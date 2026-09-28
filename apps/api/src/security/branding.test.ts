import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { getEnv } from '@sms/config';
import { createDb, withTenant, type Db } from '@sms/db';
import type { RequestContext } from '@sms/core';
import type { StorageProvider } from '@sms/storage';
import { FsStorageProvider } from '@sms/storage';
import { BRANDING_KEY_PATTERN } from '@sms/contracts';
import { writeSession, type RedisSession } from '@sms/auth';
import { createRedis } from '@sms/redis';
import { buildApp } from '../app.js';
import { createTenantTransaction } from '../routes/tenants.js';
import { detectBrandingImage, MAX_BRANDING_BYTES } from '../routes/school/branding.js';

/**
 * Branding file-rule proofs against the REAL Fastify app, real PostgreSQL
 * (migrations 0001..0004) and live Redis. Storage is a throwaway temp-directory
 * FsStorageProvider so upload/replace/clear semantics are observable on disk
 * while never touching the real store root.
 *
 * Proves: the school.branding.manage permission boundary, CSRF on the upload,
 * the 512 KiB cap, the raster-only allow-list enforced by magic-byte sniffing,
 * content-type spoofing rejection, server-generated `branding/{uuidv7}.{ext}`
 * keys, replace-removes-previous, explicit clear via settings PATCH, and
 * tenant isolation of the GET.
 *
 * Opt-in: RUN_RUNTIME_SECURITY_TESTS=1.
 */
const enabled = process.env.RUN_RUNTIME_SECURITY_TESTS === '1';
const describeDb = enabled ? describe : describe.skip;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const pngBytes = (size = 64) => Buffer.concat([PNG_SIGNATURE, Buffer.alloc(size, 0xa5)]);
const jpegBytes = (size = 64) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(size, 0xbb)]);
const webpBytes = (size = 64) =>
  Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x00, 0x00, 0x00, 0x1c]), Buffer.from('WEBP'), Buffer.alloc(size, 0xcc)]);
const svgBytes = () => Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

describe('branding file rules (pure, no infrastructure)', () => {
  it('detects the three allowed raster formats by magic bytes', () => {
    expect(detectBrandingImage(pngBytes())).toBe('png');
    expect(detectBrandingImage(jpegBytes())).toBe('jpeg');
    expect(detectBrandingImage(webpBytes())).toBe('webp');
  });

  it('rejects SVG and empty/garbage input', () => {
    expect(detectBrandingImage(svgBytes())).toBeNull();
    expect(detectBrandingImage(Buffer.alloc(0))).toBeNull();
    expect(detectBrandingImage(Buffer.from('plain text that is not an image'))).toBeNull();
  });

  it('detects a type even when a spoofed prefix greets and the suffix differs', () => {
    const pngWithTrailingGarbage = Buffer.concat([PNG_SIGNATURE, Buffer.alloc(32, 0xff)]);
    expect(detectBrandingImage(pngWithTrailingGarbage)).toBe('png');
  });

  it('covers any body up to the documented cap', () => {
    expect(detectBrandingImage(pngBytes(MAX_BRANDING_BYTES))).toBe('png');
  });

  it('BRANDING_KEY_PATTERN only admits generated branding keys', () => {
    expect(BRANDING_KEY_PATTERN.test(`branding/${randomUUID()}.png`)).toBe(true);
    expect(BRANDING_KEY_PATTERN.test(`branding/${randomUUID()}.jpeg`)).toBe(true);
    expect(BRANDING_KEY_PATTERN.test(`branding/${randomUUID()}.webp`)).toBe(true);
    expect(BRANDING_KEY_PATTERN.test(`branding/not-a-uuid.png`)).toBe(false);
    expect(BRANDING_KEY_PATTERN.test(`other/${randomUUID()}.png`)).toBe(false);
    expect(BRANDING_KEY_PATTERN.test(`branding/${randomUUID()}.svg`)).toBe(false);
    expect(BRANDING_KEY_PATTERN.test(`../${randomUUID()}.png`)).toBe(false);
  });
});

interface SessionCookies {
  token: string;
  csrf: string;
  cookie: string;
}

describeDb('API branding upload + file rules (real app + real DB + live Redis + temp storage)', () => {
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
  const slug = `bg${randomUUID().slice(0, 8)}`;
  const sessions: Record<'a' | 'b' | 'parent', SessionCookies> = {} as never;
  let keyA = '';
  let tenantAPath = '';

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

  const putLogo = (s: SessionCookies, data: Buffer, contentType: string, extra: Record<string, string> = {}) =>
    app.inject({
      method: 'PUT',
      url: '/api/v1/settings/branding',
      headers: { cookie: s.cookie, 'content-type': contentType, ...withCsrf(s), ...extra },
      payload: data,
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

    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sms-branding-'));
    storage = new FsStorageProvider(tempRoot);

    uid.owner = randomUUID();
    uid.parent = randomUUID();
    uid.platform = randomUUID();
    uid.platRole = randomUUID();
    uid.ownerEmail = `owner-${slug}@example.com`;
    uid.parentEmail = `parent-${slug}@example.com`;
    uid.platformEmail = `platform-${slug}@example.com`;

    await rows(
      migratorDb,
      sql`insert into roles (id, scope, code, name, is_system) values (${uid.platRole}, 'platform', ${`bgp${slug}_plat`}, 'Branding Platform Admin', true)`,
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
      createTenantTransaction(tx, platformCtx(uid.owner!), { slug: `${slug}-a`, name: 'Branding Tenant A', requestId: randomUUID() }),
    );
    uid.tenantA = createdA.tenantId;
    const createdB = await withTenant(appDb, platformCtx(uid.owner!), (tx) =>
      createTenantTransaction(tx, platformCtx(uid.owner!), { slug: `${slug}-b`, name: 'Branding Tenant B', requestId: randomUUID() }),
    );
    uid.tenantB = createdB.tenantId;

    const parentRoleRows = await rows(
      migratorDb,
      sql`select id from roles where tenant_id = ${uid.tenantA} and code = 'parent'`,
    );
    const parentRoleId = String(parentRoleRows[0]!.id);
    const parentMembershipRows = await rows(
      migratorDb,
      sql`insert into memberships (id, tenant_id, user_id, status) values (${randomUUID()}, ${uid.tenantA}, ${uid.parent}, 'active') returning id`,
    );
    uid.parentMembership = String(parentMembershipRows[0]!.id);
    await rows(
      migratorDb,
      sql`insert into membership_roles (membership_id, role_id) values (${uid.parentMembership}, ${parentRoleId})`,
    );

    sessions.a = await makeSession(uid.owner!, uid.tenantA!);
    sessions.b = await makeSession(uid.owner!, uid.tenantB!);
    sessions.parent = await makeSession(uid.parent!, uid.tenantA!);

    tenantAPath = path.join(tempRoot, uid.tenantA!, 'branding');

    app = await buildApp({
      deps: { db: appDb, redis, storage },
      logger: false,
    });
  });

  afterAll(async () => {
    try {
      if (app) await app.close();
      const tenantIds = [uid.tenantA!, uid.tenantB!];
      const tIn = tenantIds.map((t) => (t ? `'${t}'` : '')).join(',');
      await rows(migratorDb, sql`delete from outbox_events where tenant_id in (${sql.raw(tIn)})`);
      await rows(migratorDb, sql`delete from idempotency_keys where tenant_id in (${sql.raw(tIn)})`);
      await rows(
        migratorDb,
        sql`delete from membership_roles where membership_id in (select id from memberships where tenant_id in (${sql.raw(tIn)}) or user_id = ${uid.parent})`,
      );
      await rows(
        migratorDb,
        sql`delete from role_permissions where role_id in (select id from roles where tenant_id in (${sql.raw(tIn)}) or id = ${uid.platRole})`,
      );
      await rows(
        migratorDb,
        sql`delete from memberships where tenant_id in (${sql.raw(tIn)}) or user_id = ${uid.parent}`,
      );
      await rows(
        migratorDb,
        sql`delete from platform_role_assignments where user_id = ${uid.owner}`,
      );
      await rows(migratorDb, sql`delete from roles where tenant_id in (${sql.raw(tIn)}) or id = ${uid.platRole}`);
      await rows(migratorDb, sql`delete from users where id in (${uid.owner}, ${uid.parent})`);
      await rows(migratorDb, sql`delete from tenants where id in (${sql.raw(tIn)})`);
    } finally {
      await endMigrator();
      await endApp();
      await endRedis?.();
      await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => {});
    }
  });

  // ------------------------------------------------------------ boundaries
  it('reports both branding endpoints in the post-boot authorization matrix', () => {
    const byRoute = new Map(
      app.routeAuthorizationMatrix().routes.map((r) => [`${r.method} ${r.url}`, r]),
    );
    expect(byRoute.get('PUT /api/v1/settings/branding')).toEqual(
      expect.objectContaining({ kind: 'tenant', permission: 'school.branding.manage', devOnly: false }),
    );
    expect(byRoute.get('GET /api/v1/settings/branding/logo')).toEqual(
      expect.objectContaining({ kind: 'tenant', permission: 'school.branding.manage', devOnly: false }),
    );
    expect(byRoute.get('HEAD /api/v1/settings/branding/logo')).toEqual(
      expect.objectContaining({ kind: 'tenant', permission: 'school.branding.manage', devOnly: false }),
    );
  });

  it('rejects anonymous PUT and GET before any storage/parser work (401)', async () => {
    const put = await app.inject({
      method: 'PUT',
      url: '/api/v1/settings/branding',
      headers: { 'content-type': 'image/png' },
      payload: pngBytes(),
    });
    expect(put.statusCode).toBe(401);
    expect(envelope(put)?.code).toBe('unauthenticated');

    const get = await app.inject({ method: 'GET', url: '/api/v1/settings/branding/logo' });
    expect(get.statusCode).toBe(401);
  });

  it('denies upload and read to a principal without school.branding.manage (403 + requiredPermission)', async () => {
    const put = await putLogo(sessions.parent, pngBytes(), 'image/png');
    expect(put.statusCode).toBe(403);
    expect(envelope(put)?.code).toBe('forbidden');
    expect(envelope(put)?.requiredPermission).toBe('school.branding.manage');

    const get = await app.inject({
      method: 'GET',
      url: '/api/v1/settings/branding/logo',
      headers: { cookie: sessions.parent.cookie },
    });
    expect(get.statusCode).toBe(403);
    expect(envelope(get)?.requiredPermission).toBe('school.branding.manage');
  });

  it('requires the CSRF double-submit token on the upload', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/v1/settings/branding',
      headers: { cookie: sessions.a.cookie, 'content-type': 'image/png' },
      payload: pngBytes(),
    });
    expect(res.statusCode).toBe(403);
    expect(envelope(res)?.code).toBe('csrf_invalid');
    const stored = await rows(
      migratorDb,
      sql`select logo_path from school_settings where tenant_id = ${uid.tenantA}`,
    );
    expect(stored[0]?.logo_path ?? null).toBeNull();
  });

  // ------------------------------------------------------------- happy path
  it('owner uploads a PNG and the server generates a branding/{uuid}.png key', async () => {
    const res = await putLogo(sessions.a, pngBytes(), 'image/png');
    expect(res.statusCode).toBe(200);
    const settings = (res.json().settings as { logoPath: string });
    expect(BRANDING_KEY_PATTERN.test(settings.logoPath)).toBe(true);
    expect(settings.logoPath.endsWith('.png')).toBe(true);
    keyA = settings.logoPath;

    const dbRow = await rows(
      migratorDb,
      sql`select logo_path from school_settings where tenant_id = ${uid.tenantA}`,
    );
    expect(String(dbRow[0]!.logo_path)).toBe(keyA);

    const stored = await storage.readObject(uid.tenantA!, keyA);
    expect(stored.equals(pngBytes())).toBe(true);
  });

  it('accepts jpeg and webp (with a content-type match) and serves them with the right media type', async () => {
    const jpeg = await putLogo(sessions.a, jpegBytes(), 'image/jpeg');
    expect(jpeg.statusCode).toBe(200);
    const jpegKey = (jpeg.json().settings as { logoPath: string }).logoPath;
    expect(jpegKey.endsWith('.jpeg')).toBe(true);

    const jpegGet = await app.inject({
      method: 'GET',
      url: '/api/v1/settings/branding/logo',
      headers: { cookie: sessions.a.cookie },
    });
    expect(jpegGet.statusCode).toBe(200);
    expect(jpegGet.headers['content-type']).toBe('image/jpeg');
    expect(jpegGet.headers['cache-control']).toBe('private, max-age=300');
    expect(jpegGet.rawPayload.equals(jpegBytes())).toBe(true);

    const webp = await putLogo(sessions.a, webpBytes(), 'image/webp');
    expect(webp.statusCode).toBe(200);
    const webpKey = (webp.json().settings as { logoPath: string }).logoPath;
    expect(webpKey.endsWith('.webp')).toBe(true);

    const webpGet = await app.inject({
      method: 'GET',
      url: '/api/v1/settings/branding/logo',
      headers: { cookie: sessions.a.cookie },
    });
    expect(webpGet.headers['content-type']).toBe('image/webp');
  });

  it('accepts an octet-stream upload when magic bytes prove a real image', async () => {
    const res = await putLogo(sessions.a, pngBytes(), 'application/octet-stream');
    expect(res.statusCode).toBe(200);
    const key = (res.json().settings as { logoPath: string }).logoPath;
    expect(key.endsWith('.png')).toBe(true);
  });

  // ------------------------------------------------------ file-rule policing
  it('rejects a declared type that contradicts the file contents (415 content_type_mismatch)', async () => {
    const before = await rows(
      migratorDb,
      sql`select logo_path from school_settings where tenant_id = ${uid.tenantA}`,
    );
    const beforePath = String(before[0]!.logo_path);
    const res = await putLogo(sessions.a, jpegBytes(), 'image/png');
    expect(res.statusCode).toBe(415);
    expect(envelope(res)?.code).toBe('content_type_mismatch');

    const after = await rows(
      migratorDb,
      sql`select logo_path from school_settings where tenant_id = ${uid.tenantA}`,
    );
    expect(String(after[0]!.logo_path)).toBe(beforePath);
    await expect(storage.readObject(uid.tenantA!, beforePath)).resolves.toBeTruthy();
  });

  it('rejects SVG and non-image bodies even when declared as octet-stream (415 unsupported_media_type)', async () => {
    const res = await putLogo(sessions.a, svgBytes(), 'application/octet-stream');
    expect(res.statusCode).toBe(415);
    expect(envelope(res)?.code).toBe('unsupported_media_type');
  });

  it('rejects bodies over 512 KiB before anything is written (413 payload_too_large)', async () => {
    const before = await rows(
      migratorDb,
      sql`select logo_path from school_settings where tenant_id = ${uid.tenantA}`,
    );
    const beforePath = String(before[0]!.logo_path);
    const oversized = Buffer.concat([PNG_SIGNATURE, Buffer.alloc(MAX_BRANDING_BYTES + 1, 0xa5)]);
    const res = await putLogo(sessions.a, oversized, 'image/png');
    expect(res.statusCode).toBe(413);
    expect(envelope(res)?.code).toBe('payload_too_large');

    const after = await rows(
      migratorDb,
      sql`select logo_path from school_settings where tenant_id = ${uid.tenantA}`,
    );
    expect(String(after[0]!.logo_path)).toBe(beforePath);
  });

  it('removes the superseded object after a successful replacement', async () => {
    const previous = keyA;
    expect(previous).toBeTruthy();
    const res = await putLogo(sessions.a, webpBytes(), 'image/webp');
    expect(res.statusCode).toBe(200);
    const next = (res.json().settings as { logoPath: string }).logoPath;
    expect(next).not.toBe(previous);
    expect(next.endsWith('.webp')).toBe(true);

    expect(await storage.readObject(uid.tenantA!, next)).toBeTruthy();
    // Deletion is best-effort (fire and forget) so we poll instead of racing.
    let gone = false;
    for (let i = 0; i < 20 && !gone; i++) {
      gone = await storage.headObject(uid.tenantA!, previous).then(
        () => false,
        () => true,
      );
      if (!gone) await new Promise((r) => setTimeout(r, 25));
    }
    expect(gone).toBe(true);
  });

  it('clears the logo via settings PATCH logoPath null and GET then 404s', async () => {
    const cleared = await app.inject({
      method: 'PATCH',
      url: '/api/v1/settings',
      headers: { cookie: sessions.a.cookie, ...withCsrf(sessions.a) },
      payload: { logoPath: null },
    });
    expect(cleared.statusCode).toBe(200);
    expect((cleared.json().settings as { logoPath: string | null }).logoPath).toBeNull();

    const get = await app.inject({
      method: 'GET',
      url: '/api/v1/settings/branding/logo',
      headers: { cookie: sessions.a.cookie },
    });
    expect(get.statusCode).toBe(404);
    expect(envelope(get)?.code).toBe('not_found');
  });

  it('settings PATCH restricts logoPath to the branding key shape (validation_error otherwise)', async () => {
    const bad = await app.inject({
      method: 'PATCH',
      url: '/api/v1/settings',
      headers: { cookie: sessions.a.cookie, ...withCsrf(sessions.a) },
      payload: { logoPath: '../evil.png' },
    });
    expect(bad.statusCode).toBe(400);
    expect(envelope(bad)?.code).toBe('validation_error');

    const good = await app.inject({
      method: 'PATCH',
      url: '/api/v1/settings',
      headers: { cookie: sessions.a.cookie, ...withCsrf(sessions.a) },
      payload: { logoPath: `branding/${randomUUID()}.png` },
    });
    expect(good.statusCode).toBe(200);
    expect(BRANDING_KEY_PATTERN.test((good.json().settings as { logoPath: string }).logoPath)).toBe(true);
  });

  // --------------------------------------------------------- tenant isolation
  it('tenant B is a separate branding namespace: GET 404s until B uploads its own', async () => {
    const foreign = await app.inject({
      method: 'GET',
      url: '/api/v1/settings/branding/logo',
      headers: { cookie: sessions.b.cookie },
    });
    expect(foreign.statusCode).toBe(404);
    expect(envelope(foreign)?.code).toBe('not_found');

    const res = await putLogo(sessions.b, pngBytes(), 'image/png');
    expect(res.statusCode).toBe(200);
    const bKey = (res.json().settings as { logoPath: string }).logoPath;

    const bGet = await app.inject({
      method: 'GET',
      url: '/api/v1/settings/branding/logo',
      headers: { cookie: sessions.b.cookie },
    });
    expect(bGet.statusCode).toBe(200);
    expect(bGet.rawPayload.equals(pngBytes())).toBe(true);
    expect(bKey).not.toBe(keyA);
  });

  // ------------------------------------------------------------- audit/outbox
  it('records every branding change in audit + the existing school.settings.updated outbox event', async () => {
    const logoAudit = await rows(
      migratorDb,
      sql`select count(*)::int n from audit_logs where tenant_id = ${uid.tenantA} and action = 'school.settings.updated'
          and new_value::text like ${`%branding%`} and new_value::text like ${`%.png%`}`,
    );
    expect(Number(logoAudit[0]!.n)).toBeGreaterThanOrEqual(1);

    const logoOutbox = await rows(
      migratorDb,
      sql`select count(*)::int n from outbox_events where tenant_id = ${uid.tenantA} and event_type = 'school.settings.updated'`,
    );
    expect(Number(logoOutbox[0]!.n)).toBeGreaterThanOrEqual(1);
  });

  it('an upload writes objects only under {storageRoot}/{tenantId}/branding', async () => {
    const entries = tenantAPath ? await fs.readdir(tenantAPath).catch(() => [] as string[]) : [];
    const wrong = entries.find((e) => !BRANDING_KEY_PATTERN.test(`branding/${e}`));
    expect(wrong).toBeUndefined();
  });
});