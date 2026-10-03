// Sends a signed invoice to the running API, the way a real invoice system would.
//   npm run send:invoice                          -> the "happy" scenario, new idempotency key
//   npm run send:invoice -- --scenario mismatch   -> pick a scenario (src/demo/scenarios.ts)
//   npm run send:invoice -- --key my-key-1        -> fixed key; send twice to see the duplicate response
import crypto from 'node:crypto';
import { parseArgs } from 'node:util';
import { config } from '../src/config.ts';
import { signBody } from '../src/signature.ts';
import { SCENARIOS } from '../src/demo/scenarios.ts';

const { values } = parseArgs({ options: { scenario: { type: 'string', default: 'happy' }, key: { type: 'string' } } });
const scenario = SCENARIOS[values.scenario!];
if (!scenario) {
  console.error(`unknown scenario "${values.scenario}". Choose one of: ${Object.keys(SCENARIOS).join(', ')}`);
  process.exit(1);
}

const key = values.key ?? `demo-${crypto.randomUUID()}`;
// A fixed key must come with a fixed body (otherwise the API rightly answers 409), so derive the
// invoice number from the key; a random key gets a random invoice number.
const invoice = { ...scenario.invoice(), invoice_number: `INV-${values.key ?? crypto.randomUUID().slice(0, 8)}` };
const body = JSON.stringify(invoice);
const res = await fetch(`http://localhost:${config.port}/webhooks/invoice`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'idempotency-key': key, 'x-signature': signBody(body, config.webhookSecret) },
  body,
});
console.log(`scenario: ${values.scenario}  (expected: ${scenario.expect})`);
console.log(`${res.status} ${res.statusText}`, await res.json());
