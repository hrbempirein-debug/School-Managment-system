'use client';

import { useState } from 'react';
import Link from 'next/link';
import type { AdmissionApplication, AdmissionApplicationListResponse, AdmissionApplicationResponse } from '@sms/contracts';
import { Button, Card } from '@sms/ui';
import { clientFetch } from '@/lib/http';
import {
  ADMISSION_STATUS_LABELS,
  ADMISSION_STATUS_ORDER,
  canApproveAdmission,
  canRejectAdmission,
  canReviewAdmission,
  canSubmitAdmission,
  canWithdrawAdmission,
} from '@/lib/admissions';
import { formatDateTime } from '@/lib/format';

interface AdmissionsPipelineProps {
  initial: AdmissionApplication[];
  initialTotal: number;
  canRead: boolean;
  canCreate: boolean;
  canReview: boolean;
}

export function AdmissionsPipeline({ initial, initialTotal, canRead, canCreate, canReview }: AdmissionsPipelineProps) {
  const [items, setItems] = useState<AdmissionApplication[]>(initial);
  const [total, setTotal] = useState(initialTotal);
  const [status, setStatus] = useState('');
  const [q, setQ] = useState('');
  const [applied, setApplied] = useState('');
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // create form
  const [showCreate, setShowCreate] = useState(false);
  const [cno, setCno] = useState('');
  const [cfirstName, setCfirstName] = useState('');
  const [clastName, setClastName] = useState('');
  const [cdob, setCdob] = useState('');
  const [cgender, setCgender] = useState('');
  const [ccanpus, setCcampus] = useState('');
  const [cappliedOn, setCappliedOn] = useState('');

  async function loadInit(nextStatus: string, nextQ: string) {
    setLoading(true);
    setError(null);
    setMessage(null);
    try {
      const params = new URLSearchParams();
      params.set('limit', '100');
      params.set('offset', '0');
      if (nextStatus !== '') params.set('status', nextStatus);
      if (nextQ.trim() !== '') params.set('q', nextQ.trim());
      const res = await clientFetch<AdmissionApplicationListResponse>(`/api/v1/admission-applications?${params.toString()}`);
      setItems(res.items);
      setTotal(res.total);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Request failed');
    } finally {
      setLoading(false);
    }
  }

  async function create() {
    setError(null);
    setMessage(null);
    if (!cno.trim() || !cfirstName.trim() || !clastName.trim()) {
      setError('Student number, first name and last name are required');
      return;
    }
    setBusy(true);
    try {
      const snapshot: Record<string, string> = {
        studentNo: cno.trim(),
        firstName: cfirstName.trim(),
        lastName: clastName.trim(),
      };
      if (cdob !== '') snapshot.dateOfBirth = cdob;
      if (cgender !== '') snapshot.gender = cgender;
      if (ccanpus.trim() !== '') snapshot.campusCode = ccanpus.trim();
      const body: Record<string, unknown> = { snapshot };
      if (cappliedOn !== '') body.appliedOn = cappliedOn;
      const res = await clientFetch<AdmissionApplicationResponse>('/api/v1/admission-applications', {
        method: 'POST',
        body,
        includeCsrf: true,
      });
      setItems((prev) => [res.application, ...prev]);
      setTotal((t) => t + 1);
      setShowCreate(false);
      setCno('');
      setCfirstName('');
      setClastName('');
      setCdob('');
      setCgender('');
      setCcampus('');
      setCappliedOn('');
      setMessage('Admission application created in draft.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Create failed');
    } finally {
      setBusy(false);
    }
  }

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
      setItems((prev) => prev.map((a) => (a.id === id ? res.application : a)));
      setMessage(`Application ${ADMISSION_STATUS_LABELS[res.application.status] ?? res.application.status}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Action failed');
    } finally {
      setBusy(false);
    }
  }

  if (!canRead) {
    return (
      <main className="mx-auto max-w-3xl p-8">
        <Link href="/school" className="text-sm text-blue-600 hover:underline">
          ← School
        </Link>
        <h1 className="mt-2 text-2xl font-semibold">Admissions</h1>
        <p className="mt-3 text-sm text-amber-600">Your role cannot view admissions.</p>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-5xl p-8">
      <Link href="/school" className="text-sm text-blue-600 hover:underline">
        ← School
      </Link>
      <h1 className="mt-2 text-2xl font-semibold">Admissions pipeline</h1>

      {message && <p className="mt-3 text-sm text-green-600">{message}</p>}
      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}

      <Card className="mt-6">
        <h2 className="text-lg font-semibold">Filter</h2>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <label className="block">
            <span className="text-sm text-gray-600">Status</span>
            <select className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2" value={status} onChange={(e) => { setStatus(e.target.value); void loadInit(e.target.value, applied); }}>
              <option value="">All</option>
              {ADMISSION_STATUS_ORDER.map((s) => (
                <option key={s} value={s}>
                  {ADMISSION_STATUS_LABELS[s]}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="text-sm text-gray-600">Search applicant</span>
            <div className="mt-1 flex gap-2">
              <input
                className="w-full rounded-md border border-gray-300 px-3 py-2"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    setApplied(q);
                    void loadInit(status, q);
                  }
                }}
              />
              <Button type="button" size="small" disabled={loading} onClick={() => { setApplied(q); void loadInit(status, q); }}>
                Search
              </Button>
            </div>
          </label>
        </div>
      </Card>

      {canCreate && (
        <Card className="mt-6">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold">New application</h2>
            <button type="button" className="text-sm text-blue-600 hover:underline" onClick={() => setShowCreate((v) => !v)}>
              {showCreate ? 'Cancel' : 'Start on-site application'}
            </button>
          </div>
          {showCreate && (
            <div className="mt-4">
              <p className="text-xs text-gray-500">
                Applications begin as drafts. Submitting them moves them into the pipeline for review.
              </p>
              <div className="mt-3 grid gap-4 sm:grid-cols-4">
                <label className="block">
                  <span className="text-sm text-gray-600">Student no.</span>
                  <input className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2" value={cno} onChange={(e) => setCno(e.target.value)} />
                </label>
                <label className="block">
                  <span className="text-sm text-gray-600">First name</span>
                  <input className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2" value={cfirstName} onChange={(e) => setCfirstName(e.target.value)} />
                </label>
                <label className="block">
                  <span className="text-sm text-gray-600">Last name</span>
                  <input className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2" value={clastName} onChange={(e) => setClastName(e.target.value)} />
                </label>
                <label className="block">
                  <span className="text-sm text-gray-600">Date of birth</span>
                  <input type="date" className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2" value={cdob} onChange={(e) => setCdob(e.target.value)} />
                </label>
                <label className="block">
                  <span className="text-sm text-gray-600">Gender</span>
                  <select className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2" value={cgender} onChange={(e) => setCgender(e.target.value)}>
                    <option value="">—</option>
                    <option value="male">Male</option>
                    <option value="female">Female</option>
                    <option value="other">Other</option>
                  </select>
                </label>
                <label className="block">
                  <span className="text-sm text-gray-600">Campus code</span>
                  <input className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2" value={ccanpus} onChange={(e) => setCcampus(e.target.value)} />
                </label>
                <label className="block">
                  <span className="text-sm text-gray-600">Applied on</span>
                  <input type="date" className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2" value={cappliedOn} onChange={(e) => setCappliedOn(e.target.value)} />
                </label>
                <div className="flex items-end">
                  <Button type="button" disabled={busy} onClick={() => void create()}>
                    Create draft
                  </Button>
                </div>
              </div>
            </div>
          )}
        </Card>
      )}

      <Card className="mt-6">
        <h2 className="text-lg font-semibold">
          Applications <span className="text-sm font-normal text-gray-500">({total})</span>
        </h2>
        {loading && <p className="mt-2 text-xs text-gray-500">Loading…</p>}
        <ul className="mt-4 divide-y divide-gray-100">
          {items.map((app) => (
            <li key={app.id} className="py-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium">
                    {app.snapshot.firstName} {app.snapshot.lastName} <span className="text-gray-400">· {app.snapshot.studentNo}</span>
                  </p>
                  <p className="text-xs text-gray-500">
                    {app.status === 'accepted' && app.studentId ? 'Enrolled-to-student link set' : ''}
                    <span className="mt-0.5 block uppercase tracking-wide text-gray-400" style={{ maxWidth: '100px' }}>
                      {ADMISSION_STATUS_LABELS[app.status] ?? app.status}
                    </span>
                    <span className="mt-1 block">created {formatDateTime(app.createdAt)}</span>
                  </p>
                </div>
                {canReview && (
                  <div className="flex shrink-0 flex-wrap items-center gap-2">
                    {canSubmitAdmission(app.status) && (
                      <Button type="button" size="small" disabled={busy} onClick={() => void act(app.id, 'submit')}>
                        Submit
                      </Button>
                    )}
                    {canReviewAdmission(app.status) && (
                      <Button type="button" size="small" disabled={busy} onClick={() => void act(app.id, 'review')}>
                        Start review
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
                  </div>
                )}
              </div>
            </li>
          ))}
          {items.length === 0 && <li className="py-3 text-sm text-gray-500">No applications match.</li>}
        </ul>
      </Card>
    </main>
  );
}