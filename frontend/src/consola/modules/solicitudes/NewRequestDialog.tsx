import { useMemo, useState } from 'react';
import { newIdempotencyKey } from '../../api/client';
import { counterparties, requests } from '../../api/endpoints';
import type { CounterpartyDetail, CounterpartyRow, Network, RequestDetail, Side } from '../../api/types';
import { isDemo, useSession } from '../../app/session';
import { usdt } from '../../lib/format';
import { notifyChange, useQuery } from '../../lib/hooks';
import { KYC_STATUS, NETWORK } from '../../lib/labels';
import { Button } from '../../ui/Button';
import { ErrorNotice } from '../../ui/Feedback';
import { Field, Input, parseAmountInput, Select } from '../../ui/Form';
import { Notice } from '../../ui/Layout';
import { Modal } from '../../ui/Modal';

/**
 * Registro de una solicitud del cliente. El servidor la valida (KYC, destino aprobado, límites y
 * liquidez) y la deja Validada o Rechazada con los motivos; aquí solo se arma el pedido.
 */
export function NewRequestDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (r: RequestDetail) => void }) {
  const { system } = useSession();
  const key = useMemo(newIdempotencyKey, []);
  const clients = useQuery<CounterpartyRow[]>(() => counterparties.list(), []);
  const [cpId, setCpId] = useState('');
  const [side, setSide] = useState<Side>('SELL');
  const [network, setNetwork] = useState<Network>('BSC');
  const [raw, setRaw] = useState('');
  const [destId, setDestId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const detail = useQuery<CounterpartyDetail>(cpId ? () => counterparties.get(cpId) : null, [cpId]);

  const amount = raw ? parseAmountInput(raw, 6) : null;
  // Destino donde el cliente recibe: USDT en la red elegida si la mesa vende; pesos en banco si compra.
  const rail = side === 'SELL' ? network : 'BANK';
  const dests = (detail.data?.destinations ?? []).filter((d) => d.status === 'APROBADO' && d.rail === rail);
  const cp = clients.data?.find((c) => c.id === cpId);

  const submit = async () => {
    if (!cpId || !amount?.value) return;
    setBusy(true);
    setError(null);
    try {
      const r = await requests.create({ counterpartyId: cpId, side, usdtAmount: amount.value, network, destinationId: destId || dests[0]?.id || null }, { idempotencyKey: key });
      notifyChange();
      onCreated(r);
      onClose();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Nueva solicitud OTC"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancelar</Button>
          <Button variant="primary" onClick={submit} busy={busy} disabled={!cpId || !amount?.value}>
            Registrar solicitud
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
        {isDemo(system) && <Notice tone="warning">Modo demostración: los clientes son ficticios y ningún fondo real se mueve.</Notice>}
        <Field label="Cliente" required>
          {(id) => (
            <Select
              id={id}
              value={cpId}
              onChange={(e) => {
                setCpId(e.target.value);
                setDestId('');
              }}
              placeholder={clients.data ? 'Elige un cliente' : 'Cargando…'}
              options={(clients.data ?? []).map((c) => ({ value: c.id, label: `${c.legal_name} · ${c.document_type} ${c.document_number}` }))}
            />
          )}
        </Field>
        {cp && cp.kyc_status !== 'APROBADO' && (
          <Notice tone="danger" title={KYC_STATUS[cp.kyc_status].label}>
            Sin KYC aprobado la solicitud quedará rechazada.
          </Notice>
        )}
        <div className="field">
          <label>Operación</label>
          <div className="segmented" role="group" aria-label="Operación">
            <button type="button" aria-pressed={side === 'SELL'} onClick={() => setSide('SELL')}>
              Cliente compra USDT
            </button>
            <button type="button" aria-pressed={side === 'BUY'} onClick={() => setSide('BUY')}>
              Cliente vende USDT
            </button>
          </div>
          <span className="field-hint">
            {side === 'SELL' ? 'La mesa vende USDT: el cliente paga pesos y recibe USDT.' : 'La mesa compra USDT: el cliente envía USDT y recibe pesos.'}
          </span>
        </div>
        <div className="form-row">
          <Field label="Monto en USDT" required error={raw && amount?.error ? amount.error : null} hint={amount?.value ? usdt(amount.value) : 'Hasta 6 decimales'}>
            {(id) => <Input id={id} inputMode="decimal" value={raw} onChange={(e) => setRaw(e.target.value)} placeholder="1000" />}
          </Field>
          <Field label="Red" required>
            {(id) => (
              <Select
                id={id}
                value={network}
                onChange={(e) => {
                  setNetwork(e.target.value as Network);
                  setDestId('');
                }}
                options={[
                  { value: 'BSC', label: NETWORK.BSC },
                  { value: 'TRON', label: NETWORK.TRON },
                ]}
              />
            )}
          </Field>
        </div>
        {cpId && (
          <Field
            label={side === 'SELL' ? `Billetera ${NETWORK[network]} del cliente` : 'Cuenta bancaria del cliente'}
            hint={dests.length ? 'Solo destinos aprobados por Cumplimiento.' : undefined}
            error={detail.data && !dests.length ? 'El cliente no tiene un destino aprobado para esta operación: la solicitud quedará rechazada.' : null}
          >
            {(id) => (
              <Select
                id={id}
                value={destId || dests[0]?.id || ''}
                onChange={(e) => setDestId(e.target.value)}
                disabled={!dests.length}
                options={dests.map((d) => ({ value: d.id, label: `${d.label} · ${d.bank_name ? `${d.bank_name} ` : ''}${d.value}` }))}
              />
            )}
          </Field>
        )}
        <ErrorNotice error={error} />
      </form>
    </Modal>
  );
}
