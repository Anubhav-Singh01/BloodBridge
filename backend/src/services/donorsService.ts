import * as donationHistoryRepository from '../repositories/donationHistory.repository.js';
import * as donorLocationsRepository from '../repositories/donorLocations.repository.js';
import * as donorsRepository from '../repositories/donors.repository.js';
import type { BloodGroup } from '../repositories/donors.repository.js';
import * as donorVerificationsRepository from '../repositories/donorVerifications.repository.js';
import { AppError } from '../utils/appError.js';
import { snapToCoarseGrid } from '../utils/geo.js';
import { record as recordAudit } from './auditService.js';

export interface ProfileInput {
  bloodGroup: BloodGroup;
  selfReportedEligibility?: boolean | null | undefined;
}

/** API.md section 5: "Create or update donor profile, blood group (self-reported until verified)". */
export async function createOrUpdateProfile(userId: string, input: ProfileInput, correlationId?: string) {
  const existing = await donorsRepository.findByUserId(userId);

  if (!existing) {
    const { id } = await donorsRepository.create(userId, input.bloodGroup, input.selfReportedEligibility ?? null);
    return donorsRepository.findById(id);
  }

  const bloodGroupChanged = input.bloodGroup !== existing.bloodGroup;
  // Batch 3.12 decision A: only a genuine bloodGroup change on an already-VERIFIED donor resets
  // verification. selfReportedEligibility never resets it - no existing decision requires that.
  const resetVerification = bloodGroupChanged && existing.verificationStatus === 'VERIFIED';

  await donorsRepository.updateProfile(existing.id, { bloodGroup: input.bloodGroup, selfReportedEligibility: input.selfReportedEligibility ?? null }, resetVerification);

  if (bloodGroupChanged) {
    await recordAudit({
      actorId: userId,
      action: 'DONOR_BLOOD_GROUP_CHANGED',
      entityType: 'DONOR',
      entityId: existing.id,
      correlationId,
      details: { from: existing.bloodGroup, to: input.bloodGroup, verificationReset: resetVerification },
    });
  }

  return donorsRepository.findById(existing.id);
}

export interface AvailabilityInput {
  availabilityStatus: 'AVAILABLE' | 'UNAVAILABLE' | 'TEMPORARILY_UNAVAILABLE';
  until?: Date | null;
}

export async function setAvailability(donorId: string, input: AvailabilityInput): Promise<void> {
  await donorsRepository.setAvailability(donorId, {
    availabilityStatus: input.availabilityStatus,
    availabilityUntil: input.availabilityStatus === 'TEMPORARILY_UNAVAILABLE' ? (input.until ?? null) : null,
  });
}

export interface VerificationSubmissionInput {
  idType: string;
  idLast4?: string | null | undefined;
  idName?: string | null | undefined;
}

function sameSubmission(a: { idType: string; idLast4: string | null; idName: string | null }, existing: { idType: string; idLast4: string | null; idName: string | null }): boolean {
  return a.idType === existing.idType && a.idLast4 === existing.idLast4 && a.idName === existing.idName;
}

/**
 * API.md 5.1: creates PENDING on the first submission. Resubmission allowed only from PENDING or
 * REJECTED (updates and resets to PENDING); UNDER_REVIEW is 409 CONFLICT; VERIFIED is 409
 * VERIFICATION_ALREADY_APPROVED. Idempotent for an identical resubmission while already PENDING -
 * no write, no duplicate audit entry.
 */
export async function submitVerification(donorId: string, input: VerificationSubmissionInput, correlationId?: string) {
  const normalized = { idType: input.idType, idLast4: input.idLast4 ?? null, idName: input.idName ?? null };
  const existing = await donorVerificationsRepository.findByDonorId(donorId);

  if (!existing) {
    const { id } = await donorVerificationsRepository.insert(donorId, normalized);
    await recordAudit({ actorId: null, action: 'DONOR_VERIFICATION_SUBMITTED', entityType: 'DONOR', entityId: donorId, correlationId });
    return { id, status: 'PENDING' as const };
  }

  if (existing.status === 'UNDER_REVIEW') {
    throw new AppError(409, 'CONFLICT', 'This verification is already under review.');
  }
  if (existing.status === 'VERIFIED') {
    throw new AppError(409, 'VERIFICATION_ALREADY_APPROVED', 'This donor is already verified.');
  }
  // status is PENDING or REJECTED here.
  if (existing.status === 'PENDING' && sameSubmission(normalized, existing)) {
    return { id: existing.id, status: 'PENDING' as const }; // idempotent: nothing changed
  }

  await donorVerificationsRepository.resubmit(existing.id, normalized);
  await recordAudit({ actorId: null, action: 'DONOR_VERIFICATION_SUBMITTED', entityType: 'DONOR', entityId: donorId, correlationId });
  return { id: existing.id, status: 'PENDING' as const };
}

export async function getVerification(donorId: string) {
  return donorVerificationsRepository.findByDonorId(donorId);
}

export interface LocationInput {
  lat: number;
  lng: number;
}

/** Batch 3.12 decision B: the caller never gets the exact coordinates back, even their own. */
export async function setLocation(donorId: string, input: LocationInput): Promise<void> {
  const exact = { lat: input.lat, lng: input.lng };
  const coarse = snapToCoarseGrid(exact);
  await donorLocationsRepository.upsert(donorId, exact, coarse);
}

/** Batch 3.12 decision C: donor self-report only (SELF_REPORTED). Does not verify itself. */
export async function reportSelfDonation(donorId: string, donatedAt: Date, correlationId?: string) {
  const { id } = await donationHistoryRepository.createSelfReported(donorId, donatedAt, 'WHOLE_BLOOD');
  await recordAudit({ actorId: null, action: 'DONOR_DONATION_SELF_REPORTED', entityType: 'DONATION', entityId: id, correlationId });
  return { id, status: 'UNVERIFIED' as const };
}

export async function getHistoryPage(donorId: string, limit: number, cursor?: string) {
  return donationHistoryRepository.listByDonor(donorId, limit, cursor);
}
