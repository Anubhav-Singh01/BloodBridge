import { sql } from 'drizzle-orm';
import { boolean, check, index, jsonb, pgTable, text, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, primaryId, tstz, updatedAt } from './columns.js';
import { deletionRequestSourceEnum, deletionRequestStatusEnum, deliveryStatusEnum, notificationChannelEnum } from './enums.js';
import { donors } from './donors.js';
import { users } from './identity.js';
import { donorMatches } from './matching.js';
import { bloodRequests } from './requests.js';

// DATABASE.md 2.8, 8 and 9. Guard triggers are in 0006_schema_c_guards.sql.
// `analytics_daily` (listed in 2.8) is deferred: no document defines its metrics, so its shape is not part of this batch.

// In-app notifications. `read_at` is the "seen" time that ML.md calls seen_at.
export const notifications = pgTable(
  'notifications',
  {
    id: primaryId(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
    // Upper-case code chosen by the notification service. The set grows with features, so it is a code, not an enum.
    type: text('type').notNull(),
    // Content is cleared on anonymization (DATABASE.md section 8), so both are nullable.
    title: text('title'),
    body: text('body'),
    // Identifiers and codes only. No PII goes in here.
    data: jsonb('data').notNull().default({}),
    requestId: uuid('request_id').references(() => bloodRequests.id, { onDelete: 'restrict' }),
    matchId: uuid('match_id').references(() => donorMatches.id, { onDelete: 'restrict' }),
    readAt: tstz('read_at'),
    createdAt: createdAt(),
  },
  (t) => [
    check('notifications_type_format', sql`${t.type} ~ '^[A-Z][A-Z0-9_]*$'`),
    check('notifications_data_is_object', sql`jsonb_typeof(${t.data}) = 'object'`),
    index('notifications_user_idx').on(t.userId, t.createdAt.desc()),
    index('notifications_unread_idx').on(t.userId).where(sql`${t.readAt} IS NULL`),
    index('notifications_request_idx').on(t.requestId).where(sql`${t.requestId} IS NOT NULL`),
    index('notifications_match_idx').on(t.matchId).where(sql`${t.matchId} IS NOT NULL`),
  ],
);

// The one CASCADE in the schema: a delivery is a pure child row with no evidentiary value (DATABASE.md, top).
// `status` is the delivery_status that ML.md refers to.
export const notificationDeliveries = pgTable(
  'notification_deliveries',
  {
    id: primaryId(),
    notificationId: uuid('notification_id').notNull().references(() => notifications.id, { onDelete: 'cascade' }),
    channel: notificationChannelEnum('channel').notNull(),
    provider: text('provider'),
    status: deliveryStatusEnum('status').notNull().default('PENDING'),
    error: text('error'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // A retry updates the same row, so a notification has at most one delivery per channel.
    unique('notification_deliveries_notification_channel_key').on(t.notificationId, t.channel),
    check('notification_deliveries_error_only_when_failed', sql`${t.error} IS NULL OR ${t.status} = 'FAILED'`),
    index('notification_deliveries_pending_idx').on(t.createdAt).where(sql`${t.status} = 'PENDING'`),
  ],
);

// Runtime configuration. A row with scope and urgency both NULL is the global default (DATABASE.md 2.8).
export const settings = pgTable(
  'settings',
  {
    id: primaryId(),
    key: text('key').notNull(),
    value: jsonb('value').notNull(),
    // Reserved and NULL in v1.
    scope: text('scope'),
    // OPEN DECISION: nullable text until the urgency taxonomy is decided (same as blood_requests.urgency).
    urgency: text('urgency'),
    updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'restrict' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // NULLS NOT DISTINCT (PostgreSQL 15+): two global defaults for one key are a conflict, not two distinct rows.
    unique('settings_key_scope_urgency_key').on(t.key, t.scope, t.urgency).nullsNotDistinct(),
    check('settings_key_format', sql`${t.key} ~ '^[A-Za-z][A-Za-z0-9_.]*$'`),
    check('settings_scope_reserved', sql`${t.scope} IS NULL`),
  ],
);

// Append-only (guard triggers). Ids and action codes only, never PII, so anonymization never has to edit it (section 8).
export const auditLogs = pgTable(
  'audit_logs',
  {
    id: primaryId(),
    // NULL when the system acted.
    actorId: uuid('actor_id').references(() => users.id, { onDelete: 'restrict' }),
    // Upper-case code such as ROLE_GRANTED or DONOR_VERIFICATION_SUBMITTED (API.md).
    action: text('action').notNull(),
    entityType: text('entity_type'),
    entityId: uuid('entity_id'),
    // The X-Request-ID of the call that caused the entry (API.md 1.2).
    correlationId: text('correlation_id'),
    details: jsonb('details').notNull().default({}),
    at: tstz('at').notNull().defaultNow(),
  },
  (t) => [
    check('audit_logs_action_format', sql`${t.action} ~ '^[A-Z][A-Z0-9_]*$'`),
    check('audit_logs_entity_type_format', sql`${t.entityType} IS NULL OR ${t.entityType} ~ '^[A-Z][A-Z0-9_]*$'`),
    check('audit_logs_entity_needs_type', sql`${t.entityId} IS NULL OR ${t.entityType} IS NOT NULL`),
    check('audit_logs_details_is_object', sql`jsonb_typeof(${t.details}) = 'object'`),
    index('audit_logs_at_idx').on(t.at.desc()),
    index('audit_logs_entity_idx').on(t.entityType, t.entityId, t.at).where(sql`${t.entityId} IS NOT NULL`),
    index('audit_logs_actor_idx').on(t.actorId, t.at.desc()).where(sql`${t.actorId} IS NOT NULL`),
    index('audit_logs_action_idx').on(t.action, t.at.desc()),
  ],
);

// Idempotent webhook handling (API.md 12): insert first, process only if the insert was new. The payload is not stored
// because Clerk events carry personal data.
export const webhookEvents = pgTable(
  'webhook_events',
  {
    id: primaryId(),
    provider: text('provider').notNull(),
    providerEventId: text('provider_event_id').notNull(),
    eventType: text('event_type').notNull(),
    receivedAt: tstz('received_at').notNull().defaultNow(),
    processedAt: tstz('processed_at'),
    lastError: text('last_error'),
  },
  (t) => [
    unique('webhook_events_provider_event_key').on(t.provider, t.providerEventId),
    check('webhook_events_fields_not_blank', sql`length(btrim(${t.provider})) > 0 AND length(btrim(${t.providerEventId})) > 0 AND length(btrim(${t.eventType})) > 0`),
    index('webhook_events_unprocessed_idx').on(t.receivedAt).where(sql`${t.processedAt} IS NULL`),
  ],
);

// Append-only. Every exact-location read by a person is logged here and in audit_logs (DATABASE.md section 9).
export const locationAccessLogs = pgTable(
  'location_access_logs',
  {
    id: primaryId(),
    // Who read the location.
    accessorId: uuid('accessor_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
    donorId: uuid('donor_id').notNull().references(() => donors.id, { onDelete: 'restrict' }),
    // Nullable: an audited admin exception (section 9) need not relate to a request.
    requestId: uuid('request_id').references(() => bloodRequests.id, { onDelete: 'restrict' }),
    // Upper-case code.
    purpose: text('purpose').notNull(),
    at: tstz('at').notNull().defaultNow(),
  },
  (t) => [
    check('location_access_logs_purpose_format', sql`${t.purpose} ~ '^[A-Z][A-Z0-9_]*$'`),
    index('location_access_logs_donor_idx').on(t.donorId, t.at.desc()),
    index('location_access_logs_accessor_idx').on(t.accessorId, t.at.desc()),
  ],
);

// Created by Clerk `user.deleted` or by the user's own request (DATABASE.md section 8). Anonymization runs as a job.
export const dataDeletionRequests = pgTable(
  'data_deletion_requests',
  {
    id: primaryId(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
    source: deletionRequestSourceEnum('source').notNull(),
    status: deletionRequestStatusEnum('status').notNull().default('PENDING'),
    // A legal hold pauses anonymization of the affected records.
    legalHold: boolean('legal_hold').notNull().default(false),
    completedAt: tstz('completed_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('data_deletion_requests_completion_recorded', sql`(${t.status} = 'COMPLETED') = (${t.completedAt} IS NOT NULL)`),
    check('data_deletion_requests_hold_blocks_completion', sql`NOT (${t.status} = 'COMPLETED' AND ${t.legalHold})`),
    // A repeated Clerk event or a second click cannot open a second request while one is pending.
    uniqueIndex('data_deletion_requests_one_pending_per_user').on(t.userId).where(sql`${t.status} = 'PENDING'`),
    index('data_deletion_requests_user_idx').on(t.userId),
  ],
);

// Backs the Idempotency-Key header (API.md 1.4). `response_ref` stays NULL while the first call is still running.
export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    id: primaryId(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
    key: text('key').notNull(),
    requestFingerprint: text('request_fingerprint').notNull(),
    responseRef: text('response_ref'),
    createdAt: createdAt(),
    // Set from the retention setting when the key is stored (an unseeded setting, so the service supplies it).
    expiresAt: tstz('expires_at').notNull(),
  },
  (t) => [
    unique('idempotency_keys_user_key_key').on(t.userId, t.key),
    check('idempotency_keys_key_not_blank', sql`length(btrim(${t.key})) > 0 AND length(btrim(${t.requestFingerprint})) > 0`),
    check('idempotency_keys_expiry_after_creation', sql`${t.expiresAt} > ${t.createdAt}`),
    index('idempotency_keys_expiry_idx').on(t.expiresAt),
  ],
);
