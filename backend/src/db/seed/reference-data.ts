// Batch 3.8 reference seed: values copied verbatim from DATABASE.md section 11. Nothing here is invented. If a
// value ever needs to change, DATABASE.md is updated first (through its own approved-batch process), and this
// file is updated to match afterward - never the other way around.
//
// This file holds data only (no database access). scripts/db-seed-plan.ts decides what to do with it against a
// live snapshot, and scripts/db-seed.ts is the only place that actually opens a connection.

/** The 4 role codes from the role_code enum. DATABASE.md section 11: "roles: PATIENT, DONOR, ADMIN, SUPER_ADMIN". */
export const REFERENCE_ROLE_CODES = ['PATIENT', 'DONOR', 'ADMIN', 'SUPER_ADMIN'] as const;

export interface ReferenceSetting {
  key: string;
  /** Stored as jsonb; every value in this table is currently a bare number. */
  value: number;
}

/**
 * The 7 settings rows from DATABASE.md section 11's table. scope and urgency are both NULL for every one (the
 * table gives no per-scope or per-urgency override, and urgency itself is still an open decision).
 */
export const REFERENCE_SETTINGS: readonly ReferenceSetting[] = [
  { key: 'batch.size', value: 20 },
  { key: 'batch.response_window_minutes', value: 10 },
  { key: 'batch.max_count', value: 5 },
  { key: 'request.expiry_hours.standard', value: 24 },
  { key: 'request.expiry_hours.emergency', value: 6 },
  { key: 'fatigue.max_notifications', value: 3 },
  { key: 'fatigue.window_hours', value: 24 },
];

// Deliberately absent, per DATABASE.md section 11: the ranking freshness window, the emergency response window,
// the reservation expiry, the minimum shelf buffer, the maximum required_donors, reason categories, retention
// periods, maps/ETA settings, and every urgency-specific setting. And, per section 11's own separate paragraph,
// no row is ever added here for compatibility_rules, donation_interval_rules or eligibility_rules - those three
// tables have no reference-data concept in this project at all, seeded or otherwise, until an authoritative
// source is supplied.
