import { MAX_ATTEMPTS, type CaseState } from '@oa/shared';

const STATE_STYLE: Record<CaseState, { label: string; tone: string; pulse?: boolean }> = {
  received: { label: 'Received', tone: 'blue', pulse: true },
  validating: { label: 'Agent working', tone: 'blue', pulse: true },
  needs_info: { label: 'Needs info', tone: 'amber' },
  awaiting_approval: { label: 'Awaiting approval', tone: 'amber' },
  escalated: { label: 'Escalated', tone: 'red' },
  completed: { label: 'Completed', tone: 'green' },
  failed: { label: 'Failed', tone: 'red' },
};

export function StateBadge({ state, failedAttempts = 0 }: { state: CaseState; failedAttempts?: number }) {
  // Between attempts the case is still "in progress", but say so honestly.
  if ((state === 'received' || state === 'validating') && failedAttempts > 0 && failedAttempts < MAX_ATTEMPTS) {
    return (
      <span className="badge amber pulse" data-testid="state-badge" title="The last attempt failed; pg-boss will retry with exponential backoff">
        <span className="dot" />
        Retrying · attempt {failedAttempts + 1} of {MAX_ATTEMPTS}
      </span>
    );
  }
  const s = STATE_STYLE[state] ?? { label: state, tone: '' };
  return (
    <span className={`badge ${s.tone} ${s.pulse ? 'pulse' : ''}`} data-testid="state-badge">
      <span className="dot" />
      {s.label}
    </span>
  );
}

/** Who decided: the Claude agent (with the model) or the rules-only engine. Never ambiguous. */
export function ModeBadge({ mode, model }: { mode: 'llm' | 'rules' | null; model?: string | null }) {
  if (mode === 'llm') return <span className="badge violet" title="Decided by the Claude agent">✦ Claude{model ? ` · ${model.replace('claude-', '')}` : ''}</span>;
  if (mode === 'rules') return <span className="badge outline" title="Decided by fixed rules, no LLM involved">Rules-only (no LLM)</span>;
  return <span className="faint">—</span>;
}
