'use client';

import { useState } from 'react';
import Link from 'next/link';
import type { SchoolSettings } from '@sms/contracts';
import { Button, Card } from '@sms/ui';
import { brandingLogoUrl, clientFetch, uploadBrandingLogo, type UploadResult } from '@/lib/http';

interface SettingsPanelProps {
  initial: SchoolSettings | null;
  canManage: boolean;
  canBrand: boolean;
}

export function SettingsPanel({ initial, canManage, canBrand }: SettingsPanelProps) {
  const [form, setForm] = useState({
    schoolName: initial?.schoolName ?? '',
    schoolCode: initial?.schoolCode ?? '',
    email: initial?.email ?? '',
    phone: initial?.phone ?? '',
    address: initial?.address ?? '',
    timezone: initial?.timezone ?? 'UTC',
    locale: initial?.locale ?? 'en',
    brandingColor: initial?.brandingColor ?? '',
  });
  const [logoVersion, setLogoVersion] = useState(initial?.updatedAt ?? Date.now());
  const [hasLogo, setHasLogo] = useState(!!initial?.logoPath);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);

  function set<K extends keyof typeof form>(key: K, value: string) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  async function saveSettings() {
    setError(null);
    setMessage(null);
    setSaving(true);
    try {
      const body: Record<string, string> = {};
      if (form.schoolName) body.schoolName = form.schoolName;
      if (form.schoolCode) body.schoolCode = form.schoolCode;
      if (form.email) body.email = form.email;
      if (form.phone) body.phone = form.phone;
      if (form.address) body.address = form.address;
      if (form.timezone) body.timezone = form.timezone;
      if (form.locale) body.locale = form.locale;
      if (form.brandingColor) body.brandingColor = form.brandingColor;
      const res = await clientFetch<{ settings: SchoolSettings }>('/api/v1/settings', {
        method: 'PATCH',
        body,
        includeCsrf: true,
      });
      setLogoVersion(res.settings.updatedAt);
      setHasLogo(!!res.settings.logoPath);
      setMessage('Settings saved.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  async function onUploadFile(file: File | undefined) {
    if (!file) return;
    setError(null);
    setMessage(null);
    setUploading(true);
    try {
      const res = await uploadBrandingLogo(file);
      const settings = (res as UploadResult & { settings?: SchoolSettings }).settings;
      if (settings) {
        setLogoVersion(settings.updatedAt);
        setHasLogo(true);
        setMessage('Logo uploaded.');
      } else {
        setError('Upload did not return updated settings');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setUploading(false);
    }
  }

  async function clearLogo() {
    setError(null);
    setMessage(null);
    try {
      const res = await clientFetch<{ settings: SchoolSettings }>('/api/v1/settings', {
        method: 'PATCH',
        body: { logoPath: null },
        includeCsrf: true,
      });
      setHasLogo(!!res.settings.logoPath);
      setLogoVersion(res.settings.updatedAt);
      setMessage('Logo removed.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Clear failed');
    }
  }

  return (
    <main className="mx-auto max-w-3xl p-8">
      <Link href="/school" className="text-sm text-blue-600 hover:underline">
        ← School
      </Link>
      <h1 className="mt-2 text-2xl font-semibold">Settings &amp; Branding</h1>

      {!canManage && (
        <p className="mt-3 text-sm text-amber-600">Your role has read access only.</p>
      )}

      {message && <p className="mt-3 text-sm text-green-600">{message}</p>}
      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}

      <Card className="mt-6">
        <h2 className="text-lg font-semibold">School profile</h2>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <Field label="School name" value={form.schoolName} onChange={(v) => set('schoolName', v)} />
          <Field label="School code" value={form.schoolCode} onChange={(v) => set('schoolCode', v)} />
          <Field label="Email" value={form.email} onChange={(v) => set('email', v)} />
          <Field label="Phone" value={form.phone} onChange={(v) => set('phone', v)} />
          <div className="sm:col-span-2">
            <Field label="Address" value={form.address} onChange={(v) => set('address', v)} />
          </div>
          <Field label="Timezone" value={form.timezone} onChange={(v) => set('timezone', v)} />
          <Field label="Locale" value={form.locale} onChange={(v) => set('locale', v)} />
          <Field
            label="Brand color (#RRGGBB)"
            value={form.brandingColor}
            onChange={(v) => set('brandingColor', v)}
          />
        </div>
        <div className="mt-5">
          <Button type="button" disabled={saving || !canManage} onClick={() => void saveSettings()}>
            {saving ? 'Saving…' : 'Save settings'}
          </Button>
        </div>
      </Card>

      {canBrand && (
        <Card className="mt-6">
          <h2 className="text-lg font-semibold">Logo</h2>
          <p className="mt-1 text-sm text-gray-500">
            PNG, JPEG or WebP up to 512 KiB. SVG is not accepted.
          </p>
          <div className="mt-4 flex items-center gap-4">
            {hasLogo && (
              // logo GET is cookie + cache controlled; ?v= busts the browser cache on replace
              <img
                src={`${brandingLogoUrl()}?v=${logoVersion}`}
                alt="School logo"
                className="h-16 w-16 rounded-md border border-gray-200 object-contain"
              />
            )}
            <label className="rounded-md bg-blue-600 px-4 py-2 text-white disabled:opacity-50">
              {uploading ? 'Uploading…' : 'Choose image'}
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp"
                disabled={uploading}
                className="hidden"
                onChange={(e) => void onUploadFile(e.target.files?.[0])}
              />
            </label>
            {hasLogo && (
              <Button type="button" onClick={() => void clearLogo()} className="!bg-gray-500">
                Remove logo
              </Button>
            )}
          </div>
        </Card>
      )}
    </main>
  );
}

function Field({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="block">
      <span className="text-sm text-gray-600">{label}</span>
      <input
        className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}