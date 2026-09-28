'use client';

import { useMemo, useState } from 'react';
import type {
  AcdClass,
  AttendanceClassReportResponse,
  AttendancePeriod,
  AttendancePeriodListResponse,
  AttendanceRosterEntry,
  AttendanceStatus,
  LeaveRequest,
  LeaveRequestListResponse,
  LeaveType,
  LeaveTypeResponse,
  MarkAttendanceRequest,
  PeriodListResponse,
  Section,
  SectionListResponse,
  StaffAttendanceListResponse,
  StaffAttendanceRow,
  StaffAttendanceStatus,
  TeacherDirectoryEntry,
} from '@sms/contracts';
import { Button, Card } from '@sms/ui';
import { clientFetch } from '@/lib/http';
import {
  ATTENDANCE_STATUSES,
  STAFF_ATTENDANCE_STATUSES,
  attendanceStatusLabel,
  buildDraftEntries,
  isValidIsoDate,
  leaveStatusLabel,
  leaveWindowLabel,
  markingAllowedFor,
  markingBlockedReason,
  pendingLeaveRequests,
  portalRange,
  rosterProgress,
  sortRoster,
  studentName,
  tallyRoster,
} from '@/lib/attendance';

type Tab = 'register' | 'period' | 'staff' | 'leave' | 'types';

interface AttendanceManagerProps {
  initialClasses: AcdClass[];
  initialLeaveTypes: LeaveType[];
  teachers: TeacherDirectoryEntry[];
  canListClasses: boolean;
  canMark: boolean;
  canApproveLeave: boolean;
  canManageLeaveTypes: boolean;
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

const TABS: { id: Tab; label: string }[] = [
  { id: 'register', label: 'Daily register' },
  { id: 'period', label: 'Period register' },
  { id: 'staff', label: 'Staff clock' },
  { id: 'leave', label: 'Leave requests' },
  { id: 'types', label: 'Leave types' },
];

export function AttendanceManager({
  initialClasses,
  initialLeaveTypes,
  teachers,
  canListClasses,
  canMark,
  canApproveLeave,
  canManageLeaveTypes,
}: AttendanceManagerProps) {
  const today = todayIso();
  const [tab, setTab] = useState<Tab>('register');
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function fail(err: unknown) {
    setError(err instanceof Error ? err.message : 'Request failed');
    setMessage(null);
  }

  const tabs = useMemo(
    () =>
      TABS.filter((t) => {
        if (t.id === 'types') return canManageLeaveTypes;
        return true;
      }),
    [canManageLeaveTypes],
  );

  return (
    <main className="mx-auto max-w-5xl p-8">
      <h1 className="text-2xl font-semibold">Attendance</h1>
      <p className="mt-1 text-sm text-gray-600">
        Daily and period registers, staff clock and leave. Marking is only possible for today —
        a past day is corrected with a reason so the change stays auditable.
      </p>

      <nav className="mt-4 flex flex-wrap gap-2">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => {
              setTab(t.id);
              setError(null);
              setMessage(null);
            }}
            className={`rounded-md px-3 py-1.5 text-sm ${
              tab === t.id ? 'bg-blue-600 text-white' : 'border border-gray-300 bg-white text-gray-700'
            }`}
          >
            {t.label}
          </button>
        ))}
      </nav>

      {message && <p className="mt-3 text-sm text-green-600">{message}</p>}
      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}

      <div className="mt-4">
        {tab === 'register' && (
          <RegisterTab
            classes={initialClasses}
            canListClasses={canListClasses}
            canMark={canMark}
            today={today}
            onError={fail}
            onMessage={setMessage}
            busy={busy}
            setBusy={setBusy}
          />
        )}
        {tab === 'period' && (
          <PeriodTab
            classes={initialClasses}
            canListClasses={canListClasses}
            canMark={canMark}
            today={today}
            onError={fail}
            onMessage={setMessage}
            busy={busy}
            setBusy={setBusy}
          />
        )}
        {tab === 'staff' && (
          <StaffTab
            teachers={teachers}
            canMark={canMark}
            today={today}
            onError={fail}
            onMessage={setMessage}
            busy={busy}
            setBusy={setBusy}
          />
        )}
        {tab === 'leave' && (
          <LeaveTab
            canApprove={canApproveLeave}
            today={today}
            onError={fail}
            onMessage={setMessage}
            busy={busy}
            setBusy={setBusy}
          />
        )}
        {tab === 'types' && (
          <LeaveTypesTab
            initialLeaveTypes={initialLeaveTypes}
            canManage={canManageLeaveTypes}
            onError={fail}
            onMessage={setMessage}
            busy={busy}
            setBusy={setBusy}
          />
        )}
      </div>
    </main>
  );
}

type TabProps = {
  onError: (err: unknown) => void;
  onMessage: (msg: string | null) => void;
  busy: boolean;
  setBusy: (b: boolean) => void;
};

// ---------------------------------------------------------------- daily register

function RegisterTab({
  classes,
  canListClasses,
  canMark,
  today,
  onError,
  onMessage,
  busy,
  setBusy,
}: TabProps & { classes: AcdClass[]; canListClasses: boolean; canMark: boolean; today: string }) {
  const [classId, setClassId] = useState('');
  const [sections, setSections] = useState<Section[]>([]);
  const [sectionId, setSectionId] = useState('');
  const [date, setDate] = useState(today);
  const [report, setReport] = useState<AttendanceClassReportResponse | null>(null);
  const [draft, setDraft] = useState<Record<string, AttendanceStatus>>({});
  const [note, setNote] = useState('');
  const [loading, setLoading] = useState(false);

  const roster = useMemo(
    () => (report ? sortRoster(report.entries) : []),
    [report],
  );
  const liveEntries = useMemo<AttendanceRosterEntry[]>(
    () =>
      roster.map((e) => ({
        ...e,
        status: draft[e.studentId] ?? e.status,
      })),
    [roster, draft],
  );
  const counts = useMemo(() => tallyRoster(liveEntries), [liveEntries]);
  const progress = useMemo(() => rosterProgress(liveEntries), [liveEntries]);
  const blocked = markingBlockedReason(date, today);

  async function selectClass(id: string) {
    setClassId(id);
    setSections([]);
    setSectionId('');
    setReport(null);
    setDraft({});
    onMessage(null);
    if (!id) return;
    try {
      const res = await clientFetch<SectionListResponse>(
        `/api/v1/classes/${encodeURIComponent(id)}/sections?limit=100&offset=0`,
      );
      setSections(res.items);
    } catch (err) {
      onError(err);
    }
  }

  async function loadRoster(secId: string, on: string) {
    setSectionId(secId);
    setReport(null);
    setDraft({});
    onMessage(null);
    if (!secId || !isValidIsoDate(on)) return;
    setLoading(true);
    try {
      const res = await clientFetch<AttendanceClassReportResponse>(
        `/api/v1/attendance/reports/class?sectionId=${encodeURIComponent(secId)}&date=${encodeURIComponent(on)}`,
      );
      setReport(res);
    } catch (err) {
      onError(err);
    } finally {
      setLoading(false);
    }
  }

  function setStatus(studentId: string, status: AttendanceStatus) {
    setDraft((prev) => ({ ...prev, [studentId]: status }));
  }

  async function save() {
    if (!sectionId) {
      onError(new Error('Choose a section first'));
      return;
    }
    const entries = buildDraftEntries(liveEntries, draft, note);
    if (entries.length === 0) {
      onError(new Error('Change at least one student status before saving'));
      return;
    }
    setBusy(true);
    onMessage(null);
    try {
      const res = await clientFetch<{
        attendance: { marked: number; inserted: number; corrected: number };
      }>('/api/v1/attendance/mark', {
        method: 'POST',
        body: { date, entries } satisfies MarkAttendanceRequest,
        includeCsrf: true,
      });
      setDraft({});
      setNote('');
      onMessage(
        `Saved ${res.attendance.marked} record(s): ${res.attendance.inserted} new, ${res.attendance.corrected} corrected.`,
      );
      await loadRoster(sectionId, date);
    } catch (err) {
      onError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Card>
        <h2 className="text-lg font-semibold">Class register</h2>
        <div className="mt-4 grid gap-4 sm:grid-cols-3">
          <label className="block">
            <span className="text-sm text-gray-600">Class</span>
            <select
              className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2"
              value={classId}
              disabled={!canListClasses}
              onChange={(e) => void selectClass(e.target.value)}
            >
              <option value="">Select a class</option>
              {classes.map((c) => (
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
              disabled={sections.length === 0}
              onChange={(e) => void loadRoster(e.target.value, date)}
            >
              <option value="">Select a section</option>
              {sections.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.code}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="text-sm text-gray-600">Date</span>
            <input
              className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2"
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
          </label>
        </div>
        {!canListClasses && (
          <p className="mt-2 text-xs text-gray-500">
            Choosing a class needs classes.read; ask an administrator for the section list.
          </p>
        )}
        {blocked && (
          <p className="mt-3 text-sm text-amber-600">{blocked}</p>
        )}
      </Card>

      {report && (
        <Card className="mt-6">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-lg font-semibold">
              {report.className} · {report.sectionCode}{' '}
              <span className="text-sm font-normal text-gray-500">{report.date}</span>
            </h2>
            <p className="text-sm text-gray-600">
              {progress.marked}/{progress.total} marked · present {counts.present} · absent {counts.absent} · late{' '}
              {counts.late} · excused {counts.excused} · unmarked {counts.unmarked}
            </p>
          </div>

          <table className="mt-4 w-full text-left text-sm">
            <thead>
              <tr className="border-b text-xs uppercase text-gray-500">
                <th className="py-2">#</th>
                <th className="py-2">Student</th>
                <th className="py-2">Status</th>
              </tr>
            </thead>
            <tbody>
              {roster.map((entry) => {
                const status = draft[entry.studentId] ?? entry.status;
                return (
                  <tr key={entry.studentId} className="border-b last:border-0">
                    <td className="py-2 text-gray-500">{entry.rollNo ?? '—'}</td>
                    <td className="py-2">
                      <span className="font-medium">{studentName(entry)}</span>
                      <span className="ml-2 text-xs text-gray-500">{entry.studentNo}</span>
                    </td>
                    <td className="py-2">
                      <div className="flex flex-wrap gap-1">
                        {ATTENDANCE_STATUSES.map((s) => (
                          <button
                            key={s}
                            type="button"
                            disabled={!canMark || !markingAllowedFor(date, today)}
                            onClick={() => setStatus(entry.studentId, s)}
                            className={`rounded px-2 py-1 text-xs ${
                              status === s
                                ? 'bg-blue-600 text-white'
                                : 'border border-gray-300 text-gray-700'
                            }`}
                          >
                            {attendanceStatusLabel(s)}
                          </button>
                        ))}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {roster.length === 0 && (
            <p className="mt-3 text-sm text-gray-500">
              {loading ? 'Loading roster…' : 'No actively enrolled students in this section.'}
            </p>
          )}

          {canMark && roster.length > 0 && (
            <div className="mt-4 flex flex-wrap items-end gap-4">
              <label className="block flex-1">
                <span className="text-sm text-gray-600">Note (applies to every changed student)</span>
                <input
                  className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2"
                  value={note}
                  maxLength={500}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="Bus delay"
                />
              </label>
              <Button
                type="button"
                disabled={busy || Object.keys(draft).length === 0 || !markingAllowedFor(date, today)}
                onClick={() => void save()}
              >
                Save register
              </Button>
            </div>
          )}
        </Card>
      )}
    </>
  );
}

// -------------------------------------------------------------- period register

function PeriodTab({
  classes,
  canListClasses,
  canMark,
  today,
  onError,
  onMessage,
  busy,
  setBusy,
}: TabProps & { classes: AcdClass[]; canListClasses: boolean; canMark: boolean; today: string }) {
  const [classId, setClassId] = useState('');
  const [sections, setSections] = useState<Section[]>([]);
  const [sectionId, setSectionId] = useState('');
  const [periods, setPeriods] = useState<PeriodListResponse['items']>([]);
  const [periodId, setPeriodId] = useState('');
  const [date, setDate] = useState(today);
  const [rows, setRows] = useState<AttendancePeriod[]>([]);
  const [total, setTotal] = useState(0);
  const [statusFor, setStatusFor] = useState<Record<string, AttendanceStatus>>({});
  const blocked = markingBlockedReason(date, today);

  async function selectClass(id: string) {
    setClassId(id);
    setSections([]);
    setSectionId('');
    setRows([]);
    setTotal(0);
    onMessage(null);
    if (!id) return;
    try {
      const [sectionsRes, periodsRes] = await Promise.all([
        clientFetch<SectionListResponse>(`/api/v1/classes/${encodeURIComponent(id)}/sections?limit=100&offset=0`),
        clientFetch<PeriodListResponse>('/api/v1/periods?limit=100&offset=0'),
      ]);
      setSections(sectionsRes.items);
      setPeriods(periodsRes.items);
    } catch (err) {
      onError(err);
    }
  }

  async function load(secId: string, on: string) {
    setSectionId(secId);
    setRows([]);
    setTotal(0);
    setStatusFor({});
    onMessage(null);
    if (!secId || !isValidIsoDate(on)) return;
    try {
      const res = await clientFetch<AttendancePeriodListResponse>(
        `/api/v1/attendance/periods?sectionId=${encodeURIComponent(secId)}&date=${encodeURIComponent(on)}&limit=100&offset=0`,
      );
      setRows(res.items);
      setTotal(res.total);
    } catch (err) {
      onError(err);
    }
  }

  async function markPeriod(status: AttendanceStatus) {
    if (!sectionId || !periodId) {
      onError(new Error('Choose a section and a period first'));
      return;
    }
    const studentIds = [...new Set(rows.map((r) => r.studentId))];
    if (studentIds.length === 0) {
      onError(new Error('There is nothing to mark for this section and period yet'));
      return;
    }
    setBusy(true);
    onMessage(null);
    try {
      const res = await clientFetch<{ attendance: { marked: number } }>('/api/v1/attendance/periods/mark', {
        method: 'POST',
        body: {
          sectionId,
          periodId,
          date,
          entries: studentIds.map((studentId) => ({ studentId, status })),
        },
        includeCsrf: true,
      });
      onMessage(`Marked ${res.attendance.marked} period record(s) as ${attendanceStatusLabel(status)}.`);
      await load(sectionId, date);
    } catch (err) {
      onError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Card>
        <h2 className="text-lg font-semibold">Period register</h2>
        <div className="mt-4 grid gap-4 sm:grid-cols-4">
          <label className="block">
            <span className="text-sm text-gray-600">Class</span>
            <select
              className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2"
              value={classId}
              disabled={!canListClasses}
              onChange={(e) => void selectClass(e.target.value)}
            >
              <option value="">Select a class</option>
              {classes.map((c) => (
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
              disabled={sections.length === 0}
              onChange={(e) => void load(e.target.value, date)}
            >
              <option value="">Select a section</option>
              {sections.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.code}
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
              {periods.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="text-sm text-gray-600">Date</span>
            <input
              className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2"
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
          </label>
        </div>
        {blocked && <p className="mt-3 text-sm text-amber-600">{blocked}</p>}
      </Card>

      <Card className="mt-6">
        <h2 className="text-lg font-semibold">
          Marked records <span className="text-sm font-normal text-gray-500">({total})</span>
        </h2>
        {canMark && sectionId && periodId && (
          <div className="mt-3 flex flex-wrap gap-2">
            {ATTENDANCE_STATUSES.map((s) => (
              <Button
                key={s}
                type="button"
                size="small"
                variant="secondary"
                disabled={busy || !markingAllowedFor(date, today)}
                onClick={() => void markPeriod(s)}
              >
                Mark all {attendanceStatusLabel(s)}
              </Button>
            ))}
          </div>
        )}
        <ul className="mt-4 space-y-2">
          {rows.map((r) => (
            <li key={r.id} className="flex items-center justify-between rounded-md border p-3 text-sm">
              <span className="font-mono text-xs text-gray-500">student {r.studentId.slice(0, 8)}</span>
              <span>{attendanceStatusLabel(r.status)}</span>
            </li>
          ))}
          {rows.length === 0 && (
            <li className="text-sm text-gray-500">No period attendance recorded for this day yet.</li>
          )}
        </ul>
        <p className="mt-2 text-xs text-gray-500">
          Status of an individual period record can be changed with a same-day correction that records a
          reason.
        </p>
      </Card>
    </>
  );
}

// ------------------------------------------------------------------ staff clock

function StaffTab({
  teachers,
  canMark,
  today,
  onError,
  onMessage,
  busy,
  setBusy,
}: TabProps & { teachers: TeacherDirectoryEntry[]; canMark: boolean; today: string }) {
  const [date, setDate] = useState(today);
  const [rows, setRows] = useState<StaffAttendanceRow[]>([]);
  const [total, setTotal] = useState(0);
  const [draft, setDraft] = useState<Record<string, StaffAttendanceStatus>>({});
  const blocked = markingBlockedReason(date, today);

  async function load(on: string) {
    setDate(on);
    setDraft({});
    onMessage(null);
    if (!isValidIsoDate(on)) return;
    try {
      const res = await clientFetch<StaffAttendanceListResponse>(
        `/api/v1/staff-attendance?date=${encodeURIComponent(on)}&limit=100&offset=0`,
      );
      setRows(res.items);
      setTotal(res.total);
    } catch (err) {
      onError(err);
    }
  }

  async function mark(userId: string, status: StaffAttendanceStatus) {
    setBusy(true);
    onMessage(null);
    try {
      await clientFetch<{ attendance: StaffAttendanceRow }>('/api/v1/staff-attendance/mark', {
        method: 'POST',
        body: { userId, date, status },
        includeCsrf: true,
      });
      onMessage(`Recorded ${attendanceStatusLabel(status)} for ${userId.slice(0, 8)}.`);
      await load(date);
    } catch (err) {
      onError(err);
    } finally {
      setBusy(false);
    }
  }

  const marked = useMemo(() => new Map(rows.map((r) => [r.userId, r])), [rows]);
  const unmarkedStaff = useMemo(
    () => teachers.filter((t) => !marked.has(t.userId)),
    [teachers, marked],
  );

  return (
    <>
      <Card>
        <h2 className="text-lg font-semibold">Staff clock</h2>
        <div className="mt-4 flex flex-wrap items-end gap-4">
          <label className="block">
            <span className="text-sm text-gray-600">Date</span>
            <input
              className="mt-1 rounded-md border border-gray-300 px-3 py-2"
              type="date"
              value={date}
              onChange={(e) => void load(e.target.value)}
            />
          </label>
          <Button type="button" variant="secondary" onClick={() => void load(date)}>
            Reload
          </Button>
        </div>
        {blocked && <p className="mt-3 text-sm text-amber-600">{blocked}</p>}
      </Card>

      <Card className="mt-6">
        <h2 className="text-lg font-semibold">
          Recorded <span className="text-sm font-normal text-gray-500">({total})</span>
        </h2>
        <ul className="mt-4 space-y-2">
          {rows.map((r) => (
            <li key={r.id} className="flex items-center justify-between rounded-md border p-3 text-sm">
              <span className="font-mono text-xs text-gray-500">user {r.userId.slice(0, 8)}</span>
              <span>{attendanceStatusLabel(r.status)}</span>
            </li>
          ))}
          {rows.length === 0 && <li className="text-sm text-gray-500">Nobody clocked in for this day.</li>}
        </ul>
      </Card>

      {canMark && teachers.length > 0 && (
        <Card className="mt-6">
          <h2 className="text-lg font-semibold">Mark staff</h2>
          {teachers.length === 0 && (
            <p className="mt-2 text-sm text-gray-500">No staff directory available.</p>
          )}
          <ul className="mt-4 space-y-3">
            {teachers.map((t) => {
              const current = draft[t.userId] ?? marked.get(t.userId)?.status;
              return (
                <li key={t.userId} className="rounded-md border p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-sm font-medium">
                      {t.fullName}
                      {current ? (
                        <span className="ml-2 text-xs text-gray-500">
                          {attendanceStatusLabel(current)}
                        </span>
                      ) : (
                        <span className="ml-2 text-xs text-amber-600">not marked</span>
                      )}
                    </p>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-1">
                    {STAFF_ATTENDANCE_STATUSES.map((s) => (
                      <button
                        key={s}
                        type="button"
                        disabled={busy || !markingAllowedFor(date, today)}
                        onClick={() => setDraft((prev) => ({ ...prev, [t.userId]: s }))}
                        className={`rounded px-2 py-1 text-xs ${
                          current === s ? 'bg-blue-600 text-white' : 'border border-gray-300 text-gray-700'
                        }`}
                      >
                        {attendanceStatusLabel(s)}
                      </button>
                    ))}
                    <Button
                      type="button"
                      size="small"
                      disabled={busy || !current || !markingAllowedFor(date, today)}
                      onClick={() => void mark(t.userId, current!)}
                    >
                      Save
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
          {unmarkedStaff.length === teachers.length && (
            <p className="mt-3 text-xs text-gray-500">
              Nobody is marked for this day yet — the list above is every staff member of the school.
            </p>
          )}
        </Card>
      )}
    </>
  );
}

// -------------------------------------------------------------- leave requests

function LeaveTab({
  canApprove,
  today,
  onError,
  onMessage,
  busy,
  setBusy,
}: TabProps & { canApprove: boolean; today: string }) {
  const [status, setStatus] = useState<'pending' | 'approved' | 'rejected' | ''>('pending');
  const [rows, setRows] = useState<LeaveRequest[]>([]);
  const [total, setTotal] = useState(0);
  const [notes, setNotes] = useState<Record<string, string>>({});

  async function load(next: string) {
    setStatus(next as typeof status);
    onMessage(null);
    try {
      const query = next ? `&status=${next}` : '';
      const res = await clientFetch<LeaveRequestListResponse>(
        `/api/v1/leave-requests?limit=100&offset=0${query}`,
      );
      setRows(res.items);
      setTotal(res.total);
    } catch (err) {
      onError(err);
    }
  }

  async function decide(request: LeaveRequest, action: 'approve' | 'reject') {
    setBusy(true);
    onMessage(null);
    try {
      const res = await clientFetch<{ leaveRequest: LeaveRequest }>(
        `/api/v1/leave-requests/${encodeURIComponent(request.id)}/${action}`,
        {
          method: 'POST',
          body: notes[request.id]?.trim() ? { note: notes[request.id]!.trim() } : {},
          includeCsrf: true,
        },
      );
      onMessage(`Leave ${res.leaveRequest.status} for ${leaveWindowLabel(res.leaveRequest)}.`);
      await load(status);
    } catch (err) {
      onError(err);
    } finally {
      setBusy(false);
    }
  }

  const pending = pendingLeaveRequests(rows).length;

  return (
    <>
      <Card>
        <h2 className="text-lg font-semibold">Leave requests</h2>
        <div className="mt-4 flex flex-wrap items-end gap-4">
          <label className="block">
            <span className="text-sm text-gray-600">Status</span>
            <select
              className="mt-1 rounded-md border border-gray-300 px-3 py-2"
              value={status}
              onChange={(e) => void load(e.target.value)}
            >
              <option value="">All</option>
              <option value="pending">Pending</option>
              <option value="approved">Approved</option>
              <option value="rejected">Rejected</option>
            </select>
          </label>
          <Button type="button" variant="secondary" onClick={() => void load(status)}>
            Reload
          </Button>
          {pending > 0 && <p className="text-sm text-amber-600">{pending} awaiting a decision</p>}
        </div>
      </Card>

      <Card className="mt-6">
        <h2 className="text-lg font-semibold">
          Requests <span className="text-sm font-normal text-gray-500">({total})</span>
        </h2>
        <ul className="mt-4 space-y-3">
          {rows.map((r) => (
            <li key={r.id} className="rounded-md border p-3">
              <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                <span className="font-medium">{leaveWindowLabel(r)}</span>
                <span className="text-xs text-gray-600">{leaveStatusLabel(r.status)}</span>
              </div>
              {r.reason && <p className="mt-1 text-sm text-gray-600">{r.reason}</p>}
              {r.status === 'pending' && canApprove && (
                <div className="mt-3 flex flex-wrap items-end gap-3">
                  <label className="block flex-1">
                    <span className="text-sm text-gray-600">Decision note (optional)</span>
                    <input
                      className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
                      maxLength={500}
                      value={notes[r.id] ?? ''}
                      onChange={(e) => setNotes((prev) => ({ ...prev, [r.id]: e.target.value }))}
                    />
                  </label>
                  <Button
                    type="button"
                    size="small"
                    disabled={busy}
                    onClick={() => void decide(r, 'approve')}
                  >
                    Approve
                  </Button>
                  <Button
                    type="button"
                    size="small"
                    variant="danger"
                    disabled={busy}
                    onClick={() => void decide(r, 'reject')}
                  >
                    Reject
                  </Button>
                </div>
              )}
              {r.decisionNote && (
                <p className="mt-2 text-xs text-gray-500">Note: {r.decisionNote}</p>
              )}
            </li>
          ))}
          {rows.length === 0 && <li className="text-sm text-gray-500">No leave requests in this view.</li>}
        </ul>
        <p className="mt-2 text-xs text-gray-500">
          A request can only be decided once; a repeated decision is rejected by the server as a
          conflict. {today} is the school date.
        </p>
      </Card>
    </>
  );
}

// ----------------------------------------------------------------- leave types

function LeaveTypesTab({
  initialLeaveTypes,
  canManage,
  onError,
  onMessage,
  busy,
  setBusy,
}: TabProps & { initialLeaveTypes: LeaveType[]; canManage: boolean }) {
  const [rows, setRows] = useState<LeaveType[]>(initialLeaveTypes);
  const [code, setCode] = useState('');
  const [name, setName] = useState('');

  async function create() {
    if (!code.trim() || !name.trim()) {
      onError(new Error('A code and a name are required'));
      return;
    }
    setBusy(true);
    onMessage(null);
    try {
      const res = await clientFetch<LeaveTypeResponse>('/api/v1/leave-types', {
        method: 'POST',
        body: { code: code.trim(), name: name.trim() },
        includeCsrf: true,
      });
      setRows((prev) => [...prev, res.leaveType].sort((a, b) => (a.code < b.code ? -1 : 1)));
      setCode('');
      setName('');
      onMessage(`Leave type "${res.leaveType.code}" created.`);
    } catch (err) {
      onError(err);
    } finally {
      setBusy(false);
    }
  }

  async function toggle(row: LeaveType) {
    setBusy(true);
    onMessage(null);
    try {
      const res = await clientFetch<LeaveTypeResponse>(
        `/api/v1/leave-types/${encodeURIComponent(row.id)}`,
        {
          method: 'PATCH',
          body: { status: row.status === 'active' ? 'inactive' : 'active' },
          includeCsrf: true,
        },
      );
      setRows((prev) => prev.map((t) => (t.id === row.id ? res.leaveType : t)));
      onMessage(`Leave type "${res.leaveType.code}" is now ${res.leaveType.status}.`);
    } catch (err) {
      onError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {canManage && (
        <Card>
          <h2 className="text-lg font-semibold">New leave type</h2>
          <div className="mt-4 flex flex-wrap items-end gap-4">
            <label className="block">
              <span className="text-sm text-gray-600">Code</span>
              <input
                className="mt-1 rounded-md border border-gray-300 px-3 py-2"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="medical"
              />
            </label>
            <label className="block flex-1">
              <span className="text-sm text-gray-600">Name</span>
              <input
                className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Medical leave"
              />
            </label>
            <Button type="button" disabled={busy} onClick={() => void create()}>
              Create
            </Button>
          </div>
          <p className="mt-2 text-xs text-gray-500">
            The code is permanent — a leave request always points at the type it was filed under.
          </p>
        </Card>
      )}

      <Card className="mt-6">
        <h2 className="text-lg font-semibold">
          Leave types <span className="text-sm font-normal text-gray-500">({rows.length})</span>
        </h2>
        <ul className="mt-4 space-y-2">
          {rows.map((t) => (
            <li key={t.id} className="flex items-center justify-between rounded-md border p-3 text-sm">
              <span>
                <span className="font-medium">{t.code}</span> · {t.name}
              </span>
              {canManage ? (
                <Button
                  type="button"
                  size="small"
                  variant="secondary"
                  disabled={busy}
                  onClick={() => void toggle(t)}
                >
                  {t.status === 'active' ? 'Deactivate' : 'Activate'}
                </Button>
              ) : (
                <span className="text-xs text-gray-500">{t.status}</span>
              )}
            </li>
          ))}
          {rows.length === 0 && <li className="text-sm text-gray-500">No leave types yet.</li>}
        </ul>
      </Card>
    </>
  );
}
