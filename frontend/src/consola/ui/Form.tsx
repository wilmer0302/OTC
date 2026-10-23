import { useId, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';

export function Field({ label, hint, error, children, required }: { label: ReactNode; hint?: ReactNode; error?: string | null; children: (id: string) => ReactNode; required?: boolean }) {
  const id = useId();
  return (
    <div className={`field ${error ? 'has-error' : ''}`}>
      <label htmlFor={id}>
        {label}
        {required && <span className="req" aria-hidden> *</span>}
      </label>
      {children(id)}
      {error ? (
        <span className="field-error" role="alert">
          {error}
        </span>
      ) : (
        hint && <span className="field-hint">{hint}</span>
      )}
    </div>
  );
}

export const Input = (p: InputHTMLAttributes<HTMLInputElement>) => <input className="input" {...p} />;
export const Textarea = (p: TextareaHTMLAttributes<HTMLTextAreaElement>) => <textarea className="input" rows={3} {...p} />;

export function Select({ options, placeholder, ...p }: SelectHTMLAttributes<HTMLSelectElement> & { options: { value: string; label: string }[]; placeholder?: string }) {
  return (
    <select className="input" {...p}>
      {placeholder !== undefined && <option value="">{placeholder}</option>}
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

export function Checkbox({ label, checked, onChange }: { label: ReactNode; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="checkbox">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  );
}

/** Barra de filtros: búsqueda y selectores sobre una tabla. */
export function FilterBar({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className="filter-bar">
      <div className="filter-items">{children}</div>
      {right && <div className="filter-right">{right}</div>}
    </div>
  );
}

export function SearchInput({ value, onChange, placeholder = 'Buscar…', label = 'Buscar' }: { value: string; onChange: (v: string) => void; placeholder?: string; label?: string }) {
  return (
    <label className="filter-select filter-search">
      <span>{label}</span>
      <input type="search" className="input search" placeholder={placeholder} value={value} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}

export function FilterSelect({ label, value, onChange, options, allLabel = 'Todos' }: { label: string; value: string; onChange: (v: string) => void; options: { value: string; label: string }[]; allLabel?: string }) {
  return (
    <label className="filter-select">
      <span>{label}</span>
      <Select value={value} onChange={(e) => onChange(e.target.value)} options={options} placeholder={allLabel} />
    </label>
  );
}

// Validaciones de forma para avisar antes de enviar. El servidor vuelve a validar todo.
export const isDecimal = (v: string, maxDecimals: number) => new RegExp(`^\\d{1,18}(\\.\\d{1,${maxDecimals}})?$`).test(v.trim());
export const isPositiveDecimal = (v: string, maxDecimals: number) => isDecimal(v, maxDecimals) && /[1-9]/.test(v);
/**
 * Lee un monto escrito a mano. Acepta coma decimal (1500,25) o punto decimal (1500.25); un punto
 * con forma de separador de miles (1.500) es ambiguo y se rechaza para no confundir 1.500 con 1,5.
 */
export function parseAmountInput(raw: string, maxDecimals: number): { value?: string; error?: string } {
  const v = raw.trim().replace(/\s/g, '');
  if (!v) return { error: 'Escribe el monto' };
  let n = v;
  if (v.includes(',')) {
    if (!/^\d{1,3}(\.\d{3})*(,\d+)?$|^\d+(,\d+)?$/.test(v)) return { error: 'Formato no válido' };
    n = v.replace(/\./g, '').replace(',', '.');
  } else if (/^\d{1,3}(\.\d{3})+$/.test(v)) {
    return { error: 'Escribe el monto sin separador de miles (por ejemplo 1500 o 1500,25)' };
  }
  if (!/^\d+(\.\d+)?$/.test(n)) return { error: 'Solo números, sin signos' };
  const [, frac = ''] = n.split('.');
  if (frac.length > maxDecimals) return { error: maxDecimals === 0 ? 'Sin decimales' : `Máximo ${maxDecimals} decimales` };
  if (!/[1-9]/.test(n)) return { error: 'Debe ser mayor que cero' };
  return { value: n.replace(/^0+(?=\d)/, '') };
}
