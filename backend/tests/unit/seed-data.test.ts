import { describe, expect, it } from 'vitest';
import { REFERENCE_ROLE_CODES, REFERENCE_SETTINGS } from '../../src/db/seed/reference-data.js';
import * as demoDataModule from '../../src/db/seed/demo-data.js';
import {
  DEMO_BLOOD_UNITS,
  DEMO_DONATION_HISTORY,
  DEMO_DONORS,
  DEMO_FACILITIES,
  DEMO_IDS,
  DEMO_MEMBERSHIPS,
  DEMO_PATIENTS,
  DEMO_USERS,
} from '../../src/db/seed/demo-data.js';

// Batch 3.8. These are the project's only two seed data files; scripts/db-seed.ts and scripts/db-seed-plan.ts
// do the rest and have their own tests (db-seed-plan.test.ts). Nothing here opens a database connection.

describe('reference-data.ts matches DATABASE.md section 11 exactly', () => {
  it('has exactly the 4 documented role codes', () => {
    expect([...REFERENCE_ROLE_CODES].sort()).toEqual(['ADMIN', 'DONOR', 'PATIENT', 'SUPER_ADMIN']);
  });

  it('has exactly the 7 documented settings, with the documented values', () => {
    const expected: Record<string, number> = {
      'batch.size': 20,
      'batch.response_window_minutes': 10,
      'batch.max_count': 5,
      'request.expiry_hours.standard': 24,
      'request.expiry_hours.emergency': 6,
      'fatigue.max_notifications': 3,
      'fatigue.window_hours': 24,
    };
    expect(REFERENCE_SETTINGS).toHaveLength(Object.keys(expected).length);
    for (const row of REFERENCE_SETTINGS) {
      expect(row.value).toBe(expected[row.key]);
    }
    expect(new Set(REFERENCE_SETTINGS.map((r) => r.key))).toEqual(new Set(Object.keys(expected)));
  });

  it('every settings key matches settings_key_format (letters, digits, underscore, dot only)', () => {
    for (const row of REFERENCE_SETTINGS) {
      expect(row.key).toMatch(/^[A-Za-z][A-Za-z0-9_.]*$/);
    }
  });
});

describe('demo-data.ts: synthetic, deterministic, and never a medical-rule or blood-request row', () => {
  it('every fixed demo id is unique and uses the hand-written (never gen_random_uuid()) marker prefix', () => {
    const ids = Object.values(DEMO_IDS);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id.startsWith('d0000000-')).toBe(true);
  });

  it('every demo natural key and name is obviously fake and clearly prefixed', () => {
    for (const u of DEMO_USERS) expect(u.clerkUserId.startsWith('demo-')).toBe(true);
    for (const b of DEMO_BLOOD_UNITS) {
      expect(b.unitUid.startsWith('DEMO-UNIT-')).toBe(true);
      expect(b.facilityUnitCode.startsWith('DEMO-CODE-')).toBe(true);
    }
    for (const f of DEMO_FACILITIES) expect(f.name.startsWith('DEMO ')).toBe(true);
  });

  it('has no duplicate natural/fixed keys within any single table', () => {
    expect(new Set(DEMO_USERS.map((u) => u.clerkUserId)).size).toBe(DEMO_USERS.length);
    expect(new Set(DEMO_FACILITIES.map((f) => f.id)).size).toBe(DEMO_FACILITIES.length);
    expect(new Set(DEMO_DONORS.map((d) => d.userId)).size).toBe(DEMO_DONORS.length);
    expect(new Set(DEMO_BLOOD_UNITS.map((b) => b.unitUid)).size).toBe(DEMO_BLOOD_UNITS.length);
    expect(new Set(DEMO_DONATION_HISTORY.map((h) => h.id)).size).toBe(DEMO_DONATION_HISTORY.length);
    expect(new Set(DEMO_PATIENTS.map((p) => p.id)).size).toBe(DEMO_PATIENTS.length);
    expect(new Set(DEMO_MEMBERSHIPS.map((m) => `${m.userId}:${m.facilityId}`)).size).toBe(DEMO_MEMBERSHIPS.length);
  });

  it('every foreign reference in the dataset points at a row that is actually in the dataset', () => {
    const userIds = new Set(DEMO_USERS.map((u) => u.id));
    const facilityIds = new Set(DEMO_FACILITIES.map((f) => f.id));
    const donorIds = new Set(DEMO_DONORS.map((d) => d.id));

    for (const f of DEMO_FACILITIES) expect(userIds.has(f.createdBy)).toBe(true);
    for (const m of DEMO_MEMBERSHIPS) {
      expect(userIds.has(m.userId)).toBe(true);
      expect(facilityIds.has(m.facilityId)).toBe(true);
    }
    for (const p of DEMO_PATIENTS) expect(userIds.has(p.createdBy)).toBe(true);
    for (const d of DEMO_DONORS) expect(userIds.has(d.userId)).toBe(true);
    for (const b of DEMO_BLOOD_UNITS) expect(facilityIds.has(b.facilityId)).toBe(true);
    for (const h of DEMO_DONATION_HISTORY) {
      expect(donorIds.has(h.donorId)).toBe(true);
      expect(facilityIds.has(h.facilityId)).toBe(true);
      expect(userIds.has(h.recordedBy)).toBe(true);
    }
  });

  it('contains no blood_requests data at all (DATABASE.md section 11: the demo seed has none)', () => {
    // A structural guard, not a runtime one: this module must never grow a "request"-shaped export. If this
    // ever needs updating, that is the signal to first check the urgency-taxonomy decision has actually been
    // made (DATABASE.md section 13's open decisions list), not to just make the export and move on.
    expect(Object.keys(demoDataModule).some((name) => /request/i.test(name))).toBe(false);
  });
});
