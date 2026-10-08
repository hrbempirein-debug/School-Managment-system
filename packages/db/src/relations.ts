import { and, eq, inArray, isNull } from 'drizzle-orm';
import { guardians, studentGuardians, students, users } from './schema.js';
import type { Tx } from './client.js';

/**
 * THE D5 GUARDIAN↔STUDENT RELATIONSHIP CANON (decision D5-1).
 *
 * ── The defect ────────────────────────────────────────────────────────────────
 * `student_guardians` is the only one of the three relationship tables whose
 * `deleted_at` was silently dropped by the portal read paths. Soft-unlinking a
 * guardian therefore did NOT remove their access:
 *
 *   | site                                        | guardians | students | links |
 *   |---------------------------------------------|-----------|----------|-------|
 *   | `readableStudentIds` parent branch          |    ok     |    ok    |  MISS |
 *   | `parentScopesClass`                         |    ok     |   MISS   |  MISS |
 *   | `resolveHomeworkContext` parent branch      |    ok     |    ok    |  MISS |
 *   | worker `attendance.marked` recipients       |    ok     |   MISS*  |  MISS |
 *   | worker `exam.published` recipients          |    ok     |   MISS*  |  MISS |
 *   | `students.ts` management routes             |    ok     |    ok    |   ok  |
 *
 *   (`*` those two did not join `students` at all.)
 *
 * Phase 8 resolves announcement and messaging audiences through this same
 * relationship, so an un-fixed link would turn a removed guardian into a
 * RECIPIENT — a data disclosure, not a cosmetic bug.
 *
 * ── The rule ─────────────────────────────────────────────────────────────────
 * Every read of this relationship MUST apply all five predicates:
 *
 *   1. `guardians.tenant_id   = <tenant>`
 *   2. `guardians.user_id      = <caller>`      (recipient queries: not applicable)
 *   3. `guardians.deleted_at   IS NULL`
 *   4. `student_guardians.deleted_at IS NULL`   ← the one that was missing
 *   5. `students.deleted_at     IS NULL`
 *
 * This module is the single place those predicates are written. Call sites join
 * through `guardianStudentLinkJoin`/`linkStudentJoin` and scope through
 * `activeGuardianScope`, or call one of the two ready-made resolvers. The
 * canonicality guard in `relations-canonicality.test.ts` fails the build if a
 * site re-derives the join by hand without them.
 *
 * HONESTY NOTE: this is an APPLICATION-level invariant enforced by SQL
 * predicates. It is not a database security boundary — see the Phase 8
 * remediation report's treatment of D3 for the same distinction.
 */

/** A caller identity in a tenant. */
export type RelationCtx = { userId: string; tenantId: string | null };

/**
 * JOIN `guardians` → `student_guardians`: same tenant AND the link row is live.
 * Use as the second argument of `.innerJoin(studentGuardians, …)`.
 */
export function guardianStudentLinkJoin() {
  return and(
    eq(studentGuardians.tenantId, guardians.tenantId),
    eq(studentGuardians.guardianId, guardians.id),
    isNull(studentGuardians.deletedAt),
  );
}

/**
 * JOIN `student_guardians` → `students`: same tenant AND the student row is live.
 * Use as the second argument of `.innerJoin(students, …)`.
 */
export function linkStudentJoin() {
  return and(
    eq(students.tenantId, studentGuardians.tenantId),
    eq(students.id, studentGuardians.studentId),
    isNull(students.deletedAt),
  );
}

/**
 * The five mandatory WHERE predicates for a guardian→student read. Intended to
 * be combined with other route-specific conditions, e.g.
 *
 * ```ts
 * .from(guardians)
 * .innerJoin(studentGuardians, guardianStudentLinkJoin())
 * .innerJoin(students, linkStudentJoin())
 * .where(and(activeGuardianScope(ctx), isNull(enrollments.deletedAt)))
 * ```
 */
export function activeGuardianScope(ctx: RelationCtx) {
  return and(
    eq(guardians.tenantId, ctx.tenantId ?? ''),
    eq(studentGuardians.tenantId, ctx.tenantId ?? ''),
    eq(guardians.userId, ctx.userId),
    isNull(guardians.deletedAt),
    isNull(studentGuardians.deletedAt),
    isNull(students.deletedAt),
  );
}

/**
 * The four mandatory WHERE predicates for an audience/recipient read keyed by
 * tenant + student id rather than by caller (broadcast senders, workers).
 * `students.deleted_at` is applied by `linkStudentJoin`.
 */
export function activeLinkScope(tenantId: string) {
  return and(
    eq(studentGuardians.tenantId, tenantId),
    eq(guardians.tenantId, tenantId),
    isNull(studentGuardians.deletedAt),
    isNull(guardians.deletedAt),
  );
}

/**
 * Canonical parent-visibility resolver (D5-1 contract item 1): the set of live
 * students the caller is a live guardian of. Phase 8 audience selection MUST
 * call this — or one of the join helpers above — and never re-derive the join.
 */
export async function parentReadableStudentIds(
  tx: Tx,
  ctx: RelationCtx,
): Promise<readonly string[]> {
  const rows = await tx
    .selectDistinct({ studentId: studentGuardians.studentId })
    .from(guardians)
    .innerJoin(studentGuardians, guardianStudentLinkJoin())
    .innerJoin(students, linkStudentJoin())
    .where(activeGuardianScope(ctx))
    .execute();
  return rows.map((r) => r.studentId);
}

/**
 * Canonical recipient resolver: guardian e-mail addresses for a set of students,
 * restricted to live links. This is the query Phase 8's announcement/message
 * audience selector must reuse (or must satisfy with an equivalent predicate
 * bundle) — a soft-deleted link, guardian or student yields ZERO rows.
 */
export async function activeGuardianStudentEmails(
  tx: Tx,
  tenantId: string,
  studentIds: readonly string[],
): Promise<readonly { studentId: string; email: string }[]> {
  if (studentIds.length === 0) return [];
  const rows = await tx
    .selectDistinct({ studentId: studentGuardians.studentId, email: users.email })
    .from(studentGuardians)
    .innerJoin(guardians, guardianStudentLinkJoin())
    .innerJoin(students, linkStudentJoin())
    .innerJoin(users, eq(users.id, guardians.userId))
    .where(and(activeLinkScope(tenantId), inArray(studentGuardians.studentId, [...studentIds])))
    .execute();
  return rows;
}
