import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { simulatedAdapters } from '../src/adapters/simulated.js';
import { migrate } from '../src/db/migrate.js';
import { createPool, type Db } from '../src/db/pool.js';
import { buildApp } from '../src/http/app.js';
import { seedDemo } from '../src/seed.js';

// Prueba de punta a punta contra una base PostgreSQL de pruebas (se borra al iniciar).
const DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://otc:otc@localhost:5432/otc_test';

let db: Db;
let app: ReturnType<typeof buildApp>;
const tokens: Record<string, string> = {};
const HASH = (n: number) => n.toString(16).padStart(64, 'a');

async function call(user: string, method: 'GET' | 'POST' | 'PUT' | 'PATCH', url: string, payload?: unknown, headers = {}) {
  const res = await app.inject({
    method,
    url,
    payload: payload as object,
    headers: { authorization: `Bearer ${tokens[user]}`, ...headers },
  });
  return { status: res.statusCode, body: res.json() };
}

beforeAll(async () => {
  db = createPool(DATABASE_URL);
  await db.query('DROP SCHEMA IF EXISTS otc CASCADE; DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate(db);
  await seedDemo(db, 'demo1234');
  app = buildApp({
    db,
    adapters: simulatedAdapters(),
    config: {
      mode: 'DEMO',
      port: 0,
      databaseUrl: DATABASE_URL,
      jwtSecret: 'x'.repeat(40),
      corsOrigin: '*',
      mfaKeyHex: '0'.repeat(64),
      cookieSecure: false,
    },
  });
  for (const u of ['admin', 'trader', 'tesorero2', 'auditor']) {
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: u, password: 'demo1234' } });
    tokens[u] = res.json().token;
  }
});

afterAll(async () => {
  await app.close();
  await db.end();
});

describe('flujo OTC en modo DEMO', () => {
  it('rechaza credenciales incorrectas y lo deja en auditoría', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'trader', password: 'mala' } });
    expect(res.statusCode).toBe(401);
    const audit = await call('auditor', 'GET', '/api/audit?limit=5');
    expect(audit.body.some((a: { action: string }) => a.action === 'auth.login_failed')).toBe(true);
  });

  it('no cotiza sin TRM del día', async () => {
    const r = await call('trader', 'POST', '/api/quotes', { counterpartyId: '1', side: 'SELL', network: 'TRON', usdtAmount: '100' });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('NO_TRM');
  });

  it('el auditor no puede cargar TRM', async () => {
    const r = await call('auditor', 'POST', '/api/trm', { rate: '4000.00' });
    expect(r.status).toBe(403);
  });

  it('venta pequeña: el trader opera solo de punta a punta', async () => {
    expect((await call('trader', 'POST', '/api/trm', { rate: '4000.00' })).status).toBe(200);

    const q = await call('trader', 'POST', '/api/quotes', { counterpartyId: '1', side: 'SELL', network: 'TRON', usdtAmount: '1000' });
    expect(q.status).toBe(200);
    expect(q.body.price_cop).toBe('4015.00');
    expect(q.body.total_cop).toBe('4015000');

    const order = await call('trader', 'POST', `/api/quotes/${q.body.id}/accept`, undefined, { 'idempotency-key': 'k1' });
    expect(order.status).toBe(200);
    expect(order.body.required_approvals).toBe(1);
    // Reintento con la misma clave: misma orden, sin duplicar
    const again = await call('trader', 'POST', `/api/quotes/${q.body.id}/accept`, undefined, { 'idempotency-key': 'k1' });
    expect(again.body.id).toBe(order.body.id);

    const oid = order.body.id;
    // No se puede aprobar antes del cobro
    expect((await call('trader', 'POST', `/api/orders/${oid}/approve`)).status).toBe(409);

    const inc = await call('trader', 'POST', `/api/orders/${oid}/incoming`, { reference: 'BCOL-0001' });
    expect(inc.body.order.status).toBe('PAYMENT_CONFIRMED');
    expect(inc.body.verification.simulated).toBe(true);

    const ap = await call('trader', 'POST', `/api/orders/${oid}/approve`);
    expect(ap.body.order.status).toBe('DELIVERY_APPROVED');

    const out = await call('trader', 'POST', `/api/orders/${oid}/outgoing`, { reference: HASH(1) });
    expect(out.body.order.status).toBe('DELIVERY_SENT');

    const done = await call('trader', 'POST', `/api/orders/${oid}/confirm`);
    expect(done.body.order.status).toBe('CLOSED');

    const bal = await call('admin', 'GET', '/api/ledger/balances');
    const by = Object.fromEntries(bal.body.map((b: { code: string; total: string }) => [b.code, b.total]));
    expect(by.BANK_COP).toBe('2004015000');
    expect(by.USDT_WALLET).toBe('249000');
  });

  it('compra grande: exige una segunda persona', async () => {
    const q = await call('trader', 'POST', '/api/quotes', { counterpartyId: '2', side: 'BUY', network: 'BSC', usdtAmount: '20000' });
    expect(q.body.price_cop).toBe('3955.00');
    expect(q.body.total_cop).toBe('79100000'); // supera el umbral demo de 50.000.000
    const order = await call('trader', 'POST', `/api/quotes/${q.body.id}/accept`);
    const oid = order.body.id;
    expect(order.body.required_approvals).toBe(2);

    await call('trader', 'POST', `/api/orders/${oid}/incoming`, { reference: HASH(2) });
    const first = await call('trader', 'POST', `/api/orders/${oid}/approve`);
    expect(first.body.pendingApprovals).toBe(1);
    const dup = await call('trader', 'POST', `/api/orders/${oid}/approve`);
    expect(dup.body.code).toBe('ALREADY_APPROVED');
    const second = await call('tesorero2', 'POST', `/api/orders/${oid}/approve`);
    expect(second.body.order.status).toBe('DELIVERY_APPROVED');
  });

  it('no acepta la misma referencia de pago dos veces', async () => {
    const q = await call('trader', 'POST', '/api/quotes', { counterpartyId: '1', side: 'SELL', network: 'TRON', usdtAmount: '10' });
    const order = await call('trader', 'POST', `/api/quotes/${q.body.id}/accept`);
    const r = await call('trader', 'POST', `/api/orders/${order.body.id}/incoming`, { reference: 'BCOL-0001' });
    expect(r.body.code).toBe('DUPLICATE_REFERENCE');
  });

  it('no cotiza a clientes sin KYC aprobado', async () => {
    const r = await call('trader', 'POST', '/api/quotes', { counterpartyId: '3', side: 'BUY', network: 'TRON', usdtAmount: '10' });
    expect(r.body.code).toBe('KYC');
  });

  it('respeta el límite por operación', async () => {
    const r = await call('trader', 'POST', '/api/quotes', { counterpartyId: '1', side: 'SELL', network: 'TRON', usdtAmount: '200000.000001' });
    expect(r.body.code).toBe('LIMIT');
  });

  it('solo el administrador cambia márgenes, y queda auditado', async () => {
    expect((await call('trader', 'PUT', '/api/settings', { sell_margin_cop: '20' })).status).toBe(403);
    const ok = await call('admin', 'PUT', '/api/settings', { sell_margin_cop: '20' });
    expect(ok.body.sell_margin_cop).toBe('20.00');
  });

  it('la cadena de auditoría está íntegra', async () => {
    const r = await call('auditor', 'GET', '/api/audit/verify');
    expect(r.body.ok).toBe(true);
    expect(r.body.checked).toBeGreaterThan(10);
  });

  it('la auditoría no se puede borrar ni editar', async () => {
    await expect(db.query('DELETE FROM audit_log')).rejects.toThrow(/solo-agregar/);
  });
});
