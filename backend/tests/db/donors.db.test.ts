import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// Batch 3.12 live tests. Same technique as tests/db/facilities.db.test.ts: the one module every
// new repository imports `db` from (src/db/connection.js) is redirected to a drizzle client built
// on this file's own already-guarded test-branch connection (tests/db/helpers.ts's `sql`), so the
// application code under test runs completely unmodified while every statement still goes only to
// the confirmed test branch. No source file is changed to make this possible.
vi.mock('../../src/db/connection.js', async () => {
  const { drizzle } = await import('drizzle-orm/postgres-js');
  const schema = await import('../../src/db/schema/index.js');
  const { sql } = await import('./helpers.js');
  return { db: drizzle(sql, { schema }), sql, closePool: async () => undefined };
});

const { createUser, createDonor, createHospital, createDonationIntervalRule, addActiveMembership, verifyFacility, expectSqlState, sql } = await import('./helpers.js');
const donorsRepository = await import('../../src/repositories/donors.repository.js');
const donorVerificationsRepository = await import('../../src/repositories/donorVerifications.repository.js');
const donorLocationsRepository = await import('../../src/repositories/donorLocations.repository.js');
const donationHistoryRepository = await import('../../src/repositories/donationHistory.repository.js');
const donorEligibilityCalculationsRepository = await import('../../src/repositories/donorEligibilityCalculations.repository.js');
const facilityMembershipsRepository = await import('../../src/repositories/facilityMemberships.repository.js');
const donorsService = await import('../../src/services/donorsService.js');
const donationRecordsService = await import('../../src/services/donationRecordsService.js');
const eligibilityCalculationService = await import('../../src/services/eligibilityCalculationService.js');
const { snapToCoarseGrid } = await import('../../src/utils/geo.js');

let ownerId: string;

beforeAll(async () => {
  ownerId = await createUser();
});

/**
 * donation_interval_rules_official_no_overlap (an OFFICIAL rule is a global singleton per effective
 * date range) means this file must never leave an open-ended ("effective forever") OFFICIAL rule
 * lying around once the tests that need it are done: a later test asserting NO_RULE would otherwise
 * see it too, since this whole file's rows persist across tests within one run (only the file-level
 * globalSetup truncates them). The bb_interval_rule_guard trigger (drizzle/0002_schema_a_guards.sql)
 * allows a rule's effective_to to be closed even once it has been referenced by a calculation - just
 * never deleted or otherwise edited - so this closes the one OFFICIAL rule this file ever creates
 * (see the nested "OFFICIAL vs FACILITY precedence" describe below) once both tests sharing it are done.
 */
async function closeOpenOfficialRules(): Promise<void> {
  await sql`UPDATE donation_interval_rules SET effective_to = CURRENT_DATE WHERE scope = 'OFFICIAL' AND (effective_to IS NULL OR effective_to > CURRENT_DATE)`;
}

/**
 * Inserts a facility-recorded donation_history row directly (no API/service layer exists to record
 * one yet). verificationStatus is UNVERIFIED or VERIFIED only: bb_donation_history_before_insert
 * (drizzle/0002_schema_a_guards.sql) forbids inserting a row as REJECTED outright (it may only be
 * reached via a later UPDATE, matching donationRecordsService.rejectDonation's actual flow), and an
 * INSERT as VERIFIED is only allowed when recordedBy is an ACTIVE member of a VERIFIED+ACTIVE
 * facility - satisfied here so every caller gets the real minimal-valid-row precondition for free.
 */
async function insertFacilityDonation(
  donorId: string,
  facilityId: string,
  recordedBy: string,
  overrides: { donatedAt?: Date; verificationStatus?: 'UNVERIFIED' | 'VERIFIED'; verifiedBy?: string } = {},
): Promise<string> {
  const donatedAt = overrides.donatedAt ?? new Date(Date.now() - 24 * 60 * 60 * 1000);
  const verificationStatus = overrides.verificationStatus ?? 'UNVERIFIED';
  const verifiedBy = verificationStatus === 'UNVERIFIED' ? null : overrides.verifiedBy ?? recordedBy;
  const verifiedAt = verificationStatus === 'UNVERIFIED' ? null : donatedAt;
  if (verificationStatus === 'VERIFIED') {
    await verifyFacility(facilityId);
    await addActiveMembership(recordedBy, facilityId, 'STAFF');
  }
  // .toISOString(): this file also builds a drizzle instance on this same shared `sql` client
  // (drizzle-orm/postgres-js's construct() overwrites client.options.serializers for the
  // timestamptz/date/time OIDs with an identity passthrough, since drizzle stringifies Date values
  // itself before handing them to postgres.js). That mutation is global to the shared client, not
  // scoped to drizzle's own queries, so a raw JS Date object passed directly into this file's own
  // sql`` template - bypassing drizzle - reaches postgres.js's low-level byte writer unconverted and
  // throws. Pre-stringifying here avoids relying on the (now-disabled) default Date serializer.
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO donation_history (donor_id, donated_at, source, facility_id, recorded_by, verification_status, verified_by, verified_at)
    VALUES (${donorId}, ${donatedAt.toISOString()}, 'FACILITY_RECORDED', ${facilityId}, ${recordedBy}, ${verificationStatus}, ${verifiedBy}, ${verifiedAt ? verifiedAt.toISOString() : null})
    RETURNING id`;
  return row!.id;
}

describe('donor profile creation and blood-group-change verification reset (donorsService.createOrUpdateProfile)', () => {
  it('creates a new donors row on first PUT, PENDING by default', async () => {
    const userId = await createUser();
    const result = await donorsService.createOrUpdateProfile(userId, { bloodGroup: 'A_POS' });
    expect(result).toMatchObject({ userId, bloodGroup: 'A_POS', verificationStatus: 'PENDING' });

    const rows = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM donors WHERE user_id = ${userId}`;
    expect(rows[0]!.n).toBe(1);
  });

  it('decision A: a bloodGroup change on an already-VERIFIED donor resets verification_status to PENDING and audits it', async () => {
    const userId = await createUser();
    const donor = await donorsService.createOrUpdateProfile(userId, { bloodGroup: 'O_POS' });
    await sql`UPDATE donors SET verification_status = 'VERIFIED' WHERE id = ${donor!.id}`;

    const updated = await donorsService.createOrUpdateProfile(userId, { bloodGroup: 'B_NEG' }, 'req-reset');
    expect(updated).toMatchObject({ bloodGroup: 'B_NEG', verificationStatus: 'PENDING' });

    const auditRows = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM audit_logs WHERE action = 'DONOR_BLOOD_GROUP_CHANGED' AND entity_id = ${donor!.id} AND correlation_id = 'req-reset'`;
    expect(auditRows[0]!.n).toBe(1);
  });

  it('a bloodGroup change while still PENDING does not need to reset anything (already PENDING), but is still audited', async () => {
    const userId = await createUser();
    const donor = await donorsService.createOrUpdateProfile(userId, { bloodGroup: 'O_POS' });

    const updated = await donorsService.createOrUpdateProfile(userId, { bloodGroup: 'AB_POS' });
    expect(updated).toMatchObject({ bloodGroup: 'AB_POS', verificationStatus: 'PENDING' });

    const auditRows = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM audit_logs WHERE action = 'DONOR_BLOOD_GROUP_CHANGED' AND entity_id = ${donor!.id}`;
    expect(auditRows[0]!.n).toBe(1);
  });
});

describe('donors_availability_until_temporary CHECK constraint (defense in depth beneath the validator)', () => {
  it('rejects availability_until set while availability_status is not TEMPORARILY_UNAVAILABLE', async () => {
    const userId = await createUser();
    const donorId = await createDonor(userId);
    await expectSqlState(
      () => donorsRepository.setAvailability(donorId, { availabilityStatus: 'AVAILABLE', availabilityUntil: new Date(Date.now() + 86400000) }),
      '23514',
    );
  });

  it('accepts TEMPORARILY_UNAVAILABLE with a until set', async () => {
    const userId = await createUser();
    const donorId = await createDonor(userId);
    const until = new Date(Date.now() + 86400000);
    await donorsRepository.setAvailability(donorId, { availabilityStatus: 'TEMPORARILY_UNAVAILABLE', availabilityUntil: until });
    const row = await donorsRepository.findById(donorId);
    expect(row).toMatchObject({ availabilityStatus: 'TEMPORARILY_UNAVAILABLE' });
    expect(row!.availabilityUntil).not.toBeNull();
  });
});

describe('location exact/coarse round-trip (donorsService.setLocation -> donor_locations)', () => {
  it('stores the exact point unchanged, and the coarse point snapped through snapToCoarseGrid, both readable back through PostGIS', async () => {
    const userId = await createUser();
    const donorId = await createDonor(userId);
    const input = { lat: 12.9716, lng: 77.5946 };

    await donorsService.setLocation(donorId, input);

    const [row] = await sql<{ exactLng: number; exactLat: number; coarseLng: number; coarseLat: number }[]>`
      SELECT ST_X(location_exact::geometry) AS "exactLng", ST_Y(location_exact::geometry) AS "exactLat",
             ST_X(location_coarse::geometry) AS "coarseLng", ST_Y(location_coarse::geometry) AS "coarseLat"
      FROM donor_locations WHERE donor_id = ${donorId}`;

    expect(row!.exactLng).toBeCloseTo(input.lng, 9);
    expect(row!.exactLat).toBeCloseTo(input.lat, 9);

    const expectedCoarse = snapToCoarseGrid(input);
    expect(row!.coarseLng).toBeCloseTo(expectedCoarse.lng, 9);
    expect(row!.coarseLat).toBeCloseTo(expectedCoarse.lat, 9);

    // findExactByDonorId (the only exact-location read path, server-side only) round-trips too.
    const exact = await donorLocationsRepository.findExactByDonorId(donorId);
    expect(exact!.lat).toBeCloseTo(input.lat, 9);
    expect(exact!.lng).toBeCloseTo(input.lng, 9);
  });

  it('a second setLocation call upserts the same row (never a second one)', async () => {
    const userId = await createUser();
    const donorId = await createDonor(userId);
    await donorsService.setLocation(donorId, { lat: 12.9716, lng: 77.5946 });
    await donorsService.setLocation(donorId, { lat: 13.0827, lng: 80.2707 });

    const rows = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM donor_locations WHERE donor_id = ${donorId}`;
    expect(rows[0]!.n).toBe(1);
  });
});

describe('verification submission state machine (donorsService.submitVerification, live)', () => {
  it('a first submission creates exactly one PENDING row; resubmitting while PENDING with a changed value updates the same row', async () => {
    const userId = await createUser();
    const donorId = await createDonor(userId);

    const first = await donorsService.submitVerification(donorId, { idType: 'AADHAAR', idLast4: '1234', idName: 'Anu' });
    expect(first.status).toBe('PENDING');

    const second = await donorsService.submitVerification(donorId, { idType: 'AADHAAR', idLast4: '5678', idName: 'Anu' });
    expect(second.id).toBe(first.id);

    const rows = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM donor_verifications WHERE donor_id = ${donorId}`;
    expect(rows[0]!.n).toBe(1);
    const row = await donorVerificationsRepository.findByDonorId(donorId);
    expect(row).toMatchObject({ idLast4: '5678', status: 'PENDING' });
  });

  it('an identical resubmission while PENDING is idempotent (no update, no duplicate audit)', async () => {
    const userId = await createUser();
    const donorId = await createDonor(userId);
    const input = { idType: 'AADHAAR', idLast4: '1234', idName: 'Anu' };
    await donorsService.submitVerification(donorId, input);
    await donorsService.submitVerification(donorId, input);

    const auditRows = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM audit_logs WHERE action = 'DONOR_VERIFICATION_SUBMITTED' AND entity_id = ${donorId}`;
    expect(auditRows[0]!.n).toBe(1);
  });

  it('UNDER_REVIEW rejects a resubmission with 409 CONFLICT, and VERIFIED rejects with 409 VERIFICATION_ALREADY_APPROVED', async () => {
    const userId = await createUser();
    const donorId = await createDonor(userId);
    const submitted = await donorsService.submitVerification(donorId, { idType: 'AADHAAR' });

    await sql`UPDATE donor_verifications SET status = 'UNDER_REVIEW' WHERE id = ${submitted.id}`;
    await expect(donorsService.submitVerification(donorId, { idType: 'AADHAAR', idName: 'x' })).rejects.toMatchObject({ status: 409, code: 'CONFLICT' });

    await sql`UPDATE donor_verifications SET status = 'VERIFIED', reviewed_by = ${ownerId}, reviewed_at = now() WHERE id = ${submitted.id}`;
    await expect(donorsService.submitVerification(donorId, { idType: 'AADHAAR', idName: 'y' })).rejects.toMatchObject({ status: 409, code: 'VERIFICATION_ALREADY_APPROVED' });
  });

  it('resubmission from REJECTED resets to PENDING and clears the reviewer fields', async () => {
    const userId = await createUser();
    const donorId = await createDonor(userId);
    const submitted = await donorsService.submitVerification(donorId, { idType: 'AADHAAR' });
    await sql`UPDATE donor_verifications SET status = 'REJECTED', reviewed_by = ${ownerId}, reviewed_at = now(), notes = 'nope' WHERE id = ${submitted.id}`;

    await donorsService.submitVerification(donorId, { idType: 'VOTER_ID', idLast4: '4321' });

    const row = await donorVerificationsRepository.findByDonorId(donorId);
    expect(row).toMatchObject({ idType: 'VOTER_ID', status: 'PENDING', reviewedBy: null, reviewedAt: null });
  });
});

describe('donor self-report (donorsService.reportSelfDonation)', () => {
  it('creates a SELF_REPORTED, UNVERIFIED row with no facility_id and no recorded_by (satisfies the OR-with-SELF_REPORTED CHECKs)', async () => {
    const userId = await createUser();
    const donorId = await createDonor(userId);
    const donatedAt = new Date(Date.now() - 60 * 60 * 1000);

    const result = await donorsService.reportSelfDonation(donorId, donatedAt);
    expect(result.status).toBe('UNVERIFIED');

    const row = await donationHistoryRepository.findById(result.id);
    expect(row).toMatchObject({ donorId, source: 'SELF_REPORTED', facilityId: null, verificationStatus: 'UNVERIFIED' });
  });

  it('rejects a future donatedAt at the database level too (donation_history_not_future)', async () => {
    const userId = await createUser();
    const donorId = await createDonor(userId);
    await expectSqlState(() => donorsService.reportSelfDonation(donorId, new Date(Date.now() + 86400000)), '23514');
  });
});

describe('the eligibility engine (eligibilityCalculationService.recompute, DATABASE.md 2.4) against real donation_interval_rules rows', () => {
  it('NO_DONATION when the donor has never had a VERIFIED donation', async () => {
    const userId = await createUser();
    const donorId = await createDonor(userId);

    const calc = await eligibilityCalculationService.recompute(donorId, 'MANUAL_RECHECK');
    expect(calc.outcome).toBe('NO_DONATION');
    expect(calc.nextEligibleAt).toBeNull();

    const donor = await donorsRepository.findById(donorId);
    expect(donor!.currentEligibilityCalcId).toBe(calc.id);
    expect(donor!.nextEligibleDonationAt).toBeNull();
  });

  it('fails closed to NO_RULE when no OFFICIAL or FACILITY rule is effective', async () => {
    const userId = await createUser();
    const donorId = await createDonor(userId);
    const hospitalId = await createHospital(ownerId);
    const donatedAt = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    await insertFacilityDonation(donorId, hospitalId, ownerId, { donatedAt, verificationStatus: 'VERIFIED', verifiedBy: ownerId });

    const calc = await eligibilityCalculationService.recompute(donorId, 'DONATION_VERIFIED');
    expect(calc.outcome).toBe('NO_RULE');
    expect(calc.nextEligibleAt).toBeNull();
  });

  it('a FACILITY rule at a DIFFERENT facility than the one that recorded the donation is never considered', async () => {
    const userId = await createUser();
    const donorId = await createDonor(userId);
    const recordingHospital = await createHospital(ownerId);
    const otherHospital = await createHospital(ownerId);
    const donatedAt = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    await insertFacilityDonation(donorId, recordingHospital, ownerId, { donatedAt, verificationStatus: 'VERIFIED', verifiedBy: ownerId });

    // A generous FACILITY rule at a facility this donation has nothing to do with must be ignored,
    // leaving no applicable rule at all -> fail closed.
    await createDonationIntervalRule(ownerId, { scope: 'FACILITY', facilityId: otherHospital });

    const calc = await eligibilityCalculationService.recompute(donorId, 'DONATION_VERIFIED');
    expect(calc.outcome).toBe('NO_RULE');
  });

  // donation_interval_rules_official_no_overlap allows only one open-ended OFFICIAL rule to exist at
  // a time (it is a global singleton per effective date range, unlike FACILITY rules which are
  // scoped per facility). The two tests below both need a currently-effective 90-day OFFICIAL rule,
  // so they share exactly one instead of each creating - and colliding over - their own; every test
  // OUTSIDE this block runs with no OFFICIAL rule at all, either because it runs first (above) or
  // because the file-level beforeEach closes this one again afterward (below).
  describe('OFFICIAL vs FACILITY precedence (sharing one 90-day OFFICIAL rule)', () => {
    let officialRuleId: string;

    beforeAll(async () => {
      officialRuleId = await createDonationIntervalRule(ownerId, { scope: 'OFFICIAL' }); // 90 days, effective 2020-01-01 to forever
    });

    afterAll(async () => {
      await closeOpenOfficialRules();
    });

    it('the longer interval wins regardless of which scope it is: a 120-day FACILITY rule beats the shared 90-day OFFICIAL one', async () => {
      const userId = await createUser();
      const donorId = await createDonor(userId);
      const hospitalId = await createHospital(ownerId);
      const donatedAt = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
      await insertFacilityDonation(donorId, hospitalId, ownerId, { donatedAt, verificationStatus: 'VERIFIED', verifiedBy: ownerId });

      const facilityRuleId = await createDonationIntervalRule(ownerId, { scope: 'FACILITY', facilityId: hospitalId });
      await sql`UPDATE donation_interval_rules SET min_interval_days = 120 WHERE id = ${facilityRuleId}`; // longer than the shared 90-day OFFICIAL rule

      const calc = await eligibilityCalculationService.recompute(donorId, 'DONATION_VERIFIED');
      expect(calc.outcome).toBe('COMPUTED');
      const expectedNextEligible = new Date(donatedAt.getTime() + 120 * 24 * 60 * 60 * 1000);
      expect(calc.nextEligibleAt!.getTime()).toBe(expectedNextEligible.getTime());

      const row = await sql<{ ruleId: string; scope: string }[]>`SELECT rule_id AS "ruleId", rule_scope_used AS scope FROM donor_eligibility_calculations WHERE id = ${calc.id}`;
      expect(row[0]).toMatchObject({ ruleId: facilityRuleId, scope: 'FACILITY' });
      expect(row[0]!.ruleId).not.toBe(officialRuleId);
    });

    it('an exact tie between OFFICIAL and FACILITY (both 90 days) prefers OFFICIAL', async () => {
      const userId = await createUser();
      const donorId = await createDonor(userId);
      const hospitalId = await createHospital(ownerId);
      const donatedAt = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
      await insertFacilityDonation(donorId, hospitalId, ownerId, { donatedAt, verificationStatus: 'VERIFIED', verifiedBy: ownerId });

      const facilityRuleId = await createDonationIntervalRule(ownerId, { scope: 'FACILITY', facilityId: hospitalId }); // also 90 days (helper default)

      const calc = await eligibilityCalculationService.recompute(donorId, 'DONATION_VERIFIED');
      const row = await sql<{ ruleId: string }[]>`SELECT rule_id AS "ruleId" FROM donor_eligibility_calculations WHERE id = ${calc.id}`;
      expect(row[0]!.ruleId).toBe(officialRuleId);
      expect(row[0]!.ruleId).not.toBe(facilityRuleId);
    });
  });

  it('atomicity: recomputing twice leaves exactly one CURRENT row per donor and supersedes the prior one', async () => {
    const userId = await createUser();
    const donorId = await createDonor(userId);
    const hospitalId = await createHospital(ownerId);
    await insertFacilityDonation(donorId, hospitalId, ownerId, { verificationStatus: 'VERIFIED', verifiedBy: ownerId });

    const first = await eligibilityCalculationService.recompute(donorId, 'MANUAL_RECHECK');
    const second = await eligibilityCalculationService.recompute(donorId, 'MANUAL_RECHECK');

    const currentRows = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM donor_eligibility_calculations WHERE donor_id = ${donorId} AND status = 'CURRENT'`;
    expect(currentRows[0]!.n).toBe(1);
    const firstRow = await sql<{ status: string }[]>`SELECT status FROM donor_eligibility_calculations WHERE id = ${first.id}`;
    expect(firstRow[0]!.status).toBe('SUPERSEDED');

    const donor = await donorsRepository.findById(donorId);
    expect(donor!.currentEligibilityCalcId).toBe(second.id);

    const current = await donorEligibilityCalculationsRepository.findCurrentByDonorId(donorId);
    expect(current!.id).toBe(second.id);
  });
});

describe('facility-scoped donation review data (facilityMembershipsRepository.findActiveMembership against the donation\'s own recording facility)', () => {
  it('a real ACTIVE membership at the recording facility is found; the same person has no membership at an unrelated facility', async () => {
    const userId = await createUser();
    const donorId = await createDonor(userId);
    const recordingHospital = await createHospital(ownerId);
    const otherHospital = await createHospital(ownerId);
    const staff = await createUser();
    await addActiveMembership(staff, recordingHospital, 'STAFF');
    const donationId = await insertFacilityDonation(donorId, recordingHospital, ownerId);

    const donation = await donationHistoryRepository.findById(donationId);
    expect(donation!.facilityId).toBe(recordingHospital);

    expect(await facilityMembershipsRepository.findActiveMembership(staff, donation!.facilityId!)).toMatchObject({ role: 'STAFF' });
    expect(await facilityMembershipsRepository.findActiveMembership(staff, otherHospital)).toBeUndefined();
  });
});

describe('donationRecordsService.verifyDonation / rejectDonation end to end (write + audit + recompute)', () => {
  it('verifyDonation marks VERIFIED, records who/when, audits DONATION_VERIFIED, and recomputes (NO_RULE with no rules configured)', async () => {
    const userId = await createUser();
    const donorId = await createDonor(userId);
    const hospitalId = await createHospital(ownerId);
    const staff = await createUser();
    await addActiveMembership(staff, hospitalId, 'STAFF');
    const donationId = await insertFacilityDonation(donorId, hospitalId, ownerId);

    const result = await donationRecordsService.verifyDonation(donationId, staff, 'req-verify');
    expect(result.status).toBe('VERIFIED');
    expect(result.calculation.outcome).toBe('NO_RULE');

    const row = await donationHistoryRepository.findById(donationId);
    expect(row).toMatchObject({ verificationStatus: 'VERIFIED', verifiedBy: staff });
    expect(row!.verifiedAt).not.toBeNull();

    const auditRows = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM audit_logs WHERE action = 'DONATION_VERIFIED' AND entity_id = ${donationId} AND correlation_id = 'req-verify'`;
    expect(auditRows[0]!.n).toBe(1);

    const donor = await donorsRepository.findById(donorId);
    expect(donor!.currentEligibilityCalcId).toBe(result.calculation.id);
  });

  it('rejectDonation marks REJECTED, audits DONATION_REJECTED, and still recomputes (a harmless no-op when it was never the latest VERIFIED donation)', async () => {
    const userId = await createUser();
    const donorId = await createDonor(userId);
    const hospitalId = await createHospital(ownerId);
    const donationId = await insertFacilityDonation(donorId, hospitalId, ownerId);

    const result = await donationRecordsService.rejectDonation(donationId, ownerId, 'req-reject');
    expect(result.status).toBe('REJECTED');
    expect(result.calculation.outcome).toBe('NO_DONATION'); // no VERIFIED donation exists for this donor

    const row = await donationHistoryRepository.findById(donationId);
    expect(row).toMatchObject({ verificationStatus: 'REJECTED', verifiedBy: ownerId });

    const auditRows = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM audit_logs WHERE action = 'DONATION_REJECTED' AND entity_id = ${donationId}`;
    expect(auditRows[0]!.n).toBe(1);
  });
});
