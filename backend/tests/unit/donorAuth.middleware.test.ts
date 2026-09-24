import type { NextFunction, Request, Response } from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Batch 3.12. requireDonorProfile tested against a mocked repository - no database. Proves: donor
// ownership is always resolved fresh from req.auth.userId (never a client-supplied id), and a
// missing profile is a 404 telling the caller to create one first.

vi.mock('../../src/repositories/donors.repository.js', () => ({ findByUserId: vi.fn() }));

const donorsRepository = await import('../../src/repositories/donors.repository.js');
const { requireDonorProfile } = await import('../../src/middlewares/donorAuth.js');

function fakeReq(auth: { userId: string } | undefined): Request {
  return { auth: auth as never } as unknown as Request;
}
function fakeRes(): Response {
  return {} as Response;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('requireDonorProfile', () => {
  it('rejects with 401 when requireAuth has not run (no req.auth)', async () => {
    const next = vi.fn() as NextFunction;
    await requireDonorProfile()(fakeReq(undefined), fakeRes(), next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 401 }));
    expect(donorsRepository.findByUserId).not.toHaveBeenCalled();
  });

  it('returns 404 when the caller has no donor profile yet', async () => {
    vi.mocked(donorsRepository.findByUserId).mockResolvedValue(undefined);
    const next = vi.fn() as NextFunction;
    await requireDonorProfile()(fakeReq({ userId: 'user-1' }), fakeRes(), next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 404 }));
  });

  it('resolves the donor from req.auth.userId (never a client-supplied id) and sets req.donor', async () => {
    vi.mocked(donorsRepository.findByUserId).mockResolvedValue({
      id: 'donor-1',
      userId: 'user-1',
      bloodGroup: 'O_POS',
      verificationStatus: 'PENDING',
      availabilityStatus: 'AVAILABLE',
      availabilityUntil: null,
      nextEligibleDonationAt: null,
      currentEligibilityCalcId: null,
      selfReportedEligibility: null,
      status: 'ACTIVE',
    });
    const req = fakeReq({ userId: 'user-1' });
    const next = vi.fn() as NextFunction;
    await requireDonorProfile()(req, fakeRes(), next);
    expect(donorsRepository.findByUserId).toHaveBeenCalledWith('user-1');
    expect(next).toHaveBeenCalledWith();
    expect(req.donor).toEqual({ id: 'donor-1', userId: 'user-1' });
  });
});
