-- 0035: Guardian notification context + RLS (forward-only).
--
-- Closes the Phase 8 guardian leak (readiness report §21.6 and §22) by giving
-- student-scoped guardian notifications an explicit, tenant-bound student
-- context set instead of relying on the guardian row alone. Approved decisions
-- (readiness report §22):
--
--   * notifications.guardian_scope TEXT NOT NULL DEFAULT 'student_scoped'. The
--     only permitted value today is 'student_scoped'; a non-student-scoped
--     category requires a separate decision and a forward-only migration.
--   * notification_student_contexts: composite tenant-bound FKs to
--     notifications(tenant_id, id) and students(tenant_id, id), both
--     ON DELETE CASCADE (subordinate context rows only -- ordinary runtime
--     hard delete is unavailable by RLS, and the deferred checks fail closed).
--   * Visibility is ALL-context: a guardian-addressed notification is visible
--     to its guardian only while at least one context exists and EVERY context
--     student is a live student with a live guardian-student link to the
--     notification's guardian. Revoking any one link hides the entire
--     notification, delivered history included. There is no re-resolution,
--     retargeting, or retro-deletion when a link is revoked (the read path
--     loses visibility; history is preserved).
--   * Commit-time invariants are enforced by DEFERRABLE INITIALLY DEFERRED
--     constraint triggers (precedent: 0018, 0025): (a) every committed
--     guardian-addressed notification has at least one context row; (b) a
--     non-guardian notification has no context rows; (c) every committed
--     context references a live student with a live link to its guardian.
--     SQLSTATE 55000 for every refusal.
--
-- CONCURRENCY (see the final concurrency/deferred-constraint gate report)
-- Context-set validation is serialized per notification by taking a
-- transaction-scoped advisory lock keyed on (tenant_id, notification_id) before
-- re-reading current state. An advisory lock is used -- not FOR UPDATE -- because
-- reassigning a context makes the immediate composite FK take a FOR KEY SHARE
-- lock on the NEW parent at statement time; two mirrored reassignments then hold
-- opposite parents KEY SHARE and a later FOR UPDATE on both parents in canonical
-- order deadlocks AB-BA (surfaced as 40P01 by the H2 gate). Advisory locks do not
-- conflict with the FK's row locks, so a reassignment that touches OLD and NEW
-- parents acquires both locks in canonical ascending
-- (tenant_id, notification_id) order and mirrored updates serialize instead of
-- deadlocking. Both the child trigger and the parent trigger take the same lock,
-- so a concurrent parent reclassification and a child change also serialize.
-- Checks always re-read current rows after locking; they never trust stale
-- OLD/NEW images. Link revocation is NOT serialized here on purpose: revoked-link
-- visibility is a read-time predicate, and a concurrent revoker either makes this
-- transaction fail its commit (fail closed) or commits after it and hides the
-- row at read.
--
-- SECURITY MODEL (inherited from 0002/0004)
-- Every helper and trigger function is SECURITY INVOKER with the fixed
-- search_path (pg_catalog, public, pg_temp), PUBLIC EXECUTE is revoked, and
-- the runtime role receives EXECUTE only on the read-only helpers the policies
-- and triggers call. No SECURITY DEFINER, no new role, no bypass GUC, no
-- privilege beyond the standing tenant-shape grants.

-- ---------------------------------------------------------- anchor (O1)
-- Required composite-tenant anchor so notification_student_contexts can hold a
-- tenant-bound FK to notifications. None exists below: the four 0030 indexes
-- on notifications are all non-unique (0030:117-124).
CREATE UNIQUE INDEX notifications_tenant_id_uq ON notifications (tenant_id, id);

-- ---------------------------------------------------------- classification (O2)
-- Approved single-value classification. The NOT NULL DEFAULT keeps the 0030
-- table contract intact; the CHECK is the fail-closed domain (any future value
-- needs a decision + forward-only migration).
ALTER TABLE notifications ADD COLUMN guardian_scope text NOT NULL DEFAULT 'student_scoped';
ALTER TABLE notifications ADD CONSTRAINT notifications_guardian_scope_ck
    CHECK (guardian_scope IN ('student_scoped'));

-- ---------------------------------------------------------- context table (O3)
CREATE TABLE notification_student_contexts (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid NOT NULL,
    notification_id uuid NOT NULL,
    student_id      uuid NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT notification_student_contexts_scope_uq
        UNIQUE (tenant_id, notification_id, student_id),
    CONSTRAINT notification_student_contexts_notification_fk
        FOREIGN KEY (tenant_id, notification_id)
        REFERENCES notifications (tenant_id, id) ON DELETE CASCADE,
    CONSTRAINT notification_student_contexts_student_fk
        FOREIGN KEY (tenant_id, student_id)
        REFERENCES students (tenant_id, id) ON DELETE CASCADE
);
-- The UNIQUE index doubles as the (tenant_id, notification_id) prefix access
-- path used by every commit-time and read-time context check.
COMMENT ON TABLE notification_student_contexts IS
    'Tenant-bound student context of a guardian-addressed notification. Any '
    'context row on a non-guardian notification is a commit-time violation.';

-- ---------------------------------------------------------- grants
-- Standard tenant shape: the runtime role receives all four table privileges
-- (0005:356-359, 0030:351-354) and RLS -- not partial revocation -- is the
-- enforcement boundary. The context set is integrity-critical: UPDATE and DELETE
-- are PRIVILEGED-ONLY policies (unlike the ordinary 0030 tenant tables), so a
-- runtime session can insert contexts but can never reassign or remove one --
-- ordinary runtime UPDATE/DELETE affect 0 rows (FORCE RLS, 0030:241-242), while
-- privileged maintenance and the deferred triggers still function. FORCE RLS
-- applies to the table owner too, so these policies are required for the
-- migration/DDL role to maintain rows at all.
GRANT SELECT, INSERT, UPDATE, DELETE ON notification_student_contexts TO school_app_rw;

-- ---------------------------------------------------------- RLS (context table)
ALTER TABLE notification_student_contexts ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_student_contexts FORCE ROW LEVEL SECURITY;
CREATE POLICY notification_student_contexts_select ON notification_student_contexts
    FOR SELECT USING (
        (tenant_id = app_current_tenant_id() AND app_current_tenant_id() IS NOT NULL)
        OR app_privileged()
    );
CREATE POLICY notification_student_contexts_insert ON notification_student_contexts
    FOR INSERT WITH CHECK (
        (tenant_id = app_current_tenant_id() AND app_current_tenant_id() IS NOT NULL)
        OR app_privileged()
    );
CREATE POLICY notification_student_contexts_update ON notification_student_contexts
    FOR UPDATE USING (app_privileged())
    WITH CHECK (app_privileged());
CREATE POLICY notification_student_contexts_delete ON notification_student_contexts
    FOR DELETE USING (app_privileged());

-- ---------------------------------------------------------- helpers (read-only, SECURITY INVOKER)
-- True when, in this transaction, `p_student` (in `p_tenant`) is a live
-- student with a live guardian-student link to `p_guardian`.
CREATE OR REPLACE FUNCTION fn_notification_context_row_valid(
    p_tenant   uuid,
    p_notif_id uuid,
    p_student  uuid,
    p_guardian uuid
) RETURNS boolean
    LANGUAGE sql
    STABLE
    SECURITY INVOKER
    SET search_path = pg_catalog, public, pg_temp
AS $$
    SELECT p_guardian IS NOT NULL
       AND EXISTS (
            SELECT 1 FROM students s
            WHERE s.tenant_id = p_tenant
              AND s.id = p_student
              AND s.deleted_at IS NULL
       )
       AND EXISTS (
            SELECT 1 FROM student_guardians sg
            WHERE sg.tenant_id = p_tenant
              AND sg.student_id = p_student
              AND sg.guardian_id = p_guardian
              AND sg.deleted_at IS NULL
       )
$$;
REVOKE ALL ON FUNCTION fn_notification_context_row_valid(uuid, uuid, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fn_notification_context_row_valid(uuid, uuid, uuid, uuid) TO school_app_rw;

-- True when the context set of `(p_tenant, p_notif_id)` satisfies the approved
-- final-state invariant:
--   * non-guardian-addressed (p_guardian IS NULL) -> zero context rows;
--   * guardian-addressed -> at least one context row AND no context row whose
--     student is not a live student with a live link to p_guardian.
-- The per-row validity test is deliberately an exclusive NOT EXISTS(NOT(...));
-- an inner-join form would silently drop orphaned context rows and could pass
-- a notification whose only context is invalid.
CREATE OR REPLACE FUNCTION fn_notification_scope_ok(
    p_tenant   uuid,
    p_notif_id uuid,
    p_guardian uuid
) RETURNS boolean
    LANGUAGE sql
    STABLE
    SECURITY INVOKER
    SET search_path = pg_catalog, public, pg_temp
AS $$
    SELECT CASE
        WHEN p_guardian IS NULL THEN NOT EXISTS (
            SELECT 1 FROM notification_student_contexts c
            WHERE c.tenant_id = p_tenant
              AND c.notification_id = p_notif_id
        )
        ELSE EXISTS (
                SELECT 1 FROM notification_student_contexts c
                WHERE c.tenant_id = p_tenant
                  AND c.notification_id = p_notif_id
             )
             AND NOT EXISTS (
                SELECT 1 FROM notification_student_contexts c
                WHERE c.tenant_id = p_tenant
                  AND c.notification_id = p_notif_id
                  AND NOT (
                        EXISTS (
                            SELECT 1 FROM students s
                            WHERE s.tenant_id = c.tenant_id
                              AND s.id = c.student_id
                              AND s.deleted_at IS NULL
                        )
                        AND EXISTS (
                            SELECT 1 FROM student_guardians sg
                            WHERE sg.tenant_id = c.tenant_id
                              AND sg.student_id = c.student_id
                              AND sg.guardian_id = p_guardian
                              AND sg.deleted_at IS NULL
                        )
                  )
             )
    END
$$;
REVOKE ALL ON FUNCTION fn_notification_scope_ok(uuid, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fn_notification_scope_ok(uuid, uuid, uuid) TO school_app_rw;

-- Serialize context-set validation for one notification across transactions.
-- A transaction-scoped advisory lock keyed on (tenant_id, notification_id) is
-- taken (not a parent row lock): the immediate composite FK already holds a FOR
-- KEY SHARE row lock on the NEW parent from statement time, which conflicts with
-- FOR UPDATE and would AB-BA deadlock mirrored reassignments. Advisory locks are
-- held until transaction end and are re-entrant within a transaction; the key is
-- deterministic so both triggers agree. Returns nothing; later re-reads observe
-- the latest committed state (READ COMMITTED).
CREATE OR REPLACE FUNCTION fn_lock_notification_parent(p_tenant uuid, p_notif_id uuid)
RETURNS void
    LANGUAGE plpgsql
    SECURITY INVOKER
    SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
    PERFORM pg_advisory_xact_lock(hashtext(p_tenant::text), hashtext(p_notif_id::text));
END
$$;
REVOKE ALL ON FUNCTION fn_lock_notification_parent(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fn_lock_notification_parent(uuid, uuid) TO school_app_rw;

-- ---------------------------------------------------------- parent trigger (notifications)
-- Defers to COMMIT so a runtime launch can insert the notification and its
-- context rows in one transaction in any legal order (the child FK is
-- immediate, so 'context before notification' is structurally impossible and
-- needs no deferral). Takes the per-notification validation lock and re-reads
-- the context set at commit; never trusts OLD/NEW.
CREATE OR REPLACE FUNCTION trg_notifications_scope_consistent() RETURNS trigger
    LANGUAGE plpgsql
    SECURITY INVOKER
    SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;
    PERFORM fn_lock_notification_parent(NEW.tenant_id, NEW.id);
    IF NOT fn_notification_scope_ok(NEW.tenant_id, NEW.id, NEW.recipient_guardian_id) THEN
        RAISE EXCEPTION
            'a notification cannot commit without a valid context set (notification %, tenant %, guardian %)',
            NEW.id, NEW.tenant_id, NEW.recipient_guardian_id
            USING ERRCODE = '55000';
    END IF;
    RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION trg_notifications_scope_consistent() FROM PUBLIC;

-- ---------------------------------------------------------- context trigger (notification_student_contexts)
-- Validates the NEW side (guardian-addressed parent + live linked student) and
-- re-validates the OLD parent's surviving context set after re-reading, with
-- per-notification validation locks acquired in canonical (tenant_id,
-- notification_id) order.
CREATE OR REPLACE FUNCTION trg_notification_contexts_consistent() RETURNS trigger
    LANGUAGE plpgsql
    SECURITY INVOKER
    SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    v_g_new uuid;
    v_g_old uuid;
BEGIN
    IF TG_OP = 'INSERT' THEN
        PERFORM fn_lock_notification_parent(NEW.tenant_id, NEW.notification_id);
        SELECT recipient_guardian_id INTO v_g_new
          FROM notifications
         WHERE tenant_id = NEW.tenant_id AND id = NEW.notification_id;
        IF NOT FOUND OR v_g_new IS NULL THEN
            RAISE EXCEPTION
                'a context row may only reference a guardian-addressed notification (notification %, tenant %)',
                NEW.notification_id, NEW.tenant_id
                USING ERRCODE = '55000';
        END IF;
        IF NOT fn_notification_context_row_valid(
                NEW.tenant_id, NEW.notification_id, NEW.student_id, v_g_new) THEN
            RAISE EXCEPTION
                'a context row must reference a live student with a live guardian link (notification %, tenant %, student %, guardian %)',
                NEW.notification_id, NEW.tenant_id, NEW.student_id, v_g_new
                USING ERRCODE = '55000';
        END IF;
        RETURN NULL;
    END IF;

    IF TG_OP = 'UPDATE' THEN
        -- Canonical two-parent lock order when the row moves between
        -- notifications, so mirrored reassignments cannot AB-BA deadlock.
        IF (OLD.tenant_id, OLD.notification_id) <> (NEW.tenant_id, NEW.notification_id) THEN
            IF (OLD.tenant_id, OLD.notification_id) < (NEW.tenant_id, NEW.notification_id) THEN
                PERFORM fn_lock_notification_parent(OLD.tenant_id, OLD.notification_id);
                PERFORM fn_lock_notification_parent(NEW.tenant_id, NEW.notification_id);
            ELSE
                PERFORM fn_lock_notification_parent(NEW.tenant_id, NEW.notification_id);
                PERFORM fn_lock_notification_parent(OLD.tenant_id, OLD.notification_id);
            END IF;
        ELSE
            PERFORM fn_lock_notification_parent(NEW.tenant_id, NEW.notification_id);
        END IF;

        SELECT recipient_guardian_id INTO v_g_new
          FROM notifications
         WHERE tenant_id = NEW.tenant_id AND id = NEW.notification_id;
        IF NOT FOUND OR v_g_new IS NULL THEN
            RAISE EXCEPTION
                'a context row may only reference a guardian-addressed notification (notification %, tenant %)',
                NEW.notification_id, NEW.tenant_id
                USING ERRCODE = '55000';
        END IF;
        IF NOT fn_notification_context_row_valid(
                NEW.tenant_id, NEW.notification_id, NEW.student_id, v_g_new) THEN
            RAISE EXCEPTION
                'a context row must reference a live student with a live guardian link (notification %, tenant %, student %, guardian %)',
                NEW.notification_id, NEW.tenant_id, NEW.student_id, v_g_new
                USING ERRCODE = '55000';
        END IF;

        SELECT recipient_guardian_id INTO v_g_old
          FROM notifications
         WHERE tenant_id = OLD.tenant_id AND id = OLD.notification_id;
        IF FOUND THEN
            IF NOT fn_notification_scope_ok(OLD.tenant_id, OLD.notification_id, v_g_old) THEN
                RAISE EXCEPTION
                    'moving this context would leave its source notification without a valid context set (source notification %, tenant %)',
                    OLD.notification_id, OLD.tenant_id
                    USING ERRCODE = '55000';
            END IF;
        END IF;
        RETURN NULL;
    END IF;

    -- DELETE: re-validate the surviving set of the OLD parent (the removed row
    -- is gone). When the parent itself is deleted/cascaded in this transaction
    -- it is no longer re-readable and FOUND is false, so a legitimately
    -- cascaded-away parent is distinct from a surviving invalid parent.
    PERFORM fn_lock_notification_parent(OLD.tenant_id, OLD.notification_id);
    SELECT recipient_guardian_id INTO v_g_old
      FROM notifications
     WHERE tenant_id = OLD.tenant_id AND id = OLD.notification_id;
    IF FOUND THEN
        IF NOT fn_notification_scope_ok(OLD.tenant_id, OLD.notification_id, v_g_old) THEN
            RAISE EXCEPTION
                'removing this context would leave notification % (tenant %) without a valid context set',
                OLD.notification_id, OLD.tenant_id
                USING ERRCODE = '55000';
        END IF;
    END IF;
    RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION trg_notification_contexts_consistent() FROM PUBLIC;

-- ---------------------------------------------------------- constraint triggers
DROP TRIGGER IF EXISTS notifications_scope_consistent_trg ON notifications;
CREATE CONSTRAINT TRIGGER notifications_scope_consistent_trg
    AFTER INSERT OR UPDATE ON notifications
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION trg_notifications_scope_consistent();

DROP TRIGGER IF EXISTS notification_contexts_consistent_trg ON notification_student_contexts;
CREATE CONSTRAINT TRIGGER notification_contexts_consistent_trg
    AFTER INSERT OR UPDATE OR DELETE ON notification_student_contexts
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION trg_notification_contexts_consistent();

-- ---------------------------------------------------------- notifications SELECT (ALL-context guardian branch)
-- Replaces the C-2 guardian branch (0030:297-303) so a guardian notification
-- is visible ONLY while at least one context exists and EVERY context student
-- is a live student live-linked to the notification's guardian. Revoking any
-- link (student_guardians.deleted_at), soft-deleting any student, or lacking a
-- context hides the entire notification -- delivered history included. The
-- student branch is unchanged; the privileged escape is preserved.
DROP POLICY IF EXISTS notifications_select ON notifications;
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
            OR (
                recipient_guardian_id IS NOT NULL
                AND EXISTS (
                    SELECT 1 FROM guardians g
                    WHERE g.tenant_id = notifications.tenant_id
                      AND g.id = notifications.recipient_guardian_id
                      AND g.user_id = app_current_user_id()
                      AND g.deleted_at IS NULL
                      AND fn_notification_scope_ok(
                                notifications.tenant_id,
                                notifications.id,
                                g.id)
                )
            )
        )
    )
    OR app_privileged()
);