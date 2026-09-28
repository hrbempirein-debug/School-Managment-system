import type { GradeLevelListResponse, MeResponse } from '@sms/contracts';
import { serverFetch } from '@/lib/server';
import { GradeLevelManager } from './grade-level-manager';

export const dynamic = 'force-dynamic';

export default async function GradeLevelsPage() {
  let me: MeResponse | null = null;
  let gradeLevels: GradeLevelListResponse = { items: [], total: 0 };
  try {
    me = await serverFetch<MeResponse>('/api/v1/me');
    if (me.permissions.includes('grade.levels.read')) {
      gradeLevels = await serverFetch<GradeLevelListResponse>('/api/v1/grade-levels?limit=100&offset=0');
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
    <GradeLevelManager
      initial={gradeLevels.items}
      initialTotal={gradeLevels.total}
      canRead={me.permissions.includes('grade.levels.read')}
      canCreate={me.permissions.includes('grade.levels.create')}
      canUpdate={me.permissions.includes('grade.levels.update')}
      canDelete={me.permissions.includes('grade.levels.delete')}
    />
  );
}