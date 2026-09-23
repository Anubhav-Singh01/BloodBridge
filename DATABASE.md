# BloodBridge AI: Database design (revision 3, schema implemented in Phase 3)

Neon PostgreSQL with Drizzle ORM. UUID primary keys (`gen_random_uuid()`). `created_at` and `updated_at` on mutable tables. Enums as Postgres enums. Foreign keys everywhere. `ON DELETE` is RESTRICT for anything that is history or evidence; CASCADE is used only for pure child rows with no evidentiary value (for example `notification_deliveries` of a purged notification). Nothing cascades from `users`.

This document is the design and remains the source of truth for intent and rationale. The schema, migrations and guard functions it describes are implemented as `backend/drizzle/0000`-`0006` and applied to the `dev` and `test` Neon branches (Batches 3.1-3.8); any further schema change starts by updating this document first, then a new migration.

## 0. Changes in revision 3 (Phase 3 reconciliation)

1. `donor_matches` gains `arrived_at`, `location_consent_at`, `drop_reason` and `dropped_by` with constraints (section 6). No new status and no state-machine change.
2. `facilities.status` (ACTIVE, SUSPENDED) is separate from `verification_status`, matching API.md 11.1.
3. `user_profiles` stores `date_of_birth` and `phone_verified_at`. Age is never stored.
4. `blood_requests` gains the fields API.md 6.1 collects, and its `location` is a server-set copy of the hospital's location. `patients` gains `created_by` and `user_id`.
5. `notifications` gain nullable `request_id`, `match_id` and `read_at`.
6. `eligibility_rules` are limited to the keys MIN_AGE and MAX_AGE.
7. `urgency` is recorded as an open decision: no enum and no seed values.
8. Seeds, environments (`dev` and `test` Neon branches) and migration policy are written down (section 11). No medical rule values are seeded, not even as placeholders.

### Revision 2 changes

1. Common `facilities` entity with real foreign keys, replacing `facility_type + facility_id` pairs.
2. Donation history now has an explicit verification model; only verified records can move `next_eligible_donation_at`.
3. Eligibility calculations are stored, so `next_eligible_donation_at` is auditable.
4. Blood units have a traceable unit identifier and a race-free reservation model.
5. `donor_matches.batch_id` lifecycle and constraints are defined.
6. `ml_predictions` is renamed `ranking_predictions` (approved) and separated from `ranking_runs` and from `donor_matches`, with one source of truth for the score and feature snapshot actually used.
7. PII anonymization is separated from historical records.
8. Location tiers and authorization are defined.
9. Inventory reservation gets the same transactional protection as donor acceptance.

Unchanged: PostGIS approach, the request state machine, donor acceptance concurrency, all Phase 0 decisions.

## 1. PostGIS

Neon supports `CREATE EXTENSION postgis`. Used for `geography(Point,4326)` columns with GiST indexes, `ST_DWithin` for radius pre-filtering, and `ST_Distance` for straight-line distance. The Google Routes API (Compute Route Matrix) is then called only for the shortlist. Location tiers and access rules are in section 9.

## 2. Tables

### 2.1 Identity and access
- `users`: id, clerk_user_id (unique, nullable after anonymization), status (ACTIVE, SUSPENDED, DELETION_PENDING, ANONYMIZED), anonymized_at. Contains no PII beyond the Clerk link.
- `user_profiles`: user_id (PK, FK), full_name, email, phone, phone_verified_at (nullable; set and cleared by the Clerk synchronisation, NULL means not verified; the "phone verified" hard filter in ARCHITECTURE.md 3.2 reads it), date_of_birth (date; age is always computed from it and is never stored), address. All PII lives here so anonymization has one target (section 8).
- `roles` (seed: PATIENT, DONOR, ADMIN, SUPER_ADMIN).
- `user_roles`: user_id, role_id, granted_by, granted_at. Global roles only. Unique (user, role).
- `facility_memberships`: id, user_id FK users, facility_id FK facilities, role (FACILITY_ADMIN, STAFF), status (INVITED, ACTIVE, REMOVED), invited_by, joined_at. Unique (user_id, facility_id). The HOSPITAL and BLOOD_BANK roles are derived from an ACTIVE membership in a facility of that type. They are not stored in `user_roles`, so scoped permissions have real foreign keys.
- `patients`: minimal patient record for a request: full_name, age_band (the band supplied when the record is created, as API.md 6.1 `ageBand`, not an age; for `forSelf` it is derived from the requester's `date_of_birth` at creation; no diagnosis), created_by (FK users, RESTRICT: the requester who created the record) and user_id (nullable FK users, RESTRICT: set only when the patient is the requester themself, `forSelf` in API.md 6.1). A requester may be the patient or a family member.

### 2.2 Facilities (common entity with specialised records)
- `facilities`: id, facility_type (HOSPITAL, BLOOD_BANK), name, registration_no, contact, address, location geography, verification_status (PENDING, UNDER_REVIEW, VERIFIED, REJECTED), status (ACTIVE, SUSPENDED), created_by. Unique (id, facility_type) to support composite foreign keys. **Verification and suspension are separate columns** (API.md 11.1): suspending a facility changes only `status`, so `verification_status` is kept as recorded and reinstatement restores the facility exactly as it was. Operational actions require `verification_status = VERIFIED` and `status = ACTIVE`.
- `hospitals`: facility_id PK, facility_type (CHECK = 'HOSPITAL'), hospital-specific fields (emergency services flag etc.). Composite FK (facility_id, facility_type) to `facilities(id, facility_type)`, so a hospital row can only point at a HOSPITAL facility.
- `blood_banks`: same shape with facility_type = 'BLOOD_BANK'.
- `facility_verifications`: facility_id FK, registration metadata, status, reviewed_by, reviewed_at. Metadata only in v1.

Foreign keys by consumer:
- Anything that can belong to any facility (`blood_units.facility_id`, `donation_history.facility_id`, `facility_memberships.facility_id`, `inventory_reservations`, `blood_unit_events`) references `facilities(id)`.
- Anything that must be a hospital (`blood_requests.hospital_id`) references `hospitals(facility_id)`. A request cannot point at a blood bank.
- Anything that must be a blood bank references `blood_banks(facility_id)`.

`facilities` is used rather than two unrelated tables because most facility-owned records (inventory, memberships, donation records, verification) are identical for both types, and the type-specific constraint is kept by the composite foreign key.

### 2.3 Donors and donation history
- `donors`: user_id (unique), blood_group, verification_status, availability_status, availability_until, next_eligible_donation_at (derived copy, see 2.4), current_eligibility_calc_id FK, self_reported_eligibility, last_active_at, status (ACTIVE, SUSPENDED, ANONYMIZED).
- `donor_verifications`: donor_id, id_type, id_last4, id_name, status (PENDING, UNDER_REVIEW, VERIFIED, REJECTED), reviewed_by, reviewed_at, notes. Full ID numbers are never stored. `donors.verification_status` uses the same four values. Suspension is `donors.status` and is never a verification value (API.md 11.1).
- `donor_locations`: see section 9.
- `eligibility_rules`: rule_key (MIN_AGE or MAX_AGE; no other keys in v1), value_int, effective_from, effective_to (nullable), source_note, entered_by, created_at. Age is computed from `user_profiles.date_of_birth` when checked. Effective ranges may not overlap for the same rule_key (exclusion constraint, btree_gist). As with donation intervals, no value is invented or seeded: an admin enters it from the official or facility rule.

`donation_history` (append-only except verification fields):

| Column | Notes |
|---|---|
| id, donor_id | FK donors, RESTRICT |
| donation_type | v1: whole blood |
| donated_at | CHECK not in the future |
| source | SELF_REPORTED, REQUESTER_CONFIRMED, FACILITY_RECORDED |
| facility_id | FK facilities, nullable only when source = SELF_REPORTED |
| request_id | nullable FK blood_requests |
| recorded_by | FK users. Required for FACILITY_RECORDED and REQUESTER_CONFIRMED |
| verification_status | UNVERIFIED, VERIFIED, REJECTED |
| verified_by, verified_at | Required when VERIFIED |
| created_at | |

Constraints: `FACILITY_RECORDED` requires facility_id and recorded_by. `VERIFIED` requires verified_by and verified_at. A trigger enforces that a FACILITY_RECORDED row is inserted VERIFIED only when recorded_by has an ACTIVE membership in that facility and the facility is VERIFIED and ACTIVE (not suspended). Rows are never deleted for eligibility reasons; a wrong record is marked REJECTED and the eligibility is recomputed.

**The three sources are not equivalent.**

| Source | Meaning | Starts as | Can move `next_eligible_donation_at`? |
|---|---|---|---|
| FACILITY_RECORDED | Staff of a verified facility recorded the donation | VERIFIED | Yes |
| REQUESTER_CONFIRMED | The requester confirmed a donor donated (platform fulfilment step) | UNVERIFIED | Only after verification by facility staff (e.g. the hospital co-confirmation flag) or an admin |
| SELF_REPORTED | Donor's own claim | UNVERIFIED | Only after verification by facility staff or an admin |

Rule: only rows with `verification_status = 'VERIFIED'` are eligibility evidence and can move `next_eligible_donation_at` later. UNVERIFIED and REJECTED rows are retained as information and never make a donor eligible or extend eligibility on their own.

Decided for v1: there is no conservative hold. An UNVERIFIED self-reported donation does not by itself change `next_eligible_donation_at` and does not make the donor ineligible. It stays retained information until it is verified (then it is eligibility evidence like any VERIFIED row) or rejected. Requester-confirmed donations follow the same rule: they become eligibility evidence only after facility or admin verification, which matches the Phase 0 hospital co-confirmation decision. No setting for a self-reported hold is built in v1.

### 2.4 Auditable eligibility calculation
- `donation_interval_rules`: id, donation_type, min_interval_days, effective_from, effective_to (nullable), scope (OFFICIAL, FACILITY), facility_id (nullable FK, set when scope = FACILITY), source_note, entered_by, created_at. The interval values are entered by an admin from the official or facility rule. No value is invented or defaulted anywhere in code or seed. Rows are immutable once referenced by a calculation: a change is a new row with a new effective range, and the old row is closed by setting effective_to. An exclusion constraint (btree_gist, `daterange` per donation_type and scope) prevents overlapping effective ranges.
- `donor_eligibility_calculations` (append-only):

| Column | Purpose |
|---|---|
| id, donor_id | |
| trigger | DONATION_VERIFIED, DONATION_REJECTED, RULE_CHANGED, DAILY_JOB, MANUAL_RECHECK |
| source_donation_id | FK donation_history, the verified donation used. Null when the outcome is NO_DONATION |
| source_donated_at | Copied value |
| rule_id | FK donation_interval_rules, the exact rule row selected (the longest applicable interval, see precedence below). Null when NO_RULE |
| considered_rule_ids | uuid[]: every applicable rule row that was compared, so the audit shows what was passed over and why |
| interval_days_used, rule_scope_used, rule_effective_from, rule_effective_to, rule_source_note | Copied values of the selected rule, so the audit trail survives even if the rule table is later reorganised |
| outcome | COMPUTED, NO_DONATION (no verified donation, no wait applies), NO_RULE (ineligible, fail closed) |
| next_eligible_at | Result, null unless COMPUTED |
| status | CURRENT, SUPERSEDED |
| computed_at | |

A partial unique index allows one CURRENT row per donor. `donors.next_eligible_donation_at` and `donors.current_eligibility_calc_id` are a denormalised copy of the CURRENT row, written in the same transaction, so matching queries stay a single indexed column check. If the two ever disagree, the calculation row is the source of truth and the daily job repairs the donor row.

Calculation:
1. Take the donor's latest VERIFIED donation of the donation type.
2. Collect the applicable rules **effective at calculation time** (`effective_from <= now` and `effective_to` null or in the future): the OFFICIAL rule for that donation type, plus any FACILITY rule for that donation type belonging to the facility that recorded the source donation.
3. **Precedence: when both OFFICIAL and FACILITY rules apply, use the most restrictive, meaning the longest, interval.** On an exact tie the OFFICIAL rule is recorded as the selected one, so the result is deterministic.
4. Set `next_eligible_at = source_donated_at + interval_days_used`, and store the selected rule, all considered rules and the copied rule values in the calculation row.
5. With no applicable rule the outcome is NO_RULE and the donor is treated as ineligible (fail closed).

Timing: the rule is the one effective when the calculation runs, not the one in force on the donation date. A calculation is therefore a snapshot of that moment, and the preserved rule values make it reproducible.

Recompute triggers: a new or closed rule row in `donation_interval_rules` recomputes every donor whose latest verified donation is of the affected donation type (for FACILITY rules, of the affected facility) (trigger RULE_CHANGED); a donation being verified or rejected (DONATION_VERIFIED, DONATION_REJECTED); and the daily job, which also catches rules whose `effective_from` or `effective_to` date has been reached since the last run (DAILY_JOB). A recompute can move `next_eligible_at` earlier or later, and the previous row becomes SUPERSEDED, never edited or deleted.

### 2.5 Blood and inventory
- Enums `blood_group` (A_POS, A_NEG, B_POS, B_NEG, AB_POS, AB_NEG, O_POS, O_NEG) and `blood_component` (v1: WHOLE_BLOOD, RBC).
- `compatibility_rules`: component, recipient_group, donor_group, effective_from/to, source_note. Data-driven and unit-tested. Values come from an authoritative source and are not embedded in code.
- `blood_units`:

| Column | Notes |
|---|---|
| id | Internal UUID |
| unit_uid | Globally unique traceable identifier (system-issued, immutable, printable/barcode-able). UNIQUE, NOT NULL |
| facility_unit_code | The facility's own bag or unit number. UNIQUE (facility_id, facility_unit_code) |
| facility_id | FK facilities. Current custodian |
| origin_facility_id | FK facilities. Where it was collected. Immutable |
| source_donation_id | Nullable FK donation_history |
| blood_group, component | |
| collected_at, expires_at | CHECK expires_at > collected_at |
| status | AVAILABLE, RESERVED, ISSUED, EXPIRED, DISCARDED |
| active_reservation_id | Nullable FK inventory_reservations. UNIQUE. Set if and only if status = RESERVED |
| storage_location | |

CHECK: `(status = 'RESERVED') = (active_reservation_id IS NOT NULL)`.

- `blood_unit_events` (append-only custody trail): unit_id, event (RECEIVED, RESERVED, RELEASED, ISSUED, TRANSFERRED, EXPIRED, DISCARDED), from_facility_id, to_facility_id, request_id, actor_id, at. Together with `unit_uid` this gives end-to-end traceability. A transfer changes `facility_id` and writes an event.
- `inventory_reservations`: id, unit_id FK, request_id FK, status (ACTIVE, RELEASED, ISSUED, EXPIRED), reserved_by, reserved_at, expires_at, released_at, release_reason. **Partial unique index on (unit_id) WHERE status = 'ACTIVE'**: a unit can never have two active reservations, whatever the application code does.

### 2.6 Requests
- `blood_requests`: requester_id (FK users), patient_id (FK patients), hospital_id FK hospitals(facility_id), blood_group, component, units_required, required_donors, urgency (open decision, see the next bullet), is_emergency, required_by, reason_category, contact_phone, contact_person, additional_info, location, status, expires_at, created_at, updated_at. The requester and the patient are separate columns (API.md 6.1). `reason_category` is the value chosen from the configured list, `contact_phone` and `contact_person` are the API.md `contact`, and `additional_info` is the short free text. These four are nullable, and their required-ness and length limits are enforced by the API validator. `location` is a copy of the hospital's location, set by the server when the request is created and never accepted from the client. `contact_phone`, `contact_person` and `additional_info` are redacted on anonymization (section 8).
- **Open decision, `urgency`:** the set of urgency levels is not defined in any document. Until it is decided, the schema creates no urgency enum and no urgency-specific setting, the column is nullable text with no CHECK, and no seed data uses it. When the taxonomy is decided, a later migration adds the enum or CHECK and the API validator uses the same list. `is_emergency` is unaffected.
- `blood_request_status_history`: request_id, from_status, to_status, actor_id, reason, at.
- `request_transitions`: from_status, to_status, allowed_roles. Backs the state machine (section 4).
- `request_events`: request_id, match_id (nullable FK `donor_matches`), event_type (DONOR_ARRIVED, DONOR_DROPPED, ETA_UPDATED, VERIFICATION_RESULT, NOTE), actor_id, at, details jsonb. Timeline entries only. Events never change a status by themselves. Recording an arrival, for instance, adds a `DONOR_ARRIVED` event and sets `donor_matches.arrived_at` while the match stays CONFIRMED. A drop adds a `DONOR_DROPPED` event and sets `drop_reason` and `dropped_by` on the match.
- `request_flags`: rule-based suspicion flags for admin review.

### 2.7 Matching, ranking and ML
- `donor_searches`: request_id (unique), config_snapshot jsonb, status (ACTIVE, FULFILLED, EXHAUSTED, CANCELLED, EXPIRED), required_donors, confirmed_count, batch_count. CHECK confirmed_count <= required_donors.
- `notification_batches`: id, search_id, batch_number, opened_at, expires_at, status (PENDING, ACTIVE, EVALUATED, CANCELLED), ranking_run_id. Unique (search_id, batch_number). Unique (id, search_id) for composite FKs. **Partial unique index on (search_id) WHERE status = 'ACTIVE'**: at most one open batch per search.
- `ranking_runs`: id, search_id, ranker_type (ML, FALLBACK), model_version, ranked_at, trigger_type (INITIAL, BATCH_ADVANCE, CANDIDATE_SET_CHANGED, INPUTS_CHANGED, MODEL_CHANGED, FRESHNESS_EXPIRED), input_count. One row per ranking execution. `ranked_at` supports the freshness window in ARCHITECTURE.md.
- `ranking_predictions` (renamed from `ml_predictions`, approved; append-only; the sole source of the prediction and `feature_snapshot` used for ranking and contact): id, ranking_run_id, donor_id, rank, score, reasons jsonb, feature_snapshot jsonb, created_at. Unique (ranking_run_id, donor_id). Contains fallback rankings too, identified by the run's ranker_type and model_version.
- `donor_matches`: see section 6.
- `donor_responses`: append-only log (match_id, response, responded_at, latency_seconds). `response` is one of ACCEPTED, DECLINED, NO_RESPONSE, EXPIRED (the label set in ML.md section 2); WAITLISTED is still recorded as ACCEPTED. It records only the donor's own answer and the outcome of the response window. **No drop of any kind writes a row here**: a system drop (REVALIDATION_FAILED, NOT_ELIGIBLE_AT_ACCEPT), a hospital, owner or admin drop, and a donor withdrawal are recorded by `drop_reason` and `dropped_by` on the match, a `DONOR_DROPPED` event, the status history and the audit log. A donor's DECLINED answer is a response and is recorded here. A later donor withdrawal from an accepted or confirmed match is a drop and is recorded only through the match's drop fields, the `DONOR_DROPPED` event, the status history and the audit log.
- `ml_model_versions`: model_version, algorithm, dataset_version, features_used, metrics jsonb, trained_at, artifact_ref, status (CANDIDATE, ACTIVE, RETIRED), activated_at, activated_by (FK users). Activation is a reviewed manual action; a CHECK requires both `activated_at` and `activated_by` to be set whenever status is not CANDIDATE.

### 2.8 Platform
`notifications` (including a nullable `request_id` FK to `blood_requests`, a nullable `match_id` FK to `donor_matches` and a nullable `read_at`; `read_at` is the in-app "seen" time that ML.md calls `seen_at`, and `notification_deliveries.status` is its `delivery_status`), `notification_deliveries` (channel, provider, status, error), `settings` (key, value jsonb, scope, urgency, updated_by; `scope` is reserved and NULL in v1, `urgency` is nullable text until the open urgency decision is made, and a row with both NULL is the global default), `audit_logs` (actor_id, action, entity_type, entity_id, correlation_id, details jsonb, at; `correlation_id` carries API.md 1.2's `X-Request-ID`), `webhook_events` (provider, provider_event_id, event_type, received_at, processed_at, last_error; unique provider event id), `analytics_daily` (deferred, not yet implemented), `location_access_logs` (section 9), `data_deletion_requests` (user_id, source (USER_REQUEST, CLERK_WEBHOOK), status (PENDING, COMPLETED), legal_hold, completed_at; section 8; a CHECK ties `status = COMPLETED` to `completed_at` being set, and another forbids COMPLETED while `legal_hold` is true), and `idempotency_keys` (key, user_id, request fingerprint, stored response reference, created_at, expires_at; unique per (user_id, key); `expires_at` is a stored absolute expiry set when the record is created, from whatever retention period is configured in `settings` at that time), which backs the `Idempotency-Key` header in API.md.

## 3. Indexes

Blood group, component, donor verification and availability status, `next_eligible_donation_at`, request status, urgency, `created_at`, `expires_at`, facility ids, unit expiry and status, `donation_history (donor_id, verification_status, donated_at DESC)`. GiST on every geography column. Partial indexes for hot paths: eligible donors (`verification_status='VERIFIED' AND availability_status='AVAILABLE'`), active requests, open batches, ACTIVE reservations, CURRENT eligibility calculations. Composite (search_id, status) on `donor_matches`. All unique indexes named above.

## 4. Request state machine

States: DRAFT, SUBMITTED, VERIFICATION_PENDING, ACTIVE, DONOR_SEARCH, DONOR_CONTACTED, DONOR_ACCEPTED, DONOR_CONFIRMED, FULFILLED. Terminal: CANCELLED, EXPIRED, REJECTED.

| From | To |
|---|---|
| DRAFT | SUBMITTED, CANCELLED |
| SUBMITTED | VERIFICATION_PENDING (normal), ACTIVE (emergency fast path), REJECTED, CANCELLED |
| VERIFICATION_PENDING | ACTIVE, REJECTED, CANCELLED, EXPIRED |
| ACTIVE | DONOR_SEARCH, FULFILLED (inventory-only), CANCELLED, EXPIRED |
| DONOR_SEARCH | DONOR_CONTACTED, CANCELLED, EXPIRED |
| DONOR_CONTACTED | DONOR_SEARCH (next batch), DONOR_ACCEPTED, CANCELLED, EXPIRED |
| DONOR_ACCEPTED | DONOR_CONFIRMED, DONOR_CONTACTED (acceptor dropped), CANCELLED, EXPIRED |
| DONOR_CONFIRMED | FULFILLED, DONOR_SEARCH (confirmed donor dropped, no waitlist), CANCELLED, EXPIRED |

Terminal states have no outgoing transitions. When the pool is exhausted the state stays DONOR_SEARCH and requester and admin are notified.

Enforcement: all changes go through `requestStateMachine.transition`, which checks `request_transitions`; a trigger on `blood_requests` rejects any status change not in that table; history and audit rows are written in the same transaction. Request status is the authoritative lifecycle state. Donor-match and batch statuses are sub-process states, and only the state machine writes `blood_requests.status`. See ARCHITECTURE.md section 5.

## 5. Concurrency-safe donor acceptance (unchanged)

```
BEGIN;
  SELECT ... FROM donor_searches WHERE id = $search FOR UPDATE;   -- serialises acceptors per search
  SELECT status FROM donor_matches WHERE id = $match FOR UPDATE;  -- must be NOTIFIED and window open
  if search.status <> ACTIVE          -> WAITLISTED (or rejected if closed)
  elif confirmed_count < required     -> match = CONFIRMED; confirmed_count += 1
  else                                -> match = WAITLISTED
  if confirmed_count = required       -> search = FULFILLED; request transition; cancel outstanding NOTIFIED
  INSERT donor_responses, status history, audit_logs;
COMMIT;
```

Safeguards: unique (search_id, donor_id); CHECK `confirmed_count <= required_donors`; the server assigns CONFIRMED or WAITLISTED. Waitlist promotion takes the same lock and promotes by rank. A test with N parallel accepts and `required=2` must yield exactly 2 CONFIRMED.

## 6. `donor_matches`: batch lifecycle and constraints

Columns: id, search_id, donor_id, batch_id (nullable), selected_prediction_id, status, distance_km, eta_minutes, fatigue_bypass (bool), exclusion_reason, notified_at, responded_at, arrived_at (nullable), location_consent_at (nullable), drop_reason (nullable), dropped_by (nullable FK users, RESTRICT), created_at, updated_at.

Unique (search_id, donor_id): **one match row per donor per search**. Since a match has one `batch_id`, a donor can belong to at most one batch of a request and can never be contacted twice for it.

`batch_id` lifecycle:
1. CANDIDATE or EXCLUDED: `batch_id IS NULL`. The donor has been ranked but not contacted, or dropped out of re-validation.
2. When a batch opens, one transaction (holding the `donor_searches` row lock) creates the batch, and for each selected match sets `batch_id`, status NOTIFIED and `notified_at`. Only CANDIDATE rows can be selected (`WHERE status = 'CANDIDATE' AND batch_id IS NULL`), which is what prevents re-selection.
3. After that `batch_id` is immutable (a trigger rejects any change). Later statuses (ACCEPTED, CONFIRMED, WAITLISTED, DECLINED, NO_RESPONSE, EXPIRED, DROPPED, COMPLETED) keep it.

Constraints:
- CHECK: `status IN (CANDIDATE, EXCLUDED)` implies `batch_id IS NULL`; every other status implies `batch_id IS NOT NULL AND notified_at IS NOT NULL`.
- Composite FK `(batch_id, search_id)` to `notification_batches(id, search_id)`: a match can only reference a batch of its own search.
- `selected_prediction_id` is set at batch selection (section 7).
- Batch closing (EVALUATED or CANCELLED) resolves or cancels its recipients in the same transaction, so a closed batch never has a NOTIFIED recipient.

Across different requests a donor may hold NOTIFIED matches in several searches. That is governed by the fatigue cap, not by this constraint.

### New columns (revision 3)

- `arrived_at`: set once by the hospital arrival action (API.md 6.4) and never overwritten. The status does not change. CHECK: `arrived_at IS NULL OR status IN ('CONFIRMED', 'COMPLETED', 'DROPPED')`.
- `location_consent_at`: when the donor consented to share their exact location with the request's hospital for this match (section 9). NULL means no consent, and exact location is then never released. CHECK: `location_consent_at IS NULL OR batch_id IS NOT NULL`. The way a donor grants or withdraws consent is deferred (section 13, A4).
- `drop_reason` and `dropped_by`: CHECK `(status = 'DROPPED') = (drop_reason IS NOT NULL)` and `dropped_by IS NULL OR status = 'DROPPED'`. `dropped_by` is NULL when the system dropped the donor. `drop_reason` is an upper-case code whose allowed values are defined by the API validator. Known codes: REVALIDATION_FAILED (API.md 6.5) and NOT_ELIGIBLE_AT_ACCEPT (section 13, A1).
- `exclusion_reason` is required exactly when the status is EXCLUDED: CHECK `(status = 'EXCLUDED') = (exclusion_reason IS NOT NULL)` (ARCHITECTURE.md section 4).
- ACCEPTED stays in the status list. The acceptance transaction in section 5 sets CONFIRMED or WAITLISTED directly (section 13, A3).
- No drop writes a `donor_responses` row (section 2.7).

## 7. `ranking_predictions` versus `donor_matches`

They have distinct purposes and there is a single source of truth for the score.

| | `ranking_predictions` | `donor_matches` |
|---|---|---|
| Is | Append-only record of what a ranker output, for a donor, in one ranking run | The donor's live state in a search |
| Cardinality | Many per donor per search (each re-rank makes a new row) | Exactly one per donor per search |
| Holds | score, rank, reasons, `feature_snapshot`, run's model_version and ranker_type | status, `batch_id`, ETA, timestamps, and `selected_prediction_id` |
| Used for | Audit, explainability, training dataset, model comparison | Workflow and dashboards |

`donor_matches.selected_prediction_id` points to the prediction row that actually caused the donor to be contacted: the one from the ranking run attached to the batch the donor was selected in. That row is the prediction "used for contact". Earlier predictions for the same donor, and predictions for donors never contacted, remain for audit and retraining. `donor_matches` has no separate copies of score or model_version, so the two cannot disagree. Read paths join through `selected_prediction_id`. A view may present rank and score for convenience.

Training labels come from `donor_responses` joined to the selected prediction. Features are frozen in the prediction row at ranking time, so training data never contains information from after ranking.

## 8. PII retention and anonymization versus historical records

Principle: a deleted user is anonymized, not hard-deleted, so evidentiary and operational history stays intact and no foreign key is ever cascaded from `users`.

Flow: Clerk `user.deleted` (or a user's deletion request) creates a `data_deletion_requests` row and sets `users.status = DELETION_PENDING`. A job then, after any legal hold check, in one transaction:
- Removes or overwrites PII: `user_profiles` (name, email, phone, phone_verified_at, date_of_birth, address), `donor_locations` (exact and coarse), `donor_verifications` (id_last4, id_name), patient names, contact fields and `additional_info` on requests, notification content, Clerk link (`clerk_user_id` cleared). Sets `users.status = ANONYMIZED`, `anonymized_at`, and `donors.status = ANONYMIZED` so the donor is excluded from matching.
- Keeps, with the now pseudonymous user/donor/patient id: `donation_history`, `donor_eligibility_calculations`, `blood_requests` and their status history and timeline (patient fields redacted), `donor_matches`, `donor_responses`, `ranking_predictions` (contain no direct PII and no coordinates), `blood_unit_events`, `inventory_reservations`, `audit_logs`.

Rules:
- All foreign keys to `users`, `donors` and `patients` from history tables are RESTRICT. A hard delete of a user is blocked by design and used only for records that never gained evidentiary or operational history (for example an abandoned sign-up).
- `audit_logs` and history tables store ids and action codes, not PII payloads, so anonymization does not require editing them.
- Retention periods for each class (audit logs, donation records, requests, notification content, deletion-request records) are settings, not constants. The values are decided with appropriate legal or compliance input for India (for example DPDP Act obligations) and are not fixed in this document. A legal-hold flag on a deletion request pauses anonymization of the affected records.
- Notification cleanup, expired-request PII redaction, and stale unverified sign-up purge run in the daily job.

## 9. Location tiers and authorization

Tiers:
1. **Exact** (`donor_locations.location_exact`): used only by server-side matching and ETA code. Never returned to patients or public users, and not returned by any patient-facing or public endpoint or query.
2. **Coarse** (`donor_locations.location_coarse`): snapped to a fixed grid (about 1-2 km) at write time. It is not random noise applied on read, since repeated queries would defeat that. Used for privacy-safe markers and distance bands.
3. **Facility locations** (`facilities.location`): public for VERIFIED facilities.

`donor_locations`: donor_id (PK, FK), location_exact, location_coarse, updated_at. Exact and coarse are in a table separate from `donors`, so common donor queries never load exact coordinates by accident.

`location_access_logs`: id, accessor_id (FK users, RESTRICT; the person who performed the read), donor_id (FK donors, RESTRICT), request_id (nullable FK blood_requests), purpose (upper-case code, for example HOSPITAL_ARRIVAL or ADMIN_REVIEW), at. Append-only; written for every exact-location read (see the last bullet below).

Who sees what:
- Patients, requesters, public users: coarse location, or a distance/ETA band ("about 2-3 km, 10-15 minutes"), only for donors relevant to their request. Donor identity is not revealed until the donor is CONFIRMED and then only the minimum contact data needed.
- Authorized facility personnel: an ACTIVE `facility_memberships` member of the request's hospital may see a donor's exact location only when operationally necessary and only if all hold: the donor's match for that request is CONFIRMED, the hospital is VERIFIED and ACTIVE, and the donor has explicitly consented to share (stored on the match as `location_consent_at`, section 6). Otherwise they see coarse location and ETA. Until the consent mechanism is defined (section 13, A4), `location_consent_at` stays NULL, so no exact location is released.
- Admins: no default access to exact donor location. Any exception is an audited action.
- Every exact-location read by a person is written to `location_access_logs` (who, donor, request, purpose, at) and to `audit_logs`.

Enforcement in layers: separate table, a coarse-only view used by patient/public repositories, and a dedicated repository function for the exact read that performs the checks above. Patient-facing code has no import path to the exact column. Tests assert that no patient-facing endpoint response contains exact coordinates.

## 10. Concurrency-safe inventory reservation

Reserving a unit must be race-free in the same way donor acceptance is.

```
BEGIN;
  SELECT ... FROM blood_requests WHERE id = $request FOR UPDATE;     -- serialises per request
  -- units already ACTIVE or ISSUED for this request are counted under the lock
  if request is terminal or reserved+issued >= units_required        -> reject
  SELECT ... FROM blood_units WHERE id = ANY($units) ORDER BY id FOR UPDATE;
  for each unit, require:
     status = AVAILABLE AND expires_at > now() + minimum shelf buffer (setting)
     compatible with the request (compatibility service and rules)
     facility_id = the acting user's facility (active membership)
  INSERT inventory_reservations (status ACTIVE, expires_at);
  UPDATE blood_units SET status = RESERVED, active_reservation_id = ...;
  INSERT blood_unit_events, audit_logs;
COMMIT;
```

Safeguards, layered so a bug in one still cannot double-reserve:
1. Row lock on the unit (`FOR UPDATE`) serialises competing reservations. Multi-unit calls lock units in id order to avoid deadlocks. Global lock order: search or request row first, then unit rows in id order.
2. Partial unique index on `inventory_reservations (unit_id) WHERE status = 'ACTIVE'`.
3. `blood_units.active_reservation_id` is UNIQUE, and the CHECK ties it to status = RESERVED.
4. Conditional updates (`... WHERE status = 'AVAILABLE'`) verify the affected row count; zero rows means the unit was taken, and the request gets a CONFLICT.
5. The request-level count under the request lock stops over-reserving beyond `units_required`.

Release and expiry: an ACTIVE reservation with a passed `expires_at`, a cancelled request, or a manual release moves the reservation to RELEASED or EXPIRED and the unit back to AVAILABLE in one transaction, using `FOR UPDATE SKIP LOCKED` in the job so overlapping runs are safe. Issuing moves reservation to ISSUED and unit to ISSUED, and the request-level effect goes through `requestStateMachine`. A unit that expires while RESERVED is marked EXPIRED and its reservation EXPIRED, and the request's facility is notified. Every step writes `blood_unit_events` and audit rows.

Test: N parallel reserve calls against one unit must produce exactly one ACTIVE reservation; parallel reserves for one request must never exceed `units_required`.

## 11. Seed data, environments and migrations

**Environments.** Two Neon branches, neither of them production. `dev` holds development data: the reference seed and the demo seed. `test` is used only by automated constraint, concurrency and migration tests and receives no seed data.

**Reference seed** (idempotent). It contains only what the documents state:
- `roles`: PATIENT, DONOR, ADMIN, SUPER_ADMIN.
- `request_transitions`: the table in section 4, with the actors from API.md 6.7.
- `settings`, documented values only (`scope` and `urgency` NULL). The key names are a naming proposal, and the values come from ARCHITECTURE.md sections 3 and 4:

| Key | Value |
|---|---|
| `batch.size` | 20 |
| `batch.response_window_minutes` | 10 |
| `batch.max_count` | 5 |
| `request.expiry_hours.standard` | 24 |
| `request.expiry_hours.emergency` | 6 |
| `fatigue.max_notifications` | 3 |
| `fatigue.window_hours` | 24 |

Not seeded, because no document gives a value: the ranking freshness window, the emergency response window, the reservation expiry, the minimum shelf buffer, the maximum `required_donors`, reason categories, retention periods, maps and ETA settings, and every urgency-specific setting. Until a value is configured, the feature that needs it must not run on a guessed value. How each feature behaves without its setting is decided when that feature is implemented.

**Demo seed** (`dev` only, never production). Flagged `is_demo`, names prefixed "DEMO", emails on the reserved `example.invalid` domain, obviously fake phone numbers and identifiers, no real person or facility. It covers demo patients, donors, hospitals, blood banks, blood units and donation history. It contains no blood requests, because the urgency taxonomy is an open decision.

**No medical rule values are seeded, not even as placeholders.** Blood compatibility rules, donation-interval rules and age rules are entered only from an authoritative source that you provide. Until then `compatibility_rules`, `donation_interval_rules` and `eligibility_rules` are empty, and the fail-closed behavior in section 2.4 applies to intervals (no applicable rule means the donor is treated as ineligible).

**Migration policy.** Migrations are forward-only and reviewed before they are applied. `drizzle-kit push` is never used. Scripts print the target host and database name (never credentials) and refuse to run unless the target is explicitly confirmed and `NODE_ENV` is not production. The first contact with a database is a read-only probe.

## 12. Resolved decisions

1. **Interval precedence (confirmed):** when OFFICIAL and FACILITY rules both apply, the longest interval wins; ties select the OFFICIAL rule. The selected rule and all considered rules are preserved in `donor_eligibility_calculations`.
2. **Rule timing (confirmed):** the rule effective at calculation time is used. Relevant rule changes and rules reaching their effective dates trigger a recompute. The rule snapshot is stored with every calculation.
3. **Unverified self-reported donation (confirmed):** no conservative hold in v1. It does not change `next_eligible_donation_at` or make a donor ineligible until verified or rejected.
4. **Requester-confirmed donation (confirmed):** becomes eligibility evidence only after facility or admin verification.
5. **`ranking_predictions` (confirmed):** the rename is approved. It is the source of the prediction and feature snapshot used for ranking and contact. ML.md and ARCHITECTURE.md are updated to match.

One assumption I made to make decision 1 executable, not yet confirmed by you: a FACILITY rule is "applicable" to a donor's calculation when it belongs to the facility that recorded the donor's latest verified donation. Rules of the request's hospital are not part of the donor-level calculation in v1. Please confirm or correct this.

## 13. Phase 3 reconciliation decisions

Approved before schema work began. API.md is unchanged.

- **A1:** a donor who is no longer eligible when they accept is recorded as status DROPPED with `drop_reason = 'NOT_ELIGIBLE_AT_ACCEPT'` and `dropped_by` NULL (the API.md 5.2 outcome `DONOR_NOT_ELIGIBLE`).
- **A2:** no drop writes a `donor_responses` row (section 2.7).
- **A3:** ACCEPTED stays in the match status enumeration. No constraint depends on it. Whether it is ever stored as a resting status is decided with the acceptance service.
- **A4:** the endpoint or field by which a donor grants consent to share exact location, and whether consent can be withdrawn, are deferred to the donor and match endpoints. Until then `location_consent_at` stays NULL.
- **B1 to B9 and the seed and environment decisions:** as written in sections 2.1 to 2.8 and 11.

Open decisions (nothing is invented for them):
- The urgency taxonomy: the levels, and how urgency relates to `is_emergency` and to the per-urgency settings.
- How the age rules behave when no MIN_AGE or MAX_AGE rule is configured.
- Authoritative sources for compatibility rules, donation intervals and age rules.
- Values for the settings listed as not seeded in section 11.
- The unconfirmed assumption at the end of section 12 (which FACILITY interval rules apply to a donor's calculation).

API.md wording to align when API.md may next be edited (not edited now; this document governs until then):
- 6.5's pseudo-SQL lists `donor_responses` among the rows a drop inserts. Read it as the drop's event, status-history and audit rows (A2).
- 5.2 says an ineligible accept "marks the match accordingly". A1 defines what that means.
- `location_consent_at` has no way to be set in API.md yet (A4).
