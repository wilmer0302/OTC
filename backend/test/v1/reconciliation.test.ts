import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sandboxIntegrations } from '../../src/integrations/sandbox.js';
import { accountByCode, verifyBalances } from '../../src/modules/liquidity/service.js';
import { approveDelivery, registerPayment } from '../../src/modules/orders/service.js';
import { recordTrm } from '../../src/modules/pricing/service.js';
import { matchMovement, runStatusOf } from '../../src/modules/reconciliation/domain.js';
import {
  closeDay,
  decideAdjustment,
  getRun,
  importStatement,
  proposeAdjustment,
  reconcileAccount,
  sendItemToReview,
} from '../../src/modules/reconciliation/service.js';
import { simulateFor, simulateMovement } from '../../src/modules/sandbox/service.js';
import { acceptQuote, createQuote, createRequest } from '../../src/modules/trading/service.js';
import { createInternalTransfer, prepareSigning, registerSent } from '../../src/modules/transfers/service.js';
import { bogotaDate } from '../../src/services/trm.js';
import { actorOf, as, call, checkNow, confirmCollection, expectCode, httpLogin, newKey, setupEnv, stepUp, type Env } from './helpers.js';

describe('reglas de conciliación', () => {
  it('cruza por referencia, sentido y monto', () => {
    const book = { status: 'CONFIRMADA', amount: '4019020.000000', direction: 'IN' as const };
    expect(matchMovement({ amount: '4019020', direction: 'IN' }, book)).toEqual({ status: 'CONCILIADA', reason: null });
    expect(matchMovement({ amount: '4019000', direction: 'IN' }, book)).toEqual({
      status: 'CON_DIFERENCIA',
      reason: 'El monto no coincide: el libro dice 4019020 y el extracto 4019000',
    });
    expect(matchMovement({ amount: '4019020', direction: 'OUT' }, book).status).toBe('CON_DIFERENCIA');
    expect(matchMovement({ amount: '1', direction: 'IN' }, null).status).toBe('SIN_CONTRAPARTIDA');
    expect(matchMovement({ amount: '4019020', direction: 'IN' }, { ...book, status: 'PENDIENTE' }).status).toBe('PENDIENTE');
  });

  it('el día cuadra solo con todas las partidas conciliadas o ajustadas', () => {
    expect(runStatusOf([])).toBe('CUADRADO');
    expect(runStatusOf(['CONCILIADA', 'AJUSTADA'])).toBe('CUADRADO');
    expect(runStatusOf(['CONCILIADA', 'PENDIENTE'])).toBe('ABIERTO');
    expect(runStatusOf(['CONCILIADA', 'EN_REVISION'])).toBe('CON_DIFERENCIAS');
  });
});

describe('conciliación diaria', () => {
  let env: Env;
  let andina: string;
  let day: string;
  let n = 0;
  const hash = () => (++n).toString(16).padStart(64, 'e');

  const deps = async (username: string) => ({ db: env.db, integrations: sandboxIntegrations(env.db), now: env.clock.now, actor: await actorOf(env.db, username) });
  const itemByRef = async (runId: string, ref: string) => (await as(env, 'trader', (ctx) => getRun(ctx, runId))).items.find((i: { external_ref: string }) => i.external_ref === ref);

  /** Orden de venta completa: cobro en pesos y entrega en Tron, ambos confirmados en el sandbox. */
  async function completedSell(usdtAmount: string, bankRef: string) {
    const req = await as(env, 'trader', (ctx) => createRequest(ctx, { counterpartyId: andina, side: 'SELL', usdtAmount, network: 'TRON' }));
    const q = await as(env, 'trader', (ctx) => createQuote(ctx, req.id));
    const r = await as(env, 'trader', (ctx) => acceptQuote(ctx, q.id));
    if (!r.ok) throw r.error;
    const p = await as(env, 'trader', (ctx) => registerPayment(ctx, r.order.id, { reference: bankRef }));
    await confirmCollection(env, r.order.id);
    const a = await as(env, 'trader', (ctx) => approveDelivery(ctx, r.order.id, null));
    await as(env, 'trader', (ctx) => prepareSigning(ctx, a.transfer!.id));
    const sent = await as(env, 'trader', (ctx) => registerSent(ctx, a.transfer!.id, hash()));
    await as(env, 'admin', (ctx) => simulateFor(ctx, sent.transfer.id, { status: 'SUCCESS', confirmations: 20 }));
    await checkNow(env, sent.transfer.id);
    return { order: r.order, collection: p.transfer, delivery: sent.transfer };
  }

  beforeAll(async () => {
    env = await setupEnv();
    andina = (await env.db.query(`SELECT id FROM otc.counterparties WHERE document_number = '900000001'`)).rows[0].id;
    await as(env, 'trader', (ctx) => recordTrm(ctx, { rate: '4000' }));
    day = bogotaDate(env.clock.now());
  });
  afterAll(async () => env.close());

  it('banco: concilia lo esperado, marca diferencias y depósitos inesperados, ajusta con dos personas y cierra solo cuadrado', async () => {
    const bank = await accountByCode(env.db, 'BANCOLOMBIA_COP_DEMO');
    await completedSell('1000', 'BCOL-R-1');
    // Un cobro que el banco liquidó por otro monto, y otro confirmado que no aparece en el extracto.
    const diff = await completedSell('10', 'BCOL-R-2');
    await as(env, 'admin', (ctx) => simulateFor(ctx, diff.collection.id, { status: 'SETTLED', amount: '40000' }));
    const missing = await completedSell('20', 'BCOL-R-3');
    await as(env, 'admin', (ctx) => simulateFor(ctx, missing.collection.id, { status: 'PENDING' }));
    // Un depósito que ninguna orden esperaba.
    await as(env, 'admin', (ctx) => simulateMovement(ctx, bank.id, { reference: 'DEP-SORPRESA-1', direction: 'IN', amount: '500000' }));

    const r = await reconcileAccount(await deps('trader'), bank.id, day);
    expect(r.status).toBe('CON_DIFERENCIAS');
    const run = await as(env, 'trader', (ctx) => getRun(ctx, r.runId));
    const status = (ref: string) => run.items.find((i: { external_ref: string }) => i.external_ref === ref)?.status;
    expect(status('BCOL-R-1')).toBe('CONCILIADA');
    expect(status('BCOL-R-2')).toBe('CON_DIFERENCIA');
    expect(status('DEP-SORPRESA-1')).toBe('SIN_CONTRAPARTIDA');
    const diffItem = run.items.find((i: { external_ref: string }) => i.external_ref === 'BCOL-R-2');
    expect([diffItem.expected_amount, diffItem.observed_amount]).toEqual(['40190.000000', '40000.000000']);
    const bookOnly = run.items.find((i: { transfer_id: string; external_ref: string | null }) => i.transfer_id === missing.collection.id && !i.external_ref);
    expect(bookOnly.status).toBe('SIN_CONTRAPARTIDA');
    const cases = await env.db.query(`SELECT count(*)::int AS n FROM otc.cases WHERE entity = 'recon_item' AND status = 'ABIERTO'`);
    expect(cases.rows[0].n).toBe(3);

    // Repetir la conciliación no duplica nada.
    await reconcileAccount(await deps('trader'), bank.id, day);
    expect((await as(env, 'trader', (ctx) => getRun(ctx, r.runId))).items).toHaveLength(run.items.length);

    const closeErr = await expectCode(as(env, 'trader', (ctx) => closeDay(ctx, r.runId, null)), 'DAY_NOT_BALANCED');
    expect((closeErr as Error).message).toContain('SIN_CONTRAPARTIDA');

    // El depósito inesperado: a revisión, ajuste propuesto por una persona y aprobado por otra.
    const surprise = await itemByRef(r.runId, 'DEP-SORPRESA-1');
    await expectCode(as(env, 'tesorero2', (ctx) => proposeAdjustment(ctx, { itemId: surprise.id, amount: '500000', reason: 'x' })), 'INVALID_STATE');
    await as(env, 'tesorero2', (ctx) => sendItemToReview(ctx, surprise.id, 'Se identificó al depositante (prueba)'));
    const adj = await as(env, 'tesorero2', (ctx) =>
      proposeAdjustment(ctx, { itemId: surprise.id, amount: '500000', reason: 'Depósito sin orden, se registra como pasivo a devolver (prueba)' }),
    );
    const before = (await accountByCode(env.db, 'BANCOLOMBIA_COP_DEMO')).balance;
    expect((await accountByCode(env.db, 'BANCOLOMBIA_COP_DEMO')).balance).toBe(before); // no se aplica sin la segunda firma
    await expectCode(as(env, 'trader', (ctx) => decideAdjustment(ctx, adj.id, true, 'ok')), 'FORBIDDEN');
    await as(env, 'admin', (ctx) => decideAdjustment(ctx, adj.id, true, 'Revisado con el extracto'));
    expect(Number((await accountByCode(env.db, 'BANCOLOMBIA_COP_DEMO')).balance) - Number(before)).toBe(500000);
    expect((await itemByRef(r.runId, 'DEP-SORPRESA-1')).status).toBe('AJUSTADA');
    await expect(env.db.query(`UPDATE otc.adjustments SET decided_by = proposed_by WHERE id = $1`, [adj.id])).rejects.toThrow();

    // La diferencia de monto: ajuste negativo por lo que no llegó.
    const d = await itemByRef(r.runId, 'BCOL-R-2');
    await as(env, 'tesorero2', (ctx) => sendItemToReview(ctx, d.id, 'El cliente pagó 190 pesos menos (prueba)'));
    const adj2 = await as(env, 'tesorero2', (ctx) => proposeAdjustment(ctx, { itemId: d.id, amount: '-190', reason: 'Diferencia de pago (prueba)' }));
    await as(env, 'admin', (ctx) => decideAdjustment(ctx, adj2.id, true, 'Aprobado'));
    // Lo que el libro esperaba y no llegó: se aclara o se ajusta; aquí se ajusta.
    await as(env, 'tesorero2', (ctx) => sendItemToReview(ctx, bookOnly.id, 'El banco no lo muestra (prueba)'));
    const adj3 = await as(env, 'tesorero2', (ctx) => proposeAdjustment(ctx, { itemId: bookOnly.id, amount: `-${missing.collection.amount.split('.')[0]}`, reason: 'No llegó (prueba)' }));
    await as(env, 'admin', (ctx) => decideAdjustment(ctx, adj3.id, true, 'Aprobado'));

    expect((await as(env, 'trader', (ctx) => getRun(ctx, r.runId))).status).toBe('CUADRADO');
    await as(env, 'trader', (ctx) => closeDay(ctx, r.runId, 'Día cuadrado'));
    await expectCode(reconcileAccount(await deps('trader'), bank.id, day), 'DAY_CLOSED');
    expect((await verifyBalances(env.db)).ok).toBe(true);
  });

  it('billetera: la entrega confirmada aparece en la red y se concilia', async () => {
    const tron = await accountByCode(env.db, 'WALLET_TRON_DEMO');
    const r = await reconcileAccount(await deps('trader'), tron.id, day);
    const run = await as(env, 'trader', (ctx) => getRun(ctx, r.runId));
    expect(run.items.length).toBeGreaterThanOrEqual(3);
    expect(run.items.every((i: { status: string }) => i.status === 'CONCILIADA')).toBe(true);
    expect(r.status).toBe('CUADRADO');
  });

  it('exchange: el extracto se carga a mano y se cruza igual', async () => {
    const binance = await accountByCode(env.db, 'BINANCE_USDT_DEMO');
    const tron = await accountByCode(env.db, 'WALLET_TRON_DEMO');
    const t = await as(env, 'trader', (ctx) =>
      createInternalTransfer(ctx, { fromAccountId: binance.id, toAccountId: tron.id, amount: '700', reason: 'Reponer (prueba)' }),
    );
    await as(env, 'trader', (ctx) => prepareSigning(ctx, t.id));
    const h = hash();
    await as(env, 'trader', (ctx) => registerSent(ctx, t.id, h));
    await as(env, 'admin', (ctx) => simulateFor(ctx, t.id, { status: 'SUCCESS', confirmations: 20 }));
    expect((await checkNow(env, t.id)).status).toBe('CONFIRMADA');
    await expectCode(reconcileAccount(await deps('trader'), binance.id, day), 'INVALID'); // sin integración de extractos
    const r = await as(env, 'trader', (ctx) =>
      importStatement(ctx, binance.id, day, [{ reference: h, direction: 'OUT', amount: '700', occurredAt: env.clock.now().toISOString(), raw: { prueba: true } }]),
    );
    expect(r.status).toBe('CUADRADO');
  });

  it('por HTTP: conciliar, ver partidas y cerrar con el segundo factor', async () => {
    const bsc = await accountByCode(env.db, 'WALLET_BSC_DEMO');
    const op = await httpLogin(env, 'trader');
    const f = await call(env, op, 'POST', '/reconciliations/fetch', { accountId: bsc.id, date: day });
    expect(f.body.status).toBe('CUADRADO');
    const list = await call(env, op, 'GET', `/reconciliations?date=${day}`);
    expect(list.body.map((x: { account_code: string }) => x.account_code)).toContain('WALLET_BSC_DEMO');
    const noCode = await call(env, op, 'POST', `/reconciliations/${f.body.runId}/close`, {}, { 'idempotency-key': newKey() });
    expect(noCode.body.code).toBe('STEP_UP_REQUIRED');
    const closed = await call(env, op, 'POST', `/reconciliations/${f.body.runId}/close`, { note: 'Sin movimientos' }, { 'idempotency-key': newKey(), ...stepUp(env, 'trader') });
    expect(closed.body.status).toBe('CERRADO');
  });
});
