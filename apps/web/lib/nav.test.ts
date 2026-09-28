import { describe, it, expect } from 'vitest';
import { SCHOOL_SECTIONS, visibleSections } from './nav';

describe('permission-driven navigation', () => {
  it('renders a section only when its permission is granted', () => {
    const sections = visibleSections(['campus.read']);
    expect(sections.map((s) => s.href)).toEqual(['/school/campuses']);
  });

  it('accepts a ReadonlySet input', () => {
    const sections = visibleSections(new Set(['school.settings.manage', 'school.branding.manage']));
    expect(sections.map((s) => s.href)).toEqual(['/school/settings']);
  });

  it('grants no sections to a permission-less actor', () => {
    expect(visibleSections([])).toEqual([]);
  });

  it('orders sections per the canonical catalog', () => {
    const hrefs = SCHOOL_SECTIONS.map((s) => s.href);
    expect(hrefs).toEqual([
      '/school/settings',
      '/school/campuses',
      '/school/academic-year',
      '/school/students',
      '/school/classes',
      '/school/grade-levels',
      '/school/subjects',
      '/school/timetable',
      '/school/homework',
      '/school/attendance',
      '/school/exams',
      '/school/admissions',
      '/school/imports',
    ]);
  });

  it('shows Attendance to attendance.read and hides it from everyone else', () => {
    expect(visibleSections(['attendance.read']).map((s) => s.href)).toEqual([
      '/school/attendance',
    ]);
    // attendance.mark / attendance.request_leave alone must NOT surface the
    // module: a marker with no read scope has nothing to show.
    expect(visibleSections(['attendance.mark', 'attendance.request_leave'])).toEqual([]);
    expect(visibleSections(['attendance.read', 'attendance.mark']).map((s) => s.href)).toEqual([
      '/school/attendance',
    ]);
  });

  it('shows Exams to exams.read and hides it from a marker without read scope', () => {
    expect(visibleSections(['exams.read']).map((s) => s.href)).toEqual(['/school/exams']);
    // a teacher who may only mark has no module to open
    expect(visibleSections(['exams.mark', 'exams.publish', 'exams.correct'])).toEqual([]);
    expect(
      visibleSections(['exams.read', 'exams.mark']).map((s) => s.href),
    ).toEqual(['/school/exams']);
  });

  it('has one nav entry per href and a unique permission per section', () => {
    expect(new Set(SCHOOL_SECTIONS.map((s) => s.href)).size).toBe(SCHOOL_SECTIONS.length);
  });

  it('is stable for a full school_owner permission set', () => {
    const owner = ['tenant.read', 'tenant.update', 'school.settings.manage', 'school.branding.manage',
      'campus.read', 'campus.create', 'campus.update', 'academic.years.read', 'academic.years.write',
      'academic.terms.read', 'academic.terms.write', 'calendar.read', 'calendar.write',
      'departments.read', 'departments.write', 'students.read', 'students.create', 'students.update',
      'students.delete', 'students.export', 'guardians.read', 'guardians.create', 'guardians.update',
      'enrollment.read', 'enrollment.manage', 'student.documents.read', 'student.documents.create',
      'student.documents.update', 'student.documents.delete', 'admission.read', 'admission.create',
      'admission.update', 'admission.review', 'classes.read', 'classes.create', 'classes.update',
      'classes.delete', 'sections.read', 'sections.create', 'sections.update', 'sections.delete',
      'placement.read', 'placement.manage', 'grade.levels.read', 'grade.levels.create',
      'grade.levels.update', 'grade.levels.delete', 'subjects.read', 'subjects.create',
      'subjects.update', 'subjects.delete', 'class.subjects.read', 'class.subjects.manage',
      'teacher.assignments.read', 'teacher.assignments.manage', 'timetable.read',
      'timetable.manage', 'timetable.publish', 'homework.read', 'homework.create',
      'homework.update', 'homework.delete', 'attendance.read', 'attendance.mark',
      'attendance.approve_leave', 'attendance.request_leave', 'exams.read', 'exams.manage',
      'exams.mark', 'exams.publish', 'exams.correct'];
    expect(visibleSections(owner)).toHaveLength(13);
  });
});