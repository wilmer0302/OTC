import type { Db, Tx } from '../../db/pool.js';
import { DomainError, invalid, notFound } from '../../domain/errors.js';
import { isSandbox } from '../../integrations/ports.js';
import type { Ctx } from '../../platform/context.js';
import { recordAction } from '../../platform/events.js';
import { fmt, parseCopPrice, parseRate, parseUsdtAmount, type Dec } from '../../platform/money.js';
import { bogotaDate } from '../../services/trm.js';
import { authorize } from '../identity/permissions.js';
import { marginFor, priceAllIn, selectRule, type PriceBreakdown, type PricingRule, type Side } from './domain.js';

export interface TrmRow {
  id: string;
  valid_date: string;
  rate: string;
  source: string;
  simulated: boolean;
  created_at: string;
}

const TRM_SELECT = `SELECT id, to_char(valid_date,'YYYY-MM-DD') AS valid_date, rate, source, simulated, created_at FROM otc.trm_rates`;

/** La TRM vigente es la última cargada para la fecha de hoy en Bogotá. Sin TRM del día no se cotiza. */
export async function currentTrm(q: Db | Tx, date: string): Promise<TrmRow | null> {
  const r = await q.query<TrmRow>(`${TRM_SELECT} WHERE valid_date = $1 ORDER BY seq DESC LIMIT 1`, [date]);
  return r.rows[0] ?? null;
}

export async function requireTrm(ctx: Ctx): Promise<TrmRow> {
  const date = bogotaDate(ctx.now());
  const trm = await currentTrm(ctx.tx, date);
  if (!trm) throw new DomainError('NO_TRM', `No hay TRM cargada para hoy (${date}). No se puede cotizar.`);
  return trm;
}

export async function listTrm(ctx: Pick<Ctx, 'tx'>, limit = 30): Promise<TrmRow[]> {
  return (await ctx.tx.query<TrmRow>(`${TRM_SELECT} ORDER BY valid_date DESC, seq DESC LIMIT $1`, [limit])).rows;
}

/**
 * Carga manual de la TRM (la fuente oficial automática se agrega cuando se verifique su acceso).
 * Queda marcada como simulada mientras el sistema corra con integraciones sandbox.
 */
export async function recordTrm(ctx: Ctx, input: { rate: string; validDate?: string }): Promise<TrmRow> {
  authorize(ctx.actor, 'trm.record');
  const rate = parseCopPrice(input.rate, 'TRM');
  const validDate = input.validDate ?? bogotaDate(ctx.now());
  if (!/^\d{4}-\d{2}-\d{2}$/.test(validDate) || Number.isNaN(Date.parse(validDate))) throw invalid('Fecha inválida');
  const r = await ctx.tx.query<{ id: string }>(
    `INSERT INTO otc.trm_rates (valid_date, rate, source, simulated, entered_by, created_at)
     VALUES ($1,$2,'Ingreso manual',$3,$4,$5) RETURNING id`,
    [validDate, fmt(rate), isSandbox(ctx.integrations), ctx.actor.id, ctx.now()],
  );
  await recordAction(ctx, 'trm.record', 'trm', r.rows[0].id, { rate: fmt(rate), validDate });
  return (await ctx.tx.query<TrmRow>(`${TRM_SELECT} WHERE id = $1`, [r.rows[0].id])).rows[0];
}

// ---------- Reglas de precio ----------

/** Reglas vigentes: la más reciente de cada alcance (global o cliente) y tramo. */
export async function effectiveRules(q: Db | Tx, counterpartyId?: string | null): Promise<PricingRule[]> {
  const r = await q.query<PricingRule>(
    `SELECT DISTINCT ON (counterparty_id, min_usdt) id, counterparty_id, min_usdt, buy_margin_cop, sell_margin_cop,
            commission_rate, active, reason, created_at
     FROM otc.pricing_rules
     WHERE ($1::uuid IS NULL OR counterparty_id IS NULL OR counterparty_id = $1)
     ORDER BY counterparty_id, min_usdt, seq DESC`,
    [counterpartyId ?? null],
  );
  return r.rows;
}

export interface NewPricingRule {
  counterpartyId?: string | null;
  minUsdt?: string;
  buyMarginCop: string;
  sellMarginCop: string;
  commissionRate: string;
  active?: boolean;
  reason: string;
}

export async function setPricingRule(ctx: Ctx, input: NewPricingRule) {
  authorize(ctx.actor, 'pricing.manage');
  if (!input.reason.trim()) throw invalid('Indica el motivo del cambio');
  const minUsdt = input.minUsdt && input.minUsdt !== '0' ? fmt(parseUsdtAmount(input.minUsdt, 'Monto mínimo del tramo')) : '0';
  const buy = parseCopPrice(input.buyMarginCop, 'Margen de compra', { allowZero: true });
  const sell = parseCopPrice(input.sellMarginCop, 'Margen de venta', { allowZero: true });
  const commission = parseRate(input.commissionRate, 'Comisión');
  if (input.counterpartyId) {
    const cp = await ctx.tx.query('SELECT 1 FROM otc.counterparties WHERE id = $1', [input.counterpartyId]);
    if (!cp.rowCount) throw notFound('La contraparte');
  }
  const r = await ctx.tx.query(
    `INSERT INTO otc.pricing_rules (counterparty_id, min_usdt, buy_margin_cop, sell_margin_cop, commission_rate, active,
       reason, created_by, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [
      input.counterpartyId ?? null,
      minUsdt,
      fmt(buy),
      fmt(sell),
      fmt(commission),
      input.active ?? true,
      input.reason.trim(),
      ctx.actor.id,
      ctx.now(),
    ],
  );
  await recordAction(ctx, 'pricing.rule', 'pricing_rule', r.rows[0].id, {
    counterpartyId: input.counterpartyId ?? null,
    minUsdt,
    buyMarginCop: fmt(buy),
    sellMarginCop: fmt(sell),
    commissionRate: fmt(commission),
    active: input.active ?? true,
    reason: input.reason,
  });
  return r.rows[0];
}

export interface PricedQuote extends PriceBreakdown {
  trm: TrmRow;
  rule: PricingRule;
  marginCop: Dec;
  commissionRate: Dec;
}

/** Calcula el precio todo incluido con la TRM del día y la regla que aplica. No guarda nada. */
export async function price(ctx: Ctx, input: { counterpartyId: string; side: Side; usdtAmount: Dec }): Promise<PricedQuote> {
  const trm = await requireTrm(ctx);
  const rule = selectRule(await effectiveRules(ctx.tx, input.counterpartyId), input.counterpartyId, input.usdtAmount);
  if (!rule) throw new DomainError('NO_PRICING_RULE', 'No hay una regla de precio vigente para este cliente y monto');
  const marginCop = marginFor(rule, input.side);
  const commissionRate = parseRate(rule.commission_rate, 'Comisión');
  const breakdown = priceAllIn({ side: input.side, usdtAmount: input.usdtAmount, trm: parseCopPrice(trm.rate, 'TRM'), marginCop, commissionRate });
  return { ...breakdown, trm, rule, marginCop, commissionRate };
}
