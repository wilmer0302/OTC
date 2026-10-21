import { useEffect, useState } from 'react';

// Enrutador mínimo por hash (#/ordenes/<id>?estado=...): enlaces compartibles y botón atrás
// sin depender del servidor web.

export interface Route {
  path: string[];
  query: URLSearchParams;
}

function parse(): Route {
  const raw = window.location.hash.replace(/^#\/?/, '');
  const [p, q = ''] = raw.split('?');
  return { path: p.split('/').filter(Boolean).map(decodeURIComponent), query: new URLSearchParams(q) };
}

export function useRoute(): Route {
  const [route, setRoute] = useState(parse);
  useEffect(() => {
    const on = () => setRoute(parse());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return route;
}

export function href(path: string, query?: Record<string, string | undefined | null>) {
  const qs = query
    ? new URLSearchParams(Object.entries(query).filter(([, v]) => v) as [string, string][]).toString()
    : '';
  return `#/${path.replace(/^\//, '')}${qs ? `?${qs}` : ''}`;
}

export function navigate(path: string, query?: Record<string, string | undefined | null>) {
  window.location.hash = href(path, query);
}

/** Cambia filtros en la dirección sin agregar una entrada al historial por cada tecla. */
export function replaceQuery(path: string, query: Record<string, string | undefined | null>) {
  const url = `${window.location.pathname}${window.location.search}${href(path, query)}`;
  window.history.replaceState(null, '', url);
  window.dispatchEvent(new HashChangeEvent('hashchange'));
}
