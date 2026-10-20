import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkLimits, requiredApprovals, ZERO_USAGE, type EffectiveLimits } from '../../src/modules/limits/domain.js';
import { decideLimitChange, effectiveLimits, proposeLimitChange } from '../../src/modules/limits/service.js';
import { D } from '../../src/platform/money.js';
import { as, call, expectCode, httpLogin, newKey, setupEnv, type Env } from './helpers.js';

const limits: EffectiveLimits = {
  orderMaxUsdt: new D(200000),
  clientDailyUsdt: new D(500000),
  deskDailyUsdt: new D(2000000),
  openExposureUsdt: new D(1000000),
  openExposureCop: new D(4000000000),
  approval: { policy: 'THRESHOLD', thresholdCop: '50000000' },
};

describe('reglas de límites', () => {
  it('pasa dentro de los límites', () => {
    expect(checkLimits({ side: 'SELL', usdtAmount: new D(1000), totalCop: new D(4019020) }, limits, ZERO_USAGE)).toEqual([]);
  });

  it('el límite es inclusivo: igual al límite pasa, un millonésimo más no', () => {
    expect(checkLimits({ side: 'SELL', usdtAmount: new D('200000'), totalCop: null }, limits, ZERO_USAGE)).toEqual([]);
    const v = checkLimits({ side: 'SELL', usdtAmount: new D('200000.000001'), totalCop: null }, limits, ZERO_USAGE);
    expect(v.map((x) => x.kind)).toEqual(['ORDER_MAX_USDT']);
  });

  it('suma lo ya usado hoy y explica cuánto se ha usado', () => {
    const usage = { ...ZERO_USAGE, clientDailyUsdt: new D(450000) };
    const v = checkLimits({ side: 'BUY', usdtAmount: new D(60000), totalCop: new D(237063000) }, limits, usage);
    expect(v).toHaveLength(1);
    expect(v[0].message).toBe('Supera el límite diario del cliente (usado 450000 de 500000 USDT)');
  });

  it('la exposición en USDT cuenta ventas y la de pesos cuenta compras', () => {
    const usage = { ...ZERO_USAGE, openExposureUsdt: new D(999999), openExposureCop: new D(3999999999) };
    expect(checkLimits({ side: 'SELL', usdtAmount: new D(2), totalCop: new D(8038) }, limits, usage).map((x) => x.kind)).toEqual([
      'OPEN_EXPOSURE_USDT',
    ]);
    expect(checkLimits({ side: 'BUY', usdtAmount: new D(2), totalCop: new D(7902) }, limits, usage).map((x) => x.kind)).toEqual([
      'OPEN_EXPOSURE_COP',
    ]);
  });

  it('la política pide dos firmas por encima del umbral', () => {
    expect(requiredApprovals(limits.approval, new D(50000000))).toBe(1);
    expect(requiredApprovals(limits.approval, new D(50000001))).toBe(2);
    expect(requiredApprovals({ policy: 'ALL' }, new D(1))).toBe(2);
    expect(requiredApprovals({ policy: 'SINGLE' }, new D(1e12))).toBe(1);
  });
});

describe('cambios de límites con segunda firma', () => {
  let env: Env;
  let client: string;
  beforeAll(async () => {
    env = await setupEnv();
    client = (await env.db.query(`SELECT id FROM otc.counterparties WHERE document_number = '900000001'`)).rows[0].id;
  });
  afterAll(async () => env.close());

  it('los límites de ejemplo de la demo están vigentes', async () => {
    const l = await effectiveLimits(env.db, null);
    expect(l.orderMaxUsdt.toFixed()).toBe('200000');
    expect(l.approval).toEqual({ policy: 'THRESHOLD', thresholdCop: '50000000' });
  });

  it('quien propone no puede aprobar, y la propuesta no rige hasta la segunda firma', async () => {
    const p = await as(env, 'admin', (ctx) =>
      proposeLimitChange(ctx, { kind: 'ORDER_MAX_USDT', counterpartyId: client, value: { amount: '50000' }, reason: 'Cliente nuevo (ficticio)' }),
    );
    expect((await effectiveLimits(env.db, client)).orderMaxUsdt.toFixed()).toBe('200000');
    await expectCode(as(env, 'admin', (ctx) => decideLimitChange(ctx, p.id, true, 'ok')), 'FORBIDDEN');
    await expectCode(as(env, 'trader', (ctx) => decideLimitChange(ctx, p.id, true, 'ok')), 'FORBIDDEN');
    await as(env, 'admin2', (ctx) => decideLimitChange(ctx, p.id, true, 'Revisado'));
    expect((await effectiveLimits(env.db, client)).orderMaxUsdt.toFixed()).toBe('50000');
    expect((await effectiveLimits(env.db, null)).orderMaxUsdt.toFixed()).toBe('200000'); // los demás siguen con el global
  });

  it('valida el valor según el tipo y el alcance', async () => {
    await expectCode(
      as(env, 'admin', (ctx) => proposeLimitChange(ctx, { kind: 'ORDER_MAX_USDT', value: { amount: '1.1234567' }, reason: 'x' })),
      'INVALID',
    );
    await expectCode(
      as(env, 'admin', (ctx) => proposeLimitChange(ctx, { kind: 'DESK_DAILY_USDT', counterpartyId: client, value: { amount: '1' }, reason: 'x' })),
      'INVALID',
    );
    await expectCode(
      as(env, 'admin', (ctx) => proposeLimitChange(ctx, { kind: 'APPROVAL_POLICY', value: { policy: 'THRESHOLD' }, reason: 'x' })),
      'INVALID',
    );
  });

  it('una decisión no se puede reescribir ni borrar', async () => {
    const r = await env.db.query(`SELECT id FROM otc.policy_changes WHERE status = 'VIGENTE' LIMIT 1`);
    await expect(env.db.query(`UPDATE otc.policy_changes SET value = '{"amount":"1"}' WHERE id = $1`, [r.rows[0].id])).rejects.toThrow();
    await expect(env.db.query(`DELETE FROM otc.policy_changes`)).rejects.toThrow(/solo-agregar/);
  });

  it('por HTTP: propone un administrador, aprueba otro, y queda en el historial', async () => {
    const admin = await httpLogin(env, 'admin');
    const admin2 = await httpLogin(env, 'admin2');
    const p = await call(
      env,
      admin,
      'POST',
      '/limit-changes',
      { kind: 'APPROVAL_POLICY', value: { policy: 'ALL' }, reason: 'Toda entrega con dos firmas (prueba)' },
      { 'idempotency-key': newKey() },
    );
    expect(p.status).toBe(201);
    const dup = await call(env, admin, 'POST', '/limit-changes', { kind: 'APPROVAL_POLICY', value: { policy: 'SINGLE' }, reason: 'otra' }, { 'idempotency-key': newKey() });
    expect(dup.body.code).toBe('PENDING_PROPOSAL');
    const d = await call(env, admin2, 'POST', `/limit-changes/${p.body.id}/decision`, { approve: true, note: 'De acuerdo' }, { 'idempotency-key': newKey() });
    expect(d.body.status).toBe('VIGENTE');
    const l = await call(env, admin, 'GET', '/limits');
    expect(l.body.approval).toEqual({ policy: 'ALL' });
  });
});
