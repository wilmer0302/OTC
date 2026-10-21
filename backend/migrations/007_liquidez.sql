-- Fase 4 · Saldos y reservas de liquidez: cuentas, libro de doble partida y reservas.

-- Cuentas de la mesa. LIQUIDITY = dinero real en un banco, una billetera o un exchange.
-- INTERNAL = cuentas contables (posición de cambio, capital, ajustes).
-- balance es un acumulado que mantiene un trigger con cada línea del libro; nunca se escribe a mano.
CREATE TABLE otc.accounts (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code           TEXT NOT NULL UNIQUE CHECK (code ~ '^[A-Z0-9_]{3,40}$'),
  name           TEXT NOT NULL,
  asset          TEXT NOT NULL CHECK (asset IN ('COP','USDT')),
  kind           TEXT NOT NULL CHECK (kind IN ('LIQUIDITY','INTERNAL')),
  liquidity_type TEXT CHECK (liquidity_type IN ('BANK','WALLET','EXCHANGE')),
  network        TEXT CHECK (network IN ('TRON','BSC')),
  external_ref   TEXT, -- cuenta bancaria o dirección de la billetera (nunca una llave)
  is_default     BOOLEAN NOT NULL DEFAULT FALSE,
  active         BOOLEAN NOT NULL DEFAULT TRUE,
  balance        NUMERIC(38,6) NOT NULL DEFAULT 0,
  created_by     BIGINT REFERENCES public.users(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((kind = 'LIQUIDITY') = (liquidity_type IS NOT NULL)),
  CHECK (liquidity_type IS DISTINCT FROM 'BANK' OR (asset = 'COP' AND network IS NULL)),
  CHECK (liquidity_type IS DISTINCT FROM 'WALLET' OR (asset = 'USDT' AND network IS NOT NULL AND external_ref IS NOT NULL)),
  CHECK (kind = 'LIQUIDITY' OR NOT is_default),
  -- El dinero real no puede quedar en negativo.
  CHECK (kind <> 'LIQUIDITY' OR balance >= 0)
);
-- Una cuenta por defecto por activo y red para recibir y entregar.
CREATE UNIQUE INDEX accounts_default_idx ON otc.accounts (asset, COALESCE(network, '-')) WHERE is_default;

INSERT INTO otc.accounts (code, name, asset, kind) VALUES
  ('TRADING_COP',      'Posición de cambio (pesos)',        'COP',  'INTERNAL'),
  ('TRADING_USDT',     'Posición de cambio (USDT)',         'USDT', 'INTERNAL'),
  ('EQUITY_COP',       'Capital y saldos de apertura (pesos)', 'COP',  'INTERNAL'),
  ('EQUITY_USDT',      'Capital y saldos de apertura (USDT)',  'USDT', 'INTERNAL'),
  ('ADJUSTMENTS_COP',  'Ajustes de conciliación (pesos)',   'COP',  'INTERNAL'),
  ('ADJUSTMENTS_USDT', 'Ajustes de conciliación (USDT)',    'USDT', 'INTERNAL');

CREATE TABLE otc.journal_entries (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  seq               BIGSERIAL UNIQUE,
  kind              TEXT NOT NULL CHECK (kind IN ('OPENING','NORMAL','REVERSAL','ADJUSTMENT')),
  description       TEXT NOT NULL,
  order_id          UUID,
  transfer_id       UUID,
  reverses_entry_id UUID UNIQUE REFERENCES otc.journal_entries(id), -- un asiento se revierte una sola vez
  created_by        BIGINT REFERENCES public.users(id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((kind = 'REVERSAL') = (reverses_entry_id IS NOT NULL))
);
CREATE TRIGGER journal_entries_v1_append_only BEFORE UPDATE OR DELETE ON otc.journal_entries
  FOR EACH ROW EXECUTE FUNCTION public.forbid_change();

-- Débito positivo, crédito negativo. Pesos en enteros; USDT con 6 decimales.
CREATE TABLE otc.journal_lines (
  id         BIGSERIAL PRIMARY KEY,
  entry_id   UUID NOT NULL REFERENCES otc.journal_entries(id),
  account_id UUID NOT NULL REFERENCES otc.accounts(id),
  amount     NUMERIC(38,6) NOT NULL CHECK (amount <> 0)
);
CREATE INDEX journal_lines_entry_idx ON otc.journal_lines (entry_id);
CREATE INDEX journal_lines_account_idx ON otc.journal_lines (account_id);
CREATE TRIGGER journal_lines_v1_append_only BEFORE UPDATE OR DELETE ON otc.journal_lines
  FOR EACH ROW EXECUTE FUNCTION public.forbid_change();

-- Cada línea mueve el saldo acumulado de su cuenta en la misma transacción.
CREATE FUNCTION otc.apply_journal_line() RETURNS trigger AS $$
BEGIN
  UPDATE otc.accounts SET balance = balance + NEW.amount WHERE id = NEW.account_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER journal_lines_apply AFTER INSERT ON otc.journal_lines
  FOR EACH ROW EXECUTE FUNCTION otc.apply_journal_line();

-- Al confirmar la transacción, cada asiento debe cuadrar en cero por activo y tener al menos dos líneas.
CREATE FUNCTION otc.check_entry_balanced() RETURNS trigger AS $$
DECLARE
  bad TEXT;
BEGIN
  SELECT a.asset INTO bad
  FROM otc.journal_lines l JOIN otc.accounts a ON a.id = l.account_id
  WHERE l.entry_id = NEW.entry_id
  GROUP BY a.asset HAVING sum(l.amount) <> 0 LIMIT 1;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'Asiento % descuadrado en %', NEW.entry_id, bad;
  END IF;
  IF (SELECT count(*) FROM otc.journal_lines WHERE entry_id = NEW.entry_id) < 2 THEN
    RAISE EXCEPTION 'Asiento % con una sola línea', NEW.entry_id;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER journal_lines_balanced AFTER INSERT ON otc.journal_lines
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION otc.check_entry_balanced();

-- Reservas: liquidez apartada para una orden. Disponible = saldo − reservas ACTIVAS y BLOQUEADAS.
-- ACTIVE: apartada al aceptar la cotización. LOCKED: atada a una transferencia en curso.
-- CONSUMED: la transferencia se confirmó. RELEASED: la orden venció, se canceló o la reserva se cerró.
CREATE TABLE otc.reservations (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  UUID NOT NULL REFERENCES otc.accounts(id),
  order_id    UUID NOT NULL,
  transfer_id UUID,
  amount      NUMERIC(38,6) NOT NULL CHECK (amount > 0),
  status      TEXT NOT NULL CHECK (status IN ('ACTIVE','LOCKED','CONSUMED','RELEASED')),
  reason      TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((status = 'LOCKED') <= (transfer_id IS NOT NULL))
);
CREATE INDEX reservations_open_idx ON otc.reservations (account_id) WHERE status IN ('ACTIVE','LOCKED');
CREATE UNIQUE INDEX reservations_one_open_per_order_idx ON otc.reservations (order_id) WHERE status IN ('ACTIVE','LOCKED');
