import { z } from 'zod';
import type { Kit } from '../../http/v1/kit.js';
import {
  cancelTransfer,
  createInternalTransfer,
  getInstruction,
  getTransfer,
  listTransfers,
  prepareSigning,
  registerSent,
  retryDelivery,
} from './service.js';

const uuid = z.object({ id: z.uuid() });
const reason = z.strictObject({ reason: z.string().trim().min(3).max(500) });
const STATUS = z.enum(['CREADA', 'AUTORIZADA', 'EN_FIRMA', 'ENVIADA', 'PENDIENTE', 'CONFIRMADA', 'FALLIDA', 'CANCELADA', 'EN_REVISION']);

export function transferRoutes(kit: Kit) {
  kit.get(
    '/transfers',
    'read.operations',
    z.strictObject({
      status: STATUS.optional(),
      purpose: z.enum(['COBRO', 'ENTREGA', 'DEVOLUCION', 'TRASLADO']).optional(),
      rail: z.enum(['BANK', 'TRON', 'BSC']).optional(),
      search: z.string().trim().min(1).max(80).optional(),
    }),
    (ctx, q) => listTransfers(ctx, q),
  );
  kit.get('/transfers/:id', 'read.operations', null, (ctx, _q, req) => getTransfer(ctx, uuid.parse(req.params).id));
  kit.get('/transfers/:id/instruction', 'transfer.manage', null, (ctx, _q, req) => getInstruction(ctx, uuid.parse(req.params).id));

  kit.post('/transfers/:id/signing', { permission: 'transfer.manage', idempotent: true }, (ctx, _b, req) =>
    prepareSigning(ctx, uuid.parse(req.params).id),
  );
  kit.post(
    '/transfers/:id/sent',
    { permission: 'transfer.manage', idempotent: true, body: z.strictObject({ reference: z.string().trim().min(4).max(80) }) },
    (ctx, body, req) => registerSent(ctx, uuid.parse(req.params).id, body.reference),
  );
  kit.post('/transfers/:id/cancel', { permission: 'transfer.manage', idempotent: true, body: reason }, (ctx, body, req) =>
    cancelTransfer(ctx, uuid.parse(req.params).id, body.reason),
  );
  // Reintento: aprobación propia con el segundo factor.
  kit.post('/transfers/:id/retry', { permission: 'order.approve', idempotent: true, stepUp: true, body: reason }, (ctx, body, req) =>
    retryDelivery(ctx, uuid.parse(req.params).id, body.reason),
  );
  kit.post(
    '/transfers/internal',
    {
      permission: 'transfer.manage',
      idempotent: true,
      stepUp: true,
      status: 201,
      body: z.strictObject({
        fromAccountId: z.uuid(),
        toAccountId: z.uuid(),
        amount: z.string().trim().regex(/^\d{1,24}(\.\d{1,6})?$/),
        reason: z.string().trim().min(3).max(500),
      }),
    },
    (ctx, body) => createInternalTransfer(ctx, body),
  );
}
