# Phase 6 — Independent Final Re-Audit (Round 3)

**Auditor:** independent re-audit, no implementation changes
**Date:** 2026-09-27
**Subject:** Phase 6 (exams, results, report cards) and the Phase 6 security gate
**Baseline:** [`PHASE_6_INDEPENDENT_FINAL_RE_AUDIT_REPORT_R2.md`](./PHASE_6_INDEPENDENT_FINAL_RE_AUDIT_REPORT_R2.md)
**Verdict: `GO WITH CONDITIONS`**

All four R2 findings (P2-1, P2-2, P3-1, P3-2) are **technically closed and independently verified by
execution**. The one condition is **P2-3, provenance**, which is *not* closed and cannot be closed by
code: HEAD cannot run the Phase 6 gate at all, and the staged set is not a buildable snapshot.

A second pass over an externally supplied checklist then re-derived all six central proofs, the RLS and
cross-tenant boundary and F-01 **directly in SQL** — 66/66 checks, without the test suite — and closed
two loose ends from the first pass. It added three new conditions: **C5** (a test fixture commits its
trigger disables, §14.2), **C6** (derived mark fields are silently overwritten rather than rejected,
§9.1), and a widened **C4**. It also **withdrew** this report's own D1 correction after proving the
remediation report right (§6.1a, §17).

---

## 1. Scope and method

Every claim below was re-derived by executing the real gate, the real migration runner, the real
suites and the real database. No prior report was used as evidence for any finding; the remediation
reports were read only afterwards, in §17, to test their accuracy.

Audit constraints observed throughout:

- **No implementation, migration, test, CI, application or report changes.** The only file this audit
  creates is this report.
- **No Git mutation.** No stage, unstage, reset, checkout, clean, stash or commit. The index was
  already staged when the audit began and is bit-for-bit identical at the end (§2.3).
- **No writes to `school_saas_dev`.** All destructive work used the disposable `school_saas_test`,
  with restoration verified in a `finally` path and again at the end (§3).
- **The historical R2 report and both remediation reports were not edited.**

Destructive or state-changing probes used in this audit, and their restoration:

| Probe | Scope | Restoration |
| --- | --- | --- |
| Migration CLI A/B/C + dependency closure | `school_saas_test` (schema dropped/rebuilt) | real migration chain re-applied, verified at `0019` |
| P2-2 role matrix | **new** disposable cluster on port 55440 | `pg_ctl stop`, data dir removed, 0 listeners left |
| P3-1 enable-state matrix | `school_saas_test`, one transaction | `ROLLBACK`, zero rows, trigger re-verified `'O'` |
| P3-1a extended matrix (`'R'`, second trigger) | `school_saas_test`, one transaction | `ROLLBACK`, both triggers re-verified `'O'`, 0 disabled |
| Guarded-migration atomicity | `school_saas_test` | real chain re-applied; synthetic journal row deleted |
| P3-2 counterfactual (×2) | `school_saas_test` trigger enable-state | `trap`-guarded restore, suite re-run green |
| **Direct SQL A–F + RLS + F-01 (66 checks)** | `school_saas_test`, **committed** fixture (the runtime role is a separate connection) | dedicated cleanup probe, children-first, 20 tables re-verified at 0 rows |
| Derived-field probe | `school_saas_test`, `ROLLBACK` | 0 tenants / 0 exams / 0 marks after rollback |
| Transactional trigger-safety (×2 paths) | `school_saas_test` trigger enable-state | both paths re-enabled, 0 disabled across `public` |
| Fail-unsafe teardown reproduction | `school_saas_test` trigger enable-state | all 4 guards re-enabled, 0 disabled, journal 19 |
| `exam_subjects` reachability | `school_saas_test`, **committed** fixture | children-first cleanup, 20 tables re-verified at 0 rows |
| Stable function-identity tie-breaker | read-only | none needed |
| Schema fingerprint | read-only | none needed |

Two auditor-created defects were found and fixed during the audit itself, and are disclosed because
they are the kind of thing that invalidates an audit. **Five were found in total**; the three added
after the first draft of this report (items 3–5) came from the post-checklist re-verification:

1. **Residue introduced and removed.** The atomicity probe (§6.2) applied a *synthetic* migration
   named `0018_audit_r3_guarded_then_fails.sql`, which wrote a row into `schema_migrations`. The
   probe's restore step re-ran the real migrations but, correctly, did not delete a row it did not
   know about. It was detected, deleted, and the journal re-verified at exactly 19 rows with latest
   `0019`. **Lesson: restoring a migration chain is not the same as restoring a journal.**
2. **An over-broad verification query of my own** (`proname like 'trg_%'`, unescaped `_`) initially
   appeared to show 16 unpinned functions. Re-running inside the test's real scope
   (`trg\_%`/`fn\_%`) showed **41 of 41 pinned**. The apparent finding was my query, not the schema.
3. **Committed tenant residue from four crashed probe iterations.** The direct-SQL probe of §9.1
   commits its fixture, because the runtime role is a *separate connection* and cannot see another
   connection's uncommitted rows. Four iterations of that probe died mid-run (two authoring errors and
   one `SAVEPOINT can only be used in transaction blocks` error raised after the fixture had already
   committed), each leaving one tenant behind. All four were found and deleted with a dedicated
   cleanup probe, and an independent verification pass returned all 20 audited tables to 0 rows,
   0 disabled triggers and 19 migrations. **Lesson: a committed fixture needs its own cleanup path and
   its own residue assertion, not a `ROLLBACK`.**
4. **A wrong conclusion from a fixture artifact.** The §17.1 examination of `exam_subjects` deletion
   first reported "the runtime role sees 0 rows" while using an *uncommitted* fixture, which would
   have implied a broken SELECT policy. The same probe showed `exams` at 0 as well, which identified
   the cause as cross-connection isolation rather than RLS. See §17.1 for the corrected result.
5. **Three false positives in the widened banned-pattern sweep**, from banning `SET ROLE`, `BYPASSRLS`
   and `DROP SCHEMA` as bare substrings. Each occurrence turned out to be a *negative* security test,
   a comment, or an intentional rebuild site. The sweep was changed to classify by context and to allow
   the two named rebuild sites. **Lesson: a banned-pattern check that has not been shown to be able to
   pass will always find something, and that something will usually be a test asserting the rule.**

---

## 2. Repository state

### 2.1 HEAD

| | |
| --- | --- |
| Repository | `G:\School Managment system` |
| Branch | `master` |
| HEAD | `848c20fda26c4bd40d07467ba23d47f421e12f87` |
| Subject | *feat: complete phase 2a security foundation* |
| HEAD at audit start | `848c20fda26c4bd40d07467ba23d47f421e12f87` |
| HEAD at audit end | `848c20fda26c4bd40d07467ba23d47f421e12f87` — **unchanged** |
| Commits created | **0** |

### 2.2 Working-tree census (identical at start and end)

| Measure | Count |
| --- | --- |
| Staged paths | **17** (16 added, 1 modified) |
| Unstaged tracked modifications | **50** |
| Untracked files | **178** at audit start; **179** at audit end, the difference being this report |
| Arithmetic total delta | **245** |

The staged 17 are the Phase 6 remediation's own files: the gate workflow, the three Phase 6 suites,
the four runtime-harness files, the runtime-db unit test, the two new vitest configs, migrations
`0016`–`0019`, and `packages/db/vitest.config.ts` (modified). No `.md`, `docs/`, audit report,
Phase 5 or earlier report, `apps/web`, route/plugin/handler work, or migration below `0016` is staged.

### 2.3 What HEAD actually contains

`git archive HEAD` was extracted read-only (136 files) and inspected.

| Expected by the gate | In HEAD |
| --- | --- |
| `.github/workflows/phase6-security.yml` | **absent** — no `.github` directory at all |
| Migrations `0003`–`0019` | **absent** — only `0001`, `0002` |
| `packages/db/src/security/phase6-*.test.ts` | **absent** — only `impersonation-boundary.test.ts`, `trust-boundary.test.ts` |
| `packages/db/src/testing/*` runtime harness | **absent** |
| School routes wired into the app | **absent** — HEAD's `apps/api/src/app.ts` contains **0** occurrences of `school`; the working tree has **31** |
| A migration CLI that applies migrations | **broken** — see below |

**HEAD's `pnpm db:migrate` is a silent no-op.** `packages/db/src/cli/paths.ts` in HEAD exports
`isMainModule()` with **no parameter**, comparing `process.argv[1]` against *paths.ts's own*
`import.meta.url`. Since `argv[1]` is `.../cli/migrate.ts`, the comparison can never be true, so the
CLI body in `migrate.ts` never runs: it exits 0 having applied nothing. Reproduced:

```
HEAD  isMainModule()                     -> false   (CLI body never runs: silent no-op, exit 0)
WORKTREE isMainModule(import.meta.url)   -> true    (CLI body runs)
```

This is precisely the defect the workflow's *"Migration CLI applies every migration, then reports up
to date"* step exists to catch, and the fix lives in **two tracked-but-unstaged** files
(`packages/db/src/cli/paths.ts`, `packages/db/src/cli/migrate.ts`).

---

## 3. Database baselines

### 3.1 `school_saas_dev` — read-only, unchanged

| Dimension | Baseline at audit start | At audit end |
| --- | --- | --- |
| Migrations | 16, latest `0016_phase6_result_integrity_fixes.sql` | **identical** |
| Tables | 59 | 59 |
| Columns | 584 | 584 |
| Constraints | 719 | 719 |
| Indexes | 240 | 240 |
| Functions | 325 | 325 |
| Triggers | 33 | 33 |
| **Disabled triggers** | **0** | **0** |
| RLS enabled / forced | 58 / 58 | 58 / 58 |
| Policies | 209 | 209 |
| Row counts | 13 tenants, 254 users, 30 students, 15 enrollments, 113 outbox | unchanged |

Dev is byte-identical in shape to its baseline and its migration list still ends at `0016` — i.e. dev
sits at the pre-Phase-6-remediation state and was never advanced. No dev write occurred at any point
in this audit.

### 3.2 `school_saas_test` — disposable, restored

| Dimension | Final state |
| --- | --- |
| Migrations | 19, latest `0019_phase6_report_card_snapshot_reconciliation.sql` |
| Tables / columns / constraints / indexes | 60 / 599 / 744 / 247 |
| Functions / triggers | 332 / 38 |
| **Disabled triggers** | **0** |
| RLS enabled / forced | 59 / 59 |
| Policies | 213 |
| Row counts | **0 in every table** |
| Stray schemas (`audit_shadow_*`) | **none** |
| Synthetic journal rows | **0** |

The seven `audit_shadow_*` schemas reported in earlier rounds are **absent** and were not recreated by
any probe in this audit. They are auditor search-path residue, not repository or harness output, and
they never affected `school_saas_dev`.

---

## 4. P2-1 — destructive suite in the parallel default run: **CLOSED, verified**

**Source.** `.github/workflows/phase6-security.yml` sets `RUN_RUNTIME_SECURITY_TESTS: '1'` on the four
gate steps only (workflow lines 212–231). The `Default test suite` step runs `pnpm test` with the
variable **unset**, and a comment at the job level states the variable is deliberately not set there.

**The hazard, characterised precisely.** The hazard is real and now measured: all three packages point
`DATABASE_URL_TEST` at the **same** disposable database, and
`packages/db/src/security/phase6-migration-regression.test.ts` executes
`drop schema public cascade` (lines 251–252, 263–264). Under `turbo run test`, package suites run in
**parallel**. So with the variable set globally, the regression suite rebuilds the database while the
API and worker suites are asserting against fixtures inside it.

**Execution.**

| Run | Command | Result |
| --- | --- | --- |
| 1 | `RUN_RUNTIME_SECURITY_TESTS` unset, `turbo run test --force` | **8/8 tasks**, exit 0, 0 cached, 53.2 s |
| 2 | same | **8/8 tasks**, exit 0, 0 cached, 54.5 s |
| both | DB-backed skip counts | `@sms/db` 22 passed / **308 skipped**, `@sms/api` 52 / **397**, `@sms/worker` 16 / **74** = **779 skipped** |
| both | `phase6-migration-regression.test.ts` | `↓ 5 tests \| 5 skipped` — **never executed** |
| both | all three Phase 6 suites | `↓ 87 \| 87 skipped`, `↓ 35 \| 35 skipped`, `↓ 13 \| 13 skipped` |

The schema-dropping suite does not run at all in the default step. **P2-1 is closed**, and the CI gate
as written cannot reach the race.

**See §8.3** for the residual hazard this leaves behind.

---

## 5. P2-2 — vacuous RLS role assertion: **CLOSED, verified**

**Source.** The workflow's heredoc SQL, extracted **verbatim from the file** by script (not
transcribed) and executed against a **new** disposable cluster on port 55440. The real cluster was
never contacted. The step's shell preamble was confirmed in the same file: `set -euo pipefail` and
`psql -v ON_ERROR_STOP=1`, so a `RAISE EXCEPTION` becomes a non-zero exit.

**Execution — 5 cases × 2 roles, 10/10 pass:**

| Case | `school_app_rw` | `school_migrator` |
| --- | --- | --- |
| A. valid least-privilege role | exit 0 | exit 0 |
| B. role granted `BYPASSRLS` | **non-zero** — `fail-closed: … has BYPASSRLS, so it bypasses RLS and the isolation suites prove nothing` | same |
| C. `BYPASSRLS` revoked | exit 0 | exit 0 |
| D. role elevated to `SUPERUSER` | **non-zero** — `fail-closed: … is SUPERUSER, so it bypasses RLS…` | same |
| E. role missing entirely | **non-zero** — `fail-closed: role … does not exist, so every RLS assertion in this workflow would be vacuous` | same |

**The P2-2 defect reproduced.** Against the same `BYPASSRLS` role, the old query form printed
`FAIL: runtime role can bypass RLS` and **exited 0** — a loud message that a CI step reads as success.
The new assertion refuses instead of reporting.

Final disposable role state was `school_app_rw|f|f`, `school_migrator|f|f` (no superuser, no bypassrls,
no createdb); cluster stopped, data dir removed, **0 listeners left on 55440**.

---

## 6. P3-1 — migration that restored a trigger it never checked: **CLOSED, verified**

### 6.1 Enable-state matrix

**Source.** `0018_phase6_final_result_snapshot_integrity.sql` lines 773–822: the card-level
`ALTER TABLE … ENABLE TRIGGER`, then a `DO` block reading
`tgenabled … WHERE tgrelid='report_cards'::regclass AND tgname='report_cards_validate_trg'` and
refusing anything `IS DISTINCT FROM 'O'`, reporting `coalesce(…, 'absent')`.

**Execution**, against the real `school_saas_test`, inside one transaction that is always rolled back.
The assertion text was copied verbatim from the migration.

| Trigger state | Result |
| --- | --- |
| `'D'` (left disabled) | **refused** — `post-repair assertion failed: report_cards_validate_trg must be enabled (tgenabled='O'), found D` |
| `'A'` (`ENABLE ALWAYS`) | **refused** — `… found A` |
| absent (dropped) | **refused** — `… found absent` |
| `'O'` | **accepted**, `tgenabled` reads `O` |

`absent` is refused by the same `IS DISTINCT FROM`, because a trigger that cannot be found cannot be
shown to be enabled. 11/11 checks passed, **zero residue** (8 tables verified at 0 rows after
rollback), and the live schema trigger re-verified `'O'`.

### 6.1a The matrix was then widened: `'R'` and the second trigger

The first pass above covered `report_cards_validate_trg` and three of the four states. Two gaps were
closed by a second probe against the **same verbatim assertion text**, this time for
`report_card_subjects_freeze_trg` (also lifted and restored by `0018`/`0019`) and including the
`'R'` state that the first pass had not exercised:

| `tgenabled` | Meaning | `report_card_subjects_freeze_trg` | `report_card_subjects_validate_trg` |
| --- | --- | --- | --- |
| `'O'` | `ENABLE TRIGGER` (origin) | **accepted** | **accepted** |
| `'D'` | `DISABLE TRIGGER` | **refused** — `… found D` | **refused** |
| `'R'` | `ENABLE REPLICA TRIGGER` | **refused** — `… found R` | **refused** |
| `'A'` | `ENABLE ALWAYS TRIGGER` | **refused** — `… found A` | **refused** |
| absent | trigger dropped | **refused** — `… found absent` | **refused** |

`'R'` is the state that makes this more than a formality: under `ENABLE REPLICA TRIGGER` the trigger
still exists and still fires for the table owner, so a check that only asked "does the trigger exist"
would pass while the guard is inert for replica traffic. The assertion is a strict
`IS DISTINCT FROM 'O'`, so it refuses it. All states proven; after `ROLLBACK` both triggers read
`'O'`, 0 triggers disabled across `public`, migration journal unchanged at 19.


**The hole is real.** With the guard at `'D'`, the same aggregate rewrite of a **published** card was
no longer refused by the immutability rule; the only thing that stopped it was an *independent* rule
(the deferred snapshot-coherence trigger). With the guard restored, the identical statement is refused
outright: `a published report card is immutable`. So the assertion protects a genuinely load-bearing
guard — and, per §7.2, that guard is load-bearing in **three** places.

### 6.2 Guarded-migration atomicity

**Source.** `applyMigrations()` in `packages/db/src/cli/migrate.ts` wraps every file in
`begin` / `commit`, with `rollback` and a wrapping `Error` on failure (lines 42–51).

**Execution.** A synthetic migration was staged that lifts the guard exactly as `0018`/`0019` do and
then fails:

```
Migration 0018_audit_r3_guarded_then_fails.sql failed: relation "a_relation_that_does_not_exist" does not exist
tgenabled is still 'O' after the failure (the trigger lift was rolled back)
```

The `DISABLE TRIGGER` is rolled back with the migration, so a *failing* migration cannot leave the
guard off; the assertion is a backstop, not the primary mechanism. The repaired variant (lift →
restore, no assertion) applied and left `tgenabled='O'`.

All four `DISABLE TRIGGER` sites across `0018` and `0019` are paired with an `ENABLE` **and** a
fail-closed post-assertion requiring `tgenabled = 'O'`:

| File | Line | Lift | Re-enable | Post-assertion |
| --- | --- | --- | --- | --- |
| `0018` | 632 | `report_card_subjects_freeze_trg` | 665 | 688 (`v_validate`), 693 (`v_freeze`) |
| `0018` | 773 | `report_cards_validate_trg` | 798 | 820 (`v_card_guard`) |
| `0019` | 80 | `report_card_subjects_freeze_trg` | 161 | 182, 187 |
| `0019` | 209 | `report_cards_validate_trg` | 231 | 255 (`v_guard`) |

---

## 7. P3-2 — assertions that never reached the code they claimed to test: **CLOSED, verified**

### 7.1 The count is **2**, and the report is right

The claim concerns **`report_cards_snapshot_coherent_trg`**, the `DEFERRABLE INITIALLY DEFERRED`
snapshot-coherence trigger. Disabling it in `school_saas_test` and running
`src/security/phase6-exams.test.ts`:

| | |
| --- | --- |
| `tgenabled` during the run | `D` |
| Suite exit code | 1 |
| Result | **`Tests  2 failed \| 85 passed (87)`** |
| Failing test 1 | `F. report cards > 2. one live draft per (exam, student), but a new VERSION is allowed` |
| Failing test 2 | `H. … > P2-03 a published report card cannot be hard-deleted > refuses it for the table owner AND for the runtime role` |
| After restore | `tgenabled=O`, **`Tests  87 passed (87)`**, exit 0 |

The two repaired assertions live in exactly those two tests — line 1568
(`a publication that disagrees with its own snapshot must not COMMIT`, inside F.2) and line 3036
(`a published card with no snapshot rows must be refused at COMMIT`, inside P2-03) — and **nothing
else fails**. The counterfactual is exactly as claimed.

### 7.2 Correction to a number the reports imply, about a *different* trigger

Running the same counterfactual against the **P3-1** trigger `report_cards_validate_trg` fails
**three** tests, not two:

| Failing test | Why it depends on this trigger |
| --- | --- |
| `F.1 a card is generated only while the exam is grading or published` | the trigger is `BEFORE INSERT **OR UPDATE**` (0015 line 1213), so it also guards generation; with it off the INSERT succeeds |
| `F.3 a PUBLISHED card is a frozen snapshot…` | the immutability assertion itself |
| `F.4 a card may only be published with its exam, and needs a publication stamp` | asserts `55000`; with the guard off the weaker `report_cards_published_at_ck` fires first with `23514` |

The suite returned to **87/87** on restore. This is **not** a defect — it means the P3-1 guard is
load-bearing in three places, which strengthens §6. It is recorded because a reader of the reports
would otherwise expect two.

---

## 8. The Phase 6 security suites

### 8.1 The four gate steps, run twice each

| Gate suite | Pass 1 | Pass 2 |
| --- | --- | --- |
| `phase6-migration-regression.test.ts` | **5/5** | **5/5** |
| `phase6-exams.test.ts` (DB security) | **87/87** | **87/87** |
| `phase6-exams-acceptance.acceptance.test.ts` (API) | **35/35** | **35/35** |
| `exams-result-pipeline.test.ts` (worker) | **13/13** | **13/13** |

### 8.2 Full package suites, run twice each

Run **per package**, sequentially, with the variable set:

| Package | Pass 1 | Pass 2 |
| --- | --- | --- |
| `@sms/db` | **330/330** (19 files) | **330/330** |
| `@sms/api` | **449/449** (21 files) | **449/449** |
| `@sms/worker` | **90/90** (6 files) | **90/90** |

### 8.3 New finding: the full suite is **not** safe in parallel with the variable set globally

`RUN_RUNTIME_SECURITY_TESTS=1 pnpm turbo run test --force` **fails, nondeterministically**:

| Run | Result |
| --- | --- |
| 1 | `Tasks: 5 successful, 8 total`; worker `2 failed \| 75 passed \| 13 skipped` |
| 2 | `Tasks: 5 successful, 8 total`; worker `3 failed \| 87 passed` |
| detailed | `@sms/db` migration regression: **5 failed** — `Migration 0014_attendance_leave.sql failed: deadlock detected`; `@sms/api` acceptance: **27 of 35 failed** — `Invalid uuid` for `examId` / `examTypeId` / `gradingScaleId`; `@sms/worker` `outbox-integration.test.ts`: **5 failed** |

The mechanism is the one characterised in §4: one shared disposable database, a suite that drops the
schema, three packages asserting concurrently. The `Invalid uuid` failures are the signature of a
tenant's fixture rows being destroyed mid-assertion; the deadlock is the migrator colliding with
concurrent writers.

**This does not affect the gate as written** — the four gate steps are sequential, and the default
`pnpm test` step has the variable unset, so CI cannot reach it. It is a latent hazard for anyone who
sets the variable globally, and it is why P2-1's fix (removing the variable from the parallel step)
was necessary rather than cosmetic. **Condition C2.**

---

## 9. Central integrity proofs (DB suite, `phase6-exams.test.ts`)

87/87 pass. Coverage mapped to the R2 proof obligations by reading each test's title and its passing
result:

| Proof | Group | Tests | Result |
| --- | --- | --- | --- |
| A. RLS boundary | `A. row-level security boundary` | 11 | pass |
| B. grading-scale integrity | `B. grading scale integrity (versioned bands)` | 4 | pass |
| C. one-way exam lifecycle | `C. exam lifecycle is one-way and terminal once published` | 7 | pass |
| D. exam subjects / schedules | `D. exam subjects and schedules` | 4 | pass |
| E. marks: bounds, derivation, publish freeze | `E. marks: bounds, derivation and the publish freeze` | 9 | pass |
| F. report cards | `F. report cards` | 5 | pass |

The suite additionally pins the earlier findings as named regressions: F-03, F-04, F-06, F-07, F-08,
P1-01 (7), P1-02 (2), P2-01 (3), P2-02 (2), P2-03 (2), P3-01 (1), P3-02 (3), P3-03 (1).

Two of these are load-bearing for this audit and were independently confirmed at the SQL level in §6:
the published-card immutability guard (`F.3`) and the COMMIT-time snapshot-coherence rule (`F.2`).

### 9.1 The six proofs re-derived directly in SQL, independent of the suite

Reading a passing test is weaker evidence than issuing the statement yourself, so all six proofs were
re-derived against the live database by a purpose-written probe that never calls application code or
test helpers: **66 checks, 66 pass, 0 fail**, ending with zero residue, 0 disabled triggers and the
migration journal intact at 19 (`0019_phase6_report_card_snapshot_reconciliation.sql`).

| Proof | Established directly in SQL |
| --- | --- |
| A | All 8 new tables have RLS **enabled and forced**; `school_app_rw` is not SUPERUSER, not BYPASSRLS, not CREATEDB; with no context it sees 0 rows; a correctly signed context sees exactly its own 2 rows; a cross-tenant context sees 0 of them, by name and in bulk; cross-tenant UPDATE/DELETE affect 0 rows |
| B | A grading scale cannot be edited, cannot be deleted while referenced (`exams_scale_fk`), cannot be soft-deleted while `is_active`; a band set that does not reach 100 is refused; `exams.grading_scale_id` cannot be repointed |
| C | `published` requires a subject **and** a publication stamp; the transition is one-way (no regression out of `published`); the grading scale cannot be mutated once an exam is `grading`; soft delete of a non-draft exam is refused |
| D | No subject line may be attached to an exam already in `grading`; `max_marks` is frozen at grading; a section/subject mismatch is refused; a non-member cannot be attached |
| E | A mark outside `0..max_marks` is refused; **client-supplied `percentage`, `grade_label` and `grade_point` are silently overwritten with server-derived values**; publishing the exam freezes later edits and deletes; the correction ledger is append-only and a non-member cannot correct |
| F | A card must have at least one line and a publication stamp; once published the card and its lines are immutable and hard-delete is refused; a second card for the same `(exam, enrollment)` sees only its own lines and totals |

Proof F doubles as the direct proof of **F-01**: two cards for sibling exams of the same student were
built and each carried only its own subject lines and totals, so a sibling exam's lines cannot leak in.

Two honest qualifications on the SQL, both of which cut in the schema's favour but are worth stating
precisely rather than rounding up:

- **Cross-tenant INSERT** into `exam_subjects` is refused with `55000 … exam grading scale must be
  active`, i.e. it is stopped by a *trigger* before RLS's `WITH CHECK` is reached. The mutation is
  blocked either way, but the reason is not the one a reader might assume.
- **Derived mark fields are overwritten, not rejected.** Supplying `percentage = 99`, `grade_label =
  'Z'`, `grade_point = 4` for a mark of 50/100 stores `50.00 / B / 2.00`. A forged grade cannot
  survive, which is the security property that matters; but the client gets no error, so a caller that
  disagrees with the server's banding will not be told. This is recorded as an observation, not a
  defect.


---

## 10. RLS and cross-tenant isolation

Covered by group `A` and group `G` of the DB suite, all passing:

| Requirement | Test | Result |
| --- | --- | --- |
| RLS enabled **and** forced on all eight new tables | `A.1` | pass |
| Runtime role holds DML but sees zero rows without a context | `A.2` | pass |
| Tenant A sees its own rows, never tenant B | `A.4` | pass |
| Cross-tenant UPDATE of a snapshot touches zero rows | `A.4b` | pass |
| Cross-tenant INSERT of a snapshot line rejected by trigger **and** policy | `A.4c` | pass |
| Cross-tenant DELETE of a snapshot line rejected for every role | `A.4d` | pass |
| Cross-tenant INSERT rejected by RLS `WITH CHECK` | `A.5` | pass |
| Runtime role cannot hard-DELETE a mark or a published card | `A.6` | pass |
| Tenant B cannot see or touch tenant A's marks, cards or corrections | `G.1` | pass |
| Gradebook join returns tenant A rows with derived grades | `G.2` | pass |

Live schema agrees with the assertions: **59 tables with RLS enabled, 59 forced, 213 policies,
0 disabled triggers.**

---

## 11. F-01 and F-02 — producer/consumer verification

### F-02 (stale report card after a correction) — **closed, and the payload wording is accurate**

The remediation report and the code comment both claim the correction now enqueues a *recompute
command* in the same transaction. Verified in source and in execution:

| Producer — `apps/api/src/routes/school/exams.ts` | Consumer — `apps/worker/src/exams.ts` |
| --- | --- |
| `eventType: 'exam.result.compute'` | dispatched on `exam.result.compute` |
| `aggregateType: 'exam'`, `aggregateId: exam.id` | — |
| `payload: { tenantId, examId, actorUserId, reason: 'mark_corrected', correctionId, markId }` | `tenantIdOf()` reads `payload['tenantId']`, falling back to `event.tenantId` |
| enqueued with `tx` — the same transaction as the ledger row and the mark UPDATE | `examIdOf()` **requires** a string `payload['examId']` |
| comment: *"Context only: the worker re-reads the marks, it never trusts the payload."* | `actorOf()` reads the optional `payload['actorUserId']` |

The producer/consumer contract matches, and the `markId` / `correctionId` / `reason` fields are
explicitly documented as context the worker does not trust. The report's wording — that a published
correction previously enqueued the `result.corrected` *fact* but no recompute *command* — matches the
code comment that `result.corrected` "is a fact about the correction and had no handler that
recomputes". **No wording discrepancy found.**

### F-01 (sibling exam's subject lines leaking into a card)

Pinned by the API acceptance suite, which passes 35/35 twice:
`H. … > does not leak a sibling exam's subject lines into the card (F-01)` and
`> keeps the transcript scoped the same way (F-01)`. The worker handler re-reads the marks for the
specific `(exam, enrollment)` pair rather than trusting the card, which is the structural reason the
leak is closed.

---

## 12. Migration regression and its negative control

`phase6-migration-regression.test.ts`, 5/5 twice. Its five tests rebuild the disposable database from
nothing and re-prove the `0018`/`0019` backfill against a real pre-`0018` world.

**Negative control scope — correct and precisely bounded.** The control removes exactly one line from
the real `0018`:

```ts
const RESTORE_FREEZE =
  'ALTER TABLE report_card_subjects ENABLE TRIGGER report_card_subjects_freeze_trg;';
```

It first asserts that line **exists** in the real file (`expect(real18, '…must exist').toContain(…)`),
so the control cannot silently become a no-op, then requires the doctored migration to **abort** with
`post-backfill assertion failed` and `report_card_subjects_freeze_trg`, and finally verifies the
transaction rollback left nothing behind (the table `0018` created is gone, the backfilled rows went
with it, the journal never learned the file existed).

This is the right shape for a negative control: it fails if the defect is absent (because the line is
missing) *and* if the defect is present (because the doctored file then still migrates).

---

## 13. Migration CLI

All four cases executed against the **real** `applyMigrations()`:

| Case | Result |
| --- | --- |
| A. empty database | **19 applied**, 19 journal rows, latest `0019` |
| B. second run | **0 applied, 19 skipped**; CLI prints `migrations applied: (none) \| already applied: 19` and `database is already up to date` |
| C. broken migration (`0020_audit_r3_broken.sql`: `create table`, then a nonexistent relation) | throws `Migration 0020_audit_r3_broken.sql failed: relation "a_relation_that_does_not_exist" does not exist`; **0** partial table rows, **0** `0020` journal rows, total stayed 19 |
| restore | real chain re-applied, **19 / latest `0019` / 0 disabled triggers** |

The CLI's `process.exitCode = 1` on failure, combined with the workflow's
`set -euo pipefail` and `out="$(pnpm db:migrate)"`, makes case C fail the step. The gate's greps for
`migrations applied:` and `already applied:` match the CLI's actual output format.

**Proven dependency (§2.3):** on HEAD this same command applies **nothing** and exits 0, because
`isMainModule()` in HEAD's `paths.ts` takes no argument. The gate step would catch it — but only if
the gate existed, which on HEAD it does not.

---

## 14. Banned constructs

Scanned across `0015`–`0019`. **Zero occurrences** of any of:

| Pattern | Count |
| --- | --- |
| `drop table … cascade` | 0 |
| `drop schema` | 0 |
| `drop database` | 0 |
| `truncate` | 0 |
| `delete from` | 0 |
| `not valid` | 0 |
| `exception when` (swallowing) | 0 |
| `set role` | 0 |
| `alter table … disable row level security` | 0 |
| `alter table … no force row level security` | 0 |
| `pg_temp` / `pg_catalog.` / `format(%s` / `execute '` | 0 |
| `security definer` | 0 |

**Function `search_path` pinning (F-06).** Within the test's scope (`proname like 'trg\_%' or
'fn\_%'`): **41 functions, 41 pinned, 0 unpinned.** Verified against the catalog, not by reading the
migrations. The only `DISABLE TRIGGER` statements in `0018`/`0019` are the four paired, asserted lifts
in §6.2.

### 14.1 The sweep was widened to the whole Phase 6 tree, and the results qualified

§14 above scans only the five migrations, which is the easy half. A second sweep covered **134 files**:
the 5 migrations, 30 DB security suites, 10 harness files, 50 DB `src` files, 33 API school routes, 17
API security files, 13 worker files, 15 contracts/core files and the CI workflow.

Twelve patterns are absent everywhere: `.only`, `.skip`, `session_replication_role`,
`DISABLE TRIGGER ALL`, `TRUNCATE`, `ALTER TABLE … OWNER TO`, `pg_terminate_backend`, and
`NO FORCE ROW LEVEL SECURITY`. Three patterns needed **classification rather than a blanket ban**,
because the first sweep produced three false positives that would have been reported as findings:

| Pattern | Occurrences | Why it is not a finding |
| --- | --- | --- |
| `SET ROLE` | 4, all in `trust-boundary.test.ts` | the test asserts `school_app_rw` **cannot** `SET ROLE school_migrator` — a negative security test |
| `BYPASSRLS` | 12 | all are comments, `expect(src).not.toMatch(/BYPASSRLS/i)`, or the workflow's own fail-closed `DO` block that **raises** if the role has it |
| `DROP SCHEMA` | 2 files | confined to the two places where a from-scratch rebuild is the point: the migration regression suite and the workflow's migration-CLI step. The first is env-gated and the second is its own sequential step, so neither can run in the default `pnpm test`. This is the same operation that made **P2-1** real, so it is named rather than merely allowed. |

`RUN_RUNTIME_SECURITY_TESTS` appears in **39** files, all of them tests or the workflow; no production
code gates on it, and it is declared centrally in the testing harness rather than ad hoc per suite.

**Trigger restores.** All **25** named `DISABLE TRIGGER` statements across **7** distinct triggers are
paired with an `ENABLE` in the same file, and each of the four in `0018`/`0019` is followed by a
`tgenabled` post-assertion — SQL cannot use `try`/`finally`, so the post-assertion is the correct
mechanism there.

### 14.2 New low-severity finding: one fixture commits its trigger disable

The three other fixtures that lift guards do so safely, and this was **proved by execution** rather
than by reading: `ALTER TABLE … DISABLE TRIGGER` is transactional DDL, so a client killed mid-teardown
leaves the guard `'O'`, because the rollback undoes the DDL.

`apps/api/src/security/phase6-exams-acceptance.acceptance.test.ts` is the exception. It has **no
`BEGIN` and no `finally`**, so each of its four `disable trigger` statements **commits**. Its `step()`
helper catches per-statement errors and continues, so an ordinary throwing `DELETE` still reaches the
re-enables — but a process kill, a runner timeout or a `SIGKILL` inside that window leaves
`marks_delete_guard_trg`, `report_cards_hard_delete_guard_trg`,
`report_card_subjects_freeze_trg` and `mark_corrections_append_only_trg` **disabled and committed** in
the shared test database. Reproduced by killing a client mid-teardown: all four read `D` from a fresh
connection, where the transactional path reads `O`.

Nothing detects this afterwards. The `tgenabled` assertion is a **one-shot migration check** inside
`0018`/`0019`; both are already applied, so a later run re-applies nothing and re-asserts nothing. The
probe repaired the state and verified 0 disabled triggers.

**Severity: low.** It is a test fixture, not production code; the role that runs it is already the
schema owner and could `DROP TABLE` instead; and all four gate steps and both full-suite runs pass. It
is reported because a test harness that can silently weaken the database it is testing is the same
class of problem as P2-1, and because the fix is small (wrap the teardown in one transaction, as the
worker fixture already does).

---

## 15. Schema fingerprint

An earlier round's whole-catalog digest was **non-deterministic** across identical rebuilds. Root
cause isolated: the digest ordered functions by `proname` alone, and `public` contains **12
overloaded names**, all from `pgcrypto` — `pgp_pub_decrypt`, `pgp_pub_decrypt_bytea`, `armor`,
`digest`, `gen_salt`, `hmac`, `pgp_pub_encrypt`, `pgp_pub_encrypt_bytea`, `pgp_sym_decrypt`,
`pgp_sym_decrypt_bytea`, `pgp_sym_encrypt`, `pgp_sym_encrypt_bytea`. Ordering by name cannot
distinguish `digest(text,text)` from `digest(bytea,text)`, so the digest's *input string* varies.
**This was an auditor-probe defect, not a database integrity defect.**

A stable 11-dimension fingerprint (migrations, tables, columns, constraints, indexes, functions,
triggers, disabled triggers, RLS enabled, RLS forced, policies), each read twice:

| | `school_saas_test` | `school_saas_dev` |
| --- | --- | --- |
| migrations | 19 — stable | 16 — stable |
| tables | 60 — stable | 59 — stable |
| columns | 599 — stable | 584 — stable |
| constraints | 744 — stable | 719 — stable |
| indexes | 247 — stable | 240 — stable |
| functions | 332 — stable | 325 — stable |
| triggers | 38 — stable | 33 — stable |
| **disabled triggers** | **0 — stable** | **0 — stable** |
| RLS enabled / forced | 59 / 59 — stable | 58 / 58 — stable |
| policies | 213 — stable | 209 — stable |
| **stable sha256** | `fcc2d082d57289fa02fc9f8c0211ddb387a5f9d802f5f495e12bbf53bc25fbe8` | `bbd7c382fa7706666a8ed59e2f258a9e3c0cb85d37ade32bbe5ee4f0777f6b3b` |
| naive (unstable) digest | `336760a2e60db4028e605ad499345f4f` | `6d6afe2022d7208ab36bdf0eedbeafd0` |

All 11 dimensions are stable on both databases. Dev's stable digest is unchanged from its baseline.

### 15.1 The tie-breaker is `(proname, pg_get_function_identity_arguments(oid))`

The fix for the 12 overloaded names is not "sort by something else" but "sort by the pair that
Postgres itself uses to decide identity", and that was verified rather than assumed: ordering the
`public` schema by `(proname, pg_get_function_identity_arguments(oid))` and checking for duplicate
signatures returns **0 ambiguous identities** across **332 functions / 318 distinct names**. The 14
extra functions are exactly the overloads that broke the naive digest.

---

## 16. Typecheck and build

| Command | Result |
| --- | --- |
| `pnpm typecheck` | **17/17 tasks successful**, exit 0 |
| `pnpm turbo run build --force` | **3/3 tasks successful**, 0 cached, 54.0 s |

`turbo.json` emits a benign warning for three packages (`no output files found for task
@sms/{api,web,worker}#build`); it does not fail the task and is pre-existing.

---

## 17. Documentation accuracy

The reports were read **after** the independent work, and only to be tested. Four inaccuracies found,
one of which this audit has now **withdrawn** (D1). None is a code defect; all are in the remediation
report `PHASE_6_P2_P3_REMEDIATION_REPORT.md` or the cumulative `PHASE_6_REMEDIATION_REPORT.md`.

| # | Claim | Reality | Severity |
| --- | --- | --- | --- |
| D1 | P3-1 table: the third state is `'R'` (replica only), refused with `…found R` | **The remediation report is right and this audit's first pass was wrong.** An earlier draft of this section objected that `ENABLE ALWAYS` produces `'A'`, so `…found R` "cannot occur". That confuses the two ways of reaching a state: `'R'` is produced by `ENABLE REPLICA TRIGGER`, and re-testing against the verbatim assertion confirmed `'R'` **is** reachable and **is** refused with exactly `… found R` (§6.1a). `'A'` is a separate, also-refused state. | **withdrawn** |
| D2 | P3-1: "reporting `coalesce(state, 'absent')`" | the variable is `v_card_guard`, not `state` | cosmetic |
| D3 | P3-1/P3-2 present the card guard as backing "the two repaired assertions" | the P3-1 guard (`report_cards_validate_trg`, `BEFORE INSERT OR UPDATE`) is load-bearing in **three** tests — F.1, F.3, F.4 (§7.2). The "two" belongs to the **coherence** guard (P3-2), which is correct. The reports never conflate them explicitly, but the parallel structure invites the wrong inference. | minor |
| D4 | Cumulative report §7: the DB suite grew to **84** tests | it is now **87**. The 84 predates the P2/P3 remediation, and the addendum does not update the count. | minor |

### 17.1 An observation that was investigated and closed as **not a finding**

An early probe iteration reported that `DELETE FROM exam_subjects` was accepted while the parent exam
was in `grading`, which looked like a missing lifecycle guard on a table that otherwise refuses subject
changes at exactly that point. It was investigated to a conclusion and is recorded here because
"investigated and dismissed" is a result, and because the first reading was wrong.

Four mechanisms could have blocked that `DELETE`; all four were checked and three of them do:

| Mechanism | Finding |
| --- | --- |
| Trigger on `exam_subjects` | `exam_subjects_validate_trg` is `BEFORE INSERT OR UPDATE` **only**, so it does not fire on `DELETE`. It *is* load-bearing on the other two: in `grading`, an `UPDATE` of the line and the attachment of a new line are both refused with `exam subjects cannot be changed in status grading`. |
| Inbound FKs | all four (`exam_schedules`, `marks`, `mark_corrections`, `report_card_subjects`) are `ON DELETE NO ACTION`, so any line that already has results, a schedule, a correction or a card line cannot be removed either. |
| RLS | `exam_subjects_delete` is `USING (app_privileged())`, and `app_privileged()` is literally `current_user IN ('school_migrator')`. **The runtime role therefore cannot delete a subject line at all**, in any lifecycle state. Verified end-to-end: with a correctly signed tenant context the runtime role **sees** the row (`visible=1`) and the `DELETE` still returns `rowCount=0`, and the row survives. |
| Ownership | the schema owner *can* delete it — which is not a security boundary, since that role can equally `DROP TABLE`. |

**Conclusion: not app-reachable, and therefore not a finding.** The original observation was made
through the migrator connection, where "accepted" means the owner did something the owner is entitled
to do. The only accurate statement is the narrow one: `exam_subjects` has no `DELETE` guard of its own,
and is protected instead by RLS plus four `NO ACTION` foreign keys.

The first attempt at this probe also produced a **false** result of its own — it reported the runtime
role seeing 0 rows, which would have implied a broken `SELECT` policy — because the fixture was still
uncommitted on the migrator connection. The tell was that `exams` also read 0. Both are disclosed in
§1, item 4.

**Checked and found accurate** (no action):

- **F-02 payload wording** — matches the producer/consumer contract exactly (§11). No claim about
  payload keys contradicts the code.
- **Turbo/P2-1 step scoping** — the workflow really does set the variable on the four gate steps only,
  and the default `pnpm test` really does inherit it unset (§4).
- **0018/0019 snapshot design** — the addendum correctly supersedes §10's "deferred design decision"
  language. `report_card_subjects`, the deferred `report_cards_snapshot_coherent_trg` and the `0019`
  reconciliation all exist and are enforced; a card that disagrees with its own lines is refused at
  COMMIT (observed directly in §6.1, where a hand-built incoherent card was rejected with
  `a published report card must agree with its own subject snapshot`).
- **"Nothing was committed" / "HEAD unchanged"** — true throughout: `848c20f` at start and end.
- **"This staged set is provenance, not a working snapshot"** — correct, and stronger than the report
  claims (§18).

---

## 18. Clean checkout and P2-3: **NOT CLOSED**

This is the audit's one blocking condition. The remediation report states the staged set is
"provenance, not a working snapshot, and the reason is structural rather than avoidable". Verified,
and the scope is **larger** than the report records.

A transitive import scan from the Phase 6 roots (the gate workflow, the four suites, the harness)
found **90 reachable repository source files: 42 in HEAD, 48 not in HEAD.** Of the 48, **9 are
staged** and **39 are neither in HEAD nor staged**:

| Not in HEAD, not staged | Count |
| --- | --- |
| `apps/api/src/routes/school/*.ts` (academic-terms … util) | 33 |
| `apps/api/src/plugins/authorization.ts` | 1 |
| `apps/worker/src/exams.ts`, `apps/worker/src/report-pdf.ts` | 2 |
| `packages/contracts/src/school.ts` | 1 |
| `packages/core/src/content.ts`, `packages/core/src/csv.ts` | 2 |
| **total** | **39** |

Add to that the **13 untracked migrations `0003`–`0015`** (not import-reachable but proven necessary
by execution in §13: `0016` alone fails with `relation "marks" does not exist`, because `marks`,
`exams` and `grading_scales` are created only by `0015_exams_results.sql`), and the **tracked but
unstaged** `packages/db/src/cli/paths.ts` and `packages/db/src/cli/migrate.ts` that fix the silent
no-op in §2.3.

**Minimum coherent commit for Phase 6 ≥ 69 paths** (17 staged + 39 untracked source + 13 untracked
migrations), and that still omits `turbo.json`, the `package.json` files, `pnpm-lock.yaml` and the 50
unstaged tracked modifications — including `apps/api/src/app.ts`, without which a checkout's app
registers **no** school routes and the API acceptance suite cannot pass even if it is committed.

**Consequences, all verified:**

1. A clean checkout of `848c20f` has **no gate**, **no Phase 6 suites**, **no harness**, and
   **13 of the 19 migrations it would need**.
2. Even the staged 17 alone do not migrate: `0016` cannot apply without `0003`–`0015`.
3. Even a commit of all 69+ paths would still be insufficient without the tracked modifications,
   because HEAD's `app.ts` wires no school routes and HEAD's `pnpm db:migrate` is a silent no-op.
4. Nothing in the audit can change this: P2-3 is a **provenance/governance** condition, closable only
   by committing a coherent, self-contained change set — which this audit is forbidden to do.

---

## 19. Verdict

# `GO WITH CONDITIONS`

**Technically, Phase 6 and its gate are sound.** All four R2 findings are closed, and each closure was
re-proved by execution rather than by reading the remediation:

| R2 finding | Status | Independent proof |
| --- | --- | --- |
| P2-1 destructive suite in the parallel default run | **CLOSED** | `pnpm test` unset: 8/8 twice, 0 cached, 779 DB-backed tests skip, regression suite never executes (§4) |
| P2-2 vacuous RLS role assertion | **CLOSED** | verbatim-extracted assertion, 5 cases × 2 roles = 10/10, and the old form's exit-0 defect reproduced (§5) |
| P3-1 migration restored a trigger it never checked | **CLOSED** | all four `tgenabled` states (`'D'`, `'R'`, `'A'`, absent) refused for **both** triggers it lifts, `'O'` accepted, zero residue; failing migration rolls the lift back (§6, §6.1a) |
| P3-2 assertions never reached their code | **CLOSED** | coherence guard off ⇒ exactly the 2 named assertions fail, 85/87; restored ⇒ 87/87 (§7) |

Plus: 35/35, 13/13, 5/5 gates twice; 330/330, 449/449, 90/90 per-package twice; **66/66 direct SQL
checks re-deriving proofs A–F, RLS and F-01 without the test suite**; 59/59 RLS enabled and forced
with 0 disabled triggers; 41/41 functions pinned; migration CLI atomic and honest; typecheck 17/17;
build 3/3; `school_saas_dev` byte-identical to baseline; final DB state 19 migrations at `0019`, 0
disabled triggers, 0 rows, no stray schemas; Git index and HEAD untouched.

**Why not `GO`:** P2-3 is open, and it is open in a way that makes the gate **unrunnable from the
repository**. §18 establishes this by execution, not inference. A reviewer who clones `848c20f` cannot
reproduce any of this audit. An unconditional `GO` would assert a reproducibility that does not exist.

**Why not `NO-GO`:** no integrity defect, no vacuous evidence and no weakened rule remains. Every
mandatory technical property the R2 report demanded has been demonstrated. The gap is that the work
is uncommitted — a provenance failure with a known, mechanical remedy, not a design or correctness
failure.

### Conditions

| # | Condition | Owner | Severity if unmet |
| --- | --- | --- | --- |
| **C1** | **Commit a coherent, self-contained Phase 6 change set** — the 69+ paths of §18 **plus** the tracked modifications that HEAD needs (`apps/api/src/app.ts` route registration, `packages/db/src/cli/{paths,migrate}.ts`, `turbo.json`, lockfile). A commit of the staged 17 alone is not sufficient and would produce a repository that cannot migrate. | repository owner | **blocking for a future `GO`** |
| **C2** | **Never set `RUN_RUNTIME_SECURITY_TESTS` at job or global scope again.** §8.3 shows a global setting makes the full suite fail nondeterministically (5/8 tasks; db deadlock, 27/35 API failures, 5 worker failures) because three packages share one disposable database and one suite drops the schema. The current workflow is safe only because the variable is scoped to four sequential steps. Consider serialising DB-backed suites, or giving the destructive suite its own database, before anyone widens the scope. | CI owner | high — a plausible future edit silently reintroduces P2-1 |
| **C3** | Correct the three remaining documentation inaccuracies in §17 (D2 variable name, D3 the three-test dependency, D4 the stale 84-test count). **D1 is withdrawn** — the remediation report was right and this audit's first pass was wrong (§6.1a, §17). None affects behaviour. | report owner | low |
| **C4** | Five independent audit defects were found and disclosed in §1, including four committed tenant fixtures left by crashed probe iterations and three false positives from a banned-pattern sweep that had never been shown able to pass. Any future audit tooling should: give a committed fixture its own cleanup path and residue assertion rather than relying on `ROLLBACK`; delete synthetic journal rows explicitly; escape `_` in `LIKE`; and verify a banned-pattern check against a known-clean case before trusting a hit. | audit tooling | low — process hygiene |
| **C5** | **Wrap the API acceptance fixture's trigger teardown in one transaction**, as the worker fixture already does. `apps/api/src/security/phase6-exams-acceptance.acceptance.test.ts` commits four guard disables with no `BEGIN` and no `finally`, so a process kill inside that window leaves `marks`, `report_cards`, `report_card_subjects` and `mark_corrections` guards disabled in the shared test database, and no later run re-asserts them (§14.2). | test owner | low — test harness only, but it can silently weaken the database it is testing |
| **C6** | Consider whether a client that disagrees with the server's grade banding should be **rejected** rather than silently corrected. `marks_validate_trg` overwrites `percentage`, `grade_label` and `grade_point` with derived values, so a forged grade cannot survive, but the caller receives no error (§9.1). Optional; the current behaviour is safe. | domain owner | low — observation, not a defect |

**Explicitly not recommended:** further changes to the integrity model. No RLS policy, trigger,
constraint or function needed relaxation; every R2 closure is an assertion added, a variable scoped,
or a test made to reach the code it claims to test.

### Left exactly as found

`school_saas_dev` (16 migrations, 59 tables, 0 disabled triggers, unchanged row counts); HEAD
`848c20f`; branch `master`; the 17-path index; the 50 unstaged modifications; the 178 untracked files
that pre-existed the audit. This report is untracked and unstaged, and is the only file this audit
created — which is why the untracked count reads 179 rather than 178.
