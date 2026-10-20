import type { Db, Tx } from './db/pool.js';
import { hashPassword } from './modules/identity/service.js';
import { audit } from './services/audit.js';
import { inTransaction } from './platform/tx.js';

// Datos FICTICIOS del backend v1, solo para desarrollo, pruebas y demo.
// Cada bloque se carga una sola vez (revisa si ya existe) y queda registrado en la auditoría.
// Ningún nombre, documento, cuenta, dirección ni saldo corresponde a nada real.

export const DEMO_V1_USERS = [
  { username: 'cumplimiento', fullName: 'Cumplimiento (demo)', roles: ['CUMPLIMIENTO'] },
  { username: 'admin2', fullName: 'Segunda firma de administración (demo)', roles: ['ADMIN'] },
];

type Step = (tx: Tx, password: string) => Promise<boolean>;

const users: Step = async (tx, password) => {
  let added = false;
  for (const u of DEMO_V1_USERS) {
    const r = await tx.query(
      `INSERT INTO public.users (username, full_name, password_hash, roles) VALUES ($1,$2,$3,$4)
       ON CONFLICT (username) DO NOTHING RETURNING id`,
      [u.username, u.fullName, await hashPassword(password), u.roles],
    );
    added ||= !!r.rowCount;
  }
  return added;
};

// Parámetros de referencia: cotización vigente 2 minutos, 8 minutos para pagar (dato del negocio),
// confirmaciones por red y plazos de seguimiento de ejemplo. Cada mesa fija los suyos.
const deskSettings: Step = async (tx) => {
  const r = await tx.query('SELECT 1 FROM otc.desk_settings LIMIT 1');
  if (r.rowCount) return false;
  await tx.query(
    `INSERT INTO otc.desk_settings (quote_ttl_seconds, payment_window_seconds, request_ttl_seconds,
       price_move_threshold_bps, tron_confirmations, bsc_confirmations, transfer_pending_seconds,
       transfer_review_seconds, reason)
     VALUES (120, 480, 1800, 50, 20, 15, 900, 3600, 'Valores iniciales de ejemplo (demo)')`,
  );
  return true;
};

export const SEED_STEPS: Array<[string, Step]> = [
  ['usuarios', users],
  ['parametros', deskSettings],
];

/** Carga lo que falte de los datos ficticios. Devuelve los bloques cargados. */
export async function seedDemoV1(db: Db, password: string, steps = SEED_STEPS): Promise<string[]> {
  return inTransaction(db, async (tx) => {
    const loaded: string[] = [];
    for (const [name, step] of steps) if (await step(tx, password)) loaded.push(name);
    if (loaded.length) {
      await audit(tx, null, 'demo.seed_v1', 'system', null, { note: 'Datos ficticios del backend v1', loaded });
    }
    return loaded;
  });
}
