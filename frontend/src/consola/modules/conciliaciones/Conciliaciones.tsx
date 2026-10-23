import { useState } from 'react';
import { liquidity, reconciliation, sandbox } from '../../api/endpoints';
import type { Adjustment, LiquidityAccount, ReconItem, ReconRun, ReconRunRow } from '../../api/types';
import { DemoTag } from '../../app/DemoTag';
import { href, navigate, replaceQuery } from '../../app/router';
import { isDemo, useCan, useSession } from '../../app/session';
import { amountOf, dateOnly, dateTime, todayBogota } from '../../lib/format';
import { notifyChange, useQuery } from '../../lib/hooks';
import { PROPOSAL_STATUS, RECON_ITEM_STATUS, RECON_RUN_STATUS } from '../../lib/labels';
import { Badge, StatusBadge } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { CopyValue } from '../../ui/Copy';
import { DataTable, type Column } from '../../ui/DataTable';
import { Drawer } from '../../ui/Drawer';
import { ErrorNotice, useToast } from '../../ui/Feedback';
import { Field, FilterBar, FilterSelect, Input, parseAmountInput, Select, Textarea } from '../../ui/Form';
import { FormModal } from '../../ui/FormModal';
import { Card, KeyValue, Loading, Notice, PageHeader, Tabs } from '../../ui/Layout';
import { useConfirm } from '../../ui/Modal';
import type { PageProps } from '../index';

const OPEN_ITEM = ['PENDIENTE', 'CON_DIFERENCIA', 'SIN_CONTRAPARTIDA', 'EN_REVISION'];

export default function Conciliaciones({ route }: PageProps) {
  const can = useCan();
  const view = route.query.get('vista') === 'ajustes' ? 'ajustes' : 'dias';
  const selected = route.path[1] ?? null;
  const date = route.query.get('fecha') ?? '';
  const status = route.query.get('estado') ?? '';
  const [fetching, setFetching] = useState(false);
  const [importing, setImporting] = useState(false);
  const accounts = useQuery<LiquidityAccount[]>(() => liquidity.summary(), []);
  const runs = useQuery<ReconRunRow[]>(view === 'dias' ? () => reconciliation.list({ date: date || undefined, status: status || undefined }) : null, [view, date, status], { refreshMs: 20000 });
  const adjustments = useQuery<Adjustment[]>(() => reconciliation.adjustments({}), [view]);
  const pendingAdj = adjustments.data?.filter((a) => a.status === 'PROPUESTO').length ?? 0;
  const setFilter = (k: string, v: string) => replaceQuery(['conciliaciones', selected].filter(Boolean).join('/'), { fecha: date, estado: status, vista: view === 'ajustes' ? 'ajustes' : undefined, [k]: v });

  const columns: Column<ReconRunRow>[] = [
    { key: 'd', header: 'Día', render: (r) => <span className="cell-main">{dateOnly(r.business_date)}</span> },
    { key: 'a', header: 'Cuenta', render: (r) => r.account_code },
    { key: 's', header: 'Estado', render: (r) => <StatusBadge map={RECON_RUN_STATUS} status={r.status} /> },
    { key: 'o', header: 'Partidas abiertas', align: 'right', render: (r) => (r.open_items ? <strong className="text-danger">{r.open_items}</strong> : <span className="muted">0</span>) },
  ];

  return (
    <>
      <PageHeader
        title="Conciliaciones"
        subtitle="Cruce diario de cada cuenta contra el extracto del banco o la red. Las diferencias se revisan y se corrigen con ajustes aprobados por otra persona; el libro nunca se edita."
        actions={
          view === 'dias' &&
          can('reconciliation.manage') && (
            <>
              <Button onClick={() => setImporting(true)}>Cargar extracto</Button>
              <Button variant="primary" onClick={() => setFetching(true)}>
                Conciliar cuenta
              </Button>
            </>
          )
        }
      />
      <Tabs
        tabs={[
          { key: 'dias', label: 'Conciliaciones por día' },
          { key: 'ajustes', label: 'Ajustes', count: pendingAdj },
        ]}
        active={view}
        onChange={(k) => navigate('conciliaciones', { vista: k === 'ajustes' ? 'ajustes' : undefined })}
      />
      {view === 'ajustes' ? (
        <AdjustmentsView list={adjustments} />
      ) : (
        <div className={selected ? 'split' : ''}>
          <Card flush title={<>Días conciliados <DemoTag /></>}>
            <div className="card-section">
              <FilterBar right={<Button size="sm" onClick={runs.reload} busy={runs.loading}>Actualizar</Button>}>
                <label className="filter-select">
                  <span>Día</span>
                  <input type="date" className="input" value={date} onChange={(e) => setFilter('fecha', e.target.value)} />
                </label>
                <FilterSelect label="Estado" value={status} onChange={(v) => setFilter('estado', v)} options={Object.entries(RECON_RUN_STATUS).map(([k, v]) => ({ value: k, label: v.label }))} />
              </FilterBar>
            </div>
            <DataTable
              columns={columns}
              rows={runs.data}
              rowKey={(r) => r.id}
              loading={runs.loading}
              error={runs.error}
              selectedKey={selected}
              rowHref={(r) => href(`conciliaciones/${r.id}`, { fecha: date, estado: status })}
              empty={{ title: 'No hay conciliaciones con estos filtros', hint: can('reconciliation.manage') ? 'Usa «Conciliar cuenta» para cruzar el día con el banco o la red.' : undefined }}
            />
          </Card>
          {selected && <RunDrawer key={selected} id={selected} accounts={accounts.data ?? []} onClose={() => navigate('conciliaciones', { fecha: date, estado: status })} onChange={() => { runs.reload(); adjustments.reload(); }} />}
        </div>
      )}
      {fetching && accounts.data && <FetchDialog accounts={accounts.data} onClose={() => setFetching(false)} />}
      {importing && accounts.data && <ImportDialog accounts={accounts.data} onClose={() => setImporting(false)} />}
    </>
  );
}

function FetchDialog({ accounts, onClose }: { accounts: LiquidityAccount[]; onClose: () => void }) {
  const toast = useToast();
  const [accountId, setAccountId] = useState('');
  const [date, setDate] = useState(todayBogota());
  return (
    <FormModal
      title="Conciliar una cuenta"
      submitLabel="Pedir extracto y cruzar"
      canSubmit={!!accountId && !!date}
      onClose={onClose}
      onSubmit={async () => {
        const r = await reconciliation.fetch(accountId, date);
        toast(`Extracto cruzado: ${r.lines} movimientos`);
        navigate(`conciliaciones/${r.runId}`);
      }}
    >
      <p className="confirm-intro">El sistema pide los movimientos del día al banco o a la red y los cruza con el libro. Repetirlo actualiza la conciliación del mismo día.</p>
      <Field label="Cuenta" required>
        {(id) => <Select id={id} value={accountId} onChange={(e) => setAccountId(e.target.value)} placeholder="Elige la cuenta" options={accounts.map((a) => ({ value: a.id, label: `${a.name} (${a.code})` }))} />}
      </Field>
      <Field label="Día" required>
        {(id) => <Input id={id} type="date" value={date} max={todayBogota()} onChange={(e) => setDate(e.target.value)} />}
      </Field>
    </FormModal>
  );
}

/** Carga manual de un extracto: una línea por movimiento, separada por punto y coma. */
function ImportDialog({ accounts, onClose }: { accounts: LiquidityAccount[]; onClose: () => void }) {
  const toast = useToast();
  const [accountId, setAccountId] = useState('');
  const [date, setDate] = useState(todayBogota());
  const [text, setText] = useState('');
  const account = accounts.find((a) => a.id === accountId);
  const parsed = text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line, i) => {
      const [reference = '', dir = '', amountRaw = '', time = ''] = line.split(';').map((x) => x.trim());
      const d = dir.toUpperCase();
      const direction: 'IN' | 'OUT' | null = d === 'ENTRA' || d === 'IN' ? 'IN' : d === 'SALE' || d === 'OUT' ? 'OUT' : null;
      const amount = parseAmountInput(amountRaw, account?.asset === 'COP' ? 0 : 6);
      const at = /^\d{1,2}:\d{2}$/.test(time) ? new Date(`${date}T${time.padStart(5, '0')}:00-05:00`) : null;
      const error = reference.length < 3 ? 'referencia' : !direction ? 'sentido (ENTRA o SALE)' : amount.error ? `monto: ${amount.error}` : !at ? 'hora (HH:MM)' : null;
      return { i: i + 1, error, line: { reference, direction: direction!, amount: amount.value!, occurredAt: at?.toISOString() ?? '' } };
    });
  const errors = parsed.filter((p) => p.error);
  return (
    <FormModal
      title="Cargar extracto a mano"
      submitLabel={`Cargar ${parsed.length || ''} movimientos`}
      wide
      canSubmit={!!accountId && parsed.length > 0 && errors.length === 0}
      onClose={onClose}
      onSubmit={async (o) => {
        const r = await reconciliation.importStatement(accountId, date, parsed.map((p) => p.line), o);
        toast(`Extracto cargado: ${r.lines} movimientos cruzados`);
        navigate(`conciliaciones/${r.runId}`);
      }}
    >
      <p className="confirm-intro">Para bancos o plataformas sin conexión automática. Cada movimiento queda guardado tal como se cargó y no se puede editar.</p>
      <div className="form-row">
        <Field label="Cuenta" required>
          {(id) => <Select id={id} value={accountId} onChange={(e) => setAccountId(e.target.value)} placeholder="Elige la cuenta" options={accounts.map((a) => ({ value: a.id, label: `${a.name} (${a.code})` }))} />}
        </Field>
        <Field label="Día del extracto" required>
          {(id) => <Input id={id} type="date" value={date} max={todayBogota()} onChange={(e) => setDate(e.target.value)} />}
        </Field>
      </div>
      <Field label="Movimientos" required hint="Una línea por movimiento: referencia; ENTRA o SALE; monto; hora (HH:MM). Ejemplo: CONSIG-123; ENTRA; 3969220; 14:05">
        {(id) => <Textarea id={id} rows={6} className="input mono" value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} />}
      </Field>
      {errors.length > 0 && (
        <Notice tone="danger" title="Revisa estas líneas">
          {errors.slice(0, 5).map((e) => (
            <div key={e.i}>
              Línea {e.i}: {e.error}
            </div>
          ))}
        </Notice>
      )}
    </FormModal>
  );
}

function RunDrawer({ id, accounts, onClose, onChange }: { id: string; accounts: LiquidityAccount[]; onClose: () => void; onChange: () => void }) {
  const can = useCan();
  const { system } = useSession();
  const toast = useToast();
  const { confirm, dialog } = useConfirm();
  const { data: run, error, reload } = useQuery<ReconRun>(() => reconciliation.get(id), [id]);
  const adjustments = useQuery<Adjustment[]>(() => reconciliation.adjustments({ runId: id, status: 'PROPUESTO' }), [id]);
  const pendingAdj = (i: ReconItem) => adjustments.data?.find((a) => a.item_id === i.id);
  const [simulating, setSimulating] = useState(false);
  if (!run) return <Drawer title="Conciliación" onClose={onClose}>{error ? <ErrorNotice error={error} /> : <Loading />}</Drawer>;
  const account = accounts.find((a) => a.id === run.account_id);
  const asset = account?.asset ?? 'COP';
  const refresh = () => {
    reload();
    adjustments.reload();
    onChange();
  };
  const open = run.items.filter((i) => OPEN_ITEM.includes(i.status));

  const toReview = (i: ReconItem) =>
    confirm({
      title: `Enviar a revisión la partida ${i.number}`,
      intro: 'En revisión se decide si la diferencia se corrige con un ajuste (lo aprueba otra persona) o se aclara sin ajuste.',
      reason: { label: 'Qué hay que revisar' },
      confirmLabel: 'Enviar a revisión',
      onConfirm: async ({ reason, idempotencyKey }) => {
        await reconciliation.sendToReview(i.id, reason, { idempotencyKey });
        refresh();
      },
    });
  const propose = (i: ReconItem) =>
    confirm({
      title: `Proponer ajuste · partida ${i.number}`,
      intro: 'El ajuste corrige el libro sin tocar el registro original. Lo aprueba otra persona (administración).',
      summary: [
        ['Esperado en el libro', amountOf(asset, i.expected_amount)],
        ['Observado en el extracto', amountOf(asset, i.observed_amount)],
        ['Motivo del sistema', i.status_reason ?? '—'],
      ],
      fields: [
        {
          name: 'amount',
          label: `Monto del ajuste (${asset})`,
          hint: 'Positivo: entra a la cuenta. Negativo (con signo menos): sale de la cuenta.',
          validate: (v) => {
            const neg = v.startsWith('-');
            return parseAmountInput(neg ? v.slice(1) : v, asset === 'COP' ? 0 : 6).error ?? null;
          },
        },
      ],
      reason: { label: 'Justificación' },
      confirmLabel: 'Proponer ajuste',
      onConfirm: async ({ fields, reason, idempotencyKey }) => {
        const neg = fields.amount.startsWith('-');
        const value = parseAmountInput(neg ? fields.amount.slice(1) : fields.amount, asset === 'COP' ? 0 : 6).value!;
        await reconciliation.proposeAdjustment(i.id, `${neg ? '-' : ''}${value}`, reason, { idempotencyKey });
        toast('Ajuste propuesto: espera aprobación de administración');
        refresh();
      },
    });
  const clear = (i: ReconItem) =>
    confirm({
      title: `Aclarar partida ${i.number} sin ajuste`,
      intro: 'Úsalo solo si la diferencia está explicada y no afecta el libro (por ejemplo, un movimiento que pertenece a otro día).',
      danger: true,
      reason: { label: 'Explicación' },
      stepUp: true,
      confirmLabel: 'Aclarar partida',
      onConfirm: async ({ reason, mfaCode, idempotencyKey }) => {
        await reconciliation.clear(i.id, reason, { idempotencyKey, mfaCode });
        refresh();
      },
    });
  const close = () =>
    confirm({
      title: `Cerrar el día ${dateOnly(run.business_date)} · ${run.account_code}`,
      intro: 'Al cerrar, la conciliación queda congelada. Solo se puede cerrar si no quedan partidas abiertas.',
      reason: { label: 'Nota', optional: true },
      stepUp: true,
      confirmLabel: 'Cerrar día',
      onConfirm: async ({ reason, mfaCode, idempotencyKey }) => {
        await reconciliation.close(id, reason || null, { idempotencyKey, mfaCode });
        toast('Día cerrado');
        refresh();
      },
    });

  return (
    <Drawer title={`${run.account_code} · ${dateOnly(run.business_date)}`} onClose={onClose}>
      <StatusBadge map={RECON_RUN_STATUS} status={run.status} />
      {run.status_reason && <Notice tone="neutral">{run.status_reason}</Notice>}
      <KeyValue
        items={[
          ['Partidas', run.items.length],
          ['Abiertas', open.length ? <strong className="text-danger">{open.length}</strong> : 0],
          ['Cerrada', run.closed_at ? dateTime(run.closed_at) : 'No'],
        ]}
      />
      {run.status !== 'CERRADO' && can('reconciliation.manage') && (
        <div className="action-row" style={{ margin: '12px 0' }}>
          <Button onClick={() => reconciliation.fetch(run.account_id, run.business_date).then(() => (notifyChange(), refresh()))}>Volver a cruzar</Button>
          <Button variant="primary" onClick={close} disabled={open.length > 0} title={open.length ? 'Quedan partidas abiertas' : undefined}>
            Cerrar día
          </Button>
        </div>
      )}
      {isDemo(system) && can('sandbox.simulate') && run.status !== 'CERRADO' && account && (
        <div className="action-panel sim-panel">
          <h4>
            Simular un movimiento en el extracto <DemoTag />
          </h4>
          <p>Solo en la demostración: agrega un movimiento que el libro no tiene, para ver cómo se detecta y se corrige la diferencia.</p>
          <Button
            size="sm"
            busy={simulating}
            onClick={async () => {
              setSimulating(true);
              try {
                await sandbox.simulateMovement(account.id, { reference: `SIM-${Date.now().toString(36).toUpperCase()}`, direction: 'IN', amount: asset === 'COP' ? '150000' : '25' });
                await reconciliation.fetch(run.account_id, run.business_date);
                notifyChange();
                refresh();
              } finally {
                setSimulating(false);
              }
            }}
          >
            Simular movimiento desconocido
          </Button>
        </div>
      )}
      <h3>Partidas</h3>
      {run.items.length === 0 ? (
        <p className="muted">Sin movimientos ese día.</p>
      ) : (
        <ul className="plain-list">
          {run.items.map((i) => (
            <li key={i.id} className="recon-item">
              <span className="cell-main">#{i.number}</span>
              <StatusBadge map={RECON_ITEM_STATUS} status={i.status} />
              <span className="muted small">{i.direction === 'IN' ? 'Entra' : i.direction === 'OUT' ? 'Sale' : ''}</span>
              <span className="cell-sub">
                {i.external_ref && <CopyValue value={i.external_ref} />} Libro: {amountOf(asset, i.expected_amount)} · Extracto: {amountOf(asset, i.observed_amount)}
                {i.transfer_id && (
                  <>
                    {' · '}
                    <a href={href(`transferencias/${i.transfer_id}`)}>transferencia #{i.transfer_number}</a>
                  </>
                )}
              </span>
              {i.status_reason && <span className="cell-sub">{i.status_reason}</span>}
              {pendingAdj(i) && (
                <span className="cell-sub">
                  <Badge tone="warning">Ajuste #{pendingAdj(i)!.number} por aprobar</Badge> {amountOf(asset, pendingAdj(i)!.amount)} · {pendingAdj(i)!.proposed_by_name}
                </span>
              )}
              {OPEN_ITEM.includes(i.status) && run.status !== 'CERRADO' && (
                <span className="action-row" style={{ flexBasis: '100%' }}>
                  {i.status !== 'EN_REVISION' && can('reconciliation.manage') && (
                    <Button size="sm" onClick={() => toReview(i)}>
                      Enviar a revisión
                    </Button>
                  )}
                  {i.status === 'EN_REVISION' && !pendingAdj(i) && can('adjustment.propose') && (
                    <Button size="sm" onClick={() => propose(i)}>
                      Proponer ajuste
                    </Button>
                  )}
                  {i.status === 'EN_REVISION' && can('review.resolve') && (
                    <Button size="sm" variant="ghost" onClick={() => clear(i)}>
                      Aclarar sin ajuste
                    </Button>
                  )}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {dialog}
    </Drawer>
  );
}

function AdjustmentsView({ list }: { list: { data: Adjustment[] | null; loading: boolean; error: unknown; reload: () => void } }) {
  const can = useCan();
  const { me } = useSession();
  const toast = useToast();
  const { confirm, dialog } = useConfirm();
  const [status, setStatus] = useState('PROPUESTO');
  const rows = list.data?.filter((a) => !status || a.status === status) ?? null;

  const decide = (a: Adjustment, approve: boolean) =>
    confirm({
      title: `${approve ? 'Aprobar' : 'Rechazar'} ajuste #${a.number}`,
      intro: approve ? 'Se registra un asiento contable que corrige el saldo de la cuenta. No se puede deshacer; un error se corrige con otro ajuste.' : 'El ajuste queda rechazado y la partida sigue abierta.',
      summary: [
        ['Cuenta', a.account_code],
        ['Monto', <strong>{String(a.amount).startsWith('-') ? `− ${amountOf(a.asset, String(a.amount).slice(1))} (sale)` : `+ ${amountOf(a.asset, a.amount)} (entra)`}</strong>],
        ['Justificación', a.reason],
        ['Propuesto por', a.proposed_by_name],
      ],
      danger: !approve,
      reason: { label: 'Nota de la decisión' },
      stepUp: true,
      acknowledge: approve ? 'Revisé la evidencia y el monto del ajuste.' : undefined,
      confirmLabel: approve ? 'Aprobar ajuste' : 'Rechazar ajuste',
      onConfirm: async ({ reason, mfaCode, idempotencyKey }) => {
        await reconciliation.decideAdjustment(a.id, approve, reason, { idempotencyKey, mfaCode });
        toast(`Ajuste #${a.number} ${approve ? 'aprobado' : 'rechazado'}`);
        list.reload();
      },
    });

  const columns: Column<Adjustment>[] = [
    { key: 'n', header: 'N.º', width: '70px', render: (a) => <span className="cell-main">#{a.number}</span> },
    { key: 'c', header: 'Cuenta', render: (a) => <>{a.account_code}{a.run_id && <span className="cell-sub"><a href={href(`conciliaciones/${a.run_id}`)} onClick={(e) => e.stopPropagation()}>partida {a.item_number}</a></span>}</> },
    { key: 'm', header: 'Monto', align: 'right', render: (a) => (String(a.amount).startsWith('-') ? `− ${amountOf(a.asset, String(a.amount).slice(1))}` : `+ ${amountOf(a.asset, a.amount)}`) },
    { key: 'r', header: 'Justificación', secondary: true, render: (a) => a.reason },
    { key: 'p', header: 'Propuso', secondary: true, render: (a) => <>{a.proposed_by_name}<span className="cell-sub">{dateTime(a.created_at)}</span></> },
    { key: 's', header: 'Estado', render: (a) => <StatusBadge map={PROPOSAL_STATUS} status={a.status} title={a.status_reason ?? undefined} /> },
    {
      key: 'x',
      header: '',
      render: (a) =>
        a.status === 'PROPUESTO' && can('adjustment.approve') ? (
          a.proposed_by === me.user.id ? (
            <span className="muted small">Lo aprueba otra persona</span>
          ) : (
            <span className="action-row">
              <Button size="sm" variant="primary" onClick={() => decide(a, true)}>
                Aprobar
              </Button>
              <Button size="sm" onClick={() => decide(a, false)}>
                Rechazar
              </Button>
            </span>
          )
        ) : null,
    },
  ];
  return (
    <Card flush title={<>Ajustes contables <DemoTag /></>}>
      <div className="card-section">
        <FilterBar right={<Button size="sm" onClick={list.reload} busy={list.loading}>Actualizar</Button>}>
          <FilterSelect label="Estado" value={status} allLabel="Todos" onChange={setStatus} options={Object.entries({ PROPUESTO: 'Por aprobar', APROBADO: 'Aprobados', RECHAZADO: 'Rechazados' }).map(([value, label]) => ({ value, label }))} />
        </FilterBar>
      </div>
      <DataTable columns={columns} rows={rows} rowKey={(a) => a.id} loading={list.loading} error={list.error} empty={{ title: status === 'PROPUESTO' ? 'No hay ajustes por aprobar' : 'No hay ajustes' }} />
      {dialog}
    </Card>
  );
}
