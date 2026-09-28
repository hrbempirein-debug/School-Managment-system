import { describe, it, expect } from 'vitest';
import type {
  AttendanceDay,
  AttendanceRosterEntry,
  LeaveRequest,
} from '@sms/contracts';
import {
  ATTENDANCE_STATUSES,
  EMPTY_COUNTS,
  attendanceStatusLabel,
  buildDraftEntries,
  buildMarkEntries,
  clampPortalRange,
  isLeaveWindowPast,
  isValidIsoDate,
  leaveStatusLabel,
  leaveWindowLabel,
  markingAllowedFor,
  markingBlockedReason,
  pendingLeaveRequests,
  portalEmptyMessage,
  portalRange,
  rosterProgress,
  shiftIsoDate,
  sortAttendanceRecords,
  sortRoster,
  studentName,
  tallyRoster,
  unmarkedEntries,
} from './attendance';

const entry = (
  studentId: string,
  status: AttendanceRosterEntry['status'],
  rollNo: string | null = null,
  studentNo = studentId,
): AttendanceRosterEntry => ({
  studentId,
  studentNo,
  firstName: `First${studentId}`,
  lastName: `Last${studentId}`,
  rollNo,
  status,
  attendanceId: status === null ? null : `att-${studentId}`,
});

const day = (attendanceDate: string, id: string): AttendanceDay => ({
  id,
  tenantId: 't1',
  studentId: 's1',
  campusId: null,
  attendanceDate,
  status: 'present',
  source: 'manual',
  markedBy: 'u1',
  note: null,
  createdAt: `${attendanceDate}T00:00:00.000Z`,
  updatedAt: `${attendanceDate}T00:00:00.000Z`,
});

const leave = (id: string, status: LeaveRequest['status']): LeaveRequest => ({
  id,
  tenantId: 't1',
  studentId: 's1',
  leaveTypeId: 'lt1',
  startDate: '2026-09-20',
  endDate: '2026-09-22',
  reason: null,
  status,
  requestedBy: 'u1',
  approverUserId: status === 'pending' ? null : 'u2',
  decisionAt: status === 'pending' ? null : '2026-09-19T00:00:00.000Z',
  decisionNote: null,
  createdAt: '2026-09-18T00:00:00.000Z',
  updatedAt: '2026-09-18T00:00:00.000Z',
});

describe('attendance status labels', () => {
  it('labels every contract status and the staff-only one', () => {
    expect(ATTENDANCE_STATUSES).toEqual(['present', 'absent', 'late', 'excused']);
    expect(attendanceStatusLabel('present')).toBe('Present');
    expect(attendanceStatusLabel('on_leave')).toBe('On leave');
  });

  it('never invents a label for a null or unknown status', () => {
    expect(attendanceStatusLabel(null)).toBe('Unmarked');
    expect(attendanceStatusLabel('nope')).toBe('Unmarked');
    expect(attendanceStatusLabel(7)).toBe('Unmarked');
  });

  it('labels leave statuses and falls back for unknown input', () => {
    expect(leaveStatusLabel('pending')).toBe('Pending');
    expect(leaveStatusLabel('approved')).toBe('Approved');
    expect(leaveStatusLabel('rejected')).toBe('Rejected');
    expect(leaveStatusLabel(undefined)).toBe('—');
  });
});

describe('iso date helpers', () => {
  it('shifts across a month boundary', () => {
    expect(shiftIsoDate('2026-09-01', -1)).toBe('2026-08-31');
    expect(shiftIsoDate('2026-12-31', 1)).toBe('2027-01-01');
    expect(shiftIsoDate('2026-03-01', -1)).toBe('2026-02-28');
  });

  it('validates the YYYY-MM-DD shape the API requires', () => {
    expect(isValidIsoDate('2026-09-25')).toBe(true);
    expect(isValidIsoDate('2026-9-25')).toBe(false);
    expect(isValidIsoDate('25-09-2026')).toBe(false);
    expect(isValidIsoDate('')).toBe(false);
    expect(isValidIsoDate(null)).toBe(false);
  });
});

describe('marking window rules', () => {
  it('allows marking only for today', () => {
    expect(markingAllowedFor('2026-09-25', '2026-09-25')).toBe(true);
    expect(markingAllowedFor('2026-09-24', '2026-09-25')).toBe(false);
    expect(markingAllowedFor('2026-09-26', '2026-09-25')).toBe(false);
  });

  it('explains WHY a date is not markable instead of just disabling the button', () => {
    expect(markingBlockedReason('2026-09-25', '2026-09-25')).toBeNull();
    expect(markingBlockedReason('2026-09-26', '2026-09-25')).toMatch(/future/i);
    expect(markingBlockedReason('2026-09-24', '2026-09-25')).toMatch(/correction/i);
  });
});

describe('portal range', () => {
  it('defaults to a 30-day window ending today', () => {
    expect(portalRange('2026-09-25')).toEqual({ from: '2026-08-27', to: '2026-09-25' });
  });

  it('keeps a valid explicit range', () => {
    expect(portalRange('2026-09-25', '2026-09-01', '2026-09-10')).toEqual({
      from: '2026-09-01',
      to: '2026-09-10',
    });
  });

  it('falls back to the default when only one end is given or the order is wrong', () => {
    expect(portalRange('2026-09-25', '2026-09-01')).toEqual({
      from: '2026-08-27',
      to: '2026-09-25',
    });
    expect(portalRange('2026-09-25', '2026-09-20', '2026-09-01')).toEqual({
      from: '2026-08-27',
      to: '2026-09-25',
    });
  });

  it('clamps a typed range to the 180-day server bound', () => {
    const clamped = clampPortalRange('2020-01-01', '2026-09-25', '2026-09-25');
    expect(clamped.from).toBe(shiftIsoDate('2026-09-25', -179));
    expect(clamped.to).toBe('2026-09-25');
  });

  it('collapses an inverted typed range instead of sending from > to', () => {
    expect(clampPortalRange('2026-09-20', '2026-09-01', '2026-09-25')).toEqual({
      from: '2026-09-01',
      to: '2026-09-01',
    });
  });
});

describe('roster tally', () => {
  it('counts a null status as unmarked, never as present', () => {
    const counts = tallyRoster([
      entry('s1', 'present'),
      entry('s2', 'present'),
      entry('s3', 'absent'),
      entry('s4', null),
    ]);
    expect(counts).toEqual({ present: 2, absent: 1, late: 0, excused: 0, unmarked: 1 });
  });

  it('does not mutate the shared EMPTY_COUNTS constant', () => {
    const counts = tallyRoster([entry('s1', 'late')]);
    expect(counts.late).toBe(1);
    expect(EMPTY_COUNTS.late).toBe(0);
  });

  it('tallies an empty roster to all zeroes', () => {
    expect(tallyRoster([])).toEqual(EMPTY_COUNTS);
  });

  it('reports progress and completeness for the register header', () => {
    expect(rosterProgress([entry('s1', 'present'), entry('s2', null)])).toEqual({
      total: 2,
      marked: 1,
      complete: false,
    });
    expect(rosterProgress([]).complete).toBe(false);
    expect(rosterProgress([entry('s1', 'present')]).complete).toBe(true);
  });

  it('lists the students still to be marked', () => {
    const unmarked = unmarkedEntries([entry('s1', 'late'), entry('s2', null), entry('s3', null)]);
    expect(unmarked.map((e) => e.studentId)).toEqual(['s2', 's3']);
  });
});

describe('buildMarkEntries', () => {
  const roster = [entry('s1', null), entry('s2', 'absent'), entry('s3', null)];

  it('marks only the selected students, in roster order', () => {
    const built = buildMarkEntries(roster, ['s3', 's1'], 'present');
    expect(built).toEqual([
      { studentId: 's1', status: 'present' },
      { studentId: 's3', status: 'present' },
    ]);
  });

  it('ignores ids that are not on the roster (no cross-section mass mark)', () => {
    const built = buildMarkEntries(roster, ['s1', 'someone-else'], 'late');
    expect(built.map((e) => e.studentId)).toEqual(['s1']);
  });

  it('adds the note only when it is non-blank and within the contract limit', () => {
    expect(buildMarkEntries(roster, ['s1'], 'absent', '  illness  ')[0]!.note).toBe('illness');
    expect(buildMarkEntries(roster, ['s1'], 'absent', '   ')[0]!.note).toBeUndefined();
    expect(buildMarkEntries(roster, ['s1'], 'absent')[0]!.note).toBeUndefined();
  });

  it('returns an empty array for an empty selection so the caller can block it', () => {
    expect(buildMarkEntries(roster, [], 'present')).toEqual([]);
  });
});

describe('buildDraftEntries', () => {
  const roster = [entry('s1', null), entry('s2', null), entry('s3', null)];

  it('pairs every status with its OWN student id', () => {
    expect(buildDraftEntries(roster, { s1: 'present', s3: 'absent' })).toEqual([
      { studentId: 's1', status: 'present' },
      { studentId: 's3', status: 'absent' },
    ]);
  });

  it('keeps the pairing correct when a draft id is not on the roster', () => {
    // The regression this guards: re-deriving the selection and zipping it
    // against the draft would put 'absent' on s2 instead of on s3.
    const built = buildDraftEntries(roster, { s1: 'present', s2: 'absent', ghost: 'late', s3: 'excused' });
    expect(built).toEqual([
      { studentId: 's1', status: 'present' },
      { studentId: 's2', status: 'absent' },
      { studentId: 's3', status: 'excused' },
    ]);
  });

  it('drops an id that is not on the roster so a section cannot be marked from outside', () => {
    const built = buildDraftEntries(roster, { ghost: 'present' });
    expect(built).toEqual([]);
  });

  it('ignores a draft value that is not a contract status', () => {
    const built = buildDraftEntries(roster, { s1: 'on_leave' as never });
    expect(built).toEqual([]);
  });

  it('attaches a trimmed note only when there is one', () => {
    expect(buildDraftEntries(roster, { s1: 'late' }, '  bus delay ')[0]!.note).toBe('bus delay');
    expect(buildDraftEntries(roster, { s1: 'late' }, '   ')[0]!.note).toBeUndefined();
  });

  it('returns an empty array for an empty draft', () => {
    expect(buildDraftEntries(roster, {})).toEqual([]);
  });
});

describe('roster ordering', () => {
  it('sorts by roll number, then student number, and does not mutate the input', () => {
    const input = [entry('s3', null, null, 'B-3'), entry('s1', null, '02', 'A-1'), entry('s2', null, '01', 'A-2')];
    const sorted = sortRoster(input);
    expect(sorted.map((e) => e.studentId)).toEqual(['s2', 's1', 's3']);
    expect(input.map((e) => e.studentId)).toEqual(['s3', 's1', 's2']);
  });

  it('builds a display name', () => {
    expect(studentName({ firstName: 'Ada', lastName: 'Lovelace' })).toBe('Ada Lovelace');
  });
});

describe('portal record ordering', () => {
  it('shows the most recent day first', () => {
    const sorted = sortAttendanceRecords([day('2026-09-20', 'a'), day('2026-09-25', 'c'), day('2026-09-22', 'b')]);
    expect(sorted.map((r) => r.attendanceDate)).toEqual(['2026-09-25', '2026-09-22', '2026-09-20']);
  });

  it('breaks ties on the same day deterministically', () => {
    const sorted = sortAttendanceRecords([day('2026-09-25', 'a'), day('2026-09-25', 'c')]);
    expect(sorted.map((r) => r.id)).toEqual(['c', 'a']);
  });
});

describe('leave helpers', () => {
  it('keeps only pending requests in the review queue', () => {
    const requests = [leave('l1', 'pending'), leave('l2', 'approved'), leave('l3', 'rejected'), leave('l4', 'pending')];
    expect(pendingLeaveRequests(requests).map((r) => r.id)).toEqual(['l1', 'l4']);
  });

  it('renders a single day as one date and a range as a span', () => {
    expect(leaveWindowLabel({ startDate: '2026-09-20', endDate: '2026-09-20' })).toBe('2026-09-20');
    expect(leaveWindowLabel({ startDate: '2026-09-20', endDate: '2026-09-22' })).toBe('2026-09-20 → 2026-09-22');
  });

  it('knows when a leave window has closed', () => {
    expect(isLeaveWindowPast({ endDate: '2026-09-24' }, '2026-09-25')).toBe(true);
    expect(isLeaveWindowPast({ endDate: '2026-09-25' }, '2026-09-25')).toBe(false);
    expect(isLeaveWindowPast({ endDate: '2026-09-26' }, '2026-09-25')).toBe(false);
  });
});

describe('portal empty states', () => {
  it('gives an honest, distinct message per role', () => {
    const messages = (['staff', 'teacher', 'parent', 'student', 'none'] as const).map(portalEmptyMessage);
    expect(new Set(messages).size).toBe(5);
    expect(portalEmptyMessage('parent')).toMatch(/guardian/i);
    expect(portalEmptyMessage('student')).toMatch(/linked/i);
    expect(portalEmptyMessage('none')).toMatch(/no attendance access/i);
  });
});
