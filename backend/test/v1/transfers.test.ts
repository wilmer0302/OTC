import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { liquiditySummary } from '../../src/modules/liquidity/service.js';
import { approveDelivery, registerPayment, type OrderRow } from '../../src/modules/orders/service.js';
import { recordTrm } from '../../src/modules/pricing/service.js';
import { acceptQuote, createQuote, createRequest } from '../../src/modules/trading/service.js';
import { transferCanMove } from '../../src/modules/transfers/domain.js';
import {
  cancelTransfer,
  createInternalTransfer,
  prepareSigning,
  registerSent,
  retryDelivery,
  type TransferRow,
} from '../../src/modules/transfers/service.js';
import { as, call, confirmCollection, expectCode, httpLogin, newKey, setupEnv, stepUp, type Env } from './helpers.js';

const hash = (n: number, net: 'TRON' | 'BSC') => (net === 'BSC' ? '0x' : '') + n.toString(16).padStart(64, 'c');

describe('reglas de las transferencias', () => {
  it('una fallida nunca se reactiva y nada se confirma sin haberse enviado', () => {
    expect(transferCanMove('FALLIDA', 'AUTORIZADA')).toBe(false);
    expect(transferCanMove('AUTORIZADA', 'CONFIRMADA')).toBe(false);
    expect(transferCanMove('ENVIADA', 'CANCELADA')).toBe(false);
    expect(transferCanMove('EN_REVISION', 'CONFIRMADA')).toBe(true);
  });
});

describe('envíos, reintentos y traslados', () => {
  let env: Env;
  let andina: string;
  let refs = 0;

  async function authorizedOrder(side: 'BUY' | 'SELL', usdtAmount: string, network: 'TRON' | 'BSC' = 'TRON') {
    const req = await as(env, 'trader', (ctx) => createRequest(ctx, { counterpartyId: andina, side, usdtAmount, network }));
    const q = await as(env, 'trader', (ctx) => createQuote(ctx, req.id));
    const r = await as(env, 'trader', (ctx) => acceptQuote(ctx, q.id));
    if (!r.ok) throw r.error;
    const ref = side === 'SELL' ? `BCOL-${++refs}` : hash(++refs + 1000, network);
    await as(env, 'trader', (ctx) => registerPayment(ctx, r.order.id, { reference: ref }));
    await confirmCollection(env, r.order.id);
    const a = await as(env, 'trader', (ctx) => approveDelivery(ctx, r.order.id, null));
    return { order: a.order as OrderRow, transfer: a.transfer as TransferRow };
  }
  const available = async (code: string) => (await as(env, 'trader', (ctx) => liquiditySummary(ctx))).find((a) => a.code === code)!;
  const orderStatus = async (id: string) => (await env.db.query('SELECT status FROM otc.orders WHERE id = $1', [id])).rows[0].status;

  beforeAll(async () => {
    env = await setupEnv();
    andina = (await env.db.query(`SELECT id FROM otc.counterparties WHERE document_number = '900000001'`)).rows[0].id;
    await as(env, 'trader', (ctx) => recordTrm(ctx, { rate: '4000' }));
  });
  afterAll(async () => env.close());

  it('USDT: instrucción sin campos editables, firma fuera, hash único y la orden pasa a Entrega enviada', async () => {
    const { order, transfer } = await authorizedOrder('SELL', '1000');
    await expectCode(as(env, 'trader', (ctx) => registerSent(ctx, transfer.id, hash(1, 'TRON'))), 'INVALID_STATE');
    const s = await as(env, 'trader', (ctx) => prepareSigning(ctx, transfer.id));
    expect(s.transfer.status).toBe('EN_FIRMA');
    expect(s.instruction).toMatchObject({
      rail: 'TRON',
      asset: 'USDT',
      amount: '1000.000000',
      amountBaseUnits: '1000000000',
      from: { account: 'WALLET_TRON_DEMO', ref: 'TDemoMesaTronFicticia1111111111111' },
      to: { kind: 'CLIENTE', value: 'TDemo1AndinaFicticia11111111111111' },
    });
    // Repetir la preparación no cambia nada.
    expect((await as(env, 'trader', (ctx) => prepareSigning(ctx, transfer.id))).transfer.status).toBe('EN_FIRMA');

    await expectCode(as(env, 'trader', (ctx) => registerSent(ctx, transfer.id, '0x' + hash(1, 'TRON'))), 'INVALID');
    const sent = await as(env, 'trader', (ctx) => registerSent(ctx, transfer.id, hash(1, 'TRON')));
    expect(sent.transfer).toMatchObject({ status: 'ENVIADA', external_ref: hash(1, 'TRON') });
    expect(sent.order?.status).toBe('ENTREGA_ENVIADA');
    await expectCode(as(env, 'trader', (ctx) => cancelTransfer(ctx, transfer.id, 'ya salió')), 'INVALID_TRANSITION');
    await expect(env.db.query(`UPDATE otc.transfers SET external_ref = 'otro' WHERE id = $1`, [transfer.id])).rejects.toThrow(/no cambia/);

    // El mismo hash no sirve para otra entrega.
    const other = await authorizedOrder('SELL', '10');
    await as(env, 'trader', (ctx) => prepareSigning(ctx, other.transfer.id));
    const dup = await expectCode(as(env, 'trader', (ctx) => registerSent(ctx, other.transfer.id, hash(1, 'TRON').toUpperCase())), 'DUPLICATE_REFERENCE');
    expect((dup as Error).message).toBe(`Esta referencia ya está registrada en la orden ${order.number}`);
  });

  it('en BSC el monto va en 18 decimales', async () => {
    const { transfer } = await authorizedOrder('SELL', '1.5', 'BSC');
    const s = await as(env, 'trader', (ctx) => prepareSigning(ctx, transfer.id));
    expect(s.instruction.amountBaseUnits).toBe('1500000000000000000');
  });

  it('pesos: sin firma, se registra la referencia del banco', async () => {
    const { order, transfer } = await authorizedOrder('BUY', '100');
    expect(transfer).toMatchObject({ rail: 'BANK', asset: 'COP' });
    await expectCode(as(env, 'trader', (ctx) => prepareSigning(ctx, transfer.id)), 'INVALID');
    const sent = await as(env, 'trader', (ctx) => registerSent(ctx, transfer.id, 'PAGO-BCOL-0001'));
    expect(sent.transfer.status).toBe('ENVIADA');
    expect(await orderStatus(order.id)).toBe('ENTREGA_ENVIADA');
  });

  it('cancelar un envío antes de salir devuelve la reserva a la orden; el reintento es otra transferencia enlazada', async () => {
    const { order, transfer } = await authorizedOrder('SELL', '200');
    await as(env, 'trader', (ctx) => prepareSigning(ctx, transfer.id));
    await expectCode(as(env, 'trader', (ctx) => retryDelivery(ctx, transfer.id, 'aún no falla')), 'INVALID_STATE');
    await as(env, 'trader', (ctx) => cancelTransfer(ctx, transfer.id, 'Se digitó mal en la billetera (prueba)'));
    const res = await env.db.query('SELECT status, transfer_id FROM otc.reservations WHERE order_id = $1', [order.id]);
    expect(res.rows[0]).toEqual({ status: 'ACTIVE', transfer_id: null });
    expect(await orderStatus(order.id)).toBe('ENTREGA_AUTORIZADA');

    await expectCode(as(env, 'auditor', (ctx) => retryDelivery(ctx, transfer.id, 'x')), 'FORBIDDEN');
    const retry = await as(env, 'tesorero2', (ctx) => retryDelivery(ctx, transfer.id, 'Reintento aprobado (prueba)'));
    expect(retry).toMatchObject({ retry_of: transfer.id, status: 'AUTORIZADA', amount: '200.000000' });
    const res2 = await env.db.query('SELECT status, transfer_id FROM otc.reservations WHERE order_id = $1', [order.id]);
    expect(res2.rows[0]).toEqual({ status: 'LOCKED', transfer_id: retry.id });
    // La cancelada ya tiene su reintento: no se reintenta dos veces.
    await expect(as(env, 'tesorero2', (ctx) => retryDelivery(ctx, transfer.id, 'otra vez'))).rejects.toThrow();
  });

  it('traslado propio: sale del disponible de origen de inmediato y cancelarlo antes de enviar lo libera', async () => {
    const binance = await available('BINANCE_USDT_DEMO');
    const tron = await available('WALLET_TRON_DEMO');
    const t = await as(env, 'trader', (ctx) =>
      createInternalTransfer(ctx, { fromAccountId: binance.id, toAccountId: tron.id, amount: '10000', reason: 'Reponer la billetera (prueba)' }),
    );
    expect(t).toMatchObject({ purpose: 'TRASLADO', rail: 'TRON', status: 'AUTORIZADA', to_account_id: tron.id });
    const after = await available('BINANCE_USDT_DEMO');
    expect(after.balance).toBe(binance.balance); // el saldo contable no cambia hasta confirmar
    expect(Number(binance.available) - Number(after.available)).toBe(10000);
    expect((await available('WALLET_TRON_DEMO')).available).toBe(tron.available); // y el destino no sube todavía

    const s = await as(env, 'trader', (ctx) => prepareSigning(ctx, t.id));
    expect(s.instruction.to).toEqual({ kind: 'CUENTA_PROPIA', value: 'TDemoMesaTronFicticia1111111111111' });
    await as(env, 'trader', (ctx) => cancelTransfer(ctx, t.id, 'Ya no hace falta (prueba)'));
    expect((await available('BINANCE_USDT_DEMO')).available).toBe(binance.available);
  });

  it('traslados inválidos se rechazan con el motivo', async () => {
    const [bank, tron, bsc, binance] = await Promise.all(
      ['BANCOLOMBIA_COP_DEMO', 'WALLET_TRON_DEMO', 'WALLET_BSC_DEMO', 'BINANCE_USDT_DEMO'].map(available),
    );
    const move = (from: string, to: string, amount: string) =>
      as(env, 'trader', (ctx) => createInternalTransfer(ctx, { fromAccountId: from, toAccountId: to, amount, reason: 'prueba' }));
    await expectCode(move(bank.id, tron.id, '1'), 'INVALID');
    await expectCode(move(tron.id, bsc.id, '1'), 'INVALID');
    await expectCode(move(binance.id, tron.id, '1.0000001'), 'INVALID');
    await expectCode(move(binance.id, bsc.id, '50000.000001'), 'INSUFFICIENT_LIQUIDITY');
    await expectCode(as(env, 'auditor', (ctx) => createInternalTransfer(ctx, { fromAccountId: binance.id, toAccountId: bsc.id, amount: '1', reason: 'x' })), 'FORBIDDEN');
  });

  it('por HTTP: firma, registro del hash y lista de envíos pendientes por antigüedad', async () => {
    const { transfer } = await authorizedOrder('SELL', '300');
    const op = await httpLogin(env, 'trader');
    const s = await call(env, op, 'POST', `/transfers/${transfer.id}/signing`, undefined, { 'idempotency-key': newKey() });
    expect(s.body.instruction.amountBaseUnits).toBe('300000000');
    const sent = await call(env, op, 'POST', `/transfers/${transfer.id}/sent`, { reference: hash(99, 'TRON') }, { 'idempotency-key': newKey() });
    expect(sent.body.transfer.status).toBe('ENVIADA');
    const list = await call(env, op, 'GET', '/transfers?status=ENVIADA&purpose=ENTREGA');
    expect(list.body.map((t: { id: string }) => t.id)).toContain(transfer.id);
    const detail = await call(env, op, 'GET', `/transfers/${transfer.id}`);
    expect(detail.body.history.map((h: { to_status: string }) => h.to_status)).toEqual(['AUTORIZADA', 'EN_FIRMA', 'ENVIADA']);

    const accounts = (await call(env, op, 'GET', '/liquidity')).body as Array<{ id: string; code: string }>;
    const id = (c: string) => accounts.find((a) => a.code === c)!.id;
    const body = { fromAccountId: id('BINANCE_USDT_DEMO'), toAccountId: id('WALLET_BSC_DEMO'), amount: '5', reason: 'Prueba' };
    expect((await call(env, op, 'POST', '/transfers/internal', body, { 'idempotency-key': newKey() })).body.code).toBe('STEP_UP_REQUIRED');
    const ok = await call(env, op, 'POST', '/transfers/internal', body, { 'idempotency-key': newKey(), ...stepUp(env, 'trader') });
    expect(ok.status).toBe(201);
  });
});
