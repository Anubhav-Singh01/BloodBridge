import { beforeEach, describe, expect, it, vi } from 'vitest';

// Batch 3.12. donorsService's business logic, tested against mocked repositories/auditService -
// no database.

vi.mock('../../src/repositories/donationHistory.repository.js', () => ({
  createSelfReported: vi.fn(),
  listByDonor: vi.fn(),
}));
vi.mock('../../src/repositories/donorLocations.repository.js', () => ({
  upsert: vi.fn(),
}));
vi.mock('../../src/repositories/donors.repository.js', () => ({
  findByUserId: vi.fn(),
  findById: vi.fn(),
  create: vi.fn(),
  updateProfile: vi.fn(),
  setAvailability: vi.fn(),
}));
vi.mock('../../src/repositories/donorVerifications.repository.js', () => ({
  findByDonorId: vi.fn(),
  insert: vi.fn(),
  resubmit: vi.fn(),
}));
vi.mock('../../src/services/auditService.js', () => ({ record: vi.fn() }));

const donationHistoryRepository = await import('../../src/repositories/donationHistory.repository.js');
const donorLocationsRepository = await import('../../src/repositories/donorLocations.repository.js');
const donorsRepository = await import('../../src/repositories/donors.repository.js');
const donorVerificationsRepository = await import('../../src/repositories/donorVerifications.repository.js');
const auditService = await import('../../src/services/auditService.js');
const { AppError } = await import('../../src/utils/appError.js');
const { snapToCoarseGrid } = await import('../../src/utils/geo.js');
const donorsService = await import('../../src/services/donorsService.js');

beforeEach(() => {
  vi.clearAllMocks();
});

const donorRow = (overrides: Partial<Record<string, unknown>> = {}) => ({
  id: 'donor-1',
  userId: 'user-1',
  bloodGroup: 'O_POS' as const,
  verificationStatus: 'PENDING' as const,
  availabilityStatus: 'AVAILABLE' as const,
  availabilityUntil: null,
  nextEligibleDonationAt: null,
  currentEligibilityCalcId: null,
  selfReportedEligibility: null,
  status: 'ACTIVE' as const,
  ...overrides,
});

describe('createOrUpdateProfile', () => {
  it('creates a new donor row when none exists yet, and never resets verification (there is nothing to reset)', async () => {
    vi.mocked(donorsRepository.findByUserId).mockResolvedValue(undefined);
    vi.mocked(donorsRepository.create).mockResolvedValue({ id: 'donor-1' });
    vi.mocked(donorsRepository.findById).mockResolvedValue(donorRow());

    await donorsService.createOrUpdateProfile('user-1', { bloodGroup: 'O_POS' });

    expect(donorsRepository.create).toHaveBeenCalledWith('user-1', 'O_POS', null);
    expect(auditService.record).not.toHaveBeenCalled();
  });

  it('updating an existing profile with the SAME bloodGroup does not reset verification or audit', async () => {
    vi.mocked(donorsRepository.findByUserId).mockResolvedValue(donorRow({ verificationStatus: 'VERIFIED' }));
    vi.mocked(donorsRepository.findById).mockResolvedValue(donorRow({ verificationStatus: 'VERIFIED' }));

    await donorsService.createOrUpdateProfile('user-1', { bloodGroup: 'O_POS' });

    expect(donorsRepository.updateProfile).toHaveBeenCalledWith('donor-1', { bloodGroup: 'O_POS', selfReportedEligibility: null }, false);
    expect(auditService.record).not.toHaveBeenCalled();
  });

  it('decision A: a bloodGroup change on an already-VERIFIED donor resets verification and audits DONOR_BLOOD_GROUP_CHANGED', async () => {
    vi.mocked(donorsRepository.findByUserId).mockResolvedValue(donorRow({ bloodGroup: 'O_POS', verificationStatus: 'VERIFIED' }));
    vi.mocked(donorsRepository.findById).mockResolvedValue(donorRow({ bloodGroup: 'A_POS', verificationStatus: 'PENDING' }));

    await donorsService.createOrUpdateProfile('user-1', { bloodGroup: 'A_POS' }, 'req-1');

    expect(donorsRepository.updateProfile).toHaveBeenCalledWith('donor-1', { bloodGroup: 'A_POS', selfReportedEligibility: null }, true);
    expect(auditService.record).toHaveBeenCalledWith(
      expect.objectContaining({ actorId: 'user-1', action: 'DONOR_BLOOD_GROUP_CHANGED', entityType: 'DONOR', entityId: 'donor-1', correlationId: 'req-1', details: { from: 'O_POS', to: 'A_POS', verificationReset: true } }),
    );
  });

  it('a bloodGroup change on a NOT-yet-verified donor (e.g. PENDING) does not reset verification, but is still audited', async () => {
    vi.mocked(donorsRepository.findByUserId).mockResolvedValue(donorRow({ bloodGroup: 'O_POS', verificationStatus: 'PENDING' }));
    vi.mocked(donorsRepository.findById).mockResolvedValue(donorRow({ bloodGroup: 'A_POS', verificationStatus: 'PENDING' }));

    await donorsService.createOrUpdateProfile('user-1', { bloodGroup: 'A_POS' });

    expect(donorsRepository.updateProfile).toHaveBeenCalledWith('donor-1', { bloodGroup: 'A_POS', selfReportedEligibility: null }, false);
    expect(auditService.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'DONOR_BLOOD_GROUP_CHANGED', details: { from: 'O_POS', to: 'A_POS', verificationReset: false } }));
  });

  it('changing only selfReportedEligibility (not bloodGroup) never resets verification or audits a blood-group change', async () => {
    vi.mocked(donorsRepository.findByUserId).mockResolvedValue(donorRow({ bloodGroup: 'O_POS', verificationStatus: 'VERIFIED', selfReportedEligibility: null }));
    vi.mocked(donorsRepository.findById).mockResolvedValue(donorRow({ verificationStatus: 'VERIFIED', selfReportedEligibility: true }));

    await donorsService.createOrUpdateProfile('user-1', { bloodGroup: 'O_POS', selfReportedEligibility: true });

    expect(donorsRepository.updateProfile).toHaveBeenCalledWith('donor-1', { bloodGroup: 'O_POS', selfReportedEligibility: true }, false);
    expect(auditService.record).not.toHaveBeenCalled();
  });
});

describe('setAvailability', () => {
  it('passes through AVAILABLE with a null until', async () => {
    await donorsService.setAvailability('donor-1', { availabilityStatus: 'AVAILABLE' });
    expect(donorsRepository.setAvailability).toHaveBeenCalledWith('donor-1', { availabilityStatus: 'AVAILABLE', availabilityUntil: null });
  });

  it('only carries `until` through when TEMPORARILY_UNAVAILABLE, discarding it otherwise', async () => {
    const until = new Date('2026-12-01T00:00:00.000Z');
    await donorsService.setAvailability('donor-1', { availabilityStatus: 'TEMPORARILY_UNAVAILABLE', until });
    expect(donorsRepository.setAvailability).toHaveBeenCalledWith('donor-1', { availabilityStatus: 'TEMPORARILY_UNAVAILABLE', availabilityUntil: until });

    await donorsService.setAvailability('donor-1', { availabilityStatus: 'UNAVAILABLE', until });
    expect(donorsRepository.setAvailability).toHaveBeenCalledWith('donor-1', { availabilityStatus: 'UNAVAILABLE', availabilityUntil: null });
  });
});

describe('submitVerification', () => {
  const input = { idType: 'AADHAAR', idLast4: '1234', idName: 'Anu Bhav' };

  it('a first submission creates PENDING and audits DONOR_VERIFICATION_SUBMITTED', async () => {
    vi.mocked(donorVerificationsRepository.findByDonorId).mockResolvedValue(undefined);
    vi.mocked(donorVerificationsRepository.insert).mockResolvedValue({ id: 'verification-1' });

    const result = await donorsService.submitVerification('donor-1', input, 'req-1');

    expect(result).toEqual({ id: 'verification-1', status: 'PENDING' });
    expect(donorVerificationsRepository.insert).toHaveBeenCalledWith('donor-1', input);
    expect(auditService.record).toHaveBeenCalledWith(expect.objectContaining({ actorId: null, action: 'DONOR_VERIFICATION_SUBMITTED', entityType: 'DONOR', entityId: 'donor-1', correlationId: 'req-1' }));
  });

  it('normalizes missing idLast4/idName to null before writing (not undefined)', async () => {
    vi.mocked(donorVerificationsRepository.findByDonorId).mockResolvedValue(undefined);
    vi.mocked(donorVerificationsRepository.insert).mockResolvedValue({ id: 'verification-1' });

    await donorsService.submitVerification('donor-1', { idType: 'AADHAAR' });

    expect(donorVerificationsRepository.insert).toHaveBeenCalledWith('donor-1', { idType: 'AADHAAR', idLast4: null, idName: null });
  });

  it('UNDER_REVIEW is 409 CONFLICT', async () => {
    vi.mocked(donorVerificationsRepository.findByDonorId).mockResolvedValue({ id: 'v1', donorId: 'donor-1', idType: 'AADHAAR', idLast4: '1234', idName: 'x', status: 'UNDER_REVIEW', reviewedBy: null, reviewedAt: null, notes: null });
    await expect(donorsService.submitVerification('donor-1', input)).rejects.toMatchObject({ status: 409, code: 'CONFLICT' });
    expect(donorVerificationsRepository.resubmit).not.toHaveBeenCalled();
  });

  it('VERIFIED is 409 VERIFICATION_ALREADY_APPROVED', async () => {
    vi.mocked(donorVerificationsRepository.findByDonorId).mockResolvedValue({ id: 'v1', donorId: 'donor-1', idType: 'AADHAAR', idLast4: '1234', idName: 'x', status: 'VERIFIED', reviewedBy: 'admin-1', reviewedAt: new Date(), notes: null });
    await expect(donorsService.submitVerification('donor-1', input)).rejects.toMatchObject({ status: 409, code: 'VERIFICATION_ALREADY_APPROVED' });
  });

  it('an identical resubmission while PENDING is idempotent: no write, no duplicate audit', async () => {
    vi.mocked(donorVerificationsRepository.findByDonorId).mockResolvedValue({ id: 'v1', donorId: 'donor-1', idType: 'AADHAAR', idLast4: '1234', idName: 'Anu Bhav', status: 'PENDING', reviewedBy: null, reviewedAt: null, notes: null });

    const result = await donorsService.submitVerification('donor-1', input);

    expect(result).toEqual({ id: 'v1', status: 'PENDING' });
    expect(donorVerificationsRepository.resubmit).not.toHaveBeenCalled();
    expect(auditService.record).not.toHaveBeenCalled();
  });

  it('a changed resubmission while PENDING resubmits and audits again', async () => {
    vi.mocked(donorVerificationsRepository.findByDonorId).mockResolvedValue({ id: 'v1', donorId: 'donor-1', idType: 'AADHAAR', idLast4: '9999', idName: 'Anu Bhav', status: 'PENDING', reviewedBy: null, reviewedAt: null, notes: null });

    const result = await donorsService.submitVerification('donor-1', input);

    expect(result).toEqual({ id: 'v1', status: 'PENDING' });
    expect(donorVerificationsRepository.resubmit).toHaveBeenCalledWith('v1', input);
    expect(auditService.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'DONOR_VERIFICATION_SUBMITTED' }));
  });

  it('resubmission is allowed from REJECTED and resets to PENDING', async () => {
    vi.mocked(donorVerificationsRepository.findByDonorId).mockResolvedValue({ id: 'v1', donorId: 'donor-1', idType: 'AADHAAR', idLast4: '1234', idName: 'Anu Bhav', status: 'REJECTED', reviewedBy: 'admin-1', reviewedAt: new Date(), notes: 'nope' });

    const result = await donorsService.submitVerification('donor-1', input);

    expect(result).toEqual({ id: 'v1', status: 'PENDING' });
    expect(donorVerificationsRepository.resubmit).toHaveBeenCalledWith('v1', input);
  });
});

describe('getVerification', () => {
  it('delegates to the repository', async () => {
    vi.mocked(donorVerificationsRepository.findByDonorId).mockResolvedValue(undefined);
    const result = await donorsService.getVerification('donor-1');
    expect(result).toBeUndefined();
    expect(donorVerificationsRepository.findByDonorId).toHaveBeenCalledWith('donor-1');
  });
});

describe('setLocation', () => {
  it('decision B: stores the exact point and a coarse point snapped through snapToCoarseGrid, and never returns coordinates', async () => {
    const input = { lat: 12.9716, lng: 77.5946 };
    await donorsService.setLocation('donor-1', input);
    expect(donorLocationsRepository.upsert).toHaveBeenCalledWith('donor-1', input, snapToCoarseGrid(input));
  });
});

describe('reportSelfDonation', () => {
  it('records a SELF_REPORTED, UNVERIFIED donation and audits DONOR_DONATION_SELF_REPORTED with a null actor', async () => {
    vi.mocked(donationHistoryRepository.createSelfReported).mockResolvedValue({ id: 'donation-1' });
    const donatedAt = new Date('2026-01-01T00:00:00.000Z');

    const result = await donorsService.reportSelfDonation('donor-1', donatedAt, 'req-1');

    expect(result).toEqual({ id: 'donation-1', status: 'UNVERIFIED' });
    expect(donationHistoryRepository.createSelfReported).toHaveBeenCalledWith('donor-1', donatedAt, 'WHOLE_BLOOD');
    expect(auditService.record).toHaveBeenCalledWith(expect.objectContaining({ actorId: null, action: 'DONOR_DONATION_SELF_REPORTED', entityType: 'DONATION', entityId: 'donation-1', correlationId: 'req-1' }));
  });
});

describe('getHistoryPage', () => {
  it('delegates pagination to the repository unchanged', async () => {
    vi.mocked(donationHistoryRepository.listByDonor).mockResolvedValue({ items: [], nextCursor: null });
    const result = await donorsService.getHistoryPage('donor-1', 20, 'cursor-1');
    expect(result).toEqual({ items: [], nextCursor: null });
    expect(donationHistoryRepository.listByDonor).toHaveBeenCalledWith('donor-1', 20, 'cursor-1');
  });
});
