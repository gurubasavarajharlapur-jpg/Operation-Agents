import { config } from './config.ts';
import { createPool } from './db.ts';
import { startQueue } from '@oa/db';
import { buildServer } from './server.ts';

const pool = createPool(config.databaseUrl);
const boss = await startQueue(config.databaseUrl);
const app = buildServer({ pool, boss, webhookSecret: config.webhookSecret });

// Finish in-flight requests and release connections on Ctrl+C / container stop.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    await app.close();
    await boss.stop();
    await pool.end();
    process.exit(0);
  });
}

await app.listen({ port: config.port, host: '0.0.0.0' });
