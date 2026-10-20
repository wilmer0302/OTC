import type { Db, Tx } from '../db/pool.js';
import { DomainError, invalid, notFound } from '../domain/errors.js';
import { D } from '../domain/money.js';
import {
  assertTransition,
  incomingAsset,
  outgoingAsset,
  type OrderStatus,
} from '../domain/orderStates.js';
import type { VerificationResult } from '../adapters/types.js';
import { audit } from './audit.js';
import { requireRole } from './authz.js';
import type { Ctx } from './context.js';
import { balance, postJournal, type JournalLine } from './ledger.js';

interface OrderRow {
  id: string;
  side: 'BUY' | 'SELL';
  network: 'TRON' | 'BSC';
  usdt_amount: string;
  total_cop: string;
  status: OrderStatus;
  required_approvals: number;
  counterparty_id: string;
}

async function lockOrder(tx: Tx, id: string): Promise<OrderRow> {
  const r = await tx.query<OrderRow>('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [id]);
  if (!r.rowCount) throw notFound('La orden');
  return r.rows[0];
}

async function transition(ctx: Ctx, order: OrderRow, to: OrderStatus, note: string) {
  assertTransition(order.status, to);
  await ctx.tx.query('UPDATE orders SET status = $1, updated_at = now() WHERE id = $2', [to, order.id]);
  await ctx.tx.query(
    'INSERT INTO order_events (order_id, from_status, to_status, actor_id, note) VALUES ($1,$2,$3,$4,$5)',
    [order.id, order.status, to, ctx.actor.id, note],
  );
  await audit(ctx.tx, ctx.actor.id, 'order.transition', 'order', order.id, { from: order.status, to, note });
  order.status = to;
}

const amountFor = (order: OrderRow, asset: 'COP' | 'USDT') => (asset === 'COP' ? order.total_cop : order.usdt_amount);

async function verify(ctx: Ctx, order: OrderRow, asset: 'COP' | 'USDT', reference: string): Promise<VerificationResult> {
  return asset === 'USDT'
    ? ctx.adapters.chain.verifyTransfer({ network: order.network, txHash: reference, amountUsdt: order.usdt_amount })
    : ctx.adapters.bank.verifyTransfer({ reference, amountCop: order.total_cop });
}

function cashLines(asset: 'COP' | 'USDT', amount: string, direction: 'IN' | 'OUT'): JournalLine[] {
  const value = new D(amount);
  const signed = direction === 'IN' ? value : value.neg();
  return asset === 'COP'
    ? [
        { account: 'BANK_COP', amount: signed },
        { account: 'TRADING_COP', amount: signed.neg() },
      ]
    : [
        { account: 'USDT_WALLET', amount: signed },
        { account: 'TRADING_USDT', amount: signed.neg() },
      ];
}

/** El cliente pagó: USDT recibidos (la mesa compra) o pesos recibidos (la mesa vende). */
export async function registerIncoming(ctx: Ctx, orderId: string, reference: string) {
  requireRole(ctx.actor, 'OPERADOR', 'TESORERO', 'ADMIN');
  if (!reference.trim()) throw invalid('Falta la referencia');
  const order = await lockOrder(ctx.tx, orderId);
  if (order.status !== 'AWAITING_PAYMENT') {
    throw new DomainError('INVALID_STATE', `La orden está en ${order.status}, no esperando pago`);
  }
  const asset = incomingAsset(order.side);
  const amount = amountFor(order, asset);
  const result = await verify(ctx, order, asset, reference.trim());
  const status = result.status === 'CONFIRMED' ? 'CONFIRMED' : result.status === 'MISMATCH' ? 'MISMATCH' : 'REGISTERED';

  await insertSettlement(ctx, order, 'IN', asset, amount, reference.trim(), status, result.simulated);
  if (result.status === 'CONFIRMED') {
    await postJournal(ctx.tx, {
      description: `Cobro orden ${order.id} (${asset})`,
      orderId: order.id,
      userId: ctx.actor.id,
      lines: cashLines(asset, amount, 'IN'),
    });
    await transition(ctx, order, 'PAYMENT_CONFIRMED', `Cobro verificado: ${result.detail}`);
  } else if (result.status === 'MISMATCH') {
    await transition(ctx, order, 'IN_REVIEW', `Cobro no coincide: ${result.detail}`);
  }
  return { order, verification: result };
}

async function insertSettlement(
  ctx: Ctx,
  order: OrderRow,
  direction: 'IN' | 'OUT',
  asset: 'COP' | 'USDT',
  amount: string,
  reference: string,
  status: 'REGISTERED' | 'CONFIRMED' | 'MISMATCH',
  simulated: boolean,
) {
  const dup = await ctx.tx.query('SELECT order_id FROM settlements WHERE asset = $1 AND reference = $2', [asset, reference]);
  if (dup.rowCount) {
    throw new DomainError('DUPLICATE_REFERENCE', `Esa referencia ya está registrada en la orden ${dup.rows[0].order_id}`);
  }
  const r = await ctx.tx.query(
    `INSERT INTO settlements (order_id, direction, asset, amount, reference, status, simulated, recorded_by, confirmed_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8, CASE WHEN $6 = 'CONFIRMED' THEN now() END) RETURNING id`,
    [order.id, direction, asset, amount, reference, status, simulated, ctx.actor.id],
  );
  await audit(ctx.tx, ctx.actor.id, 'settlement.record', 'settlement', r.rows[0].id, {
    orderId: order.id,
    direction,
    asset,
    amount,
    reference,
    status,
    simulated,
  });
}

/** Aprobación de la entrega. Según la política puede requerir una segunda persona. */
export async function approveDelivery(ctx: Ctx, orderId: string) {
  requireRole(ctx.actor, 'TESORERO', 'ADMIN');
  const order = await lockOrder(ctx.tx, orderId);
  if (order.status !== 'PAYMENT_CONFIRMED') {
    throw new DomainError('INVALID_STATE', 'Solo se aprueba la entrega con el cobro confirmado');
  }
  const exists = await ctx.tx.query('SELECT 1 FROM approvals WHERE order_id = $1 AND approver_id = $2', [
    order.id,
    ctx.actor.id,
  ]);
  if (exists.rowCount) throw new DomainError('ALREADY_APPROVED', 'Ya aprobaste esta orden; falta otra persona');
  await ctx.tx.query('INSERT INTO approvals (order_id, approver_id) VALUES ($1,$2)', [order.id, ctx.actor.id]);
  await audit(ctx.tx, ctx.actor.id, 'order.approve', 'order', order.id, {});

  const count = Number(
    (await ctx.tx.query<{ n: string }>('SELECT count(*) AS n FROM approvals WHERE order_id = $1', [order.id])).rows[0].n,
  );
  if (count < order.required_approvals) {
    return { order, pendingApprovals: order.required_approvals - count };
  }

  // Control de inventario antes de comprometer la salida.
  const asset = outgoingAsset(order.side);
  const needed = new D(amountFor(order, asset));
  const available = await balance(ctx.tx, asset === 'COP' ? 'BANK_COP' : 'USDT_WALLET');
  if (available.lt(needed)) {
    throw new DomainError('INSUFFICIENT_FUNDS', `Saldo insuficiente de ${asset}: hay ${available}, se necesitan ${needed}`);
  }
  await transition(ctx, order, 'DELIVERY_APPROVED', `Aprobada (${count} de ${order.required_approvals})`);
  return { order, pendingApprovals: 0 };
}

/** La mesa envió: pago en pesos o transferencia de USDT firmada FUERA de la plataforma. */
export async function registerOutgoing(ctx: Ctx, orderId: string, reference: string) {
  requireRole(ctx.actor, 'TESORERO', 'ADMIN');
  if (!reference.trim()) throw invalid('Falta la referencia');
  const order = await lockOrder(ctx.tx, orderId);
  if (order.status !== 'DELIVERY_APPROVED') {
    throw new DomainError('INVALID_STATE', 'La entrega no está aprobada');
  }
  const asset = outgoingAsset(order.side);
  if (asset === 'USDT' && !/^(0x)?[0-9a-fA-F]{64}$/.test(reference.trim())) {
    throw invalid('El hash de la transacción debe tener 64 caracteres hexadecimales');
  }
  const amount = amountFor(order, asset);
  await insertSettlement(ctx, order, 'OUT', asset, amount, reference.trim(), 'REGISTERED', ctx.adapters.chain.simulated);
  await postJournal(ctx.tx, {
    description: `Entrega orden ${order.id} (${asset})`,
    orderId: order.id,
    userId: ctx.actor.id,
    lines: cashLines(asset, amount, 'OUT'),
  });
  await transition(ctx, order, 'DELIVERY_SENT', 'Entrega registrada, pendiente de verificación');
  return { order };
}

/** Verifica la entrega contra la red o el banco y cierra la orden. */
export async function confirmDelivery(ctx: Ctx, orderId: string) {
  requireRole(ctx.actor, 'OPERADOR', 'TESORERO', 'ADMIN');
  const order = await lockOrder(ctx.tx, orderId);
  if (order.status !== 'DELIVERY_SENT') throw new DomainError('INVALID_STATE', 'No hay una entrega por verificar');
  const s = await ctx.tx.query(
    `SELECT id, asset, reference FROM settlements WHERE order_id = $1 AND direction = 'OUT' ORDER BY id DESC LIMIT 1`,
    [order.id],
  );
  const settlement = s.rows[0];
  const result = await verify(ctx, order, settlement.asset, settlement.reference);
  if (result.status === 'PENDING') return { order, verification: result };
  const newStatus = result.status === 'CONFIRMED' ? 'CONFIRMED' : 'MISMATCH';
  await ctx.tx.query(
    `UPDATE settlements SET status = $1, confirmed_at = CASE WHEN $1 = 'CONFIRMED' THEN now() END WHERE id = $2`,
    [newStatus, settlement.id],
  );
  await audit(ctx.tx, ctx.actor.id, 'settlement.verify', 'settlement', settlement.id, { status: newStatus, detail: result.detail });
  if (result.status === 'CONFIRMED') {
    await transition(ctx, order, 'CLOSED', `Entrega verificada: ${result.detail}`);
  } else {
    await transition(ctx, order, 'IN_REVIEW', `Entrega no coincide: ${result.detail}`);
  }
  return { order, verification: result };
}

export async function cancelOrder(ctx: Ctx, orderId: string, reason: string) {
  requireRole(ctx.actor, 'OPERADOR', 'ADMIN');
  if (!reason.trim()) throw invalid('Indica el motivo de la cancelación');
  const order = await lockOrder(ctx.tx, orderId);
  await transition(ctx, order, 'CANCELLED', reason.trim());
  return { order };
}

export async function sendToReview(ctx: Ctx, orderId: string, reason: string) {
  requireRole(ctx.actor, 'OPERADOR', 'TESORERO', 'ADMIN');
  if (!reason.trim()) throw invalid('Indica el motivo');
  const order = await lockOrder(ctx.tx, orderId);
  await transition(ctx, order, 'IN_REVIEW', reason.trim());
  return { order };
}

/** Solo el administrador saca una orden de revisión, a un estado permitido. */
export async function resolveReview(ctx: Ctx, orderId: string, to: OrderStatus, note: string) {
  requireRole(ctx.actor, 'ADMIN');
  if (!note.trim()) throw invalid('Explica la resolución');
  const order = await lockOrder(ctx.tx, orderId);
  if (order.status !== 'IN_REVIEW') throw new DomainError('INVALID_STATE', 'La orden no está en revisión');
  // Solo se vuelve al estado previo a la revisión, o se cancela si no se ha movido dinero.
  const prev = await ctx.tx.query<{ from_status: OrderStatus }>(
    `SELECT from_status FROM order_events WHERE order_id = $1 AND to_status = 'IN_REVIEW' ORDER BY id DESC LIMIT 1`,
    [order.id],
  );
  const previous = prev.rows[0]?.from_status;
  if (to === 'CANCELLED') {
    const moved = await ctx.tx.query(`SELECT 1 FROM journal_entries WHERE order_id = $1 LIMIT 1`, [order.id]);
    if (moved.rowCount) {
      throw new DomainError('FUNDS_MOVED', 'La orden ya movió fondos; se necesita una devolución, no una cancelación');
    }
  } else if (to !== previous) {
    throw new DomainError('INVALID_TRANSITION', `Solo puede volver a ${previous} o cancelarse`);
  }
  await transition(ctx, order, to, `Resolución: ${note.trim()}`);
  return { order };
}

export async function listOrders(q: Db | Tx, status?: string) {
  const r = await q.query(
    `SELECT o.*, c.name AS counterparty_name,
            (SELECT count(*) FROM approvals a WHERE a.order_id = o.id)::int AS approvals
     FROM orders o JOIN counterparties c ON c.id = o.counterparty_id
     WHERE ($1::text IS NULL OR o.status = $1) ORDER BY o.id DESC LIMIT 200`,
    [status ?? null],
  );
  return r.rows;
}

export async function getOrderDetail(q: Db | Tx, id: string) {
  const o = await q.query(
    `SELECT o.*, c.name AS counterparty_name, c.bank_account, c.tron_address, c.bsc_address
     FROM orders o JOIN counterparties c ON c.id = o.counterparty_id WHERE o.id = $1`,
    [id],
  );
  if (!o.rowCount) throw notFound('La orden');
  const [events, settlements, approvals] = await Promise.all([
    q.query(
      `SELECT e.*, u.full_name AS actor_name FROM order_events e JOIN users u ON u.id = e.actor_id
       WHERE order_id = $1 ORDER BY e.id`,
      [id],
    ),
    q.query(
      `SELECT s.*, u.full_name AS recorded_by_name FROM settlements s JOIN users u ON u.id = s.recorded_by
       WHERE order_id = $1 ORDER BY s.id`,
      [id],
    ),
    q.query(
      `SELECT a.*, u.full_name AS approver_name FROM approvals a JOIN users u ON u.id = a.approver_id
       WHERE order_id = $1 ORDER BY a.id`,
      [id],
    ),
  ]);
  const order = o.rows[0];
  const destination =
    order.side === 'SELL' ? (order.network === 'TRON' ? order.tron_address : order.bsc_address) : order.bank_account;
  return { ...order, destination, events: events.rows, settlements: settlements.rows, approvalList: approvals.rows };
}
