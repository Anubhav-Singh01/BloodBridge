import { and, eq } from 'drizzle-orm';
import { db } from '../db/connection.js';
import { roles, userRoles } from '../db/schema/index.js';

export type RoleCode = 'PATIENT' | 'DONOR' | 'ADMIN' | 'SUPER_ADMIN';

/** The only place role codes are read for a user. Never read from JWT claims or the request body. */
export async function listRoleCodesForUser(userId: string): Promise<RoleCode[]> {
  const rows = await db.select({ code: roles.code }).from(userRoles).innerJoin(roles, eq(userRoles.roleId, roles.id)).where(eq(userRoles.userId, userId));
  return rows.map((r) => r.code);
}

/**
 * Grants `code` to `userId` if not already held. Idempotent: a second call for the same
 * (user, role) is a no-op via the table's own composite primary key, and this function reports
 * that as `alreadyEnrolled: true` rather than throwing.
 */
export async function enrollRole(userId: string, code: RoleCode, grantedBy: string | null = null): Promise<{ alreadyEnrolled: boolean }> {
  const [role] = await db.select({ id: roles.id }).from(roles).where(eq(roles.code, code)).limit(1);
  if (!role) {
    // The reference seed (Batch 3.8) always creates all 4 codes; this would mean the dev/test
    // branch was never seeded.
    throw new Error(`Role code "${code}" is not present in the roles table. Has the reference seed been applied?`);
  }

  const existing = await db
    .select({ userId: userRoles.userId })
    .from(userRoles)
    .where(and(eq(userRoles.userId, userId), eq(userRoles.roleId, role.id)))
    .limit(1);
  if (existing.length > 0) return { alreadyEnrolled: true };

  await db
    .insert(userRoles)
    .values({ userId, roleId: role.id, grantedBy })
    .onConflictDoNothing({ target: [userRoles.userId, userRoles.roleId] });
  return { alreadyEnrolled: false };
}
