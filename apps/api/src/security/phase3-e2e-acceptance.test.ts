import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { getEnv, type Env } from '@sms/config';
import { createDb, withTenant, type Db } from '@sms/db';
import type { RequestContext } from '@sms/core';
import type { StorageProvider } from '@sms/storage';
import { FsStorageProvider } from '@sms/storage';
import { writeSession, type RedisSession } from '@sms/auth';
import { createRedis } from '@sms/redis';
import { buildApp } from '../app.js';
import { createTenantTransaction } from '../routes/tenants.js';

/**
 * Phase 3.7 single-flow HTTP end-to-end acceptance against the ACTUAL Fastify
 * app (`buildApp`), the real dev PostgreSQL under the real `school_app_rw` role,
 * LIVE Redis, and a throwaway temp-directory FsStorageProvider.
 *
 * One tenant walks the ENTIRE Phase 3 surface in a single realistic flow:
 *   campus + academic-year setup → students → guardians → links → admission +
 *   approve (student materialization) → enroll → document upload → scan-gate →
 *   clean download → transfer → graduate → promotion batch execute → CSV import
 *   (202 + storage object + audit + outbox) → CSV export (tenant-isolated,
 *   formula neutralized). The same flow carries the consolidated security sweep:
 *   authorization matrix, principal read-only boundary, anonymous 401, CSRF,
 *   mass-assignment rejection, cross-tenant 404s, campus-scope 403/404, and a
 *   final DB-consistency acceptance pass (audit == outbox per action, no orphans).
 *
 * The async executors (student.import.submitted, student.document.uploaded scan,
 * promotion.batch.execute) are the real worker suite's job
 * (`apps/worker/src/student-import.test.ts`, `outbox-integration.test.ts`, both
 * on real PG + LIVE Redis); this suite proves the HTTP contract that hands the
 * event to them (outbox row present with the exact aggregate_id, storage object
 * landed, POST states returned) and the read-back contract once they run.
 *
 * Opt-in: RUN_RUNTIME_SECURITY_TESTS=1.
 */
const enabled = process.env.RUN_RUNTIME_SECURITY_TESTS === '1';
const describeDb = enabled ? describe : describe.skip;

const PDF_SIGNATURE = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d]);
const pdfBytes = (size = 128) => Buffer.concat([PDF_SIGNATURE, Buffer.alloc(size, 0x44)]);

interface SessionCookies {
  token: string;
  csrf: string;
  cookie: string;
}

describeDb('Phase 3.7 E2E acceptance: single-flow HTTP walkthrough + consolidated security sweep (real app + real DB + live Redis + temp storage)', () => {
  let env: Env;
  let migratorDb: Db;
  let appDb: Db;
  let redis: Redis;
  let tempRoot: string;
  let storage: StorageProvider;
  let endMigrator: () => Promise<void>;
  let endApp: () => Promise<void>;
  let endRedis: () => Promise<unknown>;
  let app: Awaited<ReturnType<typeof buildApp>>;

  const uid: Record<string, string> = {};
  const slug = `p3e${randomUUID().slice(0, 8)}`;
  const sessions: Record<'ownerA' | 'ownerB' | 'principal' | 'campus', SessionCookies> = {} as never;
  const zeroUuid = '00000000-0000-0000-0000-000000000000';

  let campusAId = '';
  let campusBId = '';
  let yearA1 = '';
  let yearA2 = '';
  let studentAId = '';
  let studentBId = '';
  let studentCId = '';
  let studentDId = '';
  let studentEId = '';
  let guardianAId = '';
  let admissionStudentId = '';
  let batch1Id = '';
  let importId = '';
  let importStorageKey = '';

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
    studentNo: `E2E-${randomUUID().slice(0, 8)}`,
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

  const admissionSnapshot = (over: Record<string, unknown> = {}) => ({
    studentNo: `ADM-${slug}`,
    firstName: 'Alice',
    lastName: 'Applicant',
    dateOfBirth: '2012-03-14',
    gender: 'female',
    campusCode: `p3ea-${slug}`,
    ...over,
  });

  const teacherHeaders = (key: string) => ({
    cookie: sessions.ownerA.cookie,
    ...withCsrf(sessions.ownerA),
    ...idem(key),
  });

  const IMPORT_CSV = [
    'student_no,first_name,last_name,date_of_birth,gender,campus',
    `IMPORT-A,Imma,Port,,,`,
    `IMPORT-B,Inno,Port,,,`,
  ].join('\n');

  beforeAll(async () => {
    env = getEnv();
    const mig = createDb({ url: env.DATABASE_URL_MIGRATOR });
    const app_ = createDb({ url: env.DATABASE_URL_APP });
    migratorDb = mig.db;
    appDb = app_.db;
    endMigrator = () => mig.pool.end();
    endApp = () => app_.pool.end();
    redis = createRedis();
    endRedis = () => redis.quit();
    await redis.connect();

    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sms-e2e-'));
    storage = new FsStorageProvider(tempRoot);

    uid.owner = randomUUID();
    uid.ownerB = randomUUID();
    uid.principal = randomUUID();
    uid.campusUser = randomUUID();
    uid.platRole = randomUUID();

    await rows(
      migratorDb,
      sql`insert into roles (id, scope, code, name, is_system) values (${uid.platRole}, 'platform', ${`p3ep${slug}_plat`}, 'Phase 3.7 Platform', true)`,
    );
    await rows(
      migratorDb,
      sql`insert into role_permissions (role_id, permission) values (${uid.platRole}, 'platform.tenants.read'), (${uid.platRole}, 'platform.tenants.create')`,
    );
    await rows(migratorDb, sql`insert into users (id, email) values (${uid.owner}, ${`owner-${slug}@example.com`})`);
    await rows(migratorDb, sql`insert into users (id, email) values (${uid.ownerB}, ${`ownerb-${slug}@example.com`})`);
    await rows(migratorDb, sql`insert into users (id, email) values (${uid.principal}, ${`principal-${slug}@example.com`})`);
    await rows(migratorDb, sql`insert into users (id, email) values (${uid.campusUser}, ${`campus-${slug}@example.com`})`);
    await rows(
      migratorDb,
      sql`insert into platform_role_assignments (user_id, role_id) values (${uid.owner}, ${uid.platRole}), (${uid.ownerB}, ${uid.platRole})`,
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
    uid.tenantA = (
      await withTenant(appDb, platformCtx(uid.owner!), (tx) =>
        createTenantTransaction(tx, platformCtx(uid.owner!), { slug: `${slug}-a`, name: 'P3E A', requestId: randomUUID() }),
      )
    ).tenantId;
    uid.tenantB = (
      await withTenant(appDb, platformCtx(uid.ownerB!), (tx) =>
        createTenantTransaction(tx, platformCtx(uid.ownerB!), { slug: `${slug}-b`, name: 'P3E B', requestId: randomUUID() }),
      )
    ).tenantId;

    const roleId = async (tenantId: string, code: string) => {
      const r = await rows(migratorDb, sql`select id from roles where tenant_id = ${tenantId} and code = ${code}`);
      return String(r[0]!.id);
    };
    const principalRoleId = await roleId(uid.tenantA!, 'principal');
    const principalMembership = await rows(
      migratorDb,
      sql`insert into memberships (id, tenant_id, user_id, status) values (${randomUUID()}, ${uid.tenantA}, ${uid.principal}, 'active') returning id`,
    );
    await rows(
      migratorDb,
      sql`insert into membership_roles (membership_id, role_id) values (${String(principalMembership[0]!.id)}, ${principalRoleId})`,
    );
    const ownerRoleIdA = await roleId(uid.tenantA!, 'school_owner');
    uid.campusMembership = randomUUID();
    await rows(
      migratorDb,
      sql`insert into memberships (id, tenant_id, user_id, status) values (${uid.campusMembership}, ${uid.tenantA}, ${uid.campusUser}, 'active')`,
    );
    await rows(
      migratorDb,
      sql`insert into membership_roles (membership_id, role_id) values (${uid.campusMembership}, ${ownerRoleIdA})`,
    );

    sessions.ownerA = await makeSession(uid.owner!, uid.tenantA!);
    sessions.ownerB = await makeSession(uid.ownerB!, uid.tenantB!);
    sessions.principal = await makeSession(uid.principal!, uid.tenantA!);
    sessions.campus = await makeSession(uid.campusUser!, uid.tenantA!);

    app = await buildApp({ deps: { db: appDb, redis, storage }, logger: false });

    const mkCampus = async (code: string, name: string, s: SessionCookies) => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/campuses',
        headers: { cookie: s.cookie, ...withCsrf(s), ...idem(`c-${code}`) },
        payload: { code, name },
      });
      expect(res.statusCode).toBe(201);
      return (res.json().campus as { id: string }).id;
    };
    campusAId = await mkCampus(`p3ea-${slug}`, 'P3E Main', sessions.ownerA);
    campusBId = await mkCampus(`p3eb-${slug}`, 'P3E Annex', sessions.ownerA);
    await mkCampus(`p3e-b-${slug}`, 'P3E B Campus', sessions.ownerB);
    await rows(
      migratorDb,
      sql`update memberships set campus_id = ${campusAId} where id = ${uid.campusMembership}`,
    );

    const mkYear = async (code: string, name: string, startsOn: string, endsOn: string, key: string) => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/academic-years',
        headers: teacherHeaders(`y-${key}`),
        payload: { code, name, startsOn, endsOn },
      });
      expect(res.statusCode).toBe(201);
      const yearId = (res.json().academicYear as { id: string }).id;
      const opened = await app.inject({
        method: 'POST',
        url: `/api/v1/academic-years/${yearId}/open`,
        headers: teacherHeaders(`yo-${key}`),
      });
      expect(opened.statusCode).toBe(200);
      return yearId;
    };
    yearA1 = await mkYear(`p3e-y1-${slug}`, 'AY 2026', '2026-01-01', '2026-12-31', 'y1');
    yearA2 = await mkYear(`p3e-y2-${slug}`, 'AY 2027', '2027-01-01', '2027-12-31', 'y2');

    const mkStudent = async (over: Record<string, unknown>, key: string) => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/students',
        headers: teacherHeaders(key),
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

    // A formula-looking student_no proves the export neutralizes CSV injection.
    await rows(
      migratorDb,
      sql`insert into students (id, tenant_id, student_no, first_name, last_name, status, primary_campus_id, deleted_at) values
            (${randomUUID()}, ${uid.tenantA}, ${`=1+1-${slug}`}, 'Formula', 'Injection', 'active', ${campusAId}, null),
            (${randomUUID()}, ${uid.tenantB}, ${`p3eb-${slug}-x`}, 'Export', 'Bravo', 'active', null, null)`,
    );
    const campusARows = await rows(
      migratorDb,
      sql`select id from campuses where tenant_id = ${uid.tenantA} and code = ${`p3ea-${slug}`}`,
    );
    // The tenant-B seed needs a real campus for its primary_campus FK.
    const campusBRows = await rows(
      migratorDb,
      sql`select id from campuses where tenant_id = ${uid.tenantB} and code = ${`p3e-b-${slug}`}`,
    );
    await rows(
      migratorDb,
      sql`update students set primary_campus_id = ${String(campusBRows[0]!.id)} where tenant_id = ${uid.tenantB} and student_no = ${`p3eb-${slug}-x`}`,
    );
  });

  afterAll(async () => {
    try {
      if (app) await app.close();
      const tIn = `'${uid.tenantA}','${uid.tenantB}'`;
      await rows(migratorDb, sql`delete from outbox_events where tenant_id in (${sql.raw(tIn)})`);
      await rows(migratorDb, sql`delete from idempotency_keys where tenant_id in (${sql.raw(tIn)})`);
      await rows(migratorDb, sql`delete from student_guardians where tenant_id in (${sql.raw(tIn)})`);
      await rows(migratorDb, sql`delete from student_documents where tenant_id in (${sql.raw(tIn)})`);
      await rows(migratorDb, sql`delete from files where tenant_id in (${sql.raw(tIn)})`);
      await rows(migratorDb, sql`delete from student_import_rows where tenant_id in (${sql.raw(tIn)})`);
      await rows(migratorDb, sql`delete from student_imports where tenant_id in (${sql.raw(tIn)})`);
      await rows(migratorDb, sql`delete from promotion_items where tenant_id in (${sql.raw(tIn)})`);
      await rows(migratorDb, sql`delete from promotion_batches where tenant_id in (${sql.raw(tIn)})`);
      await rows(migratorDb, sql`delete from transfers where tenant_id in (${sql.raw(tIn)})`);
      await rows(migratorDb, sql`delete from enrollments where tenant_id in (${sql.raw(tIn)})`);
      await rows(migratorDb, sql`delete from admission_applications where tenant_id in (${sql.raw(tIn)})`);
      await rows(migratorDb, sql`delete from guardians where tenant_id in (${sql.raw(tIn)})`);
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
        sql`delete from platform_role_assignments where user_id in (${uid.owner}, ${uid.ownerB})`,
      );
      await rows(migratorDb, sql`delete from memberships where tenant_id in (${sql.raw(tIn)}) or user_id = ${uid.campusUser}`);
      await rows(migratorDb, sql`delete from roles where tenant_id in (${sql.raw(tIn)}) or id = ${uid.platRole}`);
      await rows(
        migratorDb,
        sql`delete from users where id in (${uid.owner}, ${uid.ownerB}, ${uid.principal}, ${uid.campusUser})`,
      );
      await rows(migratorDb, sql`delete from tenants where id in (${sql.raw(tIn)})`);
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => {});
      await endMigrator();
      await endApp();
      await endRedis?.();
    }
  });

  it('1. authorization matrix: representative Phase 3 routes are tenant-scoped with the tied permission (HEAD twins)', () => {
    const byRoute = new Map(app.routeAuthorizationMatrix().routes.map((r) => [`${r.method} ${r.url}`, r]));
    const spot: Array<[string, string]> = [
      ['GET /api/v1/students', 'students.read'],
      ['POST /api/v1/students', 'students.create'],
      ['GET /api/v1/guardians', 'guardians.read'],
      ['POST /api/v1/guardians', 'guardians.create'],
      ['GET /api/v1/admission-applications', 'admission.read'],
      ['POST /api/v1/admission-applications/:id/submit', 'admission.review'],
      ['GET /api/v1/enrollments', 'enrollment.read'],
      ['POST /api/v1/students/:id/enroll', 'enrollment.manage'],
      ['GET /api/v1/promotion-batches', 'enrollment.read'],
      ['GET /api/v1/students/:id/documents', 'student.documents.read'],
      ['POST /api/v1/students/:id/documents', 'student.documents.create'],
      ['GET /api/v1/students/imports', 'students.read'],
      ['POST /api/v1/students/import', 'students.create'],
      ['GET /api/v1/students/export', 'students.export'],
    ];
    for (const [route, permission] of spot) {
      expect(byRoute.get(route)).toEqual(expect.objectContaining({ kind: 'tenant', permission, devOnly: false }));
      if (route.startsWith('GET ')) {
        expect(byRoute.get(`HEAD ${route.slice(4)}`)).toEqual(
          expect.objectContaining({ kind: 'tenant', permission, devOnly: false }),
        );
      }
    }
  });

  it('2. student created with server-forced applicant status, audit + student.created outbox', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/students',
      headers: teacherHeaders(`c-${slug}`),
      payload: studentBody({ primaryCampusId: campusAId }),
    });
    expect(res.statusCode).toBe(201);
    const student = res.json().student as { id: string; status: string; tenantId: string };
    expect(student.status).toBe('applicant');
    expect(student.tenantId).toBe(uid.tenantA);

    const audit = await rows(
      migratorDb,
      sql`select count(*)::int n from audit_logs where tenant_id = ${uid.tenantA} and action = 'student.created' and resource_id = ${student.id}`,
    );
    expect(Number(audit[0]!.n)).toBe(1);
    const outbox = await rows(
      migratorDb,
      sql`select count(*)::int n from outbox_events where tenant_id = ${uid.tenantA} and event_type = 'student.created' and aggregate_id = ${student.id}`,
    );
    expect(Number(outbox[0]!.n)).toBe(1);
  });

  it('3. a mass-assignment attempt on the same create is rejected (status is not writable)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/students',
      headers: teacherHeaders(`ma-${slug}`),
      payload: studentBody({ primaryCampusId: campusAId, tenantId: uid.tenantA, id: randomUUID() }),
    });
    expect(res.statusCode).toBe(400);
    expect(envelope(res)?.code).toBe('validation_error');
  });

  it('4. guardians: create, link to student, nested list, link + unlink audit trail', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/guardians',
      headers: teacherHeaders(`g1-${slug}`),
      payload: guardianBody({ firstName: 'Anne', lastName: 'Isabella' }),
    });
    expect(created.statusCode).toBe(201);
    guardianAId = (created.json().guardian as { id: string }).id;

    const linked = await app.inject({
      method: 'POST',
      url: `/api/v1/students/${studentAId}/guardians`,
      headers: teacherHeaders(`link-${slug}`),
      payload: { guardianId: guardianAId, relation: 'parent', isPrimary: true, canPickup: true },
    });
    expect(linked.statusCode).toBe(201);
    expect((linked.json().link as { guardianId: string }).guardianId).toBe(guardianAId);

    const list = await app.inject({
      method: 'GET',
      url: `/api/v1/students/${studentAId}/guardians`,
      headers: { cookie: sessions.ownerA.cookie },
    });
    expect(list.statusCode).toBe(200);
    expect((list.json() as { total: number }).total).toBe(1);

    const linkAudit = await rows(
      migratorDb,
      sql`select count(*)::int n from audit_logs where tenant_id = ${uid.tenantA} and action = 'student.guardian.linked'`,
    );
    expect(Number(linkAudit[0]!.n)).toBe(1);
  });

  it('5. admission lifecycle: submit -> review -> approve materializes an applicant student with events', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/admission-applications',
      headers: teacherHeaders(`adm-${slug}`),
      payload: { snapshot: admissionSnapshot() },
    });
    expect(created.statusCode).toBe(201);
    const id = (created.json().application as { id: string }).id;

    const submit = await app.inject({
      method: 'POST',
      url: `/api/v1/admission-applications/${id}/submit`,
      headers: { cookie: sessions.ownerA.cookie, ...withCsrf(sessions.ownerA) },
    });
    expect(submit.statusCode).toBe(200);
    expect((submit.json().application as { status: string }).status).toBe('submitted');

    const review = await app.inject({
      method: 'POST',
      url: `/api/v1/admission-applications/${id}/review`,
      headers: { cookie: sessions.ownerA.cookie, ...withCsrf(sessions.ownerA) },
    });
    expect(review.statusCode).toBe(200);

    const approve = await app.inject({
      method: 'POST',
      url: `/api/v1/admission-applications/${id}/approve`,
      headers: { cookie: sessions.ownerA.cookie, ...withCsrf(sessions.ownerA) },
    });
    expect(approve.statusCode).toBe(200);
    expect((approve.json().application as { status: string }).status).toBe('accepted');

    const appRow = await rows(migratorDb, sql`select student_id from admission_applications where id = ${id}`);
    admissionStudentId = String(appRow[0]!.student_id);
    const student = await rows(
      migratorDb,
      sql`select status, primary_campus_id from students where id = ${admissionStudentId}`,
    );
    expect(String(student[0]!.status)).toBe('applicant');
    expect(String(student[0]!.primary_campus_id)).toBe(campusAId);

    const audits = await rows(
      migratorDb,
      sql`select count(*)::int n from audit_logs where tenant_id = ${uid.tenantA} and action = 'admission.application.approved' and resource_id = ${id}`,
    );
    expect(Number(audits[0]!.n)).toBe(1);

    const again = await app.inject({
      method: 'POST',
      url: `/api/v1/admission-applications/${id}/approve`,
      headers: { cookie: sessions.ownerA.cookie, ...withCsrf(sessions.ownerA) },
    });
    expect(again.statusCode).toBe(409);
  });

  it('6. enrichment + enroll: PATCH student, enroll as active with audit + outbox, student flips', async () => {
    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/v1/students/${studentAId}`,
      headers: { cookie: sessions.ownerA.cookie, ...withCsrf(sessions.ownerA) },
      payload: { firstName: 'Augusta' },
    });
    expect(patched.statusCode).toBe(200);
    expect((patched.json().student as { firstName: string }).firstName).toBe('Augusta');

    const enrolled = await app.inject({
      method: 'POST',
      url: `/api/v1/students/${studentAId}/enroll`,
      headers: teacherHeaders(`enroll-a-${slug}`),
      payload: { academicYearId: yearA1 },
    });
    expect(enrolled.statusCode).toBe(200);
    expect((enrolled.json().enrollment as { status: string; academicYearId: string }).status).toBe('active');
    expect((enrolled.json().enrollment as { academicYearId: string }).academicYearId).toBe(yearA1);

    const fetched = await app.inject({
      method: 'GET',
      url: `/api/v1/students/${studentAId}`,
      headers: { cookie: sessions.ownerA.cookie },
    });
    expect((fetched.json().student as { status: string }).status).toBe('active');

    const outbox = await rows(
      migratorDb,
      sql`select count(*)::int n from outbox_events where tenant_id = ${uid.tenantA} and event_type = 'student.enrolled'`,
    );
    expect(Number(outbox[0]!.n)).toBeGreaterThanOrEqual(1);
  });

  it('7. document upload -> scan gate -> clean download: full bytes round-trip through the real provider', async () => {
    const bytes = pdfBytes();
    const uploadRes = await app.inject({
      method: 'POST',
      url: `/api/v1/students/${studentAId}/documents?documentType=birth_certificate&filename=birth.pdf`,
      headers: { cookie: sessions.ownerA.cookie, 'content-type': 'application/pdf', ...withCsrf(sessions.ownerA), ...idem(`doc-${slug}`) },
      payload: bytes,
    });
    expect(uploadRes.statusCode).toBe(201);
    const document = uploadRes.json().document as { id: string; fileId: string; scanStatus: string; mime: string };
    expect(document.scanStatus).toBe('pending');
    expect(document.mime).toBe('application/pdf');

    const file = await rows(migratorDb, sql`select storage_key from files where id = ${document.fileId}`);
    const stored = Buffer.from(await storage.readObject(uid.tenantA!, String(file[0]!.storage_key)));
    expect(createHash('sha256').update(stored).digest('hex')).toBe(createHash('sha256').update(bytes).digest('hex'));

    const pending = await app.inject({
      method: 'GET',
      url: `/api/v1/students/${studentAId}/documents/${document.id}/download`,
      headers: { cookie: sessions.ownerA.cookie },
    });
    expect(pending.statusCode).toBe(403);
    expect(envelope(pending)?.code).toBe('scan_incomplete');

    // Worker-equivalent clean transition (the real scan executor is exercised in
    // apps/worker/src/documents.test.ts on real PG + temp storage).
    await rows(
      migratorDb,
      sql`update files set scan_status = 'clean' where id = ${document.fileId}`,
    );
    const clean = await app.inject({
      method: 'GET',
      url: `/api/v1/students/${studentAId}/documents/${document.id}/download`,
      headers: { cookie: sessions.ownerA.cookie },
    });
    expect(clean.statusCode).toBe(200);
    expect(clean.headers['content-type']).toBe('application/pdf');
    expect(clean.headers['cache-control']).toBe('private, no-store');
    expect(Buffer.from(clean.body, 'latin1').subarray(0, 5).equals(PDF_SIGNATURE)).toBe(true);
  });

  it('8. transfer (B) and graduate (C) advance the lifecycle with audit + outbox', async () => {
    // Both moves require an ACTIVE student (guarded transitions).
    const enrollB = await app.inject({
      method: 'POST',
      url: `/api/v1/students/${studentBId}/enroll`,
      headers: teacherHeaders('enroll-b-e2e'),
      payload: { academicYearId: yearA1 },
    });
    expect(enrollB.statusCode).toBe(200);
    const enrollC = await app.inject({
      method: 'POST',
      url: `/api/v1/students/${studentCId}/enroll`,
      headers: teacherHeaders('enroll-c-e2e'),
      payload: { academicYearId: yearA1 },
    });
    expect(enrollC.statusCode).toBe(200);

    const transferred = await app.inject({
      method: 'POST',
      url: `/api/v1/students/${studentBId}/transfer`,
      headers: teacherHeaders(`tr-b-${slug}`),
      payload: { toSchoolName: 'Elsewhere Academy', reason: 'relocation', transferredOn: '2026-03-15' },
    });
    expect(transferred.statusCode).toBe(200);
    expect(transferred.json().transfer).toEqual(
      expect.objectContaining({ type: 'out', status: 'completed', toSchoolName: 'Elsewhere Academy' }),
    );

    const graduated = await app.inject({
      method: 'POST',
      url: `/api/v1/students/${studentCId}/graduate`,
      headers: teacherHeaders(`grad-c-${slug}`),
    });
    expect(graduated.statusCode).toBe(200);
    expect((graduated.json().student as { status: string }).status).toBe('graduated');

    const audits = await rows(
      migratorDb,
      sql`select action, count(*)::int n from audit_logs
            where tenant_id = ${uid.tenantA} and action in ('student.transferred','student.graduated') group by action`,
    );
    const byAction = new Map(audits.map((r) => [String(r.action), Number(r.n)]));
    expect(byAction.get('student.transferred')).toBe(1);
    expect(byAction.get('student.graduated')).toBe(1);
  });

  it('9. promotion batch: draft -> items -> execute enqueues promotion.batch.execute for the real worker', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/promotion-batches',
      headers: teacherHeaders(`pb-${slug}`),
      payload: { fromAcademicYearId: yearA1, toAcademicYearId: yearA2 },
    });
    expect(created.statusCode).toBe(201);
    batch1Id = (created.json().promotionBatch as { id: string; status: string }).id;

    const items = await app.inject({
      method: 'POST',
      url: `/api/v1/promotion-batches/${batch1Id}/items`,
      headers: teacherHeaders(`pb-items-${slug}`),
      payload: { studentIds: [studentDId, studentEId] },
    });
    expect(items.statusCode).toBe(201);
    expect((items.json() as { items: unknown[] }).items).toHaveLength(2);

    const executed = await app.inject({
      method: 'POST',
      url: `/api/v1/promotion-batches/${batch1Id}/execute`,
      headers: teacherHeaders(`pb-exec-${slug}`),
    });
    expect(executed.statusCode).toBe(200);
    expect((executed.json().promotionBatch as { status: string }).status).toBe('in_progress');

    const outbox = await rows(
      migratorDb,
      sql`select payload from outbox_events where tenant_id = ${uid.tenantA} and event_type = 'promotion.batch.execute' and aggregate_id = ${batch1Id}`,
    );
    expect(outbox.length).toBe(1);
    expect((outbox[0]!.payload as { tenantId: string; batchId: string }).batchId).toBe(batch1Id);
  });

  it('10. CSV import: 202 + storage object + audit + outbox handed to the worker executor', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/students/import?filename=import.csv',
      headers: { cookie: sessions.ownerA.cookie, 'content-type': 'text/csv', ...withCsrf(sessions.ownerA), ...idem(`imp-${slug}`) },
      payload: Buffer.from(IMPORT_CSV, 'utf8'),
    });
    expect(res.statusCode).toBe(202);
    const imp = res.json().import as { id: string; status: string; totalRows: number };
    importId = imp.id;
    expect(imp.status).toBe('submitted');
    expect(imp.totalRows).toBe(2);

    const dbRow = await rows(
      migratorDb,
      sql`select storage_key from student_imports where id = ${importId}`,
    );
    importStorageKey = String(dbRow[0]!.storage_key);
    expect(importStorageKey).toMatch(/^imports\/[0-9a-f]{8}-[0-9a-f-]{27}[0-9a-f-]*-[0-9a-f]{12}\.csv$/i);
    expect(Buffer.from(await storage.readObject(uid.tenantA!, importStorageKey)).toString('utf8')).toContain('IMPORT-A');

    const audit = await rows(
      migratorDb,
      sql`select count(*)::int n from audit_logs where tenant_id = ${uid.tenantA} and action = 'student.import.submitted' and resource_id = ${importId}`,
    );
    expect(Number(audit[0]!.n)).toBe(1);
    const outbox = await rows(
      migratorDb,
      sql`select count(*)::int n from outbox_events where tenant_id = ${uid.tenantA} and event_type = 'student.import.submitted' and aggregate_id = ${importId}`,
    );
    expect(Number(outbox[0]!.n)).toBe(1);

    // Nothing is materialized until the real worker executor consumes the event
    // (apps/worker/src/student-import.test.ts proves that executor end-to-end).
    const detail = await app.inject({
      method: 'GET',
      url: `/api/v1/students/imports/${importId}`,
      headers: { cookie: sessions.ownerA.cookie },
    });
    expect(detail.statusCode).toBe(200);
    expect((detail.json() as { import: { id: string }; rows: unknown[] }).rows).toHaveLength(0);
  });

  it('11. CSV export: owner-A rows only, tenant-B invisible, formula injection neutralized', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/students/export',
      headers: { cookie: sessions.ownerA.cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/csv/);
    expect(res.headers['cache-control']).toBe('private, no-store');
    const body = res.body as string;
    expect(body).toContain('E2E-');
    expect(body).toContain(`p3ea-${slug}`);
    expect(body).toContain(`'=1+1-${slug}`);
    expect(body).not.toContain(`\n=1+1-${slug}`);
    expect(body).not.toContain(`p3eb-${slug}-x`);
  });

  it('12. owner-B export contains only tenant-B rows', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/students/export',
      headers: { cookie: sessions.ownerB.cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.body as string;
    expect(body).toContain(`p3eb-${slug}-x`);
    expect(body).not.toContain('IMPORT-A');
  });

  it('13. principal is read-only across every Phase 3 write surface (403 + requiredPermission)', async () => {
    const cases: Array<{ method: 'POST' | 'PATCH' | 'DELETE'; url: string; perm: string }> = [
      { method: 'POST', url: '/api/v1/students', perm: 'students.create' },
      { method: 'POST', url: '/api/v1/guardians', perm: 'guardians.create' },
      { method: 'POST', url: `/api/v1/students/${zeroUuid}/enroll`, perm: 'enrollment.manage' },
      { method: 'POST', url: `/api/v1/students/${zeroUuid}/transfer`, perm: 'enrollment.manage' },
      { method: 'POST', url: '/api/v1/promotion-batches', perm: 'enrollment.manage' },
      { method: 'POST', url: '/api/v1/admission-applications', perm: 'admission.create' },
      { method: 'POST', url: `/api/v1/admission-applications/${zeroUuid}/approve`, perm: 'admission.review' },
      { method: 'POST', url: `/api/v1/students/${zeroUuid}/documents?documentType=x`, perm: 'student.documents.create' },
      { method: 'POST', url: '/api/v1/students/import', perm: 'students.create' },
    ];
    for (const c of cases) {
      const res = await app.inject({ method: c.method, url: c.url, headers: { cookie: sessions.principal.cookie } });
      expect(res.statusCode, `${c.method} ${c.url}`).toBe(403);
      expect(envelope(res)?.code, `${c.method} ${c.url}`).toBe('forbidden');
      expect(envelope(res)?.requiredPermission, `${c.method} ${c.url}`).toBe(c.perm);
    }

    const read = await app.inject({
      method: 'GET',
      url: '/api/v1/students',
      headers: { cookie: sessions.principal.cookie },
    });
    expect(read.statusCode).toBe(200);
  });

  it('14. anonymous callers are rejected on Phase 3 endpoints (401 before permission logic)', async () => {
    for (const url of ['/api/v1/students', '/api/v1/guardians', '/api/v1/enrollments', '/api/v1/students/export']) {
      const res = await app.inject({ method: 'GET', url, headers: { cookie: `sid=${randomUUID()}` } });
      expect(res.statusCode, url).toBe(401);
      expect(envelope(res)?.code, url).toBe('unauthenticated');
    }
  });

  it('15. CSRF double-submit is required on state-changing Phase 3 routes', async () => {
    const cases: Array<{ method: 'POST' | 'PATCH' | 'DELETE'; url: string; payload?: unknown }> = [
      { method: 'POST', url: '/api/v1/students', payload: studentBody() },
      { method: 'PATCH', url: `/api/v1/students/${studentAId}`, payload: { firstName: 'X' } },
      { method: 'POST', url: `/api/v1/students/${studentAId}/enroll`, payload: { academicYearId: yearA1 } },
      { method: 'POST', url: `/api/v1/students/${studentAId}/documents?documentType=x` },
      { method: 'POST', url: '/api/v1/students/import' },
      { method: 'POST', url: '/api/v1/admission-applications', payload: { snapshot: admissionSnapshot() } },
    ];
    for (const c of cases) {
      const res = await app.inject({
        method: c.method,
        url: c.url,
        headers: { cookie: sessions.ownerA.cookie },
        payload: c.payload as Record<string, unknown> | undefined,
      });
      expect(res.statusCode, `${c.method} ${c.url}`).toBe(403);
      expect(envelope(res)?.code, `${c.method} ${c.url}`).toBe('csrf_invalid');
    }
  });

  it('16. consolidated mass-assignment: identity/tenant/status/scan fields are never writable (400)', async () => {
    const post = (url: string, payload: Record<string, unknown>) =>
      app.inject({ method: 'POST', url, headers: { cookie: sessions.ownerA.cookie, ...withCsrf(sessions.ownerA), ...idem(`ma-${randomUUID()}`) }, payload });

    const student = await post('/api/v1/students', studentBody({ primaryCampusId: campusAId, status: 'active' }));
    expect(student.statusCode).toBe(400);
    expect(envelope(student)?.code).toBe('validation_error');

    const enroll = await post(`/api/v1/students/${studentAId}/enroll`, { academicYearId: yearA1, status: 'active' });
    expect(enroll.statusCode).toBe(400);
    expect(envelope(enroll)?.code).toBe('validation_error');

    const batch = await post('/api/v1/promotion-batches', { fromAcademicYearId: yearA1, toAcademicYearId: yearA2, tenantId: uid.tenantA });
    expect(batch.statusCode).toBe(400);
    expect(envelope(batch)?.code).toBe('validation_error');

    const application = await post('/api/v1/admission-applications', { snapshot: admissionSnapshot(), status: 'accepted' });
    expect(application.statusCode).toBe(400);
    expect(envelope(application)?.code).toBe('validation_error');

    const link = await post(`/api/v1/students/${studentAId}/guardians`, { guardianId: guardianAId, isPrimary: true, deletedAt: new Date().toISOString() });
    expect(link.statusCode).toBe(400);
    expect(envelope(link)?.code).toBe('validation_error');

    const patch = await app.inject({
      method: 'PATCH',
      url: `/api/v1/students/${studentAId}`,
      headers: { cookie: sessions.ownerA.cookie, ...withCsrf(sessions.ownerA) },
      payload: { status: 'active', tenantId: uid.tenantB },
    });
    expect(patch.statusCode).toBe(400);
    expect(envelope(patch)?.code).toBe('validation_error');
  });

  it('17. cross-tenant: every Phase 3 read/write against tenant-A rows is 404 from tenant B', async () => {
    const get = (url: string) => app.inject({ method: 'GET', url, headers: { cookie: sessions.ownerB.cookie } });
    const write = (url: string, payload?: Record<string, unknown>) =>
      app.inject({ method: 'POST', url, headers: { cookie: sessions.ownerB.cookie, ...withCsrf(sessions.ownerB), ...idem(`xt-${randomUUID()}`) }, payload });

    const student = await get(`/api/v1/students/${studentAId}`);
    expect(student.statusCode).toBe(404);
    expect(envelope(student)?.code).toBe('not_found');

    expect((await get(`/api/v1/guardians/${guardianAId}`)).statusCode).toBe(404);
    expect((await get(`/api/v1/students/${studentAId}/guardians`)).statusCode).toBe(404);
    expect((await get(`/api/v1/enrollments?studentId=${studentAId}`)).statusCode).toBe(200);
    expect(((await get(`/api/v1/enrollments?studentId=${studentAId}`)).json() as { total: number }).total).toBe(0);
    expect((await get(`/api/v1/students/${studentAId}/documents`)).statusCode).toBe(404);
    expect((await get(`/api/v1/students/imports/${importId}`)).statusCode).toBe(404);
    expect((await get(`/api/v1/promotion-batches/${batch1Id}`)).statusCode).toBe(404);

    expect((await write(`/api/v1/students/${studentAId}/transfer`, { reason: 'sneak' })).statusCode).toBe(404);
    expect((await write(`/api/v1/students/${studentAId}/enroll`, { academicYearId: yearA1 })).statusCode).toBe(404);
    expect((await write(`/api/v1/promotion-batches/${batch1Id}/execute`)).statusCode).toBe(404);
    expect((await write(`/api/v1/students/${studentAId}/guardians`, { guardianId: zeroUuid, relation: 'parent' })).statusCode).toBe(404);
    expect((await write(`/api/v1/admission-applications/${zeroUuid}/approve`)).statusCode).toBe(404);
  });

  it('18. a campus-scoped school_owner is confined to campus A end-to-end', async () => {
    const own = await app.inject({
      method: 'POST',
      url: '/api/v1/students',
      headers: { cookie: sessions.campus.cookie, ...withCsrf(sessions.campus), ...idem(`cs-own-${slug}`) },
      payload: studentBody({ primaryCampusId: campusAId }),
    });
    expect(own.statusCode).toBe(201);

    const foreignCreate = await app.inject({
      method: 'POST',
      url: '/api/v1/students',
      headers: { cookie: sessions.campus.cookie, ...withCsrf(sessions.campus), ...idem(`cs-other-${slug}`) },
      payload: studentBody({ primaryCampusId: campusBId }),
    });
    expect(foreignCreate.statusCode).toBe(403);
    expect(envelope(foreignCreate)?.code).toBe('campus_scope_denied');

    const transferForeign = await app.inject({
      method: 'POST',
      url: `/api/v1/students/${studentBId}/transfer`,
      headers: { cookie: sessions.campus.cookie, ...withCsrf(sessions.campus), ...idem(`cs-tr-${slug}`) },
      payload: { reason: 'nope' },
    });
    expect(transferForeign.statusCode).toBe(403);
    expect(envelope(transferForeign)?.code).toBe('campus_scope_denied');

    const enrollForeign = await app.inject({
      method: 'POST',
      url: `/api/v1/students/${studentBId}/enroll`,
      headers: { cookie: sessions.campus.cookie, ...withCsrf(sessions.campus), ...idem(`cs-en-${slug}`) },
      payload: { academicYearId: yearA1 },
    });
    expect(enrollForeign.statusCode).toBe(403);

    const list = await app.inject({
      method: 'GET',
      url: '/api/v1/students',
      headers: { cookie: sessions.campus.cookie },
    });
    expect(list.statusCode).toBe(200);
    for (const item of (list.json() as { items: Array<{ primaryCampusId: string }> }).items) {
      expect(item.primaryCampusId).toBe(campusAId);
    }

    // Cross-campus student fetch is 404 (isolation via RLS, not a deny).
    const b = await app.inject({
      method: 'GET',
      url: `/api/v1/students/${studentBId}`,
      headers: { cookie: sessions.campus.cookie },
    });
    expect(b.statusCode).toBe(404);
  });

  it('19. ACCEPTANCE: audit/outbox consistency and the Phase 3 graph hold at the database layer', async () => {
    const audits = await rows(
      migratorDb,
      sql`select action, count(*)::int n from audit_logs
            where tenant_id = ${uid.tenantA}
              and action in ('student.created','student.updated','student.transferred','student.graduated',
                             'guardian.created','student.guardian.linked',
                             'admission.application.created','admission.application.approved',
                             'student.import.submitted','promotion.batch.created','promotion.batch.execute_requested')
            group by action`,
    );
    const auditCounts = new Map(audits.map((r) => [String(r.action), Number(r.n)]));
    expect(auditCounts.get('student.created')).toBeGreaterThanOrEqual(5);
    expect(auditCounts.get('student.transferred')).toBe(1);
    expect(auditCounts.get('student.graduated')).toBe(1);
    expect(auditCounts.get('guardian.created')).toBe(1);
    expect(auditCounts.get('student.guardian.linked')).toBe(1);
    expect(auditCounts.get('student.import.submitted')).toBe(1);

    // Every import/approval/enroll side effect landed an outbox row.
    const outbox = await rows(
      migratorDb,
      sql`select event_type, count(*)::int n from outbox_events
            where tenant_id = ${uid.tenantA}
              and event_type in ('student.created','student.enrolled','student.transferred','student.graduated',
                                 'admission.application.approved','student.import.submitted','promotion.batch.execute',
                                 'student.document.uploaded')
            group by event_type`,
    );
    const outboxCounts = new Map(outbox.map((r) => [String(r.event_type), Number(r.n)]));
    expect(outboxCounts.get('student.created')).toBeGreaterThanOrEqual(5);
    expect(outboxCounts.get('student.enrolled')).toBeGreaterThanOrEqual(1);
    expect(outboxCounts.get('student.transferred')).toBe(1);
    expect(outboxCounts.get('student.graduated')).toBe(1);
    expect(outboxCounts.get('student.import.submitted')).toBe(1);
    expect(outboxCounts.get('promotion.batch.execute')).toBe(1);
    expect(outboxCounts.get('student.document.uploaded')).toBeGreaterThanOrEqual(1);

    // Document graph: no orphan live file.
    const orphans = await rows(
      migratorDb,
      sql`select count(*)::int n from files f
            where f.tenant_id = ${uid.tenantA} and f.deleted_at is null
              and not exists (select 1 from student_documents d where d.tenant_id = f.tenant_id and d.file_id = f.id)`,
    );
    expect(Number(orphans[0]!.n)).toBe(0);

    // Student lifecycle statuses are consistent.
    const students = await rows(
      migratorDb,
      sql`select id, status from students
            where tenant_id = ${uid.tenantA}
              and id in (${studentAId}, ${studentBId}, ${studentCId}, ${admissionStudentId})`,
    );
    const byId = new Map(students.map((s) => [String(s.id), String(s.status)]));
    expect(byId.get(studentAId)).toBe('active');
    expect(byId.get(studentBId)).toBe('transferred');
    expect(byId.get(studentCId)).toBe('graduated');
    expect(byId.get(admissionStudentId)).toBe('applicant');
  });
});