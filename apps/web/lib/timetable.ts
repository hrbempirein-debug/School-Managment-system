import type { Period, TimetableEntry, TimetableConflict } from '@sms/contracts';

/** ISO weekday labels (1 = Monday .. 7 = Sunday), matching the API contract. */
export const WEEKDAY_LABELS: readonly string[] = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export function weekdayLabel(weekday: number): string {
  return WEEKDAY_LABELS[weekday - 1] ?? String(weekday);
}

/** "08:00 – 08:45" marker for a grid column/row, straight from the `time` fields. */
export function periodMarker(period: Period): string {
  return `${period.startTime} – ${period.endTime}`;
}

/** A grid cell is identified by (weekday, periodId) — one lesson per slot. */
export function gridKey(weekday: number, periodId: string): string {
  return `${weekday}:${periodId}`;
}

export interface GridCell {
  key: string;
  weekday: number;
  period: Period;
  entry: TimetableEntry | null;
}

export interface GridRow {
  period: Period;
  cells: GridCell[];
}

/**
 * Project live entries onto the (weekday × period) grid. Rows are ordered by
 * periodNo; columns are filled for every weekday so the weekly shape is always
 * full. A cell holds at most one entry (the DB unique index enforces it).
 */
export function gridRows(
  entries: readonly TimetableEntry[],
  periods: readonly Period[],
  weekdays: readonly number[] = [1, 2, 3, 4, 5, 6, 7],
): GridRow[] {
  const byCell = new Map<string, TimetableEntry>();
  for (const entry of entries) byCell.set(gridKey(entry.weekday, entry.periodId), entry);
  const sorted = [...periods].slice().sort((a, b) => a.periodNo - b.periodNo);
  return sorted.map((period) => ({
    period,
    cells: weekdays.map((weekday) => ({
      key: gridKey(weekday, period.id),
      weekday,
      period,
      entry: byCell.get(gridKey(weekday, period.id)) ?? null,
    })),
  }));
}

/** One-line summary of publish conflicts, e.g. "Mon: teacher double-booked (2)". */
export function describeConflicts(conflicts: readonly TimetableConflict[]): string {
  if (conflicts.length === 0) return 'No conflicts';
  return conflicts
    .map((c) => `${weekdayLabel(c.weekday)}: ${c.entryCount} entries share one teacher`)
    .join('; ');
}