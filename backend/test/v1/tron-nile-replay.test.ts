import { describe, expect, it } from 'vitest';
import { tronConfigFromEnv } from '../../src/integrations/factory.js';
import { TronGridReader } from '../../src/integrations/tron/reader.js';

// Respuestas REALES de Nile (testnet), capturadas el 2026-10-24 con GET a nile.trongrid.io y repetidas aquí
// sin conexión. Sirven para comprobar que el lector entiende datos reales; NO prueban la conexión del
// adaptador con la red (eso es `npm run test:tron-real`). Se capturaron con una herramienta de lectura
// web, así que son fieles en contenido pero no byte a byte.
//
// Contrato USDT de prueba de Nile: TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf, según nileex.io/join/getJoinPage
// (sitio oficial de Nile enlazado desde developers.tron.network/docs/networks). No es el de la red principal.
// Lo esperado sale del explorador: nileapi.tronscan.org/api/transaction-info?hash=<HASH>.

const NILE_USDT = 'TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf';
const HASH = 'd38ecd357277850c0aeb468b1fc17631d6b35fc13c37e62fea24d6a9e16fc1ab';
const RECEIPT = {
  id: HASH,
  fee: 345000,
  blockNumber: 71008678,
  blockTimeStamp: 1789549287000,
  contractResult: ['0000000000000000000000000000000000000000000000000000000000000000'],
  contract_address: '41eca9bc828a3005b9a3b909f2cc5c2a54794de05f',
  receipt: { origin_energy_usage: 29650, energy_usage_total: 29650, net_fee: 345000, result: 'SUCCESS' },
  log: [
    {
      address: 'eca9bc828a3005b9a3b909f2cc5c2a54794de05f',
      topics: [
        'ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
        '0000000000000000000000009737a11aa82e1427b8eb5a0350c3fa2933db94f3',
        '000000000000000000000000bdd3cceb533d590d2017b8714740ef4a63ae2585',
      ],
      data: '000000000000000000000000000000000000000000000000000000000606d4d8',
    },
  ],
};

function replay(solid: boolean, usdtContract = NILE_USDT) {
  const f = (async (url: string | URL) => {
    const path = new URL(String(url)).pathname;
    const body =
      path === '/walletsolidity/gettransactioninfobyid' ? (solid ? RECEIPT : {}) : path === '/wallet/gettransactioninfobyid' ? RECEIPT : {};
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  const cfg = tronConfigFromEnv({ TRON_READER: 'trongrid', TRON_RPC_URL: 'https://nile.trongrid.io', TRON_USDT_CONTRACT: usdtContract })!;
  return new TronGridReader({ ...cfg, fetch: f });
}

describe('lector TRON con respuestas reales de Nile (repetidas, sin red)', () => {
  it('hash, contrato, origen, destino, cantidad, estado y bloque coinciden con el explorador', async () => {
    const obs = await replay(true).getTransaction('TRON', HASH);
    expect(obs).toMatchObject({
      found: true,
      status: 'SUCCESS',
      finalized: true,
      blockNumber: '71008678',
      tokenContract: NILE_USDT,
      from: 'TPkmgDb1GFT1EJ6JgBUbfeAKqxvGWMy36y',
      to: 'TTGvSUAzC4AMbksrzYLHdxuVFJZ7DjrDVr',
      amountBaseUnits: '101111000', // 101.111 USDT con 6 decimales
    });
    expect(obs.anomaly).toBeUndefined();
  });

  it('el mismo recibo fuera del nodo de solidez no se da por definitivo', async () => {
    const obs = await replay(false).getTransaction('TRON', HASH);
    expect(obs).toMatchObject({ found: true, status: 'PENDING', finalized: false });
  });

  it('con otro contrato configurado, informa el contrato real para que el control lo rechace', async () => {
    const obs = await replay(true, 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t').getTransaction('TRON', HASH); // USDT de la red principal
    expect(obs.tokenContract).toBe(NILE_USDT);
  });
});
