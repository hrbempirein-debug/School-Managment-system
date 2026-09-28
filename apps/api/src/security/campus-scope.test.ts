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
import { assertCampusScope } from '../routes/school/util.js';

/**
 * Campus-scope authorization proofs (AUTHORIZATION.md §4) against the real app +
 * real PostgreSQL + live Redis. A membership whose `campus_id` is set may only
 * create/update/delete holidays that target its OWN campus; school-wide (NULL
 * campus) resources are explicitly out of scope, and a NULL (school-wide)
 * membership touches anything. The guard runs in the service layer per-request
 * (the tenant resolver already carries `memberships.campus_id` into the request
 * context), and denies with 403 campus_scope_denied — distinct from the generic
 * permission denial. Read LISTING remains tenant-scoped by design until Phase 3
 * read-step filtering; only writes are asserted here.
 *
 * Opt-in: RUN_RUNTIME_SECURITY_TESTS=1.
 */
const enabled = process.env.RUN_RUNTIME_SECURITY_TESTS === '1';
const describeDb = enabled ? describe : describe.skip;

const stubStorage = {
  async readObject(): Promise<Buffer> {
    throw new Error('not consulted in campus-scope tests');
  },
} as unknown as StorageProvider;

interface SessionCookies {
  token: string;
  csrf: string;
  cookie: string;
}

describeDb('API campus-scope authorization (holidays, real app + real DB + live Redis)', () => {
  let migratorDb: Db;
  let appDb: Db;
  let redis: Redis;
  let endMigrator: () => Promise<void>;
  let endApp: () => Promise<void>;
  let endRedis: () => Promise<unknown>;
  let app: Awaited<ReturnType<typeof buildApp>>;

  const uid: Record<string, string> = {};
  const slug = `cs${randomUUID().slice(0, 8)}`;
  const sessions: Record<'owner' | 'campus' | 'ownerB', SessionCookies> = {} as never;
  let campusAId = '';
  let campusBId = '';

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

  const holiday = (d: Record<string, unknown>) => ({
    name: 'Exam Break',
    startsOn: '2026-07-01',
    endsOn: '2026-07-05',
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
    uid.campusUser = randomUUID();
    uid.platform = randomUUID();
    uid.platRole = randomUUID();
    uid.ownerEmail = `owner-${slug}@example.com`;
    uid.campusEmail = `campus-${slug}@example.com`;

    await rows(
      migratorDb,
      sql`insert into roles (id, scope, code, name, is_system) values (${uid.platRole}, 'platform', ${`csp${slug}_plat`}, 'Campus Scope Platform Admin', true)`,
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
      createTenantTransaction(tx, platformCtx(uid.owner!), { slug: `${slug}-a`, name: 'Campus Scope A', requestId: randomUUID() }),
    );
    uid.tenantA = createdA.tenantId;
    const createdB = await withTenant(appDb, platformCtx(uid.owner!), (tx) =>
      createTenantTransaction(tx, platformCtx(uid.owner!), { slug: `${slug}-b`, name: 'Campus Scope B', requestId: randomUUID() }),
    );
    uid.tenantB = createdB.tenantId;

    // Campus-scoped member of tenant A. Linked to school_owner so the ONLY thing
    // standing between them and other-campus data is the campus guard.
    const schoolOwnerRows = await rows(
      migratorDb,
      sql`select id from roles where tenant_id = ${uid.tenantA} and code = 'school_owner'`,
    );
    const ownerRoleId = String(schoolOwnerRows[0]!.id);
    uid.campusMembership = randomUUID();
    await rows(
      migratorDb,
      sql`insert into memberships (id, tenant_id, user_id, status) values (${uid.campusMembership}, ${uid.tenantA}, ${uid.campusUser}, 'active')`,
    );
    await rows(
      migratorDb,
      sql`insert into membership_roles (membership_id, role_id) values (${uid.campusMembership}, ${ownerRoleId})`,
    );

    sessions.owner = await makeSession(uid.owner!, uid.tenantA!);
    sessions.ownerB = await makeSession(uid.owner!, uid.tenantB!);
    sessions.campus = await makeSession(uid.campusUser!, uid.tenantA!);

    app = await buildApp({
      deps: { db: appDb, redis, storage: stubStorage },
      logger: false,
    });

    // Unscoped owner creates the two campuses so memberships can reference them.
    const mkCampus = async (code: string, name: string) => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/campuses',
        headers: { cookie: sessions.owner.cookie, ...withCsrf(sessions.owner), ...idem(`${code}-${slug}`) },
        payload: { code, name },
      });
      expect(res.statusCode).toBe(201);
      return (res.json().campus as { id: string }).id;
    };
    campusAId = await mkCampus(`ca-${slug}`, 'Campus A');
    campusBId = await mkCampus(`cb-${slug}`, 'Campus B');

    // Set the membership's campus AFTER the campus rows exist (FK).
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
        sql`delete from membership_roles where membership_id in (select id from memberships where tenant_id in (${sql.raw(tIn)}) or user_id = ${uid.campusUser})`,
      );
      await rows(
        migratorDb,
        sql`delete from role_permissions where role_id in (select id from roles where tenant_id in (${sql.raw(tIn)}) or id = ${uid.platRole})`,
      );
      await rows(
        migratorDb,
        sql`delete from memberships where tenant_id in (${sql.raw(tIn)}) or user_id in (${uid.campusUser})`,
      );
      await rows(migratorDb, sql`delete from platform_role_assignments where user_id = ${uid.owner}`);
      await rows(migratorDb, sql`delete from roles where tenant_id in (${sql.raw(tIn)}) or id = ${uid.platRole}`);
      await rows(migratorDb, sql`delete from users where id in (${uid.owner}, ${uid.campusUser})`);
      await rows(migratorDb, sql`delete from tenants where id in (${sql.raw(tIn)})`);
    } finally {
      await endMigrator();
      await endApp();
      await endRedis?.();
    }
  });

  it('assertCampusScope: school-wide memberships pass any target; scoped ones fail the rest', () => {
    expect(() => assertCampusScope({ campusId: null }, null)).not.toThrow();
    expect(() => assertCampusScope({ campusId: null }, campusAId)).not.toThrow();
    expect(() => assertCampusScope({ campusId: campusAId }, campusAId)).not.toThrow();

    for (const target of [campusBId, null]) {
      try {
        assertCampusScope({ campusId: campusAId }, target);
        expect.unreachable('expected campus_scope_denied');
      } catch (err) {
        expect((err as { status?: number; code?: string }).status).toBe(403);
        expect((err as { code?: string }).code).toBe('campus_scope_denied');
      }
    }
  });

  it('campus-scoped member can create a holiday on its own campus', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/holidays',
      headers: { cookie: sessions.campus.cookie, ...withCsrf(sessions.campus), ...idem(`own-${slug}`) },
      payload: holiday({ campusId: campusAId }),
    });
    expect(res.statusCode).toBe(201);
    expect((res.json().holiday as { campusId: string }).campusId).toBe(campusAId);
  });

  it('campus-scoped member is denied a holiday on ANOTHER campus (403 campus_scope_denied)', async () => {
    const before = await rows(
      migratorDb,
      sql`select count(*)::int n from audit_logs where tenant_id = ${uid.tenantA} and action = 'holiday.created'`,
    );
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/holidays',
      headers: { cookie: sessions.campus.cookie, ...withCsrf(sessions.campus), ...idem(`other-${slug}`) },
      payload: holiday({ campusId: campusBId }),
    });
    expect(res.statusCode).toBe(403);
    expect(envelope(res)?.code).toBe('campus_scope_denied');
    expect(envelope(res)?.message).toBe('Campus-scoped membership denied');

    const after = await rows(
      migratorDb,
      sql`select count(*)::int n from audit_logs where tenant_id = ${uid.tenantA} and action = 'holiday.created'`,
    );
    expect(Number(after[0]!.n)).toBe(Number(before[0]!.n));
  });

  it('campus-scoped member is denied creation of a SCHOOL-WIDE (NULL campus) holiday', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/holidays',
      headers: { cookie: sessions.campus.cookie, ...withCsrf(sessions.campus), ...idem(`null-${slug}`) },
      payload: holiday({}),
    });
    expect(res.statusCode).toBe(403);
    expect(envelope(res)?.code).toBe('campus_scope_denied');
  });

  it('scoped member CAN still read the tenant-wide list (read filtering is Phase 3)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/holidays',
      headers: { cookie: sessions.campus.cookie },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { total: number }).total).toBeGreaterThanOrEqual(1);
  });

  it('unscoped owner creates school-wide and any-campus holidays', async () => {
    const schoolWide = await app.inject({
      method: 'POST',
      url: '/api/v1/holidays',
      headers: { cookie: sessions.owner.cookie, ...withCsrf(sessions.owner), ...idem(`sw-${slug}`) },
      payload: holiday({ name: 'School Holiday' }),
    });
    expect(schoolWide.statusCode).toBe(201);
    expect((schoolWide.json().holiday as { campusId: string | null }).campusId).toBeNull();

    const scoped = await app.inject({
      method: 'POST',
      url: '/api/v1/holidays',
      headers: { cookie: sessions.owner.cookie, ...withCsrf(sessions.owner), ...idem(`sb-${slug}`) },
      payload: holiday({ name: 'On B', campusId: campusBId }),
    });
    expect(scoped.statusCode).toBe(201);
  });

  it('PATCH enforces scope on both the current row and a requested campus move', async () => {
    const mine = await app.inject({
      method: 'POST',
      url: '/api/v1/holidays',
      headers: { cookie: sessions.campus.cookie, ...withCsrf(sessions.campus), ...idem(`pmine-${slug}`) },
      payload: holiday({ name: 'Patch Mine', campusId: campusAId }),
    });
    const mineId = (mine.json().holiday as { id: string }).id;

    const moveToB = await app.inject({
      method: 'PATCH',
      url: `/api/v1/holidays/${mineId}`,
      headers: { cookie: sessions.campus.cookie, ...withCsrf(sessions.campus) },
      payload: { campusId: campusBId },
    });
    expect(moveToB.statusCode).toBe(403);
    expect(envelope(moveToB)?.code).toBe('campus_scope_denied');

    const renameOwn = await app.inject({
      method: 'PATCH',
      url: `/api/v1/holidays/${mineId}`,
      headers: { cookie: sessions.campus.cookie, ...withCsrf(sessions.campus) },
      payload: { name: 'Renamed' },
    });
    expect(renameOwn.statusCode).toBe(200);
    expect((renameOwn.json().holiday as { name: string }).name).toBe('Renamed');

    const moveToA = await app.inject({
      method: 'PATCH',
      url: `/api/v1/holidays/${mineId}`,
      headers: { cookie: sessions.campus.cookie, ...withCsrf(sessions.campus) },
      payload: { campusId: campusAId },
    });
    expect(moveToA.statusCode).toBe(200);
  });

  it('DELETE enforces scope on the current row', async () => {
    const foreign = await app.inject({
      method: 'POST',
      url: '/api/v1/holidays',
      headers: { cookie: sessions.owner.cookie, ...withCsrf(sessions.owner), ...idem(`df-${slug}`) },
      payload: holiday({ name: 'Foreign Delete', campusId: campusBId }),
    });
    const foreignId = (foreign.json().holiday as { id: string }).id;

    const denied = await app.inject({
      method: 'DELETE',
      url: `/api/v1/holidays/${foreignId}`,
      headers: { cookie: sessions.campus.cookie, ...withCsrf(sessions.campus) },
    });
    expect(denied.statusCode).toBe(403);
    expect(envelope(denied)?.code).toBe('campus_scope_denied');

    const mine = await app.inject({
      method: 'POST',
      url: '/api/v1/holidays',
      headers: { cookie: sessions.campus.cookie, ...withCsrf(sessions.campus), ...idem(`dm-${slug}`) },
      payload: holiday({ name: 'My Delete', campusId: campusAId }),
    });
    const mineId = (mine.json().holiday as { id: string }).id;
    const deleted = await app.inject({
      method: 'DELETE',
      url: `/api/v1/holidays/${mineId}`,
      headers: { cookie: sessions.campus.cookie, ...withCsrf(sessions.campus) },
    });
    expect(deleted.statusCode).toBe(204);
  });

  it('scope is derived per-request from the membership: moving the member rescopes immediately', async () => {
    await rows(
      migratorDb,
      sql`update memberships set campus_id = ${campusBId} where id = ${uid.campusMembership}`,
    );

    const nowForA = await app.inject({
      method: 'POST',
      url: '/api/v1/holidays',
      headers: { cookie: sessions.campus.cookie, ...withCsrf(sessions.campus), ...idem(`move-a-${slug}`) },
      payload: holiday({ name: 'After Move To A', campusId: campusAId }),
    });
    expect(nowForA.statusCode).toBe(403);
    expect(envelope(nowForA)?.code).toBe('campus_scope_denied');

    const nowForB = await app.inject({
      method: 'POST',
      url: '/api/v1/holidays',
      headers: { cookie: sessions.campus.cookie, ...withCsrf(sessions.campus), ...idem(`move-b-${slug}`) },
      payload: holiday({ name: 'After Move To B', campusId: campusBId }),
    });
    expect(nowForB.statusCode).toBe(201);
    expect((nowForB.json().holiday as { campusId: string }).campusId).toBe(campusBId);
  });
});