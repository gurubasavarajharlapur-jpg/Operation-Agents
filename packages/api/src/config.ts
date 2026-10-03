import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Load the repo-root .env (if present). Real environment variables win over the file.
const rootEnv = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../.env');
try {
  process.loadEnvFile(rootEnv);
} catch {
  // no .env file: rely on the real environment
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name} (see .env.example)`);
  return value;
}

export const config = {
  databaseUrl: required('DATABASE_URL'),
  port: Number(process.env.PORT ?? process.env.API_PORT ?? 3000), // PORT is set by hosts like Render
  webhookSecret: required('WEBHOOK_SECRET'),
  isProduction: process.env.NODE_ENV === 'production',
};

if (config.isProduction && config.webhookSecret === 'change-me') {
  throw new Error('WEBHOOK_SECRET is still the placeholder value; set a real secret in production');
}
