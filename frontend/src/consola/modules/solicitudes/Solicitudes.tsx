import { useMemo, useState } from 'react';
import { counterparties, requests } from '../../api/endpoints';
import type { CounterpartyRow, RequestDetail, RequestRow } from '../../api/types';
import { DemoTag } from '../../app/DemoTag';
import { href, navigate, replaceQuery } from '../../app/router';
import { useCan } from '../../app/session';
import { copPrice, dateTime, usdt } from '../../lib/format';
import { useDebounced, useQuery } from '../../lib/hooks';
import { NETWORK, ORDER_STATUS, QUOTE_STATUS, REQUEST_STATUS, SIDE, SIDE_SHORT } from '../../lib/labels';
import { StatusBadge } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { Countdown } from '../../ui/Countdown';
import { DataTable, type Column } from '../../ui/DataTable';
import { Drawer } from '../../ui/Drawer';
import { ErrorNotice, useToast } from '../../ui/Feedback';
import { FilterBar, FilterSelect, SearchInput } from '../../ui/Form';
import { Card, KeyValue, Loading, Notice, PageHeader } from '../../ui/Layout';
import { useConfirm } from '../../ui/Modal';
import { Timeline } from '../../ui/Timeline';
import { QuotePanel } from '../cotizaciones/QuotePanel';
import type { PageProps } from '../index';
import { NewRequestDialog } from './NewRequestDialog';

const OPEN = ['CREADA', 'VALIDADA', 'COTIZADA'];

export default function Solicitudes({ route }: PageProps) {
  const can = useCan();
  const selected = route.path[1] ?? null;
  const status = route.query.get('estado') ?? '';
  const client = route.query.get('cliente') ?? '';
  const [search, setSearch] = useState('');
  const [creating, setCreating] = useState(false);
  const q = useDebounced(search.trim().toLowerCase());

  const list = useQuery<RequestRow[]>(() => requests.list({ status: status || undefined, counterpartyId: client || undefined }), [status, client], { refreshMs: 15000 });
  const clients = useQuery<CounterpartyRow[]>(() => counterparties.list(), []);
  const rows = useMemo(
    () => list.data?.filter((r) => !q || r.counterparty_name.toLowerCase().includes(q) || String(r.number) === q.replace('#', '')) ?? null,
    [list.data, q],
  );
  const setFilter = (k: string, v: string) => replaceQuery(['solicitudes', selected].filter(Boolean).join('/'), { estado: status, cliente: client, [k]: v });

  const columns: Column<RequestRow>[] = [
    { key: 'n', header: 'N.º', render: (r) => <span className="cell-main">#{r.number}</span>, width: '70px' },
    { key: 'c', header: 'Cliente', render: (r) => r.counterparty_name },
    { key: 's', header: 'Operación', render: (r) => <span title={SIDE[r.side]}>{SIDE_SHORT[r.side]} · {r.network === 'TRON' ? 'TRC20' : 'BEP20'}</span> },
    { key: 'a', header: 'Monto', align: 'right', render: (r) => usdt(r.usdt_amount) },
    { key: 'st', header: 'Estado', render: (r) => <StatusBadge map={REQUEST_STATUS} status={r.status} title={r.status_reason ?? undefined} /> },
    { key: 'e', header: 'Vence', secondary: true, render: (r) => (OPEN.includes(r.status) ? <Countdown until={r.expires_at} /> : <span className="muted">—</span>) },
    { key: 'd', header: 'Creada', secondary: true, render: (r) => <span className="muted">{dateTime(r.created_at)}</span> },
  ];

  return (
    <>
      <PageHeader
        title="Solicitudes OTC"
        subtitle="Pedidos de compra o venta de USDT. El servidor valida KYC, destino, límites y liquidez antes de permitir cotizar."
        actions={
          can('request.create') && (
            <Button variant="primary" onClick={() => setCreating(true)}>
              Nueva solicitud
            </Button>
          )
        }
      />
      <div className={selected ? 'split' : ''}>
        <Card flush title={<>Solicitudes <DemoTag /></>}>
          <div className="card-section">
            <FilterBar right={<Button size="sm" onClick={list.reload} busy={list.loading}>Actualizar</Button>}>
              <SearchInput value={search} onChange={setSearch} placeholder="Cliente o número" />
              <FilterSelect label="Estado" value={status} onChange={(v) => setFilter('estado', v)} options={Object.entries(REQUEST_STATUS).map(([k, v]) => ({ value: k, label: v.label }))} />
              <FilterSelect label="Cliente" value={client} onChange={(v) => setFilter('cliente', v)} options={(clients.data ?? []).map((c) => ({ value: c.id, label: c.legal_name }))} />
            </FilterBar>
          </div>
          <DataTable
            columns={columns}
            rows={rows}
            rowKey={(r) => r.id}
            loading={list.loading}
            error={list.error}
            selectedKey={selected}
            rowHref={(r) => href(`solicitudes/${r.id}`, { estado: status, cliente: client })}
            empty={{ title: 'No hay solicitudes con estos filtros', hint: can('request.create') ? 'Registra una con «Nueva solicitud».' : undefined }}
          />
        </Card>
        {selected && <RequestDrawer key={selected} id={selected} onClose={() => navigate('solicitudes', { estado: status, cliente: client })} onChange={list.reload} />}
      </div>
      {creating && <NewRequestDialog onClose={() => setCreating(false)} onCreated={(r) => navigate(`solicitudes/${r.id}`)} />}
    </>
  );
}

function RequestDrawer({ id, onClose, onChange }: { id: string; onClose: () => void; onChange: () => void }) {
  const can = useCan();
  const toast = useToast();
  const { confirm, dialog } = useConfirm();
  const { data: r, error, reload } = useQuery<RequestDetail>(() => requests.get(id), [id], { refreshMs: 10000 });
  const [quoting, setQuoting] = useState(false);
  const [quoteError, setQuoteError] = useState<unknown>(null);
  const refresh = () => {
    reload();
    onChange();
  };

  if (!r) return <Drawer title="Solicitud" onClose={onClose}>{error ? <ErrorNotice error={error} /> : <Loading />}</Drawer>;
  const live = r.quotes.find((x) => x.status === 'VIGENTE');
  const quotable = r.status === 'VALIDADA' || r.status === 'COTIZADA';

  const quote = async () => {
    setQuoting(true);
    setQuoteError(null);
    try {
      // Cada clic es una cotización nueva (si había una vigente, el servidor la reemplaza).
      await requests.quote(id, { idempotencyKey: crypto.randomUUID() });
      refresh();
    } catch (e) {
      setQuoteError(e);
    } finally {
      setQuoting(false);
    }
  };

  const cancel = () =>
    confirm({
      title: `Cancelar solicitud #${r.number}`,
      intro: 'La solicitud se cierra y ya no se puede cotizar. Si tiene una cotización vigente, se retira.',
      danger: true,
      confirmLabel: 'Cancelar solicitud',
      reason: { label: 'Motivo', placeholder: 'Por ejemplo: el cliente desistió' },
      onConfirm: async ({ reason, idempotencyKey }) => {
        await requests.cancel(id, reason, { idempotencyKey });
        toast(`Solicitud #${r.number} cancelada`);
        refresh();
      },
    });

  return (
    <Drawer title={`Solicitud #${r.number}`} onClose={onClose}>
      <StatusBadge map={REQUEST_STATUS} status={r.status} />
      {r.status === 'RECHAZADA' && r.status_reason && (
        <Notice tone="danger" title="Motivos del rechazo">
          {r.status_reason}
        </Notice>
      )}
      <KeyValue
        items={[
          ['Cliente', <a href={href(`clientes/${r.counterparty_id}`)}>{r.counterparty_name}</a>],
          ['Operación', SIDE[r.side]],
          ['Monto', usdt(r.usdt_amount)],
          ['Red', NETWORK[r.network]],
          ['Creada', dateTime(r.created_at)],
          ['Vence', OPEN.includes(r.status) ? <><Countdown until={r.expires_at} /> · {dateTime(r.expires_at)}</> : dateTime(r.expires_at)],
        ]}
      />
      {r.order && (
        <Notice tone="success" title={`Orden #${r.order.number}`}>
          <StatusBadge map={ORDER_STATUS} status={r.order.status} /> <a href={href(`ordenes/${r.order.id}`)}>Abrir orden →</a>
        </Notice>
      )}

      {live && <QuotePanel quote={live} counterparty={r.counterparty_name} network={NETWORK[r.network]} onChange={refresh} />}

      {quotable && can('quote.create') && (
        <div className="action-panel">
          <h4>{live ? 'Volver a cotizar' : 'Cotizar'}</h4>
          <p>El precio sale de la TRM de hoy, el margen y la comisión configurados. {live ? 'La cotización vigente se reemplaza.' : ''}</p>
          <Button variant={live ? 'secondary' : 'primary'} onClick={quote} busy={quoting}>
            {live ? 'Cotizar de nuevo' : 'Generar cotización'}
          </Button>
          <ErrorNotice error={quoteError} />
        </div>
      )}

      {OPEN.includes(r.status) && can('request.cancel') && (
        <div className="action-row">
          <Button variant="ghost" onClick={cancel}>
            Cancelar solicitud
          </Button>
        </div>
      )}

      {r.quotes.length > 0 && (
        <>
          <h3>Cotizaciones</h3>
          <ul className="plain-list">
            {r.quotes.map((x) => (
              <li key={x.id}>
                <a href={href(`cotizaciones/${x.id}`)}>#{x.number}</a> <StatusBadge map={QUOTE_STATUS} status={x.status} />
                <span className="cell-sub">
                  {copPrice(x.unit_price_cop)} por USDT · {dateTime(x.created_at)}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
      <h3>Historial</h3>
      <Timeline entries={r.history} map={REQUEST_STATUS} />
      {dialog}
    </Drawer>
  );
}
