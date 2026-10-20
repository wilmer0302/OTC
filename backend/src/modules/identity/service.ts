import argon2 from 'argon2';
import bcrypt from 'bcryptjs';
import type { Db, Tx } from '../../db/pool.js';
import { DomainError, invalid, notFound } from '../../domain/errors.js';
import { actorDbId, type Actor, type Ctx, type Role } from '../../platform/context.js';
import { decrypt, encrypt, randomToken, sha256 } from '../../platform/crypto.js';
import { recordAction } from '../../platform/events.js';
import { audit } from '../../services/audit.js';
import { authorize, ROLES } from './permissions.js';
import { newTotpSecret, otpauthUri, verifyTotp } from './totp.js';

export interface IdentityConfig {
  mfaKey: Buffer;
  issuer: string;
  sessionIdleSeconds: number; // 15 minutos sin actividad
  sessionMaxSeconds: number; // 8 horas como máximo
  maxFailedLogins: number;
  lockSeconds: number;
}

export const DEFAULT_IDENTITY: Omit<IdentityConfig, 'mfaKey'> = {
  issuer: 'Mesa OTC',
  sessionIdleSeconds: 15 * 60,
  sessionMaxSeconds: 8 * 60 * 60,
  maxFailedLogins: 5,
  lockSeconds: 15 * 60,
};

// ---------- Contraseñas ----------

const ARGON2_OPTIONS = { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;
const DUMMY_HASH = await argon2.hash('no-es-una-clave-real', ARGON2_OPTIONS);

export const hashPassword = (password: string) => argon2.hash(password, ARGON2_OPTIONS);

/** Verifica contra Argon2id, o contra bcrypt para usuarios creados por la demo anterior. */
export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  if (hash.startsWith('$argon2')) return argon2.verify(hash, password);
  if (hash.startsWith('$2')) return bcrypt.compare(password, hash);
  return false;
}

export function assertPasswordPolicy(password: string): void {
  if (password.length < 12) throw invalid('La contraseña debe tener al menos 12 caracteres');
  if (password.length > 200) throw invalid('La contraseña es demasiado larga');
}

// ---------- Sesiones ----------

export interface SessionTokens {
  token: string; // va solo en la cookie HttpOnly
  csrfToken: string; // el frontend lo envía en la cabecera x-csrf-token
}

export interface LoginResult extends SessionTokens {
  user: Actor & { fullName: string };
  mfa: 'REQUIRED' | 'ENROLL';
}

export interface SessionRow {
  id: string;
  user_id: string;
  csrf_hash: string;
  mfa_verified: boolean;
  last_seen_at: Date;
  expires_at: Date;
  revoked_at: Date | null;
}

async function createSession(
  tx: Tx,
  cfg: IdentityConfig,
  userId: string,
  now: Date,
  meta: { ip?: string; userAgent?: string },
  mfaVerified = false,
): Promise<SessionTokens & { sessionId: string }> {
  const token = randomToken();
  const csrfToken = randomToken();
  const r = await tx.query<{ id: string }>(
    `INSERT INTO otc.sessions (token_hash, csrf_hash, user_id, mfa_verified, created_at, last_seen_at, expires_at, ip, user_agent)
     VALUES ($1,$2,$3,$4,$5,$5,$6,$7,$8) RETURNING id`,
    [
      sha256(token),
      sha256(csrfToken),
      userId,
      mfaVerified,
      now,
      new Date(now.getTime() + cfg.sessionMaxSeconds * 1000),
      meta.ip ?? null,
      meta.userAgent?.slice(0, 300) ?? null,
    ],
  );
  return { token, csrfToken, sessionId: r.rows[0].id };
}

/**
 * Inicio de sesión con usuario y contraseña. Devuelve null si falla, sin lanzar, para que el
 * intento fallido y el posible bloqueo queden guardados en la auditoría.
 * La sesión nace sin segundo factor: solo sirve para completarlo.
 */
export async function login(
  tx: Tx,
  cfg: IdentityConfig,
  input: { username: string; password: string; ip?: string; userAgent?: string },
  now: Date,
): Promise<LoginResult | null> {
  const r = await tx.query(
    `SELECT id, username, full_name, password_hash, roles, active, failed_logins, locked_until
     FROM public.users WHERE username = $1 FOR UPDATE`,
    [input.username],
  );
  const user = r.rows[0];
  // Se verifica siempre una huella para no revelar por tiempo si el usuario existe.
  const ok = await verifyPassword(user?.password_hash ?? DUMMY_HASH, input.password);

  if (user && user.locked_until && new Date(user.locked_until) > now) {
    await audit(tx, user.id, 'auth.login_locked', 'user', user.id, { username: input.username, ip: input.ip ?? null });
    return null;
  }
  if (!user || !ok || !user.active) {
    if (user) {
      const failed = user.failed_logins + 1;
      const lock = failed >= cfg.maxFailedLogins;
      await tx.query('UPDATE public.users SET failed_logins = $2, locked_until = $3 WHERE id = $1', [
        user.id,
        lock ? 0 : failed,
        lock ? new Date(now.getTime() + cfg.lockSeconds * 1000) : null,
      ]);
      if (lock) await audit(tx, user.id, 'auth.user_locked', 'user', user.id, { minutes: cfg.lockSeconds / 60 });
    }
    await audit(tx, user?.id ?? null, 'auth.login_failed', 'user', user?.id ?? null, {
      username: input.username,
      ip: input.ip ?? null,
    });
    return null;
  }

  // Migración transparente de bcrypt a Argon2id al iniciar sesión.
  if (!String(user.password_hash).startsWith('$argon2')) {
    await tx.query('UPDATE public.users SET password_hash = $2 WHERE id = $1', [user.id, await hashPassword(input.password)]);
    await audit(tx, user.id, 'auth.password_rehashed', 'user', user.id, { algorithm: 'argon2id' });
  }
  await tx.query('UPDATE public.users SET failed_logins = 0, locked_until = NULL WHERE id = $1', [user.id]);

  const factor = await tx.query('SELECT confirmed_at FROM otc.mfa_factors WHERE user_id = $1', [user.id]);
  const mfa = factor.rows[0]?.confirmed_at ? 'REQUIRED' : 'ENROLL';
  const session = await createSession(tx, cfg, user.id, now, input);
  await audit(tx, user.id, 'auth.login_password', 'session', session.sessionId, { mfa, ip: input.ip ?? null });
  return {
    token: session.token,
    csrfToken: session.csrfToken,
    mfa,
    user: { id: user.id, username: user.username, fullName: user.full_name, roles: user.roles as Role[] },
  };
}

export interface ResolvedSession {
  session: SessionRow;
  actor: Actor & { fullName: string };
}

/** Busca la sesión de una cookie. Vence por inactividad o por tiempo máximo, y muere si el usuario se desactiva. */
export async function resolveSession(tx: Tx | Db, cfg: IdentityConfig, token: string, now: Date): Promise<ResolvedSession | null> {
  if (!token) return null;
  const r = await tx.query(
    `SELECT s.*, u.username, u.full_name, u.roles, u.active
     FROM otc.sessions s JOIN public.users u ON u.id = s.user_id WHERE s.token_hash = $1`,
    [sha256(token)],
  );
  const s = r.rows[0];
  if (!s || s.revoked_at) return null;
  const idleLimit = new Date(new Date(s.last_seen_at).getTime() + cfg.sessionIdleSeconds * 1000);
  if (!s.active || new Date(s.expires_at) <= now || idleLimit <= now) {
    const reason = !s.active ? 'usuario desactivado' : new Date(s.expires_at) <= now ? 'tiempo máximo' : 'inactividad';
    await tx.query(`UPDATE otc.sessions SET revoked_at = $2, revoked_reason = $3 WHERE id = $1 AND revoked_at IS NULL`, [
      s.id,
      now,
      reason,
    ]);
    return null;
  }
  // Se actualiza la última actividad como mucho una vez por minuto.
  if (now.getTime() - new Date(s.last_seen_at).getTime() > 60_000) {
    await tx.query('UPDATE otc.sessions SET last_seen_at = $2 WHERE id = $1', [s.id, now]);
  }
  return {
    session: s,
    actor: { id: String(s.user_id), username: s.username, fullName: s.full_name, roles: s.roles as Role[] },
  };
}

export const csrfMatches = (session: SessionRow, header: string | undefined) =>
  typeof header === 'string' && header.length > 0 && sha256(header) === session.csrf_hash;

export async function logout(tx: Tx, sessionId: string, actorId: string): Promise<void> {
  await tx.query(
    `UPDATE otc.sessions SET revoked_at = now(), revoked_reason = 'cierre de sesión' WHERE id = $1 AND revoked_at IS NULL`,
    [sessionId],
  );
  await audit(tx, actorId, 'auth.logout', 'session', sessionId, {});
}

async function revokeAllSessions(tx: Tx, userId: string, reason: string): Promise<number> {
  const r = await tx.query(
    `UPDATE otc.sessions SET revoked_at = now(), revoked_reason = $2 WHERE user_id = $1 AND revoked_at IS NULL`,
    [userId, reason],
  );
  return r.rowCount ?? 0;
}

// ---------- Segundo factor ----------

/** Genera el secreto TOTP para enrolarse. Solo si el usuario aún no tiene un factor confirmado. */
export async function startMfaEnrollment(tx: Tx, cfg: IdentityConfig, resolved: ResolvedSession) {
  const userId = resolved.actor.id;
  const existing = await tx.query('SELECT confirmed_at FROM otc.mfa_factors WHERE user_id = $1 FOR UPDATE', [userId]);
  if (existing.rows[0]?.confirmed_at) {
    throw new DomainError('MFA_ALREADY_ENROLLED', 'Ya tienes un segundo factor; pide al administrador reiniciarlo si lo perdiste');
  }
  const secret = newTotpSecret();
  await tx.query(
    `INSERT INTO otc.mfa_factors (user_id, secret_enc) VALUES ($1,$2)
     ON CONFLICT (user_id) DO UPDATE SET secret_enc = EXCLUDED.secret_enc, confirmed_at = NULL, last_used_step = NULL`,
    [userId, encrypt(cfg.mfaKey, secret)],
  );
  await audit(tx, userId, 'auth.mfa_enrollment_started', 'user', userId, {});
  return { secret, otpauthUri: otpauthUri(cfg.issuer, resolved.actor.username, secret) };
}

/**
 * Verifica el código de 6 dígitos. Si es correcto, la sesión vieja se revoca y nace una nueva
 * con el segundo factor cumplido (cambio de identificador tras subir de privilegio).
 */
export async function verifyMfa(
  tx: Tx,
  cfg: IdentityConfig,
  resolved: ResolvedSession,
  code: string,
  now: Date,
  meta: { ip?: string; userAgent?: string },
): Promise<SessionTokens | null> {
  const userId = resolved.actor.id;
  const f = await tx.query('SELECT secret_enc, confirmed_at, last_used_step FROM otc.mfa_factors WHERE user_id = $1 FOR UPDATE', [
    userId,
  ]);
  const factor = f.rows[0];
  if (!factor || factor.secret_enc === 'REINICIADO') {
    throw new DomainError('MFA_NOT_ENROLLED', 'Primero configura tu segundo factor');
  }
  const step = verifyTotp(
    decrypt(cfg.mfaKey, factor.secret_enc),
    code,
    now,
    factor.last_used_step === null ? null : BigInt(factor.last_used_step),
  );
  if (step === null) {
    await audit(tx, userId, 'auth.mfa_failed', 'session', resolved.session.id, {});
    return null;
  }
  await tx.query(
    `UPDATE otc.mfa_factors SET last_used_step = $2, confirmed_at = COALESCE(confirmed_at, $3) WHERE user_id = $1`,
    [userId, step.toString(), now],
  );
  await tx.query(`UPDATE otc.sessions SET revoked_at = $2, revoked_reason = 'segundo factor completado' WHERE id = $1`, [
    resolved.session.id,
    now,
  ]);
  const fresh = await createSession(tx, cfg, userId, now, meta, true);
  await audit(tx, userId, factor.confirmed_at ? 'auth.login_mfa' : 'auth.mfa_enrolled', 'session', fresh.sessionId, {});
  return { token: fresh.token, csrfToken: fresh.csrfToken };
}

// ---------- Administración de usuarios ----------

const ROLE_SET = new Set<string>(ROLES);

function assertRoles(roles: string[]): Role[] {
  if (!roles.length) throw invalid('El usuario necesita al menos un rol');
  for (const r of roles) if (!ROLE_SET.has(r)) throw invalid(`Rol desconocido: ${r}`);
  return [...new Set(roles)] as Role[];
}

export async function listUsers(ctx: Pick<Ctx, 'tx'>) {
  const r = await ctx.tx.query(
    `SELECT u.id, u.username, u.full_name, u.roles, u.active, u.locked_until, u.created_at,
            (f.confirmed_at IS NOT NULL) AS mfa_enrolled
     FROM public.users u LEFT JOIN otc.mfa_factors f ON f.user_id = u.id ORDER BY u.id`,
  );
  return r.rows;
}

export async function createUser(ctx: Ctx, input: { username: string; fullName: string; password: string; roles: string[] }) {
  authorize(ctx.actor, 'users.manage');
  if (!/^[a-z0-9._-]{3,40}$/.test(input.username)) throw invalid('Usuario: 3 a 40 letras minúsculas, números, punto o guion');
  assertPasswordPolicy(input.password);
  const roles = assertRoles(input.roles);
  const dup = await ctx.tx.query('SELECT 1 FROM public.users WHERE username = $1', [input.username]);
  if (dup.rowCount) throw new DomainError('DUPLICATE', 'Ese usuario ya existe');
  const r = await ctx.tx.query<{ id: string }>(
    'INSERT INTO public.users (username, full_name, password_hash, roles) VALUES ($1,$2,$3,$4) RETURNING id',
    [input.username, input.fullName.trim(), await hashPassword(input.password), roles],
  );
  await recordAction(ctx, 'user.create', 'user', r.rows[0].id, { username: input.username, roles });
  return { id: r.rows[0].id, username: input.username, fullName: input.fullName.trim(), roles };
}

async function lockUser(ctx: Ctx, userId: string) {
  const r = await ctx.tx.query('SELECT id, username, roles, active FROM public.users WHERE id = $1 FOR UPDATE', [userId]);
  if (!r.rowCount) throw notFound('El usuario');
  return r.rows[0];
}

/** Siempre debe quedar al menos un administrador activo. */
async function assertAdminRemains(ctx: Ctx, exceptUserId: string) {
  const r = await ctx.tx.query(
    `SELECT count(*)::int AS n FROM public.users WHERE active AND 'ADMIN' = ANY(roles) AND id <> $1`,
    [exceptUserId],
  );
  if (r.rows[0].n === 0) throw new DomainError('LAST_ADMIN', 'Debe quedar al menos un administrador activo');
}

export async function setRoles(ctx: Ctx, userId: string, rolesInput: string[]) {
  authorize(ctx.actor, 'users.manage');
  const roles = assertRoles(rolesInput);
  const user = await lockUser(ctx, userId);
  if (user.roles.includes('ADMIN') && !roles.includes('ADMIN')) await assertAdminRemains(ctx, userId);
  await ctx.tx.query('UPDATE public.users SET roles = $2 WHERE id = $1', [userId, roles]);
  // Los permisos nuevos rigen desde el próximo inicio de sesión.
  const revoked = await revokeAllSessions(ctx.tx, userId, 'cambio de roles');
  await recordAction(ctx, 'user.roles', 'user', userId, { from: user.roles, to: roles, sessionsRevoked: revoked });
  return { id: userId, roles };
}

export async function setActive(ctx: Ctx, userId: string, active: boolean, reason: string) {
  authorize(ctx.actor, 'users.manage');
  if (!reason.trim()) throw invalid('Indica el motivo');
  const user = await lockUser(ctx, userId);
  if (!active && user.roles.includes('ADMIN')) await assertAdminRemains(ctx, userId);
  await ctx.tx.query('UPDATE public.users SET active = $2, failed_logins = 0, locked_until = NULL WHERE id = $1', [userId, active]);
  const revoked = active ? 0 : await revokeAllSessions(ctx.tx, userId, 'usuario desactivado');
  await recordAction(ctx, active ? 'user.enable' : 'user.disable', 'user', userId, { reason, sessionsRevoked: revoked });
  return { id: userId, active };
}

/** Reinicia el segundo factor (teléfono perdido). El usuario debe enrolarse de nuevo. */
export async function resetMfa(ctx: Ctx, userId: string, reason: string) {
  authorize(ctx.actor, 'users.manage');
  if (!reason.trim()) throw invalid('Indica el motivo');
  await lockUser(ctx, userId);
  await ctx.tx.query(
    `UPDATE otc.mfa_factors SET secret_enc = 'REINICIADO', confirmed_at = NULL, last_used_step = NULL WHERE user_id = $1`,
    [userId],
  );
  const revoked = await revokeAllSessions(ctx.tx, userId, 'segundo factor reiniciado');
  await recordAction(ctx, 'user.mfa_reset', 'user', userId, { reason, sessionsRevoked: revoked, by: actorDbId(ctx.actor) });
  return { id: userId };
}
