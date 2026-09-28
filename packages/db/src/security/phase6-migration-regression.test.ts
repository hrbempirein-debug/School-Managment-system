/**
 * Permanent regression test for the 0018/0019 historical backfill.
 *
 * WHY THIS EXISTS
 * 0018 rewrites history. It has to take cards that were ALREADY PUBLISHED before
 * the snapshot table existed and give them the body they never had, which means
 * running with exactly one integrity rule lifted - the publication freeze - for
 * exactly one statement. That is a narrow, deliberate exception, and "narrow and
 * deliberate" is precisely the kind of thing that rots silently: a later edit that
 * dropped the `ENABLE TRIGGER` line, or that lifted the validation trigger as well,
 * would still migrate every database and would only show up as cards that quietly
 * became editable, or as a backfill that no longer checks its own work.
 *
 * The suite that lives in phase6-exams.test.ts cannot catch that, because it runs
 * against an already-migrated database where the backfill has long since finished.
 * Reproducing the historical state is the whole job here, so this file builds it:
 * it rebuilds the disposable database from the real 0001, applies the real 0017,
 * plants a genuinely published card with no snapshot lines, and only then runs the
 * real 0018 and 0019 through the real migration runner.
 *
 * THE NEGATIVE CONTROL IS THE POINT
 * A test that only ever runs correct code proves nothing about whether it can fail.
 * So before the real run, the same fixture is migrated with a doctored 0018 - the
 * real file with its trigger-restoration line removed - and the run is REQUIRED to
 * abort. If that doctored migration were to succeed, this test fails, which means a
 * future edit that weakens 0018 cannot leave this suite green.
 *
 * Opt-in: RUN_RUNTIME_SECURITY_TESTS=1. Runs ONLY on the disposable database
 * resolved by @sms/db/src/testing/runtime-db.ts, whose name is asserted to be a
 * throwaway before a single statement runs - see that module for why there is no
 * override. It rebuilds that database from scratch and leaves it fully migrated, so
 * it must not run at the same time as another suite using the same database (the
 * package's vitest config sets `fileParallelism: false` for exactly this reason).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { applyMigrations } from '../cli/migrate.js';
import { migrationsDir } from '../cli/paths.js';
import { assertDisposableTestDatabase, databaseNameOf } from '../testing/runtime-db.js';

const enabled = process.env.RUN_RUNTIME_SECURITY_TESTS === '1';
const describeDb = enabled ? describe : describe.skip;

/** 0018 and 0019, by prefix, so the file is selected independently of its title. */
const M18 = '0018_phase6_final_result_snapshot_integrity.sql';
const M19 = '0019_phase6_report_card_snapshot_reconciliation.sql';

/** The real migrations numbered up to and including `n` - "the state before n+1". */
const upTo = (n: number) => (f: string): boolean => {
  const num = Number(f.slice(0, f.indexOf('_')));
  return Number.isInteger(num) && num <= n;
};

/**
 * The line that restores the freeze after the backfill. Removing this one line is
 * the negative control: the file still migrates every row, it just leaves a
 * published result's body editable by any privileged session afterwards.
 */
const RESTORE_FREEZE =
  'ALTER TABLE report_card_subjects ENABLE TRIGGER report_card_subjects_freeze_trg;';

describeDb('Phase 6 migration regression: 0018/0019 backfill a real pre-0018 database', () => {
  const slug = 'mig' + randomUUID().slice(0, 8);
  /** Codes are constrained to ^[a-z0-9_]{1,32}$, so the slug is used without dashes. */
  const code = (prefix: string): string => `${prefix}_${slug}`;
  const uid = {
    tenant: randomUUID(),
    user: randomUUID(),
    membership: randomUUID(),
    campus: randomUUID(),
    year: randomUUID(),
    term: randomUUID(),
    level: randomUUID(),
    subject: randomUUID(),
    class: randomUUID(),
    section: randomUUID(),
    link: randomUUID(),
    student: randomUUID(),
    enroll: randomUUID(),
    type: randomUUID(),
    scale: randomUUID(),
    exam: randomUUID(),
    es: randomUUID(),
    mark: randomUUID(),
    card: randomUUID(),
  };

  /** Bands tiling 0..100 so the published card's aggregate is derivable. */
  const BANDS = [
    { label: 'A', minPercent: 0, maxPercent: 40, gradePoint: 1 },
    { label: 'B', minPercent: 40, maxPercent: 60, gradePoint: 2 },
    { label: 'C', minPercent: 60, maxPercent: 80, gradePoint: 3 },
    { label: 'D', minPercent: 80, maxPercent: 100, gradePoint: 4 },
  ];

  let url = '';
  let dbName = '';
  let mig: pg.Client;
  const scratchDirs: string[] = [];

  const q = async <T extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    params: unknown[] = [],
  ): Promise<T[]> => (await mig.query<T>(text, params)).rows;

  const one = async <T extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    params: unknown[] = [],
  ): Promise<T> => {
    const rows = await q<T>(text, params);
    expect(rows.length, `expected exactly one row from: ${text.slice(0, 60)}`).toBe(1);
    return rows[0]!;
  };

  const num = (v: unknown): number => Number(v);

  /**
   * Counts that must be identical before and after a reconciliation-only migration.
   *
   * A table that does not exist yet is recorded as `null` rather than 0, so "absent"
   * and "present but empty" stay distinguishable - the whole point of the
   * pre-0018 state is that the snapshot table is absent, not empty.
   */
  const fingerprint = async (): Promise<Record<string, number | null>> => {
    const out: Record<string, number | null> = {};
    for (const t of [
      'tenants',
      'users',
      'students',
      'enrollments',
      'subjects',
      'exam_subjects',
      'exams',
      'marks',
      'report_cards',
      'report_card_subjects',
    ]) {
      const exists = await mig
        .query(`select 1 from pg_class where oid = $1::regclass`, [t])
        .then((r) => r.rowCount === 1)
        .catch(() => false);
      out[t] = exists
        ? num((await one<{ n: number }>(`select count(*)::int n from ${t}`)).n)
        : null;
    }
    return out;
  };

  /** `tgenabled` for a report_card_subjects trigger, or null if the table is gone. */
  const triggerState = async (name: string): Promise<string | null> => {
    const present = await mig
      .query(`select 1 from pg_class where oid = 'report_card_subjects'::regclass`)
      .then((r) => r.rowCount === 1)
      .catch(() => false);
    if (!present) return null;
    const row = await one<{ tgenabled: string }>(
      `select tgenabled from pg_trigger where tgrelid = 'report_card_subjects'::regclass and tgname = $1`,
      [name],
    );
    return row.tgenabled;
  };

  /** True when `report_card_subjects` exists. */
  const snapshotTableExists = async (): Promise<boolean> =>
    mig
      .query(`select 1 from pg_class where oid = 'report_card_subjects'::regclass`)
      .then((r) => r.rowCount === 1)
      .catch(() => false);

  /**
   * Materialise a migration directory. `upTo` selects the real files by prefix;
   * `override` replaces one of them with doctored text.
   */
  const stageDir = async (
    label: string,
    pick: (f: string) => boolean,
    override?: { file: string; sql: string },
  ): Promise<string> => {
    const dir = await mkdtemp(path.join(tmpdir(), `sms-mig-${label}-`));
    scratchDirs.push(dir);
    const files = (await readdir(migrationsDir))
      .filter(pick)
      .sort();
    for (const f of files) {
      const text = override && f === override.file ? override.sql : await readFile(path.join(migrationsDir, f), 'utf8');
      await writeFile(path.join(dir, f), text, 'utf8');
    }
    if (override && !files.includes(override.file)) {
      await writeFile(path.join(dir, override.file), override.sql, 'utf8');
    }
    return dir;
  };

  /** A published card with no snapshot lines: the world as it was before 0018. */
  const seedPre0018World = async (): Promise<void> => {
    await q(`insert into tenants (id, slug, name) values ($1,$2,$3)`, [uid.tenant, slug, 'Mig Regression']);
    await q(`insert into users (id, email) values ($1,$2)`, [uid.user, `t-${slug}@example.test`]);
    // A mark may only be entered by an active member of the tenant, so the fixture
    // carries a real membership rather than a privileged bypass.
    await q(`insert into memberships (id, tenant_id, user_id, status) values ($1,$2,$3,'active')`, [uid.membership, uid.tenant, uid.user]);
    await q(`insert into campuses (id, tenant_id, code, name, status) values ($1,$2,$3,$4,'active')`, [uid.campus, uid.tenant, code('campus'), 'Campus']);
    await q(`insert into academic_years (id, tenant_id, code, name, starts_on, ends_on, status) values ($1,$2,$3,$4,'2026-01-01','2026-12-31','active')`, [uid.year, uid.tenant, code('year'), 'Year']);
    await q(`insert into academic_terms (id, tenant_id, academic_year_id, code, name, sequence, starts_on, ends_on, status) values ($1,$2,$3,$4,$5,1,'2026-01-01','2026-06-30','open')`, [uid.term, uid.tenant, uid.year, code('term'), 'Term']);
    await q(`insert into grade_levels (id, tenant_id, code, name, status) values ($1,$2,$3,$4,'active')`, [uid.level, uid.tenant, code('grade'), 'Grade']);
    await q(`insert into acd_classes (id, tenant_id, campus_id, academic_year_id, grade_level_id, code, name, status) values ($1,$2,$3,$4,$5,$6,$7,'active')`, [uid.class, uid.tenant, uid.campus, uid.year, uid.level, code('class'), 'Class']);
    await q(`insert into sections (id, tenant_id, class_id, campus_id, academic_year_id, code, status) values ($1,$2,$3,$4,$5,$6,'active')`, [uid.section, uid.tenant, uid.class, uid.campus, uid.year, code('sect')]);
    await q(`insert into subjects (id, tenant_id, code, name, status) values ($1,$2,$3,$4,'active')`, [uid.subject, uid.tenant, code('subj'), 'Science']);
    await q(`insert into class_subjects (id, tenant_id, class_id, subject_id, campus_id, academic_year_id) values ($1,$2,$3,$4,$5,$6)`, [uid.link, uid.tenant, uid.class, uid.subject, uid.campus, uid.year]);
    await q(`insert into students (id, tenant_id, student_no, first_name, last_name, status, primary_campus_id) values ($1,$2,$3,'Ada','Lovelace','active',$4)`, [uid.student, uid.tenant, code('stu'), uid.campus]);
    await q(`insert into enrollments (id, tenant_id, student_id, academic_year_id, class_id, section_id, roll_no, status) values ($1,$2,$3,$4,$5,$6,'01','active')`, [uid.enroll, uid.tenant, uid.student, uid.year, uid.class, uid.section]);
    await q(`insert into exam_types (id, tenant_id, code, name) values ($1,$2,$3,$4)`, [uid.type, uid.tenant, code('mtype'), 'Midterm']);
    await q(`insert into grading_scales (id, tenant_id, code, name, version, is_active, bands) values ($1,$2,$3,$4,1,true,$5::jsonb)`, [uid.scale, uid.tenant, code('scale'), 'Standard', JSON.stringify(BANDS)]);

    // The exam walks the real lifecycle: draft -> grading (marks may only be
    // entered here) -> published (which freezes the mark's derived values).
    await q(`insert into exams (id, tenant_id, academic_term_id, academic_year_id, exam_type_id, name, status, grading_scale_id) values ($1,$2,$3,$4,$5,$6,'draft',$7)`, [uid.exam, uid.tenant, uid.term, uid.year, uid.type, `Exam ${slug}`, uid.scale]);
    await q(`insert into exam_subjects (id, tenant_id, exam_id, class_subject_id, academic_year_id, class_id, subject_id, max_marks, weight) values ($1,$2,$3,$4,$5,$6,$7,100,1)`, [uid.es, uid.tenant, uid.exam, uid.link, uid.year, uid.class, uid.subject]);
    await q(`update exams set status = 'grading' where id = $1`, [uid.exam]);
    await q(`insert into marks (id, tenant_id, exam_subject_id, enrollment_id, student_id, section_id, academic_year_id, marks_obtained, percentage, grade_label, grade_point, status, entered_by) values ($1,$2,$3,$4,$5,$6,$7,72,72,'C',3,'provisional',$8)`, [uid.mark, uid.tenant, uid.es, uid.enroll, uid.student, uid.section, uid.year, uid.user]);
    await q(`update exams set status = 'published', published_at = now() where id = $1`, [uid.exam]);

    // The card is published through the pre-0018 order: a draft row, the aggregate,
    // then publication. There is no snapshot table to write, which is exactly the
    // gap 0018 exists to close.
    await q(`insert into report_cards (id, tenant_id, exam_id, student_id, enrollment_id, academic_year_id, version, status, gpa, total_obtained, total_possible, subject_count) values ($1,$2,$3,$4,$5,$6,1,'draft',3,72,100,1)`, [uid.card, uid.tenant, uid.exam, uid.student, uid.enroll, uid.year]);
    await q(`update report_cards set status = 'published', published_at = now() where id = $1`, [uid.card]);
  };

  beforeAll(async () => {
    const testUrl = process.env.DATABASE_URL_TEST?.trim();
    const migratorSource = process.env.DATABASE_URL_MIGRATOR?.trim();
    expect(testUrl, 'DATABASE_URL_TEST is required').toBeTruthy();
    expect(migratorSource, 'DATABASE_URL_MIGRATOR is required').toBeTruthy();
    dbName = assertDisposableTestDatabase(databaseNameOf(testUrl!));

    // Same credentials, this database.
    const slash = migratorSource!.split('?')[0]!.indexOf('/', migratorSource!.indexOf('://') + 3);
    url = `${migratorSource!.split('?')[0]!.slice(0, slash)}/${encodeURIComponent(dbName)}`;
    assertDisposableTestDatabase(databaseNameOf(url));

    mig = new pg.Client({ connectionString: url });
    await mig.connect();

    // Rebuild from nothing. The migration role owns this database and its public
    // schema, so this needs no CREATEDB and no superuser - and it is what makes the
    // "before" state real rather than simulated.
    await mig.query('drop schema public cascade');
    await mig.query('create schema public');
  });

  afterAll(async () => {
    for (const d of scratchDirs) await rm(d, { recursive: true, force: true });
    // Leave behind exactly what was found on entry: an empty, fully-migrated
    // database. Re-applying the migrations alone would leave this file's own
    // fixture behind for the next suite to trip over, and a leftover tenant is
    // precisely the kind of cross-run contamination this workspace has been bitten
    // by before.
    try {
      await mig.query('drop schema public cascade');
      await mig.query('create schema public');
      await applyMigrations(url, migrationsDir);
    } catch {
      /* the suite's own assertions already reported any failure */
    }
    await mig?.end().catch(() => undefined);
  });

  it('reproduces the pre-0018 world: a published card with no snapshot lines', async () => {
    const dir = await stageDir('pre0018', upTo(17));
    const res = await applyMigrations(url, dir);
    expect(res.applied).toHaveLength(17);

    await seedPre0018World();

    const card = await one<{ status: string; total_obtained: string; gpa: string }>(
      `select status, total_obtained, gpa from report_cards where id = $1`,
      [uid.card],
    );
    expect(card.status).toBe('published');
    expect(num(card.total_obtained)).toBe(72);
    expect(num(card.gpa)).toBe(3);

    // The table does not exist yet - this is the state 0018 has to cope with.
    await expect(
      mig.query(`select 1 from report_card_subjects`),
    ).rejects.toThrow(/does not exist/);
  });

  it('REFUSES a 0018 that forgets to restore the freeze (negative control)', async () => {
    const before = await fingerprint();

    const real18 = await readFile(path.join(migrationsDir, M18), 'utf8');
    expect(real18, 'the freeze restoration line this control removes must exist').toContain(RESTORE_FREEZE);
    const broken = real18.replace(RESTORE_FREEZE, '-- (removed by the negative control)');

    const dir = await stageDir('broken18', upTo(18), { file: M18, sql: broken });
    const err = await applyMigrations(url, dir).then(
      () => null,
      (e: Error) => e,
    );

    // The doctored migration MUST fail. If it ever succeeds, this suite can no
    // longer tell a correct 0018 from a weakened one, and that is a test failure.
    expect(err, 'a 0018 that never re-enables the freeze must abort').toBeInstanceOf(Error);
    expect(err!.message).toContain('post-backfill assertion failed');
    expect(err!.message).toContain('report_card_subjects_freeze_trg');

    // The runner wrapped the file in one transaction, so the abort took the whole
    // migration with it: the table 0018 created is gone again, the backfilled rows
    // went with it, and the journal never learned the file existed. Nothing is left
    // half-applied, which is what makes "the freeze is restored" a property of the
    // transaction rather than a promise.
    expect(await fingerprint()).toEqual(before);
    expect(await snapshotTableExists()).toBe(false);
    expect(await triggerState('report_card_subjects_freeze_trg')).toBeNull();
    const journal = await q<{ version: string }>(`select version from schema_migrations where version = $1`, [M18]);
    expect(journal).toHaveLength(0);
  });

  it('backfills the historical card and leaves every integrity rule armed', async () => {
    const before = await fingerprint();

    // The real runner, the real files, from 0018 onwards.
    const res = await applyMigrations(url, migrationsDir);
    expect(res.applied).toEqual([M18, M19]);

    // --- 1. the card now has the body it never had, one line per mark ---
    const lines = await q<{
      exam_subject_id: string;
      subject_name: string;
      marks_obtained: string;
      max_marks: string;
      weight: string;
      percentage: string;
      grade_label: string;
      grade_point: string;
    }>(
      `select exam_subject_id, subject_name, marks_obtained, max_marks, weight, percentage, grade_label, grade_point
         from report_card_subjects where report_card_id = $1 order by exam_subject_id`,
      [uid.card],
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]!.exam_subject_id).toBe(uid.es);
    expect(lines[0]!.subject_name).toBe('Science');
    // The copies ARE copies, and the derived grade is the mark's own.
    expect(num(lines[0]!.marks_obtained)).toBe(72);
    expect(num(lines[0]!.max_marks)).toBe(100);
    expect(num(lines[0]!.weight)).toBe(1);
    expect(num(lines[0]!.percentage)).toBe(72);
    expect(lines[0]!.grade_label).toBe('C');
    expect(num(lines[0]!.grade_point)).toBe(3);

    // --- 2. the line describes the card's OWN exam, not a sibling's ---
    const es = await one<{ exam_id: string }>(`select exam_id from exam_subjects where id = $1`, [uid.es]);
    const card = await one<{ exam_id: string; status: string }>(
      `select exam_id, status from report_cards where id = $1`,
      [uid.card],
    );
    expect(card.status).toBe('published');
    expect(es.exam_id).toBe(card.exam_id);

    // --- 3. the stored aggregate agrees with the snapshot it was reconciled to ---
    const totals = await one<{ total_obtained: string; total_possible: string; subject_count: number; gpa: string }>(
      `select * from fn_report_card_totals($1, $2) t`,
      [uid.tenant, uid.card],
    );
    const card2 = await one<{ total_obtained: string; total_possible: string; subject_count: number; gpa: string }>(
      `select total_obtained, total_possible, subject_count, gpa from report_cards where id = $1`,
      [uid.card],
    );
    expect(num(card2.total_obtained)).toBe(num(totals.total_obtained));
    expect(num(card2.total_possible)).toBe(num(totals.total_possible));
    expect(num(card2.subject_count)).toBe(num(totals.subject_count));
    expect(num(card2.gpa)).toBe(num(totals.gpa));
    // An uncorrected card's aggregate is a no-op for the reconciliation.
    expect(num(card2.total_obtained)).toBe(72);

    // --- 4. no data was lost ---
    const after = await fingerprint();
    expect(after['tenants']).toBe(before['tenants']);
    expect(after['students']).toBe(before['students']);
    expect(after['enrollments']).toBe(before['enrollments']);
    expect(after['marks']).toBe(before['marks']);
    expect(after['exams']).toBe(before['exams']);
    expect(after['exam_subjects']).toBe(before['exam_subjects']);
    expect(after['report_cards']).toBe(before['report_cards']);
    // The snapshot table did not exist a moment ago, and now holds exactly the one
    // historical card's line.
    expect(before['report_card_subjects']).toBeNull();
    expect(after['report_card_subjects']).toBe(1);

    // --- 5. both triggers are armed, and the freeze has no privileged backdoor ---
    expect(await triggerState('report_card_subjects_freeze_trg')).toBe('O');
    expect(await triggerState('report_card_subjects_validate_trg')).toBe('O');

    const rls = await one<{ rls: boolean; force: boolean }>(
      `select relrowsecurity rls, relforcerowsecurity force from pg_class where oid = 'report_card_subjects'::regclass`,
    );
    expect(rls.rls).toBe(true);
    expect(rls.force).toBe(true);

    // This runs as the migration role - the TABLE OWNER, which holds every grant -
    // and is still refused. A privileged backdoor here is the exact failure 0018's
    // split was built to make impossible.
    await expect(
      mig.query(`update report_card_subjects set marks_obtained = 1 where report_card_id = $1`, [uid.card]),
    ).rejects.toThrow(/frozen/);
    await expect(
      mig.query(`delete from report_card_subjects where report_card_id = $1`, [uid.card]),
    ).rejects.toThrow(/frozen/);
    const stillThere = await one<{ marks_obtained: string }>(
      `select marks_obtained from report_card_subjects where report_card_id = $1`,
      [uid.card],
    );
    expect(num(stillThere.marks_obtained)).toBe(72);

    // --- 6. the journal records both files, once each ---
    const j = await q<{ version: string; n: string }>(
      `select version, count(*)::text n from schema_migrations where version in ($1,$2) group by version order by version`,
      [M18, M19],
    );
    expect(j.map((r) => r.version)).toEqual([M18, M19]);
    expect(j.every((r) => r.n === '1')).toBe(true);
  });

  it('re-running the migrations is a no-op that changes nothing', async () => {
    const before = await fingerprint();
    const res = await applyMigrations(url, migrationsDir);
    expect(res.applied).toEqual([]);
    expect(res.skipped).toHaveLength(19);
    expect(await fingerprint()).toEqual(before);
  });

  it('leaves a DRAFT card writable, which is the property that justified the exception', async () => {
    // 0018 could only backfill history because the freeze does not reach a draft -
    // a new card is built line-by-line in exactly that state. Proving the draft is
    // still writable after the migration is therefore what makes the backfill's
    // one-statement exception the narrowest possible: the ordinary path needs no
    // exemption at all, and only unreachable history did.
    const card2 = randomUUID();
    await q(
      `insert into report_cards (id, tenant_id, exam_id, student_id, enrollment_id, academic_year_id, version, status, gpa, total_obtained, total_possible, subject_count)
       values ($1,$2,$3,$4,$5,$6,2,'draft',3,72,100,0)`,
      [card2, uid.tenant, uid.exam, uid.student, uid.enroll, uid.year],
    );
    await q(
      `insert into report_card_subjects (tenant_id, report_card_id, exam_subject_id, subject_id, subject_name, marks_obtained, max_marks, weight, percentage, grade_label, grade_point)
       values ($1,$2,$3,$4,'Science',72,100,1,72,'C',3)`,
      [uid.tenant, card2, uid.es, uid.subject],
    );
    const totals = await one<{ total_obtained: string; subject_count: number }>(
      `select * from fn_report_card_totals($1,$2) t`,
      [uid.tenant, card2],
    );
    expect(num(totals.total_obtained)).toBe(72);
    expect(num(totals.subject_count)).toBe(1);

    await q(`delete from report_card_subjects where report_card_id = $1`, [card2]);
    await q(`delete from report_cards where id = $1`, [card2]);
  });
});
