import { useNow } from '../lib/hooks';

/** Tiempo restante hasta un vencimiento. Solo informa: la hora del servidor decide si algo venció. */
export function Countdown({ until, expiredLabel = 'Vencida' }: { until: string; expiredLabel?: string }) {
  const now = useNow();
  const ms = new Date(until).getTime() - now;
  if (ms <= 0) return <span className="countdown text-danger">{expiredLabel}</span>;
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const text = h ? `${h} h ${String(m).padStart(2, '0')} min` : `${m}:${String(s).padStart(2, '0')}`;
  return <span className={`countdown ${total < 30 ? 'text-danger' : total < 120 ? 'text-warning' : 'text-success'}`}>{text}</span>;
}
