import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { getEnv } from '@sms/config';
import { createDb, withTenant, type Db } from '@sms/db';
import { reportCardPreviewResponseSchema } from '@sms/contracts';
import {
  publishReportCardWithSnapshot,
  type ReportCardClient,
} from '@sms/db/src/testing/publish-card.js';
import type { RequestContext } from '@sms/core';
import type { StorageProvider } from '@sms/storage';
import { writeSession, type RedisSession } from '@sms/auth';
import { createRedis } from '@sms/redis';
import { buildApp } from '../app.js';
import { createTenantTransaction } from '../routes/tenants.js';
import { mapDomainError } from '../routes/school/util.js';

/**
 * Phase 6 API acceptance — the roadmap's own acceptance line:
 * "Full cycle class -> exam -> marks -> publish -> parent sees results; illegal
 * mark edit blocked at DB trigger", plus "authz (teacher cannot publish)",
 * "mark bounds" and "result data parent-scoped".
 *
 * Proves, against the real app + real PostgreSQL + live Redis:
 *   A. Route gate: a session + tenant context is required, and `exams.publish` /
 *      `exams.correct` are separate grants from `exams.read`.
 *   B. Lifecycle: draft -> scheduled -> grading -> published through the API,
 *      with `published` unreachable from the status endpoint at all.
 *   C. Mark entry: a teacher may only mark their OWN class subject; a second
 *      teacher and a parent are both refused the gradebook; bounds are enforced.
 *   D. Publish immutability: after publication a mark cannot be edited through
 *      the API, and a DIRECT SQL UPDATE of a published mark is refused by the
 *      0015 trigger unless a matching mark_corrections row precedes it.
 *   E. Correction workflow: `exams.correct` records the correction, flips the
 *      mark to `rechecked`, and audits it.
 *   F. Parent scope: a parent sees only their own child's published results;
 *      another family's child is 403 on the transcript and absent from the
 *      portal; an unpublished exam is invisible to a family.
 *   G. Isolation: tenant B cannot see tenant A's exam, its subjects, or a student
 *      transcript — a cross-tenant probe is a 404, whereas a parent probing
 *      another family's child is a 403, so the two denials never blur.
 *
 * 29 cases. Opt-in: RUN_RUNTIME_SECURITY_TESTS=1. Set P6_DEBUG_LOG=1 to see the
 * app's own request log while debugging a failure.
 */
const enabled = process.env.RUN_RUNTIME_SECURITY_TESTS === '1';
const describeDb = enabled ? describe : describe.skip;

const stubStorage = {
  async readObject(): Promise<Buffer> {
    throw new Error('not consulted in Phase 6 acceptance');
  },
  async getDownloadUrl(): Promise<string> {
    return 'https://example.invalid/report-card.pdf';
  },
} as unknown as StorageProvider;

interface SessionCookies {
  token: string;
  csrf: string;
  cookie: string;
}

describeDb('API Phase 6 exams & results acceptance (real app + DB + Redis)', () => {
  let migratorDb: Db;
  let appDb: Db;
  /**
   * A raw `pg.Client` on the migrator pool. The shared report-card fixture helper
   * speaks parameterised `$1` SQL against a `pg.Client`, while the rest of this
   * suite goes through drizzle. Held for the whole run and released with the pool.
   */
  let migratorClient: ReportCardClient & { release(): void };
  let redis: Redis;
  let endMigrator: () => Promise<void>;
  let endApp: () => Promise<void>;
  let endRedis: () => Promise<unknown>;
  let app: Awaited<ReturnType<typeof buildApp>>;

  const uid: Record<string, string> = {};
  const slug = `p6${randomUUID().slice(0, 8)}`;
  const sessions: Record<'owner' | 'principal' | 'teacher' | 'otherTeacher' | 'parent' | 'otherParent' | 'reader' | 'insider', SessionCookies> =
    {} as never;

  let tenantAId = '';
  let tenantBId = '';
  let campusAId = '';
  let yearAId = '';
  let termAId = '';
  let classAId = '';
  let classBId = '';
  let campusBId = '';
  let yearBId = '';
  let classSubjectAId = '';

  let child = ''; // linked to uid.parent
  let otherChild = ''; // a second family's child
  let foreignStudent = ''; // tenant B

  let examTypeId = '';
  let scaleId = '';
  let examId = '';
  let examSubjectMathId = '';
  let markId = '';

  const rows = async (db: Db, q: ReturnType<typeof sql>): Promise<Record<string, unknown>[]> =>
    (await db.execute(q)).rows;
  const one = async (db: Db, q: ReturnType<typeof sql>): Promise<Record<string, unknown>> =>
    (await db.execute(q)).rows[0]!;

  const envelope = (res: { json(): unknown }) =>
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
    json(): Record<string, any>;
  }

  const injectAs = (
    s: SessionCookies | undefined,
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    opts: { headers?: Record<string, string>; payload?: unknown } = {},
  ): Promise<InjectResult> =>
    app.inject({
      method,
      url,
      headers: { ...(s ? { cookie: s.cookie } : {}), ...opts.headers },
      payload: opts.payload as string | undefined,
    }) as unknown as Promise<InjectResult>;

  const inject = (
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    opts: { headers?: Record<string, string>; payload?: unknown } = {},
  ) => injectAs(sessions.owner, method, url, opts);

  const auditCount = async (action: string, tenantId = tenantAId): Promise<number> =>
    Number(
      (
        await one(
          migratorDb,
          sql`select count(*)::int n from audit_logs where tenant_id = ${tenantId} and action = ${action}`,
        )
      ).n,
    );

  const outboxCount = async (eventType: string, tenantId = tenantAId): Promise<number> =>
    Number(
      (
        await one(
          migratorDb,
          sql`select count(*)::int n from outbox_events where tenant_id = ${tenantId} and event_type = ${eventType}`,
        )
      ).n,
    );

  beforeAll(async () => {
    const env = getEnv();
    const mig = createDb({ url: env.DATABASE_URL_MIGRATOR });
    const app_ = createDb({ url: env.DATABASE_URL_APP });
    migratorDb = mig.db;
    appDb = app_.db;
    migratorClient = await mig.pool.connect();
    endMigrator = async () => {
      migratorClient.release();
      await mig.pool.end();
    };
    endApp = () => app_.pool.end();
    redis = createRedis();
    endRedis = () => redis.quit();
    await redis.connect();

    for (const key of [
      'owner',
      'principal',
      'teacher',
      'otherTeacher',
      'parent',
      'otherParent',
      'reader',
      'insider',
      'platRole',
    ]) {
      uid[key] = randomUUID();
    }
    await rows(
      migratorDb,
      sql`insert into roles (id, scope, code, name, is_system) values (${uid.platRole}, 'platform', ${`p6${slug}_plat`}, 'P6 Platform Admin', true)`,
    );
    await rows(
      migratorDb,
      sql`insert into role_permissions (role_id, permission) values (${uid.platRole}, 'platform.tenants.read'), (${uid.platRole}, 'platform.tenants.create')`,
    );
    await rows(
      migratorDb,
      sql`insert into users (id, email) values
        (${uid.owner}, ${`o-${slug}@example.com`}),
        (${uid.principal}, ${`pr-${slug}@example.com`}),
        (${uid.teacher}, ${`te-${slug}@example.com`}),
        (${uid.otherTeacher}, ${`t2-${slug}@example.com`}),
        (${uid.parent}, ${`pa-${slug}@example.com`}),
        (${uid.otherParent}, ${`p2-${slug}@example.com`}),
        (${uid.reader}, ${`re-${slug}@example.com`}),
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
    tenantAId = (
      await withTenant(appDb, platformCtx(uid.owner!), (tx) =>
        createTenantTransaction(tx, platformCtx(uid.owner!), {
          slug: `${slug}-a`,
          name: 'P6 A',
          requestId: randomUUID(),
        }),
      )
    ).tenantId;
    tenantBId = (
      await withTenant(appDb, platformCtx(uid.owner!), (tx) =>
        createTenantTransaction(tx, platformCtx(uid.owner!), {
          slug: `${slug}-b`,
          name: 'P6 B',
          requestId: randomUUID(),
        }),
      )
    ).tenantId;

    const roleIdOf = async (tenantId: string, code: string) =>
      String((await one(migratorDb, sql`select id from roles where tenant_id = ${tenantId} and code = ${code}`)).id);
    const ownerRoleIdB = await roleIdOf(tenantBId, 'school_owner');
    const teacherRoleId = await roleIdOf(tenantAId, 'teacher');
    const parentRoleId = await roleIdOf(tenantAId, 'parent');
    // The BUILT-IN principal role, not a custom one: result visibility is derived
    // from the role CODE ladder (staff/teacher/parent/student), so a custom code
    // would resolve to 'none'. It carries exams.read/manage/publish/correct but
    // deliberately NOT exams.mark, so publication is separable from entry.
    const principalRoleId = await roleIdOf(tenantAId, 'principal');

    // A custom role holding only exams.read, to prove the ledger stays closed.
    uid.roleReader = randomUUID();
    await rows(
      migratorDb,
      sql`insert into roles (id, tenant_id, scope, code, name, is_system) values
        (${uid.roleReader}, ${tenantAId}, 'tenant', 'p6_reader', 'P6 Reader', false)`,
    );
    await rows(
      migratorDb,
      sql`insert into role_permissions (role_id, permission) values
        (${uid.roleReader}, 'exams.read')`,
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
    await member(tenantAId, uid.principal!, principalRoleId);
    await member(tenantAId, uid.teacher!, teacherRoleId);
    await member(tenantAId, uid.otherTeacher!, teacherRoleId);
    await member(tenantAId, uid.parent!, parentRoleId);
    await member(tenantAId, uid.otherParent!, parentRoleId);
    await member(tenantAId, uid.reader!, String(uid.roleReader));
    await member(tenantBId, uid.insider!, ownerRoleIdB);

    sessions.owner = await makeSession(uid.owner!, tenantAId);
    sessions.principal = await makeSession(uid.principal!, tenantAId);
    sessions.teacher = await makeSession(uid.teacher!, tenantAId);
    sessions.otherTeacher = await makeSession(uid.otherTeacher!, tenantAId);
    sessions.parent = await makeSession(uid.parent!, tenantAId);
    sessions.otherParent = await makeSession(uid.otherParent!, tenantAId);
    sessions.reader = await makeSession(uid.reader!, tenantAId);
    sessions.insider = await makeSession(uid.insider!, tenantBId);

    app = await buildApp({ deps: { db: appDb, redis, storage: stubStorage }, logger: process.env.P6_DEBUG_LOG === '1' });

    // ---------------------------------------------------------------- fixtures
    campusAId = randomUUID();
    await rows(
      migratorDb,
      sql`insert into campuses (id, tenant_id, name, code) values (${campusAId}, ${tenantAId}, 'Main', ${`MAIN${slug.slice(0, 4)}`})`,
    );
    yearAId = randomUUID();
    await rows(
      migratorDb,
      sql`insert into academic_years (id, tenant_id, name, code, starts_on, ends_on, status)
          values (${yearAId}, ${tenantAId}, '2026', 'AY2026', current_date - 30, current_date + 300, 'active')`,
    );
    termAId = randomUUID();
    await rows(
      migratorDb,
      sql`insert into academic_terms (id, tenant_id, academic_year_id, code, name, sequence, starts_on, ends_on, status)
          values (${termAId}, ${tenantAId}, ${yearAId}, 'T1', 'Term 1', 1, current_date - 20, current_date + 60, 'open')`,
    );

    const subjectMath = randomUUID();
    await rows(
      migratorDb,
      sql`insert into subjects (id, tenant_id, code, name, status)
          values (${subjectMath}, ${tenantAId}, 'MATH', 'Mathematics', 'active')`,
    );

    const gradeLevelId = randomUUID();
    await rows(
      migratorDb,
      sql`insert into grade_levels (id, tenant_id, name, code) values (${gradeLevelId}, ${tenantAId}, 'Grade 1', 'G1')`,
    );
    classAId = randomUUID();
    classBId = randomUUID();
    await rows(
      migratorDb,
      sql`insert into acd_classes (id, tenant_id, campus_id, academic_year_id, grade_level_id, code, name, status)
          values (${classAId}, ${tenantAId}, ${campusAId}, ${yearAId}, ${gradeLevelId}, 'P6A', 'P6 Class A', 'active')`,
    );
    classSubjectAId = randomUUID();
    await rows(
      migratorDb,
      sql`insert into class_subjects (id, tenant_id, class_id, subject_id, campus_id, academic_year_id)
          values (${classSubjectAId}, ${tenantAId}, ${classAId}, ${subjectMath}, ${campusAId}, ${yearAId})`,
    );
    // The teacher owns (classA, maths) only — the second teacher owns nothing.
    await rows(
      migratorDb,
      sql`insert into teacher_assignments (id, tenant_id, class_id, subject_id, teacher_user_id, campus_id, academic_year_id)
          values (${randomUUID()}, ${tenantAId}, ${classAId}, ${subjectMath}, ${uid.teacher}, ${campusAId}, ${yearAId})`,
    );

    // Tenant B needs its OWN campus/year: the composite FKs are tenant-scoped,
    // so a tenant-B section can never point at a tenant-A class.
    campusBId = randomUUID();
    await rows(
      migratorDb,
      sql`insert into campuses (id, tenant_id, name, code) values (${campusBId}, ${tenantBId}, 'B Main', ${`BMAIN${slug.slice(0, 4)}`})`,
    );
    yearBId = randomUUID();
    await rows(
      migratorDb,
      sql`insert into academic_years (id, tenant_id, name, code, starts_on, ends_on, status)
          values (${yearBId}, ${tenantBId}, '2026', 'AY2026', current_date - 30, current_date + 300, 'active')`,
    );
    const gradeLevelBId = randomUUID();
    await rows(
      migratorDb,
      sql`insert into grade_levels (id, tenant_id, name, code) values (${gradeLevelBId}, ${tenantBId}, 'Grade 1', 'G1')`,
    );
    classBId = randomUUID();
    await rows(
      migratorDb,
      sql`insert into acd_classes (id, tenant_id, campus_id, academic_year_id, grade_level_id, code, name, status)
          values (${classBId}, ${tenantBId}, ${campusBId}, ${yearBId}, ${gradeLevelBId}, 'P6B', 'P6 Class B', 'active')`,
    );

    const mkStudent = async (
      tenantId: string,
      classId: string,
      no: string,
      campusId: string,
      yearId: string,
    ): Promise<string> => {
      const studentId = randomUUID();
      await rows(
        migratorDb,
        sql`insert into students (id, tenant_id, student_no, first_name, last_name, status)
            values (${studentId}, ${tenantId}, ${no}, 'Ada', ${`L${no}`}, 'active')`,
      );
      const sectionId = randomUUID();
      await rows(
        migratorDb,
        sql`insert into sections (id, tenant_id, class_id, campus_id, academic_year_id, code, status)
            values (${sectionId}, ${tenantId}, ${classId}, ${campusId}, ${yearId}, ${no}, 'active')`,
      );
      await rows(
        migratorDb,
        sql`insert into enrollments (id, tenant_id, student_id, class_id, section_id, academic_year_id, status, roll_no)
            values (${randomUUID()}, ${tenantId}, ${studentId}, ${classId}, ${sectionId}, ${yearId}, 'active', '1')`,
      );
      return studentId;
    };
    child = await mkStudent(tenantAId, classAId, 'P6S1', campusAId, yearAId);
    otherChild = await mkStudent(tenantAId, classAId, 'P6S2', campusAId, yearAId);
    foreignStudent = await mkStudent(tenantBId, classBId, 'P6F1', campusBId, yearBId);

    // One portal-linked guardian row per parent user; the LINK is what scopes
    // every result read, so each family is bound to exactly one child here.
    const guardianFor = async (userId: string, first: string): Promise<string> => {
      const id = randomUUID();
      await rows(
        migratorDb,
        sql`insert into guardians (id, tenant_id, user_id, first_name, last_name)
            values (${id}, ${tenantAId}, ${userId}, ${first}, 'Guardian')`,
      );
      return id;
    };
    const guardianParentId = await guardianFor(uid.parent!, 'Pat');
    const guardianOtherId = await guardianFor(uid.otherParent!, 'Oth');
    await rows(
      migratorDb,
      sql`insert into student_guardians (id, tenant_id, guardian_id, student_id, relation, is_primary) values
        (${randomUUID()}, ${tenantAId}, ${guardianParentId}, ${child}, 'parent', true),
        (${randomUUID()}, ${tenantAId}, ${guardianOtherId}, ${otherChild}, 'parent', true)`,
    );
  });

  // ------------------------------------------------------------ A. route gate
  describe('A. route gate and permission separation', () => {
    it('1. refuses an anonymous read', async () => {
      for (const url of [
        '/api/v1/exams',
        '/api/v1/exam-types',
        '/api/v1/grading-scales',
        '/api/v1/report-cards',
        '/api/v1/mark-corrections',
        '/api/v1/me/results',
      ]) {
        const res = await injectAs(undefined, 'GET', url);
        expect(res.statusCode, url).toBe(401);
      }
    });

    it('2. refuses a write that carries no CSRF token', async () => {
      const res = await injectAs(sessions.principal, 'POST', '/api/v1/exam-types', {
        payload: { code: 'nocsrf', name: 'No CSRF' },
      });
      expect(res.statusCode).toBe(403);
    });

    it('3. exams.read is not exams.manage: a reader may list, never configure', async () => {
      const list = await injectAs(sessions.reader, 'GET', '/api/v1/exams');
      expect(list.statusCode).toBe(200);

      const create = await injectAs(sessions.reader, 'POST', '/api/v1/exams', {
        headers: withCsrf(sessions.reader),
        payload: { academicTermId: termAId, examTypeId, name: 'Reader exam', gradingScaleId: scaleId },
      });
      expect(create.statusCode).toBe(403);
      expect(envelope(create)?.requiredPermission).toBe('exams.manage');
    });

    it('4. a teacher cannot publish: exams.publish is a separate grant', async () => {
      const res = await injectAs(sessions.teacher, 'POST', `/api/v1/exams/${examId}/publish`, {
        headers: withCsrf(sessions.teacher),
        payload: {},
      });
      expect(res.statusCode).toBe(403);
      expect(envelope(res)?.requiredPermission).toBe('exams.publish');
    });
  });

  // -------------------------------------------------- B/C. lifecycle and entry
  describe('B/C. exam lifecycle and mark entry', () => {
    it('creates a draft exam', async () => {
      const typeRes = await injectAs(sessions.principal, 'POST', '/api/v1/exam-types', {
        headers: { ...withCsrf(sessions.principal), ...idem(`p6-type-${slug}`) },
        payload: { code: `midterm${slug.slice(0, 6).replace(/[^a-z0-9_]/g, '')}`, name: 'Mid-term' },
      });
      expect(typeRes.statusCode, JSON.stringify(typeRes.json())).toBe(201);
      examTypeId = typeRes.json().examType.id;

      const scaleRes = await injectAs(sessions.principal, 'POST', '/api/v1/grading-scales', {
        headers: { ...withCsrf(sessions.principal), ...idem(`p6-scale-${slug}`) },
        payload: {
          code: `p6s${slug.slice(0, 6).replace(/[^a-z0-9_]/g, '')}`,
          name: 'P6 Scale',
          // ACTIVE, otherwise the exam would grade against no bands at all.
          isActive: true,
          bands: [
            { label: 'A', minPercent: 80, maxPercent: 100, gradePoint: 4 },
            { label: 'B', minPercent: 60, maxPercent: 80, gradePoint: 3 },
            { label: 'C', minPercent: 40, maxPercent: 60, gradePoint: 2 },
            { label: 'F', minPercent: 0, maxPercent: 40, gradePoint: 0 },
          ],
        },
      });
      expect(scaleRes.statusCode, JSON.stringify(scaleRes.json())).toBe(201);
      scaleId = scaleRes.json().gradingScale.id;
      expect(scaleRes.json().gradingScale.version).toBe(1);
      // Out-of-order bands are accepted: the tiling check sorts them server-side.
      expect(scaleRes.json().gradingScale.bands).toHaveLength(4);

      const examRes = await injectAs(sessions.principal, 'POST', '/api/v1/exams', {
        headers: { ...withCsrf(sessions.principal), ...idem(`p6-exam-${slug}`) },
        payload: {
          academicTermId: termAId,
          examTypeId,
          name: 'P6 Mid-term',
          campusId: campusAId,
          gradingScaleId: scaleId,
        },
      });
      expect(examRes.statusCode, JSON.stringify(examRes.json())).toBe(201);
      examId = examRes.json().exam.id;
      expect(examRes.json().exam.status).toBe('draft');

      // Publication is NOT a status-transition target: the schema narrows it away,
      // so holding exams.manage can never reach it through this endpoint.
      const illegal = await injectAs(sessions.principal, 'POST', `/api/v1/exams/${examId}/status`, {
        headers: withCsrf(sessions.principal),
        payload: { status: 'published' },
      });
      expect(illegal.statusCode).toBe(400);
    });

    it('refuses an exam whose named grading scale is dormant', async () => {
      const dormant = await injectAs(sessions.principal, 'POST', '/api/v1/grading-scales', {
        headers: { ...withCsrf(sessions.principal), ...idem(`p6-dormant-${slug}`) },
        payload: {
          code: `p6d${slug.slice(0, 6).replace(/[^a-z0-9_]/g, '')}`,
          name: 'Dormant Scale',
          isActive: false,
          bands: [{ label: 'A', minPercent: 0, maxPercent: 100, gradePoint: 4 }],
        },
      });
      expect(dormant.statusCode, JSON.stringify(dormant.json())).toBe(201);
      const dormantId = dormant.json().gradingScale.id;
      expect(dormant.json().gradingScale.isActive).toBe(false);

      const res = await injectAs(sessions.principal, 'POST', '/api/v1/exams', {
        headers: { ...withCsrf(sessions.principal), ...idem(`p6-exam-dormant-${slug}`) },
        payload: {
          academicTermId: termAId,
          examTypeId,
          name: 'P6 Dormant',
          campusId: campusAId,
          gradingScaleId: dormantId,
        },
      });
      expect(res.statusCode, JSON.stringify(res.json())).toBe(409);
      expect(envelope(res)?.code).toBe('exam_scale_not_active');
    });

    it('attaches a class subject while the exam is still configurable', async () => {
      const ok = await injectAs(sessions.principal, 'POST', `/api/v1/exams/${examId}/subjects`, {
        headers: { ...withCsrf(sessions.principal), ...idem(`p6-es-${slug}`) },
        payload: { examId, classSubjectId: classSubjectAId, maxMarks: 100, weight: 1 },
      });
      expect(ok.statusCode, JSON.stringify(ok.json())).toBe(201);
      examSubjectMathId = ok.json().examSubject.id;
      expect(Number(ok.json().examSubject.maxMarks)).toBe(100);
    });

    it('refuses a zero weight: the subject would silently drop out of the GPA', async () => {
      const res = await injectAs(sessions.principal, 'POST', `/api/v1/exams/${examId}/subjects`, {
        headers: withCsrf(sessions.principal),
        payload: { examId, classSubjectId: classSubjectAId, maxMarks: 50, weight: 0 },
      });
      expect(res.statusCode).toBe(400);
    });

    it('walks the exam to grading and then freezes its configuration', async () => {
      for (const status of ['scheduled', 'grading'] as const) {
        const res = await injectAs(sessions.principal, 'POST', `/api/v1/exams/${examId}/status`, {
          headers: withCsrf(sessions.principal),
          payload: { status },
        });
        expect(res.statusCode, JSON.stringify(res.json())).toBe(200);
        expect(res.json().exam.status).toBe(status);
      }
      const late = await injectAs(sessions.principal, 'POST', `/api/v1/exams/${examId}/subjects`, {
        headers: withCsrf(sessions.principal),
        payload: { examId, classSubjectId: classSubjectAId, maxMarks: 50, weight: 1 },
      });
      expect(late.statusCode).toBeGreaterThanOrEqual(400);
    });

    it('gives the gradebook to the assigned teacher and to nobody else', async () => {
      const mine = await injectAs(
        sessions.teacher,
        'GET',
        `/api/v1/exam-subjects/${examSubjectMathId}/gradebook`,
      );
      expect(mine.statusCode, JSON.stringify(mine.json())).toBe(200);
      expect(mine.json().canMark).toBe(true);
      // The roster is the actively enrolled class, not "everyone".
      expect(mine.json().rows).toHaveLength(2);

      const other = await injectAs(
        sessions.otherTeacher,
        'GET',
        `/api/v1/exam-subjects/${examSubjectMathId}/gradebook`,
      );
      expect(other.statusCode).toBe(403);
      expect(envelope(other)?.code).toBe('exam_subject_not_assigned');

      const family = await injectAs(
        sessions.parent,
        'GET',
        `/api/v1/exam-subjects/${examSubjectMathId}/gradebook`,
      );
      expect(family.statusCode).toBe(403);
    });

    it('hides an unpublished exam from a family', async () => {
      const list = await injectAs(sessions.parent, 'GET', '/api/v1/exams');
      expect(list.statusCode).toBe(200);
      expect(list.json().items.map((e: { id: string }) => e.id)).not.toContain(examId);

      const subjects = await injectAs(sessions.parent, 'GET', `/api/v1/exams/${examId}/subjects`);
      expect(subjects.statusCode, JSON.stringify(subjects.json())).toBe(404);
    });

    it('enters marks as the assigned teacher and keeps them in bounds', async () => {
      const gradebook = await injectAs(
        sessions.teacher,
        'GET',
        `/api/v1/exam-subjects/${examSubjectMathId}/gradebook`,
      );
      const entries = gradebook.json().rows.map((r: { enrollmentId: string }, i: number) => ({
        enrollmentId: r.enrollmentId,
        marksObtained: i === 0 ? 90 : 55,
      }));

      const res = await injectAs(sessions.teacher, 'POST', '/api/v1/marks', {
        headers: { ...withCsrf(sessions.teacher), ...idem(`p6-marks-${slug}`) },
        payload: { examSubjectId: examSubjectMathId, entries },
      });
      expect(res.statusCode, JSON.stringify(res.json())).toBe(200);
      expect(res.json().entered).toBe(2);
      // the grade is DERIVED server-side, never posted
      for (const m of res.json().marks) {
        expect(m.gradeLabel).not.toBeNull();
        expect(m.percentage).not.toBeNull();
        expect(m.status).toBe('provisional');
      }
      markId = res.json().marks[0].id;
      const labels = res.json().marks.map((m: { gradeLabel: string }) => m.gradeLabel).sort();
      // 90% and 55% land in the A and C bands of the active scale.
      expect(labels).toEqual(['A', 'C']);

      // re-posting the same marks is an UPDATE, never a duplicate row
      const again = await injectAs(sessions.teacher, 'POST', '/api/v1/marks', {
        headers: { ...withCsrf(sessions.teacher), ...idem(`p6-marks2-${slug}`) },
        payload: { examSubjectId: examSubjectMathId, entries },
      });
      expect(again.statusCode).toBe(200);
      expect(again.json().inserted).toBe(0);
      expect(again.json().updated).toBe(2);
    });

    it('refuses a mark above max_marks', async () => {
      const gradebook = await injectAs(
        sessions.teacher,
        'GET',
        `/api/v1/exam-subjects/${examSubjectMathId}/gradebook`,
      );
      const target = gradebook.json().rows[0];
      const res = await injectAs(sessions.teacher, 'POST', '/api/v1/marks', {
        headers: withCsrf(sessions.teacher),
        payload: {
          examSubjectId: examSubjectMathId,
          entries: [{ enrollmentId: target.enrollmentId, marksObtained: 101 }],
        },
      });
      expect(res.statusCode).toBeGreaterThanOrEqual(400);
      const stored = await one(
        migratorDb,
        sql`select marks_obtained from marks where id = ${markId}`,
      );
      expect(Number(stored.marks_obtained)).toBeLessThanOrEqual(100);
    });

    it('refuses mark entry from a parent', async () => {
      const res = await injectAs(sessions.parent, 'POST', '/api/v1/marks', {
        headers: withCsrf(sessions.parent),
        payload: {
          examSubjectId: examSubjectMathId,
          entries: [{ enrollmentId: '00000000-0000-4000-8000-000000000000', marksObtained: 1 }],
        },
      });
      expect(res.statusCode).toBe(403);
      expect(envelope(res)?.requiredPermission).toBe('exams.mark');
    });
  });

  // ----------------------------------------------- D. publication and freezing
  describe('D. publication and immutability', () => {
    it('publishes, audits and enqueues the compute job', async () => {
      const res = await injectAs(sessions.principal, 'POST', `/api/v1/exams/${examId}/publish`, {
        headers: { ...withCsrf(sessions.principal), ...idem(`p6-publish-${slug}`) },
        payload: {},
      });
      expect(res.statusCode, JSON.stringify(res.json())).toBe(200);
      expect(res.json().exam.status).toBe('published');
      expect(res.json().exam.publishedAt).not.toBeNull();

      expect(await auditCount('exam.result.published')).toBe(1);
      // ONE compute command per EXAM (the worker fans out over the roster), plus
      // one publication event for the family notification stub.
      expect(await outboxCount('exam.result.compute')).toBe(1);
      expect(await outboxCount('exam.published')).toBe(1);
      expect(await auditCount('exam.published')).toBe(0);
    });

    it('refuses to publish an exam that has no result set', async () => {
      const empty = await injectAs(sessions.principal, 'POST', '/api/v1/exams', {
        headers: { ...withCsrf(sessions.principal), ...idem(`p6-exam-empty-${slug}`) },
        payload: {
          academicTermId: termAId,
          examTypeId,
          name: 'P6 Empty',
          campusId: campusAId,
          gradingScaleId: scaleId,
        },
      });
      expect(empty.statusCode, JSON.stringify(empty.json())).toBe(201);
      const emptyId = empty.json().exam.id;

      const res = await injectAs(sessions.principal, 'POST', `/api/v1/exams/${emptyId}/publish`, {
        headers: withCsrf(sessions.principal),
        payload: {},
      });
      expect(res.statusCode).toBeGreaterThanOrEqual(400);
      const still = await one(migratorDb, sql`select status from exams where id = ${emptyId}`);
      expect(still.status).toBe('draft');
    });

    it('locks every mark of a published exam', async () => {
      const marks = await rows(
        migratorDb,
        sql`select status, locked_at from marks where exam_subject_id = ${examSubjectMathId}`,
      );
      expect(marks).toHaveLength(2);
      for (const m of marks) {
        expect(m.status).toBe('locked');
        expect(m.locked_at).not.toBeNull();
      }
    });

    it('refuses a mark edit through the API once published', async () => {
      const gradebook = await injectAs(
        sessions.teacher,
        'GET',
        `/api/v1/exam-subjects/${examSubjectMathId}/gradebook`,
      );
      expect(gradebook.json().locked).toBe(true);
      const target = gradebook.json().rows[0];

      const res = await injectAs(sessions.teacher, 'POST', '/api/v1/marks', {
        headers: withCsrf(sessions.teacher),
        payload: {
          examSubjectId: examSubjectMathId,
          entries: [{ enrollmentId: target.enrollmentId, marksObtained: 10 }],
        },
      });
      expect(res.statusCode).toBeGreaterThanOrEqual(400);
      const stored = await one(migratorDb, sql`select marks_obtained from marks where id = ${markId}`);
      expect(Number(stored.marks_obtained)).toBeGreaterThan(10);
    });

    it('refuses a DIRECT SQL update of a published mark with no correction (the DB trigger)', async () => {
      await expect(
        migratorDb.execute(sql`update marks set marks_obtained = 12 where id = ${markId}`),
      ).rejects.toThrow(/correction workflow|correction/i);
    });
  });

  // ------------------------------------------------------ E. correction ledger
  describe('E. correction workflow', () => {
    it('records a correction, rechecks the mark and audits it', async () => {
      const before = await one(
        migratorDb,
        sql`select marks_obtained from marks where id = ${markId}`,
      );
      // F-02: the correction must carry its OWN recomputation request. Publication
      // already queued one, so the dedicated test below inspects the rows rather
      // than trusting an absolute count.
      const res = await injectAs(sessions.principal, 'POST', `/api/v1/marks/${markId}/corrections`, {
        headers: { ...withCsrf(sessions.principal), ...idem(`p6-correct-${slug}`) },
        payload: { marksObtained: 95, reason: 'Re-marked after moderation' },
      });
      expect(res.statusCode, JSON.stringify(res.json())).toBe(201);
      expect(res.json().mark.status).toBe('rechecked');
      expect(Number(res.json().mark.marksObtained)).toBe(95);
      expect(Number(res.json().correction.oldMarksObtained)).toBe(Number(before.marks_obtained));
      expect(res.json().correction.reason).toBe('Re-marked after moderation');
      expect(await auditCount('exam.mark_corrected')).toBe(1);
      expect(await outboxCount('result.corrected')).toBe(1);
    });

    it('queues the recompute in the SAME transaction as the correction (F-02)', async () => {
      // The fact is `result.corrected`; the command is `exam.result.compute`. Both
      // are written inside the correction transaction, so a published correction can
      // never commit without the request that makes the report card catch up.
      const evts = (await rows(
        migratorDb,
        sql`select event_type, correlation_id, (payload->>'reason') as reason,
                   (payload->>'markId') as mark_id, (payload->>'examId') as exam_id
              from outbox_events
             where event_type in ('result.corrected', 'exam.result.compute')
             order by event_type`,
      )) as Array<{
        event_type: string;
        correlation_id: string | null;
        reason: string | null;
        mark_id: string | null;
        exam_id: string | null;
      }>;
      const corrected = evts.find((r) => r.event_type === 'result.corrected');
      const computes = evts.filter((r) => r.event_type === 'exam.result.compute');
      expect(corrected).toBeTruthy();
      // One from publication, one from the correction.
      expect(computes.length).toBeGreaterThanOrEqual(2);
      const fromCorrection = computes.find((c) => c.reason === 'mark_corrected');
      expect(fromCorrection).toBeTruthy();
      expect(fromCorrection!.mark_id).toBe(markId);
      // Same transaction is observable as the same correlation id.
      expect(fromCorrection!.correlation_id).toBe(corrected!.correlation_id);
      expect(fromCorrection!.exam_id).toBe(corrected!.exam_id);
    });

    it('exposes the ledger only to a role holding exams.correct', async () => {
      const principal = await injectAs(sessions.principal, 'GET', '/api/v1/mark-corrections');
      expect(principal.statusCode).toBe(200);
      expect(principal.json().total).toBe(1);

      const reader = await injectAs(sessions.reader, 'GET', '/api/v1/mark-corrections');
      expect(reader.statusCode).toBe(403);
      expect(envelope(reader)?.requiredPermission).toBe('exams.correct');
    });

    it('refuses a correction without a reason', async () => {
      const res = await injectAs(sessions.principal, 'POST', `/api/v1/marks/${markId}/corrections`, {
        headers: withCsrf(sessions.principal),
        payload: { marksObtained: 50, reason: '' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('refuses a teacher correction (exams.correct is not exams.mark)', async () => {
      const res = await injectAs(sessions.teacher, 'POST', `/api/v1/marks/${markId}/corrections`, {
        headers: withCsrf(sessions.teacher),
        payload: { marksObtained: 50, reason: 'teacher should not be able to' },
      });
      expect(res.statusCode).toBe(403);
      expect(envelope(res)?.requiredPermission).toBe('exams.correct');
    });

    it('serialises concurrent corrections on the score, not just the status (F-02)', async () => {
      // A repeated correction leaves the mark at `rechecked`, so the status carries
      // no information about which writer won. If the route guarded only the status,
      // every one of these requests would pass the route's own compare-and-swap and
      // the loser would be turned away further in, by the published-exam guard
      // trigger, which reports `mark_correction_required`. Putting the score in the
      // CAS makes the route a serialisation point, so the client is told the truth:
      // a 409 meaning "the mark changed, reload and retry".
      //
      // There are TWO independent serialisation points for this one logical
      // condition, and which one rejects a given loser depends on the interleaving:
      //   - the route's CAS on `marks_obtained` (exams.ts)  -> `mark_conflict`
      //   - the `mark_corrections` old-value guard trigger (0015_exams_results.sql),
      //     which runs on the INSERT — i.e. BEFORE the route's UPDATE — so a loser
      //     whose INSERT lands after the winner's UPDATE never reaches the CAS.
      // The guard is mapped onto the same public code, so the client contract is
      // deterministic: a concurrent correction conflict is ALWAYS `mark_conflict`,
      // never a second code that varies with thread timing. Do not widen this to a
      // set: a second accepted code would reintroduce the nondeterminism.
      //
      // Asserting the exact code still has teeth. A status-only guard would surface
      // `mark_correction_required`, which is not `mark_conflict`, so removing the
      // score predicate from the CAS still fails this test (negative-control
      // verified). The deterministic guard-path proof is the sibling test below.
      const attempts = [71, 73, 77, 79];
      const results = await Promise.all(
        attempts.map((score) =>
          injectAs(sessions.principal, 'POST', `/api/v1/marks/${markId}/corrections`, {
            headers: withCsrf(sessions.principal),
            payload: { marksObtained: score, reason: `moderation round ${score}` },
          }),
        ),
      );

      const created = results.filter((r) => r.statusCode === 201);
      const conflicts = results.filter((r) => r.statusCode === 409);
      expect(created.length + conflicts.length).toBe(attempts.length);
      expect(created.length).toBeGreaterThan(0);

      // Every loser is the same concurrency conflict, never a leaked storage-layer
      // code and never a timing-dependent second code.
      for (const c of conflicts) expect(envelope(c)?.code).toBe('mark_conflict');

      // The ledger stays a faithful record: the accepted corrections each observed a
      // distinct previous score, so the audit chain old→new has no forks, and the
      // mark now holds the last new value rather than a lost update.
      const oldScores = created.map((r) => Number(r.json().correction.oldMarksObtained));
      expect(new Set(oldScores).size).toBe(oldScores.length);
      const stored = await one(
        migratorDb,
        sql`select marks_obtained from marks where id = ${markId}`,
      );
      expect(attempts).toContain(Number(stored.marks_obtained));
      const ledger = (await rows(
        migratorDb,
        sql`select old_marks_obtained, new_marks_obtained from mark_corrections
             where mark_id = ${markId} order by created_at`,
      )) as Array<{ old_marks_obtained: string; new_marks_obtained: string }>;
      expect(ledger.length).toBeGreaterThanOrEqual(created.length);
      expect(Number(ledger[ledger.length - 1]!.new_marks_obtained)).toBe(
        Number(stored.marks_obtained),
      );
    });

    it('exposes mark_conflict for the INSERT old-value guard, and keeps both guards', async () => {
      // The concurrency test above proves the route CAS path. That test cannot prove
      // the OTHER path deterministically, because which of the two guards rejects a
      // given loser is a race. This test pins the guard path on its own, by provoking
      // the real trigger directly and asserting the public code it maps to.
      //
      // Both serialization defences must remain, so assert their existence too: a
      // future change that drops either one must fail here, not silently narrow the
      // defence to a single point.
      const trg = await one(
        migratorDb,
        sql`select count(*)::int as n from pg_trigger
              where tgname = 'mark_corrections_validate_trg' and not tgisinternal`,
      );
      expect(trg.n).toBeGreaterThan(0);

      // Provoke the guard for real: a correction row whose old_marks_obtained does not
      // match the mark it claims to correct. Everything else is valid, so the
      // old-value branch is the one that fires (0015_exams_results.sql).
      const markRow = await one(
        migratorDb,
        sql`select mk.exam_subject_id, mk.student_id, mk.marks_obtained, es.max_marks
              from marks mk
              join exam_subjects es on es.tenant_id = mk.tenant_id and es.id = mk.exam_subject_id
              where mk.id = ${markId}`,
      );
      const current = Number(markRow.marks_obtained);
      const maxMarks = Number(markRow.max_marks);
      // A value that is definitely NOT the mark's current score, so the old-value
      // branch is the one that fires.
      const staleOld = current + 1 <= maxMarks ? current + 1 : current - 1;
      // A legal new score, distinct from staleOld, so this is a well-formed
      // correction whose only defect is the stale old value.
      let newValue = current >= maxMarks ? current - 1 : current + 1;
      if (newValue === staleOld) newValue = staleOld + 1 <= maxMarks ? staleOld + 1 : staleOld - 1;

      let raised: (Error & { code?: string; pgcode?: string; message: string }) | null = null;
      try {
        await migratorClient.query(
          `insert into mark_corrections
             (tenant_id, mark_id, exam_id, exam_subject_id, student_id,
              old_marks_obtained, new_marks_obtained, reason, corrected_by)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [
            tenantAId,
            markId,
            examId,
            markRow.exam_subject_id,
            markRow.student_id,
            staleOld.toFixed(2),
            newValue.toFixed(2),
            'F-02 guard-path probe',
            uid.principal,
          ],
        );
      } catch (err) {
        raised = err as Error & { code?: string; pgcode?: string };
      }
      // The guard is not optional: the bad row must be refused.
      expect(raised).toBeTruthy();
      expect(raised!.pgcode ?? raised!.code).toBe('55000');
      expect(raised!.message).toMatch(/old value does not match the mark/i);

      // ...and it must surface as the same public code as the route CAS, so the
      // client contract is deterministic regardless of which guard won the race.
      const mapped = mapDomainError(raised);
      expect(mapped.status).toBe(409);
      expect((mapped as unknown as { code?: string }).code).toBe('mark_conflict');
      // No storage-layer text leaks to the client.
      expect(mapped.message).toBe('The mark changed concurrently; reload and retry');

      // The status guard is a DIFFERENT condition and must keep its own code, or
      // this normalization would have erased a meaningful distinction. `mapDomainError`
      // reads `code` (the SQLSTATE), which is what `pg` puts on a DatabaseError.
      const statusGuard = mapDomainError({
        code: '55000',
        message: 'a published mark can only be changed through the correction workflow',
      });
      expect((statusGuard as unknown as { code?: string }).code).toBe('mark_correction_required');
    });
  });

  // ------------------------------------------------------- F. family scoping
  // The portal and the transcript read REPORT CARDS, so the fixture publishes one per
  // child. The worker is out of scope here: its own convergence is covered by
  // apps/worker/src/exams.test.ts.
  //
  // The card is minted by the SHARED fixture helper, not INSERTed here. It used to be
  // inserted as a `published` row carrying hand-written aggregates and NO subject
  // lines at all - a state the Phase 6 schema deliberately makes impossible, because
  // the deferred coherence trigger refuses to let a card reach `published` while its
  // aggregate disagrees with its own snapshot. The trigger was right and the fixture
  // was wrong, so the fixture now writes the card the way the worker writes one:
  // draft, then lines scoped to the card's own exam, then the aggregate read back
  // from `fn_report_card_totals()`, and only then `published`. The same helper serves
  // the DB suite, so the two cannot drift into disagreeing about what a coherent card
  // is.
  //
  // Declared at suite scope, not inside describe F, because F2 also needs it.
  const publishCard = async (studentId: string, version: number, status: string): Promise<void> => {
    const enrollment = await one(
      migratorDb,
      sql`select id, class_id, section_id, academic_year_id from enrollments
            where tenant_id = ${tenantAId} and student_id = ${studentId} and deleted_at is null`,
    );
    await publishReportCardWithSnapshot(migratorClient, {
      tenantId: tenantAId,
      examId,
      studentId,
      enrollmentId: enrollment.id as string,
      version,
      status: status === 'published' ? 'published' : 'draft',
    });
  };

  describe('F. parent result scope', () => {
    it('serves a parent their own child transcript', async () => {
      await publishCard(child, 1, 'published');

      const res = await injectAs(sessions.parent, 'GET', `/api/v1/students/${child}/transcript`);
      expect(res.statusCode).toBe(200);
      expect(res.json().studentId).toBe(child);
      expect(res.json().entries).toHaveLength(1);
      expect(res.json().entries[0].examId).toBe(examId);
    });

    it('refuses a cross-child transcript read', async () => {
      const res = await injectAs(sessions.parent, 'GET', `/api/v1/students/${otherChild}/transcript`);
      expect(res.statusCode).toBe(403);
      expect(envelope(res)?.code).toBe('results_scope_denied');
    });

    it('shows a parent only their own child in the portal', async () => {
      const res = await injectAs(sessions.parent, 'GET', '/api/v1/me/results');
      expect(res.statusCode, JSON.stringify(res.json())).toBe(200);
      expect(res.json().context.role).toBe('parent');
      const ids = res.json().views.map((v: { student: { id: string } }) => v.student.id);
      expect(ids).toEqual([child]);
      const view = res.json().views[0];
      expect(view.entries.length).toBe(1);
      expect(view.entries[0].examId).toBe(examId);
      expect(view.reportCards[0].status).toBe('published');
      expect(view.reportCards[0].subjects[0].maxMarks).toBe(100);
    });

    it('shows the second family their own child only', async () => {
      await publishCard(otherChild, 1, 'published');
      const res = await injectAs(sessions.otherParent, 'GET', '/api/v1/me/results');
      const ids = res.json().views.map((v: { student: { id: string } }) => v.student.id);
      expect(ids).toEqual([otherChild]);
    });

    it('never lists a draft report card to a family', async () => {
      await publishCard(child, 2, 'draft');

      const portal = await injectAs(sessions.parent, 'GET', '/api/v1/me/results');
      for (const card of portal.json().views[0].reportCards) {
        expect(card.status).toBe('published');
      }

      const list = await injectAs(sessions.parent, 'GET', '/api/v1/report-cards');
      expect(list.statusCode).toBe(200);
      for (const card of list.json().items) expect(card.status).toBe('published');
      expect(list.json().items.map((c: { version: number }) => c.version)).not.toContain(2);
    });
  });

  // ------------------------------------------------ report-card preview contract
  //
  // WHY THIS SUITE EXISTS. The parent portal needs a PDF URL for a published card,
  // and the contracts package already declares exactly one shape for that response:
  // `reportCardPreviewResponseSchema` = { reportCard, fileUrl }. The API returns that
  // shape from `GET /api/v1/report-cards/:id`. But nothing referenced the contract
  // anywhere, and the web client asked a THIRD path for it
  // (`GET /api/v1/report-cards/:id/preview`) that no route ever registered - so the
  // "Open PDF" button in the family portal was a guaranteed runtime 404, and the
  // declared contract was free to drift from the real response.
  //
  // This suite closes both halves: the client is pointed at the route that exists,
  // and the route's real body is asserted against the contract that describes it.
  describe('F2. report-card preview response contract', () => {
    // F2 works through `otherChild`/`otherParent`, not `child`/`parent`, and the
    // reason is a real constraint rather than a preference for tidy ordering.
    //
    // `report_cards_live_draft_uq` allows at most ONE live draft per
    // (tenant, exam, student), and `publishReportCardWithSnapshot` always starts by
    // INSERTing the card as a draft before it publishes it. Describe F deliberately
    // leaves `child` v2 as a draft (that is how it proves a family never sees one),
    // so that slot is occupied for the rest of the run and any further card for
    // `child` - published or not - is a constraint violation. `otherChild` has only a
    // published v1, so it has a free draft slot and is the correct subject here.
    //
    // F2 also owns version numbers 10-12. `report_cards_student_exam_version_uq` is a
    // real unique index, so re-using a version another describe minted is a hard
    // failure.
    const publishFreshCard = async (
      studentId: string,
      version: number,
      status: 'published' | 'draft',
    ): Promise<string> => {
      await publishCard(studentId, version, status);
      const [row] = await rows(
        migratorDb,
        sql`select id from report_cards
              where tenant_id = ${tenantAId} and exam_id = ${examId}
                and student_id = ${studentId} and version = ${version}`,
      );
      expect(row, `fixture did not mint a v${version} card for ${studentId}`).toBeDefined();
      return row!.id as string;
    };

    /**
     * Stamp a card the way the reports worker does: a `files` row, then the one-time
     * pointer a published card is allowed to receive (0015 allows `file_id` to go from
     * NULL once, and never to be replaced). Done as the migrator because the runtime
     * role may not mint a `files` row for a generated artifact.
     */
    const stampArtifact = async (cardId: string): Promise<string> => {
      const [file] = await rows(
        migratorDb,
        sql`insert into files (tenant_id, storage_key, original_name, mime, size_bytes,
                                content_hash, visibility, owner_type, owner_id, scan_status)
            values (${tenantAId}, ${`report-cards/${cardId}.pdf`}, ${'report-card-preview.pdf'},
                    ${'application/pdf'}, ${4}, ${'a'.repeat(64)}, ${'tenant_portal'},
                    ${'report_card'}, ${cardId}, ${'clean'})
            on conflict (storage_key) do update set storage_key = excluded.storage_key
            returning id`,
      );
      await rows(
        migratorDb,
        sql`update report_cards set file_id = ${file!.id}
              where tenant_id = ${tenantAId} and id = ${cardId}`,
      );
      return file!.id as string;
    };

    it('serves a family the contract-shaped body with a null URL while pending', async () => {
      const cardId = await publishFreshCard(otherChild, 10, 'published');

      const res = await injectAs(sessions.otherParent, 'GET', `/api/v1/report-cards/${cardId}`);
      expect(res.statusCode, JSON.stringify(res.json())).toBe(200);

      // The contract is load-bearing here, not decorative: if the route's shape ever
      // drifts, this parse fails instead of the family portal silently breaking.
      const parsed = reportCardPreviewResponseSchema.safeParse(res.json());
      expect(
        parsed.success,
        `the report-card preview response does not match reportCardPreviewResponseSchema: ${
          parsed.success ? '' : parsed.error.message
        }`,
      ).toBe(true);
      expect(parsed.data!.reportCard.id).toBe(cardId);

      // A published card has no file_id until the reports worker runs. The portal
      // renders that as "still being generated, try again", so `null` is the
      // load-bearing value - it must not become a 404 or a fabricated URL.
      expect(res.json().reportCard.fileId).toBeNull();
      expect(res.json().fileUrl).toBeNull();
    });

    it('returns the stored artifact URL once the worker has stamped the card', async () => {
      const cardId = await publishFreshCard(otherChild, 11, 'published');
      const fileId = await stampArtifact(cardId);

      const res = await injectAs(sessions.otherParent, 'GET', `/api/v1/report-cards/${cardId}`);
      expect(res.statusCode, JSON.stringify(res.json())).toBe(200);
      expect(res.json().reportCard.fileId).toBe(fileId);
      expect(res.json().fileUrl).toBe('https://example.invalid/report-card.pdf');
      expect(reportCardPreviewResponseSchema.safeParse(res.json()).success).toBe(true);
    });

    it('refuses another family and hides a draft, so the preview adds no new surface', async () => {
      const otherCardId = await publishFreshCard(otherChild, 12, 'published');

      // 403, not 404: a parent probing another family's child is a scope denial, the
      // same way the transcript route answers.
      const cross = await injectAs(sessions.parent, 'GET', `/api/v1/report-cards/${otherCardId}`);
      expect(cross.statusCode).toBe(403);
      expect(envelope(cross)?.code).toBe('results_scope_denied');

      // A draft is invisible to a family through the preview path too: the owning
      // parent gets 404, exactly as the list route omits it.
      const draftId = await publishFreshCard(otherChild, 13, 'draft');
      const hidden = await injectAs(
        sessions.otherParent,
        'GET',
        `/api/v1/report-cards/${draftId}`,
      );
      expect(hidden.statusCode).toBe(404);
    });
  });

  afterAll(async () => {
    // A teardown statement that throws must not orphan the rows AFTER it: the
    // fixture's users/roles would then leak into the next run and break unrelated
    // suites that count global rows. So every step is independent and the
    // failures are reported, not swallowed.
    const failures: string[] = [];
    const step = async (what: string, run: () => Promise<unknown>): Promise<void> => {
      try {
        await run();
      } catch (err) {
        failures.push(`${what}: ${err instanceof Error ? err.message : String(err)}`);
      }
    };

    await step('close app', async () => {
      if (app) await app.close();
    });

    // ---------------------------------------------------------------------
    // The four guards this fixture has to lift, and why each one is lifted.
    //
    //   mark_corrections_append_only_trg  append-only BY DESIGN; also RESTRICTs
    //                                     the memberships its actor points at.
    //   marks_delete_guard_trg            published-row DELETE guard, no role
    //                                     bypass (F-03).
    //   report_cards_hard_delete_guard_trg PUBLISHED-card hard-DELETE guard, no
    //                                     role bypass (P2-03).
    //   report_card_subjects_freeze_trg   a published card's lines are frozen
    //                                     for every role. 0018 splits that freeze
    //                                     out of the integrity trigger, so THAT is
    //                                     the guard to lift; the validate trigger
    //                                     stays enabled and says nothing about a
    //                                     DELETE.
    //
    // WHY ONE TRANSACTION (and not a disable/delete/enable sequence in
    // autocommit). `ALTER TABLE ... DISABLE TRIGGER` is transactional DDL, so the
    // disabled state is only durable if somebody COMMITs it. In autocommit each
    // statement committed on its own, which meant a process kill, a runner timeout
    // or a SIGKILL anywhere in this window left all four guards disabled *and
    // committed* in the shared disposable database. Nothing detects that
    // afterwards: the `tgenabled` assertions in 0018/0019 are one-shot migration
    // checks, and both files are already applied, so a later run re-applies nothing
    // and re-asserts nothing. The suite was therefore able to silently weaken the
    // very database it exists to test.
    //
    // Wrapping the window in a single transaction closes that:
    //   * the four re-enables are in the SAME transaction as the lifts, so a
    //     successful run cannot commit a disabled guard;
    //   * the restore is asserted fail-closed against pg.tgenabled BEFORE the
    //     commit, so a trigger that did not come back aborts the teardown instead
    //     of committing a half-restored schema;
    //   * a killed or aborted session never reaches COMMIT, so PostgreSQL rolls
    //     the DDL back and every guard is still 'O' — the same property the
    //     worker fixture relies on;
    //   * a `finally` issues ROLLBACK on every path that did not commit, so the
    //     rollback is unconditional rather than dependent on a throw being caught.
    //
    // Per-delete SAVEPOINTs keep the original tolerance for a single failing
    // statement: a failure rolls back only its own savepoint, so the deletes after
    // it still run and one bad table cannot orphan the whole fixture. `DISABLE
    // TRIGGER ALL` and `session_replication_role` are deliberately not used: the
    // first would lift guards this test knows nothing about, and the second is a
    // superuser-only GUC that disables *every* trigger including RLS internals.
    // Nothing here weakens a production trigger; each is restored in-transaction
    // and then verified from the catalog.
    // ---------------------------------------------------------------------
    const GUARDS = [
      { table: 'mark_corrections', trigger: 'mark_corrections_append_only_trg' },
      { table: 'marks', trigger: 'marks_delete_guard_trg' },
      { table: 'report_cards', trigger: 'report_cards_hard_delete_guard_trg' },
      { table: 'report_card_subjects', trigger: 'report_card_subjects_freeze_trg' },
    ] as const;

    // Children first: the Phase 6 tables are all RESTRICT-referenced, and
    // `report_card_subjects` RESTRICTs `report_cards`, so the lines have to go
    // before the card that owns them.
    const TEARDOWN_TABLES = [
      'mark_corrections',
      'report_card_subjects',
      'report_cards',
      'marks',
      'exam_schedules',
      'exam_subjects',
      'exams',
      'grading_scales',
      'exam_types',
      'teacher_assignments',
      'class_subjects',
      'enrollments',
      'sections',
      'student_guardians',
      'students',
      'guardians',
      'acd_classes',
      'grade_levels',
      'subjects',
      'academic_terms',
      'academic_years',
      'campuses',
      'outbox_events',
      'idempotency_keys',
      'audit_logs',
    ] as const;

    const tenantIds = [tenantAId, tenantBId].filter((t): t is string => Boolean(t));

    // One savepoint per step, so a single failing statement is isolated. Named
    // from a counter rather than reused, because a released savepoint's name is
    // free again and a duplicate would make `rollback to` ambiguous.
    let sp = 0;
    const stepInTx = async (what: string, run: () => Promise<unknown>): Promise<void> => {
      const name = `p6_teardown_${sp++}`;
      try {
        await migratorClient.query(`savepoint ${name}`);
        await run();
        await migratorClient.query(`release savepoint ${name}`);
      } catch (err) {
        failures.push(`${what}: ${err instanceof Error ? err.message : String(err)}`);
        await migratorClient.query(`rollback to savepoint ${name}`).catch(() => undefined);
      }
    };

    let committed = false;
    try {
      await migratorClient.query('begin');
      for (const g of GUARDS) {
        await migratorClient.query(`alter table ${g.table} disable trigger ${g.trigger}`);
      }

      for (const tenantId of tenantIds) {
        for (const table of TEARDOWN_TABLES) {
          await stepInTx(`delete ${table}`, () =>
            migratorClient.query(`delete from ${table} where tenant_id = $1`, [tenantId]),
          );
        }
      }

      // Restore, then PROVE the restore, then commit — in that order. The
      // assertion is fail-closed: a trigger that is absent counts as not
      // restored, because a guard that cannot be found cannot be shown to be on.
      for (const g of GUARDS) {
        await migratorClient.query(`alter table ${g.table} enable trigger ${g.trigger}`);
      }
      const guardState = await migratorClient.query<{ trigger: string; tgenabled: string }>(
        `select tgname::text as trigger, tgenabled::text as tgenabled
           from pg_trigger
          where not tgisinternal
            and (tgrelid, tgname::text) in (${GUARDS.map(
              (g) => `('${g.table}'::regclass, '${g.trigger}')`,
            ).join(', ')})`,
      );
      const notRestored = guardState.rows.filter((r) => r.tgenabled !== 'O');
      if (guardState.rows.length !== GUARDS.length || notRestored.length > 0) {
        throw new Error(
          `fixture teardown refused to commit: guards not restored to 'O' — ` +
            `${guardState.rows.length}/${GUARDS.length} found, ` +
            `not-O: ${notRestored.map((r) => `${r.trigger}=${r.tgenabled || 'absent'}`).join(', ') || '(none)'}`,
        );
      }

      await migratorClient.query('commit');
      committed = true;
    } finally {
      // Unconditional. After a COMMIT this is a no-op warning; on every other path
      // it is what guarantees the trigger lifts are undone.
      if (!committed) {
        await migratorClient.query('rollback').catch(() => undefined);
      }
    }

    const platCode = `p6${slug}_plat`;
    const bothIn = sql.join([tenantAId, tenantBId].filter(Boolean).map((t) => sql`${t}`), sql`, `);
    if (bothIn) {
      await step('membership_roles', () =>
        rows(
          migratorDb,
          sql`delete from membership_roles where membership_id in (select id from memberships where tenant_id in (${bothIn}))`,
        ),
      );
      await step('memberships', () =>
        rows(migratorDb, sql`delete from memberships where tenant_id in (${bothIn})`),
      );
      // platform_role_assignments RESTRICTs the role AND the user, so it has to
      // go while both endpoints still exist — i.e. before the role itself.
      if (uid.owner) {
        await step('platform_role_assignments', () =>
          rows(
            migratorDb,
            sql`delete from platform_role_assignments where user_id = ${uid.owner}`,
          ),
        );
      }
      await step('role_permissions', () =>
        rows(
          migratorDb,
          sql`delete from role_permissions where role_id in (
                select id from roles
                where tenant_id in (${bothIn}) or code like ${`${slug}%`}
                   or id = ${uid.platRole} or code = ${platCode})`,
        ),
      );
      await step('roles', () =>
        rows(
          migratorDb,
          sql`delete from roles
                where tenant_id in (${bothIn}) or code like ${`${slug}%`}
                   or id = ${uid.platRole} or code = ${platCode}`,
        ),
      );
      await step('tenants', () =>
        rows(migratorDb, sql`delete from tenants where id in (${bothIn})`),
      );
    }
    if (uid.owner) {
      await step('platform_role_assignments (re-check)', () =>
        rows(
          migratorDb,
          sql`delete from platform_role_assignments where user_id = ${uid.owner}`,
        ),
      );
    }
    await step('users', () =>
      rows(migratorDb, sql`delete from users where email like ${`%-${slug}@example.com`}`),
    );

    if (failures.length > 0) {
      throw new Error(`fixture teardown incomplete: ${failures.join(' | ')}`);
    }
  });

  // ------------------------------------------- F-01: report-card subject lines
  describe('H. result-integrity remediation regressions (F-01, F-02)', () => {
    it('leaves the published report card stale until the worker runs (F-02 rationale)', async () => {
      // WHY the command is necessary, stated as a fact about the system: the API
      // does not recompute inline.
      //
      // Staleness has to be PRODUCED, not assumed. The card published above was
      // minted from the mark as it stood at publication, so it is coherent with
      // that mark - the schema demands it, and the fixture now satisfies it. The
      // correction below is what makes the card stale: the mark moves, the card
      // must not, and the recompute is QUEUED instead. Without
      // `exam.result.compute` in that transaction nothing would ever converge it,
      // and if the API recomputed inline the published snapshot would be rewritten
      // behind the worker's back - which is the bug this test exists to catch.
      const cardBefore = await one(
        migratorDb,
        sql`select id, version, total_obtained from report_cards
             where exam_id = ${examId} and student_id = ${child} and status = 'published'
             order by version desc limit 1`,
      );
      const markBefore = await one(
        migratorDb,
        sql`select marks_obtained from marks where id = ${markId}`,
      );
      // Precondition: the published card agrees with the mark it was minted from.
      // If this ever fails, the divergence asserted below would prove nothing.
      expect(Number(cardBefore.total_obtained)).toBe(Number(markBefore.marks_obtained));

      // Move the mark to a different value, through the real correction endpoint.
      const corrected = Number(markBefore.marks_obtained) === 61 ? 62 : 61;
      const res = await injectAs(sessions.principal, 'POST', `/api/v1/marks/${markId}/corrections`, {
        headers: { ...withCsrf(sessions.principal), ...idem(`p6-f02-stale-${slug}`) },
        payload: { marksObtained: corrected, reason: 'F-02: moderation after publication' },
      });
      expect(res.statusCode, JSON.stringify(res.json())).toBe(201);
      const markAfter = await one(
        migratorDb,
        sql`select marks_obtained from marks where id = ${markId}`,
      );
      expect(Number(markAfter.marks_obtained)).toBe(corrected);

      // The mark moved. The published card did NOT: it is stale, and stays stale
      // until the worker's idempotent computation converges it.
      const cardAfter = await one(
        migratorDb,
        sql`select total_obtained from report_cards where id = ${cardBefore.id}`,
      );
      expect(Number(cardAfter.total_obtained)).toBe(Number(cardBefore.total_obtained));
      expect(Number(cardAfter.total_obtained)).not.toBe(Number(markAfter.marks_obtained));

      // ...and the request that will fix it is sitting in the outbox, undispatched.
      // The payload is checked, not just its presence: `makeResultComputeHandler`
      // reads tenantId/examId off the event and nothing else, so a command that
      // named the wrong exam would be a green test over a card that never
      // converges. This is the seam between the two halves of the F-02 proof.
      const pending = await rows(
        migratorDb,
        sql`select aggregate_id, payload, dispatched_at from outbox_events
             where event_type = 'exam.result.compute' and (payload->>'reason') = 'mark_corrected'
               and dispatched_at is null`,
      );
      expect(pending.length).toBeGreaterThan(0);
      const command = pending.find((e) => e.aggregate_id === examId)!;
      expect(command, 'the queued recompute names this exam').toBeDefined();
      const payload = command.payload as Record<string, unknown>;
      expect(payload['tenantId']).toBe(tenantAId);
      expect(payload['examId']).toBe(examId);
      expect(payload['markId']).toBe(markId);
    });

    it('does not recompute a published card inline (F-02: command, not shortcut)', async () => {
      // Same read, one more time, to pin down that the API is not quietly
      // double-writing the card. The correction above moved the mark while the
      // card stayed put; the published snapshot is untouched and no second
      // version exists, because only the worker may mint one.
      //
      // The convergence itself is deliberately NOT asserted here. Superseding a
      // published card means running `makeResultComputeHandler`, and the API
      // package must not depend on the worker app to do it. That half of the
      // contract lives where the handler does, in
      // apps/worker/src/exams-result-pipeline.test.ts ("F-02 a published
      // correction converges the report card"), which drives the real handler and
      // asserts version 1 stays frozen at its published total while version 2
      // carries the corrected one. Between the two files the responsibility is
      // pinned from both ends: the API cannot converge the card, and the worker
      // does.
      const versions = await rows(
        migratorDb,
        sql`select version, status, total_obtained from report_cards
             where exam_id = ${examId} and student_id = ${child} and status = 'published'
             order by version`,
      );
      expect(versions.length).toBe(1);
      expect(Number(versions[0]!.version)).toBe(1);
      expect(Number(versions[0]!.status === 'published' ? 1 : 0)).toBe(1);

      // The staleness is real and recoverable-in-principle: the card still holds
      // a coherent snapshot of the mark as it stood at publication, it simply no
      // longer agrees with the live mark, and its lines are present for the worker
      // to supersede.
      const markNow = await one(
        migratorDb,
        sql`select marks_obtained from marks where id = ${markId}`,
      );
      const cardNow = await one(
        migratorDb,
        sql`select rc.id, rc.version, rc.total_obtained, (select count(*)::int from report_card_subjects s where s.report_card_id = rc.id) lines
             from report_cards rc
            where rc.exam_id = ${examId} and rc.student_id = ${child} and rc.status = 'published'
            order by rc.version desc limit 1`,
      );
      expect(Number(cardNow.total_obtained)).not.toBe(Number(markNow.marks_obtained));
      expect(Number(cardNow.lines)).toBeGreaterThan(0);

      // And no second PUBLISHED version was minted behind the worker's back. (A
      // draft card for the same exam and student legitimately coexists, so this
      // counts published versions rather than all cards.)
      const publishedVersions = await rows(
        migratorDb,
        sql`select version from report_cards
             where exam_id = ${examId} and student_id = ${child} and status = 'published'`,
      );
      expect(publishedVersions.map((r) => Number(r.version))).toEqual([1]);
    });
    /**
     * `loadSubjectLines` selected the mark, the exam_subject and the subject, but
     * never constrained `exam_subjects.exam_id` to the report card's own exam. The
     * effective predicate was therefore "any mark this enrollment has in this
     * academic year", so a SECOND exam in the same year contributed its subject
     * lines — and its marks, max_marks and weights — to a card that belonged to the
     * first exam. The card's own totals and subject_count were derived from the
     * worker over a correctly scoped set, so the detail view and the totals
     * disagreed with each other.
     *
     * The fixture here builds exactly that: a second, published exam in the same
     * year, with a different subject, a different max_marks and a different grade
     * for the same child.
     */
    it('does not leak a sibling exam\'s subject lines into the card (F-01)', async () => {
      const enrollment = await one(
        migratorDb,
        sql`select id, class_id, section_id, academic_year_id from enrollments
             where tenant_id = ${tenantAId} and student_id = ${child} and deleted_at is null`,
      );
      const term = await one(
        migratorDb,
        sql`select id from academic_terms where tenant_id = ${tenantAId} limit 1`,
      );
      const otherClassSubject = (
        await rows(
          migratorDb,
          sql`select id, subject_id from class_subjects
               where tenant_id = ${tenantAId} and id <> ${examSubjectMathId} and deleted_at is null
               limit 1`,
        )
      )[0];
      // Only meaningful if the fixture has a second subject; skip loudly rather than
      // silently passing.
      expect(otherClassSubject, 'fixture needs a second class_subject for the F-01 test').toBeTruthy();

      const otherExamId = randomUUID();
      const otherSubjectId = randomUUID();
      await rows(
        migratorDb,
        sql`insert into exams
              (id, tenant_id, academic_term_id, academic_year_id, exam_type_id, grading_scale_id, name, status)
            values (${otherExamId}, ${tenantAId}, ${term.id}, ${enrollment.academic_year_id},
                    (select exam_type_id from exams where id = ${examId}),
                    (select grading_scale_id from exams where id = ${examId}),
                    'SIBLING EXAM — must not appear on the card', 'draft')`,
      );
      // max_marks 40 and a distinctive grade: if either leaks onto the card, the
      // assertion below fails on a value that cannot come from the first exam.
      await rows(
        migratorDb,
        sql`insert into exam_subjects
              (id, tenant_id, exam_id, class_subject_id, academic_year_id, class_id, subject_id, max_marks, weight)
            values (${otherSubjectId}, ${tenantAId}, ${otherExamId}, ${otherClassSubject!.id},
                    ${enrollment.academic_year_id}, ${enrollment.class_id},
                    ${otherClassSubject!.subject_id}, 40, 3)`,
      );
      // Promote now that the exam has a subject: marks may only be entered while the
      // exam is 'grading', and this is the order a real exam follows.
      await rows(
        migratorDb,
        sql`update exams set status = 'grading' where id = ${otherExamId}`,
      );
      await rows(
        migratorDb,
        sql`insert into marks
              (id, tenant_id, exam_subject_id, enrollment_id, student_id, section_id, academic_year_id,
               marks_obtained, percentage, grade_label, grade_point, status, entered_by)
            values (${randomUUID()}, ${tenantAId}, ${otherSubjectId}, ${enrollment.id}, ${child},
                    ${enrollment.section_id}, ${enrollment.academic_year_id}, 40, 100, 'A', 4, 'provisional', ${uid.teacher})`,
      );
      await rows(
        migratorDb,
        sql`update exams set status = 'published', published_at = now() where id = ${otherExamId}`,
      );
      // The sibling's own card is minted through the SHARED helper, so it is a
      // genuinely coherent card: its single subject line (max_marks 40, weight 3,
      // grade A) and its aggregate are written in the order the worker writes
      // them. It used to be INSERTed as `published` with hand-written aggregates
      // and no subject lines, which the coherence trigger correctly refuses.
      await publishReportCardWithSnapshot(migratorClient, {
        tenantId: tenantAId,
        examId: otherExamId,
        studentId: child,
        enrollmentId: enrollment.id as string,
        version: 1,
        status: 'published',
      });

      const portal = await injectAs(sessions.parent, 'GET', '/api/v1/me/results');
      expect(portal.statusCode, JSON.stringify(portal.json())).toBe(200);

      // The card for the FIRST exam must describe only the first exam.
      const firstCard = portal
        .json()
        .views[0].reportCards.find((c: { examId: string }) => c.examId === examId);
      expect(firstCard).toBeTruthy();
      for (const s of firstCard.subjects as Array<{ maxMarks: number; subjectName: string }>) {
        expect(s.maxMarks).toBe(100);
        expect(s.subjectName).not.toMatch(/SIBLING/);
      }
      // And it must not have grown the sibling's line.
      const names = (firstCard.subjects as Array<{ subjectName: string }>).map((s) => s.subjectName);
      expect(names).toHaveLength(new Set(names).size);
      expect(
        (firstCard.subjects as unknown[]).some(
          (s) => (s as { maxMarks: number }).maxMarks === 40,
        ),
      ).toBe(false);

      // The sibling's own card is unaffected and still shows its own subject.
      const siblingCard = portal
        .json()
        .views[0].reportCards.find((c: { examId: string }) => c.examId === otherExamId);
      expect(siblingCard).toBeTruthy();
      expect(
        (siblingCard.subjects as Array<{ maxMarks: number }>).map((s) => s.maxMarks),
      ).toEqual([40]);
    });

    it('keeps the transcript scoped the same way', async () => {
      // The same helper feeds the transcript, so the leak showed up there too.
      const res = await injectAs(
        sessions.parent,
        'GET',
        `/api/v1/students/${child}/transcript`,
      );
      expect(res.statusCode, JSON.stringify(res.json())).toBe(200);
      for (const entry of res.json().entries as Array<{
        reportCards?: Array<{ subjects?: Array<{ maxMarks: number }> }>;
      }>) {
        for (const card of entry.reportCards ?? []) {
          for (const s of card.subjects ?? []) {
            expect([40, 100]).toContain(Number(s.maxMarks));
          }
        }
      }
    });
  });

  // ------------------------------------------------------------- G. isolation
  describe('G. tenant isolation', () => {
    it('cannot see another tenant exam or its subjects', async () => {
      const list = await injectAs(sessions.insider, 'GET', '/api/v1/exams');
      expect(list.statusCode).toBe(200);
      expect(list.json().items.map((e: { id: string }) => e.id)).not.toContain(examId);

      const subjects = await injectAs(sessions.insider, 'GET', `/api/v1/exams/${examId}/subjects`);
      expect(subjects.statusCode, JSON.stringify(subjects.json())).toBe(404);

      const card = await injectAs(sessions.insider, 'GET', `/api/v1/students/${child}/transcript`);
      // School-wide staff have no relationship restriction, so another tenant's
      // student is simply invisible (404) — whereas a PARENT probing someone
      // else's child is a relationship denial (403), so the two never blur.
      expect(card.statusCode).toBe(404);
      expect(foreignStudent).not.toBe(child);
    });
  });
});
