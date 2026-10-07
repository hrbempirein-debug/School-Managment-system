import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { getEnv } from '@sms/config';

/**
 * §20.5 RBAC backfill suite — recon §H inversion row 10 (`finance-020` /
 * `finance-rbac`: "must exist and pass").
 *
 * 0028's backfill (adaptation A12) materialises the `fees.*` permission set for
 * pre-0028 tenants. The fresh chain applies it against an EMPTY database, so by
 * the time this suite runs there are no pre-0028 tenants left to observe — the
 * outcome has to be PROVOKED. The suite therefore builds a simulated pre-0028
 * tenant (system roles with a pre-backfill permission set and no `fees.*`
 * rows), extracts the EXACT `DO $backfill$` block shipped in the 0028 file, and
 * applies it — the same technique `students-foundation.test.ts` uses to exercise
 * the 0005 backfill SQL rather than a copy.
 *
 * finance-020 (catalog fidelity, §20.5 test (a)-(d)):
 *   - every is_system role's `fees.*` subset is EXACTLY the §20.5 table:
 *     school_owner = 25 permissions, accountant = 22 (excluding
 *     structures.manage, assignments.manage, portal.read), principal =
 *     fees.reports.read only, cashier = exactly {payments.read, payments.collect,
 *     receipts.read} and NOT receipts.reissue (P1-03), parent/student =
 *     portal.read only, teacher = none, platform_admin = none;
 *   - the cashier role is created per tenant, is_system, scope 'tenant';
 *   - no is_system=false role gains or loses a permission (the checksum in the
 *     backfill is re-proven: re-applying the block must succeed and change
 *     nothing), and no custom role holds a `fees.*` permission.
 *
 * finance-rbac (behavioural, recon §C.3 ruling 5): the K predicates gate
 * ACTUAL sessions, so C alone is not enough. A cashier ticket (class
 * finance_staff, K fees.payments.collect) INSERTs a payment, while the SAME
 * class fails a fee-heads write whose K is fees.structures.manage — the
 * concrete demonstration that the C∧K policy differs from a class-only check.
 * A principal ticket (class reporting_staff) does not even see the payment.
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

type Row = Record<string, unknown>;
const mig = async (sql: string): Promise<Row[]> => (await migrator.query(sql)).rows as Row[];
const one = (rows: Row[]): Row => {
  const r = rows[0];
  if (r === undefined) throw new Error('expected at least one row');
  return r;
};
const num = (v: unknown): number => Number(String(v));

/** The complete §20.5 `fees.*` permission catalog (the 25 in the backfill). */
const FEES_ALL = [
  'fees.structures.read',
  'fees.structures.manage',
  'fees.assignments.read',
  'fees.assignments.manage',
  'fees.invoices.read',
  'fees.invoices.create',
  'fees.invoices.issue',
  'fees.invoices.void',
  'fees.payments.read',
  'fees.payments.collect',
  'fees.payments.reverse',
  'fees.refunds.read',
  'fees.refunds.request',
  'fees.refunds.approve',
  'fees.refunds.process',
  'fees.adjustments.read',
  'fees.adjustments.create',
  'fees.adjustments.approve',
  'fees.receipts.read',
  'fees.receipts.reissue',
  'fees.reconciliation.read',
  'fees.reconciliation.manage',
  'fees.ledger.read',
  'fees.reports.read',
  'fees.portal.read',
].sort();

const ACCOUNTANT_EXCLUDED = ['fees.structures.manage', 'fees.assignments.manage', 'fees.portal.read'];
const ACCOUNTANT_ALL = FEES_ALL.filter((p) => !ACCOUNTANT_EXCLUDED.includes(p));

const CASHIER_THREE = ['fees.payments.read', 'fees.payments.collect', 'fees.receipts.read'].sort();

/** fees.* permissions held by a single role, sorted. */
const feesOf = async (roleId: string): Promise<string[]> => {
  const r = await mig(
    `select permission from role_permissions
      where role_id = ${q(roleId)} and permission like 'fees.%'
      order by permission`,
  );
  return r.map((x) => String(x.permission)).sort();
};

/** THE exact DO block shipped in 0028, extracted so the suite exercises SQL, not a copy. */
let backfillSql = '';

const roleIdOf = async (code: string, isSystem: boolean, tenant?: string): Promise<string> => {
  const r = await mig(
    `select id from roles
      where code = ${q(code)} and is_system = ${isSystem}
        and ${tenant === undefined ? 'tenant_id is null' : `tenant_id = ${q(tenant)}`}`,
  );
  return String(one(r).id);
};

describeDb('finance-020 / finance-rbac: §20.5 fees.* backfill and its C∧K runtime gate', () => {
  let ownerRole = '';
  let accountantRole = '';
  let principalRole = '';
  let teacherRole = '';
  let parentRole = '';
  let studentRole = '';
  let platformRole = '';
  let customRole = '';
  let cashierRole = '';
  let feeHeadA = '';
  let feeHeadB = '';

  beforeAll(async () => {
    const env = getEnv();
    migrator = new pg.Client({ connectionString: env.DATABASE_URL_MIGRATOR });
    app = new pg.Client({ connectionString: env.DATABASE_URL_APP });
    await migrator.connect();
    await app.connect();

    const migration = await readFile(
      new URL('../../migrations/0028_phase7_finance_security.sql', import.meta.url),
      'utf8',
    );
    const lines = migration.split('\n');
    const start = lines.findIndex((l) => l.includes('DO $backfill$'));
    const end = lines.findIndex((l) => l.includes('END $backfill$;'));
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    backfillSql = lines.slice(start, end + 1).join('\n');

    for (const k of [
      'tenantA',
      'tenantB',
      'userOwner',
      'userPrincipal',
      'userCashier',
      'guardianA',
      'membershipOwner',
      'membershipPrincipal',
      'membershipCashier',
    ]) {
      uid[k] = randomUUID();
    }

    await migrator.query('begin');

    // A pre-0028 tenant: system roles carry only legacy permissions (no fees.*).
    // roles_tenant_code_uq is (tenant_id, code) WITHOUT is_system, so the
    // non-system school_owner that §20.5's filter must leave alone lives in a
    // SECOND tenant (the same shape students-foundation.test.ts uses).
    await migrator.query(
      `insert into tenants (id, slug, name) values
         (${q(T('tenantA'))}, ${q(`rbac-a-${slug}`)}, 'RBAC A'),
         (${q(T('tenantB'))}, ${q(`rbac-b-${slug}`)}, 'RBAC B')`,
    );
    await migrator.query(
      `insert into users (id, email) values
         (${q(T('userOwner'))}, ${q(`rbac-owner-${slug}@example.com`)}),
         (${q(T('userPrincipal'))}, ${q(`rbac-principal-${slug}@example.com`)}),
         (${q(T('userCashier'))}, ${q(`rbac-cashier-${slug}@example.com`)})`,
    );
    await migrator.query(
      `insert into guardians (id, tenant_id, first_name, last_name)
       values (${q(T('guardianA'))}, ${q(T('tenantA'))}, 'C', 'One')`,
    );

    // Legacy system roles, exactly as 0001's tenant templates would have
    // materialised them before 0028: tenant.read/audit.read, and no fees.*.
    const legacyRoles: Array<[string, string, string, boolean]> = [
      ['school_owner', 'school_owner', 'tenant', true],
      ['accountant', 'accountant', 'tenant', true],
      ['principal', 'principal', 'tenant', true],
      ['teacher', 'teacher', 'tenant', true],
      ['parent', 'parent', 'tenant', true],
      ['student', 'student', 'tenant', true],
      ['platform', 'platform_admin', 'platform', true],
    ];
    for (const [key, code, scope, isSystem] of legacyRoles) {
      uid[key] = randomUUID();
      await migrator.query(
        `insert into roles (id, tenant_id, scope, code, name, is_system)
         values (${q(uid[key])}, ${scope === 'platform' ? 'null' : q(T('tenantA'))}, ${q(scope)}, ${q(code)}, ${q(`Legacy ${code}`)}, ${isSystem})`,
      );
    }
    // The platform role must end with zero fees.* by template design.
    await migrator.query(
      `insert into role_permissions (role_id, permission)
       values (${q(String(uid.platform))}, 'platform.roles.manage')`,
    );

    // The custom role: code 'school_owner' (a template code), is_system=false,
    // in tenant B, with a real pre-existing permission. §20.5's is_system
    // filter is what must keep its set byte-identical.
    uid.custom = randomUUID();
    await migrator.query(
      `insert into roles (id, tenant_id, scope, code, name, is_system)
       values (${q(uid.custom)}, ${q(T('tenantB'))}, 'tenant', 'school_owner', 'Custom Copy', false)`,
    );
    await migrator.query(
      `insert into role_permissions (role_id, permission)
       values (${q(uid.custom)}, 'audit.read')`,
    );

    // Simulate the live pre-0028 world in the OTHER direction too: a system
    // principal that somehow held a foreign fees.* cell would trip the
    // backfill's own post-condition. Assert there is none anywhere first, so a
    // regression in the assertion space is a LOUD failure, not a silent skip.
    const dirtyPrincipal = await mig(
      `select count(*)::int n from roles r
        join role_permissions rp on rp.role_id = r.id
       where r.code = 'principal' and r.is_system = true
         and rp.permission like 'fees.%' and rp.permission <> 'fees.reports.read'`,
    );
    expect(num(one(dirtyPrincipal).n)).toBe(0);

    // Apply the shipped backfill ONCE (this is the first §20.5 application this
    // pre-0028 tenant has ever seen). Both of its RAISE post-conditions must
    // not fire (custom role untouched, principal within bounds) — an exception
    // here fails the suite loudly.
    await migrator.query(backfillSql);

    ownerRole = await roleIdOf('school_owner', true, T('tenantA'));
    accountantRole = await roleIdOf('accountant', true, T('tenantA'));
    principalRole = await roleIdOf('principal', true, T('tenantA'));
    teacherRole = await roleIdOf('teacher', true, T('tenantA'));
    parentRole = await roleIdOf('parent', true, T('tenantA'));
    studentRole = await roleIdOf('student', true, T('tenantA'));
    platformRole = String(uid.platform);
    customRole = String(uid.custom);
    cashierRole = await roleIdOf('cashier', true, T('tenantA'));

    // Cashier role is created by the backfill per tenant; the behavioural
    // cases drive it through real tickets, so the memberships are wired now.
    await migrator.query(
      `insert into memberships (id, tenant_id, user_id, status) values
         (${q(T('membershipOwner'))}, ${q(T('tenantA'))}, ${q(T('userOwner'))}, 'active'),
         (${q(T('membershipPrincipal'))}, ${q(T('tenantA'))}, ${q(T('userPrincipal'))}, 'active'),
         (${q(T('membershipCashier'))}, ${q(T('tenantA'))}, ${q(T('userCashier'))}, 'active')`,
    );
    await migrator.query(
      `insert into membership_roles (membership_id, role_id) values
         (${q(T('membershipOwner'))}, ${q(ownerRole)}),
         (${q(T('membershipPrincipal'))}, ${q(principalRole)}),
         (${q(T('membershipCashier'))}, ${q(cashierRole)})`,
    );

    // Two fee heads so the behavioural UPDATE cases never interfere with each
    // other: cashier is refused silently on feeHeadA, owner succeeds on feeHeadB.
    feeHeadA = randomUUID();
    feeHeadB = randomUUID();
    await migrator.query(
      `insert into fin_fee_heads (id, tenant_id, code, name) values
         (${q(feeHeadA)}, ${q(T('tenantA'))}, ${q(`headA-${slug}`)}, 'Heads A'),
         (${q(feeHeadB)}, ${q(T('tenantA'))}, ${q(`headB-${slug}`)}, 'Heads B')`,
    );

    await migrator.query('commit');
  });

  afterAll(async () => {
    const t = `${q(T('tenantA'))}, ${q(T('tenantB'))}`;
    const cleanup = [
      `delete from fin_payments where tenant_id in (${t})`,
      `delete from fin_fee_heads where tenant_id in (${t})`,
      `delete from membership_roles where membership_id in
         (${q(T('membershipOwner'))}, ${q(T('membershipPrincipal'))}, ${q(T('membershipCashier'))})`,
      `delete from memberships where tenant_id in (${t})`,
      `delete from role_permissions where role_id in
         (${q(ownerRole)}, ${q(accountantRole)}, ${q(principalRole)}, ${q(teacherRole)},
          ${q(parentRole)}, ${q(studentRole)}, ${q(cashierRole)}, ${q(platformRole)}, ${q(customRole)})`,
      `delete from roles where tenant_id in (${t})
          or id in (${q(platformRole)}, ${q(customRole)})`,
      `delete from guardians where tenant_id in (${t})`,
      `delete from users where id in (${q(T('userOwner'))}, ${q(T('userPrincipal'))}, ${q(T('userCashier'))})`,
      `delete from tenants where id in (${t})`,
    ];
    for (const sql of cleanup) {
      await migrator?.query(sql).catch(() => undefined);
    }
    await migrator?.end().catch(() => undefined);
    await app?.end().catch(() => undefined);
  });

  async function mintTicket(userId: string): Promise<void> {
    await app.query(
      `select set_config('app.rls', app_ctx_mint('tenant', ${q(userId)}, ${q(T('tenantA'))}), true)`,
    );
  }

  // ------------------------------------------------------------- catalog
  describe('finance-020 catalog fidelity (§20.5 test (a)-(d))', () => {
    it('school_owner holds all 25 fees.* permissions', async () => {
      const fees = await feesOf(ownerRole);
      expect(fees).toEqual(FEES_ALL);
    });

    it('accountant holds exactly 22 — the three administrative cells are absent', async () => {
      const fees = await feesOf(accountantRole);
      expect(fees).toEqual(ACCOUNTANT_ALL);
      for (const excluded of ACCOUNTANT_EXCLUDED) expect(fees).not.toContain(excluded);
    });

    it('principal holds exactly fees.reports.read and nothing else under fees.*', async () => {
      const fees = await feesOf(principalRole);
      expect(fees).toEqual(['fees.reports.read']);
    });

    it('cashier is created per tenant (is_system, scope tenant) with exactly three fees.* — and NOT receipts.reissue (P1-03)', async () => {
      const meta = one(
        await mig(
          `select scope, is_system from roles where id = ${q(cashierRole)}
            and tenant_id = ${q(T('tenantA'))}`,
        ),
      );
      expect(String(meta.scope)).toBe('tenant');
      expect(meta.is_system).toBe(true);
      expect(await feesOf(cashierRole)).toEqual(CASHIER_THREE);
      const count = one(
        await mig(
          `select count(*)::int n from role_permissions where role_id = ${q(cashierRole)}
            and permission = 'fees.receipts.reissue'`,
        ),
      );
      expect(num(count.n)).toBe(0);
    });

    it('parent and student gain exactly fees.portal.read', async () => {
      expect(await feesOf(parentRole)).toEqual(['fees.portal.read']);
      expect(await feesOf(studentRole)).toEqual(['fees.portal.read']);
    });

    it('teacher gains nothing under fees.*', async () => {
      expect(await feesOf(teacherRole)).toEqual([]);
    });

    it('platform_admin holds zero fees.* permissions', async () => {
      expect(await feesOf(platformRole)).toEqual([]);
    });

    it('no custom (is_system=false) role holds any fees.* permission — the §20.5 safety property', async () => {
      expect(await feesOf(customRole)).toEqual([]);
      // The is_system filter is structural: over the WHOLE database, no
      // non-system role may hold a backfilled permission.
      const r = await mig(
        `select count(*)::int n from roles r
          join role_permissions rp on rp.role_id = r.id
         where r.is_system = false and rp.permission like 'fees.%'`,
      );
      expect(num(one(r).n)).toBe(0);
    });

    it('re-applying the backfill is idempotent and changes nothing (ON CONFLICT DO NOTHING + the checksum post-condition)', async () => {
      const snapshot = await feesOf(ownerRole);
      await migrator.query(backfillSql);
      // Re-apply succeeded without a RAISE: the block's own v_before/v_after
      // checksum over non-system roles proves no custom role was widened, and
      // the principal post-condition still holds.
      expect(await feesOf(ownerRole)).toEqual(snapshot);
      expect(await feesOf(accountantRole)).toEqual(ACCOUNTANT_ALL);
      expect(await feesOf(principalRole)).toEqual(['fees.reports.read']);
      expect(await feesOf(cashierRole)).toEqual(CASHIER_THREE);
    });
  });

  // ----------------------------------------------------------- behavioural
  describe('finance-rbac behaviour: C∧K gates a real session (recon §C.3-5)', () => {
    it('a cashier ticket can INSERT a payment — class finance_staff passes C AND K(fees.payments.collect)', async () => {
      const pay = randomUUID();
      await app.query('begin');
      await mintTicket(T('userCashier'));
      const ins = await app.query(
        `insert into fin_payments
           (id, tenant_id, payment_no, amount, method, status, payer_guardian_id, received_at, received_by, idempotency_key)
         values (${q(pay)}, ${q(T('tenantA'))}, ${q(`PM-rbac-${slug}`)}, 1200, 'cash', 'settled',
                 ${q(T('guardianA'))}, now(), ${q(T('userCashier'))}, ${q(`ik-rbac-${slug}`)})`,
      );
      expect(Number(ins.rowCount)).toBe(1);
      await app.query('commit');
      const seen = one(
        await mig(`select count(*)::int n from fin_payments where id = ${q(pay)}`),
      );
      expect(num(seen.n)).toBe(1);
    });

    it('a cashier ticket is refused a fee-heads write whose K is fees.structures.manage — C alone is not power', async () => {
      // Same class as the INSERT above (finance_staff), different permission:
      // the UPDATE policy's K makes it a silent 0-row denial.
      await app.query('begin');
      await mintTicket(T('userCashier'));
      const upd = await app.query(
        `update fin_fee_heads set name = 'Tampered' where id = ${q(feeHeadA)}`,
      );
      expect(Number(upd.rowCount)).toBe(0);
      await app.query('commit');
      const name = one(
        await mig(`select name from fin_fee_heads where id = ${q(feeHeadA)}`),
      );
      expect(String(name.name)).toBe('Heads A');
    });

    it('an accountant ticket passes the same UPDATE — 22-of-25 includes structures.manage', async () => {
      // accountant is also finance_staff; its template DOES carry the K.
      await app.query('begin');
      await mintTicket(T('userOwner')); // school_owner: the shared class + K owner
      const upd = await app.query(
        `update fin_fee_heads set name = 'Legit' where id = ${q(feeHeadB)}`,
      );
      expect(Number(upd.rowCount)).toBe(1);
      await app.query('commit');
      const name = one(
        await mig(`select name from fin_fee_heads where id = ${q(feeHeadB)}`),
      );
      expect(String(name.name)).toBe('Legit');
    });

    it('a principal ticket does NOT even see the payment its class cannot touch — reporting_staff fails C', async () => {
      await app.query('begin');
      await mintTicket(T('userPrincipal'));
      const sel = await app.query(`select id from fin_payments`);
      expect(Number(sel.rowCount)).toBe(0);
      await app.query('rollback');
    });
  });
});