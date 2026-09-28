'use client';

import { useState } from 'react';
import Link from 'next/link';
import type { AcademicYear, AcdClass, Campus, ClassResponse, GradeLevel } from '@sms/contracts';
import { Button, Card } from '@sms/ui';
import { clientFetch } from '@/lib/http';
import { classStatusLabel, gradeLevelName } from '@/lib/classes';

interface ClassManagerProps {
  initial: AcdClass[];
  initialTotal: number;
  campuses: Campus[];
  years: AcademicYear[];
  gradeLevels: GradeLevel[];
  canRead: boolean;
  canCreate: boolean;
  canUpdate: boolean;
  canDelete: boolean;
}

const campusName = (campuses: Campus[], id: string) =>
  campuses.find((c) => c.id === id)?.name ?? '—';
const yearName = (years: AcademicYear[], id: string) =>
  years.find((y) => y.id === id)?.code ?? '—';

export function ClassManager({
  initial,
  initialTotal,
  campuses,
  years,
  gradeLevels,
  canRead,
  canCreate,
  canUpdate,
  canDelete,
}: ClassManagerProps) {
  const [items, setItems] = useState<AcdClass[]>(initial);
  const [total, setTotal] = useState(initialTotal);
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [campusId, setCampusId] = useState(campuses[0]?.id ?? '');
  const [yearId, setYearId] = useState(years[0]?.id ?? '');
  const [gradeLevelId, setGradeLevelId] = useState(gradeLevels[0]?.id ?? '');
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function fail(err: unknown) {
    setError(err instanceof Error ? err.message : 'Request failed');
    setMessage(null);
  }

  async function create() {
    if (!code.trim() || !name.trim() || !campusId || !yearId) {
      setError('Code, name, campus and academic year are required');
      return;
    }
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const res = await clientFetch<ClassResponse>('/api/v1/classes', {
        method: 'POST',
        body: {
          code: code.trim(),
          name: name.trim(),
          campusId,
          academicYearId: yearId,
          ...(gradeLevelId ? { gradeLevelId } : {}),
        },
        includeCsrf: true,
      });
      setItems((prev) => [res.class, ...prev]);
      setTotal((t) => t + 1);
      setCode('');
      setName('');
      setMessage(`Class "${res.class.code}" created.`);
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  }

  async function rename(klass: AcdClass) {
    setError(null);
    setMessage(null);
    try {
      const res = await clientFetch<ClassResponse>(`/api/v1/classes/${klass.id}`, {
        method: 'PATCH',
        body: { name: klass.name },
        includeCsrf: true,
      });
      setItems((prev) => prev.map((c) => (c.id === klass.id ? res.class : c)));
      setMessage('Class updated.');
    } catch (err) {
      fail(err);
    }
  }

  async function toggleStatus(klass: AcdClass) {
    setError(null);
    setMessage(null);
    try {
      const action = klass.status === 'active' ? 'deactivate' : 'activate';
      const res = await clientFetch<ClassResponse>(`/api/v1/classes/${klass.id}/${action}`, {
        method: 'POST',
        includeCsrf: true,
      });
      setItems((prev) => prev.map((c) => (c.id === klass.id ? res.class : c)));
      setMessage(`Class ${klass.status === 'active' ? 'deactivated' : 'activated'}.`);
    } catch (err) {
      fail(err);
    }
  }

  async function remove(klass: AcdClass) {
    setError(null);
    setMessage(null);
    try {
      await clientFetch<ClassResponse>(`/api/v1/classes/${klass.id}`, {
        method: 'DELETE',
        includeCsrf: true,
      });
      setItems((prev) => prev.filter((c) => c.id !== klass.id));
      setTotal((t) => t - 1);
      setMessage(`Class "${klass.code}" deleted.`);
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
        <h1 className="mt-2 text-2xl font-semibold">Classes &amp; Sections</h1>
        <p className="mt-3 text-sm text-amber-600">Your role cannot view classes.</p>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-3xl p-8">
      <Link href="/school" className="text-sm text-blue-600 hover:underline">
        ← School
      </Link>
      <h1 className="mt-2 text-2xl font-semibold">Classes &amp; Sections</h1>

      {message && <p className="mt-3 text-sm text-green-600">{message}</p>}
      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}

      {canCreate && (
        <Card className="mt-6">
          <h2 className="text-lg font-semibold">New class</h2>
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <label className="block">
              <span className="text-sm text-gray-600">Code</span>
              <input
                className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="GR-9A"
              />
            </label>
            <label className="block">
              <span className="text-sm text-gray-600">Name</span>
              <input
                className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Grade Nine A"
              />
            </label>
            <label className="block">
              <span className="text-sm text-gray-600">Campus</span>
              <select
                className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2"
                value={campusId}
                onChange={(e) => setCampusId(e.target.value)}
              >
                {campuses.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="text-sm text-gray-600">Academic year</span>
              <select
                className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2"
                value={yearId}
                onChange={(e) => setYearId(e.target.value)}
              >
                {years.map((y) => (
                  <option key={y.id} value={y.id}>
                    {y.code}
                  </option>
                ))}
              </select>
            </label>
            {gradeLevels.length > 0 && (
              <label className="block">
                <span className="text-sm text-gray-600">Grade level</span>
                <select
                  className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2"
                  value={gradeLevelId}
                  onChange={(e) => setGradeLevelId(e.target.value)}
                >
                  <option value="">(none)</option>
                  {gradeLevels.map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.code} · {g.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
          <div className="mt-4">
            <Button type="button" disabled={busy || !canCreate} onClick={() => void create()}>
              Create class
            </Button>
          </div>
        </Card>
      )}

      <Card className="mt-6">
        <h2 className="text-lg font-semibold">
          Class list <span className="text-sm font-normal text-gray-500">({total})</span>
        </h2>
        <ul className="mt-4 space-y-3">
          {items.map((klass) => (
            <li key={klass.id} className="flex items-center justify-between gap-4 rounded-md border p-3">
              <div className="min-w-0">
                <Link href={`/school/classes/${klass.id}`} className="text-sm font-medium text-blue-700 hover:underline">
                  {klass.code} · {klass.name}
                </Link>
                <p className="text-xs text-gray-500">
                  {campusName(campuses, klass.campusId)} · {yearName(years, klass.academicYearId)} ·{' '}
                  {gradeLevelName(gradeLevels, klass.gradeLevelId)} · {classStatusLabel(klass.status)}
                </p>
                {canUpdate && (
                  <input
                    className="mt-1 w-full max-w-xs rounded-md border border-gray-300 px-2 py-1 text-sm"
                    value={klass.name}
                    onChange={(e) => setItems((prev) => prev.map((c) => (c.id === klass.id ? { ...c, name: e.target.value } : c)))}
                    onBlur={() => void rename(klass)}
                  />
                )}
              </div>
              <div className="flex shrink-0 gap-2">
                {canUpdate && (
                  <Button type="button" size="small" onClick={() => void toggleStatus(klass)}>
                    {klass.status === 'active' ? 'Deactivate' : 'Activate'}
                  </Button>
                )}
                {canDelete && (
                  <Button type="button" size="small" variant="danger" onClick={() => void remove(klass)}>
                    Delete
                  </Button>
                )}
              </div>
            </li>
          ))}
          {items.length === 0 && <li className="text-sm text-gray-500">No classes yet.</li>}
        </ul>
      </Card>
    </main>
  );
}