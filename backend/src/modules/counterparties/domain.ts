// Reglas puras de clientes y contrapartes. Sin base de datos ni HTTP.

export type KycStatus = 'PENDIENTE' | 'APROBADO' | 'RECHAZADO' | 'BLOQUEADO';
export type Rail = 'BANK' | 'TRON' | 'BSC';

const KYC_TRANSITIONS: Record<KycStatus, KycStatus[]> = {
  PENDIENTE: ['APROBADO', 'RECHAZADO', 'BLOQUEADO'],
  APROBADO: ['BLOQUEADO', 'PENDIENTE'], // PENDIENTE = se pide revisar de nuevo (por ejemplo, documentos vencidos)
  RECHAZADO: ['PENDIENTE'],
  BLOQUEADO: ['PENDIENTE', 'APROBADO'],
};

export const kycCanMove = (from: KycStatus, to: KycStatus) => KYC_TRANSITIONS[from].includes(to);

/** Solo se cotiza y se opera con clientes de KYC aprobado. */
export const kycAllowsTrading = (status: KycStatus) => status === 'APROBADO';

/** Número de cuenta bancaria colombiana: solo dígitos, 6 a 20. */
export const isValidBankAccount = (value: string) => /^\d{6,20}$/.test(value);

/** Muestra solo los últimos 4 caracteres a quien no necesita el dato completo. */
export function mask(value: string): string {
  if (value.length <= 4) return '••••';
  return `••••${value.slice(-4)}`;
}

/** Red en la que se entrega USDT, o banco para pesos. */
export const railFor = (asset: 'COP' | 'USDT', network: 'TRON' | 'BSC'): Rail => (asset === 'COP' ? 'BANK' : network);
