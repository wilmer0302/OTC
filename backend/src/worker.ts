import { loadConfig } from './config.js';
import { createPool } from './db/pool.js';
import { sandboxIntegrations } from './integrations/sandbox.js';
import { runSweeps } from './jobs/sweeps.js';

// Proceso trabajador: vencimientos y seguimiento, separado de la API.
// Modo DEMO: integraciones sandbox. No existen todavía integraciones reales.
const config = loadConfig();
const db = createPool(config.databaseUrl);
const integrations = sandboxIntegrations(db);
const intervalMs = Number(process.env.WORKER_INTERVAL_MS ?? 5000);

let running = true;
async function loop() {
  while (running) {
    try {
      await runSweeps(db, integrations, () => new Date());
    } catch (err) {
      // El detalle va al registro técnico; el siguiente ciclo vuelve a intentar.
      console.error(JSON.stringify({ level: 'error', msg: 'Fallo en el barrido del trabajador', error: (err as Error).message }));
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  await db.end();
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    running = false;
  });
}
void loop();
