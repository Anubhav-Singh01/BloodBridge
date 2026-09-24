import { z } from 'zod';

// API.md 4.1: "Body: { role: 'PATIENT' | 'DONOR' }... Strict Zod enum; a missing or unknown role is
// VALIDATION_ERROR." Every body/query/param is validated with a strict object (API.md 1.4): unknown
// fields are rejected, not silently dropped.
export const enrollRoleBodySchema = z
  .object({
    role: z.enum(['PATIENT', 'DONOR']),
  })
  .strict();

export type EnrollRoleBody = z.infer<typeof enrollRoleBodySchema>;

// PATCH /users/me (API.md section 4). email and phone are intentionally not accepted here: they are
// synced from Clerk (services/clerkSyncService.ts), so accepting them here would create two
// disagreeing sources of truth for the same field.
export const updateProfileBodySchema = z
  .object({
    fullName: z.string().trim().min(1, 'fullName cannot be blank.').max(200).nullable().optional(),
    dateOfBirth: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'dateOfBirth must be an ISO date (YYYY-MM-DD).')
      .nullable()
      .optional(),
    address: z.string().trim().max(500).nullable().optional(),
  })
  .strict();

export type UpdateProfileBody = z.infer<typeof updateProfileBodySchema>;
