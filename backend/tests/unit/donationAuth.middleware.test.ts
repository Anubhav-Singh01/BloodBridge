import type { NextFunction, Request, Response } from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Batch 3.12. requireDonationReviewAccess tested against mocked repositories - no database.
// Proves: ADMIN/SUPER_ADMIN (a global role) always passes, a non-admin needs an ACTIVE membership
// at the donation's own recording facility (never any other), a SELF_REPORTED record (no facility)
// is unreachable by any non-admin, and every "no relationship" case is a 404, not a 403
// (API.md 1.1 object-scoping - the same rule facilityAuth.ts already applies).

vi.mock('../../src/repositories/donationHistory.repository.js', () => ({ findById: vi.fn() }));
vi.mock('../../src/repositories/facilityMemberships.repository.js', () => ({ findActiveMembership: vi.fn() }));

const donationHistoryRepository = await import('../../src/repositories/donationHistory.repository.js');
const facilityMembershipsRepository = await import('../../src/repositories/facilityMemberships.repository.js');
const { requireDonationReviewAccess } = await import('../../src/middlewares/donationAuth.js');

function fakeReq(auth: { userId: string; roles: string[] } | undefined, donationId = 'donation-1'): Request {
  return { auth: auth as never, params: { donationId } } as unknown as Request;
}
function fakeRes(): Response {
  return {} as Response;
}

const facilityDonation = {
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

const selfReportedDonation = { ...facilityDonation, source: 'SELF_REPORTED' as const, facilityId: null };

beforeEach(() => {
  vi.clearAllMocks();
});

describe('requireDonationReviewAccess', () => {
  it('rejects with 401 when requireAuth has not run (no req.auth)', async () => {
    const next = vi.fn() as NextFunction;
    await requireDonationReviewAccess()(fakeReq(undefined), fakeRes(), next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 401 }));
    expect(donationHistoryRepository.findById).not.toHaveBeenCalled();
  });

  it('returns 404 when the donation record does not exist', async () => {
    vi.mocked(donationHistoryRepository.findById).mockResolvedValue(undefined);
    const next = vi.fn() as NextFunction;
    await requireDonationReviewAccess()(fakeReq({ userId: 'user-1', roles: [] }), fakeRes(), next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 404 }));
    expect(facilityMembershipsRepository.findActiveMembership).not.toHaveBeenCalled();
  });

  it('ADMIN passes without ever checking facility membership', async () => {
    vi.mocked(donationHistoryRepository.findById).mockResolvedValue(facilityDonation);
    const req = fakeReq({ userId: 'admin-1', roles: ['ADMIN'] });
    const next = vi.fn() as NextFunction;
    await requireDonationReviewAccess()(req, fakeRes(), next);
    expect(next).toHaveBeenCalledWith();
    expect(facilityMembershipsRepository.findActiveMembership).not.toHaveBeenCalled();
    expect(req.donation).toEqual({ id: 'donation-1', donorId: 'donor-1' });
  });

  it('SUPER_ADMIN passes the same way as ADMIN (role inheritance)', async () => {
    vi.mocked(donationHistoryRepository.findById).mockResolvedValue(facilityDonation);
    const next = vi.fn() as NextFunction;
    await requireDonationReviewAccess()(fakeReq({ userId: 'admin-1', roles: ['SUPER_ADMIN'] }), fakeRes(), next);
    expect(next).toHaveBeenCalledWith();
  });

  it('ADMIN passes even for a SELF_REPORTED record with no facility', async () => {
    vi.mocked(donationHistoryRepository.findById).mockResolvedValue(selfReportedDonation);
    const next = vi.fn() as NextFunction;
    await requireDonationReviewAccess()(fakeReq({ userId: 'admin-1', roles: ['ADMIN'] }), fakeRes(), next);
    expect(next).toHaveBeenCalledWith();
  });

  it('a non-admin with no facility at all returns 404 for a SELF_REPORTED record (nothing to be a member of)', async () => {
    vi.mocked(donationHistoryRepository.findById).mockResolvedValue(selfReportedDonation);
    const next = vi.fn() as NextFunction;
    await requireDonationReviewAccess()(fakeReq({ userId: 'user-1', roles: [] }), fakeRes(), next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 404 }));
    expect(facilityMembershipsRepository.findActiveMembership).not.toHaveBeenCalled();
  });

  it('a non-admin who is not a member of the recording facility gets 404 (not 403)', async () => {
    vi.mocked(donationHistoryRepository.findById).mockResolvedValue(facilityDonation);
    vi.mocked(facilityMembershipsRepository.findActiveMembership).mockResolvedValue(undefined);
    const next = vi.fn() as NextFunction;
    await requireDonationReviewAccess()(fakeReq({ userId: 'user-2', roles: [] }), fakeRes(), next);
    expect(facilityMembershipsRepository.findActiveMembership).toHaveBeenCalledWith('user-2', 'facility-1');
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 404 }));
  });

  it('a non-admin who is an ACTIVE member of the recording facility passes and req.donation is set', async () => {
    vi.mocked(donationHistoryRepository.findById).mockResolvedValue(facilityDonation);
    vi.mocked(facilityMembershipsRepository.findActiveMembership).mockResolvedValue({
      id: 'membership-1',
      userId: 'user-2',
      facilityId: 'facility-1',
      role: 'STAFF',
      status: 'ACTIVE',
      joinedAt: new Date(),
    });
    const req = fakeReq({ userId: 'user-2', roles: [] });
    const next = vi.fn() as NextFunction;
    await requireDonationReviewAccess()(req, fakeRes(), next);
    expect(next).toHaveBeenCalledWith();
    expect(req.donation).toEqual({ id: 'donation-1', donorId: 'donor-1' });
  });

  it('a non-admin who is a member of a DIFFERENT facility than the one that recorded the donation gets 404', async () => {
    vi.mocked(donationHistoryRepository.findById).mockResolvedValue(facilityDonation);
    // The middleware must look up membership at THIS donation's facility (facility-1), not any
    // facility the caller happens to belong to - simulated here by the lookup itself returning
    // undefined because the mock only resolves for a different facility id.
    vi.mocked(facilityMembershipsRepository.findActiveMembership).mockImplementation(async (_userId, facilityId) => (facilityId === 'facility-1' ? undefined : ({ id: 'm', userId: 'user-2', facilityId, role: 'STAFF', status: 'ACTIVE', joinedAt: new Date() } as never)));
    const next = vi.fn() as NextFunction;
    await requireDonationReviewAccess()(fakeReq({ userId: 'user-2', roles: [] }), fakeRes(), next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 404 }));
  });
});
