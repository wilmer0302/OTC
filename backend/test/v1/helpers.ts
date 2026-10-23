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

// ---------- Órdenes de prueba ----------

/**
 * Inserta una solicitud, una cotización y una orden FICTICIAS directamente en la base, sin reservar
 * liquidez, para probar piezas que necesitan una orden existente (reservas, asientos).
 * Los flujos reales se prueban por el servicio de cotizaciones.
 */
export async function fixtureOrder(env: Env, opts: { side?: 'BUY' | 'SELL'; usdt?: string } = {}): Promise<string> {
  const side = opts.side ?? 'SELL';
  const usdt = opts.usdt ?? '1000';
  const q = (sql: string, p: unknown[] = []) => env.db.query(sql, p);
  const cp = (await q(`SELECT id FROM otc.counterparties WHERE document_number = '900000001'`)).rows[0].id;
  const dest = (await q(`SELECT id FROM otc.destinations WHERE counterparty_id = $1 AND rail = $2 AND status = 'APROBADO'`, [cp, side === 'SELL' ? 'TRON' : 'BANK'])).rows[0].id;
  let trm = (await q(`SELECT id FROM otc.trm_rates WHERE source = 'Fixture de prueba'`)).rows[0]?.id;
  if (!trm) {
    trm = (await q(`INSERT INTO otc.trm_rates (valid_date, rate, source, simulated) VALUES ('2000-01-01', 4000, 'Fixture de prueba', true) RETURNING id`)).rows[0].id;
  }
  const rule = (await q('SELECT id FROM otc.pricing_rules ORDER BY seq LIMIT 1')).rows[0].id;
  const now = env.clock.now();
  const req = (
    await q(
      `INSERT INTO otc.requests (counterparty_id, side, usdt_amount, network, destination_id, status, expires_at, created_at, updated_at)
       VALUES ($1,$2,$3,'TRON',$4,'COTIZADA',$5,$5,$5) RETURNING id`,
      [cp, side, usdt, dest, now],
    )
  ).rows[0].id;
  const quote = (
    await q(
      `INSERT INTO otc.quotes (request_id, side, usdt_amount, trm_id, trm_rate, rule_id, margin_cop, commission_rate, base_price_cop,
         unit_price_cop, subtotal_cop, commission_cop, total_cop, margin_total_cop, status, expires_at, created_at, updated_at)
       VALUES ($1,$2,$3,$4,4000,$5,15,0.001,4015,4019.02,4015*$3::numeric,4.02*$3::numeric,4019.02*$3::numeric,15*$3::numeric,'VIGENTE',$6,$6,$6)
       RETURNING id`,
      [req, side, usdt, trm, rule, now],
    )
  ).rows[0].id;
  const accounts = (await q(`SELECT code, id FROM otc.accounts WHERE code IN ('BANCOLOMBIA_COP_DEMO','WALLET_TRON_DEMO')`)).rows;
  const id = (c: string) => accounts.find((a) => a.code === c)!.id;
  const [receive, deliver] = side === 'SELL' ? [id('BANCOLOMBIA_COP_DEMO'), id('WALLET_TRON_DEMO')] : [id('WALLET_TRON_DEMO'), id('BANCOLOMBIA_COP_DEMO')];
  return (
    await q(
      `INSERT INTO otc.orders (quote_id, request_id, counterparty_id, side, network, usdt_amount, unit_price_cop, base_price_cop, subtotal_cop,
         commission_cop, total_cop, margin_total_cop, receive_account_id, deliver_account_id, destination_id, approval_policy,
         required_approvals, status, payment_deadline, created_at, updated_at)
       SELECT id, request_id, $2, side, 'TRON', usdt_amount, unit_price_cop, base_price_cop, round(subtotal_cop), round(commission_cop),
              round(total_cop), round(margin_total_cop), $3, $4, $5, '{"policy":"SINGLE"}', 1, 'CREADA', $6, $6, $6
       FROM otc.quotes WHERE id = $1 RETURNING id`,
      [quote, cp, receive, deliver, dest, now],
    )
  ).rows[0].id;
}

/** Transferencia de entrega FICTICIA de una orden, autorizada, para probar el bloqueo de reservas. */
export async function fixtureTransfer(env: Env, orderId: string): Promise<string> {
  const r = await env.db.query(
    `INSERT INTO otc.transfers (order_id, purpose, direction, rail, asset, amount, account_id, destination_id, status, created_at, updated_at)
     SELECT o.id, 'ENTREGA', 'OUT', CASE WHEN o.side = 'SELL' THEN o.network ELSE 'BANK' END, a.asset,
            CASE WHEN o.side = 'SELL' THEN o.usdt_amount ELSE o.total_cop END, o.deliver_account_id, o.destination_id, 'AUTORIZADA', $2, $2
     FROM otc.orders o JOIN otc.accounts a ON a.id = o.deliver_account_id WHERE o.id = $1 RETURNING id`,
    [orderId, env.clock.now()],
  );
  return r.rows[0].id;
}

/** Cabecera de confirmación reforzada: un código del segundo factor nuevo (avanza el reloj un paso). */
export function stepUp(env: Env, username: string): Record<string, string> {
  env.clock.advance(30);
  return { 'x-mfa-code': totpAt(secrets.get(username)!, env.clock.now()) };
}

/** Ejecuta como el actor del sistema (trabajador), en su propia transacción. */
export async function asSystem<T>(env: Env, fn: (ctx: Ctx) => Promise<T>): Promise<T> {
  const { SYSTEM_ACTOR } = await import('../../src/platform/context.js');
  return inTransaction(env.db, (tx) => fn({ tx, actor: SYSTEM_ACTOR, integrations: sandboxIntegrations(env.db), now: env.clock.now }));
}

/** Revisa una transferencia como lo haría el trabajador (consulta la red o el banco sandbox). */
export async function checkNow(env: Env, transferId: string) {
  const { checkTransfer } = await import('../../src/modules/confirmations/service.js');
  const { SYSTEM_ACTOR } = await import('../../src/platform/context.js');
  return checkTransfer({ db: env.db, integrations: sandboxIntegrations(env.db), now: env.clock.now, actor: SYSTEM_ACTOR }, transferId);
}

/** Simula en el sandbox que el banco o la red confirmaron el cobro de la orden y lo revisa. */
export async function confirmCollection(env: Env, orderId: string) {
  const { simulateFor } = await import('../../src/modules/sandbox/service.js');
  const t = await env.db.query(`SELECT id, rail FROM otc.transfers WHERE order_id = $1 AND purpose = 'COBRO' AND status <> 'FALLIDA'`, [orderId]);
  const { id, rail } = t.rows[0];
  await as(env, 'admin', (ctx) => simulateFor(ctx, id, rail === 'BANK' ? { status: 'SETTLED' } : { status: 'SUCCESS', confirmations: 100 }));
  return checkNow(env, id);
}
