import type { CampusListResponse, MeResponse } from '@sms/contracts';
import { serverFetch } from '@/lib/server';
import { CampusManager } from './campus-manager';

export const dynamic = 'force-dynamic';

export default async function CampusesPage() {
  let me: MeResponse | null = null;
  let campuses: CampusListResponse = { items: [], total: 0 };
  try {
    me = await serverFetch<MeResponse>('/api/v1/me');
    campuses = await serverFetch<CampusListResponse>('/api/v1/campuses?limit=100&offset=0');
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
    <CampusManager
      initial={campuses.items}
      initialTotal={campuses.total}
      canRead={me.permissions.includes('campus.read')}
      canCreate={me.permissions.includes('campus.create')}
      canUpdate={me.permissions.includes('campus.update')}
    />
  );
}