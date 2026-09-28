import type {
  AcademicYear,
  AcademicYearListResponse,
  Campus,
  CampusListResponse,
  ClassResponse,
  ClassSubject,
  ClassSubjectListResponse,
  GradeLevel,
  GradeLevelListResponse,
  MeResponse,
  SectionListResponse,
  Subject,
  SubjectListResponse,
  TeacherAssignment,
  TeacherAssignmentListResponse,
  TeacherDirectoryEntry,
  TeacherDirectoryResponse,
} from '@sms/contracts';
import { serverFetch } from '@/lib/server';
import { ClassDetail } from './class-detail';

export const dynamic = 'force-dynamic';

export default async function ClassDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let me: MeResponse | null = null;
  let klass = null as Awaited<ReturnType<typeof serverFetch<ClassResponse>>> | null;
  let sections: SectionListResponse = { items: [], total: 0 };
  let campuses: Campus[] = [];
  let years: AcademicYear[] = [];
  let gradeLevels: GradeLevel[] = [];
  let subjects: Subject[] = [];
  let classSubjects: ClassSubject[] = [];
  let teacherAssignments: TeacherAssignment[] = [];
  let teachers: TeacherDirectoryEntry[] = [];
  try {
    me = await serverFetch<MeResponse>('/api/v1/me');
    if (me.permissions.includes('classes.read')) {
      const [classRes, sectionRes, campusRes, yearRes, gradeLevelRes] = await Promise.all([
        serverFetch<ClassResponse>(`/api/v1/classes/${encodeURIComponent(id)}`),
        serverFetch<SectionListResponse>(`/api/v1/classes/${encodeURIComponent(id)}/sections?limit=100&offset=0`),
        serverFetch<CampusListResponse>('/api/v1/campuses?limit=100&offset=0'),
        serverFetch<AcademicYearListResponse>('/api/v1/academic-years?limit=100&offset=0'),
        serverFetch<GradeLevelListResponse>('/api/v1/grade-levels?limit=100&offset=0'),
      ]);
      klass = classRes;
      sections = sectionRes;
      campuses = campusRes.items;
      years = yearRes.items;
      gradeLevels = gradeLevelRes.items;
    }
    if (me.permissions.includes('subjects.read')) {
      const subjectRes = await serverFetch<SubjectListResponse>('/api/v1/subjects?limit=100&offset=0');
      subjects = subjectRes.items;
    }
    // Class-subject links and their teacher assignments are nested per subject:
    // the assignments endpoint is scoped to one (class, subject) pair, so fetch
    // it once per linked subject.
    if (me.permissions.includes('class.subjects.read')) {
      const linkRes = await serverFetch<ClassSubjectListResponse>(
        `/api/v1/classes/${encodeURIComponent(id)}/subjects?limit=100&offset=0`,
      );
      classSubjects = linkRes.items;
      if (me.permissions.includes('teacher.assignments.read')) {
        const perSubject = await Promise.all(
          classSubjects.map((cs) =>
            serverFetch<TeacherAssignmentListResponse>(
              `/api/v1/classes/${encodeURIComponent(id)}/subjects/${encodeURIComponent(cs.subjectId)}/teachers?limit=100&offset=0`,
            ),
          ),
        );
        teacherAssignments = perSubject.flatMap((r) => r.items);
        const teacherRes = await serverFetch<TeacherDirectoryResponse>('/api/v1/teachers');
        teachers = teacherRes.items;
      }
    }
  } catch {
    // fall through to unauthenticated UI
  }

  if (!me) {
    return (
      <main className="mx-auto max-w-3xl p-8">
        <p className="text-sm text-red-600">Please sign in first.</p>
      </main>
    );
  }

  if (!klass) {
    return (
      <main className="mx-auto max-w-3xl p-8">
        <p className="text-sm text-red-600">Class not found or you do not have access to it.</p>
      </main>
    );
  }

  return (
    <ClassDetail
      classId={id}
      initial={klass.class}
      initialSections={sections.items}
      sectionsTotal={sections.total}
      campuses={campuses}
      years={years}
      gradeLevels={gradeLevels}
      subjects={subjects}
      initialClassSubjects={classSubjects}
      teachers={teachers}
      initialTeacherAssignments={teacherAssignments}
      canRead={me.permissions.includes('classes.read')}
      canUpdate={me.permissions.includes('classes.update')}
      canDelete={me.permissions.includes('classes.delete')}
      canCreateSection={me.permissions.includes('sections.create')}
      canUpdateSection={me.permissions.includes('sections.update')}
      canDeleteSection={me.permissions.includes('sections.delete')}
      canManageClassSubjects={me.permissions.includes('class.subjects.manage')}
      canManageTeacherAssignments={me.permissions.includes('teacher.assignments.manage')}
    />
  );
}