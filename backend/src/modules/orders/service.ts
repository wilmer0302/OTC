import type { Db, Tx } from '../../db/pool.js';
import { DomainError, invalid, notFound } from '../../domain/errors.js';
import { openCase, resolveCasesFor } from '../../platform/cases.js';
import { actorDbId, type Ctx } from '../../platform/context.js';
import { history, recordAction, recordTransition } from '../../platform/events.js';
import { D } from '../../platform/money.js';
import { mask } from '../counterparties/domain.js';
import { requiredApprovals, type ApprovalPolicy, type Usage } from '../limits/domain.js';
import { authorize } from '../identity/permissions.js';
import {
  defaultAccount,
  lockReservation,
  openReservationFor,
  releaseReservation,
  reserve,
  unlockReservation,
  type AccountRow,
} from '../liquidity/service.js';
import { IN_FLIGHT } from '../transfers/domain.js';
import { createCollection, createDelivery, lockTransfer, moveTransfer, transfersOf } from '../transfers/service.js';
import { clientView, type Side } from '../pricing/domain.js';
import { orderCanMove, OPEN_ORDER_STATUSES, type OrderStatus } from './domain.js';

export interface OrderRow {
  id: string;
  number: string;
  quote_id: string;
  request_id: string;
  counterparty_id: string;
  side: Side;
  network: 'TRON' | 'BSC';
  usdt_amount: string;
  unit_price_cop: string;
  base_price_cop: string;
  subtotal_cop: string;
  commission_cop: string;
  total_cop: string;
  margin_total_cop: string;
  receive_account_id: string;
  deliver_account_id: string;
  destination_id: string;
  approval_policy: ApprovalPolicy;
  required_approvals: number;
  status: OrderStatus;
  status_reason: string | null;
  review_from: string | null;
  payment_deadline: Date;
  created_at: Date;
}

/**
 * Uso de los límites: órdenes del día (Bogotá) que no vencieron ni se cancelaron, y lo que la
 * mesa aún debe entregar en órdenes abiertas (USDT en ventas, pesos en compras).
 */
export async function limitUsage(q: Db | Tx, counterpartyId: string, day: string): Promise<Usage> {
  const r = await q.query(
    `SELECT
       COALESCE(sum(usdt_amount) FILTER (WHERE counterparty_id = $1 AND alive AND today), 0) AS client_daily,
       COALESCE(sum(usdt_amount) FILTER (WHERE alive AND today), 0) AS desk_daily,
       COALESCE(sum(usdt_amount) FILTER (WHERE side = 'SELL' AND open), 0) AS open_usdt,
       COALESCE(sum(total_cop) FILTER (WHERE side = 'BUY' AND open), 0) AS open_cop
     FROM (
       SELECT counterparty_id, side, usdt_amount, total_cop,
              status NOT IN ('VENCIDA','CANCELADA') AS alive,
              status = ANY($3::text[]) AS open,
              (created_at AT TIME ZONE 'America/Bogota')::date = $2::date AS today
       FROM otc.orders
     ) o`,
    [counterpartyId, day, OPEN_ORDER_STATUSES],
  );
  const row = r.rows[0];
  return {
    clientDailyUsdt: new D(row.client_daily),
    deskDailyUsdt: new D(row.desk_daily),
    openExposureUsdt: new D(row.open_usdt),
    openExposureCop: new D(row.open_cop),
  };
}

/** Cuentas de la mesa para una orden: dónde cobra y desde dónde entrega. */
export async function deskAccountsFor(q: Db | Tx, side: Side, network: 'TRON' | 'BSC'): Promise<{ receive: AccountRow; deliver: AccountRow }> {
  const usdt = await defaultAccount(q, 'USDT', network);
  const cop = await defaultAccount(q, 'COP', null);
  return side === 'SELL' ? { receive: cop, deliver: usdt } : { receive: usdt, deliver: cop };
}

export interface QuoteForOrder {
  id: string;
  request_id: string;
  side: Side;
  usdt_amount: string;
  unit_price_cop: string;
  base_price_cop: string;
  subtotal_cop: string;
  commission_cop: string;
  total_cop: string;
  margin_total_cop: string;
}

/**
 * Crea la orden de una cotización aceptada y reserva lo que la mesa va a entregar, en la
 * transacción de la aceptación. Si la reserva falla, falla todo y no queda orden.
 */
export async function createOrderFromQuote(
  ctx: Ctx,
  quote: QuoteForOrder,
  request: { counterparty_id: string; network: 'TRON' | 'BSC'; destination_id: string },
  policy: ApprovalPolicy,
  paymentWindowSeconds: number,
): Promise<OrderRow> {
  const { receive, deliver } = await deskAccountsFor(ctx.tx, quote.side, request.network);
  const now = ctx.now();
  const deadline = new Date(now.getTime() + paymentWindowSeconds * 1000);
  const r = await ctx.tx.query<OrderRow>(
    `INSERT INTO otc.orders (quote_id, request_id, counterparty_id, side, network, usdt_amount, unit_price_cop, base_price_cop,
       subtotal_cop, commission_cop, total_cop, margin_total_cop, receive_account_id, deliver_account_id, destination_id,
       approval_policy, required_approvals, status, payment_deadline, created_by, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,'CREADA',$18,$19,$20,$20) RETURNING *`,
    [
      quote.id,
      quote.request_id,
      request.counterparty_id,
      quote.side,
      request.network,
      quote.usdt_amount,
      quote.unit_price_cop,
      quote.base_price_cop,
      quote.subtotal_cop,
      quote.commission_cop,
      quote.total_cop,
      quote.margin_total_cop,
      receive.id,
      deliver.id,
      request.destination_id,
      policy,
      requiredApprovals(policy, new D(quote.total_cop)),
      deadline,
      actorDbId(ctx.actor),
      now,
    ],
  );
  const order = r.rows[0];
  const amount = quote.side === 'SELL' ? new D(quote.usdt_amount) : new D(quote.total_cop);
  await reserve(ctx, { accountId: deliver.id, orderId: order.id, amount, reason: `Entrega de la orden ${order.number}` });
  await recordTransition(ctx, 'order', order.id, null, 'CREADA', 'Cotización aceptada', {
    number: order.number,
    quoteId: quote.id,
    side: quote.side,
    usdtAmount: quote.usdt_amount,
    totalCop: quote.total_cop,
    paymentDeadline: deadline.toISOString(),
    requiredApprovals: order.required_approvals,
  });
  return order;
}

/** Cambia el estado de una orden ya bloqueada, validando la transición y dejando historial. */
export async function moveOrder(ctx: Ctx, order: OrderRow, to: OrderStatus, reason: string | null, data: Record<string, unknown> = {}) {
  if (!orderCanMove(order.status, to)) {
    throw new DomainError('INVALID_TRANSITION', `La orden ${order.number} no puede pasar de ${order.status} a ${to}`);
  }
  const r = await ctx.tx.query<OrderRow>(
    'UPDATE otc.orders SET status = $2, status_reason = $3, updated_at = $4 WHERE id = $1 RETURNING *',
    [order.id, to, reason, ctx.now()],
  );
  await recordTransition(ctx, 'order', order.id, order.status, to, reason, data);
  return r.rows[0];
}

export async function lockOrder(tx: Tx, id: string): Promise<OrderRow> {
  const r = await tx.query<OrderRow>('SELECT * FROM otc.orders WHERE id = $1 FOR UPDATE', [id]);
  if (!r.rowCount) throw notFound('La orden');
  return r.rows[0];
}

/** El cliente no pagó a tiempo: la orden vence y su reserva se libera en la misma transacción. */
export async function expireOrders(ctx: Ctx): Promise<string[]> {
  const due = await ctx.tx.query<OrderRow>(
    `SELECT * FROM otc.orders WHERE status = 'CREADA' AND payment_deadline <= $1 ORDER BY payment_deadline FOR UPDATE SKIP LOCKED`,
    [ctx.now()],
  );
  for (const order of due.rows) {
    await moveOrder(ctx, order, 'VENCIDA', 'El cliente no pagó dentro del plazo');
    const res = await openReservationFor(ctx.tx, order.id);
    if (res) await releaseReservation(ctx, res.id, `Orden ${order.number} vencida`);
  }
  return due.rows.map((o) => o.id);
}

// ---------- Ciclo de la orden ----------

/**
 * El cliente reporta su pago con la referencia bancaria o el hash. La orden pasa a Cobro en
 * verificación; la confirmación llega después, con evidencia del banco o de la red.
 * Si el reporte llega después del plazo, la orden no se da por vencida: pasa a revisión, porque
 * el dinero pudo haber llegado.
 */
export async function registerPayment(ctx: Ctx, orderId: string, input: { reference: string; fromRef?: string | null }) {
  authorize(ctx.actor, 'payment.register');
  const order = await lockOrder(ctx.tx, orderId);
  if (order.status !== 'CREADA') {
    throw new DomainError('INVALID_STATE', `La orden ${order.number} está ${order.status}; el pago solo se registra en una orden Creada`);
  }
  const transfer = await createCollection(ctx, order, input.reference.trim(), input.fromRef?.trim() || null);
  if (ctx.now().getTime() >= new Date(order.payment_deadline).getTime()) {
    const moved = await sendToReview(ctx, order, 'Pago reportado después del plazo de pago');
    return { order: moved, transfer };
  }
  const moved = await moveOrder(ctx, order, 'COBRO_EN_VERIFICACION', null, { transferId: transfer.id, reference: transfer.external_ref });
  return { order: moved, transfer };
}

/**
 * Aprobación de la entrega. Cada persona aprueba una vez; cuando se completan las que exige la
 * política con la que nació la orden, la orden queda autorizada, nace la transferencia de entrega
 * y la reserva queda bloqueada para ese envío.
 */
export async function approveDelivery(ctx: Ctx, orderId: string, note: string | null) {
  authorize(ctx.actor, 'order.approve');
  const order = await lockOrder(ctx.tx, orderId);
  if (order.status !== 'COBRO_CONFIRMADO') {
    throw new DomainError('INVALID_STATE', `La orden ${order.number} está ${order.status}; se aprueba con el cobro confirmado`);
  }
  const ins = await ctx.tx.query(
    `INSERT INTO otc.order_approvals (order_id, approved_by, note, created_at) VALUES ($1,$2,$3,$4)
     ON CONFLICT (order_id, approved_by) DO NOTHING RETURNING id`,
    [order.id, ctx.actor.id, note, ctx.now()],
  );
  if (!ins.rowCount) throw new DomainError('ALREADY_APPROVED', 'Ya aprobaste esta orden; la segunda aprobación debe hacerla otra persona');
  const count = (await ctx.tx.query<{ n: number }>('SELECT count(*)::int AS n FROM otc.order_approvals WHERE order_id = $1', [order.id])).rows[0].n;
  await recordAction(ctx, 'order.approve', 'order', order.id, {
    approval: count,
    required: order.required_approvals,
    note,
  });
  if (count < order.required_approvals) return { order, approvals: count, required: order.required_approvals, transfer: null };
  const authorized = await moveOrder(ctx, order, 'ENTREGA_AUTORIZADA', null, { approvals: count });
  const transfer = await createDelivery(ctx, authorized, null);
  const reservation = await openReservationFor(ctx.tx, order.id);
  if (!reservation) throw new Error(`La orden ${order.number} no tiene reserva abierta`);
  await lockReservation(ctx, reservation.id, transfer.id);
  return { order: authorized, approvals: count, required: order.required_approvals, transfer };
}

/**
 * Avanza la orden con la evidencia que ya existe: cobro confirmado pasa a Cobro confirmado; con
 * cobro y entrega confirmados, a Completada. Se llama al confirmar una transferencia y cuando
 * una orden vuelve de revisión. En revisión no avanza: decide un responsable.
 */
export async function advanceWithEvidence(ctx: Ctx, order: OrderRow): Promise<OrderRow> {
  const t = await transfersOf(ctx.tx, order.id);
  const collected = t.some((x) => x.purpose === 'COBRO' && x.status === 'CONFIRMADA');
  const delivered = t.some((x) => x.purpose === 'ENTREGA' && x.status === 'CONFIRMADA');
  if (order.status === 'COBRO_EN_VERIFICACION' && collected) {
    return moveOrder(ctx, order, 'COBRO_CONFIRMADO', 'Cobro confirmado con evidencia externa');
  }
  if (order.status === 'ENTREGA_ENVIADA' && collected && delivered) {
    return moveOrder(ctx, order, 'COMPLETADA', 'Ambas partes recibieron sus fondos (cobro y entrega confirmados)');
  }
  return order;
}

/** La entrega falló de forma demostrada: la orden vuelve a autorizada para un reintento aprobado. */
export async function onDeliveryFailed(ctx: Ctx, orderId: string, reason: string) {
  const order = await lockOrder(ctx.tx, orderId);
  if (order.status !== 'ENTREGA_ENVIADA') return order;
  return moveOrder(ctx, order, 'ENTREGA_AUTORIZADA', `Entrega fallida: ${reason}`);
}

/** Algo no cuadra en un movimiento de la orden: la orden va a revisión si todavía puede. */
export async function reviewFromTransfer(ctx: Ctx, orderId: string, reason: string) {
  const order = await lockOrder(ctx.tx, orderId);
  if (!orderCanMove(order.status, 'EN_REVISION')) return order;
  return sendToReview(ctx, order, reason);
}

async function sendToReview(ctx: Ctx, order: OrderRow, reason: string): Promise<OrderRow> {
  if (!orderCanMove(order.status, 'EN_REVISION')) {
    throw new DomainError('INVALID_TRANSITION', `La orden ${order.number} está ${order.status}; no se puede enviar a revisión`);
  }
  const r = await ctx.tx.query<OrderRow>(
    `UPDATE otc.orders SET status = 'EN_REVISION', review_from = status, status_reason = $2, updated_at = $3 WHERE id = $1 RETURNING *`,
    [order.id, reason, ctx.now()],
  );
  await recordTransition(ctx, 'order', order.id, order.status, 'EN_REVISION', reason);
  await openCase(ctx, 'order', order.id, 'REVISION', reason);
  return r.rows[0];
}

/** Cualquiera puede mandar una orden a revisión: la congela con sus reservas hasta que se resuelva. */
export async function markForReview(ctx: Ctx, orderId: string, reason: string) {
  authorize(ctx.actor, 'order.review');
  if (!reason.trim()) throw invalid('Indica qué no cuadra');
  return sendToReview(ctx, await lockOrder(ctx.tx, orderId), reason.trim());
}

/**
 * El administrador resuelve la revisión: la orden vuelve al estado desde el que entró, o se
 * cancela. Solo se cancela si no hay dinero en movimiento; si el cliente ya pagó, corresponde
 * una devolución con su propia transferencia.
 */
export async function resolveReview(ctx: Ctx, orderId: string, action: 'RESUME' | 'CANCEL', note: string) {
  authorize(ctx.actor, 'review.resolve');
  if (!note.trim()) throw invalid('Explica la resolución');
  const order = await lockOrder(ctx.tx, orderId);
  if (order.status !== 'EN_REVISION') throw new DomainError('INVALID_STATE', `La orden ${order.number} no está en revisión`);
  let result: OrderRow;
  if (action === 'RESUME') {
    const back = order.review_from as OrderStatus;
    const r = await ctx.tx.query<OrderRow>(
      `UPDATE otc.orders SET status = $2, review_from = NULL, status_reason = $3, updated_at = $4 WHERE id = $1 RETURNING *`,
      [order.id, back, note.trim(), ctx.now()],
    );
    await recordTransition(ctx, 'order', order.id, 'EN_REVISION', back, note.trim());
    result = await advanceWithEvidence(ctx, r.rows[0]);
  } else {
    result = await cancelWithoutMoney(ctx, order, note.trim());
  }
  await resolveCasesFor(ctx, 'order', order.id, `${action === 'RESUME' ? 'Reanudada' : 'Cancelada'}: ${note.trim()}`);
  return result;
}

/** El operador anula una orden antes de que el cliente reporte su pago. */
export async function cancelOrder(ctx: Ctx, orderId: string, reason: string) {
  authorize(ctx.actor, 'order.cancel');
  if (!reason.trim()) throw invalid('Indica el motivo de la cancelación');
  const order = await lockOrder(ctx.tx, orderId);
  if (order.status !== 'CREADA') {
    throw new DomainError(
      'INVALID_STATE',
      `La orden ${order.number} está ${order.status}. Después de reportado el pago no se cancela: envíala a revisión`,
    );
  }
  return cancelWithoutMoney(ctx, order, reason.trim());
}

async function cancelWithoutMoney(ctx: Ctx, order: OrderRow, reason: string): Promise<OrderRow> {
  const transfers = await transfersOf(ctx.tx, order.id);
  const moving = transfers.filter((t) => IN_FLIGHT.includes(t.status));
  if (moving.length) {
    throw new DomainError(
      'MONEY_IN_FLIGHT',
      `La orden ${order.number} tiene movimientos reportados o en curso (${moving.map((t) => `transferencia ${t.number} ${t.status}`).join(', ')}); resuélvelos o haz una devolución`,
    );
  }
  for (const t of transfers.filter((x) => !['FALLIDA', 'CANCELADA'].includes(x.status))) {
    await moveTransfer(ctx, await lockTransfer(ctx.tx, t.id), 'CANCELADA', `Orden cancelada: ${reason}`);
  }
  const res = await openReservationFor(ctx.tx, order.id);
  if (res?.status === 'LOCKED') await unlockReservation(ctx, res.id, 'Entrega cancelada');
  if (res) await releaseReservation(ctx, res.id, `Orden ${order.number} cancelada`);
  return moveOrder(ctx, order, 'CANCELADA', reason);
}

export async function getOrder(ctx: Pick<Ctx, 'tx'>, id: string) {
  const r = await ctx.tx.query(
    `SELECT o.*, v.legal_name AS counterparty_name, q.trm_id, q.trm_rate, q.rule_id, q.margin_cop, q.commission_rate,
            t.source AS trm_source, t.created_at AS trm_loaded_at
     FROM otc.orders o
     JOIN otc.quotes q ON q.id = o.quote_id
     JOIN otc.trm_rates t ON t.id = q.trm_id
     JOIN otc.counterparties c ON c.id = o.counterparty_id
     JOIN otc.counterparty_versions v ON v.counterparty_id = c.id AND v.version = c.current_version
     WHERE o.id = $1`,
    [id],
  );
  if (!r.rowCount) throw notFound('La orden');
  const reservation = await ctx.tx.query(
    `SELECT r.id, r.status, r.amount, a.code AS account FROM otc.reservations r JOIN otc.accounts a ON a.id = r.account_id
     WHERE r.order_id = $1 ORDER BY r.created_at`,
    [id],
  );
  const approvals = await ctx.tx.query(
    `SELECT a.created_at, a.note, u.full_name AS approved_by_name FROM otc.order_approvals a
     JOIN public.users u ON u.id = a.approved_by WHERE a.order_id = $1 ORDER BY a.id`,
    [id],
  );
  return {
    ...r.rows[0],
    reservations: reservation.rows,
    approvals: approvals.rows,
    transfers: await transfersOf(ctx.tx, id),
    history: await history(ctx, 'order', id),
  };
}

export async function listOrders(ctx: Pick<Ctx, 'tx'>, filter: { status?: OrderStatus; counterpartyId?: string }) {
  const r = await ctx.tx.query(
    `SELECT o.id, o.number, o.side, o.network, o.usdt_amount, o.unit_price_cop, o.total_cop, o.status, o.payment_deadline,
            o.created_at, v.legal_name AS counterparty_name
     FROM otc.orders o
     JOIN otc.counterparties c ON c.id = o.counterparty_id
     JOIN otc.counterparty_versions v ON v.counterparty_id = c.id AND v.version = c.current_version
     WHERE ($1::text IS NULL OR o.status = $1) AND ($2::uuid IS NULL OR o.counterparty_id = $2)
     ORDER BY o.created_at DESC LIMIT 200`,
    [filter.status ?? null, filter.counterpartyId ?? null],
  );
  return r.rows;
}

/**
 * Comprobante para el cliente: precio por USDT todo incluido, detalle con comisión y total,
 * a dónde pagar y dónde recibe. Nunca la TRM ni el margen de la mesa.
 */
export async function clientReceipt(ctx: Pick<Ctx, 'tx'>, id: string) {
  const r = await ctx.tx.query(
    `SELECT o.*, a.liquidity_type AS pay_to_type, a.external_ref AS pay_to_ref, a.network AS pay_to_network,
            d.rail AS dest_rail, d.value AS dest_value, d.bank_name AS dest_bank
     FROM otc.orders o JOIN otc.accounts a ON a.id = o.receive_account_id JOIN otc.destinations d ON d.id = o.destination_id
     WHERE o.id = $1`,
    [id],
  );
  if (!r.rowCount) throw notFound('La orden');
  const o = r.rows[0];
  return {
    number: o.number,
    status: o.status,
    network: o.network,
    paymentDeadline: o.payment_deadline,
    price: clientView(o.side, o.usdt_amount, {
      basePriceCop: o.base_price_cop,
      unitPriceCop: o.unit_price_cop,
      subtotalCop: o.subtotal_cop,
      commissionCop: o.commission_cop,
      totalCop: o.total_cop,
    }),
    payTo:
      o.side === 'SELL'
        ? { asset: 'COP', amount: o.total_cop, account: o.pay_to_ref }
        : { asset: 'USDT', amount: o.usdt_amount, network: o.pay_to_network, address: o.pay_to_ref },
    receiveAt: { rail: o.dest_rail, bank: o.dest_bank, value: mask(o.dest_value) },
  };
}
