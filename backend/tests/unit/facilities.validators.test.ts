import { describe, expect, it } from 'vitest';
import {
  inviteStaffBodySchema,
  listFacilitiesQuerySchema,
  registerFacilityBodySchema,
  submitVerificationBodySchema,
  updateFacilityBodySchema,
  VERIFICATION_RELEVANT_FIELDS,
} from '../../src/validators/facilities.validators.js';

// Batch 3.11.

describe('registerFacilityBodySchema', () => {
  it('accepts a minimal valid body (name only)', () => {
    expect(registerFacilityBodySchema.safeParse({ name: 'DEMO Hospital' }).success).toBe(true);
  });

  it('rejects a blank name', () => {
    expect(registerFacilityBodySchema.safeParse({ name: '   ' }).success).toBe(false);
  });

  it('rejects an unknown field (strict)', () => {
    expect(registerFacilityBodySchema.safeParse({ name: 'x', facilityType: 'HOSPITAL' }).success).toBe(false);
  });

  it('rejects an out-of-range location', () => {
    expect(registerFacilityBodySchema.safeParse({ name: 'x', location: { lat: 999, lng: 0 } }).success).toBe(false);
  });

  it('accepts a valid location', () => {
    expect(registerFacilityBodySchema.safeParse({ name: 'x', location: { lat: 12.9716, lng: 77.5946 } }).success).toBe(true);
  });
});

describe('updateFacilityBodySchema', () => {
  it('accepts an empty patch', () => {
    expect(updateFacilityBodySchema.safeParse({}).success).toBe(true);
  });

  it('accepts explicit nulls for nullable fields', () => {
    expect(updateFacilityBodySchema.safeParse({ contact: null, address: null }).success).toBe(true);
  });

  it('VERIFICATION_RELEVANT_FIELDS is exactly the approved list, and contact is not in it', () => {
    expect([...VERIFICATION_RELEVANT_FIELDS].sort()).toEqual(['address', 'location', 'name', 'registrationNo']);
    expect(VERIFICATION_RELEVANT_FIELDS).not.toContain('contact');
  });
});

describe('submitVerificationBodySchema', () => {
  it('accepts a JSON object', () => {
    expect(submitVerificationBodySchema.safeParse({ registrationMetadata: { license: 'ABC123' } }).success).toBe(true);
  });

  it('rejects a missing registrationMetadata', () => {
    expect(submitVerificationBodySchema.safeParse({}).success).toBe(false);
  });
});

describe('inviteStaffBodySchema', () => {
  it('accepts a valid invite', () => {
    expect(inviteStaffBodySchema.safeParse({ userId: '11111111-1111-4111-8111-111111111111', role: 'STAFF' }).success).toBe(true);
  });

  it('rejects a non-uuid userId', () => {
    expect(inviteStaffBodySchema.safeParse({ userId: 'not-a-uuid', role: 'STAFF' }).success).toBe(false);
  });

  it('rejects a role outside FACILITY_ADMIN/STAFF', () => {
    expect(inviteStaffBodySchema.safeParse({ userId: '11111111-1111-4111-8111-111111111111', role: 'ADMIN' }).success).toBe(false);
  });
});

describe('listFacilitiesQuerySchema', () => {
  it('defaults limit to 20 and allows no cursor', () => {
    const result = listFacilitiesQuerySchema.safeParse({});
    expect(result.success && result.data.limit).toBe(20);
  });

  it('rejects a limit above 100 (API.md 1.3)', () => {
    expect(listFacilitiesQuerySchema.safeParse({ limit: '101' }).success).toBe(false);
  });

  it('rejects a limit below 1', () => {
    expect(listFacilitiesQuerySchema.safeParse({ limit: '0' }).success).toBe(false);
  });
});
