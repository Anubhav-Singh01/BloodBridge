CREATE TYPE "public"."availability_status" AS ENUM('AVAILABLE', 'UNAVAILABLE', 'TEMPORARILY_UNAVAILABLE');--> statement-breakpoint
CREATE TYPE "public"."blood_component" AS ENUM('WHOLE_BLOOD', 'RBC');--> statement-breakpoint
CREATE TYPE "public"."blood_group" AS ENUM('A_POS', 'A_NEG', 'B_POS', 'B_NEG', 'AB_POS', 'AB_NEG', 'O_POS', 'O_NEG');--> statement-breakpoint
CREATE TYPE "public"."donation_source" AS ENUM('SELF_REPORTED', 'REQUESTER_CONFIRMED', 'FACILITY_RECORDED');--> statement-breakpoint
CREATE TYPE "public"."donation_type" AS ENUM('WHOLE_BLOOD');--> statement-breakpoint
CREATE TYPE "public"."donation_verification_status" AS ENUM('UNVERIFIED', 'VERIFIED', 'REJECTED');--> statement-breakpoint
CREATE TYPE "public"."donor_status" AS ENUM('ACTIVE', 'SUSPENDED', 'ANONYMIZED');--> statement-breakpoint
CREATE TYPE "public"."eligibility_calc_outcome" AS ENUM('COMPUTED', 'NO_DONATION', 'NO_RULE');--> statement-breakpoint
CREATE TYPE "public"."eligibility_calc_status" AS ENUM('CURRENT', 'SUPERSEDED');--> statement-breakpoint
CREATE TYPE "public"."eligibility_calc_trigger" AS ENUM('DONATION_VERIFIED', 'DONATION_REJECTED', 'RULE_CHANGED', 'DAILY_JOB', 'MANUAL_RECHECK');--> statement-breakpoint
CREATE TYPE "public"."eligibility_rule_key" AS ENUM('MIN_AGE', 'MAX_AGE');--> statement-breakpoint
CREATE TYPE "public"."facility_status" AS ENUM('ACTIVE', 'SUSPENDED');--> statement-breakpoint
CREATE TYPE "public"."facility_type" AS ENUM('HOSPITAL', 'BLOOD_BANK');--> statement-breakpoint
CREATE TYPE "public"."interval_rule_scope" AS ENUM('OFFICIAL', 'FACILITY');--> statement-breakpoint
CREATE TYPE "public"."facility_membership_role" AS ENUM('FACILITY_ADMIN', 'STAFF');--> statement-breakpoint
CREATE TYPE "public"."facility_membership_status" AS ENUM('INVITED', 'ACTIVE', 'REMOVED');--> statement-breakpoint
CREATE TYPE "public"."role_code" AS ENUM('PATIENT', 'DONOR', 'ADMIN', 'SUPER_ADMIN');--> statement-breakpoint
CREATE TYPE "public"."user_status" AS ENUM('ACTIVE', 'SUSPENDED', 'DELETION_PENDING', 'ANONYMIZED');--> statement-breakpoint
CREATE TYPE "public"."verification_status" AS ENUM('PENDING', 'UNDER_REVIEW', 'VERIFIED', 'REJECTED');--> statement-breakpoint
CREATE TABLE "patients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"full_name" text,
	"age_band" text NOT NULL,
	"created_by" uuid NOT NULL,
	"user_id" uuid,
	"is_demo" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "patients_age_band_not_blank" CHECK (length(btrim("patients"."age_band")) > 0)
);
--> statement-breakpoint
CREATE TABLE "roles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" "role_code" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "roles_code_key" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "user_profiles" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"full_name" text,
	"email" text,
	"phone" text,
	"phone_verified_at" timestamp with time zone,
	"date_of_birth" date,
	"address" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_profiles_verified_phone_exists" CHECK ("user_profiles"."phone_verified_at" IS NULL OR "user_profiles"."phone" IS NOT NULL),
	CONSTRAINT "user_profiles_dob_not_future" CHECK ("user_profiles"."date_of_birth" IS NULL OR "user_profiles"."date_of_birth" <= CURRENT_DATE)
);
--> statement-breakpoint
CREATE TABLE "user_roles" (
	"user_id" uuid NOT NULL,
	"role_id" uuid NOT NULL,
	"granted_by" uuid,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_roles_user_id_role_id_pk" PRIMARY KEY("user_id","role_id")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clerk_user_id" text,
	"status" "user_status" DEFAULT 'ACTIVE' NOT NULL,
	"anonymized_at" timestamp with time zone,
	"is_demo" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_clerk_user_id_key" UNIQUE("clerk_user_id"),
	CONSTRAINT "users_anonymized_consistent" CHECK (("users"."status" = 'ANONYMIZED') = ("users"."anonymized_at" IS NOT NULL)),
	CONSTRAINT "users_clerk_link_consistent" CHECK (("users"."status" = 'ANONYMIZED') = ("users"."clerk_user_id" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "blood_banks" (
	"facility_id" uuid PRIMARY KEY NOT NULL,
	"facility_type" "facility_type" DEFAULT 'BLOOD_BANK' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "blood_banks_type_is_blood_bank" CHECK ("blood_banks"."facility_type" = 'BLOOD_BANK')
);
--> statement-breakpoint
CREATE TABLE "facilities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"facility_type" "facility_type" NOT NULL,
	"name" text NOT NULL,
	"registration_no" text,
	"contact" text,
	"address" text,
	"location" geography(Point,4326),
	"verification_status" "verification_status" DEFAULT 'PENDING' NOT NULL,
	"status" "facility_status" DEFAULT 'ACTIVE' NOT NULL,
	"created_by" uuid NOT NULL,
	"is_demo" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "facilities_id_type_key" UNIQUE("id","facility_type"),
	CONSTRAINT "facilities_name_not_blank" CHECK (length(btrim("facilities"."name")) > 0),
	CONSTRAINT "facilities_verified_has_location" CHECK ("facilities"."verification_status" <> 'VERIFIED' OR "facilities"."location" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "facility_memberships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"facility_id" uuid NOT NULL,
	"role" "facility_membership_role" NOT NULL,
	"status" "facility_membership_status" DEFAULT 'INVITED' NOT NULL,
	"invited_by" uuid,
	"joined_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "facility_memberships_user_facility_key" UNIQUE("user_id","facility_id"),
	CONSTRAINT "facility_memberships_joined_consistent" CHECK (("facility_memberships"."status" <> 'ACTIVE' OR "facility_memberships"."joined_at" IS NOT NULL) AND ("facility_memberships"."status" <> 'INVITED' OR "facility_memberships"."joined_at" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "facility_verifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"facility_id" uuid NOT NULL,
	"registration_metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" "verification_status" DEFAULT 'PENDING' NOT NULL,
	"reviewed_by" uuid,
	"reviewed_at" timestamp with time zone,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "facility_verifications_facility_key" UNIQUE("facility_id"),
	CONSTRAINT "facility_verifications_review_recorded" CHECK ("facility_verifications"."status" NOT IN ('VERIFIED', 'REJECTED') OR ("facility_verifications"."reviewed_by" IS NOT NULL AND "facility_verifications"."reviewed_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "hospitals" (
	"facility_id" uuid PRIMARY KEY NOT NULL,
	"facility_type" "facility_type" DEFAULT 'HOSPITAL' NOT NULL,
	"has_emergency_services" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hospitals_type_is_hospital" CHECK ("hospitals"."facility_type" = 'HOSPITAL')
);
--> statement-breakpoint
CREATE TABLE "compatibility_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"component" "blood_component" NOT NULL,
	"recipient_group" "blood_group" NOT NULL,
	"donor_group" "blood_group" NOT NULL,
	"effective_from" date NOT NULL,
	"effective_to" date,
	"source_note" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "compatibility_rules_range_valid" CHECK ("compatibility_rules"."effective_to" IS NULL OR "compatibility_rules"."effective_to" > "compatibility_rules"."effective_from"),
	CONSTRAINT "compatibility_rules_source_not_blank" CHECK (length(btrim("compatibility_rules"."source_note")) > 0)
);
--> statement-breakpoint
CREATE TABLE "donation_interval_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"donation_type" "donation_type" NOT NULL,
	"min_interval_days" integer NOT NULL,
	"effective_from" date NOT NULL,
	"effective_to" date,
	"scope" interval_rule_scope NOT NULL,
	"facility_id" uuid,
	"source_note" text NOT NULL,
	"entered_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "donation_interval_rules_days_positive" CHECK ("donation_interval_rules"."min_interval_days" > 0),
	CONSTRAINT "donation_interval_rules_range_valid" CHECK ("donation_interval_rules"."effective_to" IS NULL OR "donation_interval_rules"."effective_to" > "donation_interval_rules"."effective_from"),
	CONSTRAINT "donation_interval_rules_scope_facility" CHECK (("donation_interval_rules"."scope" = 'FACILITY') = ("donation_interval_rules"."facility_id" IS NOT NULL)),
	CONSTRAINT "donation_interval_rules_source_not_blank" CHECK (length(btrim("donation_interval_rules"."source_note")) > 0)
);
--> statement-breakpoint
CREATE TABLE "eligibility_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"rule_key" "eligibility_rule_key" NOT NULL,
	"value_int" integer NOT NULL,
	"effective_from" date NOT NULL,
	"effective_to" date,
	"source_note" text NOT NULL,
	"entered_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "eligibility_rules_value_non_negative" CHECK ("eligibility_rules"."value_int" >= 0),
	CONSTRAINT "eligibility_rules_range_valid" CHECK ("eligibility_rules"."effective_to" IS NULL OR "eligibility_rules"."effective_to" > "eligibility_rules"."effective_from"),
	CONSTRAINT "eligibility_rules_source_not_blank" CHECK (length(btrim("eligibility_rules"."source_note")) > 0)
);
--> statement-breakpoint
CREATE TABLE "donation_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"donor_id" uuid NOT NULL,
	"donation_type" "donation_type" DEFAULT 'WHOLE_BLOOD' NOT NULL,
	"donated_at" timestamp with time zone NOT NULL,
	"source" "donation_source" NOT NULL,
	"facility_id" uuid,
	"request_id" uuid,
	"recorded_by" uuid,
	"verification_status" "donation_verification_status" DEFAULT 'UNVERIFIED' NOT NULL,
	"verified_by" uuid,
	"verified_at" timestamp with time zone,
	"is_demo" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "donation_history_id_donor_key" UNIQUE("id","donor_id"),
	CONSTRAINT "donation_history_not_future" CHECK ("donation_history"."donated_at" <= now()),
	CONSTRAINT "donation_history_facility_required" CHECK ("donation_history"."source" = 'SELF_REPORTED' OR "donation_history"."facility_id" IS NOT NULL),
	CONSTRAINT "donation_history_recorder_required" CHECK ("donation_history"."source" = 'SELF_REPORTED' OR "donation_history"."recorded_by" IS NOT NULL),
	CONSTRAINT "donation_history_verification_recorded" CHECK (("donation_history"."verification_status" = 'UNVERIFIED' AND "donation_history"."verified_by" IS NULL AND "donation_history"."verified_at" IS NULL)
        OR ("donation_history"."verification_status" <> 'UNVERIFIED' AND "donation_history"."verified_by" IS NOT NULL AND "donation_history"."verified_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "donor_eligibility_calculations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"donor_id" uuid NOT NULL,
	"trigger_type" "eligibility_calc_trigger" NOT NULL,
	"source_donation_id" uuid,
	"source_donated_at" timestamp with time zone,
	"rule_id" uuid,
	"considered_rule_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"interval_days_used" integer,
	"rule_scope_used" interval_rule_scope,
	"rule_effective_from" date,
	"rule_effective_to" date,
	"rule_source_note" text,
	"outcome" "eligibility_calc_outcome" NOT NULL,
	"next_eligible_at" timestamp with time zone,
	"status" "eligibility_calc_status" DEFAULT 'CURRENT' NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "donor_eligibility_calc_id_donor_key" UNIQUE("id","donor_id"),
	CONSTRAINT "donor_eligibility_calc_outcome_shape" CHECK (("donor_eligibility_calculations"."outcome" = 'COMPUTED' AND "donor_eligibility_calculations"."source_donation_id" IS NOT NULL AND "donor_eligibility_calculations"."source_donated_at" IS NOT NULL AND "donor_eligibility_calculations"."rule_id" IS NOT NULL
            AND "donor_eligibility_calculations"."interval_days_used" IS NOT NULL AND "donor_eligibility_calculations"."rule_scope_used" IS NOT NULL AND "donor_eligibility_calculations"."rule_effective_from" IS NOT NULL
            AND "donor_eligibility_calculations"."rule_source_note" IS NOT NULL AND "donor_eligibility_calculations"."next_eligible_at" IS NOT NULL)
        OR ("donor_eligibility_calculations"."outcome" = 'NO_RULE' AND "donor_eligibility_calculations"."source_donation_id" IS NOT NULL AND "donor_eligibility_calculations"."source_donated_at" IS NOT NULL
            AND "donor_eligibility_calculations"."rule_id" IS NULL AND "donor_eligibility_calculations"."next_eligible_at" IS NULL)
        OR ("donor_eligibility_calculations"."outcome" = 'NO_DONATION' AND "donor_eligibility_calculations"."source_donation_id" IS NULL AND "donor_eligibility_calculations"."rule_id" IS NULL AND "donor_eligibility_calculations"."next_eligible_at" IS NULL)),
	CONSTRAINT "donor_eligibility_calc_rule_considered" CHECK ("donor_eligibility_calculations"."rule_id" IS NULL OR "donor_eligibility_calculations"."rule_id" = ANY ("donor_eligibility_calculations"."considered_rule_ids")),
	CONSTRAINT "donor_eligibility_calc_interval_positive" CHECK ("donor_eligibility_calculations"."interval_days_used" IS NULL OR "donor_eligibility_calculations"."interval_days_used" > 0)
);
--> statement-breakpoint
CREATE TABLE "donor_locations" (
	"donor_id" uuid PRIMARY KEY NOT NULL,
	"location_exact" geography(Point,4326) NOT NULL,
	"location_coarse" geography(Point,4326) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "donor_verifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"donor_id" uuid NOT NULL,
	"id_type" text NOT NULL,
	"id_last4" text,
	"id_name" text,
	"status" "verification_status" DEFAULT 'PENDING' NOT NULL,
	"reviewed_by" uuid,
	"reviewed_at" timestamp with time zone,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "donor_verifications_donor_key" UNIQUE("donor_id"),
	CONSTRAINT "donor_verifications_id_type_format" CHECK ("donor_verifications"."id_type" ~ '^[A-Z][A-Z0-9_]*$'),
	CONSTRAINT "donor_verifications_id_last4_format" CHECK ("donor_verifications"."id_last4" IS NULL OR "donor_verifications"."id_last4" ~ '^[0-9]{4}$'),
	CONSTRAINT "donor_verifications_review_recorded" CHECK ("donor_verifications"."status" NOT IN ('VERIFIED', 'REJECTED') OR ("donor_verifications"."reviewed_by" IS NOT NULL AND "donor_verifications"."reviewed_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "donors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"blood_group" "blood_group" NOT NULL,
	"verification_status" "verification_status" DEFAULT 'PENDING' NOT NULL,
	"availability_status" "availability_status" DEFAULT 'UNAVAILABLE' NOT NULL,
	"availability_until" timestamp with time zone,
	"next_eligible_donation_at" timestamp with time zone,
	"current_eligibility_calc_id" uuid,
	"self_reported_eligibility" boolean,
	"last_active_at" timestamp with time zone,
	"status" "donor_status" DEFAULT 'ACTIVE' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "donors_user_id_key" UNIQUE("user_id"),
	CONSTRAINT "donors_availability_until_temporary" CHECK ("donors"."availability_until" IS NULL OR "donors"."availability_status" = 'TEMPORARILY_UNAVAILABLE')
);
--> statement-breakpoint
ALTER TABLE "patients" ADD CONSTRAINT "patients_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patients" ADD CONSTRAINT "patients_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_profiles" ADD CONSTRAINT "user_profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_granted_by_users_id_fk" FOREIGN KEY ("granted_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blood_banks" ADD CONSTRAINT "blood_banks_facility_fk" FOREIGN KEY ("facility_id","facility_type") REFERENCES "public"."facilities"("id","facility_type") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "facilities" ADD CONSTRAINT "facilities_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "facility_memberships" ADD CONSTRAINT "facility_memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "facility_memberships" ADD CONSTRAINT "facility_memberships_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "facility_memberships" ADD CONSTRAINT "facility_memberships_invited_by_users_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "facility_verifications" ADD CONSTRAINT "facility_verifications_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "facility_verifications" ADD CONSTRAINT "facility_verifications_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hospitals" ADD CONSTRAINT "hospitals_facility_fk" FOREIGN KEY ("facility_id","facility_type") REFERENCES "public"."facilities"("id","facility_type") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "donation_interval_rules" ADD CONSTRAINT "donation_interval_rules_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "donation_interval_rules" ADD CONSTRAINT "donation_interval_rules_entered_by_users_id_fk" FOREIGN KEY ("entered_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eligibility_rules" ADD CONSTRAINT "eligibility_rules_entered_by_users_id_fk" FOREIGN KEY ("entered_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "donation_history" ADD CONSTRAINT "donation_history_donor_id_donors_id_fk" FOREIGN KEY ("donor_id") REFERENCES "public"."donors"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "donation_history" ADD CONSTRAINT "donation_history_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "donation_history" ADD CONSTRAINT "donation_history_recorded_by_users_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "donation_history" ADD CONSTRAINT "donation_history_verified_by_users_id_fk" FOREIGN KEY ("verified_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "donor_eligibility_calculations" ADD CONSTRAINT "donor_eligibility_calculations_donor_id_donors_id_fk" FOREIGN KEY ("donor_id") REFERENCES "public"."donors"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "donor_eligibility_calculations" ADD CONSTRAINT "donor_eligibility_calculations_rule_id_donation_interval_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."donation_interval_rules"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "donor_eligibility_calculations" ADD CONSTRAINT "donor_eligibility_calc_source_donation_fk" FOREIGN KEY ("source_donation_id","donor_id") REFERENCES "public"."donation_history"("id","donor_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "donor_locations" ADD CONSTRAINT "donor_locations_donor_id_donors_id_fk" FOREIGN KEY ("donor_id") REFERENCES "public"."donors"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "donor_verifications" ADD CONSTRAINT "donor_verifications_donor_id_donors_id_fk" FOREIGN KEY ("donor_id") REFERENCES "public"."donors"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "donor_verifications" ADD CONSTRAINT "donor_verifications_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "donors" ADD CONSTRAINT "donors_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "donors" ADD CONSTRAINT "donors_current_calc_fk" FOREIGN KEY ("current_eligibility_calc_id","id") REFERENCES "public"."donor_eligibility_calculations"("id","donor_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "patients_created_by_idx" ON "patients" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX "patients_user_id_idx" ON "patients" USING btree ("user_id") WHERE "patients"."user_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "user_roles_role_idx" ON "user_roles" USING btree ("role_id");--> statement-breakpoint
CREATE INDEX "users_status_idx" ON "users" USING btree ("status");--> statement-breakpoint
CREATE INDEX "facilities_location_gist" ON "facilities" USING gist ("location");--> statement-breakpoint
CREATE INDEX "facilities_public_listing_idx" ON "facilities" USING btree ("facility_type") WHERE "facilities"."verification_status" = 'VERIFIED' AND "facilities"."status" = 'ACTIVE';--> statement-breakpoint
CREATE INDEX "facilities_created_by_idx" ON "facilities" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX "facility_memberships_active_user_idx" ON "facility_memberships" USING btree ("user_id") WHERE "facility_memberships"."status" = 'ACTIVE';--> statement-breakpoint
CREATE INDEX "facility_memberships_active_facility_idx" ON "facility_memberships" USING btree ("facility_id") WHERE "facility_memberships"."status" = 'ACTIVE';--> statement-breakpoint
CREATE INDEX "facility_verifications_open_idx" ON "facility_verifications" USING btree ("status") WHERE "facility_verifications"."status" IN ('PENDING', 'UNDER_REVIEW');--> statement-breakpoint
CREATE INDEX "compatibility_rules_lookup_idx" ON "compatibility_rules" USING btree ("component","recipient_group","donor_group","effective_from");--> statement-breakpoint
CREATE INDEX "donation_interval_rules_lookup_idx" ON "donation_interval_rules" USING btree ("donation_type","scope","effective_from");--> statement-breakpoint
CREATE INDEX "donation_interval_rules_facility_idx" ON "donation_interval_rules" USING btree ("facility_id") WHERE "donation_interval_rules"."facility_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "eligibility_rules_key_from_idx" ON "eligibility_rules" USING btree ("rule_key","effective_from");--> statement-breakpoint
CREATE INDEX "donation_history_donor_idx" ON "donation_history" USING btree ("donor_id","verification_status","donated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "donation_history_facility_idx" ON "donation_history" USING btree ("facility_id") WHERE "donation_history"."facility_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "donation_history_request_idx" ON "donation_history" USING btree ("request_id") WHERE "donation_history"."request_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "donor_eligibility_calc_current_key" ON "donor_eligibility_calculations" USING btree ("donor_id") WHERE "donor_eligibility_calculations"."status" = 'CURRENT';--> statement-breakpoint
CREATE INDEX "donor_eligibility_calc_donor_idx" ON "donor_eligibility_calculations" USING btree ("donor_id","computed_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "donor_eligibility_calc_rule_idx" ON "donor_eligibility_calculations" USING btree ("rule_id") WHERE "donor_eligibility_calculations"."rule_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "donor_eligibility_calc_source_idx" ON "donor_eligibility_calculations" USING btree ("source_donation_id") WHERE "donor_eligibility_calculations"."source_donation_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "donor_eligibility_calc_considered_gin" ON "donor_eligibility_calculations" USING gin ("considered_rule_ids");--> statement-breakpoint
CREATE INDEX "donor_locations_exact_gist" ON "donor_locations" USING gist ("location_exact");--> statement-breakpoint
CREATE INDEX "donor_locations_coarse_gist" ON "donor_locations" USING gist ("location_coarse");--> statement-breakpoint
CREATE INDEX "donor_verifications_open_idx" ON "donor_verifications" USING btree ("status") WHERE "donor_verifications"."status" IN ('PENDING', 'UNDER_REVIEW');--> statement-breakpoint
CREATE INDEX "donors_eligible_pool_idx" ON "donors" USING btree ("blood_group","next_eligible_donation_at") WHERE "donors"."verification_status" = 'VERIFIED' AND "donors"."availability_status" = 'AVAILABLE' AND "donors"."status" = 'ACTIVE';--> statement-breakpoint
CREATE INDEX "donors_verification_status_idx" ON "donors" USING btree ("verification_status");--> statement-breakpoint
CREATE INDEX "donors_next_eligible_idx" ON "donors" USING btree ("next_eligible_donation_at");