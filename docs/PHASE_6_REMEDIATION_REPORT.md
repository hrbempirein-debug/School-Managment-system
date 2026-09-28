# PHASE 6 REMEDIATION REPORT

Forward-only remediation of the Phase 6 result-integrity work, in two rounds:

- **Round 1** — the F-01 … F-08 audit, remediated by `0016_phase6_result_integrity_fixes.sql`.
- **Round 2** — the final re-audit (P1-01, P1-02, P2-01, P2-02, P2-03, P3-01, P3-02, P3-03),
  remediated by `0017_phase6_result_publication_integrity.sql`.

This report is the cumulative record and supersedes the completion claim in
[`PHASE_6_REPORT.md`](./PHASE_6_REPORT.md), which described the original delivery. No historical
migration was edited: `0015_exams_results.sql` is untouched, and every schema change in both rounds
is either additive or a `CREATE OR REPLACE` of a function an earlier migration installed.

> ### Addendum — rounds 3 and 4 (this document is no longer the whole record)
>
> Two later rounds post-date the text below, so two statements in it are now out of date. Both are
> corrected here rather than by editing the sections, so the original reasoning stays readable.
>
> 1. **§10's "Report cards are not snapshotted per subject" is obsolete.** It describes the
>    `report_card_subjects` table as a deferred design decision for the re-auditor. That decision was
>    taken: `0018_phase6_final_result_snapshot_integrity.sql` and
>    `0019_phase6_report_card_snapshot_reconciliation.sql` add the table, the
>    `report_cards_snapshot_coherent_trg` deferred constraint trigger that refuses a published card
>    which disagrees with its own lines, and the reconciliation of aggregates for pre-existing
>    cards. The caveat about a PDF mixing a frozen total with live lines is therefore closed for new
>    publications; cards published before 0018 are reconciled in place by 0019.
> 2. **§11's "fifteen findings across both rounds" is now three rounds and a gate audit.** Round 3 is
>    `0018`/`0019` above. Round 4 addressed findings P2-1, P2-2, P2-3, P3-1 and P3-2 from
>    [`PHASE_6_INDEPENDENT_FINAL_RE_AUDIT_REPORT_R2.md`](./PHASE_6_INDEPENDENT_FINAL_RE_AUDIT_REPORT_R2.md),
>    which were all defects in the **gate and its evidence** rather than in the integrity model.
>    Those are recorded in full, with their counterfactual proofs, in
>    [`PHASE_6_P2_P3_REMEDIATION_REPORT.md`](./PHASE_6_P2_P3_REMEDIATION_REPORT.md).
>
> §11's closing claim that the one gap for a re-auditor is environmental no longer holds on its own:
> the API and worker suites now run green in this environment, but a new gap opened in round 4 —
> **none of Phase 6 is inside HEAD's tree**, so the committed repository still cannot run this gate.
> See §5 of the round-4 report.
>
> 3. **§7's "DB security, Phase 6 — 84 passed" is a stale count, not a stale result.** 84 was the
>    size of that suite when §7 was written (the neighbouring "322 passed (18 files)" and the
>    "grew 38 → 63 → 84" line are consistent with it). The P2/P3 round then added three tests to
>    the same file, so the suite is now **87**, and §7's row is one round behind. The §7 text is
>    left as written for the same reason as items 1 and 2. Current measured figures, all
>    re-verified in this round: DB security Phase 6 **87/87**, DB package all suites **330/330**,
>    migration regression **5/5**, API Phase 6 acceptance **35/35**, worker result pipeline
>    **13/13**. See [`PHASE_6_RELEASE_PREPARATION_REPORT.md`](./PHASE_6_RELEASE_PREPARATION_REPORT.md).
>
>    Two related counts in §7 were never wrong about *this* round and are left alone: the API
>    package's "71 passed, 378 skipped" and the worker's "82 passed, 7 failed (Redis)" are
>    Redis-gated results from an environment that no longer has Redis available, and they are
>    reported as such.
>
> 4. **Runtime security testing is explicitly scoped to sequential workflow steps.** §7's command
>    column writes `RUN_RUNTIME_SECURITY_TESTS=1` in front of package-wide `vitest run`
>    invocations. That is accurate as a *local, single-package* command. It must not be read as a
>    shape to reproduce in CI: all packages share one `DATABASE_URL_TEST`, and
>    `pnpm test` is `pnpm turbo run test`, which fans the package test tasks out in parallel. The
>    migration regression harness rebuilds the shared disposable schema, so if that variable is
>    inherited globally the full suite fails nondeterministically. The gate therefore runs each
>    DB-backed security suite as its own **sequential** step with the variable set on that step
>    alone. `.github/workflows/phase6-security.yml` states this as a rule, and it is the only
>    supported way to run the destructive suites.

---

## 1. Scope and method

Fifteen findings against exams, results and report cards. Each was reproduced against a real
PostgreSQL instance **before** being fixed, and each fix is pinned by a regression test.

Constraints observed throughout both rounds:

- No `git commit`, `push`, `reset`, `stash`, `clean`, rebase, or history rewrite. The working tree
  is left as found, together with the unrelated modifications it already contained.
- `0015_exams_results.sql` was not modified. Round 2 adds only `0017`.
- RLS and `FORCE RLS`, RBAC, the tenant scoping of every table, the append-only correction ledger,
  report-card versioning and worker idempotency were preserved.
- Runtime suites ran against the disposable test database only. `school_saas_dev` received no write
  statement in round 2 and is still journalled at `0016`.

## 2. Findings and dispositions

| ID | Finding | Disposition |
| --- | --- | --- |
| F-01 | `loadSubjectLines()` did not scope by exam, so a sibling exam in the same year leaked its subject lines into a published report card and transcript. | Fixed in the API; exam filter added. |
| F-02 | A published correction enqueued the `result.corrected` fact but no recompute command, so the report card stayed stale forever. The correction UPDATE also guarded only `status`. | Recompute now enqueued in the correction transaction; `marks_obtained` added to the compare-and-swap. |
| F-03 | The published-exam guard froze only the mark's *value*, not its identity; other columns were freely rewritable, and a privileged `DELETE` was possible. | Superseded by P1-01: the freeze is now driven by a server-owned marker rather than by the mark's own mutable columns. |
| F-04 | `gradePoint` was nullable and unbounded, so a band could carry a null or out-of-range grade point. | `NOT NULL` plus a `0..4` range check. |
| F-05 | Runtime security suites ran against the **development** database, so fixtures mutated real tenant data. | Disposable, name-gated test database harness. |
| F-06 | 34 public Phase 6 trigger/helper functions did not pin `search_path`. | All 34 pinned; the test asserts the whole inventory, so a future unpinned function is caught. |
| F-07 | Scale resolution required `is_active` even for the exam's **pinned** scale, so retiring a scale emptied the band list and republished null grades over a published result. | Pinned scale resolves by id regardless of active state; deterministic active fallback. |
| F-08 | Duplicate band labels were accepted within one scale. | Unique `(scale, label)`. |
| P1-01 | The database decided "is this a published result?" by following the mark's current, writable `exam_subject_id`. A mark could be walked out of the published exam and shed every guard meant to protect it; the DELETE guard resolved the exam through the same mutable column. | **The publication marker** — `marks.published_exam_id` + `marks.frozen_at`, written together by the publication sweep, immutable and server-owned. The freeze and the delete guard now decide from the marker, and the current exam is consulted only as a second, independent reason. A mark may also no longer be walked *into* a published exam. |
| P1-02 | Publication re-derived the result instead of freezing the one already established, so a grading scale edited after marks were entered retroactively re-graded them — a silent correction with no ledger row. | The mark trigger re-derives only when `marks_obtained` actually changes. The publication sweep locks and stamps, preserving the stored result. A changed published value still requires a matching `mark_corrections` row, which is the only path that re-derives. |
| P2-01 | `exams.grading_scale_id` stayed writable for the whole life of the exam, so the rule a result was graded against could be swapped out from under it. | The pin is refused while the exam is `grading`/`published` and refused as soon as any mark exists. A `draft`/`scheduled` exam with no marks may still choose its scale, which is what 0016 deliberately allowed. |
| P2-02 | The documented one-way lifecycle was not enforced: `grading -> scheduled` was accepted. | `grading -> scheduled` refused; `published` and `cancelled` terminal; nothing returns to `draft`. |
| P2-03 | A privileged session could hard-DELETE a published report card, destroying the frozen snapshot. | `report_cards_hard_delete_guard_trg` for every role, with no bypass. |
| P3-01 | `marks.updated_at` was `DEFAULT now()` with no trigger, so it claimed "updated" while being insertion-only. The Drizzle `$onUpdate` is an ORM-side helper and does nothing for raw SQL, the outbox, or psql. | `marks_touch_updated_at_trg` stamps the column on every update. |
| P3-02 | `is_active` was the only thing protecting a grading scale's bands, so retiring a scale unlocked the rule that produced every grade already stored under it. | The bands of a scale pinned by an exam that is grading/published or already has marks are immutable; a new version is required. Unrelated active scales are unaffected. |
| P3-03 | Multiple active versions of one scale code left "which version" ambiguous. | No change needed: resolution is already deterministic (newest active version, then creation time, then id), and each exam carries an explicit pin. Pinned by a regression test that documents the behaviour. |

## 3. Schema changes

### 3.1 `0016_phase6_result_integrity_fixes.sql` (round 1)

- Published-mark freeze and unconditional delete guard (both later superseded in spirit by P1-01).
- `gradePoint` becomes `NOT NULL` with a `0 .. 4` range constraint. Zero is a valid grade point.
- Unique band labels within a scale.
- Lifecycle materialisation of `exams.grading_scale_id`, with backfill, so a published exam keeps
  resolving the scale it was graded against.
- `search_path` pinning for the Phase 6 surface: 34 public `trg_%` / `fn_%` functions were pinned in
  round 1, and `0017` added two more (`trg_report_cards_hard_delete_guard`,
  `trg_marks_touch_updated_at`), both pinned. The F-06 test asserts the whole catalog rather than a
  fixed list, and guards against a vacuous pass, so the live figure is now **36 functions, 0
  unpinned**.

### 3.2 `0017_phase6_result_publication_integrity.sql` (round 2)

- **The publication marker.** `marks.published_exam_id uuid` and `marks.frozen_at timestamptz`, a
  composite FK to `exams (tenant_id, id)`, a CHECK that they are set or clear together, a partial
  index on `(tenant_id, published_exam_id)`, and column comments recording why the marker exists
  instead of `exam_subject_id`. Existing marks belonging to a published exam are backfilled, and the
  backfill deliberately includes soft-deleted rows so a hidden published result is stamped too.
- **Mark trigger rebuilt around the marker.** Marker ownership (no role may set, move or clear it;
  the trigger is the only writer), the freeze itself, the refusal to re-point `exam_subject_id`, the
  refusal to move a mark into a published exam, and value-change-only re-derivation.
- **Delete guard driven by the marker**, with no role bypass, matching the append-only ledger.
- **Publication sweep** covering provisional, locked, rechecked and soft-deleted marks in one
  statement, so a result can never be published with part of its mark set unfrozen.
- **Exam lifecycle**: scale pin frozen from `grading` onward and once marks exist; `grading ->
  scheduled` refused; `published_at` required to publish.
- **`report_cards_hard_delete_guard_trg`**, every role, no bypass.
- **`marks_touch_updated_at_trg`**, stamping `updated_at` with the transaction clock — so every mark
  a single publication freezes carries the same instant.
- **Grading-scale guard**: bands that produced a result are immutable; band labels unique per scale;
  `gradePoint` required and bounded.

Schema parity: `packages/db/src/schema.ts` declares `publishedExamId`, `frozenAt`, the partial
index, the composite foreign key and the CHECK, so Drizzle and PostgreSQL agree.

`school_saas_test` is journalled at `0017_phase6_result_publication_integrity.sql` (17 entries).
`school_saas_dev` is deliberately left at `0016` (16 entries).

## 4. Application changes

Round 2 changed no business logic. The API additions are error mappings plus the regression tests
that cover them:

- `apps/api/src/routes/school/util.ts` — eleven new SQLSTATE `55000` mappings for the messages
  `0017` introduces (`mark_publication_marker_immutable`, `mark_published_frozen`,
  `exam_published_closed_to_marks`, `mark_published_immutable`,
  `report_card_published_immutable`, `exam_scale_frozen_in_status`,
  `exam_scale_frozen_has_marks`, `exam_publication_needs_timestamp`, `grading_band_point_required`,
  `grading_band_duplicate_label`, `grading_bands_result_immutable`). Each regex keys off the stable
  message prefix, because the triggers interpolate their arguments; the client never sees raw
  PostgreSQL text.
- `apps/api/src/routes/school/util.test.ts` — one case per mapping, asserting the code, the status
  and that no server-side detail leaks.
- `turbo.json` — `@sms/api#test` and `@sms/worker#test` no longer depend on another package's `test`
  task. Cross-package test orchestration serialised three suites against one disposable database for
  no benefit; `^build` is kept.

Two API call sites were re-read against the new triggers rather than assumed compatible, because
both issue statements the triggers now police:

- `POST /exams/:id/publish` sets `status` and `published_at` in the **same** UPDATE, satisfying the
  new `publication requires published_at` rule and the sweep's `FROM ... published_at IS NOT NULL`.
- `POST /exams/:id/marks/:markId/correct` inserts the `mark_corrections` row **before** the mark
  UPDATE, in one transaction. `0017` requires exactly that ordering: the trigger looks for a ledger
  row matching `(old_marks_obtained, new_marks_obtained)` when the value changes, which is why the
  correction workflow keeps working unchanged and no GUC escape hatch was needed.

## 5. Test isolation

`packages/db/src/testing/` provides `runtime-db.ts` (resolves `DATABASE_URL_TEST` and refuses any
name that is not `_test` / `test_` prefixed — there is no override flag), `global-setup.ts`
(validates, creates if absent, migrates), and `setup-env.ts` (repoints per-worker variables before
any import). All three Vitest configs use it and `fileParallelism` is disabled per package.

This round added three harness corrections, all of them consequences of the new guards rather than
new isolation policy:

- The Phase 6 DB suite and the worker pipeline suite lift `report_cards_hard_delete_guard_trg` for
  their own teardown statements and re-enable it in the same transaction, exactly as they already
  did for the marks and corrections guards.
- `platform_role_assignments` is a **global** table. Three assertions counted every row in the
  database, so they measured other suites' leftovers instead of the boundary under test. They are
  now scoped to the suite's own users in `trust-boundary.test.ts` and
  `impersonation-boundary.test.ts`.

## 6. Database safety verification

Measured after a full DB run and a full worker run against the cleaned test database:

| Check | `school_saas_test` | `school_saas_dev` |
| --- | --- | --- |
| Migration journal | `0017` (17 entries) | `0016` (16 entries) — untouched |
| `marks` / `report_cards` / `exams` left | 0 / 0 / 0 | 0 / 0 / — |
| Marks carrying a publication marker | 0 | column absent |
| Users / roles / memberships left | 0 / 0 / 0 | — / — / — (unchanged) |
| Tenant rows left | 1, an empty `Outbox Suite Tenant` from the Redis-gated worker suite | 13 (unchanged) |
| Disabled triggers | 0 | 0 |

The test database was left dirty by earlier runs in this session — probe fixtures, and API/worker
acceptance fixtures whose teardown could not complete because those suites abort in `beforeAll`
without Redis (see §10). That residue was removed: every deletion was driven from a selected list of
exact row ids, in dependency order, inside a transaction that re-enables each lifted trigger before
committing. No pattern-based deletion was used against `school_saas_dev`, and no statement other
than a read was ever issued against it.

Deliberately left in the test database: 1706 `audit_logs` rows and 4 already-dispatched
`outbox_events` rows (`user.created` / `user.login`, tenant-less global rows produced by the trust
boundary suite). Deleting audit history is not a test-hygiene operation.

## 7. Regression evidence

| Suite | Result | Command (from the package directory) |
| --- | --- | --- |
| DB security, Phase 6 | **84 passed** | `RUN_RUNTIME_SECURITY_TESTS=1 npx vitest run src/security/phase6-exams.test.ts` |
| DB package, all suites | **322 passed** (18 files) | `RUN_RUNTIME_SECURITY_TESTS=1 npx vitest run` |
| API error-envelope unit tests | **23 passed** | `npx vitest run src/routes/school/util.test.ts` |
| API package | 71 passed, **378 skipped** (Redis-gated) | `npx vitest run` |
| Worker result pipeline + result unit | **28 passed** | `RUN_RUNTIME_SECURITY_TESTS=1 npx vitest run src/exams-result-pipeline.test.ts src/exams.test.ts` |
| Worker package | 82 passed, **7 failed** (Redis) | `RUN_RUNTIME_SECURITY_TESTS=1 npx vitest run` |
| core / config / web / permissions / storage | 22 / 2 / 133 / 30 / 13 passed | `npx vitest run` |
| Typecheck | 17/17 tasks | `pnpm turbo run typecheck` |
| Build | 3/3 tasks | `pnpm turbo run build` |
| Whitespace | clean | `git diff --check` |
| Lint | **not run — no package defines a `lint` task** (`turbo` reports 0 tasks) | `pnpm turbo run lint` (since removed — see `PHASE_6_GO_CONDITION_REMEDIATION_REPORT.md`) |

The Phase 6 DB suite grew 38 (original delivery) → 63 (round 1) → **84** (round 2). The 21 new
tests are organised by finding: P1-01 (7), P1-02 (2), P2-01 (3), P2-02 (2), P2-03 (2), P3-01 (1),
P3-02 (3), P3-03 (1).

## 8. Verified in the failing direction

Round 1, verified by re-running each test with its fix removed:

- The F-02 concurrency test fails without the score compare-and-swap, reporting
  `mark_correction_required` instead of `mark_conflict` — the client was being told about a
  storage-layer guard rather than an honest concurrency conflict.
- The worker result-pipeline suite reproduces F-07 against the unfixed resolution: a retired pinned
  scale produced a second published version carrying null grades over an already-published result.

Round 2: every P-round defect was reproduced against the `0016` schema with standalone SQL probes
before the migration was written — the re-point of a published mark's `exam_subject_id`, the
soft-delete, the re-grade on publication, the mid-flight scale swap, the `grading -> scheduled`
transition, the privileged hard delete of a published card, and the stale `updated_at`. Those
probe results are the basis of the findings above.

What was **not** done: the 21 new tests were not re-run against a reverted schema. `0017` has no
down migration, and building a second database at `0016` requires a superuser (`school_migrator`
deliberately has no `CREATEDB`). The tests therefore assert the fixed behaviour, and the
reproduction evidence for the defects is the probe output, not a red test run.

## 9. Pre-existing damage — disclosed, not touched

- `school_saas_dev` retains unattached `@example.com` users and a tenant (`p3l294cb92a-a`) whose
  student parent links were removed by an earlier broad cleanup pattern. Left exactly as found: the
  correct repair is a reconciliation decision, and pattern-based deletion is what caused the harm.
- The count of unattached users in `school_saas_dev` differs from the figure quoted in the round-1
  report. Nothing in this round wrote to that database — its journal, tenant count, marks and
  triggers are unchanged — so the difference predates this work or came from elsewhere.
- The Drizzle `$onUpdate(() => sql`now()`)` → `$onUpdate(() => new Date())` change visible in
  `packages/db/src/schema.ts` was already in the working tree and is not part of this remediation;
  only the marks publication-marker block was added here.

## 10. Deferred, unverified, and known caveats

- **Redis is unavailable in this environment, so the Redis-dependent suites could not be run:**
  7 worker outbox/BullMQ integration tests fail with `Connection is closed`, and all 378 Redis-gated
  API tests — including the 35-test Phase 6 API acceptance suite — abort in `beforeAll` and are
  skipped. The round-1 report recorded 438 API tests passing; that was measured earlier in the
  session while Redis was reachable and is **not** re-verified now. No claim in §7 depends on it.
- The Phase 6 API acceptance suite is the one piece of evidence that would exercise the new
  constraints through real HTTP. It should be run wherever Redis is available before the re-audit.
- **Report cards are not snapshotted per subject.** `report_cards` stores aggregate totals, while
  the PDF subject lines are rendered from live `marks`. A correction to a published result therefore
  converges the stored aggregate but not an already-rendered PDF, which can mix a frozen total with
  live subject lines. This was assessed and deliberately **not** changed: it is a pre-existing
  consequence of P1-01 being fixed correctly (marks stay correct and attributed), no audit finding
  covered it, and the alternative — a `report_card_subjects` snapshot table — is a new table and a
  new API/worker contract, i.e. a design decision for the re-auditor rather than a remediation.
- A long-running `pnpm dev:worker` shares the outbox and will execute other suites' batches. It was
  not running during any run in §7.
- The harness validates, creates and migrates the disposable database but does not drop or reset it
  between runs; isolation is enforced per fixture.
- Lint remains unexecutable repository-wide, which is a pre-existing gap rather than a pass.

## 11. Conclusion

All fifteen findings across both rounds are fixed, and every fix is pinned by a test in a suite that
passes. The database, not the application, now decides what a published result means: the marker is
server-owned and immutable, publication freezes rather than recomputes, the grading rule is pinned
before marks can exist, the lifecycle cannot run backwards, a published card cannot be destroyed
even by a privileged session, and a grading scale that produced a result can no longer be edited
underneath it.

The development database was never a target: it is still at `0016`, with 13 tenants, no marks and no
disabled triggers, and the disposable test database was left with no marks, no report cards and
every lifted trigger re-enabled.

The one gap an independent re-auditor must close is environmental, not structural: the
Redis-dependent API and worker suites could not be executed here (§10), and should be run before
sign-off. Everything this remediation claims is verified by the runs in §7.

REMEDIATION COMPLETE — READY FOR INDEPENDENT RE-AUDIT
