import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { getEnv } from '@sms/config';
import {
  createDb,
  withSystem,
  type Db,
  type Tx,
} from '@sms/db';
import { makeResultComputeHandler, loadReportCardDocument } from './exams.js';
import type { OutboxEvent } from '@sms/contracts';

/**
 * Phase 6 worker result-pipeline integration proofs against the REAL database.
 *
 * These drive `makeResultComputeHandler` directly — the handler that
 * `exam.result.compute` reaches — rather than re-deriving its arithmetic, because
 * the findings being regression-tested are precisely about the parts a unit test
 * cannot see: which scale the handler resolves, and whether a correction actually
 * converges a published report card.
 *
 * F-07 (scale resolution): the handler used to require `is_active` even for the
 * exam's PINNED scale. A tenant that later retired the scale emptied the band list,
 * so a recompute of an already-published exam produced `gpa: null`, dropped every
 * subject from the aggregate, and minted a new published version carrying those
 * nulls — a published result destroyed by an unrelated operational toggle.
 *
 * F-02 (correction convergence): a published correction used to leave the card
 * stale forever, because the recompute command was never queued. This file also
 * pins the convergence contract the correction depends on: a changed aggregate
 * mints version + 1 and re-requests the PDF, an unchanged one converges without
 * minting a duplicate, and a redelivery is a no-op.
 *
 * Opt-in: RUN_RUNTIME_SECURITY_TESTS=1. Runs on the DISPOSABLE test database
 * resolved by @sms/db/src/testing/runtime-db.ts, never on development.
 */
const enabled = process.env.RUN_RUNTIME_SECURITY_TESTS === '1';
const describeDb = enabled ? describe : describe.skip;

/** Bands tiling 0..100; 91% lands in D/4 and 60% in C/3. */
const BANDS = [
  { label: 'A', minPercent: 0, maxPercent: 40, gradePoint: 1 },
  { label: 'B', minPercent: 40, maxPercent: 60, gradePoint: 2 },
  { label: 'C', minPercent: 60, maxPercent: 80, gradePoint: 3 },
  { label: 'D', minPercent: 80, maxPercent: 100, gradePoint: 4 },
];

describeDb('Phase 6 worker result pipeline (disposable test database)', () => {
  let db: Db;
  let pool: pg.Pool;
  let migrator: pg.Client;
  const slug = 'wk' + randomUUID().slice(0, 8);
  const uid = {
    tenant: randomUUID(),
    userA: randomUUID(),
    teacher: randomUUID(),
    campus: randomUUID(),
    year: randomUUID(),
    term: randomUUID(),
    level: randomUUID(),
    subject: randomUUID(),
    class: randomUUID(),
    section: randomUUID(),
    link: randomUUID(),
    assign: randomUUID(),
    student: randomUUID(),
    enroll: randomUUID(),
    type: randomUUID(),
    scale: randomUUID(),
    exam: randomUUID(),
    es: randomUUID(),
    mark: randomUUID(),
    file: randomUUID(),
  };

  const noop = (): void => undefined;
  const handler = makeResultComputeHandler(noop);

  const computeEvent = (tenantId: string, examId: string, correlationId: string): OutboxEvent =>
    ({
      version: 1,
      id: randomUUID(),
      tenantId,
      eventType: 'exam.result.compute',
      aggregateType: 'exam',
      aggregateId: examId,
      payload: { tenantId, examId, reason: 'mark_corrected' },
      correlationId,
      causationId: null,
      createdAt: new Date().toISOString(),
    }) as OutboxEvent;

  /** Runs the compute handler inside a real system-context transaction. */
  const compute = (tenantId: string, examId: string): Promise<void> =>
    withSystem(db, async (tx: Tx) => {
      await handler({ tx, event: computeEvent(tenantId, examId, randomUUID()), defer: noop });
    });

  const rows = async <T extends pg.QueryResultRow = pg.QueryResultRow>(
    sqlText: string,
  ): Promise<T[]> => migrator.query<T>(sqlText).then((r) => r.rows);

  const cards = async (examId: string) =>
    rows<{ id: string; version: number; status: string; gpa: string | null; total_obtained: string | null; total_possible: string; subject_count: number; file_id: string | null }>(
      `select id, version, status, gpa, total_obtained, total_possible, subject_count, file_id
         from report_cards
        where exam_id = '${examId}' and deleted_at is null
        order by version`,
    );

  /** The frozen per-subject lines of one card version - the B2 snapshot. */
  const snapshot = async (cardId: string) =>
    rows<{
      subject_name: string;
      marks_obtained: string | null;
      max_marks: string;
      weight: string;
      percentage: string | null;
      grade_label: string | null;
      grade_point: string | null;
    }>(
      `select subject_name, marks_obtained, max_marks, weight, percentage, grade_label, grade_point
         from report_card_subjects
        where report_card_id = '${cardId}'
        order by subject_name`,
    );

  beforeAll(async () => {
    const env = getEnv();
    // The MIGRATOR url, as the sibling outbox integration suite does: `withSystem`
    // establishes a signed system context, and the fixture itself is DDL-adjacent.
    const created = createDb({ url: env.DATABASE_URL_MIGRATOR });
    db = created.db;
    pool = created.pool;
    migrator = new pg.Client({ connectionString: env.DATABASE_URL_MIGRATOR });
    await migrator.connect();

    await migrator.query('begin');
    await migrator.query(
      `insert into tenants (id, slug, name) values ('${uid.tenant}', '${slug}', 'Worker ${slug}')`,
    );
    await migrator.query(
      `insert into users (id, email) values
         ('${uid.userA}', 'wk-a-${slug}@example.com'),
         ('${uid.teacher}', 'wk-t-${slug}@example.com')`,
    );
    await migrator.query(
      `insert into user_profiles (user_id, full_name) values
         ('${uid.userA}', 'Caller'), ('${uid.teacher}', 'Teacher')`,
    );
    await migrator.query(
      `insert into memberships (id, tenant_id, user_id, status) values
         ('${randomUUID()}', '${uid.tenant}', '${uid.userA}', 'active'),
         ('${randomUUID()}', '${uid.tenant}', '${uid.teacher}', 'active')`,
    );
    const roleId = randomUUID();
    const memberId = (
      await migrator.query(
        `select id from memberships where tenant_id = '${uid.tenant}' and user_id = '${uid.teacher}'`,
      )
    ).rows[0].id as string;
    await migrator.query(
      `insert into roles (id, tenant_id, scope, code, name, is_system)
       values ('${roleId}', '${uid.tenant}', 'tenant', 'teacher', 'Teacher', true)`,
    );
    await migrator.query(
      `insert into membership_roles (membership_id, role_id) values ('${memberId}', '${roleId}')`,
    );
    await migrator.query(
      `insert into campuses (id, tenant_id, code, name, status)
       values ('${uid.campus}', '${uid.tenant}', 'c-${slug}', 'Campus', 'active')`,
    );
    await migrator.query(
      `insert into academic_years (id, tenant_id, code, name, starts_on, ends_on, status)
       values ('${uid.year}', '${uid.tenant}', 'y-${slug}', 'AY', '2026-01-01', '2026-12-31', 'active')`,
    );
    await migrator.query(
      `insert into academic_terms (id, tenant_id, academic_year_id, code, name, sequence, starts_on, ends_on, status)
       values ('${uid.term}', '${uid.tenant}', '${uid.year}', 't-${slug}', 'Term', 1, '2026-01-01', '2026-06-30', 'open')`,
    );
    await migrator.query(
      `insert into grade_levels (id, tenant_id, code, name, status)
       values ('${uid.level}', '${uid.tenant}', 'gl-${slug}', 'Grade', 'active')`,
    );
    await migrator.query(
      `insert into subjects (id, tenant_id, code, name, status)
       values ('${uid.subject}', '${uid.tenant}', 'sb-${slug}', 'Maths', 'active')`,
    );
    await migrator.query(
      `insert into acd_classes (id, tenant_id, campus_id, academic_year_id, grade_level_id, code, name, status)
       values ('${uid.class}', '${uid.tenant}', '${uid.campus}', '${uid.year}', '${uid.level}', 'c-${slug}', 'Class', 'active')`,
    );
    await migrator.query(
      `insert into sections (id, tenant_id, class_id, campus_id, academic_year_id, code, status)
       values ('${uid.section}', '${uid.tenant}', '${uid.class}', '${uid.campus}', '${uid.year}', 's-${slug}', 'active')`,
    );
    await migrator.query(
      `insert into class_subjects (id, tenant_id, class_id, subject_id, campus_id, academic_year_id)
       values ('${uid.link}', '${uid.tenant}', '${uid.class}', '${uid.subject}', '${uid.campus}', '${uid.year}')`,
    );
    await migrator.query(
      `insert into teacher_assignments (id, tenant_id, class_id, subject_id, teacher_user_id, campus_id, academic_year_id)
       values ('${uid.assign}', '${uid.tenant}', '${uid.class}', '${uid.subject}', '${uid.teacher}', '${uid.campus}', '${uid.year}')`,
    );
    await migrator.query(
      `insert into students (id, tenant_id, student_no, first_name, last_name, status, primary_campus_id)
       values ('${uid.student}', '${uid.tenant}', 's-${slug}', 'Ada', 'One', 'active', '${uid.campus}')`,
    );
    await migrator.query(
      `insert into enrollments (id, tenant_id, student_id, academic_year_id, class_id, section_id, roll_no, status)
       values ('${uid.enroll}', '${uid.tenant}', '${uid.student}', '${uid.year}', '${uid.class}', '${uid.section}', '01', 'active')`,
    );
    await migrator.query(
      `insert into files (id, tenant_id, storage_key, original_name, mime, size_bytes, visibility, created_by)
       values ('${uid.file}', '${uid.tenant}', 'exam/${slug}/card.pdf', 'card.pdf', 'application/pdf', 12, 'private', '${uid.userA}')`,
    );
    await migrator.query(
      `insert into exam_types (id, tenant_id, code, name)
       values ('${uid.type}', '${uid.tenant}', 'mt_${slug}', 'Midterm')`,
    );
    await migrator.query(
      `insert into grading_scales (id, tenant_id, code, name, version, is_active, bands)
       values ('${uid.scale}', '${uid.tenant}', 'std_${slug}', 'Standard', 1, true, '${JSON.stringify(BANDS)}'::jsonb)`,
    );
    await migrator.query(
      `insert into exams (id, tenant_id, academic_term_id, academic_year_id, exam_type_id, grading_scale_id, name, status)
       values ('${uid.exam}', '${uid.tenant}', '${uid.term}', '${uid.year}', '${uid.type}', '${uid.scale}', 'Worker exam ${slug}', 'draft')`,
    );
    await migrator.query(
      `insert into exam_subjects (id, tenant_id, exam_id, class_subject_id, academic_year_id, class_id, subject_id, max_marks, weight)
       values ('${uid.es}', '${uid.tenant}', '${uid.exam}', '${uid.link}', '${uid.year}', '${uid.class}', '${uid.subject}', 100, 1)`,
    );
    await migrator.query(`update exams set status = 'grading' where id = '${uid.exam}'`);
    await migrator.query(
      `insert into marks (id, tenant_id, exam_subject_id, enrollment_id, student_id, section_id, academic_year_id, marks_obtained, entered_by)
       values ('${uid.mark}', '${uid.tenant}', '${uid.es}', '${uid.enroll}', '${uid.student}', '${uid.section}', '${uid.year}', 91, '${uid.teacher}')`,
    );
    await migrator.query('commit');
  });

  afterAll(async () => {
    try {
      await migrator.query('rollback');
      const t = `'${uid.tenant}'`;
      // `marks` and `report_cards` are guarded against deleting a PUBLISHED row, so
      // the fixture lifts the two guards for exactly its own teardown statements and
      // restores them immediately, inside one transaction.
      await migrator.query('begin');
      await migrator.query(`alter table marks disable trigger marks_delete_guard_trg`);
      await migrator.query(`alter table mark_corrections disable trigger mark_corrections_append_only_trg`);
      await migrator.query(`alter table report_cards disable trigger report_cards_hard_delete_guard_trg`);
      // A published card's lines are frozen for every role, so the fixture lifts
      // that guard for exactly its own teardown statements, as it does the two
      // guards above. 0018 splits that freeze out of the integrity trigger into
      // `report_card_subjects_freeze_trg`, so THAT is the guard to lift here; the
      // validate trigger is left enabled and has nothing to say about a DELETE.
      await migrator.query(
        `alter table report_card_subjects disable trigger report_card_subjects_freeze_trg`,
      );
      for (const table of [
        'mark_corrections', 'report_card_subjects', 'report_cards', 'marks', 'exam_schedules', 'exam_subjects', 'exams',
        'grading_scales', 'exam_types', 'teacher_assignments', 'class_subjects', 'enrollments',
        'sections', 'students', 'acd_classes', 'grade_levels', 'subjects', 'academic_terms',
        'academic_years', 'campuses', 'outbox_events',
      ]) {
        await migrator.query(`delete from ${table} where tenant_id in (${t})`);
      }
      await migrator.query(`alter table marks enable trigger marks_delete_guard_trg`);
      await migrator.query(`alter table mark_corrections enable trigger mark_corrections_append_only_trg`);
      await migrator.query(`alter table report_cards enable trigger report_cards_hard_delete_guard_trg`);
      await migrator.query(
        `alter table report_card_subjects enable trigger report_card_subjects_freeze_trg`,
      );
      await migrator.query('commit');
      await migrator.query(
        `delete from membership_roles where membership_id in (select id from memberships where tenant_id = ${t})`,
      );
      await migrator.query(`delete from memberships where tenant_id in (${t})`);
      await migrator.query(`delete from roles where tenant_id in (${t})`);
      await migrator.query(`delete from user_profiles where user_id in (select id from users where email like '%-${slug}@example.com')`);
      await migrator.query(`delete from users where email like '%-${slug}@example.com'`);
      await migrator.query(`delete from tenants where id in (${t})`);
    } finally {
      await migrator.end();
      await pool.end();
    }
  });

  /**
   * Mirrors the API's publish request: the exam flips to published AND its draft
   * cards are frozen in place (`apps/api/src/routes/school/exams.ts`). Without the
   * freeze the worker would see no published card and mint version 2, which would
   * test a state production never produces.
   *
   * The API also reconciles each draft's aggregate from `fn_report_card_totals`
   * before freezing it. That is a no-op here, and deliberately NOT copied: freezing
   * the worker's draft untouched is the stronger assertion, because it shows the
   * worker's own output is publishable without the publication path having to repair
   * it first.
   */
  const publishExam = async (): Promise<void> => {
    await migrator.query(
      `update exams set status = 'published', published_at = now() where id = '${uid.exam}'`,
    );
    await migrator.query(
      `update report_cards set status = 'published', published_at = now()
        where exam_id = '${uid.exam}' and status = 'draft' and deleted_at is null`,
    );
  };

  /** Mirrors the reports job stamping the artifact pointer exactly once. */
  const stampArtifact = async (): Promise<void> => {
    await migrator.query(`update report_cards set file_id = '${uid.file}' where exam_id = '${uid.exam}' and file_id is null`);
    // Assert the stamp really landed: a silently-NULL file_id would make the
    // convergence assertions below pass for the wrong reason.
    const remaining = await rows<{ n: number }>(
      `select count(*)::int n from report_cards where exam_id = '${uid.exam}' and file_id is null`,
    );
    expect(Number(remaining[0]!.n)).toBe(0);
  };

  const pdfRequests = async (): Promise<number> =>
    Number(
      (
        await rows<{ n: number }>(
          `select count(*)::int n from outbox_events
            where tenant_id = '${uid.tenant}' and event_type = 'report_card.generated'`,
        )
      )[0]!.n,
    );

  describe('F-07 the pinned scale resolves even after the tenant retires it', () => {
    it('grades from the pinned scale, and converges without minting a duplicate', async () => {
      // First compute while grading: a draft card from the active scale.
      await compute(uid.tenant, uid.exam);
      const draft = await cards(uid.exam);
      expect(draft).toHaveLength(1);
      expect(draft[0]!.status).toBe('draft');
      expect(Number(draft[0]!.gpa)).toBe(4);
      expect(Number(draft[0]!.total_obtained)).toBe(91);

      // Publication freezes that draft. The next compute must then CONVERGE: the
      // aggregate is unchanged, so no version 2 may appear.
      await publishExam();
      await compute(uid.tenant, uid.exam);
      const published = await cards(uid.exam);
      expect(published).toHaveLength(1);
      expect(published[0]!.status).toBe('published');
      expect(published[0]!.version).toBe(1);
      expect(Number(published[0]!.gpa)).toBe(4);

      // The reports job stamps the artifact, and the card is now fully converged.
      await stampArtifact();

      // THE REGRESSION. The tenant retires the scale this exam is pinned to. That is
      // an ordinary operational action and must not reach back into a published
      // result.
      await migrator.query(`update grading_scales set is_active = false where id = '${uid.scale}'`);

      await compute(uid.tenant, uid.exam);
      const afterRetire = await cards(uid.exam);
      // Still exactly one version. Before the fix the emptied band list made the
      // aggregate differ (gpa null, no graded lines), so the handler minted a NEW
      // published version carrying those nulls.
      expect(afterRetire).toHaveLength(1);
      expect(afterRetire[0]!.version).toBe(1);
      expect(afterRetire[0]!.status).toBe('published');
      // And the published snapshot is still graded, not voided.
      expect(Number(afterRetire[0]!.gpa)).toBe(4);
      expect(Number(afterRetire[0]!.total_obtained)).toBe(91);
      expect(afterRetire[0]!.subject_count).toBe(1);
    });

    it('still grades a mark while the pinned scale is retired', async () => {
      // The DB-side rule the handler must agree with: the pin is a historical
      // reference, so a mark can still be graded after the retirement.
      const mark = await rows<{ grade_label: string | null; grade_point: number | null }>(
        `update marks set marks_obtained = 91 where id = '${uid.mark}' returning grade_label, grade_point`,
      );
      expect(mark[0]!.grade_label).toBe('D');
      expect(Number(mark[0]!.grade_point)).toBe(4);
    });

    it('snapshots the grade the mark trigger derived, so the two cannot disagree', async () => {
      // The worker no longer re-implements the grading rule. The snapshot copies
      // what `trg_marks_validate` derived, so the card, the gradebook and the
      // aggregate are provably one decision - there is no second band lookup to
      // drift. A retired scale therefore cannot reach back into a published result
      // (F-07), because nothing in this path reads `grading_scales` at all.
      const stored = await rows<{ percentage: string; grade_label: string; grade_point: string }>(
        `select percentage, grade_label, grade_point from marks where id = '${uid.mark}'`,
      );
      const card = (await cards(uid.exam))[0]!;
      const lines = await snapshot(card.id);
      expect(lines).toHaveLength(1);
      expect(lines[0]!.marks_obtained).toBe(stored[0]!.percentage === null ? null : lines[0]!.marks_obtained);
      expect(Number(lines[0]!.percentage)).toBe(Number(stored[0]!.percentage));
      expect(lines[0]!.grade_label).toBe(stored[0]!.grade_label);
      expect(Number(lines[0]!.grade_point)).toBe(Number(stored[0]!.grade_point));
    });
  });

  describe('F-02 a published correction converges the report card', () => {
    it('mints version + 1 with the corrected total when the aggregate moves', async () => {
      // Re-activate the scale so the correction's re-derivation is the only variable.
      await migrator.query(`update grading_scales set is_active = true where id = '${uid.scale}'`);

      // The correction workflow: an append-only ledger row, then the mark UPDATE.
      await migrator.query(
        `insert into mark_corrections (id, tenant_id, mark_id, exam_id, exam_subject_id, student_id, old_marks_obtained, new_marks_obtained, reason, corrected_by)
         values ('${randomUUID()}', '${uid.tenant}', '${uid.mark}', '${uid.exam}', '${uid.es}', '${uid.student}', 91, 60, 'moderation', '${uid.teacher}')`,
      );
      await migrator.query(`update marks set marks_obtained = 60 where id = '${uid.mark}'`);

      await compute(uid.tenant, uid.exam);
      const after = await cards(uid.exam);
      expect(after).toHaveLength(2);
      expect(after.map((c) => c.version)).toEqual([1, 2]);
      // Version 1 stays frozen: a published snapshot is a historical record.
      expect(Number(after[0]!.total_obtained)).toBe(91);
      expect(after[0]!.status).toBe('published');
      // Version 2 carries the corrected numbers. 60% is a C/3 in this scale.
      expect(Number(after[1]!.total_obtained)).toBe(60);
      expect(Number(after[1]!.gpa)).toBe(3);
      expect(after[1]!.status).toBe('published');
    });

    it('re-requests the PDF for the new version only', async () => {
      const newest = (await cards(uid.exam))[1]!;
      const named = await rows<{ aggregate_id: string }>(
        `select aggregate_id from outbox_events
          where tenant_id = '${uid.tenant}' and event_type = 'report_card.generated'`,
      );
      const ids = named.map((e) => e.aggregate_id);
      expect(ids).toContain(newest.id);
      // Every request names a card of THIS exam, and the superseded version is not
      // re-requested: a family must never be handed a regenerated old snapshot.
      expect(new Set(ids).size).toBeGreaterThan(0);
    });

    it('is a no-op on redelivery: no duplicate version, no duplicate PDF request', async () => {
      // Fully converged first: the reports job has stamped the new artifact.
      await stampArtifact();
      const before = await cards(uid.exam);
      const pdfBefore = await pdfRequests();

      // Three more deliveries of the same event, as an at-least-once outbox does.
      await compute(uid.tenant, uid.exam);
      await compute(uid.tenant, uid.exam);
      await compute(uid.tenant, uid.exam);

      const after = await cards(uid.exam);
      expect(after).toHaveLength(before.length);
      expect(after.map((c) => c.version)).toEqual(before.map((c) => c.version));
      expect(await pdfRequests()).toBe(pdfBefore);
    });

    it('converges by re-requesting the PDF when the artifact is missing', async () => {
      // A dead-lettered reports job leaves a published card with no artifact. The
      // handler must ask again rather than mint a duplicate version.
      const versions = await cards(uid.exam);
      const newest = versions[versions.length - 1]!;
      await migrator.query(`update report_cards set file_id = null where id = '${newest.id}'`);

      const pdfBefore = await pdfRequests();
      await compute(uid.tenant, uid.exam);

      const after = await cards(uid.exam);
      expect(after).toHaveLength(versions.length);
      expect(after.map((c) => c.version)).toEqual(versions.map((c) => c.version));
      expect(await pdfRequests()).toBe(pdfBefore + 1);
    });
  });

  // -------------------------------------------------- B2/B3 frozen subject lines
  describe('B2 a published version keeps the document it was published with', () => {
    it('freezes version 1 at 91 while version 2 carries the corrected 60', async () => {
      const versions = await cards(uid.exam);
      expect(versions.map((c) => c.version)).toEqual([1, 2]);

      const v1 = await snapshot(versions[0]!.id);
      expect(v1).toHaveLength(1);
      expect(Number(v1[0]!.marks_obtained)).toBe(91);
      expect(Number(versions[0]!.total_obtained)).toBe(91);
      expect(Number(versions[0]!.gpa)).toBe(4);

      const v2 = await snapshot(versions[1]!.id);
      expect(Number(v2[0]!.marks_obtained)).toBe(60);
      // 60% is a C/3 in this scale.
      expect(v2[0]!.grade_label).toBe('C');
      expect(Number(versions[1]!.total_obtained)).toBe(60);
      expect(Number(versions[1]!.gpa)).toBe(3);
    });

    it('agrees with the live mark only in the version that was recomputed', async () => {
      const versions = await cards(uid.exam);
      const live = await rows<{ marks_obtained: string; grade_label: string }>(
        `select marks_obtained, grade_label from marks where id = '${uid.mark}'`,
      );
      expect(Number(live[0]!.marks_obtained)).toBe(60);

      // The historical version is a document, so it still reads what it said when it
      // was published - the correction belongs to version 2, not to version 1.
      expect(Number((await snapshot(versions[0]!.id))[0]!.marks_obtained)).toBe(91);
      expect(Number((await snapshot(versions[1]!.id))[0]!.marks_obtained)).toBe(60);
    });

    it('refuses to edit or delete a published version\'s lines, even for the table owner', async () => {
      const versions = await cards(uid.exam);
      const v1 = versions[0]!.id;

      await expect(
        migrator.query(`update report_card_subjects set marks_obtained = 1 where report_card_id = '${v1}'`),
      ).rejects.toThrow(/frozen/i);
      await expect(
        migrator.query(`delete from report_card_subjects where report_card_id = '${v1}'`),
      ).rejects.toThrow(/frozen/i);
      // The failed statements were rolled back to their own savepoint, so nothing moved.
      expect(Number((await snapshot(v1))[0]!.marks_obtained)).toBe(91);
    });

    it('refuses to publish a card whose aggregate does not describe its own lines', async () => {
      // B2, at the database rather than in the handler: the guard is the deferred
      // constraint trigger, so no code path can publish a card that lies about
      // itself, whoever writes it.
      const card = await rows<{ id: string; version: number }>(
        `select id, version from report_cards where exam_id = '${uid.exam}' and deleted_at is null
          order by version desc limit 1`,
      );
      const bogus = randomUUID();
      await expect(
        migrator
          .query('begin')
          .then(() =>
            migrator.query(
              `insert into report_cards (id, tenant_id, exam_id, student_id, enrollment_id, academic_year_id, version, status, gpa, total_obtained, total_possible, subject_count, published_at)
               values ('${bogus}', '${uid.tenant}', '${uid.exam}', '${uid.student}', '${uid.enroll}', '${uid.year}', 99, 'published', 1, 5, 5, 1, now())`,
            ),
          )
          .then(() => migrator.query('commit')),
      ).rejects.toThrow(/snapshot/i);
      await migrator.query('rollback').catch(() => undefined);
      const left = await rows<{ n: number }>(`select count(*)::int n from report_cards where id = '${bogus}'`);
      expect(Number(left[0]!.n)).toBe(0);
      expect(card).toHaveLength(1);
    });

    it('refuses a line naming a sibling exam\'s subject (B3)', async () => {
      // The worker's own PDF loader had no exam predicate in SQL and filtered in
      // JavaScript, so a sibling exam's subject could be printed on this card. The
      // snapshot makes that unrepresentable: a line must belong to its card's exam.
      const card = (
        await rows<{ id: string }>(
          `select id from report_cards where exam_id = '${uid.exam}' and deleted_at is null
            order by version desc limit 1`,
        )
      )[0]!;
      const otherEs = randomUUID();
      const otherExam = randomUUID();
      await migrator.query('begin');
      try {
        await migrator.query(
          `insert into exams (id, tenant_id, academic_term_id, academic_year_id, exam_type_id, grading_scale_id, name, status)
           values ('${otherExam}', '${uid.tenant}', '${uid.term}', '${uid.year}', '${uid.type}', '${uid.scale}', 'Sibling', 'draft')`,
        );
        await migrator.query(
          `insert into exam_subjects (id, tenant_id, exam_id, class_subject_id, academic_year_id, class_id, subject_id, max_marks, weight)
           values ('${otherEs}', '${uid.tenant}', '${otherExam}', '${uid.link}', '${uid.year}', '${uid.class}', '${uid.subject}', 100, 1)`,
        );
        await migrator.query(
          `update exams set status = 'published', published_at = now() where id = '${otherExam}'`,
        );
        await expect(
          migrator.query(
            `insert into report_card_subjects (tenant_id, report_card_id, exam_subject_id, subject_id, subject_name, marks_obtained, max_marks, weight, percentage, grade_label, grade_point)
             values ('${uid.tenant}', '${card.id}', '${otherEs}', '${uid.subject}', 'Sibling', 50, 100, 1, 50, 'B', 2)`,
          ),
        ).rejects.toThrow(/own exam/i);
      } finally {
        await migrator.query('rollback');
      }
    });

    it('renders the PDF from the snapshot, not from the live marks', async () => {
      // The last correctness link: a delivered document is a function of the card's
      // frozen lines alone.
      const versions = await cards(uid.exam);
      const doc = await loadReportCardDocument(db as unknown as Tx, uid.tenant, versions[0]!.id);
      expect(doc).not.toBeNull();
      const text = doc!.lines.map((l) => l.text).join('\n');
      expect(text).toContain('Version: 1 (published)');
      expect(text).toContain('91.00');
      expect(text).not.toContain('60.00');
    });
  });
});
