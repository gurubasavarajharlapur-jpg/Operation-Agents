-- Append-only, hash-chained audit log. Rows are written from step 4 onwards.
-- hash = sha256(prev_hash + canonical event payload), computed in application code.

CREATE TABLE audit_events (
  id          bigserial PRIMARY KEY,               -- gives the chain a strict order
  case_id     uuid REFERENCES cases(id),           -- null for system-wide events
  actor       text NOT NULL CHECK (actor IN ('agent', 'human', 'system')),
  action      text NOT NULL,
  input       jsonb,
  output      jsonb,
  tokens      integer,
  cost_usd    numeric(10,6),
  prev_hash   text,                                -- null only for the very first event
  hash        text NOT NULL UNIQUE,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_events_case_idx ON audit_events(case_id, id);

-- Enforced by the database, not by convention: history cannot be edited or removed.
CREATE FUNCTION reject_audit_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only: % is not allowed', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_events_no_update_delete
  BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION reject_audit_mutation();

CREATE TRIGGER audit_events_no_truncate
  BEFORE TRUNCATE ON audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION reject_audit_mutation();
