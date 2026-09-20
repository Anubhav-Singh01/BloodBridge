# BloodBridge AI: Architecture (Phase 1 draft)

Status: design for review. No application code exists yet.
BloodBridge AI is a software platform, not a medical authority. Medical eligibility and compatibility are confirmed by facilities and qualified professionals.

## 1. System overview

```
React (Vite, TS)  --REST-->  Express (TS, modular)  --HTTP+secret-->  FastAPI ML service
   Clerk React                 |   |   |
                               |   |   +--> Google Routes API (ETA on shortlist only)
                               |   +------> Clerk (JWT verify, webhooks)
                               +----------> Neon PostgreSQL (+PostGIS) via Drizzle
```

Three deployables: `frontend/`, `backend/`, `ml-service/`. No further microservices.

## 2. Decisions

| Area | Decision |
|---|---|
| Region | India. Phones +91. All medical and eligibility rules are data, not code. |
| Scope | Academic/portfolio, production-style. Demo data clearly labelled. |
| Auth | Clerk identity only. Roles live in our DB (`user_roles`), never in client-editable metadata. Backend verifies every request. |
| Roles | Multi-role users. Facility staff have scoped roles per hospital or blood bank. ADMIN and SUPER_ADMIN separate. |
| Admin bootstrap | Seed script promotes emails in `ADMIN_BOOTSTRAP_EMAILS`. Later admins created by SUPER_ADMIN. Every grant audit-logged. |
| Request gating | Normal: verified by hospital/admin before donors are contacted. Emergency: fast path, donors contacted immediately, verification in parallel, rate-limited. |
| Requester vs patient | A requester may act for a patient. Patient data is separate and minimal. A hospital is required on every request. |
| Fulfilment | Requester confirms the donation. Optional hospital co-confirmation is stored as a separate signal because requester-only confirmation is weaker evidence for eligibility history and ML labels. |
| Inventory | Runs in parallel with donor search. Units can be reserved or issued for a request. |
| Components v1 | Whole blood and RBC only. Compatibility is table-driven so other components can be added. |
| Donors v1 | Whole-blood donors only. |
| Identity docs | Metadata only: `id_type`, last 4, name. Full ID numbers never stored or logged. Admin-verified. UI states this is not UIDAI e-KYC. No file uploads in v1. |
| Notifications | In-app and email. SMS and push behind a provider interface (stub). |
| Moderation | Rule-based flags plus manual admin review. |
| Deployment | Long-running Node host with in-process cron behind a swappable job interface. Frontend on a static host. |
| UI | Calm clinical: white/slate with crimson accent. Red reserved for emergency states. |

## 3. Matching pipeline

Order matters. Cheap, hard filters first. The ML model runs last and only ranks.

```
Validated request
  1. Compatibility        (compatibility service, table-driven, component-aware)
  2. Verification         (donor status = VERIFIED, phone verified)
  3. Availability         (AVAILABLE only)
  4. Donation interval    (now >= next_eligible_donation_at; fail closed if no rule)
  5. Fatigue cap          (configurable, default 3 notifications / 24h; see 3.2 for the emergency rule)
  6. Exclusions           (already contacted for this request; declined; no-response)
  7. Geographic radius    (PostGIS ST_DWithin, GiST index)
  8. ETA on shortlist     (Google Routes API, Compute Route Matrix; cached, per-request call cap)
  9. Feature build        (only data available at ranking time)
 10. Ranking              (ML service, or fallback ranker)
 11. Batch select         (next batchSize donors by rank)
 12. Notify + open response window
```

Hard contract: the ML model cannot approve a donor, override eligibility, or determine medical fitness. The backend sends only donors that passed steps 1-8, and discards any returned donor id not in the sent set. If the ML service is down or no model is loaded, the transparent fallback ranker orders the same set and the stored `model_version` is `rule-based-fallback`.

### 3.1 ETA provider: Google Routes API

ETA and route distance use the current Google Routes API, specifically Compute Route Matrix (`POST https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix`). The legacy Distance Matrix API is not used anywhere in this project, and it is not enabled on the Google Cloud project.

- Called only for the shortlist that already passed steps 1-7, in chunks that respect the API's documented per-request element limits (origins x destinations). Check the current limits when implementing.
- Every call sends a response field mask (`X-Goog-FieldMask`) asking only for what is used (duration, distance, status, condition). A narrow mask also keeps the call in the cheaper billing tier.
- Routing preference (traffic-aware or not) is a setting, because traffic-aware calls have lower limits and higher cost. Default is decided at implementation time and recorded in `settings`.
- Per-element failures (`condition` not `ROUTE_EXISTS`) are handled individually: that donor keeps a straight-line estimate, labelled "estimated", and is not dropped from the pool for a mapping failure.
- Results are shown as estimates ("about 10-15 minutes"), never as exact arrival times.

### 3.2 Emergency fast path and mandatory pre-notification checks

Emergency mode changes timing and workflow only. It never relaxes donor safety.

What emergency mode may do:
- Contact donors before the normal hospital/admin verification of the request completes (request goes `SUBMITTED` to `ACTIVE` directly). Verification continues in parallel and is flagged for review.
- Use a shorter response window and expiry (configured per urgency in `settings`).
- Bypass the donor fatigue cap. Every bypass is recorded on the `donor_matches` row and in the audit log.
- Be rate-limited and flagged (`request_flags`) for admin review because it skips the verification gate.

What emergency mode and the ML model may never do. These checks are mandatory before ANY notification, in normal and emergency requests, at every batch:

| # | Mandatory check | Emergency bypass allowed |
|---|---|---|
| 1 | Blood group and component compatibility | No |
| 2 | Donor account and identity verification status VERIFIED, phone verified | No |
| 3 | Donor availability AVAILABLE | No |
| 4 | Donation interval (`next_eligible_donation_at`), fail closed if no rule | No |
| 5 | Objective eligibility rules (age range etc.) from `eligibility_rules` | No |
| 6 | Exclusion of donors already contacted, declined or non-responding for this request | No |
| 7 | Geographic eligibility (within the configured radius) | No |
| 8 | Donor fatigue cap | Yes, recorded |
| 9 | Request verification gate | Yes, verified in parallel |

The ML model runs after checks 1-7 and can only reorder donors who already passed. Emergency status is not an input that lets a donor skip 1-7, and the ML service receives no override flag. The backend enforces this in one function, `assertNotifiable(donor, request)`, which the notification sender calls immediately before creating each notification, so a bug in candidate generation or ranking still cannot notify an unsafe donor. Any donor failing it is skipped and logged.

## 4. Batch escalation

Config is read from a DB settings table with per-urgency overrides. A snapshot is stored on the request search, so later setting changes never alter a running search. Defaults (all configurable): `batchSize=20`, `responseWindowMinutes=10` (emergency may be shorter), `maxBatchCount=5`, request expiry 24h (emergency 6h).

A job evaluates expired batches. Nothing waits inside an HTTP request. For each batch past `expires_at`:
1. Recipients still NOTIFIED become NO_RESPONSE (window expiry).
2. If confirmed >= requiredDonors, the search is already fulfilled (see below) and nothing is sent.
3. Otherwise, if `batch_count < maxBatchCount` and the request is not cancelled or expired, build the next batch using the re-validation procedure below.
4. If no valid candidates remain, or `maxBatchCount` is reached, notify requester and admin. The radius is never widened automatically unless an explicit configurable rule allows it.

### Re-validation before every subsequent batch

A candidate set computed for batch 1 is a snapshot that goes stale: a donor may have become unavailable, donated elsewhere, hit the fatigue cap through another request, been suspended, or moved. The stored ranking is therefore only a starting point and is never trusted blindly.

Before batch N (N >= 2) is sent, for the donors not yet contacted in this search:
1. Re-run steps 1-7 of the pipeline against current data: compatibility, verification status, availability, donation interval, objective eligibility rules, exclusions (contacted, declined, no-response for this request), fatigue cap, and geographic radius using current donor location.
2. Drop every donor that now fails. Dropped donors are marked `EXCLUDED` on their `donor_matches` row with a reason code, so the search history shows why.
3. Re-run ETA (Routes API) only for donors whose cached ETA has expired or whose location changed.
4. Re-rank the surviving candidates (ML service, or fallback) when any of these holds: the candidate set changed, feature inputs changed (ETA, distance, availability, recent activity), the active model version changed, or the ranking is older than the freshness window (below). Stored ranks may be reused only when none of these holds. The decision, the reason for re-ranking and the ranking's `model_version` are recorded on the `ranking_runs` row attached to the batch. Per-donor scores and feature snapshots are stored in `ranking_predictions`, and `donor_matches.selected_prediction_id` identifies the prediction used to contact each donor.

Freshness window: every ranking stores `ranked_at`. `settings.rankingFreshnessMinutes` defines how long a ranking's inputs are considered current, with per-urgency overrides like the other batch settings (emergency uses a shorter window). Its value is chosen at implementation time and not fixed here. If `now - ranked_at` exceeds the window when a batch opens, the ranking is stale and is re-evaluated even if no data-change event occurred: the hard filters (steps 1-7) are re-run, stale ETAs are refreshed, and the survivors are re-ranked. The window bounds staleness of inputs that change without an event, such as time-of-day features, recent-activity features and donor movement.
5. Take the top `batchSize` of the re-ranked valid pool. Then `assertNotifiable` (3.2) runs again per donor right before each notification is created.

Because ranks are recomputed over the surviving pool, batch N is defined as "the top `batchSize` valid, uncontacted donors at the time batch N opens", not a fixed slice of ranks computed earlier. The example ranks 1-20, 21-40, 41-60 describe the usual result when nothing changes.

Fulfilment: when confirmed donors reach `requiredDonors`, the search is marked fulfilled, no more batches are created, outstanding NOTIFIED recipients are cancelled and told the request is fulfilled, and the request workflow continues. Example: batch 1 = 20 donors, 5 accepted, `requiredDonors=2` means 2 CONFIRMED, 3 WAITLISTED, fulfilled at once, no second batch.

Over-acceptance and concurrency: the first N acceptors are CONFIRMED and the rest WAITLISTED. The assignment is done inside one DB transaction holding a row lock on the search (details in DATABASE.md). Waitlisted donors are promoted through the same lock if a confirmed donor drops out.

## 5. Three separate status models

Three state machines exist. Each answers a different question, is stored in a different table, and is changed by different code. Mixing them is the most likely source of bugs, so the responsibilities are fixed here.

| | Request status | Donor-match status | Batch status |
|---|---|---|---|
| Question answered | Where is this blood request in its lifecycle? | What has happened between one donor and this request? | Is this notification round open, finished, or abandoned? |
| Table | `blood_requests.status` | `donor_matches.status` | `notification_batches.status` |
| Cardinality | 1 per request | 1 per (search, donor) | 1 per round; several per search |
| Values | DRAFT, SUBMITTED, VERIFICATION_PENDING, ACTIVE, DONOR_SEARCH, DONOR_CONTACTED, DONOR_ACCEPTED, DONOR_CONFIRMED, FULFILLED, CANCELLED, EXPIRED, REJECTED | CANDIDATE, EXCLUDED, NOTIFIED, ACCEPTED, CONFIRMED, WAITLISTED, DECLINED, NO_RESPONSE, EXPIRED, DROPPED, COMPLETED | PENDING, ACTIVE, EVALUATED, CANCELLED |
| Changed by | `requestStateMachine.transition` only | Donor response transaction, batch evaluation job, hospital actions (arrival, drop) | Batch service and evaluation job |
| Audience | Patient, hospital, admin see it | Donor sees their own; patient sees counts only | Internal and admin |
| History | `blood_request_status_history` | `donor_responses` (append-only) and audit log | Batch rows themselves |

Rules:
- The request status is the authoritative lifecycle state of the request. Donor-match and batch statuses represent their own sub-processes (one donor's interaction, one notification round) and are not the request lifecycle.
- Match and batch events may trigger valid request-state transitions, but only by calling `requestStateMachine.transition` in the same transaction that records the event, which validates the move against the transition table. Example: when a match becomes CONFIRMED and the confirmed count reaches `requiredDonors`, that transaction asks the state machine for the next valid request transition. An event that would imply an invalid transition is rejected or leaves the request status unchanged.
- Clients cannot set request status directly, and individual match or batch operations never write `blood_requests.status` themselves. Clients use intent endpoints only (submit, cancel, respond, confirm-donation, ...), and every request-status change goes through the state machine.
- Donor-match status is per donor. A request in DONOR_CONTACTED can simultaneously have donors in NOTIFIED, DECLINED and NO_RESPONSE.
- Batch status describes the round, not any donor. `EVALUATED` means the window closed and each recipient was resolved. `CANCELLED` means the round was stopped early (fulfilled, request cancelled or expired), and its NOTIFIED recipients are cancelled with it.
- Terminal request states (FULFILLED, CANCELLED, EXPIRED, REJECTED) force all open batches to CANCELLED and all open matches to a closed state.
- `EXCLUDED` (donor failed re-validation for a later batch) and `CANDIDATE` (ranked but not yet contacted) exist only on donor matches and never appear on requests.

The request state machine is implemented once, in `requestStateMachine.transition(...)`, and enforced in the DB too. Full definition and rationale are in DATABASE.md; API.md lists which role may trigger each transition. There is no generic "set status" endpoint.

## 6. Backend layout

```
backend/src/
  config/  routes/  controllers/  services/  repositories/
  middlewares/  validators/  utils/  jobs/  webhooks/  types/  app.ts
```
Routes call controllers, controllers call services, services call repositories. No business logic in routes. Key services: `compatibilityService`, `eligibilityService`, `matchingService`, `rankingService` (ML client and fallback), `batchService`, `requestStateMachine`, `notificationService`, `mapsService`, `inventoryService`, `auditService`.

Jobs run behind a `JobRunner` interface (in-process node-cron now, queue later): every 5 min (expire requests, evaluate expired batches, reminders), hourly (expire blood units), daily (recompute eligibility, aggregate analytics, clean notifications). Endpoints for external cron are guarded by `CRON_SECRET`. Job handlers are idempotent and use row locks or `SKIP LOCKED` so overlapping runs are safe.

## 7. Security summary

Clerk JWT verified on the backend for every private route. RBAC and facility scoping enforced server-side. Zod validation on every input. Helmet, CORS allow-list, rate limiting (stricter on emergency creation and auth-adjacent routes). Clerk webhooks are signature-verified and idempotent via a `webhook_events` table. Consistent error envelope with no stack traces in production. Audit log for sensitive actions. Donor exact location is never shown to patients; only coarse cells. Secrets never reach the frontend.

## 8. Google Maps safeguards (do BEFORE adding any key)

These are done in the Google Cloud console by you:
1. Create a dedicated project. Set a budget with alerts (e.g. 50/90/100%).
2. Enable the Routes API (not the legacy Distance Matrix API) and set a low daily quota on it. Enable only the APIs the application actually uses. Geocoding and Places stay disabled unless a feature requires them (for example address search or autocomplete); if one is added later, enable it, restrict it and quota it at that time.
3. Use two keys. The browser key is restricted by HTTP referrer and to the APIs the frontend actually calls (for example Maps JavaScript API). The server key is restricted to the server-side APIs actually used (currently Routes only).
   - Server key network restriction depends on the hosting provider and networking plan chosen at deployment. Render, Railway and Fly do not always provide a stable outbound IP (some plans or add-ons do, some do not). Do not assume one. The final strategy is decided once the host and plan are selected: an IP restriction if a static egress IP is available, otherwise API restriction plus tight quotas, budget alerts, key rotation and the application-side guards below.
   - Either way the server key is never sent to the browser.
4. Note that budget alerts do not stop spending on their own. Quotas do.

Application-side guards (built into `mapsService`): ETA results cached with a TTL, call count capped per search, ETA requested only for the shortlisted candidates, an env kill switch (`MAPS_ENABLED=false` falls back to straight-line distance with a "estimated" label), and no key in logs.

## 9. Phases

Phase 1 (this): ARCHITECTURE.md, DATABASE.md, API.md, ML.md. Then Phase 2 project scaffolding, following the phase list in the original brief.
