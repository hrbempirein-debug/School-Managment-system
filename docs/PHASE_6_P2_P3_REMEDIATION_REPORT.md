# PHASE 6 — P2/P3 REMEDIATION REPORT

Remediation of the five findings raised by
[`PHASE_6_INDEPENDENT_FINAL_RE_AUDIT_REPORT_R2.md`](./PHASE_6_INDEPENDENT_FINAL_RE_AUDIT_REPORT_R2.md)
against the Phase 6 **gate** and its **evidence**, not against the integrity model itself.

| ID | Finding | Status |
| --- | --- | --- |
| P2-1 | The job-level `RUN_RUNTIME_SECURITY_TESTS` made the final `pnpm test` re-run the destructive suites. | Fixed |
| P2-2 | The runtime-role check printed `FAIL:` through `psql -tAc` and exited **0**. | Fixed, proven fail-closed |
| P2-3 | Phase 6 implementation artifacts are untracked, so the gate is not inside HEAD's tree. | Partially fixable — see §5 |
| P3-1 | `0018` lifted `report_cards_validate_trg` and restored it with no assertion. | Fixed, proven load-bearing |
| P3-2 | Two published-card assertions never reached a `COMMIT`, so they were vacuous. | Fixed, proven load-bearing |

**No integrity rule was weakened.** No RLS policy, trigger, constraint or function was relaxed,
dropped or bypassed. Every change either asserts a property that was previously assumed, or makes an
assertion actually reach the code path it claims to test. `0015_exams_results.sql` and every earlier
migration are untouched. Nothing was committed.

---

## 1. P2-1 — the destructive suites ran twice, in parallel with themselves

`RUN_RUNTIME_SECURITY_TESTS: '1'` was set at **job** level, so the final `pnpm test` inherited it.
The DB-backed suites therefore ran once in their own serial steps and again inside the default suite,
where `turbo run test` executes package suites **in parallel against the same shared
`school_saas_test`** — including `phase6-migration-regression.test.ts`, the one suite that drops the
schema. That is a data race on the database the other suites are asserting against.

The variable is now set on the four gate steps only:

| Step | Command | Env |
| --- | --- | --- |
| Migration regression | `vitest run src/security/phase6-migration-regression.test.ts` | `RUN_RUNTIME_SECURITY_TESTS=1` |
| DB security suite | `vitest run src/security/phase6-exams.test.ts` | `RUN_RUNTIME_SECURITY_TESTS=1` |
| API security acceptance | `vitest run src/security/phase6-exams-acceptance.acceptance.test.ts` | `RUN_RUNTIME_SECURITY_TESTS=1` |
| Worker result-pipeline | `vitest run src/exams-result-pipeline.test.ts` | `RUN_RUNTIME_SECURITY_TESTS=1` |
| Default test suite | `pnpm test` | *unset* |

**Verified by execution, not by reading the YAML.** `pnpm test` with the variable unset: **8/8 tasks
successful**, with the DB-backed tests self-skipping — `@sms/db` 22 passed / 308 skipped, `@sms/api`
52 passed / 397 skipped, `@sms/worker` 16 passed / 74 skipped. The migration-regression suite does not
appear in that run at all. The four gate suites, run with the variable set, pass 5, 87, 35 and 13
tests. The file also parses under PyYAML, and exactly four steps carry the variable.

## 2. P2-2 — the runtime-role assertion could not fail

The old check selected `case when rolsuper or rolbypassrls then 'FAIL: …' end` and ran it through
`psql -tAc`. **psql exits 0 for a query that executes**, so a runtime role with `BYPASSRLS` produced
the string `FAIL: runtime role can bypass RLS` on stdout and a **green step**. A role that bypasses
RLS makes every isolation assertion in the gate vacuous, and the gate announced exactly that and
ignored it.

It is now a `DO` block that raises, with `ON_ERROR_STOP=1` and `set -euo pipefail` so a raise becomes
a non-zero psql exit becomes a non-zero step. Three states are refused: the role does not exist,
`rolsuper`, `rolbypassrls`. The body is fed by a quoted heredoc (`<<'SQL'`) because `$$` inside a
double-quoted shell string is the shell's own PID; `$assert$` is an explicit dollar-quote tag.

**Verified in a disposable PostgreSQL cluster**, running the assertion text extracted verbatim from
the YAML rather than a transcription of it:

| Injected state | Exit | Output |
| --- | --- | --- |
| role safe | `0` | `ok: school_app_rw is neither SUPERUSER nor BYPASSRLS` |
| `school_app_rw` with `BYPASSRLS` | `3` | `fail-closed: role school_app_rw has BYPASSRLS, …` |
| same role restored to `NOBYPASSRLS` | `0` | `ok: …` |
| role made `SUPERUSER` | `3` | `fail-closed: … is SUPERUSER, …` |
| role dropped | `3` | `fail-closed: role school_app_rw does not exist, …` |
| **old query form, `BYPASSRLS` role** | **`0`** | **`FAIL: runtime role can bypass RLS`** ← the defect, reproduced |

The last row is the finding itself, executed: the old form printed the failure and passed the step.

## 3. P3-1 — `0018` restored a trigger it never checked

`0018` lifts `report_cards_validate_trg` to repair published-card aggregates in bulk and re-enables
it at the end. The line-level equivalent already had an assertion; the card-level one did not. A
migration that ended with the lift and no assertion would migrate every database and leave every
published result — its aggregate, version, artifact stamp — editable by any privileged session, with
no error anywhere.

A `DO` block now mirrors the existing line-level assertion exactly: `SELECT tgenabled INTO … WHERE
tgrelid = 'report_cards'::regclass AND tgname = 'report_cards_validate_trg'`, refusing anything
`IS DISTINCT FROM 'O'`, reporting `coalesce(v_card_guard, 'absent')` — `v_card_guard` is the
variable's name, which is what the failure message interpolates.

**Verified against the real database**, with the assertion text extracted from the file, each case run
inside a transaction that is always rolled back:

| Trigger state | Result |
| --- | --- |
| `'O'` (honest) | accepted |
| `'D'` (left disabled) | refused — `…must be enabled (tgenabled='O'), found D` |
| absent | refused — `…found absent` |
| `'R'` (replica only) | refused — `…found R` |

The `'absent'` case is refused by the same `IS DISTINCT FROM`, because a trigger that cannot be found
cannot be shown to be enabled. `'R'` is reachable in its own right — `ALTER TABLE … ENABLE REPLICA
TRIGGER` produces it, and the guard still fires for the table owner, so a check that merely asked
"does the trigger exist" would pass while the guard is inert for replica traffic. `'A'`
(`ENABLE ALWAYS TRIGGER`) is a separate, also-refused state. The migration regression suite — which
rebuilds the database from nothing and re-proves the 0018/0019 backfill against a real pre-0018
world, negative control included — passes 5/5 with the new assertion in place.

### 3.1 How load-bearing is the card guard? Three tests, not two

This is stated separately because §4 below uses the number **two**, and the two are about
*different triggers*. Conflating them understates this finding.

`report_cards_validate_trg` is `BEFORE INSERT **OR UPDATE**` (`0015`), so it guards card
*generation* as well as card *immutability*. Disabling it and re-running the DB security suite fails
**three** tests, not two. Measured on `school_saas_test`, restoring to `O` afterwards:

| Test | Observed failure with the guard disabled |
| --- | --- |
| `F. report cards` › **1.** a card is generated only while the exam is grading or published | `expected Result{ command: 'INSERT', … } to be an instance of Error` — the out-of-phase INSERT now **succeeds**, so the test's `rejectCode` wrapper never caught anything |
| `F. report cards` › **3.** a PUBLISHED card is a frozen snapshot | `expected Result{ command: 'UPDATE', … } to be an instance of Error` — the tampering UPDATE now **succeeds** |
| `F. report cards` › **4.** a card may only be published with its exam, and needs a publication stamp | `expected '23514' to be '55000'` — with the guard off, the weaker `report_cards_published_at_ck` constraint fires first, so the test gets the wrong *class* of refusal. F.4 still fails, but for a reason that would not survive into a report card's integrity story |

```
Tests  3 failed | 84 passed (87)      # guard disabled
Tests  87 passed (87)                 # guard restored
```

Tests 2 and 5 (cross-tenant isolation; a draft card is recomputable) are unaffected, which is the
point — they exercise the paths the guard is *not* responsible for. This is not a defect; it means
the P3-1 guard is load-bearing in three places, which strengthens the case for the assertion rather
than weakening it.

## 4. P3-2 — two coherence-guard assertions never reached the code they claimed to test

(The "two" here is about `report_cards_snapshot_coherent_trg` only. The count for the *other* card
guard, `report_cards_validate_trg`, is three — see §3.1.)

`report_cards_snapshot_coherent_trg` is `DEFERRABLE INITIALLY DEFERRED`: it fires **at COMMIT**. Both
affected tests inserted a forged published card inside a transaction and then **rolled it back**, so
the trigger never fired. The tests were green with the trigger *deleted* — proof of nothing, in the
two places that exist to prove the most.

Both now commit for real and expect the refusal:

- **F.2** — the runtime role inserts a published card with hand-written aggregates and no snapshot
  lines; the `COMMIT` must fail with SQLSTATE `55000` and `must agree with its own subject snapshot`;
  the row is then shown absent **on the migrator connection** (counting on the runtime connection with
  no tenant context would return 0 whatever happened — the same vacuity in a different place).
  A positive control follows: a coherent version-2 successor for `(examPublished, studentA2)`, which
  already holds a published version 1, published through the sanctioned
  `publishReportCardWithSnapshot` helper, so it is the correction workflow's real shape rather than a
  first card in an empty slot. Its stored totals are compared against `fn_report_card_totals`, its
  line count against its own `subject_count`, and both versions are shown standing side by side.
- **P2-03** — the hard-delete guard was being asked about a state the database does not permit to
  exist. It now commits a forged card and requires the same refusal and non-persistence, then builds
  a self-contained published exam, mark and **committed** card with a real body
  (`subject_count > 0`) through the same helper, and asks the guard about *that* row. The guard must
  refuse with `55000` / `cannot be hard-deleted/` and the row must survive. A draft card is still
  discardable, so the guard is not over-scoped.

**Verified by counterfactual.** With `report_cards_snapshot_coherent_trg` disabled in the test
database, the suite fails **exactly** the two repaired coherence-guard assertions and nothing else:

```
a publication that disagrees with its own snapshot must not COMMIT
a published card with no snapshot rows must be refused at COMMIT
```

The trigger was then re-enabled and the suite returned to **87/87**, with zero disabled triggers.

## 5. P2-3 — Phase 6 is not inside HEAD's tree, and cannot be made so alone

`git ls-files` shows HEAD (`848c20f`, *"feat: complete phase 2a security foundation"*) contains only
`migrations/0001` and `0002`. The gate, the runtime harness, migrations `0003`–`0019` and the four
Phase 6 suites are all **untracked**, so the committed tree cannot run this gate at all.

Seventeen paths — the Phase 6 remediation's own files — are now **staged** (nothing committed;
HEAD unchanged). Verified with `git diff --cached --name-status`: 16 added, 1 modified
(`packages/db/vitest.config.ts`). No `.md` or `docs/` file is staged, no audit report, no Phase 5 or
earlier report, no `apps/web`, no route/plugin/handler work, no migration below `0016`. This report
and the cumulative `PHASE_6_REMEDIATION_REPORT.md` are themselves deliberately left unstaged, so that
the staged set contains executable artifacts only.

**This staged set is provenance, not a working snapshot, and the reason is structural rather than
avoidable:** `marks`, `exams` and `grading_scales` are created *only* by `0015_exams_results.sql`,
which is untracked. Staging `0016`–`0019` without `0003`–`0015` yields a migration chain that cannot
apply, and the four suites import the untracked harness plus modified tracked files
(`packages/db/src/cli/migrate.ts`, the three `vitest.config.ts`). The minimum *coherent* commit unit
is the whole 164-path working tree, which is dominated by pre-Phase-6 feature work that was
explicitly out of scope here. **A commit of this staged set alone would produce a tree that cannot
build, typecheck, or run a single suite.** That decision is the repository owner's; this report does
not make it. To undo the staging: `git restore --staged -- <paths>`.

## 6. Verification evidence

Every run below was executed in this session.

| Check | Result |
| --- | --- |
| Migration regression (rebuilds the DB, negative control) | 5/5, twice |
| DB security suite | 87/87, twice |
| API security acceptance | 35/35, twice |
| Worker result-pipeline | 13/13, twice |
| `pnpm test` (no env var) | 8/8 tasks; 779 DB-backed tests correctly skipped |
| `pnpm typecheck` | 17/17 |
| `pnpm build` | 3/3 |
| Workflow YAML | parses; exactly four steps carry the variable |
| P2-2 assertion | 5 states, correct exit codes (§2) |
| P3-1 assertion | 4 states, correct accept/refuse (§3) |
| P3-2 counterfactual | 2 expected failures with the trigger off; 87/87 with it on |
| Bypass sweep | no `.only`; the only `.skip` is the pre-existing `describeDb` runtime gate |

## 7. Database state

`school_saas_dev` was never a target and is **byte-identical** to the fingerprint taken before this
work: schema hash `2b6c952ebcfa863bbe03d7ee91e325eeed0d28c95d185ae4b541c5c9524f106e`, 16 migrations
at `0016`, 59 tables, 58/58 RLS, 33 triggers, none disabled, tenants 13 / users 254 / students 30 /
enrollments 15 / outbox 113, no marks, no report cards.

`school_saas_test` is a clean rebuild: 19 migrations at `0019`, 60 tables, 59/59 RLS enabled **and**
forced, 38 non-internal triggers, **none** disabled, all 11 probed tables at 0 rows, 213 policies,
and `public` as its only non-system schema.

Both roles are unchanged: `school_app_rw` and `school_migrator` are `rolsuper=false`,
`rolbypassrls=false`, `rolcreatedb=false`, `rolcreaterole=false`.

**Residue found and removed.** Seven `audit_shadow_*` schemas were present in `school_saas_test`,
holding shadow copies of `fn_normalize_percent`, `fn_grade_for_pct`, `fn_exam_grade_for` and
`fn_report_card_should_version` — the earlier auditor's search_path-hijack probes, not harness output
(no file in the repository creates them). Nothing depended on them (`pg_depend`: 0). Because the
rebuild drops only `public`, they would have persisted forever; they were dropped and the schema
inventory re-verified. **They are the only pre-existing residue this session found, and they are
disclosed here rather than quietly cleared.**

**A note on the schema hash.** The test database's composite hash differs from the pre-work
baseline, and it differs *between identical rebuilds* (three rebuilds, three values). The cause is in
the probe, not the database: it orders functions by `proname` alone, and `public` holds 12 overloaded
names (all `pgcrypto`), so the hash input order is unspecified. All 11 stored summary dimensions —
migrations, version, table count, RLS enabled/forced, trigger count, disabled triggers, all 11 table
row counts, sampled function, 213 policies — are identical to baseline, and that is the evidence
offered. `school_saas_dev`, which has no overloaded names and therefore a stable hash, is identical.

## 8. Disclosed limitations

- **The staged set is not independently buildable** (§5). The gate is real in the working tree and
  green, but HEAD still cannot run it.
- Nothing is committed. The index holds 17 paths pending the owner's decision.
- The composite test-database hash is not a reliable fingerprint (§7); re-baseline it with a
  tie-broken `ORDER BY` before using it as evidence in a future audit.
- Lint remains unexecutable repository-wide — a pre-existing gap, not a pass.
- The default suite's DB-backed tests self-skip by design, so a green `pnpm test` alone says nothing
  about the security properties. Only the four gate steps do.

READY FOR INDEPENDENT FINAL RE-AUDIT
