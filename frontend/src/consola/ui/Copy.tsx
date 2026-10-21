import { useState } from 'react';
import { shortId } from '../lib/format';

/** Valor largo (hash, dirección, referencia) abreviado, con el valor completo al pasar el cursor y botón para copiar. */
export function CopyValue({ value, short = true }: { value: string | null | undefined; short?: boolean }) {
  const [done, setDone] = useState(false);
  if (!value) return <span className="muted">—</span>;
  return (
    <span className="copy-value">
      <code title={value}>{short ? shortId(value) : value}</code>
      <button
        type="button"
        className="icon-btn small"
        aria-label="Copiar"
        title="Copiar"
        onClick={(e) => {
          e.stopPropagation();
          navigator.clipboard?.writeText(value).then(() => {
            setDone(true);
            setTimeout(() => setDone(false), 1500);
          });
        }}
      >
        {done ? '✓' : '⧉'}
      </button>
    </span>
  );
}
