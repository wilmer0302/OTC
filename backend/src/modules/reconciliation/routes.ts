import { z } from 'zod';
import type { Kit, V1Deps } from '../../http/v1/kit.js';
import { simulateMovement } from '../sandbox/service.js';
import {
  clearItem,
  closeDay,
  decideAdjustment,
  getRun,
  importStatement,
  listAdjustments,
  listRuns,
  proposeAdjustment,
  reconcileAccount,
  sendItemToReview,
} from './service.js';

const uuid = z.object({ id: z.uuid() });
const note = z.strictObject({ note: z.string().trim().min(3).max(500) });
const date = z.iso.date();
const amount = z.string().trim().regex(/^\d{1,24}(\.\d{1,6})?$/);

export function reconciliationRoutes(kit: Kit, deps: V1Deps) {
  kit.get('/reconciliations', 'read.operations', z.strictObject({ date: date.optional(), status: z.enum(['ABIERTO', 'CUADRADO', 'CON_DIFERENCIAS', 'CERRADO']).optional() }), (ctx, q) =>
    listRuns(ctx, q),
  );
  kit.get('/reconciliations/:id', 'read.operations', null, (ctx, _q, req) => getRun(ctx, uuid.parse(req.params).id));

  // Pide el extracto al banco o a la red y lo cruza con el libro (consulta fuera de la transacción).
  kit.post(
    '/reconciliations/fetch',
    { permission: 'reconciliation.manage', body: z.strictObject({ accountId: z.uuid(), date }) },
    (ctx, body) => reconcileAccount({ db: deps.db, integrations: deps.integrations, now: deps.now, actor: ctx.actor }, body.accountId, body.date),
  );

  kit.post(
    '/reconciliations/import',
    {
      permission: 'reconciliation.manage',
      idempotent: true,
      body: z.strictObject({
        accountId: z.uuid(),
        date,
        lines: z
          .array(
            z.strictObject({
              reference: z.string().trim().min(3).max(120),
              direction: z.enum(['IN', 'OUT']),
              amount,
              occurredAt: z.iso.datetime(),
            }),
          )
          .min(1)
          .max(2000),
      }),
    },
    (ctx, body) => importStatement(ctx, body.accountId, body.date, body.lines.map((l) => ({ ...l, raw: { ...l, cargado: 'a mano' } }))),
  );

  kit.post('/reconciliation-items/:id/review', { permission: 'reconciliation.manage', idempotent: true, body: note }, async (ctx, body, req) => {
    await sendItemToReview(ctx, uuid.parse(req.params).id, body.note);
    return { ok: true };
  });
  kit.post('/reconciliation-items/:id/clear', { permission: 'review.resolve', idempotent: true, stepUp: true, body: note }, async (ctx, body, req) => {
    await clearItem(ctx, uuid.parse(req.params).id, body.note);
    return { ok: true };
  });

  kit.post(
    '/adjustments',
    {
      permission: 'adjustment.propose',
      idempotent: true,
      status: 201,
      body: z.strictObject({ itemId: z.uuid(), amount: z.string().trim().regex(/^-?\d{1,24}(\.\d{1,6})?$/), reason: z.string().trim().min(3).max(500) }),
    },
    (ctx, body) => proposeAdjustment(ctx, body),
  );
  kit.get(
    '/adjustments',
    'read.operations',
    z.strictObject({ status: z.enum(['PROPUESTO', 'APROBADO', 'RECHAZADO']).optional(), runId: z.uuid().optional() }),
    (ctx, q) => listAdjustments(ctx, q),
  );
  kit.post(
    '/adjustments/:id/decision',
    { permission: 'adjustment.approve', idempotent: true, stepUp: true, body: z.strictObject({ approve: z.boolean(), note: z.string().trim().min(3).max(500) }) },
    (ctx, body, req) => decideAdjustment(ctx, uuid.parse(req.params).id, body.approve, body.note),
  );

  kit.post(
    '/reconciliations/:id/close',
    { permission: 'reconciliation.manage', idempotent: true, stepUp: true, body: z.strictObject({ note: z.string().trim().max(500).nullish() }) },
    (ctx, body, req) => closeDay(ctx, uuid.parse(req.params).id, body.note ?? null),
  );

  if (deps.mode === 'DEMO') {
    kit.post(
      '/sandbox/accounts/:id/movements',
      {
        permission: 'sandbox.simulate',
        body: z.strictObject({ reference: z.string().trim().min(3).max(120), direction: z.enum(['IN', 'OUT']), amount, counterpartyRef: z.string().trim().max(120).optional() }),
      },
      (ctx, body, req) => simulateMovement(ctx, uuid.parse(req.params).id, body),
    );
  }
}
