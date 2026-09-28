import type { MeResponse, ResultsPortalResponse } from '@sms/contracts';
import { serverFetch } from '@/lib/server';
import { ResultsPortalView as ResultsPortalViewTable } from './results-portal-view';

export const dynamic = 'force-dynamic';

/**
 * Parent results portal. Every read is relationship-scoped and published-only on
 * the API side, so this page only has to render what the server allowed: one
 * panel per linked child, plus a transcript that spans every published exam.
 */
export default async function ParentResultsPage() {
  let me: MeResponse | null = null;
  let portal: ResultsPortalResponse | null = null;
  try {
    me = await serverFetch<MeResponse>('/api/v1/me');
    if (me.permissions.includes('exams.read')) {
      portal = await serverFetch<ResultsPortalResponse>('/api/v1/me/results');
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

  if (!me.permissions.includes('exams.read')) {
    return (
      <main className="mx-auto max-w-3xl p-8">
        <h1 className="text-2xl font-semibold">Results</h1>
        <p className="mt-3 text-sm text-gray-600">
          Your role in this school does not include exam results access.
        </p>
      </main>
    );
  }

  if (!portal || portal.views.length === 0) {
    return (
      <main className="mx-auto max-w-3xl p-8">
        <h1 className="text-2xl font-semibold">Results</h1>
        <p className="mt-3 text-sm text-gray-600">
          No published results are available for your children yet. Results appear here once the
          school publishes an exam.
        </p>
      </main>
    );
  }

  return <ResultsPortalViewTable views={portal.views} />;
}
