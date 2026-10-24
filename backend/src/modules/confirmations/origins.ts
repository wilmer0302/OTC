import type { Db, Tx } from '../../db/pool.js';
import { DomainError, invalid, notFound } from '../../domain/errors.js';
import type { Ctx } from '../../platform/context.js';
import { recordAction } from '../../platform/events.js';
import { D, usdtToBaseUnits } from '../../platform/money.js';
import type { Network } from '../counterparties/domain.js';
import { approvedOriginAddresses } from '../counterparties/origins.js';
import { assertDifferentPerson, authorize } from '../identity/permissions.js';
import { lockTransfer } from '../transfers/service.js';
import { decide, type Observed } from './domain.js';

// Control de origen de los depósitos en USDT y su única salida: la excepción autorizada.
// Un depósito desde una dirección no aprobada queda en revisión. Para aceptarlo, alguien lo
// solicita con motivo y otra persona de Cumplimiento lo autoriza. La excepción vale para esa
// transferencia y para la dirección que reportó la red, no para la dirección en general.

/** Orígenes que superan el control para esta transferencia: aprobados del cliente y excepciones autorizadas. */
export async function authorizedOrigins(q: Db | Tx, counterpartyId: string | null, network: Network, transferId: string): Promise<string[]> {
  const approved = counterpartyId ? await approvedOriginAddresses(q, counterpartyId, network) : [];
  const exceptions = await q.query<{ from_address: string }>(
    `SELECT from_address FROM otc.origin_exceptions WHERE transfer_id = $1 AND network = $2 AND status = 'APROBADA'`,
    [transferId, network],
  );
  return [...approved, ...exceptions.rows.map((x) => x.from_address)];
}

async function lastEvidence(tx: Tx, transferId: string): Promise<Observed | null> {
  const r = await tx.query<{ payload: Observed }>('SELECT payload FROM otc.observations WHERE transfer_id = $1 ORDER BY id DESC LIMIT 1', [transferId]);
  return r.rows[0]?.payload ?? null;
}

/**
 * Solicitar que se acepte un depósito llegado desde un origen no aprobado. La dirección sale de la
 * evidencia que reportó la red, no de lo que escriba quien solicita. Si la revisión tiene otra causa
 * (otro token, otro monto, otro destino), la excepción no aplica.
 */
export async function requestOriginException(ctx: Ctx, transferId: string, reason: string) {
  authorize(ctx.actor, 'origin.exception.request');
  if (reason.trim().length < 10) throw invalid('Explica con detalle por qué se debe aceptar este origen (mínimo 10 caracteres)');
  const t = await lockTransfer(ctx.tx, transferId);
  if (t.purpose !== 'COBRO' || t.rail === 'BANK') throw invalid('La excepción de origen solo aplica a depósitos de clientes en USDT');
  if (t.status !== 'EN_REVISION') throw new DomainError('INVALID_STATE', `La transferencia ${t.number} no está en revisión`);
  const evidence = await lastEvidence(ctx.tx, transferId);
  if (!evidence?.found || !evidence.from) throw new DomainError('NO_EVIDENCE', 'La red no ha reportado la dirección de origen de este depósito');

  const rail = t.rail as Network;
  const target = await ctx.tx.query(
    `SELECT a.external_ref AS account_ref, o.counterparty_id FROM otc.transfers t
     JOIN otc.accounts a ON a.id = t.account_id JOIN otc.orders o ON o.id = t.order_id WHERE t.id = $1`,
    [transferId],
  );
  const { account_ref, counterparty_id } = target.rows[0];
  const allowed = await authorizedOrigins(ctx.tx, counterparty_id, rail, transferId);
  const expected = {
    to: account_ref,
    direction: 'IN' as const,
    amount: usdtToBaseUnits(new D(t.amount), rail),
    network: rail,
    tokenContract: ctx.integrations.chain.usdtContract(rail),
  };
  const timing = { ageSeconds: 0, pendingSeconds: Infinity, reviewSeconds: Infinity, requiredConfirmations: 0 };
  if (decide(evidence, { ...expected, allowedFrom: allowed }, timing).kind !== 'REVIEW') {
    throw new DomainError('NOT_ORIGIN_ISSUE', 'El origen de este depósito ya está autorizado; la excepción no hace falta');
  }
  const withOrigin = decide(evidence, { ...expected, allowedFrom: [...allowed, evidence.from] }, timing);
  if (withOrigin.kind === 'REVIEW' || withOrigin.kind === 'FAIL') {
    throw new DomainError('NOT_ORIGIN_ISSUE', `La revisión no es solo por el origen: ${'reason' in withOrigin ? withOrigin.reason : ''}`);
  }

  const live = await ctx.tx.query(`SELECT status FROM otc.origin_exceptions WHERE transfer_id = $1 AND status IN ('SOLICITADA','APROBADA')`, [transferId]);
  if (live.rowCount) throw new DomainError('DUPLICATE', `Ya hay una excepción ${live.rows[0].status.toLowerCase()} para esta transferencia`);

  const r = await ctx.tx.query<{ id: string }>(
    `INSERT INTO otc.origin_exceptions (transfer_id, network, from_address, reason, requested_by, requested_at)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [transferId, rail, evidence.from, reason.trim(), ctx.actor.id, ctx.now()],
  );
  await recordAction(ctx, 'origin.exception.request', 'origin_exception', r.rows[0].id, {
    transferId,
    network: rail,
    fromAddress: evidence.from,
    reason: reason.trim(),
  });
  return getException(ctx, r.rows[0].id);
}

/**
 * Autorizar o negar la excepción. Lo decide Cumplimiento, una persona distinta de quien la pidió.
 * Autorizarla no confirma nada: la transferencia sigue en revisión y se resuelve con la evidencia,
 * que ahora sí supera el control de origen.
 */
export async function decideOriginException(ctx: Ctx, id: string, approve: boolean, note: string) {
  authorize(ctx.actor, 'origin.exception.decide');
  if (note.trim().length < 3) throw invalid('Explica la decisión');
  const r = await ctx.tx.query('SELECT * FROM otc.origin_exceptions WHERE id = $1 FOR UPDATE', [id]);
  if (!r.rowCount) throw notFound('La excepción');
  const e = r.rows[0];
  if (e.status !== 'SOLICITADA') throw new DomainError('INVALID_STATE', `La excepción ya está ${e.status}`);
  assertDifferentPerson(ctx.actor, e.requested_by, 'Autorizar una excepción de origen');
  await ctx.tx.query(`UPDATE otc.origin_exceptions SET status = $2, decided_by = $3, decided_at = $4, decision_note = $5 WHERE id = $1`, [
    id,
    approve ? 'APROBADA' : 'RECHAZADA',
    ctx.actor.id,
    ctx.now(),
    note.trim(),
  ]);
  await recordAction(ctx, approve ? 'origin.exception.approve' : 'origin.exception.reject', 'origin_exception', id, {
    transferId: e.transfer_id,
    fromAddress: e.from_address,
    note: note.trim(),
  });
  return getException(ctx, id);
}

const SELECT = `SELECT e.*, t.number AS transfer_number, ru.full_name AS requested_by_name, du.full_name AS decided_by_name
  FROM otc.origin_exceptions e JOIN otc.transfers t ON t.id = e.transfer_id
  JOIN public.users ru ON ru.id = e.requested_by LEFT JOIN public.users du ON du.id = e.decided_by`;

export async function getException(ctx: Pick<Ctx, 'tx'>, id: string) {
  const r = await ctx.tx.query(`${SELECT} WHERE e.id = $1`, [id]);
  if (!r.rowCount) throw notFound('La excepción');
  return r.rows[0];
}

export async function exceptionsOf(ctx: Pick<Ctx, 'tx'>, transferId: string) {
  return (await ctx.tx.query(`${SELECT} WHERE e.transfer_id = $1 ORDER BY e.requested_at DESC`, [transferId])).rows;
}

export async function listExceptions(ctx: Pick<Ctx, 'tx'>, status: 'SOLICITADA' | 'APROBADA' | 'RECHAZADA') {
  return (await ctx.tx.query(`${SELECT} WHERE e.status = $1 ORDER BY e.requested_at LIMIT 200`, [status])).rows;
}
