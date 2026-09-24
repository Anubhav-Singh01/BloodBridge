import * as facilitiesRepository from '../repositories/facilities.repository.js';
import type { FacilityRow, FacilityType } from '../repositories/facilities.repository.js';
import * as facilityMembershipsRepository from '../repositories/facilityMemberships.repository.js';
import type { MembershipRole } from '../repositories/facilityMemberships.repository.js';
import * as facilityVerificationsRepository from '../repositories/facilityVerifications.repository.js';
import { AppError } from '../utils/appError.js';
import { record as recordAudit } from './auditService.js';
import { VERIFICATION_RELEVANT_FIELDS, type UpdateFacilityBody } from '../validators/facilities.validators.js';

function toPublicView(f: FacilityRow) {
  return { id: f.id, facilityType: f.facilityType, name: f.name, contact: f.contact, address: f.address, hasLocation: f.hasLocation, status: f.status };
}
function toFullView(f: FacilityRow) {
  return { ...toPublicView(f), registrationNo: f.registrationNo, verificationStatus: f.verificationStatus, createdBy: f.createdBy, createdAt: f.createdAt };
}

export interface RegisterFacilityInput {
  name: string;
  registrationNo?: string | null | undefined;
  contact?: string | null | undefined;
  address?: string | null | undefined;
  location?: { lat: number; lng: number } | null | undefined;
}

/** API.md section 7: self-register creates a PENDING facility, its specialized row, and an ACTIVE
 * FACILITY_ADMIN membership for the creator - and grants no other access. */
export async function registerFacility(facilityType: FacilityType, userId: string, input: RegisterFacilityInput, correlationId?: string) {
  const { id } = await facilitiesRepository.registerFacility({ ...input, facilityType, createdBy: userId });
  await facilityMembershipsRepository.createActiveAdmin(userId, id);
  await recordAudit({ actorId: userId, action: 'FACILITY_REGISTERED', entityType: 'FACILITY', entityId: id, correlationId, details: { facilityType } });
  const facility = await facilitiesRepository.findById(id);
  return toFullView(facility!);
}

/** Pub (VERIFIED, public fields) / F:ADMIN(id) (full) - API.md section 7's one-endpoint, two-view rule. */
export async function getFacilityDetail(facilityType: FacilityType, facilityId: string, callerUserId?: string) {
  const facility = await facilitiesRepository.findById(facilityId);
  if (!facility || facility.facilityType !== facilityType) return null;

  if (callerUserId) {
    const membership = await facilityMembershipsRepository.findActiveMembership(callerUserId, facilityId);
    if (membership?.role === 'FACILITY_ADMIN') return toFullView(facility);
  }
  if (facility.verificationStatus === 'VERIFIED' && facility.status === 'ACTIVE') return toPublicView(facility);
  return null;
}

export async function listFacilities(facilityType: FacilityType, limit: number, cursor?: string) {
  const page = await facilitiesRepository.listPublic(facilityType, limit, cursor);
  return { items: page.items.map(toPublicView), nextCursor: page.nextCursor };
}

function touchesVerificationRelevantField(patch: UpdateFacilityBody): boolean {
  return VERIFICATION_RELEVANT_FIELDS.some((field) => field in patch);
}

/** Verification-relevant field changes (name, registrationNo, address, location) reset
 * verification_status to UNDER_REVIEW; contact changes do not (Batch 3.11 decision). */
export async function updateFacilityProfile(facilityId: string, patch: UpdateFacilityBody): Promise<void> {
  await facilitiesRepository.updateProfile(facilityId, patch, touchesVerificationRelevantField(patch));
}

export async function submitVerification(facilityId: string, actorUserId: string, registrationMetadata: Record<string, unknown>, correlationId?: string) {
  const { id } = await facilityVerificationsRepository.upsertSubmission(facilityId, registrationMetadata);
  await recordAudit({ actorId: actorUserId, action: 'FACILITY_VERIFICATION_SUBMITTED', entityType: 'FACILITY', entityId: facilityId, correlationId });
  return { id, status: 'PENDING' as const };
}

export async function listStaff(facilityId: string) {
  return facilityMembershipsRepository.listByFacility(facilityId);
}

export async function inviteStaff(facilityId: string, invitedUserId: string, role: MembershipRole, invitedByUserId: string, correlationId?: string) {
  const { id } = await facilityMembershipsRepository.inviteStaff(facilityId, invitedUserId, role, invitedByUserId);
  await recordAudit({ actorId: invitedByUserId, action: 'STAFF_INVITED', entityType: 'FACILITY', entityId: facilityId, correlationId, details: { invitedUserId, role } });
  return { id, status: 'INVITED' as const };
}

/**
 * INVITED -> ACTIVE only, and only for the invited user themselves - facilityMembershipsRepository's
 * lookup is keyed by (userId, facilityId), so there is no path for anyone to accept on someone
 * else's behalf. Idempotent: an already-ACTIVE repeat is not re-audited.
 */
export async function acceptInvitation(userId: string, facilityId: string, correlationId?: string) {
  const before = await facilityMembershipsRepository.findMembership(userId, facilityId);
  const wasAlreadyActive = before?.status === 'ACTIVE';
  const membership = await facilityMembershipsRepository.acceptInvitation(userId, facilityId);
  if (!wasAlreadyActive) {
    await recordAudit({ actorId: userId, action: 'STAFF_INVITATION_ACCEPTED', entityType: 'FACILITY', entityId: facilityId, correlationId });
  }
  return { status: membership.status, joinedAt: membership.joinedAt };
}

/**
 * ACTIVE -> REMOVED only (soft-remove; the row is never deleted). Self-removal (a FACILITY_ADMIN
 * removing themselves) is not blocked - no approved decision restricts it - which means a facility
 * can end up with zero remaining FACILITY_ADMINs; see the implementation report.
 */
export async function removeStaff(facilityId: string, targetUserId: string, actorUserId: string, correlationId?: string): Promise<void> {
  await facilityMembershipsRepository.removeMembership(facilityId, targetUserId);
  await recordAudit({ actorId: actorUserId, action: 'STAFF_REMOVED', entityType: 'FACILITY', entityId: facilityId, correlationId, details: { removedUserId: targetUserId } });
}

export class FacilityNotFoundError extends AppError {
  constructor() {
    super(404, 'NOT_FOUND', 'Facility not found.');
  }
}
