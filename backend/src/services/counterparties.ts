import type { Db, Tx } from '../db/pool.js';
import { invalid, notFound } from '../domain/errors.js';
import { audit } from './audit.js';
import { requireRole } from './authz.js';
import type { Ctx } from './context.js';

export interface CounterpartyInput {
  name: string;
  documentId: string;
  kycStatus: 'PENDIENTE' | 'APROBADO' | 'BLOQUEADO';
  bankAccount?: string | null;
  tronAddress?: string | null;
  bscAddress?: string | null;
}

export async function listCounterparties(q: Db | Tx) {
  return (await q.query('SELECT * FROM counterparties ORDER BY name')).rows;
}

export async function getCounterparty(q: Db | Tx, id: string) {
  const r = await q.query('SELECT * FROM counterparties WHERE id = $1', [id]);
  if (!r.rowCount) throw notFound('El cliente');
  return r.rows[0];
}

function validateAddresses(ctx: Ctx, input: CounterpartyInput) {
  if (input.tronAddress && !ctx.adapters.chain.isValidAddress('TRON', input.tronAddress)) {
    throw invalid('Dirección Tron inválida');
  }
  if (input.bscAddress && !ctx.adapters.chain.isValidAddress('BSC', input.bscAddress)) {
    throw invalid('Dirección BSC inválida');
  }
}

export async function createCounterparty(ctx: Ctx, input: CounterpartyInput) {
  requireRole(ctx.actor, 'ADMIN', 'OPERADOR');
  validateAddresses(ctx, input);
  const r = await ctx.tx.query(
    `INSERT INTO counterparties (name, document_id, kyc_status, bank_account, tron_address, bsc_address, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [
      input.name.trim(),
      input.documentId.trim(),
      input.kycStatus,
      input.bankAccount || null,
      input.tronAddress || null,
      input.bscAddress || null,
      ctx.actor.id,
    ],
  );
  await audit(ctx.tx, ctx.actor.id, 'counterparty.create', 'counterparty', r.rows[0].id, { ...input });
  return r.rows[0];
}

// Solo el administrador cambia el estado KYC (en un equipo grande, Cumplimiento).
export async function setKycStatus(ctx: Ctx, id: string, kycStatus: CounterpartyInput['kycStatus']) {
  requireRole(ctx.actor, 'ADMIN');
  const before = await getCounterparty(ctx.tx, id);
  const r = await ctx.tx.query('UPDATE counterparties SET kyc_status = $1 WHERE id = $2 RETURNING *', [kycStatus, id]);
  await audit(ctx.tx, ctx.actor.id, 'counterparty.kyc', 'counterparty', id, { from: before.kyc_status, to: kycStatus });
  return r.rows[0];
}
