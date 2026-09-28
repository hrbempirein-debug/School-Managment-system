'use client';

import { useState } from 'react';
import Link from 'next/link';
import type { Subject, SubjectResponse } from '@sms/contracts';
import { Button, Card } from '@sms/ui';
import { clientFetch } from '@/lib/http';
import { subjectStatusLabel } from '@/lib/classes';

interface SubjectManagerProps {
  initial: Subject[];
  initialTotal: number;
  canRead: boolean;
  canCreate: boolean;
  canUpdate: boolean;
  canDelete: boolean;
}

export function SubjectManager({
  initial,
  initialTotal,
  canRead,
  canCreate,
  canUpdate,
  canDelete,
}: SubjectManagerProps) {
  const [items, setItems] = useState<Subject[]>(initial);
  const [total, setTotal] = useState(initialTotal);
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
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
      const res = await clientFetch<SubjectResponse>('/api/v1/subjects', {
        method: 'POST',
        body: {
          code: code.trim(),
          name: name.trim(),
          ...(description.trim() ? { description: description.trim() } : {}),
        },
        includeCsrf: true,
      });
      setItems((prev) => [res.subject, ...prev]);
      setTotal((t) => t + 1);
      setCode('');
      setName('');
      setDescription('');
      setMessage(`Subject "${res.subject.code}" created.`);
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  }

  async function rename(subject: Subject) {
    setError(null);
    setMessage(null);
    try {
      const res = await clientFetch<SubjectResponse>(`/api/v1/subjects/${subject.id}`, {
        method: 'PATCH',
        body: { name: subject.name },
        includeCsrf: true,
      });
      setItems((prev) => prev.map((s) => (s.id === subject.id ? res.subject : s)));
      setMessage('Subject updated.');
    } catch (err) {
      fail(err);
    }
  }

  async function toggleStatus(subject: Subject) {
    setError(null);
    setMessage(null);
    try {
      const action = subject.status === 'active' ? 'deactivate' : 'activate';
      const res = await clientFetch<SubjectResponse>(`/api/v1/subjects/${subject.id}/${action}`, {
        method: 'POST',
        includeCsrf: true,
      });
      setItems((prev) => prev.map((s) => (s.id === subject.id ? res.subject : s)));
      setMessage(`Subject ${subject.status === 'active' ? 'deactivated' : 'activated'}.`);
    } catch (err) {
      fail(err);
    }
  }

  async function remove(subject: Subject) {
    setError(null);
    setMessage(null);
    try {
      await clientFetch<SubjectResponse>(`/api/v1/subjects/${subject.id}`, {
        method: 'DELETE',
        includeCsrf: true,
      });
      setItems((prev) => prev.filter((s) => s.id !== subject.id));
      setTotal((t) => t - 1);
      setMessage(`Subject "${subject.code}" deleted.`);
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
        <h1 className="mt-2 text-2xl font-semibold">Subjects</h1>
        <p className="mt-3 text-sm text-amber-600">Your role cannot view subjects.</p>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-3xl p-8">
      <Link href="/school" className="text-sm text-blue-600 hover:underline">
        ← School
      </Link>
      <h1 className="mt-2 text-2xl font-semibold">Subjects</h1>
      <p className="mt-1 text-sm text-gray-600">
        The tenant-wide subject catalog (e.g. MATH &middot; Mathematics). Subjects are attached to classes and
        get a lead teacher per class.
      </p>

      {message && <p className="mt-3 text-sm text-green-600">{message}</p>}
      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}

      {canCreate && (
        <Card className="mt-6">
          <h2 className="text-lg font-semibold">New subject</h2>
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <label className="block">
              <span className="text-sm text-gray-600">Code</span>
              <input
                className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="MATH"
              />
            </label>
            <label className="block">
              <span className="text-sm text-gray-600">Name</span>
              <input
                className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Mathematics"
              />
            </label>
            <label className="block sm:col-span-2">
              <span className="text-sm text-gray-600">Description (optional)</span>
              <input
                className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Algebrčia, geometry and calculus"
              />
            </label>
          </div>
          <div className="mt-4">
            <Button type="button" disabled={busy || !canCreate} onClick={() => void create()}>
              Create subject
            </Button>
          </div>
        </Card>
      )}

      <Card className="mt-6">
        <h2 className="text-lg font-semibold">
          Subjects <span className="text-sm font-normal text-gray-500">({total})</span>
        </h2>
        <ul className="mt-4 space-y-3">
          {items.map((subject) => (
            <li key={subject.id} className="flex items-center justify-between gap-4 rounded-md border p-3">
              <div className="min-w-0">
                <p className="text-sm font-medium">
                  {subject.code} · {subject.name}
                </p>
                <p className="text-xs text-gray-500">
                  {subjectStatusLabel(subject.status)}
                  {subject.description ? ` · ${subject.description}` : ''}
                </p>
                {canUpdate && (
                  <input
                    className="mt-1 w-full max-w-xs rounded-md border border-gray-300 px-2 py-1 text-sm"
                    value={subject.name}
                    onChange={(e) => setItems((prev) => prev.map((s) => (s.id === subject.id ? { ...s, name: e.target.value } : s)))}
                    onBlur={() => void rename(subject)}
                  />
                )}
              </div>
              <div className="flex shrink-0 gap-2">
                {canUpdate && (
                  <Button type="button" size="small" onClick={() => void toggleStatus(subject)}>
                    {subject.status === 'active' ? 'Deactivate' : 'Activate'}
                  </Button>
                )}
                {canDelete && (
                  <Button type="button" size="small" variant="danger" onClick={() => void remove(subject)}>
                    Delete
                  </Button>
                )}
              </div>
            </li>
          ))}
          {items.length === 0 && <li className="text-sm text-gray-500">No subjects yet.</li>}
        </ul>
      </Card>
    </main>
  );
}