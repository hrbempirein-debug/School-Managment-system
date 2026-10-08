import { describe, it, expect } from 'vitest';
import { assertEventTenant, tenantIdOf } from './tenant-invariant.js';
import type { OutboxEvent } from '@sms/contracts';
import { randomUUID } from 'node:crypto';

/**
 * D3-1 / R-3: the worker is `school_migrator` (app_privileged), so RLS never
 * blocks cross-tenant access. That is a DB configuration fact, not an invariant.
 * The compensating application control is a test-enforced data invariant: every
 * tenant-scoped handler MUST see a concrete `event.tenantId` (string, non-empty)
 * and MAY only use that envelope value as its tenant selector. A payload-carried
 * `tenantId` is at most a consistency echo: absent -> envelope stands alone,
 * present -> must equal the envelope byte for byte, malformed -> fail closed.
 * Platform-only events are not handled by the tenant-scoped `processEvent` path
 * and should never call `assertEventTenant` — we model the "no tenantId" case as
 * a failure-closed guard here. This is explicitly NOT claiming DB-level worker
 * isolation; it is the agreed compensating control.
 */
describe('D3 worker tenant invariant (test-enforced)', () => {
  const base: OutboxEvent = {
    version: 1,
    id: randomUUID(),
    tenantId: randomUUID(),
    eventType: 'campus.created',
    aggregateType: 'campus',
    aggregateId: randomUUID(),
    payload: {},
    correlationId: null,
    causationId: null,
    createdAt: new Date().toISOString(),
  };

  const otherTenant = randomUUID();

  it('accepts a tenant-scoped event with a concrete tenantId', () => {
    expect(() => assertEventTenant(base)).not.toThrow();
  });

  it('rejects events without tenantId (undefined)', () => {
    expect(() =>
      assertEventTenant({ ...base, tenantId: undefined as unknown as string }),
    ).toThrow(/no tenantId/);
  });

  it('rejects events with empty tenantId', () => {
    expect(() => assertEventTenant({ ...base, tenantId: '' })).toThrow(/no tenantId/);
  });

  it('rejects events with null tenantId', () => {
    expect(() => assertEventTenant({ ...base, tenantId: null as unknown as string })).toThrow(/no tenantId/);
  });

  it('rejects events with whitespace-only tenantId', () => {
    expect(() => assertEventTenant({ ...base, tenantId: '   ' })).toThrow(/no tenantId/);
  });

  // ---------------------------------------------------------------- R-3 payload echo

  it('accepts a payload.tenantId that EQUALS the envelope tenantId', () => {
    const event: OutboxEvent = {
      ...base,
      payload: { tenantId: base.tenantId, attendanceDate: '2026-01-01' },
    };
    expect(() => assertEventTenant(event)).not.toThrow();
  });

  it('accepts an ABSENT payload.tenantId (envelope stands alone)', () => {
    const event: OutboxEvent = { ...base, payload: { attendanceDate: '2026-01-01' } };
    expect(() => assertEventTenant(event)).not.toThrow();
  });

  it('REJECTS a payload.tenantId that MISMATCHES the envelope', () => {
    const event: OutboxEvent = { ...base, payload: { tenantId: otherTenant } };
    expect(() => assertEventTenant(event)).toThrow(
      new RegExp(`envelope ${base.tenantId} != payload ${otherTenant}`),
    );
  });

  it('REJECTS empty/whitespace payload.tenantId', () => {
    for (const bad of ['', '   ']) {
      const event: OutboxEvent = { ...base, payload: { tenantId: bad } };
      expect(() => assertEventTenant(event), `payload tenantId = ${JSON.stringify(bad)}`).toThrow(
        /malformed payload\.tenantId/,
      );
    }
  });

  it('REJECTS null payload.tenantId (present but not a tenant selector)', () => {
    const event: OutboxEvent = { ...base, payload: { tenantId: null } };
    expect(() => assertEventTenant(event)).toThrow(/malformed payload\.tenantId/);
  });

  it('REJECTS non-string payload.tenantId (number/object/boolean)', () => {
    for (const bad of [42, {}, [], true, 3.14]) {
      const event: OutboxEvent = { ...base, payload: { tenantId: bad } };
      expect(() => assertEventTenant(event), `payload tenantId = ${JSON.stringify(bad)}`).toThrow(
        /malformed payload\.tenantId/,
      );
    }
  });

  // ---------------------------------------------------------------- tenantIdOf

  it('tenantIdOf returns the envelope value (never the payload echo)', () => {
    const event: OutboxEvent = { ...base, payload: { tenantId: base.tenantId } };
    expect(tenantIdOf(event)).toBe(base.tenantId);
  });

  it('tenantIdOf uses the envelope when no payload copy exists', () => {
    const event: OutboxEvent = { ...base, payload: {} };
    expect(tenantIdOf(event)).toBe(base.tenantId);
  });

  it('tenantIdOf throws on mismatch — handlers cannot silently select a foreign tenant', () => {
    const event: OutboxEvent = { ...base, payload: { tenantId: otherTenant } };
    expect(() => tenantIdOf(event)).toThrow(/mismatch/);
  });
});