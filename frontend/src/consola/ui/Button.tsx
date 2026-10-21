import type { ButtonHTMLAttributes, ReactNode } from 'react';

type Variant = 'primary' | 'secondary' | 'danger' | 'ghost';

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: 'sm' | 'md';
  busy?: boolean;
  icon?: ReactNode;
}

export function Button({ variant = 'secondary', size = 'md', busy, icon, children, className = '', disabled, type = 'button', ...rest }: Props) {
  return (
    <button
      type={type}
      className={`btn btn-${variant} btn-${size} ${busy ? 'is-busy' : ''} ${className}`}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      {...rest}
    >
      {busy ? <span className="spinner" aria-hidden /> : icon}
      {children}
    </button>
  );
}

export function LinkButton({ href, children, variant = 'secondary', size = 'md' }: { href: string; children: ReactNode; variant?: Variant; size?: 'sm' | 'md' }) {
  return (
    <a className={`btn btn-${variant} btn-${size}`} href={href}>
      {children}
    </a>
  );
}
