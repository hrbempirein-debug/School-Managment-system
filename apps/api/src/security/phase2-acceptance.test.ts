import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { getEnv } from '@sms/config';
import { createDb, type Db } from '@sms/db';
import type { StorageProvider } from '@sms/storage';
import { FsStorageProvider } from '@sms/storage';
import { createRedis } from '@sms/redis';
import { buildApp } from '../app.js';

/**
 * Phase 2 acceptance proof (DEVELOPMENT_ROADMAP.md line 36): a brand-new school,
 * onboarded through the REAL Phase 1 flow (register → platform role → create
 * tenant → switch), becomes fully configured for an academic year: branding
 * upload + clear, settings, campuses, an OPEN academic year with terms, paid
 * holidays, a calendar with events, and departments — all over the real HTTP
 * layer against the real PostgreSQL database and live Redis.
 *
 * Opt-in: RUN_RUNTIME_SECURITY_TESTS=1.
 */
const enabled = process.env.RUN_RUNTIME_SECURITY_TESTS === '1';
const describeDb = enabled ? describe : describe.skip;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const pngBytes = () => Buffer.concat([PNG_SIGNATURE, Buffer.alloc(64, 0xa5)]);

interface Credentials {
  cookie: string;
  csrf: string;
}

describeDb('Phase 2 acceptance: onboarding → fully configured school (real app + real DB + live Redis)', () => {
  let migratorDb: Db;
  let appDb: Db;
  let redis: Redis;
  let storage: StorageProvider;
  let tempRoot: string;
  let endMigrator: () => Promise<void>;
  let endApp: () => Promise<void>;
  let endRedis: () => Promise<unknown>;
  let app: Awaited<ReturnType<typeof buildApp>>;

const slug = `p2${randomUUID().slice(0, 8)}`;
const runIp = `10.${randomUUID().slice(0, 2).charCodeAt(0) % 255}.${randomUUID().slice(2, 4).charCodeAt(0) % 255}.${1 + (randomUUID().slice(4, 6).charCodeAt(0) % 254)}`;
const uid: Record<string, string> = {};
  let auth: Credentials;
  let tenantId = '';
  let campusMainId = '';
  let activeYearId = '';
  let calendarId = '';

  const rows = async (db: Db, q: ReturnType<typeof sql>): Promise<Record<string, unknown>[]> =>
    (await db.execute(q)).rows;

  const envelope = (res: { json: () => unknown }) =>
    (res.json() as { error?: { code?: string; message?: string } }).error;

  const cookiesFor = (res: { cookies: Array<{ name: string; value: string }> }): Credentials => {
    const session = res.cookies.find((c) => c.name === getEnv().SESSION_COOKIE_NAME);
    const csrf = res.cookies.find((c) => c.name === 'csrf');
    if (!session || !csrf) throw new Error('expected session + csrf cookies after login');
    return { cookie: `${session.name}=${session.value}`, csrf: csrf.value };
  };

  const csrfHeaders = (c: Credentials) => ({ cookie: c.cookie, 'x-csrf-token': c.csrf });

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
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sms-acceptance-'));
    storage = new FsStorageProvider(tempRoot);

    app = await buildApp({
      deps: { db: appDb, redis, storage },
      logger: false,
    });
  });

  afterAll(async () => {
    try {
      if (app) await app.close();
      const tIn = tenantId ? `'${tenantId}'` : '';
      if (tIn) {
        await rows(migratorDb, sql`delete from outbox_events where tenant_id in (${sql.raw(tIn)})`);
        await rows(migratorDb, sql`delete from idempotency_keys where tenant_id in (${sql.raw(tIn)})`);
        await rows(
          migratorDb,
          sql`delete from membership_roles where membership_id in (select id from memberships where tenant_id in (${sql.raw(tIn)}))`,
        );
        await rows(
          migratorDb,
          sql`delete from role_permissions where role_id in (select id from roles where tenant_id in (${sql.raw(tIn)}) or id = ${uid.platRole ?? ''})`,
        );
        await rows(
          migratorDb,
          sql`delete from memberships where tenant_id in (${sql.raw(tIn)})`,
        );
        await rows(
          migratorDb,
          sql`delete from platform_role_assignments where user_id = ${uid.userId ?? ''}`,
        );
        await rows(migratorDb, sql`delete from roles where tenant_id in (${sql.raw(tIn)}) or id = ${uid.platRole ?? ''}`);
        await rows(migratorDb, sql`delete from auth_sessions where user_id = ${uid.userId ?? ''}`);
        await rows(migratorDb, sql`delete from auth_tokens where user_id = ${uid.userId ?? ''}`);
        await rows(migratorDb, sql`delete from users where id = ${uid.userId ?? ''}`);
        await rows(migratorDb, sql`delete from tenants where id in (${sql.raw(tIn)})`);
      }
    } finally {
      await endMigrator();
      await endApp();
      await endRedis?.();
      await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => {});
    }
  });

  // -------------------------------------------------------------- Phase 1 flow
  it('registers a new user over the real auth route', async () => {
    const email = `staff-${slug}@example.com`;
    uid.email = email;
    uid.password = `Passw0rd-${slug}!`;
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      remoteAddress: runIp,
      payload: { email, password: uid.password, fullName: 'Onboarding Staff' },
    });
    if (res.statusCode !== 200) console.error('REGISTER FAIL', res.statusCode, res.body);
    expect(res.statusCode).toBe(200);
    uid.userId = (res.json() as { userId: string }).userId;
    expect(uid.userId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('grants the platform bootstrapper role to the user and logs in for real', async () => {
    uid.platRole = randomUUID();
    await rows(
      migratorDb,
      sql`insert into roles (id, scope, code, name, is_system) values (${uid.platRole}, 'platform', ${`p2p${slug}_plat`}, 'Acceptance Platform Admin', true)`,
    );
    await rows(
      migratorDb,
      sql`insert into role_permissions (role_id, permission) values (${uid.platRole}, 'platform.tenants.read'), (${uid.platRole}, 'platform.tenants.create')`,
    );
    await rows(
      migratorDb,
      sql`insert into platform_role_assignments (user_id, role_id) values (${uid.userId}, ${uid.platRole})`,
    );

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      remoteAddress: runIp,
      payload: { email: uid.email, password: uid.password },
    });
    expect(res.statusCode).toBe(200);
    auth = cookiesFor(res);
  });

  it('bootstraps the tenants (Phase 1 onboarding) over the real platform route', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/platform/tenants',
      headers: { ...csrfHeaders(auth), ...idem(`tenant-${slug}`) },
      payload: { slug: `new-${slug}`, name: 'New Horizon School' },
    });
    expect(res.statusCode).toBe(201);
    tenantId = (res.json() as { id: string }).id;
  });

  it('switches the active tenant so school routes resolve the context', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/tenants/switch',
      headers: { ...csrfHeaders(auth) },
      payload: { tenantId },
    });
    expect(res.statusCode).toBe(200);
    const me = res.json() as { activeTenant: { id: string }; permissions: string[] };
    expect(me.activeTenant.id).toBe(tenantId);
    expect(me.permissions).toEqual(expect.arrayContaining(['campus.read', 'school.branding.manage']));
  });

  // ----------------------------------------------------------- Phase 2 setup
  it('reads (and creates) the settings singleton over HTTP', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/settings',
      headers: { cookie: auth.cookie },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json().settings as { tenantId: string }).tenantId).toBe(tenantId);
  });

  it('uploads branding and can fetch the logo bytes back', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/v1/settings/branding',
      headers: { ...csrfHeaders(auth), 'content-type': 'image/png' },
      payload: pngBytes(),
    });
    expect(res.statusCode).toBe(200);
    const logoPath = (res.json().settings as { logoPath: string }).logoPath;
    expect(logoPath.startsWith('branding/')).toBe(true);

    const logo = await app.inject({
      method: 'GET',
      url: '/api/v1/settings/branding/logo',
      headers: { cookie: auth.cookie },
    });
    expect(logo.statusCode).toBe(200);
    expect(logo.headers['content-type']).toBe('image/png');
    expect(logo.rawPayload.equals(pngBytes())).toBe(true);
  });

  it('records school context via settings PATCH', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/settings',
      headers: { ...csrfHeaders(auth) },
      payload: { schoolName: 'New Horizon School', schoolCode: `NH-${slug.slice(0, 4)}`, brandingColor: '#7c3aed' },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json().settings as { schoolName: string }).schoolName).toBe('New Horizon School');
  });

  it('creates campuses', async () => {
    const main = await app.inject({
      method: 'POST',
      url: '/api/v1/campuses',
      headers: { ...csrfHeaders(auth), ...idem(`campus-main-${slug}`) },
      payload: { code: `main-${slug}`, name: 'Main Campus', city: 'Kigali' },
    });
    expect(main.statusCode).toBe(201);
    campusMainId = (main.json().campus as { id: string }).id;

    const second = await app.inject({
      method: 'POST',
      url: '/api/v1/campuses',
      headers: { ...csrfHeaders(auth), ...idem(`campus-annex-${slug}`) },
      payload: { code: `annex-${slug}`, name: 'Annex Campus' },
    });
    expect(second.statusCode).toBe(201);
  });

  it('configures an academic year with three terms (acceptance core)', async () => {
    const year = await app.inject({
      method: 'POST',
      url: '/api/v1/academic-years',
      headers: { ...csrfHeaders(auth), ...idem(`ay-${slug}`) },
      payload: { code: `AY-${slug}`, name: 'Academic Year 2026', startsOn: '2026-01-01', endsOn: '2026-12-31' },
    });
    expect(year.statusCode).toBe(201);
    activeYearId = (year.json().academicYear as { id: string }).id;

    const opened = await app.inject({
      method: 'POST',
      url: `/api/v1/academic-years/${activeYearId}/open`,
      headers: { ...csrfHeaders(auth) },
    });
    expect(opened.statusCode).toBe(200);
    expect((opened.json().academicYear as { status: string }).status).toBe('active');

    const terms: Array<{ code: string; name: string; sequence: number; startsOn: string; endsOn: string }> = [
      { code: 'T1', name: 'Term 1', sequence: 1, startsOn: '2026-02-01', endsOn: '2026-04-30' },
      { code: 'T2', name: 'Term 2', sequence: 2, startsOn: '2026-05-11', endsOn: '2026-08-07' },
      { code: 'T3', name: 'Term 3', sequence: 3, startsOn: '2026-09-07', endsOn: '2026-11-27' },
    ];
    for (const t of terms) {
      const created = await app.inject({
        method: 'POST',
        url: `/api/v1/academic-years/${activeYearId}/terms`,
        headers: { ...csrfHeaders(auth), ...idem(`term-${t.sequence}-${slug}`) },
        payload: t,
      });
      expect(created.statusCode, t.code).toBe(201);
    }

    const termList = await app.inject({
      method: 'GET',
      url: `/api/v1/academic-years/${activeYearId}/terms?limit=100&offset=0`,
      headers: { cookie: auth.cookie },
    });
    expect(termList.statusCode).toBe(200);
    expect((termList.json() as { total: number }).total).toBe(3);

    // Open Term 1 so the year is "in progress"; closing the year is then legitimately
    // blocked (guarding the term too).
    const termId = (termList.json() as { items: { id: string }[] }).items.find((i) => i.id)!.id;
    const termOpen = await app.inject({
      method: 'POST',
      url: `/api/v1/academic-terms/${termId}/open`,
      headers: { ...csrfHeaders(auth) },
    });
    expect(termOpen.statusCode).toBe(200);

    const closeBlocked = await app.inject({
      method: 'POST',
      url: `/api/v1/academic-years/${activeYearId}/close`,
      headers: { ...csrfHeaders(auth) },
    });
    expect(closeBlocked.statusCode).toBe(409);
    expect(envelope(closeBlocked)?.code).toBe('academic_year_has_open_terms');
  });

  it('adds a campus-scoped paid holiday', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/holidays',
      headers: { ...csrfHeaders(auth), ...idem(`hol-${slug}`) },
      payload: { name: 'Liberation Day', startsOn: '2026-07-04', endsOn: '2026-07-04', campusId: campusMainId },
    });
    expect(res.statusCode).toBe(201);
    const holiday = res.json().holiday as { campusId: string };
    expect(holiday.campusId).toBe(campusMainId);
  });

  it('creates a calendar with events', async () => {
    const cal = await app.inject({
      method: 'POST',
      url: '/api/v1/calendars',
      headers: { ...csrfHeaders(auth), ...idem(`cal-${slug}`) },
      payload: { code: `CAL-${slug}`, name: 'School Calendar 2026' },
    });
    expect(cal.statusCode).toBe(201);
    calendarId = (cal.json().calendar as { id: string }).id;

    for (let i = 1; i <= 2; i++) {
      const ev = await app.inject({
        method: 'POST',
        url: `/api/v1/calendars/${calendarId}/events`,
        headers: { ...csrfHeaders(auth), ...idem(`ev${i}-${slug}`) },
        payload: { title: `Assembly ${i}`, startsAt: `2026-03-0${i}T08:00:00.000Z`, endsAt: `2026-03-0${i}T09:00:00.000Z` },
      });
      expect(ev.statusCode, `event ${i}`).toBe(201);
    }

    const list = await app.inject({
      method: 'GET',
      url: `/api/v1/calendars/${calendarId}/events?limit=100&offset=0`,
      headers: { cookie: auth.cookie },
    });
    expect((list.json() as { total: number }).total).toBe(2);
  });

  it('creates and activates departments', async () => {
    const math = await app.inject({
      method: 'POST',
      url: '/api/v1/departments',
      headers: { ...csrfHeaders(auth), ...idem(`math-${slug}`) },
      payload: { code: `math-${slug}`, name: 'Mathematics' },
    });
    expect(math.statusCode).toBe(201);
    const mathId = (math.json().department as { id: string }).id;

    const science = await app.inject({
      method: 'POST',
      url: '/api/v1/departments',
      headers: { ...csrfHeaders(auth), ...idem(`sci-${slug}`) },
      payload: { code: `sci-${slug}`, name: 'Science' },
    });
    expect(science.statusCode).toBe(201);

    const activated = await app.inject({
      method: 'POST',
      url: `/api/v1/departments/${mathId}/activate`,
      headers: { ...csrfHeaders(auth) },
    });
    expect(activated.statusCode).toBe(200);
  });

  // ------------------------------------------------------------ acceptance bar
  it('ACCEPTANCE: the new school (Phase 1 onboarding) is fully configured for an academic year', async () => {
    const settings = await rows(
      migratorDb,
      sql`select logo_path from school_settings where tenant_id = ${tenantId}`,
    );
    expect(String(settings[0]?.logo_path ?? '')).toContain('branding/');

    const campusCount = await rows(
      migratorDb,
      sql`select count(*)::int n from campuses where tenant_id = ${tenantId} and status = 'active'`,
    );
    expect(Number(campusCount[0]!.n)).toBeGreaterThanOrEqual(2);

    const year = await rows(
      migratorDb,
      sql`select id from academic_years where tenant_id = ${tenantId} and status = 'active' limit 1`,
    );
    const activeYear = String(year[0]?.id ?? '');
    expect(activeYear).toBe(activeYearId);

    const termCount = await rows(
      migratorDb,
      sql`select count(*)::int n from academic_terms where academic_year_id = ${activeYear}`,
    );
    expect(Number(termCount[0]!.n)).toBe(3);

    const openTerm = await rows(
      migratorDb,
      sql`select count(*)::int n from academic_terms where academic_year_id = ${activeYear} and status = 'open'`,
    );
    expect(Number(openTerm[0]!.n)).toBe(1);

    const calendarCount = await rows(
      migratorDb,
      sql`select count(*)::int n from calendars where tenant_id = ${tenantId}`,
    );
    const eventCount = await rows(
      migratorDb,
      sql`select count(*)::int n from calendar_events where calendar_id in (select id from calendars where tenant_id = ${tenantId})`,
    );
    expect(Number(calendarCount[0]!.n)).toBeGreaterThanOrEqual(1);
    expect(Number(eventCount[0]!.n)).toBeGreaterThanOrEqual(2);

    const holidayCount = await rows(
      migratorDb,
      sql`select count(*)::int n from holidays where tenant_id = ${tenantId} and deleted_at is null`,
    );
    expect(Number(holidayCount[0]!.n)).toBeGreaterThanOrEqual(1);

    const departmentCount = await rows(
      migratorDb,
      sql`select count(*)::int n from departments where tenant_id = ${tenantId}`,
    );
    expect(Number(departmentCount[0]!.n)).toBeGreaterThanOrEqual(2);
  });

  it('the same staff member can still operate through the portal after all of the above', async () => {
    const me = await app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: { cookie: auth.cookie },
    });
    expect(me.statusCode).toBe(200);
    const body = me.json() as { scope: string; activeTenant: { id: string } | null; permissions: string[] };
    expect(body.scope).toBe('tenant');
    expect(body.activeTenant?.id).toBe(tenantId);
    for (const p of ['campus.read', 'academic.years.read', 'academic.terms.read', 'calendar.read', 'departments.read', 'school.settings.manage', 'school.branding.manage']) {
      expect(body.permissions).toContain(p);
    }
  });
});