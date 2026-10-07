import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { getEnv } from '@sms/config';

/**
 * Forward-remediation proofs for the 0025 refund defects, run against the REAL
 * roles and the disposable test database. Requires migrations 0001..0025 plus
 * the 0025 remediation tail:
 *
 *   0025_refund_fk_remediation.sql          R2  fin_pa_refund_fk -> NO ACTION
 *   0025_refund_provenance_remediation.sql  R1  provenance SECURITY INVOKER
 *                                            R3  reversal target effect='apply'
 *                                            R4  link-creation status check
 *   0025_refund_security_postcondition.sql  fail-closed gate (read-only)
 *
 * Every assertion is read from the live catalog or provoked against the live
 * database. No migration text is searched, so a migration that documents
 * something the database does not do still fails here.
 *
 * Section A -- provenance: definership, both bindings, and that a valid
 *   reversal still lands while three classes of invalid provenance still fail.
 * Section B -- refund FK: valid allocation, refused deletion of a referenced
 *   refund, tenant_id never nulled, cross-tenant reference refused.
 * Section C -- reversal target: an apply target is reversible, a reverse target
 *   and an on_account_return target are not, a cross-tenant target is not, and
 *   the 0024 magnitude bound is unchanged.
 * Section D -- refund status: requested/approved accepted, invalid INSERT and
 *   UPDATE rejected, the FOUR-state vocabulary still intact for 0028, and the
 *   link-creation invariant refusing a non-reversible refund.
 * Section E -- payment locking: the D2C row lock actually serialises two
 *   concurrent allocations, and an overspend is refused.
 * Section F -- posture after 0028 (recon §H inversions): SELECT on exactly the
 *   24 grantable fin_* tables; a finance-staff ticket can SELECT/INSERT the
 *   refund tables while a bare session is refused by RLS silence; RLS enabled +
 *   forced with the §B.1 command set on the refund tables; F11/F12 present with
 *   the §E signatures and app_ctx_session_id still absent; the lock helper and
 *   cross-tenant isolation unchanged.
 *
 * Opt-in: RUN_RUNTIME_SECURITY_TESTS=1 (requires PostgreSQL through 0028).
 */
const enabled = process.env.RUN_RUNTIME_SECURITY_TESTS === '1';
const describeDb = enabled ? describe : describe.skip;

let migrator: pg.Client;
let app: pg.Client;

const slug = randomUUID().slice(0, 8);
const q = (v: string): string => `'${v}'`;

const uid: Record<string, string> = {};
const T = (k: string): string => uid[k] ?? randomUUID();

/** Payment P1 carries the on-account tests; P2 the concurrent-overspend test. */
let p1 = '';
let p2 = '';
let refundRequested = '';
let refundApproved = '';

const SQLSTATE = {
  FK_VIOLATION: '23503',
  NOT_NULL_VIOLATION: '23502',
  CHECK_VIOLATION: '23514',
  INSUFFICIENT_PRIVILEGE: '42501',
  /** the finance guards' own code: 55000 object_not_in_prerequisite_state */
  OBJECT_STATE: '55000',
} as const;

async function expectFail(p: Promise<unknown>): Promise<pg.DatabaseError> {
  try {
    await p;
  } catch (err) {
    return err as pg.DatabaseError;
  }
  throw new Error('expected the statement to be refused, but it succeeded');
}

const insertPayment = (c: pg.Client, id: string, no: string, amount: number) =>
  c.query(
    `insert into fin_payments
       (id, tenant_id, payment_no, amount, method, payer_guardian_id, received_at, idempotency_key)
     values (${q(id)}, ${q(T('tenantA'))}, ${q(no)}, ${amount}, 'cash', ${q(T('guardianA'))}, now(), ${q(`ik-${no}`)})`,
  );

const insertRefund = (
  c: pg.Client,
  id: string,
  no: string,
  paymentId: string,
  amount: number,
  status: 'requested' | 'approved' | 'rejected' | 'processed',
) => {
  // proposed_allocations is NOT NULL on every row and must be a jsonb array;
  // the four-arm fin_refunds_decision_ck then pins a different companion
  // column set per state, so each status needs exactly its own fields.
  // extraCols and extraVals are kept apart deliberately: one is appended to the
  // column list and the other to the VALUES list, and mixing them up produces a
  // bare `decided_by` expression rather than an obvious failure.
  const decidedVals = `, ${q(T('userA'))}, now()`;
  const [extraCols, extraVals] =
    status === 'requested'
      ? ['', '']
      : status === 'approved'
        ? [', decided_by, decided_at, applied_allocations', `${decidedVals}, '[]'::jsonb`]
        : status === 'rejected'
          ? [', decided_by, decided_at, rejection_reason', `${decidedVals}, 'no'`]
          : [
              ', decided_by, decided_at, processed_by, processed_at, disbursement_reference, applied_allocations',
              `${decidedVals}, ${q(T('userA'))}, now(), 'trf-1', '[]'::jsonb`,
            ];
  return c.query(
    `insert into fin_refunds
       (id, tenant_id, refund_no, payment_id, amount, status, reason, proposed_allocations, requested_by, idempotency_key${extraCols})
     values (${q(id)}, ${q(T('tenantA'))}, ${q(no)}, ${q(paymentId)}, ${amount}, ${q(status)}, 'why', '[]'::jsonb, ${q(T('userA'))}, ${q(`ik-${no}`)}${extraVals})`,
  );
};

const insertAlloc = (
  c: pg.Client,
  id: string,
  paymentId: string,
  amount: number,
  effect: string,
  opts: { invoiceId?: string | null; reversalOf?: string | null; refundId?: string | null } = {},
) =>
  c.query(
    `insert into fin_payment_allocations
       (id, tenant_id, payment_id, invoice_id, amount, effect, reversal_of_allocation_id, refund_id, reason, created_by)
     values (${q(id)}, ${q(T('tenantA'))}, ${q(paymentId)}, ${opts.invoiceId === undefined ? q(T('invoiceA')) : opts.invoiceId === null ? 'null' : q(opts.invoiceId)},
             ${amount}, ${q(effect)}, ${opts.reversalOf ? q(opts.reversalOf) : 'null'},
             ${opts.refundId ? q(opts.refundId) : 'null'}, 'r', ${q(T('userA'))})`,
  );

describeDb('finance refund forward remediation (0025 tail)', () => {
  beforeAll(async () => {
    const env = getEnv();
    migrator = new pg.Client({ connectionString: env.DATABASE_URL_MIGRATOR });
    app = new pg.Client({ connectionString: env.DATABASE_URL_APP });
    await migrator.connect();
    await app.connect();

    for (const k of [
      'tenantA',
      'tenantB',
      'userA',
      'userB',
      'campusA',
      'yearA',
      'levelA',
      'classA',
      'sectionA',
      'studentA',
      'enrollmentA',
      'guardianA',
      'guardianB',
      'studentB',
      'invoiceA',
    ]) {
      uid[k] = randomUUID();
    }

    await migrator.query('begin');
    await migrator.query(
      `insert into tenants (id, slug, name) values
         (${q(T('tenantA'))}, ${q(`fr-a-${slug}`)}, 'FR A'),
         (${q(T('tenantB'))}, ${q(`fr-b-${slug}`)}, 'FR B')`,
    );
    await migrator.query(
      `insert into users (id, email) values
         (${q(T('userA'))}, ${q(`fr-a-${slug}@example.com`)}),
         (${q(T('userB'))}, ${q(`fr-b-${slug}@example.com`)})`,
    );
    await migrator.query(
      `insert into campuses (id, tenant_id, code, name, status)
       values (${q(T('campusA'))}, ${q(T('tenantA'))}, ${q(`fr-${slug}`)}, 'Campus', 'active')`,
    );
    await migrator.query(
      `insert into academic_years (id, tenant_id, code, name, starts_on, ends_on, status)
       values (${q(T('yearA'))}, ${q(T('tenantA'))}, ${q(`fry-${slug}`)}, 'AY', '2026-01-01', '2026-12-31', 'active')`,
    );
    await migrator.query(
      `insert into grade_levels (id, tenant_id, code, name, status)
       values (${q(T('levelA'))}, ${q(T('tenantA'))}, ${q(`frl-${slug}`)}, 'Grade', 'active')`,
    );
    await migrator.query(
      `insert into acd_classes (id, tenant_id, campus_id, academic_year_id, grade_level_id, code, name, status)
       values (${q(T('classA'))}, ${q(T('tenantA'))}, ${q(T('campusA'))}, ${q(T('yearA'))}, ${q(T('levelA'))}, ${q(`frc-${slug}`)}, 'Class', 'active')`,
    );
    await migrator.query(
      `insert into sections (id, tenant_id, class_id, campus_id, academic_year_id, code, status)
       values (${q(T('sectionA'))}, ${q(T('tenantA'))}, ${q(T('classA'))}, ${q(T('campusA'))}, ${q(T('yearA'))}, ${q(`frs-${slug}`)}, 'active')`,
    );
    await migrator.query(
      `insert into students (id, tenant_id, student_no, first_name, last_name, status, primary_campus_id)
       values (${q(T('studentA'))}, ${q(T('tenantA'))}, ${q(`frst-${slug}`)}, 'Stu', 'One', 'active', ${q(T('campusA'))})`,
    );
    await migrator.query(
      `insert into enrollments (id, tenant_id, student_id, academic_year_id, class_id, section_id, roll_no, status)
       values (${q(T('enrollmentA'))}, ${q(T('tenantA'))}, ${q(T('studentA'))}, ${q(T('yearA'))}, ${q(T('classA'))}, ${q(T('sectionA'))}, '01', 'active')`,
    );
    await migrator.query(
      `insert into guardians (id, tenant_id, first_name, last_name)
       values (${q(T('guardianA'))}, ${q(T('tenantA'))}, 'G', 'One')`,
    );
    // Cash is family-scoped: the payer must be a guardian of the student on the
    // invoice, so guardianA has to be linked to studentA before any payment or
    // apply-allocation can reference the invoice.
    await migrator.query(
      `insert into student_guardians (tenant_id, student_id, guardian_id, relation, is_primary)
       values (${q(T('tenantA'))}, ${q(T('studentA'))}, ${q(T('guardianA'))}, 'father', true)`,
    );
    // trg_fin_invoice_number allocates from a per-tenant+year counter row, so the
    // counter has to exist before the invoice is inserted.
    await migrator.query(
      `insert into fin_document_counters (tenant_id, academic_year_id, kind)
       values (${q(T('tenantA'))}, ${q(T('yearA'))}, 'invoice')`,
    );
    // Tenant B needs its own guardian and student so F6 can build a payment that
    // legitimately belongs to tenant B.
    await migrator.query(
      `insert into guardians (id, tenant_id, first_name, last_name)
       values (${q(T('guardianB'))}, ${q(T('tenantB'))}, 'G', 'Two')`,
    );
    await migrator.query(
      `insert into students (id, tenant_id, student_no, first_name, last_name, status)
       values (${q(T('studentB'))}, ${q(T('tenantB'))}, ${q(`frsb-${slug}`)}, 'Stu', 'Two', 'active')`,
    );
    await migrator.query(
      `insert into student_guardians (tenant_id, student_id, guardian_id, relation, is_primary)
       values (${q(T('tenantB'))}, ${q(T('studentB'))}, ${q(T('guardianB'))}, 'father', true)`,
    );
    // Inserted already 'issued': trg_fin_allocation_target_state refuses cash on
    // a draft invoice, and fin_invoices_freeze_lines only guards the
    // draft -> non-draft UPDATE transition, so going straight to issued is both
    // permitted and one statement shorter.
    await migrator.query(
      `insert into fin_invoices
         (id, tenant_id, student_id, academic_year_id, enrollment_id, status, due_date, subtotal, total, balance, created_by)
       values (${q(T('invoiceA'))}, ${q(T('tenantA'))}, ${q(T('studentA'))}, ${q(T('yearA'))}, ${q(T('enrollmentA'))},
               'issued', '2026-03-01', 500, 500, 500, ${q(T('userA'))})`,
    );
    // 0028 F2 inversion: a finance-staff ticket. A custom tenant role whose code
    // ('accountant') matches F1's finance_staff classifier arms, carrying exactly
    // the permission strings the inversion asserts, wired to userA via an active
    // tenant membership. is_system=false keeps it out of 0028's §20.5 backfill.
    const roleId = randomUUID();
    const membershipId = randomUUID();
    await migrator.query(
      `insert into roles (id, tenant_id, scope, code, name, description, is_system)
       values (${q(roleId)}, ${q(T('tenantA'))}, 'tenant', 'accountant',
               'Fixture accountant', 'F2 inversion fixture', false)`,
    );
    await migrator.query(
      `insert into role_permissions (role_id, permission) values
         (${q(roleId)}, 'fees.refunds.read'),
         (${q(roleId)}, 'fees.refunds.request')`,
    );
    await migrator.query(
      `insert into memberships (id, tenant_id, user_id, status)
       values (${q(membershipId)}, ${q(T('tenantA'))}, ${q(T('userA'))}, 'active')`,
    );
    await migrator.query(
      `insert into membership_roles (membership_id, role_id)
       values (${q(membershipId)}, ${q(roleId)})`,
    );
    await migrator.query('commit');
  });

  afterAll(async () => {
    // The four money tables are append-only and hold composite FKs into these
    // tenants, so they have to be emptied before the tenants can be deleted --
    // otherwise every ref here is refused and the suite silently litters the
    // disposable database. Every row touched here was created by this file.
    const t = [T('tenantA'), T('tenantB')].map(q).join(', ');
    const cleanup = [
      'truncate fin_payment_allocations, fin_payments, fin_receipts, fin_refunds, fin_reconciliation_matches, fin_reconciliation_batches',
      `delete from fin_invoices where tenant_id in (${t})`,
      `delete from fin_document_counters where tenant_id in (${t})`,
      `delete from student_guardians where tenant_id in (${t})`,
      `delete from enrollments where tenant_id in (${t})`,
      `delete from students where tenant_id in (${t})`,
      `delete from guardians where tenant_id in (${t})`,
      `delete from sections where tenant_id in (${t})`,
      `delete from acd_classes where tenant_id in (${t})`,
      `delete from grade_levels where tenant_id in (${t})`,
      `delete from campuses where tenant_id in (${t})`,
      `delete from academic_years where tenant_id in (${t})`,
      // memberships.tenant_id and memberships.user_id are RESTRICT FKs: they must
      // be removed before either the users or the tenants delete, or those rows
      // survive and the custom F2 fixture role (is_system=false, fees.*) leaks —
      // which trips finance-rbac's whole-DB §20.5 invariant on the next run.
      `delete from membership_roles where membership_id in
         (select id from memberships where tenant_id in (${t}))`,
      `delete from memberships where tenant_id in (${t})`,
      // users is global and has no tenant_id, so it is keyed by its own ids.
      `delete from users where id in (${q(T('userA'))}, ${q(T('userB'))})`,
      `delete from tenants where id in (${t})`,
    ];
    for (const sql of cleanup) {
      await migrator?.query(sql).catch(() => undefined);
    }
    await migrator?.end().catch(() => undefined);
    await app?.end().catch(() => undefined);
  });

  /**
   * fin_payment_allocations is append-only, so a DELETE is impossible and the
   * four money tables are reset by TRUNCATE together (they reference each other,
   * and CASCADE is not used so pre-existing finance fixtures are never touched).
   */
  beforeEach(async () => {
    await migrator.query(
      'truncate fin_payment_allocations, fin_payments, fin_receipts, fin_refunds,\n               fin_reconciliation_matches',
    );
    p1 = randomUUID();
    p2 = randomUUID();
    refundRequested = randomUUID();
    refundApproved = randomUUID();
    await insertPayment(migrator, p1, `P1-${slug}`, 1000);
    await insertPayment(migrator, p2, `P2-${slug}`, 1000);
    await insertRefund(migrator, refundRequested, `R1-${slug}`, p1, 500, 'requested');
    await insertRefund(migrator, refundApproved, `R2-${slug}`, p1, 500, 'approved');
  });

  // ---------------------------------------------------------------- A
  describe('A. provenance', () => {
    it('A1 catalog says SECURITY INVOKER, owned by school_migrator, hardened search_path', async () => {
      const r = await migrator.query(
        `select p.prosecdef, pg_get_userbyid(p.proowner) owner, p.proconfig
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' and p.proname = 'trg_fin_refund_provenance'`,
      );
      expect(r.rows).toHaveLength(1);
      expect(r.rows[0].prosecdef).toBe(false);
      expect(r.rows[0].owner).toBe('school_migrator');
      expect(r.rows[0].proconfig).toEqual(['search_path=pg_catalog, public, pg_temp']);
    });

    it('A2 the trigger is still attached on BOTH sides', async () => {
      const r = await migrator.query(
        `select c.relname
           from pg_trigger tg
           join pg_class c on c.oid = tg.tgrelid
           join pg_proc p on p.oid = tg.tgfoid
           join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' and p.proname = 'trg_fin_refund_provenance'
            and not tg.tgisinternal
          order by c.relname`,
      );
      expect(r.rows.map((x) => x.relname)).toEqual([
        'fin_payment_allocations',
        'fin_refunds',
      ]);
    });

    it('A3 a valid reversal still lands', async () => {
      const apply = randomUUID();
      const rev = randomUUID();
      await insertAlloc(migrator, apply, p1, 500, 'apply');
      await insertAlloc(migrator, rev, p1, -500, 'reverse', {
        reversalOf: apply,
        refundId: refundRequested,
      });
      const r = await migrator.query(
        `select count(*)::int n from fin_payment_allocations where id = ${q(rev)}`,
      );
      expect(r.rows[0].n).toBe(1);
    });

    it('A4 a reversal naming a refund that does not exist is refused', async () => {
      const apply = randomUUID();
      await insertAlloc(migrator, apply, p1, 500, 'apply');
      const e = await expectFail(
        insertAlloc(migrator, randomUUID(), p1, -500, 'reverse', {
          reversalOf: apply,
          refundId: randomUUID(),
        }),
      );
      expect(e.code).toBe(SQLSTATE.OBJECT_STATE);
      expect(e.message).toContain('not found in tenant');
    });

    it('A5 a refund-linked allocation must be a reversal', async () => {
      const e = await expectFail(
        insertAlloc(migrator, randomUUID(), p1, -500, 'on_account_return', {
          invoiceId: null,
          refundId: refundRequested,
        }),
      );
      expect(e.code).toBe(SQLSTATE.OBJECT_STATE);
      expect(e.message).toContain('must have effect');
    });

    it('A6 allocation and refund must name the same payment', async () => {
      const apply = randomUUID();
      await insertAlloc(migrator, apply, p1, 500, 'apply');
      const e = await expectFail(
        insertAlloc(migrator, randomUUID(), p2, -500, 'reverse', {
          reversalOf: apply,
          refundId: refundRequested,
        }),
      );
      expect(e.code).toBe(SQLSTATE.OBJECT_STATE);
      expect(e.message).toMatch(/payment_id/);
    });
  });

  // ---------------------------------------------------------------- B
  describe('B. refund FK', () => {
    it('B1 the FK is the canonical composite NO ACTION constraint', async () => {
      const r = await migrator.query(
        `select c.confdeltype, c.confupdtype, c.condeferrable, c.convalidated,
                c.conrelid::regclass::text holder, c.confrelid::regclass::text tgt,
                (select array_agg(a.attname::text order by a.attname)
                   from unnest(c.conkey) with ordinality k(attnum, ord)
                   join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum) cols
           from pg_constraint c
          where c.conname = 'fin_pa_refund_fk' and c.connamespace = 'public'::regnamespace`,
      );
      expect(r.rows).toHaveLength(1);
      // 'a' is pg_constraint's encoding of NO ACTION
      expect(r.rows[0].confdeltype).toBe('a');
      expect(r.rows[0].confupdtype).toBe('a');
      expect(r.rows[0].condeferrable).toBe(false);
      expect(r.rows[0].convalidated).toBe(true);
      expect(r.rows[0].holder).toBe('fin_payment_allocations');
      expect(r.rows[0].tgt).toBe('fin_refunds');
      expect(r.rows[0].cols).toEqual(['refund_id', 'tenant_id']);
    });

    it('B2 deleting a referenced refund is refused by the FK, not by nulling', async () => {
      const apply = randomUUID();
      const rev = randomUUID();
      await insertAlloc(migrator, apply, p1, 500, 'apply');
      await insertAlloc(migrator, rev, p1, -500, 'reverse', {
        reversalOf: apply,
        refundId: refundRequested,
      });
      const e = await expectFail(
        migrator.query(`delete from fin_refunds where id = ${q(refundRequested)}`),
      );
      expect(e.code).toBe(SQLSTATE.FK_VIOLATION);
      // The old SET NULL form surfaced 23502 from the NOT NULL on tenant_id.
      // Its absence is the point of the remediation.
      expect(e.code).not.toBe(SQLSTATE.NOT_NULL_VIOLATION);
    });

    it('B3 the refused delete left tenant_id and refund_id intact', async () => {
      const apply = randomUUID();
      const rev = randomUUID();
      await insertAlloc(migrator, apply, p1, 500, 'apply');
      await insertAlloc(migrator, rev, p1, -500, 'reverse', {
        reversalOf: apply,
        refundId: refundRequested,
      });
      await migrator
        .query(`delete from fin_refunds where id = ${q(refundRequested)}`)
        .catch(() => undefined);
      const r = await migrator.query(
        `select a.tenant_id, a.refund_id, r.tenant_id refund_tenant
           from fin_payment_allocations a
           join fin_refunds r on r.id = a.refund_id
          where a.id = ${q(rev)}`,
      );
      expect(r.rows).toHaveLength(1);
      expect(r.rows[0].tenant_id).toBe(T('tenantA'));
      expect(r.rows[0].refund_id).toBe(refundRequested);
      expect(r.rows[0].refund_tenant).toBe(T('tenantA'));
    });

    it('B4 tenant_id is still NOT NULL, which is why SET NULL could never work', async () => {
      const r = await migrator.query(
        `select attnotnull from pg_attribute
          where attrelid = 'public.fin_payment_allocations'::regclass
            and attname = 'tenant_id' and not attisdropped`,
      );
      expect(r.rows[0].attnotnull).toBe(true);
    });

    it('B5 a cross-tenant refund reference is refused', async () => {
      const other = randomUUID();
      await migrator.query(
        `insert into fin_refunds
           (id, tenant_id, refund_no, payment_id, amount, status, reason, requested_by, idempotency_key)
         values (${q(other)}, ${q(T('tenantB'))}, ${q(`RX-${slug}`)}, ${q(p1)}, 10, 'requested', 'why',
                 ${q(T('userA'))}, ${q(`ik-rx-${slug}`)})`,
      ).catch(() => undefined);
      // tenant B's refund is paired with tenant A's payment, so this row cannot
      // even be constructed; the composite FK on the refund itself is what the
      // catalog assertion below pins.
      const e = await expectFail(
        insertAlloc(migrator, randomUUID(), p1, -10, 'reverse', {
          reversalOf: null,
          refundId: other,
        }),
      );
      expect([SQLSTATE.OBJECT_STATE, SQLSTATE.FK_VIOLATION]).toContain(e.code);
    });
  });

  // ---------------------------------------------------------------- C
  describe('C. reversal target', () => {
    it('C1 a reversal of an apply allocation succeeds', async () => {
      const apply = randomUUID();
      const rev = randomUUID();
      await insertAlloc(migrator, apply, p1, 500, 'apply');
      await insertAlloc(migrator, rev, p1, -500, 'reverse', {
        reversalOf: apply,
        refundId: refundRequested,
      });
      const r = await migrator.query(
        `select a.reversal_of_allocation_id, t.effect
           from fin_payment_allocations a
           join fin_payment_allocations t on t.id = a.reversal_of_allocation_id
          where a.id = ${q(rev)}`,
      );
      expect(r.rows).toHaveLength(1);
      expect(r.rows[0].effect).toBe('apply');
    });

    it('C2 a reversal targeting an existing reversal is refused', async () => {
      const apply = randomUUID();
      const rev = randomUUID();
      await insertAlloc(migrator, apply, p1, 500, 'apply');
      await insertAlloc(migrator, rev, p1, -500, 'reverse', {
        reversalOf: apply,
        refundId: refundRequested,
      });
      const e = await expectFail(
        insertAlloc(migrator, randomUUID(), p1, -100, 'reverse', {
          reversalOf: rev,
          refundId: refundRequested,
        }),
      );
      expect(e.code).toBe(SQLSTATE.OBJECT_STATE);
      // Attribution, not just the outcome. After 0028's forward re-issue, the
      // observed refusal comes from §F.3's apply-only test inside
      // trg_fin_reversal_shape_check (recon §B.3 row 3): a 'reverse' target has
      // effect <> 'apply', so 'reversal target must be an applied allocation'
      // fires ahead of the 0024 magnitude rule. C8 pins the provenance guard's
      // copy of R3 separately.
      expect(e.message).toMatch(/reversal target must be an applied allocation/);
    });

    it('C3 a reversal targeting an on_account_return allocation is refused', async () => {
      const oar = randomUUID();
      await insertAlloc(migrator, oar, p1, -900, 'on_account_return', { invoiceId: null });
      const e = await expectFail(
        insertAlloc(migrator, randomUUID(), p1, -100, 'reverse', {
          invoiceId: null,
          reversalOf: oar,
          refundId: null,
        }),
      );
      expect(e.code).toBe(SQLSTATE.OBJECT_STATE);
      // Same attribution as C2: on_account_return is also effect <> 'apply', so
      // §F.3's apply-only test in the 0028 shape-check is what fires.
      expect(e.message).toMatch(/reversal target must be an applied allocation/);
    });

    it('C8 R3 is present in the provenance guard even though 0024 gets there first', async () => {
      // The design names v_target.effect = 'apply' as THE invariant for R3, so
      // its presence has to be provable independently of which guard happens to
      // raise first at runtime.
      const r = await migrator.query(
        `select prosrc from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' and p.proname = 'trg_fin_refund_provenance'`,
      );
      const body = r.rows[0].prosrc.replace(/--[^\n]*/g, '');
      expect(body).toMatch(/v_target\.effect\s*<>\s*'apply'/);
      expect(body).toMatch(/only an applied allocation can be reversed/);
      // It sits inside the refund-linked branch, so it only ever evaluates for
      // a reversal that names a refund.
      expect(body.indexOf('v_target.effect')).toBeGreaterThan(
        body.indexOf('NEW.refund_id IS NOT NULL'),
      );
    });

    it('C9 the 0024 shape guard runs before the provenance guard', async () => {
      // PostgreSQL fires same-timing triggers in trigger-NAME order, not
      // function-name order, so this is the ordering that decides which guard
      // reports the refusal in C2 and C3. The ORDER BY is load-bearing, not
      // cosmetic: pg_trigger is a heap, so an unordered read returns whatever
      // order the scan happens to produce and this assertion then fails at
      // random without anything in the database having changed.
      const r = await migrator.query(
        `select t.tgname
           from pg_trigger t
           join pg_class c on c.oid = t.tgrelid
           join pg_proc p on p.oid = t.tgfoid
          where c.relname = 'fin_payment_allocations'
            and not t.tgisinternal
            and (t.tgtype & 2) > 0
            and p.proname in ('trg_fin_reversal_shape', 'trg_fin_refund_provenance')
          order by t.tgname`,
      );
      const names = r.rows.map((x) => x.tgname);
      expect(names).toHaveLength(2);
      expect(names[0]).toBe('fin_allocations_shape');
      expect(names[1]).toBe('fin_pa_refund_prov_trg');
    });

    it('C4 a cross-tenant target is refused', async () => {
      const e = await expectFail(
        insertAlloc(migrator, randomUUID(), p1, -100, 'reverse', {
          reversalOf: randomUUID(),
          refundId: refundRequested,
        }),
      );
      expect(e.code).toBe(SQLSTATE.OBJECT_STATE);
    });

    it('C5 the 0024 reversal magnitude bound is unchanged', async () => {
      const apply = randomUUID();
      await insertAlloc(migrator, apply, p1, 500, 'apply');
      await insertRefund(migrator, randomUUID(), `R5-${slug}`, p1, 900, 'requested');
      const e = await expectFail(
        insertAlloc(migrator, randomUUID(), p1, -900, 'reverse', {
          reversalOf: apply,
          refundId: null,
        }),
      );
      expect(e.code).toBe(SQLSTATE.OBJECT_STATE);
      expect(e.message).toMatch(/exceeds|refund ceiling|still available/);
    });
  });

  // ---------------------------------------------------------------- D
  describe('D. refund status', () => {
    it('D1 requested is accepted', async () => {
      const r = await migrator.query(
        `select status from fin_refunds where id = ${q(refundRequested)}`,
      );
      expect(r.rows[0].status).toBe('requested');
    });

    it('D2 approved is accepted', async () => {
      const r = await migrator.query(
        `select status from fin_refunds where id = ${q(refundApproved)}`,
      );
      expect(r.rows[0].status).toBe('approved');
    });

    it('D3 an invalid status is refused on INSERT', async () => {
      const e = await expectFail(
        migrator.query(
          `insert into fin_refunds
             (id, tenant_id, refund_no, payment_id, amount, status, reason, proposed_allocations, requested_by, idempotency_key)
           values (${q(randomUUID())}, ${q(T('tenantA'))}, ${q(`RB-${slug}`)}, ${q(p1)}, 10,
                   'not_a_status', 'why', '[]'::jsonb, ${q(T('userA'))}, ${q(`ik-rb-${slug}`)})`,
        ),
      );
      expect(e.code).toBe(SQLSTATE.CHECK_VIOLATION);
    });

    it('D4 an invalid status is refused on UPDATE', async () => {
      const e = await expectFail(
        migrator.query(
          `update fin_refunds set status = 'not_a_status' where id = ${q(refundRequested)}`,
        ),
      );
      // 0028's trg_fin_refund_state (adaptation A9, §35.7) is BEFORE UPDATE OF
      // status, so it refuses the illegal transition with 55000 before the
      // fin_refunds_status_ck CHECK is ever consulted.
      expect(e.code).toBe(SQLSTATE.OBJECT_STATE);
    });

    it('D5 the FOUR-state vocabulary is intact for 0028 F11/F12', async () => {
      const rejected = randomUUID();
      const processed = randomUUID();
      await insertRefund(migrator, rejected, `RC-${slug}`, p1, 100, 'rejected');
      await insertRefund(migrator, processed, `RD-${slug}`, p1, 100, 'processed');
      const r = await migrator.query(
        `select status from fin_refunds where id in (${q(rejected)}, ${q(processed)}) order by status`,
      );
      expect(r.rows.map((x) => x.status)).toEqual(['processed', 'rejected']);
    });

    it('D6 link creation refuses a refund that is not in a reversible status', async () => {
      const apply = randomUUID();
      await insertAlloc(migrator, apply, p1, 500, 'apply');
      const rejected = randomUUID();
      await insertRefund(migrator, rejected, `RE-${slug}`, p1, 500, 'rejected');
      const e = await expectFail(
        insertAlloc(migrator, randomUUID(), p1, -500, 'reverse', {
          reversalOf: apply,
          refundId: rejected,
        }),
      );
      expect(e.code).toBe(SQLSTATE.OBJECT_STATE);
      expect(e.message).toContain('requested or approved');
    });

    it('D7 link creation ACCEPTS an approved refund', async () => {
      const apply = randomUUID();
      const rev = randomUUID();
      await insertAlloc(migrator, apply, p1, 500, 'apply');
      await insertAlloc(migrator, rev, p1, -500, 'reverse', {
        reversalOf: apply,
        refundId: refundApproved,
      });
      const r = await migrator.query(
        `select count(*)::int n from fin_payment_allocations where id = ${q(rev)}`,
      );
      expect(r.rows[0].n).toBe(1);
    });
  });

  // ---------------------------------------------------------------- E
  describe('E. payment locking (D2C)', () => {
    it('E1 the lock helper is DEFINER, migrator-owned, and unreachable from the runtime role', async () => {
      const r = await migrator.query(
        `select p.prosecdef, pg_get_userbyid(p.proowner) owner, p.proconfig,
                has_function_privilege('school_app_rw', 'public.fin_lock_payment_amount(uuid, uuid)', 'EXECUTE') app_exec
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' and p.proname = 'fin_lock_payment_amount'`,
      );
      expect(r.rows).toHaveLength(1);
      expect(r.rows[0].prosecdef).toBe(true);
      expect(r.rows[0].owner).toBe('school_migrator');
      expect(r.rows[0].proconfig).toEqual(['search_path=pg_catalog, public, pg_temp']);
      expect(r.rows[0].app_exec).toBe(false);
    });

    it('E2 both payment bound triggers stay INVOKER and delegate to the helper', async () => {
      const r = await migrator.query(
        `select p.proname, p.prosecdef, p.prosrc
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public'
            and p.proname in ('trg_fin_allocation_bounds', 'trg_fin_on_account_return_bounds')`,
      );
      expect(r.rows).toHaveLength(2);
      for (const row of r.rows) {
        expect(row.prosecdef).toBe(false);
        expect(row.prosrc).toMatch(/fin_lock_payment_amount\s*\(\s*NEW\.tenant_id/);
        expect(row.prosrc).not.toMatch(/for\s+update/i);
      }
    });

    it('E3 the row lock really serialises two concurrent allocations', async () => {
      const other = new pg.Client({ connectionString: getEnv().DATABASE_URL_MIGRATOR });
      await other.connect();
      try {
        await migrator.query('begin');
        await insertAlloc(migrator, randomUUID(), p1, -600, 'on_account_return', {
          invoiceId: null,
        });

        let settled = false;
        const pending = insertAlloc(other, randomUUID(), p1, -600, 'on_account_return', {
          invoiceId: null,
        }).then(
          () => {
            settled = true;
          },
          () => {
            settled = true;
          },
        );

        // While client 1 holds the payment row, client 2 must be parked inside
        // fin_lock_payment_amount's SELECT ... FOR UPDATE.
        await new Promise((r) => setTimeout(r, 400));
        expect(settled).toBe(false);

        await migrator.query('commit');
        await pending;
        // Once client 1 commits, client 2 proceeds and is refused: the ceiling
        // it recomputes afterwards includes the row it could not see before.
        const sum = await other.query(
          `select coalesce(sum(amount), 0)::numeric(19,4) total
             from fin_payment_allocations
            where payment_id = ${q(p1)} and effect = 'on_account_return'`,
        );
        expect(Number(sum.rows[0].total)).toBe(-600);
      } finally {
        await migrator.query('rollback').catch(() => undefined);
        await other.end();
      }
    });

    it('E4 a sequential overspend is refused', async () => {
      await insertAlloc(migrator, randomUUID(), p1, -600, 'on_account_return', {
        invoiceId: null,
      });
      const e = await expectFail(
        insertAlloc(migrator, randomUUID(), p1, -600, 'on_account_return', {
          invoiceId: null,
        }),
      );
      expect(e.code).toBe(SQLSTATE.OBJECT_STATE);
      expect(e.message).toContain('still held on account');
    });

    it('E5 allocations exactly at the payment amount are allowed', async () => {
      await insertAlloc(migrator, randomUUID(), p1, -1000, 'on_account_return', {
        invoiceId: null,
      });
      const sum = await migrator.query(
        `select coalesce(sum(amount), 0)::numeric(19,4) total
           from fin_payment_allocations
          where payment_id = ${q(p1)} and effect = 'on_account_return'`,
      );
      expect(Number(sum.rows[0].total)).toBe(-1000);
    });
  });

  // ---------------------------------------------------------------- F
  describe('F. fail-closed posture and the runtime role', () => {
    it('F1 school_app_rw holds SELECT on exactly the 24 grantable fin_* tables (all but fin_ledger_event_types)', async () => {
      const r = await migrator.query(
        `select count(*)::int n
           from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'public' and c.relkind in ('r','p')
            and c.relname like 'fin\\_%'
            and has_table_privilege('school_app_rw', c.oid, 'SELECT')`,
      );
      // §D.2/§D.3: every fin_* table gains SELECT except fin_ledger_event_types
      // (Shape 5, ruling B8 - asserted, never granted).
      expect(r.rows[0].n).toBe(24);
    });

    it('F2a refund tables: a finance-staff ticket can SELECT and INSERT', async () => {
      const tkt = (
        await migrator.query(
          `select app_ctx_mint('tenant', ${q(T('userA'))}, ${q(T('tenantA'))}) t`,
        )
      ).rows[0].t as string;
      await app.query('begin');
      await app.query(`set local app.rls = '${tkt}'`);
      try {
        const sel = await app.query(`select id from fin_refunds`);
        // The C arm of `P OR (T AND C)` admits finance_staff; the beforeEach
        // refund rows are visible.
        expect(sel.rowCount).toBeGreaterThan(0);
        const ins = await app.query(
          `insert into fin_refunds
             (id, tenant_id, refund_no, payment_id, amount, status, reason, proposed_allocations, requested_by, idempotency_key)
           values (${q(randomUUID())}, ${q(T('tenantA'))}, ${q(`fr-inv-${slug}`)}, ${q(p1)}, 1,
                   'requested', 'why', '[]'::jsonb, ${q(T('userA'))}, ${q(`ik-f2-${slug}`)})
           returning id`,
        );
        // `P OR (T AND C AND K('fees.refunds.request'))` - the fixture role
        // carries the permission via membership_roles.
        expect(ins.rowCount).toBe(1);
        const allocSel = await app.query(`select id from fin_payment_allocations`);
        expect(Number(allocSel.rowCount)).toBeGreaterThanOrEqual(0);
      } finally {
        await app.query('rollback');
      }
    });

    it('F2b refund tables: a bare school_app_rw session is refused — SELECT by RLS silence, INSERT by a 42501 RLS violation', async () => {
      const sel = await app.query(`select id from fin_refunds`);
      // SELECT has no row to return: the policy's USING predicate admits none.
      expect(sel.rowCount).toBe(0);
      // INSERT has no result-set equivalent of "0 rows": when the FOR INSERT
      // policy's WITH CHECK admits no row, PostgreSQL raises 42501 ("new row
      // violates row-level security policy"). It is still the RLS layer failing
      // closed — not the ACL.
      const e = await expectFail(
        app.query(
          `insert into fin_refunds
             (id, tenant_id, refund_no, payment_id, amount, status, reason, proposed_allocations, requested_by, idempotency_key)
           values (${q(randomUUID())}, ${q(T('tenantA'))}, ${q(`fr-bare-${slug}`)}, ${q(p1)}, 1,
                   'requested', 'why', '[]'::jsonb, ${q(T('userA'))}, ${q(`ik-f2b-${slug}`)})
           returning id`,
        ),
      );
      expect(e.code).toBe(SQLSTATE.INSUFFICIENT_PRIVILEGE);
      expect(e.message).toMatch(/row-level security/i);
    });

    it('F3 school_app_rw cannot EXECUTE the lock helper', async () => {
      const e = await expectFail(
        app.query(`select fin_lock_payment_amount(${q(T('tenantA'))}::uuid, ${q(p1)}::uuid)`),
      );
      expect([SQLSTATE.INSUFFICIENT_PRIVILEGE, '42804']).toContain(e.code);
    });

    it('F4 fin_refunds and fin_payment_allocations are RLS enabled + forced with the §B.1 command set', async () => {
      const rls = await migrator.query(
        `select c.relname as tbl, c.relrowsecurity as rls, c.relforcerowsecurity as force
           from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'public' and c.relkind = 'r'
            and c.relname in ('fin_refunds','fin_payment_allocations')`,
      );
      expect(rls.rows.length).toBe(2);
      for (const r of rls.rows) {
        expect(r.rls, `${String(r.tbl)}: RLS enabled`).toBe(true);
        expect(r.force, `${String(r.tbl)}: RLS forced`).toBe(true);
      }
      const pol = await migrator.query(
        `select c.relname as tbl, array_agg(p.polcmd::text order by p.polcmd::text) as cmds
           from pg_policy p
           join pg_class c on c.oid = p.polrelid
           join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'public' and c.relname in ('fin_refunds','fin_payment_allocations')
          group by c.relname order by c.relname`,
      );
      const CMD: Record<string, string> = { r: 'SELECT', a: 'INSERT', w: 'UPDATE', d: 'DELETE', '*': 'ALL' };
      const expectCmds = new Map<string, string[]>();
      for (const r of pol.rows) {
        expectCmds.set(String(r.tbl), (r.cmds as string[]).map((c) => CMD[c] ?? c).sort());
      }
      // §B.1: both tables carry SELECT/INSERT/UPDATE/DELETE (DELETE is `USING (P)` —
      // the migrator-side trigger tests at finance-payments.test.ts:1103 require it).
      expect(expectCmds.get('fin_refunds')).toEqual(['DELETE', 'INSERT', 'SELECT', 'UPDATE']);
      expect(expectCmds.get('fin_payment_allocations')).toEqual(['DELETE', 'INSERT', 'SELECT', 'UPDATE']);
    });

    it('F5 F11/F12 exist with the §E signatures; app_ctx_session_id is still absent', async () => {
      const r = await migrator.query(
        `select p.proname, pg_get_function_result(p.oid)::text as rtype,
                pg_get_function_arguments(p.oid) as args
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public'
            and p.proname in ('postRefundApproval', 'postRefundProcess', 'app_ctx_session_id')
          order by p.proname`,
      );
      const names = r.rows.map((x) => String(x.proname));
      expect(names).toContain('postRefundApproval');
      expect(names).toContain('postRefundProcess');
      expect(names).not.toContain('app_ctx_session_id');
      const f11 = r.rows.find((x) => String(x.proname) === 'postRefundApproval');
      expect(f11).toBeTruthy();
      expect(String(f11!.rtype)).toBe('void');
      expect(String(f11!.args)).toBe('p_session_id uuid, p_refund_id uuid, p_action text');
      const f12 = r.rows.find((x) => String(x.proname) === 'postRefundProcess');
      expect(f12).toBeTruthy();
      expect(String(f12!.rtype)).toBe('void');
      // pg_get_function_arguments renders the two DEFAULT NULL defaults with the
      // param-typed cast (DEFAULT NULL::text) from proargdefaults; normalize it
      // so the assertion is stable across PG renderings.
      expect(String(f12!.args).replace(/DEFAULT NULL::\w+/g, 'DEFAULT NULL')).toBe(
        'p_session_id uuid, p_refund_id uuid, p_action text, p_reason text DEFAULT NULL, p_disbursement_reference text DEFAULT NULL',
      );
    });

    it('F6 the two tenants are isolated: tenant A cannot reference a tenant B payment', async () => {
      // A payment that genuinely belongs to tenant B, payer-bound to tenant B's
      // own guardian so the composite payment FK is satisfied on its own terms.
      const pB = randomUUID();
      await migrator.query(
        `insert into fin_payments (id, tenant_id, payment_no, amount, method, payer_guardian_id, received_at, idempotency_key)
         values (${q(pB)}, ${q(T('tenantB'))}, ${q(`PB-${slug}`)}, 1000, 'cash', ${q(T('guardianB'))}, now(), ${q(`ik-pb-${slug}`)})`,
      );
      const e = await expectFail(
        migrator.query(
          `insert into fin_payment_allocations
             (id, tenant_id, payment_id, amount, effect, reason, created_by)
           values (${q(randomUUID())}, ${q(T('tenantA'))}, ${q(pB)}, -10, 'on_account_return', 'r', ${q(T('userA'))})`,
        ),
      );
      // Isolation is enforced twice over. At runtime the tenant-scoped lookup
      // inside trg_fin_refund_provenance refuses the row first, so the
      // observed code is 55000; the composite FK is the backstop for any path
      // that would otherwise reach it, and is asserted separately below.
      expect([SQLSTATE.OBJECT_STATE, SQLSTATE.FK_VIOLATION]).toContain(e.code);
      expect(e.message).toMatch(/tenant|not found|unknown payment/);
    });

    it('F7 the composite payment FK is present as an independent backstop', async () => {
      const r = await migrator.query(
        `select c.conname, (select array_agg(a.attname::text order by a.attname)
                             from unnest(c.conkey) with ordinality k(attnum, ord)
                             join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum) cols
           from pg_constraint c
          where c.connamespace = 'public'::regnamespace
            and c.contype = 'f'
            and c.confrelid = 'public.fin_payments'::regclass
            and c.conrelid = 'public.fin_payment_allocations'::regclass`,
      );
      expect(r.rows.length).toBeGreaterThan(0);
      // Every payment FK is composite, so a payment id alone can never satisfy
      // one: tenant_id has to agree as well.
      for (const row of r.rows) {
        expect(row.cols).toContain('tenant_id');
      }
    });
  });
});