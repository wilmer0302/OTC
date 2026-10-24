import { mkdirSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { tronConfigFromEnv } from '../src/integrations/factory.js';
import { TronGridReader } from '../src/integrations/tron/reader.js';

// Prueba de integración REAL con un nodo TRON, solo de lectura: no firma, no envía y no usa fondos.
// Se ejecuta a mano: TRON_RPC_URL=https://nile.trongrid.io npm run test:tron-real
//
// Variables (nada se guarda en el repositorio):
//   TRON_RPC_URL         obligatoria. Nile: https://nile.trongrid.io  Red principal: https://api.trongrid.io
//   TRON_API_KEY         opcional; va en la cabecera TRON-PRO-API-KEY y nunca se escribe en el informe.
//   TRON_USDT_CONTRACT   para las pruebas del lector. Debe ser el contrato USDT de ESA red, verificado.
//   TRON_REAL_TX_HASH    opcional: una transferencia USDT conocida de esa red, para leerla con el lector.
//   TRON_REAL_EXPECT_FROM / _TO / _AMOUNT  opcionales: lo que muestra el explorador para ese hash.
//
// Deja el resultado en test-real/out/ (ignorado por git): red, endpoint, extracto de la respuesta y altura.
//
// Pasar esta prueba demuestra que el nodo responde y que el lector entiende sus respuestas. NO demuestra
// que la detección de depósitos funcione de extremo a extremo: eso exige además un depósito real de
// testnet a la billetera de la mesa, confirmado por el trabajador y conciliado contra el extracto.

const env = process.env;
const rpcUrl = env.TRON_RPC_URL?.trim().replace(/\/+$/, '');
const report: Record<string, unknown> = { at: new Date().toISOString(), endpoint: rpcUrl ?? null };

function save() {
  mkdirSync(new URL('./out/', import.meta.url), { recursive: true });
  const file = new URL(`./out/tron-${String(report.at).replace(/[:.]/g, '-')}.json`, import.meta.url);
  writeFileSync(file, JSON.stringify(report, null, 2));
  console.log(`Informe: ${file.pathname}\n${JSON.stringify(report, null, 2)}`);
}

const headers = () => ({
  accept: 'application/json',
  'content-type': 'application/json',
  ...(env.TRON_API_KEY ? { 'TRON-PRO-API-KEY': env.TRON_API_KEY.trim() } : {}),
});

describe('TRON real, solo lectura', () => {
  it('el endpoint está configurado', () => {
    if (!rpcUrl) throw new Error('Falta TRON_RPC_URL. Ejemplo: TRON_RPC_URL=https://nile.trongrid.io npm run test:tron-real');
    expect(new URL(rpcUrl).protocol).toBe('https:');
  });

  it('consulta el último bloque (POST /wallet/getnowblock) y registra la altura', async () => {
    const url = `${rpcUrl}/wallet/getnowblock`;
    let res: Response;
    try {
      res = await fetch(url, { method: 'POST', headers: headers(), signal: AbortSignal.timeout(15000) });
    } catch (e) {
      const cause = (e as { cause?: { message?: string } }).cause?.message;
      report.getnowblock = { ok: false, error: `${(e as Error).message}${cause ? ` (${cause})` : ''}` };
      save();
      throw e;
    }
    const body = (await res.json().catch(() => null)) as Record<string, any> | null;
    const raw = body?.block_header?.raw_data ?? {};
    report.getnowblock = {
      ok: res.ok,
      httpStatus: res.status,
      blockID: body?.blockID ?? null,
      number: raw.number ?? null,
      timestamp: raw.timestamp ?? null,
      // Extracto: las claves que llegaron, por si la forma no es la esperada.
      keys: body ? Object.keys(body) : null,
      headerKeys: Object.keys(raw),
    };
    save();
    expect(res.ok).toBe(true);
    expect(body?.blockID).toMatch(/^[0-9a-f]{64}$/);
    expect(Number.isInteger(raw.number) && raw.number > 0).toBe(true);
  });

  const reader = () => {
    const cfg = tronConfigFromEnv({ ...env, TRON_READER: 'trongrid' });
    return new TronGridReader(cfg!);
  };

  it.skipIf(!env.TRON_USDT_CONTRACT)('el lector interpreta la respuesta real a un hash inexistente: no encontrado, sin error', async () => {
    const obs = await reader().getTransaction('TRON', '0'.repeat(64));
    report.unknownHash = obs;
    save();
    expect(obs.found).toBe(false);
  });

  it.skipIf(!env.TRON_USDT_CONTRACT || !env.TRON_REAL_TX_HASH)('el lector lee una transferencia USDT conocida y coincide con el explorador', async () => {
    const obs = await reader().getTransaction('TRON', env.TRON_REAL_TX_HASH!);
    report.knownTx = { hash: env.TRON_REAL_TX_HASH, ...obs };
    save();
    expect(obs).toMatchObject({ found: true, status: 'SUCCESS', finalized: true, tokenContract: env.TRON_USDT_CONTRACT });
    expect(obs.anomaly).toBeUndefined();
    if (env.TRON_REAL_EXPECT_FROM) expect(obs.from).toBe(env.TRON_REAL_EXPECT_FROM);
    if (env.TRON_REAL_EXPECT_TO) expect(obs.to).toBe(env.TRON_REAL_EXPECT_TO);
    if (env.TRON_REAL_EXPECT_AMOUNT) expect(obs.amountBaseUnits).toBe(env.TRON_REAL_EXPECT_AMOUNT);
  });
});
