-- 0006_student_guardians_soft_link
--
-- Forward-only Phase 3.2 change: makes the student↔guardian relation soft-deletable
-- so the runtime role (`school_app_rw`, which is FORCE-row-level-secured and can
-- only ever soft-delete — every runtime DELETE policy is app_privileged()-only, see
-- 0005 §RLS) can unlink a guardian from a student by flipping `deleted_at`.
--
-- Why:
--   0005 created `student_guardians` with a full `UNIQUE (tenant_id, student_id,
--   guardian_id, relation)` constraint and no `deleted_at` column. That left the
--   relation with no supported unlink path:
--     * a hard DELETE is impossible (runtime role has no DELETE policy);
--     * a soft unlink is impossible (no column to flip);
--   and re-linking the same (student, guardian, relation) could never be expressed.
--   Phase 3.2's `DELETE /students/:id/guardians/:guardianId` contract (API_DESIGN.md
--   §2 sub-resources + soft-delete convention used by every other school table)
--   requires exactly that. Migration 0006 therefore adopts the module-wide
--   soft-delete convention already used for students/guardians/enrollments...
--   (partial unique index scoped to `deleted_at IS NULL`), keeping the historical
--   row for audit while allowing the relation to be re-created afterwards.

ALTER TABLE student_guardians ADD COLUMN deleted_at timestamptz;

-- The relation uniqueness was declared as an inline UNIQUE constraint in 0005;
-- drop the constraint (which drops its backing index) and re-create it as a
-- partial unique index that ignores soft-unlinked rows.
ALTER TABLE student_guardians DROP CONSTRAINT IF EXISTS student_guardians_relation_uq;
CREATE UNIQUE INDEX student_guardians_relation_uq
    ON student_guardians (tenant_id, student_id, guardian_id, relation)
    WHERE deleted_at IS NULL;

-- Keep the per-side lookup indexes consistent with the soft-delete read path
-- (list-linked-guardians / list-linked-students now filter deleted_at IS NULL).
DROP INDEX IF EXISTS student_guardians_student_idx;
DROP INDEX IF EXISTS student_guardians_guardian_idx;
CREATE INDEX student_guardians_student_idx
    ON student_guardians (tenant_id, student_id)
    WHERE deleted_at IS NULL;
CREATE INDEX student_guardians_guardian_idx
    ON student_guardians (tenant_id, guardian_id)
    WHERE deleted_at IS NULL;