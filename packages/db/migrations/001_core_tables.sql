-- Core business tables: vendors, purchase orders, cases, approvals.
-- Money is numeric(12,2), never float, so amounts compare exactly.

CREATE TABLE vendors (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  email       text NOT NULL,
  status      text NOT NULL CHECK (status IN ('active', 'suspended', 'pending')),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE purchase_orders (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  po_number   text NOT NULL UNIQUE,              -- what invoices actually reference, e.g. PO-1001
  vendor_id   uuid NOT NULL REFERENCES vendors(id),
  amount      numeric(12,2) NOT NULL CHECK (amount > 0),
  currency    char(3) NOT NULL,
  status      text NOT NULL CHECK (status IN ('open', 'closed', 'cancelled')),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX purchase_orders_vendor_idx ON purchase_orders(vendor_id);

CREATE TABLE cases (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key  text NOT NULL UNIQUE,         -- the guarantee against duplicate cases
  payload_hash     text NOT NULL,                -- sha256 of the body; same key + different body = 409
  payload          jsonb NOT NULL,
  state            text NOT NULL DEFAULT 'received' CHECK (state IN (
                     'received', 'validating', 'needs_info', 'awaiting_approval',
                     'escalated', 'completed', 'failed')),
  due_date         date,                         -- null if the invoice had no valid due date
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX cases_state_idx ON cases(state);
CREATE INDEX cases_due_date_idx ON cases(due_date);

CREATE TABLE approvals (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id          uuid NOT NULL REFERENCES cases(id),
  proposed_action  text NOT NULL,
  amount           numeric(12,2) NOT NULL CHECK (amount > 0),
  currency         char(3) NOT NULL,
  status           text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  decided_by       text,
  decided_at       timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  -- First layer of the approval gate: nobody can mark a decision without saying who made it and when.
  CONSTRAINT approvals_decision_has_human CHECK (
    status = 'pending' OR (decided_by IS NOT NULL AND decided_at IS NOT NULL)
  )
);
-- At most one open proposal per case, so the agent cannot stack up duplicate payment requests.
CREATE UNIQUE INDEX approvals_one_pending_per_case ON approvals(case_id) WHERE status = 'pending';

-- Keep cases.updated_at honest without relying on every query to set it.
CREATE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER cases_set_updated_at
  BEFORE UPDATE ON cases
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
