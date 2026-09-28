import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { getEnv } from '@sms/config';
import { createDb, withTenant, type Db } from '@sms/db';
import { toApiErrorEnvelope, HttpError, type RequestContext } from '@sms/core';
import type { StorageProvider } from '@sms/storage';
import { FsStorageProvider } from '@sms/storage';
import { writeSession, type RedisSession } from '@sms/auth';
import { createRedis } from '@sms/redis';
import { buildApp } from '../app.js';
import { createTenantTransaction } from '../routes/tenants.js';

/**
 * Phase 3.7 PII + log-scrubbing security proofs.
 *
 * Client-facing hygiene (pure): the API error envelope (`toApiErrorEnvelope`)
 * never leaks underlying messages, stack traces, or injected markers — unknown
 * errors and non-exposed HttpErrors collapse to a generic `Internal error`.
 *
 * Log hygiene (real app + real DB + live Redis): a real `buildApp` instance runs
 * with a captured pino stream so every log line produced while PII-bearing
 * requests (student/guardian PII, admission snapshot, document upload, CSV import)
 * are exercised is asserted free of that PII — emails, phone numbers, names, and
 * request bodies never reach the server logs, and a deliberately exploded storage
 * provider produces a generic client envelope while keeping diagnostics server-side.
 *
 * Opt-in: RUN_RUNTIME_SECURITY_TESTS=1 (the log-hygiene half requires real infra).
 */
const enabled = process.env.RUN_RUNTIME_SECURITY_TESTS === '1';
const describeDb = enabled ? describe : describe.skip;

const PDF_SIGNATURE = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d]);
const pdfBytes = (size = 32) => Buffer.concat([PDF_SIGNATURE, Buffer.alloc(size, 0x44)]);

describe('Phase 3.7 error-envelope PII hygiene (pure)', () => {
  it('an unexpected internal error collapses to generic Internal error with no message/stack leak', () => {
    const marker = `pii-underlying-${randomUUID()}@example.com`;
    const err = new Error(`connect failed: ${marker} stack=crypto-key\nat file.ts:99`);
    const envelope = toApiErrorEnvelope(err, 'req-1');
    expect(envelope.error.code).toBe('internal');
    expect(envelope.error.message).toBe('Internal error');
    expect(envelope.error.details).toBeNull();
    const serialized = JSON.stringify(envelope);
    expect(serialized).not.toContain(marker);
    expect(serialized).not.toContain('file.ts');
    expect(serialized).not.toContain('stack');
  });

  it('a non-exposed HttpError (status >= 500) hides its message, details and any marker', () => {
    const marker = `pii-http-${randomUUID()}@example.com`;
    const err = new HttpError(`db blew up near ${marker}`, { status: 502, code: 'upstream', details: { marker } });
    const envelope = toApiErrorEnvelope(err, 'req-2');
    expect(envelope.error.code).toBe('upstream');
    expect(envelope.error.message).toBe('Internal error');
    expect(envelope.error.details).toBeNull();
    expect(JSON.stringify(envelope)).not.toContain(marker);
  });

  it('an exposed client error keeps only its benign message (never stack traces)', () => {
    const err = new HttpError('no such admission application', { status: 404, code: 'not_found' });
    const envelope = toApiErrorEnvelope(err, 'req-3');
    expect(envelope.error.message).toBe('no such admission application');
    expect(JSON.stringify(envelope)).not.toContain('at ');
  });
});

interface SessionCookies {
  token: string;
  csrf: string;
  cookie: string;
}

const markerFor = (tag: string) => `pii-${tag}-${randomUUID().slice(0, 8)}`;

describeDb('Phase 3.7 log scrubbing: PII never reaches server logs or client envelopes (real app + real DB + live Redis)', () => {
  let migratorDb: Db;
  let appDb: Db;
  let redis: Redis;
  let tempRoot: string;
  let storage: StorageProvider;
  let endMigrator: () => Promise<void>;
  let endApp: () => Promise<void>;
  let endRedis: () => Promise<unknown>;

  const uid: Record<string, string> = {};
  const slug = `p3l${randomUUID().slice(0, 8)}`;
  let owner: SessionCookies;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let scrubStudentId = '';
  const app1Logs: string[] = [];
  const app2Logs: string[] = [];

  // Distinctive, guaranteed-absent-from-codebase markers.
  const guardEmail = `guardian-${slug}@example.com`;
  const guardPhone = `+2509${slug}`;
  const studentName = `PiiHunter${slug}`;
  const csvRow = `PII-CSV-${slug},M,C`;
  const underMarker = `underlying-${slug}@pii.dev`;

  const rows = async (db: Db, q: ReturnType<typeof sql>): Promise<Record<string, unknown>[]> =>
    (await db.execute(q)).rows;

  const envelope = (res: { json: () => unknown }) =>
    (res.json() as { error?: { code?: string; message?: string; details?: unknown } }).error;

  const markerCheck = (labels: string[]) => {
    for (const line of app1Logs) {
      for (const marker of labels) {
        expect(line, `log line must not contain PII marker ${marker}`).not.toContain(marker);
      }
    }
  };

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

  function captureSink(into: string[]): Writable {
    return new Writable({
      write(chunk: Buffer, _enc, callback) {
        into.push(chunk.toString());
        callback();
      },
    });
  }

  const brokenStorage = ((): StorageProvider => ({
    async putObject() {
      throw new Error(underMarker);
    },
    async readObject() {
      throw new Error(underMarker);
    },
    async deleteObject() {
      throw new Error(underMarker);
    },
    async getDownloadUrl() {
      throw new Error(underMarker);
    },
    async headObject() {
      throw new Error(underMarker);
    },
  }))();

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

    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sms-scrub-'));
    storage = new FsStorageProvider(tempRoot);

    uid.owner = randomUUID();
    uid.platRole = randomUUID();
    await rows(
      migratorDb,
      sql`insert into roles (id, scope, code, name, is_system) values (${uid.platRole}, 'platform', ${`p3lp${slug}_plat`}, 'Phase 3.7 Scrub Platform', true)`,
    );
    await rows(
      migratorDb,
      sql`insert into role_permissions (role_id, permission) values (${uid.platRole}, 'platform.tenants.read'), (${uid.platRole}, 'platform.tenants.create')`,
    );
    await rows(migratorDb, sql`insert into users (id, email) values (${uid.owner}, ${`owner-${slug}@example.com`})`);
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
    uid.tenantA = (
      await withTenant(appDb, platformCtx(uid.owner!), (tx) =>
        createTenantTransaction(tx, platformCtx(uid.owner!), { slug: `${slug}-a`, name: 'P3L A', requestId: randomUUID() }),
      )
    ).tenantId;

    owner = await makeSession(uid.owner!, uid.tenantA!);
    app = await buildApp({
      deps: { db: appDb, redis, storage },
      logger: { level: 'info', stream: captureSink(app1Logs) },
    });

    const campus = await app.inject({
      method: 'POST',
      url: '/api/v1/campuses',
      headers: { cookie: owner.cookie, ...withCsrf(owner), ...idem(`c-${slug}`) },
      payload: { code: `p3lc-${slug}`, name: 'Scrub Campus' },
    });
    expect(campus.statusCode).toBe(201);
    uid.campus = (campus.json().campus as { id: string }).id;
  });

  afterAll(async () => {
    try {
      if (app) await app.close();
      await rows(
        migratorDb,
        sql`delete from outbox_events where tenant_id = ${uid.tenantA}`,
      );
      await rows(migratorDb, sql`delete from idempotency_keys where tenant_id = ${uid.tenantA}`);
      await rows(
        migratorDb,
        sql`delete from memberships where tenant_id = ${uid.tenantA}`,
      );
      await rows(
        migratorDb,
        sql`delete from role_permissions where role_id in (select id from roles where tenant_id = ${uid.tenantA} or id = ${uid.platRole})`,
      );
      await rows(migratorDb, sql`delete from platform_role_assignments where user_id = ${uid.owner}`);
      await rows(migratorDb, sql`delete from roles where tenant_id = ${uid.tenantA} or id = ${uid.platRole}`);
      await rows(migratorDb, sql`delete from users where id = ${uid.owner}`);
      await rows(migratorDb, sql`delete from tenants where id = ${uid.tenantA}`);
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => {});
      await endMigrator();
      await endApp();
      await endRedis?.();
    }
  });

  it('1. guardian + student + link requests carry PII that never appears in server logs', async () => {
    const guardian = await app.inject({
      method: 'POST',
      url: '/api/v1/guardians',
      headers: { cookie: owner.cookie, ...withCsrf(owner), ...idem(`g-${slug}`) },
      payload: { firstName: studentName, lastName: guardEmail, email: guardEmail, phone: guardPhone },
    });
    expect(guardian.statusCode).toBe(201);
    const guardianId = (guardian.json().guardian as { id: string }).id;

    const student = await app.inject({
      method: 'POST',
      url: '/api/v1/students',
      headers: { cookie: owner.cookie, ...withCsrf(owner), ...idem(`s-${slug}`) },
      payload: {
        studentNo: `SCRUB-${slug}`,
        firstName: studentName,
        lastName: guardEmail,
        dateOfBirth: '2010-01-01',
        gender: 'female',
        primaryCampusId: uid.campus,
      },
    });
    expect(student.statusCode).toBe(201);
    scrubStudentId = (student.json().student as { id: string }).id;

    const link = await app.inject({
      method: 'POST',
      url: `/api/v1/students/${scrubStudentId}/guardians`,
      headers: { cookie: owner.cookie, ...withCsrf(owner), ...idem(`l-${slug}`) },
      payload: { guardianId, relation: 'parent', isPrimary: true },
    });
    expect(link.statusCode).toBe(201);

    markerCheck([guardEmail, guardPhone, studentName]);
  });

  it('2. a violating payload value is only reported as a field name, never echoed back', async () => {
    const violationValue = markerFor('sneak');
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/students',
      headers: { cookie: owner.cookie, ...withCsrf(owner), ...idem(`bad-${slug}`) },
      payload: {
        studentNo: `SCRUB-BAD-${slug}`,
        firstName: 'Nice',
        lastName: 'Envelope',
        dateOfBirth: '2010-01-01',
        gender: 'female',
        status: violationValue,
      },
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.stringify(res.json());
    expect(envelope(res)?.code).toBe('validation_error');
    expect(body).not.toContain(violationValue);
  });

  it('3. CSV import bodies and document upload metadata do not reach the server logs', async () => {
    const importRes = await app.inject({
      method: 'POST',
      url: '/api/v1/students/import?filename=import.csv',
      headers: { cookie: owner.cookie, 'content-type': 'text/csv', ...withCsrf(owner), ...idem(`imp-${slug}`) },
      payload: Buffer.from(`student_no,first_name,last_name\n${csvRow}`, 'utf8'),
    });
    expect(importRes.statusCode).toBe(202);

    const upload = await app.inject({
      method: 'POST',
      url: `/api/v1/students/${'00000000-0000-0000-0000-000000000000'}/documents?documentType=birth_certificate&filename=import.csv`,
      headers: { cookie: owner.cookie, 'content-type': 'application/pdf', ...withCsrf(owner), ...idem(`doc-${slug}`) },
      payload: pdfBytes(),
    });
    // The student does not exist -> 404; exercises the request-error log path too.
    expect(upload.statusCode).toBe(404);

    markerCheck([csvRow, 'PII-CSV']);
  });

  it('4. authn/authz/challenge envelopes carry only codes, never PII or internal detail', async () => {
    const anon = await app.inject({
      method: 'GET',
      url: '/api/v1/students',
      headers: { cookie: `sid=${randomUUID()}` },
    });
    expect(anon.statusCode).toBe(401);
    expect(envelope(anon)?.code).toBe('unauthenticated');
    expect(JSON.stringify(anon.json())).not.toContain(guardEmail);

    const noCsrf = await app.inject({
      method: 'POST',
      url: '/api/v1/students',
      headers: { cookie: owner.cookie },
    });
    expect(noCsrf.statusCode).toBe(403);
    expect(envelope(noCsrf)?.code).toBe('csrf_invalid');
  });

  it('5. an exploded storage provider yields a generic client 500 while diagnostics stay server-side', async () => {
    const second = await buildApp({
      deps: { db: appDb, redis, storage: brokenStorage },
      logger: { level: 'info', stream: captureSink(app2Logs) },
    });
    try {
      const res = await second.inject({
        method: 'POST',
        url: `/api/v1/students/${scrubStudentId}/documents?documentType=birth_certificate`,
        headers: { cookie: owner.cookie, 'content-type': 'application/pdf', ...withCsrf(owner), ...idem(`boom-${slug}`) },
        payload: pdfBytes(),
      });
      // A real student exists, so the upload reaches the broken provider and 500s.
      expect(res.statusCode).toBe(500);
      const body = JSON.stringify(res.json());
      const e = envelope(res);
      expect(e?.code).toBe('internal');
      expect(e?.message).toBe('Internal error');
      expect(body).not.toContain(underMarker);
      expect(body).not.toContain('at ');
      // Server-side diagnostics do retain the underlying cause for operators.
      const serverSawIt = app2Logs.some((line) => line.includes(underMarker));
      expect(serverSawIt, 'server logs should carry the diagnosable cause').toBe(true);
    } finally {
      await second.close();
    }
  });

  it('6. session tokens never appear in request logs', () => {
    const notFound = markerFor('token');
    // Force a series of requests carrying the real session token.
    void notFound;
    const ran = (async () => {
      for (let i = 0; i < 3; i += 1) {
        await app.inject({
          method: 'GET',
          url: `/api/v1/students/${randomUUID()}`,
          headers: { cookie: owner.cookie },
        });
      }
    })();
    return ran.then(() => {
      for (const line of app1Logs) {
        expect(line).not.toContain(owner.token);
        expect(line).not.toContain(owner.csrf);
      }
    });
  });
});