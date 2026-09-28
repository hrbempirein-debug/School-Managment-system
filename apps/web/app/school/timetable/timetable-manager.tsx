'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import type {
  AcdClass,
  Period,
  Subject,
  Section,
  ClassSubject,
  TimetableEntry,
  TimetableEntryResponse,
  SectionListResponse,
  ClassSubjectListResponse,
  TimetableEntryListResponse,
  PublishTimetableResponse,
} from '@sms/contracts';
import { Button, Card } from '@sms/ui';
import { clientFetch } from '@/lib/http';
import { WEEKDAY_LABELS, gridKey, gridRows, describeConflicts } from '@/lib/timetable';

interface TimetableManagerProps {
  initialPeriods: Period[];
  initialClasses: AcdClass[];
  initialSubjects: Subject[];
  canRead: boolean;
  canManage: boolean;
  canPublish: boolean;
  canListClasses: boolean;
  canListSubjects: boolean;
}

export function TimetableManager({
  initialPeriods,
  initialClasses,
  initialSubjects,
  canRead,
  canManage,
  canPublish,
  canListClasses,
  canListSubjects,
}: TimetableManagerProps) {
  const [classId, setClassId] = useState('');
  const [sectionId, setSectionId] = useState('');
  const [subjectId, setSubjectId] = useState('');
  const [weekday, setWeekday] = useState<number>(1);
  const [periodId, setPeriodId] = useState('');
  const [sections, setSections] = useState<Section[]>([]);
  const [classSubjects, setClassSubjects] = useState<ClassSubject[]>([]);
  const [entries, setEntries] = useState<TimetableEntry[]>([]);
  const [publish, setPublish] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const subjectNames = useMemo(() => {
    const map = new Map<string, string>();
    for (const s of initialSubjects) map.set(s.id, `${s.code} · ${s.name}`);
    return map;
  }, [initialSubjects]);

  function fail(err: unknown) {
    setError(err instanceof Error ? err.message : 'Request failed');
    setMessage(null);
    setPublish(null);
  }

  async function selectClass(id: string) {
    setClassId(id);
    setSectionId('');
    setSubjectId('');
    setEntries([]);
    setPublish(null);
    if (!id) {
      setSections([]);
      setClassSubjects([]);
      return;
    }
    setError(null);
    try {
      const [sectionsRes, linksRes] = await Promise.all([
        clientFetch<SectionListResponse>(`/api/v1/classes/${id}/sections?limit=100&offset=0`),
        clientFetch<ClassSubjectListResponse>(`/api/v1/classes/${id}/subjects?limit=100&offset=0`),
      ]);
      setSections(sectionsRes.items);
      setClassSubjects(linksRes.items);
    } catch (err) {
      fail(err);
    }
  }

  async function loadGrid(secId: string) {
    if (!classId || !secId) {
      setEntries([]);
      return;
    }
    setError(null);
    try {
      const res = await clientFetch<TimetableEntryListResponse>(
        `/api/v1/classes/${classId}/sections/${secId}/timetable?limit=100&offset=0`,
      );
      setEntries(res.items);
    } catch (err) {
      fail(err);
    }
  }

  async function createLesson() {
    if (!classId || !sectionId || !subjectId || !periodId) {
      setError('Class, section, subject, weekday and period are required');
      return;
    }
    setBusy(true);
    setError(null);
    setMessage(null);
    setPublish(null);
    try {
      const res = await clientFetch<TimetableEntryResponse>(
        `/api/v1/classes/${classId}/sections/${sectionId}/timetable`,
        {
          method: 'POST',
          body: { subjectId, weekday, periodId },
          includeCsrf: true,
        },
      );
      setEntries((prev) => [...prev.filter((e) => gridKey(e.weekday, e.periodId) !== gridKey(weekday, periodId)), res.entry]);
      setMessage('Lesson added to the grid.');
      setPeriodId('');
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  }

  async function removeLesson(entry: TimetableEntry) {
    setError(null);
    setMessage(null);
    setPublish(null);
    try {
      await clientFetch<TimetableEntryResponse>(
        `/api/v1/classes/${entry.classId}/sections/${entry.sectionId}/timetable/${entry.id}`,
        { method: 'DELETE', includeCsrf: true },
      );
      setEntries((prev) => prev.filter((e) => e.id !== entry.id));
      setMessage('Lesson removed from the grid.');
    } catch (err) {
      fail(err);
    }
  }

  async function runPublish() {
    setBusy(true);
    setError(null);
    setMessage(null);
    setPublish(null);
    try {
      const res = await clientFetch<PublishTimetableResponse>('/api/v1/timetable/publish', {
        method: 'POST',
        body: {},
        includeCsrf: true,
      });
      setPublish(
        res.published
          ? 'Published — the weekly grid has no teacher double-bookings.'
          : `Not published: ${describeConflicts(res.conflicts)}. Resolve the clashes and re-publish.`,
      );
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  }

  const rows = useMemo(() => gridRows(entries, initialPeriods), [entries, initialPeriods]);
  const linkedSubjectIds = useMemo(() => new Set(classSubjects.map((l) => l.subjectId)), [classSubjects]);

  if (!canRead) {
    return (
      <main className="mx-auto max-w-3xl p-8">
        <Link href="/school" className="text-sm text-blue-600 hover:underline">
          ← School
        </Link>
        <h1 className="mt-2 text-2xl font-semibold">Weekly Timetable</h1>
        <p className="mt-3 text-sm text-amber-600">Your role cannot view the timetable.</p>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-5xl p-8">
      <Link href="/school" className="text-sm text-blue-600 hover:underline">
        ← School
      </Link>
      <h1 className="mt-2 text-2xl font-semibold">Weekly Timetable</h1>
      <p className="mt-1 text-sm text-gray-600">
        Bell periods (tenant-wide or per-campus) and the per-section lesson grid. A slot holds one lesson; the lead
        teacher is always the one assigned to the class subject.
      </p>

      {message && <p className="mt-3 text-sm text-green-600">{message}</p>}
      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
      {publish && (
        <p className={`mt-3 text-sm ${publish.startsWith('Published') ? 'text-green-600' : 'text-amber-600'}`}>
          {publish}
        </p>
      )}

      <Card className="mt-6">
        <h2 className="text-lg font-semibold">Select class &amp; section</h2>
        {!canListClasses && (
          <p className="mt-2 text-xs text-gray-500">
            Your role cannot list classes here; only periods are shown.
          </p>
        )}
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <label className="block">
            <span className="text-sm text-gray-600">Class</span>
            <select
              className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2"
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
          </label>
          <label className="block">
            <span className="text-sm text-gray-600">Section</span>
            <select
              className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2"
              value={sectionId}
              onChange={(e) => {
                setSectionId(e.target.value);
                void loadGrid(e.target.value);
              }}
            >
              <option value="">Select a section</option>
              {sections.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.code}
                </option>
              ))}
            </select>
          </label>
        </div>
      </Card>

      {canManage && classId && sectionId && (
        <Card className="mt-6">
          <h2 className="text-lg font-semibold">Add a lesson</h2>
          <div className="mt-4 grid gap-4 sm:grid-cols-4">
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
              <span className="text-sm text-gray-600">Weekday</span>
              <select
                className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2"
                value={weekday}
                onChange={(e) => setWeekday(Number(e.target.value))}
              >
                {WEEKDAY_LABELS.map((label, i) => (
                  <option key={i + 1} value={i + 1}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="text-sm text-gray-600">Period</span>
              <select
                className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2"
                value={periodId}
                onChange={(e) => setPeriodId(e.target.value)}
              >
                <option value="">Select a period</option>
                {initialPeriods.map((p) => (
                  <option key={p.id} value={p.id}>
                    P{p.periodNo} · {p.startTime}–{p.endTime}
                  </option>
                ))}
              </select>
            </label>
            <div className="flex items-end">
              <Button type="button" disabled={busy || !canManage} onClick={() => void createLesson()}>
                Add lesson
              </Button>
            </div>
          </div>
          {!canListSubjects && (
            <p className="mt-2 text-xs text-gray-500">Subject codes require subjects.read; IDs are shown otherwise.</p>
          )}
        </Card>
      )}

      <Card className="mt-6">
        <div className="flex items-center justify-between gap-4">
          <h2 className="text-lg font-semibold">Grid</h2>
          {canPublish && (
            <Button type="button" size="small" disabled={busy} onClick={() => void runPublish()}>
              Publish validation
            </Button>
          )}
        </div>
        {rows.length === 0 ? (
          <p className="mt-4 text-sm text-gray-500">No periods configured yet.</p>
        ) : (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr>
                  <th className="border px-2 py-1 text-left text-xs text-gray-500">Period</th>
                  {WEEKDAY_LABELS.map((label, i) => (
                    <th key={label} className="border px-2 py-1 text-xs text-gray-500">
                      {label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.period.id}>
                    <td className="border px-2 py-1 text-xs text-gray-600">
                      P{row.period.periodNo} {row.period.startTime}–{row.period.endTime}
                    </td>
                    {row.cells.map((cell) =>
                      cell.entry ? (
                        <td key={cell.key} className="border bg-blue-50 px-2 py-1">
                          <p className="text-xs font-medium">
                            {subjectNames.get(cell.entry.subjectId) ?? cell.entry.subjectId}
                          </p>
                          <p className="text-[10px] text-gray-500">Teacher {cell.entry.teacherUserId.slice(0, 8)}</p>
                          {canManage && (
                            <button
                              type="button"
                              className="mt-1 text-xs text-red-600 hover:underline"
                              onClick={() => void removeLesson(cell.entry!)}
                            >
                              Remove
                            </button>
                          )}
                        </td>
                      ) : (
                        <td key={cell.key} className="border px-2 py-1 text-center text-xs text-gray-300">
                          —
                        </td>
                      ),
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {classId && sectionId && rows.length > 0 && (
          <p className="mt-3 text-xs text-gray-500">
            Showing {entries.length} live lesson{entries.length === 1 ? '' : 's'}.
          </p>
        )}
      </Card>
    </main>
  );
}