-- 0007_student_imports_admission_link
--
-- Phase 3.5 forward-only additions:
--   1. student_imports + student_import_rows: the async student CSV import job
--      (upload -> storage -> worker -> status/counts/row bucket results).
--   2. admission_applications.student_id uniqueness: an application may be linked
--      to at most one live student row so a single approval can never orphan rows,
--      and a student can trace back to the one application that produced it.
--   3. Phase 3.5 permission backfill for system roles created before this
--      migration (admission.read/create/update/review; principal gets read-only).
--
-- SECURITY MODEL (inherited, unchanged in spirit): every new table is FORCE ROW
-- LEVEL SECURITY, policies trust ONLY the signed context ticket
-- (app_current_tenant_id() / app_privileged()) exactly as 0005 did, the runtime
-- role can touch only rows whose tenant_id equals the signed tenant claim, hard
-- DELETE stays privileged-only, and all parents are referenced through composite
-- (tenant_id, id) anchors so cross-tenant references fail at the DB.
--
-- IMPORT JOB-DESIGN NOTES (mirrored by the worker in apps/worker/src/student-import.ts):
--   * student_imports is an operational record with NO deleted_at: there is no
--     delete endpoint and soft-deleting an import would mask its audit trail.
--   * campus_id captures the UPLOADER's campus authorization boundary (NULL =
--     school-wide uploader). Bulk creation happens in the worker with no request
--     context, so the scope must be pinned at upload time; the worker enforces it
--     per row (a campus-scoped upload may only materialize rows for that campus).
--   * storage_key is UNIQUE (like files) so every import maps to exactly one
--     stored CSV object and the worker's delete of that object is unambiguous.
--   * status CHECK pins the worker's state machine (submitted -> processing ->
--     completed|failed) so the finalize transition is single-winner and cannot
--     drift into un-migrated states.
--   * every data row maps to one student_import_rows row carrying a result
--     bucket + the offending field/message ONLY (never board row PII). Buckets:
--       created   - student (and optional guardian/link) inserted => student_id set
--       duplicate - a prior row in the SAME import already created this student_no
--       conflict  - a live student with this student_no already exists in the tenant
--       rejected  - validation failure or campus/authorization rejection
--     A CHECK keeps buckets exact (created implies student_id, others imply none).
--   * row_number uniqueness is per-import (crash-safe: the worker skips rows that
--     already carry a result, so redelivery cannot double-insert a student).
--
-- ADMISSION LINK: partial unique index scoped to live rows only — history may
-- keep unlinked applications, but at most one live (tenant, student) pair exists.

-- ================================================================== student_imports
CREATE TABLE student_imports (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    campus_id       uuid,
    filename        text NOT NULL,
    storage_key     text NOT NULL,
    status          text NOT NULL DEFAULT 'submitted',
    total_rows      integer NOT NULL DEFAULT 0,
    created_count   integer NOT NULL DEFAULT 0,
    duplicate_count integer NOT NULL DEFAULT 0,
    conflict_count  integer NOT NULL DEFAULT 0,
    rejected_count  integer NOT NULL DEFAULT 0,
    error_summary   text,
    created_by      uuid,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT student_imports_status_ck CHECK (status IN
        ('submitted', 'processing', 'completed', 'failed')),
    CONSTRAINT student_imports_counts_ck CHECK (
        total_rows >= 0 AND created_count >= 0 AND duplicate_count >= 0 AND
        conflict_count >= 0 AND rejected_count >= 0
    ),
    CONSTRAINT student_imports_storage_key_uq UNIQUE (storage_key),
    -- Captures the uploader's campus authorization boundary (see header note):
    -- NULL = school-wide uploader, otherwise the one campus the uploader may
    -- materialize students on. The worker enforces it per row.
    CONSTRAINT student_imports_campus_fk FOREIGN KEY (tenant_id, campus_id)
        REFERENCES campuses (tenant_id, id)
);
-- Composite tenant-aware FK anchor (student_import_rows references this).
CREATE UNIQUE INDEX student_imports_tenant_id_uq ON student_imports (tenant_id, id);
-- List pagination (created_at DESC, id DESC keyset) + status scoping.
CREATE INDEX student_imports_tenant_status_idx
    ON student_imports (tenant_id, status, created_at DESC, id DESC);
CREATE INDEX student_imports_tenant_created_idx
    ON student_imports (tenant_id, created_at DESC, id DESC);

-- ================================================================== student_import_rows
CREATE TABLE student_import_rows (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   uuid NOT NULL,
    import_id   uuid NOT NULL,
    row_number  integer NOT NULL,
    status      text NOT NULL,
    student_id  uuid,
    field       text,
    message     text,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT student_import_rows_import_fk FOREIGN KEY (tenant_id, import_id)
        REFERENCES student_imports (tenant_id, id) ON DELETE CASCADE,
    CONSTRAINT student_import_rows_student_fk FOREIGN KEY (tenant_id, student_id)
        REFERENCES students (tenant_id, id),
    CONSTRAINT student_import_rows_status_ck CHECK (status IN
        ('created', 'duplicate', 'conflict', 'rejected')),
    CONSTRAINT student_import_rows_row_uq UNIQUE (tenant_id, import_id, row_number),
    CONSTRAINT student_import_rows_bucket_ck CHECK (
        (status = 'created' AND student_id IS NOT NULL) OR
        (status <> 'created' AND student_id IS NULL)
    )
);
CREATE INDEX student_import_rows_import_idx ON student_import_rows (tenant_id, import_id);

-- ================================================================== admission_applications link
CREATE UNIQUE INDEX admission_applications_student_uq
    ON admission_applications (tenant_id, student_id)
    WHERE student_id IS NOT NULL AND deleted_at IS NULL;

-- ================================================================== RLS
DO $$
DECLARE
    t text;
BEGIN
    FOREACH t IN ARRAY ARRAY['student_imports', 'student_import_rows'] LOOP
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
GRANT SELECT, INSERT, UPDATE, DELETE ON student_imports, student_import_rows TO school_app_rw;

-- ================================================================== permission backfill
-- ==== PHASE 3.5 PERMISSION BACKFILL ====
-- Applies the Phase 3.5 admission permission set to system roles that existed
-- before this migration (idempotent; safe on re-run; scoped to exact template
-- codes only; never touches custom roles).
INSERT INTO role_permissions (role_id, permission)
SELECT r.id, p.permission
FROM roles r
JOIN (VALUES
    ('school_owner', 'admission.read'),
    ('school_owner', 'admission.create'),
    ('school_owner', 'admission.update'),
    ('school_owner', 'admission.review'),
    ('principal', 'admission.read')
) AS p(code, permission) ON p.code = r.code
WHERE r.scope = 'tenant' AND r.is_system = true
ON CONFLICT (role_id, permission) DO NOTHING;
-- ==== END PHASE 3.5 PERMISSION BACKFILL ====