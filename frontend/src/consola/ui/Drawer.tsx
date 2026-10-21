import { useEffect, type ReactNode } from 'react';

/** Panel lateral de detalle; en pantallas angostas ocupa toda la pantalla. */
export function Drawer({ title, onClose, children, actions }: { title: ReactNode; onClose: () => void; children: ReactNode; actions?: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !document.querySelector('.modal') && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <aside className="drawer" aria-label={typeof title === 'string' ? title : 'Detalle'}>
      <div className="drawer-head">
        <h2>{title}</h2>
        <div className="drawer-actions">
          {actions}
          <button className="icon-btn" aria-label="Cerrar detalle" onClick={onClose}>
            ×
          </button>
        </div>
      </div>
      <div className="drawer-body">{children}</div>
    </aside>
  );
}
