import * as usersRepository from '../repositories/users.repository.js';
import * as webhookEventsRepository from '../repositories/webhookEvents.repository.js';
import { mapClerkUserToProfile, type ClerkUserData, type ClerkUserDeletedData } from '../webhooks/clerkMapping.js';
import { requestDeletion } from './usersService.js';

const PROVIDER = 'clerk';

export interface ClerkWebhookEvent {
  type: string;
  data: unknown;
}

export type SyncResult = { outcome: 'duplicate' } | { outcome: 'processed'; type: string } | { outcome: 'ignored'; type: string };

/**
 * Idempotent entry point for every Clerk webhook delivery (API.md section 12). svixId is the
 * `svix-id` header - Svix's own delivery id, used as webhook_events.provider_event_id so a retry of
 * the exact same delivery is a no-op, per the table's existing uniqueness model. Only called after
 * the caller (controllers/webhooks.controller.ts) has already verified the Svix signature.
 */
export async function handleClerkWebhookEvent(event: ClerkWebhookEvent, svixId: string): Promise<SyncResult> {
  let eventRowId: string;
  const inserted = await webhookEventsRepository.recordIfNew(PROVIDER, svixId, event.type);
  if (inserted) {
    eventRowId = inserted.id;
  } else {
    // Not new by (provider, provider_event_id). Could be a genuine duplicate delivery (already
    // processed) or a delivery whose earlier attempt failed before markProcessed ran.
    const unprocessed = await webhookEventsRepository.findUnprocessed(PROVIDER, svixId);
    if (!unprocessed) return { outcome: 'duplicate' };
    eventRowId = unprocessed.id;
  }

  try {
    const outcome = await processClerkEvent(event);
    await webhookEventsRepository.markProcessed(eventRowId);
    return outcome;
  } catch (error) {
    await webhookEventsRepository.markFailed(eventRowId, error instanceof Error ? error.message : String(error));
    throw error;
  }
}

async function processClerkEvent(event: ClerkWebhookEvent): Promise<SyncResult> {
  switch (event.type) {
    case 'user.created':
    case 'user.updated': {
      const mapped = mapClerkUserToProfile(event.data as ClerkUserData);
      await usersRepository.upsertFromClerk(mapped);
      return { outcome: 'processed', type: event.type };
    }
    case 'user.deleted': {
      const data = event.data as ClerkUserDeletedData;
      const user = await usersRepository.findByClerkUserId(data.id);
      if (user) {
        await requestDeletion(user.id, 'CLERK_WEBHOOK');
      }
      // If we have no record of this Clerk user at all, there is nothing to delete on our side.
      return { outcome: 'processed', type: event.type };
    }
    default:
      // Any other Clerk event type this app is not (yet) subscribed to meaningfully. Recorded in
      // webhook_events either way, so it never becomes an unbounded retry loop.
      return { outcome: 'ignored', type: event.type };
  }
}
