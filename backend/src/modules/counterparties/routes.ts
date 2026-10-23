import { z } from 'zod';
import type { Kit } from '../../http/v1/kit.js';
import {
  createCounterparty,
  decideDestination,
  decideKyc,
  getCounterparty,
  listCounterparties,
  listDestinations,
  proposeDestination,
  revokeDestination,
  updateCounterparty,
} from './service.js';

const uuid = z.object({ id: z.uuid() });
const KYC = z.enum(['PENDIENTE', 'APROBADO', 'RECHAZADO', 'BLOQUEADO']);
const text = (max: number) => z.string().trim().min(1).max(max);
const optionalText = (max: number) => z.string().trim().max(max).nullish();

export function counterpartyRoutes(kit: Kit) {
  kit.get(
    '/counterparties',
    'read.operations',
    z.strictObject({ search: z.string().trim().max(100).optional(), kyc: KYC.optional() }),
    (ctx, q) => listCounterparties(ctx, q),
  );
  kit.get('/counterparties/:id', 'read.operations', null, (ctx, _q, req) => getCounterparty(ctx, uuid.parse(req.params).id));

  kit.post(
    '/counterparties',
    {
      permission: 'counterparty.create',
      idempotent: true,
      status: 201,
      body: z.strictObject({
        kind: z.enum(['CLIENTE', 'PROVEEDOR']),
        personType: z.enum(['NATURAL', 'JURIDICA']),
        documentType: z.enum(['CC', 'CE', 'NIT', 'PASAPORTE']),
        documentNumber: z.string().trim().regex(/^[0-9A-Za-z-]{3,20}$/, 'Documento: 3 a 20 letras, números o guion'),
        legalName: z.string().trim().min(2).max(200),
        email: z.email().max(200).nullish(),
        phone: optionalText(40),
        notes: optionalText(1000),
      }),
    },
    (ctx, body) => createCounterparty(ctx, body),
  );

  kit.post(
    '/counterparties/:id/versions',
    {
      permission: 'counterparty.update',
      idempotent: true,
      body: z.strictObject({
        legalName: z.string().trim().min(2).max(200).optional(),
        email: z.email().max(200).nullish(),
        phone: optionalText(40),
        notes: optionalText(1000),
        reason: text(500),
      }),
    },
    (ctx, body, req) => updateCounterparty(ctx, uuid.parse(req.params).id, body),
  );

  kit.post(
    '/counterparties/:id/kyc',
    { permission: 'kyc.decide', stepUp: true, idempotent: true, body: z.strictObject({ status: KYC, note: text(1000) }) },
    (ctx, body, req) => decideKyc(ctx, uuid.parse(req.params).id, body.status, body.note),
  );

  kit.post(
    '/counterparties/:id/destinations',
    {
      permission: 'destination.propose',
      idempotent: true,
      status: 201,
      body: z.strictObject({
        rail: z.enum(['BANK', 'TRON', 'BSC']),
        value: z.string().trim().min(6).max(64),
        bankName: optionalText(80),
        accountType: z.enum(['AHORROS', 'CORRIENTE']).nullish(),
        holderDocument: optionalText(20),
        label: text(120),
        supersedesId: z.uuid().nullish(),
      }),
    },
    (ctx, body, req) => proposeDestination(ctx, uuid.parse(req.params).id, body),
  );

  kit.get(
    '/destinations',
    'read.operations',
    z.strictObject({ status: z.enum(['PROPUESTO', 'APROBADO', 'RECHAZADO', 'REVOCADO']) }),
    (ctx, q) => listDestinations(ctx, q.status),
  );

  kit.post(
    '/destinations/:id/decision',
    { permission: 'destination.decide', stepUp: true, idempotent: true, body: z.strictObject({ approve: z.boolean(), note: text(500) }) },
    (ctx, body, req) => decideDestination(ctx, uuid.parse(req.params).id, body.approve, body.note),
  );

  kit.post(
    '/destinations/:id/revoke',
    { permission: 'destination.decide', stepUp: true, idempotent: true, body: z.strictObject({ reason: text(500) }) },
    (ctx, body, req) => revokeDestination(ctx, uuid.parse(req.params).id, body.reason),
  );
}
