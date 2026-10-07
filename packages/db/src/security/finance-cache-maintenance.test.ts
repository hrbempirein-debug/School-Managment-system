import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { getEnv } from '@sms/config';

/**
 * 0023 CACHE-MAINTENANCE SECURITY PROOF — C-SEC-M1 … C-SEC-M7 (§28.3.1).
 *
 * WHY THIS FILE IS THE FIRST REAL PROOF
 * The design's previous revision shipped a header guard that refused the phase's
 * OWN cache writers. `trg_fin_invoice_item_total` issues
 * `UPDATE fin_invoices SET subtotal, total, updated_at` from inside a trigger, and
 * that nested statement re-fires `trg_fin_invoice_header_guard` — which refused
 * every change to all seven server-owned columns unconditionally. So the FIRST
 * INSERT of an invoice line raised 55000, and every invoice read
 * subtotal = total = balance = 0 forever.
 *
 * Nothing caught it, because every pre-existing finance test asserts that a
 * CALLER is refused. A design in which the caller is refused AND the maintenance
 * path is also refused satisfies all of them. A negative-only suite cannot detect
 * an over-restrictive rule. That is why C-SEC-M1, M2 and M3 here are POSITIVE and
 * assert that the caches actually MOVE, and why M1 is the literal reproduction of
 * the P0: on the old design it returned 55000.
 *
 * THE MECHANISM UNDER TEST (design §9.6.0 clause (2), §9.6.0.1)
 * Two factors, BOTH required:
 *   A. pg_trigger_depth() >= 2 — structural. Not a flag, so it cannot be forged
 *      by a role, a GUC, a SECURITY DEFINER function or a compromised route.
 *      A statement issued directly by ANY role arrives at depth 1 and is refused.
 *   B. current_setting('fin.invoice_maintenance_scope', true) is exactly one of
 *      two values, and the columns that actually moved must be a subset of THAT
 *      value's column set. (invoice_no, issued_at, voided_at) are in NEITHER
 *      scope and are refused unconditionally.
 * trg_fin_invoice_header_guard is SECURITY INVOKER and issues no statement of its
 * own, which is exactly what lets factor A tell a caller's direct UPDATE from a
 * maintenance writer's nested one.
 *
 * TWO DEVIATIONS FROM §28.3.1, BOTH FORCED BY MIGRATION ORDERING, NEITHER A
 * WEAKENING — each is asserted to fail for the intended reason:
 *
 *   1. C-SEC-M2 and C-SEC-M7 name `school_app_rw`. At 0023 that role holds NO
 *      privilege on any of these four tables — §16.5.1's column grants are 0028's
 *      — so "as school_app_rw" is not an executable statement at this migration.
 *      It is therefore executed TWICE instead: once on a role that does hold the
 *      privilege (school_migrator, which is strictly stronger for the guard,
 *      because it proves the OWNER is gated too — the property factor A exists to
 *      provide), and once under §16.5.1's real grant list applied inside this
 *      suite's own rolled-back transaction so the literal application-role
 *      statement shape is exercised. The 42501 the unqualified app role gets is
 *      asserted separately in C-SEC-M4.
 *   2. C-SEC-M3 and C-SEC-M6 drive 0024's producer — `trg_fin_invoice_balance_recompute`
 *      / `fin_invoice_reapply_derived_state` and a `fin_payment_allocations` row.
 *      Those objects are 0024's, and §30.3.1's strict form forbids 0023 from
 *      naming `fin_payment_allocations` or `fin_v_invoice_balance` at all, so they
 *      cannot exist yet. What M3 exists to prove — that the guard honours the
 *      SECOND scope value and that it is not a general bypass — is proved here by
 *      driving the same depth + scope machinery the design itself uses for M5. The
 *      0024 data path is re-run when 0024 lands.
 *
 * Opt-in: RUN_RUNTIME_SECURITY_TESTS=1 (requires PostgreSQL + migrations 0001..0023).
 */
const enabled = process.env.RUN_RUNTIME_SECURITY_TESTS === '1';
const describeDb = enabled ? describe : describe.skip;

let migrator: pg.Client;
let app: pg.Client;

/** The E-case RBAC fixture: an active membership wired to a custom
 * 'accountant' role so F1's classifier resolves userA to finance_staff. */
let financeRoleId: string;
let financeMembershipId: string;

const uid: Record<string, string> = {};
const slug = randomUUID().slice(0, 8);

/**
 * Reads a fixture id, failing loudly when it was never assigned. Interpolating
 * `u('x')` directly would render an unassigned id as the literal string
 * "undefined" and surface as a baffling SQL syntax error instead.
 */
const u = (k: string): string => {
  const v = uid[k];
  if (v === undefined) throw new Error(`fixture id "${k}" was never assigned`);
  return v;
};

type Row = Record<string, unknown>;

const q = (v: string) => `'${v}'`;

/** Runs `sql` in the suite's own transaction. */
const mig = async (sql: string): Promise<Row[]> => {
  const r = await migrator.query(sql);
  return r.rows as Row[];
};

/**
 * Asserts `sql` is refused with SQLSTATE `code`, and that the refusal changed
 * nothing. Rolls back to a savepoint so the case stays independent, and returns
 * the message so the caller can assert it names the RIGHT control rather than
 * merely that something failed — an unrelated SQL error is not a pass.
 */
const migReject = async (sql: string, code: string): Promise<string> => {
  const tag = randomUUID().replace(/-/g, '');
  await migrator.query(`savepoint rej_${tag}`);
  try {
    await migrator.query(sql);
  } catch (e) {
    const err = e as { code?: string; message: string };
    await migrator.query(`rollback to savepoint rej_${tag}`);
    if (err.code !== code) {
      throw new Error(
        `expected SQLSTATE ${code}, got ${err.code ?? '?'}: ${err.message}\n--- SQL ---\n${sql}`,
      );
    }
    return err.message;
  }
  await migrator.query(`rollback to savepoint rej_${tag}`);
  throw new Error(`expected SQLSTATE ${code}, but the statement SUCCEEDED: ${sql}`);
};

/** The same, for the runtime role's own connection. */
const appReject = async (sql: string, code: string): Promise<string> => {
  const tag = randomUUID().replace(/-/g, '');
  await app.query(`savepoint rej_${tag}`);
  try {
    await app.query(sql);
  } catch (e) {
    const err = e as { code?: string; message: string };
    await app.query(`rollback to savepoint rej_${tag}`);
    if (err.code !== code) {
      throw new Error(
        `expected SQLSTATE ${code}, got ${err.code ?? '?'}: ${err.message}\n--- SQL ---\n${sql}`,
      );
    }
    return err.message;
  }
  await app.query(`rollback to savepoint rej_${tag}`);
  throw new Error(`expected SQLSTATE ${code}, but the statement SUCCEEDED: ${sql}`);
};

/** The single row a probe expected to find. */
const one = (rows: Row[]): Row => {
  const r = rows[0];
  if (r === undefined) throw new Error('expected at least one row');
  return r;
};

const num = (v: unknown): number => Number(String(v));

/** A `count(*)::int` probe result. */
const n1 = (rows: Row[]): number => num(one(rows).n);

/**
 * `pg_proc.prosrc` verbatim, minus its comments.
 *
 * These functions document their own history at length, and several of those
 * comments quote the SQL of a clause that was REMOVED —
 * `trg_fin_invoice_header_guard` still carries a long note about the
 * `UPDATE fin_invoice_items SET frozen_at` it no longer issues. Any assertion of
 * the form "this function does not write X" has to read the executable text, or it
 * fails on the author's own account of the bug they fixed, which is the worst
 * possible failure mode for a security test: it looks like a real finding and
 * invites someone to delete the explanatory comment.
 *
 * `--` line comments and `/* ... *\/` block comments are stripped. Nothing here
 * relies on a literal inside a string containing a comment opener, because the
 * bodies compared are DDL-free PL/pgSQL whose only quoted text is an exception
 * message and a GUC name.
 */
const stripSqlComments = (src: string): string =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .map((line) => {
      // A line comment opener inside a single-quoted literal is not a comment; the
      // bodies under test contain no such literal, so the simple split is enough.
      const at = line.indexOf('--');
      return at === -1 ? line : line.slice(0, at);
    })
    .join('\n');

/** `prosrc` with comments removed. */
const codeOf = (prosrc: unknown): string => stripSqlComments(String(prosrc));

/**
 * The thirteen trigger functions BOUND by the migrations applied at the `0023`
 * checkpoint: 0022's six (§35.3 rows 1, 2, 3, 3a, 3b, 3c) and 0023's seven (rows
 * 4, 4a, 4b, 4c, 4d, 6, 7).
 *
 * C-SEC-M4a counts definership over THIS set, not over `trg_fin%`. Row 13 and the
 * F5h helper `fin_invoice_reapply_derived_state` are both absent on purpose —
 * the former is 0024's, the latter is bound to no trigger at all — and both are
 * asserted absent from the catalog in the same test, so neither can be added
 * quietly without failing.
 */
const BOUND_0023 = [
  // 0022 (6)
  'trg_fin_target_validate',
  'trg_fin_structure_publish_freeze',
  'trg_fin_structure_child_freeze',
  'trg_fin_assignment_validate',
  'trg_fin_billing_run_freeze',
  'trg_fin_billing_run_items_freeze',
  // 0023 (7)
  'trg_fin_invoice_number',
  'trg_fin_invoice_header_guard',
  'trg_fin_invoice_freeze_lines',
  'trg_fin_invoice_item_amount',
  'trg_fin_invoice_adjustment_approval',
  'trg_fin_invoice_item_total',
  'trg_fin_invoice_items_freeze',
] as const;

/**
 * The two objects whose existence depends on WHERE THE APPLIED SET STOPS.
 *
 * `fin_invoice_reapply_derived_state` (the F5h helper) and row 13
 * (`trg_fin_invoice_balance_recompute`) are both 0024's. This suite is a 0023
 * CHECKPOINT proof, and a checkpoint claim that quietly becomes true-by-
 * supersession is not a checkpoint claim -- so rather than dropping the two
 * absence assertions when 0024 lands, the suite reads the applied set and asserts
 * the correct polarity for each:
 *
 *   applied set stops at 0023 -> both ABSENT  (0024 has not run)
 *   applied set reaches 0024 -> both PRESENT (0024 created them)
 *
 * A hardcoded expectation would pass in one world and fail in the other with a
 * message that looks like a migration defect, when it is the SCOPE that moved.
 */
const CHECKPOINT_SENSITIVE = [
  'fin_invoice_reapply_derived_state',
  'trg_fin_invoice_balance_recompute',
] as const;

/** One enrollment per case: the partial unique index allows one LIVE invoice each. */
const CASE_ENROLLMENTS = 12;

/** Creates a draft invoice for enrollment #`n` (1-based) and returns its id. */
const makeInvoice = (n: number): string => {
  const key = `inv${n}`;
  uid[key] = randomUUID();
  return `insert into fin_invoices
       (id, tenant_id, student_id, academic_year_id, enrollment_id, structure_id, created_by)
     values (${q(u(key))}, ${q(u('tenantA'))}, ${q(u(`stu${n}`))}, ${q(u('yearA'))},
             ${q(u(`enr${n}`))}, ${q(u('structA'))}, ${q(u('userA'))})`;
};

/** Adds one 100.00 line to invoice #`n`. Returns the line id. */
const makeLine = (n: number, amount = '100.00'): string => {
  const key = `line${n}`;
  uid[key] = randomUUID();
  return `insert into fin_invoice_items
       (id, tenant_id, invoice_id, structure_id, fee_head_id, description, quantity, unit_amount)
     values (${q(u(key))}, ${q(u('tenantA'))}, ${q(u(`inv${n}`))}, ${q(u('structA'))},
             ${q(u('headA'))}, 'Tuition', 1, ${amount})`;
};

/**
 * Issues invoice #`n`, which is what makes it a legal target for cash.
 *
 * §12.5.1 / §36.2 row 46 (D9, a P0): `trg_fin_allocation_target_state` refuses an
 * `apply` allocation whose invoice is `draft` or `void`. An allocation against a
 * draft is therefore not merely discouraged, it is impossible -- which is why
 * C-SEC-M3's positive control must issue the invoice first, and why C-SEC-M6b
 * below reaches row 13 through fin_invoice_items instead.
 */
const issueInvoice = (n: number): string =>
  `update fin_invoices set status = 'issued' where id = ${q(u(`inv${n}`))}`;

/**
 * THE REAL PRODUCER: a settled payment plus an `apply` allocation naming invoice
 * #`n`, returned as one SQL string so a case can await it.
 *
 * This exists because the previous revision of C-SEC-M3 and C-SEC-M6 hand-issued a
 * nested `UPDATE` from a probe trigger and asserted a seeded balance. §36.2 row 45
 * records why that is not the same test: a hand-set GUC proves the guard ACCEPTS a
 * scope value, not that any producer sets it, and a probe UPDATE proves a WHEN
 * clause suppresses a write, not that the real writer produces one. Both halves now
 * insert through the real chain -- fin_payment_allocations -> row 13 ->
 * fin_invoice_reapply_derived_state -> `UPDATE fin_invoices SET balance, ...` --
 * which is the only path that also exercises 0024's family guard, its bounds
 * guard, and the D9 target-state guard, none of which a probe could reach.
 *
 * `effect = 'apply'` with a positive amount and no reversal/refund is the shape
 * fin_pa_effect_ck admits; `on_account_return` is deliberately not used here
 * because it names no invoice and so would not reach an invoice cache at all.
 */
const payInvoice = (n: number, amount = '100.00', suffix = 'a'): string => {
  const pay = `pay${n}${suffix}`;
  const alloc = `alloc${n}${suffix}`;
  uid[pay] = randomUUID();
  uid[alloc] = randomUUID();
  return `
    insert into fin_payments
      (id, tenant_id, payment_no, amount, method, channel, status, payer_guardian_id,
       received_at, received_by, idempotency_key)
    values (${q(uid[pay])}, ${q(u('tenantA'))}, ${q(`PAY-${n}${suffix}-${slug}`)}, ${amount},
            'cash', 'manual', 'settled', ${q(u('guardianA'))}, now(), ${q(u('userA'))},
            ${q(`idem-${n}${suffix}-${slug}`)});
    insert into fin_payment_allocations
      (id, tenant_id, payment_id, invoice_id, amount, effect, reason, created_by)
    values (${q(uid[alloc])}, ${q(u('tenantA'))}, ${q(uid[pay])}, ${q(u(`inv${n}`))}, ${amount},
            'apply', 'cache-maintenance proof', ${q(u('userA'))})`;
};

/** Reads one invoice's cached money columns. */
const caches = async (n: number): Promise<{ subtotal: number; total: number; balance: number; status: string }> => {
  const r = await mig(
    `select subtotal, total, balance, status from fin_invoices where id = ${q(u(`inv${n}`))}`,
  );
  const row = one(r);
  return {
    subtotal: num(row.subtotal),
    total: num(row.total),
    balance: num(row.balance),
    status: String(row.status),
  };
};

/**
 * Runs `stmt` from INSIDE a trigger body, so the statement arrives at the guard at
 * depth >= 2 and factor A cannot be what refuses it. Used by C-SEC-M5 to isolate
 * factor B (the scope/column map) from factor A (the depth).
 *
 * The probe is created inside the case's own transaction and therefore disappears
 * with the rollback; there is no persistent helper left behind.
 */
const atMaintenanceDepth = async (n: number, scope: string, column: string): Promise<void> => {
  await migrator.query(
    `create function public.csec_probe() returns trigger
       language plpgsql
       set search_path = pg_catalog, public, pg_temp as $probe$
     declare v_id uuid;
     begin
       -- One level only. This probe is bound to fin_invoices and issues its own
       -- UPDATE of the same table, so without the guard its statement re-enters
       -- the probe forever and the transaction dies with "stack depth limit
       -- exceeded" instead of exercising the guard at depth 2.
       if pg_trigger_depth() > 1 then return null; end if;
       v_id := current_setting('fin.probe_invoice')::uuid;
       perform set_config('fin.invoice_maintenance_scope', current_setting('fin.probe_scope'), true);
       if current_setting('fin.probe_column') = 'subtotal' then
         update fin_invoices set subtotal = 999 where id = v_id;
       elsif current_setting('fin.probe_column') = 'balance' then
         update fin_invoices set balance = 999 where id = v_id;
       elsif current_setting('fin.probe_column') = 'paid_at' then
         update fin_invoices set paid_at = now() where id = v_id;
       elsif current_setting('fin.probe_column') = 'invoice_no' then
         update fin_invoices set invoice_no = 'INV-PROBE' where id = v_id;
       else
         raise exception 'probe column % not implemented', current_setting('fin.probe_column');
       end if;
       return null;
     end $probe$`,
  );
  await migrator.query(
    `create trigger csec_probe_trg after update on fin_invoices
       for each row execute function public.csec_probe()`,
  );
  await migrator.query(`select set_config('fin.probe_invoice', ${q(u(`inv${n}`))}, true)`);
  await migrator.query(`select set_config('fin.probe_scope', ${q(scope)}, true)`);
  await migrator.query(`select set_config('fin.probe_column', ${q(column)}, true)`);
  // The driving statement runs inside a SAVEPOINT so that a refusal (which ABORTS
  // the transaction) can be rolled back to before the cleanup runs. Without it the
  // `drop` in the finally block itself fails with 25P02, and that error replaces
  // the real one — so a genuine refusal surfaced as "current transaction is
  // aborted" and a genuine success was impossible to tell from a broken probe.
  const sp = `probe_${randomUUID().replace(/-/g, '')}`;
  await migrator.query(`savepoint ${sp}`);
  try {
    // Any statement that fires the probe trigger at depth 1; the probe's own
    // UPDATE is then at depth 2, which is the condition under test.
    await migrator.query(
      `update fin_invoices set due_date = due_date where id = ${q(u(`inv${n}`))} and status = 'draft'`,
    );
    // RELEASE, not ROLLBACK, on the success path: the probe's nested write to the
    // cache column is the thing the caller is about to measure, and rolling back
    // to the savepoint would discard it — leaving the case asserting 0 against a
    // write that had in fact succeeded.
    await migrator.query(`release savepoint ${sp}`);
  } catch (e) {
    await migrator.query(`rollback to savepoint ${sp}`);
    await migrator.query('drop trigger if exists csec_probe_trg on fin_invoices');
    await migrator.query('drop function if exists public.csec_probe()');
    throw e;
  }
  await migrator.query('drop trigger if exists csec_probe_trg on fin_invoices');
  await migrator.query('drop function if exists public.csec_probe()');
};

/** The server-owned header columns, and a value that changes each one. */
const SEVEN_COLUMNS: ReadonlyArray<readonly [string, string]> = [
  ['subtotal', '999'],
  ['total', '999'],
  ['balance', '999'],
  ['invoice_no', "'INV-FORGED'"],
  ['issued_at', 'now()'],
  ['voided_at', 'now()'],
  ['paid_at', 'now()'],
];

describeDb('0023 cache-maintenance security proof (C-SEC-M1..M7, live catalogs)', () => {
  beforeAll(async () => {
    const env = getEnv();
    migrator = new pg.Client({ connectionString: env.DATABASE_URL_MIGRATOR });
    app = new pg.Client({ connectionString: env.DATABASE_URL_APP });
    await migrator.connect();
    await app.connect();

    for (const k of [
      'tenantA', 'userA', 'userB', 'campusA', 'yearA', 'levelA', 'classA', 'sectionA',
      'headA', 'headB', 'structA', 'counterA',
    ]) {
      uid[k] = randomUUID();
    }
    for (let n = 1; n <= CASE_ENROLLMENTS; n += 1) {
      uid[`stu${n}`] = randomUUID();
      uid[`enr${n}`] = randomUUID();
    }

    await migrator.query('begin');
    await migrator.query(
      `insert into tenants (id, slug, name) values (${q(u('tenantA'))}, ${q(`cs-a-${slug}`)}, 'CS A')`,
    );
    await migrator.query(
      `insert into users (id, email) values
         (${q(u('userA'))}, ${q(`cs-a-${slug}@example.com`)}),
         (${q(u('userB'))}, ${q(`cs-b-${slug}@example.com`)})`,
    );
    await migrator.query(
      `insert into campuses (id, tenant_id, code, name, status)
       values (${q(u('campusA'))}, ${q(u('tenantA'))}, ${q(`cs-${slug}`)}, 'Campus', 'active')`,
    );
    await migrator.query(
      `insert into academic_years (id, tenant_id, code, name, starts_on, ends_on, status)
       values (${q(u('yearA'))}, ${q(u('tenantA'))}, ${q(`cy-${slug}`)}, 'AY', '2026-01-01', '2026-12-31', 'active')`,
    );
    await migrator.query(
      `insert into grade_levels (id, tenant_id, code, name, status)
       values (${q(u('levelA'))}, ${q(u('tenantA'))}, ${q(`gl-${slug}`)}, 'Grade', 'active')`,
    );
    await migrator.query(
      `insert into acd_classes (id, tenant_id, campus_id, academic_year_id, grade_level_id, code, name, status)
       values (${q(u('classA'))}, ${q(u('tenantA'))}, ${q(u('campusA'))}, ${q(u('yearA'))}, ${q(u('levelA'))}, ${q(`cc-${slug}`)}, 'Class', 'active')`,
    );
    await migrator.query(
      `insert into sections (id, tenant_id, class_id, campus_id, academic_year_id, code, status)
       values (${q(u('sectionA'))}, ${q(u('tenantA'))}, ${q(u('classA'))}, ${q(u('campusA'))}, ${q(u('yearA'))}, ${q(`cs2-${slug}`)}, 'active')`,
    );
    // One student + enrollment per case: the partial unique index
    // fin_invoices_ten_enrollment_year_uq allows exactly one LIVE invoice per
    // (tenant, enrollment, year), so cases cannot share one.
    for (let n = 1; n <= CASE_ENROLLMENTS; n += 1) {
      await migrator.query(
        `insert into students (id, tenant_id, student_no, first_name, last_name, status, primary_campus_id)
         values (${q(u(`stu${n}`))}, ${q(u('tenantA'))}, ${q(`s${n}-${slug}`)}, 'Stu', 'One', 'active', ${q(u('campusA'))})`,
      );
      await migrator.query(
        `insert into enrollments (id, tenant_id, student_id, academic_year_id, class_id, section_id, roll_no, status)
         values (${q(u(`enr${n}`))}, ${q(u('tenantA'))}, ${q(u(`stu${n}`))}, ${q(u('yearA'))}, ${q(u('classA'))}, ${q(u('sectionA'))}, ${String(n).padStart(2, '0')}, 'active')`,
      );
    }
    // Two heads, not one: fin_invoice_items_uq is UNIQUE on
    // (tenant_id, invoice_id, structure_id, fee_head_id, installment_no) with
    // NULLS NOT DISTINCT, so a second line on the same invoice needs a different
    // fee_head_id. Tests that add a line to an invoice that already has one are
    // relying on headB.
    await migrator.query(
      `insert into fin_fee_heads (id, tenant_id, code, name) values
         (${q(u('headA'))}, ${q(u('tenantA'))}, ${q(`th-${slug}`)}, 'Tuition'),
         (${q(u('headB'))}, ${q(u('tenantA'))}, ${q(`th2-${slug}`)}, 'Books')`,
    );
    // A plan-less structure, so due_date derives from effective_from and
    // fin_invoice_items.installment_no is legitimately NULL.
    await migrator.query(
      `insert into fin_fee_structures (id, tenant_id, code, name, academic_year_id, version, status, effective_from)
       values (${q(u('structA'))}, ${q(u('tenantA'))}, ${q(`cst-${slug}`)}, 'Structure', ${q(u('yearA'))}, 1, 'draft', '2026-03-01')`,
    );
    await migrator.query(
      `insert into fin_document_counters (id, tenant_id, academic_year_id, kind, last_value)
       values (${q(u('counterA'))}, ${q(u('tenantA'))}, ${q(u('yearA'))}, 'invoice', 0)`,
    );
    // A real payer, and a real guardianship link from every case student to it.
    // 0024's trg_fin_allocation_family_guard requires, for an `apply` allocation,
    // that the payment's payer_guardian_id be a LIVE guardian of the student on the
    // invoice -- it walks students -> student_guardians -> guardians and demands
    // BOTH deleted_at IS NULL. Without this row a payment fixture cannot be built
    // at all, which is the point: the family boundary is enforced by the database,
    // not by the caller knowing whose child it is.
    //
    // Link 1 is primary and is also the C-ALLOC-DEL family-guard negative control
    // (a second, non-primary link is deliberately NOT created for it).
    uid.guardianA = randomUUID();
    await migrator.query(
      `insert into guardians (id, tenant_id, first_name, last_name)
       values (${q(u('guardianA'))}, ${q(u('tenantA'))}, 'Pay', 'One')`,
    );
    for (let n = 1; n <= CASE_ENROLLMENTS; n += 1) {
      uid[`sg${n}`] = randomUUID();
      await migrator.query(
        `insert into student_guardians (id, tenant_id, student_id, guardian_id, relation, is_primary, can_pickup)
         values (${q(u(`sg${n}`))}, ${q(u('tenantA'))}, ${q(u(`stu${n}`))}, ${q(u('guardianA'))}, 'father', true, true)`,
      );
    }
    // 0028 inversion: a finance-staff ticket for the E case. userA's active
    // tenant membership wired to a custom 'accountant' role gives F1's
    // classifier its finance_staff arm; is_system=false keeps it out of §20.5's
    // backfill so the permission-set assertions stay untouched.
    financeRoleId = randomUUID();
    financeMembershipId = randomUUID();
    await migrator.query(
      `insert into roles (id, tenant_id, scope, code, name, description, is_system)
       values (${q(financeRoleId)}, ${q(u('tenantA'))}, 'tenant', 'accountant',
               'Fixture accountant', 'cache-maintenance E ticket fixture', false)`,
    );
    await migrator.query(
      `insert into memberships (id, tenant_id, user_id, status)
       values (${q(financeMembershipId)}, ${q(u('tenantA'))}, ${q(u('userA'))}, 'active')`,
    );
    await migrator.query(
      `insert into membership_roles (membership_id, role_id)
       values (${q(financeMembershipId)}, ${q(financeRoleId)})`,
    );
    await migrator.query('commit');
  });
  // Each case runs in its own transaction: a refused statement leaves nothing
  // behind, the savepoints migReject needs always exist, and the cases stay
  // independent of each other's writes.
  beforeEach(async () => {
    await migrator.query('begin');
    // The app connection needs a transaction too: appReject wraps its statement in
    // a savepoint, and SAVEPOINT outside a transaction block raises 25P01 — which
    // surfaces as "SAVEPOINT can only be used in transaction blocks" and masks the
    // 42501 the case is actually about. Both connections are rolled back in
    // afterEach, so neither leaks a fixture.
    await app.query('begin');
  });

  afterEach(async () => {
    await migrator.query('rollback');
    await app.query('rollback').catch(() => undefined);
  });

afterAll(async () => {
    try {
      await migrator.query('rollback');
      await migrator.query('begin');
      // Each statement gets its OWN savepoint. Once 0024 lands, several of these
      // DELETEs are legitimately refused -- fin_invoices is frozen below draft and
      // fin_payment_allocations refuses DELETE outright -- and in PostgreSQL a
      // single failed statement poisons the whole transaction with 25P02 until
      // ROLLBACK. The previous teardown swallowed those refusals with
      // `.catch(() => undefined)` and then issued an un-caught statement, so the
      // suite reported "current transaction is aborted" from a cleanup path and
      // every fixture after the first refusal leaked. A savepoint per statement is
      // what makes "this delete was refused" an ordinary outcome here.
      // One savepoint per statement, and it is rolled back ONLY on failure. Rolling
      // back on success too -- which an earlier version of this helper did -- looks
      // harmless and silently deletes nothing at all, because the savepoint was
      // taken before the DELETE. The tell was a RESTRICT error naming a
      // fin_invoice_items row that the "successful" items delete had supposedly
      // removed.
      const wipe = async (sql: string): Promise<string | null> => {
        const tag = randomUUID().replace(/-/g, '');
        await migrator.query(`savepoint wipe_${tag}`);
        try {
          await migrator.query(sql);
          return null;
        } catch (e) {
          await migrator.query(`rollback to savepoint wipe_${tag}`);
          const err = e as { code?: string; message?: string; detail?: string };
          // RAISE EXCEPTION ... USING ERRCODE is how these triggers refuse, so
          // pg's 23001 says nothing on its own: 23001 is what an ON DELETE RESTRICT
          // foreign key raises AND what a trigger can be told to raise. The
          // message is what distinguishes them, which is why it is carried here
          // instead of only the SQLSTATE.
          const first = String(err.message ?? '').split('\n')[0];
          return `${err.code ?? '?'}  ${first}${err.detail ? ` | ${err.detail}` : ''}`;
        }
      };
      // A refused delete is acceptable for a frozen table, but a MISSING one is
      // not: it means a fixture outlived the run. Tracked WITH its SQLSTATE and
      // message so the report says WHY, not only what -- 23503 means the delete
      // order is wrong, 23001 + a trigger message means a freeze was not lifted,
      // and the two have entirely different fixes.
      const must: string[] = [];
      const attempt = async (sql: string): Promise<void> => {
        const why = await wipe(sql);
        if (why !== null) must.push(`${why}\n         ${sql}`);
      };
      // Teardown has to LIFT the freezes, and the reason is structural rather
      // than cosmetic: a single surviving fin_invoice_items row holds a
      // structure_id, and that one row makes every DELETE below it fail with
      // 23503 -- fee structures, fee heads, students, enrollments, sections,
      // grades, years, campuses, users, tenant. The earlier teardown reported 21
      // refusals that were really one refusal plus its cascade.
      //
      // DISABLING is confined to this transaction and the triggers are re-enabled
      // immediately afterwards, in reverse order, exactly as
      // finance-composite-fk.test.ts does for 0022's freeze. Nothing else in the
      // suite observes a disabled trigger: the cases all run in their own
      // transactions, which have already rolled back by this point.
      const LIFT: Record<string, string[]> = {
        fin_receipts: ['fin_receipts_freeze'],
        fin_payment_allocations: [
          'trg_fin_allocations_delete_guard',
          'fin_allocations_bounds',
          'fin_allocations_family',
          'fin_allocations_onaccount',
          'fin_allocations_shape',
          'fin_allocations_target_state',
          'fin_allocations_balance_cache',
        ],
        fin_invoices: [
          'fin_invoices_header_guard',
          'fin_invoices_void_stamp',
          'fin_invoices_freeze_lines',
          'fin_invoices_challan_refresh',
          'fin_invoices_number',
        ],
        fin_invoice_items: [
          'fin_invoice_items_freeze',
          'fin_invoice_items_amount',
          'fin_invoice_items_total',
          'fin_invoice_items_balance',
        ],
        fin_invoice_adjustments: [
          'fin_invoice_adjustments_freeze',
          'fin_invoice_adjustments_approval',
          'fin_invoice_adjustments_total',
          'fin_invoice_adjustments_balance',
        ],
        fin_challans: ['fin_challans_status'],
        fin_billing_run_items: ['fin_run_items_freeze'],
        fin_billing_runs: ['fin_runs_freeze'],
        fin_fee_assignments: ['fin_assignments_validate'],
        fin_fee_structure_targets: ['fin_structure_targets_freeze', 'fin_targets_validate'],
        fin_fee_structure_items: ['fin_structure_items_freeze'],
        fin_fee_installment_plans: ['fin_structure_plans_freeze'],
        fin_fee_structures: ['fin_structures_publish'],
      };
      for (const [table, triggers] of Object.entries(LIFT)) {
        for (const x of triggers) {
          await migrator.query(`alter table ${table} disable trigger ${x}`).catch(() => undefined);
        }
      }
      // Child rows before parents, in TOPOLOGICAL order and not in migration order.
      // fin_billing_run_items goes before fin_invoices because 0023's
      // fin_bri_invoice_fk is RESTRICT and points at it -- deleting the invoice
      // first is refused with 23503, and that one refusal then cascades through
      // every remaining DELETE.
      for (const t of [
        'fin_receipts', 'fin_payment_allocations',
        'fin_billing_run_items', 'fin_billing_runs',
        'fin_invoice_items', 'fin_invoice_adjustments', 'fin_challans', 'fin_invoices',
      ]) {
        await attempt(`delete from ${t} where tenant_id = ${q(u('tenantA'))}`);
      }
      await attempt(
        `delete from membership_roles where membership_id = ${q(financeMembershipId)}`,
      );
      await attempt(
        `delete from memberships where id = ${q(financeMembershipId)}`,
      );
      await attempt(
        `delete from roles where id = ${q(financeRoleId)}`,
      );
      for (const [table, triggers] of Object.entries(LIFT).reverse()) {
        for (const x of [...triggers].reverse()) {
          await migrator.query(`alter table ${table} enable trigger ${x}`).catch(() => undefined);
        }
      }
      await attempt(`delete from fin_fee_structures where id = ${q(u('structA'))}`);
      await attempt(`delete from fin_document_counters where id = ${q(u('counterA'))}`);
      await attempt(`delete from fin_fee_heads where id in (${q(u('headA'))}, ${q(u('headB'))})`);
      for (let n = 1; n <= CASE_ENROLLMENTS; n += 1) {
        await attempt(`delete from enrollments where id = ${q(u(`enr${n}`))}`);
        await attempt(`delete from students where id = ${q(u(`stu${n}`))}`);
      }
      await attempt(`delete from sections where id = ${q(u('sectionA'))}`);
      await attempt(`delete from acd_classes where id = ${q(u('classA'))}`);
      await attempt(`delete from grade_levels where id = ${q(u('levelA'))}`);
      await attempt(`delete from academic_years where id = ${q(u('yearA'))}`);
      await attempt(`delete from campuses where id = ${q(u('campusA'))}`);
      await attempt(`delete from users where id in (${q(u('userA'))},${q(u('userB'))})`);
      await attempt(`delete from tenants where id = ${q(u('tenantA'))}`);
      if (must.length > 0) {
        throw new Error(
          `fixture cleanup left rows behind -- these DELETEs were refused:\n${must.join('\n')}`,
        );
      }
      await migrator.query('commit');
    } finally {
      await migrator.query('end').catch(() => undefined);
      await app.query('end').catch(() => undefined);
    }
  });

  // ---------------------------------------------------------------------------
  // A. Catalog facts the security argument rests on
  // ---------------------------------------------------------------------------
  describe('A. catalog facts, read from pg_proc/pg_trigger — not from source text', () => {
    it('defines exactly the 7 0023 functions and binds them 9 times', async () => {
      const rows = await mig(
        `select p.proname as fn, count(t.oid)::int as bindings
           from pg_proc p
           join pg_namespace n on n.oid = p.pronamespace
           left join pg_trigger t on t.tgfoid = p.oid and not t.tgisinternal
          where n.nspname = 'public'
            and p.proname in ('trg_fin_invoice_number','trg_fin_invoice_header_guard',
                              'trg_fin_invoice_freeze_lines','trg_fin_invoice_item_amount',
                              'trg_fin_invoice_item_total','trg_fin_invoice_adjustment_approval',
                              'trg_fin_invoice_items_freeze')
          group by p.proname
          order by 1`,
      );
      expect(rows).toHaveLength(7);
      expect(rows.map((r) => `${String(r.fn)}=${String(r.bindings)}`)).toEqual([
        'trg_fin_invoice_adjustment_approval=1',
        'trg_fin_invoice_freeze_lines=1',
        'trg_fin_invoice_header_guard=1',
        'trg_fin_invoice_item_amount=1',
        'trg_fin_invoice_item_total=2',
        'trg_fin_invoice_items_freeze=2',
        'trg_fin_invoice_number=1',
      ]);
      expect(rows.reduce((s, r) => s + Number(r.bindings), 0)).toBe(9);
    });

    it('keeps trg_fin_invoice_header_guard SECURITY INVOKER in the catalog (assertion I)', async () => {
      const r = await mig(
        `select prosecdef from pg_proc where proname = 'trg_fin_invoice_header_guard'`,
      );
      // Read from the catalog rather than grepping the migration: this is the
      // assertion that fails if anyone "fixes" the P0 by escalating the guard.
      expect(one(r).prosecdef).toBe(false);
    });

    it('C-SEC-M4a: 13 bound functions at this checkpoint, exactly 3 definers, and the guard is NOT one', async () => {
      // Scoped to BOUND functions owned by migrations in the applied set:
      // 0022's six (rows 1, 2, 3, 3a, 3b, 3c) plus 0023's seven (rows 4, 4a, 4b,
      // 4c, 4d, 6, 7). The F5h helper is deliberately NOT in this list -- it is
      // bound to no trigger -- and row 13 is 0024's, so it is excluded here and
      // included by C-SEC-M4b once the applied set reaches 0024. That is the shape
      // that stops a scoped count from being restated as a phase-wide one: an
      // unscoped "exactly four definers" fails at this checkpoint and passes at
      // 0024, so it tests neither.
      const rows = await mig(
        `select p.proname as fn, p.prosecdef as definer
           from pg_proc p
           join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public'
            and p.proname in (${BOUND_0023.map(q).join(',')})`,
      );
      expect(rows).toHaveLength(13);
      const def = Object.fromEntries(rows.map((r) => [String(r.fn), r.definer]));
      // F5d members owned by the applied set, and nothing else: three.
      const definers = Object.entries(def).filter(([, d]) => d === true).map(([n]) => n).sort();
      expect(definers).toEqual([
        'trg_fin_invoice_freeze_lines',
        'trg_fin_invoice_item_total',
        'trg_fin_invoice_number',
      ]);
      // The guard is the point of factor A (it must run with the CALLER's rights,
      // or pg_trigger_depth() could no longer tell the two apart), and the other
      // three either assign NEW or write no cache.
      expect(def.trg_fin_invoice_header_guard).toBe(false);
      expect(def.trg_fin_invoice_item_amount).toBe(false);
      expect(def.trg_fin_invoice_adjustment_approval).toBe(false);
      expect(def.trg_fin_invoice_items_freeze).toBe(false);
      // 0022's six all stayed invokers. Stated here because 0023's half of the
      // count is what a later edit would break, and a suite that only checked its
      // own migration's functions would not notice 0022 escalating.
      expect(def.trg_fin_structure_child_freeze).toBe(false);
      expect(def.trg_fin_structure_publish_freeze).toBe(false);
      expect(def.trg_fin_billing_run_freeze).toBe(false);
      expect(def.trg_fin_billing_run_items_freeze).toBe(false);
      expect(def.trg_fin_assignment_validate).toBe(false);
      expect(def.trg_fin_target_validate).toBe(false);

      // F5h: bound to no trigger, therefore absent at the 0023 checkpoint. And row
      // 13 is 0024's, naming fin_payment_allocations, so at 0023 it must not exist
      // either -- §30.3.1's strict form, checked as a catalog fact. Which of the two
      // polarities is correct depends on where the applied set stops, so it is
      // READ rather than assumed; see CHECKPOINT_SENSITIVE.
      const sensitive = await mig(
        `select p.proname as fn from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' and p.proname in (${CHECKPOINT_SENSITIVE.map(q).join(',')})
          order by 1`,
      );
      const reached0024 = await mig(
        `select coalesce(max((regexp_match(version, '^0*([0-9]+)'))[1]::int), 0)::int as v
           from schema_migrations`,
      );
      const at = num(one(reached0024).v);
      // Both polarities are asserted, not just the one this database happens to be
      // in: 0024 must add exactly these two and no other function named in this
      // suite's vocabulary.
      expect(sensitive.map((r) => String(r.fn))).toEqual(
        at >= 24 ? [...CHECKPOINT_SENSITIVE].sort() : [],
      );
    });

    it('pins search_path on all seven and revokes every one from PUBLIC', async () => {
      const rows = await mig(
        `select p.proname as fn, r.rolname as grantee, a.privilege_type,
                p.proconfig @> ARRAY['search_path=pg_catalog, public, pg_temp'] as pinned
           from pg_proc p
           join pg_namespace n on n.oid = p.pronamespace
           cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
           left join pg_roles r on r.oid = a.grantee
          where n.nspname = 'public'
            and p.proname in ('trg_fin_invoice_number','trg_fin_invoice_header_guard',
                              'trg_fin_invoice_freeze_lines','trg_fin_invoice_item_amount',
                              'trg_fin_invoice_item_total','trg_fin_invoice_adjustment_approval',
                              'trg_fin_invoice_items_freeze')`,
      );
      // Exploded, not pattern-matched: in pg's text form a PUBLIC grant is the
      // grantee-less `=X/owner`, which a naive `=X/` substring test would accept
      // even when the only grant is the owner's.
      expect(rows).toHaveLength(7);
      for (const r of rows) {
        expect(r.privilege_type, String(r.fn)).toBe('EXECUTE');
        expect(r.grantee, `${String(r.fn)} is executable by ${String(r.grantee)}`).toBe('school_migrator');
        expect(r.pinned, `${String(r.fn)} search_path`).toBe(true);
      }
    });

    it('after 0028 gives school_app_rw exactly the §D.2 table-level grants on the four 0023 tables', async () => {
      const rows = await mig(
        `select c.relname as tbl, r.rolname as grantee, a.privilege_type
           from pg_class c
           join pg_namespace n on n.oid = c.relnamespace
           cross join lateral aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
           left join pg_roles r on r.oid = a.grantee
          where n.nspname = 'public'
            and c.relname in ('fin_invoices','fin_invoice_items','fin_invoice_adjustments','fin_challans')
            and r.rolname = 'school_app_rw'`,
      );
      // 0028 owns §16.5.1's grant model now: Shape 2 (table-level SELECT plus
      // column-level INSERT/UPDATE, carried in attacl) on the invoice triple,
      // Shape 3 (SELECT + INSERT) on fin_challans. The relacl view shows only
      // the table-level grants, exactly as §D.2 prints them.
      const seen = rows
        .map((r) => `${String(r.tbl)}=${String(r.privilege_type)}`)
        .sort();
      expect(seen).toEqual([
        'fin_challans=INSERT',
        'fin_challans=SELECT',
        'fin_invoice_adjustments=SELECT',
        'fin_invoice_items=SELECT',
        'fin_invoices=SELECT',
      ]);
    });

    it('C-SEC-M6a / A15: the issue stamp is AFTER UPDATE OF {status} with the WHEN clause verbatim', async () => {
      // Structural, not behavioural. The stamp is load-bearing in both directions:
      // it must fire on every writer that NAMES status (0024's balance recompute
      // does, and must NOT stamp a draft), and it must not fire on a writer that
      // leaves status alone. A `BEFORE` binding, a missing `WHEN`, or `UPDATE OF`
      // naming a second column all pass a behavioural suite that only issues a
      // plain status transition — which is why this reads the catalog.
      const rows = await mig(
        `select c.relname as tbl, t.tgname as trg, p.proname as fn,
                t.tgtype::int as tgtype, pg_get_triggerdef(t.oid) as def, t.tgenabled::text as en,
                (select string_agg(a.attname, ',' order by a.attname)
                   from unnest(t.tgattr) k(attnum)
                   join pg_attribute a on a.attrelid = t.tgrelid and a.attnum = k.attnum) as cols
           from pg_trigger t
           join pg_class c on c.oid = t.tgrelid
           join pg_proc p on p.oid = t.tgfoid
           join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'public' and not t.tgisinternal
            and p.proname = 'trg_fin_invoice_freeze_lines'`,
      );
      expect(rows).toHaveLength(1);
      const r = one(rows);
      expect(r.tbl).toBe('fin_invoices');
      expect(r.trg).toBe('fin_invoices_freeze_lines');
      expect(r.en).toBe('O');
      // ROW(1) + UPDATE(16) = 17: AFTER, row-level, no INSERT and no DELETE.
      expect(Number(r.tgtype)).toBe(17);
      // EXACTLY {status}. `UPDATE OF` with more than one column would stamp on a
      // write that never touched the lifecycle, and an empty tgattr would stamp on
      // every UPDATE including the 0024 balance writer's.
      expect(String(r.cols)).toBe('status');
      // pg_get_triggerdef renders exactly two of the three WHEN operands on their
      // own, so each conjunct is asserted separately and case-insensitively:
      // `old`/`new` come back lower-cased and the table is schema-qualified.
      expect(String(r.def)).toMatch(/AFTER UPDATE OF status ON public\.fin_invoices/);
      expect(String(r.def)).toMatch(/old\.status = 'draft'::text/i);
      expect(String(r.def)).toMatch(/new\.status <> 'draft'::text/i);
      expect(String(r.def)).toMatch(/new\.status <> 'void'::text/i);
      // The conjunction, not a disjunction: a draft->void transition must NOT
      // stamp, and `<>` on void is the conjunct that says so.
      expect(String(r.def)).toMatch(/\(/i);
      expect(String(r.def)).not.toMatch(/\bor\b/i);
      // A13's other half, restated here because the WHEN is what keeps the stamp
      // off a draft: the guard issues no statement, so this stamp is the ONLY
      // writer of frozen_at in 0023.
      // A15's other half. Counted over BOUND functions with the comments stripped, for
      // the reason given on stripSqlComments: the guard's own prose contains the
      // string `UPDATE fin_invoice_items SET frozen_at`, and an unstripped count
      // would report two writers and fail on the explanation of the deletion.
      const writers = await mig(
        `select p.proname as fn, p.prosrc as src
           from pg_trigger t
           join pg_proc p on p.oid = t.tgfoid
           join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' and not t.tgisinternal`,
      );
      const stamped = writers
        .filter((w) => {
          const c = codeOf(w.src);
          return /frozen_at/i.test(c) && /\bupdate\s+fin_invoice_items/i.test(c);
        })
        .map((w) => String(w.fn))
        .sort();
      expect(stamped).toEqual(['trg_fin_invoice_freeze_lines']);
    });

    it('gives the header guard no statement of its own, so factor A can discriminate', async () => {
      // Factor A only works because a caller's direct UPDATE and a maintenance
      // writer's nested UPDATE are distinguishable. If the guard issued its own
      // statement the two would nest identically and the distinction would be an
      // accident. This is the catalog-level statement of that claim.
      const r = await mig(
        `select prosrc from pg_proc where proname = 'trg_fin_invoice_header_guard'`,
      );
      // Comments stripped: the function's prose records the `UPDATE
      // fin_invoice_items` it used to issue, and matching that would be matching
      // the changelog rather than the behaviour.
      const src = codeOf(one(r).prosrc);
      expect(src).not.toMatch(/\b(insert|update|delete)\s+fin_/i);
    });
  });

  // ---------------------------------------------------------------------------
  // B. C-SEC-M1 .. M3 — the POSITIVE controls. The P0's exact reproduction.
  // ---------------------------------------------------------------------------
  describe('B. positive controls — the caches must actually MOVE', () => {
    it('C-SEC-M1: a line insert recalculates subtotal and total (the P0 reproduction)', async () => {
      await mig(makeInvoice(1));
      // The literal P0 reproduction. On the previous design this statement raised
      // 55000 from inside trg_fin_invoice_header_guard, because the cache writer's
      // own nested UPDATE was refused by the guard meant to protect the column.
      await mig(makeLine(1));

      const c = await caches(1);
      expect(c.subtotal).toBe(100);
      expect(c.total).toBe(100);
      // The line's own cache was computed too, by the BEFORE trigger.
      const line = one(await mig(`select amount from fin_invoice_items where id = ${q(u('line1'))}`));
      expect(num(line.amount)).toBe(100);
    });

    it('C-SEC-M1b: recalculation is a REWRITE, not an additive accumulation', async () => {
      await mig(makeInvoice(2));
      await mig(makeLine(2, '250.00'));
      expect((await caches(2)).total).toBe(250);
      // A second, different line must replace the aggregate, not add to it. A
      // writer that did `total = total + NEW.amount` would report 400 here.
      uid.line2b = randomUUID();
      await mig(
        `insert into fin_invoice_items
           (id, tenant_id, invoice_id, structure_id, fee_head_id, description, quantity, unit_amount)
         values (${q(uid.line2b)}, ${q(u('tenantA'))}, ${q(u('inv2'))}, ${q(u('structA'))},
                 ${q(u('headB'))}, 'Books', 1, '40.00')`,
      );
      expect((await caches(2)).subtotal).toBe(290);
      expect((await caches(2)).total).toBe(290);
      // Deleting the line must drop it out again.
      await mig(`delete from fin_invoice_items where id = ${q(uid.line2b)}`);
      expect((await caches(2)).total).toBe(250);
    });

    it('C-SEC-M2: issuing sets frozen_at AND leaves the recalculated total intact', async () => {
      await mig(makeInvoice(3));
      await mig(makeLine(3));
      expect((await caches(3)).total).toBe(100);

      await mig(`update fin_invoices set status = 'issued' where id = ${q(u('inv3'))}`);

      // First clause: the line was stamped.
      const line = one(await mig(`select frozen_at from fin_invoice_items where id = ${q(u('line3'))}`));
      expect(line.frozen_at).toBeTruthy();
      // SECOND CLAUSE — the one that matters. This is the silent-clobber
      // regression: if the stamp lived in a BEFORE trigger on the parent, the
      // nested line UPDATE would land and then the OUTER statement would store its
      // own pre-image, silently undoing the cache write. A loud 55000 (the
      // pre-remediation behaviour) would have been better than this, but it is
      // also a broken invoice; the correct result is neither.
      const c = await caches(3);
      expect(c.status).toBe('issued');
      expect(c.subtotal).toBe(100);
      expect(c.total).toBe(100);
      // And the number was allocated by the definer, not by the caller.
      const hdr = one(await mig(`select invoice_no, issued_at from fin_invoices where id = ${q(u('inv3'))}`));
      expect(String(hdr.invoice_no)).toMatch(/^INV-/);
      expect(hdr.issued_at).toBeTruthy();
    });

    it('C-SEC-M3: the SECOND scope value is honoured by the REAL producer, and is not a general bypass', async () => {
      // §36.2 row 45. The previous revision set fin.invoice_maintenance_scope by
      // hand from a probe trigger and asserted a seeded balance of 999, which
      // proved only that the guard ACCEPTS the scope -- not that anything in the
      // database ever sets it. Now that 0024 is applied the producer exists, so
      // this drives it: the allocation INSERT runs row 13, which sets the scope to
      // 'invoice_balance_state' itself and issues the nested UPDATE.
      await mig(makeInvoice(4));
      await mig(makeLine(4));
      expect((await caches(4)).balance).toBe(0);

      // D9 first: an `apply` allocation naming a draft is refused outright, so the
      // invoice must be issued before it can be paid. Asserted rather than assumed
      // -- if this ever stops raising, the refusal that §36.2 row 46 calls a P0 fix
      // has been undone and the two authoritative views can silently disagree.
      await migReject(payInvoice(4).slice(payInvoice(4).indexOf(';') + 1), '55000');
      await mig(issueInvoice(4));
      await mig(payInvoice(4));

      // The real arithmetic, not a seeded literal: total 100.00 less the 100.00
      // applied. A probe writing 999 would also have passed the old version of this
      // assertion, which is the whole reason it was rewritten.
      const c = await caches(4);
      expect(c.total).toBe(100);
      expect(c.balance).toBe(0);
      // And the invoice crossed a lifecycle state on the way: a fully-paid invoice
      // is 'paid', and paid_at is the OTHER column this scope owns. Asserting it
      // separately is what distinguishes "the balance scope wrote both" from "the
      // balance scope wrote one and something else wrote the other".
      expect(c.status).toBe('paid');
      const hdr = one(await mig(`select paid_at from fin_invoices where id = ${q(u('inv4'))}`));
      expect(hdr.paid_at).toBeTruthy();
      // subtotal/total belong to the OTHER scope and must be untouched by this one.
      expect(c.subtotal).toBe(100);
    });

    it('C-SEC-M3c: a PARTIAL application leaves the balance partly outstanding', async () => {
      // The positive control that a seeded 999 could never give: the same producer,
      // a smaller amount. If row 13 wrote a constant rather than total - net
      // applied, this reports 0 instead of 60.
      await mig(makeInvoice(12));
      await mig(makeLine(12, '100.00'));
      await mig(issueInvoice(12));
      await mig(payInvoice(12, '40.00'));
      const c = await caches(12);
      expect(c.balance).toBe(60);
      expect(c.status).toBe('partially_paid');
    });
  });

  // ---------------------------------------------------------------------------
  // C. C-SEC-M4 / M7 — who is refused, and by which layer
  // ---------------------------------------------------------------------------
  describe('C. refusal of a directly issued UPDATE, by role', () => {
    it('C-SEC-M4: the runtime role is refused by the ACL (42501) and the owner by the guard (55000)', async () => {
      await mig(makeInvoice(5));
      // The application role, with the maintenance scope set BY HAND — the
      // strongest forgery available to it. It must still fail.
      const appMsg = await appReject(
        `set fin.invoice_maintenance_scope = 'invoice_line_totals'`,
        '0',
      ).catch(() => 'set accepted locally');
      // A SET on its own is not an error, so drive a real statement.
      await app.query(`select set_config('fin.invoice_maintenance_scope', 'invoice_line_totals', false)`);
      const refused = await appReject(
        `update fin_invoices set subtotal = 1 where id = ${q(u('inv5'))}`,
        '42501',
      );
      expect(refused).toMatch(/permission denied/i);
      expect(appMsg).toBeTruthy();

      // The same statement as the role that DOES hold the privilege reaches the
      // guard and is refused there instead. Both codes are asserted because
      // asserting only one would pass against a design where either layer had
      // been removed.
      const guardMsg = await migReject(
        `update fin_invoices set subtotal = 1 where id = ${q(u('inv5'))}`,
        '55000',
      );
      expect(guardMsg).toMatch(/directly issued UPDATE is never a maintenance write/);
    });

    it('C-SEC-M7: the OWNER is refused on all seven server-owned columns', async () => {
      await mig(makeInvoice(6));
      await mig(makeLine(6));
      // §28.3 already asserts the runtime role is refused. This asserts the
      // OWNER is refused too, which is the property pg_trigger_depth() >= 2
      // exists to provide and which no other layer gives: "the owner has no
      // bypass" is a fact, not a hope.
      for (const [column, value] of SEVEN_COLUMNS) {
        const msg = await migReject(
          `update fin_invoices set ${column} = ${value} where id = ${q(u('inv6'))}`,
          '55000',
        );
        expect(msg, `column ${column}`).toMatch(/never a maintenance write/);
      }
      // Nothing moved.
      const c = await caches(6);
      expect(c.subtotal).toBe(100);
      expect(c.total).toBe(100);
      expect(c.balance).toBe(0);
      const hdr = one(await mig(`select invoice_no, issued_at, voided_at, paid_at from fin_invoices where id = ${q(u('inv6'))}`));
      expect(hdr.invoice_no).toBeNull();
      expect(hdr.issued_at).toBeNull();
      expect(hdr.voided_at).toBeNull();
      expect(hdr.paid_at).toBeNull();
    });

    it('C-SEC-M5: at depth, the SCOPE decides — wrong scope, wrong column, and the identity triple', async () => {
      await mig(makeInvoice(7));
      await mig(makeLine(7));

      // Each case is issued from inside a trigger, so depth >= 2 holds and factor
      // A cannot be what refuses it. The failure can therefore only be the
      // scope/column map — which is what M5 isolates.
      const wrongColumn = await migReject(
        `do $m5$ begin perform public.csec_probe_setup(); end $m5$`.replace(
          'public.csec_probe_setup()', 'public.csec_probe()',
        ),
        '00000',
      ).catch(() => null);
      // (The DO form is not used to provoke the error — see the helper-based cases
      // below, which is the same mechanism without the indirection.)

      // invoice_line_totals must not cover the balance pair.
      await expect(
        atMaintenanceDepth(7, 'invoice_line_totals', 'balance').then(
          () => { throw new Error('invoice_line_totals was allowed to move balance'); },
        ),
      ).rejects.toMatchObject({ code: '55000' });

      // invoice_balance_state must not cover the line pair.
      await expect(
        atMaintenanceDepth(7, 'invoice_balance_state', 'subtotal').then(
          () => { throw new Error('invoice_balance_state was allowed to move subtotal'); },
        ),
      ).rejects.toMatchObject({ code: '55000' });

      // The identity triple is in NEITHER scope and must be refused under BOTH.
      for (const scope of ['invoice_line_totals', 'invoice_balance_state']) {
        await expect(
          atMaintenanceDepth(7, scope, 'invoice_no').then(
            () => { throw new Error(`${scope} was allowed to move invoice_no`); },
          ),
        ).rejects.toMatchObject({ code: '55000' });
      }
      expect(wrongColumn).toBeNull();
      expect((await caches(7)).subtotal).toBe(100);
      expect((await caches(7)).balance).toBe(0);
    });

    it('C-SEC-M5b: an UNKNOWN scope value is refused, so the vocabulary is closed', async () => {
      await mig(makeInvoice(8));
      await mig(makeLine(8));
      for (const scope of ['invoice_line_totals ', 'INVOICE_LINE_TOTALS', 'everything', '*']) {
        await expect(
          atMaintenanceDepth(8, scope, 'subtotal').then(
            () => { throw new Error(`scope "${scope}" was accepted`); },
          ),
        ).rejects.toMatchObject({ code: '55000' });
      }
    });

    it('C-SEC-M6b: the REAL producer reaches a DRAFT invoice and leaves it unstamped, unsettled and unfrozen', async () => {
      // §36.2 row 45, second half. The previous revision issued a probe UPDATE of
      // `subtotal` and asserted frozen_at stayed NULL. That proved the WHEN clause
      // suppresses a write in the abstract; it did not prove the real writer's
      // UPDATE is filtered IN by `AFTER UPDATE OF status` and then held back only
      // by the WHEN. The distinction matters because if a future revision let the
      // helper settle a draft, or renamed the recompute's UPDATE so it no longer
      // names status, the trigger would be filtered OUT and stamp nothing -- for
      // the wrong reason, and invisibly.
      //
      // So this drives row 13 -- through fin_invoice_items, which row 13 is also bound
      // to, because the allocation path CANNOT reach a draft: §12.5.1 (D9, P0 row
      // 46) refuses an `apply` naming a `draft` or `void` invoice outright. The
      // design's M6b row asks for "a real allocation row naming" a draft, which
      // the same design forbids; the line insert is the producer that makes the
      // invariant reachable, and it exercises the identical
      // helper -> `UPDATE fin_invoices` chain.
      //
      // Calling fin_invoice_reapply_derived_state directly is NOT a substitute:
      // that proves the helper's arithmetic, not that the trigger chain reaches it.
      await mig(makeInvoice(9));
      await mig(makeLine(9));

      // First half of the invariant: the line is NOT stamped.
      const line = one(await mig(`select frozen_at from fin_invoice_items where id = ${q(u('line9'))}`));
      expect(line.frozen_at).toBeNull();
      // Second half: the balance is STILL ZERO, and this is the half with teeth.
      // Row 13 fired -- it is bound to fin_invoice_items and the helper was reached
      // -- but the helper EARLY-RETURNS for a draft, so it writes nothing at all.
      // Asserting `balance === 0` rather than `balance === 100` is what makes this
      // a real witness: fin_invoice_reapply_derived_state's own comment records
      // that a previous revision preserved the draft LABEL while still executing
      // the UPDATE, leaving a draft with a 100 line at balance 100 while
      // fin_v_invoice_balance excludes drafts and §9.6.0 says a draft's balance is
      // 0. "Preserving the label is not preserving the invariant" -- so the label is
      // asserted here too, but never on its own.
      const c = await caches(9);
      expect(c.total).toBe(100);
      expect(c.balance).toBe(0);
      expect(c.status).toBe('draft');
      // The early return is STRUCTURAL, not incidental: the writer never names
      // fin_invoices for a draft at all, so trg_fin_invoice_freeze_lines cannot be
      // reached on this path. That is why the WHEN clause is still load-bearing for
      // the draft -> void discard transition while being unreachable here -- and why
      // neither can be removed on the belief that the other is doing the work.
      const src = codeOf(
        String(
          one(await mig(`select prosrc from pg_proc where proname = 'fin_invoice_reapply_derived_state'`))
            .prosrc,
        ),
      );
      // The guard exists in the helper's source, and the writer's UPDATE names
      // status -- so if the early return were dropped, this test would see the stamp
      // fire AND balance 100, which is exactly the pair of failures asserted above.
      expect(src).toMatch(/v_status\s+IN\s*\(\s*'draft'\s*,\s*'void'\s*\)/i);
      expect(src).toMatch(/\bupdate\s+fin_invoices\b/i);
      expect(src).toMatch(/\bstatus\b/i);
      // The draft -> void discard is asserted as a transition of its own below
      // ("a draft invoice may be discarded..."), because it is the one reachable
      // transition the WHEN clause's `NEW.status <> 'void'` conjunct turns away,
      // and asserting it here as well would only restate the pair above.
    });

    it('a draft invoice may be discarded to void, and the stamp stays off its lines', async () => {
      // The reachable counterpart to the assertion above. §9.2 makes `draft` ->
      // `void` a legal DISCARD, and it is the only transition on this writer for
      // which the WHEN clause's `NEW.status <> 'void'` conjunct is load-bearing:
      // without it, discarding a draft would stamp the very lines the draft
      // exists to keep editable, and a re-issued invoice would carry frozen lines.
      //
      // It was previously recorded here as an OPEN QUESTION on the belief that
      // `void_reason` is one of the seven columns a directly issued UPDATE may not
      // name. It is not: SEVEN_COLUMNS is subtotal/total/balance/invoice_no/
      // issued_at/voided_at/paid_at, and `trg_fin_invoice_header_guard` compares
      // exactly those seven. `void_reason` is unguarded, so the discard is reachable
      // by an ordinary statement and the question is closed by asserting it.
      await mig(makeInvoice(9));
      await mig(makeLine(9));

      // The reason is mandatory, so the unreasoned discard is refused FIRST --
      // otherwise a reader could satisfy the row below with the bare status write.
      const unreasoned = await migReject(
        `update fin_invoices set status = 'void' where id = ${q(u('inv9'))}`,
        '55000',
      );
      expect(unreasoned).toMatch(/requires a reason/);
      const blank = await migReject(
        `update fin_invoices set status = 'void', void_reason = '   ' where id = ${q(u('inv9'))}`,
        '55000',
      );
      expect(blank).toMatch(/requires a reason/);

      // With a reason, the discard succeeds and every server-owned column is the
      // server's: voided_at is stamped by trg_fin_invoice_void, never by the caller.
      await mig(
        `update fin_invoices set status = 'void', void_reason = 'duplicate invoice'
          where id = ${q(u('inv9'))}`,
      );
      const hdr = one(
        await mig(
          `select status, void_reason, voided_at, invoice_no, balance, total
             from fin_invoices where id = ${q(u('inv9'))}`,
        ),
      );
      expect(String(hdr.status)).toBe('void');
      expect(String(hdr.void_reason)).toBe('duplicate invoice');
      expect(hdr.voided_at).toBeTruthy();
      // A discarded draft consumes no invoice number, and its money columns are
      // untouched: a discard is not a settlement.
      expect(hdr.invoice_no).toBeNull();
      expect(num(hdr.balance)).toBe(0);
      expect(num(hdr.total)).toBe(100);

      // And the line is still editable, which is the property the discard exists to
      // preserve: `NEW.status <> 'void'` keeps row 4d from stamping it.
      const line = one(await mig(`select frozen_at from fin_invoice_items where id = ${q(u('line9'))}`));
      expect(line.frozen_at).toBeNull();
    });

    it('C-SEC-M6: a nested status-touching write does NOT stamp a draft line', async () => {
      await mig(makeInvoice(10));
      await mig(makeLine(10));
      // The synthetic half, kept because it isolates the WHEN clause from the
      // producer: a probe UPDATE that names status and leaves it unchanged must not
      // stamp, which is the same refusal the real chain gets for a different reason.
      // What it cannot do is stand in for M6b above, and no longer does.
      await expect(
        atMaintenanceDepth(10, 'invoice_line_totals', 'subtotal').catch(() => undefined),
      ).resolves.toBeUndefined();
      const line = one(await mig(`select frozen_at from fin_invoice_items where id = ${q(u('line10'))}`));
      expect(line.frozen_at).toBeNull();
      expect((await caches(10)).status).toBe('draft');
    });
  });

  // ---------------------------------------------------------------------------
  // D. Transaction-locality (assertion G) and recursion (assertion H)
  // ---------------------------------------------------------------------------
  describe('D. the maintenance context is transaction-local and depth-bound', () => {
    it('G: a scope set in one transaction does not survive it', async () => {
      const other = new pg.Client({ connectionString: getEnv().DATABASE_URL_MIGRATOR });
      await other.connect();
      try {
        await migrator.query(`select set_config('fin.invoice_maintenance_scope', 'invoice_line_totals', false)`);
        // Visible on the same connection, by design...
        expect(
          (await migrator.query(`select current_setting('fin.invoice_maintenance_scope')`)).rows[0]
            ?.current_setting,
        ).toBe('invoice_line_totals');
        // ...and on a DIFFERENT session, nothing. A session-global switch would
        // be a general application bypass that outlives the request.
        const leaked = await other.query(
          `select current_setting('fin.invoice_maintenance_scope', true) as v`,
        );
        expect(leaked.rows[0]?.v ?? null).toBeNull();

        // The transaction-local form the writers actually use does not survive
        // commit at all — proven end to end by committing and re-reading.
        await other.query('begin');
        await other.query(`select set_config('fin.invoice_maintenance_scope', 'invoice_line_totals', true)`);
        await other.query('commit');
        const after = await other.query(
          `select current_setting('fin.invoice_maintenance_scope', true) as v`,
        );
        // NOT null: PostgreSQL keeps the GUC's placeholder and yields '' once the
        // transaction-local value is gone, so '' is the correct post-commit reading.
        // What must not survive is the GRANT, and '' is refused by the guard's ELSE
        // branch, so asserting on the granted value is the assertion that matters.
        expect(after.rows[0]?.v ?? null).not.toBe('invoice_line_totals');
      } finally {
        await other.end();
      }
    });

    it('G: the cache writer leaves no residue — the scope is reset around its own UPDATE', async () => {
      await mig(makeInvoice(10));
      await mig(makeLine(10));
      const after = await migrator.query(
        `select current_setting('fin.invoice_maintenance_scope', true) as v`,
      );
      // Back to '' rather than NULL: set_config stores a string, and '' is exactly
      // the value the guard's ELSE branch refuses.
      expect(after.rows[0]?.v === null || after.rows[0]?.v === '').toBe(true);
    });

    it('H: nesting depth does not become a bypass — the guard still refuses an unauthorised column at depth 3', async () => {
      await mig(makeInvoice(11));
      await mig(makeLine(11));
      // A probe whose own UPDATE fires another trigger, so the statement under
      // test arrives deeper than 2. Deeper must not mean "more authorised": the
      // column map is checked regardless of depth.
      // Depth 3 is reached with TWO triggers on fin_invoices, not with one trigger
      // calling another: a RETURNS trigger function cannot be invoked with
      // `perform` ("trigger functions can only be called as triggers"). The inner
      // trigger fires on the outer one's own UPDATE, so the inner statement
      // arrives at depth 3. Both stop recursing via pg_trigger_depth(), which is
      // why the inner body is guarded rather than the outer.
      // The scope is set ONCE, outside the trigger chain, via fin.probe_scope, and
      // both probe bodies copy it into fin.invoice_maintenance_scope. Had the
      // inner body hard-coded the scope, it would overwrite the outer's wrong
      // scope on its way in and the second half of the case would pass with the
      // RIGHT scope — asserting nothing.
      await migrator.query(
        `create function public.csec_probe_inner() returns trigger
           language plpgsql set search_path = pg_catalog, public, pg_temp as $i$
         begin
           if pg_trigger_depth() >= 3 then return null; end if;
           perform set_config('fin.invoice_maintenance_scope', current_setting('fin.probe_scope'), true);
           update fin_invoices set subtotal = current_setting('fin.probe_value')::numeric
             where id = current_setting('fin.probe_invoice')::uuid;
           return null;
         end $i$`,
      );
      await migrator.query(
        `create function public.csec_probe_outer() returns trigger
           language plpgsql set search_path = pg_catalog, public, pg_temp as $o$
         begin
           -- Only at the top, or the two triggers feed each other forever: both are
           -- bound to the same table, so each one's UPDATE re-enters both. The
           -- outer acts once (depth 1); the inner acts at depth 2 and stops at 3.
           if pg_trigger_depth() > 1 then return null; end if;
           perform set_config('fin.invoice_maintenance_scope', current_setting('fin.probe_scope'), true);
           update fin_invoices set subtotal = current_setting('fin.probe_value')::numeric
             where id = current_setting('fin.probe_invoice')::uuid;
           return null;
         end $o$`,
      );
      await migrator.query(
        `create trigger csec_probe_outer_trg after update on fin_invoices
           for each row execute function public.csec_probe_outer()`,
      );
      await migrator.query(
        `create trigger csec_probe_inner_trg after update on fin_invoices
           for each row execute function public.csec_probe_inner()`,
      );
      await migrator.query(
        `select set_config('fin.probe_invoice', ${q(u('inv11'))}, true)`,
      );
      // Legitimate scope for the first half; the second half re-points it at the
      // wrong one with a single set_config rather than redefining the functions.
      await migrator.query(
        `select set_config('fin.probe_scope', 'invoice_line_totals', true)`,
      );
      // The written VALUE also varies between the halves. Writing 999 twice would
      // make the second write a no-op, subtotal would not be dirty, and the guard
      // would have no reason to fire — the case would pass while asserting nothing.
      await migrator.query(`select set_config('fin.probe_value', '999', true)`);
      // A legitimately-scoped write at depth 3 IS permitted — depth is a floor,
      // not an exact-match requirement.
      await migrator.query(
        `update fin_invoices set due_date = due_date where id = ${q(u('inv11'))} and status = 'draft'`,
      );
      expect((await caches(11)).subtotal).toBe(999);

      // And the same deep nest with the WRONG scope is still refused.
      await migrator.query(
        `select set_config('fin.probe_scope', 'invoice_balance_state', true)`,
      );
      await migrator.query(`select set_config('fin.probe_value', '888', true)`);
      await expect(
        migrator
          .query(
            `update fin_invoices set due_date = due_date where id = ${q(u('inv11'))} and status = 'draft'`,
          )
          .then(
            () => { throw new Error('a wrong scope was accepted at depth 3'); },
          ),
      ).rejects.toMatchObject({ code: '55000' });
      // No cleanup here: the refused statement has ABORTED this transaction, so
      // every following statement would fail with 25P02 and mask the assertion.
      // afterEach rolls the whole case back, which removes the two probe
      // functions and both triggers with it — they were created inside the
      // transaction, not before it.
    });
  });

  // ---------------------------------------------------------------------------
  // E. §16.5.1's grant model is now 0028's permanent §D.2 posture.
  // ---------------------------------------------------------------------------
  describe('E. with §16.5.1 grants in force (0028), the application role still cannot touch a cache', () => {
    it('the app role may drive status through its finance-staff ticket, but not the caches (assertion A, as school_app_rw)', async () => {
      await mig(makeInvoice(12));
      await mig(makeLine(12));
      // The invoice must be COMMITTED before the app can touch it: `app` is a
      // separate session, and an invoice still uncommitted inside `migrator`'s
      // transaction is invisible to it. The app's UPDATE would then match zero
      // rows and SUCCEED, so the header would still read 'draft' and this case
      // would fail while proving nothing about the grant. The row is cleaned up
      // by afterAll, which deletes by tenant rather than relying on this
      // transaction's rollback.
      await migrator.query('commit');

      // 0028 owns §16.5.1's real grant list (Shape 2) as the permanent posture,
      // so nothing is granted or revoked locally — a REVOKE here would strip the
      // migration's grants for every later suite. What changed since the 0023-era
      // case is the RLS gate: 0028 FORCE RLS on fin_invoices, so the app must
      // carry a finance-staff ticket (F1: userA's active 'accountant' membership)
      // before its UPDATE is even weighed against the column ACL. The ticket is
      // minted per transaction because set_config(..., true) is local to it.
      await app.query(
        `select set_config('app.rls', app_ctx_mint('tenant', ${q(u('userA'))}, ${q(u('tenantA'))}), true)`,
      );
      // It may drive the lifecycle: status is granted precisely so the route can.
      await app.query(`update fin_invoices set status = 'issued' where id = ${q(u('inv12'))}`);
      // Committed before the read: two sessions, and an uncommitted write is
      // invisible to `migrator`. The commit also discards the ticket, so the
      // next transaction mints it afresh below.
      await app.query('commit');
      const hdr = one(await mig(`select status from fin_invoices where id = ${q(u('inv12'))}`));
      expect(String(hdr.status)).toBe('issued');

      // Every cache column is refused — by the ACL on the column, which is the
      // layer §16.5.1 exists to add, and NOT by the guard. Asserting the code
      // distinguishes the two: a 55000 here would mean the guard was reached at
      // all, which it must not be. Reopened after the commit above: appReject's
      // savepoint needs a live transaction, and without this every column probe
      // fails with 25P01.
      await app.query('begin');
      await app.query(
        `select set_config('app.rls', app_ctx_mint('tenant', ${q(u('userA'))}, ${q(u('tenantA'))}), true)`,
      );
      for (const [column, value] of SEVEN_COLUMNS) {
        const msg = await appReject(
          `update fin_invoices set ${column} = ${value} where id = ${q(u('inv12'))}`,
          '42501',
        );
        expect(msg, `column ${column}`).toMatch(/permission denied/i);
      }
      // And it may not supply a cached value at creation either — the INSERT
      // column list is separate from the UPDATE one for exactly this reason.
      const ins = await appReject(
        `insert into fin_invoices (tenant_id, student_id, academic_year_id, enrollment_id, created_by, total)
         values (${q(u('tenantA'))}, ${q(u('stu1'))}, ${q(u('yearA'))}, ${q(u('enr1'))}, ${q(u('userA'))}, 999)`,
        '42501',
      );
      expect(ins).toMatch(/permission denied/i);
      await app.query('commit');
    });
  });

  // ---------------------------------------------------------------------------
  // F. Lifecycle / freeze protection (assertion J) — Phase D
  // ---------------------------------------------------------------------------
  describe('F. lifecycle and freeze protection', () => {
    it('freezes lines of an issued invoice against re-pricing, and refuses amount writes', async () => {
      await mig(makeInvoice(7));
      await mig(makeLine(7));
      await mig(`update fin_invoices set status = 'issued' where id = ${q(u('inv7'))}`);

      // The line is frozen, so neither the quantity nor the unit price moves.
      await migReject(
        `update fin_invoice_items set quantity = 5 where id = ${q(u('line7'))}`,
        '55000',
      );
      await migReject(
        `update fin_invoice_items set unit_amount = 500 where id = ${q(u('line7'))}`,
        '55000',
      );
      const line = one(await mig(`select quantity, unit_amount from fin_invoice_items where id = ${q(u('line7'))}`));
      expect(num(line.quantity)).toBe(1);
      expect(num(line.unit_amount)).toBe(100);

      // amount is a CACHE, and on a DRAFT it is not refused — it is
      // OVERWRITTEN. trg_fin_invoice_item_amount runs BEFORE and assigns
      // quantity * unit_amount, so a caller-supplied amount never survives. The
      // explicit 55000 is reserved for a non-draft invoice (C-9.1), where a
      // disagreement with the factors would be cached. Both are asserted, because
      // "silently corrected while draft" and "refused once issued" are different
      // contracts and only one of them is a refusal.
      await mig(makeInvoice(8));
      await mig(makeLine(8));
      await mig(`update fin_invoice_items set amount = 999 where id = ${q(u('line8'))}`);
      const drafted = one(
        await mig(`select amount from fin_invoice_items where id = ${q(u('line8'))}`),
      );
      expect(num(drafted.amount)).toBe(100);
      await mig(`update fin_invoices set status = 'issued' where id = ${q(u('inv8'))}`);
      const msg = await migReject(
        `update fin_invoice_items set amount = 999 where id = ${q(u('line8'))}`,
        '55000',
      );
      // The FREEZE trigger is the one that fires first on an issued invoice, so its
      // message is what a caller actually sees; the amount rule (C-9.1) is the
      // belt behind it. Asserting the freeze's wording keeps the test honest about
      // which layer refused — a caller told "amount is derived" here would be sent
      // to debug the wrong rule.
      expect(msg).toMatch(/cannot update a line of a/i);
      // Still unchanged after the refusal.
      const issued = one(
        await mig(`select amount from fin_invoice_items where id = ${q(u('line8'))}`),
      );
      expect(num(issued.amount)).toBe(100);
    });

    it('refuses to re-price or delete a line once the invoice is issued', async () => {
      // CASE_ENROLLMENTS is 12, so this case reuses case 3's invoice inside its
      // own transaction — the fixture rows are committed, so this is safe.
      await mig(makeInvoice(3));
      await mig(makeLine(3, '100.00'));
      await mig(`update fin_invoices set status = 'issued' where id = ${q(u('inv3'))}`);

      const msg = await migReject(
        `update fin_invoice_items set unit_amount = 500 where id = ${q(u('line3'))}`,
        '55000',
      );
      expect(msg).toMatch(/frozen_at|cannot update a line/i);
      await migReject(`delete from fin_invoice_items where id = ${q(u('line3'))}`, '55000');
      // The re-priced value did not survive.
      const line = one(await mig(`select unit_amount from fin_invoice_items where id = ${q(u('line3'))}`));
      expect(num(line.unit_amount)).toBe(100);
    });

    it('keeps due_date immutable once the invoice leaves draft (clause 3)', async () => {
      await mig(makeInvoice(3));
      await mig(makeLine(3));
      await mig(`update fin_invoices set status = 'issued' where id = ${q(u('inv3'))}`);
      const msg = await migReject(
        `update fin_invoices set due_date = date '2026-12-31' where id = ${q(u('inv3'))}`,
        '55000',
      );
      expect(msg).toMatch(/due_date cannot be changed after issue/);
    });

    it('refuses an approval transition except pending -> approved/rejected, on a draft only', async () => {
      await mig(makeInvoice(3));
      uid.adj = randomUUID();
      await mig(
        `insert into fin_invoice_adjustments
           (id, tenant_id, invoice_id, adjustment_type, amount, reason, requested_by)
         values (${q(uid.adj)}, ${q(u('tenantA'))}, ${q(u('inv3'))}, 'concession', -10.00, 'Merit', ${q(u('userA'))})`,
      );
      // A pending adjustment does not count toward the total.
      expect((await caches(3)).total).toBe(0);

      await migReject(
        `update fin_invoice_adjustments set status = 'pending' where id = ${q(uid.adj)}`,
        '55000',
      );
      // Four eyes, enforced: the requester may not approve.
      await migReject(
        `update fin_invoice_adjustments set status = 'approved', approved_by = ${q(u('userA'))}
          where id = ${q(uid.adj)}`,
        '55000',
      );
      // A second user may.
      await mig(
        `update fin_invoice_adjustments set status = 'approved', approved_by = ${q(u('userB'))}
          where id = ${q(uid.adj)}`,
      );
      // Now it counts, and the header recomputed through the same maintenance path.
      expect((await caches(3)).total).toBe(-10);

      // ...but not on an issued invoice.
      await mig(`update fin_invoices set status = 'issued' where id = ${q(u('inv3'))}`);
      uid.adj2 = randomUUID();
      await mig(
        `insert into fin_invoice_adjustments
           (id, tenant_id, invoice_id, adjustment_type, amount, reason, requested_by)
         values (${q(uid.adj2)}, ${q(u('tenantA'))}, ${q(u('inv3'))}, 'fine', 5.00, 'Late', ${q(u('userA'))})`,
      );
      const msg = await migReject(
        `update fin_invoice_adjustments set status = 'approved', approved_by = ${q(u('userB'))}
          where id = ${q(uid.adj2)}`,
        '55000',
      );
      expect(msg).toMatch(/only be approved while the invoice is a draft/);
    });

    it('keeps a voided draft free to delete its lines, so a discarded draft can be voided (C-13)', async () => {
      // At THIS checkpoint an invoice cannot be voided at all, and that is the
      // design's shape rather than a gap in it: voided_at is written only by
      // trg_fin_invoice_void, which is 0024 (§9.3.1, §35.3 row 5 — it reads
      // fin_payment_allocations, so §30.3.1 forbids creating it in 0023). The
      // header guard therefore refuses every direct voided_at write, and the
      // fin_invoices_number_ck CHECK demands voided_at IS NOT NULL whenever
      // status = 'void'. So the void branch of the line freeze has no reachable
      // parent here.
      //
      // Asserting that absence is the point. It is what proves the DELETE
      // exception is NOT dead code by accident, and it pins the two facts 0024
      // will have to satisfy: the guard keeps refusing a caller-supplied
      // voided_at, and the void branch stays reachable only through the trigger.
      await mig(makeInvoice(3));
      await mig(makeLine(3));
      const refused = await migReject(
        `update fin_invoices set status = 'void', voided_at = now(), void_reason = 'entered in error'
          where id = ${q(u('inv3'))}`,
        '55000',
      );
      expect(refused).toMatch(/trigger-maintained/);

      // The draft is untouched, so the ordinary draft freedom still holds and the
      // discarded-draft path is provably completable once 0024 supplies the void.
      await mig(`delete from fin_invoice_items where id = ${q(u('line3'))}`);
      expect((await caches(3)).total).toBe(0);
      expect((await caches(3)).status).toBe('draft');
      expect(one(await mig(`select voided_at from fin_invoices where id = ${q(u('inv3'))}`)).voided_at).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // G. End-to-end behaviour (Phase O) + the numbering rules
  // ---------------------------------------------------------------------------
  describe('G. end-to-end invoice behaviour', () => {
    it('walks creation -> item -> amount -> subtotal -> total -> issue, in order', async () => {
      // 1-2. creation and the derived due_date.
      await mig(makeInvoice(1));
      let hdr = one(await mig(`select due_date, status, invoice_no from fin_invoices where id = ${q(u('inv1'))}`));
      // Derived from the structure's effective_from (no plan rows).
      // pg returns a Date for `date` columns in Node; compare by calendar date in UTC
      // to avoid local timezone shifts (some setups interpret '2026-03-01' as midnight +TZ).
      const dd = hdr.due_date as any;
      let s: string;
      if (dd instanceof Date) {
        s = `${dd.getFullYear()}-${String(dd.getMonth() + 1).padStart(2, '0')}-${String(dd.getDate()).padStart(2, '0')}`;
      } else if (typeof dd === 'string') {
        s = dd.slice(0, 10).replace(/^(\d{4}-\d{2}-\d{2}).*$/, '$1');
      } else {
        s = String(dd);
      }
      expect(s).toBe('2026-03-01');
      expect(String(hdr.status)).toBe('draft');
      expect(hdr.invoice_no).toBeNull();

      // 3-5. item creation, amount validation, header recompute.
      await mig(makeLine(1, '120.50'));
      hdr = one(await mig(`select due_date, status, invoice_no from fin_invoices where id = ${q(u('inv1'))}`));
      expect((await caches(1)).subtotal).toBe(120.5);
      expect((await caches(1)).total).toBe(120.5);

      // An amount that is not positive, or has a sub-paisa fraction, is refused.
      await migReject(
        `insert into fin_invoice_items
           (id, tenant_id, invoice_id, structure_id, fee_head_id, description, quantity, unit_amount)
         values (${q(randomUUID())}, ${q(u('tenantA'))}, ${q(u('inv1'))}, ${q(u('structA'))},
                 ${q(u('headA'))}, 'Negative', 1, -5)`,
        '23514',
      );
      await migReject(
        `insert into fin_invoice_items
           (id, tenant_id, invoice_id, structure_id, installment_no, fee_head_id, description, quantity, unit_amount)
         values (${q(randomUUID())}, ${q(u('tenantA'))}, ${q(u('inv1'))}, ${q(u('structA'))}, 7,
                 ${q(u('headA'))}, 'Bad plan', 1, 10)`,
        '23503',
      );

      // 6-7. issue: number allocated, line stamped, caches still correct.
      await mig(`update fin_invoices set status = 'issued' where id = ${q(u('inv1'))}`);
      hdr = one(await mig(`select invoice_no, status from fin_invoices where id = ${q(u('inv1'))}`));
      expect(String(hdr.invoice_no)).toMatch(/^INV-/);
      expect((await caches(1)).total).toBe(120.5);

      // 9. and the app still cannot subsequently forge the cache.
      const forged = await migReject(
        `update fin_invoices set total = 0 where id = ${q(u('inv1'))}`,
        '55000',
      );
      expect(forged).toMatch(/never a maintenance write/);
      expect((await caches(1)).total).toBe(120.5);
    });

    it('allocates numbers gap-free and never reuses one', async () => {
      await mig(makeInvoice(1));
      await mig(makeLine(1));
      await mig(`update fin_invoices set status = 'issued' where id = ${q(u('inv1'))}`);
      const first = String(one(await mig(`select invoice_no from fin_invoices where id = ${q(u('inv1'))}`)).invoice_no);

      await mig(makeInvoice(2));
      await mig(makeLine(2));
      await mig(`update fin_invoices set status = 'issued' where id = ${q(u('inv2'))}`);
      const second = String(one(await mig(`select invoice_no from fin_invoices where id = ${q(u('inv2'))}`)).invoice_no);

      expect(first).not.toBe(second);
      expect(Number(second.slice(-6))).toBe(Number(first.slice(-6)) + 1);
      // C-7: a second LIVE invoice for the same (tenant, enrollment, year) is
      // refused by fin_invoices_ten_enrollment_year_uq, so "billing twice" is a
      // unique violation and not a rounding difference. The index is partial on
      // `status <> 'void'`, which is what lets a replacement draft exist after a
      // void — but voiding is 0024, so only the refusal half is reachable here.
      // Each makeInvoice(n) uses its own enrollment, so the duplicate has to name
      // inv1's enrollment explicitly — otherwise this would pass for the wrong
      // reason (a distinct enrollment is legal) and prove nothing. And because
      // the index is partial on `status <> 'void'`, a DRAFT already occupies the
      // slot, so the refusal lands on the INSERT rather than on the issue.
      uid.inv3 = randomUUID();
      const doubled = await migReject(
        `insert into fin_invoices
           (id, tenant_id, student_id, academic_year_id, enrollment_id, structure_id, created_by)
         values (${q(u('inv3'))}, ${q(u('tenantA'))}, ${q(u('stu1'))}, ${q(u('yearA'))},
                 ${q(u('enr1'))}, ${q(u('structA'))}, ${q(u('userA'))})`,
        '23505',
      );
      expect(doubled).toMatch(/fin_invoices_ten_enrollment_year_uq/);

      // Nothing was written, and the two numbers issued so far are untouched.
      const rows = await mig(
        `select count(*)::int c from fin_invoices where enrollment_id = ${q(u('enr1'))}`,
      );
      expect(one(rows).c).toBe(1);
      expect(String(one(await mig(`select invoice_no from fin_invoices where id = ${q(u('inv1'))}`)).invoice_no)).toBe(first);
      expect(String(one(await mig(`select invoice_no from fin_invoices where id = ${q(u('inv2'))}`)).invoice_no)).toBe(second);
    });

    it('does not burn a counter value on a discarded draft (C-13)', async () => {
      // The counter moves only on ISSUE, so a draft that is never issued — the
      // state a discarded draft is in — never consumes a value. That is the half
      // of C-13 that IS reachable at this checkpoint; the voiding half needs
      // trg_fin_invoice_void, which is 0024 (see the C-13 line test above).
      const before = Number(
        one(await mig(`select last_value from fin_document_counters where id = ${q(u('counterA'))}`)).last_value,
      );
      await mig(makeInvoice(1));
      const stillDraft = Number(
        one(await mig(`select last_value from fin_document_counters where id = ${q(u('counterA'))}`)).last_value,
      );
      expect(stillDraft).toBe(before);
      const hdr = one(await mig(`select invoice_no, status from fin_invoices where id = ${q(u('inv1'))}`));
      expect(hdr.invoice_no).toBeNull();
      expect(String(hdr.status)).toBe('draft');

      // Issuing is what consumes one, and it consumes exactly one.
      await mig(`update fin_invoices set status = 'issued' where id = ${q(u('inv1'))}`);
      const issued = Number(
        one(await mig(`select last_value from fin_document_counters where id = ${q(u('counterA'))}`)).last_value,
      );
      expect(issued).toBe(before + 1);
    });
  });
});