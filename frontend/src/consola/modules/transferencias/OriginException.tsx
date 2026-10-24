import { transfers } from '../../api/endpoints';
import type { OriginException, TransferRow } from '../../api/types';
import { DemoTag } from '../../app/DemoTag';
import { href } from '../../app/router';
import { useCan, useSession } from '../../app/session';
import { dateTime } from '../../lib/format';
import { notifyChange, useQuery } from '../../lib/hooks';
import { NETWORK, ORIGIN_EXCEPTION_STATUS } from '../../lib/labels';
import { StatusBadge } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { CopyValue } from '../../ui/Copy';
import { useToast } from '../../ui/Feedback';
import { Notice } from '../../ui/Layout';
import { useConfirm } from '../../ui/Modal';

type T = Pick<TransferRow, 'id' | 'number' | 'purpose' | 'rail' | 'status'>;

/**
 * Excepción de origen de un depósito de USDT en revisión. Quien opera la solicita con motivo; otra
 * persona de Cumplimiento la autoriza o la niega. La excepción no abona nada: solo permite que la
 * revisión se resuelva como confirmada, y el servidor vuelve a exigir la evidencia de la red.
 */
export function OriginExceptionPanel({ t, onChange }: { t: T; onChange: () => void }) {
  const can = useCan();
  const { me } = useSession();
  const toast = useToast();
  const applies = t.purpose === 'COBRO' && t.rail !== 'BANK';
  const list = useQuery<OriginException[]>(applies ? () => transfers.originExceptions(t.id) : null, [t.id, t.status]);
  const done = () => {
    list.reload();
    notifyChange();
    onChange();
  };
  const { confirm, dialog } = useConfirm(done);
  if (!applies) return null;

  const items = list.data ?? [];
  const live = items.find((e) => e.status === 'SOLICITADA' || e.status === 'APROBADA');

  const request = () =>
    confirm({
      title: `Solicitar excepción de origen · cobro #${t.number}`,
      intro:
        'Úsala solo si el depósito fue a revisión porque salió de una billetera que no está aprobada para el cliente. La dirección de origen se toma de lo que informó la red, no de este formulario. Otra persona de Cumplimiento debe autorizarla.',
      reason: { label: 'Por qué debe abonarse este depósito (mínimo 10 caracteres)' },
      confirmLabel: 'Solicitar excepción',
      onConfirm: async ({ reason, idempotencyKey }) => {
        await transfers.requestOriginException(t.id, reason, { idempotencyKey });
        toast('Excepción solicitada: espera la decisión de Cumplimiento');
      },
    });
  const decide = (e: OriginException, approve: boolean) =>
    confirm({
      title: `${approve ? 'Autorizar' : 'Negar'} excepción de origen`,
      intro: approve
        ? 'Autoriza abonar solo este depósito desde esa dirección. No aprueba la billetera para depósitos futuros. Después, un administrador resuelve la revisión.'
        : 'El depósito sigue en revisión y no se abona desde ese origen.',
      summary: [
        ['Transferencia', `#${e.transfer_number}`],
        ['Red', NETWORK[e.network]],
        ['Origen informado por la red', <span className="mono" key="f">{e.from_address}</span>],
        ['Solicitó', `${e.requested_by_name} · ${dateTime(e.requested_at)}`],
        ['Motivo', e.reason],
      ],
      reason: { label: 'Nota de la decisión' },
      stepUp: true,
      danger: !approve,
      acknowledge: approve ? 'Verifiqué el origen del depósito y que corresponde al cliente.' : undefined,
      confirmLabel: approve ? 'Autorizar excepción' : 'Negar excepción',
      onConfirm: async ({ reason, mfaCode, idempotencyKey }) => {
        await transfers.decideOriginException(e.id, approve, reason, { idempotencyKey, mfaCode });
        toast(`Excepción ${approve ? 'autorizada' : 'negada'}`);
      },
    });

  const canRequest = t.status === 'EN_REVISION' && !live && can('origin.exception.request');
  if (!items.length && !canRequest) return null;

  return (
    <div className="action-panel" key="origin">
      <h4>
        Excepción de origen <DemoTag />
      </h4>
      {items.map((e) => (
        <div key={e.id} className="block-gap">
          <div className="dest-head">
            <span>
              {NETWORK[e.network]} · <CopyValue value={e.from_address} />
            </span>
            <StatusBadge map={ORIGIN_EXCEPTION_STATUS} status={e.status} />
          </div>
          <div className="muted small">
            Solicitó {e.requested_by_name}, {dateTime(e.requested_at)}: {e.reason}
          </div>
          {e.decided_by_name && (
            <div className="muted small">
              {e.status === 'APROBADA' ? 'Autorizó' : 'Negó'} {e.decided_by_name}: {e.decision_note}
            </div>
          )}
          {e.status === 'SOLICITADA' && can('origin.exception.decide') && (
            <div className="action-row">
              {e.requested_by === me.user.id ? (
                <span className="muted small">La autoriza otra persona</span>
              ) : (
                <>
                  <Button size="sm" variant="primary" onClick={() => decide(e, true)}>Autorizar</Button>
                  <Button size="sm" onClick={() => decide(e, false)}>Negar</Button>
                </>
              )}
            </div>
          )}
        </div>
      ))}
      {canRequest && (
        <>
          <p>Si el depósito fue a revisión porque llegó desde una billetera no aprobada, se puede pedir una excepción solo para este depósito.</p>
          <Button onClick={request}>Solicitar excepción de origen</Button>
        </>
      )}
      {dialog}
    </div>
  );
}

/** Aviso para Cumplimiento con las excepciones de origen que esperan su decisión. */
export function PendingOriginExceptions() {
  const can = useCan();
  const list = useQuery<OriginException[]>(can('origin.exception.decide') ? () => transfers.pendingOriginExceptions() : null, [], { refreshMs: 15000 });
  if (!list.data?.length) return null;
  return (
    <Notice tone="warning" title={`${list.data.length} excepción(es) de origen por autorizar`}>
      {list.data.map((e, i) => (
        <span key={e.id}>
          {i > 0 && ' · '}
          <a href={href(`transferencias/${e.transfer_id}`)}>Cobro #{e.transfer_number}</a>
        </span>
      ))}
    </Notice>
  );
}
