import { useEffect, useState } from 'react';
import { api } from '../api';
import { cop, copPrice, SIDE_LABEL, usdt } from '../format';
import { useAction, useLoad } from '../hooks';

export default function Quote({ onOrder }: { onOrder: (id: string) => void }) {
  const clients = useLoad<any[]>('/counterparties');
  const [form, setForm] = useState({ counterpartyId: '', side: 'SELL', network: 'TRON', usdtAmount: '' });
  const [quote, setQuote] = useState<any | null>(null);
  const [left, setLeft] = useState(0);
  const { busy, error, run, setError } = useAction();

  useEffect(() => {
    if (!quote) return;
    const tick = () => setLeft(Math.max(0, Math.floor((new Date(quote.expires_at).getTime() - Date.now()) / 1000)));
    tick();
    const t = setInterval(tick, 500);
    return () => clearInterval(t);
  }, [quote]);

  const approved = (clients.data ?? []).filter((c) => c.kyc_status === 'APROBADO');
  const set = (k: string, v: string) => {
    setForm({ ...form, [k]: v });
    setQuote(null);
  };

  const requestQuote = (e: React.FormEvent) => {
    e.preventDefault();
    run(async () => setQuote(await api('POST', '/quotes', form)));
  };

  const accept = () =>
    run(async () => {
      const order = await api<any>('POST', `/quotes/${quote.id}/accept`, undefined, true);
      onOrder(order.id);
    });

  return (
    <section className="narrow">
      <h2>Cotizar</h2>
      <form className="card" onSubmit={requestQuote}>
        <label>
          Cliente
          <select value={form.counterpartyId} onChange={(e) => set('counterpartyId', e.target.value)}>
            <option value="">Elige un cliente con KYC aprobado</option>
            {approved.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </label>
        <div className="row">
          <label>
            Operación
            <select value={form.side} onChange={(e) => set('side', e.target.value)}>
              <option value="SELL">El cliente compra USDT (mesa vende)</option>
              <option value="BUY">El cliente vende USDT (mesa compra)</option>
            </select>
          </label>
          <label>
            Red
            <select value={form.network} onChange={(e) => set('network', e.target.value)}>
              <option value="TRON">Tron</option>
              <option value="BSC">BSC</option>
            </select>
          </label>
        </div>
        <label>
          Monto en USDT
          <input inputMode="decimal" value={form.usdtAmount} placeholder="1000"
            onChange={(e) => set('usdtAmount', e.target.value.replace(',', '.'))} />
        </label>
        {error && !quote && <p className="error">{error}</p>}
        <button className="primary" disabled={busy || !form.counterpartyId || !form.usdtAmount}>Pedir precio</button>
      </form>

      {quote && (
        <div className="card quote">
          <div className="quote-head">
            <span>{SIDE_LABEL[quote.side]} · {quote.network}</span>
            <span className={left > 0 ? 'timer' : 'timer expired'}>{left > 0 ? `Vence en ${left} s` : 'Vencida'}</span>
          </div>
          <dl>
            <dt>TRM usada</dt>
            <dd>{copPrice(quote.trm_rate)} <span className="muted small">({quote.trm_source}{quote.trm_simulated ? ', demo' : ''})</span></dd>
            <dt>Margen</dt>
            <dd>{quote.side === 'BUY' ? '−' : '+'} {copPrice(quote.margin_cop)} por USDT</dd>
            <dt>Precio</dt>
            <dd><strong>{copPrice(quote.price_cop)}</strong> por USDT</dd>
            <dt>Cantidad</dt>
            <dd>{usdt(quote.usdt_amount)}</dd>
            <dt>Total en pesos</dt>
            <dd className="big">{cop(quote.total_cop)}</dd>
          </dl>
          {error && <p className="error">{error}</p>}
          <div className="actions">
            <button className="primary" disabled={busy || left <= 0} onClick={accept}>El cliente acepta: crear orden</button>
            <button onClick={() => { setQuote(null); setError(null); }}>Descartar</button>
          </div>
        </div>
      )}
    </section>
  );
}
