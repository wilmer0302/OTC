import type { Db, Tx } from '../../db/pool.js';
import { DomainError, invalid, notFound } from '../../domain/errors.js';
import { isSandbox, type Integrations } from '../../integrations/ports.js';
import { openCase, resolveCasesFor } from '../../platform/cases.js';
import { actorDbId, type Actor, type Ctx } from '../../platform/context.js';
import { recordTransition } from '../../platform/events.js';
import { baseUnitsToUsdt, D, fmt, parseCopInteger, parseUsdtAmount } from '../../platform/money.js';
import { inTransaction } from '../../platform/tx.js';
import { assertDifferentPerson, authorize } from '../identity/permissions.js';
import { accountByCode, adjustmentsCode, postEntry, type AccountRow } from '../liquidity/service.js';
import { FINAL_ITEM, itemCanMove, matchMovement, runStatusOf, type ItemStatus, type RunStatus } from './domain.js';

// Conciliación operativa (especificación, módulo 10). Cruza cada movimiento del banco, de la red o
// de un extracto cargado a mano con los movimientos del libro de esa cuenta. Nada se edita: las
// diferencias se resuelven con un ajuste aprobado por dos personas.

export interface StatementLine {
  reference: string;
  direction: 'IN' | 'OUT';
  amount: string; // pesos enteros o USDT con 6 decimales
  occurredAt: string;
  raw: Record<string, unknown>;
}

interface RunRow {
  id: string;
  account_id: string;
  business_date: string;
  status: RunStatus;
}

interface ItemRow {
  id: string;
  number: string;
  run_id: string;
  external_movement_id: string | null;
  transfer_id: string | null;
  status: ItemStatus;
  status_reason: string | null;
  observed_amount: string | null;
  expected_amount: string | null;
}

// ---------- Extractos ----------

/** Pide el extracto del día al banco o a la red (fuera de cualquier transacción). */
async function fetchStatement(integrations: Integrations, account: AccountRow, date: string): Promise<{ source: 'BANK' | 'CHAIN'; lines: StatementLine[] }> {
  if (!account.external_ref) throw invalid(`La cuenta ${account.code} no tiene número o dirección registrada; carga el extracto a mano`);
  if (account.liquidity_type === 'BANK') {
    const lines = await integrations.bank.listMovements(account.external_ref, date);
    return {
      source: 'BANK',
      lines: lines.map((l) => ({ reference: l.reference, direction: l.direction, amount: l.amountCop, occurredAt: l.occurredAt, raw: { ...l } })),
    };
  }
  if (account.liquidity_type === 'WALLET' && account.network) {
    const network = account.network;
    const lines = await integrations.chain.listTransfers(network, account.external_ref, date);
    return {
      source: 'CHAIN',
      lines: lines.map((l) => ({
        reference: l.txHash,
        direction: l.direction,
        amount: fmt(baseUnitsToUsdt(l.amountBaseUnits, network)),
        occurredAt: l.occurredAt,
        raw: { ...l },
      })),
    };
  }
  throw invalid(`No hay integración de extractos para ${account.code}; carga el extracto a mano`);
}

async function lockRun(tx: Tx, accountId: string, date: string, actor: Actor, now: Date): Promise<RunRow> {
  await tx.query(
    `INSERT INTO otc.recon_runs (account_id, business_date, status, started_by, created_at, updated_at)
     VALUES ($1,$2,'ABIERTO',$3,$4,$4) ON CONFLICT (account_id, business_date) DO NOTHING`,
    [accountId, date, actorDbId(actor), now],
  );
  const r = await tx.query<RunRow>(
    `SELECT id, account_id, to_char(business_date,'YYYY-MM-DD') AS business_date, status FROM otc.recon_runs
     WHERE account_id = $1 AND business_date = $2 FOR UPDATE`,
    [accountId, date],
  );
  const run = r.rows[0];
  if (run.status === 'CERRADO') throw new DomainError('DAY_CLOSED', `El día ${date} de esta cuenta ya está cerrado`);
  return run;
}

/** Movimiento del libro con la misma referencia en esta cuenta, visto desde la cuenta. */
async function bookFor(tx: Tx, accountId: string, ref: string) {
  const r = await tx.query(
    `SELECT id, status, amount, CASE WHEN account_id = $1 THEN direction ELSE 'IN' END AS direction
     FROM otc.transfers WHERE (account_id = $1 OR to_account_id = $1) AND lower(external_ref) = lower($2)`,
    [accountId, ref],
  );
  return r.rows[0] ?? null;
}

async function moveItem(ctx: Ctx, item: ItemRow, to: ItemStatus, reason: string | null, extra: { transferId?: string; expected?: string } = {}) {
  if (!itemCanMove(item.status, to)) throw new DomainError('INVALID_TRANSITION', `La partida ${item.number} no puede pasar de ${item.status} a ${to}`);
  await ctx.tx.query(
    `UPDATE otc.recon_items SET status = $2, status_reason = $3, transfer_id = COALESCE($4, transfer_id),
       expected_amount = COALESCE($5, expected_amount), updated_at = $6 WHERE id = $1`,
    [item.id, to, reason, extra.transferId ?? null, extra.expected ?? null, ctx.now()],
  );
  await recordTransition(ctx, 'recon_item', item.id, item.status, to, reason);
  if (to === 'SIN_CONTRAPARTIDA' || to === 'CON_DIFERENCIA') await openCase(ctx, 'recon_item', item.id, to, reason ?? to);
  if (FINAL_ITEM.includes(to)) await resolveCasesFor(ctx, 'recon_item', item.id, reason ?? to);
}

async function refreshRunStatus(ctx: Ctx, runId: string) {
  const items = await ctx.tx.query<{ status: ItemStatus }>('SELECT status FROM otc.recon_items WHERE run_id = $1', [runId]);
  const run = await ctx.tx.query<{ status: RunStatus }>('SELECT status FROM otc.recon_runs WHERE id = $1', [runId]);
  const next = runStatusOf(items.rows.map((i) => i.status));
  if (run.rows[0].status !== next && run.rows[0].status !== 'CERRADO') {
    await ctx.tx.query('UPDATE otc.recon_runs SET status = $2, updated_at = $3 WHERE id = $1', [runId, next, ctx.now()]);
    await recordTransition(ctx, 'recon_run', runId, run.rows[0].status, next, null);
  }
  return next;
}

/**
 * Cruza las líneas del extracto con el libro. Las líneas ya cargadas no se duplican; las partidas
 * pendientes o sin pareja se vuelven a cruzar (su pareja pudo aparecer después). Al final, cada
 * movimiento confirmado del libro en ese día sin línea en el extracto queda Sin contrapartida.
 */
async function matchLines(ctx: Ctx, run: RunRow, account: AccountRow, source: 'BANK' | 'CHAIN' | 'MANUAL', lines: StatementLine[]) {
  const now = ctx.now();
  for (const l of lines) {
    const amount = account.asset === 'COP' ? parseCopInteger(l.amount, 'Monto del extracto') : parseUsdtAmount(l.amount, 'Monto del extracto');
    const ins = await ctx.tx.query<{ id: string }>(
      `INSERT INTO otc.external_movements (run_id, account_id, source, sandbox, external_ref, direction, amount, occurred_at, raw, loaded_by, loaded_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (account_id, lower(external_ref), direction) DO NOTHING RETURNING id`,
      [run.id, account.id, source, source !== 'MANUAL' && isSandbox(ctx.integrations), l.reference, l.direction, fmt(amount), l.occurredAt, l.raw, actorDbId(ctx.actor), now],
    );
    if (!ins.rowCount) continue;
    const item = await ctx.tx.query<ItemRow>(
      `INSERT INTO otc.recon_items (run_id, external_movement_id, observed_amount, status, created_at, updated_at)
       VALUES ($1,$2,$3,'PENDIENTE',$4,$4) RETURNING *`,
      [run.id, ins.rows[0].id, fmt(amount), now],
    );
    await recordTransition(ctx, 'recon_item', item.rows[0].id, null, 'PENDIENTE', null, { reference: l.reference, amount: fmt(amount) });
  }

  // Cruce de cada partida abierta que viene del extracto.
  const open = await ctx.tx.query<ItemRow & { ref: string; direction: 'IN' | 'OUT' }>(
    `SELECT i.*, m.external_ref AS ref, m.direction FROM otc.recon_items i JOIN otc.external_movements m ON m.id = i.external_movement_id
     WHERE i.run_id = $1 AND i.status IN ('PENDIENTE','SIN_CONTRAPARTIDA') FOR UPDATE OF i`,
    [run.id],
  );
  for (const item of open.rows) {
    const book = await bookFor(ctx.tx, account.id, item.ref);
    const m = matchMovement({ amount: item.observed_amount!, direction: item.direction }, book);
    if (m.status === item.status) continue;
    if (item.status === 'SIN_CONTRAPARTIDA' && m.status !== 'CONCILIADA') continue; // espera revisión
    await moveItem(ctx, item, m.status, m.reason, { transferId: book?.id, expected: book?.amount });
  }

  // Lo que el libro esperaba en esta cuenta ese día y no aparece en el extracto.
  const missing = await ctx.tx.query<{ id: string; amount: string; number: string }>(
    `SELECT t.id, t.amount, t.number FROM otc.transfers t
     WHERE (t.account_id = $1 OR t.to_account_id = $1) AND t.status = 'CONFIRMADA'
       AND (t.updated_at AT TIME ZONE 'America/Bogota')::date = $2::date
       AND NOT EXISTS (SELECT 1 FROM otc.recon_items i WHERE i.transfer_id = t.id AND i.run_id = $3)`,
    [account.id, run.business_date, run.id],
  );
  for (const t of missing.rows) {
    const item = await ctx.tx.query<ItemRow>(
      `INSERT INTO otc.recon_items (run_id, transfer_id, expected_amount, status, status_reason, created_at, updated_at)
       VALUES ($1,$2,$3,'SIN_CONTRAPARTIDA',$4,$5,$5) RETURNING *`,
      [run.id, t.id, t.amount, `El libro registra la transferencia ${t.number} pero el extracto no la muestra`, now],
    );
    await recordTransition(ctx, 'recon_item', item.rows[0].id, null, 'SIN_CONTRAPARTIDA', item.rows[0].status_reason);
    await openCase(ctx, 'recon_item', item.rows[0].id, 'SIN_CONTRAPARTIDA', `Transferencia ${t.number} sin movimiento en el extracto`);
  }
  return refreshRunStatus(ctx, run.id);
}

export interface ReconDeps {
  db: Db;
  integrations: Integrations;
  now: () => Date;
  actor: Actor;
}

/** Concilia una cuenta en un día con el extracto del banco o de la red. */
export async function reconcileAccount(deps: ReconDeps, accountId: string, date: string) {
  authorize(deps.actor, 'reconciliation.manage');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw invalid('Fecha inválida');
  const a = await deps.db.query<AccountRow>('SELECT * FROM otc.accounts WHERE id = $1', [accountId]);
  if (!a.rowCount) throw notFound('La cuenta');
  const account = a.rows[0];
  if (account.kind !== 'LIQUIDITY') throw invalid('Se concilian las cuentas reales');
  const { source, lines } = await fetchStatement(deps.integrations, account, date);
  return inTransaction(deps.db, async (tx) => {
    const ctx: Ctx = { tx, actor: deps.actor, integrations: deps.integrations, now: deps.now };
    const run = await lockRun(tx, account.id, date, deps.actor, deps.now());
    const status = await matchLines(ctx, run, account, source, lines);
    return { runId: run.id, status, lines: lines.length };
  });
}

/** Extracto cargado a mano (por ejemplo, el historial del exchange o un archivo del banco). */
export async function importStatement(ctx: Ctx, accountId: string, date: string, lines: StatementLine[]) {
  authorize(ctx.actor, 'reconciliation.manage');
  const account = (await ctx.tx.query<AccountRow>('SELECT * FROM otc.accounts WHERE id = $1', [accountId])).rows[0];
  if (!account) throw notFound('La cuenta');
  if (account.kind !== 'LIQUIDITY') throw invalid('Se concilian las cuentas reales');
  const run = await lockRun(ctx.tx, account.id, date, ctx.actor, ctx.now());
  const status = await matchLines(ctx, run, account, 'MANUAL', lines);
  return { runId: run.id, status, lines: lines.length };
}

// ---------- Partidas, ajustes y cierre ----------

async function lockItem(tx: Tx, id: string): Promise<ItemRow> {
  const r = await tx.query<ItemRow>('SELECT * FROM otc.recon_items WHERE id = $1 FOR UPDATE', [id]);
  if (!r.rowCount) throw notFound('La partida');
  return r.rows[0];
}

/** Un responsable toma la partida con diferencia o sin pareja para investigarla. */
export async function sendItemToReview(ctx: Ctx, itemId: string, note: string) {
  authorize(ctx.actor, 'reconciliation.manage');
  if (!note.trim()) throw invalid('Indica qué se va a revisar');
  const item = await lockItem(ctx.tx, itemId);
  await moveItem(ctx, item, 'EN_REVISION', note.trim());
  await refreshRunStatus(ctx, item.run_id);
}

/** Se aclaró sin mover dinero (por ejemplo, un movimiento que llegó con otra fecha). Decide el administrador. */
export async function clearItem(ctx: Ctx, itemId: string, note: string) {
  authorize(ctx.actor, 'review.resolve');
  if (!note.trim()) throw invalid('Explica por qué no requiere ajuste');
  const item = await lockItem(ctx.tx, itemId);
  if (item.status !== 'EN_REVISION') throw new DomainError('INVALID_STATE', 'Solo se aclara una partida en revisión');
  await moveItem(ctx, item, 'CONCILIADA', `Aclarada sin ajuste: ${note.trim()}`);
  await refreshRunStatus(ctx, item.run_id);
}

/** Propone un ajuste: positivo entra a la cuenta, negativo sale. No se aplica hasta que otra persona lo apruebe. */
export async function proposeAdjustment(ctx: Ctx, input: { itemId: string; amount: string; reason: string }) {
  authorize(ctx.actor, 'adjustment.propose');
  if (!input.reason.trim()) throw invalid('Indica el motivo del ajuste');
  const item = await lockItem(ctx.tx, input.itemId);
  if (item.status !== 'EN_REVISION') throw new DomainError('INVALID_STATE', 'El ajuste se propone sobre una partida en revisión');
  const run = (await ctx.tx.query<{ account_id: string }>('SELECT account_id FROM otc.recon_runs WHERE id = $1', [item.run_id])).rows[0];
  const account = (await ctx.tx.query<AccountRow>('SELECT * FROM otc.accounts WHERE id = $1', [run.account_id])).rows[0];
  const negative = input.amount.trim().startsWith('-');
  const abs = input.amount.trim().replace(/^-/, '');
  const value = account.asset === 'COP' ? parseCopInteger(abs, 'Ajuste') : parseUsdtAmount(abs, 'Ajuste');
  const amount = negative ? value.neg() : value;
  const open = await ctx.tx.query(`SELECT 1 FROM otc.adjustments WHERE recon_item_id = $1 AND status = 'PROPUESTO'`, [item.id]);
  if (open.rowCount) throw new DomainError('PENDING_PROPOSAL', 'Ya hay un ajuste propuesto para esta partida');
  const r = await ctx.tx.query(
    `INSERT INTO otc.adjustments (account_id, recon_item_id, amount, reason, status, proposed_by, created_at, updated_at)
     VALUES ($1,$2,$3,$4,'PROPUESTO',$5,$6,$6) RETURNING *`,
    [account.id, item.id, fmt(amount), input.reason.trim(), ctx.actor.id, ctx.now()],
  ).catch((e) => {
    if ((e as { code?: string }).code === '23505') throw new DomainError('PENDING_PROPOSAL', 'Esta partida ya tiene un ajuste');
    throw e;
  });
  await recordTransition(ctx, 'adjustment', r.rows[0].id, null, 'PROPUESTO', input.reason.trim(), { item: item.number, amount: fmt(amount) });
  return r.rows[0];
}

/**
 * Segunda firma del ajuste. Al aprobarse se registra un asiento de ajuste contra la cuenta de
 * ajustes; el asiento original no se toca. La partida queda Ajustada.
 */
export async function decideAdjustment(ctx: Ctx, id: string, approve: boolean, note: string) {
  authorize(ctx.actor, 'adjustment.approve');
  if (!note.trim()) throw invalid('Explica la decisión');
  const r = await ctx.tx.query('SELECT * FROM otc.adjustments WHERE id = $1 FOR UPDATE', [id]);
  if (!r.rowCount) throw notFound('El ajuste');
  const adj = r.rows[0];
  if (adj.status !== 'PROPUESTO') throw new DomainError('INVALID_STATE', `El ajuste ya está ${adj.status}`);
  assertDifferentPerson(ctx.actor, adj.proposed_by, 'La aprobación de un ajuste');
  const now = ctx.now();
  if (!approve) {
    const u = await ctx.tx.query(
      `UPDATE otc.adjustments SET status = 'RECHAZADO', status_reason = $2, decided_by = $3, decided_at = $4, updated_at = $4 WHERE id = $1 RETURNING *`,
      [id, note.trim(), ctx.actor.id, now],
    );
    await recordTransition(ctx, 'adjustment', id, 'PROPUESTO', 'RECHAZADO', note.trim());
    return u.rows[0];
  }
  const account = (await ctx.tx.query<AccountRow>('SELECT * FROM otc.accounts WHERE id = $1', [adj.account_id])).rows[0];
  const counter = await accountByCode(ctx.tx, adjustmentsCode(account.asset));
  const amount = new D(adj.amount);
  const entryId = await postEntry(ctx, {
    kind: 'ADJUSTMENT',
    description: `Ajuste ${adj.number}: ${adj.reason}`,
    lines: [
      { accountId: account.id, amount },
      { accountId: counter.id, amount: amount.neg() },
    ],
  });
  const u = await ctx.tx.query(
    `UPDATE otc.adjustments SET status = 'APROBADO', status_reason = $2, journal_entry_id = $3, decided_by = $4, decided_at = $5, updated_at = $5
     WHERE id = $1 RETURNING *`,
    [id, note.trim(), entryId, ctx.actor.id, now],
  );
  await recordTransition(ctx, 'adjustment', id, 'PROPUESTO', 'APROBADO', note.trim(), { entryId });
  if (adj.recon_item_id) {
    const item = await lockItem(ctx.tx, adj.recon_item_id);
    await ctx.tx.query('UPDATE otc.recon_items SET status = $2, status_reason = $3, adjustment_id = $4, updated_at = $5 WHERE id = $1', [
      item.id,
      'AJUSTADA',
      `Ajuste ${adj.number} aprobado`,
      id,
      now,
    ]);
    await recordTransition(ctx, 'recon_item', item.id, item.status, 'AJUSTADA', `Ajuste ${adj.number} aprobado`);
    await resolveCasesFor(ctx, 'recon_item', item.id, `Ajuste ${adj.number}`);
    await refreshRunStatus(ctx, item.run_id);
  }
  return u.rows[0];
}

/** Cierre del día: solo cuando todas las partidas están en un estado final. Si no, dice cuáles faltan. */
export async function closeDay(ctx: Ctx, runId: string, note: string | null) {
  authorize(ctx.actor, 'reconciliation.manage');
  const r = await ctx.tx.query<RunRow>('SELECT id, account_id, business_date, status FROM otc.recon_runs WHERE id = $1 FOR UPDATE', [runId]);
  if (!r.rowCount) throw notFound('La conciliación');
  const run = r.rows[0];
  if (run.status === 'CERRADO') throw new DomainError('DAY_CLOSED', 'El día ya está cerrado');
  const open = await ctx.tx.query<{ number: string; status: string }>(
    `SELECT number, status FROM otc.recon_items WHERE run_id = $1 AND status <> ALL($2::text[]) ORDER BY number`,
    [runId, FINAL_ITEM],
  );
  if (open.rowCount) {
    throw new DomainError('DAY_NOT_BALANCED', `No se puede cerrar: faltan ${open.rows.map((i) => `partida ${i.number} (${i.status})`).join(', ')}`);
  }
  await ctx.tx.query(
    `UPDATE otc.recon_runs SET status = 'CERRADO', status_reason = $2, closed_by = $3, closed_at = $4, updated_at = $4 WHERE id = $1`,
    [runId, note, ctx.actor.id, ctx.now()],
  );
  await recordTransition(ctx, 'recon_run', runId, run.status, 'CERRADO', note);
  return { id: runId, status: 'CERRADO' };
}

export async function getRun(ctx: Pick<Ctx, 'tx'>, runId: string) {
  const r = await ctx.tx.query(
    `SELECT r.*, to_char(r.business_date,'YYYY-MM-DD') AS business_date, a.code AS account_code FROM otc.recon_runs r
     JOIN otc.accounts a ON a.id = r.account_id WHERE r.id = $1`,
    [runId],
  );
  if (!r.rowCount) throw notFound('La conciliación');
  const items = await ctx.tx.query(
    `SELECT i.*, m.external_ref, m.direction, m.source, m.occurred_at, t.number AS transfer_number
     FROM otc.recon_items i LEFT JOIN otc.external_movements m ON m.id = i.external_movement_id
     LEFT JOIN otc.transfers t ON t.id = i.transfer_id WHERE i.run_id = $1 ORDER BY i.number`,
    [runId],
  );
  return { ...r.rows[0], items: items.rows };
}

/** Ajustes con su partida y conciliación, para la bandeja de aprobación. */
export async function listAdjustments(ctx: Pick<Ctx, 'tx'>, filter: { status?: string; runId?: string }) {
  const r = await ctx.tx.query(
    `SELECT j.id, j.number, j.amount, j.reason, j.status, j.status_reason, j.created_at, j.decided_at, a.code AS account_code, a.asset,
            i.id AS item_id, i.number AS item_number, i.run_id, up.full_name AS proposed_by_name, ud.full_name AS decided_by_name,
            j.proposed_by
     FROM otc.adjustments j JOIN otc.accounts a ON a.id = j.account_id
     LEFT JOIN otc.recon_items i ON i.id = j.recon_item_id
     JOIN public.users up ON up.id = j.proposed_by LEFT JOIN public.users ud ON ud.id = j.decided_by
     WHERE ($1::text IS NULL OR j.status = $1) AND ($2::uuid IS NULL OR i.run_id = $2)
     ORDER BY j.created_at DESC LIMIT 200`,
    [filter.status ?? null, filter.runId ?? null],
  );
  return r.rows;
}

export async function listRuns(ctx: Pick<Ctx, 'tx'>, filter: { date?: string; status?: RunStatus }) {
  const r = await ctx.tx.query(
    `SELECT r.id, to_char(r.business_date,'YYYY-MM-DD') AS business_date, r.status, a.code AS account_code,
            count(i.*) FILTER (WHERE i.status NOT IN ('CONCILIADA','AJUSTADA'))::int AS open_items
     FROM otc.recon_runs r JOIN otc.accounts a ON a.id = r.account_id LEFT JOIN otc.recon_items i ON i.run_id = r.id
     WHERE ($1::date IS NULL OR r.business_date = $1) AND ($2::text IS NULL OR r.status = $2)
     GROUP BY r.id, a.code ORDER BY r.business_date DESC, a.code LIMIT 200`,
    [filter.date ?? null, filter.status ?? null],
  );
  return r.rows;
}
