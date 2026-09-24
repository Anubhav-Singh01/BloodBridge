import { beforeEach, describe, expect, it, vi } from 'vitest';

// Batch 3.10. usersService's business logic, tested against mocked repositories/auditService - no
// database, matching the established pattern for testing service logic in this codebase
// (tests/unit/readiness.service.test.ts mocks the DB connection module the same way).

vi.mock('../../src/repositories/users.repository.js', () => ({
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
vi.mock('../../src/services/auditService.js', () => ({
  record: vi.fn(),
}));

const usersRepository = await import('../../src/repositories/users.repository.js');
const userRolesRepository = await import('../../src/repositories/userRoles.repository.js');
const dataDeletionRequestsRepository = await import('../../src/repositories/dataDeletionRequests.repository.js');
const auditService = await import('../../src/services/auditService.js');
const { AppError } = await import('../../src/utils/appError.js');
const usersService = await import('../../src/services/usersService.js');

beforeEach(() => {
  vi.clearAllMocks();
});

describe('enrollRole', () => {
  it('rejects ADMIN without ever calling the repository (API.md 4.1)', async () => {
    // A RoleCode-typed value the validator would never actually let through - the service rejects
    // it too, as defense in depth, regardless of how it was reached.
    await expect(usersService.enrollRole('user-1', 'ADMIN')).rejects.toMatchObject({ status: 403, code: 'ROLE_NOT_SELF_ASSIGNABLE' });
    expect(userRolesRepository.enrollRole).not.toHaveBeenCalled();
  });

  it('rejects SUPER_ADMIN the same way', async () => {
    await expect(usersService.enrollRole('user-1', 'SUPER_ADMIN')).rejects.toBeInstanceOf(AppError);
  });

  it('a first enrolment calls the repository, audits ROLE_ENROLLED, and reports enrolled: true', async () => {
    vi.mocked(userRolesRepository.enrollRole).mockResolvedValue({ alreadyEnrolled: false });
    const result = await usersService.enrollRole('user-1', 'DONOR', 'req-1');
    expect(result).toEqual({ role: 'DONOR', enrolled: true });
    expect(auditService.record).toHaveBeenCalledWith(
      expect.objectContaining({ actorId: 'user-1', action: 'ROLE_ENROLLED', entityType: 'USER', entityId: 'user-1', correlationId: 'req-1', details: { role: 'DONOR' } }),
    );
  });

  it('an already-enrolled repeat reports enrolled: false and is not audited again (idempotent, API.md 4.1)', async () => {
    vi.mocked(userRolesRepository.enrollRole).mockResolvedValue({ alreadyEnrolled: true });
    const result = await usersService.enrollRole('user-1', 'DONOR');
    expect(result).toEqual({ role: 'DONOR', enrolled: false });
    expect(auditService.record).not.toHaveBeenCalled();
  });
});

describe('requestDeletion', () => {
  it('creates a new pending request, sets DELETION_PENDING, and audits with the caller as actor (USER_REQUEST)', async () => {
    vi.mocked(dataDeletionRequestsRepository.findPendingForUser).mockResolvedValue(undefined);
    const createdAt = new Date('2026-01-01T00:00:00Z');
    vi.mocked(dataDeletionRequestsRepository.createPending).mockResolvedValue({ id: 'req-1', userId: 'user-1', source: 'USER_REQUEST', status: 'PENDING', createdAt });

    const result = await usersService.requestDeletion('user-1', 'USER_REQUEST', 'corr-1');

    expect(result).toEqual({ status: 'pending', requestId: 'req-1', requestedAt: createdAt });
    expect(usersRepository.setStatus).toHaveBeenCalledWith('user-1', 'DELETION_PENDING');
    expect(auditService.record).toHaveBeenCalledWith(expect.objectContaining({ actorId: 'user-1', action: 'DATA_DELETION_REQUESTED', correlationId: 'corr-1', details: { source: 'USER_REQUEST' } }));
  });

  it('a webhook-sourced request audits with a null actor (the system, not the user)', async () => {
    vi.mocked(dataDeletionRequestsRepository.findPendingForUser).mockResolvedValue(undefined);
    vi.mocked(dataDeletionRequestsRepository.createPending).mockResolvedValue({ id: 'req-2', userId: 'user-1', source: 'CLERK_WEBHOOK', status: 'PENDING', createdAt: new Date() });

    await usersService.requestDeletion('user-1', 'CLERK_WEBHOOK');

    expect(auditService.record).toHaveBeenCalledWith(expect.objectContaining({ actorId: null, details: { source: 'CLERK_WEBHOOK' } }));
  });

  it('an already-pending request is returned as-is: no second row, no status write, no audit (idempotent)', async () => {
    const createdAt = new Date('2026-01-01T00:00:00Z');
    vi.mocked(dataDeletionRequestsRepository.findPendingForUser).mockResolvedValue({ id: 'req-1', userId: 'user-1', source: 'USER_REQUEST', status: 'PENDING', createdAt });

    const result = await usersService.requestDeletion('user-1', 'USER_REQUEST');

    expect(result).toEqual({ status: 'already_pending', requestId: 'req-1', requestedAt: createdAt });
    expect(dataDeletionRequestsRepository.createPending).not.toHaveBeenCalled();
    expect(usersRepository.setStatus).not.toHaveBeenCalled();
    expect(auditService.record).not.toHaveBeenCalled();
  });

  it('a concurrent creator winning the race (23505) is resolved by re-reading, not by failing the caller', async () => {
    vi.mocked(dataDeletionRequestsRepository.findPendingForUser)
      .mockResolvedValueOnce(undefined) // first check: nothing pending yet
      .mockResolvedValueOnce({ id: 'req-winner', userId: 'user-1', source: 'CLERK_WEBHOOK', status: 'PENDING', createdAt: new Date('2026-01-01T00:00:00Z') }); // re-read after losing the race
    vi.mocked(dataDeletionRequestsRepository.createPending).mockRejectedValue(Object.assign(new Error('duplicate key'), { code: '23505' }));

    const result = await usersService.requestDeletion('user-1', 'USER_REQUEST');

    expect(result).toEqual({ status: 'already_pending', requestId: 'req-winner', requestedAt: new Date('2026-01-01T00:00:00Z') });
    expect(usersRepository.setStatus).not.toHaveBeenCalled();
  });

  it('re-throws an unrelated database error instead of swallowing it', async () => {
    vi.mocked(dataDeletionRequestsRepository.findPendingForUser).mockResolvedValue(undefined);
    vi.mocked(dataDeletionRequestsRepository.createPending).mockRejectedValue(new Error('connection reset'));
    await expect(usersService.requestDeletion('user-1', 'USER_REQUEST')).rejects.toThrow('connection reset');
  });
});

describe('getAuthMe', () => {
  it('assembles id, status, roles and profile fields, and reports an empty facilityMemberships list', async () => {
    vi.mocked(usersRepository.findById).mockResolvedValue({ id: 'user-1', clerkUserId: 'clerk_1', status: 'ACTIVE' });
    vi.mocked(usersRepository.findProfileByUserId).mockResolvedValue({ fullName: 'Anu Bhav', email: 'a@example.com', phone: null, phoneVerifiedAt: null, dateOfBirth: null, address: null });
    vi.mocked(userRolesRepository.listRoleCodesForUser).mockResolvedValue(['DONOR']);

    const result = await usersService.getAuthMe('user-1');

    expect(result).toEqual({
      id: 'user-1',
      status: 'ACTIVE',
      roles: ['DONOR'],
      fullName: 'Anu Bhav',
      email: 'a@example.com',
      phone: null,
      phoneVerified: false,
      facilityMemberships: [],
    });
  });

  it('throws AppError(401) if the user row is gone', async () => {
    vi.mocked(usersRepository.findById).mockResolvedValue(undefined);
    await expect(usersService.getAuthMe('user-1')).rejects.toMatchObject({ status: 401 });
  });
});
