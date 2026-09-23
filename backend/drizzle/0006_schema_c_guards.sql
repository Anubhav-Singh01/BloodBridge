-- Batch 3.4 guards. Every rule here is already written in DATABASE.md (sections 2.7, 2.8, 6, 7 and 9) and ML.md (sections 6 and 8).
-- Nothing is applied until Batch 3.5.

-- updated_at is maintained by the database (DATABASE.md section 3). bb_touch_updated_at is defined in 0002.
CREATE TRIGGER trg_donor_searches_touch_updated_at BEFORE UPDATE ON donor_searches FOR EACH ROW EXECUTE FUNCTION bb_touch_updated_at();
--> statement-breakpoint
CREATE TRIGGER trg_notification_batches_touch_updated_at BEFORE UPDATE ON notification_batches FOR EACH ROW EXECUTE FUNCTION bb_touch_updated_at();
--> statement-breakpoint
CREATE TRIGGER trg_donor_matches_touch_updated_at BEFORE UPDATE ON donor_matches FOR EACH ROW EXECUTE FUNCTION bb_touch_updated_at();
--> statement-breakpoint
CREATE TRIGGER trg_ml_model_versions_touch_updated_at BEFORE UPDATE ON ml_model_versions FOR EACH ROW EXECUTE FUNCTION bb_touch_updated_at();
--> statement-breakpoint
CREATE TRIGGER trg_settings_touch_updated_at BEFORE UPDATE ON settings FOR EACH ROW EXECUTE FUNCTION bb_touch_updated_at();
--> statement-breakpoint
CREATE TRIGGER trg_notification_deliveries_touch_updated_at BEFORE UPDATE ON notification_deliveries FOR EACH ROW EXECUTE FUNCTION bb_touch_updated_at();
--> statement-breakpoint
CREATE TRIGGER trg_data_deletion_requests_touch_updated_at BEFORE UPDATE ON data_deletion_requests FOR EACH ROW EXECUTE FUNCTION bb_touch_updated_at();
--> statement-breakpoint
-- Append-only: ranking history, responses, audit and location-access logs. bb_forbid_update is defined in 0004.
CREATE TRIGGER trg_ranking_runs_no_update BEFORE UPDATE ON ranking_runs FOR EACH ROW EXECUTE FUNCTION bb_forbid_update();
--> statement-breakpoint
CREATE TRIGGER trg_ranking_runs_no_delete BEFORE DELETE ON ranking_runs FOR EACH ROW EXECUTE FUNCTION bb_forbid_delete();
--> statement-breakpoint
CREATE TRIGGER trg_ranking_predictions_no_update BEFORE UPDATE ON ranking_predictions FOR EACH ROW EXECUTE FUNCTION bb_forbid_update();
--> statement-breakpoint
CREATE TRIGGER trg_ranking_predictions_no_delete BEFORE DELETE ON ranking_predictions FOR EACH ROW EXECUTE FUNCTION bb_forbid_delete();
--> statement-breakpoint
CREATE TRIGGER trg_donor_responses_no_update BEFORE UPDATE ON donor_responses FOR EACH ROW EXECUTE FUNCTION bb_forbid_update();
--> statement-breakpoint
CREATE TRIGGER trg_donor_responses_no_delete BEFORE DELETE ON donor_responses FOR EACH ROW EXECUTE FUNCTION bb_forbid_delete();
--> statement-breakpoint
CREATE TRIGGER trg_audit_logs_no_update BEFORE UPDATE ON audit_logs FOR EACH ROW EXECUTE FUNCTION bb_forbid_update();
--> statement-breakpoint
CREATE TRIGGER trg_audit_logs_no_delete BEFORE DELETE ON audit_logs FOR EACH ROW EXECUTE FUNCTION bb_forbid_delete();
--> statement-breakpoint
CREATE TRIGGER trg_location_access_logs_no_update BEFORE UPDATE ON location_access_logs FOR EACH ROW EXECUTE FUNCTION bb_forbid_update();
--> statement-breakpoint
CREATE TRIGGER trg_location_access_logs_no_delete BEFORE DELETE ON location_access_logs FOR EACH ROW EXECUTE FUNCTION bb_forbid_delete();
--> statement-breakpoint
-- History that is kept (DATABASE.md section 8): these rows are never deleted.
CREATE TRIGGER trg_donor_searches_no_delete BEFORE DELETE ON donor_searches FOR EACH ROW EXECUTE FUNCTION bb_forbid_delete();
--> statement-breakpoint
CREATE TRIGGER trg_notification_batches_no_delete BEFORE DELETE ON notification_batches FOR EACH ROW EXECUTE FUNCTION bb_forbid_delete();
--> statement-breakpoint
CREATE TRIGGER trg_donor_matches_no_delete BEFORE DELETE ON donor_matches FOR EACH ROW EXECUTE FUNCTION bb_forbid_delete();
--> statement-breakpoint
CREATE TRIGGER trg_ml_model_versions_no_delete BEFORE DELETE ON ml_model_versions FOR EACH ROW EXECUTE FUNCTION bb_forbid_delete();
--> statement-breakpoint
CREATE TRIGGER trg_data_deletion_requests_no_delete BEFORE DELETE ON data_deletion_requests FOR EACH ROW EXECUTE FUNCTION bb_forbid_delete();
--> statement-breakpoint
-- Ranking runs (ML.md sections 6 and 8). A FALLBACK run must carry the label 'rule-based-fallback' and an ML run must not: that is
-- the CHECK ranking_runs_fallback_version. An ML run must also name a registered model, which a column-level foreign key
-- cannot express because FALLBACK rows have no registry row. The registry rows are never deleted (trigger above) and their
-- model_version never changes (trigger below), so the reference cannot go stale. Runs are append-only, so an insert-time
-- check is enough. Which registered model may be used (for example ACTIVE only) is decided by the ranking service.
CREATE OR REPLACE FUNCTION bb_ranking_run_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.ranker_type = 'ML' AND NOT EXISTS (
    SELECT 1 FROM ml_model_versions WHERE model_version = NEW.model_version
  ) THEN
    RAISE EXCEPTION 'An ML ranking run must reference an existing ml_model_versions.model_version, got %', NEW.model_version
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER trg_ranking_run_guard BEFORE INSERT ON ranking_runs FOR EACH ROW EXECUTE FUNCTION bb_ranking_run_guard();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION bb_ml_model_version_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.model_version IS DISTINCT FROM OLD.model_version THEN
    RAISE EXCEPTION 'model_version of a registered model cannot change'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER trg_ml_model_version_guard BEFORE UPDATE ON ml_model_versions FOR EACH ROW EXECUTE FUNCTION bb_ml_model_version_guard();
--> statement-breakpoint
-- notification_batches: the ranking run of a batch is set once. A PENDING batch may start with no run, so NULL -> run is
-- allowed. Once a run is set it never changes and never goes back to NULL, which keeps fixed the run that
-- bb_donor_match_guard (below) compares each selected prediction against. IS DISTINCT FROM is NULL-safe, so run -> NULL
-- is caught; a plain <> would let it through.
CREATE OR REPLACE FUNCTION bb_notification_batch_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.ranking_run_id IS NOT NULL AND NEW.ranking_run_id IS DISTINCT FROM OLD.ranking_run_id THEN
    RAISE EXCEPTION 'ranking_run_id of a notification batch cannot change once it is set'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER trg_notification_batch_guard BEFORE UPDATE ON notification_batches FOR EACH ROW EXECUTE FUNCTION bb_notification_batch_guard();
--> statement-breakpoint
-- donor_matches (DATABASE.md sections 6 and 7): the match identity never changes, batch_id, selected_prediction_id and
-- arrived_at are set once, and a donor selected in a batch must carry a prediction from the ranking run attached to that
-- batch. When both batch_id and selected_prediction_id are set, the batch must have a ranking run, and it must be the run
-- the prediction belongs to.
CREATE OR REPLACE FUNCTION bb_donor_match_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  batch_run uuid;
  prediction_run uuid;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.search_id IS DISTINCT FROM OLD.search_id OR NEW.donor_id IS DISTINCT FROM OLD.donor_id THEN
      RAISE EXCEPTION 'search_id and donor_id of a donor match are immutable'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF OLD.batch_id IS NOT NULL AND NEW.batch_id IS DISTINCT FROM OLD.batch_id THEN
      RAISE EXCEPTION 'batch_id of a donor match cannot change once it is set'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF OLD.selected_prediction_id IS NOT NULL AND NEW.selected_prediction_id IS DISTINCT FROM OLD.selected_prediction_id THEN
      RAISE EXCEPTION 'selected_prediction_id of a donor match cannot change once it is set'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF OLD.arrived_at IS NOT NULL AND NEW.arrived_at IS DISTINCT FROM OLD.arrived_at THEN
      RAISE EXCEPTION 'arrived_at of a donor match is set once and never overwritten'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  IF NEW.batch_id IS NOT NULL AND NEW.selected_prediction_id IS NOT NULL THEN
    SELECT ranking_run_id INTO batch_run FROM notification_batches WHERE id = NEW.batch_id;
    IF batch_run IS NULL THEN
      RAISE EXCEPTION 'The batch of a contacted donor must have a ranking run attached'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    SELECT ranking_run_id INTO prediction_run FROM ranking_predictions WHERE id = NEW.selected_prediction_id;
    IF prediction_run IS DISTINCT FROM batch_run THEN
      RAISE EXCEPTION 'The selected prediction must come from the ranking run attached to the batch'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER trg_donor_match_guard BEFORE INSERT OR UPDATE ON donor_matches FOR EACH ROW EXECUTE FUNCTION bb_donor_match_guard();
--> statement-breakpoint
-- request_events: an event that names a match must name a match of the same request (API.md 6.4).
CREATE OR REPLACE FUNCTION bb_request_event_match_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.match_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM donor_matches m JOIN donor_searches s ON s.id = m.search_id
    WHERE m.id = NEW.match_id AND s.request_id = NEW.request_id
  ) THEN
    RAISE EXCEPTION 'The match of a request event must belong to the same request'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER trg_request_events_match_guard BEFORE INSERT ON request_events FOR EACH ROW EXECUTE FUNCTION bb_request_event_match_guard();
--> statement-breakpoint
-- The coarse-only view for patient-facing and public repositories (DATABASE.md section 9).
CREATE VIEW donor_locations_coarse AS
  SELECT donor_id, location_coarse, updated_at
  FROM donor_locations;
