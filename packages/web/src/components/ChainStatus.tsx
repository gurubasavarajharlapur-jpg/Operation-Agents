import { useApi } from '../useApi.ts';
import type { ChainStatus as Chain } from '../types.ts';

/** Header pill: recomputes the whole audit hash chain on the server every 15 seconds. */
export function ChainStatus() {
  const { data, error } = useApi<Chain>('/audit/verify', 15_000);
  if (error) return <span className="badge red">Audit check failed</span>;
  if (!data) return <span className="badge">Checking audit chain…</span>;
  return data.intact ? (
    <span className="badge green" title={`Head hash ${data.head_hash ?? '—'}`} data-testid="chain-status">
      <span className="dot" />
      Audit chain intact · {data.events_checked.toLocaleString()} events
    </span>
  ) : (
    <span className="badge red" title={data.broken_at?.reason} data-testid="chain-status">
      <span className="dot" />
      Audit chain BROKEN at event {data.broken_at?.id}
    </span>
  );
}
