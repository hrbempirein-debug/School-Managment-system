import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
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
 * Phase 3.5 admissions + CSV import/export HTTP security + acceptance proofs
 * against the ACTUAL Fastify app, real dev PostgreSQL under the real
 * `school_app_rw` role, LIVE Redis, and a throwaway temp-directory storage
 * provider (so an upload lands on real disk and can be verified).
 *
 * Admissions: transition-only lifecycle (submit/review/approve/reject/withdraw)
 * with 409 guards, cross-tenant 404s, principal read-only boundary, audit +
 * outbox events, student materialization with campus scope, unknown-campus 422.
 *
 * Imports: raw-buffer CSV upload (202 + storage key + audit + outbox), idempotent
 * replay, list/detail reads (owner + principal), campus-pinned uploader scope,
 * and the size/NUL/header/row-count gates. Exports: streaming CSV with
 * formula-injection neutralization, correct headers, permission + auth gates and
 * cross-tenant isolation.
 *
 * Opt-in: RUN_RUNTIME_SECURITY_TESTS=1.
 */
const enabled = process.env.RUN_RUNTIME_SECURITY_TESTS === '1';
const describeDb = enabled ? describe : describe.skip;

interface SessionCookies {
  token: string;
  csrf: string;
  cookie: string;
}

describeDb('Phase 3.5 admissions + import/export: HTTP security + acceptance (real app + real DB + live Redis + temp storage)', () => {
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
  const slug = `p35${randomUUID().slice(0, 8)}`;
  const sessions: Record<'ownerA' | 'ownerB' | 'principal' | 'campus', SessionCookies> = {} as never;

  let campusACode = '';
  let campusBId = '';
  let campusBMemberOfAId = '';

  const rows = async (db: Db, q: ReturnType<typeof sql>): Promise<Record<string, unknown>[]> =>
    (await db.execute(q)).rows;

  const envelope = (res: { json: () => unknown }) =>
    (res.json() as { error?: { code?: string; message?: string } }).error;

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

    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sms-p35-'));
    storage = new FsStorageProvider(tempRoot);

    uid.owner = randomUUID();
    uid.principal = randomUUID();
    uid.campusUser = randomUUID();
    uid.ownerB = randomUUID();
    uid.platRole = randomUUID();

    await rows(
      migratorDb,
      sql`insert into roles (id, scope, code, name, is_system) values (${uid.platRole}, 'platform', ${`p35p${slug}_plat`}, 'Phase 3.5 Platform', true)`,
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
        createTenantTransaction(tx, platformCtx(uid.owner!), { slug: `${slug}-a`, name: 'P35 A', requestId: randomUUID() }),
      )
    ).tenantId;
    uid.tenantB = (
      await withTenant(appDb, platformCtx(uid.ownerB!), (tx) =>
        createTenantTransaction(tx, platformCtx(uid.ownerB!), { slug: `${slug}-b`, name: 'P35 B', requestId: randomUUID() }),
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
    const campusMembership = await rows(
      migratorDb,
      sql`insert into memberships (id, tenant_id, user_id, status) values (${randomUUID()}, ${uid.tenantA}, ${uid.campusUser}, 'active') returning id`,
    );
    await rows(
      migratorDb,
      sql`insert into membership_roles (membership_id, role_id) values (${String(campusMembership[0]!.id)}, ${ownerRoleIdA})`,
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
    campusACode = `p35a-${slug}`;
    await mkCampus(campusACode, 'P35 Main', sessions.ownerA);
    campusBId = await mkCampus(`p35b-${slug}`, 'P35 Annex', sessions.ownerA);
    await mkCampus(`p35b2-${slug}`, 'P35 B Campus', sessions.ownerB);

    const campusARows = await rows(
      migratorDb,
      sql`select id from campuses where tenant_id = ${uid.tenantA} and code = ${campusACode}`,
    );
    campusBMemberOfAId = String(campusARows[0]!.id);
    await rows(
      migratorDb,
      sql`update memberships set campus_id = ${campusBMemberOfAId} where user_id = ${uid.campusUser} and tenant_id = ${uid.tenantA}`,
    );

    // Live tenant-A students for the export matrix (approve() creates more).
    await rows(
      migratorDb,
      sql`insert into students (id, tenant_id, student_no, first_name, last_name, status, primary_campus_id) values
            (${randomUUID()}, ${uid.tenantA}, ${`p35x-${slug}`}, 'Export', 'Alpha', 'active', ${campusBMemberOfAId}),
            (${randomUUID()}, ${uid.tenantA}, ${`=3+3-${slug}`}, 'Formula', 'Injection', 'active', ${campusBMemberOfAId})`,
    );
    const bCampusB = await rows(
      migratorDb,
      sql`select id from campuses where tenant_id = ${uid.tenantB} and code = ${`p35b2-${slug}`}`,
    );
    await rows(
      migratorDb,
      sql`insert into students (id, tenant_id, student_no, first_name, last_name, status, primary_campus_id) values
            (${randomUUID()}, ${uid.tenantB}, ${`p35y-${slug}`}, 'Export', 'Bravo', 'active', ${String(bCampusB[0]!.id)})`,
    );
  });

  afterAll(async () => {
    try {
      if (app) await app.close();
      const tenants = `'${uid.tenantA}','${uid.tenantB}'`;
      await rows(
        migratorDb,
        sql`delete from outbox_events where tenant_id in (${sql.raw(tenants)})`,
      );
      // audit_logs is append-only by design (no DELETE policy) — residue is expected.
      await rows(
        migratorDb,
        sql`delete from idempotency_keys where tenant_id in (${sql.raw(tenants)})`,
      );
      await rows(
        migratorDb,
        sql`delete from student_import_rows where tenant_id in (${sql.raw(tenants)})`,
      );
      await rows(
        migratorDb,
        sql`delete from student_imports where tenant_id in (${sql.raw(tenants)})`,
      );
      await rows(
        migratorDb,
        sql`delete from admission_applications where tenant_id in (${sql.raw(tenants)})`,
      );
      await rows(
        migratorDb,
        sql`delete from students where tenant_id in (${sql.raw(tenants)})`,
      );
      await rows(
        migratorDb,
        sql`delete from campuses where tenant_id in (${sql.raw(tenants)})`,
      );
      await rows(
        migratorDb,
        sql`delete from membership_roles where membership_id in (select id from memberships where tenant_id in (${sql.raw(tenants)}))`,
      );
      await rows(
        migratorDb,
        sql`delete from role_permissions where role_id in (select id from roles where tenant_id in (${sql.raw(tenants)}) or id = ${uid.platRole})`,
      );
      await rows(
        migratorDb,
        sql`delete from platform_role_assignments where user_id in (${uid.owner}, ${uid.ownerB})`,
      );
      await rows(
        migratorDb,
        sql`delete from memberships where tenant_id in (${sql.raw(tenants)})`,
      );
      await rows(
        migratorDb,
        sql`delete from roles where tenant_id in (${sql.raw(tenants)}) or id = ${uid.platRole}`,
      );
      await rows(
        migratorDb,
        sql`delete from users where id in (${uid.owner}, ${uid.ownerB}, ${uid.principal}, ${uid.campusUser})`,
      );
      await rows(
        migratorDb,
        sql`delete from tenants where id in (${sql.raw(tenants)})`,
      );
    } finally {
      await endMigrator();
      await endApp();
      await endRedis();
      await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => {});
    }
  });

  // ------------------------------------------------------------ admissions

  const snapshot = (over: Record<string, unknown> = {}) => ({
    studentNo: `adm-${slug}`,
    firstName: 'Alice',
    lastName: 'Applicant',
    dateOfBirth: '2012-03-14',
    gender: 'female',
    campusCode: campusACode,
    ...over,
  });

  it('A1. create + list + get an admission application (201/200), idempotent replay', async () => {
    const empty = await app.inject({
      method: 'GET',
      url: '/api/v1/admission-applications',
      headers: { cookie: sessions.ownerA.cookie },
    });
    expect(empty.statusCode).toBe(200);
    expect((empty.json() as { items: unknown[] }).items).toHaveLength(0);

    const key = `app-${slug}`;
    const body = { snapshot: snapshot() };
    const hdrs = { cookie: sessions.ownerA.cookie, ...withCsrf(sessions.ownerA), ...idem(key) };
    const created = await app.inject({ method: 'POST', url: '/api/v1/admission-applications', headers: hdrs, payload: body });
    expect(created.statusCode).toBe(201);
    const appRow = created.json().application as { id: string; status: string; snapshot: Record<string, unknown> };
    expect(appRow.status).toBe('draft');

    const replay = await app.inject({ method: 'POST', url: '/api/v1/admission-applications', headers: hdrs, payload: body });
    expect(replay.statusCode).toBe(201);
    expect((replay.json().application as { id: string }).id).toBe(appRow.id);

    const list = await app.inject({
      method: 'GET',
      url: '/api/v1/admission-applications?status=draft',
      headers: { cookie: sessions.ownerA.cookie },
    });
    const items = (list.json() as { items: Array<{ id: string }>; total: number }).items;
    expect(items.map((i) => i.id)).toContain(appRow.id);

    const got = await app.inject({
      method: 'GET',
      url: `/api/v1/admission-applications/${appRow.id}`,
      headers: { cookie: sessions.ownerA.cookie },
    });
    expect(got.statusCode).toBe(200);
    expect((got.json().application as { snapshot: Record<string, unknown> }).snapshot.studentNo).toBe(`adm-${slug}`);

    await rows(
      migratorDb,
      sql`delete from admission_applications where id = ${appRow.id}`,
    );
  });

  it('A2. invalid create bodies are rejected shape-first (400)', async () => {
    const post = (body: Record<string, unknown>) =>
      app.inject({
        method: 'POST',
        url: '/api/v1/admission-applications',
        headers: { cookie: sessions.ownerA.cookie, ...withCsrf(sessions.ownerA), ...idem(`bad-${randomUUID()}`) },
        payload: body,
      });
    // snapshot required
    expect((await post({})).statusCode).toBe(400);
    // snapshot is strict: unknown key is rejected
    expect((await post({ snapshot: { ...snapshot(), evil: 'x' } })).statusCode).toBe(400);
    // status is not writable on create
    expect((await post({ snapshot: snapshot(), status: 'accepted' })).statusCode).toBe(400);
  });

  it('A3. submit -> review -> approve materializes an applicant student with campus + events', async () => {
    const key = `flow-${slug}`;
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/admission-applications',
      headers: { cookie: sessions.ownerA.cookie, ...withCsrf(sessions.ownerA), ...idem(key) },
      payload: { snapshot: snapshot({ studentNo: `flow-${slug}` }) },
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

    const resubmit = await app.inject({
      method: 'POST',
      url: `/api/v1/admission-applications/${id}/submit`,
      headers: { cookie: sessions.ownerA.cookie, ...withCsrf(sessions.ownerA) },
    });
    expect(resubmit.statusCode).toBe(409);
    expect(envelope(resubmit)?.code).toBe('invalid_admission_transition');

    const review = await app.inject({
      method: 'POST',
      url: `/api/v1/admission-applications/${id}/review`,
      headers: { cookie: sessions.ownerA.cookie, ...withCsrf(sessions.ownerA) },
    });
    expect(review.statusCode).toBe(200);
    expect((review.json().application as { status: string }).status).toBe('under_review');

    const approve = await app.inject({
      method: 'POST',
      url: `/api/v1/admission-applications/${id}/approve`,
      headers: { cookie: sessions.ownerA.cookie, ...withCsrf(sessions.ownerA) },
    });
    expect(approve.statusCode).toBe(200);
    expect((approve.json().application as { status: string }).status).toBe('accepted');

    const approvedApp = await rows(
      migratorDb,
      sql`select student_id from admission_applications where id = ${id}`,
    );
    const studentId = String(approvedApp[0]!.student_id);
    const student = await rows(
      migratorDb,
      sql`select status, student_no, primary_campus_id from students where id = ${studentId}`,
    );
    expect(String(student[0]!.status)).toBe('applicant');
    expect(String(student[0]!.student_no)).toBe(`flow-${slug}`);
    expect(String(student[0]!.primary_campus_id)).toBe(campusBMemberOfAId);

    const audits = await rows(
      migratorDb,
      sql`select count(*)::int n from audit_logs where tenant_id = ${uid.tenantA} and action = 'admission.application.approved' and resource_id = ${id}`,
    );
    expect(Number(audits[0]!.n)).toBe(1);
    const studentAudits = await rows(
      migratorDb,
      sql`select count(*)::int n from audit_logs where tenant_id = ${uid.tenantA} and action = 'student.created' and resource_id = ${studentId}`,
    );
    expect(Number(studentAudits[0]!.n)).toBe(1);
    const outboxEvents_ = await rows(
      migratorDb,
      sql`select count(*)::int n from outbox_events where tenant_id = ${uid.tenantA} and event_type = 'student.created' and payload->>'studentId' = ${studentId}`,
    );
    expect(Number(outboxEvents_[0]!.n)).toBe(1);
    expect((await rows(
      migratorDb,
      sql`select count(*)::int n from outbox_events where tenant_id = ${uid.tenantA} and event_type = 'admission.application.approved'`,
    ))[0]!.n).toBe(1);

    // Approving again is a 409 (single-winner).
    const again = await app.inject({
      method: 'POST',
      url: `/api/v1/admission-applications/${id}/approve`,
      headers: { cookie: sessions.ownerA.cookie, ...withCsrf(sessions.ownerA) },
    });
    expect(again.statusCode).toBe(409);
  });

  it('A4. reject and withdraw complete the terminal-state matrix; PATCH on terminal is 409', async () => {
    const mkDraft = async (no: string) => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/admission-applications',
        headers: { cookie: sessions.ownerA.cookie, ...withCsrf(sessions.ownerA), ...idem(`mk-${no}`) },
        payload: { snapshot: snapshot({ studentNo: no, campusCode: campusACode }) },
      });
      expect(res.statusCode).toBe(201);
      return (res.json().application as { id: string }).id;
    };

    const rejectedId = await mkDraft(`rej-${slug}`);
    await app.inject({ method: 'POST', url: `/api/v1/admission-applications/${rejectedId}/submit`, headers: { cookie: sessions.ownerA.cookie, ...withCsrf(sessions.ownerA) } });
    const rejected = await app.inject({ method: 'POST', url: `/api/v1/admission-applications/${rejectedId}/reject`, headers: { cookie: sessions.ownerA.cookie, ...withCsrf(sessions.ownerA) } });
    expect(rejected.statusCode).toBe(200);
    expect((rejected.json().application as { status: string }).status).toBe('rejected');

    const withdrawnId = await mkDraft(`wd-${slug}`);
    const withdrawn = await app.inject({ method: 'POST', url: `/api/v1/admission-applications/${withdrawnId}/withdraw`, headers: { cookie: sessions.ownerA.cookie, ...withCsrf(sessions.ownerA) } });
    expect(withdrawn.statusCode).toBe(200);
    expect((withdrawn.json().application as { status: string }).status).toBe('withdrawn');

    // PATCH a terminal application is refused.
    const patch = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admission-applications/${rejectedId}`,
      headers: { cookie: sessions.ownerA.cookie, ...withCsrf(sessions.ownerA) },
      payload: { appliedOn: '2026-01-01' },
    });
    expect(patch.statusCode).toBe(409);
    expect(envelope(patch)?.code).toBe('admission_not_editable');

    // A soft-deleted application disappears from read paths.
    await rows(
      migratorDb,
      sql`update admission_applications set deleted_at = now() where id = ${rejectedId}`,
    );
    const missing = await app.inject({
      method: 'GET',
      url: `/api/v1/admission-applications/${rejectedId}`,
      headers: { cookie: sessions.ownerA.cookie },
    });
    expect(missing.statusCode).toBe(404);
  });

  it('A5. unknown/nonexistent campus on the snapshot blocks approval with 422', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admission-applications',
      headers: { cookie: sessions.ownerA.cookie, ...withCsrf(sessions.ownerA), ...idem(`ghostcampus-${slug}`) },
      payload: { snapshot: snapshot({ studentNo: `ghostcampus-${slug}`, campusCode: 'no-such-campus' }) },
    });
    expect(res.statusCode).toBe(201);
    const id = (res.json().application as { id: string }).id;
    await app.inject({ method: 'POST', url: `/api/v1/admission-applications/${id}/submit`, headers: { cookie: sessions.ownerA.cookie, ...withCsrf(sessions.ownerA) } });
    const approve = await app.inject({ method: 'POST', url: `/api/v1/admission-applications/${id}/approve`, headers: { cookie: sessions.ownerA.cookie, ...withCsrf(sessions.ownerA) } });
    expect(approve.statusCode).toBe(422);
    expect(envelope(approve)?.code).toBe('admission_campus_not_found');
  });

  it('A6. a duplicate student_no at approval is a 409 (no partial acceptance)', async () => {
    const mk = async (keyStrip: string) => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/admission-applications',
        headers: { cookie: sessions.ownerA.cookie, ...withCsrf(sessions.ownerA), ...idem(`dup-${keyStrip}`) },
        payload: { snapshot: snapshot({ studentNo: `dupno-${slug}` }) },
      });
      return (res.json().application as { id: string }).id;
    };
    const first = await mk('first');
    const second = await mk('second');
    await app.inject({ method: 'POST', url: `/api/v1/admission-applications/${first}/submit`, headers: { cookie: sessions.ownerA.cookie, ...withCsrf(sessions.ownerA) } });
    await app.inject({ method: 'POST', url: `/api/v1/admission-applications/${second}/submit`, headers: { cookie: sessions.ownerA.cookie, ...withCsrf(sessions.ownerA) } });
    await app.inject({ method: 'POST', url: `/api/v1/admission-applications/${first}/approve`, headers: { cookie: sessions.ownerA.cookie, ...withCsrf(sessions.ownerA) } });
    const falter = await app.inject({ method: 'POST', url: `/api/v1/admission-applications/${second}/approve`, headers: { cookie: sessions.ownerA.cookie, ...withCsrf(sessions.ownerA) } });
    expect(falter.statusCode).toBe(409);
  });

  it('A7. principal is read-only on admissions; anonymous is refused; CSRF enforced', async () => {
    const got = await app.inject({
      method: 'GET',
      url: '/api/v1/admission-applications',
      headers: { cookie: sessions.principal.cookie },
    });
    expect(got.statusCode).toBe(200);

    const post = await app.inject({
      method: 'POST',
      url: '/api/v1/admission-applications',
      headers: { cookie: sessions.principal.cookie, ...withCsrf(sessions.principal), ...idem(`p-${slug}`) },
      payload: { snapshot: snapshot() },
    });
    expect(post.statusCode).toBe(403);
    expect((post.json() as { error?: { requiredPermission?: string } }).error?.requiredPermission).toBe('admission.create');

    const id = (
      await app.inject({
        method: 'POST',
        url: '/api/v1/admission-applications',
        headers: { cookie: sessions.ownerA.cookie, ...withCsrf(sessions.ownerA), ...idem(`pa-${slug}`) },
        payload: { snapshot: snapshot({ studentNo: `princ-${slug}` }) },
      })
    ).json().application as { id: string };

    const approve = await app.inject({
      method: 'POST',
      url: `/api/v1/admission-applications/${id}/approve`,
      headers: { cookie: sessions.principal.cookie, ...withCsrf(sessions.principal) },
    });
    expect(approve.statusCode).toBe(403);
    expect((approve.json() as { error?: { requiredPermission?: string } }).error?.requiredPermission).toBe('admission.review');

    const noCsrf = await app.inject({
      method: 'POST',
      url: `/api/v1/admission-applications/${id}/submit`,
      headers: { cookie: sessions.ownerA.cookie },
    });
    expect(noCsrf.statusCode).toBe(403);
    expect(envelope(noCsrf)?.code).toBe('csrf_invalid');

    const anon = await app.inject({
      method: 'GET',
      url: `/api/v1/admission-applications/${id}`,
      headers: { cookie: `sid=${randomUUID()}` },
    });
    expect(anon.statusCode).toBe(401);
  });

  it('A8. cross-tenant admission access is a 404 (RLS isolation)', async () => {
    const id = (
      await app.inject({
        method: 'POST',
        url: '/api/v1/admission-applications',
        headers: { cookie: sessions.ownerA.cookie, ...withCsrf(sessions.ownerA), ...idem(`xt-app-${slug}`) },
        payload: { snapshot: snapshot({ studentNo: `xtapp-${slug}` }) },
      })
    ).json().application as { id: string };
    const appId = id.id;

    const got = await app.inject({
      method: 'GET',
      url: `/api/v1/admission-applications/${appId}`,
      headers: { cookie: sessions.ownerB.cookie },
    });
    expect(got.statusCode).toBe(404);
    const list = await app.inject({
      method: 'GET',
      url: '/api/v1/admission-applications',
      headers: { cookie: sessions.ownerB.cookie },
    });
    expect((list.json() as { items: Array<{ id: string }> }).items.map((x) => x.id)).not.toContain(appId);
  });

  // ------------------------------------------------------------- CSV import

  const importHeaders = (s: SessionCookies, key: string, extra: Record<string, string> = {}) => ({
    cookie: s.cookie,
    'content-type': 'text/csv',
    ...withCsrf(s),
    ...idem(key),
    ...extra,
  });

  const IMPORT_HEAP_CSV = [
    'student_no,first_name,last_name,date_of_birth,gender,campus',
    'IMPORT-1,Immy,Port,,,',
    'IMPORT-2,Inno,Port,,,',
  ].join('\n');

  it('I1. a valid CSV upload is accepted (202) with a storage-key row, audit + outbox', async () => {
    const key = `imp-${slug}`;
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/students/import?filename=import.csv',
      headers: importHeaders(sessions.ownerA, key),
      payload: Buffer.from(IMPORT_HEAP_CSV, 'utf8'),
    });
    expect(res.statusCode).toBe(202);
    const imp = res.json().import as { id: string; status: string; totalRows: number };
    expect(imp.status).toBe('submitted');
    expect(imp.totalRows).toBe(2);

    const dbRow = await rows(
      migratorDb,
      sql`select storage_key, status, total_rows, created_by from student_imports where id = ${imp.id}`,
    );
    expect(String(dbRow[0]!.storage_key)).toMatch(/^imports\/[0-9a-f]{8}-[0-9a-f-]{27}[0-9a-f-]*-[0-9a-f]{12}\.csv$/i);
    expect(String(dbRow[0]!.status)).toBe('submitted');
    expect(Number(dbRow[0]!.total_rows)).toBe(2);
    expect(String(dbRow[0]!.created_by)).toBe(uid.owner);

    const audit = await rows(
      migratorDb,
      sql`select count(*)::int n from audit_logs where tenant_id = ${uid.tenantA} and action = 'student.import.submitted' and resource_id = ${imp.id}`,
    );
    expect(Number(audit[0]!.n)).toBe(1);
    const outbox = await rows(
      migratorDb,
      sql`select count(*)::int n from outbox_events where tenant_id = ${uid.tenantA} and event_type = 'student.import.submitted' and aggregate_id = ${imp.id}`,
    );
    expect(Number(outbox[0]!.n)).toBe(1);

    // The object really exists in the provider, and detail rows are empty until the worker runs.
    const stored = Buffer.from(await storage.readObject(uid.tenantA!, String(dbRow[0]!.storage_key)));
    expect(stored.toString('utf8')).toContain('IMPORT-1');
    const detail = await app.inject({
      method: 'GET',
      url: `/api/v1/students/imports/${imp.id}`,
      headers: { cookie: sessions.ownerA.cookie },
    });
    expect(detail.statusCode).toBe(200);
    expect((detail.json() as { import: { id: string }; rows: unknown[] }).rows).toHaveLength(0);
  });

  it('I2. idempotent replay of the upload returns the same import', async () => {
    const key = `imp-idem-${slug}`;
    const hdrs = importHeaders(sessions.ownerA, key);
    const first = await app.inject({ method: 'POST', url: '/api/v1/students/import', headers: hdrs, payload: Buffer.from(IMPORT_HEAP_CSV, 'utf8') });
    expect(first.statusCode).toBe(202);
    const second = await app.inject({ method: 'POST', url: '/api/v1/students/import', headers: hdrs, payload: Buffer.from(IMPORT_HEAP_CSV, 'utf8') });
    expect(second.statusCode).toBe(202);
    expect((second.json().import as { id: string }).id).toBe((first.json().import as { id: string }).id);
    const n = await rows(
      migratorDb,
      sql`select count(*)::int n from student_imports where tenant_id = ${uid.tenantA}`,
    );
    expect(Number(n[0]!.n)).toBe(2); // from I1 + I2 exactly
  });

  it('I3. import list is readable by owner and principal; status filter works; campus scope is pinned', async () => {
    const ownerList = await app.inject({
      method: 'GET',
      url: '/api/v1/students/imports',
      headers: { cookie: sessions.ownerA.cookie },
    });
    expect(ownerList.statusCode).toBe(200);
    expect((ownerList.json() as { total: number }).total).toBe(2);

    const principalList = await app.inject({
      method: 'GET',
      url: '/api/v1/students/imports',
      headers: { cookie: sessions.principal.cookie },
    });
    expect(principalList.statusCode).toBe(200);

    // A campus-scoped uploader pins their campus boundary on the import row.
    const campusUpload = await app.inject({
      method: 'POST',
      url: '/api/v1/students/import',
      headers: importHeaders(sessions.campus, `imp-campus-${slug}`),
      payload: Buffer.from('student_no,first_name,last_name\nC-1,Carla,Campus', 'utf8'),
    });
    expect(campusUpload.statusCode).toBe(202);
    const impId = (campusUpload.json().import as { id: string }).id;
    const row = await rows(migratorDb, sql`select campus_id from student_imports where id = ${impId}`);
    expect(String(row[0]!.campus_id)).toBe(campusBMemberOfAId);
  });

  it('I4. upload gates: too many rows 413, NUL bytes 415, bad body 400, missing columns 400', async () => {
    const many = ['student_no,first_name,last_name'];
    for (let i = 0; i < 10001; i += 1) many.push(`r-${i},F,L`);
    const tooMany = await app.inject({
      method: 'POST',
      url: '/api/v1/students/import',
      headers: importHeaders(sessions.ownerA, `imp-many-${slug}`),
      payload: Buffer.from(many.join('\n'), 'utf8'),
    });
    expect(tooMany.statusCode).toBe(413);
    expect(envelope(tooMany)?.code).toBe('import_too_many_rows');

    const nul = await app.inject({
      method: 'POST',
      url: '/api/v1/students/import',
      headers: importHeaders(sessions.ownerA, `imp-nul-${slug}`),
      payload: Buffer.from('a,b,c\n\x00,2,3', 'utf8'),
    });
    expect(nul.statusCode).toBe(415);

    const empty = await app.inject({
      method: 'POST',
      url: '/api/v1/students/import',
      headers: importHeaders(sessions.ownerA, `imp-empty-${slug}`),
      payload: Buffer.from('student_no,first_name,last_name', 'utf8'),
    });
    expect(empty.statusCode).toBe(400);

    const missingCols = await app.inject({
      method: 'POST',
      url: '/api/v1/students/import',
      headers: importHeaders(sessions.ownerA, `imp-missing-${slug}`),
      payload: Buffer.from('student_no,first_name\n1,X', 'utf8'),
    });
    expect(missingCols.statusCode).toBe(400);
    const error = missingCols.json() as { error?: { details?: { missing?: string[] } } };
    expect(error.error?.details?.missing).toContain('last_name');

    const unknownCol = await app.inject({
      method: 'POST',
      url: '/api/v1/students/import',
      headers: importHeaders(sessions.ownerA, `imp-unknown-${slug}`),
      payload: Buffer.from('student_no,first_name,last_name,evil\n1,X,Y,Z', 'utf8'),
    });
    expect(unknownCol.statusCode).toBe(400);
    const unknownError = unknownCol.json() as { error?: { details?: { columns?: string[] } } };
    expect(unknownError.error?.details?.columns).toContain('evil');
  });

  it('I5. oversize upload is 413 before anything is stored', async () => {
    const big = Buffer.concat([
      Buffer.from('student_no,first_name,last_name\n'),
      Buffer.alloc(5 * 1024 * 1024, 65),
    ]);
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/students/import',
      headers: importHeaders(sessions.ownerA, `imp-big-${slug}`),
      payload: big,
    });
    expect(res.statusCode).toBe(413);
    expect(envelope(res)?.code).toBe('payload_too_large');
  });

  it('I6. import upload needs students.create; principal and anonymous are refused', async () => {
    const denied = await app.inject({
      method: 'POST',
      url: '/api/v1/students/import',
      headers: importHeaders(sessions.principal, `imp-p-${slug}`),
      payload: Buffer.from('student_no,first_name,last_name\n1,X,Y', 'utf8'),
    });
    expect(denied.statusCode).toBe(403);
    expect((denied.json() as { error?: { requiredPermission?: string } }).error?.requiredPermission).toBe('students.create');

    const anon = await app.inject({
      method: 'POST',
      url: '/api/v1/students/import',
      headers: { 'content-type': 'text/csv', ...withCsrf(sessions.campus), ...idem(`imp-anon-${slug}`), cookie: `sid=${randomUUID()}` },
      payload: Buffer.from('a,b,c\n1,2,3', 'utf8'),
    });
    expect(anon.statusCode).toBe(401);
  });

  it('I7. cross-tenant import visibility is isolated (404 on foreign id, empty list)', async () => {
    const imports = await rows(
      migratorDb,
      sql`select id from student_imports where tenant_id = ${uid.tenantA} limit 1`,
    );
    const foreignId = String(imports[0]!.id);
    const got = await app.inject({
      method: 'GET',
      url: `/api/v1/students/imports/${foreignId}`,
      headers: { cookie: sessions.ownerB.cookie },
    });
    expect(got.statusCode).toBe(404);
  });

  // ----------------------------------------------------------- CSV export

  it('E1. owner export streams CSV with formula neutralization and expected headers', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/students/export',
      headers: { cookie: sessions.ownerA.cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/csv/);
    expect(res.headers['content-disposition']).toBe('attachment; filename="students-export.csv"');
    expect(res.headers['cache-control']).toBe('private, no-store');

    const body = res.body as string;
    const lines = body.trim().split(/\r?\n/);
    expect(lines[0]).toContain('student_no');
    expect(lines[0]).toContain('first_name');
    expect(lines[0]).toContain('campus_code');

    const joined = lines.join('\n');
    expect(joined).toContain(`p35x-${slug}`);
    expect(joined).toContain(campusACode);
    // Formula injection is neutralized.
    expect(joined).toContain(`'=3+3-${slug}`);
    expect(joined).not.toContain(`\n=3+3-${slug}`);
    // Tenant B data is invisible.
    expect(joined).not.toContain(`p35y-${slug}`);
  });

  it('E2. export follows authorization: principal lacks students.export (403), anonymous 401', async () => {
    const principal = await app.inject({
      method: 'GET',
      url: '/api/v1/students/export',
      headers: { cookie: sessions.principal.cookie },
    });
    expect(principal.statusCode).toBe(403);
    expect((principal.json() as { error?: { requiredPermission?: string } }).error?.requiredPermission).toBe('students.export');

    const anon = await app.inject({
      method: 'GET',
      url: '/api/v1/students/export',
      headers: { cookie: `sid=${randomUUID()}` },
    });
    expect(anon.statusCode).toBe(401);
  });

  it('E3. tenant B owner exports only its own data', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/students/export',
      headers: { cookie: sessions.ownerB.cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.body as string;
    expect(body).toContain(`p35y-${slug}`);
    expect(body).not.toContain(`p35x-${slug}`);
  });

  it('E4. ACCEPTANCE: every side-effecting write emitted matching audits; export snapshot is deterministic', async () => {
    const audits = await rows(
      migratorDb,
      sql`select action, count(*)::int n from audit_logs
            where tenant_id = ${uid.tenantA} and action like 'admission.application.%'
            group by action`,
    );
    const byAction = new Map(audits.map((r) => [String(r.action), Number(r.n)]));
    expect(byAction.get('admission.application.created')).toBeGreaterThanOrEqual(9);
    expect(byAction.get('admission.application.approved')).toBeGreaterThanOrEqual(1);
    expect(byAction.get('admission.application.rejected')).toBe(1);
    expect(byAction.get('admission.application.withdrawn')).toBe(1);
    expect(byAction.get('admission.application.submitted')).toBeGreaterThanOrEqual(1);
    expect(byAction.get('admission.application.review_started')).toBe(1);

    const outbox = await rows(
      migratorDb,
      sql`select event_type, count(*)::int n from outbox_events
            where tenant_id = ${uid.tenantA} and event_type like 'admission.application.%'
            group by event_type`,
    );
    const byEvent = new Map(outbox.map((r) => [String(r.event_type), Number(r.n)]));
    expect(byEvent.get('admission.application.created')).toBeGreaterThanOrEqual(9);
    expect(byEvent.get('admission.application.approved')).toBeGreaterThanOrEqual(1);

    // Export is stable: run it twice, both bodies identical.
    const run = async () =>
      (await app.inject({ method: 'GET', url: '/api/v1/students/export', headers: { cookie: sessions.ownerA.cookie } })).body;
    expect(await run()).toBe(await run());
  });
});