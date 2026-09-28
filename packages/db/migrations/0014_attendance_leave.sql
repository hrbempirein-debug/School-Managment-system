-- 0014: Phase 5 — daily + period attendance, staff attendance (light), student leave (forward-only).
--
-- Implements the roadmap Phase 5 DB scope verbatim: `attendance_days`,
-- `attendance_periods`, `staff_attendance (light)`, `leave_requests`,
-- `leave_types (student)`. Same § conventions as Phase 4.1/4.2/4.3 (migration
-- 0008/0009/0011): RLS ENABLE + FORCE, tenant-branch SELECT/INSERT/UPDATE,
-- privileged-only hard DELETE, school_app_rw grants, SECURITY INVOKER triggers,
-- composite tenant-aware foreign keys, live partial unique indexes.
--
-- CORE DOMAIN RULES (DATABASE_DESIGN §6):
--   * Attendance rows are MUTABLE ONLY SAME-DAY. A correction is a status UPDATE
--     on the row for the CURRENT school-local date and nothing else. The
--     attendance_date itself is immutable, so a row can never be slid onto a
--     mutable day to bypass the guard. INSERT may backfill any non-future date
--     (marking yesterday is legitimate); a future date is refused outright.
--   * Every correction path is audited by the caller (writeAudit with the old
--     and new status plus a required reason) — the DB supplies the invariant,
--     the API supplies the audit trail, and both are proven by the suites.
--
-- IDEMPOTENCY is a database property, not an application convention: marking the
-- same (student, date[, period]) twice collides with a live partial unique index
-- (23505), which the API turns into a conflict or resolves with an upsert.
--
-- DESIGN NOTES / SCOPE BOUNDARIES:
--   * `staff_attendance` is anchored on the tenant MEMBERSHIP user_id, not on a
--     Phase 10 `hr_employees` row. DATABASE_DESIGN §6 sketches `employee_id`,
--     but `employees` is a Phase 10 table (§10) and the roadmap qualifies this
--     table "(light)". Creating `employees` now would pull Phase 10 forward and
--     duplicate a future table. Membership is the same identity pattern Phase 4.2
--     established for teachers ("teacher identity = membership + role, not a
--     table", AUTHORIZATION.md) and is composite-FK-pinned to the tenant, so a
--     cross-tenant reference is structurally impossible.
--   * Period attendance is section-scoped: a period record belongs to a SECTION
--     and a live bell PERIOD, and the trigger proves the student is actually
--     ENROLLED in that section. Daily attendance is whole-school and therefore
--     carries the student's campus (NULL = school-wide, the same convention
--     campuses use), pinned to the student's own primary campus.
--   * `leave_types` is the Phase 5 STUDENT leave catalog. Employee leave types
--     remain Phase 10 (`hr.leave_types`) and are deliberately not created here.
--   * `marked_by` / `requested_by` / `approver_user_id` are composite-FK-pinned to
--     memberships(tenant_id, user_id) (anchored on the 0009
--     memberships_tenant_user_uq) and trigger-verified to be ACTIVE, so an
--     attendance row can never be attributed to a non-member or to a member of
--     another school.
--
-- DELIBERATELY OUT OF SCOPE: no exam/result tables, no finance tables, no
-- notification/communication tables, no employees/HR tables, no library or
-- transport tables. Notification of late arrivals is an outbox EVENT consumed by
-- a stub channel in the worker (real delivery is Phase 8).

-- ================================================================== leave_types
-- Student leave catalog per tenant (school-managed list of leave reasons).
CREATE TABLE leave_types (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL,
    code text NOT NULL,
    name text NOT NULL,
    status text NOT NULL DEFAULT 'active',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz,
    CONSTRAINT leave_types_status_ck CHECK (status IN ('active','inactive'))
);

CREATE UNIQUE INDEX leave_types_tenant_id_uq ON leave_types (tenant_id, id);
CREATE UNIQUE INDEX leave_types_tenant_code_uq ON leave_types (tenant_id, code)
    WHERE deleted_at IS NULL;
CREATE INDEX leave_types_tenant_status_idx ON leave_types (tenant_id, status)
    WHERE deleted_at IS NULL;

-- ================================================================== attendance_days
-- One row per student per school-local date. `source` records provenance:
-- 'manual' = daily register, 'period' = derived/rolled up from period marking.
CREATE TABLE attendance_days (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL,
    student_id uuid NOT NULL,
    campus_id uuid,
    attendance_date date NOT NULL,
    status text NOT NULL,
    source text NOT NULL DEFAULT 'manual',
    marked_by uuid NOT NULL,
    note text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz,
    CONSTRAINT attendance_days_status_ck
        CHECK (status IN ('present','absent','late','excused')),
    CONSTRAINT attendance_days_source_ck
        CHECK (source IN ('manual','period')),
    -- Idempotency anchor: marking the same student/date twice is a conflict, not
    -- a duplicate row.
    CONSTRAINT attendance_days_tenant_student_date_uq UNIQUE (tenant_id, student_id, attendance_date),
    CONSTRAINT attendance_days_student_fk
        FOREIGN KEY (tenant_id, student_id) REFERENCES students (tenant_id, id) ON DELETE RESTRICT,
    CONSTRAINT attendance_days_campus_fk
        FOREIGN KEY (tenant_id, campus_id) REFERENCES campuses (tenant_id, id) ON DELETE RESTRICT,
    -- The marker must be a member of THIS tenant (memberships_tenant_user_uq, 0009).
    CONSTRAINT attendance_days_marker_fk
        FOREIGN KEY (tenant_id, marked_by) REFERENCES memberships (tenant_id, user_id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX attendance_days_tenant_id_uq ON attendance_days (tenant_id, id);
CREATE INDEX attendance_days_tenant_date_idx ON attendance_days (tenant_id, attendance_date)
    WHERE deleted_at IS NULL;
CREATE INDEX attendance_days_tenant_student_idx ON attendance_days (tenant_id, student_id, attendance_date)
    WHERE deleted_at IS NULL;
CREATE INDEX attendance_days_tenant_status_idx ON attendance_days (tenant_id, attendance_date, status)
    WHERE deleted_at IS NULL;
CREATE INDEX attendance_days_campus_date_idx ON attendance_days (tenant_id, campus_id, attendance_date)
    WHERE deleted_at IS NULL;

-- ================================================================== attendance_periods
-- Period-level attendance for a SECTION during a bell PERIOD. The section is the
-- unit of marking (a teacher marks their section), which is also what makes the
-- teacher scope and the campus scope derivable.
CREATE TABLE attendance_periods (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL,
    student_id uuid NOT NULL,
    section_id uuid NOT NULL,
    period_id uuid NOT NULL,
    attendance_date date NOT NULL,
    status text NOT NULL,
    marked_by uuid NOT NULL,
    note text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz,
    CONSTRAINT attendance_periods_status_ck
        CHECK (status IN ('present','absent','late','excused')),
    -- Idempotency anchor: one mark per (student, date, period) per section.
    CONSTRAINT attendance_periods_tenant_student_date_period_uq
        UNIQUE (tenant_id, student_id, attendance_date, period_id),
    CONSTRAINT attendance_periods_student_fk
        FOREIGN KEY (tenant_id, student_id) REFERENCES students (tenant_id, id) ON DELETE RESTRICT,
    CONSTRAINT attendance_periods_section_fk
        FOREIGN KEY (tenant_id, section_id) REFERENCES sections (tenant_id, id) ON DELETE RESTRICT,
    CONSTRAINT attendance_periods_period_fk
        FOREIGN KEY (tenant_id, period_id) REFERENCES periods (tenant_id, id) ON DELETE RESTRICT,
    CONSTRAINT attendance_periods_marker_fk
        FOREIGN KEY (tenant_id, marked_by) REFERENCES memberships (tenant_id, user_id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX attendance_periods_tenant_id_uq ON attendance_periods (tenant_id, id);
CREATE INDEX attendance_periods_tenant_date_idx ON attendance_periods (tenant_id, attendance_date)
    WHERE deleted_at IS NULL;
CREATE INDEX attendance_periods_section_date_idx
    ON attendance_periods (tenant_id, section_id, attendance_date, period_id)
    WHERE deleted_at IS NULL;
CREATE INDEX attendance_periods_student_date_idx
    ON attendance_periods (tenant_id, student_id, attendance_date)
    WHERE deleted_at IS NULL;

-- ================================================================== staff_attendance
-- Light staff attendance clock (see the header note on membership-anchored
-- identity). One row per staff member per date; clock_out is optional so an open
-- shift is representable.
CREATE TABLE staff_attendance (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL,
    user_id uuid NOT NULL,
    attendance_date date NOT NULL,
    clock_in timestamptz,
    clock_out timestamptz,
    status text NOT NULL DEFAULT 'present',
    note text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz,
    CONSTRAINT staff_attendance_status_ck
        CHECK (status IN ('present','absent','late','excused','on_leave')),
    CONSTRAINT staff_attendance_unique_day UNIQUE (tenant_id, user_id, attendance_date),
    -- Staff identity is a membership of THIS tenant (memberships_tenant_user_uq, 0009).
    CONSTRAINT staff_attendance_user_fk
        FOREIGN KEY (tenant_id, user_id) REFERENCES memberships (tenant_id, user_id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX staff_attendance_tenant_id_uq ON staff_attendance (tenant_id, id);
CREATE INDEX staff_attendance_tenant_date_idx ON staff_attendance (tenant_id, attendance_date)
    WHERE deleted_at IS NULL;
CREATE INDEX staff_attendance_user_date_idx ON staff_attendance (tenant_id, user_id, attendance_date)
    WHERE deleted_at IS NULL;

-- ================================================================== leave_requests
-- Student leave requests with an explicit pending -> approved|rejected state
-- machine. The approver is a membership of the same tenant; the decision columns
-- are frozen once the request leaves 'pending'.
CREATE TABLE leave_requests (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL,
    student_id uuid NOT NULL,
    leave_type_id uuid NOT NULL,
    start_date date NOT NULL,
    end_date date NOT NULL,
    reason text,
    status text NOT NULL DEFAULT 'pending',
    requested_by uuid NOT NULL,
    approver_user_id uuid,
    decision_at timestamptz,
    decision_note text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz,
    CONSTRAINT leave_requests_status_ck
        CHECK (status IN ('pending','approved','rejected')),
    -- The decision columns are only meaningful once decided: a decided request
    -- always has an approver and a decision timestamp.
    CONSTRAINT leave_requests_decision_ck CHECK (
        (status = 'pending' AND approver_user_id IS NULL AND decision_at IS NULL)
        OR (status IN ('approved','rejected') AND approver_user_id IS NOT NULL AND decision_at IS NOT NULL)
    ),
    CONSTRAINT leave_requests_student_fk
        FOREIGN KEY (tenant_id, student_id) REFERENCES students (tenant_id, id) ON DELETE RESTRICT,
    CONSTRAINT leave_requests_type_fk
        FOREIGN KEY (tenant_id, leave_type_id) REFERENCES leave_types (tenant_id, id) ON DELETE RESTRICT,
    CONSTRAINT leave_requests_requester_fk
        FOREIGN KEY (tenant_id, requested_by) REFERENCES memberships (tenant_id, user_id) ON DELETE RESTRICT,
    CONSTRAINT leave_requests_approver_fk
        FOREIGN KEY (tenant_id, approver_user_id) REFERENCES memberships (tenant_id, user_id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX leave_requests_tenant_id_uq ON leave_requests (tenant_id, id);
CREATE INDEX leave_requests_tenant_student_idx
    ON leave_requests (tenant_id, student_id, start_date)
    WHERE deleted_at IS NULL;
CREATE INDEX leave_requests_tenant_status_idx
    ON leave_requests (tenant_id, status, start_date)
    WHERE deleted_at IS NULL;

-- ================================================================== trigger helpers
-- `current_date` resolves in the SESSION timezone, which the application's pooled
-- connections inherit from the server (school-local). Same-day therefore means
-- "the school-local calendar day", which is the only interpretation a school
-- registrar can act on.

-- Attendance-day integrity + same-day correction guard.
CREATE OR REPLACE FUNCTION trg_attendance_days_validate()
RETURNS trigger AS $$
DECLARE
    v_student record;
    v_today date := current_date;
BEGIN
    IF NEW.attendance_date > v_today THEN
        RAISE EXCEPTION 'attendance cannot be marked for a future date'
            USING ERRCODE = '55000';
    END IF;

    IF TG_OP = 'UPDATE' THEN
        IF NEW.attendance_date IS DISTINCT FROM OLD.attendance_date THEN
            RAISE EXCEPTION 'attendance date is immutable'
                USING ERRCODE = '55000';
        END IF;
        -- Same-day correction rule: past days are frozen snapshots.
        IF OLD.attendance_date <> v_today THEN
            RAISE EXCEPTION 'attendance can only be corrected on the same day as the attendance date'
                USING ERRCODE = '55000';
        END IF;
    END IF;

    -- SECURITY INVOKER: runs under the caller's RLS, so a student of another
    -- tenant is invisible here and the domain conflict (not an FK probe) fires.
    SELECT s.status, s.primary_campus_id INTO v_student
    FROM students s
    WHERE s.tenant_id = NEW.tenant_id AND s.id = NEW.student_id AND s.deleted_at IS NULL;

    IF v_student IS NULL THEN
        RAISE EXCEPTION 'attendance requires an existing student in this school'
            USING ERRCODE = '55000';
    END IF;
    IF v_student.status <> 'active' THEN
        RAISE EXCEPTION 'attendance can only be recorded for an active student'
            USING ERRCODE = '55000';
    END IF;
    -- The campus must be the student's own campus; a school-wide student (NULL)
    -- may be recorded under any campus.
    IF NEW.campus_id IS DISTINCT FROM v_student.primary_campus_id
       AND v_student.primary_campus_id IS NOT NULL THEN
        RAISE EXCEPTION 'attendance campus does not match the student campus'
            USING ERRCODE = '55000';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM memberships m
        WHERE m.tenant_id = NEW.tenant_id AND m.user_id = NEW.marked_by AND m.status = 'active'
    ) THEN
        RAISE EXCEPTION 'attendance must be marked by an active staff membership in this tenant'
            USING ERRCODE = '55000';
    END IF;

    RETURN NEW;
END
$$ LANGUAGE plpgsql SECURITY INVOKER;

DROP TRIGGER IF EXISTS attendance_days_validate_trg ON attendance_days;
CREATE TRIGGER attendance_days_validate_trg
    BEFORE INSERT OR UPDATE ON attendance_days
    FOR EACH ROW EXECUTE FUNCTION trg_attendance_days_validate();

-- Period-attendance integrity + same-day correction guard. The section membership
-- check is what stops attendance being recorded for a student who is not in the
-- class whose register is being marked.
CREATE OR REPLACE FUNCTION trg_attendance_periods_validate()
RETURNS trigger AS $$
DECLARE
    v_today date := current_date;
BEGIN
    IF NEW.attendance_date > v_today THEN
        RAISE EXCEPTION 'attendance cannot be marked for a future date'
            USING ERRCODE = '55000';
    END IF;

    IF TG_OP = 'UPDATE' THEN
        IF NEW.attendance_date IS DISTINCT FROM OLD.attendance_date THEN
            RAISE EXCEPTION 'attendance date is immutable'
                USING ERRCODE = '55000';
        END IF;
        IF NEW.period_id IS DISTINCT FROM OLD.period_id
           OR NEW.section_id IS DISTINCT FROM OLD.section_id
           OR NEW.student_id IS DISTINCT FROM OLD.student_id THEN
            RAISE EXCEPTION 'period attendance is bound to its student, section and period'
                USING ERRCODE = '55000';
        END IF;
        IF OLD.attendance_date <> v_today THEN
            RAISE EXCEPTION 'attendance can only be corrected on the same day as the attendance date'
                USING ERRCODE = '55000';
        END IF;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM students s
        WHERE s.tenant_id = NEW.tenant_id AND s.id = NEW.student_id
          AND s.deleted_at IS NULL AND s.status = 'active'
    ) THEN
        RAISE EXCEPTION 'attendance requires an active student in this school'
            USING ERRCODE = '55000';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM sections sec
        WHERE sec.tenant_id = NEW.tenant_id AND sec.id = NEW.section_id
          AND sec.deleted_at IS NULL AND sec.status = 'active'
    ) THEN
        RAISE EXCEPTION 'period attendance requires an active section'
            USING ERRCODE = '55000';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM periods p
        WHERE p.tenant_id = NEW.tenant_id AND p.id = NEW.period_id
          AND p.deleted_at IS NULL AND p.status = 'active'
    ) THEN
        RAISE EXCEPTION 'period attendance requires an active period'
            USING ERRCODE = '55000';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM enrollments e
        WHERE e.tenant_id = NEW.tenant_id
          AND e.student_id = NEW.student_id
          AND e.section_id = NEW.section_id
          AND e.status = 'active'
          AND e.deleted_at IS NULL
    ) THEN
        RAISE EXCEPTION 'student is not enrolled in this section'
            USING ERRCODE = '55000';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM memberships m
        WHERE m.tenant_id = NEW.tenant_id AND m.user_id = NEW.marked_by AND m.status = 'active'
    ) THEN
        RAISE EXCEPTION 'attendance must be marked by an active staff membership in this tenant'
            USING ERRCODE = '55000';
    END IF;

    RETURN NEW;
END
$$ LANGUAGE plpgsql SECURITY INVOKER;

DROP TRIGGER IF EXISTS attendance_periods_validate_trg ON attendance_periods;
CREATE TRIGGER attendance_periods_validate_trg
    BEFORE INSERT OR UPDATE ON attendance_periods
    FOR EACH ROW EXECUTE FUNCTION trg_attendance_periods_validate();

-- Staff-attendance integrity + same-day guard.
CREATE OR REPLACE FUNCTION trg_staff_attendance_validate()
RETURNS trigger AS $$
DECLARE
    v_today date := current_date;
BEGIN
    IF NEW.attendance_date > v_today THEN
        RAISE EXCEPTION 'attendance cannot be marked for a future date'
            USING ERRCODE = '55000';
    END IF;

    IF TG_OP = 'UPDATE' THEN
        IF NEW.attendance_date IS DISTINCT FROM OLD.attendance_date THEN
            RAISE EXCEPTION 'attendance date is immutable'
                USING ERRCODE = '55000';
        END IF;
        IF NEW.user_id IS DISTINCT FROM OLD.user_id THEN
            RAISE EXCEPTION 'staff attendance is bound to its staff member'
                USING ERRCODE = '55000';
        END IF;
        IF OLD.attendance_date <> v_today THEN
            RAISE EXCEPTION 'attendance can only be corrected on the same day as the attendance date'
                USING ERRCODE = '55000';
        END IF;
    END IF;

    IF NEW.clock_in IS NOT NULL AND NEW.clock_out IS NOT NULL AND NEW.clock_out < NEW.clock_in THEN
        RAISE EXCEPTION 'clock out must not precede clock in'
            USING ERRCODE = '55000';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM memberships m
        WHERE m.tenant_id = NEW.tenant_id AND m.user_id = NEW.user_id AND m.status = 'active'
    ) THEN
        RAISE EXCEPTION 'staff attendance requires an active membership in this tenant'
            USING ERRCODE = '55000';
    END IF;

    RETURN NEW;
END
$$ LANGUAGE plpgsql SECURITY INVOKER;

DROP TRIGGER IF EXISTS staff_attendance_validate_trg ON staff_attendance;
CREATE TRIGGER staff_attendance_validate_trg
    BEFORE INSERT OR UPDATE ON staff_attendance
    FOR EACH ROW EXECUTE FUNCTION trg_staff_attendance_validate();

-- Leave-request integrity + the pending -> approved|rejected state machine.
-- A decided request is FROZEN: only a re-decision to the same terminal status is
-- tolerated, so an approved leave can never be silently flipped to rejected.
CREATE OR REPLACE FUNCTION trg_leave_requests_validate()
RETURNS trigger AS $$
DECLARE
    v_type record;
BEGIN
    IF NEW.end_date < NEW.start_date THEN
        RAISE EXCEPTION 'leave end date must not precede the start date'
            USING ERRCODE = '55000';
    END IF;

    IF TG_OP = 'UPDATE' AND OLD.status <> 'pending' THEN
        -- Terminal state: the request may not change its status, its dates, its
        -- student or its type. Only the free-text decision note stays open.
        IF NEW.status IS DISTINCT FROM OLD.status
           OR NEW.start_date IS DISTINCT FROM OLD.start_date
           OR NEW.end_date IS DISTINCT FROM OLD.end_date
           OR NEW.student_id IS DISTINCT FROM OLD.student_id
           OR NEW.leave_type_id IS DISTINCT FROM OLD.leave_type_id
           OR NEW.requested_by IS DISTINCT FROM OLD.requested_by
           OR NEW.approver_user_id IS DISTINCT FROM OLD.approver_user_id
           OR NEW.decision_at IS DISTINCT FROM OLD.decision_at THEN
            RAISE EXCEPTION 'a decided leave request cannot be modified'
                USING ERRCODE = '55000';
        END IF;
        RETURN NEW;
    END IF;

    IF NEW.status NOT IN ('pending','approved','rejected') THEN
        RAISE EXCEPTION 'invalid leave request status'
            USING ERRCODE = '55000';
    END IF;

    -- SECURITY INVOKER: the lookups below run under the caller's RLS, so another
    -- tenant's rows are invisible and the domain conflict fires instead.
    IF NOT EXISTS (
        SELECT 1 FROM students s
        WHERE s.tenant_id = NEW.tenant_id AND s.id = NEW.student_id
          AND s.deleted_at IS NULL AND s.status = 'active'
    ) THEN
        RAISE EXCEPTION 'leave requires an active student in this school'
            USING ERRCODE = '55000';
    END IF;

    SELECT lt.status, lt.deleted_at INTO v_type
    FROM leave_types lt
    WHERE lt.tenant_id = NEW.tenant_id AND lt.id = NEW.leave_type_id;
    IF v_type IS NULL OR v_type.deleted_at IS NOT NULL THEN
        RAISE EXCEPTION 'leave type not found'
            USING ERRCODE = '55000';
    END IF;
    IF v_type.status <> 'active' THEN
        RAISE EXCEPTION 'leave type is not active'
            USING ERRCODE = '55000';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM memberships m
        WHERE m.tenant_id = NEW.tenant_id AND m.user_id = NEW.requested_by AND m.status = 'active'
    ) THEN
        RAISE EXCEPTION 'leave must be requested by an active membership in this tenant'
            USING ERRCODE = '55000';
    END IF;

    IF NEW.status <> 'pending' THEN
        IF NOT EXISTS (
            SELECT 1 FROM memberships m
            WHERE m.tenant_id = NEW.tenant_id AND m.user_id = NEW.approver_user_id
              AND m.status = 'active'
        ) THEN
            RAISE EXCEPTION 'leave must be decided by an active membership in this tenant'
                USING ERRCODE = '55000';
        END IF;
    END IF;

    RETURN NEW;
END
$$ LANGUAGE plpgsql SECURITY INVOKER;

DROP TRIGGER IF EXISTS leave_requests_validate_trg ON leave_requests;
CREATE TRIGGER leave_requests_validate_trg
    BEFORE INSERT OR UPDATE ON leave_requests
    FOR EACH ROW EXECUTE FUNCTION trg_leave_requests_validate();

-- ------------------------------------------------------------------ delete guards
-- A leave type that is still referenced by a live request is a live configuration
-- value; refuse the soft-delete rather than orphan history.
CREATE OR REPLACE FUNCTION trg_leave_types_delete_guard()
RETURNS trigger AS $$
BEGIN
    IF NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL THEN
        IF EXISTS (
            SELECT 1 FROM leave_requests lr
            WHERE lr.tenant_id = NEW.tenant_id
              AND lr.leave_type_id = NEW.id
              AND lr.deleted_at IS NULL
        ) THEN
            RAISE EXCEPTION 'cannot delete leave type with live leave requests'
                USING ERRCODE = '55000';
        END IF;
    END IF;
    RETURN NEW;
END
$$ LANGUAGE plpgsql SECURITY INVOKER;

DROP TRIGGER IF EXISTS leave_types_delete_guard_trg ON leave_types;
CREATE TRIGGER leave_types_delete_guard_trg
    BEFORE UPDATE ON leave_types
    FOR EACH ROW EXECUTE FUNCTION trg_leave_types_delete_guard();

-- The leave code is a configuration key that historical requests were filed
-- against, so it stays stable for the life of the row. The catalog is school
-- configuration, not an attendance fact, so the same-day freeze deliberately
-- does NOT apply here (it constrains attendance rows, per DATABASE_DESIGN §6).
CREATE OR REPLACE FUNCTION trg_leave_types_lifecycle_validate()
RETURNS trigger AS $$
BEGIN
    IF NEW.code IS DISTINCT FROM OLD.code THEN
        RAISE EXCEPTION 'leave type code is immutable'
            USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
END
$$ LANGUAGE plpgsql SECURITY INVOKER;

DROP TRIGGER IF EXISTS leave_types_lifecycle_trg ON leave_types;
CREATE TRIGGER leave_types_lifecycle_trg
    BEFORE UPDATE ON leave_types
    FOR EACH ROW EXECUTE FUNCTION trg_leave_types_lifecycle_validate();

-- ================================================================== RLS
-- Same shape as 0011: FORCE row level security, tenant-branch SELECT/INSERT/
-- UPDATE keyed on the signed tenant claim, privileged executor escape, and a
-- privileged-only DELETE so the runtime role can only soft-delete.
DO $$
DECLARE
    t text;
BEGIN
    FOREACH t IN ARRAY ARRAY['leave_types','attendance_days','attendance_periods','staff_attendance','leave_requests'] LOOP
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

-- Explicit runtime grants (idempotent with the 0001 default privileges).
GRANT SELECT, INSERT, UPDATE, DELETE
    ON leave_types, attendance_days, attendance_periods, staff_attendance, leave_requests
    TO school_app_rw;

-- ================================================================== permission backfill
-- ==== PHASE 5 PERMISSION BACKFILL ====
-- Applies the Phase 5 attendance/leave permission set to system roles that
-- existed before this migration. Idempotent (ON CONFLICT DO NOTHING); scoped to
-- exact template codes with r.is_system = true, so custom tenant roles are never
-- touched. Mirrors the 0011/0009 backfill shape.
--
-- * school_owner: full tenure of the attendance domain (read + mark + leave).
-- * principal:    read-only, matching the principal template's Phase 4 pattern.
-- * teacher:      read + mark (a teacher registers their own classes). NOT
--                 approve_leave — leave decisions stay an admin act.
-- * parent/student: read their own records and file a request; never mark.
INSERT INTO role_permissions (role_id, permission)
SELECT r.id, p.permission
FROM roles r
JOIN (VALUES
    ('school_owner', 'attendance.read'),
    ('school_owner', 'attendance.mark'),
    ('school_owner', 'attendance.approve_leave'),
    ('school_owner', 'attendance.request_leave'),
    ('principal', 'attendance.read'),
    ('teacher', 'attendance.read'),
    ('teacher', 'attendance.mark'),
    ('parent', 'attendance.read'),
    ('parent', 'attendance.request_leave'),
    ('student', 'attendance.read'),
    ('student', 'attendance.request_leave')
) AS p(code, permission) ON p.code = r.code
WHERE r.scope = 'tenant' AND r.is_system = true
ON CONFLICT (role_id, permission) DO NOTHING;
-- ==== END PHASE 5 PERMISSION BACKFILL ====
