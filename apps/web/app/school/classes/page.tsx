import type {
  AcademicYear,
  AcademicYearListResponse,
  Campus,
  CampusListResponse,
  ClassListResponse,
  GradeLevel,
  GradeLevelListResponse,
  MeResponse,
} from '@sms/contracts';
import { serverFetch } from '@/lib/server';
import { ClassManager } from './class-manager';

export const dynamic = 'force-dynamic';

export default async function ClassesPage() {
  let me: MeResponse | null = null;
  let classes: ClassListResponse = { items: [], total: 0 };
  let campuses: Campus[] = [];
  let years: AcademicYear[] = [];
  let gradeLevels: GradeLevel[] = [];
  try {
    me = await serverFetch<MeResponse>('/api/v1/me');
    if (me.permissions.includes('classes.read')) {
      const [classesRes, campusRes, yearRes, gradeLevelRes] = await Promise.all([
        serverFetch<ClassListResponse>('/api/v1/classes?limit=100&offset=0'),
        serverFetch<CampusListResponse>('/api/v1/campuses?limit=100&offset=0'),
        serverFetch<AcademicYearListResponse>('/api/v1/academic-years?limit=100&offset=0'),
        serverFetch<GradeLevelListResponse>('/api/v1/grade-levels?limit=100&offset=0'),
      ]);
      classes = classesRes;
      campuses = campusRes.items;
      years = yearRes.items;
      gradeLevels = gradeLevelRes.items;
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

  return (
    <ClassManager
      initial={classes.items}
      initialTotal={classes.total}
      campuses={campuses}
      years={years}
      gradeLevels={gradeLevels}
      canRead={me.permissions.includes('classes.read')}
      canCreate={me.permissions.includes('classes.create')}
      canUpdate={me.permissions.includes('classes.update')}
      canDelete={me.permissions.includes('classes.delete')}
    />
  );
}