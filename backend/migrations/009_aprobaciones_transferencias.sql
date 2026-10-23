-- Fase 4 · Aprobaciones de entrega y transferencias (cobros, entregas, devoluciones y traslados).

-- Cada aprobación es una fila; la misma persona no aprueba dos veces la misma orden.
CREATE TABLE otc.order_approvals (
  id          BIGSERIAL PRIMARY KEY,
  order_id    UUID NOT NULL REFERENCES otc.orders(id),
  approved_by BIGINT NOT NULL REFERENCES public.users(id),
  note        TEXT,
  created_at  TIMESTAMPTZ NOT NULL,
  UNIQUE (order_id, approved_by)
);
CREATE TRIGGER order_approvals_append_only BEFORE UPDATE OR DELETE ON otc.order_approvals
  FOR EACH ROW EXECUTE FUNCTION public.forbid_change();

-- Un movimiento de dinero o de USDT. IN: el cliente le paga a la mesa (cobro). OUT: la mesa paga
-- (entrega, devolución). Un traslado entre cuentas propias es OUT desde el origen hacia otra cuenta.
-- La plataforma no firma: para USDT registra el hash que devuelve la billetera externa.
CREATE TABLE otc.transfers (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  number             BIGSERIAL UNIQUE,
  order_id           UUID REFERENCES otc.orders(id),
  purpose            TEXT NOT NULL CHECK (purpose IN ('COBRO','ENTREGA','DEVOLUCION','TRASLADO')),
  direction          TEXT NOT NULL CHECK (direction IN ('IN','OUT')),
  rail               TEXT NOT NULL CHECK (rail IN ('BANK','TRON','BSC')),
  asset              TEXT NOT NULL CHECK (asset IN ('COP','USDT')),
  amount             NUMERIC(38,6) NOT NULL CHECK (amount > 0),
  account_id         UUID NOT NULL REFERENCES otc.accounts(id), -- cuenta de la mesa que cobra o paga
  destination_id     UUID REFERENCES otc.destinations(id),      -- destino del cliente (entregas y devoluciones)
  to_account_id      UUID REFERENCES otc.accounts(id),          -- cuenta propia de destino (traslados)
  counterparty_ref   TEXT,  -- dirección u origen informado por el cliente en un cobro
  external_ref       TEXT,  -- referencia bancaria o hash de la transacción
  retry_of           UUID UNIQUE REFERENCES otc.transfers(id),  -- un reintento es una transferencia nueva enlazada
  status             TEXT NOT NULL CHECK (status IN ('CREADA','AUTORIZADA','EN_FIRMA','ENVIADA','PENDIENTE',
                       'CONFIRMADA','FALLIDA','CANCELADA','EN_REVISION')),
  status_reason      TEXT,
  confirmations      INTEGER,
  last_checked_at    TIMESTAMPTZ,
  sent_at            TIMESTAMPTZ,
  created_by         BIGINT REFERENCES public.users(id),
  created_at         TIMESTAMPTZ NOT NULL,
  updated_at         TIMESTAMPTZ NOT NULL,
  CHECK ((purpose IN ('COBRO')) = (direction = 'IN')),
  CHECK (purpose <> 'TRASLADO' OR (to_account_id IS NOT NULL AND order_id IS NULL)),
  CHECK (purpose NOT IN ('ENTREGA','DEVOLUCION') OR destination_id IS NOT NULL),
  CHECK (purpose = 'TRASLADO' OR order_id IS NOT NULL),
  CHECK ((rail = 'BANK') = (asset = 'COP')),
  CHECK (status NOT IN ('ENVIADA','PENDIENTE','CONFIRMADA') OR external_ref IS NOT NULL)
);
-- Cada referencia bancaria y cada hash se acepta una sola vez en todo el sistema (por riel).
CREATE UNIQUE INDEX transfers_external_ref_idx ON otc.transfers (rail, lower(external_ref)) WHERE external_ref IS NOT NULL;
-- Una sola transferencia viva por orden y propósito: los reintentos llegan después de que la anterior falló.
CREATE UNIQUE INDEX transfers_one_live_idx ON otc.transfers (order_id, purpose)
  WHERE order_id IS NOT NULL AND status NOT IN ('FALLIDA','CANCELADA');
CREATE INDEX transfers_tracking_idx ON otc.transfers (status, sent_at) WHERE status IN ('ENVIADA','PENDIENTE');
CREATE TRIGGER transfers_guard BEFORE UPDATE OR DELETE ON otc.transfers
  FOR EACH ROW EXECUTE FUNCTION otc.guard_stateful('CONFIRMADA,FALLIDA,CANCELADA',
    'status', 'status_reason', 'external_ref', 'confirmations', 'last_checked_at', 'sent_at', 'updated_at');

-- La referencia o el hash, una vez registrados, no cambian.
CREATE FUNCTION otc.transfers_ref_fixed() RETURNS trigger AS $$
BEGIN
  IF OLD.external_ref IS NOT NULL AND NEW.external_ref IS DISTINCT FROM OLD.external_ref THEN
    RAISE EXCEPTION 'La referencia de la transferencia % ya está registrada y no cambia', OLD.number;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER transfers_ref_fixed BEFORE UPDATE ON otc.transfers
  FOR EACH ROW EXECUTE FUNCTION otc.transfers_ref_fixed();

ALTER TABLE otc.reservations ADD CONSTRAINT reservations_transfer_fk FOREIGN KEY (transfer_id) REFERENCES otc.transfers(id);
ALTER TABLE otc.journal_entries ADD CONSTRAINT journal_entries_transfer_fk FOREIGN KEY (transfer_id) REFERENCES otc.transfers(id);
