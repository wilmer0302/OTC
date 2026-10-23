import { z } from 'zod';
import type { Kit } from '../../http/v1/kit.js';
import {
  approveDelivery,
  cancelOrder,
  clientReceipt,
  getOrder,
  listOrders,
  markForReview,
  registerPayment,
  resolveReview,
} from './service.js';

const uuid = z.object({ id: z.uuid() });
const reason = z.strictObject({ reason: z.string().trim().min(3).max(500) });
const ORDER_STATUS = z.enum([
  'CREADA',
  'COBRO_EN_VERIFICACION',
  'COBRO_CONFIRMADO',
  'ENTREGA_AUTORIZADA',
  'ENTREGA_ENVIADA',
  'COMPLETADA',
  'VENCIDA',
  'CANCELADA',
  'EN_REVISION',
]);

export function orderRoutes(kit: Kit) {
  kit.get(
    '/orders',
    'read.operations',
    z.strictObject({ status: ORDER_STATUS.optional(), counterpartyId: z.uuid().optional() }),
    (ctx, q) => listOrders(ctx, q),
  );
  kit.get('/orders/:id', 'read.operations', null, (ctx, _q, req) => getOrder(ctx, uuid.parse(req.params).id));
  // Lo que se le muestra o envía al cliente: sin TRM ni margen.
  kit.get('/orders/:id/receipt', 'read.operations', null, (ctx, _q, req) => clientReceipt(ctx, uuid.parse(req.params).id));

  kit.post(
    '/orders/:id/payment',
    {
      permission: 'payment.register',
      idempotent: true,
      body: z.strictObject({ reference: z.string().trim().min(4).max(80), fromRef: z.string().trim().max(120).nullish() }),
    },
    (ctx, body, req) => registerPayment(ctx, uuid.parse(req.params).id, body),
  );

  kit.post(
    '/orders/:id/approve',
    { permission: 'order.approve', idempotent: true, stepUp: true, body: z.strictObject({ note: z.string().trim().max(500).nullish() }) },
    (ctx, body, req) => approveDelivery(ctx, uuid.parse(req.params).id, body.note ?? null),
  );

  kit.post('/orders/:id/review', { permission: 'order.review', idempotent: true, body: reason }, (ctx, body, req) =>
    markForReview(ctx, uuid.parse(req.params).id, body.reason),
  );

  kit.post(
    '/orders/:id/review/resolve',
    {
      permission: 'review.resolve',
      idempotent: true,
      stepUp: true,
      body: z.strictObject({ action: z.enum(['RESUME', 'CANCEL']), note: z.string().trim().min(3).max(500) }),
    },
    (ctx, body, req) => resolveReview(ctx, uuid.parse(req.params).id, body.action, body.note),
  );

  kit.post('/orders/:id/cancel', { permission: 'order.cancel', idempotent: true, body: reason }, (ctx, body, req) =>
    cancelOrder(ctx, uuid.parse(req.params).id, body.reason),
  );
}
