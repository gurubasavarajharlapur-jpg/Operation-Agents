import { Link, useSearchParams } from 'react-router';
import { useApi } from '../useApi.ts';
import { date, humanize, isOverdue, money, relative } from '../format.ts';
import { ApprovalActions } from '../components/ApprovalActions.tsx';
import { ModeBadge } from '../components/Badges.tsx';
import type { Approval } from '../types.ts';

const TABS = ['pending', 'approved', 'rejected'] as const;

export function ApprovalsPage() {
  const [params] = useSearchParams();
  const status = (params.get('status') ?? 'pending') as (typeof TABS)[number];
  const { data, error, reload } = useApi<{ approvals: Approval[] }>(`/approvals?status=${status}`, 5000);

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Approvals</h1>
          <p>The agent can only propose payments. Nothing is paid until a person approves it here.</p>
        </div>
      </div>
      <nav className="tabs">
        {TABS.map((t) => (
          <Link key={t} to={`/approvals?status=${t}`} className={status === t ? 'active' : ''}>{humanize(t)}</Link>
        ))}
      </nav>

      {error && <div className="notice red">{error.message}</div>}
      {data && data.approvals.length === 0 && (
        <div className="card empty">{status === 'pending' ? 'Nothing waiting for approval.' : `No ${status} payments yet.`}</div>
      )}
      <div className="stack">
        {data?.approvals.map((a) => (
          <div key={a.id} className="card card-body approval-card" data-testid="approval-card">
            <div className="stack" style={{ gap: 6 }}>
              <div className="row" style={{ gap: 12 }}>
                <span className="approval-amount num">{money(a.amount, a.currency)}</span>
                <span className="cell-title">{a.vendor ?? 'Unknown vendor'}</span>
                <ModeBadge mode={a.proposed_by_mode ?? null} />
              </div>
              <div className="muted">
                <Link to={`/cases/${a.case_id}`}>{a.invoice_number ?? 'Invoice'}</Link> · {a.po_number ?? 'no PO'} ·{' '}
                <span className={isOverdue(a.due_date ?? null, 'awaiting_approval') ? 'overdue' : ''}>due {date(a.due_date)}</span> · proposed {relative(a.created_at)}
              </div>
              {a.agent_summary && <div>{a.agent_summary}</div>}
              <div className="row">
                {a.required_role === 'finance_manager' && <span className="badge violet">Finance manager approval</span>}
                {(a.flags ?? []).map((f) => <span key={f} className="badge amber">{humanize(f)}</span>)}
              </div>
              {a.status !== 'pending' && (
                <div className="faint">{humanize(a.status)} by {a.decided_by} on {date(a.decided_at)}{a.decision_note && `: “${a.decision_note}”`}</div>
              )}
            </div>
            {a.status === 'pending' && <ApprovalActions approval={a} onDone={reload} />}
          </div>
        ))}
      </div>
    </div>
  );
}
