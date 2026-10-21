import { D, type Dec } from '../../platform/money.js';

// Solicitudes y cotizaciones: estados y reglas puras (especificación funcional, módulos 2 y 3).

export type RequestStatus = 'CREADA' | 'VALIDADA' | 'COTIZADA' | 'ACEPTADA' | 'RECHAZADA' | 'CANCELADA' | 'VENCIDA';
export type QuoteStatus = 'VIGENTE' | 'ACEPTADA' | 'VENCIDA' | 'REEMPLAZADA' | 'RETIRADA';

const REQUEST_TRANSITIONS: Record<RequestStatus, RequestStatus[]> = {
  CREADA: ['VALIDADA', 'RECHAZADA', 'CANCELADA'],
  VALIDADA: ['COTIZADA', 'RECHAZADA', 'CANCELADA'],
  COTIZADA: ['ACEPTADA', 'CANCELADA', 'VENCIDA'],
  ACEPTADA: [],
  RECHAZADA: [],
  CANCELADA: [],
  VENCIDA: [],
};

const QUOTE_TRANSITIONS: Record<QuoteStatus, QuoteStatus[]> = {
  VIGENTE: ['ACEPTADA', 'VENCIDA', 'REEMPLAZADA', 'RETIRADA'],
  ACEPTADA: [],
  VENCIDA: [],
  REEMPLAZADA: [],
  RETIRADA: [],
};

export const requestCanMove = (from: RequestStatus, to: RequestStatus) => REQUEST_TRANSITIONS[from].includes(to);
export const quoteCanMove = (from: QuoteStatus, to: QuoteStatus) => QUOTE_TRANSITIONS[from].includes(to);

/** Una solicitud se puede cotizar (o recotizar) mientras esté validada o cotizada. */
export const requestQuotable = (s: RequestStatus) => s === 'VALIDADA' || s === 'COTIZADA';

/** La hora del servidor decide: en el instante exacto del vencimiento ya no se acepta. */
export const isExpired = (expiresAt: Date, now: Date) => now.getTime() >= expiresAt.getTime();

/** Movimiento del precio de referencia en puntos básicos (1 % = 100). */
export const moveBps = (from: Dec, to: Dec): Dec => to.minus(from).abs().div(from).times(10000);

/** Se retira la cotización si la TRM se movió más que el umbral (estrictamente mayor). */
export const priceMovedBeyond = (from: Dec, to: Dec, thresholdBps: number) => moveBps(from, to).gt(new D(thresholdBps));
