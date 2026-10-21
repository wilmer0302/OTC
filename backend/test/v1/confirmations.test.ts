import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runSweeps } from '../../src/jobs/sweeps.js';
import { sandboxIntegrations } from '../../src/integrations/sandbox.js';
import { decide, type Expected } from '../../src/modules/confirmations/domain.js';
import { checkTransfer, resolveTransferReview } from '../../src/modules/confirmations/service.js';
import { accountByCode, verifyBalances } from '../../src/modules/liquidity/service.js';
import { approveDelivery, registerPayment, resolveReview, type OrderRow } from '../../src/modules/orders/service.js';
import { recordTrm } from '../../src/modules/pricing/service.js';
import { simulateFor } from '../../src/modules/sandbox/service.js';
import { acceptQuote, createQuote, createRequest } from '../../src/modules/trading/service.js';
import { createInternalTransfer, prepareSigning, registerSent, retryDelivery, type TransferRow } from '../../src/modules/transfers/service.js';
import { SYSTEM_ACTOR } from '../../src/platform/context.js';
import { as, call, checkNow, confirmCollection, expectCode, httpLogin, newKey, setupEnv, stepUp, type Env } from './helpers.js';

const exp: Expected = { to: 'TDestino', direction: 'OUT', amount: '1000000000' };
const timing = { ageSeconds: 10, pendingSeconds: 900, reviewSeconds: 3600, requiredConfirmations: 20 };

describe('interpretación de la red y del banco', () => {
  it('sin rastro: espera, alerta al primer plazo y revisión al segundo', () => {
    expect(decide({ found: false }, exp, timing)).toEqual({ kind: 'WAIT' });
    expect(decide({ found: false }, exp, { ...timing, ageSeconds: 900 }).kind).toBe('ALERT');
    expect(decide({ found: false }, exp, { ...timing, ageSeconds: 3600 }).kind).toBe('REVIEW');
  });

  it('confirmada solo con el umbral y coincidiendo destino y monto', () => {
    const ok = { found: true, status: 'SUCCESS' as const, to: 'tdestino', amount: '1000000000' };
    expect(decide({ ...ok, confirmations: 19 }, exp, timing)).toEqual({ kind: 'PENDING', confirmations: 19 });
    expect(decide({ ...ok, confirmations: 20 }, exp, timing)).toEqual({ kind: 'CONFIRM', confirmations: 20 });
    expect(decide({ ...ok, confirmations: 19 }, exp, { ...timing, ageSeconds: 3600 }).kind).toBe('REVIEW');
    // Exitosa en la red pero con otro destino u otro monto: revisión, nunca confirmada.
    expect(decide({ ...ok, confirmations: 50, to: 'TOtra' }, exp, timing).kind).toBe('REVIEW');
    expect(decide({ ...ok, confirmations: 50, amount: '999999999' }, exp, timing).kind).toBe('REVIEW');
    expect(decide({ found: true, status: 'FAILED', detail: 'sin energía' }, exp, timing)).toEqual({ kind: 'FAIL', reason: 'sin energía' });
  });

  it('el banco confirma con el movimiento liquidado en el mismo sentido y monto', () => {
    const bank: Expected = { to: null, direction: 'IN', amount: '4019020' };
    const t = { ...timing, requiredConfirmations: 0 };
    expect(decide({ found: true, status: 'SETTLED', direction: 'IN', amount: '4019020' }, bank, t).kind).toBe('CONFIRM');
    expect(decide({ found: true, status: 'SETTLED', direction: 'OUT', amount: '4019020' }, bank, t).kind).toBe('REVIEW');
    expect(decide({ found: true, status: 'REJECTED', direction: 'IN', amount: '4019020' }, bank, t).kind).toBe('FAIL');
  });
});

describe('confirmaciones con la red y el banco sandbox', () => {
  let env: Env;
  let andina: string;
  let n = 0;
  const hash = () => (++n).toString(16).padStart(64, 'd');

  const sim = (transferId: string, input: Parameters<typeof simulateFor>[2]) => as(env, 'admin', (ctx) => simulateFor(ctx, transferId, input));
  const statusOf = async (table: 'orders' | 'transfers', id: string) => (await env.db.query(`SELECT status FROM otc.${table} WHERE id = $1`, [id])).rows[0].status;
  const balance = async (code: string) => (await accountByCode(env.db, code)).balance;

  async function order(side: 'BUY' | 'SELL', usdtAmount: string): Promise<OrderRow> {
    const req = await as(env, 'trader', (ctx) => createRequest(ctx, { counterpartyId: andina, side, usdtAmount, network: 'TRON' }));
    const q = await as(env, 'trader', (ctx) => createQuote(ctx, req.id));
    const r = await as(env, 'trader', (ctx) => acceptQuote(ctx, q.id));
    if (!r.ok) throw r.error;
    return r.order;
  }

  /** Orden de venta con el cobro confirmado, aprobada, firmada y con el hash registrado. */
  async function sentDelivery(usdtAmount: string): Promise<{ order: OrderRow; delivery: TransferRow }> {
    const o = await order('SELL', usdtAmount);
    await as(env, 'trader', (ctx) => registerPayment(ctx, o.id, { reference: `BCOL-C-${++n}` }));
    await confirmCollection(env, o.id);
    const a = await as(env, 'trader', (ctx) => approveDelivery(ctx, o.id, null));
    await as(env, 'trader', (ctx) => prepareSigning(ctx, a.transfer!.id));
    const s = await as(env, 'trader', (ctx) => registerSent(ctx, a.transfer!.id, hash()));
    return { order: o, delivery: s.transfer };
  }

  beforeAll(async () => {
    env = await setupEnv();
    andina = (await env.db.query(`SELECT id FROM otc.counterparties WHERE document_number = '900000001'`)).rows[0].id;
    await as(env, 'trader', (ctx) => recordTrm(ctx, { rate: '4000' }));
  });
  afterAll(async () => env.close());

  it('de punta a punta: el cobro y la entrega se confirman con evidencia, se registran los asientos y la orden se completa', async () => {
    const bank0 = await balance('BANCOLOMBIA_COP_DEMO');
    const tron0 = await balance('WALLET_TRON_DEMO');
    const o = await order('SELL', '1000');
    const paid = await as(env, 'trader', (ctx) => registerPayment(ctx, o.id, { reference: 'BCOL-E2E-1' }));

    await sim(paid.transfer.id, { status: 'PENDING' });
    expect((await checkNow(env, paid.transfer.id)).status).toBe('PENDIENTE');
    expect(await statusOf('orders', o.id)).toBe('COBRO_EN_VERIFICACION');
    await sim(paid.transfer.id, { status: 'SETTLED' });
    expect((await checkNow(env, paid.transfer.id)).status).toBe('CONFIRMADA');
    expect(await statusOf('orders', o.id)).toBe('COBRO_CONFIRMADO');
    expect(Number(await balance('BANCOLOMBIA_COP_DEMO')) - Number(bank0)).toBe(4019020);

    const a = await as(env, 'trader', (ctx) => approveDelivery(ctx, o.id, null));
    await as(env, 'trader', (ctx) => prepareSigning(ctx, a.transfer!.id));
    await as(env, 'trader', (ctx) => registerSent(ctx, a.transfer!.id, hash()));
    await sim(a.transfer!.id, { status: 'SUCCESS', confirmations: 5 });
    expect((await checkNow(env, a.transfer!.id)).status).toBe('PENDIENTE');
    expect(await statusOf('orders', o.id)).toBe('ENTREGA_ENVIADA'); // con 5 de 20 confirmaciones nunca está completada
    expect(await balance('WALLET_TRON_DEMO')).toBe(tron0);

    await sim(a.transfer!.id, { status: 'SUCCESS', confirmations: 20 });
    expect((await checkNow(env, a.transfer!.id)).status).toBe('CONFIRMADA');
    expect(await statusOf('orders', o.id)).toBe('COMPLETADA');
    expect(Number(tron0) - Number(await balance('WALLET_TRON_DEMO'))).toBe(1000);
    const res = await env.db.query('SELECT status FROM otc.reservations WHERE order_id = $1', [o.id]);
    expect(res.rows[0].status).toBe('CONSUMED');
    expect((await verifyBalances(env.db)).ok).toBe(true);

    const entries = await env.db.query('SELECT count(*)::int AS n FROM otc.journal_entries WHERE order_id = $1', [o.id]);
    expect(entries.rows[0].n).toBe(2);
    const calls = await env.db.query(`SELECT count(*)::int AS n, bool_and(sandbox) AS sandbox, bool_and(ok) AS ok FROM otc.integration_calls`);
    expect(calls.rows[0]).toMatchObject({ sandbox: true, ok: true });
    expect(calls.rows[0].n).toBeGreaterThanOrEqual(4);
  });

  it('exitosa en la red pero a otra dirección: transferencia y orden en revisión; no se puede confirmar ni dar por fallida', async () => {
    const { order: o, delivery } = await sentDelivery('100');
    await sim(delivery.id, { status: 'SUCCESS', confirmations: 50, toAddress: 'TDemoOtraDireccionFicticia99999999' });
    expect((await checkNow(env, delivery.id)).status).toBe('EN_REVISION');
    expect(await statusOf('orders', o.id)).toBe('EN_REVISION');
    const cases = await env.db.query(`SELECT reason FROM otc.cases WHERE entity_id = $1 AND status = 'ABIERTO'`, [delivery.id]);
    expect(cases.rows.map((c) => c.reason)).toContain('REVISION');
    const err = await expectCode(as(env, 'admin', (ctx) => resolveTransferReview(ctx, delivery.id, 'CONFIRMADA', 'parece bien')), 'NO_EVIDENCE');
    expect((err as Error).message).toContain('El destino no coincide');
    await expectCode(as(env, 'admin', (ctx) => resolveTransferReview(ctx, delivery.id, 'FALLIDA', 'no')), 'NO_EVIDENCE');
  });

  it('entrega fallida en la red: la reserva vuelve a la orden, la orden vuelve a autorizada y el reintento es otra transferencia', async () => {
    const tron0 = await balance('WALLET_TRON_DEMO');
    const { order: o, delivery } = await sentDelivery('200');
    await sim(delivery.id, { status: 'FAILED', failReason: 'sin energía en Tron (simulado)' });
    expect((await checkNow(env, delivery.id)).status).toBe('FALLIDA');
    expect(await statusOf('orders', o.id)).toBe('ENTREGA_AUTORIZADA');
    const res = await env.db.query('SELECT status FROM otc.reservations WHERE order_id = $1', [o.id]);
    expect(res.rows[0].status).toBe('ACTIVE');
    expect(await balance('WALLET_TRON_DEMO')).toBe(tron0); // nada salió
    const retry = await as(env, 'tesorero2', (ctx) => retryDelivery(ctx, delivery.id, 'Se recargó energía (prueba)'));
    expect(retry.retry_of).toBe(delivery.id);
  });

  it('sin rastro: alerta al primer plazo, revisión al segundo; la confirmación tardía queda como evidencia y decide el administrador', async () => {
    const { order: o, delivery } = await sentDelivery('300');
    env.clock.advance(900);
    expect((await checkNow(env, delivery.id)).status).toBe('ENVIADA');
    const alert = await env.db.query(`SELECT 1 FROM otc.cases WHERE entity_id = $1 AND reason = 'SIN_CONFIRMAR' AND status = 'ABIERTO'`, [delivery.id]);
    expect(alert.rowCount).toBe(1);
    env.clock.advance(2700);
    expect((await checkNow(env, delivery.id)).status).toBe('EN_REVISION');
    const reserved = await env.db.query('SELECT status FROM otc.reservations WHERE order_id = $1', [o.id]);
    expect(reserved.rows[0].status).toBe('LOCKED'); // la reserva sigue bloqueada

    await sim(delivery.id, { status: 'SUCCESS', confirmations: 25 });
    expect((await checkNow(env, delivery.id)).status).toBe('EN_REVISION'); // no cambia solo
    const late = await env.db.query(`SELECT outcome FROM otc.observations WHERE transfer_id = $1 ORDER BY id DESC LIMIT 1`, [delivery.id]);
    expect(late.rows[0].outcome).toBe('EVIDENCIA_TARDIA');

    await expectCode(as(env, 'trader', (ctx) => resolveTransferReview(ctx, delivery.id, 'CONFIRMADA', 'ok')), 'FORBIDDEN');
    await as(env, 'admin', (ctx) => resolveTransferReview(ctx, delivery.id, 'CONFIRMADA', 'Verificado en el explorador de bloques'));
    expect(await statusOf('transfers', delivery.id)).toBe('CONFIRMADA');
    expect(await statusOf('orders', o.id)).toBe('EN_REVISION');
    await as(env, 'admin', (ctx) => resolveReview(ctx, o.id, 'RESUME', 'Entrega verificada'));
    expect(await statusOf('orders', o.id)).toBe('COMPLETADA');
  });

  it('un traslado propio entra al destino solo al confirmarse', async () => {
    const [b0, t0] = [await balance('BINANCE_USDT_DEMO'), await balance('WALLET_TRON_DEMO')];
    const from = await accountByCode(env.db, 'BINANCE_USDT_DEMO');
    const to = await accountByCode(env.db, 'WALLET_TRON_DEMO');
    const t = await as(env, 'trader', (ctx) =>
      createInternalTransfer(ctx, { fromAccountId: from.id, toAccountId: to.id, amount: '1000', reason: 'Reponer la billetera (prueba)' }),
    );
    await as(env, 'trader', (ctx) => prepareSigning(ctx, t.id));
    await as(env, 'trader', (ctx) => registerSent(ctx, t.id, hash()));
    await sim(t.id, { status: 'SUCCESS', confirmations: 20 });
    expect((await checkNow(env, t.id)).status).toBe('CONFIRMADA');
    expect(Number(b0) - Number(await balance('BINANCE_USDT_DEMO'))).toBe(1000);
    expect(Number(await balance('WALLET_TRON_DEMO')) - Number(t0)).toBe(1000);
  });

  it('si la integración no responde, nada cambia y la llamada queda registrada con el error', async () => {
    const { delivery } = await sentDelivery('10');
    const broken = {
      chain: { ...sandboxIntegrations(env.db).chain, sandbox: true, getTransaction: async () => Promise.reject(new Error('tiempo agotado (simulado)')) },
      bank: sandboxIntegrations(env.db).bank,
    };
    const r = await checkTransfer({ db: env.db, integrations: broken as never, now: env.clock.now, actor: SYSTEM_ACTOR }, delivery.id);
    expect(r).toEqual({ status: 'ENVIADA', applied: false });
    const call = await env.db.query(`SELECT ok, error FROM otc.integration_calls ORDER BY id DESC LIMIT 1`);
    expect(call.rows[0]).toEqual({ ok: false, error: 'tiempo agotado (simulado)' });
  });

  it('el trabajador sigue las transferencias solo', async () => {
    const { order: o, delivery } = await sentDelivery('20');
    await sim(delivery.id, { status: 'SUCCESS', confirmations: 20 });
    env.clock.advance(16);
    await runSweeps(env.db, sandboxIntegrations(env.db), env.clock.now);
    expect(await statusOf('orders', o.id)).toBe('COMPLETADA');
  });

  it('por HTTP: simular en sandbox, revisar ya y resolver con el segundo factor', async () => {
    const { delivery } = await sentDelivery('30');
    const op = await httpLogin(env, 'trader');
    const s = await call(env, op, 'POST', `/sandbox/transfers/${delivery.id}/simulate`, { status: 'SUCCESS', confirmations: 3, amount: '29' });
    expect(s.body).toMatchObject({ simulated: true });
    const c = await call(env, op, 'POST', `/transfers/${delivery.id}/check`);
    expect(c.body.status).toBe('EN_REVISION'); // monto distinto al autorizado
    const obs = await call(env, op, 'GET', `/transfers/${delivery.id}/observations`);
    expect(obs.body[0]).toMatchObject({ outcome: 'REVISION', sandbox: true });

    const admin = await httpLogin(env, 'admin');
    const noCode = await call(env, admin, 'POST', `/transfers/${delivery.id}/review/resolve`, { to: 'PENDIENTE', note: 'Volver a seguir' }, { 'idempotency-key': newKey() });
    expect(noCode.body.code).toBe('STEP_UP_REQUIRED');
    const ok = await call(
      env,
      admin,
      'POST',
      `/transfers/${delivery.id}/review/resolve`,
      { to: 'PENDIENTE', note: 'Volver a seguir' },
      { 'idempotency-key': newKey(), ...stepUp(env, 'admin') },
    );
    expect(ok.body.status).toBe('PENDIENTE');
  });
});
