# Phase 8 — Final D3/D9 Security Proof Report

> Prompt 3D artefact. Proof-of-isolation + proof-of-parity, not implementation.
> No migrations, no dependencies and no code changes were made to any production
> file; the only new files are this report and the proof test-suites it cites.
> The working tree remains byte-identical (for every pre-existing file) to the
> baseline `HEAD 5bf11d0067424ea6e372f92f536e4af0aa795552` (see §36-37).

---

## Table of contents

1. Scope, constraints and how to reproduce every claim
2. Baseline snapshot (HEAD, working-tree classification)
3. Worker architecture: role, RLS posture and the data-based isolation boundary
4. Inventory — schedule/report/outbox worker data-plane handlers
5. Inventory — every worker DB statement, tenant-scope classification
6. Documented tenant-scope exceptions (reviewed allowance list)
7. D3 verdict — cross-tenant isolation (READ)
8. D3 verdict — cross-tenant isolation (UPDATE)
9. D3 verdict — cross-tenant isolation (DELETE)
10. D3 verdict — cross-tenant isolation (UPSERT / artifact writes)
11. D3 verdict — context & validation failures fail closed
12. D3 verdict — runtime suite summary (15/15)
13. Static source gate — every worker DB statement is tenant-scoped or a reviewed allowance
14. D6 — exact content-plane tenant resolution (tenantIdOf / envelope/payload mapping)
15. D6 — deferred job payloads and per-handler enrichment
16. D6 — content-plane invalidation sweep (no un-keyed tenant reads)
17. B1 — no unconstrained reads in the worker data plane
18. B1 — log/secret scrub (no DSN, password, token or API-key leakage)
19. DEL-2 — delete inventory (exactly the sanctioned tenant-scoped DELETE)
20. D9 — permission catalog set algebra (static, no DB)
21. D9 — migration-declared permission set
22. D9 — live database parity via the PRODUCTION bootstrap path
23. D9 — per-role equality, cross-tenant determinism
24. D9 — the exact parity gap: 25 fees.* + cashier on NEW tenants
25. D6/B1/DEL-2/D9 — cross-cutting conclusions
26. Evidence integrity — migrations, dependencies, working tree
27. How to run every proof
28. Blockers encountered (STOP rule) and why they are not fixed here
29. Final verdict

---

## 1. Scope, constraints and how to reproduce every claim

This report is the Prompt 3D **final D3/D9 security proof extraction**. It proves,
with executable tests, two things:

* **D3 — worker cross-tenant isolation.** Every worker data-plane handler is
  tenant-scoped on the *data* (a tenant id predicate on every read/write), with
  the boundary proven at runtime against a live disposable database and guarded
  at source-scanning time against regression.
* **D9 — permission parity.** The TypeScript permission catalog, the role
  templates, the migration-declared permission set and the live database seeded
  by the *production* tenant-bootstrap transaction are compared **exactly** in
  both directions.

Constraints honoured:

* No new/modified migrations. Migration roster is unchanged: **34 files**,
  `0001`…`0028` (including two `0025_*` and two `0028_*` variants), and the
  runtime harness reports `already current: 34` (migrations applied: 0).
* No dependency changes (`package.json` / `pnpm-lock.yaml` / `pnpm-workspace.yaml`
  untouched). No commits, pushes or tags.
* The real production database **school_saas_dev is never touched**. Runtime
  proofs run against the **disposable `school_saas_test`** database that the
  vitest global setup creates, migrates and re-points `DATABASE_URL_*` to when
  `RUN_RUNTIME_SECURITY_TESTS=1` is set.
* No production behaviour was changed to make a proof pass (STOP rule, §28).

Reproduce everything with:

```
# static suites (no database required)
pnpm --filter @sms/worker exec vitest run src/d3-static-tenant-gate.test.ts
pnpm --filter @sms/worker exec vitest run src/d9-permission-parity.test.ts   # static part

# runtime suites (require .env; disposable school_saas_test; flag is the opt-in)
RUN_RUNTIME_SECURITY_TESTS=1 pnpm --filter @sms/worker exec vitest run src/d3-worker-tenant-isolation.test.ts
RUN_RUNTIME_SECURITY_TESTS=1 pnpm --filter @sms/worker exec vitest run src/d9-permission-parity.test.ts
```

Combined security-proof run (the command used for this report):

```
RUN_RUNTIME_SECURITY_TESTS=1 pnpm --filter @sms/worker exec vitest run \
  src/d3-worker-tenant-isolation.test.ts src/d3-static-tenant-gate.test.ts src/d9-permission-parity.test.ts
```

Result: **3 files, 29 tests, 29 passed.** The disposable database is left empty
(0 tenants) after each run.

## 2. Baseline snapshot

* Repository root: `G:\School Managment system` (git, branch `master`).
* Baseline commit verified before any Prompt 3D work:
  `5bf11d0067424ea6e372f92f536e4af0aa795552`.
* The working tree already contained changes (from earlier phases) that are
  **not** Prompt 3D artefacts and are **not** modified by this work:
  modified `.env.example`, `apps/api/src/routes/school/{attendance,homework}.ts`,
  `apps/worker/src/{attendance,exams,outbox-integration.test,worker-event-registry.test,worker}.ts`,
  `packages/contracts/src/{events,jobs}.ts`, `packages/db/src/index.ts`,
  `packages/jobs/src/queues.ts`, `packages/permissions/src/permissions.ts`;
  untracked (prior-phase) `.r11_map.json`, `.tmpgate/`, `__pycache__/`,
  `apps/api/src/security/d5-guardian-soft-unlink.test.ts`,
  `packages/db/migrations-not-authorized/`, `packages/db/src/{relations.ts,relations-canonicality.test.ts}`,
  `packages/db/{console.error(e.code),testconn.mjs}`,
  worker test/tenant-invariant files from prior phases, and four prior
  `docs/PHASE_8_*.md` reports.
* **New artefacts from this phase (and only these):**
  * `apps/worker/src/d3-worker-tenant-isolation.test.ts` (runtime, 15 tests)
  * `apps/worker/src/d3-static-tenant-gate.test.ts` (static, 2 tests)
  * `apps/worker/src/d9-permission-parity.test.ts` (static + live, 12 tests)
  * `docs/PHASE_8_FINAL_D3_D9_SECURITY_PROOF_REPORT.md` (this report)
* `git status` after the work confirms the migration directory, every
  `package.json`, `pnpm-lock.yaml` and `.env` file are unchanged. §26.

## 3. Worker architecture: role, RLS posture and the data-based boundary

Facts established this phase (and used as the isolation model):

* The worker connects with the **trusted executor** DSN (`DATABASE_URL_MIGRATOR`,
  `school_migrator` role) and runs every handler under
  `withGuc(db, { tenantId: event.tenantId, userId: actor, system: true }, …)`
  (`apps/worker/src/worker.ts:69`). The `system: true` context emits
  `set_config('app.rls', '', true)` (`packages/db/src/client.ts:38-44`), i.e.
  RLS is **bypassed**. **RLS is therefore not the isolation boundary.**
* Isolation is **data-based**: every worker statement carries an explicit
  tenant predicate (or is a documented, reviewed exception — §6). This is
  proven *at runtime* (D3) and *at the source level* (gate).
* Tenant resolution inside a handler is
  `payload.tenantId ?? event.tenantId` (`tenantIdOf`, `attendance.ts:28`,
  `exams.ts:37`; fallback in `worker.ts:254`). Every API-side emitter sets
  *both* equal to `ctx.tenantId`, so the two should never diverge in practice;
  the override behaviour is documented and probed in §12.
* A concrete, non-empty `event.tenantId` is validated before any handler runs
  (`assertEventTenant`, `tenant-invariant.ts:9`); enforcement is additionally
  verified live (§11).

"Property A" (a handler for tenant X never touches tenant Y's rows) is proven
by three independent layers: (1) statement-level static scan and allowance gate,
(2) runtime isolation tests with real tenants, rows and storage, (3) the
tenancy-invariant `event.tenantId` guard. Together they establish "no generic
unscoped tenant-table read anywhere in the worker."

## 4. Inventory — scheduler/report/outbox worker data-plane handlers

Handlers driving the data plane, and the point where `tenantIdOf` is resolved:

| Module | Handler / flow | Resolves tenant at | Write surface |
|---|---|---|---|
| `attendance.ts` | `attendance.marked` (late-list read) | `:56` | none (read) |
| `attendance.ts` | daily summary scheduler jobs | `:134` | `audit_logs` (one row per tenant+date), outbox (mail) |
| `promotion.ts` | `promotion.batch.execute` | reads batch by batchId then scopes all writes by that batch's tenant | `promotion_items`, `enrollments`, `promotion_batches` |
| `exams.ts` | `exam.result.compute` (report-card minting + recompute) | `:271` / `:514` | `report_cards`, `report_card_subjects` (incl. the delete-recompute path) |
| `exams.ts` | `report.studentReportCard` (artifact) | `:546` | `files`, `report_cards`, storage object |
| `documents.ts` | `student.document.uploaded` (scan hook) | event payload | `files` |
| `student-import.ts` | `student.import.completed` | event payload | `student_import_rows(104)`, `students`, `student_guardians`, `guardians`, `student_imports`, `audit` |
| `report-pdf.ts` | PDF renderer (pure, no DB) | — | — |

## 5. Inventory — every worker DB statement, tenant-scope classification

The static gate scans `promotion.ts`, `attendance.ts`, `documents.ts`, `exams.ts`,
`student-import.ts`, `tenant-invariant.ts`, `worker.ts`, `report-pdf.ts` and
extracts every drizzle builder statement (`select/selectDistinct/insert/update/delete`
with `.execute(`/`.returning(`/`;` terminals) **and** every raw `tx.execute(sql\`…\`)`.

**Result: 50 statements (45 builder + 5 raw).** Classification:

* **40 scoped** — the statement or its `.where(...)` carries an explicit
  `tenant_id`/`tenantId` equality predicate (or an insert value carries
  `tenantId`). This set includes every read of a tenant business table.
* **10 documented, reviewed allowances** — no tenant predicate by deliberate
  design; each is itemised in §6 with its security justification, and every one
  is either (a) keyed on a *globally unique* primary key after a tenant-scoped
  owning-row read, or (b) a scheduled, deliberately cross-tenant system read,
  or (c) a raw function call whose **first bound argument is the tenant id**
  (scoping by argument, not by predicate column).

Per-module scan summary (file : count):

| Module | Builder | Raw | Scoped | Unscoped (allowance) |
|---|---|---|---|---|
| `promotion.ts` | 11 | 0 | 5 | 6 (status-transition UPDATEs keyed by global ids) |
| `attendance.ts` | 3 | 4 | 5 | 2 (system scheduler reads) |
| `documents.ts` | 3 | 0 | 3 | 0 |
| `exams.ts` | 16 | 1 | 16 | 1 (`fn_report_card_totals(tenant_id :: uuid, …)` — argument-scoped) |
| `student-import.ts` | 12 | 0 | 11 | 1 (row read by global `importId`) |
| `tenant-invariant.ts`, `worker.ts`, `report-pdf.ts` | 0 | 0 | 0 | 0 (no DB statements) |

The exact inventoried statement list with line numbers is reproduced by the
gate test itself (see `scan` in `d3-static-tenant-gate.test.ts`); the harness
that produced the numbers for this report is `dbg-full.mts` (temp, not committed).

## 6. Documented tenant-scope exceptions (reviewed allowance list)

The gate requires **any** statement without a tenant predicate to match an
explicit allowance key `file:op:table`, else it fails. The reviewed list:

| Allowance | Why it is safe | Runtime proof |
|---|---|---|
| `promotion.ts:update:promotionItems` | Status transition keyed by globally-unique `promotion_items.id`; only reached after a tenant-scoped read of the owning batch (`promotion.ts:61`). **Defence-in-depth gap (documented):** the UPDATE itself carries no tenant predicate; the runtime negative test proves it mutates nothing cross-tenant because the owning-batch read fails first. | U1 (§8) |
| `promotion.ts:update:promotionBatches` | Same reasoning; keyed by global `promotion_batches.id`. | U1 (§8) |
| `student-import.ts:select:studentImportRows` | Row read keyed by a globally-unique `student_imports.id` (import uuid); imported rows' tenant is fixed at insert with `tenantId` (`student-import.ts:104`). | — |
| `attendance.ts:raw:(raw sql)` | Daily-summary scheduler is deliberately cross-tenant (enumerates all *active* tenants and emits one `audit_logs` row per `(tenant,date)`); its `current_date` read is system level. This is the single intended cross-tenant read. | — |
| `exams.ts:raw:(raw sql)` | `fn_report_card_totals(tenant::uuid, report_card_id)` — tenant is the **first bound parameter**; scoping by argument rather than a predicate column. | D1 negative (§9) |

Anything else unscoped **fails the gate by construction** (the gate is proven
non-vacuous — its fixture test fails unless the unsafe module is detected).

## 7. D3 — READ isolation verdict (runtime)

Suite: `d3-worker-tenant-isolation.test.ts` → describe `R1 READ
(attendance.marked)` (`attendance.ts` late-list read). Two real tenants A and B
are seeded with tenants, users, memberships, campuses, years, terms, grade
levels, subjects, classes, sections, `class_subjects`, students, enrollments,
gardians, exam types/exams/exam_subjects/marks, **`attendance_days`** and a
`promotion_batch`; each handler runs through `runEventHandler` / `processEvent`.

* R1-A same-tenant control (A event on A's date) → resolves A guardians.
* R1-B same-tenant control (B event on B's date) → resolves B guardians.
* RH-01 negative (A event on the date only B marked) →
  **deferred mail = 0**, zero B rows returned, and the drizzle logger proves the
  captured `attendance_days` read binds A's `tenant_id` and never B's.

**Verdict: PASS.** A READ for tenant X resolves only X's rows.

## 8. D3 — UPDATE isolation verdict (runtime)

Suite, describe `U1 UPDATE (promotion.batch.execute)`.

* U1-A control (A batch): the A event completes the A `promotion_batch`,
  flips its items and **creates the A enrollment row**.
* U1-B negative (A event targeting the **B** batch): `runEventHandler` yields
  zero deferred jobs, `promotion_batches`/`promotion_items`/`enrollments` are
  byte-identical after, and **no UPDATE/INSERT statement is otherwise emitted**
  (statement-level `logQuery` capture: the only qualifying writes on a foreign
  batch are absent). The cross-tenant batch id is rejected at the tenant-scoped
  owning-read (`promotion.ts:61`), so the allowlisted global-id UPDATEs are
  unreachable from another tenant's event.

**Verdict: PASS.** No UPDATE or INSERT can be aimed at another tenant's batch.

## 9. D3 — DELETE isolation verdict (runtime)

Suite, describe `D1 DELETE (exam.result.compute)` — the **only** DELETE in the
worker data plane (`exams.ts:402`, `delete from "report_card_subjects"`).

* D1-A owner controls: an owner for **B** computes and mints B draft cards; an
  owner for **A** mints A draft cards (cards exist for both tenants).
* D1-B negative (A event on the **B** exam): B's report cards are
  byte-identical after, drafter/artifact rows for B unchanged, and **no
  `delete from "report_card_subjects"` statement is issued** for another
  tenant's cards (log capture returns no DELETE at all).
* D1-C same-tenant recompute control: recomputing A's own exam **does** fire
  the DELETE path — the sentinel line is removed (proving the negative test
  wasn't vacuous).

**Verdict: PASS.** The only DELETE in the worker is tenant-scoped and cannot
target another tenant's report cards.

## 10. D3 — UPSERT / artifact-isolation verdict (runtime)

Suite, describe `S1 UPSERT (report.studentReportCard)` — artifact writing to
`files` + stamping `report_cards` + storage side-effect.

* S1-A control (A's card id): inserts the A `files` row and stamps A's card,
  storage object written.
* S1-B negative (A event on **B's** card id): returns `missing`, **no `files`
  row written**, no stamp.
* S1 storage-key conflict (a B-owned `storage_key` collides): the job **fails
  closed** (throws or converges), B's `files` row is byte-identical, no A row,
  card unstamped — a tenant can never adopt/overwrite another tenant's artifact
  key.

**Verdict: PASS.** Artifact UPSERTs honour the data boundary, and the key
namespace is collision-safe across tenants.

## 11. D3 — context & validation fail-closed verdict (runtime)

Suite, describe `X context-failure` + envelope validation.

* A `null`/missing `event.tenantId` is rejected by `assertEventTenant`
  **before any handler runs**.
* Whitespace, empty and garbage `tenantId` strings are rejected at outbox
  envelope validation (`processEvent`) and never silently processed.

**Verdict: PASS.** No handler ever executes without a concrete tenant id.

Additional documented behaviour (not a failure): the TRUST-CHAIN probe shows a
crafted mismatch where `payload.tenantId` differs from `event.tenantId` — a
handler routes on `payload.tenantId` (the payload overrides the envelope).
All API emitters set both equal to `ctx.tenantId`, so this cannot occur in the
production path; it is nonetheless recorded as a defence-in-depth note for the
implementation audit.

## 12. D3 verdict — runtime suite summary (15/15)

`apps/worker/src/d3-worker-tenant-isolation.test.ts` — **15/15 PASS**:

R1 attestation (3) · U1 (2) · D1 (4) · S1 (3) · X-context (2) · TRUST-CHAIN probe (1).

Run against the disposable `school_saas_test`; `afterAll` removes both tenants
(in FK order, after disabling the write-guard triggers), leaving the database
empty. **Overall D3 verdict: PASS.**

## 13. Static source gate — PASS

`apps/worker/src/d3-static-tenant-gate.test.ts` (no DB) proves:

* The gate is **not vacuous**: a temporary module (`__d3_unsafe_fixture__.ts`)
  containing a tenant-unscoped `SELECT enrollments` and `UPDATE students` is
  flagged (and the fixture is deleted afterwards — asserted).
* **Production sources have exactly zero unexpected unscoped statements**:
  every extracted statement is either tenant-scoped or on the §6 allowance list.
* Sanity: `promotion.ts` unscoped status-transition UPDATEs are present in the
  scan (i.e. the allowance list is real, not dead).

**Verdict: PASS** (gate failure would have been reported, not fixed).

## 14. D6 — exact content-plane tenant resolution

* `tenantIdOf(event) = payload['tenantId'] ?? event.tenantId` is the **only**
  tenant derivation in the data plane (`attendance.ts:28`, `exams.ts:37`;
  `worker.ts:254` for deferred-job payloads). No handler reads a tenant id from
  a parsed request/body or a header; there is no API-facing content surface in
  the worker.
* The envelope `event.tenantId` is validated concrete/non-empty *before* any
  handler (`assertEventTenant`), so the fallback branch (`payload` absent) can
  never run with a missing tenant.
* Root cause analysis: every API-side emit sets `payload.tenantId` **and**
  `event.tenantId` from the same `ctx.tenantId`, so overrides never occur in
  production. The override behaviour itself is captured by the TRUST-CHAIN
  probe (documented, not a violation).

**Verdict: PASS** (content-plane derivation is single-path, validated, and
probed).

## 15. D6 — deferred job payloads and per-handler enrichment

* Handler-to-job hand-off is exhaustive-inventory + parity-tested:
  `event-registry-parity.test.ts` and prior `worker-event-registry.test.ts`
  keep the worker registry and the events/jobs contracts in lock-step.
* Deferred jobs always carry `tenantId` in the payload; the report-card job
  schema (`studentReportCardJobSchema`) requires `{ reportCardId, tenantId, idempotencyKey, correlationId }`, and the identity-transit is asserted in the
  runtime suite (the worker enqueues `report.studentReportCard` with the same
  tenant that owns the artifact).
* `queue-routing.test.ts` keeps queue-route assignments deterministic.

**Verdict: PASS.**

## 16. D6 — content-plane invalidation sweep

No worker handler ingests user-controlled content and then resolves a tenant
from it: no `req`/body/header parsing exists in the worker data plane
(handlers receive the validated `event.payload`). The only "content" inputs are
storage keys / ids that are then **scoped by the event's tenant id**. The
invalidation sweep therefore finds no alternative tenant-derivation path.

**Verdict: PASS.**

## 17. B1 — no unconstrained reads in the worker data plane

Established at three levels:

* **Runtime (R1)**: the only foreign-tenant read probe (A event on B's date)
  returns zero rows and binds only A's tenant id.
* **Static gate (§13)**: every statement is scoped or allowance-listed; any new
  unkeyed read fails CI.
* **Hand-verified special cases** (§6): the promotion UPDATE allowance is *only
  reached* after a tenant-scoped owning-batch read; `studentImportRows` is
  keyed by a globally-unique `importId`; the scheduler read is system-level by
  design.

**Verdict: PASS.**

## 18. B1 — log/secret scrub

* The worker's logger (`worker.ts:353`) prints a `Logger` `data` object; event
  payloads are pre-sanitised by `enqueueOutbox` (`NEVER_STORE` =
  `password/passwordHash/token/secret/apiKey/authorization`), and the worker
  logs ids/statuses, never credentials.
* No worker source accesses `process.env` outside `worker.ts`'s `getEnv()` at
  boot; nothing logs DSNs, passwords or tokens (a sweep over
  `worker|promotion|attendance|documents|exams|student-import|report-pdf|tenant-invariant.ts`
  for `password|token|secret|apiKey|process.env` returns no logging sites).
* The `.env` file is **not** committed; test harnesses consume
  `DATABASE_URL_*` from the process/global setup only.

**Verdict: PASS.**

## 19. DEL-2 — delete inventory

A repository-wide scan of `.delete(` in the worker finds exactly **one**
production-site DELETE: `exams.ts:402` (`report_card_subjects` in the compute
recompose path). All other `.delete(` occurrences are inside test fixtures
(cleanup). The single production DELETE is tenant-scoped (proved live in §9) and
is the only authorised delete in the worker data plane. The privileged-only
DELETE RLS policies that already exist in the database cover API/admin cleanup;
no additional worker deletes are required.

**Verdict: PASS.**

## 20. D9 — permission catalog set algebra (static)

`packages/permissions/src/permissions.ts` `PERMISSION_CATALOG`:

* Catalog = **114** unique permissions (duplicate-checked).
* ROLE_TEMPLATES union = **89** = **81 tenant** (school_owner/principal/teacher/accountant/parent/student) + **8 platform**; namespaces never mix (asserted).
* Catalog-only (in **no** template) = **exactly 25**, all `fees.*`:
  `CATALOG_ONLY_FEES` in the D9 test (structures 2, assignments 2, invoices 4,
  payments 3, adjustments 3, receipts 2, reconciliation 2, ledger 1, reports 1,
  portal 1, refunds 5).
* Template-only drift = **0** (every template permission exists in the catalog).

**Verdict: PASS** (exact set arithmetic proven by test).

## 21. D9 — migration-declared permission set

Parsing every migration file (`packages/db/migrations/*.sql`, 34 files) for
permission literals `'a.b'`…`'a.b.c'`:

* Migration-declared **catalog** permissions = **77** — all valid (none outside
  the catalog).
* 52 of those 77 are also in a template; the other **25 are exactly the
  `fees.*`** set — migration-declared but **never placed in any template**.
* Template-union ∪ migration-declared = **114 = the catalog, exactly** — so the
  catalog has zero permissions that exist in neither layer.

The migration structure is summarised as: `role_permissions(role_id, permission)`
with a `(role_id, permission)` unique key; permissions for pre-existing tenants
are appended per phase (0005/0007/0008/0009/0011/0014/0015), and `0028`
introduces the `cashier` role + the 25 `fees.*` **once** via a
`SELECT … FROM roles … WHERE NOT EXISTS` backfill targeted at tenants that
already exist at migration time.

**Verdict: PASS as set-algebra.** The migration layer is *partial and
once-only* by construction — this is the seed of the §24 gap.

## 22. D9 — live database parity via the PRODUCTION bootstrap path

The live part of `d9-permission-parity.test.ts` (opt-in flag, disposable
`school_saas_test`) provisions **two disposable tenants through the REAL
`createTenantTransaction`** (`apps/api/src/routes/tenants.ts`) inside
`withSystem`, reads `roles` + `role_permissions` back with the trusted
executor, and asserts:

* Both tenants bootstrap **exactly** the six tenant-role codes
  (`school_owner/principal/teacher/accountant/parent/student`), scope `tenant`;
  the two tenants are **deterministic and identical** (per-role equality).
* **Per-role** `role_permissions` equal the corresponding `ROLE_TEMPLATES`
  permissions **exactly** (each role, each permission).
* The tenant-scoped DB union = **exactly the 81 template tenant permissions**;
  **no undeclared permission** exists (`DB ∖ template = ∅`).
* **Never** a `platform.*` grant inside a tenant bootstrap.

**Verdict: PASS** (live DB == template for what the template covers).

## 23. D9 — per-role equality, cross-tenant determinism

Covered by §22 with dedicated tests; additionally, tenant A and tenant B in the
live run are *byte-identical* across roles and permissions, confirming the
bootstrap is side-effect-free and deterministic.

## 24. D9 — the exact parity gap: 25 fees.* + cashier on NEW tenants

The **exact** parity claim ("catalog ↔ template ↔ migration ↔ live DB") does
**not** hold for a tenant created after migration `0028` ran, and the deviation
is now proven to be **precisely**:

* the **25 `fees.*`** permissions, and
* the **`cashier`** system role.

Empirical live-DB result: `catalog ∖ liveDB = 25 fees.* + 8 platform.*`
(the platform namespace is intentionally never tenant-granted), and — crucial —
**among tenant-scoped permissions the only missing entries are exactly the 25
`fees.*`** (asserted). Root cause, not a test artefact: the 25 `fees.*` were
shipped as a **migration-time backfill** (0028) and never added to
`ROLE_TEMPLATES`; `createTenantTransaction` seeds roles **only** from
`ROLE_TEMPLATES`, so every tenant created after 0028 gets 81 permissions and
**no** `cashier` role. This is a genuine production defect for new tenants
(fee-permission and cashier availability), outside the scope of a proof-only
phase and therefore **not fixed** (STOP rule, §28).

## 25. D6/B1/DEL-2/D9 — cross-cutting conclusions

* D3 is **fully proven** (runtime 15/15 + static gate 2/2 + tenant-invariant
  guard): the worker has no generic unscoped tenant-table access; the only
  intended cross-tenant read is the daily-summary scheduler.
* DEL-2 is satisfied — one tenant-scoped DELETE, proved.
* B1 is satisfied within the data plane and the log surface.
* D9 is **proven exactly in both directions**, and the proof exposes a **real,
  precisely-quantified parity gap for new tenants** (25 `fees.*` + `cashier`).
  The set algebra itself is consistent (114 = 89 ∪ 77); the defect is that the
  *migration/template provisioning contract* does not deliver the catalog to a
  fresh tenant.

## 26. Evidence integrity — migrations, dependencies, working tree

* Migrations: directory listing = **34 .sql files**; `git status` shows no
  migration file modified/unstaged and no new migration added. The runtime
  harness reports `already current: 34`, migrations applied: 0.
* 0029 and any future migrations: **RESERVED**; none created.
* Dependencies: no change to any `package.json`, `pnpm-lock.yaml` or workspace
  file; no installs performed.
* Working tree: `git status --short` after the work is listed in §2; the only
  *new* entries are the three proof-test files and this report. Every
  pre-existing modified/untracked entry is byte-identical to the baseline.

## 27. How to run every proof

As §1. Individual notes:

* `d3-static-tenant-gate.test.ts` — no DB, no env required, ~1 s.
* `d9-permission-parity.test.ts` — 7 static tests always run; 5 live tests run
  only with `RUN_RUNTIME_SECURITY_TESTS=1` (otherwise skipped).
* `d3-worker-tenant-isolation.test.ts` — requires the flag; uses the disposable
  `school_saas_test`; self-cleaning (afterAll removes tenants and triggers
  guards are disabled/re-enabled in FK order).
* Harness sanity (supporting evidence): `RUN_RUNTIME_SECURITY_TESTS=1 pnpm --filter @sms/worker exec vitest run src/exams-result-pipeline.test.ts` → 13/13 PASS.

## 28. Blockers encountered and why they are not fixed here

1. **D9 bootstrap gap (§24).** Cannot certify "catalog == fresh-tenant live DB"
   because `fees.*`/`cashier` are migration-backfilled, not templated.
   Per the STOP rule this is **reported, not fixed**: no template, migration or
   route change was made. The remedy is for the Phase 8 *implementation audit*
   (add the 25 `fees.*` to `school_owner`/`accountant` (with the 22/25 split),
   add `cashier` template or a second backfill, and a re-run policy for
   tenants created between 0028 and the remediation).
2. Transportation/toolchain blocker resolution: the static-gate scanner needed
   a real-table whitelist to avoid crypto-API false positives (`createHash(…).update(…)`);
   this is internal to the test, not a production change.

## 29. Final verdict

D3 (worker cross-tenant isolation) — **PROVEN (PASS)**: runtime 15/15, static
gate 2/2, DEL-2 lone DELETE proved tenant-scoped, B1 read/log surfaces clean.

D9 (permission parity) — **the proof is complete, but the promised property does
not hold for new tenants**: catalog 114 = templates 89 (81 tenant) ⊕ 25 fees.*,
migration-declared 77 ⊂ (templates + fees), live DB == templates exactly, gap =
exactly the 25 `fees.*` + missing `cashier` on a fresh tenant created after
0028.

> **BLOCKED — SECURITY PROOF INCOMPLETE**
>
> Reason blocker (not a test failure): an exact catalog ↔ live-DB parity for
> fresh tenants cannot be certified because `ROLE_TEMPLATES` never grants the
> 25 `fees.*` permissions and never provisions the `cashier` role; those exist
> only as a one-time migration backfill (0028) that new tenants never receive.
> Per the Prompt 3D STOP rule no remediation was attempted. The precise,
> test-backed diff is: catalog(114) = all(89 template + 25 fees) = liveDB(81) +
> 25 fees + 8 platform; tenant-scoped gap = exactly 25 fees.*; role gap =
> `cashier`. This is the single blocking item; everything else in Prompt 3D is
> proven and PASS.

---

## Machine-readable summary

```json
{
  "phase": "8",
  "prompt": "3D",
  "report": "PHASE_8_FINAL_D3_D9_SECURITY_PROOF_REPORT.md",
  "head": "5bf11d0067424ea6e372f92f536e4af0aa795552",
  "verdict": "BLOCKED — SECURITY PROOF INCOMPLETE",
  "runtime_db": "school_saas_test (disposable; school_saas_dev untouched)",
  "test_runs": {
    "combined": { "files": 3, "tests": 29, "passed": 29 },
    "d3_runtime": { "file": "apps/worker/src/d3-worker-tenant-isolation.test.ts", "tests": 15, "passed": 15 },
    "d3_static_gate": { "file": "apps/worker/src/d3-static-tenant-gate.test.ts", "tests": 2, "passed": 2 },
    "d9_parity": { "file": "apps/worker/src/d9-permission-parity.test.ts", "tests": 12, "passed": 12 },
    "harness_sanity": { "exams_result_pipeline": "13/13 PASS" }
  },
  "d3": {
    "model": "data-based isolation; worker runs as school_migrator with withGuc({system:true}) (RLS bypassed)",
    "tenantIdOf": "payload.tenantId ?? event.tenantId",
    "statements_scanned": { "total": 50, "builder": 45, "raw": 5, "scoped": 40, "documented_allowances": 10 },
    "deletes": { "production_sites": 1, "location": "exams.ts:402 report_card_subjects (tenant-scoped, runtime-proven)" },
    "sac_tests_15_of_15": ["R1 read x3", "U1 update x2", "D1 delete x4", "S1 upsert x3", "X context x2", "trust-chain probe x1"]
  },
  "d9": {
    "catalog": { "total": 114, "unique": 114 },
    "templates": { "union": 89, "tenant": 81, "platform": 8, "roles": ["school_owner","principal","teacher","accountant","parent","student"] },
    "migration_declared": { "catalog_permissions": 77, "migration_only": 25 },
    "catalog_only": { "count": 25, "permissions": "fees.* (25)" },
    "union_templates_OR_migrations_equals_catalog": true,
    "live_db": {
      "perfil_role_equals_template": true,
      "tenant_union_equals_templates_81": true,
      "undeclared_permissions": 0,
      "tenant_scoped_gap": { "count": 25, "permissions": "fees.* (25)" },
      "missing_role": "cashier",
      "platform_never_granted_to_tenants": true,
      "a_equals_b_deterministic": true
    },
    "gap_root_cause": "fees.* + cashier shipped as one-time migration 0028 backfill; ROLE_TEMPLATES never granted them; createTenantTransaction seeds only from ROLE_TEMPLATES"
  },
  "integrity": {
    "migration_files": 34,
    "new_migrations": 0,
    "dependencies_changed": false,
    "school_saas_dev_modified": false,
    "test_db_after_run": "0 tenants"
  },
  "final_gate": {
    "total_items": 44,
    "pass": 43,
    "fail": 1,
    "failed_item": {
      "id": 43,
      "label": "D9 exact parity: catalog == fresh-tenant live DB (fees.* / cashier via template bootstrap)",
      "result": "FAIL",
      "reason": "catalog(114) = templates(89) ⊕ fees(25); fresh tenant liveDB = templates(81) exactly; tenant-scoped gap = exactly the 25 fees.*; role cashier absent",
      "evidence": "apps/worker/src/d9-permission-parity.test.ts (12/12, incl. live bootstrap via createTenantTransaction)"
    }
  },
  "blocker": {
    "id": "D9-bootstrap-gap",
    "type": "production provisioning defect (proof-cert boundary)",
    "remediation": "Phase 8 implementation audit to add fees.* to school_owner/accountant templates and a cashier template/backfill — NOT performed here per STOP rule"
  }
}
```

## Final gate — 44 questions

| # | Gate item | Result | Evidence |
|---|---|---|---|
| 1 | Baseline HEAD recorded | PASS | §2 |
| 2 | Worker executes under trusted-executor RLS-bypass, isolation is data-based | PASS | §3 |
| 3 | Data-plane handler inventory complete | PASS | §4 |
| 4 | Every worker DB statement extracted | PASS | §5 |
| 5 | Every statement classified scoped/unscoped | PASS | §5 |
| 6 | Unscoped statements are on the reviewed allowance list | PASS | §6 |
| 7 | R1: cross-tenant READ reads zero foreign rows | PASS | §7 |
| 8 | R1 statement-level: bind uses owner tenant only | PASS | §7 |
| 9 | U1 cross-tenant UPDATE mutates nothing | PASS | §8 |
| 10 | U1 issues no UPDATE/INSERT on foreign target | PASS | §8 |
| 11 | D1 cross-tenant DELETE issues no DELETE | PASS | §9 |
| 12 | D1 same-tenant recompute still exercises DELETE (non-vacuous) | PASS | §9 |
| 13 | S1 cross-tenant artifact job fails closed, no file row | PASS | §10 |
| 14 | S1 storage-key conflict fails closed (no adoption/overwrite) | PASS | §10 |
| 15 | NULL event.tenantId fails before handlers | PASS | §11 |
| 16 | Empty/garbage tenantId fails envelope validation | PASS | §11 |
| 17 | payload.tenantId override behaviour documented/probed | PASS | §11/14 |
| 18 | Static gate is non-vacuous (fixture fails it) | PASS | §13 |
| 19 | Static gate: production has zero unexpected unscoped statements | PASS | §13 |
| 20 | Fixture cleaned after gate run | PASS | §13 |
| 21 | D6: single tenantId derivation path, validated | PASS | §14 |
| 22 | D6: deferred jobs carry tenantId; contracts in parity | PASS | §15 |
| 23 | D6: no content-derived tenant path (invalidation sweep) | PASS | §16 |
| 24 | B1: no unconstrained tenant reads (runtime+static) | PASS | §17 |
| 25 | B1: log/secret scrub (no DSN/password/token/apiKey in logs) | PASS | §18 |
| 26 | DEL-2: exactly one worker DELETE, tenant-scoped | PASS | §19 |
| 27 | D9: catalog = 114 unique | PASS | §20 |
| 28 | D9: templates = 89 (81 tenant + 8 platform), namespaces never mix | PASS | §20 |
| 29 | D9: tenant role codes = the six bootstrapped | PASS | §20 |
| 30 | D9: catalog-only = exactly the 25 fees.* | PASS | §20 |
| 31 | D9: template ⊆ catalog (no template-only drift) | PASS | §20 |
| 32 | D9: migration-declared = 77, all catalog-valid | PASS | §21 |
| 33 | D9: migration-only = exactly the 25 fees.* | PASS | §21 |
| 34 | D9: template-union ∪ migrations = catalog (114) | PASS | §21 |
| 35 | D9 live: bootstrap runs the PRODUCTION createTenantTransaction | PASS | §22 |
| 36 | D9 live: both tenants seed exactly six roles, deterministic | PASS | §22/23 |
| 37 | D9 live: per-role DB == per-role template exactly | PASS | §22 |
| 38 | D9 live: tenant union == 81, no undeclared permission | PASS | §22 |
| 39 | D9 live: platform.* never granted to tenants | PASS | §22 |
| 40 | D9 gap: tenant-scoped missing set == exactly 25 fees.* | PASS | §24 |
| 41 | D9 gap: cashier role absent from fresh tenant bootstrap | PASS | §24 |
| 42 | Integrity: 34 migrations, none new/modified | PASS | §26 |
| 43 | Integrity: no dependency changes; dev DB untouched; test DB clean after | PASS | §26 |
| 44 | D9 exact parity for a NEW tenant (catalog ↔ template ↔ migration ↔ live DB) | **FAIL** | §24, §28 |

Result: **43 PASS, 1 FAIL** (item 44). The single FAIL is a real provisioning
defect, not a proof failure — per the STOP rule it is blocked, not fixed, and
handed to the Phase 8 implementation audit.

---

*Prepared for the Phase 8 final D3/D9 evidence gate. All numbers above are
regenerated by the cited test files on demand; the combined run for this report
was executed and is recorded in §1/§12.*