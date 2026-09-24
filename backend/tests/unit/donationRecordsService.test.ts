import { beforeEach, describe, expect, it, vi } from 'vitest';

// Batch 3.12. verifyDonation/rejectDonation tested against mocked repositories - no database.
// Authorization itself lives in middlewares/donationAuth.ts and is assumed to have already passed;
// this only proves the write + audit + "always recompute afterward" wiring (DATABASE.md 2.4's
// documented trigger list).

vi.mock('../../src/repositories/donationHistory.repository.js', () => ({
  findById: vi.fn(),
  setVerification: vi.fn(),
}));
vi.mock('../../src/services/auditService.js', () => ({ record: vi.fn() }));
vi.mock('../../src/services/eligibilityCalculationService.js', () => ({ recompute: vi.fn() }));

const donationHistoryRepository = await import('../../src/repositories/donationHistory.repository.js');
const auditService = await import('../../src/services/auditService.js');
const eligibilityCalculationService = await import('../../src/services/eligibilityCalculationService.js');
const donationRecordsService = await import('../../src/services/donationRecordsService.js');

const donation = {
  id: 'donation-1',
  donorId: 'donor-1',
  donationType: 'WHOLE_BLOOD' as const,
  donatedAt: new Date(),
  source: 'FACILITY_RECORDED' as const,
  facilityId: 'facility-1',
  verificationStatus: 'UNVERIFIED' as const,
  verifiedBy: null,
  verifiedAt: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(donationHistoryRepository.findById).mockResolvedValue(donation);
  vi.mocked(eligibilityCalculationService.recompute).mockResolvedValue({ id: 'calc-1', donorId: 'donor-1', outcome: 'COMPUTED', nextEligibleAt: null, status: 'CURRENT', computedAt: new Date() });
});

describe('verifyDonation', () => {
  it('sets VERIFIED, audits DONATION_VERIFIED, and always recomputes eligibility afterward', async () => {
    const result = await donationRecordsService.verifyDonation('donation-1', 'admin-1', 'req-1');

    expect(donationHistoryRepository.setVerification).toHaveBeenCalledWith('donation-1', 'VERIFIED', 'admin-1');
    expect(auditService.record).toHaveBeenCalledWith(expect.objectContaining({ actorId: 'admin-1', action: 'DONATION_VERIFIED', entityType: 'DONATION', entityId: 'donation-1', correlationId: 'req-1' }));
    expect(eligibilityCalculationService.recompute).toHaveBeenCalledWith('donor-1', 'DONATION_VERIFIED');
    expect(result).toEqual({ id: 'donation-1', status: 'VERIFIED', calculation: expect.objectContaining({ id: 'calc-1' }) });
  });
});

describe('rejectDonation', () => {
  it('sets REJECTED, audits DONATION_REJECTED, and still recomputes eligibility afterward', async () => {
    const result = await donationRecordsService.rejectDonation('donation-1', 'admin-1', 'req-1');

    expect(donationHistoryRepository.setVerification).toHaveBeenCalledWith('donation-1', 'REJECTED', 'admin-1');
    expect(auditService.record).toHaveBeenCalledWith(expect.objectContaining({ actorId: 'admin-1', action: 'DONATION_REJECTED', entityType: 'DONATION', entityId: 'donation-1', correlationId: 'req-1' }));
    expect(eligibilityCalculationService.recompute).toHaveBeenCalledWith('donor-1', 'DONATION_REJECTED');
    expect(result).toEqual({ id: 'donation-1', status: 'REJECTED', calculation: expect.objectContaining({ id: 'calc-1' }) });
  });
});
