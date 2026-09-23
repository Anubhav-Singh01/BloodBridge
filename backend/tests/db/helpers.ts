import { randomUUID } from 'node:crypto';
import dotenv from 'dotenv';
import postgres from 'postgres';
import { GuardError, resolveConfirmedTestTarget } from '../../src/db/guard.js';

dotenv.config({ quiet: true });

// Shared connection and fixtures for every tests/db file. Importing this module resolves and confirms the test
// target immediately (fail closed): any tests/db file that imports it gets the same guarantee without repeating
// the guard itself. This module is never imported from tests/unit.

function connectionOptionsFrom(databaseUrl: string) {
  const url = new URL(databaseUrl);
  return {
    host: url.hostname,
    port: url.port ? Number(url.port) : 5432,
    database: decodeURIComponent(url.pathname.replace(/^\//, '')),
    username: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
  };
}

export const testTarget = resolveConfirmedTestTarget(process.env);
if (/-pooler(?=\.)/.test(testTarget.host)) {
  throw new GuardError('TEST_DATABASE_URL must be the direct (non-pooled) endpoint (Batch 3.7, D3).');
}
export const endpointLabel = testTarget.host.split('.')[0] ?? '';

export const sql = postgres({
  ...connectionOptionsFrom(process.env.TEST_DATABASE_URL as string),
  max: 5,
  idle_timeout: 20,
  // Neon's pooled endpoint is not used here at all (D3), but prepare:false and explicit certificate verification
  // match the same reasoning used everywhere else this session (scripts/db-probe-queries.ts).
  prepare: false,
  ssl: { rejectUnauthorized: true },
  connection: { application_name: 'bloodbridge-db-test' },
});

export async function closeTestPool(): Promise<void> {
  await sql.end({ timeout: 5 });
}

/**
 * A short, unique string for columns that need one (clerk_user_id, unit_uid, model_version, ...). Hyphens are
 * stripped from the UUID: some columns that use this (settings.key, via settings_key_format) allow only
 * letters, digits, underscore and dot, and a hyphen-free id is still unique and valid everywhere else.
 */
export function freshId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '')}`;
}

/** Reserves two dedicated connections from the pool for tests that race two real sessions against each other. */
export async function withTwoConnections<T>(work: (a: postgres.ReservedSql, b: postgres.ReservedSql) => Promise<T>): Promise<T> {
  const a = await sql.reserve();
  const b = await sql.reserve();
  try {
    return await work(a, b);
  } finally {
    a.release();
    b.release();
  }
}

/** Asserts that `fn()` rejects with a Postgres error carrying exactly `sqlstate` (D11: exact SQLSTATE, not "any error"). */
export async function expectSqlState(fn: () => Promise<unknown>, sqlstate: string): Promise<void> {
  try {
    await fn();
  } catch (error) {
    const code = (error as { code?: unknown } | undefined)?.code;
    if (code === sqlstate) return;
    throw new Error(`expected SQLSTATE ${sqlstate}, got ${String(code)}: ${error instanceof Error ? error.message : String(error)}`);
  }
  throw new Error(`expected SQLSTATE ${sqlstate}, but the statement succeeded`);
}

/** A PostGIS geography point built from plain lng/lat, as a raw SQL fragment for use inside a tagged template. */
export function point(lng: number, lat: number) {
  return sql`ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography`;
}

// ---------------------------------------------------------------------------------------------------------------------
// Fixtures. Each inserts the minimal valid row for its table (every NOT NULL column, every CHECK satisfied) and
// returns the new row's id (or the relevant key), so tests can build up only the FK chain they actually need.

export async function createUser(overrides: { clerkUserId?: string } = {}): Promise<string> {
  const clerkUserId = overrides.clerkUserId ?? freshId('clerk');
  const [row] = await sql<{ id: string }[]>`INSERT INTO users (clerk_user_id) VALUES (${clerkUserId}) RETURNING id`;
  return row!.id;
}

export async function createDonor(userId: string, overrides: { bloodGroup?: string } = {}): Promise<string> {
  const bloodGroup = overrides.bloodGroup ?? 'O_POS';
  const [row] = await sql<{ id: string }[]>`INSERT INTO donors (user_id, blood_group) VALUES (${userId}, ${bloodGroup}) RETURNING id`;
  return row!.id;
}

export interface FacilityRow {
  id: string;
  facilityType: 'HOSPITAL' | 'BLOOD_BANK';
}

export async function createFacility(facilityType: 'HOSPITAL' | 'BLOOD_BANK', createdBy: string, overrides: { name?: string } = {}): Promise<FacilityRow> {
  const name = overrides.name ?? freshId('facility');
  const [row] = await sql<{ id: string }[]>`INSERT INTO facilities (facility_type, name, created_by) VALUES (${facilityType}, ${name}, ${createdBy}) RETURNING id`;
  return { id: row!.id, facilityType };
}

/** Creates a facility of type HOSPITAL and its hospitals row. Returns the facility id, which is hospitals.facility_id. */
export async function createHospital(createdBy: string): Promise<string> {
  const facility = await createFacility('HOSPITAL', createdBy);
  await sql`INSERT INTO hospitals (facility_id) VALUES (${facility.id})`;
  return facility.id;
}

/** Creates a facility of type BLOOD_BANK and its blood_banks row. Returns the facility id. */
export async function createBloodBank(createdBy: string): Promise<string> {
  const facility = await createFacility('BLOOD_BANK', createdBy);
  await sql`INSERT INTO blood_banks (facility_id) VALUES (${facility.id})`;
  return facility.id;
}

export async function createPatient(createdBy: string): Promise<string> {
  const [row] = await sql<{ id: string }[]>`INSERT INTO patients (age_band, created_by) VALUES ('ADULT', ${createdBy}) RETURNING id`;
  return row!.id;
}

/** Marks a facility VERIFIED + ACTIVE with a location, so it satisfies facilities_verified_has_location. */
export async function verifyFacility(facilityId: string): Promise<void> {
  await sql`UPDATE facilities SET verification_status = 'VERIFIED', status = 'ACTIVE', location = ${point(77.5946, 12.9716)} WHERE id = ${facilityId}`;
}

/** An ACTIVE facility membership (joined_at set, per facility_memberships_joined_consistent). */
export async function addActiveMembership(userId: string, facilityId: string, role: 'FACILITY_ADMIN' | 'STAFF' = 'STAFF'): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO facility_memberships (user_id, facility_id, role, status, joined_at)
    VALUES (${userId}, ${facilityId}, ${role}, 'ACTIVE', now()) RETURNING id`;
  return row!.id;
}

export interface BloodRequestFixture {
  id: string;
  requesterId: string;
  hospitalId: string;
}

/** Creates a full, valid DRAFT blood request (the only status the state-machine trigger allows on INSERT). */
export async function createDraftBloodRequest(overrides: { requesterId?: string; hospitalId?: string } = {}): Promise<BloodRequestFixture> {
  const requesterId = overrides.requesterId ?? (await createUser());
  const patientId = await createPatient(requesterId);
  const hospitalId = overrides.hospitalId ?? (await createHospital(requesterId));
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO blood_requests (
      requester_id, patient_id, hospital_id, blood_group, component, units_required, required_donors,
      required_by, location, expires_at
    ) VALUES (
      ${requesterId}, ${patientId}, ${hospitalId}, 'O_POS', 'WHOLE_BLOOD', 1, 1,
      now() + interval '6 hours', ${point(77.5946, 12.9716)}, now() + interval '24 hours'
    ) RETURNING id`;
  return { id: row!.id, requesterId, hospitalId };
}

/** Applies a sequence of status updates, one at a time, exactly as the state-machine trigger requires. */
export async function walkRequestTo(requestId: string, path: readonly string[]): Promise<void> {
  for (const status of path) {
    await sql`UPDATE blood_requests SET status = ${status} WHERE id = ${requestId}`;
  }
}

/** Walks a fresh DRAFT request all the way to ACTIVE via the documented emergency fast path (DRAFT -> SUBMITTED -> ACTIVE). */
export async function createActiveBloodRequest(overrides: { requesterId?: string; hospitalId?: string } = {}): Promise<BloodRequestFixture> {
  const request = await createDraftBloodRequest(overrides);
  await walkRequestTo(request.id, ['SUBMITTED', 'ACTIVE']);
  return request;
}

export async function createDonorSearch(requestId: string, overrides: { requiredDonors?: number } = {}): Promise<string> {
  const requiredDonors = overrides.requiredDonors ?? 1;
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO donor_searches (request_id, config_snapshot, required_donors) VALUES (${requestId}, '{}'::jsonb, ${requiredDonors}) RETURNING id`;
  return row!.id;
}

export async function createRankingRun(
  searchId: string,
  overrides: { rankerType?: 'ML' | 'FALLBACK'; modelVersion?: string } = {},
): Promise<string> {
  const rankerType = overrides.rankerType ?? 'FALLBACK';
  const modelVersion = overrides.modelVersion ?? (rankerType === 'FALLBACK' ? 'rule-based-fallback' : freshId('model'));
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO ranking_runs (search_id, ranker_type, model_version, trigger_type, input_count)
    VALUES (${searchId}, ${rankerType}, ${modelVersion}, 'INITIAL', 0) RETURNING id`;
  return row!.id;
}

export async function createRankingPrediction(rankingRunId: string, donorId: string, overrides: { rank?: number } = {}): Promise<string> {
  const rank = overrides.rank ?? 1;
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO ranking_predictions (ranking_run_id, donor_id, rank, score, feature_snapshot)
    VALUES (${rankingRunId}, ${donorId}, ${rank}, 0.5, '{}'::jsonb) RETURNING id`;
  return row!.id;
}

export async function createNotificationBatch(
  searchId: string,
  overrides: { batchNumber?: number; rankingRunId?: string | null } = {},
): Promise<string> {
  const batchNumber = overrides.batchNumber ?? 1;
  const rankingRunId = overrides.rankingRunId ?? null;
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO notification_batches (search_id, batch_number, expires_at, ranking_run_id)
    VALUES (${searchId}, ${batchNumber}, now() + interval '10 minutes', ${rankingRunId}) RETURNING id`;
  return row!.id;
}

export async function createMlModelVersion(overrides: { modelVersion?: string; status?: 'CANDIDATE' | 'ACTIVE' | 'RETIRED' } = {}): Promise<string> {
  const modelVersion = overrides.modelVersion ?? freshId('model');
  const status = overrides.status ?? 'CANDIDATE';
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO ml_model_versions (model_version, algorithm, dataset_version, features_used, trained_at, artifact_ref, status)
    VALUES (${modelVersion}, 'logistic-regression', 'v1', ARRAY['distance_km']::text[], now(), 'models/v1/model.joblib', ${status})
    RETURNING id`;
  return row!.id;
}

export async function createDonationIntervalRule(
  enteredBy: string,
  overrides: { scope?: 'OFFICIAL' | 'FACILITY'; facilityId?: string | null; effectiveFrom?: string; effectiveTo?: string | null } = {},
): Promise<string> {
  const scope = overrides.scope ?? 'OFFICIAL';
  const facilityId = overrides.facilityId ?? null;
  const effectiveFrom = overrides.effectiveFrom ?? '2020-01-01';
  const effectiveTo = overrides.effectiveTo ?? null;
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO donation_interval_rules (donation_type, min_interval_days, effective_from, effective_to, scope, facility_id, source_note, entered_by)
    VALUES ('WHOLE_BLOOD', 90, ${effectiveFrom}, ${effectiveTo}, ${scope}, ${facilityId}, 'test fixture', ${enteredBy})
    RETURNING id`;
  return row!.id;
}

export async function createEligibilityRule(
  enteredBy: string,
  overrides: { ruleKey?: 'MIN_AGE' | 'MAX_AGE'; effectiveFrom?: string; effectiveTo?: string | null } = {},
): Promise<string> {
  const ruleKey = overrides.ruleKey ?? 'MIN_AGE';
  const effectiveFrom = overrides.effectiveFrom ?? '2020-01-01';
  const effectiveTo = overrides.effectiveTo ?? null;
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO eligibility_rules (rule_key, value_int, effective_from, effective_to, source_note, entered_by)
    VALUES (${ruleKey}, 18, ${effectiveFrom}, ${effectiveTo}, 'test fixture', ${enteredBy})
    RETURNING id`;
  return row!.id;
}

export interface BloodUnitFixture {
  id: string;
  facilityId: string;
}

export async function createBloodUnit(
  createdBy: string,
  overrides: { facilityId?: string; status?: string; collectedAt?: Date; expiresAt?: Date } = {},
): Promise<BloodUnitFixture> {
  const facilityId = overrides.facilityId ?? (await createBloodBank(createdBy));
  const collectedAt = overrides.collectedAt ?? new Date(Date.now() - 24 * 60 * 60 * 1000);
  const expiresAt = overrides.expiresAt ?? new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO blood_units (unit_uid, facility_unit_code, facility_id, origin_facility_id, blood_group, component, collected_at, expires_at, status)
    VALUES (${freshId('unit')}, ${freshId('code')}, ${facilityId}, ${facilityId}, 'O_POS', 'WHOLE_BLOOD', ${collectedAt}, ${expiresAt}, ${overrides.status ?? 'AVAILABLE'})
    RETURNING id`;
  return { id: row!.id, facilityId };
}
