# PHASE 6 — INDEPENDENT FINAL RE-AUDIT REPORT

**Date:** 2026-09-26
**Repository:** `G:\School Managment system`
**Branch / HEAD:** `master` @ `848c20fda26c4bd40d07467ba23d47f421e12f87`
**Auditor role:** independent re-audit. No product code, migration, RLS policy, trigger, worker behaviour, test, or CI file was modified by this audit.
**Supersedes:** nothing. This is a fresh, independent report. The previous independent report `docs/PHASE_6_INDEPENDENT_FINAL_RE_AUDIT_REPORT.md` is preserved unchanged and its findings remain historically intact.

---

## 1. Scope and Objective

Determine whether the Phase 6 result-integrity remediation has genuinely discharged the four conditions recorded by the previous independent audit, whether the underlying tenant-isolation and report-card integrity guarantees actually hold, and whether a real, enforceable gate now exists.

The previous audit's verdict was **GO WITH CONDITIONS** with four open conditions:

| ID | Previous condition |
|----|--------------------|
| P1 | Seven failing tests across the required suites |
| P2 | `pnpm db:migrate` silently no-opped |
| P3 | No enforceable lint gate |
| P4 | Nothing enforced any of it (no CI) |

This audit independently re-tested every one of them, plus the deeper data-integrity properties the remediation claims to have added.

---

## 2. Environment and Baseline

- Node `v26.5.0`, pnpm `12.4.1`, `packageManager: pnpm@12.4.1`, `engines.node >=22`.
- PostgreSQL 16 service, databases `school_saas_dev` and `school_saas_test`.
- Role posture confirmed at both baseline and close:
  - `school_app_rw`: `rolsuper=false`, `rolbypassrls=false`
  - `school_migrator`: `rolsuper=false`, `rolbypassrls=false`, `rolcreatedb=false`, `rolcreaterole=false`
- **No PostgreSQL superuser credential was available**, so `scripts/bootstrap.sql` could not be executed locally. This is an explicit limitation (Section 19).

Database baseline captured before any audit action:

| | `school_saas_dev` | `school_saas_test` |
|---|---|---|
| schema version | `0016_phase6_result_integrity_fixes.sql` | `0019_phase6_report_card_snapshot_reconciliation.sql` |
| migrations applied | 16 | 19 |
| tables (owner view) | 59 | 60 |
| RLS enabled / forced | — / 58 | 59 / 59 |
| non-internal triggers | 33, **0 disabled** | 38, **0 disabled** |
| tenants / users / students | 13 / 254 / 30 | 0 / 0 / 0 |
| exams / marks / report_cards | 0 / 0 / 0 | 0 / 0 / 0 |
| outbox_events | 113 | 0 |

`school_saas_dev` sits at `0016` and therefore legitimately has no `report_cards`/`report_card_subjects` tables. That is a version difference, not a defect.

An initial apparent discrepancy — "59 tables as the runtime role vs 60 as owner" — was resolved and is **not** a finding: `app_rls_secrets` is revoked from `school_app_rw` by migration `0002` and is therefore correctly invisible to the runtime role.

---

## 3. Git Baseline and Remediation Diff

Baseline and close census are **identical**:

| Measure | Baseline | Close |
|---|---|---|
| staged files | 0 | 0 |
| `M` entries | 51 | 51 |
| `??` entries (collapsed) | 112 | 112 |
| `??` entries (`-uall`) | 192 | 192 |
| total `-uall` entries | 243 | 243 |
| HEAD | `848c20f…` | `848c20f…` |

Tracked remediation diff inspected:

- `packages/db/src/cli/paths.ts` — `isMainModule()` now takes the caller's `metaUrl` instead of comparing `process.argv[1]` to its own module URL.
- `packages/db/src/cli/migrate.ts` — errors are caught, surfaced as `migration failed: …`, and `process.exitCode = 1` is set; the up-to-date path reports `already applied: N` / `database is already up to date; nothing to migrate`.
- `packages/db/src/cli/migrate-down.ts`, `packages/db/src/cli/seed.ts` — pass their own `import.meta.url`.
- `package.json` — the only change is the **removal** of `"lint": "pnpm turbo run lint"`.
- `turbo.json` — lint task removed; `RUN_RUNTIME_SECURITY_TESTS` added to the `env` allowlist of the generic and package-specific `test` tasks.
- `docs/DEPLOYMENT.md` — documents the absent lint command honestly.

No broad mechanical reformatting is present in the remediation diff. Line-ending warnings (`LF will be replaced by CRLF`) are Git's Windows defaults, not an introduced change.

**Root cause independently confirmed.** A temporary probe outside the repository demonstrated the old `isMainModule()` returns `false` for `migrate.ts` and the new one returns `true`. This **corrects** the previous audit's mechanism claim; the previous conclusion that the CLI silently no-opped is nonetheless confirmed, and the fix addresses the real cause.

---

## 4. Remediation Scope vs. Actual Working Tree

This is a material governance finding.

The remediation report describes "3 new files and 11 modified files". Git cannot corroborate that boundary:

- **Untracked** (no pre-remediation baseline exists, so a diff is impossible):
  `.github/workflows/phase6-security.yml`,
  `packages/db/src/security/phase6-exams.test.ts`,
  `apps/api/src/security/phase6-exams-acceptance.acceptance.test.ts`,
  `packages/db/src/security/phase6-migration-regression.test.ts`,
  `packages/db/src/testing/publish-card.ts`,
  `packages/db/migrations/0003…0019_*.sql` (17 files),
  `apps/worker/src/exams.ts`,
  and all three Markdown reports.
- `apps/worker/src/worker.ts` is **modified** and contains Phase 6 handler wiring; attribution between earlier phases and this remediation cannot be separated from Git alone.

Consequence: the claim "no migration changed for this remediation" is **not** independently verifiable. Direct content review of `0018`/`0019` was performed instead (Sections 9 and 12), and no dangerous operation was found — but that is a code review, not a provenance proof.

---

## 5. Verdict on the Four Prior Conditions

| ID | Condition | Verdict | Basis |
|----|-----------|---------|-------|
| P1 | Seven failing tests | **RESOLVED** | Section 6, 8, 11, 13 |
| P2 | Silent `db:migrate` | **RESOLVED** | Section 10 |
| P3 | No enforceable lint gate | **RESOLVED as specified** | Section 17 |
| P4 | Nothing enforces it | **PARTIALLY RESOLVED** | Section 16 |

P4 is only partial: a real gate now exists and its four explicit verification steps are sound, but the workflow contains a non-fail-closed assertion and its final step is deterministically red. See Section 16 and Findings P2-1 / P2-2.

---

## 6. Mandatory Non-Vacuity Check (Counterfactual Sabotage)

Required by the audit brief. The `report_card_subjects` SELECT policy was deliberately weakened to `USING (true)` and the DB security suite re-run.

```
RUN_RUNTIME_SECURITY_TESTS=1 pnpm --filter @sms/db exec vitest run src/security/phase6-exams.test.ts
→ 2 failed | 85 passed
   • "report_card_subjects: expected 3 to be +0"   (no-context read)
   • "report_card_subjects: expected 2 to be +0"   (tenant isolation)
```

The suite genuinely fails when RLS is broken. The isolation assertions are **not vacuous**.

The authoritative policy was then restored from `0018`. Post-restore verification:

- policy snapshot **byte-identical** to the pre-sabotage capture
- trigger posture **byte-identical**
- RLS `enabled` and FORCE RLS both `true`
- `report_card_subjects_freeze_trg` and `report_card_subjects_validate_trg` both `tgenabled='O'`

Note: the implementation report claimed 3 failures; **2** were observed. The non-vacuity requirement is satisfied regardless, but the report's count is inaccurate (Finding P3-2).

---

## 7. 4C: Trigger / RLS Layering

The DB suite encodes the intended layering:

- integrity triggers **enabled** → `SQLSTATE 55000`, `exam subject not found`
- named integrity triggers **disabled** → RLS rejection `SQLSTATE 42501`
- exactly 10 `ALTER TABLE … DISABLE TRIGGER` statements, each naming a specific trigger, each restored in a `finally` block, with a post-assertion that `tgenabled = 'O'`

This is the correct design: the freeze/validate triggers run *before* RLS policy evaluation, so a cross-tenant row is rejected as a data-integrity violation rather than leaking a row-count signal, while RLS remains the backstop whenever those triggers are absent.

**Direct independent confirmation of the central Phase 6 guarantee** was performed with a temporary probe against the disposable database, committing real transactions rather than relying on the suite:

```
NEGATIVE — insert a PUBLISHED card with hard-coded gpa 2.00, 70/100, subject_count 1
           and ZERO snapshot lines, then COMMIT:
  → REFUSED at commit: 55000
    "a published report card must agree with its own subject snapshot
     (card: gpa 2.00, total 70.00, of 100.00 over 1 subject(s); snapshot: gpa <NULL> …)"
  → row does not persist (verified count = 0)

POSITIVE — draft card → insert lines → set aggregates from fn_report_card_totals()
           → publish, then COMMIT:
  → COMMITTED. status=published, gpa=3.00, 72/100, subject_count=1
```

The deferred coherence trigger is armed, fires at commit, refuses incoherent publications, does not persist the offending row, and accepts coherent ones. **This is the single most important property of Phase 6 and it is sound.**

A side observation from the same probe: deleting the published card's lines is refused with `55000 "a published report card's subject lines are frozen"` even for the table owner — the immutability guarantee holds against privileged sessions.

---

## 8. F-01 and F-02 Cross-Suite Behaviour

**F-01 (sibling-exam leakage).** `apps/api/.../phase6-exams-acceptance.acceptance.test.ts:1323` — "does not leak a sibling exam's subject lines into the card (F-01)". The fixture asserts a second `class_subject` exists, so the negative case is genuinely constructed rather than vacuous. Passing.

**F-02 (correction / staleness).**
- API: stale published card rejected, correction endpoint produces a new version, outbox payload carries `tenantId`/`examId`/`markId`, and no inline recompute occurs.
- Worker: `makeResultComputeHandler` consumes `tenantId` and `examId` from the payload; the API additionally asserts `markId`, which the worker does not read. Harmless, but the remediation report's payload description is slightly wider than the worker's consumption.
- Versioning: version 1 remains frozen at its original total; version 2 recomputes to the corrected total. Passing.

**Architectural limitation, stated honestly:** `@sms/api` does not depend on `@sms/worker`. F-02 is therefore verified as a **seam contract** — the producer's emitted event shape and the consumer's handling of it, asserted in two suites that share a database and an event name. It is *not* a single-process end-to-end test with one real outbox event consumed by a live worker. This was disclosed in the implementation report and is confirmed accurate.

---

## 9. Publication Helper and Its Call Sites

`packages/db/src/testing/publish-card.ts` implements the only sanctioned publication order:

1. insert the card as `draft`
2. insert snapshot lines scoped to **that card's own exam** (`exam_subjects` filtered by the card's `exam_id`)
3. set `gpa`/`total_obtained`/`total_possible`/`subject_count` from `fn_report_card_totals(tenant, card)`
4. flip to `published`

It does not disable triggers, does not use `session_replication_role`, does not hard-code aggregates, and cannot attach another exam's lines. Call sites: `apps/api` ×2, `packages/db` ×5.

**Test-authoring gap (P3-3).** Two locations in `packages/db/src/security/phase6-exams.test.ts` (≈ lines 1541 and 2932) insert a *published* card with hard-coded aggregates and no snapshot rows and assert the insert succeeds. This initially looked like a possible integrity bypass. It is not:

- `tenantA()` (`phase6-exams.test.ts:108-119`) wraps every fixture in `begin` … `finally { rollback }`, so the row is always discarded;
- `report_cards_snapshot_coherent_trg` is `DEFERRABLE INITIALLY DEFERRED`, so it only fires at `COMMIT` — which never happens.

The product is safe (proved independently in Section 7), but the assertion proves nothing: it would still "pass" if the coherence trigger were deleted. Since the coherence trigger *is* independently load-bearing (the API suite, the regression suite, and the Section 7 probe all depend on it), this is a test-quality finding, not a security finding.

---

## 10. Migration CLI

All checks against `school_saas_test` only, with an explicit guard that refuses any non-`_test` target.

| Scenario | Result |
|---|---|
| Empty schema → `pnpm db:migrate` | applied 19 named migrations, exit 0 |
| Current schema → `pnpm db:migrate` | `migrations applied: (none) \| already applied: 19`, `database is already up to date; nothing to migrate`, exit 0 |
| Deliberately failing migration `9999_audit_probe_fail.sql` | `migration failed: Migration 9999_audit_probe_fail.sql failed: division by zero`, exit 1 |

For the failure case the auditor verified: the table created earlier in that same migration file did **not** persist, the migration was **not** written to the schema-migration journal, and the journal still contained exactly 19 entries. The temporary probe migration was then deleted; the directory again contains 19 files and no marker file.

**P2 is resolved.** The CLI is honest about no-op, reports applied migrations, fails loudly with a non-zero exit code, and leaves no partial state.

---

## 11. `0018` / `0019` Regression Coverage

`packages/db/src/security/phase6-migration-regression.test.ts` is a genuinely strong test:

- gated on `RUN_RUNTIME_SECURITY_TESTS=1`; refuses to run unless the target database is disposable
- rebuilds the schema and applies the **real** `0001`–`0017` through the **real** `applyMigrations()`
- seeds a published card with no snapshot rows
- **negative control**: stages a doctored `0018` with the freeze-trigger restoration line removed, expects failure with `post-backfill assertion failed`, and verifies rollback, journal state, and a full schema fingerprint
- applies real `0018` then `0019` and asserts backfill correctness, snapshot coherence, RLS `enabled` + `forced`, and `tgenabled='O'` for both triggers
- re-runs for idempotence and confirms drafts remain writable

```
RUN_RUNTIME_SECURITY_TESTS=1 pnpm --filter @sms/db exec vitest run \
  src/security/phase6-migration-regression.test.ts
→ 5/5 passed   (executed twice)
```

`packages/db/vitest.config.ts` uses a single-thread pool with `fileParallelism: false`, so the suite does not race itself locally.

---

## 12. Postconditions and Data-Loss / Backfill Correctness

Static DML analysis of `0018` and `0019` found **only**:

- `INSERT` into `report_card_subjects`
- `UPDATE report_cards` setting the four aggregate columns

No `DELETE`, no `TRUNCATE`, no writes to `exams`, `exam_subjects`, `marks`, `tenants`, `class_subjects`, or `grading_scales`. No `SECURITY DEFINER`. No explicit transaction control. No `ALTER TABLE … DISABLE TRIGGER ALL`. No `session_replication_role`. No `SET ROLE`.

The aggregate updates read from `fn_report_card_totals()` and are guarded by `IS DISTINCT FROM`, so re-running is a no-op. Backfill correctness is independently confirmed by the regression suite, which reconstructs a real pre-`0018` database containing a published card with zero snapshot rows and proves the backfill reconstructs the correct lines and aggregates.

**No data-loss path was found.**

Trigger handling in `0018`:
- `report_card_subjects_freeze_trg` disabled at line 632, restored at line 665
- post-backfill assertions for both snapshot triggers at lines 686-694
- `report_cards_validate_trg` disabled at line 773, restored at line 798, **but never asserted in `0018`**

`0019` restores the same trigger at line 231 and asserts it at lines 253-256. The implementation report's claim that optional P3-2 was already satisfied is therefore **inaccurate** (Finding P3-2).

---

## 13. Test Quality and Coverage Gaps

Required suites, each executed **twice**:

| Suite | Run 1 | Run 2 |
|---|---|---|
| `packages/db` security (`phase6-exams.test.ts`) | 87/87 | 87/87 |
| Migration regression | 5/5 | 5/5 |
| `apps/api` security acceptance | 35/35 | 35/35 |
| `apps/worker` result pipeline | 13/13 | 13/13 |

Full package runs, all green:

| Package | Result |
|---|---|
| `@sms/db` | 330/330 across 19 files |
| `@sms/api` | 449/449 across 21 files |
| `@sms/worker` | 90/90 across 6 files |

Gaps identified:
- **P3-3**: the two vacuous published-card assertions described in Section 9.
- **P3-4**: the regression suite does not exercise concurrency; it is a single-threaded file, so it cannot detect the cross-package interference described in Section 16. The implementation report disclosed this accurately.
- The outbox/worker seam is verified in two suites rather than one end-to-end test (Section 8).

---

## 14. Security Test Hygiene (Banned Patterns)

Swept the whole test surface:

- no `.only` / `.skip`-to-hide anywhere
- environment-gated `describeDb` skipping is present **only** in the four security suites and is the intended opt-in mechanism
- no `session_replication_role`
- no `ALTER TABLE … DISABLE TRIGGER ALL`
- no `SET ROLE`
- no `TRUNCATE`
- no `BYPASSRLS` in test code
- 10 `ALTER TABLE … DISABLE TRIGGER <named>` statements, all inside 4C, all restored in `finally` with a post-assertion
- no hard-coded aggregate maths in the publication helper

The disposable-database guard in `packages/db/src/testing/runtime-db.ts:69-86` is genuinely strong: a denylist of real environments **plus** a `_test`/`test_` name-shape allowlist, re-asserted after URL rewriting, with **no override flag**. This is why `school_saas_dev` was never at risk during this audit.

---

## 15. Database Hygiene and Restoration

All destructive activity was confined to `school_saas_test`, guarded by an explicit path assertion on every probe script.

Final state, re-measured after **all** audit activity including the failing cold CI runs:

| Check | Result |
|---|---|
| `school_saas_dev` schema version | `0016_phase6_result_integrity_fixes.sql` — unchanged |
| `school_saas_dev` tenants / users / students / outbox | 13 / 254 / 30 / 113 — unchanged |
| `school_saas_dev` tables / RLS forced / disabled triggers | 59 / 58 / **0** — unchanged |
| `school_saas_test` migrations | 19, `0019_…` |
| `school_saas_test` rows (tenants/users/cards/subs/marks/exams/outbox) | all **0** |
| `school_saas_test` disabled triggers | **0** |
| `school_saas_test` RLS enabled / forced | 59 / 59 |
| `app_rls_secrets`, `fn_current_tenant` present | yes / yes |

A failed cold CI run left residue in the disposable database (3 tenants, 9 users, 40 outbox events) because the crashed worker never reached its teardown. The auditor detected this, rebuilt the disposable database through the **real** migration runner, and re-verified the pristine state above.

**`school_saas_dev` is byte-for-byte identical to the pre-audit baseline. The disposable database is restored and empty.**

---

## 16. CI Enforcement

`.github/workflows/phase6-security.yml` triggers on push and PR, uses `ubuntu-latest` with PostgreSQL 16 and Redis 7, and provisions both databases and both least-privilege roles through `scripts/bootstrap.sql`. It sets `RUN_RUNTIME_SECURITY_TESTS: '1'` at job level (line 81) and then runs, as **separate sequential steps**:

- `pnpm install --frozen-lockfile` (line 98)
- `scripts/bootstrap.sql` (line 108)
- role assertion (lines 112-119)
- `pnpm typecheck`, `pnpm build`
- migration CLI checks
- migration regression (line 150)
- DB security, API security, worker result-pipeline suites (lines 152-160)
- `pnpm test` — "Default test suite" (line 164)

Because those are separate `run:` steps they execute **sequentially**, so the four explicit gate steps are sound and cannot race each other. The enforcement condition is materially met at that layer.

Two defects were found, however.

**P2-1 — the final default-test step is deterministically red.**
`phase6-security.yml:164` runs `pnpm test`, which is `pnpm turbo run test` and fans the 8 package test tasks out **in parallel**. Because the job-level env at line 81 sets `RUN_RUNTIME_SECURITY_TESTS='1'`, this step also executes `packages/db/src/security/phase6-migration-regression.test.ts`, whose `beforeAll` performs:

```
phase6-migration-regression.test.ts:251   drop schema public cascade
phase6-migration-regression.test.ts:252   create schema public
```

The DB, API, and worker packages all point at the single `school_saas_test`. The wipe therefore destroys the API and worker suites' fixtures **while they are running**. Reproduced on two cold runs:

| Run | Result |
|---|---|
| cold `pnpm test` | `@sms/worker#test` 1 failed / 89 passed — `outbox-integration.test.ts:989`, expected 3 to be 1 |
| cold `npx turbo run test --force` | `@sms/worker#test` **10 failed** / 80 passed — all via `tuitionFixtures` (`outbox-integration.test.ts:782` ← `:1021`) |
| `npx turbo run test --concurrency=1 --force` | **8/8 pass** |
| `@sms/worker` alone | **90/90 pass** |

The blast radius varied between runs (1 test, then 10) while worker-only and serialized runs were always green — the signature of shared-database interference, not a worker defect. The workflow as written **cannot pass**, so the gate is self-defeating: it would block every push and PR. Clearing it requires either scoping `RUN_RUNTIME_SECURITY_TESTS` to the four explicit gate steps only, or giving each package its own database in CI.

**P2-2 — the role assertion is not fail-closed.**
`phase6-security.yml:112-119` runs:

```sql
select case
  when rolsuper or rolbypassrls then 'FAIL: runtime role can bypass RLS'
  else 'ok: ' || rolname
end from pg_roles where rolname = 'school_app_rw';
```

via `psql -tAc`. `psql` exits 0 as long as the query executes; the `FAIL:` string is printed and the step still succeeds. If `school_app_rw` were ever provisioned with `BYPASSRLS` or `SUPERUSER`, this step would print a warning and the gate would continue — precisely the vacuity the workflow's own header says it exists to prevent. The query needs to raise, e.g. a `DO $$ … RAISE EXCEPTION $$` block under the existing `ON_ERROR_STOP=1`, or a shell-level `|| exit 1`. *(Established by reading the command and psql's documented exit semantics; the local environment has no `psql` binary, so it was not executed.)*

**Bootstrap reviewed, not executed.** `scripts/bootstrap.sql` creates both databases and both roles with externally supplied passwords and no hard-coded credentials. Roles are not declared with explicit `NOBYPASSRLS`/`NOSUPERUSER`; they rely on PostgreSQL defaults, which are correct. The workflow's own header states the CI service user is deliberately a superuser so the script can create the least-privilege roles. Acceptable, but a `NOBYPASSRLS NOSUPERUSER` belt-and-braces would make the intent self-documenting.

**Lockfile.** `pnpm-lock.yaml` contains two YAML documents. This is **not** corruption: `packageManager: pnpm@12.4.1` causes pnpm to write its self-install document alongside the workspace document, and pnpm parses the file successfully for every other command. Whether `--frozen-lockfile` succeeds on a clean checkout could not be verified without installing dependencies, which this audit is not permitted to do (Section 19).

---

## 17. Build, Typecheck, and Lint

| Command | Result |
|---|---|
| `npx turbo run typecheck --force` | 17/17 successful |
| `npx turbo run build --force` | 3/3 successful, with warnings for API, web, and worker |

`tsconfig.base.json` sets `noEmit: true`, so the "build" for the TypeScript packages is a type-check; no `dist` is produced. Turbo reports missing outputs for API, web, and worker. This is pre-existing and not a Phase 6 correctness problem, but it means `pnpm build` is not a packaging gate. The implementation report listed API and worker; **web also warns** (Finding P3-5).

Lint disposition, verified rather than assumed:

- root `package.json` has **no** `lint` script
- `turbo.json` has **no** empty `lint` task
- no ESLint configuration exists anywhere in the repository
- Prettier **is** a root devDependency and is installed, but there is no `.prettierrc`/`.prettierignore` and no `format:check` script, so "141 files differ" is not a meaningful policy signal
- `docs/DEPLOYMENT.md` states plainly that no linter is installed and that `pnpm lint` does not exist, rather than pretending a gate is enforced
- the ignored generated artifact `apps/web/.next/standalone/package.json` still contains a stale copied `lint` script; it is build output, not source, and was deliberately not edited

**P3 is resolved as specified:** the false claim that a lint gate exists was removed and replaced with an honest statement, and no broad formatter reformat was introduced.

---

## 18. Findings and Evidence Matrix

No P0 and no P1 findings. The security and data-integrity guarantees themselves are sound.

| ID | Sev | Finding | Evidence | Ref |
|----|-----|---------|----------|-----|
| P2-1 | P2 | CI final `pnpm test` step is deterministically red: the `0018`/`0019` regression test's `drop schema public cascade` runs concurrently with API/worker suites sharing one database | 2 cold runs failed (1 and 10 tests); worker-only 90/90; `--concurrency=1` 8/8 | §16 |
| P2-2 | P2 | Runtime-role RLS assertion prints `FAIL:` but exits 0, so it cannot fail the gate | `.github/workflows/phase6-security.yml:112-119` | §16 |
| P2-3 | P2 | The entire Phase 6 gate — workflow, both security suites, the helper, the regression test, migrations `0003`–`0019`, the worker handler — is untracked; a clean checkout cannot reproduce any of it | `git status`: 17 migrations, workflow, 3 test files untracked | §4 |
| P3-1 | P3 | `report_cards_validate_trg` is restored in `0018` but never asserted there; the remediation report claims this optional item is already satisfied | `0018:773,798` vs `0018:686-694`; `0019:253-256` | §12 |
| P3-2 | P3 | Two vacuous assertions: published cards with no snapshot rows are inserted inside `tenantA()`, which always rolls back, so the deferred coherence trigger never fires | `phase6-exams.test.ts:108-119, ≈1541, ≈2932` | §9 |
| P3-3 | P3 | Build is type-check-only (`noEmit: true`); turbo output warnings for API, **web**, and worker — the report listed only API and worker | `tsconfig.base.json`; forced build | §17 |
| P3-4 | P3 | Report inaccuracies: counterfactual yields 2 failures not 3; `turbo.json` changes exceed the reported scope; F-02 payload description is wider than the worker's actual consumption | §6, §3, §8 | — |
| P3-5 | P3 | Bootstrap roles rely on PostgreSQL defaults rather than explicit `NOBYPASSRLS NOSUPERUSER` | `scripts/bootstrap.sql` | §16 |

### Evidence matrix for the four prior conditions

| Condition | Independent evidence | Result |
|---|---|---|
| P1 seven failures | All 4 required suites green twice; full DB 330/330, API 449/449, worker 90/90; coherence guarantee proved at commit; RLS sabotage genuinely fails the suite | **RESOLVED** |
| P2 silent migrate | Empty DB migrates 19; current DB no-ops honestly; failing migration exits 1 with no partial table and no journal entry | **RESOLVED** |
| P3 lint | No script, no task, no ESLint, honest docs, no blanket reformat | **RESOLVED** |
| P4 nothing enforces | Real workflow with sound sequential gate steps, but final step is deterministically red and the role assertion is not fail-closed | **PARTIALLY RESOLVED** |

---

## 19. Limitations and Final Disposition

**Limitations.**
- The GitHub Actions workflow was **never executed**; there is no CI runner available. All CI conclusions come from reading the YAML and reproducing its commands locally, including a cold forced run.
- `scripts/bootstrap.sql` was **never executed**; no superuser credential is available. Role and database creation in CI are reviewed, not proven.
- `pnpm install --frozen-lockfile` behaviour on a clean checkout was not verified, because dependency installation is out of scope for this audit.
- Migrations `0003`–`0019`, the worker handler, and all three security/regression test files are untracked, so their pre-remediation contents cannot be recovered. Code review substitutes for diff review but is not equivalent.
- F-02 is verified as a producer/consumer seam contract across two suites, not as one end-to-end event flowing from a live API into a live worker.
- Test counts are from this machine on 2026-09-26; the workflow's own cache is cold, so the default step will fail as shown rather than pass from cache.

**What is genuinely solid.** The heart of Phase 6 is correct. Snapshot coherence is enforced at commit and refuses incoherent publications without persisting them; published lines are immutable even for the table owner; RLS isolation assertions are non-vacuous and were proven to fail under deliberate sabotage; the migration CLI is honest, atomic on failure, and journalled; `0018`/`0019` contain no destructive or data-losing operation and are covered by a real, from-scratch migration regression including a negative control; and `school_saas_dev` was never touched.

**What must be cleared before an unconditional GO.**
1. Make `.github/workflows/phase6-security.yml:164` green on a cold run — scope `RUN_RUNTIME_SECURITY_TESTS` to the four explicit gate steps, or give each package its own database in CI (P2-1).
2. Make the role assertion fail closed at `.github/workflows/phase6-security.yml:112-119` (P2-2).
3. Commit the Phase 6 gate artifacts so a clean checkout can reproduce the gate (P2-3).
4. Add the `report_cards_validate_trg` re-enable assertion to `0018` and correct the remediation report's claim (P3-1).

None of these require touching the integrity model. They are enforcement, provenance, and test-hygiene defects, and none of them permits cross-tenant access, forged report cards, or silent data loss.

---

**FINAL DISPOSITION: `GO WITH CONDITIONS`**
