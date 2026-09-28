import type { HomeworkContextResponse, HomeworkListResponse, MeResponse } from '@sms/contracts';
import { serverFetch } from '@/lib/server';
import { loadPortalViews } from '@/lib/homework-portal';
import { HomeworkPortalView } from '../../homework/homework-portal-view';

export const dynamic = 'force-dynamic';

export default async function StudentHomeworkPage() {
  let me: MeResponse | null = null;
  let context: HomeworkContextResponse['context'] | null = null;
  try {
    me = await serverFetch<MeResponse>('/api/v1/me');
    if (me.permissions.includes('homework.read')) {
      context = (await serverFetch<HomeworkContextResponse>('/api/v1/me/homework-context')).context;
    }
  } catch {
    // fall through to unauthenticated UI
  }

  if (!me || !context) {
    return (
      <main className="mx-auto max-w-3xl p-8">
        <p className="text-sm text-red-600">Please sign in first.</p>
      </main>
    );
  }

  const views = await loadPortalViews(context.classes, (classId) =>
    serverFetch<HomeworkListResponse>(`/api/v1/classes/${classId}/homework?limit=100&offset=0`),
  );

  return (
    <HomeworkPortalView heading="Student homework" expectedRole="student" context={context} views={views} />
  );
}