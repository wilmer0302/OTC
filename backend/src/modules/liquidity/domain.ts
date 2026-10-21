import { D, type Dec } from '../../platform/money.js';

// Reglas puras de liquidez y del libro contable.

export type Asset = 'COP' | 'USDT';
export type ReservationStatus = 'ACTIVE' | 'LOCKED' | 'CONSUMED' | 'RELEASED';

const RESERVATION_TRANSITIONS: Record<ReservationStatus, ReservationStatus[]> = {
  ACTIVE: ['LOCKED', 'RELEASED'],
  LOCKED: ['CONSUMED', 'ACTIVE'], // ACTIVE de nuevo si la transferencia falla de forma demostrada
  CONSUMED: [],
  RELEASED: [],
};

export const reservationCanMove = (from: ReservationStatus, to: ReservationStatus) => RESERVATION_TRANSITIONS[from].includes(to);

/** Disponible = saldo contable − reservas activas y bloqueadas. */
export const availableOf = (balance: Dec, reserved: Dec): Dec => balance.minus(reserved);

export interface LineWithAsset {
  asset: Asset;
  amount: Dec;
}

/** Un asiento cuadra en cero por cada activo, sin líneas en cero y con al menos dos líneas. */
export function assertBalanced(lines: LineWithAsset[]): void {
  if (lines.length < 2) throw new Error('Un asiento necesita al menos dos líneas');
  const sums = new Map<Asset, Dec>();
  for (const l of lines) {
    if (l.amount.isZero()) throw new Error('Línea contable en cero');
    if (l.asset === 'COP' && !l.amount.isInteger()) throw new Error('Los pesos van en enteros');
    if (l.amount.decimalPlaces() > 6) throw new Error('USDT admite máximo 6 decimales');
    sums.set(l.asset, (sums.get(l.asset) ?? new D(0)).plus(l.amount));
  }
  for (const [asset, sum] of sums) {
    if (!sum.isZero()) throw new Error(`Asiento descuadrado en ${asset}: ${sum.toFixed()}`);
  }
}
