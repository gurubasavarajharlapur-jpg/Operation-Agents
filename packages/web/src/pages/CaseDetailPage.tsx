import { Link, useParams } from 'react-router';
import { useApi } from '../useApi.ts';
import { date, isOverdue, money, relative, usd } from '../format.ts';
import { ModeBadge, StateBadge } from '../components/Badges.tsx';
import { DecisionPanel } from '../components/DecisionPanel.tsx';
import { AuditTimeline } from '../components/AuditTimeline.tsx';
import { ApprovalActions } from '../components/ApprovalActions.tsx';
import type { CaseDetail } from '../types.ts';

export function CaseDetailPage() {
  const { id } = useParams();
  const { data, error, reload } = useApi<CaseDetail>(`/cases/${id}`, 3000);

  if (error) return <div className="page"><div className="notice red">{error.message}</div></div>;
  if (!data) return <div className="page muted">Loading…</div>;

  const c = data.case;
  const pending = data.approvals.find((a) => a.status === 'pending');
  const refusals = data.events.filter((e) => e.action.startsWith('guardrail.refused')).length;

  return (
    <div className="page stack">
      <div>
        <Link to="/cases" className="muted">← All cases</Link>
      </div>
      <div className="page-header" style={{ marginBottom: 0 }}>
        <div>
          <div className="row" style={{ gap: 10 }}>
            <h1>{c.invoice_number ?? 'Invoice without a number'}</h1>
            <StateBadge state={c.state} />
          </div>
          <p>{c.vendor ?? 'Unknown vendor'} · received {relative(c.created_at)}</p>
        </div>
        <ModeBadge mode={c.mode} model={c.model} />
      </div>

      <dl className="card meta">
        <div><dt>Amount</dt><dd className="num">{money(c.amount, c.currency)}</dd></div>
        <div><dt>Purchase order</dt><dd>{c.po_number ?? '—'}</dd></div>
        <div><dt>Due</dt><dd className={isOverdue(c.due_date, c.state) ? 'overdue' : ''}>{date(c.due_date)}</dd></div>
        <div><dt>Claude usage</dt><dd className="num">{c.mode === 'llm' ? `${c.llm_calls} calls · ${c.tokens.toLocaleString()} tok · ${usd(c.cost_usd)}` : 'None (rules-only)'}</dd></div>
        <div><dt>Guardrail refusals</dt><dd className={refusals ? 'overdue' : ''}>{refusals}</dd></div>
      </dl>

      <div className="grid-2">
        <div className="stack">
          <DecisionPanel detail={data} />
          {pending && (
            <div className="card card-body">
              <h2>Your decision</h2>
              <div className="approval-card">
                <div>
                  <div className="approval-amount num">{money(pending.amount, pending.currency)}</div>
                  <div className="muted">Proposed {relative(pending.created_at)}. Approving queues the (simulated) payment.</div>
                </div>
                <ApprovalActions approval={pending} onDone={reload} />
              </div>
            </div>
          )}
          {data.approvals.filter((a) => a.status !== 'pending').map((a) => (
            <div key={a.id} className={`notice ${a.status === 'approved' ? 'green' : 'red'}`}>
              {a.status === 'approved' ? 'Approved' : 'Rejected'} by <strong>{a.decided_by}</strong> on {date(a.decided_at)}
              {a.decision_note && <>: “{a.decision_note}”</>}
            </div>
          ))}
          <details className="card card-body">
            <summary style={{ cursor: 'pointer', fontWeight: 600 }}>Invoice as received <span className="badge red" style={{ marginLeft: 6 }}>Untrusted input</span></summary>
            <pre className="json">{JSON.stringify(c.payload, null, 2)}</pre>
          </details>
        </div>

        <div className="card card-body">
          <div className="row" style={{ justifyContent: 'space-between', marginBottom: 8 }}>
            <h2 style={{ margin: 0 }}>Audit timeline</h2>
            <span className="faint">{data.events.length} events · hash-chained</span>
          </div>
          <AuditTimeline events={data.events} />
        </div>
      </div>
    </div>
  );
}
