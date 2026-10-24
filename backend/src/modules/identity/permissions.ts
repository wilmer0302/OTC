import { forbidden } from '../../domain/errors.js';
import type { Actor, Role } from '../../platform/context.js';

// Matriz de permisos de la especificación funcional. Es la única fuente de verdad:
// cada ruta y cada caso de uso del backend la consultan antes de tocar datos.
// Nadie, con ningún rol, puede editar ni borrar órdenes, asientos o auditoría: no existe ese permiso.

const ALL: Role[] = ['OPERADOR', 'TESORERO', 'CUMPLIMIENTO', 'ADMIN', 'AUDITOR'];

export const PERMISSIONS = {
  'read.operations': ALL, // ver clientes, órdenes, saldos
  'counterparty.create': ['OPERADOR', 'CUMPLIMIENTO', 'ADMIN'],
  'counterparty.update': ['OPERADOR', 'CUMPLIMIENTO', 'ADMIN'],
  'kyc.decide': ['CUMPLIMIENTO'],
  'destination.propose': ['OPERADOR'],
  'destination.decide': ['CUMPLIMIENTO', 'ADMIN'],
  'origin.propose': ['OPERADOR'], // registrar billeteras de origen de un cliente
  'origin.decide': ['CUMPLIMIENTO'], // aprobar, rechazar y revocar billeteras de origen
  'origin.exception.request': ['OPERADOR', 'TESORERO'], // pedir que se acepte un depósito de origen no aprobado
  'origin.exception.decide': ['CUMPLIMIENTO'], // autorizarlo o negarlo (persona distinta de quien lo pidió)
  'request.create': ['OPERADOR'],
  'request.cancel': ['OPERADOR', 'ADMIN'],
  'quote.create': ['OPERADOR'],
  'quote.accept': ['OPERADOR'],
  'quote.withdraw': ['OPERADOR', 'ADMIN'],
  'payment.register': ['OPERADOR', 'TESORERO'],
  'order.approve': ['TESORERO', 'ADMIN'],
  'order.cancel': ['OPERADOR', 'ADMIN'],
  'order.review': ['OPERADOR', 'TESORERO', 'CUMPLIMIENTO', 'ADMIN'],
  'review.resolve': ['ADMIN'],
  'transfer.manage': ['TESORERO'],
  'trm.record': ['TESORERO', 'ADMIN'],
  'pricing.manage': ['ADMIN'],
  'settings.manage': ['ADMIN'],
  'limits.propose': ['ADMIN'],
  'limits.approve': ['ADMIN'],
  'liquidity.manage': ['ADMIN'],
  'reconciliation.manage': ['TESORERO', 'ADMIN'],
  'adjustment.propose': ['TESORERO'],
  'adjustment.approve': ['ADMIN'],
  'users.manage': ['ADMIN'],
  'audit.read': ['CUMPLIMIENTO', 'ADMIN', 'AUDITOR'],
  'sandbox.simulate': ['TESORERO', 'ADMIN'],
} as const satisfies Record<string, readonly Role[]>;

export type Permission = keyof typeof PERMISSIONS;

export const ROLES: readonly Role[] = ALL;

export function can(actor: Actor, permission: Permission): boolean {
  const allowed: readonly Role[] = PERMISSIONS[permission];
  return actor.roles.some((r) => allowed.includes(r));
}

export function authorize(actor: Actor, permission: Permission): void {
  if (!can(actor, permission)) {
    throw forbidden(`Tu rol no permite esta acción (${permission})`);
  }
}

/** Separación de funciones: quien propuso o creó algo no puede ser quien lo aprueba. */
export function assertDifferentPerson(actor: Actor, otherUserId: string | null, what: string): void {
  if (otherUserId !== null && String(otherUserId) === actor.id) {
    throw forbidden(`${what} debe hacerlo una persona distinta`);
  }
}
