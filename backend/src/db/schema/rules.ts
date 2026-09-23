import { sql } from 'drizzle-orm';
import { check, index, integer, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { createdAt, dateStr, primaryId } from './columns.js';
import { bloodComponentEnum, bloodGroupEnum, donationTypeEnum, eligibilityRuleKeyEnum, intervalRuleScopeEnum } from './enums.js';
import { facilities } from './facilities.js';
import { users } from './identity.js';

// Rule tables start EMPTY: no compatibility, interval or age value is invented or seeded. An admin enters each
// one from an authoritative source. Ranges are half-open: `effective_to` is the first day the rule no longer applies.
// Non-overlap (exclusion) constraints are added in 0002_schema_a_guards.sql, which Drizzle cannot express.

export const eligibilityRules = pgTable(
  'eligibility_rules',
  {
    id: primaryId(),
    ruleKey: eligibilityRuleKeyEnum('rule_key').notNull(),
    valueInt: integer('value_int').notNull(),
    effectiveFrom: dateStr('effective_from').notNull(),
    effectiveTo: dateStr('effective_to'),
    sourceNote: text('source_note').notNull(),
    enteredBy: uuid('entered_by').notNull().references(() => users.id, { onDelete: 'restrict' }),
    createdAt: createdAt(),
  },
  (t) => [
    check('eligibility_rules_value_non_negative', sql`${t.valueInt} >= 0`),
    check('eligibility_rules_range_valid', sql`${t.effectiveTo} IS NULL OR ${t.effectiveTo} > ${t.effectiveFrom}`),
    check('eligibility_rules_source_not_blank', sql`length(btrim(${t.sourceNote})) > 0`),
    index('eligibility_rules_key_from_idx').on(t.ruleKey, t.effectiveFrom),
  ],
);

export const donationIntervalRules = pgTable(
  'donation_interval_rules',
  {
    id: primaryId(),
    donationType: donationTypeEnum('donation_type').notNull(),
    minIntervalDays: integer('min_interval_days').notNull(),
    effectiveFrom: dateStr('effective_from').notNull(),
    effectiveTo: dateStr('effective_to'),
    scope: intervalRuleScopeEnum('scope').notNull(),
    facilityId: uuid('facility_id').references(() => facilities.id, { onDelete: 'restrict' }),
    sourceNote: text('source_note').notNull(),
    enteredBy: uuid('entered_by').notNull().references(() => users.id, { onDelete: 'restrict' }),
    createdAt: createdAt(),
  },
  (t) => [
    check('donation_interval_rules_days_positive', sql`${t.minIntervalDays} > 0`),
    check('donation_interval_rules_range_valid', sql`${t.effectiveTo} IS NULL OR ${t.effectiveTo} > ${t.effectiveFrom}`),
    check('donation_interval_rules_scope_facility', sql`(${t.scope} = 'FACILITY') = (${t.facilityId} IS NOT NULL)`),
    check('donation_interval_rules_source_not_blank', sql`length(btrim(${t.sourceNote})) > 0`),
    index('donation_interval_rules_lookup_idx').on(t.donationType, t.scope, t.effectiveFrom),
    index('donation_interval_rules_facility_idx').on(t.facilityId).where(sql`${t.facilityId} IS NOT NULL`),
  ],
);

// A row means "this donor group may give to this recipient group for this component". Empty until an
// authoritative source is provided.
export const compatibilityRules = pgTable(
  'compatibility_rules',
  {
    id: primaryId(),
    component: bloodComponentEnum('component').notNull(),
    recipientGroup: bloodGroupEnum('recipient_group').notNull(),
    donorGroup: bloodGroupEnum('donor_group').notNull(),
    effectiveFrom: dateStr('effective_from').notNull(),
    effectiveTo: dateStr('effective_to'),
    sourceNote: text('source_note').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    check('compatibility_rules_range_valid', sql`${t.effectiveTo} IS NULL OR ${t.effectiveTo} > ${t.effectiveFrom}`),
    check('compatibility_rules_source_not_blank', sql`length(btrim(${t.sourceNote})) > 0`),
    index('compatibility_rules_lookup_idx').on(t.component, t.recipientGroup, t.donorGroup, t.effectiveFrom),
  ],
);
