import type { Tx } from '../db/pool.js';
import type { Integrations } from '../integrations/ports.js';
import type { Actor } from '../services/context.js';

export type { Actor, Role } from '../services/context.js';

/** Contexto de un caso de uso del backend v1: una transacción, quién actúa y con qué integraciones. */
export interface Ctx {
  tx: Tx;
  actor: Actor;
  integrations: Integrations;
  /** Hora del servidor; las pruebas pueden fijarla. */
  now: () => Date;
}

/** Actor del sistema (trabajador en segundo plano). No tiene usuario en la base. */
export const SYSTEM_ACTOR: Actor = { id: '0', username: 'sistema', roles: [] };
export const actorDbId = (actor: Actor): string | null => (actor.id === '0' ? null : actor.id);
