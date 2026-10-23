-- Fase 4 · Confirmaciones externas.

-- Registro de cada llamada a una integración: hora, duración y resultado. Nunca credenciales.
CREATE TABLE otc.integration_calls (
  id          BIGSERIAL PRIMARY KEY,
  integration TEXT NOT NULL CHECK (integration IN ('CHAIN','BANK')),
  operation   TEXT NOT NULL,
  target      TEXT NOT NULL,   -- red y hash, o cuenta y referencia
  sandbox     BOOLEAN NOT NULL,
  ok          BOOLEAN NOT NULL,
  duration_ms INTEGER NOT NULL CHECK (duration_ms >= 0),
  error       TEXT,
  called_at   TIMESTAMPTZ NOT NULL
);
CREATE INDEX integration_calls_at_idx ON otc.integration_calls (integration, called_at DESC);
CREATE TRIGGER integration_calls_append_only BEFORE UPDATE OR DELETE ON otc.integration_calls
  FOR EACH ROW EXECUTE FUNCTION public.forbid_change();

-- Evidencia: lo que dijo la red o el banco de una transferencia y qué hizo el sistema con eso.
-- Se guarda cuando la respuesta cambia o cuando mueve el estado; una respuesta tardía también queda.
CREATE TABLE otc.observations (
  id            BIGSERIAL PRIMARY KEY,
  transfer_id   UUID NOT NULL REFERENCES otc.transfers(id),
  source        TEXT NOT NULL CHECK (source IN ('CHAIN','BANK')),
  sandbox       BOOLEAN NOT NULL,
  payload       JSONB NOT NULL,
  outcome       TEXT NOT NULL,   -- SIN_CAMBIO, PENDIENTE, CONFIRMADA, FALLIDA, REVISION, EVIDENCIA_TARDIA, ALERTA
  note          TEXT,
  observed_at   TIMESTAMPTZ NOT NULL
);
CREATE INDEX observations_transfer_idx ON otc.observations (transfer_id, id DESC);
CREATE TRIGGER observations_append_only BEFORE UPDATE OR DELETE ON otc.observations
  FOR EACH ROW EXECUTE FUNCTION public.forbid_change();

-- SANDBOX: red y banco simulados. Solo los llenan las pruebas o un usuario de la demo con permiso
-- de simulación. Producción no usa estas tablas. Se pueden actualizar para simular el avance
-- de las confirmaciones; nunca se borran.
CREATE TABLE otc.sandbox_chain_txs (
  id                BIGSERIAL PRIMARY KEY,
  network           TEXT NOT NULL CHECK (network IN ('TRON','BSC')),
  tx_hash           TEXT NOT NULL,
  status            TEXT NOT NULL CHECK (status IN ('PENDING','SUCCESS','FAILED')),
  confirmations     INTEGER NOT NULL DEFAULT 0 CHECK (confirmations >= 0),
  from_address      TEXT NOT NULL,
  to_address        TEXT NOT NULL,
  amount_base_units NUMERIC(78,0) NOT NULL CHECK (amount_base_units > 0),
  block_number      BIGINT,
  fail_reason       TEXT,
  occurred_at       TIMESTAMPTZ NOT NULL,
  created_by        BIGINT REFERENCES public.users(id)
);
CREATE UNIQUE INDEX sandbox_chain_txs_hash_idx ON otc.sandbox_chain_txs (network, lower(tx_hash));
CREATE TRIGGER sandbox_chain_txs_no_delete BEFORE DELETE ON otc.sandbox_chain_txs
  FOR EACH ROW EXECUTE FUNCTION public.forbid_change();

CREATE TABLE otc.sandbox_bank_movements (
  id          BIGSERIAL PRIMARY KEY,
  account_ref TEXT NOT NULL,
  reference   TEXT NOT NULL,
  direction   TEXT NOT NULL CHECK (direction IN ('IN','OUT')),
  amount_cop  NUMERIC(20,0) NOT NULL CHECK (amount_cop > 0),
  status      TEXT NOT NULL CHECK (status IN ('PENDING','SETTLED','REJECTED')),
  description TEXT NOT NULL DEFAULT 'Movimiento simulado (SANDBOX)',
  occurred_at TIMESTAMPTZ NOT NULL,
  created_by  BIGINT REFERENCES public.users(id),
  UNIQUE (account_ref, reference)
);
CREATE TRIGGER sandbox_bank_movements_no_delete BEFORE DELETE ON otc.sandbox_bank_movements
  FOR EACH ROW EXECUTE FUNCTION public.forbid_change();
