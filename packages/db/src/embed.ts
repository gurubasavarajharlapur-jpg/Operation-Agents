// Optional: creates Voyage AI embeddings for policy chunks so search_policy uses vector search.
// Without this, search_policy uses Postgres full-text search, which works fine for a few documents.
//   VOYAGE_API_KEY=... npm run db:embed
import pg from 'pg';
import { DATABASE_URL } from './env.ts';

const apiKey = process.env.VOYAGE_API_KEY;
if (!apiKey) {
  console.error('VOYAGE_API_KEY is not set; search_policy will keep using full-text search.');
  process.exit(1);
}

const client = new pg.Client({ connectionString: DATABASE_URL });
await client.connect();
try {
  const { rows } = await client.query<{ id: string; content: string }>('SELECT id, content FROM kb_chunks WHERE embedding IS NULL ORDER BY id');
  if (rows.length === 0) {
    console.log('all chunks already have embeddings');
  } else {
    const res = await fetch('https://api.voyageai.com/v1/embeddings', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ input: rows.map((r) => r.content), model: 'voyage-3.5', input_type: 'document' }),
    });
    if (!res.ok) throw new Error(`Voyage API ${res.status}: ${await res.text()}`);
    const body = (await res.json()) as { data: { index: number; embedding: number[] }[] };
    for (const item of body.data) {
      await client.query('UPDATE kb_chunks SET embedding = $1::vector WHERE id = $2', [`[${item.embedding.join(',')}]`, rows[item.index].id]);
    }
    console.log(`embedded ${body.data.length} chunks with voyage-3.5`);
  }
} finally {
  await client.end();
}
