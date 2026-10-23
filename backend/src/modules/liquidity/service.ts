import type { Db, Tx } from '../../db/pool.js';
import { DomainError, invalid, notFound } from '../../domain/errors.js';
import type { Network } from '../../integrations/ports.js';
import { actorDbId, type Ctx } from '../../platform/context.js';
import { recordAction } from '../../platform/events.js';
import { D, fmt, parseCopInteger, parseUsdtAmount, type Dec } from '../../platform/money.js';
import { authorize } from '../identity/permissions.js';
import { assertBalanced, availableOf, reservationCanMove, type Asset, type ReservationStatus } from './domain.js';

export interface AccountRow {
  id: string;
  code: string;
  name: string;
  asset: Asset;
  kind: 'LIQUIDITY' | 'INTERNAL';
  liquidity_type: 'BANK' | 'WALLET' | 'EXCHANGE' | null;
  network: Network | null;
  external_ref: string | null;
  is_default: boolean;
  active: boolean;
  balance: string;
}

// ---------- Cuentas ----------

/** Bloquea cuentas siempre en el mismo orden (por id) para que dos pasos nunca se esperen mutuamente. */
export async function lockAccounts(tx: Tx, ids: string[]): Promise<Map<string, AccountRow>> {
  const unique = [...new Set(ids)].sort();
  const r = await tx.query<AccountRow>('SELECT * FROM otc.accounts WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE', [unique]);
  if (r.rowCount !== unique.length) throw notFound('Una de las cuentas');
  return new Map(r.rows.map((a) => [a.id, a]));
}

export async function accountByCode(q: Db | Tx, code: string): Promise<AccountRow> {
  const r = await q.query<AccountRow>('SELECT * FROM otc.accounts WHERE code = $1', [code]);
  if (!r.rowCount) throw notFound(`La cuenta ${code}`);
  return r.rows[0];
}

/** Cuenta por defecto de la mesa para un activo (y red, si es USDT). */
export async function defaultAccount(q: Db | Tx, asset: Asset, network: Network | null): Promise<AccountRow> {
  const r = await q.query<AccountRow>(
    `SELECT * FROM otc.accounts WHERE is_default AND active AND asset = $1 AND network IS NOT DISTINCT FROM $2`,
    [asset, asset === 'USDT' ? network : null],
  );
  if (!r.rowCount) {
    throw new DomainError('NO_ACCOUNT', `No hay una cuenta por defecto de ${asset}${asset === 'USDT' ? ` en ${network}` : ''}`);
  }
  return r.rows[0];
}

const tradingCode = (asset: Asset) => `TRADING_${asset}`;
const equityCode = (asset: Asset) => `EQUITY_${asset}`;
export const adjustmentsCode = (asset: Asset) => `ADJUSTMENTS_${asset}`;
export { tradingCode, equityCode };

export interface NewAccount {
  code: string;
  name: string;
  asset: Asset;
  liquidityType: 'BANK' | 'WALLET' | 'EXCHANGE';
  network?: Network | null;
  externalRef?: string | null;
  isDefault?: boolean;
}

export async function createLiquidityAccount(ctx: Ctx, input: NewAccount): Promise<AccountRow> {
  authorize(ctx.actor, 'liquidity.manage');
  if (input.liquidityType === 'WALLET') {
    if (!input.network || !input.externalRef) throw invalid('Una billetera necesita red y dirección');
    if (!ctx.integrations.chain.isValidAddress(input.network, input.externalRef)) throw invalid(`Dirección ${input.network} inválida`);
  }
  if (input.isDefault) {
    await ctx.tx.query(
      `UPDATE otc.accounts SET is_default = FALSE WHERE is_default AND asset = $1 AND network IS NOT DISTINCT FROM $2`,
      [input.asset, input.network ?? null],
    );
  }
  const r = await ctx.tx.query<AccountRow>(
    `INSERT INTO otc.accounts (code, name, asset, kind, liquidity_type, network, external_ref, is_default, created_by)
     VALUES ($1,$2,$3,'LIQUIDITY',$4,$5,$6,$7,$8) RETURNING *`,
    [input.code, input.name, input.asset, input.liquidityType, input.network ?? null, input.externalRef ?? null, !!input.isDefault, actorDbId(ctx.actor)],
  );
  await recordAction(ctx, 'liquidity.account_create', 'account', r.rows[0].id, { ...input });
  return r.rows[0];
}

// ---------- Libro contable ----------

export interface EntryLine {
  accountId: string;
  amount: Dec; // débito positivo, crédito negativo
}

export interface NewEntry {
  kind: 'OPENING' | 'NORMAL' | 'REVERSAL' | 'ADJUSTMENT';
  description: string;
  orderId?: string | null;
  transferId?: string | null;
  reversesEntryId?: string | null;
  lines: EntryLine[];
}

/**
 * Registra un asiento. Valida que cuadre por activo antes de escribir; la base lo vuelve a
 * verificar al confirmar la transacción. Bloquea las cuentas que toca, en orden fijo.
 */
export async function postEntry(ctx: Ctx, input: NewEntry): Promise<string> {
  const accounts = await lockAccounts(ctx.tx, input.lines.map((l) => l.accountId));
  try {
    assertBalanced(input.lines.map((l) => ({ asset: accounts.get(l.accountId)!.asset, amount: l.amount })));
  } catch (e) {
    throw invalid((e as Error).message);
  }
  for (const l of input.lines) {
    const a = accounts.get(l.accountId)!;
    if (a.kind === 'LIQUIDITY' && new D(a.balance).plus(l.amount).lt(0)) {
      throw new DomainError('NEGATIVE_BALANCE', `El asiento dejaría ${a.name} en negativo`);
    }
  }
  const e = await ctx.tx.query<{ id: string }>(
    `INSERT INTO otc.journal_entries (kind, description, order_id, transfer_id, reverses_entry_id, created_by, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [input.kind, input.description, input.orderId ?? null, input.transferId ?? null, input.reversesEntryId ?? null, actorDbId(ctx.actor), ctx.now()],
  );
  const entryId = e.rows[0].id;
  for (const l of input.lines) {
    await ctx.tx.query('INSERT INTO otc.journal_lines (entry_id, account_id, amount) VALUES ($1,$2,$3)', [entryId, l.accountId, fmt(l.amount)]);
  }
  await recordAction(ctx, 'ledger.post', 'journal_entry', entryId, {
    kind: input.kind,
    description: input.description,
    orderId: input.orderId ?? null,
    transferId: input.transferId ?? null,
    lines: input.lines.map((l) => ({ account: accounts.get(l.accountId)!.code, amount: fmt(l.amount) })),
  });
  return entryId;
}

/** Corrige sin borrar: un asiento de reverso con las mismas líneas en signo contrario. */
export async function reverseEntry(ctx: Ctx, entryId: string, reason: string): Promise<string> {
  if (!reason.trim()) throw invalid('Indica el motivo del reverso');
  const e = await ctx.tx.query('SELECT * FROM otc.journal_entries WHERE id = $1', [entryId]);
  if (!e.rowCount) throw notFound('El asiento');
  if (e.rows[0].kind === 'REVERSAL') throw new DomainError('INVALID_STATE', 'Un reverso no se revierte; registra un ajuste');
  const done = await ctx.tx.query('SELECT id FROM otc.journal_entries WHERE reverses_entry_id = $1', [entryId]);
  if (done.rowCount) throw new DomainError('ALREADY_REVERSED', 'Ese asiento ya fue revertido');
  const lines = await ctx.tx.query<{ account_id: string; amount: string }>(
    'SELECT account_id, amount FROM otc.journal_lines WHERE entry_id = $1',
    [entryId],
  );
  return postEntry(ctx, {
    kind: 'REVERSAL',
    description: `Reverso: ${reason.trim()}`,
    orderId: e.rows[0].order_id,
    transferId: e.rows[0].transfer_id,
    reversesEntryId: entryId,
    lines: lines.rows.map((l) => ({ accountId: l.account_id, amount: new D(l.amount).neg() })),
  });
}

/** Saldo inicial de una cuenta real contra el capital (en la demo, saldos ficticios). */
export async function openingBalance(ctx: Ctx, accountId: string, amount: string, reason: string): Promise<string> {
  authorize(ctx.actor, 'liquidity.manage');
  const accounts = await lockAccounts(ctx.tx, [accountId]);
  const account = accounts.get(accountId)!;
  if (account.kind !== 'LIQUIDITY') throw invalid('El saldo inicial va en una cuenta real (banco, billetera o exchange)');
  if (!reason.trim()) throw invalid('Indica de dónde sale el saldo inicial');
  const used = await ctx.tx.query('SELECT 1 FROM otc.journal_lines WHERE account_id = $1 LIMIT 1', [accountId]);
  if (used.rowCount) throw new DomainError('INVALID_STATE', 'La cuenta ya tiene movimientos; un saldo inicial solo va en una cuenta nueva');
  const value = account.asset === 'COP' ? parseCopInteger(amount, 'Saldo inicial') : parseUsdtAmount(amount, 'Saldo inicial');
  const equity = await accountByCode(ctx.tx, equityCode(account.asset));
  return postEntry(ctx, {
    kind: 'OPENING',
    description: `Saldo inicial: ${reason.trim()}`,
    lines: [
      { accountId, amount: value },
      { accountId: equity.id, amount: value.neg() },
    ],
  });
}

// ---------- Reservas ----------

async function reservedOn(tx: Tx, accountId: string): Promise<Dec> {
  const r = await tx.query<{ total: string | null }>(
    `SELECT sum(amount) AS total FROM otc.reservations WHERE account_id = $1 AND status IN ('ACTIVE','LOCKED')`,
    [accountId],
  );
  return new D(r.rows[0].total ?? 0);
}

/**
 * Aparta liquidez para una orden, o para un traslado propio (sin orden: la reserva nace atada a
 * su transferencia). Corre con la cuenta bloqueada: dos operaciones simultáneas nunca cuentan el
 * mismo saldo.
 */
export async function reserve(
  ctx: Ctx,
  input: { accountId: string; orderId?: string | null; transferId?: string | null; amount: Dec; reason: string },
) {
  if (!input.orderId && !input.transferId) throw new Error('Una reserva es de una orden o de un traslado');
  const account = (await lockAccounts(ctx.tx, [input.accountId])).get(input.accountId)!;
  if (account.kind !== 'LIQUIDITY' || !account.active) throw invalid('Solo se reserva en una cuenta real activa');
  const reserved = await reservedOn(ctx.tx, account.id);
  const available = availableOf(new D(account.balance), reserved);
  if (available.lt(input.amount)) {
    throw new DomainError(
      'INSUFFICIENT_LIQUIDITY',
      `Liquidez insuficiente en ${account.name}: disponible ${fmt(available)}, reservado ${fmt(reserved)}, se necesitan ${fmt(input.amount)}`,
    );
  }
  const r = await ctx.tx.query<{ id: string }>(
    `INSERT INTO otc.reservations (account_id, order_id, transfer_id, amount, status, reason, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$7) RETURNING id`,
    [account.id, input.orderId ?? null, input.transferId ?? null, fmt(input.amount), input.orderId ? 'ACTIVE' : 'LOCKED', input.reason, ctx.now()],
  );
  await recordAction(ctx, 'liquidity.reserve', 'reservation', r.rows[0].id, {
    account: account.code,
    orderId: input.orderId ?? null,
    transferId: input.transferId ?? null,
    amount: fmt(input.amount),
  });
  return r.rows[0].id;
}

/** Reserva abierta atada a una transferencia (entrega en curso o traslado). */
export async function openReservationForTransfer(tx: Tx, transferId: string) {
  const r = await tx.query(
    `SELECT * FROM otc.reservations WHERE transfer_id = $1 AND status IN ('ACTIVE','LOCKED') FOR UPDATE`,
    [transferId],
  );
  return r.rows[0] ?? null;
}

export async function openReservationFor(tx: Tx, orderId: string) {
  const r = await tx.query(
    `SELECT * FROM otc.reservations WHERE order_id = $1 AND status IN ('ACTIVE','LOCKED') FOR UPDATE`,
    [orderId],
  );
  return r.rows[0] ?? null;
}

async function moveReservation(ctx: Ctx, id: string, to: ReservationStatus, transferId: string | null, note: string) {
  const r = await ctx.tx.query('SELECT * FROM otc.reservations WHERE id = $1 FOR UPDATE', [id]);
  if (!r.rowCount) throw notFound('La reserva');
  const res = r.rows[0];
  if (!reservationCanMove(res.status, to)) {
    throw new DomainError('INVALID_TRANSITION', `La reserva no puede pasar de ${res.status} a ${to}`);
  }
  await ctx.tx.query('UPDATE otc.reservations SET status = $2, transfer_id = $3, updated_at = $4 WHERE id = $1', [
    id,
    to,
    to === 'ACTIVE' ? null : (transferId ?? res.transfer_id),
    ctx.now(),
  ]);
  await recordAction(ctx, `liquidity.reservation_${to.toLowerCase()}`, 'reservation', id, { from: res.status, to, transferId, note });
}

/** Ata la reserva a una transferencia en curso. */
export const lockReservation = (ctx: Ctx, id: string, transferId: string) => moveReservation(ctx, id, 'LOCKED', transferId, 'Transferencia en curso');
/** La transferencia falló de forma demostrada: la reserva vuelve a la orden. */
export const unlockReservation = (ctx: Ctx, id: string, note: string) => moveReservation(ctx, id, 'ACTIVE', null, note);
/** La transferencia se confirmó: la reserva se consume en la misma transacción que el asiento. */
export const consumeReservation = (ctx: Ctx, id: string) => moveReservation(ctx, id, 'CONSUMED', null, 'Entrega confirmada');
/** La orden venció o se canceló antes de entregar. */
export const releaseReservation = (ctx: Ctx, id: string, note: string) => moveReservation(ctx, id, 'RELEASED', null, note);

// ---------- Consultas ----------

export async function liquiditySummary(ctx: Pick<Ctx, 'tx'>) {
  const r = await ctx.tx.query(
    `SELECT a.id, a.code, a.name, a.asset, a.liquidity_type, a.network, a.external_ref, a.is_default, a.balance,
            COALESCE(sum(r.amount) FILTER (WHERE r.status = 'ACTIVE'), 0) AS reserved_active,
            COALESCE(sum(r.amount) FILTER (WHERE r.status = 'LOCKED'), 0) AS reserved_locked
     FROM otc.accounts a LEFT JOIN otc.reservations r ON r.account_id = a.id AND r.status IN ('ACTIVE','LOCKED')
     WHERE a.kind = 'LIQUIDITY' AND a.active
     GROUP BY a.id ORDER BY a.asset, a.code`,
  );
  return r.rows.map((a) => {
    const reserved = new D(a.reserved_active).plus(a.reserved_locked);
    return { ...a, reserved: fmt(reserved), available: fmt(availableOf(new D(a.balance), reserved)) };
  });
}

/** El acumulado de cada cuenta debe coincidir con la suma de sus líneas. Se usa en conciliación y pruebas. */
export async function verifyBalances(q: Db | Tx) {
  const r = await q.query(
    `SELECT a.code, a.balance, COALESCE(sum(l.amount), 0) AS ledger
     FROM otc.accounts a LEFT JOIN otc.journal_lines l ON l.account_id = a.id
     GROUP BY a.id HAVING a.balance <> COALESCE(sum(l.amount), 0)`,
  );
  return { ok: r.rowCount === 0, mismatches: r.rows };
}

export async function entriesFor(ctx: Pick<Ctx, 'tx'>, filter: { orderId?: string; accountId?: string }) {
  const r = await ctx.tx.query(
    `SELECT e.id, e.seq, e.kind, e.description, e.order_id, e.transfer_id, e.reverses_entry_id, e.created_at,
            json_agg(json_build_object('account', a.code, 'asset', a.asset, 'amount', l.amount) ORDER BY l.id) AS lines
     FROM otc.journal_entries e
     JOIN otc.journal_lines l ON l.entry_id = e.id JOIN otc.accounts a ON a.id = l.account_id
     WHERE ($1::uuid IS NULL OR e.order_id = $1)
       AND ($2::uuid IS NULL OR e.id IN (SELECT entry_id FROM otc.journal_lines WHERE account_id = $2))
     GROUP BY e.id ORDER BY e.seq DESC LIMIT 200`,
    [filter.orderId ?? null, filter.accountId ?? null],
  );
  return r.rows;
}
