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
  EN_REVISION: [], // la salida de revisión la decide el administrador (módulo de órdenes)
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
