import type { Db, Tx } from '../db/pool.js';
import { D, type Dec } from '../domain/money.js';

export type AccountCode = 'BANK_COP' | 'USDT_WALLET' | 'TRADING_COP' | 'TRADING_USDT' | 'EQUITY_COP' | 'EQUITY_USDT';

const CURRENCY: Record<AccountCode, 'COP' | 'USDT'> = {
  BANK_COP: 'COP',
  TRADING_COP: 'COP',
  EQUITY_COP: 'COP',
  USDT_WALLET: 'USDT',
  TRADING_USDT: 'USDT',
  EQUITY_USDT: 'USDT',
};

export interface JournalLine {
  account: AccountCode;
  amount: Dec; // débito positivo, crédito negativo
}

export async function postJournal(
  tx: Tx,
  input: { description: string; orderId?: string; userId?: string; lines: JournalLine[] },
): Promise<string> {
  const sums = new Map<string, Dec>();
  for (const l of input.lines) {
    if (l.amount.isZero()) throw new Error('Línea contable en cero');
    const cur = CURRENCY[l.account];
    sums.set(cur, (sums.get(cur) ?? new D(0)).plus(l.amount));
  }
  for (const [cur, sum] of sums) {
    if (!sum.isZero()) throw new Error(`Asiento descuadrado en ${cur}: ${sum.toString()}`);
  }
  const entry = await tx.query<{ id: string }>(
    'INSERT INTO journal_entries (description, order_id, created_by) VALUES ($1,$2,$3) RETURNING id',
    [input.description, input.orderId ?? null, input.userId ?? null],
  );
  const entryId = entry.rows[0].id;
  for (const l of input.lines) {
    await tx.query('INSERT INTO journal_lines (entry_id, account_code, amount) VALUES ($1,$2,$3)', [
      entryId,
      l.account,
      l.amount.toString(),
    ]);
  }
  return entryId;
}

export async function balance(q: Db | Tx, account: AccountCode): Promise<Dec> {
  const r = await q.query<{ total: string | null }>(
    'SELECT SUM(amount) AS total FROM journal_lines WHERE account_code = $1',
    [account],
  );
  return new D(r.rows[0].total ?? 0);
}

export async function balances(q: Db | Tx) {
  const r = await q.query<{ code: string; name: string; currency: string; total: string | null }>(
    `SELECT a.code, a.name, a.currency, SUM(l.amount) AS total
     FROM ledger_accounts a LEFT JOIN journal_lines l ON l.account_code = a.code
     GROUP BY a.code, a.name, a.currency ORDER BY a.code`,
  );
  return r.rows.map((row) => ({ ...row, total: new D(row.total ?? 0).toString() }));
}
