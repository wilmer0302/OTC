import cors from '@fastify/cors';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import jwt from 'jsonwebtoken';
import { z, ZodError } from 'zod';
import type { Adapters } from '../adapters/types.js';
import type { Config } from '../config.js';
import { withTx, type Db } from '../db/pool.js';
import { DomainError } from '../domain/errors.js';
import { verifyAuditChain } from '../services/audit.js';
import { requireRole } from '../services/authz.js';
import type { Actor, Ctx, Role } from '../services/context.js';
import { createCounterparty, listCounterparties, setKycStatus } from '../services/counterparties.js';
import { dashboard } from '../services/dashboard.js';
import { balances } from '../services/ledger.js';
import {
  approveDelivery,
  cancelOrder,
  confirmDelivery,
  getOrderDetail,
  listOrders,
  registerIncoming,
  registerOutgoing,
  resolveReview,
  sendToReview,
} from '../services/orders.js';
import { acceptQuote, createQuote } from '../services/quotes.js';
import { getSettings, updateSettings } from '../services/settings.js';
import { listTrm, recordManualTrm } from '../services/trm.js';
import { authenticate, listUsers } from '../services/users.js';

const ORDER_STATUSES = [
  'AWAITING_PAYMENT',
  'PAYMENT_CONFIRMED',
  'DELIVERY_APPROVED',
  'DELIVERY_SENT',
  'CLOSED',
  'CANCELLED',
  'IN_REVIEW',
] as const;

const id = z.object({ id: z.string().regex(/^\d+$/) });
const decimalString = z.string().regex(/^\d+(\.\d+)?$/, 'Número inválido');
const reference = z.object({ reference: z.string().min(1).max(200) });
const reason = z.object({ reason: z.string().min(1).max(500) });

declare module 'fastify' {
  interface FastifyRequest {
    actor?: Actor;
  }
}

export function buildApp(deps: { db: Db; config: Config; adapters: Adapters }) {
  const { db, config, adapters } = deps;
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' } });
  app.register(cors, { origin: config.corsOrigin });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof DomainError) {
      return reply.status(err.httpStatus).send({ code: err.code, message: err.message });
    }
    if (err instanceof ZodError) {
      return reply.status(400).send({ code: 'INVALID', message: err.issues.map((i) => i.message).join('; ') });
    }
    req.log.error(err);
    return reply.status(500).send({ code: 'INTERNAL', message: 'Error interno. Quedó registrado para revisión.' });
  });

  function actorOf(req: FastifyRequest): Actor {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) throw new DomainError('UNAUTHENTICATED', 'Inicia sesión', 401);
    try {
      const payload = jwt.verify(header.slice(7), config.jwtSecret) as { sub: string; username: string; roles: Role[] };
      return { id: payload.sub, username: payload.username, roles: payload.roles };
    } catch {
      throw new DomainError('UNAUTHENTICATED', 'La sesión venció; inicia sesión de nuevo', 401);
    }
  }

  // Toda escritura corre en una transacción y admite Idempotency-Key para reintentos seguros.
  async function mutate<T>(req: FastifyRequest, route: string, fn: (ctx: Ctx) => Promise<T>): Promise<T> {
    const actor = actorOf(req);
    const key = req.headers['idempotency-key'];
    return withTx(db, async (tx) => {
      if (typeof key === 'string' && key) {
        const prev = await tx.query('SELECT response FROM idempotency_keys WHERE key=$1 AND user_id=$2 AND route=$3', [
          key,
          actor.id,
          route,
        ]);
        if (prev.rowCount) return prev.rows[0].response as T;
      }
      const result = await fn({ tx, actor, adapters });
      if (typeof key === 'string' && key) {
        await tx.query('INSERT INTO idempotency_keys (key, user_id, route, response) VALUES ($1,$2,$3,$4)', [
          key,
          actor.id,
          route,
          JSON.stringify(result ?? null),
        ]);
      }
      return result;
    });
  }

  const read = (req: FastifyRequest, ...roles: Role[]) => {
    const actor = actorOf(req);
    if (roles.length) requireRole(actor, ...roles);
    return actor;
  };

  app.get('/api/health', async () => ({ ok: true }));

  app.get('/api/system', async () => ({
    mode: config.mode,
    simulatedChain: adapters.chain.simulated,
    simulatedBank: adapters.bank.simulated,
  }));

  app.post('/api/auth/login', async (req) => {
    const body = z.object({ username: z.string().min(1), password: z.string().min(1) }).parse(req.body);
    const actor = await withTx(db, (tx) => authenticate(tx, body.username, body.password));
    if (!actor) throw new DomainError('BAD_CREDENTIALS', 'Usuario o contraseña incorrectos', 401);
    const token = jwt.sign({ sub: actor.id, username: actor.username, roles: actor.roles }, config.jwtSecret, {
      expiresIn: '8h',
    });
    return { token, user: actor };
  });

  app.get('/api/me', async (req) => read(req));

  app.get('/api/dashboard', async (req) => {
    read(req);
    return dashboard(db);
  });

  app.get('/api/settings', async (req) => {
    read(req);
    return getSettings(db);
  });

  app.put('/api/settings', async (req) => {
    const body = z
      .object({
        buy_margin_cop: decimalString,
        sell_margin_cop: decimalString,
        quote_ttl_seconds: z.number().int().min(10).max(3600),
        approval_policy: z.enum(['SINGLE', 'THRESHOLD', 'ALL']),
        approval_threshold_cop: z.string().regex(/^\d+$/),
        max_order_usdt: decimalString,
      })
      .partial()
      .parse(req.body);
    return mutate(req, 'settings.update', (ctx) => updateSettings(ctx, body));
  });

  app.get('/api/trm', async (req) => {
    read(req);
    return listTrm(db);
  });

  app.post('/api/trm', async (req) => {
    const body = z
      .object({ rate: decimalString, validDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() })
      .parse(req.body);
    return mutate(req, 'trm.record', (ctx) => recordManualTrm(ctx, body));
  });

  app.get('/api/counterparties', async (req) => {
    read(req);
    return listCounterparties(db);
  });

  app.post('/api/counterparties', async (req) => {
    const body = z
      .object({
        name: z.string().min(2).max(200),
        documentId: z.string().min(3).max(40),
        kycStatus: z.enum(['PENDIENTE', 'APROBADO', 'BLOQUEADO']),
        bankAccount: z.string().max(200).nullish(),
        tronAddress: z.string().max(64).nullish(),
        bscAddress: z.string().max(64).nullish(),
      })
      .parse(req.body);
    return mutate(req, 'counterparty.create', (ctx) => createCounterparty(ctx, body));
  });

  app.patch('/api/counterparties/:id/kyc', async (req) => {
    const { id: cpId } = id.parse(req.params);
    const body = z.object({ kycStatus: z.enum(['PENDIENTE', 'APROBADO', 'BLOQUEADO']) }).parse(req.body);
    return mutate(req, 'counterparty.kyc', (ctx) => setKycStatus(ctx, cpId, body.kycStatus));
  });

  app.post('/api/quotes', async (req) => {
    const body = z
      .object({
        counterpartyId: z.string().regex(/^\d+$/),
        side: z.enum(['BUY', 'SELL']),
        network: z.enum(['TRON', 'BSC']),
        usdtAmount: decimalString,
      })
      .parse(req.body);
    return mutate(req, 'quote.create', (ctx) => createQuote(ctx, body));
  });

  app.post('/api/quotes/:id/accept', async (req, reply: FastifyReply) => {
    const { id: quoteId } = id.parse(req.params);
    const result = await mutate(req, `quote.accept.${quoteId}`, (ctx) => acceptQuote(ctx, quoteId));
    if (result.expired) {
      return reply.status(409).send({ code: 'QUOTE_EXPIRED', message: 'La cotización venció; genera una nueva' });
    }
    return result.order;
  });

  app.get('/api/orders', async (req) => {
    read(req);
    const q = z.object({ status: z.enum(ORDER_STATUSES).optional() }).parse(req.query);
    return listOrders(db, q.status);
  });

  app.get('/api/orders/:id', async (req) => {
    read(req);
    return getOrderDetail(db, id.parse(req.params).id);
  });

  app.post('/api/orders/:id/incoming', async (req) => {
    const { id: oid } = id.parse(req.params);
    const body = reference.parse(req.body);
    return mutate(req, `order.incoming.${oid}`, (ctx) => registerIncoming(ctx, oid, body.reference));
  });

  app.post('/api/orders/:id/approve', async (req) => {
    const { id: oid } = id.parse(req.params);
    return mutate(req, `order.approve.${oid}`, (ctx) => approveDelivery(ctx, oid));
  });

  app.post('/api/orders/:id/outgoing', async (req) => {
    const { id: oid } = id.parse(req.params);
    const body = reference.parse(req.body);
    return mutate(req, `order.outgoing.${oid}`, (ctx) => registerOutgoing(ctx, oid, body.reference));
  });

  app.post('/api/orders/:id/confirm', async (req) => {
    const { id: oid } = id.parse(req.params);
    return mutate(req, `order.confirm.${oid}`, (ctx) => confirmDelivery(ctx, oid));
  });

  app.post('/api/orders/:id/cancel', async (req) => {
    const { id: oid } = id.parse(req.params);
    const body = reason.parse(req.body);
    return mutate(req, `order.cancel.${oid}`, (ctx) => cancelOrder(ctx, oid, body.reason));
  });

  app.post('/api/orders/:id/review', async (req) => {
    const { id: oid } = id.parse(req.params);
    const body = reason.parse(req.body);
    return mutate(req, `order.review.${oid}`, (ctx) => sendToReview(ctx, oid, body.reason));
  });

  app.post('/api/orders/:id/resolve', async (req) => {
    const { id: oid } = id.parse(req.params);
    const body = z.object({ to: z.enum(ORDER_STATUSES), note: z.string().min(1).max(500) }).parse(req.body);
    return mutate(req, `order.resolve.${oid}`, (ctx) => resolveReview(ctx, oid, body.to, body.note));
  });

  app.get('/api/ledger/balances', async (req) => {
    read(req, 'ADMIN', 'TESORERO', 'AUDITOR');
    return balances(db);
  });

  app.get('/api/audit', async (req) => {
    read(req, 'ADMIN', 'AUDITOR');
    const q = z.object({ limit: z.coerce.number().int().min(1).max(500).default(100) }).parse(req.query);
    const r = await db.query(
      `SELECT a.id, a.at, a.action, a.entity, a.entity_id, a.data, a.hash, u.full_name AS actor_name
       FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id ORDER BY a.id DESC LIMIT $1`,
      [q.limit],
    );
    return r.rows;
  });

  app.get('/api/audit/verify', async (req) => {
    read(req, 'ADMIN', 'AUDITOR');
    return verifyAuditChain(db);
  });

  app.get('/api/users', async (req) => {
    read(req, 'ADMIN');
    return listUsers(db);
  });

  return app;
}

