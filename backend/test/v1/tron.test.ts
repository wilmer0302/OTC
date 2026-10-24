import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inTransaction } from '../../src/platform/tx.js';
import { SYSTEM_ACTOR } from '../../src/platform/context.js';
import { buildIntegrations, tronConfigFromEnv } from '../../src/integrations/factory.js';
import type { ChainReader, Integrations } from '../../src/integrations/ports.js';
import { ChainRouter } from '../../src/integrations/router.js';
import { SANDBOX_USDT_CONTRACT, SandboxBank, SandboxChain } from '../../src/integrations/sandbox.js';
import { isValidTronAddress, tronBase58ToHex, tronHexToBase58 } from '../../src/integrations/tron/address.js';
import { TRC20_TRANSFER_TOPIC, TronGridReader } from '../../src/integrations/tron/reader.js';
import { checkTransfer } from '../../src/modules/confirmations/service.js';
import { decideOrigin, proposeOrigin, revokeOrigin } from '../../src/modules/counterparties/origins.js';
import { registerPayment } from '../../src/modules/orders/service.js';
import { recordTrm } from '../../src/modules/pricing/service.js';
import { simulateFor } from '../../src/modules/sandbox/service.js';
import { acceptQuote, createQuote, createRequest } from '../../src/modules/trading/service.js';
import { actorOf, as, expectCode, setupEnv, type Env } from './helpers.js';

// Lector REAL de TRON con un nodo FALSO: las respuestas tienen la forma que muestra la documentación
// oficial (developers.tron.network), pero no vienen de la red. Estas pruebas no se conectan a TRON.
// Las direcciones y el contrato de prueba se generan aquí; no son de nadie ni son el USDT real.

const addr = (n: number) => tronHexToBase58(n.toString(16).padStart(40, '0'))!;
const TEST_USDT = addr(0xc0ffee); // contrato de PRUEBA, solo para estas pruebas
const OTHER_TOKEN = addr(0xbad);
const DESK = addr(0xd35c);
const CLIENT = addr(0xa11ce);
const STRANGER = addr(0x5757);
const hex = (a: string) => tronBase58ToHex(a)!;
const topic = (a: string) => '0'.repeat(24) + hex(a).slice(2);

function transferLog(contract: string, from: string, to: string, amount: bigint) {
  return { address: hex(contract), topics: [TRC20_TRANSFER_TOPIC, topic(from), topic(to)], data: amount.toString(16).padStart(64, '0') };
}
function receipt(hash: string, logs: unknown[], extra: Record<string, unknown> = {}) {
  return { id: hash, blockNumber: 61_000_000, blockTimeStamp: 1_761_270_000_000, receipt: { result: 'SUCCESS' }, log: logs, ...extra };
}

/** Nodo falso: guarda qué sabe de cada hash y cuenta las llamadas. `down` simula un nodo caído. */
function fakeNode() {
  const solid = new Map<string, unknown>();
  const head = new Map<string, unknown>();
  const pool = new Set<string>();
  const calls: { path: string; headers: Record<string, string> }[] = [];
  const state = { down: 0, trc20Pages: [] as unknown[] };
  const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
  const f = (async (url: string | URL, init?: RequestInit) => {
    const u = new URL(String(url));
    calls.push({ path: u.pathname, headers: (init?.headers ?? {}) as Record<string, string> });
    if (state.down > 0) {
      state.down--;
      return json({}, 503);
    }
    const value = init?.body ? (JSON.parse(String(init.body)).value as string) : '';
    if (u.pathname === '/walletsolidity/gettransactioninfobyid') return json(solid.get(value) ?? {});
    if (u.pathname === '/wallet/gettransactioninfobyid') return json(head.get(value) ?? {});
    if (u.pathname === '/wallet/gettransactionbyid') return json(pool.has(value) ? { txID: value } : {});
    if (u.pathname.endsWith('/transactions/trc20')) return json(state.trc20Pages.shift() ?? { success: true, data: [], meta: {} });
    return json({ Error: 'ruta desconocida' });
  }) as typeof fetch;
  return { fetch: f, solid, head, pool, calls, state };
}

const reader = (node: ReturnType<typeof fakeNode>, apiKey?: string) =>
  new TronGridReader({ rpcUrl: 'https://nodo-de-prueba.invalid', apiKey, usdtContract: TEST_USDT, timeoutMs: 2000, fetch: node.fetch });

let counter = 0;
const newHash = () => (++counter).toString(16).padStart(64, 'f');

describe('direcciones TRON (Base58Check)', () => {
  it('valida la suma de control y el prefijo, e ida y vuelta con hexadecimal', () => {
    expect(isValidTronAddress(DESK)).toBe(true);
    expect(tronHexToBase58(hex(DESK))).toBe(DESK);
    expect(tronHexToBase58(hex(DESK).slice(2))).toBe(DESK); // sin el prefijo 41 también
    // Contrato USDT TRC-20 publicado por Tether en tether.to/en/supported-protocols (consultado el 2026-10-24).
    expect(isValidTronAddress('TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t')).toBe(true);
    // Un carácter cambiado rompe la suma de control; las direcciones de la demo no son direcciones reales.
    expect(isValidTronAddress(DESK.slice(0, -1) + (DESK.endsWith('1') ? '2' : '1'))).toBe(false);
    expect(isValidTronAddress('TDemo1AndinaRemitente1111111111111')).toBe(false);
    expect(isValidTronAddress(SANDBOX_USDT_CONTRACT.TRON)).toBe(false);
    expect(tronHexToBase58('zz')).toBeNull();
  });
});

describe('lector TRON con nodo falso', () => {
  it('transferencia válida solidificada: origen, destino, contrato, monto y bloque', async () => {
    const node = fakeNode();
    const h = newHash();
    node.solid.set(h, receipt(h, [transferLog(TEST_USDT, CLIENT, DESK, 100_000_000n)]));
    const obs = await reader(node).getTransaction('TRON', h.toUpperCase());
    expect(obs).toMatchObject({ found: true, status: 'SUCCESS', finalized: true, from: CLIENT, to: DESK, tokenContract: TEST_USDT, amountBaseUnits: '100000000', blockNumber: '61000000' });
    expect(obs.anomaly).toBeUndefined();
  });

  it('en un bloque sin solidificar o solo transmitida: pendiente, nunca exitosa ni fallida', async () => {
    const node = fakeNode();
    const a = newHash();
    node.head.set(a, receipt(a, [transferLog(TEST_USDT, CLIENT, DESK, 1n)], { receipt: { result: 'REVERT' } }));
    expect(await reader(node).getTransaction('TRON', a)).toMatchObject({ found: true, status: 'PENDING', finalized: false });
    const b = newHash();
    node.pool.add(b);
    expect(await reader(node).getTransaction('TRON', b)).toMatchObject({ found: true, status: 'PENDING', finalized: false });
    expect(await reader(node).getTransaction('TRON', newHash())).toMatchObject({ found: false });
  });

  it('falla de ejecución en un bloque solidificado: FAILED', async () => {
    const node = fakeNode();
    const h = newHash();
    node.solid.set(h, receipt(h, [], { receipt: { result: 'REVERT' }, result: 'FAILED' }));
    expect(await reader(node).getTransaction('TRON', h)).toMatchObject({ status: 'FAILED', finalized: true });
  });

  it('otro token: informa su contrato para que el control lo rechace; sin eventos no informa contrato', async () => {
    const node = fakeNode();
    const a = newHash();
    node.solid.set(a, receipt(a, [transferLog(OTHER_TOKEN, CLIENT, DESK, 100_000_000n)]));
    expect((await reader(node).getTransaction('TRON', a)).tokenContract).toBe(OTHER_TOKEN);
    const b = newHash();
    node.solid.set(b, receipt(b, []));
    const none = await reader(node).getTransaction('TRON', b);
    expect(none.tokenContract).toBeUndefined();
    expect(none.amountBaseUnits).toBeUndefined();
  });

  it('información incompleta o ambigua: anomalía', async () => {
    const node = fakeNode();
    const cases: [unknown, string][] = [
      [receipt('x', [transferLog(TEST_USDT, CLIENT, DESK, 1n), transferLog(TEST_USDT, CLIENT, DESK, 1n)]), 'transferencias del USDT autorizado'],
      [{ ...receipt('x', [transferLog(TEST_USDT, CLIENT, DESK, 1n)]), blockNumber: undefined }, 'no informó el bloque'],
      [{ ...receipt('x', [transferLog(TEST_USDT, CLIENT, DESK, 1n)]), receipt: {} }, 'no informó el resultado'],
      [{ ...receipt('x', []), log: [{ address: hex(TEST_USDT), topics: [TRC20_TRANSFER_TOPIC], data: '00' }] }, 'formato no reconocido'],
    ];
    for (const [info, expected] of cases) {
      const h = newHash();
      node.solid.set(h, { ...(info as object), id: h });
      expect((await reader(node).getTransaction('TRON', h)).anomaly).toContain(expected);
    }
    const h = newHash();
    node.solid.set(h, receipt(newHash(), [transferLog(TEST_USDT, CLIENT, DESK, 1n)]));
    expect((await reader(node).getTransaction('TRON', h)).anomaly).toContain('no corresponde al hash');
  });

  it('referencia que no es un hash: no consulta la red', async () => {
    const node = fakeNode();
    expect(await reader(node).getTransaction('TRON', 'PAGO-123')).toMatchObject({ found: false });
    expect(node.calls).toHaveLength(0);
  });

  it('errores del RPC: HTTP, cuerpo con Error, JSON inválido o sin respuesta lanzan error; la llave no aparece', async () => {
    const node = fakeNode();
    node.state.down = 1;
    await expect(reader(node, 'llave-secreta').getTransaction('TRON', newHash())).rejects.toThrow('HTTP 503');
    expect(node.calls[0].headers['TRON-PRO-API-KEY']).toBe('llave-secreta');

    const withError = new TronGridReader({ rpcUrl: 'https://x.invalid', usdtContract: TEST_USDT, timeoutMs: 2000, fetch: (async () => new Response(JSON.stringify({ Error: 'class org.tron.core.exception.BadItemException' }))) as typeof fetch });
    await expect(withError.getTransaction('TRON', newHash())).rejects.toThrow('BadItemException');
    const notJson = new TronGridReader({ rpcUrl: 'https://x.invalid', usdtContract: TEST_USDT, timeoutMs: 2000, fetch: (async () => new Response('<html>')) as typeof fetch });
    await expect(notJson.getTransaction('TRON', newHash())).rejects.toThrow('no es JSON');
    const offline = new TronGridReader({ rpcUrl: 'https://x.invalid', apiKey: 'llave-secreta', usdtContract: TEST_USDT, timeoutMs: 2000, fetch: (async () => { throw new TypeError('fetch failed'); }) as typeof fetch });
    const err = await offline.getTransaction('TRON', newHash()).catch((e: Error) => e);
    expect((err as Error).message).toContain('sin respuesta');
    expect((err as Error).message).not.toContain('llave-secreta');
  });

  it('extracto del día: pagina con fingerprint y solo toma el USDT autorizado', async () => {
    const node = fakeNode();
    const line = (id: string, from: string, to: string, value: string, token = TEST_USDT) => ({ transaction_id: id, token_info: { address: token }, block_timestamp: Date.parse('2026-10-23T15:00:00Z'), from, to, type: 'Transfer', value });
    node.state.trc20Pages = [
      { success: true, data: [line('a1', CLIENT, DESK, '5000000'), line('a2', CLIENT, DESK, '1', OTHER_TOKEN)], meta: { fingerprint: 'pag2' } },
      { success: true, data: [line('a3', DESK, STRANGER, '2000000')], meta: {} },
    ];
    const lines = await reader(node).listTransfers('TRON', DESK, '2026-10-23');
    expect(lines.map((l) => [l.txHash, l.direction, l.amountBaseUnits])).toEqual([['a1', 'IN', '5000000'], ['a3', 'OUT', '2000000']]);
    expect(node.calls).toHaveLength(2);
  });
});

describe('configuración del lector TRON', () => {
  const ok = { TRON_READER: 'trongrid', TRON_RPC_URL: 'https://nile.trongrid.io', TRON_USDT_CONTRACT: TEST_USDT };
  it('por omisión todo es sandbox; el lector real exige URL https y un contrato válido, nunca el del simulador', () => {
    expect(tronConfigFromEnv({})).toBeNull();
    expect(() => tronConfigFromEnv({ TRON_READER: 'otro' })).toThrow('TRON_READER');
    expect(() => tronConfigFromEnv({ ...ok, TRON_RPC_URL: undefined })).toThrow('TRON_RPC_URL');
    expect(() => tronConfigFromEnv({ ...ok, TRON_RPC_URL: 'http://nodo.example.com' })).toThrow('https');
    expect(() => tronConfigFromEnv({ ...ok, TRON_RPC_URL: 'https://user:pass@nodo.example.com' })).toThrow('credenciales');
    expect(() => tronConfigFromEnv({ ...ok, TRON_USDT_CONTRACT: undefined })).toThrow('TRON_USDT_CONTRACT');
    expect(() => tronConfigFromEnv({ ...ok, TRON_USDT_CONTRACT: SANDBOX_USDT_CONTRACT.TRON })).toThrow('ficticio');
    expect(() => tronConfigFromEnv({ ...ok, TRON_USDT_CONTRACT: 'TNoEsUnaDireccionValida1111111111' })).toThrow('Base58Check');
    expect(() => tronConfigFromEnv({ ...ok, TRON_RPC_TIMEOUT_MS: '10' })).toThrow('TRON_RPC_TIMEOUT_MS');
    expect(tronConfigFromEnv({ ...ok, TRON_RPC_URL: 'http://127.0.0.1:8090' })?.rpcUrl).toBe('http://127.0.0.1:8090');
  });
  it('con el lector real, TRON deja de ser sandbox y BSC sigue simulada', () => {
    const i = buildIntegrations(null as never, ok, { fetch: fakeNode().fetch });
    expect(i.chain.sandboxFor?.('TRON')).toBe(false);
    expect(i.chain.sandboxFor?.('BSC')).toBe(true);
    expect(i.chain.usdtContract('TRON')).toBe(TEST_USDT);
    expect(i.chain.usdtContract('BSC')).toBe(SANDBOX_USDT_CONTRACT.BSC);
  });
});

describe('depósitos TRON con el lector real (nodo falso) y la base de datos', () => {
  let env: Env;
  let andina: string;
  let real: Integrations;
  let node: ReturnType<typeof fakeNode>;
  let pendingSeconds: number;

  const check = (transferId: string) => checkTransfer({ db: env.db, integrations: real, now: env.clock.now, actor: SYSTEM_ACTOR }, transferId);
  const entries = async (orderId: string) => (await env.db.query('SELECT count(*)::int AS n FROM otc.journal_entries WHERE order_id = $1', [orderId])).rows[0].n;
  const statusOf = async (id: string) => (await env.db.query('SELECT status FROM otc.transfers WHERE id = $1', [id])).rows[0].status;
  const lastNote = async (id: string) => (await env.db.query('SELECT note FROM otc.observations WHERE transfer_id = $1 ORDER BY id DESC LIMIT 1', [id])).rows[0]?.note;

  /** Orden en la que la mesa compra 100 USDT por TRON; el cliente registra el hash. */
  async function order(hash = newHash()) {
    const req = await as(env, 'trader', (ctx) => createRequest(ctx, { counterpartyId: andina, side: 'BUY', usdtAmount: '100', network: 'TRON' }));
    const q = await as(env, 'trader', (ctx) => createQuote(ctx, req.id));
    const r = await as(env, 'trader', (ctx) => acceptQuote(ctx, q.id));
    if (!r.ok) throw r.error;
    const paid = await as(env, 'trader', (ctx) => registerPayment(ctx, r.order.id, { reference: hash }));
    return { orderId: r.order.id as string, transferId: paid.transfer.id as string, hash };
  }

  beforeAll(async () => {
    env = await setupEnv();
    node = fakeNode();
    real = {
      chain: new ChainRouter({
        TRON: new TronGridReader({ rpcUrl: 'https://nodo-de-prueba.invalid', usdtContract: TEST_USDT, timeoutMs: 2000, fetch: node.fetch }),
        BSC: new SandboxChain(env.db),
      }),
      bank: new SandboxBank(env.db),
    };
    andina = (await env.db.query(`SELECT id FROM otc.counterparties WHERE document_number = '900000001'`)).rows[0].id;
    await env.db.query(`UPDATE otc.accounts SET external_ref = $1 WHERE code = 'WALLET_TRON_DEMO'`, [DESK]);
    const o = await as(env, 'trader', (ctx) => proposeOrigin(ctx, andina, { network: 'TRON', address: CLIENT, label: 'Tesorería (prueba)' }));
    await as(env, 'cumplimiento', (ctx) => decideOrigin(ctx, o.id as string, true, 'Billetera de prueba verificada'));
    await as(env, 'trader', (ctx) => recordTrm(ctx, { rate: '4000' }));
    pendingSeconds = (await env.db.query('SELECT transfer_pending_seconds AS s FROM otc.desk_settings ORDER BY id DESC LIMIT 1')).rows[0].s;
  });
  afterAll(async () => env.close());

  it('depósito válido y solidificado: se acredita una sola vez aunque se revise de nuevo', async () => {
    const d = await order();
    node.solid.set(d.hash, receipt(d.hash, [transferLog(TEST_USDT, CLIENT, DESK, 100_000_000n)]));
    expect((await check(d.transferId)).status).toBe('CONFIRMADA');
    expect(await entries(d.orderId)).toBe(1);
    const again = await check(d.transferId);
    expect(again.applied).toBe(false);
    expect(await entries(d.orderId)).toBe(1);
    const obs = await env.db.query(`SELECT sandbox, payload FROM otc.observations WHERE transfer_id = $1 AND outcome = 'CONFIRMADA'`, [d.transferId]);
    expect(obs.rows[0].sandbox).toBe(false); // evidencia del lector real, no del simulador
    expect(obs.rows[0].payload).toMatchObject({ blockNumber: '61000000', finalized: true, from: CLIENT, tokenContract: TEST_USDT });
  });

  it('el mismo hash no se registra en otra orden, ni cambiando mayúsculas', async () => {
    const d = await order();
    await expectCode(order(d.hash.toUpperCase()), 'DUPLICATE_REFERENCE');
  });

  it('contrato incorrecto u origen no autorizado: revisión, sin asiento', async () => {
    const a = await order();
    node.solid.set(a.hash, receipt(a.hash, [transferLog(OTHER_TOKEN, CLIENT, DESK, 100_000_000n)]));
    expect((await check(a.transferId)).status).toBe('EN_REVISION');
    expect(await lastNote(a.transferId)).toContain('El token no es el autorizado');
    expect(await entries(a.orderId)).toBe(0);

    const b = await order();
    node.solid.set(b.hash, receipt(b.hash, [transferLog(TEST_USDT, STRANGER, DESK, 100_000_000n)]));
    expect((await check(b.transferId)).status).toBe('EN_REVISION');
    expect(await lastNote(b.transferId)).toContain('Origen no autorizado');
    expect(await entries(b.orderId)).toBe(0);
  });

  it('transacción fallida: queda fallida, sin asiento', async () => {
    const d = await order();
    node.solid.set(d.hash, receipt(d.hash, [], { receipt: { result: 'OUT_OF_ENERGY' }, result: 'FAILED' }));
    expect((await check(d.transferId)).status).toBe('FALLIDA');
    expect(await entries(d.orderId)).toBe(0);
  });

  it('información incompleta, ambigua o sin eventos: revisión, sin asiento', async () => {
    const infos = [
      (h: string) => ({ ...receipt(h, [transferLog(TEST_USDT, CLIENT, DESK, 100_000_000n)]), receipt: {} }),
      (h: string) => receipt(h, [transferLog(TEST_USDT, CLIENT, DESK, 50_000_000n), transferLog(TEST_USDT, CLIENT, DESK, 50_000_000n)]),
      (h: string) => receipt(h, []),
    ];
    for (const build of infos) {
      const d = await order();
      node.solid.set(d.hash, build(d.hash));
      expect((await check(d.transferId)).status).toBe('EN_REVISION');
      expect(await entries(d.orderId)).toBe(0);
    }
  });

  it('sin solidificar no se acredita; cuando se solidifica, sí', async () => {
    const d = await order();
    node.head.set(d.hash, receipt(d.hash, [transferLog(TEST_USDT, CLIENT, DESK, 100_000_000n)]));
    expect((await check(d.transferId)).status).toBe('PENDIENTE');
    expect(await entries(d.orderId)).toBe(0);
    node.solid.set(d.hash, receipt(d.hash, [transferLog(TEST_USDT, CLIENT, DESK, 100_000_000n)]));
    expect((await check(d.transferId)).status).toBe('CONFIRMADA');
    expect(await entries(d.orderId)).toBe(1);
  });

  it('RPC caído: nada cambia ni se acredita, queda registrada la falla, se abre un caso y el reintento confirma', async () => {
    const d = await order();
    node.solid.set(d.hash, receipt(d.hash, [transferLog(TEST_USDT, CLIENT, DESK, 100_000_000n)]));
    node.state.down = 1;
    const r = await check(d.transferId);
    expect(r).toMatchObject({ applied: false });
    expect(await statusOf(d.transferId)).toBe('ENVIADA');
    expect(await entries(d.orderId)).toBe(0);
    const call = await env.db.query(`SELECT ok, error, sandbox FROM otc.integration_calls WHERE target = $1 ORDER BY id DESC LIMIT 1`, [`TRON:${d.hash}`]);
    expect(call.rows[0]).toMatchObject({ ok: false, sandbox: false });
    expect(call.rows[0].error).toContain('HTTP 503');

    env.clock.advance(pendingSeconds + 1);
    node.state.down = 1;
    await check(d.transferId);
    const cases = await env.db.query(`SELECT detail FROM otc.cases WHERE entity = 'transfer' AND entity_id = $1 AND status = 'ABIERTO'`, [d.transferId]);
    expect(cases.rows[0].detail).toContain('No se pudo consultar la red');

    expect((await check(d.transferId)).status).toBe('CONFIRMADA');
    expect(await entries(d.orderId)).toBe(1);
  });

  // I1: la autorización del origen se vuelve a leer dentro de la transacción que confirma.
  /** Billetera aprobada para Andina solo para una prueba, que luego la revoca. */
  async function approvedOrigin(n: number) {
    const address = addr(n);
    const o = await as(env, 'trader', (ctx) => proposeOrigin(ctx, andina, { network: 'TRON', address, label: `Revocable ${n}` }));
    await as(env, 'cumplimiento', (ctx) => decideOrigin(ctx, o.id as string, true, 'Billetera de prueba verificada'));
    return { id: o.id as string, address };
  }
  /** Integraciones cuyo lector TRON ejecuta `during` después de consultar la red y antes de devolver. */
  function hooked(during: () => Promise<void>): Integrations {
    const tron = new TronGridReader({ rpcUrl: 'https://nodo-de-prueba.invalid', usdtContract: TEST_USDT, timeoutMs: 2000, fetch: node.fetch });
    const reader: ChainReader = {
      ...tron,
      getTransaction: async (n, h) => {
        const obs = await tron.getTransaction(n, h);
        await during();
        return obs;
      },
    };
    return { chain: new ChainRouter({ TRON: reader, BSC: new SandboxChain(env.db) }), bank: real.bank };
  }
  const revoke = (id: string) => as(env, 'cumplimiento', (ctx) => revokeOrigin(ctx, id, 'Revocada durante la confirmación'));

  it('I1: revocación confirmada mientras se consulta la red: revisión, sin asiento', async () => {
    const o = await approvedOrigin(0xa11ce1);
    const d = await order();
    node.solid.set(d.hash, receipt(d.hash, [transferLog(TEST_USDT, o.address, DESK, 100_000_000n)]));
    const integrations = hooked(() => revoke(o.id).then(() => undefined));
    const r = await checkTransfer({ db: env.db, integrations, now: env.clock.now, actor: SYSTEM_ACTOR }, d.transferId);
    expect(r.status).toBe('EN_REVISION');
    expect(await lastNote(d.transferId)).toContain('Origen no autorizado');
    expect(await entries(d.orderId)).toBe(0);
  });

  it('I1: revocación en curso al decidir: la confirmación espera el bloqueo y manda a revisión, sin asiento', async () => {
    const o = await approvedOrigin(0xa11ce2);
    const d = await order();
    node.solid.set(d.hash, receipt(d.hash, [transferLog(TEST_USDT, o.address, DESK, 100_000_000n)]));
    const client = await env.db.connect();
    try {
      // Cumplimiento revoca en una transacción que todavía no confirma: la fila queda bloqueada FOR UPDATE.
      await client.query('BEGIN');
      const admin = await actorOf(env.db, 'cumplimiento');
      await revokeOrigin({ tx: client, actor: admin, integrations: real, now: env.clock.now }, o.id, 'Revocación en curso');
      const pending = check(d.transferId);
      let waiting = false;
      for (let i = 0; i < 100 && !waiting; i++) {
        await new Promise((r) => setTimeout(r, 20));
        const w = await env.db.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query ILIKE '%origin_addresses%FOR SHARE%'`);
        waiting = w.rows[0].n > 0;
      }
      expect(waiting).toBe(true); // la confirmación está esperando a la revocación
      await client.query('COMMIT');
      const r = await pending;
      expect(r.status).toBe('EN_REVISION');
      expect(await entries(d.orderId)).toBe(0);
    } finally {
      client.release();
    }
  });

  it('dos revisiones simultáneas del mismo depósito: un solo asiento y una sola confirmación', async () => {
    const d = await order();
    node.solid.set(d.hash, receipt(d.hash, [transferLog(TEST_USDT, CLIENT, DESK, 100_000_000n)]));
    const results = await Promise.all([check(d.transferId), check(d.transferId), check(d.transferId)]);
    expect(results.filter((r) => r.applied)).toHaveLength(1);
    expect(await statusOf(d.transferId)).toBe('CONFIRMADA');
    expect(await entries(d.orderId)).toBe(1);
    const confirmed = await env.db.query(`SELECT count(*)::int AS n FROM otc.observations WHERE transfer_id = $1 AND outcome = 'CONFIRMADA'`, [d.transferId]);
    expect(confirmed.rows[0].n).toBe(1);
  });

  it('con el lector real, el simulador no escribe sobre TRON', async () => {
    const d = await order();
    const admin = await actorOf(env.db, 'admin');
    await expectCode(
      inTransaction(env.db, (tx) => simulateFor({ tx, actor: admin, integrations: real, now: env.clock.now }, d.transferId, { status: 'SUCCESS', confirmations: 100 })),
      'NOT_SANDBOX',
    );
  });
});
