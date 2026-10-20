import type { Db, Tx } from '../db/pool.js';
import { DomainError, invalid, notFound } from '../domain/errors.js';
import { D, parseUsdt } from '../domain/money.js';
import { requiredApprovals } from '../domain/orderStates.js';
import { priceQuote, type Side } from '../domain/pricing.js';
import type { Network } from '../adapters/types.js';
import { audit } from './audit.js';
import { requireRole } from './authz.js';
import type { Ctx } from './context.js';
import { getCounterparty } from './counterparties.js';
import { getSettings } from './settings.js';
import { requireCurrentTrm } from './trm.js';

export interface QuoteRequest {
  counterpartyId: string;
  side: Side;
  network: Network;
  usdtAmount: string;
}

export async function createQuote(ctx: Ctx, req: QuoteRequest) {
  requireRole(ctx.actor, 'OPERADOR', 'ADMIN');
  let usdt;
  try {
    usdt = parseUsdt(req.usdtAmount);
  } catch (e) {
    throw invalid((e as Error).message);
  }

  const cp = await getCounterparty(ctx.tx, req.counterpartyId);
  if (cp.kyc_status !== 'APROBADO') {
    throw new DomainError('KYC', `El cliente ${cp.name} no tiene KYC aprobado (${cp.kyc_status})`);
  }
  // La mesa debe saber a dónde entregar antes de comprometer un precio.
  if (req.side === 'SELL') {
    const address = req.network === 'TRON' ? cp.tron_address : cp.bsc_address;
    if (!address) throw new DomainError('NO_ADDRESS', `El cliente no tiene dirección ${req.network} registrada`);
  } else if (!cp.bank_account) {
    throw new DomainError('NO_BANK', 'El cliente no tiene cuenta bancaria registrada');
  }

  const settings = await getSettings(ctx.tx);
  if (usdt.gt(settings.max_order_usdt)) {
    throw new DomainError('LIMIT', `El monto supera el límite por operación (${settings.max_order_usdt} USDT)`);
  }

  const trm = await requireCurrentTrm(ctx.tx);
  const price = priceQuote({
    side: req.side,
    usdtAmount: usdt,
    trm: new D(trm.rate),
    buyMarginCop: new D(settings.buy_margin_cop),
    sellMarginCop: new D(settings.sell_margin_cop),
  });

  const r = await ctx.tx.query(
    `INSERT INTO quotes (counterparty_id, side, network, usdt_amount, trm_id, trm_rate, margin_cop, price_cop,
       total_cop, expires_at, status, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now() + make_interval(secs => $10), 'OPEN', $11)
     RETURNING *`,
    [
      cp.id,
      req.side,
      req.network,
      usdt.toString(),
      trm.id,
      trm.rate,
      price.marginCop.toString(),
      price.priceCop.toString(),
      price.totalCop.toString(),
      settings.quote_ttl_seconds,
      ctx.actor.id,
    ],
  );
  const quote = r.rows[0];
  await audit(ctx.tx, ctx.actor.id, 'quote.create', 'quote', quote.id, {
    side: req.side,
    network: req.network,
    usdt: usdt.toString(),
    trm: trm.rate,
    trmSource: trm.source,
    price: price.priceCop.toString(),
    total: price.totalCop.toString(),
  });
  return { ...quote, trm_source: trm.source, trm_simulated: trm.simulated };
}

export async function acceptQuote(ctx: Ctx, quoteId: string) {
  requireRole(ctx.actor, 'OPERADOR', 'ADMIN');
  const r = await ctx.tx.query(
    `SELECT *, expires_at < now() AS expired FROM quotes WHERE id = $1 FOR UPDATE`,
    [quoteId],
  );
  if (!r.rowCount) throw notFound('La cotización');
  const q = r.rows[0];
  if (q.status !== 'OPEN') throw new DomainError('QUOTE_CLOSED', `La cotización ya está ${q.status}`);
  if (q.expired) {
    await ctx.tx.query(`UPDATE quotes SET status = 'EXPIRED' WHERE id = $1`, [quoteId]);
    await audit(ctx.tx, ctx.actor.id, 'quote.expire', 'quote', quoteId);
    // Se confirma la transacción para dejar registrado el vencimiento.
    return { expired: true as const, quoteId };
  }

  const settings = await getSettings(ctx.tx);
  const approvals = requiredApprovals(settings.approval_policy, q.total_cop, settings.approval_threshold_cop);

  await ctx.tx.query(`UPDATE quotes SET status = 'ACCEPTED' WHERE id = $1`, [quoteId]);
  const o = await ctx.tx.query(
    `INSERT INTO orders (quote_id, counterparty_id, side, network, usdt_amount, trm_rate, price_cop, total_cop,
       margin_cop, status, required_approvals, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'AWAITING_PAYMENT',$10,$11) RETURNING *`,
    [q.id, q.counterparty_id, q.side, q.network, q.usdt_amount, q.trm_rate, q.price_cop, q.total_cop, q.margin_cop,
      approvals, ctx.actor.id],
  );
  const order = o.rows[0];
  await ctx.tx.query(
    `INSERT INTO order_events (order_id, from_status, to_status, actor_id, note) VALUES ($1, NULL, $2, $3, $4)`,
    [order.id, 'AWAITING_PAYMENT', ctx.actor.id, `Cotización ${q.id} aceptada`],
  );
  await audit(ctx.tx, ctx.actor.id, 'order.create', 'order', order.id, {
    quoteId: q.id,
    requiredApprovals: approvals,
    policy: settings.approval_policy,
  });
  return { expired: false as const, order };
}

export async function getQuote(q: Db | Tx, id: string) {
  const r = await q.query('SELECT * FROM quotes WHERE id = $1', [id]);
  if (!r.rowCount) throw notFound('La cotización');
  return r.rows[0];
}
