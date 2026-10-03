// Sends a signed sample invoice to the running API, the way a real invoice system would.
//   npm run send:invoice                 -> new idempotency key every time (creates a new case)
//   npm run send:invoice -- my-key-123   -> fixed key; run it twice to see the duplicate response
import { config } from '../src/config.ts';
import { signBody } from '../src/signature.ts';

const key = process.argv[2] ?? `demo-${Date.now()}`;
const invoice = {
  invoice_number: `INV-${Math.floor(Math.random() * 100000)}`,
  vendor_id: 'a1000000-0000-4000-8000-000000000001',
  vendor_name: 'Northwind Office Supplies Ltd',
  po_number: 'PO-1001',
  amount: 1250.0,
  currency: 'GBP',
  issue_date: '2026-10-01',
  due_date: '2026-10-31',
  line_items: [{ description: 'Office chairs', quantity: 5, unit_price: 250.0 }],
};
// With a fixed key, keep the body fixed too, otherwise the API rightly answers 409.
if (process.argv[2]) invoice.invoice_number = `INV-${key}`;

const body = JSON.stringify(invoice);
const res = await fetch(`http://localhost:${config.port}/webhooks/invoice`, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'idempotency-key': key,
    'x-signature': signBody(body, config.webhookSecret),
  },
  body,
});
console.log(`${res.status} ${res.statusText}`, await res.json());
