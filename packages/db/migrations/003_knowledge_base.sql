-- Payment policy knowledge base for the search_policy tool (RAG).
-- Embeddings come from Voyage AI voyage-3.5 (1024 dimensions). They are filled in by the
-- embedding script in step 3, so the column is nullable until then.

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE kb_documents (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title        text NOT NULL,
  source_file  text NOT NULL UNIQUE                -- lets the agent cite which policy it used
);

CREATE TABLE kb_chunks (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id  uuid NOT NULL REFERENCES kb_documents(id) ON DELETE CASCADE,
  chunk_index  integer NOT NULL,
  content      text NOT NULL,
  embedding    vector(1024),
  UNIQUE (document_id, chunk_index)
);

-- HNSW works well from the first row (unlike ivfflat, which needs data before it is built).
CREATE INDEX kb_chunks_embedding_idx ON kb_chunks USING hnsw (embedding vector_cosine_ops);
