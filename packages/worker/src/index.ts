import { startWorker } from './startWorker.ts';

const worker = await startWorker();

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    await worker.stop();
    process.exit(0);
  });
}
