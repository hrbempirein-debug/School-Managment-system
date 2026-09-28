import { describe, it, expect } from 'vitest';
import type { Period, TimetableEntry, TimetableConflict } from '@sms/contracts';
import { WEEKDAY_LABELS, weekdayLabel, periodMarker, gridKey, gridRows, describeConflicts } from './timetable';

const period = (id: string, periodNo: number, startTime: string, endTime: string): Period => ({
  id,
  tenantId: 't',
  campusId: null,
  name: `P${periodNo}`,
  periodNo,
  startTime,
  endTime,
  status: 'active',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
});

const entry = (id: string, weekday: number, periodId: string): TimetableEntry => ({
  id,
  tenantId: 't',
  classId: 'c',
  sectionId: 's',
  subjectId: 'subj',
  teacherUserId: 'teacher',
  periodId,
  campusId: 'campus',
  academicYearId: 'year',
  weekday,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
});

describe('timetable grid helpers', () => {
  it('labels weekdays ISO-style (1 = Monday)', () => {
    expect(WEEKDAY_LABELS[0]).toBe('Mon');
    expect(weekdayLabel(1)).toBe('Mon');
    expect(weekdayLabel(7)).toBe('Sun');
    expect(weekdayLabel(9)).toBe('9');
  });

  it('renders a period time marker from the raw time fields', () => {
    expect(periodMarker(period('p', 1, '08:00', '08:45'))).toBe('08:00 – 08:45');
  });

  it('keys a cell by weekday:periodId', () => {
    expect(gridKey(3, 'p1')).toBe('3:p1');
  });

  it('projects entries onto a full weekday × period grid ordered by periodNo', () => {
    const p1 = period('p1', 1, '08:00', '08:45');
    const p2 = period('p2', 2, '09:00', '09:45');
    const rows = gridRows([entry('e1', 1, 'p2'), entry('e2', 2, 'p1')], [p2, p1]);

    expect(rows.map((r) => r.period.id)).toEqual(['p1', 'p2']);
    expect(rows[0]!.cells).toHaveLength(7);
    expect(rows[0]!.cells[1]!.entry?.id).toBe('e2');
    expect(rows[1]!.cells[0]!.entry?.id).toBe('e1');
    expect(rows[0]!.cells[0]!.entry).toBeNull();
  });

  it('summarizes publish conflicts per weekday', () => {
    const conflicts: TimetableConflict[] = [
      { weekday: 1, teacherUserId: 't1', entryCount: 2 },
      { weekday: 3, teacherUserId: 't2', entryCount: 3 },
    ];
    expect(describeConflicts([])).toBe('No conflicts');
    expect(describeConflicts(conflicts)).toContain('Mon');
    expect(describeConflicts(conflicts)).toContain('Wed');
    expect(describeConflicts(conflicts)).toContain('2 entries share one teacher');
  });
});