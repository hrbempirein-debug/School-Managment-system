'use client';

import { useState } from 'react';
import type {
  AttendancePortalView as PortalView,
  LeaveRequest,
  LeaveType,
} from '@sms/contracts';
import { Button, Card } from '@sms/ui';
import { clientFetch } from '@/lib/http';
import {
  attendanceStatusLabel,
  clampPortalRange,
  leaveStatusLabel,
  leaveWindowLabel,
  portalEmptyMessage,
  portalRange,
  sortAttendanceRecords,
  studentName,
} from '@/lib/attendance';

/**
 * Shared parent/student attendance portal (Phase 5).
 *
 * Everything on screen comes from the SELF-SCOPED `/api/v1/me/attendance*`
 * endpoints: the server decides which students a portal account may see, so this
 * component has no way to ask for another family's child. A parent sees one
 * bucket per linked child; a student sees only their own.
 */
export function AttendancePortalView({
  heading,
  expectedRole,
  today,
  initialViews,
  leaveTypes,
  canRequestLeave,
}: {
  heading: string;
  expectedRole: 'parent' | 'student';
  today: string;
  initialViews: PortalView[];
  leaveTypes: LeaveType[];
  canRequestLeave: boolean;
}) {
  const initial = portalRange(today);
  const [from, setFrom] = useState(initial.from);
  const [to, setTo] = useState(initial.to);
  const [views, setViews] = useState<PortalView[]>(initialViews);
  const [requests, setRequests] = useState<LeaveRequest[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [studentId, setStudentId] = useState(initialViews[0]?.student.id ?? '');
  const [leaveTypeId, setLeaveTypeId] = useState('');
  const [startDate, setStartDate] = useState(today);
  const [endDate, setEndDate] = useState(today);
  const [reason, setReason] = useState('');

  function fail(err: unknown) {
    setError(err instanceof Error ? err.message : 'Request failed');
    setMessage(null);
  }

  async function load(nextFrom: string, nextTo: string) {
    const range = clampPortalRange(nextFrom, nextTo, today);
    setFrom(range.from);
    setTo(range.to);
    setError(null);
    setMessage(null);
    setBusy(true);
    try {
      const query = new URLSearchParams({ from: range.from, to: range.to });
      const res = await clientFetch<{ views: PortalView[] }>(`/api/v1/me/attendance?${query}`);
      setViews(res.views);
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  }

  async function loadRequests() {
    try {
      const res = await clientFetch<{ items: LeaveRequest[] }>('/api/v1/leave-requests?limit=100&offset=0');
      setRequests(res.items);
    } catch (err) {
      fail(err);
    }
  }

  async function submitLeave() {
    if (!studentId || !leaveTypeId) {
      setError('Choose a student and a leave type');
      return;
    }
    if (endDate < startDate) {
      setError('The last day cannot be before the first day');
      return;
    }
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const res = await clientFetch<{ leaveRequest: LeaveRequest }>('/api/v1/leave-requests', {
        method: 'POST',
        body: {
          studentId,
          leaveTypeId,
          startDate,
          endDate,
          ...(reason.trim() ? { reason: reason.trim() } : {}),
        },
        includeCsrf: true,
      });
      setReason('');
      setMessage(`Leave request sent for ${leaveWindowLabel(res.leaveRequest)}.`);
      await loadRequests();
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto max-w-3xl p-8">
      <h1 className="text-2xl font-semibold">{heading}</h1>
      <p className="mt-1 text-sm text-gray-600">
        {expectedRole === 'parent'
          ? 'Attendance for the students you are a guardian of.'
          : 'Your own attendance record.'}{' '}
        A day that is not on this list has not been recorded yet — it is not counted as present.
      </p>

      {message && <p className="mt-3 text-sm text-green-600">{message}</p>}
      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}

      <Card className="mt-6">
        <h2 className="text-lg font-semibold">Date range</h2>
        <div className="mt-3 flex flex-wrap items-end gap-3">
          <label className="block">
            <span className="text-sm text-gray-600">From</span>
            <input
              className="mt-1 rounded-md border border-gray-300 px-3 py-2"
              type="date"
              value={from}
              onChange={(e) => void load(e.target.value, to)}
            />
          </label>
          <label className="block">
            <span className="text-sm text-gray-600">To</span>
            <input
              className="mt-1 rounded-md border border-gray-300 px-3 py-2"
              type="date"
              value={to}
              onChange={(e) => void load(from, e.target.value)}
            />
          </label>
          <Button type="button" variant="secondary" disabled={busy} onClick={() => void load(from, to)}>
            Refresh
          </Button>
          <p className="text-xs text-gray-500">
            Showing {from} → {to} (at most 180 days).
          </p>
        </div>
      </Card>

      {views.length === 0 ? (
        <Card className="mt-6">
          <p className="text-sm text-gray-600">{portalEmptyMessage(expectedRole)}</p>
        </Card>
      ) : (
        views.map((view) => {
          const records = sortAttendanceRecords(view.records);
          return (
            <Card key={view.student.id} className="mt-6">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h2 className="text-lg font-semibold">
                  {studentName(view.student)}{' '}
                  <span className="text-sm font-normal text-gray-500">{view.student.studentNo}</span>
                </h2>
                <p className="text-sm text-gray-600">
                  present {view.counts.present} · absent {view.counts.absent} · late {view.counts.late} ·
                  excused {view.counts.excused}
                </p>
              </div>
              {records.length === 0 ? (
                <p className="mt-3 text-sm text-gray-500">
                  No attendance has been recorded in this range.
                </p>
              ) : (
                <ul className="mt-3 divide-y divide-gray-100">
                  {records.map((r) => (
                    <li key={r.id} className="flex items-center justify-between py-2 text-sm">
                      <span>{r.attendanceDate}</span>
                      <span className="text-gray-600">
                        {attendanceStatusLabel(r.status)}
                        {r.note ? <span className="ml-2 text-xs text-gray-500">{r.note}</span> : null}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          );
        })
      )}

      {canRequestLeave && views.length > 0 && leaveTypes.length > 0 && (
        <Card className="mt-6">
          <h2 className="text-lg font-semibold">Request leave</h2>
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <label className="block">
              <span className="text-sm text-gray-600">Student</span>
              <select
                className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2"
                value={studentId}
                onChange={(e) => setStudentId(e.target.value)}
              >
                {views.map((v) => (
                  <option key={v.student.id} value={v.student.id}>
                    {studentName(v.student)}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="text-sm text-gray-600">Leave type</span>
              <select
                className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2"
                value={leaveTypeId}
                onChange={(e) => setLeaveTypeId(e.target.value)}
              >
                <option value="">Select a type</option>
                {leaveTypes.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="text-sm text-gray-600">First day</span>
              <input
                className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2"
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
              />
            </label>
            <label className="block">
              <span className="text-sm text-gray-600">Last day</span>
              <input
                className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2"
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
              />
            </label>
            <label className="block sm:col-span-2">
              <span className="text-sm text-gray-600">Reason (optional)</span>
              <textarea
                className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2"
                rows={2}
                maxLength={1000}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
            </label>
          </div>
          <div className="mt-4">
            <Button type="button" disabled={busy} onClick={() => void submitLeave()}>
              Send request
            </Button>
          </div>
        </Card>
      )}

      {canRequestLeave && (
        <Card className="mt-6">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-lg font-semibold">Your leave requests</h2>
            <Button type="button" size="small" variant="secondary" onClick={() => void loadRequests()}>
              Load
            </Button>
          </div>
          {requests.length === 0 ? (
            <p className="mt-3 text-sm text-gray-500">
              No requests loaded yet. A request is decided by the school and cannot be edited here.
            </p>
          ) : (
            <ul className="mt-3 space-y-2">
              {requests.map((r) => (
                <li key={r.id} className="flex items-center justify-between rounded-md border p-3 text-sm">
                  <span>{leaveWindowLabel(r)}</span>
                  <span className="text-xs text-gray-600">{leaveStatusLabel(r.status)}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}
    </main>
  );
}
