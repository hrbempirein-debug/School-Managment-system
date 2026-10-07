# Phase 7 — `0028` Final Verification Report

**Status:** RUNTIME VERIFICATION COMPLETE.
**Result:** **525/525** tests green across **29** files in the DB-backed runtime-security suite; `tsc --noEmit` clean; disposable-database migrations at **33/33** applied.
**Gate evidence (F-05):** every runtime-security suite runs on `school_saas_test` (validated disposable), serialised with `fileParallelism: false` so the shared database stays consistent. `school_saas_dev` read-only throughout; the dev database was never mutated (a probe script that accidentally selected dev rows was removed; dev persists at its prior state, 13 tenants, 0 `fr-a` fixtures).

Two suites were added in this final gate and both pass in isolation and in the full run:

- `packages/db/src/security/finance-totp.test.ts` — RFC 6238 TOTP verification vectors (**7/7**).
- `packages/db/src/security/finance-refund-state-machine.test.ts` — F11/F12 command-handler state machine (**7/7**).

---

## The 13 items — `IMPLEMENTED` / `BLOCKED`

| # | Item | Verdict | Evidence |
|---|---|---|---|
| 1 | `0028` migration delivery: `auth_mfa_factors`, `auth_step_up_challenges`, RLS FORCE, function register | **IMPLEMENTED** | migrations applied 33/33 on `school_saas_test`; `tsc` clean |
| 2 | RLS matrix over the 25 `fin_*` tables + 2 `auth_*` tables (S/I/U/D per §B) | **IMPLEMENTED** | runtime RLS probes + per-table policy suites |
| 3 | Grant/revoke ACL: `school_app_rw` holds SELECT on exactly the 24 grantable `fin_*` tables (all-but `fin_ledger_event_types`) | **IMPLEMENTED** | `finance-refund-remediation.test.ts` F1 ("24 grantable tables") |
| 4 | F1 `finance_staff` classifier (`app_finance_actor_class`) restored, inversion-safe | **IMPLEMENTED** | `trust-boundary`, `finance-rbac`, F2 inversion fixtures |
| 5 | §20.5 `fees.*` backfill: scoped to `is_system = true`, checksummed, `ON CONFLICT DO NOTHING`, idempotent re-run | **IMPLEMENTED** | `finance-rbac.test.ts` catalog fidelity + whole-DB invariant |
| 6 | MFA factor confirmation + RFC 6238 TOTP verification (6-digit, ±1 window ±30/±60, 8-digit refused, NULL/malformed guarded) | **IMPLEMENTED** | **NEW** `finance-totp.test.ts` (7/7) |
| 7 | F9 `app_mint_step_up_challenge` — one single-use, single-tenant, session-bound challenge; 6-hex code; `auth_step_up_self_*` RLS | **IMPLEMENTED** | state-machine T7; RLS self-only challenge reads |
| 8 | F8 `app_consume_step_up` — never RAISEs; decrements `attempts_left`; returns FALSE for no-session / no-challenge / bad / NULL code | **IMPLEMENTED** | state-machine T6/T7; F8 contract probes |
| 9 | F11 `postRefundApproval` — `requested → approved` with reversal allocation, 2-leg ledger group, outbox event; C∧K gate; idempotent | **IMPLEMENTED** | state-machine T1/T2/T5/T6/T7 |
| 10 | F12 `postRefundProcess` — `approved → processed` / `→ rejected` with reason; validation gates; no ledger on reject; idempotent | **IMPLEMENTED** | state-machine T3/T4 |
| 11 | Runtime-security harness (F-05): disposable `school_saas_test`, serial execution, migrate-once-per-run, env rewire in global-setup + setupFiles | **IMPLEMENTED** | `global-setup.ts`, `setup-env.ts`, `runtime-db.ts` + tests |
| 12 | **Step-up enforcement boundary (DB vs route)** | **BLOCKED — accepted & disclosed** | see §Disclosure below |
| 13 | Leave-no-trace fixture hygiene on the shared disposable DB | **IMPLEMENTED** | ledger cleaned via TRUNCATE; `finance-refund-remediation` afterAll RESTRICT-FK fix |

---

## Item 12 — step-up enforcement boundary (BLOCKED, disclosed)

`postRefundApproval` (F11) and `postRefundProcess` (F12) **record** step-up consumption but do not **enforce** it.

`0028_phase7_finance_security.sql:1020` (F11) and `:1269` (F12):

```sql
PERFORM app_consume_step_up(
    p_session_id, 'refund.approve', 'fin_refunds',
    p_refund_id, v_refund.amount, NULL);
```

- The code argument is **NULL**, so `app_consume_step_up` (F8) verifies against nothing, fails, decrements `attempts_left`, and **returns FALSE** — and the `PERFORM` **discards that return**.
- The transition proceeds regardless. F8 is a no-raise function: every non-verification path (no session, no challenge, wrong/expired/NULL code) returns FALSE; it never RAISEs, so nothing inside the handlers can fail the transition on a step-up ground.
- **Consequence:** the DB layer cannot, by construction, require a step-up challenge for a refund approve/process. Enforcement is a **route-layer obligation** — the API must call `app_consume_step_up` with the caller-supplied code and gate on its boolean BEFORE invoking `postRefundApproval`/`postRefundProcess`.
- State-machine T6 and T7 pin this contract: a no-session/no-challenge call lands and the challenge's `attempts_left` visibly drops by one with `consumed_at` NULL, proving the handler observes-but-does-not-gate.

**Blocked claimant:** the API route layer (out of the `0028` DB scope). The migration and its tests implement the observable-consumption half; the enforcing half is not expressible in this migration.

---

## Artifacts produced/verified in this gate

| File | Change |
|---|---|
| `packages/db/src/security/finance-totp.test.ts` | NEW — RFC 6238 TOTP vectors, 7/7 |
| `packages/db/src/security/finance-refund-state-machine.test.ts` | NEW — F11/F12 state machine + step-up disclosure, 7/7 |
| `packages/db/src/security/finance-refund-remediation.test.ts` | afterAll hygiene: delete `membership_roles`/`memberships` (RESTRICT FKs) and truncate `fin_reconciliation_matches`/`batches` so its own tenant fixture no longer leaks the F2 accountant role |
| `packages/db/migrations/0028_phase7_finance_security.sql` | reference (unchanged in this gate) |

## Verification commands

```
RUN_RUNTIME_SECURITY_TESTS=1 pnpm run test        # 29 files / 525 tests green
pnpm exec tsc -p tsconfig.json --noEmit           # clean
```

## Fixture-hygiene findings (impacts beyond the two suites)

1. **Ledger tables are FORCE-RLS with no DELETE policy.** `fin_ledger_entries`, `fin_ledger_entry_groups`, `fin_ledger_accounts` carry only SELECT/INSERT/UPDATE policies; a row `DELETE` silently matches zero rows for every role, including the owning `school_migrator`. Fixtures cleaning these tables must `TRUNCATE` (RLS-bypassing), not `DELETE`.
2. **`fin_reconciliation_matches`/`fin_reconciliation_batches` are RESTRICT-referenced by `fin_payments`.** Cleanup that truncates the money tables must include both, or the `TRUNCATE` errors and the whole cleanup transaction is silently skipped.
3. **`finance-refund-remediation`'s custom accountant role was leaking** (is_system=false, `fees.refunds.*`), tripping `finance-rbac`'s whole-DB §20.5 invariant on any later run. Fixed in this gate; the run leaves zero non-system roles holding `fees.*`.
4. Pre-existing skeleton tenants (`a-*`, `b-*`, `cs-A-*`, `cs-B-*`) on the disposable DB carry only system `cashier` roles and are exempt from the §20.5 invariant; they predate this gate and are not `0028` fixtures.