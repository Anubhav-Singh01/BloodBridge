-- Batch 3.3 guards. Every rule here is already written in DATABASE.md (sections 2.5, 2.6, 4 and 10).
-- Nothing is applied until Batch 3.5.
CREATE OR REPLACE FUNCTION bb_forbid_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: rows cannot be updated', TG_TABLE_NAME
    USING ERRCODE = 'integrity_constraint_violation';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER trg_blood_units_touch_updated_at BEFORE UPDATE ON blood_units FOR EACH ROW EXECUTE FUNCTION bb_touch_updated_at();
--> statement-breakpoint
CREATE TRIGGER trg_blood_requests_touch_updated_at BEFORE UPDATE ON blood_requests FOR EACH ROW EXECUTE FUNCTION bb_touch_updated_at();
--> statement-breakpoint
-- The allowed request status transitions: DATABASE.md section 4 (29 rows). Actors: API.md 6.7.
INSERT INTO request_transitions (from_status, to_status, allowed_actors) VALUES
  ('DRAFT', 'SUBMITTED', ARRAY['OWNER']::request_actor_kind[]),
  ('DRAFT', 'CANCELLED', ARRAY['OWNER', 'ADMIN', 'SYSTEM']::request_actor_kind[]),
  ('SUBMITTED', 'VERIFICATION_PENDING', ARRAY['OWNER']::request_actor_kind[]),
  ('SUBMITTED', 'ACTIVE', ARRAY['OWNER']::request_actor_kind[]),
  ('SUBMITTED', 'REJECTED', ARRAY['HOSPITAL_STAFF', 'ADMIN']::request_actor_kind[]),
  ('SUBMITTED', 'CANCELLED', ARRAY['OWNER', 'ADMIN', 'SYSTEM']::request_actor_kind[]),
  ('VERIFICATION_PENDING', 'ACTIVE', ARRAY['HOSPITAL_STAFF', 'ADMIN']::request_actor_kind[]),
  ('VERIFICATION_PENDING', 'REJECTED', ARRAY['HOSPITAL_STAFF', 'ADMIN']::request_actor_kind[]),
  ('VERIFICATION_PENDING', 'CANCELLED', ARRAY['OWNER', 'ADMIN', 'SYSTEM']::request_actor_kind[]),
  ('VERIFICATION_PENDING', 'EXPIRED', ARRAY['SYSTEM']::request_actor_kind[]),
  ('ACTIVE', 'DONOR_SEARCH', ARRAY['SYSTEM']::request_actor_kind[]),
  ('ACTIVE', 'FULFILLED', ARRAY['HOSPITAL_STAFF', 'BLOOD_BANK_STAFF']::request_actor_kind[]),
  ('ACTIVE', 'CANCELLED', ARRAY['OWNER', 'ADMIN', 'SYSTEM']::request_actor_kind[]),
  ('ACTIVE', 'EXPIRED', ARRAY['SYSTEM']::request_actor_kind[]),
  ('DONOR_SEARCH', 'DONOR_CONTACTED', ARRAY['SYSTEM']::request_actor_kind[]),
  ('DONOR_SEARCH', 'CANCELLED', ARRAY['OWNER', 'ADMIN', 'SYSTEM']::request_actor_kind[]),
  ('DONOR_SEARCH', 'EXPIRED', ARRAY['SYSTEM']::request_actor_kind[]),
  ('DONOR_CONTACTED', 'DONOR_SEARCH', ARRAY['SYSTEM']::request_actor_kind[]),
  ('DONOR_CONTACTED', 'DONOR_ACCEPTED', ARRAY['DONOR']::request_actor_kind[]),
  ('DONOR_CONTACTED', 'CANCELLED', ARRAY['OWNER', 'ADMIN', 'SYSTEM']::request_actor_kind[]),
  ('DONOR_CONTACTED', 'EXPIRED', ARRAY['SYSTEM']::request_actor_kind[]),
  ('DONOR_ACCEPTED', 'DONOR_CONFIRMED', ARRAY['DONOR']::request_actor_kind[]),
  ('DONOR_ACCEPTED', 'DONOR_CONTACTED', ARRAY['HOSPITAL_STAFF', 'OWNER', 'ADMIN', 'DONOR']::request_actor_kind[]),
  ('DONOR_ACCEPTED', 'CANCELLED', ARRAY['OWNER', 'ADMIN', 'SYSTEM']::request_actor_kind[]),
  ('DONOR_ACCEPTED', 'EXPIRED', ARRAY['SYSTEM']::request_actor_kind[]),
  ('DONOR_CONFIRMED', 'FULFILLED', ARRAY['OWNER']::request_actor_kind[]),
  ('DONOR_CONFIRMED', 'DONOR_SEARCH', ARRAY['HOSPITAL_STAFF', 'OWNER', 'ADMIN', 'DONOR']::request_actor_kind[]),
  ('DONOR_CONFIRMED', 'CANCELLED', ARRAY['OWNER', 'ADMIN', 'SYSTEM']::request_actor_kind[]),
  ('DONOR_CONFIRMED', 'EXPIRED', ARRAY['SYSTEM']::request_actor_kind[]);
--> statement-breakpoint
-- Request state machine (DATABASE.md section 4): created as DRAFT; a status change must be an allowed transition.
-- Terminal states have no outgoing rows, so they can never change.
CREATE OR REPLACE FUNCTION bb_blood_request_state_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'DRAFT' THEN
      RAISE EXCEPTION 'A blood request must be created as DRAFT'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT EXISTS (
    SELECT 1 FROM request_transitions t WHERE t.from_status = OLD.status AND t.to_status = NEW.status
  ) THEN
    RAISE EXCEPTION 'Illegal blood request status transition % -> %', OLD.status, NEW.status
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER trg_blood_request_state_guard BEFORE INSERT OR UPDATE ON blood_requests FOR EACH ROW EXECUTE FUNCTION bb_blood_request_state_guard();
--> statement-breakpoint
-- Append-only history and timeline tables (DATABASE.md 2.5 and 2.6).
CREATE TRIGGER trg_blood_unit_events_no_update BEFORE UPDATE ON blood_unit_events FOR EACH ROW EXECUTE FUNCTION bb_forbid_update();
--> statement-breakpoint
CREATE TRIGGER trg_blood_unit_events_no_delete BEFORE DELETE ON blood_unit_events FOR EACH ROW EXECUTE FUNCTION bb_forbid_delete();
--> statement-breakpoint
CREATE TRIGGER trg_request_status_history_no_update BEFORE UPDATE ON blood_request_status_history FOR EACH ROW EXECUTE FUNCTION bb_forbid_update();
--> statement-breakpoint
CREATE TRIGGER trg_request_status_history_no_delete BEFORE DELETE ON blood_request_status_history FOR EACH ROW EXECUTE FUNCTION bb_forbid_delete();
--> statement-breakpoint
CREATE TRIGGER trg_request_events_no_update BEFORE UPDATE ON request_events FOR EACH ROW EXECUTE FUNCTION bb_forbid_update();
--> statement-breakpoint
CREATE TRIGGER trg_request_events_no_delete BEFORE DELETE ON request_events FOR EACH ROW EXECUTE FUNCTION bb_forbid_delete();
--> statement-breakpoint
-- Blood units (DATABASE.md 2.5, API.md 7): never deleted; identity fields immutable; an issued unit's
-- blood group, component and dates cannot change.
CREATE OR REPLACE FUNCTION bb_blood_unit_guard_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.unit_uid IS DISTINCT FROM OLD.unit_uid
     OR NEW.origin_facility_id IS DISTINCT FROM OLD.origin_facility_id
     OR NEW.source_donation_id IS DISTINCT FROM OLD.source_donation_id THEN
    RAISE EXCEPTION 'unit_uid, origin_facility_id and source_donation_id of a blood unit are immutable'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.status = 'ISSUED'
     AND (NEW.blood_group, NEW.component, NEW.collected_at, NEW.expires_at)
         IS DISTINCT FROM (OLD.blood_group, OLD.component, OLD.collected_at, OLD.expires_at) THEN
    RAISE EXCEPTION 'The blood group, component and dates of an issued unit cannot change'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER trg_blood_unit_guard_update BEFORE UPDATE ON blood_units FOR EACH ROW EXECUTE FUNCTION bb_blood_unit_guard_update();
--> statement-breakpoint
CREATE TRIGGER trg_blood_units_no_delete BEFORE DELETE ON blood_units FOR EACH ROW EXECUTE FUNCTION bb_forbid_delete();
--> statement-breakpoint
-- Inventory reservations (DATABASE.md section 10): only the end fields may change, and only once.
CREATE OR REPLACE FUNCTION bb_reservation_guard_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'ACTIVE' THEN
    RAISE EXCEPTION 'A reservation that is no longer ACTIVE cannot change'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF (to_jsonb(NEW) - 'status' - 'released_at' - 'release_reason')
     IS DISTINCT FROM (to_jsonb(OLD) - 'status' - 'released_at' - 'release_reason') THEN
    RAISE EXCEPTION 'Only status, released_at and release_reason of a reservation can change'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER trg_reservation_guard_update BEFORE UPDATE ON inventory_reservations FOR EACH ROW EXECUTE FUNCTION bb_reservation_guard_update();
--> statement-breakpoint
CREATE TRIGGER trg_reservations_no_delete BEFORE DELETE ON inventory_reservations FOR EACH ROW EXECUTE FUNCTION bb_forbid_delete();
