-- =============================================================================
-- 0026_fin_ledger.sql
--
-- WHAT
-- Phase 7 (Fees & Finance) migration 6 of 9. The operationally-authoritative
-- sub-ledger: the double-entry record every other finance projection can be
-- recomputed from, and the only path by which a ledger row may ever be written.
--
-- Creates TABLES (3):
--   fin_ledger_event_types   - the closed, owner-only provenance catalogue (F-02)
--   fin_ledger_entry_groups - one balanced, immutable posting header
--   fin_ledger_entries      - the legs of a posting
--
-- Seeds CATALOGUE (exactly 10 rows):
--   invoice.issue, invoice.void, payment.settled, allocation.apply,
--   allocation.reverse, onaccount.return, adjustment.post, adjustment.reverse,
--   refund.approved, refund.processed
--
-- Creates FUNCTIONS (5):
--   trg_fin_ledger_group_balance        - deferred per-group balance proof
--   trg_fin_ledger_seal                 - sealed_at is write-once, seal validates
--   trg_fin_ledger_append_only          - no UPDATE/DELETE on a leg, any role
--   trg_fin_ledger_sealed_group_reject  - a leg may not join a sealed group
--   post_fin_ledger_group (F4)          - the SOLE ledger write path
--
-- Creates VIEWS (5):
--   V1 fin_v_ledger_account_balance           (security_invoker = on)
--   V2 fin_v_ar_aging, fin_v_collections_summary,
--      fin_v_fee_head_revenue, fin_v_on_account_summary (owner-scoped)
--
-- Adds FK constraints (the 5 owned by 0026 per the design's FK map):
--   fin_ledger_entries   (tenant_id, account_code)   -> fin_ledger_accounts (tenant_id, code)
--   fin_ledger_entries   (tenant_id, entry_group_id) -> fin_ledger_entry_groups (tenant_id, id)
--   fin_ledger_entries   (tenant_id, student_id)     -> students (tenant_id, id)
--   fin_ledger_entries   (tenant_id, invoice_id)     -> fin_invoices (tenant_id, id)
--   fin_ledger_entry_groups (tenant_id, reversal_of_group) -> itself (tenant_id, id)
--
-- Creates INDEXES (4):
--   fin_leg_groups_origin_uq    partial UNIQUE, one origin per event+source
--   fin_leg_groups_reversal_uq  partial UNIQUE, one reversal per target
--   fin_leg_entries_ar_idx      partial, AR aging reads (tenant_id, student_id)
--   (plus fin_leg_entries_ten_id_uq, the uniform tenant anchor UNIQUE constraint)
--
-- NOTE -- scope
-- This migration owns ONLY the ledger. It does NOT create
-- trg_fin_ledger_group_commit, F13 app_finance_actor_has_permission, or
-- F14 app_finance_emit_event, and it does NOT create the 0028 runtime-security
-- layer (final RLS policies, table grants, view grants).
--
--   * trg_fin_ledger_group_commit is named in two deliverable tables but has no
--     function body, no row in the function inventory, and no row in the trigger
--     inventory, whose explicit 0026 count is 4 functions / 4 statements /
--     0 definers. It is therefore NOT created: a trigger function that the
--     authoritative inventory does not list would itself be the defect.
--   * F14's function-inventory row states it is created in 0028, so 0026 must
--     not create it. F13 is likewise absent from the authoritative 0026
--     inventory and nothing in 0026 calls it. Historical "moved here from 0028"
--     wording in a deliverable table does not override the inventory.
--
--   0026's revoke half IS implemented, because 0001 installed
--   `ALTER DEFAULT PRIVILEGES ... GRANT SELECT, INSERT, UPDATE, DELETE ON
--   TABLES TO school_app_rw`, which means a table created here is born fully
--   writable by the runtime role. Every table and view below is therefore
--   revoked immediately, and only F4's EXECUTE is granted back -- F4 is the
--   sole write path, and the design states the grant in the F4 contract.
--
-- NOTE -- ratified corrections to the design's own SQL
-- Two normative inconsistencies were found in the design text and one in the
-- quarantined draft. All three were ratified before implementation:
--
--   N1  The design's F4 step 4a read
--          `IF NOT EXISTS (<legs that FAIL to mirror>) THEN RAISE 'do not mirror'`
--       which raises on an exact mirror and accepts a mismatch -- the sense is
--       inverted. This file uses the corrected form: an exact mirror is
--       accepted, any mismatch raises.
--
--   N2  A reversal group FLIPS debit/credit relative to its target while
--       preserving account, amount, student_id and invoice_id. The design's
--       mirror predicate compared `t.direction = n.direction`, which describes a
--       copy rather than a reversal; with nothing in the reporting layer
--       negating reversal groups, `invoice.issue` + `invoice.void` would have
--       doubled instead of netting to zero. Under this rule the plain
--       `SUM` in fin_v_ledger_account_balance is correct and the pair nets to
--       zero with no special case anywhere.
--
--   N3  The design's F4 step 1b verified the source row against the
--       catalogue's `source_table`, but the function never declared a
--       `v_src_table` variable nor selected `source_table`, so the step could
--       not execute. The quarantined draft "fixed" this by deleting step 1b
--       outright, which silently removed the check that makes `source_table`
--       authoritative. This file declares the variable, selects the column,
--       and keeps the check -- otherwise a caller could post against a source
--       row that does not exist.
--
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. fin_ledger_event_types -- the closed provenance catalogue
--
-- `event_type` is the ONLY provenance token a caller supplies. `source_type`,
-- `source_table` and the source-existence rule are looked up here, so
-- provenance cannot be re-stated by the caller and cannot drift from the
-- taxonomy. This is an owner-only relation: no runtime role may read or extend
-- it.
-- -----------------------------------------------------------------------------
CREATE TABLE fin_ledger_event_types (
    event_type    text PRIMARY KEY,
    source_type   text NOT NULL,
    source_table  text NOT NULL,
    -- A reversal event must carry reversal_of_group; an origin event must not.
    -- This is a property of the EVENT, enforced by F4 rather than by the caller.
    is_reversal   boolean NOT NULL,
    -- TRUE once source_table physically exists. Every row seeded below names a
    -- table created at or before 0026, which is what keeps 0026 free of a
    -- forward reference to a 0027 relation while still refusing an
    -- unverifiable source.
    source_exists boolean NOT NULL DEFAULT true,
    -- A reversal event is exactly a reversal SOURCE: the naming convention and
    -- the flag are two statements of one fact, so neither can drift from the
    -- other.
    CONSTRAINT fin_ledger_event_types_ck CHECK (
        (is_reversal AND source_type LIKE '%.reversal') OR
        (NOT is_reversal AND source_type NOT LIKE '%.reversal')
    )
);

-- The 0026 catalogue: exactly 10 events, every source table already created.
--
-- Two events are reversals (invoice.void, allocation.reverse,
-- adjustment.reverse) and seven are origins. Note that
--
--   * there is NO `invoice.adjustment` alongside `adjustment.post`: two
--     non-reversal origins on the same fin_invoice_adjustments row would be two
--     distinct keys in fin_leg_groups_origin_uq and the same adjustment could
--     therefore be posted twice.
--   * there is NO `reconciliation.post`: it would name fin_reconciliation_batches,
--     which is a 0027 relation.
INSERT INTO fin_ledger_event_types
    (event_type, source_type, source_table, is_reversal, source_exists)
VALUES
    -- 1. invoice.issue -> the receivable is raised against fee income.
    ('invoice.issue',        'invoice',                 'fin_invoices',            false, true),
    -- 2. invoice.void -> the reversal of an issue group; requires a target.
    ('invoice.void',         'invoice.void.reversal',   'fin_invoices',            true,  true),
    -- 3. payment.settled -> cash in against the receivable.
    ('payment.settled',      'payment',                 'fin_payments',            false, true),
    -- 4. allocation.apply -> an existing unapplied payment applied to an invoice.
    --    Also covers the on-account CREDIT shape (invoice_id IS NULL).
    ('allocation.apply',     'allocation',              'fin_payment_allocations', false, true),
    -- 5. allocation.reverse -> the reversal of an allocation (refund_id IS NULL).
    ('allocation.reverse',   'allocation.reversal',     'fin_payment_allocations', true,  true),
    -- 6. onaccount.return -> uncollected cash handed back. The effect lives on an
    --    ALLOCATION row, not on fin_payments.
    ('onaccount.return',     'onaccount.return',        'fin_payment_allocations', false, true),
    -- 7. adjustment.post -> an approved adjustment posts at creation.
    ('adjustment.post',      'adjustment',              'fin_invoice_adjustments', false, true),
    -- 8. adjustment.reverse -> a correction, which names what it undoes.
    ('adjustment.reverse',   'adjustment.reversal',     'fin_invoice_adjustments', true,  true),
    -- 9. refund.approved -> the first of the two refund legs.
    ('refund.approved',      'refund.approval',         'fin_refunds',             false, true),
    -- 10. refund.processed -> the second refund leg.
    ('refund.processed',     'refund.processed',        'fin_refunds',             false, true);

-- -----------------------------------------------------------------------------
-- 2. fin_ledger_entry_groups -- one posting header
-- -----------------------------------------------------------------------------
CREATE TABLE fin_ledger_entry_groups (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id         uuid NOT NULL,
    event_type        text NOT NULL,
    -- DELIBERATELY NOT a caller argument, and DELIBERATELY ABSENT from the
    -- idempotency key below. F4 derives it from fin_ledger_event_types, so a
    -- caller cannot mint a second origin for the same source by relabelling the
    -- provenance -- which is the entire point of deriving it.
    source_type       text NOT NULL,
    source_id         uuid NOT NULL,
    reversal_of_group uuid,
    -- Cached totals. These are never the proof of balance; they are kept honest
    -- by the deferred trigger, which recomputes from the legs.
    total_debit       numeric(19,4) NOT NULL DEFAULT 0,
    total_credit      numeric(19,4) NOT NULL DEFAULT 0,
    entry_count       integer,
    -- A group is inserted OPEN and sealed by a later UPDATE. sealed_at is
    -- write-once (trg_fin_ledger_seal) and no leg may join once it is set
    -- (trg_fin_ledger_sealed_group_reject).
    sealed_at         timestamptz,
    created_by        uuid,
    correlation_id    uuid,
    CONSTRAINT fin_leg_groups_reversal_fk
        FOREIGN KEY (tenant_id, reversal_of_group)
        REFERENCES fin_ledger_entry_groups (tenant_id, id) ON DELETE RESTRICT,
    -- The uniform tenant anchor every fin_* relation carries.
    CONSTRAINT fin_leg_groups_ten_id_uq UNIQUE (tenant_id, id),
    -- Only meaningful once sealed: an unsealed group is mid-write, and its
    -- totals are written by the deferred trigger rather than asserted here.
    CONSTRAINT fin_leg_groups_balanced_ck CHECK (
        sealed_at IS NULL OR (total_debit = total_credit AND entry_count IS NOT NULL)
    )
);

-- `posted_at` is deliberately NOT on the group. A group has no independent
-- posting instant: it is sealed by the same statement sequence that writes its
-- legs, and the legs' own posted_at is what every report reads. A second
-- timestamp on the header could disagree with its legs with no constraint able
-- to say which is right.

-- -----------------------------------------------------------------------------
-- 3. fin_ledger_entries -- the legs
--
-- `amount > 0` together with an explicit `direction` is the standard
-- representation, and it is what makes the balanced-group check a plain SUM
-- comparison. student_id / invoice_id are denormalised so AR aging can read the
-- LEDGER rather than the invoice table; because that is the point, both are
-- FK-backed, and an unconstrained denormalised column would be the opposite.
-- Both stay NULLABLE -- a leg can be a tenant-level posting with no student --
-- and a composite FK permits NULL.
-- -----------------------------------------------------------------------------
CREATE TABLE fin_ledger_entries (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id      uuid NOT NULL,
    entry_group_id uuid NOT NULL,
    account_code   text NOT NULL,
    direction      text NOT NULL,
    amount         numeric(19,4) NOT NULL,
    student_id     uuid,
    invoice_id     uuid,
    posted_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT fin_leg_entries_direction_ck CHECK (direction IN ('debit','credit')),
    CONSTRAINT fin_leg_entries_amount_positive_ck CHECK (amount > 0),
    -- Redundant against the check above, and named explicitly rather than
    -- folded into it: `amount <> 0` is the invariant the ledger relies on when
    -- it reasons about single-leg groups, and a constraint the reader can find
    -- by name is worth more than one fewer line of DDL.
    CONSTRAINT fin_leg_entries_nonzero_ck CHECK (amount <> 0),
    CONSTRAINT fin_leg_entries_group_fk
        FOREIGN KEY (tenant_id, entry_group_id)
        REFERENCES fin_ledger_entry_groups (tenant_id, id) ON DELETE RESTRICT,
    -- The business-key reference. fin_ledger_accounts carries
    -- UNIQUE (tenant_id, code) precisely so a leg may name an account by code.
    CONSTRAINT fin_leg_entries_account_fk
        FOREIGN KEY (tenant_id, account_code)
        REFERENCES fin_ledger_accounts (tenant_id, code),
    CONSTRAINT fin_leg_entries_student_fk
        FOREIGN KEY (tenant_id, student_id)
        REFERENCES students (tenant_id, id) ON DELETE RESTRICT,
    CONSTRAINT fin_leg_entries_invoice_fk
        FOREIGN KEY (tenant_id, invoice_id)
        REFERENCES fin_invoices (tenant_id, id) ON DELETE RESTRICT,
    CONSTRAINT fin_leg_entries_ten_id_uq UNIQUE (tenant_id, id)
);

-- -----------------------------------------------------------------------------
-- 4. Indexes
--
-- Conditional uniqueness is expressed as a partial UNIQUE INDEX, not as a
-- UNIQUE constraint: PostgreSQL does not accept a WHERE clause on a UNIQUE
-- constraint, and the intent here is specifically partial.
-- -----------------------------------------------------------------------------

-- IDEMPOTENCY (F-02): one origin group per business event per source row.
CREATE UNIQUE INDEX fin_leg_groups_origin_uq
    ON fin_ledger_entry_groups (tenant_id, event_type, source_id)
    WHERE reversal_of_group IS NULL;

-- ONE REVERSAL PER TARGET (F-03). Enforced by the index and not only by the
-- body: two concurrent reversal transactions both pass F4's SELECT ... FOR
-- UPDATE on the target, and the second must lose here.
CREATE UNIQUE INDEX fin_leg_groups_reversal_uq
    ON fin_ledger_entry_groups (tenant_id, reversal_of_group)
    WHERE reversal_of_group IS NOT NULL;

-- AR aging reads (tenant_id, student_id). Partial, because most legs are
-- tenant-level postings naming no student.
CREATE INDEX fin_leg_entries_ar_idx
    ON fin_ledger_entries (tenant_id, student_id, account_code)
    WHERE student_id IS NOT NULL;

-- -----------------------------------------------------------------------------
-- 5. Trigger functions
--
-- All four are SECURITY INVOKER: the 0026 definers count is zero. A trigger
-- that escalated to the owner would be a privilege the ledger grants itself,
-- and none of these four needs one -- the definer call in F4 is where the
-- elevation belongs, because F4 is the single write path.
--
-- search_path is pinned on every one, and EXECUTE is revoked from PUBLIC, so a
-- guard cannot be invoked outside a trigger or redirected through a hostile
-- schema.
-- -----------------------------------------------------------------------------

-- 5a. Deferred per-group balance proof.
--
-- CONSTRAINT + DEFERRABLE INITIALLY DEFERRED, so a whole group can be written
-- and the check runs at COMMIT. This is the ONE place the ledger's central
-- invariant is actually proven.
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
    -- AFTER INSERT OR UPDATE OR DELETE DEFERRABLE, so all three fire and DELETE
    -- leaves NEW unassigned.
    IF TG_OP = 'DELETE' THEN
        v_group_id := OLD.entry_group_id;
        v_tenant   := OLD.tenant_id;
    ELSE
        v_group_id := NEW.entry_group_id;
        v_tenant   := NEW.tenant_id;
    END IF;

    -- Recompute from the LEGS, not from the group's cached totals. Comparing
    -- the cached totals would only prove the seal statement was self
    -- consistent; a seal that miscounts both sides equally would pass.
    SELECT COALESCE(SUM(e.amount) FILTER (WHERE e.direction = 'debit'), 0),
           COALESCE(SUM(e.amount) FILTER (WHERE e.direction = 'credit'), 0),
           COUNT(*)
      INTO v_debits, v_credits, v_count
      FROM fin_ledger_entries e
     WHERE e.tenant_id = v_tenant AND e.entry_group_id = v_group_id;

    -- An empty group is vacuously balanced, and a one-leg group can never
    -- balance. Both are refused explicitly.
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

    -- Safe from a deferred CONSTRAINT TRIGGER, and that is why it lives here
    -- rather than in the seal statement: it fires at COMMIT, by which point the
    -- seal has run. Writing the totals from the trigger that VERIFIES them
    -- means the cached values can never be the reason verification passes.
    UPDATE fin_ledger_entry_groups
       SET total_debit = v_debits,
           total_credit = v_credits,
           entry_count = v_count
     WHERE tenant_id = v_tenant AND id = v_group_id;
    RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION trg_fin_ledger_group_balance() FROM PUBLIC;

-- 5b. Seal. A sealed group is frozen, for every role.
CREATE OR REPLACE FUNCTION trg_fin_ledger_seal() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
    -- sealed_at is WRITE-ONCE. Setting it for the first time is the seal;
    -- changing it afterwards is a rewrite, and un-sealing a group is how a
    -- balanced group becomes an unbalanced one with the evidence edited away.
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

    -- Sealing requires the cached totals to already agree, so the seal is where
    -- balance is asserted rather than after it. The deferred trigger recomputes
    -- the same values at COMMIT from the legs; this is the earlier of the two
    -- checks, and the deferred one is the authority.
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

-- 5c. Append-only. No UPDATE, no DELETE, no role exemption.
CREATE OR REPLACE FUNCTION trg_fin_ledger_append_only() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
    -- No GUC escape hatch and no `IF current_user = 'school_migrator'`. A GUC
    -- readable by a trigger expression is settable by the runtime role, and the
    -- migrator role is exactly the one a compromised migration holds.
    --
    -- DELETE lands here too: a BEFORE DELETE trigger that returned NULL would
    -- remove a ledger row without the statement ever failing and without the
    -- caller learning why.
    RAISE EXCEPTION 'ledger entries are append-only: % is not permitted', TG_OP
        USING ERRCODE = '55000';
END $$;
REVOKE ALL ON FUNCTION trg_fin_ledger_append_only() FROM PUBLIC;

-- 5d. A sealed group can never gain a leg. Written as a real function so the
-- statement is about code rather than a claim in prose.
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

-- -----------------------------------------------------------------------------
-- 6. Trigger bindings -- the 0026 inventory, exactly four statements
-- -----------------------------------------------------------------------------

-- AFTER INSERT OR UPDATE OR DELETE, deferred to COMMIT. Bound to the LEGS, not
-- to the group: the balance is a property of the legs, and the group's own
-- totals are what this trigger maintains.
DROP TRIGGER IF EXISTS fin_ledger_entries_balance ON fin_ledger_entries;
CREATE CONSTRAINT TRIGGER fin_ledger_entries_balance
    AFTER INSERT OR UPDATE OR DELETE ON fin_ledger_entries
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION trg_fin_ledger_group_balance();

DROP TRIGGER IF EXISTS fin_ledger_groups_seal ON fin_ledger_entry_groups;
CREATE TRIGGER fin_ledger_groups_seal
    BEFORE UPDATE ON fin_ledger_entry_groups
    FOR EACH ROW EXECUTE FUNCTION trg_fin_ledger_seal();

DROP TRIGGER IF EXISTS fin_ledger_entries_append_only ON fin_ledger_entries;
CREATE TRIGGER fin_ledger_entries_append_only
    BEFORE UPDATE OR DELETE ON fin_ledger_entries
    FOR EACH ROW EXECUTE FUNCTION trg_fin_ledger_append_only();

DROP TRIGGER IF EXISTS fin_ledger_entries_sealed_reject ON fin_ledger_entries;
CREATE TRIGGER fin_ledger_entries_sealed_reject
    BEFORE INSERT ON fin_ledger_entries
    FOR EACH ROW EXECUTE FUNCTION trg_fin_ledger_sealed_group_reject();

-- -----------------------------------------------------------------------------
-- 7. F4 -- post_fin_ledger_group, the single posting entry point
--
-- SECURITY DEFINER, owner school_migrator. This is the ONLY definer 0026
-- creates, and it is not optional: 0026 revokes INSERT on both ledger tables
-- from the runtime role, so an INVOKER function would raise 42501 for every
-- caller and the ledger would be unpostable.
--
-- The compensation for that elevation is mechanical rather than a promise. The
-- function accepts no free-form SQL, takes its lines as jsonb data, and every
-- element is validated -- shape, account in the tenant's chart, amount > 0,
-- direction in the enum, sum(debits) = sum(credits), tenant equality of every
-- student_id / invoice_id -- BEFORE any row is inserted. A caller who can
-- EXECUTE this can post a balanced, attributed, correctly-tenanted group and
-- nothing else.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION post_fin_ledger_group(
    p_tenant_id         uuid,
    p_event_type        text,
    p_source_id         uuid,
    p_lines             jsonb,
    p_reversal_of_group uuid DEFAULT NULL
) RETURNS uuid
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    v_tenant    uuid := app_current_tenant_id();
    v_group     uuid := gen_random_uuid();
    v_debit     numeric(19,4) := 0;
    v_credit    numeric(19,4) := 0;
    v_el        jsonb;
    v_acct      text;
    v_dir       text;
    v_amt       numeric(19,4);
    v_stu       uuid;
    v_inv       uuid;
    v_src_type  text;
    v_src_table text;
    v_is_reversal boolean;
    v_found     integer;
BEGIN
    -- 0. TENANT GATE. Two distinct failures, two distinct tests, in this order.
    --
    --    0a. A runtime caller with NO tenant in session. The predicate must
    --        name the LOGIN, not the effective user: F4 is SECURITY DEFINER, so
    --        inside this body current_user is the owner, and any privilege test
    --        reading current_user returns TRUE for every caller including the
    --        runtime role. A session with no tenant would therefore sail past,
    --        and since the mismatch test below is guarded by
    --        `v_tenant IS NOT NULL` the whole cross-check would be skipped.
    IF v_tenant IS NULL AND session_user <> 'school_migrator' THEN
        RAISE EXCEPTION 'ledger posting requires a tenant-scoped session'
            USING ERRCODE = '42501';
    END IF;

    -- 0b. A tenant in session that disagrees with the argument.
    IF v_tenant IS NOT NULL AND v_tenant IS DISTINCT FROM p_tenant_id THEN
        RAISE EXCEPTION 'ledger tenant % does not match the session tenant %',
            p_tenant_id, v_tenant USING ERRCODE = '55000';
    END IF;

    -- 1. PROVENANCE (F-02). The caller names the EVENT; the catalogue names the
    --    SOURCE. An unknown event_type is refused outright -- there is no
    --    fallback to whatever the caller felt like typing, which is what made a
    --    free-form source_type relabellable.
    SELECT e.source_type, e.is_reversal, e.source_table
      INTO v_src_type, v_is_reversal, v_src_table
      FROM fin_ledger_event_types e
     WHERE e.event_type = p_event_type;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'event_type % is not in the ledger event catalogue',
            p_event_type USING ERRCODE = '55000';
    END IF;

    -- 1a. Reversal linkage is a property of the EVENT, not of the argument. A
    --     reversal event with no target, or an origin event that names one, are
    --     both refused. A four-argument call can never reach the first branch,
    --     because p_reversal_of_group defaults to NULL.
    IF v_is_reversal AND p_reversal_of_group IS NULL THEN
        RAISE EXCEPTION 'event % is a reversal and requires reversal_of_group',
            p_event_type USING ERRCODE = '55000';
    END IF;
    IF NOT v_is_reversal AND p_reversal_of_group IS NOT NULL THEN
        RAISE EXCEPTION 'event % is not a reversal and must not name a target group',
            p_event_type USING ERRCODE = '55000';
    END IF;

    -- 1b. The source row must exist, in THIS tenant. The catalogue's
    --     source_table is a bare identifier, so the lookup is built as text and
    --     no caller-controlled SQL is ever formed -- this reads a catalogue
    --     value, not an argument.
    IF EXISTS (SELECT 1 FROM fin_ledger_event_types e
                WHERE e.event_type = p_event_type AND e.source_exists) THEN
        EXECUTE format('SELECT 1 FROM %I WHERE tenant_id = $1 AND id = $2',
                       v_src_table)
           INTO v_found USING p_tenant_id, p_source_id;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'source % % does not exist in tenant %',
                v_src_type, p_source_id, p_tenant_id USING ERRCODE = '55000';
        END IF;
    END IF;

    -- 1c. The reversal target must be sealed, in this tenant, and not already
    --     reversed. Tenant equality is already carried by
    --     fin_leg_groups_reversal_fk, so a cross-tenant target raises 23503
    --     even if this were skipped; this is for the two conditions the FK
    --     cannot express.
    IF p_reversal_of_group IS NOT NULL THEN
        PERFORM 1 FROM fin_ledger_entry_groups g
         WHERE g.tenant_id = p_tenant_id
           AND g.id = p_reversal_of_group
           AND g.sealed_at IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM fin_ledger_entry_groups r
                            WHERE r.reversal_of_group = g.id)
           FOR UPDATE OF g;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'reversal target % is absent, unsealed, or already reversed',
                p_reversal_of_group USING ERRCODE = '55000';
        END IF;
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
        -- Tenant equality of every attributed element, stated here so a
        -- violation is a 55000 with no row written rather than a 23503 after the
        -- header exists.
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

    -- 4a. A reversal must mirror its target, FLIPPING direction.
    --
    --     Account, amount, student_id and invoice_id must match exactly, and
    --     each target debit must be answered by a reversal credit and each
    --     target credit by a reversal debit. Without the flip a "reversal"
    --     would be a copy, and with nothing in the reporting layer negating
    --     reversal groups an issue plus its void would double rather than net to
    --     zero.
    --
    --     The sense matters: the subquery below yields the legs that FAIL to
    --     mirror, so a NON-EMPTY result is the failure. (The design text had
    --     this inverted -- it raised on an exact mirror and accepted a
    --     mismatch -- which was ratified and corrected as N1.)
    IF p_reversal_of_group IS NOT NULL THEN
        IF EXISTS (
            SELECT 1
              FROM (SELECT account_code, direction, amount, student_id, invoice_id
                      FROM fin_ledger_entries WHERE tenant_id = p_tenant_id
                       AND entry_group_id = p_reversal_of_group) AS t
              FULL JOIN (SELECT account_code, direction, amount, student_id, invoice_id
                           FROM jsonb_to_recordset(p_lines) AS x(
                             account_code text, direction text, amount numeric(19,4),
                             student_id uuid, invoice_id uuid)) AS n
                ON t.account_code = n.account_code
               AND t.amount = n.amount
               AND t.student_id IS NOT DISTINCT FROM n.student_id
               AND t.invoice_id IS NOT DISTINCT FROM n.invoice_id
               AND ((t.direction = 'debit'  AND n.direction = 'credit')
                 OR (t.direction = 'credit' AND n.direction = 'debit'))
             WHERE t.account_code IS NULL OR n.account_code IS NULL)
        THEN
            RAISE EXCEPTION 'reversal legs do not mirror target group %',
                p_reversal_of_group USING ERRCODE = '55000';
        END IF;
    END IF;

    -- 5. Header, UNSEALED. sealed_at stays NULL so the balanced CHECK is not
    --    yet in force and the legs below are not rejected by
    --    sealed_group_reject. source_type comes from the catalogue (step 1),
    --    never from an argument.
    INSERT INTO fin_ledger_entry_groups (
        id, tenant_id, event_type, source_type, source_id, reversal_of_group,
        total_debit, total_credit, entry_count, created_by)
    VALUES (
        v_group, p_tenant_id, p_event_type, v_src_type, p_source_id, p_reversal_of_group,
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

    -- 7. Seal. This is the first write of sealed_at, which
    --    trg_fin_ledger_seal accepts, and after which no leg may join and no row
    --    may be edited. Insert-then-seal is the only order that works.
    UPDATE fin_ledger_entry_groups
       SET sealed_at = now()
     WHERE tenant_id = p_tenant_id AND id = v_group;

    RETURN v_group;
END $$;
REVOKE ALL ON FUNCTION post_fin_ledger_group(uuid, text, uuid, jsonb, uuid) FROM PUBLIC;

-- -----------------------------------------------------------------------------
-- 8. Views
-- -----------------------------------------------------------------------------

-- V1: security_invoker = on, because it is row-level. A definer view here would
-- hand every authenticated session every tenant's ledger.
--
-- The view deliberately does NOT filter on sealed_at: a balance that excluded
-- unsealed groups would change the moment a group was written, so a trial
-- balance would not be reproducible across a run. Under N2 a reversal group is
-- an ordinary set of flipped legs, so this plain SUM needs no special case to
-- net an origin and its reversal to zero.
CREATE VIEW fin_v_ledger_account_balance WITH (security_invoker = on) AS
SELECT e.tenant_id,
       e.account_code,
       COALESCE(sum(e.amount) FILTER (WHERE e.direction = 'debit'), 0)  AS total_debit,
       COALESCE(sum(e.amount) FILTER (WHERE e.direction = 'credit'), 0) AS total_credit,
       COALESCE(sum(e.amount) FILTER (WHERE e.direction = 'debit'), 0)
     - COALESCE(sum(e.amount) FILTER (WHERE e.direction = 'credit'), 0) AS balance
  FROM fin_ledger_entries e
 GROUP BY e.tenant_id, e.account_code;

-- V2: the four aggregate views. Owner-scoped -- NO security_invoker -- so base
-- table RLS does not apply and a principal can see aggregates without holding
-- SELECT on the detail tables. The safety is in the OUTPUT SHAPE: buckets,
-- totals and counts, plus the taxonomy id, and the tenant is pinned in both the
-- projection and the WHERE.

-- 1. AR aging, in the five contract buckets.
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

-- 2. Collections summary. Counts and sums only; `channel` is a taxonomy label
--    from a closed domain, so it discloses nothing about a person.
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

-- 3. Fee-head revenue. fee_head_id / _code / _name are TAXONOMY (a published
--    price-list line), not a person, and are the permitted exception to the
--    no-id rule.
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

-- 4. On-account summary. One row per tenant: the total advance held. A payment
--    with no invoice-naming allocation is unspent on account.
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

-- -----------------------------------------------------------------------------
-- 9. Privileges
--
-- 0001 installed `ALTER DEFAULT PRIVILEGES ... GRANT SELECT, INSERT, UPDATE,
-- DELETE ON TABLES TO school_app_rw`, so every relation created above was born
-- fully writable by the runtime role. Direct INSERT on a ledger leg is the
-- thing that must stay unavailable: a runtime role that can write one can write
-- an unbalanced or unattributed leg, and the single posting entry point becomes
-- advisory. The final runtime grant set is 0028's; this migration only closes.
-- -----------------------------------------------------------------------------
REVOKE ALL ON fin_ledger_event_types   FROM school_app_rw;
REVOKE ALL ON fin_ledger_event_types   FROM PUBLIC;
REVOKE ALL ON fin_ledger_entry_groups FROM school_app_rw;
REVOKE ALL ON fin_ledger_entry_groups FROM PUBLIC;
REVOKE ALL ON fin_ledger_entries      FROM school_app_rw;
REVOKE ALL ON fin_ledger_entries      FROM PUBLIC;

REVOKE ALL ON fin_v_ledger_account_balance FROM school_app_rw;
REVOKE ALL ON fin_v_ledger_account_balance FROM PUBLIC;
REVOKE ALL ON fin_v_ar_aging             FROM school_app_rw;
REVOKE ALL ON fin_v_ar_aging             FROM PUBLIC;
REVOKE ALL ON fin_v_collections_summary  FROM school_app_rw;
REVOKE ALL ON fin_v_collections_summary  FROM PUBLIC;
REVOKE ALL ON fin_v_fee_head_revenue     FROM school_app_rw;
REVOKE ALL ON fin_v_fee_head_revenue     FROM PUBLIC;
REVOKE ALL ON fin_v_on_account_summary   FROM school_app_rw;
REVOKE ALL ON fin_v_on_account_summary   FROM PUBLIC;

-- F4 is the one capability handed to the runtime role by 0026: it validates,
-- then writes, then seals. `school_migrator` retains EXECUTE by ownership, and
-- is named here because the static test asserts the grant rather than inferring
-- it. No table INSERT/UPDATE/DELETE is granted anywhere in this migration.
GRANT EXECUTE ON FUNCTION post_fin_ledger_group(uuid, text, uuid, jsonb, uuid) TO school_app_rw;