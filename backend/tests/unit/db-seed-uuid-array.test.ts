import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Regression test for the "operator does not exist: uuid = text" bug: sql.array(values) with no explicit type
// defaults to text, which fails against a uuid column's = ANY(...). facilities.id, facility_memberships.
// facility_id, patients.id, donors.user_id and donation_history.id are all uuid columns and must pass 2950
// (PostgreSQL's uuid OID) as sql.array()'s second argument. users.clerk_user_id and blood_units.unit_uid are
// genuinely text columns and must NOT be given that type. This can only be checked against the source text
// offline: exercising the actual wire-level type would need a live connection.

const source = readFileSync(new URL('../../scripts/db-seed.ts', import.meta.url), 'utf8');

describe('db-seed.ts demo-presence queries: sql.array() element type', () => {
  it.each([
    ['facilities.id', 'sql.array(DEMO_FACILITIES.map((f) => f.id), 2950)'],
    ['facility_memberships.facility_id', 'sql.array(DEMO_MEMBERSHIPS.map((m) => m.facilityId), 2950)'],
    ['patients.id', 'sql.array(DEMO_PATIENTS.map((p) => p.id), 2950)'],
    ['donors.user_id', 'sql.array(DEMO_DONORS.map((d) => d.userId), 2950)'],
    ['donation_history.id', 'sql.array(DEMO_DONATION_HISTORY.map((h) => h.id), 2950)'],
  ])('%s (a uuid column) is typed explicitly as 2950 (uuid)', (_column, expected) => {
    expect(source).toContain(expected);
  });

  it.each([
    ['users.clerk_user_id', 'sql.array(DEMO_USERS.map((u) => u.clerkUserId))'],
    ['blood_units.unit_uid', 'sql.array(DEMO_BLOOD_UNITS.map((u) => u.unitUid))'],
  ])('%s (a genuinely text column) is left untyped (defaults to text)', (_column, expected) => {
    expect(source).toContain(expected);
    expect(source).not.toContain(`${expected.slice(0, -1)}, 2950)`);
  });
});
