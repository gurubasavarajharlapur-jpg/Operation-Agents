# Operation Agents: Invoice Operations Agent

An LLM agent that processes vendor invoices end to end: webhook intake, queue, validation, PO matching,
and a payment proposal that **only a human can approve**, with every step written to an append-only,
hash-chained audit log. See [PLAN.md](PLAN.md) for the full design and build order.

> Work in progress. The full README (live link, demo, architecture, eval results) comes on Day 2.

## Run locally

Requires Node 20+ and Docker.

```bash
cp .env.example .env      # then set WEBHOOK_SECRET
npm install
npm run db:up             # Postgres 16 + pgvector in Docker
npm run db:migrate        # apply packages/db/migrations/*.sql
npm run db:seed           # 10 vendors, 20 purchase orders, 5 policy documents
```

`npm run db:reset` wipes the database and rebuilds it from scratch.

```bash
npm run dev:api                          # API on http://localhost:3000
npm run send:invoice                     # send a signed sample invoice -> 202, new case
npm run send:invoice -- demo-key-1       # run twice -> second answer is 200 with the same case_id
npm test                                 # webhook tests against a separate operation_agents_test database
```

## Invoice webhook

`POST /webhooks/invoice` with headers `Idempotency-Key` and `X-Signature: sha256=<HMAC-SHA256 of the raw body>`.

| Situation | Response |
|---|---|
| New key | `202` case created in state `received`, job queued |
| Same key, same payload | `200` existing case returned, **not** re-queued |
| Same key, different payload | `409` |
| Bad or missing signature | `401` |
| Missing key / body not a JSON object | `400` |

How duplicates are prevented:

- `cases.idempotency_key` is `UNIQUE` and the insert uses `ON CONFLICT DO NOTHING`. When 10 identical
  requests race, Postgres lets exactly one insert win; the others wait for it, then return that case.
- The case row and its pg-boss job are written in **one transaction** (`boss.send(..., { db })`), so
  there is never a case without a job or a job without a case. If queueing fails, the case is rolled back
  and the sender can retry with the same key.
- The payload is hashed after sorting keys (`canonicalJson`), so the same invoice with different key
  order or whitespace counts as the same request.

## Layout

| Package | What it is |
|---|---|
| `packages/shared` | Types shared by every package: case states, allowed transitions, invoice payload |
| `packages/db` | SQL migrations, a small migration runner, seed data and policy documents |
| `packages/api` | Fastify API: invoice webhook (later: approvals, dashboard endpoints, audit verify) |
| `packages/worker` | *(step 3)* agent loop that works each case |
| `packages/web` | *(step 6)* React dashboard |
| `packages/evals` | *(Day 2)* labelled cases and eval runner |
