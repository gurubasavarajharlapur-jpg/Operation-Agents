import pg from 'pg';
import { startQueue } from '@oa/db';
import { APPROVAL_FINALIZE_QUEUE, INVOICE_QUEUE } from '@oa/shared';
import { config } from './config.ts';
import { anthropicCreateMessage } from './llm.ts';
import { finalizeApproval } from './finalizeApproval.ts';
import { processCase } from './processCase.ts';

const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 10 });
const createMessage = config.agentMode === 'llm' ? anthropicCreateMessage() : undefined; // one client, reused
const boss = await startQueue(config.databaseUrl, 'worker');

console.log(
  config.agentMode === 'llm'
    ? `worker: Claude agent mode (model ${config.model}, effort ${config.effort})`
    : 'worker: RULES-ONLY mode (no LLM). Set ANTHROPIC_API_KEY to use the Claude agent.',
);

await boss.work<{ caseId: string }>(INVOICE_QUEUE, { localConcurrency: config.concurrency }, async ([job]) => {
  const result = await processCase(
    {
      pool,
      mode: config.agentMode,
      createMessage,
      model: config.model,
      effort: config.effort,
      maxTurns: config.maxTurns,
      voyageApiKey: config.voyageApiKey,
    },
    job.data.caseId,
    job.retryCount,
  );
  console.log(`case ${job.data.caseId}:`, result.status === 'skipped' ? `skipped (${result.state})` : `${result.state ?? 'decided by another worker'} via ${result.endReason}, ${result.turns} turns, $${result.costUsd.toFixed(4)}`);
  return result; // stored on the pg-boss job as its output
});

await boss.work<{ approvalId: string }>(APPROVAL_FINALIZE_QUEUE, async ([job]) => {
  const result = await finalizeApproval(pool, job.data.approvalId);
  console.log(`approval ${job.data.approvalId}:`, result);
  return result;
});

// A thrown error fails the job; pg-boss retries it with exponential backoff (see startQueue).

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    await boss.stop(); // waits for in-flight jobs
    await pool.end();
    process.exit(0);
  });
}
