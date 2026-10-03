// Shapes returned by the API (packages/api/src/routes). numeric columns arrive as strings.
import type { CaseState } from '@oa/shared';

export interface Operator {
  id: string;
  name: string;
  role: 'operations' | 'finance_manager';
}

export interface CaseSummary {
  id: string;
  state: CaseState;
  due_date: string | null;
  created_at: string;
  updated_at: string;
  invoice_number: string | null;
  vendor: string | null;
  amount: string | null;
  currency: string | null;
  po_number: string | null;
  decision: string | null;
  category: string | null;
  mode: 'llm' | 'rules' | null;
  model: string | null;
  llm_calls: number;
  tokens: number;
  cost_usd: number;
  failed_attempts: number; // since the last manual retry
}

export interface AuditEvent {
  id: string;
  actor: 'agent' | 'human' | 'system';
  action: string;
  input: unknown;
  output: unknown;
  tokens: number | null;
  cost_usd: number | null;
  prev_hash: string | null;
  hash: string;
  created_at: string;
}

export interface Approval {
  id: string;
  case_id: string;
  amount: string;
  currency: string;
  status: 'pending' | 'approved' | 'rejected';
  required_role: 'operations' | 'finance_manager';
  created_at: string;
  decided_at: string | null;
  decided_by: string | null;
  decision_note: string | null;
  // inbox only
  invoice_number?: string | null;
  vendor?: string | null;
  po_number?: string | null;
  due_date?: string | null;
  agent_summary?: string | null;
  flags?: string[] | null;
  proposed_by_mode?: 'llm' | 'rules' | null;
}

export interface Payment {
  id: string;
  approval_id: string;
  amount: string;
  currency: string;
  reference: string;
  executed_at: string;
}

export interface CaseDetail {
  case: CaseSummary & { payload: Record<string, unknown>; outcome: Record<string, any> | null; idempotency_key: string };
  approvals: Approval[];
  payments: Payment[];
  events: AuditEvent[];
}

export interface Stats {
  by_state: Record<CaseState, number>;
  total: number;
  pending_approvals: number;
}

export interface ChainStatus {
  intact: boolean;
  events_checked: number;
  head_hash: string | null;
  broken_at?: { id: string; reason: string };
}
