import type { Db } from '../db/pool.js';
import type { Integrations } from '../integrations/ports.js';
import { trackTransfers } from '../modules/confirmations/service.js';
import { expireOrders } from '../modules/orders/service.js';
import { expireQuotesAndRequests } from '../modules/trading/service.js';
import { SYSTEM_ACTOR, type Ctx } from '../platform/context.js';
import { inTransaction } from '../platform/tx.js';

// Tareas periódicas del trabajador. Cada una corre en su propia transacción como actor del sistema,
// toma solo filas vencidas y las bloquea con SKIP LOCKED: dos trabajadores no procesan lo mismo.

type Job = (ctx: Ctx) => Promise<unknown>;

export const SWEEPS: Array<[string, Job]> = [
  ['cotizaciones y solicitudes vencidas', expireQuotesAndRequests],
  ['órdenes sin pago en el plazo', expireOrders],
];

export async function runSweeps(db: Db, integrations: Integrations, now: () => Date) {
  const results: Record<string, unknown> = {};
  for (const [name, job] of SWEEPS) {
    results[name] = await inTransaction(db, (tx) => job({ tx, actor: SYSTEM_ACTOR, integrations, now }));
  }
  // Seguimiento de transferencias: consulta la red o el banco fuera de la transacción, una por una.
  results['seguimiento de transferencias'] = await trackTransfers({ db, integrations, now, actor: SYSTEM_ACTOR });
  return results;
}
