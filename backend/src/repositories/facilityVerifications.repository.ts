import { eq } from 'drizzle-orm';
import { db } from '../db/connection.js';
import { facilityVerifications } from '../db/schema/index.js';

export interface VerificationRow {
  id: string;
  facilityId: string;
  registrationMetadata: Record<string, unknown>;
  status: 'PENDING' | 'UNDER_REVIEW' | 'VERIFIED' | 'REJECTED';
  reviewedBy: string | null;
  reviewedAt: Date | null;
  notes: string | null;
}

export async function findByFacilityId(facilityId: string): Promise<VerificationRow | undefined> {
  const [row] = await db.select().from(facilityVerifications).where(eq(facilityVerifications.facilityId, facilityId)).limit(1);
  return row as VerificationRow | undefined;
}

/**
 * Creates or updates the one facility_verifications row for this facility (API.md section 7: "Creates
 * or updates a PENDING record. Does not approve"). Every submission resets status to PENDING and
 * clears reviewedBy/reviewedAt: new metadata means the previous review (if any) no longer applies to
 * what is being reviewed now. Approval/rejection itself is a separate, deferred admin action.
 */
export async function upsertSubmission(facilityId: string, registrationMetadata: Record<string, unknown>): Promise<{ id: string }> {
  const [row] = await db
    .insert(facilityVerifications)
    .values({ facilityId, registrationMetadata, status: 'PENDING' })
    .onConflictDoUpdate({
      target: facilityVerifications.facilityId,
      set: { registrationMetadata, status: 'PENDING', reviewedBy: null, reviewedAt: null, updatedAt: new Date() },
    })
    .returning({ id: facilityVerifications.id });
  return row!;
}
