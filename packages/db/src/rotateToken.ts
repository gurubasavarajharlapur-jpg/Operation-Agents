// Issues a new token for an operator (the old one stops working immediately).
//   npm run operator:token -- elena.varga@finance.example
import pg from 'pg';
import { DATABASE_URL } from './env.ts';
import { hashOperatorToken, newOperatorToken } from './operatorTokens.ts';
import { saveTokens } from './tokensFile.ts';

const email = process.argv[2];
if (!email) {
  console.error('usage: npm run operator:token -- <operator email>');
  process.exit(1);
}
const client = new pg.Client({ connectionString: DATABASE_URL });
await client.connect();
const token = newOperatorToken();
const r = await client.query('UPDATE operators SET token_hash = $1 WHERE email = $2 RETURNING name, role', [hashOperatorToken(token), email]);
await client.end();
if (!r.rowCount) {
  console.error(`no operator with email ${email}`);
  process.exit(1);
}
await saveTokens({ [email]: token });
console.log(`${r.rows[0].name} (${r.rows[0].role}): ${token}`);
