import type { Db } from '../../db/pool.js';
import { DomainError } from '../../domain/errors.js';
import { actorDbId, type Ctx } from '../../platform/context.js';
import { history } from '../../platform/events.js';
import { audit, verifyAuditChain } from '../../services/audit.js';
import { authorize } from '../identity/permissions.js';

// Auditoría y trazabilidad (especificación, módulo 14). El registro vive en public.audit_log, con
// hash encadenado y protegido por la base contra cambios y borrados. Aquí: consulta, verificación
// de integridad y anclas.

export interface AuditFilter {
  entity?: string;
  entityId?: string;
  actorId?: string;
  action?: string;
  from?: string;
  to?: string;
  before?: string; // id: paginación hacia atrás
  limit?: number;
}

/** Quién hizo qué, cuándo, desde dónde y con qué valores. Del más reciente al más antiguo. */
export async function listAudit(ctx: Pick<Ctx, 'tx' | 'actor'>, f: AuditFilter) {
  authorize(ctx.actor, 'audit.read');
  const limit = Math.min(f.limit ?? 100, 500);
  const r = await ctx.tx.query(
    `SELECT a.id, a.at, a.actor_id, u.username AS actor, a.action, a.entity, a.entity_id, a.data, a.hash
     FROM public.audit_log a LEFT JOIN public.users u ON u.id = a.actor_id
     WHERE ($1::text IS NULL OR a.entity = $1) AND ($2::text IS NULL OR a.entity_id = $2)
       AND ($3::bigint IS NULL OR a.actor_id = $3) AND ($4::text IS NULL OR a.action LIKE $4 || '%')
       AND ($5::timestamptz IS NULL OR a.at >= $5) AND ($6::timestamptz IS NULL OR a.at < $6)
       AND ($7::bigint IS NULL OR a.id < $7)
     ORDER BY a.id DESC LIMIT $8`,
    [f.entity ?? null, f.entityId ?? null, f.actorId ?? null, f.action ?? null, f.from ?? null, f.to ?? null, f.before ?? null, limit],
  );
  return { items: r.rows, next: r.rows.length === limit ? r.rows[r.rows.length - 1].id : null };
}

/**
 * Verifica la cadena completa y cada ancla. Si algo no coincide, señala el primer registro
 * alterado o el ancla que ya no corresponde.
 */
export async function verifyAudit(db: Db) {
  const chain = await verifyAuditChain(db);
  const anchors = await db.query(
    `SELECT n.id, n.audit_id, n.hash AS anchored, a.hash AS current FROM otc.audit_anchors n
     LEFT JOIN public.audit_log a ON a.id = n.audit_id ORDER BY n.id`,
  );
  const badAnchor = anchors.rows.find((x) => x.current !== x.anchored);
  return {
    ok: chain.ok && !badAnchor,
    chain,
    anchors: { checked: anchors.rowCount ?? 0, brokenAnchor: badAnchor ? String(badAnchor.id) : undefined },
  };
}

/** Fija un ancla con el hash del último registro; ese hash se puede guardar fuera de la plataforma. */
export async function createAnchor(ctx: Ctx, note: string | null) {
  if (ctx.actor.id !== '0') authorize(ctx.actor, 'audit.read');
  const last = await ctx.tx.query<{ id: string; hash: string; n: string }>(
    `SELECT id, hash, (SELECT count(*) FROM public.audit_log) AS n FROM public.audit_log ORDER BY id DESC LIMIT 1`,
  );
  if (!last.rowCount) throw new DomainError('EMPTY', 'La auditoría está vacía');
  const row = last.rows[0];
  const r = await ctx.tx.query(
    `INSERT INTO otc.audit_anchors (audit_id, hash, records, note, created_by, created_at) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [row.id, row.hash, row.n, note, actorDbId(ctx.actor), ctx.now()],
  );
  await audit(ctx.tx, actorDbId(ctx.actor), 'audit.anchor', 'audit_anchor', r.rows[0].id, { auditId: row.id, hash: row.hash, note });
  return r.rows[0];
}

/** El trabajador fija un ancla al día si hubo actividad desde la última. */
export async function dailyAnchor(ctx: Ctx) {
  const last = await ctx.tx.query<{ created_at: Date; audit_id: string }>(
    'SELECT created_at, audit_id FROM otc.audit_anchors ORDER BY id DESC LIMIT 1',
  );
  const newest = await ctx.tx.query<{ id: string }>('SELECT id FROM public.audit_log ORDER BY id DESC LIMIT 1');
  if (!newest.rowCount) return null;
  const prev = last.rows[0];
  if (prev && (ctx.now().getTime() - new Date(prev.created_at).getTime() < 24 * 3600 * 1000 || prev.audit_id === newest.rows[0].id)) return null;
  return createAnchor(ctx, 'Ancla diaria automática');
}

export async function listAnchors(ctx: Pick<Ctx, 'tx' | 'actor'>) {
  authorize(ctx.actor, 'audit.read');
  const r = await ctx.tx.query('SELECT * FROM otc.audit_anchors ORDER BY id DESC LIMIT 100');
  return r.rows;
}

const ENTITIES = ['request', 'quote', 'order', 'transfer', 'recon_item', 'recon_run', 'adjustment'] as const;
export type HistoryEntity = (typeof ENTITIES)[number];
export const HISTORY_ENTITIES = ENTITIES;

/** Historial de estados de un objeto: quién, cuándo, de qué estado a cuál y por qué. */
export const entityHistory = (ctx: Pick<Ctx, 'tx'>, entity: HistoryEntity, id: string) => history(ctx, entity, id);
