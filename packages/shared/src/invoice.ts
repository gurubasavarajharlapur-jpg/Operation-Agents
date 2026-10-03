// The invoice body the webhook accepts.
// Every field is optional on purpose: the webhook stores whatever arrives, and the agent's
// validate_invoice tool (step 3) is what reports missing or inconsistent fields.
export interface InvoiceLineItem {
  description?: string;
  quantity?: number;
  unit_price?: number;
}

export interface InvoicePayload {
  invoice_number?: string;
  vendor_id?: string;
  vendor_name?: string;
  po_number?: string;
  amount?: number;
  currency?: string;
  issue_date?: string; // YYYY-MM-DD
  due_date?: string; // YYYY-MM-DD
  line_items?: InvoiceLineItem[];
  [extra: string]: unknown; // unknown fields are kept, not rejected
}

export interface WebhookResponse {
  case_id: string;
  state: string;
  duplicate: boolean;
}
