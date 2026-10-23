import type { Dashboard } from '../api/types';

export interface NavItem {
  key: string;
  label: string;
  /** Permiso mínimo para ver el módulo (la API vuelve a verificarlo). */
  permission: string;
  /** Pendientes que se muestran como contador junto al nombre. */
  badge?: (d: Dashboard) => number;
}

export const NAV: NavItem[] = [
  { key: 'inicio', label: 'Inicio', permission: 'read.operations' },
  { key: 'solicitudes', label: 'Solicitudes OTC', permission: 'read.operations' },
  { key: 'cotizaciones', label: 'Cotizaciones', permission: 'read.operations' },
  {
    key: 'ordenes',
    label: 'Órdenes y ejecución',
    permission: 'read.operations',
    badge: (d) => d.attention.ordersAwaitingApproval + d.attention.ordersInReview,
  },
  { key: 'liquidez', label: 'Liquidez', permission: 'read.operations' },
  {
    key: 'transferencias',
    label: 'Transferencias',
    permission: 'read.operations',
    badge: (d) => d.attention.deliveriesToSign + d.attention.transfersInReview + d.attention.transfersFailed,
  },
  {
    key: 'conciliaciones',
    label: 'Conciliaciones',
    permission: 'read.operations',
    badge: (d) => d.attention.reconWithDifferences + d.attention.adjustmentsProposed,
  },
  { key: 'auditoria', label: 'Historial y auditoría', permission: 'read.operations' },
  {
    key: 'clientes',
    label: 'Clientes',
    permission: 'read.operations',
    badge: (d) => d.attention.destinationsProposed + d.attention.kycPending,
  },
  {
    key: 'configuracion',
    label: 'Usuarios y configuración',
    permission: 'read.operations',
    badge: (d) => d.attention.limitChangesProposed,
  },
];
