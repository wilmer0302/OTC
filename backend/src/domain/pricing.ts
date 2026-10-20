import { D, toCopInteger, type Dec } from './money.js';

export type Side = 'BUY' | 'SELL';

export interface PriceInput {
  side: Side; // BUY: la mesa compra USDT. SELL: la mesa vende USDT.
  usdtAmount: Dec;
  trm: Dec; // pesos por dólar; 1 USDT se trata como 1 dólar (supuesto documentado)
  buyMarginCop: Dec;
  sellMarginCop: Dec;
}

export interface PriceResult {
  marginCop: Dec;
  priceCop: Dec;
  totalCop: Dec; // pesos enteros, redondeo mitad hacia arriba
  marginTotalCop: Dec; // ganancia frente a la TRM
}

export function priceQuote(input: PriceInput): PriceResult {
  const marginCop = input.side === 'BUY' ? input.buyMarginCop : input.sellMarginCop;
  const priceCop = input.side === 'BUY' ? input.trm.minus(marginCop) : input.trm.plus(marginCop);
  if (priceCop.lte(0)) throw new Error('El margen deja un precio no positivo');
  const totalCop = toCopInteger(priceCop.times(input.usdtAmount));
  const marginTotalCop = toCopInteger(marginCop.times(input.usdtAmount));
  return { marginCop, priceCop, totalCop, marginTotalCop };
}

export const ZERO = new D(0);
