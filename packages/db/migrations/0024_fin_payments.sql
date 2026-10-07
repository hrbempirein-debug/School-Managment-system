-- =============================================================================
-- 0024_fin_payments.sql
--
-- WHAT
-- Phase 7 (Fees & Finance) migration 4 of 9. The money-in side: payments, the
-- single signed allocation table that IS the reversal mechanism, and receipts.
--
--   fin_payments, fin_payment_allocations, fin_receipts
--   fin_v_payment_position                 - effect/refund-partitioned payment
--                                            position (V1, security_invoker)
--   fin_v_invoice_balance                  - the AUTHORITATIVE invoice balance,
--                                            recomputed from rows and never from
--                                            the cache (V1, security_invoker)
--
--   BOUND trigger functions, ELEVEN, over THIRTEEN statements (§35.3.2's
--   per-migration column -- not three over five, which was the moved subset
--   alone):
--     row 5   trg_fin_invoice_void              1 binding  INVOKER
--     row 8   trg_fin_challan_status            1 binding  INVOKER
--     row 8a  trg_fin_challan_refresh           1 binding  DEFINER
--     row 10  trg_fin_reversal_shape            1 binding  INVOKER
--     row 10a trg_fin_pa_delete_guard           1 binding  INVOKER
--     row 11  trg_fin_allocation_family_guard   1 binding  INVOKER
--     row 12  trg_fin_allocation_bounds         1 binding  INVOKER
--     row 12a trg_fin_allocation_target_state   1 binding  INVOKER
--     row 13  trg_fin_invoice_balance_recompute 3 bindings DEFINER
--     row 14  trg_fin_on_account_return_bounds  1 binding  INVOKER
--     row 16  trg_fin_receipt_freeze            1 binding  INVOKER
--   plus TWO unbound helpers, which are functions without a statement and so
--   appear in no column of §35.3.2's table:
--     fin_invoice_reapply_derived_state(uuid,uuid)   - the arithmetic AND the
--                                                      status decision (C-9.2)
--     trg_fin_reversal_shape_check(uuid,uuid,uuid,uuid,numeric)
--   2 partial unique indexes.
--
-- WHY NO EXISTING MIGRATION IS EDITED
-- 0021, 0022 and 0023 are applied, audited and immutable. Two design decisions
-- that were previously written into 0023 are implemented here instead, by moving
-- the objects rather than by rewriting an applied file:
--
--   * trg_fin_invoice_void, trg_fin_challan_status and
--     trg_fin_invoice_balance_recompute each name a relation THIS file creates
--     -- fin_payment_allocations and fin_v_invoice_balance respectively. §30.3.1's
--     strict form forbids a migration from naming, in a body OR in a DECLARE row
--     type, a table a LATER migration creates. They were in 0023 in the previous
--     revision and each would have raised 42P01 on first use. Row 13's THREE
--     bindings are here for the same reason, not two in 0023 plus one here.
--   * fin_billing_run_items -> fin_invoices (fin_bri_invoice_fk) was adjudicated
--     to 0023 and is the last statement of that file; §35.2, §9.5 and §8.7's
--     column comment all agree, and nothing here re-owns it.
--
-- THE ONE UNCONSTRAINED COLUMN IN THE PHASE, AND WHY IT IS SAFE HERE
-- fin_payment_allocations.refund_id is created as a PLAIN NULLABLE COLUMN with
-- no foreign key. fin_refunds does not exist yet, and PostgreSQL resolves a
-- referenced relation at ALTER TABLE time, so declaring fin_pa_refund_fk here
-- would fail 42P01 and -- because the runner wraps each file in its own
-- transaction -- would hard-stop every migration after this one. 0025 creates
-- fin_refunds and then adds the constraint by ALTER (§30.1's two-step).
--
-- This is the ONLY window in the sequence in which a fin_* column that
-- references another fin_* table is unconstrained. It contains no application
-- code, the runtime role holds no privilege on the table at all (see PRIVILEGE
-- POSTURE), and it closes in the very next migration.
--
-- CONSEQUENCE FOR THIS FILE: no trigger or function below may name fin_refunds,
-- in its body OR in a DECLARE row type. trg_fin_refund_provenance is therefore
-- created and bound ENTIRELY in 0025, not here.
--
-- THE TWO SUBSTANTIVE CORRECTIONS THIS MIGRATION MAKES
--
-- 1. fin_challans.status HAD NO WRITER AFTER INSERT (P0-07, §10.2.1).
--    trg_fin_challan_status is BEFORE INSERT OR UPDATE ON fin_challans, so it
--    fires when a CHALLAN row is written and at no other time, and before the fix
--    this document contained no UPDATE fin_challans anywhere: a challan froze at
--    whatever its balance was on the day it was issued. A printed bank-deposit
--    slip kept asserting a payable amount against a cancelled debt. The fix is
--    ONE binding -- fin_invoices_challan_refresh, AFTER UPDATE OF status on
--    fin_invoices -- which re-derives every challan of the invoice whose status
--    moved, for ANY writer of that column, and derives nothing itself: there is
--    still exactly one derivation of the five-state rule.
--
-- 2. A CORRECTION REVERSAL COULD NOT BE INSERTED AT ALL (§12.1, FI-004).
--    trg_fin_reversal_shape is a BEFORE trigger, so the row it validates does
--    not exist yet; the previous revision's helper took (tenant, id) and looked
--    the reversal row up by id, found nothing, and refused EVERY correction
--    reversal with "reversal % does not exist in tenant %". The helper takes the
--    candidate's FIELDS -- tenant, its own id, its target, its invoice and its
--    amount -- so it never reads a row that has not been written. The same
--    helper is re-run at COMMIT by 0025's fn_fin_refund_ceiling, which is why it
--    is a RETURNS void function with one copy of the arithmetic rather than a
--    second copy inside the deferred trigger.
--
-- PRIVILEGE POSTURE
-- Each table is REVOKE ALL ... FROM school_app_rw immediately after its CREATE
-- TABLE, cancelling the 0001 default-privilege grant -- which would otherwise
-- hand the runtime role DELETE at CREATE TABLE time. Every function is REVOKE
-- ALL ... FROM PUBLIC. These three tables are UNREACHABLE until 0028: no RLS, no
-- policy, no grant. §35.4's column-level grant lists are 0028's, not this
-- file's; until then the trigger layer is the whole boundary and this
-- migration's own tests are what prove it.
-- =============================================================================


-- ---------------------------------------------------------------------------
-- §11.1. fin_payments -- append-only cash in, with a NAMED payer.
--
-- The payer column is what makes family ownership a checkable fact rather than
-- an inference from whichever invoice happened to be paid. Without it "does this
-- payment belong to the same family as the invoice it pays?" has no
-- authoritative answer, and a cashier could apply one family's cash to another
-- family's invoice with every FK individually satisfied. With it,
-- trg_fin_allocation_family_guard (§12.5) can state the rule precisely: every
-- invoice named by an allocation of this payment must have at least one student
-- enrolled under this payer through a LIVE student_guardians row.
--
-- There is deliberately no reverses_payment_id and no status = 'reversed'.
-- Reversal is a row in fin_payment_allocations and nothing else; a compensating
-- payment row would give the system two ways to say the same fact and two places
-- for them to disagree. "Is this payment fully reversed?" is DERIVED in
-- fin_v_payment_position, with no column and no trigger and therefore no drift.
-- The only mutation after creation is the lifecycle transition pending ->
-- settled/failed, guarded by WHERE status = 'pending' so an out-of-order
-- provider delivery cannot settle a failed payment.
-- ---------------------------------------------------------------------------
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

-- ---------------------------------------------------------------------------
-- §12.1. fin_payment_allocations -- ONE signed table, and it is the whole of
-- the reversal mechanism.
--
-- The naive design -- an allocations table plus a reversals table plus a
-- refund_allocations table -- represents "money applied to an invoice" three
-- times and guarantees drift. Here there is one append-only signed table and the
-- three kinds of row are kept DISTINCT BY `effect` AND `refund_id`, NEVER BY
-- AMOUNT SIGN:
--
--   effect             invoice_id   amount   reversal_of   refund_id
--   apply              NOT NULL      > 0      NULL          NULL
--   apply              NULL          > 0      NULL          NULL   on-account credit
--   reverse            = target's    < 0      NOT NULL      NULL    correction reversal
--   reverse            = target's    < 0      NOT NULL      NOT NULL refund reversal
--   on_account_return  NULL          < 0      NULL          NULL    cash handed back
--
-- Naming the third negative effect is what makes payment_unallocated a
-- non-negative quantity: both negative rows are excluded from that formula by
-- `effect`, so a full return of a fully-unallocated payment cannot produce a
-- negative on-account balance.
--
-- fin_pa_effect_ck is declared EXACTLY ONCE and covers all three effects. The
-- previous revision declared it twice with identical bodies: the second could
-- never be violated, and a duplicated constraint name in one table is rejected
-- with 42710, so the DDL as written could not apply.
-- ---------------------------------------------------------------------------
CREATE TABLE fin_payment_allocations (
    id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id                uuid NOT NULL,
    payment_id               uuid NOT NULL,
    invoice_id               uuid,      -- NULL = an on-account movement
    amount                   numeric(19,4) NOT NULL CHECK (amount <> 0),
    effect                   text NOT NULL
                             CHECK (effect IN ('apply','reverse','on_account_return')),
    reversal_of_allocation_id uuid,
    -- Plain nullable column with NO foreign key for the duration of this file.
    -- fin_refunds is created by 0025, which then adds fin_pa_refund_fk by ALTER.
    -- A forward reference here would fail 42P01 at this file's own transaction
    -- and stop every migration after it. §30.1, §30.2, P0-01.
    refund_id                uuid,
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
             -- a return is money LEAVING an on-account balance, so it is
             -- negative, names no invoice, reverses nothing, and is not a refund
             AND amount < 0
             AND invoice_id IS NULL
             AND reversal_of_allocation_id IS NULL
             AND refund_id IS NULL)
    ),
    CONSTRAINT fin_pa_ten_id_uq UNIQUE (tenant_id, id)
);
-- Revoke the 0001 default-privilege grant immediately (§35.4, §30.3).
REVOKE ALL ON fin_payment_allocations FROM school_app_rw;

-- ---------------------------------------------------------------------------
-- §12.1. The two partial unique indexes that make reversal multiplicity
-- explicit and BOUNDED. Both are TENANT-PREFIXED so §6.3 R2 has no exceptions
-- and finance-composite-fk.test.ts can assert one shape.
--
-- COALESCE is deliberately avoided: the two predicates express the distinction
-- between a correction reversal and a refund reversal more readably than a
-- coalesced key would. Because both flavours draw on the SAME per-allocation
-- ceiling in trg_fin_reversal_shape_check, the two indexes are mutually
-- constraining and that helper is the authority that arbitrates between them.
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX fin_pa_one_correction_uq
    ON fin_payment_allocations (tenant_id, reversal_of_allocation_id)
    WHERE reversal_of_allocation_id IS NOT NULL AND refund_id IS NULL;

CREATE UNIQUE INDEX fin_pa_one_reversal_per_refund_uq
    ON fin_payment_allocations (tenant_id, reversal_of_allocation_id, refund_id)
    WHERE reversal_of_allocation_id IS NOT NULL AND refund_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- §25.5. fin_receipts -- issued once, immutable for life, provable against its
-- payment.
--
-- NO status COLUMN AND NO VOID. The brief's own source contradicted itself by
-- calling a receipt immutable AND giving it status = issued | void, and both
-- cannot hold. What would be voided is the INTERPRETATION, not the fact: "we
-- took 50,000 from you on 3 March" did not become untrue because an allocation
-- was a data-entry error. A correction is a NEW receipt with version = 2 and
-- supersedes_id set, and both versions stay retrievable and printable forever.
--
-- payer_guardian_id is DENORMALISED from the payment on purpose: RLS on a
-- portal document must be decidable from the row itself. A policy that had to
-- walk payment -> student_guardians -> student -> back to the payer on every
-- read is slow, and worse, its correctness would depend on a soft-delete column
-- the reader cannot see. Copying the payer at issue makes family ownership a
-- column comparison.
--
-- There is no receipt number trigger here: receipt_no comes from
-- fin_document_counters in the same transaction as the payment, which is 0028's
-- F5 seam rather than this file's.
-- ---------------------------------------------------------------------------
CREATE TABLE fin_receipts (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id        uuid NOT NULL,
    receipt_no       text NOT NULL,
    payment_id       uuid NOT NULL,
    payer_guardian_id uuid NOT NULL,
    -- the FAMILY-ATTRIBUTABLE portion of the payment, frozen at issue. amount =
    -- p.amount is WRONG whenever a payment settles two families' invoices -- a
    -- case this design forbids twice over (trg_fin_allocation_family_guard and
    -- §35.9) -- so today amount == p.amount, and trg_fin_receipt_freeze below
    -- makes that equality a DATABASE GUARANTEE rather than an assumption. The
    -- column is its own value so a future split-receipt feature does not have to
    -- redefine what a receipt is.
    amount           numeric(19,4) NOT NULL CHECK (amount > 0),
    currency         char(3) NOT NULL,
    method           text NOT NULL,
    received_at      timestamptz NOT NULL,
    received_by      uuid,
    version          integer NOT NULL DEFAULT 1 CHECK (version >= 1),
    supersedes_id    uuid,
    snapshot         jsonb NOT NULL,     -- the rendered document, frozen
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

-- ---------------------------------------------------------------------------
-- §12.4. fin_v_payment_position -- every report's payment-side formula, in one
-- place, so the API, the portal and the nightly reconciler cannot disagree.
--
-- security_invoker = on is MANDATORY (PostgreSQL 15+). Without it the view runs
-- as its owner and silently bypasses the caller's RLS, which for a view fanning
-- out over allocation rows would expose every tenant's money to any
-- authenticated session.
--
-- Two notes on this statement, both recorded because each has already been
-- misread as a defect by a reader who did not check the catalog:
--
--   (1) The GROUP BY lists only p.tenant_id, p.id, yet the target list projects
--       p.payment_no and p.amount. That is valid: fin_payments.id is a
--       single-column PRIMARY KEY, and PostgreSQL accepts any other column of
--       that relation once every column of its primary key appears in the GROUP
--       BY. Functional dependency is inferred from the PK alone and does NOT
--       extend to composite UNIQUE constraints, which is why
--       fin_payments_ten_id_uq on (tenant_id, id) would NOT have sufficed on its
--       own. Dropping p.id from the GROUP BY is a genuine 42803.
--   (2) §12.2's payment_unallocated formula carries one term this view omits:
--       payment_refund_reapplied(p). That term is identically zero in this
--       design -- §12.2 names it only so the future "refund that returns to
--       on-account" variant has somewhere to put its arithmetic. Omitting a
--       provably-zero term keeps the view and the formula numerically identical,
--       and the omission is stated here rather than left for a reader to find.
--
-- NOTE the three <= 0 correction terms in unallocated_amount: an on-account
-- RETURN, and the correction of an on-account CREDIT (reverse / refund_id IS
-- NULL / invoice_id IS NULL). The previous revision had only the first, so
-- reversing an on-account credit moved the family's money without moving any
-- published figure.
-- ---------------------------------------------------------------------------
CREATE VIEW fin_v_payment_position WITH (security_invoker = on) AS
SELECT p.tenant_id, p.id AS payment_id, p.payment_no, p.amount,
       p.amount
       - COALESCE(SUM(a.amount) FILTER (WHERE a.refund_id IS NULL
                                         AND a.invoice_id IS NOT NULL), 0)
       + COALESCE(SUM(a.amount) FILTER (WHERE a.effect = 'on_account_return'), 0)
       + COALESCE(SUM(a.amount) FILTER (WHERE a.refund_id IS NULL
                                         AND a.invoice_id IS NULL
                                         AND a.effect = 'reverse'), 0)
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

-- ---------------------------------------------------------------------------
-- §12.4.1. fin_v_invoice_balance -- the AUTHORITATIVE invoice money.
--
-- It recomputes from fin_invoice_items / fin_invoice_adjustments /
-- fin_payment_allocations and ignores the cached columns entirely, so a stale
-- cache can never make the view lie. The cache exists for reporting throughput,
-- not for correctness -- which is why every C-SEC negative test below is paired
-- with a positive control asserting the cache really does move.
--
-- FOUR INDEPENDENT SUB-QUERIES, NOT ONE JOINED AGGREGATE. This is the same defect
-- trg_fin_invoice_item_total was written to avoid: joining items to adjustments
-- to allocations on (tenant_id, invoice_id) produces a Cartesian product, so an
-- invoice with 3 lines, 1 adjustment and 2 allocations yields 6 rows and every
-- SUM is inflated by the product of the other two counts. A VIEW is the wrong
-- place to learn that lesson a second time, so the sums are separate and each is
-- independently indexable.
--
-- `balance` repeats the three total terms and the net_applied term rather than
-- aliasing `invoice_total - net_applied`, because a view's output column cannot
-- be referenced in the same SELECT list.
--
-- WHERE i.status <> 'draft' is load-bearing: a draft's balance is defined to be 0
-- by §9.6.0, so a draft is not a receivable and has no row here.
-- ---------------------------------------------------------------------------
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
                  WHERE a.tenant_id = i.tenant_id AND a.invoice_id = i.id
                    AND a.status = 'approved'), 0)
     + COALESCE((SELECT SUM(it.tax_amount)
                   FROM fin_invoice_items it
                  WHERE it.tenant_id = i.tenant_id AND it.invoice_id = i.id), 0)
                                            AS invoice_total,
       -- net_applied is SIGNED, so a reversal reduces it without a separate
       -- "reversed" column. The sum includes on-account returns only if they
       -- name this invoice, which by fin_pa_effect_ck they never do.
       COALESCE((SELECT SUM(pa.amount)
                   FROM fin_payment_allocations pa
                  WHERE pa.tenant_id = i.tenant_id AND pa.invoice_id = i.id), 0)
                                            AS net_applied,
       COALESCE((SELECT SUM(it.amount)
                   FROM fin_invoice_items it
                  WHERE it.tenant_id = i.tenant_id AND it.invoice_id = i.id), 0)
     + COALESCE((SELECT SUM(a.amount)
                   FROM fin_invoice_adjustments a
                  WHERE a.tenant_id = i.tenant_id AND a.invoice_id = i.id
                    AND a.status = 'approved'), 0)
     + COALESCE((SELECT SUM(it.tax_amount)
                   FROM fin_invoice_items it
                  WHERE it.tenant_id = i.tenant_id AND it.invoice_id = i.id), 0)
     - COALESCE((SELECT SUM(pa.amount)
                   FROM fin_payment_allocations pa
                  WHERE pa.tenant_id = i.tenant_id AND pa.invoice_id = i.id), 0)
                                            AS balance
  FROM fin_invoices i
 WHERE i.status <> 'draft';

-- ===========================================================================
-- FUNCTIONS
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- §12.4.1. fin_invoice_reapply_derived_state -- the arithmetic AND the status
-- decision, in ONE function. Deliberately NOT named trg_*: it returns void,
-- takes its arguments by name, and is PERFORMed rather than bound, which is what
-- keeps it out of §35.3's inventory as a 29th trigger function and out of F5d.
--
-- SECURITY INVOKER, and that is the pair's load-bearing detail. This function
-- issues `UPDATE fin_invoices SET balance, status, paid_at` on columns
-- school_app_rw cannot write, so in isolation it would need DEFINER. It does not:
-- its ONLY caller is trg_fin_invoice_balance_recompute, which IS a definer, and a
-- nested SECURITY INVOKER function executes with the caller's current role --
-- which here is school_migrator. The elevation is supplied by row 13 and this
-- function inherits it. The alternative (marking this one DEFINER too) was the
-- previous revision's choice and is worse in a specific way: this function is
-- not bound to any trigger, so it is an ordinary callable function with a uuid
-- signature, and a definer helper nobody may execute is safe but pointless.
--
-- It is the SECOND producer of fin.invoice_maintenance_scope and the only one
-- that establishes 'invoice_balance_state'. 0023 publishes the name and both
-- values and produces one of them; this file produces the other. Exactly two
-- producers exist in the whole phase. C-SEC-M3a asserts 0023 owns one; A16
-- asserts the vocabulary is asymmetric, with no third literal.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fin_invoice_reapply_derived_state(p_tenant uuid, p_invoice uuid)
RETURNS void
    LANGUAGE plpgsql
    SECURITY INVOKER
    SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE v_balance    numeric(19,4);
        v_status     text;
        v_new_status text;
        v_total      numeric(19,4);
BEGIN
    -- ONE STATEMENT, ONE LOCAL. An earlier draft read items and adjustments into
    -- two locals, then reassigned one from a combined expression, leaving the
    -- first two reads with no consumer. A local written twice is one whose
    -- authority a reader cannot determine, and FI-002's property test is the only
    -- thing that would catch the two readings ever disagreeing.
    --
    -- C-6: `a.status = 'approved'` -- identical to the filter in
    -- fin_v_invoice_balance and in trg_fin_invoice_item_total. Three copies of
    -- "what an adjustment is worth", which is why §16.4 keeps the definition in
    -- ONE place and these three are cross-references rather than independent
    -- definitions. FI-002's property test enumerates all three, so a fourth, or
    -- an edit to only one of them, fails it.
    --
    -- FOUR separate sub-queries, never a joined aggregate: see the note above
    -- fin_v_invoice_balance for why a 3-line / 1-adjustment / 2-allocation
    -- invoice would otherwise have every SUM inflated by a Cartesian product.
    SELECT (COALESCE((SELECT SUM(it.amount) FROM fin_invoice_items it
                       WHERE it.tenant_id = p_tenant AND it.invoice_id = p_invoice), 0)
          + COALESCE((SELECT SUM(a.amount) FROM fin_invoice_adjustments a
                       WHERE a.tenant_id = p_tenant AND a.invoice_id = p_invoice
                         AND a.status = 'approved'), 0)
          + COALESCE((SELECT SUM(it2.tax_amount) FROM fin_invoice_items it2
                       WHERE it2.tenant_id = p_tenant AND it2.invoice_id = p_invoice), 0)
          - COALESCE((SELECT SUM(pa.amount) FROM fin_payment_allocations pa
                       WHERE pa.tenant_id = p_tenant AND pa.invoice_id = p_invoice), 0))
      INTO v_balance;

    -- (C-9.2) The status decision, derived from the number just computed. It is
    -- HERE and not in the trigger because the trigger fires on an allocation
    -- insert, and deciding "is this now fully paid" requires the new balance,
    -- which requires this arithmetic. Passing the balance in as a parameter would
    -- put the value `status` depends on in two places, which is the shape of bug
    -- where a decision and its input drift.
    SELECT i.status, i.total INTO v_status, v_total
      FROM fin_invoices i
     WHERE i.tenant_id = p_tenant AND i.id = p_invoice;
    IF NOT FOUND THEN
        RETURN;   -- deleted in the same transaction; nothing to reapply
    END IF;

    -- (C-9.2 / P1-02) A DRAFT has no derived state to reapply, and a VOID invoice
    -- is terminal. Both are RETURNED FROM rather than carried through the
    -- arithmetic below, and the reason is a defect the previous revision shipped:
    -- it preserved the status LABEL (draft stayed draft) but still executed the
    -- UPDATE, so balance = v_balance was written. A draft with a 100 line and no
    -- allocation therefore ended the transaction with balance = 100, while
    -- fin_v_invoice_balance excludes drafts and §9.6.0 states a draft's balance is
    -- 0. Preserving the label is not preserving the invariant, and C-SEC-M6b (a
    -- line edit on a draft) is the case that witnesses it.
    --
    -- The early return also makes C-SEC-M6b STRUCTURAL rather than incidental:
    -- this writer now never names fin_invoices for a draft at all, so the AFTER
    -- UPDATE OF status freeze trigger cannot fire on this path. That trigger's
    -- WHEN clause is still load-bearing, but for the draft -> void discard
    -- transition (§9.6.0.1), not for this writer. Both facts are stated so a
    -- future revision cannot remove the WHEN clause on the belief that the early
    -- return is doing the work.
    --
    -- `expired` is deliberately NOT in the early-return set. An expired invoice
    -- still owes money, and an allocation against it must move it to
    -- partially_paid / paid; that is the whole reason the state is a cache.
    IF v_status IN ('draft', 'void') THEN
        RETURN;
    END IF;

    IF v_balance <= 0 THEN
        -- Zero or below: nothing is owed. A credit balance (signed allocations)
        -- lands here too, and is 'paid' in the sense that no money is due -- which
        -- is why this cannot be written as `net_applied > 0`, a rule that would
        -- leave every credit-balance invoice stuck at partially_paid forever.
        v_new_status := 'paid';
    ELSIF v_balance < v_total THEN
        v_new_status := 'partially_paid';
    ELSE
        v_new_status := 'issued';
    END IF;

    -- (C-9.2) paid_at is set on entry to 'paid' and CLEARED on exit, so
    -- fin_invoices_paid_at_ck is an equality rather than an implication. The
    -- CASE keeps the original timestamp on a no-op recompute: re-running now() on
    -- an already-paid invoice would silently restate when it settled, and a refund
    -- (which moves it back to partially_paid and clears paid_at) followed by
    -- re-payment is the only thing that should produce a new one.
    --
    -- C-SEC: `status` here is the reason the two paths must stay apart. This
    -- statement names `status`, so it satisfies the column filter of
    -- trg_fin_invoice_freeze_lines' AFTER UPDATE OF status binding and that
    -- trigger really does fire. What stops it stamping anything is, in the first
    -- instance, the early return above: for a draft this writer never reaches the
    -- UPDATE at all. The WHEN clause is the second line of defence and, unlike
    -- this writer, it also covers the draft -> void discard transition. Asserted by
    -- C-SEC-M6b; the structural half C-SEC-M6a pins the clause at the 0023
    -- checkpoint. If either the early return or the WHEN clause is relaxed, both
    -- fail, which is the correct direction for them to fail.
    PERFORM pg_catalog.set_config('fin.invoice_maintenance_scope',
                                  'invoice_balance_state', true);
    UPDATE fin_invoices
       SET balance = v_balance,
           status  = v_new_status,
           paid_at = CASE
                       WHEN v_new_status = 'paid' AND v_status <> 'paid' THEN now()
                       WHEN v_new_status <> 'paid' THEN NULL
                       ELSE paid_at
                     END,
           updated_at = now()
     WHERE tenant_id = p_tenant AND id = p_invoice;
    PERFORM pg_catalog.set_config('fin.invoice_maintenance_scope', '', true);
END $$;
REVOKE ALL ON FUNCTION fin_invoice_reapply_derived_state(uuid, uuid) FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- §12.4.1. trg_fin_invoice_balance_recompute -- row 13, the FI-002 cache writer
-- for balance/status/paid_at, and one of the FIVE whole-phase definers.
--
-- BOUND TO ALL THREE TABLES THAT FEED balance: fin_invoice_items,
-- fin_invoice_adjustments and fin_payment_allocations. A trigger bound only to
-- allocations would leave a posted invoice whose line was corrected keeping a
-- balance that no longer equals total - net_applied, and the first thing to
-- notice is month-end reconciliation, against a document already sent to a
-- family. All three are 0024's bindings, not two in 0023 plus one here, because
-- the function names fin_payment_allocations and §30.3.1's strict form forbids
-- 0023 from creating it at all.
--
-- BOTH SIDES ARE RECOMPUTED ON UPDATE. A trigger that reads
-- COALESCE(NEW.invoice_id, OLD.invoice_id) gets exactly one id, and on a move it
-- gets the destination; the origin invoice's balance then stays at its pre-move
-- value with no event left to correct it. Either the migration forbade the move
-- or the trigger must recompute both; recomputing both is one PERFORM per side
-- and needs no new constraint, so that is what this does.
--
-- AFTER, and RETURN NULL, and both are required. AFTER because the balance must
-- see the stored allocation row; RETURN NULL because in an AFTER row trigger the
-- return value is ignored, but returning NEW is misleading to the next reader who
-- copies the pattern into a BEFORE trigger.
--
-- SECURITY DEFINER because it writes balance/status/paid_at, none of which
-- §16.5.1 grants to school_app_rw. The arithmetic AND the status decision live in
-- fin_invoice_reapply_derived_state above; this function only decides WHICH
-- invoices to reapply.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trg_fin_invoice_balance_recompute() RETURNS trigger
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE v_invoice uuid;
        v_tenant  uuid;
BEGIN
    -- The FIRST write. On UPDATE this is the invoice the row is leaving; the
    -- second pass below handles the one it is joining. Both sides must be
    -- recomputed or a moved allocation leaves a stale balance on the old invoice
    -- forever, with nothing in the document to indicate it.
    IF TG_OP <> 'INSERT' THEN
        v_invoice := OLD.invoice_id;
        v_tenant  := OLD.tenant_id;
        IF v_invoice IS NOT NULL THEN
            PERFORM fin_invoice_reapply_derived_state(v_tenant, v_invoice);
        END IF;
    END IF;

    -- An allocation row with invoice_id IS NULL is an on-account movement; it
    -- touches no invoice and there is no row to update. This is what keeps the
    -- trigger from spending writes on the null case -- which is the common case
    -- for on-account returns -- and it is why the guard is on the *invoice id*
    -- and not on the operation.
    IF TG_OP = 'DELETE' THEN
        RETURN NULL;
    END IF;

    v_invoice := NEW.invoice_id;
    v_tenant  := NEW.tenant_id;
    IF v_invoice IS NOT NULL THEN
        PERFORM fin_invoice_reapply_derived_state(v_tenant, v_invoice);
    END IF;
    RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION trg_fin_invoice_balance_recompute() FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- §9.3.1. trg_fin_invoice_void -- row 5. Refuses paid -> void (C-12), requires
-- balance = 0 DERIVED FROM ALLOCATIONS, requires a reason, stamps voided_at.
--
-- CREATED HERE, NOT IN 0023: it reads fin_payment_allocations, so §30.3.1's
-- strict form puts it in the migration that owns that table. It was in 0023 in
-- the previous revision and would have raised 42P01 on the first void.
--
-- SECURITY INVOKER, DELIBERATELY. It writes voided_at, which §16.5.1 does not
-- grant to school_app_rw -- and it does not need definership, because it only
-- assigns NEW and a BEFORE trigger may set any column of NEW regardless of the
-- invoking role's column privileges. The caller performing the void names exactly
-- two columns, status and void_reason, and holds GRANT UPDATE on both; it never
-- needs voided_at.
--
-- The rule is not "BEFORE does not need DEFINER, AFTER does". It is "a function
-- that issues its OWN statement needs DEFINER; a function that only assigns to
-- NEW does not". trg_fin_invoice_item_total issues
-- `UPDATE fin_invoices SET ...` and is therefore DEFINER while this one is not,
-- and the difference is whose statement performs the write.
--
-- THE FOUR-CLAUSE ORDER IS NORMATIVE. Not-a-void-transition first, so the trigger
-- is inert on the many updates it is bound alongside. `paid` second, BEFORE the
-- balance test, because a paid invoice SATISFIES that test and the refusal should
-- name the policy rather than a number. The balance test third, and skipped for a
-- draft, where it is vacuous -- a draft -> void is a DISCARD, and
-- §12.5.1's target-state guard refuses an allocation naming a draft anyway. The
-- reason last, because it applies to both real transitions and to a discard, and
-- a caller who supplies neither deserves the most specific message.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trg_fin_invoice_void() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE v_paid numeric(19,4);
BEGIN
    IF NEW.status <> 'void' OR OLD.status = 'void' THEN
        RETURN NEW;                                    -- not a void transition
    END IF;

    -- (1) C-12 FIRST, so the refusal names the policy. A paid invoice has
    --     balance = 0, so a balance-only test would wave it through.
    IF OLD.status = 'paid' THEN
        RAISE EXCEPTION 'refund invoice % before voiding it', NEW.id
            USING ERRCODE = '55000';
    END IF;

    -- (2) 'draft' -> 'void' is a DISCARD and skips the balance test entirely.
    IF OLD.status <> 'draft' THEN
        -- (3) balance is DERIVED from allocations, never read from the cached
        --     column. A stale cache would pass a void that should be refused, and
        --     a cache this early in the sequence would always be stale.
        SELECT COALESCE(SUM(a.amount), 0) INTO v_paid
          FROM fin_payment_allocations a
         WHERE a.tenant_id = NEW.tenant_id
           AND a.invoice_id = NEW.id
           AND a.effect = 'apply';
        IF v_paid <> 0 THEN
            RAISE EXCEPTION 'cannot void an invoice with a settled balance of %', v_paid
                USING ERRCODE = '55000';
        END IF;
    END IF;

    -- (4) A void needs a reason, and the reason is not optional prose: an
    --     unreasoned void is indistinguishable from a deletion in an audit.
    IF NEW.void_reason IS NULL OR length(btrim(NEW.void_reason)) = 0 THEN
        RAISE EXCEPTION 'voiding an invoice requires a reason'
            USING ERRCODE = '55000';
    END IF;

    NEW.voided_at := now();
    RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION trg_fin_invoice_void() FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- §10.2. trg_fin_challan_status -- row 8. Derives fin_challans.status from the
-- owning invoice. SECURITY INVOKER.
--
-- CREATED HERE, NOT IN 0023: it reads fin_v_invoice_balance, which this file
-- creates.
--
-- PRECEDENCE IS STATED ONCE BECAUSE §10.2 AND TWO OTHER SECTIONS DEPEND ON IT:
--   void > paid > expired > partially_paid > issued
-- Because `expired` is tested BEFORE `partially_paid`, an OVERDUE challan with
-- any outstanding balance is `expired` even after a partial payment. It leaves
-- expired only by clearing its balance (paid) or by its invoice being voided, and
-- a partial payment on a past-due document does NOT yield partially_paid.
--
-- `paid -> void` is NOT an edge (C-12): the invoice's own guard refuses that
-- transition, so the challan reaches void only after a refund has moved the
-- invoice off `paid`. That makes the `paid -> partially_paid (refund)` edge
-- load-bearing for C-12 rather than cosmetic -- without it there is no
-- representable path from a paid challan to a voided one.
--
-- TWO SEPARATE READS, because v_inv is typed as the row type fin_invoices and has
-- no `balance` field: `SELECT i.*, v.balance` into a fin_invoices variable would
-- raise "record v_inv is not assigned yet / too many columns". The view's output
-- column list is (tenant_id, invoice_id, ..., balance) per §12.4.1.
--
-- The 42501 on an invisible balance is a PERMISSION failure, not a data failure:
-- the invoice exists but the caller cannot see it through the invoker view, and
-- reporting that as a missing invoice would be a lie.
--
-- NO DELETE TRIGGER IS NEEDED because there is no DELETE route and no DELETE
-- policy (§35.5). The control is that no such route exists.
-- ---------------------------------------------------------------------------
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
        -- The identity of the document is frozen. A challan that can be
        -- re-pointed at a different invoice is a second payable instrument for
        -- another family.
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
        RAISE EXCEPTION 'challan balance is not visible to this actor'
            USING ERRCODE = '42501';
    END IF;

    -- The closed derivation of §10.2, in precedence order.
    IF v_inv.status = 'void' THEN
        -- C-12, and this is where it becomes reachable: because `paid` is no
        -- longer an exit into void, this arm is taken ONLY after a refund has
        -- moved the invoice off `paid`, which is exactly what C-12 requires.
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
        -- Inherit the invoice's void provenance rather than inventing a reason
        -- here, so a reader comparing the two documents sees the same cause --
        -- and so fin_challans_void_ck is satisfied by the invoice's own stamp.
        NEW.voided_at := v_inv.voided_at;
        NEW.void_reason := v_inv.void_reason;
    END IF;
    RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION trg_fin_challan_status() FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- §10.2.1. trg_fin_challan_refresh -- row 8a, the SECOND 0024 definer and the
-- one that closes P0-07.
--
-- It does NOT derive the status. Row 8 does, and there is exactly one derivation
-- of the five-state rule in the whole design, which is the property §12.4's
-- "one implementation, one home" rule exists to preserve. This function's whole
-- job is to make a challan row be REWRITTEN so that row 8's BEFORE trigger
-- re-runs. `SET status = status` is deliberate: a self-assignment that changes
-- nothing is the cheapest way to say "re-derive this row", and it also satisfies
-- row 8's immutability guard, which refuses changes to invoice_id / issued_at /
-- due_on / snapshot and not to status -- otherwise the refresh would reject
-- itself.
--
-- SECURITY DEFINER, and this is the one place §10.2's argument about definership
-- does not apply. Row 8 is INVOKER because it accepts a caller's WRITE to a
-- challan row, and a definer version could accept a cross-tenant write that the
-- caller's own view returned as zero rows. This function issues no user-supplied
-- write: it writes only WHERE tenant_id = NEW.tenant_id AND invoice_id =
-- NEW.id, both taken from an invoice row the current session was already
-- authorized to UPDATE. The view read inside row 8 therefore resolves under the
-- owner, which is correct -- and the guard is no longer the view's RLS but the
-- invoice RLS that produced NEW.
--
-- NO RECURSION: this writes fin_challans, row 8 assigns NEW.status and writes
-- nothing further, and nothing here writes fin_invoices.
--
-- Skips drafts: no challan is ever issued against one, and a draft's status is
-- not payment state.
--
-- DELIBERATELY NOT BOUND to AFTER UPDATE OF balance/total/due_on, and not to
-- fin_invoice_items or fin_invoice_adjustments. The invoice's status already
-- encodes every change those can make -- a line correction that moves the balance
-- moves the status through row 13, which is the same UPDATE this trigger listens
-- to. Binding to balance as well would fire the refresh twice per allocation for
-- no additional coverage, and §35.3.2's binding arithmetic is exact rather than
-- generous.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trg_fin_challan_refresh() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
    IF NEW.status = 'draft' THEN
        RETURN NULL;
    END IF;
    UPDATE fin_challans
       SET status = status
     WHERE tenant_id = NEW.tenant_id
       AND invoice_id = NEW.id;
    RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION trg_fin_challan_refresh() FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- §12.1. trg_fin_reversal_shape_check -- the per-allocation magnitude bound,
-- as a standalone RETURNS void function, so that
--   (a) trg_fin_reversal_shape can enforce it at INSERT time, and
--   (b) 0025's fn_fin_refund_ceiling can RE-ENFORCE it at COMMIT for every
--       reversal row the transaction wrote, not only the last one.
-- One copy, two callers. Two copies would drift, and the drifted copy would be
-- the one that is not under test.
--
-- IT TAKES THE CANDIDATE'S FIELDS, NOT ITS ID, and that is the whole point of
-- the signature. The BEFORE caller is validating a row that does not exist yet;
-- a helper that looked the row up by id would find nothing and refuse EVERY
-- correction reversal. That was not a subtle defect -- it made the feature
-- impossible to use at all.
--
-- The TARGET row is still read by id, and that read is legitimate: it is a row
-- that already exists.
--
-- The caller guarantees, and this function relies on, three things: the row is a
-- reversal (both callers return early otherwise), p_target_id is NOT NULL
-- (fin_pa_effect_ck requires it on every reverse row), and p_amount < 0 (same
-- CHECK).
--
-- `a.id <> p_reversal_id` is load-bearing on two counts. It makes the helper
-- IDEMPOTENT, so re-running it at COMMIT is safe; and on the UPDATE path the row
-- being checked is already in the table, so without the exclusion its own OLD
-- version would be counted as a prior reversal and the row would be charged
-- twice against its own ceiling. On the INSERT path the id is new and matches
-- nothing, so the clause is a no-op there rather than an error.
--
-- The already-reversed sum covers BOTH flavours -- a correction reversal and N
-- refund reversals draw down the same ceiling, which is why both are summed.
--
-- The magnitude bound is not optional. The previous revision computed
-- v_original_amount and then never used it: only the invoice identity was
-- checked, so a cashier could reverse 5,000,000 against a 1,000 apply row and the
-- row-level CHECK would accept it. The refund ceiling would eventually catch it at
-- the PAYMENT level, but only for rows carrying a refund_id; a bare correction
-- reversal was entirely unbounded and could drive net_applied(invoice) deeply
-- negative -- a fabricated receivable no report would flag.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trg_fin_reversal_shape_check(
    p_tenant        uuid,
    p_reversal_id   uuid,            -- the reversal row's own id (NEW.id / OLD.id)
    p_target_id     uuid,            -- reversal_of_allocation_id
    p_invoice_id    uuid,            -- the invoice this reversal claims to touch
    p_amount        numeric(19,4)    -- negative, by fin_pa_effect_ck
) RETURNS void
    LANGUAGE plpgsql
    SECURITY INVOKER
    SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE v_original_invoice   uuid;
        v_original_amount    numeric(19,4);
        v_already_reversed   numeric(19,4);
        v_available          numeric(19,4);
BEGIN
    IF p_target_id IS NULL THEN
        RAISE EXCEPTION 'a reversal must name the allocation it reverses'
            USING ERRCODE = '55000';
    END IF;

    SELECT a.invoice_id, a.amount INTO v_original_invoice, v_original_amount
      FROM fin_payment_allocations a
     WHERE a.tenant_id = p_tenant AND a.id = p_target_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'reversal target does not exist in this tenant'
            USING ERRCODE = '55000';
    END IF;

    -- P1-13, part 1 of 2: a reversal may not name an invoice its target did not
    -- name.
    IF p_invoice_id IS DISTINCT FROM v_original_invoice THEN
        RAISE EXCEPTION 'reversal must target the same invoice as the allocation it reverses'
            USING ERRCODE = '55000';
    END IF;

    -- P1-13, part 2 of 2: and may not exceed the magnitude outstanding on its
    -- target. v_original_amount is the ORIGINAL applied amount (positive, by
    -- fin_pa_effect_ck).
    SELECT COALESCE(SUM(-a.amount), 0) INTO v_already_reversed
      FROM fin_payment_allocations a
     WHERE a.tenant_id = p_tenant
       AND a.reversal_of_allocation_id = p_target_id
       AND a.amount < 0
       AND a.id <> p_reversal_id;
    v_available := v_original_amount - v_already_reversed;

    IF -p_amount > v_available THEN
        RAISE EXCEPTION
            'reversal % exceeds the % still available on allocation %',
            -p_amount, v_available, p_target_id
            USING ERRCODE = '55000';
    END IF;
END $$;
REVOKE ALL ON FUNCTION trg_fin_reversal_shape_check(uuid, uuid, uuid, uuid, numeric) FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- §12.1. trg_fin_reversal_shape -- row 10. A THIN WRAPPER: all the arithmetic
-- lives in the helper, because the SAME two checks must run a second time at
-- COMMIT for every row in the transaction.
--
-- BEFORE INSERT OR UPDATE, because the remaining property is genuinely
-- cross-row and PostgreSQL forbids subqueries in a CHECK expression.
--
-- The helper is handed this row's FIELDS, not its id -- see the contract note
-- under the helper's own definition.
-- ---------------------------------------------------------------------------
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
    PERFORM trg_fin_reversal_shape_check(
        NEW.tenant_id, NEW.id, NEW.reversal_of_allocation_id,
        NEW.invoice_id, NEW.amount);
    RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION trg_fin_reversal_shape() FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- §12.1 / §28.3.2. trg_fin_pa_delete_guard -- row 10a, D1/A19: the append-only
-- boundary. Every DELETE is refused with SQLSTATE 55000 BEFORE the AFTER DELETE
-- branch of the balance trigger can run, so the guard and balance recomputation
-- never conflict and there is no path by which a DELETE reaches the cache
-- writer.
--
-- SECURITY INVOKER: the guard has nothing to elevate to -- it reads no row and
-- issues no statement, so definership would buy nothing and cost the ability to
-- be reasoned about from the runtime role's own session. search_path is pinned
-- and EXECUTE is revoked from PUBLIC, so the only way in is a trigger firing.
--
-- THE MESSAGE CONTAINS "append-only" because C-ALLOC-DEL-3 asserts on that word,
-- not merely on the SQLSTATE.
--
-- This is a HARD database invariant, not a policy: privilege revocations are in
-- addition to it. Even the table owner cannot perform an unauthorized DELETE,
-- and there is no legitimate internal DELETE path under the signed-allocation
-- model -- a correction is a reversal ROW plus a new allocation, never a rewrite
-- or a removal of where money went (§11.1).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trg_fin_pa_delete_guard() RETURNS trigger
    LANGUAGE plpgsql
    SECURITY INVOKER
    SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
    RAISE EXCEPTION 'fin_payment_allocations is append-only; DELETE is not permitted'
        USING ERRCODE = '55000';
END $$;
REVOKE ALL ON FUNCTION trg_fin_pa_delete_guard() FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- §12.5. trg_fin_allocation_family_guard -- row 11. Every allocation's
-- invoice's student must be linked to the payer guardian. This is the P0-09
-- cross-family hole, and it is expressed in a trigger rather than a CHECK
-- because the forbidden fact is a RELATIONSHIP between two rows in two different
-- tables, which needs a subquery, and PostgreSQL forbids subqueries in CHECK.
--
-- "AT LEAST ONE SHARED STUDENT", not "the payer is the invoice's primary
-- guardian": siblings at one school share a guardian and a single payment
-- legitimately settles several siblings' invoices. The rule that matters -- cash
-- never crosses a family boundary -- is exactly "some student of the paying
-- family is on the invoice".
--
-- SOFT-DELETED GUARDIANS ARE REFUSED: student_guardians rows are soft-deleted in
-- 0006, so a plain FK would happily accept a link that has been revoked. Both
-- sg.deleted_at IS NULL and g.deleted_at IS NULL are load-bearing. A revoked
-- link immediately stops authorising new allocations; existing allocations are
-- unaffected, because removing a guardian from a school must not rewrite history.
--
-- THE `NOT EXISTS` FORM IS DELIBERATE. The sub-select projects i.student_id for
-- invoices where the guardian condition is FALSE, so a non-null result means
-- "here is an invoice that is not this family's". Written the other way --
-- EXISTS(...) asserting that SOME invoice is fine -- the trigger would pass
-- whenever the payment had any legitimate invoice and would silently allow the
-- second, illegitimate one. The negating form makes the check PER-INVOICE, which
-- is the actual requirement.
--
-- Returns early for every non-apply row and for an on-account credit, because
-- only an apply names an invoice: a reversal names its TARGET's invoice (pinned
-- by trg_fin_reversal_shape) and an on-account return names none.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trg_fin_allocation_family_guard() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE v_payer uuid; v_invoice uuid; v_offending uuid;
BEGIN
    IF NEW.effect <> 'apply' OR NEW.invoice_id IS NULL THEN
        RETURN NEW;
    END IF;

    SELECT payer_guardian_id INTO v_payer
    FROM fin_payments
    WHERE tenant_id = NEW.tenant_id AND id = NEW.payment_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'allocation references an unknown payment' USING ERRCODE = '55000';
    END IF;

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

-- ---------------------------------------------------------------------------
-- §12.5.1. trg_fin_allocation_target_state -- row 12a, D9/P0-09's second half.
-- An `apply` row may name an invoice only in a state where money may be
-- received: issued, partially_paid, expired or paid.
--
--   draft  refused -- the document has not been issued and its balance is
--                     defined to be 0 by §9.6.0
--   void   refused -- terminal (P1-02)
--   paid   ALLOWED deliberately -- signed allocations and the documented
--                     over-credit state mean a second payment against a settled
--                     invoice is a CREDIT, not an error. Refusing it would leave
--                     every credit-balance invoice with no way to be corrected.
--   expired allowed -- an expired invoice still owes money and paying it is
--                     exactly how it leaves `expired`
--
-- WHY A FOURTH TRIGGER RATHER THAN A CLAUSE IN trg_fin_allocation_family_guard.
-- The family guard's remit is WHOSE invoice may be paid; this one's is WHICH
-- STATE it may be in, and the two failure modes -- cash crossing a family
-- boundary, and cash applied to a document that cannot receive it -- are
-- witnessed by different tests and deserve different messages. Folding them in
-- would also hide that a `reverse` row's invoice is NOT subject to this check
-- (it is subject to trg_fin_reversal_shape's same-invoice rule instead).
--
-- Returns early for every non-apply row and for a MISSING invoice: the composite
-- FK fin_pa_invoice_fk owns that case and rejects it immediately in the same
-- statement, so duplicating it here would give two error paths for one condition.
--
-- SECURITY INVOKER: it reads only rows the calling role could already read and
-- takes no lock, so it adds no privilege surface and no ordering constraint.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trg_fin_allocation_target_state() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE v_status text;
BEGIN
    IF NEW.effect <> 'apply' OR NEW.invoice_id IS NULL THEN
        RETURN NEW;
    END IF;

    SELECT i.status INTO v_status
      FROM fin_invoices i
     WHERE i.tenant_id = NEW.tenant_id AND i.id = NEW.invoice_id;

    IF NOT FOUND THEN
        RETURN NEW;
    END IF;

    IF v_status IN ('draft', 'void') THEN
        RAISE EXCEPTION
            'cash may not be applied to invoice % in state %; only an issued invoice may be paid',
            NEW.invoice_id, v_status
            USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION trg_fin_allocation_target_state() FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- §12.7. trg_fin_allocation_bounds -- row 12, FI-003: the payment-total bound,
-- locked and summed. The previous revision NAMED this trigger in four places and
-- defined it in none, so the bound existed only as prose and the only
-- enforcement was in the service -- which §12.5 already established is not the
-- trust boundary for a money move.
--
-- THE BOUND IS ON THE SET, NOT THE SINGLE ROW. A per-row bound (NEW.amount <=
-- p.amount) is satisfied by two rows of p.amount each, so double-applying a
-- payment would pass it. The invariant is about the SET of rows, which is why the
-- trigger recomputes the sum UNDER A LOCK rather than comparing the incoming row
-- alone -- a CHECK sees one row and cannot serialise against its siblings.
--
-- The payment row is locked FIRST and ascending, matching §12.6's protocol, so
-- two concurrent allocations against the same payment cannot both read the same
-- pre-state and both pass.
--
-- `a.id <> NEW.id` is load-bearing on the UPDATE path, where NEW.id is non-null:
-- without it the row's own OLD value is counted and an in-place correction is
-- rejected against a total that includes itself.
--
-- Only non-refund rows consume the payment's balance. A reverse row carrying a
-- refund_id is governed by the per-allocation ceiling in
-- trg_fin_reversal_shape_check and re-checked at COMMIT by 0025. An on-account
-- RETURN is a non-refund row and IS included, because it lowers the balance.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trg_fin_allocation_bounds() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE v_payment_amount numeric(19,4); v_committed numeric(19,4);
BEGIN
    IF NEW.refund_id IS NOT NULL THEN
        RETURN NEW;
    END IF;

    SELECT amount INTO v_payment_amount
      FROM fin_payments
     WHERE tenant_id = NEW.tenant_id AND id = NEW.payment_id
     ORDER BY id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'allocation references an unknown payment'
            USING ERRCODE = '55000';
    END IF;

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

-- ---------------------------------------------------------------------------
-- §13.3.2. trg_fin_on_account_return_bounds -- row 14. An on_account_return's
-- magnitude may not exceed the cash STILL HELD on account for that payment.
--
-- A RETURN IS NOT A REFUND: it is a permission distinct from fees.refunds.request,
-- it names no invoice, it is never refundable (FI-005), and it is the only
-- operation whose ledger pair touches 1000 Cash. That is what makes
-- payment_unallocated a non-negative quantity rather than a reported figure.
--
-- `NEW.amount + v_held < 0` is the correct ONE-SIDED bound: it says the held
-- balance would go negative, which is precisely the P0-07 defect made
-- unrepresentable rather than merely reported. The previous revision subtracted
-- every non-refund row including negative ones, so a full return of a
-- fully-unallocated payment produced a NEGATIVE unallocated balance.
--
-- `a.id <> NEW.id` is load-bearing on the UPDATE path for the same reason it is
-- in trg_fin_allocation_bounds: NEW.id is non-null there, so without it the
-- row's own OLD value sits inside v_held and NEW.amount is counted twice -- an
-- existing return of -40,000 updated to -60,000 would evaluate
-- -60,000 + (-40,000) = -100,000 < 0 and be refused, making an in-place
-- correction that LOWERS the return impossible.
--
-- Correctly a BEFORE INSERT OR UPDATE trigger, unlike 0025's refund ceiling:
-- there is exactly one row being validated and no siblings, so no deferral is
-- needed.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trg_fin_on_account_return_bounds() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE v_held   numeric(19,4);
        v_paid   numeric(19,4);
        v_applied   numeric(19,4);
        v_returned  numeric(19,4);
BEGIN
    IF NEW.effect <> 'on_account_return' THEN
        RETURN NEW;
    END IF;
    SELECT amount INTO v_paid
      FROM fin_payments
     WHERE tenant_id = NEW.tenant_id AND id = NEW.payment_id
     ORDER BY id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'on-account return references an unknown payment'
            USING ERRCODE = '55000';
    END IF;
    -- DEVIATION FROM §13.3.2's LITERAL FORMULA, and the only one in this file.
    --
    -- The design writes the ceiling as
    --     payment_returnable(p) = SUM a.amount WHERE a.payment_id = p
    --                              AND a.refund_id IS NULL AND a.invoice_id IS NULL
    -- which OMITS the payment total. That sum is not "cash held on account"; it is
    -- only the PREVIOUS returns, all of which are negative (fin_pa_effect_ck admits
    -- no positive invoice-less row), so the quantity is <= 0 for every payment. The
    -- guard then reduces to `NEW.amount < 0`, because NEW.amount is negative for an
    -- on_account_return -- so it refuses EVERY return, unconditionally, and the
    -- effect is unreachable.
    --
    -- Three clauses of the design require the opposite, and they cannot all hold
    -- with the literal formula:
    --   * §13.4 mode `none`: "the payment is fully on-account, Dr 1000 / Cr 1300" --
    --     so a payment with no allocations holds its whole amount.
    --   * §12's worked example (P2 = 100,000, fully unallocated, "then returned in
    --     full via one on_account_return row of -100,000") -- which the literal
    --     formula makes impossible.
    --   * §13.3.2's own stated purpose, "the invariant unallocated can never be
    --     over-returned", which is vacuous if nothing can ever be returned.
    --
    -- So the payment total IS subtracted from, never used as the ceiling alone:
    -- what is returned is the UNAPPLIED remainder, less anything already returned.
    -- This is the same quantity as fin_v_payment_position.unallocated_amount, which
    -- is why the view and this bound cannot drift apart.
    --
    -- `a.id <> NEW.id` is retained: NEW.id is non-null on the UPDATE path, so
    -- without it the row's own OLD value sits inside v_held and NEW.amount is
    -- counted twice -- an existing return of -40,000 updated to -60,000 would
    -- evaluate -60,000 + (-40,000) = -100,000 < 0 and be refused, making an
    -- in-place correction that LOWERS the return impossible.
    SELECT COALESCE(SUM(a.amount) FILTER (WHERE a.refund_id IS NULL AND a.invoice_id IS NOT NULL), 0),
           COALESCE(SUM(a.amount) FILTER (WHERE a.refund_id IS NULL AND a.invoice_id IS NULL), 0)
      INTO v_applied, v_returned
      FROM fin_payment_allocations a
     WHERE a.tenant_id = NEW.tenant_id AND a.payment_id = NEW.payment_id
       AND a.id <> NEW.id;
    v_held := v_paid - v_applied + v_returned;
    -- a BEFORE INSERT row is not yet counted, so compare with the pending row
    -- included
    IF NEW.amount + v_held < 0 THEN
        RAISE EXCEPTION
            'on-account return of % exceeds the % still held on account for this payment',
            -NEW.amount, v_held
            USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION trg_fin_on_account_return_bounds() FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- §25.5. trg_fin_receipt_freeze -- row 16. Receipt is immutable for life, FOR
-- EVERY ROLE including school_migrator.
--
-- NO ROLE CHECK AND NO GUC CHECK. The previous revision carried an
-- `app.allow_immutable_update` escape hatch; that is rejected twice over: a GUC
-- readable by a trigger expression is forgeable by the runtime role (0002
-- established the principle), and a role check would exempt exactly the role a
-- compromised migration runs as. This is the same no-GUC-bypass, no-role-
-- exemption rule as the ledger (§15.1, §19.7 F6).
--
-- ON INSERT IT OVERWRITES payer_guardian_id and amount FROM THE PAYMENT, it does
-- not validate them. "Validate and reject on mismatch" would still read the
-- client's value first, and the difference matters when the client's value is a
-- DIFFERENT guardian's id: overwriting means the wrong value is never written,
-- validation means it is briefly the value in NEW until this trigger runs.
--
-- amount = p.amount, NOT amount <= p.amount. A receipt for a PORTION of a payment
-- is a different payment, not a smaller receipt (§11.1, FI-007) -- a partial
-- receipt would be minted by the family's convenience and would then disagree
-- with the ledger.
--
-- A reprint is a VERSION, not an update, and it is a permissioned action:
-- version = 2 with supersedes_id set, requiring fees.receipts.reissue. Both
-- versions remain retrievable and printable forever.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trg_fin_receipt_freeze() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE v_payer uuid; v_amount numeric(19,4);
BEGIN
    IF TG_OP = 'DELETE' OR TG_OP = 'UPDATE' THEN
        RAISE EXCEPTION 'a receipt is immutable: % is not permitted', TG_OP
            USING ERRCODE = '55000';
    END IF;

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

    IF NEW.amount <> v_amount THEN
        RAISE EXCEPTION 'receipt amount must equal its payment amount'
            USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION trg_fin_receipt_freeze() FROM PUBLIC;

-- ===========================================================================
-- TRIGGER BINDINGS (§35.3.2, 0024 block): 13 statements over 11 functions.
--
-- Row 13 alone contributes THREE -- the extra two are fin_invoice_items and
-- fin_invoice_adjustments, which also feed balance. That is why 13 statements
-- sit over 11 functions and why the figure "three over five" in the previous
-- revision was the moved subset alone rather than the file.
--
-- trg_fin_refund_provenance is NOT bound here, even though
-- fin_payment_allocations is: its DECLARE block names the composite type
-- fin_refunds, which this file does not create, so both the function and its
-- allocations-side binding are deferred wholly to 0025 (§13.1, §30.3.1).
-- ===========================================================================

-- The three invoice triggers that need payment data are bound HERE (C-1, C-2).
--
-- TRIGGER NAME ORDER IS LOAD-BEARING, and this one was wrong until a runtime test
-- caught it. PostgreSQL fires BEFORE row triggers in ALPHABETICAL order of
-- tgname. trg_fin_invoice_void assigns NEW.voided_at inside a BEFORE trigger, and
-- `voided_at` is one of the seven server-owned columns trg_fin_invoice_header_guard
-- refuses at pg_trigger_depth() = 1. So a trigger named `fin_invoice_void_guard`
-- -- which sorts BEFORE `fin_invoices_header_guard` -- stamped voided_at first, and
-- the header guard then saw voided_at IS DISTINCT FROM OLD.voided_at on a statement
-- that had never named it, and refused the transition at depth 1.
--
-- The net effect was that `fin_invoices.status = 'void'` was UNREACHABLE: every
-- void UPDATE raised 55000, so an invoice could be issued and paid but never
-- voided, and trg_fin_challan_refresh had no void to propagate.
--
-- The fix is the naming convention row 4 already uses: `fin_invoices_number` also
-- assigns a guarded column (invoice_no) from inside a BEFORE trigger, and it works
-- because 'n' sorts after 'h'. This trigger now sorts after the header guard for
-- the same reason and by the same means. A caller still cannot set voided_at
-- itself -- the guard runs FIRST and refuses the caller's own target list.
DROP TRIGGER IF EXISTS fin_invoice_void_guard ON fin_invoices;
DROP TRIGGER IF EXISTS fin_invoices_void_stamp ON fin_invoices;
CREATE TRIGGER fin_invoices_void_stamp    BEFORE UPDATE ON fin_invoices
    FOR EACH ROW EXECUTE FUNCTION trg_fin_invoice_void();

-- FI-002 cache writer for balance/status/paid_at, now on ALL THREE tables that
-- feed it. A trigger bound only to allocations would leave a posted invoice whose
-- balance no longer equals total - net_applied.
DROP TRIGGER IF EXISTS fin_invoice_items_balance ON fin_invoice_items;
CREATE TRIGGER fin_invoice_items_balance AFTER INSERT OR UPDATE OR DELETE ON fin_invoice_items
    FOR EACH ROW EXECUTE FUNCTION trg_fin_invoice_balance_recompute();
DROP TRIGGER IF EXISTS fin_invoice_adjustments_balance ON fin_invoice_adjustments;
CREATE TRIGGER fin_invoice_adjustments_balance AFTER INSERT OR UPDATE OR DELETE ON fin_invoice_adjustments
    FOR EACH ROW EXECUTE FUNCTION trg_fin_invoice_balance_recompute();

DROP TRIGGER IF EXISTS fin_challans_status ON fin_challans;
CREATE TRIGGER fin_challans_status       BEFORE INSERT OR UPDATE ON fin_challans
    FOR EACH ROW EXECUTE FUNCTION trg_fin_challan_status();

-- (P0-07 §10.2.1) fin_invoices_challan_refresh -- the refresh point row 8 was
-- missing. Row 8 derives the challan's status but fires only when a CHALLAN row
-- is written, and nothing in the design ever writes one after INSERT, so without
-- this binding a challan freezes at whatever its balance was on the day it was
-- issued. UPDATE OF status catches every writer of that column -- allocation,
-- refund, line correction or void -- with one subscriber and no second
-- derivation.
DROP TRIGGER IF EXISTS fin_invoices_challan_refresh ON fin_invoices;
CREATE TRIGGER fin_invoices_challan_refresh AFTER UPDATE OF status ON fin_invoices
    FOR EACH ROW EXECUTE FUNCTION trg_fin_challan_refresh();

DROP TRIGGER IF EXISTS fin_allocations_shape ON fin_payment_allocations;
CREATE TRIGGER fin_allocations_shape     BEFORE INSERT OR UPDATE ON fin_payment_allocations
    FOR EACH ROW EXECUTE FUNCTION trg_fin_reversal_shape();
DROP TRIGGER IF EXISTS fin_allocations_family ON fin_payment_allocations;
CREATE TRIGGER fin_allocations_family    BEFORE INSERT OR UPDATE ON fin_payment_allocations
    FOR EACH ROW EXECUTE FUNCTION trg_fin_allocation_family_guard();
-- §12.5.1 P0-09's second half: an apply row may not name a draft or void invoice.
-- Disjoint from fin_allocations_family on `effect` and from
-- fin_allocations_shape the other way, so the three share no row and no ordering
-- constraint.
DROP TRIGGER IF EXISTS fin_allocations_target_state ON fin_payment_allocations;
CREATE TRIGGER fin_allocations_target_state BEFORE INSERT OR UPDATE ON fin_payment_allocations
    FOR EACH ROW EXECUTE FUNCTION trg_fin_allocation_target_state();
-- FI-003 (§12.7): the payment total, locked and summed. Distinct from the
-- on-account return ceiling below, which bounds one effect against cash still
-- held on account.
DROP TRIGGER IF EXISTS fin_allocations_bounds ON fin_payment_allocations;
CREATE TRIGGER fin_allocations_bounds    BEFORE INSERT OR UPDATE ON fin_payment_allocations
    FOR EACH ROW EXECUTE FUNCTION trg_fin_allocation_bounds();
DROP TRIGGER IF EXISTS fin_allocations_onaccount ON fin_payment_allocations;
CREATE TRIGGER fin_allocations_onaccount BEFORE INSERT OR UPDATE ON fin_payment_allocations
    FOR EACH ROW EXECUTE FUNCTION trg_fin_on_account_return_bounds();

-- D1/A19: the append-only boundary. Every DELETE is refused with 55000 before
-- the AFTER DELETE cache recomputation can run.
DROP TRIGGER IF EXISTS trg_fin_allocations_delete_guard ON fin_payment_allocations;
CREATE TRIGGER trg_fin_allocations_delete_guard
  BEFORE DELETE ON fin_payment_allocations
  FOR EACH ROW EXECUTE FUNCTION trg_fin_pa_delete_guard();

-- The THIRD binding of the same definer, on the table created HERE. Both sides of
-- an allocation move are recomputed (§12.4.1).
--
-- Views are NOT repeated in a binding block: fin_v_invoice_balance and
-- fin_v_payment_position (V1) are each written exactly once, above, in the
-- section that owns their contract.
DROP TRIGGER IF EXISTS fin_allocations_balance_cache ON fin_payment_allocations;
CREATE TRIGGER fin_allocations_balance_cache AFTER INSERT OR UPDATE OR DELETE ON fin_payment_allocations
    FOR EACH ROW EXECUTE FUNCTION trg_fin_invoice_balance_recompute();

-- Receipts are created and frozen in the SAME file: trg_fin_receipt_freeze's body
-- names nothing 0025+ creates, so §30.3.1 permits binding it here. A previous
-- revision filed it under 0025 instead, which made §30.1 and the binding block
-- disagree about which migration owns it -- the sort of drift R7' exists to catch.
DROP TRIGGER IF EXISTS fin_receipts_freeze ON fin_receipts;
CREATE TRIGGER fin_receipts_freeze       BEFORE INSERT OR UPDATE OR DELETE ON fin_receipts
    FOR EACH ROW EXECUTE FUNCTION trg_fin_receipt_freeze();