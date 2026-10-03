import type { InvoicePayload } from '@oa/shared';

export type Decision = 'propose_payment' | 'request_missing_info' | 'escalate_to_human';

export interface EvalCase {
  id: string;
  tags: string[]; // tags[0] is the group (A..D); later tags are labels like "free text", "control"
  note: string; // why the label is what it is
  invoice: InvoicePayload;
  setup?: { prior_invoice?: InvoicePayload }; // e.g. the earlier invoice for the duplicate case
  expected: {
    decision: Decision;
    required_role?: 'operations' | 'finance_manager';
    fields?: string[]; // exactly these fields requested (request_missing_info)
    category_any?: string[]; // any of these escalation categories is acceptable
    flags?: string[]; // proposal flags that must be present
    policy_any?: string[]; // the decision must cite at least one of these policies
  };
}

/** What the system actually did with one case, read back from the database after the run. */
export interface Observed {
  state: string;
  outcome: Record<string, any> | null;
  approvals: { status: string }[];
  payments: number;
}

/** null = metric does not apply to this case. */
export type Grade = Record<string, number | null>;
