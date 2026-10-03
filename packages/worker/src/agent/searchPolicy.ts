// search_policy backend. Default: Postgres full-text search, which needs no API key and is plenty
// for a handful of policy documents. If Voyage embeddings exist (npm run db:embed) and
// VOYAGE_API_KEY is set, vector search is used instead; any Voyage error falls back to full-text.
import type { Queryable } from './facts.ts';

export interface PolicyHit {
  source_file: string;
  title: string;
  content: string;
  score: number;
}

export async function searchPolicy(db: Queryable, query: string, voyageApiKey?: string): Promise<{ method: string; results: PolicyHit[] }> {
  if (voyageApiKey) {
    try {
      const hasEmbeddings = await db.query('SELECT 1 FROM kb_chunks WHERE embedding IS NOT NULL LIMIT 1');
      if (hasEmbeddings.rowCount) {
        const vector = await embedQuery(query, voyageApiKey);
        const r = await db.query<PolicyHit>(
          `SELECT d.source_file, d.title, c.content, 1 - (c.embedding <=> $1::vector) AS score
           FROM kb_chunks c JOIN kb_documents d ON d.id = c.document_id
           WHERE c.embedding IS NOT NULL
           ORDER BY c.embedding <=> $1::vector LIMIT 3`,
          [`[${vector.join(',')}]`],
        );
        return { method: 'vector', results: r.rows };
      }
    } catch (err) {
      console.warn('vector search failed, falling back to full-text search:', (err as Error).message);
    }
  }

  // OR the words together so a question phrased in plain English still finds the right section;
  // ts_rank_cd puts the sections matching the most words first.
  const words = query.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  if (words.length === 0) return { method: 'full_text', results: [] };
  const r = await db.query<PolicyHit>(
    `SELECT d.source_file, d.title, c.content, ts_rank_cd(c.search, q) AS score
     FROM kb_chunks c JOIN kb_documents d ON d.id = c.document_id,
          to_tsquery('english', $1) q
     WHERE c.search @@ q
     ORDER BY score DESC LIMIT 3`,
    [words.join(' | ')],
  );
  return { method: 'full_text', results: r.rows };
}

export async function embedQuery(text: string, apiKey: string): Promise<number[]> {
  const res = await fetch('https://api.voyageai.com/v1/embeddings', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ input: [text], model: 'voyage-3.5', input_type: 'query' }),
  });
  if (!res.ok) throw new Error(`Voyage API ${res.status}: ${await res.text()}`);
  const body = (await res.json()) as { data: { embedding: number[] }[] };
  return body.data[0].embedding;
}
