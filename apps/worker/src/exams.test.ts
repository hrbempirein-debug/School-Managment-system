import { describe, expect, it } from 'vitest';
import { sameSnapshot, type SnapshotLine } from './exams.js';
import { renderReportCardPdf } from './report-pdf.js';

/**
 * Phase 6 worker unit proofs.
 *
 * The result pipeline's arithmetic no longer lives here: the per-subject grade is
 * copied from the mark (the `marks` trigger owns it) and the card aggregate is
 * computed by `fn_report_card_totals` in the database, so the worker stores what
 * the database derives rather than re-deriving it in JavaScript and hoping the two
 * agree. Those rules are proven against the real database in
 * `packages/db/src/security/phase6-exams.test.ts` and in
 * `exams-result-pipeline.test.ts`.
 *
 * What is left here is the convergence predicate - the decision that stops a
 * redelivered `exam.result.compute` from minting a duplicate published version, and
 * that makes it mint a NEW one when the document really changed.
 */

const line = (over: Partial<SnapshotLine> & { examSubjectId: string }): SnapshotLine => ({
  subjectId: `sub-${over.examSubjectId}`,
  subjectName: `Subject ${over.examSubjectId}`,
  marksObtained: '70.00',
  maxMarks: '100.00',
  weight: '1.000',
  percentage: '70.00',
  gradeLabel: 'C',
  gradePoint: '3.00',
  ...over,
});

const MATHS = line({ examSubjectId: 'es-maths' });
const PHYSICS = line({ examSubjectId: 'es-physics', subjectName: 'Subject es-physics', maxMarks: '40.00' });

describe('sameSnapshot (outbox redelivery convergence)', () => {
  it('treats a recomputed identical document as unchanged', () => {
    expect(sameSnapshot([MATHS, PHYSICS], [line({ examSubjectId: 'es-maths' }), line({ examSubjectId: 'es-physics', subjectName: 'Subject es-physics', maxMarks: '40.00' })])).toBe(
      true,
    );
  });

  it('compares NUMERIC as numbers, not as text', () => {
    // "70" and "70.00" are one mark. A string comparison would call this a
    // correction and mint a duplicate version on every redelivery.
    expect(sameSnapshot([line({ examSubjectId: 'es-maths', marksObtained: '70', percentage: '70' })], [MATHS])).toBe(
      true,
    );
  });

  it('detects a corrected mark as a change', () => {
    expect(sameSnapshot([MATHS], [line({ examSubjectId: 'es-maths', marksObtained: '40.00', percentage: '40.00', gradeLabel: 'B', gradePoint: '2.00' })])).toBe(
      false,
    );
  });

  it('detects a regrade as a change even when the total is identical', () => {
    // Same score, new scale bands: the label moved, so a new version is owed.
    expect(sameSnapshot([MATHS], [line({ examSubjectId: 'es-maths', gradeLabel: 'B', gradePoint: '2.00' })])).toBe(
      false,
    );
  });

  it('detects a new subject as a change even when the totals happen to match', () => {
    // The B2 shape: the aggregate can be unchanged while the document is not. Two
    // lines that sum to the same total on the same weighted grade are a different
    // card, and a totals-only comparison silently discards the correction.
    const stored = [line({ examSubjectId: 'es-a', marksObtained: '100.00', percentage: '100.00', gradeLabel: 'A', gradePoint: '4.00', maxMarks: '100.00', weight: '1.000' })];
    const candidate = [
      line({ examSubjectId: 'es-b', marksObtained: '60.00', percentage: '60.00', gradeLabel: 'C', gradePoint: '4.00', maxMarks: '60.00', weight: '1.000' }),
      line({ examSubjectId: 'es-c', marksObtained: '40.00', percentage: '100.00', gradeLabel: 'A', gradePoint: '4.00', maxMarks: '40.00', weight: '1.000' }),
    ];
    // Same total (100) and the same grade point, one line instead of two.
    expect(sameSnapshot(stored, candidate)).toBe(false);
  });

  it('detects a denominator change as a change', () => {
    expect(sameSnapshot([MATHS], [line({ examSubjectId: 'es-maths', maxMarks: '50.00', percentage: '140.00' })])).toBe(
      false,
    );
  });

  it('detects a renamed subject, which changes the printed document', () => {
    expect(sameSnapshot([MATHS], [line({ examSubjectId: 'es-maths', subjectName: 'Advanced Maths' })])).toBe(
      false,
    );
  });

  it('does not confuse a blank line with a zero', () => {
    const blank = line({
      examSubjectId: 'es-maths',
      marksObtained: null,
      percentage: null,
      gradeLabel: null,
      gradePoint: null,
    });
    const zero = line({ examSubjectId: 'es-maths', marksObtained: '0.00', gradeLabel: 'A', gradePoint: '1.00' });
    expect(sameSnapshot([blank], [zero])).toBe(false);
    expect(sameSnapshot([blank], [blank])).toBe(true);
  });

  it('sees an added and a removed line', () => {
    expect(sameSnapshot([MATHS], [MATHS, PHYSICS])).toBe(false);
    expect(sameSnapshot([MATHS, PHYSICS], [MATHS])).toBe(false);
  });

  it('treats two empty documents as the same', () => {
    expect(sameSnapshot([], [])).toBe(true);
  });
});

describe('renderReportCardPdf', () => {
  const lines = [
    { text: 'Report card', kind: 'title' as const },
    { text: 'Student: Ada Lovelace' },
    { text: 'Term 1 — Total 190 / 200 — GPA 3.70' },
  ];

  it('emits a single-file PDF 1.4 with a correct xref trailer', () => {
    const pdf = renderReportCardPdf(lines).toString('latin1');
    expect(pdf.startsWith('%PDF-1.4')).toBe(true);
    expect(pdf).toContain('%%EOF');
    const startxref = pdf.slice(pdf.lastIndexOf('startxref'));
    const offset = Number(startxref.split(/\s+/)[1]);
    expect(pdf.slice(offset, offset + 4)).toBe('xref');
  });

  it('is deterministic, so a redelivered job renders byte-identical output', () => {
    expect(renderReportCardPdf(lines).equals(renderReportCardPdf(lines))).toBe(true);
  });

  it('escapes PDF delimiters in student-controlled text', () => {
    const pdf = renderReportCardPdf([{ text: 'Ada (Lovelace) \\ Study\\' }]).toString('latin1');
    expect(pdf).toContain('\\(Lovelace\\)');
    expect(pdf).toContain('\\\\');
  });

  it('drops non-ASCII rather than emitting a broken byte string', () => {
    const pdf = renderReportCardPdf([{ text: 'Ada — Lovelace' }]).toString('latin1');
    expect(pdf).not.toContain('—');
  });

  it('paginates a long roster instead of drawing off the page', () => {
    const many = Array.from({ length: 200 }, (_, i) => ({ text: `Subject ${i}: 90 / 100` }));
    const pdf = renderReportCardPdf(many).toString('latin1');
    const pages = pdf.split('/Type /Page /Parent').length - 1;
    expect(pages).toBeGreaterThan(1);
    expect(pdf).toContain(`/Count ${pages}`);
  });

  it('renders an empty card without throwing', () => {
    expect(renderReportCardPdf([]).length).toBeGreaterThan(0);
  });
});
