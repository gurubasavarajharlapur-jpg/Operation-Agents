// Production entry point: one Node process serving the API (under /api), the built dashboard,
// and the worker. Fits a single free web service. The worker still connects to the database as
// the restricted ops_worker user, so the agent cannot approve payments here either.
//
//   npm run build && npm run start:prod
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
import { startQueue } from '@oa/db';
import { apiConfig, buildServer, createPool } from '@oa/api';
import { startWorker } from '@oa/worker';

const WEB_DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web/dist');

const worker = await startWorker();
const pool = createPool(apiConfig.databaseUrl);
const boss = await startQueue(apiConfig.databaseUrl, 'api');
const demoEnabled = process.env.DEMO_MODE === 'true';
const faultInjection = process.env.ENABLE_FAULT_INJECTION === 'true';

const app = buildServer({
  pool,
  boss,
  webhookSecret: apiConfig.webhookSecret,
  apiPrefix: '/api',
  faultInjection,
  demo: {
    faultInjection,
    enabled: demoEnabled,
    agentMode: worker.mode,
    invoicesPerHour: Number(process.env.DEMO_INVOICES_PER_HOUR ?? 60),
    signInsPerHour: Number(process.env.DEMO_SIGN_INS_PER_HOUR ?? 60),
  },
});

// The dashboard: static files, and index.html for any other non-API path (client-side routes
// like /cases/123 must load the app, which then renders the right page).
await app.register(fastifyStatic, { root: WEB_DIST, wildcard: false });
app.setNotFoundHandler((request, reply) => {
  if (request.method === 'GET' && !request.url.startsWith('/api/')) return reply.sendFile('index.html');
  return reply.code(404).send({ error: 'not found' });
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    await app.close();
    await worker.stop();
    await boss.stop();
    await pool.end();
    process.exit(0);
  });
}

await app.listen({ port: apiConfig.port, host: '0.0.0.0' });
console.log(`operation-agents: http://localhost:${apiConfig.port} (demo mode ${demoEnabled ? 'on' : 'off'}, agent ${worker.mode})`);
