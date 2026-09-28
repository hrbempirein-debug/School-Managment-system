import type { MeResponse, SubjectListResponse } from '@sms/contracts';
import { serverFetch } from '@/lib/server';
import { SubjectManager } from './subject-manager';

export const dynamic = 'force-dynamic';

export default async function SubjectsPage() {
  let me: MeResponse | null = null;
  let subjects: SubjectListResponse = { items: [], total: 0 };
  try {
    me = await serverFetch<MeResponse>('/api/v1/me');
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
    <SubjectManager
      initial={subjects.items}
      initialTotal={subjects.total}
      canRead={me.permissions.includes('subjects.read')}
      canCreate={me.permissions.includes('subjects.create')}
      canUpdate={me.permissions.includes('subjects.update')}
      canDelete={me.permissions.includes('subjects.delete')}
    />
  );
}