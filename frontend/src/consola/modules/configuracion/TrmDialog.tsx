import { useMemo, useState } from 'react';
import { newIdempotencyKey } from '../../api/client';
import { pricing } from '../../api/endpoints';
import { isDemo, useSession } from '../../app/session';
import { copPrice } from '../../lib/format';
import { notifyChange } from '../../lib/hooks';
import { Button } from '../../ui/Button';
import { ErrorNotice, useToast } from '../../ui/Feedback';
import { Field, Input, parseAmountInput } from '../../ui/Form';
import { Notice } from '../../ui/Layout';
import { Modal } from '../../ui/Modal';

/** Carga manual de la TRM del día. Queda registrada con quién la cargó; al cambiar, las cotizaciones vigentes se revisan en el servidor. */
export function TrmDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { system } = useSession();
  const toast = useToast();
  const key = useMemo(newIdempotencyKey, []);
  const [raw, setRaw] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const parsed = raw ? parseAmountInput(raw, 2) : null;

  const submit = async () => {
    if (!parsed?.value) return;
    setBusy(true);
    setError(null);
    try {
      const r = await pricing.recordTrm(parsed.value, { idempotencyKey: key });
      toast(`TRM de ${r.valid_date} registrada: ${copPrice(r.rate)}`);
      notifyChange();
      onDone();
      onClose();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Cargar TRM de hoy"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancelar</Button>
          <Button variant="primary" onClick={submit} busy={busy} disabled={!parsed?.value}>
            Registrar TRM
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
        <p className="confirm-intro">
          Escribe la TRM oficial del día tal como la publica la Superintendencia Financiera. Las cotizaciones vigentes se retiran si el precio se mueve más
          que el umbral configurado.
        </p>
        {isDemo(system) && <Notice tone="warning">Modo demostración: la TRM quedará marcada como SIMULADA.</Notice>}
        <Field label="TRM (pesos por dólar)" required error={raw && parsed?.error ? parsed.error : null} hint={parsed?.value ? `Se registrará ${copPrice(parsed.value)}` : 'Ejemplo: 3950,25'}>
          {(id) => <Input id={id} inputMode="decimal" value={raw} onChange={(e) => setRaw(e.target.value)} autoFocus />}
        </Field>
        <ErrorNotice error={error} />
      </form>
    </Modal>
  );
}
