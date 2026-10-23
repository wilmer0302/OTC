import { D } from '../../platform/money.js';

// Conciliación: reglas puras para cruzar un movimiento externo con el libro.

export type ItemStatus = 'PENDIENTE' | 'CONCILIADA' | 'CON_DIFERENCIA' | 'SIN_CONTRAPARTIDA' | 'EN_REVISION' | 'AJUSTADA';
export type RunStatus = 'ABIERTO' | 'CUADRADO' | 'CON_DIFERENCIAS' | 'CERRADO';

const ITEM_TRANSITIONS: Record<ItemStatus, ItemStatus[]> = {
  PENDIENTE: ['CONCILIADA', 'CON_DIFERENCIA', 'SIN_CONTRAPARTIDA'],
  CON_DIFERENCIA: ['EN_REVISION'],
  SIN_CONTRAPARTIDA: ['EN_REVISION', 'CONCILIADA'], // conciliada si después aparece su pareja
  EN_REVISION: ['AJUSTADA', 'CONCILIADA'],
  CONCILIADA: [],
  AJUSTADA: [],
};

export const itemCanMove = (from: ItemStatus, to: ItemStatus) => ITEM_TRANSITIONS[from].includes(to);
export const FINAL_ITEM: ItemStatus[] = ['CONCILIADA', 'AJUSTADA'];

export interface BookSide {
  status: string; // estado de la transferencia
  amount: string;
  direction: 'IN' | 'OUT'; // visto desde la cuenta conciliada
}

export interface Match {
  status: ItemStatus;
  reason: string | null;
}

/** Cruza un movimiento externo con el movimiento del libro que tiene la misma referencia. */
export function matchMovement(ext: { amount: string; direction: 'IN' | 'OUT' }, book: BookSide | null): Match {
  if (!book) return { status: 'SIN_CONTRAPARTIDA', reason: 'Ningún movimiento del libro tiene esta referencia' };
  if (book.direction !== ext.direction) {
    return { status: 'CON_DIFERENCIA', reason: `El sentido no coincide: el libro dice ${book.direction} y el extracto ${ext.direction}` };
  }
  if (!new D(book.amount).eq(ext.amount)) {
    return { status: 'CON_DIFERENCIA', reason: `El monto no coincide: el libro dice ${new D(book.amount).toFixed()} y el extracto ${new D(ext.amount).toFixed()}` };
  }
  if (book.status !== 'CONFIRMADA') return { status: 'PENDIENTE', reason: `El libro todavía no la registra como confirmada (${book.status})` };
  return { status: 'CONCILIADA', reason: null };
}

/** Estado del día de la cuenta según sus partidas. */
export function runStatusOf(items: ItemStatus[]): Exclude<RunStatus, 'CERRADO'> {
  if (items.some((s) => s === 'CON_DIFERENCIA' || s === 'SIN_CONTRAPARTIDA' || s === 'EN_REVISION')) return 'CON_DIFERENCIAS';
  if (items.some((s) => s === 'PENDIENTE')) return 'ABIERTO';
  return 'CUADRADO';
}
