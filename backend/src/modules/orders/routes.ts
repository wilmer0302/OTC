import { z } from 'zod';
import type { Kit } from '../../http/v1/kit.js';
import { clientReceipt, getOrder, listOrders } from './service.js';

const uuid = z.object({ id: z.uuid() });
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
}
