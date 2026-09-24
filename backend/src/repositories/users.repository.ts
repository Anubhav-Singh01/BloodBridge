import { eq, sql } from 'drizzle-orm';
import { db } from '../db/connection.js';
import { userProfiles, users } from '../db/schema/index.js';
import type { MappedClerkProfile } from '../webhooks/clerkMapping.js';

export interface UserRow {
  id: string;
  clerkUserId: string | null;
  status: 'ACTIVE' | 'SUSPENDED' | 'DELETION_PENDING' | 'ANONYMIZED';
}

export async function findByClerkUserId(clerkUserId: string): Promise<UserRow | undefined> {
  const [row] = await db.select({ id: users.id, clerkUserId: users.clerkUserId, status: users.status }).from(users).where(eq(users.clerkUserId, clerkUserId)).limit(1);
  return row;
}

export async function findById(userId: string): Promise<UserRow | undefined> {
  const [row] = await db.select({ id: users.id, clerkUserId: users.clerkUserId, status: users.status }).from(users).where(eq(users.id, userId)).limit(1);
  return row;
}

export interface ProfileRow {
  fullName: string | null;
  email: string | null;
  phone: string | null;
  phoneVerifiedAt: Date | null;
  dateOfBirth: string | null;
  address: string | null;
}

export async function findProfileByUserId(userId: string): Promise<ProfileRow | undefined> {
  const [row] = await db
    .select({
      fullName: userProfiles.fullName,
      email: userProfiles.email,
      phone: userProfiles.phone,
      phoneVerifiedAt: userProfiles.phoneVerifiedAt,
      dateOfBirth: userProfiles.dateOfBirth,
      address: userProfiles.address,
    })
    .from(userProfiles)
    .where(eq(userProfiles.userId, userId))
    .limit(1);
  return row;
}

/**
 * Ensures a `users` row exists for this Clerk user, then upserts `user_profiles` from the mapped
 * fields. One transaction. Returns our internal user id. Used by the Clerk webhook only
 * (services/clerkSyncService.ts) - never called with data from anywhere else.
 */
export async function upsertFromClerk(profile: MappedClerkProfile): Promise<{ id: string }> {
  return db.transaction(async (tx) => {
    const [userRow] = await tx
      .insert(users)
      .values({ clerkUserId: profile.clerkUserId })
      .onConflictDoUpdate({ target: users.clerkUserId, set: { updatedAt: new Date() } })
      .returning({ id: users.id });
    const userId = userRow!.id;

    await tx
      .insert(userProfiles)
      .values({
        userId,
        fullName: profile.fullName,
        email: profile.email,
        phone: profile.phone,
        // First sync ever for this user: there is no existing row to preserve a timestamp from.
        phoneVerifiedAt: profile.phoneVerified ? new Date() : null,
      })
      .onConflictDoUpdate({
        target: userProfiles.userId,
        set: {
          fullName: profile.fullName,
          email: profile.email,
          phone: profile.phone,
          // unverified -> verified: stamp now(). verified -> still verified: COALESCE keeps the
          // existing timestamp instead of re-stamping it. verified -> unverified: NULL. The bare
          // (unaliased) column reference here is the pre-update row's value, per Postgres's own
          // ON CONFLICT DO UPDATE SET semantics - not the newly proposed insert.
          phoneVerifiedAt: profile.phoneVerified ? sql`coalesce(${userProfiles.phoneVerifiedAt}, now())` : null,
          updatedAt: new Date(),
        },
      });

    return { id: userId };
  });
}

export interface ProfileUpdate {
  fullName?: string | null | undefined;
  dateOfBirth?: string | null | undefined;
  address?: string | null | undefined;
}

/**
 * PATCH /users/me. Deliberately excludes email and phone: those are synced from Clerk
 * (services/clerkSyncService.ts) and are not accepted from this endpoint, to avoid two
 * disagreeing sources of truth for the same field.
 */
export async function updateProfile(userId: string, patch: ProfileUpdate): Promise<void> {
  if (Object.keys(patch).length === 0) return;
  await db.update(userProfiles).set({ ...patch, updatedAt: new Date() }).where(eq(userProfiles.userId, userId));
}

export async function setStatus(userId: string, status: UserRow['status']): Promise<void> {
  await db.update(users).set({ status, updatedAt: new Date() }).where(eq(users.id, userId));
}
