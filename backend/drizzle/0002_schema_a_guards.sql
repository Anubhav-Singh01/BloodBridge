-- Batch 3.2 guards: functions, triggers and exclusion constraints that Drizzle cannot express.
-- Everything here implements a rule already written in DATABASE.md. Nothing is applied until Batch 3.5.

-- Shared trigger functions, reused by later batches.
CREATE OR REPLACE FUNCTION bb_touch_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION bb_forbid_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: rows cannot be deleted', TG_TABLE_NAME
    USING ERRCODE = 'integrity_constraint_violation';
END;
$$;
--> statement-breakpoint
-- updated_at is maintained by the database (DATABASE.md section 3).
CREATE TRIGGER trg_users_touch_updated_at BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION bb_touch_updated_at();
--> statement-breakpoint
CREATE TRIGGER trg_user_profiles_touch_updated_at BEFORE UPDATE ON user_profiles FOR EACH ROW EXECUTE FUNCTION bb_touch_updated_at();
--> statement-breakpoint
CREATE TRIGGER trg_patients_touch_updated_at BEFORE UPDATE ON patients FOR EACH ROW EXECUTE FUNCTION bb_touch_updated_at();
--> statement-breakpoint
CREATE TRIGGER trg_facilities_touch_updated_at BEFORE UPDATE ON facilities FOR EACH ROW EXECUTE FUNCTION bb_touch_updated_at();
--> statement-breakpoint
CREATE TRIGGER trg_hospitals_touch_updated_at BEFORE UPDATE ON hospitals FOR EACH ROW EXECUTE FUNCTION bb_touch_updated_at();
--> statement-breakpoint
CREATE TRIGGER trg_blood_banks_touch_updated_at BEFORE UPDATE ON blood_banks FOR EACH ROW EXECUTE FUNCTION bb_touch_updated_at();
--> statement-breakpoint
CREATE TRIGGER trg_facility_memberships_touch_updated_at BEFORE UPDATE ON facility_memberships FOR EACH ROW EXECUTE FUNCTION bb_touch_updated_at();
--> statement-breakpoint
CREATE TRIGGER trg_facility_verifications_touch_updated_at BEFORE UPDATE ON facility_verifications FOR EACH ROW EXECUTE FUNCTION bb_touch_updated_at();
--> statement-breakpoint
CREATE TRIGGER trg_donors_touch_updated_at BEFORE UPDATE ON donors FOR EACH ROW EXECUTE FUNCTION bb_touch_updated_at();
--> statement-breakpoint
CREATE TRIGGER trg_donor_verifications_touch_updated_at BEFORE UPDATE ON donor_verifications FOR EACH ROW EXECUTE FUNCTION bb_touch_updated_at();
--> statement-breakpoint
CREATE TRIGGER trg_donor_locations_touch_updated_at BEFORE UPDATE ON donor_locations FOR EACH ROW EXECUTE FUNCTION bb_touch_updated_at();
--> statement-breakpoint
-- donation_history (DATABASE.md 2.3): a FACILITY_RECORDED row is inserted VERIFIED only when recorded_by is an
-- ACTIVE member of a VERIFIED and ACTIVE facility. Every other source starts UNVERIFIED.
CREATE OR REPLACE FUNCTION bb_donation_history_before_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.verification_status = 'REJECTED' THEN
    RAISE EXCEPTION 'A donation record cannot be inserted as REJECTED'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.verification_status = 'VERIFIED' THEN
    IF NEW.source <> 'FACILITY_RECORDED' THEN
      RAISE EXCEPTION 'Only a facility-recorded donation can be inserted as VERIFIED'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF NOT EXISTS (
      SELECT 1
      FROM facility_memberships m
      JOIN facilities f ON f.id = m.facility_id
      WHERE m.user_id = NEW.recorded_by
        AND m.facility_id = NEW.facility_id
        AND m.status = 'ACTIVE'
        AND f.verification_status = 'VERIFIED'
        AND f.status = 'ACTIVE'
    ) THEN
      RAISE EXCEPTION 'recorded_by must be an active member of a verified, active facility'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
-- append-only except the verification fields (DATABASE.md 2.3).
CREATE OR REPLACE FUNCTION bb_donation_history_guard_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW) - 'verification_status' - 'verified_by' - 'verified_at')
     IS DISTINCT FROM (to_jsonb(OLD) - 'verification_status' - 'verified_by' - 'verified_at') THEN
    RAISE EXCEPTION 'donation_history is append-only except its verification fields'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER trg_donation_history_before_insert BEFORE INSERT ON donation_history FOR EACH ROW EXECUTE FUNCTION bb_donation_history_before_insert();
--> statement-breakpoint
CREATE TRIGGER trg_donation_history_guard_update BEFORE UPDATE ON donation_history FOR EACH ROW EXECUTE FUNCTION bb_donation_history_guard_update();
--> statement-breakpoint
CREATE TRIGGER trg_donation_history_no_delete BEFORE DELETE ON donation_history FOR EACH ROW EXECUTE FUNCTION bb_forbid_delete();
--> statement-breakpoint
-- donor_eligibility_calculations (DATABASE.md 2.4): append-only; the only change allowed is CURRENT -> SUPERSEDED.
CREATE OR REPLACE FUNCTION bb_eligibility_calc_guard_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'CURRENT' AND NEW.status = 'SUPERSEDED'
     AND (to_jsonb(NEW) - 'status') IS NOT DISTINCT FROM (to_jsonb(OLD) - 'status') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'donor_eligibility_calculations is append-only: only CURRENT to SUPERSEDED is allowed'
    USING ERRCODE = 'integrity_constraint_violation';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER trg_eligibility_calc_guard_update BEFORE UPDATE ON donor_eligibility_calculations FOR EACH ROW EXECUTE FUNCTION bb_eligibility_calc_guard_update();
--> statement-breakpoint
CREATE TRIGGER trg_eligibility_calc_no_delete BEFORE DELETE ON donor_eligibility_calculations FOR EACH ROW EXECUTE FUNCTION bb_forbid_delete();
--> statement-breakpoint
-- donation_interval_rules (DATABASE.md 2.4): immutable once referenced by a calculation, except that
-- the range may be closed by setting effective_to. Unreferenced rows may still be corrected or deleted.
CREATE OR REPLACE FUNCTION bb_interval_rule_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  referenced boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM donor_eligibility_calculations c
    WHERE c.rule_id = OLD.id OR OLD.id = ANY (c.considered_rule_ids)
  ) INTO referenced;
  IF NOT referenced THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A donation interval rule used by an eligibility calculation cannot be deleted'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF (to_jsonb(NEW) - 'effective_to') IS DISTINCT FROM (to_jsonb(OLD) - 'effective_to') THEN
    RAISE EXCEPTION 'A donation interval rule used by an eligibility calculation can only be closed (effective_to)'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER trg_interval_rule_guard BEFORE UPDATE OR DELETE ON donation_interval_rules FOR EACH ROW EXECUTE FUNCTION bb_interval_rule_guard();
--> statement-breakpoint
-- Non-overlapping effective ranges (DATABASE.md 2.3 and 2.4). Half-open ranges: [effective_from, effective_to).
ALTER TABLE donation_interval_rules ADD CONSTRAINT donation_interval_rules_official_no_overlap
  EXCLUDE USING gist (donation_type WITH =, daterange(effective_from, effective_to, '[)') WITH &&)
  WHERE (scope = 'OFFICIAL');
--> statement-breakpoint
-- A FACILITY rule is per facility: two facilities may each have a rule for the same period.
ALTER TABLE donation_interval_rules ADD CONSTRAINT donation_interval_rules_facility_no_overlap
  EXCLUDE USING gist (donation_type WITH =, facility_id WITH =, daterange(effective_from, effective_to, '[)') WITH &&)
  WHERE (scope = 'FACILITY');
--> statement-breakpoint
ALTER TABLE eligibility_rules ADD CONSTRAINT eligibility_rules_no_overlap
  EXCLUDE USING gist (rule_key WITH =, daterange(effective_from, effective_to, '[)') WITH &&);
