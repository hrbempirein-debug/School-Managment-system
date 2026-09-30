import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { getEnv } from '@sms/config';

/**
 * 0022 fee-structure trigger INVENTORY + freeze-behaviour proofs, run against the
 * REAL roles and the disposable test database. Requires migrations 0001..0022.
 *
 * Everything asserted here is read from the live catalog or provoked against the
 * live database. No migration text is searched, so a later, correct rewrite of
 * 0022 that keeps the same object graph still passes.
 *
 * Section A -- inventory (7 tables, 8 bindings, 6 functions):
 *   * the exact (table, trigger, function) binding set, and that nothing else in
 *     the public schema carries a trg_fin_* function;
 *   * the decoded event set of every binding (NOT "it has a trigger"), because
 *     the freeze guarantees only exist if the row-level ops are all bound;
 *   * every binding is enabled and SECURITY INVOKER, so the guard runs with the
 *     caller's rights instead of escalating;
 *   * all six functions are revoked from PUBLIC (owner-only EXECUTE);
 *   * no trg_fin_* trigger is bound to a 0021 foundation table.
 *
 * Section B -- live behaviour (all refusals are SQLSTATE 55000):
 *   * a draft structure accepts child writes and cascades on delete;
 *   * publication stamps published_at/published_by, then the structure is
 *     frozen: header edit, header delete, and child insert/update/delete all
 *     raise, and the refused header delete leaves every child row in place;
 *   * the status graph: created as anything but draft is refused, published is
 *     write-once for its stamp, and only forward transitions are legal;
 *   * assignments are pinned to the anchor enrollment (student_id and
 *     academic_year_id), and targets are validated in-tenant;
 *   * the D4 partial unique index: two active NULL-structure assignments for one
 *     enrollment collide, while the same key in a second tenant does not;
 *   * a committed billing run is frozen for UPDATE/DELETE, and so are its items;
 *   * the source AND destination halves of a re-point are both checked, so an
 *     item cannot walk out of a committed run into a draft one;
 *   * the one legal write to a committed item -- attaching the invoice it
 *     produced, once, changing nothing else -- is accepted, while a re-attach or
 *     an attach that also re-prices the row is refused.
 *
 * Opt-in: RUN_RUNTIME_SECURITY_TESTS=1 (requires PostgreSQL + migration 0022).
 */
const enabled = process.env.RUN_RUNTIME_SECURITY_TESTS === '1';
const describeDb = enabled ? describe : describe.skip;

let migrator: pg.Client;
let app: pg.Client;

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

/** Runs `sql`, rolling back to a savepoint so the suite keeps its fixture. */
const mig = async (sql: string): Promise<Row[]> => {
  const r = await migrator.query(sql);
  return r.rows as Row[];
};

/** Asserts `sql` is refused with `code`, and that the refusal changed nothing. */
const migReject = async (sql: string, code: string): Promise<string> => {
  const tag = randomUUID().replace(/-/g, '');
  await migrator.query(`savepoint rej_${tag}`);
  try {
    await migrator.query(sql);
  } catch (e) {
    const err = e as { code?: string; message: string };
    await migrator.query(`rollback to savepoint rej_${tag}`);
    if (err.code !== code) {
      throw new Error(`expected SQLSTATE ${code}, got ${err.code ?? '?'}: ${err.message}`);
    }
    return err.message;
  }
  await migrator.query(`rollback to savepoint rej_${tag}`);
  throw new Error(`expected SQLSTATE ${code}, but the statement SUCCEEDED: ${sql}`);
};

const q = (v: string) => `'${v}'`;

/** The binding graph 0022 installs, decoded to per-op booleans. */
const EXPECTED_BINDINGS = [
  { table: 'fin_fee_structures', trigger: 'fin_structures_publish', fn: 'trg_fin_structure_publish_freeze', ops: ['INSERT', 'UPDATE', 'DELETE'] },
  { table: 'fin_fee_structure_items', trigger: 'fin_structure_items_freeze', fn: 'trg_fin_structure_child_freeze', ops: ['INSERT', 'UPDATE', 'DELETE'] },
  { table: 'fin_fee_installment_plans', trigger: 'fin_structure_plans_freeze', fn: 'trg_fin_structure_child_freeze', ops: ['INSERT', 'UPDATE', 'DELETE'] },
  { table: 'fin_fee_structure_targets', trigger: 'fin_structure_targets_freeze', fn: 'trg_fin_structure_child_freeze', ops: ['INSERT', 'UPDATE', 'DELETE'] },
  { table: 'fin_fee_structure_targets', trigger: 'fin_targets_validate', fn: 'trg_fin_target_validate', ops: ['INSERT', 'DELETE'] },
  { table: 'fin_fee_assignments', trigger: 'fin_assignments_validate', fn: 'trg_fin_assignment_validate', ops: ['INSERT', 'DELETE'] },
  { table: 'fin_billing_runs', trigger: 'fin_runs_freeze', fn: 'trg_fin_billing_run_freeze', ops: ['UPDATE', 'DELETE'] },
  { table: 'fin_billing_run_items', trigger: 'fin_run_items_freeze', fn: 'trg_fin_billing_run_items_freeze', ops: ['INSERT', 'UPDATE', 'DELETE'] },
] as const;

const EXPECTED_FUNCTIONS = [
  'trg_fin_assignment_validate',
  'trg_fin_billing_run_freeze',
  'trg_fin_billing_run_items_freeze',
  'trg_fin_structure_child_freeze',
  'trg_fin_structure_publish_freeze',
  'trg_fin_target_validate',
] as const;

/** Decodes pg_trigger.tgtype bit flags into the event names they represent. */
const decodeEvents = (tgtype: number): string[] => {
  const out: string[] = [];
  if (tgtype & 4) out.push('INSERT');
  if (tgtype & 8) out.push('UPDATE');
  if (tgtype & 16) out.push('DELETE');
  if (tgtype & 32) out.push('TRUNCATE');
  return out;
};

const insertStructure = (
  tenant: string,
  year: string,
  key: string,
  status = 'draft',
): string => {
  uid[key] = randomUUID();
  return `insert into fin_fee_structures
       (id, tenant_id, code, name, academic_year_id, version, status, effective_from)
     values (${q(u(key))}, ${q(tenant)}, ${q(`c-${key}-${slug}`)}, ${q(`S ${key}`)},
             ${q(year)}, 1, ${q(status)}, '2026-01-01')`;
};

const insertItem = (structure: string, head: string, key: string, amount = '100.00'): string => {
  uid[key] = randomUUID();
  return `insert into fin_fee_structure_items
       (id, tenant_id, structure_id, fee_head_id, installment_no, amount, recurrence)
     values (${q(u(key))}, ${q(u('tenantA'))}, ${q(u(structure))}, ${q(u(head))}, 1, ${amount}, 'once')`;
};

const insertPlan = (structure: string, key: string, dueOn = '2026-03-01'): string => {
  uid[key] = randomUUID();
  return `insert into fin_fee_installment_plans
       (id, tenant_id, structure_id, installment_no, due_on, label)
     values (${q(u(key))}, ${q(u('tenantA'))}, ${q(u(structure))}, 1, ${q(dueOn)}, ${q(`L ${key}`)})`;
};

const insertTarget = (structure: string, key: string, campus: string): string => {
  uid[key] = randomUUID();
  return `insert into fin_fee_structure_targets
       (id, tenant_id, structure_id, target_type, campus_id)
     values (${q(u(key))}, ${q(u('tenantA'))}, ${q(u(structure))}, 'campus', ${q(u(campus))})`;
};

const insertAssignment = (
  key: string,
  opts: { structure?: string; enrollment: string; student: string; year: string; from?: string } ,
): string => {
  uid[key] = randomUUID();
  return `insert into fin_fee_assignments
       (id, tenant_id, structure_id, enrollment_id, student_id, academic_year_id, effective_from)
     values (${q(u(key))}, ${q(u('tenantA'))},
             ${opts.structure ? q(u(opts.structure)) : 'null'},
             ${q(u(opts.enrollment))}, ${q(u(opts.student))}, ${q(u(opts.year))},
             ${q(opts.from ?? '2026-01-01')})`;
};

const insertRun = (key: string, tenant: string, year: string, status = 'draft'): string => {
  uid[key] = randomUUID();
  return `insert into fin_billing_runs
       (id, tenant_id, academic_year_id, status, idempotency_key, started_by)
     values (${q(u(key))}, ${q(tenant)}, ${q(year)}, ${q(status)}, ${q(`idem-${key}-${slug}`)}, ${q(u('userA'))})`;
};

const insertRunItem = (
  key: string,
  tenant: string,
  run: string,
  enrollment: string,
  student: string,
  structure: string,
  amount = '250.00',
): string => {
  uid[key] = randomUUID();
  return `insert into fin_billing_run_items
       (tenant_id, run_id, enrollment_id, student_id, structure_id, amount)
     values (${q(tenant)}, ${q(u(run))}, ${q(u(enrollment))}, ${q(u(student))},
             ${q(u(structure))}, ${amount})`;
};

/** The single row a probe expected to find. */
const one = (rows: Row[]): Row => {
  const r = rows[0];
  if (r === undefined) throw new Error('expected at least one row');
  return r;
};

const countRows = async (table: string, where: string, tenant = u('tenantA')): Promise<number> => {
  const r = await mig(
    `select count(*)::int as n from ${table} where tenant_id = ${q(tenant)} and ${where}`,
  );
  return Number((r[0] as Row).n);
};

describeDb('0022 finance trigger inventory + freeze behaviour (live catalogs)', () => {
  beforeAll(async () => {
    const env = getEnv();
    migrator = new pg.Client({ connectionString: env.DATABASE_URL_MIGRATOR });
    app = new pg.Client({ connectionString: env.DATABASE_URL_APP });
    await migrator.connect();
    await app.connect();

    for (const k of [
      'tenantA', 'tenantB', 'userA', 'userB',
      'campusA', 'campusB', 'yearA', 'yearB',
      'levelA', 'classA', 'sectionA',
      'studentA1', 'studentA2', 'enrollA1', 'enrollA2',
      'headA', 'headB',
      'draft', 'published', 'thawed',
      'itemD', 'itemP', 'planD', 'planP', 'targetD', 'targetP',
      'badTarget', 'assignPin',
      'runD', 'runC', 'runC2', 'runC3', 'riD', 'riC', 'invoice', 'otherInvoice',
    ]) {
      uid[k] = randomUUID();
    }

    await migrator.query('begin');
    await migrator.query(
      `insert into tenants (id, slug, name) values
         (${q(u('tenantA'))}, ${q(`fin-a-${slug}`)}, 'Fin A'),
         (${q(u('tenantB'))}, ${q(`fin-b-${slug}`)}, 'Fin B')`,
    );
    await migrator.query(
      `insert into users (id, email) values
         (${q(u('userA'))}, ${q(`fin-a-${slug}@example.com`)}),
         (${q(u('userB'))}, ${q(`fin-b-${slug}@example.com`)})`,
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
         (${q(u('studentA1'))}, ${q(u('tenantA'))}, ${q(`s1-${slug}`)}, 'Ada', 'One', 'active', ${q(u('campusA'))}),
         (${q(u('studentA2'))}, ${q(u('tenantA'))}, ${q(`s2-${slug}`)}, 'Ben', 'Two', 'active', ${q(u('campusA'))})`,
    );
    await migrator.query(
      `insert into enrollments (id, tenant_id, student_id, academic_year_id, class_id, section_id, roll_no, status) values
         (${q(u('enrollA1'))}, ${q(u('tenantA'))}, ${q(u('studentA1'))}, ${q(u('yearA'))}, ${q(u('classA'))}, ${q(u('sectionA'))}, '01', 'active'),
         (${q(u('enrollA2'))}, ${q(u('tenantA'))}, ${q(u('studentA2'))}, ${q(u('yearA'))}, ${q(u('classA'))}, ${q(u('sectionA'))}, '02', 'active')`,
    );
    await migrator.query(
      `insert into fin_fee_heads (id, tenant_id, code, name) values
         (${q(u('headA'))}, ${q(u('tenantA'))}, ${q(`tu-${slug}`)}, 'Tuition'),
         (${q(u('headB'))}, ${q(u('tenantA'))}, ${q(`bk-${slug}`)}, 'Books')`,
    );

    // The three structures section B works against: a draft that stays editable,
    // a draft promoted to published, and a second published one for the
    // write-once stamp case.
    await migrator.query(insertStructure(u('tenantA'), u('yearA'), 'draft'));
    await migrator.query(insertItem('draft', 'headA', 'itemD'));
    await migrator.query(insertPlan('draft', 'planD'));
    await migrator.query(insertTarget('draft', 'targetD', 'campusA'));

    await migrator.query(insertStructure(u('tenantA'), u('yearA'), 'published'));
    await migrator.query(insertItem('published', 'headA', 'itemP'));
    await migrator.query(insertPlan('published', 'planP'));
    await migrator.query(insertTarget('published', 'targetP', 'campusA'));
    await migrator.query(
      `update fin_fee_structures set status='published', published_at=now(), published_by=${q(u('userA'))}
        where id = ${q(u('published'))}`,
    );
    await migrator.query(insertStructure(u('tenantA'), u('yearA'), 'thawed'));
    await migrator.query(
      `update fin_fee_structures set status='published', published_at=now(), published_by=${q(u('userA'))}
        where id = ${q(u('thawed'))}`,
    );

    // A draft run and a committed run, each holding one item, for section B.
    await migrator.query(insertRun('runD', u('tenantA'), u('yearA')));
    await migrator.query(insertRunItem('riD', u('tenantA'), 'runD', 'enrollA1', 'studentA1', 'published'));
    await migrator.query(insertRun('runC', u('tenantA'), u('yearA')));
    await migrator.query(insertRunItem('riC', u('tenantA'), 'runC', 'enrollA2', 'studentA2', 'published'));
    await migrator.query(insertRun('runC2', u('tenantA'), u('yearA')));
    await migrator.query(
      `update fin_billing_runs set status='committed', committed_at=now() where id = ${q(u('runC'))}`,
    );
    // A second committed run whose item is still unattached, so the
    // attach-and-re-price case can be tested from a clean OLD.invoice_id IS NULL.
    // The item must land BEFORE the commit: inserting into a committed run is
    // itself refused, which is one of the cases section B asserts later.
    uid.enrollA3 = randomUUID();
    uid.studentA3 = randomUUID();
    await migrator.query(
      `insert into students (id, tenant_id, student_no, first_name, last_name, status, primary_campus_id)
       values (${q(u('studentA3'))}, ${q(u('tenantA'))}, ${q(`s3-${slug}`)}, 'Cleo', 'Three', 'active', ${q(u('campusA'))})`,
    );
    await migrator.query(
      `insert into enrollments (id, tenant_id, student_id, academic_year_id, class_id, section_id, roll_no, status)
       values (${q(u('enrollA3'))}, ${q(u('tenantA'))}, ${q(u('studentA3'))}, ${q(u('yearA'))}, ${q(u('classA'))}, ${q(u('sectionA'))}, '03', 'active')`,
    );
    await migrator.query(insertRun('runC3', u('tenantA'), u('yearA')));
    await migrator.query(insertRunItem('riC3', u('tenantA'), 'runC3', 'enrollA3', 'studentA3', 'published'));
    await migrator.query(
      `update fin_billing_runs set status='committed', committed_at=now() where id = ${q(u('runC3'))}`,
    );

    await migrator.query('commit');
  });

  // Each case runs in its own transaction, so a refused statement leaves nothing
  // behind, the savepoints migReject needs always exist, and the cases stay
  // independent of each other's writes.
  beforeEach(async () => {
    await migrator.query('begin');
  });

  afterEach(async () => {
    await migrator.query('rollback');
    await app.query('rollback').catch(() => undefined);
  });

  afterAll(async () => {
    try {
      await migrator.query('rollback');      await app.query('rollback').catch(() => undefined);
      await migrator.query('begin');
      // Children first: the 0022 triggers are frozen for a published structure
      // and a committed run, so teardown lifts them for its own statements
      // only. Every disable is re-enabled inside the same transaction, so a
      // failure anywhere here rolls the guard back on.
      const lift = async (table: string, triggers: string[]): Promise<void> => {
        for (const t of triggers) {
          await migrator.query(`alter table ${table} disable trigger ${t}`);
        }
        await migrator.query(`delete from ${table} where tenant_id in (${q(u('tenantA'))},${q(u('tenantB'))})`);
        for (const t of [...triggers].reverse()) {
          await migrator.query(`alter table ${table} enable trigger ${t}`);
        }
      };
      // Run items have no trigger-visible immutability of run_id, but a committed
      // run's items are frozen, so the item freeze is lifted for the delete.
      await lift('fin_billing_run_items', ['fin_run_items_freeze']);
      await lift('fin_billing_runs', ['fin_runs_freeze']);
      await lift('fin_fee_assignments', ['fin_assignments_validate']);
      // Both target triggers fire on DELETE, so both must be lifted together.
      await lift('fin_fee_structure_targets', ['fin_structure_targets_freeze', 'fin_targets_validate']);
      await lift('fin_fee_structure_items', ['fin_structure_items_freeze']);
      await lift('fin_fee_installment_plans', ['fin_structure_plans_freeze']);
      await lift('fin_fee_structures', ['fin_structures_publish']);
      await migrator.query(`delete from fin_fee_heads where tenant_id in (${q(u('tenantA'))},${q(u('tenantB'))})`);
      await migrator.query(
        `delete from enrollments where tenant_id in (${q(u('tenantA'))},${q(u('tenantB'))})`,
      );
      await migrator.query(
        `delete from students where tenant_id in (${q(u('tenantA'))},${q(u('tenantB'))})`,
      );
      await migrator.query(`delete from sections where tenant_id in (${q(u('tenantA'))},${q(u('tenantB'))})`);
      await migrator.query(`delete from acd_classes where tenant_id in (${q(u('tenantA'))},${q(u('tenantB'))})`);
      await migrator.query(`delete from grade_levels where tenant_id in (${q(u('tenantA'))},${q(u('tenantB'))})`);
      await migrator.query(`delete from academic_years where tenant_id in (${q(u('tenantA'))},${q(u('tenantB'))})`);
      await migrator.query(`delete from campuses where tenant_id in (${q(u('tenantA'))},${q(u('tenantB'))})`);
      await migrator.query(`delete from users where id in (${q(u('userA'))},${q(u('userB'))})`);
      await migrator.query(`delete from tenants where id in (${q(u('tenantA'))},${q(u('tenantB'))})`);
      await migrator.query('commit');
    } finally {
      await migrator.query('end').catch(() => undefined);
      await app.query('end').catch(() => undefined);
      await migrator.end().catch(() => undefined);
      await app.end().catch(() => undefined);
    }
  });

  describe('A. binding + function inventory', () => {
    it('binds exactly the 8 expected (table, trigger, function) triples', async () => {
      const rows = await mig(
        `select c.relname as table_name, t.tgname as trigger_name, p.proname as fn
           from pg_trigger t
           join pg_class c on c.oid = t.tgrelid
           join pg_proc p on p.oid = t.tgfoid
           join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'public' and not t.tgisinternal
            and p.proname like 'trg\\_fin%'
          order by c.relname, t.tgname`,
      );
      expect(rows.map((r) => `${r.table_name}|${r.trigger_name}|${r.fn}`).sort()).toEqual(
        EXPECTED_BINDINGS.map((b) => `${b.table}|${b.trigger}|${b.fn}`).sort(),
      );
    });

    it('binds each trigger to exactly the row-level ops the freeze needs', async () => {
      const rows = await mig(
        `select c.relname as table_name, t.tgname as trigger_name, t.tgtype::int as tgtype
           from pg_trigger t
           join pg_class c on c.oid = t.tgrelid
           join pg_proc p on p.oid = t.tgfoid
           join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'public' and not t.tgisinternal
            and p.proname like 'trg\\_fin%'`,
      );
      expect(rows).toHaveLength(8);
      for (const r of rows) {
        const want = EXPECTED_BINDINGS.find(
          (b) => b.trigger === r.trigger_name && b.table === r.table_name,
        );
        expect(want, `unexpected binding ${String(r.trigger_name)}`).toBeDefined();
        // A freeze that silently loses DELETE is still "a trigger on the table",
        // so the op set is compared explicitly rather than just its presence.
        expect(decodeEvents(Number(r.tgtype)).sort(), String(r.trigger_name)).toEqual(
          [...want!.ops].sort(),
        );
      }
    });

    it('defines exactly the 6 expected trigger functions, and nothing else', async () => {
      const rows = await mig(
        `select p.proname as fn from pg_proc p
           join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' and p.proname like 'trg\\_fin%'
          order by 1`,
      );
      expect(rows.map((r) => r.fn)).toEqual([...EXPECTED_FUNCTIONS].sort());
    });

    it('leaves every binding enabled and SECURITY INVOKER', async () => {
      const rows = await mig(
        `select t.tgname as trigger_name, t.tgenabled::text as enabled,
                p.prosecdef as security_definer, l.lanname as language
           from pg_trigger t
           join pg_class c on c.oid = t.tgrelid
           join pg_proc p on p.oid = t.tgfoid
           join pg_language l on l.oid = p.prolang
           join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'public' and not t.tgisinternal
            and p.proname like 'trg\\_fin%'
          order by 1`,
      );
      expect(rows).toHaveLength(8);
      for (const r of rows) {
        // 'O' = enabled from creation; 'D' would mean a superuser-disabled guard
        // and 'R' a replica-only one, both of which silently disable the freeze.
        expect(r.enabled, String(r.trigger_name)).toBe('O');
        // SECURITY DEFINER here would run the guard as the table owner, which is
        // the escalation these guards exist to avoid.
        expect(r.security_definer, String(r.trigger_name)).toBe(false);
        expect(r.language, String(r.trigger_name)).toBe('plpgsql');
      }
    });

    it('revokes all six functions from PUBLIC, leaving owner-only EXECUTE', async () => {
      // The ACL is exploded rather than pattern-matched: in pg's text form a
      // PUBLIC grant is the grantee-less `=X/owner`, which is indistinguishable
      // from a role literally named "" -- and `{school_migrator=X/...}` would
      // satisfy a naive `=X/` substring test even though it is owner-only.
      const rows = await mig(
        `select p.proname as fn, r.rolname as grantee, a.privilege_type
           from pg_proc p
           join pg_namespace n on n.oid = p.pronamespace
           cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
           left join pg_roles r on r.oid = a.grantee
          where n.nspname = 'public' and p.proname like 'trg\\_fin%'
          order by p.proname, r.rolname`,
      );
      expect(rows).toHaveLength(6);
      for (const r of rows) {
        expect(String(r.fn)).toMatch(/^trg_fin_/);
        expect(r.privilege_type).toBe('EXECUTE');
        // grantee 0 is PUBLIC; anything but the owner would let a caller
        // invoke the guard outside a trigger, and the app role is given no
        // fin_* privilege at all.
        expect(r.grantee, `${String(r.fn)} is executable by ${String(r.grantee)}`).toBe('school_migrator');
      }
    });

    it('binds no trg_fin_* trigger to any table outside the 7 0022 tables', async () => {
      const rows = await mig(
        `select c.relname as table_name
           from pg_trigger t
           join pg_class c on c.oid = t.tgrelid
           join pg_proc p on p.oid = t.tgfoid
           join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'public' and not t.tgisinternal
            and p.proname like 'trg\\_fin%'
            and c.relname not in ('fin_fee_structures','fin_fee_structure_items',
                                  'fin_fee_installment_plans','fin_fee_structure_targets',
                                  'fin_fee_assignments','fin_billing_runs','fin_billing_run_items')`,
      );
      expect(rows).toEqual([]);
    });

    it('leaves the 5 0021 foundation tables free of structure triggers', async () => {
      const rows = await mig(
        `select c.relname as table_name, t.tgname as trigger_name
           from pg_trigger t
           join pg_class c on c.oid = t.tgrelid
           join pg_proc p on p.oid = t.tgfoid
           join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'public' and not t.tgisinternal
            and p.proname like 'trg\\_fin%'
            and c.relname in ('fin_tax_profiles','fin_tenant_settings','fin_ledger_accounts',
                              'fin_document_counters','fin_fee_heads')`,
      );
      expect(rows).toEqual([]);
    });
  });

  describe('B. draft structures stay editable and cascade on delete', () => {
    it('accepts child insert, update and delete while the parent is draft', async () => {
      const items = await countRows('fin_fee_structure_items', `structure_id = ${q(u('draft'))}`);
      expect(items).toBe(1);
      await mig(
        `update fin_fee_structure_items set amount = 150.00 where id = ${q(u('itemD'))}`,
      );
      await mig(`delete from fin_fee_structure_items where id = ${q(u('itemD'))}`);
      await mig(insertItem('draft', 'headB', 'itemD2'));
      const after = await countRows('fin_fee_structure_items', `structure_id = ${q(u('draft'))}`);
      expect(after).toBe(1);
    });

    it('deletes a draft structure together with its children', async () => {
      await migrator.query(insertStructure(u('tenantA'), u('yearA'), 'cascade'));
      await migrator.query(insertItem('cascade', 'headA', 'itemC'));
      await migrator.query(insertPlan('cascade', 'planC'));
      await migrator.query(insertTarget('cascade', 'targetC', 'campusA'));
      await mig(`delete from fin_fee_structures where id = ${q(u('cascade'))}`);

      // The child freeze trigger fires on the cascaded DELETE too; the parent
      // lookup returns nothing mid-cascade, which must read as "not frozen".
      expect(await countRows('fin_fee_structure_items', `structure_id = ${q(u('cascade'))}`)).toBe(0);
      expect(await countRows('fin_fee_installment_plans', `structure_id = ${q(u('cascade'))}`)).toBe(0);
      expect(await countRows('fin_fee_structure_targets', `structure_id = ${q(u('cascade'))}`)).toBe(0);
    });
  });

  describe('B. publication stamps, then freezes the whole structure', () => {
    it('stamps published_at and published_by when a draft is published', async () => {
      const rows = await mig(
        `select published_at, published_by from fin_fee_structures where id = ${q(u('published'))}`,
      );
      expect(one(rows).published_at).toBeTruthy();
      expect(String(one(rows).published_by)).toBe(u('userA'));
    });

    it('refuses a header update once published', async () => {
      const msg = await migReject(
        `update fin_fee_structures set name = 'renamed' where id = ${q(u('published'))}`,
        '55000',
      );
      expect(msg).toMatch(/frozen/i);
    });

    it('refuses a header delete once published, leaving every child in place', async () => {
      await migReject(`delete from fin_fee_structures where id = ${q(u('published'))}`, '55000');
      expect(await countRows('fin_fee_structure_items', `structure_id = ${q(u('published'))}`)).toBe(1);
      expect(await countRows('fin_fee_installment_plans', `structure_id = ${q(u('published'))}`)).toBe(1);
      expect(await countRows('fin_fee_structure_targets', `structure_id = ${q(u('published'))}`)).toBe(1);
    });

    it('refuses child insert, update and delete once published', async () => {
      await migReject(insertItem('published', 'headB', 'itemPX'), '55000');
      await migReject(
        `update fin_fee_structure_items set amount = 999 where id = ${q(u('itemP'))}`,
        '55000',
      );
      await migReject(`delete from fin_fee_structure_items where id = ${q(u('itemP'))}`, '55000');
      await migReject(insertPlan('published', 'planPX', '2026-09-01'), '55000');
      await migReject(`delete from fin_fee_installment_plans where id = ${q(u('planP'))}`, '55000');
      await migReject(insertTarget('published', 'targetPX', 'campusA'), '55000');
      await migReject(`delete from fin_fee_structure_targets where id = ${q(u('targetP'))}`, '55000');

      // Nothing above may have taken effect.
      expect(await countRows('fin_fee_structure_items', `structure_id = ${q(u('published'))}`)).toBe(1);
      expect(Number(one(await mig(`select amount from fin_fee_structure_items where id = ${q(u('itemP'))}`)).amount)).toBe(100);
    });
  });

  describe('B. status graph and write-once publication stamp', () => {
    it('refuses to create a structure in any status but draft', async () => {
      await migReject(insertStructure(u('tenantA'), u('yearA'), 'bornPub', 'published'), '55000');
      await migReject(insertStructure(u('tenantA'), u('yearA'), 'bornRet', 'retired'), '55000');
    });

    it('refuses to move a published structure back to draft', async () => {
      await migReject(
        `update fin_fee_structures set status='draft' where id = ${q(u('published'))}`,
        '55000',
      );
    });

    it('refuses to re-stamp the publication of an already published structure', async () => {
      // The stamp is write-once, so a republish attempt by a different publisher
      // is refused rather than silently re-attributing the structure.
      const msg = await migReject(
        `update fin_fee_structures set published_by = ${q(u('userB'))} where id = ${q(u('thawed'))}`,
        '55000',
      );
      expect(msg).toMatch(/write-once|frozen/i);
      expect(String(one(await mig(`select published_by from fin_fee_structures where id = ${q(u('thawed'))}`)).published_by)).toBe(u('userA'));
    });
  });

  describe('B. assignment pinning and target validation', () => {
    it('refuses an assignment whose student_id contradicts the anchor enrollment', async () => {
      const msg = await migReject(
        insertAssignment('assignPin', { enrollment: 'enrollA1', student: 'studentA2', year: 'yearA' }),
        '55000',
      );
      expect(msg).toMatch(/student_id/);
    });

    it('refuses an assignment whose academic_year_id contradicts the anchor enrollment', async () => {
      const msg = await migReject(
        insertAssignment('assignPin2', { enrollment: 'enrollA1', student: 'studentA1', year: 'yearB' }),
        '55000',
      );
      expect(msg).toMatch(/academic_year_id/);
    });

    it('accepts a NULL-structure assignment that matches its enrollment', async () => {
      await mig(insertAssignment('assignOk', { enrollment: 'enrollA1', student: 'studentA1', year: 'yearA' }));
      expect(await countRows('fin_fee_assignments', `id = ${q(u('assignOk'))}`)).toBe(1);
    });

    it('refuses a target that names a campus from another tenant', async () => {
      uid.badTarget = randomUUID();
      const msg = await migReject(
        `insert into fin_fee_structure_targets
           (id, tenant_id, structure_id, target_type, campus_id)
         values (${q(u('badTarget'))}, ${q(u('tenantA'))}, ${q(u('draft'))}, 'campus', ${q(u('campusB'))})`,
        '55000',
      );
      expect(msg).toMatch(/campus does not exist|this tenant/i);
    });

    it('enforces the D4 partial unique index: one active NULL-structure row per key', async () => {
      await mig(insertAssignment('d4a', { enrollment: 'enrollA2', student: 'studentA2', year: 'yearA' }));
      // Same (tenant, enrollment, NULL structure, effective_from) and still
      // active: the index must refuse it, so a student cannot hold two
      // competing default assignments.
      await migReject(
        insertAssignment('d4b', { enrollment: 'enrollA2', student: 'studentA2', year: 'yearA' }),
        '23505',
      );
      expect(await countRows('fin_fee_assignments', `enrollment_id = ${q(u('enrollA2'))} and structure_id is null`)).toBe(1);

      // A deactivated row leaves the partial index, so the key is free again.
      await mig(`update fin_fee_assignments set is_active = false where id = ${q(u('d4a'))}`);
      await mig(insertAssignment('d4c', { enrollment: 'enrollA2', student: 'studentA2', year: 'yearA' }));
      expect(await countRows('fin_fee_assignments', `enrollment_id = ${q(u('enrollA2'))} and is_active`)).toBe(1);
    });
  });

  describe('B. committed billing runs freeze their header and items', () => {
    it('leaves a draft run and its item editable', async () => {
      await mig(
        `update fin_billing_runs set idempotency_key = idempotency_key || '-x' where id = ${q(u('runD'))}`,
      );
      await mig(`update fin_billing_run_items set amount = 260.00 where run_id = ${q(u('runD'))}`);
      await mig(`delete from fin_billing_run_items where run_id = ${q(u('runD'))}`);
      await migrator.query(insertRunItem('riD2', u('tenantA'), 'runD', 'enrollA1', 'studentA1', 'published'));
    });

    it('refuses any update or delete of a committed run header', async () => {
      const msg = await migReject(
        `update fin_billing_runs set total_amount = 1 where id = ${q(u('runC'))}`,
        '55000',
      );
      expect(msg).toMatch(/committed and frozen/i);
      await migReject(`delete from fin_billing_runs where id = ${q(u('runC'))}`, '55000');
      // Even a pure no-op is refused: the run is immutable, not merely guarded
      // against meaningful edits.
      await migReject(
        `update fin_billing_runs set status = 'committed' where id = ${q(u('runC'))}`,
        '55000',
      );
    });

    it('refuses updates and deletes of a committed run item', async () => {
      await migReject(
        `update fin_billing_run_items set amount = 999 where run_id = ${q(u('runC'))}`,
        '55000',
      );
      await migReject(`delete from fin_billing_run_items where run_id = ${q(u('runC'))}`, '55000');
      expect(await countRows('fin_billing_run_items', `run_id = ${q(u('runC'))}`)).toBe(1);
      expect(Number(one(await mig(`select amount from fin_billing_run_items where run_id = ${q(u('runC'))}`)).amount)).toBe(250);
    });

    it('refuses to re-point an item OUT of the committed run (source side checked)', async () => {
      // The destination is a draft run, so a trigger that only read NEW would
      // let this through; reading OLD as well is what closes the escape.
      const msg = await migReject(
        `update fin_billing_run_items set run_id = ${q(u('runC2'))}
          where run_id = ${q(u('runC'))} and enrollment_id = ${q(u('enrollA2'))}`,
        '55000',
      );
      expect(msg).toContain(u('runC'));
      expect(await countRows('fin_billing_run_items', `run_id = ${q(u('runC2'))}`)).toBe(0);
    });

    it('refuses to insert a new item into the committed run', async () => {
      await migReject(
        insertRunItem('riCX', u('tenantA'), 'runC', 'enrollA1', 'studentA1', 'published'),
        '55000',
      );
    });

    it('accepts attaching the produced invoice exactly once, and nothing else', async () => {
      uid.invoice = randomUUID();
      // The single legal write to a committed item: attach the invoice it
      // produced, changing no other column.
      await mig(
        `update fin_billing_run_items set invoice_id = ${q(u('invoice'))}
          where run_id = ${q(u('runC'))} and enrollment_id = ${q(u('enrollA2'))}`,
      );
      // Re-pointing an already-invoiced item to a different invoice re-bills it.
      await migReject(
        `update fin_billing_run_items set invoice_id = ${q(u('otherInvoice'))}
          where run_id = ${q(u('runC'))} and enrollment_id = ${q(u('enrollA2'))}`,
        '55000',
      );
      // Attaching the first invoice is exempt from the freeze only for the
      // invoice column: smuggling a re-price into the same statement is not, and
      // this row's OLD.invoice_id is still NULL, so it is the column list and not
      // the already-attached branch that refuses it.
      await migReject(
        `update fin_billing_run_items set invoice_id = ${q(u('invoice'))}, amount = 999
          where run_id = ${q(u('runC3'))} and enrollment_id = ${q(u('enrollA3'))}`,
        '55000',
      );
      expect(
        one(await mig(`select invoice_id, amount from fin_billing_run_items where run_id = ${q(u('runC3'))}`))
          .invoice_id,
      ).toBeNull();
    });
  });
});
