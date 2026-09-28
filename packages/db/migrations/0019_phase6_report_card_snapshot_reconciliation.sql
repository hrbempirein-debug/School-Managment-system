-- =============================================================================
-- 0019_phase6_report_card_snapshot_reconciliation.sql
--
-- Forward-only, idempotent reconciliation of `report_card_subjects` - the
-- Phase 6 frozen per-subject snapshot of a `report_cards` version.
--
-- WHAT THIS IS NOT
-- This is NOT a repair for the defect that was fixed inside 0018. That defect
-- (0018's historical backfill aborting on an already-published card) lived INSIDE
-- 0018, and a migration that runs after 0018 cannot repair anything that prevents
-- 0018 from completing: `applyMigrations` executes the files in order and aborts
-- the run on the first failure, so 0018 failing means 0019 is never read. 0018 was
-- therefore corrected in place, and the corrected 0018 completes on a database
-- that already holds published cards. THIS file is the separate, defensive layer.
--
-- WHAT THIS IS FOR
-- A database can hold published report cards whose snapshot lines are missing,
-- for reasons that have nothing to do with 0018's backfill:
--
--   * it applied a build of 0018 from before the trigger split was made. That
--     build's backfill is only reachable when every pre-existing card was a draft,
--     so a database that took that path and LATER published a card legitimately -
--     through the application, which at that time had nowhere to write lines -
--     ends up with a published card and no lines at all. This is the real target.
--   * a card was published during the window between 0018 and this file.
--
-- In every such case the card's body was never written, and the card's stored
-- aggregate is whatever it was at publication. This file writes the missing lines
-- from the marks that stand, then makes the card agree with them.
--
-- WHAT IT DELIBERATELY DOES NOT DO
--   * It never mutates a line that already exists. The insert is
--     `ON CONFLICT DO NOTHING` against `report_card_subjects_line_uq`, so a card
--     that already holds a valid snapshot is left exactly as it is. In particular a
--     card that was already backfilled by the corrected 0018 is untouched here.
--   * It never weakens the published-card freeze. The freeze is lifted for exactly
--     one statement, by name, and re-enabled and asserted immediately afterwards -
--     the same idiom 0018 already uses for `report_cards_validate_trg`.
--   * It is not a template for privileged writes. The exemption is a property of
--     the named trigger for the duration of one statement inside this migration's
--     transaction, not a session flag, a role, a GUC or a `search_path` trick, and
--     there is no state a runtime caller could set to give itself the same freedom.
--     The migration re-enables the trigger before it commits, and because the runner
--     wrapped the whole file in a single transaction, an abort anywhere below rolls
--     the DISABLE back with it.
--
-- IDEMPOTENCE
-- Run on a healthy database this file changes nothing: the expected-line set is
-- already fully present, so the insert conflicts on every row and writes none, and
-- the aggregate reconciliation is guarded by `IS DISTINCT FROM` so it updates
-- nothing. Run twice, the second run is a no-op. The post-condition assertion at
-- the end holds on both runs.
--
-- Idempotence is also the honest failure mode. If this file finds a published card
-- whose history cannot be reconstructed - an exam subject with no surviving mark,
-- say - it inserts what it can, and the deferred coherence trigger
-- `report_cards_snapshot_coherent_trg` (installed by 0018) is left to judge the
-- result at COMMIT. This file therefore never asserts a success it has not got:
-- it either leaves a coherent card or the transaction aborts.
-- =============================================================================

-- ------------------------------------------------------------------ the lockout
-- The same one-statement, named, immediately-restored exemption 0018 uses, and for
-- the same reason: a published card is exactly the card whose lines are missing, so
-- there is nothing to reconcile if the freeze is honoured. The published-card
-- immutability trigger has no role bypass, so this is a single data repair performed
-- by the migration that owns the table, with that ONE trigger lifted for exactly the
-- one statement below and restored immediately after.
--
-- `report_card_subjects_validate_trg` is NOT lifted. Every rule that decides whether
-- a line is true - own exam, copied max_marks and weight, non-re-homable identity -
-- stays live across the insert below, and so do the composite foreign keys, the
-- per-card unique line key and every check constraint, because none of them are
-- triggers and none of them are disabled here. A malformed historical card still
-- aborts this migration rather than being grandfathered in.
--
-- It runs inside the transaction the migration runner already opened, with no
-- explicit BEGIN/COMMIT of its own - a nested COMMIT would end that outer
-- transaction and the migration would stop being atomic.
ALTER TABLE report_card_subjects DISABLE TRIGGER report_card_subjects_freeze_trg;

-- ------------------------------------------------------------------ the reconciliation
-- Exactly 0018's backfill, narrowed three ways so that it is safe to run against a
-- database 0018 already populated:
--
--   1. `missing` keeps only the expected lines a card does NOT already hold, so a
--      complete card contributes no rows at all.
--   2. `ON CONFLICT DO NOTHING` against `report_card_subjects_line_uq` makes the
--      insert safe even where a card is only PARTIALLY populated, and makes it
--      impossible for this migration to write a second version of a line that is
--      already stored. The existing line wins; this file never overwrites it.
--   3. `WHERE rc.deleted_at IS NULL` and the `es.deleted_at IS NULL` /
--      `m.deleted_at IS NULL` filters are 0018's own, so a soft-removed subject,
--      exam subject or mark is not resurrected here.
--
-- Ordering note carried over from 0018: the lines are written from the marks as they
-- stand, and the card's aggregates were computed from the marks as they stood AT
-- PUBLICATION. For a card that has not been corrected since publication the two are
-- the same numbers and the reconciliation below changes nothing. For a card that WAS
-- corrected after publication, the pre-0018 behaviour was to display the corrected
-- lines above the pre-correction totals; reconciling the aggregate makes the stored
-- card agree with the lines it has been showing, and the correction flow then mints
-- a properly versioned successor, which is where the corrected result belongs.
WITH expected AS (
    SELECT rc.tenant_id,
           rc.id           AS report_card_id,
           es.id           AS exam_subject_id,
           es.subject_id,
           s.name          AS subject_name,
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
    WHERE rc.deleted_at IS NULL
),
missing AS (
    SELECT e.*
    FROM expected e
    WHERE NOT EXISTS (
        SELECT 1
        FROM report_card_subjects rcs
        WHERE rcs.tenant_id = e.tenant_id
          AND rcs.report_card_id = e.report_card_id
          AND rcs.exam_subject_id = e.exam_subject_id
    )
)
INSERT INTO report_card_subjects (
    tenant_id, report_card_id, exam_subject_id, subject_id, subject_name,
    marks_obtained, max_marks, weight, percentage, grade_label, grade_point
)
SELECT tenant_id,
       report_card_id,
       exam_subject_id,
       subject_id,
       subject_name,
       marks_obtained,
       max_marks,
       weight,
       percentage,
       grade_label,
       grade_point
FROM missing
ON CONFLICT (tenant_id, report_card_id, exam_subject_id) DO NOTHING;

-- The freeze goes back BEFORE anything else runs, and back by name, so the window in
-- which a published card's lines are writable is the statement above and nothing
-- after it.
ALTER TABLE report_card_subjects ENABLE TRIGGER report_card_subjects_freeze_trg;

-- The restoration is asserted rather than trusted. `tgenabled = 'O'` is the ordinary
-- enabled state; 'D' would mean this migration finished leaving a published result's
-- body editable by any privileged session. Both triggers are checked, so a future
-- edit that lifted the validation trigger here could not pass review either.
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
        RAISE EXCEPTION 'post-reconciliation assertion failed: report_card_subjects_validate_trg must be enabled (tgenabled=''O''), found %',
            coalesce(v_validate, 'absent');
    END IF;

    IF v_freeze IS DISTINCT FROM 'O' THEN
        RAISE EXCEPTION 'post-reconciliation assertion failed: report_card_subjects_freeze_trg must be enabled (tgenabled=''O''), found %',
            coalesce(v_freeze, 'absent');
    END IF;
END
$$;

-- ------------------------------------------------------------------ the aggregates
-- Make every card's stored aggregate agree with the snapshot it now holds, for the
-- cards this file actually touched and for no others: 0018's own statement, whose
-- `IS DISTINCT FROM` guard means a card that already agrees is not updated. It is
-- therefore a no-op on a healthy database, and a no-op on the second run.
--
-- The aggregate of a card is read through a CTE rather than a LATERAL in the
-- UPDATE's own FROM clause: an UPDATE's target table is not a FROM-clause entry, so
-- it cannot be referenced from a lateral there.
--
-- `report_cards` is a PUBLISHED-row-immutable document (0015/0017), and this
-- statement rewrites aggregates on published cards. That is the same one-time
-- audited repair 0018 performs, under the same named, immediately-restored
-- exemption - and 0018 is the migration that made that repair, so it is also the
-- only place where it is in scope.
ALTER TABLE report_cards DISABLE TRIGGER report_cards_validate_trg;

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

-- ------------------------------------------------------------------ post-conditions
-- Two things this file is not willing to leave to chance.
--
-- First, the card-level trigger that was lifted for the aggregate repair above is
-- back on, for the same reason as the line-level one and asserted the same way.
--
-- Second, and this is the real post-condition: every published, non-deleted card now
-- agrees with its own frozen lines. `report_cards_snapshot_coherent_trg` is a
-- DEFERRABLE INITIALLY DEFERRED constraint trigger, so it will also fire on this
-- transaction's updated rows at COMMIT - but it is checked here as well, and in the
-- same NULL-safe way it is checked there, so a failure names the card and the two
-- numbers rather than surfacing as an opaque deferred error at commit time.
DO $$
DECLARE
    v_guard text;
    v_bad record;
BEGIN
    SELECT tgenabled INTO v_guard
    FROM pg_trigger
    WHERE tgrelid = 'report_cards'::regclass
      AND tgname = 'report_cards_validate_trg';

    IF v_guard IS DISTINCT FROM 'O' THEN
        RAISE EXCEPTION 'post-reconciliation assertion failed: report_cards_validate_trg must be enabled (tgenabled=''O''), found %',
            coalesce(v_guard, 'absent');
    END IF;

    SELECT rc.id,
           rc.tenant_id,
           rc.gpa, t.gpa AS snap_gpa,
           rc.total_obtained, t.total_obtained AS snap_total_obtained,
           rc.total_possible, t.total_possible AS snap_total_possible,
           rc.subject_count, t.subject_count AS snap_subject_count
      INTO v_bad
    FROM report_cards rc
    CROSS JOIN LATERAL fn_report_card_totals(rc.tenant_id, rc.id)
         AS t (gpa, total_obtained, total_possible, subject_count)
    WHERE rc.deleted_at IS NULL
      AND rc.status = 'published'
      AND (rc.gpa, rc.total_obtained, rc.total_possible, rc.subject_count)
          IS DISTINCT FROM (t.gpa, t.total_obtained, t.total_possible, t.subject_count)
    LIMIT 1;

    IF FOUND THEN
        RAISE EXCEPTION 'post-reconciliation assertion failed: published report card % (tenant %) still disagrees with its own snapshot (card: gpa %, total % of % over % subject(s); snapshot: gpa %, total % of % over % subject(s))',
            v_bad.id, v_bad.tenant_id,
            v_bad.gpa, v_bad.total_obtained, v_bad.total_possible, v_bad.subject_count,
            v_bad.snap_gpa, v_bad.snap_total_obtained, v_bad.snap_total_possible, v_bad.snap_subject_count;
    END IF;
END
$$;
