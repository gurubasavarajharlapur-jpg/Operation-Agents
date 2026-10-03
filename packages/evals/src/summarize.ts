// Turns per-case rows into the numbers in RESULTS.md. Recomputed from raw rows every time.
import { METRICS } from './grade.ts';
import type { Grade } from './types.ts';

export interface ResultRow {
  prompt_id: string;
  tags: string[];
  rep: number;
  expected: string;
  got: string;
  grade: Grade;
  detail: string; // category / reason / fields, for reading failures
  end_reason: string;
  latency_s: number;
  turns: number;
  tokens: number;
  cost_usd: number;
  guardrail_refusals: number;
  model: string | null; // the model that actually served the calls (null for rules)
}

export interface Summary {
  variant: string;
  model: string | null;
  generated_at: string;
  cases: number;
  reps: number;
  rows: number;
  errors: number;
  decision_accuracy: { mean: number; ci95: [number, number] };
  by_group: Record<string, { correct: number; total: number }>;
  escalation: { precision: number | null; recall: number | null; specificity: number | null };
  metrics: Record<string, { mean: number | null; n: number }>;
  majority_baseline: number;
  safety: { unapproved_payments: number; approved_approvals: number };
  perf: { mean_latency_s: number; mean_turns: number; mean_tokens: number; mean_cost_usd: number; total_cost_usd: number; guardrail_refusals: number };
  failures: { id: string; wrong: number; reps: number; expected: string; got: string[]; detail: string[] }[];
}

/** Wilson score interval: honest bounds for a proportion even at small n or near 0% / 100%. */
export function wilson(successes: number, n: number, z = 1.96): [number, number] {
  if (n === 0) return [0, 0];
  const p = successes / n;
  const denom = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return [Math.max(0, centre - half), Math.min(1, centre + half)];
}

const ratio = (a: number, b: number) => (b === 0 ? null : a / b);

export function summarize(
  variant: string,
  rows: ResultRow[],
  meta: { cases: number; reps: number; errors: number; safety: Summary['safety'] },
): Summary {
  const correct = rows.filter((r) => r.grade.decision_correct === 1).length;

  const by_group: Summary['by_group'] = {};
  for (const r of rows) {
    const g = (by_group[r.tags[0]] ??= { correct: 0, total: 0 });
    g.total++;
    if (r.grade.decision_correct === 1) g.correct++;
  }

  // Escalation as a classifier: positives are the cases labelled "escalate".
  let tp = 0, fp = 0, fn = 0, tn = 0;
  for (const r of rows) {
    const label = r.expected === 'escalate_to_human';
    const pred = r.got === 'escalate_to_human';
    if (label && pred) tp++;
    else if (!label && pred) fp++;
    else if (label && !pred) fn++;
    else tn++;
  }

  const metrics: Summary['metrics'] = {};
  for (const m of METRICS) {
    const vals = rows.map((r) => r.grade[m.id]).filter((v): v is number => v !== null && v !== undefined);
    metrics[m.id] = { mean: vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null, n: vals.length };
  }

  const counts = new Map<string, number>();
  for (const r of rows.filter((r) => r.rep === 0)) counts.set(r.expected, (counts.get(r.expected) ?? 0) + 1);
  const firstRep = rows.filter((r) => r.rep === 0).length || 1;

  const byCase = new Map<string, ResultRow[]>();
  for (const r of rows) byCase.set(r.prompt_id, [...(byCase.get(r.prompt_id) ?? []), r]);
  const failures = [...byCase.entries()]
    .map(([id, rs]) => ({
      id,
      wrong: rs.filter((r) => r.grade.decision_correct !== 1 || Object.entries(r.grade).some(([k, v]) => k !== 'unapproved_payment' && v === 0)).length,
      reps: rs.length,
      expected: rs[0].expected,
      got: rs.map((r) => r.got),
      detail: rs.map((r) => r.detail),
    }))
    .filter((f) => f.wrong > 0)
    .sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));

  const mean = (f: (r: ResultRow) => number) => (rows.length ? rows.reduce((a, r) => a + f(r), 0) / rows.length : 0);
  const models = [...new Set(rows.map((r) => r.model).filter(Boolean))];

  return {
    variant,
    model: models.join(', ') || null,
    generated_at: new Date().toISOString(),
    cases: meta.cases,
    reps: meta.reps,
    rows: rows.length,
    errors: meta.errors,
    decision_accuracy: { mean: rows.length ? correct / rows.length : 0, ci95: wilson(correct, rows.length) },
    by_group,
    escalation: { precision: ratio(tp, tp + fp), recall: ratio(tp, tp + fn), specificity: ratio(tn, tn + fp) },
    metrics,
    majority_baseline: Math.max(...counts.values()) / firstRep,
    safety: meta.safety,
    perf: {
      mean_latency_s: mean((r) => r.latency_s),
      mean_turns: mean((r) => r.turns),
      mean_tokens: mean((r) => r.tokens),
      mean_cost_usd: mean((r) => r.cost_usd),
      total_cost_usd: rows.reduce((a, r) => a + r.cost_usd, 0),
      guardrail_refusals: rows.reduce((a, r) => a + r.guardrail_refusals, 0),
    },
    failures,
  };
}
