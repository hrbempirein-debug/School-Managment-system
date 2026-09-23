import type { MeResponse } from '@sms/contracts';
import { Card } from '@sms/ui';
import { apiFetch } from '@/lib/api';
import { SwitchButton } from './switch-button';

export const dynamic = 'force-dynamic';

export default async function SchoolPage() {
  let me: MeResponse | null = null;
  try {
    me = await apiFetch<MeResponse>('/api/v1/me');
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
    <main className="mx-auto max-w-3xl p-8">
      <h1 className="text-2xl font-semibold">School</h1>
      <p className="mt-1 text-sm text-gray-600">
        Signed in as <span className="font-medium">{me.user.email}</span>
      </p>
      {me.activeTenant ? (
        <Card className="mt-6">
          <p className="font-medium">{me.activeTenant.name}</p>
          <p className="mt-1 text-xs text-gray-500">
            {me.activeTenant.slug} · {me.activeTenant.status}
          </p>
          <ul className="mt-3 list-inside list-disc text-sm text-gray-600">
            {me.permissions.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </Card>
      ) : (
        <p className="mt-6 text-sm text-gray-500">No active school yet.</p>
      )}
      <div className="mt-4">
        <SwitchButton />
      </div>
      <p className="mt-8 text-xs text-gray-400">
        School modules (students, staff, classes, finance, AI) build out in Phase 2+.
      </p>
    </main>
  );
}