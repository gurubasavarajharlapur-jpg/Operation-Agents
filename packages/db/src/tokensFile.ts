// Local convenience only: operator tokens are written to the gitignored .operator-tokens.json so
// you can copy them into the dashboard or curl. The database only ever holds their hashes.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TOKENS_FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../.operator-tokens.json');

export async function saveTokens(tokens: Record<string, string>) {
  let existing: Record<string, string> = {};
  try {
    existing = JSON.parse(await fs.readFile(TOKENS_FILE, 'utf8'));
  } catch {
    // first time
  }
  await fs.writeFile(TOKENS_FILE, JSON.stringify({ ...existing, ...tokens }, null, 2) + '\n', { mode: 0o600 });
}
