import { and, eq, isNull, or, sql } from 'drizzle-orm';
import { db } from '../db/connection.js';
import { donationIntervalRules } from '../db/schema/index.js';

export type IntervalRuleScope = 'OFFICIAL' | 'FACILITY';

export interface DonationIntervalRuleRow {
  id: string;
  donationType: 'WHOLE_BLOOD';
  minIntervalDays: number;
  scope: IntervalRuleScope;
  facilityId: string | null;
  effectiveFrom: string;
  effectiveTo: string | null;
  sourceNote: string;
}

const RULE_COLUMNS = {
  id: donationIntervalRules.id,
  donationType: donationIntervalRules.donationType,
  minIntervalDays: donationIntervalRules.minIntervalDays,
  scope: donationIntervalRules.scope,
  facilityId: donationIntervalRules.facilityId,
  effectiveFrom: donationIntervalRules.effectiveFrom,
  effectiveTo: donationIntervalRules.effectiveTo,
  sourceNote: donationIntervalRules.sourceNote,
} as const;

/**
 * DATABASE.md section 2.4, step 2: every OFFICIAL rule for this donation type, plus any FACILITY
 * rule for this donation type belonging to `facilityId` (the facility that recorded the donor's
 * latest VERIFIED donation - never any other facility), both effective at `atDate`. Read-only:
 * rule authoring (an admin entering a value from an authoritative source) is a later batch: this
 * batch never invents, seeds, or writes to this table.
 */
export async function findApplicable(donationType: 'WHOLE_BLOOD', facilityId: string | null, atDate: Date): Promise<DonationIntervalRuleRow[]> {
  const dateStr = atDate.toISOString().slice(0, 10);
  const effective = and(sql`${donationIntervalRules.effectiveFrom} <= ${dateStr}`, or(isNull(donationIntervalRules.effectiveTo), sql`${donationIntervalRules.effectiveTo} > ${dateStr}`));

  const officialCondition = and(eq(donationIntervalRules.donationType, donationType), eq(donationIntervalRules.scope, 'OFFICIAL'), effective);
  const facilityCondition = facilityId
    ? and(eq(donationIntervalRules.donationType, donationType), eq(donationIntervalRules.scope, 'FACILITY'), eq(donationIntervalRules.facilityId, facilityId), effective)
    : undefined;

  return db
    .select(RULE_COLUMNS)
    .from(donationIntervalRules)
    .where(facilityCondition ? or(officialCondition, facilityCondition) : officialCondition);
}
