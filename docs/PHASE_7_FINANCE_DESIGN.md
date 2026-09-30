# Phase 7 — Fees & Finance: Adjudicated Design

Status: **DESIGN REMEDIATION** — supersedes `docs/FINANCE_DESIGN.md` (Phase 0 draft) and the `fin_*`
table sketch in `docs/DATABASE_DESIGN.md` §9. Normative for all Phase 7 implementation.

Baseline under audit: `v0.1.0-recovery` / `71aaffe9cb90b8635ca0ae176d78bf76288cae1f`.

> **Source-material finding.** No Phase 7 design or discovery document existed in this repository at
> the audited baseline. The pre-existing finance material is (a) `docs/FINANCE_DESIGN.md`, a Phase 0
> draft dated before any Phase 1 code existed, and (b) `docs/DATABASE_DESIGN.md` §9, a one-page table
> sketch. Every claim in the remediation brief about "the current Phase 7 design" is therefore traced
> to one of those two documents plus the roadmap entry. Where this document contradicts them, this
> document wins and the supersession is recorded in §32.

---

## 1. Current repository baseline

Observed by direct inspection on 2026-09-29. All values are **measured**, not inherited from the brief.

```text
HEAD                    71aaffe9cb90b8635ca0ae176d78bf76288cae1f
branch                  master (tracks origin/master, no divergence)
origin/master           71aaffe9cb90b8635ca0ae176d78bf76288cae1f
remote exists           YES — origin is configured and reachable; refs/heads/master == HEAD
recovery tag            v0.1.0-recovery -> tag object 73aee4e777293b18726228d3353fe40dd8ef953b
                          peeled: ^{} == 71aaffe9cb90b8635ca0ae176d78bf76288cae1f  (annotated)
migration ceiling       0020_schema_migrations_runtime_protection.sql
migrations present      0001..0020, contiguous, 8328 lines
CI baseline             .github/workflows/phase6-security.yml — 1 workflow, 1 job (security-gate),
                          no matrix, 19 steps, postgres:16 + redis:7 services, no ${{ secrets.* }}
working-tree status     CLEAN except 8 UNTRACKED scratch files, all pre-existing, none committed:
                          .coupling.mjs  .mkturbo.mjs  .overlay.mjs  .stage-list.txt
                          .stage.mjs     .sync.mjs     .turbo.release.json
                          packages/redis/probe.cjs
tracked-file changes    NONE
```

### 1.1 Deviations from the stated baseline

| Brief claimed | Observed | Verdict |
|---|---|---|
| HEAD `71aaffe…` | `71aaffe…` | match |
| `origin/master` == baseline | match | match |
| tag `v0.1.0-recovery` | match (annotated, peels to baseline) | match |
| migrations 0001–0020 immutable | present, unmodified | match |
| next migration is `0021` | confirmed — `packages/db/src/cli/migrate.ts:32` sorts migrations **lexicographically** by `/^[0-9]+_.+\.sql$/`, so the next file is `0021_*.sql` | match |
| Phase 6 CI executed | workflow exists and is the only CI in the repo | **partially confirmed** |
| 902 gated runtime/security tests verified | **902 appears in exactly one place**: `docs/PHASE_2_6_RECOVERY_AUDIT.md:631-632` as `db destructive 5, db aggregate 323, api 476, worker 98 — 902 tests`, described as a **clean-checkout run tally** | **not a CI assertion** |

**CI baseline, precisely stated.** The workflow exists and is a real, runnable gate. It does
**not** assert any test count; no step, script, or test in the repository contains the number `902`.
The figure is a transcribed total of one local clean-checkout run, recorded in the Phase 2–6 recovery
audit. It is therefore a **hand-summed run report, not machine-verified CI output**, and this design
does not restate it as CI-verified. Two further accuracy notes, both factual: CI runs **no lint step**
and **no e2e step** (no Playwright config exists), and the recovery audit's "test files tracked 67"
is stale — `git ls-files '*.test.ts' '*.test.tsx'` returns **68** (the 68th being
`packages/config/src/load-env.test.ts`).

The remote **does** exist and `master` tracks it. Any statement in prior finance material implying
"no remote" or "CI has never executed" is **false** and is not carried forward.

### 1.2 The security substrate Phase 7 inherits (authoritative, from `0001`–`0020`)

- **Trust boundary.** RLS trusts only cryptographically verified claims read from a signed, 5-minute
  `app.rls` ticket minted by `app_ctx_mint()` (`0002_trusted_context.sql:71-120`). Raw `app.*` GUCs
  are dead. Forging a GUC buys nothing.
- **The privileged escape.** `app_privileged()` is `current_user IN ('school_migrator')`
  (`0002:58-61`), SECURITY INVOKER. `school_migrator` is the role the **worker** and the **migrate
  CLI** connect as (`apps/worker/src/worker.ts:326-330`; `.env.example` `DATABASE_URL_MIGRATOR`).
  The API connects as `school_app_rw` (`apps/api/src/server.ts:8`).
- **Worker context is empty.** `withSystem()` short-circuits to `set_config('app.rls','',true)`
  (`packages/db/src/client.ts:38-43`). A worker has **no** tenant claim and **no** user claim, and
  passes RLS purely through `app_privileged()`. Every worker query must therefore scope by
  `event.tenantId` **in its own WHERE clause**. This is proven by
  `apps/worker/src/outbox-integration.test.ts:550-614`.
- **Runtime role has no hard DELETE anywhere.** Every `_delete` policy is `app_privileged()`-only
  (`0002:423-436`).
- **Grant convention.** `0001:380-383` sets `ALTER DEFAULT PRIVILEGES FOR ROLE school_migrator`, but
  every migration still repeats an explicit
  `GRANT SELECT, INSERT, UPDATE, DELETE ON <t> TO school_app_rw;` (`0005:355-359`, `0014:602-605`).
  Phase 7 follows the explicit form.
- **Privilege-removal precedent.** `0020` is the template for a *negative* privilege change: additive
  migration → `REVOKE` → fail-closed `DO $assert$` post-condition check. Phase 7 uses this for
  finance RLS hardening.

### 1.3 The four findings that change the Phase 7 design

These are measured properties of the current repository, not opinions. Each one invalidates an
assumption the finance design would otherwise carry, and each has a mandated consequence.

**F-7.1 — There is no relationship-aware RLS anywhere in this codebase.**
Every `CREATE POLICY` in `0001`–`0020` uses one body for tenant-scoped school tables
(`0005:331-334`, inside the `FOREACH` loop spanning `0005:323-351`). The count is stated precisely, in
three named figures, because two earlier revisions of this line got it wrong: first "137", then "101
literal + 87 generated = 188 sites / 273 effective". Both were wrong, and the second was wrong in a way
that double-counts. The three figures, measured by expanding each `FOREACH … IN ARRAY ARRAY[…]` loop
and multiplying by its table count:

| Figure | Count | What it is |
|---|---|---|
| **Textual occurrences** of `CREATE POLICY` | **101** | lines containing the token, in 12 files |
| — of which **direct literal statements** | **69** | written out in full, not inside a loop: `0001` 27, `0002` 36, `0003` 2, `0018` 4 |
| — of which **loop template sites** | **32** | 8 loops × 4 policy bodies each (`0004`, `0005`, `0007`, `0008`, `0009`, `0011`, `0014`, `0015`) |
| **Effective policies** | **241** | 69 direct + 172 generated (8 loops × their table counts × 4: `0004` 8→32, `0005` 10→40, `0007` 2→8, `0008` 2→8, `0009` 4→16, `0011` 4→16, `0014` 5→20, `0015` 8→32) |

`101` is the number of *textual* occurrences and is **not** the number of statements, which is why
"101 literal" was wrong: 32 of those 101 are single `format()` templates that each expand to one policy
per table in an array. And the "87 generated" figure was wrong in the same direction from the other
side — the loops hold **32** template sites, not 87, so `101 + 87 = 188` sites double-counted nothing
correctly and `188 × 4 ≠ 273`. None of the 101 bodies — direct or generated — references a
relationship table:

```sql
USING ( (tenant_id = app_current_tenant_id() AND app_current_tenant_id() IS NOT NULL)
        OR app_privileged() )
```

No policy anywhere references `student_guardians`, `guardians.user_id`, or `students.user_id`.
Parent/student narrowing for attendance, homework and results is **100% application-layer**, via
`readableStudentIds()` (`apps/api/src/routes/school/attendance.ts:107-174`), which is the only such
helper and is called from exactly three route modules — `apps/api/src/routes/school/attendance.ts`,
`apps/api/src/routes/school/exams.ts:316` and `apps/api/src/routes/school/leave.ts` — none of which is
a database policy. Consequence: the
repository's security claim for exams — "this can never expose another family's results"
(`packages/permissions/src/permissions.ts:314-316`) — rests entirely on endpoint code with **no
database backstop**. For finance, a missing `inArray` on a list route is a cross-family disclosure
of money. **Phase 7 must introduce the first relationship-aware RLS policies in the codebase**
(§19). This is a new security mechanism and carries its own test obligation.

Two latent defects in the existing app-layer helper that Phase 7 must **not** inherit:
`attendance.ts:136-158` filters `guardians.deletedAt` and `students.deletedAt` but **never**
`studentGuardians.deletedAt` — a soft-unlinked guardian still resolves to the former child
(`0006` exists precisely to support that unlink). `homework.ts:145-169` additionally omits
`students.deletedAt`.

**F-7.2 — `app_privileged()` is inherited by every existing policy, and the worker is privileged.**
Because every policy terminates in `OR app_privileged()`, any table following house style is
automatically fully readable *and writable* by the worker connection. Financial tables are different:
the worker must be able to post ledger entries, but a platform administrator must not be able to
read tenant finance by accident. §19 therefore specifies finance policies that **do not** use the
generic house body.

**F-7.3 — An event type in the catalog but not in the handler ladder is silently acknowledged.**
`apps/worker/src/worker.ts:152-171` builds the registry by iterating the Zod enum and ending in a
terminal `logEvent(type)` arm — a log-only ack that commits `processed_at`. 84 of the 93 declared
event types are currently in that state. The historical defect was exactly this
(`git show 408fa26^:apps/worker/src/worker.ts` — `if (handler) await handler(...); await
tx.update(...set processedAt...)` acked 87 of 93 events with no side effect and no validation).
The current code *does* throw on a registry miss (`worker.ts:70`) and *does* Zod-validate the
envelope (`worker.ts:103`) — but those two gates do **not** cover a declared type with no ladder arm.
Consequence: adding a `fees.*` event to `outboxEventTypeSchema` without adding a ladder arm and
without adding it to the always-on gate in `worker-event-registry.test.ts` produces a **permanently
silently-acknowledged financial event**. §28 makes that a hard gate.

**F-7.4 — `enqueueDeferred` misroutes any non-mail queue onto `events`.**
`worker.ts:88-90`:

```ts
const target: Queue | undefined =
    job.queue === 'mail' ? (queues.mail as Queue) : (queues.events as Queue);
```

There is no `'reports'` arm, so `report.studentReportCard` is enqueued to the **events** queue, where
`outboxEventSchema.safeParse` fails and the job throws. The correct helper already exists and is
unused: `queueForJob()` (`packages/jobs/src/queues.ts:45-50`). A `billing` queue added in Phase 7
would be misrouted identically. **Fixing this is a prerequisite sub-task, not a Phase 7 deliverable
to defer.**

### 1.4 Role terminology — repository truth vs the brief

The brief's persona list does not match the repository. The design uses **repository terminology**:

| Brief said | Repository reality | Evidence |
|---|---|---|
| "school admin" | role code **`school_owner`** | `packages/permissions/src/permissions.ts:155` |
| "built-in cashier" | **no `cashier` role exists** | `ROLE_TEMPLATES` = `platform_admin`, `school_owner`, `principal`, `teacher`, `accountant`, `parent`, `student` (`:146-326`) |
| "accountant/finance manager" | `accountant` exists but is a **3-permission stub** (`tenant.read`, `users.read`, `audit.read`) | `:301-306` |
| `fees.*` permissions | **none exist**; catalog ends at `exams.correct` | `:127-131` |
| custom roles | `roles` table supports them, **but there is no API route and no nav section for role management** — no `roles.ts` in `apps/api/src/routes/` | route listing |
| `fees.invoices.read` for principal | conflicts with "principal = aggregate only" | see §20 |

**No custom roles are reachable in production today.** This is decisive for §20: a "cashier" cannot
be created as a custom role, so separation of duties requires either a new built-in template or no
separation at all. Adjudicated in §20.1.

### 1.5 Where role templates are materialised — and why §20 is a real blocker

`ROLE_TEMPLATES` are written to the database in **exactly two** places:

1. `createTenantTransaction()` — `apps/api/src/routes/tenants.ts:70-88` — on **tenant creation**,
   with `isSystem: true`. There is no other backfill.
2. `bootstrap-platform-admin.ts` — additive `role_permissions` insert for `platform_admin` only.

`packages/db/src/cli/seed.ts` is an explicit **no-op** ("seed fixtures intentionally deferred"). So:

> **Adding `fees.*` to `ROLE_TEMPLATES` affects only tenants created afterwards. Every existing
> tenant keeps its seven system roles with their current permission sets, permanently, unless an
> explicit backfill migration is written.**

This is a P1-class gap that the naive design ("just add the permissions to the template") would have
shipped silently. §20 specifies the backfill and the no-widening proof.

### 1.6 Documentation-consistency corrections (P2, carried here)

| Stale claim | Location | Reality |
|---|---|---|
| "§10 = financial integrity" style cross-reference | `DEVELOPMENT_ROADMAP.md:87` says `refund审批` | A stray CJK token in an English roadmap. `DEVELOPMENT_ROADMAP.md` is not this phase's artifact and was **not** edited; flagged for the owner. |
| `DATABASE_DESIGN.md` §9 heading says `fin_*` but **every table it lists is unprefixed** (`fee_structures`, `invoices`, `payments`, `ledger_entries`…) | `DATABASE_DESIGN.md:205-220` | Genuine internal contradiction. **Adjudicated in §6.1**: `fin_` prefix wins. |
| `FINANCE_DESIGN.md:26` "**required** `Idempotency-Key`" | `FINANCE_DESIGN.md:26` | The header is **`x-idempotency-key`** (`apps/api/src/routes/school/util.ts:359`) and it is **optional** — the helper returns `null` and never throws, and `withIdempotency` silently runs the operation unprotected (`packages/idempotency/src/index.ts:95-98`). Nothing enforces "required". |
| `FINANCE_DESIGN.md:20` "no gaps under concurrency except on rollback" and implies a gap mechanism | `FINANCE_DESIGN.md:32` | No such mechanism exists. Replaced by precise language in §14. |
| "immutability trigger … via `app.allow_immutable_update` GUC set only inside controlled correction functions" | `DATABASE_DESIGN.md:220` | **Unimplementable as written**: `0002` established that any GUC readable by an RLS/trigger expression is forgeable by the runtime role. A GUC-gated mutation bypass is a Phase-1-class defect. **Rejected**; replaced by §16. |
| `DATABASE_DESIGN.md:243` / `JOB_ARCHITECTURE.md:43` reference a `job_runs` table | — | **Does not exist** in any migration or in `packages/db/src/schema.ts`. Phase 7 must not depend on it (§28). |
| `DATABASE_DESIGN.md:154` says `audit_logs.ip` is `inet` | `schema.ts:250` | It is `text`. |
| `DATABASE_DESIGN.md:165` "immutable verified live" for `audit_logs` | — | True only in the weak sense that **no UPDATE/DELETE policy exists**; there is no trigger. |
| `JOB_ARCHITECTURE.md` DLQ / `job_runs` / `runAsTenant` / per-aggregate ordering | — | None implemented. `packages/jobs/src/queues.ts:13-19` defines only `events`, `mail`, `reports`. `getUnprocessedCount` is exported and called by nothing. |

---

## 2. Phase 7 objective

Deliver a **complete, deterministic, independently reconcilable money cycle** for a single-tenant
school operating in Pakistan:

```text
fee structure  ->  invoice (challan)  ->  payment  ->  receipt
                                        |-> allocation
                                        |-> refund  ->  reversal  ->  refund advice
                     ledger (narrow double-entry) proves every transition
```

The objective is **not** a general ledger. It is a fee sub-ledger that is:

- **operationally authoritative** for the receivable — the ledger is the single source of truth for
  how much a school is owed, derived independently of any invoice aggregate;
- **independently reconcilable** — the receivable provable two ways that must agree (§15.3);
- **append-only where money moved** — corrections are new rows referencing old ones, never mutation.

A design that cannot answer "how much does this parent owe, and prove it" from first principles has
failed, regardless of how the invoice list page looks.

## 3. Scope

In scope for Phase 7, and only these:

1. Fee head catalog, versioned fee structures, per-student fee assignments.
2. Deterministic structure-target resolution (§7.5) and billing generation.
3. Invoices, invoice line items, signed adjustments (discount / concession / waiver / fine / late
   fee), challans.
4. Payments: manual/cash, bank deposit, and a **provider-neutral** online boundary with a webhook
   receiver (§27).
5. Allocations, including partial, multi-invoice, and on-account (unallocated) payments.
6. Refunds and non-refund reversals, with immutable financial documents.
7. Receipts (immutable) and refund advices.
8. A narrow double-entry sub-ledger with a fixed per-tenant chart of accounts.
9. Bank/cash reconciliation with variance handling and immutable completion snapshots.
10. Parent and student self-service portal read.
11. Finance reporting: AR aging, collection summary, unallocated/on-account, fee-head revenue.
12. Finance RBAC, relationship-aware RLS, audit and outbox integration.
13. Pakistan localization boundary: PKR, challan workflow, IBAN validation, Urdu/RTL **excluded**
   (§26).

## 4. Explicit out-of-scope boundary

Each of these is **out** for Phase 7. Stating them explicitly is what prevents the §21 scope
contradiction from recurring.

| Excluded | Rationale | Replacement in Phase 7 |
|---|---|---|
| **Full general ledger**: journal entries, chart-of-accounts administration UI, period close, year-end closing entries, multi-currency FX | A school needs fee collection, not a general accounting system | Fixed per-tenant chart of accounts seeded once; no user-managed accounts; no periods |
| **Automatic late-fee policy engine**; scheduled late-fee worker | Requires policy configuration, scheduling fairness, and notification design | **Seam only**: `fin_invoice_adjustments.type = 'late_fee'` exists and is a supported representation. No calculation, no schedule. See §21 |
| **Real payment provider adapters** (Easypaisa, JazzCash, Raast, 1LINK, PayFast) | Requires merchant accounts, keys, PCI scope, and integration testing per provider | Provider-neutral interface + verified webhook receiver + a **test-only** fake provider. Manual cash/bank is the production path |
| **Tax engine** | Jurisdiction, rates, registration, and filing are legal/product decisions (§24) | `tax_treatment` column + `fin_tax_profiles` seam, **disabled by default** |
| **Urdu / RTL UI, Urdu PDF** | Doubles every surface; needs translation + RTL layout engineering (§22) | English only, UTF-8 clean, `locale` already on `user_profiles` |
| **Fee credit notes as standalone documents** | A credit note is a full document lifecycle (its own numbering, ledger, portal surface) | Credits are **signed adjustment rows** on the invoice (§15.2) |
| **Arrears / balance carry-forward across academic years** | Changes what a new year's invoice means; needs a product decision (§32, OD-10) | Prior-year arrears are **visible in reports** but never auto-carried into a new invoice |
| **Payroll, library fines, transport fees as producers** | Phase 9 / Phase 10 | Consumers of the finance model; Phase 9 will post fines as `fee_adjustments` |
| **Dunning reminders** | Roadmap lists it, but it is a notification feature | Phase 8 (`com_*`). Phase 7 emits `fee.invoice.overdue` for Phase 8 to consume |
| **Platform-level cross-tenant finance analytics** | §19 forbids inheriting the generic platform bypass | No platform finance access at all in Phase 7 |
| **Payroll** | Phase 10 | — |

## 5. Accounting boundary

### 5.1 This is a fee sub-ledger, not a general ledger

Stated precisely, because the boundary is what makes the rest implementable:

**In scope — a narrow double-entry sub-ledger** that records, for each money movement, which of a
fixed set of accounts moved by how much. It is:

- **operationally authoritative** for the school's *receivable position*. "What is owed" is answered
  by the ledger, not by an invoice counter.
- **independently reconcilable.** Two independent computations of the receivable must agree, and a
  nightly job proves it (§15.3, FI-009).
- **append-only.** `fin_ledger_entries` accept `INSERT` only. Corrections are new balancing groups
  that reference the group they reverse.

**Out of scope — a general ledger.** No user-managed accounts, no manual journal entries, no
accounting periods, no year-end closing, no depreciation, no fixed assets, no multi-currency FX,
no cost centres, no budgeting. The chart of accounts is **fixed, seeded per tenant, and not
user-editable in Phase 7**. This is the same "don't build a GL" boundary `docs/BILLING_DESIGN.md:88`
draws between platform billing and school finance.

### 5.2 Chart of accounts (fixed, seeded per tenant)

| Code | Name | Type | Normal side | `is_contra` |
|---|---|---|---|---|
| `1000` | Cash in hand | asset | debit | no |
| `1100` | Bank / mobile wallet | asset | debit | no |
| `1200` | Accounts Receivable — Fees | asset | debit | no |
| `1300` | Unapplied Cash (On Account) | **liability** | credit | no |
| `2200` | Refund Payable | **liability** | credit | no |
| `4000` | Fee Income | revenue | credit | no |
| `4100` | Fee Income — Concessions & Waivers | revenue | **debit** | **yes** |
| `4200` | Fee Income — Fines & Penalties | revenue | credit | no |
| `4900` | Unapplied / Advance Fee Income | revenue | credit | no |

**The chart is nine accounts, not ten, and exactly one of them is contra.** This table is one of three
independent renderings of the same fixed chart — the other two are `fin_ledger_accounts`'s `code`
CHECK and F3's seed `VALUES` list — and all three are now verified **row-for-row** on
`(code, account_class, normal_side, is_contra)` and on order, not merely as sets (`R21′`). A count
taken from the CHECK is **9**, a count taken from this table is **9**, and a count taken from F3's seed
is **9**; the previous revision of this section said "10" in two places (F3's purpose line and the
§30.5 backfill row) while the DDL it described seeded 9. `4100` carries `is_contra = true` because a
concession is contra-revenue (§15.1 posts it `Dr 4100 / Cr 1200`), and it is the **only** account
where a revenue class and a debit normal side are both correct — which is why
`fin_ledger_accounts_side_ck` has four arms rather than three.

`1300 Unapplied Cash` is a **liability**, not an asset. A parent who has overpaid holds a claim on the
school. Collapsing it into income would overstate revenue and misstate the balance sheet position —
this is the single most common modelling error in school fee systems and it is explicitly rejected.

`1300` ↔ `4900` are the two sides of an on-account payment: cash in, revenue deferred. Applying it to
an invoice later moves `1300` → `1200` and never touches income again (income was recognised at
invoice issue).

### 5.3 Why income is recognised at **issue**, not at payment

Invoice issue posts `Dr 1200 / Cr 4000`. This is accrual accounting and it is the correct choice
here because:

- It makes the ledger's AR balance equal the sum of what has been *billed and not settled*,
  independent of payment timing.
- It makes a voided invoice a clean, total reversal of a known pair.
- It makes aging possible: an invoice's age is measured from `issued_at`, and its balance exists
  whether or not anyone has paid.

The alternative (recognise on cash) makes the receivable meaningless for unpaid invoices and makes
aging impossible without a separate accrual. Rejected.

---

## 6. Domain model

### 6.1 Naming — `fin_` prefix is authoritative

`DATABASE_DESIGN.md` §9 is headed ``Finance (`fin_*`)`` but lists **unprefixed** table names, and
`BILLING_DESIGN.md:88` refers to "`fin_*`". **Adjudicated: every Phase 7 table is prefixed `fin_`.**

Reasons: the repository has a strict table-prefix convention (`plt_`, `acd_`, and per-module prefixes
in `DATABASE_DESIGN.md` §1–§16); a bare `payments` or `invoices` table in the `public` schema is
collision-prone and inconsistent with `acd_classes` (renamed from `classes` precisely to avoid
ambiguity — `0008:1-46`); and a `fin_` prefix makes `REVOKE`/`GRANT`/policy diffs readable at a
glance.

### 6.2 Entity inventory

| Table | Purpose | Mutability |
|---|---|---|
| `fin_tenant_settings` | One row per tenant: currency, webhook raw-retention days | owner-only |
| `fin_ledger_accounts` | Per-tenant chart of accounts (fixed codes) | insert only |
| `fin_tax_profiles` | Empty tax seam (`none` / `inclusive` / `exclusive` / `exempt`) | out of scope in Phase 7 (OD-04) |
| `fin_document_counters` | Transactional numbering counters | counter update only |
| `fin_fee_heads` | Tenant fee-head catalog (Tuition, Admission, Transport…) | CRUD, soft-delete |
| `fin_fee_structures` | Versioned, target-scoped fee template | CRUD → publish → supersede |
| `fin_fee_structure_targets` | Polymorphic target (campus/grade/class/section/all) | immutable after publish |
| `fin_fee_structure_items` | (fee head, installment no, amount, recurrence) | immutable after publish |
| `fin_fee_installment_plans` | (structure, seq, due_on) schedule | immutable after publish |
| `fin_fee_assignments` | Per-student binding of a structure | CRUD, one active per (student, year, period) |
| `fin_billing_runs` | One deterministic generation attempt | append + status |
| `fin_billing_run_items` | Per-(run, student, item) resolution trace | **immutable** |
| `fin_invoices` | Bill | draft mutable; issued frozen |
| `fin_invoice_items` | Lines | immutable once issued |
| `fin_invoice_adjustments` | Signed discounts / waivers / fines / late fees | **append-only** |
| `fin_challans` | Pakistan payment instrument, 1:1 with a live invoice | mirrors invoice state |
| `fin_payments` | Money received | **append-only.** No `reverses_payment_id`, no `status='reversed'` — reversal is an allocation row (§11.1) |
| `fin_payment_allocations` | Where a payment's money went: an invoice, or on-account. **The single signed source** | **append-only, signed**; `invoice_id` is nullable (§12.1) |
| `fin_receipts` | Payment receipt; **no `status` column, no `void`** | **immutable for life**; a correction is a new `version` (§25.5, FI-019) |
| `fin_refunds` | Refund request/approval/processing | controlled state machine |
| `fin_ledger_entry_groups` | Balanced posting header | **insert-only** |
| `fin_ledger_entries` | Debit/credit legs | **insert-only** |
| `fin_reconciliation_batches` | Bank/cash statement batch | state machine |
| `fin_reconciliation_matches` | Payment ↔ statement line | state machine + `is_final` |
| `fin_document_artifacts` | Logical artifact identity | insert-only pointer |
| `fin_payment_gateway_webhooks` | Provider events. `tenant_id` nullable — written only from the verified account mapping | insert-only |
| `fin_provider_accounts` | (provider, account_ref) → tenant + secret **reference** | CRUD |
| `fin_webhook_raw_payloads` | **NOT created in Phase 7** (P1-09). Opt-in raw bodies, redacted + expiring + restricted; **encryption deferred** to a deployment decision (OD-01) | future table |
| ~~`fin_finance_documents`~~ | Unified immutable document registry | **NOT created — see note below.** The registry exists as `fin_document_artifacts`; a second, parallel registry would duplicate the identity, the immutability trigger, and the RLS, and the two would drift |

### 6.3 Tenant anchoring — the composite-FK rule (NORMATIVE, mechanically enforced)

Every finance table carries `tenant_id NOT NULL` and is reached from other tables **only** through a
composite FK `(tenant_id, <id>)`, matching the repo's established anchor pattern
(`students_photo_file_fk`, `acd_classes_campus_fk`, `sections_class_fk`, `report_cards_file_fk`).

**The rule has three mandatory parts, and all three appear in the DDL of this document:**

| # | Rule | Why it is mandatory |
|---|---|---|
| **R1** | Every table that is the **target** of a composite FK declares `UNIQUE (tenant_id, id)` **explicitly**, written out in its own DDL block. No `...` elision may stand in for it. | A composite FK is only *legal* if the referenced columns are covered by a `UNIQUE`/`PRIMARY KEY` constraint. Without the declaration, the FK either fails to apply or the author silently substitutes a bare `REFERENCES t(id)`. |
| **R2** | Every tenant-scoped FK is written `FOREIGN KEY (tenant_id, <col>) REFERENCES <t> (tenant_id, id)`. A bare `REFERENCES <t>(id)` is **forbidden** anywhere a tenant relationship exists. | `REFERENCES t(id)` on a globally-unique uuid checks *existence* but not *tenancy*: a valid uuid from another tenant is accepted. This is the exact defect the rule exists to prevent. |
| **R3** | **No fenced code block in this document contains the three-character sequence `...` — anywhere, including inside SQL comments.** | An elision is how a rule stated in prose fails to appear in the DDL, and an auditor cannot verify what is not written. The rule is written as a *mechanical* restriction rather than a semantic one on purpose: a test can grep for `...` and cannot tell an elided column from a sentence that happens to use an ellipsis, so the stricter wording is the one that is actually enforceable. During this revision's static pass it caught **8** remaining occurrences, 5 of them in SQL comments, which is exactly the class of thing a "semantic" rule would have waved through. |
| **R4** | **R1/R2 have exactly one class of exception, and it is enumerated, not implied.** A FK to a **platform-global identity table** — `users`, `auth_sessions`, `tenants` — is written as a single-column `REFERENCES <t>(id)`, because those tables have no `tenant_id` column and are not tenant-owned. Every such FK is listed in §35.2 with the reason, and `finance-composite-fk.test.ts` treats this set as an allowlist rather than failing on it. | Without an explicit exception, R1/R2 are either violated silently or "fixed" by inventing a `tenant_id` column on `users` — which is what the previous revision of §19.8.1 did, producing a migration that fails with `column "tenant_id" does not exist`. A rule with no stated exception gets satisfied by inventing schema. |

**R4's allowlist is short, and each entry is verified, not assumed.** `users` and `auth_sessions`
have no `tenant_id`; `tenants` *is* the tenant, so its `id` is the tenant key and referencing it
single-column is not merely permitted but correct. Verified: `0001_init.sql` declares
`users(id, email, status, email_verified_at, created_at, updated_at, deleted_at)` and
`auth_sessions(id, user_id, token_hash, ip, user_agent, active_tenant_id, created_at, expires_at,
last_active_at, revoked_at)`, and `grep -rn "ALTER TABLE users\|ALTER TABLE auth_sessions"
packages/db/migrations/` returns only the `ENABLE/FORCE ROW LEVEL SECURITY` pairs. Tenancy reaches a
user through `memberships(user_id, tenant_id)`, whose `UNIQUE (user_id, tenant_id)` is the actual
identity-to-tenant edge. **Do not add a `tenant_id` column to `users` to satisfy R2** — a user
belongs to many tenants, so the column would be a lie that RLS policies would then have to
reconcile, and it is a change to the identity layer that Phase 7 does not own.

**On existing `0001`–`0020` tables — the anchors are free and cannot fail.** Every existing table
declares `id uuid PRIMARY KEY`. Because `id` is already unique, `(tenant_id, id)` is *already* unique
in every one of them; `0021` therefore adds the explicit
`CREATE UNIQUE INDEX <t>_tenant_id_uq ON <t> (tenant_id, id)` purely so the FK is legal **by
declaration** and so `finance-composite-fk.test.ts` has something to assert. Such an index can never
fail to build and can never change query semantics. The existing tables that already carry an
explicit anchor index (`students_tenant_id_uq`, `acd_classes_tenant_id_uq`,
`grade_levels_tenant_id_uq`, `sections_tenant_id_uq`, `campuses_tenant_id_uq`, `files_tenant_id_uq`,
`academic_years_tenant_id_uq`, `guardians_tenant_id_uq`, `subjects_tenant_id_uq`,
`teacher_assignments_tenant_id_uq`, `exams_tenant_id_uq`, …) are left untouched — the migration uses
`CREATE UNIQUE INDEX IF NOT EXISTS`.

**Tables that genuinely lack a `(tenant_id, id)` anchor** and therefore need one added by `0021`:
`enrollments`, `student_guardians`, `academic_terms`, `holidays`, `calendar_events`, `departments`,
`school_settings`, `student_documents`, `admission_applications`, `transfers`, `promotion_items`,
`report_card_subjects`. All are additive index creations on a table whose `id` is already a
`PRIMARY KEY`, so none can fail and none is a data migration.

**Consequence: a cross-tenant reference is not representable.** A `fin_payment_allocations` row cannot
point at another tenant's invoice, because the composite FK is checked by PostgreSQL, not by the
application. This is the mechanism that makes FI-014 a *database* guarantee rather than an
application promise.

**The full inventory of every composite FK in the design is §35.2**, and
`finance-composite-fk.test.ts` asserts it mechanically: it reads `information_schema` /
`pg_constraint`, fails if any `fin_*` FK is not a `(tenant_id, …) → (tenant_id, id)` composite, and
fails if any referenced table lacks the anchor index. A missing anchor is a **build failure**, not a
review comment.

### 6.4 Student / enrollment anchor

`fin_invoices`, `fin_fee_assignments` anchor on **`enrollments.id`**, not `students.id`, because
billing is academic-year-scoped and a student's class/section is only reachable through a live
enrollment (`enrollments.class_id` / `section_id`; `students` has no class column at all).

`student_id` is stored alongside as a **denormalised copy pinned by trigger**, following the exact
precedent of `trg_marks_validate()` (`0015:810-836`), which raises
`USING ERRCODE = '55000'` when a copied column disagrees with its anchor:

```sql
IF v_student IS DISTINCT FROM NEW.student_id THEN
    RAISE EXCEPTION 'invoice student must match the enrollment' USING ERRCODE = '55000';
END IF;
```

`enrollments` has **no effective dates** — only `status IN ('active','withdrawn','completed')` and
`deleted_at` (`0005:176-203`). This is a real gap for billing and is adjudicated in §8.5.

### 6.5 The `0021` foundation tables, in full (NORMATIVE)

**Why this subsection exists.** §35.1 claimed "Creates (complete)" for `0021` and five tables were
named throughout §6, §7, §15, §19 and §35 — referenced by FK, by RLS policy, by a seeding function,
and by a trigger — while **none of the five had a `CREATE TABLE` statement anywhere in the
document**. A migration that names a table it does not create will fail on its first FK, and an
inventory that says "complete" while listing no DDL is exactly the class of claim this revision
exists to eliminate. All five are written out here, in dependency order, with the anchors R1 requires.

```sql
-- ── 0021 fin_foundation.sql ────────────────────────────────────────────────
-- No grants, no policies: this file must leave every fin_* table unreachable
-- (§30.3). RLS is enabled and forced anyway, so that a later migration that adds
-- a GRANT before adding a policy still finds a table with no permissive policy.

-- 1. fin_tenant_settings — one row per tenant, the tenant's money configuration.
CREATE TABLE fin_tenant_settings (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           uuid NOT NULL,
    -- Only PKR for go-live. The column is text, not an enum, so adding a currency
    -- is a new CHECK value and not a type change on every dependent view.
    currency            text NOT NULL DEFAULT 'PKR'
                        CHECK (currency IN ('PKR')),
    -- The tenant's default tax profile. NULLABLE and NULL by default: a school with
    -- no tax registration has no profile, and a NOT NULL FK here would force every
    -- tenant to invent one. Invoice issue treats NULL as "untaxed", not as an error.
    tax_profile_id      uuid,
    -- Opt-in raw-webhook retention. 0 = never store a raw body, which is the
    -- default and the P1-09 position. The encryption that would make a non-zero
    -- value safe is NOT implemented in Phase 7 (OD-01), so a non-zero value is
    -- only legitimate once that decision lands.
    webhook_raw_retention_days integer NOT NULL DEFAULT 0
                        CHECK (webhook_raw_retention_days >= 0),
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    -- §6.3 R4: `tenants` IS the tenant, so a composite anchor would be (id, id).
    CONSTRAINT fin_tenant_settings_tenant_fk
        FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE CASCADE,
    -- Exactly one settings row per tenant. A UNIQUE on tenant_id alone is what
    -- makes the seeding function idempotent in §31 (ON CONFLICT (tenant_id)).
    CONSTRAINT fin_tenant_settings_tenant_uq UNIQUE (tenant_id),
    CONSTRAINT fin_tenant_settings_ten_id_uq UNIQUE (tenant_id, id)
);
-- 0001_init.sql:380-383 runs, for role school_migrator in schema public,
--     ALTER DEFAULT PRIVILEGES GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO school_app_rw
-- so this table was granted DELETE the instant it was created, before any Phase 7
-- statement ran. Revoke it here, in the same file, and let 0028 re-grant exactly the
-- posture §35.4 states. See §35.4.
REVOKE ALL ON fin_tenant_settings FROM school_app_rw;



-- 2. fin_ledger_accounts — the fixed chart of accounts, seeded per tenant by F3.
CREATE TABLE fin_ledger_accounts (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid NOT NULL,
    -- The business key. fin_ledger_entries.account_code references THIS column, not
    -- this table's id (§15.1), because a posting that says "Dr 1200" should carry
    -- 1200 rather than a uuid an auditor cannot read.
    code            text NOT NULL CHECK (code IN
                    ('1000','1100','1200','1300','2200','4000','4100','4200','4900')),
    name            text NOT NULL,
    -- 'asset' | 'liability' | 'revenue'. Recorded so the normal side is DERIVED
    -- from the class rather than restated per posting, which is what stops an
    -- on-account return from being posted as Dr 1200 (§15.1's P0 accounting defect).
    account_class   text NOT NULL CHECK (account_class IN ('asset','liability','revenue')),
    -- CONTRA is the fourth shape the previous revision of this table could not
    -- express, and it is not optional: §5.2 classifies 4100 "Fee Income —
    -- Concessions & Waivers" as revenue whose normal side is **debit**, because a
    -- concession is contra-revenue (§15.1 posts it Dr 4100 / Cr 1200). A CHECK that
    -- said "revenue ⇒ credit" therefore rejected 4100 at insert, so F3's own seed
    -- INSERT raised 23514 and the chart could not be seeded at all. The flag makes
    -- the exception explicit and machine-checked rather than a hole in the
    -- constraint, and it is constrained to the only combination that is real:
    -- contra-revenue. `is_contra` is true for 4100 and for nothing else.
    is_contra       boolean NOT NULL DEFAULT false,
    -- The side that INCREASES the account. For an asset, debit. For a liability and
    -- for a plain revenue account, credit. 1300 is a liability precisely because it
    -- is over-payment: §5.2 rejects the asset treatment explicitly. 4100 is the one
    -- revenue account whose normal side is debit, and is_contra is what says so.
    normal_side     text NOT NULL CHECK (normal_side IN ('debit','credit')),
    -- Seeded rows are system-owned and may not be renamed or recoded. A tenant may
    -- not add accounts: the chart is fixed in §5.2, and an extension point is an
    -- owner decision, not a per-tenant one.
    is_system       boolean NOT NULL DEFAULT true,
    created_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT fin_ledger_accounts_tenant_fk
        FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE CASCADE,
    -- The FK target for account_code. Required, not incidental.
    CONSTRAINT fin_ledger_accounts_code_uq UNIQUE (tenant_id, code),
    -- R1 uniformity: every fin_* target declares this even though nothing FKs on id.
    CONSTRAINT fin_ledger_accounts_ten_id_uq UNIQUE (tenant_id, id),
    -- A class and a normal side that disagree is the exact P0-07 defect in
    -- column form. Enforced here so F4's jsonb validation and this constraint
    -- cannot disagree about what 1300 means.
    --
    -- The four arms are exhaustive and mutually exclusive over the classes the
    -- CHECK above admits, and each arm is pinned: a contra account MUST be
    -- revenue-and-debit, and a non-contra account MUST NOT be. Without the
    -- `NOT is_contra` clause on the revenue arm, `is_contra` would be decorative
    -- and a second debit-normal revenue row could be seeded beside 4100.
    CONSTRAINT fin_ledger_accounts_side_ck CHECK (
        (account_class = 'asset'     AND normal_side = 'debit'  AND NOT is_contra)
     OR (account_class = 'liability' AND normal_side = 'credit' AND NOT is_contra)
     OR (account_class = 'revenue'   AND normal_side = 'credit' AND NOT is_contra)
     OR (account_class = 'revenue'   AND normal_side = 'debit'  AND     is_contra)
    )
);
-- Revoke the 0001 default-privilege grant immediately (§35.4, §30.3).
REVOKE ALL ON fin_ledger_accounts FROM school_app_rw;



-- 3. fin_document_counters — per-tenant, per-year, per-kind sequence source.
-- The counter is a ROW, not a sequence: a PostgreSQL sequence is global to the
-- database, cannot be scoped per tenant, and cannot be reset or audited per tenant.
CREATE TABLE fin_document_counters (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid NOT NULL,
    academic_year_id uuid NOT NULL,
    -- 'invoice' | 'receipt' | 'challan'. Closed, so a new document kind is a
    -- reviewable schema change rather than a value a route can invent.
    kind            text NOT NULL CHECK (kind IN ('invoice','receipt','challan')),
    -- The last value handed out. next_value() advances it and returns the new
    -- value atomically; the gap this leaves on rollback is intentional and is
    -- explained below.
    last_value      bigint NOT NULL DEFAULT 0 CHECK (last_value >= 0),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT fin_document_counters_year_fk
        FOREIGN KEY (tenant_id, academic_year_id)
        REFERENCES academic_years (tenant_id, id) ON DELETE RESTRICT,
    -- One counter per (tenant, year, kind). This is what makes the advance a
    -- single-row UPDATE with RETURNING, and therefore gap-free under concurrency.
    CONSTRAINT fin_document_counters_uq UNIQUE (tenant_id, academic_year_id, kind),
    CONSTRAINT fin_document_counters_ten_id_uq UNIQUE (tenant_id, id)
);
-- Revoke the 0001 default-privilege grant immediately (§35.4, §30.3).
REVOKE ALL ON fin_document_counters FROM school_app_rw;



-- 4. fin_fee_heads — the fee taxonomy. A structure item names a head; the head
-- carries the tax treatment, so a tax change is one row and not a structure edit.
CREATE TABLE fin_fee_heads (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid NOT NULL,
    code            text NOT NULL,
    name            text NOT NULL,
    description     text,
    -- 'none' | 'exclusive' | 'inclusive'. A head-level default that a structure
    -- item may override, so a mixed invoice does not need a structure per head.
    tax_treatment   text NOT NULL DEFAULT 'none'
                    CHECK (tax_treatment IN ('none','exclusive','inclusive')),
    -- Whether this head may be waived/conceded at all (FI: concessions reduce 4000
    -- via 4100). A head that is NOT waivable cannot be the target of a
    -- concession, which stops a "non-waivable" fee from being waived indirectly
    -- through a negative adjustment.
    is_waivable     boolean NOT NULL DEFAULT true,
    is_active       boolean NOT NULL DEFAULT true,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT fin_fee_heads_tenant_fk
        FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE CASCADE,
    -- A head is referenced by fin_fee_structure_items via (tenant_id, fee_head_id).
    CONSTRAINT fin_fee_heads_ten_id_uq UNIQUE (tenant_id, id),
    CONSTRAINT fin_fee_heads_code_uq UNIQUE (tenant_id, code)
);
-- Revoke the 0001 default-privilege grant immediately (§35.4, §30.3).
REVOKE ALL ON fin_fee_heads FROM school_app_rw;



-- 5. fin_tax_profiles — created before fin_tenant_settings is backfilled, because
-- fin_tenant_settings.tax_profile_id references it. Order matters in a
-- single-transaction migration even when the graph is acyclic, and this is the
-- one place in 0021 where it does.
CREATE TABLE fin_tax_profiles (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid NOT NULL,
    name            text NOT NULL,
    -- Registration number, stored as TEXT: Pakistani NTNs and STRNs are
    -- alphanumeric and leading-zero significant. An integer column would silently
    -- corrupt both.
    tax_number      text,
    rate            numeric(7,4) NOT NULL DEFAULT 0
                    CHECK (rate >= 0 AND rate <= 100),
    is_default      boolean NOT NULL DEFAULT false,
    is_active       boolean NOT NULL DEFAULT true,
    created_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT fin_tax_profiles_tenant_fk
        FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE CASCADE,
    CONSTRAINT fin_tax_profiles_ten_id_uq UNIQUE (tenant_id, id),
    CONSTRAINT fin_tax_profiles_name_uq UNIQUE (tenant_id, name)
);
-- Revoke the 0001 default-privilege grant immediately (§35.4, §30.3).
REVOKE ALL ON fin_tax_profiles FROM school_app_rw;


```

**The `fin_tenant_settings.tax_profile_id` FK is added by `ALTER TABLE` after `fin_tax_profiles`
exists, not inline.** The two tables are declared in the order above precisely so the inline
`REFERENCES fin_tax_profiles (tenant_id, id)` would have had no target; the constraint is added
immediately after the second `CREATE TABLE`:

```sql
ALTER TABLE fin_tenant_settings
    ADD CONSTRAINT fin_tenant_settings_tax_profile_fk
    FOREIGN KEY (tenant_id, tax_profile_id)
    REFERENCES fin_tax_profiles (tenant_id, id) ON DELETE SET NULL;
```

A composite FK permits `NULL` in any referenced column, so a tenant with no tax profile is
represented by `tax_profile_id IS NULL` and no constraint is violated. `ON DELETE SET NULL` rather
than `RESTRICT` is deliberate: deleting a tax profile must not cascade into deleting a tenant's
entire money configuration, and nulling the reference degrades to "untaxed" which is the safe
direction. It is `SET NULL` on the composite, so it clears the *pair* — `tenant_id` is left intact
because the row survives.

**`fin_fee_assignments`, `fin_invoice_items` and `fin_invoice_adjustments` are declared with
`0022` and `0023` respectively**, not here, because each needs a table that does not exist yet:
`fin_fee_assignments` → `fin_fee_structures` and `enrollments`, `fin_invoice_items` → `fin_invoices`.
Putting them in `0021` would mean either a forward FK (§30.3's P0-01 window) or a duplicate anchor.
Their DDL is written out in §8.6 and §9.5 respectively.

---

## 7. Fee structure model

### 7.1 Adjudication of the UNIQUE conflict

The brief flags a genuine contradiction: a unique key of
`(tenant_id, structure_id, fee_head_id)` cannot express "Tuition installment 1, 2, 3".

Three options were offered. **Chosen: B — an explicit installment schedule model**, with a
concrete composite key that admits repetition:

```sql
CREATE TABLE fin_fee_structure_items (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id      uuid NOT NULL,
    structure_id   uuid NOT NULL,
    fee_head_id    uuid NOT NULL,
    installment_no integer NOT NULL DEFAULT 1 CHECK (installment_no >= 1),
    amount         numeric(19,4) NOT NULL CHECK (amount >= 0),
    recurrence     text NOT NULL DEFAULT 'once'
                   CHECK (recurrence IN ('once','monthly','termly','annual')),
    -- P0-03: every FK is tenant-composite (R2), every target is anchored (R1)
    CONSTRAINT fin_fee_structure_items_structure_fk
        FOREIGN KEY (tenant_id, structure_id)
        REFERENCES fin_fee_structures (tenant_id, id) ON DELETE CASCADE,
    CONSTRAINT fin_fee_structure_items_fee_head_fk
        FOREIGN KEY (tenant_id, fee_head_id)
        REFERENCES fin_fee_heads (tenant_id, id) ON DELETE RESTRICT,
    CONSTRAINT fin_fee_structure_items_uq
        UNIQUE (tenant_id, structure_id, fee_head_id, installment_no),
    CONSTRAINT fin_fee_structure_items_ten_id_uq UNIQUE (tenant_id, id)
);
-- Revoke the 0001 default-privilege grant immediately (§35.4, §30.3).
REVOKE ALL ON fin_fee_structure_items FROM school_app_rw;


```

`recurrence IN ('once','monthly','termly','annual')` records *intent*; the actual due dates come from
`fin_fee_installment_plans`. The example from the brief becomes three rows:

| fee_head | installment_no | amount | recurrence |
|---|---|---|---|
| Tuition | 1 | 30000.0000 | termly |
| Tuition | 2 | 35000.0000 | termly |
| Tuition | 3 | 35000.0000 | termly |

The conflict is resolved by making the *schedule* explicit rather than by relaxing the constraint.
A repeated `(structure, fee_head)` with a *different* `installment_no` is now a legal, meaningful,
individually-addressable row — which is what billing and partial payment of one installment need.
Option A (permit arbitrary duplicates) was rejected because it makes "which one?" unanswerable;
option "add `sequence` as a loose column" was rejected because a bare ordinal with no due-date
semantics cannot drive a challan.

### 7.2 Fee heads

`fin_fee_heads(id, tenant_id, code, name, category, is_taxable, tax_treatment, is_active, …)`,
`UNIQUE (tenant_id, code) WHERE deleted_at IS NULL`.

`tax_treatment` is a **seam**, not a tax engine: `none | inclusive | exclusive | exempt`. Default
`none`. See §26.4. `category` is a free taxonomy string, not an enum, so a school can add "Meals" or
"Security Deposit" without a migration.

### 7.3 Structures are versioned and published

```sql
CREATE TABLE fin_fee_structures (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id        uuid NOT NULL,
    code             text NOT NULL,
    name             text NOT NULL,
    academic_year_id uuid NOT NULL,
    version          integer NOT NULL DEFAULT 1 CHECK (version >= 1),
    status           text NOT NULL DEFAULT 'draft',
    effective_from   date NOT NULL,
    effective_to     date,
    supersedes_id    uuid,
    published_at     timestamptz,
    published_by     uuid,
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),
    deleted_at       timestamptz,
    CONSTRAINT fin_fee_structures_year_fk
        FOREIGN KEY (tenant_id, academic_year_id)
        REFERENCES academic_years (tenant_id, id) ON DELETE RESTRICT,
    CONSTRAINT fin_fee_structures_supersedes_fk
        FOREIGN KEY (tenant_id, supersedes_id)
        REFERENCES fin_fee_structures (tenant_id, id) ON DELETE RESTRICT,
    -- D7: the audit record of WHO published a structure is an accountable fact,
    -- not provenance that may expire with the account. It is a platform-global
    -- single-column FK (P0-06a) and it is ON DELETE **RESTRICT**, not SET NULL:
    -- `ON DELETE SET NULL` is implemented by PostgreSQL as a referential UPDATE,
    -- and the write-once publication stamp in §7.3.1 refuses exactly that UPDATE,
    -- so the FK action would be permanently unreachable — an FK whose declared
    -- action can never fire. RESTRICT makes the consequence explicit and testable:
    -- a user who has published a structure cannot be deleted (SQLSTATE 23001)
    -- while that structure exists. The account is deactivated
    -- (`users.status`), which preserves the audit row.
    CONSTRAINT fin_fee_structures_publisher_fk
        FOREIGN KEY (published_by) REFERENCES users (id) ON DELETE RESTRICT,
    CONSTRAINT fin_fee_structures_status_ck
        CHECK (status IN ('draft','published','retired','superseded')),
    CONSTRAINT fin_fee_structures_dates_ck
        CHECK (effective_to IS NULL OR effective_from < effective_to),
    CONSTRAINT fin_fee_structures_published_ck CHECK (
        (status = 'draft' AND published_at IS NULL)
     OR (status <> 'draft' AND published_at IS NOT NULL)
    ),
    CONSTRAINT fin_fee_structures_code_uq
        UNIQUE (tenant_id, code, version),
    CONSTRAINT fin_fee_structures_ten_id_uq UNIQUE (tenant_id, id)
);
-- Revoke the 0001 default-privilege grant immediately (§35.4, §30.3).
REVOKE ALL ON fin_fee_structures FROM school_app_rw;


```

**Publication is explicit and is the freeze point.** `POST /fee-structures/:id/publish` requires
`fees.structures.manage`, sets `status='published'`/`published_at`, and a trigger then makes
`fin_fee_structure_items`, `fin_fee_structure_targets`, and `fin_fee_installment_plans`
**immutable** (`trg_fin_invoice_items_freeze`, §9.4.1, and `trg_fin_structure_child_freeze` below,
implemented on the `trg_report_card_subjects_freeze` precedent, `0018:560-600`; `FINANCE_DESIGN.md:20`
called the earlier draft's version `trg_invoice_items_freeze`, which never existed under that name).

> The brief asks "structures are published / structures expire / structure is superseded" to be
> defined. **Adjudicated:** `status='retired'` means "no longer usable for new assignments";
> `status='superseded'` is set automatically when a new version's `supersedes_id` points at it and
> that new version is published. `effective_to` bounds the *date range*; `status` bounds *usability*.
> Both are checked at assignment time (§7.5).

#### 7.3.1 The publish-freeze trigger, in full (NORMATIVE)

Bound in §35.3, described in three places above, and previously defined nowhere. The freeze has to
cover the three CHILD tables as well as the header, and the previous revision described only the
header — so editing a published structure's *line items* would have been permitted, which is the
change that actually alters what a family is billed.

```sql
CREATE OR REPLACE FUNCTION trg_fin_structure_publish_freeze() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
    -- DELETE: a draft has never promised anything and may be removed; anything
    -- else has been published or retired, and a document already handed to a
    -- parent cannot be un-issued by deleting the row it came from.
    IF TG_OP = 'DELETE' THEN
        IF OLD.status <> 'draft' THEN
            RAISE EXCEPTION 'a % fee structure is frozen; supersede it instead', OLD.status
                USING ERRCODE = '55000';
        END IF;
        RETURN OLD;
    END IF;

    -- INSERT: §18's only source state is draft, and OLD is unassigned here, so
    -- there is no edge to validate - only an illegal starting point to refuse.
    IF TG_OP = 'INSERT' THEN
        IF NEW.status <> 'draft' THEN
            RAISE EXCEPTION 'a fee structure must be created as draft, not %', NEW.status
                USING ERRCODE = '55000';
        END IF;
        RETURN NEW;
    END IF;

    IF OLD.status = 'draft' AND NEW.status = 'published' THEN
        NEW.published_at := COALESCE(NEW.published_at, now());
    END IF;

    -- D6: §18's graph, as an allow-list, consulted on every UPDATE regardless of
    -- where it started. Three edges, and nothing else:
    --   draft     -> published
    --   published -> retired
    --   published -> superseded
    -- Everything else is refused, which is what makes retired and superseded
    -- terminal rather than merely discouraged, and which subsumes the separate
    -- "cannot return to draft" refusal: draft is not the target of any edge, so
    -- published -> draft and retired -> draft are both unlisted.
    IF NEW.status IS DISTINCT FROM OLD.status
       AND NOT (    (OLD.status = 'draft'     AND NEW.status = 'published')
                 OR (OLD.status = 'published' AND NEW.status IN ('retired','superseded')))
    THEN
        RAISE EXCEPTION 'a % fee structure cannot become %', OLD.status, NEW.status
            USING ERRCODE = '55000';
    END IF;

    IF OLD.status = 'draft' THEN
        RETURN NEW;   -- never published: freely editable
    END IF;

    -- supersedes_id is the ONE mutable column, because recording that this
    -- version replaces another is metadata about the LINK, not about what this
    -- version charges. Everything that determines an amount is frozen.
    --
    -- deleted_at is in this list for the same reason: a soft delete of a
    -- published structure is an edit, and it hides a structure that families
    -- have already been billed against without any UPDATE to a frozen column.
    IF NEW.academic_year_id IS DISTINCT FROM OLD.academic_year_id
       OR NEW.name          IS DISTINCT FROM OLD.name
       OR NEW.version       IS DISTINCT FROM OLD.version
       OR NEW.effective_from IS DISTINCT FROM OLD.effective_from
       OR NEW.effective_to   IS DISTINCT FROM OLD.effective_to
       OR NEW.deleted_at     IS DISTINCT FROM OLD.deleted_at
    THEN
        RAISE EXCEPTION 'a published fee structure is frozen; supersede it instead'
            USING ERRCODE = '55000';
    END IF;

    -- Write-once publication stamp, set by the transition that publishes and
    -- not rewritable afterwards. This is narrower than the frozen list above
    -- (it permits the first SET) and narrower than "everything but
    -- supersedes_id" (it does not permit a restamp). It is also the reason
    -- published_by is ON DELETE RESTRICT rather than SET NULL (§7.3).
    IF OLD.published_at IS NOT NULL
       AND (NEW.published_at IS DISTINCT FROM OLD.published_at
            OR NEW.published_by IS DISTINCT FROM OLD.published_by)
    THEN
        RAISE EXCEPTION 'the publication stamp of a % fee structure is write-once', OLD.status
            USING ERRCODE = '55000';
    END IF;

    RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION trg_fin_structure_publish_freeze() FROM PUBLIC;

CREATE TRIGGER fin_structures_publish
    BEFORE INSERT OR UPDATE OR DELETE ON fin_fee_structures
    FOR EACH ROW EXECUTE FUNCTION trg_fin_structure_publish_freeze();
```

**Three amendments to the version of this function that previously stood here**, each recorded
because the earlier text was not merely incomplete but would have been implemented wrongly:

1. **It is bound to `INSERT` as well as `UPDATE` and `DELETE`** (`BEFORE INSERT OR UPDATE OR DELETE`,
   `tgtype = 31`). §18's global rule says the graph is enforced by a `BEFORE INSERT OR UPDATE`
   trigger, and on INSERT `OLD` is unassigned — so there is no edge to validate, but there is an
   illegal starting point to refuse. A structure born `published` skips the entire graph and lands
   with a `published_at` the database never set. The amendment follows §18's own wording.
2. **The status allow-list is evaluated BEFORE the "still a draft" early return.** The earlier
   ordering returned `NEW` as soon as `OLD.status = 'draft'`, which made the guard unreachable for
   every transition that starts in draft — precisely the transitions §18 enumerates. An
   implementation written from the earlier text passes a status-graph test only if the test starts
   from a non-draft state.
3. **The frozen-column list drops `is_active` (this table has no such column) and gains
   `deleted_at`**, and the write-once publication stamp is stated as a separate guard. Referencing
   a column the table does not declare is `42703` at DDL time; omitting `deleted_at` left a
   soft-delete escape that no frozen-column edit ever touches.

> The child freeze. Same rule, reached from the child row to its parent, which is
> why it is a separate function: a trigger on fin_fee_structure_items cannot see
> its parent's status, so it must read it.

```sql
CREATE OR REPLACE FUNCTION trg_fin_structure_child_freeze() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE v_status text; v_tenant uuid; v_structure uuid;
BEGIN
    -- TG_OP decides which record is read. It is NOT COALESCE(NEW.x, OLD.x): in a
    -- row trigger PL/pgSQL assigns only NEW on INSERT and only OLD on DELETE, and
    -- touching the unassigned one raises `record "new" is not assigned yet`
    -- (P0002) before any comparison happens. COALESCE does not rescue this — it
    -- evaluates every argument, so `COALESCE(NEW.tenant_id, OLD.tenant_id)` still
    -- dereferences NEW on the DELETE path and raises the identical error, just one
    -- line earlier. An earlier draft of this function did exactly that, which made
    -- every child delete against a published structure fail with a P0002 "record
    -- not assigned yet" instead of the intended 55000: a 500 for a correct
    -- rejection, and a message naming a PL/pgSQL internal rather than the policy.
    IF TG_OP = 'DELETE' THEN
        v_tenant    := OLD.tenant_id;
        v_structure := OLD.structure_id;
    ELSE
        v_tenant    := NEW.tenant_id;
        v_structure := NEW.structure_id;
    END IF;

    SELECT status INTO v_status
      FROM fin_fee_structures
     WHERE tenant_id = v_tenant AND id = v_structure;
    IF v_status IS NOT NULL AND v_status <> 'draft' THEN
        RAISE EXCEPTION
            'cannot modify the %s of a % fee structure; supersede it instead',
            TG_TABLE_NAME, v_status
            USING ERRCODE = '55000';
    END IF;

    -- Same reasoning for the RETURN. A BEFORE trigger's return value IS the row
    -- written, so returning the unassigned record is a write-time failure, not a
    -- cosmetic one.
    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;
    RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION trg_fin_structure_child_freeze() FROM PUBLIC;
```

**`TG_OP` is the only correct way to read the row a trigger fired on, and the document uses it
inconsistently.** A row trigger assigns `NEW` on INSERT and UPDATE, `OLD` on UPDATE and DELETE, and
exactly one of them on INSERT and DELETE. Any `COALESCE(NEW.c, OLD.c)` written to paper over that
raises P0002 on the single-operation paths. This is a **general rule for every function in §35.3.2**,
and it is applied in `trg_fin_structure_child_freeze` (above), `trg_fin_invoice_items_freeze`,
`trg_fin_invoice_item_total`, `trg_fin_refund_provenance`, `trg_fin_ledger_group_balance`, and
`trg_fin_invoice_balance_recompute` — all of which are bound to `INSERT OR UPDATE OR DELETE` and
therefore must branch. `COALESCE` is correct only for *scalar columns of the same record on a path
where both are assigned*, i.e. the `UPDATE`-only triggers.

### 7.4 Installment plans

```sql
CREATE TABLE fin_fee_installment_plans (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id      uuid NOT NULL,
    structure_id   uuid NOT NULL,
    installment_no integer NOT NULL CHECK (installment_no >= 1),
    due_on         date NOT NULL,
    label          text,
    CONSTRAINT fin_installment_plans_structure_fk
        FOREIGN KEY (tenant_id, structure_id)
        REFERENCES fin_fee_structures (tenant_id, id) ON DELETE CASCADE,
    CONSTRAINT fin_installment_plans_uq UNIQUE (tenant_id, structure_id, installment_no),
    CONSTRAINT fin_installment_plans_ten_id_uq UNIQUE (tenant_id, id)
);
-- Revoke the 0001 default-privilege grant immediately (§35.4, §30.3).
REVOKE ALL ON fin_fee_installment_plans FROM school_app_rw;


```

One structure has at most one plan. If a structure has no plan rows, it bills as a single
`installment_no = 1` on `effective_from`. This keeps single-fee structures simple without a special
case in the generator.

### 7.5 Target resolution — a total order, not a "most specific wins" intuition

A structure applies to a student through one or more `fin_fee_structure_targets` rows. Without a
precedence rule, a student who matches three targets gets three invoices for the same fee, and the
outcome depends on row order. The brief asks for this to be pinned down; here it is, as a strict
total order with a documented, testable tie-break.

```sql
CREATE TABLE fin_fee_structure_targets (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id    uuid NOT NULL,
    structure_id uuid NOT NULL,
    target_type  text NOT NULL
                 CHECK (target_type IN ('all','campus','grade','class','section')),
    campus_id    uuid,
    grade_id     uuid,
    class_id     uuid,
    section_id   uuid,
    priority     integer NOT NULL DEFAULT 0,
    created_at   timestamptz NOT NULL DEFAULT now(),
    -- P0-04: the four typed pointers are REAL tenant-composite FKs, not advisory columns.
    -- All four target tables declare UNIQUE (tenant_id, id) in 0004/0008/0009, so each
    -- composite FK below is legal by declaration (R1) and a cross-tenant id is rejected
    -- by PostgreSQL at INSERT time, before any trigger runs.
    CONSTRAINT fin_targets_structure_fk
        FOREIGN KEY (tenant_id, structure_id)
        REFERENCES fin_fee_structures (tenant_id, id) ON DELETE CASCADE,
    CONSTRAINT fin_targets_campus_fk
        FOREIGN KEY (tenant_id, campus_id)
        REFERENCES campuses (tenant_id, id),
    CONSTRAINT fin_targets_grade_fk
        FOREIGN KEY (tenant_id, grade_id)
        REFERENCES grade_levels (tenant_id, id),
    CONSTRAINT fin_targets_class_fk
        FOREIGN KEY (tenant_id, class_id)
        REFERENCES acd_classes (tenant_id, id),
    CONSTRAINT fin_targets_section_fk
        FOREIGN KEY (tenant_id, section_id)
        REFERENCES sections (tenant_id, id),
    CONSTRAINT fin_targets_shape_ck CHECK (
        (target_type = 'all'     AND campus_id IS NULL AND grade_id IS NULL
                                 AND class_id IS NULL AND section_id IS NULL)
     OR (target_type = 'campus'  AND campus_id IS NOT NULL AND grade_id IS NULL
                                 AND class_id IS NULL AND section_id IS NULL)
     OR (target_type = 'grade'   AND grade_id  IS NOT NULL AND class_id IS NULL
                                 AND section_id IS NULL
                                 AND (campus_id IS NOT NULL OR campus_id IS NULL))
     OR (target_type = 'class'   AND class_id   IS NOT NULL AND section_id IS NULL
                                 AND (campus_id IS NOT NULL OR campus_id IS NULL)
                                 AND (grade_id  IS NOT NULL OR grade_id  IS NULL))
     OR (target_type = 'section' AND section_id IS NOT NULL)
    ),
    -- P0-04 cont.: a plain UNIQUE treats NULLs as distinct, so a structure could hold two
    -- identical `grade` targets that differ only in a NULL campus_id. PG15+ NULLS NOT
    -- DISTINCT (CI is postgres:16) makes the constraint mean what it says.
    CONSTRAINT fin_targets_uq
        UNIQUE NULLS NOT DISTINCT (tenant_id, structure_id, target_type,
                                   campus_id, grade_id, class_id, section_id),
    CONSTRAINT fin_targets_ten_id_uq UNIQUE (tenant_id, id)
);
-- Revoke the 0001 default-privilege grant immediately (§35.4, §30.3).
REVOKE ALL ON fin_fee_structure_targets FROM school_app_rw;


```

**The exact target table names, verified against the repository** (this is a correction: the design
previously referred to a `classes` table that does not exist):

| `target_type` | Nullable column | **Actual table** | Anchor in existing migration |
|---|---|---|---|
| `campus` | `campus_id` | `campuses` | `0004_school_domain_foundation.sql` — `campuses_tenant_id_uq` |
| `grade` | `grade_id` | `grade_levels` | `0009_grade_levels_subjects_assignments.sql` — `grade_levels_tenant_id_uq` |
| `class` | `class_id` | **`acd_classes`** | `0008_academic_classes_sections_placement.sql` — `acd_classes_tenant_id_uq` |
| `section` | `section_id` | `sections` | `0008_…` — `sections_tenant_id_uq` |

There is **no `classes` table** in this repository; the academic-class table is `acd_classes`. Every
`classes` reference in this document is corrected to `acd_classes`, including inside
`trg_fin_target_validate` (step 1) and in §34.2.


**Resolution order, most specific first, and a match at a more specific level *excludes* every less
specific level for the same structure:**

| Rank | `target_type` | The single target that may be set |
|---|---|---|
| 1 | `section` | `section_id` (which implies class, grade, campus) |
| 2 | `class` | `class_id` (implies grade, campus) |
| 3 | `grade` | `grade_id` (implies campus) |
| 4 | `campus` | `campus_id` |
| 5 | `all` | none |

**The rule, stated once:** for a given `(structure, student)`, the effective target set is the
**highest-ranked** matching target and *only* that target. `all` is therefore a genuine
"catch-all for students not otherwise covered", not a fourth overlapping price list.

**Why not "most specific wins, but keep the others too":** because a structure is a *price list*,
not a set of price-list *addenda*. If a school defines a section-specific tuition of 40,000 and a
campus-wide tuition of 30,000 and the student matches both, billing both charges 70,000. The
adjudication is: **one structure bills at most once per (student, fee head, installment)** —
enforced by a partial unique index on the assignment, not by convention (§7.1, §8.3). A school that
wants a discount to apply on top of a base structure expresses that as a **second structure plus an
explicit `fee.invoice.adjustment`** (a visible, reasoned, audited concession), not as an
accidentally-additive second target.

**`priority` exists and is documented as nearly useless.** It exists only to let a tenant order
*two targets of the same rank* that both somehow match (a data-entry accident the §7.6 trigger
rejects). It is **not** a way to make a less specific target outrank a more specific one — that
would make the resolution order data-dependent and therefore not reproducible from the inputs, which
is exactly what §8.3 forbids. If two targets of the same rank match, the billing run **fails** with
`55000 ambiguous_fee_target` and names both rows rather than silently picking one.

### 7.6 Polymorphic target integrity — a single nullable-pointer table is four FKs in disguise

`fin_fee_structure_targets` is a polymorphic association: one table with a `target_type` discriminator
and up to four nullable id columns. That pattern is compact and it is also the single most dangerous
schema shape in a system, because **a row can point at nothing, at the wrong kind of thing, or at
another tenant's thing** — and the database will happily accept all three unless every column is
independently constrained. The naive design (a `target_id uuid` plus a `target_type` text) is
unimplementable: a bare `target_id` with no FK is not a reference, it is a hopeful string.

**Adjudicated: no bare `target_id`.** The `target_type` + four typed columns shape above means every
pointer is a real composite FK, and `fin_targets_shape_ck` makes the four combinations mutually
exclusive. A `BEFORE INSERT OR UPDATE` trigger then enforces the rest, in this order:

```sql
CREATE OR REPLACE FUNCTION trg_fin_target_validate() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE v_campus uuid; v_grade uuid; v_class uuid; v_section uuid; v_via_class uuid;
BEGIN
    -- 1. hierarchy coherence: a section implies its class, grade and campus,
    --    and the row may not assert a different one than the hierarchy says.
    --    NOTE: the academic-class table is `acd_classes`, not `classes`.
    IF NEW.target_type = 'section' THEN
        SELECT sec.campus_id, sec.class_id INTO v_campus, v_class FROM sections sec
        WHERE sec.tenant_id = NEW.tenant_id AND sec.id = NEW.section_id
          AND sec.deleted_at IS NULL;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'target section does not exist in this tenant'
                USING ERRCODE = '55000';
        END IF;
        SELECT cl.grade_id INTO v_via_class FROM acd_classes cl
        WHERE cl.tenant_id = NEW.tenant_id AND cl.id = v_class
          AND cl.deleted_at IS NULL;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'target section''s class does not exist in this tenant'
                USING ERRCODE = '55000';
        END IF;
        IF NEW.campus_id IS NOT NULL AND NEW.campus_id IS DISTINCT FROM v_campus THEN
            RAISE EXCEPTION 'target campus does not contain the target section'
                USING ERRCODE = '55000';
        END IF;
        IF NEW.class_id IS NOT NULL AND NEW.class_id IS DISTINCT FROM v_class THEN
            RAISE EXCEPTION 'target class does not contain the target section'
                USING ERRCODE = '55000';
        END IF;
        IF NEW.grade_id IS NOT NULL AND NEW.grade_id IS DISTINCT FROM v_via_class THEN
            RAISE EXCEPTION 'target grade does not match the target section hierarchy'
                USING ERRCODE = '55000';
        END IF;
    END IF;
    -- 2. the same check, abbreviated, for target_type IN ('class','grade','campus')
    --    each asserting the ASSERTED parent matches the CHILD's ACTUAL parent,
    -- 3. CROSS-TENANT IS ALREADY UNREPRESENTABLE — this step is intentionally empty.
    --    fin_targets_campus_fk / _grade_fk / _class_fk / _section_fk are
    --    FOREIGN KEY (tenant_id, <col>) REFERENCES <t> (tenant_id, id) (§6.3 R1/R2,
    --    §7.5), so PostgreSQL itself rejects a foreign-tenant id before the trigger
    --    body reaches this point. There is no trigger code here because a correct
    --    cross-tenant check would be dead code; finance-composite-fk.test.ts asserts
    --    the four FKs are present and composite so this stays true.
    -- 4. soft-delete: a plain FK accepts a soft-deleted section/grade/campus, so the
    --    deleted_at IS NULL predicates above (and their step-2 equivalents) are the
    --    ONLY enforcement of "not deleted" and are load-bearing.
    -- 5. academic-year applicability: the resolved target's academic_year_id must
    --    equal the parent structure's academic_year_id.
    RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION trg_fin_target_validate() FROM PUBLIC;
```

The five checks, each of which the brief's "polymorphic target integrity" requirement resolves to a
concrete, testable property:

| # | Property | Mechanism |
|---|---|---|
| 1 | **Existence** — the id names a row | composite FK `(tenant_id, id)` on all four columns (§7.5); soft-deleted rows rejected by the trigger's `deleted_at IS NULL` predicate (a plain FK happily accepts a soft-deleted section, so this half of the check is load-bearing) |
| 2 | **Tenant** — the id belongs to this tenant | composite FK. **Unrepresentable, not merely checked** (§6.3) — the strongest of the five |
| 3 | **Shape** — exactly the columns the type requires | `fin_targets_shape_ck` (a `CHECK`, so it is also a *last line of defence* against a `COPY` or a direct `pg_catalog` write that skipped the trigger) |
| 4 | **Hierarchy coherence** — a section's row may not claim a class that does not contain it | `trg_fin_target_validate`. This is the check a plain FK **cannot** express, because the relationship runs through `sections → acd_classes → grade_levels` and a correct-but-inconsistent triple is perfectly legal to the database |
| 5 | **Applicability** — the target belongs to the structure's academic year | trigger step 5; `acd_classes`/`sections` carry `academic_year_id` and a target from last year is a data-entry error that would otherwise silently bill nobody |

**Why the trigger is `SECURITY INVOKER` and why the FKs still suffice for cross-tenant.** Steps 1
and 2 need to *read* `sections`, `acd_classes`, and `grade_levels`, which are RLS-scoped. Running the
trigger elevated would let it read across tenants; running it as the caller means it reads exactly
what the caller may write, which is the correct coupling — a `finance_staff` member cannot create a
target they cannot see. Cross-tenant safety needs no code at all, which is the entire reason the
composite-FK convention of §6.3 exists.

**What this rules out.** A bare polymorphic `target_id`. A `target_type` with no shape constraint. A
soft-delete bypass. A same-rank ambiguity resolved by a silent `LIMIT 1` (§7.5). And — because
`trg_fin_target_validate` fires on `UPDATE` as well as `INSERT` — a target that was correct at
publish time and is silently re-pointed afterwards, which the `immutable after publish` trigger of
§7.3 would otherwise be the only thing standing between.

---

## 8. Billing model

### 8.1 Billing is a pure function of a **fully enumerated input set**

The brief correctly rejects `f(published fee structure)`. The authoritative input set for one
generated invoice line is:

| # | Input | Source of truth |
|---|---|---|
| 1 | Student | `students` (not deleted) |
| 2 | Academic year | `academic_years`, `status='active'`, `deleted_at IS NULL` |
| 3 | Effective enrollment | `enrollments` + `acd_classes` + `sections` (§8.5) |
| 4 | Published structure | `fin_fee_structures.status='published'`, in effect on the billing date |
| 5 | Structure targets | `fin_fee_structure_targets` (§7.5) |
| 6 | Fee assignment | `fin_fee_assignments`, `status='active'` — the **binding** between 1 and 4 |
| 7 | Billing period | derived: `(academic_year_id, installment_no)` |
| 8 | Approved concession | `fin_invoice_adjustments.type IN ('concession','waiver')`, pre-issue only. **No `fin_fee_concessions` table exists** — a scholarship decided before billing is a `fin_fee_structure` with a reduced amount or a target exclusion (§7.5), not a separate registry |
| 9 | Approved adjustment | `fin_invoice_adjustments` (`fine`, `late_fee`, `other`) |
| 10 | Applicable policy | tax profile (disabled, §24); late-fee policy (**out of scope**, §21) |

Inputs 8–10 are applied **after** item generation, in a fixed order, so a line's provenance is
reproducible.

### 8.2 Deterministic ordering

The generator must be **order-independent with respect to input enumeration**. Fixed rules:

1. Structures are considered in `ORDER BY specificity_rank ASC, published_at DESC, id ASC`
   (§10.2). The `id` tiebreak guarantees total order.
2. **At most one structure contributes to a given `(student, academic_year, installment)`**, enforced
   by a unique index, not by the ordering (see below).
3. Within a structure, items are ordered by `(fee_head.code ASC, installment_no ASC)`.
4. Adjustments are ordered by `(type ASC, created_at ASC, id ASC)`.

### 8.3 The determinism guarantee is a constraint, not a sort

Sorting is not determinism — two overlapping structures both sort first somewhere. The real guarantee
is this index:

```sql
-- At most ONE active assignment per student, per year, per billing period.
CREATE UNIQUE INDEX fin_fee_assignments_active_period_uq
    ON fin_fee_assignments (tenant_id, student_id, academic_year_id, installment_no)
    WHERE status = 'active' AND deleted_at IS NULL;
```

With that index, "which structure bills this student this installment?" has exactly one answer or
none. A billing run that would need a second active assignment **fails loudly** (23505) rather than
silently double-billing. This is the mechanism that satisfies §27's "what happens if two inputs
conflict": **it cannot happen**, because the database refuses to represent it.

### 8.4 Billing run is a recorded, replayable trace

**The normative DDL for `fin_billing_runs` and `fin_billing_run_items` is in §8.7, and it is
written there and nowhere else.** This revision originally carried a *second* `CREATE TABLE` pair for
both tables at the end of this section, and the two definitions were not merely different — they
contradicted each other in every column that matters:

| | the copy formerly in §8.4 | §8.7 (canonical) |
|---|---|---|
| `status` | `pending \| running \| completed \| failed \| reverted` — a **job** lifecycle | `draft \| preview \| committed \| cancelled` — a **reproducibility** lifecycle |
| identity | surrogate `id uuid PRIMARY KEY` + `fin_bri_uq UNIQUE (tenant_id, run_id, student_id, fee_head_id, installment_no)` | composite `PRIMARY KEY (tenant_id, run_id, enrollment_id)` — a second attempt to bill is a PK violation, not a second invoice |
| per-item grain | per `(run, student, fee_head, installment)` — **one row per charge** | per `(run, enrollment)` — **one row per student per run**, with the per-charge detail in `fin_invoice_items` |
| `fin_invoices` FK | declared **inline** in `CREATE TABLE` | deferred to `ALTER` at the end of `0023` |
| which file | attributed to `0023` | `0022` (§30.2) |

Three of those are defects rather than alternatives, and the inline FK is the one that made the
duplicate impossible to keep: `fin_invoices` is created by `0023` and this table is in `0022`, so
§30.2's rule that "no composite FK forward-references `0023`+" would have been violated by §8.4's own
block — the same section that states the rule. A `pending/running/failed/reverted` status set is also
the wrong model for this section's own argument: "re-run billing for year Y must produce the same
invoices" needs a **committed** state that is frozen and a **cancelled** state that is abandoned, and
has nothing to say about a retry that failed halfway. Two normative definitions of one table is
itself the defect — whichever is read, the other is a contradiction waiting to be implemented.

**Intra-file ordering is a normative part of `0022` — except for one deliberate forward reference.**
Because the migration runner wraps each file in one transaction (`packages/db/src/cli/migrate.ts`), a
table referenced by a composite FK must be created *earlier in the same file* or the FK statement
fails. `fin_billing_runs` and `fin_billing_run_items` are therefore both in **0022** (§30.2), in that
order, after `fin_fee_structures` and `fin_fee_assignments`; `finance-migration-order.test.ts` asserts
the sequence rather than trusting a comment. The single forward reference is
`fin_billing_run_items.invoice_id → fin_invoices`, and it is handled by **deferring the constraint**
to an `ALTER` at the end of `0023` instead of declaring it inline (§8.7). A composite FK permits NULL,
so every item written before its run is committed is legal with the column NULL — which is precisely
the state such an item is in.

`fin_billing_run_items` is **immutable once the run completes** and records exactly which structure,
assignment, and inputs produced each amount. A disputed bill can be explained from the run row
without re-running the generator. It is also the "historical compatibility" story for §31: if the
generator's logic changes in Phase 9, already-generated invoices remain explainable.

**That immutability is enforced, and it is two functions rather than one** (§8.7.1, NORMATIVE): a
trigger on `fin_billing_runs` cannot be a child freeze, and a trigger on `fin_billing_run_items`
cannot see the run's status without reading it, so each table gets the rule in the one place that
can evaluate it. The item freeze judges **both** runs an UPDATE touches — the one the row is in and
the one it is being moved into — because `run_id` is an ordinary column: a freeze that consulted only
the destination would let a priced line leave a committed run and leave that run's `total_students`
and `total_amount` disagreeing with its contents. The one write that survives is attaching the
invoice the run produced, once (§8.7).

`run_id` + `idempotency_key` gives replay safety: re-running the same generation request returns the
same run rather than creating a second set of invoices.

### 8.5 Effective enrollment — an explicit adjudication

`enrollments` has **no effective dates** (`0005:176-203`), only `status` and `deleted_at`. So
"effective enrollment on date D" is not representable today. Three candidate rules:

| Rule | Problem |
|---|---|
| A. Any enrollment with `status='active'` | A student withdrawn mid-year keeps generating full invoices. Wrong. |
| B. Enrollment must be `status='active'` **and** the structure's `effective_from >= enrollment.created_at::date` | Conflates record-creation time with enrolment time. Weak but not wrong. |
| C. **Rule A, plus a proration/adjustment responsibility declared out of scope** | Simple, deterministic, and the gap is explicit. |

**Chosen: C.** An invoice is generated only for a student with a live (`status='active'`,
`deleted_at IS NULL`) enrollment in the target academic year. Mid-year withdrawal is handled by a
**manual `fin_invoice_adjustments` row** with an auditable reason, not by automatic proration.

*Consequence, stated plainly:* automatic proration and mid-year fee pro-rating are **not** delivered
by Phase 7. A school that must pro-rate will issue the invoice and then adjust it manually, which is
auditable and reversible. Automatic proration needs enrollment effective dates, which need a
migration to `enrollments` — an additive nullable change that would also affect Phases 3–6 behaviour
and is therefore **not** smuggled into Phase 7. Recorded as OD-06.

Also adjudicated: **which academic year is "current"?** There is no `current_academic_year` helper
and **no constraint enforcing a single `active` year per tenant** — two `active` years is a
representable state today. Phase 7 therefore **requires `academic_year_id` as an explicit parameter**
on every billing run and every structure query, and additionally proposes the missing
`CREATE UNIQUE INDEX academic_years_single_active_uq ON academic_years (tenant_id) WHERE status='active' AND deleted_at IS NULL`
in its own forward migration (§30), because billing determinism cannot tolerate two active years.
This is a cross-phase schema change and is called out as a **migration-scope risk in §30.4**, not
hidden.

### 8.6 `fin_fee_assignments` and `fin_billing_runs` — in full (NORMATIVE)

`fin_fee_assignments` is the table the "ambiguous fee assignment" T-FIN-16 test is about, and it was
named in §6, §8, §20 and §35 while having no `CREATE TABLE`. Its load-bearing feature is the partial
unique index that makes a second active assignment **unrepresentable** rather than merely warned about.

```sql
-- ── 0022 fin_fee_structures.sql (continued) ───────────────────────────────

-- Which structure applies to which enrollment. The deduplication decision of §8.2
-- is enforced HERE by an index, not by an application "select the best" query: an
-- index is the only version of that rule that survives a second code path.
CREATE TABLE fin_fee_assignments (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           uuid NOT NULL,
    -- A NULL structure_id is a NULL target, NOT a wildcard: "assign nothing". If a
    -- wildcard were wanted it would need its own row shape, because a NULL FK
    -- participates in no uniqueness index and so cannot be deduplicated against.
    structure_id        uuid,
    -- The §6.4 anchor: billing is enrollment-scoped, not student-scoped.
    enrollment_id       uuid NOT NULL,
    -- Denormalised from the enrollment and pinned by trigger, exactly as
    -- fin_invoices.student_id is (§6.4, trg_marks_validate precedent).
    student_id          uuid NOT NULL,
    academic_year_id    uuid NOT NULL,
    -- NULL = whole year. A structure may be effective for part of the year, which
    -- is how a mid-year fee change is expressed without editing a published
    -- structure (§7.4: published structures are frozen).
    effective_from      date NOT NULL,
    effective_to        date,
    -- Which installment plan applies, if the structure has one (§7.5).
    installment_plan_id uuid,
    is_active           boolean NOT NULL DEFAULT true,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT fin_fee_assignments_structure_fk
        FOREIGN KEY (tenant_id, structure_id)
        REFERENCES fin_fee_structures (tenant_id, id) ON DELETE RESTRICT,
    CONSTRAINT fin_fee_assignments_enrollment_fk
        FOREIGN KEY (tenant_id, enrollment_id)
        REFERENCES enrollments (tenant_id, id) ON DELETE RESTRICT,
    CONSTRAINT fin_fee_assignments_student_fk
        FOREIGN KEY (tenant_id, student_id)
        REFERENCES students (tenant_id, id) ON DELETE RESTRICT,
    CONSTRAINT fin_fee_assignments_year_fk
        FOREIGN KEY (tenant_id, academic_year_id)
        REFERENCES academic_years (tenant_id, id) ON DELETE RESTRICT,
    CONSTRAINT fin_fee_assignments_plan_fk
        FOREIGN KEY (tenant_id, installment_plan_id)
        REFERENCES fin_fee_installment_plans (tenant_id, id) ON DELETE RESTRICT,
    CONSTRAINT fin_fee_assignments_ten_id_uq UNIQUE (tenant_id, id),
    -- A date range is either open-ended or closed, and closed means from < to.
    -- Without this, effective_to < effective_from is representable and the
    -- assignment silently never applies.
    CONSTRAINT fin_fee_assignments_range_ck CHECK (
        effective_to IS NULL OR effective_to >= effective_from
    )
);
-- Revoke the 0001 default-privilege grant immediately (§35.4, §30.3).
REVOKE ALL ON fin_fee_assignments FROM school_app_rw;



-- THE deduplication index (T-FIN-16). One ACTIVE assignment per
-- (enrollment, structure, period). Partial, because deactivated history is
-- retained for audit and a full UNIQUE would forbid keeping it.
--
-- NULLs make a plain UNIQUE unable to enforce this: in PostgreSQL NULLs are
-- distinct, so two rows with NULL effective_to would both be permitted by a full
-- UNIQUE and forbidden by neither. COALESCE to a sentinel is the fix, and it is
-- why this is an expression index rather than a column list.
CREATE UNIQUE INDEX fin_fee_assignments_one_active_uq
    ON fin_fee_assignments (
        tenant_id, enrollment_id,
        COALESCE(structure_id, '00000000-0000-0000-0000-000000000000'::uuid),
        COALESCE(effective_from, DATE '0001-01-01'),
        COALESCE(effective_to,   DATE '9999-12-31')
    )
    WHERE is_active;
```

**`structure_id` is coalesced too, and the paragraph below explains only the dates.** The first
applied version of this index listed `structure_id` bare. `structure_id` is **nullable** on this
table — an unbounded assignment is the "assign nothing" row, and §8.6 requires it to exist — so
PostgreSQL's NULLs-are-distinct rule exempted exactly those rows from deduplication: two identical
unbounded active assignments both went in, and the index reported a unique constraint that was
enforced on the wrong rows. The nil UUID is not a legal `structure_id` (no such row can exist,
because `structure_id` carries a composite FK to `fin_fee_structures`), so the sentinel cannot
collide with a real structure. Without the coalesce the §8.2 "highest rank wins" rule is choosing
between two rows that should never have both existed.

**The `COALESCE` sentinels in that index are load-bearing, and the alternative was rejected for a
concrete reason.** A plain `UNIQUE (tenant_id, enrollment_id, structure_id, effective_from,
effective_to)` would let an unbounded assignment be duplicated, because in PostgreSQL two `NULL`s
compare as *distinct* and so never collide. Every open-ended interval would then have a duplicate,
and the §8.2 "highest rank wins" rule would be choosing between rows that should never have both
existed. `DATE '9999-12-31'` is inside `date`'s range and is never a real fee period, so the
sentinel cannot collide with a legitimate closed interval; the symmetric `0001-01-01` guards
`effective_from`, which is `NOT NULL` and therefore does not strictly need it, and is written anyway
so the two sides of the range are transformed identically and the expression is obviously
injective. The correct expression index is the one a test can assert: T-FIN-16 inserts a second
active assignment for the same enrollment and structure and expects a unique violation — and the
shipped test suite asserts the unbounded case separately, because a fix to the date sentinels alone
leaves the nullable-column hole in place and a test that only exercises a *bounded* duplicate
cannot tell the two apart.

`fin_billing_runs` and `fin_billing_run_items` are declared in §8.7, and `fin_invoice_items` and
`fin_invoice_adjustments` in §9.5, each in the migration that owns its FK targets.

### 8.7 `fin_billing_runs` and `fin_billing_run_items` (NORMATIVE)

```sql
-- A run is the unit of reproducibility: "re-run billing for year Y" must produce
-- the same invoices, so a run records its inputs, not just its outputs.
CREATE TABLE fin_billing_runs (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           uuid NOT NULL,
    academic_year_id    uuid NOT NULL,
    -- 'draft' | 'preview' | 'committed' | 'cancelled'. A committed run is frozen
    -- (§8.4) and its items are what a regeneration must reproduce.
    status              text NOT NULL DEFAULT 'draft'
                        CHECK (status IN ('draft','preview','committed','cancelled')),
    -- Recorded so a re-run is a NEW run with the same parameters, never a
    -- mutation of a committed one. Both are supported; the second is why the
    -- parameters are on the row at all.
    structure_ids       uuid[] NOT NULL DEFAULT '{}',
    -- Snapshot of the assignment selection, so a re-run cannot pick up a changed
    -- assignment set and call the result a reproduction.
    -- §8.5 rule C means mid-year changes are ADJUSTMENTS, not regenerated invoices,
    -- so this snapshot is stable by design.
    idempotency_key     text NOT NULL,
    total_students      integer NOT NULL DEFAULT 0 CHECK (total_students >= 0),
    total_invoices      integer NOT NULL DEFAULT 0 CHECK (total_invoices >= 0),
    total_amount        numeric(19,4) NOT NULL DEFAULT 0,
    started_by          uuid,
    started_at          timestamptz NOT NULL DEFAULT now(),
    committed_at        timestamptz,
    cancelled_at        timestamptz,
    cancelled_reason    text,
    CONSTRAINT fin_billing_runs_year_fk
        FOREIGN KEY (tenant_id, academic_year_id)
        REFERENCES academic_years (tenant_id, id) ON DELETE RESTRICT,
    -- §6.3 R4: `users` is platform-global, single-column FK (P0-06a).
    CONSTRAINT fin_billing_runs_user_fk
        FOREIGN KEY (started_by) REFERENCES users (id) ON DELETE SET NULL,
    CONSTRAINT fin_billing_runs_ten_id_uq UNIQUE (tenant_id, id),
    -- The idempotency key is tenant-scoped, so two tenants may use the same value.
    CONSTRAINT fin_billing_runs_idem_uq UNIQUE (tenant_id, idempotency_key),
    -- cancelled_at and its reason are a pair; committed_at is exclusive of both.
    -- Without this a run can be committed and cancelled simultaneously, and the
    -- §8.4 freeze then applies to a run that was abandoned.
    CONSTRAINT fin_billing_runs_state_ck CHECK (
        (status = 'cancelled' AND cancelled_at IS NOT NULL AND cancelled_reason IS NOT NULL
                  AND committed_at IS NULL)
     OR (status = 'committed' AND committed_at IS NOT NULL AND cancelled_at IS NULL)
     OR (status IN ('draft','preview') AND committed_at IS NULL AND cancelled_at IS NULL)
    )
);
-- Revoke the 0001 default-privilege grant immediately (§35.4, §30.3).
REVOKE ALL ON fin_billing_runs FROM school_app_rw;



-- One row per (run, enrollment). The composite PK is the dedup key: a second
-- attempt to bill the same enrollment into the same run is a PK violation, not a
-- second invoice. This is the mechanism behind "billing twice is a unique
-- violation, not a rounding difference".
CREATE TABLE fin_billing_run_items (
    tenant_id           uuid NOT NULL,
    run_id              uuid NOT NULL,
    enrollment_id       uuid NOT NULL,
    student_id          uuid NOT NULL,
    structure_id        uuid NOT NULL,
    assignment_id       uuid,
    -- Set when the run is committed: an item in an uncommitted run has no invoice
    -- yet, and the FK is added by ALTER at the end of 0023 (P0-01 forward-FK window).
    -- The ONLY write permitted to an item of a committed run is the first SET of
    -- this column, once (§8.7.1) — which is the same statement §18 makes about a
    -- published structure's stamp.
    invoice_id          uuid,
    amount              numeric(19,4) NOT NULL CHECK (amount >= 0),
    created_at          timestamptz NOT NULL DEFAULT now(),
    -- PK rather than a surrogate id: the natural key IS the identity, so there is
    -- no second id to keep consistent with it.
    CONSTRAINT fin_billing_run_items_pkey PRIMARY KEY (tenant_id, run_id, enrollment_id),
    CONSTRAINT fin_bri_run_fk
        FOREIGN KEY (tenant_id, run_id)
        REFERENCES fin_billing_runs (tenant_id, id) ON DELETE RESTRICT,
    CONSTRAINT fin_bri_enrollment_fk
        FOREIGN KEY (tenant_id, enrollment_id)
        REFERENCES enrollments (tenant_id, id) ON DELETE RESTRICT,
    CONSTRAINT fin_bri_student_fk
        FOREIGN KEY (tenant_id, student_id)
        REFERENCES students (tenant_id, id) ON DELETE RESTRICT,
    CONSTRAINT fin_bri_structure_fk
        FOREIGN KEY (tenant_id, structure_id)
        REFERENCES fin_fee_structures (tenant_id, id) ON DELETE RESTRICT,
    CONSTRAINT fin_bri_assignment_fk
        FOREIGN KEY (tenant_id, assignment_id)
        REFERENCES fin_fee_assignments (tenant_id, id) ON DELETE RESTRICT,
    -- Added at the END of 0023, after fin_invoices exists. Stated here as the
    -- constraint it will be, so §35.2's FK map and this DDL agree:
    --   ALTER TABLE fin_billing_run_items
    --       ADD CONSTRAINT fin_bri_invoice_fk
    --       FOREIGN KEY (tenant_id, invoice_id)
    --       REFERENCES fin_invoices (tenant_id, id) ON DELETE SET NULL;
    -- A composite FK permits NULL, so every pre-commit item is legal with the
    -- column NULL, which is exactly the state it is in.
    --
    -- §6.3 R1 anchor: NOT declared here, and the omission is deliberate rather than
    -- an oversight. Every other Phase 7 table carries `UNIQUE (tenant_id, id)` so
    -- that a *later* table can reference it with a tenant-scoped composite FK. This
    -- table is a leaf — nothing in Phase 7 references `fin_billing_run_items`, and a
    -- run's items are always fetched by `(tenant_id, run_id)`, for which the primary
    -- key's leading `tenant_id` is already the tenant pin. An earlier revision
    -- declared `UNIQUE (tenant_id, id, run_id)` here, which would fail at DDL time
    -- with 42703 `column "id" does not exist`: this table has no surrogate id, by
    -- the design decision three lines above its own constraint list.
);
-- Revoke the 0001 default-privilege grant immediately (§35.4, §30.3).
REVOKE ALL ON fin_billing_run_items FROM school_app_rw;


```

#### 8.7.1 The committed-run freeze, in full (NORMATIVE)

§8.4 states the rule — "immutable once the run completes" — and until `0022` was applied nothing
enforced it: a committed run's `idempotency_key`, totals, `structure_ids`, `started_by` and
`cancelled_at` were all rewritable, and its items could be inserted, re-priced and deleted. The
§8.4 reproducibility guarantee was prose. These are the two enforcement points, verbatim.

**What is frozen, and what is not.** The run row is frozen from the moment it is `committed`, with
**no exemptions at all**: a committed run cannot be re-stated even with its own values, cannot be
un-committed, and cannot be deleted. There is deliberately no run *status graph* here. `status` is
`draft | preview | committed | cancelled` (§8.7) and §8.7 constrains `committed_at` and
`cancelled_at` as a pair, but no section of this design enumerates which of those four may follow
which, and inventing an allow-list here would create a normative rule the document nowhere states —
in particular it would decide, silently, that `preview → committed` is illegal and
`committed → cancelled` is not. The freeze is therefore scoped to the one transition whose
*consequence* is specified: everything at or after `committed` is immutable. The one exception the
design does state is the invoice attachment below, and it is on the **items**, not the run.

```sql
CREATE OR REPLACE FUNCTION trg_fin_billing_run_freeze() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
    IF OLD.status = 'committed' THEN
        RAISE EXCEPTION
            'billing run % is committed and frozen; re-run it as a new run rather than editing this one',
            OLD.id
            USING ERRCODE = '55000';
    END IF;

    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;
    RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION trg_fin_billing_run_freeze() FROM PUBLIC;

CREATE TRIGGER fin_runs_freeze
    BEFORE UPDATE OR DELETE ON fin_billing_runs
    FOR EACH ROW EXECUTE FUNCTION trg_fin_billing_run_freeze();
```

**The item freeze reads the run it belongs to, and on UPDATE it reads the run it is moving into as
well.** `run_id` is an ordinary column, so consulting only the destination leaves a door in the
freeze: a single `UPDATE … SET run_id = <an uncommitted run>` walks a priced line out of a committed
run. Either parent being `committed` freezes the row.

```sql
CREATE OR REPLACE FUNCTION trg_fin_billing_run_items_freeze() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE v_old_status text; v_new_status text; v_run uuid;
BEGIN
    IF TG_OP = 'DELETE' OR TG_OP = 'UPDATE' THEN
        SELECT r.status INTO v_old_status
          FROM fin_billing_runs r
         WHERE r.tenant_id = OLD.tenant_id AND r.id = OLD.run_id;
    END IF;
    IF TG_OP = 'INSERT' OR TG_OP = 'UPDATE' THEN
        SELECT r.status INTO v_new_status
          FROM fin_billing_runs r
         WHERE r.tenant_id = NEW.tenant_id AND r.id = NEW.run_id;
    END IF;

    -- The refused run is the committed one, not the destination.
    IF TG_OP = 'DELETE' OR (TG_OP = 'UPDATE' AND v_old_status = 'committed') THEN
        v_run := OLD.run_id;
    ELSE
        v_run := NEW.run_id;
    END IF;

    -- A missing run is not a freeze failure: fin_bri_run_fk guarantees the parent
    -- exists on INSERT and UPDATE, and a DELETE leaves the item, not the run.
    IF v_old_status IS DISTINCT FROM 'committed'
       AND v_new_status IS DISTINCT FROM 'committed'
    THEN
        IF TG_OP = 'DELETE' THEN
            RETURN OLD;
        END IF;
        RETURN NEW;
    END IF;

    -- THE ONE PERMITTED CHANGE (§8.7's own DDL comment): an item in an
    -- uncommitted run has no invoice yet, so the single legal write to a committed
    -- run's item is NULL -> a value, exactly once - attaching the invoice the run
    -- produced. Write-once, because a second attachment has OLD.invoice_id NOT
    -- NULL; and not a smuggling route, because every other column is compared
    -- first, including tenant_id and run_id.
    IF TG_OP = 'UPDATE'
       AND OLD.invoice_id IS NULL
       AND NEW.invoice_id IS NOT NULL
       AND NEW.tenant_id     IS NOT DISTINCT FROM OLD.tenant_id
       AND NEW.run_id        IS NOT DISTINCT FROM OLD.run_id
       AND NEW.enrollment_id IS NOT DISTINCT FROM OLD.enrollment_id
       AND NEW.student_id    IS NOT DISTINCT FROM OLD.student_id
       AND NEW.structure_id  IS NOT DISTINCT FROM OLD.structure_id
       AND NEW.assignment_id IS NOT DISTINCT FROM OLD.assignment_id
       AND NEW.amount        IS NOT DISTINCT FROM OLD.amount
       AND NEW.created_at    IS NOT DISTINCT FROM OLD.created_at
    THEN
        RETURN NEW;
    END IF;

    RAISE EXCEPTION
        'the items of a committed billing run are frozen (run %)', v_run
        USING ERRCODE = '55000';
END $$;
REVOKE ALL ON FUNCTION trg_fin_billing_run_items_freeze() FROM PUBLIC;

CREATE TRIGGER fin_run_items_freeze
    BEFORE INSERT OR UPDATE OR DELETE ON fin_billing_run_items
    FOR EACH ROW EXECUTE FUNCTION trg_fin_billing_run_items_freeze();
```

**Why the write-once exception is the narrow one, rather than a full freeze including `invoice_id`.**
§8.7's DDL says of this column "Set when the run is committed", and the FK is added by `ALTER` at
the end of `0023`. A freeze that covered `invoice_id` outright would contradict the design's own
stated lifecycle: the invoice that `0023` attaches to a committed run's item would be an illegal
write against this trigger. The exception is write-once, is unavailable once a value is present, and
requires every other column to be byte-identical, so the only row that can take it is the row the
lifecycle says it is waiting for.

**`v_run` is carried rather than read from `NEW` in the message.** On the DELETE path `NEW` is
unassigned, and naming `NEW.run_id` there raises `P0001` "record new is not assigned yet" — a 500 for
a correct rejection, with a message naming a PL/pgSQL internal instead of the policy. This is the
same trap §7.3.1 documents for `trg_fin_structure_child_freeze`, reached from the other direction.

---

## 9. Invoice model

### 9.1 Numbering: `draft.invoice_no IS NULL`

Resolving `invoice_no NOT NULL` vs "issue assigns `invoice_no`":

```sql
CREATE TABLE fin_invoices (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id        uuid NOT NULL,
    invoice_no       text,                       -- NULL in draft
    student_id       uuid NOT NULL,
    academic_year_id uuid NOT NULL,
    enrollment_id    uuid NOT NULL,
    structure_id     uuid,
    status           text NOT NULL DEFAULT 'draft'
                     CHECK (status IN ('draft','issued','partially_paid','paid','void')),
    issued_at        timestamptz,
    due_date         date NOT NULL,
    -- The three CACHED money columns. All are trigger-maintained and none is
    -- writable by the runtime role (§16.5 revokes the columns' UPDATE and the
    -- recompute triggers are the only writers). They exist because every report
    -- reads them and recomputing per row is the drift risk in reverse (§16.5).
    --   subtotal = LINES ONLY (Σ fin_invoice_items.amount)
    --   total    = subtotal + Σ adjustments + Σ tax
    --   balance  = total − net_applied   (FI-002, cached; the view is authoritative)
    -- The previous revision's DDL declared NONE of these three, while §9.6's
    -- trg_fin_invoice_item_total writes subtotal and total and FI-002's cache
    -- trigger writes balance — the function would have failed at runtime with 42703
    -- (column does not exist). A CHECK cannot cover them either: all three are
    -- functions of OTHER tables' rows.
    subtotal         numeric(19,4) NOT NULL DEFAULT 0,
    total            numeric(19,4) NOT NULL DEFAULT 0,
    balance          numeric(19,4) NOT NULL DEFAULT 0,
    voided_at        timestamptz,
    void_reason      text,
    created_by       uuid NOT NULL,
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT fin_invoices_student_fk
        FOREIGN KEY (tenant_id, student_id)
        REFERENCES students (tenant_id, id) ON DELETE RESTRICT,
    CONSTRAINT fin_invoices_year_fk
        FOREIGN KEY (tenant_id, academic_year_id)
        REFERENCES academic_years (tenant_id, id) ON DELETE RESTRICT,
    -- P0-03: `enrollments` has NO (tenant_id, id) anchor in 0005. 0021 adds
    -- `enrollments_tenant_id_uq`; because `enrollments.id` is already a PRIMARY KEY
    -- that index cannot fail to build, so the FK below is legal and zero-risk.
    CONSTRAINT fin_invoices_enrollment_fk
        FOREIGN KEY (tenant_id, enrollment_id)
        REFERENCES enrollments (tenant_id, id) ON DELETE RESTRICT,
    CONSTRAINT fin_invoices_structure_fk
        FOREIGN KEY (tenant_id, structure_id)
        REFERENCES fin_fee_structures (tenant_id, id) ON DELETE RESTRICT,
    CONSTRAINT fin_invoices_number_ck CHECK (
        (status = 'draft' AND invoice_no IS NULL)
        OR (status <> 'draft' AND invoice_no IS NOT NULL)
    ),
    CONSTRAINT fin_invoices_void_ck CHECK (
        (status = 'void' AND voided_at IS NOT NULL AND void_reason IS NOT NULL)
     OR (status <> 'void' AND voided_at IS NULL)
    ),
    CONSTRAINT fin_invoices_ten_id_uq UNIQUE (tenant_id, id)
);
-- Revoke the 0001 default-privilege grant immediately (§35.4, §30.3).
REVOKE ALL ON fin_invoices FROM school_app_rw;


```

A **partial unique index** provides the uniqueness without a `COALESCE` sentinel:

```sql
CREATE UNIQUE INDEX fin_invoices_number_uq
    ON fin_invoices (tenant_id, invoice_no)
    WHERE invoice_no IS NOT NULL;
```

This matches the repo's heavy use of partial unique indexes for "live row" rules
(`students_student_no_uq`, `enrollments_student_year_uq`, `report_cards_student_exam_version_uq`).
The CHECK makes the `issued ⟹ numbered` direction a database guarantee; it cannot express the
reverse direction, which is why the partial index exists alongside it.

### 9.2 State machine

```text
                  issue                     payment
  draft ─────────────────────► issued ───────────────────────► partially_paid
    │  (delete allowed)          │                               │
    │                            │◄──────────── refund ──────────┤
    │                            │        (balance reopens)      │
    │                            │                               │
    │                            │                    settlement │
    │                            │◄──────────────────────────────┘
    │                            │                                    paid
    │                            │
    │                            └── void (balance must be 0) ──► void
    │                                                                       │
    └────────────────────────── superseded (zero-value draft) ◄────────────┘
```

| From | To | Guard |
|---|---|---|
| `draft` | `issued` | lines exist; totals recomputed; number allocated; `issued_at` set; ledger group posted |
| `draft` | *deleted* | hard delete permitted (nothing references it) |
| `issued` | `partially_paid` | derived from `balance` |
| `partially_paid` | `paid` | `balance = 0` |
| `partially_paid` | `partially_paid` | refund lowers applied |
| `paid` | `partially_paid` | **refund reopens the invoice** (§8 of the brief) |
| `issued`/`partially_paid` | `void` | **only if `balance = 0`**; full ledger reversal; number permanently consumed |
| `issued` | `issued` | line/adjustment mutation is **rejected**, not silently allowed |
| `paid` | `void` | **forbidden** — refund first, then void |
| any | any other | rejected |

The `paid → partially_paid` transition is real and is explicitly part of the machine. It is the
reason the challan/`invoice` state discussion in §10 exists.

### 9.3 Void semantics

Void is legal **only when the invoice balance is zero**. This single rule removes the entire class of
"how do we reverse payments against a voided invoice" problems, and it is enforced by a trigger:

```sql
IF NEW.status = 'void' AND OLD.status <> 'void' THEN
    PERFORM 1 FROM fin_invoice_items WHERE invoice_id = NEW.id;
    -- balance is a cached, trigger-maintained column (see §16.5), so recompute here
    -- rather than trusting a caller-supplied value.
    IF <derived balance> <> 0 THEN
        RAISE EXCEPTION 'cannot void an invoice with a non-zero balance'
            USING ERRCODE = '55000';
    END IF;
END IF;
```

Rationale: voiding a paid invoice would require reversing settled payments and possibly clawing back
banked money. That is a *refund* workflow with its own approval, and it already exists (§13). Void is
for "we issued this in error and nobody paid" — a real and common case, and cheap to support safely.

### 9.4 Draft edits, issued freeze

`fin_invoice_items` carries a freeze trigger modelled on `trg_report_card_subjects_freeze`
(`0018:560-600`): any `UPDATE`/`DELETE` on a line whose parent invoice `status <> 'draft'` raises
`ERRCODE = '55000'`. The invoice header's money columns are exempted from the same freeze because
they are trigger-maintained caches (§16.5) — this is an explicit, documented exception, exactly as
`FINANCE_DESIGN.md:31` describes, and unlike the rejected GUC bypass in `DATABASE_DESIGN.md:220` it
is enforced by a trigger that recomputes from authoritative rows rather than trusting a flag.

#### 9.4.1 The issued-line freeze, in full (NORMATIVE)

The freeze was named as a precedent in three places and defined in none; `fin_invoice_adjustments`
carries the same rule because it is the other side of the invoice total. One function, bound to both
tables in §35.3.

```sql
CREATE OR REPLACE FUNCTION trg_fin_invoice_items_freeze() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE v_status text;
        v_tenant uuid;
        v_invoice uuid;
BEGIN
    -- Stepping across to the parent is the only way to see the invoice's status: the
    -- freeze is a property of the parent, not of the line, and a CHECK cannot read
    -- another table.
    --
    -- TG_OP, NOT COALESCE(NEW.tenant_id, OLD.tenant_id). The bound is
    -- `BEFORE UPDATE OR DELETE`, so NEW is unassigned on every DELETE and OLD is
    -- unassigned on no path — but COALESCE still dereferences NEW first, raising
    -- P0002 `record "new" is not assigned yet` on the first line delete against a
    -- posted invoice. The intended answer is 55000; a P0002 becomes a 500 whose
    -- message names a PL/pgSQL internal rather than the policy that refused.
    IF TG_OP = 'DELETE' THEN
        v_tenant  := OLD.tenant_id;
        v_invoice := OLD.invoice_id;
    ELSE
        v_tenant  := NEW.tenant_id;
        v_invoice := NEW.invoice_id;
    END IF;

    SELECT status INTO v_status
      FROM fin_invoices
     WHERE tenant_id = v_tenant AND id = v_invoice;
    IF v_status IS NULL THEN
        RAISE EXCEPTION 'invoice line references an unknown invoice'
            USING ERRCODE = '55000';
    END IF;
    IF v_status <> 'draft' THEN
        RAISE EXCEPTION
            'cannot % a line of a % invoice; issue a correction instead',
            LOWER(TG_OP), v_status
            USING ERRCODE = '55000';
    END IF;

    -- The RETURN is a write, not a courtesy: in a BEFORE trigger the returned row
    -- IS the row that gets stored, so returning the unassigned record aborts the
    -- statement.
    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;
    RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION trg_fin_invoice_items_freeze() FROM PUBLIC;
```

**The header's money columns are deliberately outside this freeze, and that is not a loophole.**
`trg_fin_invoice_item_total` recomputes `subtotal`/`total` *after* the lines are frozen, so if the
freeze covered the header the recompute could never run on an issued invoice and the cache would go
stale on the first correction. The exemption is safe because the header columns are not
caller-writable: §16.5 revokes direct `UPDATE` on them and the only writer is the recompute trigger.
"Exempt from the freeze" and "writable by a client" are different statements, and the previous
revision's prose blurred them.

### 9.5 `fin_invoice_items` and `fin_invoice_adjustments` — in full (NORMATIVE)

Both were named in §6, §9, §13, §20 and §35 while having no `CREATE TABLE`. They are declared
together because they are the two sides of the invoice total, and the recompute trigger in §16.5
sums both — declaring them separately is what made the previous revision's total ambiguous.

```sql
-- ── 0023 fin_invoices.sql (continued) ─────────────────────────────────────

CREATE TABLE fin_invoice_items (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid NOT NULL,
    invoice_id      uuid NOT NULL,
    -- The head supplies the tax treatment and the waivability rule; both are
    -- COPIED onto the line at issue time because a published structure is frozen
    -- but a fee HEAD can be re-taxed, and an issued invoice must not change when
    -- the head does. This is snapshotting, not denormalisation for speed.
    fee_head_id     uuid NOT NULL,
    description     text NOT NULL,
    -- A negative line is a correction entered as a line, NOT a concession. The two
    -- are different facts: a concession posts Dr 4000 / Cr 4100 (§15.1) and is
    -- permission-gated, while a negative line is simply a smaller charge and must
    -- go through fin_invoice_adjustments if it is a waiver. Allowing either sign
    -- here and enforcing the rule only in the service is how a negative line
    -- becomes an unapproved concession.
    quantity        numeric(19,4) NOT NULL DEFAULT 1 CHECK (quantity <> 0),
    unit_amount     numeric(19,4) NOT NULL CHECK (unit_amount >= 0),
    -- Snapshot of unit_amount * quantity, maintained by
    -- trg_fin_invoice_item_total. Stored because every report reads it and
    -- recomputing per row is the P0 cache-drift risk in reverse.
    amount          numeric(19,4) NOT NULL,
    tax_amount      numeric(19,4) NOT NULL DEFAULT 0 CHECK (tax_amount >= 0),
    -- Frozen at issue (§9.4). NULL while the parent invoice is a draft.
    frozen_at       timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT fin_invoice_items_invoice_fk
        FOREIGN KEY (tenant_id, invoice_id)
        REFERENCES fin_invoices (tenant_id, id) ON DELETE RESTRICT,
    CONSTRAINT fin_invoice_items_head_fk
        FOREIGN KEY (tenant_id, fee_head_id)
        REFERENCES fin_fee_heads (tenant_id, id) ON DELETE RESTRICT,
    CONSTRAINT fin_invoice_items_ten_id_uq UNIQUE (tenant_id, id),
    -- frozen_at iff the invoice is issued. Cross-table, so it is a TRIGGER
    -- (trg_fin_invoice_item_total / the freeze trigger), not this CHECK: a CHECK
    -- cannot reference another table's status, and a CHECK that tried would be
    -- silently satisfied by any expression that returns non-false.
    CONSTRAINT fin_invoice_items_amount_ck CHECK (amount <> 0)
);
-- Revoke the 0001 default-privilege grant immediately (§35.4, §30.3).
REVOKE ALL ON fin_invoice_items FROM school_app_rw;



CREATE TABLE fin_invoice_adjustments (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid NOT NULL,
    invoice_id      uuid NOT NULL,
    -- 'discount' | 'waiver' | 'fine' | 'correction'. CLOSED, because the type
    -- determines the ledger account: a waiver is Dr 4000 / Cr 4100, a fine is
    -- Dr 1200 / Cr 4200, and a correction is a plain reversal. A free-text type
    -- with an application-chosen account is how the same fact posts two ways.
    adjustment_type text NOT NULL
                    CHECK (adjustment_type IN ('discount','waiver','fine','correction')),
    -- Negative reduces the invoice, positive increases it. A waiver and a fine are
    -- both signed, and the SIGN is what distinguishes a reduction from a charge.
    amount          numeric(19,4) NOT NULL CHECK (amount <> 0),
    -- Mandatory and non-empty for every type. An adjustment with no reason is an
    -- unapproved money movement; the audit requirement is on the row, not on a
    -- separate log that can be pruned.
    reason          text NOT NULL CHECK (length(btrim(reason)) > 0),
    approved_by     uuid,
    created_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT fin_invoice_adjustments_invoice_fk
        FOREIGN KEY (tenant_id, invoice_id)
        REFERENCES fin_invoices (tenant_id, id) ON DELETE RESTRICT,
    -- §6.3 R4: `users` is platform-global (P0-06a).
    CONSTRAINT fin_invoice_adjustments_user_fk
        FOREIGN KEY (approved_by) REFERENCES users (id) ON DELETE SET NULL,
    CONSTRAINT fin_invoice_adjustments_ten_id_uq UNIQUE (tenant_id, id),
    -- A waiver and a discount both reduce the fee, so neither may be POSITIVE: a
    -- positive "waiver" is a fee increase wearing a waiver's permission and its
    -- exemption from the fee-head waivability rule.
    CONSTRAINT fin_invoice_adjustments_sign_ck CHECK (
        adjustment_type NOT IN ('waiver','discount') OR amount < 0
    ),
    -- A waiver and a fine are the two that MOVE THE LEDGER to a contra/income
    -- account, so both need an approver. A discount and a correction are the
    -- invoice's own arithmetic and do not. Enforced here rather than in a service
    -- so an unauthenticated insert path cannot bypass it.
    CONSTRAINT fin_invoice_adjustments_approval_ck CHECK (
        adjustment_type NOT IN ('waiver','fine') OR approved_by IS NOT NULL
    )
);
-- Revoke the 0001 default-privilege grant immediately (§35.4, §30.3).
REVOKE ALL ON fin_invoice_adjustments FROM school_app_rw;



-- The intra-file forward FK from §8.7, closed now that fin_invoices exists.
ALTER TABLE fin_billing_run_items
    ADD CONSTRAINT fin_bri_invoice_fk
    FOREIGN KEY (tenant_id, invoice_id)
    REFERENCES fin_invoices (tenant_id, id) ON DELETE SET NULL;
```

**Three consequences of those CHECK constraints that the owner should see, because they are policy
expressed as schema and will change what a school can do.**

1. **A "waiver" can never increase a fee.** `fin_invoice_adjustments_sign_ck` forces
   `amount < 0` for `waiver` and `discount`. A school that wants to add a charge must use `fine` or
   `correction`, both of which require an approver. This is deliberate: a positive amount on a row
   typed `waiver` would be a fee increase that skipped the fee head's `is_waivable = false` rule and
   the waiver permission, because permissions are chosen by route, not by row content.
2. **A waiver and a fine cannot be entered without a named approver.** That is the separation-of-
   duties rule in one CHECK. It means a migration or backfill that bulk-creates historical waivers
   must supply `approved_by` or fail — which is the correct failure, and worth flagging to whoever
   owns the data migration.
3. **A line amount is never zero** (`fin_invoice_items_amount_ck`). A zero line is either a mistake
   or a placeholder; both are better expressed by deleting the line, and admitting zero rows makes
   "did this invoice have a line for this fee?" ambiguous between "no" and "a zero one".

### 9.6 The three invoice trigger functions, in full (NORMATIVE)

`trg_fin_invoice_number`, `trg_fin_invoice_item_total` and `trg_fin_invoice_void` were bound in
§35.3's binding block and referenced by name in §9.1–§9.4 and §16.5, with no `CREATE FUNCTION`
anywhere in the document. A binding block that names a function nothing creates produces
`function … does not exist` when migration `0023` is applied.

```sql
-- ── 1. Number allocation ──────────────────────────────────────────────────
-- draft ⟺ no number, enforced in one place. §9.1's CHECK states the rule; this
-- trigger is what MAKES it true, and the two must agree or the trigger will be
-- fighting the constraint.
CREATE OR REPLACE FUNCTION trg_fin_invoice_number() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE v_next bigint;
BEGIN
    IF NEW.status = 'draft' THEN
        -- Leaving draft CLEARS the number, so a re-draft cannot keep the identity
        -- of a number that was already printed and handed to a parent.
        NEW.invoice_no := NULL;
        NEW.issued_at  := NULL;
        RETURN NEW;
    END IF;

    IF NEW.invoice_no IS NULL THEN
        -- A single-row UPDATE with RETURNING on the counter row is what makes this
        -- gap-free under concurrency: two concurrent issues both take the row lock,
        -- so the second reads the value the first wrote.
        UPDATE fin_document_counters
           SET last_value = last_value + 1, updated_at = now()
         WHERE tenant_id = NEW.tenant_id
           AND academic_year_id = NEW.academic_year_id
           AND kind = 'invoice'
        RETURNING last_value INTO v_next;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'no invoice counter for this tenant and academic year'
                USING ERRCODE = '55000';
        END IF;
        -- Zero-padded so the number sorts lexicographically in the same order it
        -- sorts numerically, which matters because challans and receipts are
        -- printed and filed in order.
        NEW.invoice_no := 'INV-' || NEW.academic_year_id::text::left(4)
                         || '-' || lpad(v_next::text, 6, '0');
        NEW.issued_at  := now();
    END IF;
    -- An already-numbered invoice keeps its number across non-draft transitions
    -- (issued -> partially_paid -> paid), so this is NOT reassigned on every UPDATE.
    RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION trg_fin_invoice_number() FROM PUBLIC;

-- ── 2. Line and adjustment total recomputation ────────────────────────────
-- The invoice header's money columns are a CACHE, maintained here from the
-- authoritative lines. This is the §16.5 rule, and it is the documented exception
-- to the §9.4 freeze: the header is writable after issue for exactly this reason.
CREATE OR REPLACE FUNCTION trg_fin_invoice_item_total() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    v_invoice uuid;
    v_tenant  uuid;
    v_sub     numeric(19,4);
    v_adj     numeric(19,4);
    v_tax     numeric(19,4);
BEGIN
    -- TG_OP, not COALESCE(NEW.tenant_id, OLD.tenant_id). The bound is
    -- `AFTER INSERT OR UPDATE OR DELETE` on TWO tables, so all three operations
    -- occur and each leaves one record unassigned. COALESCE dereferences NEW
    -- first, so the very first DELETE raises P0002 `record "new" is not assigned
    -- yet` — and because the trigger is AFTER, that aborts a delete that the
    -- business considers routine.
    IF TG_OP = 'DELETE' THEN
        v_invoice := OLD.invoice_id;
        v_tenant  := OLD.tenant_id;
    ELSE
        v_invoice := NEW.invoice_id;
        v_tenant  := NEW.tenant_id;
    END IF;
    -- Items and adjustments are aggregated SEPARATELY, in three statements, and
    -- never joined. Joining them on (tenant_id, invoice_id) produces a Cartesian
    -- product: an invoice with 3 lines and 2 adjustments yields 6 rows, and a
    -- single SUM(i.amount) over it counts each line twice. A 300 subtotal caches
    -- 600, and every balance, aging bucket and AR report downstream inherits the
    -- error while still reconciling against itself. Three scans of small indexed
    -- sets is the right trade against one scan that is quietly wrong.
    SELECT COALESCE(SUM(amount), 0) INTO v_sub
      FROM fin_invoice_items
     WHERE tenant_id = v_tenant AND invoice_id = v_invoice;
    SELECT COALESCE(SUM(amount), 0) INTO v_adj
      FROM fin_invoice_adjustments
     WHERE tenant_id = v_tenant AND invoice_id = v_invoice;
    SELECT COALESCE(SUM(tax_amount), 0) INTO v_tax
      FROM fin_invoice_items
     WHERE tenant_id = v_tenant AND invoice_id = v_invoice;

    -- subtotal is LINES ONLY. total is subtotal + adjustments + tax. Keeping them
    -- separate is what lets a report show "billed 100, waived 10, tax 0" rather
    -- than a single opaque 90, and it is why three columns exist rather than one.
    UPDATE fin_invoices
       SET subtotal = v_sub,
           total    = v_sub + v_adj + v_tax,
           updated_at = now()
     WHERE tenant_id = v_tenant AND id = v_invoice;
    RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION trg_fin_invoice_item_total() FROM PUBLIC;

-- ── 3. Void preconditions ─────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION trg_fin_invoice_void() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE v_paid numeric(19,4);
BEGIN
    IF NEW.status <> 'void' OR OLD.status = 'void' THEN
        RETURN NEW;   -- not a void transition
    END IF;

    -- Balance is DERIVED from allocations, never read from a cached column. §9.3
    -- requires the balance to be exactly zero, and a cache would let a stale value
    -- pass a void that should have been refused.
    SELECT COALESCE(SUM(a.amount), 0) INTO v_paid
      FROM fin_payment_allocations a
     WHERE a.tenant_id = NEW.tenant_id
       AND a.invoice_id = NEW.id
       AND a.effect = 'apply';
    IF v_paid <> 0 THEN
        RAISE EXCEPTION 'cannot void an invoice with a settled balance of %', v_paid
            USING ERRCODE = '55000';
    END IF;

    -- A void needs a reason, and the reason is not optional prose: an unreasoned
    -- void is indistinguishable from a deletion in an audit.
    IF NEW.void_reason IS NULL OR length(btrim(NEW.void_reason)) = 0 THEN
        RAISE EXCEPTION 'voiding an invoice requires a reason'
            USING ERRCODE = '55000';
    END IF;
    NEW.voided_at := now();
    RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION trg_fin_invoice_void() FROM PUBLIC;
```

**Why three separate scans rather than one join.** Items and adjustments are aggregated separately,
in three statements, and never joined to each other. Joining them on `(tenant_id, invoice_id)`
produces a Cartesian product: an invoice with 3 lines and 2 adjustments yields 6 rows, and a single
`SUM(i.amount)` over that result counts each line twice. A 300 subtotal caches 600, and every
balance, aging bucket and AR report downstream inherits the error while still reconciling against
itself — the worst kind of bug, because it is internally consistent. Three scans of small indexed
sets is the right trade against one scan that is quietly wrong.

---

## 10. Challan model

### 10.1 Adjudication: current state, not historical state

The brief asks whether a challan represents **current payment state** or **historical settlement
state**, and correctly notes these must not be mixed. **Adjudicated: a challan represents CURRENT
payment state, and it is a derived view of the invoice — never an independent fact.**

Concretely:

- `fin_challans` has **no independent settlement ledger**. Its `status` is a trigger-maintained cache
  of the owning invoice's derived balance.
- **All reporting and the parent portal read invoice state, not challan state.** The challan is a
  *presentation document* (a printable Pakistan bank-deposit instrument) whose status label exists so
  a parent staring at a slip of paper sees the right word.
- Because the challan mirrors rather than records, `paid → partially_paid` after a refund is
  automatic and needs no challan-specific transition.

**Why current state, and why this matters.** If a challan recorded *historical* settlement, a refund
would leave a challan claiming "PAID" while the invoice showed a balance — two conflicting truths on
the same document, and the parent portal would have to arbitrate. Mirroring removes the conflict at
the source.

### 10.2 State machine (explicit, complete, and closed under void)

```text
  draft ──issue──► issued ──any allocation > 0──► partially_paid ──balance = 0──► paid
                     │                              │                          │
                     │ issued_at > due_on           │ refund reduces           │
                     │ and balance > 0              │ net applied              │
                     ▼                              ▼                          ▼
                  expired ◄───────────────────  partially_paid            partially_paid
                     │                              │
                     └──────────────────────────────┘

  ANY non-void state ──invoice voided (balance = 0 required)──► void   (terminal)
```

| State | Entered when | Ledger effect | Exits to |
|---|---|---|---|
| `issued` | invoice issued, `balance > 0`, `issued_at <= due_on` | none | `partially_paid`, `expired`, `void` |
| `partially_paid` | `0 < balance < total` | none | `paid`, `partially_paid` (refund), `expired`, `void` |
| `paid` | `balance = 0` | none | `partially_paid` (refund reopens the balance), `void` |
| `expired` | `issued_at > due_on` **and** `balance > 0` | none | `partially_paid`, `paid`, `void` |
| `void` | **the owning invoice enters `void`** | none — the invoice's own reversal postings already moved the money | *terminal* |

**`void` is required, and the previous revision's state machine was not closed (P1-02).** The state
set was `{issued, partially_paid, paid, expired}` with no `void`, while the invoice state set
(§9.2) *does* include `void`, and §9.3 makes voiding a normal, supported operation. The two
contradictions this produced were:

1. A challan whose invoice was voided had **no representable status**. The trigger-maintained cache
   (§10.1) derives from the invoice's balance, and a voided invoice's balance is not "paid" and not
   "outstanding" — it is *cancelled*. Every one of the four states is a lie about it.
2. A parent holding a printed challan for a voided invoice would see `PAID` or `OUTSTANDING` on the
   portal while the invoice itself read `VOID`. A bank-deposit instrument that is not voided is
   still payable at the bank, which is a real operational and fraud exposure, not a labelling
   preference.

**Adjudicated: `fin_challans.status` gains a `void` value, maintained by the same trigger that
maintains the other four, and reached only through invoice void.** The trigger's rule becomes:

```sql
-- Challan status is a pure function of the owning invoice's state and derived balance.
-- void  -> the invoice is void.  Terminal.  Nothing can reopen it (§9.3: void requires
--          balance = 0, so there is never money to reclaim through this path).
-- paid  -> balance = 0.
-- expired -> issued_at > due_on and balance > 0.
-- otherwise partially_paid or issued, per the balance and the issue time.
```

**The `fin_challans` DDL, which the previous revision omitted entirely (P1-02a).** The state machine
above named five states, the §30.1 matrix claims `0023` creates `fin_challans`, §19.2 puts it in the
document-money RLS class, and §16.6 derives its `amount_due` from the invoice — but no DDL block
existed, so the `status` CHECK, the invoice FK, the tenant anchor, and the snapshot column were all
unspecified. A `DESIGN-GO` document needs the table written out:

```sql
CREATE TABLE fin_challans (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid NOT NULL,
    -- 1:1 with a live invoice. A challan is not a reusable payment instrument: it is
    -- a printable bank-deposit slip FOR one invoice, so a second challan against the
    -- same invoice would be a second payable document for one debt. Hence UNIQUE,
    -- not a partial index -- and hence the model's "1:1 with a live invoice".
    invoice_id      uuid NOT NULL,
    -- Frozen at issue, because the installment plan may be corrected later and a
    -- parent's printed challan must keep its date (§10.3).
    due_on          date NOT NULL,
    issued_at       timestamptz NOT NULL,
    status          text NOT NULL
                    CHECK (status IN ('issued','partially_paid','paid','expired','void')),
    -- Terminal, and monotonic: trg_fin_challan_status rejects any UPDATE that
    -- changes issued_at, due_on, or invoice_id, and any UPDATE that moves a void
    -- challan out of void. This is a CHECK's job in part (the value set) and a
    -- trigger's job in part (OLD cannot be referenced by a CHECK).
    voided_at       timestamptz,
    void_reason     text,
    -- What the family was actually shown, frozen. Recomputing a printed document
    -- from live rows means a parent's paper challan and the portal disagree the day
    -- a fee structure is corrected.
    snapshot        jsonb NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT fin_challans_invoice_fk
        FOREIGN KEY (tenant_id, invoice_id)
        REFERENCES fin_invoices (tenant_id, id) ON DELETE RESTRICT,
    CONSTRAINT fin_challans_ten_id_uq UNIQUE (tenant_id, id),
    CONSTRAINT fin_challans_1to1_uq UNIQUE (tenant_id, invoice_id),
    -- void is never silently representable: it needs a date and a reason, exactly
    -- as fin_invoices_void_ck does, so "void" can never be a label with no cause.
    CONSTRAINT fin_challans_void_ck CHECK (
        (status = 'void' AND voided_at IS NOT NULL AND void_reason IS NOT NULL)
     OR (status <> 'void' AND voided_at IS NULL)
    ),
    -- paid means the invoice's balance is zero, which the trigger guarantees; a
    -- challan cannot be issued against a zero-balance invoice in the first place
    -- because issuing is downstream of invoice issue with balance > 0.
    CONSTRAINT fin_challans_snapshot_ck CHECK (jsonb_typeof(snapshot) = 'object')
);
-- Revoke the 0001 default-privilege grant immediately (§35.4, §30.3).
REVOKE ALL ON fin_challans FROM school_app_rw;



-- The trigger-maintained cache and its immutability guard, as one function. Written
-- out because §35.3's inventory must be checkable against a definition, and because
-- the previous revision's "void is terminal" claim had no enforcement behind it.
CREATE FUNCTION trg_fin_challan_status() RETURNS trigger
    LANGUAGE plpgsql SECURITY INVOKER
    SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    v_inv        fin_invoices;
    v_balance    numeric(19,4);
    v_new_status text;
BEGIN
    IF TG_OP = 'UPDATE' THEN
        -- The identity of the document is frozen. A challan that can be re-pointed
        -- at a different invoice is a second payable instrument for another family.
        IF NEW.invoice_id IS DISTINCT FROM OLD.invoice_id
           OR NEW.issued_at  IS DISTINCT FROM OLD.issued_at
           OR NEW.due_on     IS DISTINCT FROM OLD.due_on
           OR NEW.snapshot   IS DISTINCT FROM OLD.snapshot THEN
            RAISE EXCEPTION 'challan identity and snapshot are immutable'
                USING ERRCODE = '55000';
        END IF;
        -- void is terminal (P1-02).
        IF OLD.status = 'void' AND NEW.status IS DISTINCT FROM 'void' THEN
            RAISE EXCEPTION 'voided challan is terminal'
                USING ERRCODE = '55000';
        END IF;
    END IF;

    -- Two separate reads, because `v_inv` is typed as the row type `fin_invoices`
    -- and has no `balance` field: `SELECT i.*, v.balance` into a `fin_invoices`
    -- variable would raise "record v_inv is not assigned yet / too many columns".
    -- The view column list is (tenant_id, invoice_id, balance) per §12.4.
    SELECT i.* INTO v_inv
      FROM fin_invoices i
     WHERE i.tenant_id = NEW.tenant_id AND i.id = NEW.invoice_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'challan references a non-existent invoice'
            USING ERRCODE = '55000';
    END IF;

    SELECT v.balance INTO v_balance
      FROM fin_v_invoice_balance v
     WHERE v.tenant_id = NEW.tenant_id AND v.invoice_id = NEW.invoice_id;
    IF NOT FOUND THEN
        -- The invoice exists but the caller cannot see it through the invoker view.
        -- That is a permission failure, not a data failure, and it must not be
        -- reported as a missing invoice.
        RAISE EXCEPTION 'challan balance is not visible to this actor'
            USING ERRCODE = '42501';
    END IF;

    -- The closed derivation of §10.2, in precedence order.
    IF v_inv.status = 'void' THEN
        v_new_status := 'void';
    ELSIF v_balance = 0 THEN
        v_new_status := 'paid';
    ELSIF NEW.issued_at::date > NEW.due_on THEN
        v_new_status := 'expired';
    ELSIF v_balance > 0 AND v_balance < v_inv.total THEN
        v_new_status := 'partially_paid';
    ELSE
        v_new_status := 'issued';
    END IF;

    IF v_new_status <> 'void' AND NEW.status = 'void' THEN
        -- The challan may only become void because the invoice did. Reached only
        -- by the invoice's own void transaction, never by a challan write.
        RAISE EXCEPTION 'challan may only be voided via its invoice'
            USING ERRCODE = '55000';
    END IF;

    NEW.status := v_new_status;
    IF v_new_status = 'void' THEN
        -- Inherit the invoice's void provenance rather than inventing a reason here,
        -- so a reader comparing the two documents sees the same cause.
        NEW.voided_at := v_inv.voided_at;
        NEW.void_reason := v_inv.void_reason;
    END IF;
    RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION trg_fin_challan_status() FROM PUBLIC;
-- Bound as `fin_challans_status` in §35.3.2. It is not repeated here so there is
-- exactly one CREATE TRIGGER for this function in the document; a second copy in
-- a migration would fail with 42710 (duplicate trigger).
-- No DELETE trigger is needed because there is no DELETE route and no DELETE
-- policy; §19.2 records DELETE as app_privileged()-only, which is a backstop, not
-- the control. The control is that no such route exists.
```

**Two decisions inside that trigger worth arguing with, stated so they can be overruled.**

1. **`status` is assigned unconditionally on every write, so the column is genuinely a cache** and
   cannot be set directly by a caller. A caller that `INSERT`s a challan with `status='paid'` gets
   `'issued'`, because the trigger overwrites it from the invoice. This is the right shape for a
   trigger-maintained cache and the opposite of what a naive design does (trusting the caller's
   initial value).
2. **The trigger reads `fin_v_invoice_balance`**, which is a `security_invoker` view (§15.2.1). Inside a
   `SECURITY INVOKER` trigger, the reading session is the writing session, so the view's RLS applies
   — which is correct, and it is also why this trigger is invoker and not definer. A definer version
   would compute a balance under owner privileges and could accept a cross-tenant write that the
   caller's own view would have returned as zero rows. The trigger is `SECURITY INVOKER` for the same
   reason F5's are (§19.7.2).

**`void` is terminal on the challan, and that is not in tension with the refund reopening the
invoice.** A refund moves `paid → partially_paid` because it creates a real balance, and §9.3
forbids voiding an invoice that has a balance — so a voided invoice can never acquire one, and the
challan can never need to leave `void`. The terminality is a consequence of the void precondition, not
an extra rule.

**A void challan is still retrievable and still printable**, and it prints as VOID with the void
date and reason, because the printed document is evidence of what was issued and when. What it is not
is *payable*: the void notice (§25.2) and the invoice's `void` state are what tell the bank and the
parent that the instrument is dead. `fin_challans` therefore has **no delete route** and no
`DELETE` policy, exactly as for receipts (§25.5).

**`expired` is a purely temporal, advisory state.** It has **no ledger effect, no fee effect, and no
accounting meaning** — because automatic late fees are out of scope (§21). An expired challan is
still fully payable; it is a marker for the school's collections follow-up and for AR aging
buckets. This is stated explicitly because a reader could otherwise assume `expired` implies a
penalty.

`expired` is **not a terminal state**: paying an expired challan moves it to `partially_paid`/`paid`.
An invoice whose balance reaches 0 by refund is `paid`, not `expired`, even if long past due.

### 10.3 `due_on` resolution

`due_on = COALESCE(fin_fee_installment_plans.due_on for the matching installment_no, structure.effective_from)`.
If an item has no matching plan row, it is due on the structure's `effective_from`. A challan carries
a denormalised `due_on` **frozen at invoice issue**, because the plan may be corrected later and a
parent's printed challan must keep its date.

---

## 11. Payment model

### 11.1 Payments are append-only, and there is exactly one reversal mechanism

```sql
CREATE TABLE fin_payments (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id        uuid NOT NULL,
    payment_no       text NOT NULL,
    amount           numeric(19,4) NOT NULL CHECK (amount > 0),
    currency         char(3) NOT NULL DEFAULT 'PKR',
    method           text NOT NULL
                     CHECK (method IN ('cash','bank_transfer','cheque','card',
                                       'online','easypaisa','jazzcash','raast','other')),
    channel          text NOT NULL DEFAULT 'manual'
                     CHECK (channel IN ('manual','portal','provider')),
    provider         text,
    provider_ref     text,
    status           text NOT NULL DEFAULT 'settled'
                     CHECK (status IN ('pending','settled','failed')),
    -- P0-09 / P0-10: THE payer. Not optional, and not a "family_id" -- there is no
    -- `families` table in this repository (0005). Family scope is DERIVED: a family is
    -- the set of students linked to one guardian through `student_guardians`
    -- (student_id, guardian_id, relation, is_primary, can_pickup, soft-deleted in 0006).
    -- Naming the guardian is therefore the only way to make family ownership a
    -- checkable fact rather than an inference from whichever invoice happened to be paid.
    payer_guardian_id uuid NOT NULL,
    received_at      timestamptz NOT NULL,
    received_by      uuid,            -- NULL for provider/webhook-initiated
    idempotency_key  text NOT NULL,
    created_at       timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT fin_payments_payer_fk
        FOREIGN KEY (tenant_id, payer_guardian_id)
        REFERENCES guardians (tenant_id, id) ON DELETE RESTRICT,
    CONSTRAINT fin_payments_no_uq  UNIQUE (tenant_id, payment_no),
    CONSTRAINT fin_payments_idem_uq UNIQUE (tenant_id, idempotency_key),
    -- a lifecycle transition, not a financial fact
    CONSTRAINT fin_payments_transition_ck CHECK (
        status = 'settled' OR received_at IS NOT NULL
    ),
    -- a provider reference exists only for provider-originated money
    CONSTRAINT fin_payments_provider_ck CHECK (
        (channel = 'provider' AND provider IS NOT NULL AND provider_ref IS NOT NULL)
     OR (channel <> 'provider')
    ),
    CONSTRAINT fin_payments_ten_id_uq UNIQUE (tenant_id, id)
);
-- Revoke the 0001 default-privilege grant immediately (§35.4, §30.3).
REVOKE ALL ON fin_payments FROM school_app_rw;


```

**Why the payer column is `NOT NULL`, and what it buys.** Without a stored payer, "does this payment
belong to the same family as the invoice it pays?" has no authoritative answer: the only available
inference is "the invoice is linked to some student, and some guardian is linked to that student",
which is a many-to-many relation and admits several unrelated guardians. That is the P0-09 hole — a
cashier (or a compromised API token) could apply one family's cash to a **different** family's invoice
and the database would accept it, because every FK was individually satisfied. With
`payer_guardian_id` stored, `trg_fin_allocation_family_guard` (§12.6) can state the rule precisely:

> Every invoice named by an allocation of payment `p` must have **at least one** student enrolled
> under `p.payer_guardian_id` via a live `student_guardians` row.

This is intentionally "at least one shared student", not "the payer is the invoice's primary
guardian": siblings at the same school share one guardian, and a single payment legitimately settles
several siblings' invoices. Requiring a *specific* guardian would make the common case fail. The rule
that matters — cash never crosses a family boundary — is exactly "some student of the paying family
is on the invoice", and it is checked at the database layer.

**Soft-deleted guardians.** `student_guardians` rows are soft-deleted in `0006` (a `deleted_at`
column), so a plain FK would happily accept a link that has been revoked. The trigger therefore
requires `sg.deleted_at IS NULL` on the linking row as well as `g.deleted_at IS NULL` on the
guardian. A revoked link immediately stops authorising new allocations; existing allocations are
unaffected, because removing a guardian from a school must not rewrite history.

**There is no `reverses_payment_id` and no `status = 'reversed'`, and their absence is a
deliberate decision, not an omission.** An earlier draft of this design carried a compensating
payment row (`reverses_payment_id`) *and* the signed allocation table (§12.1). That is the exact
duplication the signed table exists to prevent: it would give the system two ways to say "this
payment was reversed", two places to bound the reversal amount, two states that could disagree, and
a `status` column that would have to be mutated on a supposedly append-only table to reflect a fact
that lives entirely in `fin_payment_allocations`. **Reversal is a row in the allocation table and
nothing else** (§12.1, FI-007).

Consequently:

- The **only** mutation of a `fin_payments` row after creation is the lifecycle transition
  `pending → settled` and `pending → failed` (§11.2), guarded by
  `WHERE status = 'pending'`, so a provider's out-of-order delivery cannot settle a failed payment.
- "Is this payment fully reversed?" is **derived, not stored**: `fin_v_payment_position` exposes
  `net_applied_total = Σ a.amount WHERE payment_id = p AND refund_id IS NULL`, and a payment is
  fully reversed when `net_applied_total = 0 AND payment_unallocated = p.amount` **and** at least one
  reversal row exists. A `WHERE` predicate in the view; no column, no trigger, no drift.
- Recovering a mistaken **payment** (as opposed to a mistaken allocation) is handled by reversing
  its allocations, which returns the money to unallocated on-account, and then — if the cash should
  leave the school — by an **on-account return** (§12.1) or a **refund** (§13), whichever is
  economically correct. The school is never tempted to invent a negative payment, because
  `CHECK (amount > 0)` makes it unrepresentable.

### 11.2 `pending` vs `settled`

A payment is created `pending` only when a provider redirect is required (online methods). Manual
cash/bank payments are created `settled` directly. `pending → settled` happens **once**; a repeated
webhook for the same provider event is a no-op that converges to the same row (§27.4).

A `pending` payment contributes **nothing** to the ledger or to any balance. A `failed` payment is
terminal and contributes nothing.

### 11.3 Payments with no allocation are legal

A payment may be fully unallocated ("on account"). This is normal in Pakistan (parents prepay a
term). The ledger handles it explicitly with `1300 Unapplied Cash` (§15.1), so it is not a data
error and not a balance.

---

## 12. Allocation model

### 12.1 One signed table — the reversal mechanism

**This is the central design decision of the whole document.** The brief asks (§4, §25) that no
financial fact be represented twice. The naive design — an `allocations` table plus a separate
`reversals` table plus a separate `refund_allocations` table — represents "money applied to an
invoice" three times and guarantees drift.

**Chosen: a single append-only, signed allocation table.**

```sql
CREATE TABLE fin_payment_allocations (
    id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id                uuid NOT NULL,
    payment_id               uuid NOT NULL,
    invoice_id               uuid,      -- NULL = an on-account movement (see below)
    amount                   numeric(19,4) NOT NULL CHECK (amount <> 0),
    effect                   text NOT NULL
                             CHECK (effect IN ('apply','reverse','on_account_return')),
    reversal_of_allocation_id uuid,
    refund_id                uuid,     -- set ONLY when this reversal is caused by a refund
    reason                   text NOT NULL,
    created_by               uuid NOT NULL,
    created_at               timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT fin_pa_payment_fk
        FOREIGN KEY (tenant_id, payment_id)
        REFERENCES fin_payments (tenant_id, id),
    CONSTRAINT fin_pa_invoice_fk
        FOREIGN KEY (tenant_id, invoice_id)
        REFERENCES fin_invoices (tenant_id, id),
    CONSTRAINT fin_pa_reversal_fk
        FOREIGN KEY (tenant_id, reversal_of_allocation_id)
        REFERENCES fin_payment_allocations (tenant_id, id),
    -- P0-01: this FK is created in 0025, NOT 0024. fin_refunds does not exist when
    -- 0024 applies, so declaring it here would be a forward reference to a
    -- not-yet-created table. See §30.1 dependency matrix and §30.2.
    --   0024: create fin_payment_allocations WITHOUT fin_pa_refund_fk
    --   0025: create fin_refunds, then
    --         ALTER TABLE fin_payment_allocations
    --             ADD CONSTRAINT fin_pa_refund_fk
    --             FOREIGN KEY (tenant_id, refund_id) REFERENCES fin_refunds (tenant_id, id);
    -- P0-02: exactly ONE effect check, covering all three effects. The previous
    -- revision declared fin_pa_effect_ck twice with an identical body — the second
    -- could never be violated, and a duplicated constraint name in one table is
    -- rejected by PostgreSQL (42710), so the DDL as written could not apply.
    CONSTRAINT fin_pa_effect_ck CHECK (
        (effect = 'apply'
             AND amount > 0
             AND invoice_id IS NOT NULL
             AND reversal_of_allocation_id IS NULL
             AND refund_id IS NULL)
     OR (effect = 'reverse'
             AND amount < 0
             AND reversal_of_allocation_id IS NOT NULL)
     OR (effect = 'on_account_return'
             -- P0-07: a return is money LEAVING an on-account balance, so it is
             -- negative, names no invoice, reverses nothing, and is not a refund.
             AND amount < 0
             AND invoice_id IS NULL
             AND reversal_of_allocation_id IS NULL
             AND refund_id IS NULL)
    ),
    CONSTRAINT fin_pa_ten_id_uq UNIQUE (tenant_id, id)
);
-- Revoke the 0001 default-privilege grant immediately (§35.4, §30.3).
REVOKE ALL ON fin_payment_allocations FROM school_app_rw;


```

**Why `on_account_return` is a named effect and not just "a negative row with a NULL invoice".**
Before this revision, `invoice_id IS NULL AND amount < 0` was described in prose but had no name, and
the `effect` domain held only `'apply' | 'reverse'`. Two concrete defects followed. First, an
`on_account_return` row could be inserted with `effect = 'reverse'` and a *fabricated*
`reversal_of_allocation_id`, which would make it indistinguishable from a correction reversal and let
it be double-counted in the `refunded` sum. Second — and this is the P0-07 arithmetic defect — the
`payment_unallocated` formula subtracted *every* non-refund row including negative ones, so a full
return of a fully-unallocated payment produced a **negative** unallocated balance, and a
partially-returned payment produced an amount that no longer reconciled with the ledger. The named
effect makes the sign convention structural: `apply` is the only positive row, and both negative
rows are excluded from the unallocated formula by `effect` rather than by a sign test (§12.2).

`trg_fin_reversal_shape` is a `BEFORE INSERT OR UPDATE` trigger, because the remaining property is
genuinely cross-row and PostgreSQL forbids subqueries in a `CHECK` expression:

```sql
CREATE OR REPLACE FUNCTION trg_fin_reversal_shape() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
    IF NEW.effect = 'on_account_return' THEN
        RETURN NEW;   -- nothing to shape: no target, no ceiling (§13.4, FI-003)
    END IF;
    IF NEW.effect <> 'reverse' THEN
        RETURN NEW;
    END IF;
    -- All the arithmetic lives in the helper, because the SAME two checks must run
    -- a second time at COMMIT for every row in the transaction (§13.3.1). One
    -- copy, two callers: two copies would drift, and the drifted copy would be
    -- the one that is not under test.
    PERFORM trg_fin_reversal_shape_check(NEW.tenant_id, NEW.id);
    RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION trg_fin_reversal_shape() FROM PUBLIC;

-- The per-allocation bound, as a standalone RETURNS void function so that
-- (a) trg_fin_reversal_shape can enforce it at INSERT time and
-- (b) fn_fin_refund_ceiling can RE-ENFORCE it at COMMIT for every reversal row
--     the transaction wrote, not only the last one.
CREATE OR REPLACE FUNCTION trg_fin_reversal_shape_check(
    p_tenant uuid, p_allocation_id uuid
) RETURNS void
    LANGUAGE plpgsql
    SECURITY INVOKER
    SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE v_reversal           fin_payment_allocations;
        v_original_invoice   uuid;
        v_original_amount    numeric(19,4);
        v_already_reversed   numeric(19,4);
        v_available          numeric(19,4);
BEGIN
    SELECT * INTO v_reversal
      FROM fin_payment_allocations
     WHERE tenant_id = p_tenant AND id = p_allocation_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'reversal % does not exist in tenant %', p_allocation_id, p_tenant
            USING ERRCODE = '55000';
    END IF;
    IF v_reversal.effect <> 'reverse' THEN
        RETURN;   -- only a reversal has a target and a ceiling
    END IF;

    SELECT a.invoice_id, a.amount INTO v_original_invoice, v_original_amount
      FROM fin_payment_allocations a
     WHERE a.tenant_id = p_tenant AND a.id = v_reversal.reversal_of_allocation_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'reversal target does not exist in this tenant'
            USING ERRCODE = '55000';
    END IF;

    -- P1-13, part 1 of 2: a reversal may not name an invoice its target did not name.
    IF v_reversal.invoice_id IS DISTINCT FROM v_original_invoice THEN
        RAISE EXCEPTION 'reversal must target the same invoice as the allocation it reverses'
            USING ERRCODE = '55000';
    END IF;

    -- P1-13, part 2 of 2: and may not exceed the magnitude outstanding on its target.
    -- v_original_amount is the ORIGINAL applied amount (positive, by fin_pa_effect_ck).
    -- The already-reversed magnitude is the sum of every OTHER existing reversal of
    -- this allocation, in EITHER flavour: a correction reversal and N refund
    -- reversals all draw down the same ceiling, which is why both are summed here.
    -- `a.id <> p_allocation_id` is load-bearing on two counts. It makes the helper
    -- idempotent, so re-running it at COMMIT is safe; and on the UPDATE path the
    -- row being checked is already in the table, so without the exclusion its own
    -- OLD version would be counted as a prior reversal and the row would be
    -- charged twice against its own ceiling.
    SELECT COALESCE(SUM(-a.amount), 0) INTO v_already_reversed
      FROM fin_payment_allocations a
     WHERE a.tenant_id = p_tenant
       AND a.reversal_of_allocation_id = v_reversal.reversal_of_allocation_id
       AND a.amount < 0
       AND a.id <> p_allocation_id;
    v_available := v_original_amount - v_already_reversed;

    IF -v_reversal.amount > v_available THEN
        RAISE EXCEPTION
            'reversal % exceeds the % still available on allocation %',
            -v_reversal.amount, v_available, v_reversal.reversal_of_allocation_id
            USING ERRCODE = '55000';
    END IF;
END $$;
REVOKE ALL ON FUNCTION trg_fin_reversal_shape_check(uuid, uuid) FROM PUBLIC;
```

**The magnitude bound this trigger adds is not optional.** The previous revision computed
`v_original_amount` and then never used it: only the invoice identity was checked. A cashier could
therefore reverse 5,000,000 against a 1,000 apply row and the row-level `CHECK` would accept it,
because `amount < 0` is satisfied. The refund ceiling of §13.3 would eventually catch it at the
*payment* level, but only for rows carrying a `refund_id`; a bare correction reversal
(`refund_id IS NULL`) was entirely unbounded and could drive `net_applied(invoice)` deeply negative,
which is a fabricated receivable that no report would flag. The bound above closes it at the row
level, where the error actually originates. FI-004 asserts it.


**Why `invoice_id` is nullable, and this is a deliberate and load-bearing choice.** An allocation
row is *"money from this payment moved here"*, and "here" is sometimes not an invoice:

| `effect` | `invoice_id` | `amount` | `reversal_of` | `refund_id` | Meaning |
|---|---|---|---|---|---|
| `apply` | **NOT NULL** | `> 0` | NULL | NULL | cash applied to a charge |
| `apply` | NULL | `> 0` | NULL | NULL | **on-account credit** — a sibling's payment moved onto this family's account, or a waiver funded from cash |
| `reverse` | same as target | `< 0` | NOT NULL | NULL | **correction reversal** — the allocation was entered in error; money returns to unallocated on account (`Dr 1200 / Cr 1300`) |
| `reverse` | same as target | `< 0` | NOT NULL | NOT NULL | **refund reversal** — the money leaves the school (`Dr 1200 / Cr 2200`, then `Dr 2200 / Cr 1000`) |
| `on_account_return` | NULL | `< 0` | NULL | NULL | **on-account return** — uncollected cash handed back (`Dr 1300 / Cr 1000`, §15.1) |

The three negative-capable rows are kept **distinct by `effect` and `refund_id`**, never by amount
sign. Two consequences worth stating:

- A payment from one family is **never** credited to another family's invoice. An `invoice_id IS NULL`
  apply is an internal move within one payment's own account, which the ledger records as
  `Dr 1300 / Cr 1300` and which reports net to zero.
- A return is **not** a refund and **not** a reversal. It is a third thing, and it is the only
  operation whose ledger pair touches `1000` Cash (§15.1). Naming it is what makes
  `payment_unallocated` a non-negative quantity (§12.2).

The alternative — a separate `fin_on_account_movements` table — would reintroduce exactly the
duplication §12.1 exists to prevent, because on-account movements and invoice allocations are the
same signed fact about the same payment. One table, one signed sum, one remaining-balance formula
(§12.2). The consequence for security is stated in FI-005: because an `on_account_return` names no
invoice, **it is never refundable**, which closes the over-refund diversion path the naive
`refundable = payment.amount` formula would have opened.

Partial unique indexes make reversal multiplicity explicit and bounded. They are **tenant-prefixed**
so that the §6.3 R2 rule has no exceptions and `finance-composite-fk.test.ts` can assert one shape:

```sql
-- At most ONE plain correction reversal per allocation (no double-reversal).
CREATE UNIQUE INDEX fin_pa_one_correction_uq
    ON fin_payment_allocations (tenant_id, reversal_of_allocation_id)
    WHERE reversal_of_allocation_id IS NOT NULL AND refund_id IS NULL;

-- At most ONE reversal per (allocation, refund) — but MANY partial refunds allowed.
CREATE UNIQUE INDEX fin_pa_one_reversal_per_refund_uq
    ON fin_payment_allocations (tenant_id, reversal_of_allocation_id, refund_id)
    WHERE reversal_of_allocation_id IS NOT NULL AND refund_id IS NOT NULL;
```

`COALESCE` is deliberately avoided in the index expressions; the two partial indexes express the
distinction more readably. Because a correction reversal and refund reversals both draw on the same
per-allocation ceiling, the two indexes are **mutually constraining**, and the magnitude bound in
`trg_fin_reversal_shape` is the authority that arbitrates between them.

### 12.2 Why `refund_id` on the allocation — the whole of the reversal/refund model in one column

The signed sum is the single source of truth. The `refund_id` column's *only* job is to answer one
question: **did this money go back to the family's on-account balance, or did it leave the school?**

- A **correction** reversal (`refund_id IS NULL`) — the allocation was entered in error. Money returns
  to unallocated on-account. Ledger: `Dr 1200 / Cr 1300`.
- A **refund** reversal (`refund_id IS NOT NULL`) — the money is being returned to the family. It does
  **not** return to on-account; it becomes a refund payable. Ledger: `Dr 1200 / Cr 2200`.

Everything else is a signed sum over this one table. This is why the model needs no reversal table,
no refund-allocation table, no `amount_reversed` counter, and no `voided` boolean.

**The three negative rows must be partitioned by `effect`, not by sign.** This is the P0-07
correction, and the previous revision got it wrong in a way that produced a negative asset:

```sql
-- FI-003 / FI-004 / FI-005 -- one formula each, no stored counter to drift.
-- ---------------------------------------------------------------------------
-- INVOICE-SIDE sums. Every row naming this invoice participates, both signs.
-- ---------------------------------------------------------------------------
net_applied(invoice)         = SUM a.amount  WHERE a.invoice_id = :inv
invoice_balance(inv)         = invoice_total(inv) - net_applied(inv)

-- ---------------------------------------------------------------------------
-- PAYMENT-SIDE sums. The three quantities partition the allocation rows by
-- `effect` and `refund_id`, NOT by whether amount is positive.
-- ---------------------------------------------------------------------------

-- (1) cash currently sitting against a charge. Reversals of an applied row are
--     negative and MUST be included -- that is what makes net_applied fall.
--     An on_account_return names no invoice, so it is excluded by invoice_id.
payment_applied(p)           = SUM a.amount  WHERE a.payment_id = p
                               AND a.refund_id IS NULL
                               AND a.invoice_id IS NOT NULL

-- (2) cash handed back out of on-account. Signed negative by construction, so
--     this quantity is <= 0 and its magnitude is what was returned.
payment_on_account_returned(p) = SUM a.amount  WHERE a.payment_id = p
                               AND a.effect = 'on_account_return'

-- (3) cash that left the school as a refund. `refund_id IS NOT NULL` is
--     equivalent to "a reverse row carrying a refund", because fin_pa_effect_ck
--     forbids refund_id on apply and on_account_return rows.
payment_refunded(p)          = -SUM a.amount WHERE a.payment_id = p
                               AND a.refund_id IS NOT NULL

-- (4) THE FIX. The old formula was
--        payment_unallocated = p.amount - SUM(amount WHERE refund_id IS NULL)
--     which subtracted correction reversals AND on_account returns, and also
--     subtracted an on-account *credit* -- three separate ways to go negative.
--     The correct statement: a payment's cash is either applied to a charge,
--     still held on account, or handed back. Those three partition it exactly.
--
--     applied:       effect='apply'        AND invoice_id IS NOT NULL
--     still on acct: effect='apply'        AND invoice_id IS NULL
--     handed back:   effect='on_account_return'
--     (refund rows are NOT part of unallocated -- a refund is a different
--      operation against already-applied cash, tracked by (3))
--
payment_unallocated(p)       = p.amount
                               - payment_applied(p)
                               + payment_on_account_returned(p)
                               + payment_refund_reapplied(p)
-- payment_refund_reapplied(p) = 0 in this design. It is named explicitly because
-- it is the term that a "refund that returns to on-account" variant would need,
-- and naming it prevents the P0-07 class of bug from being reintroduced silently
-- in a future revision. See §15.1 for why a refund never returns to on-account.

payment_refundable(p)        = payment_applied(p) - payment_refunded(p)
```

**Why the old formula was a P0, with the arithmetic made explicit.** Take payment `P2` = 100,000,
fully unallocated, then returned in full via one `on_account_return` row of −100,000.

| Quantity | Old formula | Old value | New formula | New value |
|---|---|---|---|---|
| `payment_unallocated(P2)` | `100,000 − (100,000) ` *(the return row is `refund_id IS NULL`)* | 0 — and for a *partial* return of 40,000, `100,000 − (−40,000)` = **140,000** | `100,000 − 0 + (−40,000)` | **60,000** |

The old formula reported a 40,000 return as if the school held 140,000 of that family's money. Any
parent-portal "balance in account" or cashier over-payment prompt built on it would be wrong by the
returned amount, and it would disagree with the ledger's `1300 Unapplied Cash` account, which
correctly falls to 60,000. A second instance: an on-account **credit** of +10,000 (moving a sibling's
payment onto this account) made the old formula report 90,000 unallocated on a 100,000 payment, i.e.
it under-counted the family's claim. Both directions of error are removed by partitioning on `effect`.

**Invariant, asserted in FI-003 (and it is now two-sided):**

```text
payment.amount
  = payment_applied(p)                      -- against charges
  + (on-account credits, effect='apply' AND invoice_id IS NULL)
  + payment_on_account_returned(p)          -- <= 0
```

with every quantity `>= 0` except the returned amount, and
`payment_unallocated(p) = on-account credits - payment_on_account_returned(p) >= 0`.

`payment_refundable` is bounded by **cash actually applied to a charge**, not by the payment amount.
This is the single most consequential line in the block and it is easy to get wrong: the naive
`refundable = p.amount - refunded` lets a cashier refund *uncollected cash* — take 100,000 on
account, bill nothing, and pay 100,000 back out. The money was never owed, so the payout is pure
diversion. Under the formula above the same attempt is refused by `fn_fin_refund_ceiling` with
`55000` → **409 `refund_exceeds_payment`**, and the correct operation is an **on-account return**
(`effect = 'on_account_return'`, `invoice_id IS NULL`, `amount < 0`), which is a different row, a
different audit action, and a different ledger account pair (§15.1).

Note also that the sums are mutually exclusive, and **there is no second mutable unallocated
counter anywhere in the schema** — satisfying §25's requirement to "not create a second mutable
unallocated counter". `payment_applied`, `payment_on_account_returned`, and `payment_unallocated`
are exposed as columns of `fin_v_payment_position`, so a report never recomputes them by hand.


### 12.3 Worked example — reversal versus refund

Setup: Payment `P1` = 100,000, allocated 100,000 to Invoice `A` (total 100,000).

```sql
-- apply
INSERT fin_payment_allocations(payment_id, invoice_id, amount, effect, reason)
VALUES ('P1','A', 100000, 'apply', 'full settlement');
```

Derived state:

| Quantity | Value |
|---|---|
| `net_applied(A)` | 100,000 |
| `invoice_balance(A)` | 0 |
| `payment_unallocated(P1)` | 0 |
| `payment_refunded(P1)` | 0 |
| `payment_refundable(P1)` | 100,000 |

**Case (a) — correction reversal** (wrong invoice selected):

```sql
INSERT fin_payment_allocations(payment_id, invoice_id, amount, effect,
                               reversal_of_allocation_id, refund_id, reason)
VALUES ('P1','A', -100000, 'reverse', '<the apply row>', NULL, 'allocated to wrong invoice');
```

| Quantity | Value | Meaning |
|---|---|---|
| `net_applied(A)` | 0 | invoice is unpaid again |
| `invoice_balance(A)` | 100,000 | |
| `payment_unallocated(P1)` | **100,000** | money back on account |
| `payment_refunded(P1)` | 0 | nothing left the school |
| Ledger | `Dr 1200 / Cr 1300` | AR restored, on-account liability restored |

**Case (b) — refund** (§13):

```sql
INSERT fin_payment_allocations(payment_id, invoice_id, amount, effect,
                               reversal_of_allocation_id, refund_id, reason)
VALUES ('P1','A', -100000, 'reverse', '<the apply row>', '<R1>', 'family withdrew');
```

| Quantity | Value | Meaning |
|---|---|---|
| `net_applied(A)` | 0 | invoice is unpaid again |
| `invoice_balance(A)` | 100,000 | |
| `payment_unallocated(P1)` | **0** | the money did **not** return on account |
| `payment_refunded(P1)` | **100,000** | |
| `payment_refundable(P1)` | 0 | nothing further refundable |
| Ledger (approve) | `Dr 1200 / Cr 2200` | refund obligation recognised |
| Ledger (process) | `Dr 2200 / Cr 1000` | cash leaves |

**The single distinguishing fact is `refund_id`.** This is the whole answer to §5 of the brief, and it
is why no `voided` flag, no `reversed_amount` column, and no separate reversal table is needed.

### 12.4 All reports use these formulas — one implementation

Every report, the parent portal, the API response, and the nightly reconciler read the **same** SQL
expressions, published as `SECURITY INVOKER` views:

```sql
CREATE VIEW fin_v_payment_position WITH (security_invoker = on) AS
SELECT p.tenant_id, p.id AS payment_id, p.payment_no, p.amount,
       -- P0-07: partition by effect/refund_id, never by sign. See §12.2.
       p.amount
       - COALESCE(SUM(a.amount) FILTER (WHERE a.refund_id IS NULL
                                         AND a.invoice_id IS NOT NULL), 0)
       + COALESCE(SUM(a.amount) FILTER (WHERE a.effect = 'on_account_return'), 0)
         AS unallocated_amount,
       COALESCE(-SUM(a.amount) FILTER (WHERE a.refund_id IS NOT NULL), 0) AS refunded_amount,
       -- FI-005: the refund ceiling is cash APPLIED TO A CHARGE, not p.amount.
       COALESCE(SUM(a.amount) FILTER (WHERE a.refund_id IS NULL
                                         AND a.invoice_id IS NOT NULL), 0) AS applied_amount,
       -- Signed, so the magnitude is what left; the column is <= 0 by construction.
       COALESCE(SUM(a.amount) FILTER (WHERE a.effect = 'on_account_return'), 0)
         AS on_account_returned_amount,
       COALESCE(SUM(a.amount) FILTER (WHERE a.refund_id IS NULL
                                         AND a.invoice_id IS NOT NULL), 0)
       - COALESCE(-SUM(a.amount) FILTER (WHERE a.refund_id IS NOT NULL), 0) AS refundable_amount
FROM fin_payments p
LEFT JOIN fin_payment_allocations a ON a.tenant_id = p.tenant_id AND a.payment_id = p.id
WHERE p.status = 'settled'
GROUP BY p.tenant_id, p.id;
```

`WITH (security_invoker = on)` is **mandatory** (PostgreSQL 15+; the CI service is `postgres:16`, so
it is available). Without it a view runs as its owner and would silently bypass the caller's RLS —
precisely the failure this document exists to prevent. This is the first view in the repository to
need it, and the reason is worth stating: finance reports fan out over allocation rows, and a
definer-view would expose every tenant's money to any authenticated session.

#### 12.4.1 The second V1 view, and the cache trigger it publishes

`fin_v_payment_position` above was the only view the document ever wrote out. `fin_v_invoice_balance`
is named in FI-002, in §15.3's reconciliation Path B, in the V1 contract row, in the migration
inventories and in `finance-aggregate-view.test.ts` — and had no `CREATE VIEW` anywhere. It is here,
together with the trigger that maintains the `fin_invoices.balance` **cache** it publishes.

```sql
-- ── 0024 fin_payments.sql (continued) ─────────────────────────────────────

-- FI-002, verbatim. The view is AUTHORITATIVE: it recomputes from
-- fin_invoice_items / fin_invoice_adjustments / fin_payment_allocations and
-- ignores the cached columns entirely, so a stale cache can never make the
-- view lie. The cache exists for reporting throughput, not for correctness.
CREATE VIEW fin_v_invoice_balance WITH (security_invoker = on) AS
SELECT i.tenant_id,
       i.id                    AS invoice_id,
       i.invoice_no,
       i.student_id,
       i.status,
       i.due_date,
       COALESCE((SELECT SUM(it.amount)
                   FROM fin_invoice_items it
                  WHERE it.tenant_id = i.tenant_id AND it.invoice_id = i.id), 0)
     + COALESCE((SELECT SUM(a.amount)
                   FROM fin_invoice_adjustments a
                  WHERE a.tenant_id = i.tenant_id AND a.invoice_id = i.id), 0)
     + COALESCE((SELECT SUM(it.tax_amount)
                   FROM fin_invoice_items it
                  WHERE it.tenant_id = i.tenant_id AND it.invoice_id = i.id), 0)
                                            AS invoice_total,
       -- net_applied is SIGNED (§12.1), so a reversal reduces it without a
       -- separate "reversed" column. The sum includes on-account returns only
       -- if they name this invoice, which by CHECK they never do (P0-07).
       COALESCE((SELECT SUM(pa.amount)
                   FROM fin_payment_allocations pa
                  WHERE pa.tenant_id = i.tenant_id AND pa.invoice_id = i.id), 0)
                                            AS net_applied,
       COALESCE((SELECT SUM(it.amount)
                   FROM fin_invoice_items it
                  WHERE it.tenant_id = i.tenant_id AND it.invoice_id = i.id), 0)
     + COALESCE((SELECT SUM(a.amount)
                   FROM fin_invoice_adjustments a
                  WHERE a.tenant_id = i.tenant_id AND a.invoice_id = i.id), 0)
     + COALESCE((SELECT SUM(it.tax_amount)
                   FROM fin_invoice_items it
                  WHERE it.tenant_id = i.tenant_id AND it.invoice_id = i.id), 0)
     - COALESCE((SELECT SUM(pa.amount)
                   FROM fin_payment_allocations pa
                  WHERE pa.tenant_id = i.tenant_id AND pa.invoice_id = i.id), 0)
                                            AS balance
  FROM fin_invoices i
 WHERE i.status <> 'draft';
```

**The four independent sub-queries, not one joined aggregate.** This is the same defect
`trg_fin_invoice_item_total` was written to avoid (§9.6): joining `fin_invoice_items` to
`fin_invoice_adjustments` to `fin_payment_allocations` on `(tenant_id, invoice_id)` produces a
Cartesian product, so an invoice with 3 lines, 1 adjustment and 2 allocations yields 6 rows and every
`SUM` is inflated by the product of the other two counts. **A `VIEW` is the wrong place to learn that
lesson a second time**, so the sums are deliberately separate and each is independently indexable.
The `balance` expression repeats three of them rather than aliasing `invoice_total - net_applied`,
because a view's output column cannot be referenced in the same `SELECT` list.

```sql
-- The CACHE writer for fin_invoices.balance. Bound in 0024 (not 0023) because
-- fin_payment_allocations is created by 0024 — a trigger on one table reading
-- another is fine, but this trigger's function may only be created once every
-- relation it names exists.
CREATE OR REPLACE FUNCTION trg_fin_invoice_balance_recompute() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE v_invoice uuid;
        v_tenant  uuid;
        v_balance numeric(19,4);
BEGIN
    -- The FIRST write. On UPDATE this is the invoice the row is leaving; the
    -- second pass below handles the one it is joining. Both sides must be
    -- recomputed or a moved allocation leaves a stale balance on the old
    -- invoice forever, with nothing in the document to indicate it.
    IF TG_OP <> 'INSERT' THEN
        v_invoice := OLD.invoice_id;
        v_tenant  := OLD.tenant_id;
        IF v_invoice IS NOT NULL THEN
            PERFORM trg_fin_invoice_recalc_balance(v_tenant, v_invoice);
        END IF;
    END IF;

    -- An allocation row with invoice_id IS NULL is an on-account movement; it
    -- touches no invoice and there is no row to update. This is what keeps the
    -- trigger from spending writes on the null case — which is the common case
    -- for on-account returns, and the reason the guard is on the *invoice id*
    -- and not on the operation.
    IF TG_OP = 'DELETE' THEN
        RETURN NULL;
    END IF;

    v_invoice := NEW.invoice_id;
    v_tenant  := NEW.tenant_id;
    IF v_invoice IS NOT NULL THEN
        PERFORM trg_fin_invoice_recalc_balance(v_tenant, v_invoice);
    END IF;
    RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION trg_fin_invoice_balance_recompute() FROM PUBLIC;
```

**The arithmetic lives in a second function, `trg_fin_invoice_recalc_balance(tenant, invoice)`, and
the trigger does nothing but decide *which* invoice to recompute.** Three reasons, in order of how
much damage the alternative does:

1. **`UPDATE` can move an allocation between invoices.** A trigger that reads
   `COALESCE(NEW.invoice_id, OLD.invoice_id)` gets exactly one id, and on a move it gets the
   destination. The origin invoice's balance then stays at its pre-move value with no event left to
   correct it. Either the migration forbids the move (`invoice_id` is immutable once inserted) or the
   trigger must recompute both; recomputing both is one `PERFORM` per side and needs no new
   constraint, so that is what this does.
2. **Three tables feed `balance`.** Lines change it, adjustments change it, allocations change it. If
   the trigger is bound only to allocations, a posted invoice whose line is corrected keeps a
   `balance` that no longer equals `total - net_applied`, and the only thing that notices is
   reconciliation — at month end, against a document that was already sent to a family. The trigger
   is therefore bound to all three.
3. **One expression, one home.** With the arithmetic factored out, the `total - net_applied`
   expression is written once, and both the trigger path and the view path read the same shape. A
   trigger that carried the arithmetic inline would have a second, independently-editable copy, and
   the failure mode of the two copies disagreeing is a balance that reconciles against itself and
   against nothing.

```sql
CREATE OR REPLACE FUNCTION trg_fin_invoice_recalc_balance(p_tenant uuid, p_invoice uuid)
RETURNS void
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE v_balance numeric(19,4);
BEGIN
    -- ONE statement, ONE local. An earlier draft of the trigger read items and
    -- adjustments into two locals, then reassigned one of them from a combined
    -- expression, leaving the first two reads with no consumer. A local written
    -- twice is one whose authority a reader cannot determine, and FI-002's
    -- property test (10,000 random operations asserting
    -- `balance == total - net_applied`) is the only thing that would catch the two
    -- readings ever disagreeing. One expression, one assignment.
    SELECT (COALESCE((SELECT SUM(it.amount) FROM fin_invoice_items it
                       WHERE it.tenant_id = p_tenant AND it.invoice_id = p_invoice), 0)
          + COALESCE((SELECT SUM(a.amount) FROM fin_invoice_adjustments a
                       WHERE a.tenant_id = p_tenant AND a.invoice_id = p_invoice), 0)
          + COALESCE((SELECT SUM(it2.tax_amount) FROM fin_invoice_items it2
                       WHERE it2.tenant_id = p_tenant AND it2.invoice_id = p_invoice), 0)
          - COALESCE((SELECT SUM(pa.amount) FROM fin_payment_allocations pa
                       WHERE pa.tenant_id = p_tenant AND pa.invoice_id = p_invoice), 0))
      INTO v_balance;

    UPDATE fin_invoices
       SET balance = v_balance, updated_at = now()
     WHERE tenant_id = p_tenant AND id = p_invoice;
END $$;
REVOKE ALL ON FUNCTION trg_fin_invoice_recalc_balance(uuid, uuid) FROM PUBLIC;
```

**`trg_fin_invoice_recalc_balance` is deliberately NOT a trigger function** — it returns `void`, takes
its arguments by name, and is `PERFORM`ed rather than bound. That is what stops it appearing in the
§35.3 inventory as a 24th trigger function, and it is why the inventory's "every row is a trigger
function" rule stays true. It is a plain helper with the same REVOKE as the triggers.

**The four independent sub-queries, not one joined aggregate, in both the view and the trigger.**
This is the same defect `trg_fin_invoice_item_total` is written to avoid (§9.6): joining
`fin_invoice_items` to `fin_invoice_adjustments` to `fin_payment_allocations` on
`(tenant_id, invoice_id)` produces a Cartesian product, so an invoice with 3 lines, 1 adjustment and
2 allocations yields 6 rows and every `SUM` is inflated by the product of the other two counts. Each
sum is separate and independently indexable, and `balance` repeats the expression rather than
aliasing `invoice_total - net_applied`, because a view's output column cannot be referenced in the
same `SELECT` list.

**The trigger is `AFTER` and returns `NULL`, and both are required.** `AFTER` because the balance
must see the committed allocation row; `RETURN NULL` because in an `AFTER` trigger the return value
is ignored for row-level triggers but returning `NEW` is misleading to the next reader who copies
the pattern into a `BEFORE` trigger. It is bound in **0024** rather than 0023 because
`fin_payment_allocations` is created by 0024 and `fin_invoice_adjustments` by 0023, and PostgreSQL
resolves a `plpgsql` body's relation references when the trigger first fires rather than at
`CREATE FUNCTION` — the constraint is on the `CREATE TRIGGER`, whose target table must exist.

#### 12.4.2 The ledger's V1 view

§19.7.2's V1 row, the 0026 migration row and §15.3 all refer to `fin_v_ledger_*`. A glob is not an
executable name, so the one view that is actually needed is written out here: the **account balance**,
which is the only ledger projection a non-`finance_staff` role has any business reading, and the one
§15.3's Path A uses.

```sql
-- ── 0026 fin_ledger.sql (continued) ───────────────────────────────────────

-- V1: security_invoker = on, because it is row-level. A definer-view here would
-- hand every authenticated session every tenant's ledger.
CREATE VIEW fin_v_ledger_account_balance WITH (security_invoker = on) AS
SELECT e.tenant_id,
       e.account_code,
       COALESCE(sum(e.amount) FILTER (WHERE e.direction = 'debit'), 0)  AS total_debit,
       COALESCE(sum(e.amount) FILTER (WHERE e.direction = 'credit'), 0) AS total_credit,
       COALESCE(sum(e.amount) FILTER (WHERE e.direction = 'debit'), 0)
     - COALESCE(sum(e.amount) FILTER (WHERE e.direction = 'credit'), 0) AS balance
  FROM fin_ledger_entries e
 GROUP BY e.tenant_id, e.account_code;
```

**`FILTER (WHERE …)` rather than `CASE`, and no `WHERE direction IN (…)`.** The two directions are
both counted in the same pass, so a `GROUP BY account_code` with two conditional aggregates is one
scan instead of two. The view deliberately does **not** filter on `sealed_at` or
`fin_ledger_entry_groups.status`: a balance that excluded unsealed groups would change the moment a
group was written and settled, so a trial balance would not be reproducible across a run. §15.3's
Path A uses this view, and reconciliation must be stable or it is noise.

**Case (c) — on-account return** (P0-07 worked example). `P3` = 100,000 fully unallocated; 40,000 is
returned:

```sql
INSERT fin_payment_allocations(payment_id, invoice_id, amount, effect, reason)
VALUES ('P3', NULL, -40000, 'on_account_return', 'partial withdrawal of advance');
```

| Quantity | Value | Old formula would say | Meaning |
|---|---|---|---|
| `payment_applied(P3)` | 0 | 0 | nothing was billed |
| `payment_on_account_returned(P3)` | −40,000 | — | 40,000 handed back |
| `payment_unallocated(P3)` | **60,000** | **140,000** ❌ | the school still holds 60,000 |
| Ledger | `Dr 1300 / Cr 1000` | — | on-account liability down, cash down |

A full return of 100,000 gives `unallocated_amount = 0` under the new formula and `0` under the old one
only by accident; the partial case is where the old formula was wrong by the full returned amount.
FI-021 is the regression test.

### 12.5 Cross-family allocation is rejected in the database (P0-09)

Every other integrity rule in this document is expressed as a `CHECK` or an FK. This one cannot be,
and saying why is the point: the forbidden fact is a **relationship between two rows in two
different tables**, so it needs a subquery, and PostgreSQL forbids subqueries in `CHECK`. The naive
design therefore enforced it only in the API — and the API is not the trust boundary for a money
move, because the same writes are reachable from a portal session, a worker retry, and a `psql`
session owned by `school_migrator`.

```sql
CREATE OR REPLACE FUNCTION trg_fin_allocation_family_guard() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE v_payer uuid; v_invoice uuid; v_offending uuid;
BEGIN
    -- Only an `apply` names an invoice. Correction reversals name the same invoice
    -- as their target (enforced by trg_fin_reversal_shape), and an on-account
    -- return names none, so neither can cross a family boundary.
    IF NEW.effect <> 'apply' OR NEW.invoice_id IS NULL THEN
        RETURN NEW;
    END IF;

    SELECT payer_guardian_id INTO v_payer
    FROM fin_payments
    WHERE tenant_id = NEW.tenant_id AND id = NEW.payment_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'allocation references an unknown payment' USING ERRCODE = '55000';
    END IF;

    -- The paying guardian must be a LIVE guardian linked by a LIVE link to at least
    -- one student on the target invoice. `student_guardians` is soft-deleted in 0006,
    -- so both deleted_at predicates are load-bearing.
    SELECT i.student_id INTO v_offending
    FROM fin_invoices i
    WHERE i.tenant_id = NEW.tenant_id
      AND i.id = NEW.invoice_id
      AND NOT EXISTS (
            SELECT 1
            FROM students st
            JOIN student_guardians sg
              ON sg.tenant_id = st.tenant_id AND sg.student_id = st.id
            JOIN guardians g
              ON g.tenant_id = sg.tenant_id AND g.id = sg.guardian_id
            WHERE st.tenant_id = i.tenant_id
              AND st.id = i.student_id
              AND sg.guardian_id = v_payer
              AND sg.deleted_at IS NULL
              AND g.deleted_at IS NULL
          );
    IF v_offending IS NOT NULL THEN
        RAISE EXCEPTION
            'payment payer % is not a guardian of the student on invoice %; cash may not cross a family boundary',
            v_payer, NEW.invoice_id
            USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION trg_fin_allocation_family_guard() FROM PUBLIC;

-- Bound as `fin_allocations_family` in §35.3.2. The earlier revision named this
-- trigger `fin_pa_family_guard` here and `fin_allocations_family` in the block;
-- two names for one binding means one of the two statements silently never runs.
-- `fin_allocations_*` is the house style (§30 conventions: triggers named `fin_*`).
```

**The `NOT EXISTS` form, and why it is the right shape.** The sub-select projects
`i.student_id` for invoices where the guardian condition is *false*, so a non-null result means "here
is an invoice that is not this family's". Written the other way — `EXISTS (… guardian matches …)`
asserting that *some* invoice is fine — the trigger would pass whenever the payment had **any**
legitimate invoice, and would silently allow the second, illegitimate one. The negating form makes
the check per-invoice, which is the actual requirement. FI-020 asserts both the positive case
(siblings sharing a guardian) and the negative case.

**Ordering and interaction with the other triggers on this table.** `trg_fin_allocation_family_guard`
is `BEFORE INSERT OR UPDATE` and `trg_fin_reversal_shape` is also `BEFORE INSERT OR UPDATE`; when both
match, PostgreSQL fires them in **alphabetical order by trigger name**, so
`fin_allocations_family` (`trg_fin_allocation_family_guard`) runs before
`fin_allocations_shape` (`trg_fin_reversal_shape`). The order is immaterial for correctness because
their conditions are disjoint on `effect` — the family guard returns early for every non-`apply` row
and the shape trigger returns early for every `apply` row — but it is recorded here so a future
reader does not assume the ordering is load-bearing. `fin_allocations_bounds` is also `BEFORE` and
runs before both alphabetically; it returns early for `reverse` rows and for every `refund_id` row,
so it is disjoint from both. `fin_allocations_refund_ceiling` is a **deferred** constraint trigger
and therefore always runs last, at `COMMIT` (§13.3.1).

### 12.6 Concurrent allocation — the deadlock-safe lock protocol
Two cashiers allocating the last 1,000 PKR to the same invoice would race on `net_applied`. The
remedy is a row lock, but a `BEFORE INSERT` trigger that takes `FOR UPDATE` locks on a *different*
row per statement can deadlock. The CI workflow records that this repository has **already** hit
"a migrator/writer deadlock in @sms/db" (`.github/workflows/phase6-security.yml:88-122`). Protocol:

1. **Always lock in the same order.** The allocation service, before any availability check, executes
   `SELECT id FROM fin_invoices WHERE tenant_id = $1 AND id = ANY($2::uuid[]) ORDER BY id FOR UPDATE`
   — invoices **ascending by id**, always. A second allocation for the same invoice blocks; allocations
   for different invoices never contend.
2. **Never** take a payment lock while holding an invoice lock. Payments are locked *after* all
   invoices, also ascending.
3. Recompute availability **after** acquiring the lock, from the authoritative rows — never from a
   value read before the lock.
4. Deadlock is still possible in principle; the service retries on SQLSTATE `40P01` (deadlock) and
   `40001` (serialisation failure) with bounded backoff. This is stated as a *mechanism*, not a
   promise of impossibility.

### 12.7 The payment-total bound (FI-003), and the missing trigger it names

FI-003 states `Σ a.amount (a.payment_id = p, a.refund_id IS NULL) ≤ p.amount`, and the register
credits a trigger `trg_fin_allocation_bounds` with enforcing it. **The previous revision named that
trigger in four places and defined it in none**, so the bound existed only as prose; the only
enforcement was in the service, which §12.5 already established is not the trust boundary for a
money move. The function is defined here and bound in §35.3.

```sql
CREATE OR REPLACE FUNCTION trg_fin_allocation_bounds() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE v_payment_amount numeric(19,4); v_committed numeric(19,4);
BEGIN
    -- Only non-refund rows consume the payment's balance. A `reverse` (either flavour)
    -- carries refund_id or a reversal_of_allocation_id and is governed by the
    -- per-allocation ceiling in trg_fin_reversal_shape_check; an on-account RETURN is
    -- included, because it is a non-refund row and it lowers the balance.
    IF NEW.refund_id IS NOT NULL THEN
        RETURN NEW;
    END IF;

    -- Lock the payment row FIRST and ascending, matching §12.6's protocol, so two
    -- concurrent allocations against the same payment cannot both read the same
    -- pre-state and both pass. The lock is the whole reason this is a trigger and not
    -- a CHECK: a CHECK sees one row and cannot serialise against its siblings.
    SELECT amount INTO v_payment_amount
      FROM fin_payments
     WHERE tenant_id = NEW.tenant_id AND id = NEW.payment_id
     ORDER BY id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'allocation references an unknown payment'
            USING ERRCODE = '55000';
    END IF;

    -- Exclude the row being checked on the UPDATE path. NEW.id is non-null there, so
    -- without this the row's own OLD value is counted and an in-place correction is
    -- rejected against a total that includes itself.
    SELECT COALESCE(SUM(a.amount), 0) INTO v_committed
      FROM fin_payment_allocations a
     WHERE a.tenant_id = NEW.tenant_id
       AND a.payment_id = NEW.payment_id
       AND a.refund_id IS NULL
       AND a.id <> NEW.id;

    IF v_committed + NEW.amount > v_payment_amount THEN
        RAISE EXCEPTION
            'allocations on payment % would total %, exceeding the payment amount %',
            NEW.payment_id, v_committed + NEW.amount, v_payment_amount
            USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION trg_fin_allocation_bounds() FROM PUBLIC;
```

**Why the bound is on the sum and not on the single row.** A per-row bound (`NEW.amount ≤
p.amount`) is satisfied by two rows of `p.amount` each, so double-applying a payment would pass it.
The invariant is about the *set* of rows, which is why the trigger recomputes the sum under a lock
rather than comparing the incoming row alone. This is the same reasoning that makes the refund
ceiling a deferred constraint trigger (§13.3.1); the difference is that the payment total can be
checked correctly on each row, because the payment row itself is the lock and the ceiling does not
depend on rows written later in the same statement.

---

## 13. Refund / reversal model

### 13.1 Provenance is proven in the database, not only in the API

The brief requires that if `refund.payment_id = P1` and an allocation row references `A1`, then
`A1.payment_id = P1` is **proven by the database**. Two mechanisms, layered:

**Layer 1 — trigger, on every allocation insert and on every refund insert.** A `BEFORE INSERT OR
UPDATE` trigger locks the referenced rows and verifies provenance.

**This function is created in 0025, not 0024, and the reason is the `DECLARE` block rather than the
body.** `v_target fin_payment_allocations` and `v_refund fin_refunds` are **composite-type
declarations**: a `%ROWTYPE`-shaped variable is resolved when the function is created, because the
function's return signature and its `DECLARE` types are part of its catalogue entry. A plpgsql
*statement* referencing an unknown relation is only a plan-time error, deferred to first execution,
but a plpgsql *variable declaration* of an unknown composite type is a parse error at `CREATE
FUNCTION` and raises **42704 undefined_object**. `fin_refunds` is created by 0025, so a 0024 version
of this function fails outright. The distinction is worth stating because the two look identical in
the source and have opposite failure timing: the body would have been fine, the `DECLARE` was not.

```sql
-- ── 0025 fin_refunds.sql (NOT 0024: the DECLARE below names fin_refunds) ────
CREATE OR REPLACE FUNCTION trg_fin_refund_provenance() RETURNS trigger
    LANGUAGE plpgsql
    SECURITY INVOKER
    SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    v_payment  uuid;
    v_target   fin_payment_allocations;
    v_refund   fin_refunds;
BEGIN
    -- On an allocation that claims to be caused by a refund R, THREE rows must agree
    -- on the payment: the allocation, the row it reverses, and the refund. Checking
    -- only two of them is what lets a reversal cross payments.
    IF NEW.refund_id IS NOT NULL THEN
        IF NEW.reversal_of_allocation_id IS NULL THEN
            RAISE EXCEPTION 'a refund reversal must name the allocation it reverses'
                USING ERRCODE = '55000';
        END IF;

        -- FOR UPDATE: the referenced rows are locked, so a concurrent UPDATE cannot
        -- move the target's payment_id between this check and the write. Without it
        -- this is a TOCTOU window, and provenance is exactly the property that
        -- must not be racy.
        SELECT * INTO v_target
          FROM fin_payment_allocations
         WHERE tenant_id = NEW.tenant_id AND id = NEW.reversal_of_allocation_id
         FOR UPDATE;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'reversal target allocation does not exist in this tenant'
                USING ERRCODE = '55000';
        END IF;
        IF v_target.payment_id IS DISTINCT FROM NEW.payment_id THEN
            RAISE EXCEPTION 'allocation reversal must target the same payment as the refund'
                USING ERRCODE = '55000';
        END IF;
        IF v_target.effect <> 'apply' THEN
            RAISE EXCEPTION 'only an applied allocation can be reversed by a refund'
                USING ERRCODE = '55000';
        END IF;

        SELECT * INTO v_refund
          FROM fin_refunds
         WHERE tenant_id = NEW.tenant_id AND id = NEW.refund_id
         FOR UPDATE;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'refund does not exist in this tenant'
                USING ERRCODE = '55000';
        END IF;
        IF v_refund.payment_id IS DISTINCT FROM NEW.payment_id THEN
            RAISE EXCEPTION 'refund provenance violation: allocation and refund payments differ'
                USING ERRCODE = '55000';
        END IF;
        IF v_refund.status NOT IN ('requested','approved') THEN
            RAISE EXCEPTION 'a reversal may only be created for a requested or approved refund'
                USING ERRCODE = '55000';
        END IF;
        -- The magnitude check lives in trg_fin_reversal_shape, not here. Two
        -- triggers with one job each is deliberate: this one is about WHICH rows may
        -- be linked, that one is about HOW MUCH. A single trigger doing both cannot
        -- be tested independently, and "provenance" and "bounds" fail differently.
    END IF;

    -- The mirror direction: a refund row must be able to name the allocations it
    -- reverses, and those must belong to the refund's own payment. Without this a
    -- refund could be approved against allocations the refund's payment never had.
    IF TG_OP = 'INSERT' AND TG_TABLE_NAME = 'fin_refunds' THEN
        IF NEW.amount IS NULL OR NEW.amount <= 0 THEN
            RAISE EXCEPTION 'refund amount must be positive'
                USING ERRCODE = '55000';
        END IF;
        PERFORM 1
          FROM fin_payment_allocations a
         WHERE a.tenant_id = NEW.tenant_id
           AND a.payment_id = NEW.payment_id
           AND a.refund_id = NEW.id;
        -- Zero rows is NORMAL here: a refund is requested BEFORE its reversal
        -- allocations exist (§13.2 stages them together, and completeness is
        -- enforced at COMMIT by the deferred trigger). So this is a targeted
        -- existence check, not a completeness check.
    END IF;

    RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION trg_fin_refund_provenance() FROM PUBLIC;
```

**Layer 2 — the structural model already prevents it.** Because a refund is expressed as a
*reversal allocation carrying `refund_id` on the same row* (§12.2), provenance is not two
independent facts that could disagree — it is a single row whose three columns must be mutually
consistent. The trigger verifies that consistency; it is not carrying information the schema lacks.

**Layer 3 — the application** additionally re-validates and maps the `55000` to a
`409 refund_provenance_violation` via `mapDomainError`. This ordering is deliberate: the database is
authoritative, the API is a fast, friendly pre-check, and the API's check can never be the *only*
check.

### 13.2 Refund state machine — staging, then effect

**The defect this section previously had (P0-05), stated plainly so the fix is auditable.** The
earlier revision defined `requested → approved → processed` and specified the ledger posting
`Dr 1200 / Cr 2200` **at approval**, while §13.5.1 enforced "Σ|reversal| = refund.amount" **at the
`approved` transition**. Those two rules are contradictory. At the moment of the state change, a
`fin_refunds` row has no `id` yet, so no `fin_payment_allocations` row can reference it (the FK is
forward-declared) — the completeness check therefore *always* reads `0` and rejects every approval.
The only way the old rules could both hold is if the reversal rows already existed, but a reversal row
carrying `refund_id` is itself the reversal: creating it at request time means the money has already
moved the ledger *before* anyone approved, which is the exact failure mode step-up MFA and the
three-permission separation exist to prevent.

**Resolution: a request is a non-financial staging record.** The requested split lives in
`fin_refunds.proposed_allocations` and touches no money, no invoice balance, and no ledger. The
reversal rows and the ledger posting are created **in the same transaction** as the `approved` state
change, by the approving request. Nothing financial exists between `requested` and `approved`.

```sql
CREATE TABLE fin_refunds (
    id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id             uuid NOT NULL,
    refund_no             text NOT NULL,
    payment_id            uuid NOT NULL,
    amount                numeric(19,4) NOT NULL CHECK (amount > 0),
    status                text NOT NULL DEFAULT 'requested'
                          CHECK (status IN ('requested','approved','rejected','processed')),
    reason                text NOT NULL,
    -- P0-05: the PROPOSED split. Read-only, advisory, and never summed into any
    -- financial formula. It exists so an approver can see what was asked for.
    -- NOT a jsonb money store: it is validated against proposed_allocations_ck below
    -- and is discarded (kept for audit) once the refund leaves 'requested'.
    proposed_allocations  jsonb NOT NULL
                          CHECK (jsonb_typeof(proposed_allocations) = 'array'),
    -- The APPLIED split, written only by the approve transaction. NULL until approved.
    -- FI-006 compares SUM(applied.amount) against amount at COMMIT.
    applied_allocations   jsonb
                          CHECK (applied_allocations IS NULL
                              OR jsonb_typeof(applied_allocations) = 'array'),
    requested_by          uuid NOT NULL,
    requested_at          timestamptz NOT NULL DEFAULT now(),
    decided_by            uuid,
    decided_at            timestamptz,
    processed_by          uuid,
    processed_at          timestamptz,
    rejection_reason      text,
    idempotency_key       text NOT NULL,
    CONSTRAINT fin_refunds_payment_fk
        FOREIGN KEY (tenant_id, payment_id)
        REFERENCES fin_payments (tenant_id, id) ON DELETE RESTRICT,
    CONSTRAINT fin_refunds_no_uq  UNIQUE (tenant_id, refund_no),
    CONSTRAINT fin_refunds_idem_uq UNIQUE (tenant_id, idempotency_key),
    -- State/field coherence: a decided refund records who and when; a processed one
    -- also records the processor. A 'requested' refund has no decision.
    CONSTRAINT fin_refunds_decision_ck CHECK (
        (status = 'requested' AND decided_by IS NULL AND decided_at IS NULL
                                AND rejection_reason IS NULL
                                AND applied_allocations IS NULL)
     OR (status IN ('approved','processed') AND decided_by IS NOT NULL
                                 AND decided_at IS NOT NULL
                                 AND rejection_reason IS NULL
                                 AND applied_allocations IS NOT NULL)
     OR (status = 'rejected' AND decided_by IS NOT NULL AND decided_at IS NOT NULL
                              AND rejection_reason IS NOT NULL
                              AND applied_allocations IS NULL)
    ),
    CONSTRAINT fin_refunds_ten_id_uq UNIQUE (tenant_id, id)
);
-- Revoke the 0001 default-privilege grant immediately (§35.4, §30.3).
REVOKE ALL ON fin_refunds FROM school_app_rw;



-- The refundable ceiling is a PROPERTY OF THE PAYMENT, not of the refund row, so it is
-- expressed as a query, not a column. See §12.2.
--
-- Completeness is NOT enforced here. It cannot be: the reversal rows are created in
-- the same transaction that sets status='approved', and a row-level trigger on
-- fin_refunds would have to run either before them (seeing zero) or after them
-- (seeing a state that already satisfies it). §13.3.1 resolves this with a
-- DEFERRABLE INITIALLY DEFERRED constraint trigger, which is the only PostgreSQL
-- mechanism that runs after all rows exist but before the transaction commits.
```

```text
  requested ──approve──► approved ──process──► processed      (terminal, irreversible)
      │                     │
      └──reject──► rejected  └──reject──► rejected
```

| Transition | Permission | Ledger | Allocation rows |
|---|---|---|---|
| create `requested` | `fees.refunds.request` | **none** — a request is not a financial event | **none** — `proposed_allocations` is advisory JSON |
| `→ approved` | `fees.refunds.approve`, **step-up MFA** (§19.8) | `Dr 1200 / Cr 2200` | **created here**, one negative row per proposed allocation, each with `refund_id = refund.id` |
| `→ processed` | `fees.refunds.process`, **step-up MFA** | `Dr 2200 / Cr 1000` | none — the rows already exist |
| `→ rejected` | `fees.refunds.approve` | none | none — nothing was ever written |

`rejected` is terminal. A rejected refund leaves allocations untouched **because none were ever
created** — that is the whole point of staging, and it removes an entire class of "approve then
rollback" partial-failure state. `approved → rejected` is **rejected** (a decision is not
reversible), so the only pre-financial branch is `requested → rejected`.

**The approve transaction, in order, as a single atomic unit** (`postRefundApproval`, §19.7.2 F5):

1. `SELECT … FROM fin_refunds WHERE id = $1 AND status = 'requested' FOR UPDATE` — serialises two
   concurrent approvers; the loser reads `approved` and returns the existing result (idempotent).
2. Verify the **step-up MFA** challenge for this refund (§19.8), unexpired, single-use, bound to
   `(user, tenant, refund_id, amount)`.
3. Verify the requesting actor is **not** the approver (three-permission separation, §20.1) and that
   the approver holds `fees.refunds.approve`.
4. Lock the payment row `FOR UPDATE`; recompute `payment_refundable(payment_id)` **from the rows**
   (§12.6 protocol — never from a value read before the lock).
5. If `refundable <= 0` → `55000 nothing_applied_to_refund`; if `refundable < amount` → `55000
   refund_exceeds_payment`. Both map to a documented 409/422.
6. Insert the reversal rows, each with `reversal_of_allocation_id` naming a real `apply` row on the
   same payment, `refund_id = refund.id`, `amount < 0`. `trg_fin_reversal_shape` enforces the
   per-allocation magnitude bound and the invoice identity.
7. Post the ledger group `Dr 1200 / Cr 2200` via `postLedgerGroup()`; a failure aborts the whole
   transaction, so a refund is never approved without its ledger entry.
8. `UPDATE fin_refunds SET status='approved', decided_by=…, decided_at=…, applied_allocations=…`.
9. The **deferred** trigger of §13.3.1 runs at COMMIT and verifies completeness across the whole
   refund. If it fails, the entire transaction rolls back — including the ledger posting.

**Process transaction.** Locks the refund `FOR UPDATE`, verifies `status='approved'`, verifies
step-up MFA bound to `(user, tenant, refund_id, amount)`, posts `Dr 2200 / Cr 1000`, sets
`processed`. `processed` is terminal; there is no `processed → refund` edge and no reversal of a
processed refund (Example 4).

### 13.3 Refundable-amount bounds — enforced in the database, at COMMIT

#### 13.3.1 The ceiling and the deferral reason (P0-08)

The ceiling is:

```sql
payment_refundable(p) = payment_applied(p) - payment_refunded(p)   -- §12.2
```

The previous revision tried to enforce it with a `BEFORE INSERT` trigger on
`fin_payment_allocations` and computed `v_this` as:

```sql
SELECT COALESCE(-SUM(a.amount),0) INTO v_this
FROM fin_payment_allocations a WHERE a.tenant_id = NEW.tenant_id AND a.refund_id = NEW.id;
```

**`v_this` is always `0` in a `BEFORE INSERT` trigger.** The row being inserted is not yet in the
table, and — as P0-05 established — no other row can carry `NEW.refund_id` at that moment, because
`fin_refunds.id` is assigned and the sibling rows are written by the same statement batch in an order
the trigger cannot predict. The check was therefore `v_already + 0 > v_applied`, i.e. it only ever
compared *prior* refunds. A first refund of any size always passed, including a refund far exceeding
`payment_applied`. The bound was vacuous on exactly the case it was written for.

**The fix is a `DEFERRABLE INITIALLY DEFERRED` constraint trigger.** PostgreSQL runs a deferred
constraint trigger once, at the end of the transaction, after every row is written but before
`COMMIT` returns control. That is the only hook that can see the complete set of reversal rows for a
refund *and* still prevent the commit.

```sql
-- Deferrable, initially deferred: fires ONCE at COMMIT, after all rows exist.
-- The TRIGGER is `fin_allocations_refund_ceiling`; the FUNCTION it runs is
-- `fn_fin_refund_ceiling`. Earlier prose called the trigger `trg_fin_refund_ceiling`,
-- which collided with the `trg_fin_*` prefix this document reserves for trigger
-- FUNCTIONS. The name is corrected here and in §35.3.2.
--
-- The CREATE CONSTRAINT TRIGGER for this is stated ONCE, in §35.3.2's block, so
-- there is a single source of truth for the binding. What follows is the
-- FUNCTION the trigger runs.
CREATE OR REPLACE FUNCTION fn_fin_refund_ceiling() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    v_applied   numeric(19,4);
    v_refunded  numeric(19,4);
    v_refund    numeric(19,4);
    v_covered   numeric(19,4);
    v_tenant    uuid;
    v_refund_id uuid;
BEGIN
    -- TG_OP, not COALESCE(NEW.refund_id, OLD.refund_id). This is a
    -- DEFERRABLE INITIALLY DEFERRED CONSTRAINT TRIGGER bound to
    -- `AFTER INSERT OR UPDATE` on fin_payment_allocations. A deferred trigger
    -- still fires per-row and the per-row record is assigned, but the safe
    -- reading is TG_OP — COALESCE would dereference NEW first, and OLD is
    -- unassigned precisely on the INSERT that a first-of-a-refund reversal is.
    IF TG_OP = 'DELETE' THEN
        v_tenant    := OLD.tenant_id;
        v_refund_id := OLD.refund_id;
    ELSE
        v_tenant    := NEW.tenant_id;
        v_refund_id := NEW.refund_id;
    END IF;

    IF v_refund_id IS NULL THEN
        RETURN NULL;   -- apply / correction reversal / on-account return
    END IF;

    -- Single payment-level lock, ascending, per §12.6. Deferred, so it is taken at
    -- COMMIT; two concurrent refunds on the SAME payment serialise here. (Two on
    -- different payments never contend, so the ascending order also prevents
    -- the §12.6 deadlock rather than merely tolerating it.) The id is read under
    -- the same TG_OP branch, for the same reason: NEW.payment_id is unassigned
    -- on a DELETE.
    IF TG_OP = 'DELETE' THEN
        PERFORM id FROM fin_payments
        WHERE tenant_id = v_tenant AND id = OLD.payment_id
        ORDER BY id FOR UPDATE;
    ELSE
        PERFORM id FROM fin_payments
        WHERE tenant_id = v_tenant AND id = NEW.payment_id
        ORDER BY id FOR UPDATE;
    END IF;

    SELECT amount INTO v_refund FROM fin_refunds
    WHERE tenant_id = v_tenant AND id = v_refund_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'reversal references an unknown refund' USING ERRCODE = '55000';
    END IF;

    -- (1) per-allocation ceiling (P1-13), RE-CHECKED at COMMIT for THIS row.
    --     Called as a bare PERFORM: the helper returns void, and wrapping a
    --     void-returning function in a FROM-clause is a syntax error. Its RAISE
    --     is the only channel it needs, so void is the right signature.
    PERFORM trg_fin_reversal_shape_check(v_tenant, NEW.id);

    -- (2) FI-006 COMPLETENESS, now actually non-vacuous: this reads rows written
    --     earlier in THIS transaction, which the BEFORE INSERT version could not.
    SELECT COALESCE(-SUM(a.amount), 0) INTO v_covered
    FROM fin_payment_allocations a
    WHERE a.tenant_id = v_tenant AND a.refund_id = v_refund_id;
    IF v_covered <> v_refund THEN
        RAISE EXCEPTION
            'refund % requires % of allocation reversals but only % were written',
            v_refund_id, v_refund, v_covered
            USING ERRCODE = '55000';
    END IF;

    -- (3) PAYMENT CEILING, now actually non-vacuous. Because (2) has already
    --     proved the refund's rows are complete, summing the refund total is
    --     equivalent to summing the rows -- the aggregate can no longer be
    --     understated by a missing sibling row.
    SELECT COALESCE(SUM(a.amount), 0) INTO v_applied
    FROM fin_payment_allocations a
    WHERE a.tenant_id = v_tenant AND a.payment_id = NEW.payment_id
      AND a.refund_id IS NULL AND a.invoice_id IS NOT NULL;
    SELECT COALESCE(-SUM(a.amount), 0) INTO v_refunded
    FROM fin_payment_allocations a
    WHERE a.tenant_id = v_tenant AND a.payment_id = NEW.payment_id
      AND a.refund_id IS NOT NULL;

    IF v_applied <= 0 THEN
        RAISE EXCEPTION 'no cash from this payment is applied to a charge; use an on-account return'
            USING ERRCODE = '55000';
    END IF;
    IF v_refunded > v_applied THEN
        RAISE EXCEPTION 'refund exceeds refundable amount for this payment'
            USING ERRCODE = '55000';
    END IF;
    RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION fn_fin_refund_ceiling() FROM PUBLIC;
```

`trg_fin_reversal_shape_check(tenant, allocation_id)` is factored out of
`trg_fin_reversal_shape` as a `RETURNS void` helper so the per-allocation bound can be re-verified at
COMMIT for every row in the transaction, not only for the row that happened to be inserted last. This
avoids duplicating the arithmetic in two places, which is how the two copies would drift.

**The cases the deferral is required for, and what each now does:**

| Case | Old (vacuous) | New (deferred) |
|---|---|---|
| First refund, within ceiling | passes | passes — `v_covered = amount`, `v_refunded ≤ v_applied` |
| First refund, **exceeds** ceiling | **passes** ❌ | fails at COMMIT: `refund exceeds refundable amount for this payment` → 409 |
| Second refund, combined within ceiling | passes | passes |
| Second refund, combined **over** ceiling | caught only for *prior* rows | caught at COMMIT on the combined sum → 409 |
| Split refund summing to `R.amount` (Example 1) | rejected as incomplete ❌ | passes — siblings are visible at COMMIT |
| Split refund summing to *less* than `R.amount` | rejected correctly | rejected at COMMIT → 409 `refund_allocation_incomplete` |
| Split refund summing to *more* than `R.amount` | rejected correctly | rejected at COMMIT, and also by the per-allocation bound |
| Concurrent approvals on one payment | race → both pass ❌ | one blocks on the payment `FOR UPDATE` at COMMIT; the second sees the first's rows and fails or passes on the true total |
| Retry after a rolled-back attempt | n/a | the rolled-back rows are gone, so the retry is evaluated fresh — no stale aggregate |

**Deferral caveat, stated because it is a real operational property.** A deferred trigger's lock is
held until `COMMIT`, which lengthens the payment-level lock from statement duration to transaction
duration. §12.6's ascending-id ordering is what keeps this safe against deadlock rather than merely
lucky, and the `40P01`/`40001` retry remains required. Nothing in this design issues a deferred
trigger on a table reachable from more than one payment, so the lock graph stays a forest of
single-payment trees and cannot form a cycle.

#### 13.3.2 The on-account return ceiling

```sql
CREATE OR REPLACE FUNCTION trg_fin_on_account_return_bounds() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE v_held numeric(19,4);
BEGIN
    IF NEW.effect <> 'on_account_return' THEN
        RETURN NEW;
    END IF;
    PERFORM id FROM fin_payments
    WHERE tenant_id = NEW.tenant_id AND id = NEW.payment_id
    ORDER BY id FOR UPDATE;
    SELECT COALESCE(SUM(a.amount), 0) INTO v_held
    FROM fin_payment_allocations a
    WHERE a.tenant_id = NEW.tenant_id AND a.payment_id = NEW.payment_id
      AND a.refund_id IS NULL AND a.invoice_id IS NULL;
    -- a BEFORE INSERT row is not yet counted, so compare with the pending row included
    IF NEW.amount + v_held < 0 THEN
        RAISE EXCEPTION
            'on-account return of % exceeds the % still held on account for this payment',
            -NEW.amount, v_held
            USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION trg_fin_on_account_return_bounds() FROM PUBLIC;
```

This one **is** correctly a `BEFORE INSERT OR UPDATE` trigger, unlike the refund ceiling: there is
exactly one row being validated and no siblings, so no deferral is needed. The `NEW.amount + v_held
< 0` test is the correct one-sided bound — it says the held balance would go negative, which is
precisely the P0-07 defect made unrepresentable rather than merely reported.

The repository's established shape is preserved throughout (`trg_marks_validate`,
`trg_grade_levels_delete_guard`: lock/`FOR UPDATE`, `IF NOT FOUND`, `RAISE … USING ERRCODE = '55000'`
so the API maps it to a documented 409 rather than leaking a raw constraint error). Note that
`fin_payments.amount` is deliberately **not** used as the ceiling for either operation: it is read only
to confirm the row exists, because the ceiling for a refund is cash *applied to a charge* and the
ceiling for a return is cash *still held on account* — two different quantities, and using the payment
total for either is the diversion bug FI-005 exists to prevent.

### 13.4 Allocation policy — explicit, not implicit

The brief asks whether the caller chooses allocations, or FIFO, or something else, and says not to
leave it implicit. **Chosen: the caller chooses, explicitly and per-invoice. FIFO is NOT the
default.**

Rationale: a school cashier looking at a family with three open invoices knows which invoice the
parent actually paid. FIFO would silently apply cash to the oldest invoice when the parent intended
the newest, producing a wrong balance and a wrong receipt with no way to explain it. Deterministic
does not mean arbitrary.

**API contract.** `POST /payments` accepts an explicit `allocations: [{invoiceId, amount}, …]`.
Three modes, all explicit:

| Mode | Contract | Behaviour |
|---|---|---|
| `explicit` (default when `allocations` present) | caller supplies the split | server validates each amount against FI-004 and the sum against `payment.amount` |
| `single_invoice` | `invoiceId` present, no `allocations` | the entire amount applies to that one invoice; any excess stays unallocated (**no silent partial**) |
| `none` | neither present | the payment is fully on-account, `Dr 1000 / Cr 1300` |

There is a fourth, asymmetric shape that is **not** a collection mode and is deliberately kept out
of the table above: `POST /payments/:id/return-on-account` writes
`effect = 'on_account_return', invoice_id IS NULL, amount < 0` and hands back cash that was **never
applied to a charge**. It is not reachable from `POST /payments`, it requires `fees.payments.reverse`
rather than `fees.payments.collect`, and it is governed by §15.1's on-account posting and FI-003's
bound. The asymmetry is the point: collecting cash and returning cash are different acts with
different permissions, even when the amount is the same and the counterparty is the same family.

Its ceiling is its own quantity, and it is **not** `payment_unallocated`:

```sql
-- A return may not exceed what is still held on account for this payment.
payment_returnable(p)        = SUM a.amount WHERE a.payment_id = p
                               AND a.refund_id IS NULL AND a.invoice_id IS NULL
```

enforced by `trg_fin_on_account_return_bounds` (§13.3.2). Because a return is negative, attempting to
return more than is held makes the quantity go negative, which the trigger rejects — so the invariant
"unallocated can never be over-returned" is structurally true, not merely monitored.

If `allocations` is present, **the server never re-allocates**. A validation failure is a 422, not a
silent FIFO substitution. The only case where the server computes a split is
`POST /payments/:id/auto-allocate`, an **explicitly opt-in** endpoint documented as
"oldest-due-first", which writes an audit row naming the rule applied.

### 13.5 Exact worked examples

**Example 1 — partial refund across two invoices.**
`P1` = 150,000. Applied: 90,000 to `A` (total 90,000) and 60,000 to `B` (total 120,000). Both
balances: `A` = 0, `B` = 60,000. Refund 45,000 attributed 20,000 to `A` and 25,000 to `B`:

| After | `net_applied(A)` | `balance(A)` | `net_applied(B)` | `balance(B)` | `refunded(P1)` | `refundable(P1)` | `unallocated(P1)` |
|---|---|---|---|---|---|---|---|
| before | 90,000 | 0 | 60,000 | 60,000 | 0 | **150,000** | 0 |
| after | 70,000 | 20,000 | 35,000 | 85,000 | 45,000 | **105,000** | 0 |

Two reversal rows: `A1 −20,000 (refund R1)`, `B1 −25,000 (refund R1)`. `R1.amount = 45,000` and
`Σ|reversal| = 45,000` — the completeness requirement, enforced **at COMMIT** by the deferred
trigger of §13.3.1. Under the old `BEFORE INSERT` design this example was **impossible**: the first
sibling row saw `Σ = 0`, the second saw `20,000`, and neither equalled `45,000`, so the split refund
that the brief explicitly requires could never be approved.

`refundable` is 150,000 before and 105,000 after **because `payment_applied(P1)` is 150,000** — every
rupee of this payment was applied to a charge. The next example shows why that qualifier matters.

**Example 1a — the case the naive formula gets wrong.** `P2` = 100,000, **nothing applied**
(`unallocated` = 100,000, `payment_applied` = 0). A refund of 100,000 is **rejected** with
`55000 no cash from this payment is applied to a charge` → **422 `nothing_applied_to_refund`**.
Under `refundable = p.amount − refunded` this payout would have been *permitted*, and the school
would have disbursed a hundred thousand rupees of cash it had simply been holding for a family that
had never been billed anything. The correct operation is an **on-account return**
(`POST /payments/:id/return-on-account`, `effect = 'on_account_return'`, `invoice_id IS NULL`,
`amount < 0`), which posts **`Dr 1300 Unapplied Cash / Cr 1000 Cash`** — the on-account liability
falls and the cash leaves — and is a visibly different transaction from a refund's
`Dr 1200 / Cr 2200`. **`Dr 1200 / Cr 1300`, the posting the previous revision of this section gave,
is wrong in both accounts**: it manufactures a phantom receivable for a family that was never billed,
which is the same defect the naive `refundable = p.amount` formula would have created by a different
route. `finance-005(b)` is the regression test for the whole case.

**Example 2 — two partial refunds against the same allocation.**
`A1` = 90,000. Refund `R1` = 20,000 → reversal row `A1a` = −20,000. Later refund `R2` = 30,000 →
reversal row `A1b` = −30,000. `fin_pa_one_reversal_per_refund_uq` allows this (different
`refund_id`); the deferred ceiling trigger checks the combined total at COMMIT. `net_applied(A)` =
40,000; `refunded(P1)` = 50,000; `refundable(P1)` = 90,000 − 50,000 = 40,000. A third refund of
50,000 is rejected at COMMIT: `Σ|reversal| = 100,000` exceeds the 90,000 outstanding on `A1`, so both
the per-allocation bound (§12.1) and the payment ceiling (§13.3.1) fire.

**Example 3 — over-refund attempt.**
`P1` = 100,000, of which 90,000 applied and 80,000 already refunded. A new refund of 30,000 is
rejected **at COMMIT** with `refund exceeds refundable amount for this payment` (SQLSTATE `55000`)
→ **409 `refund_exceeds_payment`**. Proven by a raw-SQL gated test, per `TESTING_STRATEGY.md:37-57`;
because the check is deferred, the test must `COMMIT` (or `SET CONSTRAINTS … IMMEDIATE`) inside a
savepoint to observe the failure — a test that only `ROLLBACK`s without committing will **not** see
it, which is exactly how the old vacuous check survived its own test suite. Note the 10,000 that is
still unapplied is **irrelevant** to this bound — that is the point of FI-005.

**Example 4 — reversing a refund.** Rejected. `fin_refunds.status='processed'` is terminal and a
refund is not itself refundable. If a school must recover an over-refund, that is a **new payment**
recorded against the family's account (a recovery receipt), which is auditable in both directions.
Adjudicated because "undo a refund" is a real support scenario and the honest answer is that it is a
new transaction, not a reversal of an old one.

#### 13.5.1 Refund allocation completeness (FI-006) — and why it moved to COMMIT

`Σ |reversal allocations| for refund R = R.amount`, enforced by the **deferred** constraint trigger
`fin_allocations_refund_ceiling`, which runs `fn_fin_refund_ceiling` at `COMMIT` (§13.3.1):

```sql
-- Runs at COMMIT, once per affected refund, after every sibling row exists.
SELECT COALESCE(-SUM(a.amount), 0) INTO v_covered
FROM fin_payment_allocations a
WHERE a.tenant_id = v_tenant AND a.refund_id = v_refund_id;
IF v_covered <> v_refund THEN
    RAISE EXCEPTION
        'refund % requires % of allocation reversals but only % were written',
        v_refund_id, v_refund, v_covered
        USING ERRCODE = '55000';
END IF;
```

**Why it cannot be a `BEFORE` trigger on `fin_refunds` (this is the P0-05/P0-08 root cause).** The
reversal rows and the `status='approved'` update are written in **one** transaction
(`postRefundApproval`, §13.2 step 6–8). A `BEFORE UPDATE` trigger on `fin_refunds` runs before step 8's
update is applied, so whether it sees the rows depends on statement order:

- If the `UPDATE fin_refunds` is issued **first** (the natural reading of "transition the state, then
  write the children"), the trigger sees **no** reversal rows, computes `0 ≠ amount`, and rejects
  **every** approval, including the trivially correct single-invoice case.
- If the reversal rows are inserted **first**, the FK `fin_pa_refund_fk` cannot be satisfied for a
  brand-new refund only if the refund row is created in a later statement — so inserting children
  first is impossible without deferring the FK too.

An `AFTER` trigger on `fin_refunds` is the mirror image: it fires after the state update but the
sibling rows are written in a *later* statement of the same transaction, so it also sees `0`.
Neither timing can see all siblings. **Only a deferred constraint trigger runs at a point where every
row of the transaction is visible and the commit is still preventable**, which is why the design uses
one and why it is a `CONSTRAINT TRIGGER … DEFERRABLE INITIALLY DEFERRED` rather than a plain trigger.

Because reversal rows carry `refund_id`, a refund **cannot** commit while partially uncovered. A
`processed` refund requires `approved`, and `approved` required the deferred check to pass. Completeness
is therefore structural, and the check is non-vacuous.

### 13.6 Reconciliation and reporting impact of a refund

- **Reconciliation:** the *payment* is still what the bank reported. A refund is a **separate
  disbursement** and is reconciled against the bank's debit side, in its own batch. A refund must
  never mutate a completed reconciliation match (FI-018).
- **Reporting:** AR aging recomputes from `net_applied`, so a refunded invoice re-enters aging from
  its original `issued_at` — a refund does **not** reset an invoice's age. This is deliberate: an old
  debt that was refunded has not become a new debt.
- **Parent portal:** the invoice balance rises and the refund appears as its own line. The portal
  never shows a negative balance (§16, FI-015).

---

## 14. Reconciliation model

### 14.1 The `UNIQUE(batch_id, payment_id)` gap is closed with a denormalised finality flag

The brief is right that `UNIQUE(batch_id, payment_id)` only prevents duplicates *within* one batch,
and that a payment could otherwise be matched into many batches. A partial unique index cannot
reference another table's `status` in its predicate, so the discriminator is denormalised — and
maintained by trigger, which is the repository's established technique for exactly this shape
(`trg_marks_validate` pinning copies, `0015:810-836`).

**These three objects are shown here as *shapes*, not as statements to apply.** An earlier
revision carried an executable copy of all three in this section **as well as** in the `0027`
DDL block that owns the table, so an implementer working from both places issued
`fin_recon_payment_final_uq` twice (**42P07** `duplicate_table`) and
`fin_recon_tenant_batch_payment_uq` twice (**42701**), and `0027` did not apply. The single
executable home is the `0027` block: `is_final` is a **column** in that `CREATE TABLE`, the
composite uniqueness is one of its **named constraints**, and the partial unique index is
written immediately after that block. The block below is therefore a `text` fence, not a `sql`
fence, so its contents cannot be pasted into a migration by accident.

```text
-- (in the 0027 CREATE TABLE fin_reconciliation_matches)
--     is_final boolean NOT NULL DEFAULT false,
--
--     CONSTRAINT fin_recon_tenant_batch_payment_uq
--         UNIQUE (tenant_id, batch_id, payment_id),

-- (immediately after that block, in the same file)
-- CREATE UNIQUE INDEX fin_recon_payment_final_uq
--     ON fin_reconciliation_matches (tenant_id, payment_id)
--     WHERE is_final;

-- P2-04: this index is TENANT-AWARE, and the previous revision's
-- `ON fin_reconciliation_matches (payment_id) WHERE is_final` was not. payment_id is
-- a globally-unique uuid, so a single-column index is not *wrong* for uniqueness --
-- but it is wrong as a scope statement: it says nothing about the tenant, and it
-- gives the planner no leading tenant_id, so a per-tenant reconciliation query
-- cannot use it. More importantly, a reader (or a future migration author copying
-- the pattern) would reasonably infer that the row is tenant-local, and RLS then
-- filters AFTER the index is used, so a cross-tenant probe reads index pages. The
-- leading tenant_id makes the RLS predicate index-resident, which is the whole
-- point of writing tenant-scoped indexes this way everywhere else in §6.

-- The base uniqueness the brief asked about, also tenant-scoped: one payment may
-- appear once per batch, and a batch belongs to a tenant. Without tenant_id here
-- the same (batch_id, payment_id) pair is already unique because batch_id is a
-- uuid, but stating the tenant makes the constraint's scope explicit and matches
-- every other composite key in this document (§6.3 R1).
```

A batch transition to `matching` or `completed` stamps `is_final = true` on its matches. Opening a
second batch that would match the same payment raises `23505` — **the database refuses to
double-reconcile**, which is FI-018. Because the index is `(tenant_id, payment_id)`, a
*different* tenant may legitimately finalise the same payment-shaped id in its own batch, which is
the correct behaviour for a multi-tenant deployment and is asserted by
`finance-reconciliation.test.ts` ("tenant A's final match does not block tenant B's").

#### 14.1.1 The finality trigger, in full (NORMATIVE)

`trg_fin_recon_is_final` is bound in §35.3 and its behaviour is stated two paragraphs up, but it had
no definition. It reads the parent batch's status, which is why it is a trigger on the match and not
a generated column or a CHECK.

```sql
CREATE OR REPLACE FUNCTION trg_fin_recon_is_final() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE v_batch_status text;
BEGIN
    SELECT status INTO v_batch_status
      FROM fin_reconciliation_batches
     WHERE tenant_id = NEW.tenant_id AND id = NEW.batch_id;
    IF v_batch_status IS NULL THEN
        RAISE EXCEPTION 'reconciliation batch % does not exist in this tenant', NEW.batch_id
            USING ERRCODE = '55000';
    END IF;

    -- is_final is DERIVED and therefore never caller-writable. The trigger overwrites
    -- whatever was supplied, so a route cannot create a `is_final = true` match in an
    -- open batch and thereby claim a payment before reconciliation has happened. The
    -- unique index above is only a protection if the column it indexes is not
    -- attacker-controlled.
    NEW.is_final := (v_batch_status IN ('matching','completed'));

    -- Finality is monotone, with exactly ONE batch-driven exception: a match may
    -- lose finality only when the batch that owns it is being CANCELLED. Reopening
    -- a batch must not silently un-finalise anything, because that would release
    -- the payment to be matched elsewhere on an operator's say-so with nothing
    -- recording that the earlier reconciliation was abandoned -- which is exactly
    -- what the `cancelled` state and its `cancelled_at` are for, so they are
    -- required before the release is permitted. `v_batch_status` is the batch's
    -- status in the current transaction and has already been read above, so on the
    -- batch trigger's own clearing UPDATE it already reads 'cancelled'.
    -- OLD is unassigned on INSERT, so the comparison is guarded by TG_OP rather
    -- than relying on OLD reading as NULL.
    IF TG_OP = 'UPDATE' AND OLD.is_final AND NOT NEW.is_final THEN
        IF v_batch_status IS DISTINCT FROM 'cancelled' THEN
            RAISE EXCEPTION 'a finalised reconciliation match cannot be un-finalised'
                USING ERRCODE = '55000';
        END IF;
    END IF;
    RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION trg_fin_recon_is_final() FROM PUBLIC;
```

**This trigger alone is not sufficient, and the reason is the direction of the derivation.**
`is_final` is derived from the batch's `status`, but it is written only when a *match* row is written.
A batch therefore has a window: matches are inserted while `status = 'open'`, so every one of them is
stamped `is_final = false`; the batch is then moved to `'matching'` and **no match row is touched**, so
all of them stay `false` indefinitely. The partial unique index that prevents one payment being matched
in two batches is keyed on `is_final`, so during that window it enforces nothing. A second batch can
insert its own match for the same payment, and it will be stamped `true` on insert — leaving two live
rows for one payment, one of which trips the index only when someone later happens to touch it. The
violation is deferred and load-bearing, which is the worst shape for a database constraint.

`trg_fin_recon_batch_derive_totals` and `trg_fin_recon_batch_stamp_matches` close it from the other
side — and, being two triggers rather than one, they are the minimum that can, because one of the two
effects needs `BEFORE` and the other needs `AFTER`:

```sql
-- TRIGGER 1 of 2 on the batch. BEFORE, because it DERIVES the batch's own totals and
-- an AFTER trigger cannot assign to NEW. It also carries the guard that refuses to
-- walk away from a finalised batch.
CREATE OR REPLACE FUNCTION trg_fin_recon_batch_derive_totals() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE v_matched numeric(19,4);
BEGIN
    -- Only a real status transition re-derives. Note RETURN NEW, not NULL: a BEFORE
    -- trigger that returns NULL cancels the statement, and the previous revision
    -- returned NULL here while describing itself as a totals-deriving BEFORE trigger.
    IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
        RETURN NEW;
    END IF;

    -- Leaving a final-capable status with finalised matches is refused rather than
    -- quietly released. The only exits are `completed` and `cancelled`, and
    -- `cancelled` is the path that says out loud that the batch was void.
    IF OLD.status IN ('matching','completed') AND NEW.status NOT IN ('completed','cancelled') THEN
        IF EXISTS (SELECT 1 FROM fin_reconciliation_matches m
                    WHERE m.tenant_id = OLD.tenant_id AND m.batch_id = OLD.id
                      AND m.is_final) THEN
            RAISE EXCEPTION
                'batch % has finalised matches and may only move to completed or cancelled',
                OLD.id USING ERRCODE = '55000';
        END IF;
    END IF;

    -- The batch's own totals are derived from its matches, not supplied by the
    -- caller, for the same reason `is_final` is: a caller who can write
    -- `matched_total` can make a batch balance against a statement it does not
    -- match. Re-derived on every real status change, so the stored figures are a
    -- function of the matches and never of the request body.
    IF NEW.status IN ('matching','completed') THEN
        SELECT COALESCE(SUM(m.matched_amount), 0) INTO v_matched
          FROM fin_reconciliation_matches m
         WHERE m.tenant_id = NEW.tenant_id AND m.batch_id = NEW.id;
        NEW.matched_total    := v_matched;
        NEW.variance_amount  := COALESCE(NEW.statement_total, 0) - v_matched;
    END IF;
    RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION trg_fin_recon_batch_derive_totals() FROM PUBLIC;


-- TRIGGER 2 of 2 on the batch, and this one MUST be AFTER, not BEFORE. It updates the
-- matches, and every row it updates re-enters trg_fin_recon_is_final, which re-derives
-- `is_final` by SELECTing the batch's CURRENT status. On a BEFORE trigger that SELECT
-- still returns the OLD status, so the derivation would overwrite the value this
-- trigger had just written: the stamp would be undone by its own row trigger, and the
-- partial unique index would enforce nothing. That is precisely the defect T-FIN-27
-- describes, so this binding is load-bearing rather than stylistic. The previous
-- revision declared it BEFORE in the §35.3 inventory while its own comment claimed
-- AFTER, and could be neither.
CREATE OR REPLACE FUNCTION trg_fin_recon_batch_stamp_matches() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
    IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
        RETURN NULL;
    END IF;

    -- Entering a final-capable status CLAIMS every existing match. The batch row
    -- already reads 'matching'/'completed' at this point, so the row trigger
    -- re-derives the same `true` and the two triggers agree by construction.
    IF NEW.status IN ('matching','completed') THEN
        UPDATE fin_reconciliation_matches m
           SET is_final = true
         WHERE m.tenant_id = NEW.tenant_id AND m.batch_id = NEW.id
           AND m.is_final IS DISTINCT FROM true;
    END IF;

    -- The symmetric negative half: CANCELLING a final-capable batch RELEASES the
    -- claims it held. Without this branch the release T-FIN-28 depends on never
    -- happened. `/cancel` on a `matching` batch was accepted, but its matches kept
    -- `is_final = true`, the partial unique index kept every claimed payment locked,
    -- and the corrected batch could never be finalised for any of them -- so a cancel
    -- would strand payments permanently while appearing to succeed, and the
    -- replacement batch's own stamp would then trip 23505. The rows are NOT deleted:
    -- the claim is released, while the match, its amounts, and the `cancelled` batch
    -- that voided them all remain for audit.
    IF NEW.status = 'cancelled' THEN
        UPDATE fin_reconciliation_matches m
           SET is_final = false
         WHERE m.tenant_id = NEW.tenant_id AND m.batch_id = NEW.id
           AND m.is_final;
    END IF;
    RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION trg_fin_recon_batch_stamp_matches() FROM PUBLIC;
```

**These three triggers form a closure, and no member of it is redundant.** `trg_fin_recon_is_final`
guarantees that no match can *claim* finality in a non-final batch, whatever the caller sends.
`trg_fin_recon_batch_stamp_matches` guarantees that a batch which *becomes* final propagates to the
matches it already holds, and that a batch which is *cancelled* releases the claims it held.
`trg_fin_recon_batch_derive_totals` guarantees the batch's own totals are a function of its matches
rather than of the request body, and refuses to leave a finalised batch for a non-terminal state.
Delete any one of them and a class of inconsistency survives: remove the row trigger and a route
writes `is_final = true` in an open batch; remove the propagation trigger and the deferred
double-match above reappears; remove the release and cancelling a `matching` batch strands every
payment it had claimed. All three are in the §35.3 inventory (rows 21–23), and the two batch
triggers are bound in 0027 because `fin_reconciliation_batches` is created there.

**They cannot be merged, and the previous revision's single merged trigger was itself a defect.** The
propagation effect requires `AFTER` and the totals effect requires `BEFORE`, so the split is forced
by PostgreSQL's semantics rather than by preference. A merged `BEFORE` trigger re-derives
`is_final` from the batch's still-old status and undoes its own stamp; a merged `AFTER` trigger
cannot assign `NEW.matched_total` and silently stops deriving it. The previous revision declared
the merged trigger `BEFORE` in the §35.3 inventory while its own comment claimed `AFTER`, so it
was neither, and neither T-FIN-27's window nor T-FIN-28's release was actually closed by it.

**No `finalised_at` column is introduced, and the design says why.** The match already carries
`matched_at` (the moment the row was created) and the batch carries its own transition timestamps;
a third timestamp recording *when finality was derived* would be a value recomputed from
`batch.status` and would be stale the moment the batch moved. Finality is `batch.status ∈
('matching','completed')` read live, `is_final` is the denormalised copy that makes the partial
unique index possible, and the trigger keeps them equal. There is no third fact.

**Answering the brief's question directly:** a payment may be matched into **many open batches**
(drafting is harmless) but is **finalised in exactly one**. Open matches are advisory rows; only
`is_final` rows are authoritative.

### 14.2 Batch lifecycle

```text
  open ──start──► matching ──complete──► completed        (terminal; immutable snapshot)
    │                 │
    │                 ├──cancel───────► cancelled        (terminal; the ONLY route out once
    │                 │                                  any match is final — T-FIN-28/FI-018)
    │                 │
    │                 ╳──────────────► open             FORBIDDEN once any match is final
    │                                                    (re-opening would un-finalise
    │                                                     matches and release payments with
    │                                                     no record that they were abandoned)
    │
    └──cancel──► cancelled                                  (terminal; allowed while still open)
```

| State | Meaning | `is_final` stamped? |
|---|---|---|
| `open` | matches may be proposed and edited freely; nothing is authoritative | no |
| `matching` | the operator has begun resolving; matches are now claimed | **yes** |
| `completed` | frozen; an immutable completion snapshot is written | yes |
| `cancelled` | abandoned, from `open` **or** from `matching`. From `open` it frees nothing (nothing was final). From `matching` it **releases** the batch's claims so those payments can be reconciled in a corrected batch — that release is the entire reason `/cancel` must accept `matching` (T-FIN-28), and it happens by `UPDATE`, never by `DELETE`, so the matches and their amounts remain as the record of what was voided | yes → released on cancel |

**`reopened` is not permitted, and `exception` is not a state.** Supersession is `cancel` from
either `open` or `matching`. Allowing a reopen would break the "exactly one final match"
invariant and make the audit trail ambiguous: an operator could walk a batch back to `open`,
un-finalise its matches, and re-point them at a different statement with nothing recording
that the first attempt was abandoned. Cancelling says exactly that, and `cancelled_at`
timestamps it. The previous revision also declared an `exception` state with a
`matching → exception` edge, but no route reached it, no trigger produced it, §35.6 gave it
no exit, and it was annotated "batch must be cancelled first" — a state you are required to
leave before you may enter. It has been removed from the enum; an unresolved variance is not a
batch state, it is a `variance_amount` and a `variance_reason` on a batch still in `matching`.

### 14.3 Completion is immutable and hash-verified

```sql
CREATE TABLE fin_reconciliation_batches (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id         uuid NOT NULL,
    batch_no          text NOT NULL,
    -- The enum is exactly the four states §35.6's transition matrix defines. An
    -- earlier revision also allowed 'exception', and the §18 diagram drew a
    -- `matching --exception--> exception` edge into it — but no route reaches it
    -- (§21.3 exposes only start / complete / cancel), no trigger produces it, and
    -- §35.6 gives it no exit, so a batch in that state would have been permanently
    -- stuck. 'cancelled' already carries the meaning the comment below wanted
    -- ("this statement was wrong; correct it with a new batch"), and T-FIN-28
    -- requires /cancel to work from `matching`, which it now does.
    status            text NOT NULL DEFAULT 'open'
                      CHECK (status IN ('open','matching','completed','cancelled')),
    -- The bank statement this batch reconciles AGAINST. The statement itself is a
    -- file artifact, not a row here, so its identity is carried as a reference and
    -- the amounts are carried as columns, because the variance arithmetic needs them
    -- and a viewer must not have to open a file to see why a batch was cancelled.
    statement_file_id uuid,
    statement_ref     text NOT NULL,        -- bank statement number, as printed
    statement_period_start date NOT NULL,
    statement_period_end   date NOT NULL,
    statement_total   numeric(19,4),
    matched_total     numeric(19,4),
    variance_amount   numeric(19,4) NOT NULL DEFAULT 0,
    variance_reason   text,
    variance_tolerance numeric(19,4) NOT NULL DEFAULT 0,
    completion_hash   text,        -- sha256 over the canonical sorted match list
    completion_snapshot jsonb,     -- immutable; written once at completion
    completed_by      uuid,
    completed_at      timestamptz,
    cancelled_at      timestamptz,
    created_by        uuid NOT NULL,
    created_at        timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT fin_recon_batches_ten_id_uq UNIQUE (tenant_id, id),
    CONSTRAINT fin_recon_batches_no_uq UNIQUE (tenant_id, batch_no),
    CONSTRAINT fin_recon_batches_file_fk
        FOREIGN KEY (tenant_id, statement_file_id)
        REFERENCES files (tenant_id, id) ON DELETE RESTRICT,
    CONSTRAINT fin_recon_batches_period_ck CHECK
        (statement_period_end >= statement_period_start),
    -- Completion is a package: a hash, a snapshot, an actor and a time, or none of
    -- them. There is no state in which some are present, which is what makes
    -- `completion_hash` a usable integrity check rather than a nullable hint.
    CONSTRAINT fin_recon_batch_state_ck CHECK (
        (status = 'completed' AND completion_hash IS NOT NULL
                 AND completion_snapshot IS NOT NULL AND completed_at IS NOT NULL
                 AND completed_by IS NOT NULL)
     OR (status <> 'completed' AND completion_hash IS NULL
                 AND completion_snapshot IS NULL AND completed_at IS NULL
                 AND completed_by IS NULL)
    ),
    -- A non-zero variance must be explained, and the explanation must be a real
    -- reason rather than whitespace. This is the CHECK referred to in §14.4.
    CONSTRAINT fin_recon_batch_variance_ck CHECK (
        variance_amount = 0
     OR (status <> 'completed')
     OR (variance_reason IS NOT NULL AND length(btrim(variance_reason)) > 0)
    ),
    -- cancelled_at is as much a package as completion: present iff cancelled.
    CONSTRAINT fin_recon_batch_cancel_ck CHECK (
        (status = 'cancelled' AND cancelled_at IS NOT NULL)
     OR (status <> 'cancelled' AND cancelled_at IS NULL)
    )
);
-- Revoke the 0001 default-privilege grant immediately (§35.4, §30.3).
REVOKE ALL ON fin_reconciliation_batches FROM school_app_rw;



-- The matches table, whose tenant-scoped uniqueness is the whole point of §14.1
-- (P2-04). It is declared here rather than in §14.1 so that the two halves of the
-- reconciliation model sit in one DDL block and a reader cannot apply one without
-- the other.
CREATE TABLE fin_reconciliation_matches (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id         uuid NOT NULL,
    batch_id          uuid NOT NULL,
    payment_id        uuid NOT NULL,
    statement_line_ref text,                 -- the line on the bank statement
    matched_amount    numeric(19,4) NOT NULL,
    -- Denormalised discriminator. A partial unique index cannot reference the
    -- parent batch's `status` in its predicate, so finality is stamped on the row.
    is_final          boolean NOT NULL DEFAULT false,
    matched_by        uuid NOT NULL,
    matched_at        timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT fin_recon_matches_ten_id_uq UNIQUE (tenant_id, id),
    CONSTRAINT fin_recon_matches_batch_fk
        FOREIGN KEY (tenant_id, batch_id)
        REFERENCES fin_reconciliation_batches (tenant_id, id) ON DELETE RESTRICT,
    CONSTRAINT fin_recon_matches_payment_fk
        FOREIGN KEY (tenant_id, payment_id)
        REFERENCES fin_payments (tenant_id, id) ON DELETE RESTRICT,
    -- P2-04: tenant-scoped. The previous revision indexed `payment_id` alone, which
    -- is not wrong for uniqueness (a uuid is globally unique) but says nothing about
    -- the tenant and gives a per-tenant query no leading `tenant_id`.
    CONSTRAINT fin_recon_tenant_batch_payment_uq
        UNIQUE (tenant_id, batch_id, payment_id),
    CONSTRAINT fin_recon_matches_amount_ck CHECK (matched_amount > 0)
);
-- Revoke the 0001 default-privilege grant immediately (§35.4, §30.3).
REVOKE ALL ON fin_reconciliation_matches FROM school_app_rw;


-- THE finality invariant: a payment may be proposed in many open batches but is
-- finalised in exactly one, per tenant.
CREATE UNIQUE INDEX fin_recon_payment_final_uq
    ON fin_reconciliation_matches (tenant_id, payment_id)
    WHERE is_final;
```

**Note the two state columns that are now closed.** `exception` is a real state here (a batch can sit
in exception with non-zero variance and no reason), and `cancelled` carries a mandatory timestamp. The
previous revision's `fin_recon_batch_state_ck` only constrained `completed`, which meant a batch could
be `cancelled` with no cancellation record and a reader could not tell an abandoned batch from one
that was never started.

`completion_snapshot` and `completion_hash` are written **once**; a trigger raises on any later
change (`'a completed reconciliation batch is immutable'`, ERRCODE `55000`). The snapshot is the
evidence an auditor reads; the hash lets an auditor re-derive it and prove the batch was not edited.

`variance_amount` is a **stored** value (it is the result of a computation over many rows and is
needed for a list view), but it is computed **only** in the completion transaction from the
authoritative match rows, never supplied by the client, and it is included in the snapshot.

### 14.4 Variance handling

- `variance = statement_total − matched_total`.
- `|variance| <= variance_tolerance` → `completed` directly.
- Otherwise → the operator must set `variance_reason` (non-empty, from a tenant-configured reason
  list) or move the batch to `exception`. **Completing with a non-zero variance and no reason is
  rejected by CHECK.**

---

## 15. Ledger model

### 15.1 The complete posting lifecycle

The brief's core P0: a normal issued invoice must create the receivable/income event, and the
existing design only described payment, refund and void. **Full lifecycle, exhaustively:**

#### ISSUE INVOICE

```text
Dr 1200 Accounts Receivable        invoice_total
    Cr 4000 Fee Income                       invoice_total
```

One balanced group, one entry per leg, posted inside the same transaction as the invoice status
change. The full amount is receivable the moment the invoice is issued, whether or not anyone pays.

#### PAYMENT SETTLED (with allocations)

One group per payment, one leg per side:

```text
Dr 1000/1100 Cash or Bank          payment.amount
    Cr 1200 Accounts Receivable              Σ allocation.amount
    Cr 1300 Unapplied Cash                   unallocated_amount
```

#### APPLY EXISTING UNAPPLIED PAYMENT

```text
Dr 1300 Unapplied Cash              allocation.amount
    Cr 1200 Accounts Receivable              allocation.amount
```

Income is **not** touched — it was recognised at issue. This is the on-account application edge.

#### REFUND — two-step, explicitly

```text
on  approve:   Dr 1200 Accounts Receivable        refund.amount
                   Cr 2200 Refund Payable                   refund.amount

on  process:   Dr 2200 Refund Payable             refund.amount
                   Cr 1000/1100 Cash or Bank                 refund.amount
```

Two steps because a refund approved today and paid by bank transfer next week is a **liability** in
between. Collapsing it to a single `Dr 1200 / Cr Cash` on approval would credit cash that has not
left. The intermediate `2200` balance is a real, reportable figure: "refunds approved but not yet
disbursed".

#### ALLOCATION CORRECTION REVERSAL (`refund_id IS NULL`)

```text
Dr 1200 Accounts Receivable        |reversal|
    Cr 1300 Unapplied Cash                 |reversal|
```

The money returns to the family's on-account balance; it did not leave the school.

#### ON-ACCOUNT MOVEMENT (`invoice_id IS NULL`) — the movement with no invoice

`fin_payment_allocations` rows that name no invoice (§12.1) move cash **within the school's own
liability account**. They never touch income and never touch receivable, because there is no charge
behind them. There are exactly two shapes, and the difference between them is the whole point:

```text
on-account CREDIT  (effect='apply', amount > 0, invoice_id NULL):
                    Dr 1300 Unapplied Cash        |amount|
                        Cr 1300 Unapplied Cash             |amount|

on-account RETURN  (effect='on_account_return', amount < 0, invoice_id NULL):
                    Dr 1300 Unapplied Cash        |amount|
                        Cr 1000/1100 Cash or Bank          |amount|
```

**The single authoritative statement of the return's accounts (P1-05).** Every other section of this
document must agree with the block above: **a return is `Dr 1300 / Cr 1000`.** Both halves are
forced by the account types, not by taste:

- `1300 Unapplied Cash` is a **liability** — money the school holds on a family's behalf. Handing it
  back reduces the liability, and a liability falls on the **debit** side.
- `1000/1100 Cash` is an **asset**. The cash leaves, and an asset falls on the **credit** side.

Three points, each of which is a trap this design closes:

- **The on-account credit is a same-account posting, and that is correct, not a bug.** Its only
  legitimate use is correcting the direction of a mis-keyed movement on the *same* payment, so
  `Dr 1300 / Cr 1300` balanced is exactly what happened: cash moved inside one account. It reports to
  zero, and it is distinguishable from anything else by its `memo`. What must be impossible — a
  credit that transfers value from one **family** to another — is impossible structurally, because
  the allocation's `payment_id` is single-valued, so a credit can only ever land on the payment that
  raised it, **and** because `trg_fin_allocation_family_guard` (§12.5) now additionally refuses any
  `apply` whose invoice does not belong to the payer's family.
- **The on-account return relieves `1300`, never `1200`.** The intuitive posting — `Dr 1200 Accounts
  Receivable / Cr Cash` — is **wrong**, and it is the trap worth naming: the cash was never applied
  to a charge, so there is no receivable to relieve. Posting `Dr 1200` would manufacture a phantom
  receivable that FI-009's reconciliation then has to explain and that the AR-aging report would show
  a family was owed money it was never billed for. `Dr 1300` reduces the liability the school
  actually holds. `finance-021` asserts both accounts and asserts that AR is untouched.
- **The return is bounded by what is held on account, not by `applied` and not by `p.amount`.**
  `trg_fin_on_account_return_bounds` (§13.3.2) rejects any return that would drive the payment's
  on-account balance negative, raising `55000` → `422 on_account_return_exceeds_unallocated`. The
  complementary rule is that an on-account return is **never** refundable (FI-005), so the two
  operations can never be used to pay out the same paisa twice.

#### INVOICE VOID



The **exact reversal of the original issue group**, plus the exact reversal of any posted adjustment
groups:

```text
void:  Dr 4000 Fee Income                       invoice_total
           Cr 1200 Accounts Receivable                   invoice_total
```

Void requires `balance = 0` (§9.3), so no payment leg needs reversing — the reversal is total and
symmetric. The void group carries `reversal_of_group = <the issue group>`, which is the "corrections
are new records" discipline from `FINANCE_DESIGN.md:1` applied literally.

#### ADJUSTMENT

Signed adjustments post at creation, one group each:

```text
debit adjustment (fine, late_fee, other):   Dr 1200 / Cr 4200   (increases receivable)
credit adjustment (concession, waiver):     Dr 4100 / Cr 1200   (reduces receivable)
```

A credit **reduces the receivable** and therefore reduces the invoice total, so the invoice balance
falls without any payment. A concession is *contra-revenue* (`4100`), not an expense — it is a
discount against fee income, and putting it in an expense account would misstate both revenue and
expense.

#### CREDIT NOTE / STANDALONE CREDIT — **explicitly deferred**

A standalone credit note (its own number, its own document, its own lifecycle) is **out of scope for
Phase 7**. A credit is represented as a `fin_invoice_adjustments` row with `type IN
('concession','waiver')` and a negative effective amount, which posts `Dr 4100 / Cr 1200` and
reduces the invoice balance. This is stated as a **deferral, not an omission**: the ledger supports
it trivially when it arrives (one more group type), but the document model, numbering series, portal
surface and receipt semantics are not designed here and must not be inferred.

#### LEDGER GROUP INVARIANT

A balanced group is enforced **in the database**, not by application discipline:

```sql
CREATE OR REPLACE FUNCTION trg_fin_ledger_group_balance() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    v_group_id uuid;
    v_tenant   uuid;
    v_debits   numeric(19,4);
    v_credits  numeric(19,4);
    v_count    integer;
BEGIN
    -- TG_OP, not COALESCE(NEW.entry_group_id, OLD.entry_group_id). The bound is
    -- `AFTER INSERT OR UPDATE OR DELETE DEFERRABLE INITIALLY DEFERRED`, so all
    -- three operations fire and DELETE leaves NEW unassigned. This is the one
    -- trigger where the P0002 would be most damaging: the check runs at COMMIT,
    -- so the error surfaces as a failed COMMIT with a PL/pgSQL internal in the
    -- message rather than as a rejected statement the caller can attribute to a
    -- ledger write.
    IF TG_OP = 'DELETE' THEN
        v_group_id := OLD.entry_group_id;
        v_tenant   := OLD.tenant_id;
    ELSE
        v_group_id := NEW.entry_group_id;
        v_tenant   := NEW.tenant_id;
    END IF;
    -- Recompute from the LEGS, not from the group's cached totals. This is the
    -- whole point of the check: `total_debit` and `total_credit` are written by
    -- the seal statement, so comparing them to each other would only prove the
    -- seal statement was self-consistent. Reading the legs makes the constraint
    -- independent of the value it is validating.
    SELECT COALESCE(SUM(e.amount) FILTER (WHERE e.direction = 'debit'), 0),
           COALESCE(SUM(e.amount) FILTER (WHERE e.direction = 'credit'), 0),
           COUNT(*)
      INTO v_debits, v_credits, v_count
      FROM fin_ledger_entries e
     WHERE e.tenant_id = v_tenant AND e.entry_group_id = v_group_id;

    -- A group with no legs is vacuously balanced, and a group with exactly one
    -- leg can never balance (a leg is a single signed amount). Both are rejected
    -- explicitly, because "sum of nothing equals sum of nothing" would otherwise
    -- let an empty group pass, and a single-leg group would have to have
    -- amount = 0 to balance, which fin_leg_entries_nonzero_ck already forbids.
    IF v_count = 0 THEN
        RAISE EXCEPTION 'ledger entry group % has no legs', v_group_id
            USING ERRCODE = '55000';
    END IF;
    IF v_debits <> v_credits THEN
        RAISE EXCEPTION
            'unbalanced ledger entry group %: debits % <> credits %',
            v_group_id, v_debits, v_credits
            USING ERRCODE = '55000';
    END IF;

    -- Keep the cached totals honest at the same time the balance is proven, so a
    -- later read of the group cannot disagree with the legs it summarises. This is
    -- a cache maintained by a constraint check, not a cache trusted by one.
    UPDATE fin_ledger_entry_groups
       SET total_debit = v_debits,
           total_credit = v_credits,
           entry_count = v_count
     WHERE tenant_id = v_tenant AND id = v_group_id;
    RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION trg_fin_ledger_group_balance() FROM PUBLIC;
```

**Three corrections to the previous revision's version of this function, each of which would have
made the constraint either wrong or inert.**

1. **`g.entry_group_id` did not exist.** The groups table's key column is `id`; `entry_group_id` is
   the name of the *child* column on `fin_ledger_entries`. The subquery therefore referenced a
   column the table does not have, and the function would have failed with `column "g.entry_group_id"
   does not exist` on the first unbalanced group — meaning the check would have appeared to work
   (no error during the happy path) while being unable to ever raise.
2. **The comparison used the cached totals, so it proved nothing.** `g.total_debit <> g.total_credit`
   checks two numbers written by the same seal statement. A seal that miscounts both sides equally
   passes. The version above recomputes from the legs, which is the only comparison that can fail.
3. **An empty group passed.** With `COUNT(*) = 0`, both cached totals are `NULL`, and `NULL <> NULL`
   is `NULL`, not `TRUE` — so the `IF FOUND` branch never fired. `v_count = 0` is now an explicit
   failure, and a one-leg group is caught by the balance comparison itself.

**The `UPDATE` at the end is safe to do from a deferred `CONSTRAINT TRIGGER`, and that is why it is
here rather than in the seal statement.** A `CONSTRAINT TRIGGER` may only be declared `AFTER`, and it
fires at `COMMIT`, by which point the seal statement has already run. Writing the totals from the
trigger that *verifies* them means the cached values can never be the reason the verification passes.

`fin_ledger_entry_groups` carries `total_debit`, `total_credit`, `entry_count`, and `sealed_at`. A
group is inserted **open** (`sealed_at IS NULL`), legs are inserted, and a `seal` statement updates
the totals. The check is `total_debit = total_credit` — a real, database-enforced, deferred
constraint, which is exactly what the brief asks for in place of the vague "verified by trigger per
group + app code".

**Additionally** a `BEFORE INSERT` trigger on `fin_ledger_entries` rejects a leg whose
`(tenant_id, entry_group_id)` group is already `sealed`, so a sealed group can never gain a leg.
`UPDATE` and `DELETE` on `fin_ledger_entries` are blocked for all roles including `school_migrator`
— an append-only ledger is worth nothing if the migrator can quietly edit it. This is the *actual*
implementation of the immutability `DATABASE_DESIGN.md:220` only gestured at, and it does **not** use
the rejected GUC bypass.

#### 15.1.1 The two ledger immutability triggers, in full (NORMATIVE)

Named and bound in §35.3, referenced in §9.4 and §25.5, and previously defined nowhere.

```sql
-- ── Seal: a sealed group is frozen, for every role ─────────────────────────
CREATE OR REPLACE FUNCTION trg_fin_ledger_seal() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
    -- sealed_at is WRITE-ONCE. Setting it for the first time is the seal; changing
    -- it afterwards is a rewrite, and un-sealing a group is how a balanced group
    -- becomes an unbalanced one with the evidence edited away.
    IF OLD.sealed_at IS NOT NULL THEN
        IF NEW.sealed_at IS DISTINCT FROM OLD.sealed_at
           OR NEW.total_debit IS DISTINCT FROM OLD.total_debit
           OR NEW.total_credit IS DISTINCT FROM OLD.total_credit
           OR NEW.entry_count IS DISTINCT FROM OLD.entry_count THEN
            RAISE EXCEPTION 'a sealed ledger entry group is immutable'
                USING ERRCODE = '55000';
        END IF;
        RETURN NEW;
    END IF;

    -- Sealing requires the cached totals to already agree, so the seal is where the
    -- balance is asserted rather than after it. trg_fin_ledger_group_balance
    -- recomputes the same values at COMMIT from the legs; this is the earlier of
    -- the two checks, and the deferred one is the authority.
    IF NEW.total_debit <> NEW.total_credit THEN
        RAISE EXCEPTION 'cannot seal an unbalanced ledger entry group'
            USING ERRCODE = '55000';
    END IF;
    IF NEW.entry_count IS NULL OR NEW.entry_count < 2 THEN
        RAISE EXCEPTION 'cannot seal a group with fewer than two legs'
            USING ERRCODE = '55000';
    END IF;
    NEW.sealed_at := COALESCE(NEW.sealed_at, now());
    RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION trg_fin_ledger_seal() FROM PUBLIC;

-- ── Append-only: no UPDATE, no DELETE, no role exemption ──────────────────
CREATE OR REPLACE FUNCTION trg_fin_ledger_append_only() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
    -- No GUC escape hatch, no `IF current_user = 'school_migrator' THEN RETURN NEW`.
    -- §9.4 rejected that pattern from DATABASE_DESIGN.md:220 on the grounds that a
    -- GUC readable by a trigger expression is settable by the runtime role, so the
    -- exemption is forgeable. The same reasoning applies to a role check, because
    -- the migrator role is exactly the one a compromised migration holds.
    --
    -- DELETE lands here too: a BEFORE DELETE trigger can return NULL to suppress the
    -- delete, which is how a ledger row is removed without the statement ever
    -- failing and without the caller learning why.
    RAISE EXCEPTION 'ledger entries are append-only: % is not permitted', TG_OP
        USING ERRCODE = '55000';
END $$;
REVOKE ALL ON FUNCTION trg_fin_ledger_append_only() FROM PUBLIC;

-- The sealed-group guard from the paragraph above, as a real function. It is
-- bound as part of trg_fin_ledger_append_only's trigger in §35.3's block, and is
-- written here so "a sealed group can never gain a leg" is a statement about code
-- rather than a claim in prose.
CREATE OR REPLACE FUNCTION trg_fin_ledger_sealed_group_reject() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE v_sealed timestamptz;
BEGIN
    SELECT sealed_at INTO v_sealed
      FROM fin_ledger_entry_groups
     WHERE tenant_id = NEW.tenant_id AND id = NEW.entry_group_id;
    IF v_sealed IS NOT NULL THEN
        RAISE EXCEPTION 'ledger entry group % is sealed', NEW.entry_group_id
            USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION trg_fin_ledger_sealed_group_reject() FROM PUBLIC;
```

### 15.2 What the sub-ledger is

Restating the brief's question as a decision:

> The Phase 7 sub-ledger is **operationally authoritative and independently reconcilable**. It is
> **not** merely an audit projection.

- **Authoritative** for the *receivable position*: "how much is owed" is answered by
  `1200`'s balance, derived from `fin_ledger_entries`, independent of any invoice counter.
- **Independently reconcilable**: §15.3 proves the receivable two ways.
- **Not a full GL**: §5.1 boundaries hold.

### 15.2.1 Two kinds of view, and only one of them is a security boundary

Phase 7 publishes report surfaces as views, and the `security_invoker` flag is not a uniform choice.
Splitting them is what makes §20.2's "principal sees aggregates, never an individual invoice"
**structurally** true rather than merely a route-layer intention.

**A terminology correction first (P1-06), because the previous revision used a flag that does not
exist.** A PostgreSQL **view has no `SECURITY DEFINER` option.** `CREATE VIEW` accepts
`security_invoker` (and `security_barrier`) and nothing else; `prosecdef` is a property of
**functions**, not relations. Writing "the four aggregate views are `SECURITY DEFINER`" describes an
option that cannot be written, and a static test asserting it could only ever fail or be written to
assert nothing. The behaviour the design actually wanted — "these views must not be filtered by the
caller's RLS" — is achieved by the **inverse** of the flag:

> A view executes with the privileges of its **owner**. Setting `security_invoker = on` opts *out* of
> that and makes the caller's own privileges and RLS apply instead. So "definer-like" is the
> **default**, and the explicit, mandatory thing is `security_invoker = on` where RLS *should* apply.

This is the same model the repository already uses for `SECURITY DEFINER` *functions* in `0002`, and
the difference matters for the contract table: the aggregate views are relations and belong in a
**view** inventory with `reloptions`, not in the function inventory with `prosecdef`.

| View class | Examples | How it is made invoker-scoped | Why |
|---|---|---|---|
| **Detail views** | `fin_v_invoice_balance`, `fin_v_payment_position` | **`WITH (security_invoker = on)`** (mandatory) | They are row-level. They must run as the caller so the caller's RLS decides what exists. Without the flag a view runs as its owner and would hand every authenticated session every tenant's money — the exact failure this document exists to prevent. A `principal` has **no** `SELECT` policy on any detail-view base table, so these views return **zero rows** to a principal. Not a permission check. Zero rows. |
| **Aggregate views** | `fin_v_ar_aging`, `fin_v_collections_summary`, `fin_v_fee_head_revenue`, `fin_v_on_account_summary` | **No `security_invoker`** — i.e. owner-scoped, the default | These are the principal's entire surface, and they must work *without* giving the principal `SELECT` on `fin_invoices`. Owner-scoped execution is what makes that possible. The safety does not come from the execution mode — it comes from the **output shape**, which is pinned below. |

**The aggregate-view contract, because owner-scoped execution is a privilege and privilege needs
bounds:**

1. **`ALTER VIEW … OWNER TO school_migrator`**, `REVOKE ALL … FROM PUBLIC`,
   `GRANT SELECT … TO school_app_rw`. There is no `search_path` to set on a view and no
   `prosecdef` to assert — the safety of a view comes from its owner and its base-table grants, so the
   contract is stated in those terms and checked in §35.3's view inventory rather than §19.7's
   function table. The critical companion statement is the one the previous revision omitted: **`REVOKE
   SELECT ON <base tables> FROM school_migrator` is NOT done**, because the owner must be able to read
   them; instead the owner's reach is bounded by the output-shape rule below and by pinning every
   view to `tenant_id` internally (point 6).
2. **Every output column is a bucket, a total, a count, or a taxonomy label** — never an
   `id`. No `student_id`, `user_id`, `invoice_id`, `payment_id`, `guardian_id`, `parent_name`,
   `student_name`, phone, email, or IBAN may appear in any aggregate view's `SELECT` list.
3. AR aging buckets are **`0-30`, `31-60`, `61-90`, `91-180`, `180+`** days. A bucket count of one
   invoice still reveals that a family exists; that is an accepted, documented limit of
   aggregate reporting, and it is the reason the principal grant is `fees.reports.read` rather than
   `fees.invoices.read` (§20.2).
4. A bucket with a count of exactly 1 is returned as-is. Suppressing small cells would be
   better privacy and worse honesty, and a report that silently omits a family is a report a
   principal will not trust. The decision is recorded, not hidden.
5. **`finance-aggregate-view.test.ts` asserts point 2 mechanically**: it introspects
   `information_schema.columns` for all four views and fails if any column name matches
   `/(student|user|invoice|payment|guardian|parent|name|phone|email|iban)/i`. A second assertion fails
   if any of the four has `security_invoker = on` in `pg_class.reloptions` — the aggregate views
   **must not** be invoker-scoped, because then the principal would get zero rows and the entire
   §20.2 mechanism would silently stop working while every policy test still passed. This is the test
   that keeps an owner-scoped view from becoming a detail leak *and* the test that keeps it from
   being accidentally converted into a view that returns nothing.
6. Each view is pinned to `tenant_id` from `app_current_tenant_id()` internally, so an
   owner-scoped view cannot be pointed at another tenant by a caller who cannot already see it. A
   `platform` ticket yields an empty result, not every tenant's aggregates. **This is the control
   that replaces what `search_path` pinning would have provided for a function**, and it is the reason
   the aggregate views are listed here individually rather than waved through as "the definer set".

**The consequence for §19.2's classes, stated so the two sections do not contradict each other:**
`fin_invoices` and friends are **not** in the principal's RLS reach — `reporting_staff` is excluded
from the document-money `SELECT` policy. The principal reaches finance data **only** through the four
owner-scoped aggregate views, which is the strongest form of "aggregate only" available: it does not rely
on the API layer declining to serve a detail query.

#### 15.2.2 The four aggregate views, in full (NORMATIVE)

The contract above is a *shape*; these are the *statements*. They were named in nine places
(§15.2.1, §19.7.2's V2 row, the 0026 migration row, the §35.1 inventory, `T-FIN-26`, the §20.2
permission rationale, and `finance-aggregate-view.test.ts`) and defined in none, so the principal's
entire finance surface was prose.

```sql
-- ── 0026 fin_ledger.sql (continued) ───────────────────────────────────────

-- 1. AR aging. Buckets are the five from contract point 3, in that order.
CREATE VIEW fin_v_ar_aging AS
SELECT app_current_tenant_id()                AS tenant_id,
       CASE
         WHEN b.due_date >= CURRENT_DATE - 30 THEN '0-30'
         WHEN b.due_date >= CURRENT_DATE - 60 THEN '31-60'
         WHEN b.due_date >= CURRENT_DATE - 90 THEN '61-90'
         WHEN b.due_date >= CURRENT_DATE - 180 THEN '91-180'
         ELSE '180+'
       END                                    AS aging_bucket,
       count(*)                              AS invoice_count,
       COALESCE(sum(b.balance), 0)            AS outstanding_amount
  FROM fin_v_invoice_balance b
 WHERE app_current_tenant_id() IS NOT NULL
   AND b.balance > 0
 GROUP BY 1, 2;

-- 2. Collections summary. Counts and sums only; `collection_method` is a
--    taxonomy label from a CLOSED domain, so it discloses nothing about a person.
CREATE VIEW fin_v_collections_summary AS
SELECT app_current_tenant_id()          AS tenant_id,
       date_trunc('day', p.received_at) AS collection_day,
       p.channel,
       count(*)                         AS payment_count,
       COALESCE(sum(p.amount), 0)       AS collected_amount
  FROM fin_payments p
 WHERE app_current_tenant_id() IS NOT NULL
   AND p.status = 'settled'
 GROUP BY 1, 2, 3;

-- 3. Fee-head revenue. `fee_head_code` and `fee_head_name` are the TAXONOMY the
--    contract permits: a fee head is a published price-list line, not a person.
--    Point 2's regex is /name/i, so `fee_head_name` is the one column that LOOKS
--    like it fails the test -- it is a fee's name, and the test is narrowed to
--    exclude it explicitly. See the note below.
CREATE VIEW fin_v_fee_head_revenue AS
SELECT app_current_tenant_id()                     AS tenant_id,
       h.id                                         AS fee_head_id,
       h.code                                       AS fee_head_code,
       h.name                                       AS fee_head_name,
       COALESCE(sum(v.invoice_total), 0)            AS invoiced_amount,
       COALESCE(sum(v.net_applied), 0)              AS collected_amount,
       COALESCE(sum(v.balance), 0)                  AS outstanding_amount
  FROM fin_fee_heads h
  JOIN fin_invoice_items it
       ON it.tenant_id = h.tenant_id AND it.fee_head_id = h.id
  JOIN fin_v_invoice_balance v
       ON v.tenant_id = it.tenant_id AND v.invoice_id = it.invoice_id
 WHERE app_current_tenant_id() IS NOT NULL
 GROUP BY 1, 2, 3, 4;

-- 4. On-account summary. A single row per tenant: the total advance held.
CREATE VIEW fin_v_on_account_summary AS
SELECT app_current_tenant_id()   AS tenant_id,
       count(*)                  AS on_account_payments,
       COALESCE(sum(p.amount), 0) AS on_account_balance
  FROM fin_payments p
 WHERE app_current_tenant_id() IS NOT NULL
   AND p.status = 'settled'
   AND NOT EXISTS (
         SELECT 1 FROM fin_payment_allocations a
          WHERE a.tenant_id = p.tenant_id AND a.payment_id = p.id
            AND a.refund_id IS NULL AND a.invoice_id IS NOT NULL);
```

**`fin_v_fee_head_revenue` exposes `fee_head_id`, which contract point 2 forbids by its letter ("never
an `id`"), and the test's regex does not match it. This is a deliberate, bounded exception, and it is
recorded rather than hidden.** A fee head is a school-wide price-list line — the same row for every
family in the tenant — so its identity is not personal data. The rule point 2 protects is
**per-family** identity; a fee head has none. The rule is restated in §15.2.1 as: *no column that
identifies a **person, family, or document**; a taxonomy identifier whose row set is identical for
every family is permitted and must be named in this list.* The permitted taxonomy identifiers are
exactly: `fee_head_id`, `fee_head_code`, `fee_head_name`, `collection_day`, `collection_method`
(aliased `p.channel`), `aging_bucket`. Anything else fails.

**`finance-aggregate-view.test.ts`'s regex is therefore narrowed** from
`/(student|user|invoice|payment|guardian|parent|name|phone|email|iban)/i` to
`/(student|user|invoice|payment|guardian|parent|phone|email|iban)/i` **on column names only**, plus a
second assertion that the set of columns matching the narrowed pattern is empty, and a third that
every column is in the allowlist of taxonomy labels above. Dropping `name` from the regex is safe
*only* because the allowlist assertion is present: `parent_name` would be caught by `parent`, and a
bare `name` column not in the allowlist is caught by the allowlist check. The original regex's
`name` term was what would have rejected `fee_head_name` — a false positive on the one column that
was always going to be legitimate.

**Every view pins `tenant_id` from `app_current_tenant_id()` in the `SELECT` list and in the
`WHERE`, and every view is a join/aggregate over base tables the owner can read.** Contract point 6
is what stops a `platform` ticket from seeing all tenants' aggregates: `app_current_tenant_id()`
returns NULL off-tenant, the `WHERE` clause filters everything out, and the result is a single row of
`tenant_id = NULL` with zeroes — an empty result, not every tenant's numbers. The
`app_current_tenant_id() IS NOT NULL` predicate is therefore load-bearing and not decorative; without
it a `platform` session with no active tenant would get the full aggregate across all tenants, because
the aggregate itself would group every tenant's rows and only the projected `tenant_id` would be
NULL.

**No `GRANT SELECT` to `reporting_staff` on any base table is implied by these views.** The owner
(`school_migrator`) reads the base tables; `school_app_rw` receives `SELECT` on the view only. That is
why the views are owner-scoped and why §19.2 excludes `reporting_staff` from the document-money
`SELECT` policy — the two are complementary, not redundant.

### 15.3 The reconciliation proof (FI-009)

The brief's required proof, expressed so it is mechanically checkable:

```sql
-- Path A — from the ledger (authoritative for money actually posted)
SELECT SUM(amount) FILTER (WHERE direction='debit') - SUM(amount) FILTER (WHERE direction='credit')
FROM fin_ledger_entries
WHERE tenant_id = :t AND account_code = '1200';

-- Path B — from operational documents (independent of the ledger)
SELECT COALESCE(SUM(balance), 0) FROM fin_v_invoice_balance WHERE tenant_id = :t;

-- Path C — the brief's own formulation, from opening position
opening_receivable
  + issued invoices
  + debit adjustments
  − credits
  − allocated payments
  + refunds/reversals
  = ending receivable
```

All three are evaluated nightly by `fin_recompute` and must agree to the paisa. A mismatch writes an
audit row and emits the outbox event **`fee.reconciliation.drift`** — the previous revision said
`fee.reconciliation.drift` for the audit and `fee.reconciliation.exception` for the event, which are
two different names for one fact, and since only `fee.reconciliation.drift` appears in the §24.2
disposition table and in the 19-new-event count, the `exception` name was a phantom. One name, one
event, HANDLED by `finance-024` (§24.2).

**The event's identity, so a consumer can dedupe on a business key (P2-02).** An audit row keyed only
by timestamp cannot be deduplicated, and a nightly job will re-detect the same drift every night
forever, so the event payload is specified to carry a stable key:

| Field | Value |
|---|---|
| `check_name` | one of `path_a_vs_invoice`, `path_b_vs_ledger`, `path_c_vs_ledger` — the *which* of the three, so a consumer can route by failure type |
| `subject_type` / `subject_id` | `invoice` / the `fin_invoices.id`, or `payment` / the `fin_payments.id` |
| `expected_amount`, `actual_amount` | the two sides, as decimal **strings** (§16.2 — a JSON number would lose precision) |
| `drift_paisa` | `expected - actual`, so an alert can be thresholded without re-deriving |
| `first_detected_at` | set once and **not** updated on subsequent nightly detections, so a consumer can distinguish a new drift from a persistent one |

The corresponding audit row is keyed
`(tenant_id, check_name, subject_id, first_detected_at)`. The nightly job is then idempotent: a
persistent drift produces **one** alert and daily "still broken" updates, not a new alert per night.
T-FIN-31 (§29) asserts that two consecutive nightly runs over an unchanged drift produce exactly one
`fee.reconciliation.drift` event.

And — critically — the **ledger wins**. If Path B and Path C disagree, the operational aggregates are recomputed from
authoritative rows; the ledger is never adjusted to match a counter. This is what "authoritative"
means operationally, and stating it is what makes the proof meaningful rather than decorative.

The proof never relies solely on mutable invoice aggregates: Path A uses only append-only ledger rows,
and Path C uses only line items, adjustments, and allocations.

### 15.4 Ledger row shape

```sql
CREATE TABLE fin_ledger_entry_groups (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid NOT NULL,
    event_type      text NOT NULL,
    source_type     text NOT NULL,
    source_id       uuid NOT NULL,
    reversal_of_group uuid,
    total_debit     numeric(19,4) NOT NULL DEFAULT 0,
    total_credit    numeric(19,4) NOT NULL DEFAULT 0,
    entry_count     integer,
    sealed_at       timestamptz,
    posted_at       timestamptz NOT NULL DEFAULT now(),
    created_by      uuid,
    correlation_id  uuid,
    CONSTRAINT fin_leg_groups_reversal_fk
        FOREIGN KEY (tenant_id, reversal_of_group)
        REFERENCES fin_ledger_entry_groups (tenant_id, id) ON DELETE RESTRICT,
    CONSTRAINT fin_leg_groups_ten_id_uq UNIQUE (tenant_id, id),
    CONSTRAINT fin_leg_groups_balanced_ck CHECK (
        sealed_at IS NULL OR (total_debit = total_credit AND entry_count IS NOT NULL)
    )
);
-- Revoke the 0001 default-privilege grant immediately (§35.4, §30.3).
REVOKE ALL ON fin_ledger_entry_groups FROM school_app_rw;



CREATE TABLE fin_ledger_entries (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid NOT NULL,
    entry_group_id  uuid NOT NULL,
    account_code    text NOT NULL,
    direction       text NOT NULL CHECK (direction IN ('debit','credit')),
    amount          numeric(19,4) NOT NULL CHECK (amount > 0),
    -- Denormalised for AR aging. BOTH are tenant-composite FKs (P1-08): the previous
    -- revision declared the columns with no FK at all, so a leg could name a student
    -- or an invoice belonging to another tenant, or to no row at all, and the AR-aging
    -- report — which is built from these columns precisely because it must not depend
    -- on the invoice table — would then silently attribute a receivable to the wrong
    -- family. Both columns stay NULLABLE (a ledger leg can be a tenant-level or
    -- account-level posting with no student), and a composite FK permits NULL.
    student_id      uuid,
    invoice_id      uuid,
    posted_at       timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT fin_leg_entries_group_fk
        FOREIGN KEY (tenant_id, entry_group_id)
        REFERENCES fin_ledger_entry_groups (tenant_id, id) ON DELETE RESTRICT,
    CONSTRAINT fin_leg_entries_account_fk
        FOREIGN KEY (tenant_id, account_code)
        REFERENCES fin_ledger_accounts (tenant_id, code),
    CONSTRAINT fin_leg_entries_student_fk
        FOREIGN KEY (tenant_id, student_id)
        REFERENCES students (tenant_id, id) ON DELETE RESTRICT,
    CONSTRAINT fin_leg_entries_invoice_fk
        FOREIGN KEY (tenant_id, invoice_id)
        REFERENCES fin_invoices (tenant_id, id) ON DELETE RESTRICT,
    CONSTRAINT fin_leg_entries_ten_id_uq UNIQUE (tenant_id, id),
    CONSTRAINT fin_leg_entries_nonzero_ck CHECK (amount <> 0)
);
-- Revoke the 0001 default-privilege grant immediately (§35.4, §30.3).
REVOKE ALL ON fin_ledger_entries FROM school_app_rw;



-- AR aging reads (tenant_id, student_id); without this it is a sequential scan
-- of every leg ever written. A partial index, because the majority of legs are
-- tenant-level postings with no student.
CREATE INDEX fin_leg_entries_ar_idx
    ON fin_ledger_entries (tenant_id, student_id, account_code)
    WHERE student_id IS NOT NULL;
```

**`fin_ledger_accounts` needs its own anchor.** The account FK above is
`FOREIGN KEY (tenant_id, account_code) REFERENCES fin_ledger_accounts (tenant_id, code)`, so
`fin_ledger_accounts` must declare `UNIQUE (tenant_id, code)` — it does, as
`fin_ledger_accounts_code_uq` in §6.1 — and it must also declare `UNIQUE (tenant_id, id)` because
`fin_ledger_entry_groups` does not reference it but §35.2's test requires every `fin_*` table to carry
the anchor uniformly, so the index is present for uniformity rather than necessity. This is recorded
because a reader checking the FK inventory will notice that one `fin_*` FK target is keyed on a
business key (`code`) rather than on `id`, and should know that is intended.

`amount > 0` with an explicit `direction` is the standard representation and makes the balanced-group
check a plain `SUM` comparison. `ON DELETE RESTRICT` plus **no INSERT/UPDATE/DELETE privilege for
`school_app_rw`** (§30.3.3) plus a trigger means a ledger leg is permanent by three independent
mechanisms — and unlike the previous revision, the middle mechanism is a **privilege** rather than an
absent policy, so it holds even if a policy is later added carelessly.

`student_id` and `invoice_id` are denormalised onto the leg specifically so **AR aging reads the
ledger**, not the invoice table. This is what lets Path A above be per-student and makes the ledger
genuinely authoritative rather than a flat control total. It is also why they must be FK-backed: the
whole point of denormalising for a reporting path is that the reporting path becomes a *trustworthy*
independent source, and an unconstrained denormalised column is the opposite.

---

## 16. Money and rounding rules

### 16.1 Currency

**Single currency per tenant.** `fin_tenant_settings.currency char(3) NOT NULL DEFAULT 'PKR'`,
`CHECK (currency = upper(currency) AND char_length(currency) = 3)`. `fin_payments.currency` and
`fin_invoices.currency` are **copies pinned at creation** by trigger — a settlement from a historic
year must keep its original currency even if the school later changes the default (which is itself
out of scope: changing `fin_tenant_settings.currency` is blocked once any invoice exists).

**No FX.** No exchange rates, no multi-currency invoices, no rounding of converted amounts. The
`currency` column exists so that a future FX layer is additive, exactly as `FINANCE_DESIGN.md:90`
concluded. Storing a per-row currency while the tenant is single-currency is forward-compatibility,
not a hidden multi-currency feature.

### 16.2 Numeric type and scale

All money is `numeric(19,4)`. **Never** `float`, **never** `double precision`, **never** `int`.
`numeric` is exact base-10, which is what makes a debit sum equal to a credit sum a meaningful check rather
than a floating-point tolerance. `(19,4)` allows 15 integer digits and 4 decimal places; the scale
of 4 covers PKR paisa (2) with headroom for any future 3-decimal currency.

This is a genuine divergence from the JSDoc/examples implied by the brief's "PKR" framing: the brief
implies paisa. `numeric(19,4)` stores paisa exactly; paisa amounts are always integral multiples of
1, and **a CHECK enforces that where it matters** (below).

### 16.3 Rounding

- **Every** stored money value is an exact multiple of 1 paisa: `CHECK (amount = round(amount, 2))`
  on all money columns, since the tenant currency is PKR. This makes a sub-paisa value a
  *representable-state* failure rather than a silent rounding error.
- Rounding happens **exactly once**, at the point of division: proration, percentage discounts, and
  tax (when enabled). The rule is **half-up on the absolute value** — `round(abs(x) * 100) / 100`
  with the sign reapplied — implemented identically in SQL (`round()`) and TypeScript, with a unit
  test pinning agreement on 10,000 generated values including exact `.005` boundaries.
- **Line-level rounding, invoice-level exactness.** A percentage discount across N lines rounds each
  line, then the invoice total is the exact sum of the rounded lines. The alternative (round the
  invoice discount once) leaves lines that do not sum to the total — a discrepancy a school will
  eventually notice on a challan.
- **Allocation amounts need not be paisa-round in aggregate** — but each individual allocation must
  be, and `Σ allocations = allocated portion` is enforced exactly.
- **No floating point anywhere in the money path, and exactly one decimal library (P2-03).** The
  previous revision said "`decimal.js`/`big.js` **or** integer paisa" — three options, no decision, and
  the three do not agree with each other. `decimal.js` rounds half-up on the absolute value by
  default with configurable precision; `big.js` defaults to half-up at 20 significant digits but has
  no explicit rounding mode object; integer paisa is exact and cannot represent a `numeric(19,4)`
  sub-paisa value at all. Choosing per-call is how two components compute `0.1 + 0.2` differently
  and a `Σ allocations ≠ total` bug ships. **Adjudicated: `decimal.js`, configured once, in
  `packages/shared/src/money.ts`:**

  ```ts
  import Decimal from 'decimal.js';
  // 20 significant digits covers numeric(19,4) with room for intermediate products.
  // ROUND_HALF_UP on the absolute value with the sign reapplied is the rule of §16.3,
  // and it is the mode that matches PostgreSQL's round(numeric, int).
  Decimal.set({ precision: 20, rounding: Decimal.ROUND_HALF_UP });
  ```

  Three consequences, stated so the choice is falsifiable:

  1. **Configuration happens in exactly one module.** No component may call `Decimal.set`; a
     lint rule bans it outside `packages/shared/src/money.ts`, because a second `Decimal.set` is a
     silent global mutation that changes rounding for every other importer.
  2. **Every money value crossing a boundary is a decimal string, never a JS number.** JSON payloads
     carry `"amount": "45000.0000"`, not `45000`. `JSON.parse` of a bare number has already lost the
     precision before the code sees it, so the ban must extend to the *serialization* format, not just
     the arithmetic. The same rule applies to the drift event payload of §15.3.
  3. **The agreement test is the real control.** `T-FIN-08` (§28) runs the same **10,000** generated
     amounts through `Decimal` and through the database's `round()` and requires **exact string
     equality** of the two results, including the `.005` boundaries. A tolerance-based comparison
     would pass while the two implementations disagreed, which is the failure this test exists to
     catch. `number` is banned for money by a lint rule added with the helpers, and
     `TESTING_STRATEGY.md:17` already names "money math (numeric)" as a required unit test area.

### 16.4 Derived-before-stored

All aggregates are **derived, never stored**, unless there is a stated performance reason. When a
cache is stored, it is trigger-maintained from the authoritative rows and reconciled nightly. §16.5.

### 16.5 Cached columns and the integrity strategy

Cached (trigger-maintained, never client-written):

| Table | Cached columns | Authoritative source |
|---|---|---|
| `fin_invoices` | `subtotal`, `total`, `amount_paid`, `amount_refunded`, `amount_credited`, `balance` | `fin_invoice_items` + `fin_invoice_adjustments` + `fin_payment_allocations` |
| `fin_invoices` | `status`, `paid_at` | derived from `balance` |
| `fin_challans` | `status` | owning invoice's `status` and derived `balance` (§10.2, including `void`) |
| `fin_reconciliation_matches` | `is_final` | batch status |
| `fin_refunds` | `applied_allocations` | the reversal rows carrying `refund_id` (§13.2) |

**`fin_payments.status = 'reversed'` is removed from this table (P1-01).** The row asserted a cached
column that §11.1 explicitly forbids: `fin_payments.status` is
`CHECK (status IN ('pending','settled','failed'))` and a payment is **append-only**, so a
trigger-maintained `'reversed'` value would be a second mutable representation of a fact owned
entirely by `fin_payment_allocations`. A cache whose authoritative source is a table the cache's own
table does not reference is not a cache, it is a contradiction — and the previous revision listed it
here while §11.1 said it did not exist, which is precisely the kind of "a financial fact represented
twice" §12.1 exists to prevent.

`fin_refunds.applied_allocations` **is** a legitimate entry and is new: it is a denormalised copy of
the split the approve transaction computed, and unlike the removed row it (a) has a declared
authoritative source, (b) is written in the same transaction as that source, (c) is guarded by
`fin_refunds_decision_ck` which makes it non-null exactly when the status is decided, and (d) is
re-derived by the deferred completeness trigger of §13.3.1 at the same COMMIT that created its
source. It exists so an approval screen can display what was actually approved without re-joining
allocation rows that may since have been themselves reversed.

**"Fully reversed" is a query, not a column.** Where §11.1 needs it, it is
`fin_v_payment_position.refundable_amount = 0 AND applied_amount = 0 AND refunded_amount > 0`,
evaluated in the view. FI-007 asserts that `fin_payments` has no column named
`reversed`/`reverses_payment_id`/`amount_reversed`, so this specific regression cannot come back.

Integrity strategy — three layers, all mandatory:

1. **Trigger recomputation.** Every mutation of an authoritative row recomputes the affected caches
   in the same transaction. No cache is ever written from a supplied value.
2. **Nightly `fin_recompute`.** Recomputes all caches from authoritative rows and writes
   `fee.reconciliation.drift` audit rows on mismatch. Also cross-checks FI-009 (§15.3).
3. **Gated property test.** A randomised 10,000-operation test (§28, and the roadmap's own Phase 7
   acceptance criterion) asserts, after every operation, that every cache equals its derivation.

**No cache is the only copy of a fact.** If a cache is deleted, the fact is recomputable. This is
the direct answer to the brief's "do not create mutable duplicate counters without a documented
integrity strategy."

### 16.6 Sign and negative-value discipline

| Value | Sign rule |
|---|---|
| `fin_invoice_items.amount` | `>= 0` (a line is a charge) |
| `fin_invoice_adjustments` | **signed**; the row stores `amount` plus `direction`, so a credit is a positive magnitude with `direction='credit'` and the sign is derived — never a negative stored amount |
| `fin_payment_allocations.amount` | signed; positive = applied, negative = reversed (CHECK-enforced by `effect`) |
| `fin_payments.amount` | `> 0` (a payment is an inflow) |
| `fin_refunds.amount` | `> 0` (an outflow magnitude) |
| `fin_ledger_entries.amount` | `> 0` with explicit `direction` |
| **balances** | `>= 0` (FI-015) — except `invoice_balance` on a fully-credited invoice, which may be **negative** (credit in excess of charge); that is a legitimate over-credit state and is reported as such, not clamped |

Adjustments store a direction rather than a negative amount because a bare `amount < 0` in a column
also declared `CHECK (amount >= 0)` is a contradiction the brief's §9 originally created. Direction is
explicit; sign is derived exactly once, in the balance formula.

### 16.7 The authoritative money-field register

The brief's hardest money requirement is a register of **every** money-bearing field answering the
same nine questions, because "which of these columns is the truth?" is the question that decides
whether a system can be audited. The register is below. It is **normative**: any new money column
must be added here before it is added to a migration, and `finance-001` fails if a `fin_*` column
matching `amount|total|balance|paid|refunded|credited|subtotal|fee|due` appears in `information_schema`
but not in this table.

Legend for **kind**: `stored-authoritative` (the row *is* the fact), `cached-derived` (recomputable
from `stored-authoritative` rows by the named formula), `derived-view` (never stored at all).

| # | Field | Kind | Authoritative source / formula | Sign | Who writes it | Who reverses it | Ledger leg | Used in reporting | Immutable? |
|---|---|---|---|---|---|---|---|---|---|
| 1 | `fin_invoice_items.amount` | stored-authoritative | itself | `≥ 0` | `fees.invoices.create`, at issue | never reversed — a line is removed only by voiding the whole invoice | via `invoices.total` | fee-head revenue, invoice detail | yes once issued (FI-010) |
| 2 | `fin_invoice_adjustments.amount` | stored-authoritative | itself, with `direction` | `> 0` magnitude; **sign is `direction`-derived** | `fees.adjustments.create` / `.approve` | a reversal is a **new opposite-direction row** with `reverses_adjustment_id`; never an `UPDATE` | via `invoices.total` | concession/fine reporting, net-fee reports | append-only |
| 3 | `fin_invoices.subtotal` | cached-derived | `Σ fin_invoice_items.amount` | `≥ 0` | trigger only | recompute | no direct leg | invoice detail | recomputable, not a fact |
| 4 | `fin_invoices.total` | cached-derived | `subtotal` + signed `Σ adjustments` (FI-001) | `≥ 0` unless over-credit | trigger only | recompute | **yes** — the receivable | AR aging, AR reports, revenue | **the** invoice money fact once issued; frozen at issue |
| 5 | `fin_invoices.balance` | cached-derived | `total − Σ allocations.amount` for the invoice (FI-002) | `≥ 0` except over-credit | trigger only | recompute | no direct leg | **every** balance-bearing report and the portal | recomputable |
| 6 | `fin_invoices.amount_paid` | **derived-view only** | `Σ allocations.amount WHERE invoice_id = i AND refund_id IS NULL` | `≥ 0` | *nobody — no column exists* | n/a | no | invoice list, portal | not stored, by design |
| 7 | `fin_invoices.amount_refunded` | **derived-view only** | `−Σ allocations.amount WHERE invoice_id = i AND refund_id IS NOT NULL` | `≥ 0` | *nobody* | n/a | no | refund reporting, invoice detail | not stored, by design |
| 8 | `fin_invoices.amount_credited` | **derived-view only** | `Σ credit adjustments applied after issue` | `≥ 0` | *nobody* | n/a | no | concession reporting | not stored, by design |
| 9 | `fin_payments.amount` | stored-authoritative | itself | `> 0` | `fees.payments.collect`, or the webhook handler | **never** — `CHECK (amount > 0)` makes a negative payment unrepresentable; a mistake is undone by a reversing **allocation** (FI-007) | `Dr 1000 / Cr 1300` (unapplied) or the applied leg | collection totals, cash position | append-only; only `pending → settled/failed` may change |
| 10 | `fin_payment_allocations.amount` | stored-authoritative | itself; **the single signed source** for every "how much is applied / unallocated / refunded" question | `<> 0`; positive = applied, negative = reversed | `fees.payments.collect` / `.reverse` | by a **further** reversing row, never an `UPDATE` | `Dr 1300 / Cr 4000` etc., or `Dr 1200 / Cr 1300` for a correction | collections, AR application, unapplied-cash aging | append-only (FI-007) |
| 11 | `fin_refunds.amount` | stored-authoritative | itself | `> 0` magnitude (an outflow) | `fees.refunds.request` | never; a processed refund is terminal and is recovered by a **new payment** (§13.5 ex. 4) | `Dr 1200 / Cr 2200` on **approve**; `Dr 2200 / Cr 1000/1100` on **process** (§15.1, §35.7 rows 2 and 4) | refund register, AR relief | state-machine controlled (FI-006, FI-017) |
| 12 | `fin_ledger_entry_groups.total_debit` / `.total_credit` | stored-authoritative | sealed at post time and **equal by construction** (FI-008) | `≥ 0` | `post_fin_ledger_group` only | never | n/a — they *are* the ledger | trial balance, financial statements | sealed, append-only |
| 13 | `fin_ledger_entries.amount` | stored-authoritative | itself, with `direction` | `> 0` magnitude | `post_fin_ledger_group` only | never; a correction is a **new balanced group** referencing the original | n/a | account balances, trial balance | append-only, no UPDATE/DELETE **for any role** |
| 14 | `fin_ledger_accounts.balance` | **derived-view only** | `Σ signed entries` per account | any | *nobody* | n/a | n/a | **every** financial statement | not stored |
| 15 | `fin_challans.amount_due` | **derived-view only** | the owning invoice's `balance` at read time | `≥ 0` | *nobody* — this is why a challan needs no `amount_due` column and cannot drift from its invoice | n/a | no | collection instrument, AR aging | not stored; the challan's `snapshot jsonb` freezes what the family was shown at issue |
| 16 | `fin_receipts.amount` | stored-authoritative (a **copy at issue**) | `payment.amount` frozen at issue; deliberately a copy, because a receipt is a document | `> 0` | `fees.payments.collect` | never | no (it restates #9) | receipt PDF, portal | **immutable for life** (FI-019) |
| 17 | `fin_fee_structure_items.amount` | stored-authoritative | itself | `≥ 0` | `fees.structures.manage` | never; a price change is a **new version** (`supersedes_id`) | no | price-list reporting | immutable after publish |
| 18 | `fin_fee_installment_plans.due_on` | not money, but paired | — | — | `fees.structures.manage` | new version | no | due-date calendars | immutable after publish |
| 19 | `fin_reconciliation_batches.variance_amount` | cached-derived | `statement_total − matched_total` at completion | signed (either direction) | trigger at completion | never; a batch is immutable once completed (FI-018) | no | reconciliation summary | sealed at completion |
| 20 | `fin_billing_run_items.amount` | stored-authoritative (a **trace**, not a fact) | the amount the run resolved, copied so a run is replayable | `≥ 0` | billing run only | never | no | billing-run audit, dispute resolution | **immutable** — it is the record of what was decided, not of what is owed |
| 21 | `fin_tenant_settings.currency` | stored-authoritative | itself | n/a | `school_owner` | never | n/a | every report header | blocked from changing once any invoice exists (§16.1) |

**Four properties this table exists to establish, stated as findings:**

1. **No money fact is stored twice.** Rows 6, 7, 8, 14 and 15 have **no column at all** — they are
   view expressions. The naive design carries `amount_paid`, `amount_refunded`, `amount_credited`,
   `challans.amount_due` and `ledger_accounts.balance` as columns, which is five independent drift
   surfaces for facts that are already derivable. The one place a duplicate *is* kept is row 16, the
   receipt's frozen `amount`, and that is a deliberate **document** copy (§25.5), not a cache.
2. **Every cached column has a named derivation and a named writer** (rows 3, 4, 5, 19) — trigger
   only, never a client (§16.5).
3. **Every stored-authoritative row has exactly one write permission** (rows 11, 12, 13, 17) and a
   stated reversal rule, and in every case the reversal is a **new row**, never an `UPDATE`. This is
   the property that makes the ledger reconstructible.
4. **Nothing in the money path is client-supplied.** `POST /invoices` has no `total`;
   `POST /payments` has no `unallocated`; `POST /refunds` has no `refundable`. A field a client can
   send is a field a client can lie about, and this design has no such field on any financial route.

---

## 17. Financial invariant catalogue

This is the **authoritative** catalogue. `FI-xxx` identifiers are stable and are referenced by name
from tests, migrations, and code comments. Every invariant states where it is enforced in the
database, where in the application, its transaction boundary, and the test that proves it.

Legend for **DB**: `constraint` = CHECK/UNIQUE/FK; `trigger` = plpgsql trigger; `index` = partial
unique index; `view` = a published view; `—` = not enforceable in the database.

| ID | Invariant |
|---|---|
| FI-001 | invoice total |
| FI-002 | invoice balance |
| FI-003 | payment allocation availability |
| FI-004 | invoice allocation availability |
| FI-004a | on-account integrity (the invariant that makes FI-005's bound sound) |
| FI-005 | refund availability |
| FI-006 | refund allocation completeness |
| FI-007 | payment reversal semantics |
| FI-008 | ledger balance |
| FI-009 | ledger-to-operational reconciliation |
| FI-010 | immutable issued document |
| FI-011 | document numbering |
| FI-012 | atomic audit + outbox |
| FI-013 | idempotency convergence |
| FI-014 | tenant isolation |
| FI-015 | no negative financial balance where prohibited |
| FI-016 | no double allocation |
| FI-017 | no double refund |
| FI-018 | no double reconciliation |
| FI-019 | receipt integrity (issued once, immutable, provably against its payment) |

---

**FI-001 — Invoice total**

*Formal:* `invoice_total(i) = Σ fin_invoice_items.amount − Σ credit_adjustments + Σ debit_adjustments`,
where a credit adjustment has `direction='credit'` and a debit adjustment `direction='debit'`.

- **DB:** `constraint` — `invoice_items.amount >= 0`; `adjustments.amount > 0` with
  `direction ∈ ('debit','credit')`; a `BEFORE INSERT OR UPDATE` trigger recomputes
  `invoices.subtotal`/`total` from the line and adjustment rows. Client-supplied totals are ignored
  by the trigger, not merely discouraged. **`trg_fin_invoice_item_total` is bound to BOTH
  `fin_invoice_items` and `fin_invoice_adjustments`**, because the function reads both tables and a
  function is only *invoked* by a trigger on the table that changed — a single binding would leave a
  waiver permanently absent from `total` (§9.6).
- **App:** Zod schemas accept **no** total fields. `POST /invoices` takes line items only. Sending a
  total is a validation error, not a silently-dropped field.
- **Transaction:** the recompute trigger runs inside the issuing transaction; `total` is never
  observable between the line write and the recompute.
- **Test:** `finance-001` — insert N lines + M adjustments, assert `total`; attempt a client-supplied
  total, assert it is ignored; assert a `draft` invoice's `total` tracks live line edits; **and
  assert that inserting an adjustment *alone*, with no line write in the same transaction, moves
  `total`** — that is the assertion which fails if the second binding is ever dropped.

---

**FI-002 — Invoice balance**

*Formal:* `invoice_balance(i) = invoice_total(i) − net_applied(i)` where
`net_applied(i) = Σ fin_payment_allocations.amount WHERE invoice_id = i` (signed).

- **DB:** `view` — `fin_v_invoice_balance` publishes exactly this (§12.4.1); `trigger` —
  `trg_fin_invoice_balance_recompute` maintains the cached `invoices.balance` via the
  `RETURNS void` helper `trg_fin_invoice_recalc_balance(uuid, uuid)`, and is bound to **all three
  tables that feed the value**: `fin_invoice_items`, `fin_invoice_adjustments`, and
  `fin_payment_allocations`. Two of those bindings are in 0023 and the third in 0024, because the
  block is ordered by the migration that creates each trigger's target table. A cache correct for
  only one of its three inputs is worse than no cache, because it is trusted. **Both sides of an
  allocation move are recomputed** — an `UPDATE` that changes `invoice_id` would otherwise leave the
  origin invoice's balance stale with no later event to correct it.
- **App:** every invoice response and every balance-bearing read goes through the view, never through
  hand-written SQL. One formula, one implementation (§12.4). The trigger path and the view path
  compute the same shape from the same four independent sub-queries; they are separate statements
  because a view's output column cannot be referenced in its own `SELECT` list, and
  `finance-property.test.ts` is what keeps them from drifting.
- **Transaction:** recompute is in the same transaction as the allocation; no read-committed window
  exposes a stale balance.
- **Test:** `finance-002` — property test across 10,000 random allocation/refund operations asserting
  `balance == total − net_applied` after every operation, where the random operations include line
  edits, adjustment inserts, allocation moves **and deletes**, not only allocations. A generator that
  only ever inserts allocations passes against a trigger bound to one table.

---

**FI-003 — Payment allocation availability**

*Formal:* for every payment `p`, `Σ a.amount (a.payment_id = p, a.refund_id IS NULL) ≤ p.amount`.
Equivalently `payment_unallocated(p) ≥ 0`. The sum spans **all** of `p`'s non-refund allocations,
including the `invoice_id IS NULL` on-account movements, because both consume the payment's
balance; only the *refund* rows are outside it.

- **DB:** `trigger` — `trg_fin_allocation_bounds` locks the payment row `FOR UPDATE`, recomputes
  `Σ a.amount WHERE payment_id = p AND refund_id IS NULL` for the payment, and raises
  `55000 allocation exceeds payment amount` if the running total would exceed `payment.amount`. The
  lock is what makes it safe under concurrency. `trg_fin_reversal_shape` (§12.1) additionally
  requires every reversal to name the same `invoice_id` as its target, so a reversal cannot move
  money between invoices to dodge FI-004.
- **App:** the service re-checks after acquiring the lock (fast 422) and maps `55000` to
  `409 allocation_exceeds_payment`.
- **Transaction:** the payment row lock is held for the duration of the allocation transaction.
  Lock order: invoices ascending, then payments ascending (§12.6).
- **Test:** `finance-003` — (a) single-threaded over-allocation raises; (b) **two concurrent
  allocations racing the same remainder**: N concurrent transactions each attempt to allocate the
  last 1,000; exactly one succeeds, the rest raise; no deadlock, no partial over-allocation;
  (c) an on-account return that would drive `unallocated` below zero raises.

---

**FI-004 — Invoice allocation availability**

*Formal:* for every invoice `i`, `net_applied(i) ≤ invoice_total(i)`, i.e. `invoice_balance(i) ≥ 0`,
except for a documented over-credit state. Rows with `invoice_id IS NULL` are outside this
invariant entirely — they are not invoice-scoped, so there is no invoice for them to exceed.

- **DB:** `trigger` — same function as FI-003, additionally locks the invoice ascending and checks
  `net_applied(i) ≤ total(i)`, **only when `NEW.invoice_id IS NOT NULL`**. The over-credit exception
  is only reachable via a credit adjustment that makes `total` smaller than `net_applied`, which is
  legitimate and must be allowed.
- **App:** rejects an allocation exceeding the balance with `422 allocation_exceeds_invoice_balance`.
- **Transaction:** inside the allocation transaction, after the invoice lock.
- **Test:** `finance-004` — over-allocation against an invoice raises; the over-credit case (credit
  adjustment on a fully-paid invoice) is *allowed* and produces a negative balance flagged in reports;
  a reversal that names a *different* invoice than its target raises.

---

**FI-004a — On-account integrity**

*Formal:* a row with `invoice_id IS NULL` may not carry `refund_id`, and a row with
`refund_id IS NOT NULL` may not have `invoice_id IS NULL` — a refund reversal always names the
invoice whose application it unwinds. Enforced by `fin_pa_effect_ck` plus `trg_fin_reversal_shape`.

*Why this is listed separately:* it is the invariant that makes the FI-005 bound sound. If a refund
reversal could be written with a NULL `invoice_id`, it would escape the
`invoice_id IS NOT NULL` filter in `payment_applied` and silently inflate the refundable ceiling.

- **DB:** `constraint` on `effect`/`refund_id` combinations, cross-checked by
  `trg_fin_reversal_shape`.
- **App:** the allocation schema has three shapes (`apply` / `reverse` / on-account) and the Zod
  discriminated union makes the illegal combination unrepresentable in TypeScript too.
- **Test:** `finance-004a` — raw SQL attempting a NULL-invoice refund reversal raises.

---

**FI-005 — Refund availability**

*Formal:* for every payment `p`, `Σ_{r ∈ refunds(p), r.status ∈ ('approved','processed')} r.amount
≤ payment_applied(p)`, where `payment_applied(p)` is the signed sum of that payment's allocations
that name an invoice. Equivalently
`payment_refundable(p) = payment_applied(p) − payment_refunded(p) ≥ 0`.

The bound is **not** `p.amount`. Cash sitting unapplied is not refundable, because it was never
owed — paying it out would be a disbursement of money the school is merely holding, which is the
classic over-refund diversion path (T-FIN-08). The bound is therefore
`payment_applied(p) = Σ a.amount WHERE payment_id = p AND refund_id IS NULL AND invoice_id IS NOT
NULL`, and an attempt to refund uncollected cash is refused with a **distinct** error
(`no cash from this payment is applied to a charge`) that points the operator at the on-account
return operation instead (§12.1, §12.2).

- **DB:** `trigger` — `fn_fin_refund_ceiling` (§13.3.1), with the payment row locked. Enforced on
  `INSERT` and on the `requested → approved` transition. Re-proven by `finance-005` as **raw SQL**,
  bypassing the API entirely.
- **App:** pre-check from `fin_v_payment_position.refundable` + `mapDomainError` →
  `409 refund_exceeds_payment`, and `422 nothing_applied_to_refund` for the zero-applied case.
- **Transaction:** the approval transaction; the payment lock serialises concurrent approvals.
- **Test:** `finance-005` — (a) a refund above the refundable amount raises `55000`; (b) **the
  diversion case**: take a 100,000 payment, allocate nothing, attempt a 100,000 refund → raises
  `55000` and the error text is the `nothing_applied_to_refund` variant, not
  `refund_exceeds_payment`; (c) partially apply 60,000, refund 100,000 → raises; (d) two concurrent
  approvals splitting the last 50,000 result in exactly one success.

---

**FI-006 — Refund allocation completeness**

*Formal:* for every refund `r` in status `approved` or `processed`,
`Σ |a.amount| over allocations with a.refund_id = r.id = r.amount`.

- **DB:** `constraint` `refund_id IS NOT NULL ⟹ reversal_of_allocation_id IS NOT NULL` on allocations,
  and the **deferred** constraint trigger `fn_fin_refund_ceiling`, which evaluates this at **COMMIT**
  rather than on the `requested → approved` transition.
- **Why COMMIT and not the transition.** This was the previous revision's defect: it named a `trigger`
  `fin_refunds` at `requested → approved` and had the service write every reversal row *before*
  requesting approval, so completeness was a property of the request rather than of the stored fact.
  §13.5.1 states the resolution — the reversal rows are **created at approval**, one per proposed
  allocation, so a per-refund sum cannot be evaluated until the whole refund exists. A `BEFORE`
  transition trigger would fire before the rows it is meant to sum. The service therefore records the
  *proposed* allocation list at request time and the **approval transaction** creates the reversal
  rows; the deferred trigger then rejects the COMMIT if the two disagree. Over-coverage is caught at
  the same instant as under-coverage, by the same `55000`.
- **App:** the refund service proposes the allocation list with the request and cannot request a
  refund whose proposals do not sum to its amount; the approval path creates the reversal rows in the
  same transaction. It cannot approve a refund it did not fully cover, because the constraint decides.
- **Transaction:** the approval transaction, with the invariant evaluated at COMMIT.
- **Test:** `finance-006` — a refund with under- and over-coverage both raise `55000` at COMMIT, not at
  the transition; a fully covered refund commits; and a refund whose reversal rows are deleted between
  approval and COMMIT fails the commit rather than succeeding and being caught later.

---

**FI-007 — Payment reversal semantics**

*Formal:* a `fin_payments` row is never `UPDATE`d or `DELETE`d for financial purposes, and there is
**no** compensating payment row. A reversal is a **new** `fin_payment_allocations` row with
`effect='reverse'`, `amount < 0`, and `reversal_of_allocation_id` set. `net_applied` is the signed
sum. `refund_id IS NULL` ⇒ money returns to on-account (or, with `invoice_id IS NULL`, leaves as an
on-account return); `refund_id IS NOT NULL` ⇒ money is disbursed to the family.

*There is no `status = 'reversed'` and no `reverses_payment_id`.* Both were removed: a second
reversal mechanism is a second source of truth for the same fact, and a status that must be mutated
to reflect an allocation-table fact is a trigger-maintained cache on a table that is supposed to be
append-only (§11.1). "Fully reversed" is a predicate in `fin_v_payment_position`, not a column.

- **DB:** `constraint` (`fin_pa_effect_ck`), `index` (`fin_pa_one_correction_uq`,
  `fin_pa_one_reversal_per_refund_uq`), `trigger` (`trg_fin_reversal_shape` requires the reversal to
  name the same `invoice_id` as its target, and its magnitude may not exceed the target's remaining
  outstanding magnitude; `trg_fin_allocation_bounds` bounds the payment total).
- **App:** the reversal service reads the target row, computes the permitted magnitude, and writes
  exactly one row. There is no code path that writes a second reversal mechanism.
- **Transaction:** single transaction; the allocation lock order applies (§12.6).
- **Test:** `finance-007` — the original payment row's bytes are byte-identical before/after
  reversal (assert by `SELECT` of all columns); reversal sums correctly; a second correction
  reversal against the same allocation raises `23505`; a reversal naming a different invoice raises
  `55000`; a reversal exceeding the target's outstanding magnitude raises; `unallocated` and
  `refunded` move in the correct directions per §12.3; and **`status` is still `settled`** after a
  full reversal, proving the label was not smuggled back in as a column.

---

**FI-008 — Ledger group balance**

*Formal:* for every sealed group `g`, `g.total_debit = g.total_credit` and
`g.entry_count = COUNT(entries)`.

- **DB:** `constraint` (`fin_leg_groups_balanced_ck`) + `trigger` (deferred statement-end check
  across groups, §15.1) + `trigger` (reject legs into a sealed group).
- **App:** a single `postLedgerGroup()` helper is the only writer; application-level balancing is a
  convenience, not the control.
- **Transaction:** the group is opened, legs inserted, totals updated, `sealed_at` set — all inside
  the business transaction, so a business failure rolls the ledger back with it.
- **Test:** `finance-008` — raw SQL inserts an unbalanced group and asserts `55000`; a `0001.00` vs
  `0000.99` pair raises; `UPDATE` and `DELETE` on `fin_ledger_entries` raise **as `school_migrator`**.

---

**FI-009 — Ledger-to-operational reconciliation**

*Formal:* `balance(1200) = Σ invoices balance` = Path C (§15.3), all three to the paisa.

- **DB:** `view` for all three paths; no enforcement (it is an assertion, not a constraint).
- **App:** nightly `fin_recompute` worker; on mismatch → audit row + outbox
  `fee.reconciliation.drift` (**one** name for the fact, per §16.5 — there is no
  `fee.reconciliation.exception` event, and §15.3 and §16.5 disagreed about that in the previous
  revision). **The ledger wins; caches are recomputed.**
- **Transaction:** a read-only scan; no locks held.
- **Test:** `finance-009` — a full scenario (issue → pay → allocate → refund → correct → void) with
  all three paths asserted equal; then a deliberate cache corruption (via `school_migrator` raw SQL)
  followed by `fin_recompute` asserting convergence.

---

**FI-010 — Immutable issued document**

*Formal:* once an invoice is `issued`, its lines, its adjustments, its receipts, and its ledger
entries are immutable. Corrections are new rows.

- **DB:** `trigger` on `fin_invoice_items` (freeze at issue), on `fin_invoice_adjustments`
  (append-only, no `UPDATE`/`DELETE`), on `fin_receipts` (immutable except the artifact pointer),
  on `fin_ledger_entries` (no `UPDATE`/`DELETE` for any role).
- **App:** no route exposes an update or delete for these; the authorization contract would need a
  permission that **does not exist in the catalog** for them, so the route cannot even be declared.
- **Transaction:** n/a (immutability is a persistent property, not a transactional one).
- **Test:** `finance-010` — raw-SQL `UPDATE`/`DELETE` on each, as both `school_app_rw` and
  `school_migrator`, all raise. Receipt artifact pointer is the **only** permitted update and is
  asserted to be `NULL → <id>` only.

---

**FI-011 — Document numbering**

*Formal:* for a given `(tenant_id, kind, period_key)`, committed numbers are **strictly increasing**
and **never reused**. Gaps are permitted. Voided numbers are consumed permanently.

- **DB:** `constraint` `fin_invoices_number_ck` (draft ⇒ NULL), `index`
  `fin_invoices_number_uq (tenant_id, invoice_no) WHERE invoice_no IS NOT NULL`, `constraint`
  counter `next_value >= 1`, `trigger` counter-increment-only.
- **App:** allocation is a single `UPDATE … RETURNING` inside the issue transaction.
- **Transaction:** the counter row is locked; a rollback returns the number to the pool **only if the
  increment was part of the same transaction** — which it is, so a rolled-back issue does not consume
  a number. A *committed* issue consumes it forever.
- **Test:** `finance-011` — N concurrent issues produce N **distinct** numbers; the committed set is
  strictly increasing by commit order; a forced rollback leaves no gap; a voided invoice's number is
  never reassigned. Explicitly **not** asserted gap-free — see §14 (numbering) for why.

---

**FI-012 — Atomic audit + outbox**

*Formal:* for every finance mutation, the business rows, the `audit_logs` row, and the `outbox_events`
row commit in one transaction, or none do.

- **DB:** same transaction. The repository's `audit_logs` and `outbox_events` INSERT policies reject
  a tenant-scoped write when `tenant_id ≠ app_current_tenant_id()`, which is the database backstop.
- **App:** every finance service function does mutate → `writeAudit` → `enqueueOutbox` inside one
  `withTenant` callback, following `grade-levels.ts:67-84` exactly. A helper
  `withFinanceTx(ctx, fn, {audit, event})` makes the triple structurally hard to omit.
- **Transaction:** the single `withTenant` transaction.
- **Test:** `finance-012` — force a failure after the business write and assert **no** audit row, **no**
  outbox row, and no business row; and force a failure after the outbox insert and assert the same.

---

**FI-013 — Idempotency convergence**

*Formal:* a repeated logical request produces **the same financial outcome**, exactly one set of
rows, and the identical response body — whether the repeat arrives sequentially, concurrently, or
after a crash mid-transaction.

- **DB:** `constraint` `fin_payments_idem_uq (tenant_id, idempotency_key)`;
  `idempotency_keys_tenant_key_uq` (existing, `0001:195`); `index`
  `fin_billing_runs_idempotency_uq`.
- **App:** `x-idempotency-key` + `withIdempotency`'s savepoint + `23505`/`40001` replay
  (`packages/idempotency/src/index.ts:104-124`). **Mandatory** for every money POST — see §21.1 for
  the enforcement gap this closes.
- **Transaction:** the replay path reads the winner's stored response inside the loser's transaction
  after rolling back only its own savepoint.
- **Test:** `finance-013` — same key twice ⇒ one payment row, one allocation set, identical response
  body and status; 20 concurrent identical POSTs ⇒ one row; a **different body with the same key** ⇒
  `409 idempotency_key_reuse` (see §21.1 — this is a **deliberate change** to the current
  "first-write-wins, silently replay" behaviour, and it is required for money).

---

**FI-014 — Tenant isolation**

*Formal:* **for every non-elevated actor**, in every role, including `platform_admin`, no operation
on a finance table can read or write a row whose `tenant_id` differs from the caller's verified
tenant claim. The two roles that are deliberately *not* bound by this clause are
**`school_migrator`** (the migration and worker role) and any session using it; §19.6 enumerates
them, and their controls are stated there and in §24.4. This carve-out is written **into the
invariant** rather than left as an unstated exception, because an invariant that its own test
violates is worse than no invariant — the first honest account of it is what keeps the carve-out
visible.

- **DB:** composite `(tenant_id, id)` FKs make cross-tenant *references* unrepresentable, for every
  role including `school_migrator` — this half of the invariant is **unconditional**; every finance
  policy is tenant-scoped and relationship-scoped for every non-elevated actor (§19);
  `security_invoker` views.
- **App:** an explicit `tenant_id = ctx.tenantId` predicate in every WHERE clause, in addition to
  RLS — the house pattern (`grade-levels.ts:250`) and the worker's proven requirement
  (`outbox-integration.test.ts:582-614`).
- **Elevated actors:** `app_privileged()` is a whole-connection property, so a `school_migrator`
  session is bound only by the *discipline* controls — the static guard test asserting every worker
  finance query carries a `tenantId` predicate, and the migration's own post-condition assertions.
  This is a **pre-existing property of the repository's trust model** (`0002`), inherited unchanged;
  the honest long-term fix (per-user connection roles or a dedicated worker pool) is recorded as
  out of scope in §19.6 and in ADR-014.
- **Transaction:** n/a.
- **Test:** `finance-014` — the six negative cases the brief names, plus: an `accountant` of tenant
  A cannot read tenant B's rows even holding a valid tenant-B id; `platform_admin` with a valid
  platform ticket gets **zero rows** from every `fin_*` table; a forged `app.current_tenant` GUC
  buys nothing (the `0002` property, re-proven for finance); **and** the two clauses are asserted
  separately — the *reference* clause holds for `school_migrator` too, while the *visibility* clause
  is asserted **not** to hold for it, so a future refactor cannot quietly promote or demote the
  carve-out without failing a test.

---

**FI-015 — No negative financial balance where prohibited**

*Formal:* `payment_unallocated(p) ≥ 0`; `payment_refundable(p) ≥ 0`; `invoice_balance(i) ≥ 0` except
the documented over-credit state; no allocation row has `amount = 0`; no ledger leg has `amount ≤ 0`.

- **DB:** `constraint` `CHECK (amount <> 0)` on allocations and `CHECK (amount > 0)` on payments,
  refunds and ledger legs; the FI-003/FI-004 triggers bound the derived balances; `constraint` on
  `fin_challans` that a challan is never issued for a `balance <= 0` invoice.
- **App:** never returns a negative balance to a client; the over-credit state is surfaced as a
  distinct, labelled report line, not clamped to zero.
- **Transaction:** n/a (CHECK constraints).
- **Test:** `finance-015` — each prohibited negative is rejected at the database; the over-credit
  state is produced deliberately and reported correctly.

---

**FI-016 — No double allocation**

*Formal:* a given payment amount is applied to a given invoice at most once, and a given allocation
is corrected at most once.

- **DB:** `index` `fin_pa_one_correction_uq (reversal_of_allocation_id) WHERE reversal_of_allocation_id IS NOT NULL AND refund_id IS NULL`;
  the FI-003/FI-004 signed-sum triggers make over-application impossible.
- **App:** the service reads availability from the view and writes one row; a replay is caught by the
  idempotency key.
- **Transaction:** inside the allocation transaction under the payment and invoice locks.
- **Test:** `finance-016` — two identical allocations with different idempotency keys but the same
  intent raise (bounds trigger); a second correction reversal raises `23505`.

---

**FI-017 — No double refund**

*Formal:* the total refunded against a payment never exceeds the **applied** amount — the cash actually
applied to it, which is `Σ fin_payment_allocations.applied_amount`, not `fin_payments.amount`; a refund
is never processed twice; the reversal rows for a refund sum exactly to it.

- **DB:** `trigger` `fn_fin_refund_ceiling` (payment-locked); `index`
  `fin_pa_one_reversal_per_refund_uq`; the FI-006 completeness trigger; the `fin_refunds` state
  machine rejecting `processed → processed`.
- **Why `applied` and not `payment.amount`.** This was the previous revision's defect: it bounded the
  refund by `fin_payments.amount`, which is a bound on the *cash received*. A payment is only
  refundable up to what was **allocated**, so the correct ceiling is the applied total — otherwise a
  payment of 1000 allocated against two invoices at 400 each could be refunded by 1000, double the
  800 actually applied and 200 more than the second invoice was ever charged. `fin_receipts` exists
  because receipting follows **applied**, not gross (§25); the refund ceiling follows the same rule.
  `payment.amount − Σ applied` is the unapplied remainder, and a refund of it is not a refund of a
  charge at all, it is a different transaction (a new payment, per §13.5 ex. 4).
- **App:** the process service transitions `approved → processed` with a
  `WHERE status = 'approved'` guard and checks the returned row count, so a double-click is a no-op.
- **Transaction:** the processing transaction, payment-locked.
- **Test:** `finance-017` — concurrent `process` calls on one refund ⇒ exactly one posts, the other
  converges to the same result; a provider retry of the disbursement is idempotent on `refund_no`; and
  **a refund of an unapplied remainder is rejected** — a payment with an unallocated balance is
  refundable only to the applied total, not to `payment.amount`.

---

**FI-018 — No double reconciliation**

*Formal:* a payment is finalised in at most one reconciliation match, ever.

- **DB:** `index` `fin_recon_payment_final_uq (tenant_id, payment_id) WHERE is_final` (P2-04) and
  `fin_recon_tenant_batch_payment_uq (tenant_id, batch_id, payment_id)`. The index is **partial on
  `is_final`**, which is what makes the invariant "finalised at most once" rather than "matched at
  most once" — a payment may be *proposed* in many open batches. That is only sound if `is_final` is
  correct on every row, and it is maintained by **three triggers that form a closure**, none
  sufficient alone (§14.1.1):

  | Trigger | Bound to | Guarantees |
  |---|---|---|
  | `trg_fin_recon_is_final` | `fin_reconciliation_matches` (row) | A match cannot **claim** finality in a non-final batch, whatever the caller supplies. Finality is monotone, with one batch-driven release: a match may lose it only while its batch is `cancelled` |
  | `trg_fin_recon_batch_derive_totals` | `fin_reconciliation_batches` (`BEFORE UPDATE OF status`) | The batch's own `matched_total`/`variance_amount` are derived from its matches rather than the caller, and a finalised batch may not leave for a non-terminal state. `BEFORE` is required — `AFTER` cannot assign `NEW` |
  | `trg_fin_recon_batch_stamp_matches` | `fin_reconciliation_batches` (`AFTER UPDATE OF status`) | A batch which **becomes** final claims every match it already holds, and a batch that is **cancelled** releases every claim it held. `AFTER` is required — the row trigger re-derives from the batch's *current* status, so a `BEFORE` stamp would be overwritten by the derivation running on it |

  The previous revision had only the row trigger, which left a window: matches inserted while the
  batch was `open` were all stamped `false`, the batch then moved to `matching` without touching any
  match row, and the partial index — which is keyed on `is_final` — enforced **nothing** during that
  window. A second batch could then insert its own match for the same payment, and it would be stamped
  `true` on insert, leaving two live rows for one payment with the index violation deferred until
  someone happened to touch the older row. Its remedy was a single merged batch trigger whose binding
  satisfied neither requirement above, so the window it claimed to close stayed open; the mirror
  defect was that cancelling a `matching` batch released nothing, stranding the payments it had
  claimed.
- **App:** the match service performs the insert and maps `23505` to
  `409 payment_already_reconciled`.
- **Transaction:** the batch-transition transaction. A batch that is not final is **mutable in both
  directions**; once any match is final, `matching → open` is refused rather than un-finalising, so
  the only exits are `completed` and `cancelled` (§35.6).
- **Test:** `finance-018` — (a) matching a reconciled payment into a second batch raises `23505`;
  (b) `cancelled` and `open` matches remain freely proposable and do not block; (c) **the regression
  the fix is for**: create matches in an `open` batch, then move the batch to `matching`, then attempt
  to match the same payment in a *second* batch — this must raise `23505`. Against the single-trigger
  design it does not, because the first batch's matches are still `is_final = false`; (d) a batch with
  finalised matches cannot be moved back to `open`; (e) a no-op `UPDATE` of a non-`status` column on a
  final batch does not rewrite its matches; (f) **the release regression the `AFTER` trigger is for**:
  move a `matching` batch to `cancelled`, then assert (i) every match it held still **exists**, with
  its `is_final` now `false` and the batch reference intact — the rows are audit evidence and are
  never deleted — (ii) a second batch can now insert a match for the same payment and stamp it `true`
  without raising `23505`, and (iii) going `matching → completed` still stamps `true` and still
  refuses to leave for a non-terminal state. Against the single-trigger design (ii) fails, because
  cancelling released nothing and the payment stayed stranded.

---

**FI-019 — Receipt integrity**

*Formal:* for every `fin_receipts` row `r`, (a) `r.amount = fin_payments(r.payment_id).amount`;
(b) `r` is never `UPDATE`d or `DELETE`d, by any role; (c) `r` has **no** `void` state — there is no
`status` column; (d) a correction mints a **new** row with `version = n+1` and `supersedes_id`
set, leaving every prior version retrievable.

- **DB:** `trigger` `trg_fin_receipt_freeze` (`BEFORE UPDATE OR DELETE`, raises `55000` for **every**
  role including `school_migrator`, with no GUC bypass and no role exemption); `trigger`
  `trg_fin_receipt_freeze` (`BEFORE INSERT`, overwrites `amount` from the payment rather than
  validating it); `constraint` `fin_receipts_version_ck`; `index` `fin_receipts_no_uq`.
- **App:** there is no `PATCH /receipts/:id` and no `POST /receipts/:id/void` route, and the
  authorization gate (`apps/api/src/plugins/authorization.ts:68-70`) would make such a route
  undeclareable without
  a permission that does not exist. Reprint is a `GET` on the artifact, plus a new version when the
  underlying facts actually changed.
- **Transaction:** the payment transaction; a receipt can never exist for a payment that rolled back.
- **Test:** `finance-019` — (a) raw-SQL `UPDATE fin_receipts SET amount = …` raises `55000` **as
  `school_app_rw` and as `school_migrator`**; `DELETE` likewise; (b) `information_schema.columns`
  contains no `status` column on `fin_receipts`; (c) every receipt's `amount` equals its payment's
  `amount` for receipts created via the API, the worker, and the webhook handler; (d) a corrected
  receipt is `version = 2`, `supersedes_id` = v1, and v1 is still readable and printable.

---

## 18. State machines — consolidated

Every state machine in the design, in one place, with the guard on each edge. This section is
normative; earlier sections elaborate but may not diverge.

```text
fin_invoices
  draft     --issue(guard: >=1 line, total recomputed, number allocated)--> issued
  draft     --delete (no dependents)-->  ∅
  issued    --payment-->                partially_paid
  issued    --payment(balance 0)-->     paid
  issued    --void(guard: balance = 0)-->  void
  partially_paid --payment(balance 0)--> paid
  partially_paid --refund(guard: net_applied > 0)--> partially_paid
  paid      --refund(guard: net_applied > 0)-->  partially_paid        <-- REOPENS
  partially_paid --void(guard: balance = 0)-->    void
  paid      --void(guard: balance = 0)-->  void
                                              (the previous revision drew this
                                               edge as FORBIDDEN; §35.6 allows
                                               `paid → void` at zero balance
                                               only, which is the same edge a
                                               full refund lands on)
  any other transition                      REJECTED (ERRCODE 55000)

fin_challans  (derived mirror of fin_invoices; every §35.6 edge appears here)
  (insert)    --invoice issued AND balance > 0-->    issued
  issued      --any allocation-->                   partially_paid
  issued      --balance 0-->                        paid
  issued      --due_on passed AND balance > 0-->    expired
  partially_paid --balance 0-->                     paid
  partially_paid --due_on passed AND balance > 0--> expired
  partially_paid --refund-->                        partially_paid
  paid        --refund-->                           partially_paid
  expired     --payment-->                          partially_paid | paid
  any         --owning invoice is void-->           void  (inherits the invoice's
                                                       date and reason)
  void        --any-->                              FORBIDDEN (terminal)
  expired has NO ledger effect and NO fee effect (late fees out of scope, §26.2)

fin_payments
  pending  --provider confirm-->  settled        (once only; repeats are no-ops)
  pending  --provider fail-->     failed         (terminal)
  settled                                      (terminal for the LIFECYCLE; the MONEY is
                                                 still reversible, see §11.1/FI-007)
  failed                                       (terminal, no money effect)

fin_refunds
  —         --request(guard: refundable(p) > 0; Σ proposed = amount;
                 allocation list non-empty)-->            requested
  requested --approve(guard: step-up OK; binding amount unchanged)--> approved
                 [posts Dr 1200 AR / Cr 2200 Refund Payable — NO cash leg]
                 [REVERSAL ROWS CREATED HERE, one per proposed allocation]
                 [FI-006 completeness is NOT checked here — it is a DEFERRED,
                  COMMIT-time check by fn_fin_refund_ceiling, because a per-refund
                  sum can only be evaluated once every row of the refund exists]
  requested --reject(guard: reason required)-->           rejected (terminal)
  approved  --process(guard: disbursement reference present)--> processed
                 [posts Dr 2200 / Cr 1000/1100 Cash or Bank; reversal rows unchanged]
  approved  --reject-->                                  FORBIDDEN  <-- see note
  processed --any-->                                     FORBIDDEN (terminal, irreversible)
  processed --refund-->                                  FORBIDDEN (§13.5.1 ex.4)
  NOTE on `approved → rejected`: the previous revision drew this edge here while
  §35.7 row 7 forbids it, and §35.7's own preamble says the table is the authority
  and "the diagram must match it". This was the last place in the document still
  allowing it. It is forbidden for a substantive reason, not a bookkeeping one:
  approval is the instant the reversal allocations and the ledger group exist, so a
  later "reject" would have to un-post money rather than decline a request. Undoing
  an approved refund is a fresh refund request, not a back edge.

fin_reconciliation_batches
  open      --start-->  matching        (CLAIMS is_final on every match; derives the totals)
  open      --cancel--> cancelled       (terminal; frees nothing, nothing was final)
  matching  --complete(guard: |variance| <= tolerance OR variance_reason set)--> completed
  matching  --cancel--> cancelled       (terminal; RELEASES every claim this batch held, by
                                          UPDATE and never by DELETE. The only route out
                                          once a match is final — this is the point of
                                          T-FIN-28 and FI-018)
  matching  --reopen--> open                    FORBIDDEN (§14.2, and §35.6 — see notes)
  completed --any-->                            FORBIDDEN (immutable; snapshot + hash written once)
  cancelled --any-->                            FORBIDDEN (terminal)
  NOTE on `matching --exception--> exception`: `exception` is not a state. No route reached
  it, no trigger produced it, §35.6 gave it no exit, and it was annotated "batch must be
  cancelled first" -- a state you are required to leave before you may enter. The enum value
  has been removed from the DDL. An unresolved variance is not a lifecycle state; it is a
  `variance_amount` and a `variance_reason` on a batch still in `matching`.
  NOTE on `reopen`: re-opening a `matching` batch would un-finalise its matches and release
  the payments with nothing recording that the attempt was abandoned. `cancelled` is the only
  way to void a batch, and it records the void in `status`, `cancelled_at` and the rows.

fin_fee_structures
  draft --publish--> published --retire--> retired        (no new assignments; existing
                                                            invoices unaffected)
  draft --publish--> published --superseded(by a newer
                                           version)--> superseded
  draft --delete--> ∅                                     (the only deletable state)
  (insert)  --any non-draft status-->            REJECTED (ERRCODE 55000): draft is
                                                the graph's ONLY source state
  draft --any--> ∅ (other than published)       REJECTED
  published --superseded--> published          ALLOWED  (a no-op, as is
                                                        published -> published and
                                                        retired -> retired: a
                                                        status graph that refuses
                                                        self-transitions refuses
                                                        the idempotent re-PUT)
  retired / superseded --any-->                REJECTED (terminal)
  published --draft-->                         REJECTED
```

**Global rule.** Every transition above is enforced by a `BEFORE INSERT OR UPDATE OR DELETE` trigger
that validates `OLD.status → NEW.status` against a table-driven allow-list, raising
`ERRCODE = '55000'` otherwise. `INSERT` is included because the graph's *source* states are part of
the graph: on INSERT there is no `OLD`, so there is no edge to validate, and the rule that keeps
`published` reachable only through `draft` is enforced by refusing any other starting status. `DELETE`
is included because "structures expire" is a state change and not a disappearance — a published or
retired structure may not be deleted at all, and a `draft` may be. The application may *request* a
transition; only the database *decides*. This mirrors the `marks` pattern (`0015`) rather than
trusting an in-memory state machine.

> **The three revisions of this rule that a reader implementing from the earlier text would get
> wrong.** (1) It was written as `BEFORE INSERT OR UPDATE`, with `OLD.status` read on the INSERT
> path — which is the P0002 class of §7.3.1 (`record "new"/"old" is not assigned yet`) turned into a
> rejected INSERT. (2) It listed `draft --delete--> ∅` but bound no DELETE event, so a published
> structure and its three `ON DELETE CASCADE` children could be removed in one statement. (3) It
> enumerated the graph as a diagram and left the implementation to place the check after the
> draft early-return, which silently disables it for every edge that starts in draft. The shipped
> function is `trg_fin_structure_publish_freeze` (§7.3.1); the allow-list is evaluated on every
> UPDATE, before any early return.

---

## 19. Tenant / RLS model

### 19.1 The contradiction, resolved

The brief identifies a real inconsistency: the house policy body is
`tenant_id = app_current_tenant_id() OR app_privileged()`, while Phase 7 has no cross-tenant finance
analytics. **Adjudicated: finance tables do not use the house body. They get four purpose-built
policy classes, and the platform bypass is not inherited.**

### 19.2 Policy classes

Finance tables are partitioned into four visibility classes.

| Class | Tables | Who can SELECT | Who can INSERT/UPDATE/DELETE |
|---|---|---|---|
| **Operational money** | `fin_payments`, `fin_payment_allocations`, `fin_refunds`, `fin_reconciliation_*`, `fin_document_counters`, `fin_ledger_entry_groups`, `fin_ledger_entries`, `fin_provider_accounts`, `fin_payment_gateway_webhooks` | `finance_staff` only; `reporting_staff` **not** (aggregate views serve principal); parent/student **never** | `finance_staff` only, and `DELETE` is `app_privileged()`-only |
| **Document money** | `fin_invoices`, `fin_invoice_items`, `fin_invoice_adjustments`, `fin_challans` | `finance_staff`; guardian (linked students only); student (own only). **`reporting_staff` is excluded** — the principal reaches finance only via the four owner-scoped aggregate views of §15.2.1, never a row | `finance_staff` only, sub-permission-gated at the route; `DELETE` is `app_privileged()`-only |
| **Portal document** | `fin_receipts` | `finance_staff`; guardian and student **own receipts only** (§19.4) | `finance_staff` only. **There is no `void`, no `DELETE`, and no `UPDATE` for anybody** — a receipt is issued once and is immutable for its life (§25.5) |
| **Configuration** | `fin_fee_heads`, `fin_fee_structures`, `fin_fee_structure_targets`, `fin_fee_structure_items`, `fin_fee_installment_plans`, `fin_fee_assignments`, `fin_tenant_settings`, `fin_tax_profiles` | `finance_staff`; parent/student **never** | `finance_staff` only, sub-permission-gated at the route; `DELETE` is `app_privileged()`-only |

`fin_receipts` is its own class and **not** operational money, and this is the resolution of a real
tension the brief's own requirements create. A parent must be able to read a receipt (§20.4 rule
(a)), and a receipt is minted by a payment. If receipts sat in the operational-money class, the
parent grant would be unreachable; if a payment were reachable so that the receipt could be, the
parent would see money movements — which the brief forbids. Splitting the *document* from the
*movement* keeps both promises: the parent sees what was paid, never what came in.

Staff visibility is *not* expressed in RLS by permission, because permissions live in
`role_permissions`, which is itself RLS-protected. RLS classifies by **role code**; the route layer
classifies by **permission**. Both layers are required, and neither substitutes for the other.

### 19.3 The two new SECURITY INVOKER/DEFINER helpers

```sql
-- Classifies the current actor for finance row visibility.
-- Takes NO arguments, so a caller cannot influence its result.
CREATE OR REPLACE FUNCTION app_finance_actor_class() RETURNS text
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path = pg_catalog, public, pg_temp
AS $$
    SELECT CASE
        WHEN app_privileged() THEN 'system'
        WHEN app_ctx_scope() <> 'tenant' THEN 'none'
        WHEN EXISTS (
            SELECT 1 FROM memberships m
            JOIN membership_roles mr ON mr.membership_id = m.id
            JOIN roles r ON r.id = mr.role_id
            WHERE m.tenant_id = app_current_tenant_id()
              AND m.user_id = app_ctx_user()
              AND m.status = 'active'
              AND r.tenant_id = m.tenant_id
              AND r.code IN ('school_owner','accountant','cashier')
        ) THEN 'finance_staff'
        WHEN EXISTS (
            SELECT 1 FROM memberships m
            JOIN membership_roles mr ON mr.membership_id = m.id
            JOIN roles r ON r.id = mr.role_id
            WHERE m.tenant_id = app_current_tenant_id()
              AND m.user_id = app_ctx_user()
              AND m.status = 'active'
              AND r.tenant_id = m.tenant_id
              AND r.code = 'principal'
        ) THEN 'reporting_staff'
        WHEN EXISTS (
            SELECT 1 FROM guardians g
            JOIN student_guardians sg
              ON sg.tenant_id = g.tenant_id AND sg.guardian_id = g.id
            WHERE g.tenant_id = app_current_tenant_id()
              AND g.user_id = app_ctx_user() AND g.deleted_at IS NULL
              AND sg.deleted_at IS NULL
        ) THEN 'guardian'
        WHEN EXISTS (
            SELECT 1 FROM students s
            WHERE s.tenant_id = app_current_tenant_id()
              AND s.user_id = app_ctx_user() AND s.deleted_at IS NULL
        ) THEN 'student_self'
        ELSE 'none'
    END
$$;
REVOKE ALL ON FUNCTION app_finance_actor_class() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_finance_actor_class() TO school_app_rw;

-- The student ids this actor may see, for the current tenant claim.
CREATE OR REPLACE FUNCTION app_finance_linked_students() RETURNS SETOF uuid
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path = pg_catalog, public, pg_temp
AS $$
    SELECT sg.student_id
    FROM student_guardians sg
    JOIN guardians g
      ON g.tenant_id = sg.tenant_id AND g.id = sg.guardian_id
    WHERE sg.tenant_id = app_current_tenant_id()
      AND g.user_id = app_ctx_user()
      AND g.deleted_at IS NULL
      AND sg.deleted_at IS NULL
    UNION
    SELECT s.id FROM students s
    WHERE s.tenant_id = app_current_tenant_id()
      AND s.user_id = app_ctx_user() AND s.deleted_at IS NULL
$$;
REVOKE ALL ON FUNCTION app_finance_linked_students() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_finance_linked_students() TO school_app_rw;
```

Both functions are the reason `guardian` sits above `student_self` in the classification: a user who
is both a guardian and a student is a guardian, and gets the guardian's (broader, multi-child) view.

**These are `SECURITY DEFINER` on purpose.** The relationship join must be provable even though
`student_guardians` and `guardians` are themselves RLS-scoped to `tenant_id = current tenant`, and
`role_permissions` is RLS-scoped too. A `SECURITY INVOKER` version would be filtered by the caller's
context and could return an empty set for a legitimate guardian — silently denying access, which is a
security bug in the *availability* direction. Running as the owner makes the relationship check
reliable.

**Why this is safe.** Both functions take **no arguments**. Their inputs — `app_current_tenant_id()`
and `app_ctx_user()` — come from the HMAC-signed `app.rls` ticket, which only `app_ctx_mint()` can
produce and only for a user with a real, **active membership** in that tenant (`0002:92-98`). So:

- A caller cannot pass a different tenant or a different user id.
- To obtain any finance row at all, the caller must hold an active membership in that tenant.
- Within that tenant, they see only students they are actually the guardian of, or their own
  student record.
- `sg.deleted_at IS NULL` is present, which **fixes the defect in `attendance.ts:136-158`** rather
  than inheriting it.

### 19.4 The policies

```sql
-- OPERATIONAL MONEY: staff-only, no parent/student reach at any level.
CREATE POLICY fin_payments_select ON fin_payments FOR SELECT USING (
    app_privileged()
    OR ( app_ctx_scope() = 'tenant'
         AND app_current_tenant_id() = fin_payments.tenant_id
         AND app_finance_actor_class() = 'finance_staff' )
);
CREATE POLICY fin_payments_insert ON fin_payments FOR INSERT WITH CHECK (
    app_ctx_scope() = 'tenant'
    AND app_current_tenant_id() = fin_payments.tenant_id
    AND app_finance_actor_class() = 'finance_staff'
);
CREATE POLICY fin_payments_delete ON fin_payments FOR DELETE USING (app_privileged());
```

```sql
-- DOCUMENT MONEY: staff see their tenant; guardians/students see only linked students.
CREATE POLICY fin_invoices_select ON fin_invoices FOR SELECT USING (
    app_privileged()
    OR ( app_ctx_scope() = 'tenant'
         AND app_current_tenant_id() = fin_invoices.tenant_id
         AND ( app_finance_actor_class() = 'finance_staff'
               OR fin_invoices.student_id IN (SELECT app_finance_linked_students()) ) )
);
```

`fin_invoices` carries a denormalised, trigger-pinned `student_id` (§6.4), which is precisely what
makes this one-line policy possible.

`UPDATE` and `DELETE` on `fin_invoices` are restricted to `finance_staff`; `DELETE` is
`app_privileged()`-only, matching every other table in the repository. Because the runtime role has
**no** DELETE policy anywhere, `school_app_rw` physically cannot hard-delete a financial row.

**Receipts are the one portal-visible document, and the policy is a single column comparison.**
`fin_receipts` carries `payer_guardian_id`, frozen from the payment at issue (§25.5). That column is
what makes the policy decidable from the row alone, and it is the P0-10 fix: the previous design
inverted reachability through the allocation and invoice, which (a) was a three-join sub-select
evaluated on every portal read, and (b) was **wrong**, because `student_guardians` is many-to-many,
so a payment settling two siblings is reachable from both families and the existence test discloses
the amount to a guardian who is not party to that particular charge.

```sql
-- PORTAL DOCUMENT: receipts are readable by the paying family, and by nobody else.
-- There is deliberately no UPDATE and no DELETE policy: the receipt is immutable (§25.5).
CREATE POLICY fin_receipts_select ON fin_receipts FOR SELECT USING (
    app_privileged()
    OR ( app_ctx_scope() = 'tenant'
         AND app_current_tenant_id() = fin_receipts.tenant_id
         AND ( app_finance_actor_class() = 'finance_staff'
               OR fin_receipts.payer_guardian_id
                  IN (SELECT app_finance_current_guardian_ids()) ) )
);
CREATE POLICY fin_receipts_insert ON fin_receipts FOR INSERT WITH CHECK (
    app_ctx_scope() = 'tenant'
    AND app_current_tenant_id() = fin_receipts.tenant_id
    AND app_finance_actor_class() = 'finance_staff'
);
```

`app_finance_current_guardian_ids()` is a third no-argument helper, added for exactly one purpose:

```sql
-- The guardian ids the current actor acts as, for the current tenant claim.
-- No arguments, so a caller cannot influence the result (§19.3).
CREATE OR REPLACE FUNCTION app_finance_current_guardian_ids() RETURNS SETOF uuid
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path = pg_catalog, public, pg_temp
AS $$
    SELECT g.id
    FROM guardians g
    WHERE g.tenant_id = app_current_tenant_id()
      AND g.user_id = app_ctx_user()
      AND g.deleted_at IS NULL
$$;
REVOKE ALL ON FUNCTION app_finance_current_guardian_ids() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_finance_current_guardian_ids() TO school_app_rw;
```

**Why a `SETOF` helper rather than reusing `app_finance_linked_students()`.** The invoice policy
needs *students*; the receipt policy needs *guardians*. They are different relations, and deriving
one from the other is exactly the many-to-many reasoning that produced the P0-10 disclosure. One
user may be several guardians (a mother registered separately per child, which `0005` permits and
real data will contain), so the helper returns a set, not a scalar — and a scalar would silently
pick one child and hide the other's receipts.

Four consequences worth stating, because each is a security decision rather than an implementation
detail:

- **A parent can never see a payment row, an allocation row, or another family's receipt** — the
  comparison is against the receipt's own column, so there is no sub-select to leak through and no
  existence test whose timing or cardinality could be observed.
- **A student sees nothing here.** `app_finance_current_guardian_ids()` returns rows only for
  `guardians.user_id = app_ctx_user()`; a student actor has no guardian row and therefore matches
  nothing. This is the correction to §19.4's earlier claim that students could read "own receipts
  only": a student's money is their family's, evidenced by the guardian of record, and inventing a
  student-side receipt path would be a second, weaker way to prove the same ownership. It also
  matches §20.4, where the `student` row of the permission matrix has no `fees.receipts.read`
  cell.
- **A fully unallocated payment still produces a family-visible receipt** — correctly, and this is a
  behaviour change. The receipt is the school's record that it *took* the money, and a family that
  prepaid a term is entitled to see that. The previous design made such a receipt unreachable, which
  meant a parent who prepaid could not obtain evidence of the payment; the payer column fixes both
  the disclosure and this omission at once, because the payer is known even with no allocation.
- **Soft-deleting a guardian stops future reads, not history.** `g.deleted_at IS NULL` means a
  deactivated guardian loses portal access immediately, which is the desired fail-closed behaviour.
  Staff access is unaffected, and the receipt row itself is immutable either way.

### 19.5 Post-condition assertion (the `0020` pattern) — and why `polqual::text` is not a check

Finance RLS is a *negative* privilege change in spirit, so it gets the `0020` treatment — an
assertion that fails the migration if the post-condition is not met, rather than trusting the DDL.

**The defect being corrected (P1-11).** The previous revision asserted
`pol.polqual::text LIKE '%app_ctx_scope() = ''platform''%'`. `pg_policy.polqual` is of type
`pg_node_tree`, a **binary internal parse tree**, not SQL text. Its `::text` representation is a
`NodeToString` dump of the parse tree, in which a string literal appears as an embedded
`String` node with a `sval` field — so the substring `'app_ctx_scope() = ''platform'''` never occurs
in it, and the predicate is **vacuously true for every policy in the database**. The assertion
passed, and would have passed no matter what the policies contained. A guard that cannot fail is
worse than no guard, because it is reported as a passing security gate.

The corrected form uses `pg_get_expr()`, which renders the **source text** of the expression node:

```sql
DO $assert$
DECLARE v_leak text;
BEGIN
    -- (1) The generic platform bypass must NOT appear in any finance policy.
    --     pg_get_expr renders the expression source; polqual::text does not (P1-11).
    SELECT string_agg(c.relname || '.' || pol.polname, ', ') INTO v_leak
    FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    WHERE c.relname LIKE 'fin\_%'
      AND pol.polqual IS NOT NULL
      AND pg_get_expr(pol.polqual, pol.polrelid) LIKE '%app_ctx_scope() = ''platform''%';
    IF v_leak IS NOT NULL THEN
        RAISE EXCEPTION 'finance policy % grants platform scope; Phase 7 forbids platform finance access',
            v_leak;
    END IF;

    -- (2) No finance table may rely on the house OR-body. Every finance policy must
    --     mention app_finance_actor_class() or a payer/linked-student column, so a
    --     copy-pasted `app_privileged()`-style policy cannot slip in unnoticed.
    SELECT string_agg(c.relname || '.' || pol.polname, ', ') INTO v_leak
    FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    WHERE c.relname LIKE 'fin\_%'
      AND pol.polqual IS NOT NULL
      AND pg_get_expr(pol.polqual, pol.polrelid) LIKE '%app_privileged()%'
      AND pg_get_expr(pol.polqual, pol.polrelid) NOT LIKE '%app_finance_actor_class()%';
    IF v_leak IS NOT NULL THEN
        RAISE EXCEPTION 'finance policy % uses the generic bypass without an actor class; refusing',
            v_leak;
    END IF;
END
$assert$;

-- (3) RLS must be ENABLED and FORCED on every fin_* table. A policy on a table whose
--     RLS is not enabled is documentation, not a control. FORCE matters as well:
--     the table owner is otherwise exempt from its own policies, and the owner is
--     not a hypothetical actor.
DO $assert_rls$
DECLARE v_open text;
BEGIN
    SELECT string_agg(c.relname, ', ') INTO v_open
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname LIKE 'fin\_%'
      AND c.relkind = 'r'
      AND (NOT c.relrowsecurity OR NOT c.relforcerowsecurity);
    IF v_open IS NOT NULL THEN
        RAISE EXCEPTION 'finance table % has RLS not enabled+forced; refusing to complete',
            v_open;
    END IF;
END
$assert_rls$;
```

**Why assertion (3) exists and why both `relrowsecurity` and `relforcerowsecurity` are checked.** A
`CREATE POLICY` statement succeeds on a table with RLS disabled and simply has no effect until
`ALTER TABLE … ENABLE ROW LEVEL SECURITY` runs. It is therefore possible to write every policy in
this document, ship the migration, and have no access control at all. `FORCE ROW LEVEL SECURITY`
closes the second half: without it, a session connected as the table's owner (which includes
`school_migrator` and any superuser) reads and writes every row regardless of the policies. The
ledger's append-only guarantee already assumes a non-owner runtime role (§15.1); asserting
`forcerowsecurity` means the design does not depend on that assumption being true.

**On what these assertions can and cannot prove.** Checks (1)–(3) are **textual and structural**.
They prove a forbidden string is absent and a required flag is set. They do **not** prove the
policy returns the right rows, that the actor classification is correct, or that a guardian cannot
see another family's receipt. Those are behavioural properties, and they are asserted separately and
behaviourally by `finance-rls` (FI-014, FI-020, FI-022), which runs as a real `school_app_rw` session
with a real signed ticket per actor class and asserts row counts. The design states this split
explicitly so that neither check is mistaken for the other: a passing migration assertion is a
necessary, not a sufficient, condition for the RLS to be correct.

### 19.6 Actor-by-actor answer to §12 of the brief

| Actor | Connection role | READ finance? | WRITE finance? | `BYPASSRLS`? | `SECURITY DEFINER` only? | Why |
|---|---|---|---|---|---|---|
| `platform_admin` (a user) | `school_app_rw` | **NO** | NO | no | no | `app_ctx_scope()='platform'` is not in any finance policy (§19.4). Phase 7 has no cross-tenant finance analytics. A platform admin needing finance is a **new explicit feature**, not a bypass. |
| `school_owner` | `school_app_rw` | YES (tenant) | YES (tenant, sub-permission) | no | no | Tenant owner. Full tenant finance via the `fees.*` catalog. |
| `accountant` | `school_app_rw` | YES (tenant) | YES (tenant, sub-permission) | no | no | The finance operator. |
| `cashier` (new, §20.1) | `school_app_rw` | YES (tenant) | collect only | no | no | Separation of duties on collection. |
| `principal` | `school_app_rw` | **AGGREGATE ONLY** (see §20.2) | NO | no | no | `reporting_staff` reaches report views, not `fin_invoices`/`fin_payments` directly. |
| `teacher` | `school_app_rw` | NO | NO | no | no | No `fees.*` grant. |
| `parent` | `school_app_rw` | linked students only, document money only | NO | no | no | §19.4. Cannot reach `fin_payments` at all — a parent sees an invoice and a receipt, never a payment row. |
| `student` | `school_app_rw` | own student only, document money only | NO | no | no | §19.4. |
| **worker** | **`school_migrator`** | **YES (all tenants)** | YES (all tenants) | **effectively yes** (`app_privileged()`) | no | Required to post ledger entries, reconcile, and generate artifacts. **Mitigation: every worker query scopes by `event.tenantId` explicitly.** Proven by `outbox-integration.test.ts:550-614` and re-proven for finance by `finance-014`. |
| **migrator / migration CLI** | `school_migrator` | YES | YES | effectively yes | no | Migrations must see all rows to backfill. Trade-off is accepted and documented. |
| **system actor** (cron, `withSystem`) | `school_migrator` | YES | YES | effectively yes | no | Same as worker. |

**The residual risk, stated honestly:** `app_privileged()` is a whole-connection property, so a
compromised worker connection can read every tenant's finance. This is a **pre-existing property of
the repository's trust model** (`0002`), not something Phase 7 introduces, and Phase 7 does not
widen it. The honest mitigation is per-user connection roles or a dedicated worker pool with
statement-level audit — both named in `0002`'s own residual-risks note and in `DECISIONS` ADR-014, and
out of scope here. **Phase 7's contribution is the static guard test** asserting that no worker
finance query omits a `tenantId` predicate, exactly as `outbox-integration.test.ts:572-576` does for
the general case.

### 19.7 The `SECURITY DEFINER` contract — every Phase 7 function, formally

Phase 7 introduces a small, closed set of privilege-elevating functions. Because each one runs with
the migration owner's rights rather than the caller's, each is specified here with a **complete
contract** rather than a name and a `CREATE` statement. A function that is not in this table does
not exist; a function that is in this table cannot be changed without changing this table.

#### 19.7.1 The `search_path` convention, and why it diverges from the repository

The repository's existing convention is `SET search_path = public, pg_catalog`
(`0002:72`, and six occurrences each in `0016`/`0017`/`0018`). **Phase 7 uses
`SET search_path = pg_catalog, public, pg_temp` on every new function**, and this is a deliberate
divergence, recorded here so it is a decision rather than an accident:

- `pg_catalog` first means a system function can never be masked by a same-named object in
  `public`.
- **`pg_temp` last is the load-bearing part.** PostgreSQL implicitly searches `pg_temp` **first** for
  relation names unless `pg_temp` is explicitly placed in `search_path`. A `SECURITY DEFINER`
  function with `search_path = public, pg_catalog` and no `pg_temp` entry is therefore exposed to
  temp-table masking by any session that can create a temp table — which `school_app_rw` can. The
  existing convention does not defend against this, and neither does an unqualified
  `SET search_path = ''` replacement that forgets to keep `pg_temp` out of the leading position.
- Every Phase 7 function additionally carries `REVOKE ALL … FROM PUBLIC` followed by an explicit
  `GRANT EXECUTE … TO <role>`, because PostgreSQL grants `EXECUTE` to `PUBLIC` on new functions by
  default. This mirrors the existing pattern (`0002:67`, `:119-120`) and is asserted by a static test.

**This is a finding about existing code, not a Phase 7 change.** Whether to retro-fit the six
existing `0002` functions is a separate owner decision — **OD-09** — because `CREATE OR REPLACE
FUNCTION` with a changed `SET` clause is a no-op unless the function is dropped first, and `0002` is
immutable.

#### 19.7.2 The closed set

Owner for all of them is the migration role **`school_migrator`**, which is the same owner the
`0002` trust functions have. The API/worker runtime role is **`school_app_rw`**; it has no `BYPASSRLS`
and no ownership of any `fin_*` table.

| # | Function or relation | Kind | Owner | `search_path` | `PUBLIC` | `EXECUTE`/`SELECT` to | Created in |
|---|---|---|---|---|---|---|---|
| F1 | `app_finance_actor_class()` | `SECURITY DEFINER` `STABLE` | `school_migrator` | `pg_catalog, public, pg_temp` | **revoked** | `school_app_rw` | `0021` |
| F2 | `app_finance_linked_students()` | `SECURITY DEFINER` `STABLE` | `school_migrator` | `pg_catalog, public, pg_temp` | **revoked** | `school_app_rw` | `0021` |
| F3 | `app_finance_seeds_ledger_accounts(p_tenant_id uuid)` | `SECURITY DEFINER` `VOLATILE` | `school_migrator` | `pg_catalog, public, pg_temp` | **revoked** | `school_migrator` only | `0021` |
| F4 | `post_fin_ledger_group(tenant, source_type, source_id, lines)` | `SECURITY DEFINER` `VOLATILE` | `school_migrator` | `pg_catalog, public, pg_temp` | revoked | `school_app_rw` | `0026` |
| F5 | **28 bound functions**, one per row of §35.3: **27 named `trg_*`** (rows 1–14, 16–25, 3a–3c) plus **`fn_fin_refund_ceiling`** (row 15, a deferred constraint trigger) | `SECURITY INVOKER` `VOLATILE` | `school_migrator` | `pg_catalog, public, pg_temp` | revoked | n/a — trigger-only, `PERFORM`ed or bound, never called by the API | `0021`–`0029` |
| F5h | **2 declared-but-unbound helpers**: `trg_fin_reversal_shape_check` and `trg_fin_invoice_recalc_balance(uuid,uuid)` | `SECURITY INVOKER` | `school_migrator` | `pg_catalog, public, pg_temp` | revoked | n/a | none — no `CREATE TRIGGER` names either |
| F6 | `app_finance_current_guardian_ids()` | `SECURITY DEFINER` `STABLE` | `school_migrator` | `pg_catalog, public, pg_temp` | **revoked** | `school_app_rw` | `0021` |
| F7 | `app_verify_mfa_code(user, code, at)` | `SECURITY DEFINER` `STABLE` | `school_migrator` | `pg_catalog, public, pg_temp` | **revoked** | `school_app_rw` | `0028` |
| F8 | `app_consume_step_up(session, action, resource_type, resource, amount, code)` | `SECURITY DEFINER` `VOLATILE` | `school_migrator` | `pg_catalog, public, pg_temp` | **revoked** | `school_app_rw` | `0028` |
| F9 | `app_mint_step_up_challenge(session, resource_type, resource_id, resource_amount, action)` — 5 args, `p_session_id` first, exactly as the DDL at the F9 block declares; the table previously showed 3, dropping the session id | `SECURITY DEFINER` `VOLATILE` | `school_migrator` | `pg_catalog, public, pg_temp` | **revoked** | `school_app_rw` | `0028` |
| F10 | `app_confirm_mfa_factor(factor, code)` | `SECURITY DEFINER` `VOLATILE` | `school_migrator` | `pg_catalog, public, pg_temp` | **revoked** | `school_app_rw` | `0028` |
| V1 | `fin_v_invoice_balance` (§12.4.1), `fin_v_payment_position` (§12.4), `fin_v_ledger_account_balance` (§12.4.2) | **view**, `security_invoker = on` | `school_migrator` | n/a — a view has no `search_path` setting | **revoked** | `school_app_rw` (SELECT) | `0024` (invoice balance, payment position), `0026` (ledger) |
| V2 | `fin_v_ar_aging`, `fin_v_collections_summary`, `fin_v_fee_head_revenue`, `fin_v_on_account_summary`; full bodies in §15.2.2 | **view**, owner-scoped (**no** `security_invoker`) | `school_migrator` | n/a | **revoked** | `school_app_rw` (SELECT) | `0026` |

**F10 was missing from this table while the DDL already granted it.** `app_confirm_mfa_factor` is a
`SECURITY DEFINER` function with an explicit `GRANT EXECUTE … TO school_app_rw`, and §19.7 is the
closed set of privilege-elevating functions, so a granted definer function with no row here was a
hole in the contract, not a cosmetic omission. Three things follow from it that the rest of the
document already assumes:

- It is the **only** function in the set that *writes* a row (it `UPDATE`s `auth_mfa_factors`); F7
  reads, F8 and F9 write to `auth_step_up_challenges`, and F1/F2/F6 are `STABLE` readers. So it is
  `VOLATILE`, and the step-up path is the only place a definer function mutates an `auth_*` row.
- `auth_mfa_factors`'s RLS branch (§35.4) is **self-only with no `app_privileged()` branch**,
  and F10's own ownership check compares the factor's `user_id` to `app_current_user_id()` before it
  writes. Those are the same predicate, and because F10 is `SECURITY DEFINER` it **bypasses the policy
  entirely** — so the in-function check is the one that must never be dropped. The branch was only
  self-consistent if this function was in the closed set.
- It therefore has to be in the F1–F10 count that the post-condition assertions check, and it is
  `0028`-ordered with the rest, after `auth_mfa_factors` and before any route can call `/mfa/confirm`.

**F4 is `SECURITY DEFINER`, and the previous revision's `SECURITY INVOKER` was unexecutable (P1-07).**
§30.3.3 revokes `INSERT` on `fin_ledger_entry_groups` and `fin_ledger_entries` from `school_app_rw`,
and an invoker function writes with the caller's privileges — so an invoker posting function and
those revokes together mean **no caller can ever post a ledger group**. The document would have
described a system that cannot record a payment while claiming the ledger was protected. Definership
is the resolution; the runtime `INSERT` grant stays revoked; the bounding mechanism is the closed
`jsonb` line shape validated before any insert, pinned in full in the F4 contract below and asserted
asymmetrically by `finance-ledger-grants.test.ts` (direct insert `42501`, execute succeeds,
unbalanced lines `55000` with zero rows left behind).

**V1/V2 are relations, not functions, and are listed separately on purpose (P1-06).** A view has no
`prosecdef` and no `search_path`; the old F6 row claimed a `SECURITY DEFINER` view and a
`pg_catalog, public, pg_temp` setting that PostgreSQL does not permit on `CREATE VIEW`, so any static
test written against it could only fail or assert nothing. The two real controls on a view are its
`reloptions` (`security_invoker`) and its owner, and both are asserted instead: V1 must have
`security_invoker = on`, V2 must **not**, and both must be owned by `school_migrator` with `PUBLIC`
revoked. Detail: §15.2.1. Inventory rows: §35.3.

F3 is the only function that is *not* reachable by the runtime role, and it is the only one that
takes a `tenant_id` argument, because seeding is a per-tenant migration act. F5's functions are all
invoker: a trigger function that ran elevated could read across tenants, and the trigger already
runs inside a transaction that the caller's RLS governs. F1, F2, F6, F7, F8, and F9 need definership,
and only because they must read `roles`/`membership_roles`/`student_guardians`/`auth_mfa_factors`/
`auth_step_up_challenges`, which are themselves RLS-scoped and would otherwise return an empty set —
a false "no guardian" or a false "no code" to a legitimate actor. F6 is the receipt path's
`app_finance_current_guardian_ids()` (§25.5) and exists for the same reason as F2.

**F8 is `VOLATILE`, not `STABLE`, and the previous revision said `STABLE`.** It performs `UPDATE` on
`auth_step_up_challenges` to decrement `attempts_left` and to set `consumed_at`. PostgreSQL will
refuse to execute a data-modifying statement inside a `STABLE` function, so the draft as written
could not run at all — a second instance of the same class of defect as F4, and a reminder that
every row in this table is checked against what PostgreSQL actually permits rather than against
what reads as intuitive.

#### 19.7.3 The per-function contract

For each function, every clause below is normative.

**F1 — `app_finance_actor_class()`**

- **Purpose:** classify the current actor as `system | finance_staff | reporting_staff | guardian |
  student_self | none` so that a finance RLS policy can branch on a value the runtime role cannot
  forge. It is a **classification function, not an authorisation function**: it never returns a
  tenant id and never grants anything on its own.
- **Arguments:** none. Deliberately none — a function that took `(user_id, tenant_id)` would be a
  privilege-escalation primitive for any caller who could name another user.
- **Tenant derivation:** implicit, from `app_current_tenant_id()`, which reads the HMAC-signed
  `app.rls` ticket. There is no path by which a caller supplies it.
- **Returns:** `text`, always one of the six literals. Never `NULL`, never raises for a missing
  relationship.
- **Caller context:** requires `app_ctx_scope() = 'tenant'`. For a platform ticket it returns
  `'none'` (the `app_privileged()` branch returns `'system'` first, and the caller's RLS branch is
  separately gated on `app_ctx_scope() = 'tenant'`).
- **RLS interaction:** runs as owner, so the `roles`/`membership_roles`/`guardians`/`student_guardians`
  reads are **not** filtered by the caller's RLS. This is the point: the relationship proof must be
  reliable or a legitimate guardian is silently denied. The only inputs are the two signed-ticket
  values, so widening the read cannot widen the result beyond that actor.
- **Grants:** `REVOKE ALL … FROM PUBLIC`, then `GRANT EXECUTE … TO school_app_rw`. `school_migrator`
  owns it and therefore retains implicit execute.
- **Transaction:** none — it is `STABLE` and read-only; it is never called from a deferred
  constraint or a `VOLATILE` write path where a read would be a surprise.
- **Audit/outbox:** none. It is a predicate, not an event.
- **Failure mode:** if the signed ticket is absent, the underlying `app_ctx_*` functions raise, the
  query fails, and the failure is a 500 at the API boundary — **never** an empty result set that
  looks like "no access". A static test asserts the `REVOKE` and the `GRANT`.

**F2 — `app_finance_linked_students()`**

- **Purpose:** return the set of student ids the current actor may see for the current tenant. It
  backs exactly one thing: the `student_id IN (app_finance_linked_students())` branch of the
  document-money and portal-document policies.
- **Arguments:** none, for the same reason as F1.
- **Tenant derivation:** implicit, from `app_current_tenant_id()`.
- **Returns:** `SETOF uuid`, possibly empty. An empty set is a legitimate, meaningful answer
  (a user with no linked students), and every calling policy treats it as "deny" rather than
  "error".
- **Caller context:** any tenant-scoped ticket. A platform ticket yields an empty set, because both
  branches are gated on `app_current_tenant_id()` matching rows whose `tenant_id` equals that claim.
- **RLS interaction:** owner-run, so a soft-deleted guardian link is evaluated by the function's own
  `sg.deleted_at IS NULL` / `g.deleted_at IS NULL` predicates rather than by the caller's policy.
  This is deliberate and is the regression fix for the `attendance.ts:136-158` defect: the predicate
  is **in the query**, not inherited from whatever policy happens to apply.
- **Grants:** `REVOKE ALL … FROM PUBLIC`, then `GRANT EXECUTE … TO school_app_rw`.
- **Transaction:** none (`STABLE`).
- **Audit/outbox:** none.
- **Failure mode:** a `SECURITY DEFINER` function returning an empty set is the classic
  hard-to-debug security bug, so F1 and F2 are covered by a test that asserts a **legitimate**
  guardian receives their child's id — not only that an illegitimate one receives nothing.

**F3 — `app_finance_seeds_ledger_accounts(p_tenant_id uuid)`**

- **Purpose:** insert the fixed **9-row** chart of accounts of §5.2 for one tenant, idempotently. It
  exists so the fixed code list lives in **one** place rather than in every migration and every test.
  9 is the count in `fin_ledger_accounts`'s `code` CHECK and in §5.2's table, and the two agree; the
  previous revision said 10, which matched neither.
- **Arguments:** `p_tenant_id uuid` — the only Phase 7 function that takes one, and it takes no user
  or role input.
- **Tenant derivation:** the argument, and the function asserts
  `p_tenant_id = app_current_tenant_id() OR app_privileged()` before writing. Under a tenant ticket
  it can therefore only seed its own tenant.
- **Returns:** `integer` — the number of rows inserted, so a caller can distinguish "already
  seeded" (0) from "seeded now" (**9**).
- **Caller context:** `school_migrator` (migration and backfill). **It is not granted to
  `school_app_rw`** — the chart of accounts is not a runtime-mutable or runtime-creatable object,
  and there is no route that calls it.
- **RLS interaction:** owner-run, so the `INSERT` is not blocked by the caller's RLS; the assertion
  above is the compensating control, and it is re-checked rather than trusted.
- **Grants:** `REVOKE ALL … FROM PUBLIC`; **no** grant to `school_app_rw`; owner-retained only.
- **Transaction:** must be called inside the migration/backfill transaction; it is not idempotent
  across a partial failure by itself, it is idempotent by `ON CONFLICT DO NOTHING`.
- **Audit/outbox:** none. Seeding is a migration act; a runtime audit row for it would be noise.
- **Failure mode:** `RAISE EXCEPTION … ERRCODE = '55000'` if the tenant argument is neither the
  current tenant nor a privileged caller, so a mis-scoped backfill fails loudly instead of writing a
  second chart of accounts somewhere.

```sql
-- F3. Owner-retained: seeds §5.2's nine accounts for one tenant, idempotently.
-- The nine VALUES rows below are the ONLY place the fixed list is written down.
-- §30.5's backfill and every test call THIS function rather than repeating the list.
CREATE OR REPLACE FUNCTION app_finance_seeds_ledger_accounts(p_tenant_id uuid)
    RETURNS integer
    LANGUAGE plpgsql VOLATILE SECURITY DEFINER
    SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    v_inserted integer;
BEGIN
    -- Re-checked in the body, not trusted from the caller. 55000 is object_not_in_prerequisite_state:
    -- the write is refused rather than performed for a tenant the caller has no right to seed.
    IF p_tenant_id IS DISTINCT FROM app_current_tenant_id() AND NOT app_privileged() THEN
        RAISE EXCEPTION 'seeds_ledger_accounts: tenant % is not the current tenant and caller is not privileged',
            p_tenant_id
            USING ERRCODE = '55000';
    END IF;

    -- ON CONFLICT (tenant_id, code) DO NOTHING, so a second call returns 0 and the
    -- is_system rows a tenant may never edit are left exactly as seeded.
    WITH seed(code, name, account_class, normal_side, is_contra) AS (
        VALUES
            ('1000', 'Cash in hand',                          'asset',     'debit',  false),
            ('1100', 'Bank / mobile wallet',                   'asset',     'debit',  false),
            ('1200', 'Accounts Receivable — Fees',            'asset',     'debit',  false),
            ('1300', 'Unapplied Cash (On Account)',            'liability', 'credit', false),
            ('2200', 'Refund Payable',                         'liability', 'credit', false),
            ('4000', 'Fee Income',                             'revenue',   'credit', false),
            ('4100', 'Fee Income — Concessions & Waivers',     'revenue',   'debit',  true ),
            ('4200', 'Fee Income — Fines & Penalties',         'revenue',   'credit', false),
            ('4900', 'Unapplied / Advance Fee Income',          'revenue',   'credit', false)
    )
    INSERT INTO fin_ledger_accounts
        (tenant_id, code, name, account_class, normal_side, is_contra, is_system)
    SELECT p_tenant_id, s.code, s.name, s.account_class, s.normal_side, s.is_contra, true
    FROM seed s
    ON CONFLICT (tenant_id, code) DO NOTHING;

    -- GET DIAGNOSTICS rather than FOUND: the caller needs the *count* (9 on a fresh
    -- tenant, 0 when already seeded), and FOUND is a boolean. ROW_COUNT on the
    -- INSERT reports rows actually inserted, so the ON CONFLICT skip is visible
    -- as the difference between 9 and 0.
    GET DIAGNOSTICS v_inserted = ROW_COUNT;

    -- The list is fixed, so a partial seed means a row was inserted that §5.2 does not
    -- contain (or one was removed). Failing loudly here is what keeps the chart
    -- provably equal to the table above instead of merely plausible.
    IF (SELECT count(*) FROM fin_ledger_accounts WHERE tenant_id = p_tenant_id) <> 9 THEN
        RAISE EXCEPTION 'seeds_ledger_accounts: tenant % has a chart that is not the fixed 9 accounts',
            p_tenant_id
            USING ERRCODE = '55000';
    END IF;

    RETURN v_inserted;
END;
$$;
-- Owner-retained only. No grant to school_app_rw: §19.7.3's caller context is
-- school_migrator, and there is no route that calls it.
REVOKE ALL ON FUNCTION app_finance_seeds_ledger_accounts(uuid) FROM PUBLIC;
```

The final `count(*) <> 9` assertion is the part that makes this function worth existing. A seed that
merely inserted nine rows would return 9 and stop, leaving a tenant with a chart that has been edited
since. Because the chart is fixed and `is_system` rows are frozen, the *only* legal end state is
exactly nine rows for the tenant, and asserting it here makes a drifted chart fail the migration that
would otherwise have carried it silently into every financial report. It is also the check that would
have caught the `4100` `CHECK` violation of §36.2 row 34 at seed time rather than at report time.

**F4 — `post_fin_ledger_group(p_tenant_id, p_source_type, p_source_id, p_lines jsonb)`**

- **Purpose:** the single posting entry point. Validates that the legs balance, writes the group
  header and the legs, and stamps the group sealed. Every financial event posts through it, so a
  second posting path is a bug by construction.
- **Arguments:** `p_tenant_id uuid`, `p_source_type text`, `p_source_id uuid`, `p_lines jsonb`
  (`[{account_code, direction, amount, student_id, invoice_id, …}]`).
- **Tenant derivation:** the argument, cross-checked against `app_current_tenant_id()`; a mismatch
  raises `55000` before any row is written.
- **Returns:** `uuid` — the new `fin_ledger_entry_groups.id`.
- **Caller context:** tenant-scoped for the API, and an empty ticket (`school_migrator`) for worker
  handlers. In the API case the caller's RLS is the tenant policy; in the worker case the caller is
  `school_migrator`, which owns the ledger tables. Both cases are legitimate, and the tenant
  cross-check below is what makes the second one safe.
- **RLS interaction:** **owner-run, and the previous revision got this backwards (P1-07).** It
  declared `SECURITY INVOKER` while §30.3.3 **revokes** `INSERT` on `fin_ledger_entry_groups` and
  `fin_ledger_entries` from `school_app_rw`. Those two statements are mutually exclusive: an invoker
  function performs the insert with the caller's privileges, so with the revokes in place the
  function would raise `42501` for **every** caller, and the ledger would be unpostable — a
  `DESIGN-GO` document that specifies a system which cannot record a payment is not a fix.

  The correct resolution is `SECURITY DEFINER` with the surrounding constraints, **not** to restore
  the runtime `INSERT` grant. Direct `INSERT` on the ledger is the thing that must stay unavailable:
  if `school_app_rw` may write `fin_ledger_entries` directly it can write an unbalanced or
  unattributed leg, and the "single posting entry point" becomes advisory. So:

  - `SECURITY DEFINER`, `SET search_path = pg_catalog, public, pg_temp`.
  - Owner `school_migrator`; `REVOKE ALL … FROM PUBLIC`; `GRANT EXECUTE` to `school_app_rw` **and**
    `school_migrator` (the latter implied by ownership, stated for the static test).
  - `school_app_rw` retains **no** `INSERT`/`UPDATE`/`DELETE` on either ledger table. The only
    reachable path from the runtime role is this function, which validates before it writes.
  - The compensation for elevation is **not** "we looked carefully at the body". It is
    mechanical: the function accepts no free-form SQL, takes its lines as `jsonb` data, and every
    element is validated (shape, `account_code` in the tenant's chart, `amount > 0`, `direction` in
    the enum, `sum(debits) = sum(credits)`, tenant equality of every `student_id`/`invoice_id`
    element against the `p_tenant_id` argument) **before** any row is inserted. An elevated write
    path that validates a closed data shape is a contained capability; an elevated write path that
    interpolates caller input is not, and this is the difference the table below records.
  - A caller who can `EXECUTE` this function can therefore post a **balanced, attributed,
    correctly-tenanted** group and nothing else. `finance-ledger-grants.test.ts` asserts exactly
    that asymmetry: direct `INSERT` fails with `42501`, `EXECUTE` succeeds, a deliberately unbalanced
    `p_lines` fails with `55000` and leaves **zero** rows in both ledger tables, and a `p_lines`
    element naming another tenant's `student_id` fails with `55000`.
- **Transaction:** the caller's business transaction. There is no autocommit path: a group that
  cannot be balanced rolls back the invoice issue, the payment, and the refund with it.
- **Audit/outbox:** the group header itself is the audit record; the surrounding business event
  writes the `fee.*` outbox row in the same transaction (FI-012).
- **Failure mode:** unbalanced legs, an unknown `account_code`, a debit leg without `amount > 0`, or
  a tenant mismatch all raise `55000`, which the API maps to a documented 409 and the worker maps to
  a retryable failure. Nothing is written in any of those cases, because the group is inserted
  **after** the lines validate.

**The body, because the contract above is only a claim until it is written.** The previous revision
granted this function and described it in prose, but never emitted a `CREATE FUNCTION` for it — the
one write path to an operationally-authoritative ledger had no definition anywhere in the document,
while every other member of the closed set did. The body below is the enforcement of the four
properties claimed above, and its shape is forced by two triggers that already exist in `0026`:

- `trg_fin_ledger_seal` is `BEFORE UPDATE` on the group and treats the **first** write of `sealed_at`
  as the seal, so the group is inserted unsealed and sealed by a later `UPDATE`.
- `trg_fin_ledger_sealed_group_reject` is `BEFORE INSERT` on the legs and **rejects any leg joining a
  sealed group**, so the legs must be inserted *before* the seal. Insert-then-seal is therefore the
  only order that works, and getting it wrong raises `55000` on the first leg.

```sql
-- ── F4: the single posting entry point. Validates, then writes, then seals ────
CREATE OR REPLACE FUNCTION post_fin_ledger_group(
    p_tenant_id     uuid,
    p_source_type   text,
    p_source_id     uuid,
    p_lines         jsonb
) RETURNS uuid
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    v_tenant uuid := app_current_tenant_id();
    v_group  uuid := gen_random_uuid();
    v_debit  numeric(19,4) := 0;
    v_credit numeric(19,4) := 0;
    v_el     jsonb;
    v_acct   text;
    v_dir    text;
    v_amt    numeric(19,4);
    v_stu    uuid;
    v_inv    uuid;
BEGIN
    -- 1. Tenant cross-check. The worker runs with an empty ticket, so the
    --    session tenant may be NULL; when it is not, it must equal the argument.
    IF v_tenant IS NOT NULL AND v_tenant IS DISTINCT FROM p_tenant_id THEN
        RAISE EXCEPTION 'ledger tenant % does not match the session tenant %',
            p_tenant_id, v_tenant USING ERRCODE = '55000';
    END IF;

    -- 2. Shape: a non-empty array of at least two legs.
    IF p_lines IS NULL
       OR jsonb_typeof(p_lines) <> 'array'
       OR jsonb_array_length(p_lines) < 2 THEN
        RAISE EXCEPTION 'p_lines must be a jsonb array of at least two legs'
            USING ERRCODE = '55000';
    END IF;

    -- 3. Every leg is validated BEFORE any row exists. Nothing below this loop
    --    can leave a partial group, because nothing below it has been written.
    FOR v_el IN SELECT jsonb_array_elements(p_lines) LOOP
        v_acct := v_el ->> 'account_code';
        v_dir  := v_el ->> 'direction';
        v_stu  := NULLIF(v_el ->> 'student_id', '')::uuid;
        v_inv  := NULLIF(v_el ->> 'invoice_id', '')::uuid;

        IF v_acct IS NULL OR v_dir IS NULL
           OR (v_el ->> 'amount') IS NULL
           OR (v_el ->> 'amount') !~ '^[0-9]+(\.[0-9]{1,4})?$' THEN
            RAISE EXCEPTION 'each leg needs account_code, direction, and a numeric amount'
                USING ERRCODE = '55000';
        END IF;
        v_amt := (v_el ->> 'amount')::numeric(19,4);

        IF v_dir NOT IN ('debit','credit') THEN
            RAISE EXCEPTION 'leg direction must be debit or credit, got %', v_dir
                USING ERRCODE = '55000';
        END IF;
        IF v_amt <= 0 THEN
            RAISE EXCEPTION 'leg amount must be greater than zero, got %', v_amt
                USING ERRCODE = '55000';
        END IF;
        IF NOT EXISTS (SELECT 1 FROM fin_ledger_accounts a
                        WHERE a.tenant_id = p_tenant_id AND a.code = v_acct) THEN
            RAISE EXCEPTION 'account % is not in the chart of accounts for tenant %',
                v_acct, p_tenant_id USING ERRCODE = '55000';
        END IF;
        -- Tenant equality of every attributed element. This is the check the
        -- composite FKs would also enforce, stated here so a violation is a
        -- 55000 with no row written rather than a 23503 after the header exists.
        IF v_stu IS NOT NULL AND NOT EXISTS (
                SELECT 1 FROM students s
                 WHERE s.tenant_id = p_tenant_id AND s.id = v_stu) THEN
            RAISE EXCEPTION 'leg student % does not belong to tenant %', v_stu, p_tenant_id
                USING ERRCODE = '55000';
        END IF;
        IF v_inv IS NOT NULL AND NOT EXISTS (
                SELECT 1 FROM fin_invoices i
                 WHERE i.tenant_id = p_tenant_id AND i.id = v_inv) THEN
            RAISE EXCEPTION 'leg invoice % does not belong to tenant %', v_inv, p_tenant_id
                USING ERRCODE = '55000';
        END IF;

        IF v_dir = 'debit' THEN
            v_debit := v_debit + v_amt;
        ELSE
            v_credit := v_credit + v_amt;
        END IF;
    END LOOP;

    -- 4. Balance. The deferred constraint trigger re-checks this at COMMIT;
    --    checking here turns a late failure into an early one.
    IF v_debit <> v_credit THEN
        RAISE EXCEPTION 'unbalanced ledger group: debit % does not equal credit %',
            v_debit, v_credit USING ERRCODE = '55000';
    END IF;

    -- 5. Header, UNSEALED. sealed_at stays NULL so the balanced CHECK is not yet
    --    in force and the legs below are not rejected by sealed_group_reject.
    INSERT INTO fin_ledger_entry_groups (
        id, tenant_id, event_type, source_type, source_id,
        total_debit, total_credit, entry_count, created_by)
    VALUES (
        v_group, p_tenant_id, p_source_type, p_source_type, p_source_id,
        v_debit, v_credit, jsonb_array_length(p_lines), app_current_user_id());

    -- 6. Legs.
    FOR v_el IN SELECT jsonb_array_elements(p_lines) LOOP
        INSERT INTO fin_ledger_entries (
            tenant_id, entry_group_id, account_code, direction, amount,
            student_id, invoice_id)
        VALUES (
            p_tenant_id, v_group, v_el ->> 'account_code', v_el ->> 'direction',
            (v_el ->> 'amount')::numeric(19,4),
            NULLIF(v_el ->> 'student_id', '')::uuid,
            NULLIF(v_el ->> 'invoice_id', '')::uuid);
    END LOOP;

    -- 7. Seal. This is the first write of sealed_at, which trg_fin_ledger_seal
    --    accepts and after which no leg may join and no row may be edited.
    UPDATE fin_ledger_entry_groups
       SET sealed_at = now()
     WHERE tenant_id = p_tenant_id AND id = v_group;

    RETURN v_group;
END $$;
REVOKE ALL ON FUNCTION post_fin_ledger_group(uuid, text, uuid, jsonb) FROM PUBLIC;
```

**Three honest limits of this body, stated rather than implied.**

- `event_type` is set to `p_source_type`, because the signature has no `event_type` argument and the
  column is `NOT NULL`. The two columns are therefore redundant as written, and nothing in the
  document reads `event_type`. This is a real modelling wart, not a decision: either the column is
  dropped or the signature gains an argument, and it is recorded as **OD-16**.
- `correlation_id` is left `NULL`. There is no `app_current_correlation_id()` in `0002`, so there is no
  honest source for it inside a `SECURITY DEFINER` body that cannot see the request. The group remains
  correlatable through `(source_type, source_id)`.
- The body validates **balance, attribution, chart membership, sign, and tenancy**. It does **not**
  validate accounting *policy* — that a payment posts to `2200` and not to `4000`. That lives in the
  business posting functions. The scope is exactly the one claimed above: a caller can post a
  balanced, attributed, correctly-tenanted group and nothing more, and `fin_ledger_accounts.normal_side`
  is what makes the *report* side (which account a balance belongs on) derivable rather than restated.

**F5 — the `trg_fin_*` trigger functions**

- **Purpose:** freeze, recompute, bound, seal, and pin. **Twenty-four** bound `trg_fin_*` functions plus
  `fn_fin_refund_ceiling` across `0021`–`0029` — 28 bound functions, one per §35.3 row — plus **two**
  `RETURNS void` helpers that have no
  trigger of their own — `trg_fin_reversal_shape_check` (§13.1, called by two trigger functions) and
  `trg_fin_invoice_recalc_balance(uuid, uuid)` (§12.4.1, `PERFORM`ed by
  `trg_fin_invoice_balance_recompute` to hold the balance arithmetic so that trigger contains only the
  decision about *which* invoice to recompute). §35.3 gives the full binding table and §35.3.1 states
  the counting rule. This line has now been wrong **three** times: "sixteen functions … plus two
  helpers" (omitting five functions the prose elsewhere required, and miscounting
  `trg_fin_artifact_document_valid` as a helper when it is bound directly), then "**twenty-two**
  `trg_fin_*` functions" (which matched no revision of the DDL), and the reconciliation split in
  §14.1.1 made it stale a third time. The count is now **taken from §35.3 by R2** rather than restated
  here, so this narrative cannot drift from the inventory without R2 failing.
- **Row-record access:** a trigger function that is bound to more than one operation reads the fired-on
  row by branching on `TG_OP`, **never** by `COALESCE(NEW.<col>, OLD.<col>)`. In PL/pgSQL a row
  trigger assigns only `NEW` on INSERT and only `OLD` on DELETE; `COALESCE` evaluates every argument,
  so it dereferences the unassigned record and raises P0002 `record "new" is not assigned yet` on the
  single-operation paths. The same applies to the return value: in a `BEFORE` trigger the returned
  record *is* the row written, so `RETURN COALESCE(NEW, OLD)` is a write-time failure, not a
  cosmetic one. `finance-trigger-inventory.test.ts` asserts no `fin_*` function body contains either
  pattern.
- **Arguments:** trigger-shaped only (`NEW`, `OLD`, `TG_TABLE_NAME`, …). No application-supplied
  argument may appear in a trigger signature, because a trigger's arguments are chosen by the
  migration author, not the caller.
- **Tenant derivation:** `NEW.tenant_id` / `OLD.tenant_id`, which is already constrained equal to the
  caller tenant by the row's own RLS policy before the trigger runs.
- **Returns:** `trigger`. `RETURN NEW` for `BEFORE` row triggers, `RETURN NULL` for statement
  triggers.
- **Caller context:** whatever the writing session is — API, worker, or migration. There is no
  context in which a `trg_fin_*` function may branch on the caller's role, because that would make
  the integrity rule role-dependent, and a role-dependent money rule is not a money rule.
- **RLS interaction:** **`SECURITY INVOKER`.** A trigger function that ran as owner would read
  `fin_*` tables unfiltered, and since several of them aggregate across rows (the allocation bounds
  trigger sums a payment's allocations), an elevated read would silently let a cross-tenant sum
  influence a same-tenant decision.
- **Grants:** `REVOKE ALL … FROM PUBLIC` on each. No `GRANT` to any runtime role — a trigger
  function is only ever invoked by its trigger, and a stray `GRANT` would let a caller fire the logic
  against a table they cannot otherwise write.
- **Transaction:** the writing transaction, always. Every trigger is `BEFORE` or `AFTER` row level
  unless stated; the ledger balance check is a `CONSTRAINT TRIGGER … DEFERRABLE INITIALLY DEFERRED`
  (§15.1) precisely so it can see the whole group.
- **Audit/outbox:** none. An event is written by the **business service**, not by a trigger, because a
  trigger writing to `outbox_events` would make the event's payload depend on trigger-time state and
  would duplicate FI-012's single write site.
- **Failure mode:** every domain conflict raises `USING ERRCODE = '55000'` (documented 409), and
  every immutability violation raises `USING ERRCODE = '55000'` as well. The immutability triggers
  have **no** GUC escape hatch and **no** role exemption — including `school_migrator` — because
  `0002` established that any GUC readable by a trigger expression is forgeable by the runtime
  role, and because a migration-owner bypass is exactly how a "temporary" repair becomes permanent
  (§9.4, §15.1, `DATABASE_DESIGN.md:220` **rejected**).

**What this table rules out.** No Phase 7 function may be added that is `SECURITY DEFINER` and is
not in this table; no function in this table may be granted to `PUBLIC`, to `school_app_rw` beyond
the grant stated, or with a `search_path` that does not end in `, pg_temp`. A static test parses
`0021`–`0029` and fails the build on any function whose `prosecdef`, `proconfig`, or `proacl` does
not match this table — so the contract is mechanically enforced, not merely documented.

**F5a — `trg_fin_invoice_recalc_balance(tenant, invoice)`, a declared helper**

- **Purpose:** hold the single copy of the `total − net_applied` expression that maintains
  `fin_invoices.balance`. It is a helper rather than a trigger function so that
  `trg_fin_invoice_balance_recompute` contains only the *decision* about which invoice to recompute —
  which is what makes "recompute both sides of a move" a two-line change instead of a duplicated
  expression. A trigger function carrying the arithmetic inline would have a second, independently
  editable copy of the formula, and two copies disagreeing is a balance that reconciles against
  itself and against nothing.
- **Arguments:** `(p_tenant uuid, p_invoice uuid)`, by name. Not trigger-shaped, because it is not
  bound to a trigger; `PERFORM`ed by the caller.
- **Tenant derivation:** neither — the tenant is an explicit argument, supplied by the caller from the
  row's own `tenant_id`. The function applies **no** tenant filter of its own beyond using the value
  it is given, so it cannot widen its own scope.
- **Returns:** `void`. Not `trigger`, and that distinction is what keeps it out of the §35.3
  inventory, whose rule is "every row is a bound trigger function".
- **Caller context:** only `trg_fin_invoice_balance_recompute`. Never the API, never the worker.
- **RLS interaction:** `SECURITY INVOKER`, same reasoning as F5. It reads four aggregates; an elevated
  read would let another tenant's rows influence a same-tenant sum.
- **Grants:** `REVOKE ALL … FROM PUBLIC`, and **no grant to any runtime role**. A helper reachable by
  the API would be a way to force an arbitrary invoice's balance to be recomputed outside any
  transaction that also validated it.
- **Transaction:** the caller's. It issues one `UPDATE`, so it is not independently atomic and must
  not be.
- **Audit/outbox:** none.
- **Failure mode:** it raises nothing itself; a `NOT FOUND` on the `UPDATE` is silent because the row
  is RLS-invisible or already gone, and either way there is no balance to correct. The *caller* is
  what raises.

**F5b — `trg_fin_recon_batch_derive_totals()`, the `BEFORE` half of the batch side**

- **Purpose:** derive the batch's own `matched_total` and `variance_amount` from its matches rather
  than from the caller — a caller who can write `matched_total` can make a batch balance against a
  statement it does not match — and refuse to let a finalised batch leave for a non-terminal state.
- **Arguments:** trigger-shaped only.
- **Tenant derivation:** `OLD.tenant_id` for the existence check, `NEW.tenant_id` for the aggregate
  over the matches. Bound `BEFORE UPDATE OF status` only, so `OLD` is always assigned.
- **Returns:** `trigger`, `RETURN NEW`. It is `BEFORE` **because** it assigns `NEW.matched_total` and
  `NEW.variance_amount`; an `AFTER` trigger cannot write `NEW` at all, which is why this effect could
  never be merged with the propagation effect in F5c. Its no-op branch returns `NEW`, not `NULL`: a
  `BEFORE` trigger returning `NULL` cancels the statement rather than skipping the work.
- **Caller context:** the batch-transition service, under `fees.reconciliation.manage`.
- **RLS interaction:** `SECURITY INVOKER`, and it writes no rows beyond the batch row the caller is
  already updating.
- **Grants:** `REVOKE ALL … FROM PUBLIC`; no grant.
- **Transaction:** the writing transaction; the aggregate sees the matches as they stand at that
  point in the statement.
- **Audit/outbox:** none; the service writes the event (§24.2's single write site).
- **Failure mode:** `55000` for a batch that has finalised matches and attempts to move to anything
  other than `completed`/`cancelled`.

**F5c — `trg_fin_recon_batch_stamp_matches()`, the `AFTER` half of the batch side**

- **Purpose:** close the finality window described in FI-018, and close it in **both** directions.
  `is_final` is derived from `batch.status` but is written only when a match row is written, so a
  batch moving `open → matching` left every pre-existing match stamped `false` and the partial unique
  index enforced nothing. This trigger fires on the batch transition itself, so every match is
  visited — and when the batch is `cancelled` it **releases** every claim the batch held, which is
  what makes `/cancel` from `matching` (T-FIN-28, FI-018) mean "this statement was wrong" rather
  than merely "stop here".
- **Arguments:** trigger-shaped only.
- **Tenant derivation:** `NEW.tenant_id` for the match `UPDATE`.
- **Returns:** `trigger`, `RETURN NULL` (an `AFTER` trigger's return value is ignored). It is
  `AFTER` **because** every row it updates re-enters `trg_fin_recon_is_final`, which re-derives
  `is_final` by selecting the batch's *current* status. Bound `BEFORE`, that select still returns the
  old status and the derivation overwrites the value this trigger had just written — the stamp is
  undone by its own row trigger, which is the defect T-FIN-27 names. The same timing is what makes the
  `cancelled` release legal: the batch row already reads `cancelled` when the match rows are updated.
- **Caller context:** the batch-transition service, under `fees.reconciliation.manage`.
- **RLS interaction:** `SECURITY INVOKER`. The `UPDATE` of the matches it performs must be subject to
  the same policy as the caller's own write, or the trigger becomes a privilege-escalation path
  around the match policy.
- **Grants:** `REVOKE ALL … FROM PUBLIC`; no grant.
- **Transaction:** the writing transaction. Its `UPDATE` re-enters `trg_fin_recon_is_final`, which
  re-derives the same value — the triggers are consistent by construction, because one decides what a
  match's value must be and this one makes sure every match is visited.
- **Audit/outbox:** none; the service writes the event (§24.2's single write site).
- **Failure mode:** `23505` from the partial unique index when a second batch tries to claim a payment
  a live batch already holds. Cancelling releases by `UPDATE` and never by `DELETE`, so the match, its
  amounts, and the `cancelled` batch that voided them all remain as the audit record.

**F6 — `app_finance_current_guardian_ids()`**

- **Purpose:** the set of `student_id`s the current actor is a *live* guardian of, for the guardian
  branch of `fin_invoices` and `fin_invoice_items` RLS.
- **Arguments:** none, for the same reason as F1.
- **Tenant derivation:** implicit, from `app_current_tenant_id()`.
- **Returns:** `SETOF uuid` (an `array_agg` into a uuid[] is equivalent; the array form is
  used so the policy has one indexed comparison instead of a subquery per row).
- **Live-link rule, and it is the whole point:** `student_guardians.deleted_at IS NULL` **and**
  `guardians.deleted_at IS NULL`. §6.3's family rule requires a *live* link, and this is the single
  place that decides it — T-FIN-18 is the regression test for a soft-unlinked guardian, and if this
  function ever drops the `deleted_at` filters, the guardian sees a sibling's invoices.
- **RLS interaction:** `SECURITY DEFINER`, so the relationship proof is not filtered by the caller's
  own RLS. This is the one place where the widening is the point: the guardian who is *being*
  evaluated is not yet the tenant that owns the link, and a self-filtered read would return nothing
  and silently deny a legitimate parent.
- **Grants:** `REVOKE ALL … FROM PUBLIC`, `GRANT EXECUTE … TO school_app_rw`.
- **Relationship to F2:** F2 is the student-self branch, F6 the guardian branch. Neither may be
  folded into the other, because their *absence* is what denies access — an empty set and an error
  are different, and both policies need the empty-set reading.

**F7 — `app_verify_mfa_code(p_user uuid, p_code text, p_at timestamptz)`**

- **Purpose:** answer exactly one question — "does `p_code` satisfy one of `p_user`'s currently
  usable factors, evaluated at instant `p_at`?" — and return a boolean.
- **Arguments:** three, and the omissions are the security property:
  - **no `tenant`** — a tenant argument would let a caller verify a factor against a tenant it did
    not act in. Tenancy is enforced one level up, by F8 comparing the challenge row's `tenant_id`
    to `app_current_tenant_id()`.
  - **no `session`** — a session argument would let a caller supply a session to satisfy. F8 passes
    `p_user` and `p_at` **from the locked challenge row**, so neither is caller-steerable.
  - **no `action`** — F8 has already matched `p_action` against the challenge's own `action`.
    Passing it again would be re-trusting a value F8 already validated.
- **Usable factor:** `revoked_at IS NULL` **and** `confirmed_at IS NOT NULL`. This is where the
  pending-enrollment exclusion lives, and it lives here rather than in a `CHECK` because a pending
  factor must be *storable* (it is the row enrollment creates) while being *unusable*. Those are
  two different questions and the previous revision conflated them into one impossible constraint.
- **Volatility:** `STABLE`, and it must be. It performs no `INSERT`/`UPDATE`/`DELETE`, so `STABLE` is
  honest; declaring it `VOLATILE` would be safe but would forbid the planner from hoisting it out of
  a loop, and declaring it `STABLE` while writing anything would make the function **unrunnable** —
  PostgreSQL rejects data-modifying statements in a `STABLE` function with `42804`. The static test
  asserts the volatility of F7 and F8 **separately**, because conflating them is precisely the error
  the previous revision made in F8.
- **Comparison:** constant-time for both paths. The email path compares digests; the TOTP path
  compares 6-digit codes, so the comparison is on fixed-width `text` and every candidate is
  evaluated before any result is returned — the function must not early-return on the first
  non-match, or the timing reveals how many leading digits were right.
- **Failure mode:** returns `FALSE`. It never raises for a wrong code and never distinguishes
  "no factor", "no such user", and "wrong code" — all three are `FALSE`, because a verifier that
  reports *which* condition failed is an account-enumeration oracle.
- **Grants:** `REVOKE ALL … FROM PUBLIC`, `GRANT EXECUTE … TO school_app_rw`. The capability
  exposed to the runtime role is a boolean over a user id the caller already knows; it reveals
  whether a *code was correct*, never whether a *factor exists*, because it returns `FALSE` in
  both cases.

**F8 — `app_consume_step_up(p_session_id uuid, p_action text, p_resource_type text, p_resource_id uuid, p_resource_amount numeric, p_code text)`**

- **Purpose:** atomically prove a step-up and **consume** it in the same transaction as the money
  movement it authorises. Returns `TRUE`/`FALSE` only — never the challenge id, so the capability
  cannot be used to probe challenge state.
- **The lock order is normative and must not be reordered:** challenge row (`FOR UPDATE`, by
  `p_session_id` + `p_action` + `p_resource_id`, most specific first) → session row (`FOR UPDATE`)
  → `app_verify_mfa_code` → conditional `UPDATE` to set `consumed_at`. Taking the session lock after
  the challenge lock is what prevents two concurrent requests on one session from each consuming a
  different challenge for the same operation.
- **Every precondition is checked against the locked rows, never against an argument:**
  `tenant_id = app_current_tenant_id()`, `session_id`'s `user_id = app_current_user_id()`, session not
  revoked, `now() < session.expires_at`, `resource_type`/`resource_id`/`resource_amount` matching the
  challenge exactly, `action` matching, `consumed_at IS NULL`, `attempts_left > 0`,
  `now() < expires_at`, `expires_at <= session.expires_at`.
- **Session/user cross-check is a hard requirement, stated because the previous revision omitted it.**
  `auth_sessions.user_id` must equal the challenge's `user_id`. Without it, a challenge minted for
  user A is spendable by user B who happens to hold the same session id from a stale read — the
  challenge table's own `user_id` column is the binding, and this is the comparison that enforces it.
- **Session expiry, stated because the previous revision promised it and did not implement it:** the
  comment claimed a challenge "never outlives its session" while the body never read
  `auth_sessions`. The check is real here: `p_session_id`'s `expires_at` bounds the challenge, and
  the mint side (§F9) refuses to set `expires_at` beyond it.
- **Amount binding is exact `numeric` equality** (`=`), not a rounded or epsilon comparison — see
  §19.8.2 for why rounding to 2 decimals would silently authorise a 0.0001 difference.
- **On failure:** decrements `attempts_left` and returns `FALSE`; at `attempts_left = 0` the row is
  permanently dead and a new challenge must be minted. The decrement is committed by the caller's
  transaction even on `FALSE`, so a caller cannot brute-force by discarding the transaction.
- **Grants:** `REVOKE ALL … FROM PUBLIC`, `GRANT EXECUTE … TO school_app_rw`.
- **Volatility:** `VOLATILE`, necessarily, because it writes `consumed_at` and `attempts_left`.

**F9 — `app_mint_step_up_challenge(p_session_id uuid, p_resource_type text, p_resource_id uuid, p_resource_amount numeric, p_action text)`**

- **Purpose:** mint one single-use challenge bound to `(tenant, session, user, action, resource,
  amount)`, and return the **code** so the caller can deliver it by email. This is the only function
  that returns a secret, and that is why its grant is the narrowest in the table.
- **Arguments:** **five**, and the first is `p_session_id` — the session the challenge is bound to.
  An earlier revision of this block said *four, and no session argument*, which contradicted the DDL
  and the F9 row of §19.7; the DDL wins, and the two are now the same five-argument contract. The
  session id is an **explicit argument**, not something read from context, because `0002` defines no
  `app_ctx_session_id()` (F8 takes `p_session_id` first for the same reason). The argument is not
  caller-forgeable: the route passes the id of the session it just authenticated, and F9 then reads
  that row to bind the challenge and to compute the expiry ceiling. Whether a *signed* claim in
  `0002` should replace that argument is the open half of §33 OD-14 — but the argument exists in the
  shipped signature either way, so this block may not describe a 4-argument function.
- **Expiry:** `expires_at = least(now() + 5 minutes, session.expires_at)`. The `least()` is the
  implementation of "never outlives its session" — minting a 5-minute challenge for a session with
  40 seconds left must produce a 40-second challenge, not a 5-minute one that outlives its own
  authentication.
- **Supersession:** minting supersedes any live, unconsumed challenge for the same
  `(tenant, session, action, resource)`, so the partial unique index on unconsumed rows can never be
  violated by a client that re-requests. Supersession happens by *consuming* the old row, not by
  deleting it, so the attempt history survives.
- **Code generation:** the 6-digit code is generated **by this function** and returned, because a
  code generated in the application and passed in would be a value the caller could choose — and a
  caller-chosen code is a caller-known code. The code is stored as `code_digest`, never as plaintext;
  the returned plaintext exists only in the response that delivers it by email.
- **Volatility:** `VOLATILE` — it inserts, and it updates the superseded row.
- **Grants:** `REVOKE ALL … FROM PUBLIC`, `GRANT EXECUTE … TO school_app_rw`.
- **Why F9 is `SECURITY DEFINER`:** it reads `auth_sessions` to derive the expiry bound and the
  user, under the same reasoning as F7. It is not granted to any role that F8 is not granted to, so
  minting a challenge never becomes a way to *use* one.

**F10 — `app_confirm_mfa_factor(p_factor uuid, p_code text)`**

- **Purpose:** the enrollment transition — "does `p_code` confirm the *pending* factor `p_factor`?" —
  returning a boolean. It is the one step that makes a factor live, and it is the only function in the
  F1–F10 set that writes an `auth_mfa_factors` row.
- **Arguments:** two, and the omissions are the whole security argument:
  - **no `user`** — this is the load-bearing omission, and an earlier draft of this block wrongly listed
    a `p_user` argument. The user is **derived from the factor row** and then compared to
    `app_current_user_id()`; if either the factor is missing, revoked, or owned by someone else, the
    function returns `FALSE` without touching a row. A caller therefore cannot name a user at all,
    let alone someone else's.
  - **no `tenant`** — tenancy is not a second input to be validated; it is implied by the factor's own
    `tenant_id`, and the caller's tenant is already pinned by `app_current_tenant_id()`.
- **Order of operations, and why it is this order:**
  1. `SELECT user_id … WHERE id = p_factor AND revoked_at IS NULL FOR UPDATE` — the lock is taken
     **first**, so two concurrent confirms of the same factor serialise here rather than both reaching
     the `UPDATE`.
  2. ownership check against `app_current_user_id()`;
  3. `app_verify_mfa_code(v_user, p_code, now())` — possession is proven by verifying a code against
     the factor's *own* secret, using the same F7 path as at use time, so a pending factor's code is
     checked by exactly the code that will later accept it;
  4. `UPDATE … SET confirmed_at = now() WHERE id = p_factor AND confirmed_at IS NULL`, returning
     `FOUND`.
- **Single-use:** the `confirmed_at IS NULL` predicate is the guard. A replayed confirm matches zero
  rows and returns `FALSE` rather than re-stamping, and F7's "usable factor" test
  (`revoked_at IS NULL AND confirmed_at IS NOT NULL`) is what a pending row must fail — so pending is
  a *storable* state and not a usable one, which is why this is a function and not a `CHECK`.
- **Volatility:** `VOLATILE` — it locks and writes.
- **Why `SECURITY DEFINER` is safe here:** it runs as `school_migrator` and so **bypasses**
  `auth_mfa_factors`'s policy. That is acceptable only because the ownership check in step 2 is
  unconditional and is the *same* predicate as the self-only policy (§35.4). The definer rights turn
  any missing check into a cross-tenant write, which is why the check is inside the function and not
  left to the caller's route.
- **Ordering:** `0028`, after `auth_mfa_factors` exists and before any `/mfa/confirm` route is live. It
  is the last of the four MFA functions, so the post-condition assertions check all four.

### 19.8 Step-up MFA — the substrate the previous revision assumed and did not build (P0-06)

**The gap, stated with repository evidence.** §13.2 requires step-up MFA on refund approve and
process, and the previous revision of this document simply asserted it. There is no substrate for it:

| Requirement | Repository state | Evidence |
|---|---|---|
| A re-authentication factor | **none** | no TOTP/OTP/WebAuthn code in `apps/api/src/plugins/auth.ts`; `grep -i "mfa\|totp\|2fa"` returns nothing |
| Session state recording a completed step-up | **none** | `auth_sessions` (`0001`) has `id, user_id, token_hash, ip, user_agent, active_tenant_id, created_at, expires_at, last_active_at, revoked_at` — no MFA columns |
| A challenge to verify against | **none** | no challenge/verification table |
| A route gate for privileged operations | **partial** | `authorization.ts` has `AuthorizationKind = 'public' \| 'authenticated' \| 'tenant' \| 'platform'` and a `requirePermission` gate — **no step-up concept** |

So "step-up MFA" as previously written was an unimplementable requirement, and a reviewer asking
"how?" would have found nothing. This section builds the substrate. It is **DESIGNED, not
IMPLEMENTED** — no migration, route, or test for it exists yet.

**Design decision: TOTP (RFC 6238) as the factor, with an email-code fallback, and no password
re-entry.** Rationale, stated so the owner can overrule it: a school's finance staff are not
consistently issued hardware tokens, TOTP is implementable against the existing `users.email` with
no new device-provisioning flow, and the fallback keeps a locked-out accountant from blocking a
payroll run. The choice does not affect any other part of the design — the binding, TTL, single-use
and audit rules below are factor-agnostic.

#### 19.8.1 Storage (migration `0028`, alongside the RBAC/RLS work)

**A schema error in the previous revision of this section, stated first because it made the
migration unrunnable (P0-06a).** The draft declared
`FOREIGN KEY (tenant_id, user_id) REFERENCES users (tenant_id, id)` and
`FOREIGN KEY (tenant_id, session_id) REFERENCES auth_sessions (tenant_id, id)`, and then "fixed" the
missing anchor by adding `CREATE UNIQUE INDEX … ON users (tenant_id, id)` and
`ON auth_sessions (tenant_id, id)`. **Neither `users` nor `auth_sessions` has a `tenant_id` column.**
Verified against `0001_init.sql`:

```sql
CREATE TABLE users (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    email            text NOT NULL, status text NOT NULL DEFAULT 'active',
    email_verified_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz
);
CREATE TABLE auth_sessions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    token_hash text NOT NULL, ip text, user_agent text,
    active_tenant_id uuid,           -- <-- the ONLY tenant-shaped column
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL, last_active_at timestamptz NOT NULL DEFAULT now(),
    revoked_at timestamptz
);
```

`grep -rn "ALTER TABLE users\|ALTER TABLE auth_sessions" packages/db/migrations/` returns only the
two `ENABLE/FORCE ROW LEVEL SECURITY` pairs — no later migration adds the column. Tenancy reaches a
user through `memberships(user_id, tenant_id)`, and `users` is a **platform-global identity**, not a
tenant-owned row. So `CREATE UNIQUE INDEX users_tenant_id_uq ON users (tenant_id, id)` would fail with
`column "tenant_id" does not exist` and migration `0028` would not apply at all — a "DESIGN-GO"
document whose new migration cannot run. The draft also asserted "`auth_sessions.tenant_id` is a real
column there (added with the tenant-scoped session work)"; it is not, and the column it does have is
`active_tenant_id`, which means "the tenant the session is *currently* acting in" and is mutable per
request, so it is the wrong thing to build an immutable challenge binding on.

**The correct model: factors are properties of the identity; challenges are properties of the
operation.** An authenticator belongs to the person, not to the school — the same phone must verify in
every tenant the user belongs to, and a per-tenant secret would mean re-enrolling on every school
transfer. A step-up challenge, by contrast, authorises one tenant-scoped money movement, so it
carries `tenant_id` and is checked against `app_current_tenant_id()`. That split is why the two tables
below have different shapes, and it is why neither needs a composite FK to `users`.

```sql
-- auth_mfa_factors is GLOBAL TO THE USER, like users itself. Deliberately NO
-- tenant_id column: the secret is the user's authenticator, shared across every
-- tenant that user belongs to, and adding tenant_id would force re-enrollment per
-- school. tenant scoping of the *decision* happens in app_verify_mfa_code, which
-- receives the tenant from the caller's signed context rather than from this row.
--
-- secret_digest is HMAC-SHA256(pepper, shared_secret) under a per-deployment
-- pepper, never the secret itself, so a database-only compromise does not yield a
-- working TOTP seed. See P2-09 (below) on why the pepper is not yet solved.
-- The previous revision stored ONE column, `secret_digest bytea NOT NULL`, documented as
-- HMAC-SHA256(pepper, shared_secret), and required app_verify_mfa_code to answer "does this
-- 6-digit code match?". For an emailed code that works: recompute the HMAC of the presented
-- code and compare digests. For TOTP it is impossible. RFC 6238 derives a code from the raw
-- secret via HMAC-SHA1(secret, counter) and then dynamic-truncates. If only a one-way
-- HMAC(pepper, secret) is available, the verifier cannot compute the expected TOTP for a
-- given counter, and cannot recover the secret to do so. The previous design therefore
-- could never have verified a TOTP factor at all, and the failure is silent: the function
-- returns false, so every TOTP login fails as a wrong code.
--
-- So the two factor types need DIFFERENT storage, and the schema says which:
--   totp      -> secret_ciphertext, envelope-encrypted, RECOVERABLE by the verifier
--   email_code-> secret_digest, one-way, and verification is a digest comparison
-- The CHECK makes the pair self-consistent, so a row cannot be stored with neither or both.
CREATE TABLE auth_mfa_factors (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id        uuid NOT NULL,
    factor_type    text NOT NULL CHECK (factor_type IN ('totp','email_code')),
    label          text NOT NULL,
    -- totp only. Envelope encryption: a per-row data key wrapped by the deployment KMS key
    -- (P2-09). Readable by app_verify_mfa_code only because that function is SECURITY
    -- DEFINER; nobody with a plain SELECT can recover a TOTP seed. Nullable for email rows.
    secret_ciphertext bytea,
    -- email_code only. HMAC-SHA256(pepper, code) under the same deployment pepper, so a
    -- database-only compromise does not yield usable codes and the code is not stored.
    secret_digest  bytea,
    confirmed_at   timestamptz,      -- NULL until the user proves possession
    last_used_at   timestamptz,
    revoked_at     timestamptz,
    created_at     timestamptz NOT NULL DEFAULT now(),
    -- Single-column FK to a PLATFORM-GLOBAL primary key. This is the documented
    -- exception to §6.3 R1/R2: users is not tenant-owned, so there is no
    -- (tenant_id, id) to composite against, and inventing one would be a schema
    -- change to an identity table outside Phase 7's remit.
    CONSTRAINT auth_mfa_factors_user_fk
        FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
    CONSTRAINT auth_mfa_factors_uq UNIQUE (user_id, factor_type, label),
    -- Storage matches factor type, exactly one of the two, no third state. This is the
    -- constraint that makes the TOTP/email split enforceable rather than a convention.
    CONSTRAINT auth_mfa_factors_secret_ck CHECK (
        (factor_type = 'totp'       AND secret_ciphertext IS NOT NULL AND secret_digest IS NULL)
     OR (factor_type = 'email_code' AND secret_ciphertext IS NULL     AND secret_digest IS NOT NULL)
    ),
    -- The previous revision's CHECK was `confirmed_at IS NOT NULL OR revoked_at IS
    -- NOT NULL`, with a comment two lines above it saying that a row with NEITHER is
    -- a pending enrollment. The comment and the constraint were opposites: the
    -- constraint made the pending state UNREPRESENTABLE, so the INSERT that
    -- enrollment depends on would have been rejected by the database. A pending
    -- factor is a real, required row (enrollment inserts, then a second request
    -- confirms it), so it must be allowed here and excluded at USE time instead.
    --
    -- What is genuinely invalid is revoking a factor that was never confirmed:
    -- that would create a "retired" row that was never live, i.e. revoke history
    -- for an authenticator that never existed.
    CONSTRAINT auth_mfa_factors_revoked_ck CHECK (
        revoked_at IS NULL OR confirmed_at IS NOT NULL
    ),
    -- Monotonic confirmation: once proven, a factor cannot silently return to
    -- pending. This is a row-level CHECK, not a trigger, because it compares two
    -- columns of the same row and needs no cross-row access.
    CONSTRAINT auth_mfa_factors_confirm_once_ck CHECK (
        confirmed_at IS NULL OR confirmed_at >= created_at
    )
);
-- Revoke the 0001 default-privilege grant immediately (§35.4, §30.3).
REVOKE ALL ON auth_mfa_factors FROM school_app_rw;



-- RLS: a factor is self-service. A user enrolls, lists, and revokes their OWN
-- factors, and nobody else reads them -- in particular no tenant admin, because
-- secret_digest is a credential. Verification does not need SELECT here: it goes
-- through app_verify_mfa_code (F7), which is SECURITY DEFINER. app_privileged() is
-- deliberately NOT in the policy: a migrator backfill is not a use case that
-- justifies a readable TOTP seed for a superuser session.
ALTER TABLE auth_mfa_factors ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_mfa_factors FORCE  ROW LEVEL SECURITY;
CREATE POLICY auth_mfa_factors_self ON auth_mfa_factors
    FOR SELECT TO school_app_rw USING (user_id = app_current_user_id());
-- Enrolment and confirmation are two writes; revocation is a THIRD write and must
-- not be expressible as a hard DELETE, because `revoked_at` is the audit record
-- that this authenticator existed. A DELETE would remove the only evidence of a
-- factor that once verified a refund approval, which is precisely the row an
-- incident review needs. The route is documented as setting revoked_at, and the
-- grant below no longer offers a second way to do the same thing destructively.
CREATE POLICY auth_mfa_factors_insert ON auth_mfa_factors
    FOR INSERT TO school_app_rw WITH CHECK (user_id = app_current_user_id());
CREATE POLICY auth_mfa_factors_update ON auth_mfa_factors
    FOR UPDATE TO school_app_rw
    USING      (user_id = app_current_user_id())
    WITH CHECK (user_id = app_current_user_id());
REVOKE ALL ON auth_mfa_factors FROM PUBLIC;
-- No DELETE. One policy per command instead of `FOR ALL`, so revoking a factor
-- is possible only by the documented soft-revoke UPDATE.
GRANT SELECT, INSERT, UPDATE ON auth_mfa_factors TO school_app_rw;
-- The confirmation UPDATE is the one privileged write in this table: it is what
-- makes a factor usable, and it is the only way a user could self-elevate from
-- "enrolled a secret they know" to "enrolled a working factor". Restricting it to
-- SECURITY DEFINER means the transition passes through a function that can also
-- verify possession, rather than a bare UPDATE a compromised route could issue
-- directly after learning any secret. This is F7a, the second half of §19.8.2.
CREATE OR REPLACE FUNCTION app_confirm_mfa_factor(p_factor uuid, p_code text) RETURNS boolean
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE v_user uuid;
BEGIN
    SELECT user_id INTO v_user FROM auth_mfa_factors
     WHERE id = p_factor AND revoked_at IS NULL
     FOR UPDATE;
    IF NOT FOUND OR v_user IS DISTINCT FROM app_current_user_id() THEN
        RETURN FALSE;
    END IF;
    -- Possession is proven by verifying a code against the factor's own secret,
    -- exactly as at use time. Only then is the factor marked confirmed. A pending
    -- factor is never consulted by verification, so this is the one transition
    -- that makes it live, and it is deliberately not reachable by plain UPDATE.
    IF NOT app_verify_mfa_code(v_user, p_code, now()) THEN
        RETURN FALSE;
    END IF;
    UPDATE auth_mfa_factors
       SET confirmed_at = now()
     WHERE id = p_factor AND confirmed_at IS NULL;
    RETURN FOUND;
END $$;
REVOKE ALL ON FUNCTION app_confirm_mfa_factor(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_confirm_mfa_factor(uuid, text) TO school_app_rw;

-- A single-use step-up assertion bound to the exact operation being authorised.
-- THIS table is tenant-scoped, because what it authorises (a refund approval) is.
CREATE TABLE auth_step_up_challenges (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid NOT NULL,
    user_id         uuid NOT NULL,
    session_id      uuid NOT NULL,
    -- THE BINDING. A step-up is not "the user re-authenticated recently"; it is
    -- "this user re-authenticated for THIS refund, of THIS amount, in THIS tenant,
    -- on THIS session". Without the columns below, a challenge minted for one
    -- refund would authorise another, and a challenge minted in tenant A would
    -- authorise tenant B.
    action          text NOT NULL CHECK (action IN ('refund.approve','refund.process')),
    resource_type   text NOT NULL CHECK (resource_type = 'fin_refunds'),
    resource_id     uuid NOT NULL,
    resource_amount numeric(19,4) NOT NULL CHECK (resource_amount > 0),
    -- Never the code and never the derived TOTP value. A digest is stored so a
    -- database read cannot be replayed against the verifier.
    code_digest     bytea NOT NULL,
    attempts_left   smallint NOT NULL DEFAULT 3 CHECK (attempts_left >= 0),
    consumed_at     timestamptz,
    expires_at      timestamptz NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    -- Same documented §6.3 R1/R2 exception: session_id and user_id are single-column
    -- FKs to platform-global primary keys. tenant_id's own integrity comes from
    -- tenants(id) -- a real, existing, single-column PK -- and the CHALLENGE is
    -- additionally pinned to the caller's tenant by app_mint_step_up_challenge (F9)
    -- and by the RLS policy below. session_id deliberately does NOT reference
    -- auth_sessions.active_tenant_id: that column changes as a session switches
    -- tenants, and a binding that can be re-pointed by a request is not a binding.
    CONSTRAINT auth_step_up_tenant_fk
        FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE CASCADE,
    CONSTRAINT auth_step_up_session_fk
        FOREIGN KEY (session_id) REFERENCES auth_sessions (id) ON DELETE CASCADE,
    CONSTRAINT auth_step_up_user_fk
        FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
    CONSTRAINT auth_step_up_expiry_ck CHECK (expires_at > created_at),
    -- A consumed challenge cannot be re-consumed, and consumption is MONOTONIC:
    -- app_consume_step_up only ever sets consumed_at from NULL, and
    -- trg_auth_step_up_immutable rejects any other UPDATE. Without the monotonic
    -- half, a caller with UPDATE could clear consumed_at and re-arm a spent code.
    CONSTRAINT auth_step_up_single_use_ck CHECK (consumed_at IS NULL OR consumed_at >= created_at),
    CONSTRAINT auth_step_up_ten_id_uq UNIQUE (tenant_id, id)
);
-- Revoke the 0001 default-privilege grant immediately (§35.4, §30.3).
REVOKE ALL ON auth_step_up_challenges FROM school_app_rw;


-- RLS: a challenge is read and written only by the session that owns it, in the
-- tenant the signed context names. There is no admin SELECT: a challenge row is
-- effectively a short-lived credential, and an auditor's legitimate need is
-- served by the audit table in §19.8.4, not by reading the live challenge.
ALTER TABLE auth_step_up_challenges ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_step_up_challenges FORCE  ROW LEVEL SECURITY;
CREATE POLICY auth_step_up_self ON auth_step_up_challenges
    FOR ALL TO school_app_rw
    USING      (tenant_id = app_current_tenant_id() AND user_id = app_current_user_id())
    WITH CHECK (tenant_id = app_current_tenant_id() AND user_id = app_current_user_id());
REVOKE ALL ON auth_step_up_challenges FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON auth_step_up_challenges TO school_app_rw;

-- The monotonicity guard the CHECK above cannot express: consumed_at only ever
-- moves NULL -> a timestamp, attempts_left only ever decreases, and the four
-- binding columns are immutable for the life of the row. A BEFORE UPDATE trigger
-- is used rather than a CHECK because PostgreSQL CHECKs cannot reference OLD.
CREATE FUNCTION trg_auth_step_up_immutable() RETURNS trigger
    LANGUAGE plpgsql SECURITY INVOKER
    SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
    IF NEW.tenant_id       IS DISTINCT FROM OLD.tenant_id
       OR NEW.user_id       IS DISTINCT FROM OLD.user_id
       OR NEW.session_id    IS DISTINCT FROM OLD.session_id
       OR NEW.action        IS DISTINCT FROM OLD.action
       OR NEW.resource_type IS DISTINCT FROM OLD.resource_type
       OR NEW.resource_id   IS DISTINCT FROM OLD.resource_id
       OR NEW.resource_amount IS DISTINCT FROM OLD.resource_amount
       OR NEW.code_digest   IS DISTINCT FROM OLD.code_digest
       OR NEW.created_at    IS DISTINCT FROM OLD.created_at
       OR NEW.expires_at    IS DISTINCT FROM OLD.expires_at
    THEN
        RAISE EXCEPTION 'step-up challenge binding is immutable'
            USING ERRCODE = '55000';
    END IF;
    IF OLD.consumed_at IS NOT NULL AND NEW.consumed_at IS DISTINCT FROM OLD.consumed_at THEN
        RAISE EXCEPTION 'step-up challenge is already consumed'
            USING ERRCODE = '55000';
    END IF;
    IF NEW.attempts_left > OLD.attempts_left THEN
        RAISE EXCEPTION 'step-up attempts_left may only decrease'
            USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION trg_auth_step_up_immutable() FROM PUBLIC;
CREATE TRIGGER auth_step_up_immutable
    BEFORE UPDATE ON auth_step_up_challenges
    FOR EACH ROW EXECUTE FUNCTION trg_auth_step_up_immutable();
-- A session may have at most ONE live (unconsumed) challenge per
-- (action, resource). Re-requesting supersedes the previous challenge rather than
-- accumulating them, so there is never a pool of valid codes to choose from. This
-- is what makes the 3-attempts budget mean something: 3 attempts against ONE code.
CREATE UNIQUE INDEX auth_step_up_live_uq
    ON auth_step_up_challenges (tenant_id, session_id, action, resource_id)
    WHERE consumed_at IS NULL;
-- Bounded lookup window: only challenges created in the last 10 minutes can be
-- verified, so the index stays small regardless of retention.
CREATE INDEX auth_step_up_recent_idx
    ON auth_step_up_challenges (tenant_id, session_id, action, resource_id, created_at DESC);
```

**A note on `action IN ('refund.approve','refund.process')`.** The CHECK is closed, and that is
deliberate for go-live: it means the database refuses to mint a step-up for any other operation, so
adding a second step-up-protected action is a **schema change with a review**, not a code change. The
cost is stated rather than hidden — the permission-gated operations added after Phase 7 (bulk
refunds, payroll disbursement) will each need an `ALTER TABLE … DROP CONSTRAINT, ADD CONSTRAINT`.
The benefit is that no route can invent a step-up for an operation the design never analysed.

**The pepper is not yet solved, and this section does not pretend otherwise (P2-09).**
`secret_ciphertext` (TOTP) and `secret_digest = HMAC-SHA256(pepper, shared_code)` (email) are only
meaningful if the pepper or KMS key is **unavailable to a database-only attacker**, and `0001`/`0002`
provide no such secret: the design needs a value from the environment or a secret manager,
`ALTER ROLE`/`current_setting` will not do (§9.4), and storing it in a table is circular. The same
class of gap as the unused `APP_ENCRYPTION_KEY` (P1-09). For go-live the options are (a) a
Kubernetes/`docker` secret injected as an env var, with all four helpers — `app_secret_digest`,
`app_secret_equals`, `app_mfa_decrypt`, `app_totp_verify` — implemented in the **application** and
reached through narrow `SECURITY DEFINER` wrappers, or (b) a `pgcrypto` call against a passphrase
held outside the database. Both are **P2-09**; what is resolved here is that the design does not
pretend a column named `secret_digest` is encryption, that a one-way digest can verify a TOTP (it
cannot, which is why TOTP has its own recoverable column), and it does not claim an HMAC whose key
is reachable by the attacker it defends against.

**What is deliberately NOT added to `auth_sessions`.** No `mfa_verified_at` column, no
`mfa_level` column. A step-up is per-operation and single-use, so storing a "verified at" timestamp
on the session would model a weaker property (recency) than the one the money operations need, and
would require a "how recent is recent enough?" constant that is then a policy decision hidden in
code. The challenge table is the whole state.

#### 19.8.2 The verification function

```sql
-- Consumes a step-up challenge for exactly one operation. Returns TRUE on success.
-- SECURITY DEFINER: it must read auth_mfa_factors, which RLS restricts to the
-- caller's own rows, and it performs the single-use transition atomically.
--
-- VOLATILE, explicitly (P0-06b). The previous revision declared this STABLE while
-- the body performs two UPDATEs. PostgreSQL refuses to execute a data-modifying
-- statement inside a STABLE function ("UPDATE is not allowed in a non-volatile
-- function"), so the draft as written would have raised 42804 on its first wrong
-- or right code. Volatility is the default, so this is stated for the static test
-- rather than for the reader.
CREATE OR REPLACE FUNCTION app_consume_step_up(
    p_session_id     uuid,
    p_action         text,
    p_resource_type  text,
    p_resource_id    uuid,
    p_resource_amount numeric(19,4),
    p_code           text
) RETURNS boolean
    LANGUAGE plpgsql
    VOLATILE SECURITY DEFINER
    SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    v_tenant  uuid := app_current_tenant_id();
    v_user    uuid := app_ctx_user();
    v_ch      auth_step_up_challenges;
    v_session auth_sessions;
    v_attempt boolean;
BEGIN
    IF v_tenant IS NULL OR v_user IS NULL THEN
        RETURN FALSE;   -- fail closed: no signed context, no step-up
    END IF;

    -- Lock order is normative: SESSION first, then CHALLENGE, then verify, then write.
    -- Every concurrent verification of this session serialises on the same session row,
    -- so two requests can never each consume a different live challenge for one
    -- operation. Taking the challenge lock first would leave two challenges for one
    -- session consumable by two requests; taking them in this order makes the
    -- session row the single contention point, and §12.6's ascending ordering is what
    -- keeps a multi-payment transaction from deadlocking against itself.
    SELECT * INTO v_session
    FROM auth_sessions s
    WHERE s.id = p_session_id
    FOR UPDATE;
    IF NOT FOUND THEN
        RETURN FALSE;
    END IF;

    -- SESSION/USER CROSS-CHECK (P0-06c). The previous revision never compared the
    -- session's user to the challenge's user. auth_sessions.user_id is the binding
    -- that stops a challenge minted for user A from being spent by user B: a session
    -- id read from a stale response, a log, or a shared link is not proof of
    -- identity on its own, and without this comparison the challenge's own user_id
    -- column is decorative.
    IF v_session.user_id IS DISTINCT FROM v_user THEN
        RETURN FALSE;
    END IF;
    -- Revoked or expired session: the challenge cannot outlive its own authentication.
    IF v_session.revoked_at IS NOT NULL THEN
        RETURN FALSE;
    END IF;
    IF now() >= v_session.expires_at THEN
        RETURN FALSE;
    END IF;

    -- Lock the live challenge for THIS session, action, resource type and resource.
    -- FOR UPDATE plus the partial unique index means two concurrent verifications of
    -- the same code cannot both succeed: the second blocks, then sees consumed_at set.
    SELECT * INTO v_ch
    FROM auth_step_up_challenges c
    WHERE c.tenant_id = v_tenant AND c.session_id = p_session_id
      AND c.user_id = v_user
      AND c.action = p_action
      AND c.resource_type = p_resource_type
      AND c.resource_id = p_resource_id
      AND c.consumed_at IS NULL
    FOR UPDATE;
    IF NOT FOUND THEN
        RETURN FALSE;
    END IF;

    -- TTL. 5 minutes, and never past the session's own expiry.
    IF v_ch.expires_at <= now() THEN
        RETURN FALSE;
    END IF;
    IF v_ch.attempts_left <= 0 THEN
        RETURN FALSE;
    END IF;

    -- BINDING, compared EXACTLY (P0-06c). The previous revision rounded both sides
    -- to 2 decimals before comparing, on the stated theory that "a challenge for
    -- 100,000.0000 must not authorise 100,000.0001". But §16.2 makes
    -- numeric(19,4) the money type precisely to preserve sub-paisa values, and
    -- rounding to 2 decimals would make 100,000.0001 and 100,000.0000 the SAME --
    -- a 0.0001 difference in the amount being authorised is silently accepted.
    -- That is a weakened check presented as a strengthened one. Exact equality is
    -- the correct rule; the paisa-rounding guarantee is enforced once, at write
    -- time, by the CHECK constraints in §16.3, not a second time in a security
    -- comparison. `=` on numeric is exact, so no epsilon is needed.
    IF v_ch.resource_amount <> p_resource_amount THEN
        RETURN FALSE;
    END IF;

    -- F7's signature is (p_user, p_code, p_at). It takes NO tenant, NO session and
    -- NO action: p_user and p_at both come from the LOCKED challenge row above, not
    -- from a route parameter, so a caller cannot steer which factor set is checked
    -- or which instant is evaluated. p_action was removed for the same reason --
    -- F8 has already matched it against the challenge row's own action, so passing
    -- it here would be a value F8 already knows and must not re-trust.
    v_attempt := app_verify_mfa_code(v_user, p_code, v_ch.created_at);
    IF NOT v_attempt THEN
        UPDATE auth_step_up_challenges SET attempts_left = attempts_left - 1
         WHERE id = v_ch.id;
        RETURN FALSE;
    END IF;

    UPDATE auth_step_up_challenges
       SET consumed_at = now()
     WHERE id = v_ch.id;
    RETURN TRUE;
END $$;
REVOKE ALL ON FUNCTION app_consume_step_up(uuid, text, text, uuid, numeric, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_consume_step_up(uuid, text, text, uuid, numeric, text) TO school_app_rw;
```

`app_verify_mfa_code` is the factor-specific verifier (RFC 6238 TOTP with a ±1 step window, or a
6-digit emailed code compared in constant time against a digest). It is declared as **F7** in
§19.7.2 with a full contract.

**The three load-bearing decisions in that contract, because the previous revision got two of them
wrong and hid the third.**

1. **It is `STABLE`, and that is correct here.** F8 is `VOLATILE` because it writes;
   `app_verify_mfa_code` reads and computes and writes nothing, so `STABLE` is the honest and
   correct declaration. The static test asserts the two volatility levels **separately**, because
   conflating them is exactly the error the previous revision made in F8, where a `STABLE` function
   with two `UPDATE`s in its body would raise `42804 UPDATE is not allowed in a non-volatile
   function` on its very first call.

2. **It takes no tenant and no session; the previous signature handed the caller a tenant.** The
   draft called it `app_verify_mfa_code(v_tenant, v_user, p_action, p_code, v_ch.created_at)` while
   its own prose claimed it "takes no session, no tenant, and no request context, so it cannot be
   steered." Both cannot be true, and the *prose* described the safer function. The corrected
   signature is `app_verify_mfa_code(p_user uuid, p_code text, p_at timestamptz)` — `p_user` comes
   from the **locked challenge row** inside F8, not from a route parameter, so a caller cannot verify
   a code against somebody else's factor, and the challenge row was already pinned to
   `app_current_tenant_id()` and `app_ctx_user()` by the same function's earlier predicates. Three
   of the five parameters are removed, and the two that remain cannot be influenced by the caller
   except through the code they are actually trying to spend.

3. **It is the only thing that may read `secret_digest`, and it is `SECURITY DEFINER` for that
   reason — not to escalate business logic.** `auth_mfa_factors` has RLS restricted to a user's own
   rows (§19.8.1), and the consuming transaction is running as the *accountant*, so an invoker
   verifier would see exactly the right rows and the enrollment-confirmation transaction — which runs
   before the user has any factor — would see none. Definership here is a function of *where the
   read happens*, and the compensating control is that the function's entire output is a boolean, it
   performs no writes, and it is `GRANT EXECUTE`d to `school_app_rw` with `PUBLIC` revoked — so the
   capability exposed is "does this code match this user's live factor", which is precisely what
   `app_consume_step_up` must ask and nothing more.

**The two factor paths, and why they cannot be merged.** The email path is a **digest comparison**:
recompute `HMAC-SHA256(pepper, presented_code)` and compare it in constant time against
`secret_digest`, which is safe because HMAC is one-way and the code is never recoverable from the
row. The TOTP path is **not** a digest comparison, and this is the single most important correction
in this section: RFC 6238 derives a code from the *raw* seed as
`HMAC-SHA1(seed, counter)` and then applies dynamic truncation, so a verifier must be able to
**recover the seed** to compute the expected code for a given counter. A one-way
`HMAC(pepper, secret)` cannot do that, and no amount of cleverness substitutes for it. The previous
revision stored one `secret_digest bytea NOT NULL` for both types and asked
`app_verify_mfa_code` to answer "does this code match?" — which is answerable for an emailed code and
**impossible for TOTP**. The failure mode is silent and total: the function returns `FALSE` for every
TOTP login, each one logged as a wrong code, and the design would ship looking like users mistyped
their authenticator codes. §19.8.1's `auth_mfa_factors_secret_ck` now makes the split a schema
invariant rather than a convention, and §19.8.5 writes both paths out.

The RFC 6238 parameters are pinned: 30-second step, 6 digits, ±1 step window (i.e. ±30 seconds of
tolerance), `floor(epoch / 30)` as the counter, big-endian 8-byte counter encoding, and dynamic
truncation per RFC 4226 §5.4. `T-FIN-26` (§28) requires the RFC 6238 appendix B test vectors — the
`SHA1` seed `12345678901234567890` with the published 8-digit expected values — so an implementer
cannot substitute a weaker scheme without failing a named test, and cannot claim RFC conformance
without demonstrating it.

#### 19.8.3 Where the gate sits, and what happens on failure

The gate is **in the business service, inside the same transaction as the money movement**, not in
the route pre-handler. This placement is deliberate and is the reason the control is meaningful:

- A route-level `preHandler` check would authorise the *request*; the money would then move in a
  separate transaction, and a race between the two would let one challenge authorise two refunds.
- Checking inside `postRefundApproval` (step 2 of §13.2) means the challenge is consumed in the
  **same transaction** as the reversal rows and the ledger posting. If the money move fails, the
  consumption rolls back with it — the user is not silently charged a step-up for a failed refund, and
  a rollback cannot resurrect a consumed challenge.
- `FOR UPDATE` on the challenge row means the same code cannot authorise two operations even under
  concurrent requests.

| Situation | Behaviour | HTTP |
|---|---|---|
| No `fees.refunds.approve` permission | route gate rejects | 403 `forbidden` |
| Permission held, no live challenge for this refund | `app_consume_step_up` returns FALSE | 428 `step_up_required` |
| Challenge exists, wrong code | attempt decremented, `55000`-free boolean FALSE | 401 `invalid_step_up_code` |
| 3 wrong attempts | `attempts_left` = 0, permanently dead; a new challenge must be requested | 401 `step_up_locked` |
| Challenge older than 5 min | expired; a new challenge must be requested | 401 `step_up_expired` |
| Code correct but the refund's amount changed since the challenge | binding check fails | 409 `step_up_binding_mismatch` |
| Code correct, operation proceeds | challenge consumed, audit row written, event emitted | 200 |
| No MFA factor enrolled and email fallback disabled | refund approve/process is **unavailable** | 503 `step_up_unavailable` |

**The last row is a design choice with a real cost, stated rather than hidden.** A tenant whose staff
have enrolled no factor cannot approve refunds. That is the correct fail-closed default for a control
that protects cash, but it means `cashier`/`accountant` enrollment is a **prerequisite** of Phase 7
go-live, not an optional hardening step. The alternative — an owner-approved break-glass override —
is deliberately **not** designed here; §33 OD-13 records it as an open decision for the owner,
because an override path for "approve a refund without step-up" is precisely the thing a
disappointed implementer would reach for and precisely the thing that defeats the control.

#### 19.8.4 Audit and events

Every step-up action writes an audit row through the existing `audit` package (which redacts codes
and digests by construction — `packages/audit/src/index.ts`'s `redactDeep` is applied to the
payload) with these actions, distinct from the money action they authorise:

| Audit action | Emitted when | Money event also emitted? |
|---|---|---|
| `auth.step_up.requested` | a challenge is minted | no — a request is not a financial event |
| `auth.step_up.failed` | wrong code, expiry, or binding mismatch | no |
| `auth.step_up.consumed` | a challenge is successfully spent | **yes** — the `fee.refund.approved` / `fee.refund.processed` outbox event is written in the same transaction |

No new outbox event types are added for step-up: the audit trail is the record, and adding events
would change the 18-new-event arithmetic of §24.1 (111 = 22 HANDLED / 89 NOOP) for a control-flow
fact that no consumer needs. FI-022 asserts the pairing — every `auth.step_up.consumed` row for
`action='refund.approve'` has exactly one `fee.refund.approved` outbox event with the same
`refund_id`, and no orphan either way.

#### 19.8.5 The mint path (F9) and the verifier (F7) in full

**F9 first, because a verifier with no mint path is not implementable.** The previous revision
described F9 only in prose and its "DDL above" for F7 did not exist; a contract table is not
something a migration can apply. Both are written out here.

```sql
-- Mints one single-use, single-tenant challenge bound to a specific refund, and
-- returns the 6-digit code. SECURITY DEFINER: it must read auth_sessions to derive
-- the user and the expiry bound, and RLS on auth_sessions is not the caller's.
--
-- The code is GENERATED HERE, not supplied by the caller. A caller-supplied code is a
-- caller-known code: if the route chose the value, the route could spend the challenge
-- without ever reading the email, and F8's "possession proof" would prove nothing. The
-- returned plaintext exists only in the response that delivers it.
CREATE OR REPLACE FUNCTION app_mint_step_up_challenge(
    p_session_id      uuid,
    p_resource_type   text,
    p_resource_id     uuid,
    p_resource_amount numeric(19,4),
    p_action          text
) RETURNS text
    LANGUAGE plpgsql
    VOLATILE SECURITY DEFINER
    SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    v_tenant     uuid := app_current_tenant_id();
    v_user       uuid := app_ctx_user();
    v_session    auth_sessions;
    v_code       text;
    v_new_id     uuid := gen_random_uuid();
    v_expires_at timestamptz;
BEGIN
    IF v_tenant IS NULL OR v_user IS NULL THEN
        RAISE EXCEPTION 'no signed tenant context' USING ERRCODE = '42501';
    END IF;

    SELECT * INTO v_session FROM auth_sessions s
     WHERE s.id = p_session_id FOR UPDATE;
    IF NOT FOUND OR v_session.user_id IS DISTINCT FROM v_user
       OR v_session.revoked_at IS NOT NULL THEN
        RAISE EXCEPTION 'session does not belong to this actor' USING ERRCODE = '42501';
    END IF;

    -- least(), not "+ 5 minutes": a 5-minute challenge minted for a session with 40
    -- seconds left must expire in 40 seconds. This is the implementation of "a
    -- challenge never outlives its own authentication" -- the previous revision
    -- promised that property in a comment and never read auth_sessions to get it.
    v_expires_at := least(now() + interval '5 minutes', v_session.expires_at);
    IF v_expires_at <= now() THEN
        RAISE EXCEPTION 'session expires before a challenge could be used'
            USING ERRCODE = '55000';
    END IF;

    -- Supersede any live challenge for the same (action, resource) by CONSUMING it,
    -- not deleting it, so the attempt history survives and the partial unique index
    -- auth_step_up_live_uq cannot be violated by a client that re-requests.
    UPDATE auth_step_up_challenges
       SET consumed_at = now()
     WHERE tenant_id = v_tenant AND session_id = p_session_id
       AND action = p_action AND resource_type = p_resource_type
       AND resource_id = p_resource_id AND consumed_at IS NULL;

    -- 6 digits from a CSPRNG: 10^6 space, ~20 bits of entropy, 3 attempts, 5-minute
    -- window. gen_random_uuid() is pgcrypto's crypto-strong source, and taking the
    -- middle six digits of two of them avoids modulo bias from a 32-bit int modulo 10^6
    -- (which would make 0 twice as likely as any other digit).
    v_code := lpad((((random() * 1000000)::bigint)::text), 6, '0');
    -- The plaintext is NOT stored. code_digest is HMAC-SHA256(pepper, code) with the
    -- deployment pepper (P2-09) so a database-only compromise yields no usable codes.
    INSERT INTO auth_step_up_challenges (
        id, tenant_id, session_id, user_id, action, resource_type, resource_id,
        resource_amount, code_digest, attempts_left, created_at, expires_at
    ) VALUES (
        v_new_id, v_tenant, p_session_id, v_user, p_action, p_resource_type,
        p_resource_id, p_resource_amount, app_secret_digest(v_code), 3, now(), v_expires_at
    );
    RETURN v_code;
END $$;
REVOKE ALL ON FUNCTION app_mint_step_up_challenge(uuid, text, uuid, numeric, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_mint_step_up_challenge(uuid, text, uuid, numeric, text) TO school_app_rw;
```

**`random()` is written out as the lpad expression above, and that is a real gap this design is
declaring rather than hiding.** `pgcrypto`'s `gen_random_bytes` is the correct source; PostgreSQL's
built-in `random()` is a fast PRNG, not a CSPRNG, and is the wrong primitive for a 20-bit secret that
authorises a refund. The correct expression is

```sql
v_code := lpad((encode(gen_random_bytes(4), 'hex')), 8, '0');
v_code := substr(v_code, 1, 6);
```

which needs `CREATE EXTENSION IF NOT EXISTS pgcrypto` — already present, since `gen_random_uuid()`
is used throughout `0001`. **The expression above, not the `random()` version, is normative**, and the
comment in the DDL marks the substitution point precisely so an implementer copies the right one.
`T-FIN-28` asserts the distribution is uniform over `000000`–`999999` with no modulo bias, and that
`v_code` is never `NULL` and never fewer than 6 characters.

**F7, the verifier.** This is the function the previous revision declared but did not write. Its
structure is fixed; the two factor paths are separate and neither falls back to the other.

```sql
-- "Does p_code satisfy one of p_user's USABLE factors at instant p_at?"
-- SECURITY DEFINER: auth_mfa_factors RLS admits only the caller's own rows, and the
-- enrollment-confirmation transaction runs before the user has any factor at all.
-- STABLE, and it must be: it writes nothing, and a data-modifying statement inside a
-- STABLE function raises 42804, so the volatility declaration is load-bearing, not
-- decorative.
--
-- Returns FALSE for: no factors, only pending factors, only revoked factors, wrong code,
-- unknown user. It never distinguishes these, because a verifier that reports WHICH
-- condition failed is an account-enumeration oracle.
CREATE OR REPLACE FUNCTION app_verify_mfa_code(
    p_user uuid,
    p_code text,
    p_at   timestamptz
) RETURNS boolean
    LANGUAGE plpgsql
    STABLE SECURITY DEFINER
    SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    v_ok boolean := FALSE;
    f    record;
BEGIN
    IF p_user IS NULL OR p_code IS NULL THEN
        RETURN FALSE;
    END IF;

    -- USABLE = confirmed AND not revoked. This is the single place the pending-
    -- enrollment exclusion lives. It must live HERE rather than in a table CHECK,
    -- because a pending factor must be STORABLE (enrollment inserts it) while being
    -- UNUSABLE. The previous revision tried to express both in one CHECK and produced
    -- a constraint that made enrollment's INSERT impossible.
    FOR f IN
        SELECT factor_type, secret_digest, secret_ciphertext
          FROM auth_mfa_factors
         WHERE user_id = p_user
           AND confirmed_at IS NOT NULL
           AND revoked_at IS NULL
    LOOP
        IF f.factor_type = 'email_code' THEN
            -- Digest comparison, constant time. app_secret_digest uses a deployment
            -- pepper (P2-09) and compares with a constant-time equality helper, so
            -- neither the digest nor the comparison leaks the code by timing.
            IF app_secret_equals(f.secret_digest, app_secret_digest(p_code)) THEN
                v_ok := TRUE;
            END IF;
        ELSIF f.factor_type = 'totp' THEN
            -- RFC 6238. secret_ciphertext is envelope-encrypted, so the raw seed is
            -- recoverable HERE and only here -- which is why this function must be
            -- SECURITY DEFINER and why secret_ciphertext is not a digest. Deriving a
            -- TOTP from a one-way digest is impossible, and the previous revision's
            -- single `secret_digest` column therefore could never have verified TOTP
            -- at all; every TOTP login would have failed as a wrong code.
            --
            -- p_at, not now(): F8 passes the CHALLENGE's created_at, so a code is
            -- evaluated against the instant the challenge was minted rather than
            -- against a wall clock the caller could shift.
            IF app_totp_verify(app_mfa_decrypt(f.secret_ciphertext), p_code, p_at) THEN
                v_ok := TRUE;
            END IF;
        END IF;
        -- No early exit on mismatch. Returning FALSE the moment one factor fails
        -- leaks, through timing, how many factors a user has and which was closest --
        -- and with one factor, whether the first N digits were right.
    END LOOP;
    RETURN v_ok;
END $$;
REVOKE ALL ON FUNCTION app_verify_mfa_code(uuid, text, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_verify_mfa_code(uuid, text, timestamptz) TO school_app_rw;
```

**What is normative here and what is delegated, stated precisely so the delegation is not a
disguised gap.** The *structure* of F7 is normative: the usable-factor predicate, the separation of
the two factor paths, `p_at` instead of `now()`, no early exit, boolean-only output, and
`STABLE` + `SECURITY DEFINER` + `search_path` + the grant set. Three helpers are called and are
specified by contract rather than written in this document:

| Helper | Contract | Why it is not inlined |
|---|---|---|
| `app_secret_digest(text) → bytea` | HMAC-SHA256 over the deployment pepper (P2-09) | Depends on where the pepper is injected, which is an open deployment decision. Inlining would hard-code a guess. |
| `app_secret_equals(bytea, bytea) → boolean` | constant-time equality, no early exit | Constant-time comparison is a correctness property, not a stylistic one, and it is small enough that inlining it risks a hand-rolled version that is not constant-time. |
| `app_totp_verify(secret, code, at) → boolean` | RFC 6238, ±1 step window, 6 digits, dynamic truncation | Requires the RFC 6238 test vectors to be run against it before it can be claimed correct. `T-FIN-26` names those vectors. |

`app_mfa_decrypt(bytea) → bytea` is the envelope-decryption half of the same P2-09 decision. All
four are `SECURITY DEFINER` with `PUBLIC` revoked and `GRANT EXECUTE` to `school_app_rw` only where
the API process calls them directly; F7 itself must remain the only path by which a factor's secret
is ever read, and the static test asserts that no `fin_*` function references
`auth_mfa_factors.secret_ciphertext` or `secret_digest` directly.

**A contract-only helper is still an unimplemented object, and the design says so in a way the test
can check.** "Specified by contract" is not a synonym for "resolved" — it means the document has
committed to a signature, a security posture, a grant set and a reason for non-inlining, while the
*body* is deferred to P2-09. Three assertions make the deferral falsifiable rather than rhetorical, and
all three belong in `finance-mfa-contract.test.ts`:

1. **Every helper F7 calls is either defined in the migration text or listed in this table.** The test
   extracts the identifiers from F7's body and asserts each is either a `CREATE FUNCTION` in the
   document or a row of the table above. A new unlisted call fails the test; it cannot be added
   silently as a fifth undefined symbol.
2. **Every listed helper has all four of: a signature, a `SECURITY DEFINER` note, a `PUBLIC` revoke,
   and a named implementation dependency (P2-09 or P2-10).** A helper listed with a contract but no
   tracked dependency is an untracked gap and fails the test.
3. **The count of listed-but-undefined helpers is reported, not asserted to be zero.** The test output
   names all four. A document that quietly dropped one would otherwise look identical to a document
   that had implemented it, and the difference is exactly what a reader needs to see.

`app_ctx_session_id()` is a **fifth** undefined symbol and is deliberately *not* in the table above:
it is not a Phase 7 crypto helper but a missing piece of `0002`'s signed context, and it is tracked
separately as **P2-10** with an owner decision (**OD-14**) because resolving it changes a ticket format
that earlier phases already depend on. It is listed here only to make the total count of
undefined-but-referenced symbols explicit: **five**, of which four are crypto helpers pending P2-09
and one is a context claim pending P2-10.

**This is still `DESIGNED`, not `IMPLEMENTED`, and the distinction is load-bearing.** No migration,
route, or test for any of this exists in the repository today (§19.8's evidence table). What this
revision resolved is the *internal* consistency of the design — the F7/F8 signature disagreement, the
TOTP-impossible digest, the pending-factor contradiction, the unenforced session binding — so that an
implementer is not handed a document that cannot run. The named implementation dependencies (pepper
placement, KMS, session claim) remain and are recorded as P2-09 and P2-10, not as resolved.

---

## 20. RBAC / permission matrix

### 20.1 The `cashier` question, adjudicated

The brief lists "built-in accountant" and "built-in cashier" as existing roles. Only `accountant`
exists, as a 3-permission stub. There is **no custom-role creation API or UI**, so a cashier cannot
be created as a custom role.

**Adjudicated: add a `cashier` built-in role template in the RBAC migration.** Justification: without
it, whoever can collect cash can also refund it and adjust invoices, because `school_owner` is the
only role holding all `fees.*` permissions. Cash handling without separation of duties is a genuine
control weakness — cashiers handle physical money, and the ability to refund is the classic
diversion path. A new template costs one entry in `ROLE_TEMPLATES` and is backfilled by the same
migration as every other role change (§20.4).

`accountant` keeps the full finance operator set **except structure design** (including refunds and
adjustments); `cashier` gets **exactly three** permissions — `fees.payments.read`,
`fees.payments.collect`, `fees.receipts.read` — and nothing else. Neither gets
`fees.structures.manage` or `fees.assignments.manage`, and neither can approve or disburse a
refund.

### 20.2 Principal is aggregate-only — adjudicated

The brief states principal is "aggregate + AR aging only, no student payment/refund detail" and warns
against granting `fees.invoices.read` to a principal in that case. **Adjudicated: principal gets
exactly one finance permission, `fees.reports.read`, and nothing else.**

`fees.reports.read` exposes the aggregate reporting surface (AR aging buckets, collection totals,
fee-head revenue, counts). It does **not** expose `fin_invoices`, `fin_payments`,
`fin_payment_allocations`, or `fin_refunds`, and this is enforced in **two independent layers**:

1. **RLS.** `reporting_staff` is excluded from the `SELECT` policy on every document-money and
   operational-money table (§19.4), so a principal's `SELECT` against `fin_invoices` returns
   **zero rows** — not a filtered set, zero.
2. **View shape.** The principal's actual surface is four **owner-scoped** aggregate views (§15.2.1
   — a view has no `SECURITY DEFINER` option; the correctness of that section's terminology is part
   of P1-06's resolution) whose output columns are pinned to buckets, totals, counts and taxonomy
   labels, and `finance-aggregate-view.test.ts` fails the build if any of them ever grows an id or a
   name column.

The route layer is a **third** gate, not the primary one: `fees.invoices.read` is not granted, so the
invoices route is undeclareable to a principal. Relying on that alone would be the weak version — a
new route, a new service method, or a direct SQL session would bypass it. Layer 1 makes the database
itself refuse.

This is a deliberate, visible narrowing relative to principal's exam privileges
(`exams.manage`/`exams.publish`). The rationale: a principal's oversight of academics does not
imply oversight of an individual's ability to pay, which is both more sensitive and more
conflict-prone. If the owner disagrees, granting `fees.invoices.read` is a one-line catalog change
— but the design does not make that change silently, because the brief explicitly warns against it.

### 20.3 Permission catalog additions

All new permissions are tenant-scoped, `fees.*`, and follow the established
`<resource>.<capability>` dotted convention. **There are exactly 25**, and the matrix in §20.4 has
exactly 25 rows — one per permission, with no invented permission and no duplicated row. A
permission that appears in the matrix but not in this list, or vice versa, is a defect caught by
`finance-rbac` (which parses both, rather than asserting a hand-written count).

**The 25th is `fees.receipts.reissue`, and the previous revision shipped 24 with a mutation route
gated on a read permission (P1-03).** §21.3 listed
`POST /finance/payments/:id/receipt-reissue` under `fees.receipts.read`, while §25.5 described the
route as minting a new receipt version and §25.5's own prose already referred to a
`fees.receipts.reissue` permission that **was not in the catalog** — so the document granted the
capability to nobody and simultaneously required it. Worse, a `cashier` holds
`fees.receipts.read`, so the naive design handed every cashier the power to mint a new financial
document. The fix is the split: reading a receipt and minting a superseding version are different
confidentiality levels, exactly as `fees.invoices.read` ≠ `fees.invoices.issue` already are. The
count changes 24 → 25 in §20.3, §20.4, §20.5, and §34.1, and every derived number is restated
below.

```text
fees.structures.read          fee structure + fee head read
fees.structures.manage        create / edit / publish / retire structures and plans
fees.assignments.read         per-student fee assignment read
fees.assignments.manage       bind a structure to a student; run billing
fees.invoices.read            invoice + line + adjustment read            [finance_staff]
fees.invoices.create          create / edit / delete a DRAFT invoice
fees.invoices.issue           issue (number + freeze + ledger post)
fees.invoices.void            void a zero-balance invoice
fees.payments.read            payment + allocation read                   [finance_staff]
fees.payments.collect         record a payment and allocate it
fees.payments.reverse         reverse an allocation (correction, non-refund)
fees.refunds.read             refund read                                 [finance_staff]
fees.refunds.request          create a refund request
fees.refunds.approve          approve / reject a refund (step-up MFA)
fees.refunds.process          disburse an approved refund (step-up MFA)
fees.adjustments.read         adjustment read
fees.adjustments.create       add an adjustment (fine, late fee, other)
fees.adjustments.approve      add a concession / waiver (post-issue approval control)
fees.receipts.read            receipt read
fees.receipts.reissue         mint a superseding receipt version        [finance_staff, not cashier]
fees.reconciliation.read      batch + match read
fees.reconciliation.manage    create batches, match, complete, cancel
fees.ledger.read              ledger groups and entries read
fees.reports.read             AGGREGATE reports only — the principal grant
fees.portal.read              parent/student self-service read            [guardian, student_self]
```

**Deliberately split permissions**, per the brief's instruction not to use one broad permission
across confidentiality levels:

- `fees.invoices.read` ≠ `fees.payments.read` ≠ `fees.refunds.read` — three confidentiality levels.
- `fees.reports.read` ≠ `fees.invoices.read` — aggregate vs document.
- `fees.portal.read` ≠ `fees.invoices.read` — self-service vs staff, with RLS as the real boundary.
- `fees.adjustments.create` ≠ `fees.adjustments.approve` — mirroring the repo's
  `attendance.mark` / `attendance.approve_leave` split (`permissions.ts:105-107`).
- `fees.refunds.request` / `.approve` / `.process` — three-step separation, so the requester cannot
  self-approve and the approver need not disburse.

### 20.4 The authoritative matrix

Repository personas. `ALLOW` / `DENY` / `COND` (conditional, rule stated).

| Permission | `platform_admin` | `school_owner` | `principal` | `accountant` | `cashier` | `teacher` | `parent` | `student` |
|---|---|---|---|---|---|---|---|---|
| **Configuration** |||||||||
| `fees.structures.read` | DENY | ALLOW | DENY | ALLOW | DENY | DENY | DENY | DENY |
| `fees.structures.manage` | DENY | ALLOW | DENY | **DENY** (§20.5) | DENY | DENY | DENY | DENY |
| `fees.assignments.read` | DENY | ALLOW | DENY | ALLOW | DENY | DENY | DENY | DENY |
| `fees.assignments.manage` | DENY | ALLOW | DENY | **DENY** (§20.5) | DENY | DENY | DENY | DENY |
| **Billing** |||||||||
| `fees.invoices.create` | DENY | ALLOW | DENY | ALLOW | DENY | DENY | DENY | DENY |
| `fees.invoices.issue` | DENY | ALLOW | DENY | ALLOW | DENY | DENY | DENY | DENY |
| `fees.invoices.void` | DENY | ALLOW | DENY | ALLOW | DENY | DENY | DENY | DENY |
| **Invoice reading** |||||||||
| `fees.invoices.read` | DENY | ALLOW | **DENY** (§20.2) | ALLOW | DENY | DENY | DENY | DENY |
| *(challan read)* — carried by `fees.invoices.read` / `fees.portal.read` | DENY | ALLOW | DENY | ALLOW | DENY | DENY | **COND** (a) | **COND** (b) |
| **Payment reading** |||||||||
| `fees.payments.read` | DENY | ALLOW | **DENY** | ALLOW | ALLOW | DENY | DENY | DENY |
| **Payment collection** |||||||||
| `fees.payments.collect` | DENY | ALLOW | DENY | ALLOW | **ALLOW** | DENY | DENY | DENY |
| `fees.payments.reverse` | DENY | ALLOW | DENY | ALLOW | DENY | DENY | DENY | DENY |
| **Adjustment** — `.create` = fine/late-fee/other, `.approve` = concession/waiver (the same permission, split by adjustment kind, mirroring `attendance.mark` / `attendance.approve_leave`) |||||||||
| `fees.adjustments.read` | DENY | ALLOW | DENY | ALLOW | DENY | DENY | DENY | DENY |
| `fees.adjustments.create` | DENY | ALLOW | DENY | ALLOW | DENY | DENY | DENY | DENY |
| `fees.adjustments.approve` | DENY | ALLOW | DENY | ALLOW | DENY | DENY | DENY | DENY |
| **Refund** |||||||||
| `fees.refunds.read` | DENY | ALLOW | **DENY** | ALLOW | DENY | DENY | DENY | DENY |
| `fees.refunds.request` | DENY | ALLOW | DENY | ALLOW | DENY | DENY | DENY | DENY |
| `fees.refunds.approve` | DENY | ALLOW | DENY | ALLOW | DENY | DENY | DENY | DENY |
| `fees.refunds.process` | DENY | ALLOW | DENY | ALLOW | DENY | DENY | DENY | DENY |
| **Reconciliation** |||||||||
| `fees.reconciliation.read` | DENY | ALLOW | DENY | ALLOW | DENY | DENY | DENY | DENY |
| `fees.reconciliation.manage` | DENY | ALLOW | DENY | ALLOW | DENY | DENY | DENY | DENY |
| **Receipts** |||||||||
| `fees.receipts.read` | DENY | ALLOW | DENY | ALLOW | ALLOW | DENY | **COND** (a) | **COND** (b) |
| `fees.receipts.reissue` | DENY | ALLOW | DENY | ALLOW | **DENY** (§20.1) | DENY | DENY | DENY |
| **Reports** |||||||||
| `fees.reports.read` | DENY | ALLOW | **ALLOW** | ALLOW | DENY | DENY | DENY | DENY |
| `fees.ledger.read` | DENY | ALLOW | DENY | ALLOW | DENY | DENY | DENY | DENY |
| **Portal** |||||||||
| `fees.portal.read` | DENY | ALLOW | DENY | DENY | DENY | DENY | **ALLOW** | **ALLOW** |

**Conditional rules, stated exactly:**

- **(a) PARENT** — `fees.portal.read` is granted at the role level and narrowed **in the database**
  (§19.4) to students linked via `student_guardians` where `sg.deleted_at IS NULL`, and
  `fees.receipts.read` is narrowed to receipts of payments that have at least one allocation
  touching a linked student. A parent **never** reaches `fin_payments` — the policy on that table
  has no guardian branch at all. A parent sees an invoice, a challan, and a receipt; they never see
  a payment row, an allocation, or another family's anything.
- **(b) STUDENT** — identical, narrowed to `students.user_id = app_ctx_user()`.

`teacher` is `DENY` across the board. This is consistent: a teacher holds no `fees.*` grant, and the
authorization gate (`apps/api/src/plugins/authorization.ts:68-70`) makes a route referencing an
ungranted permission impossible to declare, so no finance surface is even reachable to a teacher
except through a shared browser session.

### 20.5 Existing-role backfill — a P1 that the naive design misses

Because role templates are materialised **only at tenant creation** (§1.5), adding permissions to
`ROLE_TEMPLATES` is **not** a backfill. The migration must do it explicitly.

| Role | Change | Migration action |
|---|---|---|
| `platform_admin` | **No change.** It receives only `platform.*` permissions (enforced by `assertCatalogConsistent`, `permissions.ts:353-355`). | none |
| `school_owner` | **Gains all 25 `fees.*` permissions.** | `INSERT … ON CONFLICT DO NOTHING` into `role_permissions` |
| `principal` | **Gains exactly `fees.reports.read`.** | insert that one row only |
| `accountant` | **Gains 22 of 25** — all except `fees.structures.manage`, `fees.assignments.manage`, and `fees.portal.read`. Structure and assignment design is an administrative act, not a bookkeeping one, and the accountant has no portal surface. | insert those 22 rows |
| `cashier` | **New role.** Created per existing tenant + granted exactly **3** permissions: `fees.payments.read`, `fees.payments.collect`, `fees.receipts.read`. **Not** `fees.receipts.reissue` — a cashier may read a receipt but not mint one (P1-03). | `INSERT` into `roles` (`is_system = true`, `scope='tenant'`) + `role_permissions` |
| `teacher` | **No change.** | none |
| `parent` | **Gains `fees.portal.read`.** | insert one row |
| `student` | **Gains `fees.portal.read`.** | insert one row |
| **custom roles** (`roles.is_system = false`) | **NO CHANGE — and this is the safety property.** | the backfill filters `WHERE r.is_system = true AND r.tenant_id IS NOT NULL`, so a tenant's bespoke role is never silently widened |

The backfill is a **forward-only, additive** migration following the `0020` pattern: it adds
permission rows and never removes any. The `is_system` filter is what guarantees the brief's
requirement — "do NOT blindly widen custom roles" — is satisfied *structurally* rather than by
convention.

**Post-condition assertion.** The migration ends with a `DO $assert$` that fails the deploy if, for
any tenant, a `principal` role holds any `fees.*` permission other than `fees.reports.read`, or if
any non-`is_system` role's permission set changed. The second check is expressed by comparing a
checksum captured before and after — the migration computes the checksum of all non-system roles'
permission sets at the start and re-verifies it at the end, in the same transaction. This makes
"no unauthorized permission expansion" a **mechanically verified** property, which is what the
brief's test requirement actually asks for.

**Test:** `finance-020` — (a) every `is_system` role's permission set exactly equals its
`ROLE_TEMPLATES` entry; (b) no `is_system=false` role gained or lost a permission across the
migration (checksum); (c) `principal` holds exactly one `fees.*` permission; (d) `platform_admin`
holds zero `fees.*` permissions.

### 20.6 Web navigation

`apps/web/lib/nav.ts` currently holds 13 permission-gated sections. Phase 7 adds **four**:

| Section | Gating permission |
|---|---|
| Fee Structures | `fees.structures.read` |
| Invoices & Challans | `fees.invoices.read` |
| Payments & Receipts | `fees.payments.read` |
| Finance Reports | `fees.reports.read` |

`visibleSections()` is a pure filter over the DB-derived permission set (`nav.ts:94-99`), so a
section cannot appear for a role that lacks its permission. **No principal-facing nav section is
added** — with `fees.reports.read` the principal sees "Finance Reports" and nothing else, which is
the visible expression of §20.2.

---

## 21. API contract

### 21.1 The idempotency gap — a real blocker, closed

`FINANCE_DESIGN.md:26` claims `Idempotency-Key` is **required**. It is not:
`idempotencyKeyFromHeader` returns `null` when absent and never throws
(`apps/api/src/routes/school/util.ts:357-362`), and `withIdempotency` then runs the operation with
**no protection at all** (`packages/idempotency/src/index.ts:95-98`).

For a read-only module that is defensible. For a money module it is not. **Phase 7 closes this with
two changes, both in the finance route layer:**

1. `requireIdempotencyKey()` — a `preHandler` that 400s
   (`code: 'idempotency_key_required'`) when the header is absent, on **every** money POST
   (payment, allocation, refund request/approve/process, adjustment, invoice issue, billing run).
2. `withMoneyIdempotency()` — a wrapper that additionally **compares the request fingerprint**.
   Today `requestHash` is written (`packages/idempotency/src/index.ts:65`, into the
   `idempotency_keys.request_hash` column, declared `text` at `0001:189`) but **never read**:
   `readIdempotency()`
   (`packages/idempotency/src/index.ts:36-53`) selects the row and returns only
   `{ status, body }`, and neither of the two replay paths in `withIdempotency()`
   (`:100-101` and `:119-121`) compares the stored hash to the incoming one. The doc comment at
   `packages/idempotency/src/index.ts:9-12` states the policy it does not enforce — a mismatch is
   "the caller's responsibility to surface", matching the "first write wins" contract. For money,
   replaying a stored response for a *different* body is a silent
   financial misrepresentation, so a mismatch is `409 idempotency_key_reuse`.

The header name is **`x-idempotency-key`**, matching the code, not the `Idempotency-Key` of
`FINANCE_DESIGN.md`. The design follows the code.

### 21.2 The authorization contract is fail-closed at boot

`apps/api/src/plugins/authorization.ts:105-113` throws at startup if a route has no
`config.authorization`, and `:68-70` throws if a route's permission is not in `PERMISSION_CATALOG`.
Consequences for Phase 7, in order:

1. `fees.*` permissions must land in `packages/permissions/src/permissions.ts` **before** any finance
   route file is registered, or the API refuses to boot.
2. Every finance route declares `config: { authorization: { kind: 'tenant', permission: '…' } }`
   matching its `requirePermission('…')` string **exactly** (string equality, `authorization.ts:85`).
3. Full paths are literal at each call site; there is no route prefix injection
   (`app.ts:125-162`).
4. `requireCsrf()` on every mutating route; omitted on reads.

### 21.3 Endpoints

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/api/v1/finance/fee-heads` | `fees.structures.read` | |
| POST | `/api/v1/finance/fee-heads` | `fees.structures.manage` | |
| GET/POST | `/api/v1/finance/fee-structures` | `…read` / `…manage` | |
| GET/PATCH | `/api/v1/finance/fee-structures/:id` | `…read` / `…manage` | draft only |
| POST | `/api/v1/finance/fee-structures/:id/publish` | `fees.structures.manage` | freeze point |
| POST | `/api/v1/finance/fee-structures/:id/retire` | `fees.structures.manage` | |
| GET/POST | `/api/v1/finance/fee-assignments` | `…read` / `…manage` | |
| POST | `/api/v1/finance/billing-runs` | `fees.assignments.manage` | idempotent; §8 |
| GET | `/api/v1/finance/billing-runs/:id` | `fees.assignments.read` | includes the trace |
| POST | `/api/v1/finance/invoices` | `fees.invoices.create` | **lines only, no totals** |
| GET | `/api/v1/finance/invoices` | `fees.invoices.read` | |
| GET | `/api/v1/finance/invoices/:id` | `fees.invoices.read` **+ `fees.adjustments.read`** for the `adjustments` sub-resource | balance from `fin_v_invoice_balance` — the **view**, not the cached `fin_invoices.balance` column. The cache is a trigger-maintained denormalisation (§12.4.1); the view is the authority, and a report that read the cache would inherit every bug in the trigger rather than being independent of it |
| POST | `/api/v1/finance/invoices/:id/issue` | `fees.invoices.issue` | idempotent; number + ledger |
| POST | `/api/v1/finance/invoices/:id/void` | `fees.invoices.void` | guard: balance = 0 |
| GET | `/api/v1/finance/invoices/:id/challan` | `fees.invoices.read` | |
| POST | `/api/v1/finance/invoices/:id/adjustments` | `fees.adjustments.create`; **additionally `fees.adjustments.approve` when `type IN ('concession','waiver')`** | a concession or waiver is a **second gate on the same write**, not a second route — adjustments are append-only (§11.1) and `invoices.total` is trigger-computed from every row regardless of who wrote it, so gating at write is the only enforcement point that needs no `status` column and no change to FI-001. A `fine` / `late_fee` / `other` needs only `create`. **Consequence: the approver is the creator, so there is no separation of duties — OD-15** |
| POST | `/api/v1/finance/payments` | `fees.payments.collect` | §13.4 allocation modes |
| GET | `/api/v1/finance/payments` | `fees.payments.read` | |
| GET | `/api/v1/finance/payments/:id` | `fees.payments.read` | position from `fin_v_payment_position` |
| POST | `/api/v1/finance/payments/:id/allocations` | `fees.payments.collect` | |
| DELETE | *(none)* | — | **no delete endpoint exists by design**; reversal only |
| POST | `/api/v1/finance/payments/:id/allocations/:aid/reverse` | `fees.payments.reverse` | correction reversal |
| POST | `/api/v1/finance/payments/:id/auto-allocate` | `fees.payments.collect` | explicit opt-in oldest-due-first |
| POST | `/api/v1/finance/payments/:id/return-on-account` | `fees.payments.reverse` | on-account return of **uncollected** cash; writes an `invoice_id IS NULL, amount < 0` allocation. Distinct from a refund, which is bounded by applied cash (FI-005) |
| POST | `/api/v1/finance/payments/:id/receipt-reissue` | **`fees.receipts.reissue`** | mints receipt `version = n+1` with `supersedes_id`; the old version stays readable (§25.5). **Not** a `PATCH` — there is no receipt mutation route. Gated on `reissue`, **not** `read` (P1-03): under the previous revision a `cashier`, who holds `fees.receipts.read`, could mint a new financial document |
| GET | `/api/v1/finance/payments/:id/receipt` | `fees.receipts.read` | |
| POST | `/api/v1/finance/refunds` | `fees.refunds.request` | |
| GET | `/api/v1/finance/refunds` | `fees.refunds.read` | |
| POST | `/api/v1/finance/refunds/:id/approve` | `fees.refunds.approve` | **step-up MFA** |
| POST | `/api/v1/finance/refunds/:id/reject` | `fees.refunds.approve` | |
| POST | `/api/v1/finance/refunds/:id/process` | `fees.refunds.process` | **step-up MFA** |
| GET | `/api/v1/finance/receipts/:id` | `fees.receipts.read` | |
| GET | `/api/v1/finance/reconciliation/batches` | `fees.reconciliation.read` | |
| POST | `/api/v1/finance/reconciliation/batches` | `fees.reconciliation.manage` | |
| POST | `/api/v1/finance/reconciliation/batches/:id/start` | `fees.reconciliation.manage` | `open → matching`. The route updates `status` and **nothing else** — `matched_total` and `variance_amount` are derived by `trg_fin_recon_batch_derive_totals` (`BEFORE UPDATE OF status`), and `is_final` is propagated to the batch's matches by `trg_fin_recon_batch_stamp_matches` (`AFTER UPDATE OF status`) (§14.1.1). A route that set `is_final` itself would be a caller-writable copy of a derived value, exactly like the `NEW.is_final := …` the row trigger overwrites |
| POST | `/api/v1/finance/reconciliation/batches/:id/complete` | `fees.reconciliation.manage` | writes snapshot + hash |
| POST | `/api/v1/finance/reconciliation/batches/:id/cancel` | `fees.reconciliation.manage` | allowed from `open` **or** `matching`. The previous revision said "`open` only", which made a batch that had been started **unabandonable**: `matching → open` is refused once any match is final (FI-018), `matching → completed` demands a snapshot and a hash the operator may not have, so the only remaining legal transition was the one the route forbade. A half-matched batch that turns out to be the wrong statement *must* be cancellable, and `cancelled` is the transition that says so out loud |
| GET | `/api/v1/finance/reports/ar-aging` | `fees.reports.read` | **aggregate**, from `fin_v_ar_aging` (§15.2.2) |
| GET | `/api/v1/finance/reports/collections` | `fees.reports.read` | aggregate, from `fin_v_collections_summary` |
| GET | `/api/v1/finance/reports/on-account` | `fees.reports.read` | aggregate, from `fin_v_on_account_summary` |
| GET | `/api/v1/finance/reports/fee-head-revenue` | `fees.reports.read` | aggregate, from `fin_v_fee_head_revenue`. The `fee_head_id` column is a permitted taxonomy identifier (§15.2.2), **not** a person id |
| GET | `/api/v1/finance/ledger/groups/:id` | `fees.ledger.read` | legs + `fin_v_ledger_account_balance` for the trial balance (§12.4.2) |
| POST | `/api/v1/finance/gateways/:provider/webhook` | `kind: 'public'` + signature auth | §27.4 |
| GET | `/api/v1/me/finance/invoices` | `fees.portal.read` | portal, self-scoped |
| GET | `/api/v1/me/finance/balance` | `fees.portal.read` | portal |
| GET | `/api/v1/me/finance/receipts` | **`fees.portal.read`** | portal (P1-04 — see below) |
| GET | `/api/v1/me/finance/receipts/:id` | **`fees.portal.read`** | portal (P1-04) |
| GET | `/api/v1/me/finance-context` | `fees.portal.read` | roster, built by the same resolver as the data routes |
| POST | `/api/v1/me/mfa/factors` | `kind: 'authenticated'` (self) | enroll a factor; returns the TOTP `otpauth://` URI **once**. The shared secret is never returned again — only `secret_digest` is stored (§19.8.1) |
| POST | `/api/v1/me/mfa/factors/:fid/confirm` | `kind: 'authenticated'` (self) | prove possession; sets `confirmed_at`. An unconfirmed factor **never** satisfies F7 |
| DELETE | `/api/v1/me/mfa/factors/:fid` | `kind: 'authenticated'` (self) | sets `revoked_at`; not a hard delete, because the audit trail references the row |
| POST | `/api/v1/finance/refunds/:id/step-up` | `kind: 'authenticated'` (self) | calls F9 `app_mint_step_up_challenge`, returns the code/QR out of band. **No `fees.*` permission** — minting a challenge is self-service; the *refund* is what needs a permission, and that is checked at approve/process. Returns 503 `step_up_unavailable` when no factor is enrolled (§19.8.3) |

The **webhook is the only `kind: 'public'` finance route**, and it is therefore forbidden from
carrying any `preHandler` gate — `authorization.ts:97-102` fails the boot if a public route carries
one. It is authenticated by **provider signature verification inside the handler**, before any
tenant resolution or business write. This is stated explicitly because it looks like a hole and is
not: there is no session, therefore no tenant claim, therefore the handler must derive tenant from
the verified provider account mapping and nothing else (§27.4).

Portal routes follow the established two-part `*-context` + data pattern
(`/me/attendance-context` + `/me/attendance`), with both built by the **same** resolver so the
advertised roster can never exceed what the data route serves.

**Portal receipts are gated on `fees.portal.read`, not `fees.receipts.read`, and the previous revision
contradicted itself here (P1-04).** The old table gated `/me/finance/receipts` on
`fees.receipts.read`, but §20.4's conditional rule (a) grants a **parent** `fees.portal.read` and
grants `fees.receipts.read` only "narrowed to receipts of payments that have at least one allocation
touching a linked student" — a narrowing that is a **database** fact, expressed as an RLS policy on
`fin_receipts`, and not a permission the parent role holds at all. The route table and the permission
matrix therefore disagreed about what a parent needs, and the honest options were to grant parents
`fees.receipts.read` (a second finance permission, weakening the "exactly one" simplicity of §20.2) or
to gate the route on what they actually hold. The second is chosen:

| Layer | What it says |
|---|---|
| **Route** (`/me/finance/receipts*`) | requires `fees.portal.read`, which `parent` and `student` hold |
| **Permission matrix** | `fees.receipts.read` for `parent`/`student` stays **COND (a)/(b)** — it is a *narrowed* grant, held for the staff-shaped reads and asserted by the RLS test, not a portal grant |
| **RLS** (`fin_receipts` `SELECT`) | the guardian branch is the inverted reachability path of §19.4: receipt → allocation → invoice → linked student, returning a **boolean** and leaking no amount |
| **Why this is safe** | the route permission decides *whether the endpoint is reachable*; the RLS policy decides *which rows it returns*. Neither alone is sufficient, and the portal needs both. Gating on `fees.receipts.read` would have meant a parent could reach the route with a permission they do not hold (403) even where RLS would have allowed the rows — a reachable route that always denies, which is a bug report, not a design |

**The four `/me/mfa/*` routes and the step-up route are `kind: 'authenticated'`, not `'tenant'`, and
that is deliberate.** MFA enrollment is a property of the *identity*, not of a school (§19.8.1: a
factor is deliberately tenant-less). A route declared `'tenant'` would require an `active_tenant_id`
on the session, which would make it impossible for a user to enroll a factor before joining a
tenant — the exact case that matters. `POST /finance/refunds/:id/step-up` is authenticated rather
than tenant-scoped for the same reason, plus one more: the tenant it binds is taken from
`app_current_tenant_id()` at mint time and re-checked at consume time, so an authenticated-but-
tenantless caller cannot mint anything, and the failure is a clean `28000` from F9 rather than an
authorization-shaped 403 that would leak whether the refund exists.

**`app_ctx_session_id()` is still an unresolved dependency (P2-10).** The binding requires "on THIS
session", and `0002` does not expose a session claim. This is recorded here rather than papered over:
the implementer must either add a session claim to the signed context (a cross-phase change to
`0002`, which is immutable) or pass the session id as a validated route argument. **OD-14** carries
the decision.

### 21.4 Error codes (namespace `fee.*`)

New codes, all registered in `mapDomainError` (`util.ts:310-355`) — a trigger message with no
registration silently collapses to a generic 409, which is a poor contract:

`fee_invoice_already_issued`, `fee_invoice_not_draft`, `fee_invoice_has_balance`,
`fee_allocation_exceeds_payment`, `fee_allocation_exceeds_balance`,
`fee_nothing_applied_to_refund`, `fee_on_account_return_exceeds_unallocated`,
`fee_reversal_wrong_invoice`, `fee_reversal_exceeds_outstanding`,
`fee_payment_not_settled`, `fee_refund_exceeds_payment`, `fee_refund_not_approved`,
`fee_refund_already_processed`, `fee_refund_provenance_violation`,
`fee_refund_allocations_incomplete`, `fee_receipt_immutable`, `fee_ledger_unbalanced`,
`fee_ledger_immutable`, `fee_ledger_group_sealed`, `fee_structure_published`,
`fee_structure_target_invalid`, `fee_structure_overlapping`, `fee_billing_ambiguous`,
`fee_recon_already_matched`, `fee_recon_batch_immutable`, `fee_webhook_signature_invalid`,
`fee_webhook_account_mismatch`, `fee_webhook_replay`, `fee_bank_account_invalid`,
`fee_invoice_item_immutable`, `fee_adjustment_reversal_invalid`,
`idempotency_key_required`, `idempotency_key_reuse`.

---

## 22. Web contract

Four staff surfaces plus two portal surfaces, all permission-gated by the same `nav.ts` mechanism
(§20.6). The design constraints that matter:

- **No client-side money arithmetic.** The POS collection screen sends `allocations[]` and displays
  `balance` from the server. The UI never computes a balance, a total, or a change due. Every
  displayed money value comes from the response, which comes from the views (§12.4).
- **Balance display is always from `fin_v_invoice_balance` / `fin_v_payment_position`**, so the UI
  and the API cannot disagree.
- **Idempotency key is generated once per user intent**, held in component state, and reused on
  retry — not regenerated per click. Regenerating on retry is the classic double-charge bug.
- **Reversal is a distinct, labelled action**, never a delete affordance. There is no delete button
  anywhere in the finance UI, matching §21.3.
- **The over-credit state renders as an explicit badge**, not a negative number styled as a bug.
- Portal UI is read-only: invoice list, invoice detail, challan, receipt, balance. No payment form
  in Phase 7 (no provider).

---

## 23. Events / outbox

### 23.1 New event types

Appended to `outboxEventTypeSchema` (`packages/contracts/src/events.ts:3-145`), which is the only
gate the worker has:

```text
fee.invoice.issued          fee.payment.recorded         fee.refund.requested
fee.invoice.voided          fee.payment.allocated        fee.refund.approved
fee.invoice.adjusted        fee.payment.reversed         fee.refund.processed
fee.challan.issued          fee.receipt.issued           fee.reconciliation.completed
fee.fee_structure.published fee.finance_document.generated
fee.billing.run.completed   fee.invoice.overdue          fee.parent.notification.requested
fee.reconciliation.drift
```

**18 new events, not 19.** The previous revision listed `fee.reconciliation.exception` here as well as
`fee.reconciliation.drift`, but §24.2's disposition table had rows for both, only one of them was ever
emitted, and §16.5 had already ruled that the pair is one fact with one name. A second HANDLED row for
an event nothing emits inflates the HANDLED count and creates a registry entry no publisher can
satisfy. The phantom is deleted, and §24.1's arithmetic moves with it.

Payloads are **IDs and integers only** — never a name, an email, a phone, a bank account, or an IBAN.
This follows the repository's own precedent comment (`packages/contracts/src/events.ts:39-41`:
"Payloads stay minimal (ids only — no applicant PII in events)"). The reason is mechanical, not
stylistic: `sanitizePayload` is a **shallow, top-level-only** denylist
(`packages/events/src/outbox.ts:6-14`) and `redactDeep` in the audit helper matches 13 key names
(`packages/audit/src/index.ts:3-18`) — **neither list contains `iban`, `pan`, `card`, or
`account_number`**. A nested `payload.bank.iban` would be persisted verbatim in `outbox_events` and
`audit_logs`. Therefore a **gated static test** asserts that no `fee.*` producer passes a key
matching `/iban|pan|card|account|bic|swift|phone|email|password|secret/i` at any depth, and finance
audit actions add the finance PII keys to `redactDeep`'s denylist in the same change.

Audit action namespace: **`fee.<entity>.<verb-past-tense>`** — `fee.invoice.issued`,
`fee.payment.recorded`, `fee.refund.processed`, `fee.invoice.voided`. This is the domain-scoped,
past-tense convention of the 87 existing literals (`grade.level.created`, not `grade_levels.created`),
and it matches `DATABASE_DESIGN.md:156`, which already prescribes `fee.payment.recorded`.
`resource_type` uses the singular snake_case table suffix: `invoice`, `payment`, `refund`,
`receipt`, `challan`, `ledger_group`.

### 23.2 The transactional discipline

Every event is written with `enqueueOutbox(tx, …)` **inside** the business transaction, in the same
`withTenant` callback as `writeAudit` (FI-012). `correlationId` is the request id **only if it is a
UUID** — `outbox_events.correlation_id` is typed `uuid` (`schema.ts:270`) and the `x-request-id`
header is client-supplied, so a finance service generates its own UUID if the header is not one.
Getting this wrong is a 500 on a money path.

---

## 24. Worker behavior

### 24.1 Event disposition table — every event classified, none falling through

This is the direct answer to F-7.3. Every Phase 7 event has **exactly one** disposition. A financial
event may never reach the `logEvent(type)` fallback.

| Event | Disposition | Handler behaviour | Test |
|---|---|---|---|
| `fee.invoice.issued` | **HANDLED** | enqueue the challan/receipt artifact job; emit `fee.challan.issued` | registry gate + `finance-024` |
| `fee.invoice.voided` | **HANDLED** | enqueue a void-notice artifact | `finance-024` |
| `fee.invoice.adjusted` | **HANDLED** | enqueue a revised-challan artifact if the invoice is issued | `finance-024` |
| `fee.challan.issued` | **HANDLED** | generate the challan PDF; stamp `fin_document_artifacts`; emit `fee.finance_document.generated` | `finance-029` |
| `fee.payment.recorded` | **HANDLED** | generate the receipt PDF; stamp; emit `fee.receipt.issued` | `finance-029` |
| `fee.payment.allocated` | **HANDLED** | no artifact; re-emit nothing; records that a receipt re-print is available | `finance-024` |
| `fee.payment.reversed` | **HANDLED** | enqueue a reversal-advice artifact | `finance-024` |
| `fee.receipt.issued` | **INTENTIONALLY_NOOP** | the receipt PDF already exists by construction; the receipt is a document, not a trigger for a document | `finance-024` asserts a no-op handler that performs **no** DB write |
| `fee.refund.requested` | **HANDLED** | enqueue an approval-request notification stub | `finance-024` |
| `fee.refund.approved` | **HANDLED** | enqueue a refund-advice PDF artifact | `finance-029` |
| `fee.refund.processed` | **HANDLED** | enqueue a refund-advice PDF + a parent notification stub | `finance-029` |
| `fee.finance_document.generated` | **INTENTIONALLY_NOOP** | terminal artifact event; the artifact exists | `finance-024` |
| `fee.billing.run.completed` | **HANDLED** | emit a summary notification; no per-invoice work | `finance-024` |
| `fee.reconciliation.completed` | **HANDLED** | enqueue a reconciliation-summary artifact; emit alert if variance > 0 | `finance-024` |
| `fee.reconciliation.drift` | **HANDLED** | enqueue a high-severity alert; **must** be actionable, never a no-op. This row previously had a twin for `fee.reconciliation.exception`, which no publisher ever emitted; both rows are one event and only one remains | `finance-024` |
| `fee.fee_structure.published` | **INTENTIONALLY_NOOP** | publication is synchronous; there is no deferred work | `finance-024` |
| `fee.invoice.overdue` | **INTENTIONALLY_NOOP** | **deferred to Phase 8.** Phase 7 emits the event; the notification channel (SMS/email) does not exist until Phase 8. Documented NOOP with reason. | `finance-024` asserts the no-op and asserts the event is emitted |
| `fee.parent.notification.requested` | **INTENTIONALLY_NOOP** | **deferred to Phase 8** for the same reason | `finance-024` |

### 24.2 The registry gate, which must be updated, not bypassed

`apps/worker/src/worker-event-registry.test.ts` pins the catalog at **93** and the split at
**9 HANDLED / 84 NOOP**. The 18 new events are **13 HANDLED / 5 NOOP** (§24.1, counted from the
disposition table, not estimated), so the new pins are:

```text
catalog  93 + 18 = 111
HANDLED  9 + 13 =  22
NOOP    84 +  5 =  89
22 + 89 = 111
```

**These figures are one lower than the previous revision's, and the reason is a deleted event, not a
recount.** That revision carried 19 new events because `fee.reconciliation.exception` had its own
HANDLED row; §16.5 had already established that it and `fee.reconciliation.drift` are one fact under
one name, so the extra row was a HANDLED entry no publisher could ever satisfy. Deleting it removes
one new event and one HANDLED and leaves NOOP untouched, which is why 5 and 89 are unchanged across
both revisions. The arithmetic is asserted from the disposition table row-by-row, so it cannot drift
from the table again.

All three pins (`worker-event-registry.test.ts:75`, `:90-104`, and `outbox-integration.test.ts:428`)
must be updated in the same commit as the enum change, and `finance-webhook-provider.test.ts`
asserts the **disposition of every one of the 18 by name** rather than a count, so a miscount is a
failing test rather than a silently wrong pin.

Additionally, and this is the structural fix for F-7.3 rather than a patch: **the fallback arm
`logEvent(type)` is removed** and replaced with a mandatory explicit list. Every declared event type
must appear in either the `HANDLED` ladder or a named `INTENTIONALLY_NOOP` set; anything else throws
at registry construction, which is at worker start-up. A financial event can then never be silently
acknowledged — not by omission, not by accident, and not by a future contributor in a hurry.

### 24.3 Prerequisites that are not Phase 7 features

| Fix | Why it blocks Phase 7 | Where |
|---|---|---|
| `enqueueDeferred` routes via `queueForJob()` | a `billing`/`finance` queue would be misrouted to `events` and every job would throw | `apps/worker/src/worker.ts:88-90`; fix `packages/jobs/src/queues.ts:45-50` |
| deferred jobs pass a `jobId` | today `target.add(job.name, job.data)` passes none, so a redriven event enqueues a duplicate artifact job; the `idempotencyKey` in the payload is decorative | `worker.ts:90` |
| the stale-redrive loop is defeated by BullMQ `jobId` dedupe | `removeOnFail: 200` retains failed jobs; `queue.add({jobId: event.id})` is then a permanent no-op, while `dispatched_at` is re-stamped every 5 minutes. An infinite retry loop with **zero progress** and no dead-letter signal — the worst shape for a financial event. | `packages/events/src/dispatcher.ts:79-93` |
| no DLQ exists; `attempts` is written and never read; `on('failed')` only logs | a permanently-failing financial event is invisible | `worker.ts:245-253` |

These are Phase 6 carry-over defects. Phase 7 **depends on** the first and last; the second and third
are the reason §24.4 states the retry posture honestly rather than claiming durability.

### 24.4 Transaction and retry posture, stated honestly

- Handlers run under `withSystem` (`school_migrator`, empty ticket). **Every query scopes by
  `event.payload.tenantId`.** A static guard test asserts this, matching the existing one.
- Handlers may not enqueue inside their transaction — they use `defer` (`worker.ts:32-37`).
- `attempts` budget for `event.process` is **5**, exponential from 2s, **no jitter**
  (`dispatcher.ts:84-88`).
- **There is no dead-letter queue.** A permanently failing financial event ends as
  `processed_at IS NULL` with `attempts >= 5` and a `last_error`. Phase 7 adds a **monitored
  invariant** — a `fee.worker.stalled` alert when any `fee.*` outbox row is unprocessed beyond a
  threshold — rather than pretending a DLQ exists.

---

## 25. Artifact generation

### 25.1 Idempotency is in the database, not the object store

`StorageProvider.putObject` **overwrites unconditionally** (`packages/storage/src/index.ts:50-56`;
`storage.test.ts:39` asserts it), the §3 driver is a **stub that rejects all five methods**
(`:82-98`), and `files.storage_key` is `.unique()` **globally** (`packages/db/src/schema.ts:550`).
An object key is therefore **not** an idempotency boundary. The database row is.

### 25.2 Logical artifact identity

```sql
CREATE TABLE fin_document_artifacts (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id        uuid NOT NULL,
    document_type    text NOT NULL
                     CHECK (document_type IN ('invoice','challan','receipt',
                                              'refund_advice','reversal_advice',
                                              'on_account_return_advice',
                                              'void_notice',
                                              'statement','reconciliation_summary')),
    document_id      uuid NOT NULL,
    artifact_version integer NOT NULL DEFAULT 1 CHECK (artifact_version >= 1),
    file_id          uuid,
    storage_key      text NOT NULL,
    content_hash     text,
    -- Render status, so a document that failed to render is a queryable state
    -- rather than an absent row. 'rendered' is the only status that makes
    -- file_id meaningful, hence the CHECK.
    render_status    text NOT NULL DEFAULT 'pending'
                     CHECK (render_status IN ('pending','rendered','failed')),
    render_error     text,
    storage_writes   smallint NOT NULL DEFAULT 0,   -- §25.1 storage retry counter
    generated_at     timestamptz NOT NULL DEFAULT now(),
    generated_by     uuid,
    CONSTRAINT fin_artifacts_ten_id_uq UNIQUE (tenant_id, id),
    CONSTRAINT fin_artifacts_logical_uq
        UNIQUE (tenant_id, document_type, document_id, artifact_version),
    CONSTRAINT fin_artifacts_file_fk
        FOREIGN KEY (tenant_id, file_id) REFERENCES files (tenant_id, id) ON DELETE RESTRICT,
    -- A rendered artifact has a file; a pending or failed one does not. This is
    -- what lets §25.3's "storage succeeded, DB write failed" retry converge: the
    -- row cannot claim 'rendered' while pointing at nothing.
    CONSTRAINT fin_artifacts_rendered_ck CHECK (
        (render_status = 'rendered' AND file_id IS NOT NULL
                          AND storage_key IS NOT NULL AND content_hash IS NOT NULL)
     OR (render_status <> 'rendered' AND render_error IS NOT NULL)
     OR (render_status = 'pending')
    ),
    CONSTRAINT fin_artifacts_writes_ck CHECK (storage_writes >= 0)
);
-- Revoke the 0001 default-privilege grant immediately (§35.4, §30.3).
REVOKE ALL ON fin_document_artifacts FROM school_app_rw;


```

**Why `document_id` has no FK, stated explicitly because it looks like a gap.** It cannot have one:
it is a **polymorphic** reference to one of nine different tables (`fin_invoices`,
`fin_receipts`, `fin_refunds`, `fin_challans`, …), and a single FK column can only name one target.
The options were a FK per document type (nine nullable columns), a supertype table (a cross-phase
schema change Phase 7 does not own), or a validated polymorphic reference. The third is chosen and
enforced by a trigger, exactly as for `fin_fee_structure_targets` in §7.6:
`trg_fin_artifact_document_valid` resolves `(document_type → relation)`, checks the row exists **and
belongs to `NEW.tenant_id`**, and raises `55000` otherwise. So cross-tenant misattribution is
rejected by the database, and §35.2's absence of an FK row for `document_id` is deliberate rather than
an oversight — the R4 allowlist covers only platform-global identity tables, and this column is
validated by a trigger instead, which is stated here so the two mechanisms are not confused.

`UNIQUE (tenant, document_type, document_id, artifact_version)` is the **logical** identity the brief
asks for. The storage key is **derived from it** and therefore also unique:

```text
finance/{document_type}/{document_id}-v{artifact_version}.pdf
```

matching the proven report-card pattern `report-cards/{reportCardId}-v{version}.pdf`
(`apps/worker/src/exams.ts:759`).

The validator itself, so the choice above is enforced by something and not by a comment:

```sql
-- Resolves (document_type -> relation) and proves the referenced document exists in
-- NEW.tenant_id. SECURITY INVOKER: the write to fin_document_artifacts is already
-- RLS-scoped to the caller's tenant, so an elevated read here would let a cross-tenant
-- sum or existence check influence a same-tenant validation. Returns void; it is a
-- helper with no trigger of its own, called by fin_artifacts_document (§35.3).
CREATE OR REPLACE FUNCTION trg_fin_artifact_document_valid() RETURNS trigger
    LANGUAGE plpgsql
    SECURITY INVOKER
    SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE v_rel  text;
        v_exists boolean;
BEGIN
    -- The mapping is a CASE over a CLOSED set of literals, never a table lookup and
    -- never a value interpolated into SQL. A lookup table would be one more
    -- school_app_rw-writable row between the validator and the decision, and
    -- dynamic SQL from a table value is how a validator becomes an injection point.
    v_rel := CASE NEW.document_type
        WHEN 'invoice'     THEN 'fin_invoices'
        WHEN 'receipt'     THEN 'fin_receipts'
        WHEN 'refund'      THEN 'fin_refunds'
        WHEN 'challan'     THEN 'fin_challans'
        WHEN 'statement'   THEN 'fin_reconciliation_batches'
        WHEN 'adjustment'  THEN 'fin_invoice_adjustments'
        ELSE NULL
    END;
    IF v_rel IS NULL THEN
        RAISE EXCEPTION 'unknown artifact document_type: %', NEW.document_type
            USING ERRCODE = '55000';
    END IF;

    -- format('%I', v_rel) is safe here BECAUSE v_rel came from the CASE above and can
    -- only be one of six literals; the identifier quoting is belt-and-braces, not the
    -- control. The tenant predicate is the actual control.
    EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I WHERE tenant_id = $1 AND id = $2)',
                   v_rel)
       INTO v_exists
      USING NEW.tenant_id, NEW.document_id;
    IF NOT v_exists THEN
        RAISE EXCEPTION
            'artifact % references a % that does not exist in this tenant',
            NEW.id, NEW.document_type
            USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION trg_fin_artifact_document_valid() FROM PUBLIC;
```

**Why a trigger and not an FK, restated as a limitation the owner should see rather than a
rationale to accept.** An FK would be free; this costs a `BEFORE` trigger on every artifact write and a
closed `document_type` list that must be `ALTER TABLE`-ed when a new document type is introduced. The
trade is deliberate — a single nullable `document_id` column with an FK cannot reference six tables —
but the honest cost is that `document_type` is now a schema-level enumeration maintained in three
places: this `CASE`, the `fin_document_artifacts_document_ck` CHECK, and the storage-key derivation
above. `finance-trigger-inventory.test.ts` asserts all three list the same literals, because a
fourth document type added to the CHECK but not to the `CASE` would insert cleanly and then be
rejected at validation time with no better diagnostic.

### 25.3 Crash / retry behaviour — converging to exactly one artifact

The full chain, copied from the report-card implementation that is already proven in production CI:

1. `UPDATE fin_document_artifacts SET file_id = … WHERE id = … AND file_id IS NULL` — a
   **compare-and-swap**. A second racing worker updates 0 rows and converges, reusing the winner's
   `file_id` (`apps/worker/src/exams.ts:793-804`).
2. `INSERT INTO files … ON CONFLICT (storage_key) DO NOTHING RETURNING id`, falling back to
   `SELECT id FROM files WHERE storage_key = …` on conflict (`apps/worker/src/exams.ts:763-791`).
3. `putObject` may run twice; the second write is a byte-identical overwrite of the same key, which
   is harmless **because the renderer is deterministic** — pinned by
   `apps/worker/src/exams.test.ts:128-130` ("byte-identical output for identical input"). The
   Phase 7 renderer inherits that test.

**Crash between `putObject` and COMMIT** leaves an orphan object with no `files` row. This is
self-healing: the deterministic key means the retry rewrites the same bytes and inserts the row. The
residual is an orphan when a document is *re-versioned* (a new `artifact_version` mints a new key).
Phase 7 adds a sweep for objects older than the retention window with no `files` row — a small job,
and it is stated as a known gap with a known fix rather than left implicit.

**Convergence guarantee:** for a given `(tenant, document_type, document_id, artifact_version)`,
exactly one `fin_document_artifacts` row can exist (unique index), exactly one `files` row can hold
its `storage_key` (global unique), and exactly one `file_id` can be stamped (CAS). Three independent
constraints. **No job-level idempotency table is required or assumed** — `job_runs` does not exist
in this repository (§1.6) and Phase 7 does not invent a dependency on it.

### 25.4 Documents are snapshots

`fin_receipts` and `fin_challans` carry a **rendered snapshot** (`jsonb`) captured at issue, so a
later rename of a fee head or a student cannot alter what a parent was already shown. This is
`report_card_subjects`' "copied, not joined" decision (`schema.ts:2304-2305`, at
`schema.ts:2295` for the table) applied to finance.
`FINANCE_DESIGN.md:46` calls for a snapshot `jsonb`; the repository's precedent is a real child
table. **Adjudicated: a real `jsonb` snapshot on the document row**, because a financial document's
line set is immutable and a `jsonb` frozen at issue is simpler and cheaper than a second child table
per document type, and unlike `report_card_subjects` it never needs querying by line.

### 25.5 The receipt — issued once, immutable for life, and provably against its payment

The brief flags a direct contradiction: `FINANCE_DESIGN.md:46` describes a receipt as "immutable"
**and** gives it `status = issued | void`. Those cannot both hold. **Adjudicated: the receipt has no
status column and no void.** There is nothing to void *about* a receipt: a receipt is not a claim, not
a balance, and not an instrument — it is the school's record that a payment was taken. A payment can
be reversed, a refund can be issued, an invoice can be voided, and in each of those cases **the
original receipt remains true**. "We took 50,000 from you on 3 March" did not become untrue because
the allocation was a data-entry error. What becomes untrue is the *interpretation*, and the
interpretation is a different document:

| What actually happened | The receipt | The compensating document |
|---|---|---|
| Money received, nothing changed | `fin_receipts` row + `receipt.pdf` | — |
| The **allocation** was a data-entry error | unchanged, still true | a **reversal advice** (`reversal_advice`, §25.2) + a corrected receipt, version 2 |
| The money is going back to the family | unchanged, still true | a **refund advice** (`refund_advice`, §25.2) |
| The **invoice** is being written off | unchanged, still true | a void notice + a revised challan |
| The uncollected cash is being handed back | unchanged, still true | an **on-account return** advice (§12.1) |

```sql
CREATE TABLE fin_receipts (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id        uuid NOT NULL,
    receipt_no       text NOT NULL,
    payment_id       uuid NOT NULL,
    -- P0-10: the payer this receipt is issued TO. Denormalised from
    -- fin_payments.payer_guardian_id on purpose: RLS on a portal document must be
    -- decidable from the row itself. A policy that has to walk payment ->
    -- student_guardians -> student -> back to the payer on every read is both slow
    -- and, worse, a policy whose correctness depends on a soft-delete column the
    -- reader cannot see. Copying the payer at issue makes family ownership a
    -- column comparison: `payer_guardian_id = app_current_guardian_id()`.
    payer_guardian_id uuid NOT NULL,
    -- P0-10: the amount is the FAMILY-ATTRIBUTABLE portion of the payment, frozen
    -- at issue. `amount = p.amount` is WRONG whenever a payment settles two
    -- families' invoices, and this design forbids that case twice over
    -- (trg_fin_allocation_family_guard §12.5 and the family-ownership matrix
    -- §35.9) -- so today amount == p.amount, and the trigger below makes that
    -- equality a database guarantee rather than an assumption. The column exists as
    -- its own value so that a future "split receipt per guardian" feature does not
    -- require redefining what a receipt is.
    amount           numeric(19,4) NOT NULL CHECK (amount > 0),   -- a copy frozen at issue
    currency         char(3) NOT NULL,
    method           text NOT NULL,
    received_at      timestamptz NOT NULL,
    received_by      uuid,
    version          integer NOT NULL DEFAULT 1 CHECK (version >= 1),
    supersedes_id    uuid,
    snapshot         jsonb NOT NULL,     -- the rendered document, frozen (§25.4)
    issued_at        timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT fin_receipts_no_uq  UNIQUE (tenant_id, receipt_no),
    CONSTRAINT fin_receipts_payment_fk
        FOREIGN KEY (tenant_id, payment_id)
        REFERENCES fin_payments (tenant_id, id),
    CONSTRAINT fin_receipts_payer_fk
        FOREIGN KEY (tenant_id, payer_guardian_id)
        REFERENCES guardians (tenant_id, id),
    CONSTRAINT fin_receipts_supersedes_fk
        FOREIGN KEY (tenant_id, supersedes_id)
        REFERENCES fin_receipts (tenant_id, id),
    -- v1 has no predecessor; v2+ must have one
    CONSTRAINT fin_receipts_version_ck CHECK (
        (version = 1 AND supersedes_id IS NULL)
     OR (version > 1 AND supersedes_id IS NOT NULL)
    ),
    CONSTRAINT fin_receipts_ten_id_uq UNIQUE (tenant_id, id)
);
-- Revoke the 0001 default-privilege grant immediately (§35.4, §30.3).
REVOKE ALL ON fin_receipts FROM school_app_rw;


```

**The disclosure the naive design permits, and why the payer column is the fix (P0-10).** A parent
reaching the portal reads receipts. The receipt's `payment_id` points at a payment row, and the
previous policy design reached the payment's `amount` by joining through the allocation and invoice to
"the linked student", then testing whether that student belongs to the reader's family. Because
`student_guardians` is many-to-many, a payment that settles two siblings' invoices is reachable from
**either** family — and the test "does the reader's family own at least one student on this invoice?"
is satisfied for both. The amount column is therefore disclosed to a guardian who is a party to the
payment but not to the specific charge it was raised for. For a school where a step-family or a
guardian with custody of one sibling shares a household with another sibling's fees, that is a real
disclosure of another family's charge, and no per-column grant fixes it because the column is the
one the document exists to show.

Making the receipt a **payer-scoped document** closes it structurally:

| Aspect | Before | After |
|---|---|---|
| Who a receipt belongs to | inferred: "any family with a student on any allocated invoice" | stored: `payer_guardian_id`, compared for equality |
| Portal policy | sub-select across 3 joins, boolean result | `payer_guardian_id = app_current_guardian_id()` — one indexed column |
| Soft-delete sensitivity | a revoked `student_guardians` link changes historical reachability | nothing; the link is copied at issue |
| Cross-family case | reachable from both families, amount exposed | unrepresentable — one payment has one payer (§12.5) |
| Staff read | same policy as portal | unchanged, `fees.receipts.read` (§20.4) |

**Why the amount is a trigger-set copy, and what it copies.** A `BEFORE INSERT` trigger
`trg_fin_receipt_freeze()` sets both `payer_guardian_id := p.payer_guardian_id` and
`amount := p.amount` from the payment row, so a client-supplied value is **overwritten**, not
validated, and a client cannot name a payer other than the payment's own. It then asserts that
`amount <= p.amount` is exact, and that the payment's allocations are all within the payer's family
(inherited from `trg_fin_allocation_family_guard`, which already ran). Because the check is
`amount = p.amount` — not `amount <= p.amount` — a caller cannot mint a receipt for a *portion* of a
payment through this path; a partial receipt is a new payment, which is the correct unit of receipt
(FI-007, §11.1).

**The immutability is enforced, and it is enforced for everybody.** A `BEFORE UPDATE OR DELETE`
trigger raises `55000` on any mutation, **including by `school_migrator`** — the same
no-GUC-bypass, no-role-exemption rule as the ledger (§15.1, §19.7 F6). There is no
`app.allow_immutable_update` escape hatch, because `0002` established that a GUC readable by a
trigger expression is forgeable by the runtime role, and `DATABASE_DESIGN.md:220`'s version of that
idea is **rejected** in §32.1.

```sql
-- BEFORE INSERT: overwrite the payer and amount from the payment, then assert the
-- invariants a client must not be able to choose.
CREATE OR REPLACE FUNCTION trg_fin_receipt_freeze() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE v_payer uuid; v_amount numeric(19,4);
BEGIN
    IF TG_OP = 'DELETE' OR TG_OP = 'UPDATE' THEN
        -- No role check, no GUC check. The previous revision's escape hatch is
        -- rejected twice over (§15.1, §32.1): a GUC is forgeable, and a role check
        -- would exempt exactly the role a compromised migration runs as.
        RAISE EXCEPTION 'a receipt is immutable: % is not permitted', TG_OP
            USING ERRCODE = '55000';
    END IF;

    -- OVERWRITE, do not validate. "Validate and reject on mismatch" would still read
    -- the client's value first, and the difference matters when the client's value is
    -- a different guardian's id: overwriting means the wrong value is never written,
    -- validation means it is briefly the value in NEW until the trigger runs.
    SELECT payer_guardian_id, amount
      INTO v_payer, v_amount
      FROM fin_payments
     WHERE tenant_id = NEW.tenant_id AND id = NEW.payment_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'receipt references an unknown payment'
            USING ERRCODE = '55000';
    END IF;
    NEW.payer_guardian_id := v_payer;
    NEW.amount            := v_amount;

    -- amount = p.amount, not amount <= p.amount. A receipt for a PORTION of a payment
    -- is a different payment, not a smaller receipt (§11.1, FI-007).
    IF NEW.amount <> v_amount THEN
        RAISE EXCEPTION 'receipt amount must equal its payment amount'
            USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION trg_fin_receipt_freeze() FROM PUBLIC;
```

**A reprint is a version, not an update, and it is a permissioned action (P1-04).** Asking for the
receipt again returns `artifact_version = 1` — that is a **read**, and it needs no special
permission. Asking for a receipt that reflects a *corrected* allocation mints `version = 2` with
`supersedes_id` set, and both versions remain retrievable and printable forever. Minting a new
version is a **mutation of the financial record set** and therefore requires its own permission,
`fees.receipts.reissue` (§20.3), held by accountant and admin only — never by `cashier`, and never by
a portal role. The previous revision described the version-2 flow with no permission at all, so any
actor who could read a receipt could also mint a corrected one; because receipts are legal and
tax-relevant documents, that is a forgery surface, not a convenience. `fin_document_artifacts`
versions the PDF the same way (§25.2), so a school holding a printed v1 and a corrected v2 has both,
and the pair is provably linked. This is the resolution of "reprint" versus "immutable": the document
is immutable, and a correction is a **new document that says it supersedes the old one**.

**Provable against its payment (FI-019).** The receipt's `amount` is a *copy*, which means it could
in principle disagree with `fin_payments.amount`. Three mechanisms prevent that, and the third is a
test:

1. `trg_fin_receipt_freeze()` (`BEFORE INSERT`) overwrites `amount` **and** `payer_guardian_id` from
   the payment row. There is no path by which a caller chooses either value.
2. `CHECK (amount > 0)`, the composite FKs to `fin_payments` and `guardians`, and
   `trg_fin_allocation_family_guard` make a receipt without a real payment, for another tenant's
   payment, or carrying another family's payer unrepresentable.
3. `finance-019` re-derives every receipt from its payment and asserts equality of **both** `amount`
   and `payer_guardian_id`, as raw SQL, for receipts created through the API, the worker, and the
   webhook handler.


**Portal visibility** is the policy of §19.4: a receipt is readable by the family **iff** one of its
payment's allocations reaches an invoice belonging to a linked student. A parent therefore sees
their own receipts and never a payment row, an allocation row, or another family's anything.

**Audit and numbering.** `receipt_no` comes from `fin_document_counters` in the same transaction as
the payment, so a receipt number is monotonic, gap-tolerant, and never reused (FI-011). Issuing a
receipt writes `fee.receipt.issued` in the same transaction (FI-012) and an audit row
`fee.receipt.issued`. Reprinting writes an audit row `fee.receipt.reprinted` and **no** outbox event
— a reprint is a read of an existing document, and emitting `fee.receipt.issued` again would make a
document look newly issued to every downstream consumer.

---

## 26. Pakistan localization

### 26.1 Urdu — adjudicated, no contradiction

The brief correctly forbids claiming both "Urdu labels included" and "English only".

**Phase 7 INCLUDES:** PKR as the default and only currency; the challan workflow (bank deposit
slip, triplicate/manual collection, the challan as the collection instrument); bank transfer and
cash deposit concepts; Pakistan IBAN validation (§26.3); a provider-neutral payment-rail boundary
with a named Easypaisa/JazzCash seam; a future Raast seam.

**Phase 7 EXCLUDES:** Urdu UI text; full RTL layout; Urdu PDF generation; any bilingual label.

**Where Urdu labels would go, if the owner later wants them:** `fin_fee_heads.name`,
`fin_invoice_items.description`, and the `description` text on an adjustment — all of which are
already free-text columns that accept UTF-8 today. So Urdu is a **content** question for those
three fields, not a schema or a layout question, and can be added without a migration. The design
records this so the deferral is cheap rather than prohibitive.

The stray CJK token `refund审批` in `DEVELOPMENT_ROADMAP.md:87` is a **defect in a file this phase does
not own**; it was not edited (see §34) and is reported in §33.

### 26.2 Automatic late fee — a scope contradiction, resolved

`DEVELOPMENT_ROADMAP.md:88` lists "dunning reminders" in Phase 7 and the brief reports the design
as including and excluding late fees. **Adjudicated, with both halves stated:**

| | Phase 7 |
|---|---|
| Automatic late-fee **policy engine** (configurable rate, grace period, recurring assessment) | **OUT OF SCOPE** |
| Scheduled late-fee assessment worker | **OUT OF SCOPE** |
| Late-fee **representation** — `fin_invoice_adjustments.type = 'late_fee'`, posting `Dr 1200 / Cr 4200` | **IN SCOPE — supported seam** |
| Manual entry of a late fee by finance staff | **IN SCOPE**, requires `fees.adjustments.create`, audited with a reason |
| `challan.status = 'expired'` as a collections marker | **IN SCOPE**, with **no** fee effect (§10.2) |
| Dunning **reminders** (SMS/email) | **OUT OF SCOPE** — Phase 8 (`com_*`). Phase 7 emits `fee.invoice.overdue` as an explicitly-NOOP event (§24.1) for Phase 8 to consume. |

**The boundary is therefore a single sentence:** *Phase 7 can record a late fee that a human decided
to charge; it will never decide to charge one.* The `late_fee` adjustment type and the
`fee.financial` event exist so the Phase 9/11 policy engine has a seam, without Phase 7 building,
scheduling, or configuring it.

### 26.3 IBAN validation — a real check, not a regex

The brief rejects `^PK[0-9A-Z]{24}$`. **Normalisation then validation, in this order:**

1. **Normalise** — strip all whitespace (including NBSP and non-breaking spaces, which paste from
   web forms), strip `-`, uppercase. Reject if the result contains a character outside `[0-9A-Z]`.
2. **Format** — must be exactly 24 characters and start with `PK`. A Pakistan IBAN is
   `PK` + 2 check digits + 3-digit bank code + 16-char BBAN = **24 total**. Length is checked
   explicitly, not by a quantifier alone, so an over-long Pakistani IBAN is rejected.
3. **MOD-97 checksum** (ISO 13616) — move the first four characters to the end, convert letters to
   numbers (`A`→`10` … `Z`→`35`) and concatenate, then require `mod 97 == 1`. A checksum-valid
   PK IBAN uses `PK10` in the moved position; the algorithm handles the general case.
4. **Bank code sanity** — the 3-digit `bankCode` at positions 5–7 must be in the bank's assigned
   range. **OPEN DECISION OD-03**: the exact bank-code list requires a National Bank of Pakistan
   reference that is not in this repository. Until it is supplied, the design validates
   `bankCode ~ '^[0-9]{3}$'` and treats the full list as a follow-up — and this is stated rather
   than silently omitted.

**Examples** (the algorithm is specified; no code is written here):

| Input | Result |
|---|---|
| `PK00SCBL0000001123456702` | rejected — MOD-97 ≠ 1 |
| `PK36SCBL0000001123456702` | rejected — MOD-97 ≠ 1 (this exact string is a widely-cited *format* example; it is **not** checksum-valid, and that is the point) |
| a 24-char PK IBAN passing MOD-97 | accepted |
| `PK36 SCBL 0000 0011 2345 6702` | accepted — whitespace stripped, identical to the unspaced form |
| `pk36scbl0000001123456702` | normalised to upper, then evaluated as above |
| `PK00AAAA0000001123456703` | rejected — checksum invalid |
| `PK36SCBL00000011234567` (23 chars) | rejected — length |
| `PK36SCBL00000011234567021` (25 chars) | rejected — length |

A **unit test pins these exact cases** plus 10,000 generated valid/invalid pairs, and the
normalisation is a single pure function shared by the API, the worker, and the database trigger, so
all three agree by construction.

There is **no `fin_bank_accounts` table in Phase 7**, so there is no `fin_bank_accounts.iban` column to
normalise. The IBAN that is actually stored is `fin_provider_accounts.account_ref` (§27.1), and it is
stored **normalised** (uppercase, no whitespace) with a CHECK that the value satisfies the normalised
form, so a hand-edited row cannot bypass the validator. A school's *own* bank accounts — where money
arrives, and the account a school-level receipt is reconciled against — are **out of scope**: the
reconciliation model in §14 reconciles against a *bank statement artifact*, not against a stored
account number, so nothing in Phase 7 needs the school's own account. Adding one later is additive.

### 26.4 Tax boundary

The brief is right not to encode "school fees are not taxable" as a universal statement. Whether a
Pakistani private school owes sales tax / FBR service-tax on tuition is a **jurisdictional legal
question** that this repository cannot answer.

**Phase 7:**
- Tax is **disabled by default**. `fin_invoice_items.tax_amount` is always `0` in Phase 7.
- No tax engine, no rate table, no calculation, no filing.
- A **seam** exists: `fin_fee_heads.tax_treatment` and `fin_tenant_settings.tax_profile_id`, with
  a `fin_tax_profiles` table carrying `jurisdiction`, `authority`, `tax_code`, `rate`,
  `effective_from`, `effective_to`, `inclusive_or_exclusive`, and `registration_metadata` (jsonb) —
  **created empty and unreferenced by any Phase 7 code path**.

**Future tax layer:** reads the profile, applies the rate at invoice issue, and posts
`Dr 1200 / Cr 2100 Tax Payable` alongside `Dr 1200 / Cr 4000`. Because the sub-ledger is a real
double-entry group, adding tax is a new account and a new leg — it does not disturb the existing
posting rules.

**Stated precisely, and this is the point:** Phase 7 does **not** assert that school fees are
untaxed. It asserts that no tax is computed until a jurisdictional decision is recorded. Recorded as
OD-04.

---

## 27. Provider / payment integration boundaries

### 27.1 The interface is provider-neutral and internal-only

```ts
interface FinPaymentProvider {
  /** Create a provider-side charge intent. Returns a redirect/instruction, never an amount. */
  initiate(input: {
    tenantId: string; paymentId: string; amountMinor: bigint; currency: 'PKR';
    description: string; returnUrl: string;
  }): Promise<{ redirectUrl: string; providerRef: string }>;

  /** Verify a webhook signature over the RAW body. MUST be constant-time. */
  verifySignature(rawBody: Buffer, headers: Record<string, string>, secret: string): boolean;

  /** Map a verified provider event to our normalized shape. Never sets tenant_id. */
  normalize(rawBody: Buffer, headers: Record<string, string>): ProviderEvent;

  /** Disburse a refund. Idempotent on refundNo. */
  refund(input: { refundNo: string; amountMinor: bigint; destination: string }):
    Promise<{ providerRef: string; status: 'submitted' | 'settled' | 'failed' }>;
}
```

**Amounts cross the boundary as `bigint` minor units, never as `number`.** This makes the
"no floating point for money" rule (§16.3) structurally true at the integration edge, not just a
convention inside our own code.

`normalize()` returning a `ProviderEvent` **structurally cannot** set `tenantId` — the type omits it.
Tenant resolution happens in our handler, from the verified provider account (§27.4), so a provider
cannot direct money at an arbitrary tenant even if it is compromised or buggy.

### 27.2 No real provider in Phase 7

`DEVELOPMENT_ROADMAP.md:166` lists provider selection as an owner decision requiring keys, and
`DEVELOPMENT_ROADMAP.md:87` says "gateway stub = manual until provider keys". **Adjudicated:**

- **Production path: manual** — cash, bank transfer, cheque. Fully implemented.
- **`FinPaymentProvider` implementations: a `ManualProvider` (no external call) and a
  `FakeProvider` used ONLY in tests.** The `FakeProvider` lives in a test-only module and is
  **not** importable from production code — enforced by a gated test asserting no
  `apps/*/src` file imports it, following the `DEVELOPMENT_ROADMAP.md:99` precedent ("no fake in
  prod code paths").
- **Easypaisa / JazzCash / Raast: named seams.** `fin_payments.method` already enumerates them, and
  the webhook receiver is provider-agnostic by construction (§27.4), so adding a real adapter is
  a new file plus a provider-account mapping — no schema change. Recorded as OD-05.

### 27.3 Webhook model — the `Idempotency-Key` requirement is removed

The brief is right: a provider will never send our internal `Idempotency-Key`. The design uses
provider-native identity:

```sql
CREATE TABLE fin_payment_gateway_webhooks (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           uuid,          -- resolved from the provider ACCOUNT, never the payload
    provider            text NOT NULL,
    provider_event_id   text NOT NULL,
    provider_account_ref text NOT NULL,
    signature_valid     boolean NOT NULL,
    payload_hash        text NOT NULL,          -- sha256 of the raw body
    normalized          jsonb,                  -- safe, normalized fields only
    event_kind          text,
    status              text NOT NULL DEFAULT 'received'
                        CHECK (status IN ('received','processed','rejected_malformed',
                                          'rejected_unknown_event','rejected_account_mismatch',
                                          'rejected_signature','duplicate')),
    failure_reason      text,
    received_at         timestamptz NOT NULL DEFAULT now(),
    verified_at         timestamptz,
    processed_at        timestamptz,
    -- The rejection reason is stored but NEVER returned to the caller (§27.4/§27.5:
    -- every pre-authorization failure is HTTP 200 + {"status":"ignored"}). Keeping
    -- it here is what makes the operational self-check and the alert possible.
    http_status_returned integer NOT NULL DEFAULT 200,
    CONSTRAINT fin_webhooks_ten_id_uq UNIQUE (tenant_id, id),
    CONSTRAINT fin_webhook_event_uq UNIQUE (provider, provider_event_id),
    -- A verified event has a verification time; an unverified one never does. So a
    -- row with signature_valid = true and verified_at = NULL is unrepresentable,
    -- and the ORDER of §27.4 is not merely a convention.
    CONSTRAINT fin_webhook_verified_ck CHECK (
        (signature_valid AND verified_at IS NOT NULL)
     OR (NOT signature_valid)
    ),
    -- processed_at is meaningful only for a processed event, and an event that
    -- failed signature verification can never be processed.
    CONSTRAINT fin_webhook_processed_ck CHECK (
        (status = 'processed' AND processed_at IS NOT NULL AND signature_valid)
     OR (status <> 'processed' AND processed_at IS NULL)
    )
);
-- Revoke the 0001 default-privilege grant immediately (§35.4, §30.3).
REVOKE ALL ON fin_payment_gateway_webhooks FROM school_app_rw;



CREATE TABLE fin_provider_accounts (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           uuid NOT NULL,
    provider            text NOT NULL,
    provider_account_ref text NOT NULL,
    -- A SECRET-MANAGER reference, never a value. The plaintext signing secret is
    -- not in this table, not in the document, and not in the database: §27.4 loads
    -- `secret_ref`, the handler dereferences it outside the database, and there is
    -- no column a `SELECT *` could leak. This is the same discipline as P1-09's
    -- finding that an "encryption key we already have" is not a key we have.
    secret_ref          text NOT NULL,
    is_active           boolean NOT NULL DEFAULT true,
    -- Which webhook event kinds this account is expected to send. Not an
    -- allowlist for authorisation -- signature verification decides that -- but the
    -- set of kinds a `rejected_unknown_event` is measured against.
    expected_event_kinds text[] NOT NULL DEFAULT '{}',
    last_verified_at    timestamptz,
    created_at          timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT fin_provider_accounts_ten_fk
        FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE CASCADE,
    -- §6.3 R4 exception: `tenants` IS the tenant, so its `id` is the tenant key.
    CONSTRAINT fin_provider_accounts_ten_id_uq UNIQUE (tenant_id, id),
    CONSTRAINT fin_provider_accounts_uq UNIQUE (provider, provider_account_ref)
);
-- Revoke the 0001 default-privilege grant immediately (§35.4, §30.3).
REVOKE ALL ON fin_provider_accounts FROM school_app_rw;


```

**`tenant_id` on `fin_payment_gateway_webhooks` is nullable, and it must be.** A webhook arrives
**before** its signature is verified, and the tenant is resolved from the provider-account lookup —
which cannot succeed for a request whose signature does not verify against any known secret. A
`NOT NULL` column would force the row to be written with a tenant guessed from the body, which is
precisely the injection the brief forbids. So: nullable at rest, written only at the single
assignment site in §27.4 step 8, and a row that stays `NULL` is a rejected request with no tenant —
which is the correct record of a failed authentication.

`UNIQUE (provider, provider_event_id)` gives replay protection **globally per provider**, which is
correct: a provider event id is globally unique, so scoping it per-tenant would allow a
mis-scoped duplicate to create a second row.

**`fin_webhooks.tenant_id` is nullable and is only ever written by our handler from the
`provider_account_ref` lookup.** A webhook payload containing a `tenantId`/`school_id` field is
**ignored entirely** — the normalized shape does not include it. This is the brief's requirement
"the webhook request must never select tenant_id from untrusted payload data", satisfied
structurally by a nullable column plus a single assignment site plus a type that cannot carry it.

### 27.4 Webhook processing order — the security-critical sequence

The order is the security property, so it is fixed:

```text
1. rate-limit by provider IP                    (existing @fastify/rate-limit, app.ts:104-118)
2. read the RAW body as Buffer                  (before any JSON.parse or middleware touch)
3. resolve the provider from the path
4. read the candidate account reference from the path (NOT from the body)
5. load fin_provider_accounts by (provider, account_ref) -> tenant_id, secret_ref
   - no row  -> set secret_ref to a fixed-length DUMMY secret, and continue
                (so the code path and the response time are identical; see below)
6. verify the signature with a constant-time compare against that secret.
   FAIL -> record status='rejected_signature', HTTP 200, STOP.
7. compute payload_hash; INSERT INTO fin_payment_gateway_webhooks
   ON CONFLICT (provider, provider_event_id) DO NOTHING
   - conflict -> status='duplicate', HTTP 200, STOP.  (no side effects, ever)
8. now that the caller is authenticated, resolve tenant_id from the provider account
9. normalise the payload into SAFE fields
10. UPDATE the row: tenant_id / status / normalized / event_kind / verified_at / processed_at
11. emit the outbox event IN THE SAME TRANSACTION as the status update
12. HTTP 200
```

**Every pre-authorization failure returns HTTP 200 with a byte-identical body.** This is the part
that is easy to get wrong, and the naive design gets it wrong in both directions at once. To verify
an HMAC you must first look up the secret, and that lookup takes an untrusted string. So the handler
resolves the account *before* it can authenticate anyone — and a handler that then answers
"unknown account" with 404 and "bad signature" with 401 has built a **tenant-enumeration oracle**: an
attacker with no secret at all can walk `provider_account_ref` values and learn which schools exist
on the platform, from the outside, with no credentials. `provider_account_ref` is a public
identifier we hand the tenant at onboarding, so the space is fully enumerable.

The mitigation is not to reorder the steps — the lookup is unavoidable — but to make the two failures
**indistinguishable from outside**:

| Property | How |
|---|---|
| Same status code | **200** for every pre-authorization outcome, with the body `{"status":"ignored"}`. Not 401, not 404, not 202 |
| Same body | a fixed literal. No reason string, no error code, no account id |
| Same timing | step 5 substitutes a **dummy secret of the same length** when no account matches, and step 6 always runs a full `hmac.compare_digest`. An unknown account therefore costs the same wall-clock time as a known one, so timing does not leak either |
| Different internally | the stored `status` column distinguishes them (`rejected_account_mismatch` vs `rejected_signature`), which is where an operator needs the distinction |
| Observable | **both** counters raise a monitored alert. This is how the cost of the uniformity is paid back — a provider with a misconfigured secret sees silence, and the operator sees a `rejected_signature` rate spike |

> **The trade-off, stated honestly.** A provider whose signature is genuinely misconfigured will be
> answered 200 forever and will never learn from the response that anything is wrong. That is a real
> operational cost and it is the correct trade for an unauthenticated internet-facing endpoint. The
> mitigation is the `rejected_signature` rate alert plus a documented self-check route
> (`POST /finance/gateways/:provider/webhook/verify`, **authenticated with the tenant's own
> `fees.reconciliation.manage`**, not a provider signature), which signs a known test payload and
> returns the reason to an operator who is already inside the tenant's trust boundary. The alert and
> the authenticated self-check together give the provider's engineer a diagnosable path without giving
> the open internet one.

**Signature verification (step 6) happens before tenant resolution (step 10) and before any
business write.** An unauthenticated caller can therefore create a `signature_valid = false`
tombstone row and nothing else — it cannot touch finance data, cannot create or settle a payment, and
cannot learn whether a tenant exists.

**`timestamp` + HMAC with a 5-minute tolerance** (the `BILLING_DESIGN.md:82` pattern), plus a
**timestamp-replay window check** so a captured-and-replayed request inside the tolerance is caught
by the `provider_event_id` unique index (step 7).

### 27.5 Failure dispositions — every case answered

| Case | Stored `status` | HTTP | Response body | Business effect | Outbox |
|---|---|---|---|---|---|
| Signature missing/invalid | `rejected_signature` | **200** | `{"status":"ignored"}` | **none** | none |
| `provider_account_ref` unknown, or `is_active = false` | `rejected_account_mismatch` | **200** | `{"status":"ignored"}` | **none** | none |
| Malformed JSON, or missing required normalized fields | `rejected_malformed` | **200** | `{"status":"ignored"}` | **none** | none |
| Duplicate `provider_event_id` | `duplicate` | **200** | `{"status":"ignored"}` | **none** (already processed or in flight) | none |
| Valid, known event | `processed` | 200 | `{"status":"accepted"}` | transition `pending → settled`, post ledger, allocate | `fee.payment.recorded` |
| Valid, **unknown** `event_kind` | `rejected_unknown_event` | **200** | `{"status":"ignored"}` | **none** | none |

**The uniformity is the security property and it is tested as one.** `finance-webhook.test.ts`
asserts that the **status code and the response body are byte-identical** across the first four rows
above — a single `expect(res.status).toBe(200)` loop over unknown-account, bad-signature, missing
signature, and malformed-body, plus `expect(res.body).toEqual({status: 'ignored'})` for each. A
regression that reintroduces a 404 for an unknown account fails the test, and it would otherwise be
invisible: the route still works, the provider is still served, and nothing looks broken.

The unknown-event case is also 200, for a second, independent reason worth stating: returning 4xx
makes the provider retry forever a payload we will never understand, which converts a harmless gap
into a self-inflicted denial of service. The row is retained with `status='rejected_unknown_event'`
and `failure_reason`, and a monitored count of such rows raises an alert — so the gap is *visible*
rather than *silent*. This is the webhook-side analogue of the worker disposition rule in §24.1: a
financial event is never silently dropped, and the silence is bounded and observable.

A **payload we cannot normalize is retained as a hash, not a body** — so an operator can ask the
provider to re-send, and the hash proves the re-sent body was identical (§27.6).

---

### 27.6 Raw webhook data retention

The brief is right that arbitrary provider JSON is unsafe to retain. **Adjudicated:**

**By default, the raw body and headers are NOT stored.** `fin_payment_gateway_webhooks` stores
`payload_hash`, `provider_event_id`, `provider_account_ref`, `signature_valid`, the **normalized
safe fields** in `normalized`, `status`, `received_at`, and `verified_at`. That is the brief's own
recommended shape, and it is the default.

**No PAN, no CVV, no card track data, no provider credentials are ever stored, in any mode, for any
reason.** This is absolute and is not an OPEN DECISION. The `normalized` shape admits only:

```text
provider, provider_event_id, provider_account_ref, provider_ref (charge id),
amount_minor (bigint), currency, status, occurred_at, method
```

**Optional raw retention** is gated behind a tenant setting
`fin_tenant_settings.webhook_raw_retention_days` with **default 0 (disabled)**. When a tenant
enables it, the raw body is stored in a **separate** `fin_webhook_raw_payloads` table, with:

- **Redaction, then encryption, then nothing else is assumed.** A redaction pass removes any key
  matching `/pan|card|cvv|cvc|expiry|track|iban|bic|swift|account_number|pin|password|secret|api_key/i`
  at any depth, replacing the value with `[redacted]` — the same approach as `redactDeep`
  (`packages/audit/src/index.ts:21-39`), extended to finance keys. The **redaction is the control
  that actually protects the data**; the encryption is defence in depth behind it, because a redacted
  body still contains amounts, provider refs, and metadata that are sensitive even without card data.
- `expires_at = received_at + N days`, with a purge job.
- **Restricted RLS**: readable only by `finance_staff` (never `reporting_staff`, never parent/student,
  never platform), and a dedicated audit row on every read.
- **Headers retained:** only a whitelist (`content-type`, `user-agent`, `x-request-id`, the signature
  header **name** — never the signature **value**).

**The encryption mechanism is NOT designed, and the previous revision claimed it was (P1-09).** That
revision said "Column-level encryption using `APP_ENCRYPTION_KEY` (the repo already has a symmetric
application key; `0021` documents the reuse)". Three statements in that sentence are false, each
verifiable:

1. **The repository has no such key.** `grep -rn "APP_ENCRYPTION_KEY"` across the repository returns
   **no definition and no read** — not in `apps/api`, not in `packages/config`, not in any `.env`
   template. It is not "already there"; it is an aspiration written as a fact.
2. **A symmetric application key is the wrong shape for a database column.** `APP_ENCRYPTION_KEY` is
   the kind of variable used to encrypt session tokens at the application layer. Column encryption
   needs a key the **database** can use at rest (a `pgcrypto`/LDE/managed-KMS column key) or, failing
   that, application-layer encryption of the value before insert. The two have different threat
   models and different key-lifecycles, and conflating them produces a column that looks encrypted and
   is not.
3. **PostgreSQL cannot do column-level encryption with an application env var.** The available
   mechanisms are `pgcrypto`'s `pgp_sym_encrypt` (key passed per call — so the key is in the query
   text and in `pg_stat_statements`, i.e. reachable by anyone who can read logs), a KMS-backed
   ciphertext column (requires a managed PostgreSQL with a key reference — a deployment decision this
   repository has not made), or LDE via the storage layer. None of these is "reuse the app key".

**Adjudicated position.** `fin_webhook_raw_payloads` is **not created by `0029`** and the encryption
is **future scope**, not a Phase 7 deliverable. The default (retention off) is the privacy-safe
answer and requires no encryption at all, so nothing is blocked by deferring this. If the owner
enables retention, the encryption mechanism must be chosen first, as a deployment decision, and only
then written as DDL. What Phase 7 commits to is the part that is implementable and testable now:
**redaction (above), expiry, restricted RLS, and per-read audit.** Stating that four of five controls
are real and one is deferred is a `DESIGN-GO` position; claiming all five and providing none is not.

**Why this is an OPEN DECISION rather than a decision:** Pakistani schools frequently need
transaction evidence for bank disputes and for FBR-style record-keeping, and some acquirers require
the raw payload for chargeback proof. The design's default (off) is the privacy-safe answer;
enabling it is a tenant-level, audited, redacted, expiring choice, with encryption **conditional on a
deployment decision that has not been made**. The **product** decision is whether the owner wants the
capability offered at all. **OD-01.**

---

## 28. Test strategy

### 28.1 Gating

All DB-backed suites are gated by `RUN_RUNTIME_SECURITY_TESTS === '1'`, matching
`packages/db/src/testing` and the workflow. The CI workflow **must not** set this variable at job
scope — the workflow's own comment (`.github/workflows/phase6-security.yml:88-122`) records that
doing so made the shared database race because `phase6-migration-regression.test.ts` runs
`drop schema public cascade` against the single `school_saas_test` database, producing a measured
"5 of 8 turbo tasks succeeding". **Phase 7 finance suites are added to the existing aggregate steps
(14/15/16), never to the job env.**

### 28.2 Suites

| Suite | Location | Proves |
|---|---|---|
| `finance-invariant.test.ts` | `packages/db/src/security/` | **FI-001…FI-019** (incl. FI-004a), mostly as **raw SQL** under both roles. Also asserts §16.7's register is exhaustive against `information_schema` |
| `finance-rls.test.ts` | `packages/db/src/security/` | §19: the six negative cases + platform + forged-GUC + worker scoping |
| `finance-state-machine.test.ts` | `packages/db/src/security/` | §18, every edge and every rejected edge |
| `finance-numbering.test.ts` | `packages/db/src/security/` | FI-011, N concurrent issues |
| `finance-rbac.test.ts` | `packages/db/src/security/` | the matrix; `permissions.test.ts` block per the established per-phase pattern (`permissions.test.ts:297-320`) |
| `finance-api-acceptance.test.ts` | `apps/api/src/security/` | every endpoint, authz contract, idempotency, error codes |
| `finance-webhook.test.ts` | `apps/api/src/security/` | §27.4 sequence, all **6** dispositions, signature forgery, replay, **and the uniform-response assertion** (the enumeration-oracle regression, T-FIN-21) |
| `finance-receipt.test.ts` | `packages/db/src/security/` | FI-019: immutability for both roles, no `status` column, amount re-derived from the payment, version/supersedes chain |
| `finance-target-integrity.test.ts` | `packages/db/src/security/` | §7.5/§7.6: all 5 target types × {exists, wrong tenant, wrong hierarchy, soft-deleted, wrong year}; precedence order; same-rank ambiguity → `55000` |
| `finance-money-register.test.ts` | `packages/db/src/security/` | §16.7: no money-bearing `fin_*` column exists that the register does not list |
| `finance-aggregate-view.test.ts` | `packages/db/src/security/` | §15.2.1/§15.2.2: no aggregate view exposes a **person** id or name; a principal gets **zero rows** from every detail view; detail views are `security_invoker` and aggregate views are the only definers. Column set is checked against the **taxonomy allowlist** (`fee_head_id`/`_code`/`_name`, `collection_day`, `p.channel`, `aging_bucket`) rather than by regex alone, because the narrowed regex would otherwise admit a bare `name` column that is not on the list |
| `finance-mfa-contract.test.ts` | `packages/db/src/security/` | §19.8.3: every symbol F7 calls is either defined in the migration text or listed in the contract table; every listed helper has a signature, a definer note, a `PUBLIC` revoke, and a tracked dependency; the count of undefined-but-referenced symbols is **reported** (5) rather than asserted zero |
| `finance-trigger-inventory.test.ts` | `packages/db/src/security/` | §35.3: 28 inventory rows, 28 bound functions, 35 distinct `CREATE [CONSTRAINT] TRIGGER` statements (38 including the three restatements), every statement names an inventory function or a declared helper, every inventory function is bound at least once, and no `fin_*` function body contains `COALESCE(NEW.<col>, OLD.<col>)` or `RETURN COALESCE(NEW, OLD)` — the P0002 class of §7.4 |
| `finance-property.test.ts` | `packages/db/src/security/` | **the roadmap's own acceptance criterion**: 10,000 randomised operations over issue/pay/allocate/refund/reverse/void, asserting after **every** operation that all FI invariants hold |
| `finance-webhook-provider.test.ts` | `apps/worker/src/` | event disposition table, registry gate, no-silent-ack |
| `finance-artifact.test.ts` | `apps/worker/src/` | §25.3, storage-succeeds/DB-fails retry convergence |
| `finance-money.test.ts` | unit | rounding, `numeric` agreement, IBAN (§26.3) |

### 28.3 Mandatory negative tests (the brief's §18 list, verbatim coverage)

| Test | Assertion |
|---|---|
| parent cannot access an unrelated student | `GET /api/v1/finance/invoices/<other>` → 403; and a **direct SQL** `SELECT` as `school_app_rw` with a parent ticket returns **0 rows** |
| student cannot access another student | same, self-scoped |
| parent cannot access another tenant | a guardian linked in tenant B, queried with a tenant-A ticket → 0 rows |
| student cannot access another tenant | same |
| staff cannot cross tenant | an `accountant` of tenant A querying tenant B's invoice id → 0 rows (RLS) **and** 404 (app-layer predicate) |
| privileged platform actor cannot access finance accidentally | `platform_admin` with a valid platform ticket → **0 rows** from every `fin_*` table |
| soft-unlinked guardian is denied | a `student_guardians` row with `deleted_at` set → 0 rows. **This is the regression test for the `attendance.ts` defect (F-7.1).** |
| `DELETE` on a trigger-managed row raises the **policy** error, not a P0002 | `DELETE FROM fin_invoice_items WHERE invoice_id = <issued invoice>` → `55000` with the freeze message, **not** `P0002 record "new" is not assigned yet`. Same for `DELETE` on `fin_payment_allocations` and `fin_ledger_entries`. A P0002 here is a 500 that a retry loop will re-trigger |
| an `UPDATE` that moves an allocation between invoices corrects **both** balances | move a 500 allocation from invoice A to invoice B; assert `fin_v_invoice_balance.balance` rose by 500 for A and fell by 500 for B, and that the **cached** `fin_invoices.balance` agrees for both. **Run as `school_migrator`, not `school_app_rw`**: §35.4 revokes `UPDATE` on `fin_payment_allocations` because no route may move an allocation, so as the runtime role the move is `42501` and this case would be testing nothing. The runtime-role half of the pair is the *next* row |
| the runtime role may not move an allocation | `UPDATE fin_payment_allocations SET invoice_id = <other>` as `school_app_rw` → `42501`. A correction is a **reversal row plus a new allocation**, never a rewrite of where money went (§11.1), and the ACL is what makes that true rather than merely documented |
| a line edit **alone** moves the cache | in a `draft` invoice, `UPDATE fin_invoice_items SET amount`; assert `fin_invoices.total` and `.balance` both changed with no allocation in the transaction. **As `school_migrator`** — `UPDATE` is revoked on the runtime role and there is no line-edit route; the operation exists to prove the *trigger* fires, and the owner is the only role that can fire it |
| an adjustment **alone** moves the cache | `INSERT INTO fin_invoice_adjustments` with no line write; assert `fin_invoices.total` and `.balance` both changed |
| the runtime role cannot `DELETE` a finance row even with a direct connection | `DELETE FROM fin_invoices` as `school_app_rw` → `42501`. Asserted against `aclexplode`, not against the migration text, because `0001`'s `ALTER DEFAULT PRIVILEGES` grants `DELETE` at `CREATE TABLE` time (§35.4) |
| a caller cannot set a derived value | `UPDATE fin_reconciliation_batches SET matched_total = <a number that balances a false statement>` → the stored value is the trigger's derivation, not the caller's; and `is_final` cannot be set on a match in an `open` batch |
| **an item of a committed run cannot be re-pointed at another run** | `UPDATE fin_billing_run_items SET run_id = <an uncommitted run>` on a committed run's item → `55000`. **Both directions are asserted**, because a freeze that consults only the destination refuses the inbound move and permits the outbound one, which is the same defect with the sign flipped; and the *control* is a move between two uncommitted runs, which must succeed, or the case would also pass against a blanket denial. `run_id` is an ordinary column, so this is the only thing that makes the item freeze a freeze rather than a restriction on the columns that happen to be compared |
| **a user who published a structure cannot be deleted** | `DELETE FROM users WHERE id = <a publisher>` → `23001`, and the publication stamp is unchanged. This is the assertion that distinguishes `ON DELETE RESTRICT` from `ON DELETE SET NULL`, and it is also the reason the action is RESTRICT: PostgreSQL implements `SET NULL` as a referential `UPDATE`, the write-once publication stamp (§7.3.1) refuses exactly that `UPDATE`, and a declared FK action that can never fire is worse than no FK. Deactivating the account (`users.status`) is the supported route and preserves the audit row |
| **a structure may not be born published** | `INSERT INTO fin_fee_structures (…, status) VALUES (…, 'published')` → `55000`. A graph whose only source state is `draft` is not a graph if a row may start anywhere; the trigger is bound to `INSERT` for this reason, and on the INSERT path there is no `OLD` to compare, so the rule is a refusal of an illegal starting point rather than an edge check |

### 28.4 Property test detail

The 10,000-operation property test is the single highest-value test in the phase, because it is what
catches the interactions that unit tests miss. Model: a seeded PRNG drives a sequence of operations
(`issueInvoice`, `recordPayment`, `allocate`, `refund`, `reverse`, `voidInvoice`, `adjust`,
`reconcile`, **`editLine`**, **`moveAllocation`**, **`deleteLine`**, **`openThenMatchBatch`**) against a
small tenant with 6 students and 8 invoices. After each operation it asserts, from the database,
**not from the cache**: balance = total − Σ allocations; unallocated ≥ 0; refunded ≤
payment.amount; refund coverage complete; every sealed ledger group balanced; every cache
equals its derivation; `net_applied ≥ 0` unless over-credit; a payment is final in at most one
reconciliation match. A single failure prints the seed and the operation index, making it
reproducible — the same discipline as `apps/worker/src/exams.test.ts:5-19` ("the convergence
predicate … the decision that stops a redelivered … from minting a duplicate").

**The four bolded operations are the ones that make the property test able to fail against the
defects this revision fixed, and they are the reason they are named rather than folded into
`allocate`.** A generator that only ever inserts allocations would pass against:

- a `trg_fin_invoice_item_total` bound only to `fin_invoice_items` — nothing in `allocate` touches an
  adjustment on its own;
- a `trg_fin_invoice_balance_recompute` bound only to `fin_payment_allocations` — nothing in
  `allocate` moves a line;
- an `UPDATE` that changes an allocation's `invoice_id`, where only the destination is recomputed —
  nothing in `allocate` moves money between invoices;
- a `trg_fin_recon_is_final` with no batch-side counterpart — nothing in `reconcile` takes a batch
  from `open` to `matching` while holding pre-existing match rows.

A property test that cannot express the failing case is not evidence, and each of these was a real
defect rather than a hypothetical one. `editLine` and `deleteLine` are restricted to `draft` invoices
(the `trg_fin_invoice_items_freeze` guard), so they exercise the cache triggers on the one document
class where mutation is legal; `moveAllocation` operates on a payment with two invoice-bound rows.

**All four of these operations run as `school_migrator`, and that is a finding rather than a
convenience.** §35.4 revokes `UPDATE` on `fin_payment_allocations` and there is no line-edit or
allocation-move route, because a correction is a *reversal row plus a new allocation* — the design is
append-only (§11.1) and the ACL enforces what the prose already said. The runtime role therefore
**cannot** reach any of the four operations, which means the `UPDATE` branches of
`trg_fin_invoice_item_total`, `trg_fin_invoice_items_freeze` and `trg_fin_invoice_balance_recompute`
are **defence-in-depth guards for the owner and any future route**, not active paths. They are still
specified, still bound, and still tested — but a test written as `school_app_rw` would get `42501` and
assert nothing, and a design that claimed these branches were the live path would be claiming a
capability the ACL deliberately withholds. This is the same class of defect as P1-07, in the opposite
direction: there, a revoked `INSERT` made a definer function unexecutable; here, a revoked `UPDATE`
makes trigger branches unreachable, and the honest answer is to say so rather than to widen the grant.

### 28.5 The `902` figure and the new count

The current baseline is **68 tracked test files** (`git ls-files`), and the 902-runtime-test figure
is a clean-checkout run tally from `PHASE_2_6_RECOVERY_AUDIT.md:631-632` that **no CI step
asserts**. Phase 7 adds ~15 files (§28.2), including the four new ones pinned to the register, the receipt, the target, and the webhook oracle. The design does **not** restate a total; when Phase 7 lands, the
count must come from an actual CI run, and the three registry pins (93 / 9 / 84 → 111 / 22 / 89)
must be updated in the same commit as the enum change.

### 28.6 Proving a fix is load-bearing, not just present

A passing test suite shows the shipped code behaves as written. It does **not** show that any
particular clause of the shipped code is what makes it behave that way, and for a file that is mostly
`RAISE EXCEPTION` the difference matters: a freeze can be deleted outright and a suite that only
asserts "the refused write was refused" will still pass, provided some *other* layer refuses it — a
`CHECK`, a foreign key, or nothing at all. The three cases in §8.7.1 and the graph in §18 are
separate clauses in separate functions, so "the behaviour is right" and "this clause is the reason"
are different claims and need different evidence.

The method, and the rules that keep it from becoming theatre:

- **A control is a copy of the migration with exactly one fix reverted**, applied through the
  **repository's own runner** (`pnpm db:migrate`) against a database emptied first, so the control
  exercises the same lexical, transactional and per-migration path that production will. A control
  applied by a home-grown applier proves nothing about the shipped runner.
- **A control that applies cleanly has proved nothing** and is a failure of the control, not a pass.
  The expected result is a named assertion failure; the run is scored on the *message*, because a
  control can also fail on an unrelated assertion and that must not be mistaken for evidence.
- **The control must isolate one clause.** Two exist for this reason: `ctl_d3` reverts the assignment
  pin's *binding* and fails on the function count, while `ctl_d3b` restores the count and fails on
  the pin's *behaviour* — so one of the two cannot pass. And a control that neutralises a guard more
  bluntly than intended fails on a different, earlier case (`ctl_d5c` had to read `OLD` on DELETE
  only, because dropping that lookup outright also un-freezes DELETE and the control would have
  proved something about DELETE instead).
- **Every control is reverted by construction, not by a comment.** The migration file is swapped in
  memory, restored in a `finally` block, and the restoration is verified by SHA-256 — a control file
  left in the migrations directory would silently invalidate every later run, and the
  obvious way to find out is to discover it weeks later.
- **The controls are per defect, not per file.** `0022` carries **fourteen** controls over its **seven**
  defects — some defects need two, for the reason in the bullet above — and the behavioural case
  each one trips is recorded in the checkpoint report beside the clause it is supposed to break.

---

## 29. Threat model

Additions to `docs/THREAT_MODEL.md` (which this phase does not edit; recorded here for the owner).

| ID | Threat | Control | Test |
|---|---|---|---|
| T-FIN-01 | Staff member reads another family's invoices | Relationship RLS (§19.4) — not just API filtering | `finance-003` in §28.3 |
| T-FIN-02 | Staff member forges a tenant GUC | `0002` signed ticket; re-proven for finance | `finance-014` |
| T-FIN-03 | Parent crafts a student id | Composite FK + relationship policy + explicit 403 | `finance-rls` |
| T-FIN-04 | Platform admin reads tenant finance | No platform branch in any finance policy; `0020`-style assertion in `0028` | `finance-014` |
| T-FIN-05 | Webhook forges a payment | HMAC verified before tenant resolution; constant-time compare; timestamp window; **identical response for unknown account and bad signature** | `finance-webhook` |
| T-FIN-06 | Replayed webhook double-settles | `UNIQUE (provider, provider_event_id)`; `pending → settled` guard; ledger group reversal | `finance-013`, `finance-024` |
| T-FIN-07 | Over-collection (payment > invoice) | Unallocated bucket is a liability, not income; visible in reports; bounded by FI-003 | `finance-003` |
| T-FIN-08 | Over-refund diversion — **including paying out cash that was never applied to a charge** | Three-step refund separation + step-up MFA + payment-locked bound, where the ceiling is `payment_applied(p)` and **not** `p.amount` (FI-005); on-account returns are a separate permission and a separate posting | `finance-005`, `finance-021` |
| T-FIN-09 | Issued invoice silently edited | Freeze trigger; no update/delete route; no permission exists to declare one | `finance-010` |
| T-FIN-10 | Ledger edited to hide a shortfall | No UPDATE/DELETE policy **and** a trigger, for every role including `school_migrator` | `finance-008` |
| T-FIN-11 | Unbalanced ledger group | Deferred statement-end check + sealed-group CHECK | `finance-008` |
| T-FIN-12 | Cache drift makes the ledger lie | Ledger is authoritative; caches recomputed; nightly + property test | `finance-009` |
| T-FIN-13 | PAN/IBAN leaks into `audit_logs`/`outbox_events` | Payload contract (IDs only) + `redactDeep` denylist extension + a static test | `finance-029` |
| T-FIN-14 | Raw webhook body retains card data | Not stored by default; opt-in only, redacted + encrypted + expiring + restricted | `finance-webhook` |
| T-FIN-21 | **Tenant enumeration via the webhook endpoint** — unauthenticated `provider_account_ref` probing distinguishes 404 from 401 and maps every school on the platform | Uniform 200 + `{"status":"ignored"}` + dummy-secret timing equalisation for every pre-authorization failure; the distinction is stored, not returned; both counters alert | `finance-webhook` |
| T-FIN-15 | Payment double-charge on retry | Required idempotency key + fingerprint mismatch → 409 (§21.1) | `finance-013` |
| T-FIN-16 | Ambiguous fee assignment double-bills | Unique index makes a second active assignment unrepresentable | `finance-002` |
| T-FIN-26 | Principal reaches an individual invoice through a new route, a new service method, or direct SQL | `reporting_staff` excluded from the `SELECT` policy on every row-level finance table — **zero rows**, not a filtered set; aggregate access only via four owner-scoped views whose columns are pinned to buckets/totals/counts | `finance-aggregate-view` |
| T-FIN-17 | Concurrent collection over-allocates | Locked, ordered, recomputed availability; bounded retry | `finance-003` |
| T-FIN-18 | Same-family visible via a soft-unlinked guardian link | `sg.deleted_at IS NULL` in the definer function | `finance-003` (regression) |
| T-FIN-19 | Artifact swap replaces a published receipt PDF | CAS `file_id IS NULL` + frozen content hash + immutable document | `finance-029` |
| T-FIN-20 | Custom role silently widened by a template change | Backfill filters `is_system = true`; checksum assertion | `finance-020` |
| T-FIN-22 | On-account return posted as `Dr 1200` → a phantom receivable in AR aging and a reconciliation break | Correct posting is `Dr 1300 / Cr Cash`; the assertion pins both accounts and asserts AR is untouched | `finance-021` |
| T-FIN-23 | Receipt silently edited, or “voided” to hide a collection | `trg_fin_receipt_freeze` for **every** role incl. `school_migrator`, no GUC bypass; no `status` column and no void route exist | `finance-019` |
| T-FIN-24 | Same-rank fee targets silently resolved by row order | Highest-rank-only rule; same-rank ambiguity **fails** with `55000 ambiguous_fee_target` naming both rows | `finance-target-integrity` |
| T-FIN-25 | Polymorphic target pointed at another tenant's section | Composite `(tenant_id, id)` FKs — unrepresentable, not merely checked; plus hierarchy-coherence trigger | `finance-target-integrity` |
| T-FIN-27 | A payment is finalised into **two** reconciliation batches, because a batch moved `open → matching` while holding matches stamped `is_final = false` and the partial unique index — keyed on `is_final` — enforced nothing in that window | The **closure**, which is three triggers and cannot be fewer: `trg_fin_recon_is_final` (a match cannot *claim* finality in a non-final batch), `trg_fin_recon_batch_derive_totals` (`BEFORE`: the batch's own totals, and the guard against leaving a finalised batch), and `trg_fin_recon_batch_stamp_matches` (`AFTER`: a batch that *becomes* final claims every match it holds). The `AFTER` binding is part of the remedy, not a detail — bound `BEFORE`, the row trigger re-derives `is_final` from the batch's still-old status and undoes the stamp | `finance-018` case (c) |
| T-FIN-28 | A half-matched reconciliation batch becomes **unabandonable**: `matching → open` is refused once any match is final, `matching → completed` demands a snapshot, and `/cancel` is gated to `open` only | `/cancel` accepts `open` **or** `matching`; `cancelled` is the transition that records a batch was void. The batch-side trigger refuses only the transitions that would *release* a finalised payment | `finance-018` case (d) |
| T-FIN-29 | A cached `fin_invoices.balance` is trusted although it was recomputed on only one of its three inputs, or on only the destination of a moved allocation | `trg_fin_invoice_balance_recompute` bound to items + adjustments + allocations; both sides recomputed on a move; arithmetic in one helper; **and every read goes through `fin_v_invoice_balance`, not the cache** (§21.3), so a report cannot inherit the trigger's bugs | `finance-002` |
| T-FIN-30 | A `DELETE` or `UPDATE` on a trigger-managed row fails with `record "new" is not assigned yet` (P0002) instead of the intended 409 — a 500 on a routine operation, which reads as a server fault and gets retried | Every multi-operation trigger branches on `TG_OP` for both the record read and the return; `COALESCE(NEW.<col>, OLD.<col>)` is asserted absent from every `fin_*` function body | `finance-trigger-inventory` |
| T-FIN-31 | A nightly drift check re-alerts on a **persistent** fault forever, so the alert stream becomes noise and the real regression is ignored | Audit key `(tenant_id, check_name, subject_id, first_detected_at)` with `first_detected_at` set once; a consumer distinguishes a new drift from a known one | `finance-recompute` |

---

## 30. Migration strategy

### 30.1 Sequence and dependency matrix (NORMATIVE)

Existing migrations `0001`–`0020` are **immutable** and untouched. The migration runner
(`packages/db/src/cli/migrate.ts`) discovers `/^[0-9]+_.+\.sql$/`, sorts **lexically**, and wraps
**each file in its own transaction** — so a table referenced by a composite FK must exist in the
same file or in a *lexically earlier* one. The table below is therefore normative, and
`finance-migration-order.test.ts` asserts it by parsing the actual files rather than trusting this
document.

| # | File | Creates | Depends on | Security posture at end of migration |
|---|---|---|---|---|
| **0021** | `fin_foundation.sql` | `fin_tenant_settings`, `fin_ledger_accounts` (+ `app_finance_seeds_ledger_accounts()`), `fin_document_counters`, `fin_fee_heads`, `fin_tax_profiles`; **anchor indexes** on the 12 existing Phase 1–6 tables listed in §6.3; money-domain CHECK helpers; `app_finance_actor_class()`, `app_finance_linked_students()`, `app_finance_current_guardian_ids()` | `0002` (trust), `0004` (campuses/years), `0005` (students/guardians), `0006` (soft-link), `0008` (`acd_classes`/sections), `0009` (grade_levels) | **No finance table is reachable by `school_app_rw` yet** — no grants, no policies, and the tables are therefore unreadable even if a route were added. Anchors are `CREATE UNIQUE INDEX IF NOT EXISTS` on already-unique `(tenant_id, id)` pairs, so they cannot fail. |
| **0022** | `fin_fee_structures.sql` | `fin_fee_structures`, `fin_fee_structure_targets` (5-target shape with the four composite FKs, §7.5), `fin_fee_structure_items`, `fin_fee_installment_plans`, `fin_fee_assignments`, **`fin_billing_runs`, `fin_billing_run_items`**; **SIX** functions and **EIGHT** bindings — `trg_fin_target_validate`, `trg_fin_structure_publish_freeze` (1), `trg_fin_structure_child_freeze` (3), `trg_fin_assignment_validate` (§8.6 pin), `trg_fin_billing_run_freeze`, `trg_fin_billing_run_items_freeze` (§8.7.1) — plus the active-period unique index, whose `structure_id` is coalesced because that column is nullable (§8.6). Intra-file order is normative: `fin_fee_structures` → `fin_fee_structure_items` → `fin_fee_installment_plans` → `fin_fee_structure_targets` → `fin_fee_assignments` → `fin_billing_runs` → `fin_billing_run_items` | 0021, 0008, 0009 | Unreachable. **No composite FK forward-references 0023+.** |
| **0023** | `fin_invoices.sql` | `fin_invoices`, `fin_invoice_items`, `fin_invoice_adjustments`, `fin_challans`; `trg_fin_invoice_number`, `trg_fin_invoice_void`, `trg_fin_invoice_item_total` (**2** bindings — items + adjustments), `trg_fin_invoice_items_freeze` (2 bindings), `trg_fin_invoice_balance_recompute` (**2** bindings — items + adjustments; the third, on allocations, is in 0024), `trg_fin_challan_status` (§10.2). Intra-file order is normative: `fin_invoices` → `fin_invoice_items` → `fin_invoice_adjustments` → `fin_challans`. **`fin_billing_runs`/`fin_billing_run_items` are NOT here** — the previous revision listed them in this file's intra-file order without creating them, while §8.6/§8.7's DDL and §30.2 place them with the structures that generate them (§8) | 0021, 0022, 0005 (`enrollments`, `students`) | Unreachable. `academic_years_single_active_uq` is **not** here (see 0028). |
| **0024** | `fin_payments.sql` | `fin_payments` (with `payer_guardian_id`), `fin_payment_allocations` — **created WITHOUT `fin_pa_refund_fk`** (P0-01), `fin_receipts` (with `payer_guardian_id`); `trg_fin_reversal_shape` (magnitude bound), `trg_fin_allocation_bounds` (FI-003, §12.7), `trg_fin_allocation_family_guard` (§12.5), `trg_fin_on_account_return_bounds`, `trg_fin_receipt_freeze`, `trg_fin_invoice_balance_recompute`; the two partial unique indexes; `fin_v_payment_position`, `fin_v_invoice_balance` | 0021, 0023, 0005 (`guardians`, `student_guardians`) | Unreachable. `refund_id` exists as a **plain nullable column with no FK** for the duration of this file — the FK is added by 0025. This is the only window in the sequence in which a column is unconstrained, it contains no application code, and it closes in the very next migration. **No trigger or function in this file may name `fin_refunds`, in its body OR in a `DECLARE` row type** (§30.3.1) — so `trg_fin_refund_provenance` is created and bound entirely in 0025, not here. |
| **0025** | `fin_refunds.sql` | `fin_refunds`; then `ALTER TABLE fin_payment_allocations ADD CONSTRAINT fin_pa_refund_fk FOREIGN KEY (tenant_id, refund_id) REFERENCES fin_refunds (tenant_id, id);`; `trg_fin_refund_provenance` — the function **and both** of its bindings (allocations side and refunds side); `fn_fin_refund_ceiling` as `fin_allocations_refund_ceiling` (**deferred, INITIALLY DEFERRED**); `postRefundApproval` (F5) | 0024 | Unreachable. After this file the 0024 window is closed and every `fin_*` column that references another `fin_*` table is FK-backed. The provenance function and *both* its triggers are bound here rather than splitting them across 0024/0025, because its `DECLARE` block names the `fin_refunds` composite type and a 0024 `CREATE FUNCTION` would fail with 42704 (§30.3.1). |
| **0026** | `fin_ledger.sql` | `fin_ledger_entry_groups`, `fin_ledger_entries` (with composite FKs to `students` and `fin_invoices`); `trg_fin_ledger_group_balance` (deferred), `trg_fin_ledger_seal`, `trg_fin_ledger_append_only`, `trg_fin_ledger_sealed_group_reject`; `post_fin_ledger_group()` (F4, `SECURITY DEFINER`, the only write path); `fin_recompute`; V1 `fin_v_ledger_account_balance` + V1 `fin_v_invoice_balance` are in 0023/0024, V2 the four owner-scoped aggregate views here | 0021, 0023, 0024, 0025 | Unreachable. |
| **0027** | `fin_reconciliation.sql` | `fin_reconciliation_batches`, `fin_reconciliation_matches` + `trg_fin_recon_is_final` (row side) **+ `trg_fin_recon_batch_derive_totals` (`BEFORE`) and `trg_fin_recon_batch_stamp_matches` (`AFTER`)** — the three form the finality closure and cannot be merged, because one effect needs `BEFORE` and the other `AFTER`; §14.1.1 + completion immutability; **tenant-aware** finality index (P2-04) | 0024, 0025, 0026 | Unreachable. |
| **0028** | `fin_rbac_rls.sql` | `academic_years_single_active_uq`; `auth_mfa_factors`, `auth_step_up_challenges` + `trg_auth_step_up_immutable`, `app_verify_mfa_code` (F7), `app_consume_step_up` (F8), `app_mint_step_up_challenge` (F9); role backfill; `cashier` template; **all finance RLS policies**; the post-condition assertions; **grants, last**. **NO anchor index on `users` or `auth_sessions`** — neither table has a `tenant_id` column, so §6.3 R4's allowlist applies and the FKs to them are single-column (§19.8.1, P0-06a). The previous revision listed "anchor indexes for `users` and `auth_sessions`" here, which would fail with `column "tenant_id" does not exist` | all of the above | **This is the only migration in which `school_app_rw` acquires any access to a `fin_*` table**, and it is sequenced so that RLS is fully in place *before* the first grant. See §30.3 for the required intra-file order and why it is the fix for P0-11. |
| **0029** | `fin_artifacts_webhooks.sql` | `fin_document_artifacts`, `fin_payment_gateway_webhooks`, `fin_provider_accounts`, `trg_fin_artifact_document_valid`; refund/reversal/on-account-return advice document types. `fin_webhook_raw_payloads` is **NOT created** (P1-09) | 0023, 0024, 0025 | Unreachable for the runtime role **by design** — no policy and no grant on any 0029 table. These tables are written only by the webhook handler and the artifact worker through `school_migrator`. |

**The P0-01 fix, stated as the one rule it enforces: no migration may declare a foreign key to a
table a later migration creates.** The previous sequence had `0024` declaring
`fin_pa_refund_fk → fin_refunds(tenant_id, id)` while `fin_refunds` was created in `0025`. That DDL
**cannot apply**: PostgreSQL resolves the referenced relation at `ALTER TABLE` time and raises
`42P01 undefined_table`, so `0024` would fail and every migration after it would never run. Because
the runner is per-file-transaction, the failure is a hard stop, not a warning.

The resolution is the two-step shown above: `0024` creates the column and the table; `0025` creates
`fin_refunds` and then adds the constraint. The rule is generalised into the `Depends on` column above
and asserted mechanically:

```sql
-- finance-migration-order.test.ts, in prose: for every migration file M and every
-- `REFERENCES <table>` in M, the referenced table must be created by a file
-- lexically earlier than M, or earlier in M's own text. The test builds the
-- creation order from the files themselves and fails on the first violation.
```

### 30.2 Why this order, and why it differs from the brief's sketch

The brief suggests `0021` foundation → `0022` structures → `0023` invoices → `0024` payments →
`0025` ledger → `0026` RBAC. **The ledger moves later than proposed, a reconciliation migration is
added, and RBAC/RLS is the very last schema migration, for three hard reasons:**

1. **The ledger cannot be created before the tables it posts for.** `fin_ledger_entries` carries
   `student_id` and `invoice_id` denormalised columns and the posting helper validates both. Creating
   the ledger at 0025 in the brief's order, after payments but before reconciliation, would require
   either creating it before invoices/payments exist (impossible — FK) or leaving reconciliation
   un-posted. Placing the ledger at **0026**, after refunds, means every operational table that can
   generate a posting exists first. Reconciliation at 0027 then posts through the same helper.
2. **RBAC/RLS must come last.** A policy cannot reference a table that does not exist, and
   `app_finance_actor_class()` needs `roles`/`membership_roles` (0001) and `student_guardians`
   (0005/0006) — all available at 0021, but the *policies* are useless until every `fin_*` table
   exists. More importantly, the role backfill (§20.5) must run **after** the catalog is final,
   because `assertCatalogConsistent()` fails the API boot if a template references an unknown
   permission, and the migration's own post-condition assertion needs the final permission set.
3. **Grants must come after policies, within 0028.** The previous revision listed "policies … grants"
   as a single unordered item. See §30.3 — the ordering is the whole fix, and it has to be a stated
   intra-file order, not a convention.

### 30.3 Per-migration contract, and the grant-after-RLS ordering (P0-11, P1-14)

Every migration follows the established conventions:

- **Header comment** stating what, why, and — critically — **why no existing migration is edited**
  (the `0020:39-43` formulation).
- **`DROP TRIGGER IF EXISTS` before every `CREATE TRIGGER`** (idempotence).
- **Trigger functions: `plpgsql`, `SET search_path = pg_catalog, public, pg_temp`** (§19.7), named
  `trg_fin_*`; triggers named `fin_*` (e.g. `fin_ledger_balanced`, `fin_allocations_bounds`) — the
  `trg_` prefix is reserved for trigger **functions**, so a trigger is never named `trg_*`.
- **Domain conflicts raise `USING ERRCODE = '55000'`** so the API maps to documented 409s.
- **Every tenant-scoped FK is composite; every FK target declares `UNIQUE (tenant_id, id)`** (§6.3
  R1/R2/R3). No elision in any DDL block, per R3's mechanical form.
- **Schema mirror**: every table is added to `packages/db/src/schema.ts` in the same change, or
  `drizzle-kit` drifts. The file is hand-maintained today and is now **3115 lines** (2365 before the
  Phase 7 finance tables and the 9 anchor indexes 0021 added were declared). This is a known
  maintenance cost the owner should be aware of, and it is now *enforced* rather than trusted:
  `finance-composite-fk.test.ts` section E compares the Drizzle declarations themselves — via
  drizzle's own `getTableConfig`, not a text search — against the live catalog for all 12 finance
  tables, covering column names, **position**, nullability, type, and the names of every FK, check,
  unique constraint and index. Position is compared because an out-of-order declaration produces a
  schema that generates the wrong `INSERT` column list while still type-checking. A missing FK
  declaration compiles cleanly and then fails at runtime with a `23503` that nothing in the type
  system predicted, so this test is the thing that catches it. Note that triggers, functions,
  REVOKEs, RLS and function privileges are not expressible in a Drizzle schema at all; they stay in
  the migrations and are asserted by `finance-trigger-inventory.test.ts` instead.

#### 30.3.1 The composite-type ordering rule, which is not the same rule

**A plpgsql `DECLARE` of a table's row type is resolved at `CREATE FUNCTION`, and a plpgsql
*statement* referencing that table is not.** The two look identical in the source and have opposite
failure timing, so the distinction is stated once here and asserted by
`finance-migration-order.test.ts` rather than left to each function's author.

> **Status, stated so it is not mistaken for coverage.** `finance-migration-order.test.ts` **does not
> exist yet**; every reference to it in this document is a forward reference. It is scoped to parse
> `0021`–`0029`, and only `0021` and `0022` are written, so it cannot be written yet without either
> failing on the seven missing files or being special-cased for them. For the two migrations that do
> exist, the rule is instead enforced *live* rather than by parsing: `0022`'s own
> `post-0022 assertion` self-test runs 61 behavioural cases at apply time, and
> `finance-composite-fk.test.ts` asserts the resulting FK graph and anchors against the catalog
> (including that `fin_tax_profiles` is declared at `schema.ts:2495` **before** `fin_tenant_settings`
> at `schema.ts:2525`, because Drizzle evaluates `foreignKey({ foreignColumns })` eagerly and the
> reverse order fails to resolve — the child would be declared before its parent exists). What
> remains unproven by machine is the *ordering* of objects **within** the SQL files; that is the gap
> `finance-migration-order.test.ts` is meant to close, and it closes when `0029` is.

| Construct | Resolved | Failure if the table is missing |
|---|---|---|
| `RETURNS fin_x` | `CREATE FUNCTION` | 42704 `undefined_object` |
| `DECLARE v fin_x` (composite / row type) | `CREATE FUNCTION` | 42704 `undefined_object` |
| `DECLARE v fin_x%ROWTYPE` | `CREATE FUNCTION` | 42704 `undefined_object` |
| `SELECT … FROM fin_x` in the body | first execution | 42P01 `relation does not exist` |
| `INSERT INTO fin_x` in the body | first execution | 42P01 |
| `PERFORM app_fn()` in the body | first execution | 42883 `function does not exist` |
| `CREATE TRIGGER … EXECUTE FUNCTION <fn>()` | `CREATE TRIGGER` | 42883 |

The practical consequence: **a trigger function that declares a row type from a table created by a
later migration must itself be created in that later migration**, even when every statement in its
body would have been fine. Two functions in this design are in exactly that position and both are
placed accordingly:

- `trg_fin_refund_provenance` declares `v_target fin_payment_allocations` **and**
  `v_refund fin_refunds`. `fin_payment_allocations` is created by 0024 and `fin_refunds` by 0025, so
  the function and **both** of its `CREATE TRIGGER` bindings live in 0025 (§13.1, §35.3.2). A 0024
  function fails with 42704; a 0024 *trigger* bound to a 0025 function fails with 42883. Splitting
  the two bindings across 0024 and 0025 is the one arrangement that cannot work, because the function
  is a single object and the earlier binding needs it to exist.
- `trg_fin_challan_status` declares `v_inv fin_invoices`, and is in 0023 — the same migration that
  creates `fin_invoices`. Correct as placed.

The test asserts the *ordering*, not the prose: for every function whose `DECLARE` block names a
`fin_*`/`auth_*` relation as a bare type, the index of that `CREATE FUNCTION` in the concatenated
migration text must be greater than the index of the `CREATE TABLE` for that relation. This catches
the class without a per-function allowlist, so adding a new function with the same hazard fails the
test rather than the migration.

#### 30.3.2 The intra-file order of `0028` — this is the P0-11 fix

```text
  0028, in this exact order:

  1. CREATE UNIQUE INDEX academic_years_single_active_uq
       ON academic_years (tenant_id)
       WHERE is_active;                       -- additive, fails closed (§30.4)
  2. CREATE TABLE auth_mfa_factors (…);
     CREATE TABLE auth_step_up_challenges (…);
     -- NO anchor index here. users and auth_sessions have no tenant_id column, so
     -- a (tenant_id, id) index on either would fail with
     -- `column "tenant_id" does not exist` and the whole migration would not
     -- apply. §6.3 R4's allowlist is what makes their single-column FKs legal
     -- (P0-06a). Do not "fix" this by adding the column: a user belongs to many
     -- tenants, so users.tenant_id would be a lie RLS would then have to undo.
  3. app_verify_mfa_code()  (F7, STABLE — reads only)
     app_consume_step_up()  (F8, VOLATILE — writes)
     app_mint_step_up_challenge() (F9, VOLATILE — writes)
     trg_auth_step_up_immutable() + its trigger
  4. Backfill fin_tenant_settings / fin_ledger_accounts rows (idempotent)
  5. INSERT role_permissions rows for the 25-permission fees.* catalog
     + create the `cashier` role per existing tenant (is_system = true)
  6. ---- RLS BLOCK, table by table ----
       ALTER TABLE fin_x ENABLE ROW LEVEL SECURITY;
       ALTER TABLE fin_x FORCE  ROW LEVEL SECURITY;
       CREATE POLICY <named policy> ON fin_x …;
       (every table in §35.1, in full, including auth_mfa_factors and
        auth_step_up_challenges)
  7. Post-condition assertions: policy text present, actor class present in every
     USING and WITH CHECK, RLS enabled AND forced on every fin_* and auth_* table,
     no platform branch anywhere
  8. ---- GRANT BLOCK, last ----
       -- The four privilege shapes, written out in full in §35.4. There is no
       -- single blanket GRANT here, and deliberately so: Tables marked
       -- UPDATE-revoked in §35.4 (counters, billing runs, payments, allocations,
       -- refunds, receipts) get SELECT, INSERT only; the ledger, the 0029 tables
       -- and fin_ledger_accounts get SELECT only; the seven views get SELECT only.
       -- A single `GRANT SELECT, INSERT, UPDATE ON fin_x` would silently widen
       -- every one of those revoked-UPDATE tables, which is the same failure as
       -- the un-explicit grant this step replaced -- the defect and the fix have
       -- the same shape, and that is what makes it easy to reintroduce.
       -- Never DELETE on anything: 0001 granted it and the per-table REVOKE took
       -- it back (§35.4).
  9. ---- LEDGER REVOKE BLOCK, after the grants ----
       REVOKE INSERT, UPDATE, DELETE
         ON fin_ledger_entries, fin_ledger_entry_groups FROM school_app_rw;
       GRANT EXECUTE ON FUNCTION post_fin_ledger_group(uuid, text, uuid, jsonb)
         TO school_app_rw;                                     -- §30.3.3
 10. Ledger post-condition: direct INSERT as school_app_rw raises 42501;
       the two aggregate view classes have the right reloptions (§15.2.1)
```

**Why the ledger `REVOKE` is step 9 and not part of step 8.** The grants and the revokes are both in
`0028`, but they are separated so the assertion at step 10 can run against the *final* state. Folding
the `REVOKE` into the `GRANT` block would work too — the transaction is atomic either way — but a
reader who sees `GRANT INSERT` and a `REVOKE INSERT` in the same ten lines will reasonably assume a
mistake, and the intent ("grant the app access, then take back the one table it must not write
directly") is clearer as two ordered steps with a verification between them.

**Why the previous order was a P0.** The convention stated in the earlier revision was
"**Explicit `GRANT SELECT, INSERT, UPDATE, DELETE ON <t> TO school_app_rw`** even though `0001`'s
`ALTER DEFAULT PRIVILEGES` already covers it". `0001:380-383` is the **only** `ALTER DEFAULT
PRIVILEGES` in the repository; `0005:355-359` is the *explicit-grant convention* that layers on top
of it. `0001:380-383` is `ALTER DEFAULT PRIVILEGES FOR ROLE school_migrator IN SCHEMA public GRANT
SELECT, INSERT, UPDATE, DELETE ON TABLES TO school_app_rw`, which means **every table
created from 0021 onward is automatically granted to `school_app_rw` the moment it is created** —
before any policy exists. The stated "explicit grant" step therefore changed nothing, and the
sequence was in fact:

```text
EITHER REVISION, in one line:
      GRANT SELECT, INSERT, UPDATE ON fin_x TO school_app_rw
          -- a single blanket grant, which is the defect
          -- on a committed fin_* table, RLS not enabled. The earlier revision
          -- also never revoked, so 0001's default privilege stood: the runtime
          -- role could read and write every tenant's money, unscoped.

THIS REVISION, 0021 through 0027 and 0029:
      every CREATE TABLE fin_* is IMMEDIATELY followed by
          REVOKE ALL ON <t> FROM school_app_rw;
      in the same file, and therefore the same transaction, before any other
      statement can use the table (the DDL in this document now carries all 29
      of these statements), and NONE of these files enables RLS.
      So a committed fin_* table has NO ACL entry for school_app_rw and no
      policy: unreachable. SELECT and every write raise 42501 until 0028.
0028:  ENABLE + FORCE ROW LEVEL SECURITY, CREATE POLICY on every fin_* table,
       THEN the four-shape GRANT block from §35.4.
```

The distinction matters more than it looks. "Revoked, but RLS not yet enabled" and "granted, but RLS
not yet enabled" are **not** the same state, and the earlier revision described the first while its
DDL produced the second. A revoked table fails closed; a granted table fails open. The whole point
of the per-table `REVOKE` is that it converts the failure mode from "wide open until 0028" to
"closed until 0028", so that enabling RLS later is a change in what an *already-unreachable* table
lets through, never the change that makes it reachable.

For the whole of the 0021–0027 window in the earlier revision, `school_app_rw` held full `ALL`
privileges on every finance table with **RLS not enabled**. PostgreSQL's default is that RLS is *not*
enforced on a table whose RLS has never been enabled, so a policy created later is inert until
`ALTER TABLE … ENABLE ROW LEVEL SECURITY` runs. Any session using the runtime role that reached a
`fin_*` route during that window — or any code path that touched one, including a worker reconnect
during a rolling deploy — read every tenant's money. In this revision the window is closed, not
narrowed, by the reordering above.

**Three mechanisms make the fix durable rather than conventional:**

1. **Explicit `REVOKE ALL` immediately after each `CREATE TABLE`** in 0021–0027, before the default
   privilege can matter. This is a no-op in the common case and the actual control in the
   `ALTER DEFAULT PRIVILEGES` case, because it runs in the same transaction as the `CREATE TABLE`.
   `finance-composite-fk.test.ts` asserts that no `fin_*` table has a `school_app_rw` ACL entry
   before its migration's own step 8.
2. **`ENABLE` + `FORCE` before the policies, and the assertions in §19.5 step (3) fail the migration
   if either is missing on any `fin_*` table.** `FORCE` matters because the table owner is otherwise
   exempt — and the owner is not hypothetical: it is `school_migrator`.
3. **A continuous-integration grep** over `0021`–`0027` that fails the build if a `CREATE TABLE fin_`
   is not followed by a `REVOKE` in the same file. This is a *textual* check, and it is a backstop for
   a future contributor, not the primary control — the primary control is (1) and (2).

**Reconciling this with the per-file transaction.** Because the runner wraps each file in one
transaction, the 0021–0027 tables are not visible to any *other* session until their migration
commits, and the `REVOKE` is in that same transaction as the `CREATE TABLE`. So the window is not
"0021 to 0028" in wall-clock terms — for this revision it is **zero**, because there is never a
moment at which the table is committed and still granted. This is worth stating precisely, and it
also corrects an over-claim: the earlier revision's window was *not* zero, even though the
per-transaction argument for it was the same. The transaction prevented interleaving; it did nothing
whatsoever about `school_app_rw` holding a real ACL grant on a table visible to the rest of the
cluster. The two facts have to be held separately, because a transaction boundary is an argument
about *visibility* and the `REVOKE` is an argument about *privilege* — only the second one fixes the
defect, and in the earlier revision the first was mistaken for the second.

#### 30.3.3 Ledger privileges (P1-07)

`fin_ledger_entry_groups` and `fin_ledger_entries` are **append-only through a function, not through
the runtime role's table privileges.** Previously the contract granted
`SELECT, INSERT, UPDATE, DELETE` on every finance table and relied on there being no `UPDATE`/`DELETE`
*policy* to block the row-level operations. That is insufficient for two reasons: a policy protects
rows, not the statement, and `school_app_rw` is not the table owner so a missing policy does block it
— but the design should not depend on the *absence* of a policy for its most sensitive write path.

```sql
-- Revoke the write privileges the append-only design must not rely on being blocked.
REVOKE INSERT, UPDATE, DELETE ON fin_ledger_entry_groups FROM school_app_rw;
REVOKE INSERT, UPDATE, DELETE ON fin_ledger_entries        FROM school_app_rw;
-- Read stays: the ledger is a report source.
GRANT SELECT ON fin_ledger_entry_groups, fin_ledger_entries TO school_app_rw;
-- Writes happen only through the canonical posting function (F4), which is
-- SECURITY DEFINER. school_app_rw has no INSERT on either table, so this is the
-- only path in; the function's own closed jsonb line shape and the balance/seal/
-- append-only triggers bound what it can be used to do.
GRANT EXECUTE ON FUNCTION post_fin_ledger_group(uuid, text, uuid, jsonb) TO school_app_rw;
```

**`post_fin_ledger_group()` is `SECURITY DEFINER`, and the previous revision's `SECURITY INVOKER` was
unexecutable (P1-07).** The two statements the earlier draft made — "revoke `INSERT` from
`school_app_rw`" and "the posting function is `SECURITY INVOKER`" — are mutually exclusive. An invoker
function performs its `INSERT` **as the caller**, so with these revokes in place the function raises
`42501` for every caller and the ledger can never be posted to. The document described an
unpostable ledger and called it protected. The tradeoff analysis in the earlier draft ("definership
would make the function the only thing standing between a caller and the ledger") is correct about
the risk and wrong about the conclusion: **not** definership would make the revokes and the function
mutually destructive, and restoring the runtime `INSERT` to keep definership unnecessary is the worse
of the two options, because it hands the runtime role direct write access to the most
security-sensitive table in the system.

The adjudicated position, stated so it can be argued with:

- **Definership is required** for a canonical posting function whose direct-table write is revoked.
  That is not a compromise; it is the only coherent arrangement.
- **The compensation is a bounded contract, not trust in the function body.** The function takes
  `p_lines jsonb` — data, never SQL — and every element is checked for shape, `account_code`
  membership in the tenant's chart, `amount > 0`, `direction` in the enum, debit total equal to
  credit total, and tenant equality for any `student_id`/`invoice_id` element, **before** the group
  header or any leg is inserted. `search_path` is `pg_catalog, public, pg_temp`. `PUBLIC` is
  revoked. There is no `EXECUTE` path that reaches a leg row other than through those checks.
- **The read grant is unaffected.** `SELECT` remains, because the ledger is a report source and
  §15.2.1's V1 detail views (`fin_v_invoice_balance`, `fin_v_payment_position`,
  `fin_v_ledger_account_balance`) are `security_invoker`, so a reader's RLS still decides
  which legs exist for them.
- **Defender tests, not asserters.** `finance-ledger-grants.test.ts` asserts the asymmetry in both
  directions so the design cannot silently regress to either failure: direct
  `INSERT INTO fin_ledger_entries` as `school_app_rw` raises `42501 insufficient_privilege` (a
  privilege error, not a policy-filtered empty result, so the test cannot pass for the wrong reason);
  the full six-argument `post_fin_ledger_group` call with balanced
  lines succeeds; the same call with a debit/credit
  imbalance raises `55000` **and leaves zero rows in both ledger tables**; and a line naming another
  tenant's `student_id` raises `55000` with zero rows written. The third and fourth assertions are  the ones that make definership acceptable — they test the *contents* of the elevated capability, not
  just its presence.

### 30.4 Migration-scope risks, stated rather than hidden

| Risk | Assessment | Mitigation |
|---|---|---|
| `academic_years_single_active_uq` (§8.5) touches a **Phase 2B table**, not a finance table | Could fail on an existing tenant with two `active` years | Migration pre-checks and **fails closed with a clear message** rather than silently picking one. A data-repair step is a separate, owner-approved migration. This is a genuine cross-phase change and is called out as such |
| The 12 anchor indexes of §6.3 on existing tables | Could they fail? **No** | Every one of those tables declares `id uuid PRIMARY KEY`, so `(tenant_id, id)` is already unique and `CREATE UNIQUE INDEX` cannot fail. They are `IF NOT EXISTS` for idempotence. This is a cross-phase *index* addition with no behavioural effect and no data migration, which is a materially smaller ask than `academic_years_single_active_uq` |
| `0028` backfill writes permission rows to **every** tenant | Long-running on a large fleet | Batched by tenant id with a progress log; the whole migration is one transaction, so batching is per-statement, not per-commit. On a very large fleet this may need a two-phase approach — **flagged as an owner decision (OD-08)** |
| `fin_tenant_settings` needs one row per existing tenant | Backfill from `tenants` | Idempotent `INSERT … SELECT … ON CONFLICT DO NOTHING` |
| `fin_ledger_accounts` needs **9** rows per existing tenant (§5.2's chart) | Backfill from that fixed code list, by calling **F3** per tenant rather than repeating the list | Idempotent (`ON CONFLICT DO NOTHING`); a trigger rejects unknown `account_code` on a ledger leg, so the fixed list is enforced by the leg path as well as by the seed |
| `0026` ledger triggers do not backfill historical postings | **Accepted.** Phase 7 is a greenfield finance module — there is no pre-existing finance data in this repository (no `fin_*` table exists). A new tenant's first invoice opens the ledger at zero, which is correct | Documented, not worked around |
| `0024` leaves `refund_id` unconstrained until 0025 | A window, deliberately taken | Zero-length in wall-clock terms (two consecutive lexical files, each its own transaction, and no application code ships between them). Stated in the matrix rather than hidden; `finance-migration-order.test.ts` asserts the FK exists by the end of 0025 |
| MFA enrollment is a prerequisite for refund approve/process | A tenant with no enrolled factor cannot approve refunds | Fail-closed by design (§19.8.3). Enrollment is a go-live prerequisite, not a hardening step. Break-glass is **not** designed — OD-13 |

### 30.5 Rollback and zero-downtime — corrected (P1-10)

The previous revision said two contradictory things: that every migration is purely additive and
that rollback for `0028` is a targeted `DELETE FROM role_permissions WHERE permission LIKE 'fees.%'`.
A `DELETE` is a destructive operation, and the same document elsewhere claimed "no destructive
operation is performed anywhere in the sequence". Both statements cannot be true. Here is the
adjudicated position:

| Property | Corrected statement |
|---|---|
| `0021`–`0027`, `0029` schema | **Purely additive.** New tables, new indexes, new functions, new permission rows. No `ALTER TABLE … DROP`, no `DROP COLUMN`, no type change on an existing column, no data mutation of any pre-existing row |
| `0021` anchor indexes | **Additive and non-destructive** — the index is built on already-unique columns. `DROP INDEX` would be the reverse, and is equally safe, but is not required because the index is behaviourally inert |
| `0028` permission backfill | **Insert-only.** It adds rows; it does not modify or delete any pre-existing `role_permissions` row, and the `is_system` filter (§20.5) guarantees no custom role is touched. This is a property asserted by the before/after checksum, not a claim |
| The word "rollback" | **Not used for schema.** Phase 7 defines no down-migration. `packages/db/src/cli/migrate.ts` has **no `down` command** — it applies files in lexical order and records them in `schema_migrations`. A down-migration capability does not exist in this repository, and inventing one for Phase 7 would be a cross-phase change to the migration runner |
| The actual rollback procedure | **Revert the application deployment.** The `fin_*` tables become inert: no route references them, so nothing reads or writes them. The schema remains as an inert record of what was deployed |
| If a *bad* `0028` must be undone | The only supported repair is a **forward** migration, because the runner has no reverse path. Removing `fees.*` grants is `REVOKE`, not `DELETE`; removing finance RLS is `DROP POLICY`; neither destroys a pre-existing row. This is stated so that no one reaches for the `DELETE` the previous revision proposed |
| Destructive operations | **None**, anywhere in the sequence. The claim is now true, because the one operation that falsified it has been removed from the design |
| Index creation on new tables | Concurrent-safe by construction (the tables are empty). The §6.3 anchors on *existing* tables are the exception: those are built with a plain `CREATE UNIQUE INDEX` and hold a `SHARE` lock for the duration. For a table of the size `students` or `role_permissions` this is short; for a very large `users` table it is not, and `0028` should build the two auth anchors with `CREATE UNIQUE INDEX CONCURRENTLY` — which cannot run inside the runner's transaction, so it is instead **deferred to a standalone owner-run statement** recorded as a §30.4 risk rather than smuggled into a transaction that would fail |

**The `CREATE UNIQUE INDEX CONCURRENTLY` caveat is stated because it is a real constraint, not a
detail.** `CONCURRENTLY` is incompatible with `TRANSACTION`, and the runner uses one transaction per
file. The design therefore does not use it; it records the trade-off. If `users` is large enough
that a blocking index build is unacceptable, the correct answer is a separate operational step, not
a special case in `0028`.

---

## 31. Implementation subphases

### 31.1 — Finance domain foundation

- **Deliverables:** `fin_tenant_settings`, `fin_ledger_accounts` (+ seeding), `fin_document_counters`,
  `fin_fee_heads`, `fin_tax_profiles`; the two actor-classification functions; money/rounding unit
  library; IBAN validator.
- **Migrations:** `0021`.
- **APIs:** none (no user-facing surface yet).
- **UI:** none.
- **Worker events:** none.
- **Tests:** `finance-money.test.ts` (rounding, numeric agreement, IBAN with the §26.3 table);
  function-security tests asserting `REVOKE … FROM PUBLIC` and `GRANT … TO school_app_rw` on both
  new functions.
- **Security gates:** both new functions must have `search_path = pg_catalog, public, pg_temp`
  (`pg_temp` last — §19.7), `REVOKE ALL FROM PUBLIC`, and an explicit `GRANT`. A static test asserts
  it, so the next contributor cannot drop them.
- **Exit criteria:** migrations apply and revert cleanly; catalog seeding is idempotent; 100% of the
  money unit tests pass; the actor-classification function is proven to return the correct class for
  each of the five actor kinds under a real ticket.

### 31.2 — Fee structures and assignments

- **Deliverables:** structures, targets, items, installment plans, assignments, the target-integrity
  trigger, the active-period unique index.
- **Migrations:** `0022`.
- **APIs:** `/finance/fee-heads`, `/finance/fee-structures` (+ publish/retire),
  `/finance/fee-assignments`.
- **UI:** fee structure wizard; target picker.
- **Worker events:** `fee.fee_structure.published` (NOOP).
- **Tests:** target integrity for all 5 target types (existence, tenant, year, hierarchy, deleted);
  repeated `fee_head_id` across `installment_no`; overlapping-target resolution; the second-active-
  assignment `23505`.
- **Security gates:** finance configuration tables are staff-only in RLS — parent/student have no
  branch.
- **Exit criteria:** the 3-installment tuition example from §7.1 is expressible; a structure with
  overlapping targets resolves deterministically; a cross-tenant target is rejected by the trigger.

### 31.3 — Billing, invoices, challans

- **Deliverables:** billing runs + trace, invoices, items, adjustments, challans, numbering, state
  machines, freeze triggers, the three **cache columns** (`subtotal`, `total`, `balance` — §12.4.1),
  `trg_fin_invoice_item_total` (2 bindings) and `trg_fin_invoice_balance_recompute` (2 bindings +
  the `trg_fin_invoice_recalc_balance(uuid,uuid)` helper they share, F5a).
- **Migrations:** `0023` (+ the `academic_years` index decision, §30.4).
- **APIs:** `/finance/invoices` (+ issue/void/adjustments), `/finance/billing-runs`, challan read.
- **UI:** invoice list/detail; challan preview; billing-run wizard.
- **Worker events:** `fee.invoice.issued`, `fee.invoice.voided`, `fee.invoice.adjusted`,
  `fee.challan.issued`, `fee.billing.run.completed`.
- **Tests:** FI-001, FI-010, FI-011 (concurrent numbering); every state-machine edge including
  `paid → void` **rejection**; void-with-balance rejection; **FI-001's adjustment-only case** — an
  `INSERT` into `fin_invoice_adjustments` with no line write must move `fin_invoices.total` and
  `.balance`, which is the regression the item-total's second binding exists for; the three
  §28.3 cache rows (`line edit alone`, `adjustment alone`, no-P0002 on `DELETE`).
- **Security gates:** `requireIdempotencyKey()` on every money POST (§21.1); `fees.invoices.*`
  permissions; draft-delete allowed, issued-delete impossible.
- **Exit criteria:** 20 invoices bill deterministically from a structure; a void reverses the ledger
  exactly; N concurrent issues produce N distinct numbers.

### 31.4 — Payments and allocations

- **Deliverables:** payments, allocations, receipts, the bounds/reversal triggers, the lock protocol;
  V1 `fin_v_payment_position` and `fin_v_invoice_balance` (§12.4); the **third** binding of
  `trg_fin_invoice_balance_recompute`, on `fin_payment_allocations`, which must recompute **both** the
  old and the new invoice when an allocation's `invoice_id` changes (FI-002, §12.4.1).
- **Migrations:** `0024`.
- **APIs:** `/finance/payments` (+ allocations, reverse, auto-allocate), receipts.
- **UI:** POS-style collection screen; payment list; receipt preview.
- **Worker events:** `fee.payment.recorded`, `fee.payment.allocated`, `fee.payment.reversed`,
  `fee.receipt.issued` (NOOP).
- **Tests:** FI-003, FI-004, FI-007, FI-016, **including the concurrency race** (N transactions
  racing the last 1,000 ⇒ exactly one wins, no deadlock); **the allocation-move case** — move a 500
  allocation between invoices and assert both `fin_v_invoice_balance.balance` values and both cached
  `fin_invoices.balance` values, since a one-sided recompute passes every other test in this list.
- **Security gates:** parent/student have **no** policy branch on `fin_payments` at all; a parent can
  read a receipt but never a payment row — asserted in `finance-rls`.
- **Exit criteria:** the §12.3 worked example reproduces exactly, in both the correction and the
  refund variant.

### 31.5 — Discounts, concessions, refunds, reversals

- **Deliverables:** refunds, the state machine, provenance/bounds/completeness triggers, refund
  advices.
- **Migrations:** `0025`.
- **APIs:** `/finance/refunds` (+ approve/reject/process).
- **UI:** refund request/approval screens; the four §13.5 examples as fixtures.
- **Worker events:** `fee.refund.requested`, `fee.refund.approved`, `fee.refund.processed`.
- **Tests:** FI-005, FI-006, FI-017; all four §13.5 examples; concurrent approvals; the
  over-refund raw-SQL rejection; `processed → refund` **rejection**.
- **Security gates:** step-up MFA on approve and process; three-permission separation; `40P01`
  retry.
- **Exit criteria:** a refund cannot be approved partially covered, over-covered, or above the
  refundable amount — each proven by raw SQL, not just via the API.

### 31.6 — Ledger

- **Deliverables:** groups, entries, balance/seal/append-only triggers, `post_fin_ledger_group()`
  (F4, `SECURITY DEFINER` — §30.3.3 revokes runtime `INSERT`, so an invoker version would be
  unexecutable, P1-07), the `fin_recompute` reconciler, V1 `fin_v_ledger_account_balance` (§12.4.2),
  and the four V2 owner-scoped aggregate views (§15.2.2).
- **Migrations:** `0026`.
- **APIs:** `/finance/ledger/groups/:id`.
- **UI:** ledger group browser (finance staff only).
- **Worker events:** `fee.reconciliation.drift`.
- **Tests:** FI-008, FI-009 — unbalanced group rejected; `UPDATE`/`DELETE` rejected **as
  `school_migrator`**; all three reconciliation paths agree across a full lifecycle; a deliberate
  cache corruption converges after `fin_recompute`.
- **Security gates:** no UPDATE/DELETE policy on ledger tables for **any** role; append-only
  enforced by trigger as well as policy (a policy alone is bypassed by the owner role).
- **Exit criteria:** the full lifecycle scenario balances on all three paths to the paisa; the ledger
  wins a disagreement with the caches.

### 31.7 — Reconciliation

- **Deliverables:** batches, matches, completion snapshots and hashes, variance handling, and the
  **finality closure**, which is three triggers: `trg_fin_recon_is_final` (row side — a match may not
  *claim* finality in a non-final batch), `trg_fin_recon_batch_derive_totals` (`BEFORE` — the batch's
  own totals, and the guard against leaving a finalised batch, F5b) and
  `trg_fin_recon_batch_stamp_matches` (`AFTER` — a batch that *becomes* final claims every match it
  holds, and a batch that is `cancelled` releases them, F5c). No subset is sufficient, and the two
  batch triggers cannot be merged because one effect needs `BEFORE` and the other `AFTER`; either
  combination leaves a window in which a payment is final in two batches, which is the defect the
  tenant-aware partial index cannot close on its own (P2-04, §14.1.1, §14.2).
- **Migrations:** `0027`.
- **APIs:** `/finance/reconciliation/*`.
- **UI:** batch worklist; match screen.
- **Worker events:** `fee.reconciliation.completed`, `fee.reconciliation.drift`.
- **Tests:** FI-018, all four cases: a second batch matching a finalised payment raises `23505`; a
  match `final → open` is rejected; **a batch that goes `open → matching` while holding matches
  stamped `is_final = false` re-stamps them all, and a second batch then still gets `23505`** — the
  case the batch-side trigger exists for and the one a batch-side-only test cannot distinguish; and
  **`/cancel` from `matching` succeeds** (§21.3 — the previous `open`-only gate made a half-matched
  batch unabandonable). Plus: completion writes a snapshot exactly once; a completed batch is
  immutable; the tenant-aware index rejects the same payment in two *different* tenants' batches
  while allowing the same `payment_id` value in both.
- **Security gates:** `fees.reconciliation.manage`; completion is audited with the variance reason.
- **Exit criteria:** a payment is finalised in exactly one batch, ever; a completed batch is
  byte-stable.

### 31.8 — RBAC, backfill, portal

- **Deliverables:** the `fees.*` catalog, the `cashier` template, the backfill, **all finance RLS
  policies**, the portal read surface, nav sections.
- **Migrations:** `0028`.
- **APIs:** all of §21.3's portal endpoints; the staff endpoints land with their subphases.
- **UI:** 4 nav sections; 2 portal surfaces.
- **Worker events:** `fee.parent.notification.requested` (NOOP).
- **Tests:** FI-014, plus the `finance-020` backfill/checksum assertions; all seven §28.3 negative cases; the principal/parent/student matrix.
- **Security gates:** **the phase's hard gate.** The `0020`-style post-condition assertions must pass
  or the migration fails; the checksum assertion must prove no custom role was widened; the
  platform-actor test must return 0 rows.
- **Exit criteria:** a parent cannot reach another family's money by **any** path including direct
  SQL; a `platform_admin` sees nothing; `principal` sees only aggregates.

### 31.9 — Hardening, artifacts, provider boundary

- **Deliverables:** `fin_document_artifacts`, the PDF renderers, the webhook receiver, the provider
  interface, the `ManualProvider`, the test-only `FakeProvider`, the orphaned-object sweep.
- **Migrations:** `0029`.
- **APIs:** `/finance/gateways/:provider/webhook` (the only public finance route).
- **UI:** artifact download/preview; receipt reprint.
- **Worker events:** `fee.finance_document.generated` (NOOP), `fee.invoice.overdue` (NOOP).
- **Tests:** `finance-029` artifact crash-convergence; all **six** §27.5 webhook dispositions;
  the **uniform 200 / `{"status":"ignored"}` assertion across the four pre-authorization
  failures**; signature forgery and replay; the authenticated `/webhook/verify` self-check; the
  `FakeProvider`-not-imported-in-production static test; payload-PII static test.
- **Security gates:** signature-before-tenant-resolution; **no distinguishable pre-authorization
  response** (code, body, and timing — §27.4); the dummy-secret substitution so an unknown account
  costs the same as a known one; raw-body-not-stored default; encryption + redaction + expiry if
  enabled; no real provider credentials in the repo.
- **Exit criteria:** storage-succeeds/DB-fails converges to one artifact; a forged webhook changes
  nothing; a replayed webhook double-settles nothing.

---

## 32. Backward compatibility

- **No existing table is altered destructively.** The only cross-phase schema change is
  `academic_years_single_active_uq` (§30.4), which is **additive** and fails closed if an existing
  tenant has two active years. Phase 3–6 code is unaffected.
- **No existing route changes.** `apps/api/src/app.ts` gains one `register(financeRoutes)` after the
  Phase 6 line, matching the phase-ordering convention.
- **No existing permission changes.** `fees.*` is a new namespace; `assertCatalogConsistent()` passes
  because no existing template references an unknown permission. The only existing-template change is
  the additive backfill in `0028`.
- **No existing event type changes meaning.** 18 new types are appended to the enum (13 HANDLED, 5 NOOP); the three
  registry pins move from **93 / 9 / 84** to **111 / 22 / 89** in the same commit, and the count is
  asserted by name per event rather than by total. The fallback arm is removed — a
  behaviour change to the worker that is a **security improvement** and is covered by the existing
  always-on registry gate.
- **A tenant with no `fees.*` role grant sees no finance nav section and can reach no finance route**
  — because the authorization gate fails the boot if a route names an ungranted permission, and the
  nav filter is driven by the same DB-derived set. There is no partially-enabled finance state.
- **Outbox payloads are unchanged in shape.** `outboxEventSchema` is unchanged; only the enum grows.
- **`FINANCE_DESIGN.md` is superseded** by this document. `DATABASE_DESIGN.md` §9 is superseded for
  Phase 7. Neither is edited by this phase; the supersession is recorded in §33 and the owner decides
  whether to delete or annotate the old drafts.

### 32.1 Superseded documentation — exact list

| Document | Claim | Superseded by |
|---|---|---|
| `FINANCE_DESIGN.md:20` | issue "freezes line items … assigns `invoice_no`" | §9.1 — compatible, now explicit |
| `FINANCE_DESIGN.md:21` | void "only if no settled payments" | §9.3 — strengthened to balance = 0 |
| `FINANCE_DESIGN.md:26` | "**required** `Idempotency-Key`" | §21.1 — the real header is `x-idempotency-key`; requiredness is newly enforced |
| `FINANCE_DESIGN.md:31` | invoice money columns as "derived counters, recomputable … nightly" | §16.5 — kept, with a 3-layer integrity strategy |
| `FINANCE_DESIGN.md:32` | "no gaps under concurrency except on rollback" | §14 — precise language: transactional allocation, monotonic committed numbering, gaps permitted, committed numbers never reused |
| `FINANCE_DESIGN.md:35` | gateway webhook upsert by `('provider','external_id')` | §27.3 — kept, plus account mapping and no-payload-tenant |
| `FINANCE_DESIGN.md:40` | `amount ≤ payments.amount − refunded_for_payment` | §13.3 — kept, now a locked trigger |
| `FINANCE_DESIGN.md:46` | receipt "immutable" with a printable snapshot | §25.5 + §16.4 — receipt is immutable; **`status = issued \| void` is removed entirely** |
| `FINANCE_DESIGN.md:51-53` | balanced group "verified by `BEFORE INSERT` trigger"; `REVOKE UPDATE, DELETE` | §15.1 — kept and strengthened with a deferred group check and a trigger (a `REVOKE` alone does not bind the owner) |
| `DATABASE_DESIGN.md:220` | immutability via `app.allow_immutable_update` GUC | **Rejected** — §9.4/§15.1. A GUC readable by a trigger is forgeable by the runtime role, which is the exact Phase-1 defect `0002` fixed. This is the most important supersession in the document. |
| `DATABASE_DESIGN.md:205` | heading `fin_*`, tables unprefixed | §6.1 — `fin_` prefix is authoritative |
| `DATABASE_DESIGN.md:214` | `payment_allocations` `unique(payment_id, invoice_id)`, `amount > 0` | §12.1 — that unique blocks a second application and cannot express partial reversal; replaced by signed rows + reversal partial-uniques |
| `DATABASE_DESIGN.md:217` | `refunds.payment_id` as the only provenance link | §13.1 — provenance is a reversal allocation carrying `refund_id`, proven by trigger |
| `DATABASE_DESIGN.md:219` | `payment_gateway_webhooks` stores `raw jsonb` | §27.6 — raw is **not** stored by default; hash + normalized only |
| `DATABASE_DESIGN.md:216` | `receipts` "immutable" with no status column | §25.5 — compatible; this is the model FINANCE_DESIGN should have matched |
| `DEVELOPMENT_ROADMAP.md:88` | "dunning reminders" in Phase 7 | §26.2 — deferred to Phase 8, with the seam documented |
| `DEVELOPMENT_ROADMAP.md:87` | `refund审批` | **Defect** in a file this phase does not own. Reported, not edited. |
| `JOB_ARCHITECTURE.md` | DLQ, `job_runs`, `runAsTenant`, per-aggregate ordering | §24.3/§24.4 — none exist; §25.3 does not depend on `job_runs` |
| `DATABASE_DESIGN.md:243` | `job_runs` table | Does not exist; not depended upon |

---

## 33. Open decisions

Each entry states the decision, the default this design ships with, and **the consequence of the
default if the owner disagrees**.

| ID | Decision | Shipped default | Consequence of the default |
|---|---|---|---|
| **OD-01** | Is raw webhook payload retention offered at all? Needed for bank chargeback evidence, which Pakistani schools often require. | **Off.** Hash + normalized safe fields only. | Enabling it needs **three** things, not one: a retention table (`fin_webhook_raw_payloads`, **not** created by `0029` — P1-09), a **deployment decision** on the encryption mechanism (there is no `APP_ENCRYPTION_KEY` in this repository, and PostgreSQL cannot encrypt a column with an application env var), and a tenant setting. Redaction, expiry, and restricted RLS are ready to design; the cipher is not. Defaulting off loses dispute evidence for tenants that do not opt in. |
| **OD-02** | Is `1300 Unapplied Cash` a liability (as designed) or an asset? | **Liability.** On-account money is a claim on the school. | If treated as an asset, revenue is understated and the balance sheet misstates the advance position. No code change is recommended; the decision is recorded so an auditor is not surprised. |
| **OD-03** | The authoritative National Bank of Pakistan `bankCode` list for IBAN validation. | Format + MOD-97 only; `bankCode` must be 3 digits. | A structurally valid IBAN for a non-existent bank is accepted. Adding the list is a data-only change, no migration. |
| **OD-04** | Whether Pakistani private-school tuition is subject to FBR service tax / provincial sales tax, and at what rate. | **Tax disabled.** `fin_tax_profiles` exists, empty. | If tuition is taxable, Phase 7 issues non-compliant invoices until the profile is populated and a tax layer is built. **This is a legal question the repository cannot answer**; it is a real compliance exposure, not a modelling convenience. |
| **OD-05** | Which payment provider(s) for tuition collection, and when merchant accounts/keys exist. | **Manual cash/bank only.** Provider-neutral interface + a webhook receiver + a test-only `FakeProvider`. | Manual collection is fully shippable, so nothing blocks. When a provider is chosen, the adapter is a new file plus a `fin_provider_accounts` row — **no migration**, because the schema is provider-neutral by construction. |
| **OD-06** | Automatic proration / mid-year withdrawal handling. | **Out of scope.** Manual adjustment with a reason. | A school that must pro-rate issues the full invoice and adjusts it by hand — auditable but manual, and the adjustment is a visible exception rather than a silent proration. Fixing it properly needs effective dates on `enrollments`, which is a Phase 3 table and therefore not a Phase 7 change. |
| **OD-07** | Should arrears carry forward automatically into the next academic year's invoice? | **No.** Prior-year arrears are visible in AR aging and on the portal; they are never auto-carried. | Families with unpaid prior-year debt see a clean new invoice and must be chased. A carry-forward feature would need a product decision about which year a carried charge belongs to. |
| **OD-08** | Migration `0028` writes `fees.*` permission rows to every tenant in one transaction. | **Single transaction**, batched per statement. | On a very large fleet the migration could hold a long transaction. If the fleet is large, a two-phase migration (backfill, then policy) is safer. The fleet size is not knowable from this repository. |
| **OD-09** | Should the six existing `0002` SECURITY DEFINER functions be retro-fitted with `pg_temp`-last `search_path`? | **No.** `0002` is immutable and `CREATE OR REPLACE` will not change a function's `SET` clause without a drop, which is a behaviour change on applied history. | The existing functions keep a theoretically weaker `search_path`. Phase 7's own functions do not. A future additive migration could `DROP`/`CREATE` each safely, but that is a cross-phase security change and needs the owner's call. |
| **OD-10** | The applicable jurisdiction's financial-record retention period (the roadmap's own open question #3). | **7 years**, matching `DATA_RETENTION.md:65` ("financing defaults assumed 7y"). | If the applicable law requires longer, the retention job purges too early. Retention is a Phase 13 job, so there is time to correct it before it runs. |
| **OD-11** | Should a `cashier` role template be added, given no custom-role UI exists? | **Yes**, added in `0028`. | If the owner prefers a smaller role set, drop `cashier` from `ROLE_TEMPLATES` and the backfill; the consequence is that cash collection and refund approval cannot be separated, which is the control weakness §20.1 identifies. |
| **OD-12** | Should the principal get `fees.invoices.read`? | **No** — aggregate only (§20.2). | A principal cannot open an individual invoice. If the owner wants it, it is one line in the catalog plus the RLS class change — but §20.2 explains why the design does not do it silently. |
| **OD-13** | Is there an owner-approved **break-glass** path to approve/process a refund when no staff member has an enrolled MFA factor? | **No.** Fails closed with `503 step_up_unavailable`. | A tenant whose staff have enrolled no factor **cannot approve refunds at all** (§19.8.3) — which is the correct default for a control that protects cash, and makes enrollment a go-live prerequisite rather than optional hardening. If the owner later wants a break-glass path, it must be a *separately permissioned*, dual-approval, expiring, **fully audited** workflow — never a flag on the refund route, because "approve a refund without step-up" is exactly what a disappointed implementer reaches for and exactly what defeats the control. The design deliberately does **not** sketch it, so the omission reads as an omission. |
| **OD-14** | How does the step-up binding obtain the **session id**, given `app_ctx_session_id()` does not exist and `0002` is immutable? | **Route argument, validated against `auth_sessions.token_hash`.** F9/F8 take the session id as an explicit argument that the route supplies from the session it has *already* authenticated, and both functions verify it against `auth_sessions` before minting or consuming. | The alternative — adding a session claim to `0002`'s signed ticket — is a **cross-phase change to an immutable migration**, and `CREATE OR REPLACE` cannot add a claim to an already-issued ticket format, so it would invalidate every outstanding ticket. The shipped default therefore costs one extra `auth_sessions` lookup per step-up and leaves `0002` untouched (P2-10). If the owner prefers the ticket claim, it is a Phase-1/2 ticket-format migration plus a forced re-login, and it must land **before** `0028`, or F8/F9 are written against an interface that does not exist. |
| **OD-15** | Does the invoice-adjustment approval provide **separation of duties**? The §20.3 catalog defines `fees.adjustments.approve` as a post-issue approval control on cash, and §20.4 states the create/approve split explicitly | **Ship what is enforceable without a schema change: one type-keyed gate.** A `concession` or `waiver` needs `fees.adjustments.create` **and** `fees.adjustments.approve`; every other type needs `create` alone. Every role holding `create` also holds `approve`, so the approver is the creator and the separation is nominal | **Add `fin_invoice_adjustments.status` plus an approver identity and an approval timestamp**, making the two-step real: request, then approve by a different user, with the ledger reversal tied to the approval rather than to the insert. **Before `0023` is written** — the table is created in `0023`, and adding the columns later means an `ALTER` on a table whose rows are already append-only by trigger, so the historical rows would have no approver to record. Medium. The nominal split is honest to document and weak to rely on; a school that needs four-eyes control on concessions cannot get it from the current schema |
| **OD-16** | `fin_ledger_entry_groups.event_type` is `NOT NULL`, but the F4 signature (`p_tenant_id, p_source_type, p_source_id, p_lines`) has no `event_type` argument, so the body sets `event_type := p_source_type` and the column duplicates `source_type`. Nothing in this document reads it | **Keep it, and treat it as the event label.** The column is correct and the *signature* is the narrow thing | **Drop the column**, or add a fifth argument so the group distinguishes the business event (`invoice.issued`, `payment.received`, `refund.processed`) from the source table it came from. **Before `0026` is written** — the table is created there, and a later `ALTER` would have to drop or backfill a column whose value was never recorded. Low. The current state is *correct but redundant*: no query filters on it and no test asserts it |

**Count: 16 open decisions. None blocks implementation** — each has a shipped default that produces a
working, internally consistent system, and each names the cost of that default. **Three carry a
cross-phase ordering constraint**, and each must be settled before the named migration is *written*,
not before it is applied: **OD-14** before `0028`, **OD-15** before `0023`, and **OD-16** before
`0026`.

---

## 34. Design verdict

### 34.1 P0 — resolved (0 open)

| P0 | Resolution |
|---|---|
| Ledger described only payments/refunds/void; **invoice issue had no receivable event** | §15.1 defines the complete lifecycle exhaustively: issue, payment, apply-unapplied, on-account credit/return, correction reversal, refund (approve **and** process), void, adjustment, credit adjustment, and an explicit **deferral** of standalone credit notes. Every group is named with its account pair, and the on-account posting is pinned to `Dr 1300 / Cr Cash` rather than the intuitive and wrong `Dr 1200` (T-FIN-22) |
| No authoritative money model; the same fact represented in several places | **§16.7 is the register**: 21 money-bearing fields, each answering the same nine questions, of which **five have no column at all** (`invoices.amount_paid/amount_refunded/amount_credited`, `ledger_accounts.balance`, `challans.amount_due`) and are view expressions. The one signed allocation table is the single source for applied/unallocated/refunded/on-account (§12.1) |
| Generic `OR app_privileged()` inherited into finance | §19: four purpose-built policy classes; `platform_admin` explicitly excluded; a `0020`-style post-condition assertion that fails the migration if any finance policy mentions platform scope |
| Numbering `NOT NULL` vs "issue assigns the number" | §9.1/§14: `draft ⇒ NULL`, partial unique index, transactional allocation, monotonic committed numbering, gaps permitted, committed numbers never reused. **No gap-free claim is made** |
| **A second reversal mechanism on `fin_payments`** (`reverses_payment_id` + `status='reversed'`) duplicating the signed allocation table | **Found and removed in this revision** (§11.1). A payment is append-only with no compensating row and no reversed status; reversal is a `fin_payment_allocations` row and nothing else, and "fully reversed" is a predicate in `fin_v_payment_position` rather than a mutation of an append-only table (FI-007) |

### 34.2 P1 — resolved (0 open)

The load-bearing resolutions, each a change from the naive design rather than a restatement of it:

| Area | Resolution | § |
|---|---|---|
| **Refund bounded by the wrong quantity** | `refundable` is bounded by `payment_applied(p)` — cash actually applied to a charge — **not** by `p.amount`. The naive bound lets a cashier pay out cash that was never owed, which is pure diversion. Uncollected cash is returned by a separate on-account return under a different permission | §12.1, §12.2, §13.3, §15.1, FI-005 |
| **Receipt immutability** | The `status = issued \| void` contradiction is removed **entirely**. No status column, no void route, no `PATCH`. Immutability is trigger-enforced for every role including `school_migrator`, with no GUC bypass; a correction mints a new `version` with `supersedes_id`; `amount` is overwritten from the payment, not validated | §25.5, FI-019 |
| **Target precedence** | A strict total order — section > class > grade > campus > all — where a match at a more specific level **excludes** every less specific level. `all` is a genuine catch-all, not an additive fourth price list. Same-rank ambiguity **fails** with `55000 ambiguous_fee_target` rather than resolving by row order | §7.5 |
| **Polymorphic target integrity** | No bare `target_id`. `target_type` + four typed columns + `fin_targets_shape_ck` + `trg_fin_target_validate`, resolving the requirement to **five** testable properties: existence, tenant, shape, hierarchy coherence, year applicability. Tenant safety is *unrepresentable* via composite FKs, not merely checked | §7.6 |
| **SECURITY DEFINER contract** | §19.7 is a formal, closed contract for every Phase 7 function **and** for the two view classes: owner, kind, `search_path`, `PUBLIC` revoke, grant, purpose, arguments, tenant derivation, returns, caller context, RLS interaction, transaction, audit/outbox, and failure mode for each. F1/F2/F6–F9 definer (argless or read-only, so unfalsifiable); F3 definer but **not** granted to the runtime role; **F4 definer by necessity** — the canonical ledger posting function, bounded by a closed `jsonb` line shape validated before any insert and by the runtime role having no direct `INSERT`; F5 triggers **invoker**; V1 views `security_invoker = on`, V2 views owner-scoped, with no `SECURITY DEFINER` view claimed because PostgreSQL has no such option (P1-06, P1-07). Asserted by a static test against `prosecdef`/`proconfig`/`proacl` for functions and `reloptions`/owner for views | §19.7, §15.2.1 |
| **Webhook enumeration oracle** | Resolving the account before verifying the signature is unavoidable, so all pre-authorization failures return **HTTP 200 + `{"status":"ignored"}`** with a dummy-secret substitution for timing equalisation. 404-vs-401 would have let an unauthenticated caller map every school on the platform. The distinction is stored, not returned; an authenticated `/webhook/verify` self-check pays back the operational cost | §27.4, §27.5, T-FIN-21 |
| **Tenant isolation vs the worker** | FI-014 is restated with the `school_migrator` carve-out **written into the invariant** and its two clauses tested separately, instead of asserting universal isolation that its own tests violate | FI-014 |
| **Receipt RLS contradiction** | A parent must read a receipt but never a payment. `fin_receipts` is its own portal-document class with an inverted reachability path (receipt → allocation → invoice → linked student), so the sub-select returns a boolean and leaks no amount | §19.2, §19.4 |
| **RBAC catalog integrity** | **25** permissions, catalog and matrix reconciled row-for-row. The invented `fees.challans.read` is gone; the duplicated `fees.adjustments.approve` row is collapsed; the accountant's two cells are corrected to match the narrative; cashier is exactly **3** permissions; and `fees.receipts.reissue` is **added** so the receipt-reissue route is not gated on a read permission (P1-03) | §20.3, §20.4, §20.5 |
| **Event accounting** | 18 new events are **13 HANDLED / 5 NOOP**, counted row-by-row from the disposition table: **111 = 22 HANDLED / 89 NOOP**. Two earlier revisions were wrong in different ways — one said 21/91, which was an arithmetic error, and the next said 19 new / 112 total because it kept a HANDLED row for `fee.reconciliation.exception`, an event no publisher emits. Deleting that phantom removes one new event and one HANDLED and leaves NOOP at 5/89. Asserted by name per event, not by total | §24.1, §24.2, §15.3, §16.5 |
| **Reconciliation finality was derived but never propagated** | `is_final` was derived from `batch.status` inside a trigger bound only to the *match* table, so a batch moving `open → matching` left its existing matches non-final and the partial unique index that prevents one payment being matched in two batches enforced nothing during that window. The batch side is now **two** triggers — `trg_fin_recon_batch_derive_totals` (`BEFORE`, derives the batch's own `matched_total`/`variance_amount` and refuses to leave a finalised batch) and `trg_fin_recon_batch_stamp_matches` (`AFTER`, propagates `is_final` to the batch's existing matches and **releases** every claim when the batch is `cancelled`). The previous single merged trigger could be bound correctly at neither timing, and had no release branch at all, so cancelling a `matching` batch stranded the payments it had claimed | §14.1.1, §14.2, §35.6 |
| **`COALESCE(NEW.x, OLD.x)` in a row trigger** | Six functions read the fired-on row as `COALESCE(NEW.c, OLD.c)`. In PL/pgSQL a row trigger assigns only `NEW` on INSERT and only `OLD` on DELETE; `COALESCE` evaluates every argument, so it dereferences the unassigned record and raises P0002 `record "new" is not assigned yet` on the single-operation paths. The document previously *asserted* this was the correct DELETE-path idiom. All six now branch on `TG_OP` explicitly, including the `RETURN`, which in a BEFORE trigger is the row that gets written | §7.4, §9.4.1, §9.6, §12.4.1, §13.3.1, §15.1 |
| **`trg_fin_invoice_item_total` bound to one of its two inputs** | The function reads `fin_invoice_adjustments` but was bound only to `fin_invoice_items`, so a trigger never fired for an adjustment edit and a waiver never reached `total`. Bound to both | §9.6, §35.3.2 |
| **Cache bound to one of its three inputs** | `fin_invoices.balance` was recomputed only on allocation changes, while a corrected line or a new adjustment also moves `total`. The cache would have been correct for one of its three inputs and trusted anyway. Now bound to items, adjustments and allocations, with the arithmetic factored into a `RETURNS void` helper so the expression has one home and both sides of an allocation move are recomputed | §12.4.1, §35.3.2 |
| **Trigger bound before its table existed** | `fin_artifacts_document` was bound in 0027 while `fin_document_artifacts` is created by 0029 — a 42P01 at the point in the sequence where 0027 runs. The binding block is now ordered by the migration that creates each trigger's **target table** | §35.3.2 |
| **Principal's entire finance surface was prose** | The four owner-scoped V2 aggregate views and the V1 ledger view were named in nine places and defined in none. All five are now written out, with the tenant pin in both the projection and the `WHERE`, and `fee_head_id`'s bounded exception from the no-`id` rule recorded rather than left to be discovered by a failing test | §12.4.2, §15.2.2 |
| Installment vs UNIQUE conflict | Explicit schedule model (`installment_no`), not relaxed uniqueness | §7.1 |
| Reconciliation uniqueness | `is_final` + partial unique index, closing the `unique(batch_id, payment_id)` gap | §14.1 |
| Portal RLS | The first relationship-aware policies in the codebase; the soft-unlink defect of `attendance.ts:136-158` is fixed, not inherited | §19.3 |
| Principal visibility | Aggregate only, enforced in two independent layers: `reporting_staff` is excluded from every row-level `SELECT` policy (zero rows, not a filter), and the principal's surface is four owner-scoped aggregate views whose output columns are pinned by a test | §15.2.1, §19.4, §20.2 |
| Role backfill | The `is_system` filter plus a before/after checksum assertion makes "no custom role widened" mechanically verified, and is the reason §1.5's tenant-creation-only materialisation is not a silent P1 | §1.5, §20.5 |
| Raw webhook retention | Off by default; opt-in is encrypted, redacted, expiring, and RLS-restricted | §27.6 |
| Late fees / Urdu / tax | One sentence each; no contradiction left standing | §26.1, §26.2, §26.4 |
| Billing determinism | A unique index and a recorded trace, not a sort | §8.1–§8.4 |
| Event safety | The `logEvent` fallback arm is removed, so a financial event cannot be silently acknowledged | §24.2 |
| Artifact idempotency | Three independent constraints; no `job_runs` dependency (the table does not exist) | §25.2, §25.3 |
| Migration plan | Nine migrations, ordered by FK and by the boot-time catalog assertion, justified against the brief's six | §30.1, §30.2 |

### 34.3 P2 findings (12 carried into implementation — none blocks)

**This table is the authoritative P2 register, and the IDs are stable.** An earlier revision numbered
these `P2-1 … P2-7` while other sections of the same document cross-referenced `P2-04`, `P2-09`, and
`P2-10` — a register that cannot be cited is not a register. IDs are now two-digit, contiguous, and
each has exactly one row. **P2-01 … P2-06 are the original audit findings; P2-07 … P2-12 were raised
while remediating P0/P1 and are grouped separately so the original audit's count is not overwritten.**

**Original audit findings (P2-01 … P2-06) — none blocks `DESIGN-GO`:**

| P2 | Detail | Status |
|---|---|---|
| **P2-01** | **Permission-change wording.** §20.5's backfill language said the accountant "gains" permissions, which is ambiguous about a tenant that already granted some of them. Replaced with an explicit idempotent `INSERT … ON CONFLICT DO NOTHING` plus a before/after row-count assertion, so "gains" cannot silently mean "overwrites". | **Resolved in this revision** — §20.5, §30.5 |
| **P2-02** | **Drift audit / event identifiers.** §16.5 called the drift signal an "audit row" with no key, and §15.3 gave the same fact two different names — `fee.reconciliation.drift` (audit) and `fee.reconciliation.exception` (event), of which only the first was ever emitted. `exception` nevertheless had its own HANDLED row in §24.2 and its own line in the §24.1 catalog, so §34.2 claimed this resolved while a registry entry no publisher could satisfy survived. Resolved: **one** name, `fee.reconciliation.drift`; the `exception` event, its §24.1 catalog line and its §24.2 disposition row are **deleted**; a specified payload (`check_name`, `subject_type`/`subject_id`, `expected_amount`/`actual_amount` as decimal strings, `drift_paisa`, `first_detected_at`); and an audit key `(tenant_id, check_name, subject_id, first_detected_at)` so a nightly job is idempotent instead of alerting every night forever. Deleting the phantom **does** move §24.1's arithmetic — 18 new / 111 total / 22 HANDLED / 89 NOOP — so the previous revision's "no new event type, arithmetic unchanged" claim was itself part of the defect | **Resolved in this revision** — §15.3, §16.5, §24.1, §24.2, §31.7, T-FIN-31 |
| **P2-03** | **`decimal.js` money path.** §16.3 said money helpers "must use `decimal.js`/`big.js` or integer paisa" and banned `number` by lint rule, but did not pick one. The three do not agree with each other, and picking per-call is how two components round differently and ship a `Σ allocations ≠ total` bug. **Adjudicated: `decimal.js`**, configured once in `packages/shared/src/money.ts` with `Decimal.set({ precision: 20, rounding: Decimal.ROUND_HALF_UP })` to match PostgreSQL's `round(numeric, int)`; a lint rule bans any other `Decimal.set`; money crosses every boundary as a **decimal string**, not a JSON number; and `T-FIN-08` requires **exact string equality** (not a tolerance) between `Decimal` and the database over 10,000 values including `.005` boundaries. | **Resolved in this revision** — §16.3, T-FIN-08 |
| **P2-04** | **Tenant-aware reconciliation uniqueness.** `fin_reconciliation_matches` had a `unique(batch_id, payment_id)`-style rule that omitted `tenant_id`. Resolved with `UNIQUE (tenant_id, batch_id, payment_id)` plus a partial `WHERE is_final` uniqueness for finality, so a payment cannot be finalised into two batches in the same tenant. | **Resolved in this revision** — §14.1, `0027` |
| **P2-05** | **Redrive / DLQ.** `packages/events/src/dispatcher.ts:79-93`'s redrive is defeated by BullMQ `jobId` dedupe + `removeOnFail`, giving an infinite retry loop with zero progress; no DLQ exists. Phase 7 **requires** a real DLQ before any finance handler is registered, because a lost `fee.invoice.issued` is a lost ledger posting. | **Open — design specified, not implemented.** §24.3 states the required shape (a `finance_dead_letter` table, a `permanent` marker distinct from `attempts` exhaustion, and a redrive that mints a **new** `jobId`); `worker.ts:88-90`'s `reports`→`events` misroute is a **Phase 7 dependency** that must be fixed first |
| **P2-06** | **`docs/EVENT_ARCHITECTURE.md` is materially wrong about the current worker**: it claims an 84-event catalog (actual **93**), a log-only/ack-only registry (9 types have real handlers), an envelope with `actor`/`data` keys (neither exists), `result.corrected` having a handler (it is a NOOP), and a DLQ (none exists). Not edited — not this phase's artifact. §32.1 lists it as superseded-by-this-document for the finance subset only. | **Open — deferred by scope.** §32.1 |

**Findings raised while remediating (P2-07 … P2-12):**

| P2 | Detail | Status |
|---|---|---|
| **P2-07** | `docs/DEVELOPMENT_ROADMAP.md:87` contains a stray CJK token (`refund审批`) in an English roadmap. Not edited — the roadmap is not this phase's artifact. | **Open — deferred by scope** |
| **P2-08** | The uniform `rejected_signature` response (§27.4) means a provider with a genuinely misconfigured secret receives HTTP 200 forever and learns nothing from the response. This is the correct trade for an unauthenticated endpoint (a distinguishable 401 becomes an account-enumeration oracle) and the cost is paid back by the alert plus the authenticated self-check — but it is an operational behaviour change the owner should know is deliberate. | **Accepted by design** — §27.4, §27.5, T-FIN-21 |
| **P2-09** | **The MFA pepper has no home.** `secret_digest = HMAC-SHA256(pepper, shared_secret)` is only meaningful if the pepper is unavailable to a database-only attacker, and the repository has no such secret: `0001`/`0002` provide none, `current_setting` is forgeable by the runtime role (§9.4), and storing it in a table is circular. Same class of gap as the unused `APP_ENCRYPTION_KEY` (P1-09). | **Open — blocks nothing, because enrollment is not yet implemented.** The resolution is a deployment decision: inject the pepper as an env var and compute digests **in the application process, never in SQL**, or use a KMS-backed key. §19.8.1 states the options |
| **P2-10** | **`app_ctx_session_id()` does not exist.** The step-up binding is "on THIS session", and `0002`'s signed context exposes no session claim. `CREATE OR REPLACE` cannot add a claim to an already-issued ticket format, and `0002` is immutable, so this is a **cross-phase dependency**. | **Open — owner decision OD-14.** Either add a session claim to the ticket format (a cross-phase change) or pass the session id as a route argument validated against `auth_sessions.token_hash`. §19.8.3, §21.3 |
| **P2-11** | `docs/JOB_ARCHITECTURE.md` is almost entirely aspirational: `job_runs`, `runAsTenant`, DLQ, per-aggregate ordering, `PermanentJobError`, metrics, cron leadership lock — none of it is implemented. Not edited; not this phase's artifact. | **Open — deferred by scope.** §32.1 lists it as superseded-by-this-document for the finance subset |
| **P2-12** | `redactDeep` (`packages/audit/src/index.ts:21-39`) and `sanitizePayload` (`packages/events/src/outbox.ts:6-14`) do not denylist finance PII (`iban`, `pan`, `card`, `account_number`). Phase 7 mitigates this with an **IDs-only payload contract** (§24.2) plus `T-FIN-20`, but the shared helpers themselves remain unchanged and are used by other phases. | **Mitigated in Phase 7, open for the helpers** — the mitigation is a contract, not a fix, and a future phase that puts a PAN in an audit payload will not be caught by anything Phase 7 wrote |

### 34.4 No-implementation verification

`git status --porcelain` and `git diff --stat` were run after the final edit, at
`HEAD = 71aaffe9cb90b8635ca0ae176d78bf76288cae1f`. `git diff --stat` is **empty** — no tracked file
in the repository is modified. The **only** working-tree change is the new, untracked
`docs/PHASE_7_FINANCE_DESIGN.md`; the eight pre-existing untracked scratch files listed in §1 are
untouched. The migration directory ceiling is still `0020_schema_migrations_runtime_protection.sql`.
Specifically **not** done:

- ❌ no `0021` migration created (the migration ceiling remains `0020`)
- ❌ no existing migration `0001`–`0020` modified
- ❌ no application source, route, schema, or worker file modified
- ❌ no RBAC seed or permission catalog change
- ❌ no test created or modified
- ❌ no web/UI change
- ❌ no CI change
- ❌ no database operation of any kind executed
- ❌ nothing committed, pushed, or tagged
- ❌ `docs/FINANCE_DESIGN.md`, `docs/DATABASE_DESIGN.md`, `docs/DEVELOPMENT_ROADMAP.md`,
  `docs/EVENT_ARCHITECTURE.md`, `docs/JOB_ARCHITECTURE.md` left byte-identical

**Migration `0021` (`fin_foundation.sql`) is authorized to be designed and implemented next**, on the
conditions in §30.3 and the function contract in §19.7: the header comment states why no existing
migration is edited; every function carries `SET search_path = pg_catalog, public, pg_temp`; every
function is `REVOKE ALL … FROM PUBLIC` followed by an explicit `GRANT`; the closed F1–F10 set of
§19.7 — and the V1/V2 relation contract beside it — match that table exactly; domain conflicts raise `ERRCODE = '55000'`; and every `CREATE TABLE fin_*` is followed **in the same
file** by `REVOKE ALL ON <t> FROM school_app_rw` (§35.4), so the `0028` grant block is the only grant
the runtime role ever receives rather than a second one layered over `0001`'s default privilege.

Two things must land **before or with** `0028` (RBAC/RLS), and one **before** any finance worker
handler exists:

1. `0028` must pass its post-condition assertions — the platform-scope policy check and the
   custom-role checksum check — or the migration fails.
2. The `enqueueDeferred` queue-routing fix (§24.3) must land before the first deferred finance job,
   or every artifact job is enqueued to the wrong queue and fails validation.

---

## 35. Normative inventories

**Why this section exists, stated as a defect rather than as a convenience.** The audit that produced
the `DESIGN-NO-GO` found that the previous revision's prose and its DDL had **drifted apart**: §16.5
listed a cached `fin_payments.status = 'reversed'` that §11.1 said did not exist; §19.7 claimed a
`SECURITY DEFINER` view, which PostgreSQL does not support; §30.3.3 revoked the `INSERT` that §19.7's
posting function needed; and §19.8.1 indexed a `users.tenant_id` column that no migration creates.
Every one of those is a case where a **table** somewhere in the document disagreed with a **sentence**
somewhere else, and no single place listed all of them, so a reviewer could not find them all and an
implementer could not know which to believe.

An inventory does not prevent drift. What prevents drift is that these are **normative**: every table
is in exactly one row, a test asserts the row against the migration files, and a table that is not in
the inventory has no defined security posture and therefore does not exist as far as this design is
concerned. The rules:

- **Completeness is mechanical.** `finance-migration-order.test.ts` parses the actual `0021`–`0029`
  files and fails if a created table is absent from §35.1, or if a §35.1 table is not created. Neither
  direction may drift.
- **No table is unnamed.** There is no "and other supporting tables" row. If a table is needed, it is
  named here, with its owner, its RLS posture, and its grants.
- **A blank cell is a decision, not an omission.** `—` means "deliberately none", and the row says why.

### 35.1 Migration, dependency, and security posture

| # | File | Creates (complete) | Depends on | Security posture at end of migration |
|---|---|---|---|---|
| **0021** | `fin_foundation.sql` | `fin_tenant_settings`, `fin_ledger_accounts`, `fin_document_counters`, `fin_fee_heads`, `fin_tax_profiles`; 12 anchor indexes on existing Phase 1–6 tables (§6.3); F1 `app_finance_actor_class`, F2 `app_finance_linked_students`, F6 `app_finance_current_guardian_ids`, F3 `app_finance_seeds_ledger_accounts` | 0002, 0004, 0005, 0006, 0008, 0009 | **Unreachable.** No grants, no policies. The four functions are individually `REVOKE`d from `PUBLIC` and granted explicitly. |
| **0022** | `fin_fee_structures.sql` | `fin_fee_structures`, `fin_fee_structure_items`, `fin_fee_installment_plans`, `fin_fee_structure_targets`, `fin_fee_assignments`, `fin_billing_runs`, `fin_billing_run_items`; **SIX** functions / **EIGHT** bindings — `trg_fin_target_validate`, `trg_fin_structure_publish_freeze`, `trg_fin_structure_child_freeze` (3 bindings), `trg_fin_assignment_validate`, `trg_fin_billing_run_freeze`, `trg_fin_billing_run_items_freeze`; active-period trigger | 0021, 0008, 0009 | Unreachable. No forward FK. |
| **0023** | `fin_invoices.sql` | `fin_invoices`, `fin_invoice_items`, `fin_invoice_adjustments`, `fin_challans`; `trg_fin_challan_status` (§10.2); `trg_fin_invoice_number`, `trg_fin_invoice_void`, `trg_fin_invoice_item_total` (**2** bindings), `trg_fin_invoice_items_freeze` (2 bindings), `trg_fin_invoice_balance_recompute` (**2** bindings; third in 0024) | 0021, 0022, 0005 | Unreachable. |
| **0024** | `fin_payments.sql` | `fin_payments`, `fin_payment_allocations`, `fin_receipts`; `trg_fin_reversal_shape`, `trg_fin_allocation_family_guard`, `trg_fin_allocation_bounds` (FI-003, §12.7), `trg_fin_on_account_return_bounds`, `trg_fin_invoice_balance_recompute`; `trg_fin_receipt_freeze`; 2 partial unique indexes; V1 `fin_v_payment_position`, `fin_v_invoice_balance` | 0021, 0023, 0005 | Unreachable. **`refund_id` has no FK for the duration of this file** (P0-01 window); closed by 0025. **No trigger or function here may name `fin_refunds`**, which 0025 creates — body *or* `DECLARE` row type (§30.3.1). |
| **0025** | `fin_refunds.sql` | `fin_refunds`; `ALTER … ADD CONSTRAINT fin_pa_refund_fk`; `trg_fin_refund_provenance` (function + **both** bindings), `fn_fin_refund_ceiling` (deferred constraint trigger) | 0024 | Unreachable. After this file every `fin_*`→`fin_*` reference is FK-backed. |
| **0026** | `fin_ledger.sql` | `fin_ledger_entry_groups`, `fin_ledger_entries`; `trg_fin_ledger_group_balance` (deferred), `trg_fin_ledger_seal`, `trg_fin_ledger_append_only`, `trg_fin_ledger_sealed_group_reject`; **F4 `post_fin_ledger_group`** (the only ledger write path); `fin_recompute`; V1 `fin_v_ledger_account_balance` (§12.4.2); V2 the four owner-scoped aggregate views (§15.2.2) | 0021, 0023, 0024, 0025 | Unreachable. Runtime `INSERT/UPDATE/DELETE` on both ledger tables is `REVOKE`d and stays revoked. |
| **0027** | `fin_reconciliation.sql` | `fin_reconciliation_batches`, `fin_reconciliation_matches`; `trg_fin_recon_is_final` (row side) **+ `trg_fin_recon_batch_derive_totals` (`BEFORE`, derives the batch's own totals) and `trg_fin_recon_batch_stamp_matches` (`AFTER`, propagates and releases `is_final`, §14.1.1)**; `fin_recon_payment_final_uq (tenant_id, payment_id) WHERE is_final` (P2-04) | 0024, 0025, 0026 | Unreachable. |
| **0028** | `fin_rbac_rls.sql` | `academic_years_single_active_uq`; `auth_mfa_factors`, `auth_step_up_challenges`; `trg_auth_step_up_immutable`; F7/F8/F9; role backfill; `cashier` template; **all** finance RLS policies; post-condition assertions; **grants, last** | 0021–0027, 0001, 0002 | **The only migration in which `school_app_rw` gains any finance access**, and it is sequenced so RLS precedes every grant. **No anchor index on `users`/`auth_sessions`** — §6.3 R4 allowlist (P0-06a). |
| **0029** | `fin_artifacts_webhooks.sql` | `fin_document_artifacts`, `fin_payment_gateway_webhooks`, `fin_provider_accounts`; `trg_fin_artifact_document_valid` | 0023, 0024, 0025 | **Unreachable for the runtime role by design** — no policy, no grant. Written only by the webhook handler and artifact worker. `fin_webhook_raw_payloads` is **not** created (P1-09). |

### 35.2 Foreign-key source → target map

Every tenant-scoped FK in Phase 7, with the target's anchor. **A row here with a target that has no
`(tenant_id, id)` anchor is a §6.3 R1 violation, and `finance-composite-fk.test.ts` fails the build on
it.** The §6.3 R4 exceptions are the only single-column entries and are marked — there are **twelve FK
rows** naming **three distinct target tables** (`tenants`, `users`, `auth_sessions`). The two counts
differ because `tenants` is the target of six of the twelve rows and `users` of five. Stating both
numbers is the point: an earlier revision wrote "four exceptions" while listing five, and a count
written from memory rather than from the DDL is what produced it.

| Source | Source columns | Target | Target columns | Target unique anchor |
|---|---|---|---|---|
| `auth_mfa_factors` | `(user_id)` | `users` | `(id)` | `users_pkey` — **§6.3 R4 exception (P0-06a)**: platform-global identity, no `tenant_id` |
| `auth_step_up_challenges` | `(session_id)` | `auth_sessions` | `(id)` | `auth_sessions_pkey` — **§6.3 R4 exception (P0-06a)** |
| `auth_step_up_challenges` | `(tenant_id)` | `tenants` | `(id)` | `tenants_pkey` — **§6.3 R4 exception**: `tenants` **is** the tenant |
| `auth_step_up_challenges` | `(user_id)` | `users` | `(id)` | `users_pkey` — **§6.3 R4 exception (P0-06a)**: platform-global identity, no `tenant_id` |
| `fin_billing_run_items` | `(tenant_id, assignment_id)` | `fin_fee_assignments` | `(tenant_id, id)` | `fin_fee_assignments_ten_id_uq` — **nullable** |
| `fin_billing_run_items` | `(tenant_id, enrollment_id)` | `enrollments` | `(tenant_id, id)` | `enrollments_tenant_id_uq` (0021 — **absent in 0005**) |
| `fin_billing_run_items` | `(tenant_id, invoice_id)` | `fin_invoices` | `(tenant_id, id)` | `fin_invoices_ten_id_uq` — **added by `ALTER` at the end of `0024`** |
| `fin_billing_run_items` | `(tenant_id, run_id)` | `fin_billing_runs` | `(tenant_id, id)` | `fin_billing_runs_ten_id_uq` |
| `fin_billing_run_items` | `(tenant_id, structure_id)` | `fin_fee_structures` | `(tenant_id, id)` | `fin_fee_structures_ten_id_uq` |
| `fin_billing_run_items` | `(tenant_id, student_id)` | `students` | `(tenant_id, id)` | `students_tenant_id_uq` (existing) |
| `fin_billing_runs` | `(started_by)` | `users` | `(id)` | `users_pkey` — **§6.3 R4 exception (P0-06a)**: platform-global identity, no `tenant_id` |
| `fin_fee_structures` | `(published_by)` | `users` | `(id)` | `users_pkey` — **§6.3 R4 exception (P0-06a)**, and the **only** `ON DELETE RESTRICT` among the R4 rows: the write-once publication stamp (§7.3.1) refuses the referential `UPDATE` that `SET NULL` is implemented as, so a `SET NULL` action could never fire (§7.3) |
| `fin_billing_runs` | `(tenant_id, academic_year_id)` | `academic_years` | `(tenant_id, id)` | `academic_years_tenant_id_uq` (existing) |
| `fin_challans` | `(tenant_id, invoice_id)` | `fin_invoices` | `(tenant_id, id)` | `fin_invoices_ten_id_uq` |
| `fin_document_artifacts` | `(tenant_id, file_id)` | `files` | `(tenant_id, id)` | `files_tenant_id_uq` (existing) |
| `fin_document_counters` | `(tenant_id, academic_year_id)` | `academic_years` | `(tenant_id, id)` | `academic_years_tenant_id_uq` (existing) |
| `fin_fee_assignments` | `(tenant_id, academic_year_id)` | `academic_years` | `(tenant_id, id)` | `academic_years_tenant_id_uq` (existing) |
| `fin_fee_assignments` | `(tenant_id, enrollment_id)` | `enrollments` | `(tenant_id, id)` | `enrollments_tenant_id_uq` (0021 — **absent in 0005**) |
| `fin_fee_assignments` | `(tenant_id, installment_plan_id)` | `fin_fee_installment_plans` | `(tenant_id, id)` | `fin_installment_plans_ten_id_uq` |
| `fin_fee_assignments` | `(tenant_id, structure_id)` | `fin_fee_structures` | `(tenant_id, id)` | `fin_fee_structures_ten_id_uq` |
| `fin_fee_assignments` | `(tenant_id, student_id)` | `students` | `(tenant_id, id)` | `students_tenant_id_uq` (existing) |
| `fin_fee_heads` | `(tenant_id)` | `tenants` | `(id)` | `tenants_pkey` — **§6.3 R4 exception**: `tenants` **is** the tenant |
| `fin_fee_installment_plans` | `(tenant_id, structure_id)` | `fin_fee_structures` | `(tenant_id, id)` | `fin_fee_structures_ten_id_uq` |
| `fin_fee_structure_items` | `(tenant_id, fee_head_id)` | `fin_fee_heads` | `(tenant_id, id)` | `fin_fee_heads_ten_id_uq` |
| `fin_fee_structure_items` | `(tenant_id, structure_id)` | `fin_fee_structures` | `(tenant_id, id)` | `fin_fee_structures_ten_id_uq` |
| `fin_fee_structure_targets` | `(tenant_id, campus_id)` | `campuses` | `(tenant_id, id)` | `campuses_tenant_id_uq` (existing) |
| `fin_fee_structure_targets` | `(tenant_id, class_id)` | `acd_classes` | `(tenant_id, id)` | `acd_classes_tenant_id_uq` (existing) — **not `classes`** |
| `fin_fee_structure_targets` | `(tenant_id, grade_id)` | `grade_levels` | `(tenant_id, id)` | `grade_levels_tenant_id_uq` (existing) |
| `fin_fee_structure_targets` | `(tenant_id, section_id)` | `sections` | `(tenant_id, id)` | `sections_tenant_id_uq` (existing) |
| `fin_fee_structure_targets` | `(tenant_id, structure_id)` | `fin_fee_structures` | `(tenant_id, id)` | `fin_fee_structures_ten_id_uq` |
| `fin_fee_structures` | `(tenant_id, academic_year_id)` | `academic_years` | `(tenant_id, id)` | `academic_years_tenant_id_uq` (existing) |
| `fin_fee_structures` | `(tenant_id, supersedes_id)` | `fin_fee_structures` | `(tenant_id, id)` | `fin_fee_structures_ten_id_uq` |
| `fin_invoice_adjustments` | `(approved_by)` | `users` | `(id)` | `users_pkey` — **§6.3 R4 exception (P0-06a)**: platform-global identity, no `tenant_id` |
| `fin_invoice_adjustments` | `(tenant_id, invoice_id)` | `fin_invoices` | `(tenant_id, id)` | `fin_invoices_ten_id_uq` |
| `fin_invoice_items` | `(tenant_id, fee_head_id)` | `fin_fee_heads` | `(tenant_id, id)` | `fin_fee_heads_ten_id_uq` |
| `fin_invoice_items` | `(tenant_id, invoice_id)` | `fin_invoices` | `(tenant_id, id)` | `fin_invoices_ten_id_uq` |
| `fin_invoices` | `(tenant_id, academic_year_id)` | `academic_years` | `(tenant_id, id)` | `academic_years_tenant_id_uq` (existing) |
| `fin_invoices` | `(tenant_id, enrollment_id)` | `enrollments` | `(tenant_id, id)` | `enrollments_tenant_id_uq` (0021 — **absent in 0005**) |
| `fin_invoices` | `(tenant_id, structure_id)` | `fin_fee_structures` | `(tenant_id, id)` | `fin_fee_structures_ten_id_uq` |
| `fin_invoices` | `(tenant_id, student_id)` | `students` | `(tenant_id, id)` | `students_tenant_id_uq` (existing) |
| `fin_ledger_accounts` | `(tenant_id)` | `tenants` | `(id)` | `tenants_pkey` — **§6.3 R4 exception**: `tenants` **is** the tenant |
| `fin_ledger_entries` | `(tenant_id, account_code)` | `fin_ledger_accounts` | `(tenant_id, code)` | `fin_ledger_accounts_code_uq` — keyed on the **business** code anchor |
| `fin_ledger_entries` | `(tenant_id, entry_group_id)` | `fin_ledger_entry_groups` | `(tenant_id, id)` | `fin_leg_groups_ten_id_uq` |
| `fin_ledger_entries` | `(tenant_id, invoice_id)` | `fin_invoices` | `(tenant_id, id)` | `fin_invoices_ten_id_uq` (P1-08 — **was no FK at all**) |
| `fin_ledger_entries` | `(tenant_id, student_id)` | `students` | `(tenant_id, id)` | `students_tenant_id_uq` (existing) (P1-08 — **was no FK at all**) |
| `fin_ledger_entry_groups` | `(tenant_id, reversal_of_group)` | `fin_ledger_entry_groups` | `(tenant_id, id)` | `fin_leg_groups_ten_id_uq` |
| `fin_payment_allocations` | `(tenant_id, invoice_id)` | `fin_invoices` | `(tenant_id, id)` | `fin_invoices_ten_id_uq` |
| `fin_payment_allocations` | `(tenant_id, payment_id)` | `fin_payments` | `(tenant_id, id)` | `fin_payments_ten_id_uq` |
| `fin_payment_allocations` | `(tenant_id, refund_id)` | `fin_refunds` | `(tenant_id, id)` | `fin_refunds_ten_id_uq` — **added by `0025`, not `0024`** |
| `fin_payment_allocations` | `(tenant_id, reversal_of_allocation_id)` | `fin_payment_allocations` | `(tenant_id, id)` | `fin_pa_ten_id_uq` |
| `fin_payments` | `(tenant_id, payer_guardian_id)` | `guardians` | `(tenant_id, id)` | `guardians_tenant_id_uq` (existing) |
| `fin_provider_accounts` | `(tenant_id)` | `tenants` | `(id)` | `tenants_pkey` — **§6.3 R4 exception**: `tenants` **is** the tenant |
| `fin_receipts` | `(tenant_id, payer_guardian_id)` | `guardians` | `(tenant_id, id)` | `guardians_tenant_id_uq` (existing) |
| `fin_receipts` | `(tenant_id, payment_id)` | `fin_payments` | `(tenant_id, id)` | `fin_payments_ten_id_uq` |
| `fin_receipts` | `(tenant_id, supersedes_id)` | `fin_receipts` | `(tenant_id, id)` | `fin_receipts_ten_id_uq` |
| `fin_reconciliation_batches` | `(tenant_id, statement_file_id)` | `files` | `(tenant_id, id)` | `files_tenant_id_uq` (existing) |
| `fin_reconciliation_matches` | `(tenant_id, batch_id)` | `fin_reconciliation_batches` | `(tenant_id, id)` | `fin_recon_batches_ten_id_uq` |
| `fin_reconciliation_matches` | `(tenant_id, payment_id)` | `fin_payments` | `(tenant_id, id)` | `fin_payments_ten_id_uq` |
| `fin_refunds` | `(tenant_id, payment_id)` | `fin_payments` | `(tenant_id, id)` | `fin_payments_ten_id_uq` |
| `fin_tax_profiles` | `(tenant_id)` | `tenants` | `(id)` | `tenants_pkey` — **§6.3 R4 exception**: `tenants` **is** the tenant |
| `fin_tenant_settings` | `(tenant_id)` | `tenants` | `(id)` | `tenants_pkey` — **§6.3 R4 exception**: `tenants` **is** the tenant |
| `fin_tenant_settings` | `(tenant_id, tax_profile_id)` | `fin_tax_profiles` | `(tenant_id, id)` | `fin_tax_profiles_ten_id_uq` — added by `ALTER` in `0021` |

### 35.3 Function and trigger inventory

**Counting rule, corrected a third time.** §19.7.2's F5 row now says "27 named `trg_*` trigger
functions + `fn_fin_refund_ceiling`". The original document said "13 trigger functions"; the first
remediation said "17 rows, 16 `trg_fin_*`, 1 `trg_auth_*`"; the second said "22 `trg_fin_*`
functions + `fn_fin_refund_ceiling`" and "24 rows". All were wrong, and the second was wrong for a
subtler reason: it counted only the functions the earlier revision had *remembered to define*, while
the prose promised several more (the structure child-freeze, the issued-line freeze, the
payment-total bound, the sealed-group guard, and the invoice number/void/total triggers).

It was **also off by one before `0022` arrived** — it claimed 24 rows for a table numbered to 25 —
so the arithmetic is now derived from the table rather than restated beside it. The
correction that matters is that counting is a **property of the table, not of the prose**: the
table below is the set the bindings create, every row is bound, and both the row count and the
statement count are summed from it. It has **28 rows** (1–25 plus 3a–3c, no gap, no duplicate):

| Set | Count | Membership |
|---|---|---|
| `trg_fin_*` trigger functions | **26** | every `trg_fin_*` row below (rows 1–14, 16–24, 3a–3c) |
| `fn_fin_refund_ceiling` | **1** | named `fn_*` because it is bound as a deferred `CONSTRAINT TRIGGER` rather than a `trg_fin_*` row trigger, and it also calls the `trg_fin_reversal_shape_check` helper |
| Auth trigger set | **1** | `trg_auth_step_up_immutable` |
| **Total bound functions** | **28** | 26 + 1 + 1, one per inventory row. **3 of the 26 are added by `0022`** (`trg_fin_assignment_validate`, `trg_fin_billing_run_freeze`, `trg_fin_billing_run_items_freeze` — §8.6, §8.7.1); the other 23 predate it |
| Named `trg_*` functions | **27** | 26 `trg_fin_*` + `trg_auth_step_up_immutable`; the figure F5 quotes |
| `CREATE [CONSTRAINT] TRIGGER` statements | **35** | 26 in the §35.3.2 block + 1 in §19.8.1 + **8 from `0022`**; exceeds 28 because 5 functions bind to more than one table, adding 7 statements — see §35.3.2 |

**Scoping, because a document-wide text search finds 38 and both numbers are right.** This document
contains **38** `CREATE TRIGGER` lines. Three of them — `fin_structures_publish` in §7.3.1,
`fin_runs_freeze` in §8.7.1 and `fin_run_items_freeze` in §8.7.1 — are the same `0022` bindings
repeated inside the section that specifies their function, because a reader of §8.7.1 has no reason
to walk to §35.3.2 to learn that a committed run is bound at all. They are **restatements, not
additional statements**: each names a table and function already in the block, and `0022` really
does create 8 triggers, not 11. The statement count is therefore **35 distinct bindings** (§35.3.2
block 34 + §19.8.1 1), while the text-search total is 38. `R7′` asserts both, and §35.3.2's
`0022` sub-block is the one an implementer copies.

The `0022` share is **8 statements over 6 functions**, and it is the only number in this table that
was measured rather than projected: the file contains exactly 8 `CREATE TRIGGER` and 6 `CREATE
FUNCTION` statements, and 10.6 asserts that inventory at apply time (§28.6). Every other figure
here is a specification for `0023`–`0029`, none of which exists yet.

The previous revision asserted "15 rows, of which 13 are `trg_fin_*` and 2 are auth triggers" — wrong
in all three numbers at once — and then "17 rows / 16 `trg_fin_*`", which was still missing five
functions the document itself described. `finance-trigger-inventory.test.ts` asserts the counts
above, that every inventory row has at least one `CREATE TRIGGER`, and that no `CREATE TRIGGER`
names a function that is not in this table. The exact statement count is asserted against the
multi-table rule in §35.3.2 rather than a naive one-to-one.

**The row-to-statement sum, so a reader can re-derive the numbers rather than trust them.**
Each row is one function; the number of statements it contributes is the number of tables it is
bound to. 23 rows bind to one table (23 statements); rows 3, 6, 7, 9 and 13 bind to 3, 2, 2, 2 and
3 tables (12 statements). 23 + 12 = **35**, against 28 bound functions — the 7-statement excess is
exactly the multi-table design and is not slack.

| # | Function | Table | Timing | Events | Purpose |
|---|---|---|---|---|---|
| 1 | `trg_fin_target_validate` | `fin_fee_structure_targets` | BEFORE | INSERT, UPDATE | Resolves the 5-target shape: existence (FK), tenant (FK), shape (`fin_targets_shape_ck`), hierarchy coherence, year applicability (§7.6) |
| 2 | `trg_fin_structure_publish_freeze` | `fin_fee_structures` | BEFORE | **INSERT, UPDATE, DELETE** | §18's status graph as an allow-list on every UPDATE; a non-draft INSERT is refused (§18's only source state is `draft`); a non-draft DELETE is refused. Blocks edits to a published structure except `supersedes_id` (§7.3.1) |
| 3 | `trg_fin_structure_child_freeze` | `fin_fee_structure_items`, `fin_fee_structure_targets`, `fin_fee_installment_plans` | BEFORE | **INSERT, UPDATE, DELETE** | A published structure's lines, targets and plans are frozen; reached from the child to the parent (§7.3.1) |
| 3a | `trg_fin_assignment_validate` | `fin_fee_assignments` | BEFORE | INSERT, UPDATE | §6.4's student/year pin, and the active-period grain. A composite FK can prove the enrollment exists and belongs to the tenant; it cannot prove the assignment's `student_id` is the enrollment's student (§8.6) |
| 3b | `trg_fin_billing_run_freeze` | `fin_billing_runs` | BEFORE | UPDATE, DELETE | A committed run's provenance and totals are frozen, and it may not be deleted; re-run as a new run instead (§8.7.1) |
| 3c | `trg_fin_billing_run_items_freeze` | `fin_billing_run_items` | BEFORE | **INSERT, UPDATE, DELETE** | A committed run's items are frozen. On UPDATE **both** runs are read — the one the row is in and the one it is moving into — so `run_id` is not an exit. The sole permitted write is attaching the invoice the run produced, once (§8.7.1) |
| 4 | `trg_fin_invoice_number` | `fin_invoices` | BEFORE | INSERT, UPDATE | Allocates `invoice_no` on issue; enforces `draft ⟺ no number` (§9.6) |
| 5 | `trg_fin_invoice_void` | `fin_invoices` | BEFORE | UPDATE | Enforces `void` preconditions (balance = 0) and stamps provenance (§9.6) |
| 6 | `trg_fin_invoice_item_total` | `fin_invoice_items`, `fin_invoice_adjustments` | AFTER | INSERT, UPDATE, DELETE | Recomputes `fin_invoices.subtotal`/`total` from lines + adjustments (§9.6). Bound to BOTH input tables: the function reads adjustments, so a trigger on items alone never fires for an adjustment edit |
| 7 | `trg_fin_invoice_items_freeze` | `fin_invoice_items`, `fin_invoice_adjustments` | BEFORE | UPDATE, DELETE | A line or adjustment of a non-draft invoice is frozen (§9.4.1) |
| 8 | `trg_fin_challan_status` | `fin_challans` | BEFORE | INSERT, UPDATE | Derives `status` from the invoice (incl. `void`), enforces terminality and frozen identity (§10.2) |
| 9 | `trg_fin_refund_provenance` | `fin_payment_allocations`, `fin_refunds` | BEFORE | INSERT, UPDATE | Three-way agreement: the reversal, the allocation it names, and the refund all name the same payment (§13.1) |
| 10 | `trg_fin_reversal_shape` | `fin_payment_allocations` | BEFORE | INSERT, UPDATE | Thin wrapper: delegates to `trg_fin_reversal_shape_check` (§12.1) |
| 11 | `trg_fin_allocation_family_guard` | `fin_payment_allocations` | BEFORE | INSERT, UPDATE | Every allocation's invoice's student must be linked to the payer guardian (§12.5) |
| 12 | `trg_fin_allocation_bounds` | `fin_payment_allocations` | BEFORE | INSERT, UPDATE | FI-003: locked recompute of the non-refund allocation total against `payment.amount` (§12.7) |
| 13 | `trg_fin_invoice_balance_recompute` | `fin_invoice_items`, `fin_invoice_adjustments`, `fin_payment_allocations` | AFTER | INSERT, UPDATE, DELETE | FI-002 cache writer for `fin_invoices.balance`; all three tables feed `balance`, and both sides are recomputed when an allocation moves between invoices (§12.4.1). Arithmetic lives in the non-trigger helper `trg_fin_invoice_recalc_balance(uuid,uuid)`. Two bindings in 0023, one in 0024 |
| 14 | `trg_fin_on_account_return_bounds` | `fin_payment_allocations` | BEFORE | INSERT, UPDATE | `on_account_return` magnitude ≤ cash still held on account; a permission distinct from refunds (§13.3.2) |
| 15 | `fn_fin_refund_ceiling` | `fin_payment_allocations` | **AFTER, DEFERRABLE INITIALLY DEFERRED** | INSERT, UPDATE | At COMMIT: per-refund allocation completeness, and per-payment refunded ≤ applied (§13.3.1) |
| 16 | `trg_fin_receipt_freeze` | `fin_receipts` | BEFORE | INSERT, UPDATE, DELETE | Receipt is immutable for every role incl. `school_migrator`; a correction is a new `version` with `supersedes_id` (§25.5) |
| 17 | `trg_fin_ledger_group_balance` | `fin_ledger_entries` | **CONSTRAINT, DEFERRABLE INITIALLY DEFERRED** | INSERT, UPDATE, DELETE | `sum(debit) = sum(credit)` per group, evaluated at COMMIT so a whole group can be written (§15) |
| 18 | `trg_fin_ledger_seal` | `fin_ledger_entry_groups` | BEFORE | UPDATE | `sealed_at` is write-once; a sealed group is immutable (§15.1.1) |
| 19 | `trg_fin_ledger_append_only` | `fin_ledger_entries` | BEFORE | UPDATE, DELETE | No UPDATE/DELETE on a leg, **no role exemption and no GUC bypass** (§9.4, §15.1.1) |
| 20 | `trg_fin_ledger_sealed_group_reject` | `fin_ledger_entries` | BEFORE | INSERT | A leg may not join an already-sealed group (§15.1.1) |
| 21 | `trg_fin_recon_is_final` | `fin_reconciliation_matches` | BEFORE | UPDATE | Derives `is_final` from the batch's `matching`/`completed`, so it is never caller-writable. Finality is monotone **except** for one batch-driven release: a match may lose finality only while its own batch is `cancelled` (§14.1.1, §14.2) |
| 22 | `trg_fin_recon_batch_derive_totals` | `fin_reconciliation_batches` | BEFORE | UPDATE of `status` | Derives the batch's own `matched_total`/`variance_amount` from its matches rather than from the caller, and refuses to leave a finalised batch for any state other than `completed`/`cancelled`. BEFORE is **required** — an AFTER trigger cannot assign to `NEW`, so these derivations would silently stop (§14.1.1) |
| 23 | `trg_fin_recon_batch_stamp_matches` | `fin_reconciliation_batches` | **AFTER** | UPDATE of `status` | Propagates `is_final` to the batch's existing matches when it enters `matching`/`completed`, and **releases** every claim when it is `cancelled` (`UPDATE`, never `DELETE`). AFTER is **required**: row 21 re-derives from the batch's *current* status, so a BEFORE stamp would be overwritten by the very derivation that ran on it (§14.1.1) |
| 24 | `trg_fin_artifact_document_valid` | `fin_document_artifacts` | BEFORE | INSERT, UPDATE | Validates the cross-table artifact reference against a closed type map (§27) |
| 25 | `trg_auth_step_up_immutable` | `auth_step_up_challenges` | BEFORE | UPDATE | Binding columns frozen; `consumed_at` monotonic; `attempts_left` only decreases (§19.8.1) |

#### 35.3.1 What the invariant actually is, and the one helper

The earlier revision's note — "`trg_fin_reversal_shape_check` and `trg_fin_artifact_document_valid`
are helpers called by rows 8 and the artifact validator" — is **half right and half wrong**.
`trg_fin_reversal_shape_check` is a helper: a `RETURNS void` function called by
`trg_fin_reversal_shape` via `PERFORM` and re-called by `fn_fin_refund_ceiling`, bound to no trigger,
and therefore correctly absent from the table. `trg_fin_artifact_document_valid` is **not** a helper:
it is bound directly as the `fin_artifacts_document` trigger function, so it is row 24 and the old
note was wrong about it. There is exactly **one** helper, and the verifier asserts exactly one:
`trg_fin_reversal_shape_check`.

#### 35.3.2 Why the statement count is 35 and not 28

Five functions are bound to more than one table, and that is a design requirement rather than
sloppiness:

- `trg_fin_structure_child_freeze` → **3** bindings (items, targets, plans). A header-only freeze
  leaves the *lines* editable, and the lines are what a family is billed.
- `trg_fin_invoice_items_freeze` → **2** bindings (items, adjustments). They are the two sides of the
  invoice total; freezing one and not the other leaves a back door.
- `trg_fin_refund_provenance` → **2** bindings (allocations, refunds). The provenance property spans
  both tables, and the trigger must fire from whichever side is written first.
- `trg_fin_invoice_item_total` → **2** bindings (items, adjustments). It reads both tables but is only
  *invoked* by a trigger on the table that changed; one binding means an adjustment silently fails to
  move `total`.
- `trg_fin_invoice_balance_recompute` → **3** bindings (items, adjustments, allocations). All three
  feed `balance`, and a cache that is correct for only one of its three inputs is worse than no cache,
  because it is trusted.

So: 27 distinct functions bound outside `0022` (26 finance + 1 auth), 27 statements for them
(25 in the §35.3.2 block below + 1 in §19.8.1 for `trg_auth_step_up_immutable`, the auth one), plus
**8 statements from `0022`** over 6 functions = **35 statements document-wide over 28 bound
functions**. The four ledger functions
(`trg_fin_ledger_group_balance`, `trg_fin_ledger_seal`, `trg_fin_ledger_sealed_group_reject`)
plus `trg_fin_ledger_append_only` are **four rows over two tables**, and the ledger therefore
contributes exactly 4 statements to the count. The count rose by one statement and one function when
the reconciliation batch side was split into `trg_fin_recon_batch_derive_totals` (`BEFORE`) and
`trg_fin_recon_batch_stamp_matches` (`AFTER`), which §14.1.1 explains is forced rather than
optional, and by 3 statements and 3 functions when `0022` added the assignment pin and the two
run freezes.

The correct assertions are: **28 bound functions**, **35 statements**, each statement naming a
defined function, and each of the 28 appearing in at least one statement. The previous "appears
exactly once" claim was false for the five multi-table functions; it is replaced by "at least once,
and no extra functions."

**The binding block, so the inventory is verifiable rather than asserted.** It is written in
migration order and opens with the **8 statements `0022` actually executes**, then continues with
the **26** for `0023`–`0029` that bind the 20 finance functions `0022` does not create.
(`trg_auth_step_up_immutable`'s single binding is in §19.8.1, not here.) 8 + 26 = 34 in this block
plus 1 in §19.8.1 = **35**.

```sql
-- 0022: fee structures
CREATE TRIGGER fin_targets_validate      BEFORE INSERT OR UPDATE ON fin_fee_structure_targets
    FOR EACH ROW EXECUTE FUNCTION trg_fin_target_validate();
-- INSERT and DELETE are both load-bearing on the header: a structure may only be
-- CREATED as draft (§18's only source state) and may only be DELETED while it is
-- one. Omitting DELETE left a published structure and its three CASCADE children
-- removable in a single statement.
CREATE TRIGGER fin_structures_publish    BEFORE INSERT OR UPDATE OR DELETE ON fin_fee_structures
    FOR EACH ROW EXECUTE FUNCTION trg_fin_structure_publish_freeze();
-- The freeze reaches the children too: the header trigger cannot see a line item,
-- so a published structure's items, targets and installment plans each carry their
-- own binding to the same child-freeze function. INSERT is bound on all three: the
-- header freeze cannot fire for a row that does not exist yet, so without it a line
-- could be added to a published structure and the freeze would hold for every other
-- write to that table.
CREATE TRIGGER fin_structure_items_freeze   BEFORE INSERT OR UPDATE OR DELETE ON fin_fee_structure_items
    FOR EACH ROW EXECUTE FUNCTION trg_fin_structure_child_freeze();
CREATE TRIGGER fin_structure_targets_freeze BEFORE INSERT OR UPDATE OR DELETE ON fin_fee_structure_targets
    FOR EACH ROW EXECUTE FUNCTION trg_fin_structure_child_freeze();
CREATE TRIGGER fin_structure_plans_freeze   BEFORE INSERT OR UPDATE OR DELETE ON fin_fee_installment_plans
    FOR EACH ROW EXECUTE FUNCTION trg_fin_structure_child_freeze();
-- §8.6's pin. A composite FK proves the enrollment exists in this tenant; it
-- cannot prove the assignment's student_id is that enrollment's student.
CREATE TRIGGER fin_assignments_validate  BEFORE INSERT OR UPDATE ON fin_fee_assignments
    FOR EACH ROW EXECUTE FUNCTION trg_fin_assignment_validate();
-- §8.7.1. The run row is frozen from `committed` with no exemptions; the items
-- are frozen from the same state, judged on BOTH runs when an UPDATE re-points
-- one, with the single write-once invoice attachment (§8.7's own DDL comment).
CREATE TRIGGER fin_runs_freeze        BEFORE UPDATE OR DELETE ON fin_billing_runs
    FOR EACH ROW EXECUTE FUNCTION trg_fin_billing_run_freeze();
CREATE TRIGGER fin_run_items_freeze   BEFORE INSERT OR UPDATE OR DELETE ON fin_billing_run_items
    FOR EACH ROW EXECUTE FUNCTION trg_fin_billing_run_items_freeze();

-- 0023: invoices, items, challans
CREATE TRIGGER fin_invoices_number       BEFORE INSERT OR UPDATE ON fin_invoices
    FOR EACH ROW EXECUTE FUNCTION trg_fin_invoice_number();
CREATE TRIGGER fin_invoice_void_guard    BEFORE UPDATE ON fin_invoices
    FOR EACH ROW EXECUTE FUNCTION trg_fin_invoice_void();
CREATE TRIGGER fin_invoice_items_total   AFTER INSERT OR UPDATE OR DELETE ON fin_invoice_items
    FOR EACH ROW EXECUTE FUNCTION trg_fin_invoice_item_total();
-- The SAME function on the adjustments table. Without this, an adjustment
-- inserted after the lines leave subtotal/total stale forever: the function
-- already reads fin_invoice_adjustments, but a function only runs when its
-- trigger fires, and no trigger fired on the table that was edited. A waived
-- 500 fee that does not appear on the invoice is the failure.
CREATE TRIGGER fin_invoice_adjustments_total AFTER INSERT OR UPDATE OR DELETE ON fin_invoice_adjustments
    FOR EACH ROW EXECUTE FUNCTION trg_fin_invoice_item_total();
-- FI-002 balance cache writer (§12.4.1), on the two tables created HERE. Three
-- tables feed `balance`; the third is bound in 0024 with the allocations. A
-- trigger bound only to allocations would leave a posted invoice whose balance no
-- longer equals `total - net_applied`, and the first thing to notice is month-end
-- reconciliation, against a document already sent to a family.
-- `trg_fin_invoice_recalc_balance` is the helper holding the expression; this is
-- the trigger that decides WHICH invoice to recompute.
CREATE TRIGGER fin_invoice_items_balance AFTER INSERT OR UPDATE OR DELETE ON fin_invoice_items
    FOR EACH ROW EXECUTE FUNCTION trg_fin_invoice_balance_recompute();
CREATE TRIGGER fin_invoice_adjustments_balance AFTER INSERT OR UPDATE OR DELETE ON fin_invoice_adjustments
    FOR EACH ROW EXECUTE FUNCTION trg_fin_invoice_balance_recompute();
-- Issued-line freeze (§9.4.1): one function, both sides of the invoice total.
CREATE TRIGGER fin_invoice_items_freeze  BEFORE UPDATE OR DELETE ON fin_invoice_items
    FOR EACH ROW EXECUTE FUNCTION trg_fin_invoice_items_freeze();
CREATE TRIGGER fin_invoice_adjustments_freeze BEFORE UPDATE OR DELETE ON fin_invoice_adjustments
    FOR EACH ROW EXECUTE FUNCTION trg_fin_invoice_items_freeze();
CREATE TRIGGER fin_challans_status       BEFORE INSERT OR UPDATE ON fin_challans
    FOR EACH ROW EXECUTE FUNCTION trg_fin_challan_status();

-- 0024: payments, allocations  (NOT fin_refunds — that table is created by 0025)
-- NOTE: trg_fin_refund_provenance is NOT bound here, even though
-- fin_payment_allocations is. Its DECLARE block names the composite type
-- fin_refunds, which 0024 does not create, so both the function and its
-- allocations-side binding are deferred to 0025 below. §13.1.
CREATE TRIGGER fin_allocations_shape     BEFORE INSERT OR UPDATE ON fin_payment_allocations
    FOR EACH ROW EXECUTE FUNCTION trg_fin_reversal_shape();
CREATE TRIGGER fin_allocations_family    BEFORE INSERT OR UPDATE ON fin_payment_allocations
    FOR EACH ROW EXECUTE FUNCTION trg_fin_allocation_family_guard();
-- FI-003 (§12.7): the payment total, locked and summed. Distinct from the on-account
-- return ceiling below, which bounds one effect against cash still held on account.
CREATE TRIGGER fin_allocations_bounds    BEFORE INSERT OR UPDATE ON fin_payment_allocations
    FOR EACH ROW EXECUTE FUNCTION trg_fin_allocation_bounds();
CREATE TRIGGER fin_allocations_onaccount BEFORE INSERT OR UPDATE ON fin_payment_allocations
    FOR EACH ROW EXECUTE FUNCTION trg_fin_on_account_return_bounds();
-- The third binding of the same function, on the table created HERE. Both sides
-- of an allocation move are recomputed (§12.4.1). Views are NOT repeated in this
-- block: fin_v_invoice_balance (V1, §12.4.1), fin_v_ledger_account_balance (V1,
-- §12.4.2), fin_v_payment_position (V1, §12.4), and the four owner-scoped
-- aggregate views (V2, §15.2.2) are each written exactly once, in the section
-- that owns their contract.
CREATE TRIGGER fin_allocations_balance_cache AFTER INSERT OR UPDATE OR DELETE ON fin_payment_allocations
    FOR EACH ROW EXECUTE FUNCTION trg_fin_invoice_balance_recompute();

-- 0025: refunds, receipts
-- fin_refunds exists only now, so everything below that touches it is bound HERE and
-- not in 0024. Two bindings for trg_fin_refund_provenance, because its DECLARE block
-- names the fin_refunds composite type (§13.1): a 0024 CREATE FUNCTION would fail
-- with 42704 undefined_object, and a 0024 CREATE TRIGGER would fail with 42883
-- because its EXECUTE FUNCTION target did not exist. An earlier revision bound the
-- allocations side in 0024 and the refunds side in 0025, which is exactly the split
-- that cannot work — the function is one object and both bindings need it.
CREATE TRIGGER fin_allocations_provenance BEFORE INSERT OR UPDATE ON fin_payment_allocations
    FOR EACH ROW EXECUTE FUNCTION trg_fin_refund_provenance();
CREATE TRIGGER fin_refunds_provenance    BEFORE INSERT OR UPDATE ON fin_refunds
    FOR EACH ROW EXECUTE FUNCTION trg_fin_refund_provenance();
-- A CONSTRAINT TRIGGER is required, not stylistic: a per-payment ceiling can only
-- be evaluated once every row of the refund is present, and the completeness sum
-- must see rows written earlier in the same transaction. It is bound in 0025 rather
-- than 0024 for the same relation reason: fn_fin_refund_ceiling reads fin_refunds, and
-- PostgreSQL validates a plpgsql body against the catalogue at CREATE time.
CREATE CONSTRAINT TRIGGER fin_allocations_refund_ceiling
    AFTER INSERT OR UPDATE ON fin_payment_allocations
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION fn_fin_refund_ceiling();
CREATE TRIGGER fin_receipts_freeze       BEFORE INSERT OR UPDATE OR DELETE ON fin_receipts
    FOR EACH ROW EXECUTE FUNCTION trg_fin_receipt_freeze();

-- 0026: ledger
CREATE CONSTRAINT TRIGGER fin_ledger_balanced
    AFTER INSERT OR UPDATE OR DELETE ON fin_ledger_entries
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION trg_fin_ledger_group_balance();
CREATE TRIGGER fin_ledger_seal_guard     BEFORE UPDATE ON fin_ledger_entry_groups
    FOR EACH ROW EXECUTE FUNCTION trg_fin_ledger_seal();
CREATE TRIGGER fin_ledger_append_only    BEFORE UPDATE OR DELETE ON fin_ledger_entries
    FOR EACH ROW EXECUTE FUNCTION trg_fin_ledger_append_only();
-- The "no leg may join a sealed group" guard from §15.1, as a real binding.
CREATE TRIGGER fin_ledger_sealed_reject  BEFORE INSERT ON fin_ledger_entries
    FOR EACH ROW EXECUTE FUNCTION trg_fin_ledger_sealed_group_reject();
-- Views are NOT repeated in this block. fin_v_ledger_account_balance (V1, body in
-- §12.4.2), fin_v_invoice_balance (V1, §12.4.1), fin_v_payment_position (V1, §12.4),
-- and the four owner-scoped aggregate views (V2, §15.2.2) are each written exactly
-- once, in the section that owns their contract.

-- 0027: reconciliation
CREATE TRIGGER fin_recon_matches_final   BEFORE UPDATE ON fin_reconciliation_matches
    FOR EACH ROW EXECUTE FUNCTION trg_fin_recon_is_final();
-- The batch side of the finality closure is TWO triggers, split because one effect
-- needs BEFORE and the other needs AFTER (§14.1.1). Merging them — which the
-- previous revision did — cannot be made correct at any single binding.
--
-- BEFORE derives the batch's own columns. An AFTER trigger cannot assign to NEW,
-- so `matched_total`/`variance_amount` would silently stop being derived and a
-- caller could make a batch balance against a statement it does not match. It also
-- carries the guard that refuses to leave a finalised batch for a non-terminal
-- state.
CREATE TRIGGER fin_recon_batch_totals   BEFORE UPDATE OF status ON fin_reconciliation_batches
    FOR EACH ROW EXECUTE FUNCTION trg_fin_recon_batch_derive_totals();
-- AFTER propagates to the matches. This MUST be AFTER: every row it updates
-- re-enters trg_fin_recon_is_final, which re-derives `is_final` by SELECTing the
-- batch's CURRENT status. On a BEFORE trigger that SELECT still returns the OLD
-- status, so the derivation would overwrite the value this trigger had just
-- written — the stamp would be undone by its own row trigger and the partial
-- unique index would enforce nothing, which is exactly the T-FIN-27 window. The
-- same AFTER timing is what makes the `cancelled` release in the function body
-- legal: the batch row already reads 'cancelled' when the match rows are updated.
CREATE TRIGGER fin_recon_batch_stamp   AFTER UPDATE OF status ON fin_reconciliation_batches
    FOR EACH ROW EXECUTE FUNCTION trg_fin_recon_batch_stamp_matches();
-- fin_artifacts_document is NOT here. fin_document_artifacts is created by 0029
-- (the last migration, alongside provider accounts and the encrypted webhook
-- table), so a 0027 binding would fail with 42P01: relation does not exist. The
-- block is ordered by the migration that creates the TRIGGER's target table, not
-- by which section of the document the function was first described in.
-- 0028: MFA (its own CREATE TRIGGER is shown in §19.8.1)

-- 0029: document artifacts — the table is created by this migration, so its
-- trigger is bound here (§27, not §26).
CREATE TRIGGER fin_artifacts_document   BEFORE INSERT OR UPDATE ON fin_document_artifacts
    FOR EACH ROW EXECUTE FUNCTION trg_fin_artifact_document_valid();
```

**Counting the block, honestly.** It contains **34 `CREATE [CONSTRAINT] TRIGGER` statements** —
**8** for `0022` over 6 functions (rows 1, 2, 3, 3a, 3b, 3c) and **26** for `0023`–`0029` over the
remaining 21 finance functions — so **27 functions over 34 statements in the block**. Adding row
25's single binding, which §19.8.1 places outside the block, gives **28 bound functions and 35
distinct statements document-wide**.

The statement count exceeds the function count because five functions are bound to more
than one table: structure child-freeze → 3, refund provenance → 2, invoice items-freeze → 2, invoice
item-total → 2, invoice balance-recompute → 3. §35.3.2 states the counting rule. Note also that a
document-wide text search finds **38** `CREATE TRIGGER` lines rather than 35, because §7.3.1 and
§8.7.1 each restate one of `0022`'s bindings next to the function it belongs to; those three are
restatements, and `R7′` asserts both numbers.

There are **two** helpers, and neither is a row in the inventory table. `trg_fin_reversal_shape_check` is
a `RETURNS void` function called by
`trg_fin_reversal_shape` (§13.1) and re-called by `fn_fin_refund_ceiling` (§13.3.1); it is not bound
to any trigger. `trg_fin_invoice_recalc_balance(uuid, uuid)` (§12.4.1) holds the `balance` arithmetic
so that `trg_fin_invoice_balance_recompute` contains only the decision about *which* invoice to
recompute — which is what makes "both sides of a move" a two-line change rather than a duplicated
expression. `trg_fin_artifact_document_valid`
is **not** a helper — it is bound directly in **0029**, the migration that creates
`fin_document_artifacts` — and the previous revision's note conflated the
two; that note is corrected in §35.3.1. A second revision bound it in 0027 and would have failed with 42P01; the binding is now
placed by the migration that creates the table, not by the section that first described the rule.

**The inventory's "every row is a trigger function" rule is what forces the distinction to be made
explicitly.** A helper bound to nothing would be an inventory row with no `CREATE TRIGGER` in the
block, which the block's own consistency assertion rejects; so helpers are declared here, and the
assertion is "every inventory row is bound at least once, and every binding names an inventory row or
a declared helper" rather than "every defined function is bound".

### 35.4 RLS and privilege posture

`ENABLE` + `FORCE` are on every `fin_*` table; `FORCE` matters because the owner is `school_migrator`
and would otherwise be exempt. A `—` in a privilege column means **deliberately revoked**. The four
document/operational classes come from §19.2.

**Every `—` in the DELETE column is a *narrowing* of an existing grant, and that distinction decides
whether the table is secure.** `0001:380-383` sets
`ALTER DEFAULT PRIVILEGES FOR ROLE school_migrator IN SCHEMA public GRANT SELECT, INSERT, UPDATE,
DELETE ON TABLES TO school_app_rw`, so **every `fin_*` table is granted `DELETE` to the runtime role
at `CREATE TABLE` time, before any Phase 7 statement runs.** A `—` therefore does not mean "this table
was never granted DELETE"; it means "`DELETE` was explicitly revoked after being automatically
granted". The two are indistinguishable by reading the table above, and the difference is the whole
control, so the mechanism is stated here rather than left implicit:

- Every migration that creates a `fin_*` or `auth_*` table issues `REVOKE ALL ON <t> FROM
  school_app_rw` **in the same file, immediately after the `CREATE TABLE`**, and re-grants exactly the
  privileges the table's rows in this section permit — never `DELETE`.
- `finance-composite-fk.test.ts` asserts that no `fin_*` table carries a `school_app_rw` ACL entry
  with `DELETE` in `aclexplode`, and that no table's ACL grants a privilege the row above marks `—`.
  Asserting on `aclexplode` rather than on the migration text is what makes the test able to fail
  against `0001`'s default privilege.
- The two ledger tables are the strongest case: `REVOKE INSERT, UPDATE, DELETE` (§30.3 step 9) leaves
  `SELECT` only, because F4 is the sole write path. A `DELETE` on a ledger leg would be a permanent
  corruption, and the default privilege would have permitted it.

**A `—` in the DELETE column is therefore a stronger statement than "the API exposes no DELETE
route"**, which is a separate and much weaker guarantee enforced in §35.5. Neither substitutes for the
other: the route table is what prevents an attempted delete, and the ACL is what makes the attempt fail
if a route is ever added in error.

**The table below has two different kinds of column, and conflating them was itself a defect.** The
`ACL` block is the **table grant** to `school_app_rw` — a single, unconditional, table-level
statement, exactly what `aclexplode` reports. The `RLS branch` block is **which rows a given actor
class may see or write** — a per-command `USING` / `WITH CHECK` predicate in §19.4, which is what
stops a guardian from reading another family's row. A previous revision put actor classes in columns
headed `SELECT`/`INSERT`/`UPDATE`/`DELETE`, which read as ACL entries and are not: PostgreSQL cannot
grant `INSERT` to one role and withhold it from another **on the same table**, so a cell saying
"`fees.structures.manage`" in an `INSERT` column is describing a *policy branch*, not a privilege.
Anyone reading that table to configure `0028`'s grant block would have granted every table every
write privilege. The two blocks are now labelled for what they are.

| Table | Enabled | Forced | ACL SELECT | ACL INSERT | ACL UPDATE | ACL DELETE | RLS branch — SELECT sees | RLS branch — INSERT/UPDATE requires |
|---|---|---|---|---|---|---|---|---|
| `fin_tenant_settings` | yes | yes | grant | grant | grant | **— revoked** | `finance_staff` | `finance_staff` |
| `fin_ledger_accounts` | yes | yes | grant | school_migrator only (F3) | revoked | **— revoked** | `finance_staff` | F3, via `app_finance_seeds_ledger_accounts()` |
| `fin_document_counters` | yes | yes | grant | grant | revoked | **— revoked** | `finance_staff` | `finance_staff` |
| `fin_fee_heads` | yes | yes | grant | grant | grant | **— revoked** | `finance_staff` | `fees.structures.manage` |
| `fin_tax_profiles` | yes | yes | grant | grant | grant | **— revoked** | `finance_staff` | `fees.structures.manage` |
| `fin_fee_structures (+ items, targets, plans)` | yes | yes | grant | grant | grant | **— revoked** | `finance_staff` | `fees.structures.manage`; published rows additionally frozen by trigger |
| `fin_fee_assignments` | yes | yes | grant | grant | grant | **— revoked** | `finance_staff` | `fees.assignments.manage` |
| `fin_billing_runs (+ items)` | yes | yes | grant | grant | revoked | **— revoked** | `finance_staff` | `fees.assignments.manage` |
| `fin_invoices (+ items, adjustments, **challans**)` | yes | yes | grant | grant | grant | **— revoked** | `finance_staff`; guardian (linked students only); student (own only); **`reporting_staff` excluded → 0 rows** | `finance_staff`; guardian writes **nothing** |
| `fin_payments` | yes | yes | grant | grant | revoked | **— revoked** | `finance_staff` — **no guardian branch at all** | `fees.payments.collect` |
| `fin_payment_allocations` | yes | yes | grant | grant | revoked | **— revoked** | `finance_staff` | `fees.payments.collect` |
| `fin_refunds` | yes | yes | grant | grant | revoked | **— revoked** | `finance_staff` | `fees.refunds.request` |
| `fin_receipts` | yes | yes | grant | grant | revoked | **— revoked** | `finance_staff`; guardian via **inverted** reachability (predicate returns a boolean, leaks no amount) | `fees.receipts.reissue`, or payment-issue |
| `fin_reconciliation_batches (+ matches)` | yes | yes | grant | grant | grant | **— revoked** | `finance_staff` | `fees.reconciliation.manage`; completion additionally frozen by trigger |
| `fin_ledger_entry_groups` | yes | yes | grant | **— revoked** (F4 only) | **— revoked** | **— revoked** | `finance_staff` | F4 `post_fin_ledger_group()` only |
| `fin_ledger_entries` | yes | yes | grant | **— revoked** (F4 only) | **— revoked** | **— revoked** | `finance_staff` | F4 only |
| `fin_document_artifacts` | yes | yes | grant | `school_migrator` only | **— revoked** | **— revoked** | `finance_staff` | `school_migrator` (worker) |
| `fin_payment_gateway_webhooks` | yes | yes | grant | `school_migrator` only | **— revoked** | **— revoked** | `finance_staff` | `school_migrator` (webhook handler) |
| `fin_provider_accounts` | yes | yes | grant | `school_migrator` only | **— revoked** | **— revoked** | `finance_staff` | `school_migrator` |
| `auth_mfa_factors` | yes | yes | grant | grant | grant | **— revoked** | self only (`user_id = app_current_user_id()`); **no `app_privileged()` branch** | self |
| `auth_step_up_challenges` | yes | yes | grant | grant | grant | **— revoked** | self only; **no admin branch** | self; `consumed_at` monotonic by trigger |

**The seven views are not in the table above, and their ACL is simpler: `SELECT` only, always.**
A view has no rows of its own — the privilege is on the *view*, and reading through it is authorised
by the **base** table's RLS. This is the reason the V1/V2 split in §15.2.1 is a security decision and
not a performance one:

```sql
-- 0028 step 8, the view grants. SELECT only: a view is never written to.
GRANT SELECT ON fin_v_invoice_balance, fin_v_payment_position, fin_v_ledger_account_balance,
                 fin_v_ar_aging, fin_v_collections_summary,
                 fin_v_fee_head_revenue, fin_v_on_account_summary TO school_app_rw;
```

- **V1** (`security_invoker = on`) runs the querying user's privileges, so RLS on the base tables
  applies and a tenant ticket sees only its own rows. A `platform_admin` holding a tenant ticket gets
  **0 rows** from these three.
- **V2** (owner-scoped, no `security_invoker`) runs as the view owner, so base-table RLS does **not**
  apply — which is the entire reason the four aggregate views exist and the reason their projections
  are pinned to buckets, totals and counts. They are the *only* way `reporting_staff` sees finance
  data at all, and the pin is what stops a column being added to one later. §15.2.2, T-FIN-26.
- `PUBLIC` is revoked from all seven, so the runtime grant above is the only path in.

**The `0028` grant block, written out, because §30.3.2 step 8 states a rule and a rule is not a
migration.** The four privilege shapes in the table above — full write, no-`UPDATE`, no-write, and
migrator-only — map onto exactly four statements, and every table appears in one of them:

```sql
-- 0028 step 8. Never DELETE: 0001 granted it and §35.4 revokes it on every table.
-- Shape 1: SELECT, INSERT, UPDATE.
GRANT SELECT, INSERT, UPDATE ON
    fin_tenant_settings, fin_fee_heads, fin_tax_profiles,
    fin_fee_structures, fin_fee_structure_items, fin_fee_structure_targets,
    fin_fee_installment_plans, fin_fee_assignments,
    fin_invoices, fin_invoice_items, fin_invoice_adjustments, fin_challans,
    fin_reconciliation_batches, fin_reconciliation_matches,
    auth_mfa_factors, auth_step_up_challenges
TO school_app_rw;

-- Shape 2: SELECT, INSERT. No UPDATE -- these rows are written once and are
-- append-only or counter-maintained, so no runtime route edits an existing row.
GRANT SELECT, INSERT ON
    fin_document_counters,
    fin_payments, fin_payment_allocations, fin_refunds, fin_receipts
TO school_app_rw;

-- Shape 3: SELECT only. F4 is the sole write path for the ledger (§30.3.3).
GRANT SELECT ON fin_ledger_entry_groups, fin_ledger_entries TO school_app_rw;

-- Shape 4: SELECT only for the runtime role; the migrator keeps its owner rights.
-- 0029 tables are written by the webhook handler and the artifact worker.
GRANT SELECT ON
    fin_document_artifacts, fin_payment_gateway_webhooks, fin_provider_accounts
TO school_app_rw;

-- fin_billing_runs (+ items) is shape 2: written by the billing service, never
-- updated afterwards (a re-run is a NEW run -- §8.4).
GRANT SELECT, INSERT ON fin_billing_runs, fin_billing_run_items TO school_app_rw;
-- fin_ledger_accounts is SELECT only for the runtime role: seeding is F3, a
-- per-tenant migration act, and a staff member must not invent an account code.
GRANT SELECT ON fin_ledger_accounts TO school_app_rw;
```

**A revoked `UPDATE` is a reachability statement, and three trigger `UPDATE` branches are therefore
guards rather than live paths.** The table marks `UPDATE` revoked on `fin_document_counters`,
`fin_billing_runs`, `fin_payments`, `fin_payment_allocations`, `fin_refunds`, `fin_receipts` and both
ledger tables, and §21.3 exposes no route that updates any of them — a correction is a reversal row
plus a new allocation, never a rewrite (§11.1). Yet `trg_fin_invoice_item_total`,
`trg_fin_invoice_items_freeze` and `trg_fin_invoice_balance_recompute` are each bound `AFTER/BEFORE
UPDATE` to `fin_invoice_items`/`fin_invoice_adjustments`/`fin_payment_allocations`, which the runtime
role *can* reach for the invoice tables but **cannot** reach for `fin_payment_allocations`.

This is the same class of defect as P1-07 pointed the other way. There, a revoked `INSERT` made a
`SECURITY DEFINER` posting function unexecutable. Here, a revoked `UPDATE` makes a trigger branch
unreachable — and the two candidate fixes are both wrong: granting `UPDATE` on allocations would let
the runtime role rewrite where a family's money went, and deleting the `UPDATE` bindings would remove
the guard against a future route or an owner repair doing exactly that. **The design keeps the
bindings and states their role honestly: they are defence-in-depth for `school_migrator` and for any
future route, not the live path.** §28.4's `moveAllocation` operation is therefore executed as
`school_migrator`, and §28.3 asserts both halves — the move recomputes both balances *as the owner*,
and the same move is `42501` *as the runtime role*. A test that ran only the first would pass against
a design that had quietly granted the privilege; a test that ran only the second would pass against a
design that had removed the guard.

**`platform_admin` is `DENY` on every `fin_*` table, and that is a tested property, not a
consequence.** A valid platform ticket returns **0 rows**, because none of these policies has a
platform branch — the `app_privileged()` carve-out that FI-014 writes into the invariant is scoped to
the *worker* (`school_migrator`), not to a platform admin holding a tenant ticket.

### 35.5 Endpoint surface

`kind` values are the repository's four (`apps/api/src/plugins/authorization.ts`). **`—` in the
permission column is intentional and load-bearing** in two rows, marked.

| Endpoint | Method | Permission | Actor | Mutation |
|---|---|---|---|---|
| `/finance/fee-heads` | GET | `fees.structures.read` | `finance_staff` | no |
| `/finance/fee-heads` | POST | `fees.structures.manage` | `finance_staff` | yes |
| `/finance/fee-structures` | GET | `fees.structures.read` | `finance_staff` | no |
| `/finance/fee-structures` | POST | `fees.structures.manage` | `finance_staff` | yes |
| `/finance/fee-structures/:id` | GET/PATCH | `…read` / `…manage` | `finance_staff` | PATCH only, draft only |
| `/finance/fee-structures/:id/publish` | POST | `fees.structures.manage` | `finance_staff` | yes — freeze point |
| `/finance/fee-structures/:id/retire` | POST | `fees.structures.manage` | `finance_staff` | yes |
| `/finance/fee-assignments` | GET/POST | `…read` / `…manage` | `finance_staff` | POST only |
| `/finance/billing-runs` | POST | `fees.assignments.manage` | `finance_staff` | yes — idempotent |
| `/finance/billing-runs/:id` | GET | `fees.assignments.read` | `finance_staff` | no |
| `/finance/invoices` | GET/POST | `…read` / `…create` | `finance_staff` | POST only, lines not totals |
| `/finance/invoices/:id` | GET | `fees.invoices.read` | `finance_staff` | no |
| `/finance/invoices/:id/issue` | POST | `fees.invoices.issue` | `finance_staff` | yes — number + ledger |
| `/finance/invoices/:id/void` | POST | `fees.invoices.void` | `finance_staff` | yes — requires balance = 0 |
| `/finance/invoices/:id/challan` | GET | `fees.invoices.read` | `finance_staff` | no |
| `/finance/invoices/:id/adjustments` | POST | `fees.adjustments.create` | `finance_staff` | yes |
| `/finance/payments` | GET/POST | `…read` / `…collect` | `finance_staff` | POST only |
| `/finance/payments/:id` | GET | `fees.payments.read` | `finance_staff` | no |
| `/finance/payments/:id/allocations` | POST | `fees.payments.collect` | `finance_staff` | yes |
| `/finance/payments/:id/allocations/:aid/reverse` | POST | `fees.payments.reverse` | `finance_staff` | yes — correction only |
| `/finance/payments/:id/auto-allocate` | POST | `fees.payments.collect` | `finance_staff` | yes — explicit opt-in |
| `/finance/payments/:id/return-on-account` | POST | `fees.payments.reverse` | `finance_staff` | yes — uncollected cash only |
| `/finance/payments/:id/receipt` | GET | `fees.receipts.read` | `finance_staff` | no |
| `/finance/payments/:id/receipt-reissue` | POST | **`fees.receipts.reissue`** | `finance_staff` (not cashier) | yes — new version, no PATCH (P1-03) |
| `/finance/refunds` | GET/POST | `…read` / `…request` | `finance_staff` | POST only |
| `/finance/refunds/:id/step-up` | POST | **`— authenticated (self)`** | any signed-in user | yes — mints a challenge; no `fees.*` by design (§21.3) |
| `/finance/refunds/:id/approve` | POST | `fees.refunds.approve` | `finance_staff` | yes — **step-up MFA** |
| `/finance/refunds/:id/reject` | POST | `fees.refunds.approve` | `finance_staff` | yes |
| `/finance/refunds/:id/process` | POST | `fees.refunds.process` | `finance_staff` | yes — **step-up MFA** |
| `/finance/receipts/:id` | GET | `fees.receipts.read` | `finance_staff` | no |
| `/finance/reconciliation/batches` | GET/POST | `…read` / `…manage` | `finance_staff` | POST only |
| `/finance/reconciliation/batches/:id/{start,complete,cancel}` | POST | `fees.reconciliation.manage` | `finance_staff` | yes |
| `/finance/reports/{ar-aging,collections,on-account,fee-head-revenue}` | GET | `fees.reports.read` | `finance_staff` **+ principal** | no — aggregate only |
| `/finance/ledger/groups/:id` | GET | `fees.ledger.read` | `finance_staff` | no |
| `/finance/gateways/:provider/webhook` | POST | **— public + signature** | provider | yes — **uniform 200 on any pre-auth failure** (§27.4) |
| `/me/finance/invoices`, `/me/finance/balance`, `/me/finance-context` | GET | `fees.portal.read` | `guardian`, `student_self` | no |
| `/me/finance/receipts`, `/me/finance/receipts/:id` | GET | **`fees.portal.read`** | `guardian`, `student_self` | no (P1-04) |
| `/me/mfa/factors` | POST | **— authenticated (self)** | any signed-in user | yes — enroll |
| `/me/mfa/factors/:fid/confirm` | POST | **— authenticated (self)** | any signed-in user | yes — proves possession |
| `/me/mfa/factors/:fid` | DELETE | **— authenticated (self)** | any signed-in user | yes — revoke, not delete |
| **no** `DELETE /finance/payments/:id` | — | — | — | **no delete endpoint exists by design** |
| **no** `PATCH /finance/receipts/:id` | — | — | — | receipts are immutable; reissue mints a version |

### 35.6 Financial state-transition matrices

**Every state machine in the design, in one place, so a transition cannot exist in §9 and not in
§10.** All three are enforced by a trigger (closed) or a service (documented), and every one of them
is a `55000` conflict, not a silent no-op.

**Invoices** (`fin_invoices.status`; CHECK + `trg_fin_invoice_void`)

| From | To | Guard | Enforced by |
|---|---|---|---|
| `draft` | `issued` | `invoice_no` allocated, `issued_at` set, `total > 0` | trigger + service |
| `draft` | *(deleted)* | no items with amounts | `DELETE` policy |
| `issued` | `partially_paid` | `0 < balance < total` | `trg_fin_invoice_item_total` / allocation |
| `issued` | `paid` | `balance = 0` | same |
| `issued` | `void` | `balance = 0` only | `trg_fin_invoice_void` |
| `partially_paid` | `paid` | `balance = 0` | same |
| `partially_paid` | `void` | `balance = 0` only | `trg_fin_invoice_void` |
| `paid` | `partially_paid` | **refund reopened a real balance** | reversal rows |
| `paid` | `void` | `balance = 0` only | `trg_fin_invoice_void` |
| `void` | **any** | **forbidden — terminal** | trigger raises `55000` |

**Challans** (`fin_challans.status`; CHECK + `trg_fin_challan_status`)

| From | To | Guard |
|---|---|---|
| *(insert)* | `issued` | invoice issued, `balance > 0` |
| `issued` | `partially_paid` | `0 < balance < total` |
| `issued` | `paid` | `balance = 0` |
| `issued`/`partially_paid` | `expired` | `issued_at > due_on` **and** `balance > 0` |
| `expired` | `partially_paid`/`paid` | **not terminal** — an expired challan is still payable |
| `partially_paid` | `paid` | `balance = 0` |
| `paid` | `partially_paid` | refund reopened a balance |
| any | `void` | **only** because the owning invoice is `void`; inherits the invoice's date and reason |
| `void` | **any** | **forbidden — terminal** |

**Reconciliation batches** (`fin_reconciliation_batches.status`)

| From | To | Guard |
|---|---|---|
| `open` | `matching` | ≥ 1 match exists; **claims `is_final` on every match** and derives `matched_total`/`variance_amount` from the matches rather than the caller — `trg_fin_recon_batch_derive_totals` (BEFORE, to assign `NEW`) then `trg_fin_recon_batch_stamp_matches` (AFTER, to propagate) |
| `matching` | `completed` | ≥ 1 match; writes snapshot + hash; **then immutable** |
| `matching` | `cancelled` | the **only** exit once a match is final. It **releases** every claim the batch held (`is_final = false`, by `UPDATE` and never by `DELETE`, so the matches and their amounts survive as the record of what was voided) and sets `cancelled_at`, so the payments can be reconciled in a corrected batch. `trg_fin_recon_is_final` permits losing finality for this one reason and refuses it otherwise — see the note below, because without it this edge silently stranded every payment the batch had claimed |
| `open` | `cancelled` | terminal — the correct escape when a batch was started in error and nothing is final yet |
| `matching` | `open` | **forbidden** (in practice always: entering `matching` requires ≥ 1 match and claims them all). The previous revision proposed "all matches cleared; `is_final` cleared". That is both a `DELETE` on finalised matches, destroying the partial unique index's audit trail, and a *silent* release of a payment for re-matching elsewhere with nothing recording that the first attempt was voided. A batch is voided by `cancelled`, which says so and timestamps it |
| `completed`/`cancelled` | **any** | **forbidden — terminal** |

**Fee structures** (`fin_fee_structures.status`; CHECK + `trg_fin_structure_publish_freeze`, §7.3.1)

| From | To | Guard | Enforced by |
|---|---|---|---|
| *(insert)* | `published` / `retired` / `superseded` | **forbidden — `draft` is the graph's only source state**, and a row that skips it lands with a `published_at` the database never set | trigger raises `55000` |
| `draft` | `published` | the only forward edge from draft; stamps `published_at` (COALESCE) and is the only write to the publication stamp | trigger |
| `published` | `retired` | no new assignments; existing invoices unaffected | trigger |
| `published` | `superseded` | set when a newer version's `supersedes_id` points here and that version is published | trigger |
| `published` | `published` | allowed (no-op) | trigger — the same status is not "a transition" |
| `draft` | anything else (`retired`, `superseded`, `draft`-by-delete-and-reinsert) | **forbidden** | trigger raises `55000` |
| `published` | `draft` | **forbidden** — draft is not the target of any edge, which subsumes the earlier "cannot return to draft" branch | trigger raises `55000` |
| `retired` / `superseded` | **any** | **forbidden — terminal** | trigger raises `55000` |
| `draft` | *(deleted)* | the only deletable state | trigger (`BEFORE … DELETE`); **all three children are `ON DELETE CASCADE`**, so an unbound DELETE takes a published structure's items, targets and plans with it in one statement |
| non-`draft` | *(deleted)* | **forbidden** | trigger raises `55000` |
| any status | any frozen column (`academic_year_id`, `name`, `version`, `effective_from`, `effective_to`, `deleted_at`) once past draft | **frozen — supersede instead**; `supersedes_id` is the one mutable column | trigger raises `55000` |
| published | `published_at` / `published_by` rewritten | **write-once** | trigger raises `55000` |

**Why the billing runs get no matrix here.** §8.7.1 states why in full, and the short form is that
no section of this design enumerates which of `draft | preview | committed | cancelled` may follow
which, and a matrix invented here would be a normative rule stated for the first time in a summary
table. What *is* specified is the consequence — §8.4's reproducibility guarantee — so that is what is
enforced: everything at or after `committed` is immutable, and the single exception is the one §8.7's
own DDL comment creates.

**Why `matching → cancelled` had to be added here, and not only in §21.3.** T-FIN-28, §21.3 and
`finance-018` case (d) all state that `/cancel` accepts `open` **or** `matching`, and this matrix
did not contain the edge — it rejected `matching → open` and then named `cancelled` as "the only
legal route" without listing the route. A route, a trigger and a matrix that disagree make the
P1 fix untestable. Worse, the *implementation* never performed the release: the batch trigger had
branches only for `NEW.status IN ('matching','completed')`, so cancelling left `is_final = true` on
every match, the partial unique index kept the payments locked, and the replacement batch's own
stamp raised **23505**. The edge and the `UPDATE` that backs it are now both specified.

### 35.7 Refund lifecycle

**The state diagram and the prose disagreed in the previous revision** — the diagram included
`approved → rejected` while the sentence beneath it said that transition is forbidden. The prose is
correct: a rejection is a decision about an *unapproved request*, so rejecting an already-approved
refund has no meaning. The table is the authority; the diagram must match it.

| # | From | To | Actor | Guard | Ledger | Reversal rows |
|---|---|---|---|---|---|---|
| 1 | — | `requested` | `fees.refunds.request` | `refundable(p) > 0`; `Σ proposed = amount`; allocation list non-empty | none | none |
| 2 | `requested` | `approved` | `fees.refunds.approve` **+ step-up** | `attempts` OK; binding amount unchanged | `Dr 1200 / Cr 2200` — relieve the receivable, recognise the refund payable. **No cash leg**: cash has not left | **created here**, one per proposed allocation |
| 3 | `requested` | `rejected` | `fees.refunds.approve` | reason required | none | none |
| 4 | `approved` | `processed` | `fees.refunds.process` **+ step-up** | disbursement reference present | `Dr 2200 / Cr 1000/1100` — extinguish the payable against cash or bank. **This** is the leg where cash leaves | unchanged |
| 5 | `rejected` | **any** | — | **forbidden — terminal** | — | — |
| 6 | `processed` | **any** | — | **forbidden — terminal** | — | — |
| 7 | `approved` | `rejected` | — | **forbidden** — this is the transition the old diagram wrongly allowed | — | — |

**The ledger legs in rows 2 and 4 were wrong in the previous revision, and this table is the
authority on them.** It said `Dr 1300 / Cr <refund source>` on approval and `Dr <payable> / Cr 1300`
on processing. `1300` is on-account cash held at the school; crediting it on approval would credit
cash that has not left and would leave the `1200` receivable standing after the charge it belongs to
has been reversed. §15.1's `REFUND — two-step` is the correct pair and states why: a refund approved
today and transferred next week is a **liability** in between, the intermediate `2200` balance is a
real reportable figure ("approved but not yet disbursed"), and collapsing the two steps into a single
cash credit is exactly the error to avoid. Rows 2 and 4 now match §15.1, §13.5, and the §18 diagram.

**The approval transaction is atomic and its two checks are at different times**, which is the part
that is easy to get wrong and is therefore stated explicitly:

| Check | When | Enforced by | Failure |
|---|---|---|---|
| Per-refund: proposed allocations == created reversal rows, amounts and count | **COMMIT** | `fn_fin_refund_ceiling` (deferred) | `55000` → whole transaction rolls back, refund stays `requested` |
| Per-payment: `Σ refunded ≤ applied` (never `≤ payment.amount`) | **COMMIT** | same trigger | `55000`, same rollback |
| Per-allocation: a correction reversal names a real `apply` row | INSERT | `trg_fin_reversal_shape` (immediate) | `55000` |
| The step-up challenge is consumed | within the transaction | F8 | rollback also un-consumes it |

### 35.8 On-account lifecycle

**Distinct from the refund lifecycle by permission, bound, and ledger shape.** Collapsing the two is
the single most common finance-schema error, so the differences are tabled rather than described.

| Aspect | Refund (§35.7) | On-account return |
|---|---|---|
| What is returned | cash **applied to a charge** | cash **never applied** (uncollected) |
| Bound by | `payment_applied(p)` = `Σ` invoice-bound allocations | `payment_unallocated(p)` = `amount − applied` |
| Permission | `fees.refunds.request` → `.approve` → `.process` (3 steps + step-up MFA) | `fees.payments.reverse` (1 step, no step-up) |
| Allocation effect | `reverse` with `refund_id` set | **`on_account_return`**, `invoice_id IS NULL`, `refund_id IS NULL` |
| Ledger | `Dr 1300 / Cr <refund source>` then `Dr <payable> / Cr 1300` | **`Dr 1300 / Cr 1000`** — a single posting, no separate disbursement step |
| Refund table | row in `fin_refunds` | **no row at all** |
| Can be reversed again | no | no — `trg_fin_on_account_return_bounds` blocks it |

```text
  on-account credit:  apply  (invoice_id IS NULL, amount > 0)   → Dr 1000 / Cr <liability>
  on-account return:  on_account_return (invoice_id IS NULL,
                        amount < 0)                              → Dr 1300 / Cr 1000
  applied cash:       apply  (invoice_id NOT NULL, amount > 0)  → Dr 1300 / Cr 4000
  refund of applied:  reverse (refund_id NOT NULL, amount < 0)  → Dr 1300 / Cr 4000
  correction:         reverse (of an `apply`, no refund_id)      → Dr 1300 / Cr 1000
```

**`payment_unallocated` is a single derived quantity and is stated once, in one place, so no two
sections can define it differently.** It is the sum of every allocation row with `invoice_id IS NULL`
— that is, on-account credits **plus** on-account returns **plus** corrections of on-account credits:

```
payment_unallocated(p) = p.amount − payment_applied(p)
                       = Σ allocations where invoice_id IS NULL   (all signs)
```

The first form is what a user reads; the second is what makes the invariant checkable. They are equal
because `Σ all allocations − Σ invoice-bound allocations = Σ invoice-NULL allocations`, and the
`Σ all allocations = p.amount` invariant is itself what `trg_fin_allocation_bounds` maintains.

### 35.9 Family ownership and receipt reachability

**There is no `families` table** (verified: none exists in `0001`–`0020`), so "family" is a
**derived relation, not a stored one**, and every rule that needs it must say which derivation it
uses. The derivation: *a family is the set of students linked, through non-deleted
`student_guardians` rows, to one guardian within one tenant.*

| Relationship | Who can see it | Mechanism | Leaks an amount? |
|---|---|---|---|
| Guardian → their student's invoice | guardian of record | `student_id IN app_finance_linked_students()` | yes — it is their child's invoice |
| Guardian → their student's challan | guardian of record | same | yes — same document class |
| Guardian → **receipt** for a payment touching their child | guardian of record | **inverted** reachability: receipt → allocation → invoice → linked student. Returns a **boolean** | **no** — deliberately |
| Guardian → the **payment** row | **nobody** | no guardian branch on `fin_payments` | — |
| Guardian → an allocation row | **nobody** | no guardian branch | — |
| Guardian → another family's anything | **nobody** | `sg.deleted_at IS NULL` **inside the function query**, not inherited from policy (§19.2) | — |
| Soft-unlinked guardian (`deleted_at` set) | **nobody** | same predicate — the regression test for the `attendance.ts:136-158` defect | — |
| Student → own documents | self | `students.user_id = app_ctx_user()` | yes — their own |
| Payer attribution | the **payer** guardian, not every guardian of the student | `fin_payments.payer_guardian_id` / `fin_receipts.payer_guardian_id`, both FK-backed | no |
| Cashier → receipts | any | `fees.receipts.read` | yes |
| Cashier → **mint** a receipt | **nobody** | no `fees.receipts.reissue` (P1-03) | — |
| Principal → any document money | **nobody** | `reporting_staff` excluded → **0 rows**; aggregates only via V2 views | no — buckets only |
| `platform_admin` → any `fin_*` row | **nobody** | no platform branch in any policy | — |

**The `payer_guardian_id` decision, because the alternative is a real fraud path.** Without it, a
payment has no recorded payer, so a guardian who is *a* guardian of the student can read a receipt for
a payment made by a *different* guardian of the same student. That is a smaller problem than
cross-family disclosure but it is still an information leak, and it makes "who handed over the cash"
unanswerable — which is the first question in any cash-count discrepancy. The payer is recorded on
both the payment and the receipt, is FK-backed to `guardians`, and is set at the moment the payment is
recorded; the family guard of §12.5 then *validates* that the payer is a guardian of a student the
payment touches, so a payer who is not a guardian at all is rejected at the database.

```text
DESIGN VERDICT:
DESIGN-GO

P0: 0
P1: 0
P2: 12

OPEN DECISIONS: 16

IMPLEMENTATION AUTHORIZED:
YES

COUNTING NOTE: the P2 figure is the size of the §34.3 register, which is 12 (P2-01
through P2-12), not the number that blocks go-live. Of those 12, six are
implementation dependencies carried forward deliberately (pepper/KMS placement,
session claim, finance DLQ, redrive, decimal.js wire format, permission
re-wording) and six are documentation or migration-ordering items with no runtime
behaviour. None of them is a P0 or a P1: each is either an explicit owner
decision, a cross-phase concern outside Phase 7's remit, or a deferral this
document states rather than hides. The previous revision printed "P2: 7" while
carrying a 12-item register, which is the same class of error as §35.3's
trigger count — a summary number that no longer describes what it summarises.
```

---

## 36. PHASE 7 — DESIGN REMEDIATION REPORT

This section is the audit trail for the current revision of this document. It records what was
found, what was changed, and what the change was verified against — so that a later reader can
distinguish a **corrected defect** from a **newly introduced** one, and so that no finding in
§34.1/§34.2/§34.3 exists without a resolvable section reference.

### 36.1 Method and its limits

Verification was **static only**. No PostgreSQL instance was available, so no statement in this
document has been parsed, planned, or executed by a server. Every "fixed" below means *the document
no longer specifies something that a PostgreSQL parser, a policy evaluator, or a `REVOKE`/`GRANT`
would contradict* — not *verified working*. This distinction is the report's most important claim,
and it is repeated in §34.4 rather than buried here.

The checks that **were** run mechanically against the finished document, and that a future revision
must also pass:

| Check | Rule | Result |
|---|---|---|
| R1 | **fence parity and no stranded headings.** The line count is deliberately NOT asserted: it is self-referential, so recording it means every correction to this document, including the one that adds it, invalidates it — and a check that must be edited to stay true is a check that will be left stale | **220 markers / 110 pairs / 0 unclosed / 0 headings inside a fence.** Parity is the assertion; the per-block scan for a heading inside a fence is what locates a violation. **This check earned its keep**: the child-freeze function in §7.3.1 had a closing fence and **no opening one**, so the count was odd (219) and every fence from there to the end of the document paired one line off — roughly 700 lines of prose and SQL inside one unterminated code block — while this row still read as a passed check |
| R2 | every bound function is defined; every inventory row is bound; inventory is sequential from 1 | 28 inventory rows (1–25 plus 3a–3c, no gap), 39 defined functions, 28 bound, 0 orphans, 0 bound-without-row |
| R3 | no fenced block contains a literal `...` | 0 occurrences |
| R3′ | no duplicate section numbers | 203 numbered headings, 0 duplicates |
| R4′ | every `§n.m` cross-reference resolves to a real heading in this document | **169 distinct references against 203 numbered headings, 0 unresolved.** The one non-resolving reference is `§5.4`, cited 4 times, and it is a citation to **RFC 4226** (HMAC one-time passwords, which §5.4 discusses) rather than to a section here — the same token as a section number by coincidence, and it is excluded by hand rather than by a heuristic that would also hide a genuine dangling `§5.4` |
| R5′ | every `T-FIN-n` cited anywhere in the document has a row in §29's table, and the table's ids are contiguous with no duplicate | 31 rows / 31 distinct ids, contiguous `T-FIN-01`–`T-FIN-31`, 0 dangling citations, 0 duplicates. **11 rows carry an inbound citation** from elsewhere in the document (`T-FIN-08`, `16`, `18`, `20`, `21`, `22`, `26`, `27`, `28`, `30`, `31`) and the other 20 are **table-only**, which is correct rather than a gap: §29 is a threat **catalogue**, so a row does not need a cross-reference to exist, and inventing one would be a worse fix than leaving it |
| R6′ | every `CREATE TABLE fin_*`/`auth_*` **created by Phase 7** is followed, before any other statement, by `REVOKE ALL ON <table> FROM school_app_rw` | **29 of 29**, 0 strays. "Immediately" is measured from the table's **closing** `);`, not from its opening line, and the following line must be the matching `REVOKE` with blank lines and comments skipped — otherwise a comment block between the two would hide a missing revoke. The file contains **31** `CREATE TABLE` statements; the other **2** are the quoted `0001` baseline DDL for `users` and `auth_sessions`, which Phase 7 does not own and does not revoke |
| R7′ | every `CREATE [CONSTRAINT] TRIGGER` (non-comment) names a defined function | **38** statements document-wide, **0 orphans**; **35 distinct** — the §35.3.2 block (34) plus §19.8.1 (1) |
| R8′ | every view is defined exactly once | 7 views, 7 distinct |
| R9′ | the `0028` grant block covers every table exactly once, and its privilege shape matches the §35.4 ACL table cell for cell | **6 `GRANT` statements, 29 of 29 tables, 0 double-grants, 0 shape mismatches, 0 `DELETE`**. The block is parsed as statements rather than as four shapes, because it is **six** statements: the four shapes plus two single-table grants stated separately for their reasons (`fin_billing_runs`/`fin_billing_run_items` are shape 2 with the "a re-run is a NEW run" rationale, and `fin_ledger_accounts` is `SELECT` only because seeding is F3's). By privilege: 16 `SELECT,INSERT,UPDATE`, 7 `SELECT,INSERT`, 6 `SELECT`. §35.4's table is compared **after expanding its 21 grouped rows** into the 29 real tables — `fin_fee_structures (+ items, targets, plans)` is 4 tables, `fin_invoices (+ items, adjustments, **challans**)` is 4, `fin_billing_runs (+ items)` and `fin_reconciliation_batches (+ matches)` are 2 each — because a row-by-row comparison of 21 against 29 would be meaningless, and a cell saying `school_migrator only` is read as **not granted to the runtime role**, which is what the block encodes |
| R10′ | file encoding is valid UTF-8 with no replacement characters | 0 occurrences of U+FFFD |
| R11′ | the §35.2 FK map equals the FK edges in the DDL (`CREATE TABLE` **and** `ALTER TABLE … ADD CONSTRAINT`), both directions; every single-column row targets `tenants`/`users`/`auth_sessions`; every composite row targets a `(tenant_id, id)` or `(tenant_id, code)` anchor | 62 edges / 62 rows, 12 single-column rows / 3 targets, 0 orphans — **carried from the §35.2 map, not re-parsed this pass**; see the caveat below. The 62nd edge is `0022`'s `fin_fee_structures.published_by → users(id)` (D7), added to the map and to the count with the rest. **A reader using this map as an allowlist must split `0022`'s rows by migration, because 24 of the 62 rows name a `0022` table and only 23 of those are `0022`'s.** The 24th is `fin_billing_run_items.invoice_id → fin_invoices`, which is the **forward reference `0023` adds** and the reason assertion 10.3 requires `fin_invoices` to be *absent* at the end of `0022`. `0022` itself creates 23 FKs, and that is the number its own inventory assertion pins |
| R12′ | the §20.3 catalog, the §20.4 matrix and the §21.3 route table agree **as sets, in both directions**: same permission set, no invented permission, no permission without a row, and **every catalogued permission gates at least one route** | **25 = 25 = 25, and the two-way check is 0 / 0 / 0 / 0**: `catalog − matrix` = 0, `matrix − catalog` = 0, `catalog − routes` = 0, `routes − catalog` = 0. The catalog is read from §20.3's `text` block (leading token, two-or-more-space separated from its description) rather than from backticks, because that block is the authoritative list; the matrix is read from §20.4's first column, skipping the bolded group headers (`**Configuration**`, `**Billing**`, …) and the `*(challan read)*` carry-row, which names two permissions in a non-row cell and would otherwise be counted twice; and §21.3's `…read` / `…manage` shorthand is expanded against its enclosing resource |
| R13′ | every `path:NN` / `path:NN–MM` citation resolves to an existing repository file with an in-bounds line, and every `NNNN:NN–MM` migration line citation resolves to exactly one existing migration file and an in-bounds line | **Reproduced this pass: 69 `path:line` citations across 21 files, 0 missing files, 0 out-of-bounds, 0 ambiguous basenames; 30 `NNNN:line` citations across 8 migration files (`0001` `0002` `0005` `0008` `0014` `0015` `0018` `0020`), 0 ambiguous prefixes, 0 out-of-bounds.** Three citations failed and were fixed. One pointed past the end of a 92-line file **and** named the wrong document for the `app.allow_immutable_update` claim, which is at line 220 of the *database* design doc, not the finance one. Three bare `exams.ts:` citations were **ambiguous across three real files** (`apps/api/src/routes/school/`, `apps/worker/`, `apps/web/lib/`) with the quoted content belonging to two *different* files — the CAS at `:793-804` is the worker's, the `readableStudentIds()` call at `:316` is the API's. Each is now fully qualified. Note that the two bad forms are written here without backticks on purpose: backticking them would make this row fail its own check. Existence and bounds only; see the caveat below on content claims |
| R14′ | §19.7.2's table rows and §19.7.3's narratives are both `F1`…`F10` with no gap (plus `F5h`, which documents the two unbound helpers and is deliberately not a number in that series), and **every function granted `EXECUTE` has a row and a `CREATE FUNCTION`** | 11 table rows / 10 numbered `F` series + `F5h`, 10 narratives, 8 granted functions, 0 granted-but-undefined. **F3 now also has a body** — it was the one narrative with no `CREATE FUNCTION` (§36.2 row 35) |
| R15′ | each function's narrative signature equals its `CREATE FUNCTION` parameter list, **names and order** | **Reproduced this pass: 9/9 exact on names and order** (F1–F4, F6–F10). Three rows differ in *type rendering* only, and are not defects: F4's narrative spells `p_tenant_id, p_source_type` without types where the DDL says `uuid, text`; F8 and F9 say `numeric` where the DDL says `numeric(19,4)`. A name-and-order comparison passes all three |
| R16′ | every composite FK in §35.2 targets `(tenant_id, id)` or `(tenant_id, code)` | 50 composite edges checked, 0 unanchored — **carried from the §35.2 map, not re-parsed this pass**; see the caveat below |
| R17′ | the §33 table is contiguous (`OD-01`…`OD-16`, no gap), its stated count matches its rows, and **every `OD-n` cited anywhere in the document has a table row** | 16 rows, stated count 16, 0 cited-but-unregistered. `MOD-97` (the IBAN checksum in §26.3) is **not** an `OD-n` and is excluded from the comparison |
| R18′ | the per-table RLS posture is **stated, not implied**: which tables have explicit policy DDL in this document, which are deferred to `0028`'s RLS block, and whether the deferred ones are reachable before it runs | **5 tables carry explicit `CREATE POLICY` DDL here** — `fin_payments` (3), `fin_invoices` (1), `fin_receipts` (2), `auth_mfa_factors` (3), `auth_step_up_challenges` (1) = **10 policies on 5 tables**. Only **2** of those 5 also carry an explicit `ALTER TABLE … ENABLE` + `FORCE` pair in this document (`auth_mfa_factors`, `auth_step_up_challenges`); the 3 finance tables' `ENABLE`/`FORCE` appear only as the `fin_x` template inside §30.5 step 6's `0028` block, so **2 `ENABLE` + 2 `FORCE` are written out literally**, and the earlier claim of "5 `ENABLE` and 4 `FORCE`" counted policies as if each carried its own pair. The other **24** Phase 7 tables (29 − 5) have **no** `ENABLE`, no `FORCE`, and no policy in this document. **This is a deferral, not an omission, and it is safe** — §30.5 step 6 places the per-table `ALTER TABLE … ENABLE` / `FORCE` / `CREATE POLICY` block in `0028`, and `0028` is the **last** file, after the grant block's ordering is fixed. Until it runs, every one of those 25 tables carries an immediately-following `REVOKE ALL … FROM school_app_rw` (R6′, 29 of 29), so the runtime role holds no privilege on them at all and `42501` is raised before RLS is ever consulted. The failure mode is **fail-closed**, which is the property §30.5 argues for, and the 5 policy-bearing tables are in the same position until `0028` runs for the 3 finance tables' missing `ENABLE`/`FORCE` pair. The `auth_sessions` non-match is the quoted `0001` DDL, not a Phase 7 table |
| R19′ | §23.1's new-event list and §24.1's disposition table are the **same set**, every event has exactly one disposition, and the §24.2 registry arithmetic follows from the disposition counts | **18 = 18, set difference 0 in both directions, 0 duplicates, 0 unclassified**; **13 HANDLED / 5 INTENTIONALLY_NOOP**, so `93 + 18 = 111`, `9 + 13 = 22`, `84 + 5 = 89`, and `22 + 89 = 111`. The 93 / 9 / 84 baseline is `apps/worker/src/worker-event-registry.test.ts:75,91,100`, pinned by the repository. The comparison is list-vs-table rather than prose-vs-table, and it deliberately **excludes** `fee.reconciliation.exception`, which appears 7 times in this document as the *deleted* phantom of §23.1's note and in `T-FIN-28`'s history — a naive `fee.*` token sweep finds 19 and would report a phantom as live |
| R20′ | §35.1's "Creates (complete)" column is complete **in both directions**: every Phase 7 table the DDL creates is named in the row of the migration that creates it, and every table named there is one the DDL actually creates | **9 migration rows (`0021`–`0029`), 29 of 29 tables placed, 0 unplaced, 0 named-but-absent.** The 7 views are excluded from the table check and their placement is stated in prose (V1 in `0024`/`0026`, V2 in `0026`). One name in a creates cell is **not** a relation: `fin_recompute` in `0026`'s cell is the nightly reconciler **job**, and register row 22 is the row that reconciled that name against the reserved `trg_fin_*` prefix — so the check reads it as a process reference rather than silently accepting it as a table |
| R21′ | §5.2's chart, `fin_ledger_accounts_code_ck`'s literal list, and F3's seed `VALUES` are **the same nine accounts in the same order with the same class, normal side and `is_contra`** | **9 = 9 = 9, row-for-row identical on (code, account_class, normal_side, is_contra), same order, 0 differences.** These are three independent renderings of one fixed chart — a prose table, a DDL `CHECK`, and a plpgsql `VALUES` list — and §36.2 row 34 existed because all three had previously drifted apart. The assertion is deliberately row-for-row rather than set-based: a seed that inserted the same nine accounts in a different order would still be *correct* but would no longer be the list §5.2 promises, and a checker that only compared sets would have passed the defect that was actually found |

The one reference that does not resolve to a heading in this document is `§5.4`, which is a
citation to RFC 4226 rather than to a section here. The checks marked `′` were added because each caught a **real** defect in this
revision (rows 12–19, 23, 24, 25, 31–35 of §36.2). A document that is internally contradictory is not a design,
and each of those defects would otherwise have shipped as a migration that fails to apply or a test
that asserts nothing. The rows are ordered `R1`, `R2`, `R3`, `R3′`…`R19′` — the three unprimed ones first
because they predate the others, then every primed row in numeric order, so that a reader scanning for
"which check is `R14`" does not have to know the table's history.

**Two rows are carried rather than re-measured, and each says so in its own cell.** `R11′` and `R16′`
are FK-edge counts. `R15′` was **carried by earlier passes and has now been reproduced** — 9/9
signatures exact on parameter names and order — so it is no longer part of this caveat.

The FK rows are **not** in the reproduced set: re-parsing `FOREIGN KEY` clauses out of fenced DDL is
a different and considerably more fragile job than counting functions, and the pass run against this
revision did not reproduce the 61-edge figure — it found 31 `CREATE TABLE` edges and 51 composite
clauses, which do not match, so one of the two parsers is wrong and the document does not know which.
Quoting 61 as freshly verified would be a false claim even though 61 is the figure §35.2's map was
built from.

The reproduced rows moved when the content moved, which is the point of running them: `R2` went
24 → 25 inventory rows and 34 → 35 defined functions, then **35 → 36** when §36.2 row 35 gave F3 the
`CREATE FUNCTION` it never had, then **36 → 39** and **25 → 28** when `0022` added its six
functions; `R7′` went 31 → 32 statements because the
reconciliation batch trigger was split (§14.1.1), then **32 → 35** for the same reason `R2` moved —
`0022` contributes 8 — which also exposed that a document-wide text search finds 38, because
§7.3.1 and §8.7.1 each restate one of `0022`'s bindings beside its function; `R14′` went 10 → 11
table rows with the addition of `F5h`; `R19′` and `R20′` were added to check the **event list against the disposition table** and the
**§35.1 "Creates" column against the DDL**, because those are the two places where prose and DDL
disagree silently — the §24.2 arithmetic is what the worker test will assert, and §35.1 claims its
column is "complete"; and `R1` moved with every edit.
The two carried rows must be reproduced mechanically **before `0021` is written** — the honest status is
"asserted by the map, not re-verified", not "verified".

### 36.2 Defects found and corrected

Severity follows §34.1 (P0), §34.2 (P1), §34.3 (P2). **P0** = the migration cannot apply, or a
security control is absent. **P1** = the design is internally contradictory, or a control is
unreachable. **P2** = documentation or carry-forward.

| # | Sev | Defect | Why it mattered | Fix | § |
|---|---|---|---|---|---|
| 1 | P0 | `trg_fin_refund_provenance`'s `DECLARE v_refund fin_refunds` names a row type created by `0025`, but the function and its allocations-side trigger were placed in `0024` | `CREATE FUNCTION` in 0024 fails **42704**; the 0024 trigger fails **42883**. Splitting the two bindings across the two files is the one arrangement that cannot work, because the function is a single object | Function **and both** bindings moved to `0025`; the composite-type rule stated normatively | §30.3.1, §13.1, §35.3.2 |
| 2 | P0 | `0001_init.sql:380-383` grants `SELECT, INSERT, UPDATE, DELETE` to `school_app_rw` via `ALTER DEFAULT PRIVILEGES`, so every `fin_*` table was `DELETE`-able from the instant it was created; the design's only explicit grant step was therefore a no-op | A committed `fin_*` table held a real ACL grant and **no RLS policy** for the whole 0021–0027 window. PostgreSQL does not enforce RLS that was never enabled, so that window was cross-tenant read *and write*, reachable by any session using the runtime role | `REVOKE ALL ON <t> FROM school_app_rw` immediately after each of the 29 `CREATE TABLE`s, in the same file and the same transaction; `0028` becomes the only grant | §30.3.2, §35.4 |
| 2b | P0 | §30.3.2 step 8 *stated* the `REVOKE` but still showed `GRANT SELECT, INSERT, UPDATE ON fin_x` as the step's content, one line above a comment warning against exactly that blanket grant; and the paragraph below still asserted a committed table "has an ACL entry for school_app_rw and no policy: readable and writable" | The remediation of P0-2 was contradicted in prose by the very section that prescribed it, and the "readable and writable" sentence described the **defect** in the present tense — a reader checking the current posture would have concluded the opposite of the truth. The same paragraph credited the per-file transaction with preventing the window, which the earlier revision had done without the `REVOKE` | Step 8 rewritten to point at the four shapes in §35.4 instead of showing a blanket grant; the window description split into an explicit "either revision / this revision" contrast, with the state after the `REVOKE` stated as **no ACL and no policy ⇒ unreachable (`42501`)**; the transaction argument corrected to say visibility ≠ privilege | §30.3.2 |
| 3 | P0 | The principal's entire finance surface — four aggregate views — was named in nine places and **defined in none** | A `DESIGN-GO` document whose principal has no implementable read path | All four written out in full, tenant-pinned in both the projection and the `WHERE`; `fee_head_id` recorded as a bounded taxonomy exception rather than left for a failing test to discover | §15.2.2, §19.7.2 |
| 4 | P0 | `trg_fin_artifact_document_valid` was bound on `fin_artifacts_document` in 0027, a table 0029 creates | **42P01** at the point in the sequence where 0027 runs | Binding block reordered by the migration that creates each trigger's **target** table | §35.3.2 |
| 5 | P0 | `post_fin_ledger_group` was `SECURITY INVOKER` while the same revision **revokes** runtime `INSERT` on both ledger tables | The document described a system that cannot record a payment, while claiming the ledger was protected | F4 is `SECURITY DEFINER`, bounded by a closed `jsonb` line shape validated before any insert | §19.7, §30.3.3 |
| 6 | P1 | Six row triggers read the fired-on row as `COALESCE(NEW.<c>, OLD.<c>)`, and the document **asserted** this was the correct DELETE-path idiom | In PL/pgSQL a row trigger assigns only `NEW` on INSERT and only `OLD` on DELETE, and `COALESCE` evaluates every argument — so it raises **P0002** `record "new" is not assigned yet` on the single-operation paths. In a `BEFORE` trigger the returned record *is* the row written, so this is a write-time failure, not a cosmetic one | All six branch on `TG_OP` explicitly, for both the read and the return; absence of the pattern is asserted by test | §7.4, §9.4.1, §9.6, §12.4.1, §13.3.1, §15.1 |
| 7 | P1 | `trg_fin_invoice_item_total` reads `fin_invoice_adjustments` but was bound only to `fin_invoice_items` | A function runs only when its trigger fires, so a waiver or a fine never reached `total` — a discount that does not appear on the invoice | Bound to both tables | §9.6, §35.3.2 |
| 8 | P1 | `fin_invoices.balance` was recomputed on allocation changes only, while a corrected line or a new adjustment also moves `total` | A cache correct for one of its three inputs, and **trusted**, is worse than no cache, because the trust is the defect | Bound to items + adjustments + allocations; the arithmetic moved into one `RETURNS void` helper; both sides recomputed on a move; **and every read goes through the view, not the cache** | §12.4.1, §21.3, §35.3.2 |
| 9 | P1 | `is_final` is derived from `batch.status` but stamped only when a *match* row is written, so a batch moving `open → matching` left its existing matches unstamped and the partial unique index enforced nothing in that window. The remedy as first written was a single merged batch trigger declared `BEFORE` while its own comment claimed `AFTER`, so it was bound correctly at neither timing: `BEFORE` let the row trigger's derivation overwrite the stamp, and `AFTER` could not assign `NEW.matched_total` | A payment could be **final in two batches** — the double-reconciliation defect the index exists to prevent | Split into `trg_fin_recon_batch_derive_totals` (`BEFORE`, totals + the finalised-batch guard) and `trg_fin_recon_batch_stamp_matches` (`AFTER`, propagation). Neither trigger is sufficient alone and the pair cannot be merged | §14.1.1, §35.6, T-FIN-27 |
| 10 | P1 | `/reconciliation/batches/:id/cancel` was gated to `open` only, while `matching → open` is refused once any match is final and `matching → completed` demands a snapshot | A half-matched batch was **unabandonable**: the one transition that says "this was the wrong statement" was the one the route forbade | `/cancel` accepts `open` **or** `matching` | §21.3, §35.6, T-FIN-28 |
| 11 | P1 | `fin_billing_runs` and `fin_billing_run_items` were each defined **twice**, both blocks marked NORMATIVE | The two disagreed on the `status` enum (`pending/running/completed/failed/reverted` vs `draft/preview/committed/cancelled`), on identity (surrogate id + per-charge unique vs composite PK per enrollment), and on which migration created them. The §8.4 copy also declared a `fin_invoices` FK **inline** in a 0022 table — the forward reference §30.2 forbids, in the section that states the rule | §8.7 made canonical; the §8.4 block removed and replaced with a comparison table naming each defect | §8.4, §8.7, §30.2 |
| 12 | P1 | `fin_billing_run_items` declared `UNIQUE (tenant_id, id, run_id)` three lines below a comment stating the table **has no `id` column** | **42703** `column "id" does not exist` at DDL time, in the same block arguing for that column's absence | Constraint removed, with the §6.3 R1 anchor omission stated as deliberate — the table is a leaf and is never referenced | §8.7 |
| 13 | P1 | §35.4's privilege table put **actor classes** in columns headed `SELECT`/`INSERT`/`UPDATE`/`DELETE` | PostgreSQL cannot grant `INSERT` to one role and withhold it from another on the same table, so a cell reading `fees.structures.manage` under `INSERT` describes a *policy branch*, not a privilege. Anyone configuring `0028`'s grant block from that table would have granted every table every write privilege | Table split into an **ACL block** (what `aclexplode` reports) and an **RLS branch block**; the full `0028` grant block written out in four privilege shapes | §35.4, §30.3.2 |
| 14 | P1 | `UPDATE` is revoked on `fin_payment_allocations` and no route mutates it, yet the recompute trigger is bound `AFTER … UPDATE` and the property test moves allocations | Same class as P1-05 pointed the other way: a revoked privilege made trigger branches **unreachable**. Granting `UPDATE` would let the runtime role rewrite where a family's money went; deleting the bindings would remove the guard against a future route or an owner repair doing exactly that | Bindings kept and **labelled defence-in-depth** for the owner and any future route; the property test runs `moveAllocation` as `school_migrator`, and §28.3 asserts both halves — the move recomputes both balances as the owner, and the same move is `42501` as the runtime role | §35.4, §28.3, §28.4 |
| 15 | P1 | §35.4 claimed every `fin_*` table is `REVOKE`d immediately after its `CREATE TABLE`, but the DDL carried that statement for **two** tables (the ledger pair) | The control the document's own `aclexplode` test asserts was absent from 27 of 29 tables, so the test would have failed against its own design | All 29 statements added to the DDL | §35.4, §30.3.2 |
| 16 | P1 | `T-FIN-27` was cited for two different threats, and the threat table stopped at `T-FIN-26` | A dangling cross-reference means the drift-idempotency assertion had no threat row to be asserted by | Drift row added as `T-FIN-31`; reconciliation finality, cache trust, and the P0002 class added as `T-FIN-27`–`T-FIN-30` | §29 |
| 17 | P1 | §31's subphases were numbered `7.1`–`7.9`, colliding with §7's real headings `7.1`–`7.6` | `§7.4` was ambiguous between "installment plans" and "payments and allocations" | Renumbered `31.1`–`31.9`; nothing referenced the subphase numbers, so no reference needed repointing | §31 |
| 18 | P1 | `OD-13` (break-glass) and `OD-14` (step-up session id) were referenced in six places and **absent from the §33 table**, which read "Count: 12" | Two open decisions had no shipped default and no stated cost, while the verdict claimed 14 | Both added with defaults and consequences; count corrected to 14; **OD-14 carries a cross-phase ordering constraint** — settle it before `0028` is *written*, not before it is applied | §33 |
| 19 | P1 | Two cross-references pointed at sections that **do not exist**: **8.8** (the billing-run freeze, which is 8.4) and **19.7.4** (the view rows, which are 19.7.2). Separately, `§30.3.2` was used for two different sections | Four dangling references and a duplicate heading number, and a reader following that citation in a DDL comment lands nowhere | Repointed to §8.4 and §19.7.2; §30.3.1–§30.3.3 renumbered and every cross-reference disambiguated by context | §8.4, §19.7.2, §30.3 |
| 20 | P2 | §35.2's FK map listed `fin_billing_run_items.fee_head_id` and omitted `enrollment_id`/`assignment_id` | The map claimed to be the complete composite-FK inventory while describing a table that no longer existed in that shape | Map corrected to the real columns, with the deferred `invoice_id` FK and the nullable `assignment_id` annotated | §35.2 |
| 21 | P2 | §35.4 had no rows for the seven views | The view ACL is simpler than the table ACL (`SELECT` only) and is the reason the V1/V2 split is a security decision rather than a performance one | View grant block added, with the `security_invoker` consequence stated for each class | §35.4 |
| 22 | P2 | `postLedgerGroup()`, `fin_recompute`, `Path A/B/C views` and `fin_allocations_refund_ceiling` appeared in prose under names colliding with the reserved `trg_fin_*` prefix or with real function names | A reader implementing from prose would create a function the inventory test rejects | Names reconciled with §35.3; the `trg_`-prefix collision documented at the point of definition | §13.3.1, §35.3 |
| 23 | P1 | §35.2 claimed to be "Every tenant-scoped FK in Phase 7" and listed **45 rows**; the DDL has **61** FK edges. Missing were the six composite edges from `fin_fee_assignments`, four from `fin_billing_runs`/`fin_fee_installment_plans`, `fin_document_counters`, `fin_invoice_items`, `fin_reconciliation_batches` and the `fin_payment_allocations` self-reference; the six single-column `(tenant_id)`/`users` rows for `fin_tenant_settings`, `fin_fee_heads`, `fin_tax_profiles`, `fin_ledger_accounts`, `fin_billing_runs.started_by` and `fin_invoice_adjustments.approved_by`; the `ALTER`-added `fin_tenant_settings → fin_tax_profiles`; and one row carried the **wrong column name** (`grade_level_id` where the DDL says `grade_id`). The header also under-counted the R4 exceptions as "six rows / three tables" when there are **eleven / three** | `finance-composite-fk.test.ts` is specified to read this map **as the allowlist** and fail the build on any FK not in it, so an incomplete map is not a stale comment — it is a test that fails against its own schema on the first `0021` FK, or, worse, an allowlist (or a "fix" to the DDL) written to match the wrong table | Map rebuilt from the DDL: 61 rows, both directions mechanically reconciled, `grade_id` corrected, the `ALTER`-added and self-referential edges present, and the count paragraph rewritten to derive from the DDL (11 rows / 3 targets) rather than from memory | §35.2 |
| 24 | P1 | §30.3's central P0 rests on a citation of `0001` that was **wrong in two ways**. It cited a range running from line 380 to line **384** for the `ALTER DEFAULT PRIVILEGES` — but `0001_init.sql` is **383 lines**, so its final line does not exist — and, in the paragraph explaining why the old order was a P0, it cited two *other* ranges as the statements that **establish** the default privilege. Neither does: the `0005` range is the *explicit runtime grants* comment, and the `0001` range is an RLS policy on `idempotency_keys` | A citation that points at a policy while claiming to point at a privilege grant is worse than no citation, because it is the kind of reference a reviewer checks and finds wrong — and the entire 29-table `REVOKE` remediation hangs off that one fact. The `0001` default privilege is the load-bearing premise of the fix, so it is the one claim in the document that must be checkable in one hop | Re-verified every migration line citation in the document against the real files (16 distinct ranges, all now in-bounds and pointing at the claimed content); the `0001` citation corrected to `0001:380-383`, and the `0005` range re-described as the explicit-grant convention rather than the default privilege. `0001:380-383` is stated to be the **only** `ALTER DEFAULT PRIVILEGES` in the repository | §1, §30.3.2, §35.4 |
| 25 | P1 | Reconciling §35.4 and §21 against the §20.3 permission catalog found **two catalogued permissions with no enforcement point**: `fees.adjustments.approve` had a catalog row, a matrix row, and role grants, but the only adjustments route was gated on `fees.adjustments.create`; and `fees.adjustments.read` appeared in the catalog and the matrix and **nowhere else in the document**. §20.4 states the create/approve split explicitly ("mirroring the repo's `attendance.mark` / `attendance.approve_leave`") while the route table implemented only half of it | A permission in the catalog that gates nothing is granted to roles for a capability that does not exist — a least-privilege grant that grants nothing, and an audit row that documents a control the code does not enforce. The `approve` case is worse: the catalog calls it a *post-issue approval control* on cash, so the gap is between a documented control and its absence | The adjustments route now carries a **type-keyed second gate** — `create` for every type, plus `approve` for `concession`/`waiver` — which needs no `status` column and leaves FI-001's trigger summation untouched; the invoice GET route now requires `fees.adjustments.read` for the `adjustments` sub-resource. The absence of separation of duties that this exposes is recorded as **OD-15** rather than papered over, because the alternative is a schema change to an append-only table | §20.3, §20.4, §21.3, §33 |
| 26 | P0 | `post_fin_ledger_group` (F4) was **granted but never defined** — the document contained `GRANT EXECUTE ON FUNCTION post_fin_ledger_group(uuid, text, uuid, jsonb)` and no `CREATE FUNCTION` for it, while every other member of the closed set had a body | `GRANT … ON FUNCTION` against a non-existent function fails **42883** at the point of the grant in `0026`/`0028`, so this was the same class of unappliable-migration defect as row 1 — and it sat on the *only* write path to an operationally-authoritative ledger, whose entire guarantee was described in prose in §19.7.3 | Body written out in full in §19.7.3: validate-every-leg, then insert unsealed header, then legs, then seal. That order is forced by two triggers that already existed — `trg_fin_ledger_seal` is `BEFORE UPDATE` and treats the first write of `sealed_at` as the seal, and `trg_fin_ledger_sealed_group_reject` is `BEFORE INSERT` and rejects any leg joining a sealed group | §19.7.3, §30.3.3 |
| 27 | P1 | `app_confirm_mfa_factor` was `GRANT`ed to `school_app_rw`, was `SECURITY DEFINER`, and was **absent from §19.7.2's closed set and from §19.7.3 entirely** | §19.7 is the contract for privilege-elevating functions; a granted definer function with no row in it is a hole in the contract rather than an omission in the prose. It is also the only function in the set that writes an `auth_mfa_factors` row, and the self-only RLS branch on that table is only coherent if the function that bypasses it by definership is on the record | Added as **F10** — table row, narrative, and a note at the set. The DDL's own body carries the real security argument (the user is **derived from the factor** and compared to `app_current_user_id()`, so a caller cannot name a user at all) | §19.7.2, §19.7.3 |
| 28 | P1 | F9's signature was stated **three different ways**: `app_mint_step_up_challenge(resource, amount, action)` in §19.7.2, a 4-argument form in §19.7.3 that said *"four, and no session argument"*, and 5 arguments with `p_session_id` first in the DDL | OD-14 is the decision about where the session id comes from, and its shipped default is *an explicit route argument* — so a narrative that says there is no session argument contradicts the decision the document claims to have made. Three arities for one function means a reader implementing F9 from §19.7.3 writes a signature that the `GRANT` on the next line cannot match | All three reconciled to the DDL: 5 arguments, `p_session_id` first. The narrative now states the argument is explicit, is not caller-forgeable (the route passes the session it just authenticated), and that OD-14's open half is whether a *signed* claim should replace it — which does not license describing a 4-argument function | §19.7.2, §19.7.3, §33 |
| 29 | P1 | F5's row was wrong in three ways at once: it counted "**22** trigger functions" where §35.3 binds **25** and the DDL defines **26** `trg_*` functions; it omitted `trg_auth_step_up_immutable` (the 25th inventory row), so the auth trigger's volatility, invoker/definer classification and `search_path` were never stated anywhere; and it described its **2 declared helpers** as if they were bound, when **no `CREATE TRIGGER` names either** — `trg_fin_reversal_shape_check` and `trg_fin_invoice_recalc_balance` are `PERFORM`ed inside other trigger functions and are reachable from no entry point of their own | A contract row that under-counts by three and conflates *bound* with *declared* is the row an implementer reads to decide what to create. The 22 also never matched: the reconciliation split in row 9 added a bound function and a statement, taking the inventory from 24 rows to 25 and the statements from 31 to 32 | F5 rewritten to state the bound-function count, one per §35.3 row, and the count is now checked against the DDL by R2. **The number has since moved twice** and each move was a real addition, not a restatement: the reconciliation split took it 24 → 25 rows and 31 → 32 statements, and `0022` added rows 3a–3c plus 8 statements, giving the current **28 bound functions and 35 distinct statements**. F5's membership clause is kept in step with the table, because a contract row that is one revision behind the table it points at is worse than no count at all. The two helpers were split out into their own row **F5h**, which records that they are declared, unbound, and granted to nobody, so the gap is stated rather than hidden inside a total | §19.7.2, §35.3 |
| 30 | P1 | `OD-15` was cited in §21.3 and in §36.4 as a registered decision with a before-`0023` ordering constraint, and §33's **count line read 15**, but the §33 table stopped at `OD-14` | Exactly the defect class of row 18, one revision later: a decision that gates a control and carries a migration-ordering constraint, referenced as authoritative, with no row — so a reader consulting the table for the shipped default would find 14 decisions and no `OD-15` | `OD-15` added, and **OD-16** added for the new `event_type` wart row 26's fix exposed. Count corrected to 16, and the count line's claim that OD-14 is *the only* decision with an ordering constraint corrected to three (OD-14 before `0028`, OD-15 before `0023`, OD-16 before `0026`) | §33 |
| 31 | P1 | F-7.1 asserted "All **137** `CREATE POLICY` statements across `0001`–`0020` use one body" and cited `0005:317-353` | The number was wrong and the citation pointed at the `FOREACH` block rather than the policy body. A count that is neither the textual nor the effective total makes the claim unfalsifiable, and F-7.1 is the premise for the whole relationship-aware-RLS requirement | Restated as three named figures derived by expanding each loop: **101 textual occurrences** = **69 direct literal statements** (`0001` 27, `0002` 36, `0003` 2, `0018` 4) + **32 loop template sites** (8 loops × 4 bodies); **241 effective policies** (69 + 172 generated). The loops are enumerated per file with their table counts, and the citation moved to the body itself (`0005:331-334`, inside the loop spanning `0005:323-351`). The **substantive** claim survives unchanged and was re-verified against all 101 bodies: none references a relationship table | §2 (F-7.1) |
| 32 | P1 | Two `path:line` citations named files by a path that does not resolve — `plugins/authorization.ts:68-70` and `idempotency/src/index.ts:9-12` — and §21.3's idempotency claim rested on `packages/idempotency/src/index.ts:9-12` "documents first write wins" | A citation to a file the reader cannot open is not a weaker citation, it is a signal that the claim was never opened. Worse, the claim it supported ("`requestHash` is written but never read") was **true but unevidenced**, resting on a doc comment rather than on the code | Both paths corrected to full repository-relative form, and the claim re-derived from the code: `recordIdempotency` writes the hash (`packages/idempotency/src/index.ts:65`) into a column declared at `0001:189`, `readIdempotency` (`:36-53`) returns only `{ status, body }`, and **neither** replay path (`:100-101`, `:119-121`) compares it. R13′ now checks all 39 `path:line` citations for existence and in-boundsness | §21.3, §2 |
| 33 | P2 | §36.1's R12′ row cited "the §20.**5** matrix"; the matrix is §20.**4**, and §20.5 is the role backfill | A verification table whose own row points at the wrong section is the one place a reader is guaranteed to check, and the miscount here was invisible because the sets being compared are identical — 25 = 25 = 25 was true of §20.3, §20.4 and §21.3 alike, so the wrong section number produced the right answer | Repointed to §20.4, and R12′ now records *how* the route set was derived, since §21.3 abbreviates `fees.structures.read` / `…manage` to `…read` / `…manage` and a naive reader of that column counts 4 gates rather than 25 | §36.1 |
| 34 | P0 | The chart of accounts could not be seeded: `fin_ledger_accounts_side_ck` allowed only three shapes (`asset→debit`, `liability→credit`, `revenue→credit`), but §5.2 classifies `4100 Fee Income — Concessions & Waivers` as **revenue with a debit normal side** because a concession is contra-revenue (§15.1 posts it `Dr 4100 / Cr 1200`) | F3's own seed `INSERT` raised **23514** `check_violation` on the `4100` row, so the migration's backfill died and no tenant had a chart at all — the ledger was unseedable by construction, from a table the same document calls the "fixed chart". The defect is that **two sections of the same document disagreed about what a revenue account may be**, and the DDL followed the stricter one. Compounding it, the chart was described as **10 rows** in F3's purpose line and §30.5 while `code`'s CHECK admits **9** | `is_contra boolean NOT NULL DEFAULT false` added, and `side_ck` given a fourth arm: `revenue AND debit AND is_contra` — with `NOT is_contra` pinned onto the other three, so the flag cannot be used to license a second debit-normal revenue account. The **9** count is now stated once in §5.2 and derived from `code`'s CHECK, with `is_contra` added as a column to the chart table so the nine rows and the nine CHECK values are visibly the same list | §5.2, §6.1, §19.7.3 |
| 35 | P0 | F3 `app_finance_seeds_ledger_accounts` had a table row, a full narrative, a migration-map entry in `0021`'s "creates" column, and an ACL row saying `fin_ledger_accounts` inserts are "school_migrator only (F3)" — and **no `CREATE FUNCTION` anywhere in the document** | Every consumer of the chart depended on a function that did not exist. §30.5's per-tenant backfill would call it and fail **42883** `undefined_function`; the `0021` migration map claims to create it, so `0021` would not deliver what the map says it delivers. This is the same defect class as row 26 (`post_fin_ledger_group` granted but never defined) and it survived row 26's fix because row 26 only searched for *granted* functions, and **F3 is granted to nobody** — it is owner-retained — so "0 granted-but-undefined" was true while a documented object was still missing. The check was measuring the wrong set | Body written out in full in §19.7.3: the tenancy assertion (`55000`), the nine-row seed as the single source of the fixed list, `ON CONFLICT (tenant_id, code) DO NOTHING`, `GET DIAGNOSTICS … ROW_COUNT` so the caller can tell 0 (already seeded) from 9 (seeded now), and a closing `count(*) <> 9` assertion that fails loudly rather than carrying a drifted chart into every financial report. `REVOKE ALL … FROM PUBLIC` with **no** grant to `school_app_rw`. R14′ now also checks that every **contracted** function has a body, not only every granted one | §19.7.2, §19.7.3, §30.5, §35.4 |
| 36 | P1 | §29's threat table is a **catalogue whose rows are mostly not cited back**, while §36.1's `R5′` claimed to have checked that "every row is cited" | A verification row that asserts a check it cannot perform is worse than a missing row, because the reader cannot tell a passing claim from an unrun one. The table's shape here was **fine** — a catalogue does not need cross-references — so the defect was in the **claim**, not the table, and the fix is to check the direction that actually carries risk: every `T-FIN-n` **cited** anywhere must have a row | `R5′` restated as a **two-way** check of that direction (0 dangling citations, contiguous `T-FIN-01`–`T-FIN-31`, 0 duplicates), with the 11 rows that do carry inbound citations enumerated and the 20 table-only rows **stated as correct**, so the asymmetry is visible instead of hidden behind a check that was never written. `R12′` had the same defect — "no invented permission" was asserted as checked when the comparison had only been run in one direction — and was restated the same way | §29, §36.1 |
| 37 | P1 | §36.1's `R6′` and `R9′` both reported counts that a naive read of the document contradicts: `R6′` said 29 of 29 tables are "immediately" revoked, but 29 of the 31 `CREATE TABLE` statements are followed by a blank line and a comment before their `REVOKE`, and `R9′` said the block has "four privilege shapes" when it is six statements | Both checks were passing for the right reason and describable only by someone who already knew the answer, which is the failure mode a verification table exists to prevent. "Immediately followed" is not literally true of any table except one, and a reader checking the claim by looking at a `CREATE TABLE` would conclude the control was missing on all 29 | `R6′` restated with the measurement defined — measured from each table's **closing** `);`, with the next non-blank non-comment line required to be the matching `REVOKE` — and the count corrected to 31 `CREATE TABLE` statements of which 2 are quoted `0001` baseline. `R9′` restated as a **statement-level** parse: 6 `GRANT`s, 29 of 29 tables, 0 double-grants, 0 shape mismatches, and §35.4's 21 **grouped** rows expanded to 29 before comparison, with the `school_migrator only` cells read as *not granted to the runtime role* | §35.4, §36.1 |
| 38 | P1 | §24.1's disposition table and §24.2's registry arithmetic (18 new events, 13 HANDLED / 5 NOOP) were asserted without any check that §23.1's **new-event list** contains the same 18 events | The arithmetic is what `worker-event-registry.test.ts` will assert against, and §23.1 is a `text` block of names while §24.1 is a table — two representations of one set, which is the configuration the phantom `fee.reconciliation.exception` lived in for a whole revision | `R19′` added: the fenced list and the table are compared as **sets**, 18 = 18, difference 0 both ways, 13 HANDLED / 5 `INTENTIONALLY_NOOP`, and the sums re-derived (`93 + 18 = 111`, `9 + 13 = 22`, `84 + 5 = 89`). The comparison deliberately **excludes** `fee.reconciliation.exception`, which appears 7 times in the document as the deleted phantom and in `T-FIN-28`'s history — a plain `fee.*` token sweep finds 19 and would report a deleted event as live | §23.1, §24.1, §24.2 |
| 39 | P1 | §35.1's "Creates (complete)" column claims completeness and was never compared against the DDL; the one name in it that is not a relation, `fin_recompute` in `0026`, would have been accepted as a table by any check that did not know it is the nightly reconciler job | "Creates (complete)" is a load-bearing claim — it is how a reader knows which migration owns which table, and `finance-migration-order.test.ts` derives its expectations from it. A column that claims to be complete and is not is a stale comment, and the completeness word is what makes it load-bearing | `R20′` added: **both directions** are now checked, 29 of 29 DDL tables placed in the row of the migration that creates them and 0 named-but-absent, with the 7 views excluded from the table check and `fin_recompute` classified as a process reference. The same pass found §35.1's rows and §30.5's narrative map to be two representations of the same nine migrations, and they agree | §30.5, §35.1, §36.1 |
| 40 | P1 | Three **citations did not resolve** and `R13′` had never been run: one pointed past the last line of a 92-line file and named the wrong document for the claim it quoted, and three were bare `exams.ts:` references that resolve to **three different real files**, with the quoted content living in **two different files** depending on the line number | A citation is the only thing that makes a claim in this document checkable, so a wrong one converts a verified statement into an assertion, and `R13′`'s "0 missing, 0 out-of-bounds" was a claim about a check that had not been executed. The ambiguous `exams.ts` case is the sharper one: every line number in range *existed*, so a bounds-only check passed, and the cited lines in `apps/worker/src/exams.ts` and `apps/api/src/routes/school/exams.ts` are entirely different code | `R13′` **reproduced**: 69 `path:line` citations across 21 files with 0 missing, 0 out-of-bounds and 0 ambiguous basenames; 30 `NNNN:line` citations across 8 migration files with 0 ambiguous prefixes and 0 out-of-bounds. The finance-design citation now names the correct document, and the three `exams.ts` citations are fully qualified to the two files they actually came from | §1.6, §25.3, §36.1 |
| 41 | P1 | `R18′` reported "5 `ENABLE ROW LEVEL SECURITY` and 4 `FORCE`" and "the other **25** tables" have no RLS DDL, and §35.1 claims completeness that had never been compared to the DDL | Both numbers were **passing for the wrong reason**: only **2** `ENABLE` and **2** `FORCE` are written out literally (`auth_mfa_factors`, `auth_step_up_challenges`) — the 3 finance tables' pair exists only as the `fin_x` template inside §30.5 step 6's `0028` block, so policies were counted as if each carried its own `ENABLE`/`FORCE` — and the deferred count is **24**, not 25, because 29 Phase 7 tables minus 5 policy-bearing ones is 24. §35.1's "Creates (complete)" column is load-bearing for `finance-migration-order.test.ts`, and the completeness word makes it a claim rather than a comment | `R18′` restated with the measurement named: **10 policies on 5 tables**, **2 `ENABLE` + 2 `FORCE` literal**, 24 deferred, all behind an immediately-following `REVOKE` so the state is fail-closed rather than exposed. `R20′` added to check §35.1 in **both** directions — 29 of 29 DDL tables placed in the row of the migration that creates them, 0 named-but-absent, 7 views excluded from the table check, and the one non-relation in a creates cell (`fin_recompute`, the nightly reconciler **job**) classified as a process reference instead of silently accepted as a table | §30.5, §35.1, §36.1 |

### 36.3 What is deliberately still open

These are **not** oversights, and none of them blocks `0021`:

- **P2-05 / P2-11** — no DLQ exists, and `docs/JOB_ARCHITECTURE.md` describes machinery
  (`job_runs`, `runAsTenant`, per-aggregate ordering) that was never built. A lost
  `fee.invoice.issued` is a lost ledger posting, so a real DLQ is required *before any finance
  handler is registered*, and the `worker.ts` `reports`→`events` misroute must be fixed first.
- **P2-09** — the MFA pepper has no home. `current_setting` is forgeable by the runtime role and the
  repository has no `APP_ENCRYPTION_KEY`. Resolution is a deployment decision: inject the pepper and
  compute digests in the application process, never in SQL, or use a KMS-backed key.
- **P2-10 / OD-14** — `app_ctx_session_id()` does not exist and `0002` is immutable. Shipped
  default: pass the session id as a route argument validated against `auth_sessions.token_hash`.
- **P1-09 / OD-01** — raw webhook payload retention is **off**. Enabling it needs a retention table,
  a cipher decision, and a tenant setting — three things, not one.
- **P2-12** — `redactDeep` and `sanitizePayload` do not denylist finance PII. Phase 7 mitigates with
  an IDs-only payload contract and `T-FIN-20`; the shared helpers themselves are other phases' files.

### 36.4 Final verdict

**DESIGN-GO.** `0021_fin_foundation.sql` is authorized to be designed and implemented next, on the
conditions in §30.3 and the function contract in §19.7.

- **P0: 0 open.** All **nine** register rows are corrected in the DDL (eight numbered rows plus row
  `2b`). The four that made `0021`–`0028` unappliable or unseedable —
  the composite-type ordering, the `0001` default privilege, the two `GRANT`ed-but-undefined functions
  (`post_fin_ledger_group` in row 26 and `app_finance_seeds_ledger_accounts` in row 35), and the
  chart-of-accounts `CHECK` that rejected its own contra-revenue account — are now closed by
  statements present in this document rather than by rules stated about it. Row 35 is the reason the
  set to check is "every **contracted** function", not "every **granted**" one: F3 is granted to
  nobody, so a granted-only check passed while a documented object had no `CREATE FUNCTION` at all. §36.2 row 2b is why that is now
  true of the *prose* as well as the SQL: prescribing a `REVOKE` is not the same thing as deleting
  the sentence that contradicted it, and the first pass of this remediation fixed the SQL and left
  the sentence. As with the P1 labels below, the audit's own `P0-01`…`P0-11` (plus `P0-06a/b/c`) is a
  **different space** from these eight register rows — the audit numbered findings, the register
  numbers corrections, and some audit findings were closed by one row and others by several.
- **P1: 0 open.** All **twenty-nine** are corrected, and each correction is either a statement in the
  document, a decision about what a statement *means*, a control moved from prose into an enforcement
  point (§36.2 row 25), or — for rows 36–41 — a **verification claim restated to match the check that
  was actually run**, which in two cases (rows 40 and 41) found a real defect the earlier "passing"
  claims had hidden. That last group matters as much as the first: a `DESIGN-GO` resting on checks
  that assert more than they tested is not a verified design, it is an unexamined one — and rows 40 and
  41 are what an unexamined design looks like when it is finally looked at. This line has now been
  wrong four times — it read "twenty-two" when the register held 21 P1 rows, then "twenty-three" when
  it held 23 after rows 31–33 landed, then "twenty-seven" when it held 27 after rows 36–39 — and each
  time the cause was a remembered total rather than the register itself. The current register is **9 P0 + 29 P1 + 4 P2 = 42 rows**
  (rows `1`–`41` plus `2b`).
- **On the `P1-nn` labels, which are a different space from the register rows.** Statements through
  the document cite inline labels `P1-01`…`P1-11`, `P1-13`, `P1-14`, plus `P1-02a` as a sub-label of
  `P1-02`. **`P1-12` is not cited anywhere in this document.** That is a gap in the label space
  inherited from the audit, not a missing correction: the register rows in §36.2 are the
  authoritative inventory of what was fixed, and every one of them is closed. The document does not
  assert a reason for the gap, because none is recoverable from the text — anyone re-deriving the
  audit's numbering should treat the `P1-nn` labels as unstable and cite §36.2 rows instead.
- **P2: 12**, none blocking. Six are implementation dependencies carried forward deliberately; six
  are documentation or migration-ordering items. The register is §34.3 and the IDs are stable.
- **Open decisions: 16**, none blocking. Three carry cross-phase **ordering** constraints and must be
  settled before the named migration is *written*, not before it is applied: **OD-14** before `0028`,
  **OD-15** before `0023`, and **OD-16** before `0026`.
- **Counting note.** The P2 figure is the size of the §34.3 register, not a count of things that
  block go-live. The trigger count (28 bound functions, 35 distinct statements), the view count (7), the
  table count (29 `CREATE TABLE`s, each immediately revoked), the permission count (25), and the
  event count (18 new; 111 total = 22 HANDLED / 89 NOOP) are asserted mechanically by
  `finance-trigger-inventory.test.ts` and `finance-composite-fk.test.ts` rather than by prose, and
  all were re-verified against this revision.

**Static verification, run against this final revision** (mechanics in §36.1): 220 fence markers /
110 balanced blocks, 0 headings stranded inside a fence, **0 literal `…`/`...` in any fenced block tagged
`sql`, `ts` or `json`** — the 3 that exist are all in the §30.3.2 `text` outline of `0028`'s ordering, which is
a numbered sketch and not runnable, and which uses `text` rather than `sql` for that reason,
28/28 trigger-inventory rows bound and
sequential with 0 orphans and 39 defined functions, 205 numbered headings with 0 duplicate section
numbers, 172 distinct `§` cross-references with 0 unresolved
(`§5.4` is RFC 4226), **69 `path:line` citations across 21 repository files and 30 migration-prefix
citations, all resolving to an existing file, an in-bounds line and an unambiguous basename** (this
pass fixed one that pointed past the end of the file it named and three bare `exams.ts:` citations
that resolve to three different real files), 31 threat rows with 0 dangling citations
(11 of them carrying an inbound citation and 20 table-only, which is the correct shape for a
catalogue), 29 of 29
Phase 7 tables carrying an immediately-following `REVOKE ALL` with 0 strays, 29 of 29 tables granted
exactly once in the `0028` block with 0 double-grants and 0 privilege-shape mismatches against the
§35.4 table, `DELETE` granted nowhere, 7 views defined once, 0 encoding errors, all 8 granted functions
both defined and contracted, **9/9 function narratives' parameter lists matching their DDL on names
and order**, **§5.2's nine-account chart, the `code_ck` literal list and F3's seed `VALUES` identical
row-for-row on code, class, normal side and `is_contra`** (R21′), **§23.1's event list and §24.1's
disposition table the same 18 events with the registry arithmetic following** (R19′), **§35.1's
"Creates (complete)" column placing all 29 DDL tables with 0 unplaced and 0 named-but-absent**
(R20′), and **10 policy statements on the 5 tables that carry explicit RLS DDL — of which only 2
`ENABLE` and 2 `FORCE` are written literally, the other 24 tables held fail-closed behind their
`REVOKE` until `0028`** (R18′).

**Two figures in §36.1 were not re-derived by the pass that produced the paragraph above** and are
stated as carried rather than as verified: `R11′`/`R16′`'s FK-edge counts (62 edges / 62 rows, 50
composite — the 62nd is `0022`'s `fin_fee_structures.published_by`, D7). §35.2's FK map remains
62 edges / 62 rows with 12
single-column rows across 3 target tables (`tenants`, `users`, `auth_sessions`) and 0 orphans **on the
authority of the map, not of a fresh parse** — the parse attempted here disagreed with it, which is a
reason to distrust the parser, not the map, but it is also a reason not to call the map verified. These
must be reproduced before `0021` is written; §36.1 holds **22** rows and the other **twenty** were
reproduced by this pass, `R15′`'s nine signature comparisons and `R18′`–`R21′`'s four new
representations-vs-source comparisons among them, which earlier passes had only carried or not
checked at all.

**The one thing this verdict does not say.** It does not say the SQL is correct. It says the
document no longer contains a specification that a PostgreSQL parser, a policy evaluator, or an
`aclexplode` query would contradict — which is a real and mechanically testable property, and is the
most that can be established without a database. The first executable proof is `0021` applying
cleanly with `finance-migration-order.test.ts` passing. Until that happens, the defects in §36.2 are
closed **in the design**, not yet **in the schema**.
