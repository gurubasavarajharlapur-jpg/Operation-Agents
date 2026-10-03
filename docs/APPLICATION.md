# For the Red Rock application

**Link:** https://github.com/gurubasavarajharlapur-jpg/operation-agents
**Live demo:** https://operation-agents.onrender.com (no sign-up; the first load can take up to a minute)

## My 3 to 5 lines

> Invoice operations agent: invoices arrive by signed webhook, are queued, and an agent validates them,
> matches them to purchase orders, and either proposes a payment, asks the vendor for what is missing,
> or escalates to a person with the exact reason.
>
> The agent can only propose: a named person approves every payment, enforced in the API, the worker and
> the database itself (the agent's database user cannot approve anything), and every step is written to an
> append-only, hash-chained audit trail.
>
> [EDIT THIS LINE SO IT IS TRUE FOR YOU] I set the requirements and the build plan, reviewed and approved
> every design decision (data model, idempotency and retries, the approval gate, the eval cases and how
> they are graded), and tested the live deployment; Claude Code wrote most of the code under that
> direction, with plans, tests and fixes reviewed at each step.
>
> Evals: 90.6% decision accuracy on 32 hand-labelled invoices in rules-only mode (100% on every
> rule-based case; it misses only the 3 fraud and manipulation notes that need judgment, which is what the
> LLM agent is for), 0 payments without human approval, $0 per case. Built in N days.

## Before you send it

- **Make the third line accurate.** Red Rock asks what *you* built yourself, so describe your part as it
  really was. If you wrote, changed or debugged parts of the code yourself, say which. Being precise here
  is worth more than sounding bigger, and they may ask you about it.
- **Fill in "N days".** The PLAN said two days.
- **If you run the Claude evals** (needs an Anthropic API key, roughly $5 to $15), replace the last line with
  both numbers, for example: *"Evals on 32 hand-labelled invoices: Claude X% decision accuracy (Y of 5
  fraud and manipulation cases caught) vs a rules-only baseline of 90.6%, 0 unapproved payments, about $Z
  per case."* Then update the Claude column in the README and `packages/evals/RESULTS.md` (the eval
  command regenerates RESULTS.md).
- **Know these well enough to talk about them:** why the agent cannot approve (three layers), how the audit
  chain detects tampering, why a Postgres queue instead of Kafka, what breaks first under load, and what
  the three missed eval cases show. All of it is in the README.
