import type postgres from 'postgres';
import { describe, expect, it } from 'vitest';
import { createActiveBloodRequest, createBloodUnit, createDonor, createDonorSearch, createUser, freshId, withTwoConnections } from './helpers.js';

// Batch 3.7, D10: the multi-connection race tests. Each proves that a real, concurrently-attempted second write is
// blocked by PostgreSQL and then rejected once the first commits - never both succeeding, never a hang - for
// every schema-enforced uniqueness/exclusion guarantee that does not depend on any (not yet written) application
// code. See D9: this file does not test application-level acceptance-transaction logic.

type Outcome = { ok: true } | { ok: false; code: string | undefined };

async function attempt(fn: () => Promise<unknown>): Promise<Outcome> {
  try {
    await fn();
    return { ok: true };
  } catch (error) {
    return { ok: false, code: (error as { code?: unknown } | undefined)?.code as string | undefined };
  }
}

/**
 * Runs `first` on connection A inside an open transaction (not committed), starts `second` on connection B without
 * awaiting it (it should block on A's uncommitted row), waits briefly for B to actually reach that blocked state,
 * then commits A and awaits B. Asserts exactly one of the two succeeds, and the loser fails with `expectedCode`.
 *
 * The fixed delay below is a real, if imperfect, way to give B's query time to reach Postgres and start waiting
 * before A commits; on an unusually slow connection it could in principle let A commit before B has even been
 * sent, which would just make both attempts sequential rather than a true race (still a valid, if less strict,
 * proof - it would not produce a false pass).
 */
async function raceForExactlyOneWinner(params: {
  first: (tx: postgres.ReservedSql) => Promise<unknown>;
  second: (tx: postgres.ReservedSql) => Promise<unknown>;
  expectedConflictCode: string;
}): Promise<void> {
  await withTwoConnections(async (a, b) => {
    await a.unsafe('BEGIN');
    try {
      await params.first(a);
      const bPromise = attempt(() => params.second(b));
      await new Promise((resolve) => setTimeout(resolve, 500));
      await a.unsafe('COMMIT');
      const bResult = await bPromise;
      expect(bResult).toEqual({ ok: false, code: params.expectedConflictCode });
    } catch (error) {
      // a's transaction began above; if anything before COMMIT throws (including params.first itself), a is left
      // aborted. withTwoConnections releases a back into the shared pool regardless, so an un-rolled-back
      // transaction here would poison whatever later, unrelated query the pool next hands that connection to.
      // Rolling back after a successful COMMIT is a harmless no-op, so this is safe on every exit path.
      await a.unsafe('ROLLBACK').catch(() => {});
      throw error;
    }
  });
}

describe('concurrency: schema-enforced guarantees under two real, simultaneous connections', () => {
  it('donor_eligibility_calc_current_key: only one CURRENT calculation per donor can win', async () => {
    const owner = await createUser();
    const donor = await createDonor(owner);
    await raceForExactlyOneWinner({
      first: (tx) => tx`INSERT INTO donor_eligibility_calculations (donor_id, trigger_type, outcome) VALUES (${donor}, 'MANUAL_RECHECK', 'NO_DONATION')`,
      second: (tx) => tx`INSERT INTO donor_eligibility_calculations (donor_id, trigger_type, outcome) VALUES (${donor}, 'MANUAL_RECHECK', 'NO_DONATION')`,
      expectedConflictCode: '23505',
    });
  });

  it('inventory_reservations_one_active_per_unit: only one ACTIVE reservation per unit can win', async () => {
    const owner = await createUser();
    const unit = await createBloodUnit(owner);
    const requestA = await createActiveBloodRequest({ requesterId: owner });
    const requestB = await createActiveBloodRequest({ requesterId: owner });
    await raceForExactlyOneWinner({
      first: (tx) => tx`INSERT INTO inventory_reservations (unit_id, request_id, reserved_by, expires_at) VALUES (${unit.id}, ${requestA.id}, ${owner}, now() + interval '10 minutes')`,
      second: (tx) => tx`INSERT INTO inventory_reservations (unit_id, request_id, reserved_by, expires_at) VALUES (${unit.id}, ${requestB.id}, ${owner}, now() + interval '10 minutes')`,
      expectedConflictCode: '23505',
    });
  });

  it('notification_batches_one_active_per_search: only one ACTIVE batch per search can win', async () => {
    const owner = await createUser();
    const request = await createActiveBloodRequest({ requesterId: owner });
    const search = await createDonorSearch(request.id);
    await raceForExactlyOneWinner({
      first: (tx) => tx`INSERT INTO notification_batches (search_id, batch_number, status, expires_at) VALUES (${search}, 1, 'ACTIVE', now() + interval '10 minutes')`,
      second: (tx) => tx`INSERT INTO notification_batches (search_id, batch_number, status, expires_at) VALUES (${search}, 2, 'ACTIVE', now() + interval '10 minutes')`,
      expectedConflictCode: '23505',
    });
  });

  it('ml_model_versions_one_active: only one ACTIVE model can win', async () => {
    const activatorA = await createUser();
    const activatorB = await createUser();
    const versionA = freshId('model');
    const versionB = freshId('model');
    await raceForExactlyOneWinner({
      first: (tx) => tx`INSERT INTO ml_model_versions (model_version, algorithm, dataset_version, features_used, trained_at, artifact_ref, status, activated_at, activated_by)
                        VALUES (${versionA}, 'x', 'v1', ARRAY['x']::text[], now(), 'ref', 'ACTIVE', now(), ${activatorA})`,
      second: (tx) => tx`INSERT INTO ml_model_versions (model_version, algorithm, dataset_version, features_used, trained_at, artifact_ref, status, activated_at, activated_by)
                        VALUES (${versionB}, 'x', 'v1', ARRAY['x']::text[], now(), 'ref', 'ACTIVE', now(), ${activatorB})`,
      expectedConflictCode: '23505',
    });
  });

  it('data_deletion_requests_one_pending_per_user: only one PENDING request per user can win', async () => {
    const owner = await createUser();
    await raceForExactlyOneWinner({
      first: (tx) => tx`INSERT INTO data_deletion_requests (user_id, source) VALUES (${owner}, 'USER_REQUEST')`,
      second: (tx) => tx`INSERT INTO data_deletion_requests (user_id, source) VALUES (${owner}, 'CLERK_WEBHOOK')`,
      expectedConflictCode: '23505',
    });
  });

  it('eligibility_rules_no_overlap: only one of two overlapping date ranges for the same rule_key can win (EXCLUDE)', async () => {
    const owner = await createUser();
    await raceForExactlyOneWinner({
      first: (tx) => tx`INSERT INTO eligibility_rules (rule_key, value_int, effective_from, effective_to, source_note, entered_by) VALUES ('MIN_AGE', 18, '2100-01-01', '2110-01-01', 'x', ${owner})`,
      second: (tx) => tx`INSERT INTO eligibility_rules (rule_key, value_int, effective_from, effective_to, source_note, entered_by) VALUES ('MIN_AGE', 18, '2105-01-01', '2115-01-01', 'x', ${owner})`,
      expectedConflictCode: '23P01',
    });
  });

  it('donation_interval_rules_official_no_overlap: only one of two overlapping OFFICIAL ranges can win (EXCLUDE)', async () => {
    const owner = await createUser();
    await raceForExactlyOneWinner({
      first: (tx) =>
        tx`INSERT INTO donation_interval_rules (donation_type, min_interval_days, effective_from, effective_to, scope, source_note, entered_by)
           VALUES ('WHOLE_BLOOD', 90, '2100-01-01', '2110-01-01', 'OFFICIAL', 'x', ${owner})`,
      second: (tx) =>
        tx`INSERT INTO donation_interval_rules (donation_type, min_interval_days, effective_from, effective_to, scope, source_note, entered_by)
           VALUES ('WHOLE_BLOOD', 90, '2105-01-01', '2115-01-01', 'OFFICIAL', 'x', ${owner})`,
      expectedConflictCode: '23P01',
    });
  });

  it("settings_key_scope_urgency_key: only one row for the same key with scope and urgency both NULL can win (NULLS NOT DISTINCT)", async () => {
    const key = freshId('setting');
    await raceForExactlyOneWinner({
      first: (tx) => tx`INSERT INTO settings (key, value) VALUES (${key}, '1'::jsonb)`,
      second: (tx) => tx`INSERT INTO settings (key, value) VALUES (${key}, '2'::jsonb)`,
      expectedConflictCode: '23505',
    });
  });
});
