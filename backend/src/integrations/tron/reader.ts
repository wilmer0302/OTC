import type { ChainReader, ChainStatementLine, ChainTxObservation, Network } from '../ports.js';
import { isValidTronAddress, tronHexToBase58 } from './address.js';

// Lector REAL de la red TRON por la API HTTP de un nodo (TronGrid u otro proveedor compatible).
// Solo lectura: no firma, no envía y no conoce llaves. No interpreta reglas de negocio: informa lo
// que vio y el módulo de confirmaciones decide. Ante cualquier duda informa una anomalía, que manda
// la transferencia a revisión; ante una falla de la API lanza un error, y el sistema reintenta.
//
// Fuentes: developers.tron.network (referencias de wallet/ y walletsolidity/, "Confirmation
// semantics", guía de integración de exchanges) y tether.to/en/supported-protocols (contrato USDT).

/** topics[0] del evento Transfer(address,address,uint256) de TRC-20, según la guía de integración de TRON. */
export const TRC20_TRANSFER_TOPIC = 'ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

export interface TronReaderConfig {
  /** URL base del proveedor, p. ej. la de TronGrid para la red principal o para Nile (pruebas). */
  rpcUrl: string;
  /** Opcional. Va solo en la cabecera TRON-PRO-API-KEY; nunca se registra. */
  apiKey?: string;
  /** Contrato USDT autorizado (Base58Check), verificado contra la fuente oficial de Tether. */
  usdtContract: string;
  timeoutMs: number;
  /** Inyectable para las pruebas; por omisión, el fetch de Node. */
  fetch?: typeof fetch;
}

interface TronLog {
  address?: string;
  topics?: string[];
  data?: string;
}

interface TronTxInfo {
  id?: string;
  blockNumber?: number;
  blockTimeStamp?: number;
  receipt?: { result?: string };
  result?: string;
  log?: TronLog[];
}

interface Trc20Transfer {
  contract: string;
  from: string;
  to: string;
  amount: string;
}

const isEmpty = (o: unknown) => !o || (typeof o === 'object' && Object.keys(o as object).length === 0);

/** Tema de 32 bytes con una dirección: 12 bytes en cero y 20 de dirección. */
function topicAddress(topic: string | undefined): string | null {
  const t = String(topic ?? '').toLowerCase().replace(/^0x/, '');
  if (!/^0{24}[0-9a-f]{40}$/.test(t)) return null;
  return tronHexToBase58(t.slice(24));
}

function uint256(data: string | undefined): string | null {
  const d = String(data ?? '').toLowerCase().replace(/^0x/, '');
  if (!/^[0-9a-f]{64}$/.test(d)) return null;
  return BigInt('0x' + d).toString();
}

export class TronGridReader implements ChainReader {
  readonly sandbox = false;
  private readonly fetchFn: typeof fetch;
  private readonly base: string;

  constructor(private readonly config: TronReaderConfig) {
    this.fetchFn = config.fetch ?? fetch;
    this.base = config.rpcUrl.replace(/\/+$/, '');
  }

  readonly isValidAddress = (network: Network, address: string): boolean => {
    this.onlyTron(network);
    return isValidTronAddress(address);
  };

  readonly usdtContract = (network: Network): string => {
    this.onlyTron(network);
    return this.config.usdtContract;
  };

  readonly getTransaction = async (network: Network, txHash: string): Promise<ChainTxObservation> => {
    this.onlyTron(network);
    const hash = txHash.trim().replace(/^0x/i, '').toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(hash)) {
      return { found: false, detail: 'TRON: la referencia no tiene el formato de un hash de transacción (64 hexadecimales)' };
    }

    // Primero el nodo de solidez: solo devuelve recibos de bloques irreversibles.
    const solid = await this.post<TronTxInfo>('/walletsolidity/gettransactioninfobyid', { value: hash });
    if (!isEmpty(solid)) return this.fromInfo(hash, solid, true);

    // Sin recibo solidificado: puede estar en un bloque reciente o solo transmitida. Nunca se da por fallida.
    const head = await this.post<TronTxInfo>('/wallet/gettransactioninfobyid', { value: hash });
    if (!isEmpty(head)) return this.fromInfo(hash, head, false);
    const tx = await this.post<{ txID?: string }>('/wallet/gettransactionbyid', { value: hash });
    if (!isEmpty(tx) && String(tx.txID ?? '').toLowerCase() === hash) {
      return { found: true, status: 'PENDING', finalized: false, detail: 'TRON: transmitida, todavía sin recibo en un bloque' };
    }
    return { found: false, detail: 'TRON: la red no conoce ese hash' };
  };

  readonly listTransfers = async (network: Network, address: string, businessDate: string): Promise<ChainStatementLine[]> => {
    this.onlyTron(network);
    // Día hábil en America/Bogota (UTC-5 todo el año: Colombia no cambia de horario).
    const min = Date.parse(`${businessDate}T00:00:00-05:00`);
    if (Number.isNaN(min)) throw new Error(`TRON: fecha inválida ${businessDate}`);
    const params = new URLSearchParams({
      only_confirmed: 'true',
      contract_address: this.config.usdtContract,
      min_timestamp: String(min),
      max_timestamp: String(min + 86_400_000 - 1),
      order_by: 'block_timestamp,asc',
      limit: '200',
    });
    const out: ChainStatementLine[] = [];
    let fingerprint: string | undefined;
    for (let page = 0; page < 50; page++) {
      const q = new URLSearchParams(params);
      if (fingerprint) q.set('fingerprint', fingerprint);
      const r = await this.get<{ success?: boolean; data?: unknown[]; meta?: { fingerprint?: string } }>(
        `/v1/accounts/${encodeURIComponent(address)}/transactions/trc20?${q}`,
      );
      if (r.success === false || !Array.isArray(r.data)) throw new Error('TRON: respuesta de extracto inválida');
      for (const raw of r.data as Record<string, unknown>[]) {
        const token = raw.token_info as { address?: string } | undefined;
        if (raw.type !== 'Transfer' || token?.address !== this.config.usdtContract) continue;
        const value = String(raw.value ?? '');
        const ts = Number(raw.block_timestamp);
        if (!/^\d+$/.test(value) || !Number.isFinite(ts) || typeof raw.transaction_id !== 'string') {
          throw new Error('TRON: línea de extracto incompleta');
        }
        const incoming = raw.to === address;
        if (!incoming && raw.from !== address) continue;
        out.push({
          txHash: raw.transaction_id,
          direction: incoming ? 'IN' : 'OUT',
          amountBaseUnits: value,
          counterpartyAddress: String(incoming ? raw.from : raw.to),
          occurredAt: new Date(ts).toISOString(),
        });
      }
      fingerprint = r.meta?.fingerprint;
      if (!fingerprint) return out;
    }
    throw new Error('TRON: el extracto del día tiene demasiadas páginas; se detiene para no dejarlo incompleto');
  };

  /** Lee el recibo. Elige la única transferencia del USDT autorizado; cualquier ambigüedad es una anomalía. */
  private fromInfo(hash: string, info: TronTxInfo, solidified: boolean): ChainTxObservation {
    const anomalies: string[] = [];
    if (info.id !== undefined && String(info.id).toLowerCase() !== hash) anomalies.push('la respuesta no corresponde al hash consultado');
    const blockNumber = typeof info.blockNumber === 'number' && info.blockNumber > 0 ? String(info.blockNumber) : undefined;
    if (!blockNumber) anomalies.push('la red no informó el bloque');
    const receipt = info.receipt?.result;
    if (!receipt) anomalies.push('la red no informó el resultado de la ejecución');
    const failed = (receipt !== undefined && receipt !== 'SUCCESS') || String(info.result ?? '').toUpperCase() === 'FAILED';

    const transfers: Trc20Transfer[] = [];
    let malformed = 0;
    for (const l of info.log ?? []) {
      if (String(l.topics?.[0] ?? '').toLowerCase().replace(/^0x/, '') !== TRC20_TRANSFER_TOPIC) continue;
      const contract = tronHexToBase58(String(l.address ?? ''));
      const from = topicAddress(l.topics?.[1]);
      const to = topicAddress(l.topics?.[2]);
      const amount = uint256(l.data);
      if (l.topics?.length !== 3 || !contract || !from || !to || amount === null) {
        malformed++;
        continue;
      }
      transfers.push({ contract, from, to, amount });
    }
    const usdt = transfers.filter((t) => t.contract === this.config.usdtContract);
    if (usdt.length > 1) anomalies.push(`la transacción tiene ${usdt.length} transferencias del USDT autorizado`);
    if (usdt.length === 0 && malformed > 0) anomalies.push('hay un evento Transfer con formato no reconocido');
    // Sin USDT autorizado se informa el token que sí se movió, para que el control de contrato lo rechace.
    const chosen = usdt[0] ?? transfers[0];

    const where = blockNumber ? `bloque ${blockNumber}` : 'bloque sin informar';
    const base: ChainTxObservation = {
      found: true,
      blockNumber,
      ...(chosen ? { from: chosen.from, to: chosen.to, tokenContract: chosen.contract, amountBaseUnits: chosen.amount } : {}),
      ...(anomalies.length ? { anomaly: `TRON: ${anomalies.join('; ')}` } : {}),
    };
    if (!solidified) {
      // Un recibo fuera de un bloque irreversible no es definitivo, tampoco si dice que falló.
      return { ...base, status: 'PENDING', finalized: false, detail: `TRON: en ${where}, todavía no solidificado${failed ? ' (el recibo indica falla)' : ''}` };
    }
    if (failed) return { ...base, status: 'FAILED', finalized: true, detail: `TRON: la ejecución falló (${receipt ?? info.result}) en ${where}` };
    return { ...base, status: 'SUCCESS', finalized: true, detail: `TRON: solidificada en ${where}` };
  }

  private onlyTron(network: Network) {
    if (network !== 'TRON') throw new Error(`El lector TRON no atiende la red ${network}`);
  }

  private headers(json: boolean): Record<string, string> {
    return {
      accept: 'application/json',
      ...(json ? { 'content-type': 'application/json' } : {}),
      ...(this.config.apiKey ? { 'TRON-PRO-API-KEY': this.config.apiKey } : {}),
    };
  }

  private post<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>(path, { method: 'POST', headers: this.headers(true), body: JSON.stringify(body) });
  }

  private get<T>(path: string): Promise<T> {
    return this.request<T>(path, { method: 'GET', headers: this.headers(false) });
  }

  /** Los mensajes de error nombran la ruta, nunca la cabecera con la llave. */
  private async request<T>(path: string, init: RequestInit): Promise<T> {
    const name = path.split('?')[0];
    let res: Response;
    try {
      res = await this.fetchFn(this.base + path, { ...init, signal: AbortSignal.timeout(this.config.timeoutMs) });
    } catch (e) {
      throw new Error(`TRON ${name}: sin respuesta (${(e as Error).name === 'TimeoutError' ? `más de ${this.config.timeoutMs} ms` : (e as Error).message})`);
    }
    if (!res.ok) throw new Error(`TRON ${name}: HTTP ${res.status}`);
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      throw new Error(`TRON ${name}: respuesta que no es JSON`);
    }
    if (json && typeof json === 'object' && 'Error' in json) {
      throw new Error(`TRON ${name}: ${String((json as { Error: unknown }).Error).slice(0, 200)}`);
    }
    return json as T;
  }
}
