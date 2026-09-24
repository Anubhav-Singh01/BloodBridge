import type { NextFunction, Request, Response } from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Batch 3.10. requireAuth/requireRole tested against a mocked Clerk getAuth() and mocked
// repositories - no live Clerk session, no database. Proves: roles come only from user_roles
// (never from Clerk claims), and the DELETION_PENDING exception is opt-in per route, not global.

vi.mock('@clerk/express', () => ({ getAuth: vi.fn() }));
vi.mock('../../src/repositories/users.repository.js', () => ({ findByClerkUserId: vi.fn() }));
vi.mock('../../src/repositories/userRoles.repository.js', () => ({ listRoleCodesForUser: vi.fn() }));

const { getAuth } = await import('@clerk/express');
const usersRepository = await import('../../src/repositories/users.repository.js');
const userRolesRepository = await import('../../src/repositories/userRoles.repository.js');
const { requireAuth, requireRole } = await import('../../src/middlewares/auth.js');

function fakeReq(): Request {
  return {} as Request;
}
function fakeRes(): Response {
  return {} as Response;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('requireAuth', () => {
  it('rejects with 401 UNAUTHENTICATED when there is no Clerk session, without ever reading the DB', async () => {
    vi.mocked(getAuth).mockReturnValue({ isAuthenticated: false, userId: null } as never);
    const req = fakeReq();
    const next = vi.fn() as NextFunction;
    await requireAuth()(req, fakeRes(), next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 401, code: 'UNAUTHENTICATED' }));
    expect(usersRepository.findByClerkUserId).not.toHaveBeenCalled();
  });

  it('rejects with 401 when the Clerk session has no matching users row yet', async () => {
    vi.mocked(getAuth).mockReturnValue({ isAuthenticated: true, userId: 'clerk_1' } as never);
    vi.mocked(usersRepository.findByClerkUserId).mockResolvedValue(undefined);
    const next = vi.fn() as NextFunction;
    await requireAuth()(fakeReq(), fakeRes(), next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 401 }));
  });

  it('rejects an ANONYMIZED user with 401', async () => {
    vi.mocked(getAuth).mockReturnValue({ isAuthenticated: true, userId: 'clerk_1' } as never);
    vi.mocked(usersRepository.findByClerkUserId).mockResolvedValue({ id: 'user-1', clerkUserId: 'clerk_1', status: 'ANONYMIZED' });
    const next = vi.fn() as NextFunction;
    await requireAuth()(fakeReq(), fakeRes(), next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 401 }));
  });

  it('rejects a SUSPENDED user with 403', async () => {
    vi.mocked(getAuth).mockReturnValue({ isAuthenticated: true, userId: 'clerk_1' } as never);
    vi.mocked(usersRepository.findByClerkUserId).mockResolvedValue({ id: 'user-1', clerkUserId: 'clerk_1', status: 'SUSPENDED' });
    const next = vi.fn() as NextFunction;
    await requireAuth()(fakeReq(), fakeRes(), next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 403 }));
  });

  it('by default (the unweakened global rule) rejects a DELETION_PENDING user with 403', async () => {
    vi.mocked(getAuth).mockReturnValue({ isAuthenticated: true, userId: 'clerk_1' } as never);
    vi.mocked(usersRepository.findByClerkUserId).mockResolvedValue({ id: 'user-1', clerkUserId: 'clerk_1', status: 'DELETION_PENDING' });
    const next = vi.fn() as NextFunction;
    await requireAuth()(fakeReq(), fakeRes(), next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 403 }));
  });

  it('only with { allowDeletionPending: true } lets a DELETION_PENDING user through, with req.auth populated', async () => {
    vi.mocked(getAuth).mockReturnValue({ isAuthenticated: true, userId: 'clerk_1' } as never);
    vi.mocked(usersRepository.findByClerkUserId).mockResolvedValue({ id: 'user-1', clerkUserId: 'clerk_1', status: 'DELETION_PENDING' });
    vi.mocked(userRolesRepository.listRoleCodesForUser).mockResolvedValue([]);
    const req = fakeReq();
    const next = vi.fn() as NextFunction;
    await requireAuth({ allowDeletionPending: true })(req, fakeRes(), next);
    expect(next).toHaveBeenCalledWith(); // called with no error argument
    expect(req.auth).toEqual({ userId: 'user-1', clerkUserId: 'clerk_1', status: 'DELETION_PENDING', roles: [] });
  });

  it('an ACTIVE user passes through with roles read from user_roles, never invented', async () => {
    vi.mocked(getAuth).mockReturnValue({ isAuthenticated: true, userId: 'clerk_1' } as never);
    vi.mocked(usersRepository.findByClerkUserId).mockResolvedValue({ id: 'user-1', clerkUserId: 'clerk_1', status: 'ACTIVE' });
    vi.mocked(userRolesRepository.listRoleCodesForUser).mockResolvedValue(['DONOR', 'PATIENT']);
    const req = fakeReq();
    const next = vi.fn() as NextFunction;
    await requireAuth()(req, fakeRes(), next);
    expect(next).toHaveBeenCalledWith();
    expect(req.auth?.roles).toEqual(['DONOR', 'PATIENT']);
  });
});

describe('requireRole', () => {
  it('rejects with 401 if requireAuth has not run (no req.auth)', () => {
    const next = vi.fn() as NextFunction;
    requireRole('ADMIN')(fakeReq(), fakeRes(), next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 401 }));
  });

  it('rejects with 403 when req.auth.roles does not include an allowed role', () => {
    const req = fakeReq();
    req.auth = { userId: 'user-1', clerkUserId: 'clerk_1', status: 'ACTIVE', roles: ['DONOR'] };
    const next = vi.fn() as NextFunction;
    requireRole('ADMIN', 'SUPER_ADMIN')(req, fakeRes(), next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 403 }));
  });

  it('allows through when req.auth.roles includes one of the allowed roles', () => {
    const req = fakeReq();
    req.auth = { userId: 'user-1', clerkUserId: 'clerk_1', status: 'ACTIVE', roles: ['DONOR'] };
    const next = vi.fn() as NextFunction;
    requireRole('DONOR')(req, fakeRes(), next);
    expect(next).toHaveBeenCalledWith();
  });
});
