import type { ReactNode } from 'react';
import { ErrorNotice } from './Feedback';
import { EmptyState } from './Layout';

export interface Column<T> {
  key: string;
  header: ReactNode;
  render: (row: T) => ReactNode;
  align?: 'left' | 'right' | 'center';
  /** Se oculta en pantallas angostas para dejar lo esencial. */
  secondary?: boolean;
  width?: string;
}

interface Props<T> {
  columns: Column<T>[];
  rows: T[] | null;
  rowKey: (row: T) => string;
  loading?: boolean;
  error?: unknown;
  onRowClick?: (row: T) => void;
  rowHref?: (row: T) => string;
  selectedKey?: string | null;
  empty?: { title: string; hint?: ReactNode };
  caption?: string;
}

/**
 * Tabla legible: encabezado fijo, números alineados a la derecha con cifras de ancho fijo y, en
 * pantallas angostas, cada fila se muestra como una ficha con su etiqueta.
 */
export function DataTable<T>({ columns, rows, rowKey, loading, error, onRowClick, rowHref, selectedKey, empty, caption }: Props<T>) {
  if (error && !rows) return <ErrorNotice error={error} />;
  const clickable = !!(onRowClick || rowHref);
  const open = (row: T) => {
    if (onRowClick) onRowClick(row);
    else if (rowHref) window.location.hash = rowHref(row).replace(/^#/, '');
  };
  return (
    <div className={`table-wrap ${loading && rows ? 'is-refreshing' : ''}`}>
      {error && rows ? <ErrorNotice error={error} compact /> : null}
      <table className="table">
        {caption && <caption className="sr-only">{caption}</caption>}
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.key} className={`${c.align ? `align-${c.align}` : ''} ${c.secondary ? 'col-secondary' : ''}`} style={c.width ? { width: c.width } : undefined} scope="col">
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {!rows && loading &&
            [0, 1, 2].map((i) => (
              <tr key={`sk${i}`} className="skeleton-row">
                {columns.map((c) => (
                  <td key={c.key} className={c.secondary ? 'col-secondary' : ''}>
                    <span className="skeleton" />
                  </td>
                ))}
              </tr>
            ))}
          {rows?.map((row) => {
            const k = rowKey(row);
            return (
              <tr
                key={k}
                className={`${clickable ? 'is-clickable' : ''} ${selectedKey === k ? 'is-selected' : ''}`}
                onClick={clickable ? () => open(row) : undefined}
                onKeyDown={clickable ? (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), open(row)) : undefined}
                tabIndex={clickable ? 0 : undefined}
              >
                {columns.map((c) => (
                  <td
                    key={c.key}
                    data-label={typeof c.header === 'string' ? c.header : undefined}
                    className={`${c.align ? `align-${c.align}` : ''} ${c.secondary ? 'col-secondary' : ''}`}
                  >
                    <span className="td-content">{c.render(row)}</span>
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
      {rows && rows.length === 0 && <EmptyState title={empty?.title ?? 'No hay registros'}>{empty?.hint}</EmptyState>}
      {rows && rows.length === 200 && <p className="table-foot">Se muestran los 200 más recientes. Usa los filtros para acotar.</p>}
    </div>
  );
}
