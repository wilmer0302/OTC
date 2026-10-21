import { useState } from 'react';
import { counterparties, pricing } from '../../api/endpoints';
import type { CounterpartyRow, PricingRule, TrmRow } from '../../api/types';
import { useCan } from '../../app/session';
import { copPrice, dateOnly, dateTime, pct, usdt } from '../../lib/format';
import { useQuery } from '../../lib/hooks';
import { Badge, SimulatedTag } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { DataTable, type Column } from '../../ui/DataTable';
import { useToast } from '../../ui/Feedback';
import { Checkbox, Field, Input, parseAmountInput, Select } from '../../ui/Form';
import { FormModal } from '../../ui/FormModal';
import { Card, Notice } from '../../ui/Layout';
import { TrmDialog } from './TrmDialog';

/** "0.1" (%) → "0.001" sin pasar por números de punto flotante. */
export function percentToRate(p: string): string {
  const [i, f = ''] = p.split('.');
  const digits = (i + f).replace(/^0+/, '') || '0';
  const decimals = f.length + 2;
  const padded = digits.padStart(decimals + 1, '0');
  return `${padded.slice(0, -decimals)}.${padded.slice(-decimals)}`.replace(/\.?0+$/, '') || '0';
}

export function Precios() {
  const can = useCan();
  const trm = useQuery<TrmRow[]>(() => pricing.trm(), []);
  const rules = useQuery<PricingRule[]>(() => pricing.rules(), []);
  const clients = useQuery<CounterpartyRow[]>(() => counterparties.list(), []);
  const [trmOpen, setTrmOpen] = useState(false);
  const [ruleFor, setRuleFor] = useState<Partial<PricingRule> | null>(null);
  const clientName = (id: string | null) => (id ? clients.data?.find((c) => c.id === id)?.legal_name ?? 'Cliente' : 'Todos los clientes');

  const trmCols: Column<TrmRow>[] = [
    { key: 'd', header: 'Día', render: (t) => <span className="cell-main">{dateOnly(t.valid_date)}</span> },
    { key: 'r', header: 'TRM', align: 'right', render: (t) => <strong>{copPrice(t.rate)}</strong> },
    { key: 's', header: 'Fuente', render: (t) => <>{t.source} {t.simulated && <SimulatedTag>SIMULADA</SimulatedTag>}</> },
    { key: 'c', header: 'Registrada', secondary: true, render: (t) => dateTime(t.created_at) },
  ];
  const ruleCols: Column<PricingRule>[] = [
    { key: 'c', header: 'Aplica a', render: (r) => <span className="cell-main">{clientName(r.counterparty_id)}</span> },
    { key: 'm', header: 'Desde', align: 'right', render: (r) => (Number(r.min_usdt) > 0 ? usdt(r.min_usdt) : 'Cualquier monto') },
    { key: 'b', header: 'Mesa compra a', align: 'right', render: (r) => `TRM − ${copPrice(r.buy_margin_cop)}` },
    { key: 's', header: 'Mesa vende a', align: 'right', render: (r) => `TRM + ${copPrice(r.sell_margin_cop)}` },
    { key: 'f', header: 'Comisión', align: 'right', render: (r) => pct(r.commission_rate) },
    { key: 'a', header: 'Estado', render: (r) => (r.active ? <Badge tone="success">Activa</Badge> : <Badge>Inactiva</Badge>) },
    { key: 'w', header: 'Motivo', secondary: true, render: (r) => <>{r.reason}<span className="cell-sub">{dateTime(r.created_at)}</span></> },
    { key: 'x', header: '', render: (r) => can('pricing.manage') && <Button size="sm" onClick={() => setRuleFor(r)}>Cambiar</Button> },
  ];

  return (
    <>
      <Card flush title="TRM por día" actions={can('trm.record') && <Button onClick={() => setTrmOpen(true)}>Cargar TRM de hoy</Button>}>
        <DataTable columns={trmCols} rows={trm.data?.slice(0, 30) ?? null} rowKey={(t) => t.id} loading={trm.loading} error={trm.error} empty={{ title: 'No hay TRM registrada', hint: 'Sin TRM del día la mesa no cotiza.' }} />
      </Card>
      <Card flush title="Reglas de precio" actions={can('pricing.manage') && <Button variant="primary" onClick={() => setRuleFor({})}>Nueva regla</Button>}>
        <div className="card-section">
          <Notice title="Uso interno">
            El cliente ve solo el precio por USDT todo incluido y la comisión. La TRM y el margen de la mesa nunca se le muestran. Precio de venta = (TRM + margen de venta) × (1 + comisión); precio de compra = (TRM − margen de compra) × (1 − comisión). El servidor aplica la regla del cliente si existe y, si no, la general, según el tramo del monto.
          </Notice>
        </div>
        <DataTable columns={ruleCols} rows={rules.data} rowKey={(r) => r.id} loading={rules.loading} error={rules.error} empty={{ title: 'No hay reglas de precio' }} />
      </Card>
      {trmOpen && <TrmDialog onClose={() => setTrmOpen(false)} onDone={trm.reload} />}
      {ruleFor && <RuleDialog base={ruleFor} clients={clients.data ?? []} onClose={() => setRuleFor(null)} onDone={rules.reload} />}
    </>
  );
}

function RuleDialog({ base, clients, onClose, onDone }: { base: Partial<PricingRule>; clients: CounterpartyRow[]; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const editing = !!base.id;
  const [f, setF] = useState({
    counterpartyId: base.counterparty_id ?? '',
    minUsdt: base.min_usdt && Number(base.min_usdt) > 0 ? String(Number(base.min_usdt)) : '',
    buy: base.buy_margin_cop ? String(Number(base.buy_margin_cop)) : '',
    sell: base.sell_margin_cop ? String(Number(base.sell_margin_cop)) : '',
    commission: base.commission_rate ? String(+(Number(base.commission_rate) * 100).toFixed(4)) : '',
    active: base.active ?? true,
    reason: '',
  });
  const set = (k: keyof typeof f, v: string | boolean) => setF((p) => ({ ...p, [k]: v }));
  const min = f.minUsdt ? parseAmountInput(f.minUsdt, 6) : { value: '0' };
  const buy = f.buy ? parseAmountInput(f.buy, 2) : null;
  const sell = f.sell ? parseAmountInput(f.sell, 2) : null;
  const com = f.commission ? parseAmountInput(f.commission, 4) : null;
  const comErr = com?.value && Number(com.value) > 10 ? 'Máximo 10 %' : com?.error;
  const ok = !!min.value && !!buy?.value && !!sell?.value && !!com?.value && !comErr && f.reason.trim().length >= 3;
  return (
    <FormModal
      title={editing ? 'Cambiar regla de precio' : 'Nueva regla de precio'}
      submitLabel="Guardar regla"
      stepUp
      canSubmit={ok}
      onClose={onClose}
      onSubmit={async (o) => {
        await pricing.setRule(
          { counterpartyId: f.counterpartyId || null, minUsdt: min.value, buyMarginCop: buy!.value, sellMarginCop: sell!.value, commissionRate: percentToRate(com!.value!), active: f.active, reason: f.reason.trim() },
          o,
        );
        toast('Regla de precio guardada; rige para cotizaciones nuevas');
        onDone();
      }}
    >
      <p className="confirm-intro">Las cotizaciones ya emitidas conservan su precio. La regla anterior queda en el historial.</p>
      <div className="form-row">
        <Field label="Aplica a">
          {(id) => <Select id={id} value={f.counterpartyId} disabled={editing} onChange={(e) => set('counterpartyId', e.target.value)} placeholder="Todos los clientes" options={clients.map((c) => ({ value: c.id, label: c.legal_name }))} />}
        </Field>
        <Field label="Desde (USDT)" hint="Vacío = cualquier monto" error={min.error}>
          {(id) => <Input id={id} inputMode="decimal" value={f.minUsdt} disabled={editing} onChange={(e) => set('minUsdt', e.target.value)} />}
        </Field>
        <Field label="Margen de compra (COP por USDT)" required hint="La mesa compra a TRM menos este valor" error={buy?.error}>
          {(id) => <Input id={id} inputMode="decimal" value={f.buy} onChange={(e) => set('buy', e.target.value)} />}
        </Field>
        <Field label="Margen de venta (COP por USDT)" required hint="La mesa vende a TRM más este valor" error={sell?.error}>
          {(id) => <Input id={id} inputMode="decimal" value={f.sell} onChange={(e) => set('sell', e.target.value)} />}
        </Field>
        <Field label="Comisión (%)" required hint="Ej.: 0,1 para 0,1 %" error={comErr}>
          {(id) => <Input id={id} inputMode="decimal" value={f.commission} onChange={(e) => set('commission', e.target.value)} />}
        </Field>
      </div>
      <Checkbox label="Regla activa" checked={f.active} onChange={(v) => set('active', v)} />
      <Field label="Motivo del cambio" required>
        {(id) => <Input id={id} value={f.reason} onChange={(e) => set('reason', e.target.value)} />}
      </Field>
    </FormModal>
  );
}
