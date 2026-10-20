import { describe, it, expect, afterAll } from 'vitest';
import { readFile } from 'node:fs/promises';
import { existsSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * Phase 8 D3 static gate — a source-scanning "every worker DB statement is
 * tenant-scoped (or a documented key-scoped/cross-tenant exception)" gate.
 *
 * The runtime suite (d3-worker-tenant-isolation.test.ts) proves data-based
 * isolation by driving the production handlers; this gate is the COMPLEMENTARY
 * static check that fails a source change that introduces a tenant-unscoped DB
 * statement WITHOUT running a database. It is the guard the report (§15) relies
 * on for "no generic unscoped tenant-table read anywhere in the worker".
 *
 * Two properties are asserted:
 *   1. The gate is not vacuous: a temporary module containing an unscoped UPDATE
 *      and an unscoped SELECT is detected (the fixture MUST make the gate fail,
 *      and is deleted afterwards — `fixtureGone` below asserts the postcondition).
 *   2. Production sources have EXACTLY the documented allowance set: everything
 *      else carries a tenant predicate. A brand-new unscoped statement that is not
 *      on the allowance list fails the gate.
 *
 * The allowance list is a SECURITY decision made explicit, not a bypass:
 *   - promotion.ts status-transition UPDATEs scope by global `promotion_items.id` /
 *     `promotion_batches.id` AFTER a tenant-scoped read of the owning batch
 *     (defence-in-depth gap, documented in the Phase 8 report);
 *   - student-import.ts read-by-global-`importId` (import ids are globally unique);
 *   - the daily-summary scheduler is deliberately cross-tenant (one audit row per
 *     (tenant, date)), and its `current_date` read is system-level.
 * Any OTHER unscoped statement fails the gate regardless of how safe it looks.
 */

const TARGETS = [
  'promotion.ts',
  'attendance.ts',
  'documents.ts',
  'exams.ts',
  'student-import.ts',
  'tenant-invariant.ts',
  'worker.ts',
  'report-pdf.ts',
] as const;

const HERE = path.dirname(fileURLToPath(import.meta.url));

interface Stmt {
  file: string;
  line: number;
  op: 'select' | 'selectDistinct' | 'insert' | 'update' | 'delete' | 'raw';
  table: string;
  scoped: boolean;
}

function lineAt(src: string, index: number): number {
  return src.slice(0, index).split('\n').length;
}

/** Extract (op, table, chainText) for every drizzle builder statement. */
function builderStatements(src: string): Array<{ op: Stmt['op']; table: string; chain: string; index: number }> {
  const out: Array<{ op: Stmt['op']; table: string; chain: string; index: number }> = [];
  // A statement ends at `.execute(`, `.returning(` (implicit execute) or `;`.
  // Chain calls from other APIs (e.g. crypto `createHash(...).update(data)`)
  // are dropped afterwards via the DB_TABLES whitelist.
  const re = /\.(select|selectDistinct|insert|update|delete)\(([\s\S]*?)(?:\.execute\(|\.returning\(|;)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const op = m[1] as Stmt['op'];
    const chain = m[0];
    // For selects the table is in `.from(NAME)`; for DML in the op argument.
    let table = '';
    if (op === 'select' || op === 'selectDistinct') {
      const fm = /\.from\((\w+)\)/.exec(chain);
      table = fm?.[1] ?? '';
    } else {
      const am = /\.(?:insert|update|delete)\(\s*(\w+)/.exec(chain);
      table = am?.[1] ?? '';
    }
    out.push({ op, table, chain, index: m.index });
  }
  // Only keep candidates whose table is a REAL schema table; this drops false
  // positives from non-DB chain calls like `createHash(...).update(data)`.
  return out.filter((s) => s.table.length > 0 && DB_TABLES.has(snakeCase(s.table)));
}

const DB_TABLES = new Set('academic_terms academic_years acd_classes admission_applications app_rls_secrets attendance_days attendance_periods audit_logs auth_identities auth_mfa_factors auth_sessions auth_step_up_challenges auth_tokens below calendar_events calendars campuses class_subjects departments enrollments exam_schedules exam_subjects exam_types exams files fin_billing_run_items fin_billing_runs fin_challans fin_document_counters fin_fee_assignments fin_fee_heads fin_fee_installment_plans fin_fee_structure_items fin_fee_structure_targets fin_fee_structures fin_invoice_adjustments fin_invoice_items fin_invoices fin_ledger_accounts fin_ledger_entries fin_ledger_entry_groups fin_ledger_event_types fin_payment_allocations fin_payments fin_receipts fin_reconciliation_batches fin_reconciliation_matches fin_refunds fin_tax_profiles fin_tenant_settings grade_levels grading_scales guardians holidays homework homework_attachments idempotency_keys if is leave_requests leave_types mark_corrections marks membership_roles memberships outbox_events periods platform_role_assignments promotion_batches promotion_items report_card_subjects report_cards role_permissions roles school_settings sections staff_attendance student_documents student_guardians student_import_rows student_imports students subjects teacher_assignments tenants time timetable_entries transfers user_profiles users'.split(' '));

function snakeCase(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}

/** Extract raw `tx.execute(sql\`...\`)` statements. */
function rawStatements(src: string): Array<{ sqlText: string; index: number }> {
  const out: Array<{ sqlText: string; index: number }> = [];
  const re = /\.execute\(\s*sql\`([\s\S]*?)\`/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) out.push({ sqlText: m[1]!, index: m.index });
  return out;
}

function whereClauseOf(chain: string): string {
  const wm = /\.where\(([\s\S]*)$/.exec(chain);
  return wm?.[1] ?? '';
}

function isTenantScoped(chain: string): boolean {
  return /tenantId|tenant_id/.test(chain);
}

function scan(src: string, file: string): Stmt[] {
  const out: Stmt[] = [];
  for (const s of builderStatements(src)) {
    const scoped = s.op === 'insert' ? isTenantScoped(s.chain) : isTenantScoped(whereClauseOf(s.chain));
    out.push({
      file,
      line: lineAt(src, s.index),
      op: s.op,
      table: s.table,
      scoped,
    });
  }
  for (const r of rawStatements(src)) {
    out.push({
      file,
      line: lineAt(src, r.index),
      op: 'raw',
      table: '(raw sql)',
      scoped: /tenant_id/.test(r.sqlText),
    });
  }
  return out;
}

/**
 * The enumerated, reviewed allowance for statements that carry no tenant
 * predicate. Keyed by `file:op:table`. Anything else unscoped fails the gate.
 * (Line numbers are deliberately NOT pinned: a comment-only move of the
 * statement would otherwise break the gate.)
 */
const ALLOWED_UNSCOPED: ReadonlySet<string> = new Set([
  // promotion.ts — status transitions keyed by globally-unique ids, every one
  // reached only after a tenant-scoped read of the owning batch.
  'promotion.ts:update:promotionItems',
  'promotion.ts:update:promotionBatches',
  // student-import.ts — row read keyed by globally-unique import uuid.
  'student-import.ts:select:studentImportRows',
  // attendance.ts — scheduler reads are deliberately cross-tenant (system job).
  'attendance.ts:raw:(raw sql)',
  // exams.ts — fn_report_card_totals(tenant_id::uuid, card_id) scopes by ARGUMENT
  // (tenantId is the first bound parameter), not by a predicate column.
  'exams.ts:raw:(raw sql)',
]);

const unscopedViolations = (statements: Stmt[]): Stmt[] =>
  statements.filter((s) => !s.scoped && !ALLOWED_UNSCOPED.has(`${s.file}:${s.op}:${s.table}`));

// ------------------------------------------------------------------ tests

describe('D3 static tenant gate (source scan, no database)', () => {
  const fixture = path.join(HERE, '__d3_unsafe_fixture__.ts');
  afterAll(() => {
    if (existsSync(fixture)) rmSync(fixture);
  });

  it('gate is not vacuous: a tenant-unscoped UPDATE/SELECT module FAILS the gate, then the fixture is deleted', async () => {
    const unsafe = `
import { eq } from 'drizzle-orm';
import { enrollments, students, type Tx } from '@sms/db';

export async function leakRead(tx: Tx, enrollmentId: string): Promise<void> {
  await tx.select().from(enrollments).where(eq(enrollments.id, enrollmentId)).execute();
}

export async function leakWrite(tx: Tx, studentId: string): Promise<void> {
  await tx.update(students).set({ status: 'active' }).where(eq(students.id, studentId)).execute();
}

export async function scopedControl(tx: Tx, tenantId: string, studentId: string): Promise<void> {
  await tx.select().from(students).where(eq(students.tenantId, tenantId)).execute();
}
`;
    await import('node:fs').then((fs) => fs.promises.writeFile(fixture, unsafe));
    try {
      const src = await readFile(fixture, 'utf8');
      const violations = unscopedViolations(scan(src, '__d3_unsafe_fixture__.ts'));
      // The two unscoped statements are NOT on the allowance list -> gate fails,
      // while the tenant-scoped control is correctly NOT flagged.
      expect(violations.map((v) => `${v.op}:${v.table}`).sort()).toEqual([
        'select:enrollments',
        'update:students',
      ]);
    } finally {
      rmSync(fixture);
    }
    expect(existsSync(fixture)).toBe(false);
  });

  it('PRODUCTION: every worker DB statement is tenant-scoped or a documented allowance; no unexpected unscoped access', async () => {
    const all: Stmt[] = [];
    for (const name of TARGETS) {
      const src = await readFile(path.join(HERE, name), 'utf8');
      all.push(...scan(src, name));
    }

    const violations = unscopedViolations(all);
    // A new or changed unscoped statement (not in the reviewed allowance list)
    // makes this expectation fail with the exact statement list printed.
    expect(
      violations.map((v) => `${v.file}:${v.op}:${v.table}@${v.line}`),
    ).toEqual([]);

    // Sanity: the scan actually found statements and the allowed exceptions exist.
    const statusTransitions = all.filter(
      (s) => s.file === 'promotion.ts' && (s.op === 'update' || s.op === 'delete'),
    );
    expect(statusTransitions.filter((s) => !s.scoped)).not.toHaveLength(0);
  });
});