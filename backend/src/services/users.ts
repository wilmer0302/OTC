import bcrypt from 'bcryptjs';
import type { Db, Tx } from '../db/pool.js';
import { audit } from './audit.js';

const DUMMY_HASH = bcrypt.hashSync('no-es-una-clave-real', 10);
import type { Actor, Role } from './context.js';

// Devuelve null si falla, sin lanzar, para que el intento fallido quede auditado.
export async function authenticate(tx: Tx, username: string, password: string): Promise<Actor | null> {
  const r = await tx.query('SELECT id, username, password_hash, roles, active FROM users WHERE username = $1', [username]);
  const user = r.rows[0];
  // Se compara siempre para no revelar por tiempo si el usuario existe.
  const ok = await bcrypt.compare(password, user?.password_hash ?? DUMMY_HASH);
  if (!user || !ok || !user.active) {
    await audit(tx, user?.id ?? null, 'auth.login_failed', 'user', user?.id ?? null, { username });
    return null;
  }
  await audit(tx, user.id, 'auth.login', 'user', user.id, {});
  return { id: user.id, username: user.username, roles: user.roles as Role[] };
}

export async function listUsers(q: Db | Tx) {
  return (await q.query('SELECT id, username, full_name, roles, active FROM users ORDER BY id')).rows;
}

export async function createUser(
  tx: Tx,
  input: { username: string; fullName: string; password: string; roles: Role[] },
): Promise<string> {
  const hash = await bcrypt.hash(input.password, 10);
  const r = await tx.query<{ id: string }>(
    'INSERT INTO users (username, full_name, password_hash, roles) VALUES ($1,$2,$3,$4) RETURNING id',
    [input.username, input.fullName, hash, input.roles],
  );
  return r.rows[0].id;
}
