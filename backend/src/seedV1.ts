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

const userId = async (tx: Tx, username: string) =>
  (await tx.query('SELECT id FROM public.users WHERE username = $1', [username])).rows[0].id as string;

// Clientes ficticios con KYC y destinos ya aprobados (propone el trader, aprueba Cumplimiento).
// Todos son empresas, como los clientes del comprador; la plataforma admite también personas naturales.
// Las direcciones tienen formato válido pero no pertenecen a nadie: son de prueba.
export const DEMO_COUNTERPARTIES = [
  {
    name: 'Comercializadora Andina SAS (ficticio)', personType: 'JURIDICA', docType: 'NIT', doc: '900000001', kyc: 'APROBADO',
    bank: '1000000001', tron: 'TDemo1AndinaFicticia11111111111111', bsc: '0x00000000000000000000000000000000000a0001',
  },
  {
    name: 'Inversiones del Caribe SAS (ficticio)', personType: 'JURIDICA', docType: 'NIT', doc: '900000002', kyc: 'APROBADO',
    bank: '1000000002', tron: 'TDemo2CaribeFicticia22222222222222', bsc: '0x00000000000000000000000000000000000a0002',
  },
  {
    name: 'Logística del Pacífico SAS (ficticio)', personType: 'JURIDICA', docType: 'NIT', doc: '900000003', kyc: 'PENDIENTE',
    bank: null, tron: null, bsc: null,
  },
] as const;

const counterparties: Step = async (tx) => {
  const r = await tx.query('SELECT 1 FROM otc.counterparties LIMIT 1');
  if (r.rowCount) return false;
  const trader = await userId(tx, 'trader');
  const compliance = await userId(tx, 'cumplimiento');
  for (const c of DEMO_COUNTERPARTIES) {
    const cp = await tx.query<{ id: string }>(
      `INSERT INTO otc.counterparties (kind, person_type, document_type, document_number, kyc_status, created_by)
       VALUES ('CLIENTE',$1,$2,$3,$4,$5) RETURNING id`,
      [c.personType, c.docType, c.doc, c.kyc, trader],
    );
    const id = cp.rows[0].id;
    await tx.query(
      `INSERT INTO otc.counterparty_versions (counterparty_id, version, legal_name, reason, created_by)
       VALUES ($1, 1, $2, 'Alta (datos ficticios de demo)', $3)`,
      [id, c.name, trader],
    );
    if (c.kyc === 'APROBADO') {
      await tx.query(
        `INSERT INTO otc.kyc_reviews (counterparty_id, from_status, to_status, note, reviewed_by)
         VALUES ($1,'PENDIENTE','APROBADO','KYC ficticio de demo',$2)`,
        [id, compliance],
      );
    }
    const dests: Array<[string, string | null, string | null, string | null]> = [
      ['BANK', c.bank, 'Bancolombia', 'AHORROS'],
      ['TRON', c.tron, null, null],
      ['BSC', c.bsc, null, null],
    ];
    for (const [rail, value, bank, type] of dests) {
      if (!value) continue;
      await tx.query(
        `INSERT INTO otc.destinations (counterparty_id, rail, value, bank_name, account_type, label, status,
           proposed_by, decided_by, decided_at, decision_note)
         VALUES ($1,$2,$3,$4,$5,$6,'APROBADO',$7,$8, now(), 'Destino ficticio de demo')`,
        [id, rail, value, bank, type, `${rail} (demo)`, trader, compliance],
      );
    }
  }
  return true;
};

// Billeteras de origen ficticias, ya aprobadas, de los clientes con KYC aprobado: desde aquí
// "depositan" USDT en la demo. Propone el trader y aprueba Cumplimiento. No pertenecen a nadie.
export const DEMO_ORIGINS = [
  { doc: '900000001', network: 'TRON', address: 'TDemo1AndinaRemitente1111111111111' },
  { doc: '900000001', network: 'BSC', address: '0x00000000000000000000000000000000000b0001' },
  { doc: '900000002', network: 'TRON', address: 'TDemo2CaribeRemitente1111111111111' },
  { doc: '900000002', network: 'BSC', address: '0x00000000000000000000000000000000000b0002' },
] as const;

const origins: Step = async (tx) => {
  const r = await tx.query('SELECT 1 FROM otc.origin_addresses LIMIT 1');
  if (r.rowCount) return false;
  const trader = await userId(tx, 'trader');
  const compliance = await userId(tx, 'cumplimiento');
  for (const o of DEMO_ORIGINS) {
    const cp = await tx.query('SELECT id FROM otc.counterparties WHERE document_number = $1', [o.doc]);
    if (!cp.rowCount) continue;
    await tx.query(
      `INSERT INTO otc.origin_addresses (counterparty_id, network, address, label, status, proposed_by, proposed_at,
         decided_by, decided_at, decision_note)
       VALUES ($1,$2,$3,$4,'APROBADA',$5, now(), $6, now(), 'Billetera ficticia de demo')`,
      [cp.rows[0].id, o.network, o.address, `Billetera ${o.network} (demo)`, trader, compliance],
    );
  }
  return true;
};

// Regla de precio de referencia del negocio: compra a TRM − 45, venta a TRM + 15, comisión 0,1 %.
const pricing: Step = async (tx) => {
  const r = await tx.query('SELECT 1 FROM otc.pricing_rules LIMIT 1');
  if (r.rowCount) return false;
  await tx.query(
    `INSERT INTO otc.pricing_rules (counterparty_id, min_usdt, buy_margin_cop, sell_margin_cop, commission_rate, reason)
     VALUES (NULL, 0, 45, 15, 0.001, 'Regla de referencia del negocio (demo)')`,
  );
  return true;
};

// Límites de ejemplo para la demo (cada mesa fija los suyos). Propone admin y aprueba admin2.
const limits: Step = async (tx) => {
  const r = await tx.query('SELECT 1 FROM otc.policy_changes LIMIT 1');
  if (r.rowCount) return false;
  const admin = await userId(tx, 'admin');
  const admin2 = await userId(tx, 'admin2');
  const values: Array<[string, Record<string, string>]> = [
    ['ORDER_MAX_USDT', { amount: '200000' }],
    ['CLIENT_DAILY_USDT', { amount: '500000' }],
    ['DESK_DAILY_USDT', { amount: '2000000' }],
    ['OPEN_EXPOSURE_USDT', { amount: '1000000' }],
    ['OPEN_EXPOSURE_COP', { amount: '4000000000' }],
    ['APPROVAL_POLICY', { policy: 'THRESHOLD', thresholdCop: '50000000' }],
  ];
  for (const [kind, value] of values) {
    await tx.query(
      `INSERT INTO otc.policy_changes (kind, value, status, reason, proposed_by, decided_by, decided_at, decision_note)
       VALUES ($1,$2,'VIGENTE','Valor inicial de ejemplo (demo)',$3,$4, now(), 'Segunda firma de demo')`,
      [kind, value, admin, admin2],
    );
  }
  return true;
};

// Cuentas de liquidez FICTICIAS con saldos iniciales de ejemplo (no corresponden a dinero real).
// El saldo entra con un asiento de apertura contra el capital, como lo haría la mesa al arrancar.
export const DEMO_LIQUIDITY = [
  { code: 'BANCOLOMBIA_COP_DEMO', name: 'Bancolombia pesos (demo)', asset: 'COP', type: 'BANK', network: null, ref: '9990000001', isDefault: true, opening: '2000000000' },
  { code: 'WALLET_TRON_DEMO', name: 'Billetera Tron (demo)', asset: 'USDT', type: 'WALLET', network: 'TRON', ref: 'TDemoMesaTronFicticia1111111111111', isDefault: true, opening: '150000' },
  { code: 'WALLET_BSC_DEMO', name: 'Billetera BSC (demo)', asset: 'USDT', type: 'WALLET', network: 'BSC', ref: '0x00000000000000000000000000000000000d0001', isDefault: true, opening: '100000' },
  { code: 'BINANCE_USDT_DEMO', name: 'Binance USDT (demo)', asset: 'USDT', type: 'EXCHANGE', network: null, ref: null, isDefault: false, opening: '50000' },
] as const;

const liquidity: Step = async (tx) => {
  const r = await tx.query(`SELECT 1 FROM otc.accounts WHERE kind = 'LIQUIDITY' LIMIT 1`);
  if (r.rowCount) return false;
  const admin = await userId(tx, 'admin');
  for (const a of DEMO_LIQUIDITY) {
    const acc = await tx.query<{ id: string }>(
      `INSERT INTO otc.accounts (code, name, asset, kind, liquidity_type, network, external_ref, is_default, created_by)
       VALUES ($1,$2,$3,'LIQUIDITY',$4,$5,$6,$7,$8) RETURNING id`,
      [a.code, a.name, a.asset, a.type, a.network, a.ref, a.isDefault, admin],
    );
    const e = await tx.query<{ id: string }>(
      `INSERT INTO otc.journal_entries (kind, description, created_by) VALUES ('OPENING', $1, $2) RETURNING id`,
      [`Saldo inicial ficticio de demo: ${a.name}`, admin],
    );
    await tx.query(
      `INSERT INTO otc.journal_lines (entry_id, account_id, amount)
       VALUES ($1, $2, $3), ($1, (SELECT id FROM otc.accounts WHERE code = $4), -$3::numeric)`,
      [e.rows[0].id, acc.rows[0].id, a.opening, `EQUITY_${a.asset}`],
    );
  }
  return true;
};

export const SEED_STEPS: Array<[string, Step]> = [
  ['usuarios', users],
  ['parametros', deskSettings],
  ['contrapartes', counterparties],
  ['origenes', origins],
  ['precios', pricing],
  ['limites', limits],
  ['liquidez', liquidity],
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
