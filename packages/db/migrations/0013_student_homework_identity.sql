-- 0013: Phase 4 finalization — student portal identity (forward-only).
--
-- Adds the missing half of the parent/student homework-portal story: a
-- tenant-local account link on students (students.user_id) so a portal user
-- holding the `student` role can be attached to exactly one LIVE student row
-- per tenant. Together with the Phase 4.3 guardians -> student_guardians ->
-- students -> enrollments chain (which already powers parent scope) this
-- completes both read-scoped homework portals.
--
-- DESIGN:
--   * The column is nullable and unlinked by default. Linking is an explicit
--     admin act via PATCH /api/v1/students/:id (students.update gate); unlink
--     is NULL, so portal read access is revoked the moment the link is cleared.
--   * The FK is composite and tenant-aware, anchored on the 0009
--     memberships_tenant_user_uq (tenant_id, user_id) index: a student can only
--     ever point at a user who is genuinely a member of the SAME tenant, so a
--     cross-tenant link is impossible even if application authz is bypassed.
--   * A BEFORE INSERT OR UPDATE OF user_id trigger (SECURITY INVOKER, same
--     pattern as trg_teacher_assignments_validate) re-verifies at the DB that
--     the target membership is ACTIVE. Under the runtime role the membership
--     lookup runs inside the caller's RLS, so a cross-tenant or non-member link
--     surfaces as the 55000 domain conflict `student_link_requires_membership`
--     rather than a raw FK error that could be probed for user existence.
--     Status is re-checked only at write time by design: suspending a
--     membership after linking simply deactivates the portal, because every
--     portal/resolver query derives role codes from ACTIVE memberships only
--     (tenantRoleCodes), so a suspended user is 'none' regardless of the link.
--   * One live student per portal user per tenant: the partial unique index
--     students_tenant_user_uq leaves soft-deleted (historical) students free to
--     keep their link while the current profile claims the portal identity.
--     Conflict 23505 -> `student_user_already_linked`.
--
-- DELIBERATELY OUT OF SCOPE: no new permissions, no new role templates, no new
-- worker events or routes in this file. The portal reuses the existing
-- homework.read permission and the Phase 4.3 homework + class homework routes.

-- ================================================================== column
ALTER TABLE students ADD COLUMN user_id uuid;

-- ================================================================== linkage
-- Composite tenant-aware anchor: references memberships_tenant_user_uq (0009).
ALTER TABLE students
    ADD CONSTRAINT students_user_membership_fk
    FOREIGN KEY (tenant_id, user_id) REFERENCES memberships (tenant_id, user_id)
    ON DELETE RESTRICT;

-- One LIVE student per portal user per tenant (soft-deleted history excluded,
-- mirroring students_student_no_uq).
CREATE UNIQUE INDEX students_tenant_user_uq ON students (tenant_id, user_id)
    WHERE user_id IS NOT NULL AND deleted_at IS NULL;

-- ================================================================== trigger
-- SECURITY INVOKER: the membership lookup runs under the invoking role's RLS,
-- so it is automatically tenant-local (cross-tenant membership is invisible).
CREATE OR REPLACE FUNCTION trg_students_user_link_validate()
RETURNS trigger AS $$
BEGIN
    IF NEW.user_id IS NULL THEN
        RETURN NEW;
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM memberships m
        WHERE m.tenant_id = NEW.tenant_id
          AND m.user_id = NEW.user_id
          AND m.status = 'active'
    ) THEN
        RAISE EXCEPTION 'student portal link requires an active membership in this tenant'
            USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
END
$$ LANGUAGE plpgsql SECURITY INVOKER;

DROP TRIGGER IF EXISTS trg_students_user_link_validate_biu ON students;
CREATE TRIGGER trg_students_user_link_validate_biu
    BEFORE INSERT OR UPDATE OF user_id ON students
    FOR EACH ROW EXECUTE FUNCTION trg_students_user_link_validate();