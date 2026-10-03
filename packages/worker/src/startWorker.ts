// Starts the worker: consumes invoice.process and approval.finalize jobs. Used by `npm run dev:worker`
// (on its own) and by the production app (in the same process as the API).
import pg from 'pg';
import { startQueue } from '@oa/db';
import { APPROVAL_DEAD_LETTER_QUEUE, APPROVAL_FINALIZE_QUEUE, INVOICE_DEAD_LETTER_QUEUE, INVOICE_QUEUE } from '@oa/shared';
import { config } from './config.ts';
import { anthropicCreateMessage } from './llm.ts';
import { handleFinalizeDeadLetter, handleInvoiceDeadLetter, runFinalizeJob, runInvoiceJob } from './jobs.ts';

export async function startWorker() {
  const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 10 });
  const createMessage = config.agentMode === 'llm' ? anthropicCreateMessage() : undefined; // one client, reused
  const boss = await startQueue(config.databaseUrl, 'worker');

  console.log(
    config.agentMode === 'llm'
      ? `worker: Claude agent mode (model ${config.model}, effort ${config.effort}${config.dailyLlmBudgetUsd !== undefined ? `, daily budget $${config.dailyLlmBudgetUsd}` : ''})`
      : 'worker: RULES-ONLY mode (no LLM). Set ANTHROPIC_API_KEY to use the Claude agent.',
  );

  await boss.work<{ caseId: string }>(INVOICE_QUEUE, { localConcurrency: config.concurrency }, async ([job]) => {
    const result = await runInvoiceJob(
      {
        pool,
        mode: config.agentMode,
        createMessage,
        model: config.model,
        effort: config.effort,
        maxTurns: config.maxTurns,
        voyageApiKey: config.voyageApiKey,
        dailyLlmBudgetUsd: config.dailyLlmBudgetUsd,
      },
      job,
    );
    console.log(`case ${job.data.caseId}:`, result.status === 'skipped' ? `skipped (${result.state})` : `${result.state ?? 'decided by another worker'} via ${result.endReason}, ${result.turns} turns, $${result.costUsd.toFixed(4)}`);
    return result; // stored on the pg-boss job as its output
  });

  await boss.work<{ approvalId: string }>(APPROVAL_FINALIZE_QUEUE, async ([job]) => {
    const result = await runFinalizeJob(pool, job);
    console.log(`approval ${job.data.approvalId}:`, result);
    return result;
  });
  // A thrown error fails the job; pg-boss retries it with exponential backoff (see installQueues).
  // After the last attempt it lands in a dead-letter queue, and the case is marked failed:
  await boss.work<{ caseId: string }>(INVOICE_DEAD_LETTER_QUEUE, async ([job]) => {
    const result = await handleInvoiceDeadLetter(pool, job);
    console.log(`case ${job.data.caseId} dead-lettered:`, result);
    return result;
  });
  await boss.work<{ approvalId: string }>(APPROVAL_DEAD_LETTER_QUEUE, async ([job]) => {
    const result = await handleFinalizeDeadLetter(pool, job);
    console.log(`approval ${job.data.approvalId} dead-lettered:`, result);
    return result;
  });

  return {
    mode: config.agentMode,
    async stop() {
      await boss.stop(); // waits for in-flight jobs
      await pool.end();
    },
  };
}
