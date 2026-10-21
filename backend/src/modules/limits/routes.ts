import { z } from 'zod';
import type { Kit } from '../../http/v1/kit.js';
import { decideLimitChange, effectiveLimits, listLimitChanges, proposeLimitChange } from './service.js';

const KINDS = ['ORDER_MAX_USDT', 'CLIENT_DAILY_USDT', 'DESK_DAILY_USDT', 'OPEN_EXPOSURE_USDT', 'OPEN_EXPOSURE_COP', 'APPROVAL_POLICY'] as const;

export function limitRoutes(kit: Kit) {
  kit.get(
    '/limits',
    'read.operations',
    z.strictObject({ counterpartyId: z.uuid().optional() }),
    async (ctx, q) => {
      const l = await effectiveLimits(ctx.tx, q.counterpartyId ?? null);
      return {
        orderMaxUsdt: l.orderMaxUsdt.toFixed(),
        clientDailyUsdt: l.clientDailyUsdt.toFixed(),
        deskDailyUsdt: l.deskDailyUsdt.toFixed(),
        openExposureUsdt: l.openExposureUsdt.toFixed(),
        openExposureCop: l.openExposureCop.toFixed(),
        approval: l.approval,
      };
    },
  );

  kit.get(
    '/limit-changes',
    'read.operations',
    z.strictObject({ status: z.enum(['PROPUESTO', 'VIGENTE', 'RECHAZADO']).optional() }),
    (ctx, q) => listLimitChanges(ctx, q.status),
  );

  kit.post(
    '/limit-changes',
    {
      permission: 'limits.propose', stepUp: true,
      idempotent: true,
      status: 201,
      body: z.strictObject({
        kind: z.enum(KINDS),
        counterpartyId: z.uuid().nullish(),
        value: z.record(z.string(), z.string()),
        reason: z.string().trim().min(3).max(500),
      }),
    },
    (ctx, body) => proposeLimitChange(ctx, body),
  );

  kit.post(
    '/limit-changes/:id/decision',
    {
      permission: 'limits.approve', stepUp: true,
      idempotent: true,
      body: z.strictObject({ approve: z.boolean(), note: z.string().trim().min(3).max(500) }),
    },
    (ctx, body, req) => decideLimitChange(ctx, z.object({ id: z.uuid() }).parse(req.params).id, body.approve, body.note),
  );
}
