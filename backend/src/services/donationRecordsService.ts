import * as donationHistoryRepository from '../repositories/donationHistory.repository.js';
import { record as recordAudit } from './auditService.js';
import { recompute } from './eligibilityCalculationService.js';

// API.md 6.8 / Batch 3.12 decision C. Reviewing someone else's donation record - authorization
// (ADMIN, or an ACTIVE member of the record's own facility) lives in middlewares/donationAuth.ts,
// which runs before every function here and is what actually enforces "not a member of a
// different facility". This service assumes that has already passed.

export async function verifyDonation(donationId: string, actorUserId: string, correlationId?: string) {
  const donation = await donationHistoryRepository.findById(donationId);
  if (!donation) throw new Error(`Donation ${donationId} not found - should have been caught by the auth middleware.`);

  await donationHistoryRepository.setVerification(donationId, 'VERIFIED', actorUserId);
  await recordAudit({ actorId: actorUserId, action: 'DONATION_VERIFIED', entityType: 'DONATION', entityId: donationId, correlationId });
  const calculation = await recompute(donation.donorId, 'DONATION_VERIFIED');
  return { id: donationId, status: 'VERIFIED' as const, calculation };
}

export async function rejectDonation(donationId: string, actorUserId: string, correlationId?: string) {
  const donation = await donationHistoryRepository.findById(donationId);
  if (!donation) throw new Error(`Donation ${donationId} not found - should have been caught by the auth middleware.`);

  await donationHistoryRepository.setVerification(donationId, 'REJECTED', actorUserId);
  await recordAudit({ actorId: actorUserId, action: 'DONATION_REJECTED', entityType: 'DONATION', entityId: donationId, correlationId });
  // DATABASE.md 2.4: both verifying AND rejecting trigger a recompute (rejecting a record that was
  // never the latest VERIFIED donation is a harmless no-op recompute with an unchanged outcome).
  const calculation = await recompute(donation.donorId, 'DONATION_REJECTED');
  return { id: donationId, status: 'REJECTED' as const, calculation };
}
