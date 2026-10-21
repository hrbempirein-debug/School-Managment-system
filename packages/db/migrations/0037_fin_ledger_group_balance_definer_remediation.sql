-- ============================================================================
-- 0037_fin_ledger_group_balance_definer_remediation.sql
-- Forward-only remediation of the deferred balance trigger
-- `trg_fin_ledger_group_balance()` (0026 line 296).
-- ----------------------------------------------------------------------------
-- DEFECT (confirmed by CI run 39537889695, step 17):
--   0026 binds `trg_fin_ledger_group_balance()` as a DEFERRABLE INITIALLY
--   DEFERRED CONSTRAINT trigger on fin_ledger_entries. At COMMIT the trigger
--   recomputes the group's totals from the legs and issues
--       UPDATE fin_ledger_entry_groups SET total_debit = ..., total_credit = ...,
--                                          entry_count = ...
--   The function was declared SECURITY INVOKER, so that UPDATE ran with the
--   RIGHTS OF THE CALLER, school_app_rw. But 0026:820 revokes ALL on
--   fin_ledger_entry_groups from school_app_rw (0028 shape 4 leaves it SELECT
--   only), and the forced RLS UPDATE policy (0028:1645) is `USING
--   (app_privileged())`, i.e. current_user = 'school_migrator'. The update was
--   therefore refused:
--       ERROR: 42501: permission denied for table fin_ledger_entry_groups
--   in PL/pgSQL function trg_fin_ledger_group_balance() line 47.
--   The runtime role could post a ledger group through F4
--   (post_fin_ledger_group, SECURITY DEFINER) but the group's cached totals were
--   never written back, so commit of the ordinary refund path failed.
--
-- CORRECTION -- one attribute, nothing else:
--   The balance trigger is the ONE place the ledger's central invariant is
--   proven and its totals are maintained; it is an internal, trigger-maintained
--   aggregate that must run under a narrowly scoped privileged identity. It is
--   redefined as SECURITY DEFINER, owned by school_migrator (the same owner and
--   posture as F4 post_fin_ledger_group, the ledger's single write path).
--   CREATE OR REPLACE preserves the existing owner, so no ALTER ... OWNER TO is
--   required.
--
-- PRESERVED EXACTLY (the function body is byte-for-byte the 0026 body):
--   * signature      trg_fin_ledger_group_balance() RETURNS trigger
--   * tenant/group   derived from OLD/NEW of the triggering leg row only;
--                    never from a caller argument
--   * leg query      filtered by BOTH tenant_id AND entry_group_id
--   * totals         recomputed from fin_ledger_entries (the authoritative legs),
--                    never read back from the cached columns
--   * refusals       SQLSTATE 55000 for an empty group and for an unbalanced one
--   * write          single UPDATE of the cache columns on the matching group
--   * SET search_path = pg_catalog, public, pg_temp
--   * REVOKE ALL ON FUNCTION trg_fin_ledger_group_balance() FROM PUBLIC
--
-- DELIBERATELY UNCHANGED (no grant, no ACL, no policy):
--   * No GRANT EXECUTE to school_app_rw (this is a trigger function: a caller
--     must not be able to invoke it outside its binding).
--   * No GRANT UPDATE on fin_ledger_entry_groups to school_app_rw. Granting the
--     runtime role direct UPDATE would let it forge the ledger totals and bypass
--     the deferred balance proof, breaking the append-only single-writer model.
--   * Forced RLS policies, table privileges, the seal guard
--     (trg_fin_ledger_seal), the append-only guard (trg_fin_ledger_append_only),
--     the sealed-group-reject guard and the posting API (post_fin_ledger_group)
--     are all left exactly as 0026/0028 shipped them.
--
-- OWNERSHIP / PRIVILEGE NOTES:
--   * Create/replace is run by school_migrator, so the owner is school_migrator
--     and app_privileged() is TRUE for the elevated body, which is what lets the
--     RLS UPDATE policy admit the write.
--   * No new object is created: the function count, table count, FK count and
--     trigger inventory are unchanged.
--
-- IMMUTABILITY: 0001-0036 are NOT edited by this file.
-- ============================================================================
CREATE OR REPLACE FUNCTION trg_fin_ledger_group_balance() RETURNS trigger
    LANGUAGE plpgsql
    SECURITY DEFINER
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
