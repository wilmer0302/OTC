// Formato de montos. Se trabaja con los textos que envía el backend; aquí solo se presentan.
const groups = (int: string) => int.replace(/\B(?=(\d{3})+(?!\d))/g, '.');

export function fmtNumber(value: string | number, decimals?: number): string {
  let s = String(value ?? '0');
  const neg = s.startsWith('-');
  if (neg) s = s.slice(1);
  let [int, frac = ''] = s.split('.');
  if (decimals !== undefined) frac = frac.padEnd(decimals, '0').slice(0, decimals);
  else frac = frac.replace(/0+$/, '');
  return `${neg ? '-' : ''}${groups(int)}${frac ? ',' + frac : ''}`;
}

export const cop = (v: string | number) => `$ ${fmtNumber(v, 0)}`;
export const copPrice = (v: string | number) => `$ ${fmtNumber(v, 2)}`;
export const usdt = (v: string | number) => `${fmtNumber(v)} USDT`;

export const dateTime = (v: string) =>
  new Date(v).toLocaleString('es-CO', { timeZone: 'America/Bogota', dateStyle: 'short', timeStyle: 'medium' });

export const SIDE_LABEL: Record<string, string> = {
  BUY: 'Mesa compra USDT',
  SELL: 'Mesa vende USDT',
};

export const STATUS_LABEL: Record<string, string> = {
  AWAITING_PAYMENT: 'Esperando cobro',
  PAYMENT_CONFIRMED: 'Cobro confirmado',
  DELIVERY_APPROVED: 'Entrega aprobada',
  DELIVERY_SENT: 'Entrega enviada',
  CLOSED: 'Cerrada',
  CANCELLED: 'Cancelada',
  IN_REVIEW: 'En revisión',
};

export const POLICY_LABEL: Record<string, string> = {
  SINGLE: 'Una persona aprueba todo',
  THRESHOLD: 'Segunda persona por encima del umbral',
  ALL: 'Dos personas en toda salida',
};

export const SETTLEMENT_LABEL: Record<string, string> = {
  REGISTERED: 'Registrado',
  CONFIRMED: 'Verificado',
  MISMATCH: 'No coincide',
};
