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
import { DOCUMENT_KEY_PATTERN } from '@sms/contracts';
import { writeSession, type RedisSession } from '@sms/auth';
import { createRedis } from '@sms/redis';
import { buildApp } from '../app.js';
import { createTenantTransaction } from '../routes/tenants.js';
import { sanitizeDisplayName } from '../routes/school/student-documents.js';

/**
 * Phase 3.4 student-documents HTTP security + lifecycle acceptance proofs against
 * the ACTUAL Fastify app (buildApp), real dev PostgreSQL under the real
 * `school_app_rw` role, LIVE Redis, and a throwaway temp-directory
 * FsStorageProvider (so uploads land on real disk and can be re-read/verified).
 *
 * Proves end-to-end:
 *   - authorization wiring on all 6 document routes (HEAD twins), session /
 *     permission / CSRF gates, and the principal read-only boundary;
 *   - upload acceptance: raw-buffer body, magic-byte sniff (415), content-type
 *     mismatch (415), size caps (413), display-name sanitization, free-form
 *     documentType validation, server-generated `documents/{uuidv7}.{ext}` key,
 *     files+student_documents row pair (scan 'pending', content sha256), audit +
 *     student.document.uploaded outbox, idempotent replay, distinct-key duplicates;
 *   - metadata GET, filtered list, download gate (403 scan_incomplete until clean;
 *     worker-equivalent clean transition then streams bytes with correct headers;
 *     blocked stays gated) and object presence on the real provider;
 *   - PATCH metadata (mass-assignment 400, empty 400, idempotency), soft DELETE
 *     (204, hidden, file tombstoned, re-delete 404);
 *   - cross-tenant 404s, campus-scope 403 (write) / 404 (read) isolation;
 *   - a final DB-consistency acceptance pass (no orphans, keys match pattern).
 *
 * Opt-in: RUN_RUNTIME_SECURITY_TESTS=1.
 */
const enabled = process.env.RUN_RUNTIME_SECURITY_TESTS === '1';
const describeDb = enabled ? describe : describe.skip;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PDF_SIGNATURE = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d]);
const pngBytes = (size = 64) => Buffer.concat([PNG_SIGNATURE, Buffer.alloc(size, 0xa5)]);
const pdfBytes = (size = 128) => Buffer.concat([PDF_SIGNATURE, Buffer.alloc(size, 0x44)]);
const svgBytes = () => Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

describe('student document sanitizeDisplayName + key pattern (pure)', () => {
  it('accepts plain names, trims, caps at 255 chars', () => {
    expect(sanitizeDisplayName(' birth.pdf ')).toBe('birth.pdf');
    expect(sanitizeDisplayName('a'.repeat(255))).toBe('a'.repeat(255));
    expect(sanitizeDisplayName('a'.repeat(256))).toBeNull();
    expect(sanitizeDisplayName('')).toBeNull();
    expect(sanitizeDisplayName(null)).toBeNull();
  });

  it('rejects path separators, traversal, NUL and control bytes', () => {
    expect(sanitizeDisplayName('../evil.pdf')).toBeNull();
    expect(sanitizeDisplayName('a\\b.pdf')).toBeNull();
    expect(sanitizeDisplayName('a\u0000b.pdf')).toBeNull();
    expect(sanitizeDisplayName('a\u0001b.pdf')).toBeNull();
  });

  it('DOCUMENT_KEY_PATTERN only admits server-generated document keys', () => {
    expect(DOCUMENT_KEY_PATTERN.test(`documents/${randomUUID()}.pdf`)).toBe(true);
    expect(DOCUMENT_KEY_PATTERN.test(`documents/${randomUUID()}.png`)).toBe(true);
    expect(DOCUMENT_KEY_PATTERN.test(`documents/${randomUUID()}.jpg`)).toBe(true);
    expect(DOCUMENT_KEY_PATTERN.test(`branding/${randomUUID()}.png`)).toBe(false);
    expect(DOCUMENT_KEY_PATTERN.test(`documents/${randomUUID()}.svg`)).toBe(false);
    expect(DOCUMENT_KEY_PATTERN.test(`../${randomUUID()}.pdf`)).toBe(false);
  });
});

interface SessionCookies {
  token: string;
  csrf: string;
  cookie: string;
}

describeDb('Phase 3.4 student documents: HTTP security + acceptance (real app + real DB + live Redis + temp storage)', () => {
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
  const slug = `p3d${randomUUID().slice(0, 8)}`;
  const sessions: Record<'ownerA' | 'ownerB' | 'principal' | 'campus', SessionCookies> = {} as never;
  const zeroUuid = '00000000-0000-0000-0000-000000000000';

  let campusAId = '';
  let campusBId = '';
  let studentAId = '';
  let studentBId = '';
  let doc1Id = '';
  let doc3Id = '';
  let doc4Id = '';
  let file2StorageKey = '';
  let documentTypes: string[] = [];

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

  const upload = (
    s: SessionCookies,
    studentId: string,
    data: Buffer,
    contentType: string,
    over: { query?: string; filename?: string; idemKey?: string; csrf?: boolean; extraHeaders?: Record<string, string> } = {},
  ) => {
    const qs = new URLSearchParams({ documentType: over.query ?? 'birth_certificate' });
    if (over.filename) qs.set('filename', over.filename);
    return app.inject({
      method: 'POST',
      url: `/api/v1/students/${studentId}/documents?${qs.toString()}`,
      headers: {
        cookie: s.cookie,
        'content-type': contentType,
        ...withCsrf(s),
        ...idem(over.idemKey ?? `${slug}-${randomUUID()}`),
        ...over.extraHeaders,
      },
      payload: data,
    });
  };

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

    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sms-documents-'));
    storage = new FsStorageProvider(tempRoot);

    uid.owner = randomUUID();
    uid.principal = randomUUID();
    uid.campusUser = randomUUID();
    uid.platRole = randomUUID();
    uid.ownerEmail = `owner-${slug}@example.com`;
    uid.principalEmail = `principal-${slug}@example.com`;
    uid.campusEmail = `campus-${slug}@example.com`;

    await rows(
      migratorDb,
      sql`insert into roles (id, scope, code, name, is_system) values (${uid.platRole}, 'platform', ${`p3dp${slug}_plat`}, 'Phase 3.4 Platform Admin', true)`,
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
    await rows(migratorDb, sql`insert into users (id, email) values (${uid.principal}, ${uid.principalEmail})`);
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
      createTenantTransaction(tx, platformCtx(uid.owner!), { slug: `${slug}-a`, name: 'Phase 3.4 A', requestId: randomUUID() }),
    );
    uid.tenantA = createdA.tenantId;
    const createdB = await withTenant(appDb, platformCtx(uid.owner!), (tx) =>
      createTenantTransaction(tx, platformCtx(uid.owner!), { slug: `${slug}-b`, name: 'Phase 3.4 B', requestId: randomUUID() }),
    );
    uid.tenantB = createdB.tenantId;

    const roleId = async (code: string) => {
      const r = await rows(
        migratorDb,
        sql`select id from roles where tenant_id = ${uid.tenantA} and code = ${code}`,
      );
      return String(r[0]!.id);
    };
    const principalRoleId = await roleId('principal');
    const principalMembership = await rows(
      migratorDb,
      sql`insert into memberships (id, tenant_id, user_id, status) values (${randomUUID()}, ${uid.tenantA}, ${uid.principal}, 'active') returning id`,
    );
    await rows(
      migratorDb,
      sql`insert into membership_roles (membership_id, role_id) values (${String(principalMembership[0]!.id)}, ${principalRoleId})`,
    );

    const ownerRoleId = await roleId('school_owner');
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
    sessions.principal = await makeSession(uid.principal!, uid.tenantA!);
    sessions.campus = await makeSession(uid.campusUser!, uid.tenantA!);

    app = await buildApp({ deps: { db: appDb, redis, storage }, logger: false });

    const mkCampus = async (code: string, name: string) => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/campuses',
        headers: { cookie: sessions.ownerA.cookie, ...withCsrf(sessions.ownerA), ...idem(`c-${code}`) },
        payload: { code, name },
      });
      expect(res.statusCode).toBe(201);
      return (res.json().campus as { id: string }).id;
    };
    campusAId = await mkCampus(`p3da-${slug}`, 'Docs Main');
    campusBId = await mkCampus(`p3db-${slug}`, 'Docs Annex');
    await rows(
      migratorDb,
      sql`update memberships set campus_id = ${campusAId} where id = ${uid.campusMembership}`,
    );

    const mkStudent = async (over: Record<string, unknown>, key: string) => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/students',
        headers: { cookie: sessions.ownerA.cookie, ...withCsrf(sessions.ownerA), ...idem(key) },
        payload: {
          studentNo: `D-${randomUUID().slice(0, 8)}`,
          firstName: 'Doc',
          lastName: 'Student',
          dateOfBirth: '2010-01-01',
          gender: 'female',
          ...over,
        },
      });
      expect(res.statusCode).toBe(201);
      return (res.json().student as { id: string }).id;
    };
    studentAId = await mkStudent({ firstName: 'Alice', lastName: 'Adams', primaryCampusId: campusAId }, 'stu-a');
    studentBId = await mkStudent({ firstName: 'Bob', lastName: 'Baker', primaryCampusId: campusBId }, 'stu-b');
  });

  afterAll(async () => {
    try {
      if (app) await app.close();
      const tIn = `'${uid.tenantA}','${uid.tenantB}'`;
      await rows(migratorDb, sql`delete from outbox_events where tenant_id in (${sql.raw(tIn)})`);
      await rows(migratorDb, sql`delete from idempotency_keys where tenant_id in (${sql.raw(tIn)})`);
      await rows(migratorDb, sql`delete from student_documents where tenant_id in (${sql.raw(tIn)})`);
      await rows(migratorDb, sql`delete from files where tenant_id in (${sql.raw(tIn)})`);
      await rows(migratorDb, sql`delete from students where tenant_id in (${sql.raw(tIn)})`);
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
        sql`delete from memberships where tenant_id in (${sql.raw(tIn)}) or user_id = ${uid.campusUser}`,
      );
      await rows(migratorDb, sql`delete from platform_role_assignments where user_id = ${uid.owner}`);
      await rows(migratorDb, sql`delete from roles where tenant_id in (${sql.raw(tIn)}) or id = ${uid.platRole}`);
      await rows(
        migratorDb,
        sql`delete from users where id in (${uid.owner}, ${uid.principal}, ${uid.campusUser})`,
      );
      await rows(migratorDb, sql`delete from tenants where id in (${sql.raw(tIn)})`);
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => {});
      await endMigrator();
      await endApp();
      await endRedis?.();
    }
  });

  // ------------------------------------------------------------- permission map

  it('1. reports every document route in the post-boot matrix (student.documents.*, HEAD twins)', async () => {
    const byRoute = new Map(
      app.routeAuthorizationMatrix().routes.map((r) => [`${r.method} ${r.url}`, r]),
    );
    const primary: Record<string, string> = {
      'GET /api/v1/students/:id/documents': 'student.documents.read',
      'POST /api/v1/students/:id/documents': 'student.documents.create',
      'GET /api/v1/students/:id/documents/:documentId': 'student.documents.read',
      'GET /api/v1/students/:id/documents/:documentId/download': 'student.documents.read',
      'PATCH /api/v1/students/:id/documents/:documentId': 'student.documents.update',
      'DELETE /api/v1/students/:id/documents/:documentId': 'student.documents.delete',
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

  it('2. a principal (read-only) is denied the write routes with the documented permission and allowed reads', async () => {
    const writes: Array<{ method: 'POST' | 'PATCH' | 'DELETE'; url: string; perm: string }> = [
      { method: 'POST', url: `/api/v1/students/${zeroUuid}/documents?documentType=x`, perm: 'student.documents.create' },
      { method: 'PATCH', url: `/api/v1/students/${zeroUuid}/documents/${zeroUuid}`, perm: 'student.documents.update' },
      { method: 'DELETE', url: `/api/v1/students/${zeroUuid}/documents/${zeroUuid}`, perm: 'student.documents.delete' },
    ];
    for (const c of writes) {
      const res = await app.inject({
        method: c.method,
        url: c.url,
        headers: { cookie: sessions.principal.cookie },
      });
      expect(res.statusCode, `${c.method} ${c.url}`).toBe(403);
      expect(envelope(res)?.code, `${c.method} ${c.url}`).toBe('forbidden');
      expect(envelope(res)?.requiredPermission, `${c.method} ${c.url}`).toBe(c.perm);
    }
    const reads = await app.inject({
      method: 'GET',
      url: `/api/v1/students/${studentAId}/documents`,
      headers: { cookie: sessions.principal.cookie },
    });
    expect(reads.statusCode).toBe(200);
    expect((reads.json() as { total: number }).total).toBe(0);
  });

  it('3. anonymous callers are rejected on document routes (401 before permission logic)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/students/${studentAId}/documents`,
    });
    expect(res.statusCode).toBe(401);
    expect(envelope(res)?.code).toBe('unauthenticated');
  });

  it('4. CSRF double-submit is required on upload, patch and delete', async () => {
    const uploadRes = await app.inject({
      method: 'POST',
      url: `/api/v1/students/${studentAId}/documents?documentType=id_copy`,
      headers: { cookie: sessions.ownerA.cookie, 'content-type': 'application/pdf' },
      payload: pdfBytes(),
    });
    expect(uploadRes.statusCode).toBe(403);
    expect(envelope(uploadRes)?.code).toBe('csrf_invalid');

    const patchRes = await app.inject({
      method: 'PATCH',
      url: `/api/v1/students/${studentAId}/documents/${zeroUuid}`,
      headers: { cookie: sessions.ownerA.cookie },
      payload: { documentType: 'id_copy' },
    });
    expect(patchRes.statusCode).toBe(403);
    expect(envelope(patchRes)?.code).toBe('csrf_invalid');

    const deleteRes = await app.inject({
      method: 'DELETE',
      url: `/api/v1/students/${studentAId}/documents/${zeroUuid}`,
      headers: { cookie: sessions.ownerA.cookie },
    });
    expect(deleteRes.statusCode).toBe(403);
    expect(envelope(deleteRes)?.code).toBe('csrf_invalid');
  });

  // ------------------------------------------------------------------- upload

  it('5. owner uploads a PDF: 201, scanned response shape, pending scan, audit + student.document.uploaded outbox', async () => {
    const bytes = pdfBytes();
    const res = await upload(sessions.ownerA, studentAId, bytes, 'application/pdf', { filename: 'birth certificate.pdf' });
    expect(res.statusCode).toBe(201);
    const document = res.json().document as {
      id: string;
      tenantId: string;
      studentId: string;
      documentType: string;
      fileId: string;
      originalName: string;
      mime: string;
      sizeBytes: number;
      scanStatus: string;
      createdAt: string;
    };
    doc1Id = document.id;
    expect(document.tenantId).toBe(uid.tenantA);
    expect(document.studentId).toBe(studentAId);
    expect(document.documentType).toBe('birth_certificate');
    expect(document.originalName).toBe('birth certificate.pdf');
    expect(document.mime).toBe('application/pdf');
    expect(document.sizeBytes).toBe(bytes.byteLength);
    expect(document.scanStatus).toBe('pending');
    expect(document.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const file = await rows(
      migratorDb,
      sql`select storage_key, content_hash, visibility, owner_type, owner_id, created_by, scan_status
            from files where id = ${document.fileId}`,
    );
    expect(String(file[0]!.visibility)).toBe('private');
    expect(String(file[0]!.owner_type)).toBe('student');
    expect(String(file[0]!.owner_id)).toBe(studentAId);
    expect(String(file[0]!.created_by)).toBe(uid.owner);
    expect(String(file[0]!.scan_status)).toBe('pending');
    expect(String(file[0]!.content_hash)).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(DOCUMENT_KEY_PATTERN.test(String(file[0]!.storage_key))).toBe(true);

    const audit = await rows(
      migratorDb,
      sql`select count(*)::int n from audit_logs where tenant_id = ${uid.tenantA} and action = 'student.document.uploaded' and resource_id = ${doc1Id}`,
    );
    expect(Number(audit[0]!.n)).toBe(1);
    const outbox = await rows(
      migratorDb,
      sql`select payload from outbox_events where tenant_id = ${uid.tenantA} and event_type = 'student.document.uploaded' and aggregate_id = ${doc1Id}`,
    );
    expect(outbox.length).toBe(1);
    const payload = outbox[0]!.payload as { tenantId: string; documentId: string; fileId: string };
    expect(payload.tenantId).toBe(uid.tenantA);
    expect(payload.documentId).toBe(doc1Id);
    expect(payload.fileId).toBe(document.fileId);

    // The bytes actually landed on the provider under a tenant-scoped key.
    const stored = await storage.readObject(uid.tenantA!, String(file[0]!.storage_key));
    expect(stored.equals(bytes)).toBe(true);
  });

  it('6. metadata GET returns the uploaded document and the list honours type filter + pagination', async () => {
    const meta = await app.inject({
      method: 'GET',
      url: `/api/v1/students/${studentAId}/documents/${doc1Id}`,
      headers: { cookie: sessions.ownerA.cookie },
    });
    expect(meta.statusCode).toBe(200);
    const got = meta.json().document as { id: string; documentType: string; scanStatus: string; fileId: string };
    expect(got.id).toBe(doc1Id);
    expect(got.documentType).toBe('birth_certificate');
    expect(got.scanStatus).toBe('pending');

    const list = await app.inject({
      method: 'GET',
      url: `/api/v1/students/${studentAId}/documents?documentType=birth_certificate`,
      headers: { cookie: sessions.ownerA.cookie },
    });
    expect(list.statusCode).toBe(200);
    const l = list.json() as { items: Array<{ id: string }>; total: number };
    expect(l.total).toBe(1);
    expect(l.items.map((i) => i.id)).toContain(doc1Id);

    const off = await app.inject({
      method: 'GET',
      url: `/api/v1/students/${studentAId}/documents?limit=0`,
      headers: { cookie: sessions.ownerA.cookie },
    });
    expect(off.statusCode).toBe(400);
    expect(envelope(off)?.code).toBe('validation_error');
  });

  it('7. an upload with a different idempotency key but identical content is a SECOND document', async () => {
    const bytes = pngBytes();
    const res = await upload(sessions.ownerA, studentAId, bytes, 'image/png', {
      query: 'report_card',
      filename: 'report.png',
    });
    expect(res.statusCode).toBe(201);
    const doc = res.json().document as { id: string; fileId: string; mime: string; scanStatus: string };
    expect(doc.mime).toBe('image/png');
    expect(doc.scanStatus).toBe('pending');

    const file = await rows(
      migratorDb,
      sql`select storage_key from files where id = ${doc.fileId}`,
    );
    file2StorageKey = String(file[0]!.storage_key);
    const stored = await storage.readObject(uid.tenantA!, file2StorageKey);
    expect(stored.equals(bytes)).toBe(true);
  });

  it('8. idempotency: replaying the SAME key+bytes+metadata returns the stored document, not a duplicate', async () => {
    const bytes = pdfBytes(96);
    const key = `doc-idem-${slug}`;
    const first = await app.inject({
      method: 'POST',
      url: `/api/v1/students/${studentAId}/documents?documentType=id_copy&filename=id.pdf`,
      headers: { cookie: sessions.ownerA.cookie, 'content-type': 'application/pdf', ...withCsrf(sessions.ownerA), ...idem(key) },
      payload: bytes,
    });
    expect(first.statusCode).toBe(201);
    const firstId = (first.json().document as { id: string }).id;

    const replay = await app.inject({
      method: 'POST',
      url: `/api/v1/students/${studentAId}/documents?documentType=id_copy&filename=id.pdf`,
      headers: { cookie: sessions.ownerA.cookie, 'content-type': 'application/pdf', ...withCsrf(sessions.ownerA), ...idem(key) },
      payload: bytes,
    });
    expect(replay.statusCode).toBe(201);
    expect((replay.json().document as { id: string }).id).toBe(firstId);

    const count = await rows(
      migratorDb,
      sql`select count(*)::int n from student_documents where tenant_id = ${uid.tenantA} and id = ${firstId}`,
    );
    expect(Number(count[0]!.n)).toBe(1);
  });

  it('9. upload validation: 413 declared content-length, 415 sniff, 415 type mismatch, 400 body', async () => {
    const max = env.MAX_DOCUMENT_UPLOAD_BYTES;

    const tooBig = await upload(sessions.ownerA, studentAId, pngBytes(max), 'image/png', { query: 'big' });
    expect(tooBig.statusCode).toBe(413);
    expect(envelope(tooBig)?.code).toBe('payload_too_large');

    const svg = await upload(sessions.ownerA, studentAId, svgBytes(), 'application/pdf', { query: 'svg' });
    expect(svg.statusCode).toBe(415);
    expect(envelope(svg)?.code).toBe('unsupported_media_type');

    const spoofed = await upload(sessions.ownerA, studentAId, pngBytes(), 'application/pdf', { query: 'spoof' });
    expect(spoofed.statusCode).toBe(415);
    expect(envelope(spoofed)?.code).toBe('content_type_mismatch');

    // declared application/octet-stream is the wildcard: accepted without a match.
    const octet = await upload(sessions.ownerA, studentAId, pngBytes(), 'application/octet-stream', {
      query: 'octet',
      filename: 'weird.bin',
    });
    expect(octet.statusCode).toBe(201);
    expect((octet.json().document as { mime: string }).mime).toBe('image/png');
  });

  it('10. display names are sanitized (traversal/control fall back to the generated name)', async () => {
    const evil = await upload(sessions.ownerA, studentAId, pdfBytes(), 'application/pdf', {
      query: 'evil',
      filename: '../evil.pdf',
    });
    expect(evil.statusCode).toBe(201);
    expect((evil.json().document as { originalName: string }).originalName).toBe('pdf document');

    const ctrl = await upload(sessions.ownerA, studentAId, pdfBytes(), 'application/pdf', {
      query: 'ctrl',
      filename: 'a\u0000b.pdf',
    });
    expect(ctrl.statusCode).toBe(201);
    expect((ctrl.json().document as { originalName: string }).originalName).toBe('pdf document');

    const omitted = await upload(sessions.ownerA, studentAId, pdfBytes(), 'application/pdf', { query: 'none' });
    expect(omitted.statusCode).toBe(201);
    expect((omitted.json().document as { originalName: string }).originalName).toBe('pdf document');
  });

  it('11. missing/blank documentType is a 400 validation_error', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/students/${studentAId}/documents`,
      headers: { cookie: sessions.ownerA.cookie, 'content-type': 'application/pdf', ...withCsrf(sessions.ownerA), ...idem(`q-${slug}`) },
      payload: pdfBytes(),
    });
    expect(res.statusCode).toBe(400);
    expect(envelope(res)?.code).toBe('validation_error');
  });

  // ---------------------------------------------------------------- scan gate

  it('12. download is gated: pending -> 403 scan_incomplete; worker-equivalent clean -> bytes stream with safe headers', async () => {
    const pending = await app.inject({
      method: 'GET',
      url: `/api/v1/students/${studentAId}/documents/${doc1Id}/download`,
      headers: { cookie: sessions.ownerA.cookie },
    });
    expect(pending.statusCode).toBe(403);
    expect(envelope(pending)?.code).toBe('scan_incomplete');

    const bytes = pdfBytes();
    await rows(
      migratorDb,
      sql`update files set scan_status = 'clean' where storage_key in (select storage_key from files f join student_documents d on d.tenant_id = f.tenant_id and d.file_id = f.id where d.id = ${doc1Id})`,
    );
    const clean = await app.inject({
      method: 'GET',
      url: `/api/v1/students/${studentAId}/documents/${doc1Id}/download`,
      headers: { cookie: sessions.ownerA.cookie },
    });
    expect(clean.statusCode).toBe(200);
    expect(clean.headers['content-type']).toBe('application/pdf');
    expect(clean.headers['content-length']).toBe(String(bytes.byteLength));
    expect(clean.headers['content-disposition']).toContain('attachment; filename="birth certificate.pdf"');
    expect(clean.headers['cache-control']).toBe('private, no-store');
    const body = Buffer.from(clean.body, 'latin1');
    expect(body.subarray(0, 5).equals(PDF_SIGNATURE)).toBe(true);
  });

  it('13. a BLOCKED document stays gated (never streamed)', async () => {
    const res = await upload(sessions.ownerA, studentAId, pdfBytes(48), 'application/pdf', { query: 'blocked' });
    expect(res.statusCode).toBe(201);
    doc3Id = (res.json().document as { id: string }).id;
    await rows(
      migratorDb,
      sql`update files set scan_status = 'blocked' where storage_key in (select storage_key from files f join student_documents d on d.tenant_id = f.tenant_id and d.file_id = f.id where d.id = ${doc3Id})`,
    );
    const blocked = await app.inject({
      method: 'GET',
      url: `/api/v1/students/${studentAId}/documents/${doc3Id}/download`,
      headers: { cookie: sessions.ownerA.cookie },
    });
    expect(blocked.statusCode).toBe(403);
    expect(envelope(blocked)?.code).toBe('scan_incomplete');
  });

  // --------------------------------------------------------------------- PATCH

  it('14. PATCH renames documentType + originalName, audits, and mass-assignment / empty bodies are 400', async () => {
    const patch = await app.inject({
      method: 'PATCH',
      url: `/api/v1/students/${studentAId}/documents/${doc3Id}`,
      headers: { cookie: sessions.ownerA.cookie, ...withCsrf(sessions.ownerA), ...idem(`patch-${slug}`) },
      payload: { documentType: 'final_year_report', originalName: 'report v2.pdf' },
    });
    expect(patch.statusCode).toBe(200);
    const updated = patch.json().document as { documentType: string; originalName: string; scanStatus: string };
    expect(updated.documentType).toBe('final_year_report');
    expect(updated.originalName).toBe('report v2.pdf');
    expect(updated.scanStatus).toBe('blocked'); // only metadata changed

    const audit = await rows(
      migratorDb,
      sql`select count(*)::int n from audit_logs where tenant_id = ${uid.tenantA} and action = 'student.document.updated' and resource_id = ${doc3Id}`,
    );
    expect(Number(audit[0]!.n)).toBe(1);

    const mass = await app.inject({
      method: 'PATCH',
      url: `/api/v1/students/${studentAId}/documents/${doc3Id}`,
      headers: { cookie: sessions.ownerA.cookie, ...withCsrf(sessions.ownerA), ...idem(`ma-${slug}`) },
      payload: { documentType: 'x', scanStatus: 'clean' },
    });
    expect(mass.statusCode).toBe(400);
    expect(envelope(mass)?.code).toBe('validation_error');

    const empty = await app.inject({
      method: 'PATCH',
      url: `/api/v1/students/${studentAId}/documents/${doc3Id}`,
      headers: { cookie: sessions.ownerA.cookie, ...withCsrf(sessions.ownerA), ...idem(`em-${slug}`) },
      payload: {},
    });
    expect(empty.statusCode).toBe(400);
    expect(envelope(empty)?.code).toBe('validation_error');
  });

  it('15. PATCH is idempotent: replaying key+body stores one update', async () => {
    const key = `patch-idem-${slug}`;
    const body = { documentType: 'report_card_final' };
    const hdrs = { cookie: sessions.ownerA.cookie, ...withCsrf(sessions.ownerA), ...idem(key) };
    const first = await app.inject({ method: 'PATCH', url: `/api/v1/students/${studentAId}/documents/${doc3Id}`, headers: hdrs, payload: body });
    expect(first.statusCode).toBe(200);
    const id = (first.json().document as { id: string }).id;
    const second = await app.inject({ method: 'PATCH', url: `/api/v1/students/${studentAId}/documents/${doc3Id}`, headers: hdrs, payload: body });
    expect(second.statusCode).toBe(200);
    expect((second.json().document as { id: string }).id).toBe(id);
    const audit = await rows(
      migratorDb,
      sql`select count(*)::int n from audit_logs where tenant_id = ${uid.tenantA} and action = 'student.document.updated' and resource_id = ${doc3Id}`,
    );
    expect(Number(audit[0]!.n)).toBe(2);
  });

  // ------------------------------------------------------------------- delete

  it('16. DELETE soft-deletes the document and its file: 204, hidden everywhere, audit, re-delete 404', async () => {
    const del = await app.inject({
      method: 'DELETE',
      url: `/api/v1/students/${studentAId}/documents/${doc1Id}`,
      headers: { cookie: sessions.ownerA.cookie, ...withCsrf(sessions.ownerA) },
    });
    expect(del.statusCode).toBe(204);

    const meta = await app.inject({
      method: 'GET',
      url: `/api/v1/students/${studentAId}/documents/${doc1Id}`,
      headers: { cookie: sessions.ownerA.cookie },
    });
    expect(meta.statusCode).toBe(404);
    expect(envelope(meta)?.code).toBe('not_found');

    const download = await app.inject({
      method: 'GET',
      url: `/api/v1/students/${studentAId}/documents/${doc1Id}/download`,
      headers: { cookie: sessions.ownerA.cookie },
    });
    expect(download.statusCode).toBe(404);

    const list = await app.inject({
      method: 'GET',
      url: `/api/v1/students/${studentAId}/documents`,
      headers: { cookie: sessions.ownerA.cookie },
    });
    const l = list.json() as { items: Array<{ id: string }> };
    expect(l.items.map((i) => i.id)).not.toContain(doc1Id);

    const tomb = await rows(
      migratorDb,
      sql`select d.deleted_at is not null as d_tomb, f.deleted_at is not null as f_tomb
            from student_documents d join files f on f.tenant_id = d.tenant_id and f.id = d.file_id
           where d.id = ${doc1Id}`,
    );
    expect(Boolean(tomb[0]!.d_tomb)).toBe(true);
    expect(Boolean(tomb[0]!.f_tomb)).toBe(true);

    const audit = await rows(
      migratorDb,
      sql`select count(*)::int n from audit_logs where tenant_id = ${uid.tenantA} and action = 'student.document.deleted' and resource_id = ${doc1Id}`,
    );
    expect(Number(audit[0]!.n)).toBe(1);

    const again = await app.inject({
      method: 'DELETE',
      url: `/api/v1/students/${studentAId}/documents/${doc1Id}`,
      headers: { cookie: sessions.ownerA.cookie, ...withCsrf(sessions.ownerA) },
    });
    expect(again.statusCode).toBe(404);
    expect(envelope(again)?.code).toBe('not_found');
  });

  it('17. the deleted object remains on the provider (retention: files/docs are tombstoned, not purged)', async () => {
    const stored = await storage.readObject(uid.tenantA!, file2StorageKey);
    const png = Buffer.from(stored);
    expect(png.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
  });

  // ------------------------------------------------------------ cross-tenant

  it('18. cross-tenant access from tenant B to tenant A students is 404 across every document route', async () => {
    const list = await app.inject({
      method: 'GET',
      url: `/api/v1/students/${studentAId}/documents`,
      headers: { cookie: sessions.ownerB.cookie },
    });
    expect(list.statusCode).toBe(404);
    expect(envelope(list)?.code).toBe('not_found');

    const uploadRes = await app.inject({
      method: 'POST',
      url: `/api/v1/students/${studentAId}/documents?documentType=id_copy`,
      headers: { cookie: sessions.ownerB.cookie, 'content-type': 'application/pdf', ...withCsrf(sessions.ownerB), ...idem(`xt-${slug}`) },
      payload: pdfBytes(),
    });
    expect(uploadRes.statusCode).toBe(404);
    expect(envelope(uploadRes)?.code).toBe('not_found');

    const meta = await app.inject({
      method: 'GET',
      url: `/api/v1/students/${studentAId}/documents/${doc3Id}`,
      headers: { cookie: sessions.ownerB.cookie },
    });
    expect(meta.statusCode).toBe(404);
  });

  it('19. uploading to a nonexistent student is 404 not_found', async () => {
    const res = await upload(sessions.ownerA, randomUUID(), pdfBytes(), 'application/pdf', { query: 'ghost' });
    expect(res.statusCode).toBe(404);
    expect(envelope(res)?.code).toBe('not_found');
  });

  // ------------------------------------------------------------ campus scope

  it('20. a campus-scoped owner cannot upload to another campus (403) and sees its docs as 404', async () => {
    const uploadOther = await upload(sessions.campus, studentBId, pdfBytes(), 'application/pdf', { query: 'xb' });
    expect(uploadOther.statusCode).toBe(403);
    expect(envelope(uploadOther)?.code).toBe('campus_scope_denied');

    // The campus-B student does carry a document (owner uploaded it); the campus
    // member must not even see it (404, not 200-with-empty) on list/meta/download.
    const ownerUpload = await upload(sessions.ownerA, studentBId, pdfBytes(), 'application/pdf', {
      query: 'campus-b',
      filename: 'bob.pdf',
    });
    expect(ownerUpload.statusCode).toBe(201);
    doc4Id = (ownerUpload.json().document as { id: string }).id;

    const list = await app.inject({
      method: 'GET',
      url: `/api/v1/students/${studentBId}/documents`,
      headers: { cookie: sessions.campus.cookie },
    });
    expect(list.statusCode).toBe(404);
    expect(envelope(list)?.code).toBe('not_found');

    const meta = await app.inject({
      method: 'GET',
      url: `/api/v1/students/${studentBId}/documents/${doc4Id}`,
      headers: { cookie: sessions.campus.cookie },
    });
    expect(meta.statusCode).toBe(404);

    const del = await app.inject({
      method: 'DELETE',
      url: `/api/v1/students/${studentBId}/documents/${doc4Id}`,
      headers: { cookie: sessions.campus.cookie, ...withCsrf(sessions.campus) },
    });
    expect(del.statusCode).toBe(404);

    // Own campus (studentA) objects are unaffected: doc3 metadata is visible.
    const own = await app.inject({
      method: 'GET',
      url: `/api/v1/students/${studentAId}/documents/${doc3Id}`,
      headers: { cookie: sessions.campus.cookie },
    });
    expect(own.statusCode).toBe(200);
  });

  // ---------------------------------------------------------------- wrap-up

  it('21. ACCEPTANCE: the Phase 3.4 document graph is consistent at the database layer', async () => {
    const docs = await rows(
      migratorDb,
      sql`select d.id, d.document_type, f.scan_status, f.storage_key, f.owner_id, f.size_bytes
            from student_documents d
            join files f on f.tenant_id = d.tenant_id and f.id = d.file_id
           where d.tenant_id = ${uid.tenantA} and d.deleted_at is null`,
    );
    documentTypes = docs.map((r) => String(r.document_type));
    expect(docs.length).toBeGreaterThanOrEqual(4); // doc2(png)+doc3+octet+evil+ctrl+none+idem+big ones... see count below

    for (const d of docs) {
      expect(DOCUMENT_KEY_PATTERN.test(String(d.storage_key))).toBe(true);
      expect(String(d.scan_status)).toMatch(/^(pending|clean|blocked)$/);
      expect(String(d.size_bytes)).toMatch(/^\d+$/);
    }

    // Orphans impossible by construction: files is the child of documents here.
    const orphans = await rows(
      migratorDb,
      sql`select count(*)::int n from files f
            where f.tenant_id = ${uid.tenantA}
              and f.deleted_at is null
              and not exists (select 1 from student_documents d where d.tenant_id = f.tenant_id and d.file_id = f.id)`,
    );
    expect(Number(orphans[0]!.n)).toBe(0);

    const uploadedAudit = await rows(
      migratorDb,
      sql`select count(*)::int n from audit_logs where tenant_id = ${uid.tenantA} and action = 'student.document.uploaded'`,
    );
    const uploadedOutbox = await rows(
      migratorDb,
      sql`select count(*)::int n from outbox_events where tenant_id = ${uid.tenantA} and event_type = 'student.document.uploaded'`,
    );
    expect(Number(uploadedAudit[0]!.n)).toBe(Number(uploadedOutbox[0]!.n));
    expect(Number(uploadedAudit[0]!.n)).toBeGreaterThanOrEqual(7);
  });
});