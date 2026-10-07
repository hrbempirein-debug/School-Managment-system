-- =============================================================================
-- 0025_refund_provenance_remediation.sql
--
-- WHAT
-- Forward-only remediation of ONE function: trg_fin_refund_provenance.
--
-- Three canonical targets are reconciled in a single CREATE OR REPLACE, because
-- all three live in the same function body and splitting them would leave the
-- function half-remediated between migrations:
--
--   R1 / D2B   trg_fin_refund_provenance is SECURITY INVOKER.
--   R3         a reversal allocation may only target an allocation whose
--              effect = 'apply'.
--   R4         the named refund must be in a reversible status, i.e.
--              status IN ('requested','approved'), at link creation.
--
-- The applied 0025_lock_model_remediation.sql already declares SECURITY INVOKER,
-- so R1 is a no-op against a catalog that ran it. It is restated here anyway,
-- because the point of R1 is REPRODUCIBILITY: 0025_fin_refunds.sql (immutable)
-- declares SECURITY DEFINER, and a reader replaying the immutable history alone
-- would derive the wrong definership. Restating it in the forward tail makes
-- 0021..0025..this file derive INVOKER, and makes the invariant asserted rather
-- than incidental.
--
-- WHY THIS FILE DOES NOT TOUCH fin_refunds_status_check
-- fin_refunds.status is a FOUR-state vocabulary: requested, approved, rejected,
-- processed. That is what 0025_fin_refunds.sql declares (fin_refunds_status_check
-- and the four-arm fin_refunds_decision_ck) and what the authoritative design
-- declares. rejected and processed are reached by postRefundApproval /
-- postRefundProcess (F11 / F12), which are 0028's and are NOT created here.
--
-- R4 is therefore NOT a table vocabulary restriction. It is the link-creation
-- invariant: at the moment a reversal allocation is attached to a refund, that
-- refund must be in a reversible state. Narrowing the column to two states would
-- make approved -> processed and requested -> rejected unrepresentable and would
-- break 0028-owned behaviour; this file therefore leaves the column alone and
-- adds only the check the design specifies at the link.
--
-- D2 IS PRESERVED, NOT REVERSED
-- The refund-side branch removed by 0025_lock_model_remediation.sql stays
-- removed. This file adds NO scan of fin_payment_allocations keyed on a refund
-- id, and NO FOR UPDATE over that branch. The only allocation-side lock this
-- function now holds is the one for the reversal target, which is a DIFFERENT
-- lookup (keyed on reversal_of_allocation_id, inside the allocation's own row
-- path) and is the canonical mechanism for R3.
--
-- LOCK ORDER
-- trg_fin_refund_provenance is the ONLY trigger on fin_payment_allocations that
-- takes FOR UPDATE on that table; the seven other BEFORE triggers take none, and
-- the two payment triggers reach a row lock exclusively through
-- fin_lock_payment_amount (D2C). So the effective order is
--     payment row  ->  refund row  ->  reversal target allocation row
-- and it is consistent for every caller. Appending the target lookup AFTER the
-- existing refund lookup preserves that prefix; no other code path locks an
-- allocation row, so no cycle can be introduced. The authoritative design's
-- canonical excerpt happens to resolve the target before the refund, but it
-- states no lock-order requirement, and both orderings are TOCTOU-safe within
-- this single lock-taking path.
--
-- IDEMPOTENCE
-- The runner skips applied filenames, so this executes once. CREATE OR REPLACE
-- and REVOKE are idempotent, and the postcondition block only reads the catalog.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. trg_fin_refund_provenance -- R1 + R3 + R4
--
-- Checks 1-3 are the applied body's, retained verbatim in message and SQLSTATE
-- so no existing error contract moves. Checks 4 and 5 are new.
--
-- Ordering note for check 4: fin_pa_effect_ck admits a 'reverse' row only when
-- reversal_of_allocation_id IS NOT NULL, so by the time check 3 has confirmed
-- effect = 'reverse' the target id is guaranteed non-null at the CHECK layer. A
-- BEFORE trigger still sees the pre-CHECK row, so a hand-written
-- reverse-without-target is caught by NOT FOUND below rather than by the CHECK,
-- which is the correct and safe outcome either way.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trg_fin_refund_provenance()
    RETURNS trigger
    LANGUAGE plpgsql
    SECURITY INVOKER
    SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    v_refund fin_refunds;
    v_target fin_payment_allocations;
BEGIN
    IF TG_TABLE_NAME = 'fin_payment_allocations' THEN
        IF NEW.refund_id IS NOT NULL THEN

            -- (1) the named refund must exist in this tenant, locked
            SELECT * INTO v_refund
              FROM fin_refunds r
             WHERE r.tenant_id = NEW.tenant_id
               AND r.id = NEW.refund_id
             FOR UPDATE;

            IF NOT FOUND THEN
                RAISE EXCEPTION 'refund % not found in tenant % for allocation %',
                    NEW.refund_id, NEW.tenant_id, NEW.id
                    USING ERRCODE = '55000';
            END IF;

            -- (2) allocation and refund must name the same payment
            IF NEW.payment_id IS DISTINCT FROM v_refund.payment_id THEN
                RAISE EXCEPTION
                    'allocation % payment_id % does not match refund % payment_id %',
                    NEW.id, NEW.payment_id, v_refund.id, v_refund.payment_id
                    USING ERRCODE = '55000';
            END IF;

            -- (3) a refund-linked allocation is a reversal
            IF NEW.effect <> 'reverse' THEN
                RAISE EXCEPTION 'allocation % referencing refund must have effect = ''reverse''',
                    NEW.id
                    USING ERRCODE = '55000';
            END IF;

            -- (4) R3 -- the reversal target must exist in this tenant, must sit on
            -- the same payment as the refund, and must be an APPLIED allocation.
            -- The lock makes this TOCTOU-safe: a concurrent UPDATE cannot move
            -- the target's payment_id or flip its effect between this check and
            -- the write. Without it, "effect = 'apply'" is a fact about a moment
            -- that has already passed.
            SELECT * INTO v_target
              FROM fin_payment_allocations
             WHERE tenant_id = NEW.tenant_id
               AND id = NEW.reversal_of_allocation_id
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

            -- (5) R4 -- the refund must be in a reversible state AT LINK CREATION.
            -- This is a link-time condition, not a column vocabulary: a refund may
            -- legitimately later be approved and processed by 0028's F11/F12, and
            -- this row's status was read under the lock taken at (1).
            IF v_refund.status NOT IN ('requested','approved') THEN
                RAISE EXCEPTION 'a reversal may only be created for a requested or approved refund'
                    USING ERRCODE = '55000';
            END IF;
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

ALTER FUNCTION trg_fin_refund_provenance() OWNER TO school_migrator;

-- Owner-only EXECUTE. Invoked exclusively through its two triggers.
REVOKE ALL ON FUNCTION trg_fin_refund_provenance() FROM PUBLIC;

-- -----------------------------------------------------------------------------
-- 2. Postconditions -- fail closed.
--
-- Three independent passes over the body, because each catches a different
-- regression: exact presence of the new checks, exact absence of the removed
-- D2 scan, and the definership/ownership/ACL posture.
-- -----------------------------------------------------------------------------
DO $assert$
DECLARE
    v_body    text;
    v_isdef   boolean;
    v_owner   text;
    v_config  text[];
    v_bind    integer;
    v_ceiling text;
BEGIN
    SELECT p.prosecdef, p.prosrc,
           pg_get_userbyid(p.proowner), p.proconfig
      INTO v_isdef, v_body, v_owner, v_config
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname = 'trg_fin_refund_provenance';

    IF v_body IS NULL THEN
        RAISE EXCEPTION
            '0025_refund_provenance_remediation failed: trg_fin_refund_provenance does not exist';
    END IF;

    ------------------------------------------------------------------- R1
    IF v_isdef IS NOT FALSE THEN
        RAISE EXCEPTION
            '0025_refund_provenance_remediation failed: trg_fin_refund_provenance is not SECURITY INVOKER (prosecdef = %)',
            coalesce(v_isdef::text, 'null');
    END IF;

    IF v_owner <> 'school_migrator' THEN
        RAISE EXCEPTION
            '0025_refund_provenance_remediation failed: trg_fin_refund_provenance is owned by %, expected school_migrator',
            v_owner;
    END IF;

    IF v_config IS DISTINCT FROM ARRAY['search_path=pg_catalog, public, pg_temp'] THEN
        RAISE EXCEPTION
            '0025_refund_provenance_remediation failed: search_path is %s, expected pg_catalog, public, pg_temp',
            coalesce(array_to_string(v_config, ','), '(unset)');
    END IF;

    IF has_function_privilege('school_app_rw',
                              'public.trg_fin_refund_provenance()', 'EXECUTE') THEN
        RAISE EXCEPTION
            '0025_refund_provenance_remediation failed: school_app_rw may EXECUTE trg_fin_refund_provenance';
    END IF;

    ------------------------------------------------------------------- R3
    IF v_body !~* 'reversal_of_allocation_id' THEN
        RAISE EXCEPTION
            '0025_refund_provenance_remediation failed: body does not resolve reversal_of_allocation_id; R3 cannot be enforced';
    END IF;

    IF v_body !~* 'v_target\.effect\s*<>\s*''apply''' THEN
        RAISE EXCEPTION
            '0025_refund_provenance_remediation failed: body lacks the effect = ''apply'' reversal-target check';
    END IF;

    IF v_body !~* 'reversal target allocation does not exist in this tenant' THEN
        RAISE EXCEPTION
            '0025_refund_provenance_remediation failed: body lacks the reversal-target existence check';
    END IF;

    IF v_body !~* 'v_target\.payment_id\s+is\s+distinct\s+from\s+new\.payment_id' THEN
        RAISE EXCEPTION
            '0025_refund_provenance_remediation failed: body lacks the target/reversal same-payment check';
    END IF;

    -- The target must be locked, or the check reads a stale fact.
    IF v_body !~* 'into\s+v_target\s+from\s+fin_payment_allocations[\s\S]*?for\s+update' THEN
        RAISE EXCEPTION
            '0025_refund_provenance_remediation failed: the reversal target is not locked FOR UPDATE; the effect check would be TOCTOU-racy';
    END IF;

    ------------------------------------------------------------------- R4
    IF v_body !~* 'v_refund\.status\s+not\s+in\s*\(\s*''requested''\s*,\s*''approved''\s*\)' THEN
        RAISE EXCEPTION
            '0025_refund_provenance_remediation failed: body lacks the requested/approved link-creation status check';
    END IF;

    IF v_body !~* 'a reversal may only be created for a requested or approved refund' THEN
        RAISE EXCEPTION
            '0025_refund_provenance_remediation failed: body lacks the canonical link-creation status error';
    END IF;

    ------------------------------------------------- pre-existing guarantees
    IF v_body !~* 'payment_id\s+is\s+distinct\s+from\s+v_refund\.payment_id' THEN
        RAISE EXCEPTION
            '0025_refund_provenance_remediation failed: body lost the allocation/refund payment agreement check';
    END IF;

    IF v_body !~* 'new\.effect\s*<>\s*''reverse''' THEN
        RAISE EXCEPTION
            '0025_refund_provenance_remediation failed: body lost the effect = ''reverse'' requirement';
    END IF;

    IF v_body !~* 'refund\s+%\s+not\s+found\s+in\s+tenant' THEN
        RAISE EXCEPTION
            '0025_refund_provenance_remediation failed: body lost the refund existence check';
    END IF;

    ------------------------------------------------------------- D2 kept
    -- D2 stays decided: the refund-side scan must NOT come back. It is
    -- characterised by looking up allocations keyed on the refund's own id.
    IF v_body ~* 'per\s+perform\s+1[\s\S]*?from\s+fin_payment_allocations' THEN
        RAISE EXCEPTION
            '0025_refund_provenance_remediation failed: the D2 refund-side scan has been reintroduced';
    END IF;

    IF v_body ~* '\bv_stray\b' THEN
        RAISE EXCEPTION
            '0025_refund_provenance_remediation failed: v_stray has been reintroduced';
    END IF;

    -- The branch is gone, so the function must still lock what it validates:
    -- one refund row and one reversal target. Exactly two FOR UPDATE sites, so a
    -- third scan cannot hide inside the same body.
    SELECT count(*) INTO v_bind
      FROM regexp_matches(v_body, 'for\s+update', 'gi');

    IF v_bind <> 2 THEN
        RAISE EXCEPTION
            '0025_refund_provenance_remediation failed: expected exactly 2 FOR UPDATE lock sites (refund + reversal target), found %',
            v_bind;
    END IF;

    IF v_body ~* '\bexecute\s+(format|immediate)\b|\mexecute\M' THEN
        RAISE EXCEPTION
            '0025_refund_provenance_remediation failed: body contains dynamic SQL';
    END IF;

    IF v_body ~* '\mgrant\M|\brevoke\M|\bcreate\M|\balter\M|\bdrop\M' THEN
        RAISE EXCEPTION
            '0025_refund_provenance_remediation failed: body contains DDL or a privilege statement';
    END IF;

    -- Tenant scoping: every lookup must conjunct on tenant_id = NEW.tenant_id.
    -- A missing conjunct here would let one tenant's refund or target be matched.
    SELECT count(*) INTO v_bind
      FROM regexp_matches(v_body, 'tenant_id\s*=\s*NEW\.tenant_id', 'gi');

    IF v_bind < 2 THEN
        RAISE EXCEPTION
            '0025_refund_provenance_remediation failed: expected at least 2 tenant-scoped lookups, found %; a lookup is not tenant-constrained',
            v_bind;
    END IF;

    ------------------------------------------------------- trigger bindings
    -- R1 requires the bindings to be preserved. Exactly one binding per table,
    -- so no duplicate enforcement point is introduced on either side.
    FOR v_ceiling IN
        SELECT c.relname
          FROM pg_trigger tg
          JOIN pg_class c ON c.oid = tg.tgrelid
          JOIN pg_proc p ON p.oid = tg.tgfoid
          JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public'
           AND p.proname = 'trg_fin_refund_provenance'
           AND NOT tg.tgisinternal
           AND c.relname IN ('fin_refunds', 'fin_payment_allocations')
         GROUP BY c.relname
        HAVING count(*) <> 1
    LOOP
        RAISE EXCEPTION
            '0025_refund_provenance_remediation failed: % has a non-unique trg_fin_refund_provenance binding',
            v_ceiling;
    END LOOP;

    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger tg
          JOIN pg_class c ON c.oid = tg.tgrelid
          JOIN pg_proc p ON p.oid = tg.tgfoid
          JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public'
           AND p.proname = 'trg_fin_refund_provenance'
           AND NOT tg.tgisinternal
           AND c.relname = 'fin_payment_allocations'
    ) THEN
        RAISE EXCEPTION
            '0025_refund_provenance_remediation failed: the fin_payment_allocations binding is gone; R3/R4 would never run';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger tg
          JOIN pg_class c ON c.oid = tg.tgrelid
          JOIN pg_proc p ON p.oid = tg.tgfoid
          JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public'
           AND p.proname = 'trg_fin_refund_provenance'
           AND NOT tg.tgisinternal
           AND c.relname = 'fin_refunds'
    ) THEN
        RAISE EXCEPTION
            '0025_refund_provenance_remediation failed: the fin_refunds binding is gone; R1 requires trigger bindings preserved';
    END IF;
END
$assert$;

COMMIT;