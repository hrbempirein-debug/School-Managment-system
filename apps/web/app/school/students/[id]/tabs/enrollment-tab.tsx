'use client';

import { useEffect, useState } from 'react';
import type {
  AcademicYear,
  AcademicYearListResponse,
  AcdClass,
  ClassListResponse,
  Enrollment,
  EnrollmentListResponse,
  Placement,
  PlacementResponse,
  Section,
  SectionListResponse,
} from '@sms/contracts';
import { Button, Card } from '@sms/ui';
import { clientFetch } from '@/lib/http';
import { formatDateTime } from '@/lib/format';
import { classDescriptor, sectionStatusLabel, classStatusLabel } from '@/lib/classes';
import type { DetailPermissions } from '../student-detail';

const ENROLLMENT_STATUS_LABELS: Record<string, string> = {
  active: 'Active',
  withdrawn: 'Withdrawn',
  completed: 'Completed',
};

interface EnrollmentTabProps {
  studentId: string;
  permissions: DetailPermissions;
}

export function EnrollmentTab({ studentId, permissions }: EnrollmentTabProps) {
  const [enrollments, setEnrollments] = useState<Enrollment[] | null>(null);
  const [years, setYears] = useState<Record<string, AcademicYear>>({});
  const [classes, setClasses] = useState<Record<string, AcdClass[]>>({});
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      try {
        const yearName: Record<string, AcademicYear> = {};
        if (permissions.canReadYears) {
          const yearRes = await clientFetch<AcademicYearListResponse>('/api/v1/academic-years?limit=100&offset=0');
          for (const y of yearRes.items) yearName[y.id] = y;
        }
        setYears(yearName);
        const res = await clientFetch<EnrollmentListResponse>(`/api/v1/enrollments?studentId=${encodeURIComponent(studentId)}&limit=100&offset=0`);
        setEnrollments(res.items);

        if (permissions.canReadPlacement) {
          const byYear: Record<string, AcdClass[]> = {};
          for (const enrollment of res.items) {
            if (byYear[enrollment.academicYearId]) continue;
            const klassRes = await clientFetch<ClassListResponse>(
              `/api/v1/classes?academicYearId=${encodeURIComponent(enrollment.academicYearId)}&limit=100&offset=0`,
            );
            byYear[enrollment.academicYearId] = klassRes.items;
          }
          setClasses(byYear);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not load enrollment history');
      }
    }
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [studentId]);

  return (
    <Card>
      <h2 className="text-lg font-semibold">Enrollment &amp; placement</h2>
      <p className="mt-1 text-xs text-gray-500">
        Enrollment links a student to an academic year; placement puts the enrollment into a class and section with a
        roll number.
      </p>
      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}

      {enrollments === null ? (
        <p className="mt-3 text-sm text-gray-500">Loading…</p>
      ) : enrollments.length === 0 ? (
        <p className="mt-3 text-sm text-gray-500">This student has no enrollment history yet.</p>
      ) : (
        <ul className="mt-4 divide-y divide-gray-100">
          {enrollments.map((enrollment) => {
            const year = years[enrollment.academicYearId];
            return (
              <li key={enrollment.id} className="py-3">
                <div className="flex items-center justify-between gap-4">
                  <div className="min-w-0">
                    <p className="text-sm font-medium">{year ? year.name : 'Academic year'}</p>
                    <p className="text-xs text-gray-500">
                      {ENROLLMENT_STATUS_LABELS[enrollment.status] ?? enrollment.status} · since{' '}
                      {formatDateTime(enrollment.createdAt)}
                    </p>
                  </div>
                  <span className="shrink-0 text-xs uppercase tracking-wide text-gray-400">
                    {ENROLLMENT_STATUS_LABELS[enrollment.status] ?? enrollment.status}
                  </span>
                </div>
                <PlacementRow
                  enrollment={enrollment}
                  yearClasses={classes[enrollment.academicYearId]}
                  canReadPlacement={permissions.canReadPlacement}
                  canManagePlacement={permissions.canManagePlacement}
                />
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

function PlacementRow({
  enrollment,
  yearClasses,
  canReadPlacement,
  canManagePlacement,
}: {
  enrollment: Enrollment;
  yearClasses?: AcdClass[];
  canReadPlacement: boolean;
  canManagePlacement: boolean;
}) {
  const [placement, setPlacement] = useState<Placement | null>(null);
  const [classId, setClassId] = useState('');
  const [sectionId, setSectionId] = useState('');
  const [rollNo, setRollNo] = useState('');
  const [sections, setSections] = useState<Record<string, Section[]>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    async function load() {
      try {
        const res = await clientFetch<PlacementResponse>(`/api/v1/enrollments/${enrollment.id}/placement`);
        if (!active) return;
        setPlacement(res.placement);
        if (res.placement.classId) setClassId(res.placement.classId);
        if (res.placement.sectionId) setSectionId(res.placement.sectionId);
        setRollNo(res.placement.rollNo ?? '');
      } catch {
        // leave placement null: read may be unavailable
        if (active) setError('Could not load placement');
      }
    }
    if (canReadPlacement) void load();
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enrollment.id]);

  async function loadSections(klassId: string) {
    if (sections[klassId]) return;
    setError(null);
    try {
      const res = await clientFetch<SectionListResponse>(
        `/api/v1/classes/${encodeURIComponent(klassId)}/sections?limit=100&offset=0`,
      );
      setSections((prev) => ({ ...prev, [klassId]: res.items }));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load sections');
    }
  }

  async function assign() {
    if (!classId || !sectionId) {
      setError('Pick a class and a section');
      return;
    }
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const res = await clientFetch<PlacementResponse>(`/api/v1/enrollments/${enrollment.id}/placement`, {
        method: 'POST',
        body: { classId, sectionId, rollNo: rollNo.trim() || undefined },
        includeCsrf: true,
      });
      setPlacement(res.placement);
      setMessage(res.placement.classId ? 'Placement saved.' : 'Placement cleared.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Placement failed');
    } finally {
      setBusy(false);
    }
  }

  async function unassign() {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const res = await clientFetch<PlacementResponse>(`/api/v1/enrollments/${enrollment.id}/placement`, {
        method: 'DELETE',
        includeCsrf: true,
      });
      setPlacement(res.placement);
      setClassId('');
      setSectionId('');
      setRollNo('');
      setMessage('Placement cleared.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not clear placement');
    } finally {
      setBusy(false);
    }
  }

  const placedClass = placement?.classId ? yearClasses?.find((c) => c.id === placement.classId) : undefined;
  const placedSection = placement?.sectionId ? sections[placedClass?.id ?? '']?.find((s) => s.id === placement.sectionId) : undefined;

  if (!canReadPlacement && !canManagePlacement) return null;

  return (
    <div className="mt-2 rounded-md border border-dashed border-gray-200 bg-gray-50 p-3">
      <p className="text-xs font-medium uppercase tracking-wide text-gray-400">Placement</p>
      {canReadPlacement && placement ? (
        <p className="mt-1 text-sm">
          {classDescriptor(placedClass, placedSection)}
          {placement.rollNo ? ` · Roll no. ${placement.rollNo}` : ''}
        </p>
      ) : (
        <p className="mt-1 text-sm text-gray-500">Placement not available to this role.</p>
      )}

      {message && <p className="mt-2 text-xs text-green-600">{message}</p>}
      {error && <p className="mt-2 text-xs text-red-600">{error}</p>}

      {canManagePlacement && (
        <div className="mt-3 grid gap-3 sm:grid-cols-3">
          <label className="block">
            <span className="text-xs text-gray-600">Class</span>
            <select
              className="mt-1 w-full rounded-md border border-gray-300 px-2 py-1.5 text-sm"
              value={classId}
              onChange={(e) => {
                setClassId(e.target.value);
                setSectionId('');
                void loadSections(e.target.value);
              }}
            >
              <option value="">— pick class —</option>
              {(yearClasses ?? []).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.code} · {classStatusLabel(c.status)}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="text-xs text-gray-600">Section</span>
            <select
              className="mt-1 w-full rounded-md border border-gray-300 px-2 py-1.5 text-sm"
              value={sectionId}
              onChange={(e) => setSectionId(e.target.value)}
              disabled={!classId}
            >
              <option value="">— pick section —</option>
              {(sections[classId] ?? []).map((s) => (
                <option key={s.id} value={s.id}>
                  {s.code} · {sectionStatusLabel(s.status)}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="text-xs text-gray-600">Roll no.</span>
            <input
              className="mt-1 w-full rounded-md border border-gray-300 px-2 py-1.5 text-sm"
              value={rollNo}
              onChange={(e) => setRollNo(e.target.value)}
              placeholder="R-1"
            />
          </label>
        </div>
      )}

      {canManagePlacement && (
        <div className="mt-3 flex gap-2">
          <Button type="button" size="small" disabled={busy} onClick={() => void assign()}>
            Assign / update
          </Button>
          <Button type="button" size="small" variant="secondary" disabled={busy} onClick={() => void unassign()}>
            Clear
          </Button>
        </div>
      )}
    </div>
  );
}