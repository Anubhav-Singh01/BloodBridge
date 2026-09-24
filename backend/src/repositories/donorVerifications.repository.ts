import { eq } from 'drizzle-orm';
import { db } from '../db/connection.js';
import { donorVerifications } from '../db/schema/index.js';

export type VerificationStatus = 'PENDING' | 'UNDER_REVIEW' | 'VERIFIED' | 'REJECTED';

export interface DonorVerificationRow {
  id: string;
  donorId: string;
  idType: string;
  idLast4: string | null;
  idName: string | null;
  status: VerificationStatus;
  reviewedBy: string | null;
  reviewedAt: Date | null;
  notes: string | null;
}

export async function findByDonorId(donorId: string): Promise<DonorVerificationRow | undefined> {
  const [row] = await db.select().from(donorVerifications).where(eq(donorVerifications.donorId, donorId)).limit(1);
  return row as DonorVerificationRow | undefined;
}

export interface SubmissionInput {
  idType: string;
  idLast4: string | null;
  idName: string | null;
}

export async function insert(donorId: string, input: SubmissionInput): Promise<{ id: string }> {
  const [row] = await db.insert(donorVerifications).values({ donorId, ...input }).returning({ id: donorVerifications.id });
  return row!;
}

/** API.md 5.1 resubmission: allowed from PENDING or REJECTED only (checked by the service before calling this). */
export async function resubmit(id: string, input: SubmissionInput): Promise<void> {
  await db.update(donorVerifications).set({ ...input, status: 'PENDING', reviewedBy: null, reviewedAt: null, updatedAt: new Date() }).where(eq(donorVerifications.id, id));
}
