import { z } from 'zod';
import { CommittedFailure, type Kit } from '../../http/v1/kit.js';
import { acceptQuote, cancelRequest, createQuote, createRequest, getRequest, listQuotes, listRequests, quoteClientView, withdrawQuote } from './service.js';

const uuid = z.object({ id: z.uuid() });
const reason = z.strictObject({ reason: z.string().trim().min(3).max(500) });
const REQUEST_STATUS = z.enum(['CREADA', 'VALIDADA', 'COTIZADA', 'ACEPTADA', 'RECHAZADA', 'CANCELADA', 'VENCIDA']);

export function tradingRoutes(kit: Kit) {
  kit.get(
    '/requests',
    'read.operations',
    z.strictObject({ status: REQUEST_STATUS.optional(), counterpartyId: z.uuid().optional() }),
    (ctx, q) => listRequests(ctx, q),
  );
  kit.get(
    '/quotes',
    'read.operations',
    z.strictObject({ status: z.enum(['VIGENTE', 'ACEPTADA', 'VENCIDA', 'REEMPLAZADA', 'RETIRADA']).optional(), requestId: z.uuid().optional() }),
    (ctx, q) => listQuotes(ctx, q),
  );
  kit.get('/requests/:id', 'read.operations', null, (ctx, _q, req) => getRequest(ctx, uuid.parse(req.params).id));

  kit.post(
    '/requests',
    {
      permission: 'request.create',
      idempotent: true,
      status: 201,
      body: z.strictObject({
        counterpartyId: z.uuid(),
        side: z.enum(['BUY', 'SELL']),
        usdtAmount: z.string().trim().regex(/^\d{1,18}(\.\d{1,6})?$/, 'Monto USDT con máximo 6 decimales'),
        network: z.enum(['TRON', 'BSC']),
        destinationId: z.uuid().nullish(),
      }),
    },
    (ctx, body) => createRequest(ctx, body),
  );

  kit.post('/requests/:id/cancel', { permission: 'request.cancel', idempotent: true, body: reason }, (ctx, body, req) =>
    cancelRequest(ctx, uuid.parse(req.params).id, body.reason),
  );

  kit.post('/requests/:id/quotes', { permission: 'quote.create', idempotent: true, status: 201 }, async (ctx, _b, req) => {
    const quote = await createQuote(ctx, uuid.parse(req.params).id);
    return { quote, client: quoteClientView(quote) };
  });

  kit.post('/quotes/:id/withdraw', { permission: 'quote.withdraw', idempotent: true, body: reason }, async (ctx, body, req) => {
    await withdrawQuote(ctx, uuid.parse(req.params).id, body.reason);
    return { ok: true };
  });

  kit.post('/quotes/:id/accept', { permission: 'quote.accept', idempotent: true, status: 201 }, async (ctx, _b, req) => {
    const result = await acceptQuote(ctx, uuid.parse(req.params).id);
    if (!result.ok) return new CommittedFailure(result.error);
    return { order: result.order, alreadyAccepted: result.replayed };
  });
}
