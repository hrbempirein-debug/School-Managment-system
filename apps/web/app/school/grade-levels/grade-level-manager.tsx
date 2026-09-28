'use client';

import { useState } from 'react';
import Link from 'next/link';
import type { GradeLevel, GradeLevelResponse } from '@sms/contracts';
import { Button, Card } from '@sms/ui';
import { clientFetch } from '@/lib/http';
import { gradeLevelStatusLabel } from '@/lib/classes';

interface GradeLevelManagerProps {
  initial: GradeLevel[];
  initialTotal: number;
  canRead: boolean;
  canCreate: boolean;
  canUpdate: boolean;
  canDelete: boolean;
}

export function GradeLevelManager({
  initial,
  initialTotal,
  canRead,
  canCreate,
  canUpdate,
  canDelete,
}: GradeLevelManagerProps) {
  const [items, setItems] = useState<GradeLevel[]>(initial);
  const [total, setTotal] = useState(initialTotal);
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
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
      const res = await clientFetch<GradeLevelResponse>('/api/v1/grade-levels', {
        method: 'POST',
        body: { code: code.trim(), name: name.trim() },
        includeCsrf: true,
      });
      setItems((prev) => [res.gradeLevel, ...prev]);
      setTotal((t) => t + 1);
      setCode('');
      setName('');
      setMessage(`Grade level "${res.gradeLevel.code}" created.`);
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  }

  async function rename(level: GradeLevel) {
    setError(null);
    setMessage(null);
    try {
      const res = await clientFetch<GradeLevelResponse>(`/api/v1/grade-levels/${level.id}`, {
        method: 'PATCH',
        body: { name: level.name },
        includeCsrf: true,
      });
      setItems((prev) => prev.map((g) => (g.id === level.id ? res.gradeLevel : g)));
      setMessage('Grade level updated.');
    } catch (err) {
      fail(err);
    }
  }

  async function toggleStatus(level: GradeLevel) {
    setError(null);
    setMessage(null);
    try {
      const action = level.status === 'active' ? 'deactivate' : 'activate';
      const res = await clientFetch<GradeLevelResponse>(`/api/v1/grade-levels/${level.id}/${action}`, {
        method: 'POST',
        includeCsrf: true,
      });
      setItems((prev) => prev.map((g) => (g.id === level.id ? res.gradeLevel : g)));
      setMessage(`Grade level ${level.status === 'active' ? 'deactivated' : 'activated'}.`);
    } catch (err) {
      fail(err);
    }
  }

  async function remove(level: GradeLevel) {
    setError(null);
    setMessage(null);
    try {
      await clientFetch<GradeLevelResponse>(`/api/v1/grade-levels/${level.id}`, {
        method: 'DELETE',
        includeCsrf: true,
      });
      setItems((prev) => prev.filter((g) => g.id !== level.id));
      setTotal((t) => t - 1);
      setMessage(`Grade level "${level.code}" deleted.`);
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
        <h1 className="mt-2 text-2xl font-semibold">Grade Levels</h1>
        <p className="mt-3 text-sm text-amber-600">Your role cannot view grade levels.</p>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-3xl p-8">
      <Link href="/school" className="text-sm text-blue-600 hover:underline">
        ← School
      </Link>
      <h1 className="mt-2 text-2xl font-semibold">Grade Levels</h1>
      <p className="mt-1 text-sm text-gray-600">
        The tenant-wide grade catalog (e.g. GR-9 &middot; Grade Nine). Classes may reference a grade level.
      </p>

      {message && <p className="mt-3 text-sm text-green-600">{message}</p>}
      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}

      {canCreate && (
        <Card className="mt-6">
          <h2 className="text-lg font-semibold">New grade level</h2>
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <label className="block">
              <span className="text-sm text-gray-600">Code</span>
              <input
                className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="GR-9"
              />
            </label>
            <label className="block">
              <span className="text-sm text-gray-600">Name</span>
              <input
                className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Grade Nine"
              />
            </label>
          </div>
          <div className="mt-4">
            <Button type="button" disabled={busy || !canCreate} onClick={() => void create()}>
              Create grade level
            </Button>
          </div>
        </Card>
      )}

      <Card className="mt-6">
        <h2 className="text-lg font-semibold">
          Grade levels <span className="text-sm font-normal text-gray-500">({total})</span>
        </h2>
        <ul className="mt-4 space-y-3">
          {items.map((level) => (
            <li key={level.id} className="flex items-center justify-between gap-4 rounded-md border p-3">
              <div className="min-w-0">
                <p className="text-sm font-medium">
                  {level.code} · {level.name}
                </p>
                <p className="text-xs text-gray-500">{gradeLevelStatusLabel(level.status)}</p>
                {canUpdate && (
                  <input
                    className="mt-1 w-full max-w-xs rounded-md border border-gray-300 px-2 py-1 text-sm"
                    value={level.name}
                    onChange={(e) => setItems((prev) => prev.map((g) => (g.id === level.id ? { ...g, name: e.target.value } : g)))}
                    onBlur={() => void rename(level)}
                  />
                )}
              </div>
              <div className="flex shrink-0 gap-2">
                {canUpdate && (
                  <Button type="button" size="small" onClick={() => void toggleStatus(level)}>
                    {level.status === 'active' ? 'Deactivate' : 'Activate'}
                  </Button>
                )}
                {canDelete && (
                  <Button type="button" size="small" variant="danger" onClick={() => void remove(level)}>
                    Delete
                  </Button>
                )}
              </div>
            </li>
          ))}
          {items.length === 0 && <li className="text-sm text-gray-500">No grade levels yet.</li>}
        </ul>
      </Card>
    </main>
  );
}