-- Fase 4 · Solicitudes, cotizaciones y órdenes.
-- BUY: la mesa compra USDT (el cliente entrega USDT y recibe pesos).
-- SELL: la mesa vende USDT (el cliente paga pesos y recibe USDT).

-- Guardia genérica para tablas con estado: no se borra nada, una fila en estado final no cambia
-- y, mientras está abierta, solo cambian las columnas permitidas.
-- TG_ARGV[0]: estados finales separados por coma. TG_ARGV[1..]: columnas que sí pueden cambiar.
CREATE FUNCTION otc.guard_stateful() RETURNS trigger AS $$
DECLARE
  finals TEXT[] := string_to_array(TG_ARGV[0], ',');
  mutable TEXT[] := TG_ARGV[1:TG_NARGS - 1];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '% es de solo agregar: no se borran filas', TG_TABLE_NAME;
  END IF;
  IF OLD.status = ANY(finals) THEN
    RAISE EXCEPTION '% está en estado final (%) y no cambia', TG_TABLE_NAME, OLD.status;
  END IF;
  IF (to_jsonb(NEW) - mutable) IS DISTINCT FROM (to_jsonb(OLD) - mutable) THEN
    RAISE EXCEPTION 'En % solo pueden cambiar: %', TG_TABLE_NAME, array_to_string(mutable, ', ');
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Lo que pide el cliente antes de tener precio.
CREATE TABLE otc.requests (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  number          BIGSERIAL UNIQUE,
  counterparty_id UUID NOT NULL REFERENCES otc.counterparties(id),
  side            TEXT NOT NULL CHECK (side IN ('BUY','SELL')),
  usdt_amount     NUMERIC(20,6) NOT NULL CHECK (usdt_amount > 0),
  network         TEXT NOT NULL CHECK (network IN ('TRON','BSC')),
  destination_id  UUID REFERENCES otc.destinations(id), -- dónde recibe el cliente, de su lista blanca
  status          TEXT NOT NULL CHECK (status IN ('CREADA','VALIDADA','COTIZADA','ACEPTADA','RECHAZADA','CANCELADA','VENCIDA')),
  status_reason   TEXT,
  expires_at      TIMESTAMPTZ NOT NULL,
  created_by      BIGINT REFERENCES public.users(id),
  created_at      TIMESTAMPTZ NOT NULL,
  updated_at      TIMESTAMPTZ NOT NULL,
  CHECK (status NOT IN ('RECHAZADA','CANCELADA') OR status_reason IS NOT NULL)
);
CREATE INDEX requests_open_idx ON otc.requests (expires_at) WHERE status IN ('CREADA','VALIDADA','COTIZADA');
CREATE INDEX requests_counterparty_idx ON otc.requests (counterparty_id, created_at DESC);
CREATE TRIGGER requests_guard BEFORE UPDATE OR DELETE ON otc.requests
  FOR EACH ROW EXECUTE FUNCTION otc.guard_stateful('ACEPTADA,RECHAZADA,CANCELADA,VENCIDA', 'status', 'status_reason', 'updated_at');

-- Un precio firme con plazo. Guarda exactamente qué TRM y qué regla usó; nada del precio cambia después.
CREATE TABLE otc.quotes (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  number           BIGSERIAL UNIQUE,
  request_id       UUID NOT NULL REFERENCES otc.requests(id),
  replaces_id      UUID UNIQUE REFERENCES otc.quotes(id), -- la cotización anterior de la misma solicitud
  side             TEXT NOT NULL CHECK (side IN ('BUY','SELL')),
  usdt_amount      NUMERIC(20,6) NOT NULL CHECK (usdt_amount > 0),
  trm_id           UUID NOT NULL REFERENCES otc.trm_rates(id),
  trm_rate         NUMERIC(12,2) NOT NULL,
  rule_id          UUID NOT NULL REFERENCES otc.pricing_rules(id),
  margin_cop       NUMERIC(12,2) NOT NULL,
  commission_rate  NUMERIC(8,6) NOT NULL,
  base_price_cop   NUMERIC(14,2) NOT NULL,
  unit_price_cop   NUMERIC(14,2) NOT NULL CHECK (unit_price_cop > 0),
  subtotal_cop     NUMERIC(20,0) NOT NULL,
  commission_cop   NUMERIC(20,0) NOT NULL CHECK (commission_cop >= 0),
  total_cop        NUMERIC(20,0) NOT NULL CHECK (total_cop > 0),
  margin_total_cop NUMERIC(20,0) NOT NULL,
  status           TEXT NOT NULL CHECK (status IN ('VIGENTE','ACEPTADA','VENCIDA','REEMPLAZADA','RETIRADA')),
  status_reason    TEXT,
  expires_at       TIMESTAMPTZ NOT NULL,
  created_by       BIGINT REFERENCES public.users(id),
  created_at       TIMESTAMPTZ NOT NULL,
  updated_at       TIMESTAMPTZ NOT NULL,
  CHECK (status <> 'RETIRADA' OR status_reason IS NOT NULL)
);
-- Una sola cotización vigente por solicitud.
CREATE UNIQUE INDEX quotes_one_live_idx ON otc.quotes (request_id) WHERE status = 'VIGENTE';
CREATE INDEX quotes_live_expiry_idx ON otc.quotes (expires_at) WHERE status = 'VIGENTE';
CREATE TRIGGER quotes_guard BEFORE UPDATE OR DELETE ON otc.quotes
  FOR EACH ROW EXECUTE FUNCTION otc.guard_stateful('ACEPTADA,VENCIDA,REEMPLAZADA,RETIRADA', 'status', 'status_reason', 'updated_at');

-- La orden nace al aceptar una cotización: precio congelado, liquidez reservada, plazo de pago.
CREATE TABLE otc.orders (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  number              BIGSERIAL UNIQUE,
  quote_id            UUID NOT NULL UNIQUE REFERENCES otc.quotes(id), -- una cotización se acepta una sola vez
  request_id          UUID NOT NULL UNIQUE REFERENCES otc.requests(id),
  counterparty_id     UUID NOT NULL REFERENCES otc.counterparties(id),
  side                TEXT NOT NULL CHECK (side IN ('BUY','SELL')),
  network             TEXT NOT NULL CHECK (network IN ('TRON','BSC')),
  usdt_amount         NUMERIC(20,6) NOT NULL CHECK (usdt_amount > 0),
  unit_price_cop      NUMERIC(14,2) NOT NULL,
  base_price_cop      NUMERIC(14,2) NOT NULL,
  subtotal_cop        NUMERIC(20,0) NOT NULL,
  commission_cop      NUMERIC(20,0) NOT NULL,
  total_cop           NUMERIC(20,0) NOT NULL CHECK (total_cop > 0),
  margin_total_cop    NUMERIC(20,0) NOT NULL,
  receive_account_id  UUID NOT NULL REFERENCES otc.accounts(id), -- donde la mesa cobra
  deliver_account_id  UUID NOT NULL REFERENCES otc.accounts(id), -- desde donde la mesa entrega
  destination_id      UUID NOT NULL REFERENCES otc.destinations(id), -- donde recibe el cliente
  approval_policy     JSONB NOT NULL, -- la regla con la que nació; un cambio posterior no la afecta
  required_approvals  SMALLINT NOT NULL CHECK (required_approvals IN (1,2)),
  status              TEXT NOT NULL CHECK (status IN ('CREADA','COBRO_EN_VERIFICACION','COBRO_CONFIRMADO','ENTREGA_AUTORIZADA',
                        'ENTREGA_ENVIADA','COMPLETADA','VENCIDA','CANCELADA','EN_REVISION')),
  status_reason       TEXT,
  review_from         TEXT, -- estado desde el que pasó a revisión
  payment_deadline    TIMESTAMPTZ NOT NULL,
  created_by          BIGINT REFERENCES public.users(id),
  created_at          TIMESTAMPTZ NOT NULL,
  updated_at          TIMESTAMPTZ NOT NULL,
  CHECK (receive_account_id <> deliver_account_id)
);
CREATE INDEX orders_status_idx ON otc.orders (status);
CREATE INDEX orders_counterparty_idx ON otc.orders (counterparty_id, created_at DESC);
CREATE INDEX orders_payment_deadline_idx ON otc.orders (payment_deadline) WHERE status = 'CREADA';
CREATE TRIGGER orders_guard BEFORE UPDATE OR DELETE ON otc.orders
  FOR EACH ROW EXECUTE FUNCTION otc.guard_stateful('COMPLETADA,VENCIDA,CANCELADA', 'status', 'status_reason', 'review_from', 'updated_at');

-- Integridad: las reservas y los asientos que nombran una orden apuntan a una orden que existe.
ALTER TABLE otc.reservations ADD CONSTRAINT reservations_order_fk FOREIGN KEY (order_id) REFERENCES otc.orders(id);
ALTER TABLE otc.journal_entries ADD CONSTRAINT journal_entries_order_fk FOREIGN KEY (order_id) REFERENCES otc.orders(id);
