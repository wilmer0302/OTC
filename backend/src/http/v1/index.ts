import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import type { FastifyInstance } from 'fastify';
import { counterpartyRoutes } from '../../modules/counterparties/routes.js';
import { identityRoutes } from '../../modules/identity/routes.js';
import { limitRoutes } from '../../modules/limits/routes.js';
import { liquidityRoutes } from '../../modules/liquidity/routes.js';
import { pricingRoutes } from '../../modules/pricing/routes.js';
import { makeKit, type V1Deps } from './kit.js';

/**
 * API v1 bajo /api/v1: sesión por cookie HttpOnly con segundo factor, token anti-CSRF,
 * límites de solicitudes, validación estricta y permisos por ruta.
 * La API de la demo (/api) sigue funcionando sin cambios mientras el frontend migra.
 */
export async function apiV1(app: FastifyInstance, deps: V1Deps) {
  await app.register(cookie);
  await app.register(rateLimit, {
    max: 300,
    timeWindow: '1 minute',
    errorResponseBuilder: (_req, ctx) => ({
      statusCode: 429,
      code: 'RATE_LIMITED',
      message: `Demasiadas solicitudes; intenta de nuevo en ${Math.ceil(ctx.ttl / 1000)} segundos`,
    }),
  });

  app.addHook('onSend', async (_req, reply) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('x-frame-options', 'DENY');
    reply.header('referrer-policy', 'no-referrer');
    reply.header('cache-control', 'no-store');
  });

  const kit = makeKit(app, deps);
  identityRoutes(app, kit, deps);
  counterpartyRoutes(kit);
  pricingRoutes(kit);
  limitRoutes(kit);
  liquidityRoutes(kit);
}
