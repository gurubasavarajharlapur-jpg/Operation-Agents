# Deploying the public demo

The app runs as **one free Render web service** (API + worker + dashboard in one Node process) with a
**free Neon Postgres** database. Every push to `main` redeploys automatically. Budget: $0.

You need about 10 minutes. Nothing here needs a credit card.

## 1. Create the database on Neon

1. Go to **https://neon.tech** and click **Sign up** → **Continue with GitHub**.
2. Create a project: any name (e.g. `operation-agents`), Postgres **16**, the region closest to
   **Frankfurt** (e.g. *AWS Europe Central (Frankfurt)*), so the database sits next to the app.
3. On the project dashboard click **Connect**. In the dialog:
   - turn **Connection pooling OFF** (the app needs a *direct* connection: its job queue and migration
     runner use Postgres advisory locks, which a connection pooler breaks);
   - copy the connection string. It looks like
     `postgresql://neondb_owner:xxxx@ep-something-123456.eu-central-1.aws.neon.tech/neondb?sslmode=require`
     (no `-pooler` in the host name).

Keep it somewhere safe for the next step. It is a password: never commit it.

## 2. Deploy the app on Render

1. Click this button (or in Render: **New → Blueprint** and pick this repository):

   [![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/gurubasavarajharlapur-jpg/operation-agents)

2. Sign in with **GitHub**. If Render cannot see the repository (it is private), click
   **Configure GitHub** and give the Render app access to `operation-agents`.
3. Render reads `render.yaml` and shows one service, `operation-agents`, and asks for:
   - **DATABASE_URL**: paste the Neon connection string from step 1.
   - **ANTHROPIC_API_KEY**: leave **empty** (the demo runs rules-only).
4. Click **Apply** / **Deploy Blueprint**. The first build takes about 3 to 5 minutes. When the log says
   `operation-agents: http://localhost:10000 (demo mode on, agent rules)`, it is live.
5. Your public URL is shown at the top of the service page, e.g.
   **https://operation-agents.onrender.com** (Render may add a suffix if the name is taken).

Render generates `WEBHOOK_SECRET` and `WORKER_DB_PASSWORD` itself. On every start the app runs the
database migrations and the seed (both safe to repeat), then starts.

## 3. Check it

- Open the URL. The **first visit after 15 idle minutes takes 30 to 60 seconds** (free services sleep);
  after that it is fast.
- Click **Try as an operations reviewer**, send a sample invoice from the panel, and watch it get
  decided. Approve one in **Approvals** (use **Try as a finance manager** for the 14,400 one).
- `https://<your-url>/api/audit/verify` should say `"intact": true`.

## Turning on the Claude agent later

In Render → the service → **Environment**:

| Variable | Value |
|---|---|
| `ANTHROPIC_API_KEY` | your key from console.anthropic.com |
| `AGENT_MODE` | `auto` |
| `DAILY_LLM_BUDGET_USD` | already `2`: once Claude has cost $2 in a day, new cases use rules-only until midnight UTC |

Save; Render redeploys. The banner and every new case will then say **Claude**. Also set a monthly
spend limit in the Anthropic Console.

## Public demo safeguards

- Payments are simulated; there is no real money anywhere in this system.
- Each visitor who clicks **Try as…** gets their own demo operator, so the audit trail shows who
  approved what. At most `DEMO_SIGN_INS_PER_HOUR` (default 60) demo sign-ins and
  `DEMO_INVOICES_PER_HOUR` (default 60) demo invoices per hour, counted in the database.
- The worker still connects as the restricted `ops_worker` database user, which cannot approve payments.
- The seeded operators (Priya, Tom, Elena) are not reachable from the demo; their tokens are printed
  once in the first deploy's log, which only you can see.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Deploy log: `password authentication failed` | DATABASE_URL was copied incompletely; copy it again from Neon. |
| Deploy log mentions `pooler`, or cases stay in *Received* | Use the **direct** connection string (pooling off, no `-pooler` in the host). |
| Page shows *Could not reach the API* right after waking | The service was asleep; wait 30 seconds and reload. |
| Anything else | Copy the last lines of the Render log and ask. |
