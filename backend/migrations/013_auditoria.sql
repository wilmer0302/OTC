-- Fase 4 · Auditoría: anclas de la cadena de hashes.
-- Un ancla guarda el hash del último registro en un momento dado. Si alguien reescribiera la
-- cadena completa desde un punto anterior (recalculando todos los hashes), el ancla ya no
-- coincidiría. El hash del ancla se puede copiar fuera de la plataforma (correo, notaría, otro sistema).
CREATE TABLE otc.audit_anchors (
  id          BIGSERIAL PRIMARY KEY,
  audit_id    BIGINT NOT NULL REFERENCES public.audit_log(id),
  hash        TEXT NOT NULL,
  records     BIGINT NOT NULL CHECK (records > 0),
  note        TEXT,
  created_by  BIGINT REFERENCES public.users(id),
  created_at  TIMESTAMPTZ NOT NULL
);
CREATE TRIGGER audit_anchors_append_only BEFORE UPDATE OR DELETE ON otc.audit_anchors
  FOR EACH ROW EXECUTE FUNCTION public.forbid_change();
