import { useState } from 'react';
import { api } from '../api';
import type { User } from '../App';
import { cop, copPrice, dateTime, SETTLEMENT_LABEL, SIDE_LABEL, STATUS_LABEL, usdt } from '../format';
import { useAction, useLoad } from '../hooks';

interface Props {
  user: User;
  openId: string | null;
  onOpen: (id: string | null) => void;
}

export default function Orders({ user, openId, onOpen }: Props) {
  const [status, setStatus] = useState('');
  const list = useLoad<any[]>(`/orders${status ? `?status=${status}` : ''}`, [openId]);

  return (
    <section className={openId ? 'split' : ''}>
      <div>
        <h2>Órdenes</h2>
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">Todos los estados</option>
          {Object.entries(STATUS_LABEL).map(([k, v]) => (
            <option key={k} value={k}>{v}</option>
          ))}
        </select>
        {list.error && <p className="error">{list.error}</p>}
        <table>
          <thead>
            <tr><th>#</th><th>Cliente</th><th>Operación</th><th className="num">USDT</th><th className="num">Pesos</th><th>Estado</th></tr>
          </thead>
          <tbody>
            {(list.data ?? []).map((o) => (
              <tr key={o.id} className={`clickable ${openId === o.id ? 'selected' : ''}`} onClick={() => onOpen(o.id)}>
                <td>{o.id}</td>
                <td>{o.counterparty_name}</td>
                <td>{SIDE_LABEL[o.side]} · {o.network}</td>
                <td className="num">{usdt(o.usdt_amount)}</td>
                <td className="num">{cop(o.total_cop)}</td>
                <td><span className={`chip status-${o.status}`}>{STATUS_LABEL[o.status]}</span></td>
              </tr>
            ))}
            {list.data?.length === 0 && (
              <tr><td colSpan={6} className="muted">No hay órdenes.</td></tr>
            )}
          </tbody>
        </table>
      </div>
      {openId && <OrderDetail key={openId} id={openId} user={user} onClose={() => onOpen(null)} onChange={list.reload} />}
    </section>
  );
}

function OrderDetail({ id, user, onClose, onChange }: { id: string; user: User; onClose: () => void; onChange: () => void }) {
  const { data: o, error: loadError, reload } = useLoad<any>(`/orders/${id}`);
  const { busy, error, run } = useAction();
  const [ref, setRef] = useState('');
  const [reason, setReason] = useState('');
  const has = (...roles: string[]) => roles.some((r) => user.roles.includes(r));

  if (loadError) return <p className="error">{loadError}</p>;
  if (!o) return <p className="muted">Cargando…</p>;

  const act = (path: string, body?: unknown) =>
    run(async () => {
      await api('POST', `/orders/${id}/${path}`, body, true);
      setRef('');
      setReason('');
      await reload();
      onChange();
    });

  const incomingAsset = o.side === 'BUY' ? 'USDT' : 'COP';
  const outgoingAsset = o.side === 'BUY' ? 'COP' : 'USDT';
  const iApproved = o.approvalList.some((a: any) => a.approver_id === user.id);
  const prevBeforeReview = [...o.events].reverse().find((e: any) => e.to_status === 'IN_REVIEW')?.from_status;

  return (
    <aside className="card detail">
      <div className="detail-head">
        <h3>Orden #{o.id}</h3>
        <button className="link" onClick={onClose}>Cerrar</button>
      </div>
      <span className={`chip status-${o.status}`}>{STATUS_LABEL[o.status]}</span>
      <dl>
        <dt>Cliente</dt><dd>{o.counterparty_name}</dd>
        <dt>Operación</dt><dd>{SIDE_LABEL[o.side]} · red {o.network}</dd>
        <dt>Cantidad</dt><dd>{usdt(o.usdt_amount)}</dd>
        <dt>Precio</dt><dd>{copPrice(o.price_cop)} (TRM {copPrice(o.trm_rate)})</dd>
        <dt>Total</dt><dd><strong>{cop(o.total_cop)}</strong></dd>
        <dt>Cliente entrega</dt><dd>{incomingAsset === 'USDT' ? usdt(o.usdt_amount) : cop(o.total_cop)}</dd>
        <dt>Mesa entrega</dt><dd>{outgoingAsset === 'USDT' ? usdt(o.usdt_amount) : cop(o.total_cop)}</dd>
        <dt>Destino de la entrega</dt><dd className="mono">{o.destination ?? '—'}</dd>
        <dt>Aprobaciones</dt><dd>{o.approvalList.length} de {o.required_approvals}</dd>
      </dl>

      <div className="steps">
        {o.status === 'AWAITING_PAYMENT' && has('OPERADOR', 'TESORERO', 'ADMIN') && (
          <div className="step">
            <h4>1. Registrar el cobro</h4>
            <p className="muted small">
              {incomingAsset === 'USDT'
                ? 'Pega el hash de la transacción en la que el cliente envió los USDT.'
                : 'Escribe la referencia de la consignación del cliente en Bancolombia.'}
            </p>
            <input value={ref} onChange={(e) => setRef(e.target.value)} placeholder={incomingAsset === 'USDT' ? 'Hash de la transacción' : 'Referencia bancaria'} />
            <button className="primary" disabled={busy || !ref} onClick={() => act('incoming', { reference: ref })}>Verificar cobro</button>
          </div>
        )}

        {o.status === 'PAYMENT_CONFIRMED' && has('TESORERO', 'ADMIN') && (
          <div className="step">
            <h4>2. Aprobar la entrega</h4>
            {iApproved ? (
              <p className="muted">Ya aprobaste. Falta otra persona con rol Tesorero.</p>
            ) : (
              <button className="primary" disabled={busy} onClick={() => act('approve')}>Aprobar entrega</button>
            )}
          </div>
        )}

        {o.status === 'DELIVERY_APPROVED' && has('TESORERO', 'ADMIN') && (
          <div className="step">
            <h4>3. Registrar la entrega</h4>
            <p className="muted small">
              {outgoingAsset === 'USDT'
                ? 'Envía los USDT desde la billetera externa (la firma ocurre fuera de esta plataforma) y pega aquí el hash.'
                : 'Haz la transferencia en pesos y escribe su referencia.'}
            </p>
            <input value={ref} onChange={(e) => setRef(e.target.value)} placeholder={outgoingAsset === 'USDT' ? 'Hash de la transacción' : 'Referencia bancaria'} />
            <button className="primary" disabled={busy || !ref} onClick={() => act('outgoing', { reference: ref })}>Registrar entrega</button>
          </div>
        )}

        {o.status === 'DELIVERY_SENT' && (
          <div className="step">
            <h4>4. Verificar la entrega</h4>
            <p className="muted small">En la demo la verificación es simulada.</p>
            <button className="primary" disabled={busy} onClick={() => act('confirm')}>Verificar y cerrar</button>
          </div>
        )}

        {o.status === 'AWAITING_PAYMENT' && has('OPERADOR', 'ADMIN') && (
          <div className="step">
            <h4>Cancelar</h4>
            <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Motivo" />
            <button disabled={busy || !reason} onClick={() => act('cancel', { reason })}>Cancelar orden</button>
          </div>
        )}

        {!['CLOSED', 'CANCELLED', 'IN_REVIEW'].includes(o.status) && (
          <details>
            <summary>Enviar a revisión</summary>
            <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="¿Qué no cuadra?" />
            <button disabled={busy || !reason} onClick={() => act('review', { reason })}>Enviar a revisión</button>
          </details>
        )}

        {o.status === 'IN_REVIEW' && has('ADMIN') && (
          <div className="step">
            <h4>Resolver revisión</h4>
            <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Qué se verificó" />
            <div className="actions">
              {prevBeforeReview && (
                <button disabled={busy || !reason} onClick={() => act('resolve', { to: prevBeforeReview, note: reason })}>
                  Volver a «{STATUS_LABEL[prevBeforeReview]}»
                </button>
              )}
              <button disabled={busy || !reason} onClick={() => act('resolve', { to: 'CANCELLED', note: reason })}>Cancelar</button>
            </div>
          </div>
        )}
        {error && <p className="error">{error}</p>}
      </div>

      <h4>Movimientos</h4>
      {o.settlements.length === 0 ? <p className="muted">Sin movimientos.</p> : (
        <table className="compact">
          <tbody>
            {o.settlements.map((s: any) => (
              <tr key={s.id}>
                <td>{s.direction === 'IN' ? 'Cobro' : 'Entrega'} {s.asset}</td>
                <td className="mono small">{s.reference}</td>
                <td>{SETTLEMENT_LABEL[s.status]}{s.simulated ? ' (simulado)' : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h4>Historial</h4>
      <ol className="timeline">
        {o.events.map((e: any) => (
          <li key={e.id}>
            <strong>{STATUS_LABEL[e.to_status]}</strong> · {e.actor_name} · {dateTime(e.created_at)}
            {e.note && <div className="muted small">{e.note}</div>}
          </li>
        ))}
      </ol>
    </aside>
  );
}
