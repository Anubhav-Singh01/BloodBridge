import { sql } from 'drizzle-orm';
import { boolean, check, foreignKey, index, jsonb, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core';
import { createdAt, primaryId, tstz, updatedAt } from './columns.js';
import { facilityStatusEnum, facilityTypeEnum, membershipRoleEnum, membershipStatusEnum, verificationStatusEnum } from './enums.js';
import { geographyPoint } from './geography.js';
import { users } from './identity.js';

// DATABASE.md 2.2. Verification and suspension are separate columns (API.md 11.1).
export const facilities = pgTable(
  'facilities',
  {
    id: primaryId(),
    facilityType: facilityTypeEnum('facility_type').notNull(),
    name: text('name').notNull(),
    registrationNo: text('registration_no'),
    contact: text('contact'),
    address: text('address'),
    location: geographyPoint('location'),
    verificationStatus: verificationStatusEnum('verification_status').notNull().default('PENDING'),
    status: facilityStatusEnum('status').notNull().default('ACTIVE'),
    createdBy: uuid('created_by').notNull().references(() => users.id, { onDelete: 'restrict' }),
    isDemo: boolean('is_demo').notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // Supports the composite foreign keys from hospitals and blood_banks.
    unique('facilities_id_type_key').on(t.id, t.facilityType),
    check('facilities_name_not_blank', sql`length(btrim(${t.name})) > 0`),
    // Verified facilities are listed publicly with a distance, so they need a location.
    check('facilities_verified_has_location', sql`${t.verificationStatus} <> 'VERIFIED' OR ${t.location} IS NOT NULL`),
    index('facilities_location_gist').using('gist', t.location),
    index('facilities_public_listing_idx').on(t.facilityType).where(sql`${t.verificationStatus} = 'VERIFIED' AND ${t.status} = 'ACTIVE'`),
    index('facilities_created_by_idx').on(t.createdBy),
  ],
);

// A hospital row can only point at a HOSPITAL facility: the type is part of the composite foreign key.
export const hospitals = pgTable(
  'hospitals',
  {
    facilityId: uuid('facility_id').primaryKey(),
    facilityType: facilityTypeEnum('facility_type').notNull().default('HOSPITAL'),
    hasEmergencyServices: boolean('has_emergency_services').notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('hospitals_type_is_hospital', sql`${t.facilityType} = 'HOSPITAL'`),
    foreignKey({
      name: 'hospitals_facility_fk',
      columns: [t.facilityId, t.facilityType],
      foreignColumns: [facilities.id, facilities.facilityType],
    }).onDelete('restrict'),
  ],
);

export const bloodBanks = pgTable(
  'blood_banks',
  {
    facilityId: uuid('facility_id').primaryKey(),
    facilityType: facilityTypeEnum('facility_type').notNull().default('BLOOD_BANK'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('blood_banks_type_is_blood_bank', sql`${t.facilityType} = 'BLOOD_BANK'`),
    foreignKey({
      name: 'blood_banks_facility_fk',
      columns: [t.facilityId, t.facilityType],
      foreignColumns: [facilities.id, facilities.facilityType],
    }).onDelete('restrict'),
  ],
);

// Facility access is derived from ACTIVE memberships (API.md 2.1), never from global roles.
export const facilityMemberships = pgTable(
  'facility_memberships',
  {
    id: primaryId(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
    facilityId: uuid('facility_id').notNull().references(() => facilities.id, { onDelete: 'restrict' }),
    role: membershipRoleEnum('role').notNull(),
    status: membershipStatusEnum('status').notNull().default('INVITED'),
    invitedBy: uuid('invited_by').references(() => users.id, { onDelete: 'restrict' }),
    joinedAt: tstz('joined_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('facility_memberships_user_facility_key').on(t.userId, t.facilityId),
    check(
      'facility_memberships_joined_consistent',
      sql`(${t.status} <> 'ACTIVE' OR ${t.joinedAt} IS NOT NULL) AND (${t.status} <> 'INVITED' OR ${t.joinedAt} IS NULL)`,
    ),
    // The hot authorization lookups only ever ask about ACTIVE memberships.
    index('facility_memberships_active_user_idx').on(t.userId).where(sql`${t.status} = 'ACTIVE'`),
    index('facility_memberships_active_facility_idx').on(t.facilityId).where(sql`${t.status} = 'ACTIVE'`),
  ],
);

// One record per facility, created or updated by the facility's submission (API.md 7). Metadata only in v1.
export const facilityVerifications = pgTable(
  'facility_verifications',
  {
    id: primaryId(),
    facilityId: uuid('facility_id').notNull().unique('facility_verifications_facility_key').references(() => facilities.id, { onDelete: 'restrict' }),
    registrationMetadata: jsonb('registration_metadata').notNull().default({}),
    status: verificationStatusEnum('status').notNull().default('PENDING'),
    reviewedBy: uuid('reviewed_by').references(() => users.id, { onDelete: 'restrict' }),
    reviewedAt: tstz('reviewed_at'),
    notes: text('notes'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check(
      'facility_verifications_review_recorded',
      sql`${t.status} NOT IN ('VERIFIED', 'REJECTED') OR (${t.reviewedBy} IS NOT NULL AND ${t.reviewedAt} IS NOT NULL)`,
    ),
    index('facility_verifications_open_idx').on(t.status).where(sql`${t.status} IN ('PENDING', 'UNDER_REVIEW')`),
  ],
);
