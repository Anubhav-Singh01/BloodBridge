import type { Request, Response } from 'express';
import { env } from '../config/env.js';
import { handleClerkWebhookEvent } from '../services/clerkSyncService.js';
import { AppError } from '../utils/appError.js';
import { verifyClerkWebhookSignature } from '../webhooks/clerkSignature.js';

// API.md section 12. routes/webhooks.routes.ts mounts this with express.raw(), never express.json():
// Svix signs the exact request bytes, and re-serializing a parsed-then-stringified body would not
// reproduce those bytes.
export async function postClerkWebhook(req: Request, res: Response): Promise<void> {
  const svixId = req.get('svix-id');
  const svixTimestamp = req.get('svix-timestamp');
  const svixSignature = req.get('svix-signature');
  if (!svixId || !svixTimestamp || !svixSignature) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Missing Svix signature headers.');
  }

  const rawBody = req.body as Buffer;
  // Throws AppError(401, 'INVALID_SIGNATURE', ...) on failure. Nothing below this line runs unless
  // the signature is verified against CLERK_WEBHOOK_SECRET.
  verifyClerkWebhookSignature(rawBody, { 'svix-id': svixId, 'svix-timestamp': svixTimestamp, 'svix-signature': svixSignature }, env.CLERK_WEBHOOK_SECRET);

  const event = JSON.parse(rawBody.toString('utf8')) as { type: string; data: unknown };
  const result = await handleClerkWebhookEvent(event, svixId);
  // Always 200 once the signature and idempotency gate are past, including for a duplicate/ignored
  // delivery, so Svix does not retry a delivery we have already handled.
  res.status(200).json({ received: true, outcome: result.outcome });
}
