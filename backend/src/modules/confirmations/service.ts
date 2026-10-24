import type { Db } from '../../db/pool.js';
import { DomainError, invalid } from '../../domain/errors.js';
import { railIsSandbox, type Integrations } from '../../integrations/ports.js';
import { openCase, resolveCasesFor } from '../../platform/cases.js';
import type { Actor, Ctx } from '../../platform/context.js';
import { getDeskSettings } from '../../platform/deskSettings.js';
import { D, usdtToBaseUnits } from '../../platform/money.js';
import { inTransaction } from '../../platform/tx.js';
import { authorize } from '../identity/permissions.js';
import { accountByCode, consumeReservation, openReservationForTransfer, postEntry, releaseReservation, tradingCode, unlockReservation } from '../liquidity/service.js';
import { advanceWithEvidence, lockOrder, onDeliveryFailed, reviewFromTransfer } from '../orders/service.js';
import { lockTransfer, moveTransfer, type TransferRow } from '../transfers/service.js';
import { decide, type Decision, type Expected, type Observed } from './domain.js';
import { authorizedOrigins } from './origins.js';

// Confirmaciones externas. Una transferencia solo cuenta como hecha cuando el banco o la red lo
// reportan con el umbral configurado y coinciden destino y monto. La consulta externa se hace
// fuera de la transacción; el resultado se aplica después, solo si la transferencia sigue
// esperando ese resultado (si no, queda como evidencia tardía).

interface Target {
  transfer: TransferRow;
  accountRef: string | null; // cuenta o dirección de la mesa
  expected: Expected;
}

const TRACKED = ['ENVIADA', 'PENDIENTE', 'EN_REVISION'];

async function loadTarget(q: Db | Ctx['tx'], integrations: Integrations, transferId: string): Promise<Target> {
  const r = await q.query(
    `SELECT t.*, a.external_ref AS account_ref, d.value AS dest_value, ta.external_ref AS to_account_ref, o.counterparty_id
     FROM otc.transfers t JOIN otc.accounts a ON a.id = t.account_id
     LEFT JOIN otc.destinations d ON d.id = t.destination_id LEFT JOIN otc.accounts ta ON ta.id = t.to_account_id
     LEFT JOIN otc.orders o ON o.id = t.order_id
     WHERE t.id = $1`,
    [transferId],
  );
  const row = r.rows[0];
  const transfer = row as TransferRow;
  const to = transfer.direction === 'IN' ? row.account_ref : (row.dest_value ?? row.to_account_ref);
  const amount = transfer.rail === 'BANK' ? new D(transfer.amount).toFixed(0) : usdtToBaseUnits(new D(transfer.amount), transfer.rail);
  const chain = transfer.rail !== 'BANK' ? transfer.rail : null;
  return {
    transfer,
    accountRef: row.account_ref,
    expected: {
      to: chain ? to : null,
      direction: transfer.direction,
      amount,
      network: chain,
      tokenContract: chain ? integrations.chain.usdtContract(chain) : null,
      // Control de origen: solo en los cobros en USDT, que son los depósitos de clientes.
      allowedFrom: chain && transfer.purpose === 'COBRO' ? await authorizedOrigins(q, row.counterparty_id, chain, transfer.id) : null,
    },
  };
}

/** Consulta a la red o al banco. Devuelve lo observado y deja medido el tiempo de la llamada. */
async function observe(integrations: Integrations, target: Target, now: () => Date) {
  const t = target.transfer;
  const started = Date.now();
  const call = {
    integration: t.rail === 'BANK' ? ('BANK' as const) : ('CHAIN' as const),
    operation: t.rail === 'BANK' ? 'getMovement' : 'getTransaction',
    target: t.rail === 'BANK' ? `${target.accountRef}:${t.external_ref}` : `${t.rail}:${t.external_ref}`,
    sandbox: railIsSandbox(integrations, t.rail),
    calledAt: now(),
    ok: true,
    error: null as string | null,
    durationMs: 0,
  };
  let obs: Observed | null = null;
  try {
    if (t.rail === 'BANK') {
      if (!target.accountRef) throw new Error('La cuenta bancaria de la mesa no tiene número registrado');
      const m = await integrations.bank.getMovement(target.accountRef, t.external_ref!);
      obs = { found: m.found, status: m.status, direction: m.direction, amount: m.amountCop, detail: m.detail };
    } else {
      const x = await integrations.chain.getTransaction(t.rail, t.external_ref!);
      obs = {
        found: x.found,
        status: x.status,
        confirmations: x.confirmations,
        to: x.to,
        from: x.from,
        tokenContract: x.tokenContract,
        amount: x.amountBaseUnits,
        blockNumber: x.blockNumber,
        finalized: x.finalized,
        anomaly: x.anomaly,
        detail: x.detail,
      };
      // Sin campos vacíos en la evidencia: la comparación de observaciones repetidas queda estable.
      for (const k of Object.keys(obs) as (keyof Observed)[]) if (obs[k] === undefined) delete obs[k];
    }
  } catch (e) {
    call.ok = false;
    call.error = (e as Error).message.slice(0, 500);
  }
  call.durationMs = Date.now() - started;
  return { obs, call };
}

async function logCall(ctx: Ctx, call: Awaited<ReturnType<typeof observe>>['call']) {
  await ctx.tx.query(
    `INSERT INTO otc.integration_calls (integration, operation, target, sandbox, ok, duration_ms, error, called_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [call.integration, call.operation, call.target, call.sandbox, call.ok, call.durationMs, call.error, call.calledAt],
  );
}

async function saveObservation(ctx: Ctx, t: TransferRow, obs: Observed, outcome: string, note: string | null, onlyIfChanged = false) {
  if (onlyIfChanged) {
    const last = await ctx.tx.query('SELECT payload FROM otc.observations WHERE transfer_id = $1 ORDER BY id DESC LIMIT 1', [t.id]);
    if (last.rowCount && JSON.stringify(last.rows[0].payload) === JSON.stringify(obs)) return;
  }
  await ctx.tx.query(
    `INSERT INTO otc.observations (transfer_id, source, sandbox, payload, outcome, note, observed_at) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [t.id, t.rail === 'BANK' ? 'BANK' : 'CHAIN', railIsSandbox(ctx.integrations, t.rail), obs, outcome, note, ctx.now()],
  );
}

// ---------- Efectos de confirmar o fallar ----------

/** Confirmada: asiento contable, reserva consumida y avance de la orden, todo en la misma transacción. */
async function applyConfirmed(ctx: Ctx, t: TransferRow) {
  const amount = new D(t.amount);
  const trading = await accountByCode(ctx.tx, tradingCode(t.asset));
  const lines =
    t.purpose === 'COBRO'
      ? [
          { accountId: t.account_id, amount },
          { accountId: trading.id, amount: amount.neg() },
        ]
      : t.purpose === 'TRASLADO'
        ? [
            { accountId: t.to_account_id!, amount },
            { accountId: t.account_id, amount: amount.neg() },
          ]
        : [
            { accountId: trading.id, amount },
            { accountId: t.account_id, amount: amount.neg() },
          ];
  await postEntry(ctx, {
    kind: 'NORMAL',
    description: `${t.purpose === 'COBRO' ? 'Cobro' : t.purpose === 'TRASLADO' ? 'Traslado' : 'Entrega'} confirmado (transferencia ${t.number})`,
    orderId: t.order_id,
    transferId: t.id,
    lines,
  });
  if (t.direction === 'OUT') {
    const res = await openReservationForTransfer(ctx.tx, t.id);
    if (!res || res.status !== 'LOCKED') throw new Error(`La transferencia ${t.number} no tiene su reserva bloqueada`);
    await consumeReservation(ctx, res.id);
  }
  if (t.order_id && (t.purpose === 'COBRO' || t.purpose === 'ENTREGA')) await advanceWithEvidence(ctx, await lockOrder(ctx.tx, t.order_id));
  await resolveCasesFor(ctx, 'transfer', t.id, 'Confirmada con evidencia externa');
}

/** Fallida de forma demostrada: la reserva vuelve a estar disponible y la orden queda lista para un reintento. */
async function applyFailed(ctx: Ctx, t: TransferRow, reason: string) {
  const res = t.direction === 'OUT' ? await openReservationForTransfer(ctx.tx, t.id) : null;
  if (res) {
    if (t.order_id) await unlockReservation(ctx, res.id, `Transferencia ${t.number} fallida: ${reason}`);
    else await releaseReservation(ctx, res.id, `Traslado ${t.number} fallido: ${reason}`);
  }
  if (t.purpose === 'ENTREGA' && t.order_id) await onDeliveryFailed(ctx, t.order_id, reason);
  if (t.purpose === 'COBRO' && t.order_id) await reviewFromTransfer(ctx, t.order_id, `El cobro reportado falló: ${reason}`);
  await resolveCasesFor(ctx, 'transfer', t.id, `Fallida: ${reason}`);
}

async function applyDecision(ctx: Ctx, t: TransferRow, d: Decision, obs: Observed, slow: boolean) {
  switch (d.kind) {
    case 'WAIT':
      await saveObservation(ctx, t, obs, 'SIN_CAMBIO', null, true);
      return t;
    case 'ALERT':
      await saveObservation(ctx, t, obs, 'ALERTA', d.reason, true);
      await openCase(ctx, 'transfer', t.id, 'SIN_CONFIRMAR', d.reason);
      return t;
    case 'PENDING': {
      const moved =
        t.status === 'ENVIADA'
          ? await moveTransfer(ctx, t, 'PENDIENTE', 'La red ya la muestra; faltan confirmaciones', { confirmations: d.confirmations, checkedAt: ctx.now() })
          : t;
      if (t.status === 'PENDIENTE') {
        await ctx.tx.query('UPDATE otc.transfers SET confirmations = $2, updated_at = $3 WHERE id = $1', [t.id, d.confirmations, ctx.now()]);
      }
      await saveObservation(ctx, t, obs, 'PENDIENTE', null, t.status === 'PENDIENTE');
      if (slow) await openCase(ctx, 'transfer', t.id, 'SIN_CONFIRMAR', 'Pasó el primer plazo sin el umbral de confirmaciones');
      return moved;
    }
    case 'CONFIRM': {
      await saveObservation(ctx, t, obs, 'CONFIRMADA', null);
      const moved = await moveTransfer(ctx, t, 'CONFIRMADA', null, { confirmations: d.confirmations, checkedAt: ctx.now() }, { evidence: obs });
      await applyConfirmed(ctx, moved);
      return moved;
    }
    case 'FAIL': {
      await saveObservation(ctx, t, obs, 'FALLIDA', d.reason);
      const moved = await moveTransfer(ctx, t, 'FALLIDA', d.reason, { checkedAt: ctx.now() }, { evidence: obs });
      await applyFailed(ctx, moved, d.reason);
      return moved;
    }
    case 'REVIEW': {
      await saveObservation(ctx, t, obs, 'REVISION', d.reason);
      const moved = await moveTransfer(ctx, t, 'EN_REVISION', d.reason, { checkedAt: ctx.now() }, { evidence: obs });
      await openCase(ctx, 'transfer', t.id, 'REVISION', d.reason);
      if (t.order_id) await reviewFromTransfer(ctx, t.order_id, `Transferencia ${t.number}: ${d.reason}`);
      return moved;
    }
  }
}

export interface TrackDeps {
  db: Db;
  integrations: Integrations;
  now: () => Date;
  actor: Actor; // el sistema en el trabajador; la persona cuando se pide una revisión inmediata
}

/**
 * Revisa una transferencia: consulta fuera de la transacción y aplica el resultado dentro.
 * En revisión, lo observado solo se guarda como evidencia; decide un responsable.
 */
export async function checkTransfer(deps: TrackDeps, transferId: string) {
  const { db, integrations } = deps;
  const target = await loadTarget(db, integrations, transferId);
  if (!TRACKED.includes(target.transfer.status) || !target.transfer.external_ref) return { status: target.transfer.status, applied: false };
  const { obs, call } = await observe(integrations, target, deps.now);
  return inTransaction(db, async (tx) => {
    const ctx: Ctx = { tx, actor: deps.actor, integrations, now: deps.now };
    await logCall(ctx, call);
    const t = await lockTransfer(tx, transferId);
    await tx.query('UPDATE otc.transfers SET last_checked_at = $2 WHERE id = $1 AND status = ANY($3::text[])', [t.id, ctx.now(), TRACKED]);
    if (!obs) {
      // La integración no respondió: nada se acredita ni cambia de estado; el próximo ciclo reintenta.
      // Pasado el primer plazo queda un caso abierto para que alguien lo mire.
      if (t.status === 'ENVIADA' || t.status === 'PENDIENTE') {
        const settings = await getDeskSettings(ctx);
        const age = (ctx.now().getTime() - new Date(t.sent_at ?? t.created_at).getTime()) / 1000;
        if (age >= settings.transfer_pending_seconds) {
          await openCase(ctx, 'transfer', t.id, 'SIN_CONFIRMAR', `No se pudo consultar ${t.rail === 'BANK' ? 'el banco' : 'la red'}: ${call.error ?? 'sin respuesta'}`);
        }
      }
      return { status: t.status, applied: false };
    }
    if (t.status !== target.transfer.status || !TRACKED.includes(t.status)) {
      await saveObservation(ctx, t, obs, 'EVIDENCIA_TARDIA', `Llegó cuando la transferencia ya estaba ${t.status}`);
      return { status: t.status, applied: false };
    }
    if (t.status === 'EN_REVISION') {
      await saveObservation(ctx, t, obs, 'EVIDENCIA_TARDIA', 'En revisión: lo decide un responsable', true);
      return { status: t.status, applied: false };
    }
    const settings = await getDeskSettings(ctx);
    const ageSeconds = (ctx.now().getTime() - new Date(t.sent_at ?? t.created_at).getTime()) / 1000;
    const timing = {
      ageSeconds,
      pendingSeconds: settings.transfer_pending_seconds,
      reviewSeconds: settings.transfer_review_seconds,
      requiredConfirmations: t.rail === 'TRON' ? settings.tron_confirmations : t.rail === 'BSC' ? settings.bsc_confirmations : 0,
    };
    const decision = decide(obs, target.expected, timing);
    const moved = await applyDecision(ctx, t, decision, obs, ageSeconds >= timing.pendingSeconds);
    return { status: moved.status, applied: true, decision };
  });
}

/** Barrido del trabajador: revisa las transferencias en seguimiento, las más antiguas primero. */
export async function trackTransfers(deps: TrackDeps, everySeconds = 15) {
  const now = deps.now();
  const due = await deps.db.query<{ id: string }>(
    `SELECT id FROM otc.transfers
     WHERE status = ANY($1::text[]) AND external_ref IS NOT NULL
       AND (last_checked_at IS NULL OR last_checked_at <= $2)
     ORDER BY last_checked_at NULLS FIRST, sent_at LIMIT 50`,
    [TRACKED, new Date(now.getTime() - everySeconds * 1000)],
  );
  const results = [];
  for (const { id } of due.rows) results.push({ id, ...(await checkTransfer(deps, id)) });
  return results;
}

/**
 * El administrador resuelve una transferencia en revisión con la evidencia guardada: confirmada solo
 * si la red o el banco la reportaron exitosa; fallida solo si la reportaron fallida o nunca apareció.
 */
export async function resolveTransferReview(ctx: Ctx, id: string, to: 'CONFIRMADA' | 'FALLIDA' | 'PENDIENTE', note: string) {
  authorize(ctx.actor, 'review.resolve');
  if (!note.trim()) throw invalid('Explica la decisión');
  const t = await lockTransfer(ctx.tx, id);
  if (t.status !== 'EN_REVISION') throw new DomainError('INVALID_STATE', `La transferencia ${t.number} no está en revisión`);
  const last = await ctx.tx.query<{ payload: Observed }>(
    'SELECT payload FROM otc.observations WHERE transfer_id = $1 ORDER BY id DESC LIMIT 1',
    [id],
  );
  const evidence = last.rows[0]?.payload;
  if (to === 'CONFIRMADA') {
    // La evidencia debe mostrar éxito con el umbral y coincidir en destino, sentido y monto.
    const target = await loadTarget(ctx.tx, ctx.integrations, id);
    const settings = await getDeskSettings(ctx);
    const required = t.rail === 'TRON' ? settings.tron_confirmations : t.rail === 'BSC' ? settings.bsc_confirmations : 0;
    const verdict = evidence
      ? decide(evidence, target.expected, { ageSeconds: 0, pendingSeconds: Infinity, reviewSeconds: Infinity, requiredConfirmations: required })
      : null;
    if (verdict?.kind !== 'CONFIRM') {
      throw new DomainError(
        'NO_EVIDENCE',
        verdict?.kind === 'REVIEW'
          ? `La evidencia no coincide con lo autorizado: ${verdict.reason}`
          : 'No hay evidencia de la red o del banco que respalde la confirmación',
      );
    }
  }
  if (to === 'FALLIDA' && evidence?.found && evidence.status !== 'FAILED' && evidence.status !== 'REJECTED') {
    throw new DomainError('NO_EVIDENCE', 'La última evidencia muestra la transferencia en la red o en el banco; no se puede dar por fallida');
  }
  const moved = await moveTransfer(ctx, t, to, note.trim(), { checkedAt: ctx.now() }, { evidence: evidence ?? null, resolvedBy: ctx.actor.id });
  if (to === 'CONFIRMADA') await applyConfirmed(ctx, moved);
  if (to === 'FALLIDA') await applyFailed(ctx, moved, note.trim());
  if (to === 'PENDIENTE') await resolveCasesFor(ctx, 'transfer', t.id, `Vuelve a seguimiento: ${note.trim()}`);
  return moved;
}

export async function observationsOf(ctx: Pick<Ctx, 'tx'>, transferId: string) {
  const r = await ctx.tx.query('SELECT * FROM otc.observations WHERE transfer_id = $1 ORDER BY id DESC LIMIT 100', [transferId]);
  return r.rows;
}
