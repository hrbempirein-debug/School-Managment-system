# Final Phase 8 Audit Report (0035 / 0036) — school_saas_test

> **Current-baseline note (2026-10-10).** This report documents an original audit
> at HEAD `0f38b449c90a75ace8277a7e73da973e164c192b` (§1) and a later C1/C2
> concurrency addendum recorded at HEAD `122d71f52f71fca26ce5aadc44c8a2d2fbae737a`
> (see the dated addendum at the end of this file). Neither baseline describes the
> current repository. `master` has since advanced to
> `6de8e574c57b9e086cd10bca5c744e63180e36d6` via commit
> `a06fe351474e3ebd0032fc6cd7927b40459086c1` ("feat(phase8): add guardian context
> security and announcement lifecycle" — migrations 0035/0036) and the follow-on
> commit `6de8e574c57b9e086cd10bca5c744e63180e36d6` ("test(phase8): add guardian
> concurrency overlap coverage"). All findings and evidence below are historical to
> their dated baselines and were NOT re-run at the current HEAD for this
> clarification; this note adds no new test evidence.

This is a read-only audit and verification of migrations `0035_com_guardian_context_rls.sql` and `0036_com_announcement_lifecycle.sql` against `school_saas_test`. No commits, pushes, tags, releases, changes to earlier migrations, or modifications to `school_saas_dev`. All verification was performed by source inspection, read-only DB inspection (pg_catalog), and controlled execution of the opt-in runtime suite and typecheck.

## 1) Baseline & Preservation
- Branch: `master`, HEAD: `0f38b449c90a75ace8277a7e73da973e164c192b` ("feat(permissions): add phase 8 communication permissions")
- Working tree: tracked-modified `docs/PHASE_8_BLOCKING_DECISION_AND_READINESS_REPORT.md` (+188), `packages/db/src/security/phase8-communication.test.ts` (+987); staged: 0
- Stash: `stash@{0}: On master: save other changes` intact
- Untracked preserved: `.tmpgate/`, `migrations-not-authorized/`, docs 3G–3J + PHASE_8_TEMPLATE_CONTRACT_DECISIONS.md + PHASE_8_REDIS_GATE_VERIFICATION_REPORT.md, `.r11_map.json`, `__pycache__/`, stray `packages/db/{console.error(e.code)`, `testconn.mjs`
- No commits created. Migration files 0035/0036 are untracked (applied to test DB in this session).

Test DB `school_saas_test` (read-only inspection):
- `schema_migrations` count: 37 (0001–0030, 0035, 0036). 0035 and 0036 appear exactly once.
- Objects present: `notification_student_contexts`, `notifications.guardian_scope` (text NOT NULL DEFAULT 'student_scoped'), `notifications_tenant_id_uq` (UNIQUE (tenant_id,id)), four context policies, `notifications_scope_consistent_trg` (DEFERRABLE INITIALLY DEFERRED), `notification_contexts_consistent_trg` (DEFERRABLE INITIALLY DEFERRED), `announcements_lifecycle_trg` (BEFORE).
- No leftover Phase 8 tenants/templates. 0031–0034 absent as files (reserved/unallocated).

## 2) 0035 — Guardian Context + RLS + Deferred Triggers + Advisory Locks
**Constraints/anchor (verified):**
- Anchor: `UNIQUE (tenant_id, id)` on `notifications` (0035:59). Composite tenant-bound FKs to `notifications(tenant_id,id)` and `students(tenant_id,id)` with `ON DELETE CASCADE` (0035:78–83). `scope_uq (tenant_id,notification_id,student_id)` (0035:76–77). `guardian_scope` CHECK IN ('student_scoped') NOT NULL DEFAULT (0035:65–67).

**RLS/policies (verified):**
- `ENABLE ROW LEVEL SECURITY`, `FORCE ROW LEVEL SECURITY` on `notification_student_contexts` (0035:104–105).
- SELECT/INSERT: tenant-or-privileged (0035:106–115). UPDATE/DELETE: **privileged-only** (0035:116–120) via `app_privileged()` (0002:58–60); runtime role `school_app_rw` not privileged.
- Grants: `GRANT SELECT,INSERT,UPDATE,DELETE ON notification_student_contexts` to `school_app_rw` (0035:101); UPDATE/DELETE denied by policy in effect.

**Visibility (verified, fail-closed):**
- `notifications_select` (0035:364–409): guardian branch requires `guardians.deleted_at IS NULL` AND `fn_notification_scope_ok(...)` (0035:392–405). 
- `fn_notification_scope_ok` (0035:162–204): if guardian-addressed, require EXISTS ≥1 context AND NOT EXISTS any context whose student is not live or lacks a live link. This is the ALL-context invariant; a revoked/invalid context hides the entire notification.

**State-rereading deferred triggers (verified):**
- `trg_notifications_scope_consistent` (AFTER INSERT/UPDATE, DEFERRABLE INITIALLY DEFERRED; live pg_get_triggerdef confirms AFTER INSERT OR UPDATE only) validates via `fn_notification_scope_ok(NEW…)` and does not trust OLD/NEW shape beyond identity (0035:235–253). DELETE branch (241–243) is dead code (trigger does not fire on DELETE).
- `trg_notification_contexts_consistent` (AFTER INSERT/UPDATE/DELETE, DEFERRABLE INITIALLY DEFERRED; 0035:366–369): re-reads NEW parent (306–308), re-reads OLD parent for survival check (323–333, 342–344); distinguishes cascade by `IF FOUND` (326, 345). Validation uses `fn_notification_context_row_valid` and parent survival.

**Advisory locking (verified):**
- `fn_lock_notification_parent(p_tenant,p_notif_id)` does `PERFORM pg_advisory_xact_lock(hashtext(p_tenant::text), hashtext(p_notif_id::text))` (0035:216–227); live DB function body matches.
- Call sites: parent trigger (244), child INSERT (271), child UPDATE (296–303), child DELETE (341) — same (tenant, notif) key on every path.
- Canonical order for two-parent reassignment: compare (OLD.tenant_id,OLD.notification_id) < (NEW…) to acquire order (0035:294–304).
- Locks acquired before validation in all covered paths; after lock, only non-locking SELECTs. No `FOR UPDATE` remains in any Phase 8 function (live check: only pre-existing finance/MFA functions contain FOR UPDATE).
- Residual: hash collision => over-serialization only (deterministic per-notification). Advisory locks ignore RLS (DoS window not new); maintenance caution if row locks are added inside these triggers.

**Security:** all 6 functions SECURITY INVOKER with fixed search_path (`proconfig=search_path=pg_catalog,public,pg_temp`); PUBLIC revoked; appropriate grants.

## 3) 0036 — Announcement Lifecycle (Immediate BEFORE)
- Trigger `announcements_lifecycle_trg` BEFORE INSERT OR DELETE OR UPDATE (live pg_get_triggerdef), SECURITY INVOKER, fixed search_path.
- INSERT: draft-only, `published_at` NULL (0036:59–71).
- Transitions: draft→{published,cancelled}, published→cancelled; others 55000 (0036:85–92).
- `published_at`: server-owned, set to now() on draft→published; any other change refused (0036:96–101).
- Identity immutable: `id`,`tenant_id`,`created_at`; `created_by` excluded (0036:76–81; FK ON DELETE SET NULL 0030:136).
- `recipient_snapshot`: NULL→value once; rewrite/clear refused (0036:104–108).
- `deleted_at`: one-way, and cannot change in same statement as status (0036:112–121).
- Content frozen once non-draft: title/body/audience_scope (0036:125–132).
- DELETE: non-draft refused (55000); draft governed by RLS (0036:48–56).
- All errors SQLSTATE 55000, correct RETURN NEW/OLD.
- Note (non-bypass): soft-deleted published row may later move published→cancelled in a separate UPDATE (deleted_at guard only checks same-statement status change). Content remains frozen; status legal.

## 4) Concurrency Gates (H1–H3b)
Executed via `RUN_RUNTIME_SECURITY_TESTS=1 pnpm exec vitest run src/security/phase8-communication.test.ts` in `packages/db`.

Results (observed):
- [H1] commit outcomes: `55000, ok` | final committed contexts: `1` (two context deletions, same parent)
- [H2] mirrored reassignment outcomes: `ok, ok` | final n1/n2 contexts: `2 2` (no 40P01)
- 52/52 passed; Test Files 1 passed

Source mapping: H1 1362–1397 (uses c1/c2 MIGRATOR), H2 1399–1464, H3a 1466–1487, H3b 1489–1517. Timeouts 3s/10s (1350–1353). Deferred negatives use `expectCommitError` (commit-time), G tests use savepoints (immediate trigger). Runtime tests use real `school_app_rw` with minted tickets (F12–F15, G13–G14, H3b). Final state asserted.

Notes on test strength:
- H1 is a strong serialization test (unserialized would likely yield ok,ok with 0 contexts).
- H2 is weak as a “serialization necessary” proof (the mirrored interleaving is valid even without the lock); it is primarily a deadlock/non-regression gate (original FOR UPDATE produced 40P01).
- H3b exercises notification+context commit then revoke; H3a the reverse; true in-flight interleaving untested.
- Concurrency exercised only as privileged (migrator) sessions; runtime path cannot mutate contexts by design.

## 5) Regression & Typecheck
- Typecheck: `pnpm --filter @sms/db run typecheck` → clean (tsc --noEmit), no errors.
- Runtime suite (opt-in): 52/52 passed. No failures.
- Non-runtime suite: 5 files / 28 tests passed, 0 failed, 27 skipped (opt-in pattern unchanged). migrations-dir.test.ts and schema-migrations-protection.test.ts unaffected.
- Lint: no lint script/config in repo (root package.json has no lint; no eslint config). Not applicable.

## 6) DB State Verification (read-only)
Read-only queries via node/pg:
- `fn_lock_notification_parent` body contains `pg_advisory_xact_lock(hashtext(...), hashtext(...))`; SECURITY INVOKER, fixed search_path.
- No Phase 8 function body references `FOR UPDATE` (only pre-existing finance/MFA/app step-up functions do).
- `notifications_scope_consistent_trg`: `AFTER INSERT OR UPDATE ... DEFERRABLE INITIALLY DEFERRED ... EXECUTE FUNCTION trg_notifications_scope_consistent()`
- `announcements_lifecycle_trg`: `BEFORE INSERT OR DELETE OR UPDATE ... EXECUTE FUNCTION trg_announcements_lifecycle()`
- All Phase 8 trigger/helper functions: `prosecdef=false`, `proconfig=['search_path=pg_catalog, public, pg_temp']`.
- Policies on `notification_student_contexts`: r/a/w/d present; UPDATE/DELETE use `app_privileged()`.

## 7) Final Verdict
**PASS WITH CONDITIONS**

**Verified (source + read-only DB + executed tests/typecheck):**
- Correct anchor/FKs, domain constraints, ENABLE+FORCE RLS with privileged-only UPDATE/DELETE.
- ALL-context fail-closed guardian visibility (revocation/invalid context hides notification).
- State-rereading deferred triggers with proper cascade handling; deterministic advisory-lock serialization keyed by (tenant, notif) with canonical two-parent ordering; no FOR UPDATE in Phase 8.
- 0036 lifecycle/immutability rules strictly enforced (55000 on violations), server-owned published_at, write-once recipient_snapshot, frozen content, one-way soft delete behavior as specified.
- H1–H3a/H3b present; suite 52/52 passed; typecheck clean. No commits; artifacts/stash preserved.

**Conditions (document, don’t fix here):**
1. H2 is a weak serialization proof (valid even unserialized); treat as deadlock/non-regression gate or strengthen.
2. True in-flight revoke interleaving vs commit not exercised.
3. Advisory serialization only tested as privileged (migrator); runtime concurrency path untested (by design).
4. Documentation drift in `docs/PHASE_8_BLOCKING_DECISION_AND_READINESS_REPORT.md`: §21.6 states guardian RLS issue unresolved (stale) — 0035 resolves it; §22 lacks advisory-lock/canonical ordering details; test blurb overstates H2.
5. Minor: 0036 permits later status change on soft-deleted published row (document intent); 0035 has dead DELETE branch in parent trigger (harmless).
6. Independent re-execution of 52/52 not independently captured outside session (results recorded here).

No further code/schema changes authorized.

---

## Guardian-Revocation Concurrency Verification — C1/C2 Results (2026-10-10)

Dated documentation-only update. No database, test, migration, or application state was touched or re-verified in this task. Every outcome below is transcribed from the latest C1/C2 concurrency-overlap execution (the run of the opt-in suite described below); the run itself belongs to the previous session. Evidence labels used throughout:

- **Reported fresh execution result** — outcomes transcribed from that run.
- **Not independently reproduced in this documentation-only task** — applies to every execution claim below (no reruns, no DB connections, no typecheck in this task).
- **Source-level assessment** — conclusions based on SQL/code inspection.
- **Still unverified** — concurrency boundaries the suite cannot deterministically force.

### Baseline at documentation time
- Branch `master`, HEAD `122d71f` ("test(phase8): ratify announcement soft-delete lifecycle"); tracked working tree clean (`git diff --stat` empty); stash `stash@{0}` intact.
- `packages/db/src/security/phase8-concurrency-overlap.test.ts`: present, **untracked**.
- `packages/db/src/security/phase8-communication.test.ts`: present, **tracked, unmodified**.
- `packages/db/migrations/0035_com_guardian_context_rls.sql`, `0036_com_announcement_lifecycle.sql`: present, **untracked**.

### Reported execution
- **Reported fresh execution result / Not independently reproduced in this documentation-only task:** New opt-in test file `packages/db/src/security/phase8-concurrency-overlap.test.ts` (M1–M6, 12 tests), gated on `RUN_RUNTIME_SECURITY_TESTS=1` exactly like the other DB-backed security suites and not wired into any CI step. `phase8-communication.test.ts` untouched.
- **Reported fresh execution result / Not independently reproduced in this documentation-only task:** Reported command `RUN_RUNTIME_SECURITY_TESTS=1 vitest run src/security/phase8-concurrency-overlap.test.ts`; result 12/12 tests passed; typecheck clean (`tsc --noEmit`).
- **Reported fresh execution result / Not independently reproduced in this documentation-only task:** Target database `school_saas_test` only (disposable-name validation in `runtime-db.ts`); reported migration setup zero newly applied, 37 already current in `schema_migrations`; `school_saas_dev` reported untouched.
- **Reported fresh execution result / Not independently reproduced in this documentation-only task:** Cleanup probe reported zero remaining `p8c-%` rows across `students`, `notification_student_contexts`, `notifications`, and `student_guardians`.

### Reported outcomes by test group
- **M1a / M1b (Reported fresh execution result):** creator-commits-then-revoker → committed notification hidden after the revocation lands; revoker-commits-first → creator COMMIT refused SQLSTATE `55000`.
- **M2 close-boundary stress (Reported fresh execution result):** 8 iterations, all 8 returned SQLSTATE `55000`; no committed-and-hidden outcome observed in those iterations. An envelope sample — see limitation 1.
- **M3a / M3b (Reported fresh execution result):** runtime-role creator (`school_app_rw`) and privileged revoker coverage included; same tolerated outcomes as M1a/M1b.
- **M4 (Reported fresh execution result):** statement-boundary visibility — same-transaction reader saw 1 pre-revocation / 0 post-revocation; a fresh reader statement after revocation durability saw 0.
- **M5 (Reported fresh execution result):** advisory-lock contention returned `55P03` within the configured lock/statement timeouts and succeeded after the lock was released.
- **M6a1 / M6a2 (Reported fresh execution result):** hard-delete of the link after commit → notification survives but is hidden; hard-delete of the link in a live in-flight transaction → creator COMMIT refused `55000`.
- **M6b1 / M6b2 / M6b3 (Reported fresh execution result):** soft-deleted student → committed notification hidden; hard-deleting a sole-context student refused `55000` (fail-closed: the deferred DELETE-trigger re-validation prevents the cascade to a contextless guardian notification — a fresh finding that superseded the cascade-only premise); hard-deleting one of two context students cascaded cleanly and the notification stayed visible.

### Reconciliation with prior audit findings
- The earlier section 4 (H1–H3b) and its Condition 2 ("True in-flight revoke interleaving vs commit not exercised") remain recorded as the historical state of the previous session; they are retained, not overwritten. The C1/C2 results above now report true overlapping in-flight interleavings (M1a/M1b, M3a/M3b, M6a2) as **Reported fresh execution result / Not independently reproduced in this documentation-only task**.
- `docs/PHASE_8_BLOCKING_DECISION_AND_READINESS_REPORT.md` §22.2 item 3 / §22.3 documented the in-flight revocation interleaving as "unverified pending separate test authorization"; the C1/C2 suite is the outcome of that authorization and the section above records its reported coverage. The boundary the suite still cannot force remains listed under `Still unverified` below.

### Still unverified (preserved limitations)
1. Eight close-boundary iterations are useful evidence but do not prove every commit-protocol interleaving.
2. The suite cannot pin the exact microsecond boundary between deferred validation and transaction commit durability.
3. Clean-checkout CI coherence remains unresolved while the committed test depends on migration files 0035/0036 that are not committed.
4. The new opt-in test file remains untracked unless a later, separate authorization changes that status.
5. C1/C2 authorization does not authorize migration edits, migration commits, CI changes, or application changes.

### Source-level assessments (this documentation task only)
- **Source-level assessment:** the suite's deterministic cases use only forceable synchronization primitives — row-lock negotiation, transaction-scoped advisory locks (`pg_advisory_xact_lock`), READ COMMITTED statement-boundary snapshots — and M2 is an uncoordinated close-boundary stress over the tolerated outcome set, not a claim of forcing the unforceable commit-protocol interleave.
- **Source-level assessment:** per the C1/C2 scope, migration files (including 0035/0036), test files, application code, CI configuration, and environment files were not modified by this documentation task; only this documentation file changed.