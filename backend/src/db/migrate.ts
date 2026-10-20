import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPool, type Db } from './pool.js';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'migrations');
const MIGRATION_LOCK = 7_301_002; // dos despliegues simultáneos nunca migran a la vez

const checksumOf = (sql: string) => createHash('sha256').update(sql).digest('hex');

// Migraciones versionadas, solo hacia adelante. Un archivo ya aplicado no puede cambiar:
// si su suma de verificación difiere, el arranque se detiene.
export async function migrate(db: Db): Promise<string[]> {
  const client = await db.connect();
  const applied: string[] = [];
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK]);
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    await client.query('ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS checksum TEXT');

    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
      const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf8');
      const sum = checksumOf(sql);
      const done = await client.query<{ checksum: string | null }>(
        'SELECT checksum FROM schema_migrations WHERE name = $1',
        [file],
      );
      if (done.rowCount) {
        const stored = done.rows[0].checksum;
        if (stored === null) {
          // Migración aplicada antes de que existiera la verificación: se registra su suma actual.
          await client.query('UPDATE schema_migrations SET checksum = $1 WHERE name = $2', [sum, file]);
        } else if (stored !== sum) {
          throw new Error(`La migración ${file} cambió después de aplicarse. Crea una migración nueva en su lugar.`);
        }
        continue;
      }
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [file, sum]);
        await client.query('COMMIT');
        applied.push(file);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Falló la migración ${file}: ${(err as Error).message}`);
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK]).catch(() => {});
    client.release();
  }
  return applied;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('Falta DATABASE_URL');
  const db = createPool(url);
  migrate(db)
    .then((applied) => console.log(applied.length ? `Aplicadas: ${applied.join(', ')}` : 'Sin migraciones pendientes'))
    .finally(() => db.end());
}
