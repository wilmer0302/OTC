import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { z } from 'zod';
import type { Db } from '../../db/pool.js';
import { DomainError } from '../../domain/errors.js';
import type { Integrations } from '../../integrations/ports.js';
import { authorize, type Permission } from '../../modules/identity/permissions.js';
import {
  csrfMatches,
  resolveSession,
  type IdentityConfig,
  type ResolvedSession,
} from '../../modules/identity/service.js';
import type { Actor, Ctx } from '../../platform/context.js';
import { runIdempotent } from '../../platform/idempotency.js';
import { inTransaction } from '../../platform/tx.js';

export const SESSION_COOKIE = 'otc_session';

export interface V1Deps {
  db: Db;
  integrations: Integrations;
  identity: IdentityConfig;
  cookieSecure: boolean;
  mode: 'DEMO' | 'PRODUCTION';
  now: () => Date;
  /** Intentos por minuto y por IP en inicio de sesión y segundo factor (10 por defecto). */
  authRateLimit?: number;
}

/**
 * Una acción que se confirma en la base y aun así responde con error (por ejemplo, una
 * cotización que venció: el vencimiento queda guardado y el usuario recibe 409).
 */
export class CommittedFailure {
  constructor(public readonly error: DomainError) {}
}

type Handler<B, R> = (ctx: Ctx, body: B, req: FastifyRequest) => Promise<R | CommittedFailure>;

interface WriteOptions<S extends z.ZodType> {
  permission: Permission | null; // null: la ruta valida permisos más finos dentro del caso de uso
  body?: S;
  idempotent?: boolean;
  status?: number;
}

export function makeKit(app: FastifyInstance, deps: V1Deps) {
  /** Sesión válida, con segundo factor cumplido salvo que la ruta sirva justamente para completarlo. */
  async function session(req: FastifyRequest, { allowPendingMfa = false } = {}): Promise<ResolvedSession> {
    const token = req.cookies[SESSION_COOKIE];
    const resolved = token ? await resolveSession(deps.db, deps.identity, token, deps.now()) : null;
    if (!resolved) throw new DomainError('UNAUTHENTICATED', 'Inicia sesión', 401);
    if (!allowPendingMfa && !resolved.session.mfa_verified) {
      throw new DomainError('MFA_REQUIRED', 'Completa el segundo factor', 401);
    }
    if (req.method !== 'GET' && !csrfMatches(resolved.session, req.headers['x-csrf-token'] as string | undefined)) {
      throw new DomainError('CSRF', 'Solicitud rechazada: falta el token anti-CSRF o no coincide', 403);
    }
    return resolved;
  }

  const ctxFor = (tx: Ctx['tx'], actor: Actor): Ctx => ({ tx, actor, integrations: deps.integrations, now: deps.now });

  /** Lectura: sesión, segundo factor y permiso, sin transacción de escritura. */
  function get<Q extends z.ZodType>(
    path: string,
    permission: Permission,
    query: Q | null,
    handler: (ctx: Ctx, query: z.infer<Q>, req: FastifyRequest) => Promise<unknown>,
  ) {
    app.get(path, async (req) => {
      const { actor } = await session(req);
      authorize(actor, permission);
      const q = query ? query.parse(req.query) : ({} as z.infer<Q>);
      return inTransaction(deps.db, (tx) => handler(ctxFor(tx, actor), q, req));
    });
  }

  /**
   * Escritura: sesión, segundo factor, token anti-CSRF, permiso, validación estricta del cuerpo,
   * una sola transacción y, si se pide, clave de idempotencia obligatoria.
   */
  function post<S extends z.ZodType, R>(path: string, opts: WriteOptions<S>, handler: Handler<z.infer<S>, R>) {
    app.post(path, async (req: FastifyRequest, reply: FastifyReply) => {
      const { actor } = await session(req);
      if (opts.permission) authorize(actor, opts.permission);
      const body = opts.body ? opts.body.parse(req.body ?? {}) : ({} as z.infer<S>);
      const key = req.headers['idempotency-key'];
      if (opts.idempotent && (typeof key !== 'string' || !key)) {
        throw new DomainError('IDEMPOTENCY_KEY_REQUIRED', 'Falta la cabecera Idempotency-Key', 400);
      }
      const status = opts.status ?? 200;
      const outcome = await inTransaction(deps.db, async (tx) => {
        const execute = async () => {
          const result = await handler(ctxFor(tx, actor), body, req);
          if (result instanceof CommittedFailure) {
            return {
              statusCode: result.error.httpStatus,
              body: { code: result.error.code, message: result.error.message } as unknown,
            };
          }
          return { statusCode: status, body: result as unknown };
        };
        if (!opts.idempotent) return { ...(await execute()), replayed: false };
        const route = `${req.method} ${req.routeOptions.url}:${JSON.stringify(req.params ?? {})}`;
        return runIdempotent(tx, { key: key as string, userId: actor.id, route, body }, execute);
      });
      if (outcome.replayed) reply.header('idempotent-replay', 'true');
      return reply.status(outcome.statusCode).send(outcome.body);
    });
  }

  return { session, get, post, ctxFor };
}

export type Kit = ReturnType<typeof makeKit>;
