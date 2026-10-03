// Demo-only fault injection (see migration 006). If the case has failures left to simulate,
// use one up and throw, exactly where a real model-API outage would surface. Everything that
// follows (pg-boss retry with backoff, dead letter, audit trail) is the real mechanism.
import type pg from 'pg';

export class SimulatedOutageError extends Error {
  constructor() {
    super('Simulated outage: model API returned 529 overloaded');
    this.name = 'SimulatedOutageError';
  }
}

export async function throwIfFaultInjected(pool: pg.Pool, caseId: string): Promise<void> {
  const r = await pool.query(
    'UPDATE fault_injections SET failures_remaining = failures_remaining - 1 WHERE case_id = $1 AND failures_remaining > 0 RETURNING mode',
    [caseId],
  );
  if (r.rowCount) throw new SimulatedOutageError();
}
