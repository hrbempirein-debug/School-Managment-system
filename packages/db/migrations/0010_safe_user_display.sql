-- ============================================================================
-- 0010_safe_user_display.sql — controlled SECURITY DEFINER display-name helper
-- ============================================================================
-- Phase 4.2 added an eligible-teacher directory (GET /teachers). Teachers are
-- ACTIVE tenant memberships carrying the tenant-scoped `teacher` role; the
-- directory legitimately needs the display name of OTHER members.
--
-- user_profiles is self-visible only (policy user_profiles_select requires
-- app_current_user_id() = user_id, platform scope, or privileged). A plain
-- JOIN therefore hides every other member's profile, and broadening that
-- policy would leak display names platform-wide. The established pattern for
-- "needs to see what self-visibility hides, but still bounded" is a controlled
-- SECURITY DEFINER helper (see app_auth_login_lookup in 0002).
--
-- app_safe_user_display(user_id, tenant_id) returns the target member's display
-- name ONLY when BOTH the calling user and the target user hold an ACTIVE
-- membership in that tenant:
--   * the caller clause prevents cross-tenant data exfiltration — a tenant-
--     scoped session cannot read another tenant's names by passing an arbitrary
--     tenant_id;
--   * the target clause ensures the name is not reachable for a user who is not
--     actually a member of the tenant.
-- The route still applies the teacher-role filter itself; this helper stays
-- generic so later member-facing directories can reuse it.
-- ============================================================================

CREATE OR REPLACE FUNCTION app_safe_user_display(p_user_id uuid, p_tenant_id uuid)
    RETURNS text
    LANGUAGE sql
    STABLE
    SECURITY DEFINER
    SET search_path = public, pg_catalog
AS $$
    SELECT u_p.full_name
      FROM user_profiles u_p
     WHERE u_p.user_id = p_user_id
       AND EXISTS (
            SELECT 1 FROM memberships m_caller
             WHERE m_caller.user_id = app_current_user_id()
               AND m_caller.tenant_id = p_tenant_id
               AND m_caller.status = 'active'
       )
       AND EXISTS (
            SELECT 1 FROM memberships m_target
             WHERE m_target.user_id = p_user_id
               AND m_target.tenant_id = p_tenant_id
               AND m_target.status = 'active'
       );
$$;

REVOKE ALL ON FUNCTION app_safe_user_display(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_safe_user_display(uuid, uuid) TO school_app_rw;