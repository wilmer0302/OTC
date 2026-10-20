import { audit } from '../services/audit.js';
import { actorDbId, type Ctx } from './context.js';

/**
 * Deja constancia de un cambio de estado: un evento en el historial del objeto y un registro
 * en la auditoría encadenada, ambos en la transacción del caso de uso.
 */
export async function recordTransition(
  ctx: Ctx,
  entity: string,
  entityId: string,
  from: string | null,
  to: string,
  note: string | null,
  data: Record<string, unknown> = {},
): Promise<void> {
  const actorId = actorDbId(ctx.actor);
  await ctx.tx.query(
    `INSERT INTO otc.state_events (entity, entity_id, from_status, to_status, actor_id, note, data)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [entity, entityId, from, to, actorId, note, data],
  );
  await audit(ctx.tx, actorId, `${entity}.${to.toLowerCase()}`, entity, entityId, { from, to, note, ...data });
}

/** Registro de auditoría de una acción que no es un cambio de estado. */
export async function recordAction(
  ctx: Ctx,
  action: string,
  entity: string,
  entityId: string | null,
  data: Record<string, unknown> = {},
): Promise<void> {
  await audit(ctx.tx, actorDbId(ctx.actor), action, entity, entityId, data);
}

export async function history(ctx: Pick<Ctx, 'tx'>, entity: string, entityId: string) {
  const r = await ctx.tx.query(
    `SELECT e.id, e.from_status, e.to_status, e.note, e.data, e.created_at, u.full_name AS actor_name
     FROM otc.state_events e LEFT JOIN public.users u ON u.id = e.actor_id
     WHERE e.entity = $1 AND e.entity_id = $2 ORDER BY e.id`,
    [entity, entityId],
  );
  return r.rows;
}
