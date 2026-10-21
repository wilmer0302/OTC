import { z } from 'zod';
import type { Kit } from '../../http/v1/kit.js';
import type { Ctx } from '../../platform/context.js';
import { fmt, parseUsdtAmount } from '../../platform/money.js';
import { clientView } from './domain.js';
import { effectiveRules, listTrm, price, recordTrm, setPricingRule, type TrmRow } from './service.js';

const decimal = z.string().trim().regex(/^\d{1,24}(\.\d{1,18})?$/, 'Número decimal sin signos (por ejemplo 4015.50)');

export function pricingRoutes(kit: Kit, hooks: { afterTrm?: (ctx: Ctx, trm: TrmRow) => Promise<unknown> } = {}) {
  kit.get('/trm', 'read.operations', null, (ctx) => listTrm(ctx));

  kit.post(
    '/trm',
    {
      permission: 'trm.record',
      idempotent: true,
      status: 201,
      body: z.strictObject({ rate: decimal, validDate: z.iso.date().optional() }),
    },
    async (ctx, body) => {
      const trm = await recordTrm(ctx, body);
      // Las cotizaciones vigentes se revisan contra el precio nuevo (módulo de cotizaciones).
      if (hooks.afterTrm) await hooks.afterTrm(ctx, trm);
      return trm;
    },
  );

  kit.get('/pricing-rules', 'read.operations', null, (ctx) => effectiveRules(ctx.tx));

  kit.post(
    '/pricing-rules',
    {
      permission: 'pricing.manage', stepUp: true,
      idempotent: true,
      status: 201,
      body: z.strictObject({
        counterpartyId: z.uuid().nullish(),
        minUsdt: decimal.optional(),
        buyMarginCop: decimal,
        sellMarginCop: decimal,
        commissionRate: decimal,
        active: z.boolean().optional(),
        reason: z.string().trim().min(3).max(500),
      }),
    },
    (ctx, body) => setPricingRule(ctx, body),
  );

  // Vista previa del precio, sin guardar. Incluye el detalle interno y lo que vería el cliente.
  kit.post(
    '/pricing/preview',
    {
      permission: 'quote.create',
      body: z.strictObject({ counterpartyId: z.uuid(), side: z.enum(['BUY', 'SELL']), usdtAmount: decimal }),
    },
    async (ctx, body) => {
      const amount = parseUsdtAmount(body.usdtAmount);
      const p = await price(ctx, { counterpartyId: body.counterpartyId, side: body.side, usdtAmount: amount });
      const money = {
        basePriceCop: fmt(p.basePriceCop),
        unitPriceCop: fmt(p.unitPriceCop),
        subtotalCop: fmt(p.subtotalCop),
        commissionCop: fmt(p.commissionCop),
        totalCop: fmt(p.totalCop),
      };
      return {
        internal: {
          ...money,
          trmRate: p.trm.rate,
          trmId: p.trm.id,
          ruleId: p.rule.id,
          marginCop: fmt(p.marginCop),
          commissionRate: fmt(p.commissionRate),
          marginTotalCop: fmt(p.marginTotalCop),
        },
        client: clientView(body.side, fmt(amount), money),
      };
    },
  );
}
