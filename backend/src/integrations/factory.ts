import type { Db } from '../db/pool.js';
import type { Integrations } from './ports.js';
import { ChainRouter } from './router.js';
import { SANDBOX_USDT_CONTRACT, SandboxBank, SandboxChain } from './sandbox.js';
import { isValidTronAddress } from './tron/address.js';
import { TronGridReader, type TronReaderConfig } from './tron/reader.js';

// Elige las integraciones según el entorno. Por omisión todo es sandbox (la demo de siempre).
// TRON_READER=trongrid conecta el lector REAL de TRON (solo lectura); BSC y el banco siguen simulados.

type Env = Record<string, string | undefined>;

export function tronConfigFromEnv(env: Env): TronReaderConfig | null {
  const kind = (env.TRON_READER ?? 'sandbox').toLowerCase();
  if (kind === 'sandbox') return null;
  if (kind !== 'trongrid') throw new Error(`TRON_READER inválido: ${env.TRON_READER}. Usa sandbox o trongrid.`);

  const rpcUrl = env.TRON_RPC_URL?.trim();
  if (!rpcUrl) throw new Error('Falta TRON_RPC_URL (URL del nodo o de TronGrid)');
  let url: URL;
  try {
    url = new URL(rpcUrl);
  } catch {
    throw new Error('TRON_RPC_URL no es una URL válida');
  }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) throw new Error('TRON_RPC_URL debe usar https (http solo para un nodo local)');
  if (url.username || url.password) throw new Error('TRON_RPC_URL no debe llevar credenciales; la llave va en TRON_API_KEY');

  // Sin valor por omisión: el contrato se configura a propósito, verificado contra la fuente oficial de Tether.
  const usdtContract = env.TRON_USDT_CONTRACT?.trim();
  if (!usdtContract) throw new Error('Falta TRON_USDT_CONTRACT (contrato USDT TRC-20 verificado en la fuente oficial de Tether)');
  if (usdtContract === SANDBOX_USDT_CONTRACT.TRON) throw new Error('TRON_USDT_CONTRACT es el contrato ficticio del simulador; no se usa con el lector real');
  if (!isValidTronAddress(usdtContract)) throw new Error('TRON_USDT_CONTRACT no es una dirección TRON válida (Base58Check)');

  const timeoutMs = Number(env.TRON_RPC_TIMEOUT_MS ?? 8000);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 60000) throw new Error('TRON_RPC_TIMEOUT_MS debe ser un entero entre 1000 y 60000');

  return { rpcUrl, apiKey: env.TRON_API_KEY?.trim() || undefined, usdtContract, timeoutMs };
}

export function buildIntegrations(db: Db, env: Env = process.env, deps: { fetch?: typeof fetch } = {}): Integrations {
  const sandboxChain = new SandboxChain(db);
  const tron = tronConfigFromEnv(env);
  return {
    chain: tron ? new ChainRouter({ TRON: new TronGridReader({ ...tron, fetch: deps.fetch }), BSC: sandboxChain }) : sandboxChain,
    bank: new SandboxBank(db),
  };
}

/** Línea para el registro de arranque: qué red es real y cuál simulada, sin datos sensibles. */
export function describeIntegrations(env: Env = process.env): string {
  const tron = tronConfigFromEnv(env);
  return tron ? `TRON: lector real (${new URL(tron.rpcUrl).host}, contrato ${tron.usdtContract}); BSC y banco: sandbox` : 'TRON, BSC y banco: sandbox';
}
