// Handles one invoice.process job. pg-boss delivers jobs at least once, so this must be safe to
// run twice for the same case: the claim step below makes a repeat delivery a no-op.
import type pg from 'pg';
import { appendAuditEvent } from '@oa/db';
import type { CaseState } from '@oa/shared';
import type { AgentMode, Effort } from './config.ts';
import type { CreateMessage } from './llm.ts';
import { runLlmAgent, type AgentRunResult } from './agent/loop.ts';
import { runRulesAgent } from './agent/rulesAgent.ts';

export interface WorkerDeps {
  pool: pg.Pool;
  mode: AgentMode;
  createMessage?: CreateMessage; // required when mode is 'llm'
  model: string;
  effort: Effort;
  maxTurns: number;
  voyageApiKey?: string;
  today?: string;
}

export type ProcessResult = { status: 'skipped'; state: CaseState } | ({ status: 'processed' } & AgentRunResult);

export async function processCase(deps: WorkerDeps, caseId: string, attempt = 0): Promise<ProcessResult> {
  const claimed = await claimCase(deps, caseId, attempt);
  if (claimed !== 'validating') return { status: 'skipped', state: claimed };

  const result =
    deps.mode === 'llm'
      ? await runLlmAgent(
          {
            pool: deps.pool, createMessage: requireClient(deps), model: deps.model, effort: deps.effort,
            maxTurns: deps.maxTurns, voyageApiKey: deps.voyageApiKey, today: deps.today,
          },
          caseId,
        )
      : await runRulesAgent(deps.pool, caseId, deps.today);
  return { status: 'processed', ...result };
}

/**
 * received   -> validating, and the agent starts.
 * validating -> stays validating: a previous attempt crashed before deciding, so start over.
 *               (Safe: decisions and approvals are written atomically with the state change,
 *               so a crashed attempt leaves nothing half-done.)
 * anything else -> already decided; do nothing.
 */
async function claimCase(deps: WorkerDeps, caseId: string, attempt: number): Promise<CaseState> {
  const client = await deps.pool.connect();
  try {
    await client.query('BEGIN');
    // NO KEY UPDATE: see the note in decisions.ts on why not FOR UPDATE.
    const row = await client.query<{ state: CaseState }>('SELECT state FROM cases WHERE id = $1 FOR NO KEY UPDATE', [caseId]);
    const state = row.rows[0]?.state;
    if (!state) throw new Error(`case ${caseId} not found`);
    const run = { mode: deps.mode, model: deps.mode === 'llm' ? deps.model : null, attempt };

    if (state === 'received') {
      await client.query("UPDATE cases SET state = 'validating' WHERE id = $1", [caseId]);
      await appendAuditEvent(client, { caseId, actor: 'system', action: 'state.changed', input: { from: 'received', to: 'validating' }, output: { state: 'validating' } });
      await appendAuditEvent(client, { caseId, actor: 'system', action: 'agent.started', input: run });
    } else if (state === 'validating') {
      await appendAuditEvent(client, { caseId, actor: 'system', action: 'agent.restarted', input: run });
    } else {
      await appendAuditEvent(client, { caseId, actor: 'system', action: 'job.skipped', input: { attempt }, output: { reason: `case already ${state}` } });
    }
    await client.query('COMMIT');
    return state === 'received' ? 'validating' : state;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

function requireClient(deps: WorkerDeps): CreateMessage {
  if (!deps.createMessage) throw new Error('AGENT_MODE is llm but no Anthropic client was configured');
  return deps.createMessage;
}
