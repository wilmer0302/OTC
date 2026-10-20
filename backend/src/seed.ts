import type { Db } from './db/pool.js';
import { withTx } from './db/pool.js';
import { D } from './domain/money.js';
import { audit } from './services/audit.js';
import { postJournal } from './services/ledger.js';
import { createUser } from './services/users.js';

// Datos FICTICIOS para la demo. Solo se cargan en modo DEMO y con la base vacía.
export const DEMO_USERS = [
  { username: 'admin', fullName: 'Administración (demo)', roles: ['ADMIN', 'AUDITOR'] as const },
  { username: 'trader', fullName: 'Trader central (demo)', roles: ['OPERADOR', 'TESORERO'] as const },
  { username: 'tesorero2', fullName: 'Segunda aprobación (demo)', roles: ['TESORERO'] as const },
  { username: 'auditor', fullName: 'Auditoría (demo)', roles: ['AUDITOR'] as const },
];

export async function seedDemo(db: Db, password: string): Promise<boolean> {
  const existing = await db.query('SELECT 1 FROM users LIMIT 1');
  if (existing.rowCount) return false;

  await withTx(db, async (tx) => {
    for (const u of DEMO_USERS) {
      await createUser(tx, { ...u, roles: [...u.roles], password });
    }
    // Márgenes de referencia definidos por el negocio: compra TRM - 45, venta TRM + 15.
    // Umbral, vigencia y límite son valores de ejemplo para la demo; cada cliente fija los suyos.
    await tx.query(
      `INSERT INTO settings (buy_margin_cop, sell_margin_cop, quote_ttl_seconds, approval_policy,
         approval_threshold_cop, max_order_usdt)
       VALUES (45, 15, 120, 'THRESHOLD', 50000000, 200000)`,
    );
    await postJournal(tx, {
      description: 'Saldos iniciales FICTICIOS de la demo',
      lines: [
        { account: 'BANK_COP', amount: new D('2000000000') },
        { account: 'EQUITY_COP', amount: new D('-2000000000') },
        { account: 'USDT_WALLET', amount: new D('250000') },
        { account: 'EQUITY_USDT', amount: new D('-250000') },
      ],
    });
    const clients = [
      ['Comercializadora Andina SAS (ficticio)', '900000001', 'APROBADO', 'Bancolombia ahorros 000-000001 (demo)',
        'TDemoAndinaxxxxxxxxxxxxxxxxxxxxxxx', '0x000000000000000000000000000000000000a001'],
      ['Inversiones del Caribe SAS (ficticio)', '900000002', 'APROBADO', 'Bancolombia corriente 000-000002 (demo)',
        'TDemoCaribexxxxxxxxxxxxxxxxxxxxxxx', '0x000000000000000000000000000000000000a002'],
      ['Persona natural en revisión (ficticio)', '1000000003', 'PENDIENTE', null, null, null],
    ];
    for (const c of clients) {
      await tx.query(
        `INSERT INTO counterparties (name, document_id, kyc_status, bank_account, tron_address, bsc_address)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        c,
      );
    }
    await audit(tx, null, 'demo.seed', 'system', null, { note: 'Datos ficticios de demostración' });
  });
  return true;
}
