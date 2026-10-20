import { useLoad } from '../hooks';
import { cop, copPrice, SIDE_LABEL, STATUS_LABEL, usdt } from '../format';

interface DashboardData {
  today: string;
  trm: { rate: string; source: string; simulated: boolean } | null;
  balances: { code: string; name: string; total: string }[];
  ordersByStatus: Record<string, number>;
  closedToday: { side: string; orders: number; usdt: string; cop: string; margin_cop: string }[];
}

export default function Dashboard({ onOpenOrder }: { onOpenOrder: (id: string) => void }) {
  const { data, error } = useLoad<DashboardData>('/dashboard');
  const pending = useLoad<any[]>('/orders?status=PAYMENT_CONFIRMED');
  if (error) return <p className="error">{error}</p>;
  if (!data) return <p className="muted">Cargando…</p>;

  const bank = data.balances.find((b) => b.code === 'BANK_COP');
  const wallet = data.balances.find((b) => b.code === 'USDT_WALLET');
  const margin = data.closedToday.reduce((s, r) => s + Number(r.margin_cop), 0);

  return (
    <section>
      <h2>Panel · {data.today}</h2>
      <div className="tiles">
        <div className="tile">
          <span className="label">TRM de hoy</span>
          {data.trm ? (
            <>
              <strong>{copPrice(data.trm.rate)}</strong>
              <span className="muted small">
                {data.trm.source}
                {data.trm.simulated ? ' · demo' : ''}
              </span>
            </>
          ) : (
            <>
              <strong className="warn">Sin TRM</strong>
              <span className="muted small">Cárgala en Configuración para poder cotizar</span>
            </>
          )}
        </div>
        <div className="tile">
          <span className="label">Pesos en bancos</span>
          <strong>{bank ? cop(bank.total) : '-'}</strong>
          <span className="muted small">según el libro contable</span>
        </div>
        <div className="tile">
          <span className="label">USDT en billeteras</span>
          <strong>{wallet ? usdt(wallet.total) : '-'}</strong>
          <span className="muted small">según el libro contable</span>
        </div>
        <div className="tile">
          <span className="label">Margen frente a TRM hoy</span>
          <strong>{cop(margin)}</strong>
          <span className="muted small">órdenes cerradas hoy</span>
        </div>
      </div>

      <h3>Órdenes por estado</h3>
      <div className="chips">
        {Object.keys(STATUS_LABEL).map((s) => (
          <span key={s} className={`chip status-${s}`}>
            {STATUS_LABEL[s]}: {data.ordersByStatus[s] ?? 0}
          </span>
        ))}
      </div>

      <h3>Cerradas hoy</h3>
      {data.closedToday.length === 0 ? (
        <p className="muted">Aún no hay órdenes cerradas hoy.</p>
      ) : (
        <table>
          <thead>
            <tr><th>Lado</th><th>Órdenes</th><th className="num">USDT</th><th className="num">Pesos</th><th className="num">Margen</th></tr>
          </thead>
          <tbody>
            {data.closedToday.map((r) => (
              <tr key={r.side}>
                <td>{SIDE_LABEL[r.side]}</td>
                <td>{r.orders}</td>
                <td className="num">{usdt(r.usdt)}</td>
                <td className="num">{cop(r.cop)}</td>
                <td className="num">{cop(r.margin_cop)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h3>Esperando aprobación de entrega</h3>
      {!pending.data?.length ? (
        <p className="muted">Nada pendiente.</p>
      ) : (
        <table>
          <tbody>
            {pending.data.map((o) => (
              <tr key={o.id} className="clickable" onClick={() => onOpenOrder(o.id)}>
                <td>#{o.id}</td>
                <td>{o.counterparty_name}</td>
                <td>{SIDE_LABEL[o.side]}</td>
                <td className="num">{usdt(o.usdt_amount)}</td>
                <td className="num">{cop(o.total_cop)}</td>
                <td>{o.approvals} de {o.required_approvals} aprobaciones</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
