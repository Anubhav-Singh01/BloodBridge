import { beforeEach, describe, expect, it, vi } from 'vitest';
import supertest from 'supertest';

// Batch 3.10. HTTP-level tests through the real Express app (createApp()), with Clerk and the
// repositories mocked - no live Clerk session, no database. Proves the full request path: routing,
// requireAuth, validators, controllers, and the API.md 1.1 response envelope, together.

vi.mock('@clerk/express', () => ({
  // A no-op passthrough: this app's own requireAuth (middlewares/auth.ts) is what actually enforces
  // auth, using getAuth()'s mocked return value below.
  clerkMiddleware: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  getAuth: vi.fn(),
}));
// app.ts and the webhook controller both read env.js directly. Mocked with fixed fake values so
// this test never depends on (and can never crash on) whatever the real local .env happens to
// contain - the same isolation tests/unit/readiness.service.test.ts already applies to db/connection.js.
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
vi.mock('../../src/repositories/users.repository.js', () => ({
  findByClerkUserId: vi.fn(),
  findById: vi.fn(),
  findProfileByUserId: vi.fn(),
  updateProfile: vi.fn(),
  setStatus: vi.fn(),
}));
vi.mock('../../src/repositories/userRoles.repository.js', () => ({
  listRoleCodesForUser: vi.fn(),
  enrollRole: vi.fn(),
}));
vi.mock('../../src/repositories/dataDeletionRequests.repository.js', () => ({
  findPendingForUser: vi.fn(),
  createPending: vi.fn(),
}));
vi.mock('../../src/services/auditService.js', () => ({ record: vi.fn() }));

const { getAuth } = await import('@clerk/express');
const usersRepository = await import('../../src/repositories/users.repository.js');
const userRolesRepository = await import('../../src/repositories/userRoles.repository.js');
const dataDeletionRequestsRepository = await import('../../src/repositories/dataDeletionRequests.repository.js');
const { createApp } = await import('../../src/app.js');

const app = createApp();

function signedIn(status: 'ACTIVE' | 'SUSPENDED' | 'DELETION_PENDING' | 'ANONYMIZED' = 'ACTIVE', roles: string[] = []) {
  vi.mocked(getAuth).mockReturnValue({ isAuthenticated: true, userId: 'clerk_1' } as never);
  vi.mocked(usersRepository.findByClerkUserId).mockResolvedValue({ id: 'user-1', clerkUserId: 'clerk_1', status });
  vi.mocked(userRolesRepository.listRoleCodesForUser).mockResolvedValue(roles as never);
}
function signedOut() {
  vi.mocked(getAuth).mockReturnValue({ isAuthenticated: false, userId: null } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/v1/auth/me', () => {
  it('401s with the API.md error envelope when there is no session', async () => {
    signedOut();
    const res = await supertest(app).get('/api/v1/auth/me');
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ success: false, error: { code: 'UNAUTHENTICATED' } });
    expect(res.body.error.requestId).toBeTypeOf('string');
  });

  it('200s with the success envelope and the assembled identity when signed in', async () => {
    signedIn('ACTIVE', ['DONOR']);
    vi.mocked(usersRepository.findById).mockResolvedValue({ id: 'user-1', clerkUserId: 'clerk_1', status: 'ACTIVE' });
    vi.mocked(usersRepository.findProfileByUserId).mockResolvedValue({ fullName: 'Anu', email: 'a@example.com', phone: null, phoneVerifiedAt: null, dateOfBirth: null, address: null });

    const res = await supertest(app).get('/api/v1/auth/me');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, data: { id: 'user-1', roles: ['DONOR'], fullName: 'Anu' } });
  });
});

describe('PATCH /api/v1/users/me', () => {
  it('rejects an unknown field with 400 VALIDATION_ERROR (strict body)', async () => {
    signedIn();
    const res = await supertest(app).patch('/api/v1/users/me').send({ email: 'new@example.com' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(usersRepository.updateProfile).not.toHaveBeenCalled();
  });

  it('accepts a valid patch and returns 200', async () => {
    signedIn();
    const res = await supertest(app).patch('/api/v1/users/me').send({ fullName: 'New Name' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, data: { updated: true } });
    expect(usersRepository.updateProfile).toHaveBeenCalledWith('user-1', { fullName: 'New Name' });
  });
});

describe('POST /api/v1/users/me/roles', () => {
  it('rejects a privileged role with 400 VALIDATION_ERROR before it ever reaches the service (API.md 4.1)', async () => {
    signedIn();
    const res = await supertest(app).post('/api/v1/users/me/roles').send({ role: 'ADMIN' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(userRolesRepository.enrollRole).not.toHaveBeenCalled();
  });

  it('a first enrolment returns 201', async () => {
    signedIn();
    vi.mocked(userRolesRepository.enrollRole).mockResolvedValue({ alreadyEnrolled: false });
    const res = await supertest(app).post('/api/v1/users/me/roles').send({ role: 'DONOR' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ success: true, data: { role: 'DONOR', enrolled: true } });
  });

  it('an already-enrolled repeat returns 200, not an error (idempotent)', async () => {
    signedIn();
    vi.mocked(userRolesRepository.enrollRole).mockResolvedValue({ alreadyEnrolled: true });
    const res = await supertest(app).post('/api/v1/users/me/roles').send({ role: 'DONOR' });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ role: 'DONOR', enrolled: false });
  });
});

describe('DELETE /api/v1/users/me', () => {
  it('a first call returns 201 pending', async () => {
    signedIn('ACTIVE');
    vi.mocked(dataDeletionRequestsRepository.findPendingForUser).mockResolvedValue(undefined);
    vi.mocked(dataDeletionRequestsRepository.createPending).mockResolvedValue({ id: 'req-1', userId: 'user-1', source: 'USER_REQUEST', status: 'PENDING', createdAt: new Date() });

    const res = await supertest(app).delete('/api/v1/users/me');
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ status: 'pending', requestId: 'req-1' });
  });

  it('the contradiction this batch had to resolve: a DELETION_PENDING caller is allowed through on THIS route and gets an idempotent 200, even though requireAuth rejects DELETION_PENDING everywhere else', async () => {
    signedIn('DELETION_PENDING');
    vi.mocked(dataDeletionRequestsRepository.findPendingForUser).mockResolvedValue({ id: 'req-1', userId: 'user-1', source: 'USER_REQUEST', status: 'PENDING', createdAt: new Date('2026-01-01T00:00:00Z') });

    const res = await supertest(app).delete('/api/v1/users/me');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ status: 'already_pending', requestId: 'req-1' });
    expect(dataDeletionRequestsRepository.createPending).not.toHaveBeenCalled();
  });

  it('proves the global rule really is unweakened elsewhere: the same DELETION_PENDING status still 403s on a normal route', async () => {
    signedIn('DELETION_PENDING');
    const res = await supertest(app).patch('/api/v1/users/me').send({ fullName: 'x' });
    expect(res.status).toBe(403);
  });

  it('a SUSPENDED caller is still rejected on DELETE /users/me too (the exception is scoped to DELETION_PENDING only)', async () => {
    signedIn('SUSPENDED');
    const res = await supertest(app).delete('/api/v1/users/me');
    expect(res.status).toBe(403);
    expect(dataDeletionRequestsRepository.createPending).not.toHaveBeenCalled();
  });
});
