import { useState } from 'react';
import { api, ApiError } from '../api.ts';
import { useAuth } from '../auth.tsx';
import type { Approval } from '../types.ts';

/**
 * Approve / Reject for one pending approval. The button state reflects the operator's role,
 * but the server is what enforces it (and re-checks everything).
 */
export function ApprovalActions({ approval, onDone }: { approval: Approval; onDone: () => void }) {
  const { operator } = useAuth();
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const needsFinance = approval.required_role === 'finance_manager';
  const canApprove = !needsFinance || operator?.role === 'finance_manager';

  async function submit(action: 'approve' | 'reject') {
    setBusy(true);
    setError(null);
    try {
      await api(`/approvals/${approval.id}/${action}`, { method: 'POST', body: action === 'reject' ? { reason } : {} });
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  }

  if (rejecting) {
    return (
      <div className="stack" style={{ gap: 8, minWidth: 280 }}>
        <label className="label" htmlFor={`reason-${approval.id}`}>Why are you rejecting this payment?</label>
        <textarea
          id={`reason-${approval.id}`}
          className="textarea"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Recorded in the audit trail and shown on the case."
          autoFocus
        />
        <div className="row">
          <button className="btn danger solid" disabled={busy || !reason.trim()} onClick={() => submit('reject')}>Reject payment</button>
          <button className="btn ghost" disabled={busy} onClick={() => setRejecting(false)}>Cancel</button>
        </div>
        {error && <div className="error-text">{error}</div>}
      </div>
    );
  }

  return (
    <div className="stack" style={{ gap: 8, alignItems: 'flex-end' }}>
      <div className="row">
        <button className="btn danger" disabled={busy} onClick={() => setRejecting(true)}>Reject</button>
        <button
          className="btn primary"
          disabled={busy || !canApprove}
          title={canApprove ? 'Approve this payment' : 'Over 10,000: a finance manager must approve (policy 04)'}
          onClick={() => submit('approve')}
        >
          Approve payment
        </button>
      </div>
      {!canApprove && <span className="faint" style={{ fontSize: 12 }}>Needs a finance manager (policy 04)</span>}
      {error && <div className="error-text">{error}</div>}
    </div>
  );
}
