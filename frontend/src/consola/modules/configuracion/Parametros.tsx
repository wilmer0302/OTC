import { useState } from 'react';
import { settings } from '../../api/endpoints';
import type { DeskSettings } from '../../api/types';
import { useCan } from '../../app/session';
import { dateTime, duration } from '../../lib/format';
import { useQuery } from '../../lib/hooks';
import { Button } from '../../ui/Button';
import { ErrorNotice, useToast } from '../../ui/Feedback';
import { Field, Input } from '../../ui/Form';
import { FormModal } from '../../ui/FormModal';
import { Card, KeyValue, Loading } from '../../ui/Layout';

type Key = Exclude<keyof DeskSettings, 'created_at' | 'reason'>;

/** Cada parámetro se edita en la unidad en que se piensa (minutos, segundos…) y se envía en la del servidor. */
const PARAMS: { key: Key; label: string; unit: string; factor: number; min: number; max: number; help: string; show: (v: number) => string }[] = [
  { key: 'quote_ttl_seconds', label: 'Vigencia de una cotización', unit: 'segundos', factor: 1, min: 10, max: 3600, help: 'Tiempo que el cliente tiene para aceptar el precio.', show: duration },
  { key: 'payment_window_seconds', label: 'Plazo de pago del cliente', unit: 'minutos', factor: 60, min: 1, max: 1440, help: 'Desde que acepta; después la orden vence.', show: duration },
  { key: 'request_ttl_seconds', label: 'Vigencia de una solicitud sin cotizar', unit: 'minutos', factor: 60, min: 1, max: 1440, help: 'Después se cancela sola.', show: duration },
  { key: 'price_move_threshold_bps', label: 'Movimiento de precio que invalida cotizaciones', unit: 'puntos básicos (100 = 1 %)', factor: 1, min: 1, max: 10000, help: 'Si la TRM se mueve más que esto, las cotizaciones vigentes se retiran.', show: (v) => `${(v / 100).toLocaleString('es-CO')} %` },
  { key: 'tron_confirmations', label: 'Confirmaciones exigidas en Tron', unit: 'bloques', factor: 1, min: 1, max: 1000, help: 'Antes de dar por recibido un pago en TRC20.', show: (v) => `${v} bloques` },
  { key: 'bsc_confirmations', label: 'Confirmaciones exigidas en BSC', unit: 'bloques', factor: 1, min: 1, max: 1000, help: 'Antes de dar por recibido un pago en BEP20.', show: (v) => `${v} bloques` },
  { key: 'transfer_pending_seconds', label: 'Alerta por transferencia pendiente', unit: 'minutos', factor: 60, min: 1, max: 10080, help: 'Tiempo sin confirmación antes de marcarla para revisión.', show: duration },
  { key: 'transfer_review_seconds', label: 'Tiempo máximo en revisión', unit: 'minutos', factor: 60, min: 1, max: 10080, help: 'Después se escala.', show: duration },
];

export function Parametros() {
  const can = useCan();
  const s = useQuery<DeskSettings>(() => settings.get(), []);
  const [editing, setEditing] = useState(false);
  if (s.loading && !s.data) return <Loading />;
  if (s.error || !s.data) return <ErrorNotice error={s.error} />;
  const d = s.data;
  return (
    <Card title="Parámetros de la mesa" actions={can('settings.manage') && <Button onClick={() => setEditing(true)}>Editar parámetros</Button>}>
      <KeyValue columns={2} items={PARAMS.map((p) => [p.label, <span key={p.key} title={p.help}>{p.show(d[p.key])}</span>])} />
      {d.created_at && (
        <p className="muted small block-gap">
          Versión vigente desde {dateTime(d.created_at)}
          {d.reason ? ` · ${d.reason}` : ''}
        </p>
      )}
      {editing && <EditDialog current={d} onClose={() => setEditing(false)} onDone={s.reload} />}
    </Card>
  );
}

function EditDialog({ current, onClose, onDone }: { current: DeskSettings; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [vals, setVals] = useState<Record<Key, string>>(() => Object.fromEntries(PARAMS.map((p) => [p.key, String(current[p.key] / p.factor)])) as Record<Key, string>);
  const [reason, setReason] = useState('');
  const errors = Object.fromEntries(
    PARAMS.map((p) => {
      const v = vals[p.key].trim();
      const ok = /^\d+$/.test(v) && +v >= p.min && +v <= p.max;
      return [p.key, ok ? null : `Número entero entre ${p.min} y ${p.max}`];
    }),
  ) as Record<Key, string | null>;
  const patch = Object.fromEntries(PARAMS.filter((p) => !errors[p.key] && +vals[p.key] * p.factor !== current[p.key]).map((p) => [p.key, +vals[p.key] * p.factor]));
  const valid = PARAMS.every((p) => !errors[p.key]);
  return (
    <FormModal
      title="Editar parámetros de la mesa"
      submitLabel={`Guardar ${Object.keys(patch).length || ''} cambio${Object.keys(patch).length === 1 ? '' : 's'}`}
      stepUp
      wide
      canSubmit={valid && Object.keys(patch).length > 0 && reason.trim().length >= 3}
      onClose={onClose}
      onSubmit={async (o) => {
        await settings.update({ ...patch, reason: reason.trim() }, o);
        toast('Parámetros actualizados');
        onDone();
      }}
    >
      <p className="confirm-intro">Los cambios rigen para operaciones nuevas. La versión anterior queda guardada.</p>
      <div className="form-row">
        {PARAMS.map((p) => (
          <Field key={p.key} label={`${p.label} (${p.unit})`} hint={p.help} error={errors[p.key]}>
            {(id) => <Input id={id} inputMode="numeric" value={vals[p.key]} onChange={(e) => setVals((x) => ({ ...x, [p.key]: e.target.value }))} />}
          </Field>
        ))}
      </div>
      <Field label="Motivo del cambio" required>
        {(id) => <Input id={id} value={reason} onChange={(e) => setReason(e.target.value)} />}
      </Field>
    </FormModal>
  );
}
