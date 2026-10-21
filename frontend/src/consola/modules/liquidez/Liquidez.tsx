import { useState } from 'react';
import { liquidity, system, transfers } from '../../api/endpoints';
import type { Asset, Dashboard, LedgerEntry, LiquidityAccount, Network } from '../../api/types';
import { DemoTag } from '../../app/DemoTag';
import { href, navigate } from '../../app/router';
import { useCan } from '../../app/session';
import { amountOf, dateTime } from '../../lib/format';
import { useQuery } from '../../lib/hooks';
import { LIQUIDITY_TYPE, NETWORK } from '../../lib/labels';
import { Badge } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { CopyValue } from '../../ui/Copy';
import { DataTable, type Column } from '../../ui/DataTable';
import { Drawer } from '../../ui/Drawer';
import { ErrorNotice, useToast } from '../../ui/Feedback';
import { Checkbox, Field, Input, parseAmountInput, Select, Textarea } from '../../ui/Form';
import { FormModal } from '../../ui/FormModal';
import { Card, EmptyState, KeyValue, Loading, Notice, PageHeader, StatTile } from '../../ui/Layout';
import { useConfirm } from '../../ui/Modal';
import type { PageProps } from '../index';

const decimalsOf = (asset: Asset) => (asset === 'COP' ? 0 : 6);

export default function Liquidez({ route }: PageProps) {
  const can = useCan();
  const selected = route.path[1] ?? null;
  const list = useQuery<LiquidityAccount[]>(() => liquidity.summary(), [], { refreshMs: 15000 });
  const check = useQuery(() => liquidity.verify(), []);
  const [moving, setMoving] = useState(false);
  const [creating, setCreating] = useState(false);

  const columns: Column<LiquidityAccount>[] = [
    {
      key: 'n',
      header: 'Cuenta',
      render: (a) => (
        <>
          <span className="cell-main">{a.name}</span>
          <span className="cell-sub">
            {a.code}
            {a.is_default && ' · predeterminada'}
          </span>
        </>
      ),
    },
    { key: 't', header: 'Tipo', secondary: true, render: (a) => `${LIQUIDITY_TYPE[a.liquidity_type]}${a.network ? ` · ${NETWORK[a.network]}` : ''}` },
    { key: 'b', header: 'Saldo', align: 'right', render: (a) => amountOf(a.asset, a.balance) },
    { key: 'r', header: 'Reservado', align: 'right', render: (a) => <span className="muted">{amountOf(a.asset, a.reserved)}</span> },
    { key: 'd', header: 'Disponible', align: 'right', render: (a) => <strong>{amountOf(a.asset, a.available)}</strong> },
  ];

  // Totales calculados en el servidor (desde el libro contable), no en el navegador.
  const dash = useQuery<Dashboard>(() => system.dashboard(), []);
  const totals = dash.data?.liquidity ?? [];

  return (
    <>
      <PageHeader
        title="Liquidez"
        subtitle="Saldos de bancos, billeteras y exchange según el libro contable de doble entrada. Lo reservado está comprometido con órdenes en curso."
        actions={
          <>
            {can('transfer.manage') && <Button onClick={() => setMoving(true)}>Traslado entre cuentas</Button>}
            {can('liquidity.manage') && (
              <Button variant="primary" onClick={() => setCreating(true)}>
                Nueva cuenta
              </Button>
            )}
          </>
        }
      />
      {check.data && (
        <Notice tone={check.data.ok ? 'success' : 'danger'} title={check.data.ok ? 'Libro contable cuadrado' : 'El libro no cuadra con los saldos'}>
          {check.data.ok
            ? 'Cada saldo coincide con la suma de sus asientos.'
            : check.data.mismatches.map((m) => `${m.code}: saldo ${m.balance}, libro ${m.ledger}`).join(' · ')}
        </Notice>
      )}
      <div className="tiles">
        {totals.map((t) => (
          <StatTile
            key={t.asset}
            label={`${t.asset === 'COP' ? 'Pesos' : 'USDT'} disponibles`}
            value={amountOf(t.asset, t.available)}
            hint={
              <>
                Saldo {amountOf(t.asset, t.balance)} · reservado {amountOf(t.asset, t.reserved)} · {t.accounts} {t.accounts === 1 ? "cuenta" : "cuentas"} <DemoTag />
              </>
            }
          />
        ))}
      </div>
      <div className={selected ? 'split' : ''}>
        <Card flush title={<>Cuentas <DemoTag /></>} actions={<Button size="sm" onClick={list.reload} busy={list.loading}>Actualizar</Button>}>
          <DataTable
            columns={columns}
            rows={list.data}
            rowKey={(a) => a.id}
            loading={list.loading}
            error={list.error}
            selectedKey={selected}
            rowHref={(a) => href(`liquidez/${a.id}`)}
            empty={{ title: 'No hay cuentas de liquidez', hint: 'Administración las da de alta con «Nueva cuenta».' }}
          />
        </Card>
        {selected && <AccountDrawer key={selected} account={list.data?.find((a) => a.id === selected)} id={selected} onClose={() => navigate('liquidez')} />}
      </div>
      {moving && list.data && <InternalTransferDialog accounts={list.data} onClose={() => setMoving(false)} />}
      {creating && <NewAccountDialog onClose={() => setCreating(false)} />}
    </>
  );
}

function AccountDrawer({ id, account: a, onClose }: { id: string; account?: LiquidityAccount; onClose: () => void }) {
  const can = useCan();
  const toast = useToast();
  const { confirm, dialog } = useConfirm();
  const ledger = useQuery<LedgerEntry[]>(() => liquidity.ledger({ accountId: id }), [id]);
  if (!a) return <Drawer title="Cuenta" onClose={onClose}><Loading /></Drawer>;

  const opening = () =>
    confirm({
      title: `Saldo inicial · ${a.name}`,
      intro: 'Registra con qué saldo arranca la cuenta en la plataforma. Solo se permite en una cuenta sin movimientos; después, todo cambio pasa por órdenes, traslados o ajustes aprobados.',
      fields: [
        {
          name: 'amount',
          label: `Monto (${a.asset})`,
          hint: a.asset === 'COP' ? 'Pesos enteros.' : 'Hasta 6 decimales.',
          validate: (v) => parseAmountInput(v, decimalsOf(a.asset)).error ?? null,
        },
      ],
      reason: { label: 'De dónde sale el saldo', placeholder: 'Por ejemplo: extracto bancario del 20/10' },
      stepUp: true,
      confirmLabel: 'Registrar saldo inicial',
      onConfirm: async ({ fields, reason, mfaCode, idempotencyKey }) => {
        await liquidity.openingBalance(a.id, parseAmountInput(fields.amount, decimalsOf(a.asset)).value!, reason, { idempotencyKey, mfaCode });
        toast('Saldo inicial registrado');
        ledger.reload();
      },
    });

  return (
    <Drawer title={a.name} onClose={onClose}>
      <KeyValue
        items={[
          ['Código', a.code],
          ['Tipo', `${LIQUIDITY_TYPE[a.liquidity_type]} · ${a.asset}`],
          ['Red', a.network ? NETWORK[a.network] : '—'],
          ['Cuenta o dirección', <CopyValue value={a.external_ref} short={false} />],
          ['Saldo', <strong>{amountOf(a.asset, a.balance)}</strong>],
          ['Reservado', amountOf(a.asset, a.reserved)],
          ['Disponible', <strong>{amountOf(a.asset, a.available)}</strong>],
          ['Predeterminada', a.is_default ? <Badge tone="info">Sí: recibe y entrega por defecto</Badge> : 'No'],
        ]}
      />
      {can('liquidity.manage') && ledger.data?.length === 0 && (
        <div className="action-panel">
          <h4>Saldo inicial</h4>
          <p>La cuenta no tiene movimientos: puedes registrar su saldo de arranque.</p>
          <Button onClick={opening}>Registrar saldo inicial</Button>
        </div>
      )}
      <h3>Movimientos del libro</h3>
      {ledger.error ? (
        <ErrorNotice error={ledger.error} />
      ) : !ledger.data ? (
        <Loading />
      ) : ledger.data.length === 0 ? (
        <EmptyState title="Sin movimientos" />
      ) : (
        <ul className="plain-list">
          {ledger.data.map((e) => {
            const mine = e.lines.find((l) => l.account === a.code);
            const amt = String(mine?.amount ?? '0');
            return (
              <li key={e.id}>
                <span className={`amount ${amt.startsWith('-') ? 'text-danger' : 'text-success'}`}>
                  {amt.startsWith('-') ? '−' : '+'} {amountOf(a.asset, amt.replace('-', ''))}
                </span>
                <span>{e.description ?? e.kind}</span>
                <span className="cell-sub">
                  Asiento #{e.seq} · {dateTime(e.created_at)}
                  {e.order_id && (
                    <>
                      {' · '}
                      <a href={href(`ordenes/${e.order_id}`)}>ver orden</a>
                    </>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {dialog}
    </Drawer>
  );
}

function InternalTransferDialog({ accounts, onClose }: { accounts: LiquidityAccount[]; onClose: () => void }) {
  const toast = useToast();
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [raw, setRaw] = useState('');
  const [reason, setReason] = useState('');
  const source = accounts.find((a) => a.id === from);
  const targets = accounts.filter((a) => source && a.id !== from && a.asset === source.asset && (!source.network || !a.network || a.network === source.network));
  const amount = raw && source ? parseAmountInput(raw, decimalsOf(source.asset)) : null;
  return (
    <FormModal
      title="Traslado entre cuentas propias"
      submitLabel="Crear traslado"
      stepUp
      canSubmit={!!(source && to && amount?.value && reason.trim().length >= 3)}
      onClose={onClose}
      onSubmit={async (o) => {
        await transfers.internal({ fromAccountId: from, toAccountId: to, amount: amount!.value!, reason: reason.trim() }, o);
        toast('Traslado creado: queda autorizado para firmar o registrar en Transferencias');
      }}
    >
      <p className="confirm-intro">Mueve fondos entre cuentas de la mesa (por ejemplo, de la billetera al exchange). Se reserva el monto en el origen y sigue el mismo control que una entrega.</p>
      <Field label="Desde" required>
        {(id) => (
          <Select
            id={id}
            value={from}
            onChange={(e) => {
              setFrom(e.target.value);
              setTo('');
            }}
            placeholder="Cuenta de origen"
            options={accounts.map((a) => ({ value: a.id, label: `${a.name} · disponible ${amountOf(a.asset, a.available)}` }))}
          />
        )}
      </Field>
      <Field label="Hacia" required hint={source ? 'Solo cuentas del mismo activo y red.' : undefined}>
        {(id) => <Select id={id} value={to} onChange={(e) => setTo(e.target.value)} disabled={!source} placeholder="Cuenta de destino" options={targets.map((a) => ({ value: a.id, label: a.name }))} />}
      </Field>
      <Field label={`Monto${source ? ` (${source.asset})` : ''}`} required error={raw && amount?.error ? amount.error : null} hint={amount?.value && source ? amountOf(source.asset, amount.value) : undefined}>
        {(id) => <Input id={id} inputMode="decimal" value={raw} onChange={(e) => setRaw(e.target.value)} disabled={!source} />}
      </Field>
      <Field label="Motivo" required>
        {(id) => <Textarea id={id} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />}
      </Field>
    </FormModal>
  );
}

function NewAccountDialog({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const [f, setF] = useState({ code: '', name: '', asset: 'USDT' as Asset, liquidityType: 'WALLET', network: 'BSC' as Network, externalRef: '', isDefault: false });
  const set = (k: keyof typeof f, v: unknown) => setF((x) => ({ ...x, [k]: v }));
  const codeOk = /^[A-Z0-9_]{3,40}$/.test(f.code);
  const wallet = f.liquidityType === 'WALLET';
  return (
    <FormModal
      title="Nueva cuenta de liquidez"
      submitLabel="Crear cuenta"
      stepUp
      canSubmit={codeOk && f.name.trim().length >= 3 && (!wallet || f.externalRef.trim().length >= 3)}
      onClose={onClose}
      onSubmit={async (o) => {
        await liquidity.createAccount(
          {
            code: f.code,
            name: f.name.trim(),
            asset: f.asset,
            liquidityType: f.liquidityType,
            network: f.asset === 'USDT' && f.liquidityType !== 'BANK' ? f.network : null,
            externalRef: f.externalRef.trim() || null,
            isDefault: f.isDefault,
          },
          o,
        );
        toast(`Cuenta ${f.code} creada`);
      }}
    >
      <Notice tone="info">Registra solo identificadores públicos (número de cuenta o dirección). Nunca escribas aquí claves privadas, frases semilla ni contraseñas.</Notice>
      <div className="form-row">
        <Field label="Código" required error={f.code && !codeOk ? 'Mayúsculas, números y guion bajo (3 a 40)' : null} hint="Ejemplo: WALLET_BSC_2">
          {(id) => <Input id={id} value={f.code} onChange={(e) => set('code', e.target.value.toUpperCase())} />}
        </Field>
        <Field label="Nombre" required>
          {(id) => <Input id={id} value={f.name} onChange={(e) => set('name', e.target.value)} />}
        </Field>
      </div>
      <div className="form-row">
        <Field label="Activo" required>
          {(id) => <Select id={id} value={f.asset} onChange={(e) => set('asset', e.target.value)} options={[{ value: 'USDT', label: 'USDT' }, { value: 'COP', label: 'Pesos (COP)' }]} />}
        </Field>
        <Field label="Tipo" required>
          {(id) => (
            <Select
              id={id}
              value={f.liquidityType}
              onChange={(e) => set('liquidityType', e.target.value)}
              options={Object.entries(LIQUIDITY_TYPE).map(([value, label]) => ({ value, label }))}
            />
          )}
        </Field>
      </div>
      {f.asset === 'USDT' && f.liquidityType !== 'BANK' && (
        <Field label="Red" required>
          {(id) => <Select id={id} value={f.network} onChange={(e) => set('network', e.target.value)} options={[{ value: 'BSC', label: NETWORK.BSC }, { value: 'TRON', label: NETWORK.TRON }]} />}
        </Field>
      )}
      <Field label={wallet ? 'Dirección pública' : 'Número de cuenta o referencia'} required={wallet} hint={wallet ? 'Se valida el formato de la red.' : 'Opcional.'}>
        {(id) => <Input id={id} className="input mono" value={f.externalRef} onChange={(e) => set('externalRef', e.target.value)} spellCheck={false} />}
      </Field>
      <Checkbox label="Usar como cuenta predeterminada para su activo y red" checked={f.isDefault} onChange={(v) => set('isDefault', v)} />
    </FormModal>
  );
}
