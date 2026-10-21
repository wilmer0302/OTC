import type { Side } from '../pricing/domain.js';

// Ciclo de vida de la orden (especificación funcional, "Ciclo de vida de la orden"). Reglas puras.

export type OrderStatus =
  | 'CREADA'
  | 'COBRO_EN_VERIFICACION'
  | 'COBRO_CONFIRMADO'
  | 'ENTREGA_AUTORIZADA'
  | 'ENTREGA_ENVIADA'
  | 'COMPLETADA'
  | 'VENCIDA'
  | 'CANCELADA'
  | 'EN_REVISION';

const ORDER_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  CREADA: ['COBRO_EN_VERIFICACION', 'VENCIDA', 'CANCELADA', 'EN_REVISION'],
  COBRO_EN_VERIFICACION: ['COBRO_CONFIRMADO', 'EN_REVISION'],
  COBRO_CONFIRMADO: ['ENTREGA_AUTORIZADA', 'EN_REVISION'],
  ENTREGA_AUTORIZADA: ['ENTREGA_ENVIADA', 'EN_REVISION'],
  ENTREGA_ENVIADA: ['COMPLETADA', 'ENTREGA_AUTORIZADA', 'EN_REVISION'], // vuelve a autorizada si la entrega falla
  COMPLETADA: [],
  VENCIDA: [],
  CANCELADA: [],
  // El administrador resuelve: vuelve al estado desde el que entró a revisión, o se cancela.
  EN_REVISION: ['CREADA', 'COBRO_EN_VERIFICACION', 'COBRO_CONFIRMADO', 'ENTREGA_AUTORIZADA', 'ENTREGA_ENVIADA', 'CANCELADA'],
};

export const orderCanMove = (from: OrderStatus, to: OrderStatus) => ORDER_TRANSITIONS[from].includes(to);

export const OPEN_ORDER_STATUSES: OrderStatus[] = [
  'CREADA',
  'COBRO_EN_VERIFICACION',
  'COBRO_CONFIRMADO',
  'ENTREGA_AUTORIZADA',
  'ENTREGA_ENVIADA',
  'EN_REVISION',
];

/** Qué activo entrega la mesa en cada lado: en una venta entrega USDT; en una compra, pesos. */
export const deliveredAsset = (side: Side) => (side === 'SELL' ? 'USDT' : 'COP');
export const receivedAsset = (side: Side) => (side === 'SELL' ? 'COP' : 'USDT');

export const FINAL_ORDER_STATUSES: OrderStatus[] = ['COMPLETADA', 'VENCIDA', 'CANCELADA'];

/**
 * Formato de la referencia de un movimiento: hash de Tron (64 hex), hash de BSC (0x + 64 hex) o
 * referencia bancaria (letras, números y guiones). No prueba que exista: eso lo confirma el banco o la red.
 */
export function isValidExternalRef(rail: 'BANK' | 'TRON' | 'BSC', ref: string): boolean {
  if (rail === 'TRON') return /^[0-9a-fA-F]{64}$/.test(ref);
  if (rail === 'BSC') return /^0x[0-9a-fA-F]{64}$/.test(ref);
  return /^[A-Za-z0-9-]{4,64}$/.test(ref);
}
