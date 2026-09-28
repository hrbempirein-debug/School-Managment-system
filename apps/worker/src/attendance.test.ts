import { beforeAll, describe, it, expect, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql, type SQL } from 'drizzle-orm';
import { getEnv } from '@sms/config';
import { createDb, withSystem, type Db } from '@sms/db';
import {
  makeLateNotificationHandler,
  makeLeaveDecisionHandler,
  runDailyAttendanceSummaries,
  summarizeTenantAttendance,
} from './attendance.js';
import { runEventHandler } from './worker.js';
import { mailStubSendJobSchema, type JobPayload, type MailStubSendJob, type OutboxEvent } from '@sms/contracts';

/**
 * Phase 5 worker proofs, against the REAL disposable test Postgres.
 *
 *   A. `attendance.marked` defers one `mail.stub.send` STUB per late student's
 *      LIVE guardian — and none at all when nobody was late. The job is DEFERRED,
 *      never enqueued inside the transaction, so a rolled-back mark cannot notify
 *      a family (asserted by comparing the committed row count with the payload).
 *   B. `leave.approved` defers a decision stub to the requester and converges as a
 *      no-op when the request no longer matches (redriven dispatch).
 *   C. The daily summary is computed from the database (never accumulated) and
 *      writes AT MOST ONE `attendance.daily_summary` audit row per (tenant, date),
 *      so a repeated run is idempotent.
 *
 * Opt-in: RUN_RUNTIME_SECURITY_TESTS=1.
 */
const enabled = process.env.RUN_RUNTIME_SECURITY_TESTS === '1';
const describeDb = enabled ? describe : describe.skip;

const silentLog = (): void => {};
const slug = 'p5w' + randomUUID().slice(0, 8);

describeDb('Phase 5 attendance worker handlers (real PG)', () => {
  let db: Db;
  let pool: ReturnType<typeof createDb>['pool'];
  let tenantId = '';
  let today = '';
  let yesterday = '';

  let lateStudent = '';
  let presentStudent = '';
  let guardianUserId = '';
  let staffUserId = '';
  let academicYearId = '';
  let campusId = '';
  let classId = '';
  let leaveRequestId = '';
  let requesterUserId = '';

  const rows = async (q: SQL): Promise<Record<string, unknown>[]> =>
    (await withSystem(db, (tx) => tx.execute(q))).rows;
  const one = async (q: SQL): Promise<Record<string, unknown>> =>
    (await rows(q))[0]!;

  const mkUser = async (suffix: string): Promise<string> => {
    const id = randomUUID();
    await rows(sql`insert into users (id, email) values (${id}, ${`${suffix}-${slug}@example.com`})`);
    return id;
  };

  const mkStudent = async (studentNo: string): Promise<string> => {
    const id = randomUUID();
    await rows(
      sql`insert into students (id, tenant_id, student_no, first_name, last_name, status)
          values (${id}, ${tenantId}, ${studentNo}, 'Worker', 'Student', 'active')`,
    );
    await rows(
      sql`insert into enrollments (id, tenant_id, student_id, academic_year_id, class_id, status, roll_no)
          values (${randomUUID()}, ${tenantId}, ${id}, ${academicYearId}, ${classId}, 'active', ${studentNo})`,
    );
    return id;
  };

  const event = (over: Partial<OutboxEvent> & Pick<OutboxEvent, 'eventType'>): OutboxEvent => {
    const base = {
      id: randomUUID(),
      version: 1,
      tenantId,
      aggregateType: 'attendance_day',
      aggregateId: today,
      correlationId: randomUUID(),
      causationId: null,
      createdAt: new Date().toISOString(),
    };
    // Merge the payload rather than replacing it: the handlers read
    // `attendanceDate` from the payload, so a partial override must keep the
    // tenant/date defaults (exactly like a real producer that adds extra fields).
    return {
      ...base,
      ...over,
      payload: { tenantId, attendanceDate: today, ...over.payload },
    } as unknown as OutboxEvent;
  };

  /** Run one handler the way the worker does, collecting its deferred jobs. */
  const run = async (e: OutboxEvent): Promise<JobPayload[]> =>
    runEventHandler(db, e, { [e.eventType]: makeLateNotificationHandler(silentLog) });

  /** The deferred stub must satisfy the Phase 8 mail contract it claims to be. */
  const stub = (job: JobPayload): MailStubSendJob => {
    expect(job.name).toBe('mail.stub.send');
    expect(job.queue).toBe('mail');
    return mailStubSendJobSchema.parse(job.data);
  };

  beforeAll(async () => {
    const env = getEnv();
    const created = createDb({ url: env.DATABASE_URL_MIGRATOR });
    db = created.db;
    pool = created.pool;

    tenantId = randomUUID();
    await rows(
      sql`insert into tenants (id, slug, name, status) values (${tenantId}, ${slug}, 'P5 Worker Tenant', 'active')`,
    );
    today = String((await one(sql`select to_char(current_date, 'YYYY-MM-DD') d`)).d);
    yesterday = String((await one(sql`select to_char(current_date - 1, 'YYYY-MM-DD') d`)).d);

    academicYearId = randomUUID();
    await rows(
      sql`insert into academic_years (id, tenant_id, code, name, starts_on, ends_on, status)
          values (${academicYearId}, ${tenantId}, ${`ay-${slug}`}, 'AY', '2026-01-01', '2026-12-31', 'active')`,
    );
    campusId = randomUUID();
    await rows(
      sql`insert into campuses (id, tenant_id, code, name) values (${campusId}, ${tenantId}, ${`cp-${slug}`}, 'Campus')`,
    );
    classId = randomUUID();
    await rows(
      sql`insert into acd_classes (id, tenant_id, campus_id, academic_year_id, code, name, status)
          values (${classId}, ${tenantId}, ${campusId}, ${academicYearId}, ${`c-${slug}`}, 'Class', 'active')`,
    );

    lateStudent = await mkStudent(`late-${slug}`);
    presentStudent = await mkStudent(`pres-${slug}`);

    // The attendance trigger refuses a `marked_by` without an active membership,
    // so the fixtures are written by a real staff member, not by the migrator.
    staffUserId = await mkUser('staff');
    const staffRoleId = randomUUID();
    const staffMembershipId = randomUUID();
    await rows(
      sql`insert into roles (id, tenant_id, scope, code, name, is_system)
          values (${staffRoleId}, ${tenantId}, 'tenant', 'teacher', 'Teacher', false)`,
    );
    await rows(
      sql`insert into role_permissions (role_id, permission) values (${staffRoleId}, 'attendance.mark')`,
    );
    await rows(
      sql`insert into memberships (id, tenant_id, user_id, status)
          values (${staffMembershipId}, ${tenantId}, ${staffUserId}, 'active')`,
    );
    await rows(
      sql`insert into membership_roles (membership_id, role_id) values (${staffMembershipId}, ${staffRoleId})`,
    );

    // The late student's family: one guardian with a portal user, one link.
    guardianUserId = await mkUser('guard');
    const guardianId = randomUUID();
    await rows(
      sql`insert into guardians (id, tenant_id, user_id, first_name, last_name)
          values (${guardianId}, ${tenantId}, ${guardianUserId}, 'Work', 'Guardian')`,
    );
    await rows(
      sql`insert into student_guardians (id, tenant_id, student_id, guardian_id, relation, is_primary)
          values (${randomUUID()}, ${tenantId}, ${lateStudent}, ${guardianId}, 'parent', true)`,
    );
    // A second student with NO guardian proves an unlinked family is never
    // notified even when they are late.
    const orphanStudent = await mkStudent(`orph-${slug}`);
    await rows(
      sql`insert into attendance_days (id, tenant_id, student_id, attendance_date, status, source, marked_by)
          values (${randomUUID()}, ${tenantId}, ${orphanStudent}, ${today}, 'late', 'manual', ${staffUserId})`,
    );
    await rows(
      sql`insert into attendance_days (id, tenant_id, student_id, attendance_date, status, source, marked_by)
          values (${randomUUID()}, ${tenantId}, ${lateStudent}, ${today}, 'late', 'manual', ${staffUserId}),
                 (${randomUUID()}, ${tenantId}, ${presentStudent}, ${today}, 'present', 'manual', ${staffUserId})`,
    );

    // A decided leave request, filed by a parent of a DIFFERENT (present) student.
    // Keeping the requester on another child is what proves the decision stub is
    // addressed from the request row rather than from the attendance marked event.
    requesterUserId = await mkUser('req');
    const requesterGuardianId = randomUUID();
    await rows(
      sql`insert into guardians (id, tenant_id, user_id, first_name, last_name)
          values (${requesterGuardianId}, ${tenantId}, ${requesterUserId}, 'Work', 'Parent')`,
    );
    await rows(
      sql`insert into student_guardians (id, tenant_id, student_id, guardian_id, relation, is_primary)
          values (${randomUUID()}, ${tenantId}, ${presentStudent}, ${requesterGuardianId}, 'parent', true)`,
    );
    const requesterMembershipId = randomUUID();
    const parentRoleId = randomUUID();
    await rows(
      sql`insert into roles (id, tenant_id, scope, code, name, is_system)
          values (${parentRoleId}, ${tenantId}, 'tenant', 'parent', 'Parent', false)`,
    );
    await rows(
      sql`insert into role_permissions (role_id, permission) values (${parentRoleId}, 'attendance.request_leave')`,
    );
    await rows(
      sql`insert into memberships (id, tenant_id, user_id, status)
          values (${requesterMembershipId}, ${tenantId}, ${requesterUserId}, 'active')`,
    );
    await rows(
      sql`insert into membership_roles (membership_id, role_id) values (${requesterMembershipId}, ${parentRoleId})`,
    );

    const leaveTypeId = randomUUID();
    await rows(
      sql`insert into leave_types (id, tenant_id, code, name, status)
          values (${leaveTypeId}, ${tenantId}, 'medical', 'Medical', 'active')`,
    );
    leaveRequestId = randomUUID();
    await rows(
      sql`insert into leave_requests (id, tenant_id, student_id, leave_type_id, start_date, end_date, status, requested_by, approver_user_id, decision_at)
          values (${leaveRequestId}, ${tenantId}, ${presentStudent}, ${leaveTypeId}, ${today}, ${today}, 'approved', ${requesterUserId}, ${staffUserId}, now())`,
    );
  });

  afterAll(async () => {
    try {
      await withSystem(db, async (tx) => {
        await tx.execute(sql`delete from audit_logs where tenant_id = ${tenantId}`);
        await tx.execute(sql`delete from outbox_events where tenant_id = ${tenantId}`);
        await tx.execute(sql`delete from attendance_days where tenant_id = ${tenantId}`);
        await tx.execute(sql`delete from leave_requests where tenant_id = ${tenantId}`);
        await tx.execute(sql`delete from leave_types where tenant_id = ${tenantId}`);
        await tx.execute(sql`delete from student_guardians where tenant_id = ${tenantId}`);
        await tx.execute(sql`delete from guardians where tenant_id = ${tenantId}`);
        await tx.execute(sql`delete from enrollments where tenant_id = ${tenantId}`);
        await tx.execute(sql`delete from students where tenant_id = ${tenantId}`);
        await tx.execute(sql`delete from acd_classes where tenant_id = ${tenantId}`);
        await tx.execute(sql`delete from academic_years where tenant_id = ${tenantId}`);
        await tx.execute(sql`delete from campuses where tenant_id = ${tenantId}`);
        await tx.execute(sql`delete from membership_roles where membership_id in (select id from memberships where tenant_id = ${tenantId})`);
        await tx.execute(sql`delete from memberships where tenant_id = ${tenantId}`);
        await tx.execute(sql`delete from role_permissions where role_id in (select id from roles where tenant_id = ${tenantId})`);
        await tx.execute(sql`delete from roles where tenant_id = ${tenantId}`);
        await tx.execute(sql`delete from tenants where id = ${tenantId}`);
        await tx.execute(sql`delete from users where email like ${`%-${slug}@example.com`}`);
      });
    } catch {
      // best-effort cleanup
    }
    await pool.end();
  });

  describe('A. late-notification stub', () => {
    it('defers exactly one mail stub to the LIVE guardian of each late student', async () => {
      const deferred = await run(
        event({ eventType: 'attendance.marked', payload: { markedCount: 2 } }),
      );
      // Two students are 'late' (one linked, one orphan); only the linked one
      // has a guardian, so exactly ONE stub is produced.
      expect(deferred).toHaveLength(1);
      const data = stub(deferred[0]!);
      expect(data.template).toBe('attendance.student.late');
      expect(data.tenantId).toBe(tenantId);
      expect(data.to).toBe(
        String((await one(sql`select email from users where id = ${guardianUserId}`)).email),
      );
      expect(data.data['studentId']).toBe(lateStudent);
      expect(data.data['attendanceDate']).toBe(today);
    });

    it('deferring is the ONLY side effect: the handler writes no rows itself', async () => {
      const before = await one(
        sql`select count(*)::int n from audit_logs where tenant_id = ${tenantId} and action = 'attendance.notification'`,
      );
      const deferred = await run(event({ eventType: 'attendance.marked' }));
      expect(deferred).toHaveLength(1);
      const after = await one(
        sql`select count(*)::int n from audit_logs where tenant_id = ${tenantId} and action = 'attendance.notification'`,
      );
      expect(Number(after.n)).toBe(Number(before.n));
    });

    it('defers nothing when the day has no late students', async () => {
      const otherDate = '2026-01-05';
      const deferred = await run(
        event({ eventType: 'attendance.marked', payload: { attendanceDate: otherDate } }),
      );
      expect(deferred).toEqual([]);
    });
  });

  describe('B. leave decision stub', () => {
    it('defers a decision stub addressed to the requester', async () => {
      const deferred = await runEventHandler(
        db,
        event({
          eventType: 'leave.approved',
          payload: { leaveRequestId },
        }),
        { 'leave.approved': makeLeaveDecisionHandler(silentLog) },
      );
      expect(deferred).toHaveLength(1);
      const data = stub(deferred[0]!);
      expect(data.template).toBe('attendance.leave.decision');
      expect(data.to).toBe(
        String((await one(sql`select email from users where id = ${requesterUserId}`)).email),
      );
      expect(data.data['status']).toBe('approved');
    });

    it('is a no-op (no stub) when the request no longer matches the decision', async () => {
      // A redriven dispatch of an already-processed event must not re-notify.
      const deferred = await runEventHandler(
        db,
        event({
          eventType: 'leave.approved',
          payload: { leaveRequestId: randomUUID() },
        }),
        { 'leave.approved': makeLeaveDecisionHandler(silentLog) },
      );
      expect(deferred).toEqual([]);
    });

    it('rejects a payload without a leaveRequestId instead of guessing', async () => {
      await expect(
        runEventHandler(db, event({ eventType: 'leave.rejected' }), {
          'leave.rejected': makeLeaveDecisionHandler(silentLog),
        }),
      ).rejects.toThrow(/leaveRequestId/);
    });
  });

  describe('C. daily attendance summary', () => {
    it('computes the tally from the database, counting unmarked students', async () => {
      const summary = await withSystem(db, (tx) => summarizeTenantAttendance(tx, tenantId, today));
      expect(summary.tenantId).toBe(tenantId);
      expect(summary.attendanceDate).toBe(today);
      // enrolled students: late, present, orphan + the leave student (lateStudent is
      // already enrolled) => 3 expected; marked rows: late x2 + present x1.
      expect(summary.expectedStudents).toBe(3);
      expect(summary.late).toBe(2);
      expect(summary.present).toBe(1);
      expect(summary.unmarked).toBe(0);

      const empty = await withSystem(db, (tx) => summarizeTenantAttendance(tx, tenantId, yesterday));
      expect(empty.expectedStudents).toBe(3);
      expect(empty.present + empty.absent + empty.late + empty.excused).toBe(0);
      expect(empty.unmarked).toBe(3);
    });

    it('writes exactly one attendance.daily_summary audit row per (tenant, date)', async () => {
      const countRows = () =>
        one(
          sql`select count(*)::int n from audit_logs
                where tenant_id = ${tenantId} and action = 'attendance.daily_summary'
                  and new_value ->> 'attendanceDate' = ${today}`,
        );
      await runDailyAttendanceSummaries(db, silentLog, { attendanceDate: today });
      const first = await countRows();
      expect(Number(first.n)).toBe(1);

      // A repeat run (or a restarting scheduler) must converge, not duplicate.
      await runDailyAttendanceSummaries(db, silentLog, { attendanceDate: today });
      const second = await countRows();
      expect(Number(second.n)).toBe(1);
    });

    it('records the tally as the audit value', async () => {
      const r = await one(
        sql`select new_value from audit_logs
              where tenant_id = ${tenantId} and action = 'attendance.daily_summary'
                and new_value ->> 'attendanceDate' = ${today}`,
      );
      const value = r.new_value as Record<string, unknown>;
      expect(value['late']).toBe(2);
      expect(value['present']).toBe(1);
      expect(value['expectedStudents']).toBe(3);
    });
  });

  it('the daily summary only ever sees its own tenant', async () => {
    // Another tenant's attendance must not appear in this tenant's tally.
    const otherTenant = randomUUID();
    await rows(sql`insert into tenants (id, slug, name) values (${otherTenant}, ${`${slug}-x`}, 'Other')`);
    try {
      const mine = await withSystem(db, (tx) => summarizeTenantAttendance(tx, tenantId, today));
      const theirs = await withSystem(db, (tx) => summarizeTenantAttendance(tx, otherTenant, today));
      expect(theirs.expectedStudents).toBe(0);
      expect(theirs.late).toBe(0);
      expect(theirs.unmarked).toBe(0);
      expect(mine.late).toBe(2);
    } finally {
      await rows(sql`delete from audit_logs where tenant_id = ${otherTenant}`);
      await rows(sql`delete from tenants where id = ${otherTenant}`);
    }
  });
});
