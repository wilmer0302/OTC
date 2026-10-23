import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { can, PERMISSIONS } from '../../src/modules/identity/permissions.js';
import { totpAt } from '../../src/modules/identity/totp.js';
import { as, call, expectCode, httpLogin, mfaSecretOf, newKey, PASSWORD, setupEnv, stepUp, type Env, type Session } from './helpers.js';

let env: Env;
beforeAll(async () => {
  env = await setupEnv();
});
afterAll(async () => env.close());

describe('matriz de permisos', () => {
  const actor = (...roles: string[]) => ({ id: '1', username: 'x', roles }) as never;

  it('sigue la especificación funcional', () => {
    expect(can(actor('OPERADOR'), 'quote.accept')).toBe(true);
    expect(can(actor('TESORERO'), 'quote.accept')).toBe(false);
    expect(can(actor('CUMPLIMIENTO'), 'kyc.decide')).toBe(true);
    expect(can(actor('ADMIN'), 'kyc.decide')).toBe(false);
    expect(can(actor('OPERADOR'), 'destination.decide')).toBe(false);
    expect(can(actor('AUDITOR'), 'audit.read')).toBe(true);
    expect(can(actor('OPERADOR'), 'audit.read')).toBe(false);
    expect(can(actor('OPERADOR', 'TESORERO'), 'transfer.manage')).toBe(true);
  });

  it('el auditor solo tiene permisos de lectura', () => {
    const auditorCan = Object.keys(PERMISSIONS).filter((p) => can(actor('AUDITOR'), p as never));
    expect(auditorCan.sort()).toEqual(['audit.read', 'read.operations']);
  });

  it('no existe ningún permiso para editar o borrar órdenes, asientos o auditoría', () => {
    for (const p of Object.keys(PERMISSIONS)) expect(p).not.toMatch(/delete|edit|remove/);
  });
});

describe('inicio de sesión y segundo factor', () => {
  it('rechaza una contraseña incorrecta y lo deja en la auditoría', async () => {
    const r = await call(env, null, 'POST', '/auth/login', { username: 'trader', password: 'mala' });
    expect(r.status).toBe(401);
    expect(r.body.code).toBe('BAD_CREDENTIALS');
    const audit = await env.db.query(`SELECT 1 FROM audit_log WHERE action = 'auth.login_failed'`);
    expect(audit.rowCount).toBeGreaterThan(0);
  });

  it('bloquea al usuario tras 5 intentos fallidos, aunque luego ponga la clave correcta', async () => {
    for (let i = 0; i < 5; i++) await call(env, null, 'POST', '/auth/login', { username: 'tesorero2', password: 'mala' });
    const r = await call(env, null, 'POST', '/auth/login', { username: 'tesorero2', password: PASSWORD });
    expect(r.status).toBe(401);
    env.clock.advance(16 * 60);
    const ok = await call(env, null, 'POST', '/auth/login', { username: 'tesorero2', password: PASSWORD });
    expect(ok.status).toBe(200);
  });

  it('sin segundo factor la sesión no sirve para operar', async () => {
    const login = await call(env, null, 'POST', '/auth/login', { username: 'trader', password: PASSWORD });
    expect(login.body.mfa).toBe('ENROLL');
    expect(login.headers['set-cookie']).toMatch(/HttpOnly/);
    expect(login.headers['set-cookie']).toMatch(/SameSite=Strict/);
    const cookie = String(login.headers['set-cookie']).split(';')[0];
    const res = await env.app.inject({ method: 'GET', url: '/api/v1/users', headers: { cookie } });
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe('MFA_REQUIRED');
  });

  it('enrola el segundo factor, rota la sesión y no acepta el mismo código dos veces', async () => {
    const s = await httpLogin(env, 'admin');
    const me = await call(env, s, 'GET', '/me');
    expect(me.body.mfaVerified).toBe(true);
    expect(me.body.permissions).toContain('users.manage');

    // Nueva sesión: el código del mismo paso ya se usó.
    const login = await call(env, null, 'POST', '/auth/login', { username: 'admin', password: PASSWORD });
    expect(login.body.mfa).toBe('REQUIRED');
    const pending = { cookie: String(login.headers['set-cookie']).split(';')[0], csrf: login.body.csrfToken };
    const code = totpAt(mfaSecretOf('admin')!, env.clock.now());
    const reused = await call(env, pending, 'POST', '/auth/mfa/verify', { code });
    expect(reused.status).toBe(401);
    expect(reused.body.code).toBe('BAD_MFA_CODE');
  });

  it('la contraseña de la demo (bcrypt) pasa a Argon2id y el login de la demo sigue funcionando', async () => {
    const r = await env.db.query(`SELECT password_hash FROM public.users WHERE username = 'admin'`);
    expect(r.rows[0].password_hash).toMatch(/^\$argon2id\$/);
    const legacy = await env.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: PASSWORD } });
    expect(legacy.statusCode).toBe(200);
  });

  it('la sesión vence tras 15 minutos sin actividad', async () => {
    const s = await httpLogin(env, 'auditor');
    expect((await call(env, s, 'GET', '/me')).status).toBe(200);
    env.clock.advance(16 * 60);
    const r = await call(env, s, 'GET', '/me');
    expect(r.status).toBe(401);
  });

  it('cerrar sesión la revoca', async () => {
    const s = await httpLogin(env, 'auditor');
    expect((await call(env, s, 'POST', '/auth/logout')).status).toBe(200);
    expect((await call(env, s, 'GET', '/me')).status).toBe(401);
  });
});

describe('protección de las solicitudes', () => {
  let admin: Session;
  beforeAll(async () => {
    admin = await httpLogin(env, 'admin');
  });

  it('exige el token anti-CSRF en toda escritura', async () => {
    const r = await env.app.inject({
      method: 'POST',
      url: '/api/v1/users/1/disable',
      headers: { cookie: admin.cookie },
      payload: { reason: 'prueba' },
    });
    expect(r.statusCode).toBe(403);
    expect(r.json().code).toBe('CSRF');
  });

  it('valida el cuerpo de forma estricta (campos desconocidos se rechazan)', async () => {
    const r = await call(
      env,
      admin,
      'POST',
      '/users',
      { username: 'nuevo', fullName: 'Nuevo', password: 'x'.repeat(12), roles: ['OPERADOR'], esAdmin: true },
      { 'idempotency-key': newKey() },
    );
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('INVALID');
  });

  it('exige la clave de idempotencia y repite la respuesta sin duplicar', async () => {
    const body = { username: 'operador2', fullName: 'Operador dos (demo)', password: 'clave-larga-demo', roles: ['OPERADOR'] };
    expect((await call(env, admin, 'POST', '/users', body)).body.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    const key = newKey();
    // Crear usuarios pide otra vez el segundo factor: sin código, o con uno ya usado, no pasa.
    const noCode = await call(env, admin, 'POST', '/users', body, { 'idempotency-key': newKey() });
    expect([noCode.status, noCode.body.code]).toEqual([401, 'STEP_UP_REQUIRED']);
    const code = stepUp(env, 'admin');
    const first = await call(env, admin, 'POST', '/users', body, { 'idempotency-key': key, ...code });
    const reused = await call(env, admin, 'POST', '/users', { ...body, username: 'operador3' }, { 'idempotency-key': newKey(), ...code });
    expect([reused.status, reused.body.code]).toEqual([401, 'STEP_UP_FAILED']);
    const again = await call(env, admin, 'POST', '/users', body, { 'idempotency-key': key });
    expect(first.status).toBe(201);
    expect(again.status).toBe(201);
    expect(again.headers['idempotent-replay']).toBe('true');
    expect(again.body.id).toBe(first.body.id);
    const n = await env.db.query(`SELECT count(*)::int AS n FROM public.users WHERE username = 'operador2'`);
    expect(n.rows[0].n).toBe(1);
  });

  it('un rol sin permiso recibe 403 en el servidor', async () => {
    const auditor = await httpLogin(env, 'auditor');
    const r = await call(env, auditor, 'POST', '/users/1/disable', { reason: 'intento' });
    expect(r.status).toBe(403);
    expect((await call(env, auditor, 'GET', '/users')).status).toBe(403);
  });

  it('limita los intentos de inicio de sesión por IP', async () => {
    let last = 0;
    for (let i = 0; i < 51; i++) {
      const r = await env.app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        remoteAddress: '10.9.9.9',
        payload: { username: 'nadie', password: 'x' },
      });
      last = r.statusCode;
    }
    expect(last).toBe(429);
  });

  it('nunca devuelve huellas de contraseña ni secretos', async () => {
    const r = await call(env, admin, 'GET', '/users');
    const text = JSON.stringify(r.body);
    expect(text).not.toMatch(/password|argon2|secret|token/i);
  });
});

describe('administración de usuarios', () => {
  it('cambiar roles o desactivar revoca las sesiones abiertas', async () => {
    const op = await httpLogin(env, 'operador2', 'clave-larga-demo');
    expect((await call(env, op, 'GET', '/me')).status).toBe(200);
    const id = (await env.db.query(`SELECT id FROM public.users WHERE username = 'operador2'`)).rows[0].id;
    await as(env, 'admin', async (ctx) => {
      const { setRoles } = await import('../../src/modules/identity/service.js');
      await setRoles(ctx, id, ['OPERADOR', 'TESORERO']);
    });
    expect((await call(env, op, 'GET', '/me')).status).toBe(401);
  });

  it('no deja el sistema sin administradores', async () => {
    const { setActive } = await import('../../src/modules/identity/service.js');
    const ids = (await env.db.query(`SELECT id FROM public.users WHERE 'ADMIN' = ANY(roles)`)).rows.map((r) => r.id);
    await as(env, 'admin', (ctx) => setActive(ctx, ids[1], false, 'prueba'));
    await expectCode(as(env, 'admin', (ctx) => setActive(ctx, ids[0], false, 'prueba')), 'LAST_ADMIN');
    await as(env, 'admin', (ctx) => setActive(ctx, ids[1], true, 'prueba'));
  });

  it('exige contraseñas de al menos 12 caracteres', async () => {
    const { createUser } = await import('../../src/modules/identity/service.js');
    await expectCode(
      as(env, 'admin', (ctx) => createUser(ctx, { username: 'corta', fullName: 'Corta', password: 'corta', roles: ['AUDITOR'] })),
      'INVALID',
    );
  });

  it('los parámetros de la mesa cambian por versiones con motivo', async () => {
    const admin = await httpLogin(env, 'admin');
    const before = await call(env, admin, 'GET', '/settings');
    expect(before.body.payment_window_seconds).toBe(480);
    const r = await call(env, admin, 'POST', '/settings', { reason: 'prueba', payment_window_seconds: 600 }, { 'idempotency-key': newKey(), ...stepUp(env, 'admin') });
    expect(r.body.payment_window_seconds).toBe(600);
    const versions = await env.db.query('SELECT count(*)::int AS n FROM otc.desk_settings');
    expect(versions.rows[0].n).toBe(2);
    await call(env, admin, 'POST', '/settings', { reason: 'volver', payment_window_seconds: 480 }, { 'idempotency-key': newKey(), ...stepUp(env, 'admin') });
  });
});
