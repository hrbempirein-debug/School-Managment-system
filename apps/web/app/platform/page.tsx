import type { MeResponse } from '@sms/contracts';
import { apiFetch } from '@/lib/api';

export const dynamic = 'force-dynamic';

export default async function PlatformPage() {
  let me: MeResponse | null = null;
  try {
    me = await apiFetch<MeResponse>('/api/v1/me');
  } catch {
    return <Unauthenticated />;
  }

  return (
    <main className="mx-auto max-w-3xl p-8">
      <h1 className="text-2xl font-semibold">Platform</h1>
      <p className="mt-1 text-sm text-gray-600">
        Signed in as <span className="font-medium">{me.user.email}</span>
      </p>
      <p className="mt-4 text-sm text-gray-500">
        Platform administration (tenant provisioning, billing, plans) ships with Phase 2.
        This shell exists so the platform route is authenticated and reachable.
      </p>
    </main>
  );
}

function Unauthenticated() {
  return (
    <main className="mx-auto max-w-3xl p-8">
      <p className="text-sm text-red-600">Please sign in first.</p>
    </main>
  );
}