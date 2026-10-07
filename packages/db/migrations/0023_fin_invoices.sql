-- =============================================================================
-- 0023_fin_invoices.sql
--
-- WHAT
-- Phase 7 (Fees & Finance) migration 3 of 9. The invoice header, its two
-- children, and the collection document:
--
--   fin_invoices, fin_invoice_items, fin_invoice_adjustments, fin_challans
--   trg_fin_invoice_number()             - gap-free document numbering, and the
--                                          draft/void number rule (C-13)
--   trg_fin_invoice_header_guard()       - server-owned header fields, due_date
--                                          derivation (C-8), and the maintenance
--                                          authorization check
--   trg_fin_invoice_freeze_lines()       - the issue-time line stamp (row 4d)
--   trg_fin_invoice_item_amount()        - line amount = quantity x unit_amount
--   trg_fin_invoice_item_total()         - the subtotal/total cache writer,
--                                          bound on BOTH children (2 bindings)
--   trg_fin_invoice_adjustment_approval()- the approval transition (C-6)
--   trg_fin_invoice_items_freeze()       - issued-line freeze, bound on BOTH
--                                          children (2 bindings)
--   7 functions, 9 CREATE TRIGGER statements, 2 partial unique indexes
--
--   and ONE ALTER TABLE ... ADD CONSTRAINT:
--   fin_bri_invoice_fk  - fin_billing_run_items (tenant_id, invoice_id)
--                          -> fin_invoices (tenant_id, id), ON DELETE RESTRICT
--
-- WHY NO EXISTING MIGRATION IS EDITED
-- 0021 and 0022 are applied, audited and immutable. The changes the design
-- wanted on those files -- notably the `fin_billing_run_items` -> `fin_invoices`
-- foreign key -- are therefore made by ALTER inside the migration that owns the
-- referenced table, never by rewriting an applied file. That FK is 0023's, per
-- §35.2's FK map: the earliest legal placement is the end of THIS file, because
-- fin_invoices does not exist before it and the constraint's target must. It is
-- created as the last statement below, after all four CREATE TABLEs and after
-- fin_invoices_ten_id_uq is declared inline. It was previously mapped to 0024 in
-- one table cell and one column comment; both are corrected, and the dependent
-- figures are re-derived rather than adjusted by hand (§35.2, §9.5).
--
-- THE P0 THIS MIGRATION REMEDIATES (design register row 42)
-- trg_fin_invoice_item_total is a trigger that issues its own
-- `UPDATE fin_invoices SET subtotal, total, updated_at`. That nested statement
-- re-fires trg_fin_invoice_header_guard, and the previous revision of that guard
-- refused every change to all seven server-owned columns unconditionally -- so the
-- first INSERT of an invoice line raised 55000, and every invoice read
-- subtotal = total = balance = 0 forever. A refusal that fires on the maintenance
-- path is not protection; it is a broken design that also blocks the caller.
--
-- The fix is TWO FACTORS, BOTH REQUIRED, and it deliberately does NOT widen the
-- guard or make it SECURITY DEFINER:
--
--   A. STRUCTURAL -- pg_trigger_depth() >= 2. The nested UPDATE arrived from
--      inside a trigger. This is a property of the statement's position in the
--      trigger stack, not a flag, so it cannot be set by a role, a GUC, a
--      SECURITY DEFINER function or a compromised route handler. A statement
--      issued directly by ANY role arrives at depth 1 and is refused.
--   B. SCOPED -- current_setting('fin.invoice_maintenance_scope', true) must be
--      exactly 'invoice_line_totals' or 'invoice_balance_state', and the columns
--      that actually moved must be a subset of THAT value's column set.
--      (invoice_no, issued_at, voided_at) belong to NEITHER scope and are refused
--      unconditionally.
--
-- The scope is set with set_config(..., true) -- transaction-local -- immediately
-- before the UPDATE and reset immediately after, with no RETURN between them.
-- A session-global or a persistent role privilege would be a general application
-- bypass, which is precisely what this must not be.
--
-- trg_fin_invoice_header_guard is therefore SECURITY INVOKER: it issues no
-- statement of its own, which is what lets factor A tell a caller's direct UPDATE
-- from a maintenance writer's nested one.
--
-- frozen_at's lifecycle protection lives in trg_fin_invoice_freeze_lines, an
-- AFTER UPDATE OF status trigger, NOT in the header guard. See §9.6.0.1 for why
-- moving it out of a BEFORE trigger on the parent was the only correct fix: from
-- there the nested UPDATE hit the guard's own refusal AND would have been silently
-- clobbered by the outer statement's stored pre-image.
--
-- PRIVILEGE POSTURE
-- Each table is REVOKE ALL ... FROM school_app_rw immediately after its CREATE
-- TABLE, cancelling the 0001 default-privilege grant. These four tables are
-- UNREACHABLE until 0028 grants anything at all: no RLS, no app grant. §16.5.1's
-- column-level grant that makes the cache columns server-owned is 0028's, not
-- this file's; until then the trigger layer is the whole boundary and this
-- migration's own tests prove it.
-- =============================================================================


-- ---------------------------------------------------------------------------

-- §9.1. fin_invoices -- the header: grain, numbering, status, cached money.

-- ---------------------------------------------------------------------------

CREATE TABLE fin_invoices (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id        uuid NOT NULL,
    -- §9.1.1 THE GRAIN. One live invoice per (tenant, academic year, enrollment).
    -- Not one per billing run and not one per installment; §9.1.1 states why the
    -- first is forced by applied 0022 and why the second is a LINE property.
    -- NULL exactly in state 'draft' and permitted-but-unexpected in state 'void'
    -- (a draft discarded before issue never had a number to keep).
    invoice_no       text,
    student_id       uuid NOT NULL,
    academic_year_id uuid NOT NULL,
    enrollment_id    uuid NOT NULL,
    -- The structure that GENERATED this invoice, for provenance (§8.4's
    -- "explain a disputed bill from the run"). NULL for an invoice a finance
    -- officer composed by hand, which is why it is nullable; a
    -- run-generated invoice always has one, because
    -- fin_billing_run_items.structure_id is NOT NULL in applied 0022.
    structure_id     uuid,
    -- §18 invoice state machine. 'superseded' is NOT a state; see §9.2.1, which
    -- explains what replaced it and why the previous revision's diagram was
    -- wrong.
    status           text NOT NULL DEFAULT 'draft'
                     CHECK (status IN ('draft','issued','partially_paid','paid','void')),
    issued_at        timestamptz,
    -- §9.6.0 C-8. NOT NULL with no DEFAULT: the value is DERIVED by
    -- trg_fin_invoice_header_guard from the structure's first installment
    -- plan, else the structure's effective_from, else supplied by the caller
    -- when there is no structure. Never left to chance.
    due_date         date NOT NULL,
    -- The three CACHED money columns. All are trigger-maintained, none is
    -- writable by the runtime role, and the mechanism that guarantees it is
    -- §16.5.1: a COLUMN-LEVEL privilege grant, with the recompute functions as
    -- the only writers via SECURITY DEFINER. The previous revision asserted
    -- here that "§16.5 revokes the columns' UPDATE" and §16.5 revoked
    -- nothing, while §35.4 granted table-level UPDATE — so the §9.4 exception
    -- that keeps the header outside the line freeze was, in the built schema,
    -- a client-writable hole rather than an exemption. That is §16.5.1.
    --   subtotal = LINES ONLY (Σ fin_invoice_items.amount)
    --   total    = subtotal + Σ APPROVED adjustments + Σ tax
    --   balance  = total − net_applied   (FI-002, cached; the view is authoritative)
    subtotal         numeric(19,4) NOT NULL DEFAULT 0,
    total            numeric(19,4) NOT NULL DEFAULT 0,
    -- C-1. NO WRITER IN 0023. trg_fin_invoice_balance_recompute is created and
    -- bound by 0024, because it reads fin_payment_allocations. So between the
    -- 0023 landing and the 0024 landing this column is 0 on every row, by
    -- DEFAULT, and that is stated rather than left to be discovered. It is
    -- safe for the whole of that window because 0023 is UNREACHABLE: RLS is
    -- not enabled and school_app_rw holds no privilege on this table until
    -- 0028, so nothing can be read, written or voided. 0024 opens with a
    -- backfill of the column for every row that exists by then.
    balance          numeric(19,4) NOT NULL DEFAULT 0,
    -- C-9.2. Writer: 0024's trg_fin_invoice_balance_recompute, on the transition
    -- INTO 'paid' and cleared on the transition out of it. Declared here rather
    -- than left as a §16.5 reference to a column the DDL did not have.
    paid_at          timestamptz,
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
    -- C-14. created_by is a write-once audit identity, exactly like
    -- fin_fee_structures.published_by, so it is RESTRICT and NOT SET NULL.
    -- §35.2's FK map claimed to be exhaustive and had no row for this column,
    -- so an unconstrained uuid was accepted as the author of a financial
    -- document. Single-column, on the §6.3 R4 allowlist: `users` is
    -- platform-global and has no tenant_id. The account is deactivated, never
    -- deleted — the same operational answer 0022 shipped for published_by.
    CONSTRAINT fin_invoices_created_by_fk
        FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE RESTRICT,
    -- C-13. The number rule, stated as a CASE so that 'void' is explicitly the
    -- one state in which a number is OPTIONAL. A draft that is discarded before
    -- issue must not burn a counter value (§9.6.1), so a voided draft has no
    -- number; a voided ISSUED invoice keeps the number it was printed with,
    -- because that number was handed to a parent.
    CONSTRAINT fin_invoices_number_ck CHECK (
        CASE status
            WHEN 'draft' THEN invoice_no IS NULL
            WHEN 'void'  THEN TRUE
            ELSE              invoice_no IS NOT NULL
        END
    ),
    CONSTRAINT fin_invoices_void_ck CHECK (
        (status = 'void' AND voided_at IS NOT NULL AND void_reason IS NOT NULL
                   AND length(btrim(void_reason)) > 0)
     OR (status <> 'void' AND voided_at IS NULL)
    ),
    -- C-9.2. paid_at iff paid, in BOTH directions. This is a CHECK rather
    -- than prose because it is the only cheap way to catch a status writer
    -- that forgot the timestamp, or a stale timestamp left behind by a
    -- payment reversal. The previous revision wrote only
    --     (status = 'paid' AND paid_at IS NOT NULL) OR (status <> 'paid')
    -- whose second arm is TRUE for every row, so the constraint permitted
    -- paid_at to be set on a draft or on a voided invoice -- i.e. it enforced
    -- the implication in one direction and was silent in the other, which is
    -- exactly the state trg_fin_invoice_void and the balance recompute have to
    -- clear it on. Both arms are stated here.
    CONSTRAINT fin_invoices_paid_at_ck CHECK (
        (status = 'paid'   AND paid_at IS NOT NULL)
     OR (status <> 'paid' AND paid_at IS NULL)
    ),
    CONSTRAINT fin_invoices_ten_id_uq UNIQUE (tenant_id, id)
);

-- Revoke the 0001 default-privilege grant immediately (§35.4, §30.3).
REVOKE ALL ON fin_invoices FROM school_app_rw;

CREATE UNIQUE INDEX fin_invoices_number_uq
    ON fin_invoices (tenant_id, invoice_no)
    WHERE invoice_no IS NOT NULL;

-- C-7. This is the constraint that makes "billing twice" a unique violation
-- rather than a rounding difference, which is what §8.1 promised. Partial, so
-- that a voided invoice FREES its slot: §9.2.1's replacement draft needs it.
-- Without the WHERE clause a school could never re-invoice a family whose
-- invoice was voided, which §9.3 says is a real and common case.
CREATE UNIQUE INDEX fin_invoices_ten_enrollment_year_uq
    ON fin_invoices (tenant_id, enrollment_id, academic_year_id)
    WHERE status <> 'void';

-- §9.4.1. fin_invoice_items -- one billable line, positive by construction.

CREATE TABLE fin_invoice_items (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid NOT NULL,
    invoice_id      uuid NOT NULL,
    -- C-7. The line carries the structure and the installment, because §9.1.1
    -- puts the grain on the invoice and the installment dimension on the line.
    -- structure_id is NOT NULL: a line is a snapshot of exactly one
    -- fin_fee_structure_items row, and that row's own structure_id is NOT NULL
    -- in applied 0022. installment_no beside it is NOT, and the comment on that
    -- column says why -- the two columns came from the same applied grain but
    -- do not have the same shape.
    structure_id    uuid NOT NULL,
    -- C-7 + C-8, and the correction of a contradiction the previous revision
    -- created. installment_no is NULLABLE and there is no DEFAULT, because the
    -- two shapes a line can have are not the same shape:
    --   * a line taken from a structure WITH plan rows carries the real
    --     installment_no, and fin_invoice_items_plan_fk below proves it.
    --   * a line from a structure with NO plan rows has no installment to
    --     point at. Applied 0022 says such a structure "bills as a single
    --     installment on effective_from" -- a *billing convention*, not a plan
    --     row. The previous revision resolved this by defaulting the column to
    --     1 and declaring it NOT NULL, which is incompatible with that
    --     convention: a structure with no plans has no row
    --     (structure_id, 1) in fin_fee_installment_plans, so the composite FK
    --     below REJECTED every line of every plan-less structure. The two
    --     clauses could not both be satisfied, and the generator had no way to
    --     know which one it was expected to break.
    -- NULL is therefore the honest encoding of "this line is not tied to an
    -- installment", it is what lets the FK skip (MATCH SIMPLE), and the
    -- generator's two branches -- plan row present, else effective_from --
    -- map onto NULL and a value respectively. §7.4's "at most one plan" is
    -- what makes the first branch unambiguous.
    installment_no  integer CHECK (installment_no >= 1),
    -- The head supplies the tax treatment and the waivability rule; both are
    -- COPIED onto the line at issue time because a published structure is frozen
    -- but a fee HEAD can be re-taxed, and an issued invoice must not change when
    -- the head does. This is snapshotting, not denormalisation for speed.
    fee_head_id     uuid NOT NULL,
    description     text NOT NULL,
    -- C-10. A line may NOT be negative. The previous revision's comment here
    -- argued that a negative line is "a correction entered as a line, NOT a
    -- concession", and its CHECK was `amount <> 0`, which permits one — while
    -- §16.6, §16.7 and FI-001 all required `amount >= 0`. The comment was right
    -- about the CONSEQUENCE and wrong about the mechanism: a negative line IS an
    -- unapproved concession, and it is exactly the thing the adjustment approval
    -- gate exists to prevent. Allowing it here is how a waiver bypasses both
    -- fees.adjustments.approve and the fee head's is_waivable = false rule.
    -- So the sign is closed at the line, and every reduction is an
    -- adjustment.
    quantity        numeric(19,4) NOT NULL DEFAULT 1 CHECK (quantity <> 0),
    unit_amount     numeric(19,4) NOT NULL CHECK (unit_amount >= 0),
    -- C-9.1. WRITER: trg_fin_invoice_item_amount(), a BEFORE INSERT OR UPDATE
    -- trigger. The previous revision's comment claimed
    -- trg_fin_invoice_item_total maintained this column; that function updates
    -- only fin_invoices.subtotal and .total and never writes this row, so the
    -- claim was false and the column had no writer at all. The caller supplies
    -- quantity and unit_amount and this is derived, so no route can send a line
    -- total that disagrees with its own factors.
    amount          numeric(19,4) NOT NULL,
    tax_amount      numeric(19,4) NOT NULL DEFAULT 0
                    CHECK (tax_amount >= 0 AND tax_amount = round(tax_amount, 2)),
    -- Frozen at issue (§9.4). NULL while the parent invoice is a draft.
    -- WRITER: trg_fin_invoice_freeze_lines (§9.6.0.1, inventory row 4d), an
    -- AFTER UPDATE OF status trigger on fin_invoices that stamps every line on
    -- the transition out of 'draft'. It is NOT the header guard: that function's
    -- clause (6) used to do this from inside a BEFORE UPDATE trigger on the
    -- parent, which meant issuing an invoice raised 55000 from the header guard
    -- (§9.6.0). One writer, one function, and it is a definer only because
    -- frozen_at is not granted to school_app_rw (§16.5.1).
    frozen_at       timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT fin_invoice_items_invoice_fk
        FOREIGN KEY (tenant_id, invoice_id)
        REFERENCES fin_invoices (tenant_id, id) ON DELETE RESTRICT,
    CONSTRAINT fin_invoice_items_structure_fk
        FOREIGN KEY (tenant_id, structure_id)
        REFERENCES fin_fee_structures (tenant_id, id) ON DELETE RESTRICT,
    -- The three-column composite FK that makes "this line belongs to an
    -- installment of this structure's plan" a database fact rather than an
    -- application convention. fin_installment_plans_uq
    -- (tenant_id, structure_id, installment_no) is already applied in 0022, so
    -- no new anchor is needed and no index is added for it.
    --
    -- NULLABLE NOW, AND THAT IS THE POINT: with installment_no NULL (a
    -- plan-less structure, see the column comment above) MATCH SIMPLE skips
    -- this FK entirely, which is exactly the intended semantics -- there is no
    -- plan row to satisfy. The FK therefore enforces the claim only where the
    -- claim is meaningful, and no special-case trigger is needed to express
    -- "no plan". Declaring the column NOT NULL as the previous revision did
    -- turned the skip into an impossibility.
    CONSTRAINT fin_invoice_items_plan_fk
        FOREIGN KEY (tenant_id, structure_id, installment_no)
        REFERENCES fin_fee_installment_plans (tenant_id, structure_id, installment_no)
        ON DELETE RESTRICT,
    CONSTRAINT fin_invoice_items_head_fk
        FOREIGN KEY (tenant_id, fee_head_id)
        REFERENCES fin_fee_heads (tenant_id, id) ON DELETE RESTRICT,
    -- C-7 Q8: line uniqueness is (invoice, structure, head, installment), NOT
    -- (invoice, head). Two structures may legitimately charge the same fee head
    -- on one invoice; the same structure may not charge the same head for the
    -- same installment twice. This is the same four-column shape, and the same
    -- dedup role, as fin_fee_structure_items_uq in applied 0022.
    --
    -- NULLS NOT DISTINCT, and this is load-bearing rather than stylistic.
    -- installment_no is nullable (see the column comment), and under the
    -- default NULL-distinct semantics a plan-less structure could hold two
    -- identical lines -- NULL never equals NULL, so the constraint would fire
    -- on neither and the dedup role would silently evaporate for exactly the
    -- case the column became nullable to serve. NULLS NOT DISTINCT treats the
    -- two NULLs as one key and restores the guarantee. PostgreSQL 15+ is
    -- already a project requirement: §7.5's
    -- fin_fee_structure_targets_uq uses the same clause in applied 0022.
    CONSTRAINT fin_invoice_items_uq
        UNIQUE NULLS NOT DISTINCT
            (tenant_id, invoice_id, structure_id, fee_head_id, installment_no),
    CONSTRAINT fin_invoice_items_ten_id_uq UNIQUE (tenant_id, id),
    -- C-10 + C-17. `amount > 0` is the sign rule: zero is a mistake or a
    -- placeholder and both are better expressed by deleting the line, and a
    -- negative is a concession and belongs in fin_invoice_adjustments. The
    -- paisa half of §16.3's rule is the second conjunct, and it is stated as
    -- DDL here rather than left as prose — the previous revision wrote "CHECK
    -- (amount = round(amount, 2)) on all money columns" in §16.3 and put it in
    -- no DDL block anywhere in the phase, so a sub-paisa total was
    -- representable.
    CONSTRAINT fin_invoice_items_amount_ck
        CHECK (amount > 0 AND amount = round(amount, 2)),
    CONSTRAINT fin_invoice_items_unit_amount_ck
        CHECK (unit_amount = round(unit_amount, 2))
);

-- Revoke the 0001 default-privilege grant immediately (§35.4, §30.3).
REVOKE ALL ON fin_invoice_items FROM school_app_rw;

-- §9.5. fin_invoice_adjustments -- SIGNED. There is no `direction` column.

CREATE TABLE fin_invoice_adjustments (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid NOT NULL,
    invoice_id      uuid NOT NULL,
    -- C-5. THE CANONICAL ADJUSTMENT MODEL, in one place, because the previous
    -- revision specified two incompatible ones and every downstream section
    -- picked a different one. Three axes, and each is now decided:
    --
    --   column name   `adjustment_type`, NOT `type`
    --   sign          a SIGNED `amount`; there is NO `direction` column
    --   magnitude      |amount| is the money; the sign is the meaning
    --
    -- Why signed and not a `direction` column. §9.6's
    -- trg_fin_invoice_item_total — which is NORMATIVE, given in full, and
    -- bound twice — computes `total = v_sub + v_adj + v_tax` with a bare SUM.
    -- That expression is only correct if the sign is already in the column. A
    -- `direction` model would require rewriting that function to
    -- `SUM(CASE direction WHEN 'credit' THEN -amount ELSE amount END)`, and
    -- would make every one of the report formulas in §12.4 two columns wide
    -- where this design has always said one. The signed model is also the one
    -- the previous revision's own DDL and its own §9.5 sign CHECK used. The
    -- `direction` shape appears only in §16.6, §16.7 and FI-001, in prose, and
    -- those three are corrected to the signed model rather than the reverse.
    --
    -- The closed set is the union the phase actually needs, and it is CLOSED
    -- because the type determines the ledger account pair (§15.1): a waiver is
    -- Dr 4000 / Cr 4100, a fine is Dr 1200 / Cr 4200, a correction is a plain
    -- reversal. A free-text type with an application-chosen account is how the
    -- same fact posts two ways.
    --
    --   discount   reduce   -   no ledger move   (§15.1 contra-revenue)
    --   concession reduce   -   Dr 4000 / Cr 4100   requires approval
    --   waiver     reduce   -   Dr 4000 / Cr 4100   requires approval
    --   fine       raise    +   Dr 1200 / Cr 4200   requires approval
    --   late_fee   raise    +   Dr 1200 / Cr 4200   requires approval (§26.2 seam)
    --   correction either  ±   plain reversal        requires approval
    --
    -- 'concession' and 'late_fee' were named by §21.3 and §26.2 and were NOT
    -- legal values under the previous CHECK, so §21.3's approval gate keyed on
    -- `type IN ('concession','waiver')` could never fire for its first member.
    -- Both are now legal. 'late_fee' is a fine with a due date on it; it is
    -- distinct because §26.2 puts automatic assessment out of scope and names
    -- this column as the Phase 9/11 seam.
    adjustment_type text NOT NULL
                    CHECK (adjustment_type IN
                        ('discount','concession','waiver','fine','late_fee','correction')),
    -- Negative reduces the invoice, positive increases it. The SIGN is what
    -- distinguishes a reduction from a charge, which is why there is no
    -- direction column and why the sign CHECK below can be exhaustive.
    amount          numeric(19,4) NOT NULL
                    CHECK (amount <> 0 AND amount = round(amount, 2)),
    -- Mandatory and non-empty for every type. An adjustment with no reason is an
    -- unapproved money movement; the audit requirement is on the row, not on a
    -- separate log that can be pruned.
    reason          text NOT NULL CHECK (length(btrim(reason)) > 0),
    -- C-5/C-6. THE APPROVAL AXIS (OD-15, resolved before 0023 as OD-15 itself
    -- required). Four columns and a status, because "the approver is the
    -- creator" is not separation of duties and the previous revision said so
    -- while shipping it. See §9.5.1 for the full state machine and for why this
    -- could not be ALTERed in later.
    status          text NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','approved','rejected')),
    requested_by    uuid NOT NULL,
    approved_by     uuid,
    approved_at     timestamptz,
    rejected_reason text,
    -- C-5. REVERSAL LINKAGE, kept. §16.7 named `reverses_adjustment_id` as the
    -- reversal mechanism and §21.4 carries `fee_adjustment_reversal_invalid`,
    -- but the previous revision's DDL had no such column — so the one thing
    -- that makes a reversal findable (which adjustment is this undoing?) was
    -- described three times and implemented zero times. A `correction` is the
    -- reversal type, and this is what links it to its target.
    reverses_adjustment_id uuid,
    created_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT fin_invoice_adjustments_invoice_fk
        FOREIGN KEY (tenant_id, invoice_id)
        REFERENCES fin_invoices (tenant_id, id) ON DELETE RESTRICT,
    -- §6.3 R4: `users` is platform-global (P0-06a). BOTH identities are
    -- RESTRICT, not SET NULL, and the reason is the same one 0022 shipped for
    -- fin_fee_structures.published_by: a SET NULL is implemented as a
    -- referential UPDATE, and the audit identity of who asked for and who
    -- approved a money movement must not be erasable by deleting a user row.
    -- Deactivating the account (users.status) is the supported route.
    CONSTRAINT fin_invoice_adjustments_user_fk
        FOREIGN KEY (approved_by) REFERENCES users (id) ON DELETE RESTRICT,
    CONSTRAINT fin_invoice_adjustments_requester_fk
        FOREIGN KEY (requested_by) REFERENCES users (id) ON DELETE RESTRICT,
    -- Self-referential, on the same R4-composite shape as every other tenant
    -- relation. ON DELETE RESTRICT: an adjustment is never deleted at all
    -- (there is no DELETE privilege and no route), so this is about refusing to
    -- remove a target that a reversal points at.
    CONSTRAINT fin_invoice_adjustments_reverses_fk
        FOREIGN KEY (tenant_id, reverses_adjustment_id)
        REFERENCES fin_invoice_adjustments (tenant_id, id) ON DELETE RESTRICT,
    CONSTRAINT fin_invoice_adjustments_ten_id_uq UNIQUE (tenant_id, id),
    -- C-5. THE SIGN RULE, exhaustive over the closed set. The previous revision's
    -- `sign_ck` covered only waiver and discount, which left `fine` free to be
    -- negative — a "fine" that reduces a family's bill, wearing a fine's ledger
    -- treatment. Every type now has exactly the signs it may carry.
    CONSTRAINT fin_invoice_adjustments_sign_ck CHECK (
        CASE adjustment_type
            WHEN 'discount'   THEN amount < 0
            WHEN 'concession' THEN amount < 0
            WHEN 'waiver'     THEN amount < 0
            WHEN 'fine'       THEN amount > 0
            WHEN 'late_fee'   THEN amount > 0
            WHEN 'correction' THEN TRUE
            ELSE FALSE
        END
    ),
    -- C-5. A correction is only a reversal if it says what it reverses, and it
    -- may not reverse itself. Two conjuncts, both cheap, both closing a hole the
    -- previous revision's DDL had by omission.
    CONSTRAINT fin_invoice_adjustments_reverses_ck CHECK (
        (adjustment_type = 'correction') = (reverses_adjustment_id IS NOT NULL)
    ),
    -- C-6. THE APPROVAL STATE, in the schema rather than in a service. Three
    -- conjuncts, one per state, so there is no combination of populated and
    -- unpopulated columns that describes an approval that did not happen.
    CONSTRAINT fin_invoice_adjustments_approval_ck CHECK (
        CASE status
            WHEN 'pending'  THEN approved_by IS NULL
                              AND approved_at IS NULL
                              AND rejected_reason IS NULL
            WHEN 'approved' THEN approved_by IS NOT NULL
                              AND approved_at IS NOT NULL
                              AND rejected_reason IS NULL
            WHEN 'rejected' THEN approved_by IS NULL
                              AND approved_at IS NULL
                              AND rejected_reason IS NOT NULL
                              AND length(btrim(rejected_reason)) > 0
            ELSE FALSE
        END
    ),
    -- C-6. FOUR EYES, AT THE USER LEVEL. The approver must not be the requester.
    -- This is a CHECK rather than a permission because roles overlap by design
    -- (§20.5 gives school_owner all 25 fees.* permissions and accountant 22), so
    -- a role-level separation would be unenforced; separating the two ACTORS is
    -- enforceable, and it is the control the previous revision said it did not
    -- have.
    CONSTRAINT fin_invoice_adjustments_no_self_approval_ck CHECK (
        approved_by IS NULL OR approved_by <> requested_by
    ),
    -- C-5. NO SELF-REVERSAL. `reverses_adjustment_id` references
    -- (tenant_id, id) of the same table, so a row may name itself -- the FK is
    -- satisfied by the row being inserted. The previous revision had no
    -- conjunct forbidding it, and §9.5.1's prose ("the reversal is a NEW row")
    -- was the only thing standing between an implementation and a row whose
    -- `reverses_adjustment_id` is its own `id`. `IS DISTINCT FROM` rather than
    -- `<>` because the non-correction case leaves the column NULL, and NULL must
    -- pass.
    CONSTRAINT fin_invoice_adjustments_no_self_reversal_ck CHECK (
        reverses_adjustment_id IS DISTINCT FROM id
    )
);

-- Revoke the 0001 default-privilege grant immediately (§35.4, §30.3).
REVOKE ALL ON fin_invoice_adjustments FROM school_app_rw;

-- §10. fin_challans -- the collection document, 1:1 with an invoice. Its

-- status trigger is created and bound by 0024 (C-2), so a challan has no

-- trigger yet and its `status` is not yet derived.

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

-- ---------------------------------------------------------------------------

-- Trigger functions (§35.3.2). Every one is plpgsql with a pinned

-- search_path, and every one is REVOKE ALL ... FROM PUBLIC so only the

-- owner may execute it.

-- ---------------------------------------------------------------------------


CREATE OR REPLACE FUNCTION trg_fin_invoice_header_guard() RETURNS trigger
    LANGUAGE plpgsql
    SECURITY INVOKER
    SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE v_derived    date;
        v_scope       text;
        v_line_dirty  boolean;
        v_bal_dirty   boolean;
        v_ident_dirty boolean;
BEGIN
    IF TG_OP = 'INSERT' THEN
        -- (1) C-SEC. A caller may not seed the caches. Forcing them to 0 here
        -- rather than trusting the DEFAULT is the point: DEFAULT is not a
        -- privilege, so a route that lists subtotal/total in its INSERT column
        -- list would otherwise write them, and nothing downstream could tell
        -- the difference between a computed zero and a supplied zero.
        NEW.subtotal := 0;
        NEW.total    := 0;
        NEW.balance  := 0;   -- stays 0 until 0024 writes it (C-1)
        NEW.paid_at  := NULL;
    ELSE
        -- (2) C-SEC. These are server-owned on UPDATE — and NOT unconditionally,
        -- which is the whole remediation.
        --
        -- The previous revision refused every change to all seven columns, and
        -- §9.6.2's cache writer is a trigger that issues its own
        -- `UPDATE fin_invoices SET subtotal, total, updated_at`. SECURITY DEFINER
        -- does not suppress this trigger, so that statement hit this clause and
        -- the first line INSERT on any invoice raised 55000. The caches were
        -- therefore unreachable: every invoice read subtotal = total = balance = 0
        -- forever, and every report derived from them reported zero. A refusal
        -- that fires on the maintenance path is not protection — it is a broken
        -- design that also blocks the caller. The same trap waits in 0024:
        -- fin_invoice_reapply_derived_state issues
        -- `UPDATE fin_invoices SET balance, status, paid_at, updated_at`.
        --
        -- TWO FACTORS, BOTH REQUIRED, and neither is sufficient alone.
        --
        --   A. STRUCTURAL — pg_trigger_depth() >= 2. The header UPDATE was itself
        --      issued from inside a trigger. This is not a flag and nothing can
        --      set it: it is a property of where the statement sits in the
        --      trigger stack, so it cannot be forged by a role, a GUC, a SECURITY
        --      DEFINER function or a compromised route handler. A statement
        --      issued directly by ANY role, school_app_rw or school_migrator
        --      alike, arrives here at depth 1 and is refused. "The owner has no
        --      bypass" is then a fact rather than a hope (C-SEC-M7).
        --
        --   B. SCOPED — current_setting('fin.invoice_maintenance_scope', true)
        --      is exactly one of two values, and the columns that actually moved
        --      must be a subset of THAT value's column set. §9.6.0.1 publishes the
        --      vocabulary, the producer, the lifetime and the cleanup.
        --
        -- The three flags are grouped by writer, not by column, because the
        -- scopes are: invoice_line_totals may move the line pair, and
        -- invoice_balance_state the balance pair. The identity triple
        -- (invoice_no, issued_at, voided_at) is in NEITHER scope and is refused
        -- unconditionally below — which is not an omission but a fact about how
        -- those three are written: §9.6.1 and §9.3.1 assign them to NEW inside a
        -- BEFORE trigger and never issue an UPDATE of them, so no maintenance
        -- path exists that legitimately needs to reach them. A third scope can
        -- therefore never be added to make them writable without also writing the
        -- writer, which is the property that makes the closed set safe to extend.
        v_line_dirty := NEW.subtotal  IS DISTINCT FROM OLD.subtotal
                     OR NEW.total      IS DISTINCT FROM OLD.total;
        v_bal_dirty  := NEW.balance   IS DISTINCT FROM OLD.balance
                     OR NEW.paid_at    IS DISTINCT FROM OLD.paid_at;
        v_ident_dirty:= NEW.invoice_no IS DISTINCT FROM OLD.invoice_no
                     OR NEW.issued_at  IS DISTINCT FROM OLD.issued_at
                     OR NEW.voided_at  IS DISTINCT FROM OLD.voided_at;

        IF v_line_dirty OR v_bal_dirty OR v_ident_dirty THEN
            -- Factor A. Refusal names the depth, because a reader who hits this
            -- on a maintenance path needs to know immediately that the UPDATE was
            -- not nested inside a trigger.
            IF pg_trigger_depth() < 2 THEN
                RAISE EXCEPTION
                    'subtotal, total, balance, invoice_no, issued_at, voided_at and paid_at are trigger-maintained; a directly issued UPDATE is never a maintenance write'
                    USING ERRCODE = '55000';
            END IF;

            -- Factor B. current_setting's second argument is missing_ok: it yields
            -- NULL when the GUC is unset rather than raising. And NULL = 'anything'
            -- is NULL, so an absent scope falls to the ELSE branch and is refused.
            -- That is the intended reading: no authorization, no write.
            v_scope := current_setting('fin.invoice_maintenance_scope', true);
            IF v_scope = 'invoice_line_totals' THEN
                IF v_bal_dirty OR v_ident_dirty THEN
                    RAISE EXCEPTION
                        'maintenance scope % does not cover balance, paid_at, invoice_no, issued_at or voided_at',
                        v_scope
                        USING ERRCODE = '55000';
                END IF;
            ELSIF v_scope = 'invoice_balance_state' THEN
                IF v_line_dirty OR v_ident_dirty THEN
                    RAISE EXCEPTION
                        'maintenance scope % does not cover subtotal, total, invoice_no, issued_at or voided_at',
                        v_scope
                        USING ERRCODE = '55000';
                END IF;
            ELSE
                RAISE EXCEPTION
                    'no internal maintenance authorization is established for this write (fin.invoice_maintenance_scope = %)', COALESCE(v_scope, '<unset>')
                    USING ERRCODE = '55000';
            END IF;
        END IF;
    END IF;

    -- (3) due_date, immutable once the invoice leaves draft. C-8: the previous
    -- revision declared `due_date date NOT NULL` with no DEFAULT, no derivation
    -- and no writer anywhere in the phase, which is a NOT NULL column that
    -- fails at INSERT for every invoice whose author did not know a secret rule.
    IF TG_OP = 'UPDATE' AND OLD.status <> 'draft' AND NEW.due_date IS DISTINCT FROM OLD.due_date THEN
        RAISE EXCEPTION 'due_date cannot be changed after issue' USING ERRCODE = '55000';
    END IF;

    IF NEW.due_date IS NULL THEN
        -- (4) Derivation, in precedence order. The two derived sources are
        -- exactly the two cases applied 0022 already documents: a structure
        -- with plan rows bills on the FIRST installment's due_on, and a
        -- structure with no plan rows "bills as a single installment on
        -- effective_from" (0022_fin_fee_structures.sql, section 3 header).
        -- MIN(due_on) is deterministic because
        -- fin_installment_plans_uq makes due_on distinct per (structure,
        -- installment_no).
        IF NEW.structure_id IS NOT NULL THEN
            SELECT MIN(p.due_on) INTO v_derived
              FROM fin_fee_installment_plans p
             WHERE p.tenant_id = NEW.tenant_id
               AND p.structure_id = NEW.structure_id;

            IF v_derived IS NULL THEN
                SELECT s.effective_from INTO v_derived
                  FROM fin_fee_structures s
                 WHERE s.tenant_id = NEW.tenant_id
                   AND s.id = NEW.structure_id;
            END IF;
        END IF;

        -- (5) No structure, or a structure with neither plans nor an
        -- effective_from (impossible - effective_from is NOT NULL - so this is
        -- the no-structure case). The caller must supply it. Fails closed with a
        -- message that names the fix rather than a bare not-null violation.
        IF v_derived IS NULL THEN
            RAISE EXCEPTION
                'due_date is required on an invoice with no fee structure to derive it from'
                USING ERRCODE = '55000';
        END IF;
        NEW.due_date := v_derived;
    END IF;

    -- (6) MOVED to trg_fin_invoice_freeze_lines (§9.6.0.1, inventory row 4d).
    -- This is the single most load-bearing deletion in the phase, and it is the
    -- direct cause of the P0 the previous revision shipped.
    --
    -- It was `UPDATE fin_invoice_items SET frozen_at = now()` issued from inside a
    -- BEFORE UPDATE trigger on fin_invoices, on draft -> non-draft. Two defects,
    -- one loud and one quiet:
    --
    --   LOUD.  That UPDATE re-fires trg_fin_invoice_item_total (§9.6.2), whose own
    --          `UPDATE fin_invoices SET subtotal, total, updated_at` came straight
    --          back into the clause (2) above and raised 55000. Issuing an invoice
    --          failed, and adding a line to a draft failed.
    --
    --   QUIET, and worse.  It was a nested UPDATE against the very row the outer
    --          statement was mid-way through. Widening clause (2) alone would NOT
    --          have fixed it: the nested write lands, and then the OUTER statement
    --          stores its own (pre-image + NEW-assignments), clobbering it. A loud
    --          55000 would have become a silently stale cache, which is strictly
    --          worse in a financial system because nothing reports it.
    --
    -- So the fix is structural rather than a widening of clause (2): the stamp is
    -- now an AFTER UPDATE OF status trigger on fin_invoices, which fires once the
    -- header row is STORED and therefore writes a row no outer statement still
    -- owns. The cost of moving it — the parent now reads 'issued' by the time the
    -- stamp runs, so trg_fin_invoice_items_freeze has to admit its own stamp — is
    -- paid explicitly in §9.4.1, where the freeze names that exemption.
    --
    -- The previous revision described this clause approvingly as "the one clause in
    -- a BEFORE trigger that behaves like an AFTER trigger, and it is why the
    -- function is in F5d rather than in F5". It did behave like one. That was the
    -- defect, not the observation.
    RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION trg_fin_invoice_header_guard() FROM PUBLIC;

CREATE OR REPLACE FUNCTION trg_fin_invoice_freeze_lines() RETURNS trigger
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
    -- `frozen_at IS NULL` makes this idempotent and makes it safe that the
    -- trigger may fire more than once for one transition: re-stamping an already
    -- stamped line would otherwise restate when the invoice was issued, on a row
    -- whose contents are meant to be permanent evidence.
    UPDATE fin_invoice_items
       SET frozen_at = now()
     WHERE tenant_id = NEW.tenant_id
       AND invoice_id = NEW.id
       AND frozen_at IS NULL;

    -- RETURN NULL in an AFTER row trigger: the return value is ignored, and
    -- returning NEW invites the next reader to copy the pattern into a BEFORE
    -- trigger where it is wrong (§12.4.1 makes the same point for row 13).
    RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION trg_fin_invoice_freeze_lines() FROM PUBLIC;

CREATE OR REPLACE FUNCTION trg_fin_invoice_number() RETURNS trigger
    LANGUAGE plpgsql
    SECURITY DEFINER
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

    -- C-13. A DRAFT that is discarded must not burn a counter value. Under the
    -- previous revision's code, draft -> void fell through to the allocation
    -- branch below and consumed a number from a document that was never issued
    -- and never printed — an observable gap in the tenant's invoice sequence
    -- caused by throwing away a mistake, and a direct contradiction of
    -- fin_invoices_number_ck's CASE, which permits a void invoice to have no
    -- number precisely so that this case has somewhere to go.
    IF NEW.status = 'void' AND NEW.invoice_no IS NULL THEN
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
        -- The prefix is the first four characters of the academic year's id, which
        -- makes it vary by year (the counter is per tenant+year, so two years can
        -- both hand out 000001) and makes the number stable for a given year.
        -- NOTE the parentheses: `::left(4)` is a CAST to a type named `left` and
        -- raises `type "left" does not exist` on every issue. Written as a call.
        NEW.invoice_no := 'INV-' || left(NEW.academic_year_id::text, 4)
                         || '-' || lpad(v_next::text, 6, '0');
        NEW.issued_at  := now();
    END IF;
    -- An already-numbered invoice keeps its number across non-draft transitions
    -- (issued -> partially_paid -> paid), so this is NOT reassigned on every UPDATE.
    RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION trg_fin_invoice_number() FROM PUBLIC;

CREATE OR REPLACE FUNCTION trg_fin_invoice_item_amount() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
    -- §16.3: round HALF-UP on the absolute value, exactly once, at the point of
    -- division. Rounding the absolute value and then restoring the sign is what
    -- makes -0.5 round to -0.01 rather than to 0.00, which a bare
    -- round(quantity * unit_amount, 2) would do for negative products. The
    -- CHECK on the column then refuses the zero case, so a line that rounds away
    -- to nothing is a loud failure rather than a silent disappearance.
    --
    -- quantity may be negative on paper (the CHECK only bars zero) but
    -- unit_amount may not be, and the CHECK on amount is amount > 0, so a
    -- negative product is refused at the constraint. The sign convention of
    -- this column is therefore POSITIVE by construction, and no rounding rule
    -- is needed for negatives in practice - which is why the code is written
    -- the simple way and the comment explains the one case it is defensive
    -- about.
    NEW.amount := round(NEW.quantity * NEW.unit_amount, 2);
    RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION trg_fin_invoice_item_amount() FROM PUBLIC;

CREATE OR REPLACE FUNCTION trg_fin_invoice_item_total() RETURNS trigger
    LANGUAGE plpgsql
    SECURITY DEFINER
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
    -- C-6. `AND status = 'approved'` is the enforcement of "an adjustment does
    -- not count until a second user approves it", and it is here rather than in
    -- a CHECK because a CHECK cannot see a SUM. The previous revision had no
    -- status column at all, so this filter is new behaviour AND new syntax: a
    -- pending row is now visible to finance staff and invisible to the total,
    -- which is the whole point of having asked for it separately.
    SELECT COALESCE(SUM(amount), 0) INTO v_adj
      FROM fin_invoice_adjustments
     WHERE tenant_id = v_tenant AND invoice_id = v_invoice
       AND status = 'approved';
    SELECT COALESCE(SUM(tax_amount), 0) INTO v_tax
      FROM fin_invoice_items
     WHERE tenant_id = v_tenant AND invoice_id = v_invoice;

    -- subtotal is LINES ONLY. total is subtotal + APPROVED adjustments + tax.
    -- Keeping them separate is what lets a report show "billed 100, waived 10,
    -- tax 0" rather than a single opaque 90, and it is why three columns exist
    -- rather than one.
    --
    -- C-SEC: this UPDATE is the reason the function is SECURITY DEFINER.
    -- subtotal and total are NOT granted to school_app_rw (§16.5.1), so under
    -- SECURITY INVOKER this statement would fail 42501 on the first line
    -- inserted. The function is the writer; the role is not.
    --
    -- C-SEC: it is ALSO why this UPDATE needs the maintenance context, and the
    -- two requirements are different questions. Definership answers "may this
    -- statement write subtotal at all"; the context answers "which of the
    -- server-owned columns is this writer entitled to move". §9.6.0's clause (2)
    -- asks the second question on the way in, and without the context below this
    -- statement is refused by the guard it exists to satisfy — which is the P0
    -- this revision fixes.
    --
    -- The scope is established immediately before the UPDATE and reset
    -- immediately after, with no RETURN between them. `pg_catalog.` is qualified
    -- even though search_path is pinned: this statement is the reason a reader
    -- must not have to reason about resolution order to see who is authorized.
    PERFORM pg_catalog.set_config('fin.invoice_maintenance_scope',
                                  'invoice_line_totals', true);
    UPDATE fin_invoices
       SET subtotal = v_sub,
           total    = v_sub + v_adj + v_tax,
           updated_at = now()
     WHERE tenant_id = v_tenant AND id = v_invoice;
    -- Back to '' rather than to NULL: set_config stores a string, and '' is the
    -- value §9.6.0's ELSE branch refuses, which is the same answer either way.
    -- This reset is hygiene, not the protection -- pg_trigger_depth() >= 2 in
    -- §9.6.0 already makes a leaked value inert (§9.6.0.1).
    PERFORM pg_catalog.set_config('fin.invoice_maintenance_scope', '', true);
    RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION trg_fin_invoice_item_total() FROM PUBLIC;

CREATE OR REPLACE FUNCTION trg_fin_invoice_adjustment_approval() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE v_invoice_status text;
        v_target_status    text;
BEGIN
    -- C-6, DRAFT-ONLY APPROVAL, enforced here and nowhere else. The parent
    -- invoice's state is a fact about a DIFFERENT row, so no CHECK on this table
    -- can see it -- this is the same aggregate-visibility problem as the
    -- removed requires_approval_ck, and the same reason the rule lives in a
    -- trigger. Without it, a concession could be approved on an already-issued
    -- invoice, which §9.2 does not allow and which §9.5.1's prose promised.
    --
    -- The previous revision of this function read the invoice but never compared
    -- its status, so `v_invoice_status` was selected and discarded.
    SELECT i.status INTO v_invoice_status
      FROM fin_invoices i
     WHERE i.tenant_id = OLD.tenant_id
       AND i.id = OLD.invoice_id;
    IF v_invoice_status IS NULL THEN
        RAISE EXCEPTION
            'an adjustment requires an existing invoice, tenant % invoice %',
            OLD.tenant_id, OLD.invoice_id
            USING ERRCODE = '55000';
    END IF;
    IF v_invoice_status <> 'draft' THEN
        RAISE EXCEPTION
            'an adjustment may only be approved while the invoice is a draft, but invoice % is %',
            OLD.invoice_id, v_invoice_status
            USING ERRCODE = '55000';
    END IF;

    -- Every field that is NOT part of the approval transition. Written as a
    -- positive list of what MUST be unchanged, because a negative list has to be
    -- extended every time a column is added, and a column added without
    -- extending it becomes silently mutable.
    IF NEW.invoice_id           IS DISTINCT FROM OLD.invoice_id
       OR NEW.adjustment_type   IS DISTINCT FROM OLD.adjustment_type
       OR NEW.amount            IS DISTINCT FROM OLD.amount
       OR NEW.reason            IS DISTINCT FROM OLD.reason
       OR NEW.requested_by      IS DISTINCT FROM OLD.requested_by
       OR NEW.reverses_adjustment_id IS DISTINCT FROM OLD.reverses_adjustment_id
       OR NEW.created_at        IS DISTINCT FROM OLD.created_at
    THEN
        RAISE EXCEPTION
            'an invoice adjustment is immutable; only its approval may change'
            USING ERRCODE = '55000';
    END IF;

    -- The only two legal transitions. status is not among the fields above,
    -- because it IS the thing being transitioned.
    IF NOT ( (OLD.status = 'pending'  AND NEW.status = 'approved')
          OR (OLD.status = 'pending'  AND NEW.status = 'rejected') ) THEN
        RAISE EXCEPTION
            'an adjustment may only move from pending to approved or rejected, not % to %',
            OLD.status, NEW.status
            USING ERRCODE = '55000';
    END IF;

    -- Approved means somebody who is not the requester, and a timestamp. The
    -- four-eyes and state-shape rules are also CHECK constraints; this clause is
    -- what turns the *absence* of those constraints failing (a 55000 from
    -- fin_invoice_adjustments_no_self_approval_ck) into a message that names the
    -- control. Belt and braces, and deliberately: the CHECK is the enforcement,
    -- this is the diagnosis.
    IF NEW.status = 'approved' AND NEW.approved_by IS NOT NULL
       AND NEW.approved_by = NEW.requested_by THEN
        RAISE EXCEPTION
            'an adjustment cannot be approved by the user who requested it'
            USING ERRCODE = '55000';
    END IF;
    IF NEW.status = 'approved' AND NEW.approved_at IS NULL THEN
        NEW.approved_at := now();
    END IF;

    -- A reversal must point at an APPROVED adjustment. A `correction` that
    -- reverses a pending or rejected row is reversing nothing, and §21.4's
    -- fee_adjustment_reversal_invalid is the API's name for this refusal.
    IF NEW.reverses_adjustment_id IS NOT NULL THEN
        SELECT a.status INTO v_target_status
          FROM fin_invoice_adjustments a
         WHERE a.tenant_id = OLD.tenant_id
           AND a.id = NEW.reverses_adjustment_id;
        IF v_target_status IS NULL OR v_target_status <> 'approved' THEN
            RAISE EXCEPTION
                'a correction may only reverse an approved adjustment'
                USING ERRCODE = '55000';
        END IF;
    END IF;

    RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION trg_fin_invoice_adjustment_approval() FROM PUBLIC;

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

    -- (C-13) A DISCARDED DRAFT IS VOIDED, NOT DELETED — but its lines still have to be
    -- deletable, or §9.2.1's `draft -> void` path cannot be completed: the header is
    -- frozen the moment it leaves draft, so a line could never be removed afterwards,
    -- and a discarded draft would keep billing a family for fees nobody intends to
    -- charge. The parent is 'void', not 'draft', at this point, so the previous
    -- revision's `v_status <> 'draft'` refused it — meaning the adjudicated C-13
    -- behaviour was unreachable for any draft that had lines, which is all of them.
    --
    -- So the freeze has exactly three exceptions, all narrow:
    --   parent 'void'  — only DELETE, and only because a void can never be un-voided
    --                    (§9.3, void is terminal), so a line cannot be re-added either.
    --                    INSERT is still refused: the line would land on a document
    --                    whose header is terminal.
    --   parent 'draft' — the ordinary case, and everything is allowed.
    --   the ISSUE STAMP — the one write admitted on a live invoice, below.
    -- Nothing else moves, and in particular a voided invoice's ADJUSTMENTS are NOT
    -- deletable: they are the audit record of what was waived and refused, and
    -- §9.5.1 makes rejection permanent for the same reason.
    --
    -- THE ISSUE STAMP, and it exists only because §9.6.0 clause (6) moved.
    -- trg_fin_invoice_freeze_lines (§9.6.0.1) stamps every line the moment its
    -- invoice leaves 'draft'. It is an AFTER UPDATE OF status trigger on
    -- fin_invoices, so by the time it runs the parent row is already stored and
    -- reads 'issued' — and the check below would refuse the stamp that
    -- trg_fin_invoice_item_total's re-entrant cache write depends on, making it
    -- impossible to issue an invoice with lines on it. In the previous revision
    -- the stamp lived in a BEFORE UPDATE trigger on the parent, where the parent
    -- still read 'draft' and it passed by ACCIDENT; that accident cost the
    -- clause-(2) 55000 and a silent-clobber hazard, and moving the stamp is what
    -- fixed both. The consequence is paid here, explicitly, rather than left to
    -- whichever trigger happens to run first.
    --
    -- Narrow on purpose. `frozen_at` must go NULL -> non-NULL, on an
    -- `fin_invoice_items` row (not an adjustment), and EVERY OTHER COLUMN MUST BE
    -- BYTE-IDENTICAL — which is why the whole row is compared rather than a
    -- negative list. The negative-list form has to be extended every time a column
    -- is added and a column added without extending it becomes silently mutable
    -- (§9.6.2's approval trigger states the same preference for the same reason).
    -- In particular this does NOT reopen the C-9.1 `amount` guard below: amount is
    -- among the columns that must be identical, so the guard below cannot be
    -- reached through this path at all.
    --
    -- And no client can produce this statement shape: school_app_rw holds no
    -- UPDATE on `frozen_at` (§16.5.1), so the exemption is reachable only from
    -- trg_fin_invoice_freeze_lines.
    -- The rows are compared through to_jsonb(), NOT as OLD.structure_id and
    -- siblings. `->>` (not `->`) is required for the frozen_at probes: `->`
    -- returns JSON null for a SQL NULL, and `jsonb IS NULL` is FALSE for JSON
    -- null, so the `->` form made this exemption unreachable and the stamp was
    -- refused. `->>` yields SQL NULL, which is what the probe means.
    --
    -- This function is bound to BOTH fin_invoice_items and
    -- fin_invoice_adjustments (§35.3 row 6, two bindings), and the two tables do
    -- not share a column list: only the items table has frozen_at,
    -- structure_id, installment_no, fee_head_id, description, quantity,
    -- unit_amount and tax_amount. A direct `OLD.frozen_at` reference is a runtime
    -- error the moment the statement runs against the adjustments table —
    -- "record old has no field frozen_at" — so every adjustment UPDATE and DELETE
    -- on a live invoice raised 42883 instead of the intended 55000, and the
    -- approval path this function guards could not run at all.
    --
    -- to_jsonb(OLD) yields only the columns that table actually has, so the
    -- per-column comparison below is expressed as a whole-row comparison of the
    -- FIELDS BOTH TABLES SHARE, plus a separate check that the items-only
    -- columns did not move. Comparing the shared prefix via JSON keeps the
    -- exemption's meaning ("the stamp changed nothing else") without naming a
    -- column the other table lacks.
    IF v_status NOT IN ('draft', 'void')
       AND TG_OP = 'UPDATE'
       AND TG_TABLE_NAME = 'fin_invoice_items'
       AND (to_jsonb(OLD) ->> 'frozen_at') IS NULL
       AND (to_jsonb(NEW) ->> 'frozen_at') IS NOT NULL
       -- Everything except frozen_at is byte-identical.
       AND (to_jsonb(NEW) - 'frozen_at')
         IS NOT DISTINCT FROM
           (to_jsonb(OLD) - 'frozen_at')
    THEN
        RETURN NEW;   -- the issue stamp, and nothing else
    END IF;

    IF v_status NOT IN ('draft', 'void') THEN
        RAISE EXCEPTION
            'cannot % a line of a % invoice; issue a correction instead',
            LOWER(TG_OP), v_status
            USING ERRCODE = '55000';
    END IF;
    IF v_status = 'void' AND (TG_OP <> 'DELETE' OR TG_TABLE_NAME <> 'fin_invoice_items') THEN
        RAISE EXCEPTION
            'cannot % a % of a void invoice; it is terminal', LOWER(TG_OP), TG_TABLE_NAME
            USING ERRCODE = '55000';
    END IF;

    -- (C-9.1) The line amount is server-owned, and it is a cache of
    -- quantity * unit_amount computed by trg_fin_invoice_item_amount. Once the
    -- invoice is out of draft, a caller changing `amount` directly would write a
    -- cache that disagrees with its own inputs, and the recompute trigger
    -- (AFTER, so it cannot undo this) would then cache the caller's number rather
    -- than the computed one. Refused explicitly rather than left to the column
    -- grant, so the failure names the rule.
    IF TG_OP = 'UPDATE'
       AND NEW.amount IS DISTINCT FROM OLD.amount
       AND v_status <> 'draft' THEN
        RAISE EXCEPTION
            'the line amount of a % invoice is derived, not writable', v_status
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

-- ---------------------------------------------------------------------------

-- Trigger bindings (§35.3.2, 0023 block): 9 statements over 7 functions.

-- trg_fin_invoice_item_total is bound on BOTH children and

-- trg_fin_invoice_items_freeze likewise, which is why 9 statements sit over

-- 7 functions.

-- ---------------------------------------------------------------------------


-- 0023: invoices, items, challans
--
-- SCOPE (C-1, C-2, §30.3.1 strict form): NOTHING in this block may name
-- fin_payment_allocations or fin_v_invoice_balance, in a body OR in a DECLARE
-- row type. That is why trg_fin_invoice_void, trg_fin_challan_status and
-- trg_fin_invoice_balance_recompute are NOT here — all three are in the 0024
-- block below. The previous revision bound all three in 0023 and each would have
-- failed 42P01 on first use.
DROP TRIGGER IF EXISTS fin_invoices_number ON fin_invoices;
CREATE TRIGGER fin_invoices_number       BEFORE INSERT OR UPDATE ON fin_invoices
    FOR EACH ROW EXECUTE FUNCTION trg_fin_invoice_number();
-- C-8/C-9.1/C-SEC: server-owned header fields, due_date derivation, and the
-- maintenance-context refusal. BEFORE, because it sets NEW and (on INSERT)
-- normalises the caches. SECURITY INVOKER: it issues no statement of its own
-- (§16.5.2), which is what lets clause (2) tell a caller's direct UPDATE from a
-- maintenance writer's nested one.
DROP TRIGGER IF EXISTS fin_invoices_header_guard ON fin_invoices;
CREATE TRIGGER fin_invoices_header_guard BEFORE INSERT OR UPDATE ON fin_invoices
    FOR EACH ROW EXECUTE FUNCTION trg_fin_invoice_header_guard();
-- C-SEC: the issue-time line stamp, moved OUT of the header guard's clause (6)
-- into its own AFTER trigger. AFTER is the fix, not a preference: from a BEFORE
-- trigger the nested UPDATE hit the header guard's own server-owned refusal
-- (55000), and even once that was allowed the outer statement would have stored
-- its own pre-image and silently clobbered the cache write (§9.6.0.1). UPDATE OF
-- status plus WHEN keeps it off the 0024 balance writer's path, which never
-- moves an invoice out of draft.
DROP TRIGGER IF EXISTS fin_invoices_freeze_lines ON fin_invoices;
CREATE TRIGGER fin_invoices_freeze_lines AFTER UPDATE OF status ON fin_invoices
    FOR EACH ROW
    WHEN (OLD.status = 'draft' AND NEW.status <> 'draft' AND NEW.status <> 'void')
    EXECUTE FUNCTION trg_fin_invoice_freeze_lines();
-- C-9.1: the line amount is a cache of quantity * unit_amount and cannot be set
-- by an AFTER trigger.
DROP TRIGGER IF EXISTS fin_invoice_items_amount ON fin_invoice_items;
CREATE TRIGGER fin_invoice_items_amount   BEFORE INSERT OR UPDATE ON fin_invoice_items
    FOR EACH ROW EXECUTE FUNCTION trg_fin_invoice_item_amount();
DROP TRIGGER IF EXISTS fin_invoice_items_total ON fin_invoice_items;
CREATE TRIGGER fin_invoice_items_total   AFTER INSERT OR UPDATE OR DELETE ON fin_invoice_items
    FOR EACH ROW EXECUTE FUNCTION trg_fin_invoice_item_total();
-- The SAME function on the adjustments table. Without this, an adjustment
-- inserted after the lines leave subtotal/total stale forever: the function
-- already reads fin_invoice_adjustments, but a function only runs when its
-- trigger fires, and no trigger fired on the table that was edited. A waived
-- 500 fee that does not appear on the invoice is the failure.
DROP TRIGGER IF EXISTS fin_invoice_adjustments_total ON fin_invoice_adjustments;
CREATE TRIGGER fin_invoice_adjustments_total AFTER INSERT OR UPDATE OR DELETE ON fin_invoice_adjustments
    FOR EACH ROW EXECUTE FUNCTION trg_fin_invoice_item_total();
-- C-6: the approval transition. Bound to UPDATE only, because INSERT carries the
-- pending default and DELETE is refused entirely (§9.4.1).
DROP TRIGGER IF EXISTS fin_invoice_adjustments_approval ON fin_invoice_adjustments;
CREATE TRIGGER fin_invoice_adjustments_approval BEFORE UPDATE ON fin_invoice_adjustments
    FOR EACH ROW EXECUTE FUNCTION trg_fin_invoice_adjustment_approval();
-- Issued-line freeze (§9.4.1): one function, both sides of the invoice total.
DROP TRIGGER IF EXISTS fin_invoice_items_freeze ON fin_invoice_items;
CREATE TRIGGER fin_invoice_items_freeze  BEFORE UPDATE OR DELETE ON fin_invoice_items
    FOR EACH ROW EXECUTE FUNCTION trg_fin_invoice_items_freeze();
DROP TRIGGER IF EXISTS fin_invoice_adjustments_freeze ON fin_invoice_adjustments;
CREATE TRIGGER fin_invoice_adjustments_freeze BEFORE UPDATE OR DELETE ON fin_invoice_adjustments
    FOR EACH ROW EXECUTE FUNCTION trg_fin_invoice_items_freeze();

-- =============================================================================
-- C-3, C-4 -- fin_bri_invoice_fk. The LAST statement in this file, and the
-- reason this file is not purely a table-and-trigger migration.
--
-- OWNERSHIP. 0023 owns this constraint. It was previously mapped to 0024 in
-- §35.2's FK map and given ON DELETE SET NULL in §8.7's column comment; both are
-- corrected, and §9.5's DDL -- which always carried the adjudicated form -- is
-- what this file now implements. The reason 0023 and not 0024 is ordering, not
-- preference: fin_invoices is created by THIS file, so this is the first
-- migration at which the constraint can exist at all, and the ALTER follows all
-- four CREATE TABLEs because its target must be present when it runs. Deferring
-- it to 0024 would leave the column unconstrained for the whole life of the
-- phase.
--
-- COMPOSITE, therefore tenant-safe (C-3):
--     (tenant_id, invoice_id) -> (tenant_id, id)
-- against fin_invoices_ten_id_uq, which §9.1 declares INLINE in fin_invoices --
-- this ALTER does not create that anchor, it consumes it. tenant_id participates
-- in the key, so a cross-tenant attachment is unrepresentable rather than merely
-- unlikely, and §6.3 R1/R2 hold without an elision. MATCH SIMPLE is the default,
-- so every pre-commit item -- every row whose invoice_id is still NULL, which is
-- all of them until the attachment step -- stays legal with the column NULL.
--
-- ON DELETE RESTRICT (C-4), and RESTRICT is not a preference:
--   * invoice_id is nullable, but ON DELETE SET NULL is still IMPOSSIBLE here,
--     and that is the load-bearing point. PostgreSQL implements SET NULL as a
--     referential UPDATE of the referencing columns, and §8.7.1's freeze admits
--     exactly ONE update to this column -- attaching an invoice, once, under
--     OLD.invoice_id IS NULL. A referential UPDATE would arrive with
--     OLD.invoice_id IS NOT NULL and be refused by trg_fin_billing_run_items_freeze,
--     so the action could never complete; it would raise 55000 at delete time
--     instead of performing the SET NULL it promises.
--   * it would also try to null tenant_id, since a bare SET NULL on a composite
--     FK nulls every referencing column. tenant_id is NOT NULL and part of the
--     primary key, so the statement fails on 23502 before the trigger is even
--     consulted -- an error that looks like a NOT NULL violation and says
--     nothing about the real cause.
--   * RESTRICT preserves the audit meaning: an invoice a committed billing run
--     produced cannot be deleted while that link exists, and §9.2.1 has already
--     removed the hard-delete path for drafts (C-13), so no legitimate caller is
--     blocked by this action.
--   * RESTRICT matches all five sibling FKs on this same table -- fin_bri_run_fk,
--     fin_bri_enrollment_fk, fin_bri_student_fk, fin_bri_structure_fk,
--     fin_bri_assignment_fk -- and the D7 precedent. A sixth action on one table
--     would be the odd one out for no stated reason.
--
-- NO BACKFILL is needed or performed. Every fin_billing_run_items row that exists
-- at this point has invoice_id IS NULL, so the constraint is added over a set that
-- satisfies it trivially. A17 asserts the constraint's presence, composite shape,
-- target and delete action against the catalog, so a later migration cannot
-- quietly drop or weaken it.
-- =============================================================================
ALTER TABLE fin_billing_run_items
    ADD CONSTRAINT fin_bri_invoice_fk
    FOREIGN KEY (tenant_id, invoice_id)
    REFERENCES fin_invoices (tenant_id, id) ON DELETE RESTRICT;
