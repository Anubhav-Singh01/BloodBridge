import * as dataDeletionRequestsRepository from '../repositories/dataDeletionRequests.repository.js';
import type { DeletionSource } from '../repositories/dataDeletionRequests.repository.js';
import * as userRolesRepository from '../repositories/userRoles.repository.js';
import type { RoleCode } from '../repositories/userRoles.repository.js';
import * as usersRepository from '../repositories/users.repository.js';
import { AppError } from '../utils/appError.js';
import { record as recordAudit } from './auditService.js';

// API.md 4.1: only these two are ever self-assignable. ADMIN, SUPER_ADMIN and every facility role
// are rejected here even if a caller somehow got past the validator, so this rule holds regardless
// of how enrollRole is invoked.
const SELF_ENROLLABLE_ROLES: readonly RoleCode[] = ['PATIENT', 'DONOR'];

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === '23505';
}

export interface AuthMe {
  id: string;
  status: string;
  roles: RoleCode[];
  fullName: string | null;
  email: string | null;
  phone: string | null;
  phoneVerified: boolean;
  // Facility membership and donor/patient verification status are not part of this batch (no
  // facility_memberships, donors, or patients repository exists yet) - reported as empty/absent
  // rather than guessed.
  facilityMemberships: never[];
}

export async function getAuthMe(userId: string): Promise<AuthMe> {
  const user = await usersRepository.findById(userId);
  if (!user) throw new AppError(401, 'UNAUTHENTICATED', 'User not found.');
  const profile = await usersRepository.findProfileByUserId(userId);
  const roles = await userRolesRepository.listRoleCodesForUser(userId);
  return {
    id: user.id,
    status: user.status,
    roles,
    fullName: profile?.fullName ?? null,
    email: profile?.email ?? null,
    phone: profile?.phone ?? null,
    phoneVerified: profile?.phoneVerifiedAt != null,
    facilityMemberships: [],
  };
}

export interface ProfilePatch {
  fullName?: string | null | undefined;
  dateOfBirth?: string | null | undefined;
  address?: string | null | undefined;
}

export async function updateProfile(userId: string, patch: ProfilePatch): Promise<void> {
  await usersRepository.updateProfile(userId, patch);
}

export interface EnrollRoleResult {
  role: RoleCode;
  enrolled: boolean;
}

/** API.md 4.1: self-enrollment in PATIENT or DONOR only, idempotent, audited on first enrollment only. */
export async function enrollRole(userId: string, role: RoleCode, correlationId?: string): Promise<EnrollRoleResult> {
  if (!SELF_ENROLLABLE_ROLES.includes(role)) {
    throw new AppError(403, 'ROLE_NOT_SELF_ASSIGNABLE', `${role} cannot be self-assigned.`);
  }
  const { alreadyEnrolled } = await userRolesRepository.enrollRole(userId, role);
  if (!alreadyEnrolled) {
    await recordAudit({ actorId: userId, action: 'ROLE_ENROLLED', entityType: 'USER', entityId: userId, correlationId, details: { role } });
  }
  return { role, enrolled: !alreadyEnrolled };
}

export interface DeletionRequestResult {
  status: 'pending' | 'already_pending';
  requestId: string;
  requestedAt: Date;
}

/**
 * Shared by DELETE /users/me (source USER_REQUEST) and the Clerk user.deleted webhook (source
 * CLERK_WEBHOOK). Idempotent: if a PENDING request already exists for this user - including one
 * this same function just created a moment ago in a concurrent call - it is returned as-is rather
 * than treated as an error, and no second row or duplicate audit entry is written.
 */
export async function requestDeletion(userId: string, source: DeletionSource, correlationId?: string): Promise<DeletionRequestResult> {
  const existing = await dataDeletionRequestsRepository.findPendingForUser(userId);
  if (existing) {
    return { status: 'already_pending', requestId: existing.id, requestedAt: existing.createdAt };
  }

  try {
    const created = await dataDeletionRequestsRepository.createPending(userId, source);
    await usersRepository.setStatus(userId, 'DELETION_PENDING');
    await recordAudit({ actorId: source === 'USER_REQUEST' ? userId : null, action: 'DATA_DELETION_REQUESTED', entityType: 'USER', entityId: userId, correlationId, details: { source } });
    return { status: 'pending', requestId: created.id, requestedAt: created.createdAt };
  } catch (error) {
    // A concurrent call (another request, or the webhook racing the endpoint) won the insert first.
    // The row it created is the authoritative one - fetch and return it instead of failing.
    if (isUniqueViolation(error)) {
      const winner = await dataDeletionRequestsRepository.findPendingForUser(userId);
      if (winner) return { status: 'already_pending', requestId: winner.id, requestedAt: winner.createdAt };
    }
    throw error;
  }
}
