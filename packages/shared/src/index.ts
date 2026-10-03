export * from './caseStates.ts';
export * from './invoice.ts';
export * from './canonicalJson.ts';
export * from './policyRules.ts';

// pg-boss queue names
export const INVOICE_QUEUE = 'invoice.process';
export const INVOICE_DEAD_LETTER_QUEUE = 'invoice.dead';
export const APPROVAL_FINALIZE_QUEUE = 'approval.finalize';
export const APPROVAL_DEAD_LETTER_QUEUE = 'approval.dead';

// Job retry policy (pg-boss). With backoff the delays are roughly 5s, 10s, 20s:
// 1 attempt + 3 retries = 4 attempts, then the job goes to the dead-letter queue.
export const RETRY_POLICY = { retryLimit: 3, retryDelay: 5, retryBackoff: true } as const;
export const MAX_ATTEMPTS = RETRY_POLICY.retryLimit + 1;

/** Approximate wait before the next attempt after `failedAttempts` failures (pg-boss adds jitter). */
export const retryDelaySeconds = (failedAttempts: number) => RETRY_POLICY.retryDelay * 2 ** (failedAttempts - 1);
