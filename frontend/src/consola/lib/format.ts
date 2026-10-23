// Formato de montos y fechas para mostrar. Se trabaja sobre el texto decimal que envía el servidor:
// no se redondea ni se recalcula nada, solo se agrupan miles y se ajustan decimales a la vista.

const groups = (int: string) => int.replace(/\B(?=(\d{3})+(?!\d))/g, '.');

export function fmtDecimal(value: string | number | null | undefined, decimals?: number): string {
  if (value === null || value === undefined || value === '') return '—';
  let s = String(value).trim();
  const neg = s.startsWith('-');
  if (neg) s = s.slice(1);
  const [int, rawFrac = ''] = s.split('.');
  let frac = rawFrac;
  if (decimals !== undefined) {
    // Solo se completan ceros o se recortan ceros sobrantes: nunca se descarta un dígito significativo.
    frac = frac.padEnd(decimals, '0');
    const extra = frac.slice(decimals);
    frac = /^0*$/.test(extra) ? frac.slice(0, decimals) : frac.replace(/0+$/, '');
  } else frac = frac.replace(/0+$/, '');
  return `${neg ? '−' : ''}${groups(int || '0')}${frac ? ',' + frac : ''}`;
}

export const cop = (v: string | number | null | undefined) => (v === null || v === undefined ? '—' : `$ ${fmtDecimal(v, 0)}`);
export const copPrice = (v: string | number | null | undefined) => (v === null || v === undefined ? '—' : `$ ${fmtDecimal(v, 2)}`);
export const usdt = (v: string | number | null | undefined) => (v === null || v === undefined ? '—' : `${fmtDecimal(v)} USDT`);
export const amountOf = (asset: string, v: string | number | null | undefined) => (asset === 'COP' ? cop(v) : usdt(v));
export const pct = (rate: string | number) => `${fmtDecimal(String(Number(rate) * 100))} %`;

const TZ = 'America/Bogota';
export const dateTime = (v: string | null | undefined) =>
  v ? new Date(v).toLocaleString('es-CO', { timeZone: TZ, dateStyle: 'short', timeStyle: 'medium' }) : '—';
export const timeOnly = (v: string | null | undefined) =>
  v ? new Date(v).toLocaleTimeString('es-CO', { timeZone: TZ, hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—';
export const dateOnly = (v: string | null | undefined) =>
  v ? new Date(v.length === 10 ? `${v}T12:00:00-05:00` : v).toLocaleDateString('es-CO', { timeZone: TZ, dateStyle: 'medium' }) : '—';

/** Fecha de hoy en Bogotá (AAAA-MM-DD), solo para proponer un valor en un formulario. */
export const todayBogota = () => new Date().toLocaleDateString('en-CA', { timeZone: TZ });

export const shortId = (v: string | null | undefined, keep = 8) => (!v ? '—' : v.length <= keep * 2 + 1 ? v : `${v.slice(0, keep)}…${v.slice(-keep)}`);

export function duration(seconds: number): string {
  if (seconds < 60) return `${seconds} s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`;
  if (seconds < 86400) return `${+(seconds / 3600).toFixed(1)} h`;
  return `${+(seconds / 86400).toFixed(1)} días`;
}
