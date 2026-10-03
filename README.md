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

## Layout

| Package | What it is |
|---|---|
| `packages/shared` | Types shared by every package: case states, allowed transitions, invoice payload |
| `packages/db` | SQL migrations, a small migration runner, seed data and policy documents |
| `packages/api` | Fastify API: invoice webhook (later: approvals, dashboard endpoints, audit verify) |
| `packages/worker` | *(step 3)* agent loop that works each case |
| `packages/web` | *(step 6)* React dashboard |
| `packages/evals` | *(Day 2)* labelled cases and eval runner |
