import type { RoleCode } from '../repositories/userRoles.repository.js';

export {};

declare global {
  namespace Express {
    interface Request {
      /** Correlation id for this request. Set by middlewares/requestId.ts. */
      requestId: string;
      /**
       * Our own resolved identity for this request, set by middlewares/auth.ts's requireAuth().
       * Absent on routes that do not use requireAuth. `roles` is read from user_roles, never from
       * Clerk claims or the request body (API.md 2/4).
       */
      auth?: {
        userId: string;
        clerkUserId: string;
        status: 'ACTIVE' | 'SUSPENDED' | 'DELETION_PENDING' | 'ANONYMIZED';
        roles: RoleCode[];
      };
    }
  }
}
