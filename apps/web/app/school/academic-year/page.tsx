import type { AcademicYearListResponse, MeResponse } from '@sms/contracts';
import { serverFetch } from '@/lib/server';
import { AcademicYearWizard } from './academic-year-wizard';

export const dynamic = 'force-dynamic';

export default async function AcademicYearPage() {
  let me: MeResponse | null = null;
  let years: AcademicYearListResponse = { items: [], total: 0 };
  try {
    me = await serverFetch<MeResponse>('/api/v1/me');
    years = await serverFetch<AcademicYearListResponse>('/api/v1/academic-years?limit=100&offset=0');
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

  const permissions = me.permissions;
  return (
    <AcademicYearWizard
      initialYears={years.items}
      initialTotal={years.total}
      canReadYears={permissions.includes('academic.years.read')}
      canWriteYears={permissions.includes('academic.years.write')}
      canWriteTerms={permissions.includes('academic.terms.write')}
    />
  );
}