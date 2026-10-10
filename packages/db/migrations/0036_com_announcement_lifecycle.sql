-- 0036: Announcement lifecycle + content immutability (forward-only).
--
-- Enforces the approved announcement lifecycle and frozen-content rules
-- (readiness report §22 and the final design review):
--
--   * INSERT: only status 'draft', published_at NULL.
--   * Status graph (allow-list): draft->draft, draft->published,
--     draft->cancelled, published->published, published->cancelled,
--     cancelled->cancelled. Everything else is refused.
--   * published_at is server-owned: assigned by the trigger on the first
--     draft->published transition, preserved across published->cancelled, and
--     never clearable or changeable.
--   * Immutable identity: id, tenant_id, created_at. created_by is NOT frozen
--     because announcements.created_by REFERENCES users ON DELETE SET NULL
--     (0030:136): freezing it would break legitimate user deletion.
--   * Frozen content: title, body and audience_scope are immutable once the
--     existing row is 'published' or 'cancelled'; they remain mutable while
--     draft. JSONB comparisons use IS DISTINCT FROM (structural, NULL-safe), so
--     key reordering cannot bypass the freeze and three-valued logic cannot
--     leak a change through.
--   * recipient_snapshot is write-once: NULL -> value exactly once; clearing
--     or rewriting a non-NULL snapshot is refused. No population logic lives
--     here (fanout/delivery timing is out of scope).
--   * deleted_at is one-way (Option A): NULL -> timestamp once; clearing or
--     re-stamping is refused, and a soft delete may not change status or
--     frozen content.
--   * DELETE: published/cancelled announcements are refused for every role
--     (55000) because no retention policy or purge authorization exists. This
--     refusal is INTERIM and forward-only: only a separately approved migration
--     may change it after a retention policy is approved. Draft DELETE remains
--     governed by the existing privileged-only RLS path (0030:271-273).
--
-- One combined BEFORE INSERT OR UPDATE OR DELETE trigger (precedent:
-- 0022 trg_fin_structure_publish_freeze). Function is SECURITY INVOKER, fixed
-- search_path (pg_catalog, public, pg_temp), PUBLIC EXECUTE revoked. Every
-- refusal uses SQLSTATE 55000. BEFORE semantics: RETURN NEW on insert/update,
-- RETURN OLD on delete; never RETURN NULL (that would silently cancel the row
-- instead of refusing with an explicit error).

CREATE OR REPLACE FUNCTION trg_announcements_lifecycle() RETURNS trigger
    LANGUAGE plpgsql
    SECURITY INVOKER
    SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
    -- DELETE: only a draft may be physically removed (privileged-only RLS).
    -- Non-draft rows are frozen until a separately approved retention policy.
    IF TG_OP = 'DELETE' THEN
        IF OLD.status <> 'draft' THEN
            RAISE EXCEPTION
                'a % announcement is frozen; it cannot be hard-deleted until a retention policy exists',
                OLD.status
                USING ERRCODE = '55000';
        END IF;
        RETURN OLD;
    END IF;

    -- INSERT: the only legal starting state is draft with no publication stamp.
    IF TG_OP = 'INSERT' THEN
        IF NEW.status IS DISTINCT FROM 'draft' THEN
            RAISE EXCEPTION
                'an announcement must be created as draft, not %', NEW.status
                USING ERRCODE = '55000';
        END IF;
        IF NEW.published_at IS NOT NULL THEN
            RAISE EXCEPTION
                'a new announcement may not carry a publication stamp'
                USING ERRCODE = '55000';
        END IF;
        RETURN NEW;
    END IF;

    -- ----------------------------------------------------------- UPDATE

    -- Identity is immutable. created_by is deliberately NOT here (see header).
    IF NEW.id IS DISTINCT FROM OLD.id
       OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'an announcement identity field is immutable'
            USING ERRCODE = '55000';
    END IF;

    -- Allowed status transitions, as an allow-list (0022:782-788 pattern).
    -- Self-loops are covered by the IS DISTINCT FROM guard.
    IF NEW.status IS DISTINCT FROM OLD.status
       AND NOT (
            (OLD.status = 'draft'      AND NEW.status IN ('published', 'cancelled'))
            OR (OLD.status = 'published' AND NEW.status = 'cancelled')
       ) THEN
        RAISE EXCEPTION 'an announcement cannot transition from % to %', OLD.status, NEW.status
            USING ERRCODE = '55000';
    END IF;

    -- Server-owned publication stamp. The first draft->published transition
    -- assigns now(); anything else must keep OLD.published_at untouched.
    IF OLD.status = 'draft' AND NEW.status = 'published' THEN
        NEW.published_at := now();
    ELSIF NEW.published_at IS DISTINCT FROM OLD.published_at THEN
        RAISE EXCEPTION 'the publication stamp of an announcement is server-owned and write-once'
            USING ERRCODE = '55000';
    END IF;

    -- recipient_snapshot: NULL -> value exactly once; no clearing or rewrite.
    IF OLD.recipient_snapshot IS NOT NULL
       AND NEW.recipient_snapshot IS DISTINCT FROM OLD.recipient_snapshot THEN
        RAISE EXCEPTION 'recipient_snapshot is write-once'
            USING ERRCODE = '55000';
    END IF;

    -- deleted_at: one-way soft delete; changing status while soft-deleting is
    -- refused too, so a soft delete cannot smuggle a status change through.
    IF NEW.deleted_at IS DISTINCT FROM OLD.deleted_at THEN
        IF OLD.deleted_at IS NOT NULL OR NEW.deleted_at IS NULL THEN
            RAISE EXCEPTION 'deleted_at is one-way; it can only move from NULL to a timestamp once'
                USING ERRCODE = '55000';
        END IF;
        IF NEW.status IS DISTINCT FROM OLD.status THEN
            RAISE EXCEPTION 'a soft delete may not change the announcement status'
                USING ERRCODE = '55000';
        END IF;
    END IF;

    -- Frozen content once published or cancelled. IS DISTINCT FROM on jsonb is
    -- structural, so audience_scope key order cannot be used to bypass it.
    IF OLD.status IN ('published', 'cancelled') THEN
        IF NEW.title IS DISTINCT FROM OLD.title
           OR NEW.body IS DISTINCT FROM OLD.body
           OR NEW.audience_scope IS DISTINCT FROM OLD.audience_scope THEN
            RAISE EXCEPTION 'a % announcement is frozen and cannot be edited', OLD.status
                USING ERRCODE = '55000';
        END IF;
    END IF;

    RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION trg_announcements_lifecycle() FROM PUBLIC;

DROP TRIGGER IF EXISTS announcements_lifecycle_trg ON announcements;
CREATE TRIGGER announcements_lifecycle_trg
    BEFORE INSERT OR UPDATE OR DELETE ON announcements
    FOR EACH ROW EXECUTE FUNCTION trg_announcements_lifecycle();