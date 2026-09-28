'use client';

import { useEffect, useState } from 'react';
import type { AdmissionApplication, AdmissionApplicationListResponse, AdmissionApplicationResponse, Student } from '@sms/contracts';
import { Button, Card } from '@sms/ui';
import { clientFetch } from '@/lib/http';
import {
  ADMISSION_STATUS_LABELS,
  canApproveAdmission,
  canRejectAdmission,
  canReviewAdmission,
  canSubmitAdmission,
  canWithdrawAdmission,
} from '@/lib/admissions';
import { formatDateTime } from '@/lib/format';
import type { DetailPermissions } from '../student-detail';

interface AdmissionsTabProps {
  studentId: string;
  student: Student;
  permissions: DetailPermissions;
}

export function AdmissionsTab({ studentId, student, permissions }: AdmissionsTabProps) {
  const { canReadAdmissions, canReviewAdmissions, canCreateAdmission } = permissions;

  const [applications, setApplications] = useState<AdmissionApplication[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // create form
  const [showCreate, setShowCreate] = useState(false);
  const [cno, setCno] = useState('');

  async function load() {
    setError(null);
    try {
      const res = await clientFetch<AdmissionApplicationListResponse>(
        '/api/v1/admission-applications?limit=100&offset=0',
      );
      setApplications(res.items.filter((a) => a.studentId === studentId));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load applications');
    }
  }

  useEffect(() => {
    if (canReadAdmissions) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [studentId, canReadAdmissions]);

  async function act(id: string, action: 'submit' | 'review' | 'approve' | 'reject' | 'withdraw') {
    setError(null);
    setMessage(null);
    if (action === 'approve' && !window.confirm('Approve this applicant? A new student record (status "applicant") will be materialized from the stored snapshot.')) return;
    if (action === 'reject' && !window.confirm('Reject this application?')) return;
    setBusy(true);
    try {
      const res = await clientFetch<AdmissionApplicationResponse>(`/api/v1/admission-applications/${encodeURIComponent(id)}/${action}`, {
        method: 'POST',
        includeCsrf: true,
      });
      setApplications((prev) => (prev ? prev.map((a) => (a.id === id ? res.application : a)) : prev));
      setMessage(`Application ${ADMISSION_STATUS_LABELS[res.application.status] ?? res.application.status}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Action failed');
    } finally {
      setBusy(false);
    }
  }

  async function createForStudent() {
    setError(null);
    setMessage(null);
    setBusy(true);
    try {
      const snapshot: Record<string, string> = {
        studentNo: student.studentNo,
        firstName: student.firstName,
        lastName: student.lastName,
      };
      if (student.dateOfBirth) snapshot.dateOfBirth = student.dateOfBirth;
      if (student.gender) snapshot.gender = student.gender;
      if (cno.trim() !== '') snapshot.campusCode = cno.trim();
      const res = await clientFetch<AdmissionApplicationResponse>('/api/v1/admission-applications', {
        method: 'POST',
        body: { snapshot, studentId },
        includeCsrf: true,
      });
      setApplications((prev) => (prev ? [res.application, ...prev] : [res.application]));
      setShowCreate(false);
      setCno('');
      setMessage('Application created in draft. Submit it to begin the admissions pipeline.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Create failed');
    } finally {
      setBusy(false);
    }
  }

  if (!canReadAdmissions) {
    return <Card><p className="text-sm text-gray-500">Your role cannot view admissions.</p></Card>;
  }

  return (
    <Card>
      <h2 className="text-lg font-semibold">Admissions</h2>
      {message && <p className="mt-3 text-sm text-green-600">{message}</p>}
      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}

      {canCreateAdmission && (
        <div className="mt-4 border-b border-gray-100 pb-4">
          <button
            type="button"
            className="text-sm text-blue-600 hover:underline"
            onClick={() => { setShowCreate((v) => !v); setError(null); setMessage(null); }}
          >
            {showCreate ? 'Cancel creating application' : 'Create an admission application for this student'}
          </button>
          {showCreate && (
            <div className="mt-3 space-y-3">
              <p className="text-xs text-gray-500">
                The application is created in <strong>draft</strong> from this student’s details and starts the admissions pipeline.
              </p>
              <label className="block sm:max-w-sm">
                <span className="text-xs text-gray-600">Campus code (optional)</span>
                <input className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm" value={cno} onChange={(e) => setCno(e.target.value)} />
              </label>
              <Button type="button" size="small" disabled={busy} onClick={() => void createForStudent()}>
                Create application
              </Button>
            </div>
          )}
        </div>
      )}

      {applications === null ? (
        <p className="mt-3 text-sm text-gray-500">Loading…</p>
      ) : applications.length === 0 ? (
        <p className="mt-3 text-sm text-gray-500">No admission applications for this student.</p>
      ) : (
        <ul className="mt-4 divide-y divide-gray-100">
          {applications.map((app) => (
            <li key={app.id} className="py-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium">{ADMISSION_STATUS_LABELS[app.status] ?? app.status}</p>
                  <p className="text-xs text-gray-500">
                    Applied as {app.snapshot.firstName} {app.snapshot.lastName} · created {formatDateTime(app.createdAt)}
                  </p>
                </div>
                {canReviewAdmissions && (
                  <div className="flex shrink-0 flex-wrap items-center gap-2">
                    {canSubmitAdmission(app.status) && (
                      <Button type="button" size="small" disabled={busy} onClick={() => void act(app.id, 'submit')}>
                        Submit
                      </Button>
                    )}
                    {canReviewAdmission(app.status) && (
                      <Button type="button" size="small" disabled={busy} onClick={() => void act(app.id, 'review')}>
                        Under review
                      </Button>
                    )}
                    {canApproveAdmission(app.status) && (
                      <Button type="button" size="small" disabled={busy} onClick={() => void act(app.id, 'approve')}>
                        Approve
                      </Button>
                    )}
                    {canRejectAdmission(app.status) && (
                      <Button type="button" size="small" variant="danger" disabled={busy} onClick={() => void act(app.id, 'reject')}>
                        Reject
                      </Button>
                    )}
                    {canWithdrawAdmission(app.status) && (
                      <Button type="button" size="small" variant="secondary" disabled={busy} onClick={() => void act(app.id, 'withdraw')}>
                        Withdraw
                      </Button>
                    )}
                    {['accepted', 'rejected', 'withdrawn'].includes(app.status) && (
                      <span className="text-xs text-gray-400">closed</span>
                    )}
                  </div>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}