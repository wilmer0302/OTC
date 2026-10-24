import type { Db } from '../db/pool.js';
import type {
  BankMovementObservation,
  BankReader,
  BankStatementLine,
  ChainReader,
  ChainStatementLine,
  ChainTxObservation,
  Integrations,
  Network,
} from './ports.js';

// Integraciones SANDBOX. No consultan ninguna red ni banco reales.
// Responden con lo que esté escrito en las tablas otc.sandbox_*, que solo llenan las pruebas
// automáticas o un usuario de la demo con el permiso «sandbox.simulate». Toda respuesta queda
// marcada como sandbox. Producción se niega a arrancar con estas implementaciones.

const TRON_ADDRESS = /^T[1-9A-HJ-NP-Za-km-z]{33}$/;
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/**
 * Contratos USDT de la red SIMULADA. Son ficticios a propósito: no son los contratos reales de
 * Tether, que se configurarán y verificarán contra fuentes oficiales cuando exista la integración real.
 */
export const SANDBOX_USDT_CONTRACT: Record<Network, string> = {
  TRON: 'TDemoUSDTContratoFicticio111111111',
  BSC: '0x0000000000000000000000000000000000005d01',
};

export class SandboxChain implements ChainReader {
  readonly sandbox = true;
  constructor(private readonly db: Db) {}

  isValidAddress(network: Network, address: string): boolean {
    return network === 'TRON' ? TRON_ADDRESS.test(address) : EVM_ADDRESS.test(address);
  }

  // Propiedad y no método: sigue disponible cuando una prueba copia el objeto con { ...chain }.
  readonly usdtContract = (network: Network): string => SANDBOX_USDT_CONTRACT[network];

  async getTransaction(network: Network, txHash: string): Promise<ChainTxObservation> {
    const r = await this.db.query(
      `SELECT status, confirmations, from_address, to_address, amount_base_units, block_number, fail_reason, token_contract
       FROM otc.sandbox_chain_txs WHERE network = $1 AND lower(tx_hash) = lower($2)`,
      [network, txHash],
    );
    const row = r.rows[0];
    if (!row) return { found: false, detail: 'SANDBOX: la red simulada no conoce ese hash' };
    return {
      found: true,
      status: row.status,
      confirmations: row.confirmations,
      to: row.to_address,
      from: row.from_address,
      tokenContract: row.token_contract ?? undefined,
      amountBaseUnits: row.amount_base_units,
      blockNumber: row.block_number,
      detail: row.fail_reason ? `SANDBOX: ${row.fail_reason}` : 'SANDBOX: respuesta simulada',
    };
  }

  async listTransfers(network: Network, address: string, businessDate: string): Promise<ChainStatementLine[]> {
    const r = await this.db.query(
      `SELECT tx_hash, to_address, from_address, amount_base_units, occurred_at
       FROM otc.sandbox_chain_txs
       WHERE network = $1 AND status = 'SUCCESS' AND (lower(to_address) = lower($2) OR lower(from_address) = lower($2))
         AND (occurred_at AT TIME ZONE 'America/Bogota')::date = $3::date
       ORDER BY occurred_at`,
      [network, address, businessDate],
    );
    return r.rows.map((row) => {
      const incoming = row.to_address.toLowerCase() === address.toLowerCase();
      return {
        txHash: row.tx_hash,
        direction: incoming ? 'IN' : 'OUT',
        amountBaseUnits: row.amount_base_units,
        counterpartyAddress: incoming ? row.from_address : row.to_address,
        occurredAt: new Date(row.occurred_at).toISOString(),
      };
    });
  }
}

export class SandboxBank implements BankReader {
  readonly sandbox = true;
  constructor(private readonly db: Db) {}

  async getMovement(accountRef: string, reference: string): Promise<BankMovementObservation> {
    const r = await this.db.query(
      `SELECT status, direction, amount_cop FROM otc.sandbox_bank_movements WHERE account_ref = $1 AND reference = $2`,
      [accountRef, reference],
    );
    const row = r.rows[0];
    if (!row) return { found: false, detail: 'SANDBOX: el banco simulado no tiene ese movimiento' };
    return { found: true, status: row.status, direction: row.direction, amountCop: row.amount_cop, detail: 'SANDBOX: respuesta simulada' };
  }

  async listMovements(accountRef: string, businessDate: string): Promise<BankStatementLine[]> {
    const r = await this.db.query(
      `SELECT reference, direction, amount_cop, occurred_at, description FROM otc.sandbox_bank_movements
       WHERE account_ref = $1 AND status = 'SETTLED' AND (occurred_at AT TIME ZONE 'America/Bogota')::date = $2::date
       ORDER BY occurred_at`,
      [accountRef, businessDate],
    );
    return r.rows.map((row) => ({
      reference: row.reference,
      direction: row.direction,
      amountCop: row.amount_cop,
      occurredAt: new Date(row.occurred_at).toISOString(),
      description: row.description,
    }));
  }
}

export const sandboxIntegrations = (db: Db): Integrations => ({ chain: new SandboxChain(db), bank: new SandboxBank(db) });
