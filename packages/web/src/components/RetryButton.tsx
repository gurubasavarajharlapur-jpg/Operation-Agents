import { useState } from 'react';
import { api, ApiError } from '../api.ts';

/** Manual retry for a failed case: re-runs the step that failed with a fresh set of attempts. */
export function RetryButton({ caseId, onDone }: { caseId: string; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function retry() {
    setBusy(true);
    setError(null);
    try {
      await api(`/cases/${caseId}/retry`, { method: 'POST' });
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not retry');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="row">
      <button className="btn primary" disabled={busy} onClick={retry}>Retry</button>
      {error && <span className="error-text">{error}</span>}
    </div>
  );
}
