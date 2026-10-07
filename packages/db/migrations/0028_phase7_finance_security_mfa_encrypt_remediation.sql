-- ============================================================================
-- 0028_phase7_finance_security_mfa_encrypt_remediation.sql
-- Forward-only remediation of D5a `app_mfa_encrypt(bytea)` (0028 line 236).
-- ----------------------------------------------------------------------------
-- DEFECT (confirmed against PostgreSQL 18.6):
--   0028_phase7_finance_security.sql:236 calls
--       pgp_sym_encrypt(p_secret, app_ctx_secret(), 'compress-algo=0, ...')
--   with `p_secret bytea`. PostgreSQL provides NO bytea overload of
--   `pgp_sym_encrypt` (only `(text, text)` and `(text, text, text)`), so the
--   SECURITY DEFINER wrapper raised, at every invocation:
--       ERROR: 42883: function pgp_sym_encrypt(bytea, text, unknown) does not exist
--   TOTP enrollment could therefore never seal a seed: `app_mfa_encrypt` was
--   dead on arrival. (The already-green acceptance suites did not catch it
--   because they seeded the envelope directly rather than through the wrapper.)
--
-- CORRECTION — one identifier, nothing else:
--   The binary/bytea pairing of the decrypt half already shipped in 0028
--   (`app_mfa_decrypt` uses `pgp_sym_decrypt_bytea`, line 258) is
--   `pgp_sym_encrypt_bytea`. This migration replaces ONLY the function name.
--
-- PRESERVED EXACTLY (the accepted P2-09 contract, Decision 5 / D5a):
--   * signature      app_mfa_encrypt(bytea) -> bytea
--   * key source     app_ctx_secret()
--   * ciphertext     binary bytea PGP envelope (no armouring)
--   * cipher         cipher-algo=aes256
--   * compression    compress-algo=0
--   * KDF            s2k-mode=1
--   * SECURITY DEFINER
--   * SET search_path = pg_catalog, public, pg_temp
--   * VOLATILE       (PGP encryption is randomized; identical inputs differ)
--   * REVOKE ALL ... FROM PUBLIC
--   * GRANT EXECUTE ... TO school_app_rw
--
-- OWNERSHIP / PRIVILEGE NOTES:
--   * CREATE OR REPLACE FUNCTION preserves the existing owner (school_migrator),
--     so no explicit ALTER ... OWNER TO is required.
--   * The ACL is re-issued explicitly below to state the final posture in one
--     place and to keep this file self-contained and re-runnable; CREATE OR
--     REPLACE would otherwise retain the prior ACL unchanged.
--   * No new object is created: the function count, table count, FK count and
--     trigger inventory are unchanged.
--
-- IMMUTABILITY: 0001–0028 are NOT edited by this file.
-- ============================================================================
CREATE OR REPLACE FUNCTION app_mfa_encrypt(p_secret bytea) RETURNS bytea
    LANGUAGE plpgsql
    VOLATILE SECURITY DEFINER
    SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
    IF p_secret IS NULL THEN
        RETURN NULL;
    END IF;
    RETURN pgp_sym_encrypt_bytea(
        p_secret,
        app_ctx_secret(),
        'compress-algo=0, cipher-algo=aes256, s2k-mode=1'
    );
END $$;
REVOKE ALL ON FUNCTION app_mfa_encrypt(bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_mfa_encrypt(bytea) TO school_app_rw;