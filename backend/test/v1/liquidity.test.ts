import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertBalanced, availableOf, reservationCanMove } from '../../src/modules/liquidity/domain.js';
import {
  accountByCode,
  consumeReservation,
  createLiquidityAccount,
  defaultAccount,
  lockReservation,
  openingBalance,
  postEntry,
  releaseReservation,
  reserve,
  reverseEntry,
  unlockReservation,
  verifyBalances,
} from '../../src/modules/liquidity/service.js';
import { D } from '../../src/platform/money.js';
import { as, call, expectCode, fixtureOrder, httpLogin, newKey, setupEnv, type Env } from './helpers.js';

describe('reglas del libro y de las reservas', () => {
  it('un asiento cuadra por activo y necesita dos líneas', () => {
    expect(() => assertBalanced([{ asset: 'COP', amount: new D(100) }, { asset: 'COP', amount: new D(-100) }])).not.toThrow();
    expect(() => assertBalanced([{ asset: 'COP', amount: new D(100) }])).toThrow(/dos líneas/);
    expect(() => assertBalanced([{ asset: 'COP', amount: new D(100) }, { asset: 'USDT', amount: new D(-100) }])).toThrow(/descuadrado/);
    expect(() => assertBalanced([{ asset: 'COP', amount: new D('0.5') }, { asset: 'COP', amount: new D('-0.5') }])).toThrow(/enteros/);
    expect(() => assertBalanced([{ asset: 'USDT', amount: new D('1.0000001') }, { asset: 'USDT', amount: new D('-1.0000001') }])).toThrow(
      /6 decimales/,
    );
  });

  it('las reservas solo avanzan por los caminos permitidos', () => {
    expect(reservationCanMove('ACTIVE', 'LOCKED')).toBe(true);
    expect(reservationCanMove('LOCKED', 'ACTIVE')).toBe(true);
    expect(reservationCanMove('ACTIVE', 'CONSUMED')).toBe(false); // se consume solo con una transferencia atada
    expect(reservationCanMove('RELEASED', 'ACTIVE')).toBe(false);
    expect(availableOf(new D(100), new D(30)).toFixed()).toBe('70');
  });
});

describe('saldos, libro y reservas', () => {
  let env: Env;
  beforeAll(async () => {
    env = await setupEnv();
  });
  afterAll(async () => env.close());

  it('la demo arranca con cuentas ficticias, saldos de apertura y el libro cuadrado', async () => {
    const tron = await defaultAccount(env.db, 'USDT', 'TRON');
    expect(tron.code).toBe('WALLET_TRON_DEMO');
    expect(tron.balance).toBe('150000.000000');
    expect((await accountByCode(env.db, 'EQUITY_USDT')).balance).toBe('-300000.000000');
    expect((await defaultAccount(env.db, 'COP', null)).code).toBe('BANCOLOMBIA_COP_DEMO');
    expect(await verifyBalances(env.db)).toEqual({ ok: true, mismatches: [] });
  });

  it('la base rechaza un asiento descuadrado aunque se salte el servicio', async () => {
    const bank = await accountByCode(env.db, 'BANCOLOMBIA_COP_DEMO');
    const client = await env.db.connect();
    try {
      await client.query('BEGIN');
      const e = await client.query(`INSERT INTO otc.journal_entries (kind, description) VALUES ('NORMAL','prueba') RETURNING id`);
      await client.query('INSERT INTO otc.journal_lines (entry_id, account_id, amount) VALUES ($1,$2,1000)', [e.rows[0].id, bank.id]);
      await expect(client.query('COMMIT')).rejects.toThrow(/descuadrado/);
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
    expect((await accountByCode(env.db, 'BANCOLOMBIA_COP_DEMO')).balance).toBe(bank.balance);
  });

  it('la base no deja una cuenta real en negativo ni cambiar o borrar el libro', async () => {
    const bank = await accountByCode(env.db, 'BANCOLOMBIA_COP_DEMO');
    const trading = await accountByCode(env.db, 'TRADING_COP');
    await expectCode(
      as(env, 'admin', (ctx) =>
        postEntry(ctx, {
          kind: 'NORMAL',
          description: 'Salida mayor que el saldo',
          lines: [
            { accountId: bank.id, amount: new D('-2000000001') },
            { accountId: trading.id, amount: new D('2000000001') },
          ],
        }),
      ),
      'NEGATIVE_BALANCE',
    );
    await expect(env.db.query(`UPDATE otc.accounts SET balance = -1 WHERE id = $1`, [bank.id])).rejects.toThrow(/check/);
    await expect(env.db.query('UPDATE otc.journal_lines SET amount = amount * 2')).rejects.toThrow();
    await expect(env.db.query('DELETE FROM otc.journal_entries')).rejects.toThrow();
  });

  it('un asiento se revierte una sola vez y el saldo vuelve a su valor', async () => {
    const bank = await accountByCode(env.db, 'BANCOLOMBIA_COP_DEMO');
    const trading = await accountByCode(env.db, 'TRADING_COP');
    const entry = await as(env, 'tesorero2', (ctx) =>
      postEntry(ctx, {
        kind: 'NORMAL',
        description: 'Pago ficticio a cliente',
        lines: [
          { accountId: bank.id, amount: new D(-1000000) },
          { accountId: trading.id, amount: new D(1000000) },
        ],
      }),
    );
    expect((await accountByCode(env.db, 'BANCOLOMBIA_COP_DEMO')).balance).toBe(new D(bank.balance).minus(1000000).toFixed(6));
    const rev = await as(env, 'tesorero2', (ctx) => reverseEntry(ctx, entry, 'Se registró dos veces'));
    expect((await accountByCode(env.db, 'BANCOLOMBIA_COP_DEMO')).balance).toBe(bank.balance);
    await expectCode(as(env, 'tesorero2', (ctx) => reverseEntry(ctx, entry, 'otra vez')), 'ALREADY_REVERSED');
    await expectCode(as(env, 'tesorero2', (ctx) => reverseEntry(ctx, rev, 'reverso del reverso')), 'INVALID_STATE');
    expect((await verifyBalances(env.db)).ok).toBe(true);
  });

  it('reserva lo disponible y explica cuando no alcanza', async () => {
    const bsc = await defaultAccount(env.db, 'USDT', 'BSC');
    const order = await fixtureOrder(env);
    const id = await as(env, 'trader', (ctx) => reserve(ctx, { accountId: bsc.id, orderId: order, amount: new D(60000), reason: 'Orden ficticia' }));
    const other = await fixtureOrder(env);
    const err = await expectCode(
      as(env, 'trader', (ctx) => reserve(ctx, { accountId: bsc.id, orderId: other, amount: new D('40000.000001'), reason: 'Orden ficticia' })),
      'INSUFFICIENT_LIQUIDITY',
    );
    expect((err as Error).message).toBe(
      'Liquidez insuficiente en Billetera BSC (demo): disponible 40000, reservado 60000, se necesitan 40000.000001',
    );
    // Una orden tiene una sola reserva abierta.
    await expect(as(env, 'trader', (ctx) => reserve(ctx, { accountId: bsc.id, orderId: order, amount: new D(1), reason: 'otra' }))).rejects.toThrow();
    await as(env, 'trader', (ctx) => releaseReservation(ctx, id, 'Orden vencida'));
    await expectCode(as(env, 'trader', (ctx) => lockReservation(ctx, id, randomUUID())), 'INVALID_TRANSITION');
  });

  it('el ciclo completo: reservar, atar a la transferencia, liberar si falla, consumir con la entrega', async () => {
    const tron = await defaultAccount(env.db, 'USDT', 'TRON');
    const order = await fixtureOrder(env);
    const id = await as(env, 'trader', (ctx) => reserve(ctx, { accountId: tron.id, orderId: order, amount: new D(1000), reason: 'Orden ficticia' }));
    await expectCode(as(env, 'tesorero2', (ctx) => consumeReservation(ctx, id)), 'INVALID_TRANSITION');
    await as(env, 'tesorero2', (ctx) => lockReservation(ctx, id, randomUUID()));
    await as(env, 'tesorero2', (ctx) => unlockReservation(ctx, id, 'La red rechazó la transacción (simulado)'));
    const t2 = randomUUID();
    await as(env, 'tesorero2', (ctx) => lockReservation(ctx, id, t2));
    await as(env, 'tesorero2', (ctx) => consumeReservation(ctx, id));
    const r = (await env.db.query('SELECT status, transfer_id FROM otc.reservations WHERE id = $1', [id])).rows[0];
    expect(r).toEqual({ status: 'CONSUMED', transfer_id: t2 });
    const trail = await env.db.query(`SELECT action FROM public.audit_log WHERE entity_id = $1 ORDER BY id`, [id]);
    expect(trail.rows.map((x) => x.action)).toEqual([
      'liquidity.reserve',
      'liquidity.reservation_locked',
      'liquidity.reservation_active',
      'liquidity.reservation_locked',
      'liquidity.reservation_consumed',
    ]);
  });

  it('muchas reservas simultáneas nunca superan el saldo', async () => {
    const acc = await as(env, 'admin', (ctx) =>
      createLiquidityAccount(ctx, { code: 'PRUEBA_CONCURRENCIA', name: 'Cuenta de prueba (ficticia)', asset: 'USDT', liquidityType: 'EXCHANGE' }),
    );
    await as(env, 'admin', (ctx) => openingBalance(ctx, acc.id, '100000', 'Saldo ficticio de prueba'));
    const orders: string[] = [];
    for (let i = 0; i < 20; i++) orders.push(await fixtureOrder(env));
    const tries = orders.map((orderId) =>
      as(env, 'trader', (ctx) => reserve(ctx, { accountId: acc.id, orderId, amount: new D(10000), reason: 'Concurrencia' })),
    );
    const results = await Promise.allSettled(tries);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(10);
    const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(failed.every((r) => r.reason.code === 'INSUFFICIENT_LIQUIDITY')).toBe(true);
    const sum = await env.db.query(`SELECT sum(amount) AS s FROM otc.reservations WHERE account_id = $1 AND status = 'ACTIVE'`, [acc.id]);
    expect(new D(sum.rows[0].s).toFixed()).toBe('100000');
  });

  it('el saldo inicial va una sola vez, solo en cuentas reales y con el formato del activo', async () => {
    const acc = await as(env, 'admin', (ctx) =>
      createLiquidityAccount(ctx, { code: 'BANCO_PRUEBA', name: 'Banco de prueba (ficticio)', asset: 'COP', liquidityType: 'BANK' }),
    );
    await expectCode(as(env, 'admin', (ctx) => openingBalance(ctx, acc.id, '100.50', 'centavos')), 'INVALID');
    await as(env, 'admin', (ctx) => openingBalance(ctx, acc.id, '5000000', 'Saldo ficticio'));
    await expectCode(as(env, 'admin', (ctx) => openingBalance(ctx, acc.id, '1', 'otra vez')), 'INVALID_STATE');
    const equity = await accountByCode(env.db, 'EQUITY_COP');
    await expectCode(as(env, 'admin', (ctx) => openingBalance(ctx, equity.id, '1', 'interna')), 'INVALID');
    await expectCode(as(env, 'tesorero2', (ctx) => openingBalance(ctx, acc.id, '1', 'sin permiso')), 'FORBIDDEN');
    await expectCode(
      as(env, 'admin', (ctx) =>
        createLiquidityAccount(ctx, { code: 'WALLET_MALA', name: 'Billetera mala', asset: 'USDT', liquidityType: 'WALLET', network: 'TRON', externalRef: 'T123' }),
      ),
      'INVALID',
    );
  });

  it('por HTTP: resumen con disponible, alta de cuenta con permiso y verificación del libro', async () => {
    const op = await httpLogin(env, 'trader');
    const s = await call(env, op, 'GET', '/liquidity');
    expect(s.status).toBe(200);
    const bank = s.body.find((a: { code: string }) => a.code === 'BANCOLOMBIA_COP_DEMO');
    expect(bank).toMatchObject({ asset: 'COP', reserved: '0' });
    expect(new D(bank.available).eq(bank.balance)).toBe(true);

    const denied = await call(env, op, 'POST', '/accounts', { code: 'NO_PERMITIDA', name: 'x', asset: 'COP', liquidityType: 'BANK' }, { 'idempotency-key': newKey() });
    expect(denied.status).toBe(403);

    const admin = await httpLogin(env, 'admin');
    const key = newKey();
    const body = { code: 'NEQUI_COP_DEMO', name: 'Nequi pesos (demo)', asset: 'COP', liquidityType: 'BANK' };
    const created = await call(env, admin, 'POST', '/accounts', body, { 'idempotency-key': key });
    expect(created.status).toBe(201);
    const again = await call(env, admin, 'POST', '/accounts', body, { 'idempotency-key': key });
    expect(again.headers['idempotent-replay']).toBe('true');
    expect(again.body.id).toBe(created.body.id);

    const opening = await call(
      env,
      admin,
      'POST',
      `/accounts/${created.body.id}/opening-balance`,
      { amount: '-5', reason: 'negativo' },
      { 'idempotency-key': newKey() },
    );
    expect(opening.status).toBe(400);

    const ledger = await call(env, op, 'GET', `/ledger?accountId=${(await accountByCode(env.db, 'WALLET_TRON_DEMO')).id}`);
    expect(ledger.status).toBe(200);
    expect(ledger.body[0].kind).toBe('OPENING');
    expect((await call(env, op, 'GET', '/ledger/verify')).body).toEqual({ ok: true, mismatches: [] });
  });
});
