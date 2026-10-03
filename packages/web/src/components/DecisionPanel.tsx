import { categoryLabel, date, humanize, money } from '../format.ts';
import type { CaseDetail } from '../types.ts';
import { ModeBadge } from './Badges.tsx';

type Outcome = Record<string, any>;

/** What was decided, why, and what happened next. Reads cases.outcome. */
export function DecisionPanel({ detail }: { detail: CaseDetail }) {
  const c = detail.case;
  const o: Outcome | null = c.outcome;

  if (!o) {
    return (
      <div className="card card-body">
        <h2>Decision</h2>
        <div className="notice">The agent is still working on this case. This page updates automatically.</div>
      </div>
    );
  }

  return (
    <div className="card card-body stack">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h2 style={{ margin: 0 }}>Decision</h2>
        <ModeBadge mode={o.decided_by_mode ?? c.mode} model={c.model} />
      </div>

      {o.decision === 'propose_payment' && (
        <>
          <div className="notice amber">
            <strong>Payment proposed: {money(o.amount, o.currency)}</strong>. A human must approve it; the agent cannot pay.
          </div>
          {o.summary && <p style={{ margin: 0 }}>{o.summary}</p>}
          <dl className="kv">
            <dt>Approver needed</dt><dd>{o.required_role === 'finance_manager' ? 'Finance manager (over 10,000)' : 'Any operations team member'}</dd>
            {o.flags?.length > 0 && (<><dt>Flags</dt><dd className="row">{o.flags.map((f: string) => <span key={f} className="badge amber">{humanize(f)}</span>)}</dd></>)}
            <PolicyRefs refs={o.policy_refs} />
          </dl>
        </>
      )}

      {o.decision === 'request_missing_info' && (
        <>
          <div className="notice amber"><strong>Waiting for the vendor</strong> to supply missing or incorrect information.</div>
          <div>
            <h3>Fields requested</h3>
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {(o.missing_fields ?? []).map((f: { field: string; issue: string }, i: number) => (
                <li key={i}><code>{f.field}</code>: {f.issue}</li>
              ))}
            </ul>
          </div>
          {o.email && (
            <div className="email">
              <div className="email-head">
                <div><span className="muted">To:</span> {o.email.to} <span className="badge" style={{ marginLeft: 6 }}>Drafted, not sent</span></div>
                <div><span className="muted">Subject:</span> {o.email.subject}</div>
              </div>
              <div className="email-body">{o.email.body}</div>
            </div>
          )}
        </>
      )}

      {o.decision === 'escalate_to_human' && (
        <>
          <div className="notice red"><strong>Escalated: {categoryLabel(o.category)}</strong></div>
          <p style={{ margin: 0 }}>{o.reason}</p>
          <dl className="kv"><PolicyRefs refs={o.policy_refs} /></dl>
        </>
      )}

      {Array.isArray(o.blockers_at_decision) && (
        <div>
          <h3>Policy checks at decision time</h3>
          {o.blockers_at_decision.length === 0 ? (
            <div className="notice green">All coded policy checks passed.</div>
          ) : (
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {o.blockers_at_decision.map((b: { code: string; message: string; policy: string }, i: number) => (
                <li key={i}><span className="badge red" style={{ marginRight: 6 }}>Policy {b.policy}</span>{b.message}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      {o.resolution && <Resolution r={o.resolution} detail={detail} />}
    </div>
  );
}

function PolicyRefs({ refs }: { refs?: string[] }) {
  if (!refs?.length) return null;
  return (<><dt>Policies cited</dt><dd className="row">{refs.map((r) => <span key={r} className="badge outline">Policy {r}</span>)}</dd></>);
}

function Resolution({ r, detail }: { r: Outcome; detail: CaseDetail }) {
  const payment = detail.payments[0];
  if (r.type === 'paid') {
    return (
      <div className="notice green">
        <strong>Paid (simulated)</strong>: {money(r.amount, r.currency)} · reference <code>{r.payment_reference}</code> · approved by {r.approved_by}
        {payment && <> · {date(payment.executed_at)}</>}
      </div>
    );
  }
  if (r.type === 'rejected_by_approver') {
    return <div className="notice red"><strong>Rejected by {r.decided_by}</strong>: {r.reason}</div>;
  }
  return <div className="notice red"><strong>Payment blocked</strong>: {r.reason}</div>;
}
