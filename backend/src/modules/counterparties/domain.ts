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

// ---------- Billeteras de origen ----------

export type Network = 'TRON' | 'BSC';
export type OriginStatus = 'PENDIENTE' | 'APROBADA' | 'RECHAZADA' | 'REVOCADA';

/** Redes en las que la plataforma acepta depósitos de USDT. Cualquier otra se rechaza. */
export const SUPPORTED_NETWORKS: readonly Network[] = ['TRON', 'BSC'];

/**
 * Clave para comparar direcciones de una misma red: en BSC (EVM) las mayúsculas no cambian la
 * dirección; en Tron (Base58) sí. Una dirección solo se compara con otras de su misma red.
 */
export const addressKey = (network: Network, address: string) => (network === 'BSC' ? address.trim().toLowerCase() : address.trim());

/** Solo una dirección aprobada supera el control de origen. */
export const originAllowsDeposits = (status: OriginStatus) => status === 'APROBADA';

/** Una dirección se cuenta en el límite de redes mientras está pendiente o aprobada. */
export const originIsLive = (status: OriginStatus) => status === 'PENDIENTE' || status === 'APROBADA';

/**
 * ¿Cabe una dirección nueva en esta red? Si el cliente ya tiene la red habilitada, siempre cabe
 * (no hay límite de direcciones por red); si no, solo mientras no llegue al máximo de redes.
 */
export function networkFits(liveNetworks: readonly Network[], network: Network, maxNetworks: number): boolean {
  const distinct = new Set(liveNetworks);
  return distinct.has(network) || distinct.size < maxNetworks;
}
