-- 0001_init: Phase 1 foundation — tenancy, identity, RBAC, audit, outbox.
-- Owner: school_migrator. Runtime role schoool_app_rw gets DML grants below.
-- RLS model: transaction-local GUCs (app.current_tenant/current_user/platform_access/system_access)
-- set via set_config(..., true) so pooled connections can never leak context.

-- ------------------------------------------------------------------ grants
GRANT USAGE ON SCHEMA public TO school_app_rw;

-- ------------------------------------------------------------------ tenants
CREATE TABLE tenants (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    slug        text NOT NULL,
    name        text NOT NULL,
    status      text NOT NULL DEFAULT 'active',
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    deleted_at  timestamptz,
    CONSTRAINT tenants_slug_uq UNIQUE (slug),
    CONSTRAINT tenants_status_ck CHECK (status IN ('trial','active','past_due','suspended','cancelled','deleting'))
);

CREATE INDEX tenants_status_idx ON tenants (status);

-- ------------------------------------------------------------------ users
CREATE TABLE users (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    email            text NOT NULL,
    status           text NOT NULL DEFAULT 'active',
    email_verified_at timestamptz,
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),
    deleted_at       timestamptz,
    CONSTRAINT users_status_ck CHECK (status IN ('active','disabled'))
);
CREATE UNIQUE INDEX users_email_lower_uq ON users (lower(email));

CREATE TABLE user_profiles (
    user_id    uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    full_name  text NOT NULL,
    locale     text NOT NULL DEFAULT 'en',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

-- Authentication credentials. Intentionally NOT under RLS (Phase 1 decision, see DECISIONS ADR-013):
-- reached only via @sms/auth under the least-privilege app_rw connection. Harden further with
-- PgAudit in a later phase. Never return password hashes through any public endpoint.
CREATE TABLE auth_identities (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider      text NOT NULL DEFAULT 'password',
    provider_key  text NOT NULL,
    password_hash text,
    secret_enc    text,
    mfa_enabled   boolean NOT NULL DEFAULT false,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT auth_identities_provider_key_uq UNIQUE (provider, provider_key)
);
CREATE INDEX auth_identities_user_idx ON auth_identities (user_id);

CREATE TABLE auth_sessions (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    token_hash      text NOT NULL,
    ip              text,
    user_agent      text,
    active_tenant_id uuid,
    created_at      timestamptz NOT NULL DEFAULT now(),
    expires_at      timestamptz NOT NULL,
    last_active_at  timestamptz NOT NULL DEFAULT now(),
    revoked_at      timestamptz,
    CONSTRAINT auth_sessions_token_hash_uq UNIQUE (token_hash),
    CONSTRAINT auth_sessions_expiry_ck CHECK (expires_at > created_at)
);
CREATE INDEX auth_sessions_user_idx ON auth_sessions (user_id);
CREATE INDEX auth_sessions_expires_idx ON auth_sessions (expires_at);

CREATE TABLE auth_tokens (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_type  text NOT NULL,
    token_hash  text NOT NULL,
    expires_at  timestamptz NOT NULL,
    consumed_at timestamptz,
    created_at  timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT auth_tokens_token_hash_uq UNIQUE (token_hash)
);
CREATE INDEX auth_tokens_user_idx ON auth_tokens (user_id);

-- ------------------------------------------------------------------ memberships / rbac
CREATE TABLE memberships (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
    user_id    uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    status     text NOT NULL DEFAULT 'active',
    campus_id  uuid,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT memberships_user_tenant_uq UNIQUE (user_id, tenant_id),
    CONSTRAINT memberships_status_ck CHECK (status IN ('invited','active','suspended'))
);
CREATE INDEX memberships_tenant_idx ON memberships (tenant_id, status);

CREATE TABLE roles (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id    uuid REFERENCES tenants(id) ON DELETE CASCADE,
    scope        text NOT NULL DEFAULT 'tenant',
    code         text NOT NULL,
    name         text NOT NULL,
    description  text,
    is_system    boolean NOT NULL DEFAULT false,
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT roles_scope_ck CHECK (scope IN ('platform','tenant'))
);
CREATE UNIQUE INDEX roles_platform_code_uq ON roles (code) WHERE scope = 'platform';
CREATE UNIQUE INDEX roles_tenant_code_uq ON roles (tenant_id, code) WHERE tenant_id IS NOT NULL;
CREATE INDEX roles_tenant_idx ON roles (tenant_id);

CREATE TABLE role_permissions (
    role_id    uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    permission text NOT NULL,
    CONSTRAINT role_permissions_pk PRIMARY KEY (role_id, permission)
);
CREATE INDEX role_permissions_role_idx ON role_permissions (role_id);

CREATE TABLE membership_roles (
    membership_id uuid NOT NULL REFERENCES memberships(id) ON DELETE CASCADE,
    role_id       uuid NOT NULL REFERENCES roles(id) ON DELETE RESTRICT,
    CONSTRAINT membership_roles_pk PRIMARY KEY (membership_id, role_id)
);
CREATE INDEX membership_roles_membership_idx ON membership_roles (membership_id);
CREATE INDEX membership_roles_role_idx ON membership_roles (role_id);

CREATE TABLE platform_role_assignments (
    user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role_id    uuid NOT NULL REFERENCES roles(id) ON DELETE RESTRICT,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT platform_role_assignments_pk PRIMARY KEY (user_id, role_id)
);
CREATE INDEX platform_role_assignments_role_idx ON platform_role_assignments (role_id);

-- ------------------------------------------------------------------ audit
CREATE TABLE audit_logs (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    scope         text NOT NULL DEFAULT 'tenant',
    tenant_id     uuid,
    actor_user_id uuid,
    actor_type    text NOT NULL DEFAULT 'user',
    action        text NOT NULL,
    resource_type text,
    resource_id   text,
    old_value     jsonb,
    new_value     jsonb,
    ip            text,
    user_agent    text,
    request_id    text,
    occurred_at   timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT audit_logs_scope_ck CHECK (scope IN ('platform','tenant'))
);
CREATE INDEX audit_logs_tenant_time_idx ON audit_logs (tenant_id, occurred_at DESC);
CREATE INDEX audit_logs_resource_idx ON audit_logs (resource_type, resource_id);
CREATE INDEX audit_logs_action_idx ON audit_logs (action);

-- ------------------------------------------------------------------ outbox
CREATE TABLE outbox_events (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id      uuid,
    event_type     text NOT NULL,
    aggregate_type text NOT NULL,
    aggregate_id   text NOT NULL,
    payload        jsonb NOT NULL DEFAULT '{}'::jsonb,
    correlation_id uuid,
    causation_id   uuid,
    created_at     timestamptz NOT NULL DEFAULT now(),
    dispatched_at  timestamptz,
    processed_at   timestamptz,
    attempts       integer NOT NULL DEFAULT 0,
    last_error     text
);
CREATE INDEX outbox_unprocessed_idx ON outbox_events (created_at) WHERE processed_at IS NULL;

-- ------------------------------------------------------------------ idempotency
CREATE TABLE idempotency_keys (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid,
    key             text NOT NULL,
    request_hash    text,
    response_status integer,
    response_body   jsonb,
    created_at      timestamptz NOT NULL DEFAULT now(),
    expires_at      timestamptz NOT NULL
);
CREATE UNIQUE INDEX idempotency_keys_tenant_key_uq ON idempotency_keys (tenant_id, key) WHERE tenant_id IS NOT NULL;
CREATE UNIQUE INDEX idempotency_keys_global_key_uq ON idempotency_keys (key) WHERE tenant_id IS NULL;

-- ================================================================== RLS
-- GUC helpers: return NULL when unset (avoid '' cast errors).
CREATE FUNCTION app_current_tenant_id() RETURNS uuid
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS
    $$ SELECT NULLIF(current_setting('app.current_tenant', true), '')::uuid $$;

CREATE FUNCTION app_current_user_id() RETURNS uuid
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS
    $$ SELECT NULLIF(current_setting('app.current_user', true), '')::uuid $$;

-- tenants
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenants_select ON tenants FOR SELECT USING (
    (app_current_tenant_id() = id)
    OR current_setting('app.platform_access', true) = 'on'
    OR EXISTS (SELECT 1 FROM memberships m WHERE m.tenant_id = tenants.id AND m.user_id = app_current_user_id() AND m.status = 'active')
);
CREATE POLICY tenants_insert ON tenants FOR INSERT WITH CHECK (
    current_setting('app.platform_access', true) = 'on'
);
CREATE POLICY tenants_update ON tenants FOR UPDATE USING (
    current_setting('app.platform_access', true) = 'on' OR app_current_tenant_id() = id
) WITH CHECK (
    current_setting('app.platform_access', true) = 'on' OR app_current_tenant_id() = id
);

-- users (global registry: self / member-of-active-membership / platform)
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;
CREATE POLICY users_select ON users FOR SELECT USING (
    app_current_user_id() = id
    OR current_setting('app.platform_access', true) = 'on'
    OR EXISTS (SELECT 1 FROM memberships m
               WHERE m.user_id = users.id AND m.tenant_id = app_current_tenant_id() AND m.status = 'active')
);
CREATE POLICY users_insert ON users FOR INSERT WITH CHECK (true);
CREATE POLICY users_update ON users FOR UPDATE USING (
    app_current_user_id() = id OR current_setting('app.platform_access', true) = 'on'
);

-- user_profiles
ALTER TABLE user_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_profiles FORCE ROW LEVEL SECURITY;
CREATE POLICY user_profiles_select ON user_profiles FOR SELECT USING (
    app_current_user_id() = user_id OR current_setting('app.platform_access', true) = 'on'
);
CREATE POLICY user_profiles_write ON user_profiles FOR INSERT WITH CHECK (
    app_current_user_id() = user_id OR current_setting('app.platform_access', true) = 'on'
);
CREATE POLICY user_profiles_update ON user_profiles FOR UPDATE USING (
    app_current_user_id() = user_id OR current_setting('app.platform_access', true) = 'on'
);

-- auth_identities: NOT RLS-enforced (Phase 1 decision, see DECISIONS ADR-013).
-- Login is a pre-authentication lookup under app_rw; restricting the table would
-- require a BYPASSRLS definer function, which we explicitly avoid. Guarded by the
-- least-privilege app_rw connection + app-layer access only via @sms/auth.

-- auth_sessions: self-modifiable
ALTER TABLE auth_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY auth_sessions_select ON auth_sessions FOR SELECT USING (
    app_current_user_id() = user_id OR current_setting('app.platform_access', true) = 'on'
);
CREATE POLICY auth_sessions_insert ON auth_sessions FOR INSERT WITH CHECK (true);
CREATE POLICY auth_sessions_update ON auth_sessions FOR UPDATE USING (
    app_current_user_id() = user_id OR current_setting('app.platform_access', true) = 'on'
);

-- memberships: own memberships visible cross-tenant for switching; writes tenant-scoped
ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE memberships FORCE ROW LEVEL SECURITY;
CREATE POLICY memberships_select ON memberships FOR SELECT USING (
    (tenant_id = app_current_tenant_id() AND app_current_tenant_id() IS NOT NULL)
    OR app_current_user_id() = user_id
    OR current_setting('app.platform_access', true) = 'on'
);
CREATE POLICY memberships_insert ON memberships FOR INSERT WITH CHECK (
    tenant_id = app_current_tenant_id() OR current_setting('app.platform_access', true) = 'on'
);
CREATE POLICY memberships_update ON memberships FOR UPDATE USING (
    tenant_id = app_current_tenant_id() OR current_setting('app.platform_access', true) = 'on'
);

-- roles
ALTER TABLE roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE roles FORCE ROW LEVEL SECURITY;
CREATE POLICY roles_select ON roles FOR SELECT USING (
    (tenant_id = app_current_tenant_id() AND tenant_id IS NOT NULL)
    OR current_setting('app.platform_access', true) = 'on'
    OR EXISTS (SELECT 1 FROM memberships m
               WHERE m.user_id = app_current_user_id() AND m.tenant_id = roles.tenant_id AND m.status = 'active')
);
CREATE POLICY roles_insert ON roles FOR INSERT WITH CHECK (
    (scope = 'tenant' AND (tenant_id = app_current_tenant_id() OR current_setting('app.platform_access', true) = 'on'))
    OR (scope = 'platform' AND current_setting('app.platform_access', true) = 'on')
);
CREATE POLICY roles_update ON roles FOR UPDATE USING (
    (scope = 'tenant' AND (tenant_id = app_current_tenant_id() OR current_setting('app.platform_access', true) = 'on'))
    OR (scope = 'platform' AND current_setting('app.platform_access', true) = 'on')
);

-- role_permissions: scoped through their role's tenant; platform may manage any role
ALTER TABLE role_permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE role_permissions FORCE ROW LEVEL SECURITY;
CREATE POLICY role_permissions_rw ON role_permissions FOR ALL USING (
    EXISTS (SELECT 1 FROM roles r
            WHERE r.id = role_permissions.role_id
              AND (r.tenant_id = app_current_tenant_id() OR current_setting('app.platform_access', true) = 'on'))
) WITH CHECK (
    EXISTS (SELECT 1 FROM roles r
            WHERE r.id = role_permissions.role_id
              AND (r.tenant_id = app_current_tenant_id() OR current_setting('app.platform_access', true) = 'on'))
);

-- membership_roles: scoped via member membership (own memberships readable for switch)
ALTER TABLE membership_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE membership_roles FORCE ROW LEVEL SECURITY;
CREATE POLICY membership_roles_rw ON membership_roles FOR ALL USING (
    EXISTS (SELECT 1 FROM memberships m
            WHERE m.id = membership_roles.membership_id
              AND (m.user_id = app_current_user_id()
                   OR m.tenant_id = app_current_tenant_id()
                   OR current_setting('app.platform_access', true) = 'on'))
) WITH CHECK (
    EXISTS (SELECT 1 FROM memberships m
            WHERE m.id = membership_roles.membership_id
              AND (m.tenant_id = app_current_tenant_id()
                   OR current_setting('app.platform_access', true) = 'on'))
);

-- platform_role_assignments
ALTER TABLE platform_role_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_role_assignments FORCE ROW LEVEL SECURITY;
CREATE POLICY platform_role_assignments_rw ON platform_role_assignments FOR ALL USING (
    current_setting('app.platform_access', true) = 'on'
) WITH CHECK (current_setting('app.platform_access', true) = 'on');

-- audit: INSERT open (self-contained log rows), reads scope-checked
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs FORCE ROW LEVEL SECURITY;
CREATE POLICY audit_logs_insert ON audit_logs FOR INSERT WITH CHECK (
    (scope = 'tenant' AND tenant_id = app_current_tenant_id() AND tenant_id IS NOT NULL)
    OR (scope = 'platform' AND tenant_id IS NULL)
);
CREATE POLICY audit_logs_select ON audit_logs FOR SELECT USING (
    (scope = 'tenant' AND tenant_id = app_current_tenant_id())
    OR current_setting('app.platform_access', true) = 'on'
);

-- outbox: insert within context; system reads/updates for dispatch
ALTER TABLE outbox_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE outbox_events FORCE ROW LEVEL SECURITY;
CREATE POLICY outbox_events_insert ON outbox_events FOR INSERT WITH CHECK (
    (tenant_id = app_current_tenant_id() AND tenant_id IS NOT NULL)
    OR (tenant_id IS NULL AND current_setting('app.platform_access', true) = 'on')
    OR current_setting('app.system_access', true) = 'on'
);
CREATE POLICY outbox_events_read ON outbox_events FOR SELECT USING (
    current_setting('app.system_access', true) = 'on'
    OR (tenant_id = app_current_tenant_id() AND tenant_id IS NOT NULL)
);
CREATE POLICY outbox_events_update ON outbox_events FOR UPDATE USING (
    current_setting('app.system_access', true) = 'on'
);

-- idempotency_keys
ALTER TABLE idempotency_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE idempotency_keys FORCE ROW LEVEL SECURITY;
CREATE POLICY idempotency_keys_rw ON idempotency_keys FOR ALL USING (
    (tenant_id IS NOT NULL AND tenant_id = app_current_tenant_id() AND app_current_tenant_id() IS NOT NULL)
    OR (tenant_id IS NULL AND current_setting('app.platform_access', true) = 'on')
    OR current_setting('app.system_access', true) = 'on'
) WITH CHECK (
    (tenant_id IS NULL AND current_setting('app.platform_access', true) = 'on')
    OR current_setting('app.system_access', true) = 'on'
);

-- ================================================================== grants
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO school_app_rw;
GRANT SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO school_app_rw;
ALTER DEFAULT PRIVILEGES FOR ROLE school_migrator IN SCHEMA public
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO school_app_rw;
ALTER DEFAULT PRIVILEGES FOR ROLE school_migrator IN SCHEMA public
    GRANT USAGE, SELECT ON SEQUENCES TO school_app_rw;