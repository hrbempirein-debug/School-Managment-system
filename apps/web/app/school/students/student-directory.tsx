'use client';

import { useState } from 'react';
import Link from 'next/link';
import type { Campus, Student, StudentListResponse, StudentResponse } from '@sms/contracts';
import { Button, Card } from '@sms/ui';
import { clientFetch, downloadViaCredentials } from '@/lib/http';
import { STUDENT_STATUS_ORDER, genderLabel, studentStatusLabel } from '@/lib/students';
import { formatIsoDate } from '@/lib/format';

const PAGE_SIZE = 50;

interface StudentDirectoryProps {
  initial: Student[];
  initialTotal: number;
  campuses: Campus[];
  canRead: boolean;
  canCreate: boolean;
  canUpdate: boolean;
  canDelete: boolean;
  canExport: boolean;
  canReadCampuses: boolean;
}

export function StudentDirectory({ initial, initialTotal, campuses, canRead, canCreate, canExport, canReadCampuses }: StudentDirectoryProps) {
  const [items, setItems] = useState<Student[]>(initial);
  const [total, setTotal] = useState(initialTotal);
  const [offset, setOffset] = useState(0);
  const [q, setQ] = useState('');
  const [applied, setApplied] = useState('');
  const [status, setStatus] = useState('');
  const [campusId, setCampusId] = useState('');
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // create form
  const [studentNo, setStudentNo] = useState('');
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [dob, setDob] = useState('');
  const [gender, setGender] = useState('');
  const [newCampusId, setNewCampusId] = useState('');
  const [busy, setBusy] = useState(false);

  function filterParams(): URLSearchParams {
    const params = new URLSearchParams();
    if (applied.trim() !== '') params.set('q', applied.trim());
    if (status !== '') params.set('status', status);
    if (campusId !== '') params.set('campusId', campusId);
    return params;
  }

  function buildQuery(nextOffset: number) {
    const params = filterParams();
    params.set('limit', String(PAGE_SIZE));
    params.set('offset', String(nextOffset));
    return params.toString();
  }

  async function load(nextOffset: number) {
    setLoading(true);
    setError(null);
    setMessage(null);
    try {
      const res = await clientFetch<StudentListResponse>(`/api/v1/students?${buildQuery(nextOffset)}`);
      setItems(res.items);
      setTotal(res.total);
      setOffset(nextOffset);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Request failed');
    } finally {
      setLoading(false);
    }
  }

  function applyFilters() {
    setApplied(q);
    void load(0);
  }

  function changeStatus(next: string) {
    setStatus(next);
    void load(0);
  }

  function changeCampus(next: string) {
    setCampusId(next);
    void load(0);
  }

  async function create() {
    setError(null);
    setMessage(null);
    if (!studentNo.trim() || !firstName.trim() || !lastName.trim()) {
      setError('Student number, first name and last name are required');
      return;
    }
    setBusy(true);
    try {
      const body: Record<string, string> = {
        studentNo: studentNo.trim(),
        firstName: firstName.trim(),
        lastName: lastName.trim(),
      };
      if (dob !== '') body.dateOfBirth = dob;
      if (gender !== '') body.gender = gender;
      if (canReadCampuses && newCampusId !== '') body.primaryCampusId = newCampusId;
      const res = await clientFetch<StudentResponse>('/api/v1/students', { method: 'POST', body, includeCsrf: true });
      setItems((prev) => [res.student, ...prev]);
      setTotal((t) => t + 1);
      setStudentNo('');
      setFirstName('');
      setLastName('');
      setDob('');
      setGender('');
      setNewCampusId('');
      setMessage(`Student "${res.student.firstName} ${res.student.lastName}" created.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Request failed');
    } finally {
      setBusy(false);
    }
  }

  async function exportCsv() {
    setError(null);
    setMessage(null);
    try {
      await downloadViaCredentials(`/api/v1/students/export?${filterParams().toString()}`, 'students-export.csv');
      setMessage('Student export downloaded.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Export failed');
    }
  }

  if (!canRead) {
    return (
      <main className="mx-auto max-w-3xl p-8">
        <Link href="/school" className="text-sm text-blue-600 hover:underline">
          ← School
        </Link>
        <h1 className="mt-2 text-2xl font-semibold">Students</h1>
        <p className="mt-3 text-sm text-amber-600">Your role cannot view students.</p>
      </main>
    );
  }

  const page = Math.floor(offset / PAGE_SIZE) + 1;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <main className="mx-auto max-w-5xl p-8">
      <Link href="/school" className="text-sm text-blue-600 hover:underline">
        ← School
      </Link>
      <div className="mt-2 flex items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold">Students</h1>
        <Link href="/school/imports" className="text-sm text-blue-600 hover:underline">
          Bulk import wizard →
        </Link>
      </div>

      {message && <p className="mt-3 text-sm text-green-600">{message}</p>}
      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}

      <Card className="mt-6">
        <h2 className="text-lg font-semibold">Search &amp; filter</h2>
        <div className="mt-4 grid gap-4 sm:grid-cols-4">
          <label className="block sm:col-span-2">
            <span className="text-sm text-gray-600">Search name</span>
            <input
              className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') applyFilters();
              }}
            />
          </label>
          <label className="block">
            <span className="text-sm text-gray-600">Status</span>
            <select className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2" value={status} onChange={(e) => changeStatus(e.target.value)}>
              <option value="">All</option>
              {STUDENT_STATUS_ORDER.map((s) => (
                <option key={s} value={s}>
                  {studentStatusLabel(s)}
                </option>
              ))}
            </select>
          </label>
          {canReadCampuses && campuses.length > 0 ? (
            <label className="block">
              <span className="text-sm text-gray-600">Campus</span>
              <select className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2" value={campusId} onChange={(e) => changeCampus(e.target.value)}>
                <option value="">All</option>
                {campuses.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <div />
          )}
        </div>
        <div className="mt-4 flex gap-3">
          <Button type="button" onClick={() => void applyFilters()}>
            Apply
          </Button>
          {canExport && (
            <Button type="button" onClick={() => void exportCsv()}>
              Export CSV
            </Button>
          )}
        </div>
      </Card>

      {canCreate && (
        <Card className="mt-6">
          <h2 className="text-lg font-semibold">New student</h2>
          <div className="mt-4 grid gap-4 sm:grid-cols-6">
            <label className="block">
              <span className="text-sm text-gray-600">Student no.</span>
              <input className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2" value={studentNo} onChange={(e) => setStudentNo(e.target.value)} />
            </label>
            <label className="block">
              <span className="text-sm text-gray-600">First name</span>
              <input className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2" value={firstName} onChange={(e) => setFirstName(e.target.value)} />
            </label>
            <label className="block">
              <span className="text-sm text-gray-600">Last name</span>
              <input className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2" value={lastName} onChange={(e) => setLastName(e.target.value)} />
            </label>
            <label className="block">
              <span className="text-sm text-gray-600">Date of birth</span>
              <input type="date" className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2" value={dob} onChange={(e) => setDob(e.target.value)} />
            </label>
            <label className="block">
              <span className="text-sm text-gray-600">Gender</span>
              <select className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2" value={gender} onChange={(e) => setGender(e.target.value)}>
                <option value="">—</option>
                <option value="male">Male</option>
                <option value="female">Female</option>
                <option value="other">Other</option>
              </select>
            </label>
            {canReadCampuses && campuses.length > 0 && (
              <label className="block">
                <span className="text-sm text-gray-600">Campus</span>
                <select className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2" value={newCampusId} onChange={(e) => setNewCampusId(e.target.value)}>
                  <option value="">—</option>
                  {campuses.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
          <div className="mt-4">
            <Button type="button" disabled={busy} onClick={() => void create()}>
              Create student
            </Button>
          </div>
        </Card>
      )}

      <Card className="mt-6">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">
            Student list <span className="text-sm font-normal text-gray-500">({total})</span>
          </h2>
          {loading && <p className="text-xs text-gray-500">Loading…</p>}
        </div>
        <ul className="mt-4 divide-y divide-gray-100">
          {items.map((student) => (
            <li key={student.id} className="flex items-center justify-between gap-4 py-3">
              <div className="min-w-0">
                <Link href={`/school/students/${student.id}`} className="text-sm font-medium text-blue-600 hover:underline">
                  {student.firstName} {student.lastName}
                </Link>
                <p className="text-xs text-gray-500">
                  {student.studentNo} · {studentStatusLabel(student.status)} · {genderLabel(student.gender)} · born{' '}
                  {formatIsoDate(student.dateOfBirth)}
                </p>
              </div>
              <Link href={`/school/students/${student.id}`} className="shrink-0 text-sm text-gray-600 hover:underline">
                View →
              </Link>
            </li>
          ))}
          {items.length === 0 && <li className="py-3 text-sm text-gray-500">No students match.</li>}
        </ul>
        {pages > 1 && (
          <div className="mt-4 flex items-center justify-between">
            <Button type="button" size="small" disabled={offset <= 0} onClick={() => void load(Math.max(0, offset - PAGE_SIZE))}>
              ← Prev
            </Button>
            <span className="text-xs text-gray-500">
              Page {page} of {pages}
            </span>
            <Button type="button" size="small" disabled={offset + PAGE_SIZE >= total} onClick={() => void load(offset + PAGE_SIZE)}>
              Next →
            </Button>
          </div>
        )}
      </Card>
    </main>
  );
}