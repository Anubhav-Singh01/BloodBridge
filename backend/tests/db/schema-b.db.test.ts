import { beforeAll, describe, expect, it } from 'vitest';
import {
  createActiveBloodRequest,
  createBloodUnit,
  createDraftBloodRequest,
  createHospital,
  createUser,
  expectSqlState,
  freshId,
  point,
  sql,
  walkRequestTo,
} from './helpers.js';

// Constraints and triggers from 0003_schema_b.sql and 0004_schema_b_guards.sql (Batch 3.7).

let userId: string;

beforeAll(async () => {
  userId = await createUser();
});

describe('blood_requests: CHECKs', () => {
  it('rejects non-positive units_required or required_donors', async () => {
    const hospitalId = await createHospital(userId);
    const patientAndRequester = await createDraftBloodRequest({ requesterId: userId, hospitalId });
    await expectSqlState(() => sql`UPDATE blood_requests SET units_required = 0 WHERE id = ${patientAndRequester.id}`, '23514');
    await expectSqlState(() => sql`UPDATE blood_requests SET required_donors = 0 WHERE id = ${patientAndRequester.id}`, '23514');
  });

  it('requires expires_at once the request is no longer DRAFT (blood_requests_expiry_set)', async () => {
    const request = await createDraftBloodRequest({ requesterId: userId });
    await sql`UPDATE blood_requests SET expires_at = NULL WHERE id = ${request.id}`; // DRAFT may have none
    await expectSqlState(() => sql`UPDATE blood_requests SET status = 'SUBMITTED' WHERE id = ${request.id}`, '23514');
  });
});

describe('the request state machine (bb_blood_request_state_guard)', () => {
  it('rejects an INSERT that is not DRAFT', async () => {
    const hospitalId = await createHospital(userId);
    const [patient] = await sql<{ id: string }[]>`INSERT INTO patients (age_band, created_by) VALUES ('ADULT', ${userId}) RETURNING id`;
    await expectSqlState(
      () => sql`
        INSERT INTO blood_requests (requester_id, patient_id, hospital_id, blood_group, component, units_required, required_donors, required_by, location, status, expires_at)
        VALUES (${userId}, ${patient!.id}, ${hospitalId}, 'O_POS', 'WHOLE_BLOOD', 1, 1, now() + interval '6 hours', ${point(0, 0)}, 'SUBMITTED', now() + interval '1 day')`,
      '23000',
    );
  });

  it('walks a full realistic lifecycle: DRAFT -> SUBMITTED -> ACTIVE -> DONOR_SEARCH -> DONOR_CONTACTED -> DONOR_ACCEPTED -> DONOR_CONFIRMED -> FULFILLED', async () => {
    const request = await createDraftBloodRequest({ requesterId: userId });
    await expect(
      walkRequestTo(request.id, ['SUBMITTED', 'ACTIVE', 'DONOR_SEARCH', 'DONOR_CONTACTED', 'DONOR_ACCEPTED', 'DONOR_CONFIRMED', 'FULFILLED']),
    ).resolves.toBeUndefined();
    const [row] = await sql<{ status: string }[]>`SELECT status FROM blood_requests WHERE id = ${request.id}`;
    expect(row?.status).toBe('FULFILLED');
  });

  it('rejects a transition that is not in request_transitions (for example DRAFT -> ACTIVE directly)', async () => {
    const request = await createDraftBloodRequest({ requesterId: userId });
    await expectSqlState(() => sql`UPDATE blood_requests SET status = 'ACTIVE' WHERE id = ${request.id}`, '23000');
  });

  it('rejects any transition out of a terminal state (FULFILLED, CANCELLED, EXPIRED, REJECTED each have no outgoing row)', async () => {
    const fulfilled = await createDraftBloodRequest({ requesterId: userId });
    await walkRequestTo(fulfilled.id, ['SUBMITTED', 'ACTIVE', 'DONOR_SEARCH', 'DONOR_CONTACTED', 'DONOR_ACCEPTED', 'DONOR_CONFIRMED', 'FULFILLED']);
    await expectSqlState(() => sql`UPDATE blood_requests SET status = 'DONOR_SEARCH' WHERE id = ${fulfilled.id}`, '23000');

    const cancelled = await createDraftBloodRequest({ requesterId: userId });
    await walkRequestTo(cancelled.id, ['CANCELLED']);
    await expectSqlState(() => sql`UPDATE blood_requests SET status = 'SUBMITTED' WHERE id = ${cancelled.id}`, '23000');
  });

  it('samples several intermediate states, each allowing more than one documented next state', async () => {
    // SUBMITTED -> VERIFICATION_PENDING (normal path) as well as -> ACTIVE (emergency fast path, tested above).
    const normal = await createDraftBloodRequest({ requesterId: userId });
    await walkRequestTo(normal.id, ['SUBMITTED', 'VERIFICATION_PENDING']);
    await expect(sql`UPDATE blood_requests SET status = 'ACTIVE' WHERE id = ${normal.id}`).resolves.toBeDefined();

    // VERIFICATION_PENDING -> REJECTED (a hospital or admin rejects the request during verification).
    const rejected = await createDraftBloodRequest({ requesterId: userId });
    await walkRequestTo(rejected.id, ['SUBMITTED', 'VERIFICATION_PENDING']);
    await expect(sql`UPDATE blood_requests SET status = 'REJECTED' WHERE id = ${rejected.id}`).resolves.toBeDefined();

    // DONOR_CONTACTED -> DONOR_SEARCH (next batch), a documented alternative to -> DONOR_ACCEPTED.
    const nextBatch = await createDraftBloodRequest({ requesterId: userId });
    await walkRequestTo(nextBatch.id, ['SUBMITTED', 'ACTIVE', 'DONOR_SEARCH', 'DONOR_CONTACTED']);
    await expect(sql`UPDATE blood_requests SET status = 'DONOR_SEARCH' WHERE id = ${nextBatch.id}`).resolves.toBeDefined();

    // ACTIVE -> FULFILLED directly (the inventory-only fulfilment path, no donor search at all).
    const inventoryOnly = await createDraftBloodRequest({ requesterId: userId });
    await walkRequestTo(inventoryOnly.id, ['SUBMITTED', 'ACTIVE']);
    await expect(sql`UPDATE blood_requests SET status = 'FULFILLED' WHERE id = ${inventoryOnly.id}`).resolves.toBeDefined();
  });

  it('has exactly the 29 transitions documented in DATABASE.md section 4, seeded by the migration', async () => {
    const [row] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM request_transitions`;
    expect(row?.n).toBe(29);
  });
});

describe('blood_request_status_history (append-only, and its own CHECKs)', () => {
  it('rejects a first row that is not DRAFT (blood_request_status_history_first_is_draft), and a row that does not change status', async () => {
    const requestId = (await createDraftBloodRequest({ requesterId: userId })).id;
    await expectSqlState(
      () => sql`INSERT INTO blood_request_status_history (request_id, to_status) VALUES (${requestId}, 'SUBMITTED')`,
      '23514',
    );
    await expectSqlState(
      () => sql`INSERT INTO blood_request_status_history (request_id, from_status, to_status) VALUES (${requestId}, 'DRAFT', 'DRAFT')`,
      '23514',
    );
  });

  it('rejects update and delete (append-only)', async () => {
    const requestId = (await createDraftBloodRequest({ requesterId: userId })).id;
    const [row] = await sql<{ id: string }[]>`INSERT INTO blood_request_status_history (request_id, to_status) VALUES (${requestId}, 'DRAFT') RETURNING id`;
    await expectSqlState(() => sql`UPDATE blood_request_status_history SET reason = 'x' WHERE id = ${row!.id}`, '23000');
    await expectSqlState(() => sql`DELETE FROM blood_request_status_history WHERE id = ${row!.id}`, '23000');
  });
});

describe('request_events (bb_request_event_match_guard) and request_flags', () => {
  it('rejects an event whose match belongs to a different request', async () => {
    const requestA = await createActiveBloodRequest({ requesterId: userId });
    const requestB = await createActiveBloodRequest({ requesterId: userId });
    const donorSearchB = await sql<{ id: string }[]>`INSERT INTO donor_searches (request_id, config_snapshot, required_donors) VALUES (${requestB.id}, '{}'::jsonb, 1) RETURNING id`;
    const donorOwner = await createUser();
    const [donor] = await sql<{ id: string }[]>`INSERT INTO donors (user_id, blood_group) VALUES (${donorOwner}, 'O_POS') RETURNING id`;
    const [match] = await sql<{ id: string }[]>`
      INSERT INTO donor_matches (search_id, donor_id) VALUES (${donorSearchB[0]!.id}, ${donor!.id}) RETURNING id`;
    await expectSqlState(
      () => sql`INSERT INTO request_events (request_id, match_id, event_type) VALUES (${requestA.id}, ${match!.id}, 'NOTE')`,
      '23000',
    );
    await expect(sql`INSERT INTO request_events (request_id, event_type) VALUES (${requestA.id}, 'NOTE')`).resolves.toBeDefined();
  });

  it('rejects update and delete on request_events (append-only)', async () => {
    const request = await createActiveBloodRequest({ requesterId: userId });
    const [row] = await sql<{ id: string }[]>`INSERT INTO request_events (request_id, event_type) VALUES (${request.id}, 'NOTE') RETURNING id`;
    await expectSqlState(() => sql`UPDATE request_events SET event_type = 'ETA_UPDATED' WHERE id = ${row!.id}`, '23000');
    await expectSqlState(() => sql`DELETE FROM request_events WHERE id = ${row!.id}`, '23000');
  });

  it('rejects a rule_code that is not upper-case (request_flags_rule_code_format), and requires the resolution pair together', async () => {
    const request = await createActiveBloodRequest({ requesterId: userId });
    await expectSqlState(() => sql`INSERT INTO request_flags (request_id, rule_code) VALUES (${request.id}, 'lowercase')`, '23514');
    await expectSqlState(
      () => sql`INSERT INTO request_flags (request_id, rule_code, resolved_at) VALUES (${request.id}, 'SUSPICIOUS_PATTERN', now())`,
      '23514',
    );
  });
});

describe('blood_units (CHECKs and bb_blood_unit_guard_update)', () => {
  it('rejects expires_at not after collected_at (blood_units_expiry_after_collection)', async () => {
    const now = new Date();
    await expectSqlState(() => createBloodUnit(userId, { collectedAt: now, expiresAt: now }), '23514');
  });

  it('rejects a status/active_reservation_id mismatch (blood_units_reserved_has_reservation)', async () => {
    const unit = await createBloodUnit(userId);
    await expectSqlState(() => sql`UPDATE blood_units SET status = 'RESERVED' WHERE id = ${unit.id}`, '23514');
  });

  it('rejects blank identifiers (blood_units_identifiers_not_blank)', async () => {
    const facilityId = (await createBloodUnit(userId)).facilityId;
    await expectSqlState(
      () => sql`INSERT INTO blood_units (unit_uid, facility_unit_code, facility_id, origin_facility_id, blood_group, component, collected_at, expires_at)
                VALUES (' ', ${freshId('code')}, ${facilityId}, ${facilityId}, 'O_POS', 'WHOLE_BLOOD', now() - interval '1 day', now() + interval '30 days')`,
      '23514',
    );
  });

  it('rejects changing unit_uid, origin_facility_id or source_donation_id after insert (bb_blood_unit_guard_update)', async () => {
    const unit = await createBloodUnit(userId);
    await expectSqlState(() => sql`UPDATE blood_units SET unit_uid = ${freshId('unit')} WHERE id = ${unit.id}`, '23000');
    const otherFacility = await createBloodUnit(userId).then((u) => u.facilityId);
    await expectSqlState(() => sql`UPDATE blood_units SET origin_facility_id = ${otherFacility} WHERE id = ${unit.id}`, '23000');
  });

  it("rejects changing an ISSUED unit's blood group, component or dates (bb_blood_unit_guard_update)", async () => {
    const unit = await createBloodUnit(userId);
    await sql`UPDATE blood_units SET status = 'ISSUED' WHERE id = ${unit.id}`;
    await expectSqlState(() => sql`UPDATE blood_units SET blood_group = 'A_POS' WHERE id = ${unit.id}`, '23000');
    await expect(sql`UPDATE blood_units SET storage_location = 'fridge 2' WHERE id = ${unit.id}`).resolves.toBeDefined();
  });

  it('rejects deleting a blood unit (never deleted)', async () => {
    const unit = await createBloodUnit(userId);
    await expectSqlState(() => sql`DELETE FROM blood_units WHERE id = ${unit.id}`, '23000');
  });
});

describe('blood_unit_events (append-only, and its own CHECKs)', () => {
  it('requires both facilities and that they differ for a TRANSFERRED event (blood_unit_events_transfer_facilities)', async () => {
    const unit = await createBloodUnit(userId);
    await expectSqlState(() => sql`INSERT INTO blood_unit_events (unit_id, event) VALUES (${unit.id}, 'TRANSFERRED')`, '23514');
    const otherFacility = await createBloodUnit(userId).then((u) => u.facilityId);
    await expectSqlState(
      () => sql`INSERT INTO blood_unit_events (unit_id, event, from_facility_id, to_facility_id) VALUES (${unit.id}, 'TRANSFERRED', ${unit.facilityId}, ${unit.facilityId})`,
      '23514',
    );
    await expect(
      sql`INSERT INTO blood_unit_events (unit_id, event, from_facility_id, to_facility_id) VALUES (${unit.id}, 'TRANSFERRED', ${unit.facilityId}, ${otherFacility})`,
    ).resolves.toBeDefined();
  });

  it('requires a request_id for RESERVED, RELEASED and ISSUED events (blood_unit_events_request_required)', async () => {
    const unit = await createBloodUnit(userId);
    await expectSqlState(() => sql`INSERT INTO blood_unit_events (unit_id, event) VALUES (${unit.id}, 'RESERVED')`, '23514');
    await expect(sql`INSERT INTO blood_unit_events (unit_id, event) VALUES (${unit.id}, 'RECEIVED')`).resolves.toBeDefined();
  });

  it('rejects update and delete (append-only)', async () => {
    const unit = await createBloodUnit(userId);
    const [row] = await sql<{ id: string }[]>`INSERT INTO blood_unit_events (unit_id, event) VALUES (${unit.id}, 'RECEIVED') RETURNING id`;
    await expectSqlState(() => sql`UPDATE blood_unit_events SET reason = 'x' WHERE id = ${row!.id}`, '23000');
    await expectSqlState(() => sql`DELETE FROM blood_unit_events WHERE id = ${row!.id}`, '23000');
  });
});

describe('inventory_reservations (CHECKs and bb_reservation_guard_update)', () => {
  async function reserve(unitId: string, requestId: string): Promise<string> {
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO inventory_reservations (unit_id, request_id, reserved_by, expires_at) VALUES (${unitId}, ${requestId}, ${userId}, now() + interval '30 minutes') RETURNING id`;
    return row!.id;
  }

  it('rejects expires_at not after reserved_at (inventory_reservations_expiry_after_reserved)', async () => {
    const unit = await createBloodUnit(userId);
    const request = await createActiveBloodRequest({ requesterId: userId });
    await expectSqlState(
      () => sql`INSERT INTO inventory_reservations (unit_id, request_id, reserved_by, reserved_at, expires_at) VALUES (${unit.id}, ${request.id}, ${userId}, now(), now())`,
      '23514',
    );
  });

  it('requires released_at exactly when the status is RELEASED or EXPIRED (inventory_reservations_end_recorded)', async () => {
    const unit = await createBloodUnit(userId);
    const request = await createActiveBloodRequest({ requesterId: userId });
    const id = await reserve(unit.id, request.id);
    await expectSqlState(() => sql`UPDATE inventory_reservations SET status = 'RELEASED' WHERE id = ${id}`, '23514');
    await expect(sql`UPDATE inventory_reservations SET status = 'RELEASED', released_at = now() WHERE id = ${id}`).resolves.toBeDefined();
  });

  it('rejects a release_reason unless the reservation has ended (inventory_reservations_reason_only_when_ended)', async () => {
    const unit = await createBloodUnit(userId);
    const request = await createActiveBloodRequest({ requesterId: userId });
    const id = await reserve(unit.id, request.id);
    await expectSqlState(() => sql`UPDATE inventory_reservations SET release_reason = 'x' WHERE id = ${id}`, '23514');
  });

  it('freezes a non-ACTIVE reservation entirely, and only allows status/released_at/release_reason on an ACTIVE one (bb_reservation_guard_update)', async () => {
    const unit = await createBloodUnit(userId);
    const request = await createActiveBloodRequest({ requesterId: userId });
    const id = await reserve(unit.id, request.id);
    await expect(sql`UPDATE inventory_reservations SET status = 'RELEASED', released_at = now(), release_reason = 'x' WHERE id = ${id}`).resolves.toBeDefined();
    await expectSqlState(() => sql`UPDATE inventory_reservations SET release_reason = 'y' WHERE id = ${id}`, '23000');

    const unit2 = await createBloodUnit(userId);
    const otherRequest = await createActiveBloodRequest({ requesterId: userId });
    const id2 = await reserve(unit2.id, request.id);
    await expectSqlState(() => sql`UPDATE inventory_reservations SET request_id = ${otherRequest.id} WHERE id = ${id2}`, '23000');
  });

  it('rejects deleting a reservation (never deleted)', async () => {
    const unit = await createBloodUnit(userId);
    const request = await createActiveBloodRequest({ requesterId: userId });
    const id = await reserve(unit.id, request.id);
    await expectSqlState(() => sql`DELETE FROM inventory_reservations WHERE id = ${id}`, '23000');
  });
});
