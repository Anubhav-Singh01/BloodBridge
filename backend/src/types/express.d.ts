import type { FacilityType } from '../repositories/facilities.repository.js';
import type { MembershipRole } from '../repositories/facilityMemberships.repository.js';
import type { RoleCode } from '../repositories/userRoles.repository.js';

export {};

declare global {
  namespace Express {
    interface Request {
      /** Correlation id for this request. Set by middlewares/requestId.ts. */
      requestId: string;
      /**
       * Our own resolved identity for this request, set by middlewares/auth.ts's requireAuth() (or
       * left unset by optionalAuth() when there is no valid session). `roles` is read from
       * user_roles, never from Clerk claims or the request body (API.md 2/4).
       */
      auth?: {
        userId: string;
        clerkUserId: string;
        status: 'ACTIVE' | 'SUSPENDED' | 'DELETION_PENDING' | 'ANONYMIZED';
        roles: RoleCode[];
      };
      /**
       * Set by middlewares/facilityAuth.ts's requireFacilityAccess() once it has confirmed the
       * caller has an ACTIVE membership at the :id facility on the route (F:HOSPITAL(x)/
       * F:BLOOD_BANK(x)/F:ADMIN(x), API.md 2.1). Absent on routes that do not use it.
       */
      facility?: {
        id: string;
        facilityType: FacilityType;
        status: 'ACTIVE' | 'SUSPENDED';
        verificationStatus: 'PENDING' | 'UNDER_REVIEW' | 'VERIFIED' | 'REJECTED';
        membershipRole: MembershipRole;
      };
      /** Set by middlewares/donorAuth.ts's requireDonorProfile() once the caller's own donor row is confirmed to exist. */
      donor?: {
        id: string;
        userId: string;
      };
      /** Set by middlewares/donationAuth.ts's requireDonationReviewAccess() once ADMIN or facility-membership access to this donation record is confirmed. */
      donation?: {
        id: string;
        donorId: string;
      };
    }
  }
}
