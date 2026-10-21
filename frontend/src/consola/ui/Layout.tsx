import type { ReactNode } from 'react';
import type { Tone } from '../lib/labels';

export function PageHeader({ title, subtitle, actions, back }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; back?: { href: string; label: string } }) {
  return (
    <header className="page-header">
      <div>
        {back && (
          <a className="back-link" href={back.href}>
            ← {back.label}
          </a>
        )}
        <h1>{title}</h1>
        {subtitle && <p className="page-subtitle">{subtitle}</p>}
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </header>
  );
}

export function Card({ title, actions, children, className = '', flush }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; flush?: boolean }) {
  return (
    <section className={`card ${flush ? 'card-flush' : ''} ${className}`}>
      {(title || actions) && (
        <div className="card-head">
          {title && <h2>{title}</h2>}
          {actions && <div className="card-actions">{actions}</div>}
        </div>
      )}
      <div className="card-body">{children}</div>
    </section>
  );
}

export function Grid({ cols = 2, children }: { cols?: 2 | 3 | 4; children: ReactNode }) {
  return <div className={`grid grid-${cols}`}>{children}</div>;
}

export function StatTile({ label, value, hint, tone, href }: { label: string; value: ReactNode; hint?: ReactNode; tone?: Tone; href?: string }) {
  const body = (
    <>
      <span className="stat-label">{label}</span>
      <strong className={`stat-value ${tone ? `text-${tone}` : ''}`}>{value}</strong>
      {hint && <span className="stat-hint">{hint}</span>}
    </>
  );
  return href ? (
    <a className="stat-tile is-link" href={href}>
      {body}
    </a>
  ) : (
    <div className="stat-tile">{body}</div>
  );
}

/** Lista de datos etiqueta → valor. */
export function KeyValue({ items, columns = 1 }: { items: [ReactNode, ReactNode][]; columns?: 1 | 2 }) {
  return (
    <dl className={`kv kv-${columns}`}>
      {items.map(([k, v], i) => (
        <div className="kv-row" key={i}>
          <dt>{k}</dt>
          <dd>{v ?? '—'}</dd>
        </div>
      ))}
    </dl>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <strong>{title}</strong>
      {children && <p>{children}</p>}
    </div>
  );
}

export function Loading({ label = 'Cargando…' }: { label?: string }) {
  return (
    <div className="loading" role="status">
      <span className="spinner" aria-hidden /> {label}
    </div>
  );
}

export function Tabs<K extends string>({ tabs, active, onChange }: { tabs: { key: K; label: ReactNode; count?: number }[]; active: K; onChange: (k: K) => void }) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((t) => (
        <button key={t.key} role="tab" aria-selected={active === t.key} className={`tab ${active === t.key ? 'is-active' : ''}`} onClick={() => onChange(t.key)}>
          {t.label}
          {t.count !== undefined && t.count > 0 && <span className="tab-count">{t.count}</span>}
        </button>
      ))}
    </div>
  );
}

/** Aviso de contexto dentro de una pantalla (no es un error). */
export function Notice({ tone = 'info', title, children }: { tone?: Tone; title?: ReactNode; children?: ReactNode }) {
  return (
    <div className={`notice tone-${tone}`} role={tone === 'danger' ? 'alert' : undefined}>
      {title && <strong>{title}</strong>}
      {children && <div>{children}</div>}
    </div>
  );
}

export function Amount({ children, strong }: { children: ReactNode; strong?: boolean }) {
  return <span className={`amount ${strong ? 'is-strong' : ''}`}>{children}</span>;
}
