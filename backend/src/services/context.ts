import type { Adapters } from '../adapters/types.js';
import type { Tx } from '../db/pool.js';

export type Role = 'ADMIN' | 'OPERADOR' | 'TESORERO' | 'CUMPLIMIENTO' | 'AUDITOR';

export interface Actor {
  id: string;
  username: string;
  roles: Role[];
}

export interface Ctx {
  tx: Tx;
  actor: Actor;
  adapters: Adapters;
}
