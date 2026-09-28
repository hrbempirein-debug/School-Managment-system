'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { AcademicYear, AcademicYearListResponse, EnrollmentResponse, Student, StudentResponse, TransferResponse } from '@sms/contracts';
import { Button, Card } from '@sms/ui';
import { clientFetch } from '@/lib/http';
import { genderLabel, studentStatusLabel } from '@/lib/students';
import { formatIsoDate, formatDateTime } from '@/lib/format';
import { STUDENT_STATUS_LABELS } from '@/lib/students';
import type { DetailPermissions } from '../student-detail';

interface OverviewTabProps {
  student: Student;
  onStudentChange: (student: Student) => void;
  permissions: DetailPermissions;
}

export function OverviewTab({ student, onStudentChange, permissions }: OverviewTabProps) {
  const router = useRouter();
  const { canUpdate, canDelete, canManageEnrollment, canReadYears } = permissions;

  const [editing, setEditing] = useState(false);
  const [studentNo, setStudentNo] = useState(student.studentNo);
  const [firstName, setFirstName] = useState(student.firstName);
  const [lastName, setLastName] = useState(student.lastName);
  const [dob, setDob] = useState(student.dateOfBirth ?? '');
  const [gender, setGender] = useState(student.gender ?? '');
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // enrollment/transfer/graduate
  const [years, setYears] = useState<AcademicYear[] | null>(null);
  const [selectedYearId, setSelectedYearId] = useState('');
  const [showTransfer, setShowTransfer] = useState(false);
  const [toSchoolName, setToSchoolName] = useState('');
  const [reason, setReason] = useState('');
  const [transferredOn, setTransferredOn] = useState('');

  async function loadYears() {
    if (years !== null) return;
    setYears([]);
    try {
      const res = await clientFetch<AcademicYearListResponse>('/api/v1/academic-years?limit=100&offset=0');
      setYears(res.items);
      if (res.items.length === 1) setSelectedYearId(res.items[0]!.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load academic years');
    }
  }

  async function save() {
    setError(null);
    setMessage(null);
    if (!studentNo.trim() || !firstName.trim() || !lastName.trim()) {
      setError('Student number, first name and last name are required');
      return;
    }
    setBusy(true);
    try {
      const body: Record<string, string> = { studentNo: studentNo.trim(), firstName: firstName.trim(), lastName: lastName.trim() };
      if (dob !== '') body.dateOfBirth = dob;
      if (gender !== '') body.gender = gender;
      const res = await clientFetch<StudentResponse>(`/api/v1/students/${student.id}`, { method: 'PATCH', body, includeCsrf: true });
      onStudentChange(res.student);
      setEditing(false);
      setMessage('Student updated.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Update failed');
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!window.confirm('Delete this student? The student record is soft-deleted for audit purposes.')) return;
    setError(null);
    setMessage(null);
    try {
      await clientFetch<void>(`/api/v1/students/${student.id}`, { method: 'DELETE', includeCsrf: true });
      router.push('/school/students');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Delete failed');
    }
  }

  async function enroll() {
    setError(null);
    setMessage(null);
    if (!selectedYearId) {
      setError('Select an academic year to enroll into');
      return;
    }
    setBusy(true);
    try {
      await clientFetch<EnrollmentResponse>(`/api/v1/students/${student.id}/enroll`, {
        method: 'POST',
        body: { academicYearId: selectedYearId },
        includeCsrf: true,
      });
      onStudentChange({ ...student, status: 'active' });
      setMessage('Student enrolled.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Enrollment failed');
    } finally {
      setBusy(false);
    }
  }

  async function transfer() {
    setError(null);
    setMessage(null);
    setBusy(true);
    try {
      const body: Record<string, string> = {};
      if (toSchoolName.trim() !== '') body.toSchoolName = toSchoolName.trim();
      if (reason.trim() !== '') body.reason = reason.trim();
      if (transferredOn !== '') body.transferredOn = transferredOn;
      await clientFetch<TransferResponse>(`/api/v1/students/${student.id}/transfer`, { method: 'POST', body, includeCsrf: true });
      onStudentChange({ ...student, status: 'transferred' });
      setShowTransfer(false);
      setToSchoolName('');
      setReason('');
      setTransferredOn('');
      setMessage('Student marked as transferred.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Transfer failed');
    } finally {
      setBusy(false);
    }
  }

  async function graduate() {
    setError(null);
    setMessage(null);
    setBusy(true);
    try {
      const res = await clientFetch<StudentResponse>(`/api/v1/students/${student.id}/graduate`, { method: 'POST', includeCsrf: true });
      onStudentChange(res.student);
      setMessage('Student marked as graduated.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Graduation failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <Card>
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Details</h2>
          {canUpdate && !editing && (
            <Button type="button" size="small" onClick={() => { setEditing(true); setError(null); setMessage(null); }}>
              Edit
            </Button>
          )}
        </div>

        {message && <p className="mt-3 text-sm text-green-600">{message}</p>}
        {error && <p className="mt-3 text-sm text-red-600">{error}</p>}

        {!editing ? (
          <dl className="mt-4 grid gap-3 sm:grid-cols-2">
            <div>
              <dt className="text-xs text-gray-500">Student number</dt>
              <dd className="text-sm">{student.studentNo}</dd>
            </div>
            <div>
              <dt className="text-xs text-gray-500">Status</dt>
              <dd className="text-sm">{STUDENT_STATUS_LABELS[student.status] ?? student.status}</dd>
            </div>
            <div>
              <dt className="text-xs text-gray-500">First name</dt>
              <dd className="text-sm">{student.firstName}</dd>
            </div>
            <div>
              <dt className="text-xs text-gray-500">Last name</dt>
              <dd className="text-sm">{student.lastName}</dd>
            </div>
            <div>
              <dt className="text-xs text-gray-500">Date of birth</dt>
              <dd className="text-sm">{formatIsoDate(student.dateOfBirth)}</dd>
            </div>
            <div>
              <dt className="text-xs text-gray-500">Gender</dt>
              <dd className="text-sm">{genderLabel(student.gender)}</dd>
            </div>
            <div>
              <dt className="text-xs text-gray-500">Created</dt>
              <dd className="text-sm">{formatDateTime(student.createdAt)}</dd>
            </div>
            <div>
              <dt className="text-xs text-gray-500">Updated</dt>
              <dd className="text-sm">{formatDateTime(student.updatedAt)}</dd>
            </div>
          </dl>
        ) : (
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
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
            <div className="flex items-end gap-3">
              <Button type="button" disabled={busy} onClick={() => void save()}>
                Save
              </Button>
              <Button type="button" variant="secondary" onClick={() => setEditing(false)}>
                Cancel
              </Button>
            </div>
          </div>
        )}
      </Card>

      {canManageEnrollment && (
        <Card>
          <h2 className="text-lg font-semibold">Lifecycle</h2>
          <p className="mt-1 text-xs text-gray-500">Current status: {studentStatusLabel(student.status)}</p>

          {student.status === 'applicant' && (
            <div className="mt-4">
              <button type="button" className="text-sm text-blue-600 hover:underline" onClick={() => void loadYears()}>
                Enroll this applicant into an academic year
              </button>
              {years !== null && (
                <div className="mt-3 flex items-end gap-3">
                  <label className="block">
                    <span className="text-sm text-gray-600">Academic year</span>
                    <select
                      className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2"
                      value={selectedYearId}
                      onChange={(e) => setSelectedYearId(e.target.value)}
                    >
                      <option value="">—</option>
                      {years.map((y) => (
                        <option key={y.id} value={y.id}>
                          {y.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  {!canReadYears && <p className="text-xs text-gray-500">(year names unavailable)</p>}
                  <Button type="button" size="small" disabled={busy} onClick={() => void enroll()}>
                    Enroll
                  </Button>
                </div>
              )}
            </div>
          )}

          {student.status === 'active' && (
            <div className="mt-4 space-y-3">
              <div className="flex gap-3">
                <Button type="button" size="small" disabled={busy} onClick={() => void graduate()}>
                  Mark graduated
                </Button>
                <Button type="button" size="small" onClick={() => { setShowTransfer((v) => !v); setError(null); setMessage(null); }}>
                  {showTransfer ? 'Cancel transfer' : 'Transfer out'}
                </Button>
              </div>
              {showTransfer && (
                <div className="grid gap-3 sm:grid-cols-3">
                  <label className="block">
                    <span className="text-xs text-gray-600">To school</span>
                    <input className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm" value={toSchoolName} onChange={(e) => setToSchoolName(e.target.value)} />
                  </label>
                  <label className="block">
                    <span className="text-xs text-gray-600">Reason</span>
                    <input className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm" value={reason} onChange={(e) => setReason(e.target.value)} />
                  </label>
                  <label className="block">
                    <span className="text-xs text-gray-600">Transferred on</span>
                    <input type="date" className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm" value={transferredOn} onChange={(e) => setTransferredOn(e.target.value)} />
                  </label>
                  <div>
                    <Button type="button" size="small" disabled={busy} onClick={() => void transfer()}>
                      Confirm transfer
                    </Button>
                  </div>
                </div>
              )}
            </div>
          )}

          {['transferred', 'graduated', 'alumni'].includes(student.status) && (
            <p className="mt-3 text-sm text-gray-500">
              This student&apos;s lifecycle status is terminal ({studentStatusLabel(student.status)}).
            </p>
          )}
        </Card>
      )}

      {canDelete && (
        <Card>
          <h2 className="text-lg font-semibold text-red-700">Danger zone</h2>
          <p className="mt-1 text-xs text-gray-500">
            Deleting a student removes it from the directory (soft delete, audited). Guardian links and documents are kept on record.
          </p>
          <div className="mt-3">
            <Button type="button" variant="danger" onClick={() => void remove()}>
              Delete student
            </Button>
          </div>
        </Card>
      )}

      <p>
        <Link href="/school/students" className="text-sm text-blue-600 hover:underline">
          ← Back to students
        </Link>
      </p>
    </div>
  );
}