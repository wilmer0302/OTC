import { z } from 'zod';
import type { Kit } from '../../http/v1/kit.js';
import { createLiquidityAccount, entriesFor, liquiditySummary, openingBalance, verifyBalances } from './service.js';

const uuid = z.object({ id: z.uuid() });
const decimal = z.string().trim().regex(/^\d{1,24}(\.\d{1,6})?$/, 'Número decimal sin signos (por ejemplo 1500.25)');

// Los reversos y ajustes no tienen ruta propia: los hacen los flujos de órdenes y de conciliación,
// con sus propias reglas y doble firma. Aquí solo se consulta y se dan de alta cuentas.
export function liquidityRoutes(kit: Kit) {
  kit.get('/liquidity', 'read.operations', null, (ctx) => liquiditySummary(ctx));

  kit.post(
    '/accounts',
    {
      permission: 'liquidity.manage',
      idempotent: true,
      status: 201,
      body: z.strictObject({
        code: z.string().trim().regex(/^[A-Z0-9_]{3,40}$/, 'Código en mayúsculas, números y guion bajo'),
        name: z.string().trim().min(3).max(120),
        asset: z.enum(['COP', 'USDT']),
        liquidityType: z.enum(['BANK', 'WALLET', 'EXCHANGE']),
        network: z.enum(['TRON', 'BSC']).nullish(),
        externalRef: z.string().trim().min(3).max(120).nullish(),
        isDefault: z.boolean().optional(),
      }),
    },
    (ctx, body) => createLiquidityAccount(ctx, body),
  );

  kit.post(
    '/accounts/:id/opening-balance',
    {
      permission: 'liquidity.manage',
      idempotent: true,
      status: 201,
      body: z.strictObject({ amount: decimal, reason: z.string().trim().min(3).max(500) }),
    },
    async (ctx, body, req) => ({ entryId: await openingBalance(ctx, uuid.parse(req.params).id, body.amount, body.reason) }),
  );

  kit.get(
    '/ledger',
    'read.operations',
    z.strictObject({ orderId: z.uuid().optional(), accountId: z.uuid().optional() }),
    (ctx, q) => entriesFor(ctx, q),
  );

  kit.get('/ledger/verify', 'read.operations', null, (ctx) => verifyBalances(ctx.tx));
}
