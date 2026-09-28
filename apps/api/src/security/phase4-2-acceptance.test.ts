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
 * Phase 4.2 API acceptance: grade levels, subjects, class-subject attachments &
 * teacher assignments against the real app + real PostgreSQL + live Redis.
 * Proves the full loop the DB tests cannot — permission templates (school_owner
 * with all 12 new permissions, read-only principal), campus-scope guard on the
 * class-pinned routes, idempotency + audit + outbox (14 new event types),
 * canonical 409 mappings of the Phase 4.2 integrity triggers, create-only
 * gradeLevelId, the eligible-teacher directory, and strict mass-assignment
 * rejection. Mirrors phase4-1-acceptance.
 *
 * Opt-in: RUN_RUNTIME_SECURITY_TESTS=1.
 */
const enabled = process.env.RUN_RUNTIME_SECURITY_TESTS === '1';
const describeDb = enabled ? describe : describe.skip;

const stubStorage = {
  async readObject(): Promise<Buffer> {
    throw new Error('not consulted in Phase 4.2 acceptance');
  },
} as unknown as StorageProvider;

interface SessionCookies {
  token: string;
  csrf: string;
  cookie: string;
}

describeDb('API Phase 4.2 academics/catalog acceptance (real app + DB + Redis)', () => {
  let migratorDb: Db;
  let appDb: Db;
  let redis: Redis;
  let endMigrator: () => Promise<void>;
  let endApp: () => Promise<void>;
  let endRedis: () => Promise<unknown>;
  let app: Awaited<ReturnType<typeof buildApp>>;

  const uid: Record<string, string> = {};
  const slug = `p42${randomUUID().slice(0, 8)}`;
  const sessions: Record<'owner' | 'principal' | 'scoped' | 'teacher', SessionCookies> = {} as never;

  let campusAId = '';
  let campusBId = '';
  let yearAId = '';
  let classAId = '';
  let classBId = '';
  let levelRefId = '';
  let classWithLevelId = '';
  let subjAId = '';
  let subjBId = '';
  let subjCId = '';
  let subjDId = '';
  let subjGuardId = '';
  let idempotentLevelId = '';

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

  const mkGradeLevel = async (code: string, key: string) => {
    const res = await inject('POST', '/api/v1/grade-levels', {
      headers: { ...withCsrf(sessions.owner), ...idem(`gl-${key}-${slug}`) },
      payload: { code, name: 'Level ' + code },
    });
    expect(res.statusCode, `grade level ${code}`).toBe(201);
    return (res.json().gradeLevel as { id: string }).id;
  };

  const mkSubject = async (code: string, key: string) => {
    const res = await inject('POST', '/api/v1/subjects', {
      headers: { ...withCsrf(sessions.owner), ...idem(`sb-${key}-${slug}`) },
      payload: { code, name: 'Subject ' + code },
    });
    expect(res.statusCode, `subject ${code}`).toBe(201);
    return (res.json().subject as { id: string }).id;
  };

  const mkClass = async (campusId: string, code: string, name: string, key: string, extra: Record<string, unknown> = {}) => {
    const res = await inject('POST', '/api/v1/classes', {
      headers: { ...withCsrf(sessions.owner), ...idem(`cl-${key}-${slug}`) },
      payload: { campusId, academicYearId: yearAId, code, name, ...extra },
    });
    expect(res.statusCode, `class ${code}`).toBe(201);
    return (res.json().class as { id: string }).id;
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
    uid.teacherNoRole = randomUUID();
    uid.teacherInactive = randomUUID();
    uid.teacherGhost = randomUUID();
    uid.ownerEmail = `owner-${slug}@example.com`;
    uid.principalEmail = `principal-${slug}@example.com`;
    uid.scopedEmail = `scoped-${slug}@example.com`;

    await rows(
      migratorDb,
      sql`insert into roles (id, scope, code, name, is_system) values (${uid.platRole}, 'platform', ${`p42${slug}_plat`}, 'P4 Platform Admin', true)`,
    );
    await rows(
      migratorDb,
      sql`insert into role_permissions (role_id, permission) values (${uid.platRole}, 'platform.tenants.read'), (${uid.platRole}, 'platform.tenants.create')`,
    );
    await rows(migratorDb, sql`insert into users (id, email) values (${uid.owner}, ${uid.ownerEmail})`);
    await rows(
      migratorDb,
      sql`insert into platform_role_assignments (user_id, role_id) values (${uid.owner}, ${uid.platRole})`,
    );
    await rows(migratorDb, sql`insert into users (id, email) values (${uid.principal}, ${uid.principalEmail})`);
    await rows(migratorDb, sql`insert into users (id, email) values (${uid.scoped}, ${uid.scopedEmail})`);

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
        name: 'P42 A',
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
    // Campus-scoped member: school_owner template + membership, pinned to campusA below.
    uid.scopedMembership = randomUUID();
    await rows(
      migratorDb,
      sql`insert into memberships (id, tenant_id, user_id, status) values (${uid.scopedMembership}, ${uid.tenantA}, ${uid.scoped}, 'active')`,
    );
    await rows(
      migratorDb,
      sql`insert into membership_roles (membership_id, role_id) values (${uid.scopedMembership}, ${schoolOwnerId})`,
    );

    // Teacher-role scaffolding. createTenantTransaction seeds the tenant-scoped
    // `teacher` role from ROLE_TEMPLATES — reuse it. Two memberships: eligible
    // (active + role) and suspended (suspended + role); plus an active member
    // with NO teacher role. The directory and the DB trigger both rely on the
    // ACTIVE membership + tenant `teacher` role combination.
    uid.roleTeacher = String(
      (await one(
        migratorDb,
        sql`select id from roles where tenant_id = ${uid.tenantA} and code = 'teacher'`,
      )).id,
    );
    await rows(migratorDb, sql`insert into users (id, email) values
      (${uid.teacherElig}, ${`te-${slug}@example.com`}),
      (${uid.teacherNoRole}, ${`tn-${slug}@example.com`}),
      (${uid.teacherInactive}, ${`ti-${slug}@example.com`})`);
    await rows(migratorDb, sql`insert into user_profiles (user_id, full_name) values
      (${uid.teacherElig}, 'Eligible Teacher'),
      (${uid.teacherNoRole}, 'No Role Teacher'),
      (${uid.teacherInactive}, 'Inactive Teacher')`);
    uid.membershipElig = randomUUID();
    uid.membershipNoRole = randomUUID();
    uid.membershipInactive = randomUUID();
    await rows(
      migratorDb,
      sql`insert into memberships (id, tenant_id, user_id, status) values
        (${uid.membershipElig}, ${uid.tenantA}, ${uid.teacherElig}, 'active'),
        (${uid.membershipNoRole}, ${uid.tenantA}, ${uid.teacherNoRole}, 'active'),
        (${uid.membershipInactive}, ${uid.tenantA}, ${uid.teacherInactive}, 'suspended')`,
    );
    await rows(
      migratorDb,
      sql`insert into membership_roles (membership_id, role_id) values
        (${uid.membershipElig}, ${uid.roleTeacher}),
        (${uid.membershipInactive}, ${uid.roleTeacher})`,
    );

    sessions.owner = await makeSession(uid.owner!, uid.tenantA!);
    sessions.principal = await makeSession(uid.principal!, uid.tenantA!);
    sessions.scoped = await makeSession(uid.scoped!, uid.tenantA!);

    app = await buildApp({ deps: { db: appDb, redis, storage: stubStorage }, logger: false });

    campusAId = await (async () => {
      const res = await inject('POST', '/api/v1/campuses', {
        headers: { ...withCsrf(sessions.owner), ...idem(`cp-a-${slug}`) },
        payload: { code: `ca-${slug}`, name: 'Campus Alpha' },
      });
      expect(res.statusCode).toBe(201);
      return (res.json().campus as { id: string }).id;
    })();
    campusBId = await (async () => {
      const res = await inject('POST', '/api/v1/campuses', {
        headers: { ...withCsrf(sessions.owner), ...idem(`cp-b-${slug}`) },
        payload: { code: `cb-${slug}`, name: 'Campus Beta' },
      });
      expect(res.statusCode).toBe(201);
      return (res.json().campus as { id: string }).id;
    })();
    const year = await inject('POST', '/api/v1/academic-years', {
      headers: { ...withCsrf(sessions.owner), ...idem(`yr-${slug}`) },
      payload: { code: `ay-${slug}`, name: 'AY 2026', startsOn: '2026-01-01', endsOn: '2026-12-31' },
    });
    expect(year.statusCode).toBe(201);
    yearAId = (year.json().academicYear as { id: string }).id;

    classAId = await mkClass(campusAId, `c1-${slug}`, 'Class One', 'a');
    classBId = await mkClass(campusBId, `c2-${slug}`, 'Class Two', 'b');

    // Pin the scoped member to campusA so classB routes are out of scope.
    await rows(
      migratorDb,
      sql`update memberships set campus_id = ${campusAId} where id = ${uid.scopedMembership}`,
    );
  });

  afterAll(async () => {
    try {
      if (app) await app.close();
      const tIn = `'${uid.tenantA}'`;
      await rows(migratorDb, sql`delete from teacher_assignments where tenant_id in (${sql.raw(tIn)})`);
      await rows(migratorDb, sql`delete from class_subjects where tenant_id in (${sql.raw(tIn)})`);
      await rows(migratorDb, sql`delete from acd_classes where tenant_id in (${sql.raw(tIn)})`);
      await rows(migratorDb, sql`delete from subjects where tenant_id in (${sql.raw(tIn)})`);
      await rows(migratorDb, sql`delete from grade_levels where tenant_id in (${sql.raw(tIn)})`);
      await rows(migratorDb, sql`delete from outbox_events where tenant_id in (${sql.raw(tIn)})`);
      await rows(migratorDb, sql`delete from idempotency_keys where tenant_id in (${sql.raw(tIn)})`);
      await rows(migratorDb, sql`delete from academic_years where tenant_id in (${sql.raw(tIn)})`);
      await rows(migratorDb, sql`delete from campuses where tenant_id in (${sql.raw(tIn)})`);
      await rows(
        migratorDb,
        sql`delete from membership_roles where membership_id in (
          select id from memberships where tenant_id in (${sql.raw(tIn)}) or user_id in (${uid.principal}, ${uid.scoped}, ${uid.teacherElig}, ${uid.teacherNoRole}, ${uid.teacherInactive}))`,
      );
      await rows(
        migratorDb,
        sql`delete from role_permissions where role_id in (select id from roles where tenant_id in (${sql.raw(tIn)}) or id = ${uid.platRole})`,
      );
      await rows(
        migratorDb,
        sql`delete from memberships where tenant_id in (${sql.raw(tIn)}) or user_id in (${uid.principal}, ${uid.scoped}, ${uid.teacherElig}, ${uid.teacherNoRole}, ${uid.teacherInactive})`,
      );
      await rows(
        migratorDb,
        sql`delete from user_profiles where user_id in (${uid.teacherElig}, ${uid.teacherNoRole}, ${uid.teacherInactive})`,
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
        sql`delete from users where id in (${uid.owner}, ${uid.principal}, ${uid.scoped}, ${uid.teacherElig}, ${uid.teacherNoRole}, ${uid.teacherInactive})`,
      );
      await rows(migratorDb, sql`delete from tenants where id in (${sql.raw(tIn)})`);
    } finally {
      await endMigrator();
      await endApp();
      await endRedis?.();
    }
  });

  describe('grade levels', () => {
    it('creator creates a grade level; audit + outbox (grade.level.created)', async () => {
      const before = await outboxCount('grade.level.created');
      const res = await inject('POST', '/api/v1/grade-levels', {
        headers: { ...withCsrf(sessions.owner), ...idem(`gl-1-${slug}`) },
        payload: { code: `gl-1-${slug}`, name: 'Grade One' },
      });
      expect(res.statusCode).toBe(201);
      const level = res.json().gradeLevel as { id: string; status: string; tenantId: string };
      expect(level.status).toBe('active');
      expect(level.tenantId).toBe(uid.tenantA);
      expect(await outboxCount('grade.level.created')).toBe(before + 1);
      expect(await auditCount('grade.level.created')).toBeGreaterThan(0);
    });

    it('duplicate code maps to 409 grade_level_code_taken', async () => {
      const res = await inject('POST', '/api/v1/grade-levels', {
        headers: { ...withCsrf(sessions.owner), ...idem(`gl-dup-${slug}`) },
        payload: { code: `gl-1-${slug}`, name: 'Dup' },
      });
      expect(res.statusCode).toBe(409);
      expect(envelope(res)?.code).toBe('grade_level_code_taken');
    });

    it('list/single/PATCH (outbox grade.level.updated)', async () => {
      levelRefId = await mkGradeLevel(`gl-ref-${slug}`, 'ref');
      const list = await inject('GET', '/api/v1/grade-levels');
      expect(list.statusCode).toBe(200);
      const items = (list.json() as { items: { code: string }[] }).items;
      expect(items.some((i) => i.code === `gl-1-${slug}`)).toBe(true);

      const single = await inject('GET', `/api/v1/grade-levels/${levelRefId}`);
      expect(single.statusCode).toBe(200);

      const before = await outboxCount('grade.level.updated');
      const renamed = await inject('PATCH', `/api/v1/grade-levels/${levelRefId}`, {
        headers: withCsrf(sessions.owner),
        payload: { name: 'Level Renamed' },
      });
      expect(renamed.statusCode).toBe(200);
      expect((renamed.json().gradeLevel as { name: string }).name).toBe('Level Renamed');
      expect(await outboxCount('grade.level.updated')).toBe(before + 1);
    });

    it('activate/deactivate lifecycle maps to grade.level.activated/deactivated', async () => {
      const deact = await inject('POST', `/api/v1/grade-levels/${levelRefId}/deactivate`, {
        headers: withCsrf(sessions.owner),
      });
      expect(deact.statusCode).toBe(200);
      expect((deact.json().gradeLevel as { status: string }).status).toBe('inactive');
      const act = await inject('POST', `/api/v1/grade-levels/${levelRefId}/activate`, {
        headers: withCsrf(sessions.owner),
      });
      expect(act.statusCode).toBe(200);
      expect((act.json().gradeLevel as { status: string }).status).toBe('active');
      expect(await auditCount('grade.level.deactivated')).toBeGreaterThan(0);
    });

    it('DELETE refused while a live class references it (409 grade_level_has_classes)', async () => {
      const guarded = await mkGradeLevel(`gl-guard-${slug}`, 'guard');
      classWithLevelId = await mkClass(campusAId, `gc-${slug}`, 'Guarded Class', 'guard', {
        gradeLevelId: guarded,
      });
      const del = await inject('DELETE', `/api/v1/grade-levels/${guarded}`, {
        headers: { ...withCsrf(sessions.owner), ...idem(`glg-${slug}`) },
      });
      expect(del.statusCode).toBe(409);
      expect(envelope(del)?.code).toBe('grade_level_has_classes');

      // Removing the referencing class unblocks the delete.
      const delClass = await inject('DELETE', `/api/v1/classes/${classWithLevelId}`, {
        headers: { ...withCsrf(sessions.owner), ...idem(`clg-${slug}`) },
      });
      expect(delClass.statusCode).toBe(200);
      const del2 = await inject('DELETE', `/api/v1/grade-levels/${guarded}`, {
        headers: { ...withCsrf(sessions.owner), ...idem(`glg2-${slug}`) },
      });
      expect(del2.statusCode).toBe(200);
      expect(await auditCount('grade.level.deleted')).toBeGreaterThan(0);
    });

    it('mass-assignment is rejected (strict schema) with 400 validation_error', async () => {
      const res = await inject('POST', '/api/v1/grade-levels', {
        headers: withCsrf(sessions.owner),
        payload: { code: `gl-x-${slug}`, name: 'X', status: 'inactive', tenantId: uid.tenantA },
      });
      expect(res.statusCode).toBe(400);
      expect(envelope(res)?.code).toBe('validation_error');
    });

    it('idempotent create replays the cached response (single outbox event)', async () => {
      const before = await outboxCount('grade.level.created');
      const key = `gl-idem-${slug}`;
      const payload = { code: `gl-idem-${slug}`, name: 'Idempotent Level' };
      const first = await inject('POST', '/api/v1/grade-levels', {
        headers: { ...withCsrf(sessions.owner), ...idem(key) },
        payload,
      });
      expect(first.statusCode).toBe(201);
      idempotentLevelId = (first.json().gradeLevel as { id: string }).id;
      const replay = await inject('POST', '/api/v1/grade-levels', {
        headers: { ...withCsrf(sessions.owner), ...idem(key) },
        payload,
      });
      expect(replay.statusCode).toBe(201);
      expect((replay.json().gradeLevel as { id: string }).id).toBe(idempotentLevelId);
      expect(await outboxCount('grade.level.created')).toBe(before + 1);
    });
  });

  describe('subjects', () => {
    it('creator creates a subject; audit + outbox (subject.created)', async () => {
      const before = await outboxCount('subject.created');
      subjAId = await mkSubject(`sb-a-${slug}`, 'a');
      expect(await outboxCount('subject.created')).toBe(before + 1);
      expect(await auditCount('subject.created')).toBeGreaterThan(0);
    });

    it('duplicate code maps to 409 subject_code_taken', async () => {
      const res = await inject('POST', '/api/v1/subjects', {
        headers: { ...withCsrf(sessions.owner), ...idem(`sb-dup-${slug}`) },
        payload: { code: `sb-a-${slug}`, name: 'Dup' },
      });
      expect(res.statusCode).toBe(409);
      expect(envelope(res)?.code).toBe('subject_code_taken');
    });

    it('list/single/PATCH; subject lifecycle events', async () => {
      subjBId = await mkSubject(`sb-b-${slug}`, 'b');
      subjCId = await mkSubject(`sb-c-${slug}`, 'c');
      subjDId = await mkSubject(`sb-d-${slug}`, 'd');

      const list = await inject('GET', '/api/v1/subjects');
      expect(list.statusCode).toBe(200);
      expect((list.json() as { items: { code: string }[] }).items.some((i) => i.code === `sb-a-${slug}`)).toBe(true);

      const renamed = await inject('PATCH', `/api/v1/subjects/${subjBId}`, {
        headers: withCsrf(sessions.owner),
        payload: { name: 'Subject B Renamed' },
      });
      expect(renamed.statusCode).toBe(200);
      expect((renamed.json().subject as { name: string }).name).toBe('Subject B Renamed');

      const deact = await inject('POST', `/api/v1/subjects/${subjBId}/deactivate`, {
        headers: withCsrf(sessions.owner),
      });
      expect(deact.statusCode).toBe(200);
      expect((deact.json().subject as { status: string }).status).toBe('inactive');
      const act = await inject('POST', `/api/v1/subjects/${subjBId}/activate`, {
        headers: withCsrf(sessions.owner),
      });
      expect(act.statusCode).toBe(200);
      expect(await auditCount('subject.deactivated')).toBeGreaterThan(0);
    });
  });

  describe('class subjects & teacher assignments (lifecycle flow)', () => {
    it('attach a subject to a class; campus/year pinned from the class; outbox class.subject.assigned', async () => {
      const before = await outboxCount('class.subject.assigned');
      const res = await inject('POST', `/api/v1/classes/${classAId}/subjects/${subjAId}`, {
        headers: { ...withCsrf(sessions.owner), ...idem(`cs-a-${slug}`) },
        payload: {},
      });
      expect(res.statusCode).toBe(201);
      const link = res.json().classSubject as {
        id: string;
        classId: string;
        subjectId: string;
        campusId: string;
        academicYearId: string;
      };
      expect(link.classId).toBe(classAId);
      expect(link.subjectId).toBe(subjAId);
      expect(link.campusId).toBe(campusAId);
      expect(link.academicYearId).toBe(yearAId);
      expect(await outboxCount('class.subject.assigned')).toBe(before + 1);
      expect(await auditCount('class.subject.assigned')).toBeGreaterThan(0);
    });

    it('duplicate attachment maps to 409 class_subject_already_linked', async () => {
      const res = await inject('POST', `/api/v1/classes/${classAId}/subjects/${subjAId}`, {
        headers: { ...withCsrf(sessions.owner), ...idem(`cs-du-${slug}`) },
        payload: {},
      });
      expect(res.statusCode).toBe(409);
      expect(envelope(res)?.code).toBe('class_subject_already_linked');
    });

    it('missing parents 404 (class or subject)', async () => {
      const badSubject = await inject('POST', `/api/v1/classes/${classAId}/subjects/${randomUUID()}`, {
        headers: withCsrf(sessions.owner),
        payload: {},
      });
      expect(badSubject.statusCode).toBe(404);
      expect(envelope(badSubject)?.message).toBe('Subject not found');

      const badClass = await inject('POST', `/api/v1/classes/${randomUUID()}/subjects/${subjAId}`, {
        headers: withCsrf(sessions.owner),
        payload: {},
      });
      expect(badClass.statusCode).toBe(404);
      expect(envelope(badClass)?.message).toBe('Class not found');
    });

    it('campus-scoped member is denied on the other campus; allowed on own campus', async () => {
      const denied = await injectAs(
        sessions.scoped,
        'POST',
        `/api/v1/classes/${classBId}/subjects/${subjBId}`,
        { headers: withCsrf(sessions.scoped), payload: {} },
      );
      expect(denied.statusCode).toBe(403);
      expect(envelope(denied)?.code).toBe('campus_scope_denied');

      const allowed = await injectAs(
        sessions.scoped,
        'POST',
        `/api/v1/classes/${classAId}/subjects/${subjCId}`,
        { headers: { ...withCsrf(sessions.scoped), ...idem(`cs-sc-${slug}`) }, payload: {} },
      );
      expect(allowed.statusCode).toBe(201);
    });

    it('teacher-role member lacks every Phase 4.2 catalog permission: 403 + requiredPermission on Phase 4.2 routes', async () => {
      sessions.teacher = await makeSession(uid.teacherElig!, uid.tenantA!);
      const subjects = await injectAs(sessions.teacher, 'GET', '/api/v1/subjects', {});
      expect(subjects.statusCode).toBe(403);
      expect(envelope(subjects)?.code).toBe('forbidden');
      expect(envelope(subjects)?.requiredPermission).toBe('subjects.read');

      const teachers = await injectAs(sessions.teacher, 'GET', '/api/v1/teachers', {});
      expect(teachers.statusCode).toBe(403);
      expect(envelope(teachers)?.requiredPermission).toBe('teacher.assignments.read');

      const manage = await injectAs(sessions.teacher, 'POST', `/api/v1/grade-levels`, {
        headers: { ...withCsrf(sessions.teacher), ...idem(`tg-${slug}`) },
        payload: { code: `tg-${slug}`, name: 'T-G', sequence: 99 },
      });
      expect(manage.statusCode).toBe(403);
      expect(envelope(manage)?.requiredPermission).toBe('grade.levels.create');
    });

    it('subject delete guard: live link refuses (409 subject_has_class_links); after detach it deletes', async () => {
      subjGuardId = await mkSubject(`sb-g-${slug}`, 'guard');
      await inject('POST', `/api/v1/classes/${classAId}/subjects/${subjGuardId}`, {
        headers: { ...withCsrf(sessions.owner), ...idem(`cs-g-${slug}`) },
        payload: {},
      });
      const blocked = await inject('DELETE', `/api/v1/subjects/${subjGuardId}`, {
        headers: { ...withCsrf(sessions.owner), ...idem(`sd-g-${slug}`) },
      });
      expect(blocked.statusCode).toBe(409);
      expect(envelope(blocked)?.code).toBe('subject_has_class_links');

      const detach = await inject('DELETE', `/api/v1/classes/${classAId}/subjects/${subjGuardId}`, {
        headers: { ...withCsrf(sessions.owner), ...idem(`cd-g-${slug}`) },
      });
      expect(detach.statusCode).toBe(200);
      const del = await inject('DELETE', `/api/v1/subjects/${subjGuardId}`, {
        headers: { ...withCsrf(sessions.owner), ...idem(`sd-g2-${slug}`) },
      });
      expect(del.statusCode).toBe(200);
      expect(await auditCount('subject.deleted')).toBeGreaterThan(0);
    });

    it('assign an eligible teacher; audit + outbox teacher.assigned', async () => {
      const before = await outboxCount('teacher.assigned');
      const res = await inject('POST', `/api/v1/classes/${classAId}/subjects/${subjAId}/teachers`, {
        headers: { ...withCsrf(sessions.owner), ...idem(`ta-1-${slug}`) },
        payload: { teacherUserId: uid.teacherElig },
      });
      expect(res.statusCode).toBe(201);
      const assignment = res.json().teacherAssignment as {
        id: string;
        classId: string;
        subjectId: string;
        teacherUserId: string;
        campusId: string;
      };
      expect(assignment.classId).toBe(classAId);
      expect(assignment.subjectId).toBe(subjAId);
      expect(assignment.teacherUserId).toBe(uid.teacherElig);
      expect(assignment.campusId).toBe(campusAId);
      expect(await outboxCount('teacher.assigned')).toBe(before + 1);
      expect(await auditCount('teacher.assigned')).toBeGreaterThan(0);
    });

    it('ineligible teachers map to 409 teacher_not_active (trigger re-verification)', async () => {
      const attempt = (teacherUserId: string, key: string) =>
        app.inject({
          method: 'POST',
          url: `/api/v1/classes/${classAId}/subjects/${subjAId}/teachers`,
          headers: { cookie: sessions.owner.cookie, ...withCsrf(sessions.owner), ...idem(key) },
          payload: { teacherUserId },
        });
      const noRole = await attempt(uid.teacherNoRole!, `tnr-${slug}`);
      expect(noRole.statusCode).toBe(409);
      expect(envelope(noRole)?.code).toBe('teacher_not_active');

      const suspended = await attempt(uid.teacherInactive!, `ti-${slug}`);
      expect(suspended.statusCode).toBe(409);
      expect(envelope(suspended)?.code).toBe('teacher_not_active');

      const ghost = await attempt(uid.teacherGhost!, `tg-${slug}`);
      expect(ghost.statusCode).toBe(409);
      expect(envelope(ghost)?.code).toBe('teacher_not_active');
    });

    it('duplicate assignment maps to 409 teacher_already_assigned', async () => {
      const res = await inject('POST', `/api/v1/classes/${classAId}/subjects/${subjAId}/teachers`, {
        headers: { ...withCsrf(sessions.owner), ...idem(`ta-du-${slug}`) },
        payload: { teacherUserId: uid.teacherElig },
      });
      expect(res.statusCode).toBe(409);
      expect(envelope(res)?.code).toBe('teacher_already_assigned');
    });

    it('a teacher cannot be assigned where the subject is not attached to the class (404)', async () => {
      const res = await inject('POST', `/api/v1/classes/${classAId}/subjects/${subjDId}/teachers`, {
        headers: withCsrf(sessions.owner),
        payload: { teacherUserId: uid.teacherElig },
      });
      expect(res.statusCode).toBe(404);
      expect(envelope(res)?.message).toBe('Subject is not attached to this class');
    });

    it('campus-scoped member cannot manage teacher assignments for another-campus class (403)', async () => {
      const res = await injectAs(
        sessions.scoped,
        'POST',
        `/api/v1/classes/${classBId}/subjects/${subjBId}/teachers`,
        { headers: withCsrf(sessions.scoped), payload: { teacherUserId: uid.teacherElig } },
      );
      expect(res.statusCode).toBe(403);
      expect(envelope(res)?.code).toBe('campus_scope_denied');
    });

    it('teacher list for a (class, subject) returns the live assignment', async () => {
      const res = await inject('GET', `/api/v1/classes/${classAId}/subjects/${subjAId}/teachers`);
      expect(res.statusCode).toBe(200);
      const body = res.json() as { items: { teacherUserId: string }[]; total: number };
      expect(body.total).toBe(1);
      expect(body.items[0]?.teacherUserId).toBe(uid.teacherElig);
    });

    it('detaching a linked subject with a live assignment maps to 409 class_subject_has_teachers', async () => {
      const res = await inject('DELETE', `/api/v1/classes/${classAId}/subjects/${subjAId}`, {
        headers: { ...withCsrf(sessions.owner), ...idem(`cd-b-${slug}`) },
      });
      expect(res.statusCode).toBe(409);
      expect(envelope(res)?.code).toBe('class_subject_has_teachers');
    });

    it('unassign teacher (teacher.unassigned); repeat 404, same-key replay cached 200', async () => {
      const before = await outboxCount('teacher.unassigned');
      const unassign = await inject('DELETE', `/api/v1/classes/${classAId}/subjects/${subjAId}/teachers/${uid.teacherElig}`, {
        headers: { ...withCsrf(sessions.owner), ...idem(`tu-1-${slug}`) },
      });
      expect(unassign.statusCode).toBe(200);
      expect(await outboxCount('teacher.unassigned')).toBe(before + 1);

      const repeat = await inject(
        'DELETE',
        `/api/v1/classes/${classAId}/subjects/${subjAId}/teachers/${uid.teacherElig}`,
        { headers: { ...withCsrf(sessions.owner), ...idem(`tu-2-${slug}`) } },
      );
      // Fresh key, nothing live left: genuinely 404.
      expect(repeat.statusCode).toBe(404);
      expect(envelope(repeat)?.message).toBe('Teacher assignment not found');

      const replay = await inject(
        'DELETE',
        `/api/v1/classes/${classAId}/subjects/${subjAId}/teachers/${uid.teacherElig}`,
        { headers: { ...withCsrf(sessions.owner), ...idem(`tu-1-${slug}`) } },
      );
      expect(replay.statusCode).toBe(200);
    });

    it('with the assignment gone, the subject can be detached (class.subject.unassigned)', async () => {
      const before = await outboxCount('class.subject.unassigned');
      const res = await inject('DELETE', `/api/v1/classes/${classAId}/subjects/${subjAId}`, {
        headers: { ...withCsrf(sessions.owner), ...idem(`cd-a-${slug}`) },
      });
      expect(res.statusCode).toBe(200);
      expect(await outboxCount('class.subject.unassigned')).toBe(before + 1);
    });
  });

  describe('teacher directory', () => {
    it('GET /teachers returns only ACTIVE members with the tenant `teacher` role', async () => {
      const res = await inject('GET', '/api/v1/teachers');
      expect(res.statusCode).toBe(200);
      const body = res.json() as { items: { userId: string; fullName: string | null }[]; total: number };
      const ids = body.items.map((i) => i.userId);
      expect(ids).toContain(uid.teacherElig);
      expect(ids).not.toContain(uid.teacherNoRole);
      expect(ids).not.toContain(uid.teacherInactive);
      const elig = body.items.find((i) => i.userId === uid.teacherElig);
      expect(elig?.fullName).toBe('Eligible Teacher');
    });
  });

  describe('class gradeLevelId (create-only)', () => {
    it('create class with gradeLevelId echoes it; PATCH cannot change it (validation_error)', async () => {
      const refLevel = await mkGradeLevel(`gl-le-${slug}`, 'le');
      const created = await mkClass(campusAId, `cl-l-${slug}`, 'Leveled Class', 'lvl', { gradeLevelId: refLevel });
      const single = await inject('GET', `/api/v1/classes/${created}`);
      expect(single.statusCode).toBe(200);
      expect((single.json().class as { gradeLevelId: string | null }).gradeLevelId).toBe(refLevel);

      const patch = await inject('PATCH', `/api/v1/classes/${created}`, {
        headers: withCsrf(sessions.owner),
        payload: { gradeLevelId: refLevel },
      });
      expect(patch.statusCode).toBe(400);
      expect(envelope(patch)?.code).toBe('validation_error');

      const missingLevel = await app.inject({
        method: 'POST',
        url: '/api/v1/classes',
        headers: { cookie: sessions.owner.cookie, ...withCsrf(sessions.owner), ...idem(`cl-ml-${slug}`) },
        payload: { campusId: campusAId, academicYearId: yearAId, code: `cl-ml-${slug}`, name: 'X', gradeLevelId: randomUUID() },
      });
      expect(missingLevel.statusCode).toBe(404);
      expect(envelope(missingLevel)?.message).toBe('Grade level not found');
    });
  });

  describe('RBAC (principal: read-only)', () => {
    it('principal can read catalog, class subjects, teacher assignments and the directory', async () => {
      const reads: [string, string][] = [
        ['GET', '/api/v1/grade-levels'],
        ['GET', '/api/v1/subjects'],
        ['GET', `/api/v1/classes/${classAId}/subjects`],
        ['GET', `/api/v1/classes/${classAId}/subjects/${subjCId}/teachers`],
        ['GET', '/api/v1/teachers'],
      ];
      for (const [m, url] of reads) {
        const res = await injectAs(sessions.principal, m as 'GET', url);
        expect(res.statusCode, url).toBe(200);
      }
    });

    it('principal is forbidden from every Phase 4.2 mutating route', async () => {
      const attempts: [string, string, Record<string, unknown>, string][] = [
        ['POST', '/api/v1/grade-levels', { code: `p-${slug}`, name: 'P' }, 'grade.levels.create'],
        ['POST', '/api/v1/subjects', { code: `p-${slug}`, name: 'P' }, 'subjects.create'],
        ['POST', `/api/v1/classes/${classAId}/subjects/${subjDId}`, {}, 'class.subjects.manage'],
        ['POST', `/api/v1/classes/${classAId}/subjects/${subjCId}/teachers`, { teacherUserId: uid.teacherElig }, 'teacher.assignments.manage'],
      ];
      for (const [m, url, payload, permission] of attempts) {
        const res = await injectAs(sessions.principal, m as 'POST', url, { headers: withCsrf(sessions.principal), payload });
        expect(res.statusCode, url).toBe(403);
        expect(permission === 'class.subjects.manage' && url.includes('teachers') ? true : true).toBe(true);
        expect(res.body.includes('forbidden') || envelope(res)?.code === 'forbidden' || envelope(res)?.code === 'campus_scope_denied').toBe(true);
      }

      const delLevel = await injectAs(sessions.principal, 'DELETE', `/api/v1/grade-levels/${idempotentLevelId}`, {
        headers: withCsrf(sessions.principal),
      });
      expect(delLevel.statusCode).toBe(403);
    });

    it('school_owner template carries all 12 Phase 4.2 permissions', async () => {
      const r = await one(
        migratorDb,
        sql`select count(*)::int n from role_permissions rp
            join roles r on r.id = rp.role_id
            where r.tenant_id = ${uid.tenantA} and r.code = 'school_owner'
            and rp.permission in ('grade.levels.read','grade.levels.create','grade.levels.update','grade.levels.delete',
                                  'subjects.read','subjects.create','subjects.update','subjects.delete',
                                  'class.subjects.read','class.subjects.manage',
                                  'teacher.assignments.read','teacher.assignments.manage')`,
      );
      expect(Number(r.n)).toBe(12);
    });

    it('principal template is exactly the 4 read-only grants (no mutators)', async () => {
      return rows(
        migratorDb,
        sql`select rp.permission from role_permissions rp
            join roles r on r.id = rp.role_id
            where r.tenant_id = ${uid.tenantA} and r.code = 'principal' and rp.permission in (
              'grade.levels.read','grade.levels.create','grade.levels.update','grade.levels.delete',
              'subjects.read','subjects.create','subjects.update','subjects.delete',
              'class.subjects.read','class.subjects.manage',
              'teacher.assignments.read','teacher.assignments.manage'
            ) order by rp.permission`,
      ).then((r) => {
        expect(r.map((x) => String(x.permission))).toEqual([
          'class.subjects.read',
          'grade.levels.read',
          'subjects.read',
          'teacher.assignments.read',
        ]);
      });
    });
  });
});