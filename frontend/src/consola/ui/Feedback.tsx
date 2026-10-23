import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';
import { friendly } from '../lib/errors';

/** Error de la API explicado en lenguaje de operación, con la acción sugerida y la referencia para soporte. */
export function ErrorNotice({ error, compact }: { error: unknown; compact?: boolean }) {
  if (!error) return null;
  const f = friendly(error);
  return (
    <div className={`notice tone-danger ${compact ? 'is-compact' : ''}`} role="alert">
      <strong>{f.title}</strong>
      <div>{f.message}</div>
      {f.hint && <div className="notice-hint">{f.hint}</div>}
      {f.reference && <div className="notice-ref">Código de referencia: {f.reference}</div>}
    </div>
  );
}

interface Toast {
  id: number;
  tone: 'success' | 'info' | 'danger';
  text: ReactNode;
}
const ToastCtx = createContext<(text: ReactNode, tone?: Toast['tone']) => void>(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((text: ReactNode, tone: Toast['tone'] = 'success') => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, tone, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 6000);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast tone-${t.tone}`}>
            {t.text}
            <button className="toast-close" aria-label="Cerrar" onClick={() => setToasts((all) => all.filter((x) => x.id !== t.id))}>
              ×
            </button>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}
