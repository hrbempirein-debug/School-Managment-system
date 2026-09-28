-- =============================================================================
-- 0016_phase6_result_integrity_fixes.sql
--
-- Forward-only remediation of the Phase 6 final verification audit. 0015 is
-- already applied and is NOT edited; everything here is additive or a
-- CREATE OR REPLACE of a function 0015 installed.
--
-- Fixes, in the order the audit raised them:
--   F-03  a published mark is FROZEN: no identity, ownership or visibility
--         column may move, and a published mark cannot be hard-deleted by ANY
--         role. The correction workflow stays the only legal mutation.
--   F-04  a grading band must carry a non-null gradePoint within 0..4.
--   F-08  grading band labels are unique within one scale.
--   F-06  every function 0013/0014/0015 installed pins
--         `search_path = public, pg_catalog` (the 0011/0012 convention).
--   F-07  a published exam's grade rule is an explicit, immutable reference to
--         one grading_scales version: a pinned scale no longer has to be
--         `is_active`, and an exam materialises its pin as soon as it enters a
--         state that accepts marks, so "the tenant's newest active scale" can
--         never reinterpret results that already exist.
-- =============================================================================

-- ------------------------------------------------------------------ F-03 (1/2)
-- Published-mark identity freeze.
--
-- The audit's row comparison is deliberately schema-drift-proof: instead of
-- naming the columns that must not change, it removes the columns this trigger
-- owns from BOTH rows and requires the rest to be identical. A future identity
-- column is therefore frozen the day it is added to `marks`, with no edit here.
--
-- Mutable set, and why each one is here:
--   marks_obtained        the correction workflow's one legal value change
--   percentage            derived by THIS trigger from marks_obtained
--   grade_label           derived by THIS trigger from marks_obtained
--   grade_point           derived by THIS trigger from marks_obtained
--   status                server-owned: publication locks, correction rechecks
--   locked_at             stamped by publication / the correction path
--   updated_at            housekeeping
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
    -- function of (marks_obtained, max_marks, the exam's pinned scale).
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

        -- >>> F-03: the identity/ownership/visibility freeze. <<<
        -- Refused for EVERY role, privileged sessions included: a published
        -- result may not be moved to another student, repointed at another
        -- exam's subject, re-homed to another year or section, stripped of its
        -- attribution, or soft-hidden out of the report card. Before this, only
        -- marks_obtained was guarded, so all of those succeeded.
        IF (to_jsonb(NEW) - ARRAY[
                'marks_obtained','percentage','grade_label','grade_point',
                'status','locked_at','updated_at'
            ])
           IS DISTINCT FROM
           (to_jsonb(OLD) - ARRAY[
                'marks_obtained','percentage','grade_label','grade_point',
                'status','locked_at','updated_at'
            ]) THEN
            RAISE EXCEPTION 'a published mark is frozen: it cannot be moved, re-homed, re-attributed or hidden; only the correction workflow may change its value'
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
$$ LANGUAGE plpgsql SECURITY INVOKER
SET search_path = public, pg_catalog;

DROP TRIGGER IF EXISTS marks_validate_trg ON marks;
CREATE TRIGGER marks_validate_trg
    BEFORE INSERT OR UPDATE ON marks
    FOR EACH ROW EXECUTE FUNCTION trg_marks_validate();

-- ------------------------------------------------------------------ F-03 (2/2)
-- Published-mark DELETE guard.
--
-- The intended invariant (DATABASE_DESIGN §8, roadmap "illegal mark edit blocked
-- at DB trigger") is that a published result cannot be REMOVED, only corrected.
-- The audit demonstrated a privileged migrator session hard-deleting one, which
-- left the published report card permanently disagreeing with `marks`.
--
-- There is deliberately NO role bypass. `trg_mark_corrections_append_only` already
-- sets the precedent for the ledger: an unconditional refusal is the backstop
-- against a *privileged* session quietly destroying history, and test fixtures
-- dispose of their own rows by lifting the guard as the migrator for the single
-- teardown statement. An emergency override would need a second, separately
-- audited capability, which this remediation does not invent.
CREATE OR REPLACE FUNCTION trg_marks_delete_guard()
RETURNS trigger AS $$
DECLARE
    v_exam_status text;
BEGIN
    SELECT e.status INTO v_exam_status
    FROM exam_subjects es
    JOIN exams e ON e.tenant_id = es.tenant_id AND e.id = es.exam_id
    WHERE es.tenant_id = OLD.tenant_id AND es.id = OLD.exam_subject_id;

    IF v_exam_status = 'published' THEN
        RAISE EXCEPTION 'a published mark cannot be deleted; correct it through the correction workflow so the change is recorded'
            USING ERRCODE = '55000';
    END IF;

    RETURN OLD;
END
$$ LANGUAGE plpgsql SECURITY INVOKER
SET search_path = public, pg_catalog;

DROP TRIGGER IF EXISTS marks_delete_guard_trg ON marks;
CREATE TRIGGER marks_delete_guard_trg
    BEFORE DELETE ON marks
    FOR EACH ROW EXECUTE FUNCTION trg_marks_delete_guard();

-- ------------------------------------------------------------------ F-07 (1/3)
-- fn_exam_grade_for: a PINNED scale is a historical reference, so it resolves by
-- id whether or not the tenant still has it active.
--
-- The audit probe showed a published exam whose scale was later deactivated
-- resolving to label=NULL / point=NULL, i.e. re-deriving any mark of it as
-- ungraded. `is_active` is a tenant-wide operational toggle ("which scale is
-- current for NEW work"), not part of the rule that produced an existing grade,
-- so it must only gate the unpinned fallback.
--
-- The fallback is also made deterministic: several CODES can be active at once
-- (grading_scales_active_uq is unique per (tenant_id, code)), so ordering by
-- `version` alone left "the tenant's newest active scale" up to the planner.
CREATE OR REPLACE FUNCTION fn_exam_grade_for(
    p_tenant_id uuid,
    p_exam_id uuid,
    p_percentage numeric
)
RETURNS TABLE (label text, point numeric)
LANGUAGE plpgsql SECURITY INVOKER
SET search_path = public, pg_catalog AS $$
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
      AND (CASE WHEN v_scale_id IS NULL THEN gs.is_active
                ELSE gs.id = v_scale_id END)
    ORDER BY gs.version DESC, gs.created_at DESC, gs.id
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

-- ------------------------------------------------------------------ F-07 (2/3)
-- Exam lifecycle: materialise the grading-scale pin.
--
-- An exam that pins nothing silently means "whatever the tenant's newest active
-- scale happens to be", so a published result could be re-interpreted after the
-- fact: the audit probe re-graded 70% from C/3 to Z/0 purely by activating a
-- second scale. From the first state that accepts marks onwards the exam records
-- WHICH version produced its grades, and `fn_exam_grade_for` then always
-- resolves that exact row.
--
-- The pin is materialised on INSERT and on a status TRANSITION only. A
-- same-status UPDATE is left alone so staff can still choose a scale while
-- organising an unpublished exam.
--
-- The published-reconfiguration check also learns one carve-out, needed by the
-- backfill below and safe by construction: filling a NULL pin is not a
-- reconfiguration. Swapping one non-null scale for another still raises.
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
    ELSE
        v_from := NULL;
        v_to := NEW.status;
    END IF;

    IF v_to NOT IN ('draft','scheduled','grading','published','cancelled') THEN
        RAISE EXCEPTION 'invalid exam status'
            USING ERRCODE = '55000';
    END IF;

    -- >>> F-07: pin the grade rule before any mark can depend on it. <<<
    -- `marks` are accepted in exactly 'scheduled' and 'grading' (0015
    -- trg_marks_validate), so this is the first moment a result can exist.
    IF v_to IN ('scheduled','grading','published')
       AND NEW.grading_scale_id IS NULL
       AND (TG_OP = 'INSERT' OR v_from IS DISTINCT FROM v_to) THEN
        SELECT gs.id INTO NEW.grading_scale_id
        FROM grading_scales gs
        WHERE gs.tenant_id = NEW.tenant_id
          AND gs.deleted_at IS NULL
          AND gs.is_active
        ORDER BY gs.version DESC, gs.created_at DESC, gs.id
        LIMIT 1;
        -- No active scale at all: the pin stays NULL and grade derivation still
        -- returns NULL, which 0015 already documents as the reachable failure.
    END IF;

    -- only a CHANGE of scale needs re-validating (see the check below)
    IF TG_OP = 'UPDATE' THEN
        v_scale_key := CASE
            WHEN NEW.grading_scale_id IS DISTINCT FROM OLD.grading_scale_id
                THEN NEW.grading_scale_id
            ELSE NULL
        END;
    ELSE
        v_scale_key := NEW.grading_scale_id;
    END IF;

    -- An explicitly NAMED scale must be active and undeleted AT THE MOMENT IT IS
    -- PINNED. Afterwards it is a historical reference and stays resolvable even
    -- if the tenant deactivates it (see fn_exam_grade_for).
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
               OR NEW.academic_year_id IS DISTINCT FROM OLD.academic_year_id
               OR (NEW.grading_scale_id IS DISTINCT FROM OLD.grading_scale_id
                   AND OLD.grading_scale_id IS NOT NULL) THEN
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
        -- Publication requires a real result set: at least one subject.
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
$$ LANGUAGE plpgsql SECURITY INVOKER
SET search_path = public, pg_catalog;

DROP TRIGGER IF EXISTS exams_lifecycle_trg ON exams;
CREATE TRIGGER exams_lifecycle_trg
    BEFORE INSERT OR UPDATE ON exams
    FOR EACH ROW EXECUTE FUNCTION trg_exams_lifecycle_validate();

-- ------------------------------------------------------------------ F-07 (3/3)
-- Backfill: give every exam that can already have marks the explicit pin it was
-- implicitly relying on. Deterministic and tenant-scoped, and a no-op where the
-- tenant has no active scale.
UPDATE exams e
SET grading_scale_id = (
    SELECT gs.id
    FROM grading_scales gs
    WHERE gs.tenant_id = e.tenant_id
      AND gs.deleted_at IS NULL
      AND gs.is_active
    ORDER BY gs.version DESC, gs.created_at DESC, gs.id
    LIMIT 1
)
WHERE e.grading_scale_id IS NULL
  AND e.status IN ('scheduled','grading','published')
  AND e.deleted_at IS NULL
  AND EXISTS (
      SELECT 1 FROM grading_scales gs
      WHERE gs.tenant_id = e.tenant_id
        AND gs.deleted_at IS NULL
        AND gs.is_active
  );

-- ------------------------------------------------------------------ F-04 + F-08
-- Grading bands: gradePoint is mandatory and labels are unique.
--
-- F-04. The range test alone could not see an absent key: `(NULL)::numeric < 0`
-- and `> 4` are NULL, `NULL OR NULL` is NULL, and `IF NULL` is not true, so
-- `{label, minPercent, maxPercent}` with no gradePoint passed validation and
-- every mark in that band derived grade_point = NULL. The DB now requires the
-- key, rejects an explicit JSON null, and keeps the 0..4 range. A JSON number and
-- a numeric string are both still accepted, as before.
--
-- F-08. A label identifies a grade, so two bands in one scale may not share it:
-- `[A 0-50, A 50-100]` grades the same letter to two different grade points.
CREATE OR REPLACE FUNCTION trg_grading_scales_validate()
RETURNS trigger AS $$
DECLARE
    v_band jsonb;
    v_cursor numeric := 0;
    v_min numeric;
    v_max numeric;
    v_point numeric;
    v_label text;
    v_labels text[] := ARRAY[]::text[];
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
        v_label := v_band ->> 'label';
        IF v_label IS NULL OR length(v_label) NOT BETWEEN 1 AND 16 THEN
            RAISE EXCEPTION 'grading band label must be 1..16 characters'
                USING ERRCODE = '55000';
        END IF;

        -- F-08: one label per grade.
        IF v_label = ANY (v_labels) THEN
            RAISE EXCEPTION 'grading band label % appears more than once in this scale', v_label
                USING ERRCODE = '55000';
        END IF;
        v_labels := array_append(v_labels, v_label);

        v_min := (v_band ->> 'minPercent')::numeric;
        v_max := (v_band ->> 'maxPercent')::numeric;
        IF v_min IS NULL OR v_max IS NULL OR v_min < 0 OR v_max > 100 OR v_min >= v_max THEN
            RAISE EXCEPTION 'invalid grading band range %..%', v_min, v_max
                USING ERRCODE = '55000';
        END IF;

        -- F-04: the key must be PRESENT and not JSON null, then in range.
        IF NOT (v_band ? 'gradePoint') OR jsonb_typeof(v_band -> 'gradePoint') = 'null' THEN
            RAISE EXCEPTION 'grading band gradePoint is required'
                USING ERRCODE = '55000';
        END IF;
        v_point := (v_band ->> 'gradePoint')::numeric;
        IF v_point IS NULL OR v_point < 0 OR v_point > 4 THEN
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
$$ LANGUAGE plpgsql SECURITY INVOKER
SET search_path = public, pg_catalog;

DROP TRIGGER IF EXISTS grading_scales_validate_trg ON grading_scales;
CREATE TRIGGER grading_scales_validate_trg
    BEFORE INSERT OR UPDATE ON grading_scales
    FOR EACH ROW EXECUTE FUNCTION trg_grading_scales_validate();

-- ------------------------------------------------------------------ F-06
-- Pin `search_path` on the functions 0013, 0014 and 0015 installed without it.
--
-- 0011/0012 established the convention (`SET search_path = public, pg_catalog` on
-- every trigger function); 0013, 0014 and 0015 drifted. A SECURITY INVOKER
-- trigger body resolves its own table and function names through the caller's
-- search_path, so an object created earlier in that path could shadow
-- `marks`, `exams`, `fn_exam_grade_for` and friends inside the guard itself.
-- `school_app_rw` holds no CREATE on `public` today, so this is defence in depth
-- rather than a live hole — pinned now so a later grant cannot turn it into one.
--
-- The list is explicit (no pattern matching over pg_proc) so this can never
-- silently capture an unrelated function, and the loop is idempotent.
DO $$
DECLARE
    r record;
BEGIN
    FOR r IN
        SELECT p.oid::regprocedure AS sig
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
          AND p.proname = ANY (ARRAY[
              -- 0013 student homework identity
              'trg_students_user_link_validate',
              -- 0014 attendance + leave
              'trg_attendance_days_validate',
              'trg_attendance_periods_validate',
              'trg_leave_requests_validate',
              'trg_leave_types_delete_guard',
              'trg_leave_types_lifecycle_validate',
              'trg_staff_attendance_validate',
              -- 0015 exams + results (the four redefined above already carry
              -- SET search_path in their definition; ALTER is a no-op for them)
              'fn_exam_grade_for',
              'trg_exam_schedules_validate',
              'trg_exam_subjects_validate',
              'trg_exam_types_lifecycle_validate',
              'trg_exams_delete_guard',
              'trg_exams_lifecycle_validate',
              'trg_exams_publish_lock_marks',
              'trg_grading_scales_delete_guard',
              'trg_grading_scales_validate',
              'trg_mark_corrections_append_only',
              'trg_mark_corrections_validate',
              'trg_marks_validate',
              'trg_marks_delete_guard',
              'trg_report_cards_delete_guard',
              'trg_report_cards_validate'
          ])
          AND NOT EXISTS (
              SELECT 1 FROM unnest(coalesce(p.proconfig, ARRAY[]::text[])) AS cfg
              WHERE cfg LIKE 'search_path=%'
          )
    LOOP
        EXECUTE format('alter function %s set search_path = public, pg_catalog', r.sig);
    END LOOP;
END
$$;

COMMENT ON FUNCTION trg_marks_delete_guard() IS
    'F-03: refuses a hard DELETE of any mark belonging to a published exam, for every role. No bypass: the correction workflow is the only supported way to change a published result.';
COMMENT ON FUNCTION trg_marks_validate() IS
    'F-03: on a published exam, every column except marks_obtained and the columns this trigger derives from it (percentage, grade_label, grade_point, status, locked_at, updated_at) is frozen, compared as jsonb minus the mutable set so a new identity column is frozen automatically.';
COMMENT ON FUNCTION fn_exam_grade_for(uuid, uuid, numeric) IS
    'F-07: resolves the exam''s PINNED grading_scales version whether or not it is still is_active; is_active gates only the unpinned fallback, which is now ordered deterministically.';
COMMENT ON FUNCTION trg_exams_lifecycle_validate() IS
    'F-07: materialises exams.grading_scale_id on INSERT and on any transition into scheduled/grading/published, so an exam with marks always records which scale version produced its grades.';
COMMENT ON FUNCTION trg_grading_scales_validate() IS
    'F-04/F-08: every band must carry a non-null gradePoint within 0..4, and band labels are unique within one scale.';
