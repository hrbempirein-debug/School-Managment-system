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
 * Phase 4.1 API acceptance: classes, sections & student academic placement
 * against the real app + real PostgreSQL + live Redis. Proves the full loop the
 * DB tests cannot — permission-seeded templates (school_owner/principal from
 * createTenantTransaction), campus-scope guard on writes, idempotency, audit +
 * outbox wiring, canonical 409 mappings of the placement integrity triggers,
 * and read-only principal RBAC.
 *
 * Opt-in: RUN_RUNTIME_SECURITY_TESTS=1.
 */
const enabled = process.env.RUN_RUNTIME_SECURITY_TESTS === '1';
const describeDb = enabled ? describe : describe.skip;

const stubStorage = {
  async readObject(): Promise<Buffer> {
    throw new Error('not consulted in Phase 4.1 acceptance');
  },
} as unknown as StorageProvider;

interface SessionCookies {
  token: string;
  csrf: string;
  cookie: string;
}

describeDb('API Phase 4.1 classes/sections/placement acceptance (real app + DB + Redis)', () => {
  let migratorDb: Db;
  let appDb: Db;
  let redis: Redis;
  let endMigrator: () => Promise<void>;
  let endApp: () => Promise<void>;
  let endRedis: () => Promise<unknown>;
  let app: Awaited<ReturnType<typeof buildApp>>;

  const uid: Record<string, string> = {};
  const slug = `p41${randomUUID().slice(0, 8)}`;
  const sessions: Record<'owner' | 'principal' | 'campus', SessionCookies> = {} as never;

  let campusAId = '';
  let campusBId = '';
  let yearAId = '';
  let classAId = '';
  let classBId = '';
  let classInactiveId = '';
  let classEmptyId = '';
  let sectionAId = '';
  let sectionBId = '';
  let sectionOfClassBId = '';
  let enrollAId = '';
  let enrollA2Id = '';
  let enrollInactiveId = '';

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

  const cls = (d: Record<string, unknown>) => ({
    code: `gr-9-${slug}`,
    name: 'Grade Nine',
    ...d,
  });

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
    uid.campusUser = randomUUID();
    uid.platform = randomUUID();
    uid.platRole = randomUUID();
    uid.ownerEmail = `owner-${slug}@example.com`;
    uid.principalEmail = `principal-${slug}@example.com`;
    uid.campusEmail = `campus-${slug}@example.com`;

    await rows(
      migratorDb,
      sql`insert into roles (id, scope, code, name, is_system) values (${uid.platRole}, 'platform', ${`p41${slug}_plat`}, 'P4 Platform Admin', true)`,
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
    await rows(migratorDb, sql`insert into users (id, email) values (${uid.campusUser}, ${uid.campusEmail})`);

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
        name: 'P4 A',
        requestId: randomUUID(),
      }),
    );
    uid.tenantA = createdA.tenantId;

    const schoolOwner = await one(
      migratorDb,
      sql`select id from roles where tenant_id = ${uid.tenantA} and code = 'school_owner'`,
    );
    const schoolOwnerId = String(schoolOwner.id);
    // Principal membership (read-only template) in tenant A.
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
    // Campus-scoped member: school_owner template + membership pinned to campusA.
    uid.campusMembership = randomUUID();
    await rows(
      migratorDb,
      sql`insert into memberships (id, tenant_id, user_id, status) values (${uid.campusMembership}, ${uid.tenantA}, ${uid.campusUser}, 'active')`,
    );
    await rows(
      migratorDb,
      sql`insert into membership_roles (membership_id, role_id) values (${uid.campusMembership}, ${schoolOwnerId})`,
    );

    sessions.owner = await makeSession(uid.owner!, uid.tenantA!);
    sessions.principal = await makeSession(uid.principal!, uid.tenantA!);
    sessions.campus = await makeSession(uid.campusUser!, uid.tenantA!);

    app = await buildApp({ deps: { db: appDb, redis, storage: stubStorage }, logger: false });

    // --- domain scaffolding via the API where the surface is Phase 4.1, direct
    // --- DB inserts where the volume is Phase 3 or earlier (students/enrollments).
    const mkCampus = async (code: string, name: string) => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/campuses',
        headers: { cookie: sessions.owner.cookie, ...withCsrf(sessions.owner), ...idem(`cp-${code}-${slug}`) },
        payload: { code, name },
      });
      expect(res.statusCode, `campus ${code}`).toBe(201);
      return (res.json().campus as { id: string }).id;
    };
    campusAId = await mkCampus(`ca-${slug}`, 'Campus Alpha');
    campusBId = await mkCampus(`cb-${slug}`, 'Campus Beta');

    const mkYear = await app.inject({
      method: 'POST',
      url: '/api/v1/academic-years',
      headers: { cookie: sessions.owner.cookie, ...withCsrf(sessions.owner), ...idem(`yr-${slug}`) },
      payload: { code: `ay-${slug}`, name: 'AY 2026', startsOn: '2026-01-01', endsOn: '2026-12-31' },
    });
    expect(mkYear.statusCode).toBe(201);
    yearAId = (mkYear.json().academicYear as { id: string }).id;

    uid.studentA = randomUUID();
    uid.studentA2 = randomUUID();
    uid.studentInactive = randomUUID();
    await rows(
      migratorDb,
      sql`insert into students (id, tenant_id, student_no, first_name, last_name, primary_campus_id, status) values
        (${uid.studentA}, ${uid.tenantA}, ${`p41s-${slug}`}, 'Alice', 'A', ${campusAId}, 'active'),
        (${uid.studentA2}, ${uid.tenantA}, ${`p41s2-${slug}`}, 'Abel', 'A2', ${campusAId}, 'active'),
        (${uid.studentInactive}, ${uid.tenantA}, ${`p41x-${slug}`}, 'Axl', 'X', ${campusAId}, 'applicant')`,
    );
    uid.enrollA = randomUUID();
    uid.enrollA2 = randomUUID();
    uid.enrollInactive = randomUUID();
    await rows(
      migratorDb,
      sql`insert into enrollments (id, tenant_id, student_id, academic_year_id, status) values
        (${uid.enrollA}, ${uid.tenantA}, ${uid.studentA}, ${yearAId}, 'active'),
        (${uid.enrollA2}, ${uid.tenantA}, ${uid.studentA2}, ${yearAId}, 'active'),
        (${uid.enrollInactive}, ${uid.tenantA}, ${uid.studentInactive}, ${yearAId}, 'active')`,
    );
    enrollAId = uid.enrollA!;
    enrollA2Id = uid.enrollA2!;
    enrollInactiveId = uid.enrollInactive!;

    // A class per campus so later modules can demo cross-campus rejection.
    const classMake = async (campusId: string, code: string, name: string, key: string) => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/classes',
        headers: { cookie: sessions.owner.cookie, ...withCsrf(sessions.owner), ...idem(`cl-${key}-${slug}`) },
        payload: { campusId, academicYearId: yearAId, code, name },
      });
      expect(res.statusCode, `class ${code}`).toBe(201);
      return (res.json().class as { id: string }).id;
    };
    classAId = await classMake(campusAId, `g9-${slug}`, 'Grade Nine', 'a');
    classBId = await classMake(campusBId, `g8-${slug}`, 'Grade Eight', 'b');
    classInactiveId = await classMake(campusAId, `gi-${slug}`, 'Inactive Class', 'i');
    classEmptyId = await classMake(campusAId, `ge-${slug}`, 'Empty Class', 'e');

    const mkSection = async (classId: string, code: string, key: string) => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/classes/${classId}/sections`,
        headers: { cookie: sessions.owner.cookie, ...withCsrf(sessions.owner), ...idem(`sc-${key}-${slug}`) },
        payload: { code },
      });
      expect(res.statusCode, `section ${code}`).toBe(201);
      return (res.json().section as { id: string }).id;
    };
    sectionAId = await mkSection(classAId, `A-${slug}`, 'a');
    sectionBId = await mkSection(classAId, `B-${slug}`, 'b');
    sectionOfClassBId = await mkSection(classBId, `A-${slug}`, 'cb');

    // Pinned campus/scope proof: a campus-scoped member cannot create classes on
    // the other campus.
    await rows(
      migratorDb,
      sql`update memberships set campus_id = ${campusAId} where id = ${uid.campusMembership}`,
    );
  });

  afterAll(async () => {
    try {
      if (app) await app.close();
      const tIn = `'${uid.tenantA}'`;
      await rows(migratorDb, sql`delete from outbox_events where tenant_id in (${sql.raw(tIn)})`);
      await rows(migratorDb, sql`delete from idempotency_keys where tenant_id in (${sql.raw(tIn)})`);
      await rows(migratorDb, sql`delete from enrollments where tenant_id in (${sql.raw(tIn)})`);
      await rows(migratorDb, sql`delete from sections where tenant_id in (${sql.raw(tIn)})`);
      await rows(migratorDb, sql`delete from acd_classes where tenant_id in (${sql.raw(tIn)})`);
      await rows(migratorDb, sql`delete from students where tenant_id in (${sql.raw(tIn)})`);
      await rows(migratorDb, sql`delete from academic_years where tenant_id in (${sql.raw(tIn)})`);
      await rows(migratorDb, sql`delete from campuses where tenant_id in (${sql.raw(tIn)})`);
      await rows(
        migratorDb,
        sql`delete from membership_roles where membership_id in (select id from memberships where tenant_id in (${sql.raw(tIn)}) or user_id in (${uid.principal}, ${uid.campusUser}))`,
      );
      await rows(
        migratorDb,
        sql`delete from role_permissions where role_id in (select id from roles where tenant_id in (${sql.raw(tIn)}) or id = ${uid.platRole})`,
      );
      await rows(
        migratorDb,
        sql`delete from memberships where tenant_id in (${sql.raw(tIn)}) or user_id in (${uid.principal}, ${uid.campusUser})`,
      );
      await rows(migratorDb, sql`delete from platform_role_assignments where user_id = ${uid.owner}`);
      await rows(
        migratorDb,
        sql`delete from roles where tenant_id in (${sql.raw(tIn)}) or id = ${uid.platRole}`,
      );
      await rows(
        migratorDb,
        sql`delete from users where id in (${uid.owner}, ${uid.principal}, ${uid.campusUser})`,
      );
      await rows(migratorDb, sql`delete from tenants where id in (${sql.raw(tIn)})`);
    } finally {
      await endMigrator();
      await endApp();
      await endRedis?.();
    }
  });

  describe('classes', () => {
    it('creator (school_owner) can create a class; parents are validated', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/classes',
        headers: { cookie: sessions.owner.cookie, ...withCsrf(sessions.owner), ...idem(`nw-${slug}`) },
        payload: { campusId: campusAId, academicYearId: yearAId, code: `nw-${slug}`, name: 'New' },
      });
      expect(res.statusCode).toBe(201);
      const klass = res.json().class as { campusId: string; academicYearId: string; status: string };
      expect(klass.campusId).toBe(campusAId);
      expect(klass.academicYearId).toBe(yearAId);
      expect(klass.status).toBe('active');

      const missingCampus = await app.inject({
        method: 'POST',
        url: '/api/v1/classes',
        headers: { cookie: sessions.owner.cookie, ...withCsrf(sessions.owner), ...idem(`nc-${slug}`) },
        payload: { campusId: randomUUID(), academicYearId: yearAId, code: `mn-${slug}`, name: 'Missing' },
      });
      expect(missingCampus.statusCode).toBe(404);
      expect(envelope(missingCampus)?.code).toBe('not_found');
      expect(envelope(missingCampus)?.message).toBe('Campus not found');

      // The creator's first class row is audited + outboxed.
      expect(await auditCount('class.created')).toBeGreaterThan(0);
    });

    it('duplicate class code within (campus, year) maps to 409 class_code_taken', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/classes',
        headers: { cookie: sessions.owner.cookie, ...withCsrf(sessions.owner), ...idem(`dup-${slug}`) },
        payload: { campusId: campusAId, academicYearId: yearAId, code: `g9-${slug}`, name: 'Dup' },
      });
      expect(res.statusCode).toBe(409);
      expect(envelope(res)?.code).toBe('class_code_taken');
    });

    it('GET list + filters + single; PATCH renames but rejects immutables', async () => {
      const list = await app.inject({
        method: 'GET',
        url: `/api/v1/classes?campusId=${campusAId}&academicYearId=${yearAId}&status=active`,
        headers: { cookie: sessions.owner.cookie },
      });
      expect(list.statusCode).toBe(200);
      const items = (list.json() as { items: { code: string }[]; total: number }).items;
      expect(items.some((i) => i.code === `g9-${slug}`)).toBe(true);

      const single = await app.inject({
        method: 'GET',
        url: `/api/v1/classes/${classAId}`,
        headers: { cookie: sessions.owner.cookie },
      });
      expect(single.statusCode).toBe(200);

      const renamed = await app.inject({
        method: 'PATCH',
        url: `/api/v1/classes/${classAId}`,
        headers: { cookie: sessions.owner.cookie, ...withCsrf(sessions.owner) },
        payload: { name: 'Grade Nine Renamed' },
      });
      expect(renamed.statusCode).toBe(200);
      expect((renamed.json().class as { name: string }).name).toBe('Grade Nine Renamed');

      const relocating = await app.inject({
        method: 'PATCH',
        url: `/api/v1/classes/${classAId}`,
        headers: { cookie: sessions.owner.cookie, ...withCsrf(sessions.owner) },
        payload: { campusId: campusBId },
      });
      expect(relocating.statusCode).toBe(400);
      expect(envelope(relocating)?.code).toBe('validation_error');

      const ghost = await app.inject({
        method: 'GET',
        url: `/api/v1/classes/${randomUUID()}`,
        headers: { cookie: sessions.owner.cookie },
      });
      expect(ghost.statusCode).toBe(404);
    });

    it('activate/deactivate lifecycle routes work', async () => {
      const deact = await app.inject({
        method: 'POST',
        url: `/api/v1/classes/${classInactiveId}/deactivate`,
        headers: { cookie: sessions.owner.cookie, ...withCsrf(sessions.owner) },
      });
      expect(deact.statusCode).toBe(200);
      expect((deact.json().class as { status: string }).status).toBe('inactive');

      const act = await app.inject({
        method: 'POST',
        url: `/api/v1/classes/${classInactiveId}/activate`,
        headers: { cookie: sessions.owner.cookie, ...withCsrf(sessions.owner) },
      });
      expect(act.statusCode).toBe(200);
      expect((act.json().class as { status: string }).status).toBe('active');
      expect(await auditCount('class.deactivated')).toBeGreaterThan(0);
    });

    it('DELETE: empty class succeeds; class with live sections maps to 409 class_has_sections', async () => {
      const empty = await app.inject({
        method: 'DELETE',
        url: `/api/v1/classes/${classEmptyId}`,
        headers: { cookie: sessions.owner.cookie, ...withCsrf(sessions.owner), ...idem(`de-${slug}`) },
      });
      expect(empty.statusCode).toBe(200);

      const blocked = await app.inject({
        method: 'DELETE',
        url: `/api/v1/classes/${classAId}`,
        headers: { cookie: sessions.owner.cookie, ...withCsrf(sessions.owner), ...idem(`db-${slug}`) },
      });
      expect(blocked.statusCode).toBe(409);
      expect(envelope(blocked)?.code).toBe('class_has_sections');
    });

    it('campus-scoped members are denied creating classes on the other campus (403)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/classes',
        headers: { cookie: sessions.campus.cookie, ...withCsrf(sessions.campus), ...idem(`cs-${slug}`) },
        payload: { campusId: campusBId, academicYearId: yearAId, code: `cs-${slug}`, name: 'Scoped' },
      });
      expect(res.statusCode).toBe(403);
      expect(envelope(res)?.code).toBe('campus_scope_denied');

      const own = await app.inject({
        method: 'POST',
        url: '/api/v1/classes',
        headers: { cookie: sessions.campus.cookie, ...withCsrf(sessions.campus), ...idem(`co-${slug}`) },
        payload: { campusId: campusAId, academicYearId: yearAId, code: `co-${slug}`, name: 'Scoped Own' },
      });
      expect(own.statusCode).toBe(201);
    });
  });

  describe('sections', () => {
    it('creator can create a section; campus/year are pinned from the class', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/classes/${classAId}/sections`,
        headers: { cookie: sessions.owner.cookie, ...withCsrf(sessions.owner), ...idem(`sa-${slug}`) },
        payload: { code: `C-${slug}` },
      });
      expect(res.statusCode).toBe(201);
      const section = res.json().section as { campusId: string; academicYearId: string; classId: string };
      expect(section.campusId).toBe(campusAId);
      expect(section.academicYearId).toBe(yearAId);
      expect(section.classId).toBe(classAId);
    });

    it('duplicate section code in a class maps to 409 section_code_taken', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/classes/${classAId}/sections`,
        headers: { cookie: sessions.owner.cookie, ...withCsrf(sessions.owner), ...idem(`sd-${slug}`) },
        payload: { code: `A-${slug}` },
      });
      expect(res.statusCode).toBe(409);
      expect(envelope(res)?.code).toBe('section_code_taken');
    });

    it('GET list/single; PATCH; activate/deactivate; section under missing class 404s', async () => {
      const list = await app.inject({
        method: 'GET',
        url: `/api/v1/classes/${classAId}/sections`,
        headers: { cookie: sessions.owner.cookie },
      });
      expect(list.statusCode).toBe(200);
      expect((list.json() as { total: number }).total).toBeGreaterThanOrEqual(2);

      const single = await app.inject({
        method: 'GET',
        url: `/api/v1/classes/${classAId}/sections/${sectionBId}`,
        headers: { cookie: sessions.owner.cookie },
      });
      expect(single.statusCode).toBe(200);

      const renamed = await app.inject({
        method: 'PATCH',
        url: `/api/v1/classes/${classAId}/sections/${sectionBId}`,
        headers: { cookie: sessions.owner.cookie, ...withCsrf(sessions.owner) },
        payload: { code: `B2-${slug}` },
      });
      expect(renamed.statusCode).toBe(200);

      const deact = await app.inject({
        method: 'POST',
        url: `/api/v1/classes/${classAId}/sections/${sectionBId}/deactivate`,
        headers: { cookie: sessions.owner.cookie, ...withCsrf(sessions.owner) },
      });
      expect(deact.statusCode).toBe(200);
      expect((deact.json().section as { status: string }).status).toBe('inactive');
      const act = await app.inject({
        method: 'POST',
        url: `/api/v1/classes/${classAId}/sections/${sectionBId}/activate`,
        headers: { cookie: sessions.owner.cookie, ...withCsrf(sessions.owner) },
      });
      expect(act.statusCode).toBe(200);
      expect((act.json().section as { status: string }).status).toBe('active');

      const missing = await app.inject({
        method: 'POST',
        url: `/api/v1/classes/${randomUUID()}/sections`,
        headers: { cookie: sessions.owner.cookie, ...withCsrf(sessions.owner), ...idem(`sm-${slug}`) },
        payload: { code: `X-${slug}` },
      });
      expect(missing.statusCode).toBe(404);
    });

    it('DELETE of an unpopulated section succeeds', async () => {
      const temp = await app.inject({
        method: 'POST',
        url: `/api/v1/classes/${classAId}/sections`,
        headers: { cookie: sessions.owner.cookie, ...withCsrf(sessions.owner), ...idem(`st-${slug}`) },
        payload: { code: `T-${slug}` },
      });
      expect(temp.statusCode).toBe(201);
      const tempId = (temp.json().section as { id: string }).id;
      const gone = await app.inject({
        method: 'DELETE',
        url: `/api/v1/classes/${classAId}/sections/${tempId}`,
        headers: { cookie: sessions.owner.cookie, ...withCsrf(sessions.owner), ...idem(`sd-${slug}`) },
      });
      expect(gone.statusCode).toBe(200);
      expect(await auditCount('section.deleted')).toBeGreaterThan(0);
    });
  });

  describe('placement', () => {
    it('GET returns unplaced nulls', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/enrollments/${enrollAId}/placement`,
        headers: { cookie: sessions.owner.cookie },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().placement).toMatchObject({
        enrollmentId: enrollAId,
        classId: null,
        sectionId: null,
        rollNo: null,
      });
    });

    it('POST assigns a placement (event placement.assigned) and rollNo survives', async () => {
      const before = await outboxCount('placement.assigned');
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/enrollments/${enrollAId}/placement`,
        headers: { cookie: sessions.owner.cookie, ...withCsrf(sessions.owner), ...idem(`pa-${slug}`) },
        payload: { classId: classAId, sectionId: sectionAId, rollNo: 'R-1' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().placement).toMatchObject({
        enrollmentId: enrollAId,
        classId: classAId,
        sectionId: sectionAId,
        rollNo: 'R-1',
      });
      expect(await outboxCount('placement.assigned')).toBe(before + 1);
    });

    it('POST moving to another section emits placement.moved', async () => {
      const before = await outboxCount('placement.moved');
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/enrollments/${enrollAId}/placement`,
        headers: { cookie: sessions.owner.cookie, ...withCsrf(sessions.owner), ...idem(`pm-${slug}`) },
        payload: { classId: classAId, sectionId: sectionBId, rollNo: 'R-2' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().placement).toMatchObject({ sectionId: sectionBId, rollNo: 'R-2' });
      expect(await outboxCount('placement.moved')).toBe(before + 1);
    });

    it('re-POSTing the identical placement is a no-op (no duplicate event)', async () => {
      const beforeMove = await outboxCount('placement.moved');
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/enrollments/${enrollAId}/placement`,
        headers: { cookie: sessions.owner.cookie, ...withCsrf(sessions.owner) },
        payload: { classId: classAId, sectionId: sectionBId, rollNo: 'R-2' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().placement).toMatchObject({ sectionId: sectionBId });
      expect(await outboxCount('placement.moved')).toBe(beforeMove);
    });

    it('placing into an inactive class maps to 409 class_inactive', async () => {
      await app.inject({
        method: 'POST',
        url: `/api/v1/classes/${classInactiveId}/deactivate`,
        headers: { cookie: sessions.owner.cookie, ...withCsrf(sessions.owner) },
      });
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/enrollments/${enrollA2Id}/placement`,
        headers: { cookie: sessions.owner.cookie, ...withCsrf(sessions.owner), ...idem(`ci-${slug}`) },
        payload: { classId: classInactiveId, sectionId: sectionAId },
      });
      expect(res.statusCode).toBe(409);
      expect(envelope(res)?.code).toBe('class_inactive');
    });

    it('a section from a different class maps to 409 section_class_mismatch', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/enrollments/${enrollA2Id}/placement`,
        headers: { cookie: sessions.owner.cookie, ...withCsrf(sessions.owner), ...idem(`scm-${slug}`) },
        payload: { classId: classAId, sectionId: sectionOfClassBId },
      });
      expect(res.statusCode).toBe(409);
      expect(envelope(res)?.code).toBe('section_class_mismatch');
    });

    it('a student placed on another campus than their own maps to 409 student_campus_mismatch', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/enrollments/${enrollA2Id}/placement`,
        headers: { cookie: sessions.owner.cookie, ...withCsrf(sessions.owner), ...idem(`cm-${slug}`) },
        payload: { classId: classBId, sectionId: sectionOfClassBId },
      });
      expect(res.statusCode).toBe(409);
      expect(envelope(res)?.code).toBe('student_campus_mismatch');
    });

    it('an inactive student maps to 409 student_not_active', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/enrollments/${enrollInactiveId}/placement`,
        headers: { cookie: sessions.owner.cookie, ...withCsrf(sessions.owner), ...idem(`sn-${slug}`) },
        payload: { classId: classAId, sectionId: sectionAId },
      });
      expect(res.statusCode).toBe(409);
      expect(envelope(res)?.code).toBe('student_not_active');
    });

    it('duplicate roll_no inside a section maps to 409 roll_no_taken', async () => {
      const placed = await app.inject({
        method: 'POST',
        url: `/api/v1/enrollments/${enrollA2Id}/placement`,
        headers: { cookie: sessions.owner.cookie, ...withCsrf(sessions.owner), ...idem(`r1-${slug}`) },
        payload: { classId: classAId, sectionId: sectionAId, rollNo: 'R-42' },
      });
      expect(placed.statusCode).toBe(200);

      // enrollA currently holds rollNo R-2 in sectionB. Point it back at sectionA
      // with the same rollNo as enrollA2.
      const dup = await app.inject({
        method: 'POST',
        url: `/api/v1/enrollments/${enrollAId}/placement`,
        headers: { cookie: sessions.owner.cookie, ...withCsrf(sessions.owner), ...idem(`r2-${slug}`) },
        payload: { classId: classAId, sectionId: sectionAId, rollNo: 'R-42' },
      });
      expect(dup.statusCode).toBe(409);
      expect(envelope(dup)?.code).toBe('roll_no_taken');
    });

    it('DELETE unassigns and is idempotent (single placement.unassigned)', async () => {
      const before = await outboxCount('placement.unassigned');
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/v1/enrollments/${enrollAId}/placement`,
        headers: { cookie: sessions.owner.cookie, ...withCsrf(sessions.owner), ...idem(`un-${slug}`) },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().placement).toMatchObject({ classId: null, sectionId: null, rollNo: null });
      expect(await outboxCount('placement.unassigned')).toBe(before + 1);

      const again = await app.inject({
        method: 'DELETE',
        url: `/api/v1/enrollments/${enrollAId}/placement`,
        headers: { cookie: sessions.owner.cookie, ...withCsrf(sessions.owner), ...idem(`un2-${slug}`) },
      });
      expect(again.statusCode).toBe(200);
      expect(await outboxCount('placement.unassigned')).toBe(before + 1);
    });

    it('a campus-scoped member managing another-campus placement is denied (404 surface)', async () => {
      // enrollA's student is on campusA; the campus member is pinned to campusB.
      await rows(
        migratorDb,
        sql`update memberships set campus_id = ${campusBId} where id = ${uid.campusMembership}`,
      );
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/enrollments/${enrollAId}/placement`,
        headers: { cookie: sessions.campus.cookie, ...withCsrf(sessions.campus), ...idem(`cp-${slug}`) },
        payload: { classId: classAId, sectionId: sectionAId },
      });
      expect(res.statusCode).toBe(404);
      expect(envelope(res)?.code).toBe('not_found');
    });
  });

  describe('RBAC (principal: read-only)', () => {
    it('principal can read classes and sections and placement', async () => {
      const classes = await app.inject({
        method: 'GET',
        url: '/api/v1/classes',
        headers: { cookie: sessions.principal.cookie },
      });
      expect(classes.statusCode).toBe(200);

      const sections = await app.inject({
        method: 'GET',
        url: `/api/v1/classes/${classAId}/sections`,
        headers: { cookie: sessions.principal.cookie },
      });
      expect(sections.statusCode).toBe(200);

      const placement = await app.inject({
        method: 'GET',
        url: `/api/v1/enrollments/${enrollAId}/placement`,
        headers: { cookie: sessions.principal.cookie },
      });
      expect(placement.statusCode).toBe(200);
    });

    it('principal is forbidden from creating classes, sections, placements', async () => {
      const mkClass = await app.inject({
        method: 'POST',
        url: '/api/v1/classes',
        headers: { cookie: sessions.principal.cookie, ...withCsrf(sessions.principal) },
        payload: { campusId: campusAId, academicYearId: yearAId, code: `p-${slug}`, name: 'Principal' },
      });
      expect(mkClass.statusCode).toBe(403);
      expect(envelope(mkClass)?.code).toBe('forbidden');
      expect(envelope(mkClass)?.requiredPermission ?? null).toBe('classes.create');

      const mkSection = await app.inject({
        method: 'POST',
        url: `/api/v1/classes/${classAId}/sections`,
        headers: { cookie: sessions.principal.cookie, ...withCsrf(sessions.principal) },
        payload: { code: `P-${slug}` },
      });
      expect(mkSection.statusCode).toBe(403);
      expect(envelope(mkSection)?.requiredPermission ?? null).toBe('sections.create');

      const place = await app.inject({
        method: 'POST',
        url: `/api/v1/enrollments/${enrollAId}/placement`,
        headers: { cookie: sessions.principal.cookie, ...withCsrf(sessions.principal) },
        payload: { classId: classAId, sectionId: sectionAId },
      });
      expect(place.statusCode).toBe(403);
      expect(envelope(place)?.requiredPermission ?? null).toBe('placement.manage');

      const delSection = await app.inject({
        method: 'DELETE',
        url: `/api/v1/classes/${classAId}/sections/${sectionAId}`,
        headers: { cookie: sessions.principal.cookie, ...withCsrf(sessions.principal) },
      });
      expect(delSection.statusCode).toBe(403);
    });

    it('principal school_owner templates expose the full Phase 4.1 set', () => {
      // Template-level provenance: the school_owner created above already
      // exercised classes.create + sections.create + placement.manage, so the
      // definitive assertion is the permission grant count seeded at tenant
      // creation from ROLE_TEMPLATES.
      return rows(
        migratorDb,
        sql`select count(*)::int n from role_permissions rp
            join roles r on r.id = rp.role_id
            where r.tenant_id = ${uid.tenantA} and r.code = 'school_owner'
            and rp.permission in ('classes.read','classes.create','classes.update','classes.delete',
                                  'sections.read','sections.create','sections.update','sections.delete',
                                  'placement.read','placement.manage')`,
      ).then((r) => {
        expect(Number(r[0]!.n)).toBe(10);
      });
    });

    it('principal template is read-only (3 grants, no mutators)', () => {
      return rows(
        migratorDb,
        sql`select rp.permission from role_permissions rp
            join roles r on r.id = rp.role_id
            where r.tenant_id = ${uid.tenantA} and r.code = 'principal'
            and rp.permission like '%.%' and rp.permission in (
              'classes.read','classes.create','classes.update','classes.delete',
              'sections.read','sections.create','sections.update','sections.delete',
              'placement.read','placement.manage'
            ) order by rp.permission`,
      ).then((r) => {
        expect(r.map((x) => String(x.permission))).toEqual([
          'classes.read',
          'placement.read',
          'sections.read',
        ]);
      });
    });
  });
});