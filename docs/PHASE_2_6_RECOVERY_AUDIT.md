# Phases 2–6 Recovery — Phase 0 Baseline Audit

**Status:** read-only baseline. No file was created, modified, staged, committed, deleted
or reset in the production tree while producing this report, apart from this document.

**Purpose.** Phases 2 through 6 exist in the working tree of this repository but are not
committed, are not registered as runnable test tasks, and are not covered by CI. This
report fixes the factual baseline that the recovery is measured against, names each
confirmed defect, and fixes the dependency order of the recovery commits. It is the
reference for the final independent `GO` / `NO-GO` verdict.

**Method.** All figures below were produced by command from the repository itself, not
carried over from an earlier review. Where an earlier review and this report disagree,
this report is correct and the disagreement is called out in §9.

---

## 1. Repository baseline

| Fact | Value |
| --- | --- |
| Branch | `master` |
| `HEAD` | `c9ed643bd33fbdb79351aebf9322ba4712b887db` |
| `HEAD` tree | `cec61bea7080afa595f9154ff792f3bd5ab52909` |
| Tracked files | 211 |
| Modified tracked files | 20 |
| Untracked files | 129 |
| Staged files | 0 |
| Tags | 0 |
| Git remotes | 0 |
| Stashes | 0 |
| Migrations `0001`–`0019` | all 19 tracked; 0 untracked |
| Committed CI workflows | 1 (`.github/workflows/phase6-security.yml`) |

**Counting note.** `git status --porcelain` reports 123 entries, not 149, because it
collapses each untracked *directory* into a single entry. The file-level census is
`git status --porcelain -uall` = 149 entries = 20 modified + 129 untracked, and
`git ls-files --others --exclude-standard | wc -l` = 129 independently agrees. Any
future audit must use the file-level count; the collapsed count understates the
recovery surface by 26 entries.

**Untracked files by area (`-uall`):**

| Area | Untracked files |
| --- | --- |
| `apps/web` | 72 |
| `apps/api` | 18 |
| `packages/db` | 11 |
| `apps/worker` | 9 |
| `docs` (6 Phase 6 reports + Phase 4.4/5 reports) | 9 |
| `packages/storage`, `packages/redis`, `packages/permissions`, `packages/core` | 1 each |
| scratch/tooling files at repo root | 7 |

**Untracked scratch files — must never be committed.** `.turbo.release.json`,
`.stage.mjs`, `.stage-list.txt`, `.mkturbo.mjs`, `.coupling.mjs`, `.overlay.mjs`,
`.sync.mjs`, plus `packages/redis/probe.cjs`. These are authoring and investigation
artefacts, not product source.

---

## 2. The 20 modified tracked files

```
 1  apps/web/app/platform/page.tsx
 2  apps/web/app/school/page.tsx
 3  apps/web/app/school/switch-button.tsx
 4  apps/web/next-env.d.ts
 5  apps/web/next.config.mjs
 6  apps/web/package.json
 7  apps/web/tsconfig.json
 8  apps/worker/src/worker.ts
 9  docs/ARCHITECTURE.md
10  docs/AUTHORIZATION.md
11  docs/DATABASE_DESIGN.md
12  docs/EVENT_ARCHITECTURE.md
13  docs/JOB_ARCHITECTURE.md
14  packages/core/package.json
15  packages/db/src/security/impersonation-boundary.test.ts
16  packages/db/src/security/trust-boundary.test.ts
17  packages/permissions/package.json
18  packages/storage/package.json
19  packages/ui/src/index.tsx
20  pnpm-lock.yaml
```

Every one of these is Phase 2–6 work-in-progress. None is unrelated noise, but they are
*not* one atomic change: the four `package.json` files are a test-registration
dependency (§4), and `pnpm-lock.yaml` is the atomic dependency of all four. Committing
these without the corresponding untracked sources would produce a commit that does not
build, so they are split across the groups in §7 rather than committed together.

---

## 3. Package scripts at baseline

`pnpm test` is `pnpm turbo run test`. **A package with no `test` script contributes no
test task, so every `*.test.ts` inside it is unreachable no matter that it exists on
disk.** This is the single largest silent hole in the repository.

| Package | `test` script | `*.test.ts` on disk | Of which untracked | Reachable at baseline |
| --- | --- | --- | --- | --- |
| `apps/api` | `vitest run` | 21 | 18 | yes |
| `packages/db` | `vitest run` | 19 | 11 | yes |
| `apps/web` | **absent** | 13 | 13 | **NO** |
| `apps/worker` | `vitest run` | 6 | 5 | yes |
| `packages/storage` | **absent** | 1 | 1 | **NO** |
| `packages/permissions` | **absent** | 1 | 1 | **NO** |
| `packages/core` | **absent** | 1 | 1 | **NO** |
| `packages/config` | `vitest run` | 1 | 0 | yes |
| `packages/contracts` | absent | 0 | 0 | n/a (no tests) |
| `packages/redis` | absent | 0 | 0 | n/a |
| `packages/audit` | absent | 0 | 0 | n/a |
| `packages/jobs` | absent | 0 | 0 | n/a |
| **total** | | **63** | **50** | 47 reachable / 16 not |

Totals: **63 test files on disk, 13 tracked in git, 50 untracked.**
**16 of the 50 untracked test files are unreachable** (`apps/web` 13, `packages/core` 1,
`packages/permissions` 1, `packages/storage` 1) because their package has no `test`
script. The remaining 34 are reachable but uncommitted, so they exist in no commit.

The four modified `package.json` files each add exactly `"test": "vitest run"` plus a
`vitest` devDependency, and `pnpm-lock.yaml` is the matching lockfile change. This is why
those five files form one atomic group (§7, G0): the lockfile cannot be committed with
only some of the four manifests, and the manifests are worthless without it.

---

## 4. Outbox event catalog — 93 declared types

Counted by importing the real schema (`outboxEventTypeSchema.options`), not by parsing
source with a regex:

```
COUNT = 93    UNIQUE = 93    DUPLICATES = none
```

> **Superseded figures.** An earlier review reported 92 declared events. A regex
> extraction over `packages/contracts/src/events.ts` reports 94 and is *also* wrong,
> because the enum body contains `//` comment lines whose text is then matched as
> members. Only the programmatic import is authoritative. **The count is 93.**

Distribution by domain prefix:

```
academic 8   admission 7   attendance 2   calendar 6   campus 4    class 7
department 4 exam 2        grade 5        holiday 3     homework 3 leave 3
membership 1 period 3      placement 3    promotion 1   report_card 1
result 1    school 1       section 5      session 1     student 7  subject 5
teacher 2   tenant 1       timetable 4    user 3
```

### 4.1 Disposition of every declared event

`apps/worker/src/worker.ts:126-173` iterates `outboxEventTypeSchema.options` and assigns
every one of the 93 types a disposition, so no declared type is silently omitted. The
registry resolves to **8 handler instances covering 9 event types**, with the remaining
types bound to a log-only acknowledgement:

| Classification | Count | Event types |
| --- | --- | --- |
| `HANDLED` (side-effecting) | **9** | `promotion.batch.execute`, `student.document.uploaded`, `student.import.submitted`, `attendance.marked`, `leave.approved`, `leave.rejected`, `exam.result.compute`, `report_card.generated`, `exam.published` |
| `INTENTIONALLY_NOOP` (log-only ack) | **84** | every other declared type |
| `INVALID/UNKNOWN` | **0** | — |

`leave.approved` and `leave.rejected` share one handler instance; the other 8 each own
one type. So: 9 + 84 + 0 = 93.

An undeclared type is never registered (`registry['mystery.thing'] === undefined`) and
`runEventHandler` throws at `apps/worker/src/worker.ts:70` rather than acknowledging it,
so the row is recorded as failed and re-driven instead of consumed. That is the
required "no silent ack" behaviour.

### 4.2 The gap in the existing proof

`apps/worker/src/outbox-integration.test.ts:398` (test 8) pins the count to 93 and asserts
catalog/registry parity and that an undeclared type has no entry. That is necessary but
it is **not** the required classification: it cannot distinguish a real side-effecting
handler from a log-only acknowledgement, so a regression that silently demotes
`exam.result.compute` to a log-only handler would keep test 8 green.

The recovery therefore adds a focused, DB-free unit test that pins the 9 `HANDLED` types
and proves the other 84 are the log-only factory's output, using handler-function
identity: `logEvent(type)` returns a fresh closure per type, so all 84 log-only entries
are pairwise distinct from each other and from every real handler, while
`registry['leave.approved'] === registry['leave.rejected']` proves the shared real
handler. This needs no change to `worker.ts`.

---

## 5. CI baseline

One workflow exists: `.github/workflows/phase6-security.yml`, named `phase6-security`. It
is high quality and must not be weakened. It:

- provisions Postgres 16 and Redis 7 as services;
- bootstraps roles with the same `scripts/bootstrap.sql` an operator runs locally;
- fails closed if `school_app_rw` is missing, `SUPERUSER`, or has `BYPASSRLS` — raised as
  a `DO` block exception rather than printed, because the previous `psql -tAc` version
  printed `FAIL:` and still exited 0;
- runs `pnpm typecheck`, `pnpm build`, and asserts the migration CLI is not a silent
  no-op (first run must report a non-`(none)` applied count, second run must report
  `already applied` + `up to date`);
- runs four DB-backed suites as **sequential steps**, each with
  `RUN_RUNTIME_SECURITY_TESTS=1` set on the step alone;
- materialises a git-ignored root `.env` with only `DATABASE_URL_MIGRATOR`,
  `DATABASE_URL_APP`, `DATABASE_URL_TEST` for the default suite, and removes it after;
- runs `pnpm test` last, without the runtime variable, so destructive suites self-skip.

**Coverage gap.** The gate names only the four Phase 6 suites. The 34 reachable-but-
uncommitted suites and the 16 unreachable ones are enforced by nothing. Recovery expands
this gate; it does not replace it.

**Reproducibility rule that must be preserved.** `RUN_RUNTIME_SECURITY_TESTS` must never
be set at job scope or on a parallel Turbo test task. All packages point
`DATABASE_URL_TEST` at one disposable database, and
`packages/db/src/security/phase6-migration-regression.test.ts` runs
`drop schema public cascade`. Inheriting the variable into the parallel
`pnpm turbo run test` fan-out makes the whole gate nondeterministically red.

---

## 6. Confirmed defects

Each was reproduced by reading the cited source in this pass. These are the P0/P1
targets; they are not carried over from the earlier review without re-checking.

### P0 — the runtime role can rewrite its own migration history

`packages/db/migrations/0001_init.sql:378-383` grants and defaults:

```sql
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO school_app_rw;
ALTER DEFAULT PRIVILEGES FOR ROLE school_migrator IN SCHEMA public
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO school_app_rw;
```

`schema_migrations` is not created by a migration file. It is created by the CLI as the
migrator role — `packages/db/src/cli/migrate.ts:23`,
`packages/db/src/cli/migrate-down.ts:54` and `:100`, and `packages/db/src/cli/seed.ts` —
so the default-privileges clause grants the least-privilege runtime role `school_app_rw`
full DML on the migration ledger. The API can therefore `DELETE FROM schema_migrations`
and lose the record of which migrations ran.

Fix, without editing any applied migration: new
`packages/db/migrations/0020_schema_migrations_runtime_protection.sql` revoking that
DML from `school_app_rw` and re-granting only what the runtime role legitimately needs
(`SELECT`, so tooling can report state; no `INSERT`/`UPDATE`/`DELETE`). Because
`0020` is itself created by `school_migrator`, the revoke must also be accompanied by
`ALTER DEFAULT PRIVILEGES ... REVOKE` or a later migrator-created table will reintroduce
the grant. A regression test must assert the negative — the runtime role is refused
`DELETE` — against a real database, and must cover the migrator CLI still working, since
`migrate.ts` selects and inserts into this table as `school_migrator`.

### P1 — report-card preview 404s; no duplicate generation path needed

`apps/web/app/parent/results/results-portal-view.tsx:33` requests
`/api/v1/report-cards/${card.id}/preview`. The API registers only
`/api/v1/report-cards` and `/api/v1/report-cards/:id`
(`apps/api/src/routes/school/exams.ts:2306` and `:2345`); no route anywhere in
`apps/api` contains `preview`. The portal preview is therefore a hard 404.

> **CORRECTION (recorded during recovery).** The original text of this section claimed
> that migration 0018 persisted frozen per-subject lines in a `report_card_lines` table
> at `packages/db/src/schema.ts:2232`, and that preview should re-render those lines.
> **There is no `report_card_lines` table in this schema.** The claim was wrong, and the
> prescribed fix would have added a table that was never part of the design.
>
> What the schema actually provides: `report_card_subjects` holds each card's
> per-subject lines, and they are frozen for every role by
> `report_card_subjects_freeze_trg` (see migration 0015 and the 0018/0019 split
> documented in `DATABASE_DESIGN.md`). The rendered artifact is a `files` row whose id
> is stamped once onto `report_cards.file_id`; `GET /api/v1/report-cards/:id` already
> mints the download URL from that pointer
> (`apps/api/src/routes/school/exams.ts:2403-2416`).
>
> So the correct fix is smaller and stronger than re-rendering: point the client at the
> route that already exists and return **the stored artifact itself**. A published card
> with no `file_id` is the "still being generated" state the portal already handles by
> rendering `fileUrl === null`. Nothing is recomputed, so preview and publication cannot
> disagree, and no new generation path is introduced. `reportCardPreviewResponseSchema`
> (`packages/contracts/src/school.ts:2506`) already declares exactly this
> `{ reportCard, fileUrl }` shape and was referenced by nothing; the recovery makes the
> route's real body assert against it.

### P1 — platform-admin bootstrap is declared but absent

`packages/config/src/index.ts:81-82` validates optional `PLATFORM_ADMIN_EMAIL` and
`PLATFORM_ADMIN_PASSWORD` (min length 12), and nothing else in `apps/` or `packages/`
reads either key. `packages/db/src/cli/seed.ts` is an explicit, documented no-op that
must not create tenants, users or roles. The documented seed contract and
`PLATFORM_ADMIN_PASSWORD` are mutually inconsistent, and no admin is ever provisioned.

Recovery adds an explicit, opt-in bootstrap that requires the credentials to be supplied
externally, is idempotent, writes an audit record, never hardcodes or auto-generates a
default, and never runs implicitly as part of `db:migrate`.

### P2 — navigation references pages that do not exist

`apps/web/lib/nav.ts` is a mixed Phase 2/3/6 catalog; 72 untracked files under
`apps/web` include Phase 3–6 route trees. Any nav entry whose route is not committed
produces a dead link. The preferred resolution is to recover the full navigation catalog
**and** its pages atomically, so no entry can point at a missing route.

### P3 — `APP_ENCRYPTION_KEY` is validated and never used

`packages/config/src/index.ts:58` declares it optional and unused. Recorded so it is not
mistaken for working encryption.

---

## 7. Recovery groups and their dependency order

Each group is committed only after its own verification, and each commit is preceded by
an exact `git diff --cached --name-status`, `--stat` and staged-census record. Unrelated
working-tree files are never staged; `git add -A` is never used.

| # | Group | Contents | Depends on |
| --- | --- | --- | --- |
| P0 | migration `0020` | new migration + runtime-role regression test | — |
| G0 | test registration | the 4 `package.json` files + `pnpm-lock.yaml` | P0 |
| G1 | Phase 2 proof | `apps/api` authorization/campus/tenant/school-domain suites, `apps/api/src/plugins`, `apps/api/src/routes/school/util.test.ts`, `packages/core`, `packages/permissions` | G0 |
| G4 | worker pipeline | `apps/worker/src/worker.ts` + `promotion.ts`, `documents.ts`, `student-import.ts`, `attendance.ts` + new event-classification unit test | G0 |
| G2 | web foundation | `apps/web` config/tsconfig/next-env, `packages/ui`, `packages/storage` | G0 |
| G3 | Phase 3 DB + API | documents, import, lifecycle, e2e, log-scrubbing, `token-scope` | G4 |
| G5 | Phase 3–5 web | `apps/web` route trees + `nav.ts` + Phase 6 report-card preview fix | G2, G3 |
| G6 | Phase 4 proof | placement, academics, timetable, student-portal | G5 |
| G7 | Phase 5 proof | attendance lifecycle | G6 |
| G8 | platform admin | explicit bootstrap + test | P0 |
| G9 | CI | expanded gate covering Phases 2–5 | all proof groups |
| G10 | hygiene | `.gitignore` coverage for scratch files | — |

G1/G4/G2 are mutually independent and may proceed in any order after G0. G9 must come
last so the gate covers every recovered suite.

---

## 8. Verification plan

The committed result must be provable from the **index alone**, not from this working
tree. A local disposable worktree is created from the staged index; with no Git remote
configured, a clone is not possible, so a worktree or archive of `HEAD + index` is the
required mechanism.

In that clean tree, in order:

```
pnpm install --frozen-lockfile
pnpm typecheck
pnpm build
pnpm test
pnpm db:migrate
```

then the DB-backed suites **sequentially**, each with `RUN_RUNTIME_SECURITY_TESTS=1` on
that step alone: Phase 2 acceptance, Phase 3 documents/import/lifecycle/e2e, Phase 4.1–4.4,
Phase 5 attendance, Phase 6 exams (API and DB), worker outbox/result-pipeline, and the
migration regression. `pnpm db:migrate` must report a non-`(none)` applied count on a
fresh database and an explicit `already applied` / `up to date` on the second run.

Every command's real output is recorded. A command that could not be executed is
reported as not executed, never as passing.

---

## 9. Corrections to the earlier review

| Earlier claim | This audit |
| --- | --- |
| 92 declared events | **93**, verified by importing `outboxEventTypeSchema` |
| "129 untracked" read from `git status --porcelain` | 129 is the *file-level* count (`-uall`); the collapsed form is 103 entries. The figure is right only under `-uall` |
| `apps/web/next-env.d.ts` untracked | it is a **modified tracked** file (item 4 of §2) |
| `apps/api` and `apps/worker` `dev` scripts assumed runnable | `tsx` is declared only by `packages/db`; it exists in `packages/db/node_modules/.bin` but in neither `apps/api` nor `apps/worker`, so `pnpm dev:api` and `pnpm dev:worker` will not start. Not a gate blocker — `build` for both is `tsc` — but a real gap |
| 16 unreachable test files | confirmed and located: `apps/web` 13, `packages/core` 1, `packages/permissions` 1, `packages/storage` 1 |

---

## 10. Non-goals and standing constraints

- **No Phase 7 work.** No new product surface beyond what the recovery requires.
- No release tag, no push, no remote created.
- No `git reset --hard`, `git clean`, stash, amend, rebase, or force-push.
- Migrations `0001`–`0019` are applied history and are never edited; the fix is additive
  in `0020`.
- Scratch/generated files in §1 stay uncommitted.
- Domain logic is not rewritten for style. The only permitted edit to
  `apps/worker/src/worker.ts` is a change the registry contract requires; none is needed
  for the event-classification proof.

---

## 11. Resolution status (appended as the recovery proceeded)

Sections 1–10 are the Phase 0 record and are left as written, except for the one factual
correction flagged inline in §6 (the non-existent `report_card_lines` table). This
section is the outcome.

| Defect | Status | Resolution |
| --- | --- | --- |
| P0 runtime role can rewrite migration history | **fixed** | Additive migration `0020_schema_migrations_runtime_protection.sql` revokes all `schema_migrations` privileges from `school_app_rw` and `PUBLIC`, and fails closed if any privilege survives. `0001`'s default privileges are deliberately retained — the application tables need them. |
| P1 report-card preview 404 | **fixed** | Client repointed to `GET /api/v1/report-cards/:id`, which returns the stored artifact. See the correction in §6: no new table, no new generation path. |
| P1 platform-admin bootstrap absent | **fixed** | `apps/api/src/cli/bootstrap-platform-admin.ts` + `pnpm platform:bootstrap-admin`. |
| P2 navigation references missing pages | **fixed** | 72 `apps/web` files recovered so all 13 nav hrefs resolve, plus `nav-routes.test.ts` which walks the real route tree so a future gap fails the build. |
| P3 `APP_ENCRYPTION_KEY` validated but unused | **documented as unimplemented** | The audit traced the full lifecycle and concluded this is **B: future functionality documented prematurely**, not an incomplete requirement. `docs/SECURITY.md` and `.env.example` no longer claim active encryption, and `apps/api/src/security/security-doc-claims.test.ts` (7 tests, ungated) fails if the false claim returns. See §14. |
| 16 of 63 test files unreachable from `pnpm test` | **fixed** | `@sms/web`, `@sms/core`, `@sms/permissions`, `@sms/storage` test tasks registered in `package.json` and the Turbo graph. |
| 38 of 42 gated suites not runnable in CI | **fixed in config, unverified in CI** | Three aggregate gate steps added to `.github/workflows/phase6-security.yml`. Every step's exact command was executed locally and in a clean worktree and passes, **but the workflow has never run on a real CI runner** — this repository has no git remote. See §14 and §15. |

### Additional defects found and fixed during recovery

- **Event classification was unpinned.** 93 declared event types existed with 9
  `HANDLED`, 84 intentionally ignored, 0 unknown. Nothing asserted that partition, so
  silently reclassifying an event as a no-op would have been invisible.
  `apps/worker/src/worker-event-registry.test.ts` now pins the full 93/84/9 partition and
  the identity mapping, and asserts an unknown type raises rather than being acked.
- **Nav hrefs were never checked against the route tree.** The catalog and the pages
  live in two different places with nothing tying them together, which is how the
  dead link survived. `nav-routes.test.ts` closes that.
- **Two DB suites asserted on unscoped global counts.** `platform_role_assignments`,
  `users` and `user_profiles` are global tables, so `count(*)` also counted other
  suites' rows. Both now scope to their own fixture users.
- **Two suites' comments named the wrong database** (`school_saas_dev`); they run
  against the disposable `school_saas_test`.
- **A concurrency test in the F-02 gate was pinned to a coin flip.** Re-validation
  caught `phase6-exams-acceptance.acceptance.test.ts` → *"serialises concurrent
  corrections on the score, not just the status (F-02)"* failing roughly 1 run in 5 with
  `expected 'mark_correction_stale' to be 'mark_conflict'`. The cause is real and is not
  a test-only artefact: **there are two legitimate serialisation points for the same
  logical conflict**, and which one rejects a given loser depends purely on the
  interleaving.
  - The route's compare-and-swap on `marks_obtained`
    (`apps/api/src/routes/school/exams.ts:1390-1413`) → `mark_conflict`.
  - The `mark_corrections` old-value guard trigger, which runs on the **INSERT**
    (`packages/db/migrations/0015_exams_results.sql:994`), i.e. *before* the route's
    UPDATE — mapped to `mark_correction_stale` at `apps/api/src/routes/school/util.ts:109`.
    A loser whose INSERT lands after the winner's UPDATE is therefore turned away by the
    guard and never reaches the CAS at all.
  Both carry the same meaning ("the mark changed; reload and retry"), so the test was
  asserting which of two valid mechanisms won a race.
  > **SUPERSEDED by §13.1.** The interim fix here accepted the set
  > `{mark_conflict, mark_correction_stale}`. The final fix instead **normalized the
  > public contract**: the guard is now mapped to `mark_conflict` and
  > `mark_correction_stale` no longer exists. The set-based assertion was narrowed back
  > to the single code, because a second accepted code would reintroduce the
  > nondeterminism. Both guards remain; the test still has teeth.
- **The Turbo build cache was silently broken for the whole repo.** `turbo.json`
  declared `"outputs": ["dist/**"]` for the `build` task, but `tsconfig.base.json` sets
  `"noEmit": true` and neither `apps/api` nor `apps/worker` overrode it, so their
  `build` scripts (`tsc -p tsconfig.json`) are typecheck gates that emit nothing. The
  pattern therefore matched nothing for all three build tasks, which produced
  `WARNING no output files found for task ...` on every build. The practical cost was
  on `@sms/web`: `next build` emits `.next/**`, which the `dist/**` pattern did not
  cover, so **the web bundle was never cached and every build re-ran it in full**
  (1m21s forced vs 70ms cached after the fix). `turbo.json` now declares `outputs: []`
  for the typecheck-only tasks, and `apps/web/package.json` declares
  `"tasks": { "build": { "outputs": [".next/**"] } }` for the one task that really
  produces artifacts. The dead `"outDir": "dist"` in both tsconfigs was removed rather
  than left to imply an artifact that never appears. The `build` script name is
  misleading for `apps/api`/`apps/worker` but was not renamed: `^build` is an edge in
  the Turbo graph and in CI, so renaming it would be a wider change than the defect
  warrants.

### Environment notes (not code defects)

- **Redis.** The 23 `apps/worker/src/outbox-integration.test.ts` cases need a reachable
  Redis. On this host Redis runs inside WSL and answers `PONG` there, but Windows-side
  ioredis received `ECONNREFUSED` intermittently because the WSL relay only forwards
  while the VM is actively running. Holding the VM awake with a background `wsl`
  keep-alive makes the relay stable, and the suite then passes 23/23. This was an
  environment problem, not a product defect; CI provisions its own Redis 7 service and
  is unaffected.
- **`school_saas_dev` was mutated by a smoke test, and the change is retained.**
  Verifying the new `pnpm platform:bootstrap-admin` end to end caused it to run against
  the development database, because `.env` already defines `PLATFORM_ADMIN_EMAIL` and
  `PLATFORM_ADMIN_PASSWORD`. The command behaved exactly as designed: it created the
  `platform_admin` role and its 8 permissions, assigned that role to the pre-existing
  `admin@school.local` account, wrote one `system`-actor `platform.admin_bootstrap`
  audit row, and **did not rotate or set the existing account's password**. No
  credential was overwritten and no existing row was destroyed. This is the intended
  effect of the command, the operator was asked and chose to keep it, and the audit row
  is deliberately not deleted. It is recorded here so the privileged account in the dev
  database is a known, intentional state rather than a surprise.

---

## 12. Final validation

Run in this order on the recovered tree, against real PostgreSQL and a live Redis.

| Step | Command | Result |
| --- | --- | --- |
| 1 | `pnpm install --frozen-lockfile` | pass; lockfile verified, 373 entries |
| 2 | `pnpm typecheck` | 17/17 tasks |
| 3 | `pnpm build` | 3/3 tasks, no Turbo output warnings |
| 4 | `pnpm test` | 8/8 tasks (runtime suites self-skip by design) |
| 5 | `pnpm db:migrate` | dev advanced 16 → 20; second run reported up to date |
| 6 | migration regression (destructive, own DB) | 5/5 |
| 7 | `packages/db` suites (16 files) | 323/323 |
| 8 | `apps/api` suites (22 files) | 468/468 |
| 9 | `apps/worker` suites (7 files) | 98/98 |
| | **runtime security total** | **46 files / 894 tests** |

> This was the state at `f9a87c2`. The closure work in §13 raised the API suite to
> **23 files / 476 tests** (one new F-02 guard test, one new 7-case documentation
> guard), for a final total of **902 runtime tests** — see §14.

Steps 6–9 ran sequentially with `RUN_RUNTIME_SECURITY_TESTS=1` set on each command only.
`pnpm test` was run without it, confirming the default `pnpm test` path does not
accidentally execute the destructive suite.

**Live confirmation of the P0 on the real database**, not only in the test fixture: after
`pnpm db:migrate`, `school_app_rw` → `schema_migrations` reports `SELECT`, `INSERT`,
`UPDATE` and `DELETE` all **false**, `PUBLIC` **false**, and 20 migrations recorded.

**Committed-state check.** The only untracked files are the 8 declared scratch/probe
files. Every `*.test.ts` on disk is tracked (api 22/22, worker 7/7, web 14/14, db 20/20,
core 1/1, permissions 1/1, storage 1/1), and no untracked `.ts`/`.tsx`/`.sql`/`.yml`
exists outside that scratch set. The committed tree is therefore self-sufficient; the
suites do not depend on anything left on disk but uncommitted.

**Every new test was proven to have teeth** by a deliberate negative control, because a
green test that cannot fail is worth nothing:

| Control | Expected result | Observed |
| --- | --- | --- |
| Re-grant `schema_migrations` to the runtime role | P0 suite must fail | failed as designed |
| Inject a nav href to a non-existent route | dead-link test must fail | failed, caught the bad href |
| Change the detail response so the contract no longer parses | contract test must fail | failed on the mismatch |
| Introduce password rotation into the bootstrap | idempotency suite must fail | failed on the rotation |
| Misclassify a worker event's handling | registry suite must fail | 5/8 events failed |

---

## 13. Final closure changes

Three items were open at the previous verdict. All three are now closed in code; the
CI item is closed as *documented-unverified*, which is not the same as verified.

### 13.1 Concurrency contract normalized (commit `d334591`)

The two legitimate serialization points for one logical conflict now expose one public
code. The `mark_corrections` old-value guard (which runs on the INSERT, therefore
*before* the route's UPDATE) is mapped to `mark_conflict` at
`apps/api/src/routes/school/util.ts:116`, and the redundant `mark_correction_stale`
alias is gone. **Neither guard was removed** — the DB trigger and the route CAS both
remain, because they defend against different interleavings.

Contract is now: `concurrent logical correction conflict → mark_conflict`, always.
The accepted error-code set was narrowed back to the single code, not widened.

New focused coverage in the gated Phase 6 suite (39 tests, was 38):

- *exposes mark_conflict for the INSERT old-value guard, and keeps both guards* —
  asserts `mark_corrections_validate_trg` still exists, provokes the **real** trigger
  with a stale `old_marks_obtained`, confirms PG raises `55000` with the guard text,
  and confirms the public code and message. It also pins that the *status* guard still
  reports `mark_correction_required`, so normalization did not erase a real distinction.
  This test is deterministic: it does not rely on winning a race.

Negative controls re-verified after the change:

| Injected fault | Expected | Observed |
| --- | --- | --- |
| Remove the score predicate from the CAS | F-02 test must fail | **1 failed / 38 passed** |
| Remove the status predicate from the CAS | F-02 test must fail | **1 failed / 38 passed** |
| Revert SECURITY.md + .env.example to false claims | doc test must fail | **3 failed / 4 passed** |
| Add a real `secretEnc` writer to `auth.service` | doc test must fail | **1 failed / 6 passed** |

Stability: 8/8 consecutive Phase 6 acceptance runs in the main tree and 8/8 from a
clean worktree, 0 failures. Before the fix the same suite failed ~1 run in 5.

### 13.2 `APP_ENCRYPTION_KEY` adjudicated: case B (commit `8b5dd79`)

The full lifecycle was traced rather than assumed:

| Stage | Finding |
| --- | --- |
| Config validation | `packages/config/src/index.ts:58`, optional, no consumer |
| Encryption implementation | **none exists** — only argon2id (hashing) and sha256 (hashing); no AES, no `createCipheriv` anywhere |
| `auth_identities.secret_enc` | declared `text` column, nullable, never written |
| Write paths | none (`packages/auth/src/service.ts:97` and the bootstrap CLI both omit it) |
| Read/decrypt paths | none |
| Tests | none; only an audit redaction entry |
| `SECURITY.md` claim | "Encryption at rest for MFA secrets & PAT hashes: AES-256-GCM … key id stored for rotation" |
| Supporting schema | **no `key_id` column exists**; `totp_secret_enc` named in `DATABASE_DESIGN.md` **never existed**; MFA/TOTP and PAT/machine-token are **not implemented**; `password` is the only provider |

The claim was false in four independent ways, and the "MFA secrets & PAT hashes" it
claimed to protect do not exist. Adding AES-256-GCM would have been inventing a
consumer for a key with no feature behind it, so per the B branch: **no encryption was
implemented.** Instead the false claims were corrected and pinned.

- `docs/SECURITY.md` §13 now states passwords and tokens are *hashed, not encrypted*,
  and marks secret encryption `NOT YET IMPLEMENTED` with what an implementation would
  have to add.
- `.env.example` marks the key `RESERVED / UNUSED` and notes tokens are hashed.
- `docs/DATABASE_DESIGN.md` drops the phantom `totp_secret_enc` column and marks
  `secret_enc` reserved/unused.
- `apps/api/src/security/security-doc-claims.test.ts` (7 tests) runs **ungated**, so
  the false claim cannot return even in the default `pnpm test` path.

### 13.3 Fresh-clone reproducibility (commit `93ed2a4`)

Found by actually cloning: `pnpm test` failed on a clean checkout with
`DATABASE_URL_TEST is required`, because `global-setup.ts` and `setup-env.ts` resolved
the disposable database **unconditionally** — even though the default suite touches no
database and `.env` is gitignored. Both now no-op unless
`RUN_RUNTIME_SECURITY_TESTS=1`.

This is not a bypass: with the opt-in set and no `.env`, the suite still fails loudly
with the original error. Verified both ways.

---

## 14. Clean-checkout verification

Reproduced in a detached worktree at `93ed2a4` containing the intended commits only —
no scratch files, no untracked source, no `.env`.

| Check | Result |
| --- | --- |
| `pnpm install --frozen-lockfile` | pass |
| `pnpm typecheck` | 17/17 |
| `pnpm build` | 3/3, **0 Turbo warnings** |
| `pnpm test` (no opt-in) | 8/8 |
| `pnpm test` with no `.env` at all | 8/8 (the fresh-clone case) |
| `pnpm db:migrate` ×3 | up to date every time |
| Turbo web cache | 1m25s forced → 62ms cached |
| test files tracked | **67/67** (api 23, worker 7, web 14, db 20, core 1, permissions 1, storage 1) |
| untracked source in checkout | none |
| secrets committed | none (`.env`, `*.pem`, `*.key` all absent) |
| scratch files committed | none |

Runtime suites from the clean checkout: db destructive 5, db aggregate 323, api 476,
worker 98 — **902 tests**. Named groups individually: Phase 2 = 14, Phase 3 = 47,
Phase 4 = 56, Phase 6 = 39, platform bootstrap = 16, worker outbox = 23,
schema_migrations = 8, tenant/RLS = 12. Phase 6 ×8 consecutive: 0 failures.

One known ergonomic limit, not a defect: running the report-card F2 tests via
`vitest -t F2` fails, because they consume suite-scope fixtures built by earlier
`it` blocks in the same file. The supported invocation (whole file) passes. This
predates the closure work and does not affect CI, which runs whole files.

---

## 15. Final independent audit

Answering the mandated questions as an outside reviewer.

1. **Is the public concurrency error contract deterministic?** Yes. One condition, one
   code. `mark_correction_stale` no longer exists anywhere in the tree.
2. **Are both serialization guards still present?** Yes — the route CAS score predicate
   and the `mark_corrections_validate_trg` DB trigger, each asserted by a test.
3. **Does the negative control still detect a broken CAS predicate?** Yes, verified live
   for both the score predicate and the status predicate.
4. **Is `APP_ENCRYPTION_KEY` actually used?** **No**, and that is now documented rather
   than implied. It is `RESERVED / UNUSED`; setting it enables nothing.
5. **Is `auth_identities.secret_enc` populated/read?** **No.** No writer, no reader.
6. **Does SECURITY.md describe reality?** Yes, and a test enforces it.
7. **Are Phase 2–6 tests registered?** Yes — all 7 packages with test files are in the
   Turbo graph and run by the default `pnpm test`.
8. **Does the worker handle all implemented events?** Yes — 93 unique types, 9 HANDLED
   across 8 handler instances, 84 INTENTIONALLY_NOOP, 0 unknown, pinned by test.
9. **Is `schema_migrations` protected from the runtime role?** Yes, confirmed live on
   the development database: SELECT/INSERT/UPDATE/DELETE all false for
   `school_app_rw`, false for `PUBLIC`, 20 migrations recorded.
10. **Is platform-admin bootstrap secure and idempotent?** Yes — 16 tests; migrator-only,
    audited, no credential rotation, not reachable from `db:migrate` or `db:seed`.
11. **Does report-card preview work?** Yes — 3 F2 tests pass, client targets the
    existing route and the stored artifact.
12. **Is the repository reproducible from a clean checkout?** Yes — §14.
13. **Are all validation suites green?** Yes — 902 runtime tests plus 8/8 repeated
    Phase 6 runs, from a clean checkout.
14. **What remains unverified?** See below.

### What is UNVERIFIED, and why

**UNVERIFIED IN REAL CI.** `.github/workflows/phase6-security.yml` has never executed on
a CI runner: this repository has **no git remote** (`git remote -v` is empty). Every
step's commands were executed locally and in a clean worktree, and the YAML parses, but
that proves the commands are *correct*, not that the gate is *enforced*. Specifically
unproven: runner-side PostgreSQL and Redis service provisioning, the role/database
bootstrap step, secret handling on the runner, and the generated-`.env` materialisation
step.

Local evidence is not converted into a CI claim anywhere in this document.

---

## 16. Verdict: NO-GO — CI UNVERIFIED

All technical recovery issues found during this engagement are closed:

- P0 migration-ledger privilege escalation — closed and confirmed on the live dev DB
- P1 report-card preview 404 — closed
- P1 platform-admin bootstrap absent — closed
- P2 navigation dead links — closed
- 16 unreachable test files — closed
- 38 unrunnable gated suites — closed in config
- flaky F-02 concurrency gate — closed
- Turbo build cache broken for web — closed
- `APP_ENCRYPTION_KEY` false encryption claim — closed (documented as unimplemented)
- fresh-clone `pnpm test` failure — closed

The verdict remains **NO-GO** solely because no CI runner has ever executed the
workflow. This is not a code defect and cannot be fixed from inside the repository.

To reach GO: establish a legitimate remote, push, and let
`.github/workflows/phase6-security.yml` execute on a real runner, then perform the final
independent release audit against that run.
