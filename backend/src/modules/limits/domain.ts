import { z } from 'zod';
import { D, type Dec } from '../../platform/money.js';

// Límites y política de aprobación. Reglas puras, sin base de datos.

export type LimitKind =
  | 'ORDER_MAX_USDT'
  | 'CLIENT_DAILY_USDT'
  | 'DESK_DAILY_USDT'
  | 'OPEN_EXPOSURE_USDT'
  | 'OPEN_EXPOSURE_COP'
  | 'APPROVAL_POLICY';

export type ApprovalPolicy = { policy: 'SINGLE' | 'ALL' } | { policy: 'THRESHOLD'; thresholdCop: string };

const usdt = z.strictObject({ amount: z.string().regex(/^\d{1,18}(\.\d{1,6})?$/, 'Monto USDT con máximo 6 decimales') });
const cop = z.strictObject({ amount: z.string().regex(/^\d{1,20}$/, 'Monto en pesos enteros') });

export const VALUE_SCHEMAS: Record<LimitKind, z.ZodType> = {
  ORDER_MAX_USDT: usdt,
  CLIENT_DAILY_USDT: usdt,
  DESK_DAILY_USDT: usdt,
  OPEN_EXPOSURE_USDT: usdt,
  OPEN_EXPOSURE_COP: cop,
  APPROVAL_POLICY: z.discriminatedUnion('policy', [
    z.strictObject({ policy: z.literal('SINGLE') }),
    z.strictObject({ policy: z.literal('ALL') }),
    z.strictObject({ policy: z.literal('THRESHOLD'), thresholdCop: z.string().regex(/^\d{1,20}$/) }),
  ]),
};

export const PER_CLIENT_KINDS: LimitKind[] = ['ORDER_MAX_USDT', 'CLIENT_DAILY_USDT'];

export const KIND_LABEL: Record<LimitKind, string> = {
  ORDER_MAX_USDT: 'Límite por operación',
  CLIENT_DAILY_USDT: 'Límite diario del cliente',
  DESK_DAILY_USDT: 'Límite diario de la mesa',
  OPEN_EXPOSURE_USDT: 'Exposición abierta en USDT',
  OPEN_EXPOSURE_COP: 'Exposición abierta en pesos',
  APPROVAL_POLICY: 'Política de aprobación',
};

export interface EffectiveLimits {
  orderMaxUsdt: Dec;
  clientDailyUsdt: Dec;
  deskDailyUsdt: Dec;
  openExposureUsdt: Dec; // USDT que la mesa debe entregar en órdenes abiertas
  openExposureCop: Dec; // pesos que la mesa debe entregar en órdenes abiertas
  approval: ApprovalPolicy;
}

export interface Usage {
  clientDailyUsdt: Dec; // USDT del cliente hoy en órdenes no vencidas ni canceladas
  deskDailyUsdt: Dec; // ídem, toda la mesa
  openExposureUsdt: Dec;
  openExposureCop: Dec;
}

export interface Operation {
  side: 'BUY' | 'SELL';
  usdtAmount: Dec;
  totalCop: Dec | null; // null cuando aún no hay precio (solicitud)
}

export interface Violation {
  kind: LimitKind;
  message: string;
}

const n = (d: Dec) => d.toFixed();

/** Revisa todos los límites y devuelve cada violación con su mensaje para el usuario. */
export function checkLimits(op: Operation, limits: EffectiveLimits, usage: Usage): Violation[] {
  const out: Violation[] = [];
  if (op.usdtAmount.gt(limits.orderMaxUsdt)) {
    out.push({ kind: 'ORDER_MAX_USDT', message: `Supera el límite por operación (${n(op.usdtAmount)} de ${n(limits.orderMaxUsdt)} USDT)` });
  }
  const client = usage.clientDailyUsdt.plus(op.usdtAmount);
  if (client.gt(limits.clientDailyUsdt)) {
    out.push({
      kind: 'CLIENT_DAILY_USDT',
      message: `Supera el límite diario del cliente (usado ${n(usage.clientDailyUsdt)} de ${n(limits.clientDailyUsdt)} USDT)`,
    });
  }
  const desk = usage.deskDailyUsdt.plus(op.usdtAmount);
  if (desk.gt(limits.deskDailyUsdt)) {
    out.push({
      kind: 'DESK_DAILY_USDT',
      message: `Supera el límite diario de la mesa (usado ${n(usage.deskDailyUsdt)} de ${n(limits.deskDailyUsdt)} USDT)`,
    });
  }
  if (op.side === 'SELL' && usage.openExposureUsdt.plus(op.usdtAmount).gt(limits.openExposureUsdt)) {
    out.push({
      kind: 'OPEN_EXPOSURE_USDT',
      message: `Supera la exposición abierta en USDT (abierta ${n(usage.openExposureUsdt)} de ${n(limits.openExposureUsdt)})`,
    });
  }
  if (op.side === 'BUY' && op.totalCop && usage.openExposureCop.plus(op.totalCop).gt(limits.openExposureCop)) {
    out.push({
      kind: 'OPEN_EXPOSURE_COP',
      message: `Supera la exposición abierta en pesos (abierta ${n(usage.openExposureCop)} de ${n(limits.openExposureCop)})`,
    });
  }
  return out;
}

/** Aprobaciones de la entrega según la política vigente. */
export function requiredApprovals(policy: ApprovalPolicy, totalCop: Dec): 1 | 2 {
  if (policy.policy === 'THRESHOLD') return totalCop.gt(new D(policy.thresholdCop)) ? 2 : 1;
  return policy.policy === 'ALL' ? 2 : 1;
}

export const ZERO_USAGE: Usage = { clientDailyUsdt: new D(0), deskDailyUsdt: new D(0), openExposureUsdt: new D(0), openExposureCop: new D(0) };
