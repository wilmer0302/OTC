import type { Db, Tx } from '../../db/pool.js';
import { DomainError, invalid, notFound } from '../../domain/errors.js';
import type { Ctx } from '../../platform/context.js';
import { recordAction } from '../../platform/events.js';
import { assertDifferentPerson, authorize, can } from '../identity/permissions.js';
import { isValidBankAccount, kycCanMove, mask, type KycStatus, type Rail } from './domain.js';
import { originsOf } from './origins.js';

export interface NewCounterparty {
  kind: 'CLIENTE' | 'PROVEEDOR';
  personType: 'NATURAL' | 'JURIDICA';
  documentType: 'CC' | 'CE' | 'NIT' | 'PASAPORTE';
  documentNumber: string;
  legalName: string;
  email?: string | null;
  phone?: string | null;
  notes?: string | null;
}

export interface CounterpartyChange {
  legalName?: string;
  email?: string | null;
  phone?: string | null;
  notes?: string | null;
  reason: string;
}

async function insertVersion(
  ctx: Ctx,
  counterpartyId: string,
  version: number,
  data: { legalName: string; email?: string | null; phone?: string | null; notes?: string | null },
  reason: string,
) {
  await ctx.tx.query(
    `INSERT INTO otc.counterparty_versions (counterparty_id, version, legal_name, email, phone, notes, reason, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [counterpartyId, version, data.legalName.trim(), data.email ?? null, data.phone ?? null, data.notes ?? null, reason, ctx.actor.id],
  );
}

export async function createCounterparty(ctx: Ctx, input: NewCounterparty) {
  authorize(ctx.actor, 'counterparty.create');
  // La mesa solo vincula empresas (decisión 44): persona jurídica identificada con NIT.
  if (input.personType !== 'JURIDICA' || input.documentType !== 'NIT') {
    throw invalid('Solo se vinculan empresas: persona jurídica con NIT');
  }
  const doc = input.documentNumber.trim().toUpperCase();
  const dup = await ctx.tx.query(
    'SELECT number FROM otc.counterparties WHERE document_type = $1 AND document_number = $2',
    [input.documentType, doc],
  );
  if (dup.rowCount) {
    throw new DomainError('DUPLICATE', `Ya existe la contraparte #${dup.rows[0].number} con ese documento`);
  }
  const r = await ctx.tx.query<{ id: string; number: string }>(
    `INSERT INTO otc.counterparties (kind, person_type, document_type, document_number, created_by)
     VALUES ($1,$2,$3,$4,$5) RETURNING id, number`,
    [input.kind, input.personType, input.documentType, doc, ctx.actor.id],
  );
  const { id } = r.rows[0];
  await insertVersion(ctx, id, 1, input, 'Alta');
  await recordAction(ctx, 'counterparty.create', 'counterparty', id, {
    kind: input.kind,
    documentType: input.documentType,
    documentNumber: doc,
    legalName: input.legalName,
  });
  return getCounterparty(ctx, id);
}

async function lockCounterparty(tx: Tx, id: string) {
  const r = await tx.query('SELECT * FROM otc.counterparties WHERE id = $1 FOR UPDATE', [id]);
  if (!r.rowCount) throw notFound('La contraparte');
  return r.rows[0];
}

/** Un cambio de datos es una versión nueva; las anteriores quedan visibles. */
export async function updateCounterparty(ctx: Ctx, id: string, change: CounterpartyChange) {
  authorize(ctx.actor, 'counterparty.update');
  if (!change.reason.trim()) throw invalid('Indica el motivo del cambio');
  const cp = await lockCounterparty(ctx.tx, id);
  const current = (
    await ctx.tx.query('SELECT * FROM otc.counterparty_versions WHERE counterparty_id = $1 AND version = $2', [
      id,
      cp.current_version,
    ])
  ).rows[0];
  const next = cp.current_version + 1;
  await insertVersion(
    ctx,
    id,
    next,
    {
      legalName: change.legalName ?? current.legal_name,
      email: change.email !== undefined ? change.email : current.email,
      phone: change.phone !== undefined ? change.phone : current.phone,
      notes: change.notes !== undefined ? change.notes : current.notes,
    },
    change.reason.trim(),
  );
  await ctx.tx.query('UPDATE otc.counterparties SET current_version = $2 WHERE id = $1', [id, next]);
  await recordAction(ctx, 'counterparty.update', 'counterparty', id, { version: next, reason: change.reason });
  return getCounterparty(ctx, id);
}

/** Decisión de Cumplimiento sobre el KYC, siempre con nota. */
export async function decideKyc(ctx: Ctx, id: string, to: KycStatus, note: string) {
  authorize(ctx.actor, 'kyc.decide');
  if (!note.trim()) throw invalid('Explica la decisión de KYC');
  const cp = await lockCounterparty(ctx.tx, id);
  if (!kycCanMove(cp.kyc_status, to)) {
    throw new DomainError('INVALID_TRANSITION', `El KYC no puede pasar de ${cp.kyc_status} a ${to}`);
  }
  await ctx.tx.query('UPDATE otc.counterparties SET kyc_status = $2 WHERE id = $1', [id, to]);
  await ctx.tx.query(
    `INSERT INTO otc.kyc_reviews (counterparty_id, from_status, to_status, note, reviewed_by) VALUES ($1,$2,$3,$4,$5)`,
    [id, cp.kyc_status, to, note.trim(), ctx.actor.id],
  );
  await recordAction(ctx, 'counterparty.kyc', 'counterparty', id, { from: cp.kyc_status, to, note });
  return getCounterparty(ctx, id);
}

// ---------- Lista blanca de destinos ----------

export interface NewDestination {
  rail: Rail;
  value: string;
  bankName?: string | null;
  accountType?: 'AHORROS' | 'CORRIENTE' | null;
  holderDocument?: string | null;
  label: string;
  supersedesId?: string | null;
}

export async function proposeDestination(ctx: Ctx, counterpartyId: string, input: NewDestination) {
  authorize(ctx.actor, 'destination.propose');
  const cp = await lockCounterparty(ctx.tx, counterpartyId);
  if (cp.kyc_status === 'BLOQUEADO' || cp.kyc_status === 'RECHAZADO') {
    throw new DomainError('KYC', `La contraparte tiene KYC ${cp.kyc_status}`);
  }
  const value = input.value.trim();
  if (input.rail === 'BANK') {
    if (!isValidBankAccount(value)) throw invalid('La cuenta bancaria debe tener solo dígitos (6 a 20)');
    if (!input.bankName || !input.accountType) throw invalid('Indica el banco y el tipo de cuenta');
  } else {
    if (!ctx.integrations.chain.isValidAddress(input.rail, value)) throw invalid(`Dirección ${input.rail} inválida`);
    if (input.bankName || input.accountType) throw invalid('Una dirección de red no lleva banco ni tipo de cuenta');
  }
  if (input.supersedesId) {
    const prev = await ctx.tx.query('SELECT counterparty_id, rail, status FROM otc.destinations WHERE id = $1', [input.supersedesId]);
    const p = prev.rows[0];
    if (!p || p.counterparty_id !== counterpartyId || p.rail !== input.rail || p.status !== 'APROBADO') {
      throw invalid('Solo se reemplaza un destino aprobado del mismo cliente y la misma red');
    }
  }
  const dup = await ctx.tx.query(
    `SELECT status FROM otc.destinations WHERE counterparty_id = $1 AND rail = $2 AND lower(value) = lower($3)
       AND status IN ('PROPUESTO','APROBADO')`,
    [counterpartyId, input.rail, value],
  );
  if (dup.rowCount) throw new DomainError('DUPLICATE', `Ese destino ya está ${dup.rows[0].status.toLowerCase()}`);
  const r = await ctx.tx.query<{ id: string }>(
    `INSERT INTO otc.destinations (counterparty_id, rail, value, bank_name, account_type, holder_document, label, status,
       supersedes_id, proposed_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'PROPUESTO',$8,$9) RETURNING id`,
    [
      counterpartyId,
      input.rail,
      value,
      input.bankName ?? null,
      input.accountType ?? null,
      input.holderDocument ?? null,
      input.label.trim(),
      input.supersedesId ?? null,
      ctx.actor.id,
    ],
  );
  await recordAction(ctx, 'destination.propose', 'destination', r.rows[0].id, {
    counterpartyId,
    rail: input.rail,
    value,
  });
  return getDestination(ctx, r.rows[0].id);
}

async function lockDestination(tx: Tx, id: string) {
  const r = await tx.query('SELECT * FROM otc.destinations WHERE id = $1 FOR UPDATE', [id]);
  if (!r.rowCount) throw notFound('El destino');
  return r.rows[0];
}

/** Aprobar o rechazar un destino propuesto. Lo hace una persona distinta de quien lo propuso. */
export async function decideDestination(ctx: Ctx, id: string, approve: boolean, note: string) {
  authorize(ctx.actor, 'destination.decide');
  if (!note.trim()) throw invalid('Explica la decisión');
  const d = await lockDestination(ctx.tx, id);
  if (d.status !== 'PROPUESTO') throw new DomainError('INVALID_STATE', `El destino ya está ${d.status}`);
  assertDifferentPerson(ctx.actor, d.proposed_by, 'Aprobar un destino propuesto');
  const to = approve ? 'APROBADO' : 'RECHAZADO';
  await ctx.tx.query(
    `UPDATE otc.destinations SET status = $2, decided_by = $3, decided_at = $4, decision_note = $5 WHERE id = $1`,
    [id, to, ctx.actor.id, ctx.now(), note.trim()],
  );
  if (approve && d.supersedes_id) {
    await ctx.tx.query(
      `UPDATE otc.destinations SET status = 'REVOCADO', revoked_by = $2, revoked_at = $3, revoke_reason = $4
       WHERE id = $1 AND status = 'APROBADO'`,
      [d.supersedes_id, ctx.actor.id, ctx.now(), `Reemplazado por el destino ${id}`],
    );
  }
  await recordAction(ctx, approve ? 'destination.approve' : 'destination.reject', 'destination', id, { note });
  return getDestination(ctx, id);
}

export async function revokeDestination(ctx: Ctx, id: string, reason: string) {
  authorize(ctx.actor, 'destination.decide');
  if (!reason.trim()) throw invalid('Indica el motivo');
  const d = await lockDestination(ctx.tx, id);
  if (d.status !== 'APROBADO') throw new DomainError('INVALID_STATE', 'Solo se revoca un destino aprobado');
  await ctx.tx.query(
    `UPDATE otc.destinations SET status = 'REVOCADO', revoked_by = $2, revoked_at = $3, revoke_reason = $4 WHERE id = $1`,
    [id, ctx.actor.id, ctx.now(), reason.trim()],
  );
  await recordAction(ctx, 'destination.revoke', 'destination', id, { reason });
  return getDestination(ctx, id);
}

// ---------- Consultas ----------

/** Quien no propone, decide ni entrega ve las cuentas y direcciones enmascaradas. */
const seesFullDestinations = (ctx: Ctx) =>
  can(ctx.actor, 'destination.propose') || can(ctx.actor, 'destination.decide') || can(ctx.actor, 'transfer.manage');

function present(ctx: Ctx, d: Record<string, unknown>) {
  return seesFullDestinations(ctx) ? d : { ...d, value: mask(String(d.value)), holder_document: d.holder_document ? '••••' : null };
}

/** Bandeja de destinos por estado (por ejemplo, los propuestos que esperan decisión de Cumplimiento). */
export async function listDestinations(ctx: Ctx, status: string) {
  const r = await ctx.tx.query(
    `SELECT d.*, v.legal_name AS counterparty_name, u.full_name AS proposed_by_name
     FROM otc.destinations d
     JOIN otc.counterparties c ON c.id = d.counterparty_id
     JOIN otc.counterparty_versions v ON v.counterparty_id = c.id AND v.version = c.current_version
     JOIN public.users u ON u.id = d.proposed_by
     WHERE d.status = $1 ORDER BY d.proposed_at LIMIT 200`,
    [status],
  );
  return r.rows.map((d) => present(ctx, d));
}

export async function getDestination(ctx: Ctx, id: string) {
  const r = await ctx.tx.query('SELECT * FROM otc.destinations WHERE id = $1', [id]);
  if (!r.rowCount) throw notFound('El destino');
  return present(ctx, r.rows[0]);
}

export async function getCounterparty(ctx: Ctx, id: string) {
  const r = await ctx.tx.query(
    `SELECT c.*, v.legal_name, v.email, v.phone, v.notes
     FROM otc.counterparties c
     JOIN otc.counterparty_versions v ON v.counterparty_id = c.id AND v.version = c.current_version
     WHERE c.id = $1`,
    [id],
  );
  if (!r.rowCount) throw notFound('La contraparte');
  // Una transacción usa una sola conexión: las consultas van una tras otra.
  const versions = await ctx.tx.query(
    `SELECT v.version, v.legal_name, v.email, v.phone, v.notes, v.reason, v.created_at, u.full_name AS created_by_name
     FROM otc.counterparty_versions v JOIN public.users u ON u.id = v.created_by
     WHERE counterparty_id = $1 ORDER BY version DESC`,
    [id],
  );
  const kyc = await ctx.tx.query(
    `SELECT k.from_status, k.to_status, k.note, k.created_at, u.full_name AS reviewed_by_name
     FROM otc.kyc_reviews k JOIN public.users u ON u.id = k.reviewed_by
     WHERE counterparty_id = $1 ORDER BY k.created_at DESC`,
    [id],
  );
  const destinations = await ctx.tx.query('SELECT * FROM otc.destinations WHERE counterparty_id = $1 ORDER BY proposed_at DESC', [id]);
  const origins = await originsOf(ctx, id);
  return {
    ...r.rows[0],
    versions: versions.rows,
    kycHistory: kyc.rows,
    destinations: destinations.rows.map((d) => present(ctx, d)),
    origins,
  };
}

export async function listCounterparties(ctx: Ctx, filter: { search?: string; kyc?: KycStatus } = {}) {
  const r = await ctx.tx.query(
    `SELECT c.id, c.number, c.kind, c.document_type, c.document_number, c.kyc_status, v.legal_name, c.created_at
     FROM otc.counterparties c
     JOIN otc.counterparty_versions v ON v.counterparty_id = c.id AND v.version = c.current_version
     WHERE ($1::text IS NULL OR v.legal_name ILIKE '%' || $1 || '%' OR c.document_number ILIKE $1 || '%')
       AND ($2::text IS NULL OR c.kyc_status = $2)
     ORDER BY v.legal_name LIMIT 200`,
    [filter.search ?? null, filter.kyc ?? null],
  );
  return r.rows;
}

/** Destino aprobado para entregar a un cliente por un riel (lo usan cotizaciones y órdenes). */
export async function approvedDestination(q: Db | Tx, counterpartyId: string, rail: Rail, destinationId?: string | null) {
  const r = await q.query(
    `SELECT * FROM otc.destinations
     WHERE counterparty_id = $1 AND rail = $2 AND status = 'APROBADO' AND ($3::uuid IS NULL OR id = $3)
     ORDER BY decided_at DESC LIMIT 1`,
    [counterpartyId, rail, destinationId ?? null],
  );
  return r.rows[0] ?? null;
}
