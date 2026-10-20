import type { Db } from '../db/pool.js';
import { balances } from './ledger.js';
import { bogotaDate, currentTrm } from './trm.js';

export async function dashboard(db: Db) {
  const today = bogotaDate();
  const [bal, trm, byStatus, closedToday] = await Promise.all([
    balances(db),
    currentTrm(db, today),
    db.query(`SELECT status, count(*)::int AS n FROM orders GROUP BY status`),
    db.query(
      `SELECT side, count(*)::int AS orders, COALESCE(SUM(usdt_amount),0) AS usdt,
              COALESCE(SUM(total_cop),0) AS cop, COALESCE(SUM(ROUND(margin_cop * usdt_amount)),0) AS margin_cop
       FROM orders
       WHERE status = 'CLOSED' AND (updated_at AT TIME ZONE 'America/Bogota')::date = $1::date
       GROUP BY side`,
      [today],
    ),
  ]);
  return {
    today,
    trm,
    balances: bal.filter((b) => b.code === 'BANK_COP' || b.code === 'USDT_WALLET'),
    ordersByStatus: Object.fromEntries(byStatus.rows.map((r) => [r.status, r.n])),
    closedToday: closedToday.rows,
  };
}
