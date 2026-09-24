import { describe, expect, it } from 'vitest';
import {
  donorProfileBodySchema,
  listDonationHistoryQuerySchema,
  reportSelfDonationBodySchema,
  setAvailabilityBodySchema,
  setDonorLocationBodySchema,
  submitDonorVerificationBodySchema,
} from '../../src/validators/donors.validators.js';

// Batch 3.12.

describe('donorProfileBodySchema', () => {
  it('accepts a minimal valid body (bloodGroup only)', () => {
    expect(donorProfileBodySchema.safeParse({ bloodGroup: 'O_POS' }).success).toBe(true);
  });

  it('accepts an explicit selfReportedEligibility, including null', () => {
    expect(donorProfileBodySchema.safeParse({ bloodGroup: 'O_POS', selfReportedEligibility: true }).success).toBe(true);
    expect(donorProfileBodySchema.safeParse({ bloodGroup: 'O_POS', selfReportedEligibility: null }).success).toBe(true);
  });

  it('rejects an invalid bloodGroup', () => {
    expect(donorProfileBodySchema.safeParse({ bloodGroup: 'O_POSITIVE' }).success).toBe(false);
  });

  it('rejects a missing bloodGroup', () => {
    expect(donorProfileBodySchema.safeParse({}).success).toBe(false);
  });

  it('rejects an unknown field (strict)', () => {
    expect(donorProfileBodySchema.safeParse({ bloodGroup: 'O_POS', extra: 1 }).success).toBe(false);
  });
});

describe('setAvailabilityBodySchema', () => {
  it('accepts AVAILABLE with no until', () => {
    expect(setAvailabilityBodySchema.safeParse({ availabilityStatus: 'AVAILABLE' }).success).toBe(true);
  });

  it('accepts UNAVAILABLE with no until', () => {
    expect(setAvailabilityBodySchema.safeParse({ availabilityStatus: 'UNAVAILABLE' }).success).toBe(true);
  });

  it('rejects TEMPORARILY_UNAVAILABLE with no until (cross-field check)', () => {
    expect(setAvailabilityBodySchema.safeParse({ availabilityStatus: 'TEMPORARILY_UNAVAILABLE' }).success).toBe(false);
  });

  it('accepts TEMPORARILY_UNAVAILABLE with a valid until', () => {
    const result = setAvailabilityBodySchema.safeParse({ availabilityStatus: 'TEMPORARILY_UNAVAILABLE', until: '2026-12-01T00:00:00.000Z' });
    expect(result.success).toBe(true);
  });

  it('rejects AVAILABLE with an until set (cross-field check, the other direction)', () => {
    expect(setAvailabilityBodySchema.safeParse({ availabilityStatus: 'AVAILABLE', until: '2026-12-01T00:00:00.000Z' }).success).toBe(false);
  });

  it('rejects an invalid availabilityStatus', () => {
    expect(setAvailabilityBodySchema.safeParse({ availabilityStatus: 'BUSY' }).success).toBe(false);
  });

  it('rejects an unknown field (strict)', () => {
    expect(setAvailabilityBodySchema.safeParse({ availabilityStatus: 'AVAILABLE', extra: 1 }).success).toBe(false);
  });
});

describe('submitDonorVerificationBodySchema', () => {
  it('accepts idType alone (idLast4/idName optional)', () => {
    expect(submitDonorVerificationBodySchema.safeParse({ idType: 'AADHAAR' }).success).toBe(true);
  });

  it('accepts a full submission', () => {
    expect(submitDonorVerificationBodySchema.safeParse({ idType: 'AADHAAR', idLast4: '1234', idName: 'Anu Bhav' }).success).toBe(true);
  });

  it('accepts explicit nulls for idLast4/idName', () => {
    expect(submitDonorVerificationBodySchema.safeParse({ idType: 'AADHAAR', idLast4: null, idName: null }).success).toBe(true);
  });

  it('rejects a lower-case idType (must match the DB format check)', () => {
    expect(submitDonorVerificationBodySchema.safeParse({ idType: 'aadhaar' }).success).toBe(false);
  });

  it('rejects idLast4 that is not exactly four digits', () => {
    expect(submitDonorVerificationBodySchema.safeParse({ idType: 'AADHAAR', idLast4: '123' }).success).toBe(false);
    expect(submitDonorVerificationBodySchema.safeParse({ idType: 'AADHAAR', idLast4: 'abcd' }).success).toBe(false);
  });

  it('rejects a blank idName', () => {
    expect(submitDonorVerificationBodySchema.safeParse({ idType: 'AADHAAR', idName: '   ' }).success).toBe(false);
  });

  it('rejects an unknown field (strict)', () => {
    expect(submitDonorVerificationBodySchema.safeParse({ idType: 'AADHAAR', extra: 1 }).success).toBe(false);
  });
});

describe('setDonorLocationBodySchema', () => {
  it('accepts a valid lat/lng', () => {
    expect(setDonorLocationBodySchema.safeParse({ lat: 12.9716, lng: 77.5946 }).success).toBe(true);
  });

  it('rejects an out-of-range lat', () => {
    expect(setDonorLocationBodySchema.safeParse({ lat: 999, lng: 0 }).success).toBe(false);
  });

  it('rejects an out-of-range lng', () => {
    expect(setDonorLocationBodySchema.safeParse({ lat: 0, lng: 999 }).success).toBe(false);
  });

  it('rejects a missing field', () => {
    expect(setDonorLocationBodySchema.safeParse({ lat: 0 }).success).toBe(false);
  });
});

describe('reportSelfDonationBodySchema', () => {
  it('accepts a past ISO datetime', () => {
    expect(reportSelfDonationBodySchema.safeParse({ donatedAt: '2026-01-01T00:00:00.000Z' }).success).toBe(true);
  });

  it('rejects a future datetime (refine)', () => {
    const future = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    expect(reportSelfDonationBodySchema.safeParse({ donatedAt: future }).success).toBe(false);
  });

  it('rejects a non-ISO string', () => {
    expect(reportSelfDonationBodySchema.safeParse({ donatedAt: '2026-01-01' }).success).toBe(false);
  });

  it('rejects an unknown field (strict)', () => {
    expect(reportSelfDonationBodySchema.safeParse({ donatedAt: '2026-01-01T00:00:00.000Z', extra: 1 }).success).toBe(false);
  });
});

describe('listDonationHistoryQuerySchema', () => {
  it('defaults limit to 20 with no query params', () => {
    const result = listDonationHistoryQuerySchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.limit).toBe(20);
  });

  it('coerces a string limit to a number', () => {
    const result = listDonationHistoryQuerySchema.safeParse({ limit: '5' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.limit).toBe(5);
  });

  it('rejects a limit over 100', () => {
    expect(listDonationHistoryQuerySchema.safeParse({ limit: '101' }).success).toBe(false);
  });

  it('rejects a limit under 1', () => {
    expect(listDonationHistoryQuerySchema.safeParse({ limit: '0' }).success).toBe(false);
  });

  it('accepts a cursor string', () => {
    expect(listDonationHistoryQuerySchema.safeParse({ cursor: 'abc' }).success).toBe(true);
  });

  it('rejects an unknown field (strict)', () => {
    expect(listDonationHistoryQuerySchema.safeParse({ extra: 1 }).success).toBe(false);
  });
});
