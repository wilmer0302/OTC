import type { Ctx } from '../../platform/context.js';
import { D, fmt } from '../../platform/money.js';
import { bogotaDate } from '../../services/trm.js';
import { can } from '../identity/permissions.js';
import { liquiditySummary } from '../liquidity/service.js';
import { currentTrm } from '../pricing/service.js';

// Métricas operativas de la pantalla de inicio. Solo lectura: todo se calcula aquí, en el servidor,
// a partir de los mismos datos que usan los casos de uso; el navegador solo las presenta.

const countBy = async (ctx: Pick<Ctx, 'tx'>, sql: string, params: unknown[] = []) => {
  const r = await ctx.tx.query<{ status: string; n: number }>(sql, params);
  return Object.fromEntries(r.rows.map((x) => [x.status, x.n]));
};

export async function dashboard(ctx: Ctx) {
  const today = bogotaDate(ctx.now());
  const trm = await currentTrm(ctx.tx, today);

  const orders = await countBy(ctx, `SELECT status, count(*)::int AS n FROM otc.orders GROUP BY status`);
  const requests = await countBy(ctx, `SELECT status, count(*)::int AS n FROM otc.requests GROUP BY status`);
  const transfers = await countBy(ctx, `SELECT status, count(*)::int AS n FROM otc.transfers GROUP BY status`);

  // Completadas hoy (Bogotá): volumen por lado. El margen solo lo ven quienes administran precios.
  const done = await ctx.tx.query<{ side: string; orders: number; usdt: string; cop: string; commission: string; margin: string }>(
    `SELECT side, count(*)::int AS orders, sum(usdt_amount) AS usdt, sum(total_cop) AS cop,
            sum(commission_cop) AS commission, sum(margin_total_cop) AS margin
     FROM otc.orders WHERE status = 'COMPLETADA' AND (updated_at AT TIME ZONE 'America/Bogota')::date = $1::date
     GROUP BY side ORDER BY side`,
    [today],
  );
  const seesMargin = can(ctx.actor, 'pricing.manage') || can(ctx.actor, 'audit.read');
  const completedToday = done.rows.map((r) => ({
    side: r.side,
    orders: r.orders,
    usdt: fmt(new D(r.usdt)),
    cop: fmt(new D(r.cop)),
    commission: fmt(new D(r.commission)),
    margin: seesMargin ? fmt(new D(r.margin)) : null,
  }));

  // Lo que espera a alguien: cada cola dice cuántos hay; la pantalla enlaza al módulo.
  const queue = async (sql: string, params: unknown[] = []) => (await ctx.tx.query<{ n: number }>(sql, params)).rows[0].n;
  const attention = {
    ordersAwaitingApproval: orders.COBRO_CONFIRMADO ?? 0,
    ordersInReview: orders.EN_REVISION ?? 0,
    deliveriesToSign: await queue(`SELECT count(*)::int AS n FROM otc.transfers WHERE purpose = 'ENTREGA' AND status IN ('AUTORIZADA','EN_FIRMA')`),
    transfersInReview: transfers.EN_REVISION ?? 0,
    transfersFailed: await queue(
      `SELECT count(*)::int AS n FROM otc.transfers t WHERE t.status = 'FALLIDA' AND t.purpose = 'ENTREGA'
         AND NOT EXISTS (SELECT 1 FROM otc.transfers r WHERE r.retry_of = t.id)
         AND EXISTS (SELECT 1 FROM otc.orders o WHERE o.id = t.order_id AND o.status NOT IN ('COMPLETADA','CANCELADA','VENCIDA'))`,
    ),
    reconWithDifferences: await queue(`SELECT count(*)::int AS n FROM otc.recon_runs WHERE status = 'CON_DIFERENCIAS'`),
    adjustmentsProposed: await queue(`SELECT count(*)::int AS n FROM otc.adjustments WHERE status = 'PROPUESTO'`),
    limitChangesProposed: await queue(`SELECT count(*)::int AS n FROM otc.policy_changes WHERE status = 'PROPUESTO'`),
    destinationsProposed: await queue(`SELECT count(*)::int AS n FROM otc.destinations WHERE status = 'PROPUESTO'`),
    kycPending: await queue(`SELECT count(*)::int AS n FROM otc.counterparties WHERE kyc_status = 'PENDIENTE'`),
  };

  const accounts = await liquiditySummary(ctx);
  const liquidity = ['COP', 'USDT'].map((asset) => {
    const of = accounts.filter((a) => a.asset === asset);
    const sum = (k: 'balance' | 'reserved' | 'available') => fmt(of.reduce((s, a) => s.plus(a[k]), new D(0)));
    return { asset, accounts: of.length, balance: sum('balance'), reserved: sum('reserved'), available: sum('available') };
  });

  return {
    today,
    trm: trm ? { rate: trm.rate, source: trm.source, simulated: trm.simulated, loadedAt: trm.created_at } : null,
    counts: { orders, requests, transfers },
    completedToday,
    attention,
    liquidity,
  };
}
