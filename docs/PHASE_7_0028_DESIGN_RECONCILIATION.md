# Phase 7 — `0028` Design Reconciliation Report

**Status:** DESIGN RECONCILIATION — AMENDMENT ONLY. Deliverables A–I complete; **all four §I blockers closed by ruling (see §I and §J).**
**Design state:** `0028 DESIGN IS NOW INTERNALLY AUTHORIZED FOR IMPLEMENTATION, SUBJECT TO THE EXISTING §38.7 FORWARD-REMEDIATION AND INDEPENDENT-VERIFICATION GATES.`
**Gate (unchanged):** `DESIGN-AMENDED — FORWARD-REMEDIATION REQUIRED` (§38.7, not upgraded by this report).
**Scope of this document:** deliverables A–J only. **No implementation.** No migration, test, schema, API, worker or UI file is created or modified. `0001`–`0027` are untouched. `school_saas_dev` is untouched — read-only, and its stale `schema_migrations` rows are classified as external/pre-existing drift (§G Stage 1 item 2).

## Evidence base and method

Authorized sources: `docs/PHASE_7_FINANCE_DESIGN.md`, accepted migrations `0001`–`0027`,
`packages/db/src/schema.ts`, existing finance security/RLS tests, quarantined `0028` (reference only).

| Evidence | Result |
|---|---|
| `grep CREATE TABLE packages/db/migrations/002*.sql` | exactly 25 `fin_*` tables (§A) |
| Live `school_saas_dev` catalog probe | 25 tables, `relrowsecurity=false`, 0 policies, `school_app_rw` holds **zero** grants on every `fin_*` table |
| **Probe A** (rolled back): create a table with `FORCE`, no UPDATE/DELETE policy, migrate-able owner | owner `UPDATE` → **0 rows, no error, BEFORE-trigger guard does NOT fire**; owner `DELETE` → same; owner `INSERT` → `42501` |
| **Probe B** (zero footprint): `select app_finance_actor_class()` as `school_app_rw` | returns **`'system'`** while `app_privileged() = false` and `app_ctx_scope() = null` |
| **Probe C** (zero footprint): `select app_finance_actor_has_permission('x')` as `school_app_rw` | **`42501 permission denied for function`** |
| **Probe D** (zero footprint): `select count(*) from fin_tenant_settings` as `school_app_rw` | `42501 permission denied for table` (pre-0028 fail-closed confirmed) |
| Role membership between `school_migrator` and `school_app_rw` | **none in either direction** — no `SET ROLE` possible in one session |
| `packages/db/src/cli/migrate.ts` | `schema_migrations.version` is the **full filename**; `applied.has(file)` |

Probe A and Probe B/C are load-bearing and are cited again in §B, §E, §F.

---

## A. Finance object inventory — the 25 tables of `0021`–`0027`

| # | Table | Created by | §19.2 class | §35.4 row? | Live RLS/policy/`school_app_rw` ACL |
|---|---|---|---|---|---|
| 1 | `fin_tenant_settings` | 0021 | Configuration | yes | off / none / none |
| 2 | `fin_ledger_accounts` | 0021 | **not listed** | yes | off / none / none |
| 3 | `fin_document_counters` | 0021 | Operational money | yes | off / none / none |
| 4 | `fin_fee_heads` | 0021 | Configuration | yes | off / none / none |
| 5 | `fin_tax_profiles` | 0021 | Configuration | yes | off / none / none |
| 6 | `fin_fee_structures` | 0022 | Configuration | yes (grouped) | off / none / none |
| 7 | `fin_fee_structure_items` | 0022 | Configuration | yes (grouped) | off / none / none |
| 8 | `fin_fee_installment_plans` | 0022 | Configuration | yes (grouped) | off / none / none |
| 9 | `fin_fee_structure_targets` | 0022 | Configuration | yes (grouped) | off / none / none |
| 10 | `fin_fee_assignments` | 0022 | Configuration | yes | off / none / none |
| 11 | `fin_billing_runs` | 0022 | **not listed** | yes | off / none / none |
| 12 | `fin_billing_run_items` | 0022 | **not listed** | yes | off / none / none |
| 13 | `fin_invoices` | 0023 | Document money | yes (grouped) | off / none / none |
| 14 | `fin_invoice_items` | 0023 | Document money | yes (grouped) | off / none / none |
| 15 | `fin_invoice_adjustments` | 0023 | Document money | yes (grouped) | off / none / none |
| 16 | `fin_challans` | 0023 | Document money | yes | off / none / none |
| 17 | `fin_payments` | 0024 | Operational money | yes | off / none / none |
| 18 | `fin_payment_allocations` | 0024 | Operational money | yes | off / none / none |
| 19 | `fin_receipts` | 0024 | Portal document | yes | off / none / none |
| 20 | `fin_refunds` | 0025 | Operational money | yes | off / none / none |
| 21 | `fin_ledger_entry_groups` | 0026 | Operational money | yes | off / none / none |
| 22 | `fin_ledger_entries` | 0026 | Operational money | yes | off / none / none |
| 23 | **`fin_ledger_event_types`** | 0026 | **not listed** | **no** | off / none / none |
| 24 | `fin_reconciliation_batches` | 0027 | Operational money | yes | off / none / none |
| 25 | `fin_reconciliation_matches` | 0027 | Operational money | yes | off / none / none |

**Coverage gaps found (deliverable A's purpose).**

- §19.2's four-class partition names **21 of 25**: it omits `fin_ledger_accounts`, `fin_billing_runs`,
  `fin_billing_run_items`, `fin_ledger_event_types`.
- §35.4's table names **24 of 25**: it omits `fin_ledger_event_types`.
- §35.4 additionally carries **three tables that are not `0028`'s** (`fin_document_artifacts`,
  `fin_payment_gateway_webhooks`, `fin_provider_accounts`) and two non-`fin_*` tables
  (`auth_mfa_factors`, `auth_step_up_challenges`). Per §30.1 the three `fin_*` artifacts are **`0029`**;
  per ruling B7 their grants are **removed from the `0028` normative spec** and restated here as
  `0029` scope. The two `auth_*` tables **are** `0028`'s (§30.1 row 0028) and are in scope.
- Resolution of the 4 omitted `fin_*` classes, stated so no table is unclassified:
  `fin_billing_runs` / `fin_billing_run_items` → **Configuration** (they are generated by §8
  assignments and share `fees.assignments.manage`); `fin_ledger_accounts` → **Configuration,
  owner-write-only** (F3 seeds it, `school_app_rw` never writes it); `fin_ledger_event_types` →
  **owner-only closed catalogue**, a fifth class with *no runtime privilege at any level* (§D).

---

## B. Complete RLS / policy matrix — all 25 tables, all four commands

### B.0 Notation and the three derivation rules

| Symbol | Meaning |
|---|---|
| `P` | `app_privileged()` — true iff `current_user = 'school_migrator'` |
| `T(t)` | `app_ctx_scope() = 'tenant' AND app_current_tenant_id() = <t>.tenant_id` |
| `C` | `app_finance_actor_class() = 'finance_staff'` |
| `K(x)` | inline permission predicate, defined **once** below |
| `G` | `(<t>.student_id IN (SELECT app_finance_linked_students()))` |
| `R` | `(<t>.payer_guardian_id IN (SELECT app_finance_current_guardian_ids()))` |

```sql
-- K(x) — the permission primitive, inlined in the policy body.
-- No EXECUTE grant is needed because the policy is evaluated as the session role,
-- and school_app_rw already holds SELECT on all four RBAC tables (0001:378 + FORCE
-- policies admitting exactly the ticket's tenant rows).
CREATE FUNCTION app_finance_permission_held(p_permission text) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path = pg_catalog, public, pg_temp
AS $$
    SELECT EXISTS (
        SELECT 1
        FROM memberships m
        JOIN membership_roles mr ON mr.membership_id = m.id
        JOIN roles r            ON r.id = mr.role_id
        JOIN role_permissions rp ON rp.role_id = r.id
        WHERE m.tenant_id = app_current_tenant_id()
          AND m.user_id   = app_ctx_user()
          AND m.status    = 'active'
          AND r.tenant_id = m.tenant_id
          AND rp.permission = p_permission);
$$;
REVOKE ALL ON FUNCTION app_finance_permission_held(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_finance_permission_held(text) TO school_app_rw;
```

> `K(x)` is written as `app_finance_permission_held('…')` in the matrix below. It is **not** F13:
> it is deliberately `SECURITY INVOKER`-equivalent in trust model (a SECURITY DEFINER wrapper is
> used only so the RBAC read does not depend on the caller's own RLS reach, and it is granted
> EXECUTE to `school_app_rw`, which is the point at which Probe C matters).

**Why `K` is inlined rather than F13 (ruling 6, empirically forced).** Probe C shows
`app_finance_actor_has_permission` is **not executable** by `school_app_rw`. Policy expressions are
evaluated as the session role — `0002` grants `EXECUTE` on `app_privileged()` to `school_app_rw`
precisely because policies call it. Therefore **F13 must not appear in any policy predicate**.
Ruling 6's "no `EXECUTE` grant to `school_app_rw`" and ruling 2's "explicit permission is the
authorization primitive" are jointly satisfied by `K`.

**Rule 1 — visibility (`SELECT`) is classified, not permissioned.**
`P OR (T(t) AND <§35.4 SELECT cell>)`. The §35.4 "RLS branch — SELECT sees" cells name *classes*;
§19.2 names *classes*. A SELECT policy does not authorize a write, so no `K` appears in it.

**Rule 2 — write (`INSERT`/`UPDATE`) is permissioned where a permission is named.**
`P OR (T(t) AND C AND K(<permission>))` when §35.4's write cell names one of the seven permissions of
ruling 2; `P OR (T(t) AND C)` when the cell names only `finance_staff`. **The actor class is an
additional conjunct, never a substitute.**

**Rule 3 — `DELETE` is `P`-only, except where owner-deletion must be refused outright.**
`USING (app_privileged())`. Omitting the policy does **not** refuse the owner: Probe A proves the
owner's DELETE then **silently affects 0 rows and the `BEFORE` guard never fires**, which regresses
every `migReject(..., '55000')` delete assertion. Omission is therefore a *weaker* control than a
`P`-only policy for every guarded table.

### B.1 The matrix

`ACL` columns are the `0028` table grant to `school_app_rw` (`S`/`I`/`U`/`D` = SELECT/INSERT/UPDATE/DELETE;
`U(cols)` = column list; `—` = deliberately revoked). `Policy` columns are the normative predicates.

| Table | ACL S | ACL I | ACL U | ACL D | `SELECT` policy (USING) | `INSERT` policy (WITH CHECK) | `UPDATE` policy (USING) | `DELETE` policy (USING) |
|---|---|---|---|---|---|---|---|---|
| `fin_tenant_settings` | ✓ | ✓ | ✓ | — | `P OR (T AND C)` | `P OR (T AND C)` | `P OR (T AND C)` | `P` |
| `fin_ledger_accounts` | ✓ | — (F3) | — | — | `P OR (T AND C)` | `P` | `P` | — (omit) |
| `fin_document_counters` | ✓ | ✓ | — | — | `P OR (T AND C)` | `P OR (T AND C)` | **`P`** | `P` |
| `fin_fee_heads` | ✓ | ✓ | ✓ | — | `P OR (T AND C)` | `P OR (T AND C AND K('fees.structures.manage'))` | `P OR (T AND C AND K('fees.structures.manage'))` | `P` |
| `fin_tax_profiles` | ✓ | ✓ | ✓ | — | `P OR (T AND C)` | `P OR (T AND C AND K('fees.structures.manage'))` | `P OR (T AND C AND K('fees.structures.manage'))` | `P` |
| `fin_fee_structures` | ✓ | ✓ | ✓ | — | `P OR (T AND C)` | `P OR (T AND C AND K('fees.structures.manage'))` | `P OR (T AND C AND K('fees.structures.manage'))` | `P` |
| `fin_fee_structure_items` | ✓ | ✓ | ✓ | — | `P OR (T AND C)` | `P OR (T AND C AND K('fees.structures.manage'))` | `P OR (T AND C AND K('fees.structures.manage'))` | `P` |
| `fin_fee_installment_plans` | ✓ | ✓ | ✓ | — | `P OR (T AND C)` | `P OR (T AND C AND K('fees.structures.manage'))` | `P OR (T AND C AND K('fees.structures.manage'))` | `P` |
| `fin_fee_structure_targets` | ✓ | ✓ | ✓ | — | `P OR (T AND C)` | `P OR (T AND C AND K('fees.structures.manage'))` | `P OR (T AND C AND K('fees.structures.manage'))` | `P` |
| `fin_fee_assignments` | ✓ | ✓ | ✓ | — | `P OR (T AND C)` | `P OR (T AND C AND K('fees.assignments.manage'))` | `P OR (T AND C AND K('fees.assignments.manage'))` | `P` |
| `fin_billing_runs` | ✓ | ✓ | — | — | `P OR (T AND C)` | `P OR (T AND C AND K('fees.assignments.manage'))` | **`P`** | `P` |
| `fin_billing_run_items` | ✓ | ✓ | — | — | `P OR (T AND C)` | `P OR (T AND C AND K('fees.assignments.manage'))` | **`P`** | `P` |
| `fin_invoices` | ✓ | U(cols) | U(cols) | — | `P OR (T AND (C OR G))` | `P OR (T AND C)` | `P OR (T AND C)` | `P` |
| `fin_invoice_items` | ✓ | U(cols) | U(cols) | — | `P OR (T AND C)` | `P OR (T AND C)` | `P OR (T AND C)` | `P` |
| `fin_invoice_adjustments` | ✓ | U(cols) | U(cols) | — | `P OR (T AND C)` | `P OR (T AND C)` | `P OR (T AND C)` | `P` |
| `fin_challans` | ✓ | ✓ | — | — | `P OR (T AND (C OR G))` | `P OR (T AND C AND K('fees.invoices.issue'))` | **`P`** | `P` |
| `fin_payments` | ✓ | ✓ | — | — | `P OR (T AND C)` | `P OR (T AND C AND K('fees.payments.collect'))` | **`P`** | `P` |
| `fin_payment_allocations` | ✓ | ✓ | — | — | `P OR (T AND C)` | `P OR (T AND C AND K('fees.payments.collect'))` | **`P`** | **`P`** |
| `fin_receipts` | ✓ | ✓ | — | — | `P OR (T AND (C OR R))` | `P OR (T AND C AND (K('fees.receipts.reissue') OR K('fees.payments.collect')))` | **`P`** (§I.1, ruling) | — (omit) |
| `fin_refunds` | ✓ | ✓ | — | — | `P OR (T AND C)` | `P OR (T AND C AND K('fees.refunds.request'))` | **`P`** | `P` |
| `fin_reconciliation_batches` | ✓ | ✓ | ✓ | — | `P OR (T AND C)` | `P OR (T AND C AND K('fees.reconciliation.manage'))` | `P OR (T AND C AND K('fees.reconciliation.manage'))` | `P` |
| `fin_reconciliation_matches` | ✓ | ✓ | ✓ | — | `P OR (T AND C)` | `P OR (T AND C AND K('fees.reconciliation.manage'))` | `P OR (T AND C AND K('fees.reconciliation.manage'))` | `P` |
| `fin_ledger_entry_groups` | ✓ | — (F4) | — | — | `P OR (T AND C)` | **`P`** | **`P`** | — (omit) |
| `fin_ledger_entries` | ✓ | — (F4) | — | — | `P OR (T AND C)` | **`P`** | **`P`** | — (omit) |
| **`fin_ledger_event_types`** | **—** | **—** | **—** | **—** | **`P`** | **`P`** | **`P`** | **`P`** |

`auth_mfa_factors`, `auth_step_up_challenges` (in scope, `0028`): `S`/`I`/`U` granted, `D` revoked;
`SELECT`/`INSERT`/`UPDATE` policy `P OR (app_current_user_id() = <t>.user_id)` — **no
`app_privileged()` branch**, per §35.4 lines 15386–15387. `DELETE` omitted.

**Ruling I.3 — `fin_receipts` INSERT, CLOSED, NORMATIVE.** The cell is
`P OR (T AND C AND (K('fees.receipts.reissue') OR K('fees.payments.collect')))` with the normal
tenant and actor-class predicates, where `fees.receipts.reissue` is the explicit receipt-reissue
route (`/finance/payments/:id/receipt-reissue`, §35.5 line 15574) and `fees.payments.collect` is
the payment-issued receipt route (§19.2 line 8893, "a receipt is minted by a payment"). **No third
permission is invented.** There is currently no `INSERT INTO fin_receipts` producer in any migration
or in `apps/api/src`; that absence means *the application producer is not yet implemented*, not that
the policy is wrong. **This policy is authoritative for the future payment/receipt producer** and the
producer must be written to satisfy it.

**Ruling I.2 — ledger event-type naming, applies to §B.1's `fin_ledger_event_types` row.** The
accepted `0026` catalogue names are canonical; see §E.1 for the design rule and for F11/F12's exact
post types. No `fee.refund.*` row is added to the catalogue, and `0026` is not modified.

### B.2 Every `P`-only and omitted cell, with the reason it is not a placeholder

These are the cells where an unspecified policy could have been invented (ruling B6 forbids that),
so each is derived rather than asserted:

1. **`UPDATE … USING (P)` on `fin_document_counters`** — §35.4 line 15368: table-wide UPDATE is
   revoked so "only `trg_fin_invoice_number` (F5d) can advance a counter". F5d is `SECURITY DEFINER`
   (§16.5.2 row 1). Without a `P` policy, Probe A makes F5d's `UPDATE fin_document_counters`
   (0023:824) silently update nothing → the first issued invoice gets no number.
2. **`UPDATE … USING (P)` on `fin_challans`** — `trg_fin_challan_refresh` (0024:893) is the only
   writer; §35.4 line 15375 revokes table UPDATE. Same failure mode.
3. **`UPDATE … USING (P)` on `fin_payments` / `fin_payment_allocations`** — F11/F12 lock
   `SELECT … FOR UPDATE` on `fin_payments`; `fin_invoice_reapply_derived_state` (INVOKER, 0024:580)
   runs as the definer when invoked from a definer and as `school_app_rw` when invoked from a route.
   `P` covers the definer path.
4. **`UPDATE … USING (P)` on `fin_refunds`** — **this is the correction of §35.4 line 15378 and
   §30.1 line 13716.** Both claim F11/F12 "bypasses this policy entirely". They do not: Probe A plus
   `FORCE` means a `SECURITY DEFINER` body owned by `school_migrator` runs as the table owner and
   **is** subject to the policy. With §35.4's written predicate (class-only, no `P`) F11/F12's
   `UPDATE fin_refunds` would be a **silent no-op**. The ACL stays revoked (runtime cannot update
   refunds); the `P` policy is what makes F11/F12 the *only* writers, which is the intent of
   §35.4's own sentence.
5. **`UPDATE … USING (P)` on `fin_receipts` — RULING I.1, CLOSED, NORMATIVE.** The predicate is
   exactly `USING (app_privileged())`, not `P OR (T AND …)`, and it is **not** to be weakened to a
   silent zero-row no-op. Layering, stated so §19.2/§19.4's word "immutable" has one meaning:
   * **RLS layer** — only the privileged/system context can reach `UPDATE` at all.
     `school_app_rw` holds no `UPDATE` ACL on `fin_receipts` (§D.2 Shape 3), so runtime is refused
     at the statement layer with `42501`; the `P` predicate is what lets the owner's statement
     proceed past RLS.
   * **Trigger layer** — `trg_fin_receipt_freeze` is what *enforces* immutability and raises
     `55000`.
   * **Reconciled wording for §19.2 line 8887 and §19.4 line 9041:** "immutable" means *no UPDATE
     ever succeeds* — it does **not** mean *no UPDATE policy exists*. §19.4's "deliberately no
     UPDATE policy" is superseded: a missing policy under `FORCE` does not forbid the owner, it
     silently no-ops (Probe A), which **prevents** the authoritative negative test from reaching
     the trigger. The `P`-only policy is therefore the mechanism that *makes* §19.2's "no `UPDATE`
     for anybody" true, because it routes every attempt to the guard that refuses it.
   `finance-payments.test.ts:2147` (`migReject(UPDATE fin_receipts, '55000')` as migrator) is the
   binding test that requires this shape; §19.2's "no `DELETE` for anybody" is unchanged and its
   `DELETE` policy stays **omitted** (§B.2.10).
6. **`UPDATE … USING (P)` on `fin_billing_runs(+items)`** — `trg_fin_billing_run_freeze` and the
   `migReject(..., '55000')` assertions in `finance-trigger-inventory.test.ts` execute as migrator.
7. **`UPDATE … USING (P)` on `fin_ledger_entry_groups`** — F4 (0026:709) and
   `trg_fin_ledger_group_balance` (0026:345) issue `UPDATE fin_ledger_entry_groups`; §35.4 line 15381
   revokes table UPDATE. Also required for `trg_fin_ledger_append_only` (0026) to raise `55000` on a
   direct entry write.
8. **`INSERT … USING (P)` on `fin_ledger_entry_groups` / `fin_ledger_entries`** — §35.4 lines
   15381–15382: "F4 `post_fin_ledger_group()` only". F4 is `SECURITY DEFINER`; `P` is its admission.
   This is not a runtime path and grants the runtime role nothing (ACL INSERT is revoked).
9. **`INSERT/UPDATE/SELECT … P`-only on `fin_ledger_event_types`** — ruling B8: the 0026 immutable
   runtime boundary is preserved. Inventorying the table does not create runtime access: all four ACL
   privileges are withheld and the owner's own catalogue is the only writer.
10. **Omitted `DELETE` on `fin_ledger_entry_groups` / `fin_ledger_entries` / `fin_ledger_accounts`
    / `fin_receipts`** — owner-deletion is refused by silence, which Probe A shows is a *stronger*
    refusal than a policy (it refuses the owner too, with no error path to mishandle). For the three
    ledger tables this matches §35.4 line 15287 ("`REVOKE INSERT, UPDATE, DELETE` … F4 is the sole
    write path") and for `fin_receipts` it matches §19.2's "no `DELETE` … for anybody".
    **`fin_ledger_event_types` keeps `DELETE … USING (P)`** because its row is a *catalogue* whose
    owner is allowed to retire entries; it has no immutability trigger to protect.
11. **`SELECT … P OR (T AND C)` on `fin_ledger_accounts` / counters / billing runs** — §35.4's SELECT
    cell reads `finance_staff` for all of them; §19.2's omission of those tables is repaired by §A.

### B.3 What §19.4's three printed bodies become under Rule 2

§19.4 prints only three policies (`fin_payments`, `fin_invoices`, `fin_receipts`); §35.4 supplies the
rest as prose cells. Under rulings 1 and 2 the three printed bodies are amended:

| §19.4 as printed | Amended form |
|---|---|
| `fin_payments_insert` class-only | `WITH CHECK (P OR (T AND C AND K('fees.payments.collect')))` |
| `fin_receipts_insert` class-only | `WITH CHECK (P OR (T AND C AND (K('fees.receipts.reissue') OR K('fees.payments.collect'))))` |
| `fin_invoices_select` (no UPDATE/DELETE body printed; prose line 9027 says "restricted to `finance_staff`") | `UPDATE … USING (P OR (T AND C))`, `DELETE … USING (P)` |
| `fin_receipts_select` (line 9041: deliberately no UPDATE/DELETE) | `UPDATE … USING (P)` added (§I.2); `DELETE` omitted (§B.2.10) |

---

## C. Permission versus actor class — ruling 2, and the three-way contradiction

### C.1 The contradiction, quoted

| Source | Text |
|---|---|
| §19.2 lines 8897–8899 | "Staff visibility is **not** expressed in RLS by permission… **RLS classifies by role code; the route layer classifies by permission. Both layers are required, and neither substitutes for the other.**" |
| §19.4 lines 8999–9054 | every printed policy predicate tests `app_finance_actor_class()`; **no policy tests a permission** |
| §35.4 line 15296–15305 | "`RLS branch` … is **which rows a given actor class may see or write**… a cell saying `fees.structures.manage` in an `INSERT` column is describing a *policy branch*, not a privilege" |
| §35.4 write cells (15369–15380) | seven cells name **permissions**, not classes |
| §19.5 assertion (2) (9141–9151) | every `fin_%` policy containing `app_privileged()` must contain `app_finance_actor_class()` |

§19.2 says RLS must *not* carry permission. §35.4's own write cells *do* carry permission. §19.4
implements §19.2 (class only) and therefore contradicts §35.4's cells. §19.5 assertion (2) then
forces any policy containing `P` to also contain `C`, which is compatible with both readings but
makes a permission-only predicate impossible.

### C.2 The ruling, restated as the binding rule

**Permission is the authorization primitive. Actor class may only ever be an additional conjunct:
`tenant AND permission AND actor-class`. Actor class may not substitute for `fees.structures.manage`,
`fees.payments.collect`, `fees.receipts.reissue`, `fees.refunds.request`, `fees.reconciliation.manage`,
`fees.invoices.issue`, `fees.assignments.manage`.**

### C.3 How each source is reconciled (no source is silently discarded)

1. **Ruling 2 wins over §19.2's last paragraph, narrowed.** §19.2's sentence remains true for
   `SELECT` (Rule 1) — visibility is classified. It is *amended* for `INSERT`/`UPDATE`: where §35.4's
   write cell names one of the seven permissions, the predicate tests that permission. "Neither
   substitutes" is preserved literally: the class conjunct `C` is retained *alongside* `K`, so the
   route layer's permission check and the policy's permission check are two independent instances of
   the same primitive, and neither is replaced by the other.
2. **§35.4's own warning (15296–15305) is preserved and becomes a grant rule.** A permission in a
   policy cell is not a `GRANT`. §D issues the table grants; §B issues the predicates. Reading §B as
   §D would grant every table every write privilege — the exact defect §35.4 names.
3. **§19.5 assertion (2) is scoped, not deleted.** It fires today on §19.4's *own*
   `fin_payments_delete USING (app_privileged())` (no `app_finance_actor_class()`), and would fire on
   every `P`-only policy in §B.1 — a self-contradiction inside one section of the design. The amended
   assertion applies only to predicates that contain `app_ctx_scope()` (i.e. that *have* a runtime
   branch); a `P`-only predicate has no runtime branch and cannot be the "house OR-body" the comment
   describes:

   ```sql
   AND pg_get_expr(pol.polqual, pol.polrelid) LIKE '%app_ctx_scope()%'   -- added
   AND pg_get_expr(pol.polqual, pol.polrelid) LIKE '%app_privileged()%'
   AND pg_get_expr(pol.polqual, pol.polrelid) NOT LIKE '%app_finance_actor_class()%'
   ```
   Assertion (1) (no `app_ctx_scope() = 'platform'`) and assertion (3) (ENABLE+FORCE) are unchanged.
4. **Where §35.4's write cell says only `finance_staff`, class is correct and no `K` is added.**
   Those cells are `fin_tenant_settings`, `fin_document_counters`, `fin_invoices(+items,adjustments)`.
   None of them is one of ruling 2's seven permissions, so ruling 2 is not engaged. `fees.invoices.issue`
   (ruling 2) is realized on `fin_challans` (§35.4 line 15375), not on `fin_invoices`.
5. **Role-code classification is retired as a mechanism.** §19.3's `app_finance_actor_class()` already
   classifies by `roles.code IN ('school_owner','accountant','cashier')`, not by permission — so the
   mechanism never actually implemented §19.2's "role code" claim in a way that conflicts with `K`.
   §20.1/§20.5 place `cashier` in that list; §20.5 grants `cashier` exactly three permissions, two of
   which (`fees.payments.collect`, `fees.receipts.read`) are in §B.1's write cells. A cashier
   therefore passes `C` **and** `K('fees.payments.collect')` on `fin_payments`, and passes `C` but
   **fails** `K('fees.structures.manage')` on `fin_fee_heads` — which is precisely §20.5's intent and
   is impossible under a class-only predicate. **This is the concrete demonstration that ruling 2
   changes behaviour, not just wording.**

### C.4 Consequence that must be stated for the route layer

`packages/permissions/src/permissions.ts` `ROLE_TEMPLATES` currently contains **zero `fees.*`
permissions and no `cashier` role**, and `role_permissions` in the live database contains **0 `fees.*`
rows**. §B.1's `K` predicates are therefore **false for every actor until §20.5's backfill runs** —
and §20.5's backfill is a `0028` statement, not a code change. This ordering (policies → backfill →
grants) must hold inside `0028`, and the `ROLE_TEMPLATES` code change it implies is a **separate,
non-`0028` deliverable** with no effect on `0028`'s own correctness.

---

## D. Grant / revoke inventory — object by object

Ruling B8: the stale "17/16/10 grants" counts are discarded. Everything below is enumerated.

### D.1 Preconditions found in the live database

- `0001:378` `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO school_app_rw`
  and `0001:380-383` `ALTER DEFAULT PRIVILEGES … GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO
  school_app_rw` are **still live** (`aclexplode` shows `school_app_rw=arwd` on
  `fin_v_invoice_balance`, `fin_v_payment_position`). Every `CREATE TABLE` in `0028`/`0029` is
  therefore born fully granted unless `REVOKE ALL` follows immediately.
- `0001:378` also grants `school_app_rw` `SELECT, INSERT, UPDATE, DELETE` on **`memberships`,
  `roles`, `role_permissions`, `membership_roles`** — this is what makes `K` reachable (§B.0).
- All `0021`–`0027` tables already carry `REVOKE ALL … FROM school_app_rw` (0023:212/360/521/572,
  0024:162/237/320, 0025:91, 0027:37-38/55-56, and the `0021`/`0022` equivalents). **No `0021`–`0027`
  file is edited**; `0028` re-issues the grants its table requires.

### D.2 Table grants issued by `0028` (the only migration in which `school_app_rw` acquires `fin_*` access)

**Shape 1 — table-level `SELECT`, `INSERT`, `UPDATE` (three separate statements) plus
`REVOKE DELETE` — 10 tables:** `fin_tenant_settings`,
`fin_fee_heads`, `fin_tax_profiles`, `fin_fee_structures`, `fin_fee_structure_items`,
`fin_fee_installment_plans`, `fin_fee_structure_targets`, `fin_fee_assignments`,
`fin_reconciliation_batches`, `fin_reconciliation_matches` (10 tables; `DELETE` revoked on each).

**Shape 2 — column-level, three separate statements per table (9 statements):** §35.4 lines
15314–15335 are normative and are reproduced exactly:

```sql
GRANT SELECT ON fin_invoices TO school_app_rw;
GRANT INSERT (tenant_id, student_id, academic_year_id, enrollment_id, structure_id,
              due_date, void_reason, created_by) ON fin_invoices TO school_app_rw;
GRANT UPDATE (status, due_date, void_reason) ON fin_invoices TO school_app_rw;

GRANT SELECT ON fin_invoice_items TO school_app_rw;
GRANT INSERT (tenant_id, invoice_id, structure_id, installment_no, fee_head_id,
              quantity, unit_amount, tax_amount, description) ON fin_invoice_items TO school_app_rw;
GRANT UPDATE (description) ON fin_invoice_items TO school_app_rw;

GRANT SELECT ON fin_invoice_adjustments TO school_app_rw;
GRANT INSERT (tenant_id, invoice_id, adjustment_type, amount, reason, requested_by,
              reverses_adjustment_id) ON fin_invoice_adjustments TO school_app_rw;
GRANT UPDATE (status, approved_by, approved_at, rejected_reason)
    ON fin_invoice_adjustments TO school_app_rw;
```

`§16.5.1`'s INSERT lists (7837–7906) and `§35.4`'s lists (15321–15334) are **identical** — verified
column by column; there is no conflict to resolve.

**Shape 3 — `SELECT` + `INSERT` granted, `UPDATE` and `DELETE` revoked:** `fin_challans`, `fin_document_counters`, `fin_payments`,
`fin_payment_allocations`, `fin_receipts`, `fin_refunds`, `fin_billing_runs`, `fin_billing_run_items`.

**Shape 4 — `SELECT` only, `INSERT`/`UPDATE`/`DELETE` revoked:** `fin_ledger_entry_groups`, `fin_ledger_entries`.

**Shape 5 — zero runtime privilege:** `fin_ledger_accounts` (`S` only — F3 writes it), and
`fin_ledger_event_types` (**no grant at all**; ruling B8).

**Shape 6 — `auth_*` (in scope):** `auth_mfa_factors`, `auth_step_up_challenges` → `S, I, U`,
`DELETE` revoked.

**Removed from `0028` per ruling B7:** `fin_document_artifacts`, `fin_payment_gateway_webhooks`,
`fin_provider_accounts` — their §35.4 lines 15383–15385 rows are `0029` scope and are **not** part
of `0028`'s normative grant block.

### D.3 Revoke inventory (issued by `0028`, per table, immediately after any `CREATE TABLE`)

| Object | Statement |
|---|---|
| every `fin_*` and `auth_*` table `0028` creates | `REVOKE ALL ON <t> FROM school_app_rw, PUBLIC` |
| `fin_v_invoice_balance`, `fin_v_payment_position` | `REVOKE ALL … FROM school_app_rw, PUBLIC` then Shape 7 — **these two exist live with `a,r,w,d`** and 0024 issues no view revoke |
| `fin_v_ledger_account_balance`, `fin_v_ar_aging`, `fin_v_collections_summary`, `fin_v_fee_head_revenue`, `fin_v_on_account_summary` | 0026 already `REVOKE ALL`d them; `0028` re-issues `GRANT SELECT` only (Shape 7) |
| `fin_ledger_event_types` | `REVOKE ALL ON fin_ledger_event_types FROM school_app_rw, PUBLIC` (0026 already does this; `0028` asserts, does not grant) |
| every `fin_%` table's `DELETE` for `school_app_rw` | `REVOKE DELETE ON <t> FROM school_app_rw` for all 25 + 2 auth |
| every function created by `0028` | `REVOKE ALL … FROM PUBLIC`; then per §D.4 |

**Shape 7 — views (8 objects total; §35.4 line 15394 lists seven):**
`GRANT SELECT ON fin_v_invoice_balance, fin_v_payment_position, fin_v_ledger_account_balance,
fin_v_ar_aging, fin_v_collections_summary, fin_v_fee_head_revenue, fin_v_on_account_summary
TO school_app_rw;` — SELECT only, never written.

### D.4 Function grants

| Function | Owner | `PUBLIC` | `school_app_rw` | Rationale |
|---|---|---|---|---|
| `app_finance_actor_class()` (F1, replaced) | `school_migrator` | REVOKE | **GRANT** | called in every `C` predicate (§B.1) |
| `app_finance_linked_students()`, `app_finance_current_guardian_ids()` | `school_migrator` | REVOKE | **GRANT** | called in `G`/`R` |
| `app_finance_permission_held(text)` (new, §B.0) | `school_migrator` | REVOKE | **GRANT** | called in every `K` predicate |
| `postRefundApproval(...)` (F11), `postRefundProcess(...)` (F12) | `school_migrator` | REVOKE | **GRANT** | §30.3.2 step 7 route-callable |
| **`app_finance_actor_has_permission(text)` (F13)** | `school_migrator` | REVOKE | **NO GRANT — ruling 6** | called only from F11/F12 bodies |
| `app_finance_emit_event(...)` (F14) | `school_migrator` | REVOKE | **GRANT** (§19.7.3) | called by F11/F12 and by runtime-facing paths |
| `app_verify_mfa_code` (F7), `app_consume_step_up` (F8), `app_mint_step_up_challenge` (F9), `app_confirm_mfa_factor` (F10) | `school_migrator` | REVOKE | **GRANT** | §35.5 `— authenticated (self)` routes |
| `trg_fin_reversal_shape_check(...)` (amended, §F.3) | `school_migrator` | REVOKE | not granted directly (fires as trigger) | trigger function |

`app_finance_actor_class()` and `app_finance_permission_held()` are `SECURITY DEFINER` so that the
RBAC/relationship read is not itself filtered by the caller's reach — §19.3 lines 8977–8982 states
this reason for the existing helpers.

---

## E. Corrected function register — F1, F11, F12, F13, F14

| # | Function | Belongs to | Signature | Status now | Correction required |
|---|---|---|---|---|---|
| **F1** | `app_finance_actor_class()` | **`0021`** (accepted, immutable) | `() RETURNS text` | exists; live body = §19.3 | **Ruling 5:** `0028` issues `CREATE OR REPLACE` that **deletes the `WHEN app_privileged() THEN 'system'` arm**. Probe B proves that arm makes every `SECURITY DEFINER` caller `'system'` (inside a definer body `current_user = school_migrator`, so `app_privileged()` is unconditionally true) — which makes `C` false everywhere and denies all runtime access. Class is then derived solely from `0002`'s session model: `app_ctx_scope()`/`app_ctx_user()` + the RBAC join. `'system'` ceases to be a produced value. **`0021` is not edited.** |
| **F11** | `postRefundApproval` | **`0028`** (§30.1 row 0025 explicitly denies `0025`; §38.6) | **`postRefundApproval(p_session_id uuid, p_refund_id uuid, p_action text) RETURNS void`** | absent from every database (§38.6) | **Ruling 8:** explicit `p_session_id` flows into `app_consume_step_up`. **Do NOT create `app_ctx_session_id()`** (§38.6 line 16697). Body re-checks `K('fees.refunds.approve')` via F13 in-body, then posts event type **`refund.approved`** — never `fee.refund.approved` (§E.1, ruling I.2). |
| **F12** | `postRefundProcess` | **`0028`** | **`postRefundProcess(p_session_id uuid, p_refund_id uuid, p_action text, p_reason text DEFAULT NULL, p_disbursement_reference text DEFAULT NULL) RETURNS void`** | absent | **Ruling 9:** same; requires `p_disbursement_reference` per §35.7. No `app_ctx_session_id()`. Posts event type **`refund.processed`** — never `fee.refund.processed` (§E.1, ruling I.2). |
| **F13** | `app_finance_actor_has_permission` | **`0028`** — **not `0026`** | `(p_permission text) RETURNS boolean` | **broken and present in live `school_saas_dev`**: body references a non-existent `permissions` table, `rp.permission_id`, `m.is_active`; and `school_app_rw` cannot execute it (Probe C) | **Ruling 6:** (a) move out of §19.7.2/§19.7.3/§35.1's `0026` attribution into `0028` (accepted `0026_fin_ledger.sql` does not create it, and its own justification — "0025's `postRefundProcess` calls it" — is false because 0025 does not create F11/F12); (b) **no `EXECUTE` grant to `school_app_rw`**; (c) body derives caller from `app_ctx_user()`, tenant from `app_current_tenant_id()`, permission from active membership → `membership_roles` → `roles` → `role_permissions` — **never `current_user`**; (d) delete the `app_privileged()` short-circuit, which otherwise returns TRUE for every caller for the same reason as F1; (e) drop the dead `permissions`/`permission_id`/`is_active` references. |
| **F14** | `app_finance_emit_event` | **`0028`** (§30.1 row 0026 claims `0026`, but `0026_fin_ledger.sql` does not create it) | `app_finance_emit_event(p_event_type text, p_tenant_id uuid, p_aggregate_type text, p_aggregate_id uuid, p_payload jsonb) RETURNS void` | absent | **Ruling 7:** `0028`-owned; **preserve `session_user`-based privileged distinction** (unlike F1/F13, whose `current_user` is unusable). Its `INSERT INTO outbox_events` is admitted by 0002's live policy, whose third disjunct is `app_privileged()` — so the insert always passes; the real control is F14's own session-tenant guard. §19.4's comment citing "`0001:352-356`" for that policy is **stale** (0002 replaced it). |

**Corrections common to F11/F12/F13/F14 that this register records:**

- §30.1 line 13716's claim that "a definer bypasses the policy" is **false under `FORCE`** and is
  corrected by §B.2.4 (`fin_refunds` `UPDATE … USING (P)`).
- §35.4 line 15378's claim that F11/F12 "bypasses this policy entirely" is corrected the same way.
- §19.7.3 line 10729 grants F13 `EXECUTE` to `school_app_rw`, contradicting its own SQL block comment
  at line 10782 ("No `GRANT` to `school_app_rw`"). Ruling 6 resolves to **no grant**.

### E.1 Ruling I.2 — ledger event-type catalogue: CLOSED, NORMATIVE

**Design rule (added):**

> **Accepted ledger event-type catalogue names are canonical for downstream finance functions
> unless a later migration explicitly extends the catalogue.**

Applied:

- F11 `postRefundApproval` posts **`refund.approved`**.
- F12 `postRefundProcess` posts **`refund.processed`**.
- `fee.refund.approved` / `fee.refund.processed` are **not** used anywhere in `0028`.
- **No duplicate `fee.refund.*` rows** are appended to `fin_ledger_event_types`.
- **`0026_fin_ledger.sql` is not modified** — it is accepted and immutable, it is the source of the
  ratified names (`0026_fin_ledger.sql:138`), and `fin_ledger_event_types` is the posting gate: F4
  validates the requested `p_event_type` against that catalogue and raises
  `55000 … is not in the ledger event catalogue` for an unknown name. F11/F12 therefore consume the
  already-ratified event types rather than the design's §19.7.3 prose spelling.
- Corollary recorded so it is not re-litigated: §19.7.3's 14 occurrences of `fee.refund.approved`
  are **design prose, superseded by this rule**; and §30.1's claim that "0027/0028 append their own
  rows" does not license appending `fee.refund.*` here, because no later migration is extending the
  catalogue for refund events.

---

## F. §38.5 disposition — item by item

| # | §38.5 item | Disposition | Evidence / forward action |
|---|---|---|---|
| 1 | `0025` provenance `SECURITY DEFINER` → `SECURITY INVOKER` | **Already correct in the live database.** No migration needed. | Live `trg_fin_refund_provenance` is `prosecdef = false` (INVOKER), matching the canonical target. §30.1 row 0025 line 16679 records the *source file* as `DEFINER` — that is source/live drift, reconciled by documentation, **not** by editing `0025`. No duplicate migration is created. |
| 2 | `fin_pa_refund_fk` `ON DELETE SET NULL` → `NO ACTION` | **Already correct in the live database.** No migration needed. | Live `fin_pa_refund_fk` has **no `ON DELETE` clause** (defaults to `NO ACTION`), matching the target. Wording reconciled: §38.5 item 2 is a *closed* item whose subject is `0025`'s source text, which remains `DEFINER`/unset-null only as drift. |
| 3 | reversal target must have `effect = 'apply'` | **NOT satisfied — forward remediation required.** | Enforcement today: `0025_refund_provenance_remediation.sql:143` — `IF v_target.effect <> 'apply' THEN RAISE …` after a `FOR UPDATE` lock. **Residual gaps, each verified:** (i) correction reversals (`refund_id IS NULL`) take a branch that does not reach line 143; (ii) `trg_fin_reversal_shape_check` (0024, `SECURITY INVOKER`, signature `(uuid,uuid,uuid,uuid,numeric)`) checks target **existence, same invoice and ceiling only — not `effect`**; (iii) a later `UPDATE` of the target's `effect` column is unguarded. **Action:** a forward-only `CREATE OR REPLACE FUNCTION trg_fin_reversal_shape_check(...)` in `0028`, **preserving `SECURITY INVOKER`** (required by `0025_lock_model_remediation.sql:457`), adding the `effect = 'apply'` test with the same `FOR UPDATE` read as `0025_…_remediation.sql:143`, reached on every branch including `refund_id IS NULL`. No `0024`/`0025` file is edited. |
| 4 | refund `status` restricted to `requested` / `approved` | **Forward transition trigger REQUIRED. Do NOT restrict `status` to only `requested`/`approved` — that restriction is not implemented.** Restated below. | §35.7 authorises **four** states (`requested`, `approved`, `rejected`, `processed`) and seven transitions; F12's lifecycle (`approved → processed`) makes a 2-value restriction a hard failure. The correct invariant is: existing `fin_refunds_status_check` (4 values) **+** `fin_refunds_decision_ck` **+** F11/F12 in-body guards **+** ACL `UPDATE` revoked for `school_app_rw` **+ §B.2.4's `UPDATE … USING (P)`** (without which F11/F12 cannot write at all) **+ a new forward-only `BEFORE UPDATE OF status ON fin_refunds` transition trigger** encoding §35.7's seven rows exactly, including `rejected → any` forbidden, `processed → any` forbidden, `approved → rejected` forbidden. |
| 5 | `schema_migrations` migration checksums | **Separate, unresolved migration-system issue — NOT to be faked inside `0028`.** | Ledger stores `version` + `applied_at` only (`migrate.ts:12-14,23-26`); `version` is the full filename. A checksum model is a change to the migration runner and its own migration, is out of `0028`'s scope, and must not be simulated by any assertion inside `0028`. |
| 6 | F11/F12 `p_session_id` signature change | **In scope for `0028` — resolved by rulings 8 and 9.** | See §E. `app_ctx_session_id()` does not exist and is **not created**. |

**These dispositions are preserved as-is by ruling.** Items 1 and 2 are already correct live (no
migration, no duplicate); items 3 and 4 require forward remediation; item 5 is a separate
migration-system issue not to be faked in `0028`; item 6 is `0028` scope. **Two §38.5 items being
already correct does not open the gate** — §H.

---

## G. Exact forward remediation, in order

All items are forward-only. No file in `0001`–`0027` is edited. No test, schema, API, worker or UI
file is created or modified by *this* report.

**Stage 1 — reconciliation, before any `0028` DDL**

1. **Document-only:** record items 1 and 2 of §F as *already satisfied live*; do not create a
   migration for them.
2. **`schema_migrations` history drift — CLASSIFIED EXTERNAL / PRE-EXISTING, UNTOUCHED (ruling 5).**
   `school_saas_dev` contains rows `0028_fin_runtime_security.sql` and `0029_fin_final.sql` while
   none of their objects exist (`app_consume_step_up`, `auth_step_up_challenges`,
   `fin_document_artifacts`, F11/F12/F13/F14, all `fin_*` policies and grants are absent).
   `migrate.ts` keys on the **full filename** (`applied.has(file)`), so a differently-named new file
   still applies — the rows are inert with respect to `0028`.

   **These rows must NOT be removed, annotated, rewritten or otherwise mutated now.** The project
   verification rule is that `school_saas_dev` remains untouched, and no `0028` work may depend on
   cleaning them. They are classified as **pre-existing historical / quarantined
   migration-history drift and operator cleanup** — an external condition, not part of `0028`'s
   implementation scope.

   **The authoritative reproducibility proof does not use `school_saas_dev` at all.** It uses a fresh
   disposable **`school_saas_test`**: apply `0001 → … → 0027 → 0028`, then run the migration command
   a **second time to prove idempotency** (zero applied, zero skipped-changes). That fresh-run proof
   is the reproducibility evidence §38.7 asks for; the drift rows in `school_saas_dev` are recorded,
   left alone, and explicitly out of scope.
3. **Live drift register to confirm at implementation time:** `fn_fin_refund_ceiling` is
   `prosecdef = false` live while `0025_fin_refunds.sql:182` declares `SECURITY DEFINER` (§35.3 F5
   expects INVOKER → **live matches design, file does not**); `fin_v_invoice_balance` /
   `fin_v_payment_position` are declared `WITH (security_invoker = on)` in `0024:355/404` but the
   live `pg_class.reloptions` must be re-checked (V1/V2 semantics depend on it); `fin_ledger_event_types`
   holds **12** live rows vs **10** accepted in `0026`.

**Stage 2 — remaining `0028` IMPLEMENTATION SCOPE (after the four §I rulings; not implemented now)**

With I.1–I.4 closed, the remaining implementation scope of `0028` is exactly the following — no
more, no less:

4. `CREATE OR REPLACE trg_fin_reversal_shape_check` with **`effect = 'apply'` enforcement on every
   applicable branch** (§F.3), preserving `SECURITY INVOKER`.
5. Forward **refund status transition trigger** implementing the **seven authorized transitions** of
   §35.7 (§F.4). `fin_refunds.status` is **not** restricted to `requested`/`approved`.
6. `CREATE OR REPLACE app_finance_actor_class()` **removing the `current_user`-based privileged
   classification** (the `WHEN app_privileged() THEN 'system'` arm) — F1, ruling 5.
7. **F11** `postRefundApproval` with **explicit `p_session_id`**.
8. **F12** `postRefundProcess` with **explicit `p_session_id`**.
9. **F13** `app_finance_actor_has_permission` with **no `school_app_rw` `EXECUTE` grant**, body
   derived from `app_ctx_user()` / `app_current_tenant_id()` / `role_permissions` (ruling 6).
10. **F14** `app_finance_emit_event` **in `0028`**, `session_user`-based privileged distinction
   preserved.
11. **Complete 25-table RLS/policy set** — §B.1 verbatim, in §30.3's order
   (policies → assertions → grants last), with `K` defined before first use.
12. **Exact grants/revokes** — §D.2 / §D.3 / §D.4, including the `P`-only `fin_receipts` UPDATE
   policy (I.1), the `fin_receipts` INSERT disjunction (I.3), the `fin_ledger_event_types` zero
   runtime privilege (B8), the two view revokes, and `REVOKE ALL … FROM school_app_rw, PUBLIC`
   immediately after every `CREATE TABLE`.
13. **`role_permissions` backfill** — §20.5, `ON CONFLICT DO NOTHING`, `WHERE r.is_system = true AND
    r.tenant_id IS NOT NULL`, plus the `cashier` role and the §20.5 checksum post-condition.
14. **Required assertions** — §19.5 assertions (1) and (3) unchanged; assertion (2) as scoped by
    §C.3(3); §20.5's post-condition.
15. **Security-definer hardening** — `SET search_path = pg_catalog, public, pg_temp`,
    `REVOKE ALL … FROM PUBLIC`, owner `school_migrator`, and no reliance on `current_user` for
    runtime caller identity (F1/F13) while `session_user` is retained where it is the correct
    distinction (F14).

Out of scope for `0028`, recorded so it is not pulled in: `schema_migrations` checksums (§F.5), the
`ROLE_TEMPLATES` code change (§C.4), cleanup of the `school_saas_dev` drift rows (§G Stage 1 item 2),
and all `0029` objects (ruling B7).

**Stage 3 — independent verification (separate deliverable, not this report)**

16. Prove reproducibility on a fresh disposable `school_saas_test`: `0001 → … → 0027 → 0028`, then a
    second migration run proving idempotency (§G Stage 1 item 2).
17. Invert every pre-`0028` posture assertion (§H), then run the full finance suite plus the
    `finance-rls` behavioural suite (FI-014/FI-020/FI-022) as real `school_app_rw` sessions with real
    tickets per actor class.
18. Re-verify that §I.1–I.4 remain closed after implementation, and that `school_saas_dev` is
    byte-for-byte untouched.

---

## H. Corrected §38.7 gate

```text
DESIGN-RECONCILED — INTERNALLY AUTHORIZED FOR IMPLEMENTATION
SUBJECT TO THE EXISTING §38.7 FORWARD-REMEDIATION AND INDEPENDENT-VERIFICATION GATES
```

§38.7's own text is preserved and is **not** upgraded: *"Forward remediation is required before
Phase 7 implementation can proceed… This document is not `DESIGN-GO`, not `DESIGN-READY-FOR-0026`,
and not `DESIGN-READY-FOR-IMPLEMENTATION`, and no `0026` or `0028` work is authorized by it."*

The four §I design conflicts are **CLOSED** (§I, §J), so the *design* is internally consistent and
authorized. The **gates themselves remain closed** until the work they name is done:

1. **Forward remediation (§G Stage 2) is not yet executed.** §38.5 item 3 (`effect = 'apply'`) and
   item 4 (forward transition trigger) are REQUIRED and not implemented; item 5 is a separate
   unresolved migration-system issue; item 6 is `0028` scope. Items 1 and 2 being already correct in
   the live database is an *observation*, not a completion of the sequence.
2. **Independent verification (§G Stage 3) has not run** — neither the fresh
   `school_saas_test` `0001 → … → 0027 → 0028` reproducibility/idempotency proof, nor the
   behavioural `finance-rls` suite.
3. **Existing tests encode the pre-`0028` posture and must be inverted first.** The required
   inversions, enumerated so verification is not surprised by them:

| Test | Assertion today | Must become after `0028` |
|---|---|---|
| `finance-composite-fk.test.ts` D1 | no `fin_*` table has a `school_app_rw` ACL entry; all grants `school_migrator` | exactly the §D.2 shapes per table |
| `finance-composite-fk.test.ts` D2 | no `fin_*` table has RLS or any policy | every `fin_*` table `relrowsecurity AND relforcerowsecurity`; 4-command policy set per §B.1 |
| `finance-refund-remediation.test.ts` F2 | `SELECT`/`INSERT` refused on `fin_refunds`, `fin_payment_allocations` for `school_app_rw` | `SELECT`/`INSERT` **succeed** under a finance-staff ticket and the right `K`; refused without it |
| `finance-refund-remediation.test.ts` F4 | no RLS/policies on `fin_refunds` | RLS forced + policies present |
| `finance-refund-remediation.test.ts` F5 | `postRefundApproval` / `postRefundProcess` / `app_ctx_session_id` all absent | F11/F12 **present** with the §E signatures; **`app_ctx_session_id` still absent** |
| `finance-payments.test.ts` T3 | ACL + RLS deferred | granted per §D.2 |
| `finance-payments.test.ts` 2147 / 2151 | `migReject(UPDATE/DELETE fin_receipts, '55000')` as migrator | **must still raise `55000`** — this is the test that forces §B.2.5's `UPDATE … USING (P)` policy and would fail silently without it |
| `finance-payments.test.ts` 1103 | `migReject(DELETE fin_payment_allocations, 'append-only')` | **must still raise** — forces §B.1's `DELETE … USING (P)` |
| `finance-trigger-inventory.test.ts` (all `migReject`) | published-structure delete, billing-run delete, challan snapshot update, etc. all raise as migrator | **must still raise** — every one of them is a Probe-A casualty if its policy is omitted |
| `finance-020` / `finance-rbac` | §20.5's suite (`finance-rbac` **is not implemented**) | must exist and pass |

**Required sequence (unchanged, now enumerated):** design reconciliation (this report) → forward
remediation (§G stages 1–2) → independent verification (§G stage 3, §H inversions) → `0028`
implementation.

---

## I. STOP register — rulings applied, all four blockers CLOSED

Ruling 14 required stopping where a policy, permission, state transition, provenance rule, grant or
object ownership remained ambiguous. Four such items were raised; **all four are now resolved by
ruling and closed.** Each closure is reflected in the normative text above (§B, §D, §E, §G), not
only here.

### I.1 — `fin_receipts` UPDATE policy — **CLOSED**

**Resolved: use the `P`-only UPDATE RLS policy.**

The normative policy is exactly:

```sql
CREATE POLICY fin_receipts_update ON fin_receipts FOR UPDATE
    USING (app_privileged());
```

**Reason (all three conditions bind):**

1. `FORCE ROW LEVEL SECURITY` plus **no** UPDATE policy causes the owner's `UPDATE` to affect **zero
   rows** and **prevents `trg_fin_receipt_freeze` from executing at all** (Probe A).
2. `finance-payments.test.ts:2147` intentionally expects the migrator `UPDATE` to reach the freeze
   trigger and raise `55000`.
3. `school_app_rw` has **no `UPDATE` ACL** on `fin_receipts` (§D.2 Shape 3), so runtime is refused at
   the statement layer regardless.

**Layering (normative):**

| Layer | Mechanism | Effect |
|---|---|---|
| Statement | ACL — no `UPDATE` for `school_app_rw` | runtime `UPDATE` → `42501` |
| RLS | `USING (app_privileged())` | only privileged/system context may reach `UPDATE` |
| Trigger | `trg_fin_receipt_freeze` | **enforces actual immutability; raises `55000`** |

**Do NOT weaken this to a silent zero-row no-op.** A silent no-op is a failure mode, not a control:
it satisfies no test and enforces nothing.

**Wording of §19.2 line 8887 and §19.4 line 9041 reconciled:** "immutable" means **no `UPDATE`
ever succeeds**. It does *not* mean "no UPDATE policy exists". §19.4's "deliberately no UPDATE and no
DELETE policy" is superseded for `UPDATE` and retained for `DELETE`: the `P`-only UPDATE policy is
what routes every attempt to the guard that refuses it, and the omitted `DELETE` policy (owner
included) is what refuses deletion outright. Full statement in §B.2.5.

### I.2 — refund event-type names — **CLOSED**

**Resolved: use the immutable `0026` catalogue names.**

- F11 `postRefundApproval` posts **`refund.approved`**.
- F12 `postRefundProcess` posts **`refund.processed`**.
- `fee.refund.approved` and `fee.refund.processed` are **not used**.
- **No duplicate `fee.refund.*` catalogue rows** are added.
- **`0026_fin_ledger.sql` is not modified.**

**Rationale:** `0026` is accepted and immutable; `fin_ledger_event_types` is the posting gate; F4
validates the requested event type against that catalogue. F11/F12 must therefore consume the
already-ratified event types.

**Design rule added (§E.1):**

> **Accepted ledger event-type catalogue names are canonical for downstream finance functions
> unless a later migration explicitly extends the catalogue.**

### I.3 — `fin_receipts` INSERT authorization — **CLOSED**

**Resolved:**

```sql
WITH CHECK (
    app_privileged()
    OR ( app_ctx_scope() = 'tenant'
         AND app_current_tenant_id() = fin_receipts.tenant_id
         AND app_finance_actor_class() = 'finance_staff'
         AND ( app_finance_permission_held('fees.receipts.reissue')
               OR app_finance_permission_held('fees.payments.collect') ) )
)
```

i.e. `K('fees.receipts.reissue') OR K('fees.payments.collect')` with the normal tenant and
actor-class predicates.

- `fees.receipts.reissue` = the explicit receipt reissue route (§35.5 line 15574).
- `fees.payments.collect` = the payment-issued receipt route (§19.2 line 8893).
- **No other permission is invented.**

The absence of an existing API/migration `INSERT INTO fin_receipts` producer is **not** a reason to
change the policy: it means the application producer is not yet implemented. **This policy is
authoritative for the future payment/receipt producer**, which must be written to satisfy it.
Recorded in §B.1.

### I.4 — `post_fin_ledger_group` arity — **CLOSED**

**Resolved: the only valid grant/revoke signature is the actual immutable `0026` five-argument
function.**

```sql
GRANT EXECUTE ON FUNCTION post_fin_ledger_group(uuid, text, uuid, jsonb, uuid) TO school_app_rw;
-- and the matching REVOKE from PUBLIC
```

- The **4-argument** signature `post_fin_ledger_group(uuid, text, uuid, jsonb)` is **not referenced**
  anywhere in `0028` documentation, grants or revokes.
- **No 4-argument overload is created.**
- **`0026` is not modified.**

§30.3.2 step 9's 4-argument text is design prose, superseded by this ruling; a grant against a
non-existent overload would raise `42883` and abort the file. All `0028` grant/revoke documentation
in §D.4 uses the five-argument signature.

### I.5 — `school_saas_dev` migration-history drift — **CLASSIFIED EXTERNAL, UNTOUCHED**

The rows `0028_fin_runtime_security.sql` and `0029_fin_final.sql` in `school_saas_dev`'s
`schema_migrations` are classified as **pre-existing historical / quarantined migration-history
drift and operator cleanup**.

- They are **not** removed, annotated, rewritten or otherwise mutated.
- Their cleanup is **not** part of `0028` implementation.
- The project verification rule holds: **`school_saas_dev` remains untouched.**
- The authoritative reproducibility proof uses a fresh disposable **`school_saas_test`**:
  `0001 → … → 0027 → 0028`, followed by a second migration run proving **idempotency**.

See §G Stage 1 item 2.

### Resolved non-blocking corrections (recorded so nothing is lost)

- §19.5 assertion (2) → scoped per §C.3(3).
- §30.1 line 13716 / §35.4 line 15378 "a definer bypasses the policy" → corrected per §B.2.4.
- §19.7.3 line 10729 F13 `GRANT EXECUTE … TO school_app_rw` → removed per ruling 6 (its own block
  comment at line 10782 already says no grant).
- F13/F14's `0026` attribution (§30.1 row 0026, §35.1, §19.7.2) → moved to `0028` per §E.
- §19.2's 21/25 and §35.4's 24/25 coverage → repaired by §A.
- §19.2 line 8899's "RLS classifies by role code" → superseded by §C.3(1).
- §19.7.3's `fee.refund.*` prose spelling → superseded by §E.1.
- §30.1's "0027/0028 append their own rows" → does not license appending `fee.refund.*` (§E.1).
- `ROLE_TEMPLATES` has no `fees.*` and no `cashier` → code-side change outside `0028` (§C.4).
- §20.4's `fees.receipts.reissue` = `DENY` for `cashier`, while `C` admits `cashier` on
  `fin_receipts` — the `K('fees.receipts.reissue')` conjunct enforces §20.1's P1-03; a positive
  cross-check, not a conflict.
- `fn_fin_refund_ceiling` source `DEFINER` vs live `INVOKER` → forward `CREATE OR REPLACE` in
  `0028`, target INVOKER (matches live and §35.3 F5). Decided.
- Live view `security_invoker` flags vs `0024:355/404` → read `pg_class.reloptions` during
  implementation; if drifted, forward `CREATE OR REPLACE VIEW` in `0028`. **Verification task, not a
  design ambiguity** — the intended semantics (V1 invoker, V2 owner) are fixed by §15.2.1.

**No placeholder policy name, predicate, permission or actor class appears anywhere in §B.** Every
`P`-only, class-only, `K`-carrying and omitted cell is derived in §B.2 from a named source line, a
named trigger, a named test, or a ruling.

---

## J. Final stop condition

**Closing status of the four blockers:**

| | Item | Status |
|---|---|---|
| I.1 | `fin_receipts` UPDATE — `USING (app_privileged())`, trigger-enforced immutability, no silent no-op | **CLOSED** |
| I.2 | refund event types — `refund.approved` / `refund.processed`; `0026` canonical, unmodified | **CLOSED** |
| I.3 | `fin_receipts` INSERT — `K('fees.receipts.reissue') OR K('fees.payments.collect')`; policy authoritative for the future producer | **CLOSED** |
| I.4 | `post_fin_ledger_group(uuid, text, uuid, jsonb, uuid)` — five arguments only | **CLOSED** |
| I.5 | `school_saas_dev` history drift — classified external/pre-existing, **untouched** | **CLASSIFIED** |

**Remaining implementation scope:** the twelve items of §G Stage 2 —
`trg_fin_reversal_shape_check` with `effect = 'apply'` on every applicable branch; the forward refund
status transition trigger implementing the seven authorized transitions; `CREATE OR REPLACE
app_finance_actor_class()` removing `current_user`-based privileged classification; F11 with explicit
`p_session_id`; F12 with explicit `p_session_id`; F13 with no `school_app_rw` `EXECUTE` grant; F14 in
`0028`; the complete 25-table RLS/policy set; exact grants/revokes; `role_permissions` backfill;
required assertions; and security-definer hardening.

**Does any other ambiguity remain?** **No.** Every policy predicate, permission, state transition,
provenance rule, grant and object-ownership question raised by this reconciliation is decided and
written into normative text (§B, §D, §E, §F, §G). The only outstanding items are (a) the §38.7
forward-remediation work itself, (b) the independent-verification work, and (c) two
implementation-time read-backs that have fixed expected values — `pg_class.reloptions` on the two
0024 views, and the live `fin_ledger_event_types` row count (12 vs 10). None of these is an
unresolved design contradiction.

```text
0028 DESIGN IS NOW INTERNALLY AUTHORIZED FOR IMPLEMENTATION, SUBJECT TO THE EXISTING §38.7 FORWARD-REMEDIATION AND INDEPENDENT-VERIFICATION GATES.
```

**No migration is written by this report.** `0001`–`0027`, `schema.ts`, tests, API, worker, UI and
`school_saas_dev` are all untouched.