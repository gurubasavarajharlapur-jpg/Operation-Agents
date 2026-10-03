import { describe, expect, it } from 'vitest';
import { workerDatabaseUrl } from '@oa/db';

describe('workerDatabaseUrl', () => {
  it('derives the worker URL from DATABASE_URL + WORKER_DB_PASSWORD, encoding special characters', () => {
    const url = workerDatabaseUrl({ DATABASE_URL: 'postgres://owner:pw@db.example:5432/neondb?sslmode=require', WORKER_DB_PASSWORD: 'kX9+/aB3=q&z%w' });
    const parsed = new URL(url);
    expect(parsed.username).toBe('ops_worker');
    expect(decodeURIComponent(parsed.password)).toBe('kX9+/aB3=q&z%w');
    expect(parsed.host).toBe('db.example:5432');
    expect(parsed.search).toBe('?sslmode=require');
  });

  it('prefers the derived URL over a WORKER_DATABASE_URL left in a .env file', () => {
    const url = workerDatabaseUrl({ DATABASE_URL: 'postgres://o:p@prod:5432/db', WORKER_DB_PASSWORD: 'x', WORKER_DATABASE_URL: 'postgres://ops_worker:y@localhost:5432/dev' });
    expect(new URL(url).host).toBe('prod:5432');
  });

  it('falls back to WORKER_DATABASE_URL, then the local default', () => {
    expect(workerDatabaseUrl({ WORKER_DATABASE_URL: 'postgres://ops_worker:a@h/db' })).toBe('postgres://ops_worker:a@h/db');
    expect(workerDatabaseUrl({})).toContain('ops_worker:ops_worker_dev@localhost');
  });
});
