-- Fase 4 · Usuarios, roles y permisos: sesiones en el servidor y segundo factor (TOTP).

-- La sesión se guarda como huella SHA-256; el valor real solo viaja en la cookie HttpOnly.
CREATE TABLE otc.sessions (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash     TEXT NOT NULL UNIQUE,
  csrf_hash      TEXT NOT NULL,
  user_id        BIGINT NOT NULL REFERENCES public.users(id),
  mfa_verified   BOOLEAN NOT NULL DEFAULT FALSE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at     TIMESTAMPTZ NOT NULL,
  revoked_at     TIMESTAMPTZ,
  revoked_reason TEXT,
  ip             TEXT,
  user_agent     TEXT
);
CREATE INDEX sessions_user_idx ON otc.sessions (user_id) WHERE revoked_at IS NULL;

-- Secreto TOTP cifrado con AES-256-GCM; la llave vive en el gestor de secretos, no en la base.
CREATE TABLE otc.mfa_factors (
  user_id        BIGINT PRIMARY KEY REFERENCES public.users(id),
  secret_enc     TEXT NOT NULL,
  confirmed_at   TIMESTAMPTZ,
  last_used_step BIGINT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
