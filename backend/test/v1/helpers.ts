import { simulatedAdapters } from '../../src/adapters/simulated.js';
import { migrate } from '../../src/db/migrate.js';
import { createPool, type Db } from '../../src/db/pool.js';
import { buildApp } from '../../src/http/app.js';
import { sandboxIntegrations } from '../../src/integrations/sandbox.js';
import { DEFAULT_IDENTITY, type IdentityConfig } from '../../src/modules/identity/service.js';
import { totpAt } from '../../src/modules/identity/totp.js';
import type { Actor, Ctx, Role } from '../../src/platform/context.js';
import { inTransaction } from '../../src/platform/tx.js';
import { seedDemo } from '../../src/seed.js';
import { seedDemoV1 } from '../../src/seedV1.js';

// Base de pruebas con datos FICTICIOS. Se borra y se recrea al iniciar cada archivo de pruebas.
export const DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://otc:otc@localhost:5432/otc_test';
export const PASSWORD = 'demo1234';
export const MFA_KEY = Buffer.alloc(32, 7); // llave de prueba, no se usa fuera de las pruebas

/** Reloj controlable: las pruebas avanzan el tiempo sin esperar. */
export class TestClock {
  private t = Date.now();
  now = () => new Date(this.t);
  advance(seconds: number) {
    this.t += seconds * 1000;
  }
}

export interface Env {
  db: Db;
  clock: TestClock;
  identity: IdentityConfig;
  app: ReturnType<typeof buildApp>;
  close: () => Promise<void>;
}

export async function setupEnv(): Promise<Env> {
  const db = createPool(DATABASE_URL);
  await db.query('DROP SCHEMA IF EXISTS otc CASCADE; DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate(db);
  await seedDemo(db, PASSWORD);
  await seedDemoV1(db, PASSWORD);
  const clock = new TestClock();
  const identity: IdentityConfig = { ...DEFAULT_IDENTITY, mfaKey: MFA_KEY };
  const app = buildApp({
    db,
    adapters: simulatedAdapters(),
    config: {
      mode: 'DEMO',
      port: 0,
      databaseUrl: DATABASE_URL,
      jwtSecret: 'x'.repeat(40),
      corsOrigin: '*',
      mfaKeyHex: MFA_KEY.toString('hex'),
      cookieSecure: false,
    },
    v1: { db, integrations: sandboxIntegrations(db), identity, cookieSecure: false, mode: 'DEMO', now: clock.now, authRateLimit: 50 },
  });
  await app.ready();
  return {
    db,
    clock,
    identity,
    app,
    close: async () => {
      await app.close();
      await db.end();
    },
  };
}

export async function actorOf(db: Db, username: string): Promise<Actor> {
  const r = await db.query('SELECT id, username, roles FROM public.users WHERE username = $1', [username]);
  if (!r.rowCount) throw new Error(`No existe el usuario de prueba ${username}`);
  return { id: String(r.rows[0].id), username, roles: r.rows[0].roles as Role[] };
}

/** Ejecuta un caso de uso como un usuario, en su propia transacción (se confirma). */
export async function as<T>(env: Env, username: string, fn: (ctx: Ctx) => Promise<T>): Promise<T> {
  const actor = await actorOf(env.db, username);
  return inTransaction(env.db, (tx) => fn({ tx, actor, integrations: sandboxIntegrations(env.db), now: env.clock.now }));
}

/** Espera que una promesa falle con un código de error de dominio. */
export async function expectCode(p: Promise<unknown>, code: string) {
  try {
    await p;
  } catch (e) {
    const got = (e as { code?: string }).code;
    if (got !== code) throw new Error(`Se esperaba ${code} y llegó ${got}: ${(e as Error).message}`);
    return e;
  }
  throw new Error(`Se esperaba el error ${code} y no hubo error`);
}

// ---------- Cliente HTTP con sesión ----------

export interface Session {
  cookie: string;
  csrf: string;
}

const secrets = new Map<string, string>();

function cookieFrom(res: { headers: Record<string, unknown> }): string {
  const raw = res.headers['set-cookie'];
  const first = Array.isArray(raw) ? raw[0] : String(raw);
  return first.split(';')[0];
}

/** Inicia sesión por HTTP con contraseña y segundo factor (se enrola la primera vez). */
export async function httpLogin(env: Env, username: string, password = PASSWORD): Promise<Session> {
  const login = await env.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username, password } });
  if (login.statusCode !== 200) throw new Error(`Login falló: ${login.body}`);
  let session: Session = { cookie: cookieFrom(login), csrf: login.json().csrfToken };
  if (login.json().mfa === 'ENROLL') {
    const enroll = await env.app.inject({
      method: 'POST',
      url: '/api/v1/auth/mfa/enroll',
      headers: { cookie: session.cookie, 'x-csrf-token': session.csrf },
    });
    secrets.set(username, enroll.json().secret);
  }
  env.clock.advance(31); // cada código TOTP sirve una sola vez
  const verify = await env.app.inject({
    method: 'POST',
    url: '/api/v1/auth/mfa/verify',
    headers: { cookie: session.cookie, 'x-csrf-token': session.csrf },
    payload: { code: totpAt(secrets.get(username)!, env.clock.now()) },
  });
  if (verify.statusCode !== 200) throw new Error(`Segundo factor falló: ${verify.body}`);
  session = { cookie: cookieFrom(verify), csrf: verify.json().csrfToken };
  return session;
}

export const mfaSecretOf = (username: string) => secrets.get(username);

let keyCounter = 0;
export const newKey = () => `prueba-${Date.now()}-${++keyCounter}`;

export async function call(
  env: Env,
  s: Session | null,
  method: 'GET' | 'POST',
  url: string,
  payload?: unknown,
  extra: Record<string, string> = {},
) {
  const headers: Record<string, string> = { ...extra };
  if (s) {
    headers.cookie = s.cookie;
    headers['x-csrf-token'] = s.csrf;
  }
  const res = await env.app.inject({ method, url: `/api/v1${url}`, payload: payload as object, headers });
  return { status: res.statusCode, body: res.body ? res.json() : null, headers: res.headers };
}
