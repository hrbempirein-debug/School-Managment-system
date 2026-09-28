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
 * Phase 3.3 enrollment + promotion lifecycle HTTP acceptance proofs against the
 * ACTUAL Fastify app (`buildApp`), the real dev PostgreSQL under the real
 * `school_app_rw` role, and LIVE Redis. Requires migrations 0001..0006.
 *
 * Proves the lifecycle contract end-to-end:
 *   - authorization wiring on all 10 lifecycle routes (HEAD twins), session /
 *     permission / CSRF gates;
 *   - enroll (insert-first single-winner, 409 student_already_enrolled on a live
 *     duplicate, 409 invalid_student_transition for a non-applicant re-enroll,
 *     audit + student.enrolled outbox);
 *   - transfers (guarded active->transferred only, type 'out' + completed with a
 *     client-supplied or server-default transferredOn, audit + outbox);
 *   - graduation (guarded active->graduated, audit + outbox);
 *   - promotion batches (create 201 draft, same-year CHECK -> 400, add-items
 *     inheriting the batch years, student_already_in_batch, guarded execute
 *     draft->in_progress single-winner + promotion.batch.execute outbox, invalid
 *     batch state on re-execute and post-execute item adds);
 *   - strict request schemas (mass-assignment 400), idempotency replay;
 *   - cross-tenant 404s and campus-scope 403s on the lifecycle write/read paths;
 *   - a final DB-consistency acceptance pass.
 *
 * Opt-in: RUN_RUNTIME_SECURITY_TESTS=1.
 */
const enabled = process.env.RUN_RUNTIME_SECURITY_TESTS === '1';
const describeDb = enabled ? describe : describe.skip;

const stubStorage = {
  async readObject(): Promise<Buffer> {
    throw new Error('storage must not be consulted in Phase 3.3 tests');
  },
} as unknown as StorageProvider;

interface SessionCookies {
  token: string;
  csrf: string;
  cookie: string;
}

describeDb('Phase 3.3 enrollment & promotion lifecycle: HTTP security + acceptance (real app + real DB + live Redis)', () => {
  let migratorDb: Db;
  let appDb: Db;
  let redis: Redis;
  let endMigrator: () => Promise<void>;
  let endApp: () => Promise<void>;
  let endRedis: () => Promise<unknown>;
  let app: Awaited<ReturnType<typeof buildApp>>;

  const uid: Record<string, string> = {};
  const slug = `p3l${randomUUID().slice(0, 8)}`;
  const sessions: Record<'ownerA' | 'ownerB' | 'parent' | 'campus', SessionCookies> = {} as never;
  const zeroUuid = '00000000-0000-0000-0000-000000000000';

  let campusAId = '';
  let campusBId = '';
  let yearA1 = '';
  let yearA2 = '';
  let yearB = '';
  let studentAId = '';
  let studentBId = '';
  let studentCId = '';
  let studentDId = '';
  let studentEId = '';
  let batch1Id = '';
  let enrollAId = '';
  let enrollBId = '';

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
    studentNo: `L-${randomUUID().slice(0, 8)}`,
    firstName: 'Ada',
    lastName: 'Lovelace',
    dateOfBirth: '1815-12-10',
    gender: 'female',
    ...over,
  });

  const enrollHeaders = (s: SessionCookies, key: string) => ({
    cookie: s.cookie,
    ...withCsrf(s),
    ...idem(`${key}-${slug}`),
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
      sql`insert into roles (id, scope, code, name, is_system) values (${uid.platRole}, 'platform', ${`p3lp${slug}_plat`}, 'Phase 3.3 Platform Admin', true)`,
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
      createTenantTransaction(tx, platformCtx(uid.owner!), { slug: `${slug}-a`, name: 'Phase 3.3 A', requestId: randomUUID() }),
    );
    uid.tenantA = createdA.tenantId;
    const createdB = await withTenant(appDb, platformCtx(uid.owner!), (tx) =>
      createTenantTransaction(tx, platformCtx(uid.owner!), { slug: `${slug}-b`, name: 'Phase 3.3 B', requestId: randomUUID() }),
    );
    uid.tenantB = createdB.tenantId;

    // Parent member of tenant A: parent role only (no lifecycle perms).
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

    // Campus-scoped member of tenant A with school_owner: only the campus guard
    // keeps them away from other campuses.
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

    sessions.ownerA = await makeSession(uid.owner!, uid.tenantA!);
    sessions.ownerB = await makeSession(uid.owner!, uid.tenantB!);
    sessions.parent = await makeSession(uid.parent!, uid.tenantA!);
    sessions.campus = await makeSession(uid.campusUser!, uid.tenantA!);

    app = await buildApp({
      deps: { db: appDb, redis, storage: stubStorage },
      logger: false,
    });

    const mkCampus = async (code: string, name: string) => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/campuses',
        headers: enrollHeaders(sessions.ownerA, `c-${code}`),
        payload: { code, name },
      });
      expect(res.statusCode).toBe(201);
      return (res.json().campus as { id: string }).id;
    };
    campusAId = await mkCampus(`p3la-${slug}`, 'Lifecycle Main');
    campusBId = await mkCampus(`p3lb-${slug}`, 'Lifecycle Annex');
    await rows(
      migratorDb,
      sql`update memberships set campus_id = ${campusAId} where id = ${uid.campusMembership}`,
    );

    const mkYear = async (
      code: string,
      name: string,
      startsOn: string,
      endsOn: string,
      s: SessionCookies,
      key: string,
    ) => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/academic-years',
        headers: enrollHeaders(s, key),
        payload: { code, name, startsOn, endsOn },
      });
      expect(res.statusCode).toBe(201);
      const yearId = (res.json().academicYear as { id: string }).id;
      const opened = await app.inject({
        method: 'POST',
        url: `/api/v1/academic-years/${yearId}/open`,
        headers: enrollHeaders(s, `open-${key}`),
      });
      expect(opened.statusCode).toBe(200);
      return yearId;
    };
    yearA1 = await mkYear(`p3l-ya1-${slug}`, 'AY 2026 A', '2026-01-01', '2026-12-31', sessions.ownerA, 'ya1');
    yearA2 = await mkYear(`p3l-ya2-${slug}`, 'AY 2027 A', '2027-01-01', '2027-12-31', sessions.ownerA, 'ya2');
    yearB = await mkYear(`p3l-yb-${slug}`, 'AY 2026 B', '2026-01-01', '2026-12-31', sessions.ownerB, 'yb');

    const mkStudent = async (over: Record<string, unknown>, key: string) => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/students',
        headers: enrollHeaders(sessions.ownerA, key),
        payload: studentBody(over),
      });
      expect(res.statusCode).toBe(201);
      return (res.json().student as { id: string }).id;
    };
    studentAId = await mkStudent({ firstName: 'Ada', lastName: 'Lovelace', primaryCampusId: campusAId }, 'stu-a');
    studentBId = await mkStudent({ firstName: 'Charles', lastName: 'Babbage', primaryCampusId: campusBId }, 'stu-b');
    studentCId = await mkStudent({ firstName: 'Carol', lastName: 'Gamma', primaryCampusId: campusAId }, 'stu-c');
    studentDId = await mkStudent({ firstName: 'Dana', lastName: 'Delta', primaryCampusId: campusAId }, 'stu-d');
    studentEId = await mkStudent({ firstName: 'Eve', lastName: 'Epsilon', primaryCampusId: campusAId }, 'stu-e');
  });

  afterAll(async () => {
    try {
      if (app) await app.close();
      const tIn = `'${uid.tenantA}','${uid.tenantB}'`;
      await rows(migratorDb, sql`delete from outbox_events where tenant_id in (${sql.raw(tIn)})`);
      await rows(migratorDb, sql`delete from idempotency_keys where tenant_id in (${sql.raw(tIn)})`);
      await rows(migratorDb, sql`delete from promotion_items where tenant_id in (${sql.raw(tIn)})`);
      await rows(migratorDb, sql`delete from promotion_batches where tenant_id in (${sql.raw(tIn)})`);
      await rows(migratorDb, sql`delete from transfers where tenant_id in (${sql.raw(tIn)})`);
      await rows(migratorDb, sql`delete from enrollments where tenant_id in (${sql.raw(tIn)})`);
      await rows(migratorDb, sql`delete from students where tenant_id in (${sql.raw(tIn)})`);
      await rows(migratorDb, sql`delete from academic_years where tenant_id in (${sql.raw(tIn)})`);
      await rows(migratorDb, sql`delete from campuses where tenant_id in (${sql.raw(tIn)})`);
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

  it('1. reports every Phase 3.3 lifecycle route in the post-boot matrix (enrollment.read/manage, HEAD twins)', async () => {
    const byRoute = new Map(
      app.routeAuthorizationMatrix().routes.map((r) => [`${r.method} ${r.url}`, r]),
    );
    const primary: Record<string, string> = {
      'GET /api/v1/enrollments': 'enrollment.read',
      'GET /api/v1/enrollments/:id': 'enrollment.read',
      'POST /api/v1/students/:id/enroll': 'enrollment.manage',
      'POST /api/v1/students/:id/transfer': 'enrollment.manage',
      'POST /api/v1/students/:id/graduate': 'enrollment.manage',
      'POST /api/v1/promotion-batches': 'enrollment.manage',
      'GET /api/v1/promotion-batches': 'enrollment.read',
      'GET /api/v1/promotion-batches/:id': 'enrollment.read',
      'POST /api/v1/promotion-batches/:id/items': 'enrollment.manage',
      'POST /api/v1/promotion-batches/:id/execute': 'enrollment.manage',
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

  it('2. parent is denied every Phase 3.3 lifecycle route with the documented required permission', async () => {
    const cases: Array<{ method: string; url: string; perm: string }> = [
      { method: 'GET', url: '/api/v1/enrollments', perm: 'enrollment.read' },
      { method: 'GET', url: `/api/v1/enrollments/${zeroUuid}`, perm: 'enrollment.read' },
      { method: 'POST', url: `/api/v1/students/${zeroUuid}/enroll`, perm: 'enrollment.manage' },
      { method: 'POST', url: `/api/v1/students/${zeroUuid}/transfer`, perm: 'enrollment.manage' },
      { method: 'POST', url: `/api/v1/students/${zeroUuid}/graduate`, perm: 'enrollment.manage' },
      { method: 'POST', url: '/api/v1/promotion-batches', perm: 'enrollment.manage' },
      { method: 'GET', url: '/api/v1/promotion-batches', perm: 'enrollment.read' },
      { method: 'GET', url: `/api/v1/promotion-batches/${zeroUuid}`, perm: 'enrollment.read' },
      { method: 'POST', url: `/api/v1/promotion-batches/${zeroUuid}/items`, perm: 'enrollment.manage' },
      { method: 'POST', url: `/api/v1/promotion-batches/${zeroUuid}/execute`, perm: 'enrollment.manage' },
    ];
    for (const c of cases) {
      const res = await app.inject({
        method: c.method as 'GET' | 'POST',
        url: c.url,
        headers: { cookie: sessions.parent.cookie },
      });
      expect(res.statusCode, `${c.method} ${c.url}`).toBe(403);
      expect(envelope(res)?.code, `${c.method} ${c.url}`).toBe('forbidden');
      expect(envelope(res)?.requiredPermission, `${c.method} ${c.url}`).toBe(c.perm);
    }
  });

  it('3. anonymous callers are rejected on lifecycle endpoints (401 before permission logic)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/enrollments' });
    expect(res.statusCode).toBe(401);
    expect(envelope(res)?.code).toBe('unauthenticated');
  });

  it('4. CSRF double-submit is required on every state-changing lifecycle route', async () => {
    const cases: Array<{ method: 'POST'; url: string; payload?: Record<string, unknown> }> = [
      { method: 'POST', url: `/api/v1/students/${zeroUuid}/enroll`, payload: { academicYearId: zeroUuid } },
      { method: 'POST', url: '/api/v1/promotion-batches', payload: { fromAcademicYearId: zeroUuid, toAcademicYearId: zeroUuid } },
      { method: 'POST', url: `/api/v1/promotion-batches/${zeroUuid}/execute` },
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

  // ------------------------------------------------------------------- enroll

  it('5. owner enrolls an applicant: 200, active enrollment, audit + student.enrolled outbox, student flips to active', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/students/${studentAId}/enroll`,
      headers: enrollHeaders(sessions.ownerA, 'enroll-a'),
      payload: { academicYearId: yearA1 },
    });
    expect(res.statusCode).toBe(200);
    const enrollment = res.json().enrollment as {
      id: string;
      studentId: string;
      academicYearId: string;
      status: string;
      createdAt: string;
    };
    enrollAId = enrollment.id;
    expect(enrollment.studentId).toBe(studentAId);
    expect(enrollment.academicYearId).toBe(yearA1);
    expect(enrollment.status).toBe('active');
    expect(enrollment.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const audit = await rows(
      migratorDb,
      sql`select count(*)::int n from audit_logs where tenant_id = ${uid.tenantA} and action = 'student.enrolled' and resource_id = ${enrollAId}`,
    );
    expect(Number(audit[0]!.n)).toBe(1);
    const outbox = await rows(
      migratorDb,
      sql`select count(*)::int n from outbox_events where tenant_id = ${uid.tenantA} and event_type = 'student.enrolled' and aggregate_id = ${enrollAId}`,
    );
    expect(Number(outbox[0]!.n)).toBe(1);

    const student = await app.inject({
      method: 'GET',
      url: `/api/v1/students/${studentAId}`,
      headers: { cookie: sessions.ownerA.cookie },
    });
    expect(student.statusCode).toBe(200);
    expect((student.json().student as { status: string }).status).toBe('active');
  });

  it('6. a live duplicate (student, year) maps to 409 student_already_enrolled (enrollments_student_year_uq)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/students/${studentAId}/enroll`,
      headers: enrollHeaders(sessions.ownerA, 'enroll-a-dup'),
      payload: { academicYearId: yearA1 },
    });
    expect(res.statusCode).toBe(409);
    expect(envelope(res)?.code).toBe('student_already_enrolled');
  });

  it('7. re-enrolling an ACTIVE student into another year is 409 invalid_student_transition (multi-year movement is promotion)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/students/${studentAId}/enroll`,
      headers: enrollHeaders(sessions.ownerA, 'enroll-a-other'),
      payload: { academicYearId: yearA2 },
    });
    expect(res.statusCode).toBe(409);
    expect(envelope(res)?.code).toBe('invalid_student_transition');
  });

  it('8. list + get enrollments honour student/academic-year/status filters and are tenant-scoped', async () => {
    const byStudent = await app.inject({
      method: 'GET',
      url: `/api/v1/enrollments?studentId=${studentAId}`,
      headers: { cookie: sessions.ownerA.cookie },
    });
    expect(byStudent.statusCode).toBe(200);
    const items = (byStudent.json() as { items: Array<{ id: string; academicYearId: string; status: string }>; total: number }).items;
    expect(items.length).toBe(1);
    expect(items[0]!.academicYearId).toBe(yearA1);
    expect(items[0]!.status).toBe('active');

    const filtered = await app.inject({
      method: 'GET',
      url: `/api/v1/enrollments?academicYearId=${yearA1}&status=active&limit=10&offset=0`,
      headers: { cookie: sessions.ownerA.cookie },
    });
    const f = filtered.json() as { items: Array<{ id: string }>; total: number };
    expect(f.total).toBeGreaterThanOrEqual(1);
    expect(f.items.map((i) => i.id)).toContain(enrollAId);

    const fetched = await app.inject({
      method: 'GET',
      url: `/api/v1/enrollments/${enrollAId}`,
      headers: { cookie: sessions.ownerA.cookie },
    });
    expect(fetched.statusCode).toBe(200);
    expect((fetched.json().enrollment as { studentId: string }).studentId).toBe(studentAId);
  });

  it('9. owner enrolls a second student (campus B) into year A1', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/students/${studentBId}/enroll`,
      headers: enrollHeaders(sessions.ownerA, 'enroll-b'),
      payload: { academicYearId: yearA1 },
    });
    expect(res.statusCode).toBe(200);
    enrollBId = (res.json().enrollment as { id: string }).id;
  });

  // ----------------------------------------------------------------- transfer

  it('10. transferring an applicant is 409 invalid_student_transition (must be active first)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/students/${studentCId}/transfer`,
      headers: enrollHeaders(sessions.ownerA, 'tr-c'),
      payload: { toSchoolName: 'Elsewhere' },
    });
    expect(res.statusCode).toBe(409);
    expect(envelope(res)?.code).toBe('invalid_student_transition');
  });

  it('11. transferring an ACTIVE student: type out, completed, client transferredOn honored, audit + outbox, student -> transferred', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/students/${studentBId}/transfer`,
      headers: enrollHeaders(sessions.ownerA, 'tr-b'),
      payload: { toSchoolName: 'Academy B', reason: 'family relocation', transferredOn: '2026-03-15' },
    });
    expect(res.statusCode).toBe(200);
    const transfer = res.json().transfer as {
      id: string;
      studentId: string;
      type: string;
      status: string;
      toSchoolName: string;
      reason: string;
      transferredOn: string;
    };
    expect(transfer.studentId).toBe(studentBId);
    expect(transfer.type).toBe('out');
    expect(transfer.status).toBe('completed');
    expect(transfer.toSchoolName).toBe('Academy B');
    expect(transfer.reason).toBe('family relocation');
    expect(transfer.transferredOn).toBe('2026-03-15');

    const audit = await rows(
      migratorDb,
      sql`select count(*)::int n from audit_logs where tenant_id = ${uid.tenantA} and action = 'student.transferred' and resource_id = ${transfer.id}`,
    );
    expect(Number(audit[0]!.n)).toBe(1);
    const outbox = await rows(
      migratorDb,
      sql`select count(*)::int n from outbox_events where tenant_id = ${uid.tenantA} and event_type = 'student.transferred' and aggregate_id = ${transfer.id}`,
    );
    expect(Number(outbox[0]!.n)).toBe(1);

    const student = await app.inject({
      method: 'GET',
      url: `/api/v1/students/${studentBId}`,
      headers: { cookie: sessions.ownerA.cookie },
    });
    expect((student.json().student as { status: string }).status).toBe('transferred');
  });

  it('12. re-transferring a transferred student is 409 invalid_student_transition', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/students/${studentBId}/transfer`,
      headers: enrollHeaders(sessions.ownerA, 'tr-b-again'),
      payload: { reason: 'again' },
    });
    expect(res.statusCode).toBe(409);
    expect(envelope(res)?.code).toBe('invalid_student_transition');
  });

  // ----------------------------------------------------------------- graduate

  it('13. graduate cycle: enroll then graduate an applicant, audit + outbox; re-graduate is 409', async () => {
    const enrolled = await app.inject({
      method: 'POST',
      url: `/api/v1/students/${studentCId}/enroll`,
      headers: enrollHeaders(sessions.ownerA, 'enroll-c'),
      payload: { academicYearId: yearA1 },
    });
    expect(enrolled.statusCode).toBe(200);

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/students/${studentCId}/graduate`,
      headers: enrollHeaders(sessions.ownerA, 'grad-c'),
    });
    expect(res.statusCode).toBe(200);
    expect((res.json().student as { id: string; status: string }).id).toBe(studentCId);
    expect((res.json().student as { status: string }).status).toBe('graduated');

    const audit = await rows(
      migratorDb,
      sql`select count(*)::int n from audit_logs where tenant_id = ${uid.tenantA} and action = 'student.graduated' and resource_id = ${studentCId}`,
    );
    expect(Number(audit[0]!.n)).toBe(1);
    const outbox = await rows(
      migratorDb,
      sql`select count(*)::int n from outbox_events where tenant_id = ${uid.tenantA} and event_type = 'student.graduated' and aggregate_id = ${studentCId}`,
    );
    expect(Number(outbox[0]!.n)).toBe(1);

    const again = await app.inject({
      method: 'POST',
      url: `/api/v1/students/${studentCId}/graduate`,
      headers: enrollHeaders(sessions.ownerA, 'grad-c-again'),
    });
    expect(again.statusCode).toBe(409);
    expect(envelope(again)?.code).toBe('invalid_student_transition');
  });

  it('14. graduating an ACTIVE student works and the student row reports graduated', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/students/${studentAId}/graduate`,
      headers: enrollHeaders(sessions.ownerA, 'grad-a'),
    });
    expect(res.statusCode).toBe(200);
    expect((res.json().student as { status: string }).status).toBe('graduated');
  });

  // ------------------------------------------------------------- cross-tenant

  it('15. cross-tenant reads/writes of enrollments and lifecycle actions are 404 (not_found)', async () => {
    const one = await app.inject({
      method: 'GET',
      url: `/api/v1/enrollments/${enrollAId}`,
      headers: { cookie: sessions.ownerB.cookie },
    });
    expect(one.statusCode).toBe(404);
    expect(envelope(one)?.code).toBe('not_found');

    const transfer = await app.inject({
      method: 'POST',
      url: `/api/v1/students/${studentAId}/transfer`,
      headers: { cookie: sessions.ownerB.cookie, ...withCsrf(sessions.ownerB), ...idem(`xt-tr-${slug}`) },
      payload: { reason: 'sneak' },
    });
    expect(transfer.statusCode).toBe(404);
    expect(envelope(transfer)?.code).toBe('not_found');

    const list = await app.inject({
      method: 'GET',
      url: '/api/v1/enrollments',
      headers: { cookie: sessions.ownerB.cookie },
    });
    expect(list.statusCode).toBe(200);
    expect((list.json() as { total: number }).total).toBe(0);
  });

  // ------------------------------------------------------------ campus scope

  it('16. a campus-scoped member cannot act on another campus; can enroll + list their own campus only', async () => {
    // studentBId lives on campus B: cross-campus transfer is 403 campus_scope_denied.
    const other = await app.inject({
      method: 'POST',
      url: `/api/v1/students/${studentBId}/transfer`,
      headers: { cookie: sessions.campus.cookie, ...withCsrf(sessions.campus), ...idem(`cs-tr-${slug}`) },
      payload: { reason: 'nope' },
    });
    expect(other.statusCode).toBe(403);
    expect(envelope(other)?.code).toBe('campus_scope_denied');

    // Own-campus student D is enrollable by the campus member.
    const own = await app.inject({
      method: 'POST',
      url: `/api/v1/students/${studentDId}/enroll`,
      headers: { cookie: sessions.campus.cookie, ...withCsrf(sessions.campus), ...idem(`cs-en-${slug}`) },
      payload: { academicYearId: yearA1 },
    });
    expect(own.statusCode).toBe(200);

    // Enrollments list only shows campus-A students (studentD/studentA/studentC),
    // never campus-B studentB's year-A enrollment.
    const list = await app.inject({
      method: 'GET',
      url: '/api/v1/enrollments',
      headers: { cookie: sessions.campus.cookie },
    });
    expect(list.statusCode).toBe(200);
    const items = (list.json() as { items: Array<{ studentId: string }>; total: number }).items;
    expect(items.length).toBeGreaterThanOrEqual(3);
    expect(items.map((i) => i.studentId)).not.toContain(studentBId);

    // Direct fetch of a campus-B enrollment is 404 for the campus member.
    const b = await app.inject({
      method: 'GET',
      url: `/api/v1/enrollments/${enrollBId}`,
      headers: { cookie: sessions.campus.cookie },
    });
    expect(b.statusCode).toBe(404);
    expect(envelope(b)?.code).toBe('not_found');
  });

  // ------------------------------------------------------------ promotions

  it('17. creating a promotion batch: 201 draft + promotion.batch.created audit; list/get reflect it', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/promotion-batches',
      headers: enrollHeaders(sessions.ownerA, 'pb-1'),
      payload: { fromAcademicYearId: yearA1, toAcademicYearId: yearA2 },
    });
    expect(res.statusCode).toBe(201);
    const batch = res.json().promotionBatch as {
      id: string;
      fromAcademicYearId: string;
      toAcademicYearId: string;
      status: string;
      completedAt: string | null;
    };
    batch1Id = batch.id;
    expect(batch.fromAcademicYearId).toBe(yearA1);
    expect(batch.toAcademicYearId).toBe(yearA2);
    expect(batch.status).toBe('draft');
    expect(batch.completedAt).toBeNull();

    const audit = await rows(
      migratorDb,
      sql`select count(*)::int n from audit_logs where tenant_id = ${uid.tenantA} and action = 'promotion.batch.created' and resource_id = ${batch1Id}`,
    );
    expect(Number(audit[0]!.n)).toBe(1);

    const listed = await app.inject({
      method: 'GET',
      url: '/api/v1/promotion-batches?status=draft',
      headers: { cookie: sessions.ownerA.cookie },
    });
    const l = listed.json() as { items: Array<{ id: string }>; total: number };
    expect(l.items.map((i) => i.id)).toContain(batch1Id);

    const detail = await app.inject({
      method: 'GET',
      url: `/api/v1/promotion-batches/${batch1Id}`,
      headers: { cookie: sessions.ownerA.cookie },
    });
    expect(detail.statusCode).toBe(200);
    const d = detail.json() as { promotionBatch: { id: string }; items: unknown[] };
    expect(d.promotionBatch.id).toBe(batch1Id);
    expect(d.items).toEqual([]);
  });

  it('18. a batch from a year to ITSELF is rejected (promotion_batches_distinct_years_ck -> 400 validation_error)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/promotion-batches',
      headers: enrollHeaders(sessions.ownerA, 'pb-same'),
      payload: { fromAcademicYearId: yearA1, toAcademicYearId: yearA1 },
    });
    expect(res.statusCode).toBe(400);
    expect(envelope(res)?.code).toBe('validation_error');
  });

  it('19. adding items inherits the batch from/to years, audits each item, and records 201', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/promotion-batches/${batch1Id}/items`,
      headers: enrollHeaders(sessions.ownerA, 'pb-items'),
      payload: { studentIds: [studentDId, studentEId] },
    });
    expect(res.statusCode).toBe(201);
    const items = res.json().items as Array<{
      id: string;
      studentId: string;
      fromAcademicYearId: string;
      toAcademicYearId: string;
      status: string;
    }>;
    expect(items.length).toBe(2);
    for (const item of items) {
      expect(item.fromAcademicYearId).toBe(yearA1);
      expect(item.toAcademicYearId).toBe(yearA2);
      expect(item.status).toBe('pending');
    }
    expect(items.map((i) => i.studentId)).toEqual([studentDId, studentEId]);

    const audit = await rows(
      migratorDb,
      sql`select count(*)::int n from audit_logs where tenant_id = ${uid.tenantA} and action = 'promotion.batch.item.added' and resource_id in (${items[0]!.id}, ${items[1]!.id})`,
    );
    expect(Number(audit[0]!.n)).toBe(2);
  });

  it('20. adding the same student twice to one batch is 409 student_already_in_batch (promotion_items_batch_student_uq)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/promotion-batches/${batch1Id}/items`,
      headers: enrollHeaders(sessions.ownerA, 'pb-items-dup'),
      payload: { studentIds: [studentEId] },
    });
    expect(res.statusCode).toBe(409);
    expect(envelope(res)?.code).toBe('student_already_in_batch');
  });

  it('21. executing a draft batch: guarded draft->in_progress, audit + promotion.batch.execute outbox', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/promotion-batches/${batch1Id}/execute`,
      headers: enrollHeaders(sessions.ownerA, 'pb-exec'),
    });
    expect(res.statusCode).toBe(200);
    expect((res.json().promotionBatch as { status: string }).status).toBe('in_progress');

    const audit = await rows(
      migratorDb,
      sql`select count(*)::int n from audit_logs where tenant_id = ${uid.tenantA} and action = 'promotion.batch.execute_requested' and resource_id = ${batch1Id}`,
    );
    expect(Number(audit[0]!.n)).toBe(1);

    const outbox = await rows(
      migratorDb,
      sql`select payload from outbox_events where tenant_id = ${uid.tenantA} and event_type = 'promotion.batch.execute' and aggregate_id = ${batch1Id}`,
    );
    expect(outbox.length).toBe(1);
    const payload = (outbox[0]!.payload as { tenantId: string; batchId: string });
    expect(payload.tenantId).toBe(uid.tenantA);
    expect(payload.batchId).toBe(batch1Id);
  });

  it('22. re-executing a non-draft batch is 409 invalid_batch_state (single-winner guard)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/promotion-batches/${batch1Id}/execute`,
      headers: enrollHeaders(sessions.ownerA, 'pb-exec-again'),
    });
    expect(res.statusCode).toBe(409);
    expect(envelope(res)?.code).toBe('invalid_batch_state');
  });

  it('23. adding items to a batch that is no longer draft is 409 invalid_batch_state', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/promotion-batches/${batch1Id}/items`,
      headers: enrollHeaders(sessions.ownerA, 'pb-items-late'),
      payload: { studentIds: [studentCId] },
    });
    expect(res.statusCode).toBe(409);
    expect(envelope(res)?.code).toBe('invalid_batch_state');
  });

  it('24. cross-tenant execute of tenant-A batch from tenant B is 404', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/promotion-batches/${batch1Id}/execute`,
      headers: { cookie: sessions.ownerB.cookie, ...withCsrf(sessions.ownerB), ...idem(`xt-exec-${slug}`) },
    });
    expect(res.statusCode).toBe(404);
    expect(envelope(res)?.code).toBe('not_found');
  });

  // ------------------------------------------------------------- idempotency

  it('25. idempotency: replaying the same enroll key+body returns the stored response without duplicating', async () => {
    const key = `pbl-idem-${slug}`;
    const payload = { academicYearId: yearA1 };
    const headers = enrollHeaders(sessions.ownerA, key);
    const first = await app.inject({
      method: 'POST',
      url: `/api/v1/students/${studentEId}/enroll`,
      headers,
      payload,
    });
    expect(first.statusCode).toBe(200);
    const firstId = (first.json().enrollment as { id: string }).id;

    const second = await app.inject({
      method: 'POST',
      url: `/api/v1/students/${studentEId}/enroll`,
      headers,
      payload,
    });
    expect(second.statusCode).toBe(200);
    expect((second.json().enrollment as { id: string }).id).toBe(firstId);

    const count = await rows(
      migratorDb,
      sql`select count(*)::int n from enrollments where tenant_id = ${uid.tenantA} and id = ${firstId}`,
    );
    expect(Number(count[0]!.n)).toBe(1);
  });

  // ------------------------------------------------------- strict schemas 400

  it('26. mass-assignment and malformed values are rejected as validation_error', async () => {
    const wrongShape = await app.inject({
      method: 'POST',
      url: `/api/v1/students/${studentAId}/enroll`,
      headers: enrollHeaders(sessions.ownerA, 'ma-enroll'),
      payload: { academicYearId: yearA1, status: 'active' },
    });
    expect(wrongShape.statusCode).toBe(400);
    expect(envelope(wrongShape)?.code).toBe('validation_error');

    const batchMass = await app.inject({
      method: 'POST',
      url: '/api/v1/promotion-batches',
      headers: enrollHeaders(sessions.ownerA, 'ma-batch'),
      payload: { fromAcademicYearId: yearA1, toAcademicYearId: yearA2, tenantId: uid.tenantA },
    });
    expect(batchMass.statusCode).toBe(400);
    expect(envelope(batchMass)?.code).toBe('validation_error');

    const badUuid = await app.inject({
      method: 'GET',
      url: '/api/v1/enrollments/not-a-uuid',
      headers: { cookie: sessions.ownerA.cookie },
    });
    expect(badUuid.statusCode).toBe(400);
    expect(envelope(badUuid)?.code).toBe('validation_error');

    const unknownYear = await app.inject({
      method: 'POST',
      url: '/api/v1/promotion-batches',
      headers: enrollHeaders(sessions.ownerA, 'unk-batch'),
      payload: { fromAcademicYearId: randomUUID(), toAcademicYearId: yearA2 },
    });
    expect(unknownYear.statusCode).toBe(404);
    expect(envelope(unknownYear)?.code).toBe('not_found');
  });

  // ---------------------------------------------------------------- wrap-up

  it('27. ACCEPTANCE: the Phase 3.3 lifecycle graph is consistent at the database layer', async () => {
    const students = await rows(
      migratorDb,
      sql`select id, status from students where tenant_id = ${uid.tenantA} and id in (${studentAId}, ${studentBId}, ${studentCId}, ${studentDId}, ${studentEId})`,
    );
    const byId = new Map(students.map((s) => [String(s.id), String(s.status)]));
    expect(byId.get(studentAId)).toBe('graduated');
    expect(byId.get(studentBId)).toBe('transferred');
    expect(byId.get(studentCId)).toBe('graduated');
    expect(byId.get(studentDId)).toBe('active');
    expect(byId.get(studentEId)).toBe('active');

    const enrollments = await rows(
      migratorDb,
      sql`select count(*)::int n from enrollments where tenant_id = ${uid.tenantA} and deleted_at is null`,
    );
    expect(Number(enrollments[0]!.n)).toBe(5);

    const transfers = await rows(
      migratorDb,
      sql`select count(*)::int n from transfers where tenant_id = ${uid.tenantA}`,
    );
    expect(Number(transfers[0]!.n)).toBe(1);

    const batch = await rows(
      migratorDb,
      sql`select status from promotion_batches where tenant_id = ${uid.tenantA} and id = ${batch1Id}`,
    );
    expect(String(batch[0]!.status)).toBe('in_progress');

    const items = await rows(
      migratorDb,
      sql`select status, error from promotion_items where tenant_id = ${uid.tenantA} and batch_id = ${batch1Id} order by id`,
    );
    expect(items.length).toBe(2);
    for (const item of items) expect(String(item.status)).toBe('pending');

    const outboxEvents = await rows(
      migratorDb,
      sql`select event_type, count(*)::int n from outbox_events where tenant_id = ${uid.tenantA} and event_type in ('student.enrolled','student.transferred','student.graduated','promotion.batch.execute') group by event_type`,
    );
    const eventCounts = Object.fromEntries(outboxEvents.map((r) => [String(r.event_type), Number(r.n)]));
    expect(eventCounts['student.enrolled']).toBeGreaterThanOrEqual(5);
    expect(eventCounts['student.transferred']).toBe(1);
    expect(eventCounts['student.graduated']).toBe(2);
    expect(eventCounts['promotion.batch.execute']).toBe(1);
  });
});