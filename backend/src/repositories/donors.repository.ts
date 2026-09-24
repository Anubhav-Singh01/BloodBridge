import { eq } from 'drizzle-orm';
import { db } from '../db/connection.js';
import { donors } from '../db/schema/index.js';

export type BloodGroup = 'A_POS' | 'A_NEG' | 'B_POS' | 'B_NEG' | 'AB_POS' | 'AB_NEG' | 'O_POS' | 'O_NEG';
export type DonorStatus = 'ACTIVE' | 'SUSPENDED' | 'ANONYMIZED';
export type AvailabilityStatus = 'AVAILABLE' | 'UNAVAILABLE' | 'TEMPORARILY_UNAVAILABLE';
export type VerificationStatus = 'PENDING' | 'UNDER_REVIEW' | 'VERIFIED' | 'REJECTED';

export interface DonorRow {
  id: string;
  userId: string;
  bloodGroup: BloodGroup;
  verificationStatus: VerificationStatus;
  availabilityStatus: AvailabilityStatus;
  availabilityUntil: Date | null;
  nextEligibleDonationAt: Date | null;
  currentEligibilityCalcId: string | null;
  selfReportedEligibility: boolean | null;
  status: DonorStatus;
}

const DONOR_COLUMNS = {
  id: donors.id,
  userId: donors.userId,
  bloodGroup: donors.bloodGroup,
  verificationStatus: donors.verificationStatus,
  availabilityStatus: donors.availabilityStatus,
  availabilityUntil: donors.availabilityUntil,
  nextEligibleDonationAt: donors.nextEligibleDonationAt,
  currentEligibilityCalcId: donors.currentEligibilityCalcId,
  selfReportedEligibility: donors.selfReportedEligibility,
  status: donors.status,
} as const;

export async function findByUserId(userId: string): Promise<DonorRow | undefined> {
  const [row] = await db.select(DONOR_COLUMNS).from(donors).where(eq(donors.userId, userId)).limit(1);
  return row;
}

export async function findById(id: string): Promise<DonorRow | undefined> {
  const [row] = await db.select(DONOR_COLUMNS).from(donors).where(eq(donors.id, id)).limit(1);
  return row;
}

export async function create(userId: string, bloodGroup: BloodGroup, selfReportedEligibility: boolean | null): Promise<{ id: string }> {
  const [row] = await db.insert(donors).values({ userId, bloodGroup, selfReportedEligibility }).returning({ id: donors.id });
  return row!;
}

export interface ProfilePatch {
  bloodGroup?: BloodGroup;
  selfReportedEligibility?: boolean | null;
}

/** resetVerification: true when bloodGroup actually changed and the donor was VERIFIED (Batch 3.12 decision A). */
export async function updateProfile(id: string, patch: ProfilePatch, resetVerification: boolean): Promise<void> {
  const set: Record<string, unknown> = { updatedAt: new Date() };
  if ('bloodGroup' in patch) set.bloodGroup = patch.bloodGroup;
  if ('selfReportedEligibility' in patch) set.selfReportedEligibility = patch.selfReportedEligibility;
  if (resetVerification) set.verificationStatus = 'PENDING';
  await db.update(donors).set(set).where(eq(donors.id, id));
}

export interface AvailabilityPatch {
  availabilityStatus: AvailabilityStatus;
  availabilityUntil: Date | null;
}

export async function setAvailability(id: string, patch: AvailabilityPatch): Promise<void> {
  await db.update(donors).set({ ...patch, updatedAt: new Date() }).where(eq(donors.id, id));
}
