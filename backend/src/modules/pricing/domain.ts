import { D, roundCentavos, roundCop, type Dec } from '../../platform/money.js';

// Precio todo incluido (especificación funcional, módulos 3 y 4). Reglas puras, sin base de datos.
//
//   precio base  = TRM + margen de venta   (la mesa vende USDT)
//                = TRM − margen de compra  (la mesa compra USDT)
//   precio final = precio base × (1 + comisión)  en venta
//                = precio base × (1 − comisión)  en compra
//
// El precio final por USDT se redondea a centavos (es el que ve el cliente) y el total se calcula
// con ese mismo precio y se redondea a pesos enteros, para que el cliente pueda verificarlo
// multiplicando. La comisión cobrada es la diferencia exacta entre el total y el subtotal sin
// comisión, así el detalle siempre suma el total.

export type Side = 'BUY' | 'SELL'; // BUY: la mesa compra USDT. SELL: la mesa vende USDT.

export interface PriceInput {
  side: Side;
  usdtAmount: Dec;
  trm: Dec;
  marginCop: Dec; // pesos por USDT del lado que corresponde
  commissionRate: Dec; // 0.001 = 0,1 %
}

export interface PriceBreakdown {
  basePriceCop: Dec; // por USDT, antes de comisión
  unitPriceCop: Dec; // por USDT, todo incluido (el que ve el cliente)
  subtotalCop: Dec; // base × cantidad, en pesos enteros
  commissionCop: Dec; // comisión cobrada en pesos enteros
  totalCop: Dec; // lo que paga o recibe el cliente
  marginTotalCop: Dec; // ganancia por margen frente a la TRM (interna)
}

export function priceAllIn(input: PriceInput): PriceBreakdown {
  const { side, usdtAmount, trm, marginCop, commissionRate } = input;
  if (usdtAmount.lte(0)) throw new Error('La cantidad debe ser positiva');
  if (marginCop.lt(0) || commissionRate.lt(0) || commissionRate.gte(1)) throw new Error('Margen o comisión inválidos');
  const basePriceCop = side === 'SELL' ? trm.plus(marginCop) : trm.minus(marginCop);
  if (basePriceCop.lte(0)) throw new Error('El margen deja un precio no positivo');
  const factor = side === 'SELL' ? new D(1).plus(commissionRate) : new D(1).minus(commissionRate);
  const unitPriceCop = roundCentavos(basePriceCop.times(factor));
  const totalCop = roundCop(unitPriceCop.times(usdtAmount));
  const subtotalCop = roundCop(basePriceCop.times(usdtAmount));
  const commissionCop = side === 'SELL' ? totalCop.minus(subtotalCop) : subtotalCop.minus(totalCop);
  if (commissionCop.lt(0)) throw new Error('La comisión calculada es negativa; revisa la regla de precio');
  return { basePriceCop, unitPriceCop, subtotalCop, commissionCop, totalCop, marginTotalCop: roundCop(marginCop.times(usdtAmount)) };
}

/** Lo que puede ver el cliente: nunca la TRM ni el margen de la mesa. */
export interface ClientPriceView {
  side: Side;
  usdtAmount: string;
  unitPriceCop: string; // a la vista, sin abrir el detalle
  totalCop: string;
  detail: { basePriceCop: string; subtotalCop: string; commissionCop: string; totalCop: string };
}

export function clientView(side: Side, usdtAmount: string, p: Record<'basePriceCop' | 'unitPriceCop' | 'subtotalCop' | 'commissionCop' | 'totalCop', string>): ClientPriceView {
  return {
    side,
    usdtAmount,
    unitPriceCop: p.unitPriceCop,
    totalCop: p.totalCop,
    detail: { basePriceCop: p.basePriceCop, subtotalCop: p.subtotalCop, commissionCop: p.commissionCop, totalCop: p.totalCop },
  };
}

export interface PricingRule {
  id: string;
  counterparty_id: string | null;
  min_usdt: string;
  buy_margin_cop: string;
  sell_margin_cop: string;
  commission_rate: string;
  active: boolean;
}

/**
 * Elige la regla que aplica: primero las del cliente, si tiene alguna activa que cubra el monto;
 * si no, las globales. Dentro de un alcance gana el tramo de mayor monto mínimo que no supere el monto.
 * Recibe solo las reglas vigentes (la más reciente de cada alcance y tramo).
 */
export function selectRule(rules: PricingRule[], counterpartyId: string, usdtAmount: Dec): PricingRule | null {
  const pick = (scope: string | null) =>
    rules
      .filter((r) => r.active && r.counterparty_id === scope && new D(r.min_usdt).lte(usdtAmount))
      .sort((a, b) => new D(b.min_usdt).comparedTo(new D(a.min_usdt)))[0] ?? null;
  return pick(counterpartyId) ?? pick(null);
}

export const marginFor = (rule: PricingRule, side: Side): Dec =>
  new D(side === 'SELL' ? rule.sell_margin_cop : rule.buy_margin_cop);
