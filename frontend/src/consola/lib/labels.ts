// Etiquetas en español y tono visual de cada estado. El tono acompaña al texto, nunca lo reemplaza.

export type Tone = 'neutral' | 'info' | 'progress' | 'success' | 'warning' | 'danger';
interface StatusInfo {
  label: string;
  tone: Tone;
}

const s = (label: string, tone: Tone): StatusInfo => ({ label, tone });

export const REQUEST_STATUS: Record<string, StatusInfo> = {
  CREADA: s('Creada', 'neutral'),
  VALIDADA: s('Validada', 'info'),
  COTIZADA: s('Cotizada', 'progress'),
  ACEPTADA: s('Aceptada', 'success'),
  RECHAZADA: s('Rechazada', 'danger'),
  CANCELADA: s('Cancelada', 'neutral'),
  VENCIDA: s('Vencida', 'neutral'),
};

export const QUOTE_STATUS: Record<string, StatusInfo> = {
  VIGENTE: s('Vigente', 'progress'),
  ACEPTADA: s('Aceptada', 'success'),
  VENCIDA: s('Vencida', 'neutral'),
  REEMPLAZADA: s('Reemplazada', 'neutral'),
  RETIRADA: s('Retirada', 'warning'),
};

export const ORDER_STATUS: Record<string, StatusInfo> = {
  CREADA: s('Esperando pago', 'warning'),
  COBRO_EN_VERIFICACION: s('Cobro en verificación', 'progress'),
  COBRO_CONFIRMADO: s('Cobro confirmado · por aprobar', 'info'),
  ENTREGA_AUTORIZADA: s('Entrega autorizada', 'progress'),
  ENTREGA_ENVIADA: s('Entrega enviada', 'progress'),
  COMPLETADA: s('Completada', 'success'),
  VENCIDA: s('Vencida', 'neutral'),
  CANCELADA: s('Cancelada', 'neutral'),
  EN_REVISION: s('En revisión', 'danger'),
};

export const TRANSFER_STATUS: Record<string, StatusInfo> = {
  CREADA: s('Creada', 'neutral'),
  AUTORIZADA: s('Autorizada · por firmar', 'info'),
  EN_FIRMA: s('En firma', 'progress'),
  ENVIADA: s('Enviada', 'progress'),
  PENDIENTE: s('Pendiente de confirmación', 'progress'),
  CONFIRMADA: s('Confirmada', 'success'),
  FALLIDA: s('Fallida', 'danger'),
  CANCELADA: s('Cancelada', 'neutral'),
  EN_REVISION: s('En revisión', 'danger'),
};

export const KYC_STATUS: Record<string, StatusInfo> = {
  PENDIENTE: s('KYC pendiente', 'warning'),
  APROBADO: s('KYC aprobado', 'success'),
  RECHAZADO: s('KYC rechazado', 'danger'),
  BLOQUEADO: s('Bloqueado', 'danger'),
};

export const DESTINATION_STATUS: Record<string, StatusInfo> = {
  PROPUESTO: s('Por aprobar', 'warning'),
  APROBADO: s('Aprobado', 'success'),
  RECHAZADO: s('Rechazado', 'danger'),
  REVOCADO: s('Revocado', 'neutral'),
};

export const RECON_RUN_STATUS: Record<string, StatusInfo> = {
  ABIERTO: s('Abierta', 'progress'),
  CUADRADO: s('Cuadrada', 'success'),
  CON_DIFERENCIAS: s('Con diferencias', 'danger'),
  CERRADO: s('Cerrada', 'neutral'),
};

export const RECON_ITEM_STATUS: Record<string, StatusInfo> = {
  PENDIENTE: s('Pendiente', 'progress'),
  CONCILIADA: s('Conciliada', 'success'),
  CON_DIFERENCIA: s('Con diferencia', 'danger'),
  SIN_CONTRAPARTIDA: s('Sin contrapartida', 'danger'),
  EN_REVISION: s('En revisión', 'warning'),
  AJUSTADA: s('Ajustada', 'info'),
};

export const PROPOSAL_STATUS: Record<string, StatusInfo> = {
  PROPUESTO: s('Por aprobar', 'warning'),
  VIGENTE: s('Vigente', 'success'),
  APROBADO: s('Aprobado', 'success'),
  RECHAZADO: s('Rechazado', 'danger'),
};

export const RESERVATION_STATUS: Record<string, StatusInfo> = {
  ACTIVE: s('Reservada', 'progress'),
  LOCKED: s('Bloqueada para envío', 'info'),
  CONSUMED: s('Consumida', 'success'),
  RELEASED: s('Liberada', 'neutral'),
};

export const SIDE: Record<string, string> = { BUY: 'Mesa compra USDT', SELL: 'Mesa vende USDT' };
export const SIDE_SHORT: Record<string, string> = { BUY: 'Compra', SELL: 'Venta' };
export const NETWORK: Record<string, string> = { TRON: 'Tron (TRC20)', BSC: 'BSC (BEP20)', BANK: 'Banco (COP)' };
export const PURPOSE: Record<string, string> = { COBRO: 'Cobro', ENTREGA: 'Entrega', DEVOLUCION: 'Devolución', TRASLADO: 'Traslado interno' };
export const LIQUIDITY_TYPE: Record<string, string> = { BANK: 'Banco', WALLET: 'Billetera', EXCHANGE: 'Exchange' };
export const ROLE: Record<string, string> = {
  OPERADOR: 'Operador (trader)',
  TESORERO: 'Tesorero',
  CUMPLIMIENTO: 'Cumplimiento',
  ADMIN: 'Administrador',
  AUDITOR: 'Auditor',
};
export const POLICY: Record<string, string> = {
  SINGLE: 'Una aprobación',
  THRESHOLD: 'Segunda aprobación sobre un umbral',
  ALL: 'Dos aprobaciones siempre',
};
export const LIMIT_KIND: Record<string, string> = {
  ORDER_MAX_USDT: 'Máximo por orden (USDT)',
  CLIENT_DAILY_USDT: 'Máximo diario por cliente (USDT)',
  DESK_DAILY_USDT: 'Máximo diario de la mesa (USDT)',
  OPEN_EXPOSURE_USDT: 'Exposición abierta máxima (USDT)',
  OPEN_EXPOSURE_COP: 'Exposición abierta máxima (COP)',
  APPROVAL_POLICY: 'Política de aprobación de entregas',
};

export const ENTITY: Record<string, string> = {
  request: 'Solicitud',
  quote: 'Cotización',
  order: 'Orden',
  transfer: 'Transferencia',
  counterparty: 'Contraparte',
  destination: 'Destino',
  user: 'Usuario',
  session: 'Sesión',
  trm: 'TRM',
  pricing_rule: 'Regla de precio',
  limit_change: 'Límite',
  account: 'Cuenta',
  recon_run: 'Conciliación',
  recon_item: 'Partida',
  adjustment: 'Ajuste',
  case: 'Caso de revisión',
  journal_entry: 'Asiento contable',
  reservation: 'Reserva de liquidez',
  settlement: 'Pago o entrega',
  audit_anchor: 'Ancla de auditoría',
  system: 'Sistema',
  settings: 'Parámetros',
};
