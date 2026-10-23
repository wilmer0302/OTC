import { DomainError, invalid, notFound } from '../../domain/errors.js';
import { isSandbox } from '../../integrations/ports.js';
import { actorDbId, type Ctx } from '../../platform/context.js';
import { recordAction } from '../../platform/events.js';
import { D, usdtToBaseUnits } from '../../platform/money.js';
import { authorize } from '../identity/permissions.js';

// SIMULACIÓN para la demo y las pruebas: escribe lo que "dirían" la red o el banco en las tablas
// sandbox. Solo funciona con integraciones sandbox; con integraciones reales se niega.
// Nada de esto mueve dinero ni confirma nada por sí solo: el módulo de confirmaciones lo lee
// como leería la red o el banco.

function assertSandbox(ctx: Ctx) {
  authorize(ctx.actor, 'sandbox.simulate');
  if (!isSandbox(ctx.integrations)) throw new DomainError('NOT_SANDBOX', 'La simulación solo existe en entornos sandbox o demo', 404);
}

export interface SimulateInput {
  status: 'PENDING' | 'SUCCESS' | 'FAILED' | 'SETTLED' | 'REJECTED';
  confirmations?: number;
  /** Para simular un envío equivocado: otro monto (USDT o pesos) u otra dirección. */
  amount?: string;
  toAddress?: string;
  failReason?: string;
}

/**
 * Simula lo que la red o el banco reportan sobre una transferencia ya registrada (por su hash o
 * referencia). Repetirla actualiza la simulación, por ejemplo para subir las confirmaciones.
 */
export async function simulateFor(ctx: Ctx, transferId: string, input: SimulateInput) {
  assertSandbox(ctx);
  const r = await ctx.tx.query(
    `SELECT t.*, a.external_ref AS account_ref, d.value AS dest_value, ta.external_ref AS to_account_ref
     FROM otc.transfers t JOIN otc.accounts a ON a.id = t.account_id
     LEFT JOIN otc.destinations d ON d.id = t.destination_id LEFT JOIN otc.accounts ta ON ta.id = t.to_account_id
     WHERE t.id = $1`,
    [transferId],
  );
  if (!r.rowCount) throw notFound('La transferencia');
  const t = r.rows[0];
  if (!t.external_ref) throw invalid('La transferencia todavía no tiene hash o referencia registrada');
  const now = ctx.now();
  if (t.rail === 'BANK') {
    if (!['PENDING', 'SETTLED', 'REJECTED'].includes(input.status)) throw invalid('El banco responde PENDING, SETTLED o REJECTED');
    const amount = new D(input.amount ?? t.amount).toFixed(0);
    await ctx.tx.query(
      `INSERT INTO otc.sandbox_bank_movements (account_ref, reference, direction, amount_cop, status, occurred_at, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (account_ref, reference) DO UPDATE SET status = EXCLUDED.status, amount_cop = EXCLUDED.amount_cop`,
      [t.account_ref, t.external_ref, t.direction, amount, input.status, now, actorDbId(ctx.actor)],
    );
  } else {
    if (!['PENDING', 'SUCCESS', 'FAILED'].includes(input.status)) throw invalid('La red responde PENDING, SUCCESS o FAILED');
    const desk = t.account_ref ?? 'SANDBOX-SIN-DIRECCION';
    const other = t.direction === 'IN' ? 'SANDBOX-ORIGEN-CLIENTE' : (t.dest_value ?? t.to_account_ref ?? 'SANDBOX-SIN-DIRECCION');
    const from = t.direction === 'IN' ? other : desk;
    const to = input.toAddress ?? (t.direction === 'IN' ? desk : other);
    const units = usdtToBaseUnits(new D(input.amount ?? t.amount), t.rail);
    await ctx.tx.query(
      `INSERT INTO otc.sandbox_chain_txs (network, tx_hash, status, confirmations, from_address, to_address, amount_base_units,
         fail_reason, occurred_at, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (network, lower(tx_hash)) DO UPDATE SET status = EXCLUDED.status, confirmations = EXCLUDED.confirmations,
         to_address = EXCLUDED.to_address, amount_base_units = EXCLUDED.amount_base_units, fail_reason = EXCLUDED.fail_reason`,
      [t.rail, t.external_ref, input.status, input.confirmations ?? 0, from, to, units, input.failReason ?? null, now, actorDbId(ctx.actor)],
    );
  }
  await recordAction(ctx, 'sandbox.simulate', 'transfer', transferId, { ...input, sandbox: true });
  return { simulated: true, transfer: t.number, rail: t.rail, ...input };
}

/**
 * Simula un movimiento suelto en el banco o la red de una cuenta de la mesa, sin transferencia
 * en el libro (por ejemplo, un depósito que ninguna orden esperaba). Sirve para probar la conciliación.
 */
export async function simulateMovement(
  ctx: Ctx,
  accountId: string,
  input: { reference: string; direction: 'IN' | 'OUT'; amount: string; counterpartyRef?: string },
) {
  assertSandbox(ctx);
  const a = await ctx.tx.query('SELECT * FROM otc.accounts WHERE id = $1', [accountId]);
  if (!a.rowCount) throw notFound('La cuenta');
  const account = a.rows[0];
  if (!account.external_ref) throw invalid('La cuenta no tiene número o dirección registrada');
  const now = ctx.now();
  if (account.liquidity_type === 'BANK') {
    await ctx.tx.query(
      `INSERT INTO otc.sandbox_bank_movements (account_ref, reference, direction, amount_cop, status, occurred_at, created_by)
       VALUES ($1,$2,$3,$4,'SETTLED',$5,$6)`,
      [account.external_ref, input.reference, input.direction, new D(input.amount).toFixed(0), now, actorDbId(ctx.actor)],
    );
  } else if (account.liquidity_type === 'WALLET') {
    const other = input.counterpartyRef ?? 'SANDBOX-CONTRAPARTE';
    await ctx.tx.query(
      `INSERT INTO otc.sandbox_chain_txs (network, tx_hash, status, confirmations, from_address, to_address, amount_base_units, occurred_at, created_by)
       VALUES ($1,$2,'SUCCESS',100,$3,$4,$5,$6,$7)`,
      [
        account.network,
        input.reference,
        input.direction === 'IN' ? other : account.external_ref,
        input.direction === 'IN' ? account.external_ref : other,
        usdtToBaseUnits(new D(input.amount), account.network),
        now,
        actorDbId(ctx.actor),
      ],
    );
  } else {
    throw invalid('El exchange no tiene simulación: carga su extracto a mano');
  }
  await recordAction(ctx, 'sandbox.simulate_movement', 'account', accountId, { ...input, sandbox: true });
  return { simulated: true };
}
