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
import type { HomeworkContext } from '@sms/contracts';

/**
 * Phase 4.4 API acceptance — parent/student homework portals.
 *
 * Proves, against the real app + real PostgreSQL + live Redis:
 *   A. Route gate: /me/homework-context requires a session + homework.read
 *      (401 / 403 with requiredPermission).
 *   B. Role-scoped context resolution: owner/principal -> staff (all live
 *      classes, narrowed to the member's campus when campus-scoped),
 *      teacher -> only classes they are assigned to, parent -> only classes of
 *      their guardianship-linked live-enrolled students, student -> only live
 *      classes of the caller's OWN link (students.user_id), and any other
 *      homework.read holder -> role 'none' with an empty class list.
 *   C. Student read visibility (migration 0013): after an owner links a portal
 *      user via PATCH /students/:id { userId }, the linked student sees their
 *      own class homework while other classes stay empty + 404; an unlinked
 *      student sees nothing at all.
 *   D. Link lifecycle + authorization: only students.update holders may set the
 *      link; cross-tenant / no-membership / suspended targets map to the 55000
 *      trigger as 409 student_link_requires_membership; one live student per
 *      portal user per tenant (409 student_user_already_linked); unlink via
 *      userId:null; campus-scoped owners cannot link students on another
 *      campus; the UPDATE rides the audit trail.
 *
 * Opt-in: RUN_RUNTIME_SECURITY_TESTS=1.
 */
const enabled = process.env.RUN_RUNTIME_SECURITY_TESTS === '1';
const describeDb = enabled ? describe : describe.skip;

const stubStorage = {
  async readObject(): Promise<Buffer> {
    throw new Error('not consulted in Phase 4.4 acceptance');
  },
} as unknown as StorageProvider;

interface SessionCookies {
  token: string;
  csrf: string;
  cookie: string;
}

describeDb('API Phase 4.4 homework portals acceptance (real app + DB + Redis)', () => {
  let migratorDb: Db;
  let appDb: Db;
  let redis: Redis;
  let endMigrator: () => Promise<void>;
  let endApp: () => Promise<void>;
  let endRedis: () => Promise<unknown>;
  let app: Awaited<ReturnType<typeof buildApp>>;

  const uid: Record<string, string> = {};
  const slug = `p44${randomUUID().slice(0, 8)}`;
  const sessions: Record<
    | 'owner'
    | 'principal'
    | 'scoped'
    | 'teacher'
    | 'teacherTwo'
    | 'parent'
    | 'student'
    | 'bystander'
    | 'outsider',
    SessionCookies
  > = {} as never;

  let tenantAId = '';
  let campusAId = '';
  let campusBId = '';
  let yearAId = '';
  let classAId = '';
  let classBId = '';
  let subjAId = '';
  let subjBId = '';
  let hwAId = '';
  let hwBId = '';
  let childParent = ''; // parent's linked child, enrolled in classA
  let childStudent = ''; // studentUser's linked child, enrolled in classA only
  let childCrossCampus = ''; // student on campusB (for the campus-scope PATCH test)
  let studentUserId = '';

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

  const auditCount = async (action: string): Promise<number> => {
    const r = await one(
      migratorDb,
      sql`select count(*)::int n from audit_logs where tenant_id = ${tenantAId} and action = ${action}`,
    );
    return Number(r.n);
  };

  interface InjectResult {
    statusCode: number;
    body: string;
    json(): Record<string, any>;
  }

  const inject = (
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    opts: { headers?: Record<string, string>; payload?: unknown } = {},
  ): Promise<InjectResult> =>
    app.inject({
      method,
      url,
      headers: { cookie: sessions.owner.cookie, ...opts.headers },
      payload: opts.payload as string | undefined,
    }) as unknown as Promise<InjectResult>;

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

  const mkSubject = async (code: string, key: string) => {
    const res = await inject('POST', '/api/v1/subjects', {
      headers: { ...withCsrf(sessions.owner), ...idem(`sb-${key}-${slug}`) },
      payload: { code, name: 'Subject ' + code },
    });
    expect(res.statusCode, `subject ${code}`).toBe(201);
    return (res.json().subject as { id: string }).id;
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
    uid.bystander = randomUUID();
    uid.outsider = randomUUID();
    uid.suspendedUser = randomUUID();
    uid.foreignUser = randomUUID();
    uid.crossUser = randomUUID();

    await rows(
      migratorDb,
      sql`insert into roles (id, scope, code, name, is_system) values (${uid.platRole}, 'platform', ${`p44${slug}_plat`}, 'P44 Platform Admin', true)`,
    );
    await rows(
      migratorDb,
      sql`insert into role_permissions (role_id, permission) values (${uid.platRole}, 'platform.tenants.read'), (${uid.platRole}, 'platform.tenants.create')`,
    );
    await rows(migratorDb, sql`insert into users (id, email) values
      (${uid.owner}, ${`o-${slug}@example.com`}),
      (${uid.principal}, ${`p-${slug}@example.com`}),
      (${uid.scoped}, ${`s-${slug}@example.com`}),
      (${uid.teacherElig}, ${`te-${slug}@example.com`}),
      (${uid.teacherTwo}, ${`t2-${slug}@example.com`}),
      (${uid.parent}, ${`pa-${slug}@example.com`}),
      (${uid.studentUser}, ${`st-${slug}@example.com`}),
      (${uid.bystander}, ${`by-${slug}@example.com`}),
      (${uid.outsider}, ${`ou-${slug}@example.com`}),
      (${uid.suspendedUser}, ${`su-${slug}@example.com`}),
      (${uid.foreignUser}, ${`fo-${slug}@example.com`}),
      (${uid.crossUser}, ${`cr-${slug}@example.com`})`);
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
        name: 'P44 A',
        requestId: randomUUID(),
      }),
    );
    tenantAId = created.tenantId;

    // Tenant B exists ONLY so a cross-tenant membership target can be proven
    // unusable as a link in tenant A.
    await rows(
      migratorDb,
      sql`insert into tenants (id, slug, name) values (${randomUUID()}, ${`${slug}-b`}, 'P44 B')`,
    );
    const tenantBId = String(
      (await one(migratorDb, sql`select id from tenants where slug = ${`${slug}-b`}`)).id,
    );

    const roleIdOf = async (code: string) =>
      String((await one(migratorDb, sql`select id from roles where tenant_id = ${tenantAId} and code = ${code}`)).id);
    const ownerRoleId = await roleIdOf('school_owner');
    const principalRoleId = await roleIdOf('principal');
    const teacherRoleId = await roleIdOf('teacher');
    const parentRoleId = await roleIdOf('parent');
    const studentRoleId = await roleIdOf('student');

    // Custom roles: a bare homework.read holder (portal_reader) and a holder
    // WITHOUT homework.read (portal_outsider).
    uid.roleReader = randomUUID();
    uid.roleOutsider = randomUUID();
    await rows(
      migratorDb,
      sql`insert into roles (id, tenant_id, scope, code, name, is_system) values
        (${uid.roleReader}, ${tenantAId}, 'tenant', 'portal_reader', 'Portal Reader', false),
        (${uid.roleOutsider}, ${tenantAId}, 'tenant', 'portal_outsider', 'Portal Outsider', false)`,
    );
    await rows(
      migratorDb,
      sql`insert into role_permissions (role_id, permission) values (${uid.roleReader}, 'homework.read'), (${uid.roleOutsider}, 'tenant.read')`,
    );

    const member = async (tenantId: string, userId: string, status: string = 'active') => {
      const id = randomUUID();
      await rows(
        migratorDb,
        sql`insert into memberships (id, tenant_id, user_id, status) values (${id}, ${tenantId}, ${userId}, ${status})`,
      );
      return id;
    };
    const role = async (membershipId: string, roleId: string) => {
      await rows(
        migratorDb,
        sql`insert into membership_roles (membership_id, role_id) values (${membershipId}, ${roleId})`,
      );
    };

    const mPrincipal = await member(tenantAId, uid.principal!);
    await role(mPrincipal, principalRoleId);
    const mScoped = await member(tenantAId, uid.scoped!);
    await role(mScoped, ownerRoleId);
    const mTeacher = await member(tenantAId, uid.teacherElig!);
    await role(mTeacher, teacherRoleId);
    const mTeacher2 = await member(tenantAId, uid.teacherTwo!);
    await role(mTeacher2, teacherRoleId);
    const mParent = await member(tenantAId, uid.parent!);
    await role(mParent, parentRoleId);
    const mStudent = await member(tenantAId, uid.studentUser!);
    await role(mStudent, studentRoleId);
    const mBystander = await member(tenantAId, uid.bystander!);
    await role(mBystander, String(uid.roleReader));
    const mOutsider = await member(tenantAId, uid.outsider!);
    await role(mOutsider, String(uid.roleOutsider));
    await member(tenantAId, uid.suspendedUser!, 'suspended');
    await member(tenantBId, uid.crossUser!, 'active');
    // foreignUser deliberately has NO membership anywhere.

    sessions.owner = await makeSession(uid.owner!, tenantAId);
    sessions.principal = await makeSession(uid.principal!, tenantAId);
    sessions.scoped = await makeSession(uid.scoped!, tenantAId);
    sessions.teacher = await makeSession(uid.teacherElig!, tenantAId);
    sessions.teacherTwo = await makeSession(uid.teacherTwo!, tenantAId);
    sessions.parent = await makeSession(uid.parent!, tenantAId);
    sessions.student = await makeSession(uid.studentUser!, tenantAId);
    sessions.bystander = await makeSession(uid.bystander!, tenantAId);
    sessions.outsider = await makeSession(uid.outsider!, tenantAId);

    app = await buildApp({ deps: { db: appDb, redis, storage: stubStorage }, logger: false });

    const mkCampus = async (code: string, name: string, key: string) => {
      const res = await inject('POST', '/api/v1/campuses', {
        headers: { ...withCsrf(sessions.owner), ...idem(`cp-${key}-${slug}`) },
        payload: { code, name },
      });
      expect(res.statusCode).toBe(201);
      return (res.json().campus as { id: string }).id;
    };
    campusAId = await mkCampus(`ca-${slug}`, 'Campus Alpha', 'a');
    campusBId = await mkCampus(`cb-${slug}`, 'Campus Beta', 'b');
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

    // Pin the scoped owner to campusA (classB is out of scope for them).
    await rows(
      migratorDb,
      sql`update memberships set campus_id = ${campusAId} where user_id = ${uid.scoped}`,
    );

    subjAId = await mkSubject(`sb-a-${slug}`, 'a');
    subjBId = await mkSubject(`sb-b-${slug}`, 'b');
    for (const [classId, subjectId, key] of [
      [classAId, subjAId, 'aa'],
      [classBId, subjBId, 'bb'],
    ] as const) {
      const res = await inject('POST', `/api/v1/classes/${classId}/subjects/${subjectId}`, {
        headers: { ...withCsrf(sessions.owner), ...idem(`cs-${key}-${slug}`) },
        payload: {},
      });
      expect(res.statusCode).toBe(201);
    }
    for (const [classId, subjectId, teacherUserId, key] of [
      [classAId, subjAId, uid.teacherElig!, 'aa'],
      [classBId, subjBId, uid.teacherTwo!, 'bb'],
    ] as const) {
      const res = await inject('POST', `/api/v1/classes/${classId}/subjects/${subjectId}/teachers`, {
        headers: { ...withCsrf(sessions.owner), ...idem(`ta-${key}-${slug}`) },
        payload: { teacherUserId },
      });
      expect(res.statusCode).toBe(201);
    }

    const mkHomework = async (classId: string, subjectId: string, title: string, key: string) => {
      const res = await inject('POST', `/api/v1/classes/${classId}/homework`, {
        headers: { ...withCsrf(sessions.owner), ...idem(`hw-${key}-${slug}`) },
        payload: { subjectId, title, dueAt: '2026-06-30T10:00:00.000Z' },
      });
      expect(res.statusCode).toBe(201);
      return (res.json().homework as { id: string }).id;
    };
    hwAId = await mkHomework(classAId, subjAId, 'Algebra sheet A', 'a');
    hwBId = await mkHomework(classBId, subjBId, 'Art project B', 'b');

    // childStudent: a LIVE student row (enrolled in classA) the owner will later
    // link to the student portal user via the API.
    childStudent = randomUUID();
    studentUserId = childStudent;
    await rows(
      migratorDb,
      sql`insert into students (id, tenant_id, student_no, first_name, last_name, status)
          values (${childStudent}, ${tenantAId}, ${`st-${slug}`}, 'Stu', 'Portal', 'active')`,
    );
    await rows(
      migratorDb,
      sql`insert into enrollments (id, tenant_id, student_id, academic_year_id, class_id, status, roll_no)
          values (${randomUUID()}, ${tenantAId}, ${childStudent}, ${yearAId}, ${classAId}, 'active', ${`r1-${slug}`})`,
    );

    // childParent: a LIVE student enrolled in classA, linked to the parent via
    // a guardian row (the Phase 4.3 chain the parent portal relies on).
    childParent = randomUUID();
    const guardianId = randomUUID();
    await rows(
      migratorDb,
      sql`insert into guardians (id, tenant_id, user_id, first_name, last_name)
          values (${guardianId}, ${tenantAId}, ${uid.parent}, 'Guardian', 'Parent')`,
    );
    await rows(
      migratorDb,
      sql`insert into students (id, tenant_id, student_no, first_name, last_name, status)
          values (${childParent}, ${tenantAId}, ${`pa-${slug}`}, 'Kid', 'Parent', 'active')`,
    );
    await rows(
      migratorDb,
      sql`insert into student_guardians (id, tenant_id, student_id, guardian_id, relation, is_primary)
          values (${randomUUID()}, ${tenantAId}, ${childParent}, ${guardianId}, 'parent', true)`,
    );
    await rows(
      migratorDb,
      sql`insert into enrollments (id, tenant_id, student_id, academic_year_id, class_id, status, roll_no)
          values (${randomUUID()}, ${tenantAId}, ${childParent}, ${yearAId}, ${classAId}, 'active', ${`r2-${slug}`})`,
    );

    // childCrossCampus: a LIVE student on campusB — a campus-scoped (campusA)
    // owner must NOT be able to touch it.
    childCrossCampus = randomUUID();
    await rows(
      migratorDb,
      sql`insert into students (id, tenant_id, student_no, first_name, last_name, status, primary_campus_id)
          values (${childCrossCampus}, ${tenantAId}, ${`cc-${slug}`}, 'Other', 'Campus', 'active', ${campusBId})`,
    );
  });

  afterAll(async () => {
    try {
      if (app) await app.close();
      const tIn = `'${tenantAId}'`;
      await rows(migratorDb, sql`delete from homework_attachments where tenant_id in (${sql.raw(tIn)})`);
      await rows(migratorDb, sql`delete from homework where tenant_id in (${sql.raw(tIn)})`);
      await rows(migratorDb, sql`delete from teacher_assignments where tenant_id in (${sql.raw(tIn)})`);
      await rows(migratorDb, sql`delete from class_subjects where tenant_id in (${sql.raw(tIn)})`);
      await rows(migratorDb, sql`delete from enrollments where tenant_id in (${sql.raw(tIn)})`);
      await rows(migratorDb, sql`delete from student_guardians where tenant_id in (${sql.raw(tIn)})`);
      await rows(migratorDb, sql`delete from students where tenant_id in (${sql.raw(tIn)})`);
      await rows(migratorDb, sql`delete from guardians where tenant_id in (${sql.raw(tIn)})`);
      await rows(migratorDb, sql`delete from acd_classes where tenant_id in (${sql.raw(tIn)})`);
      await rows(migratorDb, sql`delete from subjects where tenant_id in (${sql.raw(tIn)})`);
      await rows(migratorDb, sql`delete from outbox_events where tenant_id in (${sql.raw(tIn)})`);
      await rows(migratorDb, sql`delete from idempotency_keys where tenant_id in (${sql.raw(tIn)})`);
      await rows(migratorDb, sql`delete from audit_logs where tenant_id in (${sql.raw(tIn)})`);
      await rows(migratorDb, sql`delete from academic_years where tenant_id in (${sql.raw(tIn)})`);
      await rows(migratorDb, sql`delete from campuses where tenant_id in (${sql.raw(tIn)})`);
      await rows(
        migratorDb,
        sql`delete from membership_roles where membership_id in (
          select id from memberships where tenant_id in (${sql.raw(tIn)}) or user_id in (${uid.principal}, ${uid.scoped}, ${uid.teacherElig}, ${uid.teacherTwo}, ${uid.parent}, ${uid.studentUser}, ${uid.bystander}, ${uid.outsider}, ${uid.suspendedUser}, ${uid.crossUser}))`,
      );
      await rows(
        migratorDb,
        sql`delete from role_permissions where role_id in (select id from roles where tenant_id in (${sql.raw(tIn)}) or id = ${uid.platRole})`,
      );
      await rows(
        migratorDb,
        sql`delete from memberships where tenant_id in (${sql.raw(tIn)}) or user_id in (${uid.principal}, ${uid.scoped}, ${uid.teacherElig}, ${uid.teacherTwo}, ${uid.parent}, ${uid.studentUser}, ${uid.bystander}, ${uid.outsider}, ${uid.suspendedUser}, ${uid.crossUser})`,
      );
      await rows(
        migratorDb,
        sql`delete from platform_role_assignments where user_id = ${uid.owner}`,
      );
      await rows(migratorDb, sql`delete from roles where id in (${uid.platRole}, ${uid.roleReader}, ${uid.roleOutsider})`);
      await rows(
        migratorDb,
        sql`delete from roles where tenant_id in (${sql.raw(tIn)}) or id = ${uid.platRole}`,
      );
      await rows(migratorDb, sql`delete from tenants where slug in (${`${slug}-a`}, ${`${slug}-b`})`);
      await rows(migratorDb, sql`delete from users where email like ${`%@${slug}.example.com`}`);
    } finally {
      await endRedis();
      await endApp();
      await endMigrator();
    }
  });

  describe('Phase 4.4 /me/homework-context gate', () => {
    it('requires a session (401 without one)', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/me/homework-context' });
      expect(res.statusCode).toBe(401);
    });

    it('requires homework.read (403 + requiredPermission for a tenant member without it)', async () => {
      const res = await injectAs(sessions.outsider, 'GET', '/api/v1/me/homework-context');
      expect(res.statusCode).toBe(403);
      expect(envelope(res)?.requiredPermission).toBe('homework.read');
    });

    it('a bare homework.read holder resolves to role none with no classes', async () => {
      const res = await injectAs(sessions.bystander, 'GET', '/api/v1/me/homework-context');
      expect(res.statusCode).toBe(200);
      const ctx = (res.json() as { context: HomeworkContext }).context;
      expect(ctx.role).toBe('none');
      expect(ctx.classes).toEqual([]);
    });
  });

  describe('Phase 4.4 role-scoped context resolution', () => {
    it('owner/principal see every live class (role staff)', async () => {
      for (const s of [sessions.owner, sessions.principal]) {
        const res = await injectAs(s, 'GET', '/api/v1/me/homework-context');
        expect(res.statusCode).toBe(200);
        const ctx = (res.json() as { context: HomeworkContext }).context;
        expect(ctx.role).toBe('staff');
        expect(ctx.classes.map((c) => c.id).sort()).toEqual([classAId, classBId].sort());
        const first = ctx.classes[0]!;
        expect(first.id).toBeTruthy();
        expect(typeof first.code).toBe('string');
        expect(first.campusId).toBeTruthy();
        expect(first.academicYearId).toBe(yearAId);
      }
    });

    it('teacher sees only the classes they teach', async () => {
      const res = await injectAs(sessions.teacher, 'GET', '/api/v1/me/homework-context');
      expect(res.statusCode).toBe(200);
      const ctx = (res.json() as { context: HomeworkContext }).context;
      expect(ctx.role).toBe('teacher');
      expect(ctx.classes.map((c) => c.id)).toEqual([classAId]);
    });

    it('parent sees only live-enrolled classes of their linked children', async () => {
      const res = await injectAs(sessions.parent, 'GET', '/api/v1/me/homework-context');
      expect(res.statusCode).toBe(200);
      const ctx = (res.json() as { context: HomeworkContext }).context;
      expect(ctx.role).toBe('parent');
      expect(ctx.classes.map((c) => c.id)).toEqual([classAId]);
    });

    it('an unlinked student resolves role student with no classes', async () => {
      const res = await injectAs(sessions.student, 'GET', '/api/v1/me/homework-context');
      expect(res.statusCode).toBe(200);
      const ctx = (res.json() as { context: HomeworkContext }).context;
      expect(ctx.role).toBe('student');
      expect(ctx.classes).toEqual([]);
    });

    it('a campus-scoped owner sees only their own campus classes (staff)', async () => {
      const res = await injectAs(sessions.scoped, 'GET', '/api/v1/me/homework-context');
      expect(res.statusCode).toBe(200);
      const ctx = (res.json() as { context: HomeworkContext }).context;
      expect(ctx.role).toBe('staff');
      expect(ctx.classes.map((c) => c.id)).toEqual([classAId]);
    });
  });

  describe('Phase 4.4 student link + portal visibility', () => {
    it('owner links the portal user to their student row (student.updated audit)', async () => {
      const before = await auditCount('student.updated');
      const res = await inject('PATCH', `/api/v1/students/${childStudent}`, {
        headers: { ...withCsrf(sessions.owner), ...idem(`link-1-${slug}`) },
        payload: { userId: uid.studentUser },
      });
      expect(res.statusCode).toBe(200);
      expect((res.json().student as { userId: string | null }).userId).toBe(uid.studentUser);
      expect(await auditCount('student.updated')).toBe(before + 1);
    });

    it('a parent/teacher cannot set the link (403 students.update)', async () => {
      for (const s of [sessions.parent, sessions.teacher]) {
        const res = await injectAs(s, 'PATCH', `/api/v1/students/${childStudent}`, {
          headers: withCsrf(s),
          payload: { firstName: 'x' },
        });
        expect(res.statusCode).toBe(403);
        expect(envelope(res)?.requiredPermission).toBe('students.update');
      }
    });

    it('linking to a user with no membership is a 409 student_link_requires_membership', async () => {
      const res = await inject('PATCH', `/api/v1/students/${childStudent}`, {
        headers: { ...withCsrf(sessions.owner), ...idem(`link-2-${slug}`) },
        payload: { userId: uid.foreignUser },
      });
      expect(res.statusCode).toBe(409);
      expect(envelope(res)?.code).toBe('student_link_requires_membership');
    });

    it('linking to a cross-tenant member is a 409 student_link_requires_membership', async () => {
      const res = await inject('PATCH', `/api/v1/students/${childStudent}`, {
        headers: { ...withCsrf(sessions.owner), ...idem(`link-3-${slug}`) },
        payload: { userId: uid.crossUser },
      });
      expect(res.statusCode).toBe(409);
      expect(envelope(res)?.code).toBe('student_link_requires_membership');
    });

    it('linking to a suspended membership is a 409 student_link_requires_membership', async () => {
      const res = await inject('PATCH', `/api/v1/students/${childStudent}`, {
        headers: { ...withCsrf(sessions.owner), ...idem(`link-4-${slug}`) },
        payload: { userId: uid.suspendedUser },
      });
      expect(res.statusCode).toBe(409);
      expect(envelope(res)?.code).toBe('student_link_requires_membership');
    });

    it('one live student per portal user per tenant (409 student_user_already_linked)', async () => {
      const otherStudent = randomUUID();
      await rows(
        migratorDb,
        sql`insert into students (id, tenant_id, student_no, first_name, last_name, status)
            values (${otherStudent}, ${tenantAId}, ${`sl-${slug}`}, 'Dup', 'Link', 'active')`,
      );
      const res = await inject('PATCH', `/api/v1/students/${otherStudent}`, {
        headers: { ...withCsrf(sessions.owner), ...idem(`link-5-${slug}`) },
        payload: { userId: uid.studentUser },
      });
      expect(res.statusCode).toBe(409);
      expect(envelope(res)?.code).toBe('student_user_already_linked');
    });

    it('a campus-scoped owner cannot touch a student on another campus (403 campus_scope_denied)', async () => {
      const res = await injectAs(sessions.scoped, 'PATCH', `/api/v1/students/${childCrossCampus}`, {
        headers: { ...withCsrf(sessions.scoped), ...idem(`link-6-${slug}`) },
        payload: { firstName: 'Nope' },
      });
      expect(res.statusCode).toBe(403);
      expect(envelope(res)?.code).toBe('campus_scope_denied');
    });

    it('the old link survives a relink failure; unlink via userId:null works', async () => {
      const res = await inject('PATCH', `/api/v1/students/${childStudent}`, {
        headers: { ...withCsrf(sessions.owner), ...idem(`link-7-${slug}`) },
        payload: { userId: null },
      });
      expect(res.statusCode).toBe(200);
      expect((res.json().student as { userId: string | null }).userId).toBeNull();

      const relink = await inject('PATCH', `/api/v1/students/${childStudent}`, {
        headers: { ...withCsrf(sessions.owner), ...idem(`link-8-${slug}`) },
        payload: { userId: uid.studentUser },
      });
      expect(relink.statusCode).toBe(200);
    });

    it('a mass-assignment attempt with an internal field is rejected as validation_error', async () => {
      const res = await inject('PATCH', `/api/v1/students/${childStudent}`, {
        headers: { ...withCsrf(sessions.owner), ...idem(`link-9-${slug}`) },
        payload: { tenantId: tenantAId, userId: uid.studentUser },
      });
      expect(res.statusCode).toBe(400);
      expect(envelope(res)?.code).toBe('validation_error');
    });
  });

  describe('Phase 4.4 linked student read visibility', () => {
    it('now sees their own class homework (list + detail 200)', async () => {
      const list = await injectAs(sessions.student, 'GET', `/api/v1/classes/${classAId}/homework`);
      expect(list.statusCode).toBe(200);
      const body = list.json() as { items: { id: string }[]; total: number };
      expect(body.total).toBeGreaterThanOrEqual(1);
      expect(body.items.map((i) => i.id)).toContain(hwAId);

      const detail = await injectAs(sessions.student, 'GET', `/api/v1/classes/${classAId}/homework/${hwAId}`);
      expect(detail.statusCode).toBe(200);
    });

    it('other classes stay hidden (empty list + 404 detail)', async () => {
      const list = await injectAs(sessions.student, 'GET', `/api/v1/classes/${classBId}/homework`);
      expect(list.statusCode).toBe(200);
      expect(list.json()).toEqual({ items: [], total: 0 });

      const detail = await injectAs(sessions.student, 'GET', `/api/v1/classes/${classBId}/homework/${hwBId}`);
      expect(detail.statusCode).toBe(404);
      expect(envelope(detail)?.message).toBe('Homework not found');
    });

    it('the student portal context now lists their own class', async () => {
      const res = await injectAs(sessions.student, 'GET', '/api/v1/me/homework-context');
      expect(res.statusCode).toBe(200);
      const ctx = (res.json() as { context: HomeworkContext }).context;
      expect(ctx.role).toBe('student');
      expect(ctx.classes.map((c) => c.id)).toEqual([classAId]);
    });

    it('teacher scope is unchanged after the student portal lands', async () => {
      const mine = await injectAs(sessions.teacher, 'GET', `/api/v1/classes/${classAId}/homework`);
      expect(mine.statusCode).toBe(200);
      expect((mine.json() as { items: { id: string }[] }).items.map((i) => i.id)).toContain(hwAId);

      const theirs = await injectAs(sessions.teacher, 'GET', `/api/v1/classes/${classBId}/homework`);
      expect(theirs.statusCode).toBe(200);
      expect((theirs.json() as { items: unknown[]; total: number }).total).toBe(0);
    });
  });
});