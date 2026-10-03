import { humanize, shortHash, time, usd } from '../format.ts';
import type { AuditEvent } from '../types.ts';

const ICON = { agent: '🤖', human: '👤', system: '⚙︎' } as const;

/** Turns an audit event into a readable title and one-line summary. */
function describe(e: AuditEvent): { title: string; text?: string; refused?: boolean } {
  const input = (e.input ?? {}) as Record<string, any>;
  const output = (e.output ?? {}) as Record<string, any>;
  const [kind, ...rest] = e.action.split('.');
  const name = rest.join('.');

  switch (kind) {
    case 'case':
      return { title: 'Invoice received', text: `Idempotency key ${input.idempotency_key}` };
    case 'webhook':
      return { title: name === 'duplicate_ignored' ? 'Duplicate submission ignored' : 'Same key, different payload: rejected (409)' };
    case 'agent':
      return { title: name === 'restarted' ? 'Agent restarted after a failed attempt' : 'Agent started', text: input.mode === 'llm' ? `Claude agent · ${input.model}` : 'Rules-only engine (no LLM)' };
    case 'rules':
      return { title: 'Rules evaluated', text: `Chose ${humanize(output.chosen ?? '')}` };
    case 'llm': {
      const calls = (output.tool_calls ?? []).map((t: { name: string }) => t.name).join(', ');
      const text = [output.text, calls && `→ calls ${calls}`].filter(Boolean).join('\n');
      return { title: `Claude, turn ${input.turn}`, text: text || `stop: ${output.stop_reason}` };
    }
    case 'tool':
      return { title: `Tool: ${name}`, text: toolSummary(name, output) };
    case 'guardrail':
      return { title: `Guardrail refused ${name.replace('refused.', '')}`, text: output.error, refused: true };
    case 'decision':
      return { title: `Decision: ${humanize(name)}`, text: input.reason ?? input.summary ?? (input.fields ? `Fields: ${input.fields.join(', ')}` : undefined) };
    case 'state':
      return { title: `State: ${humanize(input.from)} → ${humanize(input.to)}` };
    case 'approval':
      return { title: `${name === 'approved' ? 'Approved' : 'Rejected'} by ${output.operator?.name}`, text: input.note ?? undefined };
    case 'payment':
      return { title: 'Payment executed (simulated)', text: `${output.amount} ${output.currency} · ${output.reference}` };
    case 'job':
      return { title: 'Job skipped', text: output.reason };
    default:
      return { title: e.action };
  }
}

function toolSummary(name: string, o: Record<string, any>): string | undefined {
  if (name === 'validate_invoice') return o.valid ? 'Invoice is complete and consistent' : `Problems: ${(o.issues ?? []).map((i: any) => `${i.field} (${i.issue})`).join('; ')}`;
  if (name === 'lookup_vendor') return o.found ? `${o.vendor.name}: ${o.vendor.status}` : 'Not in the vendor register';
  if (name === 'match_purchase_order') return o.matched ? `Matches ${o.po_number} (difference ${o.amount_difference})` : (o.problems ?? []).join('; ');
  if (name === 'search_policy') return (o.results ?? []).map((r: any) => r.source_file).join(', ') || 'No results';
  if (o.accepted) return `Accepted → ${humanize(o.new_state)}`;
  return undefined;
}

export function AuditTimeline({ events }: { events: AuditEvent[] }) {
  if (events.length === 0) return <div className="empty">No events yet.</div>;
  return (
    <ol className="timeline" data-testid="timeline">
      {events.map((e) => {
        const d = describe(e);
        return (
          <li key={e.id} className={`event ${d.refused ? 'refused' : ''}`} data-action={e.action}>
            <div className={`event-icon ${e.actor}`} title={e.actor}>{d.refused ? '⛔' : ICON[e.actor]}</div>
            <div style={{ minWidth: 0 }}>
              <div className="event-title">{d.title}</div>
              {d.text && <div className="event-text">{d.text}</div>}
              <details>
                <summary>Details · <span className="hashlink">#{shortHash(e.hash)} ← #{shortHash(e.prev_hash)}</span></summary>
                <pre className="json">{JSON.stringify({ actor: e.actor, action: e.action, input: e.input, output: e.output }, null, 2)}</pre>
              </details>
            </div>
            <div className="event-meta">
              <div>{time(e.created_at)}</div>
              {e.tokens != null && <div className="num">{e.tokens.toLocaleString()} tok · {usd(e.cost_usd ?? 0)}</div>}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
