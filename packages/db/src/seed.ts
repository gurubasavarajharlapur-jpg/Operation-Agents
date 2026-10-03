// Loads vendors, purchase orders and policy documents. Safe to run repeatedly (upserts).
// Policy embeddings are NOT created here; the embedding script in step 3 fills kb_chunks.embedding.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { DATABASE_URL } from './env.ts';

const SEED_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../seed');

interface VendorSeed { id: string; name: string; email: string; status: string }
interface PurchaseOrderSeed { po_number: string; vendor_id: string; amount: number; currency: string; status: string }

async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await fs.readFile(path.join(SEED_DIR, file), 'utf8')) as T;
}

// One chunk per "## " section, prefixed with the document title so each chunk stands on its own.
function chunkPolicy(markdown: string): { title: string; chunks: string[] } {
  const title = markdown.match(/^# (.+)$/m)?.[1].trim() ?? 'Untitled policy';
  const sections = markdown.split(/^## /m).slice(1);
  const chunks = sections.map((section) => `${title} - ${section.trim()}`);
  return { title, chunks };
}

async function seed() {
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    await client.query('BEGIN');

    const vendors = await readJson<VendorSeed[]>('vendors.json');
    for (const v of vendors) {
      await client.query(
        `INSERT INTO vendors (id, name, email, status) VALUES ($1, $2, $3, $4)
         ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, email = EXCLUDED.email, status = EXCLUDED.status`,
        [v.id, v.name, v.email, v.status],
      );
    }

    const pos = await readJson<PurchaseOrderSeed[]>('purchase_orders.json');
    for (const po of pos) {
      await client.query(
        `INSERT INTO purchase_orders (po_number, vendor_id, amount, currency, status) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (po_number) DO UPDATE SET vendor_id = EXCLUDED.vendor_id, amount = EXCLUDED.amount,
           currency = EXCLUDED.currency, status = EXCLUDED.status`,
        [po.po_number, po.vendor_id, po.amount, po.currency, po.status],
      );
    }

    const policyDir = path.join(SEED_DIR, 'policies');
    const policyFiles = (await fs.readdir(policyDir)).filter((f) => f.endsWith('.md')).sort();
    let chunkCount = 0;
    for (const file of policyFiles) {
      const { title, chunks } = chunkPolicy(await fs.readFile(path.join(policyDir, file), 'utf8'));
      const doc = await client.query<{ id: string }>(
        `INSERT INTO kb_documents (title, source_file) VALUES ($1, $2)
         ON CONFLICT (source_file) DO UPDATE SET title = EXCLUDED.title
         RETURNING id`,
        [title, file],
      );
      const documentId = doc.rows[0].id;
      // Re-seeding replaces a document's chunks, so edited policies never leave stale text behind.
      await client.query('DELETE FROM kb_chunks WHERE document_id = $1', [documentId]);
      for (const [i, content] of chunks.entries()) {
        await client.query(
          'INSERT INTO kb_chunks (document_id, chunk_index, content) VALUES ($1, $2, $3)',
          [documentId, i, content],
        );
      }
      chunkCount += chunks.length;
    }

    await client.query('COMMIT');
    console.log(
      `seeded ${vendors.length} vendors, ${pos.length} purchase orders, ` +
        `${policyFiles.length} policy documents (${chunkCount} chunks)`,
    );
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    await client.end();
  }
}

seed().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
