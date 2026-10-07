-- 0027_fin_reconciliation.sql
-- Finance reconciliation: batches and matches with enforced finality
BEGIN;
CREATE TABLE IF NOT EXISTS fin_reconciliation_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  batch_no text NOT NULL,
  status text NOT NULL DEFAULT 'open',
  statement_file_id uuid,
  statement_ref text NOT NULL,
  statement_period_start date NOT NULL,
  statement_period_end date NOT NULL,
  statement_total numeric(19,4),
  matched_total numeric(19,4),
  variance_amount numeric(19,4) NOT NULL DEFAULT 0,
  variance_reason text,
  variance_tolerance numeric(19,4) NOT NULL DEFAULT 0,
  completion_hash text,
  completion_snapshot jsonb,
  completed_by uuid,
  completed_at timestamptz,
  cancelled_at timestamptz,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fin_recon_batches_ten_id_uq UNIQUE (tenant_id,id),
  CONSTRAINT fin_recon_batches_no_uq UNIQUE (tenant_id,batch_no),
  CONSTRAINT fin_recon_batches_file_fk FOREIGN KEY (tenant_id,statement_file_id) REFERENCES files(tenant_id,id) ON DELETE RESTRICT,
  CONSTRAINT fin_recon_batches_period_ck CHECK (statement_period_end >= statement_period_start),
  CONSTRAINT fin_recon_batches_status_ck CHECK (status IN ('open','matching','completed','cancelled')),
  CONSTRAINT fin_recon_batch_state_ck CHECK (
    (status='completed' AND completion_hash IS NOT NULL AND completion_snapshot IS NOT NULL AND completed_at IS NOT NULL AND completed_by IS NOT NULL)
    OR (status<>'completed' AND completion_hash IS NULL AND completion_snapshot IS NULL AND completed_at IS NULL AND completed_by IS NULL)
  ),
  CONSTRAINT fin_recon_batch_variance_ck CHECK (variance_amount=0 OR status<>'completed' OR (variance_reason IS NOT NULL AND length(btrim(variance_reason))>0)),
  CONSTRAINT fin_recon_batch_cancel_ck CHECK ((status='cancelled' AND cancelled_at IS NOT NULL) OR (status<>'cancelled' AND cancelled_at IS NULL))
);
REVOKE ALL ON fin_reconciliation_batches FROM school_app_rw;
REVOKE ALL ON fin_reconciliation_batches FROM PUBLIC;
CREATE TABLE IF NOT EXISTS fin_reconciliation_matches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  batch_id uuid NOT NULL,
  payment_id uuid NOT NULL,
  statement_line_ref text,
  matched_amount numeric(19,4) NOT NULL,
  is_final boolean NOT NULL DEFAULT false,
  matched_by uuid NOT NULL,
  matched_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fin_recon_matches_ten_id_uq UNIQUE (tenant_id,id),
  CONSTRAINT fin_recon_matches_batch_fk FOREIGN KEY (tenant_id,batch_id) REFERENCES fin_reconciliation_batches(tenant_id,id) ON DELETE RESTRICT,
  CONSTRAINT fin_recon_matches_payment_fk FOREIGN KEY (tenant_id,payment_id) REFERENCES fin_payments(tenant_id,id) ON DELETE RESTRICT,
  CONSTRAINT fin_recon_tenant_batch_payment_uq UNIQUE (tenant_id,batch_id,payment_id),
  CONSTRAINT fin_recon_matches_amount_ck CHECK (matched_amount>0)
);
REVOKE ALL ON fin_reconciliation_matches FROM school_app_rw;
REVOKE ALL ON fin_reconciliation_matches FROM PUBLIC;
CREATE UNIQUE INDEX IF NOT EXISTS fin_recon_payment_final_uq ON fin_reconciliation_matches (tenant_id,payment_id) WHERE is_final;
CREATE OR REPLACE FUNCTION trg_fin_recon_is_final() RETURNS trigger
    LANGUAGE plpgsql
    SECURITY INVOKER
    SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE v_batch_status text;
BEGIN
    SELECT status INTO v_batch_status
      FROM fin_reconciliation_batches
     WHERE tenant_id = NEW.tenant_id AND id = NEW.batch_id;
    IF v_batch_status IS NULL THEN
        RAISE EXCEPTION 'reconciliation batch % does not exist in this tenant', NEW.batch_id
            USING ERRCODE = '55000';
    END IF;
    NEW.is_final := (v_batch_status IN ('matching','completed'));
    IF TG_OP = 'UPDATE' AND OLD.is_final AND NOT NEW.is_final THEN
        IF v_batch_status IS DISTINCT FROM 'cancelled' THEN
            RAISE EXCEPTION 'a finalised reconciliation match cannot be un-finalised'
                USING ERRCODE = '55000';
        END IF;
    END IF;
    RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION trg_fin_recon_is_final() FROM PUBLIC;
CREATE OR REPLACE FUNCTION trg_fin_recon_batch_derive_totals() RETURNS trigger
    LANGUAGE plpgsql
    SECURITY INVOKER
    SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE v_matched numeric(19,4);
BEGIN
    IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
        RETURN NEW;
    END IF;
    IF OLD.status IN ('matching','completed') AND NEW.status NOT IN ('completed','cancelled') THEN
        IF EXISTS (SELECT 1 FROM fin_reconciliation_matches m
                    WHERE m.tenant_id = OLD.tenant_id AND m.batch_id = OLD.id
                      AND m.is_final) THEN
            RAISE EXCEPTION
                'batch % has finalised matches and may only move to completed or cancelled',
                OLD.id USING ERRCODE = '55000';
        END IF;
    END IF;
    IF NEW.status IN ('matching','completed') THEN
        SELECT COALESCE(SUM(m.matched_amount), 0) INTO v_matched
          FROM fin_reconciliation_matches m
         WHERE m.tenant_id = NEW.tenant_id AND m.batch_id = NEW.id;
        NEW.matched_total    := v_matched;
        NEW.variance_amount  := COALESCE(NEW.statement_total, 0) - v_matched;
    END IF;
    RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION trg_fin_recon_batch_derive_totals() FROM PUBLIC;
CREATE OR REPLACE FUNCTION trg_fin_recon_batch_stamp_matches() RETURNS trigger
    LANGUAGE plpgsql
    SECURITY INVOKER
    SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
    IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
        RETURN NULL;
    END IF;
    IF NEW.status IN ('matching','completed') THEN
        UPDATE fin_reconciliation_matches m
           SET is_final = true
         WHERE m.tenant_id = NEW.tenant_id AND m.batch_id = NEW.id
           AND m.is_final IS DISTINCT FROM true;
    END IF;
    IF NEW.status = 'cancelled' THEN
        UPDATE fin_reconciliation_matches m
           SET is_final = false
         WHERE m.tenant_id = NEW.tenant_id AND m.batch_id = NEW.id
           AND m.is_final;
    END IF;
    RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION trg_fin_recon_batch_stamp_matches() FROM PUBLIC;
DROP TRIGGER IF EXISTS fin_recon_is_final ON fin_reconciliation_matches;
CREATE TRIGGER fin_recon_is_final
    BEFORE INSERT OR UPDATE ON fin_reconciliation_matches
    FOR EACH ROW EXECUTE FUNCTION trg_fin_recon_is_final();
DROP TRIGGER IF EXISTS fin_recon_batch_derive_totals ON fin_reconciliation_batches;
CREATE TRIGGER fin_recon_batch_derive_totals
    BEFORE UPDATE ON fin_reconciliation_batches
    FOR EACH ROW EXECUTE FUNCTION trg_fin_recon_batch_derive_totals();
DROP TRIGGER IF EXISTS fin_recon_batch_stamp_matches ON fin_reconciliation_batches;
CREATE TRIGGER fin_recon_batch_stamp_matches
    AFTER UPDATE ON fin_reconciliation_batches
    FOR EACH ROW EXECUTE FUNCTION trg_fin_recon_batch_stamp_matches();
COMMIT;
