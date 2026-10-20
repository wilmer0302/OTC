import type { Db, Tx } from '../../db/pool.js';
import { DomainError, invalid, notFound } from '../../domain/errors.js';
import type { Ctx } from '../../platform/context.js';
import { recordAction } from '../../platform/events.js';
import { D } from '../../platform/money.js';
import { assertDifferentPerson, authorize } from '../identity/permissions.js';
import { KIND_LABEL, PER_CLIENT_KINDS, VALUE_SCHEMAS, type ApprovalPolicy, type EffectiveLimits, type LimitKind } from './domain.js';

export interface LimitProposal {
  kind: LimitKind;
  counterpartyId?: string | null;
  value: unknown;
  reason: string;
}

/** Un administrador propone el cambio; otro distinto lo aprueba (segunda firma). */
export async function proposeLimitChange(ctx: Ctx, input: LimitProposal) {
  authorize(ctx.actor, 'limits.propose');
  if (!input.reason.trim()) throw invalid('Indica el motivo del cambio');
  if (input.counterpartyId && !PER_CLIENT_KINDS.includes(input.kind)) {
    throw invalid(`${KIND_LABEL[input.kind]} es de la mesa, no se fija por cliente`);
  }
  const parsed = VALUE_SCHEMAS[input.kind].safeParse(input.value);
  if (!parsed.success) throw invalid(`Valor inválido para ${KIND_LABEL[input.kind]}: ${parsed.error.issues[0].message}`);
  const value = parsed.data as Record<string, string>;
  if ('amount' in value && new D(value.amount).lte(0)) throw invalid('El límite debe ser mayor que cero');
  if (input.counterpartyId) {
    const cp = await ctx.tx.query('SELECT 1 FROM otc.counterparties WHERE id = $1', [input.counterpartyId]);
    if (!cp.rowCount) throw notFound('La contraparte');
  }
  const open = await ctx.tx.query(
    `SELECT id FROM otc.policy_changes WHERE kind = $1 AND counterparty_id IS NOT DISTINCT FROM $2 AND status = 'PROPUESTO'`,
    [input.kind, input.counterpartyId ?? null],
  );
  if (open.rowCount) throw new DomainError('PENDING_PROPOSAL', 'Ya hay una propuesta abierta para ese límite; decídela primero');
  const r = await ctx.tx.query(
    `INSERT INTO otc.policy_changes (kind, counterparty_id, value, status, reason, proposed_by, proposed_at)
     VALUES ($1,$2,$3,'PROPUESTO',$4,$5,$6) RETURNING *`,
    [input.kind, input.counterpartyId ?? null, value, input.reason.trim(), ctx.actor.id, ctx.now()],
  );
  await recordAction(ctx, 'limits.propose', 'policy_change', r.rows[0].id, { kind: input.kind, value, reason: input.reason });
  return r.rows[0];
}

export async function decideLimitChange(ctx: Ctx, id: string, approve: boolean, note: string) {
  authorize(ctx.actor, 'limits.approve');
  if (!note.trim()) throw invalid('Explica la decisión');
  const r = await ctx.tx.query('SELECT * FROM otc.policy_changes WHERE id = $1 FOR UPDATE', [id]);
  if (!r.rowCount) throw notFound('La propuesta');
  const p = r.rows[0];
  if (p.status !== 'PROPUESTO') throw new DomainError('INVALID_STATE', `La propuesta ya está ${p.status}`);
  assertDifferentPerson(ctx.actor, p.proposed_by, 'La segunda firma de un límite');
  const to = approve ? 'VIGENTE' : 'RECHAZADO';
  const u = await ctx.tx.query(
    `UPDATE otc.policy_changes SET status = $2, decided_by = $3, decided_at = $4, decision_note = $5 WHERE id = $1 RETURNING *`,
    [id, to, ctx.actor.id, ctx.now(), note.trim()],
  );
  await recordAction(ctx, approve ? 'limits.approve' : 'limits.reject', 'policy_change', id, { kind: p.kind, value: p.value, note });
  return u.rows[0];
}

export async function listLimitChanges(ctx: Pick<Ctx, 'tx'>, status?: string) {
  const r = await ctx.tx.query(
    `SELECT p.*, up.full_name AS proposed_by_name, ud.full_name AS decided_by_name
     FROM otc.policy_changes p
     JOIN public.users up ON up.id = p.proposed_by LEFT JOIN public.users ud ON ud.id = p.decided_by
     WHERE ($1::text IS NULL OR p.status = $1) ORDER BY p.proposed_at DESC LIMIT 200`,
    [status ?? null],
  );
  return r.rows;
}

/**
 * Límites que rigen para un cliente: el del cliente si existe, si no el global.
 * Si falta alguno, la mesa no opera (es más seguro bloquear que operar sin límite).
 */
export async function effectiveLimits(q: Db | Tx, counterpartyId: string | null): Promise<EffectiveLimits> {
  const r = await q.query<{ kind: LimitKind; counterparty_id: string | null; value: Record<string, string> }>(
    `SELECT DISTINCT ON (kind, counterparty_id) kind, counterparty_id, value
     FROM otc.policy_changes
     WHERE status = 'VIGENTE' AND (counterparty_id IS NULL OR counterparty_id = $1)
     ORDER BY kind, counterparty_id, seq DESC`,
    [counterpartyId],
  );
  const get = (kind: LimitKind) => {
    const own = r.rows.find((x) => x.kind === kind && x.counterparty_id !== null);
    const global = r.rows.find((x) => x.kind === kind && x.counterparty_id === null);
    const row = own ?? global;
    if (!row) throw new DomainError('NO_LIMITS', `No hay ${KIND_LABEL[kind].toLowerCase()} vigente; la mesa no puede operar`);
    return row.value;
  };
  return {
    orderMaxUsdt: new D(get('ORDER_MAX_USDT').amount),
    clientDailyUsdt: new D(get('CLIENT_DAILY_USDT').amount),
    deskDailyUsdt: new D(get('DESK_DAILY_USDT').amount),
    openExposureUsdt: new D(get('OPEN_EXPOSURE_USDT').amount),
    openExposureCop: new D(get('OPEN_EXPOSURE_COP').amount),
    approval: get('APPROVAL_POLICY') as unknown as ApprovalPolicy,
  };
}
