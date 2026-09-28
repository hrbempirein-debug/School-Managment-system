-- 0008_academic_classes_sections_placement
--
-- Phase 4.1 forward-only additions: the academic class/section structure and
-- student academic PLACEMENT foundation beneath the Phase 3 enrollment layer.
--   1. acd_classes: academic-year-specific classes, campus-owned (the roadmap's
--      Phase 4 security bullet demands campus scoping for multi-campus
--      timetables). Name chosen exactly as DATABASE_DESIGN.md §5 and the Phase 4
--      roadmap: a table named `classes` would collide with the SQL reserved
--      word, so the physical table is `acd_classes`.
--   2. sections: sections of a class. section.campus and section.academic_year
--      are denormalized COPIES of the parent class's values and are pinned to
--      them BY THE DATABASE via composite tenant-aware FKs, so a section can
--      never drift onto another campus or another year.
--   3. enrollments.class_id / section_id wiring: migration 0005 deliberately
--      reserved these as nullable columns ONLY ("roll_no uniqueness is expressed
--      as a partial unique index that becomes fully enforceable as soon as
--      sections land"). This migration supplies the real FKs and the placement
--      integrity trigger, which makes enrollments_roll_no_uq live.
--   4. Placement integrity is enforced at the DB (placement lives ON the
--      enrollment row exactly as 0005's header intended): a placed enrollment
--      must reference a live, active class and section, class.year must equal
--      the enrollment year, section must belong to the enrollment's class, a
--      section without a class is impossible, and a student whose primary campus
--      is set cannot be placed into a class on a different campus. Unplaced
--      (NULL/NULL) enrollments stay valid — promotion and phase-3 flows insert
--      them that way.
--   5. Class/section soft-delete guards: a class cannot be soft-deleted while it
--      still has live sections or live enrollments referencing it, and a section
--      cannot be soft-deleted while live enrollments reference it. Deleting is
--      reserved for empty, accidental structures; archiving a running class is
--      the `inactive` status.
--   6. Phase 4.1 permission backfill for system roles created before this
--      migration (classes.*, sections.*, placement.*; principal gets read-only).
--
-- SECURITY MODEL (inherited, unchanged in spirit): every new table is FORCE ROW
-- LEVEL SECURITY, policies trust ONLY the signed context ticket
-- (app_current_tenant_id() / app_privileged()) exactly as 0005/0007 did, the
-- runtime role can touch only rows whose tenant_id equals the signed tenant
-- claim, hard DELETE stays privileged-only, and parent references ride the
-- composite (tenant_id, ...) anchors so cross-tenant references fail at the DB.
-- The placement trigger is SECURITY INVOKER, so its parent lookups run under
-- the same RLS as the invoking role and are automatically tenant-local: a
-- cross-tenant class/section surfaces as "not found" (a 404-equivalent
-- 23503/55000 at the DB), never as a leak.

-- ================================================================== acd_classes
CREATE TABLE acd_classes (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id        uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    campus_id        uuid NOT NULL,
    academic_year_id uuid NOT NULL,
    code             text NOT NULL,
    name             text NOT NULL,
    status           text NOT NULL DEFAULT 'active',
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),
    deleted_at       timestamptz,
    CONSTRAINT acd_classes_campus_fk FOREIGN KEY (tenant_id, campus_id)
        REFERENCES campuses (tenant_id, id),
    CONSTRAINT acd_classes_year_fk FOREIGN KEY (tenant_id, academic_year_id)
        REFERENCES academic_years (tenant_id, id),
    CONSTRAINT acd_classes_status_ck CHECK (status IN ('active', 'inactive'))
);
-- Composite tenant-aware FK anchors (sections and enrollments reference these).
CREATE UNIQUE INDEX acd_classes_tenant_id_uq ON acd_classes (tenant_id, id);
CREATE UNIQUE INDEX acd_classes_tenant_campus_id_uq ON acd_classes (tenant_id, campus_id, id);
CREATE UNIQUE INDEX acd_classes_tenant_year_id_uq ON acd_classes (tenant_id, academic_year_id, id);
-- Class code uniqueness is scoped to (tenant, campus, academic year) for LIVE
-- rows only (deleted history may reuse a code for a replacement class).
CREATE UNIQUE INDEX acd_classes_tenant_code_uq
    ON acd_classes (tenant_id, campus_id, academic_year_id, code)
    WHERE deleted_at IS NULL;
-- Directory listing / campus-and-year scoping.
CREATE INDEX acd_classes_tenant_scope_idx
    ON acd_classes (tenant_id, campus_id, academic_year_id, status)
    WHERE deleted_at IS NULL;

-- ================================================================== sections
CREATE TABLE sections (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id        uuid NOT NULL,
    class_id         uuid NOT NULL,
    -- Denormalized copies pinned to the parent class by the composite FKs below:
    -- they can never disagree with acd_classes.campus_id / academic_year_id.
    campus_id        uuid NOT NULL,
    academic_year_id uuid NOT NULL,
    code             text NOT NULL,
    status           text NOT NULL DEFAULT 'active',
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),
    deleted_at       timestamptz,
    CONSTRAINT sections_class_fk FOREIGN KEY (tenant_id, class_id)
        REFERENCES acd_classes (tenant_id, id),
    -- section.campus_id CARD = class.campus_id: the composite pair (tenant,
    -- campus, class) must exist among acd_classes, so a section can never be
    -- created on a campus its class does not own.
    CONSTRAINT sections_class_campus_fk FOREIGN KEY (tenant_id, campus_id, class_id)
        REFERENCES acd_classes (tenant_id, campus_id, id),
    -- section.academic_year_id CARD = class.academic_year_id (same mechanism).
    CONSTRAINT sections_class_year_fk FOREIGN KEY (tenant_id, academic_year_id, class_id)
        REFERENCES acd_classes (tenant_id, academic_year_id, id),
    -- Direct campus anchor (keeps the denormalized column independently valid).
    CONSTRAINT sections_campus_fk FOREIGN KEY (tenant_id, campus_id)
        REFERENCES campuses (tenant_id, id),
    CONSTRAINT sections_status_ck CHECK (status IN ('active', 'inactive'))
);
-- Composite tenant-aware FK anchors (enrollments.section_id references this).
CREATE UNIQUE INDEX sections_tenant_id_uq ON sections (tenant_id, id);
-- Section code uniqueness within its class, LIVE rows only (DATABASE_DESIGN §5:
-- unique(tenant, class_id, code)).
CREATE UNIQUE INDEX sections_tenant_class_code_uq
    ON sections (tenant_id, class_id, code)
    WHERE deleted_at IS NULL;
-- Sections-of-class listing.
CREATE INDEX sections_class_active_idx ON sections (tenant_id, class_id, status)
    WHERE deleted_at IS NULL;

-- ================================================================== enrollments placement wiring
-- Migration 0005 left these nullable columns unwired on purpose. Enforcing
-- section/year/class consistency is the placement trigger (below) so that the
-- documented 409 codes can be surfaced by the API; the plain FKs below pin the
-- parent existence + tenant identity.
ALTER TABLE enrollments
    ADD CONSTRAINT enrollments_class_fk
        FOREIGN KEY (tenant_id, class_id) REFERENCES acd_classes (tenant_id, id),
    ADD CONSTRAINT enrollments_section_fk
        FOREIGN KEY (tenant_id, section_id) REFERENCES sections (tenant_id, id);
-- Directory queries by class/section (placement listing, roll-call later).
CREATE INDEX enrollments_class_idx ON enrollments (tenant_id, class_id)
    WHERE deleted_at IS NULL;
CREATE INDEX enrollments_section_idx ON enrollments (tenant_id, section_id)
    WHERE deleted_at IS NULL;

-- ================================================================== placement integrity triggers
-- All trigger functions are SECURITY INVOKER: parent/student lookups run under
-- the invoking role and its RLS, so every check is automatically tenant-local
-- and a cross-tenant parent simply "is not found" (never leaks existence).

-- Enrollment placement validation. NULL/NULL stays valid (unplaced); placing a
-- student requires a live, active class + section with mutually consistent
-- tenant/campus/year, a section that belongs to the selected class, an active
-- student, and an active enrollment. roll_no uniqueness is enforced by the
-- enrollments_roll_no_uq partial unique index (now fully enforceable).
CREATE OR REPLACE FUNCTION trg_enrollments_placement_validate() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = public, pg_catalog
AS $$
DECLARE
    c acd_classes%ROWTYPE;
    s_record sections%ROWTYPE;
    student_campus uuid;
    student_status text;
BEGIN
    IF TG_OP = 'UPDATE'
       AND NEW.class_id IS NOT DISTINCT FROM OLD.class_id
       AND NEW.section_id IS NOT DISTINCT FROM OLD.section_id THEN
        RETURN NEW;
    END IF;
    IF NEW.class_id IS NULL AND NEW.section_id IS NULL THEN
        RETURN NEW;
    END IF;
    IF NEW.section_id IS NOT NULL AND NEW.class_id IS NULL THEN
        RAISE EXCEPTION 'section requires a class' USING ERRCODE = '55000';
    END IF;

    -- Placement target class must exist, be live and active.
    SELECT * INTO c FROM acd_classes
        WHERE id = NEW.class_id AND tenant_id = NEW.tenant_id AND deleted_at IS NULL;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'class not found for enrollment' USING ERRCODE = '23503';
    END IF;
    IF c.status <> 'active' THEN
        RAISE EXCEPTION 'class is not active' USING ERRCODE = '55000';
    END IF;
    IF c.academic_year_id <> NEW.academic_year_id THEN
        RAISE EXCEPTION 'class academic year mismatch' USING ERRCODE = '55000';
    END IF;

    IF NEW.section_id IS NOT NULL THEN
        SELECT * INTO s_record FROM sections
            WHERE id = NEW.section_id AND tenant_id = NEW.tenant_id AND deleted_at IS NULL;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'section not found for enrollment' USING ERRCODE = '23503';
        END IF;
        IF s_record.class_id <> NEW.class_id THEN
            RAISE EXCEPTION 'section belongs to a different class' USING ERRCODE = '55000';
        END IF;
        IF s_record.academic_year_id <> NEW.academic_year_id THEN
            RAISE EXCEPTION 'section academic year mismatch' USING ERRCODE = '55000';
        END IF;
        IF s_record.status <> 'active' THEN
            RAISE EXCEPTION 'section is not active' USING ERRCODE = '55000';
        END IF;
    END IF;

    -- Campus consistency with the student and student liveness.
    SELECT primary_campus_id, status INTO student_campus, student_status
        FROM students
        WHERE id = NEW.student_id AND tenant_id = NEW.tenant_id AND deleted_at IS NULL;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'student not found for enrollment' USING ERRCODE = '23503';
    END IF;
    IF student_status <> 'active' THEN
        RAISE EXCEPTION 'cannot place into a non-active student' USING ERRCODE = '55000';
    END IF;
    IF student_campus IS NOT NULL AND student_campus <> c.campus_id THEN
        RAISE EXCEPTION 'student campus does not match class campus' USING ERRCODE = '55000';
    END IF;
    IF NEW.status <> 'active' THEN
        RAISE EXCEPTION 'cannot place into a non-active enrollment' USING ERRCODE = '55000';
    END IF;

    RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS enrollments_placement_validate_trg ON enrollments;
CREATE TRIGGER enrollments_placement_validate_trg
    BEFORE INSERT OR UPDATE ON enrollments
    FOR EACH ROW EXECUTE FUNCTION trg_enrollments_placement_validate();

-- Class soft-delete guard: a class may only be deleted when it is empty (no
-- live sections and no live enrollments referencing it).
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
    RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS acd_classes_delete_guard_trg ON acd_classes;
CREATE TRIGGER acd_classes_delete_guard_trg
    BEFORE UPDATE ON acd_classes
    FOR EACH ROW EXECUTE FUNCTION trg_acd_classes_delete_guard();

-- Section lifecycle guard: sections may only be created under a LIVE class, and
-- may only be soft-deleted while no live enrollments reference them.
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
    END IF;
    RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS sections_lifecycle_validate_trg ON sections;
CREATE TRIGGER sections_lifecycle_validate_trg
    BEFORE INSERT OR UPDATE ON sections
    FOR EACH ROW EXECUTE FUNCTION trg_sections_lifecycle_validate();

-- ================================================================== RLS
-- Both new tables: FORCE row level security; tenant-branch CRUD for any row
-- whose tenant_id equals the signed tenant claim, privileged executor escapes
-- for maintenance/cross-tenant operations. Hard DELETE is privileged-only, so
-- the runtime role can only soft-delete (update deleted_at), never destroy.
DO $$
DECLARE
    t text;
BEGIN
    FOREACH t IN ARRAY ARRAY['acd_classes', 'sections'] LOOP
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
GRANT SELECT, INSERT, UPDATE, DELETE ON acd_classes, sections TO school_app_rw;

-- ================================================================== permission backfill
-- ==== PHASE 4.1 PERMISSION BACKFILL ====
-- Applies the Phase 4.1 class/section/placement permission set to system roles
-- that existed before this migration (idempotent; safe on re-run; scoped to
-- exact template codes only; never touches custom roles).
INSERT INTO role_permissions (role_id, permission)
SELECT r.id, p.permission
FROM roles r
JOIN (VALUES
    ('school_owner', 'classes.read'),
    ('school_owner', 'classes.create'),
    ('school_owner', 'classes.update'),
    ('school_owner', 'classes.delete'),
    ('school_owner', 'sections.read'),
    ('school_owner', 'sections.create'),
    ('school_owner', 'sections.update'),
    ('school_owner', 'sections.delete'),
    ('school_owner', 'placement.read'),
    ('school_owner', 'placement.manage'),
    ('principal', 'classes.read'),
    ('principal', 'sections.read'),
    ('principal', 'placement.read')
) AS p(code, permission) ON p.code = r.code
WHERE r.scope = 'tenant' AND r.is_system = true
ON CONFLICT (role_id, permission) DO NOTHING;
-- ==== END PHASE 4.1 PERMISSION BACKFILL ====