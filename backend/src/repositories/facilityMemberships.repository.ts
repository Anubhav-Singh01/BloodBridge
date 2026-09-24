import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/connection.js';
import { facilityMemberships } from '../db/schema/index.js';
import { AppError } from '../utils/appError.js';

export type MembershipRole = 'FACILITY_ADMIN' | 'STAFF';
export type MembershipStatus = 'INVITED' | 'ACTIVE' | 'REMOVED';

export interface MembershipRow {
  id: string;
  userId: string;
  facilityId: string;
  role: MembershipRole;
  status: MembershipStatus;
  joinedAt: Date | null;
}

const MEMBERSHIP_COLUMNS = {
  id: facilityMemberships.id,
  userId: facilityMemberships.userId,
  facilityId: facilityMemberships.facilityId,
  role: facilityMemberships.role,
  status: facilityMemberships.status,
  joinedAt: facilityMemberships.joinedAt,
} as const;

/** Only ever queries status = 'ACTIVE' - the one query every F:* authorization check is built on. */
export async function findActiveMembership(userId: string, facilityId: string): Promise<MembershipRow | undefined> {
  const [row] = await db
    .select(MEMBERSHIP_COLUMNS)
    .from(facilityMemberships)
    .where(and(eq(facilityMemberships.userId, userId), eq(facilityMemberships.facilityId, facilityId), eq(facilityMemberships.status, 'ACTIVE')))
    .limit(1);
  return row;
}

/** Any status - used only by the accept-invitation flow, which must see INVITED/ACTIVE/REMOVED to react correctly to each. */
export async function findMembership(userId: string, facilityId: string): Promise<MembershipRow | undefined> {
  const [row] = await db
    .select(MEMBERSHIP_COLUMNS)
    .from(facilityMemberships)
    .where(and(eq(facilityMemberships.userId, userId), eq(facilityMemberships.facilityId, facilityId)))
    .limit(1);
  return row;
}

export async function listByFacility(facilityId: string): Promise<MembershipRow[]> {
  return db.select(MEMBERSHIP_COLUMNS).from(facilityMemberships).where(eq(facilityMemberships.facilityId, facilityId));
}

/** The registration-time membership: created ACTIVE, not INVITED - the creator needs no separate acceptance step. */
export async function createActiveAdmin(userId: string, facilityId: string): Promise<{ id: string }> {
  const [row] = await db
    .insert(facilityMemberships)
    .values({ userId, facilityId, role: 'FACILITY_ADMIN', status: 'ACTIVE', joinedAt: new Date() })
    .returning({ id: facilityMemberships.id });
  return row!;
}

/**
 * Invites userId to facilityId. The unique (user_id, facility_id) constraint means there is at most
 * one row ever for this pair, so a facility that previously REMOVED this person and now wants to
 * re-invite them updates that same row back to INVITED rather than inserting a second one. Throws
 * AppError(409, 'ALREADY_MEMBER') if the person already holds an INVITED or ACTIVE membership.
 */
export async function inviteStaff(facilityId: string, userId: string, role: MembershipRole, invitedBy: string): Promise<{ id: string }> {
  const existing = await findMembership(userId, facilityId);
  if (existing && existing.status !== 'REMOVED') {
    throw new AppError(409, 'ALREADY_MEMBER', 'This person already has a membership at this facility.');
  }
  if (existing) {
    await db.update(facilityMemberships).set({ role, status: 'INVITED', invitedBy, joinedAt: null, updatedAt: new Date() }).where(eq(facilityMemberships.id, existing.id));
    return { id: existing.id };
  }
  const [row] = await db.insert(facilityMemberships).values({ userId, facilityId, role, status: 'INVITED', invitedBy }).returning({ id: facilityMemberships.id });
  return row!;
}

/** INVITED -> ACTIVE only. Throws if there is no membership row, or if it is not currently INVITED. */
export async function acceptInvitation(userId: string, facilityId: string): Promise<MembershipRow> {
  const existing = await findMembership(userId, facilityId);
  if (!existing) throw new AppError(404, 'NOT_FOUND', 'No invitation found.');
  if (existing.status === 'ACTIVE') return existing; // idempotent: already accepted
  if (existing.status === 'REMOVED') throw new AppError(409, 'CONFLICT', 'This membership was removed and cannot be accepted.');
  const [row] = await db
    .update(facilityMemberships)
    .set({ status: 'ACTIVE', joinedAt: new Date(), updatedAt: new Date() })
    .where(eq(facilityMemberships.id, existing.id))
    .returning(MEMBERSHIP_COLUMNS);
  return row!;
}

/**
 * ACTIVE -> REMOVED only. The row is never physically deleted.
 *
 * Refuses to remove the last ACTIVE FACILITY_ADMIN of a facility, whether that admin is removing
 * themselves or someone else is removing them - AppError(409, 'LAST_FACILITY_ADMIN'). The guard is
 * one atomic UPDATE (the WHERE clause's correlated count is evaluated as part of the same
 * statement), not a separate SELECT-then-UPDATE, so a concurrent removal of a different admin at
 * the same facility cannot race past it: 0 rows affected means either the guard tripped or someone
 * else already changed this row, and either way the removal did not happen.
 */
export async function removeMembership(facilityId: string, userId: string): Promise<void> {
  const existing = await findActiveMembership(userId, facilityId);
  if (!existing) throw new AppError(404, 'NOT_FOUND', 'No active membership found.');

  const rows = await db
    .update(facilityMemberships)
    .set({ status: 'REMOVED', updatedAt: new Date() })
    .where(
      sql`${facilityMemberships.id} = ${existing.id}
          AND ${facilityMemberships.status} = 'ACTIVE'
          AND (
            ${facilityMemberships.role} <> 'FACILITY_ADMIN'
            OR (
              SELECT count(*) FROM facility_memberships fm2
              WHERE fm2.facility_id = ${facilityMemberships.facilityId}
                AND fm2.role = 'FACILITY_ADMIN'
                AND fm2.status = 'ACTIVE'
            ) > 1
          )`,
    )
    .returning({ id: facilityMemberships.id });

  if (rows.length === 0) {
    throw new AppError(409, 'LAST_FACILITY_ADMIN', 'Cannot remove the last FACILITY_ADMIN of a facility.');
  }
}
