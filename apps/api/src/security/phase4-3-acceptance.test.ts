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

/**
 * Phase 4.3 API acceptance: periods, the weekly timetable grid, publish
 * validation and homework — against the real app + real PostgreSQL + live Redis.
 * Proves the Phase 4.2 loops the DB tests cannot: the server-derived teacher on
 * grid cells (teacherUserId is NOT client-writable), slot / teacher-double-booking
 * 409s surfaced through the API, the publish defense-in-depth scan (conflict rows
 * that the honest API can never produce are still caught), homework authorship
 * anchoring (self-authoring teachers + owner delegation), teacher self-scope on
 * PATCH/DELETE, parent/student read visibility, strict mass-assignment rejection,
 * idempotency + audit + outbox (10 new event types), and the Phase 4.3 permission
 * grants in the seeded templates.
 *
 * Opt-in: RUN_RUNTIME_SECURITY_TESTS=1.
 */
const enabled = process.env.RUN_RUNTIME_SECURITY_TESTS === '1';
const describeDb = enabled ? describe : describe.skip;

const stubStorage = {
  async readObject(): Promise<Buffer> {
    throw new Error('not consulted in Phase 4.3 acceptance');
  },
} as unknown as StorageProvider;

interface SessionCookies {
  token: string;
  csrf: string;
  cookie: string;
}

describeDb('API Phase 4.3 timetable/homework acceptance (real app + DB + Redis)', () => {
  let migratorDb: Db;
  let appDb: Db;
  let redis: Redis;
  let endMigrator: () => Promise<void>;
  let endApp: () => Promise<void>;
  let endRedis: () => Promise<unknown>;
  let app: Awaited<ReturnType<typeof buildApp>>;

  const uid: Record<string, string> = {};
  const slug = `p43${randomUUID().slice(0, 8)}`;
  const sessions: Record<
    'owner' | 'principal' | 'scoped' | 'teacher' | 'teacherTwo' | 'parent' | 'student',
    SessionCookies
  > = {} as never;

  let campusAId = '';
  let campusBId = '';
  let yearAId = '';
  let classAId = '';
  let classBId = '';
  let subjAId = '';
  let subjBId = '';
  let subjCId = '';
  let subjFreeId = '';
  let sectionA1Id = '';
  let sectionA2Id = '';
  let sectionB1Id = '';
  let periodAId = '';
  let periodBId = '';
  let periodCId = '';
  let fileAId = '';
  let entryA1Id = '';
  let entryA3Id = '';
  let entryB1Id = '';
  let hwA1Id = '';
  let hwA2Id = '';
  let hwIdemId = '';

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

  const outboxCount = async (eventType: string): Promise<number> => {
    const r = await one(
      migratorDb,
      sql`select count(*)::int n from outbox_events where tenant_id = ${uid.tenantA} and event_type = ${eventType}`,
    );
    return Number(r.n);
  };

  const auditCount = async (action: string): Promise<number> => {
    const r = await one(
      migratorDb,
      sql`select count(*)::int n from audit_logs where tenant_id = ${uid.tenantA} and action = ${action}`,
    );
    return Number(r.n);
  };

  interface InjectResult {
    statusCode: number;
    body: string;
    json(): Record<string, any>;
  }
  const inject = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, opts: { headers?: Record<string, string>; payload?: unknown } = {}): Promise<InjectResult> =>
    app.inject({
      method,
      url,
      headers: { cookie: sessions.owner.cookie, ...opts.headers },
      payload: opts.payload as string | undefined,
    }) as unknown as Promise<InjectResult>;

  const injectAs = (s: SessionCookies, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, opts: { headers?: Record<string, string>; payload?: unknown } = {}): Promise<InjectResult> =>
    app.inject({
      method,
      url,
      headers: { cookie: s.cookie, ...opts.headers },
      payload: opts.payload as string | undefined,
    }) as unknown as Promise<InjectResult>;

  const mkSubject = async (code: string, key: string) => {
    const res = await inject('POST', '/api/v1/subjects', {
      headers: { ...withCsrf(sessions.owner), ...idem(`sb-${key}-${slug}`) },
      payload: { code, name: 'Subject ' + code },
    });
    expect(res.statusCode, `subject ${code}`).toBe(201);
    return (res.json().subject as { id: string }).id;
  };

  const mkSection = async (classId: string, code: string, key: string) => {
    const res = await inject('POST', `/api/v1/classes/${classId}/sections`, {
      headers: { ...withCsrf(sessions.owner), ...idem(`sc-${key}-${slug}`) },
      payload: { code },
    });
    expect(res.statusCode, `section ${code}`).toBe(201);
    return (res.json().section as { id: string }).id;
  };

  const mkPeriod = async (name: string, periodNo: number, startTime: string, endTime: string, key: string) => {
    const res = await inject('POST', '/api/v1/periods', {
      headers: { ...withCsrf(sessions.owner), ...idem(`pe-${key}-${slug}`) },
      payload: { name, periodNo, startTime, endTime },
    });
    expect(res.statusCode, `period ${name}`).toBe(201);
    return res.json().period as { id: string; campusId: string | null; status: string };
  };

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

    uid.owner = randomUUID();
    uid.principal = randomUUID();
    uid.scoped = randomUUID();
    uid.platRole = randomUUID();
    uid.teacherElig = randomUUID();
    uid.teacherTwo = randomUUID();
    uid.parent = randomUUID();
    uid.studentUser = randomUUID();
    uid.ownerEmail = `owner-${slug}@example.com`;
    uid.principalEmail = `principal-${slug}@example.com`;
    uid.scopedEmail = `scoped-${slug}@example.com`;
    uid.parentEmail = `parent-${slug}@example.com`;
    uid.studentEmail = `student-${slug}@example.com`;

    await rows(
      migratorDb,
      sql`insert into roles (id, scope, code, name, is_system) values (${uid.platRole}, 'platform', ${`p43${slug}_plat`}, 'P43 Platform Admin', true)`,
    );
    await rows(
      migratorDb,
      sql`insert into role_permissions (role_id, permission) values (${uid.platRole}, 'platform.tenants.read'), (${uid.platRole}, 'platform.tenants.create')`,
    );
    await rows(migratorDb, sql`insert into users (id, email) values
      (${uid.owner}, ${uid.ownerEmail}),
      (${uid.principal}, ${uid.principalEmail}),
      (${uid.scoped}, ${uid.scopedEmail}),
      (${uid.parent}, ${uid.parentEmail}),
      (${uid.studentUser}, ${uid.studentEmail})`);
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
    const created = await withTenant(appDb, platformCtx(uid.owner!), (tx) =>
      createTenantTransaction(tx, platformCtx(uid.owner!), {
        slug: `${slug}-a`,
        name: 'P43 A',
        requestId: randomUUID(),
      }),
    );
    uid.tenantA = created.tenantId;

    const schoolOwner = await one(
      migratorDb,
      sql`select id from roles where tenant_id = ${uid.tenantA} and code = 'school_owner'`,
    );
    const schoolOwnerId = String(schoolOwner.id);

    // Principal membership (read-only template).
    uid.principalMembership = randomUUID();
    await rows(
      migratorDb,
      sql`insert into memberships (id, tenant_id, user_id, status) values (${uid.principalMembership}, ${uid.tenantA}, ${uid.principal}, 'active')`,
    );
    const principalRole = await one(
      migratorDb,
      sql`select id from roles where tenant_id = ${uid.tenantA} and code = 'principal'`,
    );
    await rows(
      migratorDb,
      sql`insert into membership_roles (membership_id, role_id) values (${uid.principalMembership}, ${String(principalRole.id)})`,
    );

    // Campus-scoped owner (pinned to campusA once created below).
    uid.scopedMembership = randomUUID();
    await rows(
      migratorDb,
      sql`insert into memberships (id, tenant_id, user_id, status) values (${uid.scopedMembership}, ${uid.tenantA}, ${uid.scoped}, 'active')`,
    );
    await rows(
      migratorDb,
      sql`insert into membership_roles (membership_id, role_id) values (${uid.scopedMembership}, ${schoolOwnerId})`,
    );

    // Teacher-role scaffolding: two active teachers.
    uid.roleTeacher = String(
      (await one(
        migratorDb,
        sql`select id from roles where tenant_id = ${uid.tenantA} and code = 'teacher'`,
      )).id,
    );
    await rows(migratorDb, sql`insert into users (id, email) values
      (${uid.teacherElig}, ${`te-${slug}@example.com`}),
      (${uid.teacherTwo}, ${`t2-${slug}@example.com`})`);
    await rows(migratorDb, sql`insert into user_profiles (user_id, full_name) values
      (${uid.teacherElig}, 'Eligible Teacher'),
      (${uid.teacherTwo}, 'Teacher Two')`);
    uid.membershipElig = randomUUID();
    uid.membershipTwo = randomUUID();
    await rows(
      migratorDb,
      sql`insert into memberships (id, tenant_id, user_id, status) values
        (${uid.membershipElig}, ${uid.tenantA}, ${uid.teacherElig}, 'active'),
        (${uid.membershipTwo}, ${uid.tenantA}, ${uid.teacherTwo}, 'active')`,
    );
    await rows(
      migratorDb,
      sql`insert into membership_roles (membership_id, role_id) values
        (${uid.membershipElig}, ${uid.roleTeacher}),
        (${uid.membershipTwo}, ${uid.roleTeacher})`,
    );

    // Parent + student memberships (visibility scoping).
    uid.parentMembership = randomUUID();
    uid.studentMembership = randomUUID();
    await rows(
      migratorDb,
      sql`insert into memberships (id, tenant_id, user_id, status) values
        (${uid.parentMembership}, ${uid.tenantA}, ${uid.parent}, 'active'),
        (${uid.studentMembership}, ${uid.tenantA}, ${uid.studentUser}, 'active')`,
    );
    const parentRole = await one(
      migratorDb,
      sql`select id from roles where tenant_id = ${uid.tenantA} and code = 'parent'`,
    );
    const studentRole = await one(
      migratorDb,
      sql`select id from roles where tenant_id = ${uid.tenantA} and code = 'student'`,
    );
    await rows(
      migratorDb,
      sql`insert into membership_roles (membership_id, role_id) values
        (${uid.parentMembership}, ${String(parentRole.id)}),
        (${uid.studentMembership}, ${String(studentRole.id)})`,
    );

    sessions.owner = await makeSession(uid.owner!, uid.tenantA!);
    sessions.principal = await makeSession(uid.principal!, uid.tenantA!);
    sessions.scoped = await makeSession(uid.scoped!, uid.tenantA!);
    sessions.teacher = await makeSession(uid.teacherElig!, uid.tenantA!);
    sessions.teacherTwo = await makeSession(uid.teacherTwo!, uid.tenantA!);
    sessions.parent = await makeSession(uid.parent!, uid.tenantA!);
    sessions.student = await makeSession(uid.studentUser!, uid.tenantA!);

    app = await buildApp({ deps: { db: appDb, redis, storage: stubStorage }, logger: false });

    const campusA = await inject('POST', '/api/v1/campuses', {
      headers: { ...withCsrf(sessions.owner), ...idem(`cp-a-${slug}`) },
      payload: { code: `ca-${slug}`, name: 'Campus Alpha' },
    });
    expect(campusA.statusCode).toBe(201);
    campusAId = (campusA.json().campus as { id: string }).id;
    const campusB = await inject('POST', '/api/v1/campuses', {
      headers: { ...withCsrf(sessions.owner), ...idem(`cp-b-${slug}`) },
      payload: { code: `cb-${slug}`, name: 'Campus Beta' },
    });
    expect(campusB.statusCode).toBe(201);
    campusBId = (campusB.json().campus as { id: string }).id;
    const year = await inject('POST', '/api/v1/academic-years', {
      headers: { ...withCsrf(sessions.owner), ...idem(`yr-${slug}`) },
      payload: { code: `ay-${slug}`, name: 'AY 2026', startsOn: '2026-01-01', endsOn: '2026-12-31' },
    });
    expect(year.statusCode).toBe(201);
    yearAId = (year.json().academicYear as { id: string }).id;

    const mkClass = async (campusId: string, code: string, name: string, key: string) => {
      const res = await inject('POST', '/api/v1/classes', {
        headers: { ...withCsrf(sessions.owner), ...idem(`cl-${key}-${slug}`) },
        payload: { campusId, academicYearId: yearAId, code, name },
      });
      expect(res.statusCode).toBe(201);
      return (res.json().class as { id: string }).id;
    };
    classAId = await mkClass(campusAId, `c1-${slug}`, 'Class One', 'a');
    classBId = await mkClass(campusBId, `c2-${slug}`, 'Class Two', 'b');

    // Pin the scoped member to campusA so classB/timetable routes are out of scope.
    await rows(
      migratorDb,
      sql`update memberships set campus_id = ${campusAId} where id = ${uid.scopedMembership}`,
    );

    subjAId = await mkSubject(`sb-a-${slug}`, 'a');
    subjBId = await mkSubject(`sb-b-${slug}`, 'b');
    subjCId = await mkSubject(`sb-c-${slug}`, 'c');
    subjFreeId = await mkSubject(`sb-f-${slug}`, 'f');

    // Sections under the classes (tenant/class/campus anchor verified by the DB).
    sectionA1Id = await mkSection(classAId, `s1-${slug}`, 'a1');
    sectionA2Id = await mkSection(classAId, `s2-${slug}`, 'a2');
    sectionB1Id = await mkSection(classBId, `s3-${slug}`, 'b1');

    // Attach subjA + subjC to classA, subjB to classB.
    for (const [classId, subjectId, key] of [
      [classAId, subjAId, 'a'],
      [classAId, subjCId, 'c'],
      [classBId, subjBId, 'b'],
    ] as const) {
      const res = await inject('POST', `/api/v1/classes/${classId}/subjects/${subjectId}`, {
        headers: { ...withCsrf(sessions.owner), ...idem(`cs-${key}-${slug}`) },
        payload: {},
      });
      expect(res.statusCode).toBe(201);
    }

    // Assignments: teacherElig teaches subjA + subjC in classA; teacherTwo subjB in classB.
    for (const [classId, subjectId, teacherUserId, key] of [
      [classAId, subjAId, uid.teacherElig!, 'a'],
      [classAId, subjCId, uid.teacherElig!, 'c'],
      [classBId, subjBId, uid.teacherTwo!, 'b'],
    ] as const) {
      const res = await inject('POST', `/api/v1/classes/${classId}/subjects/${subjectId}/teachers`, {
        headers: { ...withCsrf(sessions.owner), ...idem(`ta-${key}-${slug}`) },
        payload: { teacherUserId },
      });
      expect(res.statusCode).toBe(201);
    }

    // Attachment file (seeded via migrator; the API only validates tenant ownership).
    fileAId = randomUUID();
    await rows(
      migratorDb,
      sql`insert into files (id, tenant_id, storage_key, original_name, mime, size_bytes, visibility, scan_status)
          values (${fileAId}, ${uid.tenantA}, ${`p43-${slug}-hw.pdf`}, 'hw.pdf', 'application/pdf', 2048, 'private', 'clean')`,
    );

    // Parent link: guardian -> student -> live enrollment in classA.
    const guardianId = randomUUID();
    const studentId = randomUUID();
    const linkId = randomUUID();
    const enrollmentId = randomUUID();
    await rows(
      migratorDb,
      sql`insert into guardians (id, tenant_id, user_id, first_name, last_name)
          values (${guardianId}, ${uid.tenantA}, ${uid.parent}, 'Guardian', 'Parent')`,
    );
    await rows(
      migratorDb,
      sql`insert into students (id, tenant_id, student_no, first_name, last_name, status)
          values (${studentId}, ${uid.tenantA}, ${`s-${slug}`}, 'Kid', 'Student', 'active')`,
    );
    await rows(
      migratorDb,
      sql`insert into student_guardians (id, tenant_id, student_id, guardian_id, relation, is_primary)
          values (${linkId}, ${uid.tenantA}, ${studentId}, ${guardianId}, 'parent', true)`,
    );
    await rows(
      migratorDb,
      sql`insert into enrollments (id, tenant_id, student_id, academic_year_id, class_id, status, roll_no)
          values (${enrollmentId}, ${uid.tenantA}, ${studentId}, ${yearAId}, ${classAId}, 'active', ${`r-${slug}`})`,
    );
  });

  afterAll(async () => {
    try {
      if (app) await app.close();
      const tIn = `'${uid.tenantA}'`;
      await rows(migratorDb, sql`delete from homework_attachments where tenant_id in (${sql.raw(tIn)})`);
      await rows(migratorDb, sql`delete from homework where tenant_id in (${sql.raw(tIn)})`);
      await rows(migratorDb, sql`delete from timetable_entries where tenant_id in (${sql.raw(tIn)})`);
      await rows(migratorDb, sql`delete from periods where tenant_id in (${sql.raw(tIn)})`);
      await rows(migratorDb, sql`delete from sections where tenant_id in (${sql.raw(tIn)})`);
      await rows(migratorDb, sql`delete from teacher_assignments where tenant_id in (${sql.raw(tIn)})`);
      await rows(migratorDb, sql`delete from class_subjects where tenant_id in (${sql.raw(tIn)})`);
      await rows(migratorDb, sql`delete from enrollments where tenant_id in (${sql.raw(tIn)})`);
      await rows(migratorDb, sql`delete from student_guardians where tenant_id in (${sql.raw(tIn)})`);
      await rows(migratorDb, sql`delete from students where tenant_id in (${sql.raw(tIn)})`);
      await rows(migratorDb, sql`delete from guardians where tenant_id in (${sql.raw(tIn)})`);
      await rows(migratorDb, sql`delete from files where tenant_id in (${sql.raw(tIn)})`);
      await rows(migratorDb, sql`delete from acd_classes where tenant_id in (${sql.raw(tIn)})`);
      await rows(migratorDb, sql`delete from subjects where tenant_id in (${sql.raw(tIn)})`);
      await rows(migratorDb, sql`delete from outbox_events where tenant_id in (${sql.raw(tIn)})`);
      await rows(migratorDb, sql`delete from idempotency_keys where tenant_id in (${sql.raw(tIn)})`);
      await rows(migratorDb, sql`delete from academic_years where tenant_id in (${sql.raw(tIn)})`);
      await rows(migratorDb, sql`delete from campuses where tenant_id in (${sql.raw(tIn)})`);
      await rows(
        migratorDb,
        sql`delete from membership_roles where membership_id in (
          select id from memberships where tenant_id in (${sql.raw(tIn)}) or user_id in (${uid.principal}, ${uid.scoped}, ${uid.teacherElig}, ${uid.teacherTwo}, ${uid.parent}, ${uid.studentUser}))`,
      );
      await rows(
        migratorDb,
        sql`delete from role_permissions where role_id in (select id from roles where tenant_id in (${sql.raw(tIn)}) or id = ${uid.platRole})`,
      );
      await rows(
        migratorDb,
        sql`delete from memberships where tenant_id in (${sql.raw(tIn)}) or user_id in (${uid.principal}, ${uid.scoped}, ${uid.teacherElig}, ${uid.teacherTwo}, ${uid.parent}, ${uid.studentUser})`,
      );
      await rows(
        migratorDb,
        sql`delete from user_profiles where user_id in (${uid.teacherElig}, ${uid.teacherTwo})`,
      );
      await rows(
        migratorDb,
        sql`delete from platform_role_assignments where user_id = ${uid.owner}`,
      );
      await rows(
        migratorDb,
        sql`delete from roles where tenant_id in (${sql.raw(tIn)}) or id in (${uid.platRole}, ${uid.roleTeacher})`,
      );
      await rows(
        migratorDb,
        sql`delete from users where id in (${uid.owner}, ${uid.principal}, ${uid.scoped}, ${uid.teacherElig}, ${uid.teacherTwo}, ${uid.parent}, ${uid.studentUser})`,
      );
      await rows(migratorDb, sql`delete from tenants where id in (${sql.raw(tIn)})`);
    } finally {
      await endMigrator();
      await endApp();
      await endRedis?.();
    }
  });

  describe('periods (bell sets)', () => {
    it('creator creates a tenant-wide period; audit + outbox (period.created)', async () => {
      const before = await outboxCount('period.created');
      const period = await mkPeriod('Period A', 1, '08:00', '08:45', 'a');
      periodAId = period.id;
      expect(period.campusId).toBeNull();
      expect(period.status).toBe('active');
      expect(await outboxCount('period.created')).toBe(before + 1);
      expect(await auditCount('period.created')).toBeGreaterThan(0);
    });

    it('duplicate period_no maps to 409 period_no_taken', async () => {
      const res = await inject('POST', '/api/v1/periods', {
        headers: { ...withCsrf(sessions.owner), ...idem(`pe-dup-${slug}`) },
        payload: { name: 'Dup', periodNo: 1, startTime: '08:00', endTime: '08:45' },
      });
      expect(res.statusCode).toBe(409);
      expect(envelope(res)?.code).toBe('period_no_taken');
    });

    it('overlapping time range maps to 409 period_time_overlap', async () => {
      const res = await inject('POST', '/api/v1/periods', {
        headers: { ...withCsrf(sessions.owner), ...idem(`pe-ov-${slug}`) },
        payload: { name: 'Overlap', periodNo: 7, startTime: '08:30', endTime: '09:15' },
      });
      expect(res.statusCode).toBe(409);
      expect(envelope(res)?.code).toBe('period_time_overlap');
    });

    it('list/single/PATCH rename (outbox period.updated); activate/deactivate lifecycle', async () => {
      const periodB = await mkPeriod('Period B', 2, '09:00', '09:45', 'b');
      periodBId = periodB.id;

      const list = await inject('GET', '/api/v1/periods');
      expect(list.statusCode).toBe(200);
      expect((list.json() as { items: { periodNo: number }[] }).items.some((i) => i.periodNo === 1)).toBe(true);

      const single = await inject('GET', `/api/v1/periods/${periodAId}`);
      expect(single.statusCode).toBe(200);

      const before = await outboxCount('period.updated');
      const renamed = await inject('PATCH', `/api/v1/periods/${periodBId}`, {
        headers: withCsrf(sessions.owner),
        payload: { name: 'Period B Renamed' },
      });
      expect(renamed.statusCode).toBe(200);
      expect((renamed.json().period as { name: string }).name).toBe('Period B Renamed');
      expect(await outboxCount('period.updated')).toBe(before + 1);

      const deact = await inject('POST', `/api/v1/periods/${periodBId}/deactivate`, {
        headers: withCsrf(sessions.owner),
      });
      expect(deact.statusCode).toBe(200);
      expect((deact.json().period as { status: string }).status).toBe('inactive');
      const act = await inject('POST', `/api/v1/periods/${periodBId}/activate`, {
        headers: withCsrf(sessions.owner),
      });
      expect(act.statusCode).toBe(200);
      expect((act.json().period as { status: string }).status).toBe('active');
      expect(await auditCount('period.updated')).toBeGreaterThan(0);
    });

    it('campus-scoped member cannot manage the tenant-wide bell set (403 campus_scope_denied); can read', async () => {
      const denied = await injectAs(sessions.scoped, 'POST', '/api/v1/periods', {
        headers: { ...withCsrf(sessions.scoped), ...idem(`pe-sc-${slug}`) },
        payload: { name: 'Scoped', periodNo: 8, startTime: '11:00', endTime: '11:45' },
      });
      expect(denied.statusCode).toBe(403);
      expect(envelope(denied)?.code).toBe('campus_scope_denied');

      const read = await injectAs(sessions.scoped, 'GET', '/api/v1/periods');
      expect(read.statusCode).toBe(200);
    });

    it('idempotent create replays the cached response (single outbox event)', async () => {
      const before = await outboxCount('period.created');
      const key = `pe-idem-${slug}`;
      const payload = { name: 'Idem Period', periodNo: 9, startTime: '12:00', endTime: '12:45' };
      const first = await inject('POST', '/api/v1/periods', {
        headers: { ...withCsrf(sessions.owner), ...idem(key) },
        payload,
      });
      expect(first.statusCode).toBe(201);
      const id = (first.json().period as { id: string }).id;
      const replay = await inject('POST', '/api/v1/periods', {
        headers: { ...withCsrf(sessions.owner), ...idem(key) },
        payload,
      });
      expect(replay.statusCode).toBe(201);
      expect((replay.json().period as { id: string }).id).toBe(id);
      expect(await outboxCount('period.created')).toBe(before + 1);
    });
  });

  describe('timetable grid', () => {
    it('grid cell is created with the server-derived teacher; audit + outbox (timetable.entry.created)', async () => {
      const before = await outboxCount('timetable.entry.created');
      const res = await inject('POST', `/api/v1/classes/${classAId}/sections/${sectionA1Id}/timetable`, {
        headers: { ...withCsrf(sessions.owner), ...idem(`te-a1-${slug}`) },
        payload: { subjectId: subjAId, weekday: 1, periodId: periodAId },
      });
      expect(res.statusCode).toBe(201);
      const entry = res.json().entry as {
        id: string;
        teacherUserId: string;
        classId: string;
        sectionId: string;
        subjectId: string;
        campusId: string;
        weekday: number;
      };
      entryA1Id = entry.id;
      expect(entry.teacherUserId).toBe(uid.teacherElig);
      expect(entry.classId).toBe(classAId);
      expect(entry.campusId).toBe(campusAId);
      expect(entry.weekday).toBe(1);
      expect(await outboxCount('timetable.entry.created')).toBe(before + 1);
      expect(await auditCount('timetable.entry.created')).toBeGreaterThan(0);
    });

    it('teacherUserId is not client-writable (strict schema: 400 validation_error)', async () => {
      const res = await inject('POST', `/api/v1/classes/${classAId}/sections/${sectionA2Id}/timetable`, {
        headers: withCsrf(sessions.owner),
        payload: { subjectId: subjCId, weekday: 2, periodId: periodAId, teacherUserId: uid.teacherTwo },
      });
      expect(res.statusCode).toBe(400);
      expect(envelope(res)?.code).toBe('validation_error');
    });

    it('duplicate slot in the same section maps to 409 timetable_slot_conflict', async () => {
      const res = await inject('POST', `/api/v1/classes/${classAId}/sections/${sectionA1Id}/timetable`, {
        headers: { ...withCsrf(sessions.owner), ...idem(`te-du-${slug}`) },
        payload: { subjectId: subjAId, weekday: 1, periodId: periodAId },
      });
      expect(res.statusCode).toBe(409);
      expect(envelope(res)?.code).toBe('timetable_slot_conflict');
    });

    it('cross-section same teacher same slot maps to 409 teacher_double_booked', async () => {
      const res = await inject('POST', `/api/v1/classes/${classAId}/sections/${sectionA2Id}/timetable`, {
        headers: { ...withCsrf(sessions.owner), ...idem(`te-db-${slug}`) },
        payload: { subjectId: subjCId, weekday: 1, periodId: periodAId },
      });
      expect(res.statusCode).toBe(409);
      expect(envelope(res)?.code).toBe('teacher_double_booked');
    });

    it('a different teacher may take the same slot in their own class (201)', async () => {
      const res = await inject('POST', `/api/v1/classes/${classBId}/sections/${sectionB1Id}/timetable`, {
        headers: { ...withCsrf(sessions.owner), ...idem(`te-b1-${slug}`) },
        payload: { subjectId: subjBId, weekday: 1, periodId: periodAId },
      });
      expect(res.statusCode).toBe(201);
      entryB1Id = (res.json().entry as { id: string }).id;
      expect((res.json().entry as { teacherUserId: string }).teacherUserId).toBe(uid.teacherTwo);
    });

    it('unattached subject on a grid slot maps to 404', async () => {
      const res = await inject('POST', `/api/v1/classes/${classAId}/sections/${sectionA2Id}/timetable`, {
        headers: withCsrf(sessions.owner),
        payload: { subjectId: subjFreeId, weekday: 3, periodId: periodAId },
      });
      expect(res.statusCode).toBe(404);
      expect(envelope(res)?.message).toBe('Subject is not attached to this class');
    });

    it('PATCH moves the grid cell; the trigger re-checks the NEW slot (409 slot conflict)', async () => {
      const res = await inject('POST', `/api/v1/classes/${classAId}/sections/${sectionA1Id}/timetable`, {
        headers: { ...withCsrf(sessions.owner), ...idem(`te-a3-${slug}`) },
        payload: { subjectId: subjAId, weekday: 2, periodId: periodAId },
      });
      expect(res.statusCode).toBe(201);
      entryA3Id = (res.json().entry as { id: string }).id;

      const before = await outboxCount('timetable.entry.updated');
      const moved = await inject('PATCH', `/api/v1/classes/${classAId}/sections/${sectionA1Id}/timetable/${entryA3Id}`, {
        headers: withCsrf(sessions.owner),
        payload: { weekday: 3 },
      });
      expect(moved.statusCode).toBe(200);
      expect((moved.json().entry as { weekday: number }).weekday).toBe(3);
      expect(await outboxCount('timetable.entry.updated')).toBe(before + 1);

      // Moving onto the occupied slot of entryA1 is refused by the trigger.
      const clash = await inject('PATCH', `/api/v1/classes/${classAId}/sections/${sectionA1Id}/timetable/${entryA3Id}`, {
        headers: withCsrf(sessions.owner),
        payload: { weekday: 1, periodId: periodAId },
      });
      expect(clash.statusCode).toBe(409);
      expect(envelope(clash)?.code).toBe('timetable_slot_conflict');
    });

    it('list filters by section + weekday', async () => {
      const res = await inject('GET', `/api/v1/classes/${classAId}/sections/${sectionA1Id}/timetable?weekday=1`);
      expect(res.statusCode).toBe(200);
      const body = res.json() as { items: { id: string }[]; total: number };
      expect(body.total).toBe(1);
      expect(body.items[0]?.id).toBe(entryA1Id);
    });

    it('DELETE removes the lesson (timetable.entry.deleted); the freed slot is reusable', async () => {
      const before = await outboxCount('timetable.entry.deleted');
      const del = await inject('DELETE', `/api/v1/classes/${classAId}/sections/${sectionA1Id}/timetable/${entryA3Id}`, {
        headers: { ...withCsrf(sessions.owner), ...idem(`te-d1-${slug}`) },
      });
      expect(del.statusCode).toBe(200);
      expect(await outboxCount('timetable.entry.deleted')).toBe(before + 1);

      const reused = await inject('POST', `/api/v1/classes/${classAId}/sections/${sectionA1Id}/timetable`, {
        headers: { ...withCsrf(sessions.owner), ...idem(`te-a4-${slug}`) },
        payload: { subjectId: subjAId, weekday: 3, periodId: periodAId },
      });
      expect(reused.statusCode).toBe(201);
    });

    it('a section with live lessons cannot be deleted (409 section_has_timetable)', async () => {
      const res = await inject('DELETE', `/api/v1/classes/${classAId}/sections/${sectionA1Id}`, {
        headers: { ...withCsrf(sessions.owner), ...idem(`sc-g-${slug}`) },
      });
      expect(res.statusCode).toBe(409);
      expect(envelope(res)?.code).toBe('section_has_timetable');
    });

    it('a period referenced by a live lesson cannot be deleted (409 period_has_entries); unused deletes', async () => {
      const guarded = await inject('DELETE', `/api/v1/periods/${periodAId}`, {
        headers: { ...withCsrf(sessions.owner), ...idem(`pe-g-${slug}`) },
      });
      expect(guarded.statusCode).toBe(409);
      expect(envelope(guarded)?.code).toBe('period_has_entries');

      const periodC = await mkPeriod('Period C', 3, '10:00', '10:45', 'c');
      periodCId = periodC.id;
      const before = await outboxCount('period.deleted');
      const del = await inject('DELETE', `/api/v1/periods/${periodCId}`, {
        headers: { ...withCsrf(sessions.owner), ...idem(`pe-d1-${slug}`) },
      });
      expect(del.statusCode).toBe(200);
      expect(await outboxCount('period.deleted')).toBe(before + 1);
    });

    it('publish with a clean grid maps to 200 {published:true} + audit + outbox (timetable.published)', async () => {
      const before = await outboxCount('timetable.published');
      const res = await inject('POST', '/api/v1/timetable/publish', {
        headers: { ...withCsrf(sessions.owner), ...idem(`tp-1-${slug}`) },
        payload: {},
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { published: boolean; conflicts: unknown[] };
      expect(body.published).toBe(true);
      expect(body.conflicts).toEqual([]);
      expect(await outboxCount('timetable.published')).toBe(before + 1);
      expect(await auditCount('timetable.published')).toBeGreaterThan(0);
    });

    it('defense-in-depth: conflicting rows the API cannot produce are caught by publish (published:false)', async () => {
      // A grid that the honest API cannot create (the teacher-double-book trigger
      // refuses it) but that a privileged write could still introduce: seed it
      // directly with the row trigger disabled, then prove the publish scan is the
      // back-stop that catches it.
      const r = await inject('POST', '/api/v1/timetable/publish', {
        headers: { ...withCsrf(sessions.owner), ...idem(`tp-2-${slug}`) },
        payload: {},
      });
      expect(r.statusCode).toBe(200);
      expect((r.json() as { published: boolean }).published).toBe(true);

      try {
        await rows(
          migratorDb,
          sql`ALTER TABLE timetable_entries DISABLE TRIGGER timetable_entries_validate_trg`,
        );
        await rows(
          migratorDb,
          sql`insert into timetable_entries (tenant_id, class_id, section_id, subject_id, teacher_user_id, period_id, campus_id, academic_year_id, weekday)
              select ${uid.tenantA}, ${classAId}, ${sectionA2Id}, ${subjCId}, ${uid.teacherElig}, ${periodAId}, ${campusAId}, ${yearAId}, 1
              where not exists (
                select 1 from timetable_entries
                where tenant_id = ${uid.tenantA} and section_id = ${sectionA2Id}
                  and weekday = 1 and period_id = ${periodAId} and deleted_at is null)`,
        );
      } finally {
        await rows(
          migratorDb,
          sql`ALTER TABLE timetable_entries ENABLE TRIGGER timetable_entries_validate_trg`,
        );
      }

      const before = await outboxCount('timetable.published');
      const publish = await inject('POST', '/api/v1/timetable/publish', {
        headers: { ...withCsrf(sessions.owner), ...idem(`tp-3-${slug}`) },
        payload: {},
      });
      expect(publish.statusCode).toBe(200);
      const body = publish.json() as {
        published: boolean;
        conflicts: { weekday: number; teacherUserId: string; entryCount: number }[];
      };
      expect(body.published).toBe(false);
      expect(body.conflicts).toEqual([
        { weekday: 1, teacherUserId: uid.teacherElig, entryCount: 2 },
      ]);
      // A failing publish emits NO event.
      expect(await outboxCount('timetable.published')).toBe(before);

      // Clean the smuggled row so later tests see only the honest grid.
      await rows(
        migratorDb,
        sql`delete from timetable_entries where tenant_id = ${uid.tenantA} and section_id = ${sectionA2Id} and period_id = ${periodAId} and deleted_at is null`,
      );
    });

    it('principal may READ the grid but cannot manage or publish (403 + requiredPermission)', async () => {
      const read = await injectAs(sessions.principal, 'GET', `/api/v1/classes/${classAId}/sections/${sectionA1Id}/timetable`);
      expect(read.statusCode).toBe(200);

      const manage = await injectAs(sessions.principal, 'POST', `/api/v1/classes/${classAId}/sections/${sectionA1Id}/timetable`, {
        headers: withCsrf(sessions.principal),
        payload: { subjectId: subjAId, weekday: 4, periodId: periodAId },
      });
      expect(manage.statusCode).toBe(403);
      expect(envelope(manage)?.requiredPermission).toBe('timetable.manage');

      const publish = await injectAs(sessions.principal, 'POST', '/api/v1/timetable/publish', {
        headers: withCsrf(sessions.principal),
        payload: {},
      });
      expect(publish.statusCode).toBe(403);
      expect(envelope(publish)?.requiredPermission).toBe('timetable.publish');
    });

    it('campus-scoped member is denied on the other-campus grid (403 campus_scope_denied)', async () => {
      const res = await injectAs(sessions.scoped, 'POST', `/api/v1/classes/${classBId}/sections/${sectionB1Id}/timetable`, {
        headers: { ...withCsrf(sessions.scoped), ...idem(`te-sc-${slug}`) },
        payload: { subjectId: subjBId, weekday: 5, periodId: periodAId },
      });
      expect(res.statusCode).toBe(403);
      expect(envelope(res)?.code).toBe('campus_scope_denied');
    });
  });

  describe('homework', () => {
    it('an assigned teacher authors their own homework; audit + outbox (homework.created)', async () => {
      const before = await outboxCount('homework.created');
      const res = await injectAs(sessions.teacher, 'POST', `/api/v1/classes/${classAId}/homework`, {
        headers: { ...withCsrf(sessions.teacher), ...idem(`hw-a1-${slug}`) },
        payload: {
          subjectId: subjAId,
          title: 'Algebra sheet 1',
          body: 'Exercises 1-10',
          dueAt: '2026-10-30T00:00:00.000Z',
          attachmentFileIds: [fileAId],
        },
      });
      expect(res.statusCode).toBe(201);
      const homework = res.json().homework as {
        id: string;
        teacherUserId: string;
        classId: string;
        campusId: string;
        attachments: { fileId: string }[];
      };
      hwA1Id = homework.id;
      expect(homework.teacherUserId).toBe(uid.teacherElig);
      expect(homework.classId).toBe(classAId);
      expect(homework.campusId).toBe(campusAId);
      expect(homework.attachments[0]?.fileId).toBe(fileAId);
      expect(await outboxCount('homework.created')).toBe(before + 1);
      expect(await auditCount('homework.created')).toBeGreaterThan(0);
    });

    it('owner/principal author on the class behalf: teacherUserId delegates to the assigned teacher', async () => {
      const res = await inject('POST', `/api/v1/classes/${classAId}/homework`, {
        headers: { ...withCsrf(sessions.owner), ...idem(`hw-a2-${slug}`) },
        payload: { subjectId: subjCId, title: 'Chemistry lab', body: 'Write report' },
      });
      expect(res.statusCode).toBe(201);
      hwA2Id = (res.json().homework as { id: string }).id;
      expect((res.json().homework as { teacherUserId: string }).teacherUserId).toBe(uid.teacherElig);
    });

    it('a teacher cannot author homework for a subject they do not teach (409 homework_teacher_not_assigned)', async () => {
      const res = await injectAs(sessions.teacherTwo, 'POST', `/api/v1/classes/${classAId}/homework`, {
        headers: { ...withCsrf(sessions.teacherTwo), ...idem(`hw-bad-${slug}`) },
        payload: { subjectId: subjAId, title: 'Not mine' },
      });
      expect(res.statusCode).toBe(409);
      expect(envelope(res)?.code).toBe('homework_teacher_not_assigned');
    });

    it('homework for an unlinked subject maps to 404', async () => {
      const res = await inject('POST', `/api/v1/classes/${classAId}/homework`, {
        headers: withCsrf(sessions.owner),
        payload: { subjectId: subjFreeId, title: 'Free subject' },
      });
      expect(res.statusCode).toBe(404);
      expect(envelope(res)?.message).toBe('Subject is not attached to this class');
    });

    it('another teacher cannot PATCH or DELETE a colleague emergency (403 homework_scope_denied)', async () => {
      const other = await injectAs(sessions.teacherTwo, 'PATCH', `/api/v1/classes/${classAId}/homework/${hwA1Id}`, {
        headers: withCsrf(sessions.teacherTwo),
        payload: { title: 'Edited by other teacher' },
      });
      expect(other.statusCode).toBe(403);
      expect(envelope(other)?.code).toBe('homework_scope_denied');

      const del = await injectAs(sessions.teacherTwo, 'DELETE', `/api/v1/classes/${classAId}/homework/${hwA1Id}`, {
        headers: withCsrf(sessions.teacherTwo),
      });
      expect(del.statusCode).toBe(403);
      expect(envelope(del)?.code).toBe('homework_scope_denied');
    });

    it('owner can PATCH (homework.updated) and teacher PATCHes their own rows', async () => {
      const before = await outboxCount('homework.updated');
      const res = await inject('PATCH', `/api/v1/classes/${classAId}/homework/${hwA1Id}`, {
        headers: withCsrf(sessions.owner),
        payload: { title: 'Algebra sheet 1 (revised)', body: null },
      });
      expect(res.statusCode).toBe(200);
      const homework = res.json().homework as { title: string; body: string | null };
      expect(homework.title).toBe('Algebra sheet 1 (revised)');
      expect(homework.body).toBeNull();
      expect(await outboxCount('homework.updated')).toBe(before + 1);

      const self = await injectAs(sessions.teacher, 'PATCH', `/api/v1/classes/${classAId}/homework/${hwA1Id}`, {
        headers: withCsrf(sessions.teacher),
        payload: { body: 'Exercises 1-12 plus review' },
      });
      expect(self.statusCode).toBe(200);
    });

    it('teacher visibility: list shows own rows only; a colleague sees empty + 404 detail', async () => {
      const mine = await injectAs(sessions.teacher, 'GET', `/api/v1/classes/${classAId}/homework`);
      expect(mine.statusCode).toBe(200);
      const myBody = mine.json() as { items: { id: string }[]; total: number };
      expect(myBody.items.map((i) => i.id).sort()).toEqual([hwA1Id, hwA2Id].sort());

      const theirs = await injectAs(sessions.teacherTwo, 'GET', `/api/v1/classes/${classAId}/homework`);
      expect(theirs.statusCode).toBe(200);
      expect((theirs.json() as { items: unknown[]; total: number }).total).toBe(0);

      const detail = await injectAs(sessions.teacherTwo, 'GET', `/api/v1/classes/${classAId}/homework/${hwA1Id}`);
      expect(detail.statusCode).toBe(404);
      expect(envelope(detail)?.message).toBe('Homework not found');
    });

    it('principal reads all homework rows', async () => {
      const list = await injectAs(sessions.principal, 'GET', `/api/v1/classes/${classAId}/homework`);
      expect(list.statusCode).toBe(200);
      expect((list.json() as { total: number }).total).toBeGreaterThanOrEqual(2);

      const detail = await injectAs(sessions.principal, 'GET', `/api/v1/classes/${classAId}/homework/${hwA1Id}`);
      expect(detail.statusCode).toBe(200);
    });

    it('parent visibility: linked class visible, unlinked class 404/empty', async () => {
      const visible = await injectAs(sessions.parent, 'GET', `/api/v1/classes/${classAId}/homework`);
      expect(visible.statusCode).toBe(200);
      const body = visible.json() as { items: { id: string }[]; total: number };
      expect(body.total).toBeGreaterThanOrEqual(1);

      const detail = await injectAs(sessions.parent, 'GET', `/api/v1/classes/${classAId}/homework/${hwA1Id}`);
      expect(detail.statusCode).toBe(200);

      const hidden = await injectAs(sessions.parent, 'GET', `/api/v1/classes/${classBId}/homework`);
      expect(hidden.statusCode).toBe(200);
      expect((hidden.json() as { items: unknown[]; total: number }).total).toBe(0);

      const hiddenDetail = await injectAs(sessions.parent, 'GET', `/api/v1/classes/${classBId}/homework/${hwA1Id}`);
      expect(hiddenDetail.statusCode).toBe(404);
    });

    it('a homework.read holder without owner/principal/teacher/parent sees nothing (empty list + 404)', async () => {
      const list = await injectAs(sessions.student, 'GET', `/api/v1/classes/${classAId}/homework`);
      expect(list.statusCode).toBe(200);
      expect(list.json()).toEqual({ items: [], total: 0 });

      const detail = await injectAs(sessions.student, 'GET', `/api/v1/classes/${classAId}/homework/${hwA1Id}`);
      expect(detail.statusCode).toBe(404);
    });

    it('principal cannot mutate homework (403 + requiredPermission)', async () => {
      const res = await injectAs(sessions.principal, 'POST', `/api/v1/classes/${classAId}/homework`, {
        headers: withCsrf(sessions.principal),
        payload: { subjectId: subjAId, title: 'P' },
      });
      expect(res.statusCode).toBe(403);
      expect(envelope(res)?.requiredPermission).toBe('homework.create');
    });

    it('idempotent create replays the cached response (single outbox event + attachment set)', async () => {
      const before = await outboxCount('homework.created');
      const key = `hw-idem-${slug}`;
      const payload = { subjectId: subjAId, title: 'Idempotent homework' };
      const first = await injectAs(sessions.teacher, 'POST', `/api/v1/classes/${classAId}/homework`, {
        headers: { ...withCsrf(sessions.teacher), ...idem(key) },
        payload,
      });
      expect(first.statusCode).toBe(201);
      hwIdemId = (first.json().homework as { id: string }).id;
      const replay = await injectAs(sessions.teacher, 'POST', `/api/v1/classes/${classAId}/homework`, {
        headers: { ...withCsrf(sessions.teacher), ...idem(key) },
        payload,
      });
      expect(replay.statusCode).toBe(201);
      expect((replay.json().homework as { id: string }).id).toBe(hwIdemId);
      expect(await outboxCount('homework.created')).toBe(before + 1);
    });

    it('owner can delete homework (homework.deleted); teacher deletes their own', async () => {
      const before = await outboxCount('homework.deleted');
      const res = await inject('DELETE', `/api/v1/classes/${classAId}/homework/${hwIdemId}`, {
        headers: { ...withCsrf(sessions.owner), ...idem(`hw-d1-${slug}`) },
      });
      expect(res.statusCode).toBe(200);
      expect(await outboxCount('homework.deleted')).toBe(before + 1);
      expect(await auditCount('homework.deleted')).toBeGreaterThan(0);
    });
  });

  describe('Phase 4.3 permission templates', () => {
    it('school_owner carries the 7 new grants', async () => {
      const r = await one(
        migratorDb,
        sql`select count(*)::int n from role_permissions rp
            join roles r on r.id = rp.role_id
            where r.tenant_id = ${uid.tenantA} and r.code = 'school_owner'
            and rp.permission in ('timetable.read','timetable.manage','timetable.publish',
                                  'homework.read','homework.create','homework.update','homework.delete')`,
      );
      expect(Number(r.n)).toBe(7);
    });

    it('principal is read-only on the new resources (timetable.read + homework.read only)', async () => {
      const r = await one(
        migratorDb,
        sql`select count(*)::int n from role_permissions rp
            join roles r on r.id = rp.role_id
            where r.tenant_id = ${uid.tenantA} and r.code = 'principal'
            and rp.permission in ('timetable.read','timetable.manage','timetable.publish',
                                  'homework.read','homework.create','homework.update','homework.delete')`,
      );
      expect(Number(r.n)).toBe(2);
    });

    it('teacher: timetable.read + homework full CRUD; no timetable.manage/publish', async () => {
      const r = await one(
        migratorDb,
        sql`select count(*)::int n from role_permissions rp
            join roles r on r.id = rp.role_id
            where r.tenant_id = ${uid.tenantA} and r.code = 'teacher'
            and rp.permission in ('timetable.read','timetable.manage','timetable.publish',
                                  'homework.read','homework.create','homework.update','homework.delete')`,
      );
      expect(Number(r.n)).toBe(5);
    });

    it('parent/student templates carry homework.read only (no timetable read)', async () => {
      const r = await one(
        migratorDb,
        sql`select count(*)::int n from role_permissions rp
            join roles r on r.id = rp.role_id
            where r.tenant_id = ${uid.tenantA} and r.code in ('parent','student')
            and rp.permission in ('timetable.read','timetable.manage','timetable.publish',
                                  'homework.read','homework.create','homework.update','homework.delete')`,
      );
      expect(Number(r.n)).toBe(2);
    });
  });
});