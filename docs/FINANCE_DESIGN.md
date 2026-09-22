# Finance Design (School → Guardians)

Status: Phase 0 | Related: DATABASE_DESIGN.md §9, API_DESIGN.md, EVENT_ARCHITECTURE.md

## 1. Integrity stance

Finance is **append-only with controlled state machines**. Historical financial facts never silently change. Corrections are new records that reference the old ones. Everything money-related is audited and idempotent.

## 2. Document lifecycle

```text
fee_structures (versioned templates)
   └── fee_assignments (per student/year)
          └── invoices (draft) ──issue──► invoices (issued) ──payments──► partially_paid/paid
                     │                        │
                   void (reason+perm)      refund/adjustment
```

- **Draft invoices**: editable/ deletable by `fees.invoices.create`.
- **Issue** (`POST /invoices/:id/issue`): freezes line items (trigger blocks UPDATE on `invoice_items` when header issued), assigns `invoice_no`, emits `invoice.issued`. Issue is idempotent (re-issue with same key → same number).
- **Void** (`fees.invoices.void`): only if no settled payments (or after refunds); sets status `void`, keeps row forever; reason required; audit `fee.invoice.voided`.
- No hard DELETE on issued/paid invoices (RESTRICT + immutability trigger).

## 3. Payments

- `POST /payments` with **required `Idempotency-Key`** → unique (`tenant_id`, `idempotency_key`) guarantees single record per logical attempt.
- Server computes nothing client-side: amount, currency, allocation validated server-side against outstanding balance.
- **Single transaction boundary** for payment recording:
  1. Insert `payments` (status pending or settled).
  2. Insert `payment_allocations`.
  3. Update invoice aggregates (`amount_paid`, status) — *controlled exception to immutability: invoice money columns are derived counters, recomputable from allocations; recomputation job verifies nightly.*
  4. Insert `receipts` if settled (receipt_no from sequence with `SELECT … FOR UPDATE` on tenant counter row — no gaps under concurrency except on rollback (documented acceptable: numbers may skip, never duplicate)).
  5. Insert `ledger_entries` balanced group (cash / receivable).
  6. Audit `fee.payment.recorded` + outbox `payment.received`.
- Gateway flows: create payment `pending` → redirect → **webhook endpoint**: verify signature → upsert by (`provider`,`external_id`) unique → enqueue `payment.confirm` job → same tx steps as above guarded by status transition (`pending→settled` only once; second webhook no-ops).
- Cash/manual entry: permission `fees.payments.collect`, step-up MFA (AUTHORIZATION §7).

## 4. Refunds

- `POST /refunds` (idempotent): validates `amount ≤ payments.amount − refunded_for_payment` (DB trigger + app check), status machine `requested → approved → processed` (config: approval optional if under threshold).
- Processing: compensating `payments`-side rows are NOT edited; `refunds` row + `ledger_entries` reversing group + invoice aggregates decrease + `fee.refund.created` audit/outbox.
- Provider refunds call adapter async (job) with own idempotency key = refund_no.

## 5. Receipts

- Immutable, sequential `receipt_no`, links `payment_id`, printable PDF render from snapshot fields (store rendered snapshot jsonb so later cosmetic changes don't alter historical receipt content).
- Reprint = re-render or fetch same file; never edit.

## 6. Ledger (double-entry)

- Every money event writes a balanced `entry_group` (sum(debit)=sum(chart of credit) verified by `BEFORE INSERT` trigger per group + app code).
- Standard accounts seeded per tenant: `1000 Cash`, `1100 Bank`, `1200 Accounts Receivable`, `4000 Tuition Income`, `4100 Transport Income`, `2200 Refund Liability`, `5000 Fines Income`, etc.
- `REVOKE UPDATE, DELETE ON fin_ledger_entries FROM app_rw` — corrections = new groups (`reversal_of_group uuid`).
- Reports (outstanding balances, income) read derived views; nightly `fin_recompute` job compares derived counters vs ledger and alerts on drift.

## 7. Idempotency matrix

| Operation | Mechanism |
|---|---|
| Create payment | Idempotency-Key header + DB unique |
| Gateway webhook | (provider, external_id) unique + status state machine |
| Issue invoice / number seq | status guard + row lock |
| Refund | Idempotency-Key + refund_no unique |
| Payroll posting | run status `draft→posted` once |
| Invoice batch generation | unique (tenant, student, year, invoice_no) natural key |

## 8. Discounts / scholarships / fines

- Represented as `invoice_adjustments` rows (signed amounts) at issue time or later with approval permission (`fees.adjustments.approve` for manual post-issue); never by silently editing `invoice_items` after issue.
- Scholarship templates reusable (`fee_adjustment_templates`).

## 9. Outstanding balances & aging

- Balance per student = Σ issued invoices total − Σ allocations (+ unallocated on-account payments).
- Materialized nightly + on-demand query with index `(tenant_id, student_id) WHERE status IN ('issued','partially_paid')`.
- Aging buckets computed from `issued_at` — read-only report.

## 10. Transaction boundaries (summary)

- One DB transaction per business operation (payment record, refund process, invoice issue). Never span external HTTP calls inside DB tx — gateway calls happen before/after via jobs; state reconciled by webhooks.
- Ledger group + audit + outbox always same tx as the money rows.

## 11. Reconciliation

- Daily job: provider settlements vs internal `payments` (external reference) → mismatch report to platform/finance admin.
- Nightly: derived invoice counters vs allocations; ledger balance check; unallocated payments report.

## 12. Non-goals (Phase 7 boundary)

- Multi-currency auto-FX (single currency per school; `currency` stored for future).
- Full GL module (beyond needed accounts) — extensible account table allows growth.
- Direct coupling to subscription billing provider (separate interfaces).
