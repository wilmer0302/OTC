import type { Tx } from '../../db/pool.js';
import { DomainError, invalid, notFound } from '../../domain/errors.js';
import { actorDbId, type Ctx } from '../../platform/context.js';
import { history, recordAction, recordTransition } from '../../platform/events.js';
import { D, fmt, parseCopInteger, parseUsdtAmount, usdtToBaseUnits } from '../../platform/money.js';
import { approvedDestination } from '../counterparties/service.js';
import { authorize } from '../identity/permissions.js';
import {
  lockAccounts,
  lockReservation,
  openReservationFor,
  openReservationForTransfer,
  releaseReservation,
  reserve,
  unlockReservation,
} from '../liquidity/service.js';
import { isValidExternalRef } from '../orders/domain.js';
import type { OrderRow } from '../orders/service.js';
import { transferCanMove, type TransferStatus } from './domain.js';

export interface TransferRow {
  id: string;
  number: string;
  order_id: string | null;
  purpose: 'COBRO' | 'ENTREGA' | 'DEVOLUCION' | 'TRASLADO';
  direction: 'IN' | 'OUT';
  rail: 'BANK' | 'TRON' | 'BSC';
  asset: 'COP' | 'USDT';
  amount: string;
  account_id: string;
  destination_id: string | null;
  to_account_id: string | null;
  counterparty_ref: string | null;
  external_ref: string | null;
  retry_of: string | null;
  status: TransferStatus;
  status_reason: string | null;
  confirmations: number | null;
  sent_at: Date | null;
  created_at: Date;
}

export async function lockTransfer(tx: Tx, id: string): Promise<TransferRow> {
  const r = await tx.query<TransferRow>('SELECT * FROM otc.transfers WHERE id = $1 FOR UPDATE', [id]);
  if (!r.rowCount) throw notFound('La transferencia');
  return r.rows[0];
}

/** Cambia el estado de una transferencia bloqueada, con historial. Los campos extra se escriben en la misma sentencia. */
export async function moveTransfer(
  ctx: Ctx,
  t: TransferRow,
  to: TransferStatus,
  reason: string | null,
  extra: { externalRef?: string; confirmations?: number; sentAt?: Date; checkedAt?: Date } = {},
  data: Record<string, unknown> = {},
): Promise<TransferRow> {
  if (!transferCanMove(t.status, to)) {
    throw new DomainError('INVALID_TRANSITION', `La transferencia ${t.number} no puede pasar de ${t.status} a ${to}`);
  }
  const r = await ctx.tx.query<TransferRow>(
    `UPDATE otc.transfers SET status = $2, status_reason = $3, updated_at = $4,
       external_ref = COALESCE($5, external_ref), confirmations = COALESCE($6, confirmations),
       sent_at = COALESCE($7, sent_at), last_checked_at = COALESCE($8, last_checked_at)
     WHERE id = $1 RETURNING *`,
    [t.id, to, reason, ctx.now(), extra.externalRef ?? null, extra.confirmations ?? null, extra.sentAt ?? null, extra.checkedAt ?? null],
  );
  await recordTransition(ctx, 'transfer', t.id, t.status, to, reason, data);
  return r.rows[0];
}

/** Cada referencia bancaria y cada hash se acepta una sola vez en todo el sistema. */
export async function assertRefUnused(tx: Tx, rail: TransferRow['rail'], ref: string): Promise<void> {
  const r = await tx.query(
    `SELECT t.number AS transfer, o.number AS order FROM otc.transfers t LEFT JOIN otc.orders o ON o.id = t.order_id
     WHERE t.rail = $1 AND lower(t.external_ref) = lower($2)`,
    [rail, ref],
  );
  if (r.rowCount) {
    const row = r.rows[0];
    throw new DomainError(
      'DUPLICATE_REFERENCE',
      row.order ? `Esta referencia ya está registrada en la orden ${row.order}` : `Esta referencia ya está registrada en la transferencia ${row.transfer}`,
    );
  }
}

function checkRef(rail: TransferRow['rail'], ref: string) {
  if (!isValidExternalRef(rail, ref)) {
    throw invalid(
      rail === 'BANK'
        ? 'Referencia bancaria inválida (letras, números y guiones, de 4 a 64)'
        : rail === 'TRON'
          ? 'Hash de Tron inválido (64 caracteres hexadecimales)'
          : 'Hash de BSC inválido (0x y 64 caracteres hexadecimales)',
    );
  }
}

/**
 * Cobro: el cliente reporta que pagó. Queda Enviada con su referencia o hash; la confirmación
 * la da el banco o la red, nunca este registro.
 */
export async function createCollection(ctx: Ctx, order: OrderRow, ref: string, fromRef: string | null): Promise<TransferRow> {
  const rail = order.side === 'SELL' ? 'BANK' : order.network;
  checkRef(rail, ref);
  await assertRefUnused(ctx.tx, rail, ref);
  const now = ctx.now();
  const r = await ctx.tx.query<TransferRow>(
    `INSERT INTO otc.transfers (order_id, purpose, direction, rail, asset, amount, account_id, counterparty_ref, external_ref,
       status, sent_at, created_by, created_at, updated_at)
     VALUES ($1,'COBRO','IN',$2,$3,$4,$5,$6,$7,'ENVIADA',$8,$9,$8,$8) RETURNING *`,
    [
      order.id,
      rail,
      order.side === 'SELL' ? 'COP' : 'USDT',
      order.side === 'SELL' ? order.total_cop : order.usdt_amount,
      order.receive_account_id,
      fromRef,
      ref,
      now,
      actorDbId(ctx.actor),
    ],
  );
  const t = r.rows[0];
  await recordTransition(ctx, 'transfer', t.id, null, 'ENVIADA', 'Pago reportado por el cliente', {
    orderId: order.id,
    rail,
    amount: t.amount,
    reference: ref,
  });
  return t;
}

/**
 * Entrega: nace autorizada desde la orden autorizada. Destino, monto y red salen de la orden y de
 * la lista blanca; nada es editable. Un reintento es una transferencia nueva enlazada a la fallida.
 */
export async function createDelivery(ctx: Ctx, order: OrderRow, retryOf: string | null): Promise<TransferRow> {
  const rail = order.side === 'SELL' ? order.network : 'BANK';
  const dest = await approvedDestination(ctx.tx, order.counterparty_id, rail, order.destination_id);
  if (!dest) throw new DomainError('NO_DESTINATION', `El destino ${rail} de la orden ${order.number} ya no está aprobado`);
  const now = ctx.now();
  const r = await ctx.tx.query<TransferRow>(
    `INSERT INTO otc.transfers (order_id, purpose, direction, rail, asset, amount, account_id, destination_id, retry_of,
       status, created_by, created_at, updated_at)
     VALUES ($1,'ENTREGA','OUT',$2,$3,$4,$5,$6,$7,'AUTORIZADA',$8,$9,$9) RETURNING *`,
    [
      order.id,
      rail,
      order.side === 'SELL' ? 'USDT' : 'COP',
      order.side === 'SELL' ? order.usdt_amount : order.total_cop,
      order.deliver_account_id,
      dest.id,
      retryOf,
      actorDbId(ctx.actor),
      now,
    ],
  );
  const t = r.rows[0];
  await recordTransition(ctx, 'transfer', t.id, null, 'AUTORIZADA', retryOf ? 'Reintento aprobado' : 'Entrega autorizada', {
    orderId: order.id,
    rail,
    amount: t.amount,
    retryOf,
  });
  return t;
}

export async function transfersOf(tx: Tx, orderId: string): Promise<TransferRow[]> {
  const r = await tx.query<TransferRow>('SELECT * FROM otc.transfers WHERE order_id = $1 ORDER BY number', [orderId]);
  return r.rows;
}

// ---------- Envío: la plataforma prepara, la billetera o el banco ejecutan fuera ----------

/**
 * Instrucción de envío para firmar en la billetera externa (USDT) o para ordenar en el banco (pesos).
 * Todo sale de la transferencia autorizada y de la lista blanca: no hay campos editables.
 * La plataforma no firma ni ve llaves.
 */
async function instructionFor(tx: Tx, t: TransferRow) {
  const from = await tx.query('SELECT code, name, external_ref FROM otc.accounts WHERE id = $1', [t.account_id]);
  let to: { kind: string; value: string; bank?: string | null };
  if (t.destination_id) {
    const d = await tx.query('SELECT value, bank_name FROM otc.destinations WHERE id = $1', [t.destination_id]);
    to = { kind: 'CLIENTE', value: d.rows[0].value, bank: d.rows[0].bank_name };
  } else {
    const a = await tx.query('SELECT code, external_ref FROM otc.accounts WHERE id = $1', [t.to_account_id]);
    to = { kind: 'CUENTA_PROPIA', value: a.rows[0].external_ref ?? a.rows[0].code };
  }
  return {
    transfer: t.number,
    rail: t.rail,
    asset: t.asset,
    amount: t.amount,
    amountBaseUnits: t.rail === 'BANK' ? null : usdtToBaseUnits(new D(t.amount), t.rail),
    from: { account: from.rows[0].code, name: from.rows[0].name, ref: from.rows[0].external_ref },
    to,
    note:
      t.rail === 'BANK'
        ? 'Ordena el pago en el banco y registra aquí la referencia que te entregue.'
        : 'Firma en la billetera externa y registra aquí el hash. La plataforma no firma ni guarda llaves.',
  };
}

/** Pasa un envío de USDT a "en firma" y entrega la instrucción. Los pesos no pasan por firma. */
export async function prepareSigning(ctx: Ctx, id: string) {
  authorize(ctx.actor, 'transfer.manage');
  const t = await lockTransfer(ctx.tx, id);
  if (t.direction !== 'OUT') throw invalid('Solo los envíos de la mesa se firman');
  if (t.rail === 'BANK') throw invalid('Los pagos en pesos no pasan por firma: registra la referencia del banco');
  const moved = t.status === 'EN_FIRMA' ? t : await moveTransfer(ctx, t, 'EN_FIRMA', 'Instrucción entregada a la billetera externa');
  return { transfer: moved, instruction: await instructionFor(ctx.tx, moved) };
}

export async function getInstruction(ctx: Pick<Ctx, 'tx'>, id: string) {
  const r = await ctx.tx.query<TransferRow>('SELECT * FROM otc.transfers WHERE id = $1', [id]);
  if (!r.rowCount) throw notFound('La transferencia');
  return instructionFor(ctx.tx, r.rows[0]);
}

/**
 * Se registra el hash (o la referencia del banco) del envío ya hecho fuera. La transferencia queda
 * Enviada: todavía nadie la vio en la red. Si es una entrega, la orden pasa a Entrega enviada.
 */
export async function registerSent(ctx: Ctx, id: string, ref: string) {
  authorize(ctx.actor, 'transfer.manage');
  const t = await lockTransfer(ctx.tx, id);
  if (t.direction !== 'OUT') throw invalid('Los cobros se registran desde la orden');
  if (t.rail !== 'BANK' && t.status === 'AUTORIZADA') {
    throw new DomainError('INVALID_STATE', 'Primero prepara la instrucción de firma; luego registra el hash');
  }
  const value = ref.trim();
  checkRef(t.rail, value);
  await assertRefUnused(ctx.tx, t.rail, value);
  const now = ctx.now();
  const moved = await moveTransfer(ctx, t, 'ENVIADA', null, { externalRef: value, sentAt: now }, { reference: value });
  let order: OrderRow | null = null;
  if (t.purpose === 'ENTREGA' && t.order_id) {
    const o = await ctx.tx.query<OrderRow>('SELECT * FROM otc.orders WHERE id = $1 FOR UPDATE', [t.order_id]);
    if (o.rows[0].status === 'ENTREGA_AUTORIZADA') {
      const r = await ctx.tx.query<OrderRow>(
        `UPDATE otc.orders SET status = 'ENTREGA_ENVIADA', status_reason = NULL, updated_at = $2 WHERE id = $1 RETURNING *`,
        [t.order_id, now],
      );
      await recordTransition(ctx, 'order', t.order_id, 'ENTREGA_AUTORIZADA', 'ENTREGA_ENVIADA', null, { transferId: t.id, reference: value });
      order = r.rows[0];
    }
  }
  return { transfer: moved, order };
}

/**
 * Anula un envío que todavía no salió. En una entrega, la reserva vuelve a la orden y la orden
 * sigue autorizada esperando un reintento aprobado; en un traslado, la reserva se libera.
 */
export async function cancelTransfer(ctx: Ctx, id: string, reason: string) {
  authorize(ctx.actor, 'transfer.manage');
  if (!reason.trim()) throw invalid('Indica el motivo');
  const t = await lockTransfer(ctx.tx, id);
  if (t.direction !== 'OUT') throw invalid('Un cobro reportado no se anula: se confirma, falla o va a revisión');
  const moved = await moveTransfer(ctx, t, 'CANCELADA', reason.trim());
  const res = await openReservationForTransfer(ctx.tx, t.id);
  if (res) {
    if (t.order_id) {
      await unlockReservation(ctx, res.id, `Envío ${t.number} cancelado`);
    } else {
      await releaseReservation(ctx, res.id, `Traslado ${t.number} cancelado`);
    }
  }
  return moved;
}

/**
 * Reintento de una entrega fallida o cancelada: una transferencia nueva enlazada a la anterior,
 * con aprobación propia (la ruta pide de nuevo el segundo factor). Nunca se reactiva la fallida.
 */
export async function retryDelivery(ctx: Ctx, failedId: string, reason: string) {
  authorize(ctx.actor, 'order.approve');
  if (!reason.trim()) throw invalid('Indica por qué se reintenta');
  const failed = await lockTransfer(ctx.tx, failedId);
  if (failed.purpose !== 'ENTREGA' || !failed.order_id) throw invalid('Solo se reintentan entregas de una orden');
  if (failed.status !== 'FALLIDA' && failed.status !== 'CANCELADA') {
    throw new DomainError('INVALID_STATE', `La transferencia ${failed.number} está ${failed.status}; solo se reintenta una fallida o cancelada`);
  }
  const o = await ctx.tx.query<OrderRow>('SELECT * FROM otc.orders WHERE id = $1 FOR UPDATE', [failed.order_id]);
  const order = o.rows[0];
  if (order.status !== 'ENTREGA_AUTORIZADA') throw new DomainError('INVALID_STATE', `La orden ${order.number} está ${order.status}`);
  const retry = await createDelivery(ctx, order, failed.id);
  const res = await openReservationFor(ctx.tx, order.id);
  if (!res || res.status !== 'ACTIVE') throw new Error(`La orden ${order.number} no tiene su reserva disponible para reintentar`);
  await lockReservation(ctx, res.id, retry.id);
  await recordAction(ctx, 'transfer.retry', 'transfer', retry.id, { retryOf: failed.id, reason: reason.trim() });
  return retry;
}

// ---------- Traslados entre cuentas propias ----------

/**
 * Mover liquidez entre cuentas propias (por ejemplo, del exchange a la billetera). El monto sale
 * del disponible de origen de inmediato (queda reservado) y entra al destino solo al confirmarse.
 */
export async function createInternalTransfer(ctx: Ctx, input: { fromAccountId: string; toAccountId: string; amount: string; reason: string }) {
  authorize(ctx.actor, 'transfer.manage');
  if (!input.reason.trim()) throw invalid('Indica el motivo del traslado');
  if (input.fromAccountId === input.toAccountId) throw invalid('El origen y el destino deben ser distintos');
  const accounts = await lockAccounts(ctx.tx, [input.fromAccountId, input.toAccountId]);
  const from = accounts.get(input.fromAccountId)!;
  const to = accounts.get(input.toAccountId)!;
  if (from.kind !== 'LIQUIDITY' || to.kind !== 'LIQUIDITY') throw invalid('Los traslados son entre cuentas reales');
  if (from.asset !== to.asset) throw invalid(`No se traslada ${from.asset} a una cuenta de ${to.asset}`);
  if (from.network && to.network && from.network !== to.network) throw invalid('Las billeteras están en redes distintas');
  const rail = from.asset === 'COP' ? 'BANK' : (from.network ?? to.network);
  if (!rail) throw invalid('Indica una billetera en la red del traslado');
  const amount = from.asset === 'COP' ? parseCopInteger(input.amount) : parseUsdtAmount(input.amount);
  const now = ctx.now();
  const r = await ctx.tx.query<TransferRow>(
    `INSERT INTO otc.transfers (purpose, direction, rail, asset, amount, account_id, to_account_id, status, status_reason,
       created_by, created_at, updated_at)
     VALUES ('TRASLADO','OUT',$1,$2,$3,$4,$5,'AUTORIZADA',$6,$7,$8,$8) RETURNING *`,
    [rail, from.asset, fmt(amount), from.id, to.id, input.reason.trim(), actorDbId(ctx.actor), now],
  );
  const t = r.rows[0];
  await reserve(ctx, { accountId: from.id, transferId: t.id, amount, reason: `Traslado ${t.number} a ${to.code}` });
  await recordTransition(ctx, 'transfer', t.id, null, 'AUTORIZADA', input.reason.trim(), { from: from.code, to: to.code, amount: fmt(amount) });
  return t;
}

// ---------- Consultas ----------

export async function getTransfer(ctx: Pick<Ctx, 'tx'>, id: string) {
  const r = await ctx.tx.query(
    `SELECT t.*, o.number AS order_number, a.code AS account_code, ta.code AS to_account_code
     FROM otc.transfers t JOIN otc.accounts a ON a.id = t.account_id
     LEFT JOIN otc.accounts ta ON ta.id = t.to_account_id LEFT JOIN otc.orders o ON o.id = t.order_id
     WHERE t.id = $1`,
    [id],
  );
  if (!r.rowCount) throw notFound('La transferencia');
  return { ...r.rows[0], history: await history(ctx, 'transfer', id) };
}

/** Lista con antigüedad: lo que lleva más tiempo enviado sin confirmar aparece primero. */
export async function listTransfers(ctx: Pick<Ctx, 'tx'>, filter: { status?: TransferStatus; purpose?: TransferRow['purpose'] }) {
  const r = await ctx.tx.query(
    `SELECT t.id, t.number, t.purpose, t.direction, t.rail, t.asset, t.amount, t.status, t.status_reason, t.external_ref,
            t.confirmations, t.sent_at, t.last_checked_at, t.created_at, o.number AS order_number, a.code AS account_code
     FROM otc.transfers t JOIN otc.accounts a ON a.id = t.account_id LEFT JOIN otc.orders o ON o.id = t.order_id
     WHERE ($1::text IS NULL OR t.status = $1) AND ($2::text IS NULL OR t.purpose = $2)
     ORDER BY t.sent_at ASC NULLS LAST, t.created_at DESC LIMIT 200`,
    [filter.status ?? null, filter.purpose ?? null],
  );
  return r.rows;
}
