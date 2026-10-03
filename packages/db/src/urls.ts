// Where the restricted worker user connects. In order of preference:
//   1. DATABASE_URL with the user swapped to ops_worker and WORKER_DB_PASSWORD as its password
//      (production: the host only has to generate one secret, not a second connection string).
//      Checked first so a leftover WORKER_DATABASE_URL in a .env file can never point the worker
//      at a different database than the API.
//   2. WORKER_DATABASE_URL (local dev: see .env.example)
//   3. the local docker-compose default
export function workerDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  if (env.DATABASE_URL && env.WORKER_DB_PASSWORD) {
    const url = new URL(env.DATABASE_URL);
    url.username = 'ops_worker';
    // encodeURIComponent, not the bare setter: the setter leaves '%' unescaped, which breaks decoding.
    url.password = encodeURIComponent(env.WORKER_DB_PASSWORD);
    return url.toString();
  }
  if (env.WORKER_DATABASE_URL) return env.WORKER_DATABASE_URL;
  return 'postgres://ops_worker:ops_worker_dev@localhost:5432/operation_agents';
}
