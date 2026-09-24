import { and, eq } from 'drizzle-orm';
import { db } from '../db/connection.js';
import { dataDeletionRequests } from '../db/schema/index.js';

export type DeletionSource = 'USER_REQUEST' | 'CLERK_WEBHOOK';

export interface DeletionRequestRow {
  id: string;
  userId: string;
  source: DeletionSource;
  status: 'PENDING' | 'COMPLETED';
  createdAt: Date;
}

/** At most one row can match, enforced by data_deletion_requests_one_pending_per_user. */
export async function findPendingForUser(userId: string): Promise<DeletionRequestRow | undefined> {
  const [row] = await db
    .select({ id: dataDeletionRequests.id, userId: dataDeletionRequests.userId, source: dataDeletionRequests.source, status: dataDeletionRequests.status, createdAt: dataDeletionRequests.createdAt })
    .from(dataDeletionRequests)
    .where(and(eq(dataDeletionRequests.userId, userId), eq(dataDeletionRequests.status, 'PENDING')))
    .limit(1);
  return row;
}

/**
 * Inserts a new PENDING row. Throws the underlying postgres error (code 23505) if one is already
 * pending for this user - callers (services/usersService.ts) are expected to check
 * findPendingForUser first and treat a 23505 here as "someone else just created one", not a bug.
 */
export async function createPending(userId: string, source: DeletionSource): Promise<DeletionRequestRow> {
  const [row] = await db
    .insert(dataDeletionRequests)
    .values({ userId, source })
    .returning({ id: dataDeletionRequests.id, userId: dataDeletionRequests.userId, source: dataDeletionRequests.source, status: dataDeletionRequests.status, createdAt: dataDeletionRequests.createdAt });
  return row!;
}
