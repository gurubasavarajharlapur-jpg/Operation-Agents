// The numbers from the policy documents (packages/db/seed/policies), in one place.
// Guardrails, the rules-only agent and the tests all read these, so code and policy cannot drift apart.
export const POLICY = {
  requiredFields: ['invoice_number', 'vendor', 'po_number', 'amount', 'currency', 'issue_date', 'due_date', 'line_items'] as const,
  lineItemRoundingTolerance: 0.01, // policy 01
  poMatchPercentTolerance: 0.02, // policy 02: within 2% ...
  poMatchAbsoluteTolerance: 50.0, // ... or 50.00, whichever is smaller
  operationsApprovalLimit: 10_000, // policy 04: above this a finance manager must approve
  maxProposableAmount: 50_000, // policy 04: above this the agent must escalate
} as const;

export type RequiredField = (typeof POLICY.requiredFields)[number];
