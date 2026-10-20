// Contratos con el exterior. El dominio solo conoce estas interfaces.
// Hoy solo existen implementaciones simuladas (modo DEMO).

export type Network = 'TRON' | 'BSC';

export interface VerificationResult {
  status: 'CONFIRMED' | 'PENDING' | 'MISMATCH';
  simulated: boolean;
  detail: string;
}

export interface ChainAdapter {
  readonly simulated: boolean;
  isValidAddress(network: Network, address: string): boolean;
  /** Verifica que una transacción existe con el destino y monto esperados. */
  verifyTransfer(input: { network: Network; txHash: string; amountUsdt: string }): Promise<VerificationResult>;
}

export interface BankAdapter {
  readonly simulated: boolean;
  /** Verifica un movimiento en pesos por su referencia bancaria. */
  verifyTransfer(input: { reference: string; amountCop: string }): Promise<VerificationResult>;
}

export interface Adapters {
  chain: ChainAdapter;
  bank: BankAdapter;
}
