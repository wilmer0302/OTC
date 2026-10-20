-- Fase 4 · Plataforma del backend v1.
-- Todo lo nuevo vive en el esquema "otc". Las tablas de la demo (esquema public) no se tocan,
-- salvo agregar columnas y ampliar la lista de roles; ningún dato se borra.

CREATE SCHEMA otc;

-- Rol de Cumplimiento (especificación funcional) y bloqueo temporal por intentos fallidos.
ALTER TABLE public.users DROP CONSTRAINT users_roles_valid;
ALTER TABLE public.users ADD CONSTRAINT users_roles_valid CHECK (
  roles <@ ARRAY['ADMIN','OPERADOR','TESORERO','CUMPLIMIENTO','AUDITOR']::TEXT[] AND cardinality(roles) > 0
);
ALTER TABLE public.users ADD COLUMN failed_logins INTEGER NOT NULL DEFAULT 0;
ALTER TABLE public.users ADD COLUMN locked_until TIMESTAMPTZ;

-- Historial de estados de todos los objetos (solicitud, cotización, orden, transferencia...).
CREATE TABLE otc.state_events (
  id          BIGSERIAL PRIMARY KEY,
  entity      TEXT NOT NULL,
  entity_id   UUID NOT NULL,
  from_status TEXT,
  to_status   TEXT NOT NULL,
  actor_id    BIGINT REFERENCES public.users(id),
  note        TEXT,
  data        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX state_events_entity_idx ON otc.state_events (entity, entity_id, id);
CREATE TRIGGER state_events_append_only BEFORE UPDATE OR DELETE ON otc.state_events
  FOR EACH ROW EXECUTE FUNCTION public.forbid_change();

-- Idempotencia: la misma clave con el mismo cuerpo devuelve la misma respuesta;
-- con otro cuerpo se rechaza.
CREATE TABLE otc.idempotency_keys (
  key          TEXT NOT NULL CHECK (length(key) BETWEEN 8 AND 200),
  user_id      BIGINT NOT NULL REFERENCES public.users(id),
  route        TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status_code  INTEGER NOT NULL,
  response     JSONB NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (key, user_id, route)
);

-- Parámetros operativos de la mesa. Cada cambio es una versión nueva; rige la más reciente.
CREATE TABLE otc.desk_settings (
  id                        BIGSERIAL PRIMARY KEY,
  quote_ttl_seconds         INTEGER NOT NULL CHECK (quote_ttl_seconds BETWEEN 10 AND 3600),
  payment_window_seconds    INTEGER NOT NULL CHECK (payment_window_seconds BETWEEN 60 AND 86400),
  request_ttl_seconds       INTEGER NOT NULL CHECK (request_ttl_seconds BETWEEN 60 AND 86400),
  price_move_threshold_bps  INTEGER NOT NULL CHECK (price_move_threshold_bps BETWEEN 1 AND 10000),
  tron_confirmations        INTEGER NOT NULL CHECK (tron_confirmations BETWEEN 1 AND 1000),
  bsc_confirmations         INTEGER NOT NULL CHECK (bsc_confirmations BETWEEN 1 AND 1000),
  transfer_pending_seconds  INTEGER NOT NULL CHECK (transfer_pending_seconds BETWEEN 60 AND 604800),
  transfer_review_seconds   INTEGER NOT NULL CHECK (transfer_review_seconds BETWEEN 60 AND 604800),
  created_by                BIGINT REFERENCES public.users(id),
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  reason                    TEXT NOT NULL,
  CHECK (transfer_review_seconds > transfer_pending_seconds)
);
CREATE TRIGGER desk_settings_append_only BEFORE UPDATE OR DELETE ON otc.desk_settings
  FOR EACH ROW EXECUTE FUNCTION public.forbid_change();

-- Bandeja de pendientes: todo lo que está en revisión o necesita una persona.
CREATE TABLE otc.cases (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity      TEXT NOT NULL,
  entity_id   UUID NOT NULL,
  reason      TEXT NOT NULL,
  detail      TEXT NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('ABIERTO','RESUELTO')),
  opened_by   BIGINT REFERENCES public.users(id),
  opened_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_by BIGINT REFERENCES public.users(id),
  resolved_at TIMESTAMPTZ,
  resolution  TEXT,
  CHECK ((status = 'RESUELTO') = (resolved_at IS NOT NULL))
);
CREATE UNIQUE INDEX cases_one_open_idx ON otc.cases (entity, entity_id, reason) WHERE status = 'ABIERTO';
