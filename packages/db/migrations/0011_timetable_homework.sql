-- 0011_timetable_homework
--
-- Phase 4.3 forward-only additions: the weekly timetable and homework, the last
-- remaining scope of DEVELOPMENT_ROADMAP `## Phase 4 — Teachers + Academics +
-- Timetable` after 4.1 (classes/sections/placement) and 4.2 (grade levels,
-- subjects, class-subject links, teacher assignments).
--
-- What lands here, per DATABASE_DESIGN.md §5:
--   1. periods                          — period ("bell") definitions. tenant-wide
--      (campus_id NULL) or campus-scoped; period_no unique per (tenant, campus)
--      among live rows; time ranges may not overlap within the same tenant and
--      campus (EXCLUDE USING gist on [start_time, end_time) — touching periods,
--      e.g. 08:00-08:45 and 08:45-09:30, do NOT conflict). Requires btree_gist
--      for the uuid equality members.
--   2. timetable_entries                — the weekly grid. One live lesson per
--      (section, weekday, period) enforced by a partial unique index; the
--      teacher is NOT client-writable — it is copied server-side from the LIVE
--      teacher_assignment of the (class, subject), so a lesson always runs under
--      the assigned lead teacher and a teacher can never be double-booked
--      (the SECURITY INVOKER validate trigger re-checks the assignment and the
--      teacher's OTHER live lessons in the same weekday whose periods overlap).
--      campus_id / academic_year_id are pinned from the parent class by the same
--      composite-FK mechanism as sections/class_subjects (0008/0009).
--   3. homework                         — class+subject tasks. The author
--      (teacher_user_id) is the calling user, and the validate trigger requires
--      that user to BE the live teacher assignment for the (class, subject), so
--      only the assigned teacher can author homework for a class they teach.
--      Delete/update "other teacher's homework" is additionally refused at the
--      API (self-scope guard) — the DB anchors authorship so a future holder of
--      the shared runtime credential still cannot forge another teacher's task.
--   4. homework_attachments             — junction to files (category `assignments`
--      in the storage key layout). Tenant-aware composite FKs; a file must belong
--      to the tenant to be attachable. Attachments are set at create time only.
--
-- Delete guards are extended so live timetable/homework never orphan:
--   * periods      cannot be soft-deleted while LIVE timetable entries use them;
--   * sections     cannot be soft-deleted while LIVE timetable entries exist;
--   * subjects     additionally refuse deletion while LIVE entries / homework
--                  reference them (existing live-link guards stay intact);
--   * acd_classes  additionally refuse deletion while LIVE entries / homework
--                  reference them;
--   * teacher_assignments refuse soft-delete (unassign) while LIVE entries
--                  reference the assignment — you cannot unassign a scheduled
--                  teacher (mirror of the class-subject detach guard).
--
-- SECURITY MODEL (unchanged in spirit): every new table is FORCE ROW LEVEL
-- SECURITY with the exact 0008 policy shape — policies trust only the signed
-- context ticket (app_current_tenant_id() / app_privileged()), hard DELETE stays
-- privileged-only, and every parent reference rides a composite (tenant_id, ...)
-- anchor so cross-tenant references fail at the DB. All trigger functions are
-- SECURITY INVOKER, so their parent lookups run under the invoking role's RLS and
-- are automatically tenant-local (cross-tenant parents are "not found", never a
-- leak). The double-booking check lives in the trigger rather than an EXCLUDE
-- constraint because lesson times derive from `periods` (single source of truth);
-- the exclusion constraint covers the period-definition overlap as the roadmap
-- calls for.

-- ================================================================== extension
-- btree_gist supplies the `=` operator class for uuid inside EXCLUDE USING gist
-- (the range `&&` member is native gist). Idempotent.
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- Section anchor for the composite (tenant, class, section) FK used by
-- timetable_entries.
CREATE UNIQUE INDEX sections_tenant_class_id_uq ON sections (tenant_id, class_id, id);

-- ================================================================== periods
CREATE TABLE periods (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    campus_id   uuid,                -- NULL = the tenant-wide bell set
    name        text NOT NULL,
    period_no   integer NOT NULL,
    start_time  time NOT NULL,
    end_time    time NOT NULL,
    status      text NOT NULL DEFAULT 'active',
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    deleted_at  timestamptz,
    CONSTRAINT periods_period_no_ck CHECK (period_no > 0),
    CONSTRAINT periods_time_order_ck CHECK (end_time > start_time),
    CONSTRAINT periods_status_ck CHECK (status IN ('active', 'inactive')),
    CONSTRAINT periods_campus_fk FOREIGN KEY (tenant_id, campus_id)
        REFERENCES campuses (tenant_id, id)
);
-- Composite tenant-aware FK anchor (timetable_entries reference this).
CREATE UNIQUE INDEX periods_tenant_id_uq ON periods (tenant_id, id);
-- period_no uniqueness per (tenant, campus) for LIVE rows only; a NULL campus is
-- the tenant-wide set (COALESCE so the set is a single conflict domain).
CREATE UNIQUE INDEX periods_tenant_campus_no_uq
    ON periods (tenant_id, COALESCE(campus_id, '00000000-0000-0000-0000-000000000000'), period_no)
    WHERE deleted_at IS NULL;
CREATE INDEX periods_tenant_scope_idx ON periods (tenant_id, campus_id, status)
    WHERE deleted_at IS NULL;
-- Time ranges may not overlap within the same tenant + campus (touching is fine).
-- start_time/end_time are `time`; they are ranged on a fixed epoch date.
ALTER TABLE periods ADD CONSTRAINT periods_no_overlap_excl EXCLUDE USING gist (
    tenant_id WITH =,
    COALESCE(campus_id, '00000000-0000-0000-0000-000000000000') WITH =,
    tstzrange(
        ('2000-01-01'::date + start_time) AT TIME ZONE 'UTC',
        ('2000-01-01'::date + end_time) AT TIME ZONE 'UTC',
        '[)'
    ) WITH &&
);

-- period soft-delete guard: a period may only be deleted while no LIVE timetable
-- entry references it.
CREATE OR REPLACE FUNCTION trg_periods_delete_guard() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = public, pg_catalog
AS $$
BEGIN
    IF NEW.deleted_at IS NULL OR OLD.deleted_at IS NOT NULL THEN
        RETURN NEW;
    END IF;
    PERFORM 1 FROM timetable_entries
        WHERE tenant_id = NEW.tenant_id AND period_id = NEW.id AND deleted_at IS NULL;
    IF FOUND THEN
        RAISE EXCEPTION 'cannot delete period with live timetable entries' USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS periods_delete_guard_trg ON periods;
CREATE TRIGGER periods_delete_guard_trg
    BEFORE UPDATE ON periods
    FOR EACH ROW EXECUTE FUNCTION trg_periods_delete_guard();

-- ================================================================== timetable_entries
CREATE TABLE timetable_entries (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id        uuid NOT NULL,
    class_id         uuid NOT NULL,
    section_id       uuid NOT NULL,
    subject_id       uuid NOT NULL,
    teacher_user_id  uuid NOT NULL,
    period_id        uuid NOT NULL,
    -- Denormalized copies pinned to the parent class by the composite FKs below.
    campus_id        uuid NOT NULL,
    academic_year_id uuid NOT NULL,
    weekday          smallint NOT NULL, -- 1 = Monday .. 7 = Sunday (ISO)
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),
    deleted_at       timestamptz,
    CONSTRAINT timetable_entries_weekday_ck CHECK (weekday BETWEEN 1 AND 7),
    CONSTRAINT timetable_entries_class_fk FOREIGN KEY (tenant_id, class_id)
        REFERENCES acd_classes (tenant_id, id),
    CONSTRAINT timetable_entries_class_campus_fk FOREIGN KEY (tenant_id, campus_id, class_id)
        REFERENCES acd_classes (tenant_id, campus_id, id),
    CONSTRAINT timetable_entries_class_year_fk FOREIGN KEY (tenant_id, academic_year_id, class_id)
        REFERENCES acd_classes (tenant_id, academic_year_id, id),
    CONSTRAINT timetable_entries_section_fk FOREIGN KEY (tenant_id, section_id)
        REFERENCES sections (tenant_id, id),
    CONSTRAINT timetable_entries_section_class_fk FOREIGN KEY (tenant_id, class_id, section_id)
        REFERENCES sections (tenant_id, class_id, id),
    CONSTRAINT timetable_entries_subject_fk FOREIGN KEY (tenant_id, subject_id)
        REFERENCES subjects (tenant_id, id),
    CONSTRAINT timetable_entries_teacher_fk FOREIGN KEY (tenant_id, teacher_user_id)
        REFERENCES memberships (tenant_id, user_id),
    CONSTRAINT timetable_entries_period_fk FOREIGN KEY (tenant_id, period_id)
        REFERENCES periods (tenant_id, id),
    CONSTRAINT timetable_entries_campus_fk FOREIGN KEY (tenant_id, campus_id)
        REFERENCES campuses (tenant_id, id)
);
-- Composite tenant-aware FK anchor (future rows reference this).
CREATE UNIQUE INDEX timetable_entries_tenant_id_uq ON timetable_entries (tenant_id, id);
-- DATABASE_DESIGN §5: unique(section_id, weekday, period_no) for LIVE rows only.
CREATE UNIQUE INDEX timetable_entries_section_slot_live_uq
    ON timetable_entries (tenant_id, section_id, weekday, period_id)
    WHERE deleted_at IS NULL;
CREATE INDEX timetable_entries_class_week_idx
    ON timetable_entries (tenant_id, class_id, weekday)
    WHERE deleted_at IS NULL;
CREATE INDEX timetable_entries_teacher_week_idx
    ON timetable_entries (tenant_id, teacher_user_id, weekday)
    WHERE deleted_at IS NULL;
CREATE INDEX timetable_entries_period_idx ON timetable_entries (tenant_id, period_id)
    WHERE deleted_at IS NULL;

-- Timetable entry integrity:
--   * inserts and live updates require a LIVE parent class, LIVE section of that
--     class, LIVE subject, a LIVE class_subjects link (the subject must be taught
--     in the class), the LIVE teacher_assignment of the (class, subject) matching
--     the row's teacher (server-derived — a lesson always runs under the assigned
--     lead teacher), and a LIVE period;
--   * the teacher's OTHER live lessons on the same weekday with overlapping
--     period time are refused (55000 teacher_double_booked);
--   * soft-delete (unassign from the grid) always succeeds — history.
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
    PERFORM 1
        FROM timetable_entries e
        JOIN periods p ON p.tenant_id = e.tenant_id AND p.id = e.period_id
        WHERE e.tenant_id = NEW.tenant_id
          AND e.deleted_at IS NULL
          AND e.weekday = NEW.weekday
          AND e.teacher_user_id = NEW.teacher_user_id
          AND e.id <> NEW.id
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
DROP TRIGGER IF EXISTS timetable_entries_validate_trg ON timetable_entries;
CREATE TRIGGER timetable_entries_validate_trg
    BEFORE INSERT OR UPDATE ON timetable_entries
    FOR EACH ROW EXECUTE FUNCTION trg_timetable_entries_validate();

-- Extended section delete guard: 0008 refused deletion while live enrollments
-- exist; Phase 4.3 adds live timetable entries.
CREATE OR REPLACE FUNCTION trg_sections_lifecycle_validate() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = public, pg_catalog
AS $$
BEGIN
    IF TG_OP = 'INSERT' OR (OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NULL) THEN
        PERFORM 1 FROM acd_classes
            WHERE tenant_id = NEW.tenant_id AND id = NEW.class_id AND deleted_at IS NULL;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'class not found for section' USING ERRCODE = '23503';
        END IF;
    END IF;
    IF NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL THEN
        PERFORM 1 FROM enrollments
            WHERE tenant_id = NEW.tenant_id AND section_id = NEW.id AND deleted_at IS NULL;
        IF FOUND THEN
            RAISE EXCEPTION 'cannot delete section with live enrollments' USING ERRCODE = '55000';
        END IF;
        PERFORM 1 FROM timetable_entries
            WHERE tenant_id = NEW.tenant_id AND section_id = NEW.id AND deleted_at IS NULL;
        IF FOUND THEN
            RAISE EXCEPTION 'cannot delete section with live timetable entries' USING ERRCODE = '55000';
        END IF;
    END IF;
    RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS sections_lifecycle_validate_trg ON sections;
CREATE TRIGGER sections_lifecycle_validate_trg
    BEFORE INSERT OR UPDATE ON sections
    FOR EACH ROW EXECUTE FUNCTION trg_sections_lifecycle_validate();

-- ================================================================== homework
CREATE TABLE homework (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id        uuid NOT NULL,
    class_id         uuid NOT NULL,
    subject_id       uuid NOT NULL,
    teacher_user_id  uuid NOT NULL,
    -- Denormalized copies pinned to the parent class by the composite FKs below.
    campus_id        uuid NOT NULL,
    academic_year_id uuid NOT NULL,
    title            text NOT NULL,
    body             text,
    due_at           timestamptz,
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),
    deleted_at       timestamptz,
    CONSTRAINT homework_class_fk FOREIGN KEY (tenant_id, class_id)
        REFERENCES acd_classes (tenant_id, id),
    CONSTRAINT homework_class_campus_fk FOREIGN KEY (tenant_id, campus_id, class_id)
        REFERENCES acd_classes (tenant_id, campus_id, id),
    CONSTRAINT homework_class_year_fk FOREIGN KEY (tenant_id, academic_year_id, class_id)
        REFERENCES acd_classes (tenant_id, academic_year_id, id),
    CONSTRAINT homework_subject_fk FOREIGN KEY (tenant_id, subject_id)
        REFERENCES subjects (tenant_id, id),
    CONSTRAINT homework_teacher_fk FOREIGN KEY (tenant_id, teacher_user_id)
        REFERENCES memberships (tenant_id, user_id),
    CONSTRAINT homework_campus_fk FOREIGN KEY (tenant_id, campus_id)
        REFERENCES campuses (tenant_id, id)
);
CREATE UNIQUE INDEX homework_tenant_id_uq ON homework (tenant_id, id);
CREATE INDEX homework_class_due_idx ON homework (tenant_id, class_id, due_at)
    WHERE deleted_at IS NULL;
CREATE INDEX homework_teacher_idx ON homework (tenant_id, teacher_user_id)
    WHERE deleted_at IS NULL;

-- Homework authoring integrity: the author (teacher_user_id) must be the LIVE
-- teacher_assignment of the (class, subject) — only the assigned teacher can
-- author a task for a class they teach.
CREATE OR REPLACE FUNCTION trg_homework_validate() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = public, pg_catalog
AS $$
BEGIN
    -- Soft-delete / history writes bypass the eligibility re-validation.
    IF NEW.deleted_at IS NOT NULL THEN
        RETURN NEW;
    END IF;
    PERFORM 1 FROM acd_classes
        WHERE tenant_id = NEW.tenant_id AND id = NEW.class_id AND deleted_at IS NULL;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'class not found for homework' USING ERRCODE = '23503';
    END IF;
    PERFORM 1 FROM subjects
        WHERE tenant_id = NEW.tenant_id AND id = NEW.subject_id AND deleted_at IS NULL;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'subject not found for homework' USING ERRCODE = '23503';
    END IF;
    PERFORM 1 FROM class_subjects
        WHERE tenant_id = NEW.tenant_id AND class_id = NEW.class_id
          AND subject_id = NEW.subject_id AND deleted_at IS NULL;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'subject is not attached to the class for homework'
            USING ERRCODE = '55000';
    END IF;
    PERFORM 1 FROM teacher_assignments
        WHERE tenant_id = NEW.tenant_id AND class_id = NEW.class_id
          AND subject_id = NEW.subject_id AND teacher_user_id = NEW.teacher_user_id
          AND deleted_at IS NULL;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'author is not the assigned teacher for this class subject'
            USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS homework_validate_trg ON homework;
CREATE TRIGGER homework_validate_trg
    BEFORE INSERT OR UPDATE ON homework
    FOR EACH ROW EXECUTE FUNCTION trg_homework_validate();

-- ================================================================== homework_attachments
CREATE TABLE homework_attachments (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   uuid NOT NULL,
    homework_id uuid NOT NULL,
    file_id     uuid NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    deleted_at  timestamptz,
    CONSTRAINT homework_attachments_homework_fk FOREIGN KEY (tenant_id, homework_id)
        REFERENCES homework (tenant_id, id),
    CONSTRAINT homework_attachments_file_fk FOREIGN KEY (tenant_id, file_id)
        REFERENCES files (tenant_id, id),
    CONSTRAINT homework_attachments_hw_file_uq UNIQUE (tenant_id, homework_id, file_id)
);
CREATE UNIQUE INDEX homework_attachments_tenant_id_uq ON homework_attachments (tenant_id, id);

-- ================================================================== extended delete guards
-- Subject delete guard: live class links, live teacher assignments (0009), live
-- timetable entries and live homework (Phase 4.3) all block deletion.
CREATE OR REPLACE FUNCTION trg_subjects_delete_guard() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = public, pg_catalog
AS $$
BEGIN
    IF NEW.deleted_at IS NULL OR OLD.deleted_at IS NOT NULL THEN
        RETURN NEW;
    END IF;
    PERFORM 1 FROM class_subjects
        WHERE tenant_id = NEW.tenant_id AND subject_id = NEW.id AND deleted_at IS NULL;
    IF FOUND THEN
        RAISE EXCEPTION 'cannot delete subject attached to a class' USING ERRCODE = '55000';
    END IF;
    PERFORM 1 FROM teacher_assignments
        WHERE tenant_id = NEW.tenant_id AND subject_id = NEW.id AND deleted_at IS NULL;
    IF FOUND THEN
        RAISE EXCEPTION 'cannot delete subject with live teacher assignments' USING ERRCODE = '55000';
    END IF;
    PERFORM 1 FROM timetable_entries
        WHERE tenant_id = NEW.tenant_id AND subject_id = NEW.id AND deleted_at IS NULL;
    IF FOUND THEN
        RAISE EXCEPTION 'cannot delete subject with live timetable entries' USING ERRCODE = '55000';
    END IF;
    PERFORM 1 FROM homework
        WHERE tenant_id = NEW.tenant_id AND subject_id = NEW.id AND deleted_at IS NULL;
    IF FOUND THEN
        RAISE EXCEPTION 'cannot delete subject with live homework' USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS subjects_delete_guard_trg ON subjects;
CREATE TRIGGER subjects_delete_guard_trg
    BEFORE UPDATE ON subjects
    FOR EACH ROW EXECUTE FUNCTION trg_subjects_delete_guard();

-- Class delete guard: Phase 4.3 adds live timetable entries and live homework to
-- the existing live sections / enrollments / subject links / assignments.
CREATE OR REPLACE FUNCTION trg_acd_classes_delete_guard() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = public, pg_catalog
AS $$
BEGIN
    IF NEW.deleted_at IS NULL OR OLD.deleted_at IS NOT NULL THEN
        RETURN NEW;
    END IF;
    PERFORM 1 FROM sections
        WHERE tenant_id = NEW.tenant_id AND class_id = NEW.id AND deleted_at IS NULL;
    IF FOUND THEN
        RAISE EXCEPTION 'cannot delete class with live sections' USING ERRCODE = '55000';
    END IF;
    PERFORM 1 FROM enrollments
        WHERE tenant_id = NEW.tenant_id AND class_id = NEW.id AND deleted_at IS NULL;
    IF FOUND THEN
        RAISE EXCEPTION 'cannot delete class with live enrollments' USING ERRCODE = '55000';
    END IF;
    PERFORM 1 FROM class_subjects
        WHERE tenant_id = NEW.tenant_id AND class_id = NEW.id AND deleted_at IS NULL;
    IF FOUND THEN
        RAISE EXCEPTION 'cannot delete class with live subject links' USING ERRCODE = '55000';
    END IF;
    PERFORM 1 FROM teacher_assignments
        WHERE tenant_id = NEW.tenant_id AND class_id = NEW.id AND deleted_at IS NULL;
    IF FOUND THEN
        RAISE EXCEPTION 'cannot delete class with live teacher assignments'
            USING ERRCODE = '55000';
    END IF;
    PERFORM 1 FROM timetable_entries
        WHERE tenant_id = NEW.tenant_id AND class_id = NEW.id AND deleted_at IS NULL;
    IF FOUND THEN
        RAISE EXCEPTION 'cannot delete class with live timetable entries' USING ERRCODE = '55000';
    END IF;
    PERFORM 1 FROM homework
        WHERE tenant_id = NEW.tenant_id AND class_id = NEW.id AND deleted_at IS NULL;
    IF FOUND THEN
        RAISE EXCEPTION 'cannot delete class with live homework' USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS acd_classes_delete_guard_trg ON acd_classes;
CREATE TRIGGER acd_classes_delete_guard_trg
    BEFORE UPDATE ON acd_classes
    FOR EACH ROW EXECUTE FUNCTION trg_acd_classes_delete_guard();

-- Teacher assignment unassign guard (extended trg_teacher_assignments_validate):
-- unassign keeps working for history even if the teacher was later suspended, but
-- refuses while LIVE timetable entries reference the assignment (you cannot unassign
-- a scheduled teacher) — mirror of the class-subject detach guard.
CREATE OR REPLACE FUNCTION trg_teacher_assignments_validate() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = public, pg_catalog
AS $$
BEGIN
    -- Unassign / history writes bypass eligibility re-validation.
    IF NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL THEN
        PERFORM 1 FROM timetable_entries
            WHERE tenant_id = NEW.tenant_id AND class_id = NEW.class_id
              AND subject_id = NEW.subject_id AND deleted_at IS NULL;
        IF FOUND THEN
            RAISE EXCEPTION 'cannot unassign a teacher with live timetable entries'
                USING ERRCODE = '55000';
        END IF;
        RETURN NEW;
    END IF;
    IF NEW.deleted_at IS NOT NULL THEN
        RETURN NEW;
    END IF;

    PERFORM 1 FROM acd_classes
        WHERE tenant_id = NEW.tenant_id AND id = NEW.class_id AND deleted_at IS NULL;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'class not found for teacher assignment' USING ERRCODE = '23503';
    END IF;
    PERFORM 1 FROM subjects
        WHERE tenant_id = NEW.tenant_id AND id = NEW.subject_id AND deleted_at IS NULL;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'subject not found for teacher assignment' USING ERRCODE = '23503';
    END IF;
    PERFORM 1 FROM class_subjects
        WHERE tenant_id = NEW.tenant_id AND class_id = NEW.class_id
          AND subject_id = NEW.subject_id AND deleted_at IS NULL;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'cannot assign teacher to a subject not attached to the class'
            USING ERRCODE = '55000';
    END IF;
    PERFORM 1
        FROM memberships m
        JOIN membership_roles mr ON mr.membership_id = m.id
        JOIN roles r ON r.id = mr.role_id
        WHERE m.tenant_id = NEW.tenant_id
          AND m.user_id = NEW.teacher_user_id
          AND m.status = 'active'
          AND r.scope = 'tenant'
          AND r.code = 'teacher';
    IF NOT FOUND THEN
        RAISE EXCEPTION 'assignment requires an active teacher membership in this tenant'
            USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS teacher_assignments_validate_trg ON teacher_assignments;
CREATE TRIGGER teacher_assignments_validate_trg
    BEFORE INSERT OR UPDATE ON teacher_assignments
    FOR EACH ROW EXECUTE FUNCTION trg_teacher_assignments_validate();

-- ================================================================== RLS
-- All four new tables: FORCE row level security; tenant-branch CRUD for any row
-- whose tenant_id equals the signed tenant claim, privileged executor escape for
-- maintenance/cross-tenant operations. Hard DELETE is privileged-only, so the
-- runtime role can only soft-delete (update deleted_at), never destroy.
DO $$
DECLARE
    t text;
BEGIN
    FOREACH t IN ARRAY ARRAY['periods', 'timetable_entries', 'homework', 'homework_attachments'] LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
        EXECUTE format(
            'CREATE POLICY %I ON %I FOR SELECT USING (
                 (tenant_id = app_current_tenant_id() AND app_current_tenant_id() IS NOT NULL)
                 OR app_privileged()
             )', t || '_select', t);
        EXECUTE format(
            'CREATE POLICY %I ON %I FOR INSERT WITH CHECK (
                 (tenant_id = app_current_tenant_id() AND app_current_tenant_id() IS NOT NULL)
                 OR app_privileged()
             )', t || '_insert', t);
        EXECUTE format(
            'CREATE POLICY %I ON %I FOR UPDATE USING (
                 (tenant_id = app_current_tenant_id() AND app_current_tenant_id() IS NOT NULL)
                 OR app_privileged()
             ) WITH CHECK (
                 (tenant_id = app_current_tenant_id() AND app_current_tenant_id() IS NOT NULL)
                 OR app_privileged()
             )', t || '_update', t);
        EXECUTE format(
            'CREATE POLICY %I ON %I FOR DELETE USING (app_privileged())',
            t || '_delete', t);
    END LOOP;
END
$$;

-- Explicit runtime grants (idempotent with 0001 default privileges).
GRANT SELECT, INSERT, UPDATE, DELETE
    ON periods, timetable_entries, homework, homework_attachments TO school_app_rw;

-- ================================================================== permission backfill
-- ==== PHASE 4.3 PERMISSION BACKFILL ====
-- Applies the Phase 4.3 timetable/homework permission set to system roles that
-- existed before this migration (idempotent; safe on re-run; scoped to exact
-- template codes only; never touches custom roles).
INSERT INTO role_permissions (role_id, permission)
SELECT r.id, p.permission
FROM roles r
JOIN (VALUES
    ('school_owner', 'timetable.read'),
    ('school_owner', 'timetable.manage'),
    ('school_owner', 'timetable.publish'),
    ('school_owner', 'homework.read'),
    ('school_owner', 'homework.create'),
    ('school_owner', 'homework.update'),
    ('school_owner', 'homework.delete'),
    ('principal', 'timetable.read'),
    ('principal', 'homework.read'),
    ('teacher', 'timetable.read'),
    ('teacher', 'homework.read'),
    ('teacher', 'homework.create'),
    ('teacher', 'homework.update'),
    ('teacher', 'homework.delete'),
    ('parent', 'homework.read'),
    ('student', 'homework.read')
) AS p(code, permission) ON p.code = r.code
WHERE r.scope = 'tenant' AND r.is_system = true
ON CONFLICT (role_id, permission) DO NOTHING;
-- ==== END PHASE 4.3 PERMISSION BACKFILL ====