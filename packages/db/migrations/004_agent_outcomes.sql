-- Columns the agent worker needs (step 3).

-- What the agent decided and why: reason, drafted vendor email, missing fields, policy cited.
-- The dashboard shows this; the audit trail keeps the full step-by-step history.
ALTER TABLE cases ADD COLUMN outcome jsonb;

-- Approval authority from policy 04: up to 10,000 any operations user; above that a finance manager.
ALTER TABLE approvals ADD COLUMN required_role text NOT NULL DEFAULT 'operations'
  CHECK (required_role IN ('operations', 'finance_manager'));

-- Full-text search over policy chunks. This is the default search_policy backend;
-- vector search with Voyage embeddings is used instead when embeddings exist.
ALTER TABLE kb_chunks ADD COLUMN search tsvector
  GENERATED ALWAYS AS (to_tsvector('english', content)) STORED;
CREATE INDEX kb_chunks_search_idx ON kb_chunks USING gin (search);
