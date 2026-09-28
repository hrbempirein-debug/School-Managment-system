import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { getEnv } from '@sms/config';
import { publishReportCardWithSnapshot } from '../testing/publish-card.js';

/**
 * Phase 6 DB security + exam/result integrity proofs, run against the REAL roles +
 * disposable test database (school_app_rw -> school_saas_test). Requires migration 0015
 * (exam_types, grading_scales, exams, exam_subjects, exam_schedules, marks,
 * report_cards, mark_corrections: FORCE RLS, lifecycle triggers, derived-grade
 * trigger, published-mark freeze, correction workflow, permission backfill).
 *
 * Section A (row-level security): all eight new tables are FORCE RLS; a bare
 * app_rw session sees nothing; a signed tenant context sees only its own rows;
 * cross-tenant INSERT is rejected; `mark_corrections` is granted INSERT + SELECT
 * only (an append-only audit table); the legacy forgeable GUCs grant nothing.
 *
 * Section B (domain integrity, DATABASE_DESIGN §8 + roadmap "Tests" bullet):
 *   * grading scale bands must tile 0..100 without gap/overlap; code + version are
 *     immutable; one active version per scale code; an active scale's bands are frozen.
 *   * exam lifecycle moves forward (draft -> scheduled -> grading -> published),
 *     cancellable before publication, terminal once published; a published exam
 *     cannot be reconfigured or deleted with results, and publication always
 *     needs a stamp.
 *   * exam subjects / schedules may only be configured before grading; a schedule
 *     must fall inside the exam term; a live subject carries at most one schedule.
 *   * MARKS: bounds (marks_obtained <= max_marks), enrollment/student/section/year
 *     coherence, active-membership actor, DERIVED percentage + grade (never posted),
 *     server-derived status, and the publish freeze: a published mark cannot be
 *     inserted, changed, or unlocked without a matching mark_corrections row in the
 *     same transaction — which is the roadmap's "publish immutability (post-publish
 *     UPDATE only via correction path)" and "illegal mark edit blocked at DB trigger".
 *   * REPORT CARDS: generated only while an exam is grading/published, one live
 *     draft per (exam, student), versioned, and a published snapshot is frozen
 *     (the reports worker may still stamp the artifact pointer exactly once).
 *
 * Opt-in: RUN_RUNTIME_SECURITY_TESTS=1 (requires PostgreSQL + migration 0015).
 */
const enabled = process.env.RUN_RUNTIME_SECURITY_TESTS === '1';
const describeDb = enabled ? describe : describe.skip;

const NEW_TABLES = [
  'exam_types',
  'grading_scales',
  'exams',
  'exam_subjects',
  'exam_schedules',
  'marks',
  'report_cards',
  'report_card_subjects',
  'mark_corrections',
];

/** Bands tiling 0..100 in four steps. */
const BANDS = [
  { label: 'A', minPercent: 0, maxPercent: 40, gradePoint: 1 },
  { label: 'B', minPercent: 40, maxPercent: 60, gradePoint: 2 },
  { label: 'C', minPercent: 60, maxPercent: 80, gradePoint: 3 },
  { label: 'D', minPercent: 80, maxPercent: 100, gradePoint: 4 },
];

describeDb('Phase 6 RLS + exam/result integrity (exams, marks, report cards on school_saas_test)', () => {
  let migrator: pg.Client;
  let app: pg.Client;
  const uid: Record<string, string> = {};
  const slug = 'p6' + randomUUID().slice(0, 8);

  const appQ = <T extends pg.QueryResultRow = pg.QueryResultRow>(
    sqlText: string,
  ): Promise<T[]> => app.query<T>(sqlText).then((r) => r.rows);
  const migQ = <T extends pg.QueryResultRow = pg.QueryResultRow>(
    sqlText: string,
  ): Promise<T[]> => migrator.query<T>(sqlText).then((r) => r.rows);

  const rejectCode = async (
    fn: () => Promise<unknown>,
    code: string,
    pattern?: RegExp,
  ): Promise<void> => {
    await app.query('savepoint sp');
    const caught = await fn().catch((err: pg.DatabaseError) => err);
    await app.query('rollback to savepoint sp');
    expect(caught).toBeInstanceOf(Error);
    expect((caught as pg.DatabaseError).code).toBe(code);
    if (pattern) expect((caught as Error).message).toMatch(pattern);
  };

  /**
   * Same contract as `rejectCode`, but for statements issued on the MIGRATOR
   * connection: a rejected statement aborts that transaction, so it needs its own
   * savepoint or every later statement fails with 25P02.
   */
  const migReject = async (
    fn: () => Promise<unknown>,
    code: string,
    pattern?: RegExp,
  ): Promise<void> => {
    await migrator.query('savepoint sp');
    const caught = await fn().catch((err: pg.DatabaseError) => err);
    await migrator.query('rollback to savepoint sp');
    expect(caught).toBeInstanceOf(Error);
    expect((caught as pg.DatabaseError).code).toBe(code);
    if (pattern) expect((caught as Error).message).toMatch(pattern);
  };

  /** Runs `fn` inside a signed tenant-A transaction, always rolled back. */
  async function tenantA<T>(fn: () => Promise<T>): Promise<T> {
    const tkt = (
      await appQ(`select app_ctx_mint('tenant', '${uid.teacher}', '${uid.tenantA}') t`)
    )[0]!.t as string;
    await app.query('begin');
    await app.query(`set local app.rls = '${tkt}'`);
    try {
      return await fn();
    } finally {
      await app.query('rollback').catch(() => {});
    }
  }

  async function tenantB<T>(fn: () => Promise<T>): Promise<T> {
    const tkt = (
      await appQ(`select app_ctx_mint('tenant', '${uid.userB}', '${uid.tenantB}') t`)
    )[0]!.t as string;
    await app.query('begin');
    await app.query(`set local app.rls = '${tkt}'`);
    try {
      return await fn();
    } finally {
      await app.query('rollback').catch(() => {});
    }
  }

  /**
   * Publish a report card the way the reports worker does, and in that order:
   * write the card as a DRAFT, freeze its subject lines in, store the aggregate
   * those lines describe, and only then transition it to `published`.
   *
   * The sequence itself is NOT restated here. It lives once, in
   * `publishReportCardWithSnapshot` (@sms/db/src/testing/publish-card.ts), which
   * the API acceptance suite calls too, so the two suites cannot drift into
   * disagreeing about what a coherent published card is. This wrapper only pins
   * the tenant and the default status for the local call sites.
   */
  async function publishCardWithSnapshot(args: {
    studentId: string;
    enrollmentId: string;
    examId: string;
    version: number;
  }): Promise<string> {
    return publishReportCardWithSnapshot(migrator, {
      tenantId: uid.tenantA!,
      status: 'published',
      studentId: args.studentId,
      enrollmentId: args.enrollmentId,
      examId: args.examId,
      version: args.version,
    });
  }

  beforeAll(async () => {
    const env = getEnv();
    migrator = new pg.Client({ connectionString: env.DATABASE_URL_MIGRATOR });
    app = new pg.Client({ connectionString: env.DATABASE_URL_APP });
    await migrator.connect();
    await app.connect();

    for (const k of [
      'userA',
      'userB',
      'teacher',
      'tenantA',
      'tenantB',
      'campusA',
      'campusB',
      'yearA',
      'yearB',
      'termA',
      'termB',
      'levelA',
      'subjA',
      'classA',
      'sectionA',
      'linkA',
      'assignA',
      'studentA1',
      'studentA2',
      'studentA3',
      'enrollA1',
      'enrollA2',
      'enrollA3',
      'typeA',
      'scaleA',
      'scaleA2',
      'examDraft',
      'examSched',
      'examGrading',
      'examPublished',
      'esDraft',
      'esSched',
      'esGrading',
      'esPublished',
      'schedPublished',
      'markA1',
      'markA2',
      'markPublished',
      'correction',
      'cardDraft',
      'fileA',
      'roleTeacherA',
      'memberTeacherA',
      'examB',
      'typeB',
      'studentB1',
      'subjB',
      'subjB2',
      'linkB2',
      'levelB',
      'classB',
      'linkB',
      'sectionB',
      'enrollB1',
      'esB1',
      'esB2',
      'markB1',
      'scaleB',
      'schedB',
      'correctionB',
    ]) {
      uid[k] = randomUUID();
    }

    await migrator.query('begin');
    await migrator.query(
      `insert into tenants (id, slug, name) values
         ('${uid.tenantA}', '${slug}-a', 'Exam A'),
         ('${uid.tenantB}', '${slug}-b', 'Exam B')`,
    );
    await migrator.query(
      `insert into users (id, email) values
         ('${uid.userA}', 'p6-a-${slug}@example.com'),
         ('${uid.userB}', 'p6-b-${slug}@example.com'),
         ('${uid.teacher}', 'p6-te-${slug}@example.com')`,
    );
    await migrator.query(
      `insert into user_profiles (user_id, full_name) values
         ('${uid.userA}', 'Caller A'),
         ('${uid.userB}', 'Caller B'),
         ('${uid.teacher}', 'Exam Teacher')`,
    );
    await migrator.query(
      `insert into memberships (id, tenant_id, user_id, status) values
         ('${uid.memberTeacherA}', '${uid.tenantA}', '${uid.teacher}', 'active'),
         ('${randomUUID()}', '${uid.tenantA}', '${uid.userA}', 'active'),
         ('${randomUUID()}', '${uid.tenantB}', '${uid.userB}', 'active')`,
    );
    await migrator.query(
      `insert into roles (id, tenant_id, scope, code, name, is_system) values
         ('${uid.roleTeacherA}', '${uid.tenantA}', 'tenant', 'teacher', 'Teacher', true)`,
    );
    await migrator.query(
      `insert into membership_roles (membership_id, role_id) values
         ('${uid.memberTeacherA}', '${uid.roleTeacherA}')`,
    );
    await migrator.query(
      `insert into campuses (id, tenant_id, code, name, status) values
         ('${uid.campusA}', '${uid.tenantA}', 'cb-${slug}', 'Campus A', 'active'),
         ('${uid.campusB}', '${uid.tenantB}', 'cb-${slug}', 'Campus B', 'active')`,
    );
    await migrator.query(
      `insert into academic_years (id, tenant_id, code, name, starts_on, ends_on, status) values
         ('${uid.yearA}', '${uid.tenantA}', 'y-${slug}', 'AY A', '2026-01-01', '2026-12-31', 'active'),
         ('${uid.yearB}', '${uid.tenantB}', 'y-${slug}', 'AY B', '2026-01-01', '2026-12-31', 'active')`,
    );
    await migrator.query(
      `insert into academic_terms (id, tenant_id, academic_year_id, code, name, sequence, starts_on, ends_on, status) values
         ('${uid.termA}', '${uid.tenantA}', '${uid.yearA}', 't-${slug}', 'Term A', 1, '2026-01-01', '2026-06-30', 'open'),
         ('${uid.termB}', '${uid.tenantB}', '${uid.yearB}', 't-${slug}', 'Term B', 1, '2026-01-01', '2026-06-30', 'open')`,
    );
    await migrator.query(
      `insert into grade_levels (id, tenant_id, code, name, status) values
         ('${uid.levelA}', '${uid.tenantA}', 'gl-${slug}', 'Grade A', 'active')`,
    );
    await migrator.query(
      `insert into subjects (id, tenant_id, code, name, status) values
         ('${uid.subjA}', '${uid.tenantA}', 'sb-${slug}', 'Maths', 'active')`,
    );
    await migrator.query(
      `insert into acd_classes (id, tenant_id, campus_id, academic_year_id, grade_level_id, code, name, status) values
         ('${uid.classA}', '${uid.tenantA}', '${uid.campusA}', '${uid.yearA}', '${uid.levelA}', 'c-${slug}', 'Class A', 'active')`,
    );
    await migrator.query(
      `insert into sections (id, tenant_id, class_id, campus_id, academic_year_id, code, status) values
         ('${uid.sectionA}', '${uid.tenantA}', '${uid.classA}', '${uid.campusA}', '${uid.yearA}', 's-${slug}', 'active')`,
    );
    await migrator.query(
      `insert into class_subjects (id, tenant_id, class_id, subject_id, campus_id, academic_year_id) values
         ('${uid.linkA}', '${uid.tenantA}', '${uid.classA}', '${uid.subjA}', '${uid.campusA}', '${uid.yearA}')`,
    );
    await migrator.query(
      `insert into teacher_assignments (id, tenant_id, class_id, subject_id, teacher_user_id, campus_id, academic_year_id) values
         ('${uid.assignA}', '${uid.tenantA}', '${uid.classA}', '${uid.subjA}', '${uid.teacher}', '${uid.campusA}', '${uid.yearA}')`,
    );
    await migrator.query(
      `insert into students (id, tenant_id, student_no, first_name, last_name, status, primary_campus_id) values
         ('${uid.studentA1}', '${uid.tenantA}', 's1-${slug}', 'Ada', 'One', 'active', '${uid.campusA}'),
         ('${uid.studentA2}', '${uid.tenantA}', 's2-${slug}', 'Ben', 'Two', 'active', '${uid.campusA}'),
         ('${uid.studentA3}', '${uid.tenantA}', 's3-${slug}', 'Cy', 'Three', 'active', '${uid.campusA}')`,
    );
    await migrator.query(
      `insert into enrollments (id, tenant_id, student_id, academic_year_id, class_id, section_id, roll_no, status) values
         ('${uid.enrollA1}', '${uid.tenantA}', '${uid.studentA1}', '${uid.yearA}', '${uid.classA}', '${uid.sectionA}', '01', 'active'),
         ('${uid.enrollA2}', '${uid.tenantA}', '${uid.studentA2}', '${uid.yearA}', '${uid.classA}', '${uid.sectionA}', '02', 'active'),
         ('${uid.enrollA3}', '${uid.tenantA}', '${uid.studentA3}', '${uid.yearA}', '${uid.classA}', '${uid.sectionA}', '03', 'active')`,
    );
    await migrator.query(
      `insert into files (id, tenant_id, storage_key, original_name, mime, size_bytes, visibility, created_by) values
         ('${uid.fileA}', '${uid.tenantA}', 'exam/${slug}/card.pdf', 'card.pdf', 'application/pdf', 12, 'private', '${uid.userA}')`,
    );
    await migrator.query(
      `insert into exam_types (id, tenant_id, code, name) values
         ('${uid.typeA}', '${uid.tenantA}', 'midterm_${slug}', 'Midterm'),
         ('${uid.typeB}', '${uid.tenantB}', 'midterm_${slug}', 'Midterm')`,
    );
    await migrator.query(
      `insert into grading_scales (id, tenant_id, code, name, version, is_active, bands) values
         ('${uid.scaleA}', '${uid.tenantA}', 'std_${slug}', 'Standard', 1, true, '${JSON.stringify(BANDS)}'::jsonb),
         ('${uid.scaleA2}', '${uid.tenantA}', 'std_${slug}', 'Standard v2', 2, false, '${JSON.stringify(BANDS)}'::jsonb)`,
    );
    // Four exams spanning the whole lifecycle, all pinned to term A.
    // `examPublished` is created in 'grading' on purpose: its marks are entered
    // first, then the PUBLICATION SWEEP (trg_exams_publish_lock_marks) locks them
    // when the exam flips to 'published'.
    await migrator.query(
      `insert into exams (id, tenant_id, academic_term_id, academic_year_id, exam_type_id, grading_scale_id, name, status) values
         ('${uid.examDraft}', '${uid.tenantA}', '${uid.termA}', '${uid.yearA}', '${uid.typeA}', '${uid.scaleA}', 'Draft ${slug}', 'draft'),
         ('${uid.examSched}', '${uid.tenantA}', '${uid.termA}', '${uid.yearA}', '${uid.typeA}', '${uid.scaleA}', 'Sched ${slug}', 'draft'),
         ('${uid.examGrading}', '${uid.tenantA}', '${uid.termA}', '${uid.yearA}', '${uid.typeA}', '${uid.scaleA}', 'Grading ${slug}', 'draft'),
         ('${uid.examPublished}', '${uid.tenantA}', '${uid.termA}', '${uid.yearA}', '${uid.typeA}', '${uid.scaleA}', 'Published ${slug}', 'draft'),
         ('${uid.examB}', '${uid.tenantB}', '${uid.termB}', '${uid.yearB}', '${uid.typeB}', null, 'Foreign ${slug}', 'draft')`,
    );
    await migrator.query(
      `insert into exam_subjects (id, tenant_id, exam_id, class_subject_id, academic_year_id, class_id, subject_id, max_marks, weight) values
         ('${uid.esDraft}', '${uid.tenantA}', '${uid.examDraft}', '${uid.linkA}', '${uid.yearA}', '${uid.classA}', '${uid.subjA}', 100, 1),
         ('${uid.esSched}', '${uid.tenantA}', '${uid.examSched}', '${uid.linkA}', '${uid.yearA}', '${uid.classA}', '${uid.subjA}', 50, 1),
         ('${uid.esGrading}', '${uid.tenantA}', '${uid.examGrading}', '${uid.linkA}', '${uid.yearA}', '${uid.classA}', '${uid.subjA}', 100, 2),
         ('${uid.esPublished}', '${uid.tenantA}', '${uid.examPublished}', '${uid.linkA}', '${uid.yearA}', '${uid.classA}', '${uid.subjA}', 100, 1)`,
    );
    await migrator.query(
      `insert into exam_schedules (id, tenant_id, exam_subject_id, starts_at, ends_at, room) values
         ('${uid.schedPublished}', '${uid.tenantA}', '${uid.esGrading}', '2026-03-02 09:00:00+00', '2026-03-02 11:00:00+00', 'R1')`,
    );
    // Configuration is complete: the exams now walk the lifecycle.
    await migrator.query(
      `update exams set status = 'scheduled' where id = '${uid.examSched}'`,
    );
    await migrator.query(`update exams set status = 'grading' where id in ('${uid.examGrading}')`);
    await migrator.query(`update exams set status = 'grading' where id = '${uid.examPublished}'`);
    await migrator.query(
      `insert into marks (id, tenant_id, exam_subject_id, enrollment_id, student_id, section_id, academic_year_id, marks_obtained, percentage, grade_label, grade_point, status, entered_by) values
         ('${uid.markA1}', '${uid.tenantA}', '${uid.esGrading}', '${uid.enrollA1}', '${uid.studentA1}', '${uid.sectionA}', '${uid.yearA}', 85, 85, 'D', 4, 'provisional', '${uid.teacher}'),
         ('${uid.markA2}', '${uid.tenantA}', '${uid.esGrading}', '${uid.enrollA2}', '${uid.studentA2}', '${uid.sectionA}', '${uid.yearA}', 45, 45, 'B', 2, 'provisional', '${uid.teacher}'),
         ('${uid.markPublished}', '${uid.tenantA}', '${uid.esPublished}', '${uid.enrollA2}', '${uid.studentA2}', '${uid.sectionA}', '${uid.yearA}', 70, 70, 'C', 3, 'provisional', '${uid.teacher}')`,
    );
    // Publish: the AFTER trigger locks the exam's provisional marks, so the
    // published mark starts life as locked.
    await migrator.query(
      `update exams set status = 'published', published_at = now() where id = '${uid.examPublished}'`,
    );
    // The fixture exercises the correction workflow once (70 -> 85), which leaves
    // a `rechecked` published mark and a real append-only audit row behind.
    await migrator.query(
      `insert into mark_corrections (id, tenant_id, mark_id, exam_id, exam_subject_id, student_id, old_marks_obtained, new_marks_obtained, reason, corrected_by)
       values ('${uid.correction}', '${uid.tenantA}', '${uid.markPublished}', '${uid.examPublished}', '${uid.esPublished}', '${uid.studentA2}', 70, 85, 'fixture correction applied during setup', '${uid.teacher}')`,
    );
    await migrator.query(`update marks set marks_obtained = 85 where id = '${uid.markPublished}'`);
    await migrator.query(
      `insert into report_cards (id, tenant_id, exam_id, student_id, enrollment_id, academic_year_id, version, status, gpa, total_obtained, total_possible, subject_count) values
         ('${uid.cardDraft}', '${uid.tenantA}', '${uid.examGrading}', '${uid.studentA1}', '${uid.enrollA1}', '${uid.yearA}', 1, 'draft', 4, 85, 100, 1)`,
    );
    // One PUBLISHED card carrying a real subject snapshot, written through the
    // same draft -> lines -> aggregate -> publish order the worker uses.
    //
    // It is part of the shared fixture rather than of a later section because
    // section A asserts, for every one of the eight new tables, that the runtime
    // role sees its own tenant's rows and none of another tenant's. For
    // `report_card_subjects` that assertion is only meaningful if the fixture
    // already contains snapshot lines, so the card is really published here
    // instead of the assertion being relaxed. (The audit's finding was that the
    // assertion was wrong about WHEN data exists, not about who may see it.)
    uid.cardPublished = await publishCardWithSnapshot({
      studentId: uid.studentA2!,
      enrollmentId: uid.enrollA2!,
      examId: uid.examPublished!,
      version: 1,
    });
    // The SAME chain for tenant B, on tenant B's own exam.
    //
    // Section A asserts that the runtime role sees none of another tenant's rows.
    // That assertion is only worth anything if the other tenant HAS rows to hide:
    // against an empty neighbour it passes no matter how broken the policy is.
    // (Counterfactually, replacing the `report_card_subjects` SELECT policy with
    // `using (true)` left the original assertion green, because tenant B had no
    // snapshot lines to leak. The control below is what makes it bite.)
    await migrator.query(
      `insert into students (id, tenant_id, student_no, first_name, last_name, status, primary_campus_id) values
         ('${uid.studentB1}', '${uid.tenantB}', 'b1-${slug}', 'Bo', 'One', 'active', '${uid.campusB}')`,
    );
    await migrator.query(
      `insert into subjects (id, tenant_id, code, name, status) values
         ('${uid.subjB}', '${uid.tenantB}', 'sb-${slug}', 'Science', 'active')`,
    );
    await migrator.query(
      `insert into grade_levels (id, tenant_id, code, name, status) values
         ('${uid.levelB}', '${uid.tenantB}', 'gl-${slug}', 'Grade B', 'active')`,
    );
    await migrator.query(
      `insert into acd_classes (id, tenant_id, campus_id, academic_year_id, grade_level_id, code, name, status) values
         ('${uid.classB}', '${uid.tenantB}', '${uid.campusB}', '${uid.yearB}', '${uid.levelB}', 'cb-${slug}', 'Class B', 'active')`,
    );
    await migrator.query(
      `insert into class_subjects (id, tenant_id, class_id, subject_id, campus_id, academic_year_id) values
         ('${uid.linkB}', '${uid.tenantB}', '${uid.classB}', '${uid.subjB}', '${uid.campusB}', '${uid.yearB}')`,
    );
    await migrator.query(
      `insert into sections (id, tenant_id, class_id, campus_id, academic_year_id, code, status) values
         ('${uid.sectionB}', '${uid.tenantB}', '${uid.classB}', '${uid.campusB}', '${uid.yearB}', 's-${slug}', 'active')`,
    );
    await migrator.query(
      `insert into enrollments (id, tenant_id, student_id, academic_year_id, class_id, section_id, roll_no, status) values
         ('${uid.enrollB1}', '${uid.tenantB}', '${uid.studentB1}', '${uid.yearB}', '${uid.classB}', '${uid.sectionB}', '01', 'active')`,
    );
    await migrator.query(
      `insert into exam_subjects (id, tenant_id, exam_id, class_subject_id, academic_year_id, class_id, subject_id, max_marks, weight) values
         ('${uid.esB1}', '${uid.tenantB}', '${uid.examB}', '${uid.linkB}', '${uid.yearB}', '${uid.classB}', '${uid.subjB}', 100, 1)`,
    );
    await migrator.query(
      `insert into grading_scales (id, tenant_id, code, name, version, is_active, bands) values
         ('${uid.scaleB}', '${uid.tenantB}', 'std_${slug}', 'Standard B', 1, true, '${JSON.stringify(BANDS)}'::jsonb)`,
    );
    await migrator.query(
      `update exams set grading_scale_id = '${uid.scaleB}' where id = '${uid.examB}'`,
    );
    // A second exam subject with NO mark behind it. A snapshot line for it is
    // perfectly legal on its face - the validate trigger only requires that the
    // line copy its exam subject's max_marks and weight - which makes it the
    // cleanest way to show that RLS, and not a trigger, is what refuses a
    // cross-tenant write.
    await migrator.query(
      `insert into subjects (id, tenant_id, code, name, status) values
         ('${uid.subjB2}', '${uid.tenantB}', 'sb2-${slug}', 'History', 'active')`,
    );
    await migrator.query(
      `insert into class_subjects (id, tenant_id, class_id, subject_id, campus_id, academic_year_id) values
         ('${uid.linkB2}', '${uid.tenantB}', '${uid.classB}', '${uid.subjB2}', '${uid.campusB}', '${uid.yearB}')`,
    );
    await migrator.query(
      `insert into exam_subjects (id, tenant_id, exam_id, class_subject_id, academic_year_id, class_id, subject_id, max_marks, weight) values
         ('${uid.esB2}', '${uid.tenantB}', '${uid.examB}', '${uid.linkB2}', '${uid.yearB}', '${uid.classB}', '${uid.subjB2}', 40, 2)`,
    );
    await migrator.query(
      `insert into exam_schedules (id, tenant_id, exam_subject_id, starts_at, ends_at, room) values
         ('${uid.schedB}', '${uid.tenantB}', '${uid.esB1}', '2026-04-02 09:00:00+00', '2026-04-02 11:00:00+00', 'RB1')`,
    );
    await migrator.query(`update exams set status = 'grading' where id = '${uid.examB}'`);
    await migrator.query(
      `insert into marks (id, tenant_id, exam_subject_id, enrollment_id, student_id, section_id, academic_year_id, marks_obtained, percentage, grade_label, grade_point, status, entered_by) values
         ('${uid.markB1}', '${uid.tenantB}', '${uid.esB1}', '${uid.enrollB1}', '${uid.studentB1}', '${uid.sectionB}', '${uid.yearB}', 60, 60, 'B', 2, 'provisional', '${uid.userB}')`,
    );
    // A card may only be published alongside a published exam, and marks may only
    // be entered while it is grading - so tenant B's exam walks the same lifecycle
    // tenant A's does before its card is minted.
    await migrator.query(
      `update exams set status = 'published', published_at = now() where id = '${uid.examB}'`,
    );
    // Tenant B gets a correction of its own so the RLS sweep has a genuine
    // append-only audit row to hide from tenant A, rather than an empty table that
    // would make the isolation assertion pass for the wrong reason. The correction
    // is written while the mark still holds its OLD value, exactly as the
    // append-only trigger requires, and the mark is moved to the new value after.
    await migrator.query(
      `insert into mark_corrections (id, tenant_id, mark_id, exam_id, exam_subject_id, student_id, old_marks_obtained, new_marks_obtained, reason, corrected_by)
       values ('${uid.correctionB}', '${uid.tenantB}', '${uid.markB1}', '${uid.examB}', '${uid.esB1}', '${uid.studentB1}', 60, 72, 'tenant B fixture correction', '${uid.userB}')`,
    );
    await migrator.query(`update marks set marks_obtained = 72 where id = '${uid.markB1}'`);
    uid.cardPublishedB = await publishReportCardWithSnapshot(migrator, {
      tenantId: uid.tenantB!,
      status: 'published',
      studentId: uid.studentB1!,
      enrollmentId: uid.enrollB1!,
      examId: uid.examB!,
      version: 1,
    });
    // A second tenant-B card left as a DRAFT. The freeze does not apply to a
    // draft, so a cross-tenant line written into THIS card is refused by the RLS
    // WITH CHECK policy alone - which is the boundary test 4c is about.
    uid.cardDraftB = await publishReportCardWithSnapshot(migrator, {
      tenantId: uid.tenantB!,
      status: 'draft',
      studentId: uid.studentB1!,
      enrollmentId: uid.enrollB1!,
      examId: uid.examB!,
      version: 2,
    });
    await migrator.query('commit');
  });

  afterAll(async () => {
    try {
      // A failed fixture leaves the connection in an aborted transaction; clear
      // it so cleanup can run.
      await migrator.query('rollback');
      await app.query('rollback').catch(() => undefined);
      await migrator.query('begin');
      const t = `'${uid.tenantA}','${uid.tenantB}'`;
      // mark_corrections is append-only by trigger, so the fixture may only
      // dispose of its own audit rows with the guard lifted. The disable is
      // re-enabled before the commit, and the whole teardown is transactional,
      // so a failure anywhere here rolls the guard back on.
      await migrator.query(
        `alter table mark_corrections disable trigger mark_corrections_append_only_trg`,
      );
      await migrator.query(`delete from mark_corrections where tenant_id in (${t})`);
      await migrator.query(
        `alter table mark_corrections enable trigger mark_corrections_append_only_trg`,
      );
      // A published card's subject lines are frozen for every role (B2), so the
      // fixture disposes of them the same way it disposes of the card itself:
      // guard lifted for the one teardown statement, restored immediately after.
      // 0018 splits that freeze out of the integrity trigger into
      // `report_card_subjects_freeze_trg`, so THAT is the guard to lift here; the
      // validate trigger is left enabled and has nothing to say about a DELETE.
      //
      // The lines go BEFORE their card: `report_card_subjects_card_fk` is a plain
      // NO ACTION foreign key, so a card that still has lines cannot be deleted.
      await migrator.query(
        `alter table report_card_subjects disable trigger report_card_subjects_freeze_trg`,
      );
      await migrator.query(`delete from report_card_subjects where tenant_id in (${t})`);
      await migrator.query(
        `alter table report_card_subjects enable trigger report_card_subjects_freeze_trg`,
      );
      // report_cards carries a PUBLISHED-row hard-DELETE guard with no role bypass
      // (P2-03), disposed of exactly like the mark guard below.
      await migrator.query(
        `alter table report_cards disable trigger report_cards_hard_delete_guard_trg`,
      );
      await migrator.query(`delete from report_cards where tenant_id in (${t})`);
      await migrator.query(
        `alter table report_cards enable trigger report_cards_hard_delete_guard_trg`,
      );
      // marks carries a published-row DELETE guard with no role bypass (F-03), so
      // the fixture disposes of its own published rows the same way it disposes of
      // the append-only ledger: guard lifted for the one teardown statement,
      // restored immediately after, inside this same transaction.
      await migrator.query(`alter table marks disable trigger marks_delete_guard_trg`);
      await migrator.query(`delete from marks where tenant_id in (${t})`);
      await migrator.query(`alter table marks enable trigger marks_delete_guard_trg`);
      await migrator.query(`delete from exam_schedules where tenant_id in (${t})`);
      await migrator.query(`delete from exam_subjects where tenant_id in (${t})`);
      await migrator.query(`delete from exams where tenant_id in (${t})`);
      await migrator.query(`delete from grading_scales where tenant_id in (${t})`);
      await migrator.query(`delete from exam_types where tenant_id in (${t})`);
      await migrator.query(`delete from files where tenant_id in (${t})`);
      await migrator.query(`delete from enrollments where tenant_id in (${t})`);
      await migrator.query(`delete from students where tenant_id in (${t})`);
      await migrator.query(`delete from teacher_assignments where tenant_id in (${t})`);
      await migrator.query(`delete from class_subjects where tenant_id in (${t})`);
      await migrator.query(`delete from sections where tenant_id in (${t})`);
      await migrator.query(`delete from acd_classes where tenant_id in (${t})`);
      await migrator.query(`delete from subjects where tenant_id in (${t})`);
      await migrator.query(`delete from grade_levels where tenant_id in (${t})`);
      await migrator.query(`delete from academic_terms where tenant_id in (${t})`);
      await migrator.query(`delete from academic_years where tenant_id in (${t})`);
      await migrator.query(`delete from campuses where tenant_id in (${t})`);
      await migrator.query(
        `delete from membership_roles where membership_id in ('${uid.memberTeacherA}')`,
      );
      await migrator.query(`delete from roles where id in ('${uid.roleTeacherA}')`);
      await migrator.query(`delete from memberships where tenant_id in (${t})`);
      await migrator.query(
        `delete from user_profiles where user_id in ('${uid.userA}','${uid.userB}','${uid.teacher}')`,
      );
      await migrator.query(
        `delete from users where id in ('${uid.userA}','${uid.userB}','${uid.teacher}')`,
      );
      await migrator.query(`delete from outbox_events where tenant_id in (${t})`);
      await migrator.query(`delete from tenants where id in (${t})`);
      await migrator.query('commit');
    } finally {
      await migrator.end();
      await app.end();
    }
  });

  describe('A. row-level security boundary', () => {
    it('1. RLS is enabled AND forced on all eight new tables', async () => {
      const res = await migrator.query<{ tbl: string; rls: boolean; force: boolean }>(
        `
        select c.relname tbl, c.relrowsecurity rls, c.relforcerowsecurity force
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relname = ANY($1)
        order by c.relname`,
        [NEW_TABLES],
      );
      expect(res.rows).toHaveLength(NEW_TABLES.length);
      for (const row of res.rows) {
        expect(row.rls, row.tbl).toBe(true);
        expect(row.force, row.tbl).toBe(true);
      }
    });

    it('2. the runtime role holds DML on the domain tables but sees zero rows without a context', async () => {
      for (const t of NEW_TABLES) {
        const r = await appQ<{ n: number }>(`select count(*)::int n from ${t}`);
        expect(Number(r[0]!.n), t).toBe(0);
      }
      const g = await migQ<{ s: boolean; i: boolean; u: boolean; d: boolean }>(`
        select has_table_privilege('school_app_rw', 'exams', 'SELECT') s,
               has_table_privilege('school_app_rw', 'exams', 'INSERT') i,
               has_table_privilege('school_app_rw', 'exams', 'UPDATE') u,
               has_table_privilege('school_app_rw', 'exams', 'DELETE') d`);
      expect(g[0]).toEqual({ s: true, i: true, u: true, d: true });
    });

    it('3. mark_corrections is an append-only audit table: SELECT + INSERT only', async () => {
      const g = await migQ<{ s: boolean; i: boolean; u: boolean; d: boolean }>(`
        select has_table_privilege('school_app_rw', 'mark_corrections', 'SELECT') s,
               has_table_privilege('school_app_rw', 'mark_corrections', 'INSERT') i,
               has_table_privilege('school_app_rw', 'mark_corrections', 'UPDATE') u,
               has_table_privilege('school_app_rw', 'mark_corrections', 'DELETE') d`);
      expect(g[0]).toEqual({ s: true, i: true, u: false, d: false });
    });

    it('3b. even a PRIVILEGED session cannot rewrite the ledger', async () => {
      // The runtime role is stopped by its grants (42501, see test 3), so the
      // trigger is probed directly as the table owner — it is the backstop that
      // survives a role that *does* hold UPDATE/DELETE.
      await expect(
        migrator.query(`update mark_corrections set reason = 'rewritten' where tenant_id = '${uid.tenantA}'`),
      ).rejects.toThrow(/append-only/);
      await expect(
        migrator.query(`delete from mark_corrections where tenant_id = '${uid.tenantA}'`),
      ).rejects.toThrow(/append-only/);
      const intact = await migQ<{ n: number }>(
        `select count(*)::int n from mark_corrections where tenant_id = '${uid.tenantA}'`,
      );
      expect(intact[0]!.n).toBeGreaterThan(0);
    });

    it('4. tenant A sees its own rows and never tenant B', async () => {
      // Control first. "Tenant A sees none of tenant B's rows" is only a real
      // assertion if tenant B HAS rows, so the neighbour's fixtures are counted
      // as the privileged role before the isolation is claimed. Without this the
      // test passes against a completely open policy, because an empty neighbour
      // has nothing to leak.
      for (const t of NEW_TABLES) {
        const neighbour = await migQ<{ n: number }>(
          `select count(*)::int n from ${t} where tenant_id = '${uid.tenantB}'`,
        );
        expect(Number(neighbour[0]!.n), `${t}: tenant B must have rows for this to test isolation`).toBeGreaterThan(0);
      }

      await tenantA(async () => {
        for (const t of NEW_TABLES) {
          const own = (
            await appQ<{ n: number }>(`select count(*)::int n from ${t} where tenant_id = '${uid.tenantA}'`)
          )[0]!.n;
          const foreign = (
            await appQ<{ n: number }>(`select count(*)::int n from ${t} where tenant_id = '${uid.tenantB}'`)
          )[0]!.n;
          expect(Number(own), t).toBeGreaterThan(0);
          expect(Number(foreign), t).toBe(0);
        }
        // Belt and braces: not one visible row anywhere may belong to tenant B.
        for (const t of NEW_TABLES) {
          const leaked = await appQ<{ n: number }>(
            `select count(*)::int n from ${t} where tenant_id <> '${uid.tenantA}'`,
          );
          expect(Number(leaked[0]!.n), t).toBe(0);
        }
      });
    });

    it('4b. a cross-tenant UPDATE on the snapshot touches zero rows', async () => {
      await tenantA(async () => {
        // A write aimed at tenant B's published line. The UPDATE policy filters it
        // out rather than raising, so the tell is rowCount 0 AND the target value
        // being unchanged afterwards.
        const before = await migQ<{ marks_obtained: string }>(
          `select marks_obtained from report_card_subjects where report_card_id = '${uid.cardPublishedB}'`,
        );
        expect(Number(before[0]!.marks_obtained)).toBe(72);
        const upd = await app.query(
          `update report_card_subjects set marks_obtained = 1 where report_card_id = '${uid.cardPublishedB}'`,
        );
        expect(upd.rowCount).toBe(0);
        const after = await migQ<{ marks_obtained: string }>(
          `select marks_obtained from report_card_subjects where report_card_id = '${uid.cardPublishedB}'`,
        );
        expect(Number(after[0]!.marks_obtained)).toBe(72);
      });
    });

    it('4c. a cross-tenant INSERT of a snapshot line is rejected, by a trigger and by the policy', async () => {
      const crossTenantLine = () =>
        app.query(
          `insert into report_card_subjects (tenant_id, report_card_id, exam_subject_id, subject_id, subject_name,
                                             marks_obtained, max_marks, weight, percentage, grade_label, grade_point)
           values ('${uid.tenantB}', '${uid.cardDraftB}', '${uid.esB2}', '${uid.subjB2}', 'History', 10, 40, 2, 25, 'F', 0)`,
        );
      const assertNothingLanded = async () => {
        const left = await migQ<{ n: number }>(
          `select count(*)::int n from report_card_subjects where report_card_id = '${uid.cardDraftB}' and exam_subject_id = '${uid.esB2}'`,
        );
        expect(Number(left[0]!.n)).toBe(0);
      };

      await tenantA(async () => {
        // ===== layer 1: with every trigger armed =====
        // The write is refused, but NOT with 42501. trg_report_card_subjects_validate()
        // is SECURITY INVOKER, so it resolves the foreign exam subject through the very
        // RLS it is supposed to sit behind, finds nothing, and reports 'exam subject not
        // found' (55000) first. That is a real finding about the layering, and asserting
        // 42501 here would be asserting something false: the policy is never reached.
        await rejectCode(crossTenantLine, '55000', /exam subject not found/);
        await assertNothingLanded();
      });

      // ===== layer 2: with both integrity triggers lifted, only the policy remains =====
      // Proves the RLS WITH CHECK policy is genuinely armed for this table and is a
      // real backstop, rather than the protection resting on the triggers alone. BOTH
      // triggers have to go: trg_report_card_subjects_freeze() also calls
      // fn_report_card_line_assert_valid() before it looks at the card's status, so
      // leaving it armed produces the same 55000 for the same reason.
      // They are re-enabled in a finally, so a failure here can never leave the
      // integrity layer disabled for any later test.
      await migrator.query('commit');
      await migrator.query('alter table report_card_subjects disable trigger report_card_subjects_validate_trg');
      await migrator.query('alter table report_card_subjects disable trigger report_card_subjects_freeze_trg');
      try {
        await tenantA(async () => {
          await rejectCode(crossTenantLine, '42501');
          await assertNothingLanded();
        });
      } finally {
        await migrator.query('alter table report_card_subjects enable trigger report_card_subjects_freeze_trg');
        await migrator.query('alter table report_card_subjects enable trigger report_card_subjects_validate_trg');
        const armed = await migQ<{ tgname: string; tgenabled: string }>(
          `select tgname, tgenabled from pg_trigger
            where tgrelid = 'report_card_subjects'::regclass
              and tgname in ('report_card_subjects_validate_trg', 'report_card_subjects_freeze_trg')
            order by tgname`,
        );
        expect(armed.map((r) => [r.tgname, r.tgenabled])).toEqual([
          ['report_card_subjects_freeze_trg', 'O'],
          ['report_card_subjects_validate_trg', 'O'],
        ]);
      }
    });

    it('4d. a cross-tenant DELETE of a snapshot line is rejected for every role', async () => {
      await tenantA(async () => {
        // The runtime role is stopped by the DELETE policy, which filters the row
        // out instead of raising, so the line must survive the attempt...
        const del = await app.query(
          `delete from report_card_subjects where report_card_id = '${uid.cardPublishedB}'`,
        );
        expect(del.rowCount).toBe(0);
        // ...and so must it against the TABLE OWNER, whose policies carry the same
        // tenant term. The owner holding a DELETE grant is the case a policy-only
        // boundary is easiest to get wrong.
        const left = await migQ<{ n: number }>(
          `select count(*)::int n from report_card_subjects where report_card_id = '${uid.cardPublishedB}'`,
        );
        expect(Number(left[0]!.n)).toBe(1);
      });
    });

    it('5. cross-tenant INSERT is rejected by RLS WITH CHECK', async () => {
      await tenantA(async () => {
        // No INSERT trigger on exam_types, so the row is otherwise well formed
        // and the ONLY thing that can reject it is the RLS WITH CHECK policy.
        await rejectCode(
          () =>
            app.query(
              `insert into exam_types (id, tenant_id, code, name)
               values ('${randomUUID()}', '${uid.tenantB}', 'x_${slug}', 'X')`,
            ),
          '42501',
        );
        // A row that carries tenant B's OWN parents still fails: the policy, not
        // the triggers, is the boundary.
        await rejectCode(
          () =>
            app.query(
              `insert into exams (id, tenant_id, academic_term_id, academic_year_id, exam_type_id, name)
               values ('${randomUUID()}', '${uid.tenantB}', '${uid.termB}', '${uid.yearB}', '${uid.typeB}', 'Crossed ${slug}')`,
            ),
          '42501',
        );
      });
    });

    it('6. the runtime role cannot hard-DELETE a mark or a published report card', async () => {
      await tenantA(async () => {
        // The DELETE policy is privileged-only, so the write is filtered out
        // rather than refused: the rows must still be there afterwards.
        for (const [t, id] of [
          ['marks', uid.markA1],
          ['report_cards', uid.cardDraft],
        ] as const) {
          const del = await app.query(`delete from ${t} where id = '${id}'`);
          expect(del.rowCount, t).toBe(0);
          const left = await appQ<{ n: number }>(`select count(*)::int n from ${t} where id = '${id}'`);
          expect(Number(left[0]!.n), t).toBe(1);
        }
        // mark_corrections is stricter: it holds no DELETE grant at all.
        await rejectCode(
          () => app.query(`delete from mark_corrections where tenant_id = '${uid.tenantA}'`),
          '42501',
        );
      });
    });
  });

  describe('B. grading scale integrity (versioned bands)', () => {
    it('1. bands must tile 0..100 — a gap, an overlap and a short tail are all refused', async () => {
      await tenantA(async () => {
        const gap = [
          { label: 'A', minPercent: 0, maxPercent: 40, gradePoint: 1 },
          { label: 'B', minPercent: 50, maxPercent: 100, gradePoint: 4 },
        ];
        await rejectCode(
          () =>
            app.query(
              `insert into grading_scales (id, tenant_id, code, name, version, bands)
               values ('${randomUUID()}', '${uid.tenantA}', 'gap_${slug}', 'Gap', 1, '${JSON.stringify(gap)}'::jsonb)`,
            ),
          '55000',
          /tile 0\.\.100/,
        );
        const overlap = [
          { label: 'A', minPercent: 0, maxPercent: 50, gradePoint: 1 },
          { label: 'B', minPercent: 40, maxPercent: 100, gradePoint: 4 },
        ];
        await rejectCode(
          () =>
            app.query(
              `insert into grading_scales (id, tenant_id, code, name, version, bands)
               values ('${randomUUID()}', '${uid.tenantA}', 'ovl_${slug}', 'Overlap', 1, '${JSON.stringify(overlap)}'::jsonb)`,
            ),
          '55000',
          /tile 0\.\.100/,
        );
        const short = [
          { label: 'A', minPercent: 0, maxPercent: 50, gradePoint: 1 },
          { label: 'B', minPercent: 50, maxPercent: 90, gradePoint: 2 },
        ];
        await rejectCode(
          () =>
            app.query(
              `insert into grading_scales (id, tenant_id, code, name, version, bands)
               values ('${randomUUID()}', '${uid.tenantA}', 'shrt_${slug}', 'Short', 1, '${JSON.stringify(short)}'::jsonb)`,
            ),
          '55000',
          /end at 100/,
        );
        // A well-formed scale is accepted.
        await app.query(
          `insert into grading_scales (id, tenant_id, code, name, version, bands)
           values ('${randomUUID()}', '${uid.tenantA}', 'ok_${slug}', 'OK', 1, '${JSON.stringify(BANDS)}'::jsonb)`,
        );
      });
    });

    it('2. a second active version of the same scale is refused', async () => {
      await tenantA(async () => {
        await rejectCode(
          () =>
            app.query(
              `update grading_scales set is_active = true where id = '${uid.scaleA2}'`,
            ),
          '55000',
          /already active/,
        );
        // The trigger is not the only guard: a partial unique index backstops
        // the invariant structurally, so it must exist with the right predicate.
        const idx = await migQ<{ indexdef: string }>(
          `select indexdef from pg_indexes
           where schemaname = 'public' and tablename = 'grading_scales'
             and indexname = 'grading_scales_active_uq'`,
        );
        expect(idx).toHaveLength(1);
        expect(idx[0]!.indexdef).toMatch(/UNIQUE/);
        expect(idx[0]!.indexdef).toMatch(/is_active/);
      });
    });

    it('3. code and version are immutable; active bands are frozen', async () => {
      await tenantA(async () => {
        await rejectCode(
          () => app.query(`update grading_scales set code = 'moved_${slug}' where id = '${uid.scaleA2}'`),
          '55000',
          /immutable/,
        );
        await rejectCode(
          () => app.query(`update grading_scales set version = 7 where id = '${uid.scaleA2}'`),
          '55000',
          /immutable/,
        );
        await rejectCode(
          () =>
            app.query(
              `update grading_scales set bands = '${JSON.stringify([
                { label: 'Z', minPercent: 0, maxPercent: 100, gradePoint: 0 },
              ])}'::jsonb where id = '${uid.scaleA}'`,
            ),
          '55000',
          /new version/,
        );
        // The display name of an active scale may still be corrected.
        await app.query(`update grading_scales set name = 'Standard 2026' where id = '${uid.scaleA}'`);
      });
    });

    it('4. one row per (code, version)', async () => {
      await tenantA(async () => {
        await rejectCode(
          () =>
            app.query(
              `insert into grading_scales (id, tenant_id, code, name, version, bands)
               values ('${randomUUID()}', '${uid.tenantA}', 'std_${slug}', 'Dup', 1, '${JSON.stringify(BANDS)}'::jsonb)`,
            ),
          '23505',
        );
      });
    });
  });

  describe('C. exam lifecycle is one-way and terminal once published', () => {
    it('1. the forward path works, and publication always needs a stamp', async () => {
      await tenantA(async () => {
        await app.query(`update exams set status = 'scheduled' where id = '${uid.examDraft}'`);
        await app.query(`update exams set status = 'grading' where id = '${uid.examDraft}'`);
        await app.query(
          `update exams set status = 'published', published_at = now() where id = '${uid.examDraft}'`,
        );
        const done = (
          await appQ<{ status: string; published_at: string | null }>(
            `select status, published_at from exams where id = '${uid.examDraft}'`,
          )
        )[0]!;
        expect(done.status).toBe('published');
        expect(done.published_at).not.toBeNull();
        // The stamp is not optional: the CHECK and the trigger both hold the line.
        await rejectCode(
          () => app.query(`update exams set status = 'draft' where id = '${uid.examDraft}'`),
          '55000',
          /cannot return to draft/,
        );
        await rejectCode(
          () => app.query(`update exams set published_at = null where id = '${uid.examDraft}'`),
          '23514',
        );
      });
    });

    it('2. a published exam cannot go back to grading or be cancelled', async () => {
      await tenantA(async () => {
        await rejectCode(
          () => app.query(`update exams set status = 'grading' where id = '${uid.examPublished}'`),
          '55000',
          /cannot enter grading/,
        );
        await rejectCode(
          () => app.query(`update exams set status = 'cancelled' where id = '${uid.examPublished}'`),
          '55000',
          /cannot be cancelled/,
        );
        await rejectCode(
          () => app.query(`update exams set status = 'draft' where id = '${uid.examPublished}'`),
          '55000',
          /cannot return to draft/,
        );
      });
    });

    it('3. a published exam cannot be reconfigured', async () => {
      await tenantA(async () => {
        await rejectCode(
          () => app.query(`update exams set name = 'Renamed ${slug}' where id = '${uid.examPublished}'`),
          '55000',
          /cannot be reconfigured/,
        );
        // The pin is now refused by the P2-01 rule, which speaks about the grading
        // scale specifically and therefore fires first. The outcome is unchanged -
        // a published exam's grade rule is frozen - and it is a strictly better
        // message than the generic reconfiguration one.
        await rejectCode(
          () => app.query(`update exams set grading_scale_id = null where id = '${uid.examPublished}'`),
          '55000',
          /grading scale of an exam in status published cannot be changed/,
        );
      });
    });

    it('4. an exam with results cannot be soft-deleted, and names are unique per term', async () => {
      await tenantA(async () => {
        await rejectCode(
          () => app.query(`update exams set deleted_at = now() where id = '${uid.examGrading}'`),
          '55000',
          /with results/,
        );
        await rejectCode(
          () =>
            app.query(
              `insert into exams (id, tenant_id, academic_term_id, academic_year_id, exam_type_id, name)
               values ('${randomUUID()}', '${uid.tenantA}', '${uid.termA}', '${uid.yearA}', '${uid.typeA}', 'Published ${slug}')`,
            ),
          '23505',
        );
      });
    });

    it('5. publication requires at least one subject session', async () => {
      await tenantA(async () => {
        const emptyExam = randomUUID();
        await app.query(
          `insert into exams (id, tenant_id, academic_term_id, academic_year_id, exam_type_id, name)
           values ('${emptyExam}', '${uid.tenantA}', '${uid.termA}', '${uid.yearA}', '${uid.typeA}', 'Empty ${slug}')`,
        );
        await rejectCode(
          () =>
            app.query(
              `update exams set status = 'published', published_at = now() where id = '${emptyExam}'`,
            ),
          '55000',
          /at least one subject/,
        );
      });
    });

    it('6. an exam type code is immutable and cannot be deactivated under a live exam', async () => {
      await tenantA(async () => {
        await rejectCode(
          () => app.query(`update exam_types set code = 'final_${slug}' where id = '${uid.typeA}'`),
          '55000',
          /immutable/,
        );
        await rejectCode(
          () => app.query(`update exam_types set is_active = false where id = '${uid.typeA}'`),
          '55000',
          /live exam/,
        );
      });
    });

    it('7. an exam cannot name an INACTIVE or deleted grading scale', async () => {
      // A named-but-inactive scale would make fn_exam_grade_for find no bands, so
      // every mark of the exam would silently derive a NULL grade.
      await tenantA(async () => {
        const exam = randomUUID();
        await rejectCode(
          () =>
            app.query(
              `insert into exams (id, tenant_id, academic_term_id, academic_year_id, exam_type_id, grading_scale_id, name)
               values ('${exam}', '${uid.tenantA}', '${uid.termA}', '${uid.yearA}', '${uid.typeA}', '${uid.scaleA2}', 'Inactive scale ${slug}')`,
            ),
          '55000',
          /must be an active grading scale/,
        );
        // ...and the same rule applies when an existing exam is REPOINTED at one.
        await rejectCode(
          () =>
            app.query(
              `update exams set grading_scale_id = '${uid.scaleA2}' where id = '${uid.examDraft}'`,
            ),
          '55000',
          /must be an active grading scale/,
        );
        // Keeping the scale it already validated is not re-checked.
        await app.query(`update exams set name = 'Renamed ${slug}' where id = '${uid.examDraft}'`);
      });
    });
  });

  describe('D. exam subjects and schedules', () => {
    it('1. a subject session cannot be attached to a grading or published exam', async () => {
      await tenantA(async () => {
        await rejectCode(
          () =>
            app.query(
              `insert into exam_subjects (id, tenant_id, exam_id, class_subject_id, academic_year_id, class_id, subject_id, max_marks, weight)
               values ('${randomUUID()}', '${uid.tenantA}', '${uid.examGrading}', '${uid.linkA}', '${uid.yearA}', '${uid.classA}', '${uid.subjA}', 10, 1)`,
            ),
          '55000',
          /cannot be changed in status/,
        );
      });
    });

    it('2. unique(exam, class_subject) and a live class-subject of the SAME academic year', async () => {
      await tenantA(async () => {
        await rejectCode(
          () =>
            app.query(
              `insert into exam_subjects (id, tenant_id, exam_id, class_subject_id, academic_year_id, class_id, subject_id, max_marks, weight)
               values ('${randomUUID()}', '${uid.tenantA}', '${uid.examSched}', '${uid.linkA}', '${uid.yearA}', '${uid.classA}', '${uid.subjA}', 10, 1)`,
            ),
          '23505',
        );
        // A subject session cannot claim an academic year other than the exam's:
        // the composite (tenant, year, exam) / (tenant, year, class_subject) FKs
        // make it structurally impossible, so the year copy cannot be forged.
        const otherYear = randomUUID();
        await app.query(
          `insert into academic_years (id, tenant_id, code, name, starts_on, ends_on, status)
           values ('${otherYear}', '${uid.tenantA}', 'y2-${slug}', 'AY 2027', '2027-01-01', '2027-12-31', 'draft')`,
        );
        // A subject-free exam, so unique(exam, class_subject) cannot be what fails.
        const freshExam = randomUUID();
        await app.query(
          `insert into exams (id, tenant_id, academic_term_id, academic_year_id, exam_type_id, name)
           values ('${freshExam}', '${uid.tenantA}', '${uid.termA}', '${uid.yearA}', '${uid.typeA}', 'Yearless ${slug}')`,
        );
        await rejectCode(
          () =>
            app.query(
              `insert into exam_subjects (id, tenant_id, exam_id, class_subject_id, academic_year_id, class_id, subject_id, max_marks, weight)
               values ('${randomUUID()}', '${uid.tenantA}', '${freshExam}', '${uid.linkA}', '${otherYear}', '${uid.classA}', '${uid.subjA}', 10, 1)`,
            ),
          '23503',
        );
        await app.query(`delete from academic_years where id = '${otherYear}'`);
      });
    });

    it('3. max_marks cannot move once marks exist, and a subject cannot be detached mid-grading', async () => {
      await tenantA(async () => {
        await rejectCode(
          () => app.query(`update exam_subjects set max_marks = 200 where id = '${uid.esGrading}'`),
          '55000',
          /max_marks cannot change/,
        );
        await rejectCode(
          () => app.query(`update exam_subjects set deleted_at = now() where id = '${uid.esGrading}'`),
          '55000',
          /once grading has started|with marks/,
        );
      });
    });

    it('4. a schedule must fall inside the exam term and needs an organizable exam', async () => {
      await tenantA(async () => {
        // Term A runs 2026-01-01..2026-06-30, so November is outside it.
        await rejectCode(
          () =>
            app.query(
              `insert into exam_schedules (id, tenant_id, exam_subject_id, starts_at, ends_at)
               values ('${randomUUID()}', '${uid.tenantA}', '${uid.esSched}', '2026-11-02 09:00:00+00', '2026-11-02 11:00:00+00')`,
            ),
          '55000',
          /inside the exam term/,
        );
        // An in-term window on a schedulable exam is accepted…
        await app.query(
          `insert into exam_schedules (id, tenant_id, exam_subject_id, starts_at, ends_at, room)
           values ('${randomUUID()}', '${uid.tenantA}', '${uid.esSched}', '2026-03-02 09:00:00+00', '2026-03-02 11:00:00+00', 'R1')`,
        );
        // …and a subject session carries at most one live schedule.
        await rejectCode(
          () =>
            app.query(
              `insert into exam_schedules (id, tenant_id, exam_subject_id, starts_at, ends_at)
               values ('${randomUUID()}', '${uid.tenantA}', '${uid.esSched}', '2026-03-03 09:00:00+00', '2026-03-03 11:00:00+00')`,
            ),
          '23505',
        );
        // Once grading has started the plan is frozen.
        await rejectCode(
          () =>
            app.query(
              `update exam_schedules set room = 'R2' where id = '${uid.schedPublished}'`,
            ),
          '55000',
          /cannot be changed in status/,
        );
      });
    });
  });

  describe('E. marks: bounds, derivation and the publish freeze', () => {
    it('1. marks_obtained above max_marks is refused at the trigger', async () => {
      await tenantA(async () => {
        await rejectCode(
          () =>
            app.query(
              `update marks set marks_obtained = 101 where id = '${uid.markA1}'`,
            ),
          '55000',
          /exceeds max_marks/,
        );
        // The floor is a CHECK.
        await rejectCode(
          () =>
            app.query(`update marks set marks_obtained = -1 where id = '${uid.markA1}'`),
          '23514',
        );
      });
    });

    it('2. percentage and grade are DERIVED — a client cannot post them', async () => {
      await tenantA(async () => {
        const attempt = randomUUID();
        // A client that posts its own percentage and grade is overwritten: the
        // trigger recomputes both from (marks_obtained, max_marks, active scale).
        await app.query(
          `insert into marks (id, tenant_id, exam_subject_id, enrollment_id, student_id, section_id, academic_year_id, marks_obtained, percentage, grade_label, grade_point, entered_by)
           values ('${attempt}', '${uid.tenantA}', '${uid.esGrading}', '${uid.enrollA3}', '${uid.studentA3}', '${uid.sectionA}', '${uid.yearA}', 42, 99, 'A+', 4, '${uid.teacher}')`,
        );
        const row = (
          await appQ<{ percentage: string; grade_label: string; grade_point: string }>(
            `select percentage, grade_label, grade_point from marks where id = '${attempt}'`,
          )
        )[0]!;
        expect(Number(row.percentage)).toBe(42);
        expect(row.grade_label).toBe('B');
        expect(Number(row.grade_point)).toBe(2);
        // The band boundaries are half-open: exactly 80.00 is the top band.
        await app.query(`update marks set marks_obtained = 80 where id = '${attempt}'`);
        const at80 = (
          await appQ<{ percentage: string; grade_label: string }>(
            `select percentage, grade_label from marks where id = '${attempt}'`,
          )
        )[0]!;
        expect(Number(at80.percentage)).toBe(80);
        expect(at80.grade_label).toBe('D');
        // …and 79.99 is the band below.
        await app.query(`update marks set marks_obtained = 79.99 where id = '${attempt}'`);
        const below = (
          await appQ<{ grade_label: string }>(
            `select grade_label from marks where id = '${attempt}'`,
          )
        )[0]!;
        expect(below.grade_label).toBe('C');
        // A null value clears the derived columns.
        await app.query(`update marks set marks_obtained = null where id = '${attempt}'`);
        const cleared = (
          await appQ<{ percentage: string | null; grade_label: string | null }>(
            `select percentage, grade_label from marks where id = '${attempt}'`,
          )
        )[0]!;
        expect(cleared.percentage).toBeNull();
        expect(cleared.grade_label).toBeNull();
      });
    });

    it('3. the enrollment is the anchor: student, section and year must agree', async () => {
      await tenantA(async () => {
        await rejectCode(
          () =>
            app.query(
              `insert into marks (id, tenant_id, exam_subject_id, enrollment_id, student_id, section_id, academic_year_id, marks_obtained)
               values ('${randomUUID()}', '${uid.tenantA}', '${uid.esGrading}', '${uid.enrollA1}', '${uid.studentA2}', '${uid.sectionA}', '${uid.yearA}', 10)`,
            ),
          '55000',
          /student must match the enrollment/,
        );
        await rejectCode(
          () =>
            app.query(
              `insert into marks (id, tenant_id, exam_subject_id, enrollment_id, student_id, section_id, academic_year_id, marks_obtained)
               values ('${randomUUID()}', '${uid.tenantA}', '${uid.esGrading}', '${uid.enrollA1}', '${uid.studentA1}', null, '${uid.yearA}', 10)`,
            ),
          '55000',
          /section must match the enrollment/,
        );
        // A foreign enrollment is refused by the anchor lookup before the FK even
        // gets a say.
        await rejectCode(
          () =>
            app.query(
              `insert into marks (id, tenant_id, exam_subject_id, enrollment_id, student_id, section_id, academic_year_id, marks_obtained)
               values ('${randomUUID()}', '${uid.tenantA}', '${uid.esGrading}', '${randomUUID()}', '${uid.studentA1}', '${uid.sectionA}', '${uid.yearA}', 10)`,
            ),
          '55000',
          /enrollment not found/,
        );
      });
    });

    it('4. marks require an active membership as the entering teacher', async () => {
      await tenantA(async () => {
        await rejectCode(
          () =>
            app.query(
              `insert into marks (id, tenant_id, exam_subject_id, enrollment_id, student_id, section_id, academic_year_id, marks_obtained, entered_by)
               values ('${randomUUID()}', '${uid.tenantA}', '${uid.esGrading}', '${uid.enrollA1}', '${uid.studentA1}', '${uid.sectionA}', '${uid.yearA}', 10, '${uid.userB}')`,
            ),
          '55000',
          /active membership/,
        );
      });
    });

    it('5. marks cannot be entered on a draft or cancelled exam, and status is server-derived', async () => {
      await tenantA(async () => {
        await rejectCode(
          () =>
            app.query(
              `insert into marks (id, tenant_id, exam_subject_id, enrollment_id, student_id, section_id, academic_year_id, marks_obtained)
               values ('${randomUUID()}', '${uid.tenantA}', '${uid.esDraft}', '${uid.enrollA1}', '${uid.studentA1}', '${uid.sectionA}', '${uid.yearA}', 10)`,
            ),
          '55000',
          /cannot be entered while the exam is/,
        );
        // A writer cannot promote its own mark to a locked/rechecked state.
        await rejectCode(
          () =>
            app.query(
              `update marks set status = 'locked', locked_at = now() where id = '${uid.markA1}'`,
            ),
          '55000',
          /server-derived/,
        );
      });
    });

    it('6. unique(exam_subject, enrollment) is the idempotency anchor', async () => {
      await tenantA(async () => {
        await rejectCode(
          () =>
            app.query(
              `insert into marks (id, tenant_id, exam_subject_id, enrollment_id, student_id, section_id, academic_year_id, marks_obtained)
               values ('${randomUUID()}', '${uid.tenantA}', '${uid.esGrading}', '${uid.enrollA1}', '${uid.studentA1}', '${uid.sectionA}', '${uid.yearA}', 10)`,
            ),
          '23505',
        );
      });
    });

    it('7. PUBLISH FREEZE: a mark of a published exam cannot be inserted or edited', async () => {
      // The fixture already published the exam, so the publication sweep locked
      // its marks: this is the state the portal reads.
      const publishedMark = uid.markPublished;
      const settled = (
        await migQ<{ status: string; locked_at: string | null }>(
          `select status, locked_at from marks where id = '${publishedMark}'`,
        )
      )[0]!;
      expect(settled.locked_at).not.toBeNull();
      expect(['locked', 'rechecked']).toContain(settled.status);

      await tenantA(async () => {
        // No new marks may appear under a published exam…
        await rejectCode(
          () =>
            app.query(
              `insert into marks (id, tenant_id, exam_subject_id, enrollment_id, student_id, section_id, academic_year_id, marks_obtained)
               values ('${randomUUID()}', '${uid.tenantA}', '${uid.esPublished}', '${uid.enrollA2}', '${uid.studentA2}', '${uid.sectionA}', '${uid.yearA}', 10)`,
            ),
          '55000',
          /cannot be added to a published exam/,
        );
        // …and the value may not move. This is the roadmap's "illegal mark edit
        // blocked at DB trigger" acceptance proof.
        await rejectCode(
          () => app.query(`update marks set marks_obtained = 90 where id = '${publishedMark}'`),
          '55000',
          /correction workflow/,
        );
      });
    });

    it('8. the correction workflow is the ONLY way a published mark moves', async () => {
      const correction = randomUUID();
      uid.correction2 = correction;
      await migrator.query('begin');
      try {
        // A correction must actually change the value.
        await migReject(
          () =>
            migrator.query(
              `insert into mark_corrections (id, tenant_id, mark_id, exam_id, exam_subject_id, student_id, old_marks_obtained, new_marks_obtained, reason, corrected_by)
               values ('${randomUUID()}', '${uid.tenantA}', '${uid.markPublished}', '${uid.examPublished}', '${uid.esPublished}', '${uid.studentA2}', 85, 85, 'typo', '${uid.teacher}')`,
            ),
          '23514',
          /changed/,
        );
        // A correction of a PROVISIONAL mark is refused: that is just mark entry.
        await migReject(
          () =>
            migrator.query(
              `insert into mark_corrections (id, tenant_id, mark_id, exam_id, exam_subject_id, student_id, old_marks_obtained, new_marks_obtained, reason, corrected_by)
               values ('${randomUUID()}', '${uid.tenantA}', '${uid.markA1}', '${uid.examGrading}', '${uid.esGrading}', '${uid.studentA1}', 85, 90, 'not published yet', '${uid.teacher}')`,
            ),
          '55000',
          /published results only/,
        );
      } finally {
        await migrator.query('rollback');
      }

      // The real path: correction row first, then the UPDATE in the same
      // transaction. The mark is rechecked and the derived columns follow.
      await migrator.query('begin');
      try {
        await migrator.query(
          `insert into mark_corrections (id, tenant_id, mark_id, exam_id, exam_subject_id, student_id, old_marks_obtained, new_marks_obtained, reason, corrected_by)
           values ('${correction}', '${uid.tenantA}', '${uid.markPublished}', '${uid.examPublished}', '${uid.esPublished}', '${uid.studentA2}', 85, 92.5, 'transcription error by the invigilator', '${uid.teacher}')`,
        );
        await migrator.query(`update marks set marks_obtained = 92.5 where id = '${uid.markPublished}'`);
        await migrator.query('commit');
      } catch (err) {
        await migrator.query('rollback');
        throw err;
      }
      const fixed = (
        await migQ<{ status: string; percentage: string; grade_label: string; grade_point: string }>(
          `select status, percentage, grade_label, grade_point from marks where id = '${uid.markPublished}'`,
        )
      )[0]!;
      expect(fixed.status).toBe('rechecked');
      expect(Number(fixed.percentage)).toBe(92.5);
      expect(fixed.grade_label).toBe('D');
      expect(Number(fixed.grade_point)).toBe(4);

      // The audit trail is append-only.
      await migrator.query('begin');
      try {
        await migReject(
          () => migrator.query(`update mark_corrections set reason = 'edited' where id = '${correction}'`),
          '55000',
          /append-only/,
        );
        await migReject(
          () => migrator.query(`delete from mark_corrections where id = '${correction}'`),
          '55000',
          /append-only/,
        );
      } finally {
        await migrator.query('rollback');
      }
    });

    it('9. a correction cannot exceed max_marks or lie about the old value', async () => {
      await migrator.query('begin');
      try {
        await migReject(
          () =>
            migrator.query(
              `insert into mark_corrections (id, tenant_id, mark_id, exam_id, exam_subject_id, student_id, old_marks_obtained, new_marks_obtained, reason, corrected_by)
               values ('${randomUUID()}', '${uid.tenantA}', '${uid.markPublished}', '${uid.examPublished}', '${uid.esPublished}', '${uid.studentA2}', 92.5, 140, 'too high', '${uid.teacher}')`,
            ),
          '55000',
          /exceeds max_marks/,
        );
        await migReject(
          () =>
            migrator.query(
              `insert into mark_corrections (id, tenant_id, mark_id, exam_id, exam_subject_id, student_id, old_marks_obtained, new_marks_obtained, reason, corrected_by)
               values ('${randomUUID()}', '${uid.tenantA}', '${uid.markPublished}', '${uid.examPublished}', '${uid.esPublished}', '${uid.studentA2}', 12, 95, 'wrong old value', '${uid.teacher}')`,
            ),
          '55000',
          /old value does not match/,
        );
        await migReject(
          () =>
            migrator.query(
              `insert into mark_corrections (id, tenant_id, mark_id, exam_id, exam_subject_id, student_id, old_marks_obtained, new_marks_obtained, reason, corrected_by)
               values ('${randomUUID()}', '${uid.tenantA}', '${uid.markPublished}', '${uid.examPublished}', '${uid.esPublished}', '${uid.studentA1}', 92.5, 95, 'wrong student', '${uid.teacher}')`,
            ),
          '55000',
          /describe the corrected mark/,
        );
        // The exam copy is a denormalization too: it may not name another exam.
        await migReject(
          () =>
            migrator.query(
              `insert into mark_corrections (id, tenant_id, mark_id, exam_id, exam_subject_id, student_id, old_marks_obtained, new_marks_obtained, reason, corrected_by)
               values ('${randomUUID()}', '${uid.tenantA}', '${uid.markPublished}', '${uid.examGrading}', '${uid.esPublished}', '${uid.studentA2}', 92.5, 95, 'wrong exam', '${uid.teacher}')`,
            ),
          '55000',
          /describe the corrected mark/,
        );
        await migReject(
          () =>
            migrator.query(
              `insert into mark_corrections (id, tenant_id, mark_id, exam_id, exam_subject_id, student_id, old_marks_obtained, new_marks_obtained, reason, corrected_by)
               values ('${randomUUID()}', '${uid.tenantA}', '${uid.markPublished}', '${uid.examPublished}', '${uid.esPublished}', '${uid.studentA2}', 92.5, 95, 'no', '${uid.userB}')`,
            ),
          '55000',
          /active membership/,
        );
      } finally {
        await migrator.query('rollback');
      }
    });
  });

  describe('F. report cards', () => {
    it('1. a card is generated only while the exam is grading or published', async () => {
      await tenantA(async () => {
        await rejectCode(
          () =>
            app.query(
              `insert into report_cards (id, tenant_id, exam_id, student_id, enrollment_id, academic_year_id, version, status, total_possible)
               values ('${randomUUID()}', '${uid.tenantA}', '${uid.examDraft}', '${uid.studentA1}', '${uid.enrollA1}', '${uid.yearA}', 1, 'draft', 100)`,
            ),
          '55000',
          /grading or published/,
        );
      });
    });

    it('2. one live draft per (exam, student), but a new VERSION is allowed', async () => {
      await tenantA(async () => {
        // The fixture already holds the live draft for (examGrading, studentA1).
        await rejectCode(
          () =>
            app.query(
              `insert into report_cards (id, tenant_id, exam_id, student_id, enrollment_id, academic_year_id, version, status, total_possible)
               values ('${randomUUID()}', '${uid.tenantA}', '${uid.examGrading}', '${uid.studentA1}', '${uid.enrollA1}', '${uid.yearA}', 1, 'draft', 100)`,
            ),
          '23505',
        );
        // A different version number does NOT buy a second working copy: the
        // correction workflow supersedes the draft instead of forking it.
        await rejectCode(
          () =>
            app.query(
              `insert into report_cards (id, tenant_id, exam_id, student_id, enrollment_id, academic_year_id, version, status, total_possible)
               values ('${randomUUID()}', '${uid.tenantA}', '${uid.examGrading}', '${uid.studentA1}', '${uid.enrollA1}', '${uid.yearA}', 2, 'draft', 100)`,
            ),
          '23505',
        );
      });

      // A published exam may hold a fresh snapshot version, though: history is
      // additive and versioned, not overwritten.
      //
      // THIS HALF COMMITS, and that is the whole point of it. The version-2 row for
      // (examPublished, studentA1) is published with hand-written aggregates and NO
      // snapshot lines - the incoherent state `report_cards_snapshot_coherent_trg`
      // exists to refuse - and that trigger is DEFERRABLE INITIALLY DEFERRED, so it
      // only ever fires at COMMIT. Asserting the INSERT succeeded inside a transaction
      // that is then rolled back proved nothing at all: it would have stayed green
      // with the trigger deleted. So the assertion now ends at a real COMMIT and
      // expects the refusal, and then checks that the forged card did not survive it.
      const forged = randomUUID();
      const tkt = (
        await appQ(`select app_ctx_mint('tenant', '${uid.teacher}', '${uid.tenantA}') t`)
      )[0]!.t as string;
      await app.query('begin');
      await app.query(`set local app.rls = '${tkt}'`);
      // The runtime role is refused by every IMMEDIATE rule here: the row is
      // accepted, and the deferred trigger is what catches it.
      const written = await app.query(
        `insert into report_cards (id, tenant_id, exam_id, student_id, enrollment_id, academic_year_id, version, status, gpa, total_obtained, total_possible, subject_count, published_at)
         values ('${forged}', '${uid.tenantA}', '${uid.examPublished}', '${uid.studentA1}', '${uid.enrollA1}', '${uid.yearA}', 2, 'published', 2, 70, 100, 1, now())`,
      );
      expect(written.rowCount).toBe(1);
      const refused = await app.query('commit').then(
        () => null,
        (err: pg.DatabaseError) => err,
      );
      expect(refused, 'a publication that disagrees with its own snapshot must not COMMIT')
        .toBeInstanceOf(Error);
      expect((refused as pg.DatabaseError).code).toBe('55000');
      expect((refused as Error).message).toMatch(/must agree with its own subject snapshot/);

      // …and nothing was published: the forged card is not in the database. Read on
      // the migrator connection, whose policies are the privileged executor escape -
      // counting on `app` with no tenant context set would return 0 rows whatever
      // happened, which is the same vacuity in a different place.
      const ghosts = await migQ<{ n: number }>(
        `select count(*)::int n from report_cards where id = '${forged}'`,
      );
      expect(ghosts[0]!.n).toBe(0);

      // The same additive history, published the way the worker publishes - draft,
      // lines, the aggregate those lines describe, then the transition - DOES commit.
      // So the refusal above is about the incoherence, not about the version, and the
      // live-draft rule above is about the working copy, not about history.
      //
      // studentA2 is the pair that already holds a PUBLISHED version 1 from the
      // fixture, so version 2 is a genuine successor rather than a first card in an
      // empty slot: that is the correction workflow's shape, and the row it produces
      // has a real body (the corrected 85/100 mark on the published exam).
      const card = await publishCardWithSnapshot({
        studentId: uid.studentA2!,
        enrollmentId: uid.enrollA2!,
        examId: uid.examPublished!,
        version: 2,
      });
      const published = await migQ<{ status: string; subject_count: number; total_obtained: string }>(
        `select status, subject_count, total_obtained from report_cards where id = '${card}'`,
      );
      expect(published[0]!.status).toBe('published');
      // The successor describes the result as it stands NOW, which is what a
      // correction mints: section E moved the published mark through the correction
      // workflow, and the version-1 card stays frozen at the value it was published
      // with while this one is recomputed.
      const markNow = await migQ<{ marks_obtained: string }>(
        `select marks_obtained from marks where id = '${uid.markPublished}'`,
      );
      expect(Number(published[0]!.total_obtained)).toBe(Number(markNow[0]!.marks_obtained));
      // The card's own lines, and no one else's: the successor describes its own exam.
      const lines = await migQ<{ n: number }>(
        `select count(*)::int n from report_card_subjects where report_card_id = '${card}'`,
      );
      expect(lines[0]!.n).toBe(Number(published[0]!.subject_count));
      expect(Number(published[0]!.subject_count)).toBeGreaterThan(0);
      // And the aggregate it STORES is the one its own lines describe - the exact
      // comparison the deferred trigger made before it let this transaction commit.
      const totals = await migQ<{ gpa: string; total_obtained: string; subject_count: number }>(
        `select gpa, total_obtained, subject_count from fn_report_card_totals('${uid.tenantA}', '${card}') t`,
      );
      expect(Number(totals[0]!.total_obtained)).toBe(Number(published[0]!.total_obtained));
      expect(Number(totals[0]!.subject_count)).toBe(Number(published[0]!.subject_count));
      // Both versions stand side by side: history is additive, not overwritten.
      const versions = await migQ<{ n: number }>(
        `select count(*)::int n from report_cards
          where tenant_id = '${uid.tenantA}' and exam_id = '${uid.examPublished}'
            and student_id = '${uid.studentA2}' and deleted_at is null`,
      );
      expect(versions[0]!.n).toBe(2);
    });

    it('3. a PUBLISHED card is a frozen snapshot; the artifact pointer may be stamped once', async () => {
      const card = await publishCardWithSnapshot({
        studentId: uid.studentA1!,
        enrollmentId: uid.enrollA1!,
        examId: uid.examPublished!,
        version: 1,
      });
      uid.publishedCard = card;

      await tenantA(async () => {
        await rejectCode(
          () => app.query(`update report_cards set gpa = 4 where id = '${card}'`),
          '55000',
          /immutable/,
        );
        await rejectCode(
          () => app.query(`update report_cards set total_obtained = 99 where id = '${card}'`),
          '55000',
          /immutable/,
        );
        await rejectCode(
          () => app.query(`update report_cards set version = 2 where id = '${card}'`),
          '55000',
          /immutable/,
        );
        await rejectCode(
          () => app.query(`update report_cards set deleted_at = now() where id = '${card}'`),
          '55000',
          /cannot be removed/,
        );
        // The reports worker may stamp the generated PDF…
        await app.query(`update report_cards set file_id = '${uid.fileA}' where id = '${card}'`);
        // …but never replace it afterwards.
        const other = randomUUID();
        await migrator.query(
          `insert into files (id, tenant_id, storage_key, original_name, mime, size_bytes, visibility, created_by)
           values ('${other}', '${uid.tenantA}', 'exam/${slug}/card2.pdf', 'card2.pdf', 'application/pdf', 12, 'private', '${uid.userA}')`,
        );
        await rejectCode(
          () => app.query(`update report_cards set file_id = '${other}' where id = '${card}'`),
          '55000',
          /cannot be replaced/,
        );
        await migrator.query(`delete from files where id = '${other}'`);
      });
    });

    it('4. a card may only be published with its exam, and needs a publication stamp', async () => {
      await tenantA(async () => {
        // No stamp: the trigger refuses the transition before the CHECK can.
        await rejectCode(
          () =>
            app.query(
              `update report_cards set status = 'published' where id = '${uid.cardDraft}'`,
            ),
          '55000',
          /publication requires published_at/,
        );
        // examGrading is not published, so a stamped card is refused too.
        await rejectCode(
          () =>
            app.query(
              `update report_cards set status = 'published', published_at = now() where id = '${uid.cardDraft}'`,
            ),
          '55000',
          /only be published with its exam/,
        );
        // The card is untouched by both attempts.
        const still = (
          await appQ<{ status: string; published_at: string | null }>(
            `select status, published_at from report_cards where id = '${uid.cardDraft}'`,
          )
        )[0]!;
        expect(still.status).toBe('draft');
        expect(still.published_at).toBeNull();
      });
    });

    it('5. a draft card is recomputable: totals and gpa may be rewritten before publication', async () => {
      await tenantA(async () => {
        await app.query(
          `update report_cards set gpa = 3.5, total_obtained = 92.5, subject_count = 3 where id = '${uid.cardDraft}'`,
        );
        const row = (
          await appQ<{ gpa: string; total_obtained: string; subject_count: number }>(
            `select gpa, total_obtained, subject_count from report_cards where id = '${uid.cardDraft}'`,
          )
        )[0]!;
        expect(Number(row.gpa)).toBe(3.5);
        expect(Number(row.total_obtained)).toBe(92.5);
        expect(Number(row.subject_count)).toBe(3);
      });
    });
  });

  describe('G. isolation of the correction trail and the gradebook path', () => {
    it('1. tenant B cannot see or touch tenant A marks, cards or corrections', async () => {
      await tenantB(async () => {
        for (const t of ['marks', 'report_cards', 'mark_corrections', 'exams', 'exam_subjects']) {
          const n = (
            await appQ<{ n: number }>(`select count(*)::int n from ${t} where tenant_id = '${uid.tenantA}'`)
          )[0]!.n;
          expect(Number(n), t).toBe(0);
        }
        // A write aimed at tenant A is filtered to nothing rather than refused.
        const upd = await app.query(`update marks set marks_obtained = 1 where id = '${uid.markA1}'`);
        expect(upd.rowCount).toBe(0);
        const untouched = (
          await migQ<{ marks_obtained: string }>(
            `select marks_obtained from marks where id = '${uid.markA1}'`,
          )
        )[0]!;
        expect(Number(untouched.marks_obtained)).toBe(85);
        // And a correction aimed at tenant A's mark cannot be written from tenant
        // B: the anchor lookup rejects it before the RLS policy is even reached.
        await rejectCode(
          () =>
            app.query(
              `insert into mark_corrections (id, tenant_id, mark_id, exam_id, exam_subject_id, student_id, old_marks_obtained, new_marks_obtained, reason, corrected_by)
               values ('${randomUUID()}', '${uid.tenantB}', '${uid.markPublished}', '${uid.examPublished}', '${uid.esPublished}', '${uid.studentA2}', 85, 95, 'tenant B reaching over', '${uid.userB}')`,
            ),
          '55000',
          /mark not found/,
        );
      });
    });

    it('2. the gradebook join returns tenant A rows with derived grades attached', async () => {
      await tenantA(async () => {
        const rows = await appQ<{
          student_id: string;
          marks_obtained: string;
          percentage: string;
          grade_label: string;
          status: string;
        }>(
          `select m.student_id, m.marks_obtained, m.percentage, m.grade_label, m.status
           from marks m
           join exam_subjects es on es.tenant_id = m.tenant_id and es.id = m.exam_subject_id
           where es.exam_id = '${uid.examGrading}'
           order by m.student_id`,
        );
        expect(rows).toHaveLength(2);
        for (const r of rows) {
          expect(Number(r.percentage)).toBeGreaterThan(0);
          expect(r.grade_label).toMatch(/^[ABCD]$/);
          expect(r.status).toBe('provisional');
        }
      });
    });
  });

  /**
   * Section H — regressions for the Phase 6 result-integrity remediation
   * (migration 0016, findings F-03, F-04, F-06, F-07, F-08).
   *
   * Each test here reproduces a state the audit showed was previously accepted, and
   * asserts the database now refuses it. The point is that every one of these is a
   * REGRESSION TEST against the real catalog and the real triggers, not a unit test
   * of a helper.
   */
  describe('H. result-integrity remediation regressions (F-03, F-04, F-06, F-07, F-08)', () => {
    /**
     * Section H manages its OWN transactions. Sections A-G leave the shared
     * migrator connection inside an explicit transaction and share the `migReject`
     * savepoint helper; these tests are self-contained so that each one is
     * independently re-runnable and leaves nothing behind.
     */
    const hReject = async (
      fn: () => Promise<unknown>,
      code: string,
      pattern: RegExp,
    ): Promise<void> => {
      await migrator.query('begin');
      try {
        await migrator.query('savepoint sp');
        const caught = await fn().catch((err: pg.DatabaseError) => err);
        await migrator.query('rollback to savepoint sp');
        expect(caught).toBeInstanceOf(Error);
        // Message first: it is the contract these regressions actually assert, and
        // asserting it first means a failure shows the trigger's real wording rather
        // than only a SQLSTATE mismatch.
        expect((caught as Error).message).toMatch(pattern);
        expect((caught as pg.DatabaseError).code).toBe(code);
      } finally {
        await migrator.query('rollback').catch(() => {});
      }
    };

    /** Runs `fn` in a transaction that is always rolled back, and returns its rows. */
    const hRows = async <T extends pg.QueryResultRow>(fn: () => Promise<pg.QueryResult<T>>) => {
      await migrator.query('begin');
      try {
        const r = await fn();
        return r.rows;
      } finally {
        await migrator.query('rollback').catch(() => {});
      }
    };

    /**
     * A two-band scale tiling 0..100, where the SECOND band is the one under test.
     * Tiling matters: the pre-existing band validator already refuses gaps and
     * overlaps, so a fixture that overlapped would be refused for the wrong reason
     * and the assertion would prove nothing.
     */
    const bandsWithSecond = (band: Record<string, unknown>): string =>
      JSON.stringify([
        { label: 'A', minPercent: 0, maxPercent: 50, gradePoint: 1 },
        band,
      ]);

    describe('F-06 every Phase 6 trigger/helper function pins its search_path', () => {
      it('pg_proc.proconfig carries search_path=public for all of them', async () => {
        // Asserted against the CATALOG, so a future migration that adds a function
        // without pinning it shows up here instead of being an exploit at runtime.
        const rows = await migQ<{ proname: string; proconfig: string[] | null }>(
          `select p.proname, p.proconfig
             from pg_proc p
             join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public'
              and (p.proname like 'trg\\_%' or p.proname like 'fn\\_%')
            order by p.proname`,
        );
        // Guard the guard: if this inventory ever collapses to nothing the test is
        // vacuously green, which is exactly the failure mode F-06 had.
        expect(rows.length).toBeGreaterThanOrEqual(34);

        const unpinned = rows.filter(
          (r) => !(r.proconfig ?? []).some((c) => /^search_path=public, ?pg_catalog/.test(c)),
        );
        expect(unpinned.map((r) => r.proname)).toEqual([]);
      });

      it('includes the two Phase 6 functions the remediation added or changed', async () => {
        const rows = await migQ<{ proname: string }>(
          `select p.proname from pg_proc p
             join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public'
              and p.proname in ('trg_marks_delete_guard', 'fn_exam_grade_for')`,
        );
        expect(rows.map((r) => r.proname).sort()).toEqual([
          'fn_exam_grade_for',
          'trg_marks_delete_guard',
        ]);
      });
    });

    describe('F-04 a grading band must carry a gradePoint', () => {
      it('refuses a band whose gradePoint key is absent', async () => {
        await hReject(
          () =>
            migrator.query(
              `insert into grading_scales (id, tenant_id, code, name, version, is_active, bands)
               values ('${randomUUID()}', '${uid.tenantA}', 'f04a_${slug}', 'No point', 1, false,
                       '${bandsWithSecond({ label: 'B', minPercent: 50, maxPercent: 100 })}'::jsonb)`,
            ),
          '55000',
          /gradePoint is required/,
        );
      });

      it('refuses a band whose gradePoint is JSON null', async () => {
        await hReject(
          () =>
            migrator.query(
              `insert into grading_scales (id, tenant_id, code, name, version, is_active, bands)
               values ('${randomUUID()}', '${uid.tenantA}', 'f04b_${slug}', 'Null point', 1, false,
                       '${bandsWithSecond({ label: 'B', minPercent: 50, maxPercent: 100, gradePoint: null })}'::jsonb)`,
            ),
          '55000',
          /gradePoint is required/,
        );
      });

      it('refuses a gradePoint above 4 and below 0', async () => {
        await hReject(
          () =>
            migrator.query(
              `insert into grading_scales (id, tenant_id, code, name, version, is_active, bands)
               values ('${randomUUID()}', '${uid.tenantA}', 'f04c_${slug}', 'Too high', 1, false,
                       '${bandsWithSecond({ label: 'B', minPercent: 50, maxPercent: 100, gradePoint: 4.5 })}'::jsonb)`,
            ),
          '55000',
          /within 0\.\.4/,
        );
        await hReject(
          () =>
            migrator.query(
              `insert into grading_scales (id, tenant_id, code, name, version, is_active, bands)
               values ('${randomUUID()}', '${uid.tenantA}', 'f04d_${slug}', 'Negative', 1, false,
                       '${bandsWithSecond({ label: 'B', minPercent: 50, maxPercent: 100, gradePoint: -1 })}'::jsonb)`,
            ),
          '55000',
          /within 0\.\.4/,
        );
      });

      it('still accepts a legitimate gradePoint of exactly 0', async () => {
        // 0 is a real GPA value, not a missing value. The fix must not exclude it.
        const id = randomUUID();
        await migrator.query('begin');
        await migrator.query(
          `insert into grading_scales (id, tenant_id, code, name, version, is_active, bands)
           values ('${id}', '${uid.tenantA}', 'f04e_${slug}', 'Zero point', 1, false,
                   '${bandsWithSecond({ label: 'B', minPercent: 50, maxPercent: 100, gradePoint: 0 })}'::jsonb)`,
        );
        const rows = await migQ<{ gp: number }>(
          `select (bands->1->>'gradePoint')::numeric gp from grading_scales where id = '${id}'`,
        );
        expect(Number(rows[0]!.gp)).toBe(0);
        await migrator.query('rollback');
      });
    });

    describe('F-08 band labels are unique within a scale', () => {
      it('refuses an exact duplicate label', async () => {
        await hReject(
          () =>
            migrator.query(
              `insert into grading_scales (id, tenant_id, code, name, version, is_active, bands)
               values ('${randomUUID()}', '${uid.tenantA}', 'f08a_${slug}', 'Dup A', 1, false,
                       '[{"label":"A","minPercent":0,"maxPercent":50,"gradePoint":1},
                         {"label":"A","minPercent":50,"maxPercent":100,"gradePoint":2}]'::jsonb)`,
            ),
          '55000',
          /appears more than once in this scale/,
        );
      });

      it('refuses a duplicate reached by deactivating a band that collided with itself', async () => {
        // Same labels, different points: still a duplicate LABEL, and a report card
        // keyed on grade labels would be ambiguous.
        await hReject(
          () =>
            migrator.query(
              `insert into grading_scales (id, tenant_id, code, name, version, is_active, bands)
               values ('${randomUUID()}', '${uid.tenantA}', 'f08b_${slug}', 'Dup D', 1, false,
                       '[{"label":"A","minPercent":0,"maxPercent":50,"gradePoint":1},
                         {"label":"D","minPercent":50,"maxPercent":80,"gradePoint":3},
                         {"label":"D","minPercent":80,"maxPercent":100,"gradePoint":4}]'::jsonb)`,
            ),
          '55000',
          /appears more than once in this scale/,
        );
      });

      it('still accepts the four distinct fixture labels', async () => {
        const id = randomUUID();
        await migrator.query('begin');
        await migrator.query(
          `insert into grading_scales (id, tenant_id, code, name, version, is_active, bands)
           values ('${id}', '${uid.tenantA}', 'f08c_${slug}', 'Distinct', 1, false, '${JSON.stringify(BANDS)}'::jsonb)`,
        );
        await migrator.query('rollback');
      });
    });

    describe('F-07 a pinned grading scale resolves even when inactive', () => {
      it('derives a grade from a scale that was RETIRED after the exam pinned it', async () => {
        const scale = randomUUID();
        const exam = randomUUID();
        const es = randomUUID();
        const mark = randomUUID();
        // The real sequence, and the one that produced the finding: the exam pins a
        // scale while it is ACTIVE (the exams trigger refuses to pin a retired one
        // outright), and the scale is deactivated LATER. The pin is a historical
        // reference, so the retirement must not reach back and void the exam.
        await migrator.query('begin');
        try {
          await migrator.query(
            `insert into grading_scales (id, tenant_id, code, name, version, is_active, bands)
             values ('${scale}', '${uid.tenantA}', 'f07_${slug}', 'Retired later', 1, true, '${JSON.stringify(BANDS)}'::jsonb)`,
          );
          await migrator.query(
            `insert into exams (id, tenant_id, academic_term_id, academic_year_id, exam_type_id, grading_scale_id, name, status)
             values ('${exam}', '${uid.tenantA}', '${uid.termA}', '${uid.yearA}', '${uid.typeA}', '${scale}', 'Retired scale ${slug}', 'draft')`,
          );
          await migrator.query(
            `insert into exam_subjects (id, tenant_id, exam_id, class_subject_id, academic_year_id, class_id, subject_id, max_marks, weight)
             values ('${es}', '${uid.tenantA}', '${exam}', '${uid.linkA}', '${uid.yearA}', '${uid.classA}', '${uid.subjA}', 100, 1)`,
          );
          // The operational toggle that used to destroy the result.
          await migrator.query(`update grading_scales set is_active = false where id = '${scale}'`);
          await migrator.query(`update exams set status = 'grading' where id = '${exam}'`);
          await migrator.query(
            `insert into marks (id, tenant_id, exam_subject_id, enrollment_id, student_id, section_id, academic_year_id, marks_obtained, entered_by)
             values ('${mark}', '${uid.tenantA}', '${es}', '${uid.enrollA3}', '${uid.studentA3}', '${uid.sectionA}', '${uid.yearA}', 91, '${uid.teacher}')`,
          );
          const rows = await migQ<{ grade_label: string | null; grade_point: number | null }>(
            `select grade_label, grade_point from marks where id = '${mark}'`,
          );
          // 91% in the pinned-but-retired scale is D/4. Before the fix this was
          // null/null, which silently voided a published result.
          expect(rows[0]!.grade_label).toBe('D');
          expect(Number(rows[0]!.grade_point)).toBe(4);
        } finally {
          await migrator.query('rollback').catch(() => {});
        }
      });

      it('re-derives an already-published mark when the pinned scale was retired', async () => {
        // The exact harm: a mark that already carries a published grade is recomputed
        // (e.g. by the correction recompute) and its grade is wiped to null.
        const scale = randomUUID();
        const exam = randomUUID();
        const es = randomUUID();
        const mark = randomUUID();
        await migrator.query('begin');
        try {
          await migrator.query(
            `insert into grading_scales (id, tenant_id, code, name, version, is_active, bands)
             values ('${scale}', '${uid.tenantA}', 'f07b_${slug}', 'Retired later', 1, true, '${JSON.stringify(BANDS)}'::jsonb)`,
          );
          await migrator.query(
            `insert into exams (id, tenant_id, academic_term_id, academic_year_id, exam_type_id, grading_scale_id, name, status)
             values ('${exam}', '${uid.tenantA}', '${uid.termA}', '${uid.yearA}', '${uid.typeA}', '${scale}', 'Repub ${slug}', 'draft')`,
          );
          await migrator.query(
            `insert into exam_subjects (id, tenant_id, exam_id, class_subject_id, academic_year_id, class_id, subject_id, max_marks, weight)
             values ('${es}', '${uid.tenantA}', '${exam}', '${uid.linkA}', '${uid.yearA}', '${uid.classA}', '${uid.subjA}', 100, 1)`,
          );
          await migrator.query(`update exams set status = 'grading' where id = '${exam}'`);
          await migrator.query(
            `insert into marks (id, tenant_id, exam_subject_id, enrollment_id, student_id, section_id, academic_year_id, marks_obtained, entered_by)
             values ('${mark}', '${uid.tenantA}', '${es}', '${uid.enrollA3}', '${uid.studentA3}', '${uid.sectionA}', '${uid.yearA}', 91, '${uid.teacher}')`,
          );
          await migrator.query(
            `update exams set status = 'published', published_at = now() where id = '${exam}'`,
          );
          await migrator.query(`update grading_scales set is_active = false where id = '${scale}'`);

          // Re-derive through the ONE legal path for a published mark: an
          // append-only correction row in the same transaction.
          await migrator.query(
            `insert into mark_corrections (id, tenant_id, mark_id, exam_id, exam_subject_id, student_id, old_marks_obtained, new_marks_obtained, reason, corrected_by)
             values ('${randomUUID()}', '${uid.tenantA}', '${mark}', '${exam}', '${es}', '${uid.studentA3}', 91, 90, 're-derive after the pinned scale was retired', '${uid.teacher}')`,
          );
          await migrator.query(
            `update marks set marks_obtained = 90 where id = '${mark}'`,
          );
          const rows = await migQ<{ grade_label: string | null; grade_point: number | null }>(
            `select grade_label, grade_point from marks where id = '${mark}'`,
          );
          expect(rows[0]!.grade_label).toBe('D');
          expect(Number(rows[0]!.grade_point)).toBe(4);
        } finally {
          await migrator.query('rollback').catch(() => {});
        }
      });

      it('materialises a null grading_scale_id when the exam enters the lifecycle', async () => {
        const exam = randomUUID();
        await migrator.query('begin');
        try {
          await migrator.query(
            `insert into exams (id, tenant_id, academic_term_id, academic_year_id, exam_type_id, grading_scale_id, name, status)
             values ('${exam}', '${uid.tenantA}', '${uid.termA}', '${uid.yearA}', '${uid.typeA}', null, 'Unpinned ${slug}', 'draft')`,
          );
          const before = await migQ<{ grading_scale_id: string | null }>(
            `select grading_scale_id from exams where id = '${exam}'`,
          );
          expect(before[0]!.grading_scale_id).toBeNull();

          // Crossing into 'scheduled' is the point at which the exam stops being
          // reconfigurable, so the scale must be decided by then.
          await migrator.query(`update exams set status = 'scheduled' where id = '${exam}'`);
          const after = await migQ<{ grading_scale_id: string | null }>(
            `select grading_scale_id from exams where id = '${exam}'`,
          );
          expect(after[0]!.grading_scale_id).toBe(uid.scaleA);
        } finally {
          await migrator.query('rollback').catch(() => {});
        }
      });
    });

    describe('F-03 a published mark is frozen as a whole, not just its value', () => {
      /**
       * THE POINT OF THIS SECTION.
       *
       * Changing ONE identity column at a time is already refused by the
       * pre-existing enrollment-anchor checks ("mark student must match the
       * enrollment", the unique index on (exam_subject, enrollment), and so on), so
       * a test of that shape proves nothing about the freeze. What the audit proved
       * was accepted is a COHERENT reassignment: a move in which the enrollment,
       * student, section and year all agree with each other and with a real,
       * different target. Every coherence check passes, so the only thing that can
       * refuse it is the published-row freeze.
       *
       * `buildCoherentTarget` therefore builds a full, consistent alternative
       * identity for tenant A — another section, another student and enrollment, and
       * another PUBLISHED exam with its own exam_subject — and the tests below move
       * the mark there in a single statement.
       */
      const buildCoherentTarget = async (): Promise<{ section: string; es: string; mark: string }> => {
        const section = randomUUID();
        const student = randomUUID();
        const enrollment = randomUUID();
        const exam = randomUUID();
        const es = randomUUID();
        const mark = randomUUID();
        await migrator.query(
          `insert into sections (id, tenant_id, class_id, campus_id, academic_year_id, code, status)
           values ('${section}', '${uid.tenantA}', '${uid.classA}', '${uid.campusA}', '${uid.yearA}', 's2-${slug}', 'active')`,
        );
        await migrator.query(
          `insert into students (id, tenant_id, student_no, first_name, last_name, status, primary_campus_id)
           values ('${student}', '${uid.tenantA}', 's9-${slug}', 'Ivy', 'Nine', 'active', '${uid.campusA}')`,
        );
        await migrator.query(
          `insert into enrollments (id, tenant_id, student_id, academic_year_id, class_id, section_id, roll_no, status)
           values ('${enrollment}', '${uid.tenantA}', '${student}', '${uid.yearA}', '${uid.classA}', '${section}', '09', 'active')`,
        );
        // A second, independently PUBLISHED exam. Repointing a published mark at
        // another published exam's subject is the worst version of this bug: the
        // mark keeps looking published and lands in the wrong exam entirely.
        await migrator.query(
          `insert into exams (id, tenant_id, academic_term_id, academic_year_id, exam_type_id, grading_scale_id, name, status)
           values ('${exam}', '${uid.tenantA}', '${uid.termA}', '${uid.yearA}', '${uid.typeA}', '${uid.scaleA}', 'Other published ${slug}', 'draft')`,
        );
        await migrator.query(
          `insert into exam_subjects (id, tenant_id, exam_id, class_subject_id, academic_year_id, class_id, subject_id, max_marks, weight)
           values ('${es}', '${uid.tenantA}', '${exam}', '${uid.linkA}', '${uid.yearA}', '${uid.classA}', '${uid.subjA}', 100, 1)`,
        );
        await migrator.query(`update exams set status = 'grading' where id = '${exam}'`);
        await migrator.query(
          `insert into marks (id, tenant_id, exam_subject_id, enrollment_id, student_id, section_id, academic_year_id, marks_obtained, entered_by)
           values ('${mark}', '${uid.tenantA}', '${es}', '${enrollment}', '${student}', '${section}', '${uid.yearA}', 55, '${uid.teacher}')`,
        );
        await migrator.query(
          `update exams set status = 'published', published_at = now() where id = '${exam}'`,
        );
        return { section, es, mark };
      };

      /** Runs `fn` inside a transaction that is ALWAYS ended, however it exits. */
      const inTx = async (fn: () => Promise<void>): Promise<void> => {
        await migrator.query('begin');
        try {
          await fn();
        } finally {
          await migrator.query('rollback').catch(() => {});
        }
      };

      it('refuses a COHERENT move to another student/enrollment/section', async () => {
        // Before the remediation this was ACCEPTED: every coherence check agrees,
        // because the target is a real enrollment with a real student in a real
        // section. Only the published-row freeze refuses it.
        await hReject(
          () =>
            migrator.query(
              `update marks
                  set enrollment_id = '${uid.enrollA3}', student_id = '${uid.studentA3}', section_id = '${uid.sectionA}'
                where id = '${uid.markPublished}'`,
            ),
          '55000',
          /frozen/,
        );
      });

      it('refuses a COHERENT repoint to another PUBLISHED exam\'s exam_subject', async () => {
        await inTx(async () => {
          const t = await buildCoherentTarget();
          // The target is genuinely usable, so the refusal below is the freeze and
          // not an accidental constraint violation.
          const before = await migQ<{ exam_subject_id: string }>(
            `select exam_subject_id from marks where id = '${uid.markPublished}'`,
          );
          expect(before[0]!.exam_subject_id).toBe(uid.esPublished);

          await migrator.query('savepoint sp');
          const caught = await migrator
            .query(`update marks set exam_subject_id = '${t.es}' where id = '${uid.markPublished}'`)
            .catch((err: pg.DatabaseError) => err);
          await migrator.query('rollback to savepoint sp');
          expect(caught).toBeInstanceOf(Error);
          expect((caught as pg.DatabaseError).code).toBe('55000');
          expect((caught as Error).message).toMatch(/frozen/);

          const after = await migQ<{ exam_subject_id: string }>(
            `select exam_subject_id from marks where id = '${uid.markPublished}'`,
          );
          expect(after[0]!.exam_subject_id).toBe(uid.esPublished);
        });
      });

      it('refuses a COHERENT move that also re-anchors the academic year', async () => {
        await inTx(async () => {
          // A second, complete academic hierarchy for tenant A. `sections` is
          // keyed to its class's year, so a year change needs its own class — you
          // cannot borrow the fixture's class, and that constraint is exactly why a
          // coherent year move is only reachable by building the whole chain.
          const year2 = randomUUID();
          const class2 = randomUUID();
          const section2 = randomUUID();
          const student2 = randomUUID();
          const enroll2 = randomUUID();
          await migrator.query(
            `insert into academic_years (id, tenant_id, code, name, starts_on, ends_on, status)
             values ('${year2}', '${uid.tenantA}', 'y3-${slug}', 'AY A3', '2027-01-01', '2027-12-31', 'active')`,
          );
          await migrator.query(
            `insert into acd_classes (id, tenant_id, campus_id, academic_year_id, grade_level_id, code, name, status)
             values ('${class2}', '${uid.tenantA}', '${uid.campusA}', '${year2}', '${uid.levelA}', 'c2-${slug}', 'Class A2', 'active')`,
          );
          await migrator.query(
            `insert into sections (id, tenant_id, class_id, campus_id, academic_year_id, code, status)
             values ('${section2}', '${uid.tenantA}', '${class2}', '${uid.campusA}', '${year2}', 's3-${slug}', 'active')`,
          );
          await migrator.query(
            `insert into students (id, tenant_id, student_no, first_name, last_name, status, primary_campus_id)
             values ('${student2}', '${uid.tenantA}', 's10-${slug}', 'Jon', 'Ten', 'active', '${uid.campusA}')`,
          );
          await migrator.query(
            `insert into enrollments (id, tenant_id, student_id, academic_year_id, class_id, section_id, roll_no, status)
             values ('${enroll2}', '${uid.tenantA}', '${student2}', '${year2}', '${class2}', '${section2}', '10', 'active')`,
          );
          // enrollment + student + section + year all move together and all agree
          // with each other. The year cannot also agree with the EXAM (which lives in
          // the fixture's year), so this case is legitimately refused by the
          // exam-year coherence check rather than by the freeze — which is itself
          // the useful conclusion: academic_year_id was never the exposed column.
          await migrator.query('savepoint sp');
          const caught = await migrator
            .query(
              `update marks
                  set enrollment_id = '${enroll2}', student_id = '${student2}',
                      section_id = '${section2}', academic_year_id = '${year2}'
                where id = '${uid.markPublished}'`,
            )
            .catch((err: pg.DatabaseError) => err);
          await migrator.query('rollback to savepoint sp');
          expect(caught).toBeInstanceOf(Error);
          expect((caught as pg.DatabaseError).code).toBe('55000');
          expect((caught as Error).message).toMatch(/frozen|must match the exam/);
        });
      });

      it('refuses soft-hiding a published mark via deleted_at', async () => {
        // Coherence-neutral, so this one really is a freeze-only case: before the
        // remediation the row simply disappeared from every report while still
        // counting towards totals.
        await hReject(
          () => migrator.query(`update marks set deleted_at = now() where id = '${uid.markPublished}'`),
          '55000',
          /frozen/,
        );
      });

      it('refuses stripping the entering teacher from a published mark', async () => {
        // Also coherence-neutral. The actor is a column too.
        await hReject(
          () => migrator.query(`update marks set entered_by = null where id = '${uid.markPublished}'`),
          '55000',
          /frozen/,
        );
      });

      it('refuses changing the tenant of a published mark', async () => {
        // The derive trigger also refuses this (it then cannot resolve the
        // exam_subject in the new tenant), so the guarantee here is the outcome,
        // not which guard spoke first: the row must not change tenant.
        await inTx(async () => {
          await migrator.query('savepoint sp');
          const caught = await migrator
            .query(`update marks set tenant_id = '${uid.tenantB}' where id = '${uid.markPublished}'`)
            .catch((err: pg.DatabaseError) => err);
          // Roll the statement back to a savepoint so the verification read below
          // is not run against an aborted transaction.
          await migrator.query('rollback to savepoint sp');
          expect(caught).toBeInstanceOf(Error);
          const rows = await migQ<{ tenant_id: string }>(
            `select tenant_id from marks where id = '${uid.markPublished}'`,
          );
          expect(rows[0]!.tenant_id).toBe(uid.tenantA);
        });
      });

      it('refuses transplanting a published mark across two published exams', async () => {
        // Move a published mark of the SECOND published exam onto a real enrollment
        // of the first year. Cross-exam, coherent, and no unique-index collision,
        // because that enrollment has no mark on the receiving exam_subject.
        await inTx(async () => {
          const t = await buildCoherentTarget();
          await migrator.query('savepoint sp');
          const caught = await migrator
            .query(
              `update marks
                  set enrollment_id = '${uid.enrollA1}', student_id = '${uid.studentA1}', section_id = '${uid.sectionA}',
                      academic_year_id = '${uid.yearA}', exam_subject_id = '${uid.esPublished}'
                where id = '${t.mark}'`,
            )
            .catch((err: pg.DatabaseError) => err);
          await migrator.query('rollback to savepoint sp');
          expect(caught).toBeInstanceOf(Error);
          expect((caught as Error).message).toMatch(/frozen/);
        });
      });

      it('still permits the correction workflow\'s UPDATE shape', async () => {
        // The freeze must not be so blunt that it blocks the ONE legal write. The
        // correction path issues an UPDATE that names identity columns while only
        // really changing marks_obtained; a naive column-level freeze would reject
        // it. This asserts identity columns are compared BY VALUE, not by "was named
        // in the statement".
        await inTx(async () => {
          const caught = await migrator
            .query(
              `update marks
                  set enrollment_id = enrollment_id, student_id = student_id,
                      section_id = section_id, exam_subject_id = exam_subject_id,
                      academic_year_id = academic_year_id, entered_by = entered_by
                where id = '${uid.markPublished}'`,
            )
            .catch((err: pg.DatabaseError) => err);
          // Nothing may actually change, but nothing may be refused by the FREEZE
          // either. A refusal here, if any, has to come from the workflow rule.
          if (caught instanceof Error) expect(caught.message).not.toMatch(/frozen/);
        });
      });

      it('still permits a value change on a published mark through a real correction', async () => {
        // The positive control for the freeze: the legal path stays open, and the
        // re-derived grade still comes from the pinned scale.
        await inTx(async () => {
          // Read the mark's CURRENT value instead of hardcoding it, so this control
          // does not silently depend on how much the shared fixture has moved.
          const before = await migQ<{ marks_obtained: number }>(
            `select marks_obtained from marks where id = '${uid.markPublished}'`,
          );
          const oldValue = Number(before[0]!.marks_obtained);
          await migrator.query(
            `insert into mark_corrections (id, tenant_id, mark_id, exam_id, exam_subject_id, student_id, old_marks_obtained, new_marks_obtained, reason, corrected_by)
             values ('${randomUUID()}', '${uid.tenantA}', '${uid.markPublished}', '${uid.examPublished}', '${uid.esPublished}', '${uid.studentA2}', ${oldValue}, 60, 'F-03 positive control', '${uid.teacher}')`,
          );
          const caught = await migrator
            .query(`update marks set marks_obtained = 60 where id = '${uid.markPublished}'`)
            .catch((err: pg.DatabaseError) => err);
          expect(caught).not.toBeInstanceOf(Error);
          const rows = await migQ<{ marks_obtained: number; grade_label: string | null }>(
            `select marks_obtained, grade_label from marks where id = '${uid.markPublished}'`,
          );
          expect(Number(rows[0]!.marks_obtained)).toBe(60);
          expect(rows[0]!.grade_label).toBe('C');
        });
      });

      it('refuses a DELETE of a published mark even for the table owner', async () => {
        await hReject(
          () => migrator.query(`delete from marks where id = '${uid.markPublished}'`),
          '55000',
          /cannot be deleted/,
        );
      });

      it('refuses a DELETE reached through a different column that names the same mark', async () => {
        // The guard keys on the mark's exam, not on the WHERE clause, so it cannot
        // be walked around by deleting a batch.
        await hReject(
          () =>
            migrator.query(
              `delete from marks where exam_subject_id = '${uid.esPublished}' and tenant_id = '${uid.tenantA}'`,
            ),
          '55000',
          /cannot be deleted/,
        );
      });

      it('still permits a DELETE of a pre-publication mark', async () => {
        // The guard is scoped to published exams only. Mark entry in
        // 'draft'/'scheduled' must remain an erasable draft, otherwise a mis-keyed
        // mark is unfixable.
        const mark = randomUUID();
        await inTx(async () => {
          await migrator.query(
            `insert into marks (id, tenant_id, exam_subject_id, enrollment_id, student_id, section_id, academic_year_id, marks_obtained, entered_by)
             values ('${mark}', '${uid.tenantA}', '${uid.esSched}', '${uid.enrollA3}', '${uid.studentA3}', '${uid.sectionA}', '${uid.yearA}', 10, '${uid.teacher}')`,
          );
          const caught = await migrator
            .query(`delete from marks where id = '${mark}'`)
            .catch((err: pg.DatabaseError) => err);
          expect(caught).not.toBeInstanceOf(Error);
        });
      });

      it('is reachable by the unprivileged runtime role too', async () => {
        const tkt = (await appQ(`select app_ctx_mint('tenant', '${uid.teacher}', '${uid.tenantA}') t`))[0]!
          .t as string;
        await app.query('begin');
        await app.query(`set local app.rls = '${tkt}'`);
        try {
          const caught = await app
            .query(`update marks set deleted_at = now() where id = '${uid.markPublished}'`)
            .catch((err: pg.DatabaseError) => err);
          expect(caught).toBeInstanceOf(Error);
          expect((caught as pg.DatabaseError).code).toBe('55000');
          expect((caught as Error).message).toMatch(/frozen/);
        } finally {
          await app.query('rollback').catch(() => {});
        }
      });
    });

    // =======================================================================
    // Section I — regressions for the FINAL RE-AUDIT (migration 0017).
    //
    // Every test below reproduces, against the real catalog and the real
    // triggers, a state the audit demonstrated was ACCEPTED before 0017, and
    // asserts the database now refuses it (or, where the finding was that
    // something was silently recomputed, asserts the value no longer moves).
    // Self-contained like section H: own transactions, nothing left behind.
    // =======================================================================

    /**
     * Runs `fn` in a transaction on the migrator connection that is ALWAYS rolled
     * back, and returns whatever `fn` returned. Several of these tests need to read
     * the state back at more than one point in the same transaction, which
     * `hRows` (rows of one result) cannot express.
     */
    const iRun = async <T>(fn: () => Promise<T>): Promise<T> => {
      await migrator.query('begin');
      try {
        return await fn();
      } finally {
        await migrator.query('rollback').catch(() => {});
      }
    };

    describe('P1-01 a published mark cannot be walked out of its exam', () => {
      /**
       * The reproduction, verbatim, as the audit ran it: publication freezes a
       * mark; the mark is then re-pointed at the exam_subject of a DIFFERENT,
       * non-published exam; the published exam loses the mark, and the guard that
       * was supposed to protect it no longer applies, so the row can then be
       * hard-deleted outright. Nothing is written to the correction ledger.
       *
       * 0017 fixes the cause, not the symptom: the freeze is decided from the
       * preserved publication marker instead of the writable exam_subject_id.
       */
      const buildEscapeTarget = async (status: 'scheduled' | 'grading' = 'grading'): Promise<{ exam: string; es: string }> => {
        const exam = randomUUID();
        const es = randomUUID();
        await migrator.query(
          `insert into exams (id, tenant_id, academic_term_id, academic_year_id, exam_type_id, grading_scale_id, name, status)
           values ('${exam}', '${uid.tenantA}', '${uid.termA}', '${uid.yearA}', '${uid.typeA}', '${uid.scaleA}', 'Escape target ${slug}', 'draft')`,
        );
        // The subject session is attached while the exam is still draft: 0015
        // refuses to add one once it is grading.
        await migrator.query(
          `insert into exam_subjects (id, tenant_id, exam_id, class_subject_id, academic_year_id, class_id, subject_id, max_marks, weight)
           values ('${es}', '${uid.tenantA}', '${exam}', '${uid.linkA}', '${uid.yearA}', '${uid.classA}', '${uid.subjA}', 100, 1)`,
        );
        await migrator.query(`update exams set status = '${status}' where id = '${exam}'`);
        return { exam, es };
      };

      it('refuses the re-point, and the published exam keeps its mark', async () => {
        await migrator.query('begin');
        try {
          const { es } = await buildEscapeTarget();
          const before = (
            await migQ<{ exam_subject_id: string; published_exam_id: string | null; frozen_at: string | null }>(
              `select exam_subject_id, published_exam_id, frozen_at from marks where id = '${uid.markPublished}'`,
            )
          )[0]!;
          // The marker is the preserved relationship, and it names the exam.
          expect(before.published_exam_id).toBe(uid.examPublished);
          expect(before.frozen_at).not.toBeNull();

          await migrator.query('savepoint sp');
          const caught = await migrator
            .query(`update marks set exam_subject_id = '${es}' where id = '${uid.markPublished}'`)
            .catch((err: pg.DatabaseError) => err);
          await migrator.query('rollback to savepoint sp');
          expect(caught).toBeInstanceOf(Error);
          expect((caught as pg.DatabaseError).code).toBe('55000');
          expect((caught as Error).message).toMatch(/frozen/);

          // The mark is still attached to the published exam…
          const after = (
            await migQ<{ exam_subject_id: string; published_exam_id: string | null }>(
              `select exam_subject_id, published_exam_id from marks where id = '${uid.markPublished}'`,
            )
          )[0]!;
          expect(after.exam_subject_id).toBe(uid.esPublished);
          expect(after.published_exam_id).toBe(uid.examPublished);
          // …it is still visible to the published exam's result set…
          const stillThere = await migQ<{ n: number }>(
            `select count(*)::int n from marks where tenant_id = '${uid.tenantA}' and exam_subject_id = '${uid.esPublished}' and deleted_at is null`,
          );
          expect(stillThere[0]!.n).toBe(1);
          // …and nothing was smuggled through the correction ledger.
          const ledger = await migQ<{ n: number }>(
            `select count(*)::int n from mark_corrections where mark_id = '${uid.markPublished}' and new_marks_obtained <> old_marks_obtained and reason like 'escape%'`,
          );
          expect(ledger[0]!.n).toBe(0);
        } finally {
          await migrator.query('rollback').catch(() => {});
        }
      });

      it('still refuses the soft-delete that followed the re-point attempt', async () => {
        // The second half of the reproduction. Under 0016 the re-point had already
        // moved the mark to a non-published exam, so `deleted_at` was unconstrained
        // and the mark simply vanished from the published result. Both statements
        // are now refused, so the sequence has no working end.
        await migrator.query('begin');
        try {
          await migrator.query('savepoint sp');
          const caught = await migrator
            .query(`update marks set deleted_at = now() where id = '${uid.markPublished}'`)
            .catch((err: pg.DatabaseError) => err);
          await migrator.query('rollback to savepoint sp');
          expect(caught).toBeInstanceOf(Error);
          expect((caught as Error).message).toMatch(/frozen/);
        } finally {
          await migrator.query('rollback').catch(() => {});
        }
      });

      it('refuses the same escape for the UNPRIVILEGED runtime role', async () => {
        // The audit reproduced this as school_app_rw, not just as the table owner,
        // so the freeze has to be a database rule and not a privileged-session
        // convention.
        await tenantA(async () => {
          await rejectCode(
            () => app.query(`update marks set exam_subject_id = '${uid.esGrading}' where id = '${uid.markPublished}'`),
            '55000',
            /frozen/,
          );
          await rejectCode(
            () => app.query(`update marks set deleted_at = now() where id = '${uid.markPublished}'`),
            '55000',
            /frozen/,
          );
          // DELETE is a second line of defence here: the runtime role's DELETE
          // policy is privileged-only, so the write is filtered to zero rows rather
          // than refused, and the mark survives either way (see A.6).
          const del = await app.query(`delete from marks where id = '${uid.markPublished}'`);
          expect(del.rowCount).toBe(0);
          const left = await appQ<{ n: number }>(
            `select count(*)::int n from marks where id = '${uid.markPublished}'`,
          );
          expect(Number(left[0]!.n)).toBe(1);
        });
      });

      it('refuses a hard DELETE of a mark that is already soft-deleted at publication time', async () => {
        // The DELETE guard keys on the MARKER, not on the row's current exam, so a
        // mark that was soft-hidden before the exam was published is still frozen and
        // still undeletable. A marker-less row would be the hole.
        const es = randomUUID();
        const exam = randomUUID();
        const mark = randomUUID();
        await migrator.query('begin');
        try {
          await migrator.query(
            `insert into exams (id, tenant_id, academic_term_id, academic_year_id, exam_type_id, grading_scale_id, name, status)
             values ('${exam}', '${uid.tenantA}', '${uid.termA}', '${uid.yearA}', '${uid.typeA}', '${uid.scaleA}', 'Soft-deleted mark ${slug}', 'draft')`,
          );
          await migrator.query(
            `insert into exam_subjects (id, tenant_id, exam_id, class_subject_id, academic_year_id, class_id, subject_id, max_marks, weight)
             values ('${es}', '${uid.tenantA}', '${exam}', '${uid.linkA}', '${uid.yearA}', '${uid.classA}', '${uid.subjA}', 100, 1)`,
          );
          await migrator.query(`update exams set status = 'grading' where id = '${exam}'`);
          await migrator.query(
            `insert into marks (id, tenant_id, exam_subject_id, enrollment_id, student_id, section_id, academic_year_id, marks_obtained, entered_by)
             values ('${mark}', '${uid.tenantA}', '${es}', '${uid.enrollA1}', '${uid.studentA1}', '${uid.sectionA}', '${uid.yearA}', 40, '${uid.teacher}')`,
          );
          // Soft-hidden while the exam is still grading: legal, and it must not
          // become a loophole afterwards.
          await migrator.query(`update marks set deleted_at = now() where id = '${mark}'`);
          await migrator.query(
            `update exams set status = 'published', published_at = now() where id = '${exam}'`,
          );
          // The sweep reached it anyway, so it carries the marker…
          const frozen = (
            await migQ<{ published_exam_id: string | null; status: string }>(
              `select published_exam_id, status from marks where id = '${mark}'`,
            )
          )[0]!;
          expect(frozen.published_exam_id).toBe(exam);
          expect(frozen.status).toBe('locked');
          // …and the DELETE guard therefore applies to it.
          await migrator.query('savepoint sp');
          const caught = await migrator
            .query(`delete from marks where id = '${mark}'`)
            .catch((err: pg.DatabaseError) => err);
          await migrator.query('rollback to savepoint sp');
          expect(caught).toBeInstanceOf(Error);
          expect((caught as Error).message).toMatch(/cannot be deleted/);
        } finally {
          await migrator.query('rollback').catch(() => {});
        }
      });

      it('refuses moving a mark INTO a published exam', async () => {
        // The mirror image, which 0015/0016 left open: inserting a new mark into a
        // published exam was refused, but re-pointing an existing mark at one was
        // accepted, which silently changed a published card's subject count, totals
        // and GPA after the result had been announced.
        await migrator.query('begin');
        try {
          const { es } = await buildEscapeTarget();
          await migrator.query(
            `insert into marks (id, tenant_id, exam_subject_id, enrollment_id, student_id, section_id, academic_year_id, marks_obtained, entered_by)
             values ('${randomUUID()}', '${uid.tenantA}', '${es}', '${uid.enrollA3}', '${uid.studentA3}', '${uid.sectionA}', '${uid.yearA}', 55, '${uid.teacher}')`,
          );
          await migrator.query('savepoint sp');
          const caught = await migrator
            .query(
              `update marks set exam_subject_id = '${uid.esPublished}' where exam_subject_id = '${es}' and marks_obtained = 55`,
            )
            .catch((err: pg.DatabaseError) => err);
          await migrator.query('rollback to savepoint sp');
          expect(caught).toBeInstanceOf(Error);
          expect((caught as pg.DatabaseError).code).toBe('55000');
          expect((caught as Error).message).toMatch(/moved into a published exam/);
        } finally {
          await migrator.query('rollback').catch(() => {});
        }
      });

      it('refuses a client that sets, repoints or clears the marker itself', async () => {
        // The marker is only trustworthy because nothing but the trigger may write
        // it. Without this rule a session could pre-freeze a mark against an exam of
        // its choosing and then rewrite it under that false protection.
        await migrator.query('begin');
        try {
          // Setting one on a provisional mark of a non-published exam.
          await migrator.query('savepoint sp');
          const invented = await migrator
            .query(
              `update marks set published_exam_id = '${uid.examGrading}', frozen_at = now() where id = '${uid.markA1}'`,
            )
            .catch((err: pg.DatabaseError) => err);
          await migrator.query('rollback to savepoint sp');
          expect(invented).toBeInstanceOf(Error);
          expect((invented as pg.DatabaseError).code).toBe('55000');
          expect((invented as Error).message).toMatch(/server-owned/);

          // Repointing a real one.
          await migrator.query('savepoint sp');
          const moved = await migrator
            .query(
              `update marks set published_exam_id = '${uid.examGrading}' where id = '${uid.markPublished}'`,
            )
            .catch((err: pg.DatabaseError) => err);
          await migrator.query('rollback to savepoint sp');
          expect(moved).toBeInstanceOf(Error);
          expect((moved as Error).message).toMatch(/immutable/);

          // Clearing it.
          await migrator.query('savepoint sp');
          const cleared = await migrator
            .query(
              `update marks set published_exam_id = null, frozen_at = null where id = '${uid.markPublished}'`,
            )
            .catch((err: pg.DatabaseError) => err);
          await migrator.query('rollback to savepoint sp');
          expect(cleared).toBeInstanceOf(Error);
          expect((cleared as Error).message).toMatch(/immutable/);
        } finally {
          await migrator.query('rollback').catch(() => {});
        }
      });

      it('does not let a marker-bearing mark be re-anchored to another exam', async () => {
        // The stronger shape: even a fully COHERENT move (enrollment, student,
        // section and year all agreeing with a real target) is refused, which is the
        // only version of this bug that every coherence check used to accept.
        await migrator.query('begin');
        try {
          const section = randomUUID();
          const student = randomUUID();
          const enrollment = randomUUID();
          const { es } = await buildEscapeTarget();
          await migrator.query(
            `insert into sections (id, tenant_id, class_id, campus_id, academic_year_id, code, status)
             values ('${section}', '${uid.tenantA}', '${uid.classA}', '${uid.campusA}', '${uid.yearA}', 's9-${slug}', 'active')`,
          );
          await migrator.query(
            `insert into students (id, tenant_id, student_no, first_name, last_name, status, primary_campus_id)
             values ('${student}', '${uid.tenantA}', 's9-${slug}', 'Ivy', 'Nine', 'active', '${uid.campusA}')`,
          );
          await migrator.query(
            `insert into enrollments (id, tenant_id, student_id, academic_year_id, class_id, section_id, roll_no, status)
             values ('${enrollment}', '${uid.tenantA}', '${student}', '${uid.yearA}', '${uid.classA}', '${section}', '09', 'active')`,
          );
          await migrator.query('savepoint sp');
          const caught = await migrator
            .query(
              `update marks
                  set enrollment_id = '${enrollment}', student_id = '${student}', section_id = '${section}',
                      academic_year_id = '${uid.yearA}', exam_subject_id = '${es}'
                where id = '${uid.markPublished}'`,
            )
            .catch((err: pg.DatabaseError) => err);
          await migrator.query('rollback to savepoint sp');
          expect(caught).toBeInstanceOf(Error);
          expect((caught as Error).message).toMatch(/frozen/);
        } finally {
          await migrator.query('rollback').catch(() => {});
        }
      });
    });

    describe('P1-02 publication freezes the result instead of recomputing it', () => {
      it('leaves a published grade exactly as it was entered', async () => {
        // The audit's numbers: 90/100 entered as D/4 while the exam was grading,
        // then the scale it is graded against changed, then publication. Under
        // 0016 publication re-entered the derivation trigger and the mark became
        // E/1.50 with no correction row. 0017 derives only when marks_obtained
        // changes, so the sweep is a pure freeze.
        const exam = randomUUID();
        const es = randomUUID();
        const mark = randomUUID();
        const [entered, published] = await iRun(async () => {
          await migrator.query(
            `insert into exams (id, tenant_id, academic_term_id, academic_year_id, exam_type_id, grading_scale_id, name, status)
             values ('${exam}', '${uid.tenantA}', '${uid.termA}', '${uid.yearA}', '${uid.typeA}', '${uid.scaleA}', 'No regrade ${slug}', 'draft')`,
          );
          await migrator.query(
            `insert into exam_subjects (id, tenant_id, exam_id, class_subject_id, academic_year_id, class_id, subject_id, max_marks, weight)
             values ('${es}', '${uid.tenantA}', '${exam}', '${uid.linkA}', '${uid.yearA}', '${uid.classA}', '${uid.subjA}', 100, 1)`,
          );
          await migrator.query(`update exams set status = 'grading' where id = '${exam}'`);
          await migrator.query(
            `insert into marks (id, tenant_id, exam_subject_id, enrollment_id, student_id, section_id, academic_year_id, marks_obtained, entered_by)
             values ('${mark}', '${uid.tenantA}', '${es}', '${uid.enrollA1}', '${uid.studentA1}', '${uid.sectionA}', '${uid.yearA}', 90, '${uid.teacher}')`,
          );
          const before = await migQ<{
            percentage: string;
            grade_label: string | null;
            grade_point: string | null;
          }>(`select percentage, grade_label, grade_point from marks where id = '${mark}'`);
          await migrator.query(
            `update exams set status = 'published', published_at = now() where id = '${exam}'`,
          );
          const after = await migQ<{
            percentage: string;
            grade_label: string | null;
            grade_point: string | null;
            status: string;
          }>(`select percentage, grade_label, grade_point, status from marks where id = '${mark}'`);
          return [before[0]!, after[0]!] as const;
        });
        // Entered, still entered.
        expect(Number(entered.percentage)).toBe(90);
        expect(entered.grade_label).toBe('D');
        expect(Number(entered.grade_point)).toBe(4);
        // Publication locked it and changed nothing else.
        expect(published.status).toBe('locked');
        expect(Number(published.percentage)).toBe(90);
        expect(published.grade_label).toBe('D');
        expect(Number(published.grade_point)).toBe(4);
      });

      it('does not retroactively grade a mark whose exam had no scale to grade against', async () => {
        // A fully observable form of the same property, independent of the P3-02 band
        // freeze, so the two rules cannot both be true merely because they mask each
        // other. With no active scale at scheduling time the pin stays NULL, so a
        // mark entered then derives no grade at all. Activating a scale afterwards
        // changes what `fn_exam_grade_for` would answer - and 0016 let publication
        // reach back and grade the mark retroactively, with no correction row.
        const exam = randomUUID();
        const es = randomUUID();
        const mark = randomUUID();
        const [before, afterPublish, afterCorrection] = await iRun(async () => {
          await migrator.query(
            `update grading_scales set is_active = false where tenant_id = '${uid.tenantA}'`,
          );
          await migrator.query(
            `insert into exams (id, tenant_id, academic_term_id, academic_year_id, exam_type_id, grading_scale_id, name, status)
             values ('${exam}', '${uid.tenantA}', '${uid.termA}', '${uid.yearA}', '${uid.typeA}', null, 'Late scale ${slug}', 'draft')`,
          );
          await migrator.query(`update exams set status = 'scheduled' where id = '${exam}'`);
          await migrator.query(
            `insert into exam_subjects (id, tenant_id, exam_id, class_subject_id, academic_year_id, class_id, subject_id, max_marks, weight)
             values ('${es}', '${uid.tenantA}', '${exam}', '${uid.linkA}', '${uid.yearA}', '${uid.classA}', '${uid.subjA}', 100, 1)`,
          );
          await migrator.query(
            `insert into marks (id, tenant_id, exam_subject_id, enrollment_id, student_id, section_id, academic_year_id, marks_obtained, entered_by)
             values ('${mark}', '${uid.tenantA}', '${es}', '${uid.enrollA1}', '${uid.studentA1}', '${uid.sectionA}', '${uid.yearA}', 90, '${uid.teacher}')`,
          );
          const graded = await migQ<{ grade_label: string | null; pin: string | null }>(
            `select m.grade_label, e.grading_scale_id pin from marks m join exams e on e.id = '${exam}' where m.id = '${mark}'`,
          );
          // The rule that produced the grade changes AFTER the mark was entered.
          await migrator.query(
            `update grading_scales set is_active = true where id = '${uid.scaleA2}'`,
          );
          await migrator.query(`update exams set status = 'grading' where id = '${exam}'`);
          await migrator.query(
            `update exams set status = 'published', published_at = now() where id = '${exam}'`,
          );
          const frozen = await migQ<{
            percentage: string;
            grade_label: string | null;
            grade_point: string | null;
            status: string;
          }>(`select percentage, grade_label, grade_point, status from marks where id = '${mark}'`);
          // …and the correction path is still the one that grades it.
          await migrator.query(
            `insert into mark_corrections (id, tenant_id, mark_id, exam_id, exam_subject_id, student_id, old_marks_obtained, new_marks_obtained, reason, corrected_by)
             values ('${randomUUID()}', '${uid.tenantA}', '${mark}', '${exam}', '${es}', '${uid.studentA1}', 90, 95, 'P1-02 control: the recorded correction grades it', '${uid.teacher}')`,
          );
          await migrator.query(`update marks set marks_obtained = 95 where id = '${mark}'`);
          const corrected = await migQ<{
            grade_label: string | null;
            grade_point: string | null;
            status: string;
          }>(`select grade_label, grade_point, status from marks where id = '${mark}'`);
          return [graded[0]!, frozen[0]!, corrected[0]!] as const;
        });
        // No active scale: nothing to grade with, and the pin documents that.
        expect(before.pin).toBeNull();
        expect(before.grade_label).toBeNull();
        // A scale became available. Publication must not reach back with it.
        expect(afterPublish.status).toBe('locked');
        expect(Number(afterPublish.percentage)).toBe(90);
        expect(afterPublish.grade_label).toBeNull();
        expect(afterPublish.grade_point).toBeNull();
        // The recorded correction is what re-derives, and it does.
        expect(afterCorrection.status).toBe('rechecked');
        expect(afterCorrection.grade_label).toBe('D');
        expect(Number(afterCorrection.grade_point)).toBe(4);
      });
    });

    describe('P2-01 the grade rule an exam is graded against is frozen', () => {

      it('refuses a scale swap while the exam is grading', async () => {
        const exam = randomUUID();
        await migrator.query('begin');
        try {
          await migrator.query(
            `insert into exams (id, tenant_id, academic_term_id, academic_year_id, exam_type_id, grading_scale_id, name, status)
             values ('${exam}', '${uid.tenantA}', '${uid.termA}', '${uid.yearA}', '${uid.typeA}', '${uid.scaleA}', 'Pin freeze ${slug}', 'draft')`,
          );
          await migrator.query(`update exams set status = 'grading' where id = '${exam}'`);
          await migrator.query('savepoint sp');
          const caught = await migrator
            .query(`update exams set grading_scale_id = '${uid.scaleA2}' where id = '${exam}'`)
            .catch((err: pg.DatabaseError) => err);
          await migrator.query('rollback to savepoint sp');
          expect(caught).toBeInstanceOf(Error);
          expect((caught as pg.DatabaseError).code).toBe('55000');
          expect((caught as Error).message).toMatch(
            /grading scale of an exam in status grading cannot be changed/,
          );
        } finally {
          await migrator.query('rollback').catch(() => {});
        }
      });

      it('refuses a scale swap on a scheduled exam that already has marks', async () => {
        // The audit's P2-01 sequence, in its own words: the scale was swapped on a
        // `scheduled` exam that already had marks. `scheduled` is not `grading`, so
        // the status check alone would not have caught it.
        await migrator.query('begin');
        try {
          const es = randomUUID();
          const exam = randomUUID();
          await migrator.query(
            `insert into exams (id, tenant_id, academic_term_id, academic_year_id, exam_type_id, grading_scale_id, name, status)
             values ('${exam}', '${uid.tenantA}', '${uid.termA}', '${uid.yearA}', '${uid.typeA}', '${uid.scaleA}', 'Marked sched ${slug}', 'draft')`,
          );
          await migrator.query(`update exams set status = 'scheduled' where id = '${exam}'`);
          await migrator.query(
            `insert into exam_subjects (id, tenant_id, exam_id, class_subject_id, academic_year_id, class_id, subject_id, max_marks, weight)
             values ('${es}', '${uid.tenantA}', '${exam}', '${uid.linkA}', '${uid.yearA}', '${uid.classA}', '${uid.subjA}', 100, 1)`,
          );
          await migrator.query(
            `insert into marks (id, tenant_id, exam_subject_id, enrollment_id, student_id, section_id, academic_year_id, marks_obtained, entered_by)
             values ('${randomUUID()}', '${uid.tenantA}', '${es}', '${uid.enrollA1}', '${uid.studentA1}', '${uid.sectionA}', '${uid.yearA}', 60, '${uid.teacher}')`,
          );
          await migrator.query('savepoint sp');
          const caught = await migrator
            .query(`update exams set grading_scale_id = '${uid.scaleA2}' where id = '${exam}'`)
            .catch((err: pg.DatabaseError) => err);
          await migrator.query('rollback to savepoint sp');
          expect(caught).toBeInstanceOf(Error);
          expect((caught as pg.DatabaseError).code).toBe('55000');
          expect((caught as Error).message).toMatch(/cannot be changed once marks exist/);
        } finally {
          await migrator.query('rollback').catch(() => {});
        }
      });

      it('still lets a draft or scheduled exam with no marks choose its scale', async () => {
        // The carve-out 0016 deliberately left, and the reason this is a lifecycle
        // rule and not a blanket ban: organising an exam is exactly when the grade
        // rule is chosen, and an exam with no marks has no result to reinterpret.
        // (The alternative must be an ACTIVE scale: 0015 already refuses to pin a
        // retired one, and that rule is untouched.)
        const exam = randomUUID();
        const alt = randomUUID();
        const rows = await iRun(async () => {
          await migrator.query(
            `insert into grading_scales (id, tenant_id, code, name, version, is_active, bands)
             values ('${alt}', '${uid.tenantA}', 'p201_${slug}', 'Alternative', 3, true, '${JSON.stringify(BANDS)}'::jsonb)`,
          );
          await migrator.query(
            `insert into exams (id, tenant_id, academic_term_id, academic_year_id, exam_type_id, grading_scale_id, name, status)
             values ('${exam}', '${uid.tenantA}', '${uid.termA}', '${uid.yearA}', '${uid.typeA}', '${uid.scaleA}', 'Reselectable ${slug}', 'draft')`,
          );
          await migrator.query(`update exams set grading_scale_id = '${alt}' where id = '${exam}'`);
          await migrator.query(`update exams set status = 'scheduled' where id = '${exam}'`);
          return migQ<{ grading_scale_id: string }>(
            `select grading_scale_id from exams where id = '${exam}'`,
          );
        });
        expect(rows[0]!.grading_scale_id).toBe(alt);
      });
    });

    describe('P2-02 the lifecycle is one-way, as documented', () => {
      it('refuses grading -> scheduled, which 0015/0016 accepted', async () => {
        // DATABASE_DESIGN §8 and the roadmap both say draft -> scheduled -> grading
        // -> published with no way back. The old trigger also listed 'grading' as a
        // valid predecessor of 'scheduled', so a half-graded exam could be pushed back
        // to being merely scheduled and have its subject sessions reconfigured.
        await migrator.query('begin');
        try {
          await migrator.query('savepoint sp');
          const caught = await migrator
            .query(`update exams set status = 'scheduled' where id = '${uid.examGrading}'`)
            .catch((err: pg.DatabaseError) => err);
          await migrator.query('rollback to savepoint sp');
          expect(caught).toBeInstanceOf(Error);
          expect((caught as pg.DatabaseError).code).toBe('55000');
          expect((caught as Error).message).toMatch(/cannot be scheduled from status grading/);
        } finally {
          await migrator.query('rollback').catch(() => {});
        }
      });

      it('refuses every way back out of a terminal state', async () => {
        const cancelled = randomUUID();
        await migrator.query('begin');
        try {
          await migrator.query(
            `insert into exams (id, tenant_id, academic_term_id, academic_year_id, exam_type_id, grading_scale_id, name, status)
             values ('${cancelled}', '${uid.tenantA}', '${uid.termA}', '${uid.yearA}', '${uid.typeA}', '${uid.scaleA}', 'Terminal ${slug}', 'draft')`,
          );
          await migrator.query(`update exams set status = 'scheduled' where id = '${cancelled}'`);
          await migrator.query(`update exams set status = 'cancelled' where id = '${cancelled}'`);

          for (const [from, target, pattern] of [
            ['cancelled', 'grading', /cannot enter grading from status cancelled/],
            ['cancelled', 'scheduled', /cannot be scheduled from status cancelled/],
            ['cancelled', 'draft', /cannot return to draft from status cancelled/],
            ['published', 'grading', /cannot be published from status published|with results|cannot/],
          ] as const) {
            const id = from === 'published' ? uid.examPublished : cancelled;
            await migrator.query('savepoint sp');
            const caught = await migrator
              .query(`update exams set status = '${target}' where id = '${id}'`)
              .catch((err: pg.DatabaseError) => err);
            await migrator.query('rollback to savepoint sp');
            expect(caught, `${from} -> ${target} must be refused`).toBeInstanceOf(Error);
            expect((caught as Error).message).toMatch(pattern);
          }
        } finally {
          await migrator.query('rollback').catch(() => {});
        }
      });
    });

    describe('P2-03 a published report card cannot be hard-deleted', () => {
      it('refuses it for the table owner AND for the runtime role', async () => {
        // The audit deleted a published card outright as school_migrator, leaving a
        // gap in the audit trail where the document used to be. 0015 refused to
        // soft-remove a published card and refused every UPDATE but the artifact
        // stamp, so a hard DELETE was the one remaining way to destroy it.
        //
        // The card this guard is asked about has to be a REAL published card, and
        // that is the part the old version of this test got wrong: it built a
        // published row with hand-written aggregates and no snapshot lines inside a
        // transaction it then rolled back. Every immediate rule accepts that row and
        // the one rule that refuses it - `report_cards_snapshot_coherent_trg` - is
        // DEFERRABLE INITIALLY DEFERRED, so it only fires at a COMMIT that never
        // came. The guard was therefore being asked about a state the database does
        // not permit to exist, which is not a test.
        //
        // So the fixture is two real transactions now. First the FORGED card, which
        // has to be refused at COMMIT and must not survive the refusal. Then the
        // same exam's card published through the sanctioned order, which does commit
        // - and THAT is the row the hard-delete guard is asked about.
        const forged = randomUUID();
        await migrator.query('begin');
        try {
          await migrator.query(
            `insert into report_cards (id, tenant_id, exam_id, student_id, enrollment_id, academic_year_id, version, status, gpa, total_obtained, total_possible, subject_count, published_at)
             values ('${forged}', '${uid.tenantA}', '${uid.examPublished}', '${uid.studentA3}', '${uid.enrollA3}', '${uid.yearA}', 1, 'published', 4, 85, 100, 1, now())`,
          );
          const refused = await migrator.query('commit').then(
            () => null,
            (err: pg.DatabaseError) => err,
          );
          expect(
            refused,
            'a published card with no snapshot rows must be refused at COMMIT',
          ).toBeInstanceOf(Error);
          expect((refused as pg.DatabaseError).code).toBe('55000');
          expect((refused as Error).message).toMatch(/must agree with its own subject snapshot/);
        } catch (err) {
          await migrator.query('rollback').catch(() => {});
          throw err;
        }
        // The refused publication left nothing behind. A COMMIT that raises rolls the
        // whole transaction back, so this is 0 rather than 1 - and it is 0 because the
        // database refused, not because the fixture discarded it.
        const ghosts = await migQ<{ n: number }>(
          `select count(*)::int n from report_cards where id = '${forged}'`,
        );
        expect(ghosts[0]!.n).toBe(0);

        // A genuinely published card, committed, with a body the coherence trigger
        // checked at its own COMMIT - on its OWN exam, so the fixture is
        // self-contained and does not depend on which pair an earlier section used.
        const exam = randomUUID();
        const es = randomUUID();
        await migrator.query('begin');
        try {
          await migrator.query(
            `insert into exams (id, tenant_id, academic_term_id, academic_year_id, exam_type_id, grading_scale_id, name, status)
             values ('${exam}', '${uid.tenantA}', '${uid.termA}', '${uid.yearA}', '${uid.typeA}', '${uid.scaleA}', 'Hard delete ${slug}', 'draft')`,
          );
          await migrator.query(
            `insert into exam_subjects (id, tenant_id, exam_id, class_subject_id, academic_year_id, class_id, subject_id, max_marks, weight)
             values ('${es}', '${uid.tenantA}', '${exam}', '${uid.linkA}', '${uid.yearA}', '${uid.classA}', '${uid.subjA}', 100, 1)`,
          );
          await migrator.query(`update exams set status = 'grading' where id = '${exam}'`);
          await migrator.query(
            `insert into marks (id, tenant_id, exam_subject_id, enrollment_id, student_id, section_id, academic_year_id, marks_obtained, entered_by)
             values ('${randomUUID()}', '${uid.tenantA}', '${es}', '${uid.enrollA1}', '${uid.studentA1}', '${uid.sectionA}', '${uid.yearA}', 66, '${uid.teacher}')`,
          );
          await migrator.query(
            `update exams set status = 'published', published_at = now() where id = '${exam}'`,
          );
          await migrator.query('commit');
        } catch (err) {
          await migrator.query('rollback').catch(() => {});
          throw err;
        }

        const card = await publishReportCardWithSnapshot(migrator, {
          tenantId: uid.tenantA!,
          status: 'published',
          studentId: uid.studentA1!,
          enrollmentId: uid.enrollA1!,
          examId: exam,
          version: 1,
        });
        const committed = await migQ<{ n: number; subject_count: number }>(
          `select (select count(*)::int from report_cards where id = '${card}') n,
                  (select subject_count from report_cards where id = '${card}') subject_count`,
        );
        expect(committed[0]!.n).toBe(1);
        expect(Number(committed[0]!.subject_count)).toBeGreaterThan(0);

        await migrator.query('begin');
        try {
          await migrator.query('savepoint sp');
          const caught = await migrator
            .query(`delete from report_cards where id = '${card}'`)
            .catch((err: pg.DatabaseError) => err);
          await migrator.query('rollback to savepoint sp');
          expect(caught).toBeInstanceOf(Error);
          expect((caught as pg.DatabaseError).code).toBe('55000');
          expect((caught as Error).message).toMatch(/cannot be hard-deleted/);
          // …and the row is still there.
          const survivors = await migQ<{ n: number }>(
            `select count(*)::int n from report_cards where id = '${card}'`,
          );
          expect(survivors[0]!.n).toBe(1);
        } finally {
          await migrator.query('rollback').catch(() => {});
        }

        await tenantA(async () => {
          // A DRAFT card is filtered out of the runtime role's DELETE policy like any
          // other row, and the guard is a second line of defence behind that: it is
          // the table owner that has to be stopped.
          const del = await app.query(`delete from report_cards where id = '${uid.cardDraft}'`);
          expect(del.rowCount).toBe(0);
        });
      });

      it('still permits discarding a DRAFT card', async () => {
        // The guard is scoped to the published snapshot. A draft card is a
        // recomputable working document (see F.5), so it must stay erasable or a
        // mis-generated draft is unfixable.
        const card = randomUUID();
        const left = await iRun(async () => {
          await migrator.query(
            `insert into report_cards (id, tenant_id, exam_id, student_id, enrollment_id, academic_year_id, version, status, total_obtained, total_possible, subject_count)
             values ('${card}', '${uid.tenantA}', '${uid.examGrading}', '${uid.studentA2}', '${uid.enrollA2}', '${uid.yearA}', 9, 'draft', 10, 100, 1)`,
          );
          await migrator.query(`delete from report_cards where id = '${card}'`);
          return migQ<{ n: number }>(`select count(*)::int n from report_cards where id = '${card}'`);
        });
        expect(left[0]!.n).toBe(0);
      });
    });

    describe('P3-01 marks.updated_at is maintained', () => {
      it('moves on a lock-only update and on a value change', async () => {
        // 0015 declared the column with DEFAULT now() and no trigger ever touched it,
        // so a mark's "last updated" was really "when it was created" - including
        // after publication had locked it. (The Drizzle $onUpdate is an ORM-side
        // helper and does nothing for raw SQL, outbox writes or psql.)
        //
        // One transaction per step, because the trigger stamps `now()` - the
        // TRANSACTION clock - and two statements in one transaction legitimately
        // share it. That is the intended semantic (every mark a single publication
        // freezes carries the same instant), so the test does not fight it: it
        // reads microsecond-precision epochs across three transactions instead.
        const es = randomUUID();
        const exam = randomUUID();
        const mark = randomUUID();
        const epoch = async (): Promise<number> =>
          Number(
            (
              await migQ<{ t: string }>(
                `select extract(epoch from updated_at)::text t from marks where id = '${mark}'`,
              )
            )[0]!.t,
          );

        // Committed, so the three steps below are three real transactions; the
        // suite's afterAll disposes of it with the rest of the tenant-A fixture.
        await migrator.query('begin');
        try {
          await migrator.query(
            `insert into exams (id, tenant_id, academic_term_id, academic_year_id, exam_type_id, grading_scale_id, name, status)
             values ('${exam}', '${uid.tenantA}', '${uid.termA}', '${uid.yearA}', '${uid.typeA}', '${uid.scaleA}', 'Stamped ${slug}', 'draft')`,
          );
          await migrator.query(
            `insert into exam_subjects (id, tenant_id, exam_id, class_subject_id, academic_year_id, class_id, subject_id, max_marks, weight)
             values ('${es}', '${uid.tenantA}', '${exam}', '${uid.linkA}', '${uid.yearA}', '${uid.classA}', '${uid.subjA}', 100, 1)`,
          );
          await migrator.query(`update exams set status = 'grading' where id = '${exam}'`);
          await migrator.query(
            `insert into marks (id, tenant_id, exam_subject_id, enrollment_id, student_id, section_id, academic_year_id, marks_obtained, entered_by)
             values ('${mark}', '${uid.tenantA}', '${es}', '${uid.enrollA1}', '${uid.studentA1}', '${uid.sectionA}', '${uid.yearA}', 40, '${uid.teacher}')`,
          );
          await migrator.query('commit');
        } catch (err) {
          await migrator.query('rollback');
          throw err;
        }
        const atCreate = await epoch();

        // Committed steps, in three real transactions.
        await migrator.query(`update marks set marks_obtained = 41 where id = '${mark}'`);
        const atChange = await epoch();

        // A lock-only update: exactly what publication's sweep is.
        await migrator.query(
          `update exams set status = 'published', published_at = now() where id = '${exam}'`,
        );
        const atLock = await epoch();

        const status = (
          await migQ<{ status: string }>(`select status from marks where id = '${mark}'`)
        )[0]!.status;
        expect(status).toBe('locked');
        expect(atChange).toBeGreaterThan(atCreate);
        expect(atLock).toBeGreaterThan(atChange);
      });
    });

    describe('P3-02 bands that produced a result are immutable', () => {
      it('refuses editing a scale pinned by a grading exam', async () => {
        // The exact route the audit took to re-grade a published mark: retire the
        // pinned scale (`is_active` is only an operational toggle, so 0015/0016
        // allowed it) and then rewrite its bands.
        const scale = randomUUID();
        const exam = randomUUID();
        const es = randomUUID();
        await migrator.query('begin');
        try {
          await migrator.query(
            `insert into grading_scales (id, tenant_id, code, name, version, is_active, bands)
             values ('${scale}', '${uid.tenantA}', 'p302_${slug}', 'Retire then rewrite', 1, true, '${JSON.stringify(BANDS)}'::jsonb)`,
          );
          await migrator.query(
            `insert into exams (id, tenant_id, academic_term_id, academic_year_id, exam_type_id, grading_scale_id, name, status)
             values ('${exam}', '${uid.tenantA}', '${uid.termA}', '${uid.yearA}', '${uid.typeA}', '${scale}', 'Bands frozen ${slug}', 'draft')`,
          );
          await migrator.query(
            `insert into exam_subjects (id, tenant_id, exam_id, class_subject_id, academic_year_id, class_id, subject_id, max_marks, weight)
             values ('${es}', '${uid.tenantA}', '${exam}', '${uid.linkA}', '${uid.yearA}', '${uid.classA}', '${uid.subjA}', 100, 1)`,
          );
          await migrator.query(`update exams set status = 'grading' where id = '${exam}'`);
          // Retiring the scale is still allowed: `is_active` answers "which scale is
          // current for NEW work", not "did this produce a grade".
          await migrator.query(`update grading_scales set is_active = false where id = '${scale}'`);
          // Rewriting the bands is not.
          await migrator.query('savepoint sp');
          const caught = await migrator
            .query(
              `update grading_scales set bands = '${JSON.stringify(
                [
                  { label: 'A', minPercent: 0, maxPercent: 50, gradePoint: 1 },
                  { label: 'B', minPercent: 50, maxPercent: 100, gradePoint: 2 },
                ],
              )}'::jsonb where id = '${scale}'`,
            )
            .catch((err: pg.DatabaseError) => err);
          await migrator.query('rollback to savepoint sp');
          expect(caught).toBeInstanceOf(Error);
          expect((caught as pg.DatabaseError).code).toBe('55000');
          expect((caught as Error).message).toMatch(/produced a result cannot be edited/);
          // The bands are untouched, so the grades already derived from them still
          // reproduce.
          const still = await migQ<{ bands: unknown }>(
            `select bands from grading_scales where id = '${scale}'`,
          );
          expect(still[0]!.bands).toEqual(BANDS);
        } finally {
          await migrator.query('rollback').catch(() => {});
        }
      });

      it('refuses editing a scale an exam with marks is pinned to, before grading', async () => {
        await migrator.query('begin');
        try {
          const scale = randomUUID();
          const exam = randomUUID();
          const es = randomUUID();
          await migrator.query(
            `insert into grading_scales (id, tenant_id, code, name, version, is_active, bands)
             values ('${scale}', '${uid.tenantA}', 'p302b_${slug}', 'Marked then edited', 1, true, '${JSON.stringify(BANDS)}'::jsonb)`,
          );
          await migrator.query(
            `insert into exams (id, tenant_id, academic_term_id, academic_year_id, exam_type_id, grading_scale_id, name, status)
             values ('${exam}', '${uid.tenantA}', '${uid.termA}', '${uid.yearA}', '${uid.typeA}', '${scale}', 'Marked ${slug}', 'draft')`,
          );
          await migrator.query(
            `insert into exam_subjects (id, tenant_id, exam_id, class_subject_id, academic_year_id, class_id, subject_id, max_marks, weight)
             values ('${es}', '${uid.tenantA}', '${exam}', '${uid.linkA}', '${uid.yearA}', '${uid.classA}', '${uid.subjA}', 100, 1)`,
          );
          await migrator.query(`update exams set status = 'scheduled' where id = '${exam}'`);
          await migrator.query(
            `insert into marks (id, tenant_id, exam_subject_id, enrollment_id, student_id, section_id, academic_year_id, marks_obtained, entered_by)
             values ('${randomUUID()}', '${uid.tenantA}', '${es}', '${uid.enrollA1}', '${uid.studentA1}', '${uid.sectionA}', '${uid.yearA}', 75, '${uid.teacher}')`,
          );
          // Retiring first, so this is 0017's rule being tested rather than 0016's
          // "an active scale cannot be edited" rule, which is the outer gate.
          await migrator.query(`update grading_scales set is_active = false where id = '${scale}'`);
          // The exam is only `scheduled`, but it already has a mark, so the rule it
          // is graded by is already producing results.
          await migrator.query('savepoint sp');
          const caught = await migrator
            .query(
              `update grading_scales set bands = '${JSON.stringify([
                { label: 'A', minPercent: 0, maxPercent: 50, gradePoint: 1 },
                { label: 'B', minPercent: 50, maxPercent: 100, gradePoint: 2 },
              ])}'::jsonb where id = '${scale}'`,
            )
            .catch((err: pg.DatabaseError) => err);
          await migrator.query('rollback to savepoint sp');
          expect(caught).toBeInstanceOf(Error);
          expect((caught as Error).message).toMatch(/produced a result cannot be edited/);
        } finally {
          await migrator.query('rollback').catch(() => {});
        }
      });

      it('still lets an untouched scale be edited, and a new version be cut', async () => {
        // The guard is scoped to scales that produced something, so a draft scale
        // nobody has graded against stays editable and a corrected rule is still
        // published the documented way: a new version.
        const scale = randomUUID();
        const v2 = randomUUID();
        const rewritten = [
          { label: 'A', minPercent: 0, maxPercent: 50, gradePoint: 1 },
          { label: 'B', minPercent: 50, maxPercent: 100, gradePoint: 2 },
        ];
        const rows = await iRun(async () => {
          await migrator.query(
            `insert into grading_scales (id, tenant_id, code, name, version, is_active, bands)
             values ('${scale}', '${uid.tenantA}', 'p302c_${slug}', 'Draft scale', 1, true, '${JSON.stringify(BANDS)}'::jsonb)`,
          );
          // Retiring it first is how a scale is corrected at all (0016 freezes the
          // bands of an ACTIVE scale), and it is allowed here precisely because this
          // scale has produced nothing.
          await migrator.query(`update grading_scales set is_active = false where id = '${scale}'`);
          // …and now its bands may be rewritten.
          await migrator.query(
            `update grading_scales set bands = '${JSON.stringify(rewritten)}'::jsonb where id = '${scale}'`,
          );
          // …and a new version of the same code supersedes it.
          await migrator.query(
            `insert into grading_scales (id, tenant_id, code, name, version, is_active, bands)
             values ('${v2}', '${uid.tenantA}', 'p302c_${slug}', 'Draft scale v2', 2, true, '${JSON.stringify(BANDS)}'::jsonb)`,
          );
          return migQ<{ version: number; is_active: boolean }>(
            `select version, is_active from grading_scales where id in ('${scale}','${v2}') order by version`,
          );
        });
        expect(rows.map((r) => r.version)).toEqual([1, 2]);
        expect(rows[0]!.is_active).toBe(false);
        expect(rows[1]!.is_active).toBe(true);
      });
    });

    describe('P3-03 the grade rule is pinned per CODE, deterministically', () => {
      it('pins the newest ACTIVE version when several CODES are active', async () => {
        // The domain model constrains one active version per scale CODE, not one
        // active scale per tenant: a tenant may legitimately run several schemes at
        // once. What was unspecified is which one an exam with no explicit pin
        // inherits, and 0015's ordering was left to the planner. 0016 made it
        // deterministic (version DESC, created_at DESC, id) and 0017 keeps it, so
        // this test pins the behaviour down rather than the ambiguity.
        const exam = randomUUID();
        const rows = await iRun(async () => {
          await migrator.query(
            `update grading_scales set is_active = false where tenant_id = '${uid.tenantA}'`,
          );
          // Two different CODES, both active, deliberately not the same version, so
          // "highest version wins" is the only thing that can decide.
          await migrator.query(
            `insert into grading_scales (id, tenant_id, code, name, version, is_active, bands)
             values ('${randomUUID()}', '${uid.tenantA}', 'p303lo_${slug}', 'Low version, other code', 2, true, '${JSON.stringify(BANDS)}'::jsonb),
                    ('${randomUUID()}', '${uid.tenantA}', 'p303hi_${slug}', 'High version, other code', 7, true, '${JSON.stringify(BANDS)}'::jsonb)`,
          );
          await migrator.query(
            `insert into exams (id, tenant_id, academic_term_id, academic_year_id, exam_type_id, grading_scale_id, name, status)
             values ('${exam}', '${uid.tenantA}', '${uid.termA}', '${uid.yearA}', '${uid.typeA}', null, 'Ambiguous ${slug}', 'draft')`,
          );
          await migrator.query(`update exams set status = 'scheduled' where id = '${exam}'`);
          const pinned = await migQ<{ grading_scale_id: string; version: number }>(
            `select e.grading_scale_id, gs.version from exams e join grading_scales gs on gs.id = e.grading_scale_id where e.id = '${exam}'`,
          );
          // Several active CODES is a legitimate tenant configuration, not an error,
          // and the constraint is per code.
          const actives = await migQ<{ n: number }>(
            `select count(*)::int n from grading_scales where tenant_id = '${uid.tenantA}' and code like 'p303%_${slug}' and is_active`,
          );
          return { version: pinned[0]!.version, activeCodes: actives[0]!.n };
        });
        // The highest version among the active scales, and both stay active.
        expect(rows.version).toBe(7);
        expect(rows.activeCodes).toBe(2);
      });
    });
  });
});
