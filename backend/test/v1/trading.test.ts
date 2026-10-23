import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runSweeps } from '../../src/jobs/sweeps.js';
import { sandboxIntegrations } from '../../src/integrations/sandbox.js';
import { decideLimitChange, proposeLimitChange } from '../../src/modules/limits/service.js';
import { liquiditySummary } from '../../src/modules/liquidity/service.js';
import { clientReceipt } from '../../src/modules/orders/service.js';
import { recordTrm } from '../../src/modules/pricing/service.js';
import { isExpired, priceMovedBeyond, quoteCanMove, requestCanMove } from '../../src/modules/trading/domain.js';
import {
  acceptQuote,
  cancelRequest,
  createQuote,
  createRequest,
  quoteClientView,
  withdrawOnPriceMove,
  type NewRequest,
} from '../../src/modules/trading/service.js';
import { D } from '../../src/platform/money.js';
import { as, call, expectCode, httpLogin, newKey, setupEnv, type Env } from './helpers.js';

describe('reglas de solicitudes y cotizaciones', () => {
  it('estados cerrados', () => {
    expect(requestCanMove('VALIDADA', 'COTIZADA')).toBe(true);
    expect(requestCanMove('VALIDADA', 'VENCIDA')).toBe(false);
    expect(requestCanMove('ACEPTADA', 'CANCELADA')).toBe(false);
    expect(quoteCanMove('VIGENTE', 'ACEPTADA')).toBe(true);
    expect(quoteCanMove('VENCIDA', 'VIGENTE')).toBe(false); // una vencida no se revive
  });

  it('en el instante exacto del vencimiento ya no vale', () => {
    const t = new Date('2026-10-20T15:00:00Z');
    expect(isExpired(t, new Date('2026-10-20T14:59:59.999Z'))).toBe(false);
    expect(isExpired(t, t)).toBe(true);
  });

  it('el umbral de movimiento de precio es estricto', () => {
    expect(priceMovedBeyond(new D(4000), new D(4020), 50)).toBe(false); // exactamente 50 pb
    expect(priceMovedBeyond(new D(4000), new D('4020.01'), 50)).toBe(true);
    expect(priceMovedBeyond(new D(4000), new D('3979.99'), 50)).toBe(true);
  });
});

describe('de la solicitud a la orden', () => {
  let env: Env;
  let andina: string;
  let caribe: string;
  let pending: string;
  const sell = (cp: string, usdtAmount: string, network: 'TRON' | 'BSC' = 'TRON'): NewRequest => ({ counterpartyId: cp, side: 'SELL', usdtAmount, network });

  beforeAll(async () => {
    env = await setupEnv();
    const doc = async (d: string) => (await env.db.query('SELECT id FROM otc.counterparties WHERE document_number = $1', [d])).rows[0].id;
    andina = await doc('900000001');
    caribe = await doc('900000002');
    pending = await doc('1000000003');
  });
  afterAll(async () => env.close());

  const available = async (code: string) => {
    const rows = await as(env, 'trader', (ctx) => liquiditySummary(ctx));
    return rows.find((a) => a.code === code)!.available;
  };

  it('valida la solicitud de un cliente aprobado y rechaza, guardando el motivo, la de uno sin KYC', async () => {
    const ok = await as(env, 'trader', (ctx) => createRequest(ctx, sell(andina, '1000')));
    expect(ok.status).toBe('VALIDADA');
    expect(ok.destination_id).not.toBeNull();

    const bad = await as(env, 'trader', (ctx) => createRequest(ctx, sell(pending, '1000')));
    expect(bad.status).toBe('RECHAZADA');
    expect(bad.status_reason).toContain('El KYC del cliente está PENDIENTE');
    expect(bad.status_reason).toContain('no tiene un destino TRON aprobado');
    const saved = await env.db.query('SELECT status FROM otc.requests WHERE id = $1', [bad.id]);
    expect(saved.rows[0].status).toBe('RECHAZADA');
  });

  it('rechaza por límite y por liquidez indicativa, nombrando la regla y los valores', async () => {
    const big = await as(env, 'trader', (ctx) => createRequest(ctx, sell(andina, '200000.000001')));
    expect(big.status_reason).toContain('Supera el límite por operación (200000.000001 de 200000 USDT)');
    const noLiq = await as(env, 'trader', (ctx) => createRequest(ctx, sell(andina, '100001', 'BSC')));
    expect(noLiq.status_reason).toBe('Liquidez insuficiente en Billetera BSC (demo): disponible 100000, reservado 0, se necesitan 100001');
    await expectCode(as(env, 'auditor', (ctx) => createRequest(ctx, sell(andina, '1'))), 'FORBIDDEN');
  });

  it('sin TRM del día no cotiza; con TRM guarda qué usó y el precio todo incluido', async () => {
    const req = await as(env, 'trader', (ctx) => createRequest(ctx, sell(andina, '1000')));
    await expectCode(as(env, 'trader', (ctx) => createQuote(ctx, req.id)), 'NO_TRM');
    const trm = await as(env, 'trader', (ctx) => recordTrm(ctx, { rate: '4000' }));
    const q = await as(env, 'trader', (ctx) => createQuote(ctx, req.id));
    expect(q).toMatchObject({ status: 'VIGENTE', trm_id: trm.id, trm_rate: '4000.00', unit_price_cop: '4019.02', total_cop: '4019020' });
    expect(new Date(q.expires_at).getTime() - env.clock.now().getTime()).toBe(120_000);
    const r = await env.db.query('SELECT status FROM otc.requests WHERE id = $1', [req.id]);
    expect(r.rows[0].status).toBe('COTIZADA');

    // Lo que ve el cliente: precio por USDT, comisión y total; nunca TRM ni margen.
    const view = quoteClientView(q);
    expect(view.price).toEqual({
      side: 'SELL',
      usdtAmount: '1000.000000',
      unitPriceCop: '4019.02',
      totalCop: '4019020',
      detail: { basePriceCop: '4015.00', subtotalCop: '4015000', commissionCop: '4020', totalCop: '4019020' },
    });
    expect(JSON.stringify(view)).not.toMatch(/trm|margin/i);
  });

  it('recotizar reemplaza la anterior y la enlaza', async () => {
    const req = await as(env, 'trader', (ctx) => createRequest(ctx, sell(andina, '500')));
    const q1 = await as(env, 'trader', (ctx) => createQuote(ctx, req.id));
    const q2 = await as(env, 'trader', (ctx) => createQuote(ctx, req.id));
    expect(q2.replaces_id).toBe(q1.id);
    const old = await env.db.query('SELECT status FROM otc.quotes WHERE id = $1', [q1.id]);
    expect(old.rows[0].status).toBe('REEMPLAZADA');
    await expectCode(as(env, 'trader', (ctx) => acceptQuote(ctx, q1.id)), 'QUOTE_NOT_ACTIVE');
  });

  it('aceptar un instante después del vencimiento falla y deja la cotización Vencida', async () => {
    const req = await as(env, 'trader', (ctx) => createRequest(ctx, sell(andina, '100')));
    const q = await as(env, 'trader', (ctx) => createQuote(ctx, req.id));
    env.clock.advance(120);
    const result = await as(env, 'trader', (ctx) => acceptQuote(ctx, q.id));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('QUOTE_EXPIRED');
    const saved = await env.db.query('SELECT status FROM otc.quotes WHERE id = $1', [q.id]);
    expect(saved.rows[0].status).toBe('VENCIDA');
    // Se recotiza: la nueva queda enlazada a la vencida.
    const q2 = await as(env, 'trader', (ctx) => createQuote(ctx, req.id));
    expect(q2.replaces_id).toBe(q.id);
  });

  it('aceptar crea una sola orden con precio congelado y reserva en la misma transacción', async () => {
    const before = await available('WALLET_TRON_DEMO');
    const req = await as(env, 'trader', (ctx) => createRequest(ctx, sell(andina, '1000')));
    const q = await as(env, 'trader', (ctx) => createQuote(ctx, req.id));
    const r1 = await as(env, 'trader', (ctx) => acceptQuote(ctx, q.id));
    if (!r1.ok) throw r1.error;
    expect(r1.order).toMatchObject({ status: 'CREADA', total_cop: '4019020', unit_price_cop: '4019.02', required_approvals: 1 });
    expect(new Date(r1.order.payment_deadline).getTime() - env.clock.now().getTime()).toBe(480_000);
    expect(new D(before).minus(await available('WALLET_TRON_DEMO')).toFixed()).toBe('1000');

    // Aceptar otra vez devuelve la misma orden.
    const r2 = await as(env, 'trader', (ctx) => acceptQuote(ctx, q.id));
    expect(r2.ok && r2.order.id).toBe(r1.order.id);
    expect(r2.ok && r2.replayed).toBe(true);
    const n = await env.db.query('SELECT count(*)::int AS n FROM otc.orders WHERE quote_id = $1', [q.id]);
    expect(n.rows[0].n).toBe(1);

    // El comprobante del cliente no muestra TRM ni margen.
    const receipt = await as(env, 'trader', (ctx) => clientReceipt(ctx, r1.order.id));
    expect(receipt.payTo).toEqual({ asset: 'COP', amount: '4019020', account: '9990000001' });
    expect(JSON.stringify(receipt)).not.toMatch(/trm|margin/i);
  });

  it('dos aceptaciones simultáneas que juntas superan la liquidez: solo una crea orden', async () => {
    const reqs = await Promise.all([
      as(env, 'trader', (ctx) => createRequest(ctx, sell(andina, '60000', 'BSC'))),
      as(env, 'trader', (ctx) => createRequest(ctx, sell(caribe, '60000', 'BSC'))),
    ]);
    const quotes = [];
    for (const r of reqs) quotes.push(await as(env, 'trader', (ctx) => createQuote(ctx, r.id)));
    const results = await Promise.allSettled(quotes.map((q) => as(env, 'trader', (ctx) => acceptQuote(ctx, q.id))));
    const ok = results.filter((r) => r.status === 'fulfilled');
    const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(ok).toHaveLength(1);
    expect(failed[0].reason.code).toBe('INSUFFICIENT_LIQUIDITY');
    // La cotización de la que falló sigue vigente y no quedó orden.
    const loser = quotes[results.indexOf(failed[0])];
    const saved = await env.db.query('SELECT status FROM otc.quotes WHERE id = $1', [loser.id]);
    expect(saved.rows[0].status).toBe('VIGENTE');
    const orders = await env.db.query('SELECT 1 FROM otc.orders WHERE quote_id = $1', [loser.id]);
    expect(orders.rowCount).toBe(0);
    await as(env, 'trader', (ctx) => cancelRequest(ctx, loser.request_id, 'El cliente desistió (prueba)'));
  });

  it('dos aceptaciones simultáneas que juntas superan el límite diario del cliente: solo pasa la que cabe', async () => {
    // Lo que el cliente ya usó hoy depende de la prueba anterior; el límite queda 1500 por encima.
    const used = new D((await env.db.query(`SELECT COALESCE(sum(usdt_amount),0) AS s FROM otc.orders WHERE counterparty_id = $1`, [caribe])).rows[0].s);
    const p = await as(env, 'admin', (ctx) =>
      proposeLimitChange(ctx, { kind: 'CLIENT_DAILY_USDT', counterpartyId: caribe, value: { amount: used.plus(1500).toFixed() }, reason: 'Prueba de límite (ficticio)' }),
    );
    await as(env, 'admin2', (ctx) => decideLimitChange(ctx, p.id, true, 'Prueba'));
    const reqs = [
      await as(env, 'trader', (ctx) => createRequest(ctx, sell(caribe, '1000'))),
      await as(env, 'trader', (ctx) => createRequest(ctx, sell(caribe, '1000'))),
    ];
    expect(reqs.map((r) => r.status)).toEqual(['VALIDADA', 'VALIDADA']);
    const quotes = [];
    for (const r of reqs) quotes.push(await as(env, 'trader', (ctx) => createQuote(ctx, r.id)));
    const results = await Promise.allSettled(quotes.map((q) => as(env, 'trader', (ctx) => acceptQuote(ctx, q.id))));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected')!;
    expect(failed.reason.code).toBe('LIMIT_EXCEEDED');
    expect(failed.reason.message).toBe(`Supera el límite diario del cliente (usado ${used.plus(1000).toFixed()} de ${used.plus(1500).toFixed()} USDT)`);
  });

  it('un movimiento de la TRM mayor al umbral retira las cotizaciones vigentes', async () => {
    const req = await as(env, 'trader', (ctx) => createRequest(ctx, sell(andina, '10')));
    const q = await as(env, 'trader', (ctx) => createQuote(ctx, req.id));
    const within = await as(env, 'trader', async (ctx) => withdrawOnPriceMove(ctx, await recordTrm(ctx, { rate: '4020' })));
    expect(within).toEqual([]);
    const beyond = await as(env, 'trader', async (ctx) => withdrawOnPriceMove(ctx, await recordTrm(ctx, { rate: '4020.01' })));
    expect(beyond).toContain(q.id);
    const saved = await env.db.query('SELECT status, status_reason FROM otc.quotes WHERE id = $1', [q.id]);
    expect(saved.rows[0]).toEqual({ status: 'RETIRADA', status_reason: 'La TRM pasó de 4000.00 a 4020.01, más del umbral de 50 pb' });
  });

  it('cancelar una solicitud cotizada retira su cotización vigente', async () => {
    const req = await as(env, 'trader', (ctx) => createRequest(ctx, sell(andina, '10')));
    const q = await as(env, 'trader', (ctx) => createQuote(ctx, req.id));
    await as(env, 'trader', (ctx) => cancelRequest(ctx, req.id, 'El cliente desistió (prueba)'));
    const saved = await env.db.query('SELECT status FROM otc.quotes WHERE id = $1', [q.id]);
    expect(saved.rows[0].status).toBe('RETIRADA');
    await expectCode(as(env, 'trader', (ctx) => createQuote(ctx, req.id)), 'INVALID_STATE');
  });

  it('el trabajador vence cotizaciones, solicitudes y órdenes sin pago, y libera la reserva', async () => {
    const req = await as(env, 'trader', (ctx) => createRequest(ctx, sell(andina, '700')));
    const q = await as(env, 'trader', (ctx) => createQuote(ctx, req.id));
    const res = await as(env, 'trader', (ctx) => acceptQuote(ctx, q.id));
    if (!res.ok) throw res.error;
    const openReq = await as(env, 'trader', (ctx) => createRequest(ctx, sell(andina, '5')));
    const openQuote = await as(env, 'trader', (ctx) => createQuote(ctx, openReq.id));
    const before = await available('WALLET_TRON_DEMO');

    env.clock.advance(479);
    await runSweeps(env.db, sandboxIntegrations(env.db), env.clock.now);
    expect((await env.db.query('SELECT status FROM otc.orders WHERE id = $1', [res.order.id])).rows[0].status).toBe('CREADA');
    expect((await env.db.query('SELECT status FROM otc.quotes WHERE id = $1', [openQuote.id])).rows[0].status).toBe('VENCIDA');

    env.clock.advance(1);
    await runSweeps(env.db, sandboxIntegrations(env.db), env.clock.now);
    expect((await env.db.query('SELECT status FROM otc.orders WHERE id = $1', [res.order.id])).rows[0].status).toBe('VENCIDA');
    const reservation = await env.db.query('SELECT status FROM otc.reservations WHERE order_id = $1', [res.order.id]);
    expect(reservation.rows[0].status).toBe('RELEASED');
    // Vencen en este barrido la de 700 y las órdenes de pruebas anteriores que tampoco se pagaron.
    const released = await env.db.query(
      `SELECT sum(r.amount) AS s FROM otc.reservations r JOIN otc.accounts a ON a.id = r.account_id
       WHERE a.code = 'WALLET_TRON_DEMO' AND r.status = 'RELEASED' AND r.updated_at = $1`,
      [env.clock.now()],
    );
    expect(new D(released.rows[0].s).gte(700)).toBe(true);
    expect(new D(await available('WALLET_TRON_DEMO')).minus(before).toFixed()).toBe(new D(released.rows[0].s).toFixed());

    env.clock.advance(1800);
    await runSweeps(env.db, sandboxIntegrations(env.db), env.clock.now);
    expect((await env.db.query('SELECT status FROM otc.requests WHERE id = $1', [openReq.id])).rows[0].status).toBe('VENCIDA');
  });

  it('la base protege el precio congelado y los estados finales', async () => {
    const q = (await env.db.query(`SELECT id FROM otc.quotes WHERE status = 'ACEPTADA' LIMIT 1`)).rows[0].id;
    await expect(env.db.query(`UPDATE otc.quotes SET unit_price_cop = 1 WHERE id = $1`, [q])).rejects.toThrow(/estado final/);
    const live = await as(env, 'trader', async (ctx) => createQuote(ctx, (await createRequest(ctx, sell(andina, '1'))).id));
    await expect(env.db.query(`UPDATE otc.quotes SET total_cop = 1 WHERE id = $1`, [live.id])).rejects.toThrow(/solo pueden cambiar/);
    await expect(env.db.query(`DELETE FROM otc.orders`)).rejects.toThrow(/solo agregar/);
    await expect(env.db.query(`UPDATE otc.orders SET status = 'CREADA' WHERE status = 'VENCIDA'`)).rejects.toThrow(/estado final/);
  });

  it('por HTTP: solicitud, cotización y aceptación con idempotencia; comprobante sin TRM ni margen', async () => {
    env.clock.advance(1);
    const op = await httpLogin(env, 'trader');
    const k1 = newKey();
    const body = { counterpartyId: andina, side: 'BUY', usdtAmount: '2500.5', network: 'BSC' };
    const created = await call(env, op, 'POST', '/requests', body, { 'idempotency-key': k1 });
    expect(created.status).toBe(201);
    expect(created.body.status).toBe('VALIDADA');
    const again = await call(env, op, 'POST', '/requests', body, { 'idempotency-key': k1 });
    expect(again.body.id).toBe(created.body.id);

    const quoted = await call(env, op, 'POST', `/requests/${created.body.id}/quotes`, undefined, { 'idempotency-key': newKey() });
    expect(quoted.status).toBe(201);
    // Compra con TRM 4020.01: (4020.01 − 45) × 0,999 = 3971.03499 → 3971.03; 2500.5 × 3971.03 = 9929560.515 → 9929561
    expect(quoted.body.client.price).toMatchObject({ side: 'BUY', unitPriceCop: '3971.03', totalCop: '9929561' });
    expect(JSON.stringify(quoted.body.client)).not.toMatch(/trm|margin/i);

    const ka = newKey();
    const accepted = await call(env, op, 'POST', `/quotes/${quoted.body.quote.id}/accept`, undefined, { 'idempotency-key': ka });
    expect(accepted.status).toBe(201);
    const replay = await call(env, op, 'POST', `/quotes/${quoted.body.quote.id}/accept`, undefined, { 'idempotency-key': ka });
    expect(replay.headers['idempotent-replay']).toBe('true');
    expect(replay.body.order.id).toBe(accepted.body.order.id);

    const receipt = await call(env, op, 'GET', `/orders/${accepted.body.order.id}/receipt`);
    expect(receipt.body.payTo).toEqual({ asset: 'USDT', amount: '2500.500000', network: 'BSC', address: '0x00000000000000000000000000000000000d0001' });
    expect(receipt.body.receiveAt).toMatchObject({ rail: 'BANK', bank: 'Bancolombia' });
    expect(receipt.body.receiveAt.value).not.toBe('1000000001');
    expect(JSON.stringify(receipt.body)).not.toMatch(/trm|margin/i);

    const detail = await call(env, op, 'GET', `/orders/${accepted.body.order.id}`);
    expect(detail.body.reservations).toEqual([expect.objectContaining({ status: 'ACTIVE', amount: '9929561.000000', account: 'BANCOLOMBIA_COP_DEMO' })]);
    expect(detail.body.history.map((h: { to_status: string }) => h.to_status)).toEqual(['CREADA']);

    // Aceptar una cotización vencida por HTTP: 409, y el vencimiento queda guardado.
    const r2 = await call(env, op, 'POST', '/requests', { ...body, usdtAmount: '1' }, { 'idempotency-key': newKey() });
    const q2 = await call(env, op, 'POST', `/requests/${r2.body.id}/quotes`, undefined, { 'idempotency-key': newKey() });
    env.clock.advance(121);
    const late = await call(env, op, 'POST', `/quotes/${q2.body.quote.id}/accept`, undefined, { 'idempotency-key': newKey() });
    expect(late.status).toBe(409);
    expect(late.body.code).toBe('QUOTE_EXPIRED');
    expect((await env.db.query('SELECT status FROM otc.quotes WHERE id = $1', [q2.body.quote.id])).rows[0].status).toBe('VENCIDA');

    // Cargar una TRM por HTTP retira las cotizaciones vigentes si el precio se movió más del umbral.
    const r3 = await call(env, op, 'POST', '/requests', { ...body, usdtAmount: '1' }, { 'idempotency-key': newKey() });
    const q3 = await call(env, op, 'POST', `/requests/${r3.body.id}/quotes`, undefined, { 'idempotency-key': newKey() });
    expect((await call(env, op, 'POST', '/trm', { rate: '4100' }, { 'idempotency-key': newKey() })).status).toBe(201);
    expect((await env.db.query('SELECT status FROM otc.quotes WHERE id = $1', [q3.body.quote.id])).rows[0].status).toBe('RETIRADA');
  });
});
