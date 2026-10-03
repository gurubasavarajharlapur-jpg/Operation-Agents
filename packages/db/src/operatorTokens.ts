import crypto from 'node:crypto';

// Operators authenticate with a random bearer token. Only its sha256 is stored, so a database
// leak does not leak working tokens.
export const newOperatorToken = () => `op_${crypto.randomBytes(24).toString('base64url')}`;
export const hashOperatorToken = (token: string) => crypto.createHash('sha256').update(token).digest('hex');
