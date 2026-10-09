-- 0030: Phase 8 communication foundation (forward-only).
--
-- Adds the tenant-scoped communication domain beneath the Phase 2 authorization
-- layer. This migration creates EXACTLY the eight foundation tables frozen in
-- docs/PHASE_8_BLOCKING_DECISION_AND_READINESS_REPORT.md section 20.11:
--
--   notification_templates, notifications, announcements, message_threads,
--   message_thread_participants, messages, communication_preferences,
--   communication_quotas
--
-- Scope boundaries (frozen contract):
--   * 0031 owns template seed/override mechanics only (no new tables).
--   * 0032 owns per-channel delivery state, the recipient-bound dedupe UNIQUE
--     (tenant_id, dedupe_key, channel), budget/quota row-lock semantics and the
--     D2-1 event-type DB guard. Only the dedupe_key/channel columns ship here
--     (section 20.9/20.11); the UNIQUE stays in 0032.
--   * 0033 owns the six Phase 8 permissions; 0034 is reserved. No events and no
--     permission rows are created here.
--
-- SECURITY MODEL (inherited from 0002/0004)
--   * Every table is FORCE ROW LEVEL SECURITY. Policies trust ONLY the signed
--     context ticket (app_current_tenant_id()/app_current_user_id()/
--     app_privileged()); no raw current_setting('app.*') is read and no
--     BYPASSRLS / SET ROLE / SECURITY DEFINER shortcut is used.
--   * Cross-table tenant integrity uses composite tenant-aware foreign keys:
--     parents expose UNIQUE (tenant_id, id); children FK (tenant_id, parent_id)
--     to that anchor, so a cross-tenant parent reference fails at the DB before
--     any business rule runs.
--
-- INVARIANTS ENFORCED AT THE DB
--   * notifications C-1: exactly one of recipient_user_id / recipient_student_id
--     / recipient_guardian_id is non-NULL (recipient CHECK); C-4 recipient FKs
--     are account-linked (students.user_id / guardians.user_id anchors);
--     template_id is a nullable FK to notification_templates(id) ON DELETE SET
--     NULL.
--   * notifications C-2: SELECT visibility is canonical-recipient scoped --
--     user recipients see their own rows, student recipients are visible to the
--     student's linked user, guardian recipients to the guardian's linked user;
--     INSERT/UPDATE stay tenant-scoped and rls_privileged() executor escapes.
--   * notification_templates TMPL-1: rows are either system (tenant_id IS NULL,
--     is_system = true) or tenant-owned (tenant_id NOT NULL, is_system = false);
--     invariant (tenant_id IS NULL) <=> is_system; source_template_id self-FK
--     only for tenant rows. Tenants may only mutate their own non-system rows.
--   * communication_preferences consent (section 9.3 CONSENT-1): channel-wide,
--     UNIQUE (tenant_id, user_id, channel); an absent row means enabled. In-app
--     messaging is exempt and category-specific preferences are deferred.
--   * communication_quotas (section 9.4 ABUSE-1 / C-6): one counter per
--     (tenant_id, channel, quota_date); row-lock semantics are owned by 0032.

-- ========================================================== notification_templates
CREATE TABLE notification_templates (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id          uuid REFERENCES tenants (id) ON DELETE CASCADE,
    code               text NOT NULL,
    channel            text NOT NULL,
    locale             text NOT NULL DEFAULT 'en',
    subject            text,
    body               text NOT NULL,
    is_system          boolean NOT NULL DEFAULT false,
    source_template_id uuid REFERENCES notification_templates (id) ON DELETE SET NULL,
    created_at         timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now(),
    deleted_at         timestamptz,
    CONSTRAINT notification_templates_channel_ck
        CHECK (channel IN ('email', 'sms', 'push', 'in_app')),
    -- System rows are tenant-less; tenant rows are never system. This is the
    -- TMPL-1 invariant (tenant_id IS NULL) <=> is_system.
    CONSTRAINT notification_templates_system_tenant_ck
        CHECK ((tenant_id IS NULL) = is_system),
    -- source_template_id only exists for a tenant override of a system row.
    CONSTRAINT notification_templates_source_ck
        CHECK (source_template_id IS NULL OR tenant_id IS NOT NULL)
);
-- One system definition per (code, channel, locale); soft-deleted tenant
-- overrides do not block a re-created override.
CREATE UNIQUE INDEX notification_templates_system_uq
    ON notification_templates (code, channel, locale)
    WHERE tenant_id IS NULL;
CREATE UNIQUE INDEX notification_templates_tenant_uq
    ON notification_templates (tenant_id, code, channel, locale)
    WHERE tenant_id IS NOT NULL AND deleted_at IS NULL;
-- Composite tenant-aware anchor for self/child references.
CREATE UNIQUE INDEX notification_templates_tenant_id_uq
    ON notification_templates (tenant_id, id);

-- ========================================================== notifications
CREATE TABLE notifications (
    id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id            uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    template_id          uuid REFERENCES notification_templates (id) ON DELETE SET NULL,
    recipient_user_id    uuid REFERENCES users (id) ON DELETE RESTRICT,
    recipient_student_id uuid,
    recipient_guardian_id uuid,
    channel              text NOT NULL,
    dedupe_key           text NOT NULL,
    body                 text NOT NULL,
    created_at           timestamptz NOT NULL DEFAULT now(),
    updated_at           timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT notifications_channel_ck
        CHECK (channel IN ('email', 'sms', 'push', 'in_app')),
    -- C-1: exactly one recipient kind. Integer cast avoids a NULL result
    -- swallowing the comparison.
    CONSTRAINT notifications_recipient_exactly_one_ck CHECK (
        (recipient_user_id IS NOT NULL)::int
        + (recipient_student_id IS NOT NULL)::int
        + (recipient_guardian_id IS NOT NULL)::int
        = 1
    ),
    -- C-4: student/guardian recipients are tenant-bound account links.
    CONSTRAINT notifications_recipient_student_fk
        FOREIGN KEY (tenant_id, recipient_student_id)
        REFERENCES students (tenant_id, id) ON DELETE RESTRICT,
    CONSTRAINT notifications_recipient_guardian_fk
        FOREIGN KEY (tenant_id, recipient_guardian_id)
        REFERENCES guardians (tenant_id, id) ON DELETE RESTRICT
);
CREATE INDEX notifications_tenant_created_idx
    ON notifications (tenant_id, created_at DESC);
CREATE INDEX notifications_tenant_recipient_user_idx
    ON notifications (tenant_id, recipient_user_id);
CREATE INDEX notifications_tenant_recipient_student_idx
    ON notifications (tenant_id, recipient_student_id);
CREATE INDEX notifications_tenant_recipient_guardian_idx
    ON notifications (tenant_id, recipient_guardian_id);

-- ========================================================== announcements
CREATE TABLE announcements (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id          uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    title              text NOT NULL,
    body               text NOT NULL,
    audience_scope     jsonb NOT NULL DEFAULT '{}'::jsonb,
    recipient_snapshot jsonb,
    status             text NOT NULL DEFAULT 'draft',
    published_at       timestamptz,
    created_by         uuid REFERENCES users (id) ON DELETE SET NULL,
    created_at         timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now(),
    deleted_at         timestamptz,
    CONSTRAINT announcements_status_ck
        CHECK (status IN ('draft', 'published', 'cancelled'))
);
CREATE INDEX announcements_tenant_status_idx
    ON announcements (tenant_id, status, published_at DESC)
    WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX announcements_tenant_id_uq
    ON announcements (tenant_id, id);

-- ========================================================== message_threads
CREATE TABLE message_threads (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id  uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    subject    text,
    created_by uuid REFERENCES users (id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz
);
CREATE INDEX message_threads_tenant_created_idx
    ON message_threads (tenant_id, created_at DESC)
    WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX message_threads_tenant_id_uq
    ON message_threads (tenant_id, id);

-- ========================================================== message_thread_participants
CREATE TABLE message_thread_participants (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id  uuid NOT NULL,
    thread_id  uuid NOT NULL,
    user_id    uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT message_thread_participants_thread_fk
        FOREIGN KEY (tenant_id, thread_id)
        REFERENCES message_threads (tenant_id, id) ON DELETE CASCADE,
    -- Participant must be a member of the same tenant.
    CONSTRAINT message_thread_participants_user_fk
        FOREIGN KEY (tenant_id, user_id)
        REFERENCES memberships (tenant_id, user_id) ON DELETE CASCADE,
    CONSTRAINT message_thread_participants_uq
        UNIQUE (tenant_id, thread_id, user_id)
);
CREATE INDEX message_thread_participants_tenant_user_idx
    ON message_thread_participants (tenant_id, user_id);

-- ========================================================== messages
CREATE TABLE messages (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id      uuid NOT NULL,
    thread_id      uuid NOT NULL,
    sender_user_id uuid NOT NULL,
    body           text NOT NULL,
    created_at     timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT messages_thread_fk
        FOREIGN KEY (tenant_id, thread_id)
        REFERENCES message_threads (tenant_id, id) ON DELETE CASCADE,
    CONSTRAINT messages_sender_fk
        FOREIGN KEY (tenant_id, sender_user_id)
        REFERENCES memberships (tenant_id, user_id) ON DELETE RESTRICT
);
CREATE INDEX messages_thread_created_idx
    ON messages (thread_id, created_at);

-- ========================================================== communication_preferences
CREATE TABLE communication_preferences (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id  uuid NOT NULL,
    user_id    uuid NOT NULL,
    channel    text NOT NULL,
    enabled    boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT communication_preferences_channel_ck
        CHECK (channel IN ('email', 'sms', 'push', 'in_app')),
    CONSTRAINT communication_preferences_user_fk
        FOREIGN KEY (tenant_id, user_id)
        REFERENCES memberships (tenant_id, user_id) ON DELETE CASCADE,
    -- Channel-wide consent key: one preference row per user per channel.
    CONSTRAINT communication_preferences_uq
        UNIQUE (tenant_id, user_id, channel)
);

-- ========================================================== communication_quotas
CREATE TABLE communication_quotas (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id  uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    channel    text NOT NULL,
    quota_date date NOT NULL,
    sent_count integer NOT NULL DEFAULT 0,
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT communication_quotas_channel_ck
        CHECK (channel IN ('email', 'sms', 'push', 'in_app')),
    CONSTRAINT communication_quotas_sent_count_ck CHECK (sent_count >= 0),
    -- C-6 counter key; 0032 owns the row-lock increment semantics.
    CONSTRAINT communication_quotas_uq
        UNIQUE (tenant_id, channel, quota_date)
);

-- ========================================================== RLS (standard tenant shape)
-- Six tables use the standing 0004/0005 tenant policy shape: any row whose
-- tenant_id equals the signed tenant claim is visible/mutable, and the
-- privileged executor escapes. Hard DELETE is privileged-only, so the runtime
-- role can only soft-delete where a deleted_at column exists.
DO $$
DECLARE
    t text;
BEGIN
    FOREACH t IN ARRAY ARRAY[
        'announcements', 'message_threads', 'message_thread_participants',
        'messages', 'communication_preferences', 'communication_quotas'
    ] LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
        EXECUTE format(
            'CREATE POLICY %I ON %I FOR SELECT USING (
                 (tenant_id = app_current_tenant_id() AND app_current_tenant_id() IS NOT NULL)
                 OR app_privileged()
             )', t || '_select', t);
        EXECUTE format(
            'CREATE POLICY %I ON %I FOR INSERT WITH CHECK (
                 (tenant_id = app_current_tenant_id() AND app_current_tenant_id() IS NOT NULL)
                 OR app_privileged()
             )', t || '_insert', t);
        EXECUTE format(
            'CREATE POLICY %I ON %I FOR UPDATE USING (
                 (tenant_id = app_current_tenant_id() AND app_current_tenant_id() IS NOT NULL)
                 OR app_privileged()
             ) WITH CHECK (
                 (tenant_id = app_current_tenant_id() AND app_current_tenant_id() IS NOT NULL)
                 OR app_privileged()
             )', t || '_update', t);
        EXECUTE format(
            'CREATE POLICY %I ON %I FOR DELETE USING (app_privileged())',
            t || '_delete', t);
    END LOOP;
END
$$;

-- ------------------------------------------------ notifications (C-2) RLS
-- SELECT is canonical-recipient scoped: a user sees rows addressed to them
-- directly, plus rows addressed to a student/guardian they are linked to. All
-- branches are tenant-bound and end with the privileged escape.
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications FORCE ROW LEVEL SECURITY;
CREATE POLICY notifications_select ON notifications FOR SELECT USING (
    (
        tenant_id = app_current_tenant_id()
        AND app_current_tenant_id() IS NOT NULL
        AND (
            recipient_user_id = app_current_user_id()
            OR EXISTS (
                SELECT 1 FROM students s
                WHERE s.tenant_id = notifications.tenant_id
                  AND s.id = notifications.recipient_student_id
                  AND s.user_id = app_current_user_id()
                  AND s.deleted_at IS NULL
            )
            OR EXISTS (
                SELECT 1 FROM guardians g
                WHERE g.tenant_id = notifications.tenant_id
                  AND g.id = notifications.recipient_guardian_id
                  AND g.user_id = app_current_user_id()
                  AND g.deleted_at IS NULL
            )
        )
    )
    OR app_privileged()
);
CREATE POLICY notifications_insert ON notifications FOR INSERT WITH CHECK (
    (tenant_id = app_current_tenant_id() AND app_current_tenant_id() IS NOT NULL)
    OR app_privileged()
);
CREATE POLICY notifications_update ON notifications FOR UPDATE USING (
    (tenant_id = app_current_tenant_id() AND app_current_tenant_id() IS NOT NULL)
    OR app_privileged()
) WITH CHECK (
    (tenant_id = app_current_tenant_id() AND app_current_tenant_id() IS NOT NULL)
    OR app_privileged()
);
CREATE POLICY notifications_delete ON notifications FOR DELETE USING (app_privileged());

-- ------------------------------------------------ notification_templates (TMPL-1) RLS
-- System rows (tenant_id IS NULL, is_system) are readable from every tenant
-- context but still require a signed tenant claim, so a context-less session
-- sees nothing; tenant rows are visible/mutable only within their own tenant.
-- Runtime tenants cannot INSERT/UPDATE/DELETE system rows.
ALTER TABLE notification_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_templates FORCE ROW LEVEL SECURITY;
CREATE POLICY notification_templates_select ON notification_templates FOR SELECT USING (
    (tenant_id = app_current_tenant_id() AND app_current_tenant_id() IS NOT NULL)
    OR (tenant_id IS NULL AND is_system AND app_current_tenant_id() IS NOT NULL)
    OR app_privileged()
);
CREATE POLICY notification_templates_insert ON notification_templates FOR INSERT WITH CHECK (
    (tenant_id = app_current_tenant_id() AND app_current_tenant_id() IS NOT NULL AND NOT is_system)
    OR app_privileged()
);
CREATE POLICY notification_templates_update ON notification_templates FOR UPDATE USING (
    (tenant_id = app_current_tenant_id() AND app_current_tenant_id() IS NOT NULL AND NOT is_system)
    OR app_privileged()
) WITH CHECK (
    (tenant_id = app_current_tenant_id() AND app_current_tenant_id() IS NOT NULL AND NOT is_system)
    OR app_privileged()
);
CREATE POLICY notification_templates_delete ON notification_templates FOR DELETE USING (
    (tenant_id = app_current_tenant_id() AND app_current_tenant_id() IS NOT NULL AND NOT is_system)
    OR app_privileged()
);

-- ========================================================== grants
-- Explicit runtime grants (idempotent with 0001 default privileges).
GRANT SELECT, INSERT, UPDATE, DELETE ON
    notification_templates, notifications, announcements, message_threads,
    message_thread_participants, messages, communication_preferences,
    communication_quotas TO school_app_rw;
