import { useState } from 'react';
import { quotes as quotesApi } from '../../api/endpoints';
import type { Quote } from '../../api/types';
import { DemoTag } from '../../app/DemoTag';
import { navigate } from '../../app/router';
import { useCan } from '../../app/session';
import { cop, copPrice, pct, usdt } from '../../lib/format';
import { QUOTE_STATUS, SIDE } from '../../lib/labels';
import { StatusBadge } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { Countdown } from '../../ui/Countdown';
import { useToast } from '../../ui/Feedback';
import { KeyValue } from '../../ui/Layout';
import { useConfirm } from '../../ui/Modal';

/**
 * Cotización tal como se le comunica al cliente: precio por USDT todo incluido y total, con el detalle
 * opcional (precio antes de comisión y comisión). La TRM y el margen van aparte, marcados como
 * internos: nunca se comparten con el cliente.
 */
export function QuotePanel({ quote, counterparty, network, onChange }: { quote: Quote; counterparty: string; network: string; onChange: () => void }) {
  const can = useCan();
  const toast = useToast();
  const { confirm, dialog } = useConfirm();
  const [showDetail, setShowDetail] = useState(false);
  const live = quote.status === 'VIGENTE';
  const clientPays = quote.side === 'SELL' ? cop(quote.total_cop) : usdt(quote.usdt_amount);
  const clientGets = quote.side === 'SELL' ? usdt(quote.usdt_amount) : cop(quote.total_cop);

  const accept = () =>
    confirm({
      title: `Aceptar cotización #${quote.number}`,
      intro: 'El cliente aceptó el precio. Se crea la orden y se reserva la liquidez de la mesa. El servidor rechaza la aceptación si la cotización ya venció.',
      summary: [
        ['Cliente', counterparty],
        ['Operación', `${SIDE[quote.side]} · ${network}`],
        ['Precio por USDT', copPrice(quote.unit_price_cop)],
        ['El cliente entrega', clientPays],
        ['El cliente recibe', clientGets],
      ],
      confirmLabel: 'Aceptar y crear orden',
      acknowledge: 'Confirmo que el cliente aceptó este precio y este total.',
      onConfirm: async ({ idempotencyKey }) => {
        const r = await quotesApi.accept(quote.id, { idempotencyKey });
        toast(r.alreadyAccepted ? `La cotización ya estaba aceptada: orden #${r.order.number}` : `Orden #${r.order.number} creada`);
        onChange();
        navigate(`ordenes/${r.order.id}`);
      },
    });

  const withdraw = () =>
    confirm({
      title: `Retirar cotización #${quote.number}`,
      intro: 'La cotización deja de ser válida y el cliente ya no puede aceptarla. La solicitud puede volver a cotizarse.',
      danger: true,
      confirmLabel: 'Retirar cotización',
      reason: { label: 'Motivo', placeholder: 'Por ejemplo: el cliente no respondió o cambió el mercado' },
      onConfirm: async ({ reason, idempotencyKey }) => {
        await quotesApi.withdraw(quote.id, reason, { idempotencyKey });
        toast(`Cotización #${quote.number} retirada`);
        onChange();
      },
    });

  return (
    <div className="quote-panel">
      <div className="quote-head">
        <span>
          Cotización #{quote.number} <StatusBadge map={QUOTE_STATUS} status={quote.status} />
        </span>
        {live && (
          <span>
            Vence en <Countdown until={quote.expires_at} />
          </span>
        )}
      </div>
      <div className="price-box">
        <div className="label">
          Para el cliente <DemoTag />
        </div>
        <div className="quote-client">
          <div>
            <span className="muted small">Precio por USDT, todo incluido</span>
            <div className="big">{copPrice(quote.unit_price_cop)}</div>
          </div>
          <div>
            <span className="muted small">Total a {quote.side === 'SELL' ? 'pagar por el cliente' : 'pagar al cliente'}</span>
            <div className="big">{cop(quote.total_cop)}</div>
            <span className="muted small">por {usdt(quote.usdt_amount)}</span>
          </div>
        </div>
        <button className="btn btn-ghost btn-sm" onClick={() => setShowDetail((v) => !v)} aria-expanded={showDetail}>
          {showDetail ? 'Ocultar detalle' : 'Ver detalle del precio'}
        </button>
        {showDetail && (
          <KeyValue
            items={[
              ['Precio por USDT antes de comisión', copPrice(quote.base_price_cop)],
              ['Subtotal', cop(quote.subtotal_cop)],
              ['Comisión cobrada', cop(quote.commission_cop)],
              ['Total', cop(quote.total_cop)],
            ]}
          />
        )}
      </div>
      <div className="internal-box">
        <span className="label">Interno · no se comparte con el cliente</span>
        <KeyValue
          items={[
            ['TRM usada', copPrice(quote.trm_rate)],
            ['Margen por USDT', copPrice(quote.margin_cop)],
            ['Comisión', pct(quote.commission_rate)],
            ['Margen total', cop(quote.margin_total_cop)],
          ]}
        />
      </div>
      {quote.status_reason && <p className="muted small">{quote.status_reason}</p>}
      {live && (can('quote.accept') || can('quote.withdraw')) && (
        <div className="action-row" style={{ marginTop: 12 }}>
          {can('quote.accept') && (
            <Button variant="primary" onClick={accept}>
              El cliente aceptó
            </Button>
          )}
          {can('quote.withdraw') && <Button onClick={withdraw}>Retirar</Button>}
        </div>
      )}
      {dialog}
    </div>
  );
}
