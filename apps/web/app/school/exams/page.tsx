import type {
  AcdClass,
  AcademicTermListResponse,
  AcademicYearListResponse,
  ExamListResponse,
  ExamTypeListResponse,
  GradingScaleListResponse,
  MeResponse,
  SubjectListResponse,
} from '@sms/contracts';
import { serverFetch } from '@/lib/server';
import { ExamManager } from './exam-manager';

export const dynamic = 'force-dynamic';

/**
 * School console shell for Phase 6. Loads only what the caller may see and hands
 * the permission flags to the client component, so a teacher without
 * `exams.manage` is never rendered a publish, scale-editing or status control.
 * Class subjects are fetched on demand (per selected class) rather than for every
 * class in the school.
 */
export default async function SchoolExamsPage() {
  let me: MeResponse | null = null;
  let exams: ExamListResponse = { items: [], total: 0 };
  let examTypes: ExamTypeListResponse = { items: [], total: 0 };
  let scales: GradingScaleListResponse = { items: [], total: 0 };
  let years: AcademicYearListResponse = { items: [], total: 0 };
  let terms: AcademicTermListResponse = { items: [], total: 0 };
  let classes: AcdClass[] = [];
  let subjects: SubjectListResponse = { items: [], total: 0 };

  try {
    me = await serverFetch<MeResponse>('/api/v1/me');
    if (me.permissions.includes('exams.read')) {
      exams = await serverFetch<ExamListResponse>('/api/v1/exams?limit=100');
      examTypes = await serverFetch<ExamTypeListResponse>('/api/v1/exam-types');
      scales = await serverFetch<GradingScaleListResponse>('/api/v1/grading-scales');
      if (me.permissions.includes('academic.years.read')) {
        years = await serverFetch<AcademicYearListResponse>('/api/v1/academic-years?limit=100');
        const firstYear = years.items[0];
        terms = firstYear
          ? await serverFetch<AcademicTermListResponse>(`/api/v1/academic-years/${firstYear.id}/terms`)
          : { items: [], total: 0 };
      }
      if (me.permissions.includes('classes.read')) {
        classes = (await serverFetch<{ items: AcdClass[]; total: number }>('/api/v1/classes?limit=100')).items;
      }
      if (me.permissions.includes('subjects.read')) {
        subjects = await serverFetch<SubjectListResponse>('/api/v1/subjects?limit=200');
      }
    }
  } catch {
    // fall through to the unauthenticated UI
  }

  if (!me) {
    return (
      <main className="mx-auto max-w-3xl p-8">
        <p className="text-sm text-red-600">Please sign in first.</p>
      </main>
    );
  }

  if (!me.permissions.includes('exams.read')) {
    return (
      <main className="mx-auto max-w-3xl p-8">
        <h1 className="text-2xl font-semibold">Exams &amp; results</h1>
        <p className="mt-3 text-sm text-gray-600">
          Your role in this school does not include exam access.
        </p>
      </main>
    );
  }

  return (
    <ExamManager
      initialExams={exams.items}
      examTypes={examTypes.items}
      gradingScales={scales.items}
      academicYears={years.items}
      academicTerms={terms.items}
      classes={classes}
      subjectCatalog={subjects.items}
      canManage={me.permissions.includes('exams.manage')}
      canMark={me.permissions.includes('exams.mark')}
      canPublish={me.permissions.includes('exams.publish')}
      canCorrect={me.permissions.includes('exams.correct')}
      canReadClassSubjects={me.permissions.includes('class.subjects.read')}
    />
  );
}
