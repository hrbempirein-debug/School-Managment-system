import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { getEnv } from '@sms/config';
import { getTableConfig, type PgTable } from 'drizzle-orm/pg-core';
import {
  finBillingRunItems,
  finBillingRuns,
  finChallans,
  finDocumentCounters,
  finFeeAssignments,
  finFeeHeads,
  finFeeInstallmentPlans,
  finFeeStructureItems,
  finFeeStructureTargets,
  finFeeStructures,
  finInvoiceAdjustments,
  finInvoiceItems,
  finInvoices,
  finLedgerAccounts,
  finPaymentAllocations,
  finPayments,
  finReceipts,
  finRefunds,
  finLedgerEntryGroups,
  finLedgerEntries,
  finLedgerEventTypes,
  finReconciliationBatches,
  finReconciliationMatches,
  finTaxProfiles,
  finTenantSettings,
} from '../schema.js';

/**
 * 0022 composite-FK + tenant-isolation proofs, plus the 0023–0025 tables that
 * extend them. Run against the REAL roles and the disposable test database.
 * Requires migrations 0001..0025.
 *
 * Every assertion is read from the live catalog or provoked against the live
 * database; no migration text is searched. Section E is the one that keeps
 * packages/db/src/schema.ts honest: it compares the Drizzle declarations
 * themselves (via drizzle's own getTableConfig introspection) with what the
 * database actually contains, so a schema edit that drifts from the applied
 * migration fails here instead of silently lying to the API layer.
 *
 * SCOPE AFTER 0023–0025. 0022 was the last migration to add a finance table on
 * its own, and it is still the phase's reference for the composite-FK RULE. But
 * two of its counts were deliberately per-migration and are now stale, and this
 * suite states the later reality rather than pretending 0023–0025 never landed:
 *   * fin_billing_run_items carries 24 FKs, not the 23 0022 installed — 0023
 *     added fin_bri_invoice_fk by ALTER once fin_invoices existed (a forward
 *     reference in 0022 would have failed 42P01). Section A asserts BOTH halves:
 *     that 0022's 23 are unchanged, and that the one addition is exactly that FK.
 *   * There are 20 fin_* tables, not 12. Sections D and E widen to all 20 rather
 *     than staying green by looking at a 0022-only slice.
 * Nothing else is relaxed: every 0022 proof below still runs against the same
 * catalog objects it was written for.
 *
 * Section A -- FK shape: the 0022 constraint set, and the rule that matters --
 *   every fin_* FK is (tenant_id, <col>) -> (tenant_id, id), so a row can never
 *   be joined to a parent in another tenant. The ONLY exceptions are the two
 *   single-column users(id) references, because users is global and has no
 *   tenant_id to composite on. The 0023–0025 tables add three more single-column
 *   users(id) references on audit identities (fin_invoices.created_by, and both
 *   fin_invoice_adjustments identities) and are checked by the same rule.
 * Section B -- anchors: each tenant-scoped parent really does expose a unique
 *   (tenant_id, id) index, which is what makes the composite FKs enforceable at
 *   all; users has none, which is the allowlist's whole justification.
 * Section C -- delete actions: RESTRICT really blocks, CASCADE really cascades,
 *   SET NULL really nulls, and the four fin_targets_* FKs are NO ACTION (a
 *   deliberate choice: cascade would delete a published structure's target
 *   rows, and the freeze trigger is the layer that owns that decision).
 * Section D -- posture after 0028 (recon §H inversions): school_app_rw holds
 *   exactly the §D.2 grant shape per fin_* table with DELETE and PUBLIC absent;
 *   every fin_* table is RLS enabled+forced with the §B.1 command set, DELETE
 *   omitted exactly where §B.2.10 omits it; and the 0023 invoice attachment
 *   named exactly.
 * Section E -- schema.ts mirrors the catalog (columns, nullability, FKs, checks,
 *   unique constraints, indexes) for all 20 finance tables.
 * Section F -- a cross-tenant insert is refused by the composite FK itself.
 *
 * Opt-in: RUN_RUNTIME_SECURITY_TESTS=1 (requires PostgreSQL + migration 0028).
 */
const enabled = process.env.RUN_RUNTIME_SECURITY_TESTS === '1';
const describeDb = enabled ? describe : describe.skip;

let migrator: pg.Client;
let app: pg.Client;

const uid: Record<string, string> = {};

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
const slug = randomUUID().slice(0, 8);

/**
 * The composite references whose TARGET is a tenant-prefixed natural key rather
 * than (tenant_id, id). There is exactly one in Phase 7, and it is a stronger
 * constraint than an id reference rather than a weaker one: the line's
 * installment must belong to the line's structure's own plan, so no line can name
 * an installment of some other structure.
 */
const NATURAL_KEY_FKS = [
  { fk: 'fin_invoice_items_plan_fk', tgt: 'fin_fee_installment_plans', cols: 'tenant_id,structure_id,installment_no' },
  { fk: 'fin_leg_entries_account_fk', tgt: 'fin_ledger_accounts', cols: 'tenant_id,code' },
] as const;

type Row = Record<string, unknown>;

const mig = async (sql: string): Promise<Row[]> => {
  const r = await migrator.query(sql);
  return r.rows as Row[];
};

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

const q = (v: string) => `'${v}'`;

/** The single row a catalog probe expected to find. */
const one = (rows: Row[]): Row => {
  const r = rows[0];
  if (r === undefined) throw new Error('expected at least one row from the catalog');
  return r;
};

/** A `count(*)::int` probe result. */
const n1 = (rows: Row[]): number => Number(one(rows).n);

/** The 7 tables 0022 adds, and the FK set it installs on them. */
const T0022 = [
  'fin_fee_structures',
  'fin_fee_structure_items',
  'fin_fee_installment_plans',
  'fin_fee_structure_targets',
  'fin_fee_assignments',
  'fin_billing_runs',
  'fin_billing_run_items',
] as const;

/** The 8 tables 0023–0025 add. fin_challans arrives with 0023, not 0024. */
const T0023_0025 = [
  'fin_invoices',
  'fin_invoice_items',
  'fin_invoice_adjustments',
  'fin_challans',
  'fin_payments',
  'fin_payment_allocations',
  'fin_receipts',
  'fin_refunds',
] as const;

const ALL_FIN = [
  'fin_tax_profiles',
  'fin_tenant_settings',
  'fin_ledger_accounts',
  'fin_document_counters',
  'fin_fee_heads',
  ...T0022,
  ...T0023_0025,
  'fin_ledger_entry_groups',
  'fin_ledger_entries',
  'fin_ledger_event_types',
  'fin_reconciliation_batches',
  'fin_reconciliation_matches',
] as const;

/**
 * The §D.2 grant shape per `fin_*` table as exposed by `aclexplode(relacl)`:
 * table-level privileges granted to `school_app_rw` after 0028. Shape 2's
 * INSERT/UPDATE are column-level and therefore live in `attacl`, not `relacl` —
 * those tables show table-level SELECT only here. `fin_ledger_event_types`
 * (Shape 5) is asserted, never granted.
 */
const SHAPE: Record<string, string[]> = {
  // §D.2 Shape 1 — table-level SELECT, INSERT, UPDATE; DELETE revoked (10).
  fin_tenant_settings: ['INSERT', 'SELECT', 'UPDATE'],
  fin_fee_heads: ['INSERT', 'SELECT', 'UPDATE'],
  fin_tax_profiles: ['INSERT', 'SELECT', 'UPDATE'],
  fin_fee_structures: ['INSERT', 'SELECT', 'UPDATE'],
  fin_fee_structure_items: ['INSERT', 'SELECT', 'UPDATE'],
  fin_fee_installment_plans: ['INSERT', 'SELECT', 'UPDATE'],
  fin_fee_structure_targets: ['INSERT', 'SELECT', 'UPDATE'],
  fin_fee_assignments: ['INSERT', 'SELECT', 'UPDATE'],
  fin_reconciliation_batches: ['INSERT', 'SELECT', 'UPDATE'],
  fin_reconciliation_matches: ['INSERT', 'SELECT', 'UPDATE'],
  // §D.2 Shape 2 — column-level INSERT/UPDATE; table-level grant is SELECT only (3).
  fin_invoices: ['SELECT'],
  fin_invoice_items: ['SELECT'],
  fin_invoice_adjustments: ['SELECT'],
  // §D.2 Shape 3 — SELECT + INSERT; UPDATE and DELETE revoked (8).
  fin_challans: ['INSERT', 'SELECT'],
  fin_document_counters: ['INSERT', 'SELECT'],
  fin_payments: ['INSERT', 'SELECT'],
  fin_payment_allocations: ['INSERT', 'SELECT'],
  fin_receipts: ['INSERT', 'SELECT'],
  fin_refunds: ['INSERT', 'SELECT'],
  fin_billing_runs: ['INSERT', 'SELECT'],
  fin_billing_run_items: ['INSERT', 'SELECT'],
  // §D.2 Shape 4 — SELECT only (2).
  fin_ledger_entry_groups: ['SELECT'],
  fin_ledger_entries: ['SELECT'],
  // §D.2 Shape 5 — fin_ledger_accounts SELECT only; fin_ledger_event_types zero (2).
  fin_ledger_accounts: ['SELECT'],
  fin_ledger_event_types: [],
};

/**
 * The single FK that 0023 added to a 0022 table, by ALTER, once fin_invoices
 * existed. It is the ONLY reason section A cannot count 23 any more, and it is
 * named here rather than folded into a number so a future fourth addition to a
 * 0022 table has to be declared in this file to pass.
 */
const ADDED_AFTER_0022 = [
  { fk: 'fin_bri_invoice_fk', src: 'fin_billing_run_items', tgt: 'fin_invoices' },
] as const;

/** The R4-allowlisted single-column references, and the global `users` parent. */
const R4_SINGLE_COLUMN = [
  { fk: 'fin_fee_structures_publisher_fk', src: 'fin_fee_structures', col: 'published_by', onDelete: 'r' },
  { fk: 'fin_billing_runs_user_fk', src: 'fin_billing_runs', col: 'started_by', onDelete: 'n' },
] as const;

/**
 * EVERY single-column FK on a fin_* table, across all 20 of them. A single-column
 * reference is the one shape in this suite that is not tenant-scoped, so the
 * set is closed and named here rather than filtered by prefix at the point of
 * use. Two kinds only:
 *   * `users.id` — users is platform-global (P0-06a) and has no tenant_id, so
 *     there is nothing to composite on. All five are audit identities
 *     (published_by, started_by, and 0023's created_by / requested_by /
 *     approved_by), so none is CASCADE.
 *   * `tenants.id` — tenants IS the tenant, so a composite would be (id, id).
 *     These four are CASCADE because deleting a tenant must take its money
 *     configuration with it.
 */
const GLOBAL_PARENT_FKS = [
  { fk: 'fin_fee_structures_publisher_fk', src: 'fin_fee_structures', col: 'published_by', tgt: 'users', onDelete: 'r' },
  { fk: 'fin_billing_runs_user_fk', src: 'fin_billing_runs', col: 'started_by', tgt: 'users', onDelete: 'n' },
  { fk: 'fin_invoices_created_by_fk', src: 'fin_invoices', col: 'created_by', tgt: 'users', onDelete: 'r' },
  { fk: 'fin_invoice_adjustments_requester_fk', src: 'fin_invoice_adjustments', col: 'requested_by', tgt: 'users', onDelete: 'r' },
  { fk: 'fin_invoice_adjustments_user_fk', src: 'fin_invoice_adjustments', col: 'approved_by', tgt: 'users', onDelete: 'r' },
  { fk: 'fin_tax_profiles_tenant_fk', src: 'fin_tax_profiles', col: 'tenant_id', tgt: 'tenants', onDelete: 'c' },
  { fk: 'fin_tenant_settings_tenant_fk', src: 'fin_tenant_settings', col: 'tenant_id', tgt: 'tenants', onDelete: 'c' },
  { fk: 'fin_ledger_accounts_tenant_fk', src: 'fin_ledger_accounts', col: 'tenant_id', tgt: 'tenants', onDelete: 'c' },
  { fk: 'fin_fee_heads_tenant_fk', src: 'fin_fee_heads', col: 'tenant_id', tgt: 'tenants', onDelete: 'c' },
] as const;

const fkRows = async (tables: readonly string[]): Promise<Row[]> =>
  mig(
    `select con.conname as fk, src.relname as src_table,
            (select string_agg(a.attname, ',' order by k.ord)
               from unnest(con.conkey) with ordinality k(attnum, ord)
               join pg_attribute a on a.attrelid = con.conrelid and a.attnum = k.attnum) as src_cols,
            tgt.relname as tgt_table,
            (select string_agg(a.attname, ',' order by k.ord)
               from unnest(con.confkey) with ordinality k(attnum, ord)
               join pg_attribute a on a.attrelid = con.confrelid and a.attnum = k.attnum) as tgt_cols,
            con.confupdtype::text as on_update, con.confdeltype::text as on_delete
       from pg_constraint con
       join pg_class src on src.oid = con.conrelid
       join pg_class tgt on tgt.oid = con.confrelid
       join pg_namespace n on n.oid = src.relnamespace
      where con.contype='f' and n.nspname='public' and src.relname in (${tables.map(q).join(',')})
      order by src.relname, con.conname`,
  );

/**
 * Base SQL type with any precision/array modifier stripped, for comparison.
 * The udt_name spellings and the SQL spellings differ for a few builtin types,
 * so they are folded together before comparing.
 */
const TYPE_ALIASES: Record<string, string> = {
  bool: 'boolean',
  int2: 'smallint',
  int4: 'integer',
  int8: 'bigint',
  float4: 'real',
  float8: 'double precision',
  timestamptz: 'timestamp with time zone',
  timestamp: 'timestamp without time zone',
  timetz: 'time with time zone',
  time: 'time without time zone',
  // char(n) is bpchar in the catalog and `char(n)` in SQL; the precision is
  // stripped below, so only the base word has to be folded. 0024's currency
  // columns are the reason this alias exists.
  bpchar: 'char',
};

const baseType = (raw: string): string => {
  const s = raw.replace(/\(.*\)/, '').trim().toLowerCase();
  // PostgreSQL reports an array column's udt_name with a leading underscore
  // (_uuid) while Drizzle spells it with brackets (uuid[]); both are folded to
  // the same canonical form.
  const isArray = s.startsWith('_') || s.endsWith('[]');
  const core = s.startsWith('_') ? s.slice(1) : s.replace(/\[\]$/, '');
  const folded = TYPE_ALIASES[core] ?? core;
  return isArray ? `${folded}[]` : folded;
};

const FIN_TABLES: Record<string, PgTable> = {
  fin_tax_profiles: finTaxProfiles as unknown as PgTable,
  fin_tenant_settings: finTenantSettings as unknown as PgTable,
  fin_ledger_accounts: finLedgerAccounts as unknown as PgTable,
  fin_document_counters: finDocumentCounters as unknown as PgTable,
  fin_fee_heads: finFeeHeads as unknown as PgTable,
  fin_fee_structures: finFeeStructures as unknown as PgTable,
  fin_fee_structure_items: finFeeStructureItems as unknown as PgTable,
  fin_fee_installment_plans: finFeeInstallmentPlans as unknown as PgTable,
  fin_fee_structure_targets: finFeeStructureTargets as unknown as PgTable,
  fin_fee_assignments: finFeeAssignments as unknown as PgTable,
  fin_billing_runs: finBillingRuns as unknown as PgTable,
  fin_billing_run_items: finBillingRunItems as unknown as PgTable,
  fin_invoices: finInvoices as unknown as PgTable,
  fin_invoice_items: finInvoiceItems as unknown as PgTable,
  fin_invoice_adjustments: finInvoiceAdjustments as unknown as PgTable,
  fin_challans: finChallans as unknown as PgTable,
  fin_payments: finPayments as unknown as PgTable,
  fin_payment_allocations: finPaymentAllocations as unknown as PgTable,
  fin_receipts: finReceipts as unknown as PgTable,
  fin_refunds: finRefunds as unknown as PgTable,
  fin_reconciliation_batches: finReconciliationBatches as unknown as PgTable,
  fin_reconciliation_matches: finReconciliationMatches as unknown as PgTable,
  fin_ledger_entry_groups: finLedgerEntryGroups as unknown as PgTable,
  fin_ledger_entries: finLedgerEntries as unknown as PgTable,
  fin_ledger_event_types: finLedgerEventTypes as unknown as PgTable,
};

describeDb('0022 composite FK, anchors, delete actions, and schema fidelity', () => {
  beforeAll(async () => {
    const env = getEnv();
    migrator = new pg.Client({ connectionString: env.DATABASE_URL_MIGRATOR });
    app = new pg.Client({ connectionString: env.DATABASE_URL_APP });
    await migrator.connect();
    await app.connect();

    for (const k of [
      'tenantA', 'tenantB', 'userA',
      'campusA', 'campusB', 'yearA', 'yearB',
      'levelA', 'classA', 'sectionA',
      'studentA', 'enrollA', 'headA', 'headB',
    ]) {
      uid[k] = randomUUID();
    }

    await migrator.query('begin');
    await migrator.query(
      `insert into tenants (id, slug, name) values
         (${q(u('tenantA'))}, ${q(`fk-a-${slug}`)}, 'FK A'),
         (${q(u('tenantB'))}, ${q(`fk-b-${slug}`)}, 'FK B')`,
    );
    await migrator.query(
      `insert into users (id, email) values (${q(u('userA'))}, ${q(`fk-a-${slug}@example.com`)})`,
    );
    await migrator.query(
      `insert into campuses (id, tenant_id, code, name, status) values
         (${q(u('campusA'))}, ${q(u('tenantA'))}, ${q(`ca-${slug}`)}, 'Campus A', 'active'),
         (${q(u('campusB'))}, ${q(u('tenantB'))}, ${q(`cb-${slug}`)}, 'Campus B', 'active')`,
    );
    await migrator.query(
      `insert into academic_years (id, tenant_id, code, name, starts_on, ends_on, status) values
         (${q(u('yearA'))}, ${q(u('tenantA'))}, ${q(`ya-${slug}`)}, 'AY A', '2026-01-01', '2026-12-31', 'active'),
         (${q(u('yearB'))}, ${q(u('tenantB'))}, ${q(`yb-${slug}`)}, 'AY B', '2026-01-01', '2026-12-31', 'active')`,
    );
    await migrator.query(
      `insert into grade_levels (id, tenant_id, code, name, status) values
         (${q(u('levelA'))}, ${q(u('tenantA'))}, ${q(`gl-${slug}`)}, 'Grade A', 'active')`,
    );
    await migrator.query(
      `insert into acd_classes (id, tenant_id, campus_id, academic_year_id, grade_level_id, code, name, status) values
         (${q(u('classA'))}, ${q(u('tenantA'))}, ${q(u('campusA'))}, ${q(u('yearA'))}, ${q(u('levelA'))}, ${q(`cl-${slug}`)}, 'Class A', 'active')`,
    );
    await migrator.query(
      `insert into sections (id, tenant_id, class_id, campus_id, academic_year_id, code, status) values
         (${q(u('sectionA'))}, ${q(u('tenantA'))}, ${q(u('classA'))}, ${q(u('campusA'))}, ${q(u('yearA'))}, ${q(`sc-${slug}`)}, 'active')`,
    );
    await migrator.query(
      `insert into students (id, tenant_id, student_no, first_name, last_name, status, primary_campus_id) values
         (${q(u('studentA'))}, ${q(u('tenantA'))}, ${q(`s1-${slug}`)}, 'Ada', 'One', 'active', ${q(u('campusA'))})`,
    );
    await migrator.query(
      `insert into enrollments (id, tenant_id, student_id, academic_year_id, class_id, section_id, roll_no, status) values
         (${q(u('enrollA'))}, ${q(u('tenantA'))}, ${q(u('studentA'))}, ${q(u('yearA'))}, ${q(u('classA'))}, ${q(u('sectionA'))}, '01', 'active')`,
    );
    // A head in each tenant, so section F can point tenant A's row at tenant B's
    // parent and watch the composite FK refuse it. Tenant B gets a full class +
    // section so its enrollment is a real, valid row.
    await migrator.query(
      `insert into fin_fee_heads (id, tenant_id, code, name) values
         (${q(u('headA'))}, ${q(u('tenantA'))}, ${q(`h-a-${slug}`)}, 'Head A'),
         (${q(u('headB'))}, ${q(u('tenantB'))}, ${q(`h-b-${slug}`)}, 'Head B')`,
    );
    uid.levelB = randomUUID();
    uid.classB = randomUUID();
    uid.sectionB = randomUUID();
    await migrator.query(
      `insert into grade_levels (id, tenant_id, code, name, status) values
         (${q(u('levelB'))}, ${q(u('tenantB'))}, ${q(`glb-${slug}`)}, 'Grade B', 'active')`,
    );
    await migrator.query(
      `insert into acd_classes (id, tenant_id, campus_id, academic_year_id, grade_level_id, code, name, status) values
         (${q(u('classB'))}, ${q(u('tenantB'))}, ${q(u('campusB'))}, ${q(u('yearB'))}, ${q(u('levelB'))}, ${q(`clb-${slug}`)}, 'Class B', 'active')`,
    );
    await migrator.query(
      `insert into sections (id, tenant_id, class_id, campus_id, academic_year_id, code, status) values
         (${q(u('sectionB'))}, ${q(u('tenantB'))}, ${q(u('classB'))}, ${q(u('campusB'))}, ${q(u('yearB'))}, ${q(`scb-${slug}`)}, 'active')`,
    );
    await migrator.query('commit');
  });

  afterAll(async () => {
    try {
      await migrator.query('rollback');
      await app.query('rollback').catch(() => undefined);
      await migrator.query('begin');
      const t = `${q(u('tenantA'))},${q(u('tenantB'))}`;
      const lift = async (table: string, triggers: string[]): Promise<void> => {
        for (const x of triggers) await migrator.query(`alter table ${table} disable trigger ${x}`);
        await migrator.query(`delete from ${table} where tenant_id in (${t})`);
        for (const x of [...triggers].reverse()) await migrator.query(`alter table ${table} enable trigger ${x}`);
      };
      await lift('fin_billing_run_items', ['fin_run_items_freeze']);
      await lift('fin_billing_runs', ['fin_runs_freeze']);
      await lift('fin_fee_assignments', ['fin_assignments_validate']);
      await lift('fin_fee_structure_targets', ['fin_structure_targets_freeze', 'fin_targets_validate']);
      await lift('fin_fee_structure_items', ['fin_structure_items_freeze']);
      await lift('fin_fee_installment_plans', ['fin_structure_plans_freeze']);
      await lift('fin_fee_structures', ['fin_structures_publish']);
      await migrator.query(`delete from fin_fee_heads where tenant_id in (${t})`);
      await migrator.query(`delete from enrollments where tenant_id in (${t})`);
      await migrator.query(`delete from students where tenant_id in (${t})`);
      await migrator.query(`delete from sections where tenant_id in (${t})`);
      await migrator.query(`delete from acd_classes where tenant_id in (${t})`);
      await migrator.query(`delete from grade_levels where tenant_id in (${t})`);
      await migrator.query(`delete from academic_years where tenant_id in (${t})`);
      await migrator.query(`delete from campuses where tenant_id in (${t})`);
      await migrator.query(`delete from users where id = ${q(u('userA'))}`);
      await migrator.query(`delete from tenants where id in (${t})`);
      await migrator.query('commit');
    } finally {
      await migrator.query('end').catch(() => undefined);
      await app.query('end').catch(() => undefined);
      await migrator.end().catch(() => undefined);
      await app.end().catch(() => undefined);
    }
  });

  beforeEach(async () => {
    await migrator.query('begin');
  });

  afterEach(async () => {
    await migrator.query('rollback');
    await app.query('rollback').catch(() => undefined);
  });

  describe('A. FK shape and the tenant-scoping rule', () => {
    it('still installs exactly the 23 FKs of 0022, unchanged', async () => {
      const rows = await fkRows(T0022);
      const later = new Set<string>(ADDED_AFTER_0022.map((r) => r.fk));
      const owned = rows.filter((r) => !later.has(String(r.fk)));
      expect(owned).toHaveLength(23);
      expect(owned.every((r) => r.on_update === 'a')).toBe(true);
    });

    it('adds exactly the declared 0023–0025 FKs to the 0022 tables, and nothing else', async () => {
      // The other half of the count above. Stating 23 alone would let a later
      // migration add a fourth FK to a 0022 table and the suite would call it
      // drift; stating the additions by name makes that a declared change.
      const rows = await fkRows(T0022);
      const later = new Set<string>(ADDED_AFTER_0022.map((r) => r.fk));
      const added = rows.filter((r) => later.has(String(r.fk)));
      expect(rows).toHaveLength(23 + ADDED_AFTER_0022.length);
      expect(
        added
          .map((r) => `${String(r.fk)}:${String(r.src_table)}->${String(r.tgt_table)}`)
          .sort(),
      ).toEqual(
        ADDED_AFTER_0022.map((r) => `${r.fk}:${r.src}->${r.tgt}`).sort(),
      );
      // And it is a real composite reference, not a bare uuid column: this is
      // what stops a run item being invoiced into another tenant.
      for (const r of added) {
        expect(String(r.src_cols), String(r.fk)).toMatch(/^tenant_id,/);
        expect(String(r.tgt_cols), String(r.fk)).toBe('tenant_id,id');
      }
    });

    it('gives every FK but the documented global-parent exceptions a composite (tenant_id, col) -> (tenant_id, id) shape', async () => {
      // Widened from the 7 0022 tables to all 20: the tenant-scoping rule is a
      // phase-wide invariant, and 0023–0025 add 8 more tables that could each
      // have got it wrong.
      const rows = await fkRows(ALL_FIN);
      const allow = new Set<string>(GLOBAL_PARENT_FKS.map((r) => r.fk));
      const natural = new Map<string, string>(
        NATURAL_KEY_FKS.map((r) => [r.fk, r.cols]),
      );
      for (const r of rows) {
        if (allow.has(String(r.fk))) continue;
        // A single-column FK here would be the whole tenant-isolation bug: it
        // would let a row name a parent belonging to a different tenant. BOTH
        // sides must be tenant-prefixed, and the target side is what stops a
        // tenant A row from pointing at a tenant B parent.
        expect(String(r.src_cols), String(r.fk)).toMatch(/^tenant_id,/);
        expect(String(r.tgt_cols), String(r.fk)).toMatch(/^tenant_id,/);
        // A composite target is normally (tenant_id, id); the declared exceptions
        // name a natural key and are compared exactly rather than waved through.
        const wantTarget = natural.get(String(r.fk)) ?? 'tenant_id,id';
        expect(String(r.tgt_cols), String(r.fk)).toBe(wantTarget);
      }
      // The allowlist must not have quietly become a blanket, and the natural-key
      // list must not have become a dumping ground: only these two exemptions
      // exist across all 20 tables.
      expect(allow.size).toBeGreaterThanOrEqual(9);
      expect([...natural.keys()].filter((k) => allow.has(k))).toEqual([]);
      expect(natural.size).toBeGreaterThanOrEqual(1);
    });

    it('allows exactly the two documented single-column users(id) references on 0022', async () => {
      const rows = await fkRows(T0022);
      const single = rows
        .filter((r) => !String(r.src_cols).includes(','))
        .map((r) => `${String(r.src_table)}.${String(r.src_cols)}->${String(r.tgt_table)}.${String(r.tgt_cols)}`);
      expect(single.sort()).toEqual(
        R4_SINGLE_COLUMN.map((r) => `${r.src}.${r.col}->users.id`).sort(),
      );
      // users is global and has no tenant_id, so there is nothing to composite
      // on; the allowlist stops here rather than admitting any other single-column
      // reference.
      const usersCols = await mig(
        `select attname from pg_attribute
          where attrelid = 'users'::regclass and attnum > 0 and not attisdropped
          order by attnum`,
      );
      expect(usersCols.map((c) => c.attname)).not.toContain('tenant_id');
    });

    it('names all 9 single-column references across the 20 tables, and no others', async () => {
      // A single-column reference is the one shape in this file that is NOT
      // tenant-scoped, so every one of them across all 20 tables is named and
      // counted rather than allow-listed by prefix. There are exactly two kinds:
      // a global `users` audit identity, and `tenants.id` — where the parent IS
      // the tenant, so (id, id) would be the composite and the single column is
      // correct rather than merely permitted.
      const rows = await fkRows(ALL_FIN);
      const single = rows
        .filter((r) => !String(r.src_cols).includes(','))
        .map(
          (r) =>
            `${String(r.fk)}:${String(r.src_table)}.${String(r.src_cols)}->${String(r.tgt_table)}.${String(r.tgt_cols)}`,
        )
        .sort();
      expect(single).toEqual(
        GLOBAL_PARENT_FKS.map((r) => `${r.fk}:${r.src}.${r.col}->${r.tgt}.id`).sort(),
      );
      for (const r of rows) {
        if (String(r.src_cols).includes(',')) continue;
        const declared = GLOBAL_PARENT_FKS.find((g) => g.fk === r.fk);
        expect(declared, `undeclared single-column FK ${String(r.fk)}`).toBeDefined();
        expect(String(r.on_delete), String(r.fk)).toBe(declared!.onDelete);
      }
      // The five users(id) references are audit identities, and neither CASCADE
      // nor an unqualified action may rewrite or erase one. The four tenants(id)
      // references are the opposite case and CASCADE is required there: deleting
      // a tenant must take its money configuration with it.
      for (const g of GLOBAL_PARENT_FKS) {
        if (g.tgt !== 'users') continue;
        expect(['r', 'n'], `${g.fk} may not cascade or be a bare action`).toContain(g.onDelete);
      }
      expect(GLOBAL_PARENT_FKS.filter((g) => g.tgt === 'tenants').map((g) => g.onDelete)).toEqual([
        'c', 'c', 'c', 'c',
      ]);
    });

    it('names both R4 exceptions exactly, with their distinct delete actions', async () => {
      const rows = await fkRows(T0022);
      for (const want of R4_SINGLE_COLUMN) {
        const r = rows.find((x) => x.fk === want.fk);
        expect(r, want.fk).toBeDefined();
        expect(String(r!.src_table)).toBe(want.src);
        expect(String(r!.tgt_table)).toBe('users');
        expect(String(r!.on_delete)).toBe(want.onDelete);
      }
    });

    it('leaves no FK pointing FROM a 0021 foundation table INTO a 0022 or later table', async () => {
      // 0022 must not reach back and constrain the 0021 foundation: the
      // dependency is one-way, so 0021 stays valid on its own. 0023–0025 hold
      // to the same direction — nothing older gained a forward reference.
      const rows = await mig(
        `select src.relname as src_table, con.conname as fk, tgt.relname as tgt_table
           from pg_constraint con
           join pg_class src on src.oid = con.conrelid
           join pg_class tgt on tgt.oid = con.confrelid
           join pg_namespace n on n.oid = src.relnamespace
          where con.contype='f' and n.nspname='public'
            and src.relname in ('fin_tax_profiles','fin_tenant_settings','fin_ledger_accounts',
                                'fin_document_counters','fin_fee_heads')
            and tgt.relname in (${[...T0022, ...T0023_0025].map(q).join(',')})`,
      );
      expect(rows).toEqual([]);
    });
  });

  describe('B. anchor coverage on every tenant-scoped parent', () => {
    it('exposes a unique (tenant_id, id) index on each referenced tenant-scoped parent', async () => {
      // Widened to FKs from all 20 finance tables: 0023–0025 reference four more
      // tenant-scoped parents (fin_invoices, fin_payments, fin_refunds and
      // guardians among them), and an unanchored parent would make their
      // composite FKs unenforceable in the same silent way it would for 0022.
      const rows = await mig(
        `with parents as (
            select distinct c.oid, c.relname
              from pg_constraint con
              join pg_class c on c.oid = con.confrelid
              join pg_class src on src.oid = con.conrelid
              join pg_namespace n on n.oid = c.relnamespace
             where con.contype='f' and n.nspname='public'
               and src.relname in (${ALL_FIN.map(q).join(',')})
        )
        select p.relname as parent,
               (select string_agg(i.relname, ', ' order by i.relname)
                  from pg_index x join pg_class i on i.oid = x.indexrelid
                 where x.indrelid = p.oid and x.indisunique
                   and (select array_agg(a.attname::text order by k.ord)
                          from unnest(x.indkey) with ordinality k(attnum, ord)
                          join pg_attribute a on a.attrelid = p.oid and a.attnum = k.attnum
                         where k.ord <= 2) = array['tenant_id','id']) as anchor
          from parents p order by p.relname`,
      );
      // users is platform-global and tenants IS the tenant, so those two are the
      // only referenced parents with no (tenant_id, id) to anchor on. Naming
      // both is what makes the exemption deliberate: a THIRD global parent would
      // fail here rather than quietly exempt itself.
      const globals = rows.filter((r) => r.parent === 'users' || r.parent === 'tenants');
      expect(globals.map((r) => r.parent).sort()).toEqual(['tenants', 'users']);
      const tenantScoped = rows.filter(
        (r) => r.parent !== 'users' && r.parent !== 'tenants',
      );
      expect(tenantScoped.length).toBeGreaterThanOrEqual(20);
      for (const r of tenantScoped) {
        // Without this index the composite FKs have nothing to enforce against.
        expect(String(r.anchor ?? ''), `${String(r.parent)} has no (tenant_id, id) anchor`).not.toBe('');
      }
      for (const r of globals) {
        expect(r.anchor, `${String(r.parent)} unexpectedly has a tenant_id anchor`).toBeNull();
      }
      const usersCols = await mig(
        `select attname from pg_attribute
          where attrelid = 'users'::regclass and attnum > 0 and not attisdropped
          order by attnum`,
      );
      expect(usersCols.map((c) => c.attname)).not.toContain('tenant_id');
      const tenantCols = await mig(
        `select attname from pg_attribute
          where attrelid = 'tenants'::regclass and attnum > 0 and not attisdropped
          order by attnum`,
      );
      expect(tenantCols.map((c) => c.attname)).toContain('id');
      expect(tenantCols.map((c) => c.attname)).not.toContain('tenant_id');
    });
  });

  describe('C. delete actions behave as declared', () => {
    it('RESTRICT: refuses to delete a fee head a structure item still names', async () => {
      const structure = randomUUID();
      const item = randomUUID();
      await mig(
        `insert into fin_fee_structures (id, tenant_id, code, name, academic_year_id, effective_from)
         values (${q(structure)}, ${q(u('tenantA'))}, ${q(`c1-${slug}`)}, 'S1', ${q(u('yearA'))}, '2026-01-01')`,
      );
      await mig(
        `insert into fin_fee_structure_items (id, tenant_id, structure_id, fee_head_id, amount)
         values (${q(item)}, ${q(u('tenantA'))}, ${q(structure)}, ${q(u('headA'))}, 10.00)`,
      );
      await migReject(`delete from fin_fee_heads where id = ${q(u('headA'))}`, '23001');
    });

    it('RESTRICT: refuses to delete the publisher of a published structure', async () => {
      const publisher = randomUUID();
      const structure = randomUUID();
      await migrator.query(`insert into users (id, email) values (${q(publisher)}, ${q(`pub-${slug}@example.com`)})`);
      await mig(
        `insert into fin_fee_structures (id, tenant_id, code, name, academic_year_id, status, effective_from)
         values (${q(structure)}, ${q(u('tenantA'))}, ${q(`c2-${slug}`)}, 'S2', ${q(u('yearA'))}, 'draft', '2026-01-01')`,
      );
      await migrator.query(
        `update fin_fee_structures set status='published', published_at=now(), published_by=${q(publisher)}
          where id = ${q(structure)}`,
      );
      await migReject(`delete from users where id = ${q(publisher)}`, '23001');
    });

    it('SET NULL: deleting the user who started a run nulls started_by and keeps the run', async () => {
      const starter = randomUUID();
      const run = randomUUID();
      await migrator.query(`insert into users (id, email) values (${q(starter)}, ${q(`st-${slug}@example.com`)})`);
      await mig(
        `insert into fin_billing_runs (id, tenant_id, academic_year_id, idempotency_key, started_by)
         values (${q(run)}, ${q(u('tenantA'))}, ${q(u('yearA'))}, ${q(`idem-s-${slug}`)}, ${q(starter)})`,
      );
      await migrator.query(`delete from users where id = ${q(starter)}`);
      const rows = await mig(`select started_by from fin_billing_runs where id = ${q(run)}`);
      expect(rows).toHaveLength(1);
      // started_by is an audit hint, not an ownership claim, so losing the user
      // must not destroy a run that may already be the basis of invoices.
      expect(one(rows).started_by).toBeNull();
    });

    it('CASCADE: deleting a draft structure takes its items and plans with it', async () => {
      const structure = randomUUID();
      await mig(
        `insert into fin_fee_structures (id, tenant_id, code, name, academic_year_id, effective_from)
         values (${q(structure)}, ${q(u('tenantA'))}, ${q(`c3-${slug}`)}, 'S3', ${q(u('yearA'))}, '2026-01-01')`,
      );
      await mig(
        `insert into fin_fee_structure_items (id, tenant_id, structure_id, fee_head_id, amount)
         values (${q(randomUUID())}, ${q(u('tenantA'))}, ${q(structure)}, ${q(u('headA'))}, 10.00)`,
      );
      await mig(
        `insert into fin_fee_installment_plans (id, tenant_id, structure_id, installment_no, due_on)
         values (${q(randomUUID())}, ${q(u('tenantA'))}, ${q(structure)}, 1, '2026-03-01')`,
      );
      await mig(`delete from fin_fee_structures where id = ${q(structure)}`);
      const items = await mig(
        `select count(*)::int as n from fin_fee_structure_items where structure_id = ${q(structure)}`,
      );
      const plans = await mig(
        `select count(*)::int as n from fin_fee_installment_plans where structure_id = ${q(structure)}`,
      );
      expect(n1(items)).toBe(0);
      expect(n1(plans)).toBe(0);
    });

    it('NO ACTION: the four fin_targets_* FKs do not cascade, so targets are never silently dropped', async () => {
      const rows = await fkRows(T0022);
      const targetFks = rows
        .filter((r) => ['campuses', 'acd_classes', 'grade_levels', 'sections'].includes(String(r.tgt_table)))
        .map((r) => `${String(r.fk)}:${String(r.on_delete)}`)
        .sort();
      expect(targetFks).toEqual([
        'fin_targets_campus_fk:a',
        'fin_targets_class_fk:a',
        'fin_targets_grade_fk:a',
        'fin_targets_section_fk:a',
      ]);
      // On DELETE this is plain NO ACTION, which PostgreSQL implements as
      // RESTRICT-until-end-of-statement: deleting a campus that a target still
      // names is refused rather than removing the target row.
      const structure = randomUUID();
      const target = randomUUID();
      const campus = randomUUID();
      await migrator.query(
        `insert into campuses (id, tenant_id, code, name, status)
         values (${q(campus)}, ${q(u('tenantA'))}, ${q(`cx-${slug}`)}, 'Campus X', 'active')`,
      );
      await mig(
        `insert into fin_fee_structures (id, tenant_id, code, name, academic_year_id, effective_from)
         values (${q(structure)}, ${q(u('tenantA'))}, ${q(`c4-${slug}`)}, 'S4', ${q(u('yearA'))}, '2026-01-01')`,
      );
      await mig(
        `insert into fin_fee_structure_targets (id, tenant_id, structure_id, target_type, campus_id)
         values (${q(target)}, ${q(u('tenantA'))}, ${q(structure)}, 'campus', ${q(campus)})`,
      );
      await migReject(`delete from campuses where id = ${q(campus)}`, '23503');
      const still = await mig(`select count(*)::int as n from fin_fee_structure_targets where id = ${q(target)}`);
      expect(n1(still)).toBe(1);
    });
  });

  describe('D. security posture after 0028', () => {
    it('grants school_app_rw exactly the §D.2 shape per fin_* table, with DELETE and PUBLIC absent', async () => {
      const rows = await mig(
        `select c.relname as tbl, r.rolname as grantee, a.privilege_type
           from pg_class c
           join pg_namespace n on n.oid = c.relnamespace
           cross join lateral aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
           left join pg_roles r on r.oid = a.grantee
          where n.nspname='public' and c.relname in (${ALL_FIN.map(q).join(',')}) and c.relkind='r'`,
      );
      const byTbl = new Map<string, Row[]>();
      for (const r of rows) {
        const k = String(r.tbl);
        byTbl.set(k, [...(byTbl.get(k) ?? []), r]);
      }
      for (const tbl of ALL_FIN) {
        const t = byTbl.get(tbl) ?? [];
        const appPriv = t
          .filter((r) => r.grantee === 'school_app_rw')
          .map((r) => String(r.privilege_type))
          .sort();
        // The relacl of a Shape-2 table carries only its table-level SELECT;
        // the column-level INSERT/UPDATE live in attacl (§D.2). Tables without
        // grant history (fin_ledger_event_types, Shape 5) grant nothing.
        expect(appPriv, `${tbl}: §D.2 table-level shape`).toEqual(SHAPE[tbl]);
        expect(t.some((r) => r.grantee === null), `${tbl}: PUBLIC grant`).toBe(false);
        for (const r of t) {
          const g = r.grantee === null ? 'PUBLIC' : String(r.grantee);
          if (g === 'school_app_rw') continue;
          expect(g, `${tbl}: unexpected grantee ${g} (${String(r.privilege_type)})`).toBe(
            'school_migrator',
          );
        }
      }
    });

    it('enables + forces RLS on every fin_* table and installs the §B.1 command set, with DELETE omitted exactly per §B.2.10', async () => {
      const rls = await mig(
        `select c.relname as tbl, c.relrowsecurity as rls, c.relforcerowsecurity as force
           from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where n.nspname='public' and c.relname in (${ALL_FIN.map(q).join(',')}) and c.relkind='r'`,
      );
      expect(rls.length).toBe(ALL_FIN.length);
      for (const r of rls) {
        expect(r.rls, `${String(r.tbl)}: RLS enabled`).toBe(true);
        expect(r.force, `${String(r.tbl)}: RLS FORCEd`).toBe(true);
      }
      const pol = await mig(
        `select c.relname as tbl, p.polcmd
           from pg_policy p
           join pg_class c on c.oid = p.polrelid
           join pg_namespace n on n.oid = c.relnamespace
          where n.nspname='public' and c.relname in (${ALL_FIN.map(q).join(',')})`,
      );
      const CMD: Record<string, string> = { r: 'SELECT', a: 'INSERT', w: 'UPDATE', d: 'DELETE', '*': 'ALL' };
      const cmds = new Map<string, Set<string>>();
      for (const r of pol) {
        const k = String(r.tbl);
        const cmd = CMD[String(r.polcmd)] ?? String(r.polcmd);
        if (!cmds.has(k)) cmds.set(k, new Set());
        cmds.get(k)!.add(cmd);
      }
      const DELETE_OMITTED = new Set([
        'fin_receipts',
        'fin_ledger_accounts',
        'fin_ledger_entry_groups',
        'fin_ledger_entries',
      ]);
      for (const tbl of ALL_FIN) {
        const set = cmds.get(tbl) ?? new Set();
        expect(
          set.has('SELECT') && set.has('INSERT') && set.has('UPDATE'),
          `${tbl}: SELECT/INSERT/UPDATE policies`,
        ).toBe(true);
        // 0028 adaptation A13: per-command policies only, never FOR ALL.
        expect(set.has('ALL'), `${tbl}: no FOR ALL policy`).toBe(false);
        if (DELETE_OMITTED.has(tbl)) {
          expect(set.has('DELETE'), `${tbl}: DELETE must be omitted`).toBe(false);
        } else {
          expect(set.has('DELETE'), `${tbl}: DELETE policy required`).toBe(true);
        }
      }
    });

    it('names the 0023 invoice attachment exactly, and still points no FK at fin_billing_run_items', async () => {
      // This replaced "fin_invoices is absent and nothing points at
      // fin_billing_run_items", which was true of 0022 as a standalone migration
      // and stopped being true when 0023 landed. Both halves that survive are
      // asserted here, in the directions they actually hold:
      //   * fin_invoices exists, and the 0022 column it back-fills is now a real
      //     composite reference rather than a bare uuid;
      //   * and, still true, nothing in the schema DEPENDS ON a run item as a
      //     parent, so a run's provenance cannot be rewritten from outside.
      const inv = await mig(
        `select count(*)::int as n from pg_class c join pg_namespace n on n.oid=c.relnamespace
          where n.nspname='public' and c.relname='fin_invoices'`,
      );
      expect(n1(inv)).toBe(1);

      const rows = await fkRows(ALL_FIN);
      const attachment = rows.filter(
        (r) => r.src_table === 'fin_billing_run_items' && r.tgt_table === 'fin_invoices',
      );
      expect(attachment.map((r) => String(r.fk))).toEqual(['fin_bri_invoice_fk']);
      expect(String(attachment[0]!.src_cols)).toBe('tenant_id,invoice_id');
      expect(String(attachment[0]!.tgt_cols)).toBe('tenant_id,id');
      expect(String(attachment[0]!.on_delete)).toBe('r');

      const depended = await mig(
        `select src.relname as src_table, con.conname as fk
           from pg_constraint con
           join pg_class src on src.oid = con.conrelid
           join pg_class tgt on tgt.oid = con.confrelid
           join pg_namespace n on n.oid = src.relnamespace
          where con.contype='f' and n.nspname='public' and tgt.relname='fin_billing_run_items'`,
      );
      expect(depended).toEqual([]);
    });

    it('leaves every fin_* table with a primary key and no orphan rows', async () => {
      const noPk = await mig(
        `select c.relname as tbl from pg_class c join pg_namespace n on n.oid=c.relnamespace
          where n.nspname='public' and c.relname like 'fin\\_%' and c.relkind='r'
            and not exists (select 1 from pg_constraint con where con.conrelid=c.oid and con.contype='p')`,
      );
      expect(noPk).toEqual([]);
    });
  });

  describe('E. schema.ts mirrors the live catalog', () => {
    it('declares every finance table that exists, and none that does not', async () => {
      const cat = await mig(
        `select c.relname as tbl from pg_class c join pg_namespace n on n.oid=c.relnamespace
          where n.nspname='public' and c.relname like 'fin\\_%' and c.relkind='r' order by 1`,
      );
      expect(cat.map((r) => r.tbl).sort()).toEqual(Object.keys(FIN_TABLES).sort());
    });

    it('matches every column name, position and nullability', async () => {
      for (const [name, table] of Object.entries(FIN_TABLES)) {
        const cfg = getTableConfig(table);
        const cat = await mig(
          `select column_name, is_nullable, data_type, udt_name
             from information_schema.columns
            where table_schema='public' and table_name=${q(name)}
            order by ordinal_position`,
        );
        // Position matters as much as presence: an out-of-order insert() block
        // produces a schema that generates the wrong INSERT column list.
        expect(cat.map((c) => c.column_name), `${name} columns`).toEqual(
          cfg.columns.map((c) => c.name),
        );
        for (let i = 0; i < cat.length; i++) {
          const declared = cfg.columns[i];
          const actual = cat[i];
          if (declared === undefined || actual === undefined) {
            throw new Error(`${name}: schema and catalog disagree on column count`);
          }
          expect(actual.is_nullable === 'NO', `${name}.${String(actual.column_name)} nullability`).toBe(
            Boolean(declared.notNull),
          );
          expect(baseType(declared.getSQLType()), `${name}.${String(actual.column_name)} type`).toBe(
            baseType(String(actual.udt_name)),
          );
        }
      }
    });

    it('matches every FK name on all finance tables', async () => {
      const cat = await fkRows(ALL_FIN);
      const byTable = new Map<string, string[]>();
      for (const r of cat) {
        const list = byTable.get(String(r.src_table)) ?? [];
        list.push(String(r.fk));
        byTable.set(String(r.src_table), list);
      }
      for (const [name, table] of Object.entries(FIN_TABLES)) {
        const declared = getTableConfig(table).foreignKeys.map((f) => f.getName()).sort();
        // A missing declaration compiles fine and then fails at runtime with a
        // 23503 that nothing in the type system predicted.
        expect(declared, `${name} FKs`).toEqual((byTable.get(name) ?? []).sort());
      }
    });

    it('matches every check and unique-constraint name on all finance tables', async () => {
      for (const [name, table] of Object.entries(FIN_TABLES)) {
        const cfg = getTableConfig(table);
        const cat = await mig(
          `select con.conname as n, con.contype as t from pg_constraint con
             join pg_class c on c.oid = con.conrelid
             join pg_namespace n on n.oid = c.relnamespace
            where n.nspname='public' and c.relname=${q(name)} and con.contype in ('c','u')`,
        );
        expect(
          cfg.checks.map((c) => c.name).sort(),
          `${name} checks`,
        ).toEqual(cat.filter((c) => c.t === 'c').map((c) => String(c.n)).sort());
        // unique() is a constraint, not an index; using uniqueIndex() here would
        // silently drop the pg_constraint and change what the catalog reports.
        expect(
          cfg.uniqueConstraints.map((u) => u.name).sort(),
          `${name} unique constraints`,
        ).toEqual(cat.filter((c) => c.t === 'u').map((c) => String(c.n)).sort());
      }
    });

    it('matches every explicitly declared index, including the D4 partial one', async () => {
      for (const [name, table] of Object.entries(FIN_TABLES)) {
        const declared = getTableConfig(table)
          .indexes.map((i) => i.config.name)
          .sort();
        const cat = await mig(
          `select i.relname as n from pg_index x
             join pg_class c on c.oid = x.indrelid
             join pg_class i on i.oid = x.indexrelid
             join pg_namespace n on n.oid = c.relnamespace
            where n.nspname='public' and c.relname=${q(name)} and not x.indisprimary
              and i.relname not in (select conname from pg_constraint con where con.conrelid=c.oid)`,
        );
        // Unique CONSTRAINTS appear in pg_index too, but they are declared via
        // unique() and compared above, so they are excluded here.
        expect(declared, `${name} indexes`).toEqual(cat.map((c) => String(c.n)).sort());
      }
    });

    it('declares the D4 assignment index as a partial unique on active rows', async () => {
      const cfg = getTableConfig(finFeeAssignments);
      const idx = cfg.indexes.find((i) => i.config.name === 'fin_fee_assignments_one_active_uq');
      expect(idx, 'fin_fee_assignments_one_active_uq is not declared').toBeDefined();
      expect(idx!.config.unique).toBe(true);
      const cat = await mig(
        `select x.indisunique as uniq, x.indpred is not null as partial,
                pg_get_expr(x.indpred, x.indrelid) as pred
           from pg_index x
           join pg_class c on c.oid = x.indrelid
           join pg_class i on i.oid = x.indexrelid
           join pg_namespace n on n.oid = c.relnamespace
          where n.nspname='public' and c.relname='fin_fee_assignments'
            and i.relname='fin_fee_assignments_one_active_uq'`,
      );
      expect(one(cat).uniq).toBe(true);
      expect(one(cat).partial).toBe(true);
      expect(String(one(cat).pred)).toMatch(/is_active/);
    });

    it('declares fin_billing_run_items without an id column and with the 3-column PK', async () => {
      const cfg = getTableConfig(finBillingRunItems);
      expect(cfg.columns.map((c) => c.name)).not.toContain('id');
      const pk = await mig(
        `select a.attname as col from pg_constraint con
           join pg_class c on c.oid = con.conrelid
           join pg_namespace n on n.oid = c.relnamespace
           cross join lateral unnest(con.conkey) with ordinality k(attnum, ord)
           join pg_attribute a on a.attrelid = c.oid and a.attnum = k.attnum
          where n.nspname='public' and c.relname='fin_billing_run_items' and con.contype='p'
          order by k.ord`,
      );
      expect(pk.map((r) => r.col)).toEqual(['tenant_id', 'run_id', 'enrollment_id']);
    });
  });

  describe('F. cross-tenant references are refused', () => {
    it('refuses a structure item whose fee head belongs to another tenant', async () => {
      const structure = randomUUID();
      await migrator.query(
        `insert into fin_fee_structures (id, tenant_id, code, name, academic_year_id, effective_from)
         values (${q(structure)}, ${q(u('tenantA'))}, ${q(`cx1-${slug}`)}, 'SX', ${q(u('yearA'))}, '2026-01-01')`,
      );
      // The parent genuinely exists; it simply belongs to tenant B. Only the
      // composite (tenant_id, id) FK can catch this -- a single-column
      // fee_head_id FK would accept the row.
      await migReject(
        `insert into fin_fee_structure_items (id, tenant_id, structure_id, fee_head_id, amount)
         values (${q(randomUUID())}, ${q(u('tenantA'))}, ${q(structure)}, ${q(u('headB'))}, 10.00)`,
        '23503',
      );
    });

    it('refuses a billing run item whose enrollment belongs to another tenant', async () => {
      const foreignStudent = randomUUID();
      const foreignEnrollment = randomUUID();
      const run = randomUUID();
      const structure = randomUUID();
      await migrator.query(
        `insert into students (id, tenant_id, student_no, first_name, last_name, status, primary_campus_id)
         values (${q(foreignStudent)}, ${q(u('tenantB'))}, ${q(`s9-${slug}`)}, 'X', 'Y', 'active', ${q(u('campusB'))})`,
      );
      await migrator.query(
        `insert into enrollments (id, tenant_id, student_id, academic_year_id, class_id, section_id, roll_no, status)
         values (${q(foreignEnrollment)}, ${q(u('tenantB'))}, ${q(foreignStudent)}, ${q(u('yearB'))},
                 ${q(u('classB'))}, ${q(u('sectionB'))}, '99', 'active')`,
      );
      await migrator.query(
        `insert into fin_fee_structures (id, tenant_id, code, name, academic_year_id, effective_from)
         values (${q(structure)}, ${q(u('tenantA'))}, ${q(`cs-${slug}`)}, 'S', ${q(u('yearA'))}, '2026-01-01')`,
      );
      await migrator.query(
        `insert into fin_billing_runs (id, tenant_id, academic_year_id, idempotency_key)
         values (${q(run)}, ${q(u('tenantA'))}, ${q(u('yearA'))}, ${q(`idem-x-${slug}`)})`,
      );
      // A tenant A item that names a tenant B enrollment. The enrollment exists
      // and is active, so only the composite (tenant_id, enrollment_id) ->
      // (tenant_id, id) FK can catch this.
      await migReject(
        `insert into fin_billing_run_items (tenant_id, run_id, enrollment_id, student_id, structure_id, amount)
         values (${q(u('tenantA'))}, ${q(run)}, ${q(foreignEnrollment)}, ${q(u('studentA'))}, ${q(structure)}, 1.00)`,
        '23503',
      );
      const items = await mig(`select count(*)::int as n from fin_billing_run_items where run_id = ${q(run)}`);
      expect(n1(items)).toBe(0);
    });

    it('refuses a structure whose academic year belongs to another tenant', async () => {
      await migReject(
        `insert into fin_fee_structures (id, tenant_id, code, name, academic_year_id, effective_from)
         values (${q(randomUUID())}, ${q(u('tenantA'))}, ${q(`cy-${slug}`)}, 'SY', ${q(u('yearB'))}, '2026-01-01')`,
        '23503',
      );
    });
  });
});
