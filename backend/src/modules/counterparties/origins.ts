import type { Db, Tx } from '../../db/pool.js';
import { DomainError, invalid, notFound } from '../../domain/errors.js';
import type { Ctx } from '../../platform/context.js';
import { recordAction } from '../../platform/events.js';
import { POLICY } from '../../platform/policy.js';
import { assertDifferentPerson, authorize, can } from '../identity/permissions.js';
import { addressKey, mask, networkFits, SUPPORTED_NETWORKS, type Network, type OriginStatus } from './domain.js';

// Billeteras de origen de los clientes: desde dónde puede depositar USDT cada cliente.
// Las propone el operador, una por una, y las decide Cumplimiento. Solo una dirección aprobada
// deja acreditar un depósito; el control lo aplica el módulo de confirmaciones con lo que
// reporta la red, nunca con lo que informa el cliente o la consola.

export interface NewOrigin {
  network: Network;
  address: string;
  label: string;
}

async function lockCounterparty(tx: Tx, id: string) {
  const r = await tx.query('SELECT * FROM otc.counterparties WHERE id = $1 FOR UPDATE', [id]);
  if (!r.rowCount) throw notFound('La contraparte');
  return r.rows[0];
}

async function lockOrigin(tx: Tx, id: string) {
  const r = await tx.query('SELECT * FROM otc.origin_addresses WHERE id = $1 FOR UPDATE', [id]);
  if (!r.rowCount) throw notFound('La billetera de origen');
  return r.rows[0];
}

export async function proposeOrigin(ctx: Ctx, counterpartyId: string, input: NewOrigin) {
  authorize(ctx.actor, 'origin.propose');
  if (!SUPPORTED_NETWORKS.includes(input.network)) throw invalid(`Red no soportada: ${input.network}`);
  // El bloqueo del cliente ordena las propuestas simultáneas: el límite de redes no se puede saltar en paralelo.
  const cp = await lockCounterparty(ctx.tx, counterpartyId);
  if (cp.kind !== 'CLIENTE') throw invalid('Solo los clientes registran billeteras de origen');
  if (cp.kyc_status === 'BLOQUEADO' || cp.kyc_status === 'RECHAZADO') {
    throw new DomainError('KYC', `La contraparte tiene KYC ${cp.kyc_status}`);
  }
  const address = input.address.trim();
  if (!ctx.integrations.chain.isValidAddress(input.network, address)) throw invalid(`Dirección ${input.network} inválida`);
  if (!input.label.trim()) throw invalid('Ponle un nombre a la billetera');

  const key = addressKey(input.network, address);
  const taken = await ctx.tx.query(
    `SELECT counterparty_id, status FROM otc.origin_addresses
     WHERE network = $1 AND address_key = $2 AND status IN ('PENDIENTE','APROBADA')`,
    [input.network, key],
  );
  if (taken.rowCount) {
    const t = taken.rows[0];
    throw new DomainError(
      'DUPLICATE',
      t.counterparty_id === counterpartyId
        ? `Esa dirección ya está ${t.status.toLowerCase()} para este cliente en ${input.network}`
        : `Esa dirección ya está registrada para otro cliente en ${input.network}`,
    );
  }

  const live = await ctx.tx.query<{ network: Network }>(
    `SELECT DISTINCT network FROM otc.origin_addresses WHERE counterparty_id = $1 AND status IN ('PENDIENTE','APROBADA')`,
    [counterpartyId],
  );
  const max = POLICY.maxOriginNetworksPerClient;
  if (!networkFits(live.rows.map((x) => x.network), input.network, max)) {
    throw new DomainError('NETWORK_LIMIT', `El cliente ya tiene ${max} redes habilitadas; no se puede agregar ${input.network}`);
  }

  const r = await ctx.tx.query<{ id: string }>(
    `INSERT INTO otc.origin_addresses (counterparty_id, network, address, label, proposed_by, proposed_at)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [counterpartyId, input.network, address, input.label.trim(), ctx.actor.id, ctx.now()],
  );
  await recordAction(ctx, 'origin.propose', 'origin_address', r.rows[0].id, { counterpartyId, network: input.network, address });
  return getOrigin(ctx, r.rows[0].id);
}

/** Aprobar o rechazar una dirección pendiente. Lo hace Cumplimiento, una persona distinta de quien la propuso. */
export async function decideOrigin(ctx: Ctx, id: string, approve: boolean, note: string) {
  authorize(ctx.actor, 'origin.decide');
  if (!note.trim()) throw invalid('Explica la decisión');
  const o = await lockOrigin(ctx.tx, id);
  if (o.status !== 'PENDIENTE') throw new DomainError('INVALID_STATE', `La billetera ya está ${o.status}`);
  assertDifferentPerson(ctx.actor, o.proposed_by, 'Aprobar una billetera de origen');
  const to: OriginStatus = approve ? 'APROBADA' : 'RECHAZADA';
  await ctx.tx.query(
    `UPDATE otc.origin_addresses SET status = $2, decided_by = $3, decided_at = $4, decision_note = $5 WHERE id = $1`,
    [id, to, ctx.actor.id, ctx.now(), note.trim()],
  );
  await recordAction(ctx, approve ? 'origin.approve' : 'origin.reject', 'origin_address', id, {
    counterpartyId: o.counterparty_id,
    network: o.network,
    note: note.trim(),
  });
  return getOrigin(ctx, id);
}

/** Revocar una dirección aprobada: los depósitos que lleguen desde ella después van a revisión. */
export async function revokeOrigin(ctx: Ctx, id: string, reason: string) {
  authorize(ctx.actor, 'origin.decide');
  if (!reason.trim()) throw invalid('Indica el motivo');
  const o = await lockOrigin(ctx.tx, id);
  if (o.status !== 'APROBADA') throw new DomainError('INVALID_STATE', 'Solo se revoca una billetera aprobada');
  await ctx.tx.query(
    `UPDATE otc.origin_addresses SET status = 'REVOCADA', revoked_by = $2, revoked_at = $3, revoke_reason = $4 WHERE id = $1`,
    [id, ctx.actor.id, ctx.now(), reason.trim()],
  );
  await recordAction(ctx, 'origin.revoke', 'origin_address', id, { counterpartyId: o.counterparty_id, network: o.network, reason: reason.trim() });
  return getOrigin(ctx, id);
}

// ---------- Consultas ----------

const seesFullOrigins = (ctx: Ctx) =>
  can(ctx.actor, 'origin.propose') || can(ctx.actor, 'origin.decide') || can(ctx.actor, 'origin.exception.request') || can(ctx.actor, 'transfer.manage');

const present = (ctx: Ctx, o: Record<string, unknown>) => (seesFullOrigins(ctx) ? o : { ...o, address: mask(String(o.address)) });

const SELECT = `SELECT o.id, o.counterparty_id, o.network, o.address, o.label, o.status, o.proposed_by, o.proposed_at,
    o.decided_by, o.decided_at, o.decision_note, o.revoked_by, o.revoked_at, o.revoke_reason,
    v.legal_name AS counterparty_name, pu.full_name AS proposed_by_name, du.full_name AS decided_by_name, ru.full_name AS revoked_by_name
  FROM otc.origin_addresses o
  JOIN otc.counterparties c ON c.id = o.counterparty_id
  JOIN otc.counterparty_versions v ON v.counterparty_id = c.id AND v.version = c.current_version
  JOIN public.users pu ON pu.id = o.proposed_by
  LEFT JOIN public.users du ON du.id = o.decided_by
  LEFT JOIN public.users ru ON ru.id = o.revoked_by`;

export async function getOrigin(ctx: Ctx, id: string) {
  const r = await ctx.tx.query(`${SELECT} WHERE o.id = $1`, [id]);
  if (!r.rowCount) throw notFound('La billetera de origen');
  return present(ctx, r.rows[0]);
}

export async function originsOf(ctx: Ctx, counterpartyId: string) {
  const r = await ctx.tx.query(`${SELECT} WHERE o.counterparty_id = $1 ORDER BY o.network, o.proposed_at DESC`, [counterpartyId]);
  return r.rows.map((o) => present(ctx, o));
}

/** Bandeja por estado (por ejemplo, las pendientes que esperan a Cumplimiento). */
export async function listOrigins(ctx: Ctx, status: OriginStatus) {
  const r = await ctx.tx.query(`${SELECT} WHERE o.status = $1 ORDER BY o.proposed_at LIMIT 200`, [status]);
  return r.rows.map((o) => present(ctx, o));
}

/** Direcciones aprobadas de un cliente en una red: las únicas que superan el control de origen. */
export async function approvedOriginAddresses(q: Db | Tx, counterpartyId: string, network: Network): Promise<string[]> {
  const r = await q.query<{ address: string }>(
    `SELECT address FROM otc.origin_addresses WHERE counterparty_id = $1 AND network = $2 AND status = 'APROBADA'`,
    [counterpartyId, network],
  );
  return r.rows.map((x) => x.address);
}
