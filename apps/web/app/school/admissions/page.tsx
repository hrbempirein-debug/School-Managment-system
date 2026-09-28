import type { AdmissionApplication, AdmissionApplicationListResponse, MeResponse } from '@sms/contracts';
import { serverFetch } from '@/lib/server';
import { AdmissionsPipeline } from './admissions-pipeline';

export const dynamic = 'force-dynamic';

export default async function AdmissionsPage() {
  let me: MeResponse | null = null;
  let items: AdmissionApplication[] = [];
  let total = 0;
  try {
    me = await serverFetch<MeResponse>('/api/v1/me');
    if (me.permissions.includes('admission.read')) {
      const list = await serverFetch<AdmissionApplicationListResponse>('/api/v1/admission-applications?limit=100&offset=0');
      items = list.items;
      total = list.total;
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
    <AdmissionsPipeline
      initial={items}
      initialTotal={total}
      canRead={me.permissions.includes('admission.read')}
      canCreate={me.permissions.includes('admission.create')}
      canReview={me.permissions.includes('admission.review')}
    />
  );
}