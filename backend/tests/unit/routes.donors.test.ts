import { beforeEach, describe, expect, it, vi } from 'vitest';
import supertest from 'supertest';

// Batch 3.12. HTTP-level tests through the real Express app, proving the routing ->
// requireAuth/requireRole('DONOR')/requireDonorProfile -> validator -> controller -> service
// wiring, with Clerk and the repositories mocked (their own logic is covered by
// donorAuth.middleware.test.ts and donorsService.test.ts).

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
vi.mock('../../src/repositories/donorLocations.repository.js', () => ({ upsert: vi.fn() }));
vi.mock('../../src/repositories/donationHistory.repository.js', () => ({
  createSelfReported: vi.fn(),
  listByDonor: vi.fn(),
}));
vi.mock('../../src/services/auditService.js', () => ({ record: vi.fn() }));

const { getAuth } = await import('@clerk/express');
const usersRepository = await import('../../src/repositories/users.repository.js');
const userRolesRepository = await import('../../src/repositories/userRoles.repository.js');
const donorsRepository = await import('../../src/repositories/donors.repository.js');
const donorVerificationsRepository = await import('../../src/repositories/donorVerifications.repository.js');
const donorLocationsRepository = await import('../../src/repositories/donorLocations.repository.js');
const donationHistoryRepository = await import('../../src/repositories/donationHistory.repository.js');
const { createApp } = await import('../../src/app.js');

const app = createApp();

function signedIn(roles: string[] = ['DONOR']) {
  vi.mocked(getAuth).mockReturnValue({ isAuthenticated: true, userId: 'clerk_1' } as never);
  vi.mocked(usersRepository.findByClerkUserId).mockResolvedValue({ id: 'user-1', clerkUserId: 'clerk_1', status: 'ACTIVE' });
  vi.mocked(userRolesRepository.listRoleCodesForUser).mockResolvedValue(roles as never);
}
function signedOut() {
  vi.mocked(getAuth).mockReturnValue({ isAuthenticated: false, userId: null } as never);
}

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

beforeEach(() => {
  vi.clearAllMocks();
});

describe('PUT /api/v1/donors/me', () => {
  it('401s with no session', async () => {
    signedOut();
    const res = await supertest(app).put('/api/v1/donors/me').send({ bloodGroup: 'O_POS' });
    expect(res.status).toBe(401);
  });

  it('403s without Role:DONOR', async () => {
    signedIn([]);
    const res = await supertest(app).put('/api/v1/donors/me').send({ bloodGroup: 'O_POS' });
    expect(res.status).toBe(403);
  });

  it('400s an invalid body (unknown bloodGroup)', async () => {
    signedIn();
    const res = await supertest(app).put('/api/v1/donors/me').send({ bloodGroup: 'X' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('creates the profile and returns it in the success envelope, without requiring an existing donor profile', async () => {
    signedIn();
    vi.mocked(donorsRepository.findByUserId).mockResolvedValue(undefined);
    vi.mocked(donorsRepository.create).mockResolvedValue({ id: 'donor-1' });
    vi.mocked(donorsRepository.findById).mockResolvedValue(donorRow());

    const res = await supertest(app).put('/api/v1/donors/me').send({ bloodGroup: 'O_POS' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, data: { id: 'donor-1', bloodGroup: 'O_POS' } });
  });
});

describe('GET /api/v1/donors/me/verification', () => {
  it('404s when the caller has no donor profile yet', async () => {
    signedIn();
    vi.mocked(donorsRepository.findByUserId).mockResolvedValue(undefined);
    const res = await supertest(app).get('/api/v1/donors/me/verification');
    expect(res.status).toBe(404);
  });

  it('returns null when no verification has been submitted yet', async () => {
    signedIn();
    vi.mocked(donorsRepository.findByUserId).mockResolvedValue(donorRow());
    vi.mocked(donorVerificationsRepository.findByDonorId).mockResolvedValue(undefined);
    const res = await supertest(app).get('/api/v1/donors/me/verification');
    expect(res.status).toBe(200);
    expect(res.body.data).toBeNull();
  });

  it('returns the existing verification status and reviewer note', async () => {
    signedIn();
    vi.mocked(donorsRepository.findByUserId).mockResolvedValue(donorRow());
    vi.mocked(donorVerificationsRepository.findByDonorId).mockResolvedValue({ id: 'v1', donorId: 'donor-1', idType: 'AADHAAR', idLast4: '1234', idName: 'Anu', status: 'PENDING', reviewedBy: null, reviewedAt: null, notes: null });
    const res = await supertest(app).get('/api/v1/donors/me/verification');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ id: 'v1', status: 'PENDING' });
  });
});

describe('POST /api/v1/donors/me/verification', () => {
  it('404s when the caller has no donor profile yet', async () => {
    signedIn();
    vi.mocked(donorsRepository.findByUserId).mockResolvedValue(undefined);
    const res = await supertest(app).post('/api/v1/donors/me/verification').send({ idType: 'AADHAAR' });
    expect(res.status).toBe(404);
  });

  it('400s an invalid idType format', async () => {
    signedIn();
    vi.mocked(donorsRepository.findByUserId).mockResolvedValue(donorRow());
    const res = await supertest(app).post('/api/v1/donors/me/verification').send({ idType: 'aadhaar' });
    expect(res.status).toBe(400);
  });

  it('creates a PENDING submission on success', async () => {
    signedIn();
    vi.mocked(donorsRepository.findByUserId).mockResolvedValue(donorRow());
    vi.mocked(donorVerificationsRepository.findByDonorId).mockResolvedValue(undefined);
    vi.mocked(donorVerificationsRepository.insert).mockResolvedValue({ id: 'v1' });

    const res = await supertest(app).post('/api/v1/donors/me/verification').send({ idType: 'AADHAAR', idLast4: '1234', idName: 'Anu' });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ id: 'v1', status: 'PENDING' });
  });

  it('409s VERIFICATION_ALREADY_APPROVED once VERIFIED', async () => {
    signedIn();
    vi.mocked(donorsRepository.findByUserId).mockResolvedValue(donorRow());
    vi.mocked(donorVerificationsRepository.findByDonorId).mockResolvedValue({ id: 'v1', donorId: 'donor-1', idType: 'AADHAAR', idLast4: '1234', idName: 'Anu', status: 'VERIFIED', reviewedBy: 'admin-1', reviewedAt: new Date(), notes: null });

    const res = await supertest(app).post('/api/v1/donors/me/verification').send({ idType: 'AADHAAR', idLast4: '1234', idName: 'Anu' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('VERIFICATION_ALREADY_APPROVED');
  });
});

describe('PATCH /api/v1/donors/me/availability', () => {
  it('404s when the caller has no donor profile yet', async () => {
    signedIn();
    vi.mocked(donorsRepository.findByUserId).mockResolvedValue(undefined);
    const res = await supertest(app).patch('/api/v1/donors/me/availability').send({ availabilityStatus: 'AVAILABLE' });
    expect(res.status).toBe(404);
  });

  it('400s TEMPORARILY_UNAVAILABLE with no until', async () => {
    signedIn();
    vi.mocked(donorsRepository.findByUserId).mockResolvedValue(donorRow());
    const res = await supertest(app).patch('/api/v1/donors/me/availability').send({ availabilityStatus: 'TEMPORARILY_UNAVAILABLE' });
    expect(res.status).toBe(400);
  });

  it('200s a valid update', async () => {
    signedIn();
    vi.mocked(donorsRepository.findByUserId).mockResolvedValue(donorRow());
    const res = await supertest(app).patch('/api/v1/donors/me/availability').send({ availabilityStatus: 'UNAVAILABLE' });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ updated: true });
    expect(donorsRepository.setAvailability).toHaveBeenCalledWith('donor-1', { availabilityStatus: 'UNAVAILABLE', availabilityUntil: null });
  });
});

describe('PUT /api/v1/donors/me/location', () => {
  it('404s when the caller has no donor profile yet', async () => {
    signedIn();
    vi.mocked(donorsRepository.findByUserId).mockResolvedValue(undefined);
    const res = await supertest(app).put('/api/v1/donors/me/location').send({ lat: 12.9716, lng: 77.5946 });
    expect(res.status).toBe(404);
  });

  it('400s an out-of-range coordinate', async () => {
    signedIn();
    vi.mocked(donorsRepository.findByUserId).mockResolvedValue(donorRow());
    const res = await supertest(app).put('/api/v1/donors/me/location').send({ lat: 999, lng: 0 });
    expect(res.status).toBe(400);
  });

  it('decision B: 200s and never echoes coordinates back, even the ones just sent', async () => {
    signedIn();
    vi.mocked(donorsRepository.findByUserId).mockResolvedValue(donorRow());
    const res = await supertest(app).put('/api/v1/donors/me/location').send({ lat: 12.9716, lng: 77.5946 });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ saved: true });
    expect(res.body.data).not.toHaveProperty('lat');
    expect(res.body.data).not.toHaveProperty('lng');
    expect(donorLocationsRepository.upsert).toHaveBeenCalledWith('donor-1', { lat: 12.9716, lng: 77.5946 }, expect.anything());
  });
});

describe('POST /api/v1/donors/me/donations', () => {
  it('404s when the caller has no donor profile yet', async () => {
    signedIn();
    vi.mocked(donorsRepository.findByUserId).mockResolvedValue(undefined);
    const res = await supertest(app).post('/api/v1/donors/me/donations').send({ donatedAt: '2026-01-01T00:00:00.000Z' });
    expect(res.status).toBe(404);
  });

  it('400s a future donatedAt', async () => {
    signedIn();
    vi.mocked(donorsRepository.findByUserId).mockResolvedValue(donorRow());
    const future = new Date(Date.now() + 86400000).toISOString();
    const res = await supertest(app).post('/api/v1/donors/me/donations').send({ donatedAt: future });
    expect(res.status).toBe(400);
  });

  it('201s a valid self-report', async () => {
    signedIn();
    vi.mocked(donorsRepository.findByUserId).mockResolvedValue(donorRow());
    vi.mocked(donationHistoryRepository.createSelfReported).mockResolvedValue({ id: 'donation-1' });
    const res = await supertest(app).post('/api/v1/donors/me/donations').send({ donatedAt: '2026-01-01T00:00:00.000Z' });
    expect(res.status).toBe(201);
    expect(res.body.data).toEqual({ id: 'donation-1', status: 'UNVERIFIED' });
  });
});

describe('GET /api/v1/donors/me/history', () => {
  it('404s when the caller has no donor profile yet', async () => {
    signedIn();
    vi.mocked(donorsRepository.findByUserId).mockResolvedValue(undefined);
    const res = await supertest(app).get('/api/v1/donors/me/history');
    expect(res.status).toBe(404);
  });

  it('200s a page with pageInfo meta', async () => {
    signedIn();
    vi.mocked(donorsRepository.findByUserId).mockResolvedValue(donorRow());
    vi.mocked(donationHistoryRepository.listByDonor).mockResolvedValue({ items: [], nextCursor: null });
    const res = await supertest(app).get('/api/v1/donors/me/history');
    expect(res.status).toBe(200);
    expect(res.body.meta.pageInfo).toMatchObject({ limit: 20, hasMore: false });
  });

  it('400s an out-of-range limit', async () => {
    signedIn();
    vi.mocked(donorsRepository.findByUserId).mockResolvedValue(donorRow());
    const res = await supertest(app).get('/api/v1/donors/me/history?limit=1000');
    expect(res.status).toBe(400);
  });
});
