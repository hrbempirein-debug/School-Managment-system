-- =============================================================================
-- 0017_phase6_result_publication_integrity.sql
--
-- Forward-only remediation of the Phase 6 FINAL RE-AUDIT (P1-01, P1-02, P2-01,
-- P2-02, P2-03, P3-01, P3-02). 0015 and 0016 are already applied and are NOT
-- edited; everything here is additive, or a CREATE OR REPLACE of a function an
-- earlier migration installed.
--
-- The two P1 findings share one root cause: the database decided "is this a
-- published result?" by following the mark's CURRENT, fully mutable
-- `exam_subject_id`. A mark could therefore be walked out of the published exam
-- and lose every guard that was supposed to protect it, and publication itself
-- re-derived an academic result instead of freezing the one that had already
-- been established.
--
--   P1-01  A mark that has become part of a published result carries a
--          DATABASE-OWNED, IMMUTABLE publication marker (`published_exam_id` +
--          `frozen_at`). The freeze decision is made from that preserved
--          relationship, so re-pointing `exam_subject_id` at another exam,
--          subject, section or year can no longer escape it. The marker is
--          server-owned: no role may set, move or clear it, and the DELETE guard
--          is driven by the same marker, independently of the current exam.
--
--   P1-02  PUBLICATION IS NOT A CORRECTION. The mark trigger now re-derives
--          `percentage` / `grade_label` / `grade_point` ONLY when
--          `marks_obtained` actually changes. Publication (the exam sweep) locks
--          and stamps marks and preserves the already stored result, so a
--          grading scale edited after marks were entered can no longer
--          retroactively re-grade them. The correction workflow still writes a
--          `mark_corrections` row and DOES re-derive, which is the only way a
--          published value moves.
--
--   P2-01  `exams.grading_scale_id` is frozen once the exam can have marks:
--          refused while the exam is `grading`/`published`, and refused as soon
--          as any mark exists. A `draft`/`scheduled` exam with no marks may
--          still choose its scale, which is what 0016 deliberately allowed.
--
--   P2-02  The documented one-way lifecycle is now actually enforced:
--          `grading -> scheduled` is refused, `published` and `cancelled` are
--          terminal, and nothing may return to `draft`.
--
--   P2-03  A published report card gains a hard-DELETE guard, for every role,
--          so the frozen snapshot cannot be destroyed by a privileged session.
--
--   P3-01  `marks.updated_at` is genuinely maintained: a BEFORE UPDATE trigger
--          stamps it, so the column no longer claims "updated" while being
--          insertion-only.
--
--   P3-02  The bands of a grading scale that an exam pinned to produce a result
--          are immutable. `is_active` is an operational toggle and was the only
--          thing protecting bands, so retiring a scale unlocked the rule that
--          produced every grade already stored under it.
--
-- Unrelated active scales are NOT restricted: the guard keys on "this scale is
-- pinned by an exam that is grading/published or that already has marks".
-- =============================================================================

-- ------------------------------------------------------------------ P1-01 (1/3)
-- The publication marker.
--
-- Two columns, always written together:
--   published_exam_id  the exam whose publication this mark is part of
--   frozen_at          when that happened
--
-- The point is that this relationship is NOT derivable from anything a caller
-- can change. `marks.exam_subject_id` is writable, so the exam a mark belongs to
-- is not a safe basis for "is this published?"; this marker is, because the
-- trigger refuses to let it move.
ALTER TABLE marks ADD COLUMN IF NOT EXISTS published_exam_id uuid;
ALTER TABLE marks ADD COLUMN IF NOT EXISTS frozen_at timestamptz;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'marks_published_exam_fk'
    ) THEN
        ALTER TABLE marks ADD CONSTRAINT marks_published_exam_fk
            FOREIGN KEY (tenant_id, published_exam_id) REFERENCES exams (tenant_id, id);
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'marks_publication_ck'
    ) THEN
        ALTER TABLE marks ADD CONSTRAINT marks_publication_ck CHECK (
            (published_exam_id IS NULL AND frozen_at IS NULL)
            OR (published_exam_id IS NOT NULL AND frozen_at IS NOT NULL)
        );
    END IF;
END
$$;

CREATE INDEX IF NOT EXISTS marks_tenant_published_exam_idx
    ON marks (tenant_id, published_exam_id) WHERE published_exam_id IS NOT NULL;

COMMENT ON COLUMN marks.published_exam_id IS
    'P1-01: server-owned immutable marker naming the exam whose publication froze this mark. It is the ONLY basis on which the published-mark freeze and the published-mark DELETE guard decide, because marks.exam_subject_id is writable.';
COMMENT ON COLUMN marks.frozen_at IS
    'P1-01: publication instant of this mark; moves together with published_exam_id and is immutable once set.';

-- ------------------------------------------------------------------ P1-01 (2/3)
-- The mark trigger, rebuilt around the marker.
--
-- Two new rules, evaluated BEFORE anything resolves the current exam:
--
--   1. MARKER OWNERSHIP. When OLD is frozen, the marker may not change at all
--      (so it cannot be repointed at another exam, nor cleared). When OLD is not
--      frozen, a caller may not supply one either — the trigger is the only
--      writer, which is what makes the marker trustworthy.
--
--   2. THE FREEZE. A frozen mark's rows are compared as JSONB minus the mutable
--      set, exactly as 0016 did, so `exam_subject_id`, `enrollment_id`,
--      `student_id`, `section_id`, `academic_year_id`, `tenant_id`, `entered_by`,
--      `deleted_at` and every future identity column are all refused. The
--      decision is taken from OLD.published_exam_id, so moving the mark to a
--      non-published exam's subject cannot shake it loose.
--
-- And one removal, which is P1-02: the derived columns are recomputed ONLY when
-- the score changes. 0016 re-derived on every UPDATE, so the publication sweep
-- (status/lock only) silently re-graded every mark of the exam against whatever
-- the grading bands said at publication time.
--
-- Mutable set, and why each one is here:
--   marks_obtained        the correction workflow's one legal value change
--   percentage            derived by THIS trigger from marks_obtained
--   grade_label           derived by THIS trigger from marks_obtained
--   grade_point           derived by THIS trigger from marks_obtained
--   status                server-owned: publication locks, correction rechecks
--   locked_at             stamped by publication / the correction path
--   updated_at            housekeeping (P3-01)
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
    v_value_changed boolean;
BEGIN
    -- The exam a mark belongs to is resolved FIRST, because both the freeze and
    -- the ownership of the marker are stated in terms of that exam. Nothing below
    -- is allowed to depend on anything a caller can change except the marker.
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

    -- ===== P1-01: the marker decides, before the current exam is trusted =====
    IF TG_OP = 'UPDATE' THEN
        IF OLD.published_exam_id IS NOT NULL THEN
            IF NEW.published_exam_id IS DISTINCT FROM OLD.published_exam_id
               OR NEW.frozen_at IS DISTINCT FROM OLD.frozen_at THEN
                RAISE EXCEPTION 'the publication marker of a mark is immutable: it records the exam whose publication froze this mark'
                    USING ERRCODE = '55000';
            END IF;

            -- Refused for EVERY role, privileged sessions included: a published
            -- result may not be moved to another student, repointed at another
            -- exam's subject, re-homed to another year or section, stripped of
            -- its attribution, or soft-hidden out of the report card. Comparing
            -- whole rows as JSONB minus the mutable set means a new identity
            -- column is frozen the day it is added, with no edit here.
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
        ELSIF NEW.published_exam_id IS NOT NULL OR NEW.frozen_at IS NOT NULL THEN
            -- Only the trigger may write the marker, and the only marker it may
            -- ever write is "this mark's own exam, which is published" - exactly
            -- what the publication path stamps. Honouring a caller-supplied
            -- marker that agrees with a genuinely published exam changes nothing
            -- (the sweep would have written the same thing), while any other
            -- value would let a session invent a freeze it then hides behind.
            IF v_exam_status IS DISTINCT FROM 'published'
               OR NEW.published_exam_id IS DISTINCT FROM v_exam_id THEN
                RAISE EXCEPTION 'the publication marker of a mark is server-owned and cannot be set directly'
                    USING ERRCODE = '55000';
            END IF;
        END IF;
    END IF;

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

    -- ===== P1-02: DERIVE ON VALUE CHANGE ONLY =====
    -- `marks_obtained` is the only input to the academic result, so it is the
    -- only thing that may re-derive it. Anything else that updates a mark
    -- (publication's lock sweep, a no-op re-save of the same grade) keeps the
    -- percentage/label/point that were established when the score was entered,
    -- so editing a grading band after the fact cannot re-grade a mark.
    -- CASE, not `TG_OP = 'INSERT' OR ...`: OLD is an unassigned record on INSERT
    -- and SQL does not promise an evaluation order for a plain OR, so the OLD
    -- reference could be evaluated on an INSERT. CASE evaluates only the branch
    -- it takes.
    v_value_changed := CASE
        WHEN TG_OP = 'INSERT' THEN true
        ELSE NEW.marks_obtained IS DISTINCT FROM OLD.marks_obtained
    END;

    IF NOT v_value_changed THEN
        -- Re-posting the derived columns is still not a thing: the trigger owns
        -- them and simply carries the stored values forward.
        NEW.percentage := OLD.percentage;
        NEW.grade_label := OLD.grade_label;
        NEW.grade_point := OLD.grade_point;
    ELSIF NEW.marks_obtained IS NULL THEN
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

        -- The mirror image of the freeze: a mark that is NOT frozen in this exam
        -- may not be walked INTO it either. 0015 refused to insert a new mark into
        -- a published exam but let an existing mark be re-pointed at one, which
        -- silently changed a published card's subject count, totals and GPA after
        -- the result had been announced.
        IF NEW.exam_subject_id IS DISTINCT FROM OLD.exam_subject_id THEN
            RAISE EXCEPTION 'a mark cannot be moved into a published exam; a published result is closed to new marks'
                USING ERRCODE = '55000';
        END IF;

        -- The publication stamp. Reached on the sweep and on any later write to a
        -- mark of a published exam that predates this migration's backfill.
        IF OLD.published_exam_id IS NULL THEN
            NEW.published_exam_id := v_exam_id;
            NEW.frozen_at := now();
        END IF;

        NEW.locked_at := COALESCE(OLD.locked_at, now());

        IF v_value_changed THEN
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
           AND v_value_changed THEN
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

-- ------------------------------------------------------------------ P1-01 (3/3)
-- The DELETE guard, now driven by the marker.
--
-- The OLD (0016) guard resolved the exam through the row being deleted, which is
-- exactly the column the attack moved. The marker is the preserved relationship,
-- so a mark that was ever part of a published result can never be removed — and
-- the CURRENT exam is still consulted as a second, independent reason, so a row
-- that somehow has no marker is still protected.
--
-- There is deliberately NO role bypass, matching the append-only ledger: a
-- privileged session must not be able to quietly destroy a published result.
-- Test fixtures dispose of their own rows by lifting the guard as the migrator
-- for the single teardown statement, which is the only audited escape.
CREATE OR REPLACE FUNCTION trg_marks_delete_guard()
RETURNS trigger AS $$
DECLARE
    v_exam_status text;
BEGIN
    IF OLD.published_exam_id IS NOT NULL THEN
        RAISE EXCEPTION 'a published mark cannot be deleted; correct it through the correction workflow so the change is recorded'
            USING ERRCODE = '55000';
    END IF;

    -- Second, independent reason: the exam the row currently points at is
    -- published. Kept so the guard does not depend on the marker alone.
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

-- Backfill the marker for every mark that already belongs to a published exam, so
-- the freeze applies to history as well as to new publications. `locked_at` is the
-- publication's own stamp where it exists, because that is when the mark became
-- part of the published result.
UPDATE marks m
SET published_exam_id = es.exam_id,
    frozen_at = COALESCE(m.locked_at, (SELECT e.published_at FROM exams e
                                       WHERE e.tenant_id = m.tenant_id AND e.id = es.exam_id), now())
FROM exam_subjects es
JOIN exams e ON e.tenant_id = es.tenant_id AND e.id = es.exam_id
WHERE m.tenant_id = es.tenant_id
  AND m.exam_subject_id = es.id
  AND e.status = 'published'
  AND m.published_exam_id IS NULL;

-- ------------------------------------------------------------------ P1-02 (2/2)
-- The publication sweep: freeze, do not re-grade.
--
-- 0015's comment said "publication is a state change on the exam but a state
-- change on every mark as well", and implemented it as an UPDATE of status +
-- locked_at. That is correct as a lifecycle action and is kept exactly — the
-- audit's complaint was not the lock, it was that the UPDATE re-entered the
-- derivation trigger, so a published grade was recomputed from the grading bands
-- as they stood at publication time. `trg_marks_validate` now derives only on a
-- score change, so the sweep is a pure freeze.
--
-- One widening: the sweep reaches EVERY mark of the exam, including one that is
-- already soft-deleted. A mark skipped by the sweep would carry no marker, and a
-- marker-less row of a published exam is a row that can still be re-homed and
-- resurrected, which would change a published card's totals.
CREATE OR REPLACE FUNCTION trg_exams_publish_lock_marks()
RETURNS trigger AS $$
BEGIN
    IF NEW.status = 'published' AND OLD.status IS DISTINCT FROM 'published' THEN
        UPDATE marks m
        SET status = CASE WHEN m.status = 'rechecked' THEN 'rechecked' ELSE 'locked' END,
            locked_at = COALESCE(m.locked_at, now())
        WHERE m.tenant_id = NEW.tenant_id
          AND m.exam_subject_id IN (
              SELECT es.id FROM exam_subjects es
              WHERE es.tenant_id = NEW.tenant_id AND es.exam_id = NEW.id
          );
    END IF;
    RETURN NULL;
END
$$ LANGUAGE plpgsql SECURITY INVOKER
SET search_path = public, pg_catalog;

DROP TRIGGER IF EXISTS exams_publish_lock_marks_trg ON exams;
CREATE TRIGGER exams_publish_lock_marks_trg
    AFTER UPDATE ON exams
    FOR EACH ROW EXECUTE FUNCTION trg_exams_publish_lock_marks();

-- ------------------------------------------------------------------ P2-01 + P2-02
-- The exam lifecycle, enforced as documented.
--
-- P2-01. The grade rule an exam is graded against is a versioned scale, and
-- changing it while marks exist silently re-interprets every stored grade: the
-- marks keep their old labels while `fn_exam_grade_for` now answers with the new
-- bands, so the aggregate GPA and the per-subject lines can disagree with the
-- stored marks. The pin is frozen from the moment a result can exist:
--   * never in `grading` or `published`;
--   * never once the exam has at least one mark.
-- A `draft` or `scheduled` exam with no marks may still name a different active
-- scale, which is what 0016's "staff can still choose a scale while organising
-- an unpublished exam" carve-out needs. The one write this rule must not refuse
-- is 0016's own materialisation of a NULL pin, which is not a change of rule.
--
-- P2-02. `draft -> scheduled -> grading -> published`, `cancelled` from any
-- pre-publication state, and no way back. 0015/0016 accepted
-- `grading -> scheduled`, which contradicts DATABASE_DESIGN §8 and the roadmap
-- lifecycle. It is now refused with its own message so the API can map it to a
-- structured domain error instead of a generic conflict.
CREATE OR REPLACE FUNCTION trg_exams_lifecycle_validate()
RETURNS trigger AS $$
DECLARE
    v_from text;
    v_to text;
    v_scale_key uuid;
    v_materialising boolean := false;
    v_pin_changed boolean;
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
        v_materialising := NEW.grading_scale_id IS NOT NULL;
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

    -- >>> P2-01: the pin is frozen as soon as a result can exist. <<<
    IF TG_OP = 'UPDATE' AND NOT v_materialising THEN
        v_pin_changed := NEW.grading_scale_id IS DISTINCT FROM OLD.grading_scale_id;
        IF v_pin_changed THEN
            IF NEW.status IN ('grading','published') THEN
                RAISE EXCEPTION 'the grading scale of an exam in status % cannot be changed', NEW.status
                    USING ERRCODE = '55000';
            END IF;
            IF EXISTS (
                SELECT 1
                FROM exam_subjects es
                JOIN marks m ON m.tenant_id = es.tenant_id AND m.exam_subject_id = es.id
                WHERE es.tenant_id = NEW.tenant_id AND es.exam_id = NEW.id
                  AND es.deleted_at IS NULL
                  AND m.deleted_at IS NULL
            ) THEN
                RAISE EXCEPTION 'the grading scale of an exam cannot be changed once marks exist'
                    USING ERRCODE = '55000';
            END IF;
        END IF;
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
        -- >>> P2-02: strictly forward. 0015/0016 also accepted `grading`, which
        -- contradicted the documented one-way lifecycle. <<<
        IF v_from IS DISTINCT FROM 'draft' THEN
            RAISE EXCEPTION 'exam cannot be scheduled from status %', coalesce(v_from, 'none')
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

-- ------------------------------------------------------------------ P2-03
-- A published report card is a frozen artifact: 0015 already refused to
-- soft-remove it and refused every UPDATE but the artifact stamp, but there was
-- no hard-DELETE guard, so `school_migrator` could erase the snapshot outright and
-- the audit trail would simply have a gap where the document used to be.
--
-- No role bypass, for the same reason as the mark DELETE guard. The supported
-- route to a different published representation is the versioning workflow, which
-- mints version + 1.
CREATE OR REPLACE FUNCTION trg_report_cards_hard_delete_guard()
RETURNS trigger AS $$
DECLARE
    v_status text;
BEGIN
    SELECT rc.status INTO v_status
    FROM report_cards rc
    WHERE rc.tenant_id = OLD.tenant_id AND rc.id = OLD.id;

    IF v_status = 'published' THEN
        RAISE EXCEPTION 'a published report card cannot be hard-deleted; supersede it with a new version'
            USING ERRCODE = '55000';
    END IF;

    RETURN OLD;
END
$$ LANGUAGE plpgsql SECURITY INVOKER
SET search_path = public, pg_catalog;

DROP TRIGGER IF EXISTS report_cards_hard_delete_guard_trg ON report_cards;
CREATE TRIGGER report_cards_hard_delete_guard_trg
    BEFORE DELETE ON report_cards
    FOR EACH ROW EXECUTE FUNCTION trg_report_cards_hard_delete_guard();

-- ------------------------------------------------------------------ P3-01
-- `marks.updated_at` is maintained, not decorative.
--
-- 0015 declared the column with `DEFAULT now()` and no trigger ever touched it,
-- so a mark row's "last updated" was really "when it was created" — including
-- after publication had locked it and after a correction had re-graded it. The
-- stamp is set on every UPDATE, which makes it evidence rather than a copy of
-- created_at. It is in the mutable set of the P1-01 freeze precisely because
-- housekeeping must not be mistaken for a change of identity.
CREATE OR REPLACE FUNCTION trg_marks_touch_updated_at()
RETURNS trigger AS $$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END
$$ LANGUAGE plpgsql SECURITY INVOKER
SET search_path = public, pg_catalog;

DROP TRIGGER IF EXISTS marks_touch_updated_at_trg ON marks;
CREATE TRIGGER marks_touch_updated_at_trg
    BEFORE UPDATE ON marks
    FOR EACH ROW EXECUTE FUNCTION trg_marks_touch_updated_at();

-- ------------------------------------------------------------------ P3-02
-- Grading bands that produced a result are immutable.
--
-- 0015 froze a scale's bands only while `is_active`. `is_active` is a tenant-wide
-- operational toggle ("which scale is current for NEW work"), so retiring a scale
-- unlocked the exact rule that produced every grade already stored under it: the
-- re-audit deactivated the pinned scale, rewrote its bands, and publication
-- re-graded a C/3.00 mark to E/1.50 with no correction row. P1-02 already stops
-- that from re-grading anything, and this closes the determinism hole underneath
-- it: a pinned scale is a historical record, not a draft.
--
-- Scoped deliberately. The guard keys on "this scale is pinned by a live exam
-- that is grading or published, or that already has marks", so an unrelated
-- active or retired scale nobody ever graded against stays editable.
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

        -- >>> P3-02: a scale that produced a result is history, not a draft. <<<
        IF NEW.bands IS DISTINCT FROM OLD.bands AND EXISTS (
            SELECT 1
            FROM exams e
            WHERE e.tenant_id = OLD.tenant_id
              AND e.grading_scale_id = OLD.id
              AND e.deleted_at IS NULL
              AND (
                  e.status IN ('grading','published')
                  OR EXISTS (
                      SELECT 1
                      FROM exam_subjects es
                      JOIN marks m
                        ON m.tenant_id = es.tenant_id AND m.exam_subject_id = es.id
                      WHERE es.tenant_id = e.tenant_id
                        AND es.exam_id = e.id
                        AND es.deleted_at IS NULL
                        AND m.deleted_at IS NULL
                  )
              )
        ) THEN
            RAISE EXCEPTION 'grading bands that produced a result cannot be edited; create a new version'
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

-- ------------------------------------------------------------------ comments
COMMENT ON FUNCTION trg_marks_validate() IS
    'P1-01: the published-mark freeze is decided from the IMMUTABLE publication marker (published_exam_id), not from the writable marks.exam_subject_id, so re-pointing the mark at a non-published exam cannot escape it; the marker itself is server-owned. P1-02: percentage/grade_label/grade_point are re-derived ONLY when marks_obtained changes, so publication and any other lock-only write freeze the established result.';
COMMENT ON FUNCTION trg_marks_delete_guard() IS
    'P1-01: refuses a hard DELETE of any mark that carries the publication marker, and independently any mark whose current exam is published. No role bypass: the correction workflow is the only supported way to change a published result.';
COMMENT ON FUNCTION trg_exams_publish_lock_marks() IS
    'P1-02: publication locks and freezes every mark of the exam (including an already soft-deleted one) and derives nothing; the stored percentage/grade_label/grade_point are carried forward untouched.';
COMMENT ON FUNCTION trg_exams_lifecycle_validate() IS
    'P2-01: grading_scale_id is frozen in grading/published and once marks exist; a draft/scheduled exam with no marks may still choose one. P2-02: strictly forward lifecycle - grading -> scheduled is refused, published and cancelled are terminal, draft is unreachable.';
COMMENT ON FUNCTION trg_report_cards_hard_delete_guard() IS
    'P2-03: refuses a hard DELETE of a published report card for every role; superseding a published result is done by minting a new version.';
COMMENT ON FUNCTION trg_marks_touch_updated_at() IS
    'P3-01: maintains marks.updated_at on every UPDATE, so the column is evidence of the last write rather than a copy of created_at.';
COMMENT ON FUNCTION trg_grading_scales_validate() IS
    'F-04/F-08 plus P3-02: every band must carry a non-null gradePoint within 0..4, band labels are unique within one scale, and the bands of a scale pinned by a live grading/published exam or by an exam that already has marks are immutable.';
