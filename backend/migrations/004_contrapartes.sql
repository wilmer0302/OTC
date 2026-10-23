-- Fase 4 · Clientes y contrapartes: identidad, versiones de datos, KYC y lista blanca.

-- Identidad del cliente o proveedor. El documento no cambia: si se capturó mal, se bloquea
-- el registro y se crea uno nuevo. Los demás datos cambian por versiones.
CREATE TABLE otc.counterparties (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  number          BIGSERIAL UNIQUE,
  kind            TEXT NOT NULL CHECK (kind IN ('CLIENTE','PROVEEDOR')),
  person_type     TEXT NOT NULL CHECK (person_type IN ('NATURAL','JURIDICA')),
  document_type   TEXT NOT NULL CHECK (document_type IN ('CC','CE','NIT','PASAPORTE')),
  document_number TEXT NOT NULL CHECK (document_number ~ '^[0-9A-Za-z-]{3,20}$'),
  kyc_status      TEXT NOT NULL DEFAULT 'PENDIENTE' CHECK (kyc_status IN ('PENDIENTE','APROBADO','RECHAZADO','BLOQUEADO')),
  current_version INTEGER NOT NULL DEFAULT 1,
  created_by      BIGINT NOT NULL REFERENCES public.users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (document_type, document_number)
);

CREATE TABLE otc.counterparty_versions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  counterparty_id UUID NOT NULL REFERENCES otc.counterparties(id),
  version         INTEGER NOT NULL CHECK (version > 0),
  legal_name      TEXT NOT NULL CHECK (length(legal_name) BETWEEN 2 AND 200),
  email           TEXT,
  phone           TEXT,
  notes           TEXT,
  reason          TEXT NOT NULL,
  created_by      BIGINT NOT NULL REFERENCES public.users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (counterparty_id, version)
);
CREATE TRIGGER counterparty_versions_append_only BEFORE UPDATE OR DELETE ON otc.counterparty_versions
  FOR EACH ROW EXECUTE FUNCTION public.forbid_change();

-- Cada decisión de KYC queda guardada; el estado vigente está en otc.counterparties.
CREATE TABLE otc.kyc_reviews (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  counterparty_id UUID NOT NULL REFERENCES otc.counterparties(id),
  from_status     TEXT NOT NULL,
  to_status       TEXT NOT NULL CHECK (to_status IN ('PENDIENTE','APROBADO','RECHAZADO','BLOQUEADO')),
  note            TEXT NOT NULL,
  reviewed_by     BIGINT NOT NULL REFERENCES public.users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TRIGGER kyc_reviews_append_only BEFORE UPDATE OR DELETE ON otc.kyc_reviews
  FOR EACH ROW EXECUTE FUNCTION public.forbid_change();

-- Lista blanca: a dónde puede la mesa entregar dinero o USDT a cada cliente.
-- Una persona propone y otra distinta aprueba. Solo se entrega a destinos APROBADOS.
CREATE TABLE otc.destinations (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  counterparty_id UUID NOT NULL REFERENCES otc.counterparties(id),
  rail            TEXT NOT NULL CHECK (rail IN ('BANK','TRON','BSC')),
  value           TEXT NOT NULL, -- número de cuenta o dirección
  bank_name       TEXT,
  account_type    TEXT CHECK (account_type IN ('AHORROS','CORRIENTE')),
  holder_document TEXT,
  label           TEXT NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('PROPUESTO','APROBADO','RECHAZADO','REVOCADO')),
  supersedes_id   UUID REFERENCES otc.destinations(id),
  proposed_by     BIGINT NOT NULL REFERENCES public.users(id),
  proposed_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_by      BIGINT REFERENCES public.users(id),
  decided_at      TIMESTAMPTZ,
  decision_note   TEXT,
  revoked_by      BIGINT REFERENCES public.users(id),
  revoked_at      TIMESTAMPTZ,
  revoke_reason   TEXT,
  CHECK ((rail = 'BANK') = (bank_name IS NOT NULL AND account_type IS NOT NULL)),
  CHECK (decided_by IS NULL OR decided_by <> proposed_by),
  CHECK ((status = 'PROPUESTO') = (decided_at IS NULL)),
  CHECK ((status = 'REVOCADO') = (revoked_at IS NOT NULL))
);
-- Un mismo destino no puede estar dos veces vivo para el mismo cliente.
CREATE UNIQUE INDEX destinations_live_idx ON otc.destinations (counterparty_id, rail, lower(value))
  WHERE status IN ('PROPUESTO','APROBADO');
