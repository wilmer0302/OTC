import { useMemo, useState } from 'react';
import { counterparties, liquidity, orders } from '../../api/endpoints';
import type { CounterpartyRow, LedgerEntry, OrderDetail, OrderRow } from '../../api/types';
import { DemoTag } from '../../app/DemoTag';
import { href, navigate, replaceQuery } from '../../app/router';
import { useCan } from '../../app/session';
import { amountOf, cop, copPrice, dateTime, pct, usdt } from '../../lib/format';
import { useDebounced, useQuery } from '../../lib/hooks';
import { NETWORK, ORDER_STATUS, POLICY, PURPOSE, RESERVATION_STATUS, SIDE, SIDE_SHORT, TRANSFER_STATUS } from '../../lib/labels';
import { refError, refHint } from '../../lib/refs';
import { StatusBadge } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { CopyValue } from '../../ui/Copy';
import { Countdown } from '../../ui/Countdown';
import { DataTable, type Column } from '../../ui/DataTable';
import { Drawer } from '../../ui/Drawer';
import { ErrorNotice, useToast } from '../../ui/Feedback';
import { FilterBar, FilterSelect, SearchInput } from '../../ui/Form';
import { Card, KeyValue, Loading, Notice, PageHeader } from '../../ui/Layout';
import { useConfirm } from '../../ui/Modal';
import { Timeline } from '../../ui/Timeline';
import type { PageProps } from '../index';
import { TransferActions } from '../transferencias/TransferActions';
import { ReceiptModal } from './ReceiptModal';

const OPEN = ['CREADA', 'COBRO_EN_VERIFICACION', 'COBRO_CONFIRMADO', 'ENTREGA_AUTORIZADA', 'ENTREGA_ENVIADA', 'EN_REVISION'];
const FLOW = ['CREADA', 'COBRO_EN_VERIFICACION', 'COBRO_CONFIRMADO', 'ENTREGA_AUTORIZADA', 'ENTREGA_ENVIADA', 'COMPLETADA'];
const FLOW_LABEL = ['Esperando pago', 'Cobro en verificación', 'Por aprobar', 'Entrega autorizada', 'Entrega enviada', 'Completada'];

export default function Ordenes({ route }: PageProps) {
  const selected = route.path[1] ?? null;
  const status = route.query.get('estado') ?? 'abiertas';
  const client = route.query.get('cliente') ?? '';
  const [search, setSearch] = useState('');
  const q = useDebounced(search.trim().toLowerCase());
  const single = status !== 'abiertas' && status !== 'todas';
  const list = useQuery<OrderRow[]>(() => orders.list({ status: single ? status : undefined, counterpartyId: client || undefined }), [status, client], { refreshMs: 10000 });
  const clients = useQuery<CounterpartyRow[]>(() => counterparties.list(), []);
  const rows = useMemo(
    () =>
      list.data
        ?.filter((o) => status !== 'abiertas' || OPEN.includes(o.status))
        .filter((o) => !q || o.counterparty_name.toLowerCase().includes(q) || String(o.number) === q.replace('#', '')) ?? null,
    [list.data, q, status],
  );
  const setFilter = (k: string, v: string) => replaceQuery(['ordenes', selected].filter(Boolean).join('/'), { estado: status, cliente: client, [k]: v });

  const columns: Column<OrderRow>[] = [
    { key: 'n', header: 'N.º', render: (o) => <span className="cell-main">#{o.number}</span>, width: '70px' },
    { key: 'c', header: 'Cliente', render: (o) => o.counterparty_name },
    { key: 's', header: 'Operación', secondary: true, render: (o) => <span title={SIDE[o.side]}>{SIDE_SHORT[o.side]} · {o.network === 'TRON' ? 'TRC20' : 'BEP20'}</span> },
    { key: 'u', header: 'USDT', align: 'right', render: (o) => usdt(o.usdt_amount) },
    { key: 't', header: 'Total', align: 'right', render: (o) => cop(o.total_cop) },
    { key: 'st', header: 'Estado', render: (o) => <StatusBadge map={ORDER_STATUS} status={o.status} /> },
    {
      key: 'd',
      header: 'Plazo de pago / creada',
      secondary: true,
      render: (o) => (o.status === 'CREADA' ? <Countdown until={o.payment_deadline} expiredLabel="Plazo vencido" /> : <span className="muted">{dateTime(o.created_at)}</span>),
    },
  ];

  return (
    <>
      <PageHeader title="Órdenes y ejecución" subtitle="Desde el pago del cliente hasta la entrega confirmada. Cada paso lo registra y verifica el servidor." />
      <div className={selected ? 'split' : ''}>
        <Card flush title={<>Órdenes <DemoTag /></>}>
          <div className="card-body">
            <FilterBar right={<Button size="sm" onClick={list.reload} busy={list.loading}>Actualizar</Button>}>
              <SearchInput value={search} onChange={setSearch} placeholder="Cliente o número" />
              <FilterSelect
                label="Estado"
                value={status}
                allLabel="Todas"
                onChange={(v) => setFilter('estado', v || 'todas')}
                options={[{ value: 'abiertas', label: 'Abiertas (en curso)' }, ...Object.entries(ORDER_STATUS).map(([k, v]) => ({ value: k, label: v.label }))]}
              />
              <FilterSelect label="Cliente" value={client} onChange={(v) => setFilter('cliente', v)} options={(clients.data ?? []).map((c) => ({ value: c.id, label: c.legal_name }))} />
            </FilterBar>
          </div>
          <DataTable
            columns={columns}
            rows={rows}
            rowKey={(o) => o.id}
            loading={list.loading}
            error={list.error}
            selectedKey={selected}
            rowHref={(o) => href(`ordenes/${o.id}`, { estado: status, cliente: client })}
            empty={{ title: 'No hay órdenes con estos filtros', hint: 'Una orden nace cuando el cliente acepta una cotización.' }}
          />
        </Card>
        {selected && <OrderDrawer key={selected} id={selected} onClose={() => navigate('ordenes', { estado: status, cliente: client })} onChange={list.reload} />}
      </div>
    </>
  );
}

function Steps({ status, reviewFrom }: { status: string; reviewFrom: string | null }) {
  const at = status === 'EN_REVISION' ? FLOW.indexOf(reviewFrom ?? 'CREADA') : FLOW.indexOf(status);
  const ended = status === 'CANCELADA' || status === 'VENCIDA';
  return (
    <div className="steps" aria-label="Avance de la orden">
      {FLOW.map((s, i) => {
        const cls = ended ? '' : i < at || status === 'COMPLETADA' ? 'is-done' : i === at ? (status === 'EN_REVISION' ? 'is-problem' : 'is-current') : '';
        return (
          <div key={s} className={`step ${cls}`}>
            {FLOW_LABEL[i]}
          </div>
        );
      })}
    </div>
  );
}

function OrderDrawer({ id, onClose, onChange }: { id: string; onClose: () => void; onChange: () => void }) {
  const can = useCan();
  const toast = useToast();
  const { confirm, dialog } = useConfirm();
  const { data: o, error, reload } = useQuery<OrderDetail>(() => orders.get(id), [id], { refreshMs: 8000 });
  const ledger = useQuery<LedgerEntry[]>(() => liquidity.ledger({ orderId: id }), [id, o?.status]);
  const [receipt, setReceipt] = useState(false);
  const refresh = () => {
    reload();
    onChange();
  };

  if (!o) return <Drawer title="Orden" onClose={onClose}>{error ? <ErrorNotice error={error} /> : <Loading />}</Drawer>;

  const clientPaysCop = o.side === 'SELL';
  const collectRail = clientPaysCop ? 'BANK' : o.network;
  const clientPays = clientPaysCop ? cop(o.total_cop) : usdt(o.usdt_amount);
  const clientGets = clientPaysCop ? usdt(o.usdt_amount) : cop(o.total_cop);
  const delivery = o.transfers.find((t) => t.purpose === 'ENTREGA' && !['FALLIDA', 'CANCELADA'].includes(t.status)) ?? o.transfers.filter((t) => t.purpose === 'ENTREGA').at(-1);
  const collection = o.transfers.find((t) => t.purpose === 'COBRO' && t.status !== 'FALLIDA') ?? o.transfers.filter((t) => t.purpose === 'COBRO').at(-1);
  const policy = o.approval_policy.policy === 'THRESHOLD' ? `${POLICY.THRESHOLD} (${cop(o.approval_policy.thresholdCop)})` : POLICY[o.approval_policy.policy];

  const registerPayment = () =>
    confirm({
      title: `Registrar pago del cliente · orden #${o.number}`,
      intro: clientPaysCop
        ? 'Registra la referencia de la consignación del cliente. El sistema la verifica con el banco antes de confirmar el cobro.'
        : 'Registra el hash de la transacción con la que el cliente envió los USDT. El sistema la verifica en la red.',
      summary: [
        ['El cliente debe pagar', clientPays],
        ['Plazo', <Countdown until={o.payment_deadline} expiredLabel="Vencido: la orden irá a revisión" />],
      ],
      fields: [
        { name: 'reference', label: clientPaysCop ? 'Referencia bancaria' : 'Hash de la transacción', hint: refHint(collectRail), mono: true, validate: (v) => refError(collectRail, v) },
        { name: 'fromRef', label: clientPaysCop ? 'Cuenta de origen del cliente' : 'Dirección de origen del cliente', optional: true, hint: 'Opcional: ayuda a conciliar.', mono: true },
      ],
      confirmLabel: 'Registrar pago',
      onConfirm: async ({ fields, idempotencyKey }) => {
        await orders.registerPayment(id, fields.reference, fields.fromRef || null, { idempotencyKey });
        toast(`Pago registrado en la orden #${o.number}: queda en verificación`);
        refresh();
      },
    });

  const approve = () =>
    confirm({
      title: `Aprobar entrega · orden #${o.number}`,
      intro: 'El cobro está confirmado. Al aprobar se autoriza la salida de fondos de la mesa hacia el cliente.',
      summary: [
        ['Cliente', o.counterparty_name],
        ['La mesa entrega', <strong>{clientGets}</strong>],
        ['Por la red', clientPaysCop ? NETWORK[o.network] : NETWORK.BANK],
        ['Política', policy],
        ['Aprobaciones', `${o.approvals.length} de ${o.required_approvals}`],
      ],
      reason: { label: 'Nota', optional: true },
      stepUp: true,
      acknowledge: 'Revisé el cobro confirmado, el monto y el destino aprobado del cliente.',
      confirmLabel: 'Aprobar entrega',
      onConfirm: async ({ reason, mfaCode, idempotencyKey }) => {
        await orders.approve(id, reason || null, { idempotencyKey, mfaCode });
        toast(`Aprobación registrada en la orden #${o.number}`);
        refresh();
      },
    });

  const cancel = () =>
    confirm({
      title: `Cancelar orden #${o.number}`,
      intro: 'Solo si el cliente no ha pagado. Se libera la liquidez reservada.',
      danger: true,
      reason: { label: 'Motivo' },
      confirmLabel: 'Cancelar orden',
      onConfirm: async ({ reason, idempotencyKey }) => {
        await orders.cancel(id, reason, { idempotencyKey });
        toast(`Orden #${o.number} cancelada`);
        refresh();
      },
    });

  const review = () =>
    confirm({
      title: `Enviar a revisión · orden #${o.number}`,
      intro: 'La orden se detiene hasta que administración la revise. Úsalo si algo no cuadra.',
      danger: true,
      reason: { label: '¿Qué no cuadra?' },
      confirmLabel: 'Enviar a revisión',
      onConfirm: async ({ reason, idempotencyKey }) => {
        await orders.review(id, reason, { idempotencyKey });
        toast(`Orden #${o.number} en revisión`, 'info');
        refresh();
      },
    });

  const resolve = (action: 'RESUME' | 'CANCEL') =>
    confirm({
      title: action === 'RESUME' ? 'Reanudar la orden' : 'Cancelar la orden en revisión',
      intro:
        action === 'RESUME'
          ? `La orden vuelve a «${ORDER_STATUS[o.review_from ?? 'CREADA']?.label}» y sigue su curso.`
          : 'Solo es posible si no hay dinero en tránsito. Se libera la liquidez reservada.',
      danger: action === 'CANCEL',
      reason: { label: 'Qué se verificó' },
      stepUp: true,
      confirmLabel: action === 'RESUME' ? 'Reanudar' : 'Cancelar orden',
      onConfirm: async ({ reason, mfaCode, idempotencyKey }) => {
        await orders.resolveReview(id, action, reason, { idempotencyKey, mfaCode });
        toast('Revisión resuelta');
        refresh();
      },
    });

  return (
    <Drawer
      title={`Orden #${o.number}`}
      onClose={onClose}
      actions={
        <Button size="sm" onClick={() => setReceipt(true)}>
          Comprobante
        </Button>
      }
    >
      <StatusBadge map={ORDER_STATUS} status={o.status} />
      <Steps status={o.status} reviewFrom={o.review_from} />
      {o.status_reason && (
        <Notice tone={o.status === 'EN_REVISION' ? 'danger' : 'neutral'} title={o.status === 'EN_REVISION' ? 'Motivo de la revisión' : 'Motivo'}>
          {o.status_reason}
        </Notice>
      )}

      <KeyValue
        items={[
          ['Cliente', <a href={href(`clientes/${o.counterparty_id}`)}>{o.counterparty_name}</a>],
          ['Operación', `${SIDE[o.side]} · ${NETWORK[o.network]}`],
          ['Precio por USDT', copPrice(o.unit_price_cop)],
          ['El cliente entrega', <strong>{clientPays}</strong>],
          ['El cliente recibe', <strong>{clientGets}</strong>],
          ['Plazo de pago', o.status === 'CREADA' ? <><Countdown until={o.payment_deadline} expiredLabel="Vencido" /> · {dateTime(o.payment_deadline)}</> : dateTime(o.payment_deadline)],
          ['Aprobación', `${policy} · ${o.approvals.length} de ${o.required_approvals}`],
        ]}
      />
      <div className="internal-box">
        <span className="label">Interno · no se comparte con el cliente</span>
        <KeyValue
          items={[
            ['TRM usada', `${copPrice(o.trm_rate)} · ${o.trm_source}`],
            ['Margen por USDT', copPrice(o.margin_cop)],
            ['Comisión', `${pct(o.commission_rate)} · ${cop(o.commission_cop)}`],
            ['Margen total', cop(o.margin_total_cop)],
          ]}
        />
      </div>

      {o.status === 'CREADA' && can('payment.register') && (
        <div className="action-panel">
          <h4>1. Registrar el pago del cliente</h4>
          <p>Cuando el cliente informe que pagó, registra la referencia o el hash. El cobro no se da por hecho hasta que el banco o la red lo confirmen.</p>
          <Button variant="primary" onClick={registerPayment}>
            Registrar pago
          </Button>
        </div>
      )}
      {o.status === 'COBRO_EN_VERIFICACION' && collection && (
        <>
          <Notice tone="info" title="Verificando el cobro">
            {clientPaysCop ? 'El sistema consulta el banco.' : 'El sistema consulta la red.'} Referencia: <CopyValue value={collection.external_ref} />
          </Notice>
          <TransferActions t={collection} onChange={refresh} />
        </>
      )}
      {o.status === 'COBRO_CONFIRMADO' && (
        <div className="action-panel">
          <h4>2. Aprobar la entrega</h4>
          <p>
            Cobro confirmado. {o.approvals.length} de {o.required_approvals} aprobaciones.
            {o.approvals.length > 0 && ` Aprobó: ${o.approvals.map((a) => a.approved_by_name).join(', ')}.`}
          </p>
          {can('order.approve') ? (
            <Button variant="primary" onClick={approve}>
              Aprobar entrega
            </Button>
          ) : (
            <span className="muted small">La aprueba tesorería o administración.</span>
          )}
        </div>
      )}
      {(o.status === 'ENTREGA_AUTORIZADA' || o.status === 'ENTREGA_ENVIADA') && delivery && (
        <>
          <h3>3. Entrega al cliente</h3>
          <div className="transfer-mini">
            <a href={href(`transferencias/${delivery.id}`)}>Transferencia #{delivery.number}</a> <StatusBadge map={TRANSFER_STATUS} status={delivery.status} />
            {delivery.external_ref && <CopyValue value={delivery.external_ref} />}
          </div>
          <TransferActions t={delivery} onChange={refresh} />
        </>
      )}
      {o.status === 'COMPLETADA' && <Notice tone="success" title="Orden completada">Ambas partes recibieron sus fondos; el libro contable quedó registrado.</Notice>}

      {o.status === 'EN_REVISION' && can('review.resolve') && (
        <div className="action-panel">
          <h4>Resolver revisión</h4>
          <p>Antes de decidir, revisa las transferencias y sus observaciones.</p>
          <div className="action-row">
            <Button onClick={() => resolve('RESUME')}>Reanudar</Button>
            <Button variant="danger" onClick={() => resolve('CANCEL')}>
              Cancelar orden
            </Button>
          </div>
        </div>
      )}
      <div className="action-row">
        {o.status === 'CREADA' && can('order.cancel') && (
          <Button variant="ghost" onClick={cancel}>
            Cancelar orden
          </Button>
        )}
        {OPEN.includes(o.status) && o.status !== 'EN_REVISION' && can('order.review') && (
          <Button variant="ghost" onClick={review}>
            Enviar a revisión
          </Button>
        )}
      </div>

      <h3>Transferencias</h3>
      {o.transfers.length === 0 ? (
        <p className="muted">Aún no hay movimientos de dinero.</p>
      ) : (
        <ul className="plain-list">
          {o.transfers.map((t) => (
            <li key={t.id}>
              <a href={href(`transferencias/${t.id}`)}>
                {PURPOSE[t.purpose]} #{t.number}
              </a>
              <StatusBadge map={TRANSFER_STATUS} status={t.status} />
              <span className="amount">{amountOf(t.asset, t.amount)}</span>
              <span className="cell-sub">
                {NETWORK[t.rail]} · {t.external_ref ? <CopyValue value={t.external_ref} /> : 'sin referencia'}
              </span>
            </li>
          ))}
        </ul>
      )}

      <h3>Liquidez reservada</h3>
      {o.reservations.length === 0 ? (
        <p className="muted">Sin reservas.</p>
      ) : (
        <ul className="plain-list">
          {o.reservations.map((r) => (
            <li key={r.id}>
              <span>{r.account}</span> <StatusBadge map={RESERVATION_STATUS} status={r.status} />
              <span className="amount">{r.amount}</span>
            </li>
          ))}
        </ul>
      )}

      <h3>Asientos contables</h3>
      {!ledger.data?.length ? (
        <p className="muted">Sin asientos todavía: se registran cuando el banco o la red confirman cada movimiento.</p>
      ) : (
        <ul className="plain-list">
          {ledger.data.map((e) => (
            <li key={e.id}>
              <strong>#{e.seq}</strong> {e.description ?? e.kind} <span className="muted small">{dateTime(e.created_at)}</span>
              <span className="cell-sub">{e.lines.map((l) => `${l.account} ${String(l.amount).startsWith('-') ? '' : '+'}${amountOf(l.asset, l.amount)}`).join(' · ')}</span>
            </li>
          ))}
        </ul>
      )}

      <h3>Historial</h3>
      <Timeline entries={o.history} map={ORDER_STATUS} />
      {dialog}
      {receipt && <ReceiptModal orderId={id} onClose={() => setReceipt(false)} />}
    </Drawer>
  );
}
