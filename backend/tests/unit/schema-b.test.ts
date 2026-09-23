import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { getTableName, is } from 'drizzle-orm';
import { PgTable, getTableConfig, isPgEnum } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import * as schema from '../../src/db/schema/index.js';

const exported: unknown[] = Object.values(schema);
const tables = exported.filter((x): x is PgTable => is(x, PgTable)).map((t) => getTableConfig(t));
const enums = exported.filter(isPgEnum);
const table = (name: string) => {
  const found = tables.find((t) => t.name === name);
  if (!found) throw new Error(`table ${name} not found`);
  return found;
};
const drizzleDir = join(import.meta.dirname, '../../drizzle');
const sqlFile = (suffix: string) => readFileSync(join(drizzleDir, readdirSync(drizzleDir).find((f) => f.endsWith(suffix)) ?? ''), 'utf8');
const fk = (t: string, column: string) => table(t).foreignKeys.map((f) => f.reference()).find((r) => r.columns.some((c) => c.name === column));
const names = (cols: { name: string }[] | undefined) => cols?.map((c) => c.name);

describe('Schema B: tables and enums', () => {
  it('adds the 8 documented Schema B tables', () => {
    expect(tables.length).toBeGreaterThanOrEqual(26);
    expect(tables.map((t) => t.name)).toEqual(expect.arrayContaining([
      'blood_units', 'blood_unit_events', 'inventory_reservations', 'blood_requests',
      'blood_request_status_history', 'request_transitions', 'request_events', 'request_flags',
    ]));
  });

  it('adds 6 Schema B enums with the documented states', () => {
    expect(enums.length).toBeGreaterThanOrEqual(25);
    expect(schema.requestStatusEnum.enumValues).toEqual(['DRAFT', 'SUBMITTED', 'VERIFICATION_PENDING', 'ACTIVE', 'DONOR_SEARCH', 'DONOR_CONTACTED', 'DONOR_ACCEPTED', 'DONOR_CONFIRMED', 'FULFILLED', 'CANCELLED', 'EXPIRED', 'REJECTED']);
    expect(schema.bloodUnitStatusEnum.enumValues).toEqual(['AVAILABLE', 'RESERVED', 'ISSUED', 'EXPIRED', 'DISCARDED']);
    expect(schema.reservationStatusEnum.enumValues).toEqual(['ACTIVE', 'RELEASED', 'ISSUED', 'EXPIRED']);
  });

  it('leaves urgency an open decision: nullable text, no enum, no CHECK', () => {
    const urgency = table('blood_requests').columns.find((c) => c.name === 'urgency');
    expect(urgency?.notNull).toBe(false);
    expect(urgency?.getSQLType()).toBe('text');
    expect(enums.map((e) => e.enumName)).not.toContain('urgency');
    expect(table('blood_requests').checks.map((c) => c.name).some((n) => n.includes('urgency'))).toBe(false);
  });
});

describe('Schema B: integrity rules', () => {
  it('ties a unit to a reservation of the same unit (composite foreign key)', () => {
    const ref = fk('blood_units', 'active_reservation_id');
    expect(names(ref?.columns)).toEqual(['active_reservation_id', 'id']);
    expect(names(ref?.foreignColumns)).toEqual(['id', 'unit_id']);
    expect(table('inventory_reservations').uniqueConstraints.some((u) => names(u.columns)?.join(',') === 'id,unit_id')).toBe(true);
  });

  it('allows one ACTIVE reservation per unit (partial unique index)', () => {
    const index = table('inventory_reservations').indexes.find((i) => i.config.name === 'inventory_reservations_one_active_per_unit');
    expect(index?.config.unique).toBe(true);
    expect(index?.config.where).toBeDefined();
  });

  it('lets a request use only patient records its requester created (composite foreign key)', () => {
    const ref = fk('blood_requests', 'patient_id');
    expect(names(ref?.columns)).toEqual(['patient_id', 'requester_id']);
    expect(names(ref?.foreignColumns)).toEqual(['id', 'created_by']);
    expect(table('patients').uniqueConstraints.some((u) => names(u.columns)?.join(',') === 'id,created_by')).toBe(true);
  });

  it('points donation history at the request it belongs to', () => {
    const ref = fk('donation_history', 'request_id');
    expect(ref ? getTableName(ref.foreignTable) : undefined).toBe('blood_requests');
  });

  it('keys request_transitions by (from_status, to_status)', () => {
    expect(table('request_transitions').primaryKeys[0]?.columns.map((c) => c.name)).toEqual(['from_status', 'to_status']);
  });

  it('names every documented CHECK constraint', () => {
    const expected: Record<string, string[]> = {
      blood_requests: ['blood_requests_donors_positive', 'blood_requests_expiry_set', 'blood_requests_units_positive'],
      blood_request_status_history: ['blood_request_status_history_changes_status', 'blood_request_status_history_first_is_draft'],
      request_transitions: ['request_transitions_changes_status', 'request_transitions_has_actor'],
      request_flags: ['request_flags_resolution_recorded', 'request_flags_rule_code_format'],
      blood_units: ['blood_units_expiry_after_collection', 'blood_units_identifiers_not_blank', 'blood_units_reserved_has_reservation'],
      blood_unit_events: ['blood_unit_events_request_required', 'blood_unit_events_transfer_facilities'],
      inventory_reservations: ['inventory_reservations_end_recorded', 'inventory_reservations_expiry_after_reserved', 'inventory_reservations_reason_only_when_ended'],
    };
    for (const [name, checks] of Object.entries(expected)) expect(table(name).checks.map((c) => c.name).sort()).toEqual(checks);
  });
});

describe('Schema B: migrations', () => {
  it('the generated migration creates 6 enums and 8 tables', () => {
    const sql = sqlFile('_schema_b.sql');
    expect(sql.match(/CREATE TYPE/g)).toHaveLength(6);
    expect(sql.match(/CREATE TABLE/g)).toHaveLength(8);
  });

  it('inserts exactly the transitions documented in DATABASE.md section 4', () => {
    const doc = readFileSync(join(import.meta.dirname, '../../../DATABASE.md'), 'utf8');
    const section = doc.slice(doc.indexOf('## 4. Request state machine'), doc.indexOf('## 5.'));
    const documented: string[] = [];
    for (const line of section.split('\n')) {
      const m = line.match(/^\| ([A-Z_]+) \| (.+) \|$/);
      if (m?.[1] && m[2]) for (const to of m[2].match(/\b[A-Z][A-Z_]+\b/g) ?? []) documented.push(`${m[1]}>${to}`);
    }
    const sql = sqlFile('_schema_b_guards.sql');
    const inserted = [...sql.matchAll(/\('([A-Z_]+)', '([A-Z_]+)', ARRAY\[([^\]]*)\]/g)].map((m) => `${m[1]}>${m[2]}`);
    expect(documented).toHaveLength(29);
    expect(inserted.sort()).toEqual(documented.sort());
  });

  it('gives every transition at least one actor, and only known actor kinds', () => {
    const sql = sqlFile('_schema_b_guards.sql');
    for (const m of sql.matchAll(/\('[A-Z_]+', '[A-Z_]+', ARRAY\[([^\]]*)\]/g)) {
      const actors = (m[1] ?? '').match(/'([A-Z_]+)'/g)?.map((a) => a.replaceAll("'", '')) ?? [];
      expect(actors.length).toBeGreaterThan(0);
      for (const actor of actors) expect(schema.requestActorKindEnum.enumValues).toContain(actor);
    }
  });

  it('has the guard functions and triggers, and never drops or deletes data', () => {
    const sql = sqlFile('_schema_b_guards.sql');
    for (const name of ['trg_blood_request_state_guard', 'trg_blood_unit_guard_update', 'trg_blood_units_no_delete', 'trg_reservation_guard_update', 'trg_reservations_no_delete', 'trg_blood_unit_events_no_update', 'trg_request_status_history_no_delete', 'trg_request_events_no_update']) expect(sql).toContain(name);
    expect(sql).not.toMatch(/\bDROP\b|\bTRUNCATE\b|DELETE FROM/i);
  });
});
