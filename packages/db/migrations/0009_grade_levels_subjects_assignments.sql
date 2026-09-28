-- 0009_grade_levels_subjects_assignments
--
-- Phase 4.2 forward-only additions: the academic curriculum catalog and the
-- teaching-staff assignment layer.
--   1. grade_levels: tenant-wide grade catalog (e.g. "GR-9", "Grade 9").
--      A grade is NOT campus- or year-specific — it describes the level, and
--      acd_classes (which are campus+year specific) optionally reference one.
--      Code uniqueness is scoped to (tenant_id, code) for LIVE rows only, per
--      DATABASE_DESIGN.md §5.
--   2. subjects: tenant-wide subject catalog (e.g. "MATH", "Mathematics").
--      Also (tenant_id, code) unique for live rows, per DATABASE_DESIGN §5.
--   3. acd_classes.grade_level_id: optional, create-only link from a class to its
--      grade level. Immutable exactly like campus_id / academic_year_id (the API
--      never updates it; relocation of a populated class would break children).
--      The DB keeps it tenant-anchored via a composite FK. A grade level cannot
--      be soft-deleted while any LIVE class still references it.
--   4. class_subjects: which subjects are taught in a class (DATABASE_DESIGN §5:
--      unique(class_id, subject_id)). campus_id / academic_year_id are
--      denormalized copies of the parent class and pinned by the same composite
--      FK mechanism sections use in 0008, so a subject link can never drift onto
--      another campus or year. Soft-delete only. A subject link cannot be
--      detached while a LIVE teacher assignment references it, and the class /
--      subject delete guards are extended to refuse deleting parents that still
--      own live links.
--   5. teacher_assignments: one active teacher per (class, subject)
--      (DATABASE_DESIGN §5: "one lead, one class-subject combination"). There is
--      no separate teachers table: a "teacher" is an ACTIVE membership in the
--      tenant carrying the tenant-scoped `teacher` role. The FK anchor is the new
--      (tenant_id, user_id) uniqueness on memberships, so a cross-tenant
--      "teacher" is impossible at the DB. A SECURITY INVOKER trigger re-verifies
--      eligibility (active membership + system `teacher` role + the class-subject
--      link must exist and be live) on every insert and on any update that keeps
--      the row live. One active row per (class, subject) is enforced by a partial
--      unique index; reassignment is strictly unassign-then-assign, and
--      soft-deletion always succeeds (history), so an unassign is never blocked
--      by a teacher whose membership was later suspended.
--   6. memberships (tenant_id, user_id) unique index: the FK anchor used by
--      teacher_assignments. memberships_user_tenant_uq already makes (user_id,
--      tenant_id) unique; this adds the reversed, tenant-first anchor required by
--      composite tenant-aware foreign keys.
--
-- SECURITY MODEL (inherited, unchanged in spirit): every new table is FORCE ROW
-- LEVEL SECURITY with the exact 0008 policy shape — policies trust only the
-- signed context ticket (app_current_tenant_id() / app_privileged()), the
-- runtime role can touch only rows whose tenant_id equals the signed tenant
-- claim, hard DELETE stays privileged-only, and every parent reference rides the
-- composite (tenant_id, ...) anchor so cross-tenant references fail at the DB.
-- All trigger functions are SECURITY INVOKER, so their parent lookups run under
-- the invoking role's RLS and are automatically tenant-local: a cross-tenant
-- class/subject/membership surfaces as "not found", never as a leak.

-- ================================================================== memberships FK anchor
-- Tenant-first uniqueness on memberships so teacher_assignments can reference
-- (tenant_id, user_id) with a composite tenant-aware FK.
CREATE UNIQUE INDEX memberships_tenant_user_uq ON memberships (tenant_id, user_id);

-- ================================================================== grade_levels
CREATE TABLE grade_levels (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id  uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    code       text NOT NULL,
    name       text NOT NULL,
    status     text NOT NULL DEFAULT 'active',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz,
    CONSTRAINT grade_levels_status_ck CHECK (status IN ('active', 'inactive'))
);
-- Composite tenant-aware FK anchor (acd_classes.grade_level_id references this).
CREATE UNIQUE INDEX grade_levels_tenant_id_uq ON grade_levels (tenant_id, id);
-- Code uniqueness is tenant-wide for LIVE rows only (deleted history may reuse a code).
CREATE UNIQUE INDEX grade_levels_tenant_code_uq
    ON grade_levels (tenant_id, code)
    WHERE deleted_at IS NULL;
CREATE INDEX grade_levels_tenant_scope_idx ON grade_levels (tenant_id, status)
    WHERE deleted_at IS NULL;

-- ================================================================== subjects
CREATE TABLE subjects (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    code        text NOT NULL,
    name        text NOT NULL,
    description text,
    status      text NOT NULL DEFAULT 'active',
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    deleted_at  timestamptz,
    CONSTRAINT subjects_status_ck CHECK (status IN ('active', 'inactive'))
);
-- Composite tenant-aware FK anchor (class_subjects / teacher_assignments reference this).
CREATE UNIQUE INDEX subjects_tenant_id_uq ON subjects (tenant_id, id);
-- Code uniqueness is tenant-wide for LIVE rows only.
CREATE UNIQUE INDEX subjects_tenant_code_uq
    ON subjects (tenant_id, code)
    WHERE deleted_at IS NULL;
CREATE INDEX subjects_tenant_scope_idx ON subjects (tenant_id, status)
    WHERE deleted_at IS NULL;

-- ================================================================== acd_classes.grade_level_id
-- Create-only optional grade level link. Composite tenant-aware FK: the class
-- can never point at another tenant's grade level.
ALTER TABLE acd_classes ADD COLUMN grade_level_id uuid;
ALTER TABLE acd_classes
    ADD CONSTRAINT acd_classes_grade_level_fk
        FOREIGN KEY (tenant_id, grade_level_id) REFERENCES grade_levels (tenant_id, id);
-- Anchor for the FK above (live-only so unleveled classes stay out of it).
CREATE UNIQUE INDEX acd_classes_tenant_grade_id_uq
    ON acd_classes (tenant_id, grade_level_id, id)
    WHERE grade_level_id IS NOT NULL;
-- Directory lookup by grade level.
CREATE INDEX acd_classes_grade_level_idx ON acd_classes (tenant_id, grade_level_id)
    WHERE deleted_at IS NULL AND grade_level_id IS NOT NULL;

-- ================================================================== class_subjects
CREATE TABLE class_subjects (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id        uuid NOT NULL,
    class_id         uuid NOT NULL,
    subject_id       uuid NOT NULL,
    -- Denormalized copies pinned to the parent class by the composite FKs below:
    -- they can never disagree with acd_classes.campus_id / academic_year_id.
    campus_id        uuid NOT NULL,
    academic_year_id uuid NOT NULL,
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),
    deleted_at       timestamptz,
    CONSTRAINT class_subjects_class_fk FOREIGN KEY (tenant_id, class_id)
        REFERENCES acd_classes (tenant_id, id),
    -- class_subjects.campus_id CARD = class.campus_id, and the year likewise.
    CONSTRAINT class_subjects_class_campus_fk FOREIGN KEY (tenant_id, campus_id, class_id)
        REFERENCES acd_classes (tenant_id, campus_id, id),
    CONSTRAINT class_subjects_class_year_fk FOREIGN KEY (tenant_id, academic_year_id, class_id)
        REFERENCES acd_classes (tenant_id, academic_year_id, id),
    CONSTRAINT class_subjects_subject_fk FOREIGN KEY (tenant_id, subject_id)
        REFERENCES subjects (tenant_id, id),
    CONSTRAINT class_subjects_campus_fk FOREIGN KEY (tenant_id, campus_id)
        REFERENCES campuses (tenant_id, id)
);
-- Composite tenant-aware FK anchor (teacher_assignments reference this).
CREATE UNIQUE INDEX class_subjects_tenant_id_uq ON class_subjects (tenant_id, id);
-- DATABASE_DESIGN §5: unique(class_id, subject_id) for LIVE rows only. Soft-delete
-- keeps history; a detached (then re-attached) subject link gets a fresh row.
CREATE UNIQUE INDEX class_subjects_class_subject_live_uq
    ON class_subjects (tenant_id, class_id, subject_id)
    WHERE deleted_at IS NULL;
-- Directory listing by class / by subject.
CREATE INDEX class_subjects_class_idx ON class_subjects (tenant_id, class_id)
    WHERE deleted_at IS NULL;
CREATE INDEX class_subjects_subject_idx ON class_subjects (tenant_id, subject_id)
    WHERE deleted_at IS NULL;

-- ================================================================== teacher_assignments
CREATE TABLE teacher_assignments (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id        uuid NOT NULL,
    class_id         uuid NOT NULL,
    subject_id       uuid NOT NULL,
    teacher_user_id  uuid NOT NULL,
    -- Denormalized copies pinned to the parent class by the composite FKs below.
    campus_id        uuid NOT NULL,
    academic_year_id uuid NOT NULL,
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),
    deleted_at       timestamptz,
    CONSTRAINT teacher_assignments_class_fk FOREIGN KEY (tenant_id, class_id)
        REFERENCES acd_classes (tenant_id, id),
    CONSTRAINT teacher_assignments_class_campus_fk FOREIGN KEY (tenant_id, campus_id, class_id)
        REFERENCES acd_classes (tenant_id, campus_id, id),
    CONSTRAINT teacher_assignments_class_year_fk FOREIGN KEY (tenant_id, academic_year_id, class_id)
        REFERENCES acd_classes (tenant_id, academic_year_id, id),
    CONSTRAINT teacher_assignments_subject_fk FOREIGN KEY (tenant_id, subject_id)
        REFERENCES subjects (tenant_id, id),
    CONSTRAINT teacher_assignments_teacher_fk FOREIGN KEY (tenant_id, teacher_user_id)
        REFERENCES memberships (tenant_id, user_id),
    CONSTRAINT teacher_assignments_campus_fk FOREIGN KEY (tenant_id, campus_id)
        REFERENCES campuses (tenant_id, id)
);
-- Composite tenant-aware FK anchor (future timetable rows reference this).
CREATE UNIQUE INDEX teacher_assignments_tenant_id_uq ON teacher_assignments (tenant_id, id);
-- DATABASE_DESIGN §5: one lead teacher per (class, subject). Reassignment is
-- unassign-then-assign; the old row stays as history with deleted_at set.
CREATE UNIQUE INDEX teacher_assignments_class_subject_live_uq
    ON teacher_assignments (tenant_id, class_id, subject_id)
    WHERE deleted_at IS NULL;
-- Listing by class-subject / by subject / by teacher.
CREATE INDEX teacher_assignments_class_subject_idx
    ON teacher_assignments (tenant_id, class_id, subject_id)
    WHERE deleted_at IS NULL;
CREATE INDEX teacher_assignments_subject_idx ON teacher_assignments (tenant_id, subject_id)
    WHERE deleted_at IS NULL;
CREATE INDEX teacher_assignments_teacher_idx ON teacher_assignments (tenant_id, teacher_user_id)
    WHERE deleted_at IS NULL;

-- ================================================================== integrity triggers
-- All trigger functions are SECURITY INVOKER: parent lookups run under the
-- invoking role and its RLS, so every check is automatically tenant-local and a
-- cross-tenant parent simply "is not found" (never leaks existence).

-- grade level soft-delete guard: a grade level may only be deleted while no LIVE
-- class references it.
CREATE OR REPLACE FUNCTION trg_grade_levels_delete_guard() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = public, pg_catalog
AS $$
BEGIN
    IF NEW.deleted_at IS NULL OR OLD.deleted_at IS NOT NULL THEN
        RETURN NEW;
    END IF;
    PERFORM 1 FROM acd_classes
        WHERE tenant_id = NEW.tenant_id AND grade_level_id = NEW.id AND deleted_at IS NULL;
    IF FOUND THEN
        RAISE EXCEPTION 'cannot delete grade level with live classes' USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS grade_levels_delete_guard_trg ON grade_levels;
CREATE TRIGGER grade_levels_delete_guard_trg
    BEFORE UPDATE ON grade_levels
    FOR EACH ROW EXECUTE FUNCTION trg_grade_levels_delete_guard();

-- subject soft-delete guard: a subject may only be deleted while nothing LIVE
-- references it (class links or teacher assignments).
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
    RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS subjects_delete_guard_trg ON subjects;
CREATE TRIGGER subjects_delete_guard_trg
    BEFORE UPDATE ON subjects
    FOR EACH ROW EXECUTE FUNCTION trg_subjects_delete_guard();

-- class_subject lifecycle guard:
--   * a subject link may only be created under a LIVE class, for a LIVE subject
--     (the parent descriptions of 0008, extended with the subject parent);
--   * detaching (soft-delete) requires no LIVE teacher assignment on the pair.
CREATE OR REPLACE FUNCTION trg_class_subjects_lifecycle_validate() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = public, pg_catalog
AS $$
BEGIN
    IF TG_OP = 'INSERT' OR (OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NULL) THEN
        PERFORM 1 FROM acd_classes
            WHERE tenant_id = NEW.tenant_id AND id = NEW.class_id AND deleted_at IS NULL;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'class not found for subject link' USING ERRCODE = '23503';
        END IF;
        PERFORM 1 FROM subjects
            WHERE tenant_id = NEW.tenant_id AND id = NEW.subject_id AND deleted_at IS NULL;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'subject not found for class link' USING ERRCODE = '23503';
        END IF;
    END IF;
    IF NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL THEN
        PERFORM 1 FROM teacher_assignments
            WHERE tenant_id = NEW.tenant_id AND class_id = NEW.class_id
              AND subject_id = NEW.subject_id AND deleted_at IS NULL;
        IF FOUND THEN
            RAISE EXCEPTION 'cannot detach subject with assigned teachers' USING ERRCODE = '55000';
        END IF;
    END IF;
    RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS class_subjects_lifecycle_validate_trg ON class_subjects;
CREATE TRIGGER class_subjects_lifecycle_validate_trg
    BEFORE INSERT OR UPDATE ON class_subjects
    FOR EACH ROW EXECUTE FUNCTION trg_class_subjects_lifecycle_validate();

-- teacher assignment integrity:
--   * insert (and any update that leaves the row live / reactivates it) requires:
--       - a LIVE parent class;
--       - a LIVE parent subject;
--       - a LIVE class_subjects link (you cannot teach a subject in a class the
--         subject is not attached to);
--       - an ACTIVE membership for the teacher in THIS tenant carrying the
--         tenant-scoped `teacher` role (eligibility, re-verified at write time).
--   * soft-delete (unassign) always succeeds — history rows are writable even if
--     the teacher's membership was later suspended, so unassign never deadlocks.
CREATE OR REPLACE FUNCTION trg_teacher_assignments_validate() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = public, pg_catalog
AS $$
BEGIN
    -- Unassign / history writes bypass eligibility re-validation.
    IF NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL THEN
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

-- Extended class soft-delete guard: 0008 refused deletion while live sections or
-- live enrollments referenced the class; Phase 4.2 adds live subject links and
-- live teacher assignments. CREATE OR REPLACE keeps the migration forward-only.
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
    RETURN NEW;
END
$$;
-- The trigger object already exists from 0008; keep registration idempotent.
DROP TRIGGER IF EXISTS acd_classes_delete_guard_trg ON acd_classes;
CREATE TRIGGER acd_classes_delete_guard_trg
    BEFORE UPDATE ON acd_classes
    FOR EACH ROW EXECUTE FUNCTION trg_acd_classes_delete_guard();

-- ================================================================== RLS
-- All four new tables: FORCE row level security; tenant-branch CRUD for any row
-- whose tenant_id equals the signed tenant claim, privileged executor escape for
-- maintenance/cross-tenant operations. Hard DELETE is privileged-only, so the
-- runtime role can only soft-delete (update deleted_at), never destroy.
DO $$
DECLARE
    t text;
BEGIN
    FOREACH t IN ARRAY ARRAY['grade_levels', 'subjects', 'class_subjects', 'teacher_assignments'] LOOP
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
    ON grade_levels, subjects, class_subjects, teacher_assignments TO school_app_rw;

-- ================================================================== permission backfill
-- ==== PHASE 4.2 PERMISSION BACKFILL ====
-- Applies the Phase 4.2 grade-level/subject/class-subject/teacher-assignment
-- permission set to system roles that existed before this migration (idempotent;
-- safe on re-run; scoped to exact template codes only; never touches custom roles).
INSERT INTO role_permissions (role_id, permission)
SELECT r.id, p.permission
FROM roles r
JOIN (VALUES
    ('school_owner', 'grade.levels.read'),
    ('school_owner', 'grade.levels.create'),
    ('school_owner', 'grade.levels.update'),
    ('school_owner', 'grade.levels.delete'),
    ('school_owner', 'subjects.read'),
    ('school_owner', 'subjects.create'),
    ('school_owner', 'subjects.update'),
    ('school_owner', 'subjects.delete'),
    ('school_owner', 'class.subjects.read'),
    ('school_owner', 'class.subjects.manage'),
    ('school_owner', 'teacher.assignments.read'),
    ('school_owner', 'teacher.assignments.manage'),
    ('principal', 'grade.levels.read'),
    ('principal', 'subjects.read'),
    ('principal', 'class.subjects.read'),
    ('principal', 'teacher.assignments.read')
) AS p(code, permission) ON p.code = r.code
WHERE r.scope = 'tenant' AND r.is_system = true
ON CONFLICT (role_id, permission) DO NOTHING;
-- ==== END PHASE 4.2 PERMISSION BACKFILL ====