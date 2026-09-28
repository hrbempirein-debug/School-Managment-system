import { createHash } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { files, studentDocuments, type Tx } from '@sms/db';
import { writeAudit } from '@sms/audit';
import { detectDocumentType, DOCUMENT_MIME } from '@sms/core';
import type { OutboxEvent } from '@sms/contracts';
import type { StorageProvider } from '@sms/storage';

type Logger = (level: 'info' | 'warn' | 'error', msg: string, data?: unknown) => void;

export interface DocumentScanHandlerDeps {
  tx: Tx;
  event: OutboxEvent;
}

export type DocumentScanHandler = (deps: DocumentScanHandlerDeps) => Promise<void>;

type ScanStatus = 'clean' | 'blocked';

interface ScanDecision {
  status: ScanStatus;
  policy: string;
  reason?: string;
}

/**
 * Scan hook for student documents — the worker side of `student.document.uploaded`
 * (POST /students/:id/documents enqueues one per accepted upload).
 *
 * Runs inside runEventHandler's system transaction (data-based tenant scoping; no
 * forged ticket). Semantics:
 *   * document or file missing / soft-deleted          -> no-op ack (converged);
 *   * scan_status already 'clean'/'blocked'            -> no-op ack (idempotent
 *     at-least-once redelivery);
 *   * the guarded `UPDATE ... WHERE scan_status='pending'` makes concurrent /
 *     redriven executions single-winner: the loser sees zero rows and acks.
 *
 * The dev scan policy (documented stub — NOT antivirus) re-reads the stored
 * object and re-verifies integrity: sha256 must equal files.content_hash and the
 * magic bytes must still match the recorded MIME. A mismatch is a hard 'blocked'
 * outcome; an object that cannot be read throws (BullMQ retries, never marked
 * clean). When no storage provider is configured the hook fails closed (throws)
 * so no document is ever silently waved through.
 *
 * Only the worker transitions scan_status; the API never writes it.
 */
export function makeScanHandler(log: Logger, storage?: StorageProvider): DocumentScanHandler {
  return async ({ tx, event }) => {
    const tenantId = typeof event.payload['tenantId'] === 'string' ? event.payload['tenantId'] : null;
    const documentId = typeof event.payload['documentId'] === 'string' ? event.payload['documentId'] : null;
    if (!tenantId || !documentId) {
      throw new Error("student.document.uploaded requires string 'tenantId' and 'documentId' in payload");
    }

    const doc = await tx
      .select()
      .from(studentDocuments)
      .where(
        and(
          eq(studentDocuments.tenantId, tenantId),
          eq(studentDocuments.id, documentId),
          isNull(studentDocuments.deletedAt),
        ),
      )
      .limit(1)
      .execute()
      .then((r) => r[0]);

    if (!doc) {
      log('info', 'student.document.uploaded: no-op (document missing or deleted)', { documentId });
      return;
    }

    const file = await tx
      .select()
      .from(files)
      .where(and(eq(files.tenantId, tenantId), eq(files.id, doc.fileId), isNull(files.deletedAt)))
      .limit(1)
      .execute()
      .then((r) => r[0]);

    if (!file) {
      log('info', 'student.document.uploaded: no-op (file missing or deleted)', { documentId, fileId: doc.fileId });
      return;
    }

    if (file.scanStatus === 'clean' || file.scanStatus === 'blocked') {
      log('info', 'student.document.uploaded: no-op (scan already terminal)', {
        documentId,
        fileId: file.id,
        scanStatus: file.scanStatus,
      });
      return;
    }

    const decision = await runScanHook(storage, {
      tenantId,
      fileId: file.id,
      storageKey: file.storageKey,
      mime: file.mime,
      contentHash: file.contentHash,
    });

    // Guarded transition keeps this idempotent under concurrency/redelivery.
    const updated = await tx
      .update(files)
      .set({ scanStatus: decision.status })
      .where(and(eq(files.tenantId, tenantId), eq(files.id, file.id), eq(files.scanStatus, 'pending')))
      .returning({ id: files.id });

    if (updated.length === 0) {
      log('info', 'student.document.uploaded: no-op (concurrent scan already progressed)', {
        documentId,
        fileId: file.id,
        scanStatus: decision.status,
      });
      return;
    }

    await writeAudit(tx, {
      scope: 'tenant',
      tenantId,
      actorUserId: null,
      actorType: 'job',
      action: 'student.document.scanned',
      resourceType: 'student_document',
      resourceId: documentId,
      newValue: {
        fileId: file.id,
        scanStatus: decision.status,
        policy: decision.policy,
        reason: decision.reason ?? null,
      },
      requestId: event.correlationId ?? event.id,
    });

    log('info', 'student.document.uploaded: scan completed', {
      documentId,
      fileId: file.id,
      scanStatus: decision.status,
      policy: decision.policy,
    });
  };
}

async function runScanHook(
  storage: StorageProvider | undefined,
  input: { tenantId: string; fileId: string; storageKey: string; mime: string; contentHash: string | null },
): Promise<ScanDecision> {
  if (!storage) {
    throw new Error('document scan hook unavailable: no storage provider configured (failing closed)');
  }
  let data: Buffer;
  try {
    data = await storage.readObject(input.tenantId, input.storageKey);
  } catch (err) {
    throw new Error(
      `document scan hook: failed to read stored object (${err instanceof Error ? err.message : String(err)})`,
    );
  }
  const actualHash = createHash('sha256').update(data).digest('hex');
  if (input.contentHash && actualHash !== input.contentHash) {
    return { status: 'blocked', policy: 'dev-scan:content-hash', reason: 'content hash mismatch' };
  }
  const detected = detectDocumentType(data);
  if (!detected) {
    return { status: 'blocked', policy: 'dev-scan:magic-sniff', reason: 'content not a supported format' };
  }
  if (DOCUMENT_MIME[detected] !== input.mime) {
    return { status: 'blocked', policy: 'dev-scan:magic-sniff', reason: 'mime mismatch' };
  }
  return { status: 'clean', policy: 'dev-scan:hash+magic' };
}