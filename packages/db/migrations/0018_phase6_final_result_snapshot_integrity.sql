-- =============================================================================
-- 0018_phase6_final_result_snapshot_integrity.sql
--
-- Forward-only remediation of the three Phase 6 FINAL RE-AUDIT blockers. 0015,
-- 0016 and 0017 are already applied and are NOT edited; everything here is either
-- additive (a new table, a new function) or a CREATE OR REPLACE of a function an
-- earlier migration installed.
--
--   B1  THE PUBLICATION MARKER CANNOT BE BORN. 0017 made `published_exam_id` +
--       `frozen_at` server-owned, but only enforced that on UPDATE. A caller could
--       therefore INSERT a mark into a NON-published exam already carrying
--       `published_exam_id` = some OTHER published exam and a fabricated
--       `frozen_at`, and the row would be accepted: 0017's marker-ownership
--       branch is `IF TG_OP = 'UPDATE'`, so an INSERT skipped it entirely. The
--       freeze decision is made FROM that marker, so the row is born already
--       frozen, permanently un-re-homable and un-deletable, and its grade is
--       exempt from every guard the marker is supposed to switch on.
--       Publication itself is an UPDATE (the `exams_publish_lock_marks` sweep
--       stamps rows that already exist), so NO legitimate INSERT carries a
--       marker: the whole INSERT branch is now refused, for every role.
--
--   B2  A PUBLISHED REPORT CARD IS INTERNALLY COHERENT. `report_cards` stored only
--       AGGREGATES, while both the API's `loadSubjectLines` and the worker's
--       `loadReportCardDocument` read the per-subject lines back from LIVE
--       `marks`. A correction therefore moved the lines without moving the totals
--       the card was published with: one card could print "Total: 90.00 / 100.00"
--       above subject lines that now sum to 60, with a GPA derived from neither.
--       `report_card_subjects` freezes the per-subject lines AT THE VERSION THEY
--       BELONG TO, and every reader of a card's lines reads the snapshot instead
--       of `marks`.
--
--   B3  A CARD'S LINES BELONG TO THE CARD'S OWN EXAM. The worker's
--       `loadReportCardDocument` selected `exam_subjects.exam_id` and then
--       FILTERED IT IN JAVASCRIPT, so a sibling exam in the same academic year
--       contributed its subjects, marks and max_marks to another exam's PDF. The
--       snapshot removes the class of defect at the source - a line is keyed by
--       the report card it belongs to - and the database additionally refuses a
--       snapshot row whose `exam_subject_id` belongs to a different exam than its
--       card, so the predicate is enforced, not merely avoided.
--
-- Coherence is not left to the caller's arithmetic. `fn_report_card_totals` is the
-- ONE definition of a card's aggregate, computed from the snapshot in exact NUMERIC
-- arithmetic, and a DEFERRABLE constraint trigger refuses to let a transaction
-- commit a published card whose stored aggregates disagree with its own snapshot.
-- The worker therefore writes the snapshot first and stores whatever that function
-- says, which makes a mixed-content card unrepresentable rather than merely
-- unlikely.
--
-- Unrelated historical migrations are NOT touched: the scale pin, the one-way
-- lifecycle, the published-mark freeze, the hard-delete guards and the append-only
-- correction ledger all behave exactly as 0017 left them.
-- =============================================================================

-- ------------------------------------------------------------------ B1
-- The publication marker is server-owned on INSERT too.
--
-- 0017's own rule was "when OLD is not frozen, a caller may not supply one either -
-- the trigger is the only writer". It stated that inside `IF TG_OP = 'UPDATE'`, so
-- it was only half true. The rule as intended needs no UPDATE-only caveat at all:
-- the only writer of the marker is the publication sweep, and the sweep is an
-- UPDATE over marks that already exist (`trg_exams_publish_lock_marks`). There is
-- no supported INSERT that carries a marker, so a caller-supplied one is always
-- either redundant (a marker the sweep would have written) or a fabrication (a
-- freeze that never happened, stamped onto a mark of an unpublished exam).
--
-- Placed before any resolution of the current exam, and stated for EVERY role
-- including the table owner: the trust the marker rests on is that the database
-- put it there, and a session that can mint its own is no marker at all.
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
    -- ===== B1: a mark may not be BORN frozen =====
    -- Independent of the exam, the year, the enrollment and everything else below:
    -- a marker that did not come from the publication sweep is refused on arrival.
    -- Note this also closes the hole the CHECK constraint only appeared to close:
    -- `marks_publication_ck` demands both columns or neither, so a lone
    -- `frozen_at` was already refused - but a PAIR naming a genuinely published
    -- exam satisfied the CHECK, and 0017 accepted it, which is the forgery.
    IF TG_OP = 'INSERT' AND (NEW.published_exam_id IS NOT NULL OR NEW.frozen_at IS NOT NULL) THEN
        RAISE EXCEPTION 'the publication marker of a mark is server-owned: it is written only by publishing the mark''s own exam, and cannot be supplied at insert time'
            USING ERRCODE = '55000';
    END IF;

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

    -- ===== P1-01 (0017): the marker decides, before the current exam is trusted =====
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
            -- Reachable only now for a mark that predates this migration's B1 rule
            -- (an UPDATE cannot INSERT a row, so this is the sweep or a later
            -- repair writing a marker it is entitled to). Only the marker this
            -- trigger may ever write is "this mark's own exam, which is published".
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

    -- ===== P1-02 (0017): DERIVE ON VALUE CHANGE ONLY =====
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

-- ================================================================== B2 + B3
-- report_card_subjects: the frozen per-subject lines of ONE report-card version.
--
-- `report_cards` is versioned, and a published version is immutable, but the
-- per-subject detail it was published with was never stored: both the API and the
-- reports worker re-read it from `marks`. So the immutability was only true of the
-- aggregate half of the card. A correction is a legitimate move of a mark, and it
-- silently rewrote the lines of every ALREADY-PUBLISHED version of that card while
-- leaving the totals those versions were frozen with - which is how one card came
-- to describe "90 / 100, GPA 3.00" and "40 / 40" in the same document.
--
-- The snapshot is the lines, keyed by the card version that owns them:
--   * `subject_name` is a COPY, not a join. A published card is a document; the
--     subject must not be renamed or soft-deleted out from under it afterwards.
--   * `max_marks` / `weight` are copies too, for the same reason and because the
--     aggregate is computed from them (an `exam_subjects` row may be edited while
--     the exam is still grading).
--   * `percentage` / `grade_label` / `grade_point` are the DERIVED result as of
--     this version. They are what a correction must not be able to change here.
--   * `marks_obtained` may be NULL: a mark row exists for an ungraded subject, it
--     counts towards the denominator (max_marks) but contributes no score, and it
--     is still a line the card shows.
--
-- Every foreign key is composite on tenant_id, so no line can name another
-- tenant's card, exam subject or subject even with the RLS policies lifted.
CREATE TABLE report_card_subjects (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL,
    -- The version that owns this line.
    report_card_id uuid NOT NULL,
    -- The exam subject the line describes, and the subject it names.
    exam_subject_id uuid NOT NULL,
    subject_id uuid NOT NULL,
    subject_name text NOT NULL,
    marks_obtained numeric(9, 2),
    max_marks numeric(9, 2) NOT NULL,
    weight numeric(6, 3) NOT NULL,
    percentage numeric(5, 2),
    grade_label text,
    grade_point numeric(4, 2),
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT report_card_subjects_card_fk
        FOREIGN KEY (tenant_id, report_card_id) REFERENCES report_cards (tenant_id, id),
    CONSTRAINT report_card_subjects_exam_subject_fk
        FOREIGN KEY (tenant_id, exam_subject_id) REFERENCES exam_subjects (tenant_id, id),
    CONSTRAINT report_card_subjects_subject_fk
        FOREIGN KEY (tenant_id, subject_id) REFERENCES subjects (tenant_id, id),
    -- A subject session appears once on a card.
    CONSTRAINT report_card_subjects_line_uq UNIQUE (tenant_id, report_card_id, exam_subject_id),
    CONSTRAINT report_card_subjects_name_ck CHECK (length(subject_name) BETWEEN 1 AND 160),
    CONSTRAINT report_card_subjects_obtained_ck CHECK (marks_obtained IS NULL OR marks_obtained >= 0),
    CONSTRAINT report_card_subjects_max_marks_ck CHECK (max_marks > 0),
    CONSTRAINT report_card_subjects_weight_ck CHECK (weight > 0),
    CONSTRAINT report_card_subjects_percentage_ck
        CHECK (percentage IS NULL OR (percentage >= 0 AND percentage <= 100)),
    CONSTRAINT report_card_subjects_grade_point_ck
        CHECK (grade_point IS NULL OR (grade_point >= 0 AND grade_point <= 4)),
    CONSTRAINT report_card_subjects_label_ck CHECK (grade_label IS NULL OR length(grade_label) <= 16),
    -- A line is either fully graded or fully blank; a half-derived line would be a
    -- line the aggregate could not describe.
    CONSTRAINT report_card_subjects_grade_ck CHECK (
        (marks_obtained IS NULL AND percentage IS NULL AND grade_label IS NULL AND grade_point IS NULL)
        OR (marks_obtained IS NOT NULL AND percentage IS NOT NULL)
    )
);

CREATE UNIQUE INDEX report_card_subjects_tenant_id_uq
    ON report_card_subjects (tenant_id, id);
-- The only access path a reader has: "this card's lines", and it is the same read
-- the report-card detail, the portal, the transcript and the PDF all perform.
CREATE INDEX report_card_subjects_tenant_card_idx
    ON report_card_subjects (tenant_id, report_card_id);
CREATE INDEX report_card_subjects_tenant_exam_subject_idx
    ON report_card_subjects (tenant_id, exam_subject_id);
CREATE INDEX report_card_subjects_tenant_subject_idx
    ON report_card_subjects (tenant_id, subject_id);

COMMENT ON TABLE report_card_subjects IS
    'B2/B3: the frozen per-subject lines of ONE report_cards version. 0015-0017 stored only the card''s aggregates and re-read the detail from live `marks`, so a correction rewrote the lines of already-published versions and a sibling exam''s lines could be printed on a card. Every reader of a card''s lines reads this table, never `marks`.';
COMMENT ON COLUMN report_card_subjects.subject_name IS
    'Copied, not joined: a published card is a document and the subject may not be renamed or soft-deleted out from under it.';
COMMENT ON COLUMN report_card_subjects.max_marks IS
    'Copied from exam_subjects at the moment this version was computed; the card''s total_possible is the sum of these, and a later edit of the exam subject must not move a published card''s denominator.';
COMMENT ON COLUMN report_card_subjects.report_card_id IS
    'The report_cards version that owns this line. Immutable: a line may never be re-homed to another version, which is what makes a historical version readable at all.';

-- ------------------------------------------------------------------ B2 (1/3)
-- The snapshot is frozen with its card, and a line always belongs to its own exam.
--
-- Three rules, all of them properties of the DOCUMENT rather than of the session.
--
-- They are split across TWO triggers, and the split is load-bearing rather than
-- cosmetic:
--
--   * `report_card_subjects_validate_trg` holds rules 1 and 3 - the rules that say
--     a line is TRUE. Nothing in this migration lifts them, ever.
--   * `report_card_subjects_freeze_trg` holds rule 2 ALONE - the rule that says a
--     line is FROZEN. A card that is already published is precisely the card whose
--     lines are missing, so the historical backfill below cannot honour this rule
--     and may lift exactly this trigger, by name, for exactly one statement.
--
-- So the backfill is still a live self-check: it writes through every rule that
-- decides whether a line is true, and lifts only the rule about a line that has
-- already been shown to a family. A single combined trigger could not offer that,
-- because lifting it for the backfill would have lifted the integrity rules too.
--
--   1. OWN EXAM (B3). A line's `exam_subject_id` must belong to the card's own
--      exam. The worker's PDF loader had no such predicate in SQL and filtered in
--      JavaScript instead; a snapshot row that names another exam's subject is
--      the same defect with a permanent home, so it is refused outright. Stated
--      on INSERT and on every UPDATE, because a line that may be re-homed is a
--      line that may be re-homed onto a sibling exam.
--
--   2. FROZEN WITH A PUBLISHED CARD. Once the owning card is published the line
--      is part of an immutable snapshot: no UPDATE, no DELETE, for any role.
--      `report_cards` itself refuses everything but the artifact stamp on a
--      published card and refuses to remove or hard-delete one (0015/0017); the
--      lines are now guarded the same way, so the aggregate was never the only
--      thing keeping a published result whole. This is the whole of
--      `trg_report_card_subjects_freeze()`.
--
--   3. IDENTITY IS IMMUTABLE EVEN ON A DRAFT. A draft is a recomputable working
--      document, so its LINES may be rewritten as the marks move - that is the
--      whole point of the recompute. Its IDENTITY may not: a line may not be
--      re-homed to another card, exam subject, subject or tenant, because that
--      would let a working draft launder a line of one version onto another.
-- The integrity half of rules 1 and 3, stated ONCE so that the two triggers below
-- cannot drift apart and so that BOTH of them reject a malformed line identically.
--
-- Both triggers call this. `report_card_subjects_validate_trg` calls it always, so
-- the integrity rules are enforced even while the migration has the freeze lifted.
-- `report_card_subjects_freeze_trg` calls it FIRST, and that ordering is deliberate:
-- PostgreSQL fires same-timing triggers in ALPHABETICAL order by name, and
-- `report_card_subjects_freeze_trg` sorts before `report_card_subjects_validate_trg`.
-- Without this the freeze would answer first and a line that names a foreign exam
-- would be reported as "frozen" rather than as the own-exam violation it actually
-- is. The security outcome is the same either way - both reject - but a guard that
-- reports the wrong reason sends the reader looking in the wrong place, and the
-- freeze must not be able to mask an integrity failure.
CREATE OR REPLACE FUNCTION fn_report_card_line_assert_valid(
    p_tenant uuid,
    p_card uuid,
    p_exam_subject uuid,
    p_max_marks numeric,
    p_weight numeric
)
RETURNS void AS $$
DECLARE
    v_card_exam uuid;
    v_es_exam uuid;
    v_es_max numeric;
    v_es_weight numeric;
BEGIN
    SELECT rc.exam_id INTO v_card_exam
    FROM report_cards rc
    WHERE rc.tenant_id = p_tenant AND rc.id = p_card;

    SELECT es.exam_id, es.max_marks, es.weight INTO v_es_exam, v_es_max, v_es_weight
    FROM exam_subjects es
    WHERE es.tenant_id = p_tenant AND es.id = p_exam_subject;

    IF v_es_exam IS NULL THEN
        RAISE EXCEPTION 'exam subject not found'
            USING ERRCODE = '55000';
    END IF;

    IF v_es_exam IS DISTINCT FROM v_card_exam THEN
        RAISE EXCEPTION 'a report card subject line must describe a subject of the report card''s own exam'
            USING ERRCODE = '55000';
    END IF;

    -- The copies must BE copies. Without this a caller could snapshot a line
    -- carrying a max_marks of its own choosing, and the card's
    -- total_possible would describe an exam that never set it.
    IF p_max_marks IS DISTINCT FROM v_es_max OR p_weight IS DISTINCT FROM v_es_weight THEN
        RAISE EXCEPTION 'a report card subject line must copy max_marks and weight from the exam subject'
            USING ERRCODE = '55000';
    END IF;
END
$$ LANGUAGE plpgsql STABLE SECURITY INVOKER
SET search_path = public, pg_catalog;

COMMENT ON FUNCTION fn_report_card_line_assert_valid(uuid, uuid, uuid, numeric, numeric) IS
    'B2: the single definition of a report_card_subjects line being TRUE - the exam subject must exist, must belong to the card''s own exam, and the line''s max_marks and weight must be copies of that exam subject''s. Called by both trg_report_card_subjects_validate() and trg_report_card_subjects_freeze() so the two triggers cannot enforce different things.';

CREATE OR REPLACE FUNCTION trg_report_card_subjects_validate()
RETURNS trigger AS $$
BEGIN
    -- ===== 1. the line must belong to the card's own exam =====
    -- Nothing here consults the card's status: publication is not this trigger's
    -- business. That is what lets the backfill lift the freeze and keep this.
    IF TG_OP <> 'DELETE' THEN
        PERFORM fn_report_card_line_assert_valid(
            NEW.tenant_id, NEW.report_card_id, NEW.exam_subject_id, NEW.max_marks, NEW.weight
        );
    END IF;

    -- ===== 3. identity is immutable even on a draft =====
    IF TG_OP = 'UPDATE' THEN
        IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
           OR NEW.report_card_id IS DISTINCT FROM OLD.report_card_id
           OR NEW.exam_subject_id IS DISTINCT FROM OLD.exam_subject_id
           OR NEW.subject_id IS DISTINCT FROM OLD.subject_id THEN
            RAISE EXCEPTION 'a report card subject line cannot be re-homed to another card, exam subject, subject or tenant'
                USING ERRCODE = '55000';
        END IF;
    END IF;

    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$$ LANGUAGE plpgsql SECURITY INVOKER
SET search_path = public, pg_catalog;

COMMENT ON FUNCTION trg_report_card_subjects_validate() IS
    'B2: says a report_card_subjects line is TRUE - it describes a subject of its own card''s own exam, its max_marks and weight are copies of the exam subject''s, and its identity may never be re-homed onto another card, exam subject, subject or tenant. Deliberately holds NO publication rule, so the historical backfill can lift the freeze in trg_report_card_subjects_freeze() without ever lifting a single integrity rule.';

DROP TRIGGER IF EXISTS report_card_subjects_validate_trg ON report_card_subjects;
CREATE TRIGGER report_card_subjects_validate_trg
    BEFORE INSERT OR UPDATE OR DELETE ON report_card_subjects
    FOR EACH ROW EXECUTE FUNCTION trg_report_card_subjects_validate();

-- ===== 2. a published card's lines are frozen =====
-- The one publication rule for this table, alone in its own function so that the
-- one statement which legitimately must not honour it - the historical backfill -
-- can be granted a narrow exception without the exception extending to anything
-- else. The exemption is a property of THIS TRIGGER, not of a session flag, a
-- role, a GUC or a `search_path` trick: there is no state a runtime caller could
-- set to make itself exempt, because the migration re-enables the trigger before
-- it commits and a failure rolls that re-enabling back with it.
CREATE OR REPLACE FUNCTION trg_report_card_subjects_freeze()
RETURNS trigger AS $$
DECLARE
    v_card_status text;
BEGIN
    -- The shared integrity assertion runs first, for the reason given above: this
    -- trigger sorts before the validate trigger, and a malformed line must be
    -- reported as malformed rather than as frozen. DELETE has nothing to assert -
    -- the identity rules do not apply to a removal.
    IF TG_OP <> 'DELETE' THEN
        PERFORM fn_report_card_line_assert_valid(
            NEW.tenant_id, NEW.report_card_id, NEW.exam_subject_id, NEW.max_marks, NEW.weight
        );

        SELECT rc.status INTO v_card_status
        FROM report_cards rc
        WHERE rc.tenant_id = NEW.tenant_id AND rc.id = NEW.report_card_id;
    ELSE
        SELECT rc.status INTO v_card_status
        FROM report_cards rc
        WHERE rc.tenant_id = OLD.tenant_id AND rc.id = OLD.report_card_id;
    END IF;

    -- No role bypass, matching the card's own guard and the mark DELETE guard: a
    -- privileged session must not be able to quietly edit the body of a result
    -- that has already been shown to a family.
    IF v_card_status = 'published' THEN
        RAISE EXCEPTION 'a published report card''s subject lines are frozen: supersede the result with a new version'
            USING ERRCODE = '55000';
    END IF;

    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$$ LANGUAGE plpgsql SECURITY INVOKER
SET search_path = public, pg_catalog;

COMMENT ON FUNCTION trg_report_card_subjects_freeze() IS
    'B2: the single publication rule for report_card_subjects - once the owning card is published its subject lines are frozen for every role, for INSERT, UPDATE and DELETE. Kept alone in this function so the 0018 historical backfill can lift exactly this rule, and nothing else, for exactly one statement.';

DROP TRIGGER IF EXISTS report_card_subjects_freeze_trg ON report_card_subjects;
CREATE TRIGGER report_card_subjects_freeze_trg
    BEFORE INSERT OR UPDATE OR DELETE ON report_card_subjects
    FOR EACH ROW EXECUTE FUNCTION trg_report_card_subjects_freeze();

-- The version-1 lines of a card that predates this table are not reconstructible:
-- they were never stored, only re-read. What CAN be recorded is the line as it
-- stands, so the backfill takes the card's own exam and enrollment, in the tenant,
-- and copies the marks' own derived result (0017 froze those for a published exam,
-- so for an uncorrected published card the backfilled lines ARE the published
-- ones). The card's aggregates are then reconciled to the snapshot, which is a
-- no-op for every card that was never corrected after publication.
--
-- It is written through the SAME immutability rules as any other line, with exactly
-- one exception and it is the narrowest exception the schema admits.
--
-- The exception is the FREEZE, because a card that is ALREADY published is exactly
-- the card whose lines are missing - there is no draft to backfill, and the freeze
-- would otherwise make the missing history unrecoverable. So
-- `report_card_subjects_freeze_trg` is lifted BY NAME for exactly the one INSERT
-- below, and restored immediately afterwards with an assertion that it is enabled.
--
-- `report_card_subjects_validate_trg` is NOT lifted, and that is the whole point:
-- the backfill remains a live self-check of every rule that says a line is true. A
-- line that named a foreign exam, that failed to copy its max_marks or its weight,
-- or that carried a re-homed identity would abort the migration rather than be
-- grandfathered in - and the composite foreign keys, the per-card unique line key
-- and every check constraint are live throughout, because none of them are triggers
-- and none of them are disabled here.
--
-- A failure anywhere below - including the self-check rejecting a malformed
-- historical card - rolls this DISABLE back with it: the runner wrapped this whole
-- file in one transaction, so a migration that aborts cannot leave the freeze off.
ALTER TABLE report_card_subjects DISABLE TRIGGER report_card_subjects_freeze_trg;

INSERT INTO report_card_subjects (
    tenant_id, report_card_id, exam_subject_id, subject_id, subject_name,
    marks_obtained, max_marks, weight, percentage, grade_label, grade_point
)
SELECT rc.tenant_id,
       rc.id,
       es.id,
       es.subject_id,
       s.name,
       m.marks_obtained,
       es.max_marks,
       es.weight,
       m.percentage,
       m.grade_label,
       m.grade_point
FROM report_cards rc
JOIN exam_subjects es
  ON es.tenant_id = rc.tenant_id AND es.exam_id = rc.exam_id AND es.deleted_at IS NULL
JOIN subjects s
  ON s.tenant_id = es.tenant_id AND s.id = es.subject_id
JOIN marks m
  ON m.tenant_id = rc.tenant_id
 AND m.exam_subject_id = es.id
 AND m.enrollment_id = rc.enrollment_id
 AND m.academic_year_id = rc.academic_year_id
 AND m.deleted_at IS NULL
WHERE rc.deleted_at IS NULL;

-- The freeze is restored BEFORE anything else runs, and restored by name, so the
-- window in which a published card's lines are writable is this statement and
-- nothing after it.
ALTER TABLE report_card_subjects ENABLE TRIGGER report_card_subjects_freeze_trg;

-- And the restoration is asserted rather than trusted. `tgenabled = 'O'` is the
-- ordinary enabled state; 'D' would mean this migration finished leaving a
-- published result's body editable by any privileged session, which is precisely
-- the failure mode the split exists to make impossible. Both triggers are checked,
-- so a future edit that lifted the validation trigger here could not pass review
-- either.
DO $$
DECLARE
    v_validate text;
    v_freeze text;
BEGIN
    SELECT tgenabled INTO v_validate
    FROM pg_trigger
    WHERE tgrelid = 'report_card_subjects'::regclass
      AND tgname = 'report_card_subjects_validate_trg';

    SELECT tgenabled INTO v_freeze
    FROM pg_trigger
    WHERE tgrelid = 'report_card_subjects'::regclass
      AND tgname = 'report_card_subjects_freeze_trg';

    IF v_validate IS DISTINCT FROM 'O' THEN
        RAISE EXCEPTION 'post-backfill assertion failed: report_card_subjects_validate_trg must be enabled (tgenabled=''O''), found %',
            coalesce(v_validate, 'absent');
    END IF;

    IF v_freeze IS DISTINCT FROM 'O' THEN
        RAISE EXCEPTION 'post-backfill assertion failed: report_card_subjects_freeze_trg must be enabled (tgenabled=''O''), found %',
            coalesce(v_freeze, 'absent');
    END IF;
END
$$;

-- ------------------------------------------------------------------ B2 (2/3)
-- ONE definition of a card's aggregate, computed from its own lines.
--
-- This is the function the worker stores and the function the coherence trigger
-- checks, which is the point: the aggregate is not computed twice in two languages
-- and compared, it is computed once. A JS re-implementation rounding 3.005 to
-- 3.00 where NUMERIC rounds 3.01 would otherwise be a permanent source of
-- spurious "incoherent" failures.
--
-- The rules are the ones the aggregate has always used, stated once:
--   * `subject_count`     every line on the card, graded or not.
--   * `total_possible`     the sum of every line's max_marks, so an ungraded
--                          subject is in the denominator rather than a silent zero.
--   * `total_obtained`     the sum of the graded lines' scores, NULL while nothing
--                          at all has been graded.
--   * `gpa`                the WEIGHTED mean of the grade points over the lines
--                          that HAVE one, rounded to 2dp. An ungraded line has no
--                          grade point and must leave both the numerator and the
--                          denominator alone; a tenant with no scale gets totals
--                          and a NULL GPA rather than a fabricated 0.
CREATE OR REPLACE FUNCTION fn_report_card_totals(p_tenant uuid, p_card uuid)
RETURNS TABLE (
    gpa numeric,
    total_obtained numeric,
    total_possible numeric,
    subject_count integer
)
LANGUAGE sql STABLE
SET search_path = public, pg_catalog
AS $$
    SELECT
        CASE
            WHEN coalesce(sum(rcs.grade_point * rcs.weight)
                          FILTER (WHERE rcs.grade_point IS NOT NULL), 0) = 0 THEN NULL
            ELSE round(
                sum(rcs.grade_point * rcs.weight) FILTER (WHERE rcs.grade_point IS NOT NULL)
                / sum(rcs.weight) FILTER (WHERE rcs.grade_point IS NOT NULL), 2)
        END,
        CASE
            WHEN count(rcs.marks_obtained) = 0 THEN NULL
            ELSE sum(rcs.marks_obtained)
        END,
        coalesce(sum(rcs.max_marks), 0),
        count(*)::integer
    FROM report_card_subjects rcs
    WHERE rcs.tenant_id = p_tenant AND rcs.report_card_id = p_card;
$$;

COMMENT ON FUNCTION fn_report_card_totals(uuid, uuid) IS
    'B2: the single definition of a report card''s aggregate, derived from its own frozen subject lines in exact NUMERIC arithmetic. The worker stores what this returns and the coherence trigger compares against it, so the card''s totals and its lines can never be computed by two disagreeing implementations.';

-- ------------------------------------------------------------------ B2: the repair
-- Reconcile every PRE-EXISTING card's aggregate with the snapshot just written.
--
-- The one-time, audited exception, and deliberately narrow: the published-card
-- immutability trigger has no role bypass, so this is a single data repair
-- performed by the migration that owns the table, with that ONE trigger lifted for
-- exactly this statement and restored immediately after. It is NOT a template - a
-- privileged session still cannot rewrite a published card.
--
-- It runs BEFORE the coherence trigger below is attached, so the repair needs no
-- exception to it; and it runs inside the transaction the migration runner already
-- opened, with no explicit BEGIN/COMMIT of its own - a nested COMMIT would end that
-- outer transaction and the migration would stop being atomic.
--
-- Ordering note: the backfilled lines were written from the marks as they stand, and
-- the card's aggregates were computed from the marks as they stood AT PUBLICATION.
-- For every card that has not been corrected since publication the two are the same
-- numbers and this statement changes nothing. For a card that WAS corrected after
-- publication the pre-0018 behaviour was to display the corrected lines above the
-- pre-correction totals; reconciling the aggregate makes the stored card agree with
-- the lines it has been showing, and the correction flow then mints a properly
-- versioned successor, which is where the corrected result belongs.
ALTER TABLE report_cards DISABLE TRIGGER report_cards_validate_trg;

-- The aggregate of every card is read through a CTE rather than a LATERAL in the
-- UPDATE's own FROM clause: an UPDATE's target table is not a FROM-clause entry, so
-- it cannot be referenced from a lateral there.
WITH computed AS (
    SELECT rc_all.id,
           t.gpa,
           t.total_obtained,
           t.total_possible,
           t.subject_count
    FROM report_cards rc_all
    CROSS JOIN LATERAL fn_report_card_totals(rc_all.tenant_id, rc_all.id)
         AS t (gpa, total_obtained, total_possible, subject_count)
)
UPDATE report_cards rc
SET gpa = c.gpa,
    total_obtained = c.total_obtained,
    total_possible = c.total_possible,
    subject_count = c.subject_count
FROM computed c
WHERE c.id = rc.id
  AND (rc.gpa, rc.total_obtained, rc.total_possible, rc.subject_count)
      IS DISTINCT FROM (c.gpa, c.total_obtained, c.total_possible, c.subject_count);

ALTER TABLE report_cards ENABLE TRIGGER report_cards_validate_trg;

-- And the card-level restoration is asserted exactly as the line-level one above is,
-- in the same NULL-safe way, with the same reason. `report_cards_validate_trg` is the
-- published-card immutability rule - the one that refuses an aggregate rewrite, a
-- version change, a removal and a second artifact stamp - and it was lifted here for
-- the one aggregate repair. A migration that ended with the lift and no assertion
-- would migrate every database and leave every published result editable by any
-- privileged session from then on, silently.
--
-- `'D'` is the failure this refuses: this migration finishing with the guard off.
-- `absent` is refused by the same `IS DISTINCT FROM`, because a trigger that cannot
-- be found cannot be shown to be enabled.
DO $$
DECLARE
    v_card_guard text;
BEGIN
    SELECT tgenabled INTO v_card_guard
    FROM pg_trigger
    WHERE tgrelid = 'report_cards'::regclass
      AND tgname = 'report_cards_validate_trg';

    IF v_card_guard IS DISTINCT FROM 'O' THEN
        RAISE EXCEPTION 'post-repair assertion failed: report_cards_validate_trg must be enabled (tgenabled=''O''), found %',
            coalesce(v_card_guard, 'absent');
    END IF;
END
$$;

-- ------------------------------------------------------------------ B2 (3/3)
-- A published card may not COMMIT unless it agrees with its own lines.
--
-- Why a CONSTRAINT trigger and DEFERRABLE: a card's lines cannot exist before the
-- card does (the foreign key), so the only order in which a coherent version can
-- be written is card -> lines -> card again. Checked at COMMIT, the transaction is
-- free to write them in whatever order is convenient, and the guarantee is still
-- that no incoherent PUBLISHED card ever becomes visible. An immediate check would
-- have forced an ordering the schema cannot express.
--
-- Scoped to published cards on purpose. A DRAFT is a working document that is
-- recomputed in place: the worker replaces its lines and rewrites its aggregate in
-- the same transaction, and a draft's numbers are expected to be transient. What
-- must never happen is a DRAFT becoming PUBLISHED with numbers that do not
-- describe its own lines - so the transition is checked, because at that moment
-- the row is published and NEW is the row under test.
CREATE OR REPLACE FUNCTION trg_report_cards_snapshot_coherent()
RETURNS trigger AS $$
DECLARE
    v_status text;
    v_card uuid;
    v_tenant uuid;
    v_totals record;
    v_stored record;
BEGIN
    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;

    v_status := NEW.status;
    v_card := NEW.id;
    v_tenant := NEW.tenant_id;

    IF v_status <> 'published' THEN
        RETURN NULL;
    END IF;

    SELECT * INTO v_totals FROM fn_report_card_totals(v_tenant, v_card);
    SELECT gpa, total_obtained, total_possible, subject_count
      INTO v_stored
    FROM report_cards
    WHERE tenant_id = v_tenant AND id = v_card;

    -- NULL-safe on both sides, so "no grade" compares equal to "no grade" and a
    -- NULL aggregate never silently passes as a match against a real total.
    IF v_stored.gpa IS DISTINCT FROM v_totals.gpa
       OR v_stored.total_obtained IS DISTINCT FROM v_totals.total_obtained
       OR v_stored.total_possible IS DISTINCT FROM v_totals.total_possible
       OR v_stored.subject_count IS DISTINCT FROM v_totals.subject_count THEN
        RAISE EXCEPTION 'a published report card must agree with its own subject snapshot (card: gpa %, total %, of % over % subject(s); snapshot: gpa %, total %, of % over % subject(s))',
            v_stored.gpa, v_stored.total_obtained, v_stored.total_possible, v_stored.subject_count,
            v_totals.gpa, v_totals.total_obtained, v_totals.total_possible, v_totals.subject_count
            USING ERRCODE = '55000';
    END IF;

    RETURN NULL;
END
$$ LANGUAGE plpgsql SECURITY INVOKER
SET search_path = public, pg_catalog;

DROP TRIGGER IF EXISTS report_cards_snapshot_coherent_trg ON report_cards;
CREATE CONSTRAINT TRIGGER report_cards_snapshot_coherent_trg
    AFTER INSERT OR UPDATE ON report_cards
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION trg_report_cards_snapshot_coherent();

-- ------------------------------------------------------------------ RLS + grants
-- Exactly 0015's shape, applied to the one new table: ENABLE + FORCE, a
-- tenant-branch SELECT/INSERT/UPDATE keyed on the signed tenant claim with the
-- privileged executor escape, and a privileged-only DELETE so the runtime role can
-- only ever soft-remove. The composite foreign keys and the triggers above are the
-- second line; the policies are the boundary.
DO $$
DECLARE
    t text;
BEGIN
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', 'report_card_subjects');
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', 'report_card_subjects');
    EXECUTE format(
        'CREATE POLICY %I ON %I FOR SELECT USING (
             (tenant_id = app_current_tenant_id() AND app_current_tenant_id() IS NOT NULL)
             OR app_privileged()
         )', 'report_card_subjects_select', 'report_card_subjects');
    EXECUTE format(
        'CREATE POLICY %I ON %I FOR INSERT WITH CHECK (
             (tenant_id = app_current_tenant_id() AND app_current_tenant_id() IS NOT NULL)
             OR app_privileged()
         )', 'report_card_subjects_insert', 'report_card_subjects');
    EXECUTE format(
        'CREATE POLICY %I ON %I FOR UPDATE USING (
             (tenant_id = app_current_tenant_id() AND app_current_tenant_id() IS NOT NULL)
             OR app_privileged()
         ) WITH CHECK (
             (tenant_id = app_current_tenant_id() AND app_current_tenant_id() IS NOT NULL)
             OR app_privileged()
         )', 'report_card_subjects_update', 'report_card_subjects');
    EXECUTE format('CREATE POLICY %I ON %I FOR DELETE USING (app_privileged())',
        'report_card_subjects_delete', 'report_card_subjects');
END
$$;

-- Idempotent with the 0001 default privileges. DELETE is granted for the same
-- reason report_cards has it: the DELETE POLICY is privileged-only, so the grant
-- states the privilege level and the policy states the intent. The immutability
-- of a published card's lines is the trigger's job, not the grant's.
GRANT SELECT, INSERT, UPDATE, DELETE ON report_card_subjects TO school_app_rw;

-- ------------------------------------------------------------------ comments
COMMENT ON FUNCTION trg_marks_validate() IS
    'B1: the publication marker is server-owned on INSERT as well as UPDATE - a mark may not be born already frozen, and the freeze decision is made from the IMMUTABLE marker (published_exam_id), never from the writable marks.exam_subject_id. P1-02: percentage/grade_label/grade_point are re-derived ONLY when marks_obtained changes, so publication and any other lock-only write freeze the established result.';
COMMENT ON FUNCTION trg_report_card_subjects_validate() IS
    'B2/B3: a line must describe a subject of its own card''s own exam and must copy that exam subject''s max_marks and weight; a published card''s lines are frozen for every role (no UPDATE, no DELETE); and a line''s identity is immutable even on a draft, so a line can never be re-homed onto another version or another exam.';
COMMENT ON FUNCTION trg_report_cards_snapshot_coherent() IS
    'B2: a DEFERRABLE constraint trigger, so a version may be written card -> lines -> card, that refuses to let a transaction commit a published report card whose stored aggregate disagrees with the aggregate its own frozen subject lines produce.';
