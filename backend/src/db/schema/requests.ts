import { sql } from 'drizzle-orm';
import { boolean, check, foreignKey, index, integer, jsonb, pgTable, primaryKey, text, uuid } from 'drizzle-orm/pg-core';
import { createdAt, primaryId, tstz, updatedAt } from './columns.js';
import { bloodComponentEnum, bloodGroupEnum, requestActorKindEnum, requestEventTypeEnum, requestStatusEnum } from './enums.js';
import { hospitals } from './facilities.js';
import { geographyPoint } from './geography.js';
import { patients, users } from './identity.js';
import { donorMatches } from './matching.js';

// DATABASE.md 2.6. Status changes go through the state-machine trigger in 0004_schema_b_guards.sql.
export const bloodRequests = pgTable(
  'blood_requests',
  {
    id: primaryId(),
    requesterId: uuid('requester_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
    // The patient's foreign key is composite (below): a requester may only use patient records they created.
    patientId: uuid('patient_id').notNull(),
    hospitalId: uuid('hospital_id').notNull().references(() => hospitals.facilityId, { onDelete: 'restrict' }),
    bloodGroup: bloodGroupEnum('blood_group').notNull(),
    component: bloodComponentEnum('component').notNull(),
    unitsRequired: integer('units_required').notNull(),
    requiredDonors: integer('required_donors').notNull(),
    // OPEN DECISION: the urgency levels are undefined, so this is nullable text with no CHECK and no index.
    urgency: text('urgency'),
    isEmergency: boolean('is_emergency').notNull().default(false),
    requiredBy: tstz('required_by').notNull(),
    reasonCategory: text('reason_category'),
    contactPhone: text('contact_phone'),
    contactPerson: text('contact_person'),
    additionalInfo: text('additional_info'),
    // A copy of the hospital's location, set by the server when the request is created.
    location: geographyPoint('location').notNull(),
    status: requestStatusEnum('status').notNull().default('DRAFT'),
    expiresAt: tstz('expires_at'),
    isDemo: boolean('is_demo').notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({
      name: 'blood_requests_patient_creator_fk',
      columns: [t.patientId, t.requesterId],
      foreignColumns: [patients.id, patients.createdBy],
    }).onDelete('restrict'),
    check('blood_requests_units_positive', sql`${t.unitsRequired} > 0`),
    check('blood_requests_donors_positive', sql`${t.requiredDonors} > 0`),
    // Every submitted request expires (the expiry job needs a time).
    check('blood_requests_expiry_set', sql`${t.status} = 'DRAFT' OR ${t.expiresAt} IS NOT NULL`),
    index('blood_requests_status_idx').on(t.status),
    index('blood_requests_hospital_status_idx').on(t.hospitalId, t.status),
    index('blood_requests_requester_idx').on(t.requesterId, t.createdAt.desc()),
    index('blood_requests_open_expiry_idx')
      .on(t.expiresAt)
      .where(sql`${t.status} NOT IN ('FULFILLED', 'CANCELLED', 'EXPIRED', 'REJECTED') AND ${t.expiresAt} IS NOT NULL`),
    index('blood_requests_location_gist').using('gist', t.location),
  ],
);

// Append-only (guard triggers in 0004). The first row of a request has no from_status.
export const bloodRequestStatusHistory = pgTable(
  'blood_request_status_history',
  {
    id: primaryId(),
    requestId: uuid('request_id').notNull().references(() => bloodRequests.id, { onDelete: 'restrict' }),
    fromStatus: requestStatusEnum('from_status'),
    toStatus: requestStatusEnum('to_status').notNull(),
    actorId: uuid('actor_id').references(() => users.id, { onDelete: 'restrict' }),
    reason: text('reason'),
    at: tstz('at').notNull().defaultNow(),
  },
  (t) => [
    check('blood_request_status_history_first_is_draft', sql`${t.fromStatus} IS NOT NULL OR ${t.toStatus} = 'DRAFT'`),
    check('blood_request_status_history_changes_status', sql`${t.fromStatus} IS NULL OR ${t.fromStatus} <> ${t.toStatus}`),
    index('blood_request_status_history_request_idx').on(t.requestId, t.at),
  ],
);

// The allowed transitions (DATABASE.md section 4). The rows are inserted by 0004_schema_b_guards.sql,
// so the state-machine trigger never runs against an empty table.
export const requestTransitions = pgTable(
  'request_transitions',
  {
    fromStatus: requestStatusEnum('from_status').notNull(),
    toStatus: requestStatusEnum('to_status').notNull(),
    allowedActors: requestActorKindEnum('allowed_actors').array().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.fromStatus, t.toStatus] }),
    check('request_transitions_changes_status', sql`${t.fromStatus} <> ${t.toStatus}`),
    check('request_transitions_has_actor', sql`cardinality(${t.allowedActors}) > 0`),
  ],
);

// Timeline entries only. They never change a status (DATABASE.md 2.6). Append-only.
export const requestEvents = pgTable(
  'request_events',
  {
    id: primaryId(),
    requestId: uuid('request_id').notNull().references(() => bloodRequests.id, { onDelete: 'restrict' }),
    // The match must belong to this request's search. trg_request_events_match_guard (0006) enforces that.
    matchId: uuid('match_id').references(() => donorMatches.id, { onDelete: 'restrict' }),
    eventType: requestEventTypeEnum('event_type').notNull(),
    actorId: uuid('actor_id').references(() => users.id, { onDelete: 'restrict' }),
    at: tstz('at').notNull().defaultNow(),
    details: jsonb('details').notNull().default({}),
  },
  (t) => [
    index('request_events_request_idx').on(t.requestId, t.at),
    index('request_events_match_idx').on(t.matchId).where(sql`${t.matchId} IS NOT NULL`),
  ],
);

// Rule-based suspicion flags for admin review. A flag is open until it is resolved.
export const requestFlags = pgTable(
  'request_flags',
  {
    id: primaryId(),
    requestId: uuid('request_id').notNull().references(() => bloodRequests.id, { onDelete: 'restrict' }),
    ruleCode: text('rule_code').notNull(),
    details: jsonb('details').notNull().default({}),
    createdAt: createdAt(),
    resolvedAt: tstz('resolved_at'),
    resolvedBy: uuid('resolved_by').references(() => users.id, { onDelete: 'restrict' }),
    resolutionNote: text('resolution_note'),
  },
  (t) => [
    check('request_flags_rule_code_format', sql`${t.ruleCode} ~ '^[A-Z][A-Z0-9_]*$'`),
    check('request_flags_resolution_recorded', sql`(${t.resolvedAt} IS NULL) = (${t.resolvedBy} IS NULL)`),
    index('request_flags_request_idx').on(t.requestId),
    index('request_flags_open_idx').on(t.createdAt).where(sql`${t.resolvedAt} IS NULL`),
  ],
);
