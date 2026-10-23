import { useState } from 'react';
import { counterparties, limits } from '../../api/endpoints';
import type { CounterpartyRow, LimitChange, Limits } from '../../api/types';
import { useCan, useSession } from '../../app/session';
import { cop, dateTime, usdt } from '../../lib/format';
import { notifyChange, useQuery } from '../../lib/hooks';
import { LIMIT_KIND, POLICY, PROPOSAL_STATUS } from '../../lib/labels';
import { StatusBadge } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { DataTable, type Column } from '../../ui/DataTable';
import { ErrorNotice, useToast } from '../../ui/Feedback';
import { Field, FilterBar, FilterSelect, Input, parseAmountInput, Select } from '../../ui/Form';
import { FormModal } from '../../ui/FormModal';
import { Card, KeyValue, Loading } from '../../ui/Layout';
import { useConfirm } from '../../ui/Modal';

const PER_CLIENT = ['ORDER_MAX_USDT', 'CLIENT_DAILY_USDT'];

function valueText(kind: string, v: Record<string, string>): string {
  if (kind === 'APPROVAL_POLICY') return v.policy === 'THRESHOLD' ? `${POLICY.THRESHOLD}: ${cop(v.thresholdCop)}` : POLICY[v.policy] ?? v.policy;
  return kind === 'OPEN_EXPOSURE_COP' ? cop(v.amount) : usdt(v.amount);
}

export function Limites({ onChange }: { onChange: () => void }) {
  const can = useCan();
  const { me } = useSession();
  const toast = useToast();
  const [status, setStatus] = useState('');
  const eff = useQuery<Limits>(() => limits.effective(), []);
  const changes = useQuery<LimitChange[]>(() => limits.changes(status || undefined), [status]);
  const clients = useQuery<CounterpartyRow[]>(() => counterparties.list(), []);
  const [proposing, setProposing] = useState(false);
  const reload = () => {
    changes.reload();
    eff.reload();
    onChange();
  };
  const { confirm, dialog } = useConfirm(reload);
  const clientName = (id: string | null) => (id ? clients.data?.find((c) => c.id === id)?.legal_name ?? 'Cliente' : 'Toda la mesa');

  const decide = (c: LimitChange, approve: boolean) =>
    confirm({
      title: `${approve ? 'Aprobar' : 'Rechazar'} cambio de límite`,
      intro: approve ? 'Es la segunda firma: el límite nuevo rige de inmediato para operaciones nuevas.' : 'El límite actual se mantiene.',
      summary: [
        ['Límite', LIMIT_KIND[c.kind] ?? c.kind],
        ['Aplica a', clientName(c.counterparty_id)],
        ['Valor nuevo', <strong key="v">{valueText(c.kind, c.value)}</strong>],
        ['Motivo', c.reason],
        ['Propuesto por', c.proposed_by_name],
      ],
      reason: { label: 'Nota de la decisión', minLength: 3 },
      stepUp: true,
      danger: !approve,
      acknowledge: approve ? 'Revisé el valor y su efecto sobre la operación.' : undefined,
      confirmLabel: approve ? 'Aprobar límite' : 'Rechazar',
      onConfirm: async ({ reason, mfaCode, idempotencyKey }) => {
        await limits.decide(c.id, approve, reason, { idempotencyKey, mfaCode });
        toast(approve ? 'Límite vigente' : 'Propuesta rechazada');
        notifyChange();
      },
    });

  const columns: Column<LimitChange>[] = [
    { key: 'k', header: 'Límite', render: (c) => <><span className="cell-main">{LIMIT_KIND[c.kind] ?? c.kind}</span><span className="cell-sub">{clientName(c.counterparty_id)}</span></> },
    { key: 'v', header: 'Valor', align: 'right', render: (c) => valueText(c.kind, c.value) },
    { key: 's', header: 'Estado', render: (c) => <StatusBadge map={PROPOSAL_STATUS} status={c.status} /> },
    { key: 'p', header: 'Propuso', secondary: true, render: (c) => <>{c.proposed_by_name}<span className="cell-sub">{dateTime(c.proposed_at)} · {c.reason}</span></> },
    { key: 'd', header: 'Decidió', secondary: true, render: (c) => (c.decided_by_name ? <>{c.decided_by_name}<span className="cell-sub">{c.decision_note}</span></> : <span className="muted">—</span>) },
    {
      key: 'x',
      header: '',
      render: (c) =>
        c.status === 'PROPUESTO' && can('limits.approve') ? (
          c.proposed_by === me.user.id ? (
            <span className="muted small">Lo aprueba otro administrador</span>
          ) : (
            <span className="action-row">
              <Button size="sm" variant="primary" onClick={() => decide(c, true)}>Aprobar</Button>
              <Button size="sm" onClick={() => decide(c, false)}>Rechazar</Button>
            </span>
          )
        ) : null,
    },
  ];

  return (
    <>
      <Card title="Límites vigentes de la mesa" actions={can('limits.propose') && <Button variant="primary" onClick={() => setProposing(true)}>Proponer cambio</Button>}>
        {eff.error ? (
          <ErrorNotice error={eff.error} />
        ) : !eff.data ? (
          <Loading />
        ) : (
          <KeyValue
            columns={2}
            items={[
              [LIMIT_KIND.ORDER_MAX_USDT, usdt(eff.data.orderMaxUsdt)],
              [LIMIT_KIND.CLIENT_DAILY_USDT, usdt(eff.data.clientDailyUsdt)],
              [LIMIT_KIND.DESK_DAILY_USDT, usdt(eff.data.deskDailyUsdt)],
              [LIMIT_KIND.OPEN_EXPOSURE_USDT, usdt(eff.data.openExposureUsdt)],
              [LIMIT_KIND.OPEN_EXPOSURE_COP, cop(eff.data.openExposureCop)],
              [LIMIT_KIND.APPROVAL_POLICY, eff.data.approval.policy === 'THRESHOLD' ? `${POLICY.THRESHOLD}: ${cop(eff.data.approval.thresholdCop)}` : POLICY[eff.data.approval.policy]],
            ]}
          />
        )}
        <p className="muted small block-gap">Todo cambio necesita dos administradores: uno lo propone y otro lo aprueba. Los límites por cliente se ven en la ficha de cada cliente.</p>
      </Card>
      <Card flush title="Cambios de límites">
        <div className="card-section">
          <FilterBar right={<Button size="sm" onClick={changes.reload} busy={changes.loading}>Actualizar</Button>}>
            <FilterSelect label="Estado" value={status} onChange={setStatus} options={Object.entries(PROPOSAL_STATUS).filter(([k]) => k !== 'APROBADO').map(([value, x]) => ({ value, label: x.label }))} />
          </FilterBar>
        </div>
        <DataTable columns={columns} rows={changes.data} rowKey={(c) => c.id} loading={changes.loading} error={changes.error} empty={{ title: 'No hay cambios con este filtro' }} />
      </Card>
      {proposing && <ProposeDialog clients={clients.data ?? []} onClose={() => setProposing(false)} onDone={reload} />}
      {dialog}
    </>
  );
}

function ProposeDialog({ clients, onClose, onDone }: { clients: CounterpartyRow[]; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [kind, setKind] = useState('ORDER_MAX_USDT');
  const [client, setClient] = useState('');
  const [amount, setAmount] = useState('');
  const [policy, setPolicy] = useState('THRESHOLD');
  const [threshold, setThreshold] = useState('');
  const [reason, setReason] = useState('');
  const isPolicy = kind === 'APPROVAL_POLICY';
  const isCop = kind === 'OPEN_EXPOSURE_COP';
  const amt = amount ? parseAmountInput(amount, isCop ? 0 : 6) : null;
  const thr = threshold ? parseAmountInput(threshold, 0) : null;
  const value: Record<string, string> | null = isPolicy
    ? policy === 'THRESHOLD'
      ? thr?.value ? { policy, thresholdCop: thr.value } : null
      : { policy }
    : amt?.value && Number(amt.value) > 0 ? { amount: amt.value } : null;
  return (
    <FormModal
      title="Proponer cambio de límite"
      submitLabel="Proponer"
      stepUp
      canSubmit={!!value && reason.trim().length >= 3}
      onClose={onClose}
      onSubmit={async (o) => {
        await limits.propose({ kind, counterpartyId: client || null, value, reason: reason.trim() }, o);
        toast('Cambio propuesto: espera la aprobación de otro administrador');
        onDone();
      }}
    >
      <p className="confirm-intro">El cambio no rige hasta que otro administrador lo apruebe.</p>
      <div className="form-row">
        <Field label="Límite" required>
          {(id) => <Select id={id} value={kind} onChange={(e) => { setKind(e.target.value); if (!PER_CLIENT.includes(e.target.value)) setClient(''); }} options={Object.entries(LIMIT_KIND).map(([value, label]) => ({ value, label }))} />}
        </Field>
        <Field label="Aplica a" hint={PER_CLIENT.includes(kind) ? 'Vacío = toda la mesa' : 'Este límite es de la mesa'}>
          {(id) => <Select id={id} value={client} disabled={!PER_CLIENT.includes(kind)} onChange={(e) => setClient(e.target.value)} placeholder="Toda la mesa" options={clients.map((c) => ({ value: c.id, label: c.legal_name }))} />}
        </Field>
      </div>
      {isPolicy ? (
        <div className="form-row">
          <Field label="Política" required>
            {(id) => <Select id={id} value={policy} onChange={(e) => setPolicy(e.target.value)} options={Object.entries(POLICY).map(([value, label]) => ({ value, label }))} />}
          </Field>
          {policy === 'THRESHOLD' && (
            <Field label="Umbral (COP)" required hint="Entregas por encima piden una segunda aprobación" error={thr?.error}>
              {(id) => <Input id={id} inputMode="numeric" value={threshold} onChange={(e) => setThreshold(e.target.value)} />}
            </Field>
          )}
        </div>
      ) : (
        <Field label={`Valor nuevo (${isCop ? 'COP' : 'USDT'})`} required error={amt?.error}>
          {(id) => <Input id={id} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />}
        </Field>
      )}
      <Field label="Motivo" required>
        {(id) => <Input id={id} value={reason} onChange={(e) => setReason(e.target.value)} />}
      </Field>
    </FormModal>
  );
}
