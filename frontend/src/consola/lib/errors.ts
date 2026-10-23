import { ApiError } from '../api/client';

// Traduce un error de la API a un mensaje que una persona de operaciones entienda y sepa qué hacer.

const TITLES: Record<string, string> = {
  NETWORK: 'Sin conexión con el servidor',
  UNAUTHENTICATED: 'Tu sesión terminó',
  MFA_REQUIRED: 'Falta el segundo factor',
  CSRF: 'La página quedó desactualizada',
  FORBIDDEN: 'Tu rol no permite esta acción',
  NOT_FOUND: 'No se encontró',
  INVALID: 'Revisa los datos',
  RATE_LIMITED: 'Demasiados intentos',
  STEP_UP_REQUIRED: 'Falta el código del segundo factor',
  STEP_UP_FAILED: 'Código del segundo factor no válido',
  BAD_MFA_CODE: 'Código no válido',
  BAD_CREDENTIALS: 'No pudimos iniciar sesión',
  IDEMPOTENCY_CONFLICT: 'Operación repetida con otros datos',
  NO_TRM: 'No hay TRM del día',
  INTERNAL: 'Error del servidor',
};

const HINTS: Record<string, string> = {
  CSRF: 'Recarga la página e intenta de nuevo.',
  STEP_UP_FAILED: 'Espera a que tu aplicación muestre un código nuevo: cada código sirve una sola vez.',
  STEP_UP_REQUIRED: 'Escribe el código de 6 dígitos de tu aplicación de autenticación.',
  NO_TRM: 'Quien tenga el rol de tesorería o administración debe cargar la TRM de hoy en Configuración.',
  NETWORK: 'No se hizo ningún cambio que no se pueda repetir: puedes volver a intentarlo.',
  INTERNAL: 'Quedó registrado. Si se repite, comparte el código de referencia con soporte.',
};

// Nombres de campos que el servidor usa en sus validaciones, en el idioma de la pantalla.
const FIELDS: Record<string, string> = {
  usdtAmount: 'Monto USDT',
  amount: 'Monto',
  reference: 'Referencia',
  reason: 'Motivo',
  note: 'Nota',
  rate: 'TRM',
  documentNumber: 'Número de documento',
  legalName: 'Razón social o nombre',
  email: 'Correo',
  value: 'Cuenta o dirección',
  label: 'Etiqueta',
  username: 'Usuario',
  password: 'Contraseña',
  fullName: 'Nombre completo',
  code: 'Código',
  counterpartyId: 'Cliente',
  buyMarginCop: 'Margen de compra',
  sellMarginCop: 'Margen de venta',
  commissionRate: 'Comisión',
};

export interface FriendlyError {
  title: string;
  message: string;
  hint?: string;
  reference?: string;
}

export function friendly(err: unknown): FriendlyError {
  if (err instanceof ApiError) {
    let message = err.message;
    if (err.code === 'INVALID') message = message.replace(/(^|; )([a-zA-Z]+)(\.[\w.]+)?: /g, (_m, sep, f) => `${sep}${FIELDS[f] ?? f}: `);
    return {
      title: TITLES[err.code] ?? (err.status === 409 ? 'No se pudo completar' : 'Error'),
      message,
      hint: HINTS[err.code],
      reference: err.status >= 500 ? err.requestId : undefined,
    };
  }
  return { title: 'Error inesperado', message: (err as Error)?.message ?? String(err) };
}
