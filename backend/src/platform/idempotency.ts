import { createHash } from 'node:crypto';
import type { Tx } from '../db/pool.js';
import { DomainError } from '../domain/errors.js';
import { canonical } from '../services/audit.js';
import { lockByName } from './tx.js';

export interface IdempotencyScope {
  key: string;
  userId: string;
  route: string;
  body: unknown;
}

export interface StoredResponse<T> {
  statusCode: number;
  body: T;
  replayed: boolean;
}

export const requestHash = (body: unknown) => createHash('sha256').update(canonical(body ?? null)).digest('hex');

/**
 * Ejecuta una acción una sola vez por clave. Dos solicitudes simultáneas con la misma clave se
 * esperan entre sí (bloqueo por clave): la segunda recibe la respuesta guardada de la primera.
 * La misma clave con otro cuerpo se rechaza. Si la acción falla, no se guarda nada y la
 * transacción completa se revierte.
 */
export async function runIdempotent<T>(
  tx: Tx,
  scope: IdempotencyScope,
  action: () => Promise<{ statusCode: number; body: T }>,
): Promise<StoredResponse<T>> {
  if (!/^[A-Za-z0-9_.:-]{8,200}$/.test(scope.key)) {
    throw new DomainError('INVALID_IDEMPOTENCY_KEY', 'La clave de idempotencia debe tener entre 8 y 200 caracteres simples', 400);
  }
  const hash = requestHash(scope.body);
  await lockByName(tx, `idem:${scope.userId}:${scope.route}:${scope.key}`);
  const prev = await tx.query<{ request_hash: string; status_code: number; response: T }>(
    'SELECT request_hash, status_code, response FROM otc.idempotency_keys WHERE key = $1 AND user_id = $2 AND route = $3',
    [scope.key, scope.userId, scope.route],
  );
  if (prev.rowCount) {
    const row = prev.rows[0];
    if (row.request_hash !== hash) {
      throw new DomainError(
        'IDEMPOTENCY_MISMATCH',
        'Esa clave de idempotencia ya se usó con otros datos; genera una clave nueva',
        422,
      );
    }
    return { statusCode: row.status_code, body: row.response, replayed: true };
  }
  const result = await action();
  await tx.query(
    `INSERT INTO otc.idempotency_keys (key, user_id, route, request_hash, status_code, response)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [scope.key, scope.userId, scope.route, hash, result.statusCode, JSON.stringify(result.body ?? null)],
  );
  return { ...result, replayed: false };
}
