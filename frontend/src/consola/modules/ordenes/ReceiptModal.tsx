import { useState } from 'react';
import { orders } from '../../api/endpoints';
import type { Receipt } from '../../api/types';
import { DemoTag } from '../../app/DemoTag';
import { cop, copPrice, dateTime, timeOnly, usdt } from '../../lib/format';
import { useQuery } from '../../lib/hooks';
import { NETWORK } from '../../lib/labels';
import { Button } from '../../ui/Button';
import { ErrorNotice } from '../../ui/Feedback';
import { KeyValue, Loading } from '../../ui/Layout';
import { Modal } from '../../ui/Modal';

/** Comprobante para el cliente, tal como lo arma el servidor: sin TRM ni margen. */
export function ReceiptModal({ orderId, onClose }: { orderId: string; onClose: () => void }) {
  const { data: r, error } = useQuery<Receipt>(() => orders.receipt(orderId), [orderId]);
  const [copied, setCopied] = useState(false);
  const text = r
    ? [
        `Orden #${r.number}`,
        `${r.price.side === 'SELL' ? 'Compra' : 'Venta'} de ${usdt(r.price.usdtAmount)} · red ${NETWORK[r.network]}`,
        `Precio por USDT (todo incluido): ${copPrice(r.price.unitPriceCop)}`,
        `Total: ${cop(r.price.totalCop)} (comisión incluida: ${cop(r.price.detail.commissionCop)})`,
        r.payTo.asset === 'COP'
          ? `Paga ${cop(r.payTo.amount)} a la cuenta ${r.payTo.account}`
          : `Envía ${usdt(r.payTo.amount)} por ${NETWORK[r.payTo.network ?? r.network]} a ${r.payTo.address}`,
        `Plazo para pagar: hasta las ${timeOnly(r.paymentDeadline)} (hora de Colombia).`,
        `Recibirás en: ${r.receiveAt.bank ? `${r.receiveAt.bank} ` : ''}${r.receiveAt.value}`,
      ].join('\n')
    : '';
  return (
    <Modal
      title="Comprobante para el cliente"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cerrar</Button>
          <Button
            variant="primary"
            disabled={!r}
            onClick={() =>
              navigator.clipboard?.writeText(text).then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 2000);
              })
            }
          >
            {copied ? 'Copiado' : 'Copiar texto'}
          </Button>
        </>
      }
    >
      {!r ? (
        error ? <ErrorNotice error={error} /> : <Loading />
      ) : (
        <>
          <p className="muted small">
            Esto es lo que se comparte con el cliente. No incluye la TRM ni el margen de la mesa. <DemoTag />
          </p>
          <div className="price-box">
            <div className="quote-client">
              <div>
                <span className="muted small">Precio por USDT, todo incluido</span>
                <div className="big">{copPrice(r.price.unitPriceCop)}</div>
              </div>
              <div>
                <span className="muted small">Total</span>
                <div className="big">{cop(r.price.totalCop)}</div>
                <span className="muted small">por {usdt(r.price.usdtAmount)}</span>
              </div>
            </div>
            <KeyValue
              items={[
                ['Precio antes de comisión', copPrice(r.price.detail.basePriceCop)],
                ['Comisión', cop(r.price.detail.commissionCop)],
              ]}
            />
          </div>
          <KeyValue
            items={[
              ['El cliente paga', r.payTo.asset === 'COP' ? `${cop(r.payTo.amount)} a la cuenta ${r.payTo.account}` : `${usdt(r.payTo.amount)} a ${r.payTo.address}`],
              ['Plazo para pagar', dateTime(r.paymentDeadline)],
              ['El cliente recibe en', `${r.receiveAt.bank ? `${r.receiveAt.bank} · ` : ''}${r.receiveAt.value}`],
            ]}
          />
        </>
      )}
    </Modal>
  );
}
