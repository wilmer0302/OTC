import { forbidden } from '../domain/errors.js';
import type { Actor, Role } from './context.js';

export function requireRole(actor: Actor, ...roles: Role[]): void {
  if (!actor.roles.some((r) => roles.includes(r))) {
    throw forbidden(`Se requiere uno de estos roles: ${roles.join(', ')}`);
  }
}
