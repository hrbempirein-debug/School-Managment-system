import type { MeResponse, SchoolSettingsResponse } from '@sms/contracts';
import { serverFetch } from '@/lib/server';
import { SettingsPanel } from './settings-panel';

export const dynamic = 'force-dynamic';

export default async function SettingsPage() {
  let me: MeResponse | null = null;
  let settings: SchoolSettingsResponse['settings'] | null = null;
  try {
    me = await serverFetch<MeResponse>('/api/v1/me');
    settings = (await serverFetch<SchoolSettingsResponse>('/api/v1/settings')).settings;
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
    <SettingsPanel
      initial={settings}
      canManage={me.permissions.includes('school.settings.manage')}
      canBrand={me.permissions.includes('school.branding.manage')}
    />
  );
}