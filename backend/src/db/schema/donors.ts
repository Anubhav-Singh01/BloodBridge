import { sql } from 'drizzle-orm';
import { type AnyPgColumn, boolean, check, foreignKey, index, integer, pgTable, text, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, dateStr, primaryId, tstz, updatedAt } from './columns.js';
import {
  availabilityStatusEnum, bloodGroupEnum, donationSourceEnum, donationTypeEnum, donationVerificationStatusEnum, donorStatusEnum,
  eligibilityCalcOutcomeEnum, eligibilityCalcStatusEnum, eligibilityCalcTriggerEnum, intervalRuleScopeEnum, verificationStatusEnum,
} from './enums.js';
import { facilities } from './facilities.js';
import { geographyPoint } from './geography.js';
import { users } from './identity.js';
import { bloodRequests } from './requests.js';
import { donationIntervalRules } from './rules.js';

// DATABASE.md 2.3 and 2.4.
export const donors = pgTable(
  'donors',
  {
    id: primaryId(),
    userId: uuid('user_id').notNull().unique('donors_user_id_key').references(() => users.id, { onDelete: 'restrict' }),
    bloodGroup: bloodGroupEnum('blood_group').notNull(),
    verificationStatus: verificationStatusEnum('verification_status').notNull().default('PENDING'),
    // A new donor is not contacted until they set themselves available (fail closed).
    availabilityStatus: availabilityStatusEnum('availability_status').notNull().default('UNAVAILABLE'),
    availabilityUntil: tstz('availability_until'),
    // Denormalised copy of the CURRENT eligibility calculation (section 2.4). The calculation row is the source of truth.
    nextEligibleDonationAt: tstz('next_eligible_donation_at'),
    currentEligibilityCalcId: uuid('current_eligibility_calc_id'),
    selfReportedEligibility: boolean('self_reported_eligibility'),
    lastActiveAt: tstz('last_active_at'),
    status: donorStatusEnum('status').notNull().default('ACTIVE'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('donors_availability_until_temporary', sql`${t.availabilityUntil} IS NULL OR ${t.availabilityStatus} = 'TEMPORARILY_UNAVAILABLE'`),
    // The current calculation must belong to this same donor.
    foreignKey({
      name: 'donors_current_calc_fk',
      columns: [t.currentEligibilityCalcId, t.id],
      foreignColumns: [donorEligibilityCalculations.id, donorEligibilityCalculations.donorId],
    }).onDelete('restrict'),
    index('donors_eligible_pool_idx')
      .on(t.bloodGroup, t.nextEligibleDonationAt)
      .where(sql`${t.verificationStatus} = 'VERIFIED' AND ${t.availabilityStatus} = 'AVAILABLE' AND ${t.status} = 'ACTIVE'`),
    index('donors_verification_status_idx').on(t.verificationStatus),
    index('donors_next_eligible_idx').on(t.nextEligibleDonationAt),
  ],
);

// One record per donor, created or updated by the donor's submission (API.md 5.1). Full ID numbers are never stored.
export const donorVerifications = pgTable(
  'donor_verifications',
  {
    id: primaryId(),
    donorId: uuid('donor_id').notNull().unique('donor_verifications_donor_key').references(() => donors.id, { onDelete: 'restrict' }),
    // The allowed types are a configured list (API.md 5.1), so this is a code, not an enum.
    idType: text('id_type').notNull(),
    idLast4: text('id_last4'),
    idName: text('id_name'),
    status: verificationStatusEnum('status').notNull().default('PENDING'),
    reviewedBy: uuid('reviewed_by').references(() => users.id, { onDelete: 'restrict' }),
    reviewedAt: tstz('reviewed_at'),
    notes: text('notes'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('donor_verifications_id_type_format', sql`${t.idType} ~ '^[A-Z][A-Z0-9_]*$'`),
    check('donor_verifications_id_last4_format', sql`${t.idLast4} IS NULL OR ${t.idLast4} ~ '^[0-9]{4}$'`),
    check(
      'donor_verifications_review_recorded',
      sql`${t.status} NOT IN ('VERIFIED', 'REJECTED') OR (${t.reviewedBy} IS NOT NULL AND ${t.reviewedAt} IS NOT NULL)`,
    ),
    index('donor_verifications_open_idx').on(t.status).where(sql`${t.status} IN ('PENDING', 'UNDER_REVIEW')`),
  ],
);

// Exact and coarse locations, separate from `donors` so common queries never load exact coordinates (section 9).
// Anonymization deletes the row (it is pure PII). The coarse-only view arrives in Batch 3.4.
export const donorLocations = pgTable(
  'donor_locations',
  {
    donorId: uuid('donor_id').primaryKey().references(() => donors.id, { onDelete: 'restrict' }),
    locationExact: geographyPoint('location_exact').notNull(),
    locationCoarse: geographyPoint('location_coarse').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('donor_locations_exact_gist').using('gist', t.locationExact),
    index('donor_locations_coarse_gist').using('gist', t.locationCoarse),
  ],
);

// Append-only except the verification fields (guard triggers in 0002). Only VERIFIED rows are eligibility evidence.
export const donationHistory = pgTable(
  'donation_history',
  {
    id: primaryId(),
    // Explicit return type: part of the donors / donation_history / calculations type cycle (see donor_eligibility_calculations).
    donorId: uuid('donor_id').notNull().references((): AnyPgColumn => donors.id, { onDelete: 'restrict' }),
    donationType: donationTypeEnum('donation_type').notNull().default('WHOLE_BLOOD'),
    donatedAt: tstz('donated_at').notNull(),
    source: donationSourceEnum('source').notNull(),
    facilityId: uuid('facility_id').references(() => facilities.id, { onDelete: 'restrict' }),
    requestId: uuid('request_id').references(() => bloodRequests.id, { onDelete: 'restrict' }),
    recordedBy: uuid('recorded_by').references(() => users.id, { onDelete: 'restrict' }),
    verificationStatus: donationVerificationStatusEnum('verification_status').notNull().default('UNVERIFIED'),
    verifiedBy: uuid('verified_by').references(() => users.id, { onDelete: 'restrict' }),
    verifiedAt: tstz('verified_at'),
    isDemo: boolean('is_demo').notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [
    // Lets other tables tie a donation to its donor with a composite foreign key.
    unique('donation_history_id_donor_key').on(t.id, t.donorId),
    check('donation_history_not_future', sql`${t.donatedAt} <= now()`),
    check('donation_history_facility_required', sql`${t.source} = 'SELF_REPORTED' OR ${t.facilityId} IS NOT NULL`),
    check('donation_history_recorder_required', sql`${t.source} = 'SELF_REPORTED' OR ${t.recordedBy} IS NOT NULL`),
    // UNVERIFIED rows have no reviewer. VERIFIED and REJECTED rows record who and when (API.md 6.8).
    check(
      'donation_history_verification_recorded',
      sql`(${t.verificationStatus} = 'UNVERIFIED' AND ${t.verifiedBy} IS NULL AND ${t.verifiedAt} IS NULL)
        OR (${t.verificationStatus} <> 'UNVERIFIED' AND ${t.verifiedBy} IS NOT NULL AND ${t.verifiedAt} IS NOT NULL)`,
    ),
    index('donation_history_donor_idx').on(t.donorId, t.verificationStatus, t.donatedAt.desc()),
    index('donation_history_facility_idx').on(t.facilityId).where(sql`${t.facilityId} IS NOT NULL`),
    index('donation_history_request_idx').on(t.requestId).where(sql`${t.requestId} IS NOT NULL`),
  ],
);

// Append-only audit of every eligibility calculation (section 2.4). Only `status` may change, CURRENT to SUPERSEDED.
export const donorEligibilityCalculations = pgTable(
  'donor_eligibility_calculations',
  {
    id: primaryId(),
    // Explicit return type breaks the type cycle with `donors` (Drizzle's documented pattern for mutual references).
    donorId: uuid('donor_id').notNull().references((): AnyPgColumn => donors.id, { onDelete: 'restrict' }),
    // Named trigger_type because "trigger" is an SQL keyword.
    triggerType: eligibilityCalcTriggerEnum('trigger_type').notNull(),
    // Nullable for NO_DONATION. Its foreign key is declared below, together with donor_id.
    sourceDonationId: uuid('source_donation_id'),
    sourceDonatedAt: tstz('source_donated_at'),
    ruleId: uuid('rule_id').references(() => donationIntervalRules.id, { onDelete: 'restrict' }),
    consideredRuleIds: uuid('considered_rule_ids').array().notNull().default(sql`'{}'::uuid[]`),
    // Copied values of the selected rule, so the audit survives later rule changes.
    intervalDaysUsed: integer('interval_days_used'),
    ruleScopeUsed: intervalRuleScopeEnum('rule_scope_used'),
    ruleEffectiveFrom: dateStr('rule_effective_from'),
    ruleEffectiveTo: dateStr('rule_effective_to'),
    ruleSourceNote: text('rule_source_note'),
    outcome: eligibilityCalcOutcomeEnum('outcome').notNull(),
    nextEligibleAt: tstz('next_eligible_at'),
    status: eligibilityCalcStatusEnum('status').notNull().default('CURRENT'),
    computedAt: tstz('computed_at').notNull().defaultNow(),
  },
  (t) => [
    unique('donor_eligibility_calc_id_donor_key').on(t.id, t.donorId),
    // The source donation must belong to this same donor. When source_donation_id is NULL the
    // constraint is not checked, which is what NO_DONATION needs.
    foreignKey({
      name: 'donor_eligibility_calc_source_donation_fk',
      columns: [t.sourceDonationId, t.donorId],
      foreignColumns: [donationHistory.id, donationHistory.donorId],
    }).onDelete('restrict'),
    check(
      'donor_eligibility_calc_outcome_shape',
      sql`(${t.outcome} = 'COMPUTED' AND ${t.sourceDonationId} IS NOT NULL AND ${t.sourceDonatedAt} IS NOT NULL AND ${t.ruleId} IS NOT NULL
            AND ${t.intervalDaysUsed} IS NOT NULL AND ${t.ruleScopeUsed} IS NOT NULL AND ${t.ruleEffectiveFrom} IS NOT NULL
            AND ${t.ruleSourceNote} IS NOT NULL AND ${t.nextEligibleAt} IS NOT NULL)
        OR (${t.outcome} = 'NO_RULE' AND ${t.sourceDonationId} IS NOT NULL AND ${t.sourceDonatedAt} IS NOT NULL
            AND ${t.ruleId} IS NULL AND ${t.nextEligibleAt} IS NULL)
        OR (${t.outcome} = 'NO_DONATION' AND ${t.sourceDonationId} IS NULL AND ${t.ruleId} IS NULL AND ${t.nextEligibleAt} IS NULL)`,
    ),
    check('donor_eligibility_calc_rule_considered', sql`${t.ruleId} IS NULL OR ${t.ruleId} = ANY (${t.consideredRuleIds})`),
    check('donor_eligibility_calc_interval_positive', sql`${t.intervalDaysUsed} IS NULL OR ${t.intervalDaysUsed} > 0`),
    // At most one CURRENT calculation per donor.
    uniqueIndex('donor_eligibility_calc_current_key').on(t.donorId).where(sql`${t.status} = 'CURRENT'`),
    index('donor_eligibility_calc_donor_idx').on(t.donorId, t.computedAt.desc()),
    index('donor_eligibility_calc_rule_idx').on(t.ruleId).where(sql`${t.ruleId} IS NOT NULL`),
    index('donor_eligibility_calc_source_idx').on(t.sourceDonationId).where(sql`${t.sourceDonationId} IS NOT NULL`),
    index('donor_eligibility_calc_considered_gin').using('gin', t.consideredRuleIds),
  ],
);
