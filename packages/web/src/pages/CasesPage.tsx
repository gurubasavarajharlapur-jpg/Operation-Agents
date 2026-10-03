import { useNavigate, useSearchParams } from 'react-router';
import { CASE_STATES, type CaseState } from '@oa/shared';
import { useApi } from '../useApi.ts';
import { date, isOverdue, money, relative, usd } from '../format.ts';
import { ModeBadge, StateBadge } from '../components/Badges.tsx';
import type { CaseSummary, Stats } from '../types.ts';

const LABELS: Record<CaseState, string> = {
  received: 'Received', validating: 'Agent working', needs_info: 'Needs info', awaiting_approval: 'Awaiting approval',
  escalated: 'Escalated', completed: 'Completed', failed: 'Failed',
};

export function CasesPage() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const state = params.get('state') as CaseState | null;
  // Refresh every 3s, so you can watch a new invoice move through the states.
  const { data, error } = useApi<{ cases: CaseSummary[] }>(`/cases${state ? `?state=${state}` : ''}`, 3000);
  const { data: stats } = useApi<Stats>('/stats', 3000);

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Cases</h1>
          <p>Every invoice the agent has received, newest first. Updates live.</p>
        </div>
      </div>

      <div className="chips" role="tablist">
        <button className={`chip ${!state ? 'active' : ''}`} onClick={() => setParams({})}>
          All<span className="n">{stats?.total ?? ''}</span>
        </button>
        {CASE_STATES.filter((s) => s !== 'failed' || (stats?.by_state.failed ?? 0) > 0).map((s) => (
          <button key={s} className={`chip ${state === s ? 'active' : ''}`} onClick={() => setParams({ state: s })}>
            {LABELS[s]}<span className="n">{stats?.by_state[s] ?? ''}</span>
          </button>
        ))}
      </div>

      <div className="card">
        {error && <div className="card-body error-text">{error.message}</div>}
        {data && data.cases.length === 0 && (
          <div className="empty">
            No cases here yet. Send one with <code>npm run send:invoice -- --scenario happy</code>
          </div>
        )}
        {data && data.cases.length > 0 && (
          <table className="table" data-testid="cases-table">
            <thead>
              <tr>
                <th>Invoice</th>
                <th>Vendor</th>
                <th className="right">Amount</th>
                <th>State</th>
                <th>Due</th>
                <th>Decided by</th>
                <th className="right">Claude cost</th>
              </tr>
            </thead>
            <tbody>
              {data.cases.map((c) => (
                <tr key={c.id} onClick={() => navigate(`/cases/${c.id}`)} data-case-id={c.id}>
                  <td>
                    <div className="cell-title">{c.invoice_number ?? <span className="faint">(no number)</span>}</div>
                    <div className="cell-sub">{relative(c.created_at)}</div>
                  </td>
                  <td>{c.vendor ?? <span className="faint">Unknown</span>}</td>
                  <td className="right num">{money(c.amount, c.currency)}</td>
                  <td><StateBadge state={c.state} /></td>
                  <td className={isOverdue(c.due_date, c.state) ? 'overdue' : ''}>
                    {date(c.due_date)}{isOverdue(c.due_date, c.state) && ' · overdue'}
                  </td>
                  <td><ModeBadge mode={c.mode} model={c.model} /></td>
                  <td className="right num muted">{c.mode === 'llm' ? usd(c.cost_usd) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
