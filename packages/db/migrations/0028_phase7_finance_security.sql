-- ============================================================================
-- 0028_phase7_finance_security.sql
--
-- Phase 7 finance security: the F1 actor-class correction, the MFA crypto
-- helpers, the self-visible MFA + step-up storage, the refund state machine
-- (F11/F12) with its RBAC (K/F13) and outbox (F14) helpers, the full
-- fin_* row-level-security posture, the fees.* permission backfill, and the
-- runtime grant surface.
--
-- Implemented from, in descending authority:
--   1. docs/PHASE_7_0028_DESIGN_RECONCILIATION.md  (the disposition of every found
--      drift, and the normative policy matrix / grant shapes / rulings)
--   2. docs/PHASE_7_P209_MFA_CRYPTO_CONTRACT.md    (crypto helpers, grants, vectors)
--   3. docs/PHASE_7_FINANCE_DESIGN.md              (normative function bodies)
--
-- Every deviation from the design's printed text is a *decided* adaptation, and
-- each is marked in this file at its site:
--   A1. F1 loses the `WHEN app_privileged() THEN 'system'` arm (recon ruling 5).
--   A2. The five crypto helpers are written per the P2-09 contract, not the
--       design's "specified by contract" deferral.
--   A3. auth_mfa_factors / auth_step_up_challenges policies are NO-`TO`
--       self-policies (no `app_privileged()` branch, no TO role) per §35.4
--       lines 15386-15387 and the P2-09 contract §2. A policy with `TO
--       school_app_rw` does not bind the owner, so the SECURITY DEFINER
--       verifier/mint/consume functions would read zero rows under FORCE RLS.
--   A4. `app_ctx_session_id()` is NOT created (P2-10 deferred, recon ruling 8/9):
--       F11/F12 take `p_session_id` explicitly and thread it into
--       `app_consume_step_up`.
--   A5. Ledger/outbox event names are the ratified 0026 catalogue spellings
--       `refund.approved` / `refund.processed` (/ `refund.rejected` for the
--       outbox only) - never `fee.refund.*` (recon §E.1 / ruling I.2).
--   A6. F11's reversal INSERT uses fin_payment_allocations' `reason` +
--       `created_by` (NOT a `memo` column, which does not exist) and inlines the
--       §12.2 `payment_applied()` definition (the function is absent).
--   A7. trg_fin_reversal_shape_check is re-issued forward (SECURITY INVOKER
--       preserved) with an `effect = 'apply'` target test on every branch using
--       a FOR UPDATE read (recon §F item 3).
--   A8. fn_fin_refund_ceiling is re-issued forward as SECURITY INVOKER, keeping
--       the live posture and its deferred constraint-trigger binding.
--   A9. trg_fin_refund_state (BEFORE UPDATE OF status) encodes §35.7's seven
--       transitions; the design's "no trigger" prose is superseded by recon
--       §F item 4.
--   A10. fin_receipts DELETE policy is OMITTED per the recon matrix (§B.2.10);
--        §H's finance-payments.test.ts:2151 is inverted in the test phase to
--        assert the silent 0-row refusal rather than a 55000.
--   A11. Grants are issued LAST, after policies and assertions (§C.4 / §D.2).
--   A12. The §20.5 backfill is scoped to `is_system = true` roles with a
--        before/after checksum over non-system roles and a principal
--        post-condition.
--   A13. auth_step_up_challenges gets per-command S/I/U policies, NOT the
--        design's `FOR ALL`: recon §B.1 says auth_* "DELETE omitted", and a
--        `FOR ALL` policy would grant an RLS DELETE arm that omitted rejects.
--        Semantically seed-identical for the three commands that exist.
-- ============================================================================

-- pgcrypto is required for the HMAC / PGP primitives below (and is already in
-- use by 0001/0002). Keep the guard, per design §19.8.5.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ============================================================================
-- 1. F1 - app_finance_actor_class()  (recon §E ruling 5; 0021:356 is unchanged)
-- ----------------------------------------------------------------------------
-- The 'system' arm is deleted because Probe B proved it returns 'system' for
-- EVERY SECURITY DEFINER caller (inside a definer body current_user is the
-- owner, so app_privileged() is unconditionally true), which makes the C
-- predicate of every policy false and denies all runtime access. Class is
-- derived solely from the signed session claims (app_ctx_scope/user) plus the
-- RBAC join. 'system' ceases to be a produced value.
CREATE OR REPLACE FUNCTION app_finance_actor_class() RETURNS text
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path = pg_catalog, public, pg_temp
AS $$
    SELECT CASE
        WHEN app_ctx_scope() <> 'tenant' THEN 'none'
        WHEN EXISTS (
            SELECT 1 FROM memberships m
            JOIN membership_roles mr ON mr.membership_id = m.id
            JOIN roles r ON r.id = mr.role_id
            WHERE m.tenant_id = app_current_tenant_id()
              AND m.user_id = app_ctx_user()
              AND m.status = 'active'
              AND r.tenant_id = m.tenant_id
              AND r.code IN ('school_owner','accountant','cashier')
        ) THEN 'finance_staff'
        WHEN EXISTS (
            SELECT 1 FROM memberships m
            JOIN membership_roles mr ON mr.membership_id = m.id
            JOIN roles r ON r.id = mr.role_id
            WHERE m.tenant_id = app_current_tenant_id()
              AND m.user_id = app_ctx_user()
              AND m.status = 'active'
              AND r.tenant_id = m.tenant_id
              AND r.code = 'principal'
        ) THEN 'reporting_staff'
        WHEN EXISTS (
            SELECT 1 FROM guardians g
            JOIN student_guardians sg
              ON sg.tenant_id = g.tenant_id AND sg.guardian_id = g.id
            WHERE g.tenant_id = app_current_tenant_id()
              AND g.user_id = app_ctx_user() AND g.deleted_at IS NULL
              AND sg.deleted_at IS NULL
        ) THEN 'guardian'
        WHEN EXISTS (
            SELECT 1 FROM students s
            WHERE s.tenant_id = app_current_tenant_id()
              AND s.user_id = app_ctx_user() AND s.deleted_at IS NULL
        ) THEN 'student_self'
        ELSE 'none'
    END
$$;
REVOKE ALL ON FUNCTION app_finance_actor_class() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_finance_actor_class() TO school_app_rw;

-- F2-set helpers are already granted; re-assert per §D.4 (idempotent).
REVOKE ALL ON FUNCTION app_finance_linked_students() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_finance_linked_students() TO school_app_rw;
REVOKE ALL ON FUNCTION app_finance_current_guardian_ids() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_finance_current_guardian_ids() TO school_app_rw;

-- ============================================================================
-- 2. The five MFA crypto helpers (P2-09 contract Decisions 2-5)  (adaptation A2)
-- ----------------------------------------------------------------------------
-- Key material is the existing `app_ctx_secret()` from 0002 (Decision 1). The
-- runtime grant exists EXACTLY where the API process calls the helper
-- directly (app_secret_digest for email enrollment, app_mfa_encrypt for TOTP
-- enrollment); the verifier-only helpers carry no runtime grant.
-- Every helper: SET search_path, REVOKE ALL FROM PUBLIC, SECURITY DEFINER
-- owned by school_migrator.

-- D2 - app_secret_digest(text) -> bytea  (HMAC-SHA256; the email digest)
CREATE OR REPLACE FUNCTION app_secret_digest(p_code text) RETURNS bytea
    LANGUAGE plpgsql
    STABLE SECURITY DEFINER
    SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
    IF p_code IS NULL THEN
        RETURN NULL;
    END IF;
    RETURN hmac(
        convert_to(p_code, 'utf8'),
        convert_to(app_ctx_secret(), 'utf8'),
        'sha256'
    );
END $$;
REVOKE ALL ON FUNCTION app_secret_digest(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_secret_digest(text) TO school_app_rw;

-- D3 - app_secret_equals(bytea, bytea) -> boolean  (constant time, no early exit)
CREATE OR REPLACE FUNCTION app_secret_equals(p_a bytea, p_b bytea) RETURNS boolean
    LANGUAGE plpgsql
    STABLE SECURITY DEFINER
    SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    v_len_equal boolean := octet_length(p_a) = octet_length(p_b);
    v_len       int    := greatest(octet_length(p_a), octet_length(p_b));
    v_acc       int    := 0;
    v_i         int;
    v_ba        int;
    v_bb        int;
BEGIN
    IF p_a IS NULL OR p_b IS NULL THEN
        RETURN FALSE;
    END IF;
    FOR v_i IN 0 .. v_len - 1 LOOP
        v_ba := CASE WHEN v_i < octet_length(p_a) THEN get_byte(p_a, v_i) ELSE 0 END;
        v_bb := CASE WHEN v_i < octet_length(p_b) THEN get_byte(p_b, v_i) ELSE 0 END;
        v_acc := v_acc | (v_ba # v_bb);
    END LOOP;
    RETURN v_len_equal AND v_acc = 0;
END $$;
REVOKE ALL ON FUNCTION app_secret_equals(bytea, bytea) FROM PUBLIC;
-- NO grant to school_app_rw: only F7 calls it (design 11847-11849).

-- D4 - app_totp_verify(secret bytea, code text, at timestamptz) -> boolean
--      RFC 6238, HMAC-SHA1, 30 s step, 6 digits, ±1 window, dynamic truncation.
--      The counter is encoded as int8send() - PostgreSQL's binary output IS
--      network-byte-order big-endian, the RFC 4226 §5.3 form (contract lines
--      287-291). pg_catalog.send(int8) is NOT an alternative.
CREATE OR REPLACE FUNCTION app_totp_verify(
    p_secret bytea,
    p_code   text,
    p_at     timestamptz
) RETURNS boolean
    LANGUAGE plpgsql
    STABLE SECURITY DEFINER
    SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    v_counter  bigint;
    v_delta    integer;
    v_expected text;
    v_hs       bytea;
    v_offset   integer;
    v_bin      integer;
BEGIN
    IF p_secret IS NULL OR p_code IS NULL OR p_at IS NULL THEN
        RETURN FALSE;
    END IF;
    IF p_code !~ '^[0-9]{6}$' THEN
        RETURN FALSE;
    END IF;
    v_counter := floor(extract(epoch FROM p_at) / 30.0)::bigint;
    FOR v_delta IN -1 .. 1 LOOP
        v_hs := hmac(
            int8send((v_counter + v_delta)::int8),
            p_secret,
            'sha1'
        );
        v_offset := get_byte(v_hs, 19) & 15;
        v_bin := ((get_byte(v_hs, v_offset) & 127) << 24)
               | (get_byte(v_hs, v_offset+1) << 16)
               | (get_byte(v_hs, v_offset+2) << 8)
               | (get_byte(v_hs, v_offset+3));
        v_expected := lpad(((v_bin % 1000000))::text, 6, '0');
        IF v_expected = p_code THEN
            RETURN TRUE;
        END IF;
    END LOOP;
    RETURN FALSE;
END $$;
REVOKE ALL ON FUNCTION app_totp_verify(bytea, text, timestamptz) FROM PUBLIC;
-- NO grant to school_app_rw: only F7 calls it.

-- D5a - app_mfa_encrypt(bytea) -> bytea  (TOTP seed envelope encryption)
CREATE OR REPLACE FUNCTION app_mfa_encrypt(p_secret bytea) RETURNS bytea
    LANGUAGE plpgsql
    VOLATILE SECURITY DEFINER
    SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
    IF p_secret IS NULL THEN
        RETURN NULL;
    END IF;
    RETURN pgp_sym_encrypt(
        p_secret,
        app_ctx_secret(),
        'compress-algo=0, cipher-algo=aes256, s2k-mode=1'
    );
END $$;
REVOKE ALL ON FUNCTION app_mfa_encrypt(bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_mfa_encrypt(bytea) TO school_app_rw;

-- D5b - app_mfa_decrypt(bytea) -> bytea  (envelope decryption; F7 is the only path)
CREATE OR REPLACE FUNCTION app_mfa_decrypt(p_data bytea) RETURNS bytea
    LANGUAGE plpgsql
    STABLE SECURITY DEFINER
    SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    v_out bytea;
BEGIN
    IF p_data IS NULL THEN
        RETURN NULL;
    END IF;
    BEGIN
        v_out := pgp_sym_decrypt_bytea(
            p_data,
            app_ctx_secret()
        );
    EXCEPTION WHEN others THEN
        RETURN NULL;
    END;
    RETURN v_out;
END $$;
REVOKE ALL ON FUNCTION app_mfa_decrypt(bytea) FROM PUBLIC;
-- NO grant to school_app_rw: F7 must remain the only path by which a factor's
-- secret is ever read (design 11848-11849).

-- ============================================================================
-- 3. auth_mfa_factors  (design §19.8.1, with adaptation A3)
-- ----------------------------------------------------------------------------
-- Self-service only: a user enrolls/list/revokes their OWN factors, nobody else
-- reads them (secret_digest is a credential), and there is deliberately NO
-- app_privileged() branch - a migrator backfill is not a use case that justifies
-- a readable TOTP seed.
-- Policies are issued with NO `TO` clause so that the SECURITY DEFINER
-- functions (F7/F8/F9/F10) running as the owner still match them under FORCE
-- RLS. A `TO school_app_rw` policy would not bind the owner and the definers
-- would silently read zero rows.
CREATE TABLE auth_mfa_factors (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id        uuid NOT NULL,
    factor_type    text NOT NULL CHECK (factor_type IN ('totp','email_code')),
    label          text NOT NULL,
    secret_ciphertext bytea,
    secret_digest  bytea,
    confirmed_at   timestamptz,
    last_used_at   timestamptz,
    revoked_at     timestamptz,
    created_at     timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT auth_mfa_factors_user_fk
        FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
    CONSTRAINT auth_mfa_factors_uq UNIQUE (user_id, factor_type, label),
    CONSTRAINT auth_mfa_factors_secret_ck CHECK (
        (factor_type = 'totp'       AND secret_ciphertext IS NOT NULL AND secret_digest IS NULL)
     OR (factor_type = 'email_code' AND secret_ciphertext IS NULL     AND secret_digest IS NOT NULL)
    ),
    CONSTRAINT auth_mfa_factors_revoked_ck CHECK (
        revoked_at IS NULL OR confirmed_at IS NOT NULL
    ),
    CONSTRAINT auth_mfa_factors_confirm_once_ck CHECK (
        confirmed_at IS NULL OR confirmed_at >= created_at
    )
);
REVOKE ALL ON auth_mfa_factors FROM school_app_rw;
REVOKE ALL ON auth_mfa_factors FROM PUBLIC;

ALTER TABLE auth_mfa_factors ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_mfa_factors FORCE  ROW LEVEL SECURITY;

-- No DELETE policy and no DELETE ACL: revocation is the soft-revoke UPDATE of
-- revoked_at, which is the audit record that the authenticator existed.
CREATE POLICY auth_mfa_factors_self ON auth_mfa_factors
    FOR SELECT USING (user_id = app_current_user_id());
CREATE POLICY auth_mfa_factors_insert ON auth_mfa_factors
    FOR INSERT WITH CHECK (user_id = app_current_user_id());
CREATE POLICY auth_mfa_factors_update ON auth_mfa_factors
    FOR UPDATE
    USING      (user_id = app_current_user_id())
    WITH CHECK (user_id = app_current_user_id());

GRANT SELECT, INSERT, UPDATE ON auth_mfa_factors TO school_app_rw;

-- ============================================================================
-- 4. auth_step_up_challenges  (design §19.8.1, with adaptation A3)
-- ----------------------------------------------------------------------------
-- One single-use, single-tenant step-up assertion bound to the exact operation
-- being authorised. RLS: a challenge is read and written only by the session
-- that owns it, in the tenant the signed context names. No admin branch.
CREATE TABLE auth_step_up_challenges (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid NOT NULL,
    user_id         uuid NOT NULL,
    session_id      uuid NOT NULL,
    action          text NOT NULL CHECK (action IN ('refund.approve','refund.process')),
    resource_type   text NOT NULL CHECK (resource_type = 'fin_refunds'),
    resource_id     uuid NOT NULL,
    resource_amount numeric(19,4) NOT NULL CHECK (resource_amount > 0),
    code_digest     bytea NOT NULL,
    attempts_left   smallint NOT NULL DEFAULT 3 CHECK (attempts_left >= 0),
    consumed_at     timestamptz,
    expires_at      timestamptz NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT auth_step_up_tenant_fk
        FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE CASCADE,
    CONSTRAINT auth_step_up_session_fk
        FOREIGN KEY (session_id) REFERENCES auth_sessions (id) ON DELETE CASCADE,
    CONSTRAINT auth_step_up_user_fk
        FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
    CONSTRAINT auth_step_up_expiry_ck CHECK (expires_at > created_at),
    CONSTRAINT auth_step_up_single_use_ck CHECK (consumed_at IS NULL OR consumed_at >= created_at),
    CONSTRAINT auth_step_up_ten_id_uq UNIQUE (tenant_id, id)
);
REVOKE ALL ON auth_step_up_challenges FROM school_app_rw;
REVOKE ALL ON auth_step_up_challenges FROM PUBLIC;

ALTER TABLE auth_step_up_challenges ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_step_up_challenges FORCE  ROW LEVEL SECURITY;

CREATE POLICY auth_step_up_self_select ON auth_step_up_challenges
    FOR SELECT
    USING (tenant_id = app_current_tenant_id() AND user_id = app_current_user_id());
CREATE POLICY auth_step_up_self_insert ON auth_step_up_challenges
    FOR INSERT
    WITH CHECK (tenant_id = app_current_tenant_id() AND user_id = app_current_user_id());
CREATE POLICY auth_step_up_self_update ON auth_step_up_challenges
    FOR UPDATE
    USING      (tenant_id = app_current_tenant_id() AND user_id = app_current_user_id())
    WITH CHECK (tenant_id = app_current_tenant_id() AND user_id = app_current_user_id());
-- NO DELETE policy (recon §B.1) and NO DELETE ACL (Shape 6): a challenge is
-- retired by consumed_at, never by deletion. (The design's printed `FOR ALL`
-- is split per-command so DELETE has no policy arm at all.)

GRANT SELECT, INSERT, UPDATE ON auth_step_up_challenges TO school_app_rw;

-- Monotonicity guard the CHECKs cannot express (they cannot reference OLD):
-- the four binding columns are immutable, consumed_at only ever moves
-- NULL -> a timestamp, attempts_left only ever decreases.
CREATE FUNCTION trg_auth_step_up_immutable() RETURNS trigger
    LANGUAGE plpgsql SECURITY INVOKER
    SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
    IF NEW.tenant_id       IS DISTINCT FROM OLD.tenant_id
       OR NEW.user_id       IS DISTINCT FROM OLD.user_id
       OR NEW.session_id    IS DISTINCT FROM OLD.session_id
       OR NEW.action        IS DISTINCT FROM OLD.action
       OR NEW.resource_type IS DISTINCT FROM OLD.resource_type
       OR NEW.resource_id   IS DISTINCT FROM OLD.resource_id
       OR NEW.resource_amount IS DISTINCT FROM OLD.resource_amount
       OR NEW.code_digest   IS DISTINCT FROM OLD.code_digest
       OR NEW.created_at    IS DISTINCT FROM OLD.created_at
       OR NEW.expires_at    IS DISTINCT FROM OLD.expires_at
    THEN
        RAISE EXCEPTION 'step-up challenge binding is immutable'
            USING ERRCODE = '55000';
    END IF;
    IF OLD.consumed_at IS NOT NULL AND NEW.consumed_at IS DISTINCT FROM OLD.consumed_at THEN
        RAISE EXCEPTION 'step-up challenge is already consumed'
            USING ERRCODE = '55000';
    END IF;
    IF NEW.attempts_left > OLD.attempts_left THEN
        RAISE EXCEPTION 'step-up attempts_left may only decrease'
            USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION trg_auth_step_up_immutable() FROM PUBLIC;
CREATE TRIGGER auth_step_up_immutable
    BEFORE UPDATE ON auth_step_up_challenges
    FOR EACH ROW EXECUTE FUNCTION trg_auth_step_up_immutable();

-- At most ONE live (unconsumed) challenge per session/action/resource.
CREATE UNIQUE INDEX auth_step_up_live_uq
    ON auth_step_up_challenges (tenant_id, session_id, action, resource_id)
    WHERE consumed_at IS NULL;
CREATE INDEX auth_step_up_recent_idx
    ON auth_step_up_challenges (tenant_id, session_id, action, resource_id, created_at DESC);

-- ============================================================================
-- 5. F10, F9, F8, F7  (design §19.8.1/19.8.2/19.8.5 bodies, adaptation A3 only)
-- ----------------------------------------------------------------------------

-- F10 - app_confirm_mfa_factor: makes a pending factor live after proving
-- possession. The confirmation UPDATE is the one privileged write in this
-- table; restricting it to SECURITY DEFINER means the pending->confirmed
-- transition passes through a function that can also verify possession.
CREATE OR REPLACE FUNCTION app_confirm_mfa_factor(p_factor uuid, p_code text) RETURNS boolean
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE v_user uuid;
BEGIN
    SELECT user_id INTO v_user FROM auth_mfa_factors
     WHERE id = p_factor AND revoked_at IS NULL
     FOR UPDATE;
    IF NOT FOUND OR v_user IS DISTINCT FROM app_current_user_id() THEN
        RETURN FALSE;
    END IF;
    IF NOT app_verify_mfa_code(v_user, p_code, now()) THEN
        RETURN FALSE;
    END IF;
    UPDATE auth_mfa_factors
       SET confirmed_at = now()
     WHERE id = p_factor AND confirmed_at IS NULL;
    RETURN FOUND;
END $$;
REVOKE ALL ON FUNCTION app_confirm_mfa_factor(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_confirm_mfa_factor(uuid, text) TO school_app_rw;

-- F9 - app_mint_step_up_challenge: one single-use challenge bound to a refund,
-- returns the 6-digit code. The code is generated HERE, never supplied by a
-- caller. The code generator is the normative gen_random_bytes(4) form
-- (design 11749-11751), NOT random() (design 11727, explicitly superseded).
CREATE OR REPLACE FUNCTION app_mint_step_up_challenge(
    p_session_id      uuid,
    p_resource_type   text,
    p_resource_id     uuid,
    p_resource_amount numeric(19,4),
    p_action          text
) RETURNS text
    LANGUAGE plpgsql
    VOLATILE SECURITY DEFINER
    SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    v_tenant     uuid := app_current_tenant_id();
    v_user       uuid := app_ctx_user();
    v_session    auth_sessions;
    v_code       text;
    v_new_id     uuid := gen_random_uuid();
    v_expires_at timestamptz;
BEGIN
    IF v_tenant IS NULL OR v_user IS NULL THEN
        RAISE EXCEPTION 'no signed tenant context' USING ERRCODE = '42501';
    END IF;

    SELECT * INTO v_session FROM auth_sessions s
     WHERE s.id = p_session_id FOR UPDATE;
    IF NOT FOUND OR v_session.user_id IS DISTINCT FROM v_user
       OR v_session.revoked_at IS NOT NULL THEN
        RAISE EXCEPTION 'session does not belong to this actor' USING ERRCODE = '42501';
    END IF;

    -- A challenge never outlives its own authentication.
    v_expires_at := least(now() + interval '5 minutes', v_session.expires_at);
    IF v_expires_at <= now() THEN
        RAISE EXCEPTION 'session expires before a challenge could be used'
            USING ERRCODE = '55000';
    END IF;

    -- Supersede any live challenge for the same (action, resource) by
    -- CONSUMING it, not deleting it: the attempt history survives and the
    -- partial unique index cannot be violated by a re-request.
    UPDATE auth_step_up_challenges
       SET consumed_at = now()
     WHERE tenant_id = v_tenant AND session_id = p_session_id
       AND action = p_action AND resource_type = p_resource_type
       AND resource_id = p_resource_id AND consumed_at IS NULL;

    -- 6 digits from a CSPRNG: gen_random_uuid()/gen_random_bytes are pgcrypto's
    -- crypto-strong source. lpad to 8 first, take 6 - uniform over 000000-999999.
    v_code := lpad((encode(gen_random_bytes(4), 'hex')), 8, '0');
    v_code := substr(v_code, 1, 6);

    -- The plaintext is NOT stored; code_digest is HMAC-SHA256(key, code).
    INSERT INTO auth_step_up_challenges (
        id, tenant_id, session_id, user_id, action, resource_type, resource_id,
        resource_amount, code_digest, attempts_left, created_at, expires_at
    ) VALUES (
        v_new_id, v_tenant, p_session_id, v_user, p_action, p_resource_type,
        p_resource_id, p_resource_amount, app_secret_digest(v_code), 3, now(), v_expires_at
    );
    RETURN v_code;
END $$;
REVOKE ALL ON FUNCTION app_mint_step_up_challenge(uuid, text, uuid, numeric, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_mint_step_up_challenge(uuid, text, uuid, numeric, text) TO school_app_rw;

-- F8 - app_consume_step_up: consumes a step-up challenge for exactly one
-- operation, atomically, in the caller's transaction. VOLATILE because it
-- writes (the previous STABLE draft would raise 42804 on first call).
CREATE OR REPLACE FUNCTION app_consume_step_up(
    p_session_id      uuid,
    p_action          text,
    p_resource_type   text,
    p_resource_id     uuid,
    p_resource_amount numeric(19,4),
    p_code            text
) RETURNS boolean
    LANGUAGE plpgsql
    VOLATILE SECURITY DEFINER
    SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    v_tenant  uuid := app_current_tenant_id();
    v_user    uuid := app_ctx_user();
    v_ch      auth_step_up_challenges;
    v_session auth_sessions;
    v_attempt boolean;
BEGIN
    IF v_tenant IS NULL OR v_user IS NULL THEN
        RETURN FALSE;   -- fail closed: no signed context, no step-up
    END IF;

    -- Lock order is normative: SESSION first, then CHALLENGE. Every concurrent
    -- verification of this session serialises on the session row.
    SELECT * INTO v_session
    FROM auth_sessions s
    WHERE s.id = p_session_id
    FOR UPDATE;
    IF NOT FOUND THEN
        RETURN FALSE;
    END IF;

    -- SESSION/USER CROSS-CHECK: a session id read from a log or a shared link is
    -- not proof of identity on its own.
    IF v_session.user_id IS DISTINCT FROM v_user THEN
        RETURN FALSE;
    END IF;
    IF v_session.revoked_at IS NOT NULL THEN
        RETURN FALSE;
    END IF;
    IF now() >= v_session.expires_at THEN
        RETURN FALSE;
    END IF;

    -- Lock the live challenge for THIS session/action/resource. FOR UPDATE plus
    -- the partial unique index means two concurrent verifications cannot both
    -- succeed.
    SELECT * INTO v_ch
    FROM auth_step_up_challenges c
    WHERE c.tenant_id = v_tenant AND c.session_id = p_session_id
      AND c.user_id = v_user
      AND c.action = p_action
      AND c.resource_type = p_resource_type
      AND c.resource_id = p_resource_id
      AND c.consumed_at IS NULL
    FOR UPDATE;
    IF NOT FOUND THEN
        RETURN FALSE;
    END IF;

    -- TTL. 5 minutes, never past the session's own expiry.
    IF v_ch.expires_at <= now() THEN
        RETURN FALSE;
    END IF;
    IF v_ch.attempts_left <= 0 THEN
        RETURN FALSE;
    END IF;

    -- BINDING, compared EXACTLY. numeric(19,4) is the money type precisely to
    -- preserve sub-paisa values; rounding to 2 decimals would weaken the check.
    IF v_ch.resource_amount <> p_resource_amount THEN
        RETURN FALSE;
    END IF;

    -- F7 takes (p_user, p_code, p_at): the user and the instant come from the
    -- LOCKED challenge row (created_at), not from route parameters.
    v_attempt := app_verify_mfa_code(v_user, p_code, v_ch.created_at);
    IF NOT v_attempt THEN
        UPDATE auth_step_up_challenges SET attempts_left = attempts_left - 1
         WHERE id = v_ch.id;
        RETURN FALSE;
    END IF;

    UPDATE auth_step_up_challenges
       SET consumed_at = now()
     WHERE id = v_ch.id;
    RETURN TRUE;
END $$;
REVOKE ALL ON FUNCTION app_consume_step_up(uuid, text, text, uuid, numeric, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_consume_step_up(uuid, text, text, uuid, numeric, text) TO school_app_rw;

-- F7 - app_verify_mfa_code: factor-specific verifier (RFC 6238 TOTP with ±1
-- step window, or a 6-digit emailed code compared in constant time). Returns
-- FALSE for every failure mode - never distinguishes them - so it is not an
-- account-enumeration oracle. STABLE + SECURITY DEFINER, as the design states.
CREATE OR REPLACE FUNCTION app_verify_mfa_code(
    p_user uuid,
    p_code text,
    p_at   timestamptz
) RETURNS boolean
    LANGUAGE plpgsql
    STABLE SECURITY DEFINER
    SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    v_ok boolean := FALSE;
    f    record;
BEGIN
    IF p_user IS NULL OR p_code IS NULL THEN
        RETURN FALSE;
    END IF;

    -- USABLE = confirmed AND not revoked. This is the single place the pending-
    -- enrollment exclusion lives; a pending factor is STORABLE but UNUSABLE.
    FOR f IN
        SELECT factor_type, secret_digest, secret_ciphertext
          FROM auth_mfa_factors
         WHERE user_id = p_user
           AND confirmed_at IS NOT NULL
           AND revoked_at IS NULL
    LOOP
        IF f.factor_type = 'email_code' THEN
            IF app_secret_equals(f.secret_digest, app_secret_digest(p_code)) THEN
                v_ok := TRUE;
            END IF;
        ELSIF f.factor_type = 'totp' THEN
            IF app_totp_verify(app_mfa_decrypt(f.secret_ciphertext), p_code, p_at) THEN
                v_ok := TRUE;
            END IF;
        END IF;
        -- No early exit on mismatch: it would leak, through timing, how many
        -- factors a user has and which one matched.
    END LOOP;
    RETURN v_ok;
END $$;
REVOKE ALL ON FUNCTION app_verify_mfa_code(uuid, text, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_verify_mfa_code(uuid, text, timestamptz) TO school_app_rw;

-- ============================================================================
-- 6. K/F13/F14 - the RBAC and outbox helpers F11/F12 depend on
-- ----------------------------------------------------------------------------

-- K - app_finance_permission_held(text)  (recon §B.0). SECURITY DEFINER so the
-- RBAC read is not filtered by the caller's own RLS reach; granted to
-- school_app_rw because policy expressions are evaluated as the session role.
-- NOT F13: K may appear in policies, F13 must not (Probe C; recon ruling 6).
CREATE FUNCTION app_finance_permission_held(p_permission text) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path = pg_catalog, public, pg_temp
AS $$
    SELECT EXISTS (
        SELECT 1
        FROM memberships m
        JOIN membership_roles mr ON mr.membership_id = m.id
        JOIN roles r            ON r.id = mr.role_id
        JOIN role_permissions rp ON rp.role_id = r.id
        WHERE m.tenant_id = app_current_tenant_id()
          AND m.user_id   = app_ctx_user()
          AND m.status    = 'active'
          AND r.tenant_id = m.tenant_id
          AND rp.permission = p_permission);
$$;
REVOKE ALL ON FUNCTION app_finance_permission_held(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_finance_permission_held(text) TO school_app_rw;

-- F13 - app_finance_actor_has_permission(text)  (recon §E ruling 6, adaptation A->F)
-- SECURITY DEFINER (the RBAC tables are RLS-scoped) and STABLE. The design's
-- `app_privileged()` short-circuit is DELETED: under a definer body current_user
-- is the owner, so it would return TRUE for every caller and make the in-body
-- check vacuous. The actor and tenant come from the signed ticket. NO EXECUTE
-- grant: only F11/F12 (definers owned by school_migrator) call it, and a
-- direct grant would hand the runtime role a standing permission oracle.
CREATE OR REPLACE FUNCTION app_finance_actor_has_permission(p_permission text)
    RETURNS boolean
    LANGUAGE sql
    STABLE
    SECURITY DEFINER
    SET search_path = pg_catalog, public, pg_temp
AS $$
    SELECT p_permission IS NOT NULL
       AND EXISTS (
            SELECT 1
              FROM memberships m
              JOIN membership_roles mr ON mr.membership_id = m.id
              JOIN roles            r  ON r.id = mr.role_id
              JOIN role_permissions rp ON rp.role_id = r.id
             WHERE m.tenant_id = app_current_tenant_id()
               AND m.user_id   = app_ctx_user()
               AND m.status    = 'active'
               AND r.tenant_id = m.tenant_id
               AND rp.permission = p_permission);
$$;
REVOKE ALL ON FUNCTION app_finance_actor_has_permission(text) FROM PUBLIC;
-- NO grant to school_app_rw (recon ruling 6).

-- F14 - app_finance_emit_event: writes one outbox_events row in the caller's
-- transaction, so a refund's state change and the event announcing it are
-- co-located. The session-tenant guard distinguishes the migrator's empty
-- ticket (a legitimate worker case) from a caller with no tenant at all, and
-- refuses events tagged for a tenant the session cannot see.
CREATE OR REPLACE FUNCTION app_finance_emit_event(
    p_event_type     text,
    p_tenant_id      uuid,
    p_aggregate_type text,
    p_aggregate_id   uuid,
    p_payload        jsonb
) RETURNS void
    LANGUAGE plpgsql
    VOLATILE
    SECURITY DEFINER
    SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    v_session_tenant uuid := app_current_tenant_id();
BEGIN
    IF v_session_tenant IS NULL THEN
        IF session_user <> 'school_migrator' THEN
            RAISE EXCEPTION 'outbox write requires a tenant-scoped session'
                USING ERRCODE = '42501';
        END IF;
    ELSIF p_tenant_id IS DISTINCT FROM v_session_tenant THEN
        RAISE EXCEPTION 'outbox tenant % does not match the session tenant %',
            p_tenant_id, v_session_tenant
            USING ERRCODE = '55000';
    END IF;
    IF p_payload IS NULL THEN
        RAISE EXCEPTION 'outbox payload must not be null'
            USING ERRCODE = '55000';
    END IF;

    INSERT INTO outbox_events (
        tenant_id, event_type, aggregate_type, aggregate_id, payload
    ) VALUES (
        p_tenant_id, p_event_type, p_aggregate_type,
        p_aggregate_id::text, p_payload
    );
END $$;
REVOKE ALL ON FUNCTION app_finance_emit_event(text, uuid, text, uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_finance_emit_event(text, uuid, text, uuid, jsonb) TO school_app_rw;

-- ============================================================================
-- 7. §F.3 - trg_fin_reversal_shape_check forward remediation  (adaptation A7)
-- ----------------------------------------------------------------------------
-- Re-issued forward from 0024:942 WITH the missing `effect = 'apply'` target
-- test, using the same FOR UPDATE structural read as
-- 0025_refund_provenance_remediation.sql:143, and reached on EVERY branch
-- including refund_id IS NULL (correction reversals). SECURITY INVOKER is
-- preserved, as 0025_lock_model_remediation.sql:457 requires.
CREATE OR REPLACE FUNCTION trg_fin_reversal_shape_check(
    p_tenant        uuid,
    p_reversal_id   uuid,            -- the reversal row's own id (NEW.id / OLD.id)
    p_target_id     uuid,            -- reversal_of_allocation_id
    p_invoice_id    uuid,            -- the invoice this reversal claims to touch
    p_amount        numeric(19,4)    -- negative, by fin_pa_effect_ck
) RETURNS void
    LANGUAGE plpgsql
    SECURITY INVOKER
    SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE v_original_invoice   uuid;
        v_original_amount    numeric(19,4);
        v_original_effect    text;
        v_already_reversed   numeric(19,4);
        v_available          numeric(19,4);
BEGIN
    IF p_target_id IS NULL THEN
        RAISE EXCEPTION 'a reversal must name the allocation it reverses'
            USING ERRCODE = '55000';
    END IF;

    SELECT a.invoice_id, a.amount, a.effect INTO v_original_invoice, v_original_amount, v_original_effect
      FROM fin_payment_allocations a
     WHERE a.tenant_id = p_tenant AND a.id = p_target_id
     FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'reversal target does not exist in this tenant'
            USING ERRCODE = '55000';
    END IF;

    -- §F.3: a reversal may only reverse an APPLIED allocation. Reached on every
    -- branch (correction and refund reversals alike).
    IF v_original_effect IS DISTINCT FROM 'apply' THEN
        RAISE EXCEPTION 'reversal target must be an applied allocation'
            USING ERRCODE = '55000';
    END IF;

    -- P1-13, part 1 of 2: a reversal may not name an invoice its target did not
    -- name.
    IF p_invoice_id IS DISTINCT FROM v_original_invoice THEN
        RAISE EXCEPTION 'reversal must target the same invoice as the allocation it reverses'
            USING ERRCODE = '55000';
    END IF;

    -- P1-13, part 2 of 2: and may not exceed the magnitude outstanding on its
    -- target. v_original_amount is the ORIGINAL applied amount (positive, by
    -- fin_pa_effect_ck).
    SELECT COALESCE(SUM(-a.amount), 0) INTO v_already_reversed
      FROM fin_payment_allocations a
     WHERE a.tenant_id = p_tenant
       AND a.reversal_of_allocation_id = p_target_id
       AND a.amount < 0
       AND a.id <> p_reversal_id;
    v_available := v_original_amount - v_already_reversed;

    IF -p_amount > v_available THEN
        RAISE EXCEPTION
            'reversal % exceeds the % still available on allocation %',
            -p_amount, v_available, p_target_id
            USING ERRCODE = '55000';
    END IF;
END $$;
REVOKE ALL ON FUNCTION trg_fin_reversal_shape_check(uuid, uuid, uuid, uuid, numeric) FROM PUBLIC;

-- ============================================================================
-- 8. §F - fn_fin_refund_ceiling re-issued forward as SECURITY INVOKER (A8)
-- ----------------------------------------------------------------------------
-- The body is unchanged from 0025:179; only the definership is aligned to the
-- live posture. The deferred constraint trigger `fin_allocations_refund_ceiling`
-- (0025:265) keeps its binding, so this CREATE OR REPLACE is transparent to it.
CREATE OR REPLACE FUNCTION fn_fin_refund_ceiling()
    RETURNS trigger
    LANGUAGE plpgsql
    SECURITY INVOKER
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

-- ============================================================================
-- 9. trg_fin_refund_state - the §35.7 transition trigger  (adaptation A9)
-- ----------------------------------------------------------------------------
-- BEFORE UPDATE OF status fires only on status-changing UPDATEs, so a
-- maintenance write that touches other columns is unaffected. Encodes the
-- seven transitions verbatim: same-status no-op; requested -> approved;
-- requested -> rejected; approved -> processed; and any other move (rejected ->
-- anything, processed -> anything, approved -> rejected) is forbidden.
CREATE FUNCTION trg_fin_refund_state() RETURNS trigger
    LANGUAGE plpgsql SECURITY INVOKER
    SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
    IF OLD.status = NEW.status THEN
        RETURN NEW;                    -- same-status no-op
    END IF;
    IF OLD.status = 'requested'
       AND NEW.status IN ('approved', 'rejected') THEN
        RETURN NEW;                    -- rows 2 and 3 of §35.7
    END IF;
    IF OLD.status = 'approved' AND NEW.status = 'processed' THEN
        RETURN NEW;                    -- row 4 of §35.7
    END IF;
    RAISE EXCEPTION 'invalid refund status transition % -> %', OLD.status, NEW.status
        USING ERRCODE = '55000';       -- rows 5, 6 and 7 of §35.7
END $$;
REVOKE ALL ON FUNCTION trg_fin_refund_state() FROM PUBLIC;

CREATE TRIGGER fin_refunds_state_trg
    BEFORE UPDATE OF status ON fin_refunds
    FOR EACH ROW EXECUTE FUNCTION trg_fin_refund_state();

-- ============================================================================
-- 10. F11 - postRefundApproval  (design 10318 + adaptations A4/A5/A6)
-- ----------------------------------------------------------------------------
-- The one UPDATE on fin_refunds in Phase 7 (requested -> approved), and the
-- reason these bodies are definers. fin_refunds_decision_ck enforces the
-- coherence of the columns F11 writes together.
-- The two names are camelCase in §E (recon 445-446) and §H:613, so they must
-- be QUOTED against identifier-folding; an unquoted postRefundApproval would
-- silently create `postrefundapproval` and the contract signature would not
-- exist.
CREATE OR REPLACE FUNCTION "postRefundApproval"(
    p_session_id uuid,
    p_refund_id  uuid,
    p_action     text
)
    RETURNS void
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    v_tenant    uuid := app_current_tenant_id();
    v_refund    fin_refunds;
    v_refundable numeric(19,4);
    v_approved  numeric(19,4);
    v_leg       jsonb;
    v_applied   jsonb := '[]'::jsonb;
    v_elem      jsonb;
    v_alloc_id  uuid;
    v_alloc_amt numeric(19,4);
    v_target    fin_payment_allocations;
BEGIN
    ------------------------------------------------------------------ step 0
    IF p_action IS DISTINCT FROM 'approve' THEN
        RAISE EXCEPTION 'postRefundApproval handles only the approve action, not %',
            coalesce(p_action, 'null')
            USING ERRCODE = '55000';
    END IF;

    ------------------------------------------------------------------ step 1
    -- Tenant-prefixed BEFORE any lock, so a foreign id resolves to zero rows
    -- rather than to a locked row in another tenant.
    SELECT * INTO v_refund
      FROM fin_refunds
     WHERE tenant_id = v_tenant AND id = p_refund_id
     FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'refund % not found in this tenant', p_refund_id
            USING ERRCODE = '55000';
    END IF;

    -- Idempotency: the loser of a concurrent approve reads 'approved' and returns
    -- without re-posting. This is the ONLY early return in the function, and it
    -- returns before any write, so a replay cannot double-post the ledger group.
    IF v_refund.status <> 'requested' THEN
        IF v_refund.status = 'approved' THEN
            RETURN;
        END IF;
        RAISE EXCEPTION 'refund % is %, not requested', p_refund_id, v_refund.status
            USING ERRCODE = '55000';
    END IF;

    ------------------------------------------------------------------ step 2
    -- F8. Consumes the challenge: decrements attempts_left and stamps
    -- consumed_at. If any later step raises, the caller's transaction rolls back
    -- and the consumption is un-done with it.
    PERFORM app_consume_step_up(
        p_session_id, 'refund.approve', 'fin_refunds',
        p_refund_id, v_refund.amount, NULL);

    ------------------------------------------------------------------ step 3
    IF v_refund.requested_by = app_current_user_id() THEN
        RAISE EXCEPTION 'a refund may not be approved by the actor who requested it'
            USING ERRCODE = '55000';
    END IF;
    IF NOT app_finance_actor_has_permission('fees.refunds.approve') THEN
        RAISE EXCEPTION 'actor lacks fees.refunds.approve'
            USING ERRCODE = '55000';
    END IF;

    ------------------------------------------------------------------ step 4
    -- Lock the payment, THEN recompute (§12.6's protocol).
    PERFORM 1 FROM fin_payments
     WHERE tenant_id = v_tenant AND id = v_refund.payment_id FOR UPDATE;

    -- Adaptation A6: §12.2's payment_applied() is inlined (the function does not
    -- exist in the schema).
    SELECT (SELECT COALESCE(SUM(a.amount), 0)
              FROM fin_payment_allocations a
             WHERE a.tenant_id = v_tenant
               AND a.payment_id = v_refund.payment_id
               AND a.refund_id IS NULL
               AND a.invoice_id IS NOT NULL)
         - COALESCE((SELECT -SUM(a.amount)
                       FROM fin_payment_allocations a
                      WHERE a.tenant_id = v_tenant
                        AND a.payment_id = v_refund.payment_id
                        AND a.refund_id IS NOT NULL), 0)
      INTO v_refundable;

    ------------------------------------------------------------------ step 5
    IF v_refundable <= 0 THEN
        RAISE EXCEPTION 'nothing_applied_to_refund: payment % has no applied cash left to refund',
            v_refund.payment_id
            USING ERRCODE = '55000';
    END IF;
    IF v_refundable < v_refund.amount THEN
        RAISE EXCEPTION 'refund_exceeds_payment: % refundable against a request for %',
            v_refundable, v_refund.amount
            USING ERRCODE = '55000';
    END IF;

    ------------------------------------------------------------------ step 6
    -- The APPLIED split, walked from the PROPOSED split. jsonb_array_elements
    -- preserves array order, and every element is resolved to a real `apply` row
    -- on this payment before a single reversal row is written.
    FOR v_elem IN
        SELECT e FROM jsonb_array_elements(v_refund.proposed_allocations) AS e
    LOOP
        v_alloc_id := (v_elem ->> 'allocation_id')::uuid;
        v_alloc_amt := (v_elem ->> 'amount')::numeric(19,4);

        IF v_alloc_amt IS NULL OR v_alloc_amt <= 0 THEN
            RAISE EXCEPTION 'proposed allocation for % carries a non-positive amount', v_alloc_id
                USING ERRCODE = '55000';
        END IF;

        SELECT * INTO v_target
          FROM fin_payment_allocations
         WHERE tenant_id = v_tenant AND id = v_alloc_id;

        IF NOT FOUND THEN
            RAISE EXCEPTION 'proposed allocation % does not exist in this tenant', v_alloc_id
                USING ERRCODE = '55000';
        END IF;
        IF v_target.payment_id IS DISTINCT FROM v_refund.payment_id
           OR v_target.effect <> 'apply' THEN
            RAISE EXCEPTION 'proposed allocation % is not an applied allocation on payment %',
                v_alloc_id, v_refund.payment_id
                USING ERRCODE = '55000';
        END IF;
        IF v_target.amount < v_alloc_amt THEN
            RAISE EXCEPTION 'proposed reversal of % exceeds the applied allocation % of %',
                v_alloc_amt, v_alloc_id, v_target.amount
                USING ERRCODE = '55000';
        END IF;

        -- amount < 0 is the outflow sign; reversal_of_allocation_id and refund_id
        -- are what trg_fin_refund_provenance and trg_fin_reversal_shape read.
        -- Adaptation A6: fin_payment_allocations carries reason + created_by
        -- (both NOT NULL), not a `memo` column.
        INSERT INTO fin_payment_allocations (
            tenant_id, payment_id, invoice_id, effect, amount,
            reversal_of_allocation_id, refund_id, reason, created_by)
        VALUES (
            v_tenant, v_refund.payment_id, v_target.invoice_id, 'reverse', -v_alloc_amt,
            v_alloc_id, v_refund.id,
            format('refund %s', v_refund.refund_no), app_current_user_id());

        v_applied := v_applied || jsonb_build_object(
            'allocation_id', v_alloc_id,
            'reversal_allocation_id',
                (SELECT a.id FROM fin_payment_allocations a
                  WHERE a.tenant_id = v_tenant AND a.refund_id = v_refund.id
                    AND a.reversal_of_allocation_id = v_alloc_id
                  ORDER BY a.id LIMIT 1),
            'amount', v_alloc_amt);
    END LOOP;

    IF jsonb_array_length(v_applied) = 0 THEN
        RAISE EXCEPTION 'refund % proposed no allocations; nothing to approve', p_refund_id
            USING ERRCODE = '55000';
    END IF;

    ------------------------------------------------------------------ step 7
    -- F4. The two-step refund, approve leg (§15.1 `REFUND - two-step`, §35.7
    -- row 2): relieve the receivable, recognise the payable. Adaptation A5: the
    -- event type is the ratified 0026 catalogue name `refund.approved`.
    v_leg := jsonb_build_array(
        jsonb_build_object('account_code', '1200', 'direction', 'debit',
                           'amount', v_refund.amount),
        jsonb_build_object('account_code', '2200', 'direction', 'credit',
                           'amount', v_refund.amount));

    PERFORM post_fin_ledger_group(
        v_tenant, 'refund.approved', v_refund.id, v_leg);

    -- The outbox row, in the SAME transaction as F8's consumption. FI-022's
    -- bijection between a consumed challenge and an approved event is only
    -- meaningful because both are written by the same transaction.
    PERFORM app_finance_emit_event('refund.approved', v_tenant, 'fin_refunds',
        v_refund.id, jsonb_build_object(
            'amount',     v_refund.amount,
            'payment_id', v_refund.payment_id));

    ------------------------------------------------------------------ step 8
    UPDATE fin_refunds
       SET status              = 'approved',
           decided_by          = app_current_user_id(),
           decided_at          = now(),
           applied_allocations = v_applied
     WHERE tenant_id = v_tenant AND id = p_refund_id;

    -- step 9 is not a statement: fn_fin_refund_ceiling is a DEFERRABLE
    -- INITIALLY DEFERRED constraint trigger and runs at COMMIT with every
    -- reversal row from step 6 visible (§13.3.1).

    RETURN;
END $$;
REVOKE ALL ON FUNCTION "postRefundApproval"(uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "postRefundApproval"(uuid, uuid, text) TO school_app_rw;

-- ============================================================================
-- 11. F12 - postRefundProcess  (design 10555 + adaptations A4/A5)
-- ----------------------------------------------------------------------------
-- The remaining two transitions: requested -> rejected and approved -> processed.
-- one function rather than two because reject posts nothing and needs no ledger
-- capability, so a single function with a constrained p_action carries strictly
-- less privilege surface. reject requires a reason; process requires a
-- disbursement reference.
CREATE OR REPLACE FUNCTION "postRefundProcess"(
    p_session_id             uuid,
    p_refund_id              uuid,
    p_action                 text,
    p_reason                 text DEFAULT NULL,
    p_disbursement_reference text DEFAULT NULL
)
    RETURNS void
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    v_tenant uuid := app_current_tenant_id();
    v_refund fin_refunds;
    v_leg    jsonb;
BEGIN
    IF p_action IS DISTINCT FROM 'process' AND p_action IS DISTINCT FROM 'reject' THEN
        RAISE EXCEPTION 'postRefundProcess handles process or reject, not %',
            coalesce(p_action, 'null')
            USING ERRCODE = '55000';
    END IF;

    SELECT * INTO v_refund
      FROM fin_refunds
     WHERE tenant_id = v_tenant AND id = p_refund_id
     FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'refund % not found in this tenant', p_refund_id
            USING ERRCODE = '55000';
    END IF;

    IF p_action = 'reject' THEN
        ---------------------------------------------------------- reject branch
        IF v_refund.status <> 'requested' THEN
            IF v_refund.status = 'rejected' THEN
                RETURN;                              -- idempotent replay
            END IF;
            RAISE EXCEPTION 'refund_already_decided: refund % is % and cannot be rejected',
                p_refund_id, v_refund.status
                USING ERRCODE = '55000';
        END IF;
        IF v_refund.requested_by = app_current_user_id() THEN
            RAISE EXCEPTION 'a refund may not be rejected by the actor who requested it'
                USING ERRCODE = '55000';
        END IF;
        IF NOT app_finance_actor_has_permission('fees.refunds.approve') THEN
            RAISE EXCEPTION 'actor lacks fees.refunds.approve'
                USING ERRCODE = '55000';
        END IF;
        IF p_reason IS NULL OR btrim(p_reason) = '' THEN
            RAISE EXCEPTION 'rejection_reason_required: a rejected refund must record why'
                USING ERRCODE = '55000';
        END IF;

        -- No allocation rows exist (that is what staging means), so nothing to
        -- reverse and nothing to post. The deferred ceiling still runs at COMMIT
        -- and finds no reversal rows for this refund, which is the correct
        -- outcome for a rejected request.
        UPDATE fin_refunds
           SET status           = 'rejected',
               decided_by       = app_current_user_id(),
               decided_at       = now(),
               rejection_reason = btrim(p_reason)
         WHERE tenant_id = v_tenant AND id = p_refund_id;

        PERFORM app_finance_emit_event('refund.rejected', v_tenant, 'fin_refunds',
            p_refund_id, jsonb_build_object('reason', btrim(p_reason)));
        RETURN;
    END IF;

    ------------------------------------------------------------- process branch
    IF v_refund.status <> 'approved' THEN
        IF v_refund.status = 'processed' THEN
            RETURN;                                  -- idempotent replay
        END IF;
        RAISE EXCEPTION 'refund_not_approved: refund % is %, not approved',
            p_refund_id, v_refund.status
            USING ERRCODE = '55000';
    END IF;
    IF NOT app_finance_actor_has_permission('fees.refunds.process') THEN
        RAISE EXCEPTION 'actor lacks fees.refunds.process'
            USING ERRCODE = '55000';
    END IF;
    -- §35.7 row 4's guard: this is where cash leaves the school, so the payout is
    -- required to be reconcilable against a bank statement.
    IF p_disbursement_reference IS NULL OR btrim(p_disbursement_reference) = '' THEN
        RAISE EXCEPTION 'disbursement_reference_required: a processed refund must record the payout reference'
            USING ERRCODE = '55000';
    END IF;

    -- F8 bound to the OTHER action. The challenge table's CHECK is action IN
    -- ('refund.approve','refund.process') precisely so a challenge minted for
    -- approval cannot be spent on disbursement.
    PERFORM app_consume_step_up(
        p_session_id, 'refund.process', 'fin_refunds',
        p_refund_id, v_refund.amount, NULL);

    -- The process leg (§35.7 row 4): extinguish the payable against cash or bank.
    -- THIS is where cash leaves. Adaptation A5: ratified catalogue event name.
    v_leg := jsonb_build_array(
        jsonb_build_object('account_code', '2200', 'direction', 'debit',
                           'amount', v_refund.amount),
        jsonb_build_object('account_code', '1000', 'direction', 'credit',
                           'amount', v_refund.amount));

    PERFORM post_fin_ledger_group(
        v_tenant, 'refund.processed', v_refund.id, v_leg);

    UPDATE fin_refunds
       SET status       = 'processed',
           processed_by = app_current_user_id(),
           processed_at = now(),
           disbursement_reference = btrim(p_disbursement_reference)
     WHERE tenant_id = v_tenant AND id = p_refund_id;

    PERFORM app_finance_emit_event('refund.processed', v_tenant, 'fin_refunds',
        p_refund_id, jsonb_build_object(
            'amount', v_refund.amount,
            'disbursement_reference', btrim(p_disbursement_reference)));
END $$;
REVOKE ALL ON FUNCTION "postRefundProcess"(uuid, uuid, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "postRefundProcess"(uuid, uuid, text, text, text) TO school_app_rw;

-- ============================================================================
-- 12. fin_* ROW LEVEL SECURITY  (recon §B.1 matrix, normative)
-- ----------------------------------------------------------------------------
-- Predicate legend (recon §B, expanded at each site):
--   P   = app_privileged()
--   T   = app_ctx_scope() = 'tenant' AND app_current_tenant_id() = <t>.tenant_id
--   C   = app_finance_actor_class() = 'finance_staff'
--   K(x)= app_finance_permission_held(x)
--   G/R = the linked-students / current-guardians reachability predicates below
-- Every policy is issued WITHOUT a `TO` clause so it binds the owner too (FORCE
-- RLS): that is what lets the SECURITY DEFINER writers below pass the P branch.
-- Each table: ENABLE + FORCE, then its policies.
-- ----------------------------------------------------------------------------

-- fin_tenant_settings --------------------------------------------------------
ALTER TABLE fin_tenant_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE fin_tenant_settings FORCE  ROW LEVEL SECURITY;
CREATE POLICY fin_tenant_settings_select ON fin_tenant_settings FOR SELECT USING (
    app_privileged()
    OR (app_ctx_scope() = 'tenant' AND app_current_tenant_id() = fin_tenant_settings.tenant_id
        AND app_finance_actor_class() = 'finance_staff'));
CREATE POLICY fin_tenant_settings_insert ON fin_tenant_settings FOR INSERT WITH CHECK (
    app_privileged()
    OR (app_ctx_scope() = 'tenant' AND app_current_tenant_id() = fin_tenant_settings.tenant_id
        AND app_finance_actor_class() = 'finance_staff'));
CREATE POLICY fin_tenant_settings_update ON fin_tenant_settings FOR UPDATE
    USING (
        app_privileged()
        OR (app_ctx_scope() = 'tenant' AND app_current_tenant_id() = fin_tenant_settings.tenant_id
            AND app_finance_actor_class() = 'finance_staff'));
CREATE POLICY fin_tenant_settings_delete ON fin_tenant_settings FOR DELETE USING (
    app_privileged());

-- fin_ledger_accounts --------------------------------------------------------
ALTER TABLE fin_ledger_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE fin_ledger_accounts FORCE  ROW LEVEL SECURITY;
CREATE POLICY fin_ledger_accounts_select ON fin_ledger_accounts FOR SELECT USING (
    app_privileged()
    OR (app_ctx_scope() = 'tenant' AND app_current_tenant_id() = fin_ledger_accounts.tenant_id
        AND app_finance_actor_class() = 'finance_staff'));
CREATE POLICY fin_ledger_accounts_insert ON fin_ledger_accounts FOR INSERT WITH CHECK (
    app_privileged());
CREATE POLICY fin_ledger_accounts_update ON fin_ledger_accounts FOR UPDATE
    USING (app_privileged());
-- DELETE policy omitted (§B.2.10): owner deletion is refused by silence.

-- fin_document_counters ------------------------------------------------------
ALTER TABLE fin_document_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE fin_document_counters FORCE  ROW LEVEL SECURITY;
CREATE POLICY fin_document_counters_select ON fin_document_counters FOR SELECT USING (
    app_privileged()
    OR (app_ctx_scope() = 'tenant' AND app_current_tenant_id() = fin_document_counters.tenant_id
        AND app_finance_actor_class() = 'finance_staff'));
CREATE POLICY fin_document_counters_insert ON fin_document_counters FOR INSERT WITH CHECK (
    app_privileged()
    OR (app_ctx_scope() = 'tenant' AND app_current_tenant_id() = fin_document_counters.tenant_id
        AND app_finance_actor_class() = 'finance_staff'));
-- UPDATE is P-only: trg_fin_invoice_number (F5d, SECURITY DEFINER) is the only
-- possible writer of a counter (recon §B.2.1).
CREATE POLICY fin_document_counters_update ON fin_document_counters FOR UPDATE
    USING (app_privileged());
CREATE POLICY fin_document_counters_delete ON fin_document_counters FOR DELETE USING (
    app_privileged());

-- fees.structures family: heads / tax profiles / structures / items / plans / targets
DO $rls_structures$
DECLARE
    t text;
    k text := 'fees.structures.manage';
BEGIN
    FOREACH t IN ARRAY ARRAY[
        'fin_fee_heads', 'fin_tax_profiles', 'fin_fee_structures',
        'fin_fee_structure_items', 'fin_fee_installment_plans', 'fin_fee_structure_targets'
    ] LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format('ALTER TABLE %I FORCE  ROW LEVEL SECURITY', t);
        EXECUTE format('CREATE POLICY %I ON %I FOR SELECT USING (
            app_privileged()
            OR (app_ctx_scope() = ''tenant'' AND app_current_tenant_id() = %I.tenant_id
                AND app_finance_actor_class() = ''finance_staff''))',
            t || '_select', t, t);
        EXECUTE format('CREATE POLICY %I ON %I FOR INSERT WITH CHECK (
            app_privileged()
            OR (app_ctx_scope() = ''tenant'' AND app_current_tenant_id() = %I.tenant_id
                AND app_finance_actor_class() = ''finance_staff''
                AND app_finance_permission_held(%L)))',
            t || '_insert', t, t, k);
        EXECUTE format('CREATE POLICY %I ON %I FOR UPDATE
            USING (
                app_privileged()
                OR (app_ctx_scope() = ''tenant'' AND app_current_tenant_id() = %I.tenant_id
                    AND app_finance_actor_class() = ''finance_staff''
                    AND app_finance_permission_held(%L)))',
            t || '_update', t, t, k);
        EXECUTE format('CREATE POLICY %I ON %I FOR DELETE USING (app_privileged())',
            t || '_delete', t);
    END LOOP;
END $rls_structures$;

-- fin_fee_assignments: K('fees.assignments.manage') -------------------------
ALTER TABLE fin_fee_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE fin_fee_assignments FORCE  ROW LEVEL SECURITY;
CREATE POLICY fin_fee_assignments_select ON fin_fee_assignments FOR SELECT USING (
    app_privileged()
    OR (app_ctx_scope() = 'tenant' AND app_current_tenant_id() = fin_fee_assignments.tenant_id
        AND app_finance_actor_class() = 'finance_staff'));
CREATE POLICY fin_fee_assignments_insert ON fin_fee_assignments FOR INSERT WITH CHECK (
    app_privileged()
    OR (app_ctx_scope() = 'tenant' AND app_current_tenant_id() = fin_fee_assignments.tenant_id
        AND app_finance_actor_class() = 'finance_staff'
        AND app_finance_permission_held('fees.assignments.manage')));
CREATE POLICY fin_fee_assignments_update ON fin_fee_assignments FOR UPDATE
    USING (
        app_privileged()
        OR (app_ctx_scope() = 'tenant' AND app_current_tenant_id() = fin_fee_assignments.tenant_id
            AND app_finance_actor_class() = 'finance_staff'
            AND app_finance_permission_held('fees.assignments.manage')));
CREATE POLICY fin_fee_assignments_delete ON fin_fee_assignments FOR DELETE USING (
    app_privileged());

-- billing runs ---------------------------------------------------------------
DO $rls_billing$
DECLARE
    t text;
BEGIN
    FOREACH t IN ARRAY ARRAY['fin_billing_runs', 'fin_billing_run_items'] LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format('ALTER TABLE %I FORCE  ROW LEVEL SECURITY', t);
        EXECUTE format('CREATE POLICY %I ON %I FOR SELECT USING (
            app_privileged()
            OR (app_ctx_scope() = ''tenant'' AND app_current_tenant_id() = %I.tenant_id
                AND app_finance_actor_class() = ''finance_staff''))',
            t || '_select', t, t);
        EXECUTE format('CREATE POLICY %I ON %I FOR INSERT WITH CHECK (
            app_privileged()
            OR (app_ctx_scope() = ''tenant'' AND app_current_tenant_id() = %I.tenant_id
                AND app_finance_actor_class() = ''finance_staff''
                AND app_finance_permission_held(''fees.assignments.manage'')))',
            t || '_insert', t, t);
        -- UPDATE is P-only (recon §B.2.6).
        EXECUTE format('CREATE POLICY %I ON %I FOR UPDATE USING (app_privileged())',
            t || '_update', t);
        EXECUTE format('CREATE POLICY %I ON %I FOR DELETE USING (app_privileged())',
            t || '_delete', t);
    END LOOP;
END $rls_billing$;

-- fin_invoices: G = the linked-students reachability predicate ---------------
ALTER TABLE fin_invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE fin_invoices FORCE  ROW LEVEL SECURITY;
CREATE POLICY fin_invoices_select ON fin_invoices FOR SELECT USING (
    app_privileged()
    OR (app_ctx_scope() = 'tenant' AND app_current_tenant_id() = fin_invoices.tenant_id
        AND (
            app_finance_actor_class() = 'finance_staff'
            OR fin_invoices.student_id IN (SELECT app_finance_linked_students())
        )));
CREATE POLICY fin_invoices_insert ON fin_invoices FOR INSERT WITH CHECK (
    app_privileged()
    OR (app_ctx_scope() = 'tenant' AND app_current_tenant_id() = fin_invoices.tenant_id
        AND app_finance_actor_class() = 'finance_staff'));
CREATE POLICY fin_invoices_update ON fin_invoices FOR UPDATE
    USING (
        app_privileged()
        OR (app_ctx_scope() = 'tenant' AND app_current_tenant_id() = fin_invoices.tenant_id
            AND app_finance_actor_class() = 'finance_staff'));
CREATE POLICY fin_invoices_delete ON fin_invoices FOR DELETE USING (
    app_privileged());

-- fin_invoice_items / fin_invoice_adjustments: class-only writes -------------
DO $rls_lines$
DECLARE
    t text;
BEGIN
    FOREACH t IN ARRAY ARRAY['fin_invoice_items', 'fin_invoice_adjustments'] LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format('ALTER TABLE %I FORCE  ROW LEVEL SECURITY', t);
        EXECUTE format('CREATE POLICY %I ON %I FOR SELECT USING (
            app_privileged()
            OR (app_ctx_scope() = ''tenant'' AND app_current_tenant_id() = %I.tenant_id
                AND app_finance_actor_class() = ''finance_staff''))',
            t || '_select', t, t);
        EXECUTE format('CREATE POLICY %I ON %I FOR INSERT WITH CHECK (
            app_privileged()
            OR (app_ctx_scope() = ''tenant'' AND app_current_tenant_id() = %I.tenant_id
                AND app_finance_actor_class() = ''finance_staff''))',
            t || '_insert', t, t);
        EXECUTE format('CREATE POLICY %I ON %I FOR UPDATE
            USING (
                app_privileged()
                OR (app_ctx_scope() = ''tenant'' AND app_current_tenant_id() = %I.tenant_id
                    AND app_finance_actor_class() = ''finance_staff''))',
            t || '_update', t, t);
        EXECUTE format('CREATE POLICY %I ON %I FOR DELETE USING (app_privileged())',
            t || '_delete', t);
    END LOOP;
END $rls_lines$;

-- fin_challans: G via the owning invoice (adaptation: fin_challans has no
-- student_id, so reachability is resolved through fin_invoices) ---------------
ALTER TABLE fin_challans ENABLE ROW LEVEL SECURITY;
ALTER TABLE fin_challans FORCE  ROW LEVEL SECURITY;
CREATE POLICY fin_challans_select ON fin_challans FOR SELECT USING (
    app_privileged()
    OR (app_ctx_scope() = 'tenant' AND app_current_tenant_id() = fin_challans.tenant_id
        AND (
            app_finance_actor_class() = 'finance_staff'
            OR fin_challans.invoice_id IN (
                SELECT fi.id FROM fin_invoices fi
                 WHERE fi.student_id IN (SELECT app_finance_linked_students()))
        )));
CREATE POLICY fin_challans_insert ON fin_challans FOR INSERT WITH CHECK (
    app_privileged()
    OR (app_ctx_scope() = 'tenant' AND app_current_tenant_id() = fin_challans.tenant_id
        AND app_finance_actor_class() = 'finance_staff'
        AND app_finance_permission_held('fees.invoices.issue')));
-- UPDATE is P-only: trg_fin_challan_refresh (0024:893, SECURITY DEFINER) is the
-- only possible writer (recon §B.2.2).
CREATE POLICY fin_challans_update ON fin_challans FOR UPDATE
    USING (app_privileged());
CREATE POLICY fin_challans_delete ON fin_challans FOR DELETE USING (
    app_privileged());

-- fin_payments / fin_payment_allocations -------------------------------------
DO $rls_pay$
DECLARE
    t text;
BEGIN
    FOREACH t IN ARRAY ARRAY['fin_payments', 'fin_payment_allocations'] LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format('ALTER TABLE %I FORCE  ROW LEVEL SECURITY', t);
        EXECUTE format('CREATE POLICY %I ON %I FOR SELECT USING (
            app_privileged()
            OR (app_ctx_scope() = ''tenant'' AND app_current_tenant_id() = %I.tenant_id
                AND app_finance_actor_class() = ''finance_staff''))',
            t || '_select', t, t);
        EXECUTE format('CREATE POLICY %I ON %I FOR INSERT WITH CHECK (
            app_privileged()
            OR (app_ctx_scope() = ''tenant'' AND app_current_tenant_id() = %I.tenant_id
                AND app_finance_actor_class() = ''finance_staff''
                AND app_finance_permission_held(''fees.payments.collect'')))',
            t || '_insert', t, t);
        -- UPDATE is P-only (recon §B.2.3).
        EXECUTE format('CREATE POLICY %I ON %I FOR UPDATE USING (app_privileged())',
            t || '_update', t);
        EXECUTE format('CREATE POLICY %I ON %I FOR DELETE USING (app_privileged())',
            t || '_delete', t);
    END LOOP;
END $rls_pay$;

-- fin_receipts ---------------------------------------------------------------
ALTER TABLE fin_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE fin_receipts FORCE  ROW LEVEL SECURITY;
-- R = payer_guardian_id reachability (a guardian can read a receipt they paid).
CREATE POLICY fin_receipts_select ON fin_receipts FOR SELECT USING (
    app_privileged()
    OR (app_ctx_scope() = 'tenant' AND app_current_tenant_id() = fin_receipts.tenant_id
        AND (
            app_finance_actor_class() = 'finance_staff'
            OR fin_receipts.payer_guardian_id IN (SELECT app_finance_current_guardian_ids())
        )));
-- Ruling I.3: closed, normative - reissue OR payment-issue; no third permission.
CREATE POLICY fin_receipts_insert ON fin_receipts FOR INSERT WITH CHECK (
    app_privileged()
    OR (app_ctx_scope() = 'tenant' AND app_current_tenant_id() = fin_receipts.tenant_id
        AND app_finance_actor_class() = 'finance_staff'
        AND (app_finance_permission_held('fees.receipts.reissue')
             OR app_finance_permission_held('fees.payments.collect'))));
-- Ruling I.1: UPDATE is exactly P-only. trg_fin_receipt_freeze (0024:1377)
-- raises 55000 for the owner's own UPDATE, so immutability is enforced at the
-- trigger layer; the P + FORCE pair routes every attempt to that guard.
-- fin_receipts holds no UPDATE ACL for school_app_rw (Shape 3), so runtime is
-- refused at the statement layer with 42501 before RLS is consulted.
CREATE POLICY fin_receipts_update ON fin_receipts FOR UPDATE
    USING (app_privileged());
-- DELETE policy OMITTED (§B.2.10, adaptation A10). The owner's DELETE silently
-- affects 0 rows (Probe A); there is no row and no BEFORE guard to error.

-- fin_refunds ----------------------------------------------------------------
ALTER TABLE fin_refunds ENABLE ROW LEVEL SECURITY;
ALTER TABLE fin_refunds FORCE  ROW LEVEL SECURITY;
CREATE POLICY fin_refunds_select ON fin_refunds FOR SELECT USING (
    app_privileged()
    OR (app_ctx_scope() = 'tenant' AND app_current_tenant_id() = fin_refunds.tenant_id
        AND app_finance_actor_class() = 'finance_staff'));
CREATE POLICY fin_refunds_insert ON fin_refunds FOR INSERT WITH CHECK (
    app_privileged()
    OR (app_ctx_scope() = 'tenant' AND app_current_tenant_id() = fin_refunds.tenant_id
        AND app_finance_actor_class() = 'finance_staff'
        AND app_finance_permission_held('fees.refunds.request')));
-- UPDATE is P-only (recon §B.2.4). This is what makes F11/F12 - definers owned
-- by school_migrator, subject to FORCE RLS like the owner - the ONLY writers of
-- status and the server-owned columns. Runtime still holds no UPDATE ACL.
CREATE POLICY fin_refunds_update ON fin_refunds FOR UPDATE
    USING (app_privileged());
CREATE POLICY fin_refunds_delete ON fin_refunds FOR DELETE USING (
    app_privileged());

-- reconciliation --------------------------------------------------------------
DO $rls_recon$
DECLARE
    t text;
BEGIN
    FOREACH t IN ARRAY ARRAY['fin_reconciliation_batches', 'fin_reconciliation_matches'] LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format('ALTER TABLE %I FORCE  ROW LEVEL SECURITY', t);
        EXECUTE format('CREATE POLICY %I ON %I FOR SELECT USING (
            app_privileged()
            OR (app_ctx_scope() = ''tenant'' AND app_current_tenant_id() = %I.tenant_id
                AND app_finance_actor_class() = ''finance_staff''))',
            t || '_select', t, t);
        EXECUTE format('CREATE POLICY %I ON %I FOR INSERT WITH CHECK (
            app_privileged()
            OR (app_ctx_scope() = ''tenant'' AND app_current_tenant_id() = %I.tenant_id
                AND app_finance_actor_class() = ''finance_staff''
                AND app_finance_permission_held(''fees.reconciliation.manage'')))',
            t || '_insert', t, t);
        EXECUTE format('CREATE POLICY %I ON %I FOR UPDATE
            USING (
                app_privileged()
                OR (app_ctx_scope() = ''tenant'' AND app_current_tenant_id() = %I.tenant_id
                    AND app_finance_actor_class() = ''finance_staff''
                    AND app_finance_permission_held(''fees.reconciliation.manage'')))',
            t || '_update', t, t);
        EXECUTE format('CREATE POLICY %I ON %I FOR DELETE USING (app_privileged())',
            t || '_delete', t);
    END LOOP;
END $rls_recon$;

-- ledger ----------------------------------------------------------------------
DO $rls_ledger$
DECLARE
    t text;
BEGIN
    FOREACH t IN ARRAY ARRAY['fin_ledger_entry_groups', 'fin_ledger_entries'] LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format('ALTER TABLE %I FORCE  ROW LEVEL SECURITY', t);
        EXECUTE format('CREATE POLICY %I ON %I FOR SELECT USING (
            app_privileged()
            OR (app_ctx_scope() = ''tenant'' AND app_current_tenant_id() = %I.tenant_id
                AND app_finance_actor_class() = ''finance_staff''))',
            t || '_select', t, t);
        -- INSERT/UPDATE are P-only: F4 post_fin_ledger_group (SECURITY DEFINER)
        -- is the sole 0026 write path (recon §B.2.8).
        EXECUTE format('CREATE POLICY %I ON %I FOR INSERT WITH CHECK (app_privileged())',
            t || '_insert', t);
        EXECUTE format('CREATE POLICY %I ON %I FOR UPDATE USING (app_privileged())',
            t || '_update', t);
        -- DELETE omitted (§B.2.10).
    END LOOP;
END $rls_ledger$;

-- fin_ledger_event_types: P-only both ways; zero runtime ACL (ruling B8) ------
ALTER TABLE fin_ledger_event_types ENABLE ROW LEVEL SECURITY;
ALTER TABLE fin_ledger_event_types FORCE  ROW LEVEL SECURITY;
CREATE POLICY fin_ledger_event_types_select ON fin_ledger_event_types FOR SELECT USING (
    app_privileged());
CREATE POLICY fin_ledger_event_types_insert ON fin_ledger_event_types FOR INSERT WITH CHECK (
    app_privileged());
CREATE POLICY fin_ledger_event_types_update ON fin_ledger_event_types FOR UPDATE
    USING (app_privileged());
CREATE POLICY fin_ledger_event_types_delete ON fin_ledger_event_types FOR DELETE USING (
    app_privileged());

-- ============================================================================
-- 13. §20.5 fees.* permission backfill  (adaptation A12)
-- ----------------------------------------------------------------------------
-- The role templates are materialised only at tenant creation, so adding
-- permissions must be an explicit per-tenant backfill scoped to is_system roles.
-- Forward-only and additive. A before/after checksum over non-system roles'
-- permission sets proves no custom role was widened, and a post-condition
-- restricts principal to exactly fees.reports.read among fees.*.
DO $backfill$
DECLARE
    v_before text;
    v_after  text;
BEGIN
    SELECT md5(string_agg(md5(r.id::text) || '=' || rp.permission, ',' ORDER BY r.id, rp.permission))
      INTO v_before
      FROM roles r
      JOIN role_permissions rp ON rp.role_id = r.id
     WHERE r.is_system = false;

    -- cashier: a NEW per-tenant system role, created once per existing tenant.
    INSERT INTO roles (tenant_id, code, name, description, scope, is_system)
    SELECT t.id, 'cashier', 'Cashier', 'Cashier role (POS fee collection)', 'tenant', true
      FROM tenants t
     WHERE NOT EXISTS (
        SELECT 1 FROM roles r WHERE r.tenant_id = t.id AND r.code = 'cashier');

    -- school_owner: all 25 fees.* permissions.
    INSERT INTO role_permissions (role_id, permission)
    SELECT r.id, p.permission
      FROM roles r
      JOIN (VALUES
        ('school_owner', 'fees.structures.read'),
        ('school_owner', 'fees.structures.manage'),
        ('school_owner', 'fees.assignments.read'),
        ('school_owner', 'fees.assignments.manage'),
        ('school_owner', 'fees.invoices.read'),
        ('school_owner', 'fees.invoices.create'),
        ('school_owner', 'fees.invoices.issue'),
        ('school_owner', 'fees.invoices.void'),
        ('school_owner', 'fees.payments.read'),
        ('school_owner', 'fees.payments.collect'),
        ('school_owner', 'fees.payments.reverse'),
        ('school_owner', 'fees.refunds.read'),
        ('school_owner', 'fees.refunds.request'),
        ('school_owner', 'fees.refunds.approve'),
        ('school_owner', 'fees.refunds.process'),
        ('school_owner', 'fees.adjustments.read'),
        ('school_owner', 'fees.adjustments.create'),
        ('school_owner', 'fees.adjustments.approve'),
        ('school_owner', 'fees.receipts.read'),
        ('school_owner', 'fees.receipts.reissue'),
        ('school_owner', 'fees.reconciliation.read'),
        ('school_owner', 'fees.reconciliation.manage'),
        ('school_owner', 'fees.ledger.read'),
        ('school_owner', 'fees.reports.read'),
        ('school_owner', 'fees.portal.read')
      ) AS p(code, permission) ON p.code = r.code
     WHERE r.is_system = true AND r.tenant_id IS NOT NULL
    ON CONFLICT (role_id, permission) DO NOTHING;

    -- accountant: 22 of 25 - all except structures.manage, assignments.manage,
    -- portal.read (§20.5).
    INSERT INTO role_permissions (role_id, permission)
    SELECT r.id, p.permission
      FROM roles r
      JOIN (VALUES
        ('accountant', 'fees.structures.read'),
        ('accountant', 'fees.assignments.read'),
        ('accountant', 'fees.invoices.read'),
        ('accountant', 'fees.invoices.create'),
        ('accountant', 'fees.invoices.issue'),
        ('accountant', 'fees.invoices.void'),
        ('accountant', 'fees.payments.read'),
        ('accountant', 'fees.payments.collect'),
        ('accountant', 'fees.payments.reverse'),
        ('accountant', 'fees.refunds.read'),
        ('accountant', 'fees.refunds.request'),
        ('accountant', 'fees.refunds.approve'),
        ('accountant', 'fees.refunds.process'),
        ('accountant', 'fees.adjustments.read'),
        ('accountant', 'fees.adjustments.create'),
        ('accountant', 'fees.adjustments.approve'),
        ('accountant', 'fees.receipts.read'),
        ('accountant', 'fees.receipts.reissue'),
        ('accountant', 'fees.reconciliation.read'),
        ('accountant', 'fees.reconciliation.manage'),
        ('accountant', 'fees.ledger.read'),
        ('accountant', 'fees.reports.read')
      ) AS p(code, permission) ON p.code = r.code
     WHERE r.is_system = true AND r.tenant_id IS NOT NULL
    ON CONFLICT (role_id, permission) DO NOTHING;

    -- principal: exactly fees.reports.read.
    INSERT INTO role_permissions (role_id, permission)
    SELECT r.id, 'fees.reports.read'
      FROM roles r
     WHERE r.code = 'principal' AND r.is_system = true AND r.tenant_id IS NOT NULL
    ON CONFLICT (role_id, permission) DO NOTHING;

    -- cashier: exactly three (NOT fees.receipts.reissue, per P1-03/§20.5).
    INSERT INTO role_permissions (role_id, permission)
    SELECT r.id, p.permission
      FROM roles r
      JOIN (VALUES
        ('cashier', 'fees.payments.read'),
        ('cashier', 'fees.payments.collect'),
        ('cashier', 'fees.receipts.read')
      ) AS p(code, permission) ON p.code = r.code
     WHERE r.is_system = true AND r.tenant_id IS NOT NULL
    ON CONFLICT (role_id, permission) DO NOTHING;

    -- parent and student: fees.portal.read.
    INSERT INTO role_permissions (role_id, permission)
    SELECT r.id, 'fees.portal.read'
      FROM roles r
     WHERE r.code IN ('parent', 'student') AND r.is_system = true AND r.tenant_id IS NOT NULL
    ON CONFLICT (role_id, permission) DO NOTHING;

    -- Post-condition: non-system roles' permission sets are byte-identical.
    SELECT md5(string_agg(md5(r.id::text) || '=' || rp.permission, ',' ORDER BY r.id, rp.permission))
      INTO v_after
      FROM roles r
      JOIN role_permissions rp ON rp.role_id = r.id
     WHERE r.is_system = false;

    IF v_after IS DISTINCT FROM v_before THEN
        RAISE EXCEPTION '§20.5 backfill widened a non-system role permission set';
    END IF;

    -- Post-condition: a principal holds no fees.* permission other than
    -- fees.reports.read.
    IF EXISTS (
        SELECT 1
          FROM roles r
          JOIN role_permissions rp ON rp.role_id = r.id
         WHERE r.code = 'principal'
           AND rp.permission LIKE 'fees.%'
           AND rp.permission <> 'fees.reports.read'
    ) THEN
        RAISE EXCEPTION '§20.5 principal holds a fees.* permission beyond fees.reports.read';
    END IF;
END $backfill$;

-- ============================================================================
-- 14. §19.5 postures - static self-assertions (three rows, enforced here)
-- ----------------------------------------------------------------------------
-- (1) no fin_% policy contains a platform-scope context test.
DO $assert1$
BEGIN
    IF EXISTS (
        SELECT 1
          FROM pg_policy p
          JOIN pg_class c      ON c.oid = p.polrelid
          JOIN pg_namespace n  ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relname LIKE 'fin\_%'
           AND (pg_get_expr(p.polqual, p.polrelid) LIKE '%app_ctx_scope() = ''platform''%'
             OR pg_get_expr(p.polwithcheck, p.polrelid) LIKE '%app_ctx_scope() = ''platform''%')
    ) THEN
        RAISE EXCEPTION '§19.5(1): a fin_%% policy contains a platform-scope context test';
    END IF;
END $assert1$;

-- (2) scoped: any fin_% policy containing BOTH app_ctx_scope() AND
--     app_privileged() must also carry app_finance_actor_class().
DO $assert2$
BEGIN
    IF EXISTS (
        SELECT 1
          FROM pg_policy p
          JOIN pg_class c      ON c.oid = p.polrelid
          JOIN pg_namespace n  ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relname LIKE 'fin\_%'
           AND (
                (pg_get_expr(p.polqual, p.polrelid) LIKE '%app_ctx_scope()%'
             AND pg_get_expr(p.polqual, p.polrelid) LIKE '%app_privileged()%'
             AND pg_get_expr(p.polqual, p.polrelid) NOT LIKE '%app_finance_actor_class()%')
             OR
                (pg_get_expr(p.polwithcheck, p.polrelid) LIKE '%app_ctx_scope()%'
             AND pg_get_expr(p.polwithcheck, p.polrelid) LIKE '%app_privileged()%'
             AND pg_get_expr(p.polwithcheck, p.polrelid) NOT LIKE '%app_finance_actor_class()%')
           )
    ) THEN
        RAISE EXCEPTION '§19.5(2): a fin_%% policy with context + privileged lacks the actor class';
    END IF;
END $assert2$;

-- (3) every finance and auth data table is ENABLE + FORCE RLS.
DO $assert3$
BEGIN
    IF EXISTS (
        SELECT 1
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relkind = 'r'
           AND (c.relname LIKE 'fin\_%' OR c.relname LIKE 'auth\_%')
           AND (c.relrowsecurity = false OR c.relforcerowsecurity = false)
    ) THEN
        RAISE EXCEPTION '§19.5(3): a fin_%%/auth_%% table is not ENABLE + FORCE RLS';
    END IF;
END $assert3$;

-- ============================================================================
-- 15. GRANTS, LAST  (adaptation A11; recon §C.4 / §D.2-D.4)
-- ----------------------------------------------------------------------------
-- The only migration in which school_app_rw acquires fin_* access. Every grant
-- is stated explicitly here (after a REVOKE ALL) so the final ACL is exactly the
-- §D.2 shape regardless of the grants 0021-0026 issued.

-- Shape 1 - table-level SELECT, INSERT, UPDATE; DELETE revoked (10 tables).
DO $grants_shape1$
DECLARE
    t text;
BEGIN
    FOREACH t IN ARRAY ARRAY[
        'fin_tenant_settings', 'fin_fee_heads', 'fin_tax_profiles',
        'fin_fee_structures', 'fin_fee_structure_items', 'fin_fee_installment_plans',
        'fin_fee_structure_targets', 'fin_fee_assignments',
        'fin_reconciliation_batches', 'fin_reconciliation_matches'
    ] LOOP
        EXECUTE format('REVOKE ALL ON %I FROM school_app_rw', t);
        EXECUTE format('GRANT SELECT, INSERT, UPDATE ON %I TO school_app_rw', t);
    END LOOP;
END $grants_shape1$;

-- Shape 2 - column-level, exactly §35.4 lines 15314-15335 (9 statements).
REVOKE ALL ON fin_invoices FROM school_app_rw;
GRANT SELECT ON fin_invoices TO school_app_rw;
GRANT INSERT (tenant_id, student_id, academic_year_id, enrollment_id, structure_id,
              due_date, void_reason, created_by) ON fin_invoices TO school_app_rw;
GRANT UPDATE (status, due_date, void_reason) ON fin_invoices TO school_app_rw;

REVOKE ALL ON fin_invoice_items FROM school_app_rw;
GRANT SELECT ON fin_invoice_items TO school_app_rw;
GRANT INSERT (tenant_id, invoice_id, structure_id, installment_no, fee_head_id,
              quantity, unit_amount, tax_amount, description) ON fin_invoice_items TO school_app_rw;
GRANT UPDATE (description) ON fin_invoice_items TO school_app_rw;

REVOKE ALL ON fin_invoice_adjustments FROM school_app_rw;
GRANT SELECT ON fin_invoice_adjustments TO school_app_rw;
GRANT INSERT (tenant_id, invoice_id, adjustment_type, amount, reason, requested_by,
              reverses_adjustment_id) ON fin_invoice_adjustments TO school_app_rw;
GRANT UPDATE (status, approved_by, approved_at, rejected_reason)
    ON fin_invoice_adjustments TO school_app_rw;

-- Shape 3 - SELECT + INSERT; UPDATE and DELETE revoked (8 tables).
DO $grants_shape3$
DECLARE
    t text;
BEGIN
    FOREACH t IN ARRAY ARRAY[
        'fin_challans', 'fin_document_counters', 'fin_payments',
        'fin_payment_allocations', 'fin_receipts', 'fin_refunds',
        'fin_billing_runs', 'fin_billing_run_items'
    ] LOOP
        EXECUTE format('REVOKE ALL ON %I FROM school_app_rw', t);
        EXECUTE format('GRANT SELECT, INSERT ON %I TO school_app_rw', t);
    END LOOP;
END $grants_shape3$;

-- Shape 4 - SELECT only (2 tables).
DO $grants_shape4$
DECLARE
    t text;
BEGIN
    FOREACH t IN ARRAY ARRAY['fin_ledger_entry_groups', 'fin_ledger_entries'] LOOP
        EXECUTE format('REVOKE ALL ON %I FROM school_app_rw', t);
        EXECUTE format('GRANT SELECT ON %I TO school_app_rw', t);
    END LOOP;
END $grants_shape4$;

-- Shape 5 - fin_ledger_accounts SELECT only (F3 writes it); fin_ledger_event_types
-- zero runtime privilege (assert-revoke, never grant).
REVOKE ALL ON fin_ledger_accounts FROM school_app_rw;
GRANT SELECT ON fin_ledger_accounts TO school_app_rw;
REVOKE ALL ON fin_ledger_event_types FROM school_app_rw, PUBLIC;

-- Shape 6 - auth_*: SELECT/INSERT/UPDATE granted, DELETE revoked (already issued
-- at table creation above; re-assert deterministically).
REVOKE ALL ON auth_mfa_factors FROM school_app_rw;
GRANT SELECT, INSERT, UPDATE ON auth_mfa_factors TO school_app_rw;
REVOKE ALL ON auth_step_up_challenges FROM school_app_rw;
GRANT SELECT, INSERT, UPDATE ON auth_step_up_challenges TO school_app_rw;

-- Shape 7 - views. fin_v_invoice_balance and fin_v_payment_position roll over
-- from 0024 with a,r,w,d and no revoke; the five 0026 views were already
-- REVOKE ALL'd. 0028 REVOKEs the two, then grants SELECT-only on all seven.
REVOKE ALL ON fin_v_invoice_balance, fin_v_payment_position FROM school_app_rw, PUBLIC;
GRANT SELECT ON fin_v_invoice_balance, fin_v_payment_position,
                 fin_v_ledger_account_balance, fin_v_ar_aging,
                 fin_v_collections_summary, fin_v_fee_head_revenue,
                 fin_v_on_account_summary TO school_app_rw;