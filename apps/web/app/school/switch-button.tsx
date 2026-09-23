'use client';

import { useEffect, useState } from 'react';
import type { MembershipsResponse } from '@sms/contracts';
import { Button } from '@sms/ui';
import { API_BASE_URL, apiFetch } from '@/lib/api';

function getCsrf(): string {
  if (typeof document === 'undefined') return '';
  const match = document.cookie.match(/(?:^|;\s*)csrf=([^;]+)/);
  return match ? decodeURIComponent(match[1] ?? '') : '';
}

export function SwitchButton() {
  const [memberships, setMemberships] = useState<MembershipsResponse['memberships']>([]);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    void apiFetch<MembershipsResponse>('/api/v1/me/memberships')
      .then((res) => setMemberships(res.memberships))
      .catch(() => setMemberships([]));
  }, []);

  async function switchTenant(tenantId: string) {
    setLoading(true);
    setMessage(null);
    try {
      await fetch(`${API_BASE_URL}/api/v1/tenants/switch`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-csrf-token': getCsrf() },
        body: JSON.stringify({ tenantId }),
        credentials: 'include',
      });
      window.location.reload();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Switch failed');
      setLoading(false);
    }
  }

  return (
    <div className="space-y-2">
      {memberships.map((m) => (
        <div key={m.id} className="flex items-center justify-between rounded-md border p-3">
          <div>
            <p className="text-sm font-medium">{m.tenantName}</p>
            <p className="text-xs text-gray-500">
              {m.tenantSlug} · {m.roles.map((r) => r.name).join(', ')}
            </p>
          </div>
          <Button
            type="button"
            size="small"
            disabled={loading}
            onClick={() => void switchTenant(m.tenantId)}
          >
            Switch
          </Button>
        </div>
      ))}
      {message && <p className="text-sm text-red-600">{message}</p>}
    </div>
  );
}