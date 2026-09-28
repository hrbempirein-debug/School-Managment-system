# Phase 6 — Final Blocker Remediation Report (P1 Report-Card Snapshot Integrity)

Date: 2026-09-26
Scope: remediation of the single P1 blocker recorded in `docs/PHASE_6_INDEPENDENT_RE_AUDIT_REPORT.md`
Final status: **REMEDIATION COMPLETE — READY FOR INDEPENDENT PHASE 6 RE-AUDIT** (with two out-of-scope pre-existing test-authoring defects disclosed in §11)

---

## 1. Exact files changed

| # | File | Change | Kind |
|---|------|--------|------|
| 1 | `packages/db/migrations/0018_phase6_final_result_snapshot_integrity.sql` | Trigger split, shared integrity assertion, narrowed backfill bypass | modified (913 lines) |
| 2 | `packages/db/migrations/0019_phase6_report_card_snapshot_reconciliation.sql` | New forward-only idempotent reconciliation migration | **added** (283 lines) |
| 3 | `packages/db/src/security/phase6-exams.test.ts` | Teardown trigger rename; added missing `publishCardWithSnapshot` helper | modified |
| 4 | `apps/worker/src/exams-result-pipeline.test.ts` | Teardown trigger rename | modified |
| 5 | `docs/PHASE_6_FINAL_BLOCKER_REMEDIATION_REPORT.md` | This report | **added** |

No other repository file was modified. No production configuration, no `school_saas_dev`, and no dependency manifest was touched.

## 2. Root cause

`0018` performed a backfill of `report_card_subjects` for already-published report cards. The backfill temporarily disabled the publication-freeze trigger, and its own re-enable happened in a *later* statement than the backfill that repaired aggregates — so the migration was also (correctly) asserting an invariant its own backfill order violated.

More precisely, the failure reproduced as a hard `55000` abort:

```
a published report card's subject lines are frozen: supersede the result with a new version
```

Raised while inserting *missing* lines for a card that had no lines at all. The freeze predicate was "card is published", not "the card already had a snapshot", so a card that was published before its snapshot existed could never be repaired by the very migration meant to repair it.

Contributing defect: the pre-existing backfill could not be run on a database where the freeze trigger was legitimately active, because it relied on the trigger being off.

## 3. Design decision and rationale

**A `0019`-only fix is impossible.** `packages/db/src/cli/migrate.ts` runs each migration in its own transaction and throws on the first failure. A failed `0018` aborts the chain before `0019` is ever read. Any real fix therefore had to make `0018` itself succeed.

Because `0018` was provably never shipped, the authorized approach was the minimum viable one:

- keep `0018` as the file that must succeed;
- make the *narrowest* change that lets it succeed without weakening the schema;
- add `0019` only for the genuinely new idempotent reconciliation work, so the repair is not silently coupled to a file already recorded as applied anywhere.

## 4. Changes in `0018`

**a. Shared integrity assertion** — `fn_report_card_line_assert_valid(...)` at line 470. One authoritative function for the line-level invariants, so validate and freeze cannot drift.

**b. Ownership split**
- `trg_report_card_subjects_validate()` (line 516) — integrity + identity immutability only.
- `trg_report_card_subjects_freeze()` (line 560) — publication freeze only, and it calls the shared assertion **first**.

**c. Error-precedence fix (the subtle part).** PostgreSQL fires same-kind triggers in alphabetical name order, so `report_card_subjects_freeze_trg` fires *before* `report_card_subjects_validate_trg`. Originally the freeze trigger delegated to the validate trigger, so a bad line reported the *freeze* error instead of the *integrity* error. Now freeze checks the shared function before its own publish-state check, which restores the intended precedence.

**d. Narrowed backfill bypass** — line 632 disables **only** `report_card_subjects_freeze_trg`; line 665 re-enables it. `report_card_subjects_validate_trg` is never disabled, so integrity and identity constraints are enforced for every single row the backfill writes. Lines 689/694 then assert both triggers are `tgenabled = 'O'`.

## 5. Changes in `0019`

- Reconstructs missing `report_card_subjects` lines for published cards, using an `expected`/`missing` CTE pair and `ON CONFLICT (tenant_id, report_card_id, exam_subject_id) DO NOTHING` (line 156) — so it is safe to re-run and creates no duplicates.
- Same narrow bypass: disables only the freeze trigger (line 80), re-enables it (line 161), and asserts both triggers are `O` (lines 183/188).
- Reconciles the card's stored aggregates, guarded by `IS DISTINCT FROM` so untouched cards are not written.
- Restores `report_cards_validate_trg` (lines 209/231) and asserts a final published-snapshot coherence invariant (line 277) that would fail the migration if reconciliation left any card disagreeing with its own lines.

## 6. Why the bypass is safe

| Requirement | Status |
|---|---|
| Freeze trigger disabled only for the repair window | Yes — exact name, `ALTER TABLE ... DISABLE TRIGGER <one trigger>` |
| Re-enabled immediately after | Yes — next statement, before any aggregate work |
| Enabled state asserted in-file | Yes — `tgenabled = 'O'` assertions in both migrations |
| Final DB-wide trigger audit | 0 disabled triggers anywhere |
| `DISABLE TRIGGER ALL` | 0 occurrences |
| `session_replication_role` | 0 occurrences |
| Integrity trigger disabled during backfill | 0 occurrences — it stays active throughout |
| Explicit `BEGIN`/`COMMIT` in migration | 0 occurrences — the runner owns the transaction |
| `DROP TRIGGER` | 3 occurrences, all `DROP TRIGGER IF EXISTS` recreate pairs matching the 0015 (13) / 0017 (7) convention |

Total `DISABLE`/`ENABLE TRIGGER` statements across both files: 8, all named, all paired.

## 7. Reproduction: before vs after

**Before (original `0018`):**
- Draft-only backfill → succeeded.
- Published card with real marks → `55000: a published report card's subject lines are frozen: supersede the result with a new version`, migration aborts.
- Same backfill with only the named freeze trigger disabled → succeeded, proving the freeze predicate was the sole blocker.

**After:**
- Proof harness: **71 passed, 0 failed.**

## 8. Verification performed

| Check | Result |
|---|---|
| Real `applyMigrations()` proof harness (19 scenarios) | **71/71 pass** |
| Full migration chain on an empty schema | **19/19 apply** |
| `pnpm typecheck` | **17/17 tasks pass** |
| `pnpm build` | **3/3 tasks pass** |
| Worker suite (`exams-result-pipeline`) | **90/90 pass** |
| `@sms/db` suite | **321/322** — 1 pre-existing failure (§11) |
| API acceptance suite | **29/35** — 6 pre-existing failures (§11) |

Harness coverage includes: positive published cards with real marks; corrected-after-publication values with stale aggregates; malformed data rollback; runtime freeze on insert/update/delete; trigger state after every phase; `0019` repair and idempotence; RLS enabled + forced with expected policies; and full rollback with no journal entry and no disabled triggers on failure.

## 9. Test-side changes and their justification

- **Teardown trigger rename (2 files).** `0018`'s rename to `report_card_subjects_freeze_trg` made the old teardown reference a non-existent trigger. Renamed to the current name. Not a weakened assertion.
- **Added `publishCardWithSnapshot` helper.** The DB suite called a helper that was never defined, which was both a hard test error and a `tsc` error (`TS2304`) that made `pnpm typecheck` fail. The helper creates a draft card, inserts its lines, computes `fn_report_card_totals`, then publishes. It now also exercises the real publication path against the new trigger split, which is directly load-bearing for this fix.

One attempted change was **made and then reverted**: adding a second student mark for `examPublished` to give the RLS test a real line. It broke an unrelated mark-count assertion, and the RLS test still failed because it runs in section A while the only snapshot creator runs in section F. Reverting kept the suite strictly better than before (320 → 321 passing) without inventing fixture data to satisfy a test. The underlying defect is disclosed in §11 rather than papered over.

## 10. Environment and cleanup

- `school_saas_dev`: **untouched** — last migration `0016`, 0 report cards, no `report_card_subjects` table.
- `school_saas_test`: schema dropped, recreated empty, and re-migrated through the real `applyMigrations()` → **19/19 migrations, 0 tenants, 0 report cards, 0 report_card_subjects rows, 0 disabled triggers**, both snapshot triggers `=O`.
- Working tree: 153 entries, of which exactly one is new relative to the audit baseline (152) — `0019`. The remaining entries are pre-existing uncommitted work from earlier phases.

## 11. Disclosed residuals (pre-existing, out of remediation scope)

Both were reproduced **with `0018` and `0019` removed from the tree**, so neither is caused by this remediation.

1. **DB suite, 1 failure — RLS test ordering gap.** `phase6-exams.test.ts` section A asserts `report_card_subjects` has visible rows, but nothing in `beforeAll` creates any; the only creator (`publishCardWithSnapshot`) runs later in section F. Fixing it properly means seeding a snapshot card in the shared fixture, which cascades into many hard-coded count assertions across the file. That is test-authoring work on a security fixture, not remediation of the P1 defect, and doing it by guesswork risks weakening real assertions.

2. **API acceptance suite, 6 failures.** These originate in the untouched `trg_report_cards_snapshot_coherent()`, firing when a published card has no subject lines. The suite contains **zero** references to `report_card_subjects`, and the same 6 failures occur with `0019` removed.

## 12. Final status

**REMEDIATION COMPLETE — READY FOR INDEPENDENT PHASE 6 RE-AUDIT**

The P1 blocker is fixed and proven by a 71/71 real-runner harness, a clean 19/19 empty-schema migration chain, green typecheck, green build, and a green worker suite. Published-card immutability and line-level integrity both hold during and after the repair.

The re-auditor should treat the two residuals in §11 as separate, pre-existing findings requiring their own work — and should note that they mean two of the three affected suites are not fully green, for reasons unrelated to this remediation. If the gate is interpreted as *literally zero failing tests*, the verdict would instead be REMEDIATION FAILED; that call belongs to the reviewer, not to this report.
