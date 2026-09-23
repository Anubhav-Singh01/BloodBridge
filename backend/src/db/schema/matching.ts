import { sql } from 'drizzle-orm';
import { boolean, check, doublePrecision, foreignKey, index, integer, jsonb, pgTable, text, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, primaryId, tstz, updatedAt } from './columns.js';
import { batchStatusEnum, donorResponseKindEnum, matchStatusEnum, modelStatusEnum, rankerTypeEnum, rankingTriggerEnum, searchStatusEnum } from './enums.js';
import { donors } from './donors.js';
import { users } from './identity.js';
import { bloodRequests } from './requests.js';

// DATABASE.md 2.7, 5, 6 and 7. Guard triggers are in 0006_schema_c_guards.sql.

// One search per request. The settings it started with are frozen in `config_snapshot` (ARCHITECTURE.md section 4).
export const donorSearches = pgTable(
  'donor_searches',
  {
    id: primaryId(),
    requestId: uuid('request_id').notNull().unique('donor_searches_request_key').references(() => bloodRequests.id, { onDelete: 'restrict' }),
    configSnapshot: jsonb('config_snapshot').notNull(),
    status: searchStatusEnum('status').notNull().default('ACTIVE'),
    requiredDonors: integer('required_donors').notNull(),
    confirmedCount: integer('confirmed_count').notNull().default(0),
    batchCount: integer('batch_count').notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('donor_searches_required_positive', sql`${t.requiredDonors} > 0`),
    // Backstop for the acceptance transaction (DATABASE.md section 5): the counter can never exceed the target.
    check('donor_searches_confirmed_within_required', sql`${t.confirmedCount} >= 0 AND ${t.confirmedCount} <= ${t.requiredDonors}`),
    check('donor_searches_batch_count_non_negative', sql`${t.batchCount} >= 0`),
    check('donor_searches_config_is_object', sql`jsonb_typeof(${t.configSnapshot}) = 'object'`),
    index('donor_searches_active_idx').on(t.status).where(sql`${t.status} = 'ACTIVE'`),
  ],
);

// One row per ranking execution (append-only). `ranked_at` supports the freshness window in ARCHITECTURE.md section 4.
export const rankingRuns = pgTable(
  'ranking_runs',
  {
    id: primaryId(),
    searchId: uuid('search_id').notNull().references(() => donorSearches.id, { onDelete: 'restrict' }),
    rankerType: rankerTypeEnum('ranker_type').notNull(),
    // 'rule-based-fallback' for the fallback ranker (ML.md section 6), the ml_model_versions.model_version otherwise.
    modelVersion: text('model_version').notNull(),
    rankedAt: tstz('ranked_at').notNull().defaultNow(),
    // Named trigger_type because "trigger" is an SQL keyword (same rename as donor_eligibility_calculations).
    triggerType: rankingTriggerEnum('trigger_type').notNull(),
    inputCount: integer('input_count').notNull(),
  },
  (t) => [
    // Lets notification_batches tie a batch to a run of its own search with a composite foreign key.
    unique('ranking_runs_id_search_key').on(t.id, t.searchId),
    check('ranking_runs_input_count_non_negative', sql`${t.inputCount} >= 0`),
    check('ranking_runs_model_version_not_blank', sql`length(btrim(${t.modelVersion})) > 0`),
    // The fallback ranker is never presented as ML, and an ML run never carries the fallback label.
    check('ranking_runs_fallback_version', sql`(${t.rankerType} = 'FALLBACK') = (${t.modelVersion} = 'rule-based-fallback')`),
    index('ranking_runs_search_idx').on(t.searchId, t.rankedAt.desc()),
  ],
);

// Append-only. The sole source of the score and feature snapshot used for ranking and contact (DATABASE.md section 7).
export const rankingPredictions = pgTable(
  'ranking_predictions',
  {
    id: primaryId(),
    rankingRunId: uuid('ranking_run_id').notNull().references(() => rankingRuns.id, { onDelete: 'restrict' }),
    donorId: uuid('donor_id').notNull().references(() => donors.id, { onDelete: 'restrict' }),
    rank: integer('rank').notNull(),
    score: doublePrecision('score').notNull(),
    // Coarse operational labels (ML.md section 5). No PII and no coordinates.
    reasons: jsonb('reasons').notNull().default([]),
    featureSnapshot: jsonb('feature_snapshot').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique('ranking_predictions_run_donor_key').on(t.rankingRunId, t.donorId),
    // Lets donor_matches tie its selected prediction to the same donor with a composite foreign key.
    unique('ranking_predictions_id_donor_key').on(t.id, t.donorId),
    check('ranking_predictions_rank_positive', sql`${t.rank} >= 1`),
    check('ranking_predictions_reasons_is_array', sql`jsonb_typeof(${t.reasons}) = 'array'`),
    check('ranking_predictions_snapshot_is_object', sql`jsonb_typeof(${t.featureSnapshot}) = 'object'`),
    index('ranking_predictions_donor_idx').on(t.donorId, t.createdAt.desc()),
  ],
);

// One notification round. At most one ACTIVE batch per search (DATABASE.md 2.7).
export const notificationBatches = pgTable(
  'notification_batches',
  {
    id: primaryId(),
    searchId: uuid('search_id').notNull().references(() => donorSearches.id, { onDelete: 'restrict' }),
    batchNumber: integer('batch_number').notNull(),
    openedAt: tstz('opened_at').notNull().defaultNow(),
    expiresAt: tstz('expires_at').notNull(),
    status: batchStatusEnum('status').notNull().default('PENDING'),
    // The run must belong to the same search (composite foreign key below). NULL skips that check.
    rankingRunId: uuid('ranking_run_id'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('notification_batches_search_number_key').on(t.searchId, t.batchNumber),
    // Lets donor_matches reference a batch of its own search with a composite foreign key.
    unique('notification_batches_id_search_key').on(t.id, t.searchId),
    foreignKey({
      name: 'notification_batches_run_fk',
      columns: [t.rankingRunId, t.searchId],
      foreignColumns: [rankingRuns.id, rankingRuns.searchId],
    }).onDelete('restrict'),
    uniqueIndex('notification_batches_one_active_per_search').on(t.searchId).where(sql`${t.status} = 'ACTIVE'`),
    check('notification_batches_number_positive', sql`${t.batchNumber} > 0`),
    check('notification_batches_expiry_after_open', sql`${t.expiresAt} > ${t.openedAt}`),
    // The evaluation job scans open batches by expiry.
    index('notification_batches_open_expiry_idx').on(t.expiresAt).where(sql`${t.status} = 'ACTIVE'`),
    index('notification_batches_ranking_run_idx').on(t.rankingRunId).where(sql`${t.rankingRunId} IS NOT NULL`),
  ],
);

// The donor's live state in a search: exactly one row per donor per search (DATABASE.md section 6).
export const donorMatches = pgTable(
  'donor_matches',
  {
    id: primaryId(),
    searchId: uuid('search_id').notNull().references(() => donorSearches.id, { onDelete: 'restrict' }),
    donorId: uuid('donor_id').notNull().references(() => donors.id, { onDelete: 'restrict' }),
    // Both foreign keys below are composite, so they are declared in the table config.
    batchId: uuid('batch_id'),
    selectedPredictionId: uuid('selected_prediction_id'),
    status: matchStatusEnum('status').notNull().default('CANDIDATE'),
    distanceKm: doublePrecision('distance_km'),
    etaMinutes: integer('eta_minutes'),
    fatigueBypass: boolean('fatigue_bypass').notNull().default(false),
    exclusionReason: text('exclusion_reason'),
    notifiedAt: tstz('notified_at'),
    respondedAt: tstz('responded_at'),
    arrivedAt: tstz('arrived_at'),
    locationConsentAt: tstz('location_consent_at'),
    dropReason: text('drop_reason'),
    droppedBy: uuid('dropped_by').references(() => users.id, { onDelete: 'restrict' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('donor_matches_search_donor_key').on(t.searchId, t.donorId),
    // A match can only reference a batch of its own search (section 6).
    foreignKey({
      name: 'donor_matches_batch_fk',
      columns: [t.batchId, t.searchId],
      foreignColumns: [notificationBatches.id, notificationBatches.searchId],
    }).onDelete('restrict'),
    // The prediction used for contact must be a prediction for this same donor (section 7).
    foreignKey({
      name: 'donor_matches_prediction_fk',
      columns: [t.selectedPredictionId, t.donorId],
      foreignColumns: [rankingPredictions.id, rankingPredictions.donorId],
    }).onDelete('restrict'),
    // CANDIDATE and EXCLUDED donors were never contacted. Every other status has a batch and a notification time.
    check(
      'donor_matches_batch_by_status',
      sql`(${t.status} IN ('CANDIDATE', 'EXCLUDED') AND ${t.batchId} IS NULL)
        OR (${t.status} NOT IN ('CANDIDATE', 'EXCLUDED') AND ${t.batchId} IS NOT NULL AND ${t.notifiedAt} IS NOT NULL)`,
    ),
    // The prediction is chosen at batch selection, in the same step that sets batch_id (section 6, step 2).
    check('donor_matches_selection_consistent', sql`(${t.batchId} IS NULL) = (${t.selectedPredictionId} IS NULL)`),
    check('donor_matches_exclusion_reason', sql`(${t.status} = 'EXCLUDED') = (${t.exclusionReason} IS NOT NULL)`),
    check('donor_matches_drop_reason', sql`(${t.status} = 'DROPPED') = (${t.dropReason} IS NOT NULL)`),
    // NULL dropped_by means the system dropped the donor.
    check('donor_matches_dropped_by_only_when_dropped', sql`${t.droppedBy} IS NULL OR ${t.status} = 'DROPPED'`),
    check('donor_matches_arrived_status', sql`${t.arrivedAt} IS NULL OR ${t.status} IN ('CONFIRMED', 'COMPLETED', 'DROPPED')`),
    check('donor_matches_consent_needs_batch', sql`${t.locationConsentAt} IS NULL OR ${t.batchId} IS NOT NULL`),
    // Upper-case codes whose allowed values are defined by the API validator (section 6).
    check(
      'donor_matches_reason_code_format',
      sql`(${t.exclusionReason} IS NULL OR ${t.exclusionReason} ~ '^[A-Z][A-Z0-9_]*$') AND (${t.dropReason} IS NULL OR ${t.dropReason} ~ '^[A-Z][A-Z0-9_]*$')`,
    ),
    check('donor_matches_distance_eta_non_negative', sql`(${t.distanceKm} IS NULL OR ${t.distanceKm} >= 0) AND (${t.etaMinutes} IS NULL OR ${t.etaMinutes} >= 0)`),
    index('donor_matches_search_status_idx').on(t.searchId, t.status),
    // Fatigue cap: notifications a donor received in a time window (ARCHITECTURE.md section 3).
    index('donor_matches_donor_notified_idx').on(t.donorId, t.notifiedAt.desc()).where(sql`${t.notifiedAt} IS NOT NULL`),
    index('donor_matches_batch_idx').on(t.batchId).where(sql`${t.batchId} IS NOT NULL`),
    index('donor_matches_prediction_idx').on(t.selectedPredictionId).where(sql`${t.selectedPredictionId} IS NOT NULL`),
  ],
);

// Append-only log of the donor's own answer and of the response window's outcome. No drop of any kind writes here
// (DATABASE.md 2.7 and 13, A2). One row per match, so a match yields exactly one training label.
export const donorResponses = pgTable(
  'donor_responses',
  {
    id: primaryId(),
    matchId: uuid('match_id').notNull().unique('donor_responses_match_key').references(() => donorMatches.id, { onDelete: 'restrict' }),
    // WAITLISTED is still recorded as ACCEPTED (ML.md section 2).
    response: donorResponseKindEnum('response').notNull(),
    respondedAt: tstz('responded_at').notNull().defaultNow(),
    latencySeconds: integer('latency_seconds'),
  },
  (t) => [
    check('donor_responses_latency_non_negative', sql`${t.latencySeconds} IS NULL OR ${t.latencySeconds} >= 0`),
    index('donor_responses_responded_idx').on(t.respondedAt),
  ],
);

// Model registry. A row starts as CANDIDATE and is activated by a reviewed, audit-logged admin action (ML.md section 8).
export const mlModelVersions = pgTable(
  'ml_model_versions',
  {
    id: primaryId(),
    modelVersion: text('model_version').notNull().unique('ml_model_versions_model_version_key'),
    algorithm: text('algorithm').notNull(),
    datasetVersion: text('dataset_version').notNull(),
    featuresUsed: text('features_used').array().notNull(),
    metrics: jsonb('metrics').notNull().default({}),
    trainedAt: tstz('trained_at').notNull(),
    artifactRef: text('artifact_ref').notNull(),
    status: modelStatusEnum('status').notNull().default('CANDIDATE'),
    activatedAt: tstz('activated_at'),
    activatedBy: uuid('activated_by').references(() => users.id, { onDelete: 'restrict' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // At most one active model: every ACTIVE row has the same key, so a second one is rejected.
    uniqueIndex('ml_model_versions_one_active').on(t.status).where(sql`${t.status} = 'ACTIVE'`),
    check('ml_model_versions_version_not_blank', sql`length(btrim(${t.modelVersion})) > 0`),
    // The label of the fallback ranker is reserved, so the two can never be confused.
    check('ml_model_versions_not_fallback_label', sql`${t.modelVersion} <> 'rule-based-fallback'`),
    check('ml_model_versions_activation_recorded', sql`${t.status} = 'CANDIDATE' OR (${t.activatedAt} IS NOT NULL AND ${t.activatedBy} IS NOT NULL)`),
    check('ml_model_versions_metrics_is_object', sql`jsonb_typeof(${t.metrics}) = 'object'`),
  ],
);
