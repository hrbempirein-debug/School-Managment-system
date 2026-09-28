import type {
  MeResponse,
  PeriodListResponse,
  ClassListResponse,
  SubjectListResponse,
} from '@sms/contracts';
import { serverFetch } from '@/lib/server';
import { TimetableManager } from './timetable-manager';

export const dynamic = 'force-dynamic';

export default async function TimetablePage() {
  let me: MeResponse | null = null;
  let periods: PeriodListResponse = { items: [], total: 0 };
  let classes: ClassListResponse = { items: [], total: 0 };
  let subjects: SubjectListResponse = { items: [], total: 0 };
  try {
    me = await serverFetch<MeResponse>('/api/v1/me');
    if (me.permissions.includes('timetable.read')) {
      periods = await serverFetch<PeriodListResponse>('/api/v1/periods?limit=100&offset=0');
    }
    if (me.permissions.includes('classes.read')) {
      classes = await serverFetch<ClassListResponse>('/api/v1/classes?limit=100&offset=0');
    }
    if (me.permissions.includes('subjects.read')) {
      subjects = await serverFetch<SubjectListResponse>('/api/v1/subjects?limit=100&offset=0');
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
    <TimetableManager
      initialPeriods={periods.items}
      initialClasses={classes.items}
      initialSubjects={subjects.items}
      canRead={me.permissions.includes('timetable.read')}
      canManage={me.permissions.includes('timetable.manage')}
      canPublish={me.permissions.includes('timetable.publish')}
      canListClasses={me.permissions.includes('classes.read')}
      canListSubjects={me.permissions.includes('subjects.read')}
    />
  );
}