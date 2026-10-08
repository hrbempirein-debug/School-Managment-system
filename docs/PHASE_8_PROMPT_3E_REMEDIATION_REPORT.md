# PHASE 8 — PROMPT 3E REMEDIATION REPORT (four blockers)
**Version:** 1.0
**Date:** 2026-10-08
**Repository:** G:\School Managment system
**Branch:** master
**HEAD:** 5bf11d0067424ea6e372f92f536e4af0aa795552 (unchanged)

## 1. Executive Summary

Four proven blockers from the Phase 8 blocking-decision were remediated in
**targeted fashion only** — no Phase 8 implementation, no migrations added or
modified, no dependencies installed, no commits/pushes/tags:

- **R-1** — `ROLE_TEMPLATES` now reproduce the full Phase 7 finance matrix
  (`school_owner` 25 `fees.*`; `accountant` 22; `principal` `fees.reports.read`;
  **new `cashier`** tenant template with exactly 3; `parent`/`student` `fees.portal.read`).
  Fresh-tenant parity is proven by a rewritten D9 proof that provisions TWO
  disposable tenants through the **production bootstrap** (`createTenantTransaction`)
  and asserts the DB content equals the catalog exactly (106 per tenant, all 25
  `fees.*`).
- **R-3** — the outbox **envelope** `event.tenantId` is now the single
  authoritative tenant selector. `assertEventTenant` (first statement of
  `runEventHandler`) rejects absent/mismatched/malformed payload echoes with
  **zero data-plane SQL**; all five handler modules resolve through
  `tenantIdOf(event)`, backed by a runtime T1–T5 suite and a source-scan gate.
- **R-2** — the three stale `113` catalog-count claims corrected to **114**.
- **R-4** — the false Phase 7 dunning claims (`fee.invoice.overdue` /
  `fee.parent.notification.requested` "Phase 7 emits, Phase 8 consumes",
  `finance-024` assertions) reclassified per blocking-decision §5.6 to the
  **Phase 9+ backlog, blocked on a scheduler primitive** across all seven
  `PHASE_7_FINANCE_DESIGN.md` locations.

**Final Verdict:** PROMPT 3E REMEDIATION COMPLETE — ALL FOUR BLOCKERS CLOSED, NO
PHASE 8 IMPLEMENTATION, MIGRATIONS 0001–0028 UNTOUCHED, 0029 RESERVED, NO COMMITS.

## 2. Scope and hard constraints honoured

- No migration files `0001–0028` modified; `0029` remains reserved
  (`fin_artifacts_webhooks.sql`); no `0030+` created.
- Never touched `school_saas_dev` — every runtime proof used the disposable
  `school_saas_test` via `packages/db/src/testing/{global-setup,setup-env,runtime-db}.ts`.
- No dependency/lockfile changes; no commits/pushes/tags; branch `master` at
  baseline HEAD `5bf11d0` throughout.
- R-1 needed **no migration** (the matrix lives in `ROLE_TEMPLATES` code; the
  immutable `0028` §20.5 backfill is the historical record, reproduced and
  cross-checked by tests).
- `docs/PHASE_8_3D_REMAINING_SECTIONS_AUDIT.md` **left untouched** (it correctly
  documented the mismatch R-2 fixes elsewhere).

## 3. Baseline verification

- HEAD `5bf11d0067424ea6e372f92f536e4af0aa795552`, branch `master`.
- Working tree already dirty from prior approved phases (expected, per Prompt 3a).
- No migration files in `git status`; `0029*/0030+` absent from `packages/db/migrations/`.
- Pre-existing unrelated artifacts remain untouched (`.r11_map.json`, `.tmpgate/`,
  `__pycache__/`, `migrations-not-authorized/`, `packages/db/{console.error(e.code`,
  `testconn.mjs`, prior-phase reports).

## 4. R-1 — Authoritative matrix (no second source of truth)

`packages/db/migrations/0028_phase7_finance_security.sql` §20.5 (immutable) is the
historical contract; the forward path for new tenants is `ROLE_TEMPLATES`
(`packages/permissions/src/permissions.ts`). The remediation makes the code
reproduce the migration **row for row** and proves it:

- `FEES_PERMISSIONS` derived from `PERMISSION_CATALOG` = the 25 `fees.*` members.
- `school_owner` gains `...FEES_PERMISSIONS` (25); `accountant` gains
  `FEES_PERMISSIONS` minus the §20.5 exclusions (`fees.structures.manage`,
  `fees.assignments.manage`, `fees.portal.read`) = 22.
- `principal` gains exactly `fees.reports.read`.
- New tenant template **`cashier`** (scope `tenant`, `is_system`) with EXACTLY
  `fees.payments.read`, `fees.payments.collect`, `fees.receipts.read` — never
  `fees.receipts.reissue` (P1-03). Created unassigned; ownership assignment stays
  a separate act.
- `parent`/`student` gain exactly `fees.portal.read`.
- `assertCatalogConsistent()` adds the **D9 coverage invariant**: every catalog
  permission is reachable from ≥1 role template of its own scope.

Static arithmetic after fix (all verified by tests, not asserted by hand):
catalog **114** unique; tenant union **106**; `codes` =
school_owner, principal, teacher, accountant, cashier, parent, student; roster
permissions 106/30/11/25/3/6/6; 53 `fees.*` rows per tenant; catalog ==
template-union ∪ migration-declared (114/114).

## 5. R-1 — Static proof (no DB)

`apps/worker/src/d9-permission-parity.test.ts` (9 static tests, run in default
worker suite):

- catalog is exactly **114** unique; every template permission resolves.
- template union == whole catalog (no orphan permission, no template-only drift).
- tenant union == catalog minus `platform.*` = **106**; platform union = 8.
- tenant role codes == the seven templates (incl. `cashier`).
- the catalog owns exactly **25** `fees.*` **and every one is reachable from a
  tenant template** — the assertion that failed before remediation.
- migration-declared permissions = exactly **77**, all catalog-valid;
  catalog == template-union ∪ migration-declared.
- **ROLE_TEMPLATES' finance matrix reproduces 0028 §20.5 row for row** (53 rows
  parsed from the immutable SQL: 25+22+3+1+1+1); no template invents a grant §20.5
  omits and none omits one §20.5 makes.

## 6. R-1 — Live bootstrap proof (production path, disposable DB)

9 live tests (opt-in): **two** fresh tenants and a legacy fixture are provisioned
with real UUIDs via `withSystem(db, tx => createTenantTransaction(tx, {userId},
{slug, name, requestId}))` — the exact API route function — and DB rows are read
back. Assertions:

- both tenants seed exactly the 7 tenant roles (incl. `cashier`), all
  `scope='tenant'`, `is_system=true`, owned by their tenant.
- `cashier` exists holding EXACTLY the three §20.5 permissions; never
  `fees.receipts.reissue`.
- per-role `role_permissions` EXACTLY equal `ROLE_TEMPLATES`.
- the fresh-tenant union equals the authoritative tenant permission set (106)
  with explicit `missing/extra/duplicates/invalid` failure reporting.
- all **25** `fees.*` individually asserted present (incl. the four refund
  permissions).
- §20.5 matrix check: only `{school_owner, accountant, cashier}` hold the three
  collection permissions; teacher/parent/student hold no write grants; principal
  holds exactly `fees.reports.read`; `fees.structures.manage` — school_owner only.
- **cross-tenant row-identity isolation**: A and B share no role id and no
  permission row; per-code capabilities identical.
- **existing-tenant unchanged**: a byte-identical before/after diff of every
  pre-existing `roles`/`role_permissions` row; no new row for a foreign tenant.
- **legacy fixture**: a pre-Phase-7 tenant (6 roles, 134 rows, unique union 81,
  zero `fees.*`) is left byte-identical after a further production bootstrap.

API-level proof: `apps/api/src/routes/tenants.test.ts` **3/3 passed** with
`RUN_RUNTIME_SECURITY_TESTS=1` (route creates tenant + owner membership + commits
tenant-scoped audit/outbox).

## 7. R-3 — Trust chain design

- `apps/worker/src/tenant-invariant.ts` rewritten: `assertEventTenant` first
  validates the envelope (`tenantId` concrete, non-empty, non-whitespace), then —
  if the payload carries a `tenantId` key — requires it to be a non-empty string
  **equal to the envelope**; any mismatch/malformed value is rejected. `tenantIdOf`
  is the only sanctioned handler selector; re-validates so direct handler calls are
  safe.
- `runEventHandler` already calls `assertEventTenant` as its **FIRST statement**,
  before `withGuc` and before any SQL — unchanged, now with payload-echo checking.
- **Handlers migrated off payload-first selection** (the actual R-3 defect):
  - `attendance.ts`, `exams.ts`: local `tenantIdOf` (payload-first w/ envelope
    fallback) removed; imports the invariant's.
  - `promotion.ts`, `documents.ts`, `student-import.ts`: `payload['tenantId']`
    reads replaced by `tenantIdOf(event)`; error messages no longer demand a
    payload tenant.
- Residual (documented): `worker.ts:240/254` read `payload.tenantId` from Mail /
  Reports **BullMQ job payloads** (no outbox envelope exists there) — out of scope
  for the envelope trust chain. Pre-existing `OutboxEvent` tsc error (the
  missing import) is now fixed.

## 8. R-3 — Runtime proof (T1–T5, disposable DB)

`apps/worker/src/d3-worker-tenant-isolation.test.ts` — the old "TRUST-CHAIN probe"
(which asserted payload.tenantId *overrides* the envelope — the vulnerability) is
replaced by 6 tests, all passing:

- **T1 ACCEPT**: envelope A == payload A → same-tenant result; B never bound.
- **T2 ACCEPT**: envelope A, **no payload.tenantId** → handler runs on envelope A.
- **T3 REJECT**: envelope A / payload B mismatch → aborts with **zero SQL**
  (drizzle statement recorder `captured` empty).
- **T4 REJECT**: envelope B / payload A mismatch → same.
- **T5 REJECT**: empty/whitespace/null/number/boolean/object payload.tenantId →
  `malformed payload.tenantId`, zero SQL.
- **T3–T5 via `processEvent`**: DB-unchanged — the ONLY statement is the
  failure-record `update "outbox_events"` on the event's own row (asserted: no
  `attendance_days`/`promotion_batches`/`students`, neither tenant bound).

`tenant-invariant.test.ts` expanded 4 → **14** unit tests covering all branches.

## 9. R-3 — Static gate (no DB)

New `apps/worker/src/d3-tenant-trust-gate.test.ts`:

- **Non-vacuous**: a fixture selecting the tenant from `event.payload['tenantId']`
  FAILS the gate; the fixture is deleted afterwards (postcondition asserted).
- **Production**: no worker source reads `event.payload.tenantId` /
  `event.payload['tenantId']` outside the enforcement point
  (`tenant-invariant.ts`).
- The five data-plane handler modules must import `tenantIdOf` and call
  `tenantIdOf(event)`; greps would catch any reintroduction.

## 10. R-2 — Permission-count doc fix (113 → 114)

- `docs/PHASE_8_EVIDENCE_CLOSURE_REPORT.md:36` — `(total 113)` → `(total 114)`.
- `docs/PHASE_8_PRE_IMPLEMENTATION_REMEDIATION_REPORT.md:43` — `count 93→113` → `93→114`.
- `docs/PHASE_8_SECURITY_PROOF_CLOSURE_REPORT.md:64` — `count 113` → `count 114`.
- `docs/PHASE_8_3D_REMAINING_SECTIONS_AUDIT.md` intentionally **unchanged** (it is
  the document that correctly recorded the mismatch).

## 11. R-4 — Dunning doc reclassification (per blocking-decision §5.6, DOC-3)

All seven `docs/PHASE_7_FINANCE_DESIGN.md` locations corrected — the claim
"Phase 7 emits `fee.invoice.overdue` / `fee.parent.notification.requested`;
`finance-024` asserts it" is replaced by the reclassification (0 emissions, 0 enum
members, no `finance-024` test; dunning → **Phase 9+ backlog, blocked on a
scheduler primitive**):

- `:278` exclusion table row; `:12314` event-listing block;
  `:12385`/`:12386` NOOP disposition rows; `:12863` boundary row;
  `:14281`/`:14296` subphase worker-events rows.
- No events were added to the registry, no `finance-024` created
  (explicitly out of scope; that is `DOC-4`/Phase 8 doc work).

## 12. Test summary

| Suite | Default | Opt-in (`RUN_RUNTIME_SECURITY_TESTS=1`) |
|---|---|---|
| @sms/permissions | **30 passed** | 30 passed |
| @sms/db | 28 passed / 508 skipped | (same non-redis) |
| @sms/worker | **81 passed / 108 skipped** (8 files) | **181 passed / 7 failed / 1 skipped** |
| @sms/api | 59 passed / 437 skipped (6 files) | tenants.test.ts 3/3 passed; remaining files gated on Redis |
| @sms/contracts | no test files | — |

R-1/R-3 highlights (all passing): d9 parity **18** (9 static + 9 live);
d3 worker isolation **20** (incl. T1–T5); tenant-invariant **14**;
tenant-trust-gate **3**; static tenant gate **2**; tenants route **3**.

## 13. Pre-existing environmental limitation (Redis down — unrelated)

The 7 opt-in failures (outbox-integration 3,4,5,12,15,16,22) and the
queue-routing D1-LIVE setup are all **`ECONNREFUSED 127.0.0.1:6379`** /
`Connection is closed` — no Redis server is running in this environment
(verified directly). These suites/opt-in blocks were added in prior phases
(D1/D2) and exercise BullMQ/Redis; they do not touch R-1/R-2/R-3/R-4 code paths
and fail identically without my changes. The D1 report should treat "opt-in Redis
suites" as runnable only when Redis is present; everything Redis-free that my
changes can affect passes.

## 14. Typecheck

- `@sms/permissions`: clean.
- `@sms/api`: clean on its own tsconfig.
- `@sms/worker`: **no NEW errors introduced**. Two prior worker-local errors are
  now FIXED (the `OutboxEvent` name-import in `tenant-invariant.ts`; the
  d9 import-path quirk). Remaining 1 worker-local (pre-existing comparison in
  `d3-static-tenant-gate.test.ts`, untouched) + 22 api fastify-augmentation
  errors surfaced by the worker tsconfig's cross-package reference (pre-existing).

## 15. Migration and git integrity

- `git status` over `packages/db/migrations/`: **empty** (0001–0028 untouched);
  no `0029*/0030+`.
- HEAD unchanged at `5bf11d0067424ea6e372f92f536e4af0aa795552`; branch `master`;
  no commit/push/tag/reset/rebase.
- `git diff --check`: only pre-existing blank-line-at-EOF in
  `packages/jobs/src/queues.ts:116` (prior-phase D1 work; not touched here).
- Runtime DB used exclusively: disposable `school_saas_test` (migrations applied:
  0, already current: 34); `school_saas_dev` untouched.

## 16. Files changed (this prompt)

- `packages/permissions/src/permissions.ts` (R-1: matrix + cashier + coverage invariant)
- `apps/worker/src/tenant-invariant.ts` (R-3: rewritten + `OutboxEvent` import + `tenantIdOf`)
- `apps/worker/src/{attendance,exams,promotion,documents,student-import}.ts` (R-3: envelope selector)
- `apps/worker/src/d9-permission-parity.test.ts` (R-1: gap→parity rewrite, 18 tests)
- `apps/worker/src/tenant-invariant.test.ts` (R-3: 4→14)
- `apps/worker/src/d3-worker-tenant-isolation.test.ts` (R-3: probe→T1–T5)
- `apps/worker/src/d3-tenant-trust-gate.test.ts` (R-3: new static gate)
- `apps/worker/src/documents.test.ts`, `apps/worker/src/student-import.test.ts`
  (R-3: updated rejection-message expectations)
- `docs/PHASE_8_EVIDENCE_CLOSURE_REPORT.md`, `docs/PHASE_8_PRE_IMPLEMENTATION_REMEDIATION_REPORT.md`,
  `docs/PHASE_8_SECURITY_PROOF_CLOSURE_REPORT.md` (R-2: 113→114)
- `docs/PHASE_7_FINANCE_DESIGN.md` (R-4: 7 dunning lines reclassified)
- `docs/PHASE_8_PROMPT_3E_REMEDIATION_REPORT.md` (this file)

## 17. Independent-audit checklist

- [x] R-1: catalog 114 / tenant union 106 / all 25 `fees.*` reachable; §20.5 matrix reproduced row-for-row; cashier exactly 3.
- [x] R-1: production bootstrap proven on disposable tenants A/B/C + legacy fixture; existing rows byte-identical.
- [x] R-3: envelope authoritative; T1–T5 pass with zero data-plane SQL on rejections; handlers all use `tenantIdOf(event)`; static gate non-vacuous.
- [x] R-2: all three stale `113` references → `114`.
- [x] R-4: all seven dunning doc locations reclassified per §5.6.
- [x] Migrations 0001–0028 untouched; 0029 reserved; no 0030+; no commits/pushes; `school_saas_dev` untouched.
- [x] No new tsc errors; no dependency/lockfile changes.

---

## PROMPT 3E STATUS:

```
BLOCKER              STATUS    EVIDENCE
R-1 fresh-tenant     CLOSED    ROLE_TEMPLATES == 0028 §20.5 (row-for-row, 53 rows);
finance/cashier                 d9-parity 18/18 (9 static + 9 live via createTenantTransaction);
bootstrap                       tenants.test.ts 3/3; existing tenants byte-identical; A/B isolated.
R-3 worker envelope/ CLOSED    envelope authoritative; 5 handlers use tenantIdOf(event);
payload trust chain             assertEventTenant first statement; T1–T5 with ZERO data-plane SQL;
                                tenant-invariant 14/14; trust-gate 3/3 (non-vacuous); static gate 2/2.
R-2 permission count CLOSED    113 → 114 in all 3 stale report references; audit doc untouched.
  (113 vs 114)
R-4 false Phase 7    CLOSED    all 7 PHASE_7_FINANCE_DESIGN.md dunning claims reclassified
dunning docs                     per §5.6 (fee.invoice.overdue / fee.parent.notification.requested
                                → Phase 9+ backlog, blocked on scheduler). No fake finance-024.

INTEGRITY: migrations 0001-0028 untouched, 0029 reserved, no 0030+, HEAD 5bf11d0,
master, no commits/pushes, school_saas_dev untouched, no new tsc errors.
REDIS GATE (-): 7 worker + API opt-in failures are ECONNREFUSED (no Redis server
up) — pre-existing environmental, unrelated to R-1..R-4.

FINAL VERDICT: PROMPT 3E REMEDIATION COMPLETE — ALL FOUR BLOCKERS CLOSED.
```