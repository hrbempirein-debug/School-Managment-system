import type { Campus, CampusListResponse, MeResponse, Student, StudentListResponse } from '@sms/contracts';
import { serverFetch } from '@/lib/server';
import { StudentDirectory } from './student-directory';

export const dynamic = 'force-dynamic';

export default async function StudentsPage() {
  let me: MeResponse | null = null;
  let items: Student[] = [];
  let total = 0;
  let campuses: Campus[] = [];
  try {
    me = await serverFetch<MeResponse>('/api/v1/me');
    if (me.permissions.includes('students.read')) {
      const list = await serverFetch<StudentListResponse>('/api/v1/students?limit=50&offset=0');
      items = list.items;
      total = list.total;
    }
    if (me.permissions.includes('campus.read')) {
      const campusesRes = await serverFetch<CampusListResponse>('/api/v1/campuses?limit=100&offset=0');
      campuses = campusesRes.items;
    }
  } catch {
    // fall through to unauthenticated / permission UI
  }

  if (!me) {
    return (
      <main className="mx-auto max-w-3xl p-8">
        <p className="text-sm text-red-600">Please sign in first.</p>
      </main>
    );
  }

  return (
    <StudentDirectory
      initial={items}
      initialTotal={total}
      campuses={campuses}
      canRead={me.permissions.includes('students.read')}
      canCreate={me.permissions.includes('students.create')}
      canUpdate={me.permissions.includes('students.update')}
      canDelete={me.permissions.includes('students.delete')}
      canExport={me.permissions.includes('students.export')}
      canReadCampuses={me.permissions.includes('campus.read')}
    />
  );
}