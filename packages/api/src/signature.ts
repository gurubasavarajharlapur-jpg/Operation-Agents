import crypto from 'node:crypto';

// Webhook senders sign the raw request body with the shared secret:
//   X-Signature: sha256=<hex HMAC-SHA256 of the body>
// This proves the request came from someone who knows the secret and that the body was not altered.
export function signBody(rawBody: string, secret: string): string {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
}

export function isValidSignature(rawBody: string, header: string | undefined, secret: string): boolean {
  if (!header) return false;
  const expected = Buffer.from(signBody(rawBody, secret));
  const received = Buffer.from(header);
  // timingSafeEqual stops an attacker learning the signature byte by byte from response times.
  return expected.length === received.length && crypto.timingSafeEqual(expected, received);
}
