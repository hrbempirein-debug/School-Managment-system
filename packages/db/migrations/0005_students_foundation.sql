-- 0005: Phase 3.1 students/guardians/enrollment FOUNDATION (forward-only).
--
-- Adds the tenant-scoped student lifecycle beneath the Phase 2B authorization
-- layer: files metadata (minimal), students, guardians, student_guardians,
-- enrollments, student_documents, admission_applications, transfers,
-- promotion_batches, promotion_items, plus the pg_trgm search foundation and
-- the Phase 3.1 permission backfill for tenants created before this migration.
--
-- WHAT THIS PHASE DELIBERATELY DOES NOT DO (arrives with Phase 3.2+):
--   * No API routes / CRUD / actions. No contracts in @sms/contracts.
--   * No class/section wiring: acd_classes/acd_sections are Phase 4, so
--     enrollments.class_id / section_id and promotion_items.from/to_section_id
--     are nullable columns ONLY (roll_no uniqueness is expressed as a partial
--     unique index that becomes fully enforceable as soon as sections land).
--   * No status-transition triggers: the state machines for admissions,
--     enrollment, promotion and transfers are Phase 3.2 domain logic. The
--     foundation pins the value sets with CHECK constraints so later logic
--     cannot drift into un-migrated states. "Do not invent" holds: every CHECK
--     below comes from DATABASE_DESIGN.md / MASTER (admission), transfer and
--     promotion states are the smallest closed set implied by those modules.
--   * No student documents upload flow; the files metadata table is the
--     required anchor so student_documents.file_id is a real FK.
--
-- SECURITY MODEL (inherited from 0002/0003/0004):
--   * Every table is FORCE ROW LEVEL SECURITY. Policies trust ONLY the signed
--     context ticket (app_current_tenant_id()/app_privileged()); no raw
--     current_setting('app.*') is ever read, and no BYPASSRLS / SET ROLE /
--     SECURITY DEFINER shortcut is used.
--   * The runtime role (school_app_rw) can see and mutate only rows whose
--     tenant_id equals the signed tenant claim. The privileged executor
--     (school_migrator) is the sole DELETE-capable and cross-tenant role.
--   * tenant_id derives from the trusted context in the API layer and is
--     enforced here WITH CHECK; a forged/foreign tenant_id on INSERT/UPDATE is
--     impossible even if application authz is bypassed.
--   * Cross-table tenant integrity uses composite tenant-aware foreign keys:
--     every child references the parent's UNIQUE (tenant_id, id) anchor, so a
--     cross-tenant parent reference fails at the DB before any business rule.
--   * students carries the Phase-1 "RESTRICT" decision from DATABASE_DESIGN
--     §4: hard deletion of a student is blocked while any operational child
--     (enrollment, transfer, admission application, promotion item) references
--     it. Pure-dependent bridges (student_guardians, student_documents) CASCADE
--     so the privileged purge path can clean them; files metadata is RESTRICT
--     (retention job owns object lifecycle, never auto-deleted).
--
-- SEARCH FOUNDATION:
--   * pg_trgm (trusted extension, installable by the database owner) enables
--     fast ILIKE name search for the Phase 3.2 list/filter/search work. A GIN
--     trigram index over the full display name (first last order) backs the
--     planned `q=` parameter; a btree (tenant_id, status, last_name) partial
--     index backs the common status-scoped directory listing.
--
-- PERMISSION BACKFILL:
--   * Tenants created before this migration seeded their system roles from the
--     PERMISSION_CATALOG of that time and therefore lack the Phase 3.1
--     permissions. The single idempotent statement at the bottom adds exactly
--     the Phase 3.1 set to those existing system roles that match a template
--     code (school_owner full set, principal read-only set). It touches only
--     is_system roles with a known template code, never custom roles, and is a
--     no-op for tenants created after this migration (their templates already
--     include the set). ON CONFLICT DO NOTHING makes re-runs safe.

-- ================================================================== search
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ================================================================== files
-- Minimal file-metadata foundation (FILE_STORAGE.md §4). RLS tenant-scoped;
-- the runtime role can never read/write objects outside a signed tenant claim
-- and physical object lifecycle belongs to the privileged retention path.
CREATE TABLE files (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id    uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    storage_key  text NOT NULL,
    original_name text NOT NULL,
    mime         text NOT NULL,
    size_bytes   bigint NOT NULL,
    content_hash text,
    visibility   text NOT NULL DEFAULT 'private',
    owner_type   text,
    owner_id     uuid,
    scan_status  text NOT NULL DEFAULT 'pending',
    created_by   uuid,
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now(),
    deleted_at   timestamptz,
    CONSTRAINT files_storage_key_uq UNIQUE (storage_key),
    CONSTRAINT files_visibility_ck CHECK (visibility IN ('private', 'tenant_portal')),
    CONSTRAINT files_scan_status_ck CHECK (scan_status IN ('pending', 'clean', 'blocked')),
    CONSTRAINT files_size_ck CHECK (size_bytes >= 0)
);
-- Composite tenant-aware FK anchor (students.photo_file_id,
-- student_documents.file_id reference this).
CREATE UNIQUE INDEX files_tenant_id_uq ON files (tenant_id, id);
CREATE INDEX files_owner_idx ON files (tenant_id, owner_type, owner_id)
    WHERE deleted_at IS NULL;

-- ================================================================== students
CREATE TABLE students (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id        uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    student_no       text NOT NULL,
    first_name       text NOT NULL,
    last_name        text NOT NULL,
    date_of_birth    date,
    gender           text,
    status           text NOT NULL DEFAULT 'applicant',
    primary_campus_id uuid,
    photo_file_id    uuid,
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),
    deleted_at       timestamptz,
    CONSTRAINT students_status_ck CHECK (status IN
        ('applicant', 'active', 'transferred', 'graduated', 'alumni')),
    CONSTRAINT students_gender_ck CHECK (gender IN ('male', 'female', 'other')),
    -- photo/campus references are tenant-aware; campus FK is RESTRICT so a
    -- campus cannot vanish under active students.
    CONSTRAINT students_photo_file_fk FOREIGN KEY (tenant_id, photo_file_id)
        REFERENCES files (tenant_id, id),
    CONSTRAINT students_primary_campus_fk FOREIGN KEY (tenant_id, primary_campus_id)
        REFERENCES campuses (tenant_id, id)
);
-- Composite tenant-aware FK anchor (enrollments, student_documents, transfers,
-- admission_applications, promotion_items reference this).
CREATE UNIQUE INDEX students_tenant_id_uq ON students (tenant_id, id);
-- Tenant-local student_no uniqueness for LIVE rows only (deleted history may
-- reuse a number for a new applicant).
CREATE UNIQUE INDEX students_student_no_uq ON students (tenant_id, student_no)
    WHERE deleted_at IS NULL;
-- Directory listing / status scoping (DATABASE_DESIGN §17).
CREATE INDEX students_tenant_status_name_idx ON students (tenant_id, status, last_name)
    WHERE deleted_at IS NULL;
-- Search foundation: ILIKE '%query%' over the display name.
CREATE INDEX students_name_trgm_idx ON students
    USING gin ((first_name || ' ' || last_name) gin_trgm_ops);

-- ================================================================== guardians
CREATE TABLE guardians (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id  uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    user_id    uuid REFERENCES users (id) ON DELETE SET NULL,
    first_name text NOT NULL,
    last_name  text NOT NULL,
    email      text,
    phone      text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz
);
CREATE UNIQUE INDEX guardians_tenant_id_uq ON guardians (tenant_id, id);
CREATE INDEX guardians_tenant_name_idx ON guardians (tenant_id, last_name)
    WHERE deleted_at IS NULL;
-- At most one portal-linked guardian per user per tenant.
CREATE UNIQUE INDEX guardians_tenant_user_uq ON guardians (tenant_id, user_id)
    WHERE user_id IS NOT NULL AND deleted_at IS NULL;

-- ================================================================== student_guardians
CREATE TABLE student_guardians (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   uuid NOT NULL,
    student_id  uuid NOT NULL,
    guardian_id uuid NOT NULL,
    relation    text NOT NULL,
    is_primary  boolean NOT NULL DEFAULT false,
    can_pickup  boolean NOT NULL DEFAULT false,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT student_guardians_student_fk FOREIGN KEY (tenant_id, student_id)
        REFERENCES students (tenant_id, id) ON DELETE CASCADE,
    CONSTRAINT student_guardians_guardian_fk FOREIGN KEY (tenant_id, guardian_id)
        REFERENCES guardians (tenant_id, id) ON DELETE CASCADE,
    CONSTRAINT student_guardians_relation_uq UNIQUE (tenant_id, student_id, guardian_id, relation)
);
CREATE INDEX student_guardians_student_idx ON student_guardians (tenant_id, student_id);
CREATE INDEX student_guardians_guardian_idx ON student_guardians (tenant_id, guardian_id);

-- ================================================================== enrollments
CREATE TABLE enrollments (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id        uuid NOT NULL,
    student_id       uuid NOT NULL,
    academic_year_id uuid NOT NULL,
    class_id         uuid,
    section_id       uuid,
    roll_no          text,
    status           text NOT NULL DEFAULT 'active',
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),
    deleted_at       timestamptz,
    CONSTRAINT enrollments_student_fk FOREIGN KEY (tenant_id, student_id)
        REFERENCES students (tenant_id, id),
    CONSTRAINT enrollments_year_fk FOREIGN KEY (tenant_id, academic_year_id)
        REFERENCES academic_years (tenant_id, id),
    CONSTRAINT enrollments_status_ck CHECK (status IN ('active', 'withdrawn', 'completed'))
);
-- Tenant-local one-live-enrollment-per-student-per-year (deleted history free).
CREATE UNIQUE INDEX enrollments_student_year_uq ON enrollments (tenant_id, student_id, academic_year_id)
    WHERE deleted_at IS NULL;
-- roll_no uniqueness arrives with sections (Phase 4): unique per tenant,
-- section and roll_no among live/active rows. NULL section_id (pre-Phase 4)
-- rows are untouched by the index, so the Phase 3 foundation cannot collide.
CREATE UNIQUE INDEX enrollments_roll_no_uq ON enrollments (tenant_id, section_id, roll_no)
    WHERE deleted_at IS NULL AND status = 'active' AND section_id IS NOT NULL AND roll_no IS NOT NULL;
CREATE INDEX enrollments_tenant_year_status_idx ON enrollments (tenant_id, academic_year_id, status)
    WHERE deleted_at IS NULL;

-- ================================================================== student_documents
CREATE TABLE student_documents (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     uuid NOT NULL,
    student_id    uuid NOT NULL,
    document_type text NOT NULL,
    file_id       uuid NOT NULL,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),
    deleted_at    timestamptz,
    CONSTRAINT student_documents_student_fk FOREIGN KEY (tenant_id, student_id)
        REFERENCES students (tenant_id, id) ON DELETE CASCADE,
    CONSTRAINT student_documents_file_fk FOREIGN KEY (tenant_id, file_id)
        REFERENCES files (tenant_id, id)
);
CREATE INDEX student_documents_student_idx ON student_documents (tenant_id, student_id)
    WHERE deleted_at IS NULL;

-- ================================================================== admission_applications
CREATE TABLE admission_applications (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id  uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    student_id uuid,
    status     text NOT NULL DEFAULT 'draft',
    snapshot   jsonb NOT NULL DEFAULT '{}'::jsonb,
    applied_on date,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz,
    CONSTRAINT admission_applications_student_fk FOREIGN KEY (tenant_id, student_id)
        REFERENCES students (tenant_id, id),
    CONSTRAINT admission_applications_status_ck CHECK (status IN
        ('draft', 'submitted', 'under_review', 'accepted', 'rejected', 'withdrawn'))
);
CREATE INDEX admission_applications_tenant_status_idx ON admission_applications (tenant_id, status)
    WHERE deleted_at IS NULL;

-- ================================================================== transfers
CREATE TABLE transfers (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id        uuid NOT NULL,
    student_id       uuid NOT NULL,
    type             text NOT NULL,
    status           text NOT NULL DEFAULT 'in_progress',
    from_school_name text,
    to_school_name   text,
    reason           text,
    transferred_on   date,
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),
    deleted_at       timestamptz,
    CONSTRAINT transfers_student_fk FOREIGN KEY (tenant_id, student_id)
        REFERENCES students (tenant_id, id),
    CONSTRAINT transfers_type_ck CHECK (type IN ('in', 'out')),
    CONSTRAINT transfers_status_ck CHECK (status IN ('in_progress', 'completed', 'cancelled'))
);
CREATE INDEX transfers_tenant_student_idx ON transfers (tenant_id, student_id)
    WHERE deleted_at IS NULL;

-- ================================================================== promotion_batches
CREATE TABLE promotion_batches (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           uuid NOT NULL,
    from_academic_year_id uuid NOT NULL,
    to_academic_year_id uuid NOT NULL,
    status              text NOT NULL DEFAULT 'draft',
    created_by          uuid,
    completed_at        timestamptz,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    deleted_at          timestamptz,
    CONSTRAINT promotion_batches_from_year_fk FOREIGN KEY (tenant_id, from_academic_year_id)
        REFERENCES academic_years (tenant_id, id),
    CONSTRAINT promotion_batches_to_year_fk FOREIGN KEY (tenant_id, to_academic_year_id)
        REFERENCES academic_years (tenant_id, id),
    CONSTRAINT promotion_batches_status_ck CHECK (status IN ('draft', 'in_progress', 'completed', 'cancelled')),
    CONSTRAINT promotion_batches_distinct_years_ck CHECK (from_academic_year_id <> to_academic_year_id)
);
CREATE UNIQUE INDEX promotion_batches_tenant_id_uq ON promotion_batches (tenant_id, id);
CREATE INDEX promotion_batches_tenant_status_idx ON promotion_batches (tenant_id, status)
    WHERE deleted_at IS NULL;

-- ================================================================== promotion_items
CREATE TABLE promotion_items (
    id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id            uuid NOT NULL,
    batch_id             uuid NOT NULL,
    student_id           uuid NOT NULL,
    from_academic_year_id uuid NOT NULL,
    to_academic_year_id  uuid NOT NULL,
    from_section_id      uuid,
    to_section_id        uuid,
    status               text NOT NULL DEFAULT 'pending',
    error                text,
    created_at           timestamptz NOT NULL DEFAULT now(),
    updated_at           timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT promotion_items_batch_fk FOREIGN KEY (tenant_id, batch_id)
        REFERENCES promotion_batches (tenant_id, id) ON DELETE CASCADE,
    CONSTRAINT promotion_items_student_fk FOREIGN KEY (tenant_id, student_id)
        REFERENCES students (tenant_id, id),
    CONSTRAINT promotion_items_from_year_fk FOREIGN KEY (tenant_id, from_academic_year_id)
        REFERENCES academic_years (tenant_id, id),
    CONSTRAINT promotion_items_to_year_fk FOREIGN KEY (tenant_id, to_academic_year_id)
        REFERENCES academic_years (tenant_id, id),
    CONSTRAINT promotion_items_status_ck CHECK (status IN ('pending', 'promoted', 'failed')),
    CONSTRAINT promotion_items_batch_student_uq UNIQUE (tenant_id, batch_id, student_id)
);
CREATE INDEX promotion_items_batch_idx ON promotion_items (tenant_id, batch_id);

-- ================================================================== RLS
-- All ten tables: FORCE row level security; tenant-branch CRUD for any row
-- whose tenant_id equals the signed tenant claim, privileged executor escapes
-- for maintenance/cross-tenant operations. Hard DELETE is privileged-only, so
-- the runtime role can only soft-delete (update deleted_at), never destroy.
DO $$
DECLARE
    t text;
BEGIN
    FOREACH t IN ARRAY ARRAY[
        'files', 'students', 'guardians', 'student_guardians', 'enrollments',
        'student_documents', 'admission_applications', 'transfers',
        'promotion_batches', 'promotion_items'
    ] LOOP
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
GRANT SELECT, INSERT, UPDATE, DELETE ON
    files, students, guardians, student_guardians, enrollments,
    student_documents, admission_applications, transfers,
    promotion_batches, promotion_items TO school_app_rw;

-- ================================================================== permission backfill
-- ==== PHASE 3.1 PERMISSION BACKFILL ====
-- Applies the Phase 3.1 permission set to system roles that existed before this
-- migration (idempotent; safe on re-run; scoped to exact template codes only).
INSERT INTO role_permissions (role_id, permission)
SELECT r.id, p.permission
FROM roles r
JOIN (VALUES
    ('school_owner', 'students.read'),
    ('school_owner', 'students.create'),
    ('school_owner', 'students.update'),
    ('school_owner', 'students.delete'),
    ('school_owner', 'students.export'),
    ('school_owner', 'guardians.read'),
    ('school_owner', 'guardians.create'),
    ('school_owner', 'guardians.update'),
    ('school_owner', 'enrollment.read'),
    ('school_owner', 'enrollment.manage'),
    ('principal', 'students.read'),
    ('principal', 'guardians.read'),
    ('principal', 'enrollment.read')
) AS p(code, permission) ON p.code = r.code
WHERE r.scope = 'tenant' AND r.is_system = true
ON CONFLICT (role_id, permission) DO NOTHING;
-- ==== END PHASE 3.1 PERMISSION BACKFILL ====