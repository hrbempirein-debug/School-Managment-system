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
 * HTTP-level school-domain contract proofs against the ACTUAL Fastify
 * application (`buildApp`), the real dev PostgreSQL database under the real
 * `school_app_rw` role, and the LIVE Redis server (127.0.0.1:6379, verified
 * reachable). @fastify/rate-limit's RedisStore auto-defines its `rateLimit`
 * command on the provided ioredis client, so sessions and the global rate
 * limiter both run against real Redis.
 *
 * Proves: the tenant/permission boundaries wired to each of the eight school
 * domains, CSRF on every state-changing route, idempotent creation (same-tenant
 * replay + cross-tenant key isolation), the domain-error mapping (conflict /
 * validation_error / academic_year_has_open_terms …), cross-tenant 404s, the
 * soft-delete path, and the settings singleton, which is intentionally gated by
 * `school.settings.manage` (read+update combined; principal has no role here).
 *
 * Opt-in: RUN_RUNTIME_SECURITY_TESTS=1 (requires PostgreSQL + migrations
 * 0001..0004 + live Redis).
 */
const enabled = process.env.RUN_RUNTIME_SECURITY_TESTS === '1';
const describeDb = enabled ? describe : describe.skip;

const stubStorage = {
  async readObject(): Promise<Buffer> {
    throw new Error('files route should deny before storage is consulted');
  },
} as unknown as StorageProvider;

interface SessionCookies {
  token: string;
  csrf: string;
  cookie: string;
}

describeDb('API school-domain contracts (real app + real DB + live Redis, HTTP-level)', () => {
  let migratorDb: Db;
  let appDb: Db;
  let redis: Redis;
  let endMigrator: () => Promise<void>;
  let endApp: () => Promise<void>;
  let endRedis: () => Promise<unknown>;
  let app: Awaited<ReturnType<typeof buildApp>>;

  const uid: Record<string, string> = {};
  const slug = `sd${randomUUID().slice(0, 8)}`;
  const sessions: Record<'a' | 'b' | 'parent' | 'principal' | 'platform', SessionCookies> = {} as never;
  let campusAId = '';
  let yearAId = '';

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
    uid.principal = randomUUID();
    uid.platform = randomUUID();
    uid.platRole = randomUUID();
    uid.ownerEmail = `owner-${slug}@example.com`;
    uid.parentEmail = `parent-${slug}@example.com`;
    uid.principalEmail = `principal-${slug}@example.com`;
    uid.platformEmail = `platform-${slug}@example.com`;
    uid.otherTenant = randomUUID();

    // Platform role (tenant bootstrap + platform-only operator).
    await rows(
      migratorDb,
      sql`insert into roles (id, scope, code, name, is_system) values (${uid.platRole}, 'platform', ${`sdp${slug}_plat`}, 'Test Platform Admin', true)`,
    );
    await rows(
      migratorDb,
      sql`insert into role_permissions (role_id, permission) values (${uid.platRole}, 'platform.tenants.read'), (${uid.platRole}, 'platform.tenants.create')`,
    );

    // 1) Platform user who bootstraps two tenants and is owner of both.
    await rows(migratorDb, sql`insert into users (id, email) values (${uid.owner}, ${uid.ownerEmail})`);
    await rows(
      migratorDb,
      sql`insert into platform_role_assignments (user_id, role_id) values (${uid.owner}, ${uid.platRole})`,
    );

    // 2) Platform-only operator - deliberately no tenant membership.
    await rows(
      migratorDb,
      sql`insert into users (id, email) values (${uid.platform}, ${uid.platformEmail})`,
    );
    await rows(
      migratorDb,
      sql`insert into platform_role_assignments (user_id, role_id) values (${uid.platform}, ${uid.platRole})`,
    );

    // 3) Two real tenants with the Phase 2B owner template (school_owner grants
    //    every school-domain permission to uid.owner in both tenants).
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
      createTenantTransaction(tx, platformCtx(uid.owner!), { slug: `${slug}-a`, name: 'School Domain A', requestId: randomUUID() }),
    );
    uid.tenantA = createdA.tenantId;
    const createdB = await withTenant(appDb, platformCtx(uid.owner!), (tx) =>
      createTenantTransaction(tx, platformCtx(uid.owner!), { slug: `${slug}-b`, name: 'School Domain B', requestId: randomUUID() }),
    );
    uid.tenantB = createdB.tenantId;

    // 5) Principal member of tenant A: the seeded read-mostly school template.
    await rows(
      migratorDb,
      sql`insert into users (id, email) values (${uid.principal}, ${uid.principalEmail})`,
    );
    const principalRole = await rows(
      migratorDb,
      sql`select id from roles where tenant_id = ${uid.tenantA} and code = 'principal'`,
    );
    const principalRoleId = String(principalRole[0]!.id);
    const principalMembershipRows = await rows(
      migratorDb,
      sql`insert into memberships (id, tenant_id, user_id, status) values (${randomUUID()}, ${uid.tenantA}, ${uid.principal}, 'active') returning id`,
    );
    uid.principalMembership = String(principalMembershipRows[0]!.id);
    await rows(
      migratorDb,
      sql`insert into membership_roles (membership_id, role_id) values (${uid.principalMembership}, ${principalRoleId})`,
    );

    // 4) Parent member of tenant A: parent role only (no school permissions).
    await rows(migratorDb, sql`insert into users (id, email) values (${uid.parent}, ${uid.parentEmail})`);
    const parentRole = await rows(
      migratorDb,
      sql`select id from roles where tenant_id = ${uid.tenantA} and code = 'parent'`,
    );
    const parentRoleId = String(parentRole[0]!.id);
    const parentMembershipRows = await rows(
      migratorDb,
      sql`insert into memberships (id, tenant_id, user_id, status) values (${randomUUID()}, ${uid.tenantA}, ${uid.parent}, 'active') returning id`,
    );
    uid.parentMembership = String(parentMembershipRows[0]!.id);
    await rows(
      migratorDb,
      sql`insert into membership_roles (membership_id, role_id) values (${uid.parentMembership}, ${parentRoleId})`,
    );

    // 6) Sessions: owner in tenant A and tenant B (cross-tenant probe), parent
    //    in A, principal in A, platform-only operator pointing at A (denied at
    //    membership).
    sessions.a = await makeSession(uid.owner!, uid.tenantA!);
    sessions.b = await makeSession(uid.owner!, uid.tenantB!);
    sessions.parent = await makeSession(uid.parent!, uid.tenantA!);
    sessions.principal = await makeSession(uid.principal!, uid.tenantA!);
    sessions.platform = await makeSession(uid.platform!, uid.tenantA!);

    app = await buildApp({
      deps: { db: appDb, redis, storage: stubStorage },
      logger: false,
    });
  });

  afterAll(async () => {
    try {
      if (app) await app.close();
      const tenantIds = [uid.tenantA!, uid.tenantB!];
      const tIn = tenantIds.map((t) => (t ? `'${t}'` : '')).join(',');
      await rows(
        migratorDb,
        sql`delete from outbox_events where tenant_id in (${sql.raw(tIn)})`,
      );
      // audit_logs is append-only by design (0001: INSERT + SELECT policies only, no
      // DELETE policy), so its rows cannot be removed - even by the privileged migrator
      // role. Count assertions are per-tenant/action and RLS-isolated, so accumulation
      // is harmless. idempotency_keys does have a privileged DELETE policy and IS removed.
      await rows(
        migratorDb,
        sql`delete from idempotency_keys where tenant_id in (${sql.raw(tIn)})`,
      );
      await rows(
        migratorDb,
        sql`delete from membership_roles where membership_id in (select id from memberships where tenant_id in (${sql.raw(tIn)}) or user_id in (${uid.parent}, ${uid.principal}))`,
      );
      await rows(
        migratorDb,
        sql`delete from role_permissions where role_id in (select id from roles where tenant_id in (${sql.raw(tIn)}) or id = ${uid.platRole})`,
      );
      await rows(
        migratorDb,
        sql`delete from memberships where tenant_id in (${sql.raw(tIn)}) or user_id in (${uid.parent}, ${uid.principal})`,
      );
      await rows(
        migratorDb,
        sql`delete from platform_role_assignments where user_id in (${uid.owner}, ${uid.platform})`,
      );
      await rows(migratorDb, sql`delete from roles where tenant_id in (${sql.raw(tIn)}) or id = ${uid.platRole}`);
      await rows(
        migratorDb,
        sql`delete from users where id in (${uid.owner}, ${uid.parent}, ${uid.principal}, ${uid.platform})`,
      );
      await rows(migratorDb, sql`delete from tenants where id in (${sql.raw(tIn)})`);
    } finally {
      await endMigrator();
      await endApp();
      await endRedis?.();
    }
  });

  // ---------------------------------------------------------------- boundary

  it('rejects anonymous callers on school endpoints (401, before permission logic)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/campuses' });
    expect(res.statusCode).toBe(401);
    expect(envelope(res)?.code).toBe('unauthenticated');
  });

  it('denies a platform-only operator tenant endpoints (cross-boundary)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/campuses',
      headers: { cookie: sessions.platform.cookie },
    });
    expect(res.statusCode).toBe(403);
    expect(envelope(res)?.code).toBe('forbidden');
    expect(envelope(res)?.message).toBe('Tenant access denied');
  });

  it('reports the school-domain routes in the post-boot authorization matrix with HEAD twins', async () => {
    const byRoute = new Map(
      app.routeAuthorizationMatrix().routes.map((r) => [`${r.method} ${r.url}`, r]),
    );
    const primary: Record<string, string> = {
      'GET /api/v1/campuses': 'campus.read',
      'POST /api/v1/campuses': 'campus.create',
      'GET /api/v1/campuses/:id': 'campus.read',
      'PATCH /api/v1/campuses/:id': 'campus.update',
      'POST /api/v1/campuses/:id/activate': 'campus.update',
      'POST /api/v1/campuses/:id/deactivate': 'campus.update',
      'GET /api/v1/academic-years': 'academic.years.read',
      'POST /api/v1/academic-years': 'academic.years.write',
      'POST /api/v1/academic-years/:id/open': 'academic.years.write',
      'POST /api/v1/academic-years/:id/close': 'academic.years.write',
      'GET /api/v1/academic-years/:academicYearId/terms': 'academic.terms.read',
      'POST /api/v1/academic-years/:academicYearId/terms': 'academic.terms.write',
      'POST /api/v1/academic-terms/:id/open': 'academic.terms.write',
      'POST /api/v1/academic-terms/:id/close': 'academic.terms.write',
      'GET /api/v1/holidays': 'calendar.read',
      'POST /api/v1/holidays': 'calendar.write',
      'DELETE /api/v1/holidays/:id': 'calendar.write',
      'GET /api/v1/calendars': 'calendar.read',
      'POST /api/v1/calendars': 'calendar.write',
      'DELETE /api/v1/calendars/:id': 'calendar.write',
      'GET /api/v1/calendars/:calendarId/events': 'calendar.read',
      'POST /api/v1/calendars/:calendarId/events': 'calendar.write',
      'GET /api/v1/calendar-events/:id': 'calendar.read',
      'DELETE /api/v1/calendar-events/:id': 'calendar.write',
      'GET /api/v1/departments': 'departments.read',
      'POST /api/v1/departments': 'departments.write',
      'POST /api/v1/departments/:id/activate': 'departments.write',
      'POST /api/v1/departments/:id/deactivate': 'departments.write',
      'GET /api/v1/settings': 'school.settings.manage',
      'PATCH /api/v1/settings': 'school.settings.manage',
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

  // ------------------------------------------------------------- permissions

  it('maps each school endpoint to its documented permission (parent denied with requiredPermission)', async () => {
    const cases: Array<{ method: 'GET' | 'POST' | 'PATCH'; url: string; perm: string }> = [
      { method: 'GET', url: '/api/v1/campuses', perm: 'campus.read' },
      { method: 'POST', url: '/api/v1/campuses', perm: 'campus.create' },
      { method: 'PATCH', url: '/api/v1/campuses/00000000-0000-0000-0000-000000000000', perm: 'campus.update' },
      { method: 'GET', url: '/api/v1/academic-years', perm: 'academic.years.read' },
      { method: 'POST', url: '/api/v1/academic-years', perm: 'academic.years.write' },
      { method: 'GET', url: '/api/v1/holidays', perm: 'calendar.read' },
      { method: 'POST', url: '/api/v1/calendars', perm: 'calendar.write' },
      { method: 'GET', url: '/api/v1/departments', perm: 'departments.read' },
      { method: 'POST', url: '/api/v1/departments', perm: 'departments.write' },
      { method: 'GET', url: '/api/v1/settings', perm: 'school.settings.manage' },
      { method: 'PATCH', url: '/api/v1/settings', perm: 'school.settings.manage' },
      { method: 'GET', url: '/api/v1/enrollments', perm: 'enrollment.read' },
      { method: 'POST', url: '/api/v1/promotion-batches', perm: 'enrollment.manage' },
      { method: 'POST', url: '/api/v1/students/00000000-0000-0000-0000-000000000000/enroll', perm: 'enrollment.manage' },
    ];
    for (const c of cases) {
      const res = await app.inject({
        method: c.method,
        url: c.url,
        headers: { cookie: sessions.parent.cookie },
      });
      expect(res.statusCode, `${c.method} ${c.url}`).toBe(403);
      expect(envelope(res)?.code, `${c.method} ${c.url}`).toBe('forbidden');
      expect(envelope(res)?.requiredPermission, `${c.method} ${c.url}`).toBe(c.perm);
    }
  });

  it('still requires the CSRF double-submit token on state-changing school endpoints', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/campuses',
      headers: { cookie: sessions.a.cookie, ...idem('no-csrf-${slug}') },
      payload: { code: `nocsrf-${slug}`, name: 'No CSRF' },
    });
    expect(res.statusCode).toBe(403);
    expect(envelope(res)?.code).toBe('csrf_invalid');
  });

  // ---------------------------------------------------------- happy path + idem

  it('owner can create, list and fetch a campus (201/200/200) with audit + outbox rows', async () => {
    const headers = { cookie: sessions.a.cookie, ...withCsrf(sessions.a), ...idem(`campus-1-${slug}`) };
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/campuses',
      headers,
      payload: { code: `c1-${slug}`, name: 'Main Campus', city: 'Paris' },
    });
    expect(created.statusCode).toBe(201);
    const campus = (created.json().campus as { id: string; tenantId: string; code: string }).id;
    campusAId = campus;
    expect(created.json().campus.tenantId).toBe(uid.tenantA);

    const listed = await app.inject({
      method: 'GET',
      url: '/api/v1/campuses',
      headers: { cookie: sessions.a.cookie },
    });
    expect(listed.statusCode).toBe(200);
    const body = listed.json() as { items: { code: string }[]; total: number };
    expect(body.items.map((i) => i.code)).toContain(`c1-${slug}`);

    const fetched = await app.inject({
      method: 'GET',
      url: `/api/v1/campuses/${campusAId}`,
      headers: { cookie: sessions.a.cookie },
    });
    expect(fetched.statusCode).toBe(200);
    expect((fetched.json().campus as { city: string | null }).city).toBe('Paris');

    const audit = await rows(
      migratorDb,
      sql`select count(*)::int n from audit_logs where tenant_id = ${uid.tenantA} and action = 'campus.created'`,
    );
    const outbox = await rows(
      migratorDb,
      sql`select count(*)::int n from outbox_events where tenant_id = ${uid.tenantA} and event_type = 'campus.created'`,
    );
    expect(Number(audit[0]!.n)).toBe(1);
    expect(Number(outbox[0]!.n)).toBe(1);
  });

  it('replays an identical POST under the same idempotency key instead of duplicating', async () => {
    const headers = { cookie: sessions.a.cookie, ...withCsrf(sessions.a), ...idem(`campus-2-${slug}`) };
    const first = await app.inject({
      method: 'POST',
      url: '/api/v1/campuses',
      headers,
      payload: { code: `c2-${slug}`, name: 'Idempotent Campus' },
    });
    expect(first.statusCode).toBe(201);
    const rerequest = await app.inject({
      method: 'POST',
      url: '/api/v1/campuses',
      headers,
      payload: { code: `c2-${slug}`, name: 'Idempotent Campus' },
    });
    // withIdempotency replays the STORED response verbatim, so the replay is 201.
    expect(rerequest.statusCode).toBe(201);
    expect((rerequest.json() as { id: string }).id).toBe((first.json() as { id: string }).id);
    const count = await rows(
      migratorDb,
      sql`select count(*)::int n from campuses where tenant_id = ${uid.tenantA} and code = ${`c2-${slug}`}`,
    );
    expect(Number(count[0]!.n)).toBe(1);
  });

  it('isolates idempotency keys per tenant (same key creates a row in the other tenant)', async () => {
    const key = `campus-shared-${slug}`;
    const inA = await app.inject({
      method: 'POST',
      url: '/api/v1/campuses',
      headers: { cookie: sessions.a.cookie, ...withCsrf(sessions.a), ...idem(key) },
      payload: { code: `ca-${slug}`, name: 'In A' },
    });
    const inB = await app.inject({
      method: 'POST',
      url: '/api/v1/campuses',
      headers: { cookie: sessions.b.cookie, ...withCsrf(sessions.b), ...idem(key) },
      payload: { code: `ca-${slug}`, name: 'In B' },
    });
    expect(inA.statusCode).toBe(201);
    expect(inB.statusCode).toBe(201);
    const aCount = await rows(
      migratorDb,
      sql`select count(*)::int n from campuses where tenant_id = ${uid.tenantA} and code = ${`ca-${slug}`}`,
    );
    const bCount = await rows(
      migratorDb,
      sql`select count(*)::int n from campuses where tenant_id = ${uid.tenantB} and code = ${`ca-${slug}`}`,
    );
    expect(Number(aCount[0]!.n)).toBe(1);
    expect(Number(bCount[0]!.n)).toBe(1);
  });

  // ------------------------------------------------------------- domain rules

  it('maps a duplicate unique code to 409 conflict', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/campuses',
      headers: { cookie: sessions.a.cookie, ...withCsrf(sessions.a), ...idem(`dup-${slug}`) },
      payload: { code: `c1-${slug}`, name: 'Duplicate' },
    });
    expect(res.statusCode).toBe(409);
    expect(envelope(res)?.code).toBe('conflict');
  });

  it('rejects an academic year with inverted dates as validation_error', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/academic-years',
      headers: { cookie: sessions.a.cookie, ...withCsrf(sessions.a), ...idem(`bad-year-${slug}`) },
      payload: { code: `by-${slug}`, name: 'Bad', startsOn: '2026-12-31', endsOn: '2026-01-01' },
    });
    expect(res.statusCode).toBe(400);
    expect(envelope(res)?.code).toBe('validation_error');
  });

  it('maps domain-rule trigger violations (open-term-in-year, close-with-open-terms)', async () => {
    // year -> open -> term inside -> open term -> close year must be blocked.
    const year = await app.inject({
      method: 'POST',
      url: '/api/v1/academic-years',
      headers: { cookie: sessions.a.cookie, ...withCsrf(sessions.a), ...idem(`yr-${slug}`) },
      payload: { code: `yr-${slug}`, name: 'AY', startsOn: '2026-01-01', endsOn: '2026-12-31' },
    });
    expect(year.statusCode).toBe(201);
    yearAId = (year.json().academicYear as { id: string }).id;

    const opened = await app.inject({
      method: 'POST',
      url: `/api/v1/academic-years/${yearAId}/open`,
      headers: { cookie: sessions.a.cookie, ...withCsrf(sessions.a) },
    });
    expect(opened.statusCode).toBe(200);

    const term = await app.inject({
      method: 'POST',
      url: `/api/v1/academic-years/${yearAId}/terms`,
      headers: { cookie: sessions.a.cookie, ...withCsrf(sessions.a), ...idem(`t1-${slug}`) },
      payload: { code: `t1-${slug}`, name: 'Term 1', sequence: 1, startsOn: '2026-02-01', endsOn: '2026-06-30' },
    });
    expect(term.statusCode).toBe(201);
    const termId = (term.json().academicTerm as { id: string }).id;

    const termOpen = await app.inject({
      method: 'POST',
      url: `/api/v1/academic-terms/${termId}/open`,
      headers: { cookie: sessions.a.cookie, ...withCsrf(sessions.a) },
    });
    expect(termOpen.statusCode).toBe(200);

    const termOutside = await app.inject({
      method: 'POST',
      url: `/api/v1/academic-years/${yearAId}/terms`,
      headers: { cookie: sessions.a.cookie, ...withCsrf(sessions.a), ...idem(`tout-${slug}`) },
      payload: { code: `tout-${slug}`, name: 'Outside', sequence: 9, startsOn: '2025-02-01', endsOn: '2025-06-30' },
    });
    expect(termOutside.statusCode).toBe(409);
    expect(envelope(termOutside)?.code).toBe('term_outside_academic_year');

    const closed = await app.inject({
      method: 'POST',
      url: `/api/v1/academic-years/${yearAId}/close`,
      headers: { cookie: sessions.a.cookie, ...withCsrf(sessions.a) },
    });
    expect(closed.statusCode).toBe(409);
    expect(envelope(closed)?.code).toBe('academic_year_has_open_terms');
  });

  // ------------------------------------------------------- cross-tenant access

  it('denies cross-tenant reads even for an authorized owner (404 not_found)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/campuses/${campusAId}`,
      headers: { cookie: sessions.b.cookie },
    });
    expect(res.statusCode).toBe(404);
    expect(envelope(res)?.code).toBe('not_found');
    const list = await app.inject({
      method: 'GET',
      url: '/api/v1/campuses',
      headers: { cookie: sessions.b.cookie },
    });
    const codes = (list.json() as { items: { code: string }[] }).items.map((i) => i.code);
    expect(codes).not.toContain(`c1-${slug}`);
  });

  it('cross-tenant writes fail: PATCHing another tenant campus returns 404', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/campuses/${campusAId}`,
      headers: { cookie: sessions.b.cookie, ...withCsrf(sessions.b), ...idem(`xp-${slug}`) },
      payload: { name: 'Hacked' },
    });
    expect(res.statusCode).toBe(404);
    expect(envelope(res)?.code).toBe('not_found');
  });

  // ------------------------------------------------------ holidays + settings

  it('walks the holiday lifecycle: create, soft-delete, hide', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/holidays',
      headers: { cookie: sessions.a.cookie, ...withCsrf(sessions.a), ...idem(`hol-${slug}`) },
      payload: { name: 'Exam Break', startsOn: '2026-07-01', endsOn: '2026-07-05' },
    });
    expect(created.statusCode).toBe(201);
    const holidayId = (created.json().holiday as { id: string }).id;

    const deleted = await app.inject({
      method: 'DELETE',
      url: `/api/v1/holidays/${holidayId}`,
      headers: { cookie: sessions.a.cookie, ...withCsrf(sessions.a) },
    });
    expect(deleted.statusCode).toBe(204);

    const fetched = await app.inject({
      method: 'GET',
      url: `/api/v1/holidays/${holidayId}`,
      headers: { cookie: sessions.a.cookie },
    });
    expect(fetched.statusCode).toBe(404);

    const count = await rows(
      migratorDb,
      sql`select count(*)::int n from holidays where id = ${holidayId} and deleted_at is not null`,
    );
    expect(Number(count[0]!.n)).toBe(1);
  });

  it('serves settings via get-or-create and honours the manage gate on PATCH', async () => {
    const fetched = await app.inject({
      method: 'GET',
      url: '/api/v1/settings',
      headers: { cookie: sessions.a.cookie },
    });
    expect(fetched.statusCode).toBe(200);
    expect((fetched.json().settings as { tenantId: string }).tenantId).toBe(uid.tenantA);

    const patched = await app.inject({
      method: 'PATCH',
      url: '/api/v1/settings',
      headers: { cookie: sessions.a.cookie, ...withCsrf(sessions.a) },
      payload: { schoolName: `School ${slug}` },
    });
    expect(patched.statusCode).toBe(200);
    expect((patched.json().settings as { schoolName: string }).schoolName).toBe(`School ${slug}`);

    const reread = await app.inject({
      method: 'GET',
      url: '/api/v1/settings',
      headers: { cookie: sessions.a.cookie },
    });
    expect((reread.json().settings as { schoolName: string }).schoolName).toBe(`School ${slug}`);

    const parent = await app.inject({
      method: 'GET',
      url: '/api/v1/settings',
      headers: { cookie: sessions.parent.cookie },
    });
    expect(parent.statusCode).toBe(403);
    expect(envelope(parent)?.requiredPermission).toBe('school.settings.manage');
  });

  // ------------------------------------------------ nested parent ownership

  it('enforces academic-year parent ownership on the nested terms collection (404 + real total)', async () => {
    const year = await app.inject({
      method: 'POST',
      url: '/api/v1/academic-years',
      headers: { cookie: sessions.a.cookie, ...withCsrf(sessions.a), ...idem(`ptyr-${slug}`) },
      payload: { code: `ptyr-${slug}`, name: 'Parent Year', startsOn: '2026-01-01', endsOn: '2026-12-31' },
    });
    expect(year.statusCode).toBe(201);
    const yearId = (year.json().academicYear as { id: string }).id;
    const opened = await app.inject({
      method: 'POST',
      url: `/api/v1/academic-years/${yearId}/open`,
      headers: { cookie: sessions.a.cookie, ...withCsrf(sessions.a) },
    });
    expect(opened.statusCode).toBe(200);
    const term = await app.inject({
      method: 'POST',
      url: `/api/v1/academic-years/${yearId}/terms`,
      headers: { cookie: sessions.a.cookie, ...withCsrf(sessions.a), ...idem(`ptt1-${slug}`) },
      payload: { code: `ptt1-${slug}`, name: 'Parent Term', sequence: 1, startsOn: '2026-02-01', endsOn: '2026-06-30' },
    });
    expect(term.statusCode).toBe(201);

    const own = await app.inject({
      method: 'GET',
      url: `/api/v1/academic-years/${yearId}/terms?limit=1&offset=0`,
      headers: { cookie: sessions.a.cookie },
    });
    expect(own.statusCode).toBe(200);
    const ownBody = own.json() as { items: unknown[]; total: number };
    expect(ownBody.items).toHaveLength(1);
    expect(ownBody.total).toBe(1);

    const missing = await app.inject({
      method: 'GET',
      url: `/api/v1/academic-years/${randomUUID()}/terms`,
      headers: { cookie: sessions.a.cookie },
    });
    expect(missing.statusCode).toBe(404);
    expect(envelope(missing)?.code).toBe('not_found');

    const foreign = await app.inject({
      method: 'GET',
      url: `/api/v1/academic-years/${yearId}/terms`,
      headers: { cookie: sessions.b.cookie },
    });
    expect(foreign.statusCode).toBe(404);
    expect(envelope(foreign)?.code).toBe('not_found');
  });

  it('enforces calendar parent ownership on the nested events collection (404 + real total)', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/calendars',
      headers: { cookie: sessions.a.cookie, ...withCsrf(sessions.a), ...idem(`ptcal-${slug}`) },
      payload: { code: `ptcal-${slug}`, name: 'Parent Calendar' },
    });
    expect(created.statusCode).toBe(201);
    const calendarId = (created.json().calendar as { id: string }).id;
    for (let i = 1; i <= 2; i++) {
      const ev = await app.inject({
        method: 'POST',
        url: `/api/v1/calendars/${calendarId}/events`,
        headers: { cookie: sessions.a.cookie, ...withCsrf(sessions.a), ...idem(`ptev${i}-${slug}`) },
        payload: { title: `Event ${i}`, startsAt: '2026-03-01T10:00:00.000Z', endsAt: '2026-03-01T11:00:00.000Z' },
      });
      expect(ev.statusCode).toBe(201);
    }

    const own = await app.inject({
      method: 'GET',
      url: `/api/v1/calendars/${calendarId}/events?limit=1&offset=0`,
      headers: { cookie: sessions.a.cookie },
    });
    expect(own.statusCode).toBe(200);
    const ownBody = own.json() as { items: unknown[]; total: number };
    expect(ownBody.items).toHaveLength(1);
    expect(ownBody.total).toBe(2);

    const missing = await app.inject({
      method: 'GET',
      url: `/api/v1/calendars/${randomUUID()}/events`,
      headers: { cookie: sessions.a.cookie },
    });
    expect(missing.statusCode).toBe(404);
    expect(envelope(missing)?.code).toBe('not_found');

    const foreign = await app.inject({
      method: 'GET',
      url: `/api/v1/calendars/${calendarId}/events`,
      headers: { cookie: sessions.b.cookie },
    });
    expect(foreign.statusCode).toBe(404);
    expect(envelope(foreign)?.code).toBe('not_found');
  });

  // ------------------------------------------------------- principal (read-most)

  it('principal sees read-only school data but is denied every managing action', async () => {
    const year = await app.inject({
      method: 'POST',
      url: '/api/v1/academic-years',
      headers: { cookie: sessions.a.cookie, ...withCsrf(sessions.a), ...idem(`pryr-${slug}`) },
      payload: { code: `pryr-${slug}`, name: 'Principal Year', startsOn: '2026-01-01', endsOn: '2026-12-31' },
    });
    expect(year.statusCode).toBe(201);
    const yearId = (year.json().academicYear as { id: string }).id;

    const reads: string[] = [
      '/api/v1/campuses',
      `/api/v1/academic-years/${yearId}/terms`,
      '/api/v1/calendars',
      '/api/v1/holidays',
      '/api/v1/departments',
    ];
    for (const url of reads) {
      const res = await app.inject({ method: 'GET', url, headers: { cookie: sessions.principal.cookie } });
      expect(res.statusCode, `GET ${url}`).toBe(200);
    }

    const writes: Array<{ m: 'POST' | 'PATCH'; url: string; perm: string; payload: Record<string, unknown> }> = [
      { m: 'POST', url: '/api/v1/campuses', perm: 'campus.create', payload: { code: `px-${slug}`, name: 'X' } },
      {
        m: 'POST',
        url: '/api/v1/academic-years',
        perm: 'academic.years.write',
        payload: { code: `pxy-${slug}`, name: 'X', startsOn: '2026-01-01', endsOn: '2026-12-31' },
      },
      { m: 'PATCH', url: '/api/v1/campuses/00000000-0000-0000-0000-000000000000', perm: 'campus.update', payload: { name: 'X' } },
      { m: 'POST', url: '/api/v1/holidays', perm: 'calendar.write', payload: { name: 'X', startsOn: '2026-01-01', endsOn: '2026-01-02' } },
      { m: 'POST', url: '/api/v1/departments', perm: 'departments.write', payload: { code: `pd-${slug}`, name: 'X' } },
      { m: 'PATCH', url: '/api/v1/settings', perm: 'school.settings.manage', payload: { schoolName: 'X' } },
    ];
    for (const w of writes) {
      const res = await app.inject({
        method: w.m,
        url: w.url,
        headers: { cookie: sessions.principal.cookie, ...withCsrf(sessions.principal) },
        payload: w.payload,
      });
      expect(res.statusCode, `${w.m} ${w.url}`).toBe(403);
      expect(envelope(res)?.code, `${w.m} ${w.url}`).toBe('forbidden');
      expect(envelope(res)?.requiredPermission, `${w.m} ${w.url}`).toBe(w.perm);
    }
  });

  // ----------------------------------------------------- error normalization

  it('rejects a non-UUID path param as validation_error (400) before any lookup', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/campuses/not-a-uuid',
      headers: { cookie: sessions.a.cookie },
    });
    expect(res.statusCode).toBe(400);
    expect(envelope(res)?.code).toBe('validation_error');
  });

  it('a blocked domain transition writes NO audit row and NO outbox event', async () => {
    const year = await app.inject({
      method: 'POST',
      url: '/api/v1/academic-years',
      headers: { cookie: sessions.a.cookie, ...withCsrf(sessions.a), ...idem(`fayr-${slug}`) },
      payload: { code: `fayr-${slug}`, name: 'Fail Year', startsOn: '2026-01-01', endsOn: '2026-12-31' },
    });
    expect(year.statusCode).toBe(201);
    const yearId = (year.json().academicYear as { id: string }).id;
    await app.inject({
      method: 'POST',
      url: `/api/v1/academic-years/${yearId}/open`,
      headers: { cookie: sessions.a.cookie, ...withCsrf(sessions.a) },
    });
    const term = await app.inject({
      method: 'POST',
      url: `/api/v1/academic-years/${yearId}/terms`,
      headers: { cookie: sessions.a.cookie, ...withCsrf(sessions.a), ...idem(`fat1-${slug}`) },
      payload: { code: `fat1-${slug}`, name: 'Fail Term', sequence: 1, startsOn: '2026-02-01', endsOn: '2026-06-30' },
    });
    expect(term.statusCode).toBe(201);
    const termId = (term.json().academicTerm as { id: string }).id;
    const termOpen = await app.inject({
      method: 'POST',
      url: `/api/v1/academic-terms/${termId}/open`,
      headers: { cookie: sessions.a.cookie, ...withCsrf(sessions.a) },
    });
    expect(termOpen.statusCode).toBe(200);
    const closed = await app.inject({
      method: 'POST',
      url: `/api/v1/academic-years/${yearId}/close`,
      headers: { cookie: sessions.a.cookie, ...withCsrf(sessions.a) },
    });
    expect(closed.statusCode).toBe(409);
    expect(envelope(closed)?.code).toBe('academic_year_has_open_terms');

    const audit = await rows(
      migratorDb,
      sql`select count(*)::int n from audit_logs where tenant_id = ${uid.tenantA} and action = 'academic.year.closed'`,
    );
    const outbox = await rows(
      migratorDb,
      sql`select count(*)::int n from outbox_events where tenant_id = ${uid.tenantA} and event_type = 'academic.year.closed'`,
    );
    expect(Number(audit[0]!.n)).toBe(0);
    expect(Number(outbox[0]!.n)).toBe(0);
  });

  it('outbox payloads and audit values never contain secret-bearing keys for this tenant', async () => {
    const sensitive = `'"(password|secret|authorization|access_token|client_secret)"'`;
    const outbox = await rows(
      migratorDb,
      sql`select count(*)::int n from outbox_events where tenant_id = ${uid.tenantA} and payload::text ~* ${sensitive}`,
    );
    const audit = await rows(
      migratorDb,
      sql`select count(*)::int n from audit_logs where tenant_id = ${uid.tenantA}
          and (new_value::text ~* ${sensitive} or old_value::text ~* ${sensitive})`,
    );
    expect(Number(outbox[0]!.n)).toBe(0);
    expect(Number(audit[0]!.n)).toBe(0);
  });

  // -------------------------------------------------------- idempotency depth

  it('concurrent same-key creates converge: one side effect, both 201 with the SAME stored response', async () => {
    const key = `con-${slug}`;
    const payloads = [
      { code: `con-1-${slug}`, name: 'Concurrent A' },
      { code: `con-2-${slug}`, name: 'Concurrent B' },
    ];
    const fire = (payload: { code: string; name: string }) =>
      app.inject({
        method: 'POST',
        url: '/api/v1/campuses',
        headers: { cookie: sessions.a.cookie, ...withCsrf(sessions.a), ...idem(key) },
        payload,
      });
    const [one, two] = await Promise.all([fire(payloads[0]!), fire(payloads[1]!)]);
    expect(one.statusCode).toBe(201);
    expect(two.statusCode).toBe(201);
    const idOne = (one.json().campus as { id: string }).id;
    const idTwo = (two.json().campus as { id: string }).id;
    expect(idOne).toBe(idTwo);

    // Exactly ONE mutation won the key: whichever body executed first. The loser's
    // insert + audit + outbox all rolled back inside its savepoint.
    const won = await rows(
      migratorDb,
      sql`select count(*)::int n from campuses where tenant_id = ${uid.tenantA}
          and (code = ${`con-1-${slug}`} or code = ${`con-2-${slug}`})`,
    );
    expect(Number(won[0]!.n)).toBe(1);
    const keyRows = await rows(
      migratorDb,
      sql`select count(*)::int n from idempotency_keys where tenant_id = ${uid.tenantA} and key = ${key}`,
    );
    expect(Number(keyRows[0]!.n)).toBe(1);
    const audit = await rows(
      migratorDb,
      sql`select count(*)::int n from audit_logs where tenant_id = ${uid.tenantA} and action = 'campus.created'
          and (new_value::text like ${`%con-1-${slug}%`} or new_value::text like ${`%con-2-${slug}%`})`,
    );
    const outbox = await rows(
      migratorDb,
      sql`select count(*)::int n from outbox_events where tenant_id = ${uid.tenantA} and event_type = 'campus.created'
          and (payload::text like ${`%con-1-${slug}%`} or payload::text like ${`%con-2-${slug}%`})`,
    );
    expect(Number(audit[0]!.n)).toBe(1);
    expect(Number(outbox[0]!.n)).toBe(1);
  });

  it('a replayed key with a DIFFERENT body returns the stored (first-write-wins) response', async () => {
    const key = `fw-${slug}`;
    const first = await app.inject({
      method: 'POST',
      url: '/api/v1/campuses',
      headers: { cookie: sessions.a.cookie, ...withCsrf(sessions.a), ...idem(key) },
      payload: { code: `fw-${slug}`, name: 'First Write' },
    });
    expect(first.statusCode).toBe(201);
    const firstId = (first.json().campus as { id: string }).id;

    const replay = await app.inject({
      method: 'POST',
      url: '/api/v1/campuses',
      headers: { cookie: sessions.a.cookie, ...withCsrf(sessions.a), ...idem(key) },
      payload: { code: `fw-${slug}`, name: 'Second Attempt' },
    });
    expect(replay.statusCode).toBe(201);
    const replayedCampus = replay.json().campus as { id: string; name: string };
    expect(replayedCampus.id).toBe(firstId);
    expect(replayedCampus.name).toBe('First Write');

    const campusCount = await rows(
      migratorDb,
      sql`select count(*)::int n from campuses where tenant_id = ${uid.tenantA} and code = ${`fw-${slug}`}`,
    );
    expect(Number(campusCount[0]!.n)).toBe(1);
    const audit = await rows(
      migratorDb,
      sql`select count(*)::int n from audit_logs where tenant_id = ${uid.tenantA} and action = 'campus.created' and new_value::text like ${`%fw-${slug}%`}`,
    );
    const outbox = await rows(
      migratorDb,
      sql`select count(*)::int n from outbox_events where tenant_id = ${uid.tenantA} and event_type = 'campus.created' and payload::text like ${`%fw-${slug}%`}`,
    );
    expect(Number(audit[0]!.n)).toBe(1);
    expect(Number(outbox[0]!.n)).toBe(1);
  });
});