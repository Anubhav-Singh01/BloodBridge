import { z } from 'zod';

// API.md section 7. Every body is a strict Zod object (API.md 1.4): unknown fields are rejected.

const locationSchema = z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) }).strict();

export const registerFacilityBodySchema = z
  .object({
    name: z.string().trim().min(1, 'name cannot be blank.').max(200),
    registrationNo: z.string().trim().min(1).max(100).nullable().optional(),
    contact: z.string().trim().min(1).max(200).nullable().optional(),
    address: z.string().trim().min(1).max(500).nullable().optional(),
    location: locationSchema.nullable().optional(),
  })
  .strict();
export type RegisterFacilityBody = z.infer<typeof registerFacilityBodySchema>;

// Batch 3.11 decision: name, registrationNo, address, location are verification-relevant (resets
// verification_status to UNDER_REVIEW); contact is not.
export const VERIFICATION_RELEVANT_FIELDS = ['name', 'registrationNo', 'address', 'location'] as const;

export const updateFacilityBodySchema = z
  .object({
    name: z.string().trim().min(1, 'name cannot be blank.').max(200).optional(),
    registrationNo: z.string().trim().min(1).max(100).nullable().optional(),
    contact: z.string().trim().min(1).max(200).nullable().optional(),
    address: z.string().trim().min(1).max(500).nullable().optional(),
    location: locationSchema.nullable().optional(),
  })
  .strict();
export type UpdateFacilityBody = z.infer<typeof updateFacilityBodySchema>;

// "Metadata only in v1" (DATABASE.md 2.2) - no specific sub-fields are documented anywhere, so only
// the shape (a JSON object) is validated, matching facility_verifications_registration_metadata's
// own jsonb-object-only expectation.
export const submitVerificationBodySchema = z
  .object({
    registrationMetadata: z.record(z.string(), z.unknown()),
  })
  .strict();
export type SubmitVerificationBody = z.infer<typeof submitVerificationBodySchema>;

export const inviteStaffBodySchema = z
  .object({
    userId: z.string().uuid(),
    role: z.enum(['FACILITY_ADMIN', 'STAFF']),
  })
  .strict();
export type InviteStaffBody = z.infer<typeof inviteStaffBodySchema>;

export const listFacilitiesQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(20),
    cursor: z.string().min(1).optional(),
  })
  .strict();
export type ListFacilitiesQuery = z.infer<typeof listFacilitiesQuerySchema>;
