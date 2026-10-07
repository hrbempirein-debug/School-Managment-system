-- =============================================================================
-- 0025_privilege_remediation.sql
--
-- WHAT
-- Strictly subtractive. Removes the last runtime-reachable finance privilege
-- that 0025_fin_refunds.sql granted, restoring the D1 fail-closed posture:
--
--   school_app_rw MUST hold no privilege on any fin_* table at the end of the
--   0025 remediation stage. Runtime finance access begins in 0028, which is
--   also where RLS and the finance grants arrive.
--
-- This file contains NO grant, NO policy, NO ENABLE/FORCE ROW LEVEL SECURITY,
-- and NO CREATE FUNCTION. It revokes, then asserts.
--
-- WHY
-- 0025_fin_refunds.sql ended with
--     GRANT SELECT, INSERT ON fin_refunds TO school_app_rw;
--     GRANT SELECT, INSERT ON fin_payment_allocations TO school_app_rw;
-- which contradicts the same file's own NOTE ("0025 is a write-once staging
-- checkpoint") and §30.1, which classifies every 0025 object as UNREACHABLE
-- because 0025 creates no policy and therefore no RLS. Without RLS those two
-- grants are not a guarded door; they are an unguarded one, and
-- fin_refunds has no tenant-scoped policy to constrain them.
--
-- SCOPE NOTE -- fin_payment_allocations
-- 0025 also granted SELECT, INSERT on fin_payment_allocations. The live catalog
-- shows school_app_rw already holds NO privilege on that table (0001's default
-- privileges covered the table when 0024 created it, and 0024 revoked it), so
-- the grant from 0025 is a no-op today and needs no corrective statement. It is
-- revoked here defensively anyway: a REVOKE of a privilege that is not held is
-- a no-op, so this costs nothing and makes the file's intent hold regardless of
-- what any earlier migration did.
--
-- SCOPE NOTE -- the two fin_v_* views
-- school_app_rw holds INSERT/UPDATE/DELETE/SELECT on fin_v_invoice_balance and
-- fin_v_payment_position. Those are VIEWS, not tables, and the grants come from
-- 0001's `GRANT ... ON ALL TABLES IN SCHEMA public` default privileges, which
-- in PostgreSQL covers views as well. They predate this remediation, are not
-- touched here, and are outside the 0025 scope; they are reported as a
-- pre-existing finding for separate owner scheduling. The assertion below
-- therefore covers relkind IN ('r','p') -- D1's "table" -- and deliberately
-- does not extend to views.
--
-- IDEMPOTENCE
-- The runner skips applied filenames, so this executes once. REVOKE is
-- idempotent and `has_*_privilege` assertions are read-only, so re-running the
-- statements is a no-op, matching 0020's established pattern.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. Revoke. Nothing in this file grants anything.
-- -----------------------------------------------------------------------------
REVOKE ALL ON TABLE fin_refunds FROM school_app_rw;

-- Belt and braces, in 0020's own words: "Nothing grants this to PUBLIC today,
-- but a ledger that is readable by any role is the same defect one indirection
-- away." The same applies to a money-bearing table.
REVOKE ALL ON TABLE fin_refunds FROM PUBLIC;

-- No-op today; see the scope note above.
REVOKE ALL ON TABLE fin_payment_allocations FROM school_app_rw;
REVOKE ALL ON TABLE fin_payment_allocations FROM PUBLIC;

-- -----------------------------------------------------------------------------
-- 2. Postcondition -- fail closed.
--
-- An empty ACL is the intended end state, not a warning: a surviving privilege
-- here means 0025 is reachable, so this RAISEs and aborts the migration rather
-- than reporting and continuing. Three independent checks, because each covers
-- a path the others do not:
--
--   (a) has_table_privilege  -- effective privilege, folding in PUBLIC and any
--                               role membership, so it catches inheritance.
--   (b) has_column_privilege -- a column-level grant is invisible to (a).
--   (c) aclexplode           -- the raw ACL, so an entry that grants nothing
--                               effective today (a revoked column grant, or a
--                               grant to a role with no path in) is still
--                               reported as a leftover rather than ignored.
-- -----------------------------------------------------------------------------
DO $assert$
DECLARE
    v_survivor text;
    v_rel      text;
BEGIN
    ------------------------------------------------------------------ (a)
    SELECT string_agg(format('%s on %s', x.p, c.relname), ', ')
      INTO v_survivor
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     CROSS JOIN LATERAL unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE',
                                     'TRUNCATE', 'REFERENCES', 'TRIGGER']) AS x(p)
     WHERE n.nspname = 'public'
       AND c.relname = 'fin_refunds'
       AND has_table_privilege('school_app_rw', c.oid, x.p);

    IF v_survivor IS NOT NULL THEN
        RAISE EXCEPTION
            '0025_privilege_remediation failed: school_app_rw still holds %; 0025 must remain unreachable until 0028 installs RLS and the finance grants',
            v_survivor;
    END IF;

    ------------------------------------------------------------------ (b)
    SELECT string_agg(format('%s on %s.%s', x.p, c.relname, a.attname), ', ')
      INTO v_survivor
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
     CROSS JOIN LATERAL unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'REFERENCES']) AS x(p)
     WHERE n.nspname = 'public'
       AND c.relname = 'fin_refunds'
       AND has_column_privilege('school_app_rw', a.attrelid, a.attnum, x.p);

    IF v_survivor IS NOT NULL THEN
        RAISE EXCEPTION
            '0025_privilege_remediation failed: column-level grant survived: school_app_rw still holds %',
            v_survivor;
    END IF;

    ------------------------------------------------------------------ (c)
    SELECT string_agg(format('%s -> %s on %s', a.privilege_type,
                             coalesce(r.rolname, 'PUBLIC'), c.relname), ', ')
      INTO v_survivor
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl, acldefault('r', c.relowner))) a
      LEFT JOIN pg_roles r ON r.oid = a.grantee
     WHERE n.nspname = 'public'
       AND c.relname IN ('fin_refunds', 'fin_payment_allocations')
       AND a.privilege_type <> 'MAINTAIN'
       AND (r.rolname IS NULL OR r.rolname IN ('school_app_rw', 'PUBLIC'));

    IF v_survivor IS NOT NULL THEN
        RAISE EXCEPTION
            '0025_privilege_remediation failed: ACL entry survived: %', v_survivor;
    END IF;

    ---------------------------------------------------- D1, table-wide
    -- school_app_rw must hold nothing on any fin_* TABLE. Views are excluded
    -- deliberately; see the scope note in the file header.
    SELECT string_agg(format('%s -> %s on %s', a.privilege_type,
                             coalesce(r.rolname, 'PUBLIC'), c.relname), ', ')
      INTO v_survivor
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl, acldefault('r', c.relowner))) a
      LEFT JOIN pg_roles r ON r.oid = a.grantee
     WHERE n.nspname = 'public'
       AND c.relkind IN ('r', 'p')
       AND c.relname LIKE 'fin\_%'
       AND a.privilege_type <> 'MAINTAIN'
       AND (r.rolname IS NULL OR r.rolname IN ('school_app_rw', 'PUBLIC'));

    IF v_survivor IS NOT NULL THEN
        RAISE EXCEPTION
            '0025_privilege_remediation failed: school_app_rw still holds a privilege on a finance table: %',
            v_survivor;
    END IF;

    ------------------------------------------------------- no RLS added
    -- This file must not have enabled RLS or created a policy. RLS is 0028's
    -- transition, and enabling it here with no policy would silently deny the
    -- migrator's own future writes rather than protect anything.
    SELECT string_agg(c.relname, ', ')
      INTO v_rel
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relkind IN ('r', 'p')
       AND c.relname LIKE 'fin\_%'
       AND (c.relrowsecurity OR c.relforcerowsecurity);

    IF v_rel IS NOT NULL THEN
        RAISE EXCEPTION
            '0025_privilege_remediation failed: row-level security is enabled on %; RLS belongs to 0028',
            v_rel;
    END IF;

    IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename LIKE 'fin\_%') THEN
        RAISE EXCEPTION
            '0025_privilege_remediation failed: a finance policy exists; policy DDL belongs to 0028';
    END IF;
END
$assert$;

COMMIT;
