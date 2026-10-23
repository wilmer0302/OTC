import { simulatedAdapters } from './adapters/simulated.js';
import { loadConfig } from './config.js';
import { migrate } from './db/migrate.js';
import { createPool } from './db/pool.js';
import { buildApp } from './http/app.js';
import { sandboxIntegrations } from './integrations/sandbox.js';
import { DEFAULT_IDENTITY } from './modules/identity/service.js';
import { parseKey } from './platform/crypto.js';
import { seedDemo } from './seed.js';
import { seedDemoV1 } from './seedV1.js';

const config = loadConfig();
const db = createPool(config.databaseUrl);

const applied = await migrate(db);
if (applied.length) console.log(`Migraciones aplicadas: ${applied.join(', ')}`);

// Modo DEMO: adaptadores simulados y datos ficticios.
const adapters = simulatedAdapters();
const demoPassword = process.env.DEMO_PASSWORD ?? 'demo1234';
if (await seedDemo(db, demoPassword)) console.log('Datos ficticios de demostración cargados');
const loadedV1 = await seedDemoV1(db, demoPassword);
if (loadedV1.length) console.log(`Datos ficticios del backend v1 cargados: ${loadedV1.join(', ')}`);

const app = buildApp({
  db,
  config,
  adapters,
  v1: {
    db,
    // Modo DEMO: integraciones sandbox. No existen todavía integraciones reales.
    integrations: sandboxIntegrations(db),
    identity: { ...DEFAULT_IDENTITY, mfaKey: parseKey(config.mfaKeyHex) },
    cookieSecure: config.cookieSecure,
    mode: config.mode,
    now: () => new Date(),
  },
});
await app.listen({ port: config.port, host: '0.0.0.0' });

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    await app.close();
    await db.end();
    process.exit(0);
  });
}
