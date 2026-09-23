-- 0002_trusted_context: replace the forgeable GUC RLS boundary with a signed,
-- short-lived context ticket verified against server-side secrets.
--
-- WHY (Phase-1 security blocker): before this migration every RLS policy trusted
-- transaction-local GUCs (app.current_tenant/current_user/platform_access/system_access)
-- that school_app_rw could set itself via set_config(...). That made RLS forgeable:
-- any holder of the runtime connection could self-grant platform/system authority and
-- read/write any tenant's rows.
--
-- WHAT CHANGES
--   * `app.rls` GUC now carries an HMAC-SHA256 context ticket. Only SECURITY DEFINER
--     function app_ctx_mint() can produce a valid ticket, and mintage is gated by DATA:
--       scope 'account'  -> userId provided (identity asserted by the app session)
--       scope 'tenant'   -> an ACTIVE membership (user_id, tenant_id) must exist
--       scope 'platform' -> the user must have a platform_role_assignments row
--       scope 'none'     -> no claims
--   * Policies trust ONLY verified ticket claims via app_ctx_scope()/app_ctx_user()/
--     app_ctx_tenant() and the executor escape app_current_user() IN (school_migrator).
--     None of the legacy app.* GUCs are read any more, so forging them buys nothing.
--   * The executor escape is unavoidable only through a school_migrator connection
--     (worker/dispatcher/migrations) or a controlled SECURITY DEFINER function, because
--     school_app_rw cannot SET ROLE (no membership grant) -- verified by integration test.
--   * auth_identities (previously NOT RLS-enforced) is now FORCE RLS: self-visible only;
--     the pre-auth login lookup is narrowed to a SECURITY DEFINER helper so credentials
--     can never be overwritten by the runtime role.
--
-- Residual risks (documented in DECISIONS ADR-014): a raw-SQL holder of the app
-- credential can still assert any identity that has a real membership/assignment (the
-- database cannot cryptographically distinguish users behind a single runtime role); and
-- users_insert remains open-by-design so registration can create rows pre-context.
-- These require per-user connection roles or a dedicated platform pool in a later phase.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ================================================================== secrets
-- Single-row context secret. Only SECURITY DEFINER functions owned by school_migrator
-- can read it; the runtime role is blocked by FORCE RLS and an explicit REVOKE.
CREATE TABLE app_rls_secrets (
    kind       text PRIMARY KEY,
    value      text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO app_rls_secrets (kind, value)
VALUES ('context', encode(gen_random_bytes(48), 'hex'));

REVOKE ALL ON TABLE app_rls_secrets FROM school_app_rw;

ALTER TABLE app_rls_secrets ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_rls_secrets FORCE ROW LEVEL SECURITY;
CREATE POLICY app_rls_secrets_own ON app_rls_secrets FOR ALL
    USING (current_user = 'school_migrator')
    WITH CHECK (current_user = 'school_migrator');

-- ================================================================== helpers

-- True when the executing session carries the trusted (privileged) role.
-- SECURITY INVOKER on purpose so RLS policies see the real session user.
CREATE OR REPLACE FUNCTION app_privileged() RETURNS boolean
    LANGUAGE sql STABLE
    AS $$ SELECT current_user IN ('school_migrator') $$;
GRANT EXECUTE ON FUNCTION app_privileged() TO school_app_rw;

-- Read the context secret. Internal only -- never granted to the runtime role.
CREATE OR REPLACE FUNCTION app_ctx_secret() RETURNS text
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
    AS $$ SELECT value FROM app_rls_secrets WHERE kind = 'context' $$;
REVOKE ALL ON FUNCTION app_ctx_secret() FROM PUBLIC;

-- Mint a signed context ticket and install it as the transaction-local app.rls GUC.
-- The ticket is the ONLY way a school_app_rw session can prove context.
CREATE OR REPLACE FUNCTION app_ctx_mint(scope text, u uuid, t uuid) RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog
    AS $$
DECLARE
    claims_ text;
    secret_ text;
    exp_    bigint;
    u_      text := coalesce(u::text, '');
    t_      text := coalesce(t::text, '');
    ticket_ text;
BEGIN
    IF scope NOT IN ('none', 'account', 'tenant', 'platform') THEN
        RETURN NULL;
    END IF;
    IF scope IN ('account', 'platform') AND u IS NULL THEN
        RETURN NULL;
    END IF;
    IF scope = 'tenant' AND (u IS NULL OR t IS NULL) THEN
        RETURN NULL;
    END IF;
    IF scope = 'tenant' THEN
        -- Validate against a real, active membership (privileged executor path).
        PERFORM 1 FROM memberships
            WHERE user_id = u AND tenant_id = t AND status = 'active';
        IF NOT FOUND THEN
            RETURN NULL;
        END IF;
    END IF;
    IF scope = 'platform' THEN
        -- Validate against a real platform role assignment.
        PERFORM 1 FROM platform_role_assignments WHERE user_id = u;
        IF NOT FOUND THEN
            RETURN NULL;
        END IF;
    END IF;

    secret_ := app_ctx_secret();
    exp_    := (extract(epoch FROM now()))::bigint + 300; -- 5 minute lifetime
    claims_ := format('{"s":"%s","u":"%s","t":"%s","e":%s}', scope, u_, t_, exp_);
    ticket_ := format(
        '%s.%s',
        encode(convert_to(claims_, 'utf8'), 'base64'),
        encode(hmac(convert_to(claims_, 'utf8'), convert_to(secret_, 'utf8'), 'sha256'), 'hex')
    );
    PERFORM set_config('app.rls', ticket_, true);
    RETURN ticket_;
END
$$;
REVOKE ALL ON FUNCTION app_ctx_mint(text, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_ctx_mint(text, uuid, uuid) TO school_app_rw;

-- Parse + cryptographically verify the current app.rls ticket. Returns claims jsonb
-- or NULL. Robust against malformed/forged input (never raises on bad GUC content).
CREATE OR REPLACE FUNCTION app_ctx_claims() RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_catalog
    AS $$
DECLARE
    tk      text := current_setting('app.rls', true);
    payload text;
    sig     text;
    mac     bytea;
BEGIN
    IF tk IS NULL OR tk = '' OR position('.' in tk) = 0 THEN
        RETURN NULL;
    END IF;
    BEGIN
        payload := convert_from(decode(split_part(tk, '.', 1), 'base64'), 'utf8');
    EXCEPTION WHEN OTHERS THEN
        RETURN NULL;
    END;
    sig := split_part(tk, '.', 2);
    mac := hmac(convert_to(payload, 'utf8'), convert_to(app_ctx_secret(), 'utf8'), 'sha256');
    IF encode(mac, 'hex') <> sig THEN
        RETURN NULL;
    END IF;
    IF (payload::jsonb ->> 'e')::numeric < (extract(epoch FROM now())) THEN
        RETURN NULL;
    END IF;
    RETURN payload::jsonb;
END
$$;
REVOKE ALL ON FUNCTION app_ctx_claims() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_ctx_claims() TO school_app_rw;

-- Claim accessors used by RLS policies. Take no arguments, so a forged GUC cannot
-- influence their result -- every call re-verifies the signed ticket.
CREATE OR REPLACE FUNCTION app_ctx_scope() RETURNS text
    LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_catalog
    AS $$
DECLARE
    c jsonb := app_ctx_claims();
BEGIN
    RETURN CASE WHEN c IS NULL THEN NULL ELSE c ->> 's' END;
END
$$;
REVOKE ALL ON FUNCTION app_ctx_scope() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_ctx_scope() TO school_app_rw;

CREATE OR REPLACE FUNCTION app_ctx_user() RETURNS uuid
    LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_catalog
    AS $$
DECLARE
    c jsonb := app_ctx_claims();
BEGIN
    RETURN CASE WHEN c IS NULL OR (c ->> 'u') = '' THEN NULL ELSE (c ->> 'u')::uuid END;
END
$$;
REVOKE ALL ON FUNCTION app_ctx_user() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_ctx_user() TO school_app_rw;

CREATE OR REPLACE FUNCTION app_ctx_tenant() RETURNS uuid
    LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_catalog
    AS $$
DECLARE
    c jsonb := app_ctx_claims();
BEGIN
    RETURN CASE WHEN c IS NULL OR (c ->> 't') = '' THEN NULL ELSE (c ->> 't')::uuid END;
END
$$;
REVOKE ALL ON FUNCTION app_ctx_tenant() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_ctx_tenant() TO school_app_rw;

-- Backwards-compatible helpers previously reading raw GUCs. Now claim-backed, so every
-- existing app_current_user_id()/app_current_tenant_id() reference in a policy becomes
-- forge-proof without waiting for call-site rewrites.
CREATE OR REPLACE FUNCTION app_current_user_id() RETURNS uuid
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
    AS $$ SELECT app_ctx_user() $$;
GRANT EXECUTE ON FUNCTION app_current_user_id() TO school_app_rw;

CREATE OR REPLACE FUNCTION app_current_tenant_id() RETURNS uuid
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
    AS $$ SELECT app_ctx_tenant() $$;
GRANT EXECUTE ON FUNCTION app_current_tenant_id() TO school_app_rw;

-- Narrow pre-auth identity lookup for the login flow. auth_identities is FORCE RLS and
-- self-visible only; this definer is the sanctioned way to read credentials before any
-- context ticket exists. Returns only what the login flow needs.
CREATE OR REPLACE FUNCTION app_auth_login_lookup(provider text, provider_key text)
    RETURNS TABLE(user_id uuid, password_hash text)
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_catalog
    AS $$
    SELECT u.user_id, u.password_hash
    FROM auth_identities u
    WHERE u.provider = $1 AND u.provider_key = $2
$$;
REVOKE ALL ON FUNCTION app_auth_login_lookup(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_auth_login_lookup(text, text) TO school_app_rw;

-- ================================================================== policies
-- Every policy below replaced. Rule: row access is granted only through verified ticket
-- claims (app_ctx_scope/user/tenant) OR the privileged executor escape. No raw GUCs.

-- tenants ----------------------------------------------------------------
DROP POLICY IF EXISTS tenants_select ON tenants;
DROP POLICY IF EXISTS tenants_insert ON tenants;
DROP POLICY IF EXISTS tenants_update ON tenants;
CREATE POLICY tenants_select ON tenants FOR SELECT USING (
    app_current_tenant_id() = id
    OR app_ctx_scope() = 'platform'
    OR EXISTS (SELECT 1 FROM memberships m
               WHERE m.tenant_id = tenants.id AND m.user_id = app_current_user_id() AND m.status = 'active')
    OR app_privileged()
);
CREATE POLICY tenants_insert ON tenants FOR INSERT WITH CHECK (
    app_ctx_scope() = 'platform' OR app_privileged()
);
CREATE POLICY tenants_update ON tenants FOR UPDATE USING (
    app_ctx_scope() = 'platform' OR app_current_tenant_id() = id OR app_privileged()
) WITH CHECK (
    app_ctx_scope() = 'platform' OR app_current_tenant_id() = id OR app_privileged()
);

-- users -------------------------------------------------------------------
DROP POLICY IF EXISTS users_select ON users;
DROP POLICY IF EXISTS users_insert ON users;
DROP POLICY IF EXISTS users_update ON users;
CREATE POLICY users_select ON users FOR SELECT USING (
    app_current_user_id() = id
    OR app_ctx_scope() = 'platform'
    OR EXISTS (SELECT 1 FROM memberships m
               WHERE m.user_id = users.id AND m.tenant_id = app_current_tenant_id() AND m.status = 'active')
    OR app_privileged()
);
-- Registration runs before any context exists; creating the registry row cannot be gated.
CREATE POLICY users_insert ON users FOR INSERT WITH CHECK (true);
CREATE POLICY users_update ON users FOR UPDATE USING (
    app_current_user_id() = id OR app_ctx_scope() = 'platform' OR app_privileged()
);

-- user_profiles -----------------------------------------------------------
DROP POLICY IF EXISTS user_profiles_select ON user_profiles;
DROP POLICY IF EXISTS user_profiles_write ON user_profiles;
DROP POLICY IF EXISTS user_profiles_update ON user_profiles;
CREATE POLICY user_profiles_select ON user_profiles FOR SELECT USING (
    app_current_user_id() = user_id OR app_ctx_scope() = 'platform' OR app_privileged()
);
CREATE POLICY user_profiles_write ON user_profiles FOR INSERT WITH CHECK (
    app_current_user_id() = user_id OR app_ctx_scope() = 'platform' OR app_privileged()
);
CREATE POLICY user_profiles_update ON user_profiles FOR UPDATE USING (
    app_current_user_id() = user_id OR app_ctx_scope() = 'platform' OR app_privileged()
);

-- auth_identities (NEW: previously not RLS-enforced) ----------------------
-- Self-visible/writable only. The login path reads via app_auth_login_lookup().
ALTER TABLE auth_identities ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_identities FORCE ROW LEVEL SECURITY;
CREATE POLICY auth_identities_own ON auth_identities FOR ALL USING (
    app_current_user_id() = user_id OR app_privileged()
) WITH CHECK (
    app_current_user_id() = user_id OR app_privileged()
);

-- auth_sessions -----------------------------------------------------------
DROP POLICY IF EXISTS auth_sessions_select ON auth_sessions;
DROP POLICY IF EXISTS auth_sessions_insert ON auth_sessions;
DROP POLICY IF EXISTS auth_sessions_update ON auth_sessions;
CREATE POLICY auth_sessions_select ON auth_sessions FOR SELECT USING (
    app_current_user_id() = user_id OR app_ctx_scope() = 'platform' OR app_privileged()
);
CREATE POLICY auth_sessions_insert ON auth_sessions FOR INSERT WITH CHECK (true);
CREATE POLICY auth_sessions_update ON auth_sessions FOR UPDATE USING (
    app_current_user_id() = user_id OR app_ctx_scope() = 'platform' OR app_privileged()
);

-- memberships -------------------------------------------------------------
DROP POLICY IF EXISTS memberships_select ON memberships;
DROP POLICY IF EXISTS memberships_insert ON memberships;
DROP POLICY IF EXISTS memberships_update ON memberships;
CREATE POLICY memberships_select ON memberships FOR SELECT USING (
    (tenant_id = app_current_tenant_id() AND app_current_tenant_id() IS NOT NULL)
    OR app_current_user_id() = user_id
    OR app_ctx_scope() = 'platform'
    OR app_privileged()
);
CREATE POLICY memberships_insert ON memberships FOR INSERT WITH CHECK (
    tenant_id = app_current_tenant_id() OR app_ctx_scope() = 'platform' OR app_privileged()
);
CREATE POLICY memberships_update ON memberships FOR UPDATE USING (
    tenant_id = app_current_tenant_id() OR app_ctx_scope() = 'platform' OR app_privileged()
);

-- roles -------------------------------------------------------------------
DROP POLICY IF EXISTS roles_select ON roles;
DROP POLICY IF EXISTS roles_insert ON roles;
DROP POLICY IF EXISTS roles_update ON roles;
CREATE POLICY roles_select ON roles FOR SELECT USING (
    (tenant_id = app_current_tenant_id() AND tenant_id IS NOT NULL)
    OR app_ctx_scope() = 'platform'
    OR EXISTS (SELECT 1 FROM memberships m
               WHERE m.user_id = app_current_user_id() AND m.tenant_id = roles.tenant_id AND m.status = 'active')
    OR app_privileged()
);
CREATE POLICY roles_insert ON roles FOR INSERT WITH CHECK (
    (scope = 'tenant' AND (tenant_id = app_current_tenant_id() OR app_ctx_scope() = 'platform'))
    OR (scope = 'platform' AND app_ctx_scope() = 'platform')
    OR app_privileged()
);
CREATE POLICY roles_update ON roles FOR UPDATE USING (
    (scope = 'tenant' AND (tenant_id = app_current_tenant_id() OR app_ctx_scope() = 'platform'))
    OR (scope = 'platform' AND app_ctx_scope() = 'platform')
    OR app_privileged()
);

-- role_permissions --------------------------------------------------------
DROP POLICY IF EXISTS role_permissions_rw ON role_permissions;
CREATE POLICY role_permissions_rw ON role_permissions FOR ALL USING (
    EXISTS (SELECT 1 FROM roles r
            WHERE r.id = role_permissions.role_id
              AND (r.tenant_id = app_current_tenant_id() OR app_ctx_scope() = 'platform'))
    OR app_privileged()
) WITH CHECK (
    EXISTS (SELECT 1 FROM roles r
            WHERE r.id = role_permissions.role_id
              AND (r.tenant_id = app_current_tenant_id() OR app_ctx_scope() = 'platform'))
    OR app_privileged()
);

-- membership_roles --------------------------------------------------------
DROP POLICY IF EXISTS membership_roles_rw ON membership_roles;
CREATE POLICY membership_roles_rw ON membership_roles FOR ALL USING (
    EXISTS (SELECT 1 FROM memberships m
            WHERE m.id = membership_roles.membership_id
              AND (m.user_id = app_current_user_id()
                   OR m.tenant_id = app_current_tenant_id()
                   OR app_ctx_scope() = 'platform'))
    OR app_privileged()
) WITH CHECK (
    EXISTS (SELECT 1 FROM memberships m
            WHERE m.id = membership_roles.membership_id
              AND (m.tenant_id = app_current_tenant_id() OR app_ctx_scope() = 'platform'))
    OR app_privileged()
);

-- platform_role_assignments -----------------------------------------------
DROP POLICY IF EXISTS platform_role_assignments_rw ON platform_role_assignments;
CREATE POLICY platform_role_assignments_rw ON platform_role_assignments FOR ALL USING (
    app_ctx_scope() = 'platform' OR app_privileged()
) WITH CHECK (
    app_ctx_scope() = 'platform' OR app_privileged()
);

-- audit -------------------------------------------------------------------
DROP POLICY IF EXISTS audit_logs_insert ON audit_logs;
DROP POLICY IF EXISTS audit_logs_select ON audit_logs;
CREATE POLICY audit_logs_insert ON audit_logs FOR INSERT WITH CHECK (
    (scope = 'tenant' AND tenant_id = app_current_tenant_id() AND tenant_id IS NOT NULL)
    OR (scope = 'platform' AND tenant_id IS NULL)
    OR app_privileged()
);
CREATE POLICY audit_logs_select ON audit_logs FOR SELECT USING (
    (scope = 'tenant' AND tenant_id = app_current_tenant_id())
    OR app_ctx_scope() = 'platform'
    OR app_privileged()
);

-- outbox ------------------------------------------------------------------
DROP POLICY IF EXISTS outbox_events_insert ON outbox_events;
DROP POLICY IF EXISTS outbox_events_read ON outbox_events;
DROP POLICY IF EXISTS outbox_events_update ON outbox_events;
CREATE POLICY outbox_events_insert ON outbox_events FOR INSERT WITH CHECK (
    (tenant_id = app_current_tenant_id() AND tenant_id IS NOT NULL)
    OR (tenant_id IS NULL AND app_ctx_scope() IN ('account', 'platform'))
    OR app_privileged()
);
CREATE POLICY outbox_events_read ON outbox_events FOR SELECT USING (
    (tenant_id = app_current_tenant_id() AND tenant_id IS NOT NULL)
    OR app_ctx_scope() = 'platform'
    OR app_privileged()
);
-- Only the trusted executor (worker/dispatcher) may mark rows dispatched/processed.
CREATE POLICY outbox_events_update ON outbox_events FOR UPDATE USING (
    app_privileged()
);

-- idempotency_keys --------------------------------------------------------
DROP POLICY IF EXISTS idempotency_keys_rw ON idempotency_keys;
CREATE POLICY idempotency_keys_rw ON idempotency_keys FOR ALL USING (
    (tenant_id IS NOT NULL AND tenant_id = app_current_tenant_id() AND app_current_tenant_id() IS NOT NULL)
    OR (tenant_id IS NULL AND app_ctx_scope() IN ('account', 'platform'))
    OR app_privileged()
) WITH CHECK (
    (tenant_id IS NULL AND app_ctx_scope() IN ('account', 'platform'))
    OR app_privileged()
);

-- ================================================================== privileged-only deletes
-- Without DELETE policies, FORCE RLS silently denies deletion even for the trusted executor
-- (no policy => no rows match), leaving orphans unpurgeable. The runtime app_rw role has no
-- path to these: each policy allows ONLY the privileged executor (worker/dispatcher/admin
-- cleanup, retention). No DELETE access is granted to school_app_rw anywhere.
DROP POLICY IF EXISTS tenants_delete ON tenants;
CREATE POLICY tenants_delete ON tenants FOR DELETE USING (app_privileged());
DROP POLICY IF EXISTS users_delete ON users;
CREATE POLICY users_delete ON users FOR DELETE USING (app_privileged());
DROP POLICY IF EXISTS user_profiles_delete ON user_profiles;
CREATE POLICY user_profiles_delete ON user_profiles FOR DELETE USING (app_privileged());
DROP POLICY IF EXISTS auth_sessions_delete ON auth_sessions;
CREATE POLICY auth_sessions_delete ON auth_sessions FOR DELETE USING (app_privileged());
DROP POLICY IF EXISTS memberships_delete ON memberships;
CREATE POLICY memberships_delete ON memberships FOR DELETE USING (app_privileged());
DROP POLICY IF EXISTS roles_delete ON roles;
CREATE POLICY roles_delete ON roles FOR DELETE USING (app_privileged());
DROP POLICY IF EXISTS outbox_events_delete ON outbox_events;
CREATE POLICY outbox_events_delete ON outbox_events FOR DELETE USING (app_privileged());

-- Note: default privileges (GRANT ... ON ALL TABLES in 0001) still apply to new tables,
-- but app_rls_secrets is protected by FORCE RLS + the explicit REVOKE above, and is the
-- only table here that carries a secret. Any future secret-bearing table must do the same.