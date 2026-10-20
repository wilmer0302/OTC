import type { Db, Tx } from '../db/pool.js';
import type { ApprovalPolicy } from '../domain/orderStates.js';
import { audit } from './audit.js';
import { requireRole } from './authz.js';
import type { Ctx } from './context.js';

export interface Settings {
  buy_margin_cop: string;
  sell_margin_cop: string;
  quote_ttl_seconds: number;
  approval_policy: ApprovalPolicy;
  approval_threshold_cop: string;
  max_order_usdt: string;
  updated_at: string;
}

export async function getSettings(q: Db | Tx): Promise<Settings> {
  const r = await q.query<Settings>('SELECT * FROM settings WHERE id = 1');
  if (!r.rowCount) throw new Error('La configuración no está inicializada');
  return r.rows[0];
}

export async function updateSettings(ctx: Ctx, patch: Partial<Omit<Settings, 'updated_at'>>): Promise<Settings> {
  requireRole(ctx.actor, 'ADMIN');
  const before = await getSettings(ctx.tx);
  const next = { ...before, ...patch };
  await ctx.tx.query(
    `UPDATE settings SET buy_margin_cop=$1, sell_margin_cop=$2, quote_ttl_seconds=$3, approval_policy=$4,
       approval_threshold_cop=$5, max_order_usdt=$6, updated_at=now(), updated_by=$7 WHERE id = 1`,
    [
      next.buy_margin_cop,
      next.sell_margin_cop,
      next.quote_ttl_seconds,
      next.approval_policy,
      next.approval_threshold_cop,
      next.max_order_usdt,
      ctx.actor.id,
    ],
  );
  const { updated_at: _a, ...b } = before;
  await audit(ctx.tx, ctx.actor.id, 'settings.update', 'settings', 1, { before: b, after: patch });
  return getSettings(ctx.tx);
}
