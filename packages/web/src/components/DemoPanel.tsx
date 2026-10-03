import { useState } from 'react';
import { api, ApiError } from '../api.ts';
import type { DemoInfo } from '../demo.ts';

/** Demo only: send a sample invoice through the real webhook and watch the agent handle it. */
export function DemoPanel({ demo }: { demo: DemoInfo }) {
  const [scenario, setScenario] = useState(demo.scenarios[0]?.id ?? 'happy');
  const [failure, setFailure] = useState('none');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'green' | 'red'; text: string } | null>(null);
  const selected = demo.scenarios.find((s) => s.id === scenario);

  async function send() {
    setBusy(true);
    setMessage(null);
    try {
      await api('/demo/invoices', { method: 'POST', body: { scenario, failure } });
      setMessage({
        tone: 'green',
        text: failure === 'none'
          ? 'Sent. Watch it appear below and move through the states.'
          : failure === 'recovers'
            ? 'Sent with a simulated outage. Watch two attempts fail and retry with backoff (about 5s, then 10s), then the normal decision.'
            : 'Sent with a permanent outage. All 4 attempts will fail (about 35 to 45 seconds), then the case becomes Failed. Open it and click Retry.',
      });
    } catch (err) {
      setMessage({ tone: 'red', text: err instanceof ApiError ? err.message : 'Could not send.' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card card-body" style={{ marginBottom: 16 }} data-testid="demo-panel">
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-end' }}>
        <div className="stack" style={{ gap: 6, flex: 1, minWidth: 260 }}>
          <label className="label" htmlFor="scenario" style={{ margin: 0 }}>Send a sample invoice</label>
          <div className="row">
            <select id="scenario" className="input" style={{ maxWidth: 280 }} value={scenario} onChange={(e) => setScenario(e.target.value)}>
              {demo.scenarios.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
            </select>
            {demo.fault_injection && (
              <select aria-label="Simulate a failure" className="input" style={{ maxWidth: 260 }} value={failure} onChange={(e) => setFailure(e.target.value)}>
                <option value="none">No failure</option>
                <option value="recovers">Agent outage, recovers</option>
                <option value="never_recovers">Agent outage, never recovers</option>
              </select>
            )}
            <button className="btn primary" disabled={busy} onClick={send}>Send invoice</button>
          </div>
          {selected && <div className="muted" style={{ fontSize: 13 }}>Expected: {selected.expect}</div>}
        </div>
      </div>
      {message && <div className={`notice ${message.tone}`} style={{ marginTop: 10 }}>{message.text}</div>}
    </div>
  );
}
