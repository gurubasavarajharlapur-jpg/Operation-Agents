import { useState, type FormEvent } from 'react';
import { ApiError } from '../api.ts';
import { useAuth } from '../auth.tsx';
import { useDemo } from '../demo.ts';

export function SignIn() {
  const { signIn, demoSignIn } = useAuth();
  const demo = useDemo();
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await signIn(token.trim());
    } catch (err) {
      setError(err instanceof ApiError && err.status === 401 ? 'That token is not valid for an active operator.' : 'Could not reach the API. Is it running?');
    } finally {
      setBusy(false);
    }
  }

  async function tryDemo(role: 'operations' | 'finance_manager') {
    setBusy(true);
    setError(null);
    try {
      await demoSignIn(role);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not reach the API.');
      setBusy(false);
    }
  }

  return (
    <div className="signin">
      <form className="card card-body stack" onSubmit={submit}>
        <div className="row" style={{ gap: 10 }}>
          <span className="brand-mark">OA</span>
          <div>
            <h1 style={{ fontSize: 18 }}>Operation Agents</h1>
            <div className="muted">Invoice operations, with a human in charge of every payment.</div>
          </div>
        </div>
        {demo?.enabled && (
          <div className="stack" style={{ gap: 8 }}>
            <div className="notice">
              This is a public demo. Invoices are samples and <strong>payments are simulated</strong>. Pick a role to try it:
            </div>
            <button type="button" className="btn primary" disabled={busy} onClick={() => tryDemo('operations')}>
              Try as an operations reviewer
            </button>
            <button type="button" className="btn" disabled={busy} onClick={() => tryDemo('finance_manager')}>
              Try as a finance manager (can approve over 10,000)
            </button>
            <div className="faint" style={{ textAlign: 'center', fontSize: 12 }}>or sign in with an operator token</div>
          </div>
        )}
        <div>
          <label className="label" htmlFor="token">Operator token</label>
          <input id="token" className="input mono" type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder="op_…" autoFocus={!demo?.enabled} />
        </div>
        {error && <div className="error-text">{error}</div>}
        <button className={`btn ${demo?.enabled ? '' : 'primary'}`} disabled={busy || !token.trim()}>Sign in</button>
        <div className="notice">
          Tokens are printed by <code>npm run db:seed</code> and saved in <code>.operator-tokens.json</code>. Each one belongs to a named operator, whose name is recorded on every approval.
        </div>
      </form>
    </div>
  );
}
