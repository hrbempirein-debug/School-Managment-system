import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pg from 'pg';
import type { Job } from 'bullmq';
import { drizzle } from 'drizzle-orm/node-postgres';
import { getEnv } from '@sms/config';
import { createDb, schema, withGuc, type Db, type Tx } from '@sms/db';
import { FsStorageProvider, type StorageProvider } from '@sms/storage';
import type { JobPayload, OutboxEvent } from '@sms/contracts';
import { buildHandlers, processEvent, runEventHandler } from './worker.js';
import { processReportCardJob } from './exams.js';

/**
 * Phase 8 D3 proof — cross-tenant isolation of the worker, asserted at RUNTIME
 * against the disposable test database (school_saas_test).
 *
 * Every category of database operation a worker handler can perform is exercised
 * through the PRODUCTION entry points (`runEventHandler`, `processEvent`, the
 * reports-queue wrapper around `processReportCardJob`):
 *   READ   -> attendance.marked (late-notification stub)
 *   UPDATE -> promotion.batch.execute
 *   DELETE -> exam.result.compute (report_card_subjects replace)
 *   UPSERT -> report.studentReportCard (files insert onConflictDoNothing)
 *
 * Each test asserts BOTH an effect (the target row is untouched / the owner's row
 * is touched) AND a statement-level invariant (drizzle query recorder: no
 * captured statement ever binds the other tenant's tenant_id, and the mutation
 * statement for the category never appears on a cross-tenant attempt).
 *
 * Isolation here is DATA-based: the worker runs as the trusted executor with
 * `app.rls` cleared (`withGuc({system:true})`), so RLS is NOT the boundary — the
 * boundary is that every query predicate carries the event's tenant. That fact and
 * its `school_worker_rw` hardening follow-up are asserted/document here, not
 * papered over.
 *
 * Opt-in: RUN_RUNTIME_SECURITY_TESTS=1 (disposable database only).
 */
const enabled = process.env.RUN_RUNTIME_SECURITY_TESTS === '1';
const describeDb = enabled ? describe : describe.skip;

const noop = (): void => undefined;

interface Captured {
  text: string;
  params: unknown[];
}

describeDb('D3 worker cross-tenant isolation (disposable test database)', () => {
  let pool: pg.Pool;
  let migrator: pg.Client;
  let storage: StorageProvider;
  let storageRoot: string;

  const captured: Captured[] = [];
  let recDb: Db;

  const state = {
    A: createFixtureUids('A'),
    B: createFixtureUids('B'),
  };

  const tenantIds = [state.A.tenant, state.B.tenant];
  const otherTenant = (forTenant: 'A' | 'B'): string =>
    (forTenant === 'A' ? state.B : state.A).tenant;
  const slug = 'd3' + Math.abs(Math.random() * 0xffffff).toString(16).slice(0, 6);
  const guardianEmail = (forTenant: 'A' | 'B'): string =>
    `g-${state[forTenant].date.slice(-2)}-${slug}@example.com`;

  const handlers = buildHandlers(noop);

  const rows = async <T extends pg.QueryResultRow>(text: string): Promise<T[]> =>
    migrator.query<T>(text).then((r) => r.rows);

  beforeAll(async () => {
    const env = getEnv();
    const created = createDb({ url: env.DATABASE_URL_MIGRATOR });
    pool = created.pool;
    recDb = drizzle(pool, {
      schema,
      logger: {
        logQuery: (text, params) => captured.push({ text, params }),
      },
    });
    migrator = new pg.Client({ connectionString: env.DATABASE_URL_MIGRATOR });
    await migrator.connect();

    storageRoot = mkdtempSync(path.join(tmpdir(), 'd3-storage-'));
    storage = new FsStorageProvider(storageRoot);

    await migrator.query('begin');
    await seedTenant(migrator, state.A, slug);
    await seedTenant(migrator, state.B, slug);
    await migrator.query('commit');
  });

  afterAll(async () => {
    try {
      await migrator.query('begin');
      await migrator.query('alter table marks disable trigger marks_delete_guard_trg');
      await migrator.query('alter table mark_corrections disable trigger mark_corrections_append_only_trg');
      await migrator.query('alter table report_cards disable trigger report_cards_hard_delete_guard_trg');
      await migrator.query('alter table report_card_subjects disable trigger report_card_subjects_freeze_trg');
      const t = tenantIds.map((id) => `'${id}'`).join(',');
      for (const table of [
        'promotion_items',
        'promotion_batches',
        'attendance_days',
        'leave_requests',
        'student_documents',
        'student_import_rows',
        'student_imports',
        'student_guardians',
        'guardians',
        'mark_corrections',
        'report_card_subjects',
        'report_cards',
        'marks',
        'files',
        'exam_schedules',
        'exam_subjects',
        'exams',
        'exam_types',
        'grading_scales',
        'teacher_assignments',
        'class_subjects',
        'enrollments',
        'sections',
        'acd_classes',
        'students',
        'grade_levels',
        'subjects',
        'academic_terms',
        'academic_years',
        'campuses',
        'outbox_events',
        'audit_logs',
      ]) {
        await migrator.query(`delete from ${table} where tenant_id in (${t})`);
      }
      await migrator.query('alter table marks enable trigger marks_delete_guard_trg');
      await migrator.query('alter table mark_corrections enable trigger mark_corrections_append_only_trg');
      await migrator.query('alter table report_cards enable trigger report_cards_hard_delete_guard_trg');
      await migrator.query('alter table report_card_subjects enable trigger report_card_subjects_freeze_trg');
      await migrator.query('commit');

      await migrator.query(
        `delete from role_permissions where role_id in (select id from roles where tenant_id in (${t}))`,
      );
      await migrator.query(
        `delete from membership_roles where membership_id in (select id from memberships where tenant_id in (${t}))`,
      );
      await migrator.query(`delete from memberships where tenant_id in (${t})`);
      await migrator.query(`delete from roles where tenant_id in (${t})`);
      await migrator.query(
        `delete from users where email like '%${slug}@example.com'`,
      );
      await migrator.query(`delete from tenants where id in (${t})`);
    } finally {
      await migrator.end();
      await pool.end();
      rmSync(storageRoot, { recursive: true, force: true });
    }
  });

  // ------------------------------------------------------------------ helpers

  const makeEvent = (
    tenantId: string,
    partial: {
      eventType: OutboxEvent['eventType'];
      aggregateType: string;
      aggregateId: string;
      payload: Record<string, unknown>;
    },
  ): OutboxEvent => ({
    version: 1,
    id: randomUUID(),
    tenantId,
    eventType: partial.eventType,
    aggregateType: partial.aggregateType,
    aggregateId: partial.aggregateId,
    payload: { tenantId, ...partial.payload },
    correlationId: randomUUID(),
    causationId: null,
    createdAt: new Date().toISOString(),
  });

  /** Production handler runner; captures drizzle SQL so the run can be audited. */
  const run = async (event: OutboxEvent): Promise<{ deferred: JobPayload[] }> => {
    captured.length = 0;
    const deferred = await runEventHandler(recDb, event, handlers);
    return { deferred };
  };

  const lastRunStatements = (): Captured[] => [...captured];

  const paramsInclude = (value: string): boolean =>
    captured.some((s) => s.params.some((p) => p === value || String(p) === value));

  const anyStatementLike = (re: RegExp): boolean =>
    captured.some((s) => re.test(s.text));

  const statementsLike = (re: RegExp): string[] =>
    captured.filter((s) => re.test(s.text)).map((s) => s.text);

  const cardOf = async (tenantId: string, studentId: string) =>
    (
      await rows<{ id: string; file_id: string | null }>(
        `select id, file_id from report_cards
          where tenant_id = '${tenantId}' and student_id = '${studentId}' and deleted_at is null`,
      )
    )[0];

  const cardLines = async (cardId: string) =>
    rows<{ subject_name: string; marks_obtained: string | null }>(
      `select subject_name, marks_obtained from report_card_subjects
        where report_card_id = '${cardId}' order by subject_name`,
    );

  // ------------------------------------------------------------------ READ

  describe('R1 READ — attendance.marked late-notification stub', () => {
    it('same-tenant control: a Tenant-A late row resolves to Tenant-A guardians', async () => {
      const event = makeEvent(state.A.tenant, {
        eventType: 'attendance.marked',
        aggregateType: 'attendance_day',
        aggregateId: state.A.attendanceDay,
        payload: { attendanceDate: state.A.date },
      });
      const { deferred } = await run(event);
      expect(deferred.length).toBeGreaterThan(0);
      const emails = deferred.map((j) => (j.data as { to: string }).to);
      expect(emails).toContain(guardianEmail('A'));
      expect(paramsInclude(state.B.tenant)).toBe(false);
      expect(anyStatementLike(/attendance_days/i)).toBe(true);
    });

    it('same-tenant control: a Tenant-B late row resolves to Tenant-B guardians', async () => {
      const event = makeEvent(state.B.tenant, {
        eventType: 'attendance.marked',
        aggregateType: 'attendance_day',
        aggregateId: state.B.attendanceDay,
        payload: { attendanceDate: state.B.date },
      });
      const { deferred } = await run(event);
      expect(deferred.length).toBeGreaterThan(0);
      const emails = deferred.map((j) => (j.data as { to: string }).to);
      expect(emails).toContain(guardianEmail('B'));
      expect(paramsInclude(state.A.tenant)).toBe(false);
    });

    it('NEGATIVE: a Tenant-A event on a date only Tenant-B marked reads ZERO Tenant-B rows', async () => {
      const event = makeEvent(state.A.tenant, {
        eventType: 'attendance.marked',
        aggregateType: 'attendance_day',
        aggregateId: state.B.attendanceDay,
        payload: { attendanceDate: state.B.date },
      });
      const { deferred } = await run(event);
      expect(deferred).toHaveLength(0);
      // The only statements issued were tenant-A-scoped; Tenant-B's tenant_id was
      // never bound to any query — B's late row (proven readable above by B
      // itself) was not read.
      expect(paramsInclude(state.B.tenant)).toBe(false);
      const reads = statementsLike(/from "attendance_days"/i);
      expect(reads.length).toBe(1);
      expect(reads[0]).toContain('"tenant_id"');
    });
  });

  // ------------------------------------------------------------------ UPDATE

  describe('U1 UPDATE — promotion.batch.execute', () => {
    it('same-tenant control: a Tenant-A event completes Tenant-A batch and enrolls its student', async () => {
      const event = makeEvent(state.A.tenant, {
        eventType: 'promotion.batch.execute',
        aggregateType: 'promotion_batch',
        aggregateId: state.A.batch,
        payload: { batchId: state.A.batch },
      });
      const { deferred } = await run(event);

      const batch = (
        await rows<{ status: string }>(
          `select status from promotion_batches where id = '${state.A.batch}'`,
        )
      )[0]!.status;
      expect(batch).toBe('completed');
      const item = (
        await rows<{ status: string }>(
          `select status from promotion_items where id = '${state.A.item}'`,
        )
      )[0]!.status;
      expect(item).toBe('promoted');
      const enrollment = await rows(
        `select id from enrollments
          where tenant_id = '${state.A.tenant}' and student_id = '${state.A.student1}'
            and academic_year_id = '${state.A.year2}' and deleted_at is null`,
      );
      expect(enrollment.length).toBe(1);
      expect(paramsInclude(state.B.tenant)).toBe(false);
      // The completion update was scoped to Tenant A's batch by id within the
      // tenant's row set.
      expect(anyStatementLike(/update "promotion_batches"/i)).toBe(true);
    });

    it('NEGATIVE: a Tenant-A event targeting Tenant-B batch mutates nothing and issues no UPDATE', async () => {
      const before = {
        batch: (
          await rows<{ status: string }>(
            `select status from promotion_batches where id = '${state.B.batch}'`,
          )
        )[0]!.status,
        item: (
          await rows<{ status: string }>(
            `select status from promotion_items where id = '${state.B.item}'`,
          )
        )[0]!.status,
        enrollments: await rows(
          `select id from enrollments
            where tenant_id = '${state.B.tenant}' and student_id = '${state.B.student1}'
              and academic_year_id = '${state.B.year2}' and deleted_at is null`,
        ),
      };

      const event = makeEvent(state.A.tenant, {
        eventType: 'promotion.batch.execute',
        aggregateType: 'promotion_batch',
        aggregateId: state.B.batch,
        payload: { batchId: state.B.batch },
      });
      const { deferred } = await run(event);
      expect(deferred).toHaveLength(0);

      const after = {
        batch: (
          await rows<{ status: string }>(
            `select status from promotion_batches where id = '${state.B.batch}'`,
          )
        )[0]!.status,
        item: (
          await rows<{ status: string }>(
            `select status from promotion_items where id = '${state.B.item}'`,
          )
        )[0]!.status,
        enrollments: await rows(
          `select id from enrollments
            where tenant_id = '${state.B.tenant}' and student_id = '${state.B.student1}'
              and academic_year_id = '${state.B.year2}' and deleted_at is null`,
        ),
      };

      expect(after.batch).toBe(before.batch);
      expect(after.item).toBe(before.item);
      expect(after.enrollments).toHaveLength(before.enrollments.length);
      // Defence-in-depth gap documented in the report: promotion_items / batch
      // UPDATEs carry no tenant predicate, so the strongest cross-tenant claim is
      // that the batch is FIRST read tenant-scoped and therefore cannot be found.
      expect(paramsInclude(state.B.tenant)).toBe(false);
      expect(anyStatementLike(/update "promotion_batches"/i)).toBe(false);
      expect(anyStatementLike(/update "promotion_items"/i)).toBe(false);
      expect(anyStatementLike(/insert into "enrollments"/i)).toBe(false);
    });
  });

  // ------------------------------------------------------------------ DELETE

  describe('D1 DELETE — exam.result.compute report_card_subjects replace', () => {
    it('owner control: Tenant-B compute mints Tenant-B draft cards', async () => {
      const event = makeEvent(state.B.tenant, {
        eventType: 'exam.result.compute',
        aggregateType: 'exam',
        aggregateId: state.B.exam,
        payload: { examId: state.B.exam, reason: 'seed' },
      });
      const { deferred } = await run(event);
      expect(deferred).toHaveLength(0);
      const cards = await rows(
        `select id from report_cards where tenant_id = '${state.B.tenant}' and deleted_at is null`,
      );
      expect(cards.length).toBe(2);
      expect(paramsInclude(state.A.tenant)).toBe(false);
    });

    it('owner control: Tenant-A compute mints Tenant-A draft cards', async () => {
      const event = makeEvent(state.A.tenant, {
        eventType: 'exam.result.compute',
        aggregateType: 'exam',
        aggregateId: state.A.exam,
        payload: { examId: state.A.exam, reason: 'seed' },
      });
      const { deferred } = await run(event);
      expect(deferred).toHaveLength(0);
      const cards = await rows(
        `select id from report_cards where tenant_id = '${state.A.tenant}' and deleted_at is null`,
      );
      expect(cards.length).toBe(2);
    });

    it('NEGATIVE: a Tenant-A event targeting Tenant-B exam issues no DELETE and leaves Tenant-B cards byte-identical', async () => {
      const bCard1 = (await cardOf(state.B.tenant, state.B.student1))!;
      const beforeLines = await cardLines(bCard1.id);

      const event = makeEvent(state.A.tenant, {
        eventType: 'exam.result.compute',
        aggregateType: 'exam',
        aggregateId: state.B.exam,
        payload: { examId: state.B.exam, reason: 'cross-tenant' },
      });
      const { deferred } = await run(event);
      expect(deferred).toHaveLength(0);

      const afterLines = await cardLines(bCard1.id);
      expect(afterLines).toEqual(beforeLines);
      const bCards = await rows(
        `select id from report_cards where tenant_id = '${state.B.tenant}' and deleted_at is null`,
      );
      expect(bCards.length).toBe(2);
      expect(paramsInclude(state.B.tenant)).toBe(false);
      expect(anyStatementLike(/delete from "report_card_subjects"/i)).toBe(false);
      expect(anyStatementLike(/insert into "report_cards"/i)).toBe(false);
    });

    it('same-tenant control: Tenant-A recompute DOES execute the DELETE path (sentinel line removed)', async () => {
      const aCard1 = (await cardOf(state.A.tenant, state.A.student1))!;
      const es2 = state.A.examSubject2;
      expect(await cardLines(aCard1.id)).toHaveLength(1);

      await migrator.query(
        `insert into report_card_subjects
           (id, tenant_id, report_card_id, exam_subject_id, subject_id, subject_name, max_marks, weight)
         values ('${randomUUID()}', '${state.A.tenant}', '${aCard1.id}', '${es2}',
                 '${state.A.subject2}', 'SENTINEL', 100, 1)`,
      );
      expect(await cardLines(aCard1.id)).toHaveLength(2);

      const event = makeEvent(state.A.tenant, {
        eventType: 'exam.result.compute',
        aggregateType: 'exam',
        aggregateId: state.A.exam,
        payload: { examId: state.A.exam, reason: 'recompute' },
      });
      const { deferred } = await run(event);
      expect(deferred).toHaveLength(0);

      const after = await cardLines(aCard1.id);
      expect(after).toHaveLength(1);
      expect(after.some((l) => l.subject_name === 'SENTINEL')).toBe(false);
      expect(anyStatementLike(/delete from "report_card_subjects"/i)).toBe(true);
      expect(paramsInclude(state.B.tenant)).toBe(false);
    });
  });

  // ------------------------------------------------------------------ UPSERT

  describe('S1 UPSERT — report.studentReportCard files insert', () => {
    it('same-tenant control: Tenant-A artifact job inserts a Tenant-A file row and stamps its own card', async () => {
      const aCard1 = (await cardOf(state.A.tenant, state.A.student1))!;
      const before = (
        await rows<{ n: number }>(
          `select count(*)::int n from files where tenant_id = '${state.A.tenant}'`,
        )
      )[0]!.n;

      captured.length = 0;
      const outcome = await withGuc(recDb, { tenantId: state.A.tenant, system: true }, (tx) =>
        processReportCardJob(tx, storage, noop, {
          reportCardId: aCard1.id,
          tenantId: state.A.tenant,
          idempotencyKey: randomUUID(),
          correlationId: randomUUID(),
        }),
      );

      expect(outcome.status).toBe('generated');
      const afterFiles = await rows(
        `select storage_key, original_name, scan_status from files where tenant_id = '${state.A.tenant}'`,
      );
      expect(afterFiles.length).toBe(before + 1);
      const stamped = (await cardOf(state.A.tenant, state.A.student1))!;
      expect(stamped.file_id).not.toBeNull();
      expect(anyStatementLike(/insert into "files"/i)).toBe(true);
      expect(anyStatementLike(/update "report_cards"/i)).toBe(true);
      expect(paramsInclude(state.B.tenant)).toBe(false);
    });

    it('NEGATIVE: a Tenant-A job on a Tenant-B card id returns missing and issues no file write', async () => {
      const bCard1 = (await cardOf(state.B.tenant, state.B.student1))!;
      const bFilesBefore = await rows(
        `select storage_key, original_name from files where tenant_id = '${state.B.tenant}'`,
      );

      captured.length = 0;
      const outcome = await withGuc(recDb, { tenantId: state.A.tenant, system: true }, (tx) =>
        processReportCardJob(tx, storage, noop, {
          reportCardId: bCard1.id,
          tenantId: state.A.tenant,
          idempotencyKey: randomUUID(),
          correlationId: randomUUID(),
        }),
      );

      expect(outcome.status).toBe('missing');
      const bAfter = (
        await rows<{ file_id: string | null }>(
          `select file_id from report_cards where id = '${bCard1.id}'`,
        )
      )[0];
      expect(bAfter!.file_id).toBeNull();
      const bFilesAfter = await rows(
        `select storage_key, original_name from files where tenant_id = '${state.B.tenant}'`,
      );
      expect(bFilesAfter).toEqual(bFilesBefore);
      expect(anyStatementLike(/insert into "files"/i)).toBe(false);
      expect(anyStatementLike(/update "report_cards"/i)).toBe(false);
      expect(paramsInclude(state.B.tenant)).toBe(false);
    });

    it('NEGATIVE (storage-key conflict): a Tenant-B owned storage_key is never adopted or overwritten; job fails closed', async () => {
      const aCard2 = (await cardOf(state.A.tenant, state.A.student2))!;
      const key = `report-cards/${aCard2.id}-v1.pdf`;

      await migrator.query(
        `insert into files (id, tenant_id, storage_key, original_name, mime, size_bytes, visibility, scan_status)
         values ('${randomUUID()}', '${state.B.tenant}', '${key}', 'b-owner-of-colliding-key.pdf',
                 'application/pdf', 12, 'private', 'pending')`,
      );

      captured.length = 0;
      let outcome: unknown;
      let threw = false;
      try {
        outcome = await withGuc(recDb, { tenantId: state.A.tenant, system: true }, (tx) =>
          processReportCardJob(tx, storage, noop, {
            reportCardId: aCard2.id,
            tenantId: state.A.tenant,
            idempotencyKey: randomUUID(),
            correlationId: randomUUID(),
          }),
        );
      } catch {
        threw = true;
      }

      // The globally-unique storage_key makes the insert conflict; the fallback
      // re-read is tenant-scoped, so the job can NEITHER adopt nor overwrite the
      // Tenant-B row — it errors (fail-closed) rather than leaking.
      expect(threw || (outcome as { status?: string }).status === 'converged').toBe(true);
      const bRow = (
        await rows<{ original_name: string; tenant_id: string }>(
          `select original_name, tenant_id from files where storage_key = '${key}'`,
        )
      )[0];
      expect(bRow!.tenant_id).toBe(state.B.tenant);
      expect(bRow!.original_name).toBe('b-owner-of-colliding-key.pdf');
      const aOwned = (
        await rows<{ n: number }>(
          `select count(*)::int n from files where tenant_id = '${state.A.tenant}' and storage_key = '${key}'`,
        )
      )[0]!.n;
      expect(aOwned).toBe(0);
      const stamp = (await cardOf(state.A.tenant, state.A.student2))!;
      expect(stamp.file_id).toBeNull();
      expect(paramsInclude(state.B.tenant)).toBe(false);
    });
  });

  // ------------------------------------------------------------------ context failure

  describe('X context — absent/malformed tenant context fails closed', () => {
    const deliver = async (event: OutboxEvent): Promise<void> => {
      captured.length = 0;
      const job = { id: randomUUID(), data: { event }, attemptsMade: 0 } as unknown as Job<{
        event: OutboxEvent;
      }>;
      await processEvent(recDb, job, handlers);
    };

    it('a NULL event.tenantId is rejected by assertEventTenant before any handler runs', async () => {
      const event = {
        version: 1,
        id: randomUUID(),
        tenantId: null,
        eventType: 'attendance.marked' as const,
        aggregateType: 'attendance_day',
        aggregateId: state.A.attendanceDay,
        payload: { tenantId: state.A.tenant, attendanceDate: state.A.date },
        correlationId: null,
        causationId: null,
        createdAt: new Date().toISOString(),
      };
      await expect(deliver(event)).rejects.toThrow(/tenant/i);
      expect(paramsInclude(state.A.tenant)).toBe(false);
    });

    it('whitespace/empty/garbage tenantId is rejected at envelope validation (never silently processed)', async () => {
      for (const bad of ['', '   ', 'not-a-uuid']) {
        const event = makeEvent(bad, {
          eventType: 'attendance.marked',
          aggregateType: 'attendance_day',
          aggregateId: state.A.attendanceDay,
          payload: { attendanceDate: state.A.date },
        });
        await expect(deliver(event)).rejects.toThrow();
        expect(captured.some((s) => s.params.includes(bad))).toBe(false);
      }
    });
  });

  // ------------------------------------------------------------------ R-3 trust chain

  /**
   * R-3 — the outbox ENVELOPE (`event.tenantId`) is authoritative; a
   * payload-carried `tenantId` is only ever a consistency echo and may NOT
   * select the tenant. `assertEventTenant` is the FIRST statement of
   * `runEventHandler`, so any mismatch/malformed payload aborts with ZERO
   * data-plane SQL (proven below via the drizzle statement recorder) and an
   * absent payload copy is simply carried on the envelope.
   */
  describe('R-3 TRUST CHAIN — envelope authoritative, payload echo must agree', () => {
    const baseEvent = (
      tenantId: string,
      payload: Record<string, unknown>,
    ): OutboxEvent => ({
      version: 1,
      id: randomUUID(),
      tenantId,
      eventType: 'attendance.marked',
      aggregateType: 'attendance_day',
      aggregateId: state.A.attendanceDay,
      payload,
      correlationId: randomUUID(),
      causationId: null,
      createdAt: new Date().toISOString(),
    });

    it('T1 ACCEPT: envelope == payload echo renders same-tenant result', async () => {
      const event = baseEvent(state.A.tenant, {
        tenantId: state.A.tenant,
        attendanceDate: state.A.date,
      });
      const { deferred } = await run(event);
      expect(deferred.length).toBeGreaterThan(0);
      const emails = deferred.map((j) => (j.data as { to: string }).to);
      expect(emails).toContain(guardianEmail('A'));
      expect(anyStatementLike(/from "attendance_days"/i)).toBe(true);
      expect(paramsInclude(state.A.tenant)).toBe(true);
      expect(paramsInclude(state.B.tenant)).toBe(false);
    });

    it('T2 ACCEPT: NO payload.tenantId — envelope stands alone, handler still runs on the envelope tenant', async () => {
      const event = baseEvent(state.A.tenant, { attendanceDate: state.A.date });
      const { deferred } = await run(event);
      expect(deferred.length).toBeGreaterThan(0);
      const emails = deferred.map((j) => (j.data as { to: string }).to);
      expect(emails).toContain(guardianEmail('A'));
      // The only tenant bound anywhere is the envelope value — data-plane SQL
      // ran, but Tenant B's id was never bound to any statement.
      expect(paramsInclude(state.A.tenant)).toBe(true);
      expect(paramsInclude(state.B.tenant)).toBe(false);
    });

    it('T3 REJECT: envelope A / payload B mismatch aborts before ANY SQL', async () => {
      const event = baseEvent(state.A.tenant, {
        tenantId: state.B.tenant,
        attendanceDate: state.B.date,
      });
      captured.length = 0;
      await expect(runEventHandler(recDb, event, handlers)).rejects.toThrow(/mismatch/);
      // assertEventTenant runs first: not a single statement reached the DB.
      expect(captured, 'no SQL may execute before the tenant trust check').toHaveLength(0);
    });

    it('T4 REJECT: envelope B / payload A mismatch aborts before ANY SQL', async () => {
      const event = baseEvent(state.B.tenant, {
        tenantId: state.A.tenant,
        attendanceDate: state.A.date,
      });
      captured.length = 0;
      await expect(runEventHandler(recDb, event, handlers)).rejects.toThrow(/mismatch/);
      expect(captured, 'no SQL may execute before the tenant trust check').toHaveLength(0);
    });

    it('T5 REJECT: malformed payload.tenantId (empty/whitespace/null/non-string) fails closed', async () => {
      for (const bad of ['', '   ', null, 42, true, {}, []]) {
        const event = baseEvent(state.A.tenant, { tenantId: bad, attendanceDate: state.A.date });
        captured.length = 0;
        await expect(runEventHandler(recDb, event, handlers), `payload tenantId = ${JSON.stringify(bad)}`).rejects.toThrow(
          /malformed payload\.tenantId/,
        );
        expect(captured, `no SQL for payload tenantId = ${JSON.stringify(bad)}`).toHaveLength(0);
      }
    });

    it('T3/T4/T5 via processEvent: DB-unchanged, the ONLY statement touches the event’s own outbox row', async () => {
      // processEvent adds the failure bookkeeping (last_error on the event row)
      // and re-throws. Nothing else may be written — in particular no domain
      // table and no cross-tenant data.
      const jobs = [
        // T3 mismatch
        baseEvent(state.A.tenant, { tenantId: state.B.tenant, attendanceDate: state.B.date }),
        // T4 mismatch (B envelope wants A's data)
        baseEvent(state.B.tenant, { tenantId: state.A.tenant, attendanceDate: state.A.date }),
        // T5 malformed echo
        baseEvent(state.A.tenant, { tenantId: '   ', attendanceDate: state.A.date }),
      ];
      for (const event of jobs) {
        captured.length = 0;
        const job = {
          id: randomUUID(),
          data: { event },
          attemptsMade: 0,
        } as unknown as Job<{ event: OutboxEvent }>;
        await expect(processEvent(recDb, job, handlers)).rejects.toThrow();
        // Exactly one bookkeeping statement against the event's OWN outbox row
        // (set_config GUC bookkeeping and begin/commit may also appear, but no
        // data-plane table may be touched).
        const bookkeeping = captured.filter((s) => /update\s+"outbox_events"/i.test(s.text));
        expect(bookkeeping, `bookkeeping to have exactly one outbox_events update; got ${captured
          .map((s) => s.text)
          .join(' | ')}`).toHaveLength(1);
        expect(anyStatementLike(/attendance_days/i)).toBe(false);
        expect(anyStatementLike(/promotion_batches/i)).toBe(false);
        expect(anyStatementLike(/students/i)).toBe(false);
        expect(paramsInclude(state.A.tenant)).toBe(false);
        expect(paramsInclude(state.B.tenant)).toBe(false);
      }
    });
  });
});

interface TenantFixtureUids {
  tenant: string;
  campus: string;
  year: string;
  year2: string;
  term: string;
  level: string;
  subject1: string;
  subject2: string;
  classId: string;
  section: string;
  link1: string;
  link2: string;
  student1: string;
  student2: string;
  enroll1: string;
  enroll2: string;
  examType: string;
  exam: string;
  examSubject1: string;
  examSubject2: string;
  user: string;
  membership: string;
  guardian: string;
  studentGuardian1: string;
  attendanceDay: string;
  batch: string;
  item: string;
  date: string;
}

function createFixtureUids(prefix: string): TenantFixtureUids {
  const uuid = (): string => randomUUID();
  return {
    tenant: uuid(),
    campus: uuid(),
    year: uuid(),
    year2: uuid(),
    term: uuid(),
    level: uuid(),
    subject1: uuid(),
    subject2: uuid(),
    classId: uuid(),
    section: uuid(),
    link1: uuid(),
    link2: uuid(),
    student1: uuid(),
    student2: uuid(),
    enroll1: uuid(),
    enroll2: uuid(),
    examType: uuid(),
    exam: uuid(),
    examSubject1: uuid(),
    examSubject2: uuid(),
    user: uuid(),
    membership: uuid(),
    guardian: uuid(),
    studentGuardian1: uuid(),
    attendanceDay: uuid(),
    batch: uuid(),
    item: uuid(),
    date: prefix === 'A' ? '2025-02-10' : '2025-02-11',
  };
}

/** Full academic + attendance + promotion fixture for ONE tenant (one txn). */
async function seedTenant(m: pg.Client, u: TenantFixtureUids, slug: string): Promise<void> {
  const s = slug + u.date.slice(-2);
  const email = (name: string): string => `${name}-${u.date.slice(-2)}-${slug}@example.com`;
  const q = (sqlText: string): Promise<pg.QueryResult> => m.query(sqlText);

  await q(`insert into tenants (id, slug, name) values ('${u.tenant}', 't-${s}', 'D3 Tenant ${s}')`);
  await q(`insert into users (id, email) values ('${u.user}', '${email('g')}')`);
  await q(
    `insert into memberships (id, tenant_id, user_id, status)
     values ('${u.membership}', '${u.tenant}', '${u.user}', 'active')`,
  );
  await q(
    `insert into campuses (id, tenant_id, code, name, status)
     values ('${u.campus}', '${u.tenant}', 'cp-${s}', 'Campus', 'active')`,
  );
  await q(
    `insert into academic_years (id, tenant_id, code, name, starts_on, ends_on, status)
     values ('${u.year}', '${u.tenant}', 'ay-${s}', 'AY', '2025-01-01', '2025-12-31', 'active'),
            ('${u.year2}', '${u.tenant}', 'ay2-${s}', 'AY2', '2026-01-01', '2026-12-31', 'active')`,
  );
  await q(
    `insert into academic_terms (id, tenant_id, academic_year_id, code, name, sequence, starts_on, ends_on, status)
     values ('${u.term}', '${u.tenant}', '${u.year}', 'tm-${s}', 'Term 1', 1, '2025-01-01', '2025-06-30', 'open')`,
  );
  await q(
    `insert into grade_levels (id, tenant_id, code, name, status)
     values ('${u.level}', '${u.tenant}', 'gl-${s}', 'Grade 1', 'active')`,
  );
  await q(
    `insert into subjects (id, tenant_id, code, name, status)
     values ('${u.subject1}', '${u.tenant}', 'sb1-${s}', 'Maths', 'active'),
            ('${u.subject2}', '${u.tenant}', 'sb2-${s}', 'Science', 'active')`,
  );
  await q(
    `insert into acd_classes (id, tenant_id, campus_id, academic_year_id, grade_level_id, code, name, status)
     values ('${u.classId}', '${u.tenant}', '${u.campus}', '${u.year}', '${u.level}', 'cl-${s}', 'Class', 'active')`,
  );
  await q(
    `insert into sections (id, tenant_id, class_id, campus_id, academic_year_id, code, status)
     values ('${u.section}', '${u.tenant}', '${u.classId}', '${u.campus}', '${u.year}', 'sec-${s}', 'active')`,
  );
  await q(
    `insert into class_subjects (id, tenant_id, class_id, subject_id, campus_id, academic_year_id)
     values ('${u.link1}', '${u.tenant}', '${u.classId}', '${u.subject1}', '${u.campus}', '${u.year}'),
            ('${u.link2}', '${u.tenant}', '${u.classId}', '${u.subject2}', '${u.campus}', '${u.year}')`,
  );
  await q(
    `insert into students (id, tenant_id, student_no, first_name, last_name, status, primary_campus_id)
     values ('${u.student1}', '${u.tenant}', 'S1-${s}', 'One', '${u.date}', 'active', '${u.campus}'),
            ('${u.student2}', '${u.tenant}', 'S2-${s}', 'Two', '${u.date}', 'active', '${u.campus}')`,
  );
  await q(
    `insert into enrollments (id, tenant_id, student_id, academic_year_id, class_id, section_id, roll_no, status)
     values ('${u.enroll1}', '${u.tenant}', '${u.student1}', '${u.year}', '${u.classId}', '${u.section}', '01', 'active'),
            ('${u.enroll2}', '${u.tenant}', '${u.student2}', '${u.year}', '${u.classId}', '${u.section}', '02', 'active')`,
  );
  await q(
    `insert into guardians (id, tenant_id, user_id, first_name, last_name, email)
     values ('${u.guardian}', '${u.tenant}', '${u.user}', 'Guardian', '${u.date}', '${email('g')}')`,
  );
  await q(
    `insert into student_guardians (id, tenant_id, student_id, guardian_id, relation, is_primary)
     values ('${u.studentGuardian1}', '${u.tenant}', '${u.student1}', '${u.guardian}', 'parent', true)`,
  );
  await q(
    `insert into exam_types (id, tenant_id, code, name)
     values ('${u.examType}', '${u.tenant}', 'et_${s}', 'Midterm')`,
  );
  await q(
    `insert into exams (id, tenant_id, academic_term_id, academic_year_id, exam_type_id, name, status)
     values ('${u.exam}', '${u.tenant}', '${u.term}', '${u.year}', '${u.examType}', 'Exam ${s}', 'draft')`,
  );
  await q(
    `insert into exam_subjects (id, tenant_id, exam_id, class_subject_id, academic_year_id, class_id, subject_id, max_marks, weight)
     values ('${u.examSubject1}', '${u.tenant}', '${u.exam}', '${u.link1}', '${u.year}', '${u.classId}', '${u.subject1}', 100, 1),
            ('${u.examSubject2}', '${u.tenant}', '${u.exam}', '${u.link2}', '${u.year}', '${u.classId}', '${u.subject2}', 100, 1)`,
  );
  await q(`update exams set status = 'grading' where id = '${u.exam}'`);
  await q(
    `insert into marks (id, tenant_id, exam_subject_id, enrollment_id, student_id, section_id, academic_year_id, marks_obtained, entered_by)
     values ('${randomUUID()}', '${u.tenant}', '${u.examSubject1}', '${u.enroll1}', '${u.student1}', '${u.section}', '${u.year}', 88, '${u.user}')`,
  );
  await q(
    `insert into attendance_days (id, tenant_id, student_id, campus_id, attendance_date, status, source, marked_by)
     values ('${u.attendanceDay}', '${u.tenant}', '${u.student1}', '${u.campus}', '${u.date}', 'late', 'manual', '${u.user}')`,
  );
  await q(
    `insert into promotion_batches (id, tenant_id, from_academic_year_id, to_academic_year_id, status)
     values ('${u.batch}', '${u.tenant}', '${u.year}', '${u.year2}', 'in_progress')`,
  );
  await q(
    `insert into promotion_items (id, tenant_id, batch_id, student_id, from_academic_year_id, to_academic_year_id, from_section_id, status)
     values ('${u.item}', '${u.tenant}', '${u.batch}', '${u.student1}', '${u.year}', '${u.year2}', '${u.section}', 'pending')`,
  );
}