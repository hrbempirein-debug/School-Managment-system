# Phase 6 — GO-Condition Remediation Report

**Subject:** remediation of the four GO conditions raised by
[`PHASE_6_INDEPENDENT_FINAL_RE_AUDIT_REPORT.md`](./PHASE_6_INDEPENDENT_FINAL_RE_AUDIT_REPORT.md)
**Date:** 2026-09-26
**Branch / HEAD:** `master` @ `848c20fda26c4bd40d07467ba23d47f421e12f87` — unchanged, nothing committed
**Inputs:** the independent audit report, read in full before any file was modified

---

## 0. What this remediation did and did not do

The audit's verdict was **GO WITH CONDITIONS**, and its central finding was that the Phase 6
*data-integrity property is established* — the database refuses an incoherent published report card
rather than merely avoiding it. That property was **not touched**. No migration was edited, no RLS
policy was weakened, no trigger was relaxed, no assertion was deleted, and no test was skipped or
weakened to make a suite green.

Every change below is one of:

- fixing a **test-authoring defect** (an invalid fixture that asserted something impossible, or
  asserted something vacuous);
- fixing **tooling** that silently did nothing;
- adding **missing enforcement and a missing regression test**;
- removing a **false-success command**.

Where a change could have weakened a guarantee, the change was made the other way: the strengthened
tests were proved by counterfactual to actually fail when the guarantee is removed.

---

## 1. Condition 1 — the 7 failing tests

**Audit finding:** 7 tests across the required suites failed. All 7 were test-authoring defects.

### 1.1 The original 7, and what each was actually asserting

| Suite | Test | Real cause |
|---|---|---|
| DB | snapshot isolation (3 tests) | A cross-tenant row was minted with `session_replication_role`, and teardown deleted a parent before its child |
| API | published-card immutability (2) | The fixture built an **incoherent** card (aggregate disagreeing with its own lines) and then asserted the trigger would reject it. The trigger correctly rejected the *fixture*; the test was wrong, not the trigger |
| API | `F-01` sibling-card insert | Same: an impossible cross-exam line was inserted and the rejection attributed to the wrong rule |
| API | `F-02` (2) | The API **does not** recompute inline by design, so a card *stays* stale until the worker runs. The test asserted the opposite |

### 1.2 The real fix: one authoritative publication helper

Three files had each re-implemented "mint a report card" with slightly different arithmetic, and each
got a different one wrong. They now share
[`packages/db/src/testing/publish-card.ts`](../packages/db/src/testing/publish-card.ts), which writes
a card in the one order the schema permits — draft row → snapshot lines scoped to **that card's own
exam** → aggregate recomputed by `fn_report_card_totals()` → publication only once the card agrees
with its own body. No test re-derives a total by hand, so a card can no longer be published
incoherent even by accident.

### 1.3 The isolation tests were passing for the wrong reason

This is the most important finding in this section, and the audit did not raise it.

The three snapshot-isolation tests asserted that tenant A cannot see tenant B's rows. I replaced the
`report_card_subjects` SELECT policy with `using (true)` — removing tenant isolation entirely — and
**the tests still passed.** They were vacuous: the fixture only ever created tenant A's data, so
"tenant B's rows are invisible" was true because tenant B had no rows.

The fixture now builds a genuine tenant B, and the sweep first asserts tenant B **has** rows in every
Phase 6 table before asserting tenant A cannot see them. With the same policy sabotage, **3 tests
fail** (`report_card_subjects: expected 3 to be 0`, `expected 2 to be 0`, and a changed error code).
The policy was then restored from the exact SQL text in migration `0018`, and all four
`report_card_subjects` policies were verified byte-identical to their pre-sabotage definitions.

### 1.4 A genuine layering discovery

`4c` originally asserted a cross-tenant snapshot `INSERT` is refused with `42501` (RLS). It is refused
with **`55000`**, `"exam subject not found"`, and always was. `trg_report_card_subjects_validate()`
and `trg_report_card_subjects_freeze()` are both `SECURITY INVOKER` and both call
`fn_report_card_line_assert_valid()` **before** consulting the card's status. That function resolves
the foreign exam subject *through the very RLS it sits behind*, so under a tenant-A context it finds
nothing and raises first.

This is defence in depth working, not a hole — the write is refused either way. The test now proves
**both** layers rather than asserting a mechanism that never runs:

1. with all triggers armed, the write is refused (`55000`, trigger first);
2. with both integrity triggers lifted by name, the *same* write is refused by the RLS `WITH CHECK`
   policy alone (`42501`), and the triggers are re-enabled in a `finally` and asserted `tgenabled = 'O'`.

An independent auditor should know the ordering exists: for this table the trigger is the first line
of defence and the policy is the backstop.

### 1.5 F-02, stated honestly

The API suite cannot run the worker: `@sms/api` does not depend on `@sms/worker`, and adding an
app-to-app dependency to close a test would be the wrong fix. F-02 is therefore pinned from both ends:

- **API suite (35/35):** the correction moves the mark through the real endpoint; the published card
  does **not** move; exactly one published version exists and no version 2 was minted behind the
  worker's back; and the queued `exam.result.compute` event's payload is asserted to name the right
  `tenantId`/`examId`/`markId` — the exact fields `makeResultComputeHandler` reads.
- **Worker suite (13/13):** `makeResultComputeHandler` is driven directly and asserted to mint
  version 2 with the corrected total while version 1 stays frozen at its published value.

An earlier draft of the API test carried a comment claiming supersession "produces version 2" while
never running the worker. That claim was false and has been removed rather than left standing.

The contract boundary, stated so it cannot be misread: the **API emits, the worker consumes**. The
API's obligation ends at enqueueing a well-formed `exam.result.compute` command inside the
correction's own transaction — it performs no recompute and mints no version. The worker's obligation
begins at reading that command. Neither suite covers the other's half, which is why each asserts its
own edge of the same payload: the API asserts the command that is *emitted*, the worker asserts the
version 2 that *consuming* it produces. A green pair proves the handoff is well-formed in both
directions; it is not, and is not claimed to be, a single end-to-end run.

---

## 2. Condition 2 — `pnpm db:migrate` silently did nothing

### 2.1 Root cause (established, not guessed)

`isMainModule()` in [`packages/db/src/cli/paths.ts`](../packages/db/src/cli/paths.ts) compared
`process.argv[1]` against **its own** `import.meta.url` — that of `paths.ts`. For every real CLI entry
point the comparison was therefore false, so `if (isMainModule(import.meta.url))` never ran: the
process exited 0 having applied nothing and printed nothing.

`isMainModule(metaUrl)` now takes the **caller's** `import.meta.url`, and `migrate.ts`,
`migrate-down.ts` and `seed.ts` each pass their own. `migrate.ts` also reports failures and sets a
non-zero exit code instead of dying silently.

### 2.2 Verified against a real database, not a unit test

| Scenario | Result |
|---|---|
| Empty schema | applied `0001` … `0019`, listed by name, exit 0 |
| Already current | `migrations applied: (none) \| already applied: 19` + `database is already up to date; nothing to migrate` |
| Re-run x2 | identical output, identical schema fingerprint (60 tables, 19 migrations) |
| Deliberately broken `0020` probe | `migration failed: … division by zero`, **exit 1**, partial table absent, `0020` absent from the journal, total still 19 |

The probe migration was removed. The same shell assertions CI runs were executed locally against a
genuinely emptied disposable database and pass.

---

## 3. Condition 3 — nothing enforced any of this

### 3.1 CI

[` .github/workflows/phase6-security.yml`](../.github/workflows/phase6-security.yml) runs on every push
and pull request with PostgreSQL 16 and Redis 7 services. It does **not** rely on `pnpm test` picking
the security suites up: each is an explicit step with `RUN_RUNTIME_SECURITY_TESTS=1`, so a suite cannot
be silently skipped again.

Steps: bootstrap roles/databases via the operator's own `scripts/bootstrap.sql` → **assert the runtime
role has neither `rolsuper` nor `rolbypassrls`** (an isolation suite run against a role that can bypass
RLS proves nothing) → typecheck → build → migration-CLI assertions → migration regression → DB security
→ API security → worker result pipeline → default suite.

### 3.2 The lint false-success

The repository previously exposed `pnpm lint`, but it executed zero tasks because no package defined a
`lint` script. The no-op task was **removed** rather than introducing a repo-wide formatter or linter
during the security remediation. The root `lint` script and the empty `turbo.json` task are gone; no
`.prettierrc` was added; **no file was reformatted**. ESLint adoption or a repo-wide Prettier policy
(≈141 existing files do not match Prettier's output) is intentionally deferred as a separate
engineering change. `pnpm lint` now exits non-zero with `Command "lint" not found`, so nothing reports
success without having checked anything.

`docs/DEPLOYMENT.md` no longer lists `pnpm lint` among the target scripts and states the position. The
independent audit report's **findings were left unedited** — a clearly-marked addendum records that the
command has since been removed, because editing an independent audit's findings would destroy the very
independence that made it worth reading.

### 3.3 No other gate was weakened

`pnpm test`, `pnpm typecheck` and `pnpm build` are unchanged in behaviour. The security suites remain
opt-in **locally** by design (they need a database); what changed is that CI no longer depends on
anyone remembering to set the flag.

---

## 4. Condition 4 — the `0018`/`0019` migrations had no regression test

[`packages/db/src/security/phase6-migration-regression.test.ts`](../packages/db/src/security/phase6-migration-regression.test.ts)
(5 tests) rebuilds a real pre-`0018` world and re-proves the backfill on every run:

1. **The "before" state is real, not simulated.** It drops and recreates `public`, applies the real
   `0001`–`0017` through the **real** `applyMigrations()`, and plants a genuinely published card with
   **no** snapshot lines — the world as it was. (The migration role owns the database, so this needs
   no `CREATEDB` and no superuser.)
2. **The negative control.** Before the real run, the same fixture is migrated with a doctored `0018` —
   the real file with `ALTER TABLE report_card_subjects ENABLE TRIGGER report_card_subjects_freeze_trg;`
   removed. That run **must abort**, and the test asserts it does, on the specific
   `post-backfill assertion failed` message. *If the doctored migration ever succeeded, this test
   fails*, so a future edit that weakens `0018` cannot leave the suite green.
3. **The abort is clean.** Fingerprint unchanged, the table `0018` created is gone again, the journal
   never learned the file existed — the freeze is restored by the transaction, not by a promise.
4. **Postconditions after the real `0018` + `0019`:** exactly one backfilled line for the historical
   card; the line names the card's **own** exam subject; `max_marks`/`weight` are copies and the grade
   is the mark's own; the stored aggregate equals `fn_report_card_totals()`; no row count lost and the
   snapshot table is the only thing that grew; both triggers `tgenabled = 'O'`; RLS **and** FORCE RLS on;
   the owner — holding every grant — is still refused `UPDATE`/`DELETE` on a published line; both
   migrations journalled exactly once; a re-run applies nothing and changes nothing.
5. **A draft card is still writable**, which is the property that justified lifting the freeze for the
   backfill at all: the ordinary path needs no exemption, only unreachable history did.

Optional item **P3-2 was already satisfied** — the trigger-restoration assertion is in `0018` at lines
673–698, and the new negative control proves it is load-bearing rather than decorative.

---

## 5. Exact files changed

**New (3)**

| File | Purpose |
|---|---|
| `.github/workflows/phase6-security.yml` | the enforcing CI gate |
| `packages/db/src/security/phase6-migration-regression.test.ts` | `0018`/`0019` regression + negative control |
| `packages/db/src/testing/publish-card.ts` | shared, coherent card-publication fixture helper |

**Modified (11)**

| File | Change |
|---|---|
| `packages/db/src/cli/paths.ts` | `isMainModule(metaUrl)` takes the caller's URL |
| `packages/db/src/cli/migrate.ts` | pass own URL; report failures; non-zero exit |
| `packages/db/src/cli/migrate-down.ts` | pass own URL |
| `packages/db/src/cli/seed.ts` | pass own URL |
| `packages/db/src/security/phase6-exams.test.ts` | shared helper; real tenant-B control; tests 4, 4b, 4c, 4d; teardown order |
| `apps/api/src/security/phase6-exams-acceptance.acceptance.test.ts` | shared helper; F-01 fixture; F-02 staleness + command payload; teardown guards |
| `package.json` | removed the no-op `lint` script |
| `turbo.json` | removed the empty `lint` task |
| `docs/DEPLOYMENT.md` | `pnpm lint` removed from target scripts; position stated |
| `docs/PHASE_6_REMEDIATION_REPORT.md` | stale lint row annotated as removed |
| `docs/PHASE_6_INDEPENDENT_FINAL_RE_AUDIT_REPORT.md` | marked addendum only; **findings unedited** |

`packages/db/src/security/phase6-exams.test.ts` and
`apps/api/src/security/phase6-exams-acceptance.acceptance.test.ts` are **untracked** in this repository
(the security suites were never committed), which is why they do not appear as `M`.

**Not changed:** any file under `packages/db/migrations/`; any RLS policy, trigger or function; the
model; `apps/worker/src/exams.ts`. **No file was reformatted for style.** No unrelated pre-existing
modification was reverted.

---

## 6. Verification

| Gate | Baseline (audit) | Now |
|---|---|---|
| DB package | 321 passed, **1 failed** | **330 passed, 0 failed** (19 files) |
| API package | 443 passed, **6 failed** | **449 passed, 0 failed** (21 files) |
| Worker package | 90 passed | **90 passed** (6 files) |
| DB security suite | — | **87/87** |
| API security acceptance | — | **35/35** |
| Worker result pipeline | — | **13/13** |
| Migration regression | did not exist | **5/5** |
| Typecheck | 17/17 | **17/17** |
| Build | 3/3 | **3/3** |
| Default `pnpm test` | green, security skipped | **8/8 tasks, security skipped** |
| `pnpm lint` | **false success (0 tasks)** | **exits 1 — command does not exist** |
| Migration CLI, empty DB | silent no-op | applies `0001`–`0019` by name |
| Migration CLI, re-run | silent | explicit `already applied: 19`, `up to date` |
| Migration CLI, broken SQL | silent | `migration failed: …`, **exit 1**, rolled back |

Net: the 7 failures are fixed (+8 new tests), and `330 = 322 baseline + 8`, `449 = 449 baseline`.

**Counterfactuals** (each proves a test can actually fail):

| Sabotage | Result |
|---|---|
| `report_card_subjects` SELECT → `using (true)` | **3 tests fail** (0 failed before the fix — the tests were vacuous) |
| `0018` freeze-restoration line removed | migration aborts on the post-backfill assertion; test **passes**, i.e. the control bites |
| `0020` broken migration | CLI exit 1, rollback, no journal row |

**Database hygiene.** `school_saas_test` (disposable): 19 migrations, 60 tables, **0 disabled
triggers**, 0 leftover rows — the regression test leaves it empty and fully migrated, because a
leftover tenant is the cross-run contamination this workspace has been bitten by before.
`school_saas_dev`: **16 migrations, 0 disabled triggers, data untouched** (13 tenants, 254 users, 30
students, 113 outbox events) — identical to the remediation-start baseline. No destructive command was
ever aimed at development. All temporary probe files were removed; `git status` shows none.

---

## 7. Limitations an independent auditor should check

These are real, and I would rather state them than have them discovered.

1. **The CI workflow has never been executed.** No CI runner was available here. Its YAML parses, its
   toolchain versions match `packageManager`/`engines`, and every command it runs was executed locally
   and passes — but the workflow itself is unproven until its first real run. That first run is the
   confirming event for condition 3.
2. **The CI database bootstrap is unexercised.** It runs the operator's own unchanged
   `scripts/bootstrap.sql` as superuser, which I could not do locally (`school_migrator` has no
   `CREATEDB` and no superuser credential is available). Note this also means the regression test
   cannot provision its own second database; it rebuilds the disposable one in place instead.
3. **The regression test must not run concurrently with other suites on the same database**, because
   it rebuilds `public`. Mitigated by `fileParallelism: false` in `packages/db/vitest.config.ts` and
   by CI running it as its own step.
4. **F-02 is proven across two suites, not end-to-end in one**, by design — `@sms/api` deliberately
   does not depend on `@sms/worker`. The seam (the outbox payload the worker reads) is asserted
   explicitly rather than assumed.
5. **The layering note in §1.4** is a design observation, not a defect, but it means the `42501`
   expectation for `report_card_subjects` was never reachable through a live trigger and should not be
   reintroduced as an assertion.

Two pre-existing build warnings (`no output files found for task @sms/api#build` / `@sms/worker#build`)
are unrelated to this work and were left alone.

---

## 8. Disposition of the audit's four conditions

| # | Condition | Status |
|---|---|---|
| 1 | 7 tests fail | **Resolved.** All suites green; the isolation tests additionally proved to have been vacuous and are now non-vacuous (3-test counterfactual). |
| 2 | `pnpm db:migrate` silently does nothing | **Resolved.** Root cause fixed in the CLI; verified on an empty database, on re-runs, and against a failing migration; asserted in CI. |
| 3 | Nothing enforces any of this | **Resolved, with the caveat in §7.1.** CI gate added with explicit, non-opt-in security steps and a no-`BYPASSRLS` assertion; the `pnpm lint` false success removed rather than papered over. |
| 4 | `0018`/`0019` have no regression test | **Resolved.** Real pre-`0018` database, real runner, mandatory negative control, nine postconditions including the no-privileged-backdoor check. |

The Phase 6 integrity design was not modified, and no finding in the independent audit was
contradicted — only completed.

---

## 9. Implementation status

READY FOR INDEPENDENT FINAL RE-AUDIT
