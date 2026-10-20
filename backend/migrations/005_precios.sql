-- Fase 4 · Precios, comisiones y márgenes.

-- TRM: pesos por dólar, vigente para una fecha de Bogotá. Cada carga es un registro nuevo.
CREATE TABLE otc.trm_rates (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  seq         BIGSERIAL UNIQUE, -- orden de carga, sin empates aunque dos cargas tengan la misma hora
  valid_date  DATE NOT NULL,
  rate        NUMERIC(12,2) NOT NULL CHECK (rate > 0),
  source      TEXT NOT NULL,
  simulated   BOOLEAN NOT NULL,
  entered_by  BIGINT REFERENCES public.users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX trm_rates_date_idx ON otc.trm_rates (valid_date, seq DESC);
CREATE TRIGGER trm_rates_append_only BEFORE UPDATE OR DELETE ON otc.trm_rates
  FOR EACH ROW EXECUTE FUNCTION public.forbid_change();

-- Reglas de precio: margen en pesos por USDT para cada lado y comisión porcentual.
-- Alcance: global (sin cliente) o por cliente; tramos por monto mínimo en USDT.
-- Nada se edita: cada cambio es una fila nueva y rige la más reciente de cada alcance y tramo.
CREATE TABLE otc.pricing_rules (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  seq              BIGSERIAL UNIQUE, -- orden de creación: rige la de mayor seq en cada alcance y tramo
  counterparty_id  UUID REFERENCES otc.counterparties(id),
  min_usdt         NUMERIC(20,6) NOT NULL DEFAULT 0 CHECK (min_usdt >= 0),
  buy_margin_cop   NUMERIC(12,2) NOT NULL CHECK (buy_margin_cop >= 0),
  sell_margin_cop  NUMERIC(12,2) NOT NULL CHECK (sell_margin_cop >= 0),
  commission_rate  NUMERIC(8,6) NOT NULL CHECK (commission_rate >= 0 AND commission_rate <= 0.1),
  active           BOOLEAN NOT NULL DEFAULT TRUE,
  reason           TEXT NOT NULL,
  created_by       BIGINT REFERENCES public.users(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX pricing_rules_scope_idx ON otc.pricing_rules (counterparty_id, min_usdt, seq DESC);
CREATE TRIGGER pricing_rules_append_only BEFORE UPDATE OR DELETE ON otc.pricing_rules
  FOR EACH ROW EXECUTE FUNCTION public.forbid_change();
