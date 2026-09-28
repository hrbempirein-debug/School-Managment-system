# Phase 6 Release Preparation Report

Prepared against [`PHASE_6_INDEPENDENT_FINAL_RE_AUDIT_REPORT_R3.md`](./PHASE_6_INDEPENDENT_FINAL_RE_AUDIT_REPORT_R3.md)
(**GO WITH CONDITIONS**). R3 was read and **not modified**. File inventory and staging rationale are
in [`PHASE_6_RELEASE_MANIFEST.md`](./PHASE_6_RELEASE_MANIFEST.md).

| | |
| --- | --- |
| Branch / HEAD | `master` @ `848c20fda26c4bd40d07467ba23d47f421e12f87` |
| Staged paths | 107 |
| Commits made | **0** |
| `school_saas_dev` | untouched, still journalled at `0016` |

## Status in one paragraph

The Phase 6 implementation is verified and a coherent release snapshot is staged. C1/P2-3 (Phase 6
absent from HEAD) and C5 (unsafe trigger teardown) are closed. **No commit was made**, so nothing
is released yet: a clean checkout of `848c20f` still contains only migrations `0001`–`0002` and
cannot run the gate. Reproducibility from a clean checkout is a property of the **staged index**,
which was exported and proven to build and test green; it becomes a property of the repository only
when the owner commits it.

## Conditions carried in from R3

| ID | Condition | Disposition here |
| --- | --- | --- |
| C1 / P2-3 | Phase 6 is not in HEAD and cannot be made so alone | **Closed for the snapshot.** Full closure derived and staged; proven by clean-directory export (§ clean-checkout verification). |
| C2 | `RUN_RUNTIME_SECURITY_TESTS` must never be global | **Closed and made explicit.** Restated as a rule in the workflow. |
| C3 | Docs state a wrong variable name | **Closed.** `coalesce(state, …)` → `coalesce(v_card_guard, …)`. |
| C4 | Docs understate the P3-1 guard's reach | **Closed**, with the counterfactual measured rather than asserted. |
| C5 | `afterAll` disabled four triggers in autocommit | **Closed** and proven four ways. |
| C6 | No change needed for server-derived mark fields | **Confirmed no action.** |

## What changed, and why

### C5 — the four trigger guards

`apps/api/src/security/phase6-exams-acceptance.acceptance.test.ts` disabled
`report_cards_hard_delete_guard_trg`, `report_card_subjects_freeze_trg`, `marks_delete_guard_trg`
and `mark_corrections_append_only_trg` outside any transaction. A failure between the disable and
the re-enable — or a `SIGKILL` — would leave all four guards off **permanently**, on the shared
test database, with no error: `report_cards` and `mark_corrections` hard-delete and
`report_card_subjects` freeze would be silently disabled for every subsequent run.

The teardown now runs in **one** `BEGIN`/`COMMIT` on a single `migratorClient` connection, with a
named savepoint per delete, and re-enables and re-reads `pg_trigger` before committing. It uses
only the four named `ALTER TABLE … DISABLE/ENABLE TRIGGER` statements — no `DISABLE TRIGGER ALL`, no
`session_replication_role` — and no production migration was touched.

Proof, each measured:

| # | Requirement | Result |
| --- | --- | --- |
| 1 | Normal path | Suite **35/35**; a fresh connection sees all four guards `O`. |
| 2 | Failure mid-teardown | Injected throw before the re-enable loop: suite fails, and a **fresh** connection still sees all four `O`. |
| 3 | Abrupt termination | `SIGKILL` with the guards disabled inside an open transaction: fresh connection sees all four `O`. |
| 4 | Honest accounting | The old autocommit behaviour was reproduced deliberately — a fresh connection saw all four `D` — then repaired. The defect was real, not theoretical. |

The residue left by the deliberate fault injection was cleaned afterwards. `audit_logs` is
append-only by design (RLS forced, no `DELETE` policy), so its rows cannot be deleted without
weakening RLS; the test database was instead rebuilt by the migration regression suite, which
`DROP`s and recreates the schema. That is the harness's documented behaviour.

### C2 — the scoping rule

`RUN_RUNTIME_SECURITY_TESTS=1` **must not** be applied globally, at job scope, or to a parallel
Turbo test task. All packages share one `DATABASE_URL_TEST` and `pnpm test` is
`pnpm turbo run test`, which fans out in parallel; the migration regression harness rebuilds the
shared disposable schema, so an inherited variable produced a nondeterministic failure — 5 of 8
Turbo tasks succeeding, a migrator/writer deadlock in `@sms/db`, 27 of 35 API acceptance failures
reading `Invalid uuid`, and 5 worker failures. The rule and its measured justification are now
stated in `.github/workflows/phase6-security.yml` and in the remediation addendum. Each DB-backed
security suite remains an explicit **sequential** step with the variable set on that step alone.

`turbo.json` also gained `env: ["RUN_RUNTIME_SECURITY_TESTS"]` on `test` and the
`@sms/{db,api,worker}#test` tasks, so Turbo's cache key includes the variable instead of serving a
result computed without it.

### C3, C4 and the documentation pass

Corrections are in the addenda of the affected reports, following those documents' own stated
convention of correcting forward rather than rewriting superseded sections.

- **C3** — the P3-1 failure message interpolates `v_card_guard`, not `state`.
- **C4** — the P3-1 guard is load-bearing in **three** tests, not two. Measured: disabling
  `report_cards_validate_trg` fails exactly 3 of 87 —
  `F. report cards` › 1 (`expected Result{ command: 'INSERT' } to be an instance of Error`), › 3
  (same for `UPDATE`), and › 4 (`expected '23514' to be '55000'`, because the weaker
  `report_cards_published_at_ck` fires first). Restored: 87/87. The "two" elsewhere in that report
  refers to the *coherence* guard (`report_cards_snapshot_coherent_trg`), a different trigger; both
  passages now say which.
- **Stale count** — `PHASE_6_REMEDIATION_REPORT.md` §7 records "84 passed" for the DB security
  suite. 84 was that suite's size at the time; the P2/P3 round added three tests, so it is now 87.
- **F-02** — restated as an explicit contract boundary: the **API emits**, the **worker consumes**.
  The API's obligation ends at enqueueing a well-formed `exam.result.compute` command inside the
  correction's transaction; it recomputes nothing and mints no version. Neither suite covers the
  other's half, and a green pair is not claimed to be end-to-end.
- **Snapshot-line architecture** — already superseded by the existing addendum item 1; confirmed
  accurate and left alone.
- **Withdrawn `R`-state claim** — R3 withdrew its own earlier assertion that a trigger state of `'R'`
  "cannot occur". No document in this repository repeats that claim, so there was nothing to
  correct. The remediation report's `'R'` row is **right** and was left as written: `'R'` is
  produced by `ENABLE REPLICA TRIGGER` and the guard still fires for the table owner, so a check
  that merely asked "does the trigger exist" would pass while the guard is inert for replica
  traffic.
- **Schema fingerprint determinism** — see below.

## Verification

All runs against the disposable `school_saas_test`. `school_saas_dev` received no write statement.

### Security suites, each twice, each isolated as the gate requires

| Suite | Run 1 | Run 2 |
| --- | --- | --- |
| Migration regression | 5/5 | 5/5 |
| DB security (Phase 6) | 87/87 | 87/87 |
| API security acceptance | 35/35 | 35/35 |
| Worker result pipeline | 13/13 | 13/13 |

### Full suites, twice

| Suite | Run 1 | Run 2 |
| --- | --- | --- |
| `@sms/db` (19 files) | 330/330 | 330/330 |
| `@sms/api` | 52 passed, 397 skipped (449) | identical |
| `@sms/worker` | 16 passed, 74 skipped (90) | identical |

The skips are correct: with the variable unset, the runtime-security suites skip by design.

### Typecheck, build, and the normal test path

Run in the **working tree**, which contains unrelated Phase 2–5 test infrastructure. The staged
snapshot's own figures are in "clean-checkout verification" below and are **not** these.

| Check | Result |
| --- | --- |
| `pnpm turbo run typecheck --force` | **17/17** tasks, 0 cached |
| `pnpm turbo run build --force` | **3/3** tasks, 0 cached |
| `pnpm test` (env unset) ×2, forced | **8/8** tasks both runs; 1069 tests, 290 passed, **779** skipped; byte-identical skip profile across runs, so no cache-induced race |

`build` emits a pre-existing warning that `@sms/{api,web,worker}#build` declare no outputs.
`outputs: ["dist/**"]` is unchanged from HEAD and the warning predates this work; it is noted, not
fixed, because changing it is outside Phase 6.

### Migration CLI

`school_migrator` owns the test database but has neither `CREATEDB` nor the `postgres` password, so
a second physical database could not be created. No migration hardcodes `public.`, so the probes
were run against a genuinely empty **schema** with `search_path` pointed at it, which exercises the
same `applyMigrations` code path from a from-nothing state.

| Probe | Result |
| --- | --- |
| A — empty schema, apply all | `0001`…`0019` applied, exit **0**, 60 tables, 19 journalled |
| B — re-run | `migrations applied: (none) \| already applied: 19`, exit **0** |
| C — deliberately failing `0020` | `migration failed: … P6 PROBE`, exit **1**; partial table **absent**, journal still **19**, `0020` **not** journalled, table count still 60 |

The probe migration and the probe schema were removed afterwards; `packages/db/migrations/` contains
`0001`–`0019` and nothing else, and `school_saas_test.schema_migrations` holds exactly 19 rows.

### Clean-checkout verification — the C1/P2-3 proof

The claim "a clean checkout can run the gate" cannot be demonstrated from the working tree, and it
cannot be demonstrated with a commit either, because no commit is authorised. So the **index itself**
was exported and tested:

```
git checkout-index --all --prefix=<tmp>/     # 206 files, no repository history
pnpm install --frozen-lockfile --offline     # SUCCESS
pnpm turbo run typecheck                     # 17/17
pnpm turbo run build                         # 3/3
migration regression / DB / API / worker     # 5/5, 87/87, 35/35, 13/13
pnpm test                                    # 4/4 tasks
```

This is the substantive result for C1/P2-3: the frozen lockfile is consistent with the staged
manifests, the snapshot compiles, and all four Phase 6 security suites pass **with no Phase 2–5
test infrastructure present at all**. The committed-tree gap R3 identified is real, and the staged
snapshot is the closure that closes it.

### Final database state

`school_saas_test` — 19 migrations (`0019_phase6_report_card_snapshot_reconciliation.sql`), 60
tables, 599 columns, 744 constraints, 247 indexes, 332 functions, 38 triggers, **0 disabled** and
0 in any state other than `'O'`, RLS enabled 59/59 and forced 59/59, 213 policies, no
`audit_shadow` schema, 0 synthetic journal rows, 0 unpinned `search_path` functions, 0 ambiguous
function identities, `school_app_rw`/`school_migrator` both non-superuser, non-`BYPASSRLS`,
non-`CREATEDB`, and the app role with no tenant context seeing 0 rows in all six Phase 6 tables.
The four C5 guards read `O` from a fresh connection.

The only rows in the test database are `app_rls_secrets` (1), `schema_migrations` (19) and
`audit_logs` (19). The audit rows are the correct outcome, not residue: `audit_logs` is append-only
by design — RLS is forced and the table has no `DELETE` policy, so a `DELETE` matches zero rows
even for the owner — and each API security suite run legitimately appends to it. No Phase 6 fixture
data survives in any table.

`school_saas_dev` — **unchanged**: 16 migrations (`0016_phase6_result_integrity_fixes.sql`), 59
tables, 584 columns, 719 constraints, 240 indexes, 325 functions, 33 triggers, 0 disabled, RLS
58/58, 209 policies, 13 tenants, 254 users, 14195 audit rows. `report_card_subjects` is absent
there, and `report_cards_hard_delete_guard_trg` is absent — both are created by `0017`/`0018`, which
dev has not run. That absence is the proof dev was not migrated.

## Deliberately not done

- **No commit, no `git add` of Class D or Class E, no history rewrite, no stash, no reset.** The
  working tree is otherwise as found.
- **No `school_saas_dev` migration.** Dev remains at `0016`; applying `0017`–`0019` is a deployment
  decision.
- **No redesign** of the integrity model, RLS, triggers, or publication semantics. No historical
  migration was edited. No new permissions, roles, or event types.
- **No `audit_shadow` schema, no synthetic journal row** — both are verification scaffolding, not
  product.
- **No lint introduction.** The `lint` removal staged alongside `turbo.json` is a false-success-gate
  fix; adopting a real linter is a separate change.

## Open items for the owner

1. **Commit the staged snapshot** if the release is to exist. Until then the gate is not reachable
   from a clean checkout of `848c20f`.
2. **Class E decisions** — the three mixed architecture documents, `docs/JOB_ARCHITECTURE.md`, and
   `apps/worker/src/worker.ts`. Staging any of them pulls in non-Phase 6 content.
3. **Class D test infrastructure** — committing it regenerates the lockfile with four more importer
   entries and raises `pnpm test` from 4 tasks to 8.
4. **Whether to commit the independent audit reports** (R1/R2/R3) alongside the code.
5. **`school_saas_dev` rollout** of `0017`–`0019`.
6. **Pre-existing `build` outputs warning**, and the absence of any real linter.
