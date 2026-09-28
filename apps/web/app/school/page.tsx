import Link from 'next/link';
import type { MeResponse } from '@sms/contracts';
import { Card } from '@sms/ui';
import { serverFetch } from '@/lib/server';
import { visibleSections } from '@/lib/nav';
import { SwitchButton } from './switch-button';

export const dynamic = 'force-dynamic';

export default async function SchoolPage() {
  let me: MeResponse | null = null;
  try {
    me = await serverFetch<MeResponse>('/api/v1/me');
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

  const sections = visibleSections(me.permissions);

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
          <div className="mt-4 grid gap-3 sm:grid-cols-3">
            {sections.map((s) => (
              <Link
                key={s.href}
                href={s.href}
                className="rounded-md border border-gray-200 bg-gray-50 p-3 transition-colors hover:border-blue-400 hover:bg-blue-50"
              >
                <p className="text-sm font-medium">{s.title}</p>
                <p className="mt-1 text-xs text-gray-500">{s.description}</p>
              </Link>
            ))}
            {sections.length === 0 && (
              <p className="text-sm text-gray-500">No school modules are available for your role yet.</p>
            )}
          </div>
        </Card>
      ) : (
        <p className="mt-6 text-sm text-gray-500">No active school yet.</p>
      )}
      <div className="mt-4">
        <SwitchButton />
      </div>
    </main>
  );
}