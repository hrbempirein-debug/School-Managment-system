/**
 * Publish a report card the way the reports worker does, and in that order.
 *
 * WHY THIS EXISTS
 * A report card is only coherent if its stored aggregate is derived from its own
 * subject lines, and the database now enforces exactly that: the deferred
 * coherence trigger refuses to let a card reach `published` while its aggregate
 * disagrees with its snapshot. So a fixture that wants a published card cannot
 * INSERT one with hard-coded aggregates - that state is the incoherent state the
 * Phase 6 remediation exists to prevent, and the database is right to refuse it.
 *
 * The order below is therefore the contract, not a convenience:
 *
 *   1. write the card as a DRAFT;
 *   2. freeze its subject lines in, scoped to the card's OWN exam;
 *   3. store the aggregate those lines describe, computed by
 *      `fn_report_card_totals()`;
 *   4. only then transition it to `published`.
 *
 * The lines are written while the card is still a draft, so the ordinary
 * `report_card_subjects_freeze_trg` is never lifted and never has to be. Reaching a
 * published card WITH a snapshot must go through the ordinary publication path; if
 * that ever needs a guard lifted to succeed, the bug is in the publication path and
 * belongs there, not in a test fixture.
 *
 * WHY THERE IS NO ARITHMETIC IN HERE
 * The aggregate is read back from `fn_report_card_totals()`, the same function the
 * worker stores and the same function the coherence trigger checks. It is computed
 * once, in the database, in one place. A JS re-implementation that rounded 3.005 to
 * 3.00 where NUMERIC rounds 3.01 would be a permanent source of spurious
 * "incoherent" failures - and a fixture that restated the totals by hand is
 * precisely how the suites ended up asking for a state the schema forbids.
 *
 * This is a TEST fixture helper. It performs no tenant scoping and sets no RLS
 * context, so it must be handed a privileged (DDL) client; it is not a code path
 * the application may use.
 */
import { randomUUID } from 'node:crypto';

/** The slice of `pg.Client` this helper needs, so callers may pass a pooled client. */
export interface ReportCardClient {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: T[]; rowCount: number | null }>;
}

export interface PublishReportCardArgs {
  tenantId: string;
  examId: string;
  studentId: string;
  enrollmentId: string;
  version: number;
  /** `published` mints the real publication; `draft` stops after step 3. */
  status?: 'draft' | 'published';
}

export async function publishReportCardWithSnapshot(
  client: ReportCardClient,
  args: PublishReportCardArgs,
): Promise<string> {
  const card = randomUUID();
  const status = args.status ?? 'published';

  const enrollment = await client.query<{ academic_year_id: string }>(
    `select academic_year_id from enrollments where id = $1 and tenant_id = $2`,
    [args.enrollmentId, args.tenantId],
  );
  const yearId = enrollment.rows[0]?.academic_year_id;
  if (!yearId) {
    throw new Error(
      `publishReportCardWithSnapshot: no enrollment ${args.enrollmentId} in tenant ${args.tenantId}`,
    );
  }

  await client.query(
    `insert into report_cards (id, tenant_id, exam_id, student_id, enrollment_id, academic_year_id, version, status)
     values ($1, $2, $3, $4, $5, $6, $7, 'draft')`,
    [card, args.tenantId, args.examId, args.studentId, args.enrollmentId, yearId, args.version],
  );

  // Scoped to the card's OWN exam. The predicate is load-bearing (F-01): without
  // `es.exam_id = rc.exam_id` a sibling exam in the same year contributes its
  // subject lines, marks, max_marks and weights to this card.
  await client.query(
    `insert into report_card_subjects (tenant_id, report_card_id, exam_subject_id, subject_id, subject_name,
                                       marks_obtained, max_marks, weight, percentage, grade_label, grade_point)
     select rc.tenant_id, rc.id, es.id, es.subject_id, s.name,
            m.marks_obtained, es.max_marks, es.weight, m.percentage, m.grade_label, m.grade_point
     from report_cards rc
     join exam_subjects es
       on es.tenant_id = rc.tenant_id and es.exam_id = rc.exam_id and es.deleted_at is null
     join subjects s
       on s.tenant_id = es.tenant_id and s.id = es.subject_id
     join marks m
       on m.tenant_id = rc.tenant_id and m.exam_subject_id = es.id
      and m.enrollment_id = rc.enrollment_id
      and m.academic_year_id = rc.academic_year_id
      and m.deleted_at is null
     where rc.id = $1`,
    [card],
  );

  // The aggregate the card STORES must be the one its own lines describe, or the
  // deferred coherence trigger refuses the publication below.
  await client.query(
    `update report_cards rc
        set gpa = t.gpa,
            total_obtained = t.total_obtained,
            total_possible = t.total_possible,
            subject_count = t.subject_count
       from (select * from fn_report_card_totals($1, $2)) t
      where rc.id = $2`,
    [args.tenantId, card],
  );

  if (status === 'published') {
    await client.query(
      `update report_cards set status = 'published', published_at = now() where id = $1`,
      [card],
    );
  }

  return card;
}
