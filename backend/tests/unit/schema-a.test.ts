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

describe('Schema A: tables and enums', () => {
  it('defines the 18 documented Schema A tables', () => {
    expect(tables.map((t) => t.name)).toEqual(expect.arrayContaining([
      'blood_banks', 'compatibility_rules', 'donation_history', 'donation_interval_rules', 'donor_eligibility_calculations',
      'donor_locations', 'donor_verifications', 'donors', 'eligibility_rules', 'facilities', 'facility_memberships',
      'facility_verifications', 'hospitals', 'patients', 'roles', 'user_profiles', 'user_roles', 'users',
    ]));
  });

  it('defines the 19 Schema A enums, with facilities and donors sharing one verification enum without SUSPENDED', () => {
    expect(enums.length).toBeGreaterThanOrEqual(19);
    expect(schema.verificationStatusEnum.enumValues).toEqual(['PENDING', 'UNDER_REVIEW', 'VERIFIED', 'REJECTED']);
    expect(schema.facilityStatusEnum.enumValues).toEqual(['ACTIVE', 'SUSPENDED']);
    expect(schema.donationTypeEnum.enumValues).toEqual(['WHOLE_BLOOD']);
    expect(schema.eligibilityRuleKeyEnum.enumValues).toEqual(['MIN_AGE', 'MAX_AGE']);
  });

  it('has no urgency enum (open decision) and no ID-type enum (configured list)', () => {
    expect(enums.map((e) => e.enumName)).not.toContain('urgency');
    expect(enums.map((e) => e.enumName).some((n) => n.includes('id_type'))).toBe(false);
  });
});

describe('Schema A: integrity rules from DATABASE.md', () => {
  it('uses ON DELETE RESTRICT on every foreign key, except the one documented cascade', () => {
    // DATABASE.md (top): CASCADE only for pure child rows with no evidentiary value, for example notification_deliveries.
    for (const t of tables) {
      for (const fk of t.foreignKeys) {
        const column = fk.reference().columns.map((c) => c.name).join(',');
        const expected = `${t.name}.${column}` === 'notification_deliveries.notification_id' ? 'cascade' : 'restrict';
        expect({ table: t.name, column, onDelete: fk.onDelete }).toEqual({ table: t.name, column, onDelete: expected });
      }
    }
  });

  it('keeps PII columns nullable so anonymization can clear them', () => {
    const profile = table('user_profiles').columns;
    for (const name of ['full_name', 'email', 'phone', 'date_of_birth', 'address']) expect(profile.find((c) => c.name === name)?.notNull).toBe(false);
    expect(table('donor_verifications').columns.find((c) => c.name === 'id_last4')?.notNull).toBe(false);
  });

  it('gives hospitals and blood banks a composite foreign key that carries the facility type', () => {
    for (const name of ['hospitals', 'blood_banks']) {
      const fk = table(name).foreignKeys[0]?.reference();
      expect(fk?.columns.map((c) => c.name)).toEqual(['facility_id', 'facility_type']);
      expect(fk?.foreignColumns.map((c) => c.name)).toEqual(['id', 'facility_type']);
    }
  });

  it('keeps one CURRENT eligibility calculation per donor (partial unique index)', () => {
    const index = table('donor_eligibility_calculations').indexes.find((i) => i.config.name === 'donor_eligibility_calc_current_key');
    expect(index?.config.unique).toBe(true);
    expect(index?.config.where).toBeDefined();
  });

  it('ties the source donation of a calculation to the same donor (composite foreign key)', () => {
    const calc = table('donor_eligibility_calculations');
    const fk = calc.foreignKeys.map((f) => f.reference()).find((r) => r.columns.some((c) => c.name === 'source_donation_id'));
    expect(fk?.columns.map((c) => c.name)).toEqual(['source_donation_id', 'donor_id']);
    expect(fk?.foreignColumns.map((c) => c.name)).toEqual(['id', 'donor_id']);
    expect(fk ? getTableName(fk.foreignTable) : undefined).toBe('donation_history');
    // The referenced pair must itself be unique, or the foreign key could not exist.
    const pairKey = table('donation_history').uniqueConstraints.find((u) => u.columns.map((c) => c.name).join(',') === 'id,donor_id');
    expect(pairKey).toBeDefined();
    // Still nullable, because a NO_DONATION calculation has no source donation.
    expect(calc.columns.find((c) => c.name === 'source_donation_id')?.notNull).toBe(false);
  });

  it('names every documented CHECK constraint', () => {
    const expected: Record<string, string[]> = {
      users: ['users_anonymized_consistent', 'users_clerk_link_consistent'],
      user_profiles: ['user_profiles_dob_not_future', 'user_profiles_verified_phone_exists'],
      patients: ['patients_age_band_not_blank'],
      facilities: ['facilities_name_not_blank', 'facilities_verified_has_location'],
      hospitals: ['hospitals_type_is_hospital'],
      blood_banks: ['blood_banks_type_is_blood_bank'],
      facility_memberships: ['facility_memberships_joined_consistent'],
      facility_verifications: ['facility_verifications_review_recorded'],
      donors: ['donors_availability_until_temporary'],
      donor_verifications: ['donor_verifications_id_last4_format', 'donor_verifications_id_type_format', 'donor_verifications_review_recorded'],
      donation_history: ['donation_history_facility_required', 'donation_history_not_future', 'donation_history_recorder_required', 'donation_history_verification_recorded'],
      donor_eligibility_calculations: ['donor_eligibility_calc_interval_positive', 'donor_eligibility_calc_outcome_shape', 'donor_eligibility_calc_rule_considered'],
      eligibility_rules: ['eligibility_rules_range_valid', 'eligibility_rules_source_not_blank', 'eligibility_rules_value_non_negative'],
      donation_interval_rules: ['donation_interval_rules_days_positive', 'donation_interval_rules_range_valid', 'donation_interval_rules_scope_facility', 'donation_interval_rules_source_not_blank'],
      compatibility_rules: ['compatibility_rules_range_valid', 'compatibility_rules_source_not_blank'],
    };
    for (const [name, checks] of Object.entries(expected)) {
      expect(table(name).checks.map((c) => c.name).sort()).toEqual(checks);
    }
  });
});

describe('Schema A: migration files', () => {
  it('the generated migration creates 19 enums and 18 tables', () => {
    const sql = sqlFile('_schema_a.sql');
    expect(sql.match(/CREATE TYPE/g)).toHaveLength(19);
    expect(sql.match(/CREATE TABLE/g)).toHaveLength(18);
  });

  it('the guards migration has the three exclusion constraints and the guard triggers', () => {
    const sql = sqlFile('_schema_a_guards.sql');
    expect(sql.match(/EXCLUDE USING gist/g)).toHaveLength(3);
    for (const name of [
      'trg_donation_history_before_insert', 'trg_donation_history_guard_update', 'trg_donation_history_no_delete',
      'trg_eligibility_calc_guard_update', 'trg_eligibility_calc_no_delete', 'trg_interval_rule_guard',
    ]) expect(sql).toContain(name);
    expect(sql.match(/_touch_updated_at BEFORE UPDATE/g)).toHaveLength(11);
  });

  it('the guards migration never drops or deletes data', () => {
    const sql = sqlFile('_schema_a_guards.sql');
    expect(sql).not.toMatch(/\bDROP\b|\bTRUNCATE\b|DELETE FROM/i);
  });
});
