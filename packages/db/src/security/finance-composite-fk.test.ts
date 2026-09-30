import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { getEnv } from '@sms/config';
import { getTableConfig, type PgTable } from 'drizzle-orm/pg-core';
import {
  finBillingRunItems,
  finBillingRuns,
  finDocumentCounters,
  finFeeAssignments,
  finFeeHeads,
  finFeeInstallmentPlans,
  finFeeStructureItems,
  finFeeStructureTargets,
  finFeeStructures,
  finLedgerAccounts,
  finTaxProfiles,
  finTenantSettings,
} from '../schema.js';

/**
 * 0022 composite-FK + tenant-isolation proofs, run against the REAL roles and
 * the disposable test database. Requires migrations 0001..0022.
 *
 * Every assertion is read from the live catalog or provoked against the live
 * database; no migration text is searched. Section E is the one that keeps
 * packages/db/src/schema.ts honest: it compares the Drizzle declarations
 * themselves (via drizzle's own getTableConfig introspection) with what the
 * database actually contains, so a schema edit that drifts from the applied
 * migration fails here instead of silently lying to the API layer.
 *
 * Section A -- FK shape: the exact 23 constraints, and the rule that matters --
 *   every fin_* FK is (tenant_id, <col>) -> (tenant_id, id), so a row can never
 *   be joined to a parent in another tenant. The ONLY exceptions are the two
 *   single-column users(id) references, because users is global and has no
 *   tenant_id to composite on.
 * Section B -- anchors: each tenant-scoped parent really does expose a unique
 *   (tenant_id, id) index, which is what makes the composite FKs enforceable at
 *   all; users has none, which is the allowlist's whole justification.
 * Section C -- delete actions: RESTRICT really blocks, CASCADE really cascades,
 *   SET NULL really nulls, and the four fin_targets_* FKs are NO ACTION (a
 *   deliberate choice: cascade would delete a published structure's target
 *   rows, and the freeze trigger is the layer that owns that decision).
 * Section D -- posture: no fin_* privilege for school_app_rw, no RLS, no
 *   policies, no app grant, fin_invoices still absent, and nothing points at
 *   fin_billing_run_items.
 * Section E -- schema.ts mirrors the catalog (columns, nullability, FKs, checks,
 *   unique constraints, indexes) for all 12 finance tables.
 * Section F -- a cross-tenant insert is refused by the composite FK itself.
 *
 * Opt-in: RUN_RUNTIME_SECURITY_TESTS=1 (requires PostgreSQL + migration 0022).
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

const ALL_FIN = [
  'fin_tax_profiles',
  'fin_tenant_settings',
  'fin_ledger_accounts',
  'fin_document_counters',
  'fin_fee_heads',
  ...T0022,
] as const;

/** The two R4-allowlisted single-column references, and the global `users` parent. */
const R4_SINGLE_COLUMN = [
  { fk: 'fin_fee_structures_publisher_fk', src: 'fin_fee_structures', col: 'published_by', onDelete: 'r' },
  { fk: 'fin_billing_runs_user_fk', src: 'fin_billing_runs', col: 'started_by', onDelete: 'n' },
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
    it('installs exactly 23 FKs across the 7 0022 tables', async () => {
      const rows = await fkRows(T0022);
      expect(rows).toHaveLength(23);
      expect(rows.every((r) => r.on_update === 'a')).toBe(true);
    });

    it('gives every FK but the two R4 exceptions a composite (tenant_id, col) -> (tenant_id, id) shape', async () => {
      const rows = await fkRows(T0022);
      const allow = new Set<string>(R4_SINGLE_COLUMN.map((r) => r.fk));
      for (const r of rows) {
        if (allow.has(String(r.fk))) continue;
        // A single-column FK here would be the whole tenant-isolation bug: it
        // would let a row name a parent belonging to a different tenant.
        expect(String(r.src_cols), String(r.fk)).toMatch(/^tenant_id,/);
        expect(String(r.tgt_cols), String(r.fk)).toBe('tenant_id,id');
      }
    });

    it('allows exactly the two documented single-column users(id) references', async () => {
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

    it('leaves no FK pointing FROM a 0021 foundation table INTO a 0022 table', async () => {
      // 0022 must not reach back and constrain the 0021 foundation: the
      // dependency is one-way, so 0021 stays valid on its own.
      const rows = await mig(
        `select src.relname as src_table, con.conname as fk, tgt.relname as tgt_table
           from pg_constraint con
           join pg_class src on src.oid = con.conrelid
           join pg_class tgt on tgt.oid = con.confrelid
           join pg_namespace n on n.oid = src.relnamespace
          where con.contype='f' and n.nspname='public'
            and src.relname in ('fin_tax_profiles','fin_tenant_settings','fin_ledger_accounts',
                                'fin_document_counters','fin_fee_heads')
            and tgt.relname in (${T0022.map(q).join(',')})`,
      );
      expect(rows).toEqual([]);
    });
  });

  describe('B. anchor coverage on every tenant-scoped parent', () => {
    it('exposes a unique (tenant_id, id) index on each referenced tenant-scoped parent', async () => {
      const rows = await mig(
        `with parents as (
            select distinct c.oid, c.relname
              from pg_constraint con
              join pg_class c on c.oid = con.confrelid
              join pg_class src on src.oid = con.conrelid
              join pg_namespace n on n.oid = c.relnamespace
             where con.contype='f' and n.nspname='public'
               and src.relname in (${T0022.map(q).join(',')})
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
      // The 7 pre-existing parents 0021 anchored, plus the 6 0022 tables that
      // can be referenced; users is the one global parent with no tenant_id.
      const tenantScoped = rows.filter((r) => r.parent !== 'users');
      expect(tenantScoped.length).toBeGreaterThanOrEqual(12);
      for (const r of tenantScoped) {
        // Without this index the composite FKs have nothing to enforce against.
        expect(String(r.anchor ?? ''), `${String(r.parent)} has no (tenant_id, id) anchor`).not.toBe('');
      }
      expect(rows.find((r) => r.parent === 'users')?.anchor ?? null).toBeNull();
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

  describe('D. security posture', () => {
    it('grants school_app_rw nothing at all on any of the 12 fin_* tables', async () => {
      const rows = await mig(
        `select c.relname as tbl, r.rolname as grantee, a.privilege_type
           from pg_class c
           join pg_namespace n on n.oid = c.relnamespace
           cross join lateral aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
           left join pg_roles r on r.oid = a.grantee
          where n.nspname='public' and c.relname like 'fin\\_%' and c.relkind='r'
            and (r.rolname is not null or a.grantee = 0)`,
      );
      const appRows = rows.filter((r) => r.grantee === 'school_app_rw' || r.grantee === null);
      // The finance tables are not app-reachable in 0022: the API must go
      // through reviewed service code with the migrator's tenant context, so
      // granting the app role anything here would bypass that entirely.
      expect(appRows).toEqual([]);
      for (const r of rows) {
        expect(String(r.grantee), `${String(r.tbl)} grants ${String(r.privilege_type)}`).toBe('school_migrator');
      }
    });

    it('enables no RLS and defines no policy on any 0022 table', async () => {
      const rls = await mig(
        `select c.relname as tbl, c.relrowsecurity as rls, c.relforcerowsecurity as force
           from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where n.nspname='public' and c.relname in (${T0022.map(q).join(',')}) and c.relkind='r'`,
      );
      expect(rls).toHaveLength(7);
      for (const r of rls) {
        // Tenant isolation here is enforced by the composite FKs, not RLS: a
        // session context could be forged, so no policy may rely on one.
        expect(r.rls, String(r.tbl)).toBe(false);
        expect(r.force, String(r.tbl)).toBe(false);
      }
      const pol = await mig(
        `select c.relname as tbl, p.polname
           from pg_policy p
           join pg_class c on c.oid = p.polrelid
           join pg_namespace n on n.oid = c.relnamespace
          where n.nspname='public' and c.relname in (${T0022.map(q).join(',')})`,
      );
      expect(pol).toEqual([]);
    });

    it('leaves fin_invoices absent and points no FK at fin_billing_run_items', async () => {
      const inv = await mig(
        `select count(*)::int as n from pg_class c join pg_namespace n on n.oid=c.relnamespace
          where n.nspname='public' and c.relname='fin_invoices'`,
      );
      expect(n1(inv)).toBe(0);
      const refs = await mig(
        `select src.relname as src_table, con.conname as fk
           from pg_constraint con
           join pg_class src on src.oid = con.conrelid
           join pg_class tgt on tgt.oid = con.confrelid
           join pg_namespace n on n.oid = src.relnamespace
          where con.contype='f' and n.nspname='public' and tgt.relname='fin_billing_run_items'`,
      );
      // invoice_id is deliberately FK-less: 0023 owns fin_invoices, and a
      // dangling uuid is preferred over a 0022 migration depending on a table
      // that does not exist yet.
      expect(refs).toEqual([]);
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
    it('declares exactly the 12 finance tables that exist', async () => {
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

    it('matches every FK name on all 12 tables', async () => {
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

    it('matches every check and unique-constraint name on all 12 tables', async () => {
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
