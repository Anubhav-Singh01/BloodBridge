// The tables Batch 3.7 resets before every tests/db run. Pure module: no imports of `postgres`, no I/O, no
// database connection of any kind. This is what makes it possible to unit-test the comparison logic offline
// (tests/unit/db-test-reset.test.ts), completely separately from the live database code in reset.ts.
//
// The list below is hard-coded on purpose, per the approved safeguard: it is never derived from a live query,
// and never re-derived by re-scanning the migration files (the way scripts/db-migrate-plan.ts's expectedObjects
// does for other purposes). A live query is used only to CONFIRM this exact list still matches reality
// (tableSetMismatch, below); it never DECIDES what gets truncated. To add or remove a table, this array must be
// edited by hand, in review, in the same way any other reviewed change to this project is made.

/** Batch 3.7 truncates exactly these 40 tables. Deliberately omits request_transitions (see REFERENCE_TABLES). */
export const RESET_TABLES = [
  // Schema A (18 tables, DATABASE.md 2.1-2.4)
  'users', 'user_profiles', 'roles', 'user_roles', 'patients',
  'facilities', 'hospitals', 'blood_banks', 'facility_memberships', 'facility_verifications',
  'donors', 'donor_verifications', 'donor_locations', 'donation_history', 'donor_eligibility_calculations',
  'eligibility_rules', 'donation_interval_rules', 'compatibility_rules',
  // Schema B (7 of its 8 tables, DATABASE.md 2.5-2.6; request_transitions excluded, see below)
  'blood_requests', 'blood_request_status_history', 'request_events', 'request_flags',
  'blood_units', 'blood_unit_events', 'inventory_reservations',
  // Schema C (15 tables, DATABASE.md 2.7-2.8; analytics_daily was deferred in Batch 3.4 and does not exist)
  'donor_searches', 'ranking_runs', 'ranking_predictions', 'notification_batches', 'donor_matches',
  'donor_responses', 'ml_model_versions', 'notifications', 'notification_deliveries', 'settings',
  'audit_logs', 'webhook_events', 'location_access_logs', 'data_deletion_requests', 'idempotency_keys',
] as const;

/**
 * Fixed reference data inserted by the migrations themselves (0004_schema_b_guards.sql's 29-row INSERT), not
 * test data. Never truncated: truncating it would break the request state-machine trigger for every test.
 */
export const REFERENCE_TABLES = ['request_transitions'] as const;

/** The full set the live public schema must have before a reset is allowed: RESET_TABLES plus the reference table. */
export const ALL_EXPECTED_TABLES: readonly string[] = [...RESET_TABLES, ...REFERENCE_TABLES];

/**
 * Pure comparison, order-independent. Returns null when `actual` is exactly ALL_EXPECTED_TABLES (a set match);
 * otherwise the list of every difference (each table missing from `actual`, each table in `actual` that is not
 * expected), so a caller can fail closed with a precise reason rather than guessing.
 */
export function tableSetMismatch(actual: readonly string[]): string[] | null {
  const expected = new Set(ALL_EXPECTED_TABLES);
  const seen = new Set(actual);
  const missing = ALL_EXPECTED_TABLES.filter((t) => !seen.has(t)).map((t) => `missing: ${t}`);
  const unexpected = actual.filter((t) => !expected.has(t)).map((t) => `unexpected: ${t}`);
  const problems = [...missing, ...unexpected];
  return problems.length > 0 ? problems : null;
}

/** The single TRUNCATE statement Batch 3.7 ever sends. Built once, from the hard-coded array above, never from a query result. */
export const RESET_STATEMENT = `TRUNCATE TABLE ${RESET_TABLES.map((t) => `"${t}"`).join(', ')} RESTART IDENTITY CASCADE`;
