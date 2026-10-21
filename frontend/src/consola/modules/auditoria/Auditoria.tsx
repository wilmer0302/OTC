import { useEffect, useState } from 'react';
import { audit, orders, quotes, reconciliation, requests, transfers, users } from '../../api/endpoints';
import type { Anchor, AuditRecord, AuditVerify, HistoryEntry, UserRow } from '../../api/types';
import { href, navigate, replaceQuery } from '../../app/router';
import { useCan } from '../../app/session';
import { dateOnly, dateTime } from '../../lib/format';
import { notifyChange, useDebounced, useQuery } from '../../lib/hooks';
import { ENTITY, ORDER_STATUS, PROPOSAL_STATUS, QUOTE_STATUS, RECON_RUN_STATUS, REQUEST_STATUS, TRANSFER_STATUS, type Tone } from '../../lib/labels';
import { Badge } from '../../ui/Badge';
import { Button, LinkButton } from '../../ui/Button';
import { CopyValue } from '../../ui/Copy';
import { DataTable, type Column } from '../../ui/DataTable';
import { Drawer } from '../../ui/Drawer';
import { ErrorNotice, useToast } from '../../ui/Feedback';
import { Field, FilterBar, FilterSelect, Input, SearchInput, Select } from '../../ui/Form';
import { Card, EmptyState, KeyValue, Loading, Notice, PageHeader, Tabs } from '../../ui/Layout';
import { useConfirm } from '../../ui/Modal';
import { Timeline } from '../../ui/Timeline';
import type { PageProps } from '../index';

type View = 'registro' | 'integridad' | 'objeto';

/** Áreas del registro: el prefijo de la acción (auth.login → auth). */
const AREA: Record<string, string> = {
  auth: 'Accesos y sesiones',
  request: 'Solicitudes',
  quote: 'Cotizaciones',
  order: 'Órdenes',
  transfer: 'Transferencias',
  settlement: 'Pagos y entregas',
  liquidity: 'Liquidez',
  ledger: 'Libro contable',
  recon_item: 'Partidas de conciliación',
  recon_run: 'Conciliaciones',
  adjustment: 'Ajustes',
  case: 'Casos de revisión',
  counterparty: 'Clientes',
  destination: 'Destinos de pago',
  limit: 'Límites',
  pricing: 'Precios',
  trm: 'TRM',
  settings: 'Configuración',
  user: 'Usuarios',
  sandbox: 'Simulador (demo)',
  demo: 'Datos de demostración',
  audit: 'Auditoría',
};

/** Objetos con historial de estados y el módulo donde se abren. */
const HISTORY: Record<string, { label: string; map: Record<string, { label: string; tone: Tone }>; module: string }> = {
  request: { label: 'Solicitud', map: REQUEST_STATUS, module: 'solicitudes' },
  quote: { label: 'Cotización', map: QUOTE_STATUS, module: 'cotizaciones' },
  order: { label: 'Orden', map: ORDER_STATUS, module: 'ordenes' },
  transfer: { label: 'Transferencia', map: TRANSFER_STATUS, module: 'transferencias' },
  recon_run: { label: 'Conciliación', map: RECON_RUN_STATUS, module: 'conciliaciones' },
  adjustment: { label: 'Ajuste', map: PROPOSAL_STATUS, module: 'conciliaciones' },
};

const actionTone = (a: string): Tone => (/failed|locked|step_up_failed|rejected|rechaz/.test(a) ? 'danger' : a.startsWith('sandbox.') || a.startsWith('demo.') ? 'warning' : 'neutral');

export default function Auditoria({ route }: PageProps) {
  const can = useCan();
  const canAudit = can('audit.read');
  const asked = route.query.get('vista') as View | null;
  const view: View = !canAudit ? 'objeto' : asked === 'integridad' || asked === 'objeto' ? asked : 'registro';
  return (
    <>
      <PageHeader
        title="Historial y auditoría"
        subtitle="Quién hizo qué, cuándo y desde dónde. El registro es encadenado: no se puede editar ni borrar, y su integridad se puede verificar en cualquier momento."
      />
      {canAudit ? (
        <Tabs
          tabs={[
            { key: 'registro', label: 'Registro de auditoría' },
            { key: 'integridad', label: 'Integridad y anclas' },
            { key: 'objeto', label: 'Historial de un objeto' },
          ]}
          active={view}
          onChange={(k) => navigate('auditoria', { vista: k === 'registro' ? undefined : k })}
        />
      ) : (
        <Notice title="Ves el historial de estados de cada operación">El registro completo de auditoría lo consultan Cumplimiento, Administración y Auditoría.</Notice>
      )}
      {view === 'registro' && <AuditLog route={route} />}
      {view === 'integridad' && <Integrity />}
      {view === 'objeto' && <ObjectHistory route={route} />}
    </>
  );
}

/** Convierte un día de Bogotá (UTC−5, sin horario de verano) en el instante en que empieza. */
const dayStart = (d: string, plusDays = 0) => {
  const t = new Date(`${d}T00:00:00-05:00`);
  t.setUTCDate(t.getUTCDate() + plusDays);
  return t.toISOString();
};

function AuditLog({ route }: PageProps) {
  const q = route.query;
  const f = { area: q.get('area') ?? '', entity: q.get('entidad') ?? '', entityId: q.get('id') ?? '', actorId: q.get('usuario') ?? '', from: q.get('desde') ?? '', to: q.get('hasta') ?? '' };
  const setFilter = (k: string, v: string) =>
    replaceQuery('auditoria', { area: f.area, entidad: f.entity, id: f.entityId, usuario: f.actorId, desde: f.from, hasta: f.to, [k]: v || undefined });
  const [idInput, setIdInput] = useState(f.entityId);
  const debouncedId = useDebounced(idInput.trim(), 400);
  useEffect(() => {
    if (debouncedId !== f.entityId) setFilter('id', debouncedId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedId]);

  const userList = useQuery<UserRow[]>(() => users.list().catch(() => [] as UserRow[]), []);
  const [items, setItems] = useState<AuditRecord[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [selected, setSelected] = useState<AuditRecord | null>(null);
  const key = JSON.stringify(f);

  const load = async (before?: string) => {
    setLoading(true);
    setError(null);
    try {
      const r = await audit.list({
        action: f.area ? `${f.area}.` : undefined,
        entity: f.entity || undefined,
        entityId: f.entityId || undefined,
        actorId: f.actorId || undefined,
        from: f.from ? dayStart(f.from) : undefined,
        to: f.to ? dayStart(f.to, 1) : undefined,
        before,
        limit: 100,
      });
      setItems((prev) => (before ? [...prev, ...r.items] : r.items));
      setNext(r.next);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    setSelected(null);
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const actorName = (r: AuditRecord) => r.actor ?? (r.actor_id === '0' ? 'Sistema' : r.actor_id ? `Usuario ${r.actor_id}` : 'Sistema');
  const columns: Column<AuditRecord>[] = [
    { key: 'at', header: 'Fecha y hora', render: (r) => <span className="nowrap">{dateTime(r.at)}</span> },
    {
      key: 'actor',
      header: 'Usuario',
      render: (r) =>
        r.actor_id && r.actor_id !== '0' ? (
          <button type="button" className="link-button" title="Ver solo este usuario" onClick={(e) => { e.stopPropagation(); setFilter('usuario', r.actor_id!); }}>
            {actorName(r)}
          </button>
        ) : (
          <span className="muted">{actorName(r)}</span>
        ),
    },
    { key: 'action', header: 'Acción', render: (r) => <Badge tone={actionTone(r.action)}>{r.action}</Badge> },
    { key: 'entity', header: 'Objeto', render: (r) => (r.entity ? <span>{ENTITY[r.entity] ?? r.entity}</span> : <span className="muted">—</span>) },
    { key: 'ip', header: 'Origen', secondary: true, render: (r) => <span className="mono muted">{originOf(r)?.ip ?? '—'}</span> },
    { key: 'id', header: 'Registro', align: 'right', secondary: true, render: (r) => <span className="mono muted">{r.id}</span> },
  ];
  const activeUser = f.actorId ? userList.data?.find((u) => u.id === f.actorId)?.full_name ?? items.find((i) => i.actor_id === f.actorId)?.actor ?? `Usuario ${f.actorId}` : null;

  return (
    <div className={selected ? 'split' : ''}>
      <Card flush title="Registro de auditoría">
        <div className="card-section">
          <FilterBar
            right={
              <>
                <Button size="sm" onClick={() => exportCsv(items)} disabled={!items.length}>
                  Exportar CSV
                </Button>
                <Button size="sm" onClick={() => void load()} busy={loading}>
                  Actualizar
                </Button>
              </>
            }
          >
            <FilterSelect label="Área" value={f.area} onChange={(v) => setFilter('area', v)} allLabel="Todas" options={Object.entries(AREA).map(([value, label]) => ({ value, label }))} />
            <FilterSelect label="Objeto" value={f.entity} onChange={(v) => setFilter('entidad', v)} options={Object.entries(ENTITY).map(([value, label]) => ({ value, label }))} />
            {userList.data && userList.data.length > 0 ? (
              <FilterSelect label="Usuario" value={f.actorId} onChange={(v) => setFilter('usuario', v)} options={userList.data.map((u) => ({ value: u.id, label: u.full_name }))} />
            ) : null}
            <label className="filter-select">
              <span>Desde</span>
              <input type="date" className="input" value={f.from} max={f.to || undefined} onChange={(e) => setFilter('desde', e.target.value)} />
            </label>
            <label className="filter-select">
              <span>Hasta</span>
              <input type="date" className="input" value={f.to} min={f.from || undefined} onChange={(e) => setFilter('hasta', e.target.value)} />
            </label>
            <SearchInput label="Identificador del objeto" placeholder="Pega el identificador…" value={idInput} onChange={setIdInput} />
          </FilterBar>
          {activeUser && !userList.data?.length && (
            <div className="filter-chips">
              <Badge tone="info">Usuario: {activeUser}</Badge>
              <button type="button" className="link-button" onClick={() => setFilter('usuario', '')}>
                Quitar filtro
              </button>
            </div>
          )}
        </div>
        <DataTable
          columns={columns}
          rows={error && !items.length ? null : items}
          rowKey={(r) => r.id}
          loading={loading && !items.length}
          error={items.length ? null : error}
          selectedKey={selected?.id ?? null}
          onRowClick={(r) => setSelected(r)}
          empty={{ title: 'No hay registros con estos filtros' }}
        />
        {items.length > 0 && (
          <div className="card-section table-more">
            <span className="muted">{items.length} registros cargados, del más reciente al más antiguo.</span>
            {error ? <ErrorNotice error={error} compact /> : null}
            {next && (
              <Button size="sm" onClick={() => void load(next)} busy={loading}>
                Cargar más antiguos
              </Button>
            )}
          </div>
        )}
      </Card>
      {selected && <RecordDrawer record={selected} actor={actorName(selected)} onClose={() => setSelected(null)} onFilterEntity={() => { setIdInput(selected.entity_id ?? ''); replaceQuery('auditoria', { entidad: selected.entity ?? undefined, id: selected.entity_id ?? undefined }); }} />}
    </div>
  );
}

function originOf(r: AuditRecord): { ip?: string; userAgent?: string } | null {
  const d = r.data as { origin?: { ip?: string; userAgent?: string }; ip?: string } | null;
  if (!d) return null;
  return d.origin ?? (d.ip ? { ip: d.ip } : null);
}

function RecordDrawer({ record, actor, onClose, onFilterEntity }: { record: AuditRecord; actor: string; onClose: () => void; onFilterEntity: () => void }) {
  const origin = originOf(record);
  const { origin: _o, ...rest } = (record.data ?? {}) as Record<string, unknown>;
  const h = record.entity ? HISTORY[record.entity] : undefined;
  return (
    <Drawer title={`Registro ${record.id}`} onClose={onClose}>
      <KeyValue
        items={[
          ['Fecha y hora', dateTime(record.at)],
          ['Usuario', actor],
          ['Acción', <Badge key="a" tone={actionTone(record.action)}>{record.action}</Badge>],
          ['Área', AREA[record.action.split('.')[0]] ?? record.action.split('.')[0]],
          ['Objeto', record.entity ? `${ENTITY[record.entity] ?? record.entity}` : '—'],
          ['Identificador', record.entity_id ? <CopyValue key="e" value={record.entity_id} /> : '—'],
          ['Dirección IP', origin?.ip ?? '—'],
          ['Navegador', origin?.userAgent ? <span key="u" className="muted small">{origin.userAgent}</span> : '—'],
          ['Huella (hash)', <CopyValue key="h" value={record.hash} />],
        ]}
      />
      <h3>Datos registrados</h3>
      {Object.keys(rest).length ? <pre className="json-block">{JSON.stringify(rest, null, 2)}</pre> : <p className="muted">Sin datos adicionales.</p>}
      {record.entity_id && (
        <div className="action-row">
          <Button size="sm" onClick={onFilterEntity}>
            Ver todo el registro de este objeto
          </Button>
          {h && (
            <LinkButton size="sm" href={href(`${h.module}/${record.entity === 'adjustment' ? '' : record.entity_id}`.replace(/\/$/, ''), record.entity === 'adjustment' ? { vista: 'ajustes' } : undefined)}>
              Abrir en {h.label === 'Ajuste' ? 'Conciliaciones' : `${h.label.toLowerCase()}`}
            </LinkButton>
          )}
        </div>
      )}
      {h && record.entity_id && (
        <>
          <h3>Historial de estados</h3>
          <HistoryTimeline entity={record.entity!} id={record.entity_id} />
        </>
      )}
    </Drawer>
  );
}

function HistoryTimeline({ entity, id }: { entity: string; id: string }) {
  const hist = useQuery<HistoryEntry[]>(() => audit.history(entity, id), [entity, id]);
  if (hist.loading && !hist.data) return <Loading />;
  if (hist.error) return <ErrorNotice error={hist.error} compact />;
  return <Timeline entries={hist.data ?? []} map={HISTORY[entity].map} />;
}

function Integrity() {
  const toast = useToast();
  const [result, setResult] = useState<AuditVerify | null>(null);
  const [checkedAt, setCheckedAt] = useState<Date | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [verifyError, setVerifyError] = useState<unknown>(null);
  const anchors = useQuery<Anchor[]>(() => audit.anchors(), []);
  const { confirm, dialog } = useConfirm(() => anchors.reload());

  const verify = async () => {
    setVerifying(true);
    setVerifyError(null);
    try {
      setResult(await audit.verify());
      setCheckedAt(new Date());
    } catch (e) {
      setVerifyError(e);
    } finally {
      setVerifying(false);
    }
  };

  const columns: Column<Anchor>[] = [
    { key: 'id', header: 'Ancla', render: (a) => <span className="cell-main">#{a.id}</span>, width: '70px' },
    { key: 'at', header: 'Fijada', render: (a) => dateTime(a.created_at) },
    { key: 'r', header: 'Registros cubiertos', align: 'right', render: (a) => Number(a.records).toLocaleString('es-CO') },
    { key: 'h', header: 'Huella', render: (a) => <CopyValue value={a.hash} /> },
    { key: 'n', header: 'Nota', secondary: true, render: (a) => a.note ?? <span className="muted">—</span> },
  ];

  return (
    <>
      <Card
        title="Verificar integridad"
        actions={
          <Button variant="primary" onClick={verify} busy={verifying}>
            Verificar ahora
          </Button>
        }
      >
        <p className="muted">
          Cada registro guarda la huella del anterior. La verificación recalcula la cadena completa en el servidor y compara cada ancla. Si alguien alterara o borrara un registro directamente en la base, la verificación lo señala.
        </p>
        {verifyError ? <ErrorNotice error={verifyError} /> : null}
        {result &&
          (result.ok ? (
            <Notice tone="success" title="Registro íntegro">
              Se verificaron {result.chain.checked?.toLocaleString('es-CO')} registros y {result.anchors.checked} anclas. Todo coincide. {checkedAt && <span className="muted">Verificado: {checkedAt.toLocaleTimeString('es-CO')}</span>}
            </Notice>
          ) : (
            <Notice tone="danger" title="La auditoría no coincide">
              {result.chain.ok ? 'La cadena está completa, ' : `La cadena se rompe en el registro ${result.chain.brokenAt}. `}
              {result.anchors.brokenAnchor ? `el ancla #${result.anchors.brokenAnchor} ya no corresponde al registro que fijó.` : 'las anclas coinciden.'} Escala el caso a Cumplimiento y conserva las anclas guardadas fuera de la plataforma.
            </Notice>
          ))}
      </Card>
      <Card
        flush
        title="Anclas"
        actions={
          <Button
            onClick={() =>
              confirm({
                title: 'Fijar un ancla ahora',
                intro: 'Se guarda la huella del último registro de auditoría. Copia esa huella y consérvala fuera de la plataforma (correo, acta o documento firmado): sirve para demostrar después que el registro no cambió.',
                confirmLabel: 'Fijar ancla',
                reason: { label: 'Nota', placeholder: 'Ej.: cierre de mes, revisión externa…', optional: true },
                onConfirm: async (v) => {
                  const a = await audit.createAnchor(v.reason || null, { idempotencyKey: v.idempotencyKey });
                  toast(`Ancla #${a.id} fijada`);
                  notifyChange();
                  return a;
                },
              })
            }
          >
            Fijar ancla
          </Button>
        }
      >
        <div className="card-section">
          <p className="muted">El sistema fija un ancla diaria automática cuando hubo actividad. Puedes fijar otra en cualquier momento.</p>
        </div>
        <DataTable columns={columns} rows={anchors.data} rowKey={(a) => a.id} loading={anchors.loading} error={anchors.error} empty={{ title: 'Aún no hay anclas' }} />
      </Card>
      {dialog}
    </>
  );
}

interface Pickable {
  id: string;
  label: string;
}

const PICKERS: Record<string, () => Promise<Pickable[]>> = {
  order: async () => (await orders.list()).map((o) => ({ id: o.id, label: `Orden #${o.number} · ${o.counterparty_name}` })),
  request: async () => (await requests.list()).map((r) => ({ id: r.id, label: `Solicitud #${r.number} · ${r.counterparty_name}` })),
  quote: async () => (await quotes.list()).map((r) => ({ id: r.id, label: `Cotización #${r.number} · solicitud #${r.request_number}` })),
  transfer: async () => (await transfers.list()).map((t) => ({ id: t.id, label: `Transferencia #${t.number}` })),
  recon_run: async () => (await reconciliation.list()).map((r) => ({ id: r.id, label: `${dateOnly(r.business_date)} · ${r.account_code}` })),
  adjustment: async () => (await reconciliation.adjustments()).map((a) => ({ id: a.id, label: `Ajuste #${a.number}` })),
};

/** Historial de estados de una operación, para cualquier usuario con lectura de operaciones. */
function ObjectHistory({ route }: PageProps) {
  const type = route.query.get('tipo') ?? 'order';
  const id = route.query.get('objeto') ?? '';
  const [search, setSearch] = useState('');
  const list = useQuery<Pickable[]>(() => (PICKERS[type] ?? PICKERS.order)(), [type]);
  const s = search.trim().toLowerCase().replace('#', '');
  const options = (list.data ?? []).filter((o) => !s || o.label.toLowerCase().includes(s));
  const set = (k: string, v: string) => replaceQuery('auditoria', { vista: 'objeto', tipo: type, objeto: id, [k]: v || undefined, ...(k === 'tipo' ? { objeto: undefined } : {}) });
  const h = HISTORY[type] ?? HISTORY.order;

  return (
    <Card title="Historial de un objeto">
      <p className="muted">Elige la operación para ver cada cambio de estado: quién lo hizo, cuándo y con qué motivo.</p>
      <div className="form-row form-row-3">
        <Field label="Tipo">
          {(fid) => <Select id={fid} value={type} onChange={(e) => set('tipo', e.target.value)} options={Object.entries(HISTORY).map(([value, x]) => ({ value, label: x.label }))} />}
        </Field>
        <Field label="Buscar por número o cliente">
          {(fid) => <Input id={fid} value={search} placeholder="Ej.: 12" onChange={(e) => setSearch(e.target.value)} />}
        </Field>
        <Field label={h.label}>
          {(fid) => (
            <Select
              id={fid}
              value={id}
              onChange={(e) => set('objeto', e.target.value)}
              placeholder={list.loading ? 'Cargando…' : options.length ? 'Elige uno' : 'No hay resultados'}
              options={options.map((o) => ({ value: o.id, label: o.label }))}
            />
          )}
        </Field>
      </div>
      {list.error ? <ErrorNotice error={list.error} compact /> : null}
      {id ? (
        <>
          <div className="action-row">
            <LinkButton size="sm" href={type === 'adjustment' ? href('conciliaciones', { vista: 'ajustes' }) : href(`${h.module}/${id}`)}>
              Abrir en el módulo
            </LinkButton>
          </div>
          <HistoryTimeline entity={type} id={id} />
        </>
      ) : (
        <EmptyState title="Elige una operación para ver su historial" />
      )}
    </Card>
  );
}

function exportCsv(rows: AuditRecord[]) {
  const esc = (v: unknown) => {
    const s = v == null ? '' : typeof v === 'string' ? v : JSON.stringify(v);
    return /[",;\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const head = ['registro', 'fecha', 'usuario', 'accion', 'objeto', 'identificador', 'datos', 'huella'];
  const lines = rows.map((r) => [r.id, r.at, r.actor ?? r.actor_id ?? 'Sistema', r.action, r.entity, r.entity_id, r.data, r.hash].map(esc).join(','));
  const blob = new Blob(['﻿' + [head.join(','), ...lines].join('\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `auditoria-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}
