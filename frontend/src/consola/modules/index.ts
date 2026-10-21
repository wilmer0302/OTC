import type { ComponentType } from 'react';
import type { Route } from '../app/router';
import { Pending } from './Pending';

export interface PageProps {
  route: Route;
}

// Un componente por módulo del menú. Cada módulo vive en su carpeta y solo usa la API y la UI comunes.
export const MODULES: Record<string, ComponentType<PageProps>> = {
  inicio: Pending,
  solicitudes: Pending,
  cotizaciones: Pending,
  ordenes: Pending,
  liquidez: Pending,
  transferencias: Pending,
  conciliaciones: Pending,
  auditoria: Pending,
  clientes: Pending,
  configuracion: Pending,
};
