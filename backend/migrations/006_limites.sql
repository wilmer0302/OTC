-- Fase 4 · Configuración de límites y política de aprobación.
-- Cambiar un límite exige dos administradores: uno propone y otro distinto aprueba.
-- Rige el cambio aprobado más reciente de cada tipo y alcance. Nada se edita ni se borra
-- (solo el estado de una propuesta pasa de PROPUESTO a VIGENTE o RECHAZADO).

CREATE TABLE otc.policy_changes (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  seq             BIGSERIAL UNIQUE, -- solo hay una propuesta abierta por tipo y alcance: mayor seq = decisión más reciente
  kind            TEXT NOT NULL CHECK (kind IN (
                    'ORDER_MAX_USDT','CLIENT_DAILY_USDT','DESK_DAILY_USDT',
                    'OPEN_EXPOSURE_USDT','OPEN_EXPOSURE_COP','APPROVAL_POLICY')),
  counterparty_id UUID REFERENCES otc.counterparties(id),
  value           JSONB NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('PROPUESTO','VIGENTE','RECHAZADO')),
  reason          TEXT NOT NULL,
  proposed_by     BIGINT NOT NULL REFERENCES public.users(id),
  proposed_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_by      BIGINT REFERENCES public.users(id),
  decided_at      TIMESTAMPTZ,
  decision_note   TEXT,
  CHECK (decided_by IS NULL OR decided_by <> proposed_by),
  CHECK ((status = 'PROPUESTO') = (decided_at IS NULL)),
  -- Solo estos límites pueden fijarse por cliente; los de la mesa son globales.
  CHECK (counterparty_id IS NULL OR kind IN ('ORDER_MAX_USDT','CLIENT_DAILY_USDT'))
);
CREATE INDEX policy_changes_effective_idx ON otc.policy_changes (kind, counterparty_id, seq DESC)
  WHERE status = 'VIGENTE';
-- Una propuesta abierta por tipo y alcance a la vez.
CREATE UNIQUE INDEX policy_changes_one_open_idx ON otc.policy_changes (kind, COALESCE(counterparty_id, '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE status = 'PROPUESTO';

CREATE FUNCTION otc.policy_changes_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'La tabla % es solo-agregar', TG_TABLE_NAME;
  END IF;
  IF OLD.status <> 'PROPUESTO' OR NEW.kind <> OLD.kind OR NEW.value <> OLD.value
     OR NEW.counterparty_id IS DISTINCT FROM OLD.counterparty_id OR NEW.proposed_by <> OLD.proposed_by OR NEW.seq <> OLD.seq THEN
    RAISE EXCEPTION 'Una propuesta de límite solo cambia una vez, de PROPUESTO a su decisión';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER policy_changes_guard BEFORE UPDATE OR DELETE ON otc.policy_changes
  FOR EACH ROW EXECUTE FUNCTION otc.policy_changes_guard();
