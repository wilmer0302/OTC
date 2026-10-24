import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addressKey, networkFits, type Network } from '../../src/modules/counterparties/domain.js';
import { createCounterparty } from '../../src/modules/counterparties/service.js';
import { decideOrigin, proposeOrigin, revokeOrigin } from '../../src/modules/counterparties/origins.js';
import { decide } from '../../src/modules/confirmations/domain.js';
import { authorizedOrigins, decideOriginException, requestOriginException } from '../../src/modules/confirmations/origins.js';
import { resolveTransferReview } from '../../src/modules/confirmations/service.js';
import { registerPayment, type OrderRow } from '../../src/modules/orders/service.js';
import { recordTrm } from '../../src/modules/pricing/service.js';
import { simulateFor, type SimulateInput } from '../../src/modules/sandbox/service.js';
import { acceptQuote, createQuote, createRequest } from '../../src/modules/trading/service.js';
import { SANDBOX_USDT_CONTRACT } from '../../src/integrations/sandbox.js';
import { POLICY } from '../../src/platform/policy.js';
import { DEMO_ORIGINS } from '../../src/seedV1.js';
import { as, call, checkNow, expectCode, httpLogin, newKey, setupEnv, stepUp, type Env } from './helpers.js';

// Billeteras de origen: solo un depósito en USDT desde una dirección aprobada del cliente,
// en la red correcta y del contrato autorizado, se acredita solo. Todo lo demás va a revisión.
// La red es SIMULADA (sandbox): estas pruebas validan las reglas del servidor, no una red real.

const ANDINA_TRON = DEMO_ORIGINS[0].address;
const CARIBE_TRON = DEMO_ORIGINS[2].address;
const tron = (tag: string) => `TRemite${tag}`.padEnd(34, '1');
const exp = { to: 'TMesa', direction: 'IN' as const, amount: '1000000', network: 'TRON' as const, tokenContract: SANDBOX_USDT_CONTRACT.TRON };
const ok = { found: true, status: 'SUCCESS' as const, confirmations: 30, to: 'TMesa', amount: '1000000', tokenContract: SANDBOX_USDT_CONTRACT.TRON };
const timing = { ageSeconds: 10, pendingSeconds: 900, reviewSeconds: 3600, requiredConfirmations: 20 };

describe('reglas puras del control de origen', () => {
  it('solo confirma con un origen autorizado y el contrato autorizado', () => {
    expect(decide({ ...ok, from: 'TCliente' }, { ...exp, allowedFrom: ['TCliente'] }, timing).kind).toBe('CONFIRM');
    expect(decide({ ...ok, from: 'TOtro' }, { ...exp, allowedFrom: ['TCliente'] }, timing).kind).toBe('REVIEW');
    expect(decide({ ...ok, from: 'TCliente' }, { ...exp, allowedFrom: [] }, timing).kind).toBe('REVIEW');
    // Sin origen informado por la red no se puede verificar: revisión.
    expect(decide({ ...ok }, { ...exp, allowedFrom: ['TCliente'] }, timing).kind).toBe('REVIEW');
    // Contrato falso, aunque el monto, el destino y el origen coincidan.
    const fake = decide({ ...ok, from: 'TCliente', tokenContract: 'TContratoFalso' }, { ...exp, allowedFrom: ['TCliente'] }, timing);
    expect(fake).toMatchObject({ kind: 'REVIEW' });
    expect((fake as { reason: string }).reason).toContain('El token no es el autorizado');
    expect(decide({ ...ok, from: 'TCliente', tokenContract: undefined }, { ...exp, allowedFrom: ['TCliente'] }, timing).kind).toBe('REVIEW');
  });

  it('compara direcciones según su red: Tron distingue mayúsculas, BSC no', () => {
    expect(addressKey('TRON', 'TAbC')).not.toBe(addressKey('TRON', 'tabc'));
    expect(addressKey('BSC', '0xAbC')).toBe(addressKey('BSC', '0xabc'));
    expect(decide({ ...ok, from: ANDINA_TRON.toLowerCase() }, { ...exp, allowedFrom: [ANDINA_TRON] }, timing).kind).toBe('REVIEW');
    const bsc = { ...exp, network: 'BSC' as const, tokenContract: SANDBOX_USDT_CONTRACT.BSC };
    const bscObs = { ...ok, tokenContract: SANDBOX_USDT_CONTRACT.BSC, from: '0x00000000000000000000000000000000000B0001' };
    expect(decide(bscObs, { ...bsc, allowedFrom: ['0x00000000000000000000000000000000000b0001'] }, timing).kind).toBe('CONFIRM');
  });

  it('límite de redes: una red nueva cabe solo bajo el máximo; una red ya habilitada siempre admite más direcciones', () => {
    const four = ['TRON', 'BSC', 'RED3', 'RED4'] as unknown as Network[];
    expect(networkFits(four, 'TRON', 4)).toBe(true);
    expect(networkFits(four, 'RED5' as Network, 4)).toBe(false);
    expect(networkFits(['TRON', 'BSC', 'RED3'] as unknown as Network[], 'RED4' as Network, 4)).toBe(true);
    expect(networkFits([], 'BSC', 1)).toBe(true);
    expect(networkFits(['TRON'], 'BSC', 1)).toBe(false);
    expect(POLICY.maxOriginNetworksPerClient).toBe(4); // valor por defecto de la configuración central
  });
});

describe('billeteras de origen con base de datos', () => {
  let env: Env;
  let andina: string;
  let caribe: string;
  let n = 0;
  const hash = () => (++n).toString(16).padStart(64, 'a');
  const statusOf = async (table: 'orders' | 'transfers', id: string) => (await env.db.query(`SELECT status FROM otc.${table} WHERE id = $1`, [id])).rows[0].status;
  const sim = (id: string, input: SimulateInput) => as(env, 'admin', (ctx) => simulateFor(ctx, id, input));
  const entriesOf = async (orderId: string) => (await env.db.query('SELECT count(*)::int AS n FROM otc.journal_entries WHERE order_id = $1', [orderId])).rows[0].n;

  /** Orden en la que la mesa compra USDT: el cliente deposita en la billetera Tron de la mesa. */
  async function deposit(counterpartyId: string, from: string | undefined, extra: Partial<SimulateInput> = {}) {
    const req = await as(env, 'trader', (ctx) => createRequest(ctx, { counterpartyId, side: 'BUY', usdtAmount: '100', network: 'TRON' }));
    const q = await as(env, 'trader', (ctx) => createQuote(ctx, req.id));
    const r = await as(env, 'trader', (ctx) => acceptQuote(ctx, q.id));
    if (!r.ok) throw r.error;
    const order: OrderRow = r.order;
    const paid = await as(env, 'trader', (ctx) => registerPayment(ctx, order.id, { reference: hash(), fromRef: 'lo que diga el cliente no cuenta' }));
    await sim(paid.transfer.id, { status: 'SUCCESS', confirmations: 100, ...(from ? { fromAddress: from } : {}), ...extra });
    const checked = await checkNow(env, paid.transfer.id);
    return { order, transfer: paid.transfer, status: checked.status };
  }

  beforeAll(async () => {
    env = await setupEnv();
    const doc = async (d: string) => (await env.db.query('SELECT id FROM otc.counterparties WHERE document_number = $1', [d])).rows[0].id;
    andina = await doc('900000001');
    caribe = await doc('900000002');
    await as(env, 'trader', (ctx) => recordTrm(ctx, { rate: '4000' }));
  });
  afterAll(async () => env.close());

  it('la demo trae billeteras de origen aprobadas por Cumplimiento', async () => {
    const r = await env.db.query(`SELECT count(*)::int AS n FROM otc.origin_addresses WHERE status = 'APROBADA'`);
    expect(r.rows[0].n).toBe(4);
  });

  it('depósito desde una billetera aprobada del cliente: se acredita solo', async () => {
    const d = await deposit(andina, ANDINA_TRON);
    expect(d.status).toBe('CONFIRMADA');
    expect(await statusOf('orders', d.order.id)).toBe('COBRO_CONFIRMADO');
  });

  it('depósito desde una dirección desconocida: revisión, sin asiento ni avance de la orden', async () => {
    const d = await deposit(andina, tron('Desconocida'));
    expect(d.status).toBe('EN_REVISION');
    expect(await statusOf('orders', d.order.id)).toBe('EN_REVISION');
    expect(await entriesOf(d.order.id)).toBe(0);
    const obs = await env.db.query(`SELECT note FROM otc.observations WHERE transfer_id = $1 ORDER BY id DESC LIMIT 1`, [d.transfer.id]);
    expect(obs.rows[0].note).toContain('Origen no autorizado');
    // Ni el administrador puede confirmarla sin una excepción autorizada.
    await expectCode(as(env, 'admin', (ctx) => resolveTransferReview(ctx, d.transfer.id, 'CONFIRMADA', 'Parece del cliente')), 'NO_EVIDENCE');
  });

  it('depósito desde la billetera aprobada de OTRO cliente: revisión', async () => {
    const d = await deposit(andina, CARIBE_TRON);
    expect(d.status).toBe('EN_REVISION');
  });

  it('pendiente, rechazada y revocada no superan el control', async () => {
    const pending = await as(env, 'trader', (ctx) => proposeOrigin(ctx, andina, { network: 'TRON', address: tron('Pendiente'), label: 'Pendiente' }));
    expect(pending.status).toBe('PENDIENTE');
    expect((await deposit(andina, tron('Pendiente'))).status).toBe('EN_REVISION');

    const rejected = await as(env, 'trader', (ctx) => proposeOrigin(ctx, andina, { network: 'TRON', address: tron('Rechazada'), label: 'Rechazada' }));
    await as(env, 'cumplimiento', (ctx) => decideOrigin(ctx, rejected.id as string, false, 'No es del cliente'));
    expect((await deposit(andina, tron('Rechazada'))).status).toBe('EN_REVISION');

    const revoked = await as(env, 'trader', (ctx) => proposeOrigin(ctx, andina, { network: 'TRON', address: tron('Revocada'), label: 'Revocada' }));
    await as(env, 'cumplimiento', (ctx) => decideOrigin(ctx, revoked.id as string, true, 'Verificada con el cliente'));
    expect((await deposit(andina, tron('Revocada'))).status).toBe('CONFIRMADA');
    await as(env, 'cumplimiento', (ctx) => revokeOrigin(ctx, revoked.id as string, 'El cliente reportó la billetera comprometida'));
    expect((await deposit(andina, tron('Revocada'))).status).toBe('EN_REVISION');
  });

  it('contrato falso con el mismo monto, destino y origen aprobado: revisión', async () => {
    const d = await deposit(andina, ANDINA_TRON, { tokenContract: 'TContratoFalsoQueSeLlamaUSDT111111' });
    expect(d.status).toBe('EN_REVISION');
    const obs = await env.db.query(`SELECT note FROM otc.observations WHERE transfer_id = $1 ORDER BY id DESC LIMIT 1`, [d.transfer.id]);
    expect(obs.rows[0].note).toContain('El token no es el autorizado');
  });

  it('el mismo hash no se acepta dos veces como depósito', async () => {
    const first = await deposit(andina, ANDINA_TRON);
    const req = await as(env, 'trader', (ctx) => createRequest(ctx, { counterpartyId: andina, side: 'BUY', usdtAmount: '100', network: 'TRON' }));
    const q = await as(env, 'trader', (ctx) => createQuote(ctx, req.id));
    const r = await as(env, 'trader', (ctx) => acceptQuote(ctx, q.id));
    if (!r.ok) throw r.error;
    await expectCode(as(env, 'trader', (ctx) => registerPayment(ctx, r.order.id, { reference: first.transfer.external_ref! })), 'DUPLICATE_REFERENCE');
  });

  it('valida red, formato y duplicados al registrar', async () => {
    await expectCode(as(env, 'trader', (ctx) => proposeOrigin(ctx, andina, { network: 'ETH' as Network, address: tron('Eth'), label: 'x' })), 'INVALID');
    await expectCode(as(env, 'trader', (ctx) => proposeOrigin(ctx, andina, { network: 'TRON', address: '0x00000000000000000000000000000000000c0001', label: 'x' })), 'INVALID');
    await expectCode(as(env, 'trader', (ctx) => proposeOrigin(ctx, andina, { network: 'BSC', address: tron('EnBsc'), label: 'x' })), 'INVALID');
    // Duplicada en la misma red, del mismo cliente o de otro.
    await expectCode(as(env, 'trader', (ctx) => proposeOrigin(ctx, andina, { network: 'TRON', address: ANDINA_TRON, label: 'x' })), 'DUPLICATE');
    await expectCode(as(env, 'trader', (ctx) => proposeOrigin(ctx, andina, { network: 'TRON', address: CARIBE_TRON, label: 'x' })), 'DUPLICATE');
    // En BSC la misma dirección con otras mayúsculas es la misma.
    const bscUpper = DEMO_ORIGINS[1].address.toUpperCase().replace('0X', '0x');
    await expectCode(as(env, 'trader', (ctx) => proposeOrigin(ctx, andina, { network: 'BSC', address: bscUpper, label: 'x' })), 'DUPLICATE');
    // Una dirección rechazada o revocada se puede volver a proponer: queda pendiente otra vez.
    const again = await as(env, 'trader', (ctx) => proposeOrigin(ctx, andina, { network: 'TRON', address: tron('Rechazada'), label: 'Otra vez' }));
    expect(again.status).toBe('PENDIENTE');
  });

  it('las aprobaciones son de Cumplimiento y quedan en la auditoría con usuario, fecha y motivo', async () => {
    const o = await as(env, 'trader', (ctx) => proposeOrigin(ctx, caribe, { network: 'TRON', address: tron('Auditoria'), label: 'Auditoría' }));
    await expectCode(as(env, 'trader', (ctx) => decideOrigin(ctx, o.id as string, true, 'yo mismo')), 'FORBIDDEN');
    await expectCode(as(env, 'admin', (ctx) => decideOrigin(ctx, o.id as string, true, 'administrador')), 'FORBIDDEN');
    await expectCode(as(env, 'tesorero2', (ctx) => decideOrigin(ctx, o.id as string, true, 'tesorería')), 'FORBIDDEN');
    await as(env, 'cumplimiento', (ctx) => decideOrigin(ctx, o.id as string, true, 'Certificación de la billetera recibida'));
    await expectCode(as(env, 'cumplimiento', (ctx) => decideOrigin(ctx, o.id as string, false, 'otra vez')), 'INVALID_STATE');
    await expectCode(as(env, 'admin', (ctx) => revokeOrigin(ctx, o.id as string, 'administrador')), 'FORBIDDEN');
    const a = await env.db.query(
      `SELECT l.at, u.username, l.data FROM audit_log l JOIN users u ON u.id = l.actor_id WHERE l.action = 'origin.approve' AND l.entity_id = $1`,
      [o.id],
    );
    expect(a.rowCount).toBe(1);
    expect(a.rows[0].username).toBe('cumplimiento');
    expect(a.rows[0].data.note).toBe('Certificación de la billetera recibida');
    expect(a.rows[0].at).toBeInstanceOf(Date);
  });

  it('límite de redes por cliente desde la configuración central, validado en el servidor', async () => {
    // Hoy la plataforma soporta 2 redes, así que el máximo de 4 no se puede superar en la práctica;
    // se baja a 1 para comprobar que el servidor aplica el límite.
    const cp = await env.db.query(`SELECT id FROM otc.counterparties WHERE document_number = '900000003'`);
    const nuevo = cp.rows[0].id;
    const saved = POLICY.maxOriginNetworksPerClient;
    POLICY.maxOriginNetworksPerClient = 1;
    try {
      const t1 = await as(env, 'trader', (ctx) => proposeOrigin(ctx, nuevo, { network: 'TRON', address: tron('LimiteA'), label: 'A' }));
      await as(env, 'trader', (ctx) => proposeOrigin(ctx, nuevo, { network: 'TRON', address: tron('LimiteB'), label: 'B' })); // misma red: sin tope
      await expectCode(
        as(env, 'trader', (ctx) => proposeOrigin(ctx, nuevo, { network: 'BSC', address: '0x00000000000000000000000000000000000d0003', label: 'C' })),
        'NETWORK_LIMIT',
      );
      // Rechazadas o revocadas ya no cuentan: la red deja de estar habilitada.
      await as(env, 'cumplimiento', (ctx) => decideOrigin(ctx, t1.id as string, false, 'No corresponde'));
      const tB = await env.db.query(`SELECT id FROM otc.origin_addresses WHERE address = $1`, [tron('LimiteB')]);
      await as(env, 'cumplimiento', (ctx) => decideOrigin(ctx, tB.rows[0].id, false, 'No corresponde'));
      const bsc = await as(env, 'trader', (ctx) => proposeOrigin(ctx, nuevo, { network: 'BSC', address: '0x00000000000000000000000000000000000d0003', label: 'C' }));
      expect(bsc.status).toBe('PENDIENTE');
    } finally {
      POLICY.maxOriginNetworksPerClient = saved;
    }
  });

  it('un origen aprobado en una red no autoriza depósitos en otra', async () => {
    const tronOrigins = await as(env, 'admin', (ctx) => authorizedOrigins(ctx.tx, andina, 'TRON', '00000000-0000-0000-0000-000000000000'));
    const bscOrigins = await as(env, 'admin', (ctx) => authorizedOrigins(ctx.tx, andina, 'BSC', '00000000-0000-0000-0000-000000000000'));
    expect(tronOrigins).toContain(ANDINA_TRON);
    expect(bscOrigins).not.toContain(ANDINA_TRON);
    expect(bscOrigins).toContain(DEMO_ORIGINS[1].address);
  });

  it('excepción: se solicita con motivo, la autoriza otra persona de Cumplimiento y solo entonces se puede confirmar', async () => {
    const d = await deposit(caribe, tron('Excepcion'));
    expect(d.status).toBe('EN_REVISION');
    await expectCode(as(env, 'trader', (ctx) => requestOriginException(ctx, d.transfer.id, 'corto')), 'INVALID');
    await expectCode(as(env, 'cumplimiento', (ctx) => requestOriginException(ctx, d.transfer.id, 'Cumplimiento no la solicita')), 'FORBIDDEN');
    const e = await as(env, 'trader', (ctx) => requestOriginException(ctx, d.transfer.id, 'El cliente pagó desde la billetera de su filial; soporte adjunto'));
    expect(e).toMatchObject({ status: 'SOLICITADA', from_address: tron('Excepcion') }); // la dirección sale de la red, no del formulario
    await expectCode(as(env, 'trader', (ctx) => requestOriginException(ctx, d.transfer.id, 'Segunda solicitud para lo mismo')), 'DUPLICATE');
    await expectCode(as(env, 'admin', (ctx) => resolveTransferReview(ctx, d.transfer.id, 'CONFIRMADA', 'antes de autorizar')), 'NO_EVIDENCE');
    await expectCode(as(env, 'trader', (ctx) => decideOriginException(ctx, e.id, true, 'yo mismo')), 'FORBIDDEN');
    await expectCode(as(env, 'admin', (ctx) => decideOriginException(ctx, e.id, true, 'administrador')), 'FORBIDDEN');
    await as(env, 'cumplimiento', (ctx) => decideOriginException(ctx, e.id, true, 'Soporte de la filial verificado'));
    // La excepción no confirma sola: la transferencia sigue en revisión hasta que la resuelve el administrador.
    expect(await statusOf('transfers', d.transfer.id)).toBe('EN_REVISION');
    await as(env, 'admin', (ctx) => resolveTransferReview(ctx, d.transfer.id, 'CONFIRMADA', 'Con excepción de origen autorizada'));
    expect(await statusOf('transfers', d.transfer.id)).toBe('CONFIRMADA');
    const trail = await env.db.query(
      `SELECT action FROM audit_log WHERE action LIKE 'origin.exception.%' AND entity_id = $1 ORDER BY id`,
      [e.id],
    );
    expect(trail.rows.map((r) => r.action)).toEqual(['origin.exception.request', 'origin.exception.approve']);
    // La excepción vale para esa transferencia: otro depósito desde la misma dirección vuelve a revisión.
    expect((await deposit(caribe, tron('Excepcion'))).status).toBe('EN_REVISION');
  });

  it('la excepción de origen no tapa otro problema: con un contrato falso no se puede solicitar', async () => {
    const d = await deposit(caribe, tron('ExcepToken'), { tokenContract: 'TContratoFalsoQueSeLlamaUSDT111111' });
    expect(d.status).toBe('EN_REVISION');
    await expectCode(as(env, 'trader', (ctx) => requestOriginException(ctx, d.transfer.id, 'Pide excepción para un token falso')), 'NOT_ORIGIN_ISSUE');
  });

  it('separación de funciones: quien pide o propone no decide, aunque tenga el rol de Cumplimiento', async () => {
    // Un usuario con los dos roles: el permiso no lo frena, solo la regla de persona distinta.
    await env.db.query(
      `INSERT INTO public.users (username, full_name, password_hash, roles)
       SELECT 'mixto', 'Operador y Cumplimiento (prueba)', password_hash, ARRAY['OPERADOR','CUMPLIMIENTO'] FROM public.users WHERE username = 'trader'
       ON CONFLICT (username) DO NOTHING`,
    );
    const o = await as(env, 'mixto', (ctx) => proposeOrigin(ctx, caribe, { network: 'TRON', address: tron('Mixto'), label: 'Mixto' }));
    await expectCode(as(env, 'mixto', (ctx) => decideOrigin(ctx, o.id as string, true, 'me apruebo')), 'FORBIDDEN');

    const d = await deposit(caribe, tron('MixtoDeposito'));
    const e = await as(env, 'mixto', (ctx) => requestOriginException(ctx, d.transfer.id, 'El cliente pagó desde una billetera nueva'));
    await expectCode(as(env, 'mixto', (ctx) => decideOriginException(ctx, e.id, true, 'me autorizo')), 'FORBIDDEN');
    // La base también lo impide, aunque alguien salte la aplicación.
    const mixto = await env.db.query(`SELECT id FROM public.users WHERE username = 'mixto'`);
    await expect(
      env.db.query(`UPDATE otc.origin_exceptions SET status = 'APROBADA', decided_by = $2, decided_at = now(), decision_note = 'directo' WHERE id = $1`, [
        e.id,
        mixto.rows[0].id,
      ]),
    ).rejects.toThrow();
    await as(env, 'cumplimiento', (ctx) => decideOriginException(ctx, e.id, true, 'Verificada por otra persona'));
  });

  it('la excepción no cambia importe, destino, contrato ni confirmaciones exigidas', async () => {
    // Importe, destino o contrato distintos: la revisión no es solo por el origen y no se puede pedir.
    const amount = await deposit(caribe, tron('ExcepMonto'), { amount: '99' });
    expect(amount.status).toBe('EN_REVISION');
    await expectCode(as(env, 'trader', (ctx) => requestOriginException(ctx, amount.transfer.id, 'El cliente pagó desde otra billetera')), 'NOT_ORIGIN_ISSUE');
    const dest = await deposit(caribe, tron('ExcepDestino'), { toAddress: tron('OtraMesa') });
    expect(dest.status).toBe('EN_REVISION');
    await expectCode(as(env, 'trader', (ctx) => requestOriginException(ctx, dest.transfer.id, 'El cliente pagó desde otra billetera')), 'NOT_ORIGIN_ISSUE');
    const token = await deposit(caribe, tron('ExcepContrato'), { tokenContract: 'TContratoFalsoQueSeLlamaUSDT111111' });
    await expectCode(as(env, 'trader', (ctx) => requestOriginException(ctx, token.transfer.id, 'El cliente pagó desde otra billetera')), 'NOT_ORIGIN_ISSUE');

    // Confirmaciones: con la excepción autorizada, sigue sin confirmarse por debajo del umbral.
    const few = await deposit(caribe, tron('ExcepConfirm'), { confirmations: 1 });
    expect(few.status).toBe('EN_REVISION');
    const e = await as(env, 'trader', (ctx) => requestOriginException(ctx, few.transfer.id, 'El cliente pagó desde la billetera de su filial'));
    await as(env, 'cumplimiento', (ctx) => decideOriginException(ctx, e.id, true, 'Filial verificada'));
    await expectCode(as(env, 'admin', (ctx) => resolveTransferReview(ctx, few.transfer.id, 'CONFIRMADA', 'Con excepción')), 'NO_EVIDENCE');

    // Si después de autorizada la red informa otro importe u otro origen, tampoco se confirma.
    const later = await deposit(caribe, tron('ExcepDespues'));
    const e2 = await as(env, 'trader', (ctx) => requestOriginException(ctx, later.transfer.id, 'El cliente pagó desde la billetera de su filial'));
    await as(env, 'cumplimiento', (ctx) => decideOriginException(ctx, e2.id, true, 'Filial verificada'));
    await sim(later.transfer.id, { status: 'SUCCESS', confirmations: 100, fromAddress: tron('ExcepDespues'), amount: '99' });
    await checkNow(env, later.transfer.id);
    await expectCode(as(env, 'admin', (ctx) => resolveTransferReview(ctx, later.transfer.id, 'CONFIRMADA', 'Con excepción')), 'NO_EVIDENCE');
    await sim(later.transfer.id, { status: 'SUCCESS', confirmations: 100, fromAddress: tron('OtroOrigen') });
    await checkNow(env, later.transfer.id);
    await expectCode(as(env, 'admin', (ctx) => resolveTransferReview(ctx, later.transfer.id, 'CONFIRMADA', 'Con excepción')), 'NO_EVIDENCE');
    expect(await entriesOf(later.order.id)).toBe(0);
  });

  it('una excepción solo se autoriza mientras el depósito sigue en revisión; negarla siempre se puede', async () => {
    const d = await deposit(caribe, tron('ExcepTarde'));
    const e = await as(env, 'trader', (ctx) => requestOriginException(ctx, d.transfer.id, 'El cliente pagó desde la billetera de su filial'));
    await as(env, 'admin', (ctx) => resolveTransferReview(ctx, d.transfer.id, 'PENDIENTE', 'Vuelve a seguimiento'));
    expect(await statusOf('transfers', d.transfer.id)).not.toBe('EN_REVISION');
    await expectCode(as(env, 'cumplimiento', (ctx) => decideOriginException(ctx, e.id, true, 'Tarde')), 'INVALID_STATE');
    const closed = await as(env, 'cumplimiento', (ctx) => decideOriginException(ctx, e.id, false, 'Ya no aplica'));
    expect(closed.status).toBe('RECHAZADA');
  });

  it('solicitudes simultáneas: el tope de redes y los duplicados se respetan', async () => {
    const nuevo = async (nit: string) =>
      (await as(env, 'trader', (ctx) => createCounterparty(ctx, { kind: 'CLIENTE', personType: 'JURIDICA', documentType: 'NIT', documentNumber: nit, legalName: `Prueba ${nit} SAS` }))).id as string;
    const a = await nuevo('900999101');
    const b = await nuevo('900999102');
    const saved = POLICY.maxOriginNetworksPerClient;
    POLICY.maxOriginNetworksPerClient = 1;
    try {
      // Dos redes distintas a la vez para el mismo cliente con tope 1: entra una sola.
      const both = await Promise.allSettled([
        as(env, 'trader', (ctx) => proposeOrigin(ctx, a, { network: 'TRON', address: tron('ConcurrenteA'), label: 'A' })),
        as(env, 'trader', (ctx) => proposeOrigin(ctx, a, { network: 'BSC', address: '0x00000000000000000000000000000000000e0001', label: 'B' })),
      ]);
      expect(both.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const failed = both.find((r) => r.status === 'rejected') as PromiseRejectedResult;
      expect(failed.reason.code).toBe('NETWORK_LIMIT');
    } finally {
      POLICY.maxOriginNetworksPerClient = saved;
    }
    // La misma dirección a la vez para dos clientes distintos: queda para uno, el otro recibe DUPLICATE.
    const same = tron('ConcurrenteMisma');
    const dup = await Promise.allSettled([
      as(env, 'trader', (ctx) => proposeOrigin(ctx, a, { network: 'TRON', address: same, label: 'A' })),
      as(env, 'trader', (ctx) => proposeOrigin(ctx, b, { network: 'TRON', address: same, label: 'B' })),
    ]);
    expect(dup.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((dup.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason.code).toBe('DUPLICATE');
    const live = await env.db.query(`SELECT count(*)::int AS n FROM otc.origin_addresses WHERE address = $1`, [same]);
    expect(live.rows[0].n).toBe(1);
  });

  it('por HTTP: revocar y decidir una excepción piden el segundo factor', async () => {
    const op = await httpLogin(env, 'trader');
    const co = await httpLogin(env, 'cumplimiento');
    const created = await call(env, op, 'POST', `/counterparties/${caribe}/origins`, { network: 'TRON', address: tron('HttpRevoca'), label: 'HTTP' }, { 'idempotency-key': newKey() });
    await call(env, co, 'POST', `/origins/${created.body.id}/decision`, { approve: true, note: 'Verificada' }, { 'idempotency-key': newKey(), ...stepUp(env, 'cumplimiento') });
    const revokeNoCode = await call(env, co, 'POST', `/origins/${created.body.id}/revoke`, { reason: 'Comprometida' }, { 'idempotency-key': newKey() });
    expect(revokeNoCode.status).toBe(401);
    expect(revokeNoCode.body.code).toBe('STEP_UP_REQUIRED');
    const revoked = await call(env, co, 'POST', `/origins/${created.body.id}/revoke`, { reason: 'Comprometida' }, { 'idempotency-key': newKey(), ...stepUp(env, 'cumplimiento') });
    expect(revoked.status).toBe(200);
    expect(revoked.body.status).toBe('REVOCADA');

    const d = await deposit(caribe, tron('HttpExcepcion'));
    const req = await call(env, op, 'POST', `/transfers/${d.transfer.id}/origin-exception`, { reason: 'El cliente pagó desde su filial' }, { 'idempotency-key': newKey() });
    expect(req.status).toBe(201);
    const noCode = await call(env, co, 'POST', `/origin-exceptions/${req.body.id}/decision`, { approve: true, note: 'Verificada' }, { 'idempotency-key': newKey() });
    expect(noCode.status).toBe(401);
    expect(noCode.body.code).toBe('STEP_UP_REQUIRED');
    const yes = await call(env, co, 'POST', `/origin-exceptions/${req.body.id}/decision`, { approve: true, note: 'Verificada' }, { 'idempotency-key': newKey(), ...stepUp(env, 'cumplimiento') });
    expect(yes.status).toBe(200);
    expect(yes.body.status).toBe('APROBADA');
  });

  it('por HTTP: solo redes soportadas y decisiones con segundo factor', async () => {
    const op = await httpLogin(env, 'trader');
    const bad = await call(env, op, 'POST', `/counterparties/${andina}/origins`, { network: 'ETH', address: tron('Http'), label: 'x' }, { 'idempotency-key': newKey() });
    expect(bad.status).toBe(400);
    const created = await call(env, op, 'POST', `/counterparties/${andina}/origins`, { network: 'TRON', address: tron('Http'), label: 'HTTP' }, { 'idempotency-key': newKey() });
    expect(created.status).toBe(201);
    const co = await httpLogin(env, 'cumplimiento');
    const noMfa = await call(env, co, 'POST', `/origins/${created.body.id}/decision`, { approve: true, note: 'sin código' }, { 'idempotency-key': newKey() });
    expect(noMfa.status).toBe(401);
    expect(noMfa.body.code).toBe('STEP_UP_REQUIRED');
    const yes = await call(env, co, 'POST', `/origins/${created.body.id}/decision`, { approve: true, note: 'Verificada' }, { 'idempotency-key': newKey(), ...stepUp(env, 'cumplimiento') });
    expect(yes.status).toBe(200);
    expect(yes.body.status).toBe('APROBADA');
    const policy = await call(env, op, 'GET', '/origins/policy');
    expect(policy.body).toEqual({ networks: ['TRON', 'BSC'], maxNetworksPerClient: 4 });
    const detail = await call(env, op, 'GET', `/counterparties/${andina}`);
    expect(detail.body.origins.some((o: { address: string }) => o.address === tron('Http'))).toBe(true);
  });
});
