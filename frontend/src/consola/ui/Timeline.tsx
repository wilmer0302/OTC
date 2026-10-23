import type { HistoryEntry } from '../api/types';
import { dateTime } from '../lib/format';
import type { Tone } from '../lib/labels';
import { StatusBadge } from './Badge';
import { EmptyState } from './Layout';

/** Historial de estados de una entidad: quién, cuándo, de qué estado a cuál y por qué. */
export function Timeline({ entries, map }: { entries: HistoryEntry[]; map: Record<string, { label: string; tone: Tone }> }) {
  if (!entries.length) return <EmptyState title="Sin movimientos registrados" />;
  return (
    <ol className="timeline">
      {entries.map((e) => (
        <li key={e.id}>
          <div className="timeline-head">
            <StatusBadge map={map} status={e.to_status} />
            <span className="muted">{dateTime(e.created_at)}</span>
          </div>
          <div className="timeline-meta">{e.actor_name ?? 'Sistema (proceso automático)'}</div>
          {e.note && <div className="timeline-note">{e.note}</div>}
        </li>
      ))}
    </ol>
  );
}
