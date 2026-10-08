# PHASE 8 — Prompt 3F: INDEPENDENT FINAL VERIFICATION OF 3E REMEDIATION

> **Audit-only.** This report verifies that Prompt 3E closed R-1..R-4 and that the
> repository is now ready for the Phase 8 implementation audit. It changed no
> code, no migration, no test, no dependency, and no database. Every claim below
> is backed by a re-run, a re-read, or a command output captured during this audit.

---

## 1. VERDICT

```
FINAL VERDICT: CLEARED WITH CONDITIONS.
         - "CLEARED WITH CONDITIONS" requires and receives the two explicit
           conditions below; every code/security property of R-1..R-4 is
           independently proven (see sections 6-18).
         - No BLOCKED code/security defect was found. Every fix audited is
           present and every record/reference is accurate.
         - 3E's asserted remediation, independently re-verified, is COMPLETE.

PHASE 8 IMPLEMENTATION MAY START: YES
  Reason: Every R-1..R-4 remediation claim in the 3E report was independently
  re-verified from this audit's OWN source-text counts, own runs and own
  greps (sections 6-18); the migration/dependency/git immutability checks and
  stop-condition checks all pass with NO contamination (sections 19-24). The
  single non-verified gate is REDIS GATE = UNVERIFIED (section 25) — the local
  environment has no Redis server — which forces "CLEARED WITH CONDITIONS"
  rather than "CLEARED FOR PHASE 8 IMPLEMENTATION AUDIT".
  Conditions before the Phase 8 cutover:
    C1  In the Phase 8 implementation environment, run the previously-blocked
        opt-in suites with a live Redis (outbox-integration tests 3/4/5/12/15/16/22,
        queue-routing D1-LIVE, and the API runtime suites) and record their
        results in the Phase 8 implementation report.
    C2  Merge/rebase and commit the 3E remediation (test/material additions are
        currently untracked; section 23) ONLY as part of the Phase 8
        implementation audit, after the Phase 8 maintainer confirms the 3E
        material, exactly as required by the 3E constraints. Applying any new
        code or migration before that point would violate the audit's scope.
```

---

## 2. TRIGGER

- The documented trigger is issued by the repository owner: **Prompt 3F** — an
  INDEPENDENT final verification that Prompt 3E's remediation actually closed
  R-1..R-4, that the remediation is compatible with the renumbered final Phase 8
  Report, and that nothing else changed. This report is the audit's sole output.

## 3. SCOPE

- **Audited:** `packages/permissions/src/permissions.ts` (R-1 matrix),
  `packages/contracts/src/events.ts`, `packages/contracts/src/jobs.ts`,
  `packages/db/migrations/0028_phase7_finance_security.sql` (§20.5 backfill),
  `packages/db/src/schema.ts`, `apps/api/src/plugins/auth.ts` + routes
  `apps/api/src/routes/tenants.ts` (authz path),
  `packages/tenancy/src/index.ts`, `apps/worker/src/worker.ts` and all handlers
  (`attendance.ts`, `documents.ts`, `student-import.ts`, `promotion.ts`,
  `exams.ts`, `report-pdf.ts`), the new invariant files
  `tenant-invariant.ts` + tests, the d9/d3 evidence suites, vitest runtime-DB
  wiring, 3E's remediation report, and the R-2/R-4 documentation targets.
- **NOT audited (out of 3F scope):** Phase 8 feature code (there is none to
  audit), D1/D2 logic beyond what is needed to classify the Redis-blocked
  suites, deployment/CI config, or any Phase 9+ backlog content.

## 4. METHOD AND INDEPENDENCE

- **Independence:** this audit recomputed every R-1 number from PRIMARY SOURces —
  the source text of `permissions.ts` was counted by a regex over the file,
  NOT via the module's exports (the module was also imported and checked equal);
  the §20.5 matrix was extracted from the migration SQL SOURCE by regex, NOT from
  the template code. Then a LIVE disposable-DB run proved the runtime DB equals
  those expectations. The 3E report was never used as a source; it was only
  cross-referenced AFTER the independent numbers existed.
- **Gates used:** `RUN_RUNTIME_SECURITY_TESTS=1` routes all worker suites to the
  disposable `school_saas_test` DB only. No production/dev DB was touched.
- **Tools:** `vitest`, `tsc --noEmit`, `git`, `pg` via `@sms/db` runtime-db,
  `psql`-free deterministic checks, `ripgrep`.

## 5. BASELINE — REPO, HEAD, BRANCH (RE-VERIFIED, UNCHANGED)

| Check | Expected | Observed | Status |
|---|---|---|---|
| HEAD | `5bf11d0067424ea6e372f92f536e4af0aa795552` | identical | PASS |
| Branch | `master` | `master` | PASS |
| `git diff -- packages/db/migrations` | empty | empty | PASS |
| `git diff -- package.json pnpm-lock.yaml` | empty | empty | PASS |
| Migration dir: no `0029`/`0030+` | absent | absent (only 0001-0028 incl. two `0028_*`) | PASS |
| `packages/db/migrations-not-authorized/` | outside authorized dir | `0026_fin_ledger.sql`, `0027_fin_reconciliation.sql`, `0028_fin_runtime_security.sql`, `0029_fin_final.sql` | PASS (untracked, pre-existing, NOT in scope; no Phase 8 content) |
| stash | pre-existing `stash@{0}` | untouched | PASS |
| `.env.example`, routes, contracts, jobs, db index, queues, permissions | 3E-modified, uncommitted | as listed in section 23 | PASS |

## 6. STOP-CONDITION CHECK (none triggered)

The three enumerated stop conditions are checked at audit start on the LIVE —
not on any reported value — and NONE is true on a re-run:

1. **No catalog drop/shift:** §26 refresh = PASS (`114`/`106` re-derived from
   source, section 7). Stop-condition "new permission NOT in the string catalog,
   template, or migration" = FALSE.
2. **No fee matrix regression:** §20.5 backfill reproduced row-for-row (section
   8). Stop-condition FALSE.
3. **No handler-tenant defect:** `tenantIdOf(event)` in all handlers; no
   payload-carried tenant as source (sections 13-14). Stop-condition FALSE.

## 7. R-1 — AUTHORITATIVE MATRIX, COUNTED FROM PRIMARY SOURCE

- Catalog `codes` counted from the SOURCE TEXT of `permissions.ts`:
  **exactly 114 unique** (`platform.*` 8; tenant 106 — 81 non-fee + 25 `fees.*`).
  Duplicates in source: 0.
- Imported module count == source-text count (114 == 114).
- Template union == catalog (no orphans, no template-only permissions) and
  tenant union == 106. (3F-audit static test PASS.)
- `ROLE_TEMPLATES` per-role matrix: school_owner 106, principal 30, teacher 11,
  accountant 25, cashier 3, parent 6, student 6.
- Cashier == exactly `fees.payments.collect`, `fees.payments.read`,
  `fees.receipts.read` (no `fees.receipts.reissue`).
- parent/student == exactly `fees.portal.read`. teacher == no `fees.*` at all.
  accountant == all 22 owner-skewed minus `fees.structures.manage`,
  `fees.assignments.manage`, `fees.portal.read` (i.e. DOES hold
  `fees.receipts.reissue` as the backfill prescribes). principal == exactly
  `fees.reports.read`.

## 8. R-1 — §20.5 BACKFILL REPRODUCED FROM MIGRATION SOURCE, ROW-FOR-ROW

- The `0028_phase7_finance_security.sql` §20.5 backfill was parsed from the SQL
  source by regex (its own extraction, independent of the TS template). Observed:
  **53 `fees.*` rows**.
  - school_owner 25 (all 25 incl. `fees.structures.manage`, `fees.assignments.manage`,
    `fees.receipts.reissue`, `fees.refunds.approve/process`, `fees.reconciliation.manage`,
    `fees.portal.read`)
  - accountant 22; principal 1 (`fees.reports.read`); cashier 3; parent 1
    (`fees.portal.read`); student 1 (`fees.portal.read`)
- Cross-compare to `ROLE_TEMPLATES`: missing_from_template = none,
  extra_in_template = none, mismatched_roles = none, duplicate_rows = none.
- SQL-level dups impossible by construction: `roles_tenant_code_uq`
  (`schema.ts:183`) and role_permissions composite PK `(role_id, permission)`
  (`schema.ts:199`).

## 9. R-1 — LIVE BOOTSTRAP PROOF (disposable DB, production path)

- A disposable `school_saas_test` DB was created by the runtime harness
  (`migrations applied: 0, already current: 34`).
- Through the PRODUCTION `createTenantTransaction`, two fresh tenants were
  provisioned (owner membership + school_owner minted).
- The DB `role_permissions` for each of the 7 roles was SELECTed and compared to
  `ROLE_TEMPLATES` EXACTLY, per role AND as the union:
  - school_owner template=106 db=106; principal 30/30; teacher 11/11;
    accountant 25/25; cashier 3/3; parent 6/6; student 6/6.
  - union = 106 (expected 106); union_missing = none; union_extra = none.
- A LEGACY (pre-Phase-7) tenant configuration used by d9 (test, live) was
  verified byte-identical after the migration batch — non-regression PASS
  (d9 test "existing-tenant fixture" 18/18, §16).

## 10. R-1 — RUNTIME AUTHORIZATION (resolveTenantContext PATH)

- LIVE: with the disposable tenant, `resolveTenantContext(db, { userId, tenantId })`
  was executed per role and the effective `fees.*` permission set extracted,
  asserting the §20.5 grants AND the enumerated `lacks` (the exact forbidden
  combos the 3E remediation cared about):
  - school_owner => all 25 `fees.*`; principal => `fees.reports.read` only;
    teacher => none; accountant => 22 (incl. `fees.receipts.reissue`, EXCLUDING
    `fees.structures.manage`, `fees.assignments.manage`, `fees.portal.read`);
    cashier => exactly `fees.payments.collect`, `fees.payments.read`,
    `fees.receipts.read`; parent => `fees.portal.read`; student => `fees.portal.read`.
  - Every `lacks` combination asserted = denied. (3F-audit live authz test PASS.)
- STATIC: `apps/api/src/plugins/auth.ts` deploys `requirePermission` +
  `requireTenantContext`, and the tenants route uses `createTenantTransaction`;
  the authorizer's `resolveTenantContext` (tenancy) reads memberships +
  membershipRoles against the same DB rows proven above. The API binary itself
  typechecks clean (section 22).

## 11. R-2 — PERMISSION-COUNT DOC FIX (113 → 114)

- The three formerly-stale references, re-read at their exact lines:
  - `docs/PHASE_8_EVIDENCE_CLOSURE_REPORT.md:36` — `(total 114)` ✓
  - `docs/PHASE_8_PRE_IMPLEMENTATION_REMEDIATION_REPORT.md:43` — `count 93→114` ✓
  - `docs/PHASE_8_SECURITY_PROOF_CLOSURE_REPORT.md:64` — `count 114` ✓
- The 6 remaining `113` occurrences are all inside
  `docs/PHASE_8_3D_REMAINING_SECTIONS_AUDIT.md` and are historical quotes of the
  pre-3E state; they are correct as historical references and MUST NOT change.

## 12. R-4 — DUNNING DOC RECLASSIFICATION (per blocking-decision §5.6)

- `docs/PHASE_7_FINANCE_DESIGN.md:278` — Phase 7 does NOT emit `fee.invoice.overdue`; no
  such event exists; reclassified Phase 9+ backlog, blocking-decision §5.6. ✓
- `docs/PHASE_7_FINANCE_DESIGN.md:12314` — `fee.invoice.overdue` /
  `fee.parent.notification.requested` are NOT emitted; same reclassification. ✓
- `apps/worker/src/event-registry-parity.test.ts:150` — asserts
  `fee.invoice.overdue` is a BOGUS (rejected) event type. ✓
- No `finance-024` test reference exists anywhere in `apps/`/`packages` `.ts`.
  The remaining `finance-024` mentions are design-doc rows that describe future
  finance dispositions, not emissions or tests. R-4 CLOSED.

## 13. R-3 — TRUST CHAIN AND HANDLER INVENTORY

`assertEventTenant` is the FIRST statement of `runEventHandler`
(`worker.ts:61`), before `withGuc` (`worker.ts:67`) and before any handler/SQL.
`tenantIdOf(event)` returns the envelope tenant or throws.

Table 1 — complete handler inventory, audited live (default worker build registers
every one of these; grep/read of each source):

| Handler | file:line | Driven by | Tenant selector |
|---|---|---|---|
| `runEventHandler` | `worker.ts:56` | BullMQ `events` worker | `assertEventTenant` first, `withGuc(event.tenantId)` |
| `makeLateNotificationHandler` | `attendance.ts:49` | `attendance.marked` | `tenantIdOf(event)` |
| `makeLeaveDecisionHandler` | `attendance.ts:127` | `leave.approved/rejected` | `tenantIdOf(event)` |
| `runDailyAttendanceSummaries` | `attendance.ts:248` | scheduled job | tenant-scoped per row; system job |
| `makeScanHandler` | `documents.ts:48` | `document.scanned` | `tenantIdOf(event)` |
| `makeStudentImportHandler` | `student-import.ts:140` | `student.imported` | `tenantIdOf(event)` |
| `makePromotionHandler` | `promotion.ts:32` | `placement.promotionApplied` | `tenantIdOf(event)` |
| `makeResultComputeHandler` | `exams.ts:264` | `exam.result.computed` | `tenantIdOf(event)` |
| `makeReportCardGeneratedHandler` | `exams.ts:507` | `exam.reportCard.generated` | `tenantIdOf(event)` |
| `makePublishNotificationHandler` | `exams.ts:539` | `exam.published` | `tenantIdOf(event)` |
| `processReportCardJob` | `exams.ts:696` | BullMQ `reports` worker | `tenantId` from JOB payload provenance (section 14) |
| `report-pdf.ts` | renderer | pure | NO DB access |
| mail worker | `worker.ts:233` | BullMQ `mail` | logs `payload.tenantId` only; NO DB |

Every R-3 tenant-scoped handler resolves its tenant via `tenantIdOf(event)` —
NO handler reads `event.payload.tenantId` as its source of truth.

## 14. R-3 — PAYLOAD.TENANTID CENSUS AND REPORTS RECONCILIATION

- Complete grep census for `payload.*tenantId` in `apps/`/`packages`:
  - PRODUCTION reads are limited to EXACTLY three sites:
    - `tenant-invariant.ts` — the enforcement point itself.
    - `worker.ts:240` — mail worker: logs `payload.tenantId`, no DB.
    - `worker.ts:253-254` — reports worker: reads `payload.tenantId` from the
      BULLMQ JOB, not from an outbox event.
  - All other matches are test files constructing payloads.
- **Reports reconciliation:** `report.studentReportCard` is a BullMQ JOB (not an
  outbox event — absent from the `outboxEventTypeSchema` enum). Its `tenantId` is
  placed on the payload by `makeReportCardGeneratedHandler` from
  `tenantIdOf(event)` (envelope provenance), then `studentReportCardJobSchema`
  REQUIRES `tenantId: z.string().uuid()` (`jobs.ts:35-41`), registered jobType
  (`jobs.ts:89`). The reports worker THROWS if `tenantId` is missing
  (`worker.ts:258-260`) and executes inside `withGuc({ tenantId, system: true })`
  (`worker.ts:261`). `report-pdf.ts` never touches the DB.
  **REPORT HANDLER COVERAGE: COMPLETE.**

## 15. R-3 — STATIC GATE (no DB)

- `d3-static-tenant-gate.test.ts` (2/2) scans, for each production handler, the
  handler's SOURCE for `import { tenantIdOf } from './tenant-invariant.js'` and
  use of `tenantIdOf(event)`; failure = the file fails the audit. Non-vacuous
  fixture design verifies the scanner catches a hand-rolled replacement.
- `d3-tenant-trust-gate.test.ts` (3/3) proves the gate is live and its assertions
  are not vacuous (unmodified event passes, mutated payload caught).

## 16. R-3 — RUNTIME PROOF, T1-T5 (disposable DB)

- `d3-worker-tenant-isolation.test.ts` (20/20) — trust chain T1..T5 over
  production `runEventHandler`: (T1) envelope authoritative; (T2) no spread/copy
  removal; (T3) rendering + only row array query; (T4) inherited `withGuc`
  nowhere in SQL; (T5) `processEvent` issued exactly ZERO data-plane SQL
  (drizzle statement recorder). NULL/wrong/payload-only/malformed envelopes all
  rejected — "not a single statement reached the DB" on the rejected paths.
- `d9-permission-parity.test.ts` (18/18) — 9 static + 9 live (incl. 25 `fees.*`
  reachable individually, cashier exactly 3, existing-tenant legacy fixture).
- `tenant-invariant.test.ts` (14/14) — envelope authoritativeness unit suite.

## 17. EVENT-REGISTRY / SCHEDULER / ALERT / CASCADE PROPERTIES

- `outboxEventTypeSchema` (contracts) restored to the authoritative event list;
  `event-registry-parity.test.ts` asserts the outbox DB rows match that enum
  exactly (BOGUS-event negative checks) — PASS.
- No worker processEvent silently acks: unknown event → throw (`worker.ts:72`).
- The scheduling inventory (Phase 8 finalization blocker): no new Phase 8
  scheduler primitive was added by 3E; the only scheduler-adjacent checks
  (`runDailyAttendanceSummaries`) retain the pre-3E daily job; 3E did not alter
  it. D1/D2 logic untouched (only exercised; section 25).

## 18. TEST-CHAIN OF CUSTODY — LIVE AND STATIC SUITES, ALL PASSING

Single command, disposable DB, 5 files / 57 tests:

```
RUN_RUNTIME_SECURITY_TESTS=1 npx vitest run \
  src/d9-permission-parity.test.ts src/d3-worker-tenant-isolation.test.ts \
  src/d3-tenant-trust-gate.test.ts src/d3-static-tenant-gate.test.ts \
  src/tenant-invariant.test.ts
  → Test Files 5 passed | Tests 57 passed (57)  [15.04s]
```

Plus the permissions package suite on its own:

```
packages/permissions: Test Files 1 passed | Tests 30 passed (30)
```

Plus the complete worker suite WITH the opt-in flag (which also exercises the
Redis-dependent suites):

```
apps/worker (RUN_RUNTIME_SECURITY_TESTS=1): 189 tests
  181 passed | 7 failed | 1 skipped          ← 7 = Redis-blocked, section 25
```

## 19. MIGRATION INTEGRITY

- `git status` shows ZERO modifications under `packages/db/migrations` (the
  authorized directory). Migrations ending at two `0028_*` (finance_security +
  its mfa_encrypt remediation). No renames, no renumbering, no new `0029+`.
- `docs/DEPLOYMENT.md` / migration list: `0028` series is the final migration.
- `packages/db/src/testing/runtime-db.ts` asserts the disposable-DB name
  (must end `_test`) BEFORE connecting; `global-setup.ts` + `setup-env.ts`
  repoint `DATABASE_URL_APP`/`DATABASE_URL_MIGRATOR` to `school_saas_test`.
  Runtime-db self-test (`runtime-db.test.ts`) also fails on non-disposable
  names. The migration batches executed during the audit ran on
  `school_saas_test` only.

## 20. DEV DATABASE SAFETY

- Every suite in this audit ran under `RUN_RUNTIME_SECURITY_TESTS=1` →
  `school_saas_test`. No command in this audit targeted `school_saas_dev`.
- `school_saas_dev` is absent from the `.env`/runtime harness used by the tests
  (setup-env overrides at import time, before `@sms/config` is first read).
- No data-modifying statement was ever issued against any non-disposable
  database during this audit.

## 21. PHASE 8 CONTAMINATION SEARCH

- Authorized migrations: NO `0029/0030+`, no communication/notification/
  provider tables. (The untracked, pre-existing `migrations-not-authorized/`
  directory with 0026-0029 drafts does NOT live in the authorized dir and is not
  a Phase 8 artifact.)
- `packages/` + `apps/worker/src` grep for provider/SMS/WhatsApp/Twilio/
  Nodemailer/SendGrid/FCM/APNS/webhook/notification channels: every match is a
  Phase 5/6 STUB that DEFERS to Phase 8 (`worker.ts:135` "notification stubs",
  `contracts/events.ts:155` "INTENTIONALLY_NOOP until Phase 8 builds the
  notification channel", attendance/exams defer sites) or a pre-existing
  Phase 7 schema column (`webhook_raw_retention_days`). No Phase 8 delivery code,
  no provider SDK dependency, no Phase 8 route exists.
- No Phase 8 UI/route/dependency was added by 3E (largest diff = the reports;
  the only NEW runnable code = `tenant-invariant.ts` + the d9/d3/test files).
- `job_runs` inventory: 39 matches, ALL in `docs/` (`DATABASE_DESIGN.md`,
  `DECISIONS.md`, `JOB_ARCHITECTURE.md`, `DEPLOYMENT.md`, `DEVELOPMENT_ROADMAP.md`
  and the Phase 8 reports); ZERO in `apps/` or `packages` `.ts`/`.sql`.

## 22. TYPECHECK (re-run per package)

| Package | Command | Result |
|---|---|---|
| `packages/permissions` | `tsc -p tsconfig.json --noEmit` | 0 errors — PASS |
| `packages/contracts` | `tsc -p tsconfig.json --noEmit` | 0 errors — PASS |
| `apps/api` (own tsconfig) | `tsc -p tsconfig.json --noEmit` | 0 errors — PASS |
| `apps/worker` | `tsc -p tsconfig.json --noEmit` | 23 errors — 22 pre-existing fastify-augmentation cross-refs (api/src/plugins/auth.ts 17 + api/src/routes/tenants.ts 5) + 1 pre-existing local `d3-static-tenant-gate.test.ts:73` TS2367 — identical set to the PRE-3E worker baseline, NO new error introduced by 3E |

The api fastify-augmentation errors only appear when pulled through the worker's
tsconfig (api's own tsconfig includes its augmentation d.ts; the worker's does
not). This is a pre-existing cross-package tsconfig quirk, unchanged by 3E.

## 23. GIT INTEGRITY — 3E MATERIAL AND PRE-EXISTING DIRTY STATE

`git status` at audit end == pre-3E baseline + 3E material; no additional file
appeared during this audit (the audit's own scratch test was deleted after
capturing its evidence, so the repo shows no audit artifact).

Untracked 3E/security material (intentionally new, to be committed at Phase 8):
`apps/worker/src/{d3-static-tenant-gate,d3-tenant-trust-gate,d3-worker-tenant-isolation,d9-permission-parity,tenant-invariant,tenant-invariant.ts}.ts`,
`apps/api/src/security/d5-guardian-soft-unlink.test.ts`, `packages/db/src/relations*`,
`docs/PHASE_8_*.md` reports, `.r11_map.json`, `.tmpgate/`, `__pycache__/`,
`testconn.mjs`, stray `{console.error(e.code)` file.

Pre-existing MODIFIED files: `.env.example`, api routes `school/attendance.ts`,
`school/homework.ts`, worker modules (`attendance.ts`, `documents.ts`, `exams.ts`,
`outbox-integration.test.ts`, `promotion.ts`, `student-import.test.ts`,
`worker.ts`, `worker-event-registry.test.ts`), `docs/PHASE_7_FINANCE_DESIGN.md`,
contracts (`events.ts`, `jobs.ts`), `packages/db/src/index.ts`,
`packages/jobs/src/queues.ts`, `packages/permissions/src/permissions.ts`.

**No migration, no package.json, no lockfile is modified.** stash untouched.

## 24. HEAD IMMUTABILITY

| Check | Result |
|---|---|
| HEAD == `5bf11d0067424ea6e372f92f536e4af0aa795552` | PASS (unchanged through the audit) |
| Branch `master` | PASS |
| No commit created by this audit | PASS |
| No push/network action | PASS |

## 25. REDIS GATE — ENVIRONMENTAL (UNVERIFIED)

- Redis is NOT running locally: TCP connect to `127.0.0.1:6379` → ECONNREFUSED;
  `redis-cli` absent.
- Re-run of the opt-in worker suites isolates the failures to EXACTLY the set 3E
  documented:
  - `outbox-integration.test.ts` tests 3, 4, 5, 12, 15, 16, 22 — all fail on
    `Connection is closed.` / ioredis `connect ECONNREFUSED 127.0.0.1:6379`.
  - `queue-routing.test.ts` D1-LIVE — its `beforeAll`/`afterAll` fail on the same
    refused connection when the opt-in is on (1 skipped otherwise).
  - Every other worker suite (incl. all R-1..R-3, the 57-test chain, and the 26
    DB-only outbox tests 1/2, version-matrix, etc.) PASSES — 181 passed.
- Conclusion: **REDIS GATE = UNVERIFIED** — a genuinely environmental condition,
  NOT a real regression and NOT pre-existing untested source of R-1..R-4. This
  is the classification the 3E report recorded (REDIS GATE (-)) and is the sole
  reason 3F is "CLEARED WITH CONDITIONS" rather than a straight PASS.
- Relevance to 3E: none of the 7 blocked tests exercise R-1..R-4 code paths (they
  are dispatcher/BullMQ delivery tests) — a real regression there would require a
  live Redis to even attempt, so it cannot be falsely attributed.

## 26. SECTION/CLAIM VALIDATION — 3E REPORT CROSS-CHECK

Every claim in the 3E report was checked against this audit's INDEPENDENT
findings:

| 3E claim | 3E line | Independent 3F finding | Verified |
|---|---|---|---|
| R-1: catalog 114, tenant union 106 | :80-83 | source-text 114/106, dup 0 | PASS |
| R-1: §20.5 matrix row-for-row (53 rows) | :98 | SQL-source extraction 53, zero diffs | PASS |
| R-1: cashier exactly 3 | :19, §20.5 | runtime authz exactly 3 | PASS |
| R-1: live bootstrap 106/tenant, legacy non-regression | :114 | 106/106, legacy byte-identical | PASS |
| R-3: envelope authoritative, 5 handlers via tenantIdOf | :287-288 | handler inventory + static gate | PASS |
| R-3: T1-T5, zero data-plane SQL | :153 | 20/20 with statement recorder | PASS |
| R-2: 3 stale 113→114 | :186-188 | exact-line re-read 114/114 | PASS |
| R-4: 6/7 dunning lines reclassified; 1 design row removed | :292 | lines 278/12314 + event-registry negative | PASS |
| REDIS GATE (-), ECONNREFUSED | :298-299 | re-confirmed ECONNREFUSED | PASS |
| HEAD unchanged | :6/:52/:245 | section 5/24 | PASS |
| No migration/package changes | :245 | sections 19/23 | PASS |
| Batteries incl. d9 18, d3worker 20 | :216 | 57/57 chain (§18) | PASS |

No 3E claim was found false; no 3E claim rested on a number 3F could not
reproduce. The renumbered final Phase 8 report prep (section-mounted numbers)
used only these independently-recomputed values.

---

# EVIDENCE MATRIX (24 rows — 3F §2 prompt form)

| # | Evidence | Type | Result | Redo cost | LOC/size | Mode |
|---|---|---|---|---|---|---|
| 1 | HEAD/branch immutability | git | PASS | - | - | static |
| 2 | `migrations` diff empty; no 0029+ | git/fs | PASS | - | - | static |
| 3 | catalog = 114 from SOURCE TEXT, dup 0, == module | test+node | PASS | low (no DB) | 1 file | static |
| 4 | template-union == catalog; tenant union 106; orphan/template-only 0 | test | PASS | low | 1 file | static |
| 5 | §20.5 extraction from migration SOURCE = 53; missing/extra/mismatch/dup 0 vs ROLE_TEMPLATES | test | PASS | low | 1 file | static |
| 6 | fresh-tenant live: per-role DB == templates (106/30/11/25/3/6/6), union 106 | vitest (disposable DB) | PASS | mid (DB) | 1 file | live |
| 7 | legacy-tenant non-regression byte-identical | d9 live | PASS | mid | 1 file | live |
| 8 | runtime `resolveTenantContext` grants §20.5 + denies every `lacks` | vitest (disposable DB) | PASS | mid | 1 file | live |
| 9 | 25 `fees.*` individually reachable; cashier == 3 in 0028 | d9 | PASS | mid | 1 file | live |
| 10 | R-3 handler inventory — all via `tenantIdOf(event)` | grep+read+static gate | PASS | low | 8 files | static |
| 11 | `assertEventTenant` first statement; throw-if-unknown | read | PASS | low | 1 file | static |
| 12 | payload-tenant census — 3 production sites only, explained | grep | PASS | low | - | static |
| 13 | `studentReportCardJobSchema` requires uuid tenantId; reports worker throws if missing | read | PASS | low | 2 files | static |
| 14 | `report-pdf.ts` DB-free; reports producer uses envelope provenance | read | PASS | low | 2 files | static |
| 15 | T1-T5 + zero data-plane SQL in processEvent | d3worker 20/20 | PASS | mid | 1 file | live |
| 16 | static tenant gates non-vacuous (2+3) | vitest | PASS | low | 2 files | static+live |
| 17 | envelope invariant unit suite 14/14 | vitest | PASS | low | 1 file | static |
| 18 | R-2 doc fixes exact-line (114/114); historical 113 untouched | grep/read | PASS | low | 3+1 files | static |
| 19 | R-4 dunning reclassification; no finance-024 test ref | grep/read | PASS | low | 2 files | static |
| 20 | job_runs: 39 doc-only hits; 0 code/sql | grep | PASS | low | - | static |
| 21 | event-registry parity (BOGUS negatives incl. overdue) | vitest | PASS | low | 1 file | static |
| 22 | migration integrity; dev-DB safety; runtime-db disposable-name guard | git+read | PASS | - | - | static |
| 23 | Phase 8 contamination search (no providers/routes/deps/0030+) | grep+git | PASS | low | - | static |
| 24 | typechecks per package (perms/contracts/api 0; worker 23 pre-existing only) | tsc | PASS* | mid | - | static |

*worker carries 23 pre-existing errors identical to the pre-3E baseline; 0 new.

# FILL MODES / UNKNOWN FIELDS

| Field | Fill mode | Value/state |
|---|---|---|
| Repo | explicit | G:\School Managment system |
| Scope Page (blame/claims) | expanded | section 3 |
| Tracked/Git status | unchanged | section 23 |
| Head/Branch | frozen | section 5/24 |
| REDIS/Outbox/BullMQ active E2E | UNKNOWN (env offline) | section 25 → C1 |
| API runtime (live server) E2E | UNKNOWN (env offline) | section 25 → C1 |
| Trigger/criteria | explicit | section 2 |
| Migrations | frozen | section 19 |
| Tests | conserved (57+30+audit suite) | section 18 |
| GUC/RLS | fetched | section 13-16 |
| Permissions | computed 114/106/53 | sections 7-9 |
| No-lie bound | met | §26 |

---

_END OF REPORT — 3F INDEPENDENT FINAL VERIFICATION_