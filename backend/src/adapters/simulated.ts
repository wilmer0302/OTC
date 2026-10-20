import type { Adapters, BankAdapter, ChainAdapter, Network } from './types.js';

// Adaptadores SIMULADOS para la demo. No consultan ninguna red ni banco:
// aceptan cualquier referencia con formato válido y la marcan como simulada.

const TRON_ADDRESS = /^T[1-9A-HJ-NP-Za-km-z]{33}$/;
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const TX_HASH = /^(0x)?[0-9a-fA-F]{64}$/;

export class SimulatedChain implements ChainAdapter {
  readonly simulated = true;

  isValidAddress(network: Network, address: string): boolean {
    return network === 'TRON' ? TRON_ADDRESS.test(address) : EVM_ADDRESS.test(address);
  }

  async verifyTransfer({ txHash }: { network: Network; txHash: string; amountUsdt: string }) {
    if (!TX_HASH.test(txHash)) {
      return { status: 'MISMATCH' as const, simulated: true, detail: 'Hash con formato inválido' };
    }
    return { status: 'CONFIRMED' as const, simulated: true, detail: 'Confirmación SIMULADA (demo)' };
  }
}

export class SimulatedBank implements BankAdapter {
  readonly simulated = true;

  async verifyTransfer({ reference }: { reference: string; amountCop: string }) {
    if (reference.trim().length < 4) {
      return { status: 'MISMATCH' as const, simulated: true, detail: 'Referencia demasiado corta' };
    }
    return { status: 'CONFIRMED' as const, simulated: true, detail: 'Confirmación SIMULADA (demo)' };
  }
}

export const simulatedAdapters = (): Adapters => ({ chain: new SimulatedChain(), bank: new SimulatedBank() });
