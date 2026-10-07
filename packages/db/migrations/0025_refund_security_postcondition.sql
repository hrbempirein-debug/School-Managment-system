-- =============================================================================
-- 0025_refund_security_postcondition.sql
--
-- WHAT
-- A pure gate. This file creates, alters, drops, grants and revokes NOTHING. It
-- reads the catalog and RAISEs on any violation, so a partially-remediated or
-- half-applied forward tail aborts the migration instead of being recorded as
-- applied.
--
-- It is named 0025_refund_security_postcondition rather than
-- 0025_refund_integrity_remediation for a mechanical reason: the runner sorts
-- filenames with a plain lexical .sort() (packages/db/src/cli/migrate.ts:32), so
-- "refund_integrity" ('i') would sort BEFORE "refund_provenance" ('p') and this
-- gate would run before the remediation it gates. 'security' ('s') sorts last.
-- The realised order is therefore
--     0025_fin_refunds
--     0025_lock_model_remediation
--     0025_privilege_remediation
--     0025_refund_fk_remediation
--     0025_refund_provenance_remediation
--     0025_refund_security_postcondition      <-- this file, last
--     0026_fin_ledger                         (not created by this task)
--
-- WHAT IT PROVES
--   R1  trg_fin_refund_provenance is SECURITY INVOKER.
--   R2  fin_pa_refund_fk is ON DELETE NO ACTION, NOT DEFERRABLE, validated, over
--       the canonical composite columns, and fin_payment_allocations.tenant_id is
--       still NOT NULL (the premise that made SET NULL impossible).
--   R3  the reversal-target effect='apply' check is present and locked.
--   R4  the link-creation status check is present, AND the four-state
--       fin_refunds.status vocabulary is still intact for 0028's F11/F12.
--   D1  fail-closed: school_app_rw holds nothing on any fin_* table, and RLS and
--       policies remain absent (both are 0028's).
--   D2C fin_lock_payment_amount is still the narrow SECURITY DEFINER helper:
--       right owner, right search_path, no PUBLIC or school_app_rw EXECUTE,
--       static body, one statement, tenant-scoped, locking exactly one row, and
--       still called only by the two SECURITY INVOKER payment triggers.
--   0028 NOT PREMATURELY ENABLED: postRefundApproval, postRefundProcess and
--       app_ctx_session_id do not exist.
--
-- IDEMPOTENCE
-- The runner skips applied filenames, so this executes once. Every statement is
-- a catalog read, so re-running it is a no-op regardless.
-- =============================================================================

BEGIN;

DO $assert$
DECLARE
    v_body      text;
    v_stripped  text;
    v_helper    text;
    v_config    text[];
    v_owner     text;
    v_isdef     boolean;
    v_conf      pg_constraint;
    v_bin       text;
    v_ok        text[];
    v_survivor  text;
    v_rel       text;
    v_count     integer;
    v_notnull   boolean;
    -- Named v_caller, not c: a plpgsql record variable called c would shadow
    -- the pg_class alias c used below, and plpgsql resolves the variable first,
    -- turning c.relname into "record c is not assigned yet".
    v_caller    record;
BEGIN
    --     ================================================================== R1
    SELECT p.prosecdef, pg_get_userbyid(p.proowner), p.proconfig
      INTO v_isdef, v_owner, v_config
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'trg_fin_refund_provenance';

    IF v_isdef IS NOT FALSE THEN
        RAISE EXCEPTION 'R1 FAILED: trg_fin_refund_provenance is not SECURITY INVOKER';
    END IF;

    IF has_function_privilege('school_app_rw',
                              'public.trg_fin_refund_provenance()', 'EXECUTE') THEN
        RAISE EXCEPTION 'R1 FAILED: school_app_rw may EXECUTE trg_fin_refund_provenance';
    END IF;

    SELECT prosrc INTO v_body
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'trg_fin_refund_provenance';

    IF v_body !~* 'v_target\.effect\s*<>\s*''apply''' THEN
        RAISE EXCEPTION 'R3 FAILED: reversal-target effect=''apply'' check absent';
    END IF;

    IF v_body !~* 'v_refund\.status\s+not\s+in' THEN
        RAISE EXCEPTION 'R4 FAILED: link-creation status check absent';
    END IF;

    -- D2 must still be decided.
    IF v_body ~* '\bv_stray\b' THEN
        RAISE EXCEPTION 'D2 REGRESSED: the refund-side scan was reintroduced';
    END IF;

    --     ================================================================== R2
    SELECT * INTO v_conf
      FROM pg_constraint
     WHERE conname = 'fin_pa_refund_fk'
       AND connamespace = 'public'::regnamespace;

    IF v_conf IS NULL THEN
        RAISE EXCEPTION 'R2 FAILED: fin_pa_refund_fk absent';
    END IF;

    IF v_conf.confdeltype <> 'a' THEN
        RAISE EXCEPTION 'R2 FAILED: fin_pa_refund_fk ON DELETE is %, expected ''a'' (NO ACTION)',
            v_conf.confdeltype;
    END IF;

    IF v_conf.condeferrable OR v_conf.condeferred OR v_conf.convalidated IS NOT TRUE THEN
        RAISE EXCEPTION 'R2 FAILED: fin_pa_refund_fk is deferrable or not validated';
    END IF;

    SELECT attnotnull INTO v_notnull
      FROM pg_attribute
     WHERE attrelid = 'public.fin_payment_allocations'::regclass
       AND attname = 'tenant_id' AND NOT attisdropped;

    IF v_notnull IS DISTINCT FROM true THEN
        RAISE EXCEPTION 'R2 FAILED: fin_payment_allocations.tenant_id is no longer NOT NULL';
    END IF;

    --     ================================================================== R4
    -- The vocabulary must still be FOUR states. This is evaluated against the
    -- constraint's own predicate rather than by matching its text, so a rewrite
    -- that keeps the four literals but changes the logic is still caught.
    -- conbin is a pg_node_tree, whose text form is the PARSE TREE
    -- ({SCALARARRAYOPEXPR :opno 98 ...}), not SQL. pg_get_expr decompiles it
    -- back to the source expression, which is the only form that can be
    -- re-executed below.
    SELECT pg_get_expr(c.conbin, c.conrelid) INTO v_bin
      FROM pg_constraint c
     WHERE c.conname = 'fin_refunds_status_check'
       AND c.connamespace = 'public'::regnamespace
       AND c.conrelid = 'public.fin_refunds'::regclass;

    IF v_bin IS NULL THEN
        RAISE EXCEPTION 'R4 FAILED: fin_refunds_status_check is absent; the status vocabulary is unconstrained';
    END IF;

    -- The VALUES column is aliased `status` because that is the identifier the
    -- constraint's own predicate is written against; evaluating a predicate that
    -- references a column the FROM clause does not expose would raise 42703.
    -- The literal 'not_a_status' candidate is the negative control: it must be
    -- absent from the result, which is what proves the check still rejects.
    EXECUTE format(
        'SELECT array_agg(status ORDER BY status) FROM (VALUES (%L),(%L),(%L),(%L),(%L)) AS t(status) WHERE %s',
        'requested', 'approved', 'rejected', 'processed', 'not_a_status', v_bin)
      INTO v_ok;

    IF v_ok IS DISTINCT FROM ARRAY['approved', 'processed', 'rejected', 'requested'] THEN
        RAISE EXCEPTION
            'R4 FAILED: fin_refunds.status accepts %, expected exactly {requested, approved, rejected, processed}',
            coalesce(array_to_string(v_ok, ', '), '(none)');
    END IF;

    -- The four-arm decision state machine must survive too; F11/F12 drive it.
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'fin_refunds_decision_ck'
           AND connamespace = 'public'::regnamespace
           AND conrelid = 'public.fin_refunds'::regclass
    ) THEN
        RAISE EXCEPTION 'R4 FAILED: fin_refunds_decision_ck is absent; F11/F12 have no state machine to drive';
    END IF;

    --     ================================================================= D2C
    SELECT p.prosecdef, pg_get_userbyid(p.proowner), p.proconfig, p.prosrc
      INTO v_isdef, v_owner, v_config, v_helper
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname = 'fin_lock_payment_amount'
       AND pg_get_function_identity_arguments(p.oid) = 'p_tenant_id uuid, p_payment_id uuid';

    IF v_helper IS NULL THEN
        RAISE EXCEPTION 'D2C FAILED: fin_lock_payment_amount(uuid, uuid) is absent';
    END IF;

    IF v_isdef IS DISTINCT FROM true THEN
        RAISE EXCEPTION 'D2C FAILED: fin_lock_payment_amount is not SECURITY DEFINER';
    END IF;

    IF v_owner <> 'school_migrator' THEN
        RAISE EXCEPTION 'D2C FAILED: fin_lock_payment_amount is owned by %, expected school_migrator', v_owner;
    END IF;

    IF v_config IS DISTINCT FROM ARRAY['search_path=pg_catalog, public, pg_temp'] THEN
        RAISE EXCEPTION 'D2C FAILED: fin_lock_payment_amount search_path is %s',
            coalesce(array_to_string(v_config, ','), '(unset)');
    END IF;

    IF has_function_privilege('school_app_rw',
                              'public.fin_lock_payment_amount(uuid, uuid)', 'EXECUTE') THEN
        RAISE EXCEPTION 'D2C FAILED: school_app_rw may EXECUTE fin_lock_payment_amount; it is an internal trigger helper';
    END IF;

    IF EXISTS (
        SELECT 1
          FROM pg_proc p
          JOIN pg_namespace n ON n.oid = p.pronamespace
          CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
          LEFT JOIN pg_roles r ON r.oid = a.grantee
         WHERE n.nspname = 'public'
           AND p.proname = 'fin_lock_payment_amount'
           AND a.privilege_type = 'EXECUTE'
           AND (r.rolname IS NULL OR r.rolname IN ('school_app_rw', 'PUBLIC'))
    ) THEN
        RAISE EXCEPTION 'D2C FAILED: fin_lock_payment_amount retains a PUBLIC or school_app_rw EXECUTE entry';
    END IF;

    -- Every capability audit below runs against the body with its -- comments
    -- removed. A keyword appearing in prose is not a capability: the helper's
    -- own comment explains what a caller-side "PERFORM" would have done wrong,
    -- and matching that word would fail this gate on a healthy function. It
    -- also means a future comment cannot silently satisfy or trip an audit.
    v_stripped := regexp_replace(v_helper, '--[^\n]*', '', 'g');

    -- Still narrow: one locked row, one tenant, no writes, no composition.
    IF v_stripped !~* '\mfor\s+update\M' THEN
        RAISE EXCEPTION 'D2C FAILED: fin_lock_payment_amount no longer issues FOR UPDATE';
    END IF;

    IF v_stripped !~* 'tenant_id\s*=\s*p_tenant_id' OR v_stripped !~* 'id\s*=\s*p_payment_id' THEN
        RAISE EXCEPTION 'D2C FAILED: fin_lock_payment_amount lost its (tenant_id, id) predicate';
    END IF;

    IF v_stripped ~* '\mexecute\M|\mformat\s*\(' THEN
        RAISE EXCEPTION 'D2C FAILED: fin_lock_payment_amount contains dynamic SQL';
    END IF;

    IF v_stripped ~* '\minsert\M|\mdelete\M|\mupdate\s+[a-z_][a-z0-9_.]*\s+set\M' THEN
        RAISE EXCEPTION 'D2C FAILED: fin_lock_payment_amount performs a write';
    END IF;

    IF v_stripped ~* '\morder\s+by\M' THEN
        RAISE EXCEPTION 'D2C FAILED: fin_lock_payment_amount would lock more than one row';
    END IF;

    SELECT count(*) INTO v_count
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname = 'fin_lock_payment_amount';

    IF v_count <> 1 THEN
        RAISE EXCEPTION 'D2C FAILED: expected exactly 1 fin_lock_payment_amount overload, found %', v_count;
    END IF;

    -- Both callers must still be INVOKER and must still delegate to it.
    FOR v_caller IN
        SELECT p.proname, p.prosecdef, p.prosrc
          FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public'
           AND p.proname IN ('trg_fin_allocation_bounds', 'trg_fin_on_account_return_bounds')
    LOOP
        IF v_caller.prosecdef IS NOT FALSE THEN
            RAISE EXCEPTION 'D2C FAILED: % is not SECURITY INVOKER', v_caller.proname;
        END IF;

        IF v_caller.prosrc !~* 'fin_lock_payment_amount\s*\(\s*NEW\.tenant_id\s*,\s*NEW\.payment_id\s*\)' THEN
            RAISE EXCEPTION 'D2C FAILED: % no longer delegates its lock to fin_lock_payment_amount', v_caller.proname;
        END IF;

        IF v_caller.prosrc ~* '\mfor\s+update\M' THEN
            RAISE EXCEPTION 'D2C FAILED: % issues FOR UPDATE directly again', v_caller.proname;
        END IF;
    END LOOP;

    SELECT count(*) INTO v_count
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN ('trg_fin_allocation_bounds', 'trg_fin_on_account_return_bounds');

    IF v_count <> 2 THEN
        RAISE EXCEPTION 'D2C FAILED: expected 2 payment bound triggers, found %', v_count;
    END IF;

    --     ======================================================== D1 fail-closed
    SELECT string_agg(format('%s.%s', c.relname, x.p), ', ')
      INTO v_survivor
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      CROSS JOIN LATERAL unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) AS x(p)
     WHERE n.nspname = 'public'
       AND c.relkind IN ('r','p')
       AND c.relname LIKE 'fin\_%'
       AND has_table_privilege('school_app_rw', c.oid, x.p);

    IF v_survivor IS NOT NULL THEN
        RAISE EXCEPTION 'D1 FAILED: school_app_rw holds %; finance must stay unreachable until 0028', v_survivor;
    END IF;

    SELECT string_agg(c.relname, ', ')
      INTO v_rel
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relkind IN ('r','p')
       AND c.relname LIKE 'fin\_%'
       AND (c.relrowsecurity OR c.relforcerowsecurity);

    IF v_rel IS NOT NULL THEN
        RAISE EXCEPTION 'D1 FAILED: RLS is enabled on %; RLS is 0028''s transition', v_rel;
    END IF;

    IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename LIKE 'fin\_%') THEN
        RAISE EXCEPTION 'D1 FAILED: a finance RLS policy exists; policy DDL is 0028''s';
    END IF;

    --     ============================================ 0028 must not be enabled
    -- F11/F12 and app_ctx_session_id() are 0028-owned. Their existence here
    -- would mean the refund workflow was switched on ahead of its migration.
    SELECT string_agg(p.proname, ', ')
      INTO v_survivor
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN ('postRefundApproval', 'postRefundProcess', 'app_ctx_session_id');

    IF v_survivor IS NOT NULL THEN
        RAISE EXCEPTION
            '0028 SCOPE FAILED: % exists; F11/F12/app_ctx_session_id are 0028-owned and must not be created by the 0025 remediation',
            v_survivor;
    END IF;
END
$assert$;

COMMIT;