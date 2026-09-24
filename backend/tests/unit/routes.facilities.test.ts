import { beforeEach, describe, expect, it, vi } from 'vitest';
import supertest from 'supertest';

// Batch 3.11. HTTP-level tests through the real Express app, proving the routing -> requireAuth/
// requireFacilityAccess -> validator -> controller -> service wiring, with Clerk and the
// repositories mocked (their own logic is covered by facilityAuth.middleware.test.ts and
// facilitiesService.test.ts).

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
vi.mock('../../src/repositories/facilities.repository.js', () => ({
  registerFacility: vi.fn(),
  findById: vi.fn(),
  updateProfile: vi.fn(),
  listPublic: vi.fn(),
}));
vi.mock('../../src/repositories/facilityMemberships.repository.js', () => ({
  createActiveAdmin: vi.fn(),
  findActiveMembership: vi.fn(),
  findMembership: vi.fn(),
  acceptInvitation: vi.fn(),
  removeMembership: vi.fn(),
  inviteStaff: vi.fn(),
  listByFacility: vi.fn(),
}));
vi.mock('../../src/repositories/facilityVerifications.repository.js', () => ({ upsertSubmission: vi.fn() }));
vi.mock('../../src/services/auditService.js', () => ({ record: vi.fn() }));

const { getAuth } = await import('@clerk/express');
const { AppError } = await import('../../src/utils/appError.js');
const usersRepository = await import('../../src/repositories/users.repository.js');
const userRolesRepository = await import('../../src/repositories/userRoles.repository.js');
const facilitiesRepository = await import('../../src/repositories/facilities.repository.js');
const facilityMembershipsRepository = await import('../../src/repositories/facilityMemberships.repository.js');
const { createApp } = await import('../../src/app.js');

const app = createApp();

function signedIn(userId = 'user-1') {
  vi.mocked(getAuth).mockReturnValue({ isAuthenticated: true, userId: 'clerk_1' } as never);
  vi.mocked(usersRepository.findByClerkUserId).mockResolvedValue({ id: userId, clerkUserId: 'clerk_1', status: 'ACTIVE' });
  vi.mocked(userRolesRepository.listRoleCodesForUser).mockResolvedValue([]);
}
function signedOut() {
  vi.mocked(getAuth).mockReturnValue({ isAuthenticated: false, userId: null } as never);
}

const hospitalRow = (overrides: Partial<Record<string, unknown>> = {}) => ({
  id: 'facility-1',
  facilityType: 'HOSPITAL' as const,
  name: 'DEMO Hospital',
  registrationNo: null,
  contact: null,
  address: null,
  hasLocation: false,
  verificationStatus: 'PENDING' as const,
  status: 'ACTIVE' as const,
  createdBy: 'user-1',
  createdAt: new Date(),
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('POST /api/v1/hospitals', () => {
  it('401s with no session', async () => {
    signedOut();
    const res = await supertest(app).post('/api/v1/hospitals').send({ name: 'DEMO Hospital' });
    expect(res.status).toBe(401);
  });

  it('registers a facility and returns 201', async () => {
    signedIn();
    vi.mocked(facilitiesRepository.registerFacility).mockResolvedValue({ id: 'facility-1' });
    vi.mocked(facilitiesRepository.findById).mockResolvedValue(hospitalRow());
    const res = await supertest(app).post('/api/v1/hospitals').send({ name: 'DEMO Hospital' });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ id: 'facility-1', facilityType: 'HOSPITAL' });
    expect(facilityMembershipsRepository.createActiveAdmin).toHaveBeenCalledWith('user-1', 'facility-1');
  });

  it('a blood-bank body sent to the hospital route is fine (facilityType is not client-supplied); an unknown field 400s', async () => {
    signedIn();
    const res = await supertest(app).post('/api/v1/hospitals').send({ name: 'x', facilityType: 'BLOOD_BANK' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('GET /api/v1/hospitals/:id', () => {
  it('returns the public view with no session when VERIFIED', async () => {
    signedOut();
    vi.mocked(facilitiesRepository.findById).mockResolvedValue(hospitalRow({ verificationStatus: 'VERIFIED' }));
    const res = await supertest(app).get('/api/v1/hospitals/facility-1');
    expect(res.status).toBe(200);
    expect(res.body.data).not.toHaveProperty('verificationStatus');
  });

  it('404s with no session when not yet VERIFIED', async () => {
    signedOut();
    vi.mocked(facilitiesRepository.findById).mockResolvedValue(hospitalRow({ verificationStatus: 'PENDING' }));
    const res = await supertest(app).get('/api/v1/hospitals/facility-1');
    expect(res.status).toBe(404);
  });

  it("returns the full view for the facility's own FACILITY_ADMIN, even while PENDING", async () => {
    signedIn();
    vi.mocked(facilitiesRepository.findById).mockResolvedValue(hospitalRow({ verificationStatus: 'PENDING' }));
    vi.mocked(facilityMembershipsRepository.findActiveMembership).mockResolvedValue({ id: 'm1', userId: 'user-1', facilityId: 'facility-1', role: 'FACILITY_ADMIN', status: 'ACTIVE', joinedAt: new Date() });
    const res = await supertest(app).get('/api/v1/hospitals/facility-1');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ verificationStatus: 'PENDING' });
  });
});

describe('PATCH /api/v1/hospitals/:id', () => {
  it('404s for a caller with no membership at this facility (object-scoping, not 403)', async () => {
    signedIn();
    vi.mocked(facilitiesRepository.findById).mockResolvedValue(hospitalRow());
    vi.mocked(facilityMembershipsRepository.findActiveMembership).mockResolvedValue(undefined);
    const res = await supertest(app).patch('/api/v1/hospitals/facility-1').send({ name: 'New Name' });
    expect(res.status).toBe(404);
  });

  it('403s for an ACTIVE STAFF member (not FACILITY_ADMIN)', async () => {
    signedIn();
    vi.mocked(facilitiesRepository.findById).mockResolvedValue(hospitalRow());
    vi.mocked(facilityMembershipsRepository.findActiveMembership).mockResolvedValue({ id: 'm1', userId: 'user-1', facilityId: 'facility-1', role: 'STAFF', status: 'ACTIVE', joinedAt: new Date() });
    const res = await supertest(app).patch('/api/v1/hospitals/facility-1').send({ name: 'New Name' });
    expect(res.status).toBe(403);
  });

  it("200s for the facility's own FACILITY_ADMIN while PENDING (Batch 3.11 decision 4)", async () => {
    signedIn();
    vi.mocked(facilitiesRepository.findById).mockResolvedValue(hospitalRow({ verificationStatus: 'PENDING' }));
    vi.mocked(facilityMembershipsRepository.findActiveMembership).mockResolvedValue({ id: 'm1', userId: 'user-1', facilityId: 'facility-1', role: 'FACILITY_ADMIN', status: 'ACTIVE', joinedAt: new Date() });
    const res = await supertest(app).patch('/api/v1/hospitals/facility-1').send({ name: 'New Name' });
    expect(res.status).toBe(200);
    expect(facilitiesRepository.updateProfile).toHaveBeenCalledWith('facility-1', { name: 'New Name' }, true);
  });
});

describe('POST /api/v1/facilities/:id/staff/accept', () => {
  it('transitions the caller\'s own INVITED membership to ACTIVE', async () => {
    signedIn();
    vi.mocked(facilityMembershipsRepository.findMembership).mockResolvedValue({ id: 'm1', userId: 'user-1', facilityId: 'facility-1', role: 'STAFF', status: 'INVITED', joinedAt: null });
    vi.mocked(facilityMembershipsRepository.acceptInvitation).mockResolvedValue({ id: 'm1', userId: 'user-1', facilityId: 'facility-1', role: 'STAFF', status: 'ACTIVE', joinedAt: new Date() });
    const res = await supertest(app).post('/api/v1/facilities/facility-1/staff/accept');
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('ACTIVE');
    expect(facilityMembershipsRepository.acceptInvitation).toHaveBeenCalledWith('user-1', 'facility-1');
  });

  it('404s when the caller has no invitation at all (never accepts on someone else\'s behalf)', async () => {
    signedIn();
    vi.mocked(facilityMembershipsRepository.findMembership).mockResolvedValue(undefined);
    vi.mocked(facilityMembershipsRepository.acceptInvitation).mockRejectedValue(new AppError(404, 'NOT_FOUND', 'No invitation found.'));
    const res = await supertest(app).post('/api/v1/facilities/facility-1/staff/accept');
    expect(res.status).toBe(404);
  });
});

describe('DELETE /api/v1/facilities/:id/staff/:userId', () => {
  it("200s for the facility's FACILITY_ADMIN and soft-removes (never deletes) via the repository", async () => {
    signedIn();
    vi.mocked(facilitiesRepository.findById).mockResolvedValue(hospitalRow());
    vi.mocked(facilityMembershipsRepository.findActiveMembership).mockResolvedValue({ id: 'm1', userId: 'user-1', facilityId: 'facility-1', role: 'FACILITY_ADMIN', status: 'ACTIVE', joinedAt: new Date() });
    const res = await supertest(app).delete('/api/v1/facilities/facility-1/staff/target-user');
    expect(res.status).toBe(200);
    expect(facilityMembershipsRepository.removeMembership).toHaveBeenCalledWith('facility-1', 'target-user');
  });
});
