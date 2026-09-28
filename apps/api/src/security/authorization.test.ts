import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { getEnv } from '@sms/config';
import { createDb, withTenant, type Db } from '@sms/db';
import type { RequestContext } from '@sms/core';
import type { StorageProvider } from '@sms/storage';
import { writeSession, type RedisSession } from '@sms/auth';
import { buildApp } from '../app.js';
import { createTenantTransaction } from '../routes/tenants.js';

/**
 * HTTP-level authorization contract proofs against the ACTUAL Fastify
 * application (`buildApp`), the real dev PostgreSQL database under the real
 * `school_app_rw` role, and a documented in-process Redis double.
 *
 * Redis double rationale: sessions (`sess:{hash}`) and the global rate-limit
 * counter normally live in Redis. No Redis server runs in this development
 * environment (127.0.0.1:6379 refused) and none can be started here, so the
 * suite seeds sessions through the same `writeSession`/`hashSessionToken` API
 * against an in-memory stand-in implementing get/set/del + the
 * `defineCommand('rateLimit', …)` command @fastify/rate-limit needs. The DB,
 * membership/role/permission resolution, authorization gates, route contracts
 * and startup validation are all REAL code paths.
 *
 * Opt-in: RUN_RUNTIME_SECURITY_TESTS=1 (requires PostgreSQL + migrations
 * 0001..0003).
 */
const enabled = process.env.RUN_RUNTIME_SECURITY_TESTS === '1';
const describeDb = enabled ? describe : describe.skip;

class FakeRedis {
  private store = new Map<string, string>();
  status = 'ready';
  defineCommand(_name: string, _opts: unknown): void {
    // rateLimit is implemented natively below; nothing to register.
  }
  rateLimit(
    key: string,
    timeWindow: number,
    _max: number,
    _continueExceeding: boolean,
    _exponentialBackoff: boolean,
    cb: (err: Error | null, result?: number[]) => void,
  ): void {
    const prev = JSON.parse(this.store.get(key) ?? '[]') as number[];
    const current = (prev[0] ?? 0) + 1;
    const ttl = current === 1 ? timeWindow : (prev[1] ?? 0);
    this.store.set(key, JSON.stringify([current, ttl]));
    cb(null, [current, ttl]);
  }
  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }
  async set(key: string, value: string, _mode?: string, _ttl?: number): Promise<'OK'> {
    this.store.set(key, value);
    return 'OK';
  }
  async del(key: string): Promise<number> {
    return this.store.delete(key) ? 1 : 0;
  }
  async quit(): Promise<void> {}
}

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

describeDb('API authorization contracts (real app + real DB, HTTP-level)', () => {
  let migratorDb: Db;
  let appDb: Db;
  let redis: FakeRedis;
  let endMigrator: () => Promise<void>;
  let endApp: () => Promise<void>;
  let app: Awaited<ReturnType<typeof buildApp>>;

  const uid: Record<string, string> = {};
  const slug = `az${randomUUID().slice(0, 8)}`;
  const sessions: Record<'owner' | 'parent' | 'platform', SessionCookies> = {} as never;

  const rows = async (db: Db, q: ReturnType<typeof sql>): Promise<Record<string, unknown>[]> =>
    (await db.execute(q)).rows;

  const envelope = (res: { json: () => unknown }) =>
    (res.json() as { error?: { code?: string; message?: string; requiredPermission?: string | null } }).error;

  beforeAll(async () => {
    const env = getEnv();
    const mig = createDb({ url: env.DATABASE_URL_MIGRATOR });
    const app_ = createDb({ url: env.DATABASE_URL_APP });
    migratorDb = mig.db;
    appDb = app_.db;
    endMigrator = () => mig.pool.end();
    endApp = () => app_.pool.end();
    redis = new FakeRedis();

    uid.owner = randomUUID();
    uid.parent = randomUUID();
    uid.platform = randomUUID();
    uid.platRole = randomUUID();

    uid.ownerEmail = `owner-${slug}@example.com`;
    uid.parentEmail = `parent-${slug}@example.com`;
    uid.platformEmail = `platform-${slug}@example.com`;
    uid.otherTenant = randomUUID();

    // Platform role used by both the tenant-creating owner (needs the platform
    // ticket to insert the tenant row) and the platform-only operator.
    await rows(
      migratorDb,
      sql`insert into roles (id, scope, code, name, is_system) values (${uid.platRole}, 'platform', ${`app${slug}_plat`}, 'Test Platform Admin', true)`,
    );
    await rows(
      migratorDb,
      sql`insert into role_permissions (role_id, permission) values (${uid.platRole}, 'platform.tenants.read'), (${uid.platRole}, 'platform.tenants.create')`,
    );

    // 1) School owner — also holds the platform role so app_ctx_mint('platform')
    //    succeeds while bootstrapping the tenant (mirrors the real
    //    POST /platform/tenants flow where the creator becomes the owner).
    await rows(migratorDb, sql`insert into users (id, email) values (${uid.owner}, ${uid.ownerEmail})`);
    await rows(
      migratorDb,
      sql`insert into platform_role_assignments (user_id, role_id) values (${uid.owner}, ${uid.platRole})`,
    );

    // 2) Platform-only operator — platform role, deliberately NO tenant membership.
    await rows(
      migratorDb,
      sql`insert into users (id, email) values (${uid.platform}, ${uid.platformEmail})`,
    );
    await rows(
      migratorDb,
      sql`insert into platform_role_assignments (user_id, role_id) values (${uid.platform}, ${uid.platRole})`,
    );

    // 3) Real tenant (seeds tenant role templates with the Phase 2B permission
    //    set via createTenantTransaction; ctx.userId becomes the school owner).
    const platformCtx: RequestContext = {
      requestId: randomUUID(),
      userId: uid.owner,
      scope: 'platform',
      tenantId: null,
      membershipId: null,
      campusId: null,
      roleIds: [uid.platRole],
      permissions: new Set(['platform.tenants.create', 'platform.tenants.read']),
      platformAccess: true,
      isSystem: false,
    };
    const created = await withTenant(appDb, platformCtx, (tx) =>
      createTenantTransaction(tx, platformCtx, { slug, name: 'Authorization Test School', requestId: randomUUID() }),
    );
    uid.tenant = created.tenantId;

    // 4) Parent member of the same tenant with only the `parent` role (no audit.read).
    await rows(migratorDb, sql`insert into users (id, email) values (${uid.parent}, ${uid.parentEmail})`);
    const parentRole = await rows(
      migratorDb,
      sql`select id from roles where tenant_id = ${uid.tenant} and code = 'parent'`,
    );
    const parentRoleId = String(parentRole[0]!.id);
    const parentMembershipRows = await rows(
      migratorDb,
      sql`insert into memberships (id, tenant_id, user_id, status) values (${randomUUID()}, ${uid.tenant}, ${uid.parent}, 'active') returning id`,
    );
    uid.parentMembership = String(parentMembershipRows[0]!.id);
    await rows(
      migratorDb,
      sql`insert into membership_roles (membership_id, role_id) values (${uid.parentMembership}, ${parentRoleId})`,
    );

    // 5) Sessions in the (documented) in-process Redis double.
    sessions.owner = await makeSession(uid.owner!, uid.tenant!);
    sessions.parent = await makeSession(uid.parent!, uid.tenant!);
    // Platform operator has no membership; activeTenantId set so requireTenantContext
    // resolves to a 403 membership denial (not the 400 "no tenant selected").
    sessions.platform = await makeSession(uid.platform!, uid.tenant!);

    // 5) Real app with real DB — must boot (startup validation passes).
    app = await buildApp({
      deps: { db: appDb, redis: redis as unknown as Redis, storage: stubStorage },
      logger: false,
    });
  });

  async function makeSession(userId: string, activeTenantId: string | null): Promise<SessionCookies> {
    const session: RedisSession = {
      userId,
      activeTenantId,
      csrfToken: `csrf-${userId.slice(0, 8)}`,
      createdAt: Date.now(),
      expiresAt: Date.now() + 3_600_000,
    };
    const issued = { token: `tok-${randomUUID()}`, tokenHash: '' };
    await writeSession(redis as unknown as Redis, issued.token, session);
    return {
      token: issued.token,
      csrf: session.csrfToken,
      cookie: `${getEnv().SESSION_COOKIE_NAME}=${issued.token}`,
    };
  }

  afterAll(async () => {
    try {
      if (app) await app.close();
      // The logout tests emit NULL-tenant `user.logout` outbox rows (revokeSession);
      // tenant-scoped cleanup below does not catch them, so remove them explicitly.
      await rows(
        migratorDb,
        sql`delete from outbox_events where tenant_id is null and event_type = 'user.logout'`,
      );
      await rows(migratorDb, sql`delete from outbox_events where tenant_id = ${uid.tenant}`);
      // audit_logs is append-only by design (0001: INSERT + SELECT policies only - no
      // DELETE policy even for the privileged migrator role); residue accumulates by
      // design and scoped count assertions are RLS-isolated.
      await rows(
        migratorDb,
        sql`delete from membership_roles where membership_id in (select id from memberships where tenant_id = ${uid.tenant} or user_id = ${uid.parent})`,
      );
      await rows(
        migratorDb,
        sql`delete from role_permissions where role_id in (select id from roles where tenant_id = ${uid.tenant} or id = ${uid.platRole})`,
      );
      await rows(
        migratorDb,
        sql`delete from memberships where tenant_id = ${uid.tenant} or user_id in (${uid.parent})`,
      );
      await rows(
        migratorDb,
        sql`delete from platform_role_assignments where user_id in (${uid.owner}, ${uid.platform})`,
      );
      await rows(migratorDb, sql`delete from roles where tenant_id = ${uid.tenant} or id = ${uid.platRole}`);
      await rows(
        migratorDb,
        sql`delete from users where id in (${uid.owner}, ${uid.parent}, ${uid.platform})`,
      );
      await rows(migratorDb, sql`delete from tenants where id = ${uid.tenant}`);
    } finally {
      await endMigrator();
      await endApp();
    }
  });

  it('is reachable and public (health probes do not require auth)', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('ok');
  });

  it('rejects anonymous callers on authenticated endpoints (401 unauthenticated)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/me' });
    expect(res.statusCode).toBe(401);
    expect(envelope(res)?.code).toBe('unauthenticated');
  });

  it('rejects anonymous callers on tenant endpoints (401 unauthenticated, before permission logic)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/audit' });
    expect(res.statusCode).toBe(401);
    expect(envelope(res)?.code).toBe('unauthenticated');
  });

  it('serves /me to an authenticated session', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: { cookie: sessions.owner.cookie },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json().user as { userId: string }).userId).toBe(uid.owner);
  });

  it('denies a tenant member without the required permission (403 forbidden + requiredPermission)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/audit',
      headers: { cookie: sessions.parent.cookie },
    });
    expect(res.statusCode).toBe(403);
    expect(envelope(res)?.code).toBe('forbidden');
    expect(envelope(res)?.requiredPermission).toBe('audit.read');
  });

  it('allows a tenant member with the required permission (school_owner has audit.read)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/audit',
      headers: { cookie: sessions.owner.cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().auditLogs).toBeInstanceOf(Array);
  });

  it('denies the platform-only operator tenant endpoints (cross-boundary)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/audit',
      headers: { cookie: sessions.platform.cookie },
    });
    expect(res.statusCode).toBe(403);
    expect(envelope(res)?.code).toBe('forbidden');
    expect(envelope(res)?.message).toBe('Tenant access denied');
  });

  it('denies a tenant member the platform endpoints (platform boundary)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/platform/tenants',
      headers: { cookie: sessions.parent.cookie },
    });
    expect(res.statusCode).toBe(403);
    expect(envelope(res)?.code).toBe('forbidden');
    expect(envelope(res)?.requiredPermission).toBe('platform.tenants.read');
  });

  it('allows a platform operator with platform.tenants.read on platform endpoints', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/platform/tenants',
      headers: { cookie: sessions.platform.cookie },
    });
    expect(res.statusCode).toBe(200);
    const tenantSlugs = (res.json().tenants as { slug: string }[]).map((t) => t.slug);
    expect(tenantSlugs).toContain(slug);
  });

  it('denies cross-tenant object access even for an authenticated tenant member', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/files/${uid.otherTenant}/secret.pdf`,
      headers: { cookie: sessions.owner.cookie },
    });
    expect(res.statusCode).toBe(404);
    expect(envelope(res)?.code).toBe('not_found');
  });

  it('still requires the CSRF double-submit token on state-changing endpoints', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: { cookie: sessions.owner.cookie },
    });
    expect(res.statusCode).toBe(403);
    expect(envelope(res)?.code).toBe('csrf_invalid');
  });

  it('accepts the CSRF token when present and completes the logout', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: {
        cookie: sessions.owner.cookie,
        'x-csrf-token': sessions.owner.csrf,
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });

  it('exposes the Phase 2B catalog through the permissions endpoint', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/permissions',
      headers: { cookie: sessions.parent.cookie },
    });
    expect(res.statusCode).toBe(200);
    const perms = res.json().permissions as string[];
    for (const p of [
      'school.settings.manage',
      'campus.read',
      'campus.create',
      'campus.update',
      'academic.years.read',
      'academic.years.write',
      'academic.terms.read',
      'academic.terms.write',
      'calendar.read',
      'calendar.write',
      'departments.read',
      'departments.write',
    ]) {
      expect(perms).toContain(p);
    }
  });

  it('reports the full route authorization matrix after boot', async () => {
    const byRoute = new Map(
      app.routeAuthorizationMatrix().routes.map((r) => [`${r.method} ${r.url}`, r]),
    );
    const expected: Record<string, { kind: string; permission: string | null; devOnly: boolean }> = {
      'GET /health': { kind: 'public', permission: null, devOnly: false },
      'GET /ready': { kind: 'public', permission: null, devOnly: false },
      'POST /api/v1/auth/register': { kind: 'public', permission: null, devOnly: false },
      'POST /api/v1/auth/login': { kind: 'public', permission: null, devOnly: false },
      'POST /api/v1/auth/logout': { kind: 'authenticated', permission: null, devOnly: false },
      'GET /api/v1/me': { kind: 'authenticated', permission: null, devOnly: false },
      'GET /api/v1/me/memberships': { kind: 'authenticated', permission: null, devOnly: false },
      'GET /api/v1/me/homework-context': { kind: 'tenant', permission: 'homework.read', devOnly: false },
      'POST /api/v1/tenants/switch': { kind: 'authenticated', permission: null, devOnly: false },
      'GET /api/v1/permissions': { kind: 'authenticated', permission: null, devOnly: false },
      'GET /api/v1/audit': { kind: 'tenant', permission: 'audit.read', devOnly: false },
      'GET /api/v1/files/:tenantId/*': { kind: 'tenant', permission: 'tenant.read', devOnly: true },
      'POST /api/v1/platform/tenants': {
        kind: 'platform',
        permission: 'platform.tenants.create',
        devOnly: false,
      },
      'GET /api/v1/platform/tenants': {
        kind: 'platform',
        permission: 'platform.tenants.read',
        devOnly: false,
      },
      // Phase 2B.3 school domain
      'GET /api/v1/campuses': { kind: 'tenant', permission: 'campus.read', devOnly: false },
      'POST /api/v1/campuses': { kind: 'tenant', permission: 'campus.create', devOnly: false },
      'GET /api/v1/campuses/:id': { kind: 'tenant', permission: 'campus.read', devOnly: false },
      'PATCH /api/v1/campuses/:id': { kind: 'tenant', permission: 'campus.update', devOnly: false },
      'POST /api/v1/campuses/:id/activate': { kind: 'tenant', permission: 'campus.update', devOnly: false },
      'POST /api/v1/campuses/:id/deactivate': { kind: 'tenant', permission: 'campus.update', devOnly: false },
      'GET /api/v1/academic-years': { kind: 'tenant', permission: 'academic.years.read', devOnly: false },
      'POST /api/v1/academic-years': { kind: 'tenant', permission: 'academic.years.write', devOnly: false },
      'GET /api/v1/academic-years/:id': { kind: 'tenant', permission: 'academic.years.read', devOnly: false },
      'PATCH /api/v1/academic-years/:id': { kind: 'tenant', permission: 'academic.years.write', devOnly: false },
      'POST /api/v1/academic-years/:id/open': { kind: 'tenant', permission: 'academic.years.write', devOnly: false },
      'POST /api/v1/academic-years/:id/close': { kind: 'tenant', permission: 'academic.years.write', devOnly: false },
      'GET /api/v1/academic-years/:academicYearId/terms': { kind: 'tenant', permission: 'academic.terms.read', devOnly: false },
      'POST /api/v1/academic-years/:academicYearId/terms': { kind: 'tenant', permission: 'academic.terms.write', devOnly: false },
      'GET /api/v1/academic-terms/:id': { kind: 'tenant', permission: 'academic.terms.read', devOnly: false },
      'PATCH /api/v1/academic-terms/:id': { kind: 'tenant', permission: 'academic.terms.write', devOnly: false },
      'POST /api/v1/academic-terms/:id/open': { kind: 'tenant', permission: 'academic.terms.write', devOnly: false },
      'POST /api/v1/academic-terms/:id/close': { kind: 'tenant', permission: 'academic.terms.write', devOnly: false },
      'GET /api/v1/holidays': { kind: 'tenant', permission: 'calendar.read', devOnly: false },
      'POST /api/v1/holidays': { kind: 'tenant', permission: 'calendar.write', devOnly: false },
      'GET /api/v1/holidays/:id': { kind: 'tenant', permission: 'calendar.read', devOnly: false },
      'PATCH /api/v1/holidays/:id': { kind: 'tenant', permission: 'calendar.write', devOnly: false },
      'DELETE /api/v1/holidays/:id': { kind: 'tenant', permission: 'calendar.write', devOnly: false },
      'GET /api/v1/calendars': { kind: 'tenant', permission: 'calendar.read', devOnly: false },
      'POST /api/v1/calendars': { kind: 'tenant', permission: 'calendar.write', devOnly: false },
      'GET /api/v1/calendars/:id': { kind: 'tenant', permission: 'calendar.read', devOnly: false },
      'PATCH /api/v1/calendars/:id': { kind: 'tenant', permission: 'calendar.write', devOnly: false },
      'DELETE /api/v1/calendars/:id': { kind: 'tenant', permission: 'calendar.write', devOnly: false },
      'GET /api/v1/calendars/:calendarId/events': { kind: 'tenant', permission: 'calendar.read', devOnly: false },
      'POST /api/v1/calendars/:calendarId/events': { kind: 'tenant', permission: 'calendar.write', devOnly: false },
      'GET /api/v1/calendar-events/:id': { kind: 'tenant', permission: 'calendar.read', devOnly: false },
      'PATCH /api/v1/calendar-events/:id': { kind: 'tenant', permission: 'calendar.write', devOnly: false },
      'DELETE /api/v1/calendar-events/:id': { kind: 'tenant', permission: 'calendar.write', devOnly: false },
      'GET /api/v1/departments': { kind: 'tenant', permission: 'departments.read', devOnly: false },
      'POST /api/v1/departments': { kind: 'tenant', permission: 'departments.write', devOnly: false },
      'GET /api/v1/departments/:id': { kind: 'tenant', permission: 'departments.read', devOnly: false },
      'PATCH /api/v1/departments/:id': { kind: 'tenant', permission: 'departments.write', devOnly: false },
      'POST /api/v1/departments/:id/activate': { kind: 'tenant', permission: 'departments.write', devOnly: false },
      'POST /api/v1/departments/:id/deactivate': { kind: 'tenant', permission: 'departments.write', devOnly: false },
      'GET /api/v1/settings': { kind: 'tenant', permission: 'school.settings.manage', devOnly: false },
      'PATCH /api/v1/settings': { kind: 'tenant', permission: 'school.settings.manage', devOnly: false },
      'PUT /api/v1/settings/branding': { kind: 'tenant', permission: 'school.branding.manage', devOnly: false },
      'GET /api/v1/settings/branding/logo': { kind: 'tenant', permission: 'school.branding.manage', devOnly: false },
      // Phase 3.2 students & guardians
      'GET /api/v1/students': { kind: 'tenant', permission: 'students.read', devOnly: false },
      'POST /api/v1/students': { kind: 'tenant', permission: 'students.create', devOnly: false },
      'GET /api/v1/students/:id': { kind: 'tenant', permission: 'students.read', devOnly: false },
      'PATCH /api/v1/students/:id': { kind: 'tenant', permission: 'students.update', devOnly: false },
      'DELETE /api/v1/students/:id': { kind: 'tenant', permission: 'students.delete', devOnly: false },
      'GET /api/v1/students/:id/guardians': { kind: 'tenant', permission: 'students.read', devOnly: false },
      'POST /api/v1/students/:id/guardians': { kind: 'tenant', permission: 'students.update', devOnly: false },
      'DELETE /api/v1/students/:id/guardians/:guardianId': { kind: 'tenant', permission: 'students.update', devOnly: false },
      'GET /api/v1/guardians': { kind: 'tenant', permission: 'guardians.read', devOnly: false },
      'POST /api/v1/guardians': { kind: 'tenant', permission: 'guardians.create', devOnly: false },
      'GET /api/v1/guardians/:id': { kind: 'tenant', permission: 'guardians.read', devOnly: false },
      'PATCH /api/v1/guardians/:id': { kind: 'tenant', permission: 'guardians.update', devOnly: false },
      'DELETE /api/v1/guardians/:id': { kind: 'tenant', permission: 'guardians.update', devOnly: false },
      // Phase 3.3 enrollments & promotion
      'GET /api/v1/enrollments': { kind: 'tenant', permission: 'enrollment.read', devOnly: false },
      'GET /api/v1/enrollments/:id': { kind: 'tenant', permission: 'enrollment.read', devOnly: false },
      'POST /api/v1/students/:id/enroll': { kind: 'tenant', permission: 'enrollment.manage', devOnly: false },
      'POST /api/v1/students/:id/transfer': { kind: 'tenant', permission: 'enrollment.manage', devOnly: false },
      'POST /api/v1/students/:id/graduate': { kind: 'tenant', permission: 'enrollment.manage', devOnly: false },
      'POST /api/v1/promotion-batches': { kind: 'tenant', permission: 'enrollment.manage', devOnly: false },
      'GET /api/v1/promotion-batches': { kind: 'tenant', permission: 'enrollment.read', devOnly: false },
      'GET /api/v1/promotion-batches/:id': { kind: 'tenant', permission: 'enrollment.read', devOnly: false },
      'POST /api/v1/promotion-batches/:id/items': { kind: 'tenant', permission: 'enrollment.manage', devOnly: false },
      'POST /api/v1/promotion-batches/:id/execute': { kind: 'tenant', permission: 'enrollment.manage', devOnly: false },
      // Phase 3.4 student documents
      'GET /api/v1/students/:id/documents': { kind: 'tenant', permission: 'student.documents.read', devOnly: false },
      'POST /api/v1/students/:id/documents': { kind: 'tenant', permission: 'student.documents.create', devOnly: false },
      'GET /api/v1/students/:id/documents/:documentId': { kind: 'tenant', permission: 'student.documents.read', devOnly: false },
      'GET /api/v1/students/:id/documents/:documentId/download': { kind: 'tenant', permission: 'student.documents.read', devOnly: false },
      'PATCH /api/v1/students/:id/documents/:documentId': { kind: 'tenant', permission: 'student.documents.update', devOnly: false },
      'DELETE /api/v1/students/:id/documents/:documentId': { kind: 'tenant', permission: 'student.documents.delete', devOnly: false },
      // Phase 3.5 admissions, CSV import + export
      'GET /api/v1/admission-applications': { kind: 'tenant', permission: 'admission.read', devOnly: false },
      'POST /api/v1/admission-applications': { kind: 'tenant', permission: 'admission.create', devOnly: false },
      'GET /api/v1/admission-applications/:id': { kind: 'tenant', permission: 'admission.read', devOnly: false },
      'PATCH /api/v1/admission-applications/:id': { kind: 'tenant', permission: 'admission.update', devOnly: false },
      'POST /api/v1/admission-applications/:id/submit': { kind: 'tenant', permission: 'admission.review', devOnly: false },
      'POST /api/v1/admission-applications/:id/review': { kind: 'tenant', permission: 'admission.review', devOnly: false },
      'POST /api/v1/admission-applications/:id/approve': { kind: 'tenant', permission: 'admission.review', devOnly: false },
      'POST /api/v1/admission-applications/:id/reject': { kind: 'tenant', permission: 'admission.review', devOnly: false },
      'POST /api/v1/admission-applications/:id/withdraw': { kind: 'tenant', permission: 'admission.review', devOnly: false },
      'POST /api/v1/students/import': { kind: 'tenant', permission: 'students.create', devOnly: false },
      'GET /api/v1/students/imports': { kind: 'tenant', permission: 'students.read', devOnly: false },
      'GET /api/v1/students/imports/:id': { kind: 'tenant', permission: 'students.read', devOnly: false },
      'GET /api/v1/students/export': { kind: 'tenant', permission: 'students.export', devOnly: false },
      // Phase 4.1 classes, sections & placement
      'GET /api/v1/classes': { kind: 'tenant', permission: 'classes.read', devOnly: false },
      'POST /api/v1/classes': { kind: 'tenant', permission: 'classes.create', devOnly: false },
      'GET /api/v1/classes/:id': { kind: 'tenant', permission: 'classes.read', devOnly: false },
      'PATCH /api/v1/classes/:id': { kind: 'tenant', permission: 'classes.update', devOnly: false },
      'DELETE /api/v1/classes/:id': { kind: 'tenant', permission: 'classes.delete', devOnly: false },
      'POST /api/v1/classes/:id/activate': { kind: 'tenant', permission: 'classes.update', devOnly: false },
      'POST /api/v1/classes/:id/deactivate': { kind: 'tenant', permission: 'classes.update', devOnly: false },
      'GET /api/v1/classes/:id/sections': { kind: 'tenant', permission: 'sections.read', devOnly: false },
      'POST /api/v1/classes/:id/sections': { kind: 'tenant', permission: 'sections.create', devOnly: false },
      'GET /api/v1/classes/:id/sections/:sectionId': { kind: 'tenant', permission: 'sections.read', devOnly: false },
      'PATCH /api/v1/classes/:id/sections/:sectionId': { kind: 'tenant', permission: 'sections.update', devOnly: false },
      'DELETE /api/v1/classes/:id/sections/:sectionId': { kind: 'tenant', permission: 'sections.delete', devOnly: false },
      'POST /api/v1/classes/:id/sections/:sectionId/activate': { kind: 'tenant', permission: 'sections.update', devOnly: false },
      'POST /api/v1/classes/:id/sections/:sectionId/deactivate': { kind: 'tenant', permission: 'sections.update', devOnly: false },
      'GET /api/v1/enrollments/:id/placement': { kind: 'tenant', permission: 'placement.read', devOnly: false },
      'POST /api/v1/enrollments/:id/placement': { kind: 'tenant', permission: 'placement.manage', devOnly: false },
      'DELETE /api/v1/enrollments/:id/placement': { kind: 'tenant', permission: 'placement.manage', devOnly: false },
      // Phase 4.2 grade levels, subjects, class-subject links & teacher assignments
      'GET /api/v1/grade-levels': { kind: 'tenant', permission: 'grade.levels.read', devOnly: false },
      'POST /api/v1/grade-levels': { kind: 'tenant', permission: 'grade.levels.create', devOnly: false },
      'GET /api/v1/grade-levels/:id': { kind: 'tenant', permission: 'grade.levels.read', devOnly: false },
      'PATCH /api/v1/grade-levels/:id': { kind: 'tenant', permission: 'grade.levels.update', devOnly: false },
      'POST /api/v1/grade-levels/:id/activate': { kind: 'tenant', permission: 'grade.levels.update', devOnly: false },
      'POST /api/v1/grade-levels/:id/deactivate': { kind: 'tenant', permission: 'grade.levels.update', devOnly: false },
      'DELETE /api/v1/grade-levels/:id': { kind: 'tenant', permission: 'grade.levels.delete', devOnly: false },
      'GET /api/v1/subjects': { kind: 'tenant', permission: 'subjects.read', devOnly: false },
      'POST /api/v1/subjects': { kind: 'tenant', permission: 'subjects.create', devOnly: false },
      'GET /api/v1/subjects/:id': { kind: 'tenant', permission: 'subjects.read', devOnly: false },
      'PATCH /api/v1/subjects/:id': { kind: 'tenant', permission: 'subjects.update', devOnly: false },
      'POST /api/v1/subjects/:id/activate': { kind: 'tenant', permission: 'subjects.update', devOnly: false },
      'POST /api/v1/subjects/:id/deactivate': { kind: 'tenant', permission: 'subjects.update', devOnly: false },
      'DELETE /api/v1/subjects/:id': { kind: 'tenant', permission: 'subjects.delete', devOnly: false },
      'GET /api/v1/classes/:id/subjects': { kind: 'tenant', permission: 'class.subjects.read', devOnly: false },
      'POST /api/v1/classes/:id/subjects/:subjectId': { kind: 'tenant', permission: 'class.subjects.manage', devOnly: false },
      'DELETE /api/v1/classes/:id/subjects/:subjectId': { kind: 'tenant', permission: 'class.subjects.manage', devOnly: false },
      'GET /api/v1/classes/:id/subjects/:subjectId/teachers': { kind: 'tenant', permission: 'teacher.assignments.read', devOnly: false },
      'POST /api/v1/classes/:id/subjects/:subjectId/teachers': { kind: 'tenant', permission: 'teacher.assignments.manage', devOnly: false },
      'DELETE /api/v1/classes/:id/subjects/:subjectId/teachers/:teacherId': { kind: 'tenant', permission: 'teacher.assignments.manage', devOnly: false },
      'GET /api/v1/teachers': { kind: 'tenant', permission: 'teacher.assignments.read', devOnly: false },
      // Phase 4.3 timetables (periods, weekly grid, publish) & homework
      'GET /api/v1/periods': { kind: 'tenant', permission: 'timetable.read', devOnly: false },
      'POST /api/v1/periods': { kind: 'tenant', permission: 'timetable.manage', devOnly: false },
      'GET /api/v1/periods/:id': { kind: 'tenant', permission: 'timetable.read', devOnly: false },
      'PATCH /api/v1/periods/:id': { kind: 'tenant', permission: 'timetable.manage', devOnly: false },
      'POST /api/v1/periods/:id/activate': { kind: 'tenant', permission: 'timetable.manage', devOnly: false },
      'POST /api/v1/periods/:id/deactivate': { kind: 'tenant', permission: 'timetable.manage', devOnly: false },
      'DELETE /api/v1/periods/:id': { kind: 'tenant', permission: 'timetable.manage', devOnly: false },
      'GET /api/v1/classes/:id/sections/:sectionId/timetable': { kind: 'tenant', permission: 'timetable.read', devOnly: false },
      'POST /api/v1/classes/:id/sections/:sectionId/timetable': { kind: 'tenant', permission: 'timetable.manage', devOnly: false },
      'PATCH /api/v1/classes/:id/sections/:sectionId/timetable/:entryId': { kind: 'tenant', permission: 'timetable.manage', devOnly: false },
      'DELETE /api/v1/classes/:id/sections/:sectionId/timetable/:entryId': { kind: 'tenant', permission: 'timetable.manage', devOnly: false },
      'POST /api/v1/timetable/publish': { kind: 'tenant', permission: 'timetable.publish', devOnly: false },
      'GET /api/v1/classes/:id/homework': { kind: 'tenant', permission: 'homework.read', devOnly: false },
      'POST /api/v1/classes/:id/homework': { kind: 'tenant', permission: 'homework.create', devOnly: false },
      'GET /api/v1/classes/:id/homework/:homeworkId': { kind: 'tenant', permission: 'homework.read', devOnly: false },
      'PATCH /api/v1/classes/:id/homework/:homeworkId': { kind: 'tenant', permission: 'homework.update', devOnly: false },
      'DELETE /api/v1/classes/:id/homework/:homeworkId': { kind: 'tenant', permission: 'homework.delete', devOnly: false },
      // Phase 5 attendance & leave: daily register, period marking + correction,
      // class/student reports, staff clock, leave types, leave workflow and the
      // self-scoped parent/student portals. `attendance.mark` is deliberately a
      // separate grant from `attendance.read` (parents hold read only).
      'GET /api/v1/attendance': { kind: 'tenant', permission: 'attendance.read', devOnly: false },
      'POST /api/v1/attendance/mark': { kind: 'tenant', permission: 'attendance.mark', devOnly: false },
      'PATCH /api/v1/attendance/:id/correct': { kind: 'tenant', permission: 'attendance.mark', devOnly: false },
      'GET /api/v1/attendance/periods': { kind: 'tenant', permission: 'attendance.read', devOnly: false },
      'POST /api/v1/attendance/periods/mark': { kind: 'tenant', permission: 'attendance.mark', devOnly: false },
      'PATCH /api/v1/attendance/periods/:id/correct': { kind: 'tenant', permission: 'attendance.mark', devOnly: false },
      'GET /api/v1/attendance/reports/class': { kind: 'tenant', permission: 'attendance.read', devOnly: false },
      'GET /api/v1/attendance/reports/student': { kind: 'tenant', permission: 'attendance.read', devOnly: false },
      'GET /api/v1/staff-attendance': { kind: 'tenant', permission: 'attendance.read', devOnly: false },
      'POST /api/v1/staff-attendance/mark': { kind: 'tenant', permission: 'attendance.mark', devOnly: false },
      'GET /api/v1/leave-types': { kind: 'tenant', permission: 'attendance.read', devOnly: false },
      'POST /api/v1/leave-types': { kind: 'tenant', permission: 'attendance.mark', devOnly: false },
      'PATCH /api/v1/leave-types/:id': { kind: 'tenant', permission: 'attendance.mark', devOnly: false },
      'GET /api/v1/leave-requests': { kind: 'tenant', permission: 'attendance.read', devOnly: false },
      'POST /api/v1/leave-requests': { kind: 'tenant', permission: 'attendance.request_leave', devOnly: false },
      'POST /api/v1/leave-requests/:id/approve': { kind: 'tenant', permission: 'attendance.approve_leave', devOnly: false },
      'POST /api/v1/leave-requests/:id/reject': { kind: 'tenant', permission: 'attendance.approve_leave', devOnly: false },
      'GET /api/v1/me/attendance-context': { kind: 'tenant', permission: 'attendance.read', devOnly: false },
      'GET /api/v1/me/attendance': { kind: 'tenant', permission: 'attendance.read', devOnly: false },
      // Phase 6 exams + results: exam types and versioned grading scales, the exam
      // lifecycle, exam subjects/schedules, the gradebook grid, teacher mark entry,
      // the correction workflow, publication, report cards, transcript and the
      // self-scoped results portal. Note the deliberate split: `exams.mark` is a
      // teacher's grant, `exams.publish` a principal's, `exams.correct` a
      // principal's, and every results READ is `exams.read` (which parents hold).
      'GET /api/v1/exam-types': { kind: 'tenant', permission: 'exams.read', devOnly: false },
      'POST /api/v1/exam-types': { kind: 'tenant', permission: 'exams.manage', devOnly: false },
      'PATCH /api/v1/exam-types/:id': { kind: 'tenant', permission: 'exams.manage', devOnly: false },
      'GET /api/v1/grading-scales': { kind: 'tenant', permission: 'exams.read', devOnly: false },
      'POST /api/v1/grading-scales': { kind: 'tenant', permission: 'exams.manage', devOnly: false },
      'PATCH /api/v1/grading-scales/:id': { kind: 'tenant', permission: 'exams.manage', devOnly: false },
      'GET /api/v1/exams': { kind: 'tenant', permission: 'exams.read', devOnly: false },
      'POST /api/v1/exams': { kind: 'tenant', permission: 'exams.manage', devOnly: false },
      'PATCH /api/v1/exams/:id': { kind: 'tenant', permission: 'exams.manage', devOnly: false },
      'POST /api/v1/exams/:id/status': { kind: 'tenant', permission: 'exams.manage', devOnly: false },
      'POST /api/v1/exams/:id/publish': { kind: 'tenant', permission: 'exams.publish', devOnly: false },
      'GET /api/v1/exams/:id/subjects': { kind: 'tenant', permission: 'exams.read', devOnly: false },
      'POST /api/v1/exams/:id/subjects': { kind: 'tenant', permission: 'exams.manage', devOnly: false },
      'PATCH /api/v1/exam-subjects/:id': { kind: 'tenant', permission: 'exams.manage', devOnly: false },
      'GET /api/v1/exams/:id/schedules': { kind: 'tenant', permission: 'exams.read', devOnly: false },
      'POST /api/v1/exam-schedules': { kind: 'tenant', permission: 'exams.manage', devOnly: false },
      'PATCH /api/v1/exam-schedules/:id': { kind: 'tenant', permission: 'exams.manage', devOnly: false },
      'GET /api/v1/exam-subjects/:id/gradebook': { kind: 'tenant', permission: 'exams.read', devOnly: false },
      'POST /api/v1/marks': { kind: 'tenant', permission: 'exams.mark', devOnly: false },
      'GET /api/v1/mark-corrections': { kind: 'tenant', permission: 'exams.correct', devOnly: false },
      'POST /api/v1/marks/:id/corrections': { kind: 'tenant', permission: 'exams.correct', devOnly: false },
      'GET /api/v1/report-cards': { kind: 'tenant', permission: 'exams.read', devOnly: false },
      'GET /api/v1/report-cards/:id': { kind: 'tenant', permission: 'exams.read', devOnly: false },
      'GET /api/v1/students/:studentId/transcript': { kind: 'tenant', permission: 'exams.read', devOnly: false },
      'GET /api/v1/me/results': { kind: 'tenant', permission: 'exams.read', devOnly: false },
    };
    // Fastify exposes a HEAD twin for every GET route; the gate captures and
    // validates those under the identical contract.
    for (const [key, want] of Object.entries({ ...expected })) {
      if (key.startsWith('GET ')) expected[`HEAD ${key.slice(4)}`] = want;
    }
    expect(byRoute.size).toBe(Object.keys(expected).length);
    for (const [key, want] of Object.entries(expected)) {
      expect(byRoute.get(key)).toEqual(expect.objectContaining(want));
    }
  });
});