import { describe, expect, it } from 'vitest';
import { D, parseUsdt } from '../src/domain/money.js';
import { assertTransition, requiredApprovals } from '../src/domain/orderStates.js';
import { priceQuote } from '../src/domain/pricing.js';

const base = { trm: new D('4000.00'), buyMarginCop: new D(45), sellMarginCop: new D(15) };

describe('precio sobre TRM', () => {
  it('la mesa compra USDT a TRM - 45', () => {
    const r = priceQuote({ ...base, side: 'BUY', usdtAmount: new D('1000') });
    expect(r.priceCop.toString()).toBe('3955');
    expect(r.totalCop.toString()).toBe('3955000');
    expect(r.marginTotalCop.toString()).toBe('45000');
  });

  it('la mesa vende USDT a TRM + 15', () => {
    const r = priceQuote({ ...base, side: 'SELL', usdtAmount: new D('1000') });
    expect(r.priceCop.toString()).toBe('4015');
    expect(r.totalCop.toString()).toBe('4015000');
  });

  it('redondea el total a pesos enteros, mitad hacia arriba, sin errores de punto flotante', () => {
    const r = priceQuote({ ...base, trm: new D('4123.45'), side: 'SELL', usdtAmount: new D('0.1') });
    // (4123.45 + 15) * 0.1 = 413.845 -> 414
    expect(r.totalCop.toString()).toBe('414');
  });

  it('rechaza más de 6 decimales de USDT', () => {
    expect(() => parseUsdt('1.0000001')).toThrow();
    expect(parseUsdt('1.000001').toString()).toBe('1.000001');
  });
});

describe('estados de la orden', () => {
  it('no permite saltarse el cobro', () => {
    expect(() => assertTransition('AWAITING_PAYMENT', 'DELIVERY_APPROVED')).toThrow();
    expect(() => assertTransition('AWAITING_PAYMENT', 'PAYMENT_CONFIRMED')).not.toThrow();
  });

  it('una orden cerrada no cambia', () => {
    expect(() => assertTransition('CLOSED', 'IN_REVIEW')).toThrow();
  });
});

describe('política de aprobación', () => {
  it('umbral: segunda persona solo por encima del monto', () => {
    expect(requiredApprovals('THRESHOLD', '50000000', '50000000')).toBe(1);
    expect(requiredApprovals('THRESHOLD', '50000001', '50000000')).toBe(2);
    expect(requiredApprovals('SINGLE', '999999999999', '0')).toBe(1);
    expect(requiredApprovals('ALL', '1', '999999999')).toBe(2);
  });
});
