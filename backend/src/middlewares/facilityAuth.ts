import type { NextFunction, Request, Response } from 'express';
import * as facilitiesRepository from '../repositories/facilities.repository.js';
import type { FacilityType } from '../repositories/facilities.repository.js';
import * as facilityMembershipsRepository from '../repositories/facilityMemberships.repository.js';
import { AppError } from '../utils/appError.js';
import { requireParam } from '../utils/params.js';

// API.md 2.1: F:HOSPITAL(x)/F:BLOOD_BANK(x)/F:ADMIN(x). Facility access is derived from
// facility_memberships, never a global role, and is re-evaluated from the database on every
// request - nothing about it is cached in the JWT or anywhere else. Must run after requireAuth()
// on the same route.

export interface FacilityAuthOptions {
  /** Which facility_type(s) this route accepts. A route for one type given a facility of the other gets 404. */
  types: readonly FacilityType[];
  /** F:ADMIN(x): the membership's own role must be FACILITY_ADMIN, not just any ACTIVE membership. */
  adminOnly?: boolean;
  /**
   * Batch 3.11 decision 4: profile management, verification submission, and staff management are
   * all available to a facility's own FACILITY_ADMIN before verification. Only a route that sets
   * this requires facility.status = 'ACTIVE' AND facility.verification_status = 'VERIFIED' as well
   * as membership - no route in this batch does; this exists for a later (inventory) batch to use.
   */
  requireOperational?: boolean;
}

/** req.params.id is expected to be the facility id, matching every route this guards (API.md section 7). */
export function requireFacilityAccess(options: FacilityAuthOptions) {
  return async function requireFacilityAccessMiddleware(req: Request, _res: Response, next: NextFunction): Promise<void> {
    try {
      if (!req.auth) {
        throw new AppError(401, 'UNAUTHENTICATED', 'Sign-in required.');
      }
      const facilityId = requireParam(req, 'id');

      const facility = await facilitiesRepository.findById(facilityId);
      // A facility of the wrong type is treated exactly like a facility that does not exist: this
      // route has no relationship to it either way (API.md 1.1's object-scoping rule - 404, not 403).
      if (!facility || !options.types.includes(facility.facilityType)) {
        throw new AppError(404, 'NOT_FOUND', 'Facility not found.');
      }

      const membership = await facilityMembershipsRepository.findActiveMembership(req.auth.userId, facilityId);
      // No relationship to this facility at all (never a member, or REMOVED/INVITED only) - also 404,
      // never 403, so a caller cannot distinguish "not yours" from "does not exist".
      if (!membership) {
        throw new AppError(404, 'NOT_FOUND', 'Facility not found.');
      }
      if (options.adminOnly && membership.role !== 'FACILITY_ADMIN') {
        throw new AppError(403, 'FORBIDDEN', 'FACILITY_ADMIN role required.');
      }
      if (options.requireOperational && !(facility.status === 'ACTIVE' && facility.verificationStatus === 'VERIFIED')) {
        throw new AppError(403, 'FORBIDDEN', 'This facility is not yet operational.');
      }

      req.facility = { id: facility.id, facilityType: facility.facilityType, status: facility.status, verificationStatus: facility.verificationStatus, membershipRole: membership.role };
      next();
    } catch (error) {
      next(error);
    }
  };
}
