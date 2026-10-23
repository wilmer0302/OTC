import type { ReactNode } from 'react';
import type { Tone } from '../lib/labels';

export function Badge({ tone = 'neutral', children, title }: { tone?: Tone; children: ReactNode; title?: string }) {
  return (
    <span className={`badge tone-${tone}`} title={title}>
      <span className="badge-dot" aria-hidden />
      {children}
    </span>
  );
}

/** Estado con su etiqueta en español; si el estado no está en el mapa se muestra tal cual. */
export function StatusBadge({ map, status, title }: { map: Record<string, { label: string; tone: Tone }>; status: string; title?: string }) {
  const info = map[status] ?? { label: status, tone: 'neutral' as Tone };
  return (
    <Badge tone={info.tone} title={title}>
      {info.label}
    </Badge>
  );
}

/** Marca obligatoria en todo dato que proviene de un entorno simulado. */
export function SimulatedTag({ children = 'DATOS SIMULADOS' }: { children?: ReactNode }) {
  return <span className="sim-tag">{children}</span>;
}
