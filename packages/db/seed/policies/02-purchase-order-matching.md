# Purchase Order Matching Policy

## Every invoice needs an open purchase order
Each invoice must reference a purchase order (PO) number that exists and belongs to the same vendor that issued the invoice. Invoices against a PO with status "closed" or "cancelled" must be escalated to a human; they are never proposed for payment.

## Amount tolerance
An invoice matches its PO when the invoice total is within 2% of the PO amount or within 50.00 in the PO currency, whichever is smaller. An invoice above that tolerance must be escalated with the exact amount difference stated. An invoice below the PO amount (a partial invoice) may be proposed for payment if all other checks pass.

## Currency
The invoice currency must equal the PO currency. A currency mismatch is always escalated, even if the converted amount would match. The agent must not perform currency conversion.
