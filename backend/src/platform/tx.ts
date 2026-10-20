import type { Db, Tx } from '../db/pool.js';

const RETRYABLE = new Set(['40001', '40P01']); // conflicto de serialización, bloqueo mutuo
const MAX_ATTEMPTS = 3;

/**
 * Ejecuta un paso crítico en una sola transacción. Si PostgreSQL reporta un conflicto de
 * serialización o un bloqueo mutuo, el paso completo se repite (hasta 3 intentos).
 */
export async function inTransaction<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      const code = (err as { code?: string }).code;
      if (code && RETRYABLE.has(code) && attempt < MAX_ATTEMPTS) continue;
      throw err;
    } finally {
      client.release();
    }
  }
}

/** Bloqueo consultivo dentro de la transacción, por nombre (por ejemplo, el control de límites). */
export async function lockByName(tx: Tx, name: string): Promise<void> {
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [name]);
}
