import { useCallback, useEffect, useRef, useState } from 'react';

/** Carga datos de la API y permite recargarlos. Con `refreshMs` se refresca solo mientras la pestaña está visible. */
export function useQuery<T>(load: (() => Promise<T>) | null, deps: unknown[], opts: { refreshMs?: number } = {}) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(!!load);
  const seq = useRef(0);
  const loader = useRef(load);
  loader.current = load;

  const reload = useCallback(async () => {
    const fn = loader.current;
    if (!fn) return;
    const mine = ++seq.current;
    setLoading(true);
    try {
      const result = await fn();
      if (mine === seq.current) {
        setData(result);
        setError(null);
      }
    } catch (e) {
      if (mine === seq.current) setError(e);
    } finally {
      if (mine === seq.current) setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!load) {
      setData(null);
      return;
    }
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => {
    if (!opts.refreshMs) return;
    const t = setInterval(() => {
      if (document.visibilityState === 'visible') reload();
    }, opts.refreshMs);
    return () => clearInterval(t);
  }, [opts.refreshMs, reload]);

  return { data, error, loading, reload, setData };
}

/** Valor que se actualiza solo cuando el usuario deja de escribir. */
export function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** Hora actual que avanza cada segundo, para cuentas regresivas. Solo informa: el servidor decide los vencimientos. */
export function useNow(intervalMs = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}
