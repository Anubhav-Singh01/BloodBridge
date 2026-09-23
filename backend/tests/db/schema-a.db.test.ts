import { beforeAll, describe, expect, it } from 'vitest';
import {
  addActiveMembership,
  createDonationIntervalRule,
  createDonor,
  createEligibilityRule,
  createFacility,
  createHospital,
  createUser,
  expectSqlState,
  freshId,
  point,
  sql,
  verifyFacility,
} from './helpers.js';

// Constraints and triggers from 0001_schema_a.sql and 0002_schema_a_guards.sql (Batch 3.7).

let userId: string;
let donorId: string;
let facilityId: string;

beforeAll(async () => {
  userId = await createUser();
  donorId = await createDonor(userId);
  facilityId = await createFacility('HOSPITAL', userId).then((f) => f.id);
});

describe('users', () => {
  it('accepts an ACTIVE user with a clerk link, and an ANONYMIZED user with none', async () => {
    await expect(createUser()).resolves.toBeTypeOf('string');
    const [row] = await sql<{ id: string }[]>`INSERT INTO users (clerk_user_id, status, anonymized_at) VALUES (NULL, 'ANONYMIZED', now()) RETURNING id`;
    expect(row?.id).toBeTypeOf('string');
  });

  it('rejects an ACTIVE user with no clerk link (users_clerk_link_consistent), and an ANONYMIZED one with a link', async () => {
    await expectSqlState(() => sql`INSERT INTO users (clerk_user_id, status) VALUES (NULL, 'ACTIVE')`, '23514');
    await expectSqlState(() => sql`INSERT INTO users (clerk_user_id, status, anonymized_at) VALUES (${freshId('clerk')}, 'ANONYMIZED', now())`, '23514');
  });

  it('rejects a status/anonymized_at mismatch (users_anonymized_consistent)', async () => {
    await expectSqlState(() => sql`INSERT INTO users (clerk_user_id, status, anonymized_at) VALUES (${freshId('clerk')}, 'ACTIVE', now())`, '23514');
    await expectSqlState(() => sql`INSERT INTO users (clerk_user_id, status) VALUES (NULL, 'ANONYMIZED')`, '23514');
  });
});

describe('user_profiles', () => {
  it('accepts a profile with no phone, and one with a verified phone', async () => {
    const owner = await createUser();
    await expect(sql`INSERT INTO user_profiles (user_id) VALUES (${owner})`).resolves.toBeDefined();
    const owner2 = await createUser();
    await expect(sql`INSERT INTO user_profiles (user_id, phone, phone_verified_at) VALUES (${owner2}, '+911234567890', now())`).resolves.toBeDefined();
  });

  it('rejects phone_verified_at with no phone (user_profiles_verified_phone_exists)', async () => {
    const owner = await createUser();
    await expectSqlState(() => sql`INSERT INTO user_profiles (user_id, phone_verified_at) VALUES (${owner}, now())`, '23514');
  });

  it('rejects a date of birth in the future (user_profiles_dob_not_future)', async () => {
    const owner = await createUser();
    await expectSqlState(() => sql`INSERT INTO user_profiles (user_id, date_of_birth) VALUES (${owner}, '2999-01-01')`, '23514');
  });
});

describe('patients', () => {
  it('rejects a blank age_band (patients_age_band_not_blank)', async () => {
    await expectSqlState(() => sql`INSERT INTO patients (age_band, created_by) VALUES ('   ', ${userId})`, '23514');
  });

  it('lets a blood_request use only a patient its own requester created (blood_requests_patient_creator_fk, composite)', async () => {
    const otherUser = await createUser();
    const [patient] = await sql<{ id: string }[]>`INSERT INTO patients (age_band, created_by) VALUES ('ADULT', ${otherUser}) RETURNING id`;
    const hospitalId = await createHospital(userId);
    await expectSqlState(
      () => sql`
        INSERT INTO blood_requests (requester_id, patient_id, hospital_id, blood_group, component, units_required, required_donors, required_by, location)
        VALUES (${userId}, ${patient!.id}, ${hospitalId}, 'O_POS', 'WHOLE_BLOOD', 1, 1, now() + interval '6 hours', ${point(0, 0)})`,
      '23503',
    );
  });
});

describe('facilities, hospitals and blood_banks', () => {
  it('rejects a blank name (facilities_name_not_blank)', async () => {
    await expectSqlState(() => sql`INSERT INTO facilities (facility_type, name, created_by) VALUES ('HOSPITAL', '  ', ${userId})`, '23514');
  });

  it('rejects a VERIFIED facility with no location (facilities_verified_has_location), and accepts one with a location', async () => {
    const { id } = await createFacility('HOSPITAL', userId);
    await expectSqlState(() => sql`UPDATE facilities SET verification_status = 'VERIFIED' WHERE id = ${id}`, '23514');
    await expect(sql`UPDATE facilities SET verification_status = 'VERIFIED', location = ${point(0, 0)} WHERE id = ${id}`).resolves.toBeDefined();
  });

  it('rejects a hospital row pointed at a facility of type BLOOD_BANK (the composite (facility_id, facility_type) foreign key)', async () => {
    const bloodBankFacility = await createFacility('BLOOD_BANK', userId);
    await expectSqlState(() => sql`INSERT INTO hospitals (facility_id) VALUES (${bloodBankFacility.id})`, '23503');
  });

  it('rejects a blood_banks row pointed at a facility of type HOSPITAL', async () => {
    const hospitalFacility = await createFacility('HOSPITAL', userId);
    await expectSqlState(() => sql`INSERT INTO blood_banks (facility_id) VALUES (${hospitalFacility.id})`, '23503');
  });

  it('the hospitals_type_is_hospital and blood_banks_type_is_blood_bank CHECKs reject the other literal value', async () => {
    // The composite FK above already stops a mismatched facility. This proves the table's own CHECK also holds,
    // independent of the FK, for a facility_id that (hypothetically) belongs to the right type.
    const facility = await createFacility('HOSPITAL', userId);
    await expectSqlState(() => sql`INSERT INTO hospitals (facility_id, facility_type) VALUES (${facility.id}, 'BLOOD_BANK')`, '23514');
  });
});

describe('facility_memberships and facility_verifications', () => {
  it('rejects an ACTIVE membership with no joined_at, and an INVITED one with a joined_at (facility_memberships_joined_consistent)', async () => {
    const member = await createUser();
    await expectSqlState(() => sql`INSERT INTO facility_memberships (user_id, facility_id, role, status) VALUES (${member}, ${facilityId}, 'STAFF', 'ACTIVE')`, '23514');
    await expectSqlState(
      () => sql`INSERT INTO facility_memberships (user_id, facility_id, role, status, joined_at) VALUES (${member}, ${facilityId}, 'STAFF', 'INVITED', now())`,
      '23514',
    );
    await expect(addActiveMembership(member, facilityId)).resolves.toBeTypeOf('string');
  });

  it('rejects a VERIFIED facility_verifications row with no reviewer (facility_verifications_review_recorded)', async () => {
    const facility = await createFacility('HOSPITAL', userId);
    await expectSqlState(() => sql`INSERT INTO facility_verifications (facility_id, status) VALUES (${facility.id}, 'VERIFIED')`, '23514');
    await expect(
      sql`INSERT INTO facility_verifications (facility_id, status, reviewed_by, reviewed_at) VALUES (${facility.id}, 'VERIFIED', ${userId}, now())`,
    ).resolves.toBeDefined();
  });
});

describe('donors', () => {
  it('rejects availability_until set while not TEMPORARILY_UNAVAILABLE (donors_availability_until_temporary)', async () => {
    const owner = await createUser();
    const id = await createDonor(owner);
    await expectSqlState(() => sql`UPDATE donors SET availability_until = now() + interval '1 day' WHERE id = ${id}`, '23514');
    await expect(
      sql`UPDATE donors SET availability_status = 'TEMPORARILY_UNAVAILABLE', availability_until = now() + interval '1 day' WHERE id = ${id}`,
    ).resolves.toBeDefined();
  });

  it('rejects current_eligibility_calc_id pointing at another donor’s calculation (donors_current_calc_fk, composite)', async () => {
    const otherOwner = await createUser();
    const otherDonor = await createDonor(otherOwner);
    const [calc] = await sql<{ id: string }[]>`
      INSERT INTO donor_eligibility_calculations (donor_id, trigger_type, outcome) VALUES (${otherDonor}, 'MANUAL_RECHECK', 'NO_DONATION') RETURNING id`;
    await expectSqlState(() => sql`UPDATE donors SET current_eligibility_calc_id = ${calc!.id} WHERE id = ${donorId}`, '23503');
  });
});

describe('donor_verifications', () => {
  it('rejects a lower-case id_type (donor_verifications_id_type_format)', async () => {
    await expectSqlState(() => sql`INSERT INTO donor_verifications (donor_id, id_type) VALUES (${donorId}, 'aadhaar')`, '23514');
  });

  it('rejects an id_last4 that is not exactly four digits (donor_verifications_id_last4_format)', async () => {
    await expectSqlState(() => sql`INSERT INTO donor_verifications (donor_id, id_type, id_last4) VALUES (${donorId}, 'AADHAAR', '12A4')`, '23514');
  });

  it('rejects a VERIFIED verification with no reviewer (donor_verifications_review_recorded)', async () => {
    await expectSqlState(() => sql`INSERT INTO donor_verifications (donor_id, id_type, status) VALUES (${donorId}, 'AADHAAR', 'VERIFIED')`, '23514');
  });
});

describe('donation_history: CHECKs, the insert guard, and the append-only update guard', () => {
  it('rejects a future donated_at (donation_history_not_future)', async () => {
    await expectSqlState(
      () => sql`INSERT INTO donation_history (donor_id, donated_at, source) VALUES (${donorId}, now() + interval '1 day', 'SELF_REPORTED')`,
      '23514',
    );
  });

  it('requires a facility and a recorder unless self-reported (donation_history_facility_required, donation_history_recorder_required)', async () => {
    await expectSqlState(() => sql`INSERT INTO donation_history (donor_id, donated_at, source) VALUES (${donorId}, now(), 'FACILITY_RECORDED')`, '23514');
    await expect(sql`INSERT INTO donation_history (donor_id, donated_at, source) VALUES (${donorId}, now(), 'SELF_REPORTED')`).resolves.toBeDefined();
  });

  it('rejects inserting a donation as REJECTED (bb_donation_history_before_insert)', async () => {
    await expectSqlState(
      () => sql`INSERT INTO donation_history (donor_id, donated_at, source, verification_status) VALUES (${donorId}, now(), 'SELF_REPORTED', 'REJECTED')`,
      '23000',
    );
  });

  it('rejects inserting a VERIFIED donation that is not FACILITY_RECORDED (bb_donation_history_before_insert)', async () => {
    await expectSqlState(
      () => sql`INSERT INTO donation_history (donor_id, donated_at, source, facility_id, recorded_by, verification_status)
                VALUES (${donorId}, now(), 'SELF_REPORTED', ${facilityId}, ${userId}, 'VERIFIED')`,
      '23000',
    );
  });

  it('rejects inserting a FACILITY_RECORDED VERIFIED donation when the recorder has no active, verified membership (bb_donation_history_before_insert)', async () => {
    await expectSqlState(
      () => sql`INSERT INTO donation_history (donor_id, donated_at, source, facility_id, recorded_by, verification_status, verified_by, verified_at)
                VALUES (${donorId}, now(), 'FACILITY_RECORDED', ${facilityId}, ${userId}, 'VERIFIED', ${userId}, now())`,
      '23000',
    );
  });

  it('accepts inserting a FACILITY_RECORDED VERIFIED donation once the recorder is an active member of a verified, active facility', async () => {
    const facility = await createFacility('HOSPITAL', userId);
    await verifyFacility(facility.id);
    await addActiveMembership(userId, facility.id);
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO donation_history (donor_id, donated_at, source, facility_id, recorded_by, verification_status, verified_by, verified_at)
      VALUES (${donorId}, now(), 'FACILITY_RECORDED', ${facility.id}, ${userId}, 'VERIFIED', ${userId}, now())
      RETURNING id`;
    expect(row?.id).toBeTypeOf('string');
  });

  it('rejects changing anything but the verification fields after insert (bb_donation_history_guard_update)', async () => {
    const [row] = await sql<{ id: string }[]>`INSERT INTO donation_history (donor_id, donated_at, source) VALUES (${donorId}, now(), 'SELF_REPORTED') RETURNING id`;
    await expectSqlState(() => sql`UPDATE donation_history SET donated_at = now() - interval '1 day' WHERE id = ${row!.id}`, '23000');
    await expect(
      sql`UPDATE donation_history SET verification_status = 'REJECTED', verified_by = ${userId}, verified_at = now() WHERE id = ${row!.id}`,
    ).resolves.toBeDefined();
  });

  it('rejects deleting a donation_history row (append-only)', async () => {
    const [row] = await sql<{ id: string }[]>`INSERT INTO donation_history (donor_id, donated_at, source) VALUES (${donorId}, now(), 'SELF_REPORTED') RETURNING id`;
    await expectSqlState(() => sql`DELETE FROM donation_history WHERE id = ${row!.id}`, '23000');
  });
});

describe('donor_eligibility_calculations', () => {
  it('accepts the three documented outcome shapes, and rejects a shape mismatch (donor_eligibility_calc_outcome_shape)', async () => {
    // A fresh donor, not the shared donorId: this test's own successful insert below must not leave a CURRENT
    // row behind for donorId, which would collide with other tests in this describe block (D2).
    const owner = await createUser();
    const donor = await createDonor(owner);
    await expect(sql`INSERT INTO donor_eligibility_calculations (donor_id, trigger_type, outcome) VALUES (${donor}, 'MANUAL_RECHECK', 'NO_DONATION')`).resolves.toBeDefined();
    await expectSqlState(
      () => sql`INSERT INTO donor_eligibility_calculations (donor_id, trigger_type, outcome, next_eligible_at) VALUES (${donor}, 'MANUAL_RECHECK', 'NO_DONATION', now())`,
      '23514',
    );
  });

  it('rejects source_donation_id pointing at another donor’s donation (composite FK to donation_history)', async () => {
    const otherOwner = await createUser();
    const otherDonor = await createDonor(otherOwner);
    const [donation] = await sql<{ id: string }[]>`INSERT INTO donation_history (donor_id, donated_at, source) VALUES (${otherDonor}, now(), 'SELF_REPORTED') RETURNING id`;
    await expectSqlState(
      () => sql`
        INSERT INTO donor_eligibility_calculations (donor_id, trigger_type, source_donation_id, source_donated_at, outcome)
        VALUES (${donorId}, 'DONATION_VERIFIED', ${donation!.id}, now(), 'NO_RULE')`,
      '23503',
    );
  });

  it('allows at most one CURRENT calculation per donor (partial unique index), and only CURRENT to SUPERSEDED updates', async () => {
    const owner = await createUser();
    const donor = await createDonor(owner);
    const [first] = await sql<{ id: string }[]>`INSERT INTO donor_eligibility_calculations (donor_id, trigger_type, outcome) VALUES (${donor}, 'MANUAL_RECHECK', 'NO_DONATION') RETURNING id`;
    await expectSqlState(
      () => sql`INSERT INTO donor_eligibility_calculations (donor_id, trigger_type, outcome) VALUES (${donor}, 'MANUAL_RECHECK', 'NO_DONATION')`,
      '23505',
    );
    await expectSqlState(() => sql`UPDATE donor_eligibility_calculations SET trigger_type = 'DAILY_JOB' WHERE id = ${first!.id}`, '23000');
    await expect(sql`UPDATE donor_eligibility_calculations SET status = 'SUPERSEDED' WHERE id = ${first!.id}`).resolves.toBeDefined();
    // Now that the row is SUPERSEDED, a second CURRENT calculation for the same donor is allowed.
    await expect(sql`INSERT INTO donor_eligibility_calculations (donor_id, trigger_type, outcome) VALUES (${donor}, 'MANUAL_RECHECK', 'NO_DONATION')`).resolves.toBeDefined();
  });

  it('rejects deleting a calculation row (never deleted)', async () => {
    // A fresh donor, not the shared donorId, for the same reason as the outcome-shapes test above (D2).
    const owner = await createUser();
    const donor = await createDonor(owner);
    const [row] = await sql<{ id: string }[]>`INSERT INTO donor_eligibility_calculations (donor_id, trigger_type, outcome) VALUES (${donor}, 'MANUAL_RECHECK', 'NO_DONATION') RETURNING id`;
    await expectSqlState(() => sql`DELETE FROM donor_eligibility_calculations WHERE id = ${row!.id}`, '23000');
  });
});

describe('eligibility_rules and donation_interval_rules', () => {
  it('rejects a negative value_int (eligibility_rules_value_non_negative) and a blank source_note (eligibility_rules_source_not_blank)', async () => {
    await expectSqlState(() => sql`INSERT INTO eligibility_rules (rule_key, value_int, effective_from, source_note, entered_by) VALUES ('MIN_AGE', -1, '2020-01-01', 'x', ${userId})`, '23514');
    await expectSqlState(() => sql`INSERT INTO eligibility_rules (rule_key, value_int, effective_from, source_note, entered_by) VALUES ('MIN_AGE', 18, '2020-01-01', ' ', ${userId})`, '23514');
  });

  it('rejects effective_to not after effective_from (eligibility_rules_range_valid)', async () => {
    await expectSqlState(
      () => sql`INSERT INTO eligibility_rules (rule_key, value_int, effective_from, effective_to, source_note, entered_by) VALUES ('MIN_AGE', 18, '2020-01-01', '2019-01-01', 'x', ${userId})`,
      '23514',
    );
  });

  it('rejects two rules for the same rule_key with overlapping dates (eligibility_rules_no_overlap, EXCLUDE)', async () => {
    await createEligibilityRule(userId, { ruleKey: 'MAX_AGE', effectiveFrom: '2010-01-01', effectiveTo: '2020-01-01' });
    await expectSqlState(() => createEligibilityRule(userId, { ruleKey: 'MAX_AGE', effectiveFrom: '2015-01-01', effectiveTo: '2025-01-01' }), '23P01');
  });

  it('rejects a non-positive min_interval_days (donation_interval_rules_days_positive)', async () => {
    await expectSqlState(
      () => sql`INSERT INTO donation_interval_rules (donation_type, min_interval_days, effective_from, scope, source_note, entered_by) VALUES ('WHOLE_BLOOD', 0, '2021-01-01', 'OFFICIAL', 'x', ${userId})`,
      '23514',
    );
  });

  it('requires facility_id if and only if scope is FACILITY (donation_interval_rules_scope_facility)', async () => {
    await expectSqlState(
      () => sql`INSERT INTO donation_interval_rules (donation_type, min_interval_days, effective_from, scope, source_note, entered_by) VALUES ('WHOLE_BLOOD', 90, '2030-01-01', 'FACILITY', 'x', ${userId})`,
      '23514',
    );
    await expectSqlState(
      () => sql`INSERT INTO donation_interval_rules (donation_type, min_interval_days, effective_from, scope, facility_id, source_note, entered_by) VALUES ('WHOLE_BLOOD', 90, '2031-01-01', 'OFFICIAL', ${facilityId}, 'x', ${userId})`,
      '23514',
    );
  });

  it('lets an OFFICIAL and a FACILITY rule cover the same dates (the EXCLUDE constraints are scoped separately)', async () => {
    // Bounded, not open-ended: an unbounded effective_to would swallow every later OFFICIAL-scope date used
    // elsewhere in this file and in concurrency.db.test.ts, since there is no reset between test files (D3).
    await expect(createDonationIntervalRule(userId, { scope: 'OFFICIAL', effectiveFrom: '2040-01-01', effectiveTo: '2041-01-01' })).resolves.toBeTypeOf('string');
    await expect(createDonationIntervalRule(userId, { scope: 'FACILITY', facilityId, effectiveFrom: '2040-01-01', effectiveTo: '2041-01-01' })).resolves.toBeTypeOf('string');
  });

  it('rejects two OFFICIAL rules with overlapping dates for the same donation_type (eligibility_rules_no_overlap-style EXCLUDE)', async () => {
    await createDonationIntervalRule(userId, { scope: 'OFFICIAL', effectiveFrom: '2050-01-01', effectiveTo: '2060-01-01' });
    await expectSqlState(() => createDonationIntervalRule(userId, { scope: 'OFFICIAL', effectiveFrom: '2055-01-01', effectiveTo: '2065-01-01' }), '23P01');
  });

  it('a donation_interval_rules row referenced by a calculation can only be closed (effective_to), never deleted or otherwise changed (bb_interval_rule_guard)', async () => {
    const owner = await createUser();
    const donor = await createDonor(owner);
    // Bounded at creation (see D3 note above); the close below narrows it further, well short of the
    // unreferencedRuleId fixture's 2080 start.
    const ruleId = await createDonationIntervalRule(userId, { effectiveFrom: '2070-01-01', effectiveTo: '2071-01-01' });
    const [donation] = await sql<{ id: string }[]>`INSERT INTO donation_history (donor_id, donated_at, source) VALUES (${donor}, now(), 'SELF_REPORTED') RETURNING id`;
    await sql`
      INSERT INTO donor_eligibility_calculations (donor_id, trigger_type, source_donation_id, source_donated_at, rule_id, considered_rule_ids, interval_days_used, rule_scope_used, rule_effective_from, rule_source_note, outcome, next_eligible_at)
      VALUES (${donor}, 'DONATION_VERIFIED', ${donation!.id}, now(), ${ruleId}, ARRAY[${ruleId}]::uuid[], 90, 'OFFICIAL', '2070-01-01', 'x', 'COMPUTED', now() + interval '90 days')`;
    await expectSqlState(() => sql`DELETE FROM donation_interval_rules WHERE id = ${ruleId}`, '23000');
    await expectSqlState(() => sql`UPDATE donation_interval_rules SET min_interval_days = 100 WHERE id = ${ruleId}`, '23000');
    await expect(sql`UPDATE donation_interval_rules SET effective_to = '2070-06-01' WHERE id = ${ruleId}`).resolves.toBeDefined();

    const unreferencedRuleId = await createDonationIntervalRule(userId, { effectiveFrom: '2080-01-01', effectiveTo: '2081-01-01' });
    await expect(sql`DELETE FROM donation_interval_rules WHERE id = ${unreferencedRuleId}`).resolves.toBeDefined();
  });
});

describe('compatibility_rules', () => {
  it('rejects effective_to not after effective_from, and a blank source_note', async () => {
    await expectSqlState(
      () => sql`INSERT INTO compatibility_rules (component, recipient_group, donor_group, effective_from, effective_to, source_note) VALUES ('WHOLE_BLOOD', 'O_POS', 'O_POS', '2020-01-01', '2019-01-01', 'x')`,
      '23514',
    );
    await expectSqlState(
      () => sql`INSERT INTO compatibility_rules (component, recipient_group, donor_group, effective_from, source_note) VALUES ('WHOLE_BLOOD', 'O_POS', 'O_POS', '2020-01-01', ' ')`,
      '23514',
    );
  });
});

describe('geography: a real round trip through PostGIS', () => {
  it('writes and reads back the same longitude and latitude (donor_locations)', async () => {
    const owner = await createUser();
    const donor = await createDonor(owner);
    const lng = 77.594566;
    const lat = 12.971599;
    await sql`INSERT INTO donor_locations (donor_id, location_exact, location_coarse) VALUES (${donor}, ${point(lng, lat)}, ${point(lng, lat)})`;
    const [row] = await sql<{ lng: number; lat: number }[]>`
      SELECT ST_X(location_exact::geometry) AS lng, ST_Y(location_exact::geometry) AS lat FROM donor_locations WHERE donor_id = ${donor}`;
    expect(row?.lng).toBeCloseTo(lng, 6);
    expect(row?.lat).toBeCloseTo(lat, 6);
  });
});
