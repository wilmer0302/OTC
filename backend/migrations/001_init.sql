-- Esquema inicial de la plataforma OTC.
-- Montos: NUMERIC exacto. USDT con 6 decimales de trabajo, COP en pesos enteros.

CREATE TABLE users (
  id            BIGSERIAL PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  full_name     TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  roles         TEXT[] NOT NULL,
  active        BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT users_roles_valid CHECK (roles <@ ARRAY['ADMIN','OPERADOR','TESORERO','AUDITOR']::TEXT[] AND cardinality(roles) > 0)
);

-- Configuración del cliente comprador. Una sola fila (id = 1); cada cambio queda en auditoría.
CREATE TABLE settings (
  id                     SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  buy_margin_cop         NUMERIC(18,2) NOT NULL CHECK (buy_margin_cop >= 0),
  sell_margin_cop        NUMERIC(18,2) NOT NULL CHECK (sell_margin_cop >= 0),
  quote_ttl_seconds      INTEGER NOT NULL CHECK (quote_ttl_seconds BETWEEN 10 AND 3600),
  approval_policy        TEXT NOT NULL CHECK (approval_policy IN ('SINGLE','THRESHOLD','ALL')),
  approval_threshold_cop NUMERIC(20,0) NOT NULL CHECK (approval_threshold_cop >= 0),
  max_order_usdt         NUMERIC(20,6) NOT NULL CHECK (max_order_usdt > 0),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by             BIGINT REFERENCES users(id)
);

-- TRM: pesos por dólar, vigente para una fecha (zona horaria de Bogotá).
CREATE TABLE trm_rates (
  id          BIGSERIAL PRIMARY KEY,
  valid_date  DATE NOT NULL,
  rate        NUMERIC(12,2) NOT NULL CHECK (rate > 0),
  source      TEXT NOT NULL,
  simulated   BOOLEAN NOT NULL,
  entered_by  BIGINT REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX trm_rates_date_idx ON trm_rates (valid_date, created_at DESC);

CREATE TABLE counterparties (
  id           BIGSERIAL PRIMARY KEY,
  name         TEXT NOT NULL,
  document_id  TEXT NOT NULL UNIQUE,
  kyc_status   TEXT NOT NULL CHECK (kyc_status IN ('PENDIENTE','APROBADO','BLOQUEADO')),
  bank_account TEXT,
  tron_address TEXT,
  bsc_address  TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by   BIGINT REFERENCES users(id)
);

-- side: BUY = la mesa compra USDT al cliente; SELL = la mesa vende USDT al cliente.
CREATE TABLE quotes (
  id              BIGSERIAL PRIMARY KEY,
  counterparty_id BIGINT NOT NULL REFERENCES counterparties(id),
  side            TEXT NOT NULL CHECK (side IN ('BUY','SELL')),
  network         TEXT NOT NULL CHECK (network IN ('TRON','BSC')),
  usdt_amount     NUMERIC(20,6) NOT NULL CHECK (usdt_amount > 0),
  trm_id          BIGINT NOT NULL REFERENCES trm_rates(id),
  trm_rate        NUMERIC(12,2) NOT NULL,
  margin_cop      NUMERIC(18,2) NOT NULL,
  price_cop       NUMERIC(18,2) NOT NULL,
  total_cop       NUMERIC(24,0) NOT NULL,
  expires_at      TIMESTAMPTZ NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('OPEN','ACCEPTED','EXPIRED')),
  created_by      BIGINT NOT NULL REFERENCES users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE orders (
  id              BIGSERIAL PRIMARY KEY,
  quote_id        BIGINT NOT NULL UNIQUE REFERENCES quotes(id),
  counterparty_id BIGINT NOT NULL REFERENCES counterparties(id),
  side            TEXT NOT NULL CHECK (side IN ('BUY','SELL')),
  network         TEXT NOT NULL CHECK (network IN ('TRON','BSC')),
  usdt_amount     NUMERIC(20,6) NOT NULL,
  trm_rate        NUMERIC(12,2) NOT NULL,
  price_cop       NUMERIC(18,2) NOT NULL,
  total_cop       NUMERIC(24,0) NOT NULL,
  margin_cop      NUMERIC(18,2) NOT NULL,
  status          TEXT NOT NULL CHECK (status IN (
                    'AWAITING_PAYMENT','PAYMENT_CONFIRMED','DELIVERY_APPROVED',
                    'DELIVERY_SENT','CLOSED','CANCELLED','IN_REVIEW')),
  required_approvals SMALLINT NOT NULL CHECK (required_approvals IN (1,2)),
  created_by      BIGINT NOT NULL REFERENCES users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX orders_status_idx ON orders (status);

CREATE TABLE order_events (
  id          BIGSERIAL PRIMARY KEY,
  order_id    BIGINT NOT NULL REFERENCES orders(id),
  from_status TEXT,
  to_status   TEXT NOT NULL,
  actor_id    BIGINT NOT NULL REFERENCES users(id),
  note        TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE approvals (
  id          BIGSERIAL PRIMARY KEY,
  order_id    BIGINT NOT NULL REFERENCES orders(id),
  approver_id BIGINT NOT NULL REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (order_id, approver_id)
);

-- Cada pata de la orden: cobro (IN) y entrega (OUT), en COP o USDT.
CREATE TABLE settlements (
  id           BIGSERIAL PRIMARY KEY,
  order_id     BIGINT NOT NULL REFERENCES orders(id),
  direction    TEXT NOT NULL CHECK (direction IN ('IN','OUT')),
  asset        TEXT NOT NULL CHECK (asset IN ('COP','USDT')),
  amount       NUMERIC(24,6) NOT NULL CHECK (amount > 0),
  reference    TEXT NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('REGISTERED','CONFIRMED','MISMATCH')),
  simulated    BOOLEAN NOT NULL,
  recorded_by  BIGINT NOT NULL REFERENCES users(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  confirmed_at TIMESTAMPTZ,
  UNIQUE (asset, reference)
);

-- Libro contable de doble entrada. Cada asiento cuadra a cero por moneda.
CREATE TABLE ledger_accounts (
  code     TEXT PRIMARY KEY,
  name     TEXT NOT NULL,
  currency TEXT NOT NULL CHECK (currency IN ('COP','USDT'))
);

CREATE TABLE journal_entries (
  id          BIGSERIAL PRIMARY KEY,
  description TEXT NOT NULL,
  order_id    BIGINT REFERENCES orders(id),
  created_by  BIGINT REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE journal_lines (
  id           BIGSERIAL PRIMARY KEY,
  entry_id     BIGINT NOT NULL REFERENCES journal_entries(id),
  account_code TEXT NOT NULL REFERENCES ledger_accounts(code),
  amount       NUMERIC(24,6) NOT NULL CHECK (amount <> 0) -- débito positivo, crédito negativo
);
CREATE INDEX journal_lines_account_idx ON journal_lines (account_code);

-- Auditoría solo-agregar, encadenada por hash.
CREATE TABLE audit_log (
  id         BIGSERIAL PRIMARY KEY,
  at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor_id   BIGINT REFERENCES users(id),
  action     TEXT NOT NULL,
  entity     TEXT NOT NULL,
  entity_id  TEXT,
  data       JSONB NOT NULL,
  prev_hash  TEXT NOT NULL,
  hash       TEXT NOT NULL UNIQUE
);

CREATE FUNCTION forbid_change() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'La tabla % es solo-agregar', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_log_append_only BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER journal_lines_append_only BEFORE UPDATE OR DELETE ON journal_lines
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER journal_entries_append_only BEFORE UPDATE OR DELETE ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- Reintentos seguros: la misma clave devuelve la misma respuesta.
CREATE TABLE idempotency_keys (
  key        TEXT NOT NULL,
  user_id    BIGINT NOT NULL REFERENCES users(id),
  route      TEXT NOT NULL,
  response   JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (key, user_id, route)
);

INSERT INTO ledger_accounts (code, name, currency) VALUES
  ('BANK_COP',     'Bancos (pesos)',                  'COP'),
  ('USDT_WALLET',  'Billeteras USDT',                 'USDT'),
  ('TRADING_COP',  'Posición de cambio (pesos)',      'COP'),
  ('TRADING_USDT', 'Posición de cambio (USDT)',       'USDT'),
  ('EQUITY_COP',   'Capital inicial (pesos)',         'COP'),
  ('EQUITY_USDT',  'Capital inicial (USDT)',          'USDT');
