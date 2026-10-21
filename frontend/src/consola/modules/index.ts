import type { ComponentType } from 'react';
import type { Route } from '../app/router';
import Inicio from './inicio/Inicio';
import Cotizaciones from './cotizaciones/Cotizaciones';
import Ordenes from './ordenes/Ordenes';
import { Pending } from './Pending';
import Solicitudes from './solicitudes/Solicitudes';

export interface PageProps {
  route: Route;
}

// Un componente por módulo del menú. Cada módulo vive en su carpeta y solo usa la API y la UI comunes.
export const MODULES: Record<string, ComponentType<PageProps>> = {
  inicio: Inicio,
  solicitudes: Solicitudes,
  cotizaciones: Cotizaciones,
  ordenes: Ordenes,
  liquidez: Pending,
  transferencias: Pending,
  conciliaciones: Pending,
  auditoria: Pending,
  clientes: Pending,
  configuracion: Pending,
};
