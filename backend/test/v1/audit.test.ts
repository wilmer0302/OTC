import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAnchor, listAudit, verifyAudit } from '../../src/modules/audit/service.js';
import { recordTrm } from '../../src/modules/pricing/service.js';
import { createRequest } from '../../src/modules/trading/service.js';
import { as, call, expectCode, httpLogin, newKey, setupEnv, type Env } from './helpers.js';

describe('auditoría y trazabilidad', () => {
  let env: Env;
  let andina: string;

  beforeAll(async () => {
    env = await setupEnv();
    andina = (await env.db.query(`SELECT id FROM otc.counterparties WHERE document_number = '900000001'`)).rows[0].id;
    await as(env, 'trader', (ctx) => recordTrm(ctx, { rate: '4000' }));
  });
  afterAll(async () => env.close());

  it('quién hizo qué, cuándo y desde dónde; solo para auditoría, cumplimiento y administración', async () => {
    const op = await httpLogin(env, 'trader');
    const created = await call(
      env,
      op,
      'POST',
      '/requests',
      { counterpartyId: andina, side: 'SELL', usdtAmount: '100', network: 'TRON' },
      { 'idempotency-key': newKey(), 'user-agent': 'navegador-de-prueba' },
    );
    expect((await call(env, op, 'GET', '/audit')).status).toBe(403);

    const auditor = await httpLogin(env, 'auditor');
    const r = await call(env, auditor, 'GET', `/audit?entity=request&entityId=${created.body.id}`);
    expect(r.status).toBe(200);
    expect(r.body.items.map((i: { action: string }) => i.action)).toEqual(['request.validada', 'request.creada']);
    expect(r.body.items[0]).toMatchObject({ actor: 'trader', data: { from: 'CREADA', to: 'VALIDADA', origin: { ip: '127.0.0.1', userAgent: 'navegador-de-prueba' } } });

    const h = await call(env, op, 'GET', `/history/request/${created.body.id}`);
    expect(h.body.map((x: { to_status: string }) => x.to_status)).toEqual(['CREADA', 'VALIDADA']);
    expect((await call(env, op, 'GET', `/history/usuarios/${created.body.id}`)).status).toBe(400);
  });

  it('pagina hacia atrás sin repetir registros', async () => {
    const page1 = await as(env, 'auditor', (ctx) => listAudit(ctx, { limit: 3 }));
    const page2 = await as(env, 'auditor', (ctx) => listAudit(ctx, { limit: 3, before: page1.next }));
    expect(page1.items).toHaveLength(3);
    expect(Number(page2.items[0].id)).toBeLessThan(Number(page1.items[2].id));
  });

  it('si la auditoría falla, la acción tampoco ocurre', async () => {
    const before = (await env.db.query('SELECT count(*)::int AS n FROM otc.requests')).rows[0].n;
    await env.db.query(`ALTER TABLE public.audit_log ADD CONSTRAINT prueba_falla CHECK (action <> 'request.creada') NOT VALID`);
    try {
      await expect(as(env, 'trader', (ctx) => createRequest(ctx, { counterpartyId: andina, side: 'SELL', usdtAmount: '1', network: 'TRON' }))).rejects.toThrow();
    } finally {
      await env.db.query('ALTER TABLE public.audit_log DROP CONSTRAINT prueba_falla');
    }
    expect((await env.db.query('SELECT count(*)::int AS n FROM otc.requests')).rows[0].n).toBe(before);
  });

  it('nadie, ni el administrador, edita o borra la auditoría ni sus anclas', async () => {
    await expect(env.db.query(`UPDATE public.audit_log SET action = 'otra' WHERE id = 1`)).rejects.toThrow(/solo-agregar/);
    await expect(env.db.query('DELETE FROM public.audit_log')).rejects.toThrow(/solo-agregar/);
    await as(env, 'admin', (ctx) => createAnchor(ctx, 'prueba'));
    await expect(env.db.query('DELETE FROM otc.audit_anchors')).rejects.toThrow(/solo-agregar/);
    await expectCode(as(env, 'trader', (ctx) => createAnchor(ctx, null)), 'FORBIDDEN');
  });

  it('la verificación confirma la cadena completa o señala el primer registro alterado y el ancla rota', async () => {
    const auditor = await httpLogin(env, 'auditor');
    const anchor = await call(env, auditor, 'POST', '/audit/anchors', { note: 'Copia enviada a la junta (prueba)' }, { 'idempotency-key': newKey() });
    expect(anchor.status).toBe(201);
    const ok = await call(env, auditor, 'GET', '/audit/verify');
    expect(ok.body).toMatchObject({ ok: true, chain: { ok: true }, anchors: { checked: 2 } });

    // Alguien con acceso directo a la base desactiva la protección y altera un registro.
    const target = (await env.db.query('SELECT id FROM public.audit_log ORDER BY id LIMIT 1 OFFSET 5')).rows[0].id;
    await env.db.query('ALTER TABLE public.audit_log DISABLE TRIGGER audit_log_append_only');
    try {
      await env.db.query(`UPDATE public.audit_log SET data = '{"alterado": true}' WHERE id = $1`, [target]);
    } finally {
      await env.db.query('ALTER TABLE public.audit_log ENABLE TRIGGER audit_log_append_only');
    }
    const broken = await verifyAudit(env.db);
    expect(broken.ok).toBe(false);
    expect(broken.chain.brokenAt).toBe(target);

    // Aunque recalculara todos los hashes, el ancla ya no coincidiría.
    const anchored = anchor.body.audit_id;
    await env.db.query('ALTER TABLE public.audit_log DISABLE TRIGGER audit_log_append_only');
    try {
      await env.db.query(`UPDATE public.audit_log SET hash = repeat('f', 64) WHERE id = $1`, [anchored]);
    } finally {
      await env.db.query('ALTER TABLE public.audit_log ENABLE TRIGGER audit_log_append_only');
    }
    expect((await verifyAudit(env.db)).anchors.brokenAnchor).toBe(String(anchor.body.id));
  });
});
