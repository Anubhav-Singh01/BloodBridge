CREATE TYPE "public"."batch_status" AS ENUM('PENDING', 'ACTIVE', 'EVALUATED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."deletion_request_source" AS ENUM('USER_REQUEST', 'CLERK_WEBHOOK');--> statement-breakpoint
CREATE TYPE "public"."deletion_request_status" AS ENUM('PENDING', 'COMPLETED');--> statement-breakpoint
CREATE TYPE "public"."delivery_status" AS ENUM('PENDING', 'SENT', 'DELIVERED', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."donor_response_kind" AS ENUM('ACCEPTED', 'DECLINED', 'NO_RESPONSE', 'EXPIRED');--> statement-breakpoint
CREATE TYPE "public"."match_status" AS ENUM('CANDIDATE', 'EXCLUDED', 'NOTIFIED', 'ACCEPTED', 'CONFIRMED', 'WAITLISTED', 'DECLINED', 'NO_RESPONSE', 'EXPIRED', 'DROPPED', 'COMPLETED');--> statement-breakpoint
CREATE TYPE "public"."model_status" AS ENUM('CANDIDATE', 'ACTIVE', 'RETIRED');--> statement-breakpoint
CREATE TYPE "public"."notification_channel" AS ENUM('IN_APP', 'EMAIL', 'SMS', 'PUSH');--> statement-breakpoint
CREATE TYPE "public"."ranker_type" AS ENUM('ML', 'FALLBACK');--> statement-breakpoint
CREATE TYPE "public"."ranking_trigger" AS ENUM('INITIAL', 'BATCH_ADVANCE', 'CANDIDATE_SET_CHANGED', 'INPUTS_CHANGED', 'MODEL_CHANGED', 'FRESHNESS_EXPIRED');--> statement-breakpoint
CREATE TYPE "public"."search_status" AS ENUM('ACTIVE', 'FULFILLED', 'EXHAUSTED', 'CANCELLED', 'EXPIRED');--> statement-breakpoint
CREATE TABLE "donor_matches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"search_id" uuid NOT NULL,
	"donor_id" uuid NOT NULL,
	"batch_id" uuid,
	"selected_prediction_id" uuid,
	"status" "match_status" DEFAULT 'CANDIDATE' NOT NULL,
	"distance_km" double precision,
	"eta_minutes" integer,
	"fatigue_bypass" boolean DEFAULT false NOT NULL,
	"exclusion_reason" text,
	"notified_at" timestamp with time zone,
	"responded_at" timestamp with time zone,
	"arrived_at" timestamp with time zone,
	"location_consent_at" timestamp with time zone,
	"drop_reason" text,
	"dropped_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "donor_matches_search_donor_key" UNIQUE("search_id","donor_id"),
	CONSTRAINT "donor_matches_batch_by_status" CHECK (("donor_matches"."status" IN ('CANDIDATE', 'EXCLUDED') AND "donor_matches"."batch_id" IS NULL)
        OR ("donor_matches"."status" NOT IN ('CANDIDATE', 'EXCLUDED') AND "donor_matches"."batch_id" IS NOT NULL AND "donor_matches"."notified_at" IS NOT NULL)),
	CONSTRAINT "donor_matches_selection_consistent" CHECK (("donor_matches"."batch_id" IS NULL) = ("donor_matches"."selected_prediction_id" IS NULL)),
	CONSTRAINT "donor_matches_exclusion_reason" CHECK (("donor_matches"."status" = 'EXCLUDED') = ("donor_matches"."exclusion_reason" IS NOT NULL)),
	CONSTRAINT "donor_matches_drop_reason" CHECK (("donor_matches"."status" = 'DROPPED') = ("donor_matches"."drop_reason" IS NOT NULL)),
	CONSTRAINT "donor_matches_dropped_by_only_when_dropped" CHECK ("donor_matches"."dropped_by" IS NULL OR "donor_matches"."status" = 'DROPPED'),
	CONSTRAINT "donor_matches_arrived_status" CHECK ("donor_matches"."arrived_at" IS NULL OR "donor_matches"."status" IN ('CONFIRMED', 'COMPLETED', 'DROPPED')),
	CONSTRAINT "donor_matches_consent_needs_batch" CHECK ("donor_matches"."location_consent_at" IS NULL OR "donor_matches"."batch_id" IS NOT NULL),
	CONSTRAINT "donor_matches_reason_code_format" CHECK (("donor_matches"."exclusion_reason" IS NULL OR "donor_matches"."exclusion_reason" ~ '^[A-Z][A-Z0-9_]*$') AND ("donor_matches"."drop_reason" IS NULL OR "donor_matches"."drop_reason" ~ '^[A-Z][A-Z0-9_]*$')),
	CONSTRAINT "donor_matches_distance_eta_non_negative" CHECK (("donor_matches"."distance_km" IS NULL OR "donor_matches"."distance_km" >= 0) AND ("donor_matches"."eta_minutes" IS NULL OR "donor_matches"."eta_minutes" >= 0))
);
--> statement-breakpoint
CREATE TABLE "donor_responses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"match_id" uuid NOT NULL,
	"response" "donor_response_kind" NOT NULL,
	"responded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"latency_seconds" integer,
	CONSTRAINT "donor_responses_match_key" UNIQUE("match_id"),
	CONSTRAINT "donor_responses_latency_non_negative" CHECK ("donor_responses"."latency_seconds" IS NULL OR "donor_responses"."latency_seconds" >= 0)
);
--> statement-breakpoint
CREATE TABLE "donor_searches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" uuid NOT NULL,
	"config_snapshot" jsonb NOT NULL,
	"status" "search_status" DEFAULT 'ACTIVE' NOT NULL,
	"required_donors" integer NOT NULL,
	"confirmed_count" integer DEFAULT 0 NOT NULL,
	"batch_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "donor_searches_request_key" UNIQUE("request_id"),
	CONSTRAINT "donor_searches_required_positive" CHECK ("donor_searches"."required_donors" > 0),
	CONSTRAINT "donor_searches_confirmed_within_required" CHECK ("donor_searches"."confirmed_count" >= 0 AND "donor_searches"."confirmed_count" <= "donor_searches"."required_donors"),
	CONSTRAINT "donor_searches_batch_count_non_negative" CHECK ("donor_searches"."batch_count" >= 0),
	CONSTRAINT "donor_searches_config_is_object" CHECK (jsonb_typeof("donor_searches"."config_snapshot") = 'object')
);
--> statement-breakpoint
CREATE TABLE "ml_model_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"model_version" text NOT NULL,
	"algorithm" text NOT NULL,
	"dataset_version" text NOT NULL,
	"features_used" text[] NOT NULL,
	"metrics" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"trained_at" timestamp with time zone NOT NULL,
	"artifact_ref" text NOT NULL,
	"status" "model_status" DEFAULT 'CANDIDATE' NOT NULL,
	"activated_at" timestamp with time zone,
	"activated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ml_model_versions_model_version_key" UNIQUE("model_version"),
	CONSTRAINT "ml_model_versions_version_not_blank" CHECK (length(btrim("ml_model_versions"."model_version")) > 0),
	CONSTRAINT "ml_model_versions_not_fallback_label" CHECK ("ml_model_versions"."model_version" <> 'rule-based-fallback'),
	CONSTRAINT "ml_model_versions_activation_recorded" CHECK ("ml_model_versions"."status" = 'CANDIDATE' OR ("ml_model_versions"."activated_at" IS NOT NULL AND "ml_model_versions"."activated_by" IS NOT NULL)),
	CONSTRAINT "ml_model_versions_metrics_is_object" CHECK (jsonb_typeof("ml_model_versions"."metrics") = 'object')
);
--> statement-breakpoint
CREATE TABLE "notification_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"search_id" uuid NOT NULL,
	"batch_number" integer NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"status" "batch_status" DEFAULT 'PENDING' NOT NULL,
	"ranking_run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_batches_search_number_key" UNIQUE("search_id","batch_number"),
	CONSTRAINT "notification_batches_id_search_key" UNIQUE("id","search_id"),
	CONSTRAINT "notification_batches_number_positive" CHECK ("notification_batches"."batch_number" > 0),
	CONSTRAINT "notification_batches_expiry_after_open" CHECK ("notification_batches"."expires_at" > "notification_batches"."opened_at")
);
--> statement-breakpoint
CREATE TABLE "ranking_predictions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ranking_run_id" uuid NOT NULL,
	"donor_id" uuid NOT NULL,
	"rank" integer NOT NULL,
	"score" double precision NOT NULL,
	"reasons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"feature_snapshot" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ranking_predictions_run_donor_key" UNIQUE("ranking_run_id","donor_id"),
	CONSTRAINT "ranking_predictions_id_donor_key" UNIQUE("id","donor_id"),
	CONSTRAINT "ranking_predictions_rank_positive" CHECK ("ranking_predictions"."rank" >= 1),
	CONSTRAINT "ranking_predictions_reasons_is_array" CHECK (jsonb_typeof("ranking_predictions"."reasons") = 'array'),
	CONSTRAINT "ranking_predictions_snapshot_is_object" CHECK (jsonb_typeof("ranking_predictions"."feature_snapshot") = 'object')
);
--> statement-breakpoint
CREATE TABLE "ranking_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"search_id" uuid NOT NULL,
	"ranker_type" "ranker_type" NOT NULL,
	"model_version" text NOT NULL,
	"ranked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"trigger_type" "ranking_trigger" NOT NULL,
	"input_count" integer NOT NULL,
	CONSTRAINT "ranking_runs_id_search_key" UNIQUE("id","search_id"),
	CONSTRAINT "ranking_runs_input_count_non_negative" CHECK ("ranking_runs"."input_count" >= 0),
	CONSTRAINT "ranking_runs_model_version_not_blank" CHECK (length(btrim("ranking_runs"."model_version")) > 0),
	CONSTRAINT "ranking_runs_fallback_version" CHECK (("ranking_runs"."ranker_type" = 'FALLBACK') = ("ranking_runs"."model_version" = 'rule-based-fallback'))
);
--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_id" uuid,
	"action" text NOT NULL,
	"entity_type" text,
	"entity_id" uuid,
	"correlation_id" text,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "audit_logs_action_format" CHECK ("audit_logs"."action" ~ '^[A-Z][A-Z0-9_]*$'),
	CONSTRAINT "audit_logs_entity_type_format" CHECK ("audit_logs"."entity_type" IS NULL OR "audit_logs"."entity_type" ~ '^[A-Z][A-Z0-9_]*$'),
	CONSTRAINT "audit_logs_entity_needs_type" CHECK ("audit_logs"."entity_id" IS NULL OR "audit_logs"."entity_type" IS NOT NULL),
	CONSTRAINT "audit_logs_details_is_object" CHECK (jsonb_typeof("audit_logs"."details") = 'object')
);
--> statement-breakpoint
CREATE TABLE "data_deletion_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"source" "deletion_request_source" NOT NULL,
	"status" "deletion_request_status" DEFAULT 'PENDING' NOT NULL,
	"legal_hold" boolean DEFAULT false NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "data_deletion_requests_completion_recorded" CHECK (("data_deletion_requests"."status" = 'COMPLETED') = ("data_deletion_requests"."completed_at" IS NOT NULL)),
	CONSTRAINT "data_deletion_requests_hold_blocks_completion" CHECK (NOT ("data_deletion_requests"."status" = 'COMPLETED' AND "data_deletion_requests"."legal_hold"))
);
--> statement-breakpoint
CREATE TABLE "idempotency_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"key" text NOT NULL,
	"request_fingerprint" text NOT NULL,
	"response_ref" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "idempotency_keys_user_key_key" UNIQUE("user_id","key"),
	CONSTRAINT "idempotency_keys_key_not_blank" CHECK (length(btrim("idempotency_keys"."key")) > 0 AND length(btrim("idempotency_keys"."request_fingerprint")) > 0),
	CONSTRAINT "idempotency_keys_expiry_after_creation" CHECK ("idempotency_keys"."expires_at" > "idempotency_keys"."created_at")
);
--> statement-breakpoint
CREATE TABLE "location_access_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"accessor_id" uuid NOT NULL,
	"donor_id" uuid NOT NULL,
	"request_id" uuid,
	"purpose" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "location_access_logs_purpose_format" CHECK ("location_access_logs"."purpose" ~ '^[A-Z][A-Z0-9_]*$')
);
--> statement-breakpoint
CREATE TABLE "notification_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"notification_id" uuid NOT NULL,
	"channel" "notification_channel" NOT NULL,
	"provider" text,
	"status" "delivery_status" DEFAULT 'PENDING' NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_deliveries_notification_channel_key" UNIQUE("notification_id","channel"),
	CONSTRAINT "notification_deliveries_error_only_when_failed" CHECK ("notification_deliveries"."error" IS NULL OR "notification_deliveries"."status" = 'FAILED')
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"type" text NOT NULL,
	"title" text,
	"body" text,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"request_id" uuid,
	"match_id" uuid,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notifications_type_format" CHECK ("notifications"."type" ~ '^[A-Z][A-Z0-9_]*$'),
	CONSTRAINT "notifications_data_is_object" CHECK (jsonb_typeof("notifications"."data") = 'object')
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"value" jsonb NOT NULL,
	"scope" text,
	"urgency" text,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "settings_key_scope_urgency_key" UNIQUE NULLS NOT DISTINCT("key","scope","urgency"),
	CONSTRAINT "settings_key_format" CHECK ("settings"."key" ~ '^[A-Za-z][A-Za-z0-9_.]*$'),
	CONSTRAINT "settings_scope_reserved" CHECK ("settings"."scope" IS NULL)
);
--> statement-breakpoint
CREATE TABLE "webhook_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"provider_event_id" text NOT NULL,
	"event_type" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"last_error" text,
	CONSTRAINT "webhook_events_provider_event_key" UNIQUE("provider","provider_event_id"),
	CONSTRAINT "webhook_events_fields_not_blank" CHECK (length(btrim("webhook_events"."provider")) > 0 AND length(btrim("webhook_events"."provider_event_id")) > 0 AND length(btrim("webhook_events"."event_type")) > 0)
);
--> statement-breakpoint
ALTER TABLE "donor_matches" ADD CONSTRAINT "donor_matches_search_id_donor_searches_id_fk" FOREIGN KEY ("search_id") REFERENCES "public"."donor_searches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "donor_matches" ADD CONSTRAINT "donor_matches_donor_id_donors_id_fk" FOREIGN KEY ("donor_id") REFERENCES "public"."donors"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "donor_matches" ADD CONSTRAINT "donor_matches_dropped_by_users_id_fk" FOREIGN KEY ("dropped_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "donor_matches" ADD CONSTRAINT "donor_matches_batch_fk" FOREIGN KEY ("batch_id","search_id") REFERENCES "public"."notification_batches"("id","search_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "donor_matches" ADD CONSTRAINT "donor_matches_prediction_fk" FOREIGN KEY ("selected_prediction_id","donor_id") REFERENCES "public"."ranking_predictions"("id","donor_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "donor_responses" ADD CONSTRAINT "donor_responses_match_id_donor_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."donor_matches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "donor_searches" ADD CONSTRAINT "donor_searches_request_id_blood_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."blood_requests"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ml_model_versions" ADD CONSTRAINT "ml_model_versions_activated_by_users_id_fk" FOREIGN KEY ("activated_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_batches" ADD CONSTRAINT "notification_batches_search_id_donor_searches_id_fk" FOREIGN KEY ("search_id") REFERENCES "public"."donor_searches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_batches" ADD CONSTRAINT "notification_batches_run_fk" FOREIGN KEY ("ranking_run_id","search_id") REFERENCES "public"."ranking_runs"("id","search_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ranking_predictions" ADD CONSTRAINT "ranking_predictions_ranking_run_id_ranking_runs_id_fk" FOREIGN KEY ("ranking_run_id") REFERENCES "public"."ranking_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ranking_predictions" ADD CONSTRAINT "ranking_predictions_donor_id_donors_id_fk" FOREIGN KEY ("donor_id") REFERENCES "public"."donors"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ranking_runs" ADD CONSTRAINT "ranking_runs_search_id_donor_searches_id_fk" FOREIGN KEY ("search_id") REFERENCES "public"."donor_searches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_deletion_requests" ADD CONSTRAINT "data_deletion_requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "location_access_logs" ADD CONSTRAINT "location_access_logs_accessor_id_users_id_fk" FOREIGN KEY ("accessor_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "location_access_logs" ADD CONSTRAINT "location_access_logs_donor_id_donors_id_fk" FOREIGN KEY ("donor_id") REFERENCES "public"."donors"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "location_access_logs" ADD CONSTRAINT "location_access_logs_request_id_blood_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."blood_requests"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_notification_id_notifications_id_fk" FOREIGN KEY ("notification_id") REFERENCES "public"."notifications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_request_id_blood_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."blood_requests"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_match_id_donor_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."donor_matches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settings" ADD CONSTRAINT "settings_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "donor_matches_search_status_idx" ON "donor_matches" USING btree ("search_id","status");--> statement-breakpoint
CREATE INDEX "donor_matches_donor_notified_idx" ON "donor_matches" USING btree ("donor_id","notified_at" DESC NULLS LAST) WHERE "donor_matches"."notified_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "donor_matches_batch_idx" ON "donor_matches" USING btree ("batch_id") WHERE "donor_matches"."batch_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "donor_matches_prediction_idx" ON "donor_matches" USING btree ("selected_prediction_id") WHERE "donor_matches"."selected_prediction_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "donor_responses_responded_idx" ON "donor_responses" USING btree ("responded_at");--> statement-breakpoint
CREATE INDEX "donor_searches_active_idx" ON "donor_searches" USING btree ("status") WHERE "donor_searches"."status" = 'ACTIVE';--> statement-breakpoint
CREATE UNIQUE INDEX "ml_model_versions_one_active" ON "ml_model_versions" USING btree ("status") WHERE "ml_model_versions"."status" = 'ACTIVE';--> statement-breakpoint
CREATE UNIQUE INDEX "notification_batches_one_active_per_search" ON "notification_batches" USING btree ("search_id") WHERE "notification_batches"."status" = 'ACTIVE';--> statement-breakpoint
CREATE INDEX "notification_batches_open_expiry_idx" ON "notification_batches" USING btree ("expires_at") WHERE "notification_batches"."status" = 'ACTIVE';--> statement-breakpoint
CREATE INDEX "notification_batches_ranking_run_idx" ON "notification_batches" USING btree ("ranking_run_id") WHERE "notification_batches"."ranking_run_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "ranking_predictions_donor_idx" ON "ranking_predictions" USING btree ("donor_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "ranking_runs_search_idx" ON "ranking_runs" USING btree ("search_id","ranked_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "audit_logs_at_idx" ON "audit_logs" USING btree ("at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "audit_logs_entity_idx" ON "audit_logs" USING btree ("entity_type","entity_id","at") WHERE "audit_logs"."entity_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "audit_logs_actor_idx" ON "audit_logs" USING btree ("actor_id","at" DESC NULLS LAST) WHERE "audit_logs"."actor_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "audit_logs_action_idx" ON "audit_logs" USING btree ("action","at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "data_deletion_requests_one_pending_per_user" ON "data_deletion_requests" USING btree ("user_id") WHERE "data_deletion_requests"."status" = 'PENDING';--> statement-breakpoint
CREATE INDEX "data_deletion_requests_user_idx" ON "data_deletion_requests" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idempotency_keys_expiry_idx" ON "idempotency_keys" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "location_access_logs_donor_idx" ON "location_access_logs" USING btree ("donor_id","at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "location_access_logs_accessor_idx" ON "location_access_logs" USING btree ("accessor_id","at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "notification_deliveries_pending_idx" ON "notification_deliveries" USING btree ("created_at") WHERE "notification_deliveries"."status" = 'PENDING';--> statement-breakpoint
CREATE INDEX "notifications_user_idx" ON "notifications" USING btree ("user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "notifications_unread_idx" ON "notifications" USING btree ("user_id") WHERE "notifications"."read_at" IS NULL;--> statement-breakpoint
CREATE INDEX "notifications_request_idx" ON "notifications" USING btree ("request_id") WHERE "notifications"."request_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "notifications_match_idx" ON "notifications" USING btree ("match_id") WHERE "notifications"."match_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "webhook_events_unprocessed_idx" ON "webhook_events" USING btree ("received_at") WHERE "webhook_events"."processed_at" IS NULL;--> statement-breakpoint
ALTER TABLE "request_events" ADD CONSTRAINT "request_events_match_id_donor_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."donor_matches"("id") ON DELETE restrict ON UPDATE no action;