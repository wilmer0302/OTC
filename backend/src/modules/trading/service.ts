import type { Tx } from '../../db/pool.js';
import { DomainError, invalid, notFound } from '../../domain/errors.js';
import { actorDbId, type Ctx } from '../../platform/context.js';
import { getDeskSettings } from '../../platform/deskSettings.js';
import { history, recordTransition } from '../../platform/events.js';
import { D, fmt, parseUsdtAmount, type Dec } from '../../platform/money.js';
import { lockByName } from '../../platform/tx.js';
import { bogotaDate } from '../../services/trm.js';
import { kycAllowsTrading, type KycStatus } from '../counterparties/domain.js';
import { approvedDestination } from '../counterparties/service.js';
import { authorize } from '../identity/permissions.js';
import { checkLimits } from '../limits/domain.js';
import { effectiveLimits } from '../limits/service.js';
import { liquiditySummary } from '../liquidity/service.js';
import { createOrderFromQuote, deskAccountsFor, limitUsage, type OrderRow } from '../orders/service.js';
import { clientView, type Side } from '../pricing/domain.js';
import { currentTrm, price, type TrmRow } from '../pricing/service.js';
import { isExpired, priceMovedBeyond, quoteCanMove, requestCanMove, requestQuotable, type QuoteStatus, type RequestStatus } from './domain.js';

// Solicitudes y cotizaciones. Los cálculos comerciales vienen de pricing; los límites, de limits;
// la liquidez, de liquidity. Aquí no se llama a ningún exchange, banco ni red.

export interface RequestRow {
  id: string;
  number: string;
  counterparty_id: string;
  side: Side;
  usdt_amount: string;
  network: 'TRON' | 'BSC';
  destination_id: string | null;
  status: RequestStatus;
  status_reason: string | null;
  expires_at: Date;
}

export interface QuoteRow {
  id: string;
  number: string;
  request_id: string;
  replaces_id: string | null;
  side: Side;
  usdt_amount: string;
  trm_id: string;
  trm_rate: string;
  rule_id: string;
  margin_cop: string;
  commission_rate: string;
  base_price_cop: string;
  unit_price_cop: string;
  subtotal_cop: string;
  commission_cop: string;
  total_cop: string;
  margin_total_cop: string;
  status: QuoteStatus;
  status_reason: string | null;
  expires_at: Date;
}

// ---------- Validación previa ----------

interface Assessment {
  problems: string[];
  destinationId: string | null;
}

/**
 * Revisa KYC, destino aprobado, límites y liquidez. Devuelve cada problema con un mensaje que
 * nombra la regla y los valores. totalCop es null cuando todavía no hay precio.
 */
async function assess(
  ctx: Ctx,
  input: { counterpartyId: string; side: Side; usdtAmount: Dec; network: 'TRON' | 'BSC'; destinationId?: string | null },
  totalCop: Dec | null,
): Promise<Assessment> {
  const problems: string[] = [];
  const cp = await ctx.tx.query<{ kyc_status: KycStatus }>('SELECT kyc_status FROM otc.counterparties WHERE id = $1', [input.counterpartyId]);
  if (!cp.rowCount) throw notFound('El cliente');
  if (!kycAllowsTrading(cp.rows[0].kyc_status)) problems.push(`El KYC del cliente está ${cp.rows[0].kyc_status}; solo se opera con KYC APROBADO`);

  // Donde recibe el cliente: dirección de la red elegida si la mesa vende, cuenta bancaria si la mesa compra.
  const rail = input.side === 'SELL' ? input.network : 'BANK';
  const dest = await approvedDestination(ctx.tx, input.counterpartyId, rail, input.destinationId);
  if (!dest) problems.push(`El cliente no tiene un destino ${rail} aprobado${input.destinationId ? ' con ese identificador' : ''}`);

  const limits = await effectiveLimits(ctx.tx, input.counterpartyId);
  const usage = await limitUsage(ctx.tx, input.counterpartyId, bogotaDate(ctx.now()));
  for (const v of checkLimits({ side: input.side, usdtAmount: input.usdtAmount, totalCop }, limits, usage)) problems.push(v.message);

  // Liquidez indicativa en la cuenta desde la que la mesa entregaría. Se vuelve a revisar, con reserva, al aceptar.
  const needed = input.side === 'SELL' ? input.usdtAmount : totalCop;
  if (needed) {
    const { deliver } = await deskAccountsFor(ctx.tx, input.side, input.network);
    const row = (await liquiditySummary(ctx)).find((a) => a.id === deliver.id);
    if (row && new D(row.available).lt(needed)) {
      problems.push(`Liquidez insuficiente en ${deliver.name}: disponible ${row.available}, reservado ${row.reserved}, se necesitan ${fmt(needed)}`);
    }
  }
  return { problems, destinationId: dest?.id ?? null };
}

/** Total indicativo para validar la liquidez en pesos de una compra; sin TRM del día no hay estimado. */
async function indicativeTotal(ctx: Ctx, counterpartyId: string, side: Side, usdtAmount: Dec): Promise<Dec | null> {
  if (side === 'SELL') return null;
  if (!(await currentTrm(ctx.tx, bogotaDate(ctx.now())))) return null;
  return (await price(ctx, { counterpartyId, side, usdtAmount })).totalCop;
}

// ---------- Solicitudes ----------

async function lockRequest(tx: Tx, id: string): Promise<RequestRow> {
  const r = await tx.query<RequestRow>('SELECT * FROM otc.requests WHERE id = $1 FOR UPDATE', [id]);
  if (!r.rowCount) throw notFound('La solicitud');
  return r.rows[0];
}

async function moveRequest(ctx: Ctx, req: RequestRow, to: RequestStatus, reason: string | null): Promise<RequestRow> {
  if (!requestCanMove(req.status, to)) throw new DomainError('INVALID_TRANSITION', `La solicitud no puede pasar de ${req.status} a ${to}`);
  const r = await ctx.tx.query<RequestRow>(
    'UPDATE otc.requests SET status = $2, status_reason = $3, updated_at = $4 WHERE id = $1 RETURNING *',
    [req.id, to, reason, ctx.now()],
  );
  await recordTransition(ctx, 'request', req.id, req.status, to, reason);
  return r.rows[0];
}

async function moveQuote(ctx: Ctx, q: QuoteRow, to: QuoteStatus, reason: string | null, data: Record<string, unknown> = {}) {
  if (!quoteCanMove(q.status, to)) throw new DomainError('INVALID_TRANSITION', `La cotización no puede pasar de ${q.status} a ${to}`);
  await ctx.tx.query('UPDATE otc.quotes SET status = $2, status_reason = $3, updated_at = $4 WHERE id = $1', [q.id, to, reason, ctx.now()]);
  await recordTransition(ctx, 'quote', q.id, q.status, to, reason, data);
}

export interface NewRequest {
  counterpartyId: string;
  side: Side;
  usdtAmount: string;
  network: 'TRON' | 'BSC';
  destinationId?: string | null;
}

/**
 * Registra lo que pide el cliente y lo valida en el acto. Si algo falla, la solicitud queda
 * guardada como Rechazada con todos los motivos, para que el operador sepa qué pasó.
 */
export async function createRequest(ctx: Ctx, input: NewRequest): Promise<RequestRow> {
  authorize(ctx.actor, 'request.create');
  const usdtAmount = parseUsdtAmount(input.usdtAmount);
  const total = await indicativeTotal(ctx, input.counterpartyId, input.side, usdtAmount);
  const { problems, destinationId } = await assess(ctx, { ...input, usdtAmount }, total);
  const settings = await getDeskSettings(ctx);
  const now = ctx.now();
  const ins = await ctx.tx.query<RequestRow>(
    `INSERT INTO otc.requests (counterparty_id, side, usdt_amount, network, destination_id, status, expires_at, created_by, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,'CREADA',$6,$7,$8,$8) RETURNING *`,
    [
      input.counterpartyId,
      input.side,
      fmt(usdtAmount),
      input.network,
      destinationId,
      new Date(now.getTime() + settings.request_ttl_seconds * 1000),
      actorDbId(ctx.actor),
      now,
    ],
  );
  const req = ins.rows[0];
  await recordTransition(ctx, 'request', req.id, null, 'CREADA', null, { side: input.side, usdtAmount: fmt(usdtAmount), network: input.network });
  if (problems.length) return moveRequest(ctx, req, 'RECHAZADA', problems.join('. '));
  return moveRequest(ctx, req, 'VALIDADA', null);
}

/** El cliente desistió: la solicitud se cancela y su cotización vigente se retira. */
export async function cancelRequest(ctx: Ctx, id: string, reason: string): Promise<RequestRow> {
  authorize(ctx.actor, 'request.cancel');
  if (!reason.trim()) throw invalid('Indica el motivo de la cancelación');
  const req = await lockRequest(ctx.tx, id);
  await withdrawLiveQuote(ctx, id, `Solicitud cancelada: ${reason.trim()}`);
  return moveRequest(ctx, req, 'CANCELADA', reason.trim());
}

async function withdrawLiveQuote(ctx: Ctx, requestId: string, reason: string) {
  const live = await ctx.tx.query<QuoteRow>(`SELECT * FROM otc.quotes WHERE request_id = $1 AND status = 'VIGENTE' FOR UPDATE`, [requestId]);
  for (const q of live.rows) await moveQuote(ctx, q, 'RETIRADA', reason);
}

// ---------- Cotizaciones ----------

/**
 * Precio firme con plazo. Usa la TRM del día y la regla vigente, y guarda cuáles usó.
 * Si la solicitud ya tenía una cotización, la nueva la reemplaza y queda enlazada.
 */
export async function createQuote(ctx: Ctx, requestId: string): Promise<QuoteRow> {
  authorize(ctx.actor, 'quote.create');
  const req = await lockRequest(ctx.tx, requestId);
  if (!requestQuotable(req.status)) throw new DomainError('INVALID_STATE', `La solicitud está ${req.status}; no se puede cotizar`);
  if (isExpired(new Date(req.expires_at), ctx.now())) throw new DomainError('REQUEST_EXPIRED', 'La solicitud venció; registra una nueva');
  const usdtAmount = new D(req.usdt_amount);
  const p = await price(ctx, { counterpartyId: req.counterparty_id, side: req.side, usdtAmount });
  const { problems } = await assess(
    ctx,
    { counterpartyId: req.counterparty_id, side: req.side, usdtAmount, network: req.network, destinationId: req.destination_id },
    p.totalCop,
  );
  if (problems.length) throw new DomainError('QUOTE_BLOCKED', `No se puede cotizar: ${problems.join('. ')}`);

  const previous = await ctx.tx.query<QuoteRow>(
    'SELECT * FROM otc.quotes WHERE request_id = $1 ORDER BY number DESC LIMIT 1 FOR UPDATE',
    [requestId],
  );
  const prev = previous.rows[0] ?? null;
  if (prev?.status === 'VIGENTE') await moveQuote(ctx, prev, 'REEMPLAZADA', 'Se emitió una cotización nueva');

  const settings = await getDeskSettings(ctx);
  const now = ctx.now();
  const r = await ctx.tx.query<QuoteRow>(
    `INSERT INTO otc.quotes (request_id, replaces_id, side, usdt_amount, trm_id, trm_rate, rule_id, margin_cop, commission_rate,
       base_price_cop, unit_price_cop, subtotal_cop, commission_cop, total_cop, margin_total_cop, status, expires_at,
       created_by, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'VIGENTE',$16,$17,$18,$18) RETURNING *`,
    [
      requestId,
      prev?.id ?? null,
      req.side,
      req.usdt_amount,
      p.trm.id,
      p.trm.rate,
      p.rule.id,
      fmt(p.marginCop),
      fmt(p.commissionRate),
      p.basePriceCop.toFixed(2),
      fmt(p.unitPriceCop),
      fmt(p.subtotalCop),
      fmt(p.commissionCop),
      fmt(p.totalCop),
      fmt(p.marginTotalCop),
      new Date(now.getTime() + settings.quote_ttl_seconds * 1000),
      actorDbId(ctx.actor),
      now,
    ],
  );
  const quote = r.rows[0];
  await recordTransition(ctx, 'quote', quote.id, null, 'VIGENTE', null, {
    requestId,
    replaces: prev?.id ?? null,
    trmId: p.trm.id,
    trmRate: p.trm.rate,
    ruleId: p.rule.id,
    unitPriceCop: quote.unit_price_cop,
    totalCop: quote.total_cop,
    expiresAt: quote.expires_at,
  });
  if (req.status === 'VALIDADA') await moveRequest(ctx, req, 'COTIZADA', null);
  return quote;
}

/** La mesa anula una cotización vigente antes de que venza. */
export async function withdrawQuote(ctx: Ctx, id: string, reason: string) {
  authorize(ctx.actor, 'quote.withdraw');
  if (!reason.trim()) throw invalid('Indica el motivo del retiro');
  const r = await ctx.tx.query<QuoteRow>('SELECT * FROM otc.quotes WHERE id = $1 FOR UPDATE', [id]);
  if (!r.rowCount) throw notFound('La cotización');
  await moveQuote(ctx, r.rows[0], 'RETIRADA', reason.trim());
}

export type AcceptResult = { ok: true; order: OrderRow; replayed: boolean } | { ok: false; error: DomainError };

/**
 * El cliente aceptó. En una sola transacción: verifica el plazo con la hora del servidor, vuelve a
 * revisar KYC, destino y límites bajo un bloqueo (dos aceptaciones simultáneas no superan un límite),
 * crea la orden y reserva la liquidez. Si la reserva falla no queda orden y la cotización sigue vigente.
 * Una cotización vencida queda marcada como Vencida aunque la respuesta sea un error.
 */
export async function acceptQuote(ctx: Ctx, id: string): Promise<AcceptResult> {
  authorize(ctx.actor, 'quote.accept');
  // Bloqueo global de límites y exposición: serializa las aceptaciones, que son pocas y cortas.
  await lockByName(ctx.tx, 'otc.limits');
  const qr = await ctx.tx.query<QuoteRow>('SELECT * FROM otc.quotes WHERE id = $1 FOR UPDATE', [id]);
  if (!qr.rowCount) throw notFound('La cotización');
  const quote = qr.rows[0];
  if (quote.status === 'ACEPTADA') {
    const existing = await ctx.tx.query<OrderRow>('SELECT * FROM otc.orders WHERE quote_id = $1', [id]);
    return { ok: true, order: existing.rows[0], replayed: true };
  }
  if (quote.status !== 'VIGENTE') {
    throw new DomainError('QUOTE_NOT_ACTIVE', `La cotización está ${quote.status}${quote.status_reason ? ` (${quote.status_reason})` : ''}; pide una nueva`);
  }
  if (isExpired(new Date(quote.expires_at), ctx.now())) {
    await moveQuote(ctx, quote, 'VENCIDA', 'Se intentó aceptar después del vencimiento');
    return { ok: false, error: new DomainError('QUOTE_EXPIRED', 'La cotización venció según la hora del servidor; pide una nueva') };
  }
  const req = await lockRequest(ctx.tx, quote.request_id);
  if (req.status !== 'COTIZADA') throw new DomainError('INVALID_STATE', `La solicitud está ${req.status}`);
  if (isExpired(new Date(req.expires_at), ctx.now())) throw new DomainError('REQUEST_EXPIRED', 'La solicitud venció; registra una nueva');

  const usdtAmount = new D(quote.usdt_amount);
  const totalCop = new D(quote.total_cop);
  const cp = await ctx.tx.query<{ kyc_status: KycStatus }>('SELECT kyc_status FROM otc.counterparties WHERE id = $1 FOR SHARE', [
    req.counterparty_id,
  ]);
  if (!kycAllowsTrading(cp.rows[0].kyc_status)) throw new DomainError('KYC', `El KYC del cliente está ${cp.rows[0].kyc_status}`);
  const rail = req.side === 'SELL' ? req.network : 'BANK';
  const dest = await approvedDestination(ctx.tx, req.counterparty_id, rail, req.destination_id);
  if (!dest) throw new DomainError('NO_DESTINATION', `El destino ${rail} del cliente ya no está aprobado`);

  const limits = await effectiveLimits(ctx.tx, req.counterparty_id);
  const usage = await limitUsage(ctx.tx, req.counterparty_id, bogotaDate(ctx.now()));
  const violations = checkLimits({ side: req.side, usdtAmount, totalCop }, limits, usage);
  if (violations.length) throw new DomainError('LIMIT_EXCEEDED', violations.map((v) => v.message).join('. '));

  const settings = await getDeskSettings(ctx);
  const order = await createOrderFromQuote(
    ctx,
    quote,
    { counterparty_id: req.counterparty_id, network: req.network, destination_id: dest.id },
    limits.approval,
    settings.payment_window_seconds,
  );
  await moveQuote(ctx, quote, 'ACEPTADA', null, { orderId: order.id });
  await moveRequest(ctx, req, 'ACEPTADA', null);
  return { ok: true, order, replayed: false };
}

/**
 * Tras cargar una TRM del día: se retiran las cotizaciones vigentes cuya TRM difiere de la nueva
 * en más del umbral configurado.
 */
export async function withdrawOnPriceMove(ctx: Ctx, trm: TrmRow): Promise<string[]> {
  if (trm.valid_date !== bogotaDate(ctx.now())) return [];
  const { price_move_threshold_bps: bps } = await getDeskSettings(ctx);
  const live = await ctx.tx.query<QuoteRow>(`SELECT * FROM otc.quotes WHERE status = 'VIGENTE' FOR UPDATE`);
  const withdrawn: string[] = [];
  for (const q of live.rows) {
    if (priceMovedBeyond(new D(q.trm_rate), new D(trm.rate), bps)) {
      await moveQuote(ctx, q, 'RETIRADA', `La TRM pasó de ${q.trm_rate} a ${trm.rate}, más del umbral de ${bps} pb`, { trmId: trm.id });
      withdrawn.push(q.id);
    }
  }
  return withdrawn;
}

/** Barrido del trabajador: cotizaciones y solicitudes cuyo plazo pasó. */
export async function expireQuotesAndRequests(ctx: Ctx): Promise<{ quotes: string[]; requests: string[] }> {
  const now = ctx.now();
  const qs = await ctx.tx.query<QuoteRow>(
    `SELECT * FROM otc.quotes WHERE status = 'VIGENTE' AND expires_at <= $1 FOR UPDATE SKIP LOCKED`,
    [now],
  );
  for (const q of qs.rows) await moveQuote(ctx, q, 'VENCIDA', 'Pasó la hora de vencimiento');
  const rs = await ctx.tx.query<RequestRow>(
    `SELECT * FROM otc.requests WHERE status IN ('CREADA','VALIDADA','COTIZADA') AND expires_at <= $1 FOR UPDATE SKIP LOCKED`,
    [now],
  );
  const expired: string[] = [];
  for (const r of rs.rows) {
    if (r.status === 'COTIZADA') {
      await withdrawLiveQuote(ctx, r.id, 'La solicitud venció');
      await moveRequest(ctx, r, 'VENCIDA', 'Pasó el plazo sin aceptación');
    } else {
      // Una solicitud sin cotizar que vence se cancela: el estado Vencida es para las cotizadas sin aceptación.
      await moveRequest(ctx, r, 'CANCELADA', 'Venció el plazo sin cotización');
    }
    expired.push(r.id);
  }
  return { quotes: qs.rows.map((q) => q.id), requests: expired };
}

// ---------- Consultas ----------

export function quoteClientView(q: QuoteRow) {
  return {
    number: q.number,
    status: q.status,
    expiresAt: q.expires_at,
    price: clientView(q.side, q.usdt_amount, {
      basePriceCop: q.base_price_cop,
      unitPriceCop: q.unit_price_cop,
      subtotalCop: q.subtotal_cop,
      commissionCop: q.commission_cop,
      totalCop: q.total_cop,
    }),
  };
}

export async function getRequest(ctx: Pick<Ctx, 'tx'>, id: string) {
  const r = await ctx.tx.query(
    `SELECT r.*, v.legal_name AS counterparty_name FROM otc.requests r
     JOIN otc.counterparties c ON c.id = r.counterparty_id
     JOIN otc.counterparty_versions v ON v.counterparty_id = c.id AND v.version = c.current_version
     WHERE r.id = $1`,
    [id],
  );
  if (!r.rowCount) throw notFound('La solicitud');
  const quotes = await ctx.tx.query('SELECT * FROM otc.quotes WHERE request_id = $1 ORDER BY number DESC', [id]);
  const order = await ctx.tx.query('SELECT id, number, status FROM otc.orders WHERE request_id = $1', [id]);
  return { ...r.rows[0], quotes: quotes.rows, order: order.rows[0] ?? null, history: await history(ctx, 'request', id) };
}

export async function listRequests(ctx: Pick<Ctx, 'tx'>, filter: { status?: RequestStatus; counterpartyId?: string }) {
  const r = await ctx.tx.query(
    `SELECT r.id, r.number, r.side, r.usdt_amount, r.network, r.status, r.status_reason, r.expires_at, r.created_at,
            v.legal_name AS counterparty_name
     FROM otc.requests r
     JOIN otc.counterparties c ON c.id = r.counterparty_id
     JOIN otc.counterparty_versions v ON v.counterparty_id = c.id AND v.version = c.current_version
     WHERE ($1::text IS NULL OR r.status = $1) AND ($2::uuid IS NULL OR r.counterparty_id = $2)
     ORDER BY r.created_at DESC LIMIT 200`,
    [filter.status ?? null, filter.counterpartyId ?? null],
  );
  return r.rows;
}
