import { createHash } from 'node:crypto';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  academicTerms,
  enrollments,
  examSubjects,
  exams,
  files,
  guardians,
  marks,
  reportCards,
  reportCardSubjects,
  students,
  studentGuardians,
  subjects,
  users,
  type Tx,
} from '@sms/db';
import { writeAudit } from '@sms/audit';
import { enqueueOutbox } from '@sms/events';
import { studentReportCardJobSchema, type JobPayload, type OutboxEvent } from '@sms/contracts';
import type { StorageProvider } from '@sms/storage';
import { renderReportCardPdf, type ReportCardLine } from './report-pdf.js';

type Logger = (level: 'info' | 'warn' | 'error', msg: string, data?: unknown) => void;

export interface ExamHandlerDeps {
  tx: Tx;
  event: OutboxEvent;
  /** Registers a job to run AFTER the handler's transaction has committed. */
  defer: (job: JobPayload) => void;
}

export type ExamHandler = (deps: ExamHandlerDeps) => Promise<void>;

/** Channel used for the Phase 6 publication stub; Phase 8 owns real delivery. */
const PUBLISH_TEMPLATE = 'exam.result.published';

function tenantIdOf(event: OutboxEvent): string {
  const tenantId = typeof event.payload['tenantId'] === 'string' ? event.payload['tenantId'] : event.tenantId;
  if (!tenantId) throw new Error('exam event requires a tenantId');
  return tenantId;
}

function examIdOf(event: OutboxEvent): string {
  const examId = event.payload['examId'];
  if (typeof examId !== 'string') throw new Error("exam event requires a string 'examId' in payload");
  return examId;
}

function actorOf(event: OutboxEvent): string | null {
  return typeof event.payload['actorUserId'] === 'string' ? event.payload['actorUserId'] : null;
}

/**
 * The lines a result version SHOULD carry, read from the marks that exist right now
 * for this enrollment on this exam.
 *
 * Every grade column is COPIED from the mark rather than re-derived here.
 * `trg_marks_validate` owns `percentage` / `grade_label` / `grade_point` and derives
 * them from the exam's PINNED grading scale; a second, JavaScript implementation of
 * that rule in the worker is a second source of truth for the same number, and the
 * snapshot would then freeze whatever the two implementations happened to disagree
 * about. Copying makes the snapshot, the gradebook and the aggregate provably the
 * same decision. (F-07's concern - a retired scale voiding a result - cannot arise
 * here at all: nothing in this path reads `grading_scales`.)
 *
 * `marks_obtained IS NULL` is a real line: the subject was entered and left blank.
 * It belongs in the denominator and on the card, and it carries no grade.
 */
export interface SnapshotLine {
  examSubjectId: string;
  subjectId: string;
  subjectName: string;
  marksObtained: string | null;
  maxMarks: string;
  weight: string;
  percentage: string | null;
  gradeLabel: string | null;
  gradePoint: string | null;
}

async function loadCandidateLines(
  tx: Tx,
  tenantId: string,
  examId: string,
  academicYearId: string,
  enrollmentId: string,
): Promise<SnapshotLine[]> {
  return tx
    .select({
      examSubjectId: examSubjects.id,
      subjectId: examSubjects.subjectId,
      subjectName: subjects.name,
      marksObtained: marks.marksObtained,
      maxMarks: examSubjects.maxMarks,
      weight: examSubjects.weight,
      percentage: marks.percentage,
      gradeLabel: marks.gradeLabel,
      gradePoint: marks.gradePoint,
    })
    .from(marks)
    .innerJoin(
      examSubjects,
      and(eq(examSubjects.tenantId, marks.tenantId), eq(examSubjects.id, marks.examSubjectId)),
    )
    .innerJoin(
      subjects,
      and(eq(subjects.tenantId, examSubjects.tenantId), eq(subjects.id, examSubjects.subjectId)),
    )
    .where(
      and(
        eq(marks.tenantId, tenantId),
        eq(marks.enrollmentId, enrollmentId),
        eq(marks.academicYearId, academicYearId),
        // The card's own exam, in SQL. Without it the join is "any mark this
        // enrollment has in this year", so a sibling exam contributes its own
        // subject lines to this card (B3).
        eq(examSubjects.examId, examId),
        isNull(marks.deletedAt),
        isNull(examSubjects.deletedAt),
      ),
    )
    .orderBy(subjects.name)
    .execute();
}

/** NUMERIC arrives as text; compare the parsed numbers, not the raw strings. */
function num(value: string | null): number | null {
  return value === null ? null : Number(value);
}

/**
 * Does the frozen snapshot already say exactly what this run computed?
 *
 * The comparison is over the LINES, not over the card's aggregate. Comparing totals
 * was the B2 defect in miniature: two different subject sets can add up to the same
 * GPA and total (move 10 points from one 100-mark subject to a 40-mark one, or
 * re-grade a subject inside the same band), and a totals-only check calls that
 * "unchanged" - so the correction is silently dropped and the published card keeps
 * describing a result that no longer exists. Numeric columns are compared as parsed
 * numbers because NUMERIC text is not canonical ("72.50" and "72.5" are one total).
 */
export function sameSnapshot(
  stored: readonly SnapshotLine[],
  candidate: readonly SnapshotLine[],
): boolean {
  if (stored.length !== candidate.length) return false;
  const bySubject = new Map(stored.map((l) => [l.examSubjectId, l]));
  for (const line of candidate) {
    const other = bySubject.get(line.examSubjectId);
    if (!other) return false;
    if (
      other.subjectId !== line.subjectId ||
      other.subjectName !== line.subjectName ||
      num(other.marksObtained) !== num(line.marksObtained) ||
      num(other.maxMarks) !== num(line.maxMarks) ||
      num(other.weight) !== num(line.weight) ||
      num(other.percentage) !== num(line.percentage) ||
      other.gradeLabel !== line.gradeLabel ||
      num(other.gradePoint) !== num(line.gradePoint)
    ) {
      return false;
    }
  }
  return true;
}

/** The lines a card version is frozen with, exactly as stored. */
async function loadStoredLines(
  tx: Tx,
  tenantId: string,
  cardId: string,
): Promise<SnapshotLine[]> {
  return tx
    .select({
      examSubjectId: reportCardSubjects.examSubjectId,
      subjectId: reportCardSubjects.subjectId,
      subjectName: reportCardSubjects.subjectName,
      marksObtained: reportCardSubjects.marksObtained,
      maxMarks: reportCardSubjects.maxMarks,
      weight: reportCardSubjects.weight,
      percentage: reportCardSubjects.percentage,
      gradeLabel: reportCardSubjects.gradeLabel,
      gradePoint: reportCardSubjects.gradePoint,
    })
    .from(reportCardSubjects)
    .where(
      and(
        eq(reportCardSubjects.tenantId, tenantId),
        eq(reportCardSubjects.reportCardId, cardId),
      ),
    )
    .orderBy(reportCardSubjects.subjectName)
    .execute();
}

/**
 * A card's aggregate, from the ONE definition of it: `fn_report_card_totals`, over
 * the card's own lines, in exact NUMERIC. The worker stores what the database
 * computes rather than re-deriving the sum and the weighted mean in JavaScript, so
 * the value stored here and the value the coherence trigger checks at COMMIT are
 * the same computation and not two implementations that have to agree.
 */
interface CardTotals {
  gpa: string | null;
  totalObtained: string | null;
  totalPossible: string;
  subjectCount: number;
}

async function loadCardTotals(tx: Tx, tenantId: string, cardId: string): Promise<CardTotals> {
  const result = await tx.execute(
    sql`select gpa::text as gpa, total_obtained::text as total_obtained,
               total_possible::text as total_possible, subject_count
          from fn_report_card_totals(${tenantId}::uuid, ${cardId}::uuid)`,
  );
  const row = (result as unknown as { rows: Record<string, unknown>[] }).rows[0];
  if (!row) throw new Error(`fn_report_card_totals returned no row for card ${cardId}`);
  return {
    gpa: (row['gpa'] as string | null) ?? null,
    totalObtained: (row['total_obtained'] as string | null) ?? null,
    totalPossible: String(row['total_possible']),
    subjectCount: Number(row['subject_count']),
  };
}

async function activeEnrollments(tx: Tx, tenantId: string, examId: string) {
  return tx
    .selectDistinct({
      enrollmentId: enrollments.id,
      studentId: enrollments.studentId,
      academicYearId: enrollments.academicYearId,
    })
    .from(examSubjects)
    .innerJoin(
      enrollments,
      and(
        eq(enrollments.tenantId, examSubjects.tenantId),
        eq(enrollments.classId, examSubjects.classId),
        eq(enrollments.academicYearId, examSubjects.academicYearId),
      ),
    )
    .where(
      and(
        eq(examSubjects.tenantId, tenantId),
        eq(examSubjects.examId, examId),
        isNull(examSubjects.deletedAt),
        eq(enrollments.status, 'active'),
        isNull(enrollments.deletedAt),
      ),
    )
    .execute();
}

/**
 * `exam.result.compute` -> one report card per actively enrolled student.
 *
 * A result version is a DOCUMENT, and this handler writes it in the only order the
 * schema permits: card (draft) -> its frozen subject lines -> the aggregate the
 * database derives from those lines -> publish. A card is therefore never
 * published without lines, and a published card can never disagree with itself
 * (`report_cards_snapshot_coherent_trg` re-checks the last step at COMMIT).
 *
 * Versioning (DATABASE_DESIGN §8): a DRAFT card is recomputed in place while the
 * exam is still grading; once the exam is published, a computation that would change
 * the document INSERTs the next VERSION rather than editing the published one, so the
 * history of a result stays additive and auditable (the trigger refuses any other
 * write to a published card, its lines included).
 */
export function makeResultComputeHandler(log: Logger): ExamHandler {
  return async ({ tx, event, defer }) => {
    const tenantId = tenantIdOf(event);
    const examId = examIdOf(event);

    const exam = await tx
      .select({
        id: exams.id,
        status: exams.status,
        academicYearId: exams.academicYearId,
        name: exams.name,
      })
      .from(exams)
      .where(and(eq(exams.tenantId, tenantId), eq(exams.id, examId), isNull(exams.deletedAt)))
      .limit(1)
      .execute()
      .then((r) => r[0]);
    if (!exam) {
      log('warn', 'exam.result.compute: exam not found, no-op', { tenantId, examId });
      return;
    }
    if (exam.status !== 'grading' && exam.status !== 'published') {
      // Draft/cancelled exams have no result set to compute; a redriven dispatch
      // converges as a no-op instead of failing forever.
      log('info', 'exam.result.compute: exam is not gradable, no-op', { tenantId, examId, status: exam.status });
      return;
    }
    const published = exam.status === 'published';

    const examSubjectCount = await tx
      .select({ id: examSubjects.id })
      .from(examSubjects)
      .where(
        and(eq(examSubjects.tenantId, tenantId), eq(examSubjects.examId, examId), isNull(examSubjects.deletedAt)),
      )
      .execute();
    if (!examSubjectCount.length) {
      log('info', 'exam.result.compute: exam has no subjects, no-op', { tenantId, examId });
      return;
    }

    const roster = await activeEnrollments(tx, tenantId, examId);
    let written = 0;
    let superseded = 0;
    let converged = 0;

    for (const enrollment of roster) {
      const candidate = await loadCandidateLines(
        tx,
        tenantId,
        examId,
        exam.academicYearId,
        enrollment.enrollmentId,
      );

      const existing = await tx
        .select()
        .from(reportCards)
        .where(
          and(
            eq(reportCards.tenantId, tenantId),
            eq(reportCards.examId, examId),
            eq(reportCards.studentId, enrollment.studentId),
            isNull(reportCards.deletedAt),
          ),
        )
        .orderBy(sql`${reportCards.version} desc`)
        .execute();

      const draft = existing.find((c) => c.status === 'draft');
      const latest = existing[0];
      const nextVersion = (existing[0]?.version ?? 0) + 1;

      // CONVERGENCE. Publication freezes the draft that the previous compute wrote,
      // so the first post-publish run usually recomputes the SAME document. A
      // published version and its lines are immutable, so re-inserting it would
      // manufacture a duplicate version (and a duplicate PDF) on every outbox
      // redelivery. A new published version is therefore only written when the
      // document actually moved - which is exactly the correction case, and the
      // reason the table is versioned at all.
      if (published && latest?.status === 'published') {
        const stored = await loadStoredLines(tx, tenantId, latest.id);
        if (sameSnapshot(stored, candidate)) {
          if (latest.fileId) {
            // Fully converged: the snapshot and its artifact both exist.
            converged += 1;
            continue;
          }
          // The PDF is still missing (a failed or dead-lettered reports job): ask
          // for it again instead of minting a duplicate version.
          await enqueueOutbox(tx, {
            tenantId,
            eventType: 'report_card.generated',
            aggregateType: 'report_card',
            aggregateId: latest.id,
            payload: {
              tenantId,
              reportCardId: latest.id,
              examId,
              studentId: enrollment.studentId,
            },
            correlationId: event.correlationId,
          });
          written += 1;
          continue;
        }
      }

      const cardId =
        draft?.id ??
        (
          await tx
            .insert(reportCards)
            .values({
              tenantId,
              examId,
              studentId: enrollment.studentId,
              enrollmentId: enrollment.enrollmentId,
              academicYearId: exam.academicYearId,
              version: nextVersion,
              // Always born a DRAFT, even when the exam is already published: the
              // lines cannot exist before the card, and a published card with no
              // lines is a document that describes nothing. The flip below is what
              // publishes it, in the same transaction.
              status: 'draft',
            })
            .returning({ id: reportCards.id })
        )[0]!.id;

      // A DRAFT's lines are its working document, so they are replaced wholesale
      // rather than diffed. (A published card's lines are frozen by the database,
      // and the branch above never reaches here for one.)
      await tx
        .delete(reportCardSubjects)
        .where(
          and(
            eq(reportCardSubjects.tenantId, tenantId),
            eq(reportCardSubjects.reportCardId, cardId),
          ),
        )
        .execute();
      if (candidate.length) {
        await tx
          .insert(reportCardSubjects)
          .values(
            candidate.map((line) => ({
              tenantId,
              reportCardId: cardId,
              examSubjectId: line.examSubjectId,
              subjectId: line.subjectId,
              subjectName: line.subjectName,
              marksObtained: line.marksObtained,
              maxMarks: line.maxMarks,
              weight: line.weight,
              percentage: line.percentage,
              gradeLabel: line.gradeLabel,
              gradePoint: line.gradePoint,
            })),
          )
          .execute();
      }

      // The aggregate is the database's, derived from the lines just written.
      const totals = await loadCardTotals(tx, tenantId, cardId);
      await tx
        .update(reportCards)
        .set({
          gpa: totals.gpa,
          totalObtained: totals.totalObtained,
          totalPossible: totals.totalPossible,
          subjectCount: totals.subjectCount,
        })
        .where(
          and(
            eq(reportCards.tenantId, tenantId),
            eq(reportCards.id, cardId),
            eq(reportCards.status, 'draft'),
          ),
        )
        .execute();

      if (!published) {
        written += 1;
        // A draft is a MUTABLE staff working document, so it never gets a frozen
        // PDF: staff read the live gradebook and a family only ever sees a
        // published, immutable snapshot. This is what keeps a preview from going
        // stale behind a recomputed draft.
        continue;
      }

      const froze = await tx
        .update(reportCards)
        .set({ status: 'published', publishedAt: new Date() })
        .where(
          and(
            eq(reportCards.tenantId, tenantId),
            eq(reportCards.id, cardId),
            eq(reportCards.status, 'draft'),
          ),
        )
        .returning({ id: reportCards.id });
      if (!froze[0]) {
        // A concurrent publication froze the draft between the read and the write;
        // the next dispatch produces the published version.
        log('info', 'exam.result.compute: draft was frozen concurrently, skipping', {
          tenantId,
          examId,
          reportCardId: cardId,
        });
        continue;
      }
      written += 1;
      superseded += 1;

      await enqueueOutbox(tx, {
        tenantId,
        eventType: 'report_card.generated',
        aggregateType: 'report_card',
        aggregateId: cardId,
        // ids only: the PDF job re-reads the snapshot, so no result data travels
        // through the outbox.
        payload: { tenantId, reportCardId: cardId, examId, studentId: enrollment.studentId },
        correlationId: event.correlationId,
      });
    }

    log('info', 'exam.result.compute: report cards written', {
      tenantId,
      examId,
      examStatus: exam.status,
      cards: written,
      newPublishedVersions: superseded,
      converged,
    });
  };
}

/**
 * `report_card.generated` -> defer the `reports`-queue artifact job. The job
 * carries the report card id ONLY, so the PDF can never be rendered from
 * client/event data, and `idempotencyKey` is the event id so a redelivery
 * converges on the same artifact.
 */
export function makeReportCardGeneratedHandler(log: Logger): ExamHandler {
  return async ({ event, defer }) => {
    const tenantId = tenantIdOf(event);
    const reportCardId = event.payload['reportCardId'];
    if (typeof reportCardId !== 'string') {
      throw new Error("report_card.generated requires a string 'reportCardId' in payload");
    }
    defer({
      name: 'report.studentReportCard',
      queue: 'reports',
      data: {
        reportCardId,
        tenantId,
        idempotencyKey: event.id,
        correlationId: event.correlationId ?? undefined,
      },
    });
    log('info', 'report_card.generated: deferred PDF job', { tenantId, reportCardId });
  };
}

/**
 * `exam.published` -> a publication STUB to every linked guardian.
 *
 * Recipients are the LIVE guardians of the students ON this exam, resolved from
 * the exam's own roster — so a notification can only ever reach a family already
 * linked to a student who took the exam. The handler only DEFERS: a rolled-back
 * publication sends nothing. Phase 8 replaces the stub channel with real
 * provider adapters.
 */
export function makePublishNotificationHandler(log: Logger): ExamHandler {
  return async ({ tx, event, defer }) => {
    const tenantId = tenantIdOf(event);
    const examId = examIdOf(event);

    const studentsOnExam = await activeEnrollments(tx, tenantId, examId);
    if (!studentsOnExam.length) {
      log('info', 'exam.published: no enrolled students, no-op', { tenantId, examId });
      return;
    }
    const studentIds = studentsOnExam.map((s) => s.studentId);

    const recipients = await tx
      .selectDistinct({ studentId: studentGuardians.studentId, email: users.email })
      .from(studentGuardians)
      .innerJoin(
        guardians,
        and(
          eq(guardians.tenantId, studentGuardians.tenantId),
          eq(guardians.id, studentGuardians.guardianId),
        ),
      )
      .innerJoin(users, eq(users.id, guardians.userId))
      .where(
        and(
          eq(studentGuardians.tenantId, tenantId),
          inArray(studentGuardians.studentId, studentIds),
        ),
      )
      .execute();

    let deferred = 0;
    for (const row of recipients) {
      defer({
        name: 'mail.stub.send',
        queue: 'mail',
        data: {
          to: row.email,
          template: PUBLISH_TEMPLATE,
          tenantId,
          correlationId: event.correlationId,
          data: { tenantId, examId, studentId: row.studentId },
        },
      });
      deferred += 1;
    }
    log('info', 'exam.published: deferred publication notifications', {
      tenantId,
      examId,
      students: studentIds.length,
      notifications: deferred,
    });
  };
}
// ------------------------------------------------------------------ PDF artifact job

export interface ReportCardDocument {
  reportCardId: string;
  originalName: string;
  lines: ReportCardLine[];
  cardVersion: number;
  cardStatus: string;
}

/**
 * Assemble the printable report card.
 *
 * Every value is read from the card's own FROZEN snapshot, and the job payload never
 * carries a grade, so a replayed job can only ever re-render what the database
 * already published.
 *
 * The per-subject lines come from `report_card_subjects` and NOT from `marks`. That
 * is the whole point of the table: this loader used to re-read the detail from live
 * marks and filter to the card's exam in JavaScript, so a correction silently
 * rewrote the body of an already-published, already-delivered card, and a line from
 * a sibling exam could be printed on it. The snapshot makes both impossible: the
 * lines belong to one card version and the database refuses a line that names
 * another exam's subject.
 */
export async function loadReportCardDocument(
  tx: Tx,
  tenantId: string,
  reportCardId: string,
): Promise<ReportCardDocument | null> {
  const card = await tx
    .select({
      id: reportCards.id,
      version: reportCards.version,
      status: reportCards.status,
      gpa: reportCards.gpa,
      totalObtained: reportCards.totalObtained,
      totalPossible: reportCards.totalPossible,
      subjectCount: reportCards.subjectCount,
      examId: reportCards.examId,
      studentId: reportCards.studentId,
      enrollmentId: reportCards.enrollmentId,
      academicYearId: reportCards.academicYearId,
      examName: exams.name,
      examPublishedAt: exams.publishedAt,
      termName: academicTerms.name,
      studentNo: students.studentNo,
      studentFirstName: students.firstName,
      studentLastName: students.lastName,
    })
    .from(reportCards)
    .innerJoin(exams, and(eq(exams.tenantId, reportCards.tenantId), eq(exams.id, reportCards.examId)))
    .innerJoin(
      academicTerms,
      and(eq(academicTerms.tenantId, exams.tenantId), eq(academicTerms.id, exams.academicTermId)),
    )
    .innerJoin(students, and(eq(students.tenantId, reportCards.tenantId), eq(students.id, reportCards.studentId)))
    .where(and(eq(reportCards.tenantId, tenantId), eq(reportCards.id, reportCardId), isNull(reportCards.deletedAt)))
    .limit(1)
    .execute()
    .then((r) => r[0]);
  if (!card) return null;

  // The card's OWN lines, by construction the ones of the card's own exam.
  const subjectRows = await loadStoredLines(tx, tenantId, card.id);

  const lines: ReportCardLine[] = [
    { text: 'REPORT CARD', kind: 'title' },
    { text: `Student: ${card.studentFirstName} ${card.studentLastName} (${card.studentNo})` },
    { text: `Exam: ${card.examName}` },
    { text: `Term: ${card.termName}` },
    { text: `Version: ${card.version} (${card.status})` },
    { text: '' },
    { text: 'Subject                          Marks      Max       %   Grade' },
  ];
  for (const row of subjectRows) {
    const obtained = row.marksObtained === null ? '-' : Number(row.marksObtained).toFixed(2);
    const percent = row.percentage === null ? '-' : `${Number(row.percentage).toFixed(2)}%`;
    const grade = row.gradeLabel ?? '-';
    lines.push({
      text:
        `${row.subjectName.padEnd(30).slice(0, 30)} ${obtained.padStart(8)} ` +
        `${String(Number(row.maxMarks)).padStart(8)} ${percent.padStart(8)} ${grade.padStart(6)}`,
    });
  }
  const total = card.totalObtained === null ? '-' : Number(card.totalObtained).toFixed(2);
  lines.push({ text: '' });
  lines.push({ text: `Total: ${total} / ${Number(card.totalPossible).toFixed(2)}` });
  lines.push({ text: `GPA: ${card.gpa === null ? '-' : Number(card.gpa).toFixed(2)}` });
  lines.push({ text: `Subjects: ${card.subjectCount}` });
  if (card.examPublishedAt) {
    lines.push({ text: `Published: ${card.examPublishedAt.toISOString().slice(0, 10)}` });
  }

  return {
    reportCardId: card.id,
    originalName: `report-card-${card.studentNo}-${card.version}.pdf`,
    lines,
    cardVersion: card.version,
    cardStatus: card.status,
  };
}

export interface ReportCardJobOutcome {
  status: 'generated' | 'converged' | 'missing';
  reportCardId: string;
  fileId?: string;
  storageKey?: string;
}

/**
 * `report.studentReportCard` on the `reports` queue. Renders the PDF, stores it
 * through the StorageProvider, records a `files` row and stamps
 * `report_cards.file_id`.
 *
 * Idempotent by construction: a redelivered job for a card that already has an
 * artifact converges and writes nothing. The trigger allows the artifact pointer
 * exactly once on a published card and never as a replacement, so a duplicate
 * stamp would raise rather than silently overwrite a family's document.
 */
export async function processReportCardJob(
  tx: Tx,
  storage: StorageProvider,
  log: Logger,
  raw: unknown,
): Promise<ReportCardJobOutcome> {
  const parsed = studentReportCardJobSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `invalid report.studentReportCard payload (${parsed.error.issues.length} issue(s)): ${parsed.error.message}`,
    );
  }
  const { reportCardId, tenantId } = parsed.data;

  const current = await tx
    .select({ id: reportCards.id, fileId: reportCards.fileId })
    .from(reportCards)
    .where(and(eq(reportCards.tenantId, tenantId), eq(reportCards.id, reportCardId)))
    .limit(1)
    .execute()
    .then((r) => r[0]);
  if (!current) {
    log('warn', 'report.studentReportCard: report card not found', { tenantId, reportCardId });
    return { status: 'missing', reportCardId };
  }
  if (current.fileId) {
    log('info', 'report.studentReportCard: artifact already present, converged', {
      tenantId,
      reportCardId,
      fileId: current.fileId,
    });
    return { status: 'converged', reportCardId, fileId: current.fileId };
  }

  const doc = await loadReportCardDocument(tx, tenantId, reportCardId);
  if (!doc) {
    log('warn', 'report.studentReportCard: report card not readable', { tenantId, reportCardId });
    return { status: 'missing', reportCardId };
  }

  const data = renderReportCardPdf(doc.lines);
  const key = `report-cards/${reportCardId}-v${doc.cardVersion}.pdf`;
  const contentHash = createHash('sha256').update(data).digest('hex');
  await storage.putObject({ tenantId, key, data, contentType: 'application/pdf' });

  const inserted = await tx
    .insert(files)
    .values({
      tenantId,
      storageKey: key,
      originalName: doc.originalName,
      mime: 'application/pdf',
      sizeBytes: BigInt(data.byteLength),
      contentHash,
      // Generated server-side, so it is already trusted: a family portal may fetch
      // it and it needs no upload scan.
      visibility: 'tenant_portal',
      ownerType: 'report_card',
      ownerId: reportCardId,
      scanStatus: 'clean',
    })
    .onConflictDoNothing({ target: files.storageKey })
    .returning({ id: files.id });
  const fileId =
    inserted[0]?.id ??
    (
      await tx
        .select({ id: files.id })
        .from(files)
        .where(and(eq(files.tenantId, tenantId), eq(files.storageKey, key)))
        .limit(1)
        .execute()
        .then((r) => r[0]!.id)
    );

  const stamped = await tx
    .update(reportCards)
    .set({ fileId })
    .where(and(eq(reportCards.tenantId, tenantId), eq(reportCards.id, reportCardId), isNull(reportCards.fileId)))
    .returning({ id: reportCards.id });
  if (!stamped[0]) {
    log('info', 'report.studentReportCard: artifact stamped concurrently, converged', {
      tenantId,
      reportCardId,
    });
    return { status: 'converged', reportCardId, fileId, storageKey: key };
  }

  await writeAudit(tx, {
    scope: 'tenant',
    tenantId,
    actorUserId: null,
    actorType: 'system',
    action: 'exam.report_card.generated',
    resourceType: 'report_card',
    resourceId: reportCardId,
    newValue: {
      fileId,
      storageKey: key,
      version: doc.cardVersion,
      status: doc.cardStatus,
      sizeBytes: data.byteLength,
    },
    requestId: null,
  });

  log('info', 'report.studentReportCard: artifact generated', {
    tenantId,
    reportCardId,
    fileId,
    storageKey: key,
    sizeBytes: data.byteLength,
  });
  return { status: 'generated', reportCardId, fileId, storageKey: key };
}
