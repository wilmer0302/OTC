import { Decimal } from 'decimal.js';

// Toda aritmética de dinero usa Decimal; nunca number.
export const D = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP });
export type Dec = InstanceType<typeof D>;

export const USDT_DECIMALS = 6;

export function parseUsdt(value: string): Dec {
  const d = new D(value);
  if (!d.isFinite() || d.lte(0)) throw new Error('Monto USDT inválido');
  if (d.decimalPlaces() > USDT_DECIMALS) throw new Error(`USDT admite máximo ${USDT_DECIMALS} decimales`);
  return d;
}

export const toCopInteger = (d: Dec): Dec => d.toDecimalPlaces(0, D.ROUND_HALF_UP);
