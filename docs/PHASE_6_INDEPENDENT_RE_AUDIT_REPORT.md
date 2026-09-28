PHASE 6 — INDEPENDENT RE-AUDIT REPORT (POST-0018)
===================================================

Date: Sat Sep 26 2026
Repo: G:\School Managment system
Branch: master
HEAD: 848c20fda26c4bd40d07467ba23d47f421e12f87 (unchanged by this audit)
Working tree: 151 pre-existing status entries, byte-identical to the baseline
captured at audit start (except for this report file, which is new).

VERDICT: **PHASE 6 NOT COMPLETE — GATE BLOCKED**

One confirmed P1 defect was found. Per the audit rules the audit was STOPPED at
that point and the defect was NOT fixed. Phase 7 was not started.


1) CONFIRMED DEFECT (P1) — migration 0018 cannot be applied to any database
   that already contains a published report card
-------------------------------------------------------------------

File: packages/db/migrations/0018_phase6_final_result_snapshot_integrity.sql

Relevant lines:
  441  CREATE OR REPLACE FUNCTION trg_report_card_subjects_validate()
  509  DROP TRIGGER IF EXISTS report_card_subjects_validate_trg ...
  510  CREATE TRIGGER report_card_subjects_validate_trg
  512      BEFORE INSERT OR UPDATE OR DELETE ON report_card_subjects
  527  INSERT INTO report_card_subjects ( ... ) SELECT ... FROM report_cards rc ...

Mechanism
  * Line 510 creates the freeze trigger BEFORE the backfill at line 527.
  * The backfill selects `FROM report_cards rc ... WHERE rc.deleted_at IS NULL`
    with NO status filter, so it necessarily includes rows whose status is
    'published'.
  * trg_report_card_subjects_validate refuses any INSERT whose owning report
    card is published, raising:
        SQLSTATE 55000
        "a published report card's subject lines are frozen:
         supersede the result with a new version"
  * Therefore the migration aborts on the FIRST published report card that has
    at least one matching mark. The migration cannot complete.

The migration's own comment (lines 514-526) states the intent:
    "It is written through the SAME immutability rules as any other line - the
     validate trigger above is deliberately not lifted for it - which makes the
     backfill a live self-check of those rules: a line that named a foreign
     exam, or failed to copy its max_marks, would abort the migration rather
     than be grandfathered in."

The intent was to reject MALFORMED rows. The actual effect is to reject ALL
published cards, including entirely well-formed ones, because "published cards
are frozen" is a correct rule for ordinary runtime writes but cannot also apply
to the one-time backfill that is supposed to populate those very cards.

Minimal reproduction (school_saas_test, 0018 applied, every statement rolled
back; backfill statement copied verbatim from lines 527-550 and scoped to a
single tenant so unrelated rows cannot interfere):

  BF.1  tenant whose only card is a DRAFT
         -> backfill SUCCEEDS
  BF.2  tenant with a PUBLISHED card that has no lines yet
         -> backfill ABORTS
            55000: a published report card's subject lines are frozen:
                   supersede the result with a new version
  BF.3  the IDENTICAL statement, with report_card_subjects_validate_trg
        disabled in the same transaction
         -> backfill SUCCEEDS

BF.3 isolates the cause: the freeze trigger is the sole blocker. The published
card in BF.2 deliberately had zero lines, so the unique index
report_card_subjects_line_uq cannot be a confound.

Impact
  * Any environment that has actually used Phase 6 report cards cannot be
    migrated to 0018. The migration is a hard prerequisite for the feature it
    ships, so this blocks the rollout of the very feature being remediated.
  * school_saas_dev currently holds 0 report_cards, so applying 0018 to dev
    today would succeed — but only because Phase 6 report cards have never been
    created there. The backfill has therefore never been exercised against
    realistic data in ANY environment, including school_saas_test, which reached
    0018 while containing no report cards.
  * Consequently the statement in
    docs/PHASE_6_FINAL_BLOCKER_REMEDIATION_REPORT.md §2 — "Backfilled existing
    cards from marks, reconciled aggregates" — is unverified, and false for any
    database containing published cards.
  * Whether a deployed environment already holds published report cards was NOT
    determined; it is outside the reach of the databases available here.

Remediation options — NOT APPLIED, recorded for the owner only
  1. Keep the stated self-check intent but scope it: run the backfill with the
     freeze rule lifted, while a SEPARATE ownership/max_marks self-check
     trigger remains active for the duration of the backfill. This preserves
     what the comment says the backfill is for.
  2. Move the backfill BEFORE the freeze trigger is created, then create the
     trigger. Simpler, but loses the "live self-check" property entirely.
  Either way this needs a new migration (0019), or an amended 0018 if 0018 has
  not shipped to any environment that matters.


2) VERIFIED SOUND (no defect found)
----------------------------------
All probes ran against school_saas_test with isolated per-tenant fixtures that
were torn down afterwards. Counts are real committed/rolled-back assertions,
not smoke tests.

  Publication marker forgery (school_app_rw and even table owner)
    forged marker/value/identity/soft-delete writes ....... rejected
    legitimate publication stamps + locks every mark ....... pass
    sibling exam unaffected by the lock ..................... pass
    runtime DELETE affects 0 rows (privileged-only) ........ pass
    attempted status downgrade forced back to 'locked' ..... pass
                                                                 8/8 + 21/23
    (2 of the 21/23 were defects in the probe itself, resolved by a 9/9 follow-up)

  Report-card snapshot ownership
    cross-exam line, cross-tenant line, fabricated max_marks/weight,
    duplicate line, identity re-homing ..................... all rejected 10/10

  Totals and coherence
    fn_report_card_totals deterministic ..................... pass
    incoherent publication fails at real COMMIT ............ pass
    SET CONSTRAINTS ALL IMMEDIATE exposes the violation .... pass  8/8

  Published snapshot freeze
    every line field, identity, insert/delete, aggregate,
    exam ownership and enrollment ownership ................ frozen  24/24

  Correction lifecycle, end to end through the REAL API correctMark() and the
  REAL worker handler (not reimplemented SQL)
    draft v1 -> publish -> freeze ......................... pass
    redelivered compute is a no-op, no duplicate version ... pass
    correction recorded, v1 snapshot NOT mutated ........... pass
    recompute mints v2 carrying the corrected mark ......... pass
    second correction mints v3, v1 and v2 intact ........... pass
    sibling exam never contributes to any version .......... pass
    worker PDF agrees with the stored snapshot ............. pass       8/8

  Worker cross-exam isolation (B3)
    the exam_id predicate in loadCandidateLines is present in SQL and is
    load-bearing: removing it demonstrably pulls the sibling exam's subject
    into the card (5 rows vs 3) ......................... pass  5/5
    no JS array .filter() is used as a security boundary in any
    Phase 6 worker or API query ........................... confirmed by
    exhaustive enumeration of every .from() in the worker

  RLS / FORCE RLS / tenant isolation
    bare school_app_rw sees 0 rows in all 9 Phase 6 tables . 9/9
    legacy forgeable GUCs (app.tenant_id, app.tenant,
      app.user_id) grant nothing .......................... 3/3
    tenant A never sees tenant B rows, by scan or by id ... 9 + 4
    cross-tenant UPDATE affects 0 rows ..................... 3/3
    cross-tenant INSERT rejected .......................... 4/4
    app_ctx_mint refuses a (user, tenant) pair with no
      active membership ................................... pass 35/35

  Grading scale integrity
    missing / out-of-range gradePoint rejected; gaps,
    overlaps, wrong start, wrong end, duplicate labels,
    >12 bands all rejected; code and version immutable;
    active bands frozen; one active version per code;
    pinned scale cannot be deleted; draft exam with no marks
    may be repinned; scheduled exam WITH marks may not;
    grading/published exam may not; inactive and deleted
    scales cannot be pinned; cross-tenant scale pin rejected;
    an inactive but PINNED scale still grades (historical
    usability) and its bands stay frozen ................... all pass
    cross-tenant grade resolution: tenant A asking to grade
    tenant B's exam never receives B's bands, verified with
    a signature band unique to B, both as migrator and as
    school_app_rw .......................................... 8/8

  Exam lifecycle matrix + report-card deletion
    all 20 from->to transitions behave as documented
      (draft->scheduled/grading/cancelled; scheduled->
      published/grading/cancelled; grading->published/
      cancelled; everything out of published refused)
    publication requires >=1 subject and a published_at .. pass
    a published exam cannot be renamed, retyped, retermed,
      repinned, re-dated, downgraded, cancelled, or
      soft-deleted while it has results .................... pass
    a published exam with NO results CAN be soft-deleted
      (documented, deliberate contract) ................... pass
    published exam_subjects frozen: max_marks, weight,
      subject re-point, removal, addition .................. pass
    draft report card may be edited and soft-deleted;
      published card may not be soft-deleted, downgraded,
      re-aggregated, re-versioned, re-pointed, and its lines
      can be neither hard-deleted nor added to ............ pass
    publishing a card whose aggregates disagree with its
      own lines is refused at COMMIT (deferred constraint
      trigger, confirmed via SET CONSTRAINTS ALL IMMEDIATE) . pass
    a newer draft version may be minted beside a published
      one; a second concurrent draft and a duplicate version
      number are both refused ............................. pass 57/57

Two findings that LOOKED like defects during this audit and were shown to be
probe errors, recorded so they are not re-investigated:
  * "a published report card's lines are not frozen" — the probe's own
    publication had been rolled back, so the card was still a draft.
  * "a scheduled exam with marks can be repinned" — the earlier repin had been
    rolled back, so the probe re-pinned the scale to the value it already had,
    which is correctly a no-op.


3) AUDIT INTEGRITY
------------------
  * No implementation file was modified. No migration was edited. No
    configuration was changed. Nothing was committed.
  * One temporary probe file was created inside the repository during the
    work (apps/worker/src/audit-probe-tmp.test.ts) to exercise the real API
    and worker correction path. It has been DELETED; `git status` shows no
    trace of it. The only file this audit adds to the repository is this
    report.
  * All probe scripts and the baseline snapshots live outside the repository
    in C:\Users\user\AppData\Local\Temp\opencode\audit6.
  * school_saas_dev: NOT MODIFIED. Read-only inspection only. Confirmed still
    at 0016_phase6_result_integrity_fixes.sql with 59 tables and 0
    report_cards.
  * school_saas_test: still at 0018. Every fixture tenant created by this
    audit has been removed (0 tenants remain), all Phase 6 triggers are
    re-enabled (0 disabled), and the migration journal is unchanged.
  * Working tree verified byte-identical to the 151-entry baseline.


4) DELIBERATELY NOT COMPLETED
-----------------------------
The audit was stopped at the confirmed defect, as required. The following were
therefore NOT performed and must not be read as passing:

  * the required DB Phase 6 security suite
  * the required API Phase 6 acceptance suite
  * the required worker exam and result-pipeline suites
  * typecheck, build, and full regression runs
  * the second clean run for repeatability
  * the test-harness review

None of these can change the verdict: the gate is already blocked by a
migration that cannot be applied to a database holding published report cards.


5) WHAT IS NEEDED TO UNBLOCK
----------------------------
  1. Decide between the two remediation options in §1 and implement them in a
     new migration (0019), or amend 0018 if it has not shipped.
  2. Prove the fix on a database that actually contains published report cards
     with marks. Neither school_saas_dev nor school_saas_test currently does,
     which is precisely why this defect survived the original remediation. A
     fixture with at least one published card and one mark is required, and it
     must be created BEFORE the migration is applied.
  3. Re-run this audit end to end, including the suites listed in §4.
