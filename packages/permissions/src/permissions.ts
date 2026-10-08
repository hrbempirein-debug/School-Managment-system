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
  // Finance — core capabilities (Phase 7). The 25 `fees.*` permissions are the
  // system-wide finance catalog defined in §20.5 and backfilled by migration
  // 0028: structures, assignments, invoices, payments, adjustments, receipts,
  // reconciliation, ledger, reports and the portal view.
  'fees.structures.read',
  'fees.structures.manage',
  'fees.assignments.read',
  'fees.assignments.manage',
  'fees.invoices.read',
  'fees.invoices.create',
  'fees.invoices.issue',
  'fees.invoices.void',
  'fees.payments.read',
  'fees.payments.collect',
  'fees.payments.reverse',
  'fees.adjustments.read',
  'fees.adjustments.create',
  'fees.adjustments.approve',
  'fees.receipts.read',
  'fees.receipts.reissue',
  'fees.reconciliation.read',
  'fees.reconciliation.manage',
  'fees.ledger.read',
  'fees.reports.read',
  'fees.portal.read',
  // Finance — refund command surface (Phase 7). Four deliberately separate
  // capabilities: `request` files a refund, `read` sees the queue, `approve`
  // decides approve/reject and `process` disburses. `approve` and `process` are
  // the step-up (MFA) gated commands, and keeping them apart means the actor who
  // authorises a refund need not be the actor who lets the cash leave.
  'fees.refunds.request',
  'fees.refunds.read',
  'fees.refunds.approve',
  'fees.refunds.process',
]);

export const PERMISSION_SET: ReadonlySet<Permission> = new Set(PERMISSION_CATALOG);

/**
 * The Phase 7 finance permissions, DERIVED from the catalog so that the 25
 * `fees.*` strings have exactly one definition site in the whole codebase.
 * Role templates below compose their finance grants from this list instead of
 * repeating the literals — a new finance permission is therefore visible to the
 * template matrix the moment it is catalogued.
 */
export const FEES_PERMISSIONS: readonly Permission[] = Object.freeze(
  PERMISSION_CATALOG.filter((p) => p.startsWith('fees.')),
);

/**
 * Phase 7 §20.5 per-role finance membership — the ONE fact the catalog cannot
 * state (the catalog knows which permissions exist, not who holds them).
 * This is a faithful mirror of the immutable `0028_phase7_finance_security.sql`
 * §20.5 backfill: that migration reconfigured tenants that already existed,
 * `ROLE_TEMPLATES` is the forward path for tenants created afterwards, and the
 * two MUST describe the same end state. Nothing here re-declares a permission
 * identifier that the catalog does not own.
 */
const ACCOUNTANT_FEES_EXCLUSIONS: readonly Permission[] = Object.freeze([
  // Structure/assignment authoring is an owner act, and the portal view is a
  // parent/student grant — exactly the three §20.5 withholds from the accountant.
  'fees.structures.manage',
  'fees.assignments.manage',
  'fees.portal.read',
]);

/** §20.5: the cashier holds EXACTLY these three — never `fees.receipts.reissue` (P1-03). */
const CASHIER_PERMISSIONS: readonly Permission[] = Object.freeze([
  'fees.payments.read',
  'fees.payments.collect',
  'fees.receipts.read',
]);

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
      // Phase 7 §20.5: the owner holds ALL finance permissions (structures,
      // assignments, invoices, payments, adjustments, receipts, reconciliation,
      // ledger, reports, portal and the four refund commands).
      ...FEES_PERMISSIONS,
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
      // Phase 7 §20.5: the principal is read-only over finance and holds
      // EXACTLY `fees.reports.read` among the 25 `fees.*`.
      'fees.reports.read',
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
    // Phase 7 §20.5: the accountant holds every finance permission EXCEPT the
    // three exclusions (structure/assignment authoring and the family portal
    // view) — 22 of the 25 `fees.*`. Derived from the catalog so the grant can
    // never drift from the permission list it selects from.
    permissions: [
      'tenant.read',
      'users.read',
      'audit.read',
      ...FEES_PERMISSIONS.filter((p) => !ACCOUNTANT_FEES_EXCLUSIONS.includes(p)),
    ],
  },
  {
    code: 'cashier',
    scope: 'tenant',
    name: 'Cashier',
    description: 'Cashier role (POS fee collection)',
    // Phase 7 §20.1/§20.5 (OD-11): a tenant-scoped system role holding EXACTLY
    // three permissions. Deliberately a template so a fresh tenant can collect
    // cash at the point of sale; it is created WITHOUT a membership, exactly as
    // the 0028 backfill created it — assigning a user to it is an owner act.
    // `fees.receipts.reissue` is deliberately absent (P1-03): a cashier may read
    // a receipt but never mint a superseding one.
    permissions: [...CASHIER_PERMISSIONS],
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
    // Phase 7 §20.5: the family portal grant is EXACTLY `fees.portal.read`.
    permissions: ['tenant.read', 'homework.read', 'attendance.read', 'attendance.request_leave', 'exams.read', 'fees.portal.read'],
  },
  {
    code: 'student',
    scope: 'tenant',
    name: 'Student',
    description: 'Student portal',
    // Phase 7 §20.5: the family portal grant is EXACTLY `fees.portal.read`.
    permissions: ['tenant.read', 'homework.read', 'attendance.read', 'attendance.request_leave', 'exams.read', 'fees.portal.read'],
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
  // D9: a catalog permission that no role template grants is unreachable at
  // runtime, because authorization reads `role_permissions` and a fresh tenant
  // is provisioned from ROLE_TEMPLATES alone. Every permission MUST therefore
  // be reachable from at least one template of its own scope, otherwise the
  // catalog silently advertises a capability no tenant can ever hold. (This is
  // exactly the gap the Phase 7 `fees.*` / `cashier` backfill left behind.)
  const reachable = {
    platform: new Set<string>(),
    tenant: new Set<string>(),
  } as const;
  for (const template of ROLE_TEMPLATES) {
    for (const p of template.permissions) reachable[template.scope].add(p);
  }
  const unreachable = [...seen].filter(
    (p) => !reachable[isPlatformPermission(p) ? 'platform' : 'tenant'].has(p),
  );
  if (unreachable.length > 0) {
    throw new AppError(
      `Permission(s) granted by no role template of their scope (a fresh tenant could never hold them): ${unreachable.join(', ')}`,
    );
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