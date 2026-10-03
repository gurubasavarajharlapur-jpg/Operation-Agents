import { useState, type FormEvent } from 'react';
import { ApiError } from '../api.ts';
import { useAuth } from '../auth.tsx';

export function SignIn() {
  const { signIn } = useAuth();
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
        <div>
          <label className="label" htmlFor="token">Operator token</label>
          <input id="token" className="input mono" type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder="op_…" autoFocus />
        </div>
        {error && <div className="error-text">{error}</div>}
        <button className="btn primary" disabled={busy || !token.trim()}>Sign in</button>
        <div className="notice">
          Tokens are printed by <code>npm run db:seed</code> and saved in <code>.operator-tokens.json</code>. Each one belongs to a named operator, whose name is recorded on every approval.
        </div>
      </form>
    </div>
  );
}
