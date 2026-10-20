import { createHash } from 'node:crypto';
import type { Db, Tx } from '../db/pool.js';

const GENESIS = '0'.repeat(64);
const AUDIT_LOCK = 7_301_001; // serializa la cadena de hashes

// JSON con llaves ordenadas para que el hash no dependa del orden.
export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .filter((k) => obj[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`)
    .join(',')}}`;
}

interface AuditBody {
  at: string;
  actorId: string | null;
  action: string;
  entity: string;
  entityId: string | null;
  data: Record<string, unknown>;
}

const hashOf = (prev: string, body: AuditBody) =>
  createHash('sha256').update(`${prev}|${canonical(body)}`).digest('hex');

export async function audit(
  tx: Tx,
  actorId: string | null,
  action: string,
  entity: string,
  entityId: string | number | null,
  data: Record<string, unknown> = {},
): Promise<void> {
  await tx.query('SELECT pg_advisory_xact_lock($1)', [AUDIT_LOCK]);
  const last = await tx.query<{ hash: string }>('SELECT hash FROM audit_log ORDER BY id DESC LIMIT 1');
  const prev = last.rows[0]?.hash ?? GENESIS;
  const body: AuditBody = {
    at: new Date().toISOString(),
    actorId,
    action,
    entity,
    entityId: entityId === null ? null : String(entityId),
    data: JSON.parse(JSON.stringify(data)),
  };
  await tx.query(
    `INSERT INTO audit_log (at, actor_id, action, entity, entity_id, data, prev_hash, hash)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [body.at, actorId, action, entity, body.entityId, body.data, prev, hashOf(prev, body)],
  );
}

export async function verifyAuditChain(db: Db): Promise<{ ok: boolean; checked: number; brokenAt?: string }> {
  const rows = await db.query(
    `SELECT id, to_char(at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at,
            actor_id, action, entity, entity_id, data, prev_hash, hash
     FROM audit_log ORDER BY id`,
  );
  let prev = GENESIS;
  for (const r of rows.rows) {
    const body: AuditBody = {
      at: r.at,
      actorId: r.actor_id,
      action: r.action,
      entity: r.entity,
      entityId: r.entity_id,
      data: r.data,
    };
    if (r.prev_hash !== prev || hashOf(prev, body) !== r.hash) {
      return { ok: false, checked: rows.rowCount ?? 0, brokenAt: r.id };
    }
    prev = r.hash;
  }
  return { ok: true, checked: rows.rowCount ?? 0 };
}
