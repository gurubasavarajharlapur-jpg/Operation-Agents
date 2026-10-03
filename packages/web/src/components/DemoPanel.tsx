import { useState } from 'react';
import { api, ApiError } from '../api.ts';
import type { DemoInfo } from '../demo.ts';

/** Demo only: send a sample invoice through the real webhook and watch the agent handle it. */
export function DemoPanel({ demo }: { demo: DemoInfo }) {
  const [scenario, setScenario] = useState(demo.scenarios[0]?.id ?? 'happy');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'green' | 'red'; text: string } | null>(null);
  const selected = demo.scenarios.find((s) => s.id === scenario);

  async function send() {
    setBusy(true);
    setMessage(null);
    try {
      await api('/demo/invoices', { method: 'POST', body: { scenario } });
      setMessage({ tone: 'green', text: 'Sent. Watch it appear below and move through the states.' });
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
            <button className="btn primary" disabled={busy} onClick={send}>Send invoice</button>
          </div>
          {selected && <div className="muted" style={{ fontSize: 13 }}>Expected: {selected.expect}</div>}
        </div>
      </div>
      {message && <div className={`notice ${message.tone}`} style={{ marginTop: 10 }}>{message.text}</div>}
    </div>
  );
}
