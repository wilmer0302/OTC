import { useState } from 'react';
import { transfers } from '../../api/endpoints';
import type { Observation, TransferDetail, TransferRow } from '../../api/types';
import { DemoTag } from '../../app/DemoTag';
import { href, navigate, replaceQuery } from '../../app/router';
import { amountOf, dateTime } from '../../lib/format';
import { useDebounced, useQuery } from '../../lib/hooks';
import { NETWORK, PURPOSE, TRANSFER_STATUS } from '../../lib/labels';
import { Badge, SimulatedTag, StatusBadge } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { CopyValue } from '../../ui/Copy';
import { DataTable, type Column } from '../../ui/DataTable';
import { Drawer } from '../../ui/Drawer';
import { ErrorNotice } from '../../ui/Feedback';
import { FilterBar, FilterSelect, SearchInput } from '../../ui/Form';
import { Card, EmptyState, KeyValue, Loading, Notice, PageHeader, Tabs } from '../../ui/Layout';
import { Timeline } from '../../ui/Timeline';
import type { PageProps } from '../index';
import { PendingOriginExceptions } from './OriginException';
import { TransferActions } from './TransferActions';

const RAIL_TABS = [
  { key: '', label: 'Todas' },
  { key: 'TRON', label: 'USDT · Tron (TRC20)' },
  { key: 'BSC', label: 'USDT · BSC (BEP20)' },
  { key: 'BANK', label: 'Pesos · banco' },
] as const;

export default function Transferencias({ route }: PageProps) {
  const selected = route.path[1] ?? null;
  const rail = route.query.get('red') ?? '';
  const status = route.query.get('estado') ?? '';
  const purpose = route.query.get('tipo') ?? '';
  const [search, setSearch] = useState('');
  const q = useDebounced(search.trim().replace(/^#/, ''), 400);
  const list = useQuery<TransferRow[]>(
    () => transfers.list({ rail: rail || undefined, status: status || undefined, purpose: purpose || undefined, search: q || undefined }),
    [rail, status, purpose, q],
    { refreshMs: 10000 },
  );
  const query = { red: rail, estado: status, tipo: purpose };
  const setFilter = (k: string, v: string) => replaceQuery(['transferencias', selected].filter(Boolean).join('/'), { ...query, [k]: v });

  const columns: Column<TransferRow>[] = [
    { key: 'n', header: 'N.º', width: '70px', render: (t) => <span className="cell-main">#{t.number}</span> },
    {
      key: 'p',
      header: 'Tipo',
      render: (t) => (
        <>
          {PURPOSE[t.purpose]} <span className="muted">{t.direction === 'IN' ? '· entra' : '· sale'}</span>
          <span className="cell-sub">{t.order_number ? `Orden #${t.order_number}` : t.account_code}</span>
        </>
      ),
    },
    { key: 'r', header: 'Red', secondary: true, render: (t) => NETWORK[t.rail] },
    { key: 'a', header: 'Monto', align: 'right', render: (t) => amountOf(t.asset, t.amount) },
    {
      key: 's',
      header: 'Estado',
      render: (t) => (
        <>
          <StatusBadge map={TRANSFER_STATUS} status={t.status} title={t.status_reason ?? undefined} />
          {t.rail !== 'BANK' && t.confirmations !== null && ['ENVIADA', 'PENDIENTE'].includes(t.status) && <span className="cell-sub">{t.confirmations} confirmaciones</span>}
        </>
      ),
    },
    { key: 'h', header: 'Hash / referencia', secondary: true, render: (t) => <CopyValue value={t.external_ref} /> },
    { key: 'd', header: 'Enviada', secondary: true, render: (t) => <span className="muted">{t.sent_at ? dateTime(t.sent_at) : '—'}</span> },
  ];

  return (
    <>
      <PageHeader
        title="Transferencias"
        subtitle="Movimientos de USDT por Tron (TRC20) y BSC (BEP20) y pagos en pesos. Cada uno se verifica contra la red o el banco; la plataforma no firma ni guarda llaves."
      />
      <PendingOriginExceptions />
      <Tabs tabs={RAIL_TABS.map((t) => ({ key: t.key, label: t.label }))} active={rail as (typeof RAIL_TABS)[number]['key']} onChange={(k) => setFilter('red', k)} />
      <div className={selected ? 'split' : ''}>
        <Card flush title={<>Transferencias <DemoTag /></>}>
          <div className="card-section">
            <FilterBar right={<Button size="sm" onClick={list.reload} busy={list.loading}>Actualizar</Button>}>
              <SearchInput value={search} onChange={setSearch} placeholder="Hash, referencia, n.º u orden" />
              <FilterSelect label="Estado" value={status} onChange={(v) => setFilter('estado', v)} options={Object.entries(TRANSFER_STATUS).map(([k, v]) => ({ value: k, label: v.label }))} />
              <FilterSelect label="Tipo" value={purpose} onChange={(v) => setFilter('tipo', v)} options={Object.entries(PURPOSE).map(([k, v]) => ({ value: k, label: v }))} />
            </FilterBar>
          </div>
          <DataTable
            columns={columns}
            rows={list.data}
            rowKey={(t) => t.id}
            loading={list.loading}
            error={list.error}
            selectedKey={selected}
            rowHref={(t) => href(`transferencias/${t.id}`, query)}
            empty={{ title: 'No hay transferencias con estos filtros' }}
          />
        </Card>
        {selected && <TransferDrawer key={selected} id={selected} onClose={() => navigate('transferencias', query)} onChange={list.reload} />}
      </div>
    </>
  );
}

const OUTCOME: Record<string, { label: string; tone: 'success' | 'danger' | 'warning' | 'neutral' | 'info' }> = {
  CONFIRMADA: { label: 'Confirmada', tone: 'success' },
  PENDIENTE: { label: 'Pendiente', tone: 'info' },
  FALLIDA: { label: 'Fallida', tone: 'danger' },
  REVISION: { label: 'Enviada a revisión', tone: 'danger' },
  ALERTA: { label: 'Alerta', tone: 'danger' },
  SIN_CAMBIO: { label: 'Sin cambio', tone: 'neutral' },
  EVIDENCIA_TARDIA: { label: 'Evidencia tardía', tone: 'warning' },
};

function TransferDrawer({ id, onClose, onChange }: { id: string; onClose: () => void; onChange: () => void }) {
  const { data: t, error, reload } = useQuery<TransferDetail>(() => transfers.get(id), [id], { refreshMs: 8000 });
  const obs = useQuery<Observation[]>(() => transfers.observations(id), [id, t?.status, t?.confirmations]);
  if (!t) return <Drawer title="Transferencia" onClose={onClose}>{error ? <ErrorNotice error={error} /> : <Loading />}</Drawer>;
  const refresh = () => {
    reload();
    obs.reload();
    onChange();
  };
  return (
    <Drawer title={`${PURPOSE[t.purpose]} #${t.number}`} onClose={onClose}>
      <StatusBadge map={TRANSFER_STATUS} status={t.status} />
      {t.status_reason && (
        <Notice tone={['FALLIDA', 'EN_REVISION'].includes(t.status) ? 'danger' : 'neutral'} title="Detalle del estado">
          {t.status_reason}
        </Notice>
      )}
      <KeyValue
        items={[
          ['Monto', <strong>{amountOf(t.asset, t.amount)}</strong>],
          ['Red', NETWORK[t.rail]],
          ['Sentido', t.direction === 'IN' ? 'Entra a la mesa' : 'Sale de la mesa'],
          ['Cuenta de la mesa', t.account_code],
          ...(t.to_account_code ? ([['Cuenta de destino', t.to_account_code]] as [string, string][]) : []),
          ['Orden', t.order_id ? <a href={href(`ordenes/${t.order_id}`)}>#{t.order_number}</a> : '—'],
          ['Hash / referencia', <CopyValue value={t.external_ref} short={false} />],
          ...(t.counterparty_ref ? ([['Origen informado', <CopyValue value={t.counterparty_ref} />]] as [string, JSX.Element][]) : []),
          ...(t.rail !== 'BANK' ? ([['Confirmaciones', t.confirmations ?? '—']] as [string, string | number][]) : []),
          ['Enviada', dateTime(t.sent_at)],
          ['Última verificación', dateTime(t.last_checked_at)],
          ...(t.retry_of ? ([['Reintento de', <a href={href(`transferencias/${t.retry_of}`)}>transferencia anterior</a>]] as [string, JSX.Element][]) : []),
        ]}
      />
      <TransferActions t={t} onChange={refresh} />

      <h3>Observaciones de la red o el banco</h3>
      {!obs.data ? (
        obs.error ? <ErrorNotice error={obs.error} /> : <Loading />
      ) : obs.data.length === 0 ? (
        <EmptyState title="Sin observaciones todavía" />
      ) : (
        <ul className="plain-list">
          {obs.data.map((o) => {
            const out = OUTCOME[o.outcome] ?? { label: o.outcome, tone: 'neutral' as const };
            return (
              <li key={o.id}>
                <Badge tone={out.tone}>{out.label}</Badge>
                <span className="muted small">{o.source === 'BANK' ? 'Banco' : o.source === 'CHAIN' ? 'Red' : o.source}</span>
                {o.sandbox && <SimulatedTag>SIMULADA</SimulatedTag>}
                <span className="cell-sub">
                  {dateTime(o.observed_at)}
                  {o.note ? ` · ${o.note}` : ''}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      <h3>Historial</h3>
      <Timeline entries={t.history} map={TRANSFER_STATUS} />
    </Drawer>
  );
}
