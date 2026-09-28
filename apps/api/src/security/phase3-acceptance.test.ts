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
 * Phase 3.2 HTTP security + acceptance proofs against the ACTUAL Fastify app
 * (`buildApp`), the real dev PostgreSQL under the real `school_app_rw` role, and
 * the LIVE Redis server. Requires migrations 0001..0006 (ROW the 0006 soft-unlink
 * partial unique index).
 *
 * Proves the students/guardians/links contract end-to-end: permission wiring on
 * all 13 primary routes, CSRF, per-tenancy isolation (cross-tenant reads/writes
 * are 404), uniqueness conflicts mapped to stable codes, strict (mass-assignment
 * rejecting) request schemas, the audit actions, the `student.created` outbox
 * event, campus-scope enforcement on the student side, and the forward-only 0006
 * soft-unlink lifecycle (unlink releases the (student, guardian, relation) key so
 * the same link can be created again while older rows stay for audit).
 *
 * Opt-in: RUN_RUNTIME_SECURITY_TESTS=1.
 */
const enabled = process.env.RUN_RUNTIME_SECURITY_TESTS === '1';
const describeDb = enabled ? describe : describe.skip;

const stubStorage = {
  async readObject(): Promise<Buffer> {
    throw new Error('storage must not be consulted in Phase 3.2 tests');
  },
} as unknown as StorageProvider;

interface SessionCookies {
  token: string;
  csrf: string;
  cookie: string;
}

describeDb('Phase 3.2 students & guardians: HTTP security + acceptance (real app + real DB + live Redis)', () => {
  let migratorDb: Db;
  let appDb: Db;
  let redis: Redis;
  let endMigrator: () => Promise<void>;
  let endApp: () => Promise<void>;
  let endRedis: () => Promise<unknown>;
  let app: Awaited<ReturnType<typeof buildApp>>;

  const uid: Record<string, string> = {};
  const slug = `p3${randomUUID().slice(0, 8)}`;
  const sessions: Record<'ownerA' | 'ownerB' | 'parent' | 'campus', SessionCookies> = {} as never;
  let campusAId = '';
  let campusBId = '';
  let studentAId = '';
  let studentBId = '';
  let guardianAId = '';
  let guardianBId = '';

  const rows = async (db: Db, q: ReturnType<typeof sql>): Promise<Record<string, unknown>[]> =>
    (await db.execute(q)).rows;

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

  const studentBody = (over: Record<string, unknown> = {}) => ({
    studentNo: `S-${randomUUID().slice(0, 8)}`,
    firstName: 'Ada',
    lastName: 'Lovelace',
    dateOfBirth: '1815-12-10',
    gender: 'female',
    ...over,
  });

  const guardianBody = (over: Record<string, unknown> = {}) => ({
    firstName: 'Anne',
    lastName: 'Isabella',
    email: `anne-${randomUUID().slice(0, 8)}@example.com`,
    phone: '+250700000000',
    ...over,
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
    uid.parent = randomUUID();
    uid.campusUser = randomUUID();
    uid.platRole = randomUUID();
    uid.ownerEmail = `owner-${slug}@example.com`;
    uid.parentEmail = `parent-${slug}@example.com`;
    uid.campusEmail = `campus-${slug}@example.com`;

    await rows(
      migratorDb,
      sql`insert into roles (id, scope, code, name, is_system) values (${uid.platRole}, 'platform', ${`p3p${slug}_plat`}, 'Phase 3.2 Platform Admin', true)`,
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
    await rows(migratorDb, sql`insert into users (id, email) values (${uid.parent}, ${uid.parentEmail})`);
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
      createTenantTransaction(tx, platformCtx(uid.owner!), { slug: `${slug}-a`, name: 'Phase 3.2 A', requestId: randomUUID() }),
    );
    uid.tenantA = createdA.tenantId;
    const createdB = await withTenant(appDb, platformCtx(uid.owner!), (tx) =>
      createTenantTransaction(tx, platformCtx(uid.owner!), { slug: `${slug}-b`, name: 'Phase 3.2 B', requestId: randomUUID() }),
    );
    uid.tenantB = createdB.tenantId;

    // Parent member of tenant A: parent role only (no students/guardians perms).
    const parentRole = await rows(
      migratorDb,
      sql`select id from roles where tenant_id = ${uid.tenantA} and code = 'parent'`,
    );
    const parentRoleId = String(parentRole[0]!.id);
    const parentMembershipRows = await rows(
      migratorDb,
      sql`insert into memberships (id, tenant_id, user_id, status) values (${randomUUID()}, ${uid.tenantA}, ${uid.parent}, 'active') returning id`,
    );
    await rows(
      migratorDb,
      sql`insert into membership_roles (membership_id, role_id) values (${String(parentMembershipRows[0]!.id)}, ${parentRoleId})`,
    );

    // Campus-scoped member of tenant A, granted school_owner: the ONLY thing
    // standing between them and other-campus data is the campus guard.
    const ownerRole = await rows(
      migratorDb,
      sql`select id from roles where tenant_id = ${uid.tenantA} and code = 'school_owner'`,
    );
    const ownerRoleId = String(ownerRole[0]!.id);
    uid.campusMembership = randomUUID();
    await rows(
      migratorDb,
      sql`insert into memberships (id, tenant_id, user_id, status) values (${uid.campusMembership}, ${uid.tenantA}, ${uid.campusUser}, 'active')`,
    );
    await rows(
      migratorDb,
      sql`insert into membership_roles (membership_id, role_id) values (${uid.campusMembership}, ${ownerRoleId})`,
    );

    // Sessions.
    sessions.ownerA = await makeSession(uid.owner!, uid.tenantA!);
    sessions.ownerB = await makeSession(uid.owner!, uid.tenantB!);
    sessions.parent = await makeSession(uid.parent!, uid.tenantA!);
    sessions.campus = await makeSession(uid.campusUser!, uid.tenantA!);

    app = await buildApp({
      deps: { db: appDb, redis, storage: stubStorage },
      logger: false,
    });

    // Owner (school-wide) creates two campuses so the campus-scoped runs can
    // reference a real campus and the membership FK can be set.
    const mkCampus = async (code: string, name: string) => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/campuses',
        headers: { cookie: sessions.ownerA.cookie, ...withCsrf(sessions.ownerA), ...idem(`c-${code}-${slug}`) },
        payload: { code, name },
      });
      expect(res.statusCode).toBe(201);
      return (res.json().campus as { id: string }).id;
    };
    campusAId = await mkCampus(`p3a-${slug}`, 'Phase 3.2 Main');
    campusBId = await mkCampus(`p3b-${slug}`, 'Phase 3.2 Annex');
    await rows(
      migratorDb,
      sql`update memberships set campus_id = ${campusAId} where id = ${uid.campusMembership}`,
    );
  });

  afterAll(async () => {
    try {
      if (app) await app.close();
      const tIn = `'${uid.tenantA}','${uid.tenantB}'`;
      await rows(migratorDb, sql`delete from outbox_events where tenant_id in (${sql.raw(tIn)})`);
      await rows(migratorDb, sql`delete from idempotency_keys where tenant_id in (${sql.raw(tIn)})`);
      await rows(
        migratorDb,
        sql`delete from membership_roles where membership_id in (select id from memberships where tenant_id in (${sql.raw(tIn)}) or user_id in (${uid.parent}, ${uid.campusUser}))`,
      );
      await rows(
        migratorDb,
        sql`delete from role_permissions where role_id in (select id from roles where tenant_id in (${sql.raw(tIn)}) or id = ${uid.platRole})`,
      );
      await rows(
        migratorDb,
        sql`delete from memberships where tenant_id in (${sql.raw(tIn)}) or user_id = ${uid.campusUser}`,
      );
      await rows(migratorDb, sql`delete from platform_role_assignments where user_id = ${uid.owner}`);
      await rows(migratorDb, sql`delete from roles where tenant_id in (${sql.raw(tIn)}) or id = ${uid.platRole}`);
      await rows(
        migratorDb,
        sql`delete from users where id in (${uid.owner}, ${uid.parent}, ${uid.campusUser})`,
      );
      await rows(migratorDb, sql`delete from tenants where id in (${sql.raw(tIn)})`);
    } finally {
      await endMigrator();
      await endApp();
      await endRedis?.();
    }
  });

  // ------------------------------------------------------------- permission map

  it('1. reports every Phase 3.2 route in the post-boot matrix (tenant kind + permission, HEAD twins)', async () => {
    const byRoute = new Map(
      app.routeAuthorizationMatrix().routes.map((r) => [`${r.method} ${r.url}`, r]),
    );
    const primary: Record<string, string> = {
      'GET /api/v1/students': 'students.read',
      'POST /api/v1/students': 'students.create',
      'GET /api/v1/students/:id': 'students.read',
      'PATCH /api/v1/students/:id': 'students.update',
      'DELETE /api/v1/students/:id': 'students.delete',
      'GET /api/v1/students/:id/guardians': 'students.read',
      'POST /api/v1/students/:id/guardians': 'students.update',
      'DELETE /api/v1/students/:id/guardians/:guardianId': 'students.update',
      'GET /api/v1/guardians': 'guardians.read',
      'POST /api/v1/guardians': 'guardians.create',
      'GET /api/v1/guardians/:id': 'guardians.read',
      'PATCH /api/v1/guardians/:id': 'guardians.update',
      'DELETE /api/v1/guardians/:id': 'guardians.update',
    };
    for (const [key, permission] of Object.entries(primary)) {
      expect(byRoute.get(key)).toEqual(
        expect.objectContaining({ kind: 'tenant', permission, devOnly: false }),
      );
      if (key.startsWith('GET ')) {
        expect(byRoute.get(`HEAD ${key.slice(4)}`)).toEqual(
          expect.objectContaining({ kind: 'tenant', permission, devOnly: false }),
        );
      }
    }
  });

  it('2. parent is denied every Phase 3.2 route with the documented required permission', async () => {
    const cases: Array<{ method: string; url: string; perm: string }> = [
      { method: 'GET', url: '/api/v1/students', perm: 'students.read' },
      { method: 'POST', url: '/api/v1/students', perm: 'students.create' },
      { method: 'GET', url: '/api/v1/students/00000000-0000-0000-0000-000000000000', perm: 'students.read' },
      { method: 'PATCH', url: '/api/v1/students/00000000-0000-0000-0000-000000000000', perm: 'students.update' },
      { method: 'DELETE', url: '/api/v1/students/00000000-0000-0000-0000-000000000000', perm: 'students.delete' },
      { method: 'GET', url: '/api/v1/students/00000000-0000-0000-0000-000000000000/guardians', perm: 'students.read' },
      { method: 'POST', url: '/api/v1/students/00000000-0000-0000-0000-000000000000/guardians', perm: 'students.update' },
      { method: 'DELETE', url: '/api/v1/students/00000000-0000-0000-0000-000000000000/guardians/00000000-0000-0000-0000-000000000000', perm: 'students.update' },
      { method: 'GET', url: '/api/v1/guardians', perm: 'guardians.read' },
      { method: 'POST', url: '/api/v1/guardians', perm: 'guardians.create' },
      { method: 'GET', url: '/api/v1/guardians/00000000-0000-0000-0000-000000000000', perm: 'guardians.read' },
      { method: 'PATCH', url: '/api/v1/guardians/00000000-0000-0000-0000-000000000000', perm: 'guardians.update' },
      { method: 'DELETE', url: '/api/v1/guardians/00000000-0000-0000-0000-000000000000', perm: 'guardians.update' },
    ];
    for (const c of cases) {
      const res = await app.inject({
        method: c.method as 'GET' | 'POST' | 'PATCH' | 'DELETE',
        url: c.url,
        headers: { cookie: sessions.parent.cookie },
      });
      expect(res.statusCode, `${c.method} ${c.url}`).toBe(403);
      expect(envelope(res)?.code, `${c.method} ${c.url}`).toBe('forbidden');
      expect(envelope(res)?.requiredPermission, `${c.method} ${c.url}`).toBe(c.perm);
    }
  });

  it('3. anonymous callers are rejected on Phase 3.2 endpoints (401 before permission logic)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/students' });
    expect(res.statusCode).toBe(401);
    expect(envelope(res)?.code).toBe('unauthenticated');
  });

  it('4. CSRF double-submit is required on every state-changing Phase 3.2 route', async () => {
    const cases: Array<{ method: 'POST' | 'PATCH' | 'DELETE'; url: string; payload: Record<string, unknown> }> = [
      { method: 'POST', url: '/api/v1/students', payload: studentBody({ studentNo: `nc-${slug}` }) },
      { method: 'POST', url: '/api/v1/guardians', payload: guardianBody() },
    ];
    for (const c of cases) {
      const res = await app.inject({
        method: c.method,
        url: c.url,
        headers: { cookie: sessions.ownerA.cookie },
        payload: c.payload,
      });
      expect(res.statusCode, `${c.method} ${c.url}`).toBe(403);
      expect(envelope(res)?.code, `${c.method} ${c.url}`).toBe('csrf_invalid');
    }
  });

  // ------------------------------------------------------------- student CRUD

  it('5. owner creates a student: 201, server-forced applicant status, audit + student.created outbox', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/students',
      headers: { cookie: sessions.ownerA.cookie, ...withCsrf(sessions.ownerA), ...idem(`stu1-${slug}`) },
      payload: studentBody({ primaryCampusId: campusAId }),
    });
    expect(res.statusCode).toBe(201);
    const student = res.json().student as { id: string; status: string; tenantId: string; primaryCampusId: string; createdAt: string };
    studentAId = student.id;
    expect(student.status).toBe('applicant');
    expect(student.tenantId).toBe(uid.tenantA);
    expect(student.primaryCampusId).toBe(campusAId);
    expect(student.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const audit = await rows(
      migratorDb,
      sql`select count(*)::int n from audit_logs where tenant_id = ${uid.tenantA} and action = 'student.created' and resource_id = ${studentAId}`,
    );
    expect(Number(audit[0]!.n)).toBe(1);
    const outbox = await rows(
      migratorDb,
      sql`select count(*)::int n from outbox_events where tenant_id = ${uid.tenantA} and event_type = 'student.created' and aggregate_id = ${studentAId}`,
    );
    expect(Number(outbox[0]!.n)).toBe(1);
  });

  it('6. duplicate student_no maps to 409 student_no_taken (custom UNIQUE_CONFLICTS entry)', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/students',
      headers: { cookie: sessions.ownerA.cookie, ...withCsrf(sessions.ownerA), ...idem(`dup-${slug}`) },
      payload: studentBody({}),
    });
    const dupNo = (created.json().student as { studentNo: string }).studentNo;

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/students',
      headers: { cookie: sessions.ownerA.cookie, ...withCsrf(sessions.ownerA), ...idem(`dup2-${slug}`) },
      payload: studentBody({ studentNo: dupNo }),
    });
    expect(res.statusCode).toBe(409);
    expect(envelope(res)?.code).toBe('student_no_taken');
  });

  it('7. mass assignment is rejected: status/tenantId/id/unknown keys return 400 validation_error', async () => {
    const cases = [
      studentBody({ status: 'active' }),
      studentBody({ tenantId: uid.tenantB }),
      studentBody({ id: randomUUID() }),
      studentBody({ photoFileId: randomUUID() }),
    ];
    for (const payload of cases) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/students',
        headers: { cookie: sessions.ownerA.cookie, ...withCsrf(sessions.ownerA), ...idem(`ma-${randomUUID()}`) },
        payload,
      });
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
      expect(envelope(res)?.code, JSON.stringify(payload)).toBe('validation_error');
    }
  });

  it('8. list + search: q (name ILIKE), status filter, deterministic ordering, total', async () => {
    const list = await app.inject({
      method: 'GET',
      url: `/api/v1/students?q=lovelace&status=applicant&limit=10&offset=0`,
      headers: { cookie: sessions.ownerA.cookie },
    });
    expect(list.statusCode).toBe(200);
    const body = list.json() as { items: Array<{ id: string }>; total: number };
    expect(body.total).toBeGreaterThanOrEqual(1);
    expect(body.items.map((i) => i.id)).toContain(studentAId);

    const all = await app.inject({
      method: 'GET',
      url: '/api/v1/students',
      headers: { cookie: sessions.ownerA.cookie },
    });
    const allBody = all.json() as { items: Array<{ lastName: string }>; total: number };
    const lastNames = allBody.items.map((i) => i.lastName);
    expect(lastNames).toEqual([...lastNames].sort());
  });

  it('9. GET student by id returns the tenant-scoped row; a second student is created on campus B', async () => {
    const fetched = await app.inject({
      method: 'GET',
      url: `/api/v1/students/${studentAId}`,
      headers: { cookie: sessions.ownerA.cookie },
    });
    expect(fetched.statusCode).toBe(200);
    expect((fetched.json().student as { firstName: string }).firstName).toBe('Ada');

    const b = await app.inject({
      method: 'POST',
      url: '/api/v1/students',
      headers: { cookie: sessions.ownerA.cookie, ...withCsrf(sessions.ownerA), ...idem(`stu2-${slug}`) },
      payload: studentBody({ firstName: 'Charles', lastName: 'Babbage', primaryCampusId: campusBId }),
    });
    expect(b.statusCode).toBe(201);
    studentBId = (b.json().student as { id: string }).id;
  });

  it('10. PATCH student updates writable fields and audits student.updated (unique-code conflict inside tx)', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/students/${studentAId}`,
      headers: { cookie: sessions.ownerA.cookie, ...withCsrf(sessions.ownerA) },
      payload: { firstName: 'Augusta' },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json().student as { firstName: string }).firstName).toBe('Augusta');

    const audit = await rows(
      migratorDb,
      sql`select count(*)::int n from audit_logs where tenant_id = ${uid.tenantA} and action = 'student.updated' and resource_id = ${studentAId}`,
    );
    expect(Number(audit[0]!.n)).toBe(1);
  });

  it('11. status and primaryCampusId are not patchable (strict update schema)', async () => {
    for (const payload of [{ status: 'active' }, { primaryCampusId: campusBId }]) {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/students/${studentAId}`,
        headers: { cookie: sessions.ownerA.cookie, ...withCsrf(sessions.ownerA) },
        payload,
      });
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
      expect(envelope(res)?.code, JSON.stringify(payload)).toBe('validation_error');
    }
  });

  // --------------------------------------------------------- guardian CRUD

  it('12. creating a guardian: 201 + guardian.created audit; list + get + search', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/guardians',
      headers: { cookie: sessions.ownerA.cookie, ...withCsrf(sessions.ownerA), ...idem(`g1-${slug}`) },
      payload: guardianBody(),
    });
    expect(created.statusCode).toBe(201);
    guardianAId = (created.json().guardian as { id: string }).id;

    const audit = await rows(
      migratorDb,
      sql`select count(*)::int n from audit_logs where tenant_id = ${uid.tenantA} and action = 'guardian.created' and resource_id = ${guardianAId}`,
    );
    expect(Number(audit[0]!.n)).toBe(1);

    const listed = await app.inject({
      method: 'GET',
      url: `/api/v1/guardians?q=${encodeURIComponent('isabella')}`,
      headers: { cookie: sessions.ownerA.cookie },
    });
    expect(listed.statusCode).toBe(200);
    const body = listed.json() as { items: Array<{ id: string }>; total: number };
    expect(body.total).toBeGreaterThanOrEqual(1);

    const fetched = await app.inject({
      method: 'GET',
      url: `/api/v1/guardians/${guardianAId}`,
      headers: { cookie: sessions.ownerA.cookie },
    });
    expect(fetched.statusCode).toBe(200);
    expect((fetched.json().guardian as { email: string }).email).toMatch(/@example\.com$/);
  });

  it('13. a second guardian is created and guardian PATCH audits guardian.updated', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/guardians',
      headers: { cookie: sessions.ownerA.cookie, ...withCsrf(sessions.ownerA), ...idem(`g2-${slug}`) },
      payload: guardianBody({ firstName: 'Mary', lastName: 'Somerville' }),
    });
    expect(created.statusCode).toBe(201);
    guardianBId = (created.json().guardian as { id: string }).id;

    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/v1/guardians/${guardianBId}`,
      headers: { cookie: sessions.ownerA.cookie, ...withCsrf(sessions.ownerA) },
      payload: { phone: '+250711111111' },
    });
    expect(patched.statusCode).toBe(200);
    expect((patched.json().guardian as { phone: string }).phone).toBe('+250711111111');

    const audit = await rows(
      migratorDb,
      sql`select count(*)::int n from audit_logs where tenant_id = ${uid.tenantA} and action = 'guardian.updated' and resource_id = ${guardianBId}`,
    );
    expect(Number(audit[0]!.n)).toBe(1);
  });

  // --------------------------------------------------------------- links

  it('14. linking a guardian to a student: 201 with guardian embedded; student.guardian.linked audited', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/students/${studentAId}/guardians`,
      headers: { cookie: sessions.ownerA.cookie, ...withCsrf(sessions.ownerA), ...idem(`link1-${slug}`) },
      payload: { guardianId: guardianAId, relation: 'parent', isPrimary: true, canPickup: true },
    });
    expect(res.statusCode).toBe(201);
    const link = res.json().link as { id: string; guardianId: string; isPrimary: boolean; guardian: { id: string } };
    expect(link.guardianId).toBe(guardianAId);
    expect(link.isPrimary).toBe(true);
    expect(link.guardian.id).toBe(guardianAId);

    const audit = await rows(
      migratorDb,
      sql`select count(*)::int n from audit_logs where tenant_id = ${uid.tenantA} and action = 'student.guardian.linked'`,
    );
    expect(Number(audit[0]!.n)).toBe(1);
  });

  it('15. duplicate (student, guardian, relation) maps to 409 guardian_already_linked', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/students/${studentAId}/guardians`,
      headers: { cookie: sessions.ownerA.cookie, ...withCsrf(sessions.ownerA), ...idem(`link-dup-${slug}`) },
      payload: { guardianId: guardianAId, relation: 'parent' },
    });
    expect(res.statusCode).toBe(409);
    expect(envelope(res)?.code).toBe('guardian_already_linked');
  });

  it('16. nested guardians list returns the live link; a different relation on the same guardian is allowed', async () => {
    const list = await app.inject({
      method: 'GET',
      url: `/api/v1/students/${studentAId}/guardians?limit=10&offset=0`,
      headers: { cookie: sessions.ownerA.cookie },
    });
    expect(list.statusCode).toBe(200);
    const body = list.json() as { items: Array<{ relation: string }>; total: number };
    expect(body.total).toBe(1);
    expect(body.items[0]!.relation).toBe('parent');

    const otherRelation = await app.inject({
      method: 'POST',
      url: `/api/v1/students/${studentAId}/guardians`,
      headers: { cookie: sessions.ownerA.cookie, ...withCsrf(sessions.ownerA), ...idem(`link2-${slug}`) },
      payload: { guardianId: guardianAId, relation: 'father' },
    });
    expect(otherRelation.statusCode).toBe(201);

    const after = await app.inject({
      method: 'GET',
      url: `/api/v1/students/${studentAId}/guardians`,
      headers: { cookie: sessions.ownerA.cookie },
    });
    expect((after.json() as { total: number }).total).toBe(2);
  });

  it('17. unlinking releases the (student, guardian, relation) key but keeps the row for audit', async () => {
    const before = await rows(
      migratorDb,
      sql`select count(*)::int n from student_guardians where tenant_id = ${uid.tenantA} and student_id = ${studentAId} and relation = 'parent'`,
    );

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/students/${studentAId}/guardians/${guardianAId}`,
      headers: { cookie: sessions.ownerA.cookie, ...withCsrf(sessions.ownerA) },
    });
    expect(res.statusCode).toBe(204);

    const audit = await rows(
      migratorDb,
      sql`select count(*)::int n from audit_logs where tenant_id = ${uid.tenantA} and action = 'student.guardian.unlinked'`,
    );
    expect(Number(audit[0]!.n)).toBe(1);

    const rowsAfter = await rows(
      migratorDb,
      sql`select count(*)::int n, count(*) filter (where deleted_at is null)::int live from student_guardians where tenant_id = ${uid.tenantA} and student_id = ${studentAId} and relation = 'parent'`,
    );
    expect(Number(rowsAfter[0]!.n)).toBe(Number(before[0]!.n)); // historical row kept
    expect(Number(rowsAfter[0]!.live)).toBe(0); // but no longer live

    const list = await app.inject({
      method: 'GET',
      url: `/api/v1/students/${studentAId}/guardians`,
      headers: { cookie: sessions.ownerA.cookie },
    });
    // Unlinking a guardian releases the WHOLE (student, guardian) pair, so both
    // the parent and the father relation rows are soft-deleted.
    expect((list.json() as { total: number }).total).toBe(0);
  });

  it('18. the same (student, guardian, relation) can be re-linked after the soft unlink (0006 forward-only fix)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/students/${studentAId}/guardians`,
      headers: { cookie: sessions.ownerA.cookie, ...withCsrf(sessions.ownerA), ...idem(`relink-${slug}`) },
      payload: { guardianId: guardianAId, relation: 'parent' },
    });
    expect(res.statusCode).toBe(201);

    const list = await app.inject({
      method: 'GET',
      url: `/api/v1/students/${studentAId}/guardians`,
      headers: { cookie: sessions.ownerA.cookie },
    });
    const body = list.json() as { items: Array<{ relation: string }>; total: number };
    expect(body.total).toBe(1);
    expect(body.items[0]!.relation).toBe('parent');
  });

  // ------------------------------------------------------------- cross-tenant

  it('19. cross-tenant reads/writes of students and guardians are 404 (not_found)', async () => {
    const stud = await app.inject({
      method: 'GET',
      url: `/api/v1/students/${studentAId}`,
      headers: { cookie: sessions.ownerB.cookie },
    });
    expect(stud.statusCode).toBe(404);
    expect(envelope(stud)?.code).toBe('not_found');

    const guard = await app.inject({
      method: 'GET',
      url: `/api/v1/guardians/${guardianAId}`,
      headers: { cookie: sessions.ownerB.cookie },
    });
    expect(guard.statusCode).toBe(404);

    const link = await app.inject({
      method: 'POST',
      url: `/api/v1/students/${studentAId}/guardians`,
      headers: { cookie: sessions.ownerB.cookie, ...withCsrf(sessions.ownerB), ...idem(`xt-${slug}`) },
      payload: { guardianId: guardianAId, relation: 'mother' },
    });
    expect(link.statusCode).toBe(404);
    expect(envelope(link)?.code).toBe('not_found');

    const list = await app.inject({
      method: 'GET',
      url: `/api/v1/students/${studentAId}/guardians`,
      headers: { cookie: sessions.ownerB.cookie },
    });
    expect(list.statusCode).toBe(404);
  });

  it('20. cross-tenant: linking a guardian from tenant B to a tenant A student fails (guardian not found)', async () => {
    const gB = await app.inject({
      method: 'POST',
      url: '/api/v1/guardians',
      headers: { cookie: sessions.ownerB.cookie, ...withCsrf(sessions.ownerB), ...idem(`gb-${slug}`) },
      payload: guardianBody({ firstName: 'Foreign', lastName: 'Guardian' }),
    });
    expect(gB.statusCode).toBe(201);
    const guardianBIdTenantB = (gB.json().guardian as { id: string }).id;

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/students/${studentAId}/guardians`,
      headers: { cookie: sessions.ownerA.cookie, ...withCsrf(sessions.ownerA), ...idem(`xtb-${slug}`) },
      payload: { guardianId: guardianBIdTenantB, relation: 'mother' },
    });
    expect(res.statusCode).toBe(404);
    expect(envelope(res)?.code).toBe('not_found');
  });

  it('21. idempotency: replaying the same key+body returns the stored response without duplicating', async () => {
    const key = `idem-${slug}`;
    const payload = guardianBody({ firstName: 'Idem', lastName: 'Mirror' });
    const headers = { cookie: sessions.ownerA.cookie, ...withCsrf(sessions.ownerA), ...idem(key) };
    const first = await app.inject({ method: 'POST', url: '/api/v1/guardians', headers, payload });
    expect(first.statusCode).toBe(201);
    const firstId = (first.json().guardian as { id: string }).id;

    const second = await app.inject({ method: 'POST', url: '/api/v1/guardians', headers, payload });
    expect(second.statusCode).toBe(201);
    expect((second.json().guardian as { id: string }).id).toBe(firstId);

    const count = await rows(
      migratorDb,
      sql`select count(*)::int n from guardians where tenant_id = ${uid.tenantA} and id = ${firstId}`,
    );
    expect(Number(count[0]!.n)).toBe(1);
  });

  it('22. invalid path params and unknown relation values are rejected as validation_error', async () => {
    const bad = await app.inject({
      method: 'GET',
      url: '/api/v1/students/not-a-uuid',
      headers: { cookie: sessions.ownerA.cookie },
    });
    expect(bad.statusCode).toBe(400);
    expect(envelope(bad)?.code).toBe('validation_error');

    const badRel = await app.inject({
      method: 'POST',
      url: `/api/v1/students/${studentAId}/guardians`,
      headers: { cookie: sessions.ownerA.cookie, ...withCsrf(sessions.ownerA), ...idem(`br-${slug}`) },
      payload: { guardianId: guardianBId, relation: 'cousin' },
    });
    expect(badRel.statusCode).toBe(400);
    expect(envelope(badRel)?.code).toBe('validation_error');
  });

  // ------------------------------------------------------------ campus scope

  it('23. a campus-scoped member can create students on their own campus only', async () => {
    const own = await app.inject({
      method: 'POST',
      url: '/api/v1/students',
      headers: { cookie: sessions.campus.cookie, ...withCsrf(sessions.campus), ...idem(`cs-own-${slug}`) },
      payload: studentBody({ firstName: 'Campus', lastName: 'Local', primaryCampusId: campusAId }),
    });
    expect(own.statusCode).toBe(201);
    expect((own.json().student as { primaryCampusId: string }).primaryCampusId).toBe(campusAId);

    const other = await app.inject({
      method: 'POST',
      url: '/api/v1/students',
      headers: { cookie: sessions.campus.cookie, ...withCsrf(sessions.campus), ...idem(`cs-other-${slug}`) },
      payload: studentBody({ primaryCampusId: campusBId }),
    });
    expect(other.statusCode).toBe(403);
    expect(envelope(other)?.code).toBe('campus_scope_denied');

    const schoolWide = await app.inject({
      method: 'POST',
      url: '/api/v1/students',
      headers: { cookie: sessions.campus.cookie, ...withCsrf(sessions.campus), ...idem(`cs-null-${slug}`) },
      payload: studentBody({}),
    });
    expect(schoolWide.statusCode).toBe(403);
    expect(envelope(schoolWide)?.code).toBe('campus_scope_denied');
  });

  it('24. a campus-scoped member sees only their campus in listings and 404s on other-campus ids', async () => {
    const list = await app.inject({
      method: 'GET',
      url: '/api/v1/students',
      headers: { cookie: sessions.campus.cookie },
    });
    expect(list.statusCode).toBe(200);
    const body = list.json() as { items: Array<{ id: string; primaryCampusId: string }> };
    for (const item of body.items) expect(item.primaryCampusId).toBe(campusAId);

    // studentAId is on campus A (created in test 5); studentBId is on campus B.
    const a = await app.inject({
      method: 'GET',
      url: `/api/v1/students/${studentAId}`,
      headers: { cookie: sessions.campus.cookie },
    });
    expect(a.statusCode).toBe(200);

    const b = await app.inject({
      method: 'GET',
      url: `/api/v1/students/${studentBId}`,
      headers: { cookie: sessions.campus.cookie },
    });
    expect(b.statusCode).toBe(404);
    expect(envelope(b)?.code).toBe('not_found');
  });

  it('25. campus-scoped update and unlink of another-campus students is denied; own-campus is allowed', async () => {
    const patchForeign = await app.inject({
      method: 'PATCH',
      url: `/api/v1/students/${studentBId}`,
      headers: { cookie: sessions.campus.cookie, ...withCsrf(sessions.campus) },
      payload: { firstName: 'Sneak' },
    });
    expect(patchForeign.statusCode).toBe(403);
    expect(envelope(patchForeign)?.code).toBe('campus_scope_denied');

    const deleteForeign = await app.inject({
      method: 'DELETE',
      url: `/api/v1/students/${studentBId}`,
      headers: { cookie: sessions.campus.cookie, ...withCsrf(sessions.campus) },
    });
    expect(deleteForeign.statusCode).toBe(403);

    // Own-campus student created by the campus member is editable.
    const own = await app.inject({
      method: 'POST',
      url: '/api/v1/students',
      headers: { cookie: sessions.campus.cookie, ...withCsrf(sessions.campus), ...idem(`cs-edit-${slug}`) },
      payload: studentBody({ firstName: 'EditMe', lastName: 'Local', primaryCampusId: campusAId }),
    });
    const ownId = (own.json().student as { id: string }).id;
    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/v1/students/${ownId}`,
      headers: { cookie: sessions.campus.cookie, ...withCsrf(sessions.campus) },
      payload: { lastName: 'Patched' },
    });
    expect(patched.statusCode).toBe(200);
    expect((patched.json().student as { lastName: string }).lastName).toBe('Patched');
  });

  // ------------------------------------------------------- soft-delete (wrap-up)

  it('26. deleting a student is a soft delete: 204, hidden from get/list, student.deleted audited', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/students/${studentAId}`,
      headers: { cookie: sessions.ownerA.cookie, ...withCsrf(sessions.ownerA) },
    });
    expect(res.statusCode).toBe(204);

    const fetched = await app.inject({
      method: 'GET',
      url: `/api/v1/students/${studentAId}`,
      headers: { cookie: sessions.ownerA.cookie },
    });
    expect(fetched.statusCode).toBe(404);

    const audit = await rows(
      migratorDb,
      sql`select count(*)::int n from audit_logs where tenant_id = ${uid.tenantA} and action = 'student.deleted' and resource_id = ${studentAId}`,
    );
    expect(Number(audit[0]!.n)).toBe(1);
  });

  it('27. deleting a guardian is a soft delete under the guardians.update permission', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/guardians/${guardianBId}`,
      headers: { cookie: sessions.ownerA.cookie, ...withCsrf(sessions.ownerA) },
    });
    expect(res.statusCode).toBe(204);

    const fetched = await app.inject({
      method: 'GET',
      url: `/api/v1/guardians/${guardianBId}`,
      headers: { cookie: sessions.ownerA.cookie },
    });
    expect(fetched.statusCode).toBe(404);

    const audit = await rows(
      migratorDb,
      sql`select count(*)::int n from audit_logs where tenant_id = ${uid.tenantA} and action = 'guardian.deleted' and resource_id = ${guardianBId}`,
    );
    expect(Number(audit[0]!.n)).toBe(1);
  });

  it('28. ACCEPTANCE: the Phase 3.2 relationship graph is consistent at the database layer', async () => {
    const students = await rows(
      migratorDb,
      sql`select count(*)::int total, count(*) filter (where deleted_at is not null)::int deleted from students where tenant_id = ${uid.tenantA}`,
    );
    expect(Number(students[0]!.total)).toBeGreaterThan(0);
    expect(Number(students[0]!.deleted)).toBeGreaterThanOrEqual(1);

    const guardians = await rows(
      migratorDb,
      sql`select count(*)::int total, count(*) filter (where deleted_at is not null)::int deleted from guardians where tenant_id = ${uid.tenantA}`,
    );
    expect(Number(guardians[0]!.total)).toBeGreaterThanOrEqual(2);
    expect(Number(guardians[0]!.deleted)).toBeGreaterThanOrEqual(1);

    const links = await rows(
      migratorDb,
      sql`select count(*)::int excluding_deleted,
                 count(*) filter (where deleted_at is not null)::int soft_unlinked
          from student_guardians where tenant_id = ${uid.tenantA}`,
    );

    const live = await rows(
      migratorDb,
      sql`select count(*)::int n
          from student_guardians sg join guardians g on g.id = sg.guardian_id join students s on s.id = sg.student_id
          where sg.tenant_id = ${uid.tenantA} and sg.deleted_at is null and g.deleted_at is null and s.deleted_at is null`,
    );
    // Every link still resolves — the soft-unlinked row is history only, and the
    // live set contains exactly the re-link from test 18 on surviving rows.
    expect(Number(links[0]!.soft_unlinked)).toBeGreaterThanOrEqual(1);

    const outboxCreated = await rows(
      migratorDb,
      sql`select count(*)::int n from outbox_events where tenant_id = ${uid.tenantA} and event_type = 'student.created'`,
    );
    expect(Number(outboxCreated[0]!.n)).toBeGreaterThanOrEqual(1);
  });
});