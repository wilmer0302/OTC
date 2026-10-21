import type { Tx } from '../../db/pool.js';
import { DomainError, invalid, notFound } from '../../domain/errors.js';
import { actorDbId, type Ctx } from '../../platform/context.js';
import { recordTransition } from '../../platform/events.js';
import { approvedDestination } from '../counterparties/service.js';
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
