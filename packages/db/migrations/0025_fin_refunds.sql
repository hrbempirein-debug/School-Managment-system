-- =============================================================================
-- 0025_fin_refunds.sql
--
-- WHAT
-- Phase 7 (Fees & Finance) migration 5 of 9. Refund foundation / write-once
-- requested staging.
--
-- Creates:
--   fin_refunds
--   trg_fin_refund_provenance() - provenance enforcement (non-vacuous)
--   fn_fin_refund_ceiling() - deferred refund ceiling enforcement
--
-- Adds FK constraint:
--   fin_payment_allocations → fin_refunds (closes 0024 forward-ref window)
--
-- BOUND triggers (3):
--   fin_pa_refund_prov_trg - BEFORE INSERT OR UPDATE ON fin_payment_allocations
--   fin_refunds_prov_trg   - BEFORE INSERT OR UPDATE ON fin_refunds
--   fin_allocations_refund_ceiling (CONSTRAINT TRIGGER, DEFERRABLE INITIALLY DEFERRED)
--     - AFTER INSERT OR UPDATE ON fin_payment_allocations
--
-- NOTE
-- This migration owns ONLY refund foundation/staging. It does NOT create
-- postRefundApproval (F11), postRefundProcess (F12), app_consume_step_up (F8),
-- or post_fin_ledger_group (F4). Those are owned by later migrations per the
-- approved design.
--
-- 0025 is a write-once staging checkpoint: only INSERT of 'requested' refunds
-- is executable; UPDATE of status/server-owned fields is denied to runtime role.
-- =============================================================================

BEGIN;

-- 1. fin_refunds table
CREATE TABLE fin_refunds (
    id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id               uuid NOT NULL,
    refund_no               text NOT NULL,
    payment_id              uuid NOT NULL,
    amount                  numeric(19,4) NOT NULL CHECK (amount > 0),
    status                  text NOT NULL DEFAULT 'requested'
                            CHECK (status IN ('requested', 'approved', 'rejected', 'processed')),
    reason                  text NOT NULL,
    proposed_allocations    jsonb NOT NULL
                            CHECK (jsonb_typeof(proposed_allocations) = 'array'),
    applied_allocations     jsonb
                            CHECK (applied_allocations IS NULL
                                OR jsonb_typeof(applied_allocations) = 'array'),
    requested_by            uuid NOT NULL,
    requested_at            timestamptz NOT NULL DEFAULT now(),
    decided_by              uuid,
    decided_at              timestamptz,
    processed_by            uuid,
    processed_at            timestamptz,
    rejection_reason        text,
    disbursement_reference  text,
    idempotency_key         text NOT NULL,
    CONSTRAINT fin_refunds_payment_fk
        FOREIGN KEY (tenant_id, payment_id)
        REFERENCES fin_payments (tenant_id, id) ON DELETE RESTRICT,
    CONSTRAINT fin_refunds_no_uq UNIQUE (tenant_id, refund_no),
    CONSTRAINT fin_refunds_idem_uq UNIQUE (tenant_id, idempotency_key),
    CONSTRAINT fin_refunds_decision_ck CHECK (
        (status = 'requested'
            AND decided_by IS NULL AND decided_at IS NULL
            AND rejection_reason IS NULL
            AND disbursement_reference IS NULL
            AND applied_allocations IS NULL)
     OR (status = 'approved'
            AND decided_by IS NOT NULL AND decided_at IS NOT NULL
            AND rejection_reason IS NULL
            AND disbursement_reference IS NULL
            AND applied_allocations IS NOT NULL)
     OR (status = 'processed'
            AND decided_by IS NOT NULL AND decided_at IS NOT NULL
            AND processed_by IS NOT NULL AND processed_at IS NOT NULL
            AND rejection_reason IS NULL
            AND disbursement_reference IS NOT NULL
            AND applied_allocations IS NOT NULL)
     OR (status = 'rejected'
            AND decided_by IS NOT NULL AND decided_at IS NOT NULL
            AND processed_by IS NULL AND processed_at IS NULL
            AND rejection_reason IS NOT NULL
            AND disbursement_reference IS NULL
            AND applied_allocations IS NULL)
    )
);

CREATE UNIQUE INDEX fin_refunds_ten_id_uq ON fin_refunds (tenant_id, id);

REVOKE ALL ON TABLE fin_refunds FROM school_app_rw;

-- 2. Add FK from fin_payment_allocations to fin_refunds
ALTER TABLE fin_payment_allocations
    ADD CONSTRAINT fin_pa_refund_fk
        FOREIGN KEY (tenant_id, refund_id)
        REFERENCES fin_refunds (tenant_id, id) ON DELETE SET NULL;

-- 3. Provenance enforcement function
CREATE OR REPLACE FUNCTION trg_fin_refund_provenance()
    RETURNS trigger
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    v_refund  fin_refunds;
    v_stray   fin_payment_allocations;
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
        RETURN NEW;
    END IF;

    IF TG_TABLE_NAME = 'fin_refunds' THEN
        FOR v_stray IN
            SELECT a.id, a.payment_id
              FROM fin_payment_allocations a
             WHERE a.tenant_id = NEW.tenant_id
               AND a.refund_id = NEW.id
               AND a.payment_id IS DISTINCT FROM NEW.payment_id
             FOR UPDATE
        LOOP
            RAISE EXCEPTION
                'refund % already carries a reversal naming payment %, but the refund names payment %',
                NEW.id, v_stray.payment_id, NEW.payment_id
                USING ERRCODE = '55000';
        END LOOP;

        PERFORM 1
          FROM fin_payment_allocations a
         WHERE a.tenant_id = NEW.tenant_id
           AND a.refund_id = NEW.id
           AND a.payment_id IS DISTINCT FROM NEW.payment_id
           LIMIT 1;

        IF FOUND THEN
            RAISE EXCEPTION
                'refund % has reversal allocations with mismatched payment_id',
                NEW.id
                USING ERRCODE = '55000';
        END IF;

        RETURN NEW;
    END IF;

    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION trg_fin_refund_provenance() FROM PUBLIC;

-- 4. Refund ceiling enforcement (deferred)
CREATE OR REPLACE FUNCTION fn_fin_refund_ceiling()
    RETURNS trigger
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    v_payment_id  uuid;
    v_tenant      uuid;
    v_refunded    numeric(19,4);
    v_applied     numeric(19,4);
    rec           RECORD;
BEGIN
    IF TG_OP = 'DELETE' THEN
        v_payment_id := OLD.payment_id;
        v_tenant := OLD.tenant_id;
    ELSE
        v_payment_id := NEW.payment_id;
        v_tenant := NEW.tenant_id;
    END IF;

    FOR rec IN
        SELECT r.id, r.amount
          FROM fin_refunds r
         WHERE r.tenant_id = v_tenant
           AND r.payment_id = v_payment_id
    LOOP
        SELECT COALESCE(SUM(ABS(a.amount)), 0)
          INTO v_refunded
          FROM fin_payment_allocations a
         WHERE a.tenant_id = v_tenant
           AND a.refund_id = rec.id
           AND a.effect = 'reverse';

        IF v_refunded > rec.amount + 0.0001 THEN
            RAISE EXCEPTION
                'refund % ceiling violated: refunded %.4f exceeds refund amount %.4f',
                rec.id, v_refunded, rec.amount
                USING ERRCODE = '55000';
        END IF;
    END LOOP;

    SELECT COALESCE(SUM(ABS(a.amount)), 0)
      INTO v_refunded
      FROM fin_payment_allocations a
     WHERE a.tenant_id = v_tenant
       AND a.payment_id = v_payment_id
       AND a.effect = 'reverse'
       AND a.refund_id IS NOT NULL;

    SELECT COALESCE(SUM(a.amount), 0)
      INTO v_applied
      FROM fin_payment_allocations a
     WHERE a.tenant_id = v_tenant
       AND a.payment_id = v_payment_id
       AND a.effect = 'apply'
       AND a.invoice_id IS NOT NULL
       AND a.refund_id IS NULL;

    IF v_applied < 0 THEN
        v_applied := 0;
    END IF;

    IF v_refunded > v_applied + 0.0001 THEN
        RAISE EXCEPTION
            'refund ceiling violated: total refunded %.4f exceeds applied %.4f on payment',
            v_refunded, v_applied
            USING ERRCODE = '55000';
    END IF;

    RETURN NEW;
END;
$$;


REVOKE ALL ON FUNCTION fn_fin_refund_ceiling() FROM PUBLIC;

-- 5. Triggers
CREATE TRIGGER fin_pa_refund_prov_trg
    BEFORE INSERT OR UPDATE ON fin_payment_allocations
    FOR EACH ROW EXECUTE FUNCTION trg_fin_refund_provenance();

CREATE TRIGGER fin_refunds_prov_trg
    BEFORE INSERT OR UPDATE ON fin_refunds
    FOR EACH ROW EXECUTE FUNCTION trg_fin_refund_provenance();

CREATE CONSTRAINT TRIGGER fin_allocations_refund_ceiling
    AFTER INSERT OR UPDATE ON fin_payment_allocations
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION fn_fin_refund_ceiling();

-- 6. Grants
GRANT SELECT, INSERT ON fin_refunds TO school_app_rw;
GRANT SELECT, INSERT ON fin_payment_allocations TO school_app_rw;

-- 7. Indexes
CREATE INDEX fin_refunds_tenant_payment_idx ON fin_refunds (tenant_id, payment_id);
CREATE INDEX fin_refunds_tenant_status_idx ON fin_refunds (tenant_id, status);
CREATE INDEX fin_refunds_requested_by_idx ON fin_refunds (tenant_id, requested_by);
COMMIT;
