import pg from 'pg';

// NUMERIC llega como texto para no perder precisión; nunca se convierte a float.
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (v) => v);
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => v);

export type Db = pg.Pool;
export type Tx = pg.PoolClient;

export function createPool(connectionString: string): Db {
  // search_path fijo: si el usuario de la base se llamara igual que el esquema "otc", PostgreSQL
  // buscaría ahí primero las tablas de la demo. El código v1 siempre escribe "otc." explícito.
  return new pg.Pool({ connectionString, max: 10, options: '-c search_path=public' });
}

export async function withTx<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
