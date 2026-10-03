# Proof of Work Build Plan: Invoice Operations Agent

Proof-of-work project for a job application to Red Rock Technology (Step 1: a link to something I personally built, plus 3 to 5 lines on what I built myself).

Red Rock builds custom AI agents that take over repetitive operational work, with a verifiable audit trail and human authorisation on anything with economic impact. This project is a small, honest version of that idea.

## What it does

A vendor invoice processing agent. Invoices arrive by webhook, go onto a queue, and an LLM agent works each case:

1. **Intake and validation:** checks the invoice is complete and consistent, and flags exactly which fields are missing.
2. **Verification:** looks up the vendor and matches the invoice against its purchase order.
3. **Decision:** resolves the case itself where it safely can, or escalates to a human.
4. **Human approval gate:** the agent can only *propose* a payment. A person must approve or reject it in the dashboard. No payment is real; it is simulated.
5. **Audit trail:** every step, tool call, and decision is logged to an append-only, hash-chained table.

## Stack

- **Backend:** Node.js + TypeScript, Fastify
- **Front end:** React + Vite
- **Database:** PostgreSQL (with pgvector for the policy knowledge base)
- **Queue:** pg-boss (runs on Postgres, no extra infrastructure)
- **LLM:** Claude API with tool use
- **Local dev:** docker-compose for Postgres
- **Repo layout:** monorepo with `api`, `worker`, `web`, `shared` (types), `evals`

## Case states

`received` → `validating` → one of:

- `needs_info` (missing fields, vendor email drafted)
- `awaiting_approval` (payment proposed, waiting for a human)
- `escalated` (agent cannot resolve safely)
- `completed`
- `failed` (dead-lettered after 3 retries)

## Data model

- `vendors` (id, name, email, status)
- `purchase_orders` (id, vendor_id, amount, currency, status)
- `cases` (id, idempotency_key UNIQUE, payload, state, due_date, created_at, updated_at)
- `approvals` (id, case_id, proposed_action, amount, status, decided_by, decided_at)
- `audit_events` (id, case_id, actor [agent | human | system], action, input, output, tokens, cost_usd, prev_hash, hash, created_at)
- `kb_chunks` (id, content, embedding) for payment policy documents

Rules for `audit_events`:

- Append-only: a database trigger rejects UPDATE and DELETE.
- Hash chain: `hash = sha256(prev_hash + event payload)`.
- A `GET /audit/verify` endpoint recomputes the chain and reports whether it is intact.

## Agent tools

- `validate_invoice`: returns missing or inconsistent fields
- `lookup_vendor`: vendor record and status
- `match_purchase_order`: PO match result and amount difference
- `search_policy`: RAG over payment policy documents
- `request_missing_info`: drafts an email to the vendor, sets state to `needs_info`
- `propose_payment`: creates an approval request, sets state to `awaiting_approval`. Never pays.
- `escalate_to_human`: sets state to `escalated` with a reason

Hard rule enforced in code, not only in the prompt: no code path completes a payment without an `approvals` row with status `approved` and a human `decided_by`.

## Build order

### Day 1: working end to end

1. Scaffold the monorepo, docker-compose, database migrations, and seed data (10 vendors, 20 purchase orders, 5 policy documents).
2. `POST /webhooks/invoice` with an idempotency key. Duplicates return the existing case and are not re-queued.
3. Worker that runs the agent loop with the tools above.
4. Audit logging for every agent step, tool call, and state change, with the hash chain.
5. Approval flow: `POST /approvals/:id/approve` and `/reject`, which enqueue a follow-up job to finish the case.
6. Dashboard: case list with state and due date, case detail with the full audit timeline, approvals inbox.

### Day 2: reliability, evals, polish

1. Retries with exponential backoff and a dead-letter state after 3 failures, visible in the dashboard.
2. A "simulate failure" toggle so a reviewer can watch a retry happen.
3. Eval suite (see below).
4. Cost and token tracking per case, shown in the UI, plus totals.
5. Dashboard extras: overdue cases, anomalies (amount mismatch, unknown vendor), audit chain status.
6. Deploy, then write the README.

## Evals

About 30 labelled cases in `evals/cases.json`, covering:

- Complete invoice, PO matches: should propose payment
- Missing fields: should request info and name the right fields
- Amount mismatch or unknown vendor: should escalate
- Duplicate submission: should not create a second case
- Policy edge cases: should cite the right policy

Report:

- Decision accuracy
- Escalation precision and recall
- Safety invariant: payments completed without human approval (must be 0)
- Average cost and latency per case

## README must include

- Live link and a 60-second demo GIF or video
- Architecture diagram
- Eval results table
- How the audit trail and approval gate work
- Trade-offs: why a queue over Kafka at this scale, cheaper versus stronger model, what breaks first under load
- What I would build next

## My 3 to 5 lines (fill in real numbers after)

> Invoice operations agent: invoices arrive by webhook, are queued, and an LLM agent validates them, matches them to purchase orders, and either resolves, requests missing information, or escalates.
> The agent can only propose payments. A human approves each one, and every action is written to an append-only, hash-chained audit log.
> I designed the architecture, the idempotency and retry logic, the approval gate, the tool schemas, and the eval suite. Claude Code generated much of the boilerplate, which I reviewed and reworked.
> Evals: X% decision accuracy on 30 cases, 0 unapproved payments, about $Y per case. Built in N days.

## Working rules for Claude Code

- Build one step at a time. Before each step, show the plan and wait for approval.
- After each step, explain what was built and why, and how to run and test it.
- Commit after each working step with a clear message.
- Keep secrets in `.env`, never in code or commits. Provide `.env.example`.
- Prefer simple, readable code over clever abstractions. I must be able to explain every file.

## First prompt to paste

```
Read PLAN.md. Start with Day 1, steps 1 and 2 only: scaffold the
monorepo, docker-compose with Postgres + pgvector, migrations and seed
data, and the invoice webhook that enqueues a job with an idempotency
key using pg-boss. Follow the "Working rules for Claude Code" section.
Show me the folder structure and data model first and wait for my
approval before writing code.
```
