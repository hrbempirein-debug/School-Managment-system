'use client';

import { useState } from 'react';
import Link from 'next/link';
import type { Campus, CampusListResponse, CampusResponse } from '@sms/contracts';
import { Button, Card } from '@sms/ui';
import { clientFetch } from '@/lib/http';

interface CampusManagerProps {
  initial: Campus[];
  initialTotal: number;
  canRead: boolean;
  canCreate: boolean;
  canUpdate: boolean;
}

export function CampusManager({ initial, initialTotal, canRead, canCreate, canUpdate }: CampusManagerProps) {
  const [items, setItems] = useState<Campus[]>(initial);
  const [total, setTotal] = useState(initialTotal);
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [city, setCity] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function fail(err: unknown) {
    setError(err instanceof Error ? err.message : 'Request failed');
    setMessage(null);
  }

  async function create() {
    if (!code.trim() || !name.trim()) {
      setError('Code and name are required');
      return;
    }
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const res = await clientFetch<CampusResponse>('/api/v1/campuses', {
        method: 'POST',
        body: { code: code.trim(), name: name.trim(), city: city.trim() || undefined },
        includeCsrf: true,
      });
      setItems((prev) => [res.campus, ...prev]);
      setTotal((t) => t + 1);
      setCode('');
      setName('');
      setCity('');
      setMessage(`Campus "${res.campus.name}" created.`);
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  }

  async function toggleStatus(campus: Campus) {
    setError(null);
    setMessage(null);
    try {
      const action = campus.status === 'active' ? 'deactivate' : 'activate';
      const res = await clientFetch<CampusResponse>(`/api/v1/campuses/${campus.id}/${action}`, {
        method: 'POST',
        includeCsrf: true,
      });
      setItems((prev) => prev.map((c) => (c.id === campus.id ? res.campus : c)));
      setMessage(`Campus ${campus.status === 'active' ? 'deactivated' : 'activated'}.`);
    } catch (err) {
      fail(err);
    }
  }

  async function rename(campus: Campus) {
    setError(null);
    setMessage(null);
    try {
      const res = await clientFetch<CampusResponse>(`/api/v1/campuses/${campus.id}`, {
        method: 'PATCH',
        body: { name: campus.name },
        includeCsrf: true,
      });
      setItems((prev) => prev.map((c) => (c.id === campus.id ? res.campus : c)));
      setMessage('Campus updated.');
    } catch (err) {
      fail(err);
    }
  }

  if (!canRead) {
    return (
      <main className="mx-auto max-w-3xl p-8">
        <Link href="/school" className="text-sm text-blue-600 hover:underline">
          ← School
        </Link>
        <h1 className="mt-2 text-2xl font-semibold">Campuses</h1>
        <p className="mt-3 text-sm text-amber-600">Your role cannot view campuses.</p>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-3xl p-8">
      <Link href="/school" className="text-sm text-blue-600 hover:underline">
        ← School
      </Link>
      <h1 className="mt-2 text-2xl font-semibold">Campuses</h1>

      {message && <p className="mt-3 text-sm text-green-600">{message}</p>}
      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}

      {canCreate && (
        <Card className="mt-6">
          <h2 className="text-lg font-semibold">New campus</h2>
          <div className="mt-4 grid gap-4 sm:grid-cols-3">
            <label className="block">
              <span className="text-sm text-gray-600">Code</span>
              <input
                className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2"
                value={code}
                onChange={(e) => setCode(e.target.value)}
              />
            </label>
            <label className="block">
              <span className="text-sm text-gray-600">Name</span>
              <input
                className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            <label className="block">
              <span className="text-sm text-gray-600">City</span>
              <input
                className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2"
                value={city}
                onChange={(e) => setCity(e.target.value)}
              />
            </label>
          </div>
          <div className="mt-4">
            <Button type="button" disabled={busy || !canCreate} onClick={() => void create()}>
              Create campus
            </Button>
          </div>
        </Card>
      )}

      <Card className="mt-6">
        <h2 className="text-lg font-semibold">
          Campus list <span className="text-sm font-normal text-gray-500">({total})</span>
        </h2>
        <ul className="mt-4 space-y-3">
          {items.map((campus) => (
            <li key={campus.id} className="flex items-center justify-between rounded-md border p-3">
              <div>
                <p className="text-sm font-medium">{campus.name}</p>
                <p className="text-xs text-gray-500">
                  {campus.code} · {campus.city || 'no city'} · {campus.status}
                </p>
                <input
                  className="mt-1 w-full max-w-xs rounded-md border border-gray-300 px-2 py-1 text-sm"
                  value={campus.name}
                  disabled={!canUpdate}
                  onChange={(e) => setItems((prev) => prev.map((c) => (c.id === campus.id ? { ...c, name: e.target.value } : c)))}
                  onBlur={() => void rename(campus)}
                />
              </div>
              {canUpdate && (
                <Button type="button" size="small" onClick={() => void toggleStatus(campus)}>
                  {campus.status === 'active' ? 'Deactivate' : 'Activate'}
                </Button>
              )}
            </li>
          ))}
          {items.length === 0 && <li className="text-sm text-gray-500">No campuses yet.</li>}
        </ul>
      </Card>
    </main>
  );
}