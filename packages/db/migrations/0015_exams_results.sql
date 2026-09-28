-- 0015: Phase 6 — exams, marks, grading scales, report cards, publishing +
-- corrections (forward-only).
--
-- Implements the roadmap Phase 6 DB scope verbatim: `exam_types`, `exams`,
-- `exam_subjects`, `exam_schedules`, `marks`, `grading_scales` (versioned),
-- `report_cards` (versioned), `mark_corrections`. Same § conventions as Phase 4
-- / Phase 5 (migration 0011 / 0014): RLS ENABLE + FORCE, tenant-branch
-- SELECT/INSERT/UPDATE keyed on the signed tenant claim, privileged-only hard
-- DELETE, school_app_rw grants, SECURITY INVOKER triggers, composite tenant-aware
-- foreign keys, live partial unique indexes.
--
-- CORE DOMAIN RULES (DATABASE_DESIGN §8):
--   * The lifecycle is a ONE-WAY state machine: draft -> scheduled -> grading ->
--     published, with `cancelled` reachable from every pre-publication state.
--     `published` is terminal; corrections never reopen the exam, they supersede a
--     single mark (and bump the report card to a new version).
--   * A published mark is IMMUTABLE. An UPDATE of `marks_obtained` on a mark of a
--     published exam is refused UNLESS a matching `mark_corrections` row already
--     exists in the SAME transaction (the correction workflow), which forces the
--     reason, the actor and the audit trail to exist before the value can move.
--   * `percentage`, `grade_label` and `grade_point` are DERIVED, never posted. The
--     trigger recomputes them from `exam_subjects.max_marks` and the exam's active
--     grading scale, so a client can never forge a grade.
--   * `report_cards` is a SNAPSHOT: once published it is frozen. A corrected
--     result produces a NEW VERSION row, so the historical artifact stays
--     auditable (partial unique index on the live draft).
--
-- IDEMPOTENCY is a database property, not an application convention: entering
-- marks for the same (exam_subject, enrollment) twice collides with a live partial
-- unique index (23505), which the API resolves with an upsert, and the tenant
-- cannot have two live exams of the same name in the same term.
--
-- DESIGN NOTES / SCOPE BOUNDARIES:
--   * Marks are anchored on the ENROLLMENT (DATABASE_DESIGN §8: unique
--     (exam_subject, enrollment_id)), not on the student, because the exam subject
--     is a class subject and the enrollment is what proves the student sat it.
--     `student_id` / `section_id` are denormalized copies pinned by trigger, so a
--     grade can never be attached to the wrong person or section.
--   * `exams.grading_scale_id` is nullable: NULL means "use the tenant's active
--     scale". It is snapshotted onto the exam rather than looked up per mark so a
--     published result always states which scale produced it — a versioned scale
--     (DATABASE_DESIGN §8) would otherwise make old results unreproducible.
--   * `exam_subjects` pins class_id / subject_id / academic_year_id through
--     composite FKs to `class_subjects` AND to `exams(tenant_id,
--     academic_year_id, id)`, so a subject session can never be mixed across
--     academic years — the year is structural, not a trigger convention.
--   * The teacher identity is the MEMBERSHIP user id (AUTHORIZATION.md: "teacher
--     identity = membership + role, not a table"), composite-FK-pinned to
--     memberships(tenant_id, user_id) and trigger-verified ACTIVE. The API
--     additionally checks the `teacher_assignments` row for the class subject;
--     the DB supplies the invariant, the API supplies the assignment scope.
--   * The composite FK anchors this migration adds to EARLIER tables
--     (academic_terms, class_subjects, enrollments) are additive unique indexes,
--     exactly as 0009/0011/0014 did for their parents. No earlier file is edited.
--
-- DELIBERATELY OUT OF SCOPE: no finance/HR/transport tables, no communication or
-- notification tables (publish notifications are outbox EVENTS consumed by a stub
-- channel in the worker; real delivery is Phase 8), no exam question bank, no
-- student/parent result UI beyond the API.

-- ------------------------------------------------------------------ anchors
-- Composite tenant-aware FK targets for the Phase 6 tables. Additive only.
CREATE UNIQUE INDEX IF NOT EXISTS academic_terms_tenant_id_uq
    ON academic_terms (tenant_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS academic_terms_tenant_year_id_uq
    ON academic_terms (tenant_id, academic_year_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS class_subjects_tenant_class_id_uq
    ON class_subjects (tenant_id, class_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS class_subjects_tenant_year_id_uq
    ON class_subjects (tenant_id, academic_year_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS enrollments_tenant_id_uq
    ON enrollments (tenant_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS enrollments_tenant_year_id_uq
    ON enrollments (tenant_id, academic_year_id, id);

-- ================================================================== exam_types
-- Tenant catalog of exam kinds (Unit test, Midterm, Final, ...).
CREATE TABLE exam_types (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL,
    code text NOT NULL,
    name text NOT NULL,
    is_active boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz,
    CONSTRAINT exam_types_code_ck CHECK (code ~ '^[a-z0-9_]{1,32}$'),
    CONSTRAINT exam_types_code_len_ck CHECK (length(name) BETWEEN 1 AND 120)
);

CREATE UNIQUE INDEX exam_types_tenant_id_uq ON exam_types (tenant_id, id);
CREATE UNIQUE INDEX exam_types_tenant_code_uq ON exam_types (tenant_id, code)
    WHERE deleted_at IS NULL;
CREATE INDEX exam_types_tenant_active_idx ON exam_types (tenant_id, is_active)
    WHERE deleted_at IS NULL;

-- ================================================================== grading_scales
-- Versioned grade bands. `bands` is a JSONB array of
-- { label, minPercent, maxPercent, gradePoint } half-open ranges; the trigger
-- proves the bands tile 0..100 without gaps or overlap (DATABASE_DESIGN §8:
-- "app validation + trigger"), so a malformed scale can never be created by any
-- writer, privileged included.
CREATE TABLE grading_scales (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL,
    code text NOT NULL,
    name text NOT NULL,
    version integer NOT NULL,
    is_active boolean NOT NULL DEFAULT false,
    bands jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz,
    CONSTRAINT grading_scales_code_ck CHECK (code ~ '^[a-z0-9_]{1,32}$'),
    CONSTRAINT grading_scales_version_ck CHECK (version >= 1),
    CONSTRAINT grading_scales_bands_array_ck CHECK (jsonb_typeof(bands) = 'array'),
    CONSTRAINT grading_scales_bands_len_ck CHECK (jsonb_array_length(bands) BETWEEN 1 AND 12)
);

CREATE UNIQUE INDEX grading_scales_tenant_id_uq ON grading_scales (tenant_id, id);
-- One row per (code, version): the version is the history axis.
CREATE UNIQUE INDEX grading_scales_code_version_uq ON grading_scales (tenant_id, code, version)
    WHERE deleted_at IS NULL;
-- At most ONE active version per scale code.
CREATE UNIQUE INDEX grading_scales_active_uq ON grading_scales (tenant_id, code)
    WHERE deleted_at IS NULL AND is_active;
CREATE INDEX grading_scales_tenant_idx ON grading_scales (tenant_id, code)
    WHERE deleted_at IS NULL;

-- ================================================================== exams
-- Exam instance per academic term. `academic_year_id` is denormalized from the
-- term and pinned by a composite FK, so it can never disagree.
CREATE TABLE exams (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL,
    academic_term_id uuid NOT NULL,
    academic_year_id uuid NOT NULL,
    exam_type_id uuid NOT NULL,
    campus_id uuid,
    grading_scale_id uuid,
    name text NOT NULL,
    status text NOT NULL DEFAULT 'draft',
    published_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz,
    CONSTRAINT exams_name_ck CHECK (length(name) BETWEEN 1 AND 160),
    CONSTRAINT exams_status_ck
        CHECK (status IN ('draft','scheduled','grading','published','cancelled')),
    CONSTRAINT exams_term_fk
        FOREIGN KEY (tenant_id, academic_term_id) REFERENCES academic_terms (tenant_id, id),
    -- The year CARD = the term's year.
    CONSTRAINT exams_term_year_fk
        FOREIGN KEY (tenant_id, academic_year_id, academic_term_id)
        REFERENCES academic_terms (tenant_id, academic_year_id, id),
    CONSTRAINT exams_type_fk
        FOREIGN KEY (tenant_id, exam_type_id) REFERENCES exam_types (tenant_id, id),
    CONSTRAINT exams_campus_fk
        FOREIGN KEY (tenant_id, campus_id) REFERENCES campuses (tenant_id, id),
    CONSTRAINT exams_scale_fk
        FOREIGN KEY (tenant_id, grading_scale_id) REFERENCES grading_scales (tenant_id, id),
    -- published_at exists iff the exam is published.
    CONSTRAINT exams_published_at_ck CHECK (
        (status = 'published' AND published_at IS NOT NULL)
        OR (status <> 'published' AND published_at IS NULL)
    )
);

CREATE UNIQUE INDEX exams_tenant_id_uq ON exams (tenant_id, id);
CREATE UNIQUE INDEX exams_tenant_year_id_uq ON exams (tenant_id, academic_year_id, id);
-- Idempotency anchor: no two live exams may share a name inside one term.
CREATE UNIQUE INDEX exams_term_name_uq ON exams (tenant_id, academic_term_id, name)
    WHERE deleted_at IS NULL AND status <> 'cancelled';
CREATE INDEX exams_tenant_term_status_idx ON exams (tenant_id, academic_term_id, status)
    WHERE deleted_at IS NULL;
CREATE INDEX exams_tenant_year_idx ON exams (tenant_id, academic_year_id, status)
    WHERE deleted_at IS NULL;
CREATE INDEX exams_tenant_campus_idx ON exams (tenant_id, campus_id, status)
    WHERE deleted_at IS NULL AND campus_id IS NOT NULL;
CREATE INDEX exams_tenant_type_idx ON exams (tenant_id, exam_type_id)
    WHERE deleted_at IS NULL;

-- ================================================================== exam_subjects
-- Subject session of an exam: one row per (exam, class_subject). max_marks is the
-- denominator of every mark, weight is the GPA weight (both > 0).
CREATE TABLE exam_subjects (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL,
    exam_id uuid NOT NULL,
    class_subject_id uuid NOT NULL,
    academic_year_id uuid NOT NULL,
    class_id uuid NOT NULL,
    subject_id uuid NOT NULL,
    max_marks numeric(9,2) NOT NULL,
    weight numeric(6,3) NOT NULL DEFAULT 1,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz,
    CONSTRAINT exam_subjects_max_marks_ck CHECK (max_marks > 0),
    CONSTRAINT exam_subjects_weight_ck CHECK (weight > 0),
    CONSTRAINT exam_subjects_exam_fk
        FOREIGN KEY (tenant_id, exam_id) REFERENCES exams (tenant_id, id),
    -- The subject session belongs to the SAME academic year as the exam.
    CONSTRAINT exam_subjects_exam_year_fk
        FOREIGN KEY (tenant_id, academic_year_id, exam_id)
        REFERENCES exams (tenant_id, academic_year_id, id),
    -- The class subject is pinned to the exam's year, and its class / subject are
    -- CARD-copies of the class subject row itself.
    CONSTRAINT exam_subjects_class_subject_year_fk
        FOREIGN KEY (tenant_id, academic_year_id, class_subject_id)
        REFERENCES class_subjects (tenant_id, academic_year_id, id),
    CONSTRAINT exam_subjects_class_subject_class_fk
        FOREIGN KEY (tenant_id, class_id, class_subject_id)
        REFERENCES class_subjects (tenant_id, class_id, id),
    CONSTRAINT exam_subjects_subject_fk
        FOREIGN KEY (tenant_id, subject_id) REFERENCES subjects (tenant_id, id),
    -- DATABASE_DESIGN §8: unique(exam, class_subject).
    CONSTRAINT exam_subjects_exam_subject_uq UNIQUE (tenant_id, exam_id, class_subject_id)
);

CREATE UNIQUE INDEX exam_subjects_tenant_id_uq ON exam_subjects (tenant_id, id);
CREATE UNIQUE INDEX exam_subjects_tenant_year_id_uq
    ON exam_subjects (tenant_id, academic_year_id, id);
CREATE INDEX exam_subjects_tenant_exam_idx ON exam_subjects (tenant_id, exam_id)
    WHERE deleted_at IS NULL;
CREATE INDEX exam_subjects_tenant_class_subject_idx
    ON exam_subjects (tenant_id, class_subject_id) WHERE deleted_at IS NULL;
CREATE INDEX exam_subjects_tenant_class_idx ON exam_subjects (tenant_id, class_id)
    WHERE deleted_at IS NULL;

-- ================================================================== exam_schedules
-- Date/time/room of one subject session. A schedule may only exist while the
-- exam is still being organized (draft/scheduled); a published exam is a fact of
-- the past and its schedule can no longer move.
CREATE TABLE exam_schedules (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL,
    exam_subject_id uuid NOT NULL,
    starts_at timestamptz NOT NULL,
    ends_at timestamptz NOT NULL,
    room text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz,
    CONSTRAINT exam_schedules_window_ck CHECK (starts_at < ends_at),
    CONSTRAINT exam_schedules_room_ck CHECK (room IS NULL OR length(room) <= 120),
    CONSTRAINT exam_schedules_subject_fk
        FOREIGN KEY (tenant_id, exam_subject_id) REFERENCES exam_subjects (tenant_id, id)
);

CREATE UNIQUE INDEX exam_schedules_tenant_id_uq ON exam_schedules (tenant_id, id);
CREATE UNIQUE INDEX exam_schedules_subject_live_uq
    ON exam_schedules (tenant_id, exam_subject_id) WHERE deleted_at IS NULL;
CREATE INDEX exam_schedules_tenant_starts_idx ON exam_schedules (tenant_id, starts_at)
    WHERE deleted_at IS NULL;

-- ================================================================== marks
-- Grade entry. marks_obtained is entered; percentage / grade_label / grade_point
-- are recomputed by the trigger; status, entered_by and locked_at are
-- server-derived.
CREATE TABLE marks (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL,
    exam_subject_id uuid NOT NULL,
    enrollment_id uuid NOT NULL,
    student_id uuid NOT NULL,
    section_id uuid,
    academic_year_id uuid NOT NULL,
    marks_obtained numeric(9,2),
    percentage numeric(5,2),
    grade_label text,
    grade_point numeric(4,2),
    status text NOT NULL DEFAULT 'provisional',
    entered_by uuid,
    locked_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz,
    CONSTRAINT marks_status_ck CHECK (status IN ('provisional','locked','rechecked')),
    -- DATABASE_DESIGN §8: marks_obtained CHECK (>=0 <= max). The upper bound
    -- needs the exam subject, so it is enforced by the trigger; the hard floor and
    -- the derived ranges live here.
    CONSTRAINT marks_obtained_ck CHECK (marks_obtained IS NULL OR marks_obtained >= 0),
    CONSTRAINT marks_percentage_ck CHECK (percentage IS NULL OR (percentage >= 0 AND percentage <= 100)),
    CONSTRAINT marks_grade_point_ck CHECK (grade_point IS NULL OR (grade_point >= 0 AND grade_point <= 4)),
    -- Idempotency anchor: unique(exam_subject, enrollment_id).
    CONSTRAINT marks_exam_subject_enrollment_uq UNIQUE (tenant_id, exam_subject_id, enrollment_id),
    CONSTRAINT marks_subject_year_fk
        FOREIGN KEY (tenant_id, academic_year_id, exam_subject_id)
        REFERENCES exam_subjects (tenant_id, academic_year_id, id),
    CONSTRAINT marks_enrollment_fk
        FOREIGN KEY (tenant_id, enrollment_id) REFERENCES enrollments (tenant_id, id),
    -- The enrollment belongs to the same academic year as the mark.
    CONSTRAINT marks_enrollment_year_fk
        FOREIGN KEY (tenant_id, academic_year_id, enrollment_id)
        REFERENCES enrollments (tenant_id, academic_year_id, id),
    CONSTRAINT marks_student_fk
        FOREIGN KEY (tenant_id, student_id) REFERENCES students (tenant_id, id),
    CONSTRAINT marks_section_fk
        FOREIGN KEY (tenant_id, section_id) REFERENCES sections (tenant_id, id),
    -- entered_by is a MEMBERSHIP of this tenant (0009 memberships_tenant_user_uq).
    CONSTRAINT marks_entered_by_fk
        FOREIGN KEY (tenant_id, entered_by) REFERENCES memberships (tenant_id, user_id),
    -- A mark with no value is provisional until published; a locked/rechecked
    -- mark carries locked_at.
    CONSTRAINT marks_locked_ck CHECK (
        (status = 'provisional' AND locked_at IS NULL)
        OR (status IN ('locked','rechecked') AND locked_at IS NOT NULL)
    )
);

CREATE UNIQUE INDEX marks_tenant_id_uq ON marks (tenant_id, id);
CREATE INDEX marks_tenant_subject_idx ON marks (tenant_id, exam_subject_id)
    WHERE deleted_at IS NULL;
-- Result reads are per student, per exam: the report-card / transcript hot path.
CREATE INDEX marks_tenant_student_idx ON marks (tenant_id, student_id)
    WHERE deleted_at IS NULL;
CREATE INDEX marks_tenant_status_idx ON marks (tenant_id, status) WHERE deleted_at IS NULL;

-- ================================================================== report_cards
-- Generated per-student artifact. `version` is the correction axis: a corrected
-- result produces a NEW draft version; the published snapshot is immutable.
CREATE TABLE report_cards (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL,
    exam_id uuid NOT NULL,
    student_id uuid NOT NULL,
    enrollment_id uuid NOT NULL,
    academic_year_id uuid NOT NULL,
    version integer NOT NULL DEFAULT 1,
    status text NOT NULL DEFAULT 'draft',
    gpa numeric(4,2),
    total_obtained numeric(10,2),
    total_possible numeric(10,2) NOT NULL DEFAULT 0,
    subject_count integer NOT NULL DEFAULT 0,
    file_id uuid,
    published_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz,
    CONSTRAINT report_cards_status_ck CHECK (status IN ('draft','published')),
    CONSTRAINT report_cards_version_ck CHECK (version >= 1),
    CONSTRAINT report_cards_gpa_ck CHECK (gpa IS NULL OR (gpa >= 0 AND gpa <= 4)),
    CONSTRAINT report_cards_totals_ck CHECK (total_obtained IS NULL OR total_obtained >= 0),
    CONSTRAINT report_cards_total_possible_ck CHECK (total_possible >= 0),
    CONSTRAINT report_cards_subject_count_ck CHECK (subject_count >= 0),
    CONSTRAINT report_cards_exam_fk
        FOREIGN KEY (tenant_id, exam_id) REFERENCES exams (tenant_id, id),
    CONSTRAINT report_cards_exam_year_fk
        FOREIGN KEY (tenant_id, academic_year_id, exam_id)
        REFERENCES exams (tenant_id, academic_year_id, id),
    CONSTRAINT report_cards_student_fk
        FOREIGN KEY (tenant_id, student_id) REFERENCES students (tenant_id, id),
    CONSTRAINT report_cards_enrollment_fk
        FOREIGN KEY (tenant_id, enrollment_id) REFERENCES enrollments (tenant_id, id),
    -- The artifact itself lives in the platform file store; report_cards only
    -- pins the reference so a rendered PDF can never be orphaned silently.
    CONSTRAINT report_cards_file_fk
        FOREIGN KEY (tenant_id, file_id) REFERENCES files (tenant_id, id),
    -- A published card carries its publication stamp; a draft does not.
    CONSTRAINT report_cards_published_at_ck CHECK (
        (status = 'published' AND published_at IS NOT NULL)
        OR (status = 'draft' AND published_at IS NULL)
    )
);

CREATE UNIQUE INDEX report_cards_tenant_id_uq ON report_cards (tenant_id, id);
-- DATABASE_DESIGN §8: unique(student, exam) per version.
CREATE UNIQUE INDEX report_cards_student_exam_version_uq
    ON report_cards (tenant_id, exam_id, student_id, version) WHERE deleted_at IS NULL;
-- At most one LIVE DRAFT per (exam, student): the correction workflow supersedes
-- the working copy instead of forking a second one.
CREATE UNIQUE INDEX report_cards_live_draft_uq
    ON report_cards (tenant_id, exam_id, student_id)
    WHERE deleted_at IS NULL AND status = 'draft';
CREATE INDEX report_cards_tenant_exam_idx ON report_cards (tenant_id, exam_id, status)
    WHERE deleted_at IS NULL;
-- Parent/student portal + transcript hot path.
CREATE INDEX report_cards_tenant_student_idx ON report_cards (tenant_id, student_id, status)
    WHERE deleted_at IS NULL;
CREATE INDEX report_cards_tenant_year_idx ON report_cards (tenant_id, academic_year_id)
    WHERE deleted_at IS NULL;

-- ================================================================== mark_corrections
-- Append-only audit trail of every published-mark change (old, new, reason,
-- actor). The trigger on `marks` REQUIRES a row here before a published value can
-- move, so the correction workflow is the only path and it cannot be silent.
CREATE TABLE mark_corrections (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL,
    mark_id uuid NOT NULL,
    exam_id uuid NOT NULL,
    exam_subject_id uuid NOT NULL,
    student_id uuid NOT NULL,
    old_marks_obtained numeric(9,2),
    new_marks_obtained numeric(9,2) NOT NULL,
    reason text NOT NULL,
    corrected_by uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT mark_corrections_reason_ck CHECK (length(reason) BETWEEN 3 AND 500),
    CONSTRAINT mark_corrections_new_ck CHECK (new_marks_obtained >= 0),
    -- A correction that does not actually change the value is a bug, not a
    -- correction: refuse it at the database level.
    CONSTRAINT mark_corrections_changed_ck
        CHECK (old_marks_obtained IS DISTINCT FROM new_marks_obtained),
    CONSTRAINT mark_corrections_mark_fk
        FOREIGN KEY (tenant_id, mark_id) REFERENCES marks (tenant_id, id),
    CONSTRAINT mark_corrections_exam_fk
        FOREIGN KEY (tenant_id, exam_id) REFERENCES exams (tenant_id, id),
    CONSTRAINT mark_corrections_subject_fk
        FOREIGN KEY (tenant_id, exam_subject_id) REFERENCES exam_subjects (tenant_id, id),
    CONSTRAINT mark_corrections_student_fk
        FOREIGN KEY (tenant_id, student_id) REFERENCES students (tenant_id, id),
    CONSTRAINT mark_corrections_actor_fk
        FOREIGN KEY (tenant_id, corrected_by) REFERENCES memberships (tenant_id, user_id)
);

CREATE UNIQUE INDEX mark_corrections_tenant_id_uq ON mark_corrections (tenant_id, id);
CREATE INDEX mark_corrections_tenant_mark_idx ON mark_corrections (tenant_id, mark_id);
-- The trigger's "is there a pending correction for this value?" lookup.
CREATE INDEX mark_corrections_lookup_idx
    ON mark_corrections (tenant_id, mark_id, new_marks_obtained);
CREATE INDEX mark_corrections_tenant_student_idx ON mark_corrections (tenant_id, student_id);

-- ================================================================== helpers
-- Grade lookup for a percentage against the exam's scale (or the tenant's active
-- scale when the exam pins none). Returns the band whose half-open range
-- [min_percent, max_percent) contains the percentage, the top band being
-- inclusive of 100. SECURITY INVOKER: another tenant's scale is invisible, so the
-- "no scale" path is the only reachable failure.
CREATE OR REPLACE FUNCTION fn_exam_grade_for(
    p_tenant_id uuid,
    p_exam_id uuid,
    p_percentage numeric
)
RETURNS TABLE (label text, point numeric)
LANGUAGE plpgsql SECURITY INVOKER AS $$
DECLARE
    v_scale_id uuid;
    v_bands jsonb;
    v_band jsonb;
BEGIN
    IF p_percentage IS NULL THEN
        RETURN QUERY SELECT NULL::text, NULL::numeric;
        RETURN;
    END IF;

    SELECT e.grading_scale_id INTO v_scale_id
    FROM exams e
    WHERE e.tenant_id = p_tenant_id AND e.id = p_exam_id;

    SELECT gs.id, gs.bands INTO v_scale_id, v_bands
    FROM grading_scales gs
    WHERE gs.tenant_id = p_tenant_id
      AND gs.deleted_at IS NULL
      AND gs.is_active
      AND (v_scale_id IS NULL OR gs.id = v_scale_id)
    ORDER BY gs.version DESC
    LIMIT 1;

    IF v_bands IS NULL THEN
        RETURN QUERY SELECT NULL::text, NULL::numeric;
        RETURN;
    END IF;

    FOR v_band IN
        SELECT band.value
        FROM jsonb_array_elements(v_bands) AS band(value)
        ORDER BY (band.value ->> 'minPercent')::numeric
    LOOP
        IF p_percentage >= (v_band ->> 'minPercent')::numeric
           AND (p_percentage < (v_band ->> 'maxPercent')::numeric
                OR (v_band ->> 'maxPercent')::numeric = 100
                    AND p_percentage = 100) THEN
            RETURN QUERY SELECT v_band ->> 'label', (v_band ->> 'gradePoint')::numeric;
            RETURN;
        END IF;
    END LOOP;

    RETURN QUERY SELECT NULL::text, NULL::numeric;
END
$$;

-- ================================================================== triggers
-- ------------------------------------------------------------------ exam lifecycle
-- draft -> scheduled -> grading -> published (one way, no skipping ahead except
-- via cancellation), cancelled from any pre-publication state, and `published`
-- is terminal apart from its own stamp. A published exam's configuration is
-- frozen: a correction workflow never reopens it.
CREATE OR REPLACE FUNCTION trg_exams_lifecycle_validate()
RETURNS trigger AS $$
DECLARE
    v_from text;
    v_to text;
    v_scale_key uuid;
BEGIN
    IF TG_OP = 'UPDATE' THEN
        v_from := OLD.status;
        v_to := NEW.status;
        -- only a CHANGE of scale needs re-validating (see the check below)
        v_scale_key := CASE
            WHEN NEW.grading_scale_id IS DISTINCT FROM OLD.grading_scale_id
                THEN NEW.grading_scale_id
            ELSE NULL
        END;
    ELSE
        v_from := NULL;
        v_to := NEW.status;
        v_scale_key := NEW.grading_scale_id;
    END IF;

    IF v_to NOT IN ('draft','scheduled','grading','published','cancelled') THEN
        RAISE EXCEPTION 'invalid exam status'
            USING ERRCODE = '55000';
    END IF;

    -- An explicitly NAMED scale must be active and undeleted. Otherwise
    -- fn_exam_grade_for finds no bands and every mark of this exam silently
    -- derives a NULL grade — a data-quality hole that is invisible until a
    -- report card is printed. (A NULL scale keeps its documented meaning:
    -- "fall back to the tenant's newest active scale".)
    IF v_scale_key IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM grading_scales gs
        WHERE gs.tenant_id = NEW.tenant_id AND gs.id = v_scale_key
          AND gs.deleted_at IS NULL AND gs.is_active
    ) THEN
        RAISE EXCEPTION 'exam grading scale must be an active grading scale'
            USING ERRCODE = '55000';
    END IF;

    IF TG_OP = 'UPDATE' AND v_from = v_to THEN
        -- Same status: configuration may still move, but not after publication.
        IF v_from = 'published' THEN
            IF NEW.name IS DISTINCT FROM OLD.name
               OR NEW.academic_term_id IS DISTINCT FROM OLD.academic_term_id
               OR NEW.exam_type_id IS DISTINCT FROM OLD.exam_type_id
               OR NEW.campus_id IS DISTINCT FROM OLD.campus_id
               OR NEW.grading_scale_id IS DISTINCT FROM OLD.grading_scale_id
               OR NEW.academic_year_id IS DISTINCT FROM OLD.academic_year_id THEN
                RAISE EXCEPTION 'a published exam cannot be reconfigured'
                    USING ERRCODE = '55000';
            END IF;
        END IF;
        RETURN NEW;
    END IF;

    IF v_to = 'published' THEN
        IF v_from NOT IN ('draft','scheduled','grading') THEN
            RAISE EXCEPTION 'exam cannot be published from status %', v_from
                USING ERRCODE = '55000';
        END IF;
        -- Publication requires a real result set: at least one mark must exist.
        IF NOT EXISTS (
            SELECT 1 FROM exam_subjects es
            WHERE es.tenant_id = NEW.tenant_id AND es.exam_id = NEW.id
              AND es.deleted_at IS NULL
        ) THEN
            RAISE EXCEPTION 'an exam needs at least one subject before publication'
                USING ERRCODE = '55000';
        END IF;
        IF NEW.published_at IS NULL THEN
            RAISE EXCEPTION 'publication requires published_at'
                USING ERRCODE = '55000';
        END IF;
        RETURN NEW;
    END IF;

    IF v_to = 'cancelled' THEN
        IF v_from IN ('published','cancelled') THEN
            RAISE EXCEPTION 'a published exam cannot be cancelled'
                USING ERRCODE = '55000';
        END IF;
        RETURN NEW;
    END IF;

    IF v_to = 'grading' THEN
        IF v_from NOT IN ('scheduled','draft') THEN
            RAISE EXCEPTION 'exam cannot enter grading from status %', v_from
                USING ERRCODE = '55000';
        END IF;
        RETURN NEW;
    END IF;

    IF v_to = 'scheduled' THEN
        IF v_from NOT IN ('draft','grading') THEN
            RAISE EXCEPTION 'exam cannot be scheduled from status %', v_from
                USING ERRCODE = '55000';
        END IF;
        RETURN NEW;
    END IF;

    -- draft
    IF v_from IS NOT NULL THEN
        RAISE EXCEPTION 'exam cannot return to draft from status %', v_from
            USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
END
$$ LANGUAGE plpgsql SECURITY INVOKER;

DROP TRIGGER IF EXISTS exams_lifecycle_trg ON exams;
CREATE TRIGGER exams_lifecycle_trg
    BEFORE INSERT OR UPDATE ON exams
    FOR EACH ROW EXECUTE FUNCTION trg_exams_lifecycle_validate();

-- A cancelled or published exam keeps its rows (history), so the soft-delete is
-- refused while marks or report cards still reference it.
CREATE OR REPLACE FUNCTION trg_exams_delete_guard()
RETURNS trigger AS $$
BEGIN
    IF NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL THEN
        -- `marks` reaches the exam through exam_subjects, so the guard joins
        -- rather than reading a denormalized exam_id.
        IF EXISTS (
            SELECT 1 FROM marks m
            JOIN exam_subjects es ON es.tenant_id = m.tenant_id AND es.id = m.exam_subject_id
            WHERE m.tenant_id = NEW.tenant_id AND es.exam_id = NEW.id
              AND m.deleted_at IS NULL
        ) OR EXISTS (
            SELECT 1 FROM report_cards rc
            WHERE rc.tenant_id = NEW.tenant_id AND rc.exam_id = NEW.id
              AND rc.deleted_at IS NULL
        ) THEN
            RAISE EXCEPTION 'cannot delete an exam with results'
                USING ERRCODE = '55000';
        END IF;
    END IF;
    RETURN NEW;
END
$$ LANGUAGE plpgsql SECURITY INVOKER;

DROP TRIGGER IF EXISTS exams_delete_guard_trg ON exams;
CREATE TRIGGER exams_delete_guard_trg
    BEFORE UPDATE ON exams
    FOR EACH ROW EXECUTE FUNCTION trg_exams_delete_guard();

-- Publication is a state change on the exam but a state change on every mark as
-- well: this sweep turns the exam's provisional marks into locked ones in the SAME
-- transaction. Without it a published exam would keep provisional, unlocked marks
-- and the gradebook would disagree with the published snapshot.
CREATE OR REPLACE FUNCTION trg_exams_publish_lock_marks()
RETURNS trigger AS $$
BEGIN
    IF NEW.status = 'published' AND OLD.status IS DISTINCT FROM 'published' THEN
        UPDATE marks m
        SET status = CASE WHEN m.status = 'rechecked' THEN 'rechecked' ELSE 'locked' END,
            locked_at = COALESCE(m.locked_at, now())
        WHERE m.tenant_id = NEW.tenant_id
          AND m.deleted_at IS NULL
          AND m.exam_subject_id IN (
              SELECT es.id FROM exam_subjects es
              WHERE es.tenant_id = NEW.tenant_id AND es.exam_id = NEW.id
          );
    END IF;
    RETURN NULL;
END
$$ LANGUAGE plpgsql SECURITY INVOKER;

DROP TRIGGER IF EXISTS exams_publish_lock_marks_trg ON exams;
CREATE TRIGGER exams_publish_lock_marks_trg
    AFTER UPDATE ON exams
    FOR EACH ROW EXECUTE FUNCTION trg_exams_publish_lock_marks();

-- ------------------------------------------------------------------ exam subjects
-- Subjects may only be attached while the exam is being organized, and a live
-- exam subject that carries marks is a grading fact: it may not be detached.
CREATE OR REPLACE FUNCTION trg_exam_subjects_validate()
RETURNS trigger AS $$
DECLARE
    v_status text;
BEGIN
    SELECT e.status INTO v_status
    FROM exams e
    WHERE e.tenant_id = NEW.tenant_id AND e.id = NEW.exam_id;

    IF v_status IS NULL THEN
        RAISE EXCEPTION 'exam not found'
            USING ERRCODE = '55000';
    END IF;

    IF TG_OP = 'UPDATE' AND NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL THEN
        IF v_status IN ('grading','published') THEN
            RAISE EXCEPTION 'exam subjects cannot be removed once grading has started'
                USING ERRCODE = '55000';
        END IF;
        IF EXISTS (
            SELECT 1 FROM marks m
            WHERE m.tenant_id = NEW.tenant_id AND m.exam_subject_id = NEW.id
              AND m.deleted_at IS NULL
        ) THEN
            RAISE EXCEPTION 'cannot remove an exam subject with marks'
                USING ERRCODE = '55000';
        END IF;
        RETURN NEW;
    END IF;

    -- A published freeze also covers the marks ceiling: once marks exist, changing
    -- max_marks would silently rescale every stored percentage. This is checked
    -- BEFORE the status gate so the caller gets the specific reason.
    IF TG_OP = 'UPDATE' AND NEW.max_marks IS DISTINCT FROM OLD.max_marks
       AND EXISTS (
           SELECT 1 FROM marks m
           WHERE m.tenant_id = NEW.tenant_id AND m.exam_subject_id = NEW.id
             AND m.deleted_at IS NULL
       ) THEN
        RAISE EXCEPTION 'max_marks cannot change once marks exist'
            USING ERRCODE = '55000';
    END IF;

    IF v_status NOT IN ('draft','scheduled') THEN
        RAISE EXCEPTION 'exam subjects cannot be changed in status %', v_status
            USING ERRCODE = '55000';
    END IF;

    RETURN NEW;
END
$$ LANGUAGE plpgsql SECURITY INVOKER;

DROP TRIGGER IF EXISTS exam_subjects_validate_trg ON exam_subjects;
CREATE TRIGGER exam_subjects_validate_trg
    BEFORE INSERT OR UPDATE ON exam_subjects
    FOR EACH ROW EXECUTE FUNCTION trg_exam_subjects_validate();

-- ------------------------------------------------------------------ exam schedules
-- The window must sit inside the exam's academic term and the exam must still be
-- schedulable. A published exam is a historical fact.
CREATE OR REPLACE FUNCTION trg_exam_schedules_validate()
RETURNS trigger AS $$
DECLARE
    v_status text;
    v_starts date;
    v_ends date;
BEGIN
    SELECT e.status, t.starts_on, t.ends_on INTO v_status, v_starts, v_ends
    FROM exam_subjects es
    JOIN exams e ON e.tenant_id = es.tenant_id AND e.id = es.exam_id
    JOIN academic_terms t ON t.tenant_id = e.tenant_id AND t.id = e.academic_term_id
    WHERE es.tenant_id = NEW.tenant_id AND es.id = NEW.exam_subject_id
      AND es.deleted_at IS NULL;

    IF v_status IS NULL THEN
        RAISE EXCEPTION 'exam subject not found'
            USING ERRCODE = '55000';
    END IF;

    IF v_status NOT IN ('draft','scheduled') THEN
        RAISE EXCEPTION 'exam schedule cannot be changed in status %', v_status
            USING ERRCODE = '55000';
    END IF;

    IF (NEW.starts_at AT TIME ZONE 'UTC')::date < v_starts
       OR (NEW.ends_at AT TIME ZONE 'UTC')::date > v_ends THEN
        RAISE EXCEPTION 'exam schedule must fall inside the exam term'
            USING ERRCODE = '55000';
    END IF;

    RETURN NEW;
END
$$ LANGUAGE plpgsql SECURITY INVOKER;

DROP TRIGGER IF EXISTS exam_schedules_validate_trg ON exam_schedules;
CREATE TRIGGER exam_schedules_validate_trg
    BEFORE INSERT OR UPDATE ON exam_schedules
    FOR EACH ROW EXECUTE FUNCTION trg_exam_schedules_validate();

-- ------------------------------------------------------------------ marks
-- The heart of Phase 6. Enforces, in one place:
--   1. the exam must be in a state that accepts marks (scheduled / grading);
--   2. the enrollment must belong to the mark's student, year and section;
--   3. marks_obtained <= exam_subjects.max_marks (DATABASE_DESIGN §8);
--   4. percentage / grade_label / grade_point are DERIVED here, never posted;
--   5. a published exam's marks are locked, and a locked mark's value can only
--      move when a matching `mark_corrections` row already exists in this
--      transaction (the correction workflow), which flips the status to
--      'rechecked'.
CREATE OR REPLACE FUNCTION trg_marks_validate()
RETURNS trigger AS $$
DECLARE
    v_exam_id uuid;
    v_exam_status text;
    v_max numeric;
    v_section uuid;
    v_student uuid;
    v_year uuid;
    v_correction record;
    v_grade record;
BEGIN
    SELECT es.exam_id, es.max_marks INTO v_exam_id, v_max
    FROM exam_subjects es
    WHERE es.tenant_id = NEW.tenant_id AND es.id = NEW.exam_subject_id
      AND es.deleted_at IS NULL;

    IF v_exam_id IS NULL THEN
        RAISE EXCEPTION 'exam subject not found'
            USING ERRCODE = '55000';
    END IF;

    SELECT e.status INTO v_exam_status
    FROM exams e
    WHERE e.tenant_id = NEW.tenant_id AND e.id = v_exam_id;

    SELECT e.academic_year_id INTO v_year FROM exams e
    WHERE e.tenant_id = NEW.tenant_id AND e.id = v_exam_id;

    IF v_year IS DISTINCT FROM NEW.academic_year_id THEN
        RAISE EXCEPTION 'mark academic year must match the exam'
            USING ERRCODE = '55000';
    END IF;

    -- The enrollment is the anchor (unique(exam_subject, enrollment_id)): the
    -- student and section copies must be exactly the enrollment's own.
    SELECT en.student_id, en.section_id, en.academic_year_id
    INTO v_student, v_section, v_year
    FROM enrollments en
    WHERE en.tenant_id = NEW.tenant_id AND en.id = NEW.enrollment_id
      AND en.deleted_at IS NULL;

    IF v_student IS NULL THEN
        RAISE EXCEPTION 'enrollment not found'
            USING ERRCODE = '55000';
    END IF;

    IF v_student IS DISTINCT FROM NEW.student_id THEN
        RAISE EXCEPTION 'mark student must match the enrollment'
            USING ERRCODE = '55000';
    END IF;

    IF v_year IS DISTINCT FROM NEW.academic_year_id THEN
        RAISE EXCEPTION 'enrollment academic year must match the exam'
            USING ERRCODE = '55000';
    END IF;

    IF v_section IS DISTINCT FROM NEW.section_id THEN
        RAISE EXCEPTION 'mark section must match the enrollment'
            USING ERRCODE = '55000';
    END IF;

    -- entered_by is an ACTIVE membership of this tenant (identity anchor).
    IF NEW.entered_by IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM memberships m
        WHERE m.tenant_id = NEW.tenant_id AND m.user_id = NEW.entered_by
          AND m.status = 'active'
    ) THEN
        RAISE EXCEPTION 'marks must be entered by an active membership in this tenant'
            USING ERRCODE = '55000';
    END IF;

    IF v_exam_status IN ('draft','cancelled') THEN
        RAISE EXCEPTION 'marks cannot be entered while the exam is %', v_exam_status
            USING ERRCODE = '55000';
    END IF;

    IF NEW.marks_obtained IS NOT NULL AND NEW.marks_obtained > v_max THEN
        RAISE EXCEPTION 'marks_obtained (%) exceeds max_marks (%)', NEW.marks_obtained, v_max
            USING ERRCODE = '55000';
    END IF;

    -- DERIVED COLUMNS. A writer may post marks_obtained only; the grade is a
    -- function of (marks_obtained, max_marks, active scale).
    IF NEW.marks_obtained IS NULL THEN
        NEW.percentage := NULL;
        NEW.grade_label := NULL;
        NEW.grade_point := NULL;
    ELSE
        NEW.percentage := round((NEW.marks_obtained / v_max) * 100, 2);
        SELECT * INTO v_grade
        FROM fn_exam_grade_for(NEW.tenant_id, v_exam_id, NEW.percentage);
        NEW.grade_label := v_grade.label;
        NEW.grade_point := v_grade.point;
    END IF;

    IF v_exam_status = 'published' THEN
        -- Publication freezes the value set: everything becomes locked.
        IF TG_OP = 'INSERT' THEN
            RAISE EXCEPTION 'marks cannot be added to a published exam'
                USING ERRCODE = '55000';
        END IF;
        NEW.locked_at := COALESCE(OLD.locked_at, now());

        IF NEW.marks_obtained IS DISTINCT FROM OLD.marks_obtained THEN
            SELECT * INTO v_correction
            FROM mark_corrections mc
            WHERE mc.tenant_id = NEW.tenant_id
              AND mc.mark_id = NEW.id
              AND mc.old_marks_obtained IS NOT DISTINCT FROM OLD.marks_obtained
              AND mc.new_marks_obtained = NEW.marks_obtained
            ORDER BY mc.created_at DESC
            LIMIT 1;

            IF v_correction.id IS NULL THEN
                RAISE EXCEPTION 'a published mark can only be changed through the correction workflow'
                    USING ERRCODE = '55000';
            END IF;

            -- A corrected published mark is rechecked, not silently locked again.
            NEW.status := 'rechecked';
        ELSE
            -- The publication sweep (and any later no-op write) locks a
            -- provisional mark, but a rechecked mark keeps saying so.
            NEW.status := CASE WHEN OLD.status = 'rechecked' THEN 'rechecked' ELSE 'locked' END;
        END IF;
        RETURN NEW;
    END IF;

    -- Pre-publication: a provisional mark is the working state; a locked or
    -- rechecked mark may only move through the correction workflow, and a status
    -- is never a client-writable column. (Guarded by TG_OP because OLD is unassigned
    -- on INSERT.)
    IF TG_OP = 'UPDATE' THEN
        IF OLD.status IN ('locked','rechecked')
           AND NEW.marks_obtained IS DISTINCT FROM OLD.marks_obtained THEN
            SELECT * INTO v_correction
            FROM mark_corrections mc
            WHERE mc.tenant_id = NEW.tenant_id
              AND mc.mark_id = NEW.id
              AND mc.old_marks_obtained IS NOT DISTINCT FROM OLD.marks_obtained
              AND mc.new_marks_obtained = NEW.marks_obtained
            ORDER BY mc.created_at DESC
            LIMIT 1;

            IF v_correction.id IS NULL THEN
                RAISE EXCEPTION 'a locked mark can only be changed through the correction workflow'
                    USING ERRCODE = '55000';
            END IF;
            NEW.status := 'rechecked';
            NEW.locked_at := COALESCE(OLD.locked_at, now());
        END IF;

        IF NEW.status IS DISTINCT FROM OLD.status
           AND NEW.status IS DISTINCT FROM 'provisional' THEN
            -- Only the publication path (or the correction path above) may set a
            -- non-provisional status; a writer cannot promote its own mark.
            IF NOT (NEW.status = 'locked' AND v_exam_status = 'published') THEN
                RAISE EXCEPTION 'mark status is server-derived and cannot be set directly'
                    USING ERRCODE = '55000';
            END IF;
        END IF;
    END IF;

    RETURN NEW;
END
$$ LANGUAGE plpgsql SECURITY INVOKER;

DROP TRIGGER IF EXISTS marks_validate_trg ON marks;
CREATE TRIGGER marks_validate_trg
    BEFORE INSERT OR UPDATE ON marks
    FOR EACH ROW EXECUTE FUNCTION trg_marks_validate();

-- ------------------------------------------------------------------ mark corrections
-- Append-only, and only meaningful on a mark of a published exam: a "correction"
-- of a provisional mark is just mark entry.
CREATE OR REPLACE FUNCTION trg_mark_corrections_validate()
RETURNS trigger AS $$
DECLARE
    v_status text;
    v_max numeric;
    v_exam uuid;
BEGIN
    SELECT e.status, es.max_marks, e.id
    INTO v_status, v_max, v_exam
    FROM marks mk
    JOIN exam_subjects es ON es.tenant_id = mk.tenant_id AND es.id = mk.exam_subject_id
    JOIN exams e ON e.tenant_id = es.tenant_id AND e.id = es.exam_id
    WHERE mk.tenant_id = NEW.tenant_id AND mk.id = NEW.mark_id;

    IF v_status IS NULL THEN
        RAISE EXCEPTION 'mark not found'
            USING ERRCODE = '55000';
    END IF;

    IF v_status <> 'published' THEN
        RAISE EXCEPTION 'the correction workflow applies to published results only'
            USING ERRCODE = '55000';
    END IF;

    IF NEW.new_marks_obtained > v_max THEN
        RAISE EXCEPTION 'corrected mark (%) exceeds max_marks (%)', NEW.new_marks_obtained, v_max
            USING ERRCODE = '55000';
    END IF;

    -- The correction must describe THIS mark, and its denormalized copies must
    -- match the mark it corrects.
    IF NEW.exam_id IS DISTINCT FROM v_exam
       OR NEW.exam_subject_id IS DISTINCT FROM (SELECT mk.exam_subject_id FROM marks mk
            WHERE mk.tenant_id = NEW.tenant_id AND mk.id = NEW.mark_id)
       OR NEW.student_id IS DISTINCT FROM (SELECT mk.student_id FROM marks mk
            WHERE mk.tenant_id = NEW.tenant_id AND mk.id = NEW.mark_id) THEN
        RAISE EXCEPTION 'mark correction must describe the corrected mark'
            USING ERRCODE = '55000';
    END IF;

    IF NEW.old_marks_obtained IS DISTINCT FROM (SELECT mk.marks_obtained FROM marks mk
            WHERE mk.tenant_id = NEW.tenant_id AND mk.id = NEW.mark_id) THEN
        RAISE EXCEPTION 'mark correction old value does not match the mark'
            USING ERRCODE = '55000';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM memberships m
        WHERE m.tenant_id = NEW.tenant_id AND m.user_id = NEW.corrected_by
          AND m.status = 'active'
    ) THEN
        RAISE EXCEPTION 'a correction must be made by an active membership in this tenant'
            USING ERRCODE = '55000';
    END IF;

    RETURN NEW;
END
$$ LANGUAGE plpgsql SECURITY INVOKER;

DROP TRIGGER IF EXISTS mark_corrections_validate_trg ON mark_corrections;
CREATE TRIGGER mark_corrections_validate_trg
    BEFORE INSERT ON mark_corrections
    FOR EACH ROW EXECUTE FUNCTION trg_mark_corrections_validate();

-- No UPDATE/DELETE on mark_corrections at all: it is an audit table.
-- Nothing cascades INTO this table (every FK is a plain NO ACTION reference and
-- a tenant is retired with the `deleting` status, never a hard delete), so an
-- unconditional refusal is the whole rule: the ledger is append-only for good.
-- The runtime role holds only SELECT + INSERT, which makes this trigger the
-- backstop against a *privileged* session quietly rewriting the record.
CREATE OR REPLACE FUNCTION trg_mark_corrections_append_only()
RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'mark corrections are append-only'
        USING ERRCODE = '55000';
END
$$ LANGUAGE plpgsql SECURITY INVOKER;

DROP TRIGGER IF EXISTS mark_corrections_append_only_trg ON mark_corrections;
CREATE TRIGGER mark_corrections_append_only_trg
    BEFORE UPDATE OR DELETE ON mark_corrections
    FOR EACH ROW EXECUTE FUNCTION trg_mark_corrections_append_only();

-- ------------------------------------------------------------------ grading scales
-- Bands must tile 0..100 without gaps or overlap, each band well formed, and the
-- version axis is server-owned: a code's version is immutable and unique, and
-- only the newest version may be active.
CREATE OR REPLACE FUNCTION trg_grading_scales_validate()
RETURNS trigger AS $$
DECLARE
    v_band jsonb;
    v_cursor numeric := 0;
    v_min numeric;
    v_max numeric;
BEGIN
    -- NOTE: the SRF must be ALIASED (`AS band(value)`) and sorted on the alias.
    -- Referring to the plpgsql variable `v_band` inside the ORDER BY reads a
    -- record that is still NULL on the first pass, so the loop would run in
    -- JSON array order and reject a perfectly valid out-of-order scale.
    FOR v_band IN
        SELECT band.value
        FROM jsonb_array_elements(NEW.bands) AS band(value)
        ORDER BY (band.value ->> 'minPercent')::numeric
    LOOP
        IF (v_band ->> 'label') IS NULL OR length(v_band ->> 'label') NOT BETWEEN 1 AND 16 THEN
            RAISE EXCEPTION 'grading band label must be 1..16 characters'
                USING ERRCODE = '55000';
        END IF;
        v_min := (v_band ->> 'minPercent')::numeric;
        v_max := (v_band ->> 'maxPercent')::numeric;
        IF v_min IS NULL OR v_max IS NULL OR v_min < 0 OR v_max > 100 OR v_min >= v_max THEN
            RAISE EXCEPTION 'invalid grading band range %..%', v_min, v_max
                USING ERRCODE = '55000';
        END IF;
        IF (v_band ->> 'gradePoint')::numeric < 0 OR (v_band ->> 'gradePoint')::numeric > 4 THEN
            RAISE EXCEPTION 'grading band gradePoint must be within 0..4'
                USING ERRCODE = '55000';
        END IF;
        -- Contiguity: the first band must start at 0 and each next band must
        -- start exactly where the previous one ended.
        IF v_min <> v_cursor THEN
            RAISE EXCEPTION 'grading bands must tile 0..100 without gaps or overlap (expected %, got %)',
                v_cursor, v_min
                USING ERRCODE = '55000';
        END IF;
        v_cursor := v_max;
    END LOOP;

    IF v_cursor <> 100 THEN
        RAISE EXCEPTION 'grading bands must end at 100 (got %)', v_cursor
            USING ERRCODE = '55000';
    END IF;

    IF TG_OP = 'UPDATE' THEN
        IF NEW.code IS DISTINCT FROM OLD.code OR NEW.version IS DISTINCT FROM OLD.version THEN
            RAISE EXCEPTION 'grading scale code and version are immutable'
                USING ERRCODE = '55000';
        END IF;
        IF NEW.bands IS DISTINCT FROM OLD.bands AND OLD.is_active THEN
            RAISE EXCEPTION 'an active grading scale cannot be edited; create a new version'
                USING ERRCODE = '55000';
        END IF;
    END IF;

    -- At most one active version per code, and only the newest one.
    IF NEW.is_active AND EXISTS (
        SELECT 1 FROM grading_scales gs
        WHERE gs.tenant_id = NEW.tenant_id AND gs.code = NEW.code
          AND gs.deleted_at IS NULL AND gs.is_active
          AND gs.id IS DISTINCT FROM NEW.id
    ) THEN
        RAISE EXCEPTION 'another version of this grading scale is already active'
            USING ERRCODE = '55000';
    END IF;

    RETURN NEW;
END
$$ LANGUAGE plpgsql SECURITY INVOKER;

DROP TRIGGER IF EXISTS grading_scales_validate_trg ON grading_scales;
CREATE TRIGGER grading_scales_validate_trg
    BEFORE INSERT OR UPDATE ON grading_scales
    FOR EACH ROW EXECUTE FUNCTION trg_grading_scales_validate();

-- The exam type code is a configuration key that exams were filed against, so it
-- stays stable for the life of the row; only the display name and the active flag
-- may move.
CREATE OR REPLACE FUNCTION trg_exam_types_lifecycle_validate()
RETURNS trigger AS $$
BEGIN
    IF NEW.code IS DISTINCT FROM OLD.code THEN
        RAISE EXCEPTION 'exam type code is immutable'
            USING ERRCODE = '55000';
    END IF;
    IF NEW.is_active = false AND EXISTS (
        SELECT 1 FROM exams e
        WHERE e.tenant_id = NEW.tenant_id AND e.exam_type_id = NEW.id
          AND e.deleted_at IS NULL AND e.status IN ('draft','scheduled','grading')
    ) THEN
        RAISE EXCEPTION 'cannot deactivate an exam type used by a live exam'
            USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
END
$$ LANGUAGE plpgsql SECURITY INVOKER;

DROP TRIGGER IF EXISTS exam_types_lifecycle_trg ON exam_types;
CREATE TRIGGER exam_types_lifecycle_trg
    BEFORE UPDATE ON exam_types
    FOR EACH ROW EXECUTE FUNCTION trg_exam_types_lifecycle_validate();

-- ------------------------------------------------------------------ report cards
-- A published card is an immutable snapshot: only the artifact pointer may be
-- stamped after publication, nothing else. A new correction creates a new VERSION
-- row, so history is additive and auditable.
CREATE OR REPLACE FUNCTION trg_report_cards_validate()
RETURNS trigger AS $$
DECLARE
    v_exam_status text;
BEGIN
    SELECT e.status INTO v_exam_status
    FROM exams e
    WHERE e.tenant_id = NEW.tenant_id AND e.id = NEW.exam_id;

    IF v_exam_status IS NULL THEN
        RAISE EXCEPTION 'exam not found'
            USING ERRCODE = '55000';
    END IF;

    IF TG_OP = 'UPDATE' AND OLD.status = 'published' THEN
        IF NEW.gpa IS DISTINCT FROM OLD.gpa
           OR NEW.total_obtained IS DISTINCT FROM OLD.total_obtained
           OR NEW.total_possible IS DISTINCT FROM OLD.total_possible
           OR NEW.subject_count IS DISTINCT FROM OLD.subject_count
           OR NEW.version IS DISTINCT FROM OLD.version
           OR NEW.exam_id IS DISTINCT FROM OLD.exam_id
           OR NEW.student_id IS DISTINCT FROM OLD.student_id
           OR NEW.enrollment_id IS DISTINCT FROM OLD.enrollment_id
           OR NEW.academic_year_id IS DISTINCT FROM OLD.academic_year_id
           OR NEW.published_at IS DISTINCT FROM OLD.published_at
           OR NEW.status IS DISTINCT FROM OLD.status THEN
            RAISE EXCEPTION 'a published report card is immutable'
                USING ERRCODE = '55000';
        END IF;
        -- The artifact pointer is the ONE field a published card may still receive:
        -- the reports worker stamps the generated PDF onto the frozen snapshot.
        IF NEW.file_id IS NOT NULL AND NEW.file_id IS DISTINCT FROM OLD.file_id
           AND OLD.file_id IS NOT NULL THEN
            RAISE EXCEPTION 'a report card artifact cannot be replaced'
                USING ERRCODE = '55000';
        END IF;
        RETURN NEW;
    END IF;

    IF TG_OP = 'UPDATE' AND NEW.status = 'published' AND OLD.status <> 'published' THEN
        IF NEW.published_at IS NULL THEN
            RAISE EXCEPTION 'publication requires published_at'
                USING ERRCODE = '55000';
        END IF;
        -- A card may only be published with its exam published.
        IF v_exam_status <> 'published' THEN
            RAISE EXCEPTION 'a report card can only be published with its exam'
                USING ERRCODE = '55000';
        END IF;
    END IF;

    IF TG_OP = 'INSERT' AND NEW.status = 'published' AND v_exam_status <> 'published' THEN
        RAISE EXCEPTION 'a report card can only be published with its exam'
            USING ERRCODE = '55000';
    END IF;

    IF TG_OP = 'INSERT' AND v_exam_status NOT IN ('grading','published') THEN
        RAISE EXCEPTION 'report cards are generated while an exam is grading or published'
            USING ERRCODE = '55000';
    END IF;

    RETURN NEW;
END
$$ LANGUAGE plpgsql SECURITY INVOKER;

DROP TRIGGER IF EXISTS report_cards_validate_trg ON report_cards;
CREATE TRIGGER report_cards_validate_trg
    BEFORE INSERT OR UPDATE ON report_cards
    FOR EACH ROW EXECUTE FUNCTION trg_report_cards_validate();

-- ------------------------------------------------------------------ delete guards
-- A grading scale that an exam pins cannot be deleted: the published result would
-- lose the rules that produced it.
CREATE OR REPLACE FUNCTION trg_grading_scales_delete_guard()
RETURNS trigger AS $$
BEGIN
    IF NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL THEN
        IF EXISTS (
            SELECT 1 FROM exams e
            WHERE e.tenant_id = NEW.tenant_id AND e.grading_scale_id = NEW.id
              AND e.deleted_at IS NULL
        ) THEN
            RAISE EXCEPTION 'cannot delete a grading scale used by an exam'
                USING ERRCODE = '55000';
        END IF;
    END IF;
    RETURN NEW;
END
$$ LANGUAGE plpgsql SECURITY INVOKER;

DROP TRIGGER IF EXISTS grading_scales_delete_guard_trg ON grading_scales;
CREATE TRIGGER grading_scales_delete_guard_trg
    BEFORE UPDATE ON grading_scales
    FOR EACH ROW EXECUTE FUNCTION trg_grading_scales_delete_guard();

-- A published report card is an artifact that must stay reachable; a draft may be
-- superseded by the correction workflow.
CREATE OR REPLACE FUNCTION trg_report_cards_delete_guard()
RETURNS trigger AS $$
BEGIN
    IF NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL AND OLD.status = 'published' THEN
        RAISE EXCEPTION 'a published report card cannot be removed'
            USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
END
$$ LANGUAGE plpgsql SECURITY INVOKER;

DROP TRIGGER IF EXISTS report_cards_delete_guard_trg ON report_cards;
CREATE TRIGGER report_cards_delete_guard_trg
    BEFORE UPDATE ON report_cards
    FOR EACH ROW EXECUTE FUNCTION trg_report_cards_delete_guard();

-- ================================================================== RLS
-- Same shape as 0011/0014: FORCE row level security, tenant-branch
-- SELECT/INSERT/UPDATE keyed on the signed tenant claim, privileged executor
-- escape, and a privileged-only DELETE so the runtime role can only soft-delete.
DO $$
DECLARE
    t text;
BEGIN
    FOREACH t IN ARRAY ARRAY['exam_types','exams','exam_subjects','exam_schedules','marks',
                             'grading_scales','report_cards','mark_corrections'] LOOP
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
        EXECUTE format('CREATE POLICY %I ON %I FOR DELETE USING (app_privileged())',
            t || '_delete', t);
    END LOOP;
END
$$;

-- Explicit runtime grants (idempotent with the 0001 default privileges).
-- mark_corrections gets INSERT only: 0001 granted ALL TABLES to school_app_rw, so
-- the append-only intent needs an explicit REVOKE as well as the narrow GRANT.
-- The trigger refuses the rest; the privilege level states the same intent.
GRANT SELECT, INSERT, UPDATE, DELETE
    ON exam_types, exams, exam_subjects, exam_schedules, marks, grading_scales, report_cards
    TO school_app_rw;
GRANT SELECT, INSERT ON mark_corrections TO school_app_rw;
REVOKE UPDATE, DELETE ON mark_corrections FROM school_app_rw;

-- ================================================================== permission backfill
-- ==== PHASE 6 PERMISSION BACKFILL ====
-- Applies the Phase 6 exams permission set to system roles that existed before
-- this migration. Idempotent (ON CONFLICT DO NOTHING); scoped to exact template
-- codes with r.is_system = true, so custom tenant roles are never touched. Mirrors
-- the 0011/0014 backfill shape.
--
-- * school_owner: full tenure of the exams domain.
-- * principal:    read + manage + publish + correct. NOT mark — the principal
--                  configures and releases results but does not enter grades.
-- * teacher:      read + mark (own subject, enforced by teacher_assignments at the
--                  API). NOT publish, NOT correct (roadmap: "authz (teacher
--                  cannot publish)").
-- * parent/student: read (parent-scoped at the endpoint layer).
INSERT INTO role_permissions (role_id, permission)
SELECT r.id, p.permission
FROM roles r
JOIN (VALUES
    ('school_owner', 'exams.read'),
    ('school_owner', 'exams.manage'),
    ('school_owner', 'exams.mark'),
    ('school_owner', 'exams.publish'),
    ('school_owner', 'exams.correct'),
    ('principal', 'exams.read'),
    ('principal', 'exams.manage'),
    ('principal', 'exams.publish'),
    ('principal', 'exams.correct'),
    ('teacher', 'exams.read'),
    ('teacher', 'exams.mark'),
    ('parent', 'exams.read'),
    ('student', 'exams.read')
) AS p(code, permission) ON p.code = r.code
WHERE r.scope = 'tenant' AND r.is_system = true
ON CONFLICT (role_id, permission) DO NOTHING;
-- ==== END PHASE 6 PERMISSION BACKFILL ====
