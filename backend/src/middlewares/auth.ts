import { getAuth } from '@clerk/express';
import type { NextFunction, Request, Response } from 'express';
import * as userRolesRepository from '../repositories/userRoles.repository.js';
import type { RoleCode } from '../repositories/userRoles.repository.js';
import * as usersRepository from '../repositories/users.repository.js';
import { AppError } from '../utils/appError.js';

// API.md 2/4: authorization is always evaluated from our database, never from JWT claims or
// client-supplied data. clerkMiddleware() (mounted once in app.ts) only tells us the caller has a
// valid Clerk session; everything else - whether our own users row exists yet, its status, and its
// roles - is read from our own tables here, on every request.

export interface RequireAuthOptions {
  /**
   * DELETE /users/me is the one approved exception (Batch 3.10 decision): an already-authenticated
   * DELETION_PENDING user must still be able to call that one endpoint, idempotently, without being
   * rejected purely for already being pending. No other route sets this. Every route that does not
   * explicitly opt in keeps the unweakened rule: SUSPENDED and DELETION_PENDING are both rejected.
   */
  allowDeletionPending?: boolean;
}

export function requireAuth(options: RequireAuthOptions = {}) {
  return async function requireAuthMiddleware(req: Request, _res: Response, next: NextFunction): Promise<void> {
    try {
      const { userId: clerkUserId, isAuthenticated } = getAuth(req);
      if (!isAuthenticated || !clerkUserId) {
        throw new AppError(401, 'UNAUTHENTICATED', 'Sign-in required.');
      }

      const user = await usersRepository.findByClerkUserId(clerkUserId);
      if (!user) {
        // A valid Clerk session, but no users row yet - most likely the user.created webhook has
        // not been delivered or processed yet. Treated the same as unauthenticated: no session or
        // role of ours to grant.
        throw new AppError(401, 'UNAUTHENTICATED', 'Account not yet synchronized.');
      }
      if (user.status === 'ANONYMIZED') {
        throw new AppError(401, 'UNAUTHENTICATED', 'This account no longer exists.');
      }
      if (user.status === 'SUSPENDED') {
        throw new AppError(403, 'FORBIDDEN', 'This account is suspended.');
      }
      if (user.status === 'DELETION_PENDING' && !options.allowDeletionPending) {
        throw new AppError(403, 'FORBIDDEN', 'This account is pending deletion.');
      }

      const roles = await userRolesRepository.listRoleCodesForUser(user.id);
      req.auth = { userId: user.id, clerkUserId, status: user.status, roles };
      next();
    } catch (error) {
      next(error);
    }
  };
}

/**
 * For a route that is public but behaves differently for a signed-in caller (API.md section 7:
 * "Pub (VERIFIED, public fields) / F:ADMIN(id) (full)"). Unlike requireAuth(), this never rejects:
 * an absent, expired, or unsynchronized session simply leaves req.auth unset, and the route falls
 * back to its public behavior. A blocked account (SUSPENDED/DELETION_PENDING/ANONYMIZED) is also
 * just treated as anonymous here, never as an error - the caller only loses the extra access their
 * status would otherwise have blocked anyway.
 */
export function optionalAuth() {
  return async function optionalAuthMiddleware(req: Request, _res: Response, next: NextFunction): Promise<void> {
    try {
      const { userId: clerkUserId, isAuthenticated } = getAuth(req);
      if (!isAuthenticated || !clerkUserId) {
        next();
        return;
      }
      const user = await usersRepository.findByClerkUserId(clerkUserId);
      if (!user || user.status !== 'ACTIVE') {
        next();
        return;
      }
      const roles = await userRolesRepository.listRoleCodesForUser(user.id);
      req.auth = { userId: user.id, clerkUserId, status: user.status, roles };
      next();
    } catch (error) {
      next(error);
    }
  };
}

/** Role:X (API.md section 2). Must run after requireAuth() on the same route. */
export function requireRole(...allowed: readonly RoleCode[]) {
  return function requireRoleMiddleware(req: Request, _res: Response, next: NextFunction): void {
    if (!req.auth) {
      next(new AppError(401, 'UNAUTHENTICATED', 'Sign-in required.'));
      return;
    }
    if (!req.auth.roles.some((role) => allowed.includes(role))) {
      next(new AppError(403, 'FORBIDDEN', 'You do not have the required role.'));
      return;
    }
    next();
  };
}
