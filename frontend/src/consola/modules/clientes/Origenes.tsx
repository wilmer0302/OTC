import { useState, type ReactNode } from 'react';
import { counterparties } from '../../api/endpoints';
import type { CounterpartyDetail, OriginAddress } from '../../api/types';
import { DemoTag } from '../../app/DemoTag';
import { href } from '../../app/router';
import { useCan, useSession } from '../../app/session';
import { dateTime } from '../../lib/format';
import { notifyChange, useQuery } from '../../lib/hooks';
import { NETWORK, ORIGIN_STATUS } from '../../lib/labels';
import { destinationError, destinationHint } from '../../lib/refs';
import { StatusBadge } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { CopyValue } from '../../ui/Copy';
import { DataTable, type Column } from '../../ui/DataTable';
import { useToast } from '../../ui/Feedback';
import { Field, Input, Select } from '../../ui/Form';
import { FormModal } from '../../ui/FormModal';
import { Card, EmptyState, Notice } from '../../ui/Layout';
import { useConfirm } from '../../ui/Modal';

// Billeteras de origen: desde dónde puede enviar USDT cada cliente. Un depósito solo se abona si
// llega desde una dirección APROBADA por Cumplimiento en esa misma red; el resto va a revisión.
// Toda regla se valida de nuevo en el servidor; aquí solo se guía al usuario.

const LIVE = ['PENDIENTE', 'APROBADA'];

function AddressValue({ value, full }: { value: string; full?: boolean }) {
  return value.includes('•') ? <code title="Enmascarado: tu rol no ve la dirección completa">{value}</code> : <CopyValue value={value} short={!full} />;
}

function originSummary(o: OriginAddress): [string, ReactNode][] {
  return [
    ['Cliente', o.counterparty_name],
    ['Red', NETWORK[o.network]],
    ['Etiqueta', o.label ?? '—'],
    ['Dirección', <span className="mono" key="a">{o.address}</span>],
    ['Propuso', `${o.proposed_by_name} · ${dateTime(o.proposed_at)}`],
  ];
}

/** Acciones de Cumplimiento sobre una billetera de origen: aprobar, rechazar o revocar, con segundo factor y motivo. */
function useOriginActions(onDone: () => void) {
  const toast = useToast();
  const { confirm, dialog } = useConfirm(onDone);
  const decide = (o: OriginAddress, approve: boolean) =>
    confirm({
      title: `${approve ? 'Aprobar' : 'Rechazar'} billetera de origen`,
      intro: approve
        ? 'Desde la aprobación, los depósitos que lleguen desde esta dirección y en esta red se pueden abonar al cliente.'
        : 'La billetera queda rechazada. Un depósito desde ella irá a revisión.',
      summary: originSummary(o),
      reason: { label: 'Nota de la decisión' },
      stepUp: true,
      danger: !approve,
      acknowledge: approve ? 'Verifiqué que la billetera pertenece al cliente y en esta red.' : undefined,
      confirmLabel: approve ? 'Aprobar billetera' : 'Rechazar billetera',
      onConfirm: async ({ reason, mfaCode, idempotencyKey }) => {
        await counterparties.decideOrigin(o.id, approve, reason, { idempotencyKey, mfaCode });
        toast(`Billetera ${approve ? 'aprobada' : 'rechazada'}`);
        notifyChange();
      },
    });
  const revoke = (o: OriginAddress) =>
    confirm({
      title: 'Revocar billetera de origen',
      intro: 'Los depósitos nuevos desde esta dirección irán a revisión. Los ya abonados no cambian.',
      summary: originSummary(o),
      reason: { label: 'Motivo de la revocación' },
      stepUp: true,
      danger: true,
      confirmLabel: 'Revocar billetera',
      onConfirm: async ({ reason, mfaCode, idempotencyKey }) => {
        await counterparties.revokeOrigin(o.id, reason, { idempotencyKey, mfaCode });
        toast('Billetera revocada');
        notifyChange();
      },
    });
  return { decide, revoke, dialog };
}

/** Sección «Billeteras de origen» dentro de la ficha del cliente. */
export function OriginSection({ c, onDone }: { c: CounterpartyDetail; onDone: () => void }) {
  const can = useCan();
  const { me } = useSession();
  const policy = useQuery(() => counterparties.originPolicy(), []);
  const [proposing, setProposing] = useState(false);
  const { decide, revoke, dialog } = useOriginActions(onDone);
  const max = policy.data?.maxNetworksPerClient;
  const liveNetworks = new Set(c.origins.filter((o) => LIVE.includes(o.status)).map((o) => o.network));
  const canPropose = can('origin.propose') && c.kind === 'CLIENTE' && c.kyc_status !== 'BLOQUEADO' && c.kyc_status !== 'RECHAZADO';

  return (
    <>
      <h3>Billeteras de origen <DemoTag /></h3>
      <p className="muted small">
        Un depósito de USDT solo se abona si sale de una de estas direcciones, aprobada y en la misma red. Cualquier otro origen va a revisión.
        {max !== undefined && ` Redes habilitadas: ${liveNetworks.size} de ${max} permitidas.`}
      </p>
      {canPropose && (
        <div className="action-row block-gap">
          <Button size="sm" onClick={() => setProposing(true)}>Registrar billetera de origen</Button>
        </div>
      )}
      {c.origins.length ? (
        <ul className="plain-list dest-list">
          {c.origins.map((o) => (
            <li key={o.id}>
              <div className="dest-head">
                <strong>{o.label ?? 'Sin etiqueta'}</strong>
                <StatusBadge map={ORIGIN_STATUS} status={o.status} />
              </div>
              <div className="cell-sub">{NETWORK[o.network]} · propuso {o.proposed_by_name}, {dateTime(o.proposed_at)}</div>
              <div><AddressValue value={o.address} full /></div>
              {o.decided_by_name && <div className="muted small">{o.status === 'RECHAZADA' ? 'Rechazó' : 'Aprobó'} {o.decided_by_name}: {o.decision_note}</div>}
              {o.revoked_by_name && <div className="muted small">Revocó {o.revoked_by_name}: {o.revoke_reason}</div>}
              <div className="action-row">
                {o.status === 'PENDIENTE' && can('origin.decide') && (o.proposed_by === me.user.id ? (
                  <span className="muted small">Lo aprueba otra persona</span>
                ) : (
                  <>
                    <Button size="sm" variant="primary" onClick={() => decide(o, true)}>Aprobar</Button>
                    <Button size="sm" onClick={() => decide(o, false)}>Rechazar</Button>
                  </>
                ))}
                {o.status === 'APROBADA' && can('origin.decide') && <Button size="sm" variant="danger" onClick={() => revoke(o)}>Revocar</Button>}
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState title="Sin billeteras de origen">Sus depósitos de USDT irán a revisión hasta que Cumplimiento apruebe al menos una billetera.</EmptyState>
      )}
      {proposing && policy.data && (
        <ProposeOriginDialog c={c} networks={policy.data.networks} max={policy.data.maxNetworksPerClient} liveNetworks={liveNetworks} onClose={() => setProposing(false)} onDone={onDone} />
      )}
      {dialog}
    </>
  );
}

function ProposeOriginDialog({ c, networks, max, liveNetworks, onClose, onDone }: { c: CounterpartyDetail; networks: string[]; max: number; liveNetworks: Set<string>; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [f, setF] = useState({ network: networks[0] ?? 'TRON', address: '', label: '' });
  const set = (k: keyof typeof f, v: string) => setF((p) => ({ ...p, [k]: v }));
  const addressError = f.address.trim() ? destinationError(f.network, f.address.trim()) : null;
  const overLimit = !liveNetworks.has(f.network) && liveNetworks.size >= max;
  return (
    <FormModal
      title={`Registrar billetera de origen · ${c.legal_name}`}
      submitLabel="Enviar a Cumplimiento"
      canSubmit={!!f.address.trim() && !addressError && !overLimit}
      onClose={onClose}
      onSubmit={async (o) => {
        await counterparties.proposeOrigin(c.id, { network: f.network, address: f.address.trim(), label: f.label.trim() || null }, o);
        toast('Billetera registrada: espera la aprobación de Cumplimiento');
        onDone();
      }}
    >
      <p className="confirm-intro">La billetera no habilita abonos hasta que Cumplimiento la apruebe. La misma dirección en otra red es otra billetera y se registra aparte.</p>
      {overLimit && <Notice tone="warning" title="Límite de redes alcanzado">El cliente ya tiene billeteras en {max} redes. Solo puede registrar más direcciones en esas redes.</Notice>}
      <div className="form-row">
        <Field label="Red" required>
          {(id) => <Select id={id} value={f.network} onChange={(e) => set('network', e.target.value)} options={networks.map((value) => ({ value, label: NETWORK[value] ?? value }))} />}
        </Field>
        <Field label="Etiqueta" hint="Ej.: Tesorería principal">
          {(id) => <Input id={id} value={f.label} onChange={(e) => set('label', e.target.value)} />}
        </Field>
      </div>
      <Field label="Dirección desde la que envía" required hint={destinationHint(f.network)} error={addressError}>
        {(id) => <Input id={id} className="input mono" value={f.address} onChange={(e) => set('address', e.target.value)} spellCheck={false} autoComplete="off" />}
      </Field>
    </FormModal>
  );
}

/** Bandeja de billeteras de origen que esperan decisión de Cumplimiento. */
export function OriginQueue({ list }: { list: ReturnType<typeof useQuery<OriginAddress[]>> }) {
  const can = useCan();
  const { me } = useSession();
  const { decide, dialog } = useOriginActions(() => list.reload());
  const columns: Column<OriginAddress>[] = [
    { key: 'c', header: 'Cliente', render: (o) => <a href={href(`clientes/${o.counterparty_id}`)}>{o.counterparty_name}</a> },
    { key: 'n', header: 'Billetera', render: (o) => <><span className="cell-main">{o.label ?? 'Sin etiqueta'}</span><span className="cell-sub">{NETWORK[o.network]}</span></> },
    { key: 'a', header: 'Dirección', render: (o) => <AddressValue value={o.address} /> },
    { key: 'p', header: 'Propuso', secondary: true, render: (o) => <>{o.proposed_by_name}<span className="cell-sub">{dateTime(o.proposed_at)}</span></> },
    {
      key: 'x',
      header: '',
      render: (o) =>
        !can('origin.decide') ? null : o.proposed_by === me.user.id ? (
          <span className="muted small">Lo aprueba otra persona</span>
        ) : (
          <span className="action-row">
            <Button size="sm" variant="primary" onClick={() => decide(o, true)}>Aprobar</Button>
            <Button size="sm" onClick={() => decide(o, false)}>Rechazar</Button>
          </span>
        ),
    },
  ];
  return (
    <Card flush title={<>Billeteras de origen por aprobar <DemoTag /></>}>
      <DataTable columns={columns} rows={list.data} rowKey={(o) => o.id} loading={list.loading} error={list.error} empty={{ title: 'No hay billeteras esperando decisión' }} />
      {dialog}
    </Card>
  );
}
