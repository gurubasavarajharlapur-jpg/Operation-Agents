import '../src/config.ts'; // loads .env

// Tests use their own database next to the dev one, so test runs never touch dev data.
export function testDatabaseUrl(): string {
  const url = new URL(process.env.DATABASE_URL!);
  url.pathname = '/operation_agents_test';
  return url.toString();
}
