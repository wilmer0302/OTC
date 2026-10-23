import { DomainError, notFound } from '../domain/errors.js';
import { actorDbId, type Ctx } from './context.js';
import { recordAction } from './events.js';

// Bandeja de pendientes: un caso abierto por objeto y motivo. Abrir dos veces el mismo
// caso no lo duplica; agrega la novedad al registro de auditoría.

export async function openCase(ctx: Ctx, entity: string, entityId: string, reason: string, detail: string) {
  const r = await ctx.tx.query<{ id: string }>(
    `INSERT INTO otc.cases (entity, entity_id, reason, detail, status, opened_by)
     VALUES ($1,$2,$3,$4,'ABIERTO',$5)
     ON CONFLICT (entity, entity_id, reason) WHERE status = 'ABIERTO' DO NOTHING
     RETURNING id`,
    [entity, entityId, reason, detail, actorDbId(ctx.actor)],
  );
  const id = r.rows[0]?.id ?? null;
  await recordAction(ctx, id ? 'case.open' : 'case.update', 'case', id, { entity, entityId, reason, detail });
  return id;
}

export async function resolveCase(ctx: Ctx, caseId: string, resolution: string) {
  const r = await ctx.tx.query(`SELECT * FROM otc.cases WHERE id = $1 FOR UPDATE`, [caseId]);
  if (!r.rowCount) throw notFound('El caso');
  if (r.rows[0].status !== 'ABIERTO') throw new DomainError('CASE_CLOSED', 'El caso ya está resuelto');
  await ctx.tx.query(
    `UPDATE otc.cases SET status = 'RESUELTO', resolved_by = $2, resolved_at = now(), resolution = $3 WHERE id = $1`,
    [caseId, actorDbId(ctx.actor), resolution],
  );
  await recordAction(ctx, 'case.resolve', 'case', caseId, { resolution });
}

/** Cierra los casos abiertos de un objeto (por ejemplo, al resolver su revisión). */
export async function resolveCasesFor(ctx: Ctx, entity: string, entityId: string, resolution: string) {
  const r = await ctx.tx.query<{ id: string }>(
    `SELECT id FROM otc.cases WHERE entity = $1 AND entity_id = $2 AND status = 'ABIERTO' FOR UPDATE`,
    [entity, entityId],
  );
  for (const row of r.rows) await resolveCase(ctx, row.id, resolution);
}

export async function listOpenCases(ctx: Pick<Ctx, 'tx'>) {
  const r = await ctx.tx.query(
    `SELECT c.*, extract(epoch FROM now() - c.opened_at)::int AS age_seconds
     FROM otc.cases c WHERE status = 'ABIERTO' ORDER BY opened_at`,
  );
  return r.rows;
}
