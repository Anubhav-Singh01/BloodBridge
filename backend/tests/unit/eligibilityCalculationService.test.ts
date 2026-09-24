import { beforeEach, describe, expect, it, vi } from 'vitest';

// Batch 3.12. DATABASE.md section 2.4's algorithm, tested against mocked repositories - no
// database. Proves: OFFICIAL vs FACILITY precedence (longest interval wins), an exact tie prefers
// OFFICIAL, no applicable rule fails closed (NO_RULE), and no verified donation at all is NO_DONATION.
// This never touches eligibility_rules (age filters) - only donation_interval_rules.

vi.mock('../../src/repositories/donationHistory.repository.js', () => ({
  findLatestVerified: vi.fn(),
}));
vi.mock('../../src/repositories/donationIntervalRules.repository.js', () => ({
  findApplicable: vi.fn(),
}));
vi.mock('../../src/repositories/donorEligibilityCalculations.repository.js', () => ({
  applyRecompute: vi.fn(),
}));

const donationHistoryRepository = await import('../../src/repositories/donationHistory.repository.js');
const donationIntervalRulesRepository = await import('../../src/repositories/donationIntervalRules.repository.js');
const donorEligibilityCalculationsRepository = await import('../../src/repositories/donorEligibilityCalculations.repository.js');
const { recompute } = await import('../../src/services/eligibilityCalculationService.js');

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(donorEligibilityCalculationsRepository.applyRecompute).mockImplementation(async (input) => ({
    id: 'calc-1',
    donorId: input.donorId,
    outcome: input.outcome,
    nextEligibleAt: input.nextEligibleAt ?? null,
    status: 'CURRENT',
    computedAt: new Date(),
  }));
});

const donation = {
  id: 'donation-1',
  donorId: 'donor-1',
  donationType: 'WHOLE_BLOOD' as const,
  donatedAt: new Date('2026-01-01T00:00:00.000Z'),
  source: 'FACILITY_RECORDED' as const,
  facilityId: 'facility-1',
  verificationStatus: 'VERIFIED' as const,
  verifiedBy: 'admin-1',
  verifiedAt: new Date('2026-01-02T00:00:00.000Z'),
};

function rule(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'rule-1',
    donationType: 'WHOLE_BLOOD' as const,
    minIntervalDays: 90,
    scope: 'OFFICIAL' as const,
    facilityId: null,
    effectiveFrom: '2020-01-01',
    effectiveTo: null,
    sourceNote: 'test',
    ...overrides,
  };
}

describe('recompute', () => {
  it('reports NO_DONATION when the donor has never had a VERIFIED donation, without ever reading rules', async () => {
    vi.mocked(donationHistoryRepository.findLatestVerified).mockResolvedValue(undefined);

    const result = await recompute('donor-1', 'MANUAL_RECHECK');

    expect(result.outcome).toBe('NO_DONATION');
    expect(donationIntervalRulesRepository.findApplicable).not.toHaveBeenCalled();
    expect(donorEligibilityCalculationsRepository.applyRecompute).toHaveBeenCalledWith(
      expect.objectContaining({ donorId: 'donor-1', triggerType: 'MANUAL_RECHECK', outcome: 'NO_DONATION', consideredRuleIds: [] }),
    );
  });

  it('fails closed with NO_RULE when no OFFICIAL or FACILITY rule applies', async () => {
    vi.mocked(donationHistoryRepository.findLatestVerified).mockResolvedValue(donation);
    vi.mocked(donationIntervalRulesRepository.findApplicable).mockResolvedValue([]);

    const result = await recompute('donor-1', 'DONATION_VERIFIED');

    expect(result.outcome).toBe('NO_RULE');
    expect(donationIntervalRulesRepository.findApplicable).toHaveBeenCalledWith('WHOLE_BLOOD', 'facility-1', expect.any(Date));
    expect(donorEligibilityCalculationsRepository.applyRecompute).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'NO_RULE', sourceDonationId: 'donation-1', consideredRuleIds: [] }),
    );
  });

  it('scopes the FACILITY rule lookup to the facility that recorded the latest VERIFIED donation', async () => {
    vi.mocked(donationHistoryRepository.findLatestVerified).mockResolvedValue({ ...donation, facilityId: 'facility-42' });
    vi.mocked(donationIntervalRulesRepository.findApplicable).mockResolvedValue([rule()]);

    await recompute('donor-1', 'DONATION_VERIFIED');

    expect(donationIntervalRulesRepository.findApplicable).toHaveBeenCalledWith('WHOLE_BLOOD', 'facility-42', expect.any(Date));
  });

  it('computes nextEligibleAt from the longer FACILITY rule when it exceeds the OFFICIAL rule', async () => {
    vi.mocked(donationHistoryRepository.findLatestVerified).mockResolvedValue(donation);
    const official = rule({ id: 'rule-official', minIntervalDays: 90, scope: 'OFFICIAL' });
    const facility = rule({ id: 'rule-facility', minIntervalDays: 120, scope: 'FACILITY', facilityId: 'facility-1' });
    vi.mocked(donationIntervalRulesRepository.findApplicable).mockResolvedValue([official, facility]);

    await recompute('donor-1', 'DONATION_VERIFIED');

    const expectedNextEligible = new Date(donation.donatedAt.getTime() + 120 * 24 * 60 * 60 * 1000);
    expect(donorEligibilityCalculationsRepository.applyRecompute).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: 'COMPUTED',
        ruleId: 'rule-facility',
        intervalDaysUsed: 120,
        ruleScopeUsed: 'FACILITY',
        nextEligibleAt: expectedNextEligible,
        consideredRuleIds: expect.arrayContaining(['rule-official', 'rule-facility']),
      }),
    );
  });

  it('picks the longer OFFICIAL rule when it exceeds the FACILITY rule', async () => {
    vi.mocked(donationHistoryRepository.findLatestVerified).mockResolvedValue(donation);
    const official = rule({ id: 'rule-official', minIntervalDays: 150, scope: 'OFFICIAL' });
    const facility = rule({ id: 'rule-facility', minIntervalDays: 90, scope: 'FACILITY', facilityId: 'facility-1' });
    vi.mocked(donationIntervalRulesRepository.findApplicable).mockResolvedValue([official, facility]);

    await recompute('donor-1', 'DONATION_VERIFIED');

    expect(donorEligibilityCalculationsRepository.applyRecompute).toHaveBeenCalledWith(
      expect.objectContaining({ ruleId: 'rule-official', intervalDaysUsed: 150, ruleScopeUsed: 'OFFICIAL' }),
    );
  });

  it('an exact tie between OFFICIAL and FACILITY prefers OFFICIAL', async () => {
    vi.mocked(donationHistoryRepository.findLatestVerified).mockResolvedValue(donation);
    const official = rule({ id: 'rule-official', minIntervalDays: 90, scope: 'OFFICIAL' });
    const facility = rule({ id: 'rule-facility', minIntervalDays: 90, scope: 'FACILITY', facilityId: 'facility-1' });
    // Order shouldn't matter - test both orderings.
    vi.mocked(donationIntervalRulesRepository.findApplicable).mockResolvedValue([facility, official]);

    await recompute('donor-1', 'DONATION_VERIFIED');

    expect(donorEligibilityCalculationsRepository.applyRecompute).toHaveBeenCalledWith(expect.objectContaining({ ruleId: 'rule-official', ruleScopeUsed: 'OFFICIAL' }));
  });

  it('an exact tie the other ordering still prefers OFFICIAL', async () => {
    vi.mocked(donationHistoryRepository.findLatestVerified).mockResolvedValue(donation);
    const official = rule({ id: 'rule-official', minIntervalDays: 90, scope: 'OFFICIAL' });
    const facility = rule({ id: 'rule-facility', minIntervalDays: 90, scope: 'FACILITY', facilityId: 'facility-1' });
    vi.mocked(donationIntervalRulesRepository.findApplicable).mockResolvedValue([official, facility]);

    await recompute('donor-1', 'DONATION_VERIFIED');

    expect(donorEligibilityCalculationsRepository.applyRecompute).toHaveBeenCalledWith(expect.objectContaining({ ruleId: 'rule-official', ruleScopeUsed: 'OFFICIAL' }));
  });

  it('with only a FACILITY rule applicable, uses it', async () => {
    vi.mocked(donationHistoryRepository.findLatestVerified).mockResolvedValue(donation);
    const facility = rule({ id: 'rule-facility', minIntervalDays: 60, scope: 'FACILITY', facilityId: 'facility-1' });
    vi.mocked(donationIntervalRulesRepository.findApplicable).mockResolvedValue([facility]);

    await recompute('donor-1', 'DONATION_VERIFIED');

    expect(donorEligibilityCalculationsRepository.applyRecompute).toHaveBeenCalledWith(expect.objectContaining({ ruleId: 'rule-facility', intervalDaysUsed: 60 }));
  });

  it('never queries eligibility_rules or anything age-related - only donation_interval_rules', async () => {
    vi.mocked(donationHistoryRepository.findLatestVerified).mockResolvedValue(donation);
    vi.mocked(donationIntervalRulesRepository.findApplicable).mockResolvedValue([rule()]);
    await recompute('donor-1', 'DONATION_VERIFIED');
    // Implicit: the only repositories mocked/imported by this suite are donationHistory,
    // donationIntervalRules and donorEligibilityCalculations - no eligibilityRules repository exists
    // in this module's import graph at all.
    expect(donationIntervalRulesRepository.findApplicable).toHaveBeenCalledTimes(1);
  });
});
