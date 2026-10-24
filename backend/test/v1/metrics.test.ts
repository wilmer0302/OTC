import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { recordTrm } from '../../src/modules/pricing/service.js';
import { as, call, httpLogin, newKey, setupEnv, type Env } from './helpers.js';

// Lecturas que alimentan la consola web: métricas de inicio y bandejas. Datos FICTICIOS.
describe('métricas y bandejas de la consola', () => {
  let env: Env;
  let andina: string;

  beforeAll(async () => {
    env = await setupEnv();
    andina = (await env.db.query(`SELECT id FROM otc.counterparties WHERE document_number = '900000001'`)).rows[0].id;
  });
  afterAll(async () => env.close());

  it('el modo del sistema es público para mostrar la etiqueta de datos simulados antes de entrar', async () => {
    const r = await call(env, null, 'GET', '/system');
    expect(r.body).toEqual({ mode: 'DEMO', sandbox: { chain: true, bank: true, networks: { TRON: true, BSC: true } } });
  });

  it('sin TRM el inicio lo dice; los saldos salen del libro y las colas cuentan lo pendiente', async () => {
    const trader = await httpLogin(env, 'trader');
    const r = await call(env, trader, 'GET', '/dashboard');
    expect(r.status).toBe(200);
    expect(r.body.trm).toBeNull();
    expect(r.body.liquidity).toEqual([
      { asset: 'COP', accounts: 1, balance: '2000000000', reserved: '0', available: '2000000000' },
      { asset: 'USDT', accounts: 3, balance: '300000', reserved: '0', available: '300000' },
    ]);
    expect(r.body.attention.kycPending).toBe(1);
    expect((await call(env, null, 'GET', '/dashboard')).status).toBe(401);
  });

  it('cotizaciones: la bandeja lista cada cotización con su solicitud, cliente y orden', async () => {
    await as(env, 'trader', (ctx) => recordTrm(ctx, { rate: '4000' }));
    const trader = await httpLogin(env, 'trader');
    const req = await call(env, trader, 'POST', '/requests', { counterpartyId: andina, side: 'SELL', usdtAmount: '1000', network: 'TRON' }, { 'idempotency-key': newKey() });
    const quote = await call(env, trader, 'POST', `/requests/${req.body.id}/quotes`, {}, { 'idempotency-key': newKey() });
    await call(env, trader, 'POST', `/quotes/${quote.body.quote.id}/accept`, {}, { 'idempotency-key': newKey() });

    const list = await call(env, trader, 'GET', '/quotes');
    expect(list.body).toHaveLength(1);
    expect(list.body[0]).toMatchObject({ status: 'ACEPTADA', counterparty_name: 'Comercializadora Andina SAS (ficticio)', network: 'TRON' });
    expect(list.body[0].order_number).toBeTruthy();
    expect((await call(env, trader, 'GET', '/quotes?status=VIGENTE')).body).toHaveLength(0);

    const dash = await call(env, trader, 'GET', '/dashboard');
    expect(dash.body.trm.rate).toBe('4000.00');
    expect(dash.body.counts.orders).toEqual({ CREADA: 1 });
    expect(dash.body.liquidity[1].reserved).toBe('1000');
  });

  it('el margen del día solo lo ve quien administra precios o audita', async () => {
    await env.db.query(`UPDATE otc.orders SET status = 'COMPLETADA'`); // atajo de prueba sobre datos ficticios
    const trader = await httpLogin(env, 'trader');
    const admin = await httpLogin(env, 'admin');
    const t = (await call(env, trader, 'GET', '/dashboard')).body.completedToday[0];
    const a = (await call(env, admin, 'GET', '/dashboard')).body.completedToday[0];
    expect(t).toMatchObject({ side: 'SELL', orders: 1, usdt: '1000', margin: null });
    expect(a.margin).toBe('15000');
  });

  it('transferencias: filtro por red y búsqueda por número de orden o referencia', async () => {
    const trader = await httpLogin(env, 'trader');
    const order = (await env.db.query('SELECT id, number FROM otc.orders')).rows[0];
    await env.db.query(
      `INSERT INTO otc.transfers (order_id, purpose, direction, rail, asset, amount, account_id, status, external_ref, created_at, updated_at)
       SELECT id, 'COBRO', 'IN', 'BANK', 'COP', total_cop, receive_account_id, 'ENVIADA', 'REF-PRUEBA-1', now(), now() FROM otc.orders WHERE id = $1`,
      [order.id],
    );
    expect((await call(env, trader, 'GET', '/transfers?rail=TRON')).body).toHaveLength(0);
    expect((await call(env, trader, 'GET', '/transfers?rail=BANK')).body).toHaveLength(1);
    expect((await call(env, trader, 'GET', `/transfers?search=${order.number}`)).body).toHaveLength(1);
    expect((await call(env, trader, 'GET', '/transfers?search=ref-prueba')).body).toHaveLength(1);
    expect((await call(env, trader, 'GET', '/transfers?search=OTRA')).body).toHaveLength(0);
  });

  it('destinos propuestos: bandeja de Cumplimiento, enmascarada para quien no gestiona destinos', async () => {
    const trader = await httpLogin(env, 'trader');
    await call(
      env,
      trader,
      'POST',
      `/counterparties/${andina}/destinations`,
      { rail: 'BANK', value: '1000000099', bankName: 'Bancolombia', accountType: 'AHORROS', label: 'Cuenta nueva (ficticia)' },
      { 'idempotency-key': newKey() },
    );
    const compliance = await httpLogin(env, 'cumplimiento');
    const auditor = await httpLogin(env, 'auditor');
    const full = (await call(env, compliance, 'GET', '/destinations?status=PROPUESTO')).body;
    expect(full).toHaveLength(1);
    expect(full[0]).toMatchObject({ value: '1000000099', counterparty_name: 'Comercializadora Andina SAS (ficticio)' });
    expect((await call(env, auditor, 'GET', '/destinations?status=PROPUESTO')).body[0].value).not.toBe('1000000099');
    expect((await call(env, compliance, 'GET', '/dashboard')).body.attention.destinationsProposed).toBe(1);
  });
});
