import { useMemo, useState } from 'react';
import { quotes, requests } from '../../api/endpoints';
import type { QuoteRow, RequestDetail } from '../../api/types';
import { DemoTag } from '../../app/DemoTag';
import { href, navigate, replaceQuery } from '../../app/router';
import { cop, copPrice, dateTime, usdt } from '../../lib/format';
import { useDebounced, useQuery } from '../../lib/hooks';
import { NETWORK, QUOTE_STATUS, SIDE, SIDE_SHORT } from '../../lib/labels';
import { StatusBadge } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { Countdown } from '../../ui/Countdown';
import { DataTable, type Column } from '../../ui/DataTable';
import { Drawer } from '../../ui/Drawer';
import { ErrorNotice } from '../../ui/Feedback';
import { FilterBar, FilterSelect, SearchInput } from '../../ui/Form';
import { Card, KeyValue, Loading, Notice, PageHeader } from '../../ui/Layout';
import type { PageProps } from '../index';
import { QuotePanel } from './QuotePanel';

export default function Cotizaciones({ route }: PageProps) {
  const selected = route.path[1] ?? null;
  const status = route.query.get('estado') ?? 'VIGENTE';
  const [search, setSearch] = useState('');
  const q = useDebounced(search.trim().toLowerCase());
  const list = useQuery<QuoteRow[]>(() => quotes.list({ status: status === 'TODAS' ? undefined : status }), [status], { refreshMs: 10000 });
  const rows = useMemo(
    () =>
      list.data?.filter(
        (r) => !q || r.counterparty_name.toLowerCase().includes(q) || [r.number, r.request_number, r.order_number].map(String).includes(q.replace('#', '')),
      ) ?? null,
    [list.data, q],
  );

  const columns: Column<QuoteRow>[] = [
    { key: 'n', header: 'N.º', render: (r) => <span className="cell-main">#{r.number}</span>, width: '70px' },
    { key: 'c', header: 'Cliente', render: (r) => <>{r.counterparty_name}<span className="cell-sub">Solicitud #{r.request_number}</span></> },
    { key: 's', header: 'Operación', secondary: true, render: (r) => `${SIDE_SHORT[r.side]} · ${r.network === 'TRON' ? 'TRC20' : 'BEP20'}` },
    { key: 'a', header: 'Monto', align: 'right', render: (r) => usdt(r.usdt_amount) },
    { key: 'p', header: 'Precio por USDT', align: 'right', render: (r) => copPrice(r.unit_price_cop) },
    { key: 't', header: 'Total', align: 'right', render: (r) => <strong>{cop(r.total_cop)}</strong> },
    { key: 'st', header: 'Estado', render: (r) => <StatusBadge map={QUOTE_STATUS} status={r.status} title={r.status_reason ?? undefined} /> },
    {
      key: 'v',
      header: 'Vence / orden',
      render: (r) =>
        r.status === 'VIGENTE' ? (
          <Countdown until={r.expires_at} />
        ) : r.order_id ? (
          <a href={href(`ordenes/${r.order_id}`)} onClick={(e) => e.stopPropagation()}>
            Orden #{r.order_number}
          </a>
        ) : (
          <span className="muted">{dateTime(r.expires_at)}</span>
        ),
    },
  ];

  return (
    <>
      <PageHeader
        title="Cotizaciones"
        subtitle="Precios ofrecidos a los clientes. El cliente ve el precio por USDT todo incluido y el total; la TRM y el margen son internos."
      />
      <div className={selected ? 'split' : ''}>
        <Card flush title={<>Cotizaciones <DemoTag /></>}>
          <div className="card-body">
            <FilterBar right={<Button size="sm" onClick={list.reload} busy={list.loading}>Actualizar</Button>}>
              <SearchInput value={search} onChange={setSearch} placeholder="Cliente, cotización, solicitud u orden" />
              <FilterSelect
                label="Estado"
                value={status === 'TODAS' ? '' : status}
                allLabel="Todas"
                onChange={(v) => replaceQuery(['cotizaciones', selected].filter(Boolean).join('/'), { estado: v || 'TODAS' })}
                options={Object.entries(QUOTE_STATUS).map(([k, v]) => ({ value: k, label: v.label }))}
              />
            </FilterBar>
          </div>
          <DataTable
            columns={columns}
            rows={rows}
            rowKey={(r) => r.id}
            loading={list.loading}
            error={list.error}
            selectedKey={selected}
            rowHref={(r) => href(`cotizaciones/${r.id}`, { estado: status })}
            empty={{ title: status === 'VIGENTE' ? 'No hay cotizaciones vigentes' : 'No hay cotizaciones con estos filtros', hint: <>Se cotiza desde una solicitud validada en <a href={href('solicitudes')}>Solicitudes OTC</a>.</> }}
          />
        </Card>
        {selected && <QuoteDrawer key={selected} id={selected} row={list.data?.find((r) => r.id === selected)} onClose={() => navigate('cotizaciones', { estado: status })} onChange={list.reload} />}
      </div>
    </>
  );
}

function QuoteDrawer({ id, row, onClose, onChange }: { id: string; row?: QuoteRow; onClose: () => void; onChange: () => void }) {
  // La cotización completa (con el detalle interno) viene con su solicitud.
  const all = useQuery<QuoteRow[]>(row ? null : () => quotes.list(), [row]);
  const requestId = row?.request_id ?? all.data?.find((r) => r.id === id)?.request_id;
  const req = useQuery<RequestDetail>(requestId ? () => requests.get(requestId) : null, [requestId], { refreshMs: 10000 });
  const quote = req.data?.quotes.find((x) => x.id === id);

  if (all.data && !requestId) return <Drawer title="Cotización" onClose={onClose}><Notice tone="warning">La cotización no existe.</Notice></Drawer>;
  if (!req.data || !quote) return <Drawer title="Cotización" onClose={onClose}>{req.error || all.error ? <ErrorNotice error={req.error ?? all.error} /> : <Loading />}</Drawer>;
  const r = req.data;
  return (
    <Drawer title={`Cotización #${quote.number}`} onClose={onClose}>
      <KeyValue
        items={[
          ['Cliente', r.counterparty_name],
          ['Solicitud', <a href={href(`solicitudes/${r.id}`)}>#{r.number}</a>],
          ['Operación', `${SIDE[quote.side]} · ${NETWORK[r.network]}`],
          ['Creada', dateTime(quote.created_at)],
          ['Vence', dateTime(quote.expires_at)],
          ...(r.order && quote.status === 'ACEPTADA' ? ([['Orden', <a href={href(`ordenes/${r.order.id}`)}>#{r.order.number}</a>]] as [string, JSX.Element][]) : []),
        ]}
      />
      <QuotePanel
        quote={quote}
        counterparty={r.counterparty_name}
        network={NETWORK[r.network]}
        onChange={() => {
          req.reload();
          onChange();
        }}
      />
    </Drawer>
  );
}
