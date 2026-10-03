// Every state a case can be in. Kept in sync with the CHECK constraint on cases.state
// in packages/db/migrations/001_core_tables.sql.
export const CASE_STATES = [
  'received',
  'validating',
  'needs_info',
  'awaiting_approval',
  'escalated',
  'completed',
  'failed',
] as const;

export type CaseState = (typeof CASE_STATES)[number];

// Which state can move to which. The worker (step 3) refuses any transition not listed here.
export const ALLOWED_TRANSITIONS: Record<CaseState, readonly CaseState[]> = {
  received: ['validating', 'failed'],
  validating: ['needs_info', 'awaiting_approval', 'escalated', 'failed'],
  needs_info: ['validating', 'escalated'], // vendor re-sends info -> re-validate
  awaiting_approval: ['completed', 'escalated'], // approved -> completed, rejected -> escalated
  escalated: ['completed'], // a human resolves it
  completed: [],
  failed: ['received'], // manual retry from the dashboard
};

export function canTransition(from: CaseState, to: CaseState): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}
