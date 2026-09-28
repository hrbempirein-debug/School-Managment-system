import type {
  ExamStatus,
  GradebookRow,
  GradingScaleBand,
  MarkStatus,
  ReportCard,
  TranscriptEntry,
} from '@sms/contracts';

/**
 * Phase 6 exams + results UI helpers. Everything here is a pure function so the
 * gradebook, the publish flow and the family result views are unit-testable
 * without a browser or an API.
 *
 * Three rules from the roadmap are encoded here rather than left to each screen:
 *  1. the grade band lookup mirrors the DATABASE rule exactly (half-open
 *     [min, max) with the top band closed at 100), so a preview never disagrees
 *     with the grade the trigger stored;
 *  2. a published gradebook is READ-ONLY in the UI — correction is a separate,
 *     reasoned action, never an edit in the grid;
 *  3. tallies are derived from the rows the server sent, never accumulated in
 *     component state, so the UI cannot over-count what was saved.
 */

export const EXAM_STATUS_LABELS: Record<ExamStatus, string> = {
  draft: 'Draft',
  scheduled: 'Scheduled',
  grading: 'Grading',
  published: 'Published',
  cancelled: 'Cancelled',
};

export const MARK_STATUS_LABELS: Record<MarkStatus, string> = {
  provisional: 'Provisional',
  locked: 'Locked',
  rechecked: 'Rechecked',
};

export const REPORT_CARD_STATUS_LABELS: Record<ReportCard['status'], string> = {
  draft: 'Draft',
  published: 'Published',
};

export function examStatusLabel(status: unknown): string {
  if (typeof status === 'string' && status in EXAM_STATUS_LABELS) {
    return EXAM_STATUS_LABELS[status as ExamStatus];
  }
  return 'Unknown';
}

export function markStatusLabel(status: unknown): string {
  if (typeof status === 'string' && status in MARK_STATUS_LABELS) {
    return MARK_STATUS_LABELS[status as MarkStatus];
  }
  return 'Unknown';
}

export function reportCardStatusLabel(status: unknown): string {
  if (typeof status === 'string' && status in REPORT_CARD_STATUS_LABELS) {
    return REPORT_CARD_STATUS_LABELS[status as ReportCard['status']];
  }
  return 'Unknown';
}

/** The database's own band rule, mirrored for optimistic display only. */
export function gradeForPercent(
  bands: readonly GradingScaleBand[],
  percent: number | null,
): GradingScaleBand | null {
  if (percent === null || !Number.isFinite(percent)) return null;
  for (const band of bands) {
    const inRange =
      percent >= band.minPercent &&
      (percent < band.maxPercent || (band.maxPercent === 100 && percent === 100));
    if (inRange) return band;
  }
  return null;
}

export interface MarkInputResult {
  ok: boolean;
  value: number | null;
  reason?: string;
}

/**
 * Parse a gradebook cell. Blank means "not graded" (a null mark, which is a
 * legitimate value), and anything outside `[0, maxMarks]` is refused in the UI so
 * the teacher gets the reason immediately instead of a 409 from the trigger.
 */
export function parseMarkInput(raw: string, maxMarks: number): MarkInputResult {
  const trimmed = raw.trim();
  if (trimmed === '') return { ok: true, value: null };
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) return { ok: false, value: null, reason: 'Enter a number' };
  if (parsed < 0) return { ok: false, value: null, reason: 'Marks cannot be negative' };
  if (parsed > maxMarks) {
    return { ok: false, value: null, reason: `Marks cannot exceed ${maxMarks}` };
  }
  return { ok: true, value: parsed };
}

export interface GradebookProgress {
  total: number;
  entered: number;
  ungraded: number;
  remaining: number;
  complete: boolean;
}

/** Progress over the rows the server sent — never accumulated in component state. */
export function gradebookProgress(rows: readonly GradebookRow[]): GradebookProgress {
  const total = rows.length;
  let entered = 0;
  let ungraded = 0;
  for (const row of rows) {
    if (row.marksObtained === null) ungraded += 1;
    else entered += 1;
  }
  const remaining = total - entered;
  return { total, entered, ungraded, remaining, complete: total > 0 && remaining === 0 };
}

export interface MarkEntryGate {
  allowed: boolean;
  reason: string | null;
}

/**
 * Whether the grid may be saved. A published exam is locked, and a teacher who
 * does not own the class subject has no business saving — the server enforces
 * both, and the UI refuses to pretend otherwise.
 */
export function markEntryGate(locked: boolean, canMark: boolean): MarkEntryGate {
  if (locked) {
    return { allowed: false, reason: 'This exam is published — use the correction workflow' };
  }
  if (!canMark) {
    return { allowed: false, reason: 'You can only enter marks for your own class subjects' };
  }
  return { allowed: true, reason: null };
}

export interface MarkEntry {
  enrollmentId: string;
  marksObtained: number | null;
}

export interface CellValidation {
  invalid: Record<string, string>;
  entries: MarkEntry[];
}

/**
 * Validate a whole draft against each row's own `maxMarks` and build the payload.
 * Returns the per-cell errors so the grid can mark the offending input rather
 * than failing the entire save.
 */
export function validateMarkDraft(
  rows: readonly GradebookRow[],
  maxMarks: number,
  draft: Readonly<Record<string, string>>,
): CellValidation {
  const invalid: Record<string, string> = {};
  const entries: MarkEntry[] = [];
  for (const row of rows) {
    const raw = draft[row.enrollmentId] ?? '';
    const parsed = parseMarkInput(raw, maxMarks);
    if (!parsed.ok) {
      invalid[row.enrollmentId] = parsed.reason ?? 'Invalid mark';
      continue;
    }
    entries.push({ enrollmentId: row.enrollmentId, marksObtained: parsed.value });
  }
  return { invalid, entries };
}

export function cellText(row: GradebookRow): string {
  return row.marksObtained === null ? '' : String(row.marksObtained);
}

/** Roster order: roll number first, then name — the order a register prints. */
export function sortGradebookRows(rows: readonly GradebookRow[]): GradebookRow[] {
  return [...rows].sort((a, b) => {
    if (a.rollNo && b.rollNo) return a.rollNo.localeCompare(b.rollNo, undefined, { numeric: true });
    if (a.rollNo) return -1;
    if (b.rollNo) return 1;
    return a.studentName.localeCompare(b.studentName);
  });
}

/** Mirrors `trg_exams_lifecycle_validate()` in migration 0015. Published is
 * terminal and `cancelled` is reachable from every pre-publication state. */
export const EXAM_TRANSITIONS: Record<ExamStatus, readonly ExamStatus[]> = {
  draft: ['scheduled', 'grading', 'cancelled'],
  scheduled: ['grading', 'cancelled'],
  grading: ['scheduled', 'cancelled'],
  published: [],
  cancelled: [],
};

/** The lifecycle a principal may drive from the UI (publication is separate). */
export function allowedExamTransitions(status: ExamStatus): readonly ExamStatus[] {
  return EXAM_TRANSITIONS[status] ?? [];
}

export function canTransitionExam(status: ExamStatus, target: ExamStatus): boolean {
  return allowedExamTransitions(status).includes(target);
}

/** Publication additionally needs at least one subject and a non-cancelled exam. */
export function publishGate(exam: {
  status: ExamStatus;
  subjects: number;
  marksEntered: number;
}): MarkEntryGate {
  if (exam.status === 'published') {
    return { allowed: false, reason: 'This exam is already published' };
  }
  if (exam.status === 'cancelled') {
    return { allowed: false, reason: 'A cancelled exam cannot be published' };
  }
  if (exam.subjects === 0) {
    return { allowed: false, reason: 'Add at least one exam subject first' };
  }
  if (exam.marksEntered === 0) {
    return { allowed: false, reason: 'Enter at least one mark before publishing' };
  }
  return { allowed: true, reason: null };
}

export function formatPercent(value: number | null): string {
  return value === null ? '—' : `${value.toFixed(2)}%`;
}

export function formatGpa(value: number | null): string {
  return value === null ? '—' : value.toFixed(2);
}

/** Trim trailing zeros so a whole mark reads "80" and a half mark reads "72.5". */
function compact(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0+$/, '');
}

export function formatTotal(obtained: number | null, possible: number): string {
  return `${obtained === null ? '—' : compact(obtained)} / ${compact(possible)}`;
}

export interface TranscriptTotals {
  exams: number;
  graded: number;
  averageGpa: number | null;
  averagePercent: number | null;
}

/** Transcript roll-up across published results only. */
export function transcriptTotals(entries: readonly TranscriptEntry[]): TranscriptTotals {
  const graded = entries.filter((e) => e.totalObtained !== null);
  const gpas = graded.map((e) => e.gpa).filter((g): g is number => g !== null);
  const percents = graded
    .filter((e) => e.totalObtained !== null && e.totalPossible > 0)
    .map((e) => (e.totalObtained! / e.totalPossible) * 100);
  const mean = (values: number[]): number | null =>
    values.length === 0 ? null : Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 100) / 100;
  return {
    exams: entries.length,
    graded: graded.length,
    averageGpa: mean(gpas),
    averagePercent: mean(percents),
  };
}

/** Bands must tile 0..100 with no gap or overlap — checked before the API call. */
export function validateBands(bands: readonly GradingScaleBand[]): string | null {
  if (bands.length === 0) return 'Add at least one band';
  const sorted = [...bands].sort((a, b) => a.minPercent - b.minPercent);
  let cursor = 0;
  for (const band of sorted) {
    if (band.minPercent !== cursor) {
      return cursor === 0
        ? 'The first band must start at 0'
        : `Bands must be contiguous: expected ${cursor}, got ${band.minPercent}`;
    }
    if (band.maxPercent <= band.minPercent) return 'Each band must end above where it starts';
    cursor = band.maxPercent;
  }
  if (cursor !== 100) return 'The last band must end at 100';
  return null;
}
