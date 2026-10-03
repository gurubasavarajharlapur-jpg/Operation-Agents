-- Step 5: the human approval gate.
-- "No payment completes without an approvals row with status approved and a human decided_by"
-- is enforced here in the database, in addition to the API and worker code.

-- 1. The humans. Only a registered, active operator can decide an approval.
CREATE TABLE operators (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  email       text NOT NULL UNIQUE,
  role        text NOT NULL CHECK (role IN ('operations', 'finance_manager')),
  token_hash  text NOT NULL UNIQUE,      -- sha256 of the API token; the token itself is never stored
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- decided_by now has to point at a real operator, not free text.
ALTER TABLE approvals
  ALTER COLUMN decided_by TYPE uuid USING decided_by::uuid,
  ADD CONSTRAINT approvals_decided_by_operator FOREIGN KEY (decided_by) REFERENCES operators(id),
  ADD COLUMN decision_note text;

-- 2. Simulated payments. One per approval, ever (UNIQUE approval_id), so a re-delivered job
--    or a double click can never pay twice.
CREATE TABLE payments (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  approval_id  uuid NOT NULL UNIQUE REFERENCES approvals(id),
  case_id      uuid NOT NULL REFERENCES cases(id),
  amount       numeric(12,2) NOT NULL,
  currency     char(3) NOT NULL,
  reference    text NOT NULL UNIQUE,      -- e.g. SIM-20261003-8F2A1C; nothing real is paid
  executed_at  timestamptz NOT NULL DEFAULT now()
);

-- The last line of defence: whatever code or SQL tries to insert a payment, the row is refused
-- unless its approval was approved by an active human operator for exactly this amount.
-- SECURITY DEFINER so the check can read approvals/operators even when the inserting role
-- (the worker) has no access to operators' token hashes.
CREATE FUNCTION payments_require_human_approval() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  a approvals%ROWTYPE;
  approver_active boolean;
BEGIN
  SELECT * INTO a FROM approvals WHERE id = NEW.approval_id;
  IF a.id IS NULL THEN
    RAISE EXCEPTION 'payment refused: approval % does not exist', NEW.approval_id;
  END IF;
  IF a.status <> 'approved' THEN
    RAISE EXCEPTION 'payment refused: approval % is %, not approved', a.id, a.status;
  END IF;
  SELECT active INTO approver_active FROM operators WHERE id = a.decided_by;
  IF a.decided_by IS NULL OR approver_active IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'payment refused: approval % was not decided by an active human operator', a.id;
  END IF;
  IF a.case_id <> NEW.case_id OR a.amount <> NEW.amount OR a.currency <> NEW.currency THEN
    RAISE EXCEPTION 'payment refused: case, amount or currency differs from approval %', a.id;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER payments_require_human_approval
  BEFORE INSERT ON payments
  FOR EACH ROW EXECUTE FUNCTION payments_require_human_approval();

-- Payments are a ledger: never edited or removed (same function as the audit log uses).
CREATE TRIGGER payments_no_update_delete
  BEFORE UPDATE OR DELETE ON payments
  FOR EACH ROW EXECUTE FUNCTION reject_audit_mutation();

-- 3. A restricted database user for the worker (the process that runs the agent).
--    It can read what it needs and record the agent's work, but it has NO permission to
--    UPDATE approvals: even a compromised agent process cannot approve a payment.
--    Its password is set by the migrate script from WORKER_DATABASE_URL, never stored here.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ops_worker') THEN
    CREATE ROLE ops_worker LOGIN;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO ops_worker;
GRANT SELECT ON vendors, purchase_orders, kb_documents, kb_chunks, approvals, payments TO ops_worker;
GRANT SELECT (id, name, role, active) ON operators TO ops_worker;   -- not email or token_hash
GRANT SELECT, UPDATE ON cases TO ops_worker;                        -- move case state, write outcome
GRANT INSERT ON approvals TO ops_worker;                            -- propose; never UPDATE (= decide)
GRANT INSERT ON payments TO ops_worker;                             -- only after the trigger's checks
GRANT SELECT, INSERT ON audit_events TO ops_worker;                 -- append only
GRANT USAGE ON SEQUENCE audit_events_id_seq TO ops_worker;
