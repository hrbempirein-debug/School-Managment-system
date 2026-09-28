export interface NavSection {
  title: string;
  description: string;
  href: string;
  permission: string;
}

/**
 * Permission-driven school module catalog: a section is only rendered when the
 * active tenant grants its permission. Kept a pure function so the navigation is
 * unit-testable without a browser or API.
 */
export const SCHOOL_SECTIONS: readonly NavSection[] = [
  {
    title: 'Settings & Branding',
    description: 'School profile, brand color and logo',
    href: '/school/settings',
    permission: 'school.settings.manage',
  },
  {
    title: 'Campuses',
    description: 'Manage campuses and locations',
    href: '/school/campuses',
    permission: 'campus.read',
  },
  {
    title: 'Academic Year',
    description: 'Set up years, terms and the school calendar',
    href: '/school/academic-year',
    permission: 'academic.years.read',
  },
  {
    title: 'Students',
    description: 'Directory, guardians, enrollment, documents and export',
    href: '/school/students',
    permission: 'students.read',
  },
  {
    title: 'Classes & Sections',
    description: 'Academic classes, class sections and student placement',
    href: '/school/classes',
    permission: 'classes.read',
  },
  {
    title: 'Grade Levels',
    description: 'Tenant-wide grade level catalog',
    href: '/school/grade-levels',
    permission: 'grade.levels.read',
  },
  {
    title: 'Subjects',
    description: 'Tenant-wide subject catalog',
    href: '/school/subjects',
    permission: 'subjects.read',
  },
  {
    title: 'Weekly Timetable',
    description: 'Bell periods, the per-section lesson grid and publish validation',
    href: '/school/timetable',
    permission: 'timetable.read',
  },
  {
    title: 'Homework',
    description: 'Assignments per class subject, due dates and attachments',
    href: '/school/homework',
    permission: 'homework.read',
  },
  {
    title: 'Attendance',
    description: 'Daily and period registers, staff clock, leave requests and reports',
    href: '/school/attendance',
    permission: 'attendance.read',
  },
  {
    title: 'Exams & Results',
    description: 'Exam scheduling, mark entry, publication, corrections and report cards',
    href: '/school/exams',
    permission: 'exams.read',
  },
  {
    title: 'Admissions',
    description: 'Applicant pipeline and application review',
    href: '/school/admissions',
    permission: 'admission.read',
  },
  {
    title: 'Student Imports',
    description: 'Bulk CSV import wizard and import history',
    href: '/school/imports',
    permission: 'students.read',
  },
];

export function visibleSections(
  permissions: ReadonlySet<string> | readonly string[],
): NavSection[] {
  const set = permissions instanceof Set ? permissions : new Set(permissions);
  return SCHOOL_SECTIONS.filter((s) => set.has(s.permission));
}