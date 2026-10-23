import { useState, type ReactNode } from 'react';
import { counterparties, limits, orders } from '../../api/endpoints';
import type { CounterpartyDetail, CounterpartyRow, Destination, Limits, OrderRow } from '../../api/types';
import { DemoTag } from '../../app/DemoTag';
import { href, navigate, replaceQuery } from '../../app/router';
import { useCan, useSession } from '../../app/session';
import { cop, dateOnly, dateTime, usdt } from '../../lib/format';
import { notifyChange, useDebounced, useQuery } from '../../lib/hooks';
import { DESTINATION_STATUS, KYC_STATUS, NETWORK, ORDER_STATUS, SIDE_SHORT } from '../../lib/labels';
import { destinationError, destinationHint } from '../../lib/refs';
import { Badge, StatusBadge } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { CopyValue } from '../../ui/Copy';
import { DataTable, type Column } from '../../ui/DataTable';
import { Drawer } from '../../ui/Drawer';
import { ErrorNotice, useToast } from '../../ui/Feedback';
import { Field, FilterBar, FilterSelect, Input, SearchInput, Select, Textarea } from '../../ui/Form';
import { FormModal } from '../../ui/FormModal';
import { Card, EmptyState, KeyValue, Loading, Notice, PageHeader, Tabs } from '../../ui/Layout';
import { useConfirm } from '../../ui/Modal';
import type { PageProps } from '../index';

const KIND: Record<string, string> = { CLIENTE: 'Cliente', PROVEEDOR: 'Proveedor de liquidez' };
const PERSON: Record<string, string> = { NATURAL: 'Persona natural', JURIDICA: 'Persona jurídica' };
const DOC: Record<string, string> = { CC: 'Cédula', CE: 'Cédula de extranjería', NIT: 'NIT', PASAPORTE: 'Pasaporte' };
const ACCOUNT_TYPE: Record<string, string> = { AHORROS: 'Ahorros', CORRIENTE: 'Corriente' };
/** Cambios de KYC que el servidor acepta desde cada estado (se valida de nuevo allá). */
const KYC_NEXT: Record<string, string[]> = {
  PENDIENTE: ['APROBADO', 'RECHAZADO', 'BLOQUEADO'],
  APROBADO: ['BLOQUEADO', 'PENDIENTE'],
  RECHAZADO: ['PENDIENTE'],
  BLOQUEADO: ['PENDIENTE', 'APROBADO'],
};

export default function Clientes({ route }: PageProps) {
  const can = useCan();
  const view = route.query.get('vista') === 'destinos' ? 'destinos' : 'clientes';
  const selected = route.path[1] ?? null;
  const kyc = route.query.get('kyc') ?? '';
  const [search, setSearch] = useState(route.query.get('q') ?? '');
  const q = useDebounced(search.trim(), 300);
  const [creating, setCreating] = useState(false);
  const list = useQuery<CounterpartyRow[]>(view === 'clientes' ? () => counterparties.list({ search: q || undefined, kyc: kyc || undefined }) : null, [view, q, kyc]);
  const proposed = useQuery<Destination[]>(() => counterparties.destinations('PROPUESTO'), [view]);
  const query = { kyc, q: q || undefined };

  const columns: Column<CounterpartyRow>[] = [
    { key: 'n', header: 'N.º', width: '70px', render: (c) => <span className="cell-main">#{c.number}</span> },
    { key: 'name', header: 'Nombre o razón social', render: (c) => <><span className="cell-main">{c.legal_name}</span>{c.kind !== 'CLIENTE' && <span className="cell-sub">{KIND[c.kind]}</span>}</> },
    { key: 'doc', header: 'Documento', render: (c) => <span className="mono">{DOC[c.document_type] ?? c.document_type} {c.document_number}</span> },
    { key: 'kyc', header: 'KYC', render: (c) => <StatusBadge map={KYC_STATUS} status={c.kyc_status} /> },
    { key: 'at', header: 'Alta', secondary: true, render: (c) => dateOnly(c.created_at) },
  ];

  return (
    <>
      <PageHeader
        title="Clientes"
        subtitle="Contrapartes, su KYC y la lista blanca de cuentas y billeteras donde reciben. Solo se opera con KYC aprobado y solo se paga a destinos aprobados por Cumplimiento."
        actions={
          can('counterparty.create') && (
            <Button variant="primary" onClick={() => setCreating(true)}>
              Nuevo cliente
            </Button>
          )
        }
      />
      <Tabs
        tabs={[
          { key: 'clientes', label: 'Clientes' },
          { key: 'destinos', label: 'Destinos por aprobar', count: proposed.data?.length ?? 0 },
        ]}
        active={view}
        onChange={(k) => navigate('clientes', { vista: k === 'destinos' ? 'destinos' : undefined })}
      />
      {view === 'destinos' ? (
        <DestinationQueue list={proposed} />
      ) : (
        <div className={selected ? 'split' : ''}>
          <Card flush title={<>Contrapartes <DemoTag /></>}>
            <div className="card-section">
              <FilterBar right={<Button size="sm" onClick={list.reload} busy={list.loading}>Actualizar</Button>}>
                <SearchInput value={search} onChange={setSearch} placeholder="Nombre o documento…" />
                <FilterSelect label="KYC" value={kyc} onChange={(v) => replaceQuery(['clientes', selected].filter(Boolean).join('/'), { ...query, kyc: v || undefined })} options={Object.entries(KYC_STATUS).map(([value, x]) => ({ value, label: x.label }))} />
              </FilterBar>
            </div>
            <DataTable
              columns={columns}
              rows={list.data}
              rowKey={(c) => c.id}
              loading={list.loading}
              error={list.error}
              selectedKey={selected}
              rowHref={(c) => href(`clientes/${c.id}`, query)}
              empty={{ title: 'No hay clientes con estos filtros', hint: can('counterparty.create') ? 'Usa «Nuevo cliente» para registrar uno.' : undefined }}
            />
          </Card>
          {selected && <ClientDrawer key={selected} id={selected} onClose={() => navigate('clientes', query)} />}
        </div>
      )}
      {creating && <NewClientDialog onClose={() => setCreating(false)} />}
    </>
  );
}

function NewClientDialog({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const [f, setF] = useState({ kind: 'CLIENTE', personType: 'JURIDICA', documentType: 'NIT', documentNumber: '', legalName: '', email: '', phone: '', notes: '' });
  const set = (k: keyof typeof f, v: string) => setF((p) => ({ ...p, [k]: v }));
  const docOk = /^[0-9A-Za-z-]{3,20}$/.test(f.documentNumber.trim());
  const emailOk = !f.email.trim() || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.email.trim());
  return (
    <FormModal
      title="Nuevo cliente"
      submitLabel="Registrar cliente"
      canSubmit={docOk && f.legalName.trim().length >= 2 && emailOk}
      onClose={onClose}
      onSubmit={async (o) => {
        const r = await counterparties.create(
          { ...f, documentNumber: f.documentNumber.trim(), legalName: f.legalName.trim(), email: f.email.trim() || null, phone: f.phone.trim() || null, notes: f.notes.trim() || null },
          o,
        );
        toast('Cliente registrado con KYC pendiente');
        navigate(`clientes/${r.id}`);
      }}
    >
      <p className="confirm-intro">El cliente queda con KYC pendiente: no se le cotiza hasta que Cumplimiento lo apruebe.</p>
      <div className="form-row">
        <Field label="Tipo" required>
          {(id) => <Select id={id} value={f.kind} onChange={(e) => set('kind', e.target.value)} options={Object.entries(KIND).map(([value, label]) => ({ value, label }))} />}
        </Field>
        <Field label="Persona" required>
          {(id) => <Select id={id} value={f.personType} onChange={(e) => { set('personType', e.target.value); set('documentType', e.target.value === 'JURIDICA' ? 'NIT' : 'CC'); }} options={Object.entries(PERSON).map(([value, label]) => ({ value, label }))} />}
        </Field>
        <Field label="Tipo de documento" required>
          {(id) => <Select id={id} value={f.documentType} onChange={(e) => set('documentType', e.target.value)} options={Object.entries(DOC).map(([value, label]) => ({ value, label }))} />}
        </Field>
        <Field label="Número de documento" required error={f.documentNumber && !docOk ? '3 a 20 letras, números o guion' : null}>
          {(id) => <Input id={id} value={f.documentNumber} onChange={(e) => set('documentNumber', e.target.value)} autoComplete="off" />}
        </Field>
      </div>
      <Field label="Nombre o razón social" required>
        {(id) => <Input id={id} value={f.legalName} onChange={(e) => set('legalName', e.target.value)} />}
      </Field>
      <div className="form-row">
        <Field label="Correo" error={!emailOk ? 'Correo no válido' : null}>
          {(id) => <Input id={id} type="email" value={f.email} onChange={(e) => set('email', e.target.value)} />}
        </Field>
        <Field label="Teléfono">
          {(id) => <Input id={id} value={f.phone} onChange={(e) => set('phone', e.target.value)} />}
        </Field>
      </div>
      <Field label="Notas">
        {(id) => <Textarea id={id} value={f.notes} onChange={(e) => set('notes', e.target.value)} />}
      </Field>
    </FormModal>
  );
}

function ClientDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const can = useCan();
  const { me } = useSession();
  const toast = useToast();
  const detail = useQuery<CounterpartyDetail>(() => counterparties.get(id), [id]);
  const lim = useQuery<Limits>(() => limits.effective(id), [id]);
  const recent = useQuery<OrderRow[]>(() => orders.list({ counterpartyId: id }), [id]);
  const [editing, setEditing] = useState(false);
  const [kycOpen, setKycOpen] = useState(false);
  const [proposing, setProposing] = useState<{ supersedes?: Destination } | null>(null);
  const { confirm, dialog } = useConfirm(() => detail.reload());
  const c = detail.data;

  const decide = (d: Destination, approve: boolean) =>
    confirm({
      title: `${approve ? 'Aprobar' : 'Rechazar'} destino`,
      intro: approve ? 'Desde la aprobación se pueden enviar pagos a este destino. Verifica que la cuenta o la dirección pertenezcan al cliente.' : 'El destino queda rechazado y no se puede usar para pagos.',
      summary: destinationSummary(d),
      reason: { label: 'Nota de la decisión' },
      stepUp: true,
      danger: !approve,
      acknowledge: approve ? 'Verifiqué que el destino pertenece al cliente.' : undefined,
      confirmLabel: approve ? 'Aprobar destino' : 'Rechazar destino',
      onConfirm: async ({ reason, mfaCode, idempotencyKey }) => {
        await counterparties.decideDestination(d.id, approve, reason, { idempotencyKey, mfaCode });
        toast(`Destino ${approve ? 'aprobado' : 'rechazado'}`);
      },
    });
  const revoke = (d: Destination) =>
    confirm({
      title: 'Revocar destino',
      intro: 'El destino deja de estar disponible para nuevos pagos. Los pagos ya enviados no cambian.',
      summary: destinationSummary(d),
      reason: { label: 'Motivo de la revocación' },
      stepUp: true,
      danger: true,
      confirmLabel: 'Revocar destino',
      onConfirm: async ({ reason, mfaCode, idempotencyKey }) => {
        await counterparties.revokeDestination(d.id, reason, { idempotencyKey, mfaCode });
        toast('Destino revocado');
      },
    });

  if (detail.loading && !c) return <Drawer title="Cliente" onClose={onClose}><Loading /></Drawer>;
  if (detail.error || !c) return <Drawer title="Cliente" onClose={onClose}><ErrorNotice error={detail.error} /></Drawer>;

  return (
    <Drawer
      title={<>#{c.number} · {c.legal_name}</>}
      onClose={onClose}
      actions={<StatusBadge map={KYC_STATUS} status={c.kyc_status} />}
    >
      {c.kyc_status !== 'APROBADO' && (
        <Notice tone={c.kyc_status === 'PENDIENTE' ? 'warning' : 'danger'} title={c.kyc_status === 'PENDIENTE' ? 'KYC pendiente: no se le puede cotizar' : 'No se puede operar con este cliente'}>
          {c.kyc_status === 'PENDIENTE' ? 'Cumplimiento debe revisar sus documentos y aprobar el KYC.' : 'Solo Cumplimiento puede cambiar este estado.'}
        </Notice>
      )}
      <div className="action-row block-gap">
        {can('counterparty.update') && <Button size="sm" onClick={() => setEditing(true)}>Editar datos</Button>}
        {can('kyc.decide') && <Button size="sm" variant="primary" onClick={() => setKycOpen(true)}>Decidir KYC</Button>}
        {can('destination.propose') && c.kyc_status !== 'BLOQUEADO' && c.kyc_status !== 'RECHAZADO' && <Button size="sm" onClick={() => setProposing({})}>Proponer destino</Button>}
      </div>
      <KeyValue
        items={[
          ['Tipo', `${KIND[c.kind]} · ${PERSON[c.person_type]}`],
          ['Documento', <span key="d" className="mono">{DOC[c.document_type] ?? c.document_type} {c.document_number}</span>],
          ['Correo', c.email ?? '—'],
          ['Teléfono', c.phone ?? '—'],
          ['Notas', c.notes ?? '—'],
          ['Versión de datos', `v${c.current_version} · alta ${dateOnly(c.created_at)}`],
        ]}
      />

      <h3>Destinos de pago</h3>
      {c.destinations.length ? (
        <ul className="plain-list dest-list">
          {c.destinations.map((d) => (
            <li key={d.id}>
              <div className="dest-head">
                <strong>{d.label}</strong>
                <StatusBadge map={DESTINATION_STATUS} status={d.status} />
              </div>
              <div className="cell-sub">
                {NETWORK[d.rail]}
                {d.bank_name && ` · ${d.bank_name} ${d.account_type ? ACCOUNT_TYPE[d.account_type] ?? d.account_type : ''}`}
              </div>
              <div><DestValue value={d.value} full /></div>
              {(d.decision_note || d.revoke_reason) && <div className="muted small">{d.revoke_reason ?? d.decision_note}</div>}
              <div className="action-row">
                {d.status === 'PROPUESTO' && can('destination.decide') && (d.proposed_by === me.user.id ? (
                  <span className="muted small">Lo aprueba otra persona</span>
                ) : (
                  <>
                    <Button size="sm" variant="primary" onClick={() => decide(d, true)}>Aprobar</Button>
                    <Button size="sm" onClick={() => decide(d, false)}>Rechazar</Button>
                  </>
                ))}
                {d.status === 'APROBADO' && can('destination.propose') && <Button size="sm" onClick={() => setProposing({ supersedes: d })}>Reemplazar</Button>}
                {d.status === 'APROBADO' && can('destination.decide') && <Button size="sm" variant="danger" onClick={() => revoke(d)}>Revocar</Button>}
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState title="Sin destinos registrados">El cliente necesita al menos un destino aprobado para recibir pagos.</EmptyState>
      )}

      <h3>Límites vigentes</h3>
      {lim.error ? <ErrorNotice error={lim.error} compact /> : lim.data ? (
        <KeyValue items={[['Máximo por orden', usdt(lim.data.orderMaxUsdt)], ['Máximo diario del cliente', usdt(lim.data.clientDailyUsdt)]]} />
      ) : <Loading />}

      <h3>Órdenes recientes</h3>
      {recent.data?.length ? (
        <ul className="plain-list">
          {recent.data.slice(0, 8).map((o) => (
            <li key={o.id}>
              <a href={href(`ordenes/${o.id}`)}>#{o.number}</a> · {SIDE_SHORT[o.side]} {usdt(o.usdt_amount)} · {cop(o.total_cop)} <StatusBadge map={ORDER_STATUS} status={o.status} />
              <div className="cell-sub">{dateTime(o.created_at)}</div>
            </li>
          ))}
        </ul>
      ) : recent.loading ? <Loading /> : <p className="muted">Sin órdenes.</p>}

      <h3>Historial de KYC</h3>
      {c.kycHistory.length ? (
        <ol className="timeline">
          {c.kycHistory.map((k, i) => (
            <li key={i}>
              <div className="timeline-head"><StatusBadge map={KYC_STATUS} status={k.to_status} /><span className="muted">{dateTime(k.created_at)}</span></div>
              <div className="timeline-meta">{k.reviewed_by_name}</div>
              <div className="timeline-note">{k.note}</div>
            </li>
          ))}
        </ol>
      ) : <p className="muted">Sin decisiones de KYC todavía.</p>}

      <h3>Cambios de datos</h3>
      <ol className="timeline">
        {c.versions.map((v) => (
          <li key={v.version}>
            <div className="timeline-head"><Badge>v{v.version}</Badge><span className="muted">{dateTime(v.created_at)}</span></div>
            <div className="timeline-meta">{v.created_by_name}</div>
            <div className="timeline-note">{v.reason}</div>
          </li>
        ))}
      </ol>

      {editing && <EditClientDialog c={c} onClose={() => setEditing(false)} onDone={detail.reload} />}
      {kycOpen && <KycDialog c={c} onClose={() => setKycOpen(false)} onDone={detail.reload} />}
      {proposing && <ProposeDestinationDialog c={c} supersedes={proposing.supersedes} onClose={() => setProposing(null)} onDone={detail.reload} />}
      {dialog}
    </Drawer>
  );
}

/** Quien no gestiona destinos recibe el valor enmascarado desde el servidor: no tiene sentido copiarlo. */
function DestValue({ value, full }: { value: string; full?: boolean }) {
  return value.includes('•') ? <code title="Enmascarado: tu rol no ve el valor completo">{value}</code> : <CopyValue value={value} short={!full} />;
}

function destinationSummary(d: Destination): [string, ReactNode][] {
  return [
    ['Cliente', d.counterparty_name ?? '—'],
    ['Etiqueta', d.label],
    ['Red', NETWORK[d.rail]],
    ...(d.bank_name ? ([['Banco', `${d.bank_name} · ${ACCOUNT_TYPE[d.account_type ?? ''] ?? ''}`]] as [string, string][]) : []),
    ['Cuenta o dirección', <span className="mono" key="v">{d.value}</span>],
    ...(d.holder_document ? ([['Documento del titular', d.holder_document]] as [string, string][]) : []),
  ];
}

function EditClientDialog({ c, onClose, onDone }: { c: CounterpartyDetail; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [f, setF] = useState({ legalName: c.legal_name, email: c.email ?? '', phone: c.phone ?? '', notes: c.notes ?? '', reason: '' });
  const set = (k: keyof typeof f, v: string) => setF((p) => ({ ...p, [k]: v }));
  const emailOk = !f.email.trim() || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.email.trim());
  const changed = f.legalName.trim() !== c.legal_name || f.email.trim() !== (c.email ?? '') || f.phone.trim() !== (c.phone ?? '') || f.notes.trim() !== (c.notes ?? '');
  return (
    <FormModal
      title={`Editar datos · #${c.number}`}
      submitLabel="Guardar nueva versión"
      canSubmit={changed && emailOk && f.legalName.trim().length >= 2 && f.reason.trim().length > 0}
      onClose={onClose}
      onSubmit={async (o) => {
        await counterparties.update(c.id, { legalName: f.legalName.trim(), email: f.email.trim() || null, phone: f.phone.trim() || null, notes: f.notes.trim() || null, reason: f.reason.trim() }, o);
        toast('Datos actualizados');
        onDone();
      }}
    >
      <p className="confirm-intro">Los datos anteriores no se borran: queda una versión nueva con el motivo del cambio.</p>
      <Field label="Nombre o razón social" required>
        {(id) => <Input id={id} value={f.legalName} onChange={(e) => set('legalName', e.target.value)} />}
      </Field>
      <div className="form-row">
        <Field label="Correo" error={!emailOk ? 'Correo no válido' : null}>
          {(id) => <Input id={id} type="email" value={f.email} onChange={(e) => set('email', e.target.value)} />}
        </Field>
        <Field label="Teléfono">
          {(id) => <Input id={id} value={f.phone} onChange={(e) => set('phone', e.target.value)} />}
        </Field>
      </div>
      <Field label="Notas">
        {(id) => <Textarea id={id} value={f.notes} onChange={(e) => set('notes', e.target.value)} />}
      </Field>
      <Field label="Motivo del cambio" required>
        {(id) => <Input id={id} value={f.reason} onChange={(e) => set('reason', e.target.value)} placeholder="Ej.: el cliente actualizó su correo" />}
      </Field>
    </FormModal>
  );
}

function KycDialog({ c, onClose, onDone }: { c: CounterpartyDetail; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const options = KYC_NEXT[c.kyc_status] ?? [];
  const [to, setTo] = useState(options[0] ?? '');
  const [note, setNote] = useState('');
  const risky = to === 'BLOQUEADO' || to === 'RECHAZADO';
  return (
    <FormModal
      title={`Decisión de KYC · ${c.legal_name}`}
      submitLabel="Registrar decisión"
      canSubmit={!!to && note.trim().length > 0}
      stepUp
      danger={risky}
      onClose={onClose}
      onSubmit={async (o) => {
        await counterparties.decideKyc(c.id, to, note.trim(), o);
        toast(`KYC: ${KYC_STATUS[to].label}`);
        onDone();
      }}
    >
      <p className="confirm-intro">
        Estado actual: <StatusBadge map={KYC_STATUS} status={c.kyc_status} />. {to === 'APROBADO' ? 'Con KYC aprobado se le puede cotizar.' : to === 'BLOQUEADO' ? 'Bloquear impide cotizarle y pagarle hasta nueva decisión.' : to === 'PENDIENTE' ? 'Vuelve a revisión: no se le cotiza mientras tanto.' : ''}
      </p>
      <Field label="Nuevo estado" required>
        {(id) => <Select id={id} value={to} onChange={(e) => setTo(e.target.value)} options={options.map((k) => ({ value: k, label: KYC_STATUS[k].label }))} />}
      </Field>
      <Field label="Nota de la decisión" required hint="Queda en el historial del cliente y en la auditoría.">
        {(id) => <Textarea id={id} value={note} onChange={(e) => setNote(e.target.value)} />}
      </Field>
    </FormModal>
  );
}

function ProposeDestinationDialog({ c, supersedes, onClose, onDone }: { c: CounterpartyDetail; supersedes?: Destination; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [f, setF] = useState({ rail: supersedes?.rail ?? 'BSC', value: '', bankName: 'Bancolombia', accountType: 'AHORROS', holderDocument: c.document_number, label: supersedes?.label ?? '' });
  const set = (k: keyof typeof f, v: string) => setF((p) => ({ ...p, [k]: v }));
  const bank = f.rail === 'BANK';
  const valueError = f.value.trim() ? destinationError(f.rail, f.value.trim()) : null;
  return (
    <FormModal
      title={supersedes ? `Reemplazar destino · ${supersedes.label}` : `Proponer destino · ${c.legal_name}`}
      submitLabel="Proponer destino"
      canSubmit={!!f.value.trim() && !valueError && f.label.trim().length > 0 && (!bank || (!!f.bankName.trim() && !!f.accountType))}
      onClose={onClose}
      onSubmit={async (o) => {
        await counterparties.proposeDestination(
          c.id,
          {
            rail: f.rail,
            value: f.value.trim(),
            bankName: bank ? f.bankName.trim() : null,
            accountType: bank ? f.accountType : null,
            holderDocument: bank ? f.holderDocument.trim() || null : null,
            label: f.label.trim(),
            supersedesId: supersedes?.id ?? null,
          },
          o,
        );
        toast('Destino propuesto: espera la aprobación de Cumplimiento');
        onDone();
      }}
    >
      <p className="confirm-intro">El destino no se puede usar hasta que otra persona de Cumplimiento o Administración lo apruebe.{supersedes && ' Al aprobarse, reemplaza al destino actual.'}</p>
      <div className="form-row">
        <Field label="Red" required>
          {(id) => <Select id={id} value={f.rail} disabled={!!supersedes} onChange={(e) => { set('rail', e.target.value); set('value', ''); }} options={Object.entries(NETWORK).map(([value, label]) => ({ value, label }))} />}
        </Field>
        <Field label="Etiqueta" required hint="Ej.: Billetera principal, Cuenta nómina">
          {(id) => <Input id={id} value={f.label} onChange={(e) => set('label', e.target.value)} />}
        </Field>
      </div>
      <Field label={bank ? 'Número de cuenta' : 'Dirección de la billetera'} required hint={destinationHint(f.rail)} error={valueError}>
        {(id) => <Input id={id} className="input mono" value={f.value} onChange={(e) => set('value', e.target.value)} spellCheck={false} autoComplete="off" />}
      </Field>
      {bank && (
        <div className="form-row">
          <Field label="Banco" required>
            {(id) => <Input id={id} value={f.bankName} onChange={(e) => set('bankName', e.target.value)} />}
          </Field>
          <Field label="Tipo de cuenta" required>
            {(id) => <Select id={id} value={f.accountType} onChange={(e) => set('accountType', e.target.value)} options={Object.entries(ACCOUNT_TYPE).map(([value, label]) => ({ value, label }))} />}
          </Field>
          <Field label="Documento del titular">
            {(id) => <Input id={id} value={f.holderDocument} onChange={(e) => set('holderDocument', e.target.value)} />}
          </Field>
        </div>
      )}
    </FormModal>
  );
}

/** Bandeja de destinos propuestos que esperan decisión de Cumplimiento o Administración. */
function DestinationQueue({ list }: { list: ReturnType<typeof useQuery<Destination[]>> }) {
  const can = useCan();
  const { me } = useSession();
  const toast = useToast();
  const { confirm, dialog } = useConfirm(() => list.reload());
  const decide = (d: Destination, approve: boolean) =>
    confirm({
      title: `${approve ? 'Aprobar' : 'Rechazar'} destino · ${d.counterparty_name}`,
      intro: approve ? 'Desde la aprobación se pueden enviar pagos a este destino.' : 'El destino queda rechazado.',
      summary: destinationSummary(d),
      reason: { label: 'Nota de la decisión' },
      stepUp: true,
      danger: !approve,
      acknowledge: approve ? 'Verifiqué que el destino pertenece al cliente.' : undefined,
      confirmLabel: approve ? 'Aprobar destino' : 'Rechazar destino',
      onConfirm: async ({ reason, mfaCode, idempotencyKey }) => {
        await counterparties.decideDestination(d.id, approve, reason, { idempotencyKey, mfaCode });
        toast(`Destino ${approve ? 'aprobado' : 'rechazado'}`);
        notifyChange();
      },
    });
  const columns: Column<Destination>[] = [
    { key: 'c', header: 'Cliente', render: (d) => <a href={href(`clientes/${d.counterparty_id}`)}>{d.counterparty_name}</a> },
    { key: 'l', header: 'Destino', render: (d) => <><span className="cell-main">{d.label}</span><span className="cell-sub">{NETWORK[d.rail]}{d.bank_name ? ` · ${d.bank_name}` : ''}</span></> },
    { key: 'v', header: 'Cuenta o dirección', render: (d) => <DestValue value={d.value} /> },
    { key: 'p', header: 'Propuso', secondary: true, render: (d) => <>{d.proposed_by_name}<span className="cell-sub">{dateTime(d.proposed_at)}</span></> },
    {
      key: 'x',
      header: '',
      render: (d) =>
        !can('destination.decide') ? null : d.proposed_by === me.user.id ? (
          <span className="muted small">Lo aprueba otra persona</span>
        ) : (
          <span className="action-row">
            <Button size="sm" variant="primary" onClick={() => decide(d, true)}>Aprobar</Button>
            <Button size="sm" onClick={() => decide(d, false)}>Rechazar</Button>
          </span>
        ),
    },
  ];
  return (
    <Card flush title={<>Destinos por aprobar <DemoTag /></>}>
      <DataTable columns={columns} rows={list.data} rowKey={(d) => d.id} loading={list.loading} error={list.error} empty={{ title: 'No hay destinos esperando decisión' }} />
      {dialog}
    </Card>
  );
}
