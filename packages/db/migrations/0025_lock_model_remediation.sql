-- =============================================================================
-- 0025_lock_model_remediation.sql
--
-- WHAT
-- Forward-only remediation of the Phase 7 lock model. Creates exactly one
-- internal helper and rewrites three already-applied trigger function BODIES.
-- Nothing here creates a table, a trigger, a policy, or a privilege.
--
-- Creates:
--   fin_lock_payment_amount(uuid, uuid) - internal trigger helper (D2C)
--
-- Replaces (CREATE OR REPLACE, same name/signature/arity):
--   trg_fin_allocation_bounds()          - delegates its row lock to the helper
--   trg_fin_on_account_return_bounds()   - delegates its row lock to the helper
--   trg_fin_refund_provenance()          - drops the vacuous refund-side scan
--
-- WHY
--
-- D2C -- the payment-side lock is load-bearing and cannot stay where it is.
--   trg_fin_allocation_bounds and trg_fin_on_account_return_bounds each ran
--       SELECT amount FROM fin_payments WHERE tenant_id = .. AND id = ..
--       ORDER BY id FOR UPDATE
--   as SECURITY INVOKER. PostgreSQL grants SELECT ... FOR UPDATE only to a
--   role holding UPDATE on the table (or on at least one locked column).
--   school_app_rw holds NO UPDATE on fin_payments anywhere -- §35.4 revokes it
--   deliberately -- so that statement raises 42501 at the first allocation.
--   The lock is FI-003's entire serialisation mechanism; it cannot be dropped,
--   and granting UPDATE on fin_payments.amount would hand the runtime role the
--   cached-column write that §16.5.1 withholds and that F5d's five definers
--   exist to protect.
--
--   The lock therefore moves behind one SECURITY DEFINER helper. Both call
--   sites need exactly the same thing -- the payment's `amount`, locked, for an
--   explicit (tenant_id, id) pair -- which is why this is ONE helper and not
--   two. That is §16.5.2's existing row-4 pattern: the elevation lives on the
--   boundary of the bound function and the unbound callee inherits it, so both
--   triggers remain SECURITY INVOKER and neither widens its own privilege.
--
-- D2 -- the refund-side scan is vacuous and is removed.
--   trg_fin_refund_provenance's fin_refunds branch scanned
--   fin_payment_allocations for rows carrying NEW.id with a mismatched
--   payment_id, under FOR UPDATE, at BEFORE INSERT OR UPDATE.
--   fin_pa_refund_fk is NOT DEFERRABLE, so an allocation can never reference a
--   refund that is not already committed, and at BEFORE INSERT the NEW.id is a
--   freshly generated uuid that no allocation references. The scan therefore
--   returns zero rows on every reachable path and cannot fail: it was a lock
--   with nothing to lock. The branch additionally repeated the identical
--   predicate a second time as PERFORM 1 ... LIMIT 1 followed by IF FOUND /
--   RAISE, which is unreachable behind the FOR-loop that precedes it and raises
--   on the same condition with a different message.
--   Both are removed. The meaningful provenance checks -- the ALLOCATION-side
--   branch, which locks and validates the refund an allocation names, and the
--   payment_id / effect='reverse' agreement -- are retained unchanged.
--
-- SECURITY MODEL of the helper
--   SECURITY DEFINER, owned by school_migrator, VOLATILE (a row lock is a side
--   effect that must happen exactly once per invocation), hardened
--   search_path, EXECUTE revoked from PUBLIC and never granted to
--   school_app_rw. It is reachable only through the two bound trigger
--   functions above. It reads one column and takes one row lock; it performs
--   no INSERT, no UPDATE, no DELETE, no DDL, and contains no dynamic SQL and no
--   caller-controlled identifier. The (tenant_id, id) predicate is MANDATORY:
--   as a definer it reads outside RLS, so an omitted tenant conjunct would let
--   it lock another tenant's payment row. The caller supplies the tenant
--   explicitly; the helper never infers it.
--
-- IDEMPOTENCE
--   The runner records applied filenames and skips them, so this file executes
--   once. Its own statements are nonetheless re-runnable: CREATE OR REPLACE
--   and REVOKE are both idempotent, matching 0021-0025.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. fin_lock_payment_amount -- the single shared lock helper (D2C / C2-B)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fin_lock_payment_amount(
    p_tenant_id uuid,
    p_payment_id uuid
)
    RETURNS numeric
    LANGUAGE plpgsql
    VOLATILE
    SECURITY DEFINER
    SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    v_amount numeric(19,4);
BEGIN
    -- The ONLY statement in this function. FOR UPDATE is what serialises two
    -- concurrent allocations against the same payment, so it must be issued
    -- HERE rather than in the caller: a caller-side PERFORM of a helper that
    -- did not lock would serialise nothing.
    --
    -- Returning fin_payments.amount also serves both callers, which need the
    -- payment total to evaluate their own bound. amount is NOT NULL, so a NULL
    -- return unambiguously means "no such payment in this tenant", which is how
    -- each trigger preserves its own pre-existing error message.
    SELECT fin_payments.amount INTO v_amount
      FROM fin_payments
     WHERE fin_payments.tenant_id = p_tenant_id
       AND fin_payments.id = p_payment_id
     FOR UPDATE;

    RETURN v_amount;
END;
$$;

ALTER FUNCTION fin_lock_payment_amount(uuid, uuid) OWNER TO school_migrator;

-- Internal helper: no PUBLIC EXECUTE, and deliberately NO grant to
-- school_app_rw. A runtime EXECUTE grant would turn a row lock into a
-- caller-directed lock primitive against any payment whose (tenant_id, id) the
-- caller can name, which is exactly the capability F13's no-oracle rule and
-- §19.7.2's grant table exist to withhold.
REVOKE ALL ON FUNCTION fin_lock_payment_amount(uuid, uuid) FROM PUBLIC;

-- -----------------------------------------------------------------------------
-- 2. trg_fin_allocation_bounds -- delegate the lock (D2B preserved)
--
-- Every other behaviour is byte-for-byte the applied 0024 body: the
-- refund_id early return, the SUM over sibling allocations excluding NEW.id,
-- the FI-003 comparison, the 55000 SQLSTATE and both error messages, and
-- tenant scoping on every statement. SECURITY INVOKER is now stated explicitly;
-- it was already the effective mode (the default) and stating it makes the
-- invariant auditable rather than incidental.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trg_fin_allocation_bounds() RETURNS trigger
    LANGUAGE plpgsql
    SECURITY INVOKER
    SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE v_payment_amount numeric(19,4); v_committed numeric(19,4);
BEGIN
    IF NEW.refund_id IS NOT NULL THEN
        RETURN NEW;
    END IF;

    -- One lock acquisition, and it happens inside the helper.
    v_payment_amount := fin_lock_payment_amount(NEW.tenant_id, NEW.payment_id);
    IF v_payment_amount IS NULL THEN
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
ALTER FUNCTION trg_fin_allocation_bounds() OWNER TO school_migrator;
REVOKE ALL ON FUNCTION trg_fin_allocation_bounds() FROM PUBLIC;

-- -----------------------------------------------------------------------------
-- 3. trg_fin_on_account_return_bounds -- delegate the lock
--
-- The DEVIATION comment recorded in 0024 against §13.3.2's literal
-- payment_returnable() formula is PRESERVED and still governs: what may be
-- returned is the UNAPPLIED remainder less anything already returned, so
--     v_held := v_paid - v_applied + v_returned
-- is unchanged, as is the one-sided NEW.amount + v_held < 0 bound, the
-- a.id <> NEW.id exclusion that keeps an in-place correction from double
-- counting the row's own OLD value, and the 55000 SQLSTATE with both messages.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trg_fin_on_account_return_bounds() RETURNS trigger
    LANGUAGE plpgsql
    SECURITY INVOKER
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
    v_paid := fin_lock_payment_amount(NEW.tenant_id, NEW.payment_id);
    IF v_paid IS NULL THEN
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
    -- evaluate -60,000 + (-40,000) = -100,000 < 0 and be refused, making an in-place
    -- correction that LOWERS the return impossible, and one that RAISES it past
    -- the ceiling is refused for the wrong reason.
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
ALTER FUNCTION trg_fin_on_account_return_bounds() OWNER TO school_migrator;
REVOKE ALL ON FUNCTION trg_fin_on_account_return_bounds() FROM PUBLIC;

-- -----------------------------------------------------------------------------
-- 4. trg_fin_refund_provenance -- remove the vacuous refund-side scan (D2)
--
-- The ALLOCATION-side branch is retained in full: it locks and validates the
-- refund an allocation names, requires payment_id agreement between the
-- allocation and its refund, and requires effect = 'reverse'. That branch is
-- reachable and load-bearing.
--
-- The fin_refunds branch is REMOVED ENTIRELY. Both of its checks tested the same
-- condition -- allocations naming NEW.id whose payment_id differs from
-- NEW.payment_id -- and both were unreachable:
--   * the FOR-loop could not raise, because a NOT DEFERRABLE
--     fin_pa_refund_fk means no allocation can reference an uncommitted refund,
--     and at BEFORE INSERT NEW.id is a fresh uuid;
--   * the PERFORM 1 ... LIMIT 1 / IF FOUND / RAISE that followed it was dead
--     even in principle, being the same predicate as the loop immediately above.
-- Removing the branch leaves the function's trailing RETURN NEW to serve the
-- refund side, which is exactly its behaviour on every path the old code could
-- actually reach.
--
-- SECURITY INVOKER is preserved deliberately. The applied catalog already reported
-- prosecdef = false for this function, and the authoritative design's DDL for
-- trg_fin_refund_provenance is explicitly SECURITY INVOKER, so INVOKER is both the
-- baseline and the intended posture. The on-disk 0025_fin_refunds.sql disagrees
-- (it declares SECURITY DEFINER); that divergence is a PRE-EXISTING inconsistency
-- between two immutable sources and is NOT resolved here, because changing it is
-- outside this remediation's boundary.
--
-- INVOKER is also the safer choice on the merits. This function only reads
-- fin_refunds and fin_payment_allocations, which are RLS-scoped from 0028 onward;
-- running it elevated would let it read ACROSS tenants, whereas running it as the
-- caller means it sees exactly what the caller may write. It performs no writes,
-- so DEFINER would buy nothing and cost tenant isolation. The test suite encodes
-- the same invariant for every trg_fin_* guard: SECURITY DEFINER on these is
-- "the escalation these guards exist to avoid".
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trg_fin_refund_provenance()
    RETURNS trigger
    LANGUAGE plpgsql
    SECURITY INVOKER
    SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    v_refund fin_refunds;
BEGIN
    IF TG_TABLE_NAME = 'fin_payment_allocations' THEN
        IF NEW.refund_id IS NOT NULL THEN
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

            IF NEW.payment_id IS DISTINCT FROM v_refund.payment_id THEN
                RAISE EXCEPTION
                    'allocation % payment_id % does not match refund % payment_id %',
                    NEW.id, NEW.payment_id, v_refund.id, v_refund.payment_id
                    USING ERRCODE = '55000';
            END IF;

            IF NEW.effect <> 'reverse' THEN
                RAISE EXCEPTION 'allocation % referencing refund must have effect = ''reverse''',
                    NEW.id
                    USING ERRCODE = '55000';
            END IF;
        END IF;
    END IF;

    RETURN NEW;
END;
$$;
ALTER FUNCTION trg_fin_refund_provenance() OWNER TO school_migrator;
REVOKE ALL ON FUNCTION trg_fin_refund_provenance() FROM PUBLIC;

-- -----------------------------------------------------------------------------
-- 5. Postconditions -- fail closed (D2C §6/§11, D2 §24.4)
--
-- `has_function_privilege` and `has_table_privilege` are catalog lookups that
-- report the privileges actually in effect, so these assert the granted state
-- rather than the intent of the statements above. Any violation RAISEs, which
-- aborts the transaction and therefore the migration.
-- -----------------------------------------------------------------------------
DO $assert$
DECLARE
    v_owner   text;
    v_config  text[];
    v_pub     boolean;
    v_app     boolean;
    v_isdef   boolean;
    v_body    text;
    v_t       text;
    v_survivor text;
BEGIN
    ------------------------------------------------------------------ helper
    SELECT pg_get_userbyid(p.proowner), p.proconfig, p.prosecdef, p.prosrc
      INTO v_owner, v_config, v_isdef, v_body
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname = 'fin_lock_payment_amount'
       AND pg_get_function_identity_arguments(p.oid) = 'p_tenant_id uuid, p_payment_id uuid';

    IF v_owner IS NULL THEN
        RAISE EXCEPTION
            '0025_lock_model_remediation failed: fin_lock_payment_amount(uuid, uuid) was not created';
    END IF;

    IF v_owner <> 'school_migrator' THEN
        RAISE EXCEPTION
            '0025_lock_model_remediation failed: fin_lock_payment_amount is owned by %, expected school_migrator',
            v_owner;
    END IF;

    IF v_isdef IS DISTINCT FROM true THEN
        RAISE EXCEPTION
            '0025_lock_model_remediation failed: fin_lock_payment_amount is not SECURITY DEFINER';
    END IF;

    IF v_config IS DISTINCT FROM ARRAY['search_path=pg_catalog, public, pg_temp'] THEN
        RAISE EXCEPTION
            '0025_lock_model_remediation failed: fin_lock_payment_amount search_path is %s, expected pg_catalog, public, pg_temp',
            coalesce(array_to_string(v_config, ','), '(unset)');
    END IF;

    -- No PUBLIC EXECUTE and no school_app_rw EXECUTE. has_function_privilege
    -- folds in PUBLIC and role inheritance, so this covers every path by which
    -- the runtime role could reach the function.
    SELECT has_function_privilege('school_app_rw',
                                  'public.fin_lock_payment_amount(uuid, uuid)', 'EXECUTE')
      INTO v_app;
    IF v_app THEN
        RAISE EXCEPTION
            '0025_lock_model_remediation failed: school_app_rw may EXECUTE fin_lock_payment_amount; it is an internal trigger helper';
    END IF;

    -- Explicit ACL cross-check, independent of the privilege lookup above.
    SELECT EXISTS (
        SELECT 1
          FROM pg_proc p
          JOIN pg_namespace n ON n.oid = p.pronamespace
          CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
          LEFT JOIN pg_roles r ON r.oid = a.grantee
         WHERE n.nspname = 'public'
           AND p.proname = 'fin_lock_payment_amount'
           AND a.privilege_type = 'EXECUTE'
           AND (r.rolname IS NULL OR r.rolname IN ('school_app_rw', 'PUBLIC'))
      )
      INTO v_pub;
    IF v_pub THEN
        RAISE EXCEPTION
            '0025_lock_model_remediation failed: fin_lock_payment_amount retains a PUBLIC or school_app_rw EXECUTE grant';
    END IF;

    -- Static body audit. A definer helper that could compose SQL, name a
    -- relation, or write would be a strictly larger capability than a row lock.
    IF v_body ~* '\mexecute\M' OR v_body ~* '\mformat\s*\(' OR v_body ~ '%' THEN
        RAISE EXCEPTION
            '0025_lock_model_remediation failed: fin_lock_payment_amount body contains dynamic SQL';
    END IF;

    IF v_body ~* '\minsert\M'
       OR v_body ~* '\mdelete\M'
       OR v_body ~* '\mupdate\s+[a-z_][a-z0-9_.]*\s+set\M' THEN
        RAISE EXCEPTION
            '0025_lock_model_remediation failed: fin_lock_payment_amount body performs a write';
    END IF;

    IF v_body ~* '\m(create|alter|drop|truncate|grant|revoke)\M' THEN
        RAISE EXCEPTION
            '0025_lock_model_remediation failed: fin_lock_payment_amount body contains DDL or a privilege statement';
    END IF;

    IF v_body !~* 'tenant_id\s*=\s*p_tenant_id' THEN
        RAISE EXCEPTION
            '0025_lock_model_remediation failed: fin_lock_payment_amount body has no tenant predicate; a definer must scope by tenant explicitly';
    END IF;

    IF v_body !~* 'id\s*=\s*p_payment_id' THEN
        RAISE EXCEPTION
            '0025_lock_model_remediation failed: fin_lock_payment_amount body has no payment-id predicate';
    END IF;

    IF v_body !~* '\mfor\s+update\M' THEN
        RAISE EXCEPTION
            '0025_lock_model_remediation failed: fin_lock_payment_amount body does not issue FOR UPDATE; it would serialise nothing';
    END IF;

    -- Exactly one payment row may be locked: a bare id lookup with the tenant
    -- conjunct. The helper must not contain a payment-wide scan.
    IF v_body ~* '\morder\s+by\M' THEN
        RAISE EXCEPTION
            '0025_lock_model_remediation failed: fin_lock_payment_amount body contains ORDER BY; a multi-row lock is out of scope';
    END IF;

    ------------------------------------------------------- payment triggers
    FOREACH v_t IN ARRAY ARRAY['trg_fin_allocation_bounds', 'trg_fin_on_account_return_bounds']
    LOOP
        EXECUTE format('SELECT prosecdef, prosrc FROM pg_proc p
                          JOIN pg_namespace n ON n.oid = p.pronamespace
                         WHERE n.nspname = ''public'' AND p.proname = %L', v_t)
          INTO v_isdef, v_body;

        IF v_isdef IS NOT FALSE THEN
            RAISE EXCEPTION
                '0025_lock_model_remediation failed: % is not SECURITY INVOKER', v_t;
        END IF;

        IF v_body !~* 'fin_lock_payment_amount\s*\(\s*NEW\.tenant_id\s*,\s*NEW\.payment_id\s*\)' THEN
            RAISE EXCEPTION
                '0025_lock_model_remediation failed: % does not delegate its lock to fin_lock_payment_amount', v_t;
        END IF;

        -- The direct read is what raised 42501; it must be gone from the caller.
        IF v_body ~* '\mfor\s+update\M' THEN
            RAISE EXCEPTION
                '0025_lock_model_remediation failed: % still issues FOR UPDATE directly instead of delegating', v_t;
        END IF;

        IF v_body ~* 'from\s+fin_payments' THEN
            RAISE EXCEPTION
                '0025_lock_model_remediation failed: % still reads fin_payments directly', v_t;
        END IF;
    END LOOP;

    ------------------------------------------------------ refund provenance
    SELECT prosrc INTO v_body
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'trg_fin_refund_provenance';

    IF v_body ~* 'limit\s+1' THEN
        RAISE EXCEPTION
            '0025_lock_model_remediation failed: trg_fin_refund_provenance still carries the redundant duplicate predicate';
    END IF;

    IF v_body ~* 'v_stray' THEN
        RAISE EXCEPTION
            '0025_lock_model_remediation failed: trg_fin_refund_provenance still declares or uses the removed v_stray scan';
    END IF;

    -- The refund-side branch is gone, so the allocation-side lock MUST survive:
    -- it is the only remaining serialization point in this function. Note that the
    -- removed refund-side branch was itself reachable on UPDATE (an existing refund
    -- already named by a reversal allocation could be re-pointed at another
    -- payment). That loss is the accepted, owner-directed consequence of D2, which
    -- forbade replacing the scan with any weaker approximation. At this checkpoint
    -- it is unreachable from the runtime role, which holds no privilege on
    -- fin_refunds at all.
    IF v_body !~* '\mfor\s+update\M' THEN
        RAISE EXCEPTION
            '0025_lock_model_remediation failed: trg_fin_refund_provenance lost its allocation-side lock';
    END IF;

    IF v_body !~* 'effect\s*<>|effect\s*!=' THEN
        RAISE EXCEPTION
            '0025_lock_model_remediation failed: trg_fin_refund_provenance lost its effect = reverse check';
    END IF;

    IF v_body !~* 'payment_id\s+is\s+distinct\s+from\s+v_refund\.payment_id' THEN
        RAISE EXCEPTION
            '0025_lock_model_remediation failed: trg_fin_refund_provenance lost its payment_id agreement check';
    END IF;

    ------------------------------------------------------------------ D2B
    -- The two payment triggers must remain bound, so FI-003 keeps its
    -- enforcement point. Verified by name against pg_trigger.
    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger tg
          JOIN pg_class c ON c.oid = tg.tgrelid
          JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public'
           AND NOT tg.tgisinternal
           AND tg.tgfoid = (
                 SELECT p.oid FROM pg_proc p
                   JOIN pg_namespace pn ON pn.oid = p.pronamespace
                  WHERE pn.nspname = 'public'
                    AND p.proname = 'trg_fin_allocation_bounds')
      ) THEN
        RAISE EXCEPTION
            '0025_lock_model_remediation failed: trg_fin_allocation_bounds is no longer bound to a trigger';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger tg
          JOIN pg_class c ON c.oid = tg.tgrelid
          JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public'
           AND NOT tg.tgisinternal
           AND tg.tgfoid = (
                 SELECT p.oid FROM pg_proc p
                   JOIN pg_namespace pn ON pn.oid = p.pronamespace
                  WHERE pn.nspname = 'public'
                    AND p.proname = 'trg_fin_on_account_return_bounds')
      ) THEN
        RAISE EXCEPTION
            '0025_lock_model_remediation failed: trg_fin_on_account_return_bounds is no longer bound to a trigger';
    END IF;
END
$assert$;

COMMIT;
