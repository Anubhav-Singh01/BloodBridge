import type { NextFunction, Request, Response } from 'express';
import * as donationHistoryRepository from '../repositories/donationHistory.repository.js';
import * as facilityMembershipsRepository from '../repositories/facilityMemberships.repository.js';
import type { RoleCode } from '../repositories/userRoles.repository.js';
import { AppError } from '../utils/appError.js';
import { requireParam } from '../utils/params.js';

// API.md 6.8 / Batch 3.12 decision C: ADMIN (global role) OR an ACTIVE member of the facility on
// this specific donation record - never a member of any other facility, and never anyone at all
// for a SELF_REPORTED record (no facility to be a member of). Must run after requireAuth().
//
// This is the first ADMIN-gated route in the app: "ADMIN inherits to SUPER_ADMIN" (ARCHITECTURE.md)
// is handled the same way requireRole() already handles any role list - by naming both roles here,
// not by new logic.
const ADMIN_ROLES: readonly RoleCode[] = ['ADMIN', 'SUPER_ADMIN'];

export function requireDonationReviewAccess() {
  return async function requireDonationReviewAccessMiddleware(req: Request, _res: Response, next: NextFunction): Promise<void> {
    try {
      if (!req.auth) {
        throw new AppError(401, 'UNAUTHENTICATED', 'Sign-in required.');
      }
      const donationId = requireParam(req, 'donationId');
      const donation = await donationHistoryRepository.findById(donationId);
      // Object-scoping (API.md 1.1): a nonexistent record, a record with no facility to a
      // non-admin, or a record at a facility the caller does not belong to, all look the same: 404.
      if (!donation) {
        throw new AppError(404, 'NOT_FOUND', 'Donation record not found.');
      }

      const isAdmin = req.auth.roles.some((role) => ADMIN_ROLES.includes(role));
      if (!isAdmin) {
        if (!donation.facilityId) {
          throw new AppError(404, 'NOT_FOUND', 'Donation record not found.');
        }
        const membership = await facilityMembershipsRepository.findActiveMembership(req.auth.userId, donation.facilityId);
        if (!membership) {
          throw new AppError(404, 'NOT_FOUND', 'Donation record not found.');
        }
      }

      req.donation = { id: donation.id, donorId: donation.donorId };
      next();
    } catch (error) {
      next(error);
    }
  };
}
