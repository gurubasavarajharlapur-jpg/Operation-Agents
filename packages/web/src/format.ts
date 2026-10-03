export function money(amount: string | number | null | undefined, currency: string | null | undefined): string {
  if (amount === null || amount === undefined || amount === '') return '—';
  const n = Number(amount);
  if (!Number.isFinite(n)) return '—';
  try {
    return new Intl.NumberFormat('en-GB', { style: 'currency', currency: currency ?? 'GBP' }).format(n);
  } catch {
    return `${n.toFixed(2)} ${currency ?? ''}`.trim(); // invalid currency code on an untrusted invoice
  }
}

export const usd = (n: number) => (n === 0 ? '$0' : n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(3)}`);

export function date(value: string | null | undefined): string {
  if (!value) return '—';
  const d = new Date(value.length === 10 ? `${value}T00:00:00Z` : value);
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

export function time(value: string): string {
  return new Date(value).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function relative(value: string): string {
  const seconds = Math.round((Date.now() - new Date(value).getTime()) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} h ago`;
  return date(value);
}

export const isOverdue = (due: string | null, state: string) =>
  Boolean(due) && due! < new Date().toISOString().slice(0, 10) && !['completed', 'failed'].includes(state);

export const humanize = (s: string) => s.replaceAll('_', ' ').replace(/^./, (c) => c.toUpperCase());
export const shortHash = (h: string | null) => (h ? h.slice(0, 8) : 'genesis');

const CATEGORY_LABELS: Record<string, string> = {
  unknown_vendor: 'Unknown vendor',
  vendor_not_active: 'Vendor not active',
  vendor_mismatch: 'Vendor name mismatch',
  po_mismatch: 'PO mismatch',
  suspected_duplicate: 'Suspected duplicate',
  over_approval_limit: 'Over approval limit',
  suspicious_content: 'Suspicious content',
  agent_failure: 'Agent could not decide',
  rejected_by_approver: 'Rejected by approver',
  approval_mismatch: 'Approval no longer matches invoice',
  other: 'Other',
};
export const categoryLabel = (c: string | null | undefined) => (c ? CATEGORY_LABELS[c] ?? humanize(c) : 'Other');
