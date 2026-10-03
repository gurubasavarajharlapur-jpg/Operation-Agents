-- Day 2: failures are first-class. Cases that exhaust their retries become 'failed' (already a
-- valid state); this migration adds the demo-only fault injection used to show retries live.

-- "Simulate failure" for the public demo. One row per case: the worker fails that many attempts
-- on purpose, at the point where a real model-API outage would hit, then carries on normally.
-- Written by the API only when ENABLE_FAULT_INJECTION=true, and never read from the invoice body:
-- untrusted input must not control infrastructure behaviour.
CREATE TABLE fault_injections (
  case_id             uuid PRIMARY KEY REFERENCES cases(id),
  mode                text NOT NULL CHECK (mode IN ('recovers', 'never_recovers')),
  failures_remaining  integer NOT NULL CHECK (failures_remaining >= 0),
  created_at          timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, UPDATE ON fault_injections TO ops_worker;
