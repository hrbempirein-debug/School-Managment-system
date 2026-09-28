'use client';

import { useState } from 'react';
import Link from 'next/link';
import type {
  AcademicYear,
  AcdClass,
  Campus,
  ClassResponse,
  ClassSubject,
  ClassSubjectResponse,
  GradeLevel,
  Section,
  SectionResponse,
  Subject,
  TeacherAssignment,
  TeacherAssignmentResponse,
} from '@sms/contracts';
import { Button, Card } from '@sms/ui';
import { clientFetch } from '@/lib/http';
import {
  classStatusLabel,
  gradeLevelName,
  sectionStatusLabel,
} from '@/lib/classes';

interface ClassDetailProps {
  classId: string;
  initial: AcdClass;
  initialSections: Section[];
  sectionsTotal: number;
  campuses: Campus[];
  years: AcademicYear[];
  gradeLevels: GradeLevel[];
  subjects: Subject[];
  initialClassSubjects: ClassSubject[];
  teachers: { userId: string; fullName: string }[];
  initialTeacherAssignments: TeacherAssignment[];
  canRead: boolean;
  canUpdate: boolean;
  canDelete: boolean;
  canCreateSection: boolean;
  canUpdateSection: boolean;
  canDeleteSection: boolean;
  canManageClassSubjects: boolean;
  canManageTeacherAssignments: boolean;
}

const campusName = (campuses: Campus[], id: string) =>
  campuses.find((c) => c.id === id)?.name ?? '—';
const yearName = (years: AcademicYear[], id: string) =>
  years.find((y) => y.id === id)?.code ?? '—';
const subjectName = (subjects: Subject[], id: string) =>
  subjects.find((s) => s.id === id)?.code ?? '—';
const teacherName = (teachers: { userId: string; fullName: string }[], userId: string) =>
  teachers.find((t) => t.userId === userId)?.fullName ?? '—';
const attachedSubjectIds = (links: ClassSubject[]) => new Set(links.map((l) => l.subjectId));

export function ClassDetail({
  classId,
  initial,
  initialSections,
  sectionsTotal,
  campuses,
  years,
  gradeLevels,
  subjects,
  initialClassSubjects,
  teachers,
  initialTeacherAssignments,
  canRead,
  canUpdate,
  canDelete,
  canCreateSection,
  canUpdateSection,
  canDeleteSection,
  canManageClassSubjects,
  canManageTeacherAssignments,
}: ClassDetailProps) {
  const [klass, setKlass] = useState<AcdClass>(initial);
  const [sections, setSections] = useState<Section[]>(initialSections);
  const [sectionCode, setSectionCode] = useState('');
  const [classSubjects, setClassSubjects] = useState<ClassSubject[]>(initialClassSubjects);
  const [teacherAssignments, setTeacherAssignments] = useState<TeacherAssignment[]>(
    initialTeacherAssignments,
  );
  const [attachSubjectId, setAttachSubjectId] = useState('');
  const [teachUserId, setTeachUserId] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function fail(err: unknown) {
    setError(err instanceof Error ? err.message : 'Request failed');
    setMessage(null);
  }

  async function rename() {
    setError(null);
    setMessage(null);
    try {
      const res = await clientFetch<ClassResponse>(`/api/v1/classes/${classId}`, {
        method: 'PATCH',
        body: { name: klass.name },
        includeCsrf: true,
      });
      setKlass(res.class);
      setMessage('Class updated.');
    } catch (err) {
      fail(err);
    }
  }

  async function toggleStatus() {
    setError(null);
    setMessage(null);
    try {
      const action = klass.status === 'active' ? 'deactivate' : 'activate';
      const res = await clientFetch<ClassResponse>(`/api/v1/classes/${classId}/${action}`, {
        method: 'POST',
        includeCsrf: true,
      });
      setKlass(res.class);
      setMessage(`Class ${klass.status === 'active' ? 'deactivated' : 'activated'}.`);
    } catch (err) {
      fail(err);
    }
  }

  async function removeClass() {
    setError(null);
    setMessage(null);
    try {
      await clientFetch<ClassResponse>(`/api/v1/classes/${classId}`, {
        method: 'DELETE',
        includeCsrf: true,
      });
      setMessage('Class deleted.');
      window.location.href = '/school/classes';
    } catch (err) {
      fail(err);
    }
  }

  async function createSection() {
    if (!sectionCode.trim()) {
      setError('A section code is required');
      return;
    }
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const res = await clientFetch<SectionResponse>(`/api/v1/classes/${classId}/sections`, {
        method: 'POST',
        body: { code: sectionCode.trim() },
        includeCsrf: true,
      });
      setSections((prev) => [...prev, res.section]);
      setSectionCode('');
      setMessage(`Section "${res.section.code}" created.`);
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  }

  async function renameSection(section: Section, code: string) {
    setError(null);
    setMessage(null);
    try {
      const res = await clientFetch<SectionResponse>(`/api/v1/classes/${classId}/sections/${section.id}`, {
        method: 'PATCH',
        body: { code },
        includeCsrf: true,
      });
      setSections((prev) => prev.map((s) => (s.id === section.id ? res.section : s)));
      setMessage('Section updated.');
    } catch (err) {
      fail(err);
    }
  }

  async function toggleSection(section: Section) {
    setError(null);
    setMessage(null);
    try {
      const action = section.status === 'active' ? 'deactivate' : 'activate';
      const res = await clientFetch<SectionResponse>(
        `/api/v1/classes/${classId}/sections/${section.id}/${action}`,
        { method: 'POST', includeCsrf: true },
      );
      setSections((prev) => prev.map((s) => (s.id === section.id ? res.section : s)));
      setMessage(`Section ${section.status === 'active' ? 'deactivated' : 'activated'}.`);
    } catch (err) {
      fail(err);
    }
  }

  async function removeSection(section: Section) {
    setError(null);
    setMessage(null);
    try {
      await clientFetch<SectionResponse>(`/api/v1/classes/${classId}/sections/${section.id}`, {
        method: 'DELETE',
        includeCsrf: true,
      });
      setSections((prev) => prev.filter((s) => s.id !== section.id));
      setMessage(`Section "${section.code}" deleted.`);
    } catch (err) {
      fail(err);
    }
  }

  async function attachSubject() {
    if (!attachSubjectId) {
      setError('Choose a subject to attach');
      return;
    }
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const res = await clientFetch<ClassSubjectResponse>(
        `/api/v1/classes/${classId}/subjects/${encodeURIComponent(attachSubjectId)}`,
        { method: 'POST', includeCsrf: true },
      );
      setClassSubjects((prev) => [...prev, res.classSubject]);
      setAttachSubjectId('');
      setMessage(`Subject attached.`);
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  }

  async function detachSubject(subjectId: string) {
    setError(null);
    setMessage(null);
    try {
      await clientFetch<ClassSubjectResponse>(
        `/api/v1/classes/${classId}/subjects/${encodeURIComponent(subjectId)}`,
        { method: 'DELETE', includeCsrf: true },
      );
      setClassSubjects((prev) => prev.filter((l) => l.subjectId !== subjectId));
      setTeacherAssignments((prev) => prev.filter((a) => a.subjectId !== subjectId));
      setMessage('Subject detached.');
    } catch (err) {
      fail(err);
    }
  }

  async function assignTeacher(subjectId: string) {
    const teacherUserId = teachUserId[subjectId];
    if (!teacherUserId) {
      setError('Choose a teacher to assign');
      return;
    }
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const res = await clientFetch<TeacherAssignmentResponse>(
        `/api/v1/classes/${classId}/subjects/${encodeURIComponent(subjectId)}/teachers`,
        { method: 'POST', body: { teacherUserId }, includeCsrf: true },
      );
      setTeacherAssignments((prev) => [
        ...prev.filter((a) => a.subjectId !== subjectId),
        res.teacherAssignment,
      ]);
      setTeachUserId((prev) => ({ ...prev, [subjectId]: '' }));
      setMessage('Teacher assigned.');
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  }

  async function unassignTeacher(subjectId: string, teacherUserId: string) {
    setError(null);
    setMessage(null);
    try {
      await clientFetch<TeacherAssignmentResponse>(
        `/api/v1/classes/${classId}/subjects/${encodeURIComponent(subjectId)}/teachers/${encodeURIComponent(teacherUserId)}`,
        { method: 'DELETE', includeCsrf: true },
      );
      setTeacherAssignments((prev) =>
        prev.filter((a) => a.subjectId !== subjectId || a.teacherUserId !== teacherUserId),
      );
      setMessage('Teacher unassigned.');
    } catch (err) {
      fail(err);
    }
  }

  if (!canRead) {
    return (
      <main className="mx-auto max-w-3xl p-8">
        <Link href="/school/classes" className="text-sm text-blue-600 hover:underline">
          ← Classes
        </Link>
        <h1 className="mt-2 text-2xl font-semibold">Class</h1>
        <p className="mt-3 text-sm text-amber-600">Your role cannot view classes.</p>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-3xl p-8">
      <Link href="/school/classes" className="text-sm text-blue-600 hover:underline">
        ← Classes
      </Link>
      <h1 className="mt-2 text-2xl font-semibold">
        {klass.code} · {klass.name}
      </h1>
      <p className="mt-1 text-sm text-gray-600">
        {campusName(campuses, klass.campusId)} · {yearName(years, klass.academicYearId)} ·{' '}
        {gradeLevelName(gradeLevels, klass.gradeLevelId)} · {classStatusLabel(klass.status)}
      </p>

      {message && <p className="mt-3 text-sm text-green-600">{message}</p>}
      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}

      {canUpdate && (
        <Card className="mt-6">
          <h2 className="text-lg font-semibold">Class details</h2>
          <div className="mt-4 flex items-end gap-4">
            <label className="block flex-1">
              <span className="text-sm text-gray-600">Name</span>
              <input
                className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2"
                value={klass.name}
                onChange={(e) => setKlass({ ...klass, name: e.target.value })}
              />
            </label>
            <Button type="button" onClick={() => void rename()}>
              Save
            </Button>
            <Button type="button" variant="secondary" onClick={() => void toggleStatus()}>
              {klass.status === 'active' ? 'Deactivate' : 'Activate'}
            </Button>
            {canDelete && (
              <Button type="button" variant="danger" onClick={() => void removeClass()}>
                Delete
              </Button>
            )}
          </div>
          <p className="mt-3 text-xs text-gray-500">
            Campus and academic year are fixed after creation; relocation would break placed enrollments.
          </p>
        </Card>
      )}

      <Card className="mt-6">
        <h2 className="text-lg font-semibold">
          Sections <span className="text-sm font-normal text-gray-500">({sectionsTotal})</span>
        </h2>
        <p className="mt-1 text-xs text-gray-500">
          Sections group students within a class (e.g. A, B) and receive the placement roll numbers.
        </p>

        {canCreateSection && (
          <div className="mt-4 flex items-end gap-4">
            <label className="block flex-1">
              <span className="text-sm text-gray-600">New section code</span>
              <input
                className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2"
                value={sectionCode}
                onChange={(e) => setSectionCode(e.target.value)}
                placeholder="A"
              />
            </label>
            <Button type="button" disabled={busy} onClick={() => void createSection()}>
              Add section
            </Button>
          </div>
        )}

        <ul className="mt-4 space-y-2">
          {sections.map((section) => (
            <li key={section.id} className="flex items-center justify-between gap-4 rounded-md border p-3">
              <div className="min-w-0">
                <p className="text-sm font-medium">
                  {section.code} · {sectionStatusLabel(section.status)}
                </p>
                {canUpdateSection && (
                  <input
                    className="mt-1 w-full max-w-xs rounded-md border border-gray-300 px-2 py-1 text-sm"
                    defaultValue={section.code}
                    onBlur={(e) => {
                      if (e.target.value.trim() !== section.code) void renameSection(section, e.target.value.trim());
                    }}
                  />
                )}
              </div>
              <div className="flex shrink-0 gap-2">
                {canUpdateSection && (
                  <Button type="button" size="small" onClick={() => void toggleSection(section)}>
                    {section.status === 'active' ? 'Deactivate' : 'Activate'}
                  </Button>
                )}
                {canDeleteSection && (
                  <Button type="button" size="small" variant="danger" onClick={() => void removeSection(section)}>
                    Delete
                  </Button>
                )}
              </div>
            </li>
          ))}
          {sections.length === 0 && <li className="text-sm text-gray-500">No sections yet.</li>}
        </ul>
      </Card>

      <Card className="mt-6">
        <h2 className="text-lg font-semibold">
          Subjects &amp; Teachers{' '}
          <span className="text-sm font-normal text-gray-500">({classSubjects.length})</span>
        </h2>
        <p className="mt-1 text-xs text-gray-500">
          Subjects are attached from the tenant-wide catalog; each attached subject gets one lead
          teacher (an active membership with the teacher role).
        </p>

        {canManageClassSubjects && (
          <div className="mt-4 flex items-end gap-4">
            <label className="block flex-1">
              <span className="text-sm text-gray-600">Attach subject</span>
              <select
                className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2"
                value={attachSubjectId}
                onChange={(e) => setAttachSubjectId(e.target.value)}
              >
                <option value="">Choose a subject…</option>
                {subjects
                  .filter((s) => !attachedSubjectIds(classSubjects).has(s.id))
                  .map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.code} · {s.name}
                    </option>
                  ))}
              </select>
            </label>
            <Button type="button" disabled={busy} onClick={() => void attachSubject()}>
              Attach subject
            </Button>
          </div>
        )}

        <ul className="mt-4 space-y-2">
          {classSubjects.map((link) => {
            const teacher = teacherAssignments.find((a) => a.subjectId === link.subjectId);
            return (
              <li key={link.id} className="rounded-md border p-3">
                <div className="flex items-center justify-between gap-4">
                  <p className="text-sm font-medium">
                    {subjectName(subjects, link.subjectId)}
                    <span className="ml-2 text-xs text-gray-500">
                      teacher:{' '}
                      {teacher
                        ? teacherName(teachers, teacher.teacherUserId)
                        : 'unassigned'}
                    </span>
                  </p>
                  <div className="flex shrink-0 gap-2">
                    {canManageClassSubjects && (
                      <Button type="button" size="small" variant="danger" onClick={() => void detachSubject(link.subjectId)}>
                        Detach
                      </Button>
                    )}
                  </div>
                </div>

                {canManageTeacherAssignments && (
                  <div className="mt-3 flex items-end gap-4">
                    <label className="block flex-1">
                      <span className="text-sm text-gray-600">
                        {teacher ? 'Reassign teacher' : 'Assign teacher'}
                      </span>
                      <select
                        className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2"
                        value={teachUserId[link.subjectId] ?? ''}
                        onChange={(e) =>
                          setTeachUserId((prev) => ({ ...prev, [link.subjectId]: e.target.value }))
                        }
                      >
                        <option value="">Choose a teacher…</option>
                        {teachers.map((t) => (
                          <option key={t.userId} value={t.userId}>
                            {t.fullName}
                          </option>
                        ))}
                      </select>
                    </label>
                    <Button
                      type="button"
                      size="small"
                      disabled={busy}
                      onClick={() => void assignTeacher(link.subjectId)}
                    >
                      Assign
                    </Button>
                    {teacher && (
                      <Button
                        type="button"
                        size="small"
                        variant="danger"
                        onClick={() => void unassignTeacher(link.subjectId, teacher.teacherUserId)}
                      >
                        Unassign
                      </Button>
                    )}
                  </div>
                )}
              </li>
            );
          })}
          {classSubjects.length === 0 && (
            <li className="text-sm text-gray-500">No subjects attached yet.</li>
          )}
        </ul>
      </Card>
    </main>
  );
}