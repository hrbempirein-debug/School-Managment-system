import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

/**
 * D5 canonicality guard (decision D5-1 contract item 1).
 *
 * The defect was not a single missing `IS NULL` — it was that FOUR different
 * places each re-derived the guardian→student join by hand, and three of them
 * dropped `student_guardians.deleted_at`. A guard that only fixes those four
 * sites would break again at the fifth.
 *
 * So this suite does not test behaviour; it tests SHAPE. Any production file
 * that reads `studentGuardians` must either be the canonical module itself or
 * express the link through one of that module's exported helpers (or state the
 * `deleted_at` predicate literally). Re-deriving the join by hand fails the
 * build, which is the only durable way to keep "one resolver" true.
 *
 * Pure: reads source files only, no database. Runs in the default suite.
 */

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

/** The canonical module is allowed to contain the raw table by definition. */
const CANONICAL_MODULE = 'packages/db/src/relations.ts';

/** Schema/DDL never joins; constraint names contain the table name. */
const STRUCTURAL = new Set(['packages/db/src/schema.ts']);

/** Raw relationship reads in production (non-test) sources. */
const FROM_READ = /\.from\(\s*studentGuardians\s*\)/;
const JOIN_READ = /\.innerJoin\(\s*studentGuardians\s*,/;
const READ_PATTERNS = [FROM_READ, JOIN_READ];

/**
 * A read site is canonical when it does at least one of:
 *   - state `student_guardians.deleted_at IS NULL` itself, or
 *   - go through a helper exported by `@sms/db`'s relation canon.
 */
const CANONICAL_MARKERS = [
  'isNull(studentGuardians.deletedAt)',
  'guardianStudentLinkJoin',
  'parentReadableStudentIds',
  'activeGuardianStudentEmails',
];

const SCAN_ROOTS = ['apps/api/src', 'apps/worker/src', 'packages/contracts/src', 'packages/events/src', 'packages/jobs/src', 'packages/db/src'];

function listSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === 'node_modules' || entry === 'dist') continue;
      listSourceFiles(full, out);
      continue;
    }
    if (!entry.endsWith('.ts')) continue;
    if (entry.endsWith('.test.ts') || entry.endsWith('.spec.ts')) continue;
    out.push(full);
  }
  return out;
}

function rel(full: string): string {
  return full.replace(/\\/g, '/').slice(repoRoot.replace(/\\/g, '/').length);
}

const readSites = (): { file: string; src: string }[] => {
  const found: { file: string; src: string }[] = [];
  for (const root of SCAN_ROOTS) {
    let files: string[];
    try {
      files = listSourceFiles(join(repoRoot, root));
    } catch {
      continue;
    }
    for (const full of files) {
      const file = rel(full);
      if (file === CANONICAL_MODULE || STRUCTURAL.has(file)) continue;
      const src = readFileSync(full, 'utf8');
      if (!READ_PATTERNS.some((re) => re.test(src))) continue;
      found.push({ file, src });
    }
  }
  return found;
};

describe('D5 canonicality: nobody re-derives the guardian↔student join by hand', () => {
  it('finds the expected read sites (the guard is actually looking at something)', () => {
    const files = readSites().map((r) => r.file).sort();
    // If this list changes, the canon gained or lost a consumer: re-audit it
    // rather than editing the expectation to match.
    expect(files).toEqual([
      'apps/api/src/routes/school/homework.ts',
      'apps/api/src/routes/school/students.ts',
    ]);
  });

  it('every read site states the link predicate or uses the canonical helper', () => {
    const offenders: string[] = [];
    for (const { file, src } of readSites()) {
      if (!CANONICAL_MARKERS.some((m) => src.includes(m))) offenders.push(file);
    }
    expect(
      offenders,
      'raw student_guardians reads bypass the D5 canon — a soft-unlinked guardian would regain access',
    ).toEqual([]);
  });

  it('no read site still carries the unfixed three-table join shape', () => {
    const offenders: string[] = [];
    for (const { file, src } of readSites()) {
      const joinsGuardianById = /eq\(\s*studentGuardians\.guardianId\s*,\s*guardians\.id\s*\)/.test(src);
      if (joinsGuardianById && !src.includes('isNull(studentGuardians.deletedAt)') && !src.includes('guardianStudentLinkJoin')) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the parent-visibility ladder delegates instead of re-deriving', () => {
    const attendance = readFileSync(join(repoRoot, 'apps/api/src/routes/school/attendance.ts'), 'utf8');
    expect(attendance).toContain('parentReadableStudentIds(tx, ctx)');
    expect(attendance, 'attendance.ts must no longer query studentGuardians directly').not.toMatch(
      FROM_READ,
    );
    expect(attendance).not.toMatch(JOIN_READ);

    for (const workerFile of ['apps/worker/src/attendance.ts', 'apps/worker/src/exams.ts']) {
      const src = readFileSync(join(repoRoot, workerFile), 'utf8');
      expect(src, `${workerFile} must resolve recipients through the canon`).toContain(
        'activeGuardianStudentEmails(',
      );
      expect(src).not.toMatch(FROM_READ);
      expect(src).not.toMatch(JOIN_READ);
    }
  });

  it('the canonical module actually applies all five predicates', () => {
    const canon = readFileSync(join(repoRoot, CANONICAL_MODULE), 'utf8');

    const link = canon.slice(canon.indexOf('export function guardianStudentLinkJoin'));
    expect(link).toContain('isNull(studentGuardians.deletedAt)');

    const toStudent = canon.slice(canon.indexOf('export function linkStudentJoin'));
    expect(toStudent).toContain('isNull(students.deletedAt)');

    const scope = canon.slice(canon.indexOf('export function activeGuardianScope'));
    expect(scope).toContain('eq(guardians.tenantId');
    expect(scope).toContain('eq(guardians.userId');
    expect(scope).toContain('isNull(guardians.deletedAt)');
    expect(scope).toContain('isNull(studentGuardians.deletedAt)');
    expect(scope).toContain('isNull(students.deletedAt)');

    const recipients = canon.slice(canon.indexOf('export async function activeGuardianStudentEmails'));
    expect(recipients).toContain('activeLinkScope(');
    expect(recipients).toContain('guardianStudentLinkJoin()');
    expect(recipients).toContain('linkStudentJoin()');
  });

  it('the canon is exported from the package entry point', () => {
    const index = readFileSync(join(repoRoot, 'packages/db/src/index.ts'), 'utf8');
    expect(index).toContain("export * from './relations.js';");
  });
});
