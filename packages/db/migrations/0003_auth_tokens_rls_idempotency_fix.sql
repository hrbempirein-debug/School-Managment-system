-- 0003: Phase 2B.1 DB security preconditions (forward-only).
--
-- Closes two confirmed gaps from the Phase 2B discovery audit:
--
-- 1. auth_tokens was the only scoped table with no row-level security: it inherited the
--    blanket school_app_rw DML grant from 0001 (line 378) and nothing filtered it. It is
--    now FORCE RLS and self-visible/writable only, mirroring the auth_identities_own model
--    from 0002, with the privileged executor escape retained for pre-auth token creation
--    (password reset / invite) and maintenance. Future token functionality therefore
--    cannot accidentally bypass tenant / user isolation.
--
-- 2. idempotency_keys_rw from 0002 wrote only NULL-tenant (account/platform) rows or
--    privileged rows; its WITH CHECK dropped the tenant branch present in USING, so
--    tenant-scoped idempotency writes (the Phase 7 money path) were impossible. The
--    WITH CHECK now mirrors USING: a tenant-scoped row is writable only while tenant_id
--    equals the current signed tenant context (cross-tenant writes denied). Existing
--    account/platform (NULL tenant) and privileged behavior is unchanged.

-- ================================================================== auth_tokens
ALTER TABLE auth_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_tokens FORCE ROW LEVEL SECURITY;

-- Self-visible/writable only, privileged executor escape. Mirrors auth_identities_own (0002).
CREATE POLICY auth_tokens_own ON auth_tokens FOR ALL
    USING (app_current_user_id() = user_id OR app_privileged())
    WITH CHECK (app_current_user_id() = user_id OR app_privileged());

-- ================================================================== idempotency_keys
DROP POLICY IF EXISTS idempotency_keys_rw ON idempotency_keys;
CREATE POLICY idempotency_keys_rw ON idempotency_keys FOR ALL USING (
    (tenant_id IS NOT NULL AND tenant_id = app_current_tenant_id() AND app_current_tenant_id() IS NOT NULL)
    OR (tenant_id IS NULL AND app_ctx_scope() IN ('account', 'platform'))
    OR app_privileged()
) WITH CHECK (
    (tenant_id IS NOT NULL AND tenant_id = app_current_tenant_id() AND app_current_tenant_id() IS NOT NULL)
    OR (tenant_id IS NULL AND app_ctx_scope() IN ('account', 'platform'))
    OR app_privileged()
);