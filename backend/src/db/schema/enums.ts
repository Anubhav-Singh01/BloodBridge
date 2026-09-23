import { pgEnum } from 'drizzle-orm/pg-core';

// Enums for Schema A (identity, facilities, donors, donation history, eligibility and rules).
// Values come from DATABASE.md and API.md. Later batches append their own enums here.
export const userStatusEnum = pgEnum('user_status', ['ACTIVE', 'SUSPENDED', 'DELETION_PENDING', 'ANONYMIZED']);
export const roleCodeEnum = pgEnum('role_code', ['PATIENT', 'DONOR', 'ADMIN', 'SUPER_ADMIN']);
export const facilityTypeEnum = pgEnum('facility_type', ['HOSPITAL', 'BLOOD_BANK']);
export const facilityStatusEnum = pgEnum('facility_status', ['ACTIVE', 'SUSPENDED']);
// One verification enum for facilities, donors and both verification tables. Suspension is never a
// verification value (API.md 11.1).
export const verificationStatusEnum = pgEnum('verification_status', ['PENDING', 'UNDER_REVIEW', 'VERIFIED', 'REJECTED']);
export const membershipRoleEnum = pgEnum('facility_membership_role', ['FACILITY_ADMIN', 'STAFF']);
export const membershipStatusEnum = pgEnum('facility_membership_status', ['INVITED', 'ACTIVE', 'REMOVED']);
export const donorStatusEnum = pgEnum('donor_status', ['ACTIVE', 'SUSPENDED', 'ANONYMIZED']);
export const availabilityStatusEnum = pgEnum('availability_status', ['AVAILABLE', 'UNAVAILABLE', 'TEMPORARILY_UNAVAILABLE']);
export const bloodGroupEnum = pgEnum('blood_group', ['A_POS', 'A_NEG', 'B_POS', 'B_NEG', 'AB_POS', 'AB_NEG', 'O_POS', 'O_NEG']);
export const bloodComponentEnum = pgEnum('blood_component', ['WHOLE_BLOOD', 'RBC']);
export const donationTypeEnum = pgEnum('donation_type', ['WHOLE_BLOOD']);
export const donationSourceEnum = pgEnum('donation_source', ['SELF_REPORTED', 'REQUESTER_CONFIRMED', 'FACILITY_RECORDED']);
export const donationVerificationStatusEnum = pgEnum('donation_verification_status', ['UNVERIFIED', 'VERIFIED', 'REJECTED']);
export const eligibilityRuleKeyEnum = pgEnum('eligibility_rule_key', ['MIN_AGE', 'MAX_AGE']);
export const intervalRuleScopeEnum = pgEnum('interval_rule_scope', ['OFFICIAL', 'FACILITY']);
export const eligibilityCalcTriggerEnum = pgEnum('eligibility_calc_trigger', ['DONATION_VERIFIED', 'DONATION_REJECTED', 'RULE_CHANGED', 'DAILY_JOB', 'MANUAL_RECHECK']);
export const eligibilityCalcOutcomeEnum = pgEnum('eligibility_calc_outcome', ['COMPUTED', 'NO_DONATION', 'NO_RULE']);
export const eligibilityCalcStatusEnum = pgEnum('eligibility_calc_status', ['CURRENT', 'SUPERSEDED']);

// Schema B (inventory and requests).
export const requestStatusEnum = pgEnum('request_status', ['DRAFT', 'SUBMITTED', 'VERIFICATION_PENDING', 'ACTIVE', 'DONOR_SEARCH', 'DONOR_CONTACTED', 'DONOR_ACCEPTED', 'DONOR_CONFIRMED', 'FULFILLED', 'CANCELLED', 'EXPIRED', 'REJECTED']);
export const requestEventTypeEnum = pgEnum('request_event_type', ['DONOR_ARRIVED', 'DONOR_DROPPED', 'ETA_UPDATED', 'VERIFICATION_RESULT', 'NOTE']);
// Who may cause a status transition (API.md 6.7). These are not the global roles in `role_code`.
export const requestActorKindEnum = pgEnum('request_actor_kind', ['OWNER', 'HOSPITAL_STAFF', 'BLOOD_BANK_STAFF', 'ADMIN', 'DONOR', 'SYSTEM']);
export const bloodUnitStatusEnum = pgEnum('blood_unit_status', ['AVAILABLE', 'RESERVED', 'ISSUED', 'EXPIRED', 'DISCARDED']);
export const bloodUnitEventTypeEnum = pgEnum('blood_unit_event_type', ['RECEIVED', 'RESERVED', 'RELEASED', 'ISSUED', 'TRANSFERRED', 'EXPIRED', 'DISCARDED']);
export const reservationStatusEnum = pgEnum('reservation_status', ['ACTIVE', 'RELEASED', 'ISSUED', 'EXPIRED']);

// Schema C (matching, ranking, ML and platform).
export const searchStatusEnum = pgEnum('search_status', ['ACTIVE', 'FULFILLED', 'EXHAUSTED', 'CANCELLED', 'EXPIRED']);
export const batchStatusEnum = pgEnum('batch_status', ['PENDING', 'ACTIVE', 'EVALUATED', 'CANCELLED']);
export const rankerTypeEnum = pgEnum('ranker_type', ['ML', 'FALLBACK']);
export const rankingTriggerEnum = pgEnum('ranking_trigger', ['INITIAL', 'BATCH_ADVANCE', 'CANDIDATE_SET_CHANGED', 'INPUTS_CHANGED', 'MODEL_CHANGED', 'FRESHNESS_EXPIRED']);
export const matchStatusEnum = pgEnum('match_status', ['CANDIDATE', 'EXCLUDED', 'NOTIFIED', 'ACCEPTED', 'CONFIRMED', 'WAITLISTED', 'DECLINED', 'NO_RESPONSE', 'EXPIRED', 'DROPPED', 'COMPLETED']);
// The label set of ML.md section 2. WAITLISTED is recorded as ACCEPTED, and no drop writes a response.
export const donorResponseKindEnum = pgEnum('donor_response_kind', ['ACCEPTED', 'DECLINED', 'NO_RESPONSE', 'EXPIRED']);
export const modelStatusEnum = pgEnum('model_status', ['CANDIDATE', 'ACTIVE', 'RETIRED']);
// In-app and email are live in v1. SMS and push are stubs behind the provider interface.
export const notificationChannelEnum = pgEnum('notification_channel', ['IN_APP', 'EMAIL', 'SMS', 'PUSH']);
export const deliveryStatusEnum = pgEnum('delivery_status', ['PENDING', 'SENT', 'DELIVERED', 'FAILED']);
export const deletionRequestSourceEnum = pgEnum('deletion_request_source', ['USER_REQUEST', 'CLERK_WEBHOOK']);
export const deletionRequestStatusEnum = pgEnum('deletion_request_status', ['PENDING', 'COMPLETED']);
