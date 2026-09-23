import dotenv from 'dotenv';
import postgres from 'postgres';
import { resolveConfirmedTarget, type GuardEnv } from '../src/db/guard.js';
import { connectionOptions } from './db-probe-queries.js';
import { planPresence, planSettings } from './db-seed-plan.js';
import { REFERENCE_ROLE_CODES, REFERENCE_SETTINGS } from '../src/db/seed/reference-data.js';
import {
  DEMO_BLOOD_UNITS,
  DEMO_DONATION_HISTORY,
  DEMO_DONORS,
  DEMO_FACILITIES,
  DEMO_MEMBERSHIPS,
  DEMO_PATIENTS,
  DEMO_USERS,
} from '../src/db/seed/demo-data.js';

dotenv.config({ quiet: true });

// Batch 3.8: the guarded reference/demo seed.
//
// Default (no flags) is a dry run: it only ever SELECTs, prints what would happen, and writes nothing.
// --apply writes the reference data (roles, settings) inside one transaction.
// --demo (only meaningful together with --apply) additionally writes the synthetic demo dataset in a second
// transaction; without --apply it is still shown in the plan, just not written.
//
// Settings behavior (the one approved modification to the original Batch 3.8 proposal): a settings row already
// present with a value that differs from DATABASE.md section 11's table is never overwritten. It is reported as
// a mismatch, and in that case NOTHING is written at all - not even the rows that were fine - until the
// mismatch is resolved by hand and the script is re-run. See scripts/db-seed-plan.ts for the pure logic this
// script only calls, prints, and gates on.
//
// This never touches compatibility_rules, donation_interval_rules or eligibility_rules: there is no code path
// here that writes to any of the three, by design (DATABASE.md section 11).

const argv = process.argv.slice(2);
const KNOWN_FLAGS = new Set(['--apply', '--demo']);
for (const arg of argv) {
  if (!KNOWN_FLAGS.has(arg)) {
    console.error(`db-seed: unrecognised argument "${arg}". Only --apply and --demo are supported.`);
    process.exit(1);
  }
}
const apply = argv.includes('--apply');
const demo = argv.includes('--demo');

// resolveConfirmedTarget (src/db/guard.ts) is the same dev-target guard scripts/db-migrate.ts uses: it requires
// DATABASE_URL_DIRECT (or DATABASE_URL) plus CONFIRM_DB_HOST matching that host, and it refuses outright when
// NODE_ENV=production. It never reads TEST_DATABASE_URL, so this script has no code path to the test branch.
const target = resolveConfirmedTarget(process.env as GuardEnv, 'seed');
console.log(`db-seed: target ${target.host}/${target.database}${apply ? ' --apply' : ' (plan only)'}${demo ? ' --demo' : ''}`);

const url = process.env.DATABASE_URL_DIRECT || process.env.DATABASE_URL;
if (!url) {
  // resolveConfirmedTarget already throws before this point if neither is set; this narrows the type for below.
  throw new Error('db-seed: DATABASE_URL_DIRECT or DATABASE_URL must be set.');
}
const sql = postgres({
  ...connectionOptions(url),
  // Override the probe's fetch_types: false. sql.array() (used for the = ANY(${...}) queries below) resolves
  // its parameter's array type OID from postgres.js's own type-introspection round trip; without it, the
  // lookup is empty and the parameter falls back to a scalar type, which Postgres then refuses as the
  // right-hand side of ANY(...). The probe itself has no array parameters, so it never needed this.
  fetch_types: true,
  connection: { application_name: 'bloodbridge-db-seed' },
});

try {
  // Re-check identity live: the connection string was confirmed offline, this confirms what the server actually
  // is, the same gap tests/db/reset.ts closes before its own (much more destructive) TRUNCATE.
  const [identity] = await sql<{ database: string; in_recovery: boolean }[]>`SELECT current_database() AS database, pg_is_in_recovery() AS in_recovery`;
  if (!identity || identity.database !== target.database) {
    throw new Error(`db-seed: refusing - connected to "${identity?.database}", expected "${target.database}".`);
  }
  if (identity.in_recovery) {
    throw new Error('db-seed: refusing - the server is in recovery (a replica).');
  }

  // --- Reference data plan (roles, settings) ---
  const existingRoleRows = await sql<{ code: string }[]>`SELECT code FROM roles`;
  const rolesPlan = planPresence(new Set(existingRoleRows.map((r) => r.code)), REFERENCE_ROLE_CODES);

  const existingSettingRows = await sql<{ key: string; value: unknown }[]>`
    SELECT key, value FROM settings WHERE scope IS NULL AND urgency IS NULL AND key = ANY(${sql.array(REFERENCE_SETTINGS.map((r) => r.key))})`;
  const settingsPlan = planSettings(
    new Map(existingSettingRows.map((r) => [r.key, r.value] as const)),
    REFERENCE_SETTINGS,
  );

  console.log(`db-seed: roles - ${rolesPlan.toInsert.length} to insert, ${rolesPlan.alreadyPresent.length} already present`);
  for (const action of settingsPlan.actions) {
    if (action.kind === 'insert') console.log(`db-seed:   settings ${action.key}: INSERT ${JSON.stringify(action.value)}`);
    else if (action.kind === 'noop') console.log(`db-seed:   settings ${action.key}: already ${JSON.stringify(action.value)} (no change)`);
    else {
      console.error(
        `db-seed:   settings ${action.key}: MISMATCH - database has ${JSON.stringify(action.existingValue)}, DATABASE.md section 11 says ${JSON.stringify(action.expectedValue)}`,
      );
    }
  }

  // --- Demo data plan (only computed when --demo is passed; still just a plan unless --apply is also passed) ---
  const demoPlans: { table: string; plan: ReturnType<typeof planPresence> }[] = [];
  if (demo) {
    // PostgreSQL OID 2950 is uuid. facilities.id, facility_memberships.facility_id, patients.id, donors.user_id
    // and donation_history.id are all uuid columns, so sql.array() must be told that explicitly - left to its
    // own default it types a plain JS string array as text, and "uuid = ANY(text[])" has no operator. users.
    // clerk_user_id and blood_units.unit_uid are genuinely text columns and must NOT be given this type.
    const [users, facilities, memberships, patients, donors, bloodUnits, donationHistory] = await Promise.all([
      sql<{ clerk_user_id: string }[]>`SELECT clerk_user_id FROM users WHERE clerk_user_id = ANY(${sql.array(DEMO_USERS.map((u) => u.clerkUserId))})`,
      sql<{ id: string }[]>`SELECT id FROM facilities WHERE id = ANY(${sql.array(DEMO_FACILITIES.map((f) => f.id), 2950)})`,
      sql<{ user_id: string; facility_id: string }[]>`
        SELECT user_id, facility_id FROM facility_memberships WHERE facility_id = ANY(${sql.array(DEMO_MEMBERSHIPS.map((m) => m.facilityId), 2950)})`,
      sql<{ id: string }[]>`SELECT id FROM patients WHERE id = ANY(${sql.array(DEMO_PATIENTS.map((p) => p.id), 2950)})`,
      sql<{ user_id: string }[]>`SELECT user_id FROM donors WHERE user_id = ANY(${sql.array(DEMO_DONORS.map((d) => d.userId), 2950)})`,
      sql<{ unit_uid: string }[]>`SELECT unit_uid FROM blood_units WHERE unit_uid = ANY(${sql.array(DEMO_BLOOD_UNITS.map((u) => u.unitUid))})`,
      sql<{ id: string }[]>`SELECT id FROM donation_history WHERE id = ANY(${sql.array(DEMO_DONATION_HISTORY.map((h) => h.id), 2950)})`,
    ]);
    const membershipKeys = new Set(memberships.map((m) => `${m.user_id}:${m.facility_id}`));
    demoPlans.push(
      { table: 'users', plan: planPresence(new Set(users.map((u) => u.clerk_user_id)), DEMO_USERS.map((u) => u.clerkUserId)) },
      { table: 'facilities', plan: planPresence(new Set(facilities.map((f) => f.id)), DEMO_FACILITIES.map((f) => f.id)) },
      { table: 'facility_memberships', plan: planPresence(membershipKeys, DEMO_MEMBERSHIPS.map((m) => `${m.userId}:${m.facilityId}`)) },
      { table: 'patients', plan: planPresence(new Set(patients.map((p) => p.id)), DEMO_PATIENTS.map((p) => p.id)) },
      { table: 'donors', plan: planPresence(new Set(donors.map((d) => d.user_id)), DEMO_DONORS.map((d) => d.userId)) },
      { table: 'blood_units', plan: planPresence(new Set(bloodUnits.map((u) => u.unit_uid)), DEMO_BLOOD_UNITS.map((u) => u.unitUid)) },
      { table: 'donation_history', plan: planPresence(new Set(donationHistory.map((h) => h.id)), DEMO_DONATION_HISTORY.map((h) => h.id)) },
    );
    for (const { table, plan } of demoPlans) {
      console.log(`db-seed:   demo ${table} - ${plan.toInsert.length} to insert, ${plan.alreadyPresent.length} already present`);
    }
  }

  if (settingsPlan.hasMismatch) {
    console.error(
      'db-seed: refusing - one or more settings differ from DATABASE.md section 11 (see MISMATCH lines above). Nothing was written, including the rows that were fine. Resolve the mismatch by hand, then re-run.',
    );
    process.exitCode = 1;
  } else if (!apply) {
    console.log('db-seed: plan only, nothing written. Pass --apply to write the reference data (add --demo to also write the demo dataset).');
  } else {
    await sql.begin(async (tx) => {
      for (const code of rolesPlan.toInsert) {
        await tx`INSERT INTO roles (code) VALUES (${code}) ON CONFLICT (code) DO NOTHING`;
      }
      for (const action of settingsPlan.actions) {
        if (action.kind !== 'insert') continue;
        await tx`INSERT INTO settings (key, value) VALUES (${action.key}, ${sql.json(action.value)}) ON CONFLICT (key, scope, urgency) DO NOTHING`;
      }
    });
    console.log('db-seed: reference data applied.');

    if (demo) {
      await sql.begin(async (tx) => {
        for (const u of DEMO_USERS) {
          await tx`INSERT INTO users (id, clerk_user_id, is_demo) VALUES (${u.id}, ${u.clerkUserId}, true) ON CONFLICT (clerk_user_id) DO NOTHING`;
        }
        for (const f of DEMO_FACILITIES) {
          await tx`
            INSERT INTO facilities (id, facility_type, name, created_by, is_demo, verification_status, status, location)
            VALUES (${f.id}, ${f.facilityType}, ${f.name}, ${f.createdBy}, true, 'VERIFIED', 'ACTIVE', ST_SetSRID(ST_MakePoint(${f.lng}, ${f.lat}), 4326)::geography)
            ON CONFLICT (id) DO NOTHING`;
          if (f.facilityType === 'HOSPITAL') {
            await tx`INSERT INTO hospitals (facility_id) VALUES (${f.id}) ON CONFLICT (facility_id) DO NOTHING`;
          } else {
            await tx`INSERT INTO blood_banks (facility_id) VALUES (${f.id}) ON CONFLICT (facility_id) DO NOTHING`;
          }
        }
        for (const m of DEMO_MEMBERSHIPS) {
          await tx`
            INSERT INTO facility_memberships (user_id, facility_id, role, status, joined_at)
            VALUES (${m.userId}, ${m.facilityId}, ${m.role}, 'ACTIVE', now())
            ON CONFLICT (user_id, facility_id) DO NOTHING`;
        }
        for (const p of DEMO_PATIENTS) {
          await tx`INSERT INTO patients (id, age_band, created_by, is_demo) VALUES (${p.id}, 'ADULT', ${p.createdBy}, true) ON CONFLICT (id) DO NOTHING`;
        }
        for (const d of DEMO_DONORS) {
          await tx`INSERT INTO donors (id, user_id, blood_group) VALUES (${d.id}, ${d.userId}, ${d.bloodGroup}) ON CONFLICT (user_id) DO NOTHING`;
        }
        for (const b of DEMO_BLOOD_UNITS) {
          await tx`
            INSERT INTO blood_units (unit_uid, facility_unit_code, facility_id, origin_facility_id, blood_group, component, collected_at, expires_at, status, is_demo)
            VALUES (
              ${b.unitUid}, ${b.facilityUnitCode}, ${b.facilityId}, ${b.facilityId}, ${b.bloodGroup}, ${b.component},
              now() - interval '1 day' * ${b.collectedDaysAgo}, now() + interval '1 day' * ${b.expiresInDays}, 'AVAILABLE', true
            )
            ON CONFLICT (unit_uid) DO NOTHING`;
        }
        for (const h of DEMO_DONATION_HISTORY) {
          await tx`
            INSERT INTO donation_history (id, donor_id, donated_at, source, facility_id, recorded_by, verification_status, verified_by, verified_at, is_demo)
            VALUES (
              ${h.id}, ${h.donorId}, now() - interval '1 day' * ${h.donatedDaysAgo}, 'FACILITY_RECORDED',
              ${h.facilityId}, ${h.recordedBy}, 'VERIFIED', ${h.recordedBy}, now(), true
            )
            ON CONFLICT (id) DO NOTHING`;
        }
      });
      console.log('db-seed: demo data applied.');
    }
  }
} finally {
  await sql.end({ timeout: 5 });
}
