# BloodBridge AI: API design (Phase 1 draft, revision 2)

Design only. No controllers, code or migrations exist yet. This revision aligns the API with the finalized ARCHITECTURE.md and DATABASE.md.

Business endpoints live under `/api/v1`. JSON only. Auth is a Clerk session JWT in `Authorization: Bearer`, verified on the backend for every private route. Authorization is always evaluated from our database, never from JWT claims or client-supplied role data. A request with a valid Clerk session but no synchronized `users` row yet (the `user.created` webhook has not been processed) is `401 UNAUTHENTICATED`, the same as no session at all: there is no local identity yet to authorize (section 4).

## 1. Conventions

### 1.1 Response envelope

```json
{ "success": true, "data": {}, "meta": {} }
{ "success": false, "error": { "code": "DONOR_NOT_ELIGIBLE", "message": "...", "details": [], "requestId": "..." } }
```
`meta` is optional. `error.details` and `error.requestId` are optional.

Error rules:
- `details` is used mainly for validation errors: a list of `{ path, message }` field problems. It never echoes submitted values of sensitive fields.
- Responses never contain stack traces, SQL or driver errors, file paths, secrets, environment values, or sensitive donor information (identity, contact, exact location, eligibility internals). Internal detail goes to server logs only, tagged with the request id.
- Unexpected failures return `INTERNAL_ERROR` with a generic message and the `requestId`, so support can find the log line.

Status and code map: 400 `VALIDATION_ERROR`; 401 `UNAUTHENTICATED`; 403 `FORBIDDEN`; 404 `NOT_FOUND`; 409 `CONFLICT` or `INVALID_STATE_TRANSITION`; 429 `RATE_LIMITED`; 500 `INTERNAL_ERROR`; 503 `SERVICE_UNAVAILABLE`. Domain codes (for example `DONOR_NOT_ELIGIBLE`, `WINDOW_CLOSED`, `ALREADY_RESPONDED`, `ROLE_NOT_SELF_ASSIGNABLE`, `LAST_FACILITY_ADMIN` — 409, refusing to remove a facility's last ACTIVE FACILITY_ADMIN, section 7) use the same envelope with the closest HTTP status. For object-level scoping (a resource belonging to a facility or user the caller has no relation to), the API returns 404 instead of 403 so existence is not leaked.

### 1.2 Request correlation (`X-Request-ID`)
- Every response carries an `X-Request-ID` header.
- If the client sends `X-Request-ID` and it is a valid token (letters, digits, `-`, `_`, at most 64 characters), it is reused. Otherwise the server generates a UUID. It is never used for authorization or trusted for anything else.
- The id is attached to every log line for that request, written on audit rows, forwarded to the ML service in `X-Request-ID`, and included as `error.requestId` in every error response.

### 1.3 Pagination (all list endpoints)
One convention, cursor-based:
- Query: `limit` (integer, default 20, **maximum 100**) and `cursor` (opaque string from the previous page). Optional `sort` only from a per-endpoint whitelist.
- A `limit` above 100 or below 1 is rejected with `VALIDATION_ERROR`, not silently clamped.
- Response: `data.items` (array) and `meta.pageInfo = { limit, nextCursor, hasMore }`. `nextCursor` is null on the last page.
- Ordering is stable and total (sort key plus id) so pages cannot skip or repeat rows. Cursors are signed or opaque and carry no PII.
- Aggregate and single-object endpoints are not paginated.

### 1.4 Other cross-cutting rules
- Every body, query and param is validated with Zod (strict objects: unknown fields are rejected).
- `Idempotency-Key` header accepted on `POST /blood-requests` and other create/confirm operations marked below. The key is stored with the request fingerprint (DATABASE.md `idempotency_keys`) and a repeat with the same key returns the original result.
- Rate limits: strict on request creation, `respond`, `/maps/eta`, and `/blood/availability` (public). CORS allow-list from `FRONTEND_URL`.
- Every mutation on a sensitive resource writes an audit log entry.
- Request status is changed only through intent endpoints that call `requestStateMachine.transition`. There is no generic "set status" endpoint, and match or batch operations never write `blood_requests.status` themselves.

## 2. Authorization model

Notation used in the endpoint tables:

| Notation | Meaning |
|---|---|
| Pub | No authentication |
| Auth | Any signed-in, non-suspended user |
| Role:X | The user has global role X in `user_roles` (PATIENT, DONOR, ADMIN, SUPER_ADMIN only) |
| Owner | The resource belongs to the caller (`requester_id`, the donor's own match, etc.) |
| F:HOSPITAL(x) | Scoped membership check, below |
| F:BLOOD_BANK(x) | Scoped membership check, below |
| F:ADMIN(x) | Scoped membership check, below |

### 2.1 Facility access is derived from `facility_memberships`

Hospital and blood-bank staff are **not** global roles. `user_roles` holds only PATIENT, DONOR, ADMIN, SUPER_ADMIN. Facility access is computed on each request by querying `facility_memberships`:

- **F:HOSPITAL(x)**: the caller has an `ACTIVE` membership in facility `x`, where `facilities.facility_type = 'HOSPITAL'` and `x` is the relevant facility (for a request, `blood_requests.hospital_id`; for a unit or donation record, the facility that owns it).
- **F:BLOOD_BANK(x)**: the same check, with `facility_type = 'BLOOD_BANK'`.
- **F:ADMIN(x)**: F:HOSPITAL(x) or F:BLOOD_BANK(x) with membership `role = FACILITY_ADMIN`. Facility admins can manage staff and profile and approve sensitive facility actions. Plain `STAFF` members can perform operational actions only.
- **Facility state:** operational actions (inventory, verifying requests, recording donations, arrivals) also require `facilities.verification_status = 'VERIFIED'`. A PENDING, UNDER_REVIEW or REJECTED facility can only manage its own profile and verification submission. A SUSPENDED facility is denied every action.
- The facility is always identified from the resource (or a path/body facility id that is then checked), never trusted from the client. A caller who is a member of facility A but not B gets 404 on B's resources.
- Membership is never cached in the JWT. Removing or suspending a member takes effect on the next request.
- Signing up to run a facility only creates a PENDING facility and a FACILITY_ADMIN membership for the creator. It grants no other access.
- ADMIN and SUPER_ADMIN are global roles granted only by the seed bootstrap or by SUPER_ADMIN, never by the self-service API.
- **SUPER_ADMIN inherits every ADMIN permission.** Wherever this document says ADMIN, a SUPER_ADMIN is also allowed and can perform every ADMIN action, subject to the same rules and audit logging as an ADMIN. SUPER_ADMIN additionally holds the SUPER_ADMIN-only actions, such as granting and revoking the ADMIN and SUPER_ADMIN roles (`POST /admin/roles`). An ADMIN does not hold those SUPER_ADMIN-only actions.

### 2.2 Privacy rules that apply to every endpoint
- Donor exact location is never returned to patients, requesters or public users, and appears in no patient-facing or public response (DATABASE.md section 9).
- Patients and requesters see donor counts, anonymous handles ("Donor 1"), coarse location or distance/ETA bands. Once a donor is CONFIRMED they see only the minimum contact information the donor has agreed to share.
- Donors never see patient identity. They see the request's hospital, blood group, component, units, urgency, distance band and deadlines.
- Hospital staff see the identity and contact of donors CONFIRMED for their own hospital's requests only.

## 3. Infrastructure endpoints (outside `/api/v1`, unauthenticated)

| Method | Path | Behavior |
|---|---|---|
| GET | /health | Liveness. Returns 200 `{ "status": "ok" }` if the process is running. Touches no dependency. |
| GET | /ready | Readiness. Checks that configuration loaded and the database answers a trivial query within a short timeout. Returns 200 or 503 with `{ "status": "ready" | "not_ready", "checks": { "database": "ok" | "fail" } }`. The ML service is not a readiness dependency, because the fallback ranker keeps matching available. It reports only ok/fail, never connection strings, versions, hostnames or error text. |

Both are excluded from auth, may be excluded from request logging noise, carry `X-Request-ID`, and use the light rate limit meant for platform probes. They are not part of the versioned API or the response envelope.

## 4. Auth and users

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | /auth/me | Auth | Current user, global roles, active facility memberships, donor and patient verification statuses |
| PATCH | /users/me | Auth | See 4.2 |
| POST | /users/me/roles | Auth | See 4.1 |
| DELETE | /users/me | Auth | See 4.3 |

A Clerk session with no synchronized `users` row yet (see the note above section 1) is `401 UNAUTHENTICATED` on every route in this section, including `/auth/me`.

### 4.1 POST /users/me/roles (self-enrolment)
- Body: `{ "role": "PATIENT" | "DONOR" }`. The client must explicitly choose one. Strict Zod enum; a missing or unknown role is `VALIDATION_ERROR`.
- **Idempotent.** Enrolling in a role the user already has returns 200 with `{ role, enrolled: false }` and changes nothing. A first enrolment returns 201 with `enrolled: true`. Concurrent duplicate calls are safe through the unique (user, role) constraint (conflict is treated as already enrolled).
- **Never allows privileged roles.** `ADMIN`, `SUPER_ADMIN`, and any facility role (HOSPITAL, BLOOD_BANK, FACILITY_ADMIN, STAFF) are rejected with 403 `ROLE_NOT_SELF_ASSIGNABLE`. Facility access comes only through `facility_memberships` (facility creation or invitation), and ADMIN/SUPER_ADMIN only through the bootstrap or SUPER_ADMIN (`POST /admin/roles`).
- Suspended or anonymized users are rejected with 403.
- **Audited:** a first enrolment writes an `ROLE_ENROLLED` audit row (actor = subject = the user, role, requestId). No-op repeats are not audited.

### 4.2 PATCH /users/me
- Body (Zod-validated, strict): `fullName`, `dateOfBirth`, `address`, each optional. Unknown fields are rejected.
- **`email` and `phone` are never accepted here.** Both are Clerk-controlled: they are synchronized only from the `user.created`/`user.updated` webhook (section 12), so this endpoint cannot create a second, disagreeing source of truth for either field. Changing an email or phone number happens through Clerk, and the next webhook delivery syncs it.

### 4.3 DELETE /users/me
- Creates a `data_deletion_requests` row (`source = USER_REQUEST`) and sets `users.status = DELETION_PENDING`. Anonymization runs as a job (DATABASE.md section 8), not a hard delete.
- **Idempotent.** If a request is already `PENDING` for this user (including one created a moment earlier by the Clerk `user.deleted` webhook, `source = CLERK_WEBHOOK`), this returns the existing request instead of creating a second one or erroring.
- **The one exception to the DELETION_PENDING rule above section 1's note:** this specific endpoint accepts a caller whose own status is already `DELETION_PENDING`, precisely so the idempotent repeat call above can succeed. No other endpoint accepts a `DELETION_PENDING` caller.
- **Audited:** a genuinely new pending request writes a `DATA_DELETION_REQUESTED` audit row (actor = the user for `USER_REQUEST`, none/system for `CLERK_WEBHOOK`). An idempotent repeat is not audited again.

## 5. Donors and matches

| Method | Path | Auth | Notes |
|---|---|---|---|
| PUT | /donors/me | Role:DONOR | Create or update donor profile, blood group (self-reported until verified) |
| POST | /donors/me/verification | Role:DONOR | See 5.1 |
| GET | /donors/me/verification | Role:DONOR | Own verification status and reviewer note |
| PATCH | /donors/me/availability | Role:DONOR | AVAILABLE, UNAVAILABLE, TEMPORARILY_UNAVAILABLE (+ `until`) |
| PUT | /donors/me/location | Role:DONOR | Set location. Server writes `donor_locations` and derives the coarse cell. Response never echoes exact coordinates back beyond what the donor just sent |
| GET | /donors/me/requests | Role:DONOR | Paginated. Requests the donor was notified about. Fields and deadlines are defined in 5.3. No patient or requester identity |
| GET | /donors/me/history | Role:DONOR | Paginated donation history including verification status of each record |
| POST | /matches/:matchId/respond | Role:DONOR + Owner | See 5.2 |
| POST | /matches/:matchId/withdraw | Role:DONOR + Owner | The donor drops out of an accepted or confirmed match. Same service and transaction as the drop endpoint (see 6.5). Idempotent |

### 5.1 POST /donors/me/verification
- Body: `{ idType, idLast4, idName }`. `idType` is an enum (Aadhaar, Voter ID, Driving Licence, and others as configured), `idLast4` exactly four digits, `idName` the name as on the document. A full ID number is not accepted: any field that looks like one is rejected by validation, and nothing longer than four digits is ever stored or logged. The UI states this is not UIDAI e-KYC.
- **Effect:** creates or updates the caller's `donor_verifications` record with status `PENDING`. It **does not approve the donor**, and `donors.verification_status` does not become VERIFIED from this call.
- Resubmission: allowed when the record is PENDING or REJECTED (updates it and sets it to PENDING again). If UNDER_REVIEW, returns 409 `CONFLICT`. If already VERIFIED, returns 409 `VERIFICATION_ALREADY_APPROVED`. A SUSPENDED donor gets 403.
- **Approval and rejection are ADMIN actions only** (`POST /admin/verifications/:id/approve` and `/reject`). Phone verification comes from Clerk and is checked separately.
- Audited (`DONOR_VERIFICATION_SUBMITTED`). Idempotent for an identical resubmission.

### 5.2 POST /matches/:matchId/respond
- Body: `{ "response": "ACCEPT" | "DECLINE" }`.
- Allowed only if the match belongs to the caller, its status is NOTIFIED, its batch is ACTIVE and inside the response window, and the request is not in a terminal state. Otherwise `WINDOW_CLOSED`, `ALREADY_RESPONDED` (409) or 404.
- ACCEPT re-checks that the donor is still notifiable (verified, available, not suspended, donation interval, eligibility) before recording anything. A failure returns `DONOR_NOT_ELIGIBLE` and marks the match accordingly.
- The server, never the client, assigns CONFIRMED or WAITLISTED inside the locked transaction of DATABASE.md section 5. The response returns the outcome (`CONFIRMED`, `WAITLISTED`, `DECLINED`).
- Request status may change as a consequence, but only via the state machine inside the same transaction.
- Audited (`DONOR_ACCEPTED_REQUEST`, `DONOR_DECLINED_REQUEST`).

### 5.3 What a donor sees for a request (`GET /donors/me/requests`)

Per item, only these fields are returned:
- Request context: hospital name and public location, blood group, component, units needed, urgency and emergency flag.
- Distance band and estimated travel-time range (estimates, never exact arrival times or coordinates).
- The donor's own response state (`NOTIFIED`, `ACCEPTED`, `CONFIRMED`, `WAITLISTED`, `DECLINED`, `NO_RESPONSE`, `EXPIRED`, `DROPPED`, `COMPLETED`), and, once confirmed, the minimum details needed to reach the hospital.

Deadlines and times visible to a donor (exactly these three):

| Field | Meaning | Source |
|---|---|---|
| `requestedAt` | When the request was created | Request creation time |
| `respondBy` | The last moment this donor can accept or decline. Shown only while their match is NOTIFIED. After that, the state is shown instead of a deadline | The expiry of the notification round the donor was contacted in |
| `requiredBy` | When the hospital needs the blood | The request's required date/time |

Not exposed to donors: the request's internal expiry time, batch numbers or batch size, the donor's rank or score, model or ranker information, how many donors were contacted or have responded, other donors' statuses, the escalation schedule, the response-window setting, or eligibility and ranking explanations. The donor sees one deadline, their own `respondBy`, without the internal mechanism behind it. If the request is cancelled, fulfilled or expired, the item shows that outcome and no deadline. `POST /matches/:matchId/respond` after `respondBy` returns `WINDOW_CLOSED`.

## 6. Patients and blood requests

| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | /blood-requests | Role:PATIENT | Create draft. See 6.1. Supports Idempotency-Key |
| POST | /blood-requests/:id/submit | Owner | DRAFT to SUBMITTED, then in the same transaction to VERIFICATION_PENDING (normal) or ACTIVE (emergency fast path) |
| GET | /blood-requests | Owner / F:HOSPITAL / F:BLOOD_BANK / ADMIN | Paginated, scoped by caller (6.2) |
| GET | /blood-requests/:id | Owner / F:HOSPITAL(request.hospital) / ADMIN | Detail with the caller-appropriate view (6.2) |
| GET | /blood-requests/:id/timeline | Same as detail | Status history and `request_events` |
| GET | /blood-requests/:id/donor-search | Owner / F:HOSPITAL(request.hospital) / ADMIN | Batch and match progress: counts by match status, current batch, ETA bands. No donor identity or location for Owner (see 2.2) |
| POST | /blood-requests/:id/verify | F:HOSPITAL(request.hospital) / ADMIN | See 6.3 |
| POST | /blood-requests/:id/reject | F:HOSPITAL(request.hospital) / ADMIN | Reason required. See 6.3 |
| POST | /blood-requests/:id/cancel | Owner / ADMIN | To CANCELLED from any non-terminal state permitted by the transition table. Closes open batches and matches, releases active reservations |
| POST | /blood-requests/:id/donors/:matchId/arrival | F:HOSPITAL(request.hospital) | See 6.4 |
| POST | /blood-requests/:id/donors/:matchId/drop | F:HOSPITAL(request.hospital) / Owner / ADMIN | See 6.5 |
| POST | /blood-requests/:id/confirm-donation | Owner | See 6.6. Supports Idempotency-Key |
| POST | /donation-history/:donationId/verify | ADMIN, or an ACTIVE member of the facility on the record (6.8) | Verifies a donation record (hospital co-confirmation is this action). Optional |
| POST | /donation-history/:donationId/reject | Same as verify | Marks the record REJECTED. Triggers an eligibility recompute |

Every one of these delegates to `requestStateMachine.transition` where the request status changes, and the caller's permission for that transition is enforced as in 6.7.

### 6.1 POST /blood-requests
- **The requester and the patient are separate.** `requester_id` is always the authenticated user, taken from the token and never accepted from the body. `patient_id` identifies the person who needs blood, and may be the requester or someone else (a family member). This matches DATABASE.md, where `blood_requests` has both `requester_id` and `patient_id`.
- Body:
  - `patient`: one of
    - `{ "forSelf": true }`: the patient record is derived from the requester's own profile (no duplicate data entry), or
    - `{ "existingPatientId": "<uuid>" }`: a patient record previously created by this requester, or
    - `{ "fullName": string, "ageBand": string }`: creates a new minimal patient record for someone else. Only the fields the `patients` table has; no diagnosis, history, or other medical detail is accepted or stored.
  - `hospitalId` (required; must be a VERIFIED hospital, so it references `hospitals`, never a blood bank).
  - `bloodGroup`, `component` (WHOLE_BLOOD or RBC), `unitsRequired`, `requiredDonors` (bounded by a setting), `urgency`, `isEmergency`, `requiredBy`.
  - `reasonCategory` (from a configured list), `contact` (phone, contact person), `additionalInfo` (short free text, length-limited, with a UI warning not to include medical details).
  - No other medical fields are accepted. Unknown fields are rejected.
- Response 201: the request in `DRAFT`, with `requesterId` and `patientId`. Returns a patient-safe view.
- The requester must have Role:PATIENT (self-enrolled through `/users/me/roles`) and must not be suspended.
- Emergency creation is rate-limited more strictly and can raise a `request_flags` entry. It cannot skip the mandatory donor checks (ARCHITECTURE.md 3.2).
- Audited (`REQUEST_CREATED`).

### 6.2 Scoped views
- Owner: their own requests, full request detail, patient-safe timeline.
- F:HOSPITAL(x): requests where `hospital_id = x`, including requester and patient contact needed to act. Confirmed donors' identity and contact for those requests.
- F:BLOOD_BANK(x): an inventory/fulfilment view only, of ACTIVE and later non-terminal requests, so the blood bank can decide on reserving and issuing units. It contains only: request id, blood group, component, units required and units already reserved or issued, urgency and emergency flag, required-by time, request status, and the requesting hospital's name and public facility contact. It **never** exposes requester or patient information (name, contact, age band, relationship, reason category, additional info) and **never** exposes any donor information (identity, contact, location, match or response status, counts of donors). It has no access to `/blood-requests/:id/timeline`, `/donor-search`, or `/donors/:matchId/*`; those return 404 for blood-bank-only callers. Blood-bank staff who need to contact someone do so through the hospital's published facility contact.
- ADMIN: all requests, with donor exact location still excluded (DATABASE.md section 9).

### 6.3 verify and reject
- Normal request: `verify` moves VERIFICATION_PENDING to ACTIVE. `reject` moves it to REJECTED (reason required).
- Emergency fast-path request already ACTIVE (verification runs in parallel): `verify` records the verification result as a `request_events` entry and clears the flag, with no status change. `reject` cannot use REJECTED, because REJECTED is not reachable from ACTIVE states in the state machine, so the request goes to CANCELLED with reason code `VERIFICATION_REJECTED`, all open batches and matches are closed, donors are told, and an admin alert is created.
- Only F:HOSPITAL of the request's own hospital, or ADMIN, may do this. An ADMIN action is audit-logged as `ADMIN_ACTION`.

### 6.4 POST /blood-requests/:id/donors/:matchId/arrival
- Records that the donor arrived at the hospital. **It introduces no new donor-match status.** The match must be CONFIRMED and stays CONFIRMED.
- Effect: sets `donor_matches.arrived_at` (if not already set) and writes a `request_events` row of type `DONOR_ARRIVED` linked to the request and match. No request status change.
- Idempotent: a repeat returns the original timestamp. A match in any other status returns 409 `INVALID_MATCH_STATE`. `matchId` must belong to `:id`, otherwise 404.
- Caller: F:HOSPITAL(request.hospital) with VERIFIED facility. Audited.

### 6.5 POST /blood-requests/:id/donors/:matchId/drop (and donor withdraw)
Body: `{ "reason": <code> }`. Allowed callers: F:HOSPITAL(request.hospital), the request Owner, ADMIN. A donor uses `POST /matches/:matchId/withdraw`, which calls the same service.

The whole operation is one transaction, using the same locking discipline as acceptance (DATABASE.md section 5):

```
BEGIN;
  SELECT ... FROM donor_searches WHERE id = $search FOR UPDATE;    -- same lock as acceptance
  SELECT ... FROM donor_matches WHERE id = $match FOR UPDATE;      -- must be ACCEPTED or CONFIRMED (else idempotent no-op / 409)
  match -> DROPPED (reason, actor); if it was CONFIRMED, confirmed_count -= 1
  loop over WAITLISTED matches ordered by their selected rank:
      revalidate the donor now through the hard pipeline (compatibility, verification,
      availability, donation interval, eligibility rules, exclusions, geographic
      eligibility) and assertNotifiable
      if valid -> match = CONFIRMED, confirmed_count += 1, notification queued; stop when confirmed_count = required
      if not   -> match = DROPPED with reason REVALIDATION_FAILED; continue
  if confirmed_count < required: reopen the search (ACTIVE) so the batch job can contact further donors,
      and request DONOR_CONFIRMED -> DONOR_SEARCH (or DONOR_ACCEPTED -> DONOR_CONTACTED) through the state machine
  INSERT donor_responses / request_events / status history / audit_logs;
COMMIT;
```

- Because the search row is locked first, a concurrent acceptance, another drop, or a job cannot interleave. A concurrent accept sees the updated `confirmed_count`. Two simultaneous drops serialise, and each promotion is validated after the previous one finishes.
- A promoted donor is revalidated **immediately before** being confirmed and notified. A waitlisted donor's earlier acceptance is never trusted. Revalidation uses stored data in the transaction (no external calls while locks are held), so ETA is not recomputed here and cached ETA is reused.
- Notifications for the drop, promotion and (if needed) reopened search are inserted in the same transaction and delivered after commit.
- Idempotent: dropping an already DROPPED match returns 200 with the current state.
- Test: parallel drop and accept calls against one search must never leave `confirmed_count > required_donors`, never promote an ineligible donor, and never promote the same waitlisted donor twice.

### 6.6 POST /blood-requests/:id/confirm-donation
- **What it records:** the requester's confirmation that one or more specific donors donated. Body: `{ "matchIds": [uuid, ...] }`, each of which must be a CONFIRMED match of this request. For each, it creates a `donation_history` row with `source = REQUESTER_CONFIRMED` and `verification_status = UNVERIFIED`, and moves the match to COMPLETED.
- It does **not** by itself move the request to FULFILLED and does **not** change any donor's eligibility, because requester confirmation is not eligibility evidence until a facility or admin verifies it (DATABASE.md section 2.3).
- **When FULFILLED happens:** after recording, the fulfilment evaluator checks the request's criteria (the confirmed donation count has reached `required_donors` for the donor path, or the inventory path has been completed by issuing units). Only if they are satisfied does the same transaction call `requestStateMachine.transition(DONOR_CONFIRMED to FULFILLED)`. Otherwise the request stays in its current state and the response says `fulfilled: false` with the remaining count.
- Response: `{ recorded: [...], fulfilled: boolean, remainingDonors: number }`.
- **Hospital co-confirmation is separate and optional.** Facility staff record it with `POST /donation-history/:donationId/verify`. That verifies the donation record (making it eligibility evidence and triggering an eligibility recompute). Fulfilment of the request does not wait for it.
- Only the Owner may call this, and only while the request is DONOR_CONFIRMED. Idempotent per match through the Idempotency-Key and the match's COMPLETED status. Audited.

### 6.8 Authorization for /donation-history/:donationId/verify and /reject
- The caller must be **either** an ADMIN, **or** an ACTIVE member (`facility_memberships`) of the facility associated with that donation record (`donation_history.facility_id`), where that facility is VERIFIED. Hospital and blood-bank members are both acceptable, but only for the facility on the record. Being a member of some other facility is not enough.
- A record with no facility (a SELF_REPORTED record) can be verified or rejected only by an ADMIN.
- The facility is read from the record on the server, never from the request body or path. A non-admin caller who is not a member of that facility gets 404.
- The same permission applies to both endpoints, and `/admin/donation-history/:id/verify|reject` is the equivalent ADMIN-only route.
- Effect and audit: sets `verification_status` (VERIFIED or REJECTED) with `verified_by` and `verified_at`, triggers an eligibility recompute, and writes an audit row. An already-verified or rejected record returns 409 `CONFLICT` unless the same outcome is repeated, which is a no-op.

### 6.7 Permission check against the state machine

| Transition | Endpoint | Who |
|---|---|---|
| DRAFT to SUBMITTED, then to VERIFICATION_PENDING or ACTIVE | submit | Owner |
| VERIFICATION_PENDING to ACTIVE | verify | F:HOSPITAL(request.hospital), ADMIN |
| SUBMITTED or VERIFICATION_PENDING to REJECTED | reject | F:HOSPITAL(request.hospital), ADMIN |
| Any non-terminal state to CANCELLED | cancel (Owner, ADMIN); emergency rejection after activation (6.3) | Owner, ADMIN, system |
| ACTIVE to DONOR_SEARCH, DONOR_SEARCH to DONOR_CONTACTED, DONOR_CONTACTED to DONOR_SEARCH | Batch service and evaluation job | System only |
| DONOR_CONTACTED to DONOR_ACCEPTED, DONOR_ACCEPTED to DONOR_CONFIRMED | respond (the acceptance transaction) | Donor, through the state machine |
| DONOR_ACCEPTED to DONOR_CONTACTED, DONOR_CONFIRMED to DONOR_SEARCH | drop, withdraw | F:HOSPITAL, Owner, ADMIN, donor |
| DONOR_CONFIRMED to FULFILLED | confirm-donation, only if criteria satisfied | Owner, through the evaluator |
| ACTIVE to FULFILLED (inventory-only) | inventory issue flow | F:HOSPITAL or F:BLOOD_BANK of the issuing facility, through the evaluator |
| Any non-terminal state to EXPIRED | Expiry job | System only |

No user endpoint can trigger a system-only transition. Terminal states accept no further transition: calls return 409 `INVALID_STATE_TRANSITION`.

## 7. Facilities and inventory

| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | /hospitals, /blood-banks | Auth | Self-register. Creates a PENDING `facilities` row plus the specialised row, and the caller becomes FACILITY_ADMIN |
| GET | /hospitals, /blood-banks | Pub | Paginated. VERIFIED facilities only, public fields only |
| GET | /hospitals/:id, /blood-banks/:id | Pub (VERIFIED, public fields) / F:ADMIN(id) (full) | |
| PATCH | /hospitals/:id, /blood-banks/:id | F:ADMIN(id) | Profile update. Verification-relevant changes reset status to UNDER_REVIEW |
| POST | /hospitals/:id/verification, /blood-banks/:id/verification | F:ADMIN(id) | Submit registration metadata. Creates or updates a PENDING record. Does not approve |
| GET | /facilities/:id/staff | F:ADMIN(id) | List staff, every status (INVITED, ACTIVE, REMOVED) |
| POST | /facilities/:id/staff | F:ADMIN(id) | Invite staff by internal `userId` (see note below). Creates an INVITED membership, which grants no access until accepted |
| POST | /facilities/:id/staff/accept | Auth | The invited user accepts their own INVITED membership, which becomes ACTIVE. No one may accept on another user's behalf. Idempotent if already ACTIVE; 409 `CONFLICT` if the membership was REMOVED |
| DELETE | /facilities/:id/staff/:userId | F:ADMIN(id) | Soft-removes an ACTIVE membership (sets REMOVED; the row is never deleted, so a later re-invite reuses it). Refused with 409 `LAST_FACILITY_ADMIN` if it would leave the facility with no ACTIVE FACILITY_ADMIN |
| GET | /blood/units | F:HOSPITAL or F:BLOOD_BANK(facilityId) | Paginated. `facilityId` query is required and must be a facility where the caller has an ACTIVE membership |
| POST | /blood/units | Same, own facility | Register a unit. `facilityId` must equal a facility the caller belongs to. `unit_uid` is issued by the server |
| PATCH | /blood/units/:id | Same, unit's custodian facility | Update storage location or facility code. Not blood group or expiry after issue |
| POST | /blood/units/:id/discard | Same, unit's custodian facility | Marks DISCARDED with reason. Units are never physically deleted, to keep traceability |
| POST | /blood/units/:id/reserve | Same, unit's custodian facility | Body `{ requestId }`. See 7.1 |
| POST | /blood/reservations/:id/release | Same, reservation's facility | Releases an ACTIVE reservation |
| POST | /blood/units/:id/issue | Same, unit's custodian facility | Body `{ requestId }`. Requires an ACTIVE reservation for that request |
| POST | /blood/units/:id/transfer | F:ADMIN of the current custodian facility | Controlled transfer, see 7.2 |
| GET | /blood/units/:id/events | Custodian facility staff / ADMIN | Custody trail (`blood_unit_events`) |

Staff are invited by internal `userId` in v1: there is no lookup-by-email or other discovery endpoint yet, so the inviter must already know the invitee's id through some other channel. This is a known limitation, deferred to a later batch, not a design decision.

Audited: `FACILITY_REGISTERED` (self-registration), `FACILITY_VERIFICATION_SUBMITTED` (verification submission - every submission, not only the first), `STAFF_INVITED`, `STAFF_INVITATION_ACCEPTED` (a genuine INVITED to ACTIVE transition only, not an idempotent repeat), `STAFF_REMOVED`.

### 7.1 Ownership, scoping and concurrency
- **Facility ownership is enforced on every unit and reservation operation.** The server loads the unit (or reservation), reads its current custodian `facility_id`, and requires an ACTIVE membership of the caller in that facility and a VERIFIED facility. A `facilityId` supplied by the client is only a filter that must be checked, never a source of authority. Staff can therefore operate only on units belonging to their own authorized facility, with the controlled transfer operation as the only exception. A unit of another facility returns 404.
- Reserve, release, issue, and expiry use the transaction in DATABASE.md section 10: request row lock, unit rows locked in id order, conditional updates, the unique index on ACTIVE reservations, and the `active_reservation_id` CHECK. A losing caller gets 409 `UNIT_NOT_AVAILABLE`. Over-reserving beyond `units_required` gets 409 `REQUEST_UNITS_FULFILLED`.
- Reserve also checks that the request is non-terminal and ACTIVE or later, that the unit is compatible with the request (compatibility service), and that the unit's remaining shelf life meets the configured buffer.
- Issue moves the unit to ISSUED, records the event, and asks the fulfilment evaluator whether the request can transition (state machine).
- Audited: `BLOOD_UNIT_RESERVED`, `BLOOD_UNIT_ISSUED`, `INVENTORY_UPDATED`.

### 7.2 Transfers
Only a FACILITY_ADMIN of the unit's current custodian facility may initiate a transfer. The unit must be AVAILABLE (not RESERVED or ISSUED), and the destination must be a different, VERIFIED facility. The transfer updates `facility_id`, writes a `TRANSFERRED` event with both facilities, and is audited. The source facility loses access immediately and the destination gains it. A two-step acceptance by the receiving facility is a possible later extension.

## 8. Blood availability (public)

`GET /blood/availability` (Pub, rate-limited, cached briefly).
- Query: `bloodGroup`, `component` (WHOLE_BLOOD or RBC), `lat`, `lng`, `radiusKm` (bounded), plus pagination. The searcher's coordinates are used only for the query and are not stored or logged.
- Returns **verified facility-level availability only**: for each VERIFIED facility in range, name, type, distance, count of AVAILABLE units for the requested group and component (units that are unreserved and not within the shelf-life buffer), `lastUpdatedAt`, facility status, and the facility's published contact information. Counts only, no unit ids.
- Never returns donor identity, donor exact or coarse location, donor contact information, or any donor data. It reads only facility and unit-count data, and has no join to donor tables.
- Facilities that are not VERIFIED (PENDING, UNDER_REVIEW, REJECTED, SUSPENDED) never appear.

## 9. Maps

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | /maps/nearby/facilities | Pub | VERIFIED facilities only. Rate-limited, cached |
| POST | /maps/eta | Auth | See 9.1 |

### 9.1 POST /maps/eta
This is **not** a generic routing API. It does not accept two arbitrary coordinates. The caller states a purpose, and the server decides which points are used.

Body is one of:
- `{ "mode": "DONOR_TO_HOSPITAL", "matchId" }`: caller must be the donor who owns the match. The origin is the donor's stored location, read server-side. The destination is the request's hospital.
- `{ "mode": "CONFIRMED_DONOR_TO_HOSPITAL", "requestId", "matchId" }`: caller is the request Owner or F:HOSPITAL(request.hospital). The match must be CONFIRMED for that request. The donor's origin is used only on the server.
- `{ "mode": "SELF_TO_FACILITY", "facilityId", "origin": { lat, lng } }`: the caller's own current position (a value the caller already has) to a VERIFIED facility. The origin is used for one calculation, and is not stored or logged. Stricter rate limit.

Privacy: **exact donor location is never present in the request or response.** The response is limited to `{ etaMinutesMin, etaMinutesMax, distanceBand, estimated: true, source, computedAt }`. Patients and the public only ever receive bands, never coordinates. Any other combination of inputs is rejected by validation.

Behavior:
- Respects `MAPS_ENABLED`. When false, or when the provider fails, is over quota, or the per-request call cap is hit, the API still answers with a straight-line distance based estimate (`source: "STRAIGHT_LINE_ESTIMATE"`, using a configured average speed) labelled as estimated. It does not fail with an error only because maps are unavailable.
- When enabled, it uses the Google Routes API (Compute Route Matrix) through the server key, with cached results (ARCHITECTURE.md 3.1 and 8), and the per-request cap.
- Output is always a range presented as an estimate, never an exact arrival time.
- Audited only for exact-location-derived modes (`location_access_logs` when a person, not a batch job, triggers a computation from a donor's exact location).

## 10. Notifications

| Method | Path | Auth |
|---|---|---|
| GET | /notifications | Auth (paginated, own only) |
| PATCH | /notifications/:id/read | Auth (own only) |
| POST | /notifications/read-all | Auth |

## 11. Admin and analytics

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | /admin/users, /admin/facilities, /admin/verifications | ADMIN | Paginated |
| POST | /admin/verifications/:id/approve | ADMIN | Verification approval for donors and facilities (donor verification, facility verification) |
| POST | /admin/verifications/:id/reject | ADMIN | Reason required |
| POST | /admin/users/:id/suspend | ADMIN | Suspension of a user. See 11.1 |
| POST | /admin/users/:id/reinstate | ADMIN | Lifts a suspension |
| POST | /admin/facilities/:id/suspend | ADMIN | Suspension of a facility |
| POST | /admin/facilities/:id/reinstate | ADMIN | Lifts a suspension |
| GET | /admin/requests, /admin/flags | ADMIN | Paginated |
| GET, PUT | /admin/settings | ADMIN | Includes batch, freshness and maps settings |
| GET, PUT | /admin/rules/compatibility, /admin/rules/donation-intervals, /admin/rules/eligibility | ADMIN | Effective-dated rows, immutable once used. Changes trigger eligibility recompute |
| POST | /admin/roles | SUPER_ADMIN | Grant or revoke ADMIN or SUPER_ADMIN. Audited as `ROLE_GRANTED` or `ROLE_REVOKED` |
| POST | /admin/donation-history/:id/verify, /reject | ADMIN | Admin verification of donation records |
| GET | /admin/audit-logs | ADMIN | Paginated |
| GET | /analytics/public-stats | Pub | Aggregates only |
| GET | /analytics/platform, /donors, /inventory, /demand | ADMIN | |

### 11.1 Verification is separate from suspension
- **Verification** (approve, reject) decides whether an identity or facility is trusted. It moves a verification record and the owning donor or facility status between PENDING, UNDER_REVIEW, VERIFIED, REJECTED.
- **Suspension** (suspend, reinstate) is a separate administrative action on a user or facility that has already been through, or may not need, verification. It has its own endpoints, requires a reason, and is audited (`USER_SUSPENDED`, `FACILITY_SUSPENDED`, and their reinstatements). The two are never combined in one endpoint or one status change.
- Effects of a suspension, applied in one transaction: a suspended donor is excluded from all future matching and their open matches are closed; a suspended facility is denied all operational actions (2.1) and disappears from public listings and availability; the affected users are notified.
- Suspension does not delete data, and reinstatement does not re-verify. Verification status is kept as recorded, and reinstatement returns the entity to the state it had before suspension.
- Admins cannot suspend themselves, and only SUPER_ADMIN can suspend another ADMIN.

## 12. Webhooks and jobs

| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | /webhooks/clerk | Svix signature | user.created, user.updated, user.deleted. Idempotent through `webhook_events`. `user.deleted` starts anonymization, not a hard delete |
| POST | /internal/jobs/:name | CRON_SECRET | Optional external cron trigger |

## 13. Internal: backend to ML service

`POST {ML_SERVICE_URL}/predict` with `X-Service-Secret: ML_SERVICE_SECRET` and `X-Request-ID`. Contract in ML.md. Only donors that already passed the hard filters are sent.
