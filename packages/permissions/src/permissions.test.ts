import { describe, it, expect } from 'vitest';
import {
  PERMISSION_CATALOG,
  PERMISSION_SET,
  ROLE_TEMPLATES,
  assertCatalogConsistent,
  permissionForTemplate,
  isPlatformPermission,
  isRegisteredPermission,
  type RoleTemplate,
} from './permissions.js';

const PHASE_2B_PERMISSIONS = Object.freeze([
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
]);

const PHASE_2B_READ_ONLY = PHASE_2B_PERMISSIONS.filter((p) => p.endsWith('.read'));

const PHASE_3_PERMISSIONS = Object.freeze([
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
]);

const PHASE_3_READ_ONLY = Object.freeze(['students.read', 'guardians.read', 'enrollment.read']);

const PHASE_3_4_PERMISSIONS = Object.freeze([
  'student.documents.read',
  'student.documents.create',
  'student.documents.update',
  'student.documents.delete',
]);

const PHASE_3_4_READ_ONLY = Object.freeze(['student.documents.read']);

const PHASE_3_5_PERMISSIONS = Object.freeze([
  'admission.read',
  'admission.create',
  'admission.update',
  'admission.review',
]);

const PHASE_3_5_READ_ONLY = Object.freeze(['admission.read']);

describe('permission catalog consistency', () => {
  it('passes assertion used at application boot', () => {
    expect(() => assertCatalogConsistent()).not.toThrow();
  });

  it('contains no duplicate identifiers', () => {
    expect(new Set<string>(PERMISSION_CATALOG)).toHaveLength(PERMISSION_CATALOG.length);
  });

  it('keeps platform and tenant permissions in separate namespaces', () => {
    for (const p of PERMISSION_CATALOG) {
      const platform = p.startsWith('platform.');
      const tenant = p.includes('.') && !platform;
      expect(platform || tenant).toBe(true);
    }
  });
});

describe('Phase 2B school-domain permissions', () => {
  it('registers every Phase 2B permission exactly once', () => {
    for (const p of PHASE_2B_PERMISSIONS) {
      expect(isRegisteredPermission(p)).toBe(true);
      expect(PERMISSION_CATALOG.filter((x) => x === p)).toHaveLength(1);
    }
  });

  it('scopes every Phase 2B permission to the tenant namespace', () => {
    for (const p of PHASE_2B_PERMISSIONS) {
      expect(isPlatformPermission(p)).toBe(false);
    }
  });
});

describe('Phase 3 students/guardians/enrollment permissions', () => {
  it('registers every Phase 3 permission exactly once', () => {
    for (const p of PHASE_3_PERMISSIONS) {
      expect(isRegisteredPermission(p)).toBe(true);
      expect(PERMISSION_CATALOG.filter((x) => x === p)).toHaveLength(1);
    }
  });

  it('scopes every Phase 3 permission to the tenant namespace', () => {
    for (const p of PHASE_3_PERMISSIONS) {
      expect(isPlatformPermission(p)).toBe(false);
    }
  });
});

describe('Phase 3.4 student-document permissions', () => {
  it('registers every Phase 3.4 permission exactly once', () => {
    for (const p of PHASE_3_4_PERMISSIONS) {
      expect(isRegisteredPermission(p)).toBe(true);
      expect(PERMISSION_CATALOG.filter((x) => x === p)).toHaveLength(1);
    }
  });

  it('scopes every Phase 3.4 permission to the tenant namespace', () => {
    for (const p of PHASE_3_4_PERMISSIONS) {
      expect(isPlatformPermission(p)).toBe(false);
    }
  });

  it('school_owner holds the full Phase 3.4 document set', () => {
    const owner = permissionForTemplate('school_owner');
    for (const p of PHASE_3_4_PERMISSIONS) expect(owner).toContain(p);
  });

  it('principal holds read-only document access (no create/update/delete)', () => {
    const principal = permissionForTemplate('principal');
    for (const p of PHASE_3_4_READ_ONLY) expect(principal).toContain(p);
    expect(principal).not.toContain('student.documents.create');
    expect(principal).not.toContain('student.documents.update');
    expect(principal).not.toContain('student.documents.delete');
  });
});

describe('Phase 3.5 admission permissions', () => {
  it('registers every Phase 3.5 permission exactly once', () => {
    for (const p of PHASE_3_5_PERMISSIONS) {
      expect(isRegisteredPermission(p)).toBe(true);
      expect(PERMISSION_CATALOG.filter((x) => x === p)).toHaveLength(1);
    }
  });

  it('scopes every Phase 3.5 permission to the tenant namespace', () => {
    for (const p of PHASE_3_5_PERMISSIONS) {
      expect(isPlatformPermission(p)).toBe(false);
    }
  });

  it('school_owner holds the full Phase 3.5 admission set', () => {
    const owner = permissionForTemplate('school_owner');
    for (const p of PHASE_3_5_PERMISSIONS) expect(owner).toContain(p);
  });

  it('principal holds read-only admission access (no create/update/review)', () => {
    const principal = permissionForTemplate('principal');
    for (const p of PHASE_3_5_READ_ONLY) expect(principal).toContain(p);
    expect(principal).not.toContain('admission.create');
    expect(principal).not.toContain('admission.update');
    expect(principal).not.toContain('admission.review');
  });
});

const PHASE_4_1_PERMISSIONS = Object.freeze([
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
]);

const PHASE_4_1_MUTATING = PHASE_4_1_PERMISSIONS.filter((p) => !p.endsWith('.read'));
const PHASE_4_1_READ_ONLY = Object.freeze([
  'classes.read',
  'sections.read',
  'placement.read',
]);

describe('role templates', () => {
  const tenantTemplates = ROLE_TEMPLATES.filter((t): t is RoleTemplate & { scope: 'tenant' } => t.scope === 'tenant');
  const platformTemplates = ROLE_TEMPLATES.filter((t): t is RoleTemplate & { scope: 'platform' } => t.scope === 'platform');

  it('refers only to registered permissions', () => {
    for (const t of ROLE_TEMPLATES) {
      for (const p of t.permissions) expect(PERMISSION_SET.has(p)).toBe(true);
    }
  });

  it('never mixes namespaces', () => {
    for (const t of tenantTemplates) {
      expect(t.permissions.some((p) => p.startsWith('platform.'))).toBe(false);
    }
    for (const t of platformTemplates) {
      expect(t.permissions.every((p) => p.startsWith('platform.'))).toBe(true);
    }
  });

  it('school_owner holds the full Phase 2B school-admin set', () => {
    const owner = permissionForTemplate('school_owner');
    for (const p of PHASE_2B_PERMISSIONS) expect(owner).toContain(p);
  });

  it('school_owner holds the full Phase 3 student/guardian/enrollment set', () => {
    const owner = permissionForTemplate('school_owner');
    for (const p of PHASE_3_PERMISSIONS) expect(owner).toContain(p);
  });

  it('school_owner holds the full Phase 3.5 admission set', () => {
    const owner = permissionForTemplate('school_owner');
    for (const p of PHASE_3_5_PERMISSIONS) expect(owner).toContain(p);
  });

  it('principal holds read-only student/guardian/enrollment access (no write/manage)', () => {
    const principal = permissionForTemplate('principal');
    for (const p of PHASE_3_READ_ONLY) expect(principal).toContain(p);
    expect(principal).not.toContain('students.create');
    expect(principal).not.toContain('students.update');
    expect(principal).not.toContain('students.delete');
    expect(principal).not.toContain('students.export');
    expect(principal).not.toContain('guardians.create');
    expect(principal).not.toContain('guardians.update');
    expect(principal).not.toContain('enrollment.manage');
  });

  it('principal holds read-only academic structure (no manage/write/create)', () => {
    const principal = permissionForTemplate('principal');
    for (const p of PHASE_2B_READ_ONLY) expect(principal).toContain(p);
    expect(principal).not.toContain('school.settings.manage');
    expect(principal).not.toContain('school.branding.manage');
    expect(principal).not.toContain('campus.create');
    expect(principal).not.toContain('campus.update');
    expect(principal).not.toContain('academic.years.write');
    expect(principal).not.toContain('academic.terms.write');
    expect(principal).not.toContain('calendar.write');
    expect(principal).not.toContain('departments.write');
  });
});

describe('Phase 4.1 classes/sections/placement permissions', () => {
  it('registers every Phase 4.1 permission exactly once', () => {
    for (const p of PHASE_4_1_PERMISSIONS) {
      expect(isRegisteredPermission(p)).toBe(true);
      expect(PERMISSION_CATALOG.filter((x) => x === p)).toHaveLength(1);
    }
  });

  it('scopes every Phase 4.1 permission to the tenant namespace', () => {
    for (const p of PHASE_4_1_PERMISSIONS) {
      expect(isPlatformPermission(p)).toBe(false);
    }
  });

  it('school_owner holds the full Phase 4.1 set', () => {
    const owner = permissionForTemplate('school_owner');
    for (const p of PHASE_4_1_PERMISSIONS) expect(owner).toContain(p);
  });

  it('principal holds read-only Phase 4.1 access (no create/update/delete/manage)', () => {
    const principal = permissionForTemplate('principal');
    for (const p of PHASE_4_1_READ_ONLY) expect(principal).toContain(p);
    for (const p of PHASE_4_1_MUTATING) expect(principal).not.toContain(p);
  });
});

const PHASE_4_2_PERMISSIONS = Object.freeze([
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
]);

const PHASE_4_2_MUTATING = PHASE_4_2_PERMISSIONS.filter((p) => !p.endsWith('.read'));
const PHASE_4_2_READ_ONLY = Object.freeze([
  'grade.levels.read',
  'subjects.read',
  'class.subjects.read',
  'teacher.assignments.read',
]);

describe('Phase 4.2 grade-level/subject/assignment permissions', () => {
  it('registers every Phase 4.2 permission exactly once', () => {
    for (const p of PHASE_4_2_PERMISSIONS) {
      expect(isRegisteredPermission(p)).toBe(true);
      expect(PERMISSION_CATALOG.filter((x) => x === p)).toHaveLength(1);
    }
  });

  it('scopes every Phase 4.2 permission to the tenant namespace', () => {
    for (const p of PHASE_4_2_PERMISSIONS) {
      expect(isPlatformPermission(p)).toBe(false);
    }
  });

  it('school_owner holds the full Phase 4.2 set', () => {
    const owner = permissionForTemplate('school_owner');
    for (const p of PHASE_4_2_PERMISSIONS) expect(owner).toContain(p);
  });

  it('principal holds read-only Phase 4.2 access (no create/update/delete/manage)', () => {
    const principal = permissionForTemplate('principal');
    for (const p of PHASE_4_2_READ_ONLY) expect(principal).toContain(p);
    for (const p of PHASE_4_2_MUTATING) expect(principal).not.toContain(p);
  });
});