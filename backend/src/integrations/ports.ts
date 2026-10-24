// Contratos con el exterior (backend v1). La lógica OTC solo conoce estas interfaces:
// nunca importa un proveedor concreto. Cada interfaz tiene una implementación sandbox
// (desarrollo, pruebas, demo) y, más adelante, una real que solo carga producción.

export type Network = 'TRON' | 'BSC';

/** Lo que la red dice de una transacción. Sin interpretación: la decide el módulo de confirmaciones. */
export interface ChainTxObservation {
  found: boolean;
  status?: 'PENDING' | 'SUCCESS' | 'FAILED';
  confirmations?: number;
  /** Dirección que recibió los USDT. */
  to?: string;
  /** Dirección que envió los USDT, tal como la reporta la red (nunca la que informa el cliente). */
  from?: string;
  /** Contrato del token transferido. Se compara con el contrato autorizado, no con el símbolo. */
  tokenContract?: string;
  /** Monto en unidades base del token (6 decimales en Tron, 18 en BSC). */
  amountBaseUnits?: string;
  blockNumber?: string;
  detail?: string;
}

export interface ChainStatementLine {
  txHash: string;
  direction: 'IN' | 'OUT';
  amountBaseUnits: string;
  counterpartyAddress: string;
  occurredAt: string;
}

/** Solo lectura de la red: la plataforma nunca firma ni ve claves. */
export interface ChainReader {
  readonly sandbox: boolean;
  isValidAddress(network: Network, address: string): boolean;
  /** Contrato USDT autorizado en esa red para este entorno. */
  usdtContract(network: Network): string;
  getTransaction(network: Network, txHash: string): Promise<ChainTxObservation>;
  listTransfers(network: Network, address: string, businessDate: string): Promise<ChainStatementLine[]>;
}

export interface BankMovementObservation {
  found: boolean;
  status?: 'PENDING' | 'SETTLED' | 'REJECTED';
  direction?: 'IN' | 'OUT';
  amountCop?: string;
  detail?: string;
}

export interface BankStatementLine {
  reference: string;
  direction: 'IN' | 'OUT';
  amountCop: string;
  occurredAt: string;
  description: string;
}

/** Lectura del banco (movimientos y extracto). Los pagos se ordenan fuera de la plataforma en esta fase. */
export interface BankReader {
  readonly sandbox: boolean;
  getMovement(accountRef: string, reference: string): Promise<BankMovementObservation>;
  listMovements(accountRef: string, businessDate: string): Promise<BankStatementLine[]>;
}

export interface Integrations {
  chain: ChainReader;
  bank: BankReader;
}

export const isSandbox = (i: Integrations) => i.chain.sandbox || i.bank.sandbox;
