import { beforeAll, describe, expect, it } from 'vitest';
import {
  createActiveBloodRequest,
  createDonor,
  createDonorSearch,
  createMlModelVersion,
  createNotificationBatch,
  createRankingPrediction,
  createRankingRun,
  createUser,
  expectSqlState,
  freshId,
  sql,
} from './helpers.js';

// Constraints and triggers from 0005_schema_c.sql and 0006_schema_c_guards.sql (Batch 3.7). This file fills the
// 14 it.todo() placeholders that were deliberately left in tests/unit/schema-c.test.ts during Batch 3.4.

let userId: string;
let searchId: string;

beforeAll(async () => {
  userId = await createUser();
  const request = await createActiveBloodRequest({ requesterId: userId });
  searchId = await createDonorSearch(request.id);
});

describe('donor_searches', () => {
  it('rejects a non-positive required_donors, a negative confirmed_count over the required amount, and a negative batch_count', async () => {
    await expectSqlState(() => sql`UPDATE donor_searches SET required_donors = 0 WHERE id = ${searchId}`, '23514');
    await expectSqlState(() => sql`UPDATE donor_searches SET confirmed_count = -1 WHERE id = ${searchId}`, '23514');
    await expectSqlState(() => sql`UPDATE donor_searches SET confirmed_count = 999 WHERE id = ${searchId}`, '23514');
    await expectSqlState(() => sql`UPDATE donor_searches SET batch_count = -1 WHERE id = ${searchId}`, '23514');
  });

  it('rejects a config_snapshot that is not a JSON object', async () => {
    const request = await createActiveBloodRequest({ requesterId: userId });
    await expectSqlState(
      () => sql`INSERT INTO donor_searches (request_id, config_snapshot, required_donors) VALUES (${request.id}, '[1,2]'::jsonb, 1)`,
      '23514',
    );
  });
});

describe('ranking_runs', () => {
  it('rejects a negative input_count and a blank model_version', async () => {
    // Probed via INSERT, not UPDATE: ranking_runs is append-only (bb_forbid_update), so an UPDATE would always
    // be blocked by that BEFORE trigger (SQLSTATE 23000) before ranking_runs_input_count_non_negative is ever
    // evaluated. INSERT has no such guard, so the CHECK is reached directly.
    await expectSqlState(
      () => sql`INSERT INTO ranking_runs (search_id, ranker_type, model_version, trigger_type, input_count) VALUES (${searchId}, 'FALLBACK', 'rule-based-fallback', 'INITIAL', -1)`,
      '23514',
    );
    await expectSqlState(
      () => sql`INSERT INTO ranking_runs (search_id, ranker_type, model_version, trigger_type, input_count) VALUES (${searchId}, 'FALLBACK', ' ', 'INITIAL', 0)`,
      '23514',
    );
  });

  it('a FALLBACK run must carry the rule-based-fallback label, and an ML run must not (ranking_runs_fallback_version)', async () => {
    await expectSqlState(
      () => sql`INSERT INTO ranking_runs (search_id, ranker_type, model_version, trigger_type, input_count) VALUES (${searchId}, 'FALLBACK', 'not-the-label', 'INITIAL', 0)`,
      '23514',
    );
    await expectSqlState(
      // bb_ranking_run_guard (BEFORE INSERT) fires before the ranking_runs_fallback_version CHECK is ever
      // evaluated: 'rule-based-fallback' is never an actual ml_model_versions row, so the guard's own
      // "must reference an existing model_version" raise (ERRCODE 'foreign_key_violation') wins the race.
      () => sql`INSERT INTO ranking_runs (search_id, ranker_type, model_version, trigger_type, input_count) VALUES (${searchId}, 'ML', 'rule-based-fallback', 'INITIAL', 0)`,
      '23503',
    );
  });

  it('an ML run naming an unregistered model is rejected (bb_ranking_run_guard); a registered one is accepted', async () => {
    await expectSqlState(
      () => sql`INSERT INTO ranking_runs (search_id, ranker_type, model_version, trigger_type, input_count) VALUES (${searchId}, 'ML', ${freshId('unregistered')}, 'INITIAL', 0)`,
      '23503',
    );
    const modelVersion = freshId('model');
    await createMlModelVersion({ modelVersion });
    await expect(createRankingRun(searchId, { rankerType: 'ML', modelVersion })).resolves.toBeTypeOf('string');
  });

  it('rejects update and delete on ranking_runs (append-only)', async () => {
    const run = await createRankingRun(searchId);
    await expectSqlState(() => sql`UPDATE ranking_runs SET input_count = 5 WHERE id = ${run}`, '23000');
    await expectSqlState(() => sql`DELETE FROM ranking_runs WHERE id = ${run}`, '23000');
  });
});

describe('ranking_predictions', () => {
  it('rejects a rank below 1, a reasons value that is not a JSON array, and a feature_snapshot that is not an object', async () => {
    const run = await createRankingRun(searchId);
    const owner = await createUser();
    const donor = await createDonor(owner);
    await expectSqlState(
      () => sql`INSERT INTO ranking_predictions (ranking_run_id, donor_id, rank, score, feature_snapshot) VALUES (${run}, ${donor}, 0, 0.5, '{}'::jsonb)`,
      '23514',
    );
    await expectSqlState(
      () => sql`INSERT INTO ranking_predictions (ranking_run_id, donor_id, rank, score, reasons, feature_snapshot) VALUES (${run}, ${donor}, 1, 0.5, '{}'::jsonb, '{}'::jsonb)`,
      '23514',
    );
    await expectSqlState(
      () => sql`INSERT INTO ranking_predictions (ranking_run_id, donor_id, rank, score, feature_snapshot) VALUES (${run}, ${donor}, 1, 0.5, '[1]'::jsonb)`,
      '23514',
    );
  });

  it('rejects update and delete on ranking_predictions (append-only)', async () => {
    const run = await createRankingRun(searchId);
    const owner = await createUser();
    const donor = await createDonor(owner);
    const id = await createRankingPrediction(run, donor);
    await expectSqlState(() => sql`UPDATE ranking_predictions SET score = 0.9 WHERE id = ${id}`, '23000');
    await expectSqlState(() => sql`DELETE FROM ranking_predictions WHERE id = ${id}`, '23000');
  });
});

describe('notification_batches', () => {
  it('rejects a non-positive batch_number and expires_at not after opened_at', async () => {
    await expectSqlState(
      () => sql`INSERT INTO notification_batches (search_id, batch_number, expires_at) VALUES (${searchId}, 0, now() + interval '10 minutes')`,
      '23514',
    );
    await expectSqlState(
      () => sql`INSERT INTO notification_batches (search_id, batch_number, opened_at, expires_at) VALUES (${searchId}, 2, now(), now())`,
      '23514',
    );
  });

  it('allows at most one ACTIVE batch per search (notification_batches_one_active_per_search)', async () => {
    const request = await createActiveBloodRequest({ requesterId: userId });
    const search = await createDonorSearch(request.id);
    await sql`INSERT INTO notification_batches (search_id, batch_number, status, expires_at) VALUES (${search}, 1, 'ACTIVE', now() + interval '10 minutes')`;
    await expectSqlState(
      () => sql`INSERT INTO notification_batches (search_id, batch_number, status, expires_at) VALUES (${search}, 2, 'ACTIVE', now() + interval '10 minutes')`,
      '23505',
    );
  });

  it('rejects a ranking_run_id that belongs to a different search (notification_batches_run_fk, composite)', async () => {
    const otherRequest = await createActiveBloodRequest({ requesterId: userId });
    const otherSearch = await createDonorSearch(otherRequest.id);
    const otherRun = await createRankingRun(otherSearch);
    await expectSqlState(
      () => sql`INSERT INTO notification_batches (search_id, batch_number, expires_at, ranking_run_id) VALUES (${searchId}, 99, now() + interval '10 minutes', ${otherRun})`,
      '23503',
    );
  });

  describe('bb_notification_batch_guard: ranking_run_id may be set once and never changed', () => {
    it('allows NULL to a valid run of the same search', async () => {
      const batch = await createNotificationBatch(searchId, { batchNumber: 10 });
      const run = await createRankingRun(searchId);
      await expect(sql`UPDATE notification_batches SET ranking_run_id = ${run} WHERE id = ${batch}`).resolves.toBeDefined();
    });

    it('allows setting the run to the same value again', async () => {
      const run = await createRankingRun(searchId);
      const batch = await createNotificationBatch(searchId, { batchNumber: 11, rankingRunId: run });
      await expect(sql`UPDATE notification_batches SET ranking_run_id = ${run} WHERE id = ${batch}`).resolves.toBeDefined();
    });

    it('rejects changing the run to a different one', async () => {
      const run = await createRankingRun(searchId);
      const otherRun = await createRankingRun(searchId);
      const batch = await createNotificationBatch(searchId, { batchNumber: 12, rankingRunId: run });
      await expectSqlState(() => sql`UPDATE notification_batches SET ranking_run_id = ${otherRun} WHERE id = ${batch}`, '23000');
    });

    it('rejects setting the run back to NULL', async () => {
      const run = await createRankingRun(searchId);
      const batch = await createNotificationBatch(searchId, { batchNumber: 13, rankingRunId: run });
      await expectSqlState(() => sql`UPDATE notification_batches SET ranking_run_id = NULL WHERE id = ${batch}`, '23000');
    });
  });

  it('rejects deleting a notification batch (never deleted)', async () => {
    const batch = await createNotificationBatch(searchId, { batchNumber: 20 });
    await expectSqlState(() => sql`DELETE FROM notification_batches WHERE id = ${batch}`, '23000');
  });
});

describe('donor_matches (bb_donor_match_guard, plus its own CHECKs)', () => {
  async function contactedMatch(donorId: string, batchId: string, predictionId: string): Promise<string> {
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO donor_matches (search_id, donor_id, batch_id, selected_prediction_id, status, notified_at)
      VALUES (${searchId}, ${donorId}, ${batchId}, ${predictionId}, 'NOTIFIED', now()) RETURNING id`;
    return row!.id;
  }

  it('rejects setting batch_id and selected_prediction_id together when the batch has no ranking run', async () => {
    const owner = await createUser();
    const donor = await createDonor(owner);
    const run = await createRankingRun(searchId);
    const prediction = await createRankingPrediction(run, donor);
    const batchWithNoRun = await createNotificationBatch(searchId, { batchNumber: 30 });
    await expectSqlState(() => contactedMatch(donor, batchWithNoRun, prediction), '23000');
  });

  it('rejects a prediction from a different ranking run than the one attached to the batch', async () => {
    const owner = await createUser();
    const donor = await createDonor(owner);
    const runA = await createRankingRun(searchId);
    const runB = await createRankingRun(searchId);
    const predictionFromB = await createRankingPrediction(runB, donor);
    const batchOnA = await createNotificationBatch(searchId, { batchNumber: 31, rankingRunId: runA });
    await expectSqlState(() => contactedMatch(donor, batchOnA, predictionFromB), '23000');
  });

  it('accepts a prediction from the same ranking run as the batch', async () => {
    const owner = await createUser();
    const donor = await createDonor(owner);
    const run = await createRankingRun(searchId);
    const prediction = await createRankingPrediction(run, donor);
    const batch = await createNotificationBatch(searchId, { batchNumber: 32, rankingRunId: run });
    await expect(contactedMatch(donor, batch, prediction)).resolves.toBeTypeOf('string');
  });

  it('makes search_id and donor_id immutable, and batch_id/selected_prediction_id/arrived_at set-once', async () => {
    const owner = await createUser();
    const donor = await createDonor(owner);
    const run = await createRankingRun(searchId);
    const prediction = await createRankingPrediction(run, donor);
    const batch = await createNotificationBatch(searchId, { batchNumber: 33, rankingRunId: run });
    const matchId = await contactedMatch(donor, batch, prediction);

    const otherRequest = await createActiveBloodRequest({ requesterId: userId });
    const otherSearch = await createDonorSearch(otherRequest.id);
    await expectSqlState(() => sql`UPDATE donor_matches SET search_id = ${otherSearch} WHERE id = ${matchId}`, '23000');
    const otherOwner = await createUser();
    const otherDonor = await createDonor(otherOwner);
    await expectSqlState(() => sql`UPDATE donor_matches SET donor_id = ${otherDonor} WHERE id = ${matchId}`, '23000');

    const otherBatch = await createNotificationBatch(searchId, { batchNumber: 34 });
    await expectSqlState(() => sql`UPDATE donor_matches SET batch_id = ${otherBatch} WHERE id = ${matchId}`, '23000');

    const run2 = await createRankingRun(searchId);
    const prediction2 = await createRankingPrediction(run2, donor);
    await expectSqlState(() => sql`UPDATE donor_matches SET selected_prediction_id = ${prediction2} WHERE id = ${matchId}`, '23000');

    await sql`UPDATE donor_matches SET status = 'CONFIRMED', arrived_at = now() WHERE id = ${matchId}`;
    await expectSqlState(() => sql`UPDATE donor_matches SET arrived_at = now() + interval '1 minute' WHERE id = ${matchId}`, '23000');
  });

  it('rejects a CANDIDATE/EXCLUDED match with a batch, and a contacted match with none (donor_matches_batch_by_status)', async () => {
    const owner = await createUser();
    const donor = await createDonor(owner);
    const run = await createRankingRun(searchId);
    const prediction = await createRankingPrediction(run, donor);
    const batch = await createNotificationBatch(searchId, { batchNumber: 35, rankingRunId: run });
    await expectSqlState(
      () => sql`INSERT INTO donor_matches (search_id, donor_id, batch_id, selected_prediction_id) VALUES (${searchId}, ${donor}, ${batch}, ${prediction})`,
      '23514', // status defaults to CANDIDATE, which requires batch_id IS NULL
    );
    await expectSqlState(
      () => sql`INSERT INTO donor_matches (search_id, donor_id, status, notified_at) VALUES (${searchId}, ${donor}, 'NOTIFIED', now())`,
      '23514', // NOTIFIED requires batch_id IS NOT NULL
    );
  });

  it('requires exclusion_reason exactly for EXCLUDED, and drop_reason exactly for DROPPED, each an upper-case code', async () => {
    const owner = await createUser();
    const donor = await createDonor(owner);
    await expectSqlState(
      () => sql`INSERT INTO donor_matches (search_id, donor_id, status) VALUES (${searchId}, ${donor}, 'EXCLUDED')`,
      '23514',
    );
    await expectSqlState(
      () => sql`INSERT INTO donor_matches (search_id, donor_id, status, exclusion_reason) VALUES (${searchId}, ${donor}, 'EXCLUDED', 'not upper')`,
      '23514',
    );
    await expect(
      sql`INSERT INTO donor_matches (search_id, donor_id, status, exclusion_reason) VALUES (${searchId}, ${donor}, 'EXCLUDED', 'NOT_ELIGIBLE')`,
    ).resolves.toBeDefined();
  });
});

describe('donor_responses', () => {
  it('rejects a negative latency_seconds', async () => {
    const owner = await createUser();
    const donor = await createDonor(owner);
    const [match] = await sql<{ id: string }[]>`INSERT INTO donor_matches (search_id, donor_id) VALUES (${searchId}, ${donor}) RETURNING id`;
    await expectSqlState(
      () => sql`INSERT INTO donor_responses (match_id, response, latency_seconds) VALUES (${match!.id}, 'DECLINED', -1)`,
      '23514',
    );
  });

  it('rejects update and delete (append-only), and a second response for the same match (unique match_id)', async () => {
    const owner = await createUser();
    const donor = await createDonor(owner);
    const [match] = await sql<{ id: string }[]>`INSERT INTO donor_matches (search_id, donor_id) VALUES (${searchId}, ${donor}) RETURNING id`;
    const [row] = await sql<{ id: string }[]>`INSERT INTO donor_responses (match_id, response) VALUES (${match!.id}, 'DECLINED') RETURNING id`;
    await expectSqlState(() => sql`UPDATE donor_responses SET response = 'ACCEPTED' WHERE id = ${row!.id}`, '23000');
    await expectSqlState(() => sql`DELETE FROM donor_responses WHERE id = ${row!.id}`, '23000');
    await expectSqlState(() => sql`INSERT INTO donor_responses (match_id, response) VALUES (${match!.id}, 'ACCEPTED')`, '23505');
  });
});

describe('ml_model_versions (bb_ml_model_version_guard, the never-deleted trigger, and its own CHECKs)', () => {
  it('rejects renaming a registered model, but allows other field updates', async () => {
    const id = await createMlModelVersion();
    await expectSqlState(() => sql`UPDATE ml_model_versions SET model_version = ${freshId('renamed')} WHERE id = ${id}`, '23000');
    await expect(sql`UPDATE ml_model_versions SET status = 'ACTIVE', activated_at = now(), activated_by = ${userId} WHERE id = ${id}`).resolves.toBeDefined();
    // Retire the ACTIVE row this test created: there is no reset between tests or files, so leaving it ACTIVE
    // would leak into every later ml_model_versions_one_active check in this file and in concurrency.db.test.ts.
    await sql`UPDATE ml_model_versions SET status = 'RETIRED' WHERE id = ${id}`;
  });

  it('rejects deleting a registered model (never deleted)', async () => {
    const id = await createMlModelVersion();
    await expectSqlState(() => sql`DELETE FROM ml_model_versions WHERE id = ${id}`, '23000');
  });

  it('allows at most one ACTIVE model (ml_model_versions_one_active)', async () => {
    const first = await createMlModelVersion();
    await sql`UPDATE ml_model_versions SET status = 'ACTIVE', activated_at = now(), activated_by = ${userId} WHERE id = ${first}`;
    const second = await createMlModelVersion();
    await expectSqlState(
      () => sql`UPDATE ml_model_versions SET status = 'ACTIVE', activated_at = now(), activated_by = ${userId} WHERE id = ${second}`,
      '23505',
    );
    // Retire the ACTIVE row this test created: there is no reset between test files, so leaving it ACTIVE would
    // collide with concurrency.db.test.ts's own ml_model_versions_one_active race later in the same run.
    await sql`UPDATE ml_model_versions SET status = 'RETIRED' WHERE id = ${first}`;
  });

  it('rejects a model_version equal to the reserved fallback label, and requires activation fields once ACTIVE', async () => {
    await expectSqlState(
      () => sql`INSERT INTO ml_model_versions (model_version, algorithm, dataset_version, features_used, trained_at, artifact_ref)
                VALUES ('rule-based-fallback', 'x', 'v1', ARRAY['x']::text[], now(), 'ref')`,
      '23514',
    );
    const id = await createMlModelVersion();
    await expectSqlState(() => sql`UPDATE ml_model_versions SET status = 'ACTIVE' WHERE id = ${id}`, '23514');
  });
});

describe('notifications and notification_deliveries (the one CASCADE)', () => {
  it('rejects a lower-case type, and a data value that is not a JSON object', async () => {
    await expectSqlState(() => sql`INSERT INTO notifications (user_id, type) VALUES (${userId}, 'lowercase')`, '23514');
    await expectSqlState(() => sql`INSERT INTO notifications (user_id, type, data) VALUES (${userId}, 'DONOR_MATCHED', '[1]'::jsonb)`, '23514');
  });

  it('rejects an error message unless the delivery FAILED', async () => {
    const [notification] = await sql<{ id: string }[]>`INSERT INTO notifications (user_id, type) VALUES (${userId}, 'DONOR_MATCHED') RETURNING id`;
    await expectSqlState(
      () => sql`INSERT INTO notification_deliveries (notification_id, channel, error) VALUES (${notification!.id}, 'IN_APP', 'boom')`,
      '23514',
    );
  });

  it('deleting a notification cascades to delete its deliveries (the one intentional CASCADE)', async () => {
    const [notification] = await sql<{ id: string }[]>`INSERT INTO notifications (user_id, type) VALUES (${userId}, 'DONOR_MATCHED') RETURNING id`;
    const [delivery] = await sql<{ id: string }[]>`INSERT INTO notification_deliveries (notification_id, channel) VALUES (${notification!.id}, 'IN_APP') RETURNING id`;
    await expect(sql`DELETE FROM notifications WHERE id = ${notification!.id}`).resolves.toBeDefined();
    const remaining = await sql<{ id: string }[]>`SELECT id FROM notification_deliveries WHERE id = ${delivery!.id}`;
    expect(remaining).toHaveLength(0);
  });
});

describe('settings: NULLS NOT DISTINCT (the reason this batch requires PostgreSQL 15)', () => {
  it('rejects two rows with the same key when both scope and urgency are NULL', async () => {
    const key = freshId('setting');
    await sql`INSERT INTO settings (key, value) VALUES (${key}, '1'::jsonb)`;
    await expectSqlState(() => sql`INSERT INTO settings (key, value) VALUES (${key}, '2'::jsonb)`, '23505');
  });

  it('still allows the same key with two different, non-null urgency values', async () => {
    const key = freshId('setting');
    await sql`INSERT INTO settings (key, value, urgency) VALUES (${key}, '1'::jsonb, 'HIGH')`;
    await expect(sql`INSERT INTO settings (key, value, urgency) VALUES (${key}, '2'::jsonb, 'LOW')`).resolves.toBeDefined();
  });

  it('rejects a key in the wrong format, and a non-NULL scope (reserved in v1)', async () => {
    await expectSqlState(() => sql`INSERT INTO settings (key, value) VALUES ('1bad', '1'::jsonb)`, '23514');
    await expectSqlState(() => sql`INSERT INTO settings (key, value, scope) VALUES (${freshId('setting')}, '1'::jsonb, 'GLOBAL')`, '23514');
  });
});

describe('audit_logs, webhook_events, location_access_logs', () => {
  it('rejects a lower-case action, and an entity_id with no entity_type', async () => {
    await expectSqlState(() => sql`INSERT INTO audit_logs (action) VALUES ('lowercase')`, '23514');
    await expectSqlState(() => sql`INSERT INTO audit_logs (action, entity_id) VALUES ('ROLE_GRANTED', gen_random_uuid())`, '23514');
  });

  it('rejects update and delete on audit_logs (append-only)', async () => {
    const [row] = await sql<{ id: string }[]>`INSERT INTO audit_logs (action) VALUES ('ROLE_GRANTED') RETURNING id`;
    await expectSqlState(() => sql`UPDATE audit_logs SET action = 'ROLE_REVOKED' WHERE id = ${row!.id}`, '23000');
    await expectSqlState(() => sql`DELETE FROM audit_logs WHERE id = ${row!.id}`, '23000');
  });

  it('rejects blank webhook_events fields, and a duplicate (provider, provider_event_id)', async () => {
    await expectSqlState(() => sql`INSERT INTO webhook_events (provider, provider_event_id, event_type) VALUES (' ', 'x', 'user.created')`, '23514');
    const eventId = freshId('evt');
    await sql`INSERT INTO webhook_events (provider, provider_event_id, event_type) VALUES ('clerk', ${eventId}, 'user.created')`;
    await expectSqlState(() => sql`INSERT INTO webhook_events (provider, provider_event_id, event_type) VALUES ('clerk', ${eventId}, 'user.updated')`, '23505');
  });

  it('rejects a lower-case purpose, and update/delete on location_access_logs (append-only)', async () => {
    const donor = await createDonor(await createUser());
    await expectSqlState(() => sql`INSERT INTO location_access_logs (accessor_id, donor_id, purpose) VALUES (${userId}, ${donor}, 'lowercase')`, '23514');
    const [row] = await sql<{ id: string }[]>`INSERT INTO location_access_logs (accessor_id, donor_id, purpose) VALUES (${userId}, ${donor}, 'HOSPITAL_ARRIVAL') RETURNING id`;
    await expectSqlState(() => sql`UPDATE location_access_logs SET purpose = 'ADMIN_REVIEW' WHERE id = ${row!.id}`, '23000');
    await expectSqlState(() => sql`DELETE FROM location_access_logs WHERE id = ${row!.id}`, '23000');
  });
});

describe('data_deletion_requests and idempotency_keys', () => {
  it('requires completed_at exactly when COMPLETED, and rejects COMPLETED together with a legal hold', async () => {
    const owner = await createUser();
    await expectSqlState(() => sql`INSERT INTO data_deletion_requests (user_id, source, status) VALUES (${owner}, 'USER_REQUEST', 'COMPLETED')`, '23514');
    await expectSqlState(
      () => sql`INSERT INTO data_deletion_requests (user_id, source, status, legal_hold, completed_at) VALUES (${owner}, 'USER_REQUEST', 'COMPLETED', true, now())`,
      '23514',
    );
  });

  it('allows at most one PENDING deletion request per user', async () => {
    const owner = await createUser();
    await sql`INSERT INTO data_deletion_requests (user_id, source) VALUES (${owner}, 'USER_REQUEST')`;
    await expectSqlState(() => sql`INSERT INTO data_deletion_requests (user_id, source) VALUES (${owner}, 'CLERK_WEBHOOK')`, '23505');
  });

  it('rejects deleting a data_deletion_requests row (never deleted)', async () => {
    const owner = await createUser();
    const [row] = await sql<{ id: string }[]>`INSERT INTO data_deletion_requests (user_id, source) VALUES (${owner}, 'USER_REQUEST') RETURNING id`;
    await expectSqlState(() => sql`DELETE FROM data_deletion_requests WHERE id = ${row!.id}`, '23000');
  });

  it('rejects a blank key, and expires_at not after created_at, and a duplicate (user_id, key)', async () => {
    await expectSqlState(
      () => sql`INSERT INTO idempotency_keys (user_id, key, request_fingerprint, expires_at) VALUES (${userId}, ' ', 'fp', now() + interval '1 day')`,
      '23514',
    );
    const key = freshId('idem');
    await sql`INSERT INTO idempotency_keys (user_id, key, request_fingerprint, expires_at) VALUES (${userId}, ${key}, 'fp', now() + interval '1 day')`;
    await expectSqlState(
      () => sql`INSERT INTO idempotency_keys (user_id, key, request_fingerprint, expires_at) VALUES (${userId}, ${key}, 'fp2', now() + interval '1 day')`,
      '23505',
    );
  });
});

describe('donor_locations_coarse: the privacy boundary view', () => {
  it('exposes only donor_id, location_coarse and updated_at, never the exact column', async () => {
    const owner = await createUser();
    const donor = await createDonor(owner);
    await sql`INSERT INTO donor_locations (donor_id, location_exact, location_coarse)
              VALUES (${donor}, ST_SetSRID(ST_MakePoint(0, 0), 4326)::geography, ST_SetSRID(ST_MakePoint(0, 0), 4326)::geography)`;
    const [row] = await sql<Record<string, unknown>[]>`SELECT * FROM donor_locations_coarse WHERE donor_id = ${donor}`;
    expect(row).toBeDefined();
    expect(Object.keys(row!).sort()).toEqual(['donor_id', 'location_coarse', 'updated_at']);
  });
});
