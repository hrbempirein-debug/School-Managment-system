import type { FastifyInstance } from 'fastify';
import { and, count, desc, eq, inArray, isNull } from 'drizzle-orm';
import {
  acdClasses,
  subjects,
  classSubjects,
  teacherAssignments,
  memberships,
  membershipRoles,
  roles,
  homework,
  homeworkAttachments,
  files,
  students,
  studentGuardians,
  guardians,
  enrollments,
  withTenant,
  type Tx,
} from '@sms/db';
import { HttpError } from '@sms/core';
import { writeAudit } from '@sms/audit';
import { enqueueOutbox } from '@sms/events';
import { requestFingerprint, withIdempotency } from '@sms/idempotency';
import {
  createHomeworkRequestSchema,
  homeworkListQuerySchema,
  homeworkListParamSchema,
  homeworkParamSchema,
  updateHomeworkRequestSchema,
  type Homework,
  type HomeworkAttachment,
  type HomeworkContext,
  type HomeworkContextClass,
} from '@sms/contracts';
import {
  requireSession,
  requireTenantContext,
  requirePermission,
  requireCsrf,
} from '../../plugins/auth.js';
import {
  mapDomainError,
  idempotencyKeyFromHeader,
  notFoundError,
  assertCampusScope,
} from './util.js';

type HomeworkRow = typeof homework.$inferSelect;
type HomeworkAttachmentRow = typeof homeworkAttachments.$inferSelect;
type FileRow = typeof files.$inferSelect;
type ClassRow = typeof acdClasses.$inferSelect;

export function toHomework(row: HomeworkRow): Homework {
  return {
    id: row.id,
    tenantId: row.tenantId,
    classId: row.classId,
    subjectId: row.subjectId,
    teacherUserId: row.teacherUserId,
    campusId: row.campusId,
    academicYearId: row.academicYearId,
    title: row.title,
    body: row.body,
    dueAt: row.dueAt ? row.dueAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toHomeworkAttachment(row: HomeworkAttachmentRow): HomeworkAttachment {
  return {
    id: row.id,
    tenantId: row.tenantId,
    homeworkId: row.homeworkId,
    fileId: row.fileId,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Tenant-scoped role CODES of the calling user (active membership only). */
export async function tenantRoleCodes(
  tx: Tx,
  ctx: { userId: string; tenantId: string | null },
): Promise<string[]> {
  const rows = await tx
    .select({ code: roles.code })
    .from(memberships)
    .innerJoin(membershipRoles, eq(membershipRoles.membershipId, memberships.id))
    .innerJoin(roles, eq(roles.id, membershipRoles.roleId))
    .where(
      and(
        eq(memberships.tenantId, ctx.tenantId ?? ''),
        eq(memberships.userId, ctx.userId),
        eq(memberships.status, 'active'),
        eq(roles.scope, 'tenant'),
      ),
    )
    .execute();
  return rows.map((r) => r.code);
}

async function resolveLiveClass(
  tx: Tx,
  ctx: { tenantId: string | null; campusId: string | null },
  classId: string,
): Promise<ClassRow> {
  const row = await tx
    .select()
    .from(acdClasses)
    .where(and(eq(acdClasses.tenantId, ctx.tenantId ?? ''), eq(acdClasses.id, classId), isNull(acdClasses.deletedAt)))
    .limit(1)
    .execute()
    .then((r) => r[0]);
  if (!row) throw notFoundError('Class not found');
  assertCampusScope(ctx, row.campusId);
  return row;
}

/**
 * Read visibility for a holder of homework.read (result scoping; the permission
 * alone only unlocks the route — this decides which ROWS are reachable):
 *   * school_owner / principal -> every live row in the tenant
 *   * teacher                 -> rows they authored (== rows for classes they teach)
 *   * parent                  -> classes of their linked students (guardians ->
 *                                student_guardians -> students -> live enrollments)
 *   * student                 -> classes of the caller's own link (students.user_id ->
 *                                live enrollments); unlinked student accounts resolve
 *                                to no classes (honest empty portal state)
 *   * any other holder        -> nothing
 * All narrowings are applied as SQL conditions + a 404 (never 403) on detail, so
 * the existence of other teachers' homework is not observable.
 */
type Visibility = 'all' | 'teacher' | 'parent' | 'student' | 'none';

function visibilityOf(codes: readonly string[]): Visibility {
  if (codes.includes('school_owner') || codes.includes('principal')) return 'all';
  if (codes.includes('teacher')) return 'teacher';
  if (codes.includes('parent')) return 'parent';
  if (codes.includes('student')) return 'student';
  return 'none';
}

/** For a parent: does a live enrollment link their student to this class? */
export async function parentScopesClass(
  tx: Tx,
  ctx: { userId: string; tenantId: string | null },
  classId: string,
): Promise<boolean> {
  const row = await tx
    .select({ id: enrollments.id })
    .from(guardians)
    .innerJoin(studentGuardians, eq(studentGuardians.guardianId, guardians.id))
    .innerJoin(students, eq(students.id, studentGuardians.studentId))
    .innerJoin(enrollments, eq(enrollments.studentId, students.id))
    .where(
      and(
        eq(guardians.tenantId, ctx.tenantId ?? ''),
        eq(guardians.userId, ctx.userId),
        isNull(guardians.deletedAt),
        eq(enrollments.classId, classId),
        isNull(enrollments.deletedAt),
      ),
    )
    .limit(1)
    .execute()
    .then((r) => r[0]);
  return Boolean(row);
}

/** For a linked student: does a live enrollment of their own link hit this class? */
export async function studentScopesClass(
  tx: Tx,
  ctx: { userId: string; tenantId: string | null },
  classId: string,
): Promise<boolean> {
  const row = await tx
    .select({ id: enrollments.id })
    .from(students)
    .innerJoin(enrollments, eq(enrollments.studentId, students.id))
    .where(
      and(
        eq(students.tenantId, ctx.tenantId ?? ''),
        eq(students.userId, ctx.userId),
        isNull(students.deletedAt),
        eq(enrollments.classId, classId),
        isNull(enrollments.deletedAt),
        eq(enrollments.status, 'active'),
      ),
    )
    .limit(1)
    .execute()
    .then((r) => r[0]);
  return Boolean(row);
}

/**
 * Portal self-scoping context (GET /api/v1/me/homework-context). Mirrors the
 * per-class visibility exactly: the role derives from the caller's ACTIVE tenant
 * role codes and the class list is precisely the set the class-level homework
 * routes expose, so a portal can never advertise a class whose homework the
 * caller cannot actually read. Campus-scoped members are narrowed to their own
 * campus (matching resolveLiveClass). An unlinked parent/student or any other
 * homework.read holder resolves to an empty list — the portal renders that as an
 * honest "no access configured" state rather than hiding the section.
 */
export async function resolveHomeworkContext(
  tx: Tx,
  ctx: { userId: string; tenantId: string | null; campusId: string | null },
): Promise<HomeworkContext> {
  const vis = visibilityOf(await tenantRoleCodes(tx, ctx));
  let role: HomeworkContext['role'];
  let classes: readonly ClassRow[] = [];

  if (vis === 'all') {
    role = 'staff';
    classes = await tx
      .select()
      .from(acdClasses)
      .where(and(eq(acdClasses.tenantId, ctx.tenantId ?? ''), isNull(acdClasses.deletedAt)))
      .orderBy(acdClasses.code)
      .execute();
  } else if (vis === 'teacher') {
    role = 'teacher';
    const rows = await tx
      .selectDistinct({ class: acdClasses })
      .from(teacherAssignments)
      .innerJoin(
        acdClasses,
        and(eq(acdClasses.tenantId, teacherAssignments.tenantId), eq(acdClasses.id, teacherAssignments.classId)),
      )
      .where(
        and(
          eq(teacherAssignments.tenantId, ctx.tenantId ?? ''),
          eq(teacherAssignments.teacherUserId, ctx.userId),
          isNull(teacherAssignments.deletedAt),
          isNull(acdClasses.deletedAt),
        ),
      )
      .orderBy(acdClasses.code)
      .execute();
    classes = rows.map((r) => r.class);
  } else if (vis === 'parent') {
    role = 'parent';
    const rows = await tx
      .selectDistinct({ class: acdClasses })
      .from(guardians)
      .innerJoin(
        studentGuardians,
        and(eq(studentGuardians.tenantId, guardians.tenantId), eq(studentGuardians.guardianId, guardians.id)),
      )
      .innerJoin(
        students,
        and(eq(students.tenantId, studentGuardians.tenantId), eq(students.id, studentGuardians.studentId)),
      )
      .innerJoin(
        enrollments,
        and(eq(enrollments.tenantId, students.tenantId), eq(enrollments.studentId, students.id)),
      )
      .innerJoin(
        acdClasses,
        and(eq(acdClasses.tenantId, enrollments.tenantId), eq(acdClasses.id, enrollments.classId)),
      )
      .where(
        and(
          eq(guardians.tenantId, ctx.tenantId ?? ''),
          eq(guardians.userId, ctx.userId),
          isNull(guardians.deletedAt),
          isNull(students.deletedAt),
          isNull(enrollments.deletedAt),
          eq(enrollments.status, 'active'),
          isNull(acdClasses.deletedAt),
        ),
      )
      .orderBy(acdClasses.code)
      .execute();
    classes = rows.map((r) => r.class);
  } else if (vis === 'student') {
    role = 'student';
    const rows = await tx
      .selectDistinct({ class: acdClasses })
      .from(students)
      .innerJoin(
        enrollments,
        and(eq(enrollments.tenantId, students.tenantId), eq(enrollments.studentId, students.id)),
      )
      .innerJoin(
        acdClasses,
        and(eq(acdClasses.tenantId, enrollments.tenantId), eq(acdClasses.id, enrollments.classId)),
      )
      .where(
        and(
          eq(students.tenantId, ctx.tenantId ?? ''),
          eq(students.userId, ctx.userId),
          isNull(students.deletedAt),
          isNull(enrollments.deletedAt),
          eq(enrollments.status, 'active'),
          isNull(acdClasses.deletedAt),
        ),
      )
      .orderBy(acdClasses.code)
      .execute();
    classes = rows.map((r) => r.class);
  } else {
    role = 'none';
  }

  if (ctx.campusId) {
    classes = classes.filter((c) => c.campusId === ctx.campusId);
  }

  const mapped: HomeworkContextClass[] = classes.map((c) => ({
    id: c.id,
    code: c.code,
    name: c.name,
    campusId: c.campusId,
    academicYearId: c.academicYearId,
  }));
  return { role, classes: mapped };
}

function scopeDenied(): HttpError {
  return new HttpError('Teacher may only author homework for their own class subject', {
    status: 403,
    code: 'homework_scope_denied',
  });
}

export interface HomeworkWriteResult {
  row: HomeworkRow;
  attachments: HomeworkAttachmentRow[];
}

/**
 * Author homework for a class + subject. The DB trigger anchors authorship to the
 * LIVE teacher_assignment of the (class, subject): when the caller is themselves a
 * teacher, teacherUserId is the caller (self-authoring; a teacher can only write
 * homework for a subject they teach — otherwise 409 `homework_teacher_not_assigned`).
 * Owner/principal callers author on the class's BEHALF (teacherUserId = the
 * assigned teacher), so their homework.create permission has a real path while the
 * recorded author stays the subject's assigned teacher. Attachments are created
 * only here; tenant ownership of files is verified (the composite FK enforces it).
 */
export async function createHomework(
  tx: Tx,
  ctx: { userId: string; tenantId: string | null; campusId: string | null },
  classId: string,
  input: { subjectId: string; title: string; body?: string; dueAt?: string; attachmentFileIds: string[] },
  requestId: string,
): Promise<HomeworkWriteResult> {
  try {
    const parent = await resolveLiveClass(tx, ctx, classId);
    const subject = await tx
      .select({ id: subjects.id })
      .from(subjects)
      .where(and(eq(subjects.tenantId, ctx.tenantId ?? ''), eq(subjects.id, input.subjectId), isNull(subjects.deletedAt)))
      .limit(1)
      .execute()
      .then((r) => r[0]);
    if (!subject) throw notFoundError('Subject not found');
    const link = await tx
      .select({ id: classSubjects.id })
      .from(classSubjects)
      .where(
        and(
          eq(classSubjects.tenantId, ctx.tenantId ?? ''),
          eq(classSubjects.classId, parent.id),
          eq(classSubjects.subjectId, subject.id),
          isNull(classSubjects.deletedAt),
        ),
      )
      .limit(1)
      .execute()
      .then((r) => r[0]);
    if (!link) throw notFoundError('Subject is not attached to this class');
    const assignment = await tx
      .select({ id: teacherAssignments.id, teacherUserId: teacherAssignments.teacherUserId })
      .from(teacherAssignments)
      .where(
        and(
          eq(teacherAssignments.tenantId, ctx.tenantId ?? ''),
          eq(teacherAssignments.classId, parent.id),
          eq(teacherAssignments.subjectId, subject.id),
          isNull(teacherAssignments.deletedAt),
        ),
      )
      .limit(1)
      .execute()
      .then((r) => r[0]);
    if (!assignment) throw notFoundError('No teacher is assigned to this subject in this class');

    const codes = await tenantRoleCodes(tx, ctx);
    const teacherUserId = codes.includes('teacher') ? ctx.userId : assignment.teacherUserId;

    const fileIds = input.attachmentFileIds;
    let fileRows: FileRow[] = [];
    if (fileIds.length > 0) {
      fileRows = await tx
        .select()
        .from(files)
        .where(
          and(
            eq(files.tenantId, ctx.tenantId ?? ''),
            inArray(files.id, fileIds),
            isNull(files.deletedAt),
          ),
        )
        .execute();
      if (fileRows.length !== fileIds.length) {
        throw notFoundError('One or more attachment files not found');
      }
    }

    const rows = await tx
      .insert(homework)
      .values({
        tenantId: ctx.tenantId ?? '',
        classId: parent.id,
        subjectId: subject.id,
        teacherUserId,
        campusId: parent.campusId,
        academicYearId: parent.academicYearId,
        title: input.title,
        body: input.body ?? null,
        dueAt: input.dueAt ? new Date(input.dueAt) : null,
      })
      .returning();
    const row = rows[0]!;

    const attached: HomeworkAttachmentRow[] = [];
    if (fileRows.length > 0) {
      const inserted = await tx
        .insert(homeworkAttachments)
        .values(
          fileRows.map((f) => ({
            tenantId: ctx.tenantId ?? '',
            homeworkId: row.id,
            fileId: f.id,
          })),
        )
        .returning();
      attached.push(...inserted);
    }

    await writeAudit(tx, {
      scope: 'tenant',
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      action: 'homework.created',
      resourceType: 'homework',
      resourceId: row.id,
      newValue: toHomework(row),
      requestId,
    });
    await enqueueOutbox(tx, {
      tenantId: ctx.tenantId,
      eventType: 'homework.created',
      aggregateType: 'homework',
      aggregateId: row.id,
      payload: {
        tenantId: ctx.tenantId,
        homeworkId: row.id,
        classId: row.classId,
        subjectId: row.subjectId,
        teacherUserId: row.teacherUserId,
      },
      correlationId: requestId,
    });
    return { row, attachments: attached };
  } catch (err) {
    throw mapDomainError(err);
  }
}

export async function updateHomework(
  tx: Tx,
  ctx: { userId: string; tenantId: string | null; campusId: string | null },
  classId: string,
  homeworkId: string,
  input: { title?: string; body?: string | null; dueAt?: string | null },
  requestId: string,
): Promise<HomeworkRow | null> {
  try {
    const parent = await resolveLiveClass(tx, ctx, classId);
    const beforeRows = await tx
      .select()
      .from(homework)
      .where(
        and(
          eq(homework.tenantId, ctx.tenantId ?? ''),
          eq(homework.id, homeworkId),
          eq(homework.classId, parent.id),
          isNull(homework.deletedAt),
        ),
      )
      .limit(1)
      .execute();
    const before = beforeRows[0];
    if (!before) return null;
    assertCampusScope(ctx, before.campusId);
    const codes = await tenantRoleCodes(tx, ctx);
    if (codes.includes('teacher') && before.teacherUserId !== ctx.userId) {
      throw scopeDenied();
    }

    const set: Partial<HomeworkRow> = {};
    if (input.title !== undefined) set.title = input.title;
    if (input.body !== undefined) set.body = input.body ?? null;
    if (input.dueAt !== undefined) set.dueAt = input.dueAt ? new Date(input.dueAt) : null;
    const rows = await tx
      .update(homework)
      .set(set)
      .where(
        and(
          eq(homework.tenantId, ctx.tenantId ?? ''),
          eq(homework.id, homeworkId),
          isNull(homework.deletedAt),
        ),
      )
      .returning();
    const row = rows[0];
    if (!row) return null;
    await writeAudit(tx, {
      scope: 'tenant',
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      action: 'homework.updated',
      resourceType: 'homework',
      resourceId: row.id,
      oldValue: toHomework(before),
      newValue: toHomework(row),
      requestId,
    });
    await enqueueOutbox(tx, {
      tenantId: ctx.tenantId,
      eventType: 'homework.updated',
      aggregateType: 'homework',
      aggregateId: row.id,
      payload: { tenantId: ctx.tenantId, homeworkId: row.id, title: row.title },
      correlationId: requestId,
    });
    return row;
  } catch (err) {
    throw mapDomainError(err);
  }
}

export async function deleteHomework(
  tx: Tx,
  ctx: { userId: string; tenantId: string | null; campusId: string | null },
  classId: string,
  homeworkId: string,
  requestId: string,
): Promise<HomeworkRow | null> {
  try {
    const parent = await resolveLiveClass(tx, ctx, classId);
    const beforeRows = await tx
      .select()
      .from(homework)
      .where(
        and(
          eq(homework.tenantId, ctx.tenantId ?? ''),
          eq(homework.id, homeworkId),
          eq(homework.classId, parent.id),
          isNull(homework.deletedAt),
        ),
      )
      .limit(1)
      .execute();
    const before = beforeRows[0];
    if (!before) return null;
    assertCampusScope(ctx, before.campusId);
    const codes = await tenantRoleCodes(tx, ctx);
    if (codes.includes('teacher') && before.teacherUserId !== ctx.userId) {
      throw scopeDenied();
    }

    const rows = await tx
      .update(homework)
      .set({ deletedAt: new Date() })
      .where(
        and(
          eq(homework.tenantId, ctx.tenantId ?? ''),
          eq(homework.id, homeworkId),
          isNull(homework.deletedAt),
        ),
      )
      .returning();
    const row = rows[0];
    if (!row) return null;
    await writeAudit(tx, {
      scope: 'tenant',
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      action: 'homework.deleted',
      resourceType: 'homework',
      resourceId: row.id,
      oldValue: toHomework(before),
      newValue: { deletedAt: row.deletedAt?.toISOString() ?? null },
      requestId,
    });
    await enqueueOutbox(tx, {
      tenantId: ctx.tenantId,
      eventType: 'homework.deleted',
      aggregateType: 'homework',
      aggregateId: row.id,
      payload: { tenantId: ctx.tenantId, homeworkId: row.id, classId: row.classId },
      correlationId: requestId,
    });
    return row;
  } catch (err) {
    throw mapDomainError(err);
  }
}

export default async function homeworkRoutes(app: FastifyInstance) {
  app.get(
    '/api/v1/classes/:id/homework',
    {
      config: { authorization: { kind: 'tenant', permission: 'homework.read' } },
      preHandler: [requireSession(), requireTenantContext(), requirePermission('homework.read')],
    },
    async (request) => {
      const { id } = homeworkListParamSchema.parse(request.params);
      const ctx = request.ctx!;
      const codes = await withTenant(app.db, ctx, (tx) => tenantRoleCodes(tx, ctx));
      const vis = visibilityOf(codes);
      if (vis === 'none') return { items: [], total: 0 };
      await withTenant(app.db, ctx, (tx) => resolveLiveClass(tx, ctx, id));
      if (vis === 'parent' && !(await withTenant(app.db, ctx, (tx) => parentScopesClass(tx, ctx, id)))) {
        return { items: [], total: 0 };
      }
      if (vis === 'student' && !(await withTenant(app.db, ctx, (tx) => studentScopesClass(tx, ctx, id)))) {
        return { items: [], total: 0 };
      }
      const query = homeworkListQuerySchema.parse(request.query);
      const conditions = [
        eq(homework.tenantId, ctx.tenantId ?? ''),
        eq(homework.classId, id),
        isNull(homework.deletedAt),
      ];
      if (query.subjectId) conditions.push(eq(homework.subjectId, query.subjectId));
      if (query.dueBefore) conditions.push(eq(homework.dueAt, new Date(query.dueBefore)));
      if (vis === 'teacher') conditions.push(eq(homework.teacherUserId, ctx.userId));
      const rows = await withTenant(app.db, ctx, (tx) =>
        tx
          .select()
          .from(homework)
          .where(and(...conditions))
          .orderBy(homework.dueAt, desc(homework.createdAt), desc(homework.id))
          .limit(query.limit)
          .offset(query.offset)
          .execute(),
      );
      const totalRow = await withTenant(app.db, ctx, (tx) =>
        tx.select({ total: count() }).from(homework).where(and(...conditions)).execute(),
      );
      const mapped = await Promise.all(
        rows.map(async (row) => {
          const attachments = await withTenant(app.db, ctx, (tx) =>
            tx
              .select()
              .from(homeworkAttachments)
              .where(
                and(
                  eq(homeworkAttachments.tenantId, ctx.tenantId ?? ''),
                  eq(homeworkAttachments.homeworkId, row.id),
                  isNull(homeworkAttachments.deletedAt),
                ),
              )
              .orderBy(homeworkAttachments.createdAt)
              .execute(),
          );
          return { ...toHomework(row), attachments: attachments.map(toHomeworkAttachment) };
        }),
      );
      return { items: mapped, total: totalRow[0]?.total ?? 0 };
    },
  );

  app.get(
    '/api/v1/classes/:id/homework/:homeworkId',
    {
      config: { authorization: { kind: 'tenant', permission: 'homework.read' } },
      preHandler: [requireSession(), requireTenantContext(), requirePermission('homework.read')],
    },
    async (request) => {
      const { id, homeworkId } = homeworkParamSchema.parse(request.params);
      const ctx = request.ctx!;
      const codes = await withTenant(app.db, ctx, (tx) => tenantRoleCodes(tx, ctx));
      const vis = visibilityOf(codes);
      await withTenant(app.db, ctx, (tx) => resolveLiveClass(tx, ctx, id));
      const row = await withTenant(app.db, ctx, (tx) =>
        tx
          .select()
          .from(homework)
          .where(
            and(
              eq(homework.tenantId, ctx.tenantId ?? ''),
              eq(homework.id, homeworkId),
              eq(homework.classId, id),
              isNull(homework.deletedAt),
            ),
          )
          .limit(1)
          .execute()
          .then((r) => r[0]),
      );
      if (!row) throw notFoundError('Homework not found');
      if (vis === 'none') throw notFoundError('Homework not found');
      if (vis === 'teacher' && row.teacherUserId !== ctx.userId) {
        throw notFoundError('Homework not found');
      }
      if (vis === 'parent' && !(await withTenant(app.db, ctx, (tx) => parentScopesClass(tx, ctx, id)))) {
        throw notFoundError('Homework not found');
      }
      if (vis === 'student' && !(await withTenant(app.db, ctx, (tx) => studentScopesClass(tx, ctx, id)))) {
        throw notFoundError('Homework not found');
      }
      const attachments = await withTenant(app.db, ctx, (tx) =>
        tx
          .select()
          .from(homeworkAttachments)
          .where(
            and(
              eq(homeworkAttachments.tenantId, ctx.tenantId ?? ''),
              eq(homeworkAttachments.homeworkId, row.id),
              isNull(homeworkAttachments.deletedAt),
            ),
          )
          .orderBy(homeworkAttachments.createdAt)
          .execute(),
      );
      return { homework: { ...toHomework(row), attachments: attachments.map(toHomeworkAttachment) } };
    },
  );

  app.post(
    '/api/v1/classes/:id/homework',
    {
      config: { authorization: { kind: 'tenant', permission: 'homework.create' } },
      preHandler: [requireSession(), requireTenantContext(), requirePermission('homework.create'), requireCsrf()],
    },
    async (request, reply) => {
      const { id } = homeworkListParamSchema.parse(request.params);
      const body = createHomeworkRequestSchema.parse(request.body);
      const ctx = request.ctx!;
      const idemKey = idempotencyKeyFromHeader(request.headers);
      const fingerprint = requestFingerprint(request.method, request.url, body);
      const outcome = await withTenant(app.db, ctx, (tx) =>
        withIdempotency(tx, { tenantId: ctx.tenantId, key: idemKey }, fingerprint, async () => {
          const result = await createHomework(tx, ctx, id, body, request.requestId);
          return {
            status: 201,
            body: {
              homework: {
                ...toHomework(result.row),
                attachments: result.attachments.map(toHomeworkAttachment),
              },
            },
          };
        }),
      );
      return reply.code(outcome.status).send(outcome.body);
    },
  );

  app.patch(
    '/api/v1/classes/:id/homework/:homeworkId',
    {
      config: { authorization: { kind: 'tenant', permission: 'homework.update' } },
      preHandler: [requireSession(), requireTenantContext(), requirePermission('homework.update'), requireCsrf()],
    },
    async (request, reply) => {
      const { id, homeworkId } = homeworkParamSchema.parse(request.params);
      const body = updateHomeworkRequestSchema.parse(request.body);
      const ctx = request.ctx!;
      const idemKey = idempotencyKeyFromHeader(request.headers);
      const fingerprint = requestFingerprint(request.method, request.url, body);
      const outcome = await withTenant(app.db, ctx, (tx) =>
        withIdempotency(tx, { tenantId: ctx.tenantId, key: idemKey }, fingerprint, async () => {
          const row = await updateHomework(tx, ctx, id, homeworkId, body, request.requestId);
          if (!row) throw notFoundError('Homework not found');
          const attachments = await tx
            .select()
            .from(homeworkAttachments)
            .where(
              and(
                eq(homeworkAttachments.tenantId, ctx.tenantId ?? ''),
                eq(homeworkAttachments.homeworkId, row.id),
                isNull(homeworkAttachments.deletedAt),
              ),
            )
            .orderBy(homeworkAttachments.createdAt)
            .execute();
          return {
            status: 200,
            body: { homework: { ...toHomework(row), attachments: attachments.map(toHomeworkAttachment) } },
          };
        }),
      );
      return reply.code(outcome.status).send(outcome.body);
    },
  );

  app.delete(
    '/api/v1/classes/:id/homework/:homeworkId',
    {
      config: { authorization: { kind: 'tenant', permission: 'homework.delete' } },
      preHandler: [requireSession(), requireTenantContext(), requirePermission('homework.delete'), requireCsrf()],
    },
    async (request, reply) => {
      const { id, homeworkId } = homeworkParamSchema.parse(request.params);
      const ctx = request.ctx!;
      const idemKey = idempotencyKeyFromHeader(request.headers);
      const fingerprint = requestFingerprint(request.method, request.url, {});
      const outcome = await withTenant(app.db, ctx, (tx) =>
        withIdempotency(tx, { tenantId: ctx.tenantId, key: idemKey }, fingerprint, async () => {
          const row = await deleteHomework(tx, ctx, id, homeworkId, request.requestId);
          if (!row) throw notFoundError('Homework not found');
          return { status: 200, body: { homework: toHomework(row) } };
        }),
      );
      return reply.code(outcome.status).send(outcome.body);
    },
  );
}