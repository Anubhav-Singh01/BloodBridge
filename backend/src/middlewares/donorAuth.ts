import type { NextFunction, Request, Response } from 'express';
import * as donorsRepository from '../repositories/donors.repository.js';
import { AppError } from '../utils/appError.js';

// Every /donors/me/* route except PUT /donors/me (which creates the profile) needs an existing
// donors row for the caller. Role:DONOR (requireRole('DONOR')) only grants the *right* to have one;
// donor ownership itself is always resolved fresh from the database by req.auth.userId, never from
// a client-supplied id or cached anywhere (preserving the same rule requireAuth() already applies
// to the user's own identity). Must run after requireAuth() + requireRole('DONOR').
export function requireDonorProfile() {
  return async function requireDonorProfileMiddleware(req: Request, _res: Response, next: NextFunction): Promise<void> {
    try {
      if (!req.auth) {
        throw new AppError(401, 'UNAUTHENTICATED', 'Sign-in required.');
      }
      const donor = await donorsRepository.findByUserId(req.auth.userId);
      if (!donor) {
        throw new AppError(404, 'NOT_FOUND', 'No donor profile yet. Create one with PUT /donors/me first.');
      }
      req.donor = { id: donor.id, userId: donor.userId };
      next();
    } catch (error) {
      next(error);
    }
  };
}
