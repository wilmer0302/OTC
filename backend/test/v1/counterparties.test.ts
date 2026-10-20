import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { kycCanMove, mask, railFor } from '../../src/modules/counterparties/domain.js';
import {
  approvedDestination,
  createCounterparty,
  decideDestination,
  decideKyc,
  getCounterparty,
  proposeDestination,
  revokeDestination,
  updateCounterparty,
} from '../../src/modules/counterparties/service.js';
import { as, call, expectCode, httpLogin, newKey, setupEnv, type Env } from './helpers.js';

let env: Env;
beforeAll(async () => {
  env = await setupEnv();
});
afterAll(async () => env.close());

const TRON_OK = 'TPruebaFicticiaxxxxxxxxxxxxxxxxxxx'; // formato válido, no pertenece a nadie

describe('reglas puras', () => {
  it('KYC solo se mueve por transiciones permitidas', () => {
    expect(kycCanMove('PENDIENTE', 'APROBADO')).toBe(true);
    expect(kycCanMove('RECHAZADO', 'APROBADO')).toBe(false);
    expect(kycCanMove('APROBADO', 'RECHAZADO')).toBe(false);
  });
  it('enmascara y elige el riel', () => {
    expect(mask('1000000001')).toBe('••••0001');
    expect(railFor('COP', 'TRON')).toBe('BANK');
    expect(railFor('USDT', 'BSC')).toBe('BSC');
  });
});

describe('clientes y contrapartes', () => {
  let id: string;

  it('crea un cliente con su primera versión y lo deja en auditoría', async () => {
    const cp = await as(env, 'trader', (ctx) =>
      createCounterparty(ctx, {
        kind: 'CLIENTE',
        personType: 'JURIDICA',
        documentType: 'NIT',
        documentNumber: '900999001',
        legalName: 'Cliente de prueba SAS (ficticio)',
      }),
    );
    id = cp.id;
    expect(cp.kyc_status).toBe('PENDIENTE');
    expect(cp.versions).toHaveLength(1);
    const a = await env.db.query(`SELECT 1 FROM audit_log WHERE action = 'counterparty.create' AND entity_id = $1`, [id]);
    expect(a.rowCount).toBe(1);
  });

  it('no acepta dos clientes con el mismo documento', async () => {
    await expectCode(
      as(env, 'trader', (ctx) =>
        createCounterparty(ctx, {
          kind: 'CLIENTE',
          personType: 'JURIDICA',
          documentType: 'NIT',
          documentNumber: '900999001',
          legalName: 'Otro nombre',
        }),
      ),
      'DUPLICATE',
    );
  });

  it('corregir datos crea una versión nueva sin borrar la anterior', async () => {
    const cp = await as(env, 'trader', (ctx) =>
      updateCounterparty(ctx, id, { legalName: 'Cliente de prueba S.A.S. (ficticio)', reason: 'Razón social mal escrita' }),
    );
    expect(cp.current_version).toBe(2);
    expect(cp.legal_name).toBe('Cliente de prueba S.A.S. (ficticio)');
    expect(cp.versions.map((v: { legal_name: string }) => v.legal_name)).toEqual([
      'Cliente de prueba S.A.S. (ficticio)',
      'Cliente de prueba SAS (ficticio)',
    ]);
    await expect(env.db.query('DELETE FROM otc.counterparty_versions')).rejects.toThrow(/solo-agregar/);
  });

  it('solo Cumplimiento decide el KYC, con nota y transición válida', async () => {
    await expectCode(as(env, 'admin', (ctx) => decideKyc(ctx, id, 'APROBADO', 'ok')), 'FORBIDDEN');
    await expectCode(as(env, 'cumplimiento', (ctx) => decideKyc(ctx, id, 'APROBADO', ' ')), 'INVALID');
    const cp = await as(env, 'cumplimiento', (ctx) => decideKyc(ctx, id, 'APROBADO', 'Documentos verificados (ficticio)'));
    expect(cp.kyc_status).toBe('APROBADO');
    expect(cp.kycHistory).toHaveLength(1);
    await expectCode(as(env, 'cumplimiento', (ctx) => decideKyc(ctx, id, 'RECHAZADO', 'x')), 'INVALID_TRANSITION');
  });
});

describe('lista blanca de destinos', () => {
  let cpId: string;
  let destId: string;

  beforeAll(async () => {
    const cp = await as(env, 'trader', (ctx) =>
      createCounterparty(ctx, {
        kind: 'CLIENTE',
        personType: 'NATURAL',
        documentType: 'CC',
        documentNumber: '1000999002',
        legalName: 'Persona de prueba (ficticio)',
      }),
    );
    cpId = cp.id;
  });

  it('valida direcciones y cuentas antes de proponer', async () => {
    await expectCode(
      as(env, 'trader', (ctx) => proposeDestination(ctx, cpId, { rail: 'TRON', value: '0x123', label: 'mala' })),
      'INVALID',
    );
    await expectCode(
      as(env, 'trader', (ctx) =>
        proposeDestination(ctx, cpId, { rail: 'BANK', value: '12-34', bankName: 'Bancolombia', accountType: 'AHORROS', label: 'x' }),
      ),
      'INVALID',
    );
  });

  it('quien propone no puede aprobar; otra persona sí', async () => {
    const d = await as(env, 'trader', (ctx) => proposeDestination(ctx, cpId, { rail: 'TRON', value: TRON_OK, label: 'Billetera Tron' }));
    destId = d.id as string;
    expect(d.status).toBe('PROPUESTO');
    expect(await approvedDestination(env.db, cpId, 'TRON')).toBeNull();
    // Proponer es del Operador; aprobar, de Cumplimiento o Administración.
    await expectCode(as(env, 'admin', (ctx) => proposeDestination(ctx, cpId, { rail: 'BSC', value: '0x' + '1'.repeat(40), label: 'x' })), 'FORBIDDEN');
    await expectCode(as(env, 'trader', (ctx) => decideDestination(ctx, destId, true, 'ok')), 'FORBIDDEN');
    const ok = await as(env, 'cumplimiento', (ctx) => decideDestination(ctx, destId, true, 'Verificada con el cliente'));
    expect(ok.status).toBe('APROBADO');
    expect((await approvedDestination(env.db, cpId, 'TRON'))?.id).toBe(destId);
  });

  it('no permite el mismo destino dos veces vivo', async () => {
    await expectCode(
      as(env, 'trader', (ctx) => proposeDestination(ctx, cpId, { rail: 'TRON', value: TRON_OK, label: 'repetida' })),
      'DUPLICATE',
    );
  });

  it('reemplazar un destino revoca el anterior al aprobar el nuevo', async () => {
    const nuevo = await as(env, 'trader', (ctx) =>
      proposeDestination(ctx, cpId, { rail: 'TRON', value: 'TNuevaPruebaFicticiaxxxxxxxxxxxxxx', label: 'Nueva', supersedesId: destId }),
    );
    await as(env, 'admin', (ctx) => decideDestination(ctx, nuevo.id as string, true, 'Cambio pedido por el cliente'));
    const viejo = await env.db.query('SELECT status, revoke_reason FROM otc.destinations WHERE id = $1', [destId]);
    expect(viejo.rows[0].status).toBe('REVOCADO');
    expect((await approvedDestination(env.db, cpId, 'TRON'))?.id).toBe(nuevo.id);
    await as(env, 'cumplimiento', (ctx) => revokeDestination(ctx, nuevo.id as string, 'Prueba de revocación'));
    expect(await approvedDestination(env.db, cpId, 'TRON')).toBeNull();
  });

  it('el auditor ve las cuentas enmascaradas', async () => {
    const cp = await as(env, 'auditor', (ctx) => getCounterparty(ctx, cpId));
    for (const d of cp.destinations) expect(String(d.value)).toMatch(/^••••/);
    const op = await as(env, 'trader', (ctx) => getCounterparty(ctx, cpId));
    expect(op.destinations.some((d: { value: string }) => d.value === TRON_OK)).toBe(true);
  });
});

describe('API de contrapartes', () => {
  it('crea por HTTP con validación estricta, idempotencia y permisos', async () => {
    const op = await httpLogin(env, 'trader');
    const body = {
      kind: 'CLIENTE',
      personType: 'JURIDICA',
      documentType: 'NIT',
      documentNumber: '900999777',
      legalName: 'Cliente HTTP (ficticio)',
    };
    const key = newKey();
    const first = await call(env, op, 'POST', '/counterparties', body, { 'idempotency-key': key });
    const again = await call(env, op, 'POST', '/counterparties', body, { 'idempotency-key': key });
    expect(first.status).toBe(201);
    expect(again.body.id).toBe(first.body.id);
    const bad = await call(env, op, 'POST', '/counterparties', { ...body, documentNumber: "1'; DROP TABLE x" }, { 'idempotency-key': newKey() });
    expect(bad.status).toBe(400);
    const list = await call(env, op, 'GET', '/counterparties?search=HTTP');
    expect(list.body.map((c: { legal_name: string }) => c.legal_name)).toContain('Cliente HTTP (ficticio)');

    const auditor = await httpLogin(env, 'auditor');
    const denied = await call(env, auditor, 'POST', '/counterparties', body, { 'idempotency-key': newKey() });
    expect(denied.status).toBe(403);
  });

  it('los datos ficticios de la demo traen clientes con destinos aprobados', async () => {
    const r = await env.db.query(
      `SELECT count(*)::int AS n FROM otc.destinations d JOIN otc.counterparties c ON c.id = d.counterparty_id
       WHERE d.status = 'APROBADO' AND c.document_number IN ('900000001','900000002')`,
    );
    expect(r.rows[0].n).toBe(6);
  });
});
