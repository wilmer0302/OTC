import { z } from 'zod';
import type { Kit, V1Deps } from '../../http/v1/kit.js';
import { createAnchor, entityHistory, HISTORY_ENTITIES, listAnchors, listAudit, verifyAudit } from './service.js';

export function auditRoutes(kit: Kit, deps: V1Deps) {
  kit.get(
    '/audit',
    'audit.read',
    z.strictObject({
      entity: z.string().max(40).optional(),
      entityId: z.string().max(80).optional(),
      actorId: z.string().regex(/^\d+$/).optional(),
      action: z.string().max(80).optional(),
      from: z.iso.datetime().optional(),
      to: z.iso.datetime().optional(),
      before: z.string().regex(/^\d+$/).optional(),
      limit: z.coerce.number().int().min(1).max(500).optional(),
    }),
    (ctx, q) => listAudit(ctx, q),
  );
  kit.get('/audit/verify', 'audit.read', null, () => verifyAudit(deps.db));
  kit.get('/audit/anchors', 'audit.read', null, (ctx) => listAnchors(ctx));
  kit.post(
    '/audit/anchors',
    { permission: 'audit.read', idempotent: true, status: 201, body: z.strictObject({ note: z.string().trim().max(500).nullish() }) },
    (ctx, body) => createAnchor(ctx, body.note ?? null),
  );
  kit.get('/history/:entity/:id', 'read.operations', null, (ctx, _q, req) => {
    const p = z.object({ entity: z.enum(HISTORY_ENTITIES), id: z.uuid() }).parse(req.params);
    return entityHistory(ctx, p.entity, p.id);
  });
}
