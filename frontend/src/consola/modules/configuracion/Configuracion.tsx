import { limits } from '../../api/endpoints';
import type { LimitChange } from '../../api/types';
import { navigate } from '../../app/router';
import { useCan } from '../../app/session';
import { useQuery } from '../../lib/hooks';
import { PageHeader, Tabs } from '../../ui/Layout';
import type { PageProps } from '../index';
import { Limites } from './Limites';
import { Parametros } from './Parametros';
import { Precios } from './Precios';
import { Usuarios } from './Usuarios';

type View = 'usuarios' | 'parametros' | 'precios' | 'limites';

export default function Configuracion({ route }: PageProps) {
  const can = useCan();
  const canUsers = can('users.manage');
  const asked = route.query.get('vista') as View | null;
  const view: View = asked && ['parametros', 'precios', 'limites'].includes(asked) ? asked : canUsers && (!asked || asked === 'usuarios') ? 'usuarios' : 'parametros';
  const proposed = useQuery<LimitChange[]>(() => limits.changes('PROPUESTO'), [view]);
  const tabs: { key: View; label: string; count?: number }[] = [
    ...(canUsers ? [{ key: 'usuarios' as const, label: 'Usuarios' }] : []),
    { key: 'parametros', label: 'Parámetros de la mesa' },
    { key: 'precios', label: 'TRM y precios' },
    { key: 'limites', label: 'Límites y aprobaciones', count: proposed.data?.length ?? 0 },
  ];
  return (
    <>
      <PageHeader
        title="Usuarios y configuración"
        subtitle="Quién entra y con qué rol, los tiempos de la mesa, las reglas de precio y los límites. Cada cambio pide el segundo factor, guarda el motivo y conserva la versión anterior."
      />
      <Tabs tabs={tabs} active={view} onChange={(k) => navigate('configuracion', { vista: k })} />
      {view === 'usuarios' && <Usuarios />}
      {view === 'parametros' && <Parametros />}
      {view === 'precios' && <Precios />}
      {view === 'limites' && <Limites onChange={proposed.reload} />}
    </>
  );
}
