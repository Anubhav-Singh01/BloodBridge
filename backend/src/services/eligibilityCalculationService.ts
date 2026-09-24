import * as donationHistoryRepository from '../repositories/donationHistory.repository.js';
import * as donationIntervalRulesRepository from '../repositories/donationIntervalRules.repository.js';
import type { DonationIntervalRuleRow } from '../repositories/donationIntervalRules.repository.js';
import * as donorEligibilityCalculationsRepository from '../repositories/donorEligibilityCalculations.repository.js';
import type { CalculationRow, EligibilityCalcTrigger } from '../repositories/donorEligibilityCalculations.repository.js';

// DATABASE.md section 2.4. Pure domain service, no HTTP - called by whatever action changes the
// facts a calculation depends on. Batch 3.12 wires DONATION_VERIFIED, DONATION_REJECTED and
// MANUAL_RECHECK; RULE_CHANGED (bulk, affects many donors) and DAILY_JOB are not implemented here -
// both belong to a job runner that does not exist yet.
//
// This never touches eligibility_rules (MIN_AGE/MAX_AGE): that table is a matching-time hard filter
// (ARCHITECTURE.md section 3, step 5), unrelated to donation-interval timing, which is all this
// calculation is about.

const DONATION_TYPE = 'WHOLE_BLOOD' as const;

/**
 * Longest interval wins; an exact tie prefers the OFFICIAL-scoped rule (DATABASE.md section 2.4,
 * step 3). In practice at most one OFFICIAL and one FACILITY rule can ever be simultaneously
 * effective (the exclusion constraints on donation_interval_rules forbid overlapping ranges within
 * each scope), so this is choosing between at most two rules - but the logic holds for any count.
 */
function selectRule(rules: readonly DonationIntervalRuleRow[]): DonationIntervalRuleRow | null {
  let best: DonationIntervalRuleRow | null = null;
  for (const rule of rules) {
    if (!best || rule.minIntervalDays > best.minIntervalDays || (rule.minIntervalDays === best.minIntervalDays && rule.scope === 'OFFICIAL' && best.scope !== 'OFFICIAL')) {
      best = rule;
    }
  }
  return best;
}

/**
 * Recomputes one donor's CURRENT eligibility calculation and writes it atomically (the previous
 * CURRENT row becomes SUPERSEDED, donors.next_eligible_donation_at / current_eligibility_calc_id
 * are updated in the same transaction - all inside donorEligibilityCalculationsRepository.applyRecompute).
 */
export async function recompute(donorId: string, triggerType: EligibilityCalcTrigger): Promise<CalculationRow> {
  const latestVerified = await donationHistoryRepository.findLatestVerified(donorId, DONATION_TYPE);

  if (!latestVerified) {
    return donorEligibilityCalculationsRepository.applyRecompute({ donorId, triggerType, outcome: 'NO_DONATION', consideredRuleIds: [] });
  }

  // "Effective at calculation time" (DATABASE.md 2.4, step 2/timing), not the donation date.
  const now = new Date();
  // The FACILITY rule considered is scoped to the facility that recorded THIS donation, never any
  // other (DATABASE.md section 12's working assumption, preserved as-is).
  const applicableRules = await donationIntervalRulesRepository.findApplicable(DONATION_TYPE, latestVerified.facilityId, now);
  const consideredRuleIds = applicableRules.map((rule) => rule.id);
  const selected = selectRule(applicableRules);

  if (!selected) {
    // Fail closed: no applicable rule means ineligible, never a guessed default (DATABASE.md 2.4, step 5).
    return donorEligibilityCalculationsRepository.applyRecompute({
      donorId,
      triggerType,
      outcome: 'NO_RULE',
      sourceDonationId: latestVerified.id,
      sourceDonatedAt: latestVerified.donatedAt,
      consideredRuleIds,
    });
  }

  const nextEligibleAt = new Date(latestVerified.donatedAt.getTime() + selected.minIntervalDays * 24 * 60 * 60 * 1000);

  return donorEligibilityCalculationsRepository.applyRecompute({
    donorId,
    triggerType,
    outcome: 'COMPUTED',
    sourceDonationId: latestVerified.id,
    sourceDonatedAt: latestVerified.donatedAt,
    ruleId: selected.id,
    consideredRuleIds,
    intervalDaysUsed: selected.minIntervalDays,
    ruleScopeUsed: selected.scope,
    ruleEffectiveFrom: selected.effectiveFrom,
    ruleEffectiveTo: selected.effectiveTo,
    ruleSourceNote: selected.sourceNote,
    nextEligibleAt,
  });
}
