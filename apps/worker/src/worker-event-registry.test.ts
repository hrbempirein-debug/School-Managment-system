import { describe, it, expect } from 'vitest';
import { outboxEventTypeSchema, type OutboxEvent, type OutboxEventType } from '@sms/contracts';
import { buildHandlers, type EventHandlerDeps, type OutboxHandler } from './worker.js';

/**
 * Every declared production event, classified, with no silent omission.
 *
 * WHY THIS FILE IS SEPARATE FROM outbox-integration.test.ts
 * That suite's test 8 already pins the catalog at 93 and asserts registry/catalog
 * parity, so "a declared type has no handler" is already covered. Parity is not
 * classification: parity cannot tell a real side-effecting handler from a log-only
 * acknowledgement. A regression that quietly demoted `exam.result.compute` to a
 * log-only handler would leave test 8 green while silently stopping every result
 * computation in the system.
 *
 * The recovery requirement is that all 93 declared events land in exactly one of:
 *
 *   HANDLED            - owns a real, side-effecting handler
 *   INTENTIONALLY_NOOP - deliberately log-only, acked with a log line and nothing else
 *   INVALID/UNKNOWN   - not in the catalog; must have no disposition and must throw
 *
 * HOW THE CLASSIFICATION IS PROVEN WITHOUT CHANGING worker.ts
 * `buildHandlers` binds declared types with a ternary ladder, and the fallback is
 * `logEvent(type)` - a factory that returns a FRESH closure on every call. That gives
 * a reliable structural signature, and it is the only mechanism used here:
 *
 *   * the 8 real handlers are module-level singletons, so two types sharing one
 *     handler compare `===` (`leave.approved` and `leave.rejected` do);
 *   * every log-only binding is a distinct object, so no two INTENTIONALLY_NOOP types
 *     share a function and no INTENTIONALLY_NOOP type aliases a real handler.
 *
 * A behavioural assertion backs the structural one: each INTENTIONALLY_NOOP handler is
 * invoked with a `tx` Proxy that throws on ANY property access, and must resolve
 * having only written to the logger. A handler that touched the database would throw,
 * so "no-op" is proven rather than assumed.
 *
 * No database, Redis or runtime flag is involved, so this file runs in the default
 * `pnpm test` suite and is always enforced. The DB-backed proof that an unknown event
 * is recorded as failed and re-driven rather than acked is `processEvent`'s throw at
 * worker.ts:70, asserted by tests 9/10/19 of outbox-integration.test.ts.
 */
const silentLog = () => {
  type LogLevel = 'info' | 'error' | 'warn' | 'debug';
  void (undefined as unknown as LogLevel);
};

/** The 9 declared events that own a real handler. Pinned deliberately. */
const HANDLED: readonly OutboxEventType[] = [
  'promotion.batch.execute',
  'student.document.uploaded',
  'student.import.submitted',
  'attendance.marked',
  'leave.approved',
  'leave.rejected',
  'exam.result.compute',
  'report_card.generated',
  'exam.published',
];

/**
 * Event types that intentionally share one handler instance. Everything else in
 * HANDLED owns a handler no other type uses, which is asserted below - so a future
 * edit that aliases two real handlers onto one function is caught.
 */
const SHARED_HANDLER_PAIRS: ReadonlyArray<readonly [OutboxEventType, OutboxEventType]> = [
  ['leave.approved', 'leave.rejected'],
];

const catalog = outboxEventTypeSchema.options as unknown as readonly OutboxEventType[];

describe('outbox event registry: every declared event is classified', () => {
  it('pins the declared catalog', () => {
    // 89 through Phase 5; Phase 6 adds exam.result.compute, exam.published,
    // report_card.generated and result.corrected.
    expect(catalog.length).toBe(93);
    expect(new Set(catalog).size, 'the catalog contains a duplicate event type').toBe(93);
  });

  it('registers exactly the catalog: no missing type, no extra type', () => {
    const registry = buildHandlers(silentLog);
    const keys = Object.keys(registry);
    expect(keys.length, 'the registry and the catalog have drifted apart').toBe(catalog.length);
    // Both directions, so a renamed type cannot hide behind an equal count.
    expect([...keys].sort()).toEqual([...catalog].sort());
    for (const t of catalog) {
      expect(typeof registry[t], `declared event ${t} has no handler`).toBe('function');
    }
  });

  it('HANDLED is exactly the pinned 9, and all of them are declared', () => {
    expect(HANDLED.length).toBe(9);
    expect(new Set(HANDLED).size, 'HANDLED contains a duplicate').toBe(9);
    for (const t of HANDLED) {
      expect(catalog, `${t} is pinned as HANDLED but is not a declared event`).toContain(t);
    }
  });

  it('the remaining 84 are INTENTIONALLY_NOOP - accounted for, none unclassified', () => {
    const noop = catalog.filter((t) => !HANDLED.includes(t));
    expect(noop.length, 'catalog minus HANDLED is not the expected 84').toBe(84);
    // The three buckets partition the catalog and cover it completely: nothing is
    // left in an unstated state, which is the "no silent omission" requirement.
    expect(HANDLED.length + noop.length).toBe(catalog.length);
  });

  it('INVALID/UNKNOWN: an undeclared type has no disposition at all', () => {
    const registry = buildHandlers(silentLog);
    for (const bogus of ['mystery.thing', 'exam.result.computed', 'user.created.extra', '', 'HANDLED']) {
      expect(registry[bogus], `"${bogus}" is not a declared event but has a handler`).toBeUndefined();
    }
  });

  it('structural: real handlers are shared where declared, and never aliased to a no-op', () => {
    const registry = buildHandlers(silentLog);
    const handlers = new Map<OutboxEventType, OutboxHandler>(HANDLED.map((t) => [t, registry[t]!]));

    // The declared sharing is real.
    for (const [a, b] of SHARED_HANDLER_PAIRS) {
      expect(registry[a], `${a} should share its handler with ${b}`).toBe(registry[b]);
    }

    // No OTHER pair of HANDLED types may share a handler: if two unrelated events
    // collapsed onto one function, one of their side effects would be lost.
    const shared = new Set(SHARED_HANDLER_PAIRS.map(([a, b]) => `${a}|${b}`));
    for (const a of HANDLED) {
      for (const b of HANDLED) {
        if (a === b || shared.has(`${a}|${b}`) || shared.has(`${b}|${a}`)) continue;
        expect(registry[a], `${a} and ${b} unexpectedly share one handler`).not.toBe(registry[b]);
      }
    }

    // Every HANDLED handler must be an object distinct from every other one...
    const realHandlers = [...new Set(handlers.values())];
    expect(realHandlers.length, 'expected 8 distinct real handler instances for 9 event types').toBe(8);

    // ...and distinct from every INTENTIONALLY_NOOP binding. `logEvent(type)` returns
    // a fresh closure per call, so a no-op can never be the same object as a real
    // handler. This is the assertion that a real handler cannot be silently demoted
    // to a log-only one without the identity changing.
    for (const t of catalog.filter((x) => !HANDLED.includes(x))) {
      expect(realHandlers, `${t} is no-op but aliases a real handler`).not.toContain(registry[t]);
    }
  });

  it('structural: all 84 no-op bindings are distinct, i.e. per-type log-only closures', () => {
    const registry = buildHandlers(silentLog);
    const noopTypes = catalog.filter((t) => !HANDLED.includes(t));
    const seen = new Map<OutboxHandler, OutboxEventType>();
    for (const t of noopTypes) {
      const fn = registry[t]!;
      const prior = seen.get(fn);
      expect(prior, `${t} shares its log-only handler with ${prior}`).toBeUndefined();
      seen.set(fn, t);
    }
    expect(seen.size).toBe(84);
  });

  it('behavioural: a no-op writes only to the logger and never touches the database', async () => {
    const registry = buildHandlers(silentLog);
    const lines: Array<{ level: string; message: string }> = [];
    const log = (level: string, message: string) => {
      lines.push({ level, message });
    };
    const registryWithSpy = buildHandlers(log as never);

    // Any property access on this Proxy throws, so a handler that reaches for the
    // transaction fails here instead of silently passing as a no-op.
    const tripwire = new Proxy(
      {},
      {
        get(_t, prop) {
          throw new Error(`a log-only handler touched the database via tx.${String(prop)}`);
        },
      },
    );

    const noopTypes = catalog.filter((t) => !HANDLED.includes(t));
    // Every no-op, not a sample: the guarantee is "all 84", so all 84 are exercised.
    for (const t of noopTypes) {
      const deferred: unknown[] = [];
      const event = { id: 'e-1', tenantId: 't-1', aggregateId: 'a-1', eventType: t } as OutboxEvent;
      const deps = { tx: tripwire as never, event, defer: (j: unknown) => deferred.push(j) };
      await expect(
        registryWithSpy[t]!(deps as unknown as EventHandlerDeps),
        `${t} is classified as a no-op but did not complete`,
      ).resolves.toBeUndefined();
      expect(deferred, `${t} deferred a job, so it is not a no-op`).toHaveLength(0);
    }

    // And they are actually logging, not silently resolving.
    expect(lines.length, 'the 84 no-op handlers produced no log output at all').toBe(84);
    expect(lines.every((l) => l.message.includes('outbox:'))).toBe(true);
    expect(new Set(lines.map((l) => l.message)).size, 'each no-op should log its own event type').toBe(84);
    // `registry` is the same construction as `registryWithSpy`; referenced so the
    // unused-variable intent is explicit rather than accidental.
    expect(Object.keys(registry).length).toBe(93);
  });
});
