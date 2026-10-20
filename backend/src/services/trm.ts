import type { Db, Tx } from '../db/pool.js';
import { D } from '../domain/money.js';
import { DomainError, invalid } from '../domain/errors.js';
import { audit } from './audit.js';
import { requireRole } from './authz.js';
import type { Ctx } from './context.js';

// Fecha de hoy en Bogotá, formato YYYY-MM-DD.
export function bogotaDate(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota' }).format(now);
}

export interface TrmRow {
  id: string;
  valid_date: string;
  rate: string;
  source: string;
  simulated: boolean;
  created_at: string;
}

const SELECT = `SELECT id, to_char(valid_date,'YYYY-MM-DD') AS valid_date, rate, source, simulated, created_at FROM trm_rates`;

export async function currentTrm(q: Db | Tx, date = bogotaDate()): Promise<TrmRow | null> {
  const r = await q.query<TrmRow>(`${SELECT} WHERE valid_date = $1 ORDER BY created_at DESC, id DESC LIMIT 1`, [date]);
  return r.rows[0] ?? null;
}

export async function requireCurrentTrm(q: Db | Tx): Promise<TrmRow> {
  const trm = await currentTrm(q);
  if (!trm) {
    throw new DomainError('NO_TRM', `No hay TRM cargada para hoy (${bogotaDate()}). No se puede cotizar.`);
  }
  return trm;
}

export async function listTrm(q: Db | Tx): Promise<TrmRow[]> {
  return (await q.query<TrmRow>(`${SELECT} ORDER BY valid_date DESC, created_at DESC LIMIT 30`)).rows;
}

// En la demo la TRM se ingresa a mano y queda marcada como tal.
// La fuente oficial automática se elige en una fase posterior.
export async function recordManualTrm(ctx: Ctx, input: { rate: string; validDate?: string }): Promise<TrmRow> {
  requireRole(ctx.actor, 'ADMIN', 'TESORERO');
  const rate = new D(input.rate);
  if (!rate.isFinite() || rate.lte(0) || rate.decimalPlaces() > 2) throw invalid('TRM inválida');
  const validDate = input.validDate ?? bogotaDate();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(validDate)) throw invalid('Fecha inválida');
  const r = await ctx.tx.query<{ id: string }>(
    `INSERT INTO trm_rates (valid_date, rate, source, simulated, entered_by)
     VALUES ($1,$2,'Ingreso manual',$3,$4) RETURNING id`,
    [validDate, rate.toString(), ctx.adapters.chain.simulated, ctx.actor.id],
  );
  await audit(ctx.tx, ctx.actor.id, 'trm.record', 'trm', r.rows[0].id, { rate: rate.toString(), validDate });
  return (await ctx.tx.query<TrmRow>(`${SELECT} WHERE id = $1`, [r.rows[0].id])).rows[0];
}
