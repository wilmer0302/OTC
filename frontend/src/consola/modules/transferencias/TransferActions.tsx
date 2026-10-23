import { useState } from 'react';
import { sandbox, transfers } from '../../api/endpoints';
import type { Instruction, TransferRow } from '../../api/types';
import { DemoTag } from '../../app/DemoTag';
import { isDemo, useCan, useSession } from '../../app/session';
import { amountOf } from '../../lib/format';
import { notifyChange } from '../../lib/hooks';
import { NETWORK, PURPOSE } from '../../lib/labels';
import { refError, refHint } from '../../lib/refs';
import { Button } from '../../ui/Button';
import { CopyValue } from '../../ui/Copy';
import { ErrorNotice, useToast } from '../../ui/Feedback';
import { KeyValue, Notice } from '../../ui/Layout';
import { Modal, useConfirm } from '../../ui/Modal';

type T = Pick<TransferRow, 'id' | 'number' | 'purpose' | 'direction' | 'rail' | 'asset' | 'amount' | 'status' | 'external_ref'>;

/**
 * Acciones posibles sobre una transferencia según su estado y el rol. Se usa en el detalle de la
 * transferencia y en el de la orden. La plataforma no firma ni guarda llaves: el envío de USDT se
 * firma en la billetera externa y aquí solo se registra el hash.
 */
export function TransferActions({ t, onChange }: { t: T; onChange: () => void }) {
  const can = useCan();
  const { system } = useSession();
  const toast = useToast();
  const { confirm, dialog } = useConfirm();
  const [instruction, setInstruction] = useState<Instruction | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const out = t.direction === 'OUT';
  const label = `${PURPOSE[t.purpose].toLowerCase()} #${t.number}`;
  const amount = amountOf(t.asset, t.amount);

  const run = async (name: string, fn: () => Promise<unknown>) => {
    setBusy(name);
    setError(null);
    try {
      await fn();
      notifyChange();
      onChange();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  };

  const showInstruction = () => run('instr', async () => setInstruction(await transfers.instruction(t.id)));
  const prepare = () =>
    run('prep', async () => {
      setInstruction((await transfers.prepareSigning(t.id, { idempotencyKey: crypto.randomUUID() })).instruction);
    });

  const registerSent = () =>
    confirm({
      title: `Registrar envío de la ${label}`,
      intro:
        t.rail === 'BANK'
          ? 'Registra la referencia que entregó el banco al ordenar el pago. El sistema la verificará con el banco.'
          : 'Registra el hash de la transacción que firmaste en la billetera externa. El sistema la verificará en la red.',
      summary: [
        ['Monto', amount],
        ['Red', NETWORK[t.rail]],
      ],
      fields: [{ name: 'reference', label: t.rail === 'BANK' ? 'Referencia bancaria' : 'Hash de la transacción', hint: refHint(t.rail), mono: true, validate: (v) => refError(t.rail, v) }],
      acknowledge: t.rail === 'BANK' ? 'Confirmo que ordené este pago en el banco por el monto indicado.' : 'Confirmo que firmé y envié este monto desde la billetera externa.',
      confirmLabel: 'Registrar envío',
      onConfirm: async ({ fields, idempotencyKey }) => {
        await transfers.registerSent(t.id, fields.reference, { idempotencyKey });
        toast(`Envío registrado en la ${label}. Queda en verificación.`);
        onChange();
      },
    });

  const cancel = () =>
    confirm({
      title: `Cancelar la ${label}`,
      intro: 'Solo se cancela si el dinero no salió. La reserva de liquidez se libera según corresponda.',
      danger: true,
      reason: { label: 'Motivo' },
      confirmLabel: 'Cancelar transferencia',
      onConfirm: async ({ reason, idempotencyKey }) => {
        await transfers.cancel(t.id, reason, { idempotencyKey });
        toast(`Transferencia #${t.number} cancelada`);
        onChange();
      },
    });

  const retry = () =>
    confirm({
      title: `Reintentar la ${label}`,
      intro: 'Se crea una entrega nueva, autorizada, enlazada a la fallida. La fallida no se reactiva.',
      summary: [['Monto', amount]],
      reason: { label: 'Motivo del reintento' },
      stepUp: true,
      confirmLabel: 'Crear reintento',
      onConfirm: async ({ reason, mfaCode, idempotencyKey }) => {
        await transfers.retry(t.id, reason, { idempotencyKey, mfaCode });
        toast('Reintento creado: queda autorizado para firmar y enviar.');
        onChange();
      },
    });

  const resolve = (to: 'CONFIRMADA' | 'FALLIDA' | 'PENDIENTE') =>
    confirm({
      title: { CONFIRMADA: 'Dar por confirmada', FALLIDA: 'Dar por fallida', PENDIENTE: 'Devolver a seguimiento' }[to],
      intro:
        to === 'CONFIRMADA'
          ? 'Solo si la evidencia de la red o del banco coincide con lo registrado. El servidor exige esa evidencia.'
          : to === 'FALLIDA'
            ? 'El dinero no llegó. La transferencia queda fallida y, si es una entrega, podrá reintentarse.'
            : 'El sistema seguirá consultando la red o el banco.',
      danger: to === 'FALLIDA',
      reason: { label: 'Qué se verificó' },
      stepUp: true,
      confirmLabel: 'Resolver revisión',
      onConfirm: async ({ reason, mfaCode, idempotencyKey }) => {
        await transfers.resolveReview(t.id, to, reason, { idempotencyKey, mfaCode });
        toast('Revisión resuelta');
        onChange();
      },
    });

  const simulate = (status: string, extra: { amount?: string; failReason?: string } = {}) =>
    run(`sim-${status}`, async () => {
      await sandbox.simulateTransfer(t.id, { status, confirmations: status === 'SUCCESS' ? 100 : status === 'PENDING' ? 1 : undefined, ...extra });
      // Quien gestiona transferencias la verifica de inmediato; si no, la verifica el proceso automático.
      if (can('transfer.manage')) {
        await transfers.check(t.id);
        toast('Simulación aplicada y verificada', 'info');
      } else toast('Simulación aplicada: el proceso automático la verificará en segundos', 'info');
    });

  const manage = can('transfer.manage');
  const panels = [];

  if (out && manage && t.status === 'AUTORIZADA' && t.rail !== 'BANK') {
    panels.push(
      <div className="action-panel" key="sign">
        <h4>Preparar la firma</h4>
        <p>Genera la instrucción exacta (origen, destino, monto) para firmar en la billetera externa. La plataforma no firma ni guarda llaves.</p>
        <Button variant="primary" onClick={prepare} busy={busy === 'prep'}>
          Preparar firma
        </Button>
      </div>,
    );
  }
  if (out && manage && (t.status === 'EN_FIRMA' || (t.status === 'AUTORIZADA' && t.rail === 'BANK'))) {
    panels.push(
      <div className="action-panel" key="sent">
        <h4>{t.rail === 'BANK' ? 'Ordenar el pago y registrar la referencia' : 'Registrar el hash del envío'}</h4>
        <p>{t.rail === 'BANK' ? 'Ordena el pago en el banco con la instrucción y registra la referencia.' : 'Después de firmar y enviar, registra el hash para que el sistema lo verifique en la red.'}</p>
        <div className="action-row">
          <Button onClick={showInstruction} busy={busy === 'instr'}>
            Ver instrucción
          </Button>
          <Button variant="primary" onClick={registerSent}>
            {t.rail === 'BANK' ? 'Registrar referencia' : 'Registrar hash'}
          </Button>
        </div>
      </div>,
    );
  }
  if ((t.status === 'ENVIADA' || t.status === 'PENDIENTE') && manage) {
    panels.push(
      <div className="action-panel" key="check">
        <h4>En verificación</h4>
        <p>El proceso automático consulta {t.rail === 'BANK' ? 'el banco' : 'la red'} cada pocos segundos. Puedes pedir una revisión inmediata.</p>
        <Button onClick={() => run('check', () => transfers.check(t.id).then(() => toast('Revisión hecha', 'info')))} busy={busy === 'check'}>
          Revisar ahora
        </Button>
      </div>,
    );
  }
  if (t.status === 'FALLIDA' && t.purpose === 'ENTREGA' && can('order.approve')) {
    panels.push(
      <div className="action-panel" key="retry">
        <h4>Entrega fallida</h4>
        <p>El dinero no llegó al cliente. Puedes crear un reintento (pide tu código del segundo factor).</p>
        <Button variant="primary" onClick={retry}>
          Reintentar entrega
        </Button>
      </div>,
    );
  }
  if (t.status === 'EN_REVISION' && can('review.resolve')) {
    panels.push(
      <div className="action-panel" key="review">
        <h4>Resolver revisión</h4>
        <p>Decide con la evidencia de la red o del banco (ver observaciones).</p>
        <div className="action-row">
          <Button onClick={() => resolve('CONFIRMADA')}>Confirmada</Button>
          <Button onClick={() => resolve('PENDIENTE')}>Volver a seguimiento</Button>
          <Button variant="danger" onClick={() => resolve('FALLIDA')}>
            Fallida
          </Button>
        </div>
      </div>,
    );
  }
  if (out && manage && ['CREADA', 'AUTORIZADA', 'EN_FIRMA'].includes(t.status)) {
    panels.push(
      <div className="action-row" key="cancel">
        <Button variant="ghost" onClick={cancel}>
          Cancelar transferencia
        </Button>
      </div>,
    );
  }

  // Simulación: solo en modo DEMO y con el permiso de simular. Escribe lo que "diría" la red o el banco.
  const canSimulate = isDemo(system) && can('sandbox.simulate') && t.external_ref && ['ENVIADA', 'PENDIENTE', 'EN_REVISION'].includes(t.status);
  if (canSimulate) {
    const bank = t.rail === 'BANK';
    panels.push(
      <div className="action-panel sim-panel" key="sim">
        <h4>
          Simulador de {bank ? 'banco' : 'red'} <DemoTag />
        </h4>
        <p>Solo existe en la demostración: simula la respuesta {bank ? 'del banco' : 'de la red'} y la verifica de inmediato.</p>
        <div className="action-row">
          <Button size="sm" onClick={() => simulate(bank ? 'SETTLED' : 'SUCCESS')} busy={busy === `sim-${bank ? 'SETTLED' : 'SUCCESS'}`}>
            Simular confirmada
          </Button>
          {!bank && (
            <Button size="sm" onClick={() => simulate('PENDING')} busy={busy === 'sim-PENDING'}>
              Simular pendiente
            </Button>
          )}
          <Button size="sm" onClick={() => simulate(bank ? 'REJECTED' : 'FAILED', { failReason: 'Simulación de falla (demo)' })} busy={busy === `sim-${bank ? 'REJECTED' : 'FAILED'}`}>
            Simular {bank ? 'rechazada' : 'fallida'}
          </Button>
        </div>
      </div>,
    );
  }

  return (
    <>
      {panels}
      <ErrorNotice error={error} />
      {dialog}
      {instruction && <InstructionModal instruction={instruction} onClose={() => setInstruction(null)} onRegister={registerSent} />}
    </>
  );
}

function InstructionModal({ instruction: i, onClose, onRegister }: { instruction: Instruction; onClose: () => void; onRegister: () => void }) {
  return (
    <Modal
      title={`Instrucción de envío · transferencia #${i.transfer}`}
      onClose={onClose}
      wide
      footer={
        <>
          <Button onClick={onClose}>Cerrar</Button>
          <Button
            variant="primary"
            onClick={() => {
              onClose();
              onRegister();
            }}
          >
            {i.rail === 'BANK' ? 'Ya ordené el pago: registrar referencia' : 'Ya firmé y envié: registrar hash'}
          </Button>
        </>
      }
    >
      <Notice tone="info">{i.note}</Notice>
      <KeyValue
        items={[
          ['Monto', <strong>{amountOf(i.asset, i.amount)}</strong>],
          ...(i.amountBaseUnits ? ([['Unidades base del token', <CopyValue value={i.amountBaseUnits} short={false} />]] as [string, JSX.Element][]) : []),
          ['Red', NETWORK[i.rail]],
          ['Desde', <>{i.from.name} <span className="muted">({i.from.account})</span> {i.from.ref && <CopyValue value={i.from.ref} short={false} />}</>],
          ['Hacia', <>{i.to.kind === 'CLIENTE' ? 'Cliente' : 'Cuenta propia'}{i.to.bank ? ` · ${i.to.bank}` : ''} <CopyValue value={i.to.value} short={false} /></>],
        ]}
      />
      <p className="muted small">
        Revisa la dirección carácter por carácter en la billetera antes de firmar. <DemoTag />
      </p>
    </Modal>
  );
}
