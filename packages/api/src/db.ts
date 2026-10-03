import pg from 'pg';

// Postgres returns `date` columns as JS Date objects by default, which shifts them by the
// server's timezone. Keep them as plain 'YYYY-MM-DD' strings instead.
pg.types.setTypeParser(pg.types.builtins.DATE, (value) => value);

export function createPool(databaseUrl: string): pg.Pool {
  return new pg.Pool({ connectionString: databaseUrl, max: 10 });
}
