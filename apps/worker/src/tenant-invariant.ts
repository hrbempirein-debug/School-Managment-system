import type { OutboxEvent } from '@sms/contracts';

/**
 * R-3 — worker tenant trust chain.
 *
 * `event.tenantId` (the outbox ENVELOPE) is the single authoritative tenant
 * selector for every worker handler. `event.payload.tenantId` is at best a
 * redundant echo of it and at worst an attacker-influenced value carried in
 * the event body; it is therefore only ever used as a CONSISTENCY check, never
 * as a source of truth.
 *
 * Rules enforced here, in this order:
 *   1. envelope `tenantId` must be a concrete, non-empty, non-whitespace string;
 *   2. if the payload carries a `tenantId` key at all it must be a non-empty
 *      string (absent -> the envelope stands alone, which is legal);
 *   3. when present the payload value must EQUAL the envelope value byte for
 *      byte — anything else (different tenant, empty, whitespace, null, number,
 *      object) is rejected before a single statement can run.
 *
 * `assertEventTenant` is invoked as the FIRST statement of `runEventHandler`,
 * ahead of `withGuc` and ahead of any SQL, so a malformed or cross-tenant
 * event aborts with zero data-plane access. This is an APPLICATION invariant
 * (test-enforced), not a DB security boundary — the worker connects as
 * `school_migrator` and RLS never blocks it.
 */
function resolveTenant(event: OutboxEvent): string {
  const envelope = event.tenantId;
  // D3-1 (compensating control): worker handlers must never execute a tenant-
  // scoped operation without a concrete tenant. Treat platform-only events as
  // those with no tenantId at all (by convention in this system) — never coerce
  // NULL to a random id.
  if (typeof envelope !== 'string' || envelope.trim().length === 0) {
    throw new Error(`outbox event ${event.eventType} has no tenantId; cannot run tenant-scoped handler`);
  }

  const payload = event.payload;
  if (payload !== null && typeof payload === 'object' && Object.hasOwn(payload, 'tenantId')) {
    const claimed: unknown = payload['tenantId'];
    if (typeof claimed !== 'string' || claimed.trim().length === 0) {
      throw new Error(
        `outbox event ${event.eventType} has a malformed payload.tenantId (${JSON.stringify(
          claimed,
        )}); refusing to run tenant-scoped handler`,
      );
    }
    if (claimed !== envelope) {
      throw new Error(
        `outbox event ${event.eventType} tenantId mismatch: envelope ${envelope} != payload ${claimed}; refusing to run tenant-scoped handler`,
      );
    }
  }
  return envelope;
}

export function assertEventTenant(event: OutboxEvent): void {
  resolveTenant(event);
}

/**
 * The ONLY sanctioned way for a handler to obtain its tenant. Returns the
 * envelope value and re-validates the payload echo, so a handler is safe even
 * when invoked directly by a test that bypassed `runEventHandler`.
 */
export function tenantIdOf(event: OutboxEvent): string {
  return resolveTenant(event);
}
