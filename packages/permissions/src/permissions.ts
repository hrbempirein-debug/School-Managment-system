import { AppError } from '@sms/core';

type Permission = string;

/** Single source of truth for authorization permission identifiers. */
export const PERMISSION_CATALOG: readonly Permission[] = Object.freeze([
  // Platform scope
  'platform.tenants.create',
  'platform.tenants.read',
  'platform.tenants.update',
  'platform.tenants.status_change',
  'platform.users.read',
  'platform.plans.manage',
  'platform.billing.read',
  'platform.audit.read',

  // Tenant scope
  'tenant.read',
  'tenant.update',
  // School administration & academic structure (Phase 2B)
  'school.settings.manage',
  'school.branding.manage',
  'campus.read',
  'campus.create',
  'campus.update',
  'academic.years.read',
  'academic.years.write',
  'academic.terms.read',
  'academic.terms.write',
  'calendar.read',
  'calendar.write',
  'departments.read',
  'departments.write',
  'users.read',
  'users.create',
  'users.update',
  'memberships.read',
  'memberships.create',
  'memberships.update',
  'roles.read',
  'roles.create',
  'roles.update',
  'audit.read',
  // Students, guardians & enrollment (Phase 3)
  'students.read',
  'students.create',
  'students.update',
  'students.delete',
  'students.export',
  'guardians.read',
  'guardians.create',
  'guardians.update',
  'enrollment.read',
  'enrollment.manage',
  // Student documents (Phase 3.4)
  'student.documents.read',
  'student.documents.create',
  'student.documents.update',
  'student.documents.delete',
  // Admission applications (Phase 3.5). `.review` guards the explicit lifecycle
  // action routes (submit/review/approve/reject/withdraw) — transitions are never
  // reachable through `.update`.
  'admission.read',
  'admission.create',
  'admission.update',
  'admission.review',
  // Classes, sections & academic placement (Phase 4.1)
  'classes.read',
  'classes.create',
  'classes.update',
  'classes.delete',
  'sections.read',
  'sections.create',
  'sections.update',
  'sections.delete',
  'placement.read',
  'placement.manage',
  // Grade levels, subjects, class-subjects & teacher assignments (Phase 4.2)
  'grade.levels.read',
  'grade.levels.create',
  'grade.levels.update',
  'grade.levels.delete',
  'subjects.read',
  'subjects.create',
  'subjects.update',
  'subjects.delete',
  'class.subjects.read',
  'class.subjects.manage',
  'teacher.assignments.read',
  'teacher.assignments.manage',
  // Timetable & homework (Phase 4.3)
  'timetable.read',
  'timetable.manage',
  'timetable.publish',
  'homework.read',
  'homework.create',
  'homework.update',
  'homework.delete',
  // Attendance & student leave (Phase 5).
  // `attendance.read` and `attendance.mark` are deliberately SEPARATE (roadmap
  // Phase 5 security: "attendance.mark vs read") so a read-only role such as
  // `principal` can see registers without being able to write them. A correction
  // is a same-day status change, so it is gated on `.mark` — the same-day freeze
  // (DATABASE_DESIGN §6) is the real control, not a second write permission.
  // `attendance.request_leave` is a filing action (parent/student) and
  // `attendance.approve_leave` is a decision action (school staff); neither maps
  // onto `.mark` or `.read`, so both are distinct catalog entries.
  'attendance.read',
  'attendance.mark',
  'attendance.approve_leave',
  'attendance.request_leave',
  // Exams & results (Phase 6). Four capabilities, deliberately separate:
  //   * `exams.read`    — exams, gradebook, report cards, transcript (incl. the
  //                       parent/student portals, which additionally relationship-scope).
  //   * `exams.manage`  — configuration: exam types, exams, exam subjects, exam
  //                       schedules and grading-scale versions. Creating a grading
  //                       scale is a settings act, not a grading act, so it lives here.
  //   * `exams.mark`    — result entry. The analogue of `attendance.mark`: the
  //                       teacher identity comes from the session and the
  //                       `teacher_assignments` row is the real control, so this
  //                       grant alone must not imply the ability to publish.
  //   * `exams.publish` — the publication boundary (roadmap-named). Finalizes the
  //                       exam, freezes marks and makes results parent-visible.
  //   * `exams.correct` — the correction workflow (roadmap-named). The ONLY path
  //                       that may change a published mark; it always writes
  //                       `mark_corrections` (old, new, reason) + an audit row.
  'exams.read',
  'exams.manage',
  'exams.mark',
  'exams.publish',
  'exams.correct',
]);

export const PERMISSION_SET: ReadonlySet<Permission> = new Set(PERMISSION_CATALOG);

export type RoleScope = 'platform' | 'tenant';

export interface RoleTemplate {
  code: string;
  scope: RoleScope;
  name: string;
  description: string;
  permissions: readonly Permission[];
}

export const ROLE_TEMPLATES: readonly RoleTemplate[] = Object.freeze([
  {
    code: 'platform_admin',
    scope: 'platform',
    name: 'Platform Administrator',
    description: 'Full platform administration',
    permissions: PERMISSION_CATALOG.filter((p) => p.startsWith('platform.')),
  },
  {
    code: 'school_owner',
    scope: 'tenant',
    name: 'School Owner (Admin)',
    description: 'Full school administration',
    permissions: [
      'tenant.read',
      'tenant.update',
      'school.settings.manage',
      'school.branding.manage',
      'campus.read',
      'campus.create',
      'campus.update',
      'academic.years.read',
      'academic.years.write',
      'academic.terms.read',
      'academic.terms.write',
      'calendar.read',
      'calendar.write',
      'departments.read',
      'departments.write',
      'users.read',
      'users.create',
      'users.update',
      'memberships.read',
      'memberships.create',
      'memberships.update',
      'roles.read',
      'roles.create',
      'roles.update',
      'audit.read',
      'students.read',
      'students.create',
      'students.update',
      'students.delete',
      'students.export',
      'guardians.read',
      'guardians.create',
      'guardians.update',
      'enrollment.read',
      'enrollment.manage',
      'student.documents.read',
      'student.documents.create',
      'student.documents.update',
      'student.documents.delete',
      'admission.read',
      'admission.create',
      'admission.update',
      'admission.review',
      'classes.read',
      'classes.create',
      'classes.update',
      'classes.delete',
      'sections.read',
      'sections.create',
      'sections.update',
      'sections.delete',
      'placement.read',
      'placement.manage',
      'grade.levels.read',
      'grade.levels.create',
      'grade.levels.update',
      'grade.levels.delete',
      'subjects.read',
      'subjects.create',
      'subjects.update',
      'subjects.delete',
      'class.subjects.read',
      'class.subjects.manage',
      'teacher.assignments.read',
      'teacher.assignments.manage',
      'timetable.read',
      'timetable.manage',
      'timetable.publish',
      'homework.read',
      'homework.create',
      'homework.update',
      'homework.delete',
      'attendance.read',
      'attendance.mark',
      'attendance.approve_leave',
      'attendance.request_leave',
      'exams.read',
      'exams.manage',
      'exams.mark',
      'exams.publish',
      'exams.correct',
    ],
  },
  {
    code: 'principal',
    scope: 'tenant',
    name: 'Principal',
    description: 'School leadership, read-mostly',
    permissions: [
      'tenant.read',
      'users.read',
      'memberships.read',
      'roles.read',
      'audit.read',
      'campus.read',
      'academic.years.read',
      'academic.terms.read',
      'calendar.read',
      'departments.read',
      'students.read',
      'guardians.read',
      'enrollment.read',
      'student.documents.read',
      'admission.read',
      'classes.read',
      'sections.read',
      'placement.read',
      'grade.levels.read',
      'subjects.read',
      'class.subjects.read',
      'teacher.assignments.read',
      'timetable.read',
      'homework.read',
      'attendance.read',
      // Leadership owns the exam lifecycle end to end EXCEPT result entry:
      // `exams.mark` is absent so the principal cannot enter marks, and the
      // separation mirrors the read-only principal pattern of Phase 5.
      'exams.read',
      'exams.manage',
      'exams.publish',
      'exams.correct',
    ],
  },
  {
    code: 'teacher',
    scope: 'tenant',
    name: 'Teacher',
    description: 'Teaching staff',
    // A teacher reads attendance and registers their own classes. Leave DECISIONS
    // are an administrative act, so `attendance.approve_leave` is deliberately
    // absent from the teacher template.
    // A teacher reads exams, enters marks for their OWN class subjects and sees
    // published results. `exams.publish` and `exams.correct` are deliberately
    // absent: publishing is an administrative act (roadmap: "authz (teacher
    // cannot publish)"), and so is rewriting a published mark.
    permissions: ['tenant.read', 'users.read',
      'timetable.read', 'homework.read', 'homework.create', 'homework.update', 'homework.delete',
      'attendance.read', 'attendance.mark',
      'exams.read', 'exams.mark'],
  },
  {
    code: 'accountant',
    scope: 'tenant',
    name: 'Accountant',
    description: 'Finance staff (finance module lands in a later phase)',
    permissions: ['tenant.read', 'users.read', 'audit.read'],
  },
  {
    code: 'parent',
    scope: 'tenant',
    name: 'Parent / Guardian',
    description: 'Parent portal',
    // Read their children's attendance and file a leave request. They can never
    // mark attendance (`attendance.mark` is absent) nor decide a leave.
    // `exams.read` is the portal grant; the self-scoped endpoint additionally
    // relationship-scopes to linked children, so this can never expose another
    // family's results. No manage/mark/publish/correct — ever.
    permissions: ['tenant.read', 'homework.read', 'attendance.read', 'attendance.request_leave', 'exams.read'],
  },
  {
    code: 'student',
    scope: 'tenant',
    name: 'Student',
    description: 'Student portal',
    permissions: ['tenant.read', 'homework.read', 'attendance.read', 'attendance.request_leave', 'exams.read'],
  },
]);

/**
 * Fail-fast validation of the permission registry. Invoked at application boot
 * so the process never starts with a broken authorization metadata model.
 */
export function assertCatalogConsistent(): void {
  const seen = new Set<string>();
  const dupes: string[] = [];
  for (const p of PERMISSION_CATALOG) {
    if (seen.has(p)) dupes.push(p);
    seen.add(p);
  }
  if (dupes.length > 0) {
    throw new AppError(`Duplicate permission identifiers in catalog: ${dupes.join(', ')}`);
  }
  if (!seen.has('audit.read')) {
    throw new AppError('audit.read is a required system permission');
  }
  for (const template of ROLE_TEMPLATES) {
    for (const p of template.permissions) {
      if (!seen.has(p)) {
        throw new AppError(
          `Role template "${template.code}" references unknown permission "${p}"`,
        );
      }
    }
    if (template.scope === 'platform' && template.permissions.some((p) => !p.startsWith('platform.'))) {
      throw new AppError(`Platform role "${template.code}" contains a tenant permission`);
    }
    if (template.scope === 'tenant' && template.permissions.some((p) => p.startsWith('platform.'))) {
      throw new AppError(`Tenant role "${template.code}" contains a platform permission`);
    }
  }
}

export function permissionForTemplate(templateCode: string): Permission[] {
  const t = ROLE_TEMPLATES.find((r) => r.code === templateCode);
  if (!t) throw new AppError(`Unknown role template: ${templateCode}`);
  return [...t.permissions];
}

export function isPlatformPermission(p: string): boolean {
  return p.startsWith('platform.');
}

export function isRegisteredPermission(p: string): boolean {
  return PERMISSION_SET.has(p);
}