import type {
  AttendanceContextRole,
  AttendanceDay,
  AttendanceReportCounts,
  AttendanceRosterEntry,
  AttendanceStatus,
  LeaveRequest,
  LeaveRequestStatus,
  StaffAttendanceStatus,
} from '@sms/contracts';

/**
 * Phase 5 attendance UI helpers. Everything here is a pure function so the
 * register/portal logic is unit-testable without a browser or an API.
 *
 * Two rules from the roadmap are encoded rather than left to each screen:
 *  1. a PAST date can no longer be marked — it must be corrected, with a
 *     reason, through the audit trail (DB trigger rejects back-dated marks);
 *  2. tallies are derived from the roster the server sent, never accumulated
 *     in component state, so the UI can never over-count a mark.
 */

export const ATTENDANCE_STATUSES: readonly AttendanceStatus[] = [
  'present',
  'absent',
  'late',
  'excused',
];

export const STAFF_ATTENDANCE_STATUSES: readonly StaffAttendanceStatus[] = [
  'present',
  'absent',
  'late',
  'excused',
  'on_leave',
];

const STATUS_LABELS: Record<AttendanceStatus | StaffAttendanceStatus, string> = {
  present: 'Present',
  absent: 'Absent',
  late: 'Late',
  excused: 'Excused',
  on_leave: 'On leave',
};

const LEAVE_STATUS_LABELS: Record<LeaveRequestStatus, string> = {
  pending: 'Pending',
  approved: 'Approved',
  rejected: 'Rejected',
};

export function attendanceStatusLabel(status: unknown): string {
  if (typeof status === 'string' && status in STATUS_LABELS) {
    return STATUS_LABELS[status as AttendanceStatus];
  }
  return 'Unmarked';
}

export function leaveStatusLabel(status: unknown): string {
  if (typeof status === 'string' && status in LEAVE_STATUS_LABELS) {
    return LEAVE_STATUS_LABELS[status as LeaveRequestStatus];
  }
  return '—';
}

/** `YYYY-MM-DD` arithmetic in UTC so a browser timezone can never shift a day. */
export function shiftIsoDate(iso: string, days: number): string {
  const base = new Date(`${iso}T00:00:00.000Z`);
  base.setUTCDate(base.getUTCDate() + days);
  return base.toISOString().slice(0, 10);
}

export function isValidIsoDate(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

/**
 * Marking is only allowed for TODAY. `markingAllowedFor` exists so the register
 * can disable the Save button (and say why) instead of letting the server
 * reject a back-dated register after the fact.
 */
export function markingAllowedFor(date: string, today: string): boolean {
  return date === today;
}

export function markingBlockedReason(date: string, today: string): string | null {
  if (markingAllowedFor(date, today)) return null;
  if (date > today) {
    return 'Future dates cannot be marked. Attendance is recorded on the day it happens.';
  }
  return 'That day has passed. Use a same-day correction (with a reason) from the register.';
}

/** Portal default window: the API accepts at most 180 days. */
export const PORTAL_RANGE_MAX_DAYS = 180;
export const PORTAL_RANGE_DEFAULT_DAYS = 30;

export function portalRange(
  today: string,
  from?: string,
  to?: string,
): { from: string; to: string } {
  const defaultFrom = shiftIsoDate(today, -(PORTAL_RANGE_DEFAULT_DAYS - 1));
  const earliest = shiftIsoDate(today, -(PORTAL_RANGE_MAX_DAYS - 1));
  // Only a COMPLETE, ordered range is honoured: a half-typed or inverted range
  // (both are transient states of two date inputs) falls back to the default
  // window rather than sending a request the server would reject.
  if (isValidIsoDate(from) && isValidIsoDate(to) && from <= to) {
    return { from: from < earliest ? earliest : from, to };
  }
  return { from: defaultFrom, to: today };
}

/** Clamp a user-typed range to the API's bound, keeping `from <= to`. */
export function clampPortalRange(
  from: string,
  to: string,
  today: string,
): { from: string; to: string } {
  const safeTo = isValidIsoDate(to) ? to : today;
  const earliest = shiftIsoDate(today, -(PORTAL_RANGE_MAX_DAYS - 1));
  const safeFrom = isValidIsoDate(from) ? (from < earliest ? earliest : from) : earliest;
  if (safeFrom > safeTo) return { from: safeTo, to: safeTo };
  return { from: safeFrom, to: safeTo };
}

export const EMPTY_COUNTS: AttendanceReportCounts = {
  present: 0,
  absent: 0,
  late: 0,
  excused: 0,
  unmarked: 0,
};

/** Tally a roster: a null status is UNMARKED, never silently "present". */
export function tallyRoster(entries: readonly AttendanceRosterEntry[]): AttendanceReportCounts {
  const counts: AttendanceReportCounts = { ...EMPTY_COUNTS };
  for (const entry of entries) {
    if (entry.status === null) counts.unmarked += 1;
    else counts[entry.status] += 1;
  }
  return counts;
}

export function rosterProgress(entries: readonly AttendanceRosterEntry[]): {
  total: number;
  marked: number;
  complete: boolean;
} {
  const total = entries.length;
  const marked = entries.filter((e) => e.status !== null).length;
  return { total, marked, complete: total > 0 && marked === total };
}

export function unmarkedEntries(
  entries: readonly AttendanceRosterEntry[],
): AttendanceRosterEntry[] {
  return entries.filter((e) => e.status === null);
}

/**
 * Apply one status to a roster selection and return the bulk-mark entries.
 * An empty selection is returned as an empty array so the caller can block the
 * request with its own message (the API rejects a 0-entry mark as invalid).
 */
export function buildMarkEntries(
  entries: readonly AttendanceRosterEntry[],
  studentIds: readonly string[],
  status: AttendanceStatus,
  note?: string,
): { studentId: string; status: AttendanceStatus; note?: string }[] {
  const selected = new Set(studentIds);
  const trimmed = note?.trim();
  return entries
    .filter((e) => selected.has(e.studentId))
    .map((e) => ({
      studentId: e.studentId,
      status,
      ...(trimmed ? { note: trimmed } : {}),
    }));
}

/**
 * Turn a per-student status draft into the bulk-mark entries.
 *
 * The draft is a `studentId -> status` map, so the status MUST travel with its
 * own student id. Pairing positions (i.e. re-deriving the selection and zipping
 * it against the draft) silently marks the wrong student as soon as one id is
 * not on the roster, so the pairing happens here, keyed by id, and is unit
 * tested. Ids that are not on the roster are dropped: the register can never
 * mark a student outside its own section.
 */
export function buildDraftEntries(
  entries: readonly AttendanceRosterEntry[],
  draft: Readonly<Record<string, AttendanceStatus>>,
  note?: string,
): { studentId: string; status: AttendanceStatus; note?: string }[] {
  const onRoster = new Set(entries.map((e) => e.studentId));
  const trimmed = note?.trim();
  const out: { studentId: string; status: AttendanceStatus; note?: string }[] = [];
  for (const [studentId, status] of Object.entries(draft)) {
    if (!onRoster.has(studentId)) continue;
    if (!ATTENDANCE_STATUSES.includes(status)) continue;
    out.push({ studentId, status, ...(trimmed ? { note: trimmed } : {}) });
  }
  return out;
}

/**
 * Roster display order: students WITH a roll number first, in roll order, then
 * the unplaced ones by student number. A missing roll number must not sort ahead
 * of roll 01 just because the empty string compares smaller.
 */
export function sortRoster(entries: readonly AttendanceRosterEntry[]): AttendanceRosterEntry[] {
  return [...entries].sort((a, b) => {
    if (a.rollNo !== b.rollNo) {
      if (a.rollNo === null) return 1;
      if (b.rollNo === null) return -1;
      return a.rollNo < b.rollNo ? -1 : 1;
    }
    return a.studentNo < b.studentNo ? -1 : a.studentNo > b.studentNo ? 1 : 0;
  });
}

export function studentName(student: {
  firstName: string;
  lastName: string;
}): string {
  return `${student.firstName} ${student.lastName}`.trim();
}

/** Newest day first for the portal history; ties resolved by id for stability. */
export function sortAttendanceRecords(records: readonly AttendanceDay[]): AttendanceDay[] {
  return [...records].sort((a, b) => {
    if (a.attendanceDate !== b.attendanceDate) return a.attendanceDate < b.attendanceDate ? 1 : -1;
    return a.id < b.id ? 1 : -1;
  });
}

export function pendingLeaveRequests(requests: readonly LeaveRequest[]): LeaveRequest[] {
  return requests.filter((r) => r.status === 'pending');
}

/** A leave window is a single day when both ends match, otherwise a range. */
export function leaveWindowLabel(request: {
  startDate: string;
  endDate: string;
}): string {
  return request.startDate === request.endDate
    ? request.startDate
    : `${request.startDate} → ${request.endDate}`;
}

export function isLeaveWindowPast(request: { endDate: string }, today: string): boolean {
  return request.endDate < today;
}

/** Honest empty states — never a fake success screen. */
export function portalEmptyMessage(role: AttendanceContextRole): string {
  switch (role) {
    case 'parent':
      return 'You are not linked to any enrolled children yet. Parents see attendance for the students they are a guardian of.';
    case 'student':
      return 'No student record is linked to this portal account yet. Ask the school to link it.';
    case 'teacher':
      return 'No students are assigned to you yet, so there is no register to take.';
    case 'staff':
      return 'No students are enrolled in this school yet.';
    default:
      return 'This account has no attendance access in this school.';
  }
}
