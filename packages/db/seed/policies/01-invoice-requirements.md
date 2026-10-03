# Invoice Requirements Policy

## Required fields
An invoice can only be processed when all of the following are present: invoice number, vendor (name or vendor ID), purchase order number, total amount, currency (three-letter ISO code), issue date, and due date. At least one line item must be listed.

## Consistency checks
The sum of line items (quantity multiplied by unit price) must equal the invoice total, allowing for rounding of up to 0.01. The due date must not be earlier than the issue date. The issue date must not be in the future.

## Missing or inconsistent information
If any required field is missing or a consistency check fails, the invoice must not be paid or escalated for payment. Instead, the vendor is contacted at their registered email address and asked for the specific missing or incorrect fields. The request must name each field individually; a generic "invoice incomplete" message is not acceptable.
