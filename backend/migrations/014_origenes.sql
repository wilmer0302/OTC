-- Billeteras de origen de los clientes y excepciones de origen.
-- Un depósito en USDT solo se acredita solo si sale de una dirección aprobada por Cumplimiento
-- para ese cliente y esa red. Cambio aditivo: no modifica tablas ni datos existentes.

CREATE TABLE otc.origin_addresses (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  counterparty_id UUID NOT NULL REFERENCES otc.counterparties(id),
  network         TEXT NOT NULL CHECK (network IN ('TRON','BSC')),
  address         TEXT NOT NULL CHECK (length(address) BETWEEN 20 AND 120),
  -- Clave de comparación: en BSC las direcciones no distinguen mayúsculas; en Tron (Base58) sí.
  address_key     TEXT GENERATED ALWAYS AS (CASE WHEN network = 'BSC' THEN lower(address) ELSE address END) STORED,
  label           TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'PENDIENTE' CHECK (status IN ('PENDIENTE','APROBADA','RECHAZADA','REVOCADA')),
  proposed_by     BIGINT NOT NULL REFERENCES public.users(id),
  proposed_at     TIMESTAMPTZ NOT NULL,
  decided_by      BIGINT REFERENCES public.users(id),
  decided_at      TIMESTAMPTZ,
  decision_note   TEXT,
  revoked_by      BIGINT REFERENCES public.users(id),
  revoked_at      TIMESTAMPTZ,
  revoke_reason   TEXT,
  CHECK (status = 'PENDIENTE' OR (decided_by IS NOT NULL AND decision_note IS NOT NULL)),
  CHECK (status <> 'REVOCADA' OR (revoked_by IS NOT NULL AND revoke_reason IS NOT NULL))
);
-- Una dirección viva (pendiente o aprobada) pertenece a un solo cliente dentro de una red.
-- La misma cadena de texto en otra red es otra dirección.
CREATE UNIQUE INDEX origin_addresses_live_idx ON otc.origin_addresses (network, address_key)
  WHERE status IN ('PENDIENTE','APROBADA');
CREATE INDEX origin_addresses_counterparty_idx ON otc.origin_addresses (counterparty_id, network, status);
CREATE TRIGGER origin_addresses_no_delete BEFORE DELETE ON otc.origin_addresses
  FOR EACH ROW EXECUTE FUNCTION public.forbid_change();

-- Excepción: un depósito que llegó desde un origen no aprobado se acepta solo si alguien lo
-- solicita con motivo y otra persona de Cumplimiento lo autoriza. Vale para esa transferencia
-- y esa dirección observada, nada más.
CREATE TABLE otc.origin_exceptions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transfer_id   UUID NOT NULL REFERENCES otc.transfers(id),
  network       TEXT NOT NULL CHECK (network IN ('TRON','BSC')),
  from_address  TEXT NOT NULL,
  reason        TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'SOLICITADA' CHECK (status IN ('SOLICITADA','APROBADA','RECHAZADA')),
  requested_by  BIGINT NOT NULL REFERENCES public.users(id),
  requested_at  TIMESTAMPTZ NOT NULL,
  decided_by    BIGINT REFERENCES public.users(id),
  decided_at    TIMESTAMPTZ,
  decision_note TEXT,
  CHECK (status = 'SOLICITADA' OR (decided_by IS NOT NULL AND decision_note IS NOT NULL)),
  CHECK (decided_by IS NULL OR decided_by <> requested_by)
);
CREATE UNIQUE INDEX origin_exceptions_live_idx ON otc.origin_exceptions (transfer_id) WHERE status IN ('SOLICITADA','APROBADA');
CREATE TRIGGER origin_exceptions_no_delete BEFORE DELETE ON otc.origin_exceptions
  FOR EACH ROW EXECUTE FUNCTION public.forbid_change();

-- SANDBOX: la red simulada también informa el contrato del token, como lo hará la red real.
ALTER TABLE otc.sandbox_chain_txs ADD COLUMN token_contract TEXT;
