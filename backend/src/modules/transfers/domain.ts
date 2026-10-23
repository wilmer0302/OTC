// Ciclo de vida de las transferencias (especificación funcional). Reglas puras.
// Un cobro (IN) entra como Enviada: el cliente ya pagó por fuera y se registra su referencia.

export type TransferStatus =
  | 'CREADA'
  | 'AUTORIZADA'
  | 'EN_FIRMA'
  | 'ENVIADA'
  | 'PENDIENTE'
  | 'CONFIRMADA'
  | 'FALLIDA'
  | 'CANCELADA'
  | 'EN_REVISION';

const TRANSFER_TRANSITIONS: Record<TransferStatus, TransferStatus[]> = {
  CREADA: ['AUTORIZADA', 'CANCELADA'],
  AUTORIZADA: ['EN_FIRMA', 'ENVIADA', 'CANCELADA'], // los pesos no pasan por firma
  EN_FIRMA: ['ENVIADA', 'CANCELADA'],
  ENVIADA: ['PENDIENTE', 'CONFIRMADA', 'FALLIDA', 'EN_REVISION'],
  PENDIENTE: ['CONFIRMADA', 'FALLIDA', 'EN_REVISION'],
  CONFIRMADA: [],
  FALLIDA: [], // nunca se reactiva: el reintento es otra transferencia
  CANCELADA: [],
  // Un responsable decide con la evidencia: confirmada, fallida o de vuelta a seguimiento.
  EN_REVISION: ['CONFIRMADA', 'FALLIDA', 'PENDIENTE'],
};

export const transferCanMove = (from: TransferStatus, to: TransferStatus) => TRANSFER_TRANSITIONS[from].includes(to);

/** Estados en los que el dinero pudo haber salido o entrado: no se cancela nada encima de ellos. */
export const IN_FLIGHT: TransferStatus[] = ['ENVIADA', 'PENDIENTE', 'CONFIRMADA', 'EN_REVISION'];
