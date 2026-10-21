import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decideLimitChange, proposeLimitChange } from '../../src/modules/limits/service.js';
import { isValidExternalRef, orderCanMove } from '../../src/modules/orders/domain.js';
import {
  approveDelivery,
  cancelOrder,
  getOrder,
  markForReview,
  onCollectionConfirmed,
  registerPayment,
  resolveReview,
  type OrderRow,
} from '../../src/modules/orders/service.js';
import { recordTrm } from '../../src/modules/pricing/service.js';
import { acceptQuote, createQuote, createRequest } from '../../src/modules/trading/service.js';
import { as, asSystem, call, expectCode, httpLogin, newKey, setupEnv, stepUp, type Env } from './helpers.js';

const TRON_HASH = 'a'.repeat(63) + '1';
const BSC_HASH = '0x' + 'b'.repeat(63) + '2';

describe('reglas de la orden', () => {
  it('ninguna orden salta del cobro a la entrega ni sale de un estado final', () => {
    expect(orderCanMove('CREADA', 'COBRO_EN_VERIFICACION')).toBe(true);
    expect(orderCanMove('CREADA', 'ENTREGA_AUTORIZADA')).toBe(false);
    expect(orderCanMove('ENTREGA_ENVIADA', 'COMPLETADA')).toBe(true);
    expect(orderCanMove('COMPLETADA', 'EN_REVISION')).toBe(false);
    expect(orderCanMove('COBRO_CONFIRMADO', 'CANCELADA')).toBe(false);
  });

  it('valida el formato de referencias y hashes', () => {
    expect(isValidExternalRef('TRON', TRON_HASH)).toBe(true);
    expect(isValidExternalRef('TRON', '0x' + TRON_HASH)).toBe(false);
    expect(isValidExternalRef('BSC', BSC_HASH)).toBe(true);
    expect(isValidExternalRef('BANK', 'BCOL-2026-000123')).toBe(true);
    expect(isValidExternalRef('BANK', 'ref con espacios')).toBe(false);
  });
});

describe('ciclo de la orden', () => {
  let env: Env;
  let andina: string;

  async function newOrder(side: 'BUY' | 'SELL', usdtAmount: string, network: 'TRON' | 'BSC' = 'TRON'): Promise<OrderRow> {
    const req = await as(env, 'trader', (ctx) => createRequest(ctx, { counterpartyId: andina, side, usdtAmount, network }));
    if (req.status !== 'VALIDADA') throw new Error(req.status_reason ?? req.status);
    const q = await as(env, 'trader', (ctx) => createQuote(ctx, req.id));
    const r = await as(env, 'trader', (ctx) => acceptQuote(ctx, q.id));
    if (!r.ok) throw r.error;
    return r.order;
  }
  const status = async (id: string) => (await env.db.query('SELECT status FROM otc.orders WHERE id = $1', [id])).rows[0].status;
  const reservation = async (orderId: string) =>
    (await env.db.query('SELECT status, transfer_id FROM otc.reservations WHERE order_id = $1 ORDER BY created_at DESC LIMIT 1', [orderId])).rows[0];

  beforeAll(async () => {
    env = await setupEnv();
    andina = (await env.db.query(`SELECT id FROM otc.counterparties WHERE document_number = '900000001'`)).rows[0].id;
    await as(env, 'trader', (ctx) => recordTrm(ctx, { rate: '4000' }));
  });
  afterAll(async () => env.close());

  it('registrar el pago deja la orden en verificación con un cobro Enviado; nunca confirmado', async () => {
    const o = await newOrder('SELL', '1000');
    await expectCode(as(env, 'trader', (ctx) => registerPayment(ctx, o.id, { reference: 'mal ref' })), 'INVALID');
    const r = await as(env, 'trader', (ctx) => registerPayment(ctx, o.id, { reference: 'BCOL-0001' }));
    expect(r.order.status).toBe('COBRO_EN_VERIFICACION');
    expect(r.transfer).toMatchObject({ purpose: 'COBRO', direction: 'IN', rail: 'BANK', asset: 'COP', amount: '4019020.000000', status: 'ENVIADA' });

    // La misma referencia no se acepta en otra orden (tampoco cambiando mayúsculas).
    const o2 = await newOrder('SELL', '10');
    const err = await expectCode(as(env, 'trader', (ctx) => registerPayment(ctx, o2.id, { reference: 'bcol-0001' })), 'DUPLICATE_REFERENCE');
    expect((err as Error).message).toBe(`Esta referencia ya está registrada en la orden ${o.number}`);
    await expectCode(as(env, 'trader', (ctx) => registerPayment(ctx, o.id, { reference: 'BCOL-0002' })), 'INVALID_STATE');
  });

  it('en una compra el cobro es en USDT por la red de la orden', async () => {
    const o = await newOrder('BUY', '500', 'BSC');
    await expectCode(as(env, 'trader', (ctx) => registerPayment(ctx, o.id, { reference: TRON_HASH })), 'INVALID');
    const r = await as(env, 'trader', (ctx) => registerPayment(ctx, o.id, { reference: BSC_HASH }));
    expect(r.transfer).toMatchObject({ rail: 'BSC', asset: 'USDT', amount: '500.000000' });
  });

  it('un pago reportado después del plazo manda la orden a revisión con un pendiente abierto', async () => {
    const o = await newOrder('SELL', '20');
    env.clock.advance(480);
    const r = await as(env, 'trader', (ctx) => registerPayment(ctx, o.id, { reference: 'BCOL-TARDE-1' }));
    expect(r.order).toMatchObject({ status: 'EN_REVISION', review_from: 'CREADA', status_reason: 'Pago reportado después del plazo de pago' });
    const c = await env.db.query(`SELECT status FROM otc.cases WHERE entity = 'order' AND entity_id = $1`, [o.id]);
    expect(c.rows[0].status).toBe('ABIERTO');
    // Con dinero reportado no se puede cancelar: hay que confirmarlo o devolverlo.
    await expectCode(as(env, 'admin', (ctx) => resolveReview(ctx, o.id, 'CANCEL', 'No llegó')), 'MONEY_IN_FLIGHT');
  });

  it('sobre el umbral la entrega exige dos aprobaciones de personas distintas; luego nace la transferencia y se bloquea la reserva', async () => {
    const o = await newOrder('SELL', '20000'); // 80.380.400 COP, por encima de 50.000.000
    expect(o.required_approvals).toBe(2);
    await as(env, 'trader', (ctx) => registerPayment(ctx, o.id, { reference: 'BCOL-0100' }));
    await expectCode(as(env, 'trader', (ctx) => approveDelivery(ctx, o.id, null)), 'INVALID_STATE'); // falta el cobro confirmado
    await asSystem(env, (ctx) => onCollectionConfirmed(ctx, o.id, { source: 'prueba' }));
    expect(await status(o.id)).toBe('COBRO_CONFIRMADO');

    const first = await as(env, 'trader', (ctx) => approveDelivery(ctx, o.id, 'Primera firma'));
    expect(first).toMatchObject({ approvals: 1, required: 2, transfer: null });
    expect(await status(o.id)).toBe('COBRO_CONFIRMADO');
    await expectCode(as(env, 'trader', (ctx) => approveDelivery(ctx, o.id, 'otra vez')), 'ALREADY_APPROVED');
    await expectCode(as(env, 'cumplimiento', (ctx) => approveDelivery(ctx, o.id, null)), 'FORBIDDEN');

    const second = await as(env, 'tesorero2', (ctx) => approveDelivery(ctx, o.id, 'Segunda firma'));
    expect(second.order.status).toBe('ENTREGA_AUTORIZADA');
    expect(second.transfer).toMatchObject({ purpose: 'ENTREGA', direction: 'OUT', rail: 'TRON', asset: 'USDT', amount: '20000.000000', status: 'AUTORIZADA' });
    expect(await reservation(o.id)).toEqual({ status: 'LOCKED', transfer_id: second.transfer!.id });

    const detail = await as(env, 'auditor', (ctx) => getOrder(ctx, o.id));
    expect(detail.approvals).toHaveLength(2);
    expect(detail.history.map((h: { to_status: string }) => h.to_status)).toEqual([
      'CREADA',
      'COBRO_EN_VERIFICACION',
      'COBRO_CONFIRMADO',
      'ENTREGA_AUTORIZADA',
    ]);
  });

  it('una orden conserva la política con la que nació aunque la política cambie después', async () => {
    const before = await newOrder('SELL', '100');
    expect(before.required_approvals).toBe(1);
    const p = await as(env, 'admin', (ctx) =>
      proposeLimitChange(ctx, { kind: 'APPROVAL_POLICY', value: { policy: 'ALL' }, reason: 'Dos firmas siempre (prueba)' }),
    );
    await as(env, 'admin2', (ctx) => decideLimitChange(ctx, p.id, true, 'Prueba'));
    const after = await newOrder('SELL', '100');
    expect(after.required_approvals).toBe(2);
    await as(env, 'trader', (ctx) => registerPayment(ctx, before.id, { reference: 'BCOL-0200' }));
    await asSystem(env, (ctx) => onCollectionConfirmed(ctx, before.id, { source: 'prueba' }));
    const r = await as(env, 'trader', (ctx) => approveDelivery(ctx, before.id, null));
    expect(r.order.status).toBe('ENTREGA_AUTORIZADA');
  });

  it('se cancela antes del pago y libera la reserva; después del pago no', async () => {
    const o = await newOrder('SELL', '30');
    await expectCode(as(env, 'trader', (ctx) => cancelOrder(ctx, o.id, '')), 'INVALID');
    await as(env, 'trader', (ctx) => cancelOrder(ctx, o.id, 'El cliente desistió (prueba)'));
    expect(await status(o.id)).toBe('CANCELADA');
    expect((await reservation(o.id)).status).toBe('RELEASED');

    const paid = await newOrder('SELL', '30');
    await as(env, 'trader', (ctx) => registerPayment(ctx, paid.id, { reference: 'BCOL-0300' }));
    const err = await expectCode(as(env, 'trader', (ctx) => cancelOrder(ctx, paid.id, 'desistió')), 'INVALID_STATE');
    expect((err as Error).message).toContain('envíala a revisión');
  });

  it('revisión: congela la orden; el administrador la reanuda o la cancela si no hay dinero en movimiento', async () => {
    const o = await newOrder('SELL', '40');
    await as(env, 'trader', (ctx) => registerPayment(ctx, o.id, { reference: 'BCOL-0400' }));
    await expectCode(as(env, 'auditor', (ctx) => markForReview(ctx, o.id, 'no cuadra')), 'FORBIDDEN');
    await as(env, 'cumplimiento', (ctx) => markForReview(ctx, o.id, 'El nombre del pagador no coincide'));
    expect(await status(o.id)).toBe('EN_REVISION');
    // En revisión no avanza: la confirmación que llegue se guarda, pero el estado no cambia solo.
    await asSystem(env, (ctx) => onCollectionConfirmed(ctx, o.id, { source: 'prueba' }));
    expect(await status(o.id)).toBe('EN_REVISION');
    await expectCode(as(env, 'trader', (ctx) => resolveReview(ctx, o.id, 'RESUME', 'ok')), 'FORBIDDEN');
    await as(env, 'admin', (ctx) => resolveReview(ctx, o.id, 'RESUME', 'Pagador verificado por teléfono'));
    expect(await status(o.id)).toBe('COBRO_EN_VERIFICACION');
    const c = await env.db.query(`SELECT status FROM otc.cases WHERE entity = 'order' AND entity_id = $1`, [o.id]);
    expect(c.rows[0].status).not.toBe('ABIERTO');

    const fresh = await newOrder('SELL', '40');
    await as(env, 'trader', (ctx) => markForReview(ctx, fresh.id, 'Cliente sospechoso (prueba)'));
    await as(env, 'admin', (ctx) => resolveReview(ctx, fresh.id, 'CANCEL', 'No se opera (prueba)'));
    expect(await status(fresh.id)).toBe('CANCELADA');
    expect((await reservation(fresh.id)).status).toBe('RELEASED');
  });

  it('por HTTP: registrar el pago y aprobar la entrega pidiendo otra vez el segundo factor', async () => {
    const o = await newOrder('BUY', '100', 'TRON');
    const op = await httpLogin(env, 'trader');
    const k = newKey();
    const paid = await call(env, op, 'POST', `/orders/${o.id}/payment`, { reference: TRON_HASH }, { 'idempotency-key': k });
    expect(paid.status).toBe(200);
    expect(paid.body.order.status).toBe('COBRO_EN_VERIFICACION');
    const replay = await call(env, op, 'POST', `/orders/${o.id}/payment`, { reference: TRON_HASH }, { 'idempotency-key': k });
    expect(replay.body.transfer.id).toBe(paid.body.transfer.id);
    await asSystem(env, (ctx) => onCollectionConfirmed(ctx, o.id, { source: 'prueba' }));

    const noCode = await call(env, op, 'POST', `/orders/${o.id}/approve`, {}, { 'idempotency-key': newKey() });
    expect([noCode.status, noCode.body.code]).toEqual([401, 'STEP_UP_REQUIRED']);
    const first = await call(env, op, 'POST', `/orders/${o.id}/approve`, { note: 'ok' }, { 'idempotency-key': newKey(), ...stepUp(env, 'trader') });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ approvals: 1, required: 2 }); // la política ya es "siempre dos"
    const t2 = await httpLogin(env, 'tesorero2');
    const second = await call(env, t2, 'POST', `/orders/${o.id}/approve`, {}, { 'idempotency-key': newKey(), ...stepUp(env, 'tesorero2') });
    expect(second.body.order.status).toBe('ENTREGA_AUTORIZADA');
    expect(second.body.transfer).toMatchObject({ rail: 'BANK', asset: 'COP', status: 'AUTORIZADA' });
  });
});
