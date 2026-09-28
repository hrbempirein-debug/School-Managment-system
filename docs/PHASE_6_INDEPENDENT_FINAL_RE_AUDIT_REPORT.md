# Phase 6 — Independent Final Re-Audit Report

**Subject:** closure of the Phase 6 result-integrity gate after the `0018`/`0019` remediation
**Auditor:** independent re-audit (no involvement in the remediation)
**Date:** 2026-09-26
**Branch / HEAD:** `master` @ `848c20fda26c4bd40d07467ba23d47f421e12f87`
**Mode:** audit-only. No product code, migration, test, fixture, configuration or Git history was modified.

> **Addendum — read with the findings below.** This report is the independent record of the state at
> `848c20f` and its findings are deliberately left unedited. The GO conditions have since been worked on;
> see [`PHASE_6_GO_CONDITION_REMEDIATION_REPORT.md`](./PHASE_6_GO_CONDITION_REMEDIATION_REPORT.md) for what
> was actually changed and what remains open. One present-tense detail below is now historical: the
> no-op `pnpm lint` command described in condition 3 has since been **removed** (root script and the empty
> `turbo.json` task), rather than replaced with a formatter or linter, so the repository no longer presents
> a lint command that succeeds without checking anything.

---

## VERDICT

# GO WITH CONDITIONS

The Phase 6 **data-integrity property is established**. The original P1 defect — a published report card
disagreeing with its own subject snapshot — is genuinely fixed, and the fix is the strongest kind of fix:
the database now *refuses* the incoherent state rather than merely avoiding it. I proved this adversarially,
not by reading the remediation's own report.

The gate nevertheless **cannot be called closed**, for reasons that are real but are *not* product defects:

1. **7 tests in the required suites fail.** All 7 are test-authoring defects, and I proved each one with a
   counterfactual. But a gate whose own suite is red is not a closed gate, and the red tests are currently
   *masking* real coverage.
2. **`pnpm db:migrate` silently does nothing** (exit 0, no output, no migrations applied). This is the only
   supported way to apply the very migrations under audit.
3. **Nothing enforces any of this.** There is no CI configuration in the repository, the security suites are
   skipped by the default `pnpm test`, and `pnpm lint` executes zero tasks.
4. **The `0018`/`0019` migrations have no regression test.** The exact defect that caused this remediation
   would not be caught by anything in the repository.

Conditions for upgrading to **GO** are listed at the end. None of them require touching the integrity design.

---

## 1. Scope and method

I audited the closure of the Phase 6 gate as an independent party. Specifically I did **not** accept the
remediation report's conclusions; I re-derived every claim from source, from the real migration runner, and
from direct database probes.

| Area | Method |
|---|---|
| Baseline | Recorded branch, HEAD, working-tree census, migration inventory and both database states before any test ran |
| Source | Read `0018`, `0019`, `applyMigrations`, the worker's result handler, the API publish path, and every RLS policy |
| Real migration | Drove the **real** `applyMigrations()` against a database seeded to a genuine pre-`0018` state |
| Negative control | Rebuilt the pre-fix `0018` outside the repository and confirmed the defect reproduces |
| Adversarial SQL | 196 assertions executed as the privileged and runtime roles against real fixtures |
| Suites | Full DB, API and worker suites, plus typecheck, build, default test and lint |
| Counterfactual | Rebuilt each failing test's *intent* with a coherent fixture to prove the product, not the test |
| Repeatability | Every probe executed twice; results identical |
| Integrity | Database and repository state restored and verified against the baseline |

**Rules I held myself to.** Audit-only: no product modification. All probes were written **outside** the
repository (`%TEMP%\opencode\audit\`) and removed afterwards. `school_saas_dev` was treated as read-only and
was never a migration target. I did not inherit the remediation report's severity ratings, and where I
disagreed with it I recorded my own.

---

## 2. Baseline

| Item | Value |
|---|---|
| Branch / HEAD | `master` / `848c20fda26c4bd40d07467ba23d47f421e12f87` |
| Working tree | **153 entries** — 45 modified, 108 untracked, 0 staged |
| Migrations | exactly `0001`–`0019`, no stray file |
| `school_saas_dev` | 16 migrations (through `0016`), 13 tenants, no `report_card_subjects` |
| `school_saas_test` | 19 migrations, zero fixture rows, 0 disabled triggers, both snapshot triggers enabled |

Runtime roles: `DATABASE_URL_MIGRATOR` / `DATABASE_URL_APP`. All probing was redirected to the disposable
`school_saas_test`. `school_migrator` lacks `CREATEDB`, so `school_saas_test` had to pre-exist; I never
attempted to create a database.

**Note on `app_privileged()`.** `school_migrator` is the privileged role and **bypasses RLS entirely**. Early
in the audit a probe of mine accidentally connected as `school_migrator` while intending to test RLS, and
appeared to show a cross-tenant leak. It was not: the bypass was the cause. I re-ran against the true runtime
role `school_app_rw` and cross-tenant isolation held. I record this because it is exactly the kind of
self-inflicted false positive that produces a wrong "P0", and because it confirms the bypass is real and
load-bearing.

---

## 3. Verdict on the original defect

The defect: a published report card could carry aggregates (`gpa`, totals, `subject_count`) that disagreed
with its own subject lines, and the detail view could show a different set of lines from the totals.

**Negative control — the defect was real.** I reconstructed the pre-fix `0018` outside the repository,
removing only the freeze-disable statement, and ran it against a realistic pre-`0018` database. It failed with
the original error, and the failure rolled back cleanly:

```
a published report card's subject lines are frozen: supersede the result with a new version
  0018 not recorded in the journal
  no partial schema (to_regclass('report_card_subjects') IS NULL)
  both published cards untouched
  zero disabled triggers left behind
```

**Positive control — the fix works.** Running the corrected `0018` + `0019` over the same fixture: the
published card survives, receives exactly its correct lines with correct marks/max/weight/grades, its stale
aggregates are reconciled (`gpa 3.50 / 130 of 150` → `3.33 / 125 of 150`), no sibling-exam or cross-tenant
row is introduced, no duplicate is created, and the corrected trigger state is asserted on exit. **38/38.**

The negative control matters as much as the positive one: it demonstrates the test is *sensitive* to the
defect, so the positive result is meaningful rather than vacuous.

---

## 4. Independent probe results

196 assertions, all passing, all reproduced on a second execution.

| Probe | Assertions | Covers |
|---|---|---|
| Realistic migration (§5) | **38 / 38** | Real published card through real `0018`+`0019` |
| Negative control (§5b) | **9 / 9** | Pre-fix `0018` reproduces the defect; clean rollback |
| Snapshot integrity + RLS (§6–§11) | **45 / 45** | Malformed lines, freeze, RLS with data, coherence, immutability |
| Marker, isolation, scale, lifecycle (§9/§13–§15) | **57 / 57** | Publication marker, worker exam isolation, grade scale, exam + card lifecycle |
| Two-layer scope counterfactual (§12/§18) | **19 / 19** | Tenant vs family boundary, F-01, F-02 |
| Idempotency + posture (§4/§20) | **28 / 28** | Re-runnability, trigger posture, RLS posture, runtime-role default |

### 4.1 Every prohibited mutation of a published card is refused

Twelve distinct attacks, all refused: insert a line, update marks, delete a line, re-home a line to another
exam subject, fabricate `max_marks`, fabricate `weight`, downgrade to draft, change `exam_id`, soft-delete,
hard-delete, corrupt the aggregate. Afterwards the card still holds exactly its 2 lines and its aggregate is
still coherent.

### 4.2 Integrity still applies to drafts, without freezing them

A draft's lines reject a foreign exam subject, a fabricated `max_marks`, a fabricated `weight`, a duplicate
identity, and an identity re-home — while its marks remain rewritable and its lines deletable, because that
is precisely what the worker's recompute does. Freezing drafts would have broken the product; freezing
published cards is the point.

### 4.3 A published card may not *commit* while incoherent

Within a transaction I published a card carrying an in-range but wrong aggregate (`gpa 1.00, 7 of 8, 1
subject`). The deferred coherence trigger refused it **at COMMIT** and the card rolled back to draft. The
same transaction with the aggregate derived from `fn_report_card_totals()` published successfully. This is
the property the whole remediation exists to guarantee, and it holds.

### 4.4 The publication marker cannot be forged

`published_exam_id` is server-owned. A caller cannot set it on insert, cannot repoint it, cannot clear it,
cannot re-home the mark to a sibling exam's subject, cannot re-attribute it to another student, and cannot
soft-hide it. An *unfrozen* mark cannot be walked into a published exam either. A direct edit to a derived
column on a frozen mark does not persist — the trigger carries the established result forward, which is the
intended P1-02 behaviour.

A genuine bonus property: an **active grading scale is immutable** ("create a new version"), and `fn_exam_grade_for`
resolves an exam's **pinned** scale by id, so retiring a scale cannot silently re-grade a published result.

### 4.5 Idempotency and posture

Re-running the real runner after `0018`+`0019` applies **0 migrations** and leaves cards, lines and the
journal **byte-identical**; a third run likewise. After the chain: **zero** user triggers disabled anywhere
in the database, RLS enabled *and forced* on both `report_cards` and `report_card_subjects` with 4 policies
each, and the bare `school_app_rw` role sees 0 rows — including after forging the legacy `app.tenant_id` GUC.

---

## 5. Classification of the 7 test failures

This was the most important part of the audit, and I refused to accept either "the tests are fine" or "the
product is broken" without proof. **All 7 are test-authoring defects.**

### 5.1 The database suite — 1 failure

`packages/db/src/security/phase6-exams.test.ts:561` — `report_card_subjects: expected 0 to be greater than 0`

Section A loops over the tables and asserts tenant A sees `>0` of its own rows — but at that point in the
file **no `report_card_subjects` rows exist yet**; they are first created much later, by
`publishCardWithSnapshot` in a later section. The assertion is unrunnable as written.

I proved the RLS is correct by seeding real data: tenant A sees `>0` of its own lines, 0 of tenant B's; every
visible row is tenant A's; a cross-tenant UPDATE affects 0 rows and leaves the target value unchanged;
cross-tenant INSERT and DELETE are refused; a bare role and a forged GUC both see nothing. **The suite's
assertion is wrong about when data exists, not about who may see it.**

### 5.2 The API suite — 6 failures, one root cause

Four fail with the database's own coherence error, verbatim:

```
a published report card must agree with its own subject snapshot
  (card: gpa 3.50, total 90.00, of 100.00 over 1 subject(s); snapshot: gpa <NULL>, total <NULL>, of 0 over 0 subject(s))
```

The cause is the suite's own `publishCard` helper (`phase6-exams-acceptance.acceptance.test.ts:916-931`),
which inserts a **published** card with hard-coded aggregates and **zero snapshot rows** via privileged SQL.
That is precisely the impossible state the remediation exists to prevent, and the trigger refuses it. The
helper throws, so:

| # | Test | Failure | Classification |
|---|---|---|---|
| 1 | serves a parent their own child transcript | `publishCard` throws | test fixture forges an impossible card |
| 2 | shows a parent only their own child in the portal | `entries.length` 0, expected 1 | **consequence** of #1 — the card does not exist, so there is nothing to list |
| 3 | shows the second family their own child only | `publishCard` throws | test fixture, as #1 |
| 4 | leaves the published card stale until the worker runs | `Cannot read properties of undefined (reading 'total_obtained')` | **consequence** — the card it queries does not exist |
| 5 | does not recompute a published card inline | `versions.length` 0, expected 1 | **consequence** — same |
| 6 | does not leak a sibling exam's subject lines (F-01) | coherence error, `gpa 4.00, total 40.00, of 40.00, snapshot 0` | test fixture, as #1 |

The 2 "consequence" failures are worth calling out: they are **not** independent defects, and a reader who
only saw `expected +0 to be +1` could easily misread #2 as an over-restrictive scope check leaking nothing.
It is the opposite — a missing card.

### 5.3 Counterfactual: the product satisfies every one of these tests

I rebuilt each failing test's *intent* with a coherent fixture (card → lines → aggregate from
`fn_report_card_totals()` → publish) and real data. **19/19.** The real API publish path already does exactly
this, and its endpoint test passes; the worker's 13 pipeline tests — including "freezes version 1 at 91 while
version 2 carries the corrected 60", "is a no-op on redelivery", and "refuses to edit or delete a published
version's lines, even for the table owner" — all pass.

### 5.4 A two-layer scoping design worth stating explicitly

My first scoping probe appeared to show each parent seeing the *other family's* card. On investigation this
is **correct by design**, and understanding it is important:

- **The database enforces the tenant boundary.** Two children of the same tenant are both visible to any
  member of that tenant. A parent in a *different* tenant sees 0 cards and 0 lines.
- **The application enforces the family boundary.** `readableStudentIds()`
  (`apps/api/src/routes/school/attendance.ts:136`) derives a parent's permitted set from
  `guardians ⋈ student_guardians`; the transcript route 403s with `results_scope_denied` for any student
  outside it.

I verified the cross-tenant case empirically (0 rows for an out-of-tenant parent) and the family case against
the exact guardian join the API uses. Neither layer leaks. The residual risk is the one already documented in
`0002_trusted_context.sql`: a holder of the single runtime credential can assert any identity that has a real
membership. That is a documented, accepted, out-of-scope design decision — not a Phase 6 regression.

---

## 6. Independent probe results — required suites

| Check | Command | Result |
|---|---|---|
| Typecheck | `npx turbo run typecheck --force` | **17 / 17** successful, 0 cached |
| Build | `npx turbo run build --force` | **3 / 3** successful |
| DB suite | `RUN_RUNTIME_SECURITY_TESTS=1 vitest run` (`@sms/db`) | **321 passed, 1 failed** (322) |
| API suite | `RUN_RUNTIME_SECURITY_TESTS=1 vitest run` (`@sms/api`) | **443 passed, 6 failed** (449) |
| Worker suite | `RUN_RUNTIME_SECURITY_TESTS=1 vitest run` (`@sms/worker`) | **90 / 90** passed |
| Default test | `pnpm test` | **8 / 8** tasks, but security suites **skipped** |
| Lint | `pnpm lint` | **0 tasks executed** |

> **Correction to an intermediate reading of mine:** an early `pnpm typecheck -- --force` appeared to fail
> `@sms/contracts` and `@sms/ui`. That was my own argument-passing error — `-- --force` forwards `--force` to
> `tsc`. With the flag passed to turbo correctly, all 17 tasks pass from cold. Typecheck is genuinely clean;
> I am recording this because I reported the failure before diagnosing it.

---

## 7. Findings

No P0 or P1. The integrity design is sound and, where it matters, enforced by the database rather than by
convention.

### P2-1 — `pnpm db:migrate` silently applies nothing
**Pre-existing; outside the remediation's blast radius; operationally material.**

```
$ pnpm --filter @sms/db run migrate ; echo $?
0
# stdout: 0 bytes
```

Exit 0, no output, no migrations applied — reproduced three times, including invoking
`tsx packages/db/src/cli/migrate.ts` directly with `DATABASE_URL_MIGRATOR` supplied explicitly. I verified
that `process.argv[1]` is the correct absolute path under pnpm's script runner and that the script body *does*
execute, and that `isMainModule()` returns `true` for that path — so the guard in
`packages/db/src/cli/paths.ts` is not the cause. The top-level `await applyMigrations(...)` neither resolves
nor rejects before the process exits 0. I did not establish the internal mechanism and am not going to
guess at it; the next diagnostic step is to instrument that await.

Both `paths.ts` and `migrate.ts` are committed and **unmodified** by the Phase 6 work, so this is not a
remediation regression. It does not affect this audit's conclusions, because I invoked the real
`applyMigrations()` function directly — which is also how I established that the migrations themselves are
correct. But it is the *only* supported way to deploy the migrations under review, and it does not work.

### P2-2 — The required suites are red, and the failures mask real coverage
7 failures, all test-authoring defects (§5). Two consequences beyond the red count:

- The 3 parent-scope tests error during setup, so **the family-scope boundary is not currently being asserted
  by the suite at all**. My probe asserts it, but the probe is not in the repository and will not run in CI.
- The 2 F-02 tests query a card that was never created, so **the "stale until the worker runs" rationale and
  the "no inline recompute" property are not currently being asserted by the suite either.**

The product behaviours are correct — I proved each — but the repository's own regression protection for them
is currently absent.

### P2-3 — Nothing enforces the gate
- **No CI.** There is no `.github/` directory and no other CI configuration in the repository. Nothing runs
  typecheck, build, tests or migrations on commit or on pull requests.
- **The security suites are opt-in.** `pnpm test` skips them unless `RUN_RUNTIME_SECURITY_TESTS=1` is set
  (74 worker, 300 db, 397 api tests skipped). A default `pnpm test` run is green while the entire Phase 6
  gate is unexercised.
- **`pnpm lint` is a no-op.** `turbo.json` defines a `lint` task and the root script invokes it, but **no
  package defines a `lint` script**, so it reports success having done nothing. The only formatting tool
  present is `prettier`, with no config and no script.

### P3-1 — The `0018`/`0019` migrations have no regression test
No test file references either migration. `publishCardWithSnapshot` builds cards at *runtime*; it never runs
the migration against a pre-`0018` database. So the precise failure mode that caused this remediation — a
backfill that trips the published-card freeze — would not be caught by anything in the repository. The
negative control in §3 is the proof that such a test is both possible and necessary.

### P3-2 — `0018` does not assert the restoration of `report_cards_validate_trg`
`0018` disables it (line 773) and re-enables it (line 798) but does not assert `tgenabled = 'O'`, whereas it
*does* assert both `report_card_subjects` triggers, and `0019` *does* assert this one (line 256). Because
`0019` always runs immediately after in the same chain, the end state is still verified. This is a
defence-in-depth gap for a standalone `0018` application, not a live defect.

### P3-3 — `packages/db/src/cli/paths.ts` is a latent trap
`isMainModule()` compares `path.resolve(process.argv[1])` against `path.resolve(fileURLToPath(import.meta.url))`
— a string comparison that is sensitive to the space in `G:\School Managment system`, to realpath/case
normalisation, and to the shim used. It works under pnpm here, but it is the kind of check that fails
*silently* by design. Flagged alongside P2-1 because a silent migration command and a silent entrypoint guard
fail in the same way.

### Observation — `DROP TRIGGER IF EXISTS` (3 uses)
Standard and safe; the chain is re-runnable, which I verified by fingerprinting the database across three
runs.

### Observation — banned-pattern sweep clean
Across `0018` and `0019`: `DISABLE TRIGGER ALL` 0, `session_replication_role` 0, explicit `BEGIN;`/`COMMIT;`/
`ROLLBACK` 0, `TRUNCATE` 0, `DELETE FROM` 0. Transaction control belongs to the runner, which uses one
explicit transaction per migration and aborts on first failure — so `0019` cannot repair a failed `0018`, and
`0019` is written to be independently re-runnable.

---

## 8. Cleanup and integrity

| Check | Result |
|---|---|
| `school_saas_test` | schema dropped and rebuilt by the **real** runner → `APPLIED=19`; no fixture rows; 0 disabled triggers; both snapshot triggers `=O` — **baseline restored** |
| `school_saas_dev` | 16 migrations, 13 tenants, `report_card_subjects` absent — **untouched** |
| Repository | 45 modified / 108 untracked / 0 staged = **153**, identical to baseline; same branch; same HEAD; migrations `0001`–`0019` |
| Probes | all written outside the repository and removed; no temporary file remains |
| Only permitted addition | this report |

During the audit I briefly added and removed a throwaway script under `packages/db/src/cli/` to diagnose
P2-1, restoring `package.json` byte-for-byte; the final census above was taken after removal and matches the
baseline exactly.

---

## 9. Repeatability

Every probe was executed twice against a freshly reset database:

| Probe | Run 1 | Run 2 |
|---|---|---|
| Idempotency + posture | 28 / 28 | 28 / 28 |
| Snapshot integrity + RLS | 45 / 45 | 45 / 45 |
| Marker, isolation, scale, lifecycle | 57 / 57 | 57 / 57 |
| Two-layer scope counterfactual | 19 / 19 | 19 / 19 |
| Realistic migration | 38 / 38 | 38 / 38 |
| Negative control | 9 / 9 | 9 / 9 |

**196 assertions, identical both times, zero flakes.** The first execution of the negative control reported
8/9; the single failure was my own script asserting three published cards when the fixture correctly has two.
I corrected the script — not the product — and re-ran to a clean 9/9. Several early probe failures were also
my own faulty assumptions (a nonexistent column, an out-of-range value tripping a CHECK constraint before the
trigger under test, a mis-computed expected GPA, a shadowed variable, and the migrator/app role mix-up in
§2). In every case I corrected the probe and re-ran; none was a product defect, and I have recorded the
substantive ones here rather than quietly fixing them.

---

## 10. Conditions for upgrading to GO

The integrity design needs **no** further work. These are test, tooling and deployment conditions. All are
small and none requires a schema change.

1. **Fix the 7 failing tests** so the required suites are green. Concretely: replace the API suite's
   `publishCard` helper with the real publication order (card → lines → aggregate from
   `fn_report_card_totals()` → publish), and move the DB suite's `report_card_subjects` assertion to after
   the data exists. Then confirm the 3 parent-scope and 2 F-02 tests actually assert — today they do not.
2. **Fix `pnpm db:migrate`** so the documented command applies migrations and reports what it did. Until then
   the migrations under review cannot be deployed by their supported path.
3. **Add a migration regression test** that runs `0018`+`0019` against a seeded pre-`0018` database and
   asserts a published card survives with correct lines and reconciled aggregates — the negative control in
   §3, made permanent.
4. **Add CI** that runs typecheck, build and the security suites **with** `RUN_RUNTIME_SECURITY_TESTS=1`, and
   either wire up a linter or delete the `lint` task so it stops reporting false success.
5. **Optional (P3-2):** have `0018` assert the restoration of `report_cards_validate_trg`, matching `0019`.

Conditions 1–4 are, in my judgement, the minimum for a gate that can be called closed. Condition 5 is
hardening.

---

## 11. What I would tell the next reader

The single most important thing in this report is not a passing test count. It is that **the database now
refuses the states the tests used to assert were fine.** The API suite's `publishCard` helper wanted to insert
a published card whose aggregates described one subject while its snapshot described none. `0018`/`0019` made
that insert impossible. Six tests broke, and every one of them broke by asking for something the system is
now right to refuse.

That is the remediation working. But a green gate has to come from fixing the tests, not from relaxing the
database — and until the suite is green and something runs it automatically, "the gate is closed" is a claim
rather than a fact.
