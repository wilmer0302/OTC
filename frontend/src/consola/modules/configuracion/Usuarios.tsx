import { useState } from 'react';
import { users } from '../../api/endpoints';
import type { Role, UserRow } from '../../api/types';
import { useSession } from '../../app/session';
import { dateOnly, dateTime } from '../../lib/format';
import { useQuery } from '../../lib/hooks';
import { ROLE } from '../../lib/labels';
import { Badge } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { DataTable, type Column } from '../../ui/DataTable';
import { useToast } from '../../ui/Feedback';
import { Checkbox, Field, Input } from '../../ui/Form';
import { FormModal } from '../../ui/FormModal';
import { Card } from '../../ui/Layout';
import { useConfirm } from '../../ui/Modal';

const ROLES = Object.keys(ROLE) as Role[];
const ROLE_HELP: Record<Role, string> = {
  OPERADOR: 'Registra clientes y solicitudes, cotiza y propone destinos.',
  TESORERO: 'Registra pagos, aprueba entregas y firma transferencias.',
  CUMPLIMIENTO: 'Decide el KYC y aprueba destinos de pago.',
  ADMIN: 'Usuarios, precios, límites, cuentas y ajustes.',
  AUDITOR: 'Solo lectura, incluido el registro de auditoría.',
};

export function Usuarios() {
  const { me } = useSession();
  const toast = useToast();
  const list = useQuery<UserRow[]>(() => users.list(), []);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<UserRow | null>(null);
  const { confirm, dialog } = useConfirm(() => list.reload());

  const toggle = (u: UserRow) =>
    confirm({
      title: `${u.active ? 'Desactivar' : 'Activar'} a ${u.full_name}`,
      intro: u.active ? 'La persona no podrá iniciar sesión y se cierran sus sesiones abiertas. Su historial se conserva.' : 'La persona podrá volver a iniciar sesión con su contraseña y su segundo factor.',
      summary: [['Usuario', u.username], ['Roles', u.roles.map((r) => ROLE[r]).join(', ')]],
      reason: { label: 'Motivo', minLength: 3 },
      stepUp: true,
      danger: u.active,
      confirmLabel: u.active ? 'Desactivar usuario' : 'Activar usuario',
      onConfirm: async ({ reason, mfaCode, idempotencyKey }) => {
        await (u.active ? users.disable : users.enable)(u.id, reason, { idempotencyKey, mfaCode });
        toast(`${u.full_name}: ${u.active ? 'desactivado' : 'activado'}`);
      },
    });
  const resetMfa = (u: UserRow) =>
    confirm({
      title: `Reiniciar el segundo factor de ${u.full_name}`,
      intro: 'Se borra su segundo factor y se cierran sus sesiones. En su próximo ingreso deberá registrar uno nuevo con su aplicación de autenticación. Úsalo solo si perdió el teléfono o la aplicación.',
      reason: { label: 'Motivo', minLength: 3 },
      stepUp: true,
      danger: true,
      acknowledge: 'Verifiqué la identidad de la persona por un canal distinto a este sistema.',
      confirmLabel: 'Reiniciar segundo factor',
      onConfirm: async ({ reason, mfaCode, idempotencyKey }) => {
        await users.resetMfa(u.id, reason, { idempotencyKey, mfaCode });
        toast('Segundo factor reiniciado');
      },
    });

  const columns: Column<UserRow>[] = [
    { key: 'n', header: 'Nombre', render: (u) => <><span className="cell-main">{u.full_name}{u.id === me.user.id && <span className="muted"> (tú)</span>}</span><span className="cell-sub mono">{u.username}</span></> },
    { key: 'r', header: 'Roles', render: (u) => <span className="badge-row">{u.roles.map((r) => <Badge key={r} tone={r === 'ADMIN' ? 'info' : 'neutral'}>{ROLE[r]}</Badge>)}</span> },
    {
      key: 's',
      header: 'Estado',
      render: (u) =>
        !u.active ? <Badge tone="neutral">Desactivado</Badge> : u.locked_until && new Date(u.locked_until) > new Date() ? <Badge tone="danger" title={`Hasta ${dateTime(u.locked_until)}`}>Bloqueado por intentos</Badge> : <Badge tone="success">Activo</Badge>,
    },
    { key: 'm', header: 'Segundo factor', render: (u) => (u.mfa_enrolled ? <Badge tone="success">Registrado</Badge> : <Badge tone="warning">Pendiente</Badge>) },
    { key: 'c', header: 'Alta', secondary: true, render: (u) => dateOnly(u.created_at) },
    {
      key: 'x',
      header: '',
      render: (u) =>
        u.id === me.user.id ? null : (
          <span className="action-row">
            <Button size="sm" onClick={() => setEditing(u)}>Roles</Button>
            <Button size="sm" onClick={() => toggle(u)}>{u.active ? 'Desactivar' : 'Activar'}</Button>
            {u.mfa_enrolled && <Button size="sm" onClick={() => resetMfa(u)}>Reiniciar 2FA</Button>}
          </span>
        ),
    },
  ];

  return (
    <Card flush title="Usuarios" actions={<Button variant="primary" onClick={() => setCreating(true)}>Nuevo usuario</Button>}>
      <div className="card-section">
        <p className="muted">Los cambios de rol cierran las sesiones de la persona para que rijan desde su próximo ingreso. Para evitar errores, aquí no se ofrecen cambios sobre tu propio usuario: pídeselos a otro administrador.</p>
      </div>
      <DataTable columns={columns} rows={list.data} rowKey={(u) => u.id} loading={list.loading} error={list.error} empty={{ title: 'Sin usuarios' }} />
      {creating && <NewUserDialog onClose={() => setCreating(false)} onDone={list.reload} />}
      {editing && <RolesDialog user={editing} onClose={() => setEditing(null)} onDone={list.reload} />}
      {dialog}
    </Card>
  );
}

function RolePicker({ value, onChange }: { value: Role[]; onChange: (r: Role[]) => void }) {
  return (
    <div className="role-picker">
      {ROLES.map((r) => (
        <div key={r}>
          <Checkbox label={<><strong>{ROLE[r]}</strong> <span className="muted small">{ROLE_HELP[r]}</span></>} checked={value.includes(r)} onChange={(v) => onChange(v ? [...value, r] : value.filter((x) => x !== r))} />
        </div>
      ))}
    </div>
  );
}

function NewUserDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [f, setF] = useState({ username: '', fullName: '', password: '', password2: '' });
  const [roles, setRoles] = useState<Role[]>([]);
  const set = (k: keyof typeof f, v: string) => setF((p) => ({ ...p, [k]: v }));
  const userOk = /^[a-z0-9._-]{3,40}$/.test(f.username);
  const passOk = f.password.length >= 12;
  const same = f.password === f.password2;
  return (
    <FormModal
      title="Nuevo usuario"
      submitLabel="Crear usuario"
      stepUp
      canSubmit={userOk && f.fullName.trim().length >= 3 && passOk && same && roles.length > 0}
      onClose={onClose}
      onSubmit={async (o) => {
        await users.create({ username: f.username, fullName: f.fullName.trim(), password: f.password, roles }, o);
        toast(`Usuario ${f.username} creado`);
        onDone();
      }}
    >
      <p className="confirm-intro">Entrega la contraseña inicial por un canal seguro. En su primer ingreso la persona registra su segundo factor.</p>
      <div className="form-row">
        <Field label="Usuario" required error={f.username && !userOk ? 'Minúsculas, números, punto o guion (3 a 40)' : null}>
          {(id) => <Input id={id} value={f.username} onChange={(e) => set('username', e.target.value.toLowerCase())} autoComplete="off" />}
        </Field>
        <Field label="Nombre completo" required>
          {(id) => <Input id={id} value={f.fullName} onChange={(e) => set('fullName', e.target.value)} />}
        </Field>
        <Field label="Contraseña inicial" required error={f.password && !passOk ? 'Al menos 12 caracteres' : null}>
          {(id) => <Input id={id} type="password" value={f.password} onChange={(e) => set('password', e.target.value)} autoComplete="new-password" />}
        </Field>
        <Field label="Repite la contraseña" required error={f.password2 && !same ? 'No coincide' : null}>
          {(id) => <Input id={id} type="password" value={f.password2} onChange={(e) => set('password2', e.target.value)} autoComplete="new-password" />}
        </Field>
      </div>
      <fieldset className="fieldset">
        <legend>Roles *</legend>
        <RolePicker value={roles} onChange={setRoles} />
      </fieldset>
    </FormModal>
  );
}

function RolesDialog({ user, onClose, onDone }: { user: UserRow; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [roles, setRoles] = useState<Role[]>(user.roles);
  const changed = roles.length !== user.roles.length || roles.some((r) => !user.roles.includes(r));
  return (
    <FormModal
      title={`Roles de ${user.full_name}`}
      submitLabel="Guardar roles"
      stepUp
      canSubmit={changed && roles.length > 0}
      onClose={onClose}
      onSubmit={async (o) => {
        await users.setRoles(user.id, roles, o);
        toast('Roles actualizados; la persona debe iniciar sesión de nuevo');
        onDone();
      }}
    >
      <p className="confirm-intro">Al guardar se cierran las sesiones de la persona. Siempre debe quedar al menos un administrador activo.</p>
      <RolePicker value={roles} onChange={setRoles} />
    </FormModal>
  );
}
