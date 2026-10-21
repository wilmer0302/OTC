import { useState } from 'react';
import { system as systemApi } from '../../api/endpoints';
import type { Dashboard } from '../../api/types';
import { DemoTag } from '../../app/DemoTag';
import { href } from '../../app/router';
import { useCan } from '../../app/session';
import { cop, copPrice, dateOnly, dateTime, usdt } from '../../lib/format';
import { useQuery } from '../../lib/hooks';
import { ORDER_STATUS, REQUEST_STATUS, SIDE, type Tone } from '../../lib/labels';
import { StatusBadge } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { ErrorNotice } from '../../ui/Feedback';
import { Amount, Card, EmptyState, Grid, Loading, Notice, PageHeader, StatTile } from '../../ui/Layout';
import { TrmDialog } from '../configuracion/TrmDialog';

const OPEN_ORDERS = ['CREADA', 'COBRO_EN_VERIFICACION', 'COBRO_CONFIRMADO', 'ENTREGA_AUTORIZADA', 'ENTREGA_ENVIADA', 'EN_REVISION'];
const OPEN_REQUESTS = ['CREADA', 'VALIDADA', 'COTIZADA'];

// Colas de trabajo: qué espera a alguien, dónde se atiende y con qué urgencia.
const QUEUES: { key: keyof Dashboard['attention']; label: string; link: string; tone: Tone }[] = [
  { key: 'ordersAwaitingApproval', label: 'Órdenes con cobro confirmado por aprobar', link: href('ordenes', { estado: 'COBRO_CONFIRMADO' }), tone: 'info' },
  { key: 'deliveriesToSign', label: 'Entregas autorizadas por firmar o registrar', link: href('transferencias', { estado: 'AUTORIZADA' }), tone: 'info' },
  { key: 'ordersInReview', label: 'Órdenes en revisión', link: href('ordenes', { estado: 'EN_REVISION' }), tone: 'danger' },
  { key: 'transfersInReview', label: 'Transferencias en revisión', link: href('transferencias', { estado: 'EN_REVISION' }), tone: 'danger' },
  { key: 'transfersFailed', label: 'Entregas fallidas sin reintento', link: href('transferencias', { estado: 'FALLIDA' }), tone: 'danger' },
  { key: 'reconWithDifferences', label: 'Conciliaciones con diferencias', link: href('conciliaciones', { estado: 'CON_DIFERENCIAS' }), tone: 'danger' },
  { key: 'adjustmentsProposed', label: 'Ajustes contables por aprobar', link: href('conciliaciones', { vista: 'ajustes' }), tone: 'warning' },
  { key: 'destinationsProposed', label: 'Cuentas o billeteras de clientes por aprobar', link: href('clientes', { vista: 'destinos' }), tone: 'warning' },
  { key: 'kycPending', label: 'Clientes con KYC pendiente', link: href('clientes', { kyc: 'PENDIENTE' }), tone: 'warning' },
  { key: 'limitChangesProposed', label: 'Cambios de límites por aprobar', link: href('configuracion', { vista: 'limites' }), tone: 'warning' },
];

export default function Inicio() {
  const can = useCan();
  const { data, error, loading, reload } = useQuery<Dashboard>(() => systemApi.dashboard(), [], { refreshMs: 30000 });
  const [trmOpen, setTrmOpen] = useState(false);

  if (!data) return loading ? <Loading /> : <ErrorNotice error={error} />;

  const cop$ = data.liquidity.find((l) => l.asset === 'COP');
  const usdt$ = data.liquidity.find((l) => l.asset === 'USDT');
  const openOrders = OPEN_ORDERS.reduce((s, k) => s + (data.counts.orders[k] ?? 0), 0);
  const openRequests = OPEN_REQUESTS.reduce((s, k) => s + (data.counts.requests[k] ?? 0), 0);
  const doneOrders = data.completedToday.reduce((s, r) => s + r.orders, 0);
  const pending = QUEUES.filter((q) => data.attention[q.key] > 0);

  return (
    <>
      <PageHeader
        title="Inicio"
        subtitle={<>Operación del {dateOnly(data.today)} · se actualiza cada 30 segundos</>}
        actions={
          <Button onClick={reload} busy={loading}>
            Actualizar
          </Button>
        }
      />

      {!data.trm && (
        <Notice tone="warning" title="No hay TRM cargada para hoy">
          Sin TRM del día el sistema no cotiza.{' '}
          {can('trm.record') ? (
            <Button size="sm" variant="primary" onClick={() => setTrmOpen(true)}>
              Cargar TRM
            </Button>
          ) : (
            'Pide a tesorería o administración que la cargue.'
          )}
        </Notice>
      )}

      <div className="tiles">
        <StatTile
          label="TRM de hoy"
          value={data.trm ? copPrice(data.trm.rate) : 'Sin TRM'}
          tone={data.trm ? undefined : 'warning'}
          hint={
            data.trm ? (
              <>
                {data.trm.source} · {dateTime(data.trm.loadedAt)}
                {data.trm.simulated && <span className="sim-tag">SIMULADA</span>}
              </>
            ) : (
              'No se puede cotizar'
            )
          }
        />
        <StatTile
          label="Pesos disponibles"
          value={cop(cop$?.available ?? '0')}
          hint={
            <>
              Saldo {cop(cop$?.balance ?? '0')} · reservado {cop(cop$?.reserved ?? '0')} <DemoTag />
            </>
          }
          href={href('liquidez')}
        />
        <StatTile
          label="USDT disponibles"
          value={usdt(usdt$?.available ?? '0')}
          hint={
            <>
              Saldo {usdt(usdt$?.balance ?? '0')} · reservado {usdt(usdt$?.reserved ?? '0')} <DemoTag />
            </>
          }
          href={href('liquidez')}
        />
        <StatTile label="Órdenes abiertas" value={openOrders} hint={`${openRequests} solicitudes abiertas`} href={href('ordenes', { estado: 'abiertas' })} />
        <StatTile label="Completadas hoy" value={doneOrders} tone={doneOrders ? 'success' : undefined} hint="Ambas partes recibieron sus fondos" />
      </div>

      <Grid cols={2}>
        <Card title="Requiere atención" actions={pending.length ? <span className="nav-badge">{pending.length}</span> : null}>
          {pending.length === 0 ? (
            <EmptyState title="Nada pendiente">No hay aprobaciones, revisiones ni diferencias abiertas.</EmptyState>
          ) : (
            <ul className="queue-list">
              {pending.map((q) => (
                <li key={q.key}>
                  <a href={q.link}>
                    <span className={`queue-count tone-${q.tone}`}>{data.attention[q.key]}</span>
                    <span>{q.label}</span>
                    <span className="queue-go" aria-hidden>
                      →
                    </span>
                  </a>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="Órdenes por estado">
          <ul className="status-bars">
            {Object.keys(ORDER_STATUS).map((s) => {
              const n = data.counts.orders[s] ?? 0;
              const max = Math.max(1, ...Object.values(data.counts.orders));
              return (
                <li key={s}>
                  <a href={href('ordenes', { estado: s })}>
                    <StatusBadge map={ORDER_STATUS} status={s} />
                    <span className="bar" aria-hidden>
                      <span style={{ width: `${(n / max) * 100}%` }} className={`bar-fill tone-${ORDER_STATUS[s].tone}`} />
                    </span>
                    <strong className="amount">{n}</strong>
                  </a>
                </li>
              );
            })}
          </ul>
        </Card>
      </Grid>

      <Grid cols={2}>
        <Card title={<>Completadas hoy <DemoTag /></>} flush>
          {data.completedToday.length === 0 ? (
            <EmptyState title="Aún no hay órdenes completadas hoy" />
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Operación</th>
                  <th className="align-right">Órdenes</th>
                  <th className="align-right">USDT</th>
                  <th className="align-right">Pesos</th>
                  <th className="align-right">Comisión</th>
                  {data.completedToday[0].margin !== null && <th className="align-right">Margen</th>}
                </tr>
              </thead>
              <tbody>
                {data.completedToday.map((r) => (
                  <tr key={r.side}>
                    <td data-label="Operación">{SIDE[r.side]}</td>
                    <td data-label="Órdenes" className="align-right">{r.orders}</td>
                    <td data-label="USDT" className="align-right">{usdt(r.usdt)}</td>
                    <td data-label="Pesos" className="align-right">{cop(r.cop)}</td>
                    <td data-label="Comisión" className="align-right">{cop(r.commission)}</td>
                    {r.margin !== null && (
                      <td data-label="Margen" className="align-right">
                        <Amount strong>{cop(r.margin)}</Amount>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>

        <Card title="Solicitudes por estado">
          <div className="chip-row">
            {Object.keys(REQUEST_STATUS).map((s) => (
              <a key={s} href={href('solicitudes', { estado: s })} className="chip-link">
                <StatusBadge map={REQUEST_STATUS} status={s} /> <strong className="amount">{data.counts.requests[s] ?? 0}</strong>
              </a>
            ))}
          </div>
        </Card>
      </Grid>

      {trmOpen && <TrmDialog onClose={() => setTrmOpen(false)} onDone={reload} />}
    </>
  );
}
