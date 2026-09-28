import { createHash, randomBytes } from 'node:crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { idempotencyKeys, type Tx } from '@sms/db';

export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Deterministic fingerprint of the mutation. A replayed request whose method,
 * route and body all match the original is safe to short-circuit; a mismatch is
 * the caller's responsibility to surface (the stored response is still returned,
 * matching the "first write wins" contract).
 */
export function requestFingerprint(method: string, path: string, body: unknown): string {
  return createHash('sha256')
    .update(`${method}:${path}:${JSON.stringify(body ?? null)}`)
    .digest('hex');
}

export interface StoredIdempotency {
  status: number;
  body: unknown;
}

export interface GenericPgError {
  code?: string;
}

/**
 * Load a replayable response for a key within the current transaction. Tenant-
 * scoped keys are isolated by tenant_id (unique (tenant_id, key)); account/
 * platform scope uses the NULL-tenant global key. RLS (0003) limits both to the
 * signed context, so a key minted in tenant A is invisible to tenant B.
 */
export async function readIdempotency(
  tx: Tx,
  opts: { tenantId?: string | null; key: string },
): Promise<StoredIdempotency | null> {
  const tenantId = opts.tenantId ?? null;
  const row = tenantId
    ? await tx
        .select()
        .from(idempotencyKeys)
        .where(and(eq(idempotencyKeys.tenantId, tenantId), eq(idempotencyKeys.key, opts.key)))
        .limit(1)
    : await tx
        .select()
        .from(idempotencyKeys)
        .where(and(isNull(idempotencyKeys.tenantId), eq(idempotencyKeys.key, opts.key)))
        .limit(1);
  const hit = row[0];
  if (!hit) return null;
  if (hit.expiresAt.getTime() <= Date.now()) return null;
  return { status: hit.responseStatus ?? 200, body: hit.responseBody };
}

export async function recordIdempotency(
  tx: Tx,
  opts: { tenantId?: string | null; key: string; requestHash: string },
  status: number,
  body: unknown,
): Promise<void> {
  await tx.insert(idempotencyKeys).values({
    tenantId: opts.tenantId ?? null,
    key: opts.key,
    requestHash: opts.requestHash,
    responseStatus: status,
    responseBody: normalizeBody(body),
    expiresAt: sql`now() + interval '1 day'`,
    createdAt: sql`now()`,
  });
}

/** jsonb never accepts undefined; normalize to null so the stored body round-trips. */
function normalizeBody(body: unknown): unknown {
  if (body === undefined) return null;
  return body;
}

/**
 * Executes a mutation exactly once per (tenant, key) and replays the stored
 * response afterwards. Runs inside the caller's transaction so the idempotency
 * record commits atomically with the mutation, audit trail and outbox event.
 *
 * Concurrent requests that share a key are serialized by the uniqueness of
 * (tenant_id, key): the loser's insert raises 23505 inside a savepoint, which
 * rolls back only its own mutation (so no duplicate side effects commit) and
 * then replays the winner's stored response instead of failing.
 */
export async function withIdempotency<T>(
  tx: Tx,
  opts: { tenantId?: string | null; key?: string | null },
  requestHash: string,
  run: () => Promise<{ status: number; body: T }>,
): Promise<{ status: number; body: T; replayed: boolean }> {
  if (!opts.key) {
    const result = await run();
    return { ...result, replayed: false };
  }
  const existing = await readIdempotency(tx, { tenantId: opts.tenantId, key: opts.key });
  if (existing) {
    return { status: existing.status, body: existing.body as T, replayed: true };
  }
  const tenantId = opts.tenantId ?? null;
  const savepoint = `idem_${randomBytes(6).toString('hex')}`;
  const open = sql.raw(`SAVEPOINT ${savepoint}`);
  const rollback = sql.raw(`ROLLBACK TO SAVEPOINT ${savepoint}`);
  const release = sql.raw(`RELEASE SAVEPOINT ${savepoint}`);
  await tx.execute(open);
  try {
    const result = await run();
    await recordIdempotency(tx, { tenantId, key: opts.key, requestHash }, result.status, result.body);
    await tx.execute(release);
    return { ...result, replayed: false };
  } catch (err) {
    await tx.execute(rollback).catch(() => {});
    const code = (err as GenericPgError).code;
    if (code === '23505' || code === '40001') {
      const winner = await readIdempotency(tx, { tenantId, key: opts.key });
      if (winner) {
        return { status: winner.status, body: winner.body as T, replayed: true };
      }
    }
    throw err;
  }
}