import { Link, useNavigate } from 'react-router';
import { CASE_STATES, type CaseState } from '@oa/shared';
import { useApi } from '../useApi.ts';
import { categoryLabel, money, usd } from '../format.ts';
import type { ChainStatus, MoneyByCurrency, Overview } from '../types.ts';
import { useDemo } from '../demo.ts';

const STATE_LABEL: Record<CaseState, string> = {
  received: 'Received', validating: 'Agent working', needs_info: 'Needs info', awaiting_approval: 'Awaiting approval',
  escalated: 'Escalated', completed: 'Completed', failed: 'Failed',
};
// State colour always sits next to its label, never alone.
const STATE_TONE: Record<CaseState, string> = {
  received: 'blue', validating: 'blue', needs_info: 'amber', awaiting_approval: 'amber', escalated: 'red', completed: 'green', failed: 'red',
};

/** Amounts per currency, never added across currencies. */
const perCurrency = (rows: MoneyByCurrency[]) => (rows.length ? rows.map((r) => money(r.amount, r.currency)).join(' · ') : '—');

export function OverviewPage() {
  const { data, error } = useApi<Overview>('/overview', 10_000);
  const { data: chain } = useApi<ChainStatus>('/audit/verify', 30_000);
  const navigate = useNavigate();
  const demo = useDemo();

  if (error) return <div className="page"><div className="notice red">{error.message}</div></div>;
  if (!data) return <div className="page muted">Loading…</div>;

  const a = data.attention;
  const maxState = Math.max(1, ...Object.values(data.by_state));
  const maxCat = Math.max(1, ...data.escalation_categories.map((c) => c.n));
  const attentionRows = [
    { key: 'failed', icon: '⚠︎', label: 'Failed after all retries', n: a.failed, to: '/cases?attention=failed' },
    { key: 'overdue', icon: '⏰', label: 'Overdue and not yet paid', n: a.overdue, to: '/cases?attention=overdue' },
    { key: 'stale', icon: '⌛', label: 'Waiting for approval over 24h', n: a.stale, to: '/cases?attention=stale' },
    { key: 'escalated', icon: '↑', label: 'Escalated, open for a human', n: a.open_escalations, to: '/cases?state=escalated' },
  ];

  return (
    <div className="page stack" data-testid="overview">
      <div className="page-header" style={{ marginBottom: 0 }}>
        <div>
          <h1>Overview</h1>
          <p>What the agent is doing, what it costs, and what needs a person. Updates every 10 seconds.</p>
        </div>
      </div>

      {demo?.enabled && (
        <div className="notice" data-testid="demo-hint">
          <strong>Try it:</strong> go to <Link to="/cases">Cases</Link> and send a sample invoice (you can also simulate an outage). Then come back here and watch these numbers change.
        </div>
      )}

      <div className="tiles">
        <Link to="/cases" className="tile" data-testid="tile-cases">
          <div className="tile-label">Cases</div>
          <div className="tile-value num">{data.total.toLocaleString('en-GB')}</div>
          <div className="tile-sub">{data.claude.cases_by_mode.llm} by Claude · {data.claude.cases_by_mode.rules} rules-only</div>
        </Link>
        <Link to="/approvals" className="tile" data-testid="tile-approvals">
          <div className="tile-label">Awaiting approval</div>
          <div className="tile-value num">{data.awaiting_approval.count}</div>
          <div className="tile-sub num">{perCurrency(data.awaiting_approval.by_currency)}</div>
        </Link>
        <a href="#attention" className={`tile ${a.needs_attention ? 'tile-alert' : ''}`} data-testid="tile-attention">
          <div className="tile-label">Needs attention</div>
          <div className="tile-value num">{a.needs_attention}</div>
          <div className="tile-sub">{a.failed} failed · {a.overdue} overdue · {a.stale} waiting &gt;24h</div>
        </a>
        <div className="tile" data-testid="tile-claude">
          <div className="tile-label">Claude spend</div>
          <div className="tile-value num">{usd(data.claude.cost_usd)}</div>
          <div className="tile-sub num">
            {data.claude.calls ? `${usd(data.claude.cost_per_llm_case_usd)}/case · ${data.claude.tokens.toLocaleString('en-GB')} tokens` : 'No Claude calls yet (rules-only)'}
          </div>
        </div>
        <div className={`tile ${chain && !chain.intact ? 'tile-alert' : ''}`} data-testid="tile-chain">
          <div className="tile-label">Audit chain</div>
          <div className="tile-value" style={{ fontSize: 20 }}>{chain ? (chain.intact ? '✓ Intact' : '✗ Broken') : '…'}</div>
          <div className="tile-sub mono" title={chain?.head_hash ?? ''}>{chain ? `${chain.events_checked.toLocaleString('en-GB')} events · head ${chain.head_hash?.slice(0, 8) ?? '—'}` : ''}</div>
        </div>
      </div>

      <div className="grid-2 even">
        <section className="card card-body">
          <h2>Cases by state</h2>
          <ul className="barlist" data-testid="by-state">
            {CASE_STATES.map((s) => (
              <li key={s}>
                <button className="barlist-row" onClick={() => navigate(`/cases?state=${s}`)} title={`${STATE_LABEL[s]}: ${data.by_state[s]} cases`}>
                  <span className="barlist-label"><span className={`badge-dot ${STATE_TONE[s]}`} />{STATE_LABEL[s]}</span>
                  <span className="bar-track"><span className={`bar-fill ${STATE_TONE[s]}`} style={{ width: `${(data.by_state[s] / maxState) * 100}%` }} /></span>
                  <span className="barlist-value num">{data.by_state[s]}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>

        <section className="card card-body" id="attention">
          <h2>Needs attention</h2>
          <ul className="attention" data-testid="attention">
            {attentionRows.map((r) => (
              <li key={r.key}>
                <Link to={r.to} className={`attention-row ${r.n ? 'has' : ''}`}>
                  <span className="attention-icon" aria-hidden>{r.icon}</span>
                  <span>{r.label}</span>
                  <span className="num attention-n">{r.n}</span>
                </Link>
              </li>
            ))}
          </ul>
          <div className="faint" style={{ marginTop: 10, fontSize: 13 }}>
            {a.guardrail_refusals_7d
              ? `${a.guardrail_refusals_7d} guardrail refusal${a.guardrail_refusals_7d === 1 ? '' : 's'} in the last 7 days: the code blocked an action the agent attempted.`
              : 'No guardrail refusals in the last 7 days.'}
          </div>
        </section>

        <section className="card card-body">
          <h2>Why cases were escalated</h2>
          {data.escalation_categories.length === 0 ? (
            <div className="muted">No escalated cases.</div>
          ) : (
            <ul className="barlist" data-testid="categories">
              {data.escalation_categories.map((c) => (
                <li key={c.category}>
                  <button className="barlist-row" onClick={() => navigate(`/cases?category=${c.category}`)} title={`${categoryLabel(c.category)}: ${c.n} cases`}>
                    <span className="barlist-label">{categoryLabel(c.category)}</span>
                    <span className="bar-track"><span className="bar-fill accent" style={{ width: `${(c.n / maxCat) * 100}%` }} /></span>
                    <span className="barlist-value num">{c.n}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="card card-body">
          <h2>Money</h2>
          <table className="table money-table" data-testid="money">
            <tbody>
              <tr><td>Proposed by the agent</td><td className="right num">{perCurrency(data.money.proposed)}</td></tr>
              <tr><td>Approved by a person</td><td className="right num">{perCurrency(data.money.approved)}</td></tr>
              <tr><td>Paid (simulated)</td><td className="right num">{perCurrency(data.money.paid)}</td></tr>
              <tr><td>Rejected by a person</td><td className="right num">{perCurrency(data.money.rejected)}</td></tr>
              <tr><td>Escalated, not put forward</td><td className="right num">{perCurrency(data.money.blocked)}</td></tr>
            </tbody>
          </table>
          <div className="faint" style={{ marginTop: 10, fontSize: 13 }}>Totals are kept per currency and never added across currencies.</div>
        </section>
      </div>
    </div>
  );
}
