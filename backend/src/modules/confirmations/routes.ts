import { z } from 'zod';
import type { Kit, V1Deps } from '../../http/v1/kit.js';
import { simulateFor } from '../sandbox/service.js';
import { checkTransfer, observationsOf, resolveTransferReview } from './service.js';

const uuid = z.object({ id: z.uuid() });

export function confirmationRoutes(kit: Kit, deps: V1Deps) {
  kit.get('/transfers/:id/observations', 'read.operations', null, (ctx, _q, req) => observationsOf(ctx, uuid.parse(req.params).id));

  // Revisión inmediata (el trabajador lo hace solo cada pocos segundos). Consulta y aplica en su propia transacción.
  kit.post('/transfers/:id/check', { permission: 'transfer.manage' }, (ctx, _b, req) =>
    checkTransfer({ db: deps.db, integrations: deps.integrations, now: deps.now, actor: ctx.actor }, uuid.parse(req.params).id),
  );

  kit.post(
    '/transfers/:id/review/resolve',
    {
      permission: 'review.resolve',
      idempotent: true,
      stepUp: true,
      body: z.strictObject({ to: z.enum(['CONFIRMADA', 'FALLIDA', 'PENDIENTE']), note: z.string().trim().min(3).max(500) }),
    },
    (ctx, body, req) => resolveTransferReview(ctx, uuid.parse(req.params).id, body.to, body.note),
  );

  // SANDBOX: solo existe en modo DEMO. Simula lo que reportarían la red o el banco.
  if (deps.mode === 'DEMO') {
    kit.post(
      '/sandbox/transfers/:id/simulate',
      {
        permission: 'sandbox.simulate',
        body: z.strictObject({
          status: z.enum(['PENDING', 'SUCCESS', 'FAILED', 'SETTLED', 'REJECTED']),
          confirmations: z.number().int().min(0).max(1000).optional(),
          amount: z.string().trim().regex(/^\d{1,24}(\.\d{1,6})?$/).optional(),
          toAddress: z.string().trim().max(120).optional(),
          failReason: z.string().trim().max(200).optional(),
        }),
      },
      (ctx, body, req) => simulateFor(ctx, uuid.parse(req.params).id, body),
    );
  }
}
