import { and, eq, isNull } from 'drizzle-orm';
import { db } from '../db/connection.js';
import { webhookEvents } from '../db/schema/index.js';

/**
 * The idempotency gate (API.md section 12): inserts the event id first, before any processing.
 * Returns the new row's id if this delivery is new, or null if (provider, providerEventId) already
 * exists - a Svix retry or a duplicate delivery. A null result does NOT necessarily mean "already
 * handled": findUnprocessed() below distinguishes a genuine duplicate (already processed) from a
 * previous attempt that recorded the event but failed before finishing, so a retry is not silently
 * dropped.
 */
export async function recordIfNew(provider: string, providerEventId: string, eventType: string): Promise<{ id: string } | null> {
  const rows = await db
    .insert(webhookEvents)
    .values({ provider, providerEventId, eventType })
    .onConflictDoNothing({ target: [webhookEvents.provider, webhookEvents.providerEventId] })
    .returning({ id: webhookEvents.id });
  return rows[0] ?? null;
}

/**
 * Looks up an existing (provider, providerEventId) row that has NOT yet been marked processed.
 * Called only when recordIfNew returned null, to tell a genuine duplicate (already processed,
 * skip) apart from a delivery whose previous attempt failed before markProcessed ran (retry it
 * using this row's id, rather than inserting a second one).
 */
export async function findUnprocessed(provider: string, providerEventId: string): Promise<{ id: string } | null> {
  const [row] = await db
    .select({ id: webhookEvents.id })
    .from(webhookEvents)
    .where(and(eq(webhookEvents.provider, provider), eq(webhookEvents.providerEventId, providerEventId), isNull(webhookEvents.processedAt)))
    .limit(1);
  return row ?? null;
}

export async function markProcessed(id: string): Promise<void> {
  await db.update(webhookEvents).set({ processedAt: new Date() }).where(eq(webhookEvents.id, id));
}

export async function markFailed(id: string, error: string): Promise<void> {
  await db.update(webhookEvents).set({ lastError: error }).where(eq(webhookEvents.id, id));
}
