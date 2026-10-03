import { workerDatabaseUrl } from './urls.ts';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Load the repo-root .env (if present) into process.env. Real env vars win over the file.
const rootEnv = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../.env');
try {
  process.loadEnvFile(rootEnv);
} catch {
  // no .env file: rely on the real environment
}

export const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://ops:ops@localhost:5432/operation_agents';

// The worker connects as the restricted ops_worker role (migration 005).
export const WORKER_DATABASE_URL = workerDatabaseUrl();
