import type { MeResponse, StudentImport, StudentImportListResponse } from '@sms/contracts';
import { serverFetch } from '@/lib/server';
import { ImportWizard } from './import-wizard';

export const dynamic = 'force-dynamic';

export default async function ImportsPage() {
  let me: MeResponse | null = null;
  let imports: StudentImport[] = [];
  let total = 0;
  try {
    me = await serverFetch<MeResponse>('/api/v1/me');
    if (me.permissions.includes('students.read')) {
      const list = await serverFetch<StudentImportListResponse>('/api/v1/students/imports?limit=100&offset=0');
      imports = list.items;
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
    <ImportWizard
      initial={imports}
      initialTotal={total}
      canRead={me.permissions.includes('students.read')}
      canCreate={me.permissions.includes('students.create')}
    />
  );
}