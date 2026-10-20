import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { DomainError } from '../../domain/errors.js';
import { randomToken, sha256 } from '../../platform/crypto.js';
import { getDeskSettings, updateDeskSettings } from '../../platform/deskSettings.js';
import { inTransaction } from '../../platform/tx.js';
import { SESSION_COOKIE, type Kit, type V1Deps } from '../../http/v1/kit.js';
import { ROLES } from './permissions.js';
import { PERMISSIONS } from './permissions.js';
import {
  createUser,
  listUsers,
  login,
  logout,
  resetMfa,
  setActive,
  setRoles,
  startMfaEnrollment,
  verifyMfa,
  type SessionTokens,
} from './service.js';

const id = z.object({ id: z.string().regex(/^\d+$/) });
const reason = z.strictObject({ reason: z.string().trim().min(3).max(500) });
const roleList = z.array(z.enum(ROLES as [string, ...string[]])).min(1).max(5);

export function identityRoutes(app: FastifyInstance, kit: Kit, deps: V1Deps) {
  const setCookie = (reply: FastifyReply, tokens: SessionTokens) =>
    reply.setCookie(SESSION_COOKIE, tokens.token, {
      httpOnly: true,
      secure: deps.cookieSecure,
      sameSite: 'strict',
      path: '/api/v1',
      maxAge: deps.identity.sessionMaxSeconds,
    });
  const meta = (req: FastifyRequest) => ({ ip: req.ip, userAgent: req.headers['user-agent'] });

  app.post(
    '/auth/login',
    { config: { rateLimit: { max: deps.authRateLimit ?? 10, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const body = z
        .strictObject({ username: z.string().trim().min(1).max(40), password: z.string().min(1).max(200) })
        .parse(req.body);
      const result = await inTransaction(deps.db, (tx) => login(tx, deps.identity, { ...body, ...meta(req) }, deps.now()));
      if (!result) throw new DomainError('BAD_CREDENTIALS', 'Usuario o contraseña incorrectos, o usuario bloqueado', 401);
      setCookie(reply, result);
      return { user: result.user, mfa: result.mfa, csrfToken: result.csrfToken };
    },
  );

  app.post(
    '/auth/mfa/enroll',
    { config: { rateLimit: { max: deps.authRateLimit ?? 10, timeWindow: '1 minute' } } },
    async (req) => {
      const resolved = await kit.session(req, { allowPendingMfa: true });
      return inTransaction(deps.db, (tx) => startMfaEnrollment(tx, deps.identity, resolved));
    },
  );

  app.post(
    '/auth/mfa/verify',
    { config: { rateLimit: { max: deps.authRateLimit ?? 10, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const resolved = await kit.session(req, { allowPendingMfa: true });
      const { code } = z.strictObject({ code: z.string().regex(/^\d{6}$/, 'El código tiene 6 dígitos') }).parse(req.body);
      const tokens = await inTransaction(deps.db, (tx) => verifyMfa(tx, deps.identity, resolved, code, deps.now(), meta(req)));
      if (!tokens) throw new DomainError('BAD_MFA_CODE', 'Código incorrecto o ya usado', 401);
      setCookie(reply, tokens);
      return { csrfToken: tokens.csrfToken, user: resolved.actor };
    },
  );

  app.post('/auth/logout', async (req, reply) => {
    const resolved = await kit.session(req, { allowPendingMfa: true });
    await inTransaction(deps.db, (tx) => logout(tx, resolved.session.id, resolved.actor.id));
    reply.clearCookie(SESSION_COOKIE, { path: '/api/v1' });
    return { ok: true };
  });

  // El token anti-CSRF solo se guarda como huella: tras recargar la página se emite uno nuevo.
  app.get('/auth/csrf', async (req) => {
    const resolved = await kit.session(req, { allowPendingMfa: true });
    const csrfToken = randomToken();
    await deps.db.query('UPDATE otc.sessions SET csrf_hash = $2 WHERE id = $1', [resolved.session.id, sha256(csrfToken)]);
    return { csrfToken };
  });

  app.get('/me', async (req) => {
    const { actor, session } = await kit.session(req, { allowPendingMfa: true });
    const permissions = Object.entries(PERMISSIONS)
      .filter(([, roles]) => actor.roles.some((r) => (roles as readonly string[]).includes(r)))
      .map(([p]) => p);
    return { user: actor, mfaVerified: session.mfa_verified, permissions, mode: deps.mode };
  });

  // ---- Usuarios ----
  kit.get('/users', 'users.manage', null, (ctx) => listUsers(ctx));

  kit.post(
    '/users',
    {
      permission: 'users.manage',
      idempotent: true,
      status: 201,
      body: z.strictObject({
        username: z.string().trim().min(3).max(40),
        fullName: z.string().trim().min(3).max(120),
        password: z.string().min(12).max(200),
        roles: roleList,
      }),
    },
    (ctx, body) => createUser(ctx, body),
  );

  kit.post(
    '/users/:id/roles',
    { permission: 'users.manage', body: z.strictObject({ roles: roleList }) },
    (ctx, body, req) => setRoles(ctx, id.parse(req.params).id, body.roles),
  );
  kit.post('/users/:id/disable', { permission: 'users.manage', body: reason }, (ctx, body, req) =>
    setActive(ctx, id.parse(req.params).id, false, body.reason),
  );
  kit.post('/users/:id/enable', { permission: 'users.manage', body: reason }, (ctx, body, req) =>
    setActive(ctx, id.parse(req.params).id, true, body.reason),
  );
  kit.post('/users/:id/mfa-reset', { permission: 'users.manage', body: reason }, (ctx, body, req) =>
    resetMfa(ctx, id.parse(req.params).id, body.reason),
  );

  // ---- Parámetros de la mesa ----
  kit.get('/settings', 'read.operations', null, (ctx) => getDeskSettings(ctx));
  const seconds = (min: number, max: number) => z.number().int().min(min).max(max);
  kit.post(
    '/settings',
    {
      permission: 'settings.manage',
      idempotent: true,
      body: z.strictObject({
        reason: z.string().trim().min(3).max(500),
        quote_ttl_seconds: seconds(10, 3600).optional(),
        payment_window_seconds: seconds(60, 86400).optional(),
        request_ttl_seconds: seconds(60, 86400).optional(),
        price_move_threshold_bps: seconds(1, 10000).optional(),
        tron_confirmations: seconds(1, 1000).optional(),
        bsc_confirmations: seconds(1, 1000).optional(),
        transfer_pending_seconds: seconds(60, 604800).optional(),
        transfer_review_seconds: seconds(60, 604800).optional(),
      }),
    },
    (ctx, { reason: why, ...patch }) => updateDeskSettings(ctx, patch, why),
  );
}
