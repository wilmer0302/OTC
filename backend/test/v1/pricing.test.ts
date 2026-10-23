import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { clientView, priceAllIn, selectRule, type PricingRule } from '../../src/modules/pricing/domain.js';
import { effectiveRules, price, recordTrm, setPricingRule } from '../../src/modules/pricing/service.js';
import { D } from '../../src/platform/money.js';
import { as, call, expectCode, httpLogin, newKey, setupEnv, type Env } from './helpers.js';

const p = (side: 'BUY' | 'SELL', amount: string, trm = '4000', margin = side === 'SELL' ? '15' : '45', c = '0.001') =>
  priceAllIn({ side, usdtAmount: new D(amount), trm: new D(trm), marginCop: new D(margin), commissionRate: new D(c) });

describe('precio todo incluido (reglas puras)', () => {
  it('con TRM 4.000 la mesa vende a 4.019,02 y compra a 3.951,05 (especificación)', () => {
    expect(p('SELL', '1').unitPriceCop.toFixed(2)).toBe('4019.02');
    expect(p('BUY', '1').unitPriceCop.toFixed(2)).toBe('3951.05');
  });

  it('el total es el precio por USDT por la cantidad, en pesos enteros', () => {
    const sell = p('SELL', '1000');
    expect(sell.totalCop.toFixed()).toBe('4019020');
    expect(sell.subtotalCop.toFixed()).toBe('4015000');
    expect(sell.commissionCop.toFixed()).toBe('4020');
    expect(sell.marginTotalCop.toFixed()).toBe('15000');
    const buy = p('BUY', '1000');
    expect(buy.totalCop.toFixed()).toBe('3951050');
    expect(buy.subtotalCop.toFixed()).toBe('3955000');
    expect(buy.commissionCop.toFixed()).toBe('3950');
  });

  it('para cualquier monto y TRM, el detalle suma exactamente el total', () => {
    let seed = 42;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    for (let i = 0; i < 2000; i++) {
      const amount = new D(Math.floor(rnd() * 500_000_000_000) + 1).div(1_000_000); // hasta 500.000 USDT, 6 decimales
      const trm = new D(Math.floor(rnd() * 300_000) + 300_000).div(100); // 3.000,00 a 6.000,00
      const side = rnd() < 0.5 ? 'BUY' : 'SELL';
      const r = priceAllIn({ side, usdtAmount: amount, trm, marginCop: new D(Math.floor(rnd() * 100)), commissionRate: new D('0.001') });
      const recomposed = side === 'SELL' ? r.subtotalCop.plus(r.commissionCop) : r.subtotalCop.minus(r.commissionCop);
      expect(recomposed.eq(r.totalCop)).toBe(true);
      expect(r.totalCop.isInteger()).toBe(true);
      expect(r.commissionCop.gte(0)).toBe(true);
      expect(r.totalCop.eq(r.unitPriceCop.times(amount).toDecimalPlaces(0, D.ROUND_HALF_UP))).toBe(true);
    }
  });

  it('sin comisión, el precio final es el precio base', () => {
    const r = p('SELL', '10', '4000', '15', '0');
    expect(r.unitPriceCop.toFixed(2)).toBe('4015.00');
    expect(r.commissionCop.toFixed()).toBe('0');
  });

  it('la vista del cliente no incluye TRM ni margen', () => {
    const r = p('SELL', '1000');
    const view = clientView('SELL', '1000', {
      basePriceCop: r.basePriceCop.toFixed(),
      unitPriceCop: r.unitPriceCop.toFixed(),
      subtotalCop: r.subtotalCop.toFixed(),
      commissionCop: r.commissionCop.toFixed(),
      totalCop: r.totalCop.toFixed(),
    });
    const text = JSON.stringify(view).toLowerCase();
    expect(text).not.toMatch(/trm|margin|margen/);
    expect(view.unitPriceCop).toBe('4019.02');
  });

  it('elige la regla del cliente y el tramo de mayor monto mínimo que aplica', () => {
    const rule = (id: string, cp: string | null, min: string, active = true): PricingRule => ({
      id, counterparty_id: cp, min_usdt: min, buy_margin_cop: '45', sell_margin_cop: '15', commission_rate: '0.001', active,
    });
    const rules = [rule('g0', null, '0'), rule('g1', null, '50000'), rule('c0', 'C', '10000'), rule('c1', 'C', '100000', false)];
    expect(selectRule(rules, 'X', new D('60000'))?.id).toBe('g1');
    expect(selectRule(rules, 'C', new D('5000'))?.id).toBe('g0'); // el tramo del cliente arranca en 10.000
    expect(selectRule(rules, 'C', new D('20000'))?.id).toBe('c0');
    expect(selectRule(rules, 'C', new D('200000'))?.id).toBe('c0'); // el tramo de 100.000 está inactivo
  });
});

describe('precios con base de datos', () => {
  let env: Env;
  let client: string;
  beforeAll(async () => {
    env = await setupEnv();
    client = (await env.db.query(`SELECT id FROM otc.counterparties WHERE document_number = '900000001'`)).rows[0].id;
  });
  afterAll(async () => env.close());

  it('no cotiza sin TRM del día', async () => {
    await expectCode(as(env, 'trader', (ctx) => price(ctx, { counterpartyId: client, side: 'SELL', usdtAmount: new D(1) })), 'NO_TRM');
  });

  it('carga la TRM (registro nuevo cada vez, nunca se sobrescribe) y calcula con la regla de referencia', async () => {
    await expectCode(as(env, 'auditor', (ctx) => recordTrm(ctx, { rate: '4000' })), 'FORBIDDEN');
    await as(env, 'trader', (ctx) => recordTrm(ctx, { rate: '3990.10' }));
    const trm = await as(env, 'trader', (ctx) => recordTrm(ctx, { rate: '4000.00' }));
    expect(trm.simulated).toBe(true);
    const r = await as(env, 'trader', (ctx) => price(ctx, { counterpartyId: client, side: 'SELL', usdtAmount: new D(1000) }));
    expect(r.trm.rate).toBe('4000.00');
    expect(r.unitPriceCop.toFixed(2)).toBe('4019.02');
    await expect(env.db.query(`UPDATE otc.trm_rates SET rate = 1`)).rejects.toThrow(/solo-agregar/);
  });

  it('solo el administrador cambia márgenes y comisiones; cada cambio es una versión', async () => {
    await expectCode(
      as(env, 'trader', (ctx) => setPricingRule(ctx, { buyMarginCop: '40', sellMarginCop: '10', commissionRate: '0.001', reason: 'x' })),
      'FORBIDDEN',
    );
    await as(env, 'admin', (ctx) =>
      setPricingRule(ctx, { counterpartyId: client, buyMarginCop: '40', sellMarginCop: '10', commissionRate: '0.0005', reason: 'Cliente preferencial (ficticio)' }),
    );
    const r = await as(env, 'trader', (ctx) => price(ctx, { counterpartyId: client, side: 'SELL', usdtAmount: new D(1000) }));
    expect(r.unitPriceCop.toFixed(2)).toBe('4012.01'); // (4000 + 10) × 1,0005 = 4012,005
    const rules = await effectiveRules(env.db);
    expect(rules).toHaveLength(2);
    await expectCode(
      as(env, 'admin', (ctx) => setPricingRule(ctx, { buyMarginCop: '40', sellMarginCop: '10', commissionRate: '0.5', reason: 'x' })),
      'INVALID',
    );
  });

  it('la vista previa por HTTP separa lo interno de lo que ve el cliente', async () => {
    const op = await httpLogin(env, 'trader');
    const other = (await env.db.query(`SELECT id FROM otc.counterparties WHERE document_number = '900000002'`)).rows[0].id;
    const r = await call(env, op, 'POST', '/pricing/preview', { counterpartyId: other, side: 'BUY', usdtAmount: '1000' });
    expect(r.status).toBe(200);
    expect(r.body.internal.marginCop).toBe('45');
    expect(r.body.client.unitPriceCop).toBe('3951.05');
    expect(JSON.stringify(r.body.client)).not.toMatch(/trm|margin/i);
    const t = await call(env, op, 'POST', '/trm', { rate: '4000.123' }, { 'idempotency-key': newKey() });
    expect(t.status).toBe(400);
  });
});
