import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { getTableName, is } from 'drizzle-orm';
import { PgTable, getTableConfig, getViewConfig, isPgEnum } from 'drizzle-orm/pg-core';
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
const index = (t: string, name: string) => table(t).indexes.find((i) => i.config.name === name);
// A single-column .unique() is exposed on the column; a multi-column unique() is in uniqueConstraints.
const uniqueOn = (t: string, ...columns: string[]) =>
  columns.length === 1
    ? table(t).columns.some((c) => c.name === columns[0] && c.isUnique)
    : table(t).uniqueConstraints.some((u) => names(u.columns)?.join(',') === columns.join(','));

// The text of one guard function: from its CREATE line to the closing $$; (no regular expression, so nothing to mis-escape).
const functionBody = (sql: string, name: string) => {
  const start = sql.indexOf(`CREATE OR REPLACE FUNCTION ${name}()`);
  const end = sql.indexOf('\n$$;', start);
  return start >= 0 && end > start ? sql.slice(start, end) : '';
};

const SCHEMA_C_TABLES = [
  'donor_searches', 'notification_batches', 'ranking_runs', 'ranking_predictions', 'donor_matches', 'donor_responses', 'ml_model_versions',
  'notifications', 'notification_deliveries', 'settings', 'audit_logs', 'webhook_events',
  'location_access_logs', 'data_deletion_requests', 'idempotency_keys',
];

describe('Schema C: tables and enums', () => {
  it('adds 15 of the 16 documented tables, making 41 in total', () => {
    expect(tables).toHaveLength(41);
    expect(tables.map((t) => t.name)).toEqual(expect.arrayContaining(SCHEMA_C_TABLES));
  });

  it('defers analytics_daily: its metrics are not defined by the API or database contract yet', () => {
    expect(tables.map((t) => t.name)).not.toContain('analytics_daily');
  });

  it('adds 11 enums (36 in total) with the documented values', () => {
    expect(enums).toHaveLength(36);
    expect(schema.matchStatusEnum.enumValues).toEqual(['CANDIDATE', 'EXCLUDED', 'NOTIFIED', 'ACCEPTED', 'CONFIRMED', 'WAITLISTED', 'DECLINED', 'NO_RESPONSE', 'EXPIRED', 'DROPPED', 'COMPLETED']);
    expect(schema.batchStatusEnum.enumValues).toEqual(['PENDING', 'ACTIVE', 'EVALUATED', 'CANCELLED']);
    expect(schema.searchStatusEnum.enumValues).toEqual(['ACTIVE', 'FULFILLED', 'EXHAUSTED', 'CANCELLED', 'EXPIRED']);
    // The label set of ML.md section 2: a drop and WAITLISTED are never response values.
    expect(schema.donorResponseKindEnum.enumValues).toEqual(['ACCEPTED', 'DECLINED', 'NO_RESPONSE', 'EXPIRED']);
    expect(schema.modelStatusEnum.enumValues).toEqual(['CANDIDATE', 'ACTIVE', 'RETIRED']);
  });

  it('still has no urgency enum: settings.urgency is nullable text with no CHECK', () => {
    const urgency = table('settings').columns.find((c) => c.name === 'urgency');
    expect(urgency?.notNull).toBe(false);
    expect(urgency?.getSQLType()).toBe('text');
    expect(enums.map((e) => e.enumName)).not.toContain('urgency');
    expect(table('settings').checks.some((c) => c.name.includes('urgency'))).toBe(false);
  });

  it('keeps personal data and coordinates out of the Schema C tables that must not hold them', () => {
    const forbidden = /email|phone|full_name|address|date_of_birth|latitude|longitude|location/;
    for (const name of ['donor_searches', 'notification_batches', 'ranking_runs', 'ranking_predictions', 'donor_responses', 'ml_model_versions', 'audit_logs', 'webhook_events', 'location_access_logs', 'idempotency_keys']) {
      expect({ table: name, columns: table(name).columns.map((c) => c.name).filter((c) => forbidden.test(c)) }).toEqual({ table: name, columns: [] });
    }
  });
});

describe('Schema C: integrity rules from DATABASE.md', () => {
  it('has one match per donor per search, and one search per request', () => {
    expect(uniqueOn('donor_matches', 'search_id', 'donor_id')).toBe(true);
    expect(uniqueOn('donor_searches', 'request_id')).toBe(true);
  });

  it('lets a match reference only a batch of its own search (composite foreign key)', () => {
    const ref = fk('donor_matches', 'batch_id');
    expect(names(ref?.columns)).toEqual(['batch_id', 'search_id']);
    expect(names(ref?.foreignColumns)).toEqual(['id', 'search_id']);
    expect(table('notification_batches').uniqueConstraints.some((u) => names(u.columns)?.join(',') === 'id,search_id')).toBe(true);
  });

  it('lets a match select only a prediction made for the same donor (composite foreign key)', () => {
    const ref = fk('donor_matches', 'selected_prediction_id');
    expect(names(ref?.columns)).toEqual(['selected_prediction_id', 'donor_id']);
    expect(names(ref?.foreignColumns)).toEqual(['id', 'donor_id']);
    expect(table('ranking_predictions').uniqueConstraints.some((u) => names(u.columns)?.join(',') === 'id,donor_id')).toBe(true);
  });

  it('lets a batch reference only a ranking run of its own search (composite foreign key)', () => {
    const ref = fk('notification_batches', 'ranking_run_id');
    expect(names(ref?.columns)).toEqual(['ranking_run_id', 'search_id']);
    expect(names(ref?.foreignColumns)).toEqual(['id', 'search_id']);
    expect(table('ranking_runs').uniqueConstraints.some((u) => names(u.columns)?.join(',') === 'id,search_id')).toBe(true);
  });

  it('keeps one prediction per donor per ranking run, and one response per match', () => {
    expect(uniqueOn('ranking_predictions', 'ranking_run_id', 'donor_id')).toBe(true);
    expect(uniqueOn('donor_responses', 'match_id')).toBe(true);
  });

  it('completes the request timeline link: request_events.match_id references donor_matches', () => {
    expect(fk('request_events', 'match_id') ? getTableName(fk('request_events', 'match_id')!.foreignTable) : undefined).toBe('donor_matches');
    expect(fk('notifications', 'match_id') ? getTableName(fk('notifications', 'match_id')!.foreignTable) : undefined).toBe('donor_matches');
    expect(fk('notifications', 'request_id') ? getTableName(fk('notifications', 'request_id')!.foreignTable) : undefined).toBe('blood_requests');
  });

  it('allows one ACTIVE batch per search, one ACTIVE model, and one PENDING deletion request per user (partial unique indexes)', () => {
    for (const [t, name] of [['notification_batches', 'notification_batches_one_active_per_search'], ['ml_model_versions', 'ml_model_versions_one_active'], ['data_deletion_requests', 'data_deletion_requests_one_pending_per_user']] as const) {
      expect({ index: name, unique: index(t, name)?.config.unique, partial: index(t, name)?.config.where !== undefined }).toEqual({ index: name, unique: true, partial: true });
    }
  });

  it('treats NULL scope and urgency as equal in the settings key (NULLS NOT DISTINCT)', () => {
    const key = table('settings').uniqueConstraints.find((u) => u.name === 'settings_key_scope_urgency_key');
    expect(names(key?.columns)).toEqual(['key', 'scope', 'urgency']);
    expect(key?.nullsNotDistinct).toBe(true);
  });

  it('has exactly one CASCADE foreign key: notification_deliveries to notifications', () => {
    const cascades = tables.flatMap((t) => t.foreignKeys.filter((f) => f.onDelete === 'cascade').map((f) => `${t.name}.${names(f.reference().columns)?.join(',')}`));
    expect(cascades).toEqual(['notification_deliveries.notification_id']);
  });

  it('names every documented CHECK constraint', () => {
    const expected: Record<string, string[]> = {
      donor_searches: ['donor_searches_batch_count_non_negative', 'donor_searches_config_is_object', 'donor_searches_confirmed_within_required', 'donor_searches_required_positive'],
      ranking_runs: ['ranking_runs_fallback_version', 'ranking_runs_input_count_non_negative', 'ranking_runs_model_version_not_blank'],
      ranking_predictions: ['ranking_predictions_rank_positive', 'ranking_predictions_reasons_is_array', 'ranking_predictions_snapshot_is_object'],
      notification_batches: ['notification_batches_expiry_after_open', 'notification_batches_number_positive'],
      donor_matches: [
        'donor_matches_arrived_status', 'donor_matches_batch_by_status', 'donor_matches_consent_needs_batch', 'donor_matches_distance_eta_non_negative',
        'donor_matches_drop_reason', 'donor_matches_dropped_by_only_when_dropped', 'donor_matches_exclusion_reason', 'donor_matches_reason_code_format',
        'donor_matches_selection_consistent',
      ],
      donor_responses: ['donor_responses_latency_non_negative'],
      ml_model_versions: ['ml_model_versions_activation_recorded', 'ml_model_versions_metrics_is_object', 'ml_model_versions_not_fallback_label', 'ml_model_versions_version_not_blank'],
      notifications: ['notifications_data_is_object', 'notifications_type_format'],
      notification_deliveries: ['notification_deliveries_error_only_when_failed'],
      settings: ['settings_key_format', 'settings_scope_reserved'],
      audit_logs: ['audit_logs_action_format', 'audit_logs_details_is_object', 'audit_logs_entity_needs_type', 'audit_logs_entity_type_format'],
      webhook_events: ['webhook_events_fields_not_blank'],
      location_access_logs: ['location_access_logs_purpose_format'],
      data_deletion_requests: ['data_deletion_requests_completion_recorded', 'data_deletion_requests_hold_blocks_completion'],
      idempotency_keys: ['idempotency_keys_expiry_after_creation', 'idempotency_keys_key_not_blank'],
    };
    for (const [name, checks] of Object.entries(expected)) expect(table(name).checks.map((c) => c.name).sort()).toEqual(checks);
  });

  it('gives the coarse-location view only the coarse column, never the exact one', () => {
    expect(Object.keys(getViewConfig(schema.donorLocationsCoarse).selectedFields).sort()).toEqual(['donorId', 'locationCoarse', 'updatedAt']);
  });
});

describe('Schema C: migrations', () => {
  it('the generated migration creates 11 enums and 15 tables, and no view', () => {
    const sql = sqlFile('_schema_c.sql');
    expect(sql.match(/CREATE TYPE/g)).toHaveLength(11);
    expect(sql.match(/CREATE TABLE/g)).toHaveLength(15);
    expect(sql).not.toContain('analytics_daily');
    expect(sql).toContain('NULLS NOT DISTINCT');
    expect(sql).not.toMatch(/CREATE (OR REPLACE )?VIEW/);
    // A FALLBACK run must carry the fallback label, and an ML run must not (the ML side is also checked by a trigger).
    expect(sql).toContain(`CONSTRAINT "ranking_runs_fallback_version" CHECK (("ranking_runs"."ranker_type" = 'FALLBACK') = ("ranking_runs"."model_version" = 'rule-based-fallback'))`);
  });

  it('attaches exactly the intended triggers', () => {
    const sql = sqlFile('_schema_c_guards.sql');
    const triggers = [...sql.matchAll(/CREATE TRIGGER \w+ BEFORE (INSERT OR UPDATE|INSERT|UPDATE|DELETE) ON (\w+) FOR EACH ROW EXECUTE FUNCTION (\w+)\(\)/g)].map((m) => `${m[2]}|${m[1]}|${m[3]}`).sort();
    const touch = ['donor_searches', 'notification_batches', 'donor_matches', 'ml_model_versions', 'settings', 'notification_deliveries', 'data_deletion_requests'].map((t) => `${t}|UPDATE|bb_touch_updated_at`);
    const appendOnly = ['ranking_runs', 'ranking_predictions', 'donor_responses', 'audit_logs', 'location_access_logs'].flatMap((t) => [`${t}|UPDATE|bb_forbid_update`, `${t}|DELETE|bb_forbid_delete`]);
    const neverDeleted = ['donor_searches', 'notification_batches', 'donor_matches', 'ml_model_versions', 'data_deletion_requests'].map((t) => `${t}|DELETE|bb_forbid_delete`);
    const guards = [
      'donor_matches|INSERT OR UPDATE|bb_donor_match_guard',
      'request_events|INSERT|bb_request_event_match_guard',
      'ranking_runs|INSERT|bb_ranking_run_guard',
      'ml_model_versions|UPDATE|bb_ml_model_version_guard',
      'notification_batches|UPDATE|bb_notification_batch_guard',
    ];
    expect(triggers).toEqual([...touch, ...appendOnly, ...neverDeleted, ...guards].sort());
  });

  it('the donor match guard requires the batch to have a ranking run, equal to the run of the selected prediction', () => {
    const body = functionBody(sqlFile('_schema_c_guards.sql'), 'bb_donor_match_guard');
    expect(body).not.toBe('');
    expect(body).toContain('IF NEW.batch_id IS NOT NULL AND NEW.selected_prediction_id IS NOT NULL THEN');
    expect(body).toContain('SELECT ranking_run_id INTO batch_run FROM notification_batches WHERE id = NEW.batch_id;');
    expect(body).toContain('IF batch_run IS NULL THEN');
    expect(body).toContain('SELECT ranking_run_id INTO prediction_run FROM ranking_predictions WHERE id = NEW.selected_prediction_id;');
    expect(body).toContain('IF prediction_run IS DISTINCT FROM batch_run THEN');
    // The earlier version skipped the comparison when the batch had no run. That escape hatch must stay gone.
    expect(body).not.toContain('IF batch_run IS NOT NULL THEN');
  });

  it('an ML ranking run must name an existing model version, and that version can never be renamed or deleted', () => {
    const sql = sqlFile('_schema_c_guards.sql');
    const runGuard = functionBody(sql, 'bb_ranking_run_guard');
    expect(runGuard).not.toBe('');
    expect(runGuard).toContain("IF NEW.ranker_type = 'ML' AND NOT EXISTS (");
    expect(runGuard).toContain('SELECT 1 FROM ml_model_versions WHERE model_version = NEW.model_version');
    const renameGuard = functionBody(sql, 'bb_ml_model_version_guard');
    expect(renameGuard).not.toBe('');
    expect(renameGuard).toContain('IF NEW.model_version IS DISTINCT FROM OLD.model_version THEN');
    expect(sql).toContain('CREATE TRIGGER trg_ml_model_versions_no_delete BEFORE DELETE ON ml_model_versions');
  });

  it('a batch ranking run can be set once (NULL to a run) and can never change or be cleared', () => {
    const sql = sqlFile('_schema_c_guards.sql');
    const body = functionBody(sql, 'bb_notification_batch_guard');
    expect(body).not.toBe('');
    // The whole rule is this one condition. IS DISTINCT FROM is NULL-safe: a plain <> would let "run -> NULL" through.
    expect(body).toContain('IF OLD.ranking_run_id IS NOT NULL AND NEW.ranking_run_id IS DISTINCT FROM OLD.ranking_run_id THEN');
    expect(body).not.toMatch(/ranking_run_id\s*(<>|!=)/);
    expect(sql).toContain('CREATE TRIGGER trg_notification_batch_guard BEFORE UPDATE ON notification_batches');

    // The same condition, transcribed, applied to the transitions of the requirement. JavaScript's !== is NULL-safe in the
    // same way as IS DISTINCT FROM. The real PostgreSQL behaviour is tested in Batch 3.7 (see the list at the end).
    const rejected = (oldRun: string | null, newRun: string | null) => oldRun !== null && newRun !== oldRun;
    expect(rejected(null, 'run-a')).toBe(false); // NULL -> a run: allowed
    expect(rejected('run-a', 'run-a')).toBe(false); // the same run: allowed
    expect(rejected('run-a', 'run-b')).toBe(true); // a different run: rejected
    expect(rejected('run-a', null)).toBe(true); // back to NULL: rejected
    expect(rejected(null, null)).toBe(false); // still no run: allowed
  });

  it('creates the coarse view from the coarse column only, seeds nothing, and never drops or deletes data', () => {
    const sql = sqlFile('_schema_c_guards.sql');
    const view = sql.match(/CREATE VIEW donor_locations_coarse AS[\s\S]*?;/)?.[0] ?? '';
    expect(view).toContain('location_coarse');
    expect(view).not.toContain('location_exact');
    expect(sql).not.toMatch(/INSERT INTO/);
    expect(sql).not.toMatch(/\bDROP\b|\bTRUNCATE\b|DELETE FROM/i);
  });
});

// The behaviour that only a real PostgreSQL can prove (the 14 items formerly listed here as it.todo()) is now
// implemented for real, against the dedicated test branch, in backend/tests/db/schema-c.db.test.ts and
// concurrency.db.test.ts (Batch 3.7, run via `npm run test:db`, never by this offline `npm test` suite).
