CREATE TYPE "public"."blood_unit_event_type" AS ENUM('RECEIVED', 'RESERVED', 'RELEASED', 'ISSUED', 'TRANSFERRED', 'EXPIRED', 'DISCARDED');--> statement-breakpoint
CREATE TYPE "public"."blood_unit_status" AS ENUM('AVAILABLE', 'RESERVED', 'ISSUED', 'EXPIRED', 'DISCARDED');--> statement-breakpoint
CREATE TYPE "public"."request_actor_kind" AS ENUM('OWNER', 'HOSPITAL_STAFF', 'BLOOD_BANK_STAFF', 'ADMIN', 'DONOR', 'SYSTEM');--> statement-breakpoint
CREATE TYPE "public"."request_event_type" AS ENUM('DONOR_ARRIVED', 'DONOR_DROPPED', 'ETA_UPDATED', 'VERIFICATION_RESULT', 'NOTE');--> statement-breakpoint
CREATE TYPE "public"."request_status" AS ENUM('DRAFT', 'SUBMITTED', 'VERIFICATION_PENDING', 'ACTIVE', 'DONOR_SEARCH', 'DONOR_CONTACTED', 'DONOR_ACCEPTED', 'DONOR_CONFIRMED', 'FULFILLED', 'CANCELLED', 'EXPIRED', 'REJECTED');--> statement-breakpoint
CREATE TYPE "public"."reservation_status" AS ENUM('ACTIVE', 'RELEASED', 'ISSUED', 'EXPIRED');--> statement-breakpoint
CREATE TABLE "blood_request_status_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" uuid NOT NULL,
	"from_status" "request_status",
	"to_status" "request_status" NOT NULL,
	"actor_id" uuid,
	"reason" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "blood_request_status_history_first_is_draft" CHECK ("blood_request_status_history"."from_status" IS NOT NULL OR "blood_request_status_history"."to_status" = 'DRAFT'),
	CONSTRAINT "blood_request_status_history_changes_status" CHECK ("blood_request_status_history"."from_status" IS NULL OR "blood_request_status_history"."from_status" <> "blood_request_status_history"."to_status")
);
--> statement-breakpoint
CREATE TABLE "blood_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"requester_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"hospital_id" uuid NOT NULL,
	"blood_group" "blood_group" NOT NULL,
	"component" "blood_component" NOT NULL,
	"units_required" integer NOT NULL,
	"required_donors" integer NOT NULL,
	"urgency" text,
	"is_emergency" boolean DEFAULT false NOT NULL,
	"required_by" timestamp with time zone NOT NULL,
	"reason_category" text,
	"contact_phone" text,
	"contact_person" text,
	"additional_info" text,
	"location" geography(Point,4326) NOT NULL,
	"status" "request_status" DEFAULT 'DRAFT' NOT NULL,
	"expires_at" timestamp with time zone,
	"is_demo" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "blood_requests_units_positive" CHECK ("blood_requests"."units_required" > 0),
	CONSTRAINT "blood_requests_donors_positive" CHECK ("blood_requests"."required_donors" > 0),
	CONSTRAINT "blood_requests_expiry_set" CHECK ("blood_requests"."status" = 'DRAFT' OR "blood_requests"."expires_at" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "request_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" uuid NOT NULL,
	"match_id" uuid,
	"event_type" "request_event_type" NOT NULL,
	"actor_id" uuid,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "request_flags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" uuid NOT NULL,
	"rule_code" text NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolved_by" uuid,
	"resolution_note" text,
	CONSTRAINT "request_flags_rule_code_format" CHECK ("request_flags"."rule_code" ~ '^[A-Z][A-Z0-9_]*$'),
	CONSTRAINT "request_flags_resolution_recorded" CHECK (("request_flags"."resolved_at" IS NULL) = ("request_flags"."resolved_by" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "request_transitions" (
	"from_status" "request_status" NOT NULL,
	"to_status" "request_status" NOT NULL,
	"allowed_actors" "request_actor_kind"[] NOT NULL,
	CONSTRAINT "request_transitions_from_status_to_status_pk" PRIMARY KEY("from_status","to_status"),
	CONSTRAINT "request_transitions_changes_status" CHECK ("request_transitions"."from_status" <> "request_transitions"."to_status"),
	CONSTRAINT "request_transitions_has_actor" CHECK (cardinality("request_transitions"."allowed_actors") > 0)
);
--> statement-breakpoint
CREATE TABLE "blood_unit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"unit_id" uuid NOT NULL,
	"event" "blood_unit_event_type" NOT NULL,
	"from_facility_id" uuid,
	"to_facility_id" uuid,
	"request_id" uuid,
	"actor_id" uuid,
	"reason" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "blood_unit_events_transfer_facilities" CHECK ("blood_unit_events"."event" <> 'TRANSFERRED' OR ("blood_unit_events"."from_facility_id" IS NOT NULL AND "blood_unit_events"."to_facility_id" IS NOT NULL AND "blood_unit_events"."from_facility_id" <> "blood_unit_events"."to_facility_id")),
	CONSTRAINT "blood_unit_events_request_required" CHECK ("blood_unit_events"."event" NOT IN ('RESERVED', 'RELEASED', 'ISSUED') OR "blood_unit_events"."request_id" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "blood_units" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"unit_uid" text NOT NULL,
	"facility_unit_code" text NOT NULL,
	"facility_id" uuid NOT NULL,
	"origin_facility_id" uuid NOT NULL,
	"source_donation_id" uuid,
	"blood_group" "blood_group" NOT NULL,
	"component" "blood_component" NOT NULL,
	"collected_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"status" "blood_unit_status" DEFAULT 'AVAILABLE' NOT NULL,
	"active_reservation_id" uuid,
	"storage_location" text,
	"is_demo" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "blood_units_unit_uid_key" UNIQUE("unit_uid"),
	CONSTRAINT "blood_units_active_reservation_key" UNIQUE("active_reservation_id"),
	CONSTRAINT "blood_units_facility_code_key" UNIQUE("facility_id","facility_unit_code"),
	CONSTRAINT "blood_units_expiry_after_collection" CHECK ("blood_units"."expires_at" > "blood_units"."collected_at"),
	CONSTRAINT "blood_units_reserved_has_reservation" CHECK (("blood_units"."status" = 'RESERVED') = ("blood_units"."active_reservation_id" IS NOT NULL)),
	CONSTRAINT "blood_units_identifiers_not_blank" CHECK (length(btrim("blood_units"."unit_uid")) > 0 AND length(btrim("blood_units"."facility_unit_code")) > 0)
);
--> statement-breakpoint
CREATE TABLE "inventory_reservations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"unit_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"status" "reservation_status" DEFAULT 'ACTIVE' NOT NULL,
	"reserved_by" uuid NOT NULL,
	"reserved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"released_at" timestamp with time zone,
	"release_reason" text,
	CONSTRAINT "inventory_reservations_id_unit_key" UNIQUE("id","unit_id"),
	CONSTRAINT "inventory_reservations_expiry_after_reserved" CHECK ("inventory_reservations"."expires_at" > "inventory_reservations"."reserved_at"),
	CONSTRAINT "inventory_reservations_end_recorded" CHECK (("inventory_reservations"."status" IN ('RELEASED', 'EXPIRED')) = ("inventory_reservations"."released_at" IS NOT NULL)),
	CONSTRAINT "inventory_reservations_reason_only_when_ended" CHECK ("inventory_reservations"."release_reason" IS NULL OR "inventory_reservations"."status" IN ('RELEASED', 'EXPIRED'))
);
--> statement-breakpoint
ALTER TABLE "patients" ADD CONSTRAINT "patients_id_creator_key" UNIQUE("id","created_by");--> statement-breakpoint
ALTER TABLE "blood_request_status_history" ADD CONSTRAINT "blood_request_status_history_request_id_blood_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."blood_requests"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blood_request_status_history" ADD CONSTRAINT "blood_request_status_history_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blood_requests" ADD CONSTRAINT "blood_requests_requester_id_users_id_fk" FOREIGN KEY ("requester_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blood_requests" ADD CONSTRAINT "blood_requests_hospital_id_hospitals_facility_id_fk" FOREIGN KEY ("hospital_id") REFERENCES "public"."hospitals"("facility_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blood_requests" ADD CONSTRAINT "blood_requests_patient_creator_fk" FOREIGN KEY ("patient_id","requester_id") REFERENCES "public"."patients"("id","created_by") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request_events" ADD CONSTRAINT "request_events_request_id_blood_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."blood_requests"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request_events" ADD CONSTRAINT "request_events_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request_flags" ADD CONSTRAINT "request_flags_request_id_blood_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."blood_requests"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request_flags" ADD CONSTRAINT "request_flags_resolved_by_users_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blood_unit_events" ADD CONSTRAINT "blood_unit_events_unit_id_blood_units_id_fk" FOREIGN KEY ("unit_id") REFERENCES "public"."blood_units"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blood_unit_events" ADD CONSTRAINT "blood_unit_events_from_facility_id_facilities_id_fk" FOREIGN KEY ("from_facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blood_unit_events" ADD CONSTRAINT "blood_unit_events_to_facility_id_facilities_id_fk" FOREIGN KEY ("to_facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blood_unit_events" ADD CONSTRAINT "blood_unit_events_request_id_blood_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."blood_requests"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blood_unit_events" ADD CONSTRAINT "blood_unit_events_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blood_units" ADD CONSTRAINT "blood_units_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blood_units" ADD CONSTRAINT "blood_units_origin_facility_id_facilities_id_fk" FOREIGN KEY ("origin_facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blood_units" ADD CONSTRAINT "blood_units_source_donation_id_donation_history_id_fk" FOREIGN KEY ("source_donation_id") REFERENCES "public"."donation_history"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blood_units" ADD CONSTRAINT "blood_units_active_reservation_fk" FOREIGN KEY ("active_reservation_id","id") REFERENCES "public"."inventory_reservations"("id","unit_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_reservations" ADD CONSTRAINT "inventory_reservations_unit_id_blood_units_id_fk" FOREIGN KEY ("unit_id") REFERENCES "public"."blood_units"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_reservations" ADD CONSTRAINT "inventory_reservations_request_id_blood_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."blood_requests"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_reservations" ADD CONSTRAINT "inventory_reservations_reserved_by_users_id_fk" FOREIGN KEY ("reserved_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "blood_request_status_history_request_idx" ON "blood_request_status_history" USING btree ("request_id","at");--> statement-breakpoint
CREATE INDEX "blood_requests_status_idx" ON "blood_requests" USING btree ("status");--> statement-breakpoint
CREATE INDEX "blood_requests_hospital_status_idx" ON "blood_requests" USING btree ("hospital_id","status");--> statement-breakpoint
CREATE INDEX "blood_requests_requester_idx" ON "blood_requests" USING btree ("requester_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "blood_requests_open_expiry_idx" ON "blood_requests" USING btree ("expires_at") WHERE "blood_requests"."status" NOT IN ('FULFILLED', 'CANCELLED', 'EXPIRED', 'REJECTED') AND "blood_requests"."expires_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "blood_requests_location_gist" ON "blood_requests" USING gist ("location");--> statement-breakpoint
CREATE INDEX "request_events_request_idx" ON "request_events" USING btree ("request_id","at");--> statement-breakpoint
CREATE INDEX "request_events_match_idx" ON "request_events" USING btree ("match_id") WHERE "request_events"."match_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "request_flags_request_idx" ON "request_flags" USING btree ("request_id");--> statement-breakpoint
CREATE INDEX "request_flags_open_idx" ON "request_flags" USING btree ("created_at") WHERE "request_flags"."resolved_at" IS NULL;--> statement-breakpoint
CREATE INDEX "blood_unit_events_unit_idx" ON "blood_unit_events" USING btree ("unit_id","at");--> statement-breakpoint
CREATE INDEX "blood_unit_events_request_idx" ON "blood_unit_events" USING btree ("request_id") WHERE "blood_unit_events"."request_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "blood_units_availability_idx" ON "blood_units" USING btree ("facility_id","blood_group","component","expires_at") WHERE "blood_units"."status" = 'AVAILABLE';--> statement-breakpoint
CREATE INDEX "blood_units_expiry_idx" ON "blood_units" USING btree ("expires_at") WHERE "blood_units"."status" IN ('AVAILABLE', 'RESERVED');--> statement-breakpoint
CREATE INDEX "blood_units_facility_status_idx" ON "blood_units" USING btree ("facility_id","status");--> statement-breakpoint
CREATE INDEX "blood_units_origin_idx" ON "blood_units" USING btree ("origin_facility_id");--> statement-breakpoint
CREATE INDEX "blood_units_source_donation_idx" ON "blood_units" USING btree ("source_donation_id") WHERE "blood_units"."source_donation_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_reservations_one_active_per_unit" ON "inventory_reservations" USING btree ("unit_id") WHERE "inventory_reservations"."status" = 'ACTIVE';--> statement-breakpoint
CREATE INDEX "inventory_reservations_request_idx" ON "inventory_reservations" USING btree ("request_id","status");--> statement-breakpoint
CREATE INDEX "inventory_reservations_active_expiry_idx" ON "inventory_reservations" USING btree ("expires_at") WHERE "inventory_reservations"."status" = 'ACTIVE';--> statement-breakpoint
ALTER TABLE "donation_history" ADD CONSTRAINT "donation_history_request_id_blood_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."blood_requests"("id") ON DELETE restrict ON UPDATE no action;