-- =============================================================================
-- 0025_refund_fk_remediation.sql
--
-- WHAT
-- Forward-only remediation of ONE constraint: fin_pa_refund_fk, the composite
-- foreign key from fin_payment_allocations(tenant_id, refund_id) to
-- fin_refunds(tenant_id, id).
--
-- The constraint keeps its name, its columns, its target and its NOT DEFERRABLE
-- semantics. Only the ON DELETE action changes:
--
--     before:  ON DELETE SET NULL   (defective)
--     after :  ON DELETE NO ACTION  (canonical)
--
-- This file touches no other object. It creates no function, no trigger, no
-- policy and no privilege.
--
-- WHY SET NULL IS DEFECTIVE HERE
-- The FK is composite over (tenant_id, refund_id). ON DELETE SET NULL sets BOTH
-- referencing columns to NULL. fin_payment_allocations.tenant_id is NOT NULL, so
-- a SET NULL on that column cannot succeed: PostgreSQL raises
--
--     23502 not_null_violation
--
-- the moment a refund is deleted while any allocation names it. The intent of
-- SET NULL here was plainly "clear the optional link", which would require
-- nulling refund_id alone -- but a composite FK's action applies to the whole
-- key, so the SET NULL form is not expressible on this constraint. It is not a
-- permissive constraint that is occasionally awkward; it is a constraint that
-- can never do what it says, so it fails with the wrong error and the wrong
-- meaning.
--
-- NO ACTION is both the canonical target and the correct behaviour: deleting a
-- refund that is still named by a payment allocation must be REJECTED. A refund
-- is not a scratch row -- it is the accountable record of money leaving, and
-- fin_payment_allocations is append-only (trg_fin_pa_delete_guard, and
-- trg_fin_ledger_append_only for the ledger). Silently detaching the link would
-- destroy the provenance of the reversal, which is precisely the property
-- fin_pa_refund_fk and trg_fin_refund_provenance exist to protect.
--
-- WHY THIS IS A NEW FILE AND NOT AN EDIT TO 0025_fin_refunds.sql
-- 0025_fin_refunds.sql is IMMUTABLE and is pinned by SHA-256. It declares the
-- defective SET NULL form, and that declaration is the source/live drift this
-- migration reconciles. The ledger in schema_migrations records filenames only
-- and carries no checksums, so the on-disk history cannot be re-verified against
-- what any database actually executed -- which is exactly why this correction
-- has to be a forward statement rather than a history edit. Replaying
-- 0021..0025..this file now yields the canonical constraint, so the catalog is
-- reproducible from the immutable history plus the forward tail.
--
-- CONCURRENCY / LOCKING
-- ADD CONSTRAINT ... FOREIGN KEY takes ACCESS EXCLUSIVE on
-- fin_payment_allocations and ROW SHARE on fin_refunds for the duration, and
-- validates immediately. This is a staging checkpoint: both tables are write
-- unreachable from the runtime role (0025_privilege_remediation removed the
-- last school_app_rw grant on them and 0025 created no RLS policy), so there is
-- no concurrent runtime writer to block. Validation scans the referencing side;
-- on a populated table that is a full scan under the same ACCESS EXCLUSIVE
-- lock, which is the correct and unavoidable cost of validating a composite FK
-- rather than adding it NOT VALID.
--
-- IDEMPOTENCE
-- The runner records applied filenames and skips them, so this executes once.
-- Its own statements are nonetheless re-runnable: DROP CONSTRAINT IF EXISTS is
-- a no-op when absent, and the ADD is always preceded by the DROP, so a re-run
-- can never produce a second fin_pa_refund_fk. The end state is identical.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. Replace the constraint.
--
-- The DROP is unconditional-by-name rather than conditional-on-action so the
-- file converges on the canonical definition from ANY starting state, including
-- one where an earlier out-of-band edit left a differently-defined constraint
-- under this name.
-- -----------------------------------------------------------------------------
ALTER TABLE fin_payment_allocations DROP CONSTRAINT IF EXISTS fin_pa_refund_fk;

ALTER TABLE fin_payment_allocations
    ADD CONSTRAINT fin_pa_refund_fk
    FOREIGN KEY (tenant_id, refund_id)
    REFERENCES fin_refunds (tenant_id, id)
    ON DELETE NO ACTION
    NOT DEFERRABLE;

-- -----------------------------------------------------------------------------
-- 2. Postconditions -- fail closed.
--
-- confdeltype is the catalog's encoding of the ON DELETE action:
--     a = NO ACTION      r = RESTRICT      c = CASCADE
--     n = SET NULL       d = SET DEFAULT
-- so 'a' is the literal verification of the canonical target.
--
-- The constraint is verified by NAME and then decomposed, so a same-named
-- constraint that was recreated over different columns or pointing at a
-- different table cannot pass this gate.
-- -----------------------------------------------------------------------------
DO $assert$
DECLARE
    v_conf   pg_constraint;
    v_cols   text[];
    v_tgt    text;
    v_null   boolean;
    v_dupes  integer;
    v_orphan integer;
BEGIN
    SELECT c.* INTO v_conf
      FROM pg_constraint c
     WHERE c.conname = 'fin_pa_refund_fk'
       AND c.connamespace = 'public'::regnamespace;

    ---------------------------------------------------------------- existence
    IF v_conf IS NULL THEN
        RAISE EXCEPTION
            '0025_refund_fk_remediation failed: constraint fin_pa_refund_fk does not exist';
    END IF;

    -- Exactly one, on the right table. A duplicate under another name would be a
    -- second, invisible enforcement point.
    SELECT count(*) INTO v_dupes
      FROM pg_constraint c
     WHERE c.connamespace = 'public'::regnamespace
       AND c.contype = 'f'
       AND c.conrelid = 'public.fin_payment_allocations'::regclass
       AND c.confrelid = 'public.fin_refunds'::regclass;

    IF v_dupes <> 1 THEN
        RAISE EXCEPTION
            '0025_refund_fk_remediation failed: expected exactly 1 fin_payment_allocations -> fin_refunds FK, found %',
            v_dupes;
    END IF;

    ------------------------------------------------------------- ON DELETE
    IF v_conf.confdeltype <> 'a' THEN
        RAISE EXCEPTION
            '0025_refund_fk_remediation failed: fin_pa_refund_fk has ON DELETE action %; expected ''a'' (NO ACTION)',
            v_conf.confdeltype;
    END IF;

    IF v_conf.confupdtype <> 'a' THEN
        RAISE EXCEPTION
            '0025_refund_fk_remediation failed: fin_pa_refund_fk has ON UPDATE action %; expected ''a'' (NO ACTION)',
            v_conf.confupdtype;
    END IF;

    ------------------------------------------------------------ deferrability
    IF v_conf.condeferrable OR v_conf.condeferred THEN
        RAISE EXCEPTION
            '0025_refund_fk_remediation failed: fin_pa_refund_fk is deferrable (deferrable=%, deferred=%); it must remain NOT DEFERRABLE',
            v_conf.condeferrable, v_conf.condeferred;
    END IF;

    ---------------------------------------------------------- columns/target
    SELECT array_agg(a.attname ORDER BY k.ord)
      INTO v_cols
      FROM unnest(v_conf.conkey) WITH ORDINALITY AS k(attnum, ord)
      JOIN pg_attribute a ON a.attrelid = v_conf.conrelid AND a.attnum = k.attnum;

    IF v_cols IS DISTINCT FROM ARRAY['tenant_id', 'refund_id'] THEN
        RAISE EXCEPTION
            '0025_refund_fk_remediation failed: fin_pa_refund_fk columns are %, expected {tenant_id, refund_id}',
            array_to_string(v_cols, ', ');
    END IF;

    IF v_conf.confrelid <> 'public.fin_refunds'::regclass THEN
        RAISE EXCEPTION
            '0025_refund_fk_remediation failed: fin_pa_refund_fk references %, expected fin_refunds',
            v_conf.confrelid::regclass;
    END IF;

    -- The referenced key must still be unique on exactly (tenant_id, id). This
    -- is checked against pg_index rather than pg_constraint on purpose: 0021
    -- enforces it with a bare UNIQUE INDEX (fin_refunds_ten_id_uq), not with a
    -- named unique CONSTRAINT, so a pg_constraint-only check would report a
    -- false failure on a healthy database. A unique index on a SUPERSET of the
    -- two columns would not do -- only the exact column set guarantees that
    -- (tenant_id, id) is itself unique -- hence the equality, not a containment
    -- test.
    IF NOT EXISTS (
        SELECT 1
          FROM pg_index i
         WHERE i.indrelid = 'public.fin_refunds'::regclass
           AND i.indisunique
           AND i.indisvalid
           AND (SELECT array_agg(a.attname::text ORDER BY a.attname::text)
                  FROM unnest(i.indkey) AS k(attnum)
                  JOIN pg_attribute a
                    ON a.attrelid = i.indrelid AND a.attnum = k.attnum)
               = ARRAY['id', 'tenant_id']
    ) THEN
        RAISE EXCEPTION
            '0025_refund_fk_remediation failed: fin_refunds has no valid unique index on exactly (tenant_id, id); the FK has no target';
    END IF;

    ------------------------------------------------- the reason this migration
    -- Confirm the NOT NULL that made SET NULL impossible is still present. If
    -- this ever reports false the premise of the remediation changes and the
    -- gate must not pass silently.
    SELECT a.attnotnull INTO v_null
      FROM pg_attribute a
     WHERE a.attrelid = 'public.fin_payment_allocations'::regclass
       AND a.attname = 'tenant_id'
       AND NOT a.attisdropped;

    IF v_null IS DISTINCT FROM true THEN
        RAISE EXCEPTION
            '0025_refund_fk_remediation failed: fin_payment_allocations.tenant_id is no longer NOT NULL; re-adjudicate the ON DELETE action';
    END IF;

    ---------------------------------------------------------------- validated
    IF v_conf.convalidated IS NOT TRUE THEN
        RAISE EXCEPTION
            '0025_refund_fk_remediation failed: fin_pa_refund_fk was added NOT VALID; it is not enforced for existing rows';
    END IF;

    -------------------------------------------------------------- no orphans
    -- The old rows must satisfy the new constraint. ADD ... FOREIGN KEY
    -- validated it, so a non-zero count here means the catalog and the data
    -- disagree, which is not a state to migrate past silently.
    SELECT count(*) INTO v_orphan
      FROM fin_payment_allocations a
     WHERE a.refund_id IS NOT NULL
       AND NOT EXISTS (
             SELECT 1 FROM fin_refunds r
              WHERE r.tenant_id = a.tenant_id AND r.id = a.refund_id);

    IF v_orphan <> 0 THEN
        RAISE EXCEPTION
            '0025_refund_fk_remediation failed: % allocation(s) name a refund that does not exist in their tenant',
            v_orphan;
    END IF;
END
$assert$;

COMMIT;