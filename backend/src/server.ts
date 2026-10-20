import { simulatedAdapters } from './adapters/simulated.js';
import { loadConfig } from './config.js';
import { migrate } from './db/migrate.js';
import { createPool } from './db/pool.js';
import { buildApp } from './http/app.js';
import { seedDemo } from './seed.js';

const config = loadConfig();
const db = createPool(config.databaseUrl);

const applied = await migrate(db);
if (applied.length) console.log(`Migraciones aplicadas: ${applied.join(', ')}`);

// Modo DEMO: adaptadores simulados y datos ficticios.
const adapters = simulatedAdapters();
const demoPassword = process.env.DEMO_PASSWORD ?? 'demo1234';
if (await seedDemo(db, demoPassword)) console.log('Datos ficticios de demostración cargados');

const app = buildApp({ db, config, adapters });
await app.listen({ port: config.port, host: '0.0.0.0' });

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    await app.close();
    await db.end();
    process.exit(0);
  });
}
