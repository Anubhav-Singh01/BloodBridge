import { and, eq } from 'drizzle-orm';
import { db } from '../db/connection.js';
import { donorEligibilityCalculations, donors } from '../db/schema/index.js';

export type EligibilityCalcTrigger = 'DONATION_VERIFIED' | 'DONATION_REJECTED' | 'RULE_CHANGED' | 'DAILY_JOB' | 'MANUAL_RECHECK';
export type EligibilityCalcOutcome = 'COMPUTED' | 'NO_DONATION' | 'NO_RULE';

export interface NewCalculation {
  donorId: string;
  triggerType: EligibilityCalcTrigger;
  outcome: EligibilityCalcOutcome;
  sourceDonationId?: string | null;
  sourceDonatedAt?: Date | null;
  ruleId?: string | null;
  consideredRuleIds: string[];
  intervalDaysUsed?: number | null;
  ruleScopeUsed?: 'OFFICIAL' | 'FACILITY' | null;
  ruleEffectiveFrom?: string | null;
  ruleEffectiveTo?: string | null;
  ruleSourceNote?: string | null;
  nextEligibleAt?: Date | null;
}

export interface CalculationRow {
  id: string;
  donorId: string;
  outcome: EligibilityCalcOutcome;
  nextEligibleAt: Date | null;
  status: 'CURRENT' | 'SUPERSEDED';
  computedAt: Date;
}

/**
 * DATABASE.md section 2.4: one transaction supersedes the prior CURRENT row (never edited or
 * deleted - only its `status` moves CURRENT -> SUPERSEDED, which is all the guard trigger allows),
 * inserts the new CURRENT row, and updates `donors.next_eligible_donation_at` /
 * `current_eligibility_calc_id`. The only write path for this table and these two donor columns.
 */
export async function applyRecompute(input: NewCalculation): Promise<CalculationRow> {
  return db.transaction(async (tx) => {
    await tx
      .update(donorEligibilityCalculations)
      .set({ status: 'SUPERSEDED' })
      .where(and(eq(donorEligibilityCalculations.donorId, input.donorId), eq(donorEligibilityCalculations.status, 'CURRENT')));

    const [row] = await tx
      .insert(donorEligibilityCalculations)
      .values({
        donorId: input.donorId,
        triggerType: input.triggerType,
        outcome: input.outcome,
        sourceDonationId: input.sourceDonationId ?? null,
        sourceDonatedAt: input.sourceDonatedAt ?? null,
        ruleId: input.ruleId ?? null,
        consideredRuleIds: input.consideredRuleIds,
        intervalDaysUsed: input.intervalDaysUsed ?? null,
        ruleScopeUsed: input.ruleScopeUsed ?? null,
        ruleEffectiveFrom: input.ruleEffectiveFrom ?? null,
        ruleEffectiveTo: input.ruleEffectiveTo ?? null,
        ruleSourceNote: input.ruleSourceNote ?? null,
        nextEligibleAt: input.nextEligibleAt ?? null,
      })
      .returning({ id: donorEligibilityCalculations.id, donorId: donorEligibilityCalculations.donorId, outcome: donorEligibilityCalculations.outcome, nextEligibleAt: donorEligibilityCalculations.nextEligibleAt, status: donorEligibilityCalculations.status, computedAt: donorEligibilityCalculations.computedAt });

    await tx.update(donors).set({ currentEligibilityCalcId: row!.id, nextEligibleDonationAt: row!.nextEligibleAt, updatedAt: new Date() }).where(eq(donors.id, input.donorId));

    return row!;
  });
}

export async function findCurrentByDonorId(donorId: string): Promise<CalculationRow | undefined> {
  const [row] = await db
    .select({ id: donorEligibilityCalculations.id, donorId: donorEligibilityCalculations.donorId, outcome: donorEligibilityCalculations.outcome, nextEligibleAt: donorEligibilityCalculations.nextEligibleAt, status: donorEligibilityCalculations.status, computedAt: donorEligibilityCalculations.computedAt })
    .from(donorEligibilityCalculations)
    .where(and(eq(donorEligibilityCalculations.donorId, donorId), eq(donorEligibilityCalculations.status, 'CURRENT')))
    .limit(1);
  return row;
}
