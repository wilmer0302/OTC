import { invalid } from '../domain/errors.js';
import { D, type Dec } from '../domain/money.js';
import type { Network } from '../integrations/ports.js';

// Reglas de importes del backend v1:
// - Los montos viajan y se guardan como texto decimal; la aritmética usa Decimal, nunca number.
// - USDT de negocio: máximo 6 decimales. Pesos: precios con centavos, totales en pesos enteros.
// - En la red, USDT tiene 6 decimales en Tron y 18 en BSC; se compara en unidades base, sin redondeo.

export { D, type Dec };

export const USDT_DECIMALS = 6;
export const CHAIN_DECIMALS: Record<Network, number> = { TRON: 6, BSC: 18 };

const PLAIN_DECIMAL = /^\d{1,24}(\.\d{1,18})?$/;

function parse(value: string, field: string): Dec {
  if (typeof value !== 'string' || !PLAIN_DECIMAL.test(value)) {
    throw invalid(`${field}: escribe un número decimal sin signos ni exponentes (por ejemplo 1500.25)`);
  }
  return new D(value);
}

/** Monto USDT positivo con máximo 6 decimales. */
export function parseUsdtAmount(value: string, field = 'Monto USDT'): Dec {
  const d = parse(value, field);
  if (d.lte(0)) throw invalid(`${field} debe ser mayor que cero`);
  if (d.decimalPlaces() > USDT_DECIMALS) throw invalid(`${field} admite máximo ${USDT_DECIMALS} decimales`);
  return d;
}

/** Pesos enteros positivos (totales, límites, saldos en pesos). */
export function parseCopInteger(value: string, field = 'Monto en pesos'): Dec {
  const d = parse(value, field);
  if (d.lte(0)) throw invalid(`${field} debe ser mayor que cero`);
  if (!d.isInteger()) throw invalid(`${field} va en pesos enteros, sin centavos`);
  return d;
}

/** Precio o tasa en pesos con máximo 2 decimales (TRM, márgenes). Admite cero si se indica. */
export function parseCopPrice(value: string, field: string, { allowZero = false } = {}): Dec {
  const d = parse(value, field);
  if (allowZero ? d.lt(0) : d.lte(0)) throw invalid(`${field} debe ser ${allowZero ? 'cero o más' : 'mayor que cero'}`);
  if (d.decimalPlaces() > 2) throw invalid(`${field} admite máximo 2 decimales`);
  return d;
}

/** Tasa como fracción (0.001 = 0,1 %), entre 0 y 0.1, con máximo 6 decimales. */
export function parseRate(value: string, field: string): Dec {
  const d = parse(value, field);
  if (d.gt('0.1')) throw invalid(`${field} no puede superar 0.1 (10 %)`);
  if (d.decimalPlaces() > 6) throw invalid(`${field} admite máximo 6 decimales`);
  return d;
}

export const roundCop = (d: Dec): Dec => d.toDecimalPlaces(0, D.ROUND_HALF_UP);
export const roundCentavos = (d: Dec): Dec => d.toDecimalPlaces(2, D.ROUND_HALF_UP);

export function usdtToBaseUnits(amount: Dec, network: Network): string {
  if (amount.decimalPlaces() > USDT_DECIMALS) throw invalid('Monto USDT con más de 6 decimales');
  return amount.times(new D(10).pow(CHAIN_DECIMALS[network])).toFixed(0);
}

export function baseUnitsToUsdt(units: string, network: Network): Dec {
  if (!/^\d+$/.test(units)) throw invalid('Unidades base inválidas');
  return new D(units).div(new D(10).pow(CHAIN_DECIMALS[network]));
}

/** Texto canónico de un monto (sin ceros sobrantes), para guardar y comparar. */
export const fmt = (d: Dec): string => d.toFixed();
