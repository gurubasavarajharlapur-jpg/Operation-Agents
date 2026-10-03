// The eval runner.
//   npm run eval -- --variant rules                                       (free)
//   npm run eval -- --variant oracle | null                               (sanity checks, free)
//   npm run eval -- --variant claude --model claude-opus-5-5 --reps 3     (needs ANTHROPIC_API_KEY)
// Options: --reps N, --concurrency N, --effort low|medium|high, --timeout-s N, --cases A1-clean,B1-missing-po, --check
//
// Each run: fresh eval database (migrated + seeded) -> every case through the real signed webhook and
// the real worker code (as the restricted ops_worker user) -> graded from the database end state.
// Writes runs/<variant>/{results.jsonl, errors.jsonl, summary.json, traces/} and regenerates RESULTS.md.
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import Anthropic from '@anthropic-ai/sdk';
import pg from 'pg';
import { buildServer, signBody } from '@oa/api';
import { startQueue, workerDatabaseUrl } from '@oa/db';
import { processCase, SYSTEM_PROMPT, type CreateMessage } from '@oa/worker';
import { gradeCase, observedDecision } from './grade.ts';
import { writeResultsMarkdown } from './report.ts';
import { summarize, type ResultRow } from './summarize.ts';
import type { EvalCase, Observed } from './types.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = path.resolve(ROOT, '../..');
try {
  process.loadEnvFile(path.join(REPO, '.env'));
} catch {
  // no .env
}

const { values: args } = parseArgs({
  options: {
    variant: { type: 'string', default: 'rules' },
    model: { type: 'string', default: 'claude-opus-5-5' },
    effort: { type: 'string', default: 'medium' },
    reps: { type: 'string' },
    concurrency: { type: 'string' },
    'timeout-s': { type: 'string', default: '300' },
    cases: { type: 'string' },
    check: { type: 'boolean', default: false },
  },
});

const variant = args.variant!;
if (!['rules', 'oracle', 'null', 'claude'].includes(variant)) throw new Error(`unknown variant ${variant}`);
const isClaude = variant === 'claude';
const reps = Number(args.reps ?? (isClaude ? 3 : 1));
const concurrency = Number(args.concurrency ?? (isClaude ? 4 : 8));
const timeoutMs = Number(args['timeout-s']) * 1000;
const variantName = isClaude ? args.model! : variant;

const file = JSON.parse(await fs.readFile(path.join(ROOT, 'cases.json'), 'utf8')) as { today: string; cases: EvalCase[] };
const TODAY = file.today;
const only = args.cases?.split(',');
const cases = only ? file.cases.filter((c) => only.includes(c.id)) : file.cases;

// ---- fresh, isolated eval database -----------------------------------------------------
const adminUrl = process.env.DATABASE_URL ?? 'postgres://ops:ops@localhost:5432/operation_agents';
const evalUrl = withDb(adminUrl, 'operation_agents_eval');
const evalWorkerUrl = withDb(workerDatabaseUrl(), 'operation_agents_eval');

function withDb(url: string, db: string) {
  const u = new URL(url);
  u.pathname = `/${db}`;
  return u.toString();
}

async function resetEvalDatabase() {
  const admin = new pg.Client({ connectionString: withDb(adminUrl, 'postgres') });
  await admin.connect();
  await admin.query('DROP DATABASE IF EXISTS operation_agents_eval WITH (FORCE)');
  await admin.query('CREATE DATABASE operation_agents_eval');
  await admin.end();
  const env = { ...process.env, DATABASE_URL: evalUrl, WORKER_DATABASE_URL: evalWorkerUrl, OPERATOR_TOKENS_FILE: 'off' };
  for (const script of ['packages/db/src/migrate.ts', 'packages/db/src/seed.ts']) {
    execFileSync('npx', ['tsx', script], { cwd: REPO, env, stdio: 'pipe' });
  }
}

// ---- how each variant "thinks" ---------------------------------------------------------
class ServedModelMismatch extends Error {}

function claudeClient(model: string): CreateMessage {
  const client = new Anthropic();
  // No server-side fallback here: an eval must measure the model it asked for, so a response
  // served by any other model fails the attempt loudly instead of being scored.
  return async (params) => {
    const res = await client.beta.messages.create(params);
    if (!res.model.startsWith(model)) throw new ServedModelMismatch(`asked for ${model}, served by ${res.model}`);
    return res;
  };
}

/** A scripted "model" that always makes the labelled decision: checks labels, guardrails and grader. */
function oracleClient(c: EvalCase): CreateMessage {
  const e = c.expected;
  const input =
    e.decision === 'propose_payment'
      ? { summary: 'Oracle: matches the label.', policy_refs: e.policy_any ?? [] }
      : e.decision === 'request_missing_info'
        ? { fields: e.fields ?? [], email_subject: 'Information needed', email_body: `Please send: ${(e.fields ?? []).join(', ')}.` }
        : { category: e.category_any?.[0] ?? 'other', reason: 'Oracle: matches the label.', policy_refs: e.policy_any ?? [] };
  return async () =>
    ({
      id: 'oracle', type: 'message', role: 'assistant', model: 'oracle', stop_reason: 'tool_use', stop_sequence: null, stop_details: null,
      content: [{ type: 'tool_use', id: `toolu_${crypto.randomUUID()}`, name: e.decision, input }],
      usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    }) as unknown as Anthropic.Beta.BetaMessage;
}

/** A scripted "model" that never decides anything. */
const nullClient: CreateMessage = async () =>
  ({
    id: 'null', type: 'message', role: 'assistant', model: 'null', stop_reason: 'end_turn', stop_sequence: null, stop_details: null,
    content: [{ type: 'text', text: 'I have no opinion.', citations: null }],
    usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  }) as unknown as Anthropic.Beta.BetaMessage;

// ---- one case ----------------------------------------------------------------------------
/** A hard per-case wall-clock ceiling. The timer is cleared when the case finishes, so it never keeps the process alive. */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const ceiling = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timeout after ${ms / 1000}s`)), ms);
  });
  return Promise.race([p, ceiling]).finally(() => clearTimeout(timer));
}

const repInvoice = (inv: Record<string, unknown>, rep: number) =>
  // A per-rep invoice number, so reps never look like duplicates of each other.
  typeof inv.invoice_number === 'string' ? { ...inv, invoice_number: `${inv.invoice_number}-R${rep}` } : { ...inv };

await resetEvalDatabase();
const pool = new pg.Pool({ connectionString: evalUrl, max: 10 });
const workerPool = new pg.Pool({ connectionString: evalWorkerUrl, max: 10 });
const boss = await startQueue(evalUrl, 'worker'); // jobs are queued by the webhook but never consumed: the runner calls the worker code directly
const app = buildServer({ pool, boss, webhookSecret: 'eval-secret', logger: false });
await app.ready();
const sharedClaude = isClaude ? claudeClient(args.model!) : null;

async function send(invoice: Record<string, unknown>): Promise<string> {
  const body = JSON.stringify(invoice);
  const res = await app.inject({
    method: 'POST', url: '/webhooks/invoice', payload: body,
    headers: { 'content-type': 'application/json', 'idempotency-key': `eval-${crypto.randomUUID()}`, 'x-signature': signBody(body, 'eval-secret') },
  });
  if (res.statusCode !== 202) throw new Error(`webhook returned ${res.statusCode}: ${res.body}`);
  return res.json().case_id;
}

async function runOne(c: EvalCase, rep: number): Promise<{ row: ResultRow; trace: unknown[] }> {
  if (c.setup?.prior_invoice) await send(repInvoice(c.setup.prior_invoice, rep));
  const caseId = await send(repInvoice(c.invoice, rep));

  const createMessage = isClaude ? sharedClaude! : variant === 'oracle' ? oracleClient(c) : variant === 'null' ? nullClient : undefined;
  const started = performance.now();
  const result = await withTimeout(
    processCase(
      { pool: workerPool, mode: variant === 'rules' ? 'rules' : 'llm', createMessage, model: args.model!, effort: args.effort as 'medium', maxTurns: 8, today: TODAY },
      caseId,
    ),
    timeoutMs,
  );
  const latency = (performance.now() - started) / 1000;

  const cRow = (await pool.query('SELECT state, outcome FROM cases WHERE id = $1', [caseId])).rows[0];
  const observed: Observed = {
    state: cRow.state,
    outcome: cRow.outcome,
    approvals: (await pool.query('SELECT status FROM approvals WHERE case_id = $1', [caseId])).rows,
    payments: (await pool.query('SELECT count(*)::int AS n FROM payments WHERE case_id = $1', [caseId])).rows[0].n,
  };
  const events = (await pool.query('SELECT actor, action, input, output, tokens, cost_usd::float AS cost FROM audit_events WHERE case_id = $1 ORDER BY id', [caseId])).rows;
  const llmCalls = events.filter((e) => e.action === 'llm.call');
  const o = observed.outcome ?? {};

  const row: ResultRow = {
    prompt_id: c.id,
    tags: c.tags,
    rep,
    expected: c.expected.decision,
    got: observedDecision(observed),
    grade: gradeCase(c, observed),
    detail: o.category ?? (o.missing_fields ? o.missing_fields.map((f: { field: string }) => f.field).join('+') : o.required_role ?? ''),
    end_reason: result.status === 'processed' ? result.endReason : result.status,
    latency_s: Number(latency.toFixed(3)),
    turns: llmCalls.length,
    tokens: llmCalls.reduce((a, e) => a + (e.tokens ?? 0), 0),
    cost_usd: llmCalls.reduce((a, e) => a + (e.cost ?? 0), 0),
    guardrail_refusals: events.filter((e) => e.action.startsWith('guardrail.refused')).length,
    model: isClaude ? ([...new Set(llmCalls.map((e) => e.output?.served_by))].join(',') || null) : null,
  };

  // The trace: the case's audit trail as a conversation (system prompt and invoice first for Claude).
  const trace: unknown[] = isClaude ? [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: JSON.stringify(c.invoice, null, 2) }] : [];
  for (const e of events) {
    if (e.action === 'llm.call') {
      if (e.output?.text) trace.push({ role: 'assistant', content: e.output.text });
    } else if (e.action.startsWith('tool.') || e.action.startsWith('guardrail.')) {
      trace.push({ role: 'tool_call', name: e.action.replace(/^(tool|guardrail\.refused)\./, ''), content: JSON.stringify(e.input, null, 2) });
      trace.push({ role: 'tool_result', content: JSON.stringify(e.output) });
    } else {
      trace.push({ role: 'system', content: `[${e.actor}] ${e.action} ${JSON.stringify(e.output ?? e.input ?? {})}` });
    }
  }
  return { row, trace };
}

// ---- run everything ------------------------------------------------------------------------
const outDir = path.join(ROOT, 'runs', variantName);
await fs.rm(outDir, { recursive: true, force: true });
await fs.mkdir(path.join(outDir, 'traces'), { recursive: true });
const rows: ResultRow[] = [];
let errors = 0;

const jobs = cases.flatMap((c) => Array.from({ length: reps }, (_, rep) => ({ c, rep })));
const t0 = performance.now();
let next = 0;
async function lane() {
  while (next < jobs.length) {
    const { c, rep } = jobs[next++];
    try {
      const { row, trace } = await runOne(c, rep);
      rows.push(row);
      // Written as each case completes, so a crash keeps everything already finished.
      await fs.appendFile(path.join(outDir, 'results.jsonl'), JSON.stringify(row) + '\n');
      await fs.writeFile(path.join(outDir, 'traces', `${c.id}_rep${rep}.json`), JSON.stringify(trace, null, 2));
      process.stdout.write(row.grade.decision_correct ? '.' : 'x');
    } catch (err) {
      // Infrastructure failures are not model failures: they never enter results.jsonl.
      errors++;
      const failure_class = err instanceof ServedModelMismatch ? 'served_model_mismatch' : /timeout/.test(String(err)) ? 'timeout' : 'harness_or_api_error';
      await fs.appendFile(path.join(outDir, 'errors.jsonl'), JSON.stringify({ prompt_id: c.id, rep, failure_class, message: String(err) }) + '\n');
      process.stdout.write('E');
    }
  }
}
await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, lane));
process.stdout.write('\n');

// Run-level safety invariant: the eval never approves anything, so there must be no payment at all.
const safety = {
  unapproved_payments: (await pool.query('SELECT count(*)::int AS n FROM payments')).rows[0].n,
  approved_approvals: (await pool.query("SELECT count(*)::int AS n FROM approvals WHERE status = 'approved'")).rows[0].n,
};
rows.sort((a, b) => a.prompt_id.localeCompare(b.prompt_id, undefined, { numeric: true }) || a.rep - b.rep);
const summary = summarize(variantName, rows, { cases: cases.length, reps, errors, safety });
await fs.writeFile(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
if (!only) await writeResultsMarkdown(path.join(ROOT, 'runs'), path.join(ROOT, 'RESULTS.md'));

await app.close();
await boss.stop();
await pool.end();
await workerPool.end();

const a = summary.decision_accuracy;
console.log(
  `${variantName}: decision accuracy ${(a.mean * 100).toFixed(1)}% (95% CI ${(a.ci95[0] * 100).toFixed(1)}–${(a.ci95[1] * 100).toFixed(1)}%) ` +
    `on ${summary.rows} runs, ${errors} errors, unapproved payments ${safety.unapproved_payments}, ` +
    `cost $${summary.perf.total_cost_usd.toFixed(4)}, ${((performance.now() - t0) / 1000).toFixed(1)}s`,
);
for (const f of summary.failures) console.log(`  ${f.id}: expected ${f.expected}, got ${[...new Set(f.got)].join('/')} ${[...new Set(f.detail)].filter(Boolean).join('/')}`);

// --check: the regression gate CI uses.
if (args.check) {
  const problems: string[] = [];
  if (safety.unapproved_payments > 0) problems.push(`${safety.unapproved_payments} unapproved payment(s)`);
  if (errors > 0) problems.push(`${errors} harness error(s)`);
  if (variant === 'oracle' && summary.failures.length) problems.push('oracle is not 100%: a label, guardrail or the grader is wrong');
  if (variant === 'rules') {
    const ruleBased = rows.filter((r) => !r.tags[0].startsWith('D') || r.tags.includes('control'));
    const wrong = ruleBased.filter((r) => Object.entries(r.grade).some(([k, v]) => (k === 'unapproved_payment' ? v !== 0 : v === 0)));
    if (wrong.length) problems.push(`rules regressed on: ${[...new Set(wrong.map((r) => r.prompt_id))].join(', ')}`);
  }
  if (problems.length) {
    console.error(`EVAL CHECK FAILED: ${problems.join('; ')}`);
    process.exit(1);
  }
  console.log('eval check passed');
}
