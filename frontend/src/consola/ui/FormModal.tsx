import { useMemo, useState, type ReactNode } from 'react';
import { newIdempotencyKey } from '../api/client';
import { notifyChange } from '../lib/hooks';
import { Button } from './Button';
import { ErrorNotice } from './Feedback';
import { Field, Input } from './Form';
import { Modal } from './Modal';

/**
 * Formulario en ventana para altas y cambios con varios campos. Mantiene una clave de idempotencia
 * por apertura y, si la acción lo exige, pide el código del segundo factor antes de enviar.
 */
export function FormModal({
  title,
  children,
  submitLabel,
  canSubmit,
  stepUp,
  danger,
  wide,
  onSubmit,
  onClose,
}: {
  title: string;
  children: ReactNode;
  submitLabel: string;
  canSubmit: boolean;
  stepUp?: boolean;
  danger?: boolean;
  wide?: boolean;
  onSubmit: (o: { idempotencyKey: string; mfaCode?: string }) => Promise<unknown>;
  onClose: () => void;
}) {
  const key = useMemo(newIdempotencyKey, []);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const ready = canSubmit && (!stepUp || /^\d{6}$/.test(code));

  const submit = async () => {
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit({ idempotencyKey: key, mfaCode: stepUp ? code : undefined });
      notifyChange();
      onClose();
    } catch (e) {
      setError(e);
      setCode('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={title}
      onClose={busy ? () => {} : onClose}
      wide={wide}
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            Cancelar
          </Button>
          <Button variant={danger ? 'danger' : 'primary'} onClick={submit} busy={busy} disabled={!ready}>
            {submitLabel}
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
        {children}
        {stepUp && (
          <Field label="Código del segundo factor" required hint="Esta acción pide de nuevo tu código. Cada código sirve una sola vez.">
            {(id) => (
              <Input id={id} className="input code-input" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} />
            )}
          </Field>
        )}
        <ErrorNotice error={error} />
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}
