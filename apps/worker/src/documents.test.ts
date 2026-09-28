import { beforeAll, describe, it, expect, afterAll } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sql, eq, and } from 'drizzle-orm';
import { getEnv } from '@sms/config';
import {
  files,
  studentDocuments,
  auditLogs,
  students,
  createDb,
  withSystem,
  type Db,
} from '@sms/db';
import type { OutboxEvent } from '@sms/contracts';
import type { StorageProvider } from '@sms/storage';
import { FsStorageProvider } from '@sms/storage';
import { makeScanHandler, type DocumentScanHandler } from './documents.js';

/**
 * Phase 3.4 document scan-hook proofs. Runs the worker's scan handler against the
 * REAL disposable test Postgres (school_saas_test) and a throwaway temp-directory
 * FsStorageProvider, exercising every branch of the scan policy:
 *   pending->clean on hash+magic match; blocked on content-hash mismatch and on
 *   magic-sniff/mime mismatch; no-ops for missing/soft-deleted documents, missing/
 *   soft-deleted files, and terminal scan states; single-winner guarded update;
 *   fail-closed when no storage is configured or the object is unreadable; audit
 *   written only by the transition winner under actorType 'job'.
 *
 * Opt-in: RUN_RUNTIME_SECURITY_TESTS=1 (requires migrations 0001..0006).
 */
const enabled = process.env.RUN_RUNTIME_SECURITY_TESTS === '1';
const describeDb = enabled ? describe : describe.skip;

const PDF_SIGNATURE = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d]);
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const pdfBytes = (size = 96) => Buffer.concat([PDF_SIGNATURE, Buffer.alloc(size, 0x44)]);
const pngBytes = (size = 96) => Buffer.concat([PNG_SIGNATURE, Buffer.alloc(size, 0xa5)]);

interface DocFixture {
  studentId: string;
  documentId: string;
  fileId: string;
  storageKey: string;
}

describeDb('student document scan hook (real PG + temp storage)', () => {
  let db: Db;
  let pool: ReturnType<typeof createDb>['pool'];
  let tenantA: string;
  let slug: string;
  let studentA: string;
  let tempRoot: string;
  let storage: StorageProvider;

  const silentLog = (): void => {};

  beforeAll(async () => {
    const env = getEnv();
    const created = createDb({ url: env.DATABASE_URL_MIGRATOR });
    db = created.db;
    pool = created.pool;
    tenantA = randomUUID();
    studentA = randomUUID();
    slug = `sc${randomUUID().slice(0, 8)}`;
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sms-docscan-'));
    storage = new FsStorageProvider(tempRoot);
    await withSystem(db, async (tx) => {
      await tx.execute(sql`insert into tenants (id, slug, name) values (${tenantA}, ${`t-${slug}`}, 'Doc Scan Tenant')`);
      await tx.execute(
        sql`insert into students (id, tenant_id, student_no, first_name, last_name, status) values
              (${studentA}, ${tenantA}, ${`sc-${slug}`}, 'Scan', 'Subject', 'active')`,
      );
    });
  });

  afterAll(async () => {
    try {
      await withSystem(db, async (tx) => {
        await tx.execute(sql`delete from audit_logs where tenant_id = ${tenantA}`);
        await tx.execute(sql`delete from student_documents where tenant_id = ${tenantA}`);
        await tx.execute(sql`delete from files where tenant_id = ${tenantA}`);
        await tx.execute(sql`delete from students where tenant_id = ${tenantA}`);
        await tx.execute(sql`delete from tenants where id = ${tenantA}`);
      });
    } catch {
      // best-effort cleanup
    }
    await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => {});
    await pool.end();
  });

  const createFixture = async (input: {
    bytes: Buffer;
    mime?: string;
    contentHash?: string | null;
    scanStatus?: 'pending' | 'clean' | 'blocked';
    storeObject?: boolean;
    fileDeletedAt?: boolean;
    docDeletedAt?: boolean;
  }): Promise<DocFixture> => {
    const documentId = randomUUID();
    const fileId = randomUUID();
    const storageKey = `documents/${randomUUID()}.${input.mime === 'image/png' ? 'png' : 'pdf'}`;
    const mime = input.mime ?? 'application/pdf';
    const hash = input.contentHash !== undefined ? input.contentHash : createHash('sha256').update(input.bytes).digest('hex');
    const scanStatus = input.scanStatus ?? 'pending';
    if (input.storeObject !== false) {
      await storage.putObject({ tenantId: tenantA, key: storageKey, data: input.bytes, contentType: mime });
    }
    await withSystem(db, async (tx) => {
      await tx
        .insert(files)
        .values({
          id: fileId,
          tenantId: tenantA,
          storageKey,
          originalName: 'scan.pdf',
          mime,
          sizeBytes: BigInt(input.bytes.byteLength),
          contentHash: hash,
          scanStatus,
          deletedAt: input.fileDeletedAt ? new Date() : null,
        });
      await tx
        .insert(studentDocuments)
        .values({
          id: documentId,
          tenantId: tenantA,
          studentId: studentA,
          documentType: 'scan_document',
          fileId,
          deletedAt: input.docDeletedAt ? new Date() : null,
        });
    });
    return { studentId: studentA, documentId, fileId, storageKey };
  };

  const event = (over: Partial<OutboxEvent['payload']>): OutboxEvent =>
    ({
      id: randomUUID(),
      eventType: 'student.document.uploaded',
      aggregateType: 'student_document',
      aggregateId: randomUUID(),
      tenantId: tenantA,
      scope: 'tenant',
      version: 1,
      payload: { tenantId: tenantA, documentId: randomUUID(), fileId: randomUUID(), ...over },
      correlationId: randomUUID(),
      causationId: null,
      createdAt: new Date().toISOString(),
    }) as OutboxEvent;

  const fileStatus = async (storageKey: string): Promise<string> => {
    const r = await withSystem(db, async (tx) =>
      tx.select({ scanStatus: files.scanStatus }).from(files).where(eq(files.storageKey, storageKey)).limit(1).execute(),
    );
    return String(r[0]!.scanStatus);
  };

  const scanAudits = async (documentId: string): Promise<number> => {
    const r = await withSystem(db, async (tx) =>
      tx
        .select({ n: sql<number>`count(*)::int` })
        .from(auditLogs)
        .where(and(eq(auditLogs.tenantId, tenantA), eq(auditLogs.action, 'student.document.scanned'), eq(auditLogs.resourceId, documentId)))
        .execute(),
    );
    return Number(r[0]!.n);
  };

  const run = async (handler: DocumentScanHandler, payload: Record<string, unknown>): Promise<void> => {
    await withSystem(db, async (tx) => {
      await handler({ tx, event: event(payload as never) });
    });
  };

  it('1. pending -> clean on hash+magic match; exactly one audit under actorType job', async () => {
    const bytes = pdfBytes();
    const fx = await createFixture({ bytes });
    const handler = makeScanHandler(silentLog, storage);
    await run(handler, { tenantId: tenantA, documentId: fx.documentId });
    expect(await fileStatus(fx.storageKey)).toBe('clean');
    expect(await scanAudits(fx.documentId)).toBe(1);
    const audits = await withSystem(db, async (tx) =>
      tx
        .select({ actorType: auditLogs.actorType, action: auditLogs.action, newValue: auditLogs.newValue })
        .from(auditLogs)
        .where(eq(auditLogs.resourceId, fx.documentId))
        .execute(),
    );
    expect(String(audits[0]!.actorType)).toBe('job');
  });

  it('2. content-hash mismatch -> blocked (dev-scan:content-hash)', async () => {
    const fx = await createFixture({
      bytes: pdfBytes(),
      contentHash: createHash('sha256').update(Buffer.from('different')).digest('hex'),
    });
    await run(makeScanHandler(silentLog, storage), { tenantId: tenantA, documentId: fx.documentId });
    expect(await fileStatus(fx.storageKey)).toBe('blocked');
    const audits = await withSystem(db, async (tx) =>
      tx
        .select({ newValue: auditLogs.newValue })
        .from(auditLogs)
        .where(eq(auditLogs.resourceId, fx.documentId))
        .execute(),
    );
    const nv = audits[0]!.newValue as { policy: string; reason: string | null };
    expect(nv.policy).toContain('content-hash');
  });

  it('3. magic-sniff/mime mismatch -> blocked (dev-scan:magic-sniff)', async () => {
    // Bytes are PNG but the row claims application/pdf: sniff disagrees.
    const fx = await createFixture({ bytes: pngBytes(), mime: 'application/pdf' });
    await run(makeScanHandler(silentLog, storage), { tenantId: tenantA, documentId: fx.documentId });
    expect(await fileStatus(fx.storageKey)).toBe('blocked');
    const audits = await withSystem(db, async (tx) =>
      tx
        .select({ newValue: auditLogs.newValue })
        .from(auditLogs)
        .where(eq(auditLogs.resourceId, fx.documentId))
        .execute(),
    );
    const nv = audits[0]!.newValue as { policy: string; reason: string | null };
    expect(nv.policy).toContain('magic-sniff');
    expect(nv.reason).toContain('mime mismatch');
  });

  it('4. unreadable content (no magic bytes) -> blocked', async () => {
    const fx = await createFixture({ bytes: Buffer.from('jlkasdjlkas plain text'), mime: 'application/pdf' });
    await run(makeScanHandler(silentLog, storage), { tenantId: tenantA, documentId: fx.documentId });
    expect(await fileStatus(fx.storageKey)).toBe('blocked');
  });

  it('5. soft-deleted document is a no-op (stays pending, no audit)', async () => {
    const fx = await createFixture({ bytes: pdfBytes(), docDeletedAt: true });
    await run(makeScanHandler(silentLog, storage), { tenantId: tenantA, documentId: fx.documentId });
    expect(await fileStatus(fx.storageKey)).toBe('pending');
    expect(await scanAudits(fx.documentId)).toBe(0);
  });

  it('6. missing/soft-deleted file is a no-op', async () => {
    const fx = await createFixture({ bytes: pdfBytes(), fileDeletedAt: true });
    await run(makeScanHandler(silentLog, storage), { tenantId: tenantA, documentId: fx.documentId });
    expect(await fileStatus(fx.storageKey)).toBe('pending');
    expect(await scanAudits(fx.documentId)).toBe(0);
  });

  it('7. terminal scan states are no-ops (idempotent redelivery)', async () => {
    const cleaned = await createFixture({ bytes: pdfBytes(), scanStatus: 'clean' });
    await run(makeScanHandler(silentLog, storage), { tenantId: tenantA, documentId: cleaned.documentId });
    expect(await fileStatus(cleaned.storageKey)).toBe('clean');
    expect(await scanAudits(cleaned.documentId)).toBe(0);

    const blocked = await createFixture({ bytes: pdfBytes(), scanStatus: 'blocked' });
    await run(makeScanHandler(silentLog, storage), { tenantId: tenantA, documentId: blocked.documentId });
    expect(await fileStatus(blocked.storageKey)).toBe('blocked');
    expect(await scanAudits(blocked.documentId)).toBe(0);
  });

  it('8. single-winner guarded update: a concurrently progressed row is left untouched and un-audited', async () => {
    const fx = await createFixture({ bytes: pdfBytes() });
    // Simulate the winner having already advanced the row before this run lands.
    await withSystem(db, async (tx) => {
      await tx
        .update(files)
        .set({ scanStatus: 'blocked' })
        .where(and(eq(files.tenantId, tenantA), eq(files.storageKey, fx.storageKey), eq(files.scanStatus, 'pending')));
    });
    await run(makeScanHandler(silentLog, storage), { tenantId: tenantA, documentId: fx.documentId });
    expect(await fileStatus(fx.storageKey)).toBe('blocked');
    expect(await scanAudits(fx.documentId)).toBe(0);
  });

  it('9. no storage provider -> fails CLOSED (throws, stays pending, no audit)', async () => {
    const fx = await createFixture({ bytes: pdfBytes() });
    const handler = makeScanHandler(silentLog, undefined);
    const failed = await withSystem(db, async (tx) =>
      handler({ tx, event: event({ tenantId: tenantA, documentId: fx.documentId }) }).catch((e: Error) => e.message),
    );
    expect(failed).toMatch(/failing closed/i);
    expect(await fileStatus(fx.storageKey)).toBe('pending');
    expect(await scanAudits(fx.documentId)).toBe(0);
  });

  it('10. unreadable object -> throws (fails closed, stays pending)', async () => {
    const fx = await createFixture({ bytes: pdfBytes(), storeObject: false });
    const failed = await withSystem(db, async (tx) =>
      makeScanHandler(silentLog, storage)({ tx, event: event({ tenantId: tenantA, documentId: fx.documentId }) }).catch(
        (e: Error) => e.message,
      ),
    );
    expect(failed).toMatch(/failed to read stored object/i);
    expect(await fileStatus(fx.storageKey)).toBe('pending');
    expect(await scanAudits(fx.documentId)).toBe(0);
  });

  it('11. a malformed payload (missing documentId) is rejected, not acked', async () => {
    await expect(
      withSystem(db, async (tx) =>
        makeScanHandler(silentLog, storage)({ tx, event: event({ tenantId: tenantA, documentId: null }) }),
      ),
    ).rejects.toThrow(/requires string 'tenantId' and 'documentId'/);
  });

  it('12. a second run after a successful clean transitions nothing (idempotency end-to-end)', async () => {
    const fx = await createFixture({ bytes: pdfBytes() });
    const handler = makeScanHandler(silentLog, storage);
    await run(handler, { tenantId: tenantA, documentId: fx.documentId });
    await run(handler, { tenantId: tenantA, documentId: fx.documentId });
    expect(await fileStatus(fx.storageKey)).toBe('clean');
    expect(await scanAudits(fx.documentId)).toBe(1);
  });

  it('13. buildHandlers wires student.document.uploaded to the scan hook (storage-aware)', async () => {
    const { buildHandlers } = await import('./worker.js');
    const registry = buildHandlers(silentLog, { storage });
    expect(typeof registry['student.document.uploaded']).toBe('function');
    const logOnlyFn = registry['campus.created'] as (deps: { event: OutboxEvent }) => Promise<void>;
    const scanFn = registry['student.document.uploaded'] as (deps: { event: OutboxEvent }) => Promise<void>;
    expect(scanFn.toString()).toContain('scanStatus');
    expect(logOnlyFn.toString()).not.toContain('scanStatus');
  });
});