import type { Db, Tx } from '../db/pool.js';
import { invalid } from '../domain/errors.js';
import { authorize } from '../modules/identity/permissions.js';
import { actorDbId, type Ctx } from './context.js';
import { recordAction } from './events.js';

export interface DeskSettings {
  id: string;
  quote_ttl_seconds: number;
  payment_window_seconds: number;
  request_ttl_seconds: number;
  price_move_threshold_bps: number;
  tron_confirmations: number;
  bsc_confirmations: number;
  transfer_pending_seconds: number;
  transfer_review_seconds: number;
  created_at: string;
  reason: string;
}

export type DeskSettingsPatch = Partial<Omit<DeskSettings, 'id' | 'created_at' | 'reason'>>;

const FIELDS = [
  'quote_ttl_seconds',
  'payment_window_seconds',
  'request_ttl_seconds',
  'price_move_threshold_bps',
  'tron_confirmations',
  'bsc_confirmations',
  'transfer_pending_seconds',
  'transfer_review_seconds',
] as const;

export async function getDeskSettings(q: Pick<Ctx, 'tx'> | { tx: Db | Tx }): Promise<DeskSettings> {
  const r = await q.tx.query<DeskSettings>('SELECT * FROM otc.desk_settings ORDER BY id DESC LIMIT 1');
  if (!r.rowCount) throw new Error('Los parámetros de la mesa no están inicializados');
  return r.rows[0];
}

/** Cada cambio es una versión nueva; la anterior queda guardada. */
export async function updateDeskSettings(ctx: Ctx, patch: DeskSettingsPatch, reason: string): Promise<DeskSettings> {
  authorize(ctx.actor, 'settings.manage');
  if (!reason.trim()) throw invalid('Indica el motivo del cambio');
  const before = await getDeskSettings(ctx);
  const next = { ...before, ...patch };
  const r = await ctx.tx.query<DeskSettings>(
    `INSERT INTO otc.desk_settings (${FIELDS.join(', ')}, created_by, reason)
     VALUES (${FIELDS.map((_, i) => `$${i + 1}`).join(', ')}, $${FIELDS.length + 1}, $${FIELDS.length + 2}) RETURNING *`,
    [...FIELDS.map((f) => next[f]), actorDbId(ctx.actor), reason.trim()],
  );
  await recordAction(ctx, 'settings.update', 'desk_settings', r.rows[0].id, { before: before.id, patch, reason });
  return r.rows[0];
}
