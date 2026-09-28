import { describe, expect, it } from 'vitest';
import type { GradebookRow, GradingScaleBand, TranscriptEntry } from '@sms/contracts';
import {
  EXAM_TRANSITIONS,
  allowedExamTransitions,
  cellText,
  canTransitionExam,
  examStatusLabel,
  formatGpa,
  formatPercent,
  formatTotal,
  gradeForPercent,
  gradebookProgress,
  markEntryGate,
  markStatusLabel,
  parseMarkInput,
  publishGate,
  reportCardStatusLabel,
  sortGradebookRows,
  transcriptTotals,
  validateBands,
  validateMarkDraft,
} from './exams';

const BANDS: GradingScaleBand[] = [
  { label: 'A', minPercent: 80, maxPercent: 100, gradePoint: 4 },
  { label: 'B', minPercent: 70, maxPercent: 80, gradePoint: 3 },
  { label: 'C', minPercent: 60, maxPercent: 70, gradePoint: 2 },
  { label: 'F', minPercent: 0, maxPercent: 60, gradePoint: 0 },
];

function row(over: Partial<GradebookRow> = {}): GradebookRow {
  return {
    enrollmentId: 'e1',
    studentId: 's1',
    studentName: 'Ada',
    sectionId: null,
    rollNo: '1',
    marksObtained: null,
    percentage: null,
    gradeLabel: null,
    gradePoint: null,
    status: 'provisional',
    ...over,
  };
}

describe('exam lifecycle labels', () => {
  it('labels every status and both directions of a transition', () => {
    expect(examStatusLabel('draft')).toBe('Draft');
    expect(examStatusLabel('scheduled')).toBe('Scheduled');
    expect(examStatusLabel('grading')).toBe('Grading');
    expect(examStatusLabel('published')).toBe('Published');
    expect(examStatusLabel('cancelled')).toBe('Cancelled');
  });

  it('treats published and cancelled as terminal states', () => {
    expect(allowedExamTransitions('published')).toEqual([]);
    expect(allowedExamTransitions('cancelled')).toEqual([]);
  });

  it('offers cancellation from every pre-publication status but never from published', () => {
    for (const status of ['draft', 'scheduled', 'grading'] as const) {
      expect(allowedExamTransitions(status)).toContain('cancelled');
      expect(allowedExamTransitions(status)).not.toContain('published');
    }
  });

  it('mirrors the trigger: publish only from a pre-publication status', () => {
    expect(canTransitionExam('scheduled', 'grading')).toBe(true);
    expect(canTransitionExam('grading', 'scheduled')).toBe(true);
    expect(canTransitionExam('published', 'draft')).toBe(false);
    expect(canTransitionExam('published', 'cancelled')).toBe(false);
    expect(canTransitionExam('grading', 'draft')).toBe(false);
    expect(EXAM_TRANSITIONS.draft).toEqual(['scheduled', 'grading', 'cancelled']);
  });
});

describe('publish gate', () => {
  it('blocks publication before any subject is attached', () => {
    const gate = publishGate({ status: 'grading', subjects: 0, marksEntered: 0 });
    expect(gate.allowed).toBe(false);
    expect(gate.reason).toBeTruthy();
  });

  it('blocks publication before any mark is entered', () => {
    const gate = publishGate({ status: 'grading', subjects: 2, marksEntered: 0 });
    expect(gate.allowed).toBe(false);
  });

  it('allows publication once a subject carries at least one entered mark', () => {
    // Per-cell completeness is the DB trigger's job; the client can only gate
    // on what the list response actually told it.
    expect(publishGate({ status: 'grading', subjects: 2, marksEntered: 1 })).toEqual({
      allowed: true,
      reason: null,
    });
  });

  it('refuses to re-publish a published or cancelled exam', () => {
    expect(publishGate({ status: 'published', subjects: 2, marksEntered: 2 }).allowed).toBe(false);
    expect(publishGate({ status: 'cancelled', subjects: 2, marksEntered: 2 }).allowed).toBe(false);
  });

  it('offers publication from every pre-publication state, as the trigger does', () => {
    // trg_exams_lifecycle_validate allows draft|scheduled|grading -> published;
    // the client must not be stricter than the database or it hides a legal move.
    for (const status of ['draft', 'scheduled', 'grading'] as const) {
      expect(publishGate({ status, subjects: 3, marksEntered: 3 }).allowed).toBe(true);
    }
  });
});

describe('mark input parsing', () => {
  it('accepts an empty cell as an absent mark and trims decimals', () => {
    expect(parseMarkInput('', 100)).toEqual({ ok: true, value: null });
    expect(parseMarkInput('  ', 100)).toEqual({ ok: true, value: null });
    expect(parseMarkInput('73.5', 100)).toEqual({ ok: true, value: 73.5 });
    expect(parseMarkInput('0', 100)).toEqual({ ok: true, value: 0 });
  });

  it('rejects a negative, non-numeric or out-of-range mark', () => {
    expect(parseMarkInput('-1', 100).ok).toBe(false);
    expect(parseMarkInput('abc', 100).ok).toBe(false);
    expect(parseMarkInput('101', 100).ok).toBe(false);
    expect(parseMarkInput('100.01', 100).ok).toBe(false);
  });

  it('rejects NaN and Infinity from an overflowing number', () => {
    expect(parseMarkInput('1e400', 100).ok).toBe(false);
  });
});

describe('gradebook helpers', () => {
  it('validates a whole grid and reports the offending rows only', () => {
    const rows = [row({ enrollmentId: 'a' }), row({ enrollmentId: 'b' }), row({ enrollmentId: 'c' })];
    const result = validateMarkDraft(rows, 100, { a: '90', b: '120', c: '' });
    expect(Object.keys(result.invalid)).toEqual(['b']);
    // an invalid cell is never put on the wire: the save is refused instead
    expect(result.entries.map((e) => e.enrollmentId)).toEqual(['a', 'c']);
    expect(result.entries.find((e) => e.enrollmentId === 'a')?.marksObtained).toBe(90);
    expect(result.entries.find((e) => e.enrollmentId === 'c')?.marksObtained).toBeNull();
  });

  it('excludes an out-of-range row from the payload and names it', () => {
    const rows = [row({ enrollmentId: 'a' }), row({ enrollmentId: 'b' })];
    const result = validateMarkDraft(rows, 50, { a: '999', b: '10' });
    expect(Object.keys(result.invalid)).toEqual(['a']);
    expect(result.entries.map((e) => e.enrollmentId)).toEqual(['b']);
  });

  it('sends a null mark for an untouched row so the server clears it', () => {
    const rows = [row({ enrollmentId: 'a', marksObtained: 30 })];
    const result = validateMarkDraft(rows, 50, {});
    expect(result.entries).toEqual([{ enrollmentId: 'a', marksObtained: null }]);
    expect(result.invalid).toEqual({});
  });

  it('summarises how much of the grid is entered', () => {
    const rows = [row({ marksObtained: 5 }), row({ marksObtained: null })];
    expect(gradebookProgress(rows)).toMatchObject({ total: 2, entered: 1, ungraded: 1, complete: false });
    expect(gradebookProgress([row({ marksObtained: 1 })])).toMatchObject({ complete: true });
    // an empty roster is never "complete" — there is nothing to publish
    expect(gradebookProgress([])).toMatchObject({ total: 0, complete: false });
  });

  it('sorts by roll number numerically with blank rolls last', () => {
    const rows = [
      row({ enrollmentId: 'x', rollNo: '10' }),
      row({ enrollmentId: 'y', rollNo: '2' }),
      row({ enrollmentId: 'z', rollNo: null }),
      row({ enrollmentId: 'w', rollNo: '1' }),
    ];
    expect(sortGradebookRows(rows).map((r) => r.enrollmentId)).toEqual(['w', 'y', 'x', 'z']);
  });

  it('seeds the edit buffer from the server row and round-trips', () => {
    const server = row({ marksObtained: 42.5, status: 'provisional' });
    expect(cellText(server)).toBe('42.5');
    expect(cellText(row({ marksObtained: null }))).toBe('');
    expect(markStatusLabel('provisional')).toBe('Provisional');
    expect(markStatusLabel('rechecked')).toBe('Rechecked');
  });

  it('gates mark entry on both the lock and the caller permission', () => {
    expect(markEntryGate(true, true).allowed).toBe(false);
    expect(markEntryGate(false, false).allowed).toBe(false);
    expect(markEntryGate(false, true).allowed).toBe(true);
  });
});

describe('grading scale helpers', () => {
  it('resolves a percentage to the half-open band that contains it', () => {
    expect(gradeForPercent(BANDS, 85)?.label).toBe('A');
    expect(gradeForPercent(BANDS, 80)?.label).toBe('A');
    expect(gradeForPercent(BANDS, 79.99)?.label).toBe('B');
    expect(gradeForPercent(BANDS, 60)?.label).toBe('C');
    expect(gradeForPercent(BANDS, 59.99)?.label).toBe('F');
  });

  it('returns no band when no scale is active or the value is missing', () => {
    expect(gradeForPercent([], 90)).toBeNull();
    expect(gradeForPercent(BANDS, null)).toBeNull();
  });

  it('accepts a tiling set of bands', () => {
    expect(validateBands(BANDS)).toBeNull();
  });

  it('rejects an empty band set, a non-100 ceiling, gaps and overlaps', () => {
    expect(validateBands([])).toBeTruthy();
    expect(validateBands([{ label: 'A', minPercent: 0, maxPercent: 90, gradePoint: 4 }])).toBeTruthy();
    expect(
      validateBands([
        { label: 'A', minPercent: 50, maxPercent: 100, gradePoint: 4 },
        { label: 'B', minPercent: 0, maxPercent: 50, gradePoint: 3 },
      ]),
    ).toBeNull();
    // gap: nothing covers 20–30
    expect(
      validateBands([
        { label: 'A', minPercent: 30, maxPercent: 100, gradePoint: 4 },
        { label: 'B', minPercent: 0, maxPercent: 20, gradePoint: 3 },
      ]),
    ).toBeTruthy();
    // overlap: both cover 70
    expect(
      validateBands([
        { label: 'A', minPercent: 70, maxPercent: 100, gradePoint: 4 },
        { label: 'B', minPercent: 0, maxPercent: 80, gradePoint: 3 },
      ]),
    ).toBeTruthy();
  });

  it('rejects an out-of-range or inverted band', () => {
    expect(
      validateBands([
        { label: 'A', minPercent: -1, maxPercent: 100, gradePoint: 4 },
        { label: 'B', minPercent: 0, maxPercent: 50, gradePoint: 3 },
      ]),
    ).toBeTruthy();
    expect(
      validateBands([
        { label: 'A', minPercent: 60, maxPercent: 50, gradePoint: 4 },
        { label: 'B', minPercent: 0, maxPercent: 60, gradePoint: 3 },
      ]),
    ).toBeTruthy();
  });
});

describe('formatting', () => {
  it('formats a null aggregate as an em dash rather than a misleading zero', () => {
    expect(formatGpa(null)).toBe('—');
    expect(formatPercent(null)).toBe('—');
    expect(formatTotal(null, 300)).toBe('— / 300');
  });

  it('formats a present aggregate to two decimals', () => {
    expect(formatGpa(3.6666)).toBe('3.67');
    expect(formatPercent(72.3456)).toBe('72.35%');
    expect(formatTotal(250, 300)).toBe('250 / 300');
    expect(formatTotal(72.5, 100)).toBe('72.5 / 100');
    expect(reportCardStatusLabel('draft')).toBe('Draft');
    expect(reportCardStatusLabel('published')).toBe('Published');
    expect(markStatusLabel('locked')).toBe('Locked');
  });

  it('rolls a transcript up over published results only', () => {
    const entry = (over: Partial<TranscriptEntry> = {}): TranscriptEntry => ({
      examId: 'e',
      examName: 'Mid-term',
      termName: 'Term 1',
      academicYearName: '2026',
      publishedAt: '2026-06-01T00:00:00.000Z',
      gpa: 3.5,
      totalObtained: 150,
      totalPossible: 200,
      subjectCount: 4,
      ...over,
    });
    expect(transcriptTotals([])).toEqual({
      exams: 0,
      graded: 0,
      averageGpa: null,
      averagePercent: null,
    });
    expect(
      transcriptTotals([entry(), entry({ gpa: 2.5, totalObtained: 100, totalPossible: 200 })]),
    ).toEqual({ exams: 2, graded: 2, averageGpa: 3, averagePercent: 62.5 });
    // an ungraded (null aggregate) exam counts as an exam but not as graded
    expect(transcriptTotals([entry(), entry({ gpa: null, totalObtained: null })])).toEqual({
      exams: 2,
      graded: 1,
      averageGpa: 3.5,
      averagePercent: 75,
    });
  });
});
