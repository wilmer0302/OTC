import { mkdirSync, writeFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { buildIntegrations, tronConfigFromEnv } from '../src/integrations/factory.js';
import type { Integrations } from '../src/integrations/ports.js';
import { checkTransfer, trackTransfers } from '../src/modules/confirmations/service.js';
import { decideOrigin, proposeOrigin } from '../src/modules/counterparties/origins.js';
import { registerPayment } from '../src/modules/orders/service.js';
import { recordTrm } from '../src/modules/pricing/service.js';
import { reconcileAccount } from '../src/modules/reconciliation/service.js';
import { acceptQuote, createQuote, createRequest } from '../src/modules/trading/service.js';
import { baseUnitsToUsdt, fmt } from '../src/platform/money.js';
import { SYSTEM_ACTOR } from '../src/platform/context.js';
import { actorOf, as, DATABASE_URL, setupEnv, type Env } from '../test/v1/helpers.js';

// Flujo de extremo a extremo contra un nodo TRON REAL (Nile), solo de lectura: el producto detecta un
// depósito real, exige bloque irreversible, valida contrato y origen aprobado, acredita una sola vez con
// revisiones simultáneas y concilia contra el extracto de la red. No firma, no envía, no mueve fondos.
//
// Usa una base de PRUEBA que se BORRA (TEST_DATABASE_URL, su nombre debe contener "test" o "e2e").
// Variables, además de TRON_RPC_URL, TRON_USDT_CONTRACT y TRON_API_KEY (opcional):
//   TRON_E2E_TX_HASH            depósito USDT real, ya visible en el explorador
//   TRON_E2E_DESK               dirección que lo recibió (hace de billetera de la mesa)
//   TRON_E2E_FROM               dirección que lo envió (hace de billetera aprobada del cliente)
//   TRON_E2E_AMOUNT_BASE_UNITS  monto en unidades base, tal como lo muestra el explorador
// Informe en test-real/out/tron-e2e-*.json.

const env = process.env;
const need = ['TRON_RPC_URL', 'TRON_USDT_CONTRACT', 'TRON_E2E_TX_HASH', 'TRON_E2E_DESK', 'TRON_E2E_FROM', 'TRON_E2E_AMOUNT_BASE_UNITS'];
const missing = need.filter((k) => !env[k]?.trim());
const HASH = env.TRON_E2E_TX_HASH?.trim().toLowerCase() ?? '';
const DESK = env.TRON_E2E_DESK?.trim() ?? '';
const FROM = env.TRON_E2E_FROM?.trim() ?? '';
const BASE_UNITS = env.TRON_E2E_AMOUNT_BASE_UNITS?.trim() ?? '';
const MAINNET_USDT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'; // tether.to; aquí solo sirve como contrato equivocado

const report: Record<string, unknown> = { at: new Date().toISOString(), endpoint: env.TRON_RPC_URL ?? null, database: DATABASE_URL.replace(/\/\/[^@]*@/, '//***@') };
function save() {
  mkdirSync(new URL('./out/', import.meta.url), { recursive: true });
  const file = new URL(`./out/tron-e2e-${String(report.at).replace(/[:.]/g, '-')}.json`, import.meta.url);
  writeFileSync(file, JSON.stringify(report, null, 2));
}

const realIntegrations = (env2: Env, contract = env.TRON_USDT_CONTRACT!): Integrations =>
  buildIntegrations(env2.db, { TRON_READER: 'trongrid', TRON_RPC_URL: env.TRON_RPC_URL, TRON_API_KEY: env.TRON_API_KEY, TRON_USDT_CONTRACT: contract });

async function post(path: string, body?: unknown) {
  const res = await fetch(`${env.TRON_RPC_URL!.replace(/\/+$/, '')}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(env.TRON_API_KEY ? { 'TRON-PRO-API-KEY': env.TRON_API_KEY.trim() } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return (await res.json()) as Record<string, any>;
}

/** Base nueva con la mesa recibiendo en DESK. Con `approve`, FROM queda aprobada para Andina. */
async function freshDesk(approve: boolean) {
  const e = await setupEnv();
  const andina = (await e.db.query(`SELECT id FROM otc.counterparties WHERE document_number = '900000001'`)).rows[0].id as string;
  await e.db.query(`UPDATE otc.accounts SET external_ref = $1 WHERE code = 'WALLET_TRON_DEMO'`, [DESK]);
  if (approve) {
    const o = await as(e, 'trader', (ctx) => proposeOrigin(ctx, andina, { network: 'TRON', address: FROM, label: 'Origen de la prueba E2E' }));
    await as(e, 'cumplimiento', (ctx) => decideOrigin(ctx, o.id as string, true, 'Billetera de la prueba E2E en Nile'));
  }
  await as(e, 'trader', (ctx) => recordTrm(ctx, { rate: '4000' }));
  return { e, andina };
}

/** La mesa compra exactamente el monto del depósito y el cliente registra el hash real. */
async function orderFor(e: Env, andina: string) {
  const usdtAmount = fmt(baseUnitsToUsdt(BASE_UNITS, 'TRON'));
  const req = await as(e, 'trader', (ctx) => createRequest(ctx, { counterpartyId: andina, side: 'BUY', usdtAmount, network: 'TRON' }));
  const q = await as(e, 'trader', (ctx) => createQuote(ctx, req.id));
  const r = await as(e, 'trader', (ctx) => acceptQuote(ctx, q.id));
  if (!r.ok) throw r.error;
  const paid = await as(e, 'trader', (ctx) => registerPayment(ctx, r.order.id, { reference: HASH }));
  return { orderId: r.order.id as string, transferId: paid.transfer.id as string };
}

const count = async (e: Env, sql: string, args: unknown[]) => (await e.db.query(sql, args)).rows[0].n as number;
const entriesOf = (e: Env, orderId: string) => count(e, 'SELECT count(*)::int AS n FROM otc.journal_entries WHERE order_id = $1', [orderId]);
const noteOf = async (e: Env, id: string) => (await e.db.query('SELECT note FROM otc.observations WHERE transfer_id = $1 ORDER BY id DESC LIMIT 1', [id])).rows[0]?.note;

describe.skipIf(missing.length > 0)('TRON real de extremo a extremo (solo lectura)', () => {
  let current: Env | null = null;
  afterEach(async () => {
    save();
    await current?.close();
    current = null;
  });

  it('la base es de prueba (se borra)', () => {
    expect(new URL(DATABASE_URL).pathname).toMatch(/test|e2e/i);
  });

  it('1. detección: el depósito está en un bloque irreversible, con el contrato, origen, destino y monto esperados', async () => {
    const cfg = tronConfigFromEnv({ ...env, TRON_READER: 'trongrid' })!;
    expect(cfg.usdtContract).not.toBe(MAINNET_USDT); // en Nile no vale el contrato de la red principal
    const head = await post('/wallet/getnowblock');
    const solid = await post('/walletsolidity/getnowblock');
    const info = await post('/walletsolidity/gettransactioninfobyid', { value: HASH });
    const { e } = await freshDesk(false);
    current = e;
    const obs = await realIntegrations(e).chain.getTransaction('TRON', HASH);
    const solidHeight = solid.block_header?.raw_data?.number;
    report.detection = {
      network: env.TRON_RPC_URL, headHeight: head.block_header?.raw_data?.number, solidHeight,
      txBlock: info.blockNumber, txTime: info.blockTimeStamp ? new Date(info.blockTimeStamp).toISOString() : null, observation: obs,
    };
    expect(obs).toMatchObject({ found: true, status: 'SUCCESS', finalized: true, tokenContract: cfg.usdtContract, from: FROM, to: DESK, amountBaseUnits: BASE_UNITS });
    expect(obs.anomaly).toBeUndefined();
    expect(Number(obs.blockNumber)).toBeLessThanOrEqual(solidHeight); // bloque ya solidificado
  });

  it('2. origen no aprobado: revisión, sin asiento', async () => {
    const { e, andina } = await freshDesk(false);
    current = e;
    const d = await orderFor(e, andina);
    const r = await checkTransfer({ db: e.db, integrations: realIntegrations(e), now: e.clock.now, actor: SYSTEM_ACTOR }, d.transferId);
    report.unapprovedOrigin = { status: r.status, note: await noteOf(e, d.transferId), entries: await entriesOf(e, d.orderId) };
    expect(r.status).toBe('EN_REVISION');
    expect(await noteOf(e, d.transferId)).toContain('Origen no autorizado');
    expect(await entriesOf(e, d.orderId)).toBe(0);
  });

  it('3. contrato distinto del configurado: revisión, sin asiento', async () => {
    const { e, andina } = await freshDesk(true);
    current = e;
    const d = await orderFor(e, andina);
    const r = await checkTransfer({ db: e.db, integrations: realIntegrations(e, MAINNET_USDT), now: e.clock.now, actor: SYSTEM_ACTOR }, d.transferId);
    report.wrongContract = { status: r.status, note: await noteOf(e, d.transferId), entries: await entriesOf(e, d.orderId) };
    expect(r.status).toBe('EN_REVISION');
    expect(await noteOf(e, d.transferId)).toContain('El token no es el autorizado');
    expect(await entriesOf(e, d.orderId)).toBe(0);
  });

  it('4. acreditación: origen aprobado, revisiones simultáneas y un solo asiento; luego concilia', async () => {
    const { e, andina } = await freshDesk(true);
    current = e;
    const integrations = realIntegrations(e);
    const deps = { db: e.db, integrations, now: e.clock.now, actor: SYSTEM_ACTOR };
    const d = await orderFor(e, andina);

    // Tres revisiones y un barrido del trabajador a la vez, como dos procesos que ven el mismo depósito.
    const [a, b, c, sweep] = await Promise.all([checkTransfer(deps, d.transferId), checkTransfer(deps, d.transferId), checkTransfer(deps, d.transferId), trackTransfers(deps, 0)]);
    const applied = [a, b, c, ...sweep.filter((s) => s.id === d.transferId)].filter((x) => x.applied && x.status === 'CONFIRMADA');
    const again = await checkTransfer(deps, d.transferId);
    const transfer = (await e.db.query('SELECT status FROM otc.transfers WHERE id = $1', [d.transferId])).rows[0];
    const evidence = (await e.db.query(`SELECT sandbox, payload FROM otc.observations WHERE transfer_id = $1 AND outcome = 'CONFIRMADA'`, [d.transferId])).rows;
    const calls = await count(e, `SELECT count(*)::int AS n FROM otc.integration_calls WHERE target = $1 AND sandbox = false AND ok = true`, [`TRON:${HASH}`]);
    report.credit = { status: transfer.status, confirmations: applied.length, entries: await entriesOf(e, d.orderId), recheckApplied: again.applied, evidence, realCalls: calls };
    expect(transfer.status).toBe('CONFIRMADA');
    expect(applied).toHaveLength(1);
    expect(await entriesOf(e, d.orderId)).toBe(1);
    expect(again.applied).toBe(false);
    expect(evidence).toHaveLength(1);
    expect(evidence[0]).toMatchObject({ sandbox: false, payload: { finalized: true, from: FROM, to: DESK, amount: BASE_UNITS } });

    // Conciliación del día del depósito (hora de Bogotá) contra el extracto real de TronGrid.
    const info = await post('/walletsolidity/gettransactioninfobyid', { value: HASH });
    const day = new Date(info.blockTimeStamp - 5 * 3600_000).toISOString().slice(0, 10);
    const wallet = (await e.db.query(`SELECT id FROM otc.accounts WHERE code = 'WALLET_TRON_DEMO'`)).rows[0].id;
    const trader = await actorOf(e.db, 'trader');
    const run = await reconcileAccount({ db: e.db, integrations, now: e.clock.now, actor: trader }, wallet, day);
    const items = await e.db.query(
      `SELECT m.external_ref, m.sandbox, i.status FROM otc.recon_items i JOIN otc.external_movements m ON m.id = i.external_movement_id WHERE i.run_id = $1`,
      [run.runId],
    );
    const ours = items.rows.find((r) => r.external_ref.toLowerCase() === HASH);
    report.reconciliation = { day, runStatus: run.status, statementLines: run.lines, ours, others: items.rows.length - (ours ? 1 : 0) };
    expect(ours).toMatchObject({ status: 'CONCILIADA', sandbox: false });
  });
});

describe.runIf(missing.length > 0)('TRON real de extremo a extremo: configuración', () => {
  it('faltan variables', () => {
    throw new Error(`Faltan variables para la prueba E2E: ${missing.join(', ')}`);
  });
});
