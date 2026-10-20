import { DomainError } from './errors.js';

export type OrderStatus =
  | 'AWAITING_PAYMENT'
  | 'PAYMENT_CONFIRMED'
  | 'DELIVERY_APPROVED'
  | 'DELIVERY_SENT'
  | 'CLOSED'
  | 'CANCELLED'
  | 'IN_REVIEW';

// Única fuente de verdad de las transiciones permitidas.
const TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  AWAITING_PAYMENT: ['PAYMENT_CONFIRMED', 'CANCELLED', 'IN_REVIEW'],
  PAYMENT_CONFIRMED: ['DELIVERY_APPROVED', 'IN_REVIEW'],
  DELIVERY_APPROVED: ['DELIVERY_SENT', 'IN_REVIEW'],
  DELIVERY_SENT: ['CLOSED', 'IN_REVIEW'],
  IN_REVIEW: ['AWAITING_PAYMENT', 'PAYMENT_CONFIRMED', 'DELIVERY_APPROVED', 'DELIVERY_SENT', 'CANCELLED'],
  CLOSED: [],
  CANCELLED: [],
};

export function assertTransition(from: OrderStatus, to: OrderStatus): void {
  if (!TRANSITIONS[from].includes(to)) {
    throw new DomainError('INVALID_TRANSITION', `No se puede pasar de ${from} a ${to}`);
  }
}

export const allowedNext = (from: OrderStatus): OrderStatus[] => TRANSITIONS[from];

// Lo que el cliente entrega (cobro) y lo que la mesa entrega, según el lado.
export const incomingAsset = (side: 'BUY' | 'SELL') => (side === 'BUY' ? 'USDT' : 'COP');
export const outgoingAsset = (side: 'BUY' | 'SELL') => (side === 'BUY' ? 'COP' : 'USDT');

export type ApprovalPolicy = 'SINGLE' | 'THRESHOLD' | 'ALL';

export function requiredApprovals(policy: ApprovalPolicy, totalCop: string, thresholdCop: string): 1 | 2 {
  if (policy === 'ALL') return 2;
  if (policy === 'SINGLE') return 1;
  // THRESHOLD: por encima del umbral se exige una segunda persona
  return BigInt(totalCop) > BigInt(thresholdCop) ? 2 : 1;
}
