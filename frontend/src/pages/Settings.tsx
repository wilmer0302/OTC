import { useEffect, useState } from 'react';
import { api } from '../api';
import type { User } from '../App';
import { cop, copPrice, dateTime, POLICY_LABEL } from '../format';
import { useAction, useLoad } from '../hooks';

export default function Settings({ user }: { user: User }) {
  const settings = useLoad<any>('/settings');
  const trm = useLoad<any[]>('/trm');
  const [form, setForm] = useState<any>(null);
  const [rate, setRate] = useState('');
  const save = useAction();
  const trmAction = useAction();
  const isAdmin = user.roles.includes('ADMIN');
  const canTrm = isAdmin || user.roles.includes('TESORERO');

  useEffect(() => {
    if (settings.data) setForm(settings.data);
  }, [settings.data]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    save.run(async () => {
      const { buy_margin_cop, sell_margin_cop, quote_ttl_seconds, approval_policy, approval_threshold_cop, max_order_usdt } = form;
      await api('PUT', '/settings', {
        buy_margin_cop: String(buy_margin_cop),
        sell_margin_cop: String(sell_margin_cop),
        quote_ttl_seconds: Number(quote_ttl_seconds),
        approval_policy,
        approval_threshold_cop: String(approval_threshold_cop).split('.')[0],
        max_order_usdt: String(max_order_usdt),
      }, true);
      settings.reload();
    });
  };

  const addTrm = (e: React.FormEvent) => {
    e.preventDefault();
    trmAction.run(async () => {
      await api('POST', '/trm', { rate: rate.replace(',', '.') }, true);
      setRate('');
      trm.reload();
    });
  };

  const field = (key: string, label: string, help?: string) => (
    <label>
      {label}
      <input value={form[key]} disabled={!isAdmin} onChange={(e) => setForm({ ...form, [key]: e.target.value })} />
      {help && <span className="muted small">{help}</span>}
    </label>
  );

  return (
    <section className="two-col">
      <div className="card">
        <h3>TRM</h3>
        <p className="muted small">
          En la demo la TRM se ingresa a mano y queda registrada con quién la cargó. La fuente oficial automática se
          conecta en la instalación de cada cliente.
        </p>
        {canTrm && (
          <form onSubmit={addTrm} className="inline">
            <input value={rate} onChange={(e) => setRate(e.target.value)} placeholder="Pesos por dólar, ej. 4000,00" inputMode="decimal" />
            <button className="primary" disabled={trmAction.busy || !rate}>Cargar TRM de hoy</button>
          </form>
        )}
        {trmAction.error && <p className="error">{trmAction.error}</p>}
        <table className="compact">
          <thead><tr><th>Fecha</th><th className="num">TRM</th><th>Fuente</th><th>Cargada</th></tr></thead>
          <tbody>
            {(trm.data ?? []).map((t) => (
              <tr key={t.id}>
                <td>{t.valid_date}</td>
                <td className="num">{copPrice(t.rate)}</td>
                <td>{t.source}{t.simulated ? ' (demo)' : ''}</td>
                <td className="small">{dateTime(t.created_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card">
        <h3>Reglas de la mesa</h3>
        {!form ? <p className="muted">Cargando…</p> : (
          <form onSubmit={submit}>
            {field('buy_margin_cop', 'Margen de compra (pesos por USDT)', 'La mesa compra a TRM menos este valor')}
            {field('sell_margin_cop', 'Margen de venta (pesos por USDT)', 'La mesa vende a TRM más este valor')}
            {field('quote_ttl_seconds', 'Vigencia de una cotización (segundos)')}
            <label>
              Política de aprobación de entregas
              <select value={form.approval_policy} disabled={!isAdmin} onChange={(e) => setForm({ ...form, approval_policy: e.target.value })}>
                {Object.entries(POLICY_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </label>
            {form.approval_policy === 'THRESHOLD' &&
              field('approval_threshold_cop', 'Umbral para segunda aprobación (pesos)', `Actual: ${cop(settings.data?.approval_threshold_cop ?? 0)}`)}
            {field('max_order_usdt', 'Límite por operación (USDT)')}
            {save.error && <p className="error">{save.error}</p>}
            {isAdmin ? <button className="primary" disabled={save.busy}>Guardar cambios</button>
              : <p className="muted small">Solo el administrador cambia estas reglas.</p>}
            <p className="muted small">Cada cambio queda en la auditoría con el valor anterior y el nuevo.</p>
          </form>
        )}
      </div>
    </section>
  );
}
