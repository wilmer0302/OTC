import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { newIdempotencyKey } from '../api/client';
import { notifyChange } from '../lib/hooks';
import { Button } from './Button';
import { ErrorNotice } from './Feedback';
import { Checkbox, Field, Input, Textarea } from './Form';
import { KeyValue } from './Layout';

export function Modal({ title, onClose, children, footer, wide }: { title: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const first = ref.current?.querySelector<HTMLElement>('input, textarea, select, button.btn-primary, button');
    first?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      prev?.focus();
    };
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? 'is-wide' : ''}`} role="dialog" aria-modal="true" aria-label={typeof title === 'string' ? title : undefined} ref={ref}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button className="icon-btn" aria-label="Cerrar" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

export interface ConfirmValues {
  reason: string;
  mfaCode?: string;
  idempotencyKey: string;
  /** Valores de los campos adicionales, ya recortados. */
  fields: Record<string, string>;
}

export interface ConfirmField {
  name: string;
  label: string;
  placeholder?: string;
  hint?: string;
  optional?: boolean;
  mono?: boolean;
  /** Devuelve el error a mostrar, o null si el valor sirve. Es una ayuda: el servidor valida de nuevo. */
  validate?: (v: string) => string | null;
}

export interface ConfirmConfig {
  title: string;
  /** Qué va a pasar, en una o dos frases. */
  intro?: ReactNode;
  /** Datos clave que la persona debe revisar antes de confirmar. */
  summary?: [ReactNode, ReactNode][];
  danger?: boolean;
  confirmLabel: string;
  /** Pide un motivo o nota escrita (queda en la auditoría). */
  reason?: { label: string; placeholder?: string; optional?: boolean; minLength?: number };
  /** Pide de nuevo el código del segundo factor (el servidor lo exige en aprobaciones y configuración). */
  stepUp?: boolean;
  /** Casilla de verificación explícita para operaciones con dinero o irreversibles. */
  acknowledge?: string;
  extra?: ReactNode;
  /** Campos que la operación necesita (referencia, hash, monto…), antes del motivo. */
  fields?: ConfirmField[];
  onConfirm: (v: ConfirmValues) => Promise<unknown>;
}

/**
 * Confirmación explícita de una operación sensible: resume lo que se hará, pide motivo, código del
 * segundo factor o una casilla según el caso, y conserva la misma clave de idempotencia en los
 * reintentos para que un doble clic o una reconexión no repitan la operación.
 */
export function ConfirmDialog({ config, onClose, onDone }: { config: ConfirmConfig; onClose: () => void; onDone?: (result: unknown) => void }) {
  const key = useMemo(newIdempotencyKey, [config]);
  const [reason, setReason] = useState('');
  const [code, setCode] = useState('');
  const [ack, setAck] = useState(false);
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const min = config.reason?.minLength ?? 3;
  const reasonOk = !config.reason || (config.reason.optional && !reason.trim()) || reason.trim().length >= min;
  const codeOk = !config.stepUp || /^\d{6}$/.test(code);
  const fieldErrors = Object.fromEntries(
    (config.fields ?? []).map((f) => {
      const v = (values[f.name] ?? '').trim();
      if (!v) return [f.name, f.optional ? null : 'Obligatorio'];
      return [f.name, f.validate ? f.validate(v) : null];
    }),
  );
  const fieldsOk = Object.values(fieldErrors).every((e) => !e);
  const ready = reasonOk && codeOk && fieldsOk && (!config.acknowledge || ack);

  const submit = async () => {
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    try {
      const trimmed = Object.fromEntries(Object.entries(values).map(([k, v]) => [k, v.trim()]));
      const result = await config.onConfirm({ reason: reason.trim(), mfaCode: config.stepUp ? code : undefined, idempotencyKey: key, fields: trimmed });
      notifyChange();
      onDone?.(result);
      onClose();
    } catch (e) {
      setError(e);
      setCode(''); // cada código sirve una sola vez
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={config.title}
      onClose={busy ? () => {} : onClose}
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            Volver
          </Button>
          <Button variant={config.danger ? 'danger' : 'primary'} onClick={submit} disabled={!ready} busy={busy}>
            {config.confirmLabel}
          </Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        {config.intro && <p className="confirm-intro">{config.intro}</p>}
        {config.summary && config.summary.length > 0 && (
          <div className="confirm-summary">
            <KeyValue items={config.summary} />
          </div>
        )}
        {config.extra}
        {config.fields?.map((f) => {
          const v = values[f.name] ?? '';
          return (
            <Field key={f.name} label={f.label} required={!f.optional} hint={f.hint} error={v.trim() ? fieldErrors[f.name] : null}>
              {(id) => (
                <Input
                  id={id}
                  value={v}
                  placeholder={f.placeholder}
                  className={`input ${f.mono ? 'mono' : ''}`}
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(e) => setValues((all) => ({ ...all, [f.name]: e.target.value }))}
                />
              )}
            </Field>
          );
        })}
        {config.reason && (
          <Field label={config.reason.label} required={!config.reason.optional} hint={config.reason.optional ? 'Opcional. Queda en la auditoría.' : `Mínimo ${min} caracteres. Queda en la auditoría.`}>
            {(id) => <Textarea id={id} value={reason} placeholder={config.reason!.placeholder} onChange={(e) => setReason(e.target.value)} maxLength={500} />}
          </Field>
        )}
        {config.stepUp && (
          <Field label="Código del segundo factor" required hint="Los 6 dígitos de tu aplicación de autenticación. Cada código sirve una sola vez.">
            {(id) => (
              <Input
                id={id}
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="\d{6}"
                maxLength={6}
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                className="input code-input"
              />
            )}
          </Field>
        )}
        {config.acknowledge && <Checkbox label={config.acknowledge} checked={ack} onChange={setAck} />}
        <ErrorNotice error={error} />
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

/** Abre confirmaciones desde cualquier pantalla: `confirm({...})` y renderizar `dialog`. */
export function useConfirm(onDone?: (result: unknown) => void) {
  const [config, setConfig] = useState<ConfirmConfig | null>(null);
  const dialog = config ? <ConfirmDialog config={config} onClose={() => setConfig(null)} onDone={onDone} /> : null;
  return { confirm: setConfig, dialog };
}
