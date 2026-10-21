import type { ComponentType } from 'react';
import type { Route } from '../app/router';
import Inicio from './inicio/Inicio';
import Cotizaciones from './cotizaciones/Cotizaciones';
import Ordenes from './ordenes/Ordenes';
import Liquidez from './liquidez/Liquidez';
import Conciliaciones from './conciliaciones/Conciliaciones';
import Auditoria from './auditoria/Auditoria';
import Clientes from './clientes/Clientes';
import { Pending } from './Pending';
import Transferencias from './transferencias/Transferencias';
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
  liquidez: Liquidez,
  transferencias: Transferencias,
  conciliaciones: Conciliaciones,
  auditoria: Auditoria,
  clientes: Clientes,
  configuracion: Pending,
};
