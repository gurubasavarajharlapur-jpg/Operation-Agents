// The Claude agent loop. Claude chooses tools; the loop runs them, records every step in the
// audit trail, and stops as soon as a decision tool succeeds. Every other way out of the loop
// (no decision, turn limit, refusal, output limit) escalates the case to a human.
import type Anthropic from '@anthropic-ai/sdk';
import type pg from 'pg';
import { recordAuditEvent } from '@oa/db';
import type { CaseState } from '@oa/shared';
import type { CreateMessage } from '../llm.ts';
import type { Effort } from '../config.ts';
import { applyDecision, type DecisionResult } from './decisions.ts';
import { loadCase, todayUtc } from './facts.ts';
import { costUsd, totalTokens } from './pricing.ts';
import { NUDGE_MESSAGE, SYSTEM_PROMPT, buildUserMessage } from './prompt.ts';
import { TOOL_DEFINITIONS, executeTool, isDecisionTool } from './tools.ts';

export interface LlmAgentDeps {
  pool: pg.Pool;
  createMessage: CreateMessage;
  model: string;
  effort: Effort;
  maxTurns: number;
  voyageApiKey?: string;
  today?: string;
}

export interface AgentRunResult {
  state: CaseState | null; // null if the case had already been decided elsewhere
  endReason: 'decision' | 'already_decided' | 'no_decision' | 'turn_limit' | 'refusal' | 'max_tokens' | 'unexpected_stop';
  turns: number;
  tokens: number;
  costUsd: number;
}

export async function runLlmAgent(deps: LlmAgentDeps, caseId: string): Promise<AgentRunResult> {
  const today = deps.today ?? todayUtc();
  const caseRow = await loadCase(deps.pool, caseId);
  const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: 'user', content: buildUserMessage(caseId, caseRow.payload, today) }];
  const totals = { tokens: 0, costUsd: 0 };
  let nudged = false;

  const finish = (state: CaseState | null, endReason: AgentRunResult['endReason'], turns: number): AgentRunResult => ({
    state, endReason, turns, ...totals,
  });

  // Any exit without a decision hands the case to a human.
  const forceEscalation = async (endReason: AgentRunResult['endReason'], reason: string, turns: number) => {
    const result = await applyDecision(
      { pool: deps.pool, caseId, actor: 'system', mode: 'llm', today },
      { type: 'escalate_to_human', category: 'agent_failure', reason, policy_refs: [] },
    );
    return finish(result.ok ? result.state : null, result.ok ? endReason : 'already_decided', turns);
  };

  for (let turn = 1; turn <= deps.maxTurns; turn++) {
    const response = await deps.createMessage({
      model: deps.model,
      max_tokens: 16000,
      // Tools render before the system prompt, so this breakpoint caches tools + system together.
      system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
      tools: TOOL_DEFINITIONS,
      messages,
      output_config: { effort: deps.effort },
      cache_control: { type: 'ephemeral' }, // also cache the growing conversation between turns
    });

    const cost = costUsd(response.model, response.usage);
    const tokens = totalTokens(response.usage);
    totals.tokens += tokens;
    totals.costUsd += cost ?? 0;
    const toolUses = response.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use');
    await recordAuditEvent(deps.pool, {
      caseId, actor: 'agent', action: 'llm.call', tokens, costUsd: cost,
      input: { turn, model: deps.model, effort: deps.effort },
      output: {
        served_by: response.model,
        stop_reason: response.stop_reason,
        usage: response.usage,
        text: response.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n') || undefined,
        tool_calls: toolUses.map((t) => ({ name: t.name, input: t.input })),
      },
    });

    // Append the whole assistant turn unchanged (thinking blocks included); the history is append-only.
    messages.push({ role: 'assistant', content: response.content });

    switch (response.stop_reason) {
      case 'tool_use': {
        const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
        let decided: DecisionResult | null = null;
        for (const toolUse of toolUses) {
          if (decided?.ok) {
            results.push({ type: 'tool_result', tool_use_id: toolUse.id, is_error: true, content: 'Not run: a decision was already made for this case.' });
            continue;
          }
          const out = await executeTool(
            { pool: deps.pool, caseId, voyageApiKey: deps.voyageApiKey, today },
            toolUse.name,
            toolUse.input as Record<string, unknown>,
          );
          await recordAuditEvent(deps.pool, {
            caseId, actor: 'agent',
            // A refused decision is the guardrail working; give it its own action so it stands out.
            action: isDecisionTool(toolUse.name) && out.isError ? `guardrail.refused.${toolUse.name}` : `tool.${toolUse.name}`,
            input: toolUse.input, output: out.result,
          });
          if (out.decision?.ok) decided = out.decision;
          // Another worker decided this case meanwhile: stop now rather than pay for more turns.
          if (out.decision && !out.decision.ok && out.decision.alreadyDecided) return finish(null, 'already_decided', turn);
          results.push({ type: 'tool_result', tool_use_id: toolUse.id, is_error: out.isError, content: JSON.stringify(out.result) });
        }
        if (decided?.ok) return finish(decided.state, 'decision', turn);
        messages.push({ role: 'user', content: results });
        break;
      }
      case 'end_turn':
      case 'stop_sequence':
        if (nudged) return forceEscalation('no_decision', 'The agent finished without making a decision.', turn);
        nudged = true;
        messages.push({ role: 'user', content: NUDGE_MESSAGE });
        break;
      case 'pause_turn':
        break; // server paused a long turn; sending the history back resumes it
      case 'refusal':
        return forceEscalation('refusal', `The model declined to process this case (${response.stop_details?.category ?? 'no category'}).`, turn);
      case 'max_tokens':
        return forceEscalation('max_tokens', 'The model response hit the output token limit.', turn);
      default:
        return forceEscalation('unexpected_stop', `Unexpected stop reason: ${response.stop_reason}.`, turn);
    }
  }
  return forceEscalation('turn_limit', `No decision after ${deps.maxTurns} turns.`, deps.maxTurns);
}

