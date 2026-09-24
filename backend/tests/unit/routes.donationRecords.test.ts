import { beforeEach, describe, expect, it, vi } from 'vitest';
import supertest from 'supertest';

// Batch 3.12. HTTP-level tests through the real Express app for the first ADMIN-gated routes in
// the app, proving routing -> requireAuth/requireDonationReviewAccess -> controller -> service
// wiring, with Clerk and the repositories mocked (their own logic is covered by
// donationAuth.middleware.test.ts and donationRecordsService.test.ts).

vi.mock('@clerk/express', () => ({
  clerkMiddleware: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  getAuth: vi.fn(),
}));
vi.mock('../../src/config/env.js', () => ({
  env: {
    NODE_ENV: 'test',
    PORT: 5000,
    FRONTEND_URL: 'http://localhost:5173',
    BACKEND_URL: 'http://localhost:5000',
    DATABASE_URL: 'postgres://fake:fake@localhost:5432/fake',
    CLERK_SECRET_KEY: 'sk_test_fake',
    CLERK_WEBHOOK_SECRET: 'whsec_ZmFrZS10ZXN0LXNlY3JldC0zMmJ5dGVzIQ==',
  },
}));
vi.mock('../../src/repositories/users.repository.js', () => ({ findByClerkUserId: vi.fn() }));
vi.mock('../../src/repositories/userRoles.repository.js', () => ({ listRoleCodesForUser: vi.fn() }));
vi.mock('../../src/repositories/donationHistory.repository.js', () => ({
  findById: vi.fn(),
  setVerification: vi.fn(),
  findLatestVerified: vi.fn(),
}));
vi.mock('../../src/repositories/facilityMemberships.repository.js', () => ({ findActiveMembership: vi.fn() }));
vi.mock('../../src/repositories/donationIntervalRules.repository.js', () => ({ findApplicable: vi.fn() }));
vi.mock('../../src/repositories/donorEligibilityCalculations.repository.js', () => ({ applyRecompute: vi.fn() }));
vi.mock('../../src/services/auditService.js', () => ({ record: vi.fn() }));

const { getAuth } = await import('@clerk/express');
const usersRepository = await import('../../src/repositories/users.repository.js');
const userRolesRepository = await import('../../src/repositories/userRoles.repository.js');
const donationHistoryRepository = await import('../../src/repositories/donationHistory.repository.js');
const facilityMembershipsRepository = await import('../../src/repositories/facilityMemberships.repository.js');
const donationIntervalRulesRepository = await import('../../src/repositories/donationIntervalRules.repository.js');
const donorEligibilityCalculationsRepository = await import('../../src/repositories/donorEligibilityCalculations.repository.js');
const { createApp } = await import('../../src/app.js');

const app = createApp();

function signedIn(roles: string[] = ['ADMIN']) {
  vi.mocked(getAuth).mockReturnValue({ isAuthenticated: true, userId: 'clerk_1' } as never);
  vi.mocked(usersRepository.findByClerkUserId).mockResolvedValue({ id: 'user-1', clerkUserId: 'clerk_1', status: 'ACTIVE' });
  vi.mocked(userRolesRepository.listRoleCodesForUser).mockResolvedValue(roles as never);
}
function signedOut() {
  vi.mocked(getAuth).mockReturnValue({ isAuthenticated: false, userId: null } as never);
}

const donation = {
  id: 'donation-1',
  donorId: 'donor-1',
  donationType: 'WHOLE_BLOOD' as const,
  donatedAt: new Date('2026-01-01T00:00:00.000Z'),
  source: 'FACILITY_RECORDED' as const,
  facilityId: 'facility-1',
  verificationStatus: 'UNVERIFIED' as const,
  verifiedBy: null,
  verifiedAt: null,
};

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
  // recompute() runs for real off the mocked repositories: with the just-verified donation as the
  // latest VERIFIED one and no interval rules configured, it fails closed to NO_RULE.
  vi.mocked(donationHistoryRepository.findLatestVerified).mockResolvedValue(donation);
  vi.mocked(donationIntervalRulesRepository.findApplicable).mockResolvedValue([]);
});

describe('POST /api/v1/donation-history/:donationId/verify', () => {
  it('401s with no session', async () => {
    signedOut();
    const res = await supertest(app).post('/api/v1/donation-history/donation-1/verify');
    expect(res.status).toBe(401);
  });

  it('404s for a non-admin who is not a member of the recording facility', async () => {
    signedIn([]);
    vi.mocked(donationHistoryRepository.findById).mockResolvedValue(donation);
    vi.mocked(facilityMembershipsRepository.findActiveMembership).mockResolvedValue(undefined);
    const res = await supertest(app).post('/api/v1/donation-history/donation-1/verify');
    expect(res.status).toBe(404);
  });

  it('404s for a nonexistent donation record, even for ADMIN', async () => {
    signedIn(['ADMIN']);
    vi.mocked(donationHistoryRepository.findById).mockResolvedValue(undefined);
    const res = await supertest(app).post('/api/v1/donation-history/does-not-exist/verify');
    expect(res.status).toBe(404);
  });

  it('ADMIN can verify and the response includes the recomputed eligibility calculation', async () => {
    signedIn(['ADMIN']);
    vi.mocked(donationHistoryRepository.findById).mockResolvedValue(donation);

    const res = await supertest(app).post('/api/v1/donation-history/donation-1/verify');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ id: 'donation-1', status: 'VERIFIED', calculation: { outcome: 'NO_RULE' } });
    expect(donationHistoryRepository.setVerification).toHaveBeenCalledWith('donation-1', 'VERIFIED', 'user-1');
  });

  it('a facility STAFF member of the recording facility can also verify', async () => {
    signedIn([]);
    vi.mocked(donationHistoryRepository.findById).mockResolvedValue(donation);
    vi.mocked(facilityMembershipsRepository.findActiveMembership).mockResolvedValue({ id: 'm1', userId: 'user-1', facilityId: 'facility-1', role: 'STAFF', status: 'ACTIVE', joinedAt: new Date() });

    const res = await supertest(app).post('/api/v1/donation-history/donation-1/verify');
    expect(res.status).toBe(200);
  });
});

describe('POST /api/v1/donation-history/:donationId/reject', () => {
  it('401s with no session', async () => {
    signedOut();
    const res = await supertest(app).post('/api/v1/donation-history/donation-1/reject');
    expect(res.status).toBe(401);
  });

  it('404s for a SELF_REPORTED record when the caller is not an admin (no facility to belong to)', async () => {
    signedIn([]);
    vi.mocked(donationHistoryRepository.findById).mockResolvedValue({ ...donation, source: 'SELF_REPORTED', facilityId: null });
    const res = await supertest(app).post('/api/v1/donation-history/donation-1/reject');
    expect(res.status).toBe(404);
  });

  it('ADMIN can reject and the response includes the recomputed eligibility calculation', async () => {
    signedIn(['SUPER_ADMIN']);
    vi.mocked(donationHistoryRepository.findById).mockResolvedValue(donation);

    const res = await supertest(app).post('/api/v1/donation-history/donation-1/reject');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ id: 'donation-1', status: 'REJECTED' });
    expect(donationHistoryRepository.setVerification).toHaveBeenCalledWith('donation-1', 'REJECTED', 'user-1');
  });
});
