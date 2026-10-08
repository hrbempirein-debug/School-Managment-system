import { describe, it, expect, afterAll } from 'vitest';
import { readFile, readdir } from 'node:fs/promises';
import { existsSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * Phase 8 R-3 static gate — the outbox ENVELOPE (`event.tenantId`) is the ONLY
 * legitimate tenant selector in the worker. A payload-carried `tenantId` is used
 * by exactly one file — `tenant-invariant.ts` — and only to VERIFY consistency;
 * it must never select the tenant or act as a fallback source.
 *
 * Two properties are asserted:
 *   1. The gate is not vacuous: a temporary module that selects the tenant from
 *      `event.payload['tenantId']` (with an envelope fallback) MUST fail the
 *      gate, and the fixture is deleted afterwards (`fixtureGone` asserts the
 *      postcondition).
 *   2. Production sources contain NO payload tenant read outside
 *      `tenant-invariant.ts`. The inverse is also pinned: handlers DO call
 *      `tenantIdOf`, so the gate would catch a future replacement that stops
 *      using the enforcement point.
 *
 * This complements the runtime trust-chain suite
 * (d3-worker-tenant-isolation.test.ts "R-3 TRUST CHAIN") and the D3 statement
 * gate (d3-static-tenant-gate.test.ts): no source change can reintroduce a
 * payload-first tenant selection without a database round-trip to notice.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** The single legitimate reader of the payload echo — the enforcement point. */
const ENFORCEMENT_FILE = 'tenant-invariant.ts';

const FORBIDDEN_READ = /event\.payload(?:\.tenantId|\[['"]tenantId['"]\])/;

interface Hit {
  file: string;
  line: number;
}

function lineAt(src: string, index: number): number {
  return src.slice(0, index).split('\n').length;
}

function scanFile(src: string, file: string): Hit[] {
  const hits: Hit[] = [];
  const re = new RegExp(FORBIDDEN_READ.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    hits.push({ file, line: lineAt(src, m.index) });
  }
  return hits;
}

async function workerNonTestSources(): Promise<string[]> {
  const entries = await readdir(HERE);
  return entries
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && !f.startsWith('__'))
    .sort();
}

describe('R-3 static tenant-trust gate (source scan, no database)', () => {
  const fixture = path.join(HERE, '__r3_payload_fixture__.ts');
  afterAll(() => {
    if (existsSync(fixture)) rmSync(fixture);
  });

  it('gate is not vacuous: a payload-first tenant selector FAILS the gate, then the fixture is deleted', async () => {
    const unsafe = `
import type { OutboxEvent } from '@sms/contracts';
import { tenantIdOf } from './tenant-invariant.js';

export function compliant(event: OutboxEvent): string {
  return tenantIdOf(event);
}

export function regressed(event: OutboxEvent): string {
  const claimed = event.payload['tenantId'];
  return typeof claimed === 'string' ? claimed : event.tenantId;
}
`;
    await import('node:fs').then((fs) => fs.promises.writeFile(fixture, unsafe));
    try {
      const src = await readFile(fixture, 'utf8');
      const hits = scanFile(src, '__r3_payload_fixture__.ts');
      expect(hits).toHaveLength(1);
      expect(hits[0]!.line).toBeGreaterThan(0);
    } finally {
      rmSync(fixture);
    }
    expect(existsSync(fixture)).toBe(false);
  });

  it('PRODUCTION: no worker source reads the payload tenant echo outside the enforcement point', async () => {
    const sources = await workerNonTestSources();
    expect(sources.length).toBeGreaterThan(5);
    const hits: Hit[] = [];
    for (const name of sources) {
      const src = await readFile(path.join(HERE, name), 'utf8');
      if (name === ENFORCEMENT_FILE) continue;
      hits.push(...scanFile(src, name));
    }
    expect(
      hits.map((h) => `${h.file}@${h.line}`),
    ).toEqual([]);
  });

  it('PRODUCTION: every tenant-scoped handler now resolves its tenant through tenantIdOf', async () => {
    // The five data-plane handler modules MUST import the enforcement point, so
    // the source of truth cannot be bypassed by re-deriving the tenant inline.
    const handlerModules = [
      'attendance.ts',
      'exams.ts',
      'promotion.ts',
      'documents.ts',
      'student-import.ts',
    ];
    for (const name of handlerModules) {
      const src = await readFile(path.join(HERE, name), 'utf8');
      expect(src, `${name} must import tenantIdOf`).toMatch(/import\s*\{[^}]*\btenantIdOf\b[^}]*\}\s*from\s*'\.\/tenant-invariant\.js'/);
      expect(src, `${name} must not read the payload tenant echo`).not.toMatch(FORBIDDEN_READ);
      expect(src, `${name} must use tenantIdOf(event) rather than the envelope inline`).toMatch(/\btenantIdOf\(event\)/);
    }
  });
});