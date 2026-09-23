import { sql } from 'drizzle-orm';
import { boolean, check, index, pgTable, primaryKey, text, unique, uuid } from 'drizzle-orm/pg-core';
import { createdAt, dateStr, primaryId, tstz, updatedAt } from './columns.js';
import { roleCodeEnum, userStatusEnum } from './enums.js';

// DATABASE.md 2.1. `users` holds no PII beyond the Clerk link. All PII lives in `user_profiles`.
export const users = pgTable(
  'users',
  {
    id: primaryId(),
    clerkUserId: text('clerk_user_id').unique('users_clerk_user_id_key'),
    status: userStatusEnum('status').notNull().default('ACTIVE'),
    anonymizedAt: tstz('anonymized_at'),
    isDemo: boolean('is_demo').notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // Anonymized users have an anonymization time and no Clerk link; everyone else has a Clerk link (section 8).
    check('users_anonymized_consistent', sql`(${t.status} = 'ANONYMIZED') = (${t.anonymizedAt} IS NOT NULL)`),
    check('users_clerk_link_consistent', sql`(${t.status} = 'ANONYMIZED') = (${t.clerkUserId} IS NULL)`),
    index('users_status_idx').on(t.status),
  ],
);

// Every PII column is nullable: anonymization sets it to NULL instead of writing fake values (section 8).
export const userProfiles = pgTable(
  'user_profiles',
  {
    userId: uuid('user_id').primaryKey().references(() => users.id, { onDelete: 'restrict' }),
    fullName: text('full_name'),
    email: text('email'),
    phone: text('phone'),
    phoneVerifiedAt: tstz('phone_verified_at'),
    dateOfBirth: dateStr('date_of_birth'),
    address: text('address'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('user_profiles_verified_phone_exists', sql`${t.phoneVerifiedAt} IS NULL OR ${t.phone} IS NOT NULL`),
    check('user_profiles_dob_not_future', sql`${t.dateOfBirth} IS NULL OR ${t.dateOfBirth} <= CURRENT_DATE`),
  ],
);

export const roles = pgTable('roles', {
  id: primaryId(),
  code: roleCodeEnum('code').notNull().unique('roles_code_key'),
  createdAt: createdAt(),
});

// Global roles only (PATIENT, DONOR, ADMIN, SUPER_ADMIN). Facility access comes from facility_memberships.
export const userRoles = pgTable(
  'user_roles',
  {
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
    roleId: uuid('role_id').notNull().references(() => roles.id, { onDelete: 'restrict' }),
    grantedBy: uuid('granted_by').references(() => users.id, { onDelete: 'restrict' }),
    grantedAt: tstz('granted_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.roleId] }), index('user_roles_role_idx').on(t.roleId)],
);

// Minimal patient record: no diagnosis. `age_band` is the band supplied at creation, not an age.
export const patients = pgTable(
  'patients',
  {
    id: primaryId(),
    fullName: text('full_name'),
    ageBand: text('age_band').notNull(),
    createdBy: uuid('created_by').notNull().references(() => users.id, { onDelete: 'restrict' }),
    // Set only when the patient is the requester themself (`forSelf`, API.md 6.1).
    userId: uuid('user_id').references(() => users.id, { onDelete: 'restrict' }),
    isDemo: boolean('is_demo').notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // Lets blood_requests tie a patient to the requester who created it (API.md 6.1).
    unique('patients_id_creator_key').on(t.id, t.createdBy),
    check('patients_age_band_not_blank', sql`length(btrim(${t.ageBand})) > 0`),
    index('patients_created_by_idx').on(t.createdBy),
    index('patients_user_id_idx').on(t.userId).where(sql`${t.userId} IS NOT NULL`),
  ],
);
