'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import type {
  AcdClass,
  Subject,
  HomeworkDetail,
  HomeworkResponse,
  HomeworkListResponse,
  ClassSubjectListResponse,
} from '@sms/contracts';
import { Button, Card } from '@sms/ui';
import { clientFetch } from '@/lib/http';

interface HomeworkManagerProps {
  initialClasses: AcdClass[];
  initialSubjects: Subject[];
  canRead: boolean;
  canCreate: boolean;
  canUpdate: boolean;
  canDelete: boolean;
  canListClasses: boolean;
  canListSubjects: boolean;
}

export function HomeworkManager({
  initialClasses,
  initialSubjects,
  canRead,
  canCreate,
  canUpdate,
  canDelete,
  canListClasses,
  canListSubjects,
}: HomeworkManagerProps) {
  const [classId, setClassId] = useState('');
  const [rows, setRows] = useState<HomeworkDetail[]>([]);
  const [total, setTotal] = useState(0);
  const [subjectId, setSubjectId] = useState('');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [dueAt, setDueAt] = useState('');
  const [classSubjects, setClassSubjects] = useState<ClassSubjectListResponse['items']>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const subjectNames = useMemo(() => {
    const map = new Map<string, string>();
    for (const s of initialSubjects) map.set(s.id, `${s.code} · ${s.name}`);
    return map;
  }, [initialSubjects]);

  const linkedSubjectIds = useMemo(() => new Set(classSubjects.map((l) => l.subjectId)), [classSubjects]);

  function fail(err: unknown) {
    setError(err instanceof Error ? err.message : 'Request failed');
    setMessage(null);
  }

  async function selectClass(id: string) {
    setClassId(id);
    setRows([]);
    setTotal(0);
    setError(null);
    if (!id) {
      setClassSubjects([]);
      return;
    }
    try {
      const [linksRes, listRes] = await Promise.all([
        clientFetch<ClassSubjectListResponse>(`/api/v1/classes/${id}/subjects?limit=100&offset=0`),
        clientFetch<HomeworkListResponse>(`/api/v1/classes/${id}/homework?limit=100&offset=0`),
      ]);
      setClassSubjects(linksRes.items);
      setRows(listRes.items);
      setTotal(listRes.total);
    } catch (err) {
      fail(err);
    }
  }

  async function createHomework() {
    if (!classId || !subjectId || !title.trim()) {
      setError('Class, subject and title are required');
      return;
    }
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const res = await clientFetch<HomeworkResponse>(`/api/v1/classes/${classId}/homework`, {
        method: 'POST',
        body: {
          subjectId,
          title: title.trim(),
          ...(body.trim() ? { body: body.trim() } : {}),
          ...(dueAt ? { dueAt: new Date(dueAt).toISOString() } : {}),
        },
        includeCsrf: true,
      });
      setRows((prev) => [res.homework, ...prev]);
      setTotal((t) => t + 1);
      setTitle('');
      setBody('');
      setDueAt('');
      setMessage('Homework assigned.');
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  }

  async function updateTitle(hw: HomeworkDetail) {
    setError(null);
    setMessage(null);
    try {
      const res = await clientFetch<HomeworkResponse>(`/api/v1/classes/${hw.classId}/homework/${hw.id}`, {
        method: 'PATCH',
        body: { title: hw.title },
        includeCsrf: true,
      });
      setRows((prev) => prev.map((r) => (r.id === hw.id ? res.homework : r)));
      setMessage('Homework updated.');
    } catch (err) {
      fail(err);
    }
  }

  async function removeHomework(hw: HomeworkDetail) {
    setError(null);
    setMessage(null);
    try {
      await clientFetch<HomeworkResponse>(`/api/v1/classes/${hw.classId}/homework/${hw.id}`, {
        method: 'DELETE',
        includeCsrf: true,
      });
      setRows((prev) => prev.filter((r) => r.id !== hw.id));
      setTotal((t) => Math.max(0, t - 1));
      setMessage('Homework deleted.');
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
        <h1 className="mt-2 text-2xl font-semibold">Homework</h1>
        <p className="mt-3 text-sm text-amber-600">Your role cannot view homework.</p>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-3xl p-8">
      <Link href="/school" className="text-sm text-blue-600 hover:underline">
        ← School
      </Link>
      <h1 className="mt-2 text-2xl font-semibold">Homework</h1>
      <p className="mt-1 text-sm text-gray-600">
        Assignments per class subject. Homework is authored by the assigned teacher; parents see their children&apos;s
        classes only.
      </p>

      {message && <p className="mt-3 text-sm text-green-600">{message}</p>}
      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}

      <Card className="mt-6">
        <h2 className="text-lg font-semibold">Class</h2>
        {!canListClasses && (
          <p className="mt-2 text-xs text-gray-500">Your role cannot list classes here.</p>
        )}
        <select
          className="mt-3 w-full rounded-md border border-gray-300 px-3 py-2"
          value={classId}
          disabled={!canListClasses}
          onChange={(e) => void selectClass(e.target.value)}
        >
          <option value="">Select a class</option>
          {initialClasses.map((c) => (
            <option key={c.id} value={c.id}>
              {c.code} · {c.name}
            </option>
          ))}
        </select>
      </Card>

      {classId && canCreate && (
        <Card className="mt-6">
          <h2 className="text-lg font-semibold">New homework</h2>
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <label className="block">
              <span className="text-sm text-gray-600">Subject</span>
              <select
                className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2"
                value={subjectId}
                onChange={(e) => setSubjectId(e.target.value)}
              >
                <option value="">Select a subject</option>
                {classSubjects.map((l) => (
                  <option key={l.subjectId} value={l.subjectId}>
                    {subjectNames.get(l.subjectId) ?? l.subjectId}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="text-sm text-gray-600">Due date (optional)</span>
              <input
                className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2"
                type="date"
                value={dueAt}
                onChange={(e) => setDueAt(e.target.value)}
              />
            </label>
            <label className="block sm:col-span-2">
              <span className="text-sm text-gray-600">Title</span>
              <input
                className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Algebra sheet 1"
              />
            </label>
            <label className="block sm:col-span-2">
              <span className="text-sm text-gray-600">Body (optional)</span>
              <textarea
                className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2"
                rows={3}
                value={body}
                onChange={(e) => setBody(e.target.value)}
              />
            </label>
          </div>
          <div className="mt-4">
            <Button type="button" disabled={busy || !canCreate} onClick={() => void createHomework()}>
              Assign homework
            </Button>
          </div>
          {!canListSubjects && (
            <p className="mt-2 text-xs text-gray-500">Subject codes require subjects.read; IDs are shown otherwise.</p>
          )}
        </Card>
      )}

      <Card className="mt-6">
        <h2 className="text-lg font-semibold">
          Homework <span className="text-sm font-normal text-gray-500">({total})</span>
        </h2>
        <ul className="mt-4 space-y-3">
          {rows.map((hw) => (
            <li key={hw.id} className="rounded-md border p-3">
              <div className="flex items-center justify-between gap-4">
                <div className="min-w-0">
                  <p className="text-sm font-medium">{hw.title}</p>
                  <p className="text-xs text-gray-500">
                    {subjectNames.get(hw.subjectId) ?? hw.subjectId} · Teacher{' '}
                    {hw.teacherUserId.slice(0, 8)}
                    {hw.dueAt ? ` · due ${new Date(hw.dueAt).toLocaleDateString()}` : ''}
                    {hw.attachments.length > 0 ? ` · ${hw.attachments.length} attachment(s)` : ''}
                  </p>
                </div>
                <div className="flex shrink-0 gap-2">
                  {canUpdate && (
                    <input
                      className="w-full max-w-[220px] rounded-md border border-gray-300 px-2 py-1 text-sm"
                      value={hw.title}
                      onChange={(e) =>
                        setRows((prev) => prev.map((r) => (r.id === hw.id ? { ...r, title: e.target.value } : r)))
                      }
                      onBlur={() => void updateTitle(hw)}
                    />
                  )}
                  {canDelete && (
                    <Button type="button" size="small" variant="danger" onClick={() => void removeHomework(hw)}>
                      Delete
                    </Button>
                  )}
                </div>
              </div>
              {hw.body && <p className="mt-2 text-sm text-gray-600">{hw.body}</p>}
            </li>
          ))}
          {rows.length === 0 && <li className="text-sm text-gray-500">No homework for this class yet.</li>}
        </ul>
      </Card>
    </main>
  );
}