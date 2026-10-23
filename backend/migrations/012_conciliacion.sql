-- Fase 4 · Conciliación operativa: extractos externos contra el libro, partidas, ajustes y cierre diario.

-- Una conciliación por cuenta y día de negocio (Bogotá).
CREATE TABLE otc.recon_runs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    UUID NOT NULL REFERENCES otc.accounts(id),
  business_date DATE NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('ABIERTO','CUADRADO','CON_DIFERENCIAS','CERRADO')),
  status_reason TEXT,
  started_by    BIGINT REFERENCES public.users(id),
  closed_by     BIGINT REFERENCES public.users(id),
  closed_at     TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL,
  updated_at    TIMESTAMPTZ NOT NULL,
  UNIQUE (account_id, business_date),
  CHECK ((status = 'CERRADO') = (closed_at IS NOT NULL))
);
CREATE TRIGGER recon_runs_guard BEFORE UPDATE OR DELETE ON otc.recon_runs
  FOR EACH ROW EXECUTE FUNCTION otc.guard_stateful('CERRADO', 'status', 'status_reason', 'closed_by', 'closed_at', 'updated_at');

-- Movimientos tal como los reporta el banco, la red o un extracto cargado a mano. Nunca se editan.
CREATE TABLE otc.external_movements (
  id           BIGSERIAL PRIMARY KEY,
  run_id       UUID NOT NULL REFERENCES otc.recon_runs(id),
  account_id   UUID NOT NULL REFERENCES otc.accounts(id),
  source       TEXT NOT NULL CHECK (source IN ('BANK','CHAIN','MANUAL')),
  sandbox      BOOLEAN NOT NULL,
  external_ref TEXT NOT NULL,
  direction    TEXT NOT NULL CHECK (direction IN ('IN','OUT')),
  amount       NUMERIC(38,6) NOT NULL CHECK (amount > 0),
  occurred_at  TIMESTAMPTZ NOT NULL,
  raw          JSONB NOT NULL,
  loaded_by    BIGINT REFERENCES public.users(id),
  loaded_at    TIMESTAMPTZ NOT NULL
);
CREATE UNIQUE INDEX external_movements_unique_idx ON otc.external_movements (account_id, lower(external_ref), direction);
CREATE TRIGGER external_movements_append_only BEFORE UPDATE OR DELETE ON otc.external_movements
  FOR EACH ROW EXECUTE FUNCTION public.forbid_change();

-- Ajustes: corrigen el libro sin tocar el original. Los propone una persona y los aprueba otra.
CREATE TABLE otc.adjustments (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  number           BIGSERIAL UNIQUE,
  account_id       UUID NOT NULL REFERENCES otc.accounts(id),
  amount           NUMERIC(38,6) NOT NULL CHECK (amount <> 0), -- positivo: entra a la cuenta; negativo: sale
  reason           TEXT NOT NULL,
  status           TEXT NOT NULL CHECK (status IN ('PROPUESTO','APROBADO','RECHAZADO')),
  status_reason    TEXT,
  journal_entry_id UUID REFERENCES otc.journal_entries(id),
  proposed_by      BIGINT NOT NULL REFERENCES public.users(id),
  decided_by       BIGINT REFERENCES public.users(id),
  decided_at       TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL,
  updated_at       TIMESTAMPTZ NOT NULL,
  CHECK (decided_by IS NULL OR decided_by <> proposed_by),
  CHECK ((status = 'APROBADO') = (journal_entry_id IS NOT NULL))
);
CREATE TRIGGER adjustments_guard BEFORE UPDATE OR DELETE ON otc.adjustments
  FOR EACH ROW EXECUTE FUNCTION otc.guard_stateful('APROBADO,RECHAZADO',
    'status', 'status_reason', 'journal_entry_id', 'decided_by', 'decided_at', 'updated_at');

-- Partidas: cada movimiento externo, o cada movimiento del libro, con o sin pareja.
CREATE TABLE otc.recon_items (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  number               BIGSERIAL UNIQUE,
  run_id               UUID NOT NULL REFERENCES otc.recon_runs(id),
  external_movement_id BIGINT UNIQUE REFERENCES otc.external_movements(id),
  transfer_id          UUID REFERENCES otc.transfers(id),
  expected_amount      NUMERIC(38,6),
  observed_amount      NUMERIC(38,6),
  status               TEXT NOT NULL CHECK (status IN ('PENDIENTE','CONCILIADA','CON_DIFERENCIA','SIN_CONTRAPARTIDA','EN_REVISION','AJUSTADA')),
  status_reason        TEXT,
  adjustment_id        UUID UNIQUE REFERENCES otc.adjustments(id),
  created_at           TIMESTAMPTZ NOT NULL,
  updated_at           TIMESTAMPTZ NOT NULL,
  CHECK (external_movement_id IS NOT NULL OR transfer_id IS NOT NULL),
  CHECK ((status = 'AJUSTADA') = (adjustment_id IS NOT NULL))
);
CREATE INDEX recon_items_run_idx ON otc.recon_items (run_id, status);
-- Un movimiento del libro se concilia una sola vez.
CREATE UNIQUE INDEX recon_items_transfer_idx ON otc.recon_items (transfer_id, run_id) WHERE transfer_id IS NOT NULL;
CREATE TRIGGER recon_items_guard BEFORE UPDATE OR DELETE ON otc.recon_items
  FOR EACH ROW EXECUTE FUNCTION otc.guard_stateful('CONCILIADA,AJUSTADA',
    'status', 'status_reason', 'transfer_id', 'expected_amount', 'adjustment_id', 'updated_at');

ALTER TABLE otc.adjustments ADD COLUMN recon_item_id UUID UNIQUE REFERENCES otc.recon_items(id);
