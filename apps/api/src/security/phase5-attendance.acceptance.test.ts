import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { getEnv } from '@sms/config';
import { createDb, withTenant, type Db } from '@sms/db';
import type { RequestContext } from '@sms/core';
import type { StorageProvider } from '@sms/storage';
import { writeSession, type RedisSession } from '@sms/auth';
import { createRedis } from '@sms/redis';
import { buildApp } from '../app.js';
import { createTenantTransaction } from '../routes/tenants.js';
import type {
  AttendanceContext,
  AttendancePortalResponse,
  AttendanceStudentReportResponse,
} from '@sms/contracts';

/**
 * Phase 5 API acceptance — daily/period attendance, staff light attendance and
 * the student leave lifecycle.
 *
 * Proves, against the real app + real PostgreSQL + live Redis:
 *   A. Route gate: every Phase 5 route needs a session + a tenant context, and
 *      `attendance.mark` / `attendance.approve_leave` / `attendance.request_leave`
 *      are SEPARATE grants from `attendance.read` (a parent with read-only is
 *      403'd on marking with requiredPermission echoed back).
 *   B. Uniqueness is a DATABASE fact: a direct second insert of the same
 *      (tenant, student, date), (…, period) and (tenant, user, date) raises
 *      23505 on the named constraint — while the API's own repeated mark is an
 *      idempotent UPDATE of today's row, never a duplicate.
 *   C. Same-day corrections: correcting today succeeds, correcting a PAST day is
 *      refused by the 0014 trigger (409 attendance_correction_window_closed),
 *      the correction date is immutable, and a correction without a reason never
 *      reaches the DB.
 *   D. Parent own-children scope: a parent sees only their guardianship-linked
 *      child in the list, portal and report reads; another family's child is 404
 *      (existence is not observable) and filing leave for them is 403.
 *   E. Tenant isolation: tenant B's student is unreachable from tenant A for
 *      reads, marks, leave filing and decisions.
 *   F. Leave lifecycle: pending -> approved/rejected is a single-shot
 *      compare-and-set, the decision columns are server-derived, the parent
 *      cannot file for a stranger, a second decision is 409, and an inactive
 *      leave type cannot be used.
 *   G. Audit + outbox: attendance.corrected, leave.requested and leave.approved
 *      all produce an audit row and an outbox event.
 *
 * Opt-in: RUN_RUNTIME_SECURITY_TESTS=1.
 */
const enabled = process.env.RUN_RUNTIME_SECURITY_TESTS === '1';
const describeDb = enabled ? describe : describe.skip;

const stubStorage = {
  async readObject(): Promise<Buffer> {
    throw new Error('not consulted in Phase 5 acceptance');
  },
} as unknown as StorageProvider;

interface SessionCookies {
  token: string;
  csrf: string;
  cookie: string;
}

describeDb('API Phase 5 attendance & leave acceptance (real app + DB + Redis)', () => {
  let migratorDb: Db;
  let appDb: Db;
  let redis: Redis;
  let endMigrator: () => Promise<void>;
  let endApp: () => Promise<void>;
  let endRedis: () => Promise<unknown>;
  let app: Awaited<ReturnType<typeof buildApp>>;

  const uid: Record<string, string> = {};
  const slug = `p5${randomUUID().slice(0, 8)}`;
  const sessions: Record<
    'owner' | 'teacher' | 'teacherTwo' | 'parent' | 'reader' | 'outsider' | 'insider',
    SessionCookies
  > = {} as never;

  let tenantAId = '';
  let tenantBId = '';
  let campusAId = '';
  let yearAId = '';
  let classAId = '';
  let classBId = '';
  let sectionAId = '';
  let sectionBId = '';
  let periodAId = '';
  let subjectAId = '';

  // Tenant A students
  let childParent = ''; // linked to uid.parent via a guardian row
  let childOther = ''; // a second family's child — must stay invisible to the parent
  let childTeacherTwo = ''; // enrolled in classB only (other teacher's class)
  let childPeriod = ''; // used only by the period-marking proofs
  // Tenant B student — proves isolation
  let foreignStudent = '';

  let leaveTypeId = '';
  let today = '';
  let yesterday = '';
  let tomorrow = '';

  const rows = async (db: Db, q: ReturnType<typeof sql>): Promise<Record<string, unknown>[]> =>
    (await db.execute(q)).rows;
  const one = async (db: Db, q: ReturnType<typeof sql>): Promise<Record<string, unknown>> =>
    (await db.execute(q)).rows[0]!;

  const envelope = (res: { json: () => unknown }) =>
    (res.json() as { error?: { code?: string; message?: string; requiredPermission?: string | null } }).error;

  async function makeSession(userId: string, activeTenantId: string | null): Promise<SessionCookies> {
    const session: RedisSession = {
      userId,
      activeTenantId,
      csrfToken: `csrf-${userId.slice(0, 8)}`,
      createdAt: Date.now(),
      expiresAt: Date.now() + 3_600_000,
    };
    const issued = { token: `tok-${randomUUID()}`, tokenHash: '' };
    await writeSession(redis, issued.token, session);
    return {
      token: issued.token,
      csrf: session.csrfToken,
      cookie: `${getEnv().SESSION_COOKIE_NAME}=${issued.token}`,
    };
  }

  const withCsrf = (s: SessionCookies) => ({ 'x-csrf-token': s.csrf });
  const idem = (key: string) => ({ 'x-idempotency-key': key });

  interface InjectResult {
    statusCode: number;
    body: string;
    json(): Record<string, any>;
  }

  const injectAs = (
    s: SessionCookies,
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    opts: { headers?: Record<string, string>; payload?: unknown } = {},
  ): Promise<InjectResult> =>
    app.inject({
      method,
      url,
      headers: { cookie: s.cookie, ...opts.headers },
      payload: opts.payload as string | undefined,
    }) as unknown as Promise<InjectResult>;

  const inject = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, opts = {}) =>
    injectAs(sessions.owner, method, url, opts);

  const auditCount = async (action: string, tenantId = tenantAId): Promise<number> => {
    const r = await one(
      migratorDb,
      sql`select count(*)::int n from audit_logs where tenant_id = ${tenantId} and action = ${action}`,
    );
    return Number(r.n);
  };

  const outboxCount = async (eventType: string, tenantId = tenantAId): Promise<number> => {
    const r = await one(
      migratorDb,
      sql`select count(*)::int n from outbox_events where tenant_id = ${tenantId} and event_type = ${eventType}`,
    );
    return Number(r.n);
  };

  /** Number of live attendance rows for a student/date — the uniqueness fact. */
  const dayRowCount = async (tenantId: string, studentId: string, date: string): Promise<number> => {
    const r = await one(
      migratorDb,
      sql`select count(*)::int n from attendance_days
            where tenant_id = ${tenantId} and student_id = ${studentId}
              and attendance_date = ${date} and deleted_at is null`,
    );
    return Number(r.n);
  };

  const insertDayRow = async (tenantId: string, studentId: string, date: string, markedBy: string) =>
    rows(
      migratorDb,
      sql`insert into attendance_days (id, tenant_id, student_id, attendance_date, status, source, marked_by, campus_id)
          values (${randomUUID()}, ${tenantId}, ${studentId}, ${date}, 'present', 'manual', ${markedBy}, ${campusAId})`,
    );

  beforeAll(async () => {
    const env = getEnv();
    const mig = createDb({ url: env.DATABASE_URL_MIGRATOR });
    const app_ = createDb({ url: env.DATABASE_URL_APP });
    migratorDb = mig.db;
    appDb = app_.db;
    endMigrator = () => mig.pool.end();
    endApp = () => app_.pool.end();
    redis = createRedis();
    endRedis = () => redis.quit();
    await redis.connect();

    for (const key of ['owner', 'teacher', 'teacherTwo', 'parent', 'reader', 'outsider', 'insider', 'platRole']) {
      uid[key] = randomUUID();
    }
    await rows(
      migratorDb,
      sql`insert into roles (id, scope, code, name, is_system) values (${uid.platRole}, 'platform', ${`p5${slug}_plat`}, 'P5 Platform Admin', true)`,
    );
    await rows(
      migratorDb,
      sql`insert into role_permissions (role_id, permission) values (${uid.platRole}, 'platform.tenants.read'), (${uid.platRole}, 'platform.tenants.create')`,
    );
    await rows(
      migratorDb,
      sql`insert into users (id, email) values
        (${uid.owner}, ${`o-${slug}@example.com`}),
        (${uid.teacher}, ${`te-${slug}@example.com`}),
        (${uid.teacherTwo}, ${`t2-${slug}@example.com`}),
        (${uid.parent}, ${`pa-${slug}@example.com`}),
        (${uid.reader}, ${`re-${slug}@example.com`}),
        (${uid.outsider}, ${`ou-${slug}@example.com`}),
        (${uid.insider}, ${`in-${slug}@example.com`})`,
    );
    await rows(
      migratorDb,
      sql`insert into platform_role_assignments (user_id, role_id) values (${uid.owner}, ${uid.platRole})`,
    );

    const platformCtx = (userId: string): RequestContext => ({
      requestId: randomUUID(),
      userId,
      scope: 'platform',
      tenantId: null,
      membershipId: null,
      campusId: null,
      roleIds: [uid.platRole!],
      permissions: new Set(['platform.tenants.create', 'platform.tenants.read']),
      platformAccess: true,
      isSystem: false,
    });
    const createdA = await withTenant(appDb, platformCtx(uid.owner!), (tx) =>
      createTenantTransaction(tx, platformCtx(uid.owner!), {
        slug: `${slug}-a`,
        name: 'P5 A',
        requestId: randomUUID(),
      }),
    );
    tenantAId = createdA.tenantId;
    // Tenant B is created through the SAME transaction so it gets the seeded
    // role catalog (school_owner, teacher, parent, ...) that Phase 5 relies on.
    const createdB = await withTenant(appDb, platformCtx(uid.owner!), (tx) =>
      createTenantTransaction(tx, platformCtx(uid.owner!), {
        slug: `${slug}-b`,
        name: 'P5 B',
        requestId: randomUUID(),
      }),
    );
    tenantBId = createdB.tenantId;

    const roleIdOf = async (tenantId: string, code: string) =>
      String((await one(migratorDb, sql`select id from roles where tenant_id = ${tenantId} and code = ${code}`)).id);
    const ownerRoleId = await roleIdOf(tenantAId, 'school_owner');
    const teacherRoleId = await roleIdOf(tenantAId, 'teacher');
    const parentRoleId = await roleIdOf(tenantAId, 'parent');
    const ownerRoleIdB = await roleIdOf(tenantBId, 'school_owner');

    // Custom roles: attendance.read only, and no attendance permission at all.
    uid.roleReader = randomUUID();
    uid.roleOutsider = randomUUID();
    await rows(
      migratorDb,
      sql`insert into roles (id, tenant_id, scope, code, name, is_system) values
        (${uid.roleReader}, ${tenantAId}, 'tenant', 'attendance_reader', 'Attendance Reader', false),
        (${uid.roleOutsider}, ${tenantAId}, 'tenant', 'attendance_outsider', 'Attendance Outsider', false)`,
    );
    await rows(
      migratorDb,
      sql`insert into role_permissions (role_id, permission)
          values (${uid.roleReader}, 'attendance.read'),
                 (${uid.roleOutsider}, 'tenant.read')`,
    );

    const member = async (tenantId: string, userId: string, roleId: string) => {
      const id = randomUUID();
      await rows(
        migratorDb,
        sql`insert into memberships (id, tenant_id, user_id, status) values (${id}, ${tenantId}, ${userId}, 'active')`,
      );
      await rows(
        migratorDb,
        sql`insert into membership_roles (membership_id, role_id) values (${id}, ${roleId})`,
      );
      return id;
    };
    // NOTE: the platform owner already has a school_owner membership in each
    // tenant (created by createTenantTransaction) — adding one again would
    // violate memberships_user_tenant_uq.
    await member(tenantAId, uid.teacher!, teacherRoleId);
    await member(tenantAId, uid.teacherTwo!, teacherRoleId);
    await member(tenantAId, uid.parent!, parentRoleId);
    await member(tenantAId, uid.reader!, String(uid.roleReader));
    await member(tenantAId, uid.outsider!, String(uid.roleOutsider));
    // `insider` is a school owner of the OTHER tenant — used to prove isolation.
    await member(tenantBId, uid.insider!, ownerRoleIdB);

    sessions.owner = await makeSession(uid.owner!, tenantAId);
    sessions.teacher = await makeSession(uid.teacher!, tenantAId);
    sessions.teacherTwo = await makeSession(uid.teacherTwo!, tenantAId);
    sessions.parent = await makeSession(uid.parent!, tenantAId);
    sessions.reader = await makeSession(uid.reader!, tenantAId);
    sessions.outsider = await makeSession(uid.outsider!, tenantAId);
    sessions.insider = await makeSession(uid.insider!, tenantBId);

    app = await buildApp({ deps: { db: appDb, redis, storage: stubStorage }, logger: false });

    // Dates are derived from the DATABASE clock so the tests agree with the
    // `current_date` the 0014 triggers compare against.
    today = String(
      (
        await one(
          migratorDb,
          sql`select to_char(current_date, 'YYYY-MM-DD') d`,
        )
      ).d,
    );
    yesterday = String(
      (
        await one(
          migratorDb,
          sql`select to_char(current_date - 1, 'YYYY-MM-DD') d`,
        )
      ).d,
    );
    tomorrow = String(
      (
        await one(
          migratorDb,
          sql`select to_char(current_date + 1, 'YYYY-MM-DD') d`,
        )
      ).d,
    );

    const mkCampus = async (code: string, name: string, key: string) => {
      const res = await inject('POST', '/api/v1/campuses', {
        headers: { ...withCsrf(sessions.owner), ...idem(`cp-${key}-${slug}`) },
        payload: { code, name },
      });
      expect(res.statusCode).toBe(201);
      return (res.json().campus as { id: string }).id;
    };
    campusAId = await mkCampus(`ca-${slug}`, 'Campus Alpha', 'a');

    const year = await inject('POST', '/api/v1/academic-years', {
      headers: { ...withCsrf(sessions.owner), ...idem(`yr-${slug}`) },
      payload: { code: `ay-${slug}`, name: 'AY', startsOn: '2026-01-01', endsOn: '2026-12-31' },
    });
    expect(year.statusCode).toBe(201);
    yearAId = (year.json().academicYear as { id: string }).id;

    const mkClass = async (code: string, name: string, key: string) => {
      const res = await inject('POST', '/api/v1/classes', {
        headers: { ...withCsrf(sessions.owner), ...idem(`cl-${key}-${slug}`) },
        payload: { campusId: campusAId, academicYearId: yearAId, code, name },
      });
      expect(res.statusCode).toBe(201);
      return (res.json().class as { id: string }).id;
    };
    classAId = await mkClass(`c1-${slug}`, 'Class One', 'a');
    classBId = await mkClass(`c2-${slug}`, 'Class Two', 'b');

    const mkSection = async (classId: string, code: string, key: string) => {
      const res = await inject('POST', `/api/v1/classes/${classId}/sections`, {
        headers: { ...withCsrf(sessions.owner), ...idem(`se-${key}-${slug}`) },
        payload: { code },
      });
      expect(res.statusCode).toBe(201);
      return (res.json().section as { id: string }).id;
    };
    sectionAId = await mkSection(classAId, `sa-${slug}`, 'a');
    sectionBId = await mkSection(classBId, `sb-${slug}`, 'b');

    const period = await inject('POST', '/api/v1/periods', {
      headers: { ...withCsrf(sessions.owner), ...idem(`pe-${slug}`) },
      payload: {
        name: 'Period 1',
        periodNo: 1,
        startTime: '08:00',
        endTime: '08:45',
        campusId: campusAId,
      },
    });
    expect(period.statusCode).toBe(201);
    periodAId = (period.json().period as { id: string }).id;

    subjectAId = (
      await inject('POST', '/api/v1/subjects', {
        headers: { ...withCsrf(sessions.owner), ...idem(`sb-${slug}`) },
        payload: { code: `sb-${slug}`, name: 'Subject' },
      })
    ).json().subject.id as string;
    for (const [classId, subjectId, teacherUserId, key] of [
      [classAId, subjectAId, uid.teacher!, 'aa'],
      [classBId, subjectAId, uid.teacherTwo!, 'bb'],
    ] as const) {
      const link = await inject('POST', `/api/v1/classes/${classId}/subjects/${subjectId}`, {
        headers: { ...withCsrf(sessions.owner), ...idem(`cs-${key}-${slug}`) },
        payload: {},
      });
      expect(link.statusCode).toBe(201);
      const assign = await inject('POST', `/api/v1/classes/${classId}/subjects/${subjectId}/teachers`, {
        headers: { ...withCsrf(sessions.owner), ...idem(`ta-${key}-${slug}`) },
        payload: { teacherUserId },
      });
      expect(assign.statusCode).toBe(201);
    }

    const mkStudent = async (
      tenantId: string,
      studentNo: string,
      firstName: string,
      campusId: string | null = campusAId,
    ) => {
      const id = randomUUID();
      await rows(
        migratorDb,
        sql`insert into students (id, tenant_id, student_no, first_name, last_name, status, primary_campus_id)
            values (${id}, ${tenantId}, ${studentNo}, ${firstName}, 'Test', 'active', ${campusId})`,
      );
      return id;
    };
    const enroll = async (tenantId: string, studentId: string, classId: string, sectionId: string, roll: string) =>
      rows(
        migratorDb,
        sql`insert into enrollments (id, tenant_id, student_id, academic_year_id, class_id, section_id, status, roll_no)
            values (${randomUUID()}, ${tenantId}, ${studentId}, ${yearAId}, ${classId}, ${sectionId}, 'active', ${roll})`,
      );

    childParent = await mkStudent(tenantAId, `pa-${slug}`, 'Kid');
    await enroll(tenantAId, childParent, classAId, sectionAId, `r1-${slug}`);
    const guardianId = randomUUID();
    await rows(
      migratorDb,
      sql`insert into guardians (id, tenant_id, user_id, first_name, last_name)
          values (${guardianId}, ${tenantAId}, ${uid.parent}, 'Guardian', 'Parent')`,
    );
    await rows(
      migratorDb,
      sql`insert into student_guardians (id, tenant_id, student_id, guardian_id, relation, is_primary)
          values (${randomUUID()}, ${tenantAId}, ${childParent}, ${guardianId}, 'parent', true)`,
    );

    childOther = await mkStudent(tenantAId, `ot-${slug}`, 'Other');
    await enroll(tenantAId, childOther, classAId, sectionAId, `r2-${slug}`);

    childTeacherTwo = await mkStudent(tenantAId, `tt-${slug}`, 'Third');
    await enroll(tenantAId, childTeacherTwo, classBId, sectionBId, `r3-${slug}`);

    // Used ONLY by the period-marking proofs so the insert/correct split is
    // deterministic and independent of the daily-mark fixtures.
    childPeriod = await mkStudent(tenantAId, `pe-${slug}`, 'Fourth');
    await enroll(tenantAId, childPeriod, classAId, sectionAId, `r4-${slug}`);

    foreignStudent = await mkStudent(tenantBId, `fb-${slug}`, 'Foreign', null);

    const lt = await inject('POST', '/api/v1/leave-types', {
      headers: { ...withCsrf(sessions.owner), ...idem(`lt-${slug}`) },
      payload: { code: 'medical', name: 'Medical' },
    });
    expect(lt.statusCode).toBe(201);
    leaveTypeId = (lt.json().leaveType as { id: string }).id;
  });

  afterAll(async () => {
    try {
      if (app) await app.close();
      for (const tenantId of [tenantAId, tenantBId]) {
        const tIn = `'${tenantId}'`;
        await rows(migratorDb, sql`delete from attendance_periods where tenant_id in (${sql.raw(tIn)})`);
        await rows(migratorDb, sql`delete from attendance_days where tenant_id in (${sql.raw(tIn)})`);
        await rows(migratorDb, sql`delete from staff_attendance where tenant_id in (${sql.raw(tIn)})`);
        await rows(migratorDb, sql`delete from leave_requests where tenant_id in (${sql.raw(tIn)})`);
        await rows(migratorDb, sql`delete from leave_types where tenant_id in (${sql.raw(tIn)})`);
        await rows(migratorDb, sql`delete from teacher_assignments where tenant_id in (${sql.raw(tIn)})`);
        await rows(migratorDb, sql`delete from class_subjects where tenant_id in (${sql.raw(tIn)})`);
        await rows(migratorDb, sql`delete from enrollments where tenant_id in (${sql.raw(tIn)})`);
        await rows(migratorDb, sql`delete from sections where tenant_id in (${sql.raw(tIn)})`);
        await rows(migratorDb, sql`delete from student_guardians where tenant_id in (${sql.raw(tIn)})`);
        await rows(migratorDb, sql`delete from students where tenant_id in (${sql.raw(tIn)})`);
        await rows(migratorDb, sql`delete from guardians where tenant_id in (${sql.raw(tIn)})`);
        await rows(migratorDb, sql`delete from acd_classes where tenant_id in (${sql.raw(tIn)})`);
        await rows(migratorDb, sql`delete from periods where tenant_id in (${sql.raw(tIn)})`);
        await rows(migratorDb, sql`delete from subjects where tenant_id in (${sql.raw(tIn)})`);
        await rows(migratorDb, sql`delete from outbox_events where tenant_id in (${sql.raw(tIn)})`);
        await rows(migratorDb, sql`delete from idempotency_keys where tenant_id in (${sql.raw(tIn)})`);
        await rows(migratorDb, sql`delete from audit_logs where tenant_id in (${sql.raw(tIn)})`);
        await rows(migratorDb, sql`delete from academic_years where tenant_id in (${sql.raw(tIn)})`);
        await rows(migratorDb, sql`delete from campuses where tenant_id in (${sql.raw(tIn)})`);
      }
      await rows(
        migratorDb,
        sql`delete from membership_roles where membership_id in (
              select id from memberships
              where user_id in (${uid.owner}, ${uid.teacher}, ${uid.teacherTwo}, ${uid.parent}, ${uid.reader}, ${uid.outsider}, ${uid.insider})
                 or tenant_id in (${tenantAId}, ${tenantBId}))`,
      );
      await rows(
        migratorDb,
        sql`delete from memberships
            where user_id in (${uid.owner}, ${uid.teacher}, ${uid.teacherTwo}, ${uid.parent}, ${uid.reader}, ${uid.outsider}, ${uid.insider})
               or tenant_id in (${tenantAId}, ${tenantBId})`,
      );
      await rows(migratorDb, sql`delete from platform_role_assignments where user_id = ${uid.owner}`);
      await rows(
        migratorDb,
        sql`delete from role_permissions where role_id in (select id from roles where tenant_id in (${tenantAId}, ${tenantBId}) or id = ${uid.platRole} or id in (${uid.roleReader}, ${uid.roleOutsider}))`,
      );
      await rows(
        migratorDb,
        sql`delete from roles where tenant_id in (${tenantAId}, ${tenantBId}) or id in (${uid.platRole}, ${uid.roleReader}, ${uid.roleOutsider})`,
      );
      await rows(migratorDb, sql`delete from tenants where slug in (${`${slug}-a`}, ${`${slug}-b`})`);
      await rows(migratorDb, sql`delete from users where email like ${`%-${slug}@example.com`}`);
    } finally {
      await endRedis();
      await endApp();
      await endMigrator();
    }
  });

  // ------------------------------------------------------------------ A. gate
  describe('Phase 5 route gate and permission separation', () => {
    it('requires a session on every Phase 5 read', async () => {
      for (const url of [
        '/api/v1/attendance',
        '/api/v1/attendance/periods',
        '/api/v1/attendance/reports/class?sectionId=' + sectionAId + '&date=' + today,
        '/api/v1/staff-attendance',
        '/api/v1/leave-requests',
        '/api/v1/leave-types',
        '/api/v1/me/attendance-context',
        '/api/v1/me/attendance',
      ]) {
        const res = await app.inject({ method: 'GET', url });
        expect(res.statusCode, url).toBe(401);
      }
    });

    it('requires attendance.read for a member without any attendance permission', async () => {
      for (const url of ['/api/v1/attendance', '/api/v1/leave-requests', '/api/v1/me/attendance']) {
        const res = await injectAs(sessions.outsider, 'GET', url);
        expect(res.statusCode, url).toBe(403);
        expect(envelope(res)?.requiredPermission).toBe('attendance.read');
      }
    });

    it('attendance.mark is a SEPARATE grant from attendance.read (parent has read only)', async () => {
      const read = await injectAs(sessions.parent, 'GET', '/api/v1/attendance');
      expect(read.statusCode).toBe(200);

      const mark = await injectAs(sessions.parent, 'POST', '/api/v1/attendance/mark', {
        headers: { ...withCsrf(sessions.parent), ...idem(`p5-parent-mark-${slug}`) },
        payload: { date: today, entries: [{ studentId: childParent, status: 'present' }] },
      });
      expect(mark.statusCode).toBe(403);
      expect(envelope(mark)?.requiredPermission).toBe('attendance.mark');

      const staffMark = await injectAs(sessions.parent, 'POST', '/api/v1/staff-attendance/mark', {
        headers: { ...withCsrf(sessions.parent), ...idem(`p5-parent-staff-${slug}`) },
        payload: { userId: uid.teacher!, date: today, status: 'present' },
      });
      expect(staffMark.statusCode).toBe(403);
      expect(envelope(staffMark)?.requiredPermission).toBe('attendance.mark');
    });

    it('attendance.approve_leave is NOT granted to a teacher (mark without decide)', async () => {
      const res = await injectAs(sessions.teacher, 'POST', `/api/v1/leave-requests/${randomUUID()}/approve`, {
        headers: { ...withCsrf(sessions.teacher), ...idem(`p5-teach-approve-${slug}`) },
        payload: {},
      });
      expect(res.statusCode).toBe(403);
      expect(envelope(res)?.requiredPermission).toBe('attendance.approve_leave');
    });

    it('attendance.request_leave is not granted to a bare attendance.read holder', async () => {
      const res = await injectAs(sessions.reader, 'POST', '/api/v1/leave-requests', {
        headers: { ...withCsrf(sessions.reader), ...idem(`p5-reader-file-${slug}`) },
        payload: { studentId: childOther, leaveTypeId, startDate: today, endDate: today },
      });
      expect(res.statusCode).toBe(403);
      expect(envelope(res)?.requiredPermission).toBe('attendance.request_leave');
    });

    it('rejects a write without a CSRF token', async () => {
      const res = await inject('POST', '/api/v1/attendance/mark', {
        headers: idem(`p5-nocsrf-${slug}`),
        payload: { date: today, entries: [{ studentId: childOther, status: 'present' }] },
      });
      expect(res.statusCode).toBe(403);
    });
  });

  // ------------------------------------------------------- B. uniqueness
  describe('Phase 5 uniqueness is enforced by the database', () => {
    it('a second daily row for the same (tenant, student, date) raises 23505', async () => {
      await insertDayRow(tenantAId, childOther, today, uid.owner!);
      await expect(insertDayRow(tenantAId, childOther, today, uid.owner!)).rejects.toMatchObject({
        code: '23505',
        constraint: 'attendance_days_tenant_student_date_uq',
      });
      expect(await dayRowCount(tenantAId, childOther, today)).toBe(1);
    });

    it('a second period row for the same (tenant, student, date, period) raises 23505', async () => {
      const insert = () =>
        rows(
          migratorDb,
          sql`insert into attendance_periods (id, tenant_id, student_id, section_id, period_id, attendance_date, status, marked_by)
              values (${randomUUID()}, ${tenantAId}, ${childOther}, ${sectionAId}, ${periodAId}, ${today}, 'present', ${uid.owner})`,
        );
      await insert();
      await expect(insert()).rejects.toMatchObject({
        code: '23505',
        constraint: 'attendance_periods_tenant_student_date_period_uq',
      });
    });

    it('a second staff row for the same (tenant, user, date) raises 23505', async () => {
      const insert = () =>
        rows(
          migratorDb,
          sql`insert into staff_attendance (id, tenant_id, user_id, attendance_date, status)
              values (${randomUUID()}, ${tenantAId}, ${uid.teacher}, ${today}, 'present')`,
        );
      await insert();
      await expect(insert()).rejects.toMatchObject({
        code: '23505',
        constraint: 'staff_attendance_unique_day',
      });
    });

    it('a duplicate leave type code raises 23505', async () => {
      const res = await inject('POST', '/api/v1/leave-types', {
        headers: { ...withCsrf(sessions.owner), ...idem(`lt-dup-${slug}`) },
        payload: { code: 'medical', name: 'Medical again' },
      });
      expect(res.statusCode).toBe(409);
      expect(envelope(res)?.code).toBe('leave_type_code_taken');
    });

    it('the API resolves a repeated mark as an UPDATE, never a duplicate row', async () => {
      const first = await inject('POST', '/api/v1/attendance/mark', {
        headers: { ...withCsrf(sessions.owner), ...idem(`p5-mk-1-${slug}`) },
        payload: { date: today, entries: [{ studentId: childParent, status: 'present' }] },
      });
      expect(first.statusCode).toBe(200);
      expect(first.json().attendance).toMatchObject({ marked: 1, inserted: 1, corrected: 0 });

      const second = await inject('POST', '/api/v1/attendance/mark', {
        headers: { ...withCsrf(sessions.owner), ...idem(`p5-mk-2-${slug}`) },
        payload: { date: today, entries: [{ studentId: childParent, status: 'late' }] },
      });
      expect(second.statusCode).toBe(200);
      expect(second.json().attendance).toMatchObject({ marked: 1, inserted: 0, corrected: 1 });
      expect(await dayRowCount(tenantAId, childParent, today)).toBe(1);
    });

    it('honours the idempotency key: a replayed identical mark is served from the key', async () => {
      const key = idem(`p5-idem-${slug}`);
      const payload = {
        date: today,
        entries: [{ studentId: childOther, status: 'excused' }],
      };
      const a = await inject('POST', '/api/v1/attendance/mark', {
        headers: { ...withCsrf(sessions.owner), ...key },
        payload,
      });
      const b = await inject('POST', '/api/v1/attendance/mark', {
        headers: { ...withCsrf(sessions.owner), ...key },
        payload,
      });
      expect(a.statusCode).toBe(200);
      expect(b.statusCode).toBe(200);
      expect(b.json().attendance).toEqual(a.json().attendance);
      // childOther already has a manual row from the uniqueness proof above, so
      // the single live row is still the only one.
      expect(await dayRowCount(tenantAId, childOther, today)).toBe(1);
    });
  });

  // ------------------------------------------- C. same-day correction rules
  describe('Phase 5 same-day correction rules', () => {
    it('correcting TODAY succeeds and writes an attendance.corrected audit row', async () => {
      const before = await auditCount('attendance.corrected');
      const list = await inject('GET', `/api/v1/attendance?date=${today}&studentId=${childParent}`);
      const id = (list.json().items as { id: string }[])[0]!.id;

      const res = await inject('PATCH', `/api/v1/attendance/${id}/correct`, {
        headers: { ...withCsrf(sessions.owner), ...idem(`p5-cor-1-${slug}`) },
        payload: { status: 'absent', reason: 'Register was taken against the wrong section' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().attendance).toMatchObject({ status: 'absent' });
      expect(await auditCount('attendance.corrected')).toBe(before + 1);
    });

    it('a correction without a reason never reaches the database', async () => {
      const list = await inject('GET', `/api/v1/attendance?date=${today}&studentId=${childParent}`);
      const id = (list.json().items as { id: string }[])[0]!.id;
      const res = await inject('PATCH', `/api/v1/attendance/${id}/correct`, {
        headers: { ...withCsrf(sessions.owner), ...idem(`p5-cor-noreason-${slug}`) },
        payload: { status: 'present' },
      });
      expect(res.statusCode).toBe(400);
      expect(envelope(res)?.code).toBe('validation_error');
    });

    it('a PAST-day row cannot be corrected (0014 same-day trigger)', async () => {
      // Seed a past row directly as the owner (marking a past date is allowed;
      // only CORRECTION is same-day restricted).
      await insertDayRow(tenantAId, childTeacherTwo, yesterday, uid.owner!);
      const list = await inject('GET', `/api/v1/attendance?date=${yesterday}&studentId=${childTeacherTwo}`);
      const id = (list.json().items as { id: string }[])[0]!.id;

      const res = await inject('PATCH', `/api/v1/attendance/${id}/correct`, {
        headers: { ...withCsrf(sessions.owner), ...idem(`p5-cor-past-${slug}`) },
        payload: { status: 'late', reason: 'Late arrival noticed the next morning' },
      });
      expect(res.statusCode).toBe(409);
      expect(envelope(res)?.code).toBe('attendance_correction_window_closed');
    });

    it('a future date cannot be marked at all', async () => {
      const res = await inject('POST', '/api/v1/attendance/mark', {
        headers: { ...withCsrf(sessions.owner), ...idem(`p5-future-${slug}`) },
        payload: { date: tomorrow, entries: [{ studentId: childParent, status: 'present' }] },
      });
      expect(res.statusCode).toBe(409);
      expect(envelope(res)?.code).toBe('attendance_future_date');
    });

    it('the attendance date is immutable (correction cannot move a row)', async () => {
      const list = await inject('GET', `/api/v1/attendance?date=${today}&studentId=${childParent}`);
      const id = (list.json().items as { id: string }[])[0]!.id;
      await expect(
        rows(
          migratorDb,
          sql`update attendance_days set attendance_date = ${yesterday} where id = ${id}`,
        ),
      ).rejects.toMatchObject({ code: '55000' });
    });

    it('a period row bound to its section/period cannot be re-pointed', async () => {
      const marked = await inject('POST', '/api/v1/attendance/periods/mark', {
        headers: { ...withCsrf(sessions.owner), ...idem(`p5-per-1-${slug}`) },
        payload: {
          sectionId: sectionAId,
          periodId: periodAId,
          date: today,
          entries: [
            { studentId: childPeriod, status: 'present' },
            { studentId: childParent, status: 'absent' },
          ],
        },
      });
      expect(marked.statusCode).toBe(200);
      expect(marked.json().attendance).toMatchObject({ marked: 2, inserted: 2, corrected: 0 });

      const id = (marked.json().attendance.items as { id: string }[])[0]!.id;
      await expect(
        rows(
          migratorDb,
          sql`update attendance_periods set section_id = ${sectionBId} where id = ${id}`,
        ),
      ).rejects.toMatchObject({ code: '55000' });
    });

    it('period marking refuses a student who is not enrolled in the section', async () => {
      const res = await inject('POST', '/api/v1/attendance/periods/mark', {
        headers: { ...withCsrf(sessions.owner), ...idem(`p5-per-bad-${slug}`) },
        payload: {
          sectionId: sectionAId,
          periodId: periodAId,
          date: today,
          entries: [{ studentId: childTeacherTwo, status: 'present' }],
        },
      });
      expect(res.statusCode).toBe(409);
      expect(envelope(res)?.code).toBe('attendance_not_enrolled');
    });
  });

  // ------------------------------------------- D. parent own-children scope
  describe('Phase 5 parent own-children scope', () => {
    it('a parent sees ONLY their guardianship-linked child in the list', async () => {
      const res = await injectAs(sessions.parent, 'GET', `/api/v1/attendance?date=${today}`);
      expect(res.statusCode).toBe(200);
      const items = res.json().items as { studentId: string }[];
      expect(items.length).toBeGreaterThan(0);
      expect(new Set(items.map((i) => i.studentId))).toEqual(new Set([childParent]));
    });

    it('a parent asking for another family\'s child gets 404, never data', async () => {
      const res = await injectAs(
        sessions.parent,
        'GET',
        `/api/v1/attendance/reports/student?studentId=${childOther}&from=${today}&to=${today}`,
      );
      expect(res.statusCode).toBe(404);
      expect(res.json()).not.toHaveProperty('counts');
    });

    it('a parent sees only their child in the portal context and portal read', async () => {
      const ctxRes = await injectAs(sessions.parent, 'GET', '/api/v1/me/attendance-context');
      expect(ctxRes.statusCode).toBe(200);
      const context = (ctxRes.json() as { context: AttendanceContext }).context;
      expect(context.role).toBe('parent');
      expect(context.students.map((s) => s.id)).toEqual([childParent]);

      const view = await injectAs(
        sessions.parent,
        'GET',
        `/api/v1/me/attendance?from=${today}&to=${today}`,
      );
      expect(view.statusCode).toBe(200);
      const portal = view.json() as AttendancePortalResponse;
      expect(portal.views).toHaveLength(1);
      expect(portal.views[0]!.student.id).toBe(childParent);
      expect(portal.views[0]!.counts.absent).toBeGreaterThanOrEqual(1);
    });

    it('a parent may NOT read a section register (it would expose classmates)', async () => {
      // A section register lists EVERY enrolled student, so it is a
      // teacher/admin surface. A parent's own child's attendance is served by
      // /me/attendance instead — never the whole class.
      for (const sectionId of [sectionAId, sectionBId]) {
        const res = await injectAs(
          sessions.parent,
          'GET',
          `/api/v1/attendance/reports/class?sectionId=${sectionId}&date=${today}`,
        );
        expect(res.statusCode, sectionId).toBe(403);
        expect(envelope(res)?.code).toBe('attendance_scope_denied');
      }
    });

    it("a parent's own-child data comes from the self-scoped portal, not a class view", async () => {
      const report = await injectAs(
        sessions.parent,
        'GET',
        `/api/v1/attendance/reports/student?studentId=${childParent}&from=${today}&to=${today}`,
      );
      expect(report.statusCode).toBe(200);
      const body = report.json() as AttendanceStudentReportResponse;
      expect(body.studentId).toBe(childParent);
      expect(body.counts.present + body.counts.absent + body.counts.late + body.counts.excused).toBeGreaterThan(0);
    });
  });

  // ------------------------------------------- E. teacher + campus scope
  describe('Phase 5 teacher mark scope', () => {
    it('a teacher may mark their own class roster', async () => {
      const roster = await injectAs(
        sessions.teacher,
        'GET',
        `/api/v1/attendance/reports/class?sectionId=${sectionAId}&date=${today}`,
      );
      expect(roster.statusCode).toBe(200);
      const res = await injectAs(sessions.teacher, 'POST', '/api/v1/attendance/mark', {
        headers: { ...withCsrf(sessions.teacher), ...idem(`p5-teach-mark-${slug}`) },
        payload: {
          date: today,
          entries: [
            { studentId: childParent, status: 'present' },
            { studentId: childOther, status: 'present' },
          ],
        },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().attendance.marked).toBe(2);
    });

    it('a teacher may NOT mark a student from another teacher\'s class', async () => {
      const res = await injectAs(sessions.teacher, 'POST', '/api/v1/attendance/mark', {
        headers: { ...withCsrf(sessions.teacher), ...idem(`p5-teach-cross-${slug}`) },
        payload: { date: today, entries: [{ studentId: childTeacherTwo, status: 'present' }] },
      });
      expect(res.statusCode).toBe(403);
      expect(envelope(res)?.code).toBe('attendance_scope_denied');
    });

    it('a teacher may not mark a period for a section they do not teach', async () => {
      const res = await injectAs(sessions.teacher, 'POST', '/api/v1/attendance/periods/mark', {
        headers: { ...withCsrf(sessions.teacher), ...idem(`p5-teach-per-cross-${slug}`) },
        payload: {
          sectionId: sectionBId,
          periodId: periodAId,
          date: today,
          entries: [{ studentId: childTeacherTwo, status: 'present' }],
        },
      });
      expect(res.statusCode).toBe(403);
      expect(envelope(res)?.code).toBe('attendance_scope_denied');
    });
  });

  // ------------------------------------------- F. tenant isolation
  describe('Phase 5 tenant isolation', () => {
    it("a tenant B owner sees only tenant B's own students", async () => {
      const ctxRes = await injectAs(sessions.insider, 'GET', '/api/v1/me/attendance-context');
      expect(ctxRes.statusCode).toBe(200);
      const context = (ctxRes.json() as { context: AttendanceContext }).context;
      // Tenant B has exactly one student of its own; none of tenant A's appear.
      expect(context.students.map((s) => s.id)).toEqual([foreignStudent]);
      expect(context.students.map((s) => s.id)).not.toContain(childParent);

      const list = await injectAs(sessions.insider, 'GET', `/api/v1/attendance?date=${today}`);
      expect(list.statusCode).toBe(200);
      expect(list.json().total).toBe(0);
    });

    it("a tenant B owner cannot mark or report on a tenant A student", async () => {
      const mark = await injectAs(sessions.insider, 'POST', '/api/v1/attendance/mark', {
        headers: { ...withCsrf(sessions.insider), ...idem(`p5-ins-mark-${slug}`) },
        payload: { date: today, entries: [{ studentId: childParent, status: 'absent' }] },
      });
      expect(mark.statusCode).toBe(404);

      const report = await injectAs(
        sessions.insider,
        'GET',
        `/api/v1/attendance/reports/student?studentId=${childParent}&from=${today}&to=${today}`,
      );
      expect(report.statusCode).toBe(404);
    });

    it('RLS holds even for a direct migrator-role read of another tenant id', async () => {
      // The app role is tenant-scoped by RLS; the migrator role is not, so this
      // asserts the row count for the OTHER tenant is exactly what it wrote.
      const r = await one(
        migratorDb,
        sql`select count(*)::int n from attendance_days where tenant_id = ${tenantBId}`,
      );
      expect(Number(r.n)).toBe(0);
      const foreign = await one(
        migratorDb,
        sql`select count(*)::int n from students where tenant_id = ${tenantBId}`,
      );
      expect(Number(foreign.n)).toBe(1);
    });
  });

  // ------------------------------------------- G. staff attendance
  describe('Phase 5 staff attendance (light)', () => {
    it('marks a staff member and is idempotent on a repeat mark', async () => {
      const first = await inject('POST', '/api/v1/staff-attendance/mark', {
        headers: { ...withCsrf(sessions.owner), ...idem(`p5-staff-1-${slug}`) },
        payload: {
          userId: uid.teacher!,
          date: today,
          status: 'present',
          clockIn: `${today}T08:05:00.000Z`,
          clockOut: `${today}T16:00:00.000Z`,
        },
      });
      expect(first.statusCode).toBe(200);
      expect(first.json().attendance).toMatchObject({ status: 'present' });

      const second = await inject('POST', '/api/v1/staff-attendance/mark', {
        headers: { ...withCsrf(sessions.owner), ...idem(`p5-staff-2-${slug}`) },
        payload: { userId: uid.teacher!, date: today, status: 'on_leave' },
      });
      expect(second.statusCode).toBe(200);
      const list = await inject('GET', `/api/v1/staff-attendance?date=${today}&userId=${uid.teacher}`);
      expect(list.json().total).toBe(1);
      expect((list.json().items as { status: string }[])[0]!.status).toBe('on_leave');
    });

    it('refuses a staff clock-out before clock-in', async () => {
      const res = await inject('POST', '/api/v1/staff-attendance/mark', {
        headers: { ...withCsrf(sessions.owner), ...idem(`p5-staff-order-${slug}`) },
        payload: {
          userId: uid.teacherTwo!,
          date: today,
          status: 'present',
          clockIn: `${today}T16:00:00.000Z`,
          clockOut: `${today}T08:00:00.000Z`,
        },
      });
      expect(res.statusCode).toBe(409);
      expect(envelope(res)?.code).toBe('staff_attendance_clock_order');
    });

    it('refuses a staff row for a non-member of the tenant', async () => {
      const res = await inject('POST', '/api/v1/staff-attendance/mark', {
        headers: { ...withCsrf(sessions.owner), ...idem(`p5-staff-outsider-${slug}`) },
        payload: { userId: foreignStudent, date: today, status: 'present' },
      });
      expect(res.statusCode).toBe(409);
      expect(envelope(res)?.code).toBe('staff_attendance_membership_inactive');
    });
  });

  // ------------------------------------------- H. leave lifecycle
  describe('Phase 5 leave request lifecycle', () => {
    it('a parent files leave for their own child as pending', async () => {
      const res = await injectAs(sessions.parent, 'POST', '/api/v1/leave-requests', {
        headers: { ...withCsrf(sessions.parent), ...idem(`p5-file-1-${slug}`) },
        payload: {
          studentId: childParent,
          leaveTypeId,
          startDate: today,
          endDate: tomorrow,
          reason: 'Fever',
        },
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().leaveRequest).toMatchObject({
        status: 'pending',
        requestedBy: uid.parent,
        approverUserId: null,
        decisionAt: null,
      });
    });

    it('a parent may NOT file leave for another family\'s child', async () => {
      const res = await injectAs(sessions.parent, 'POST', '/api/v1/leave-requests', {
        headers: { ...withCsrf(sessions.parent), ...idem(`p5-file-stranger-${slug}`) },
        payload: { studentId: childOther, leaveTypeId, startDate: today, endDate: today },
      });
      expect(res.statusCode).toBe(403);
      expect(envelope(res)?.code).toBe('leave_scope_denied');
    });

    it('a parent may NOT file leave for a student in another tenant', async () => {
      const res = await injectAs(sessions.parent, 'POST', '/api/v1/leave-requests', {
        headers: { ...withCsrf(sessions.parent), ...idem(`p5-file-foreign-${slug}`) },
        payload: { studentId: foreignStudent, leaveTypeId, startDate: today, endDate: today },
      });
      expect(res.statusCode).toBe(404);
    });

    it('a leave request with endDate before startDate is a validation error', async () => {
      const res = await injectAs(sessions.parent, 'POST', '/api/v1/leave-requests', {
        headers: { ...withCsrf(sessions.parent), ...idem(`p5-file-range-${slug}`) },
        payload: {
          studentId: childParent,
          leaveTypeId,
          startDate: tomorrow,
          endDate: today,
        },
      });
      expect(res.statusCode).toBe(400);
      expect(envelope(res)?.code).toBe('validation_error');
    });

    it('a leave type that is not active cannot be used', async () => {
      const patched = await inject('PATCH', `/api/v1/leave-types/${leaveTypeId}`, {
        headers: { ...withCsrf(sessions.owner), ...idem(`p5-lt-inactive-${slug}`) },
        payload: { status: 'inactive' },
      });
      expect(patched.statusCode).toBe(200);
      const res = await injectAs(sessions.parent, 'POST', '/api/v1/leave-requests', {
        headers: { ...withCsrf(sessions.parent), ...idem(`p5-file-inactive-${slug}`) },
        payload: { studentId: childParent, leaveTypeId, startDate: today, endDate: today },
      });
      expect(res.statusCode).toBe(404);
      await inject('PATCH', `/api/v1/leave-types/${leaveTypeId}`, {
        headers: { ...withCsrf(sessions.owner), ...idem(`p5-lt-active-${slug}`) },
        payload: { status: 'active' },
      });
    });

    it('a leave type code is immutable', async () => {
      const res = await inject('PATCH', `/api/v1/leave-types/${leaveTypeId}`, {
        headers: { ...withCsrf(sessions.owner), ...idem(`p5-lt-code-${slug}`) },
        payload: { code: 'other' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('the owner approves a pending request exactly once', async () => {
      const list = await inject('GET', '/api/v1/leave-requests?status=pending');
      const pending = (list.json().items as { id: string }[])[0]!.id;

      const approved = await inject('POST', `/api/v1/leave-requests/${pending}/approve`, {
        headers: { ...withCsrf(sessions.owner), ...idem(`p5-approve-${slug}`) },
        payload: { note: 'Get well soon' },
      });
      expect(approved.statusCode).toBe(200);
      expect(approved.json().leaveRequest).toMatchObject({
        status: 'approved',
        approverUserId: uid.owner,
      });
      expect(approved.json().leaveRequest.decisionAt).toBeTruthy();

      const again = await inject('POST', `/api/v1/leave-requests/${pending}/approve`, {
        headers: { ...withCsrf(sessions.owner), ...idem(`p5-approve-2-${slug}`) },
        payload: {},
      });
      expect(again.statusCode).toBe(409);
      expect(envelope(again)?.code).toBe('leave_already_decided');

      const reject = await inject('POST', `/api/v1/leave-requests/${pending}/reject`, {
        headers: { ...withCsrf(sessions.owner), ...idem(`p5-reject-2-${slug}`) },
        payload: {},
      });
      expect(reject.statusCode).toBe(409);
      expect(envelope(reject)?.code).toBe('leave_already_decided');
    });

    it('a decided leave request is frozen at the database level', async () => {
      const r = await one(
        migratorDb,
        sql`select id from leave_requests where tenant_id = ${tenantAId} and status = 'approved' limit 1`,
      );
      // The decision itself can never be rewritten...
      await expect(
        rows(migratorDb, sql`update leave_requests set status = 'rejected' where id = ${r.id}`),
      ).rejects.toMatchObject({ code: '55000' });
      // ...nor its dates, its student, its type or its approver.
      await expect(
        rows(migratorDb, sql`update leave_requests set start_date = ${tomorrow} where id = ${r.id}`),
      ).rejects.toMatchObject({ code: '55000' });
      await expect(
        rows(migratorDb, sql`update leave_requests set approver_user_id = ${uid.parent} where id = ${r.id}`),
      ).rejects.toMatchObject({ code: '55000' });
    });

    it('a parent sees only their own child\'s leave requests', async () => {
      await injectAs(sessions.parent, 'POST', '/api/v1/leave-requests', {
        headers: { ...withCsrf(sessions.parent), ...idem(`p5-file-2-${slug}`) },
        payload: { studentId: childParent, leaveTypeId, startDate: today, endDate: today },
      });
      const res = await injectAs(sessions.parent, 'GET', '/api/v1/leave-requests');
      expect(res.statusCode).toBe(200);
      const items = res.json().items as { studentId: string }[];
      expect(items.length).toBeGreaterThan(0);
      expect(new Set(items.map((i) => i.studentId))).toEqual(new Set([childParent]));
    });

    it('a tenant B owner sees no leave requests from tenant A', async () => {
      const res = await injectAs(sessions.insider, 'GET', '/api/v1/leave-requests');
      expect(res.statusCode).toBe(200);
      expect(res.json().total).toBe(0);
    });

    it('a tenant B owner cannot approve a tenant A leave request', async () => {
      const list = await inject('GET', '/api/v1/leave-requests?status=pending');
      const id = (list.json().items as { id: string }[])[0]!.id;
      const res = await injectAs(sessions.insider, 'POST', `/api/v1/leave-requests/${id}/approve`, {
        headers: { ...withCsrf(sessions.insider), ...idem(`p5-ins-approve-${slug}`) },
        payload: {},
      });
      expect(res.statusCode).toBe(404);
    });
  });

  // ------------------------------------------- I. audit + outbox
  describe('Phase 5 audit and outbox coverage', () => {
    it('records attendance.marked, leave.requested and leave.approved', async () => {
      expect(await auditCount('attendance.marked')).toBeGreaterThan(0);
      expect(await auditCount('leave.requested')).toBeGreaterThan(0);
      expect(await auditCount('leave.approved')).toBeGreaterThan(0);
      expect(await outboxCount('leave.requested')).toBeGreaterThan(0);
      expect(await outboxCount('leave.approved')).toBeGreaterThan(0);
    });

    it('a leave-type deactivation is audited with old and new values', async () => {
      const r = await one(
        migratorDb,
        sql`select old_value, new_value from audit_logs
            where tenant_id = ${tenantAId} and action = 'leave.type.updated' order by occurred_at desc limit 1`,
      );
      expect(JSON.stringify(r.old_value)).toContain('inactive');
      expect(JSON.stringify(r.new_value)).toContain('active');
    });
  });
});
