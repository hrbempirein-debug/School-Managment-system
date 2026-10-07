# PHASE 7 — CURRENT STATE

Implementation authority for Phase 7 (Fees + Finance). This file records **state**, not design.
The design authority remains `docs/PHASE_7_FINANCE_DESIGN.md`; where that document's historical
audit sections disagree, its latest amended requirement wins (§38, amended 2026-10-05).

## Current baseline

```text
HEAD                     d12b90416b2104846a3eee028c2de5460f1727c1
branch                   master
origin/master            d12b90416b2104846a3eee028c2de5460f1727c1   (identical to HEAD)
latest committed Phase 7 migration   0022_fin_fee_structures.sql
```

`0001`–`0022` are committed. `0023` and later exist **only in the working tree** and are untracked.

## Accepted

```text
0021_fin_foundation.sql
0022_fin_fee_structures.sql
```

Both are accepted as previously verified. Do **not** re-audit them. Treat them as correct unless a
later migration demonstrably proves an actual incompatibility.

## Pending

```text
0023_fin_invoices.sql                     untracked, executable, not yet committed
0024_fin_payments.sql                     untracked, executable, not yet committed
0025_fin_refunds.sql                      untracked, executable, not yet committed
0025 forward remediation tail             5 untracked forward files (see Current blocker)
0026_fin_ledger.sql                       NOT AUTHORIZED — quarantined
0027_fin_reconciliation.sql               NOT AUTHORIZED — quarantined
0028_fin_runtime_security.sql             NOT AUTHORIZED — quarantined
0029_fin_final.sql                        NOT AUTHORIZED — quarantined
API                                       not started / not authorized
Worker                                    not started / not authorized
Web                                       not started / not authorized
E2E                                       not started / not authorized
```

`0026`–`0029` are unverified drafts. They were removed from `packages/db/migrations/` and now live in
`packages/db/migrations-not-authorized/`, which the migration runner does not read. They must not be
moved back into `packages/db/migrations/` until explicitly authorized. **Do not place a quarantine
*subdirectory* inside `packages/db/migrations/`**: `phase6-migration-regression.test.ts` copies every
directory entry it selects and fails with `EISDIR` on a directory.

## Current blocker

### The 0025 forward-remediation gate

`0025_fin_refunds.sql` is immutable and does not satisfy four canonical requirements. Each is closed
**forward-only**, by the five-file remediation tail applied after it:

| # | Canonical requirement | Closed by | Live catalog verified |
|---|---|---|---|
| R1 | `trg_fin_refund_provenance` is `SECURITY INVOKER` | `0025_lock_model_remediation.sql`, restated in `0025_refund_provenance_remediation.sql` | `prosecdef = false`, owner `school_migrator`, `school_app_rw` has no `EXECUTE` |
| R2 | `fin_pa_refund_fk` is `ON DELETE NO ACTION` | `0025_refund_fk_remediation.sql` | `confdeltype = 'a'`, validated, not deferrable; `fin_payment_allocations.tenant_id` stays `NOT NULL` |
| R3 | a reversal's target allocation must have `effect = 'apply'` | `0025_refund_provenance_remediation.sql` (check 4, target locked `FOR UPDATE`) | present in the live function body and enforced behaviourally |
| R4 | link creation requires refund `status IN ('requested','approved')` | `0025_refund_provenance_remediation.sql` (check 5, read under the lock taken at check 1) | present in the live function body and enforced behaviourally |

Supporting tail files: `0025_privilege_remediation.sql` (no runtime-reachable `fin_*` table
privilege) and `0025_refund_security_postcondition.sql` (read-only fail-closed gate over R1–R4, D2
and D2C).

Still open, and **not** closable by a forward migration at this stage:

- `schema_migrations` stores `version` + `applied_at` and **no checksums**, so applied-file drift
  cannot be detected by the runner (design §38.5 item 5). Redesigning the runner is out of scope.
- F11 `postRefundApproval`, F12 `postRefundProcess`, F8 `app_consume_step_up` remain strictly
  `0028`-owned and do not exist. `app_ctx_session_id()` does not exist.
- Finance RLS and finance grants remain `0028`-owned; at this stage `school_app_rw` holds **no**
  privilege on any of the 20 `fin_*` tables and no `fin_*` table has RLS enabled. That is the
  intended fail-closed posture for this checkpoint.
- **Known live drift:** `school_saas_dev` still records `0026`–`0029` in `schema_migrations` and
  still carries objects those files created, while the files are now quarantined and uncommitted.
  `school_migrator` has no `CREATEDB`, so rebuilding that database is an operator action. Treat
  `school_saas_dev` as contaminated by unauthorized draft work until it is rebuilt from
  `0001`…`0025` + tail. Do not use it as a verification target.

### Why Phase 7 still cannot proceed to `0026`

`0023`/`0024` verification is **incomplete**. The migrations execute cleanly from an empty database
and their own dedicated suites pass, but the two committed `0022`-checkpoint suites
(`finance-composite-fk.test.ts`, `finance-trigger-inventory.test.ts`) assert global catalog facts
("exactly 23 FKs across the 7 0022 tables", "exactly 8 `trg_fin_*` bindings", "exactly the 12 finance
tables", "`fin_invoices` absent", "no FK points at `fin_billing_run_items`") that `0023`–`0025`
legitimately invalidated. 11 assertions fail. In addition `packages/db/src/schema.ts` still declares
only the `0021`+`0022` slice, so it does not mirror the 8 tables `0023`–`0025` added and does not
declare `fin_bri_invoice_fk`, which `0023` installed on the `0022` table `fin_billing_run_items`.
Closing that is `0023`/`0024` work, not a `0025` concern.

## Rules

```text
0001–0022 immutable      never edited
0025 immutable          never edited
forward-only remediation  every correction is a NEW later migration
0026–0029 not yet authorized
API/UI not yet authorized
```

No `0021`–`0025` file may be edited to close any of the requirements above. Modular-monolith
architecture, PostgreSQL + RLS + Redis + events, and the Phase 0–6 design are unchanged.

## Next authorized task

```text
0023/0024 executable verification followed by
0025 forward remediation and verification
```

Status of that task as of this normalization pass:

- **Done and green:** the `0025` remediation tail — empty-database chain `0001`…`0025` + tail applies
  (30 files), and `finance-refund-remediation.test.ts` is 37/37 against the disposable database.
- **Remaining:** the 11 stale `0022`-checkpoint assertions listed above, `schema.ts` coverage for
  `0023`–`0025`, and a dedicated `0023` behavioural suite.
- **Still not authorized afterwards:** `0026`, `0027`, `0028`, `0029`, finance API, worker, UI, E2E.
