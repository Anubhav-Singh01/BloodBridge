import { z } from 'zod';

// API.md section 5. Every body/query is a strict Zod object (API.md 1.4): unknown fields rejected.

const BLOOD_GROUPS = ['A_POS', 'A_NEG', 'B_POS', 'B_NEG', 'AB_POS', 'AB_NEG', 'O_POS', 'O_NEG'] as const;

export const donorProfileBodySchema = z
  .object({
    bloodGroup: z.enum(BLOOD_GROUPS),
    selfReportedEligibility: z.boolean().nullable().optional(),
  })
  .strict();
export type DonorProfileBody = z.infer<typeof donorProfileBodySchema>;

export const setAvailabilityBodySchema = z
  .object({
    availabilityStatus: z.enum(['AVAILABLE', 'UNAVAILABLE', 'TEMPORARILY_UNAVAILABLE']),
    until: z.string().datetime().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    // Mirrors donors_availability_until_temporary at the validator level (defense in depth; the DB
    // CHECK is still the actual guarantee).
    if (value.availabilityStatus === 'TEMPORARILY_UNAVAILABLE' && !value.until) {
      ctx.addIssue({ code: 'custom', path: ['until'], message: 'until is required when availabilityStatus is TEMPORARILY_UNAVAILABLE.' });
    }
    if (value.availabilityStatus !== 'TEMPORARILY_UNAVAILABLE' && value.until) {
      ctx.addIssue({ code: 'custom', path: ['until'], message: 'until is only accepted when availabilityStatus is TEMPORARILY_UNAVAILABLE.' });
    }
  });
export type SetAvailabilityBody = z.infer<typeof setAvailabilityBodySchema>;

// API.md 5.1: idType is a configured list of codes (Aadhaar, Voter ID, ...), not yet backed by any
// settings-driven configuration, so only the DB's own format is validated
// (donor_verifications_id_type_format: ^[A-Z][A-Z0-9_]*$) - no specific list is invented here.
export const submitDonorVerificationBodySchema = z
  .object({
    idType: z.string().regex(/^[A-Z][A-Z0-9_]*$/, 'idType must be an upper-case code.'),
    idLast4: z
      .string()
      .regex(/^[0-9]{4}$/, 'idLast4 must be exactly four digits.')
      .nullable()
      .optional(),
    idName: z.string().trim().min(1).max(200).nullable().optional(),
  })
  .strict();
export type SubmitDonorVerificationBody = z.infer<typeof submitDonorVerificationBodySchema>;

export const setDonorLocationBodySchema = z
  .object({
    lat: z.number().min(-90).max(90),
    lng: z.number().min(-180).max(180),
  })
  .strict();
export type SetDonorLocationBody = z.infer<typeof setDonorLocationBodySchema>;

export const reportSelfDonationBodySchema = z
  .object({
    donatedAt: z.string().datetime(),
  })
  .strict()
  .refine((value) => new Date(value.donatedAt).getTime() <= Date.now(), { path: ['donatedAt'], message: 'donatedAt cannot be in the future.' });
export type ReportSelfDonationBody = z.infer<typeof reportSelfDonationBodySchema>;

export const listDonationHistoryQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(20),
    cursor: z.string().min(1).optional(),
  })
  .strict();
export type ListDonationHistoryQuery = z.infer<typeof listDonationHistoryQuerySchema>;
