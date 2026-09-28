-- 0012_timetable_double_book_disambiguation
--
-- Refines trg_timetable_entries_validate from 0011 so an EXACT slot duplicate —
-- the same (section, weekday, period) — is reported by the partial unique index
-- `timetable_entries_section_slot_live_uq` (23505, mapped to timetable_slot_conflict
-- at the API) instead of being shadowed by the teacher double-booking guard
-- (55000 teacher_double_booked).
--
-- The double-booking check still refuses every GENUINE overlap: the same teacher
-- teaching in a different section, or in the same section at a different period
-- whose time range overlaps, at the same weekday. Only the degenerate re-insert
-- of the same section+period row is left for the uniqueness index to catch, so the
-- API can distinguish a slot collision (409 timetable_slot_conflict) from a staff
-- scheduling clash (409 teacher_double_booked).
--
-- Forward-only: 0011 is already applied to any environment that reached Phase 4.3,
-- and its `CREATE TABLE` statements are not idempotent, so this migration replaces
-- the function in place (CREATE OR REPLACE keeps the trigger wired to the new body).
CREATE OR REPLACE FUNCTION trg_timetable_entries_validate() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = public, pg_catalog
AS $$
DECLARE
    new_start time;
    new_end   time;
BEGIN
    -- Soft-delete / history writes bypass the eligibility re-validation.
    IF NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL THEN
        RETURN NEW;
    END IF;
    IF NEW.deleted_at IS NOT NULL THEN
        RETURN NEW;
    END IF;

    PERFORM 1 FROM acd_classes
        WHERE tenant_id = NEW.tenant_id AND id = NEW.class_id AND deleted_at IS NULL;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'class not found for timetable entry' USING ERRCODE = '23503';
    END IF;
    PERFORM 1 FROM sections
        WHERE tenant_id = NEW.tenant_id AND class_id = NEW.class_id
          AND id = NEW.section_id AND deleted_at IS NULL;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'section not found for timetable entry' USING ERRCODE = '23503';
    END IF;
    PERFORM 1 FROM subjects
        WHERE tenant_id = NEW.tenant_id AND id = NEW.subject_id AND deleted_at IS NULL;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'subject not found for timetable entry' USING ERRCODE = '23503';
    END IF;
    PERFORM 1 FROM class_subjects
        WHERE tenant_id = NEW.tenant_id AND class_id = NEW.class_id
          AND subject_id = NEW.subject_id AND deleted_at IS NULL;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'subject is not attached to the class for this timetable entry'
            USING ERRCODE = '55000';
    END IF;
    PERFORM 1 FROM teacher_assignments
        WHERE tenant_id = NEW.tenant_id AND class_id = NEW.class_id
          AND subject_id = NEW.subject_id AND teacher_user_id = NEW.teacher_user_id
          AND deleted_at IS NULL;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'teacher is not the assigned teacher for this class subject'
            USING ERRCODE = '55000';
    END IF;
    SELECT start_time, end_time INTO new_start, new_end FROM periods
        WHERE tenant_id = NEW.tenant_id AND id = NEW.period_id AND deleted_at IS NULL;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'period not found for timetable entry' USING ERRCODE = '23503';
    END IF;

    -- Teacher double-booking: same tenant, same weekday, same teacher, another
    -- live lesson whose period time overlaps the new one (touching is allowed).
    -- An EXACT slot re-insert (same section AND same period) is excluded here so
    -- the partial unique index reports it as 23505 timetable_slot_conflict.
    PERFORM 1
        FROM timetable_entries e
        JOIN periods p ON p.tenant_id = e.tenant_id AND p.id = e.period_id
        WHERE e.tenant_id = NEW.tenant_id
          AND e.deleted_at IS NULL
          AND e.weekday = NEW.weekday
          AND e.teacher_user_id = NEW.teacher_user_id
          AND e.id <> NEW.id
          AND NOT (e.section_id = NEW.section_id AND e.period_id = NEW.period_id)
          AND tstzrange(('2000-01-01'::date + new_start) AT TIME ZONE 'UTC',
                        ('2000-01-01'::date + new_end) AT TIME ZONE 'UTC', '[)')
              && tstzrange(('2000-01-01'::date + p.start_time) AT TIME ZONE 'UTC',
                           ('2000-01-01'::date + p.end_time) AT TIME ZONE 'UTC', '[)');
    IF FOUND THEN
        RAISE EXCEPTION 'teacher is double-booked in the timetable' USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
END
$$;