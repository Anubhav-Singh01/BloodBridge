import { Webhook, WebhookVerificationError } from 'svix';
import { AppError } from '../utils/appError.js';

// Verifies a Clerk webhook delivery's Svix signature before anything else touches the payload
// (API.md section 12: "Svix signature"). The payload MUST be the exact raw request body text -
// re-serializing a parsed body would change its bytes and break the signature, so the webhook route
// is mounted with a raw body parser (see routes/webhooks.routes.ts), not the JSON one the rest of the
// API uses.
//
// Throws AppError(401, 'INVALID_SIGNATURE', ...) on any verification failure. Never returns the
// parsed payload - callers JSON.parse the raw text themselves only after this has not thrown.

export interface SvixHeaders {
  'svix-id': string;
  'svix-timestamp': string;
  'svix-signature': string;
}

export function verifyClerkWebhookSignature(rawBody: string | Buffer, headers: SvixHeaders, secret: string): void {
  try {
    new Webhook(secret).verify(rawBody, headers);
  } catch (error) {
    if (error instanceof WebhookVerificationError) {
      throw new AppError(401, 'INVALID_SIGNATURE', 'Webhook signature verification failed.');
    }
    throw error;
  }
}
