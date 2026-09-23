import { sql } from 'drizzle-orm';
import { type AnyPgColumn, boolean, check, foreignKey, index, pgTable, text, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, primaryId, tstz, updatedAt } from './columns.js';
import { bloodComponentEnum, bloodGroupEnum, bloodUnitEventTypeEnum, bloodUnitStatusEnum, reservationStatusEnum } from './enums.js';
import { donationHistory } from './donors.js';
import { facilities } from './facilities.js';
import { users } from './identity.js';
import { bloodRequests } from './requests.js';

// DATABASE.md 2.5. Units are never deleted (traceability). Guard triggers are in 0004_schema_b_guards.sql.
export const bloodUnits = pgTable(
  'blood_units',
  {
    id: primaryId(),
    // System-issued, globally unique and immutable. The format is chosen when the inventory service is built.
    unitUid: text('unit_uid').notNull().unique('blood_units_unit_uid_key'),
    facilityUnitCode: text('facility_unit_code').notNull(),
    // Current custodian. Changes only through a transfer.
    facilityId: uuid('facility_id').notNull().references(() => facilities.id, { onDelete: 'restrict' }),
    originFacilityId: uuid('origin_facility_id').notNull().references(() => facilities.id, { onDelete: 'restrict' }),
    sourceDonationId: uuid('source_donation_id').references(() => donationHistory.id, { onDelete: 'restrict' }),
    bloodGroup: bloodGroupEnum('blood_group').notNull(),
    component: bloodComponentEnum('component').notNull(),
    collectedAt: tstz('collected_at').notNull(),
    expiresAt: tstz('expires_at').notNull(),
    status: bloodUnitStatusEnum('status').notNull().default('AVAILABLE'),
    // Set if and only if status = RESERVED. The composite foreign key below ties it to a reservation of THIS unit.
    activeReservationId: uuid('active_reservation_id').unique('blood_units_active_reservation_key'),
    storageLocation: text('storage_location'),
    isDemo: boolean('is_demo').notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('blood_units_facility_code_key').on(t.facilityId, t.facilityUnitCode),
    check('blood_units_expiry_after_collection', sql`${t.expiresAt} > ${t.collectedAt}`),
    check('blood_units_reserved_has_reservation', sql`(${t.status} = 'RESERVED') = (${t.activeReservationId} IS NOT NULL)`),
    check('blood_units_identifiers_not_blank', sql`length(btrim(${t.unitUid})) > 0 AND length(btrim(${t.facilityUnitCode})) > 0`),
    foreignKey({
      name: 'blood_units_active_reservation_fk',
      columns: [t.activeReservationId, t.id],
      foreignColumns: [inventoryReservations.id, inventoryReservations.unitId],
    }).onDelete('restrict'),
    index('blood_units_availability_idx').on(t.facilityId, t.bloodGroup, t.component, t.expiresAt).where(sql`${t.status} = 'AVAILABLE'`),
    index('blood_units_expiry_idx').on(t.expiresAt).where(sql`${t.status} IN ('AVAILABLE', 'RESERVED')`),
    index('blood_units_facility_status_idx').on(t.facilityId, t.status),
    index('blood_units_origin_idx').on(t.originFacilityId),
    index('blood_units_source_donation_idx').on(t.sourceDonationId).where(sql`${t.sourceDonationId} IS NOT NULL`),
  ],
);

// Append-only custody trail (guard triggers in 0004). `reason` records, for example, why a unit was discarded.
export const bloodUnitEvents = pgTable(
  'blood_unit_events',
  {
    id: primaryId(),
    unitId: uuid('unit_id').notNull().references(() => bloodUnits.id, { onDelete: 'restrict' }),
    event: bloodUnitEventTypeEnum('event').notNull(),
    fromFacilityId: uuid('from_facility_id').references(() => facilities.id, { onDelete: 'restrict' }),
    toFacilityId: uuid('to_facility_id').references(() => facilities.id, { onDelete: 'restrict' }),
    requestId: uuid('request_id').references(() => bloodRequests.id, { onDelete: 'restrict' }),
    // NULL when the system acted (for example the expiry job).
    actorId: uuid('actor_id').references(() => users.id, { onDelete: 'restrict' }),
    reason: text('reason'),
    at: tstz('at').notNull().defaultNow(),
  },
  (t) => [
    check(
      'blood_unit_events_transfer_facilities',
      sql`${t.event} <> 'TRANSFERRED' OR (${t.fromFacilityId} IS NOT NULL AND ${t.toFacilityId} IS NOT NULL AND ${t.fromFacilityId} <> ${t.toFacilityId})`,
    ),
    check('blood_unit_events_request_required', sql`${t.event} NOT IN ('RESERVED', 'RELEASED', 'ISSUED') OR ${t.requestId} IS NOT NULL`),
    index('blood_unit_events_unit_idx').on(t.unitId, t.at),
    index('blood_unit_events_request_idx').on(t.requestId).where(sql`${t.requestId} IS NOT NULL`),
  ],
);

// DATABASE.md 2.5 and 10. One ACTIVE reservation per unit, whatever the application does.
export const inventoryReservations = pgTable(
  'inventory_reservations',
  {
    id: primaryId(),
    // Explicit return type: blood_units and inventory_reservations reference each other (same pattern as in donors.ts).
    unitId: uuid('unit_id').notNull().references((): AnyPgColumn => bloodUnits.id, { onDelete: 'restrict' }),
    requestId: uuid('request_id').notNull().references(() => bloodRequests.id, { onDelete: 'restrict' }),
    status: reservationStatusEnum('status').notNull().default('ACTIVE'),
    reservedBy: uuid('reserved_by').notNull().references(() => users.id, { onDelete: 'restrict' }),
    reservedAt: tstz('reserved_at').notNull().defaultNow(),
    // The reservation lifetime is an unseeded setting, so the service must supply it.
    expiresAt: tstz('expires_at').notNull(),
    releasedAt: tstz('released_at'),
    releaseReason: text('release_reason'),
  },
  (t) => [
    unique('inventory_reservations_id_unit_key').on(t.id, t.unitId),
    uniqueIndex('inventory_reservations_one_active_per_unit').on(t.unitId).where(sql`${t.status} = 'ACTIVE'`),
    check('inventory_reservations_expiry_after_reserved', sql`${t.expiresAt} > ${t.reservedAt}`),
    // RELEASED and EXPIRED reservations record when they ended. ACTIVE and ISSUED ones have no end fields.
    check('inventory_reservations_end_recorded', sql`(${t.status} IN ('RELEASED', 'EXPIRED')) = (${t.releasedAt} IS NOT NULL)`),
    check('inventory_reservations_reason_only_when_ended', sql`${t.releaseReason} IS NULL OR ${t.status} IN ('RELEASED', 'EXPIRED')`),
    index('inventory_reservations_request_idx').on(t.requestId, t.status),
    index('inventory_reservations_active_expiry_idx').on(t.expiresAt).where(sql`${t.status} = 'ACTIVE'`),
  ],
);
