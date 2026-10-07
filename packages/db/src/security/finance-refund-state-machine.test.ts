import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { getEnv } from '@sms/config';

/**
 * Refund command-handler state machine — 0028's F11/F12.
 *
 * The trigger suite (finance-trigger-inventory) proves `fin_refunds_state_trg`
 * exists and the D section of finance-refund-remediation proves the four-state
 * vocabulary and the rejected-INSERT/UPDATE sides. This suite proves the
 * MACHINE at the command-handler level: what `postRefundApproval` and
 * `postRefundProcess` actually DO to a live refund when driven through
 * school_app_rw with a finance ticket:
 *
 *   requested --postRefundApproval--> approved --postRefundProcess--> processed
 *   requested --postRefundProcess('reject')--> rejected
 *
 * plus the refusals (§35.7 rows 5,6,7; self-approval; missing reason; missing
 * disbursement reference; non-approve action), the idempotent replays, and the
 * F8 step-up binding. The step-up contract is asserted honestly:
 *
 *   F11/F12 PERFORM app_consume_step_up(session, action, ..., NULL) and DISCARD
 *   its boolean, so the DB functions themselves are NOT the enforcement point —
 *   the API route must verify the caller-supplied challenge code with
 *   app_consume_step_up BEFORE invoking the handler. A NULL/missing challenge is
 *   therefore absorbed: it either decrements the challenge's attempts_left
 *   (T7) or finds nothing and returns FALSE (T6), and in BOTH cases the
 *   transition still lands. The suite pins that observable so it stays
 *   documented, not accidentally "fixed" into a false sense of DB-enforced
 *   step-up.
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

const now = Math.floor(Date.now() / 1000).toString(16).slice(-6);
let n = 0;
const uniq = (): string => `${slug}-${now}-${(n += 1)}`;

let sessionApp = '';

/** App-ticket + a command call, each wrapped in its own savepoint. */
async function fcall(sql: string): Promise<{ code?: string; message?: string; rows?: Row[] }> {
  const tag = randomUUID().replace(/-/g, '');
  await app.query(`savepoint fm_${tag}`);
  try {
    const r = await app.query(sql);
    await app.query(`release savepoint fm_${tag}`);
    return { rows: r.rows as Row[] };
  } catch (e) {
    await app.query(`rollback to savepoint fm_${tag}`);
    const err = e as { code?: string; message: string };
    return { code: err.code, message: err.message };
  }
}

/** begin + mint a ticket, returning the app transaction handle to commit. */
async function asUser(user: string): Promise<void> {
  await app.query(
    `select set_config('app.rls', app_ctx_mint('tenant', ${q(user)}, ${q(T('tenantA'))}), true)`,
  );
}

const approve = (session: string, refundId: string, action = 'approve'): Promise<{
  code?: string;
  message?: string;
}> =>
  fcall(`select "postRefundApproval"(${q(session)}, ${q(refundId)}, ${q(action)})`);

const runProcess = (
  session: string,
  refundId: string,
  action: string,
  reason: string | null,
  dispRef: string | null,
): Promise<{ code?: string; message?: string }> =>
  fcall(
    `select "postRefundProcess"(${q(session)}, ${q(refundId)}, ${q(action)}, ` +
      `${reason === null ? 'null' : q(reason)}, ${dispRef === null ? 'null' : q(dispRef)})`,
  );

describeDb('finance refund command-handler state machine (F11/F12)', () => {
  let requiring = '';

  beforeAll(async () => {
    const env = getEnv();
    migrator = new pg.Client({ connectionString: env.DATABASE_URL_MIGRATOR });
    app = new pg.Client({ connectionString: env.DATABASE_URL_APP });
    await migrator.connect();
    await app.connect();

    for (const k of [
      'tenantA',
      'requester',
      'approver',
      'processor',
      'clerk',
      'campusA',
      'yearA',
      'levelA',
      'classA',
      'sectionA',
      'studentA',
      'enrollmentA',
      'guardianA',
      'invoiceA',
      'membershipApp',
      'membershipProc',
      'membershipClerk',
    ]) {
      uid[k] = randomUUID();
    }

    await migrator.query('begin');

    await migrator.query(
      `insert into tenants (id, slug, name) values (${q(T('tenantA'))}, ${q(`fsm-a-${slug}`)}, 'FSM A')`,
    );
    await migrator.query(
      `insert into users (id, email) values
         (${q(T('requester'))}, ${q(`fsm-req-${slug}@example.com`)}),
         (${q(T('approver'))}, ${q(`fsm-app-${slug}@example.com`)}),
         (${q(T('processor'))}, ${q(`fsm-pro-${slug}@example.com`)}),
         (${q(T('clerk'))}, ${q(`fsm-clk-${slug}@example.com`)})`,
    );
    await migrator.query(
      `insert into campuses (id, tenant_id, code, name, status)
       values (${q(T('campusA'))}, ${q(T('tenantA'))}, ${q(`fsm-${slug}`)}, 'Campus', 'active')`,
    );
    await migrator.query(
      `insert into academic_years (id, tenant_id, code, name, starts_on, ends_on, status)
       values (${q(T('yearA'))}, ${q(T('tenantA'))}, ${q(`fsmy-${slug}`)}, 'AY', '2026-01-01', '2026-12-31', 'active')
       on conflict do nothing`,
    );
    await migrator.query(
      `insert into grade_levels (id, tenant_id, code, name, status)
       values (${q(T('levelA'))}, ${q(T('tenantA'))}, ${q(`fsml-${slug}`)}, 'Grade', 'active')`,
    );
    await migrator.query(
      `insert into acd_classes (id, tenant_id, campus_id, academic_year_id, grade_level_id, code, name, status)
       values (${q(T('classA'))}, ${q(T('tenantA'))}, ${q(T('campusA'))}, ${q(T('yearA'))}, ${q(T('levelA'))}, ${q(`fsmc-${slug}`)}, 'Class', 'active')`,
    );
    await migrator.query(
      `insert into sections (id, tenant_id, class_id, campus_id, academic_year_id, code, status)
       values (${q(T('sectionA'))}, ${q(T('tenantA'))}, ${q(T('classA'))}, ${q(T('campusA'))}, ${q(T('yearA'))}, ${q(`fsms-${slug}`)}, 'active')`,
    );
    await migrator.query(
      `insert into students (id, tenant_id, student_no, first_name, last_name, status, primary_campus_id)
       values (${q(T('studentA'))}, ${q(T('tenantA'))}, ${q(`fsmst-${slug}`)}, 'Stu', 'One', 'active', ${q(T('campusA'))})`,
    );
    await migrator.query(
      `insert into enrollments (id, tenant_id, student_id, academic_year_id, class_id, section_id, roll_no, status)
       values (${q(T('enrollmentA'))}, ${q(T('tenantA'))}, ${q(T('studentA'))}, ${q(T('yearA'))}, ${q(T('classA'))}, ${q(T('sectionA'))}, '01', 'active')`,
    );
    await migrator.query(
      `insert into guardians (id, tenant_id, first_name, last_name)
       values (${q(T('guardianA'))}, ${q(T('tenantA'))}, 'G', 'One')`,
    );
    await migrator.query(
      `insert into student_guardians (tenant_id, student_id, guardian_id, relation, is_primary)
       values (${q(T('tenantA'))}, ${q(T('studentA'))}, ${q(T('guardianA'))}, 'father', true)`,
    );
    await migrator.query(
      `insert into fin_document_counters (tenant_id, academic_year_id, kind)
       values (${q(T('tenantA'))}, ${q(T('yearA'))}, 'invoice')`,
    );
    // F11/F12 post ledger legs against the fixed 9-account chart; the per-tenant
    // chart is provisioned by the same seeder the design calls at tenant setup.
    await migrator.query(`select app_finance_seeds_ledger_accounts(${q(T('tenantA'))})`);
    await migrator.query(
      `insert into fin_invoices
         (id, tenant_id, student_id, academic_year_id, enrollment_id, status, due_date, subtotal, total, balance, created_by)
       values (${q(T('invoiceA'))}, ${q(T('tenantA'))}, ${q(T('studentA'))}, ${q(T('yearA'))}, ${q(T('enrollmentA'))},
               'issued', '2026-03-01', 500, 500, 500, ${q(T('requester'))})`,
    );

    // A finance-staff role carrying the two decision permissions F11/F12 need.
    // It must be the SYSTEM accountant role: finance-rbac asserts the §20.5
    // whole-DB invariant that NO custom (is_system=false) role holds a fees.*
    // permission, so a fixture must not create one. Seeding a per-tenant system
    // role mirrors what tenant provisioning does (0028 creates 'cashier' for
    // pre-existing tenants; the runtime seeds the rest).
    const accountant = randomUUID();
    await migrator.query(
      `insert into roles (id, tenant_id, code, name, description, scope, is_system)
       values (${q(accountant)}, ${q(T('tenantA'))}, 'accountant',
               'Accountant', 'system accountant', 'tenant', true)
       on conflict do nothing`,
    );
    await migrator.query(
      `insert into role_permissions (role_id, permission) values
         (${q(accountant)}, 'fees.refunds.approve'),
         (${q(accountant)}, 'fees.refunds.process'),
         (${q(accountant)}, 'fees.refunds.request')`,
    );
    // A clerk role with NO fees.* permissions: a class-inside-finance actor that
    // fails the C∧K gate of the handlers' own permission checks.
    const clerkRole = randomUUID();
    await migrator.query(
      `insert into roles (id, tenant_id, scope, code, name, description, is_system)
       values (${q(clerkRole)}, ${q(T('tenantA'))}, 'tenant', 'clerk',
               'Fixture clerk', 'refund state machine fixture', false)`,
    );
    await migrator.query(
      `insert into memberships (id, tenant_id, user_id, status) values
         (${q(T('membershipApp'))}, ${q(T('tenantA'))}, ${q(T('approver'))}, 'active'),
         (${q(T('membershipProc'))}, ${q(T('tenantA'))}, ${q(T('processor'))}, 'active'),
         (${q(T('membershipClerk'))}, ${q(T('tenantA'))}, ${q(T('clerk'))}, 'active')`,
    );
    await migrator.query(
      `insert into membership_roles (membership_id, role_id) values
         (${q(T('membershipApp'))}, ${q(accountant)}),
         (${q(T('membershipProc'))}, ${q(accountant)}),
         (${q(T('membershipClerk'))}, ${q(clerkRole)})`,
    );

    // A real auth_sessions row for the approver: T7 mints a genuine challenge
    // against it so the F8 step-up consumption is observable.
    sessionApp = randomUUID();
    await migrator.query(
      `insert into auth_sessions (id, user_id, token_hash, expires_at)
       values (${q(sessionApp)}, ${q(T('approver'))}, ${q(`fsm-${slug}-${uniq()}`)}, now() + interval '1 hour')`,
    );

    requiring = accountant;
    void requiring;
    await migrator.query('commit');
  });

  afterAll(async () => {
    const t = q(T('tenantA'));
    // Split triggers that guard every RLS window the suite drives: the deletion
    // guard on the append-only allocation table is parked for the transaction
    // so the whole tenant fixture can leave no trace.
    await migrator
      ?.query(
        `begin;
         truncate fin_ledger_entry_groups, fin_ledger_entries, fin_ledger_accounts;
alter table fin_payment_allocations disable trigger trg_fin_allocations_delete_guard;
         delete from fin_payment_allocations where tenant_id in (${t});
         alter table fin_payment_allocations enable trigger trg_fin_allocations_delete_guard;
         delete from outbox_events where tenant_id in (${t});
         delete from fin_refunds where tenant_id in (${t});
         delete from fin_payments where tenant_id in (${t});
         delete from fin_ledger_accounts where tenant_id in (${t});
         delete from fin_invoices where id in (select id from fin_invoices where tenant_id in (${t}));
         commit;`,
      )
      .catch(() => undefined);
    const cleanup = [
      `delete from fin_document_counters where tenant_id in (${t})`,
      `delete from membership_roles where membership_id in
         (${q(T('membershipApp'))}, ${q(T('membershipProc'))}, ${q(T('membershipClerk'))})`,
      `delete from memberships where tenant_id in (${t})`,
      `delete from role_permissions where role_id in (select id from roles where tenant_id in (${t}))`,
      `delete from roles where tenant_id in (${t})`,
      `delete from auth_sessions where id = ${q(sessionApp)}`,
      `delete from student_guardians where tenant_id in (${t})`,
      `delete from enrollments where tenant_id in (${t})`,
      `delete from students where tenant_id in (${t})`,
      `delete from guardians where tenant_id in (${t})`,
      `delete from sections where tenant_id in (${t})`,
      `delete from acd_classes where tenant_id in (${t})`,
      `delete from grade_levels where tenant_id in (${t})`,
      `delete from campuses where tenant_id in (${t})`,
      `delete from academic_years where tenant_id in (${t})`,
      `delete from users where id in
         (${q(T('requester'))}, ${q(T('approver'))}, ${q(T('processor'))}, ${q(T('clerk'))})`,
      `delete from tenants where id in (${t})`,
    ];
    for (const sql of cleanup) {
      await migrator?.query(sql).catch(() => undefined);
    }
    await migrator?.end().catch(() => undefined);
    await app?.end().catch(() => undefined);
  });

  let paymentId = '';
  let allocId = '';
  let refundId = '';
  const paymentIds = new Set<string>();
  const extraRefunds: string[] = [];

  beforeEach(async () => {
    paymentId = randomUUID();
    allocId = randomUUID();
    refundId = randomUUID();
    paymentIds.add(paymentId);
    await migrator.query(`
      insert into fin_payments
        (id, tenant_id, payment_no, amount, method, payer_guardian_id, received_at, idempotency_key)
      values (${q(paymentId)}, ${q(T('tenantA'))}, ${q(`P-${uniq()}`)}, 1000, 'cash',
              ${q(T('guardianA'))}, now(), ${q(`ik-${uniq()}`)});
      insert into fin_payment_allocations
        (id, tenant_id, payment_id, invoice_id, amount, effect, reversal_of_allocation_id, refund_id, reason, created_by)
      values (${q(allocId)}, ${q(T('tenantA'))}, ${q(paymentId)}, ${q(T('invoiceA'))}, 500, 'apply',
              null, null, 'alloc', ${q(T('requester'))});
      insert into fin_refunds
        (id, tenant_id, refund_no, payment_id, amount, status, reason, proposed_allocations, requested_by, idempotency_key)
      values (${q(refundId)}, ${q(T('tenantA'))}, ${q(`R-${uniq()}`)}, ${q(paymentId)}, 400,
              'requested', 'parent appeal',
              '[{"allocation_id": "${allocId}", "amount": 400}]'::jsonb,
              ${q(T('requester'))}, ${q(`ikr-${uniq()}`)});
    `);
    // The handler runs on the APP connection, whose transactions only see
    // COMMITTED rows: the fixture must be visible there, so the migrator side
    // commits its own preparation transaction. Every row is owned by this test's
    // ids and removed again in afterEach.
    await migrator.query('commit');
  });

  afterEach(async () => {
    await app.query('rollback').catch(() => undefined);
    const refundIds = [refundId, ...extraRefunds].map(q).join(', ');
    const payIds = [...paymentIds].map(q).join(', ');
    await migrator.query(`
      begin;
      -- The two transaction figures are FORCE-RLS with only SELECT/INSERT/UPDATE
      -- policies (no DELETE), so a row DELETE silently matches zero rows for
      -- every role including the owning migrator. TRUNCATE bypasses RLS. The
      -- chart of accounts is seeded once in beforeAll and survives here; it is
      -- cleared (by tenant) in afterAll.
      truncate fin_ledger_entry_groups, fin_ledger_entries;
      -- fin_payment_allocations is append-only: the DELETE guard trigger is
      -- parked for the duration of this cleanup transaction only, and restored
      -- before commit, so the run leaves no trace.
      alter table fin_payment_allocations disable trigger trg_fin_allocations_delete_guard;
      delete from fin_payment_allocations where tenant_id = ${q(T('tenantA'))} and payment_id in (${payIds});
      alter table fin_payment_allocations enable trigger trg_fin_allocations_delete_guard;
      delete from fin_refunds where tenant_id = ${q(T('tenantA'))} and id in (${refundIds});
      delete from fin_payments where tenant_id = ${q(T('tenantA'))} and id in (${payIds});
      commit;
    `).catch(() => undefined);
    extraRefunds.length = 0;
    paymentIds.clear();
  });

  /** Convenience: status + decided columns for the current refund. */
  const state = async (): Promise<Row> =>
    one(
      await mig(
        `select status, decided_by, decided_at, processed_by, rejection_reason,
                disbursement_reference, applied_allocations
           from fin_refunds where id = ${q(refundId)}`,
      ),
    );

  const ledgerLegs = async (event: string, srcId: string): Promise<number> =>
    num(
      one(
        await mig(
          `select count(*)::int n
             from fin_ledger_entry_groups g
             join fin_ledger_entries e
               on e.tenant_id = g.tenant_id and e.entry_group_id = g.id
            where g.tenant_id = ${q(T('tenantA'))}
              and g.event_type = ${q(event)} and g.source_id = ${q(srcId)}`,
        ),
      ).n,
    );

  const outboxFor = async (event: string, srcId: string): Promise<number> =>
    num(
      one(
        await mig(
          `select count(*)::int n from outbox_events
            where tenant_id = ${q(T('tenantA'))} and event_type = ${q(event)}
              and aggregate_id = ${q(srcId)}`,
        ),
      ).n,
    );

  // -------------------------------------------------------------- machine
  it('T1 the full machine: requested -> approved -> processed, with reversals, ledger and outbox written in the handlers', async () => {
    await app.query('begin');
    await asUser(T('approver'));
    const a = await approve(randomUUID(), refundId); // random session: no step-up row
    expect(a.code).toBeUndefined();
    await app.query('commit');

    let s = await state();
    expect(String(s.status)).toBe('approved');
    expect(String(s.decided_by)).toBe(T('approver'));
    expect(s.rejection_reason).toBeNull();
    const applied = s.applied_allocations as unknown as Array<Record<string, string>>;
    expect(applied).toHaveLength(1);
    const applied0 = applied[0] ?? {};
    expect(applied0.allocation_id).toBe(allocId);
    expect(num(applied0.amount)).toBe(400); // jsonb decodes numeric literals to numbers
    expect(String(applied0.reversal_allocation_id)).not.toBe('');
    // The reversal row the approve leg wrote.
    const rev = one(
      await mig(
        `select amount from fin_payment_allocations
          where tenant_id = ${q(T('tenantA'))} and refund_id = ${q(refundId)}
            and effect = 'reverse' and reversal_of_allocation_id = ${q(allocId)}`,
      ),
    );
    expect(String(rev.amount)).toBe('-400.0000');
    expect(await ledgerLegs('refund.approved', refundId)).toBe(2);
    expect(await outboxFor('refund.approved', refundId)).toBe(1);

    await app.query('begin');
    await asUser(T('processor'));
    const p = await runProcess(randomUUID(), refundId, 'process', null, 'CHK-0001');
    expect(p.code).toBeUndefined();
    await app.query('commit');

    s = await state();
    expect(String(s.status)).toBe('processed');
    expect(String(s.processed_by)).toBe(T('processor'));
    expect(String(s.disbursement_reference)).toBe('CHK-0001');
    expect(await ledgerLegs('refund.processed', refundId)).toBe(2);
    expect(await outboxFor('refund.processed', refundId)).toBe(1);
  });

  it('T2 approve refuses: wrong action, self-approval, wrong status, and a class member without the permission', async () => {
    // (a) the handler is approve-only.
    await app.query('begin');
    await asUser(T('approver'));
    const bad = await approve(randomUUID(), refundId, 'reject');
    expect(bad.code).toBe('55000');
    expect(bad.message).toMatch(/postRefundApproval handles only the approve action/);
    await app.query('commit');

    // (b) requester == approver. New refund whose requested_by is the approver.
    const self = randomUUID();
    extraRefunds.push(self);
    await migrator.query(
      `insert into fin_refunds
         (id, tenant_id, refund_no, payment_id, amount, status, reason, proposed_allocations, requested_by, idempotency_key)
       values (${q(self)}, ${q(T('tenantA'))}, ${q(`R2-${uniq()}`)}, ${q(paymentId)}, 100,
               'requested', 'self', '[]'::jsonb, ${q(T('approver'))}, ${q(`ikr2-${uniq()}`)})`,
    );
    await app.query('begin');
    await asUser(T('approver'));
    const selfRes = await approve(randomUUID(), self);
    expect(selfRes.code).toBe('55000');
    expect(selfRes.message).toMatch(/may not be approved by the actor who requested it/);
    await app.query('commit');

    // (d) clerk: inside the tenant, finance-ineligible role -> actor lacks the
    // permission. Runs while the fixture refund is still 'requested': the
    // handler's own permission check must be what refuses it, not the state
    // machine. So (d) precedes (c)'s final-state probe.
    await app.query('begin');
    await asUser(T('clerk'));
    const d = await approve(randomUUID(), refundId);
    expect(d.code).toBe('55000');
    expect(d.message).toMatch(/actor lacks fees\.refunds\.approve/);
    await app.query('commit');

    // (c) already decided. Drive the current refund to processed, then approve again.
    await app.query('begin');
    await asUser(T('approver'));
    expect((await approve(randomUUID(), refundId)).code).toBeUndefined();
    await app.query('commit');
    await app.query('begin');
    await asUser(T('processor'));
    expect((await runProcess(randomUUID(), refundId, 'process', null, 'CHK-0002')).code).toBeUndefined();
    await app.query('commit');
    await app.query('begin');
    await asUser(T('approver'));
    const again = await approve(randomUUID(), refundId);
    expect(again.code).toBe('55000');
    expect(again.message).toMatch(/refund .* is processed, not requested/);
    await app.query('commit');
  });

  it('T3 postRefundProcess reject: requested -> rejected with a reason, no ledger, idempotent, and refused after processing', async () => {
    await app.query('begin');
    await asUser(T('approver'));
    const r = await runProcess(randomUUID(), refundId, 'reject', 'parent withdrew the appeal', null);
    expect(r.code).toBeUndefined();
    await app.query('commit');

    let s = await state();
    expect(String(s.status)).toBe('rejected');
    expect(String(s.decided_by)).toBe(T('approver'));
    expect(String(s.rejection_reason)).toBe('parent withdrew the appeal');
    expect(await ledgerLegs('refund.rejected', refundId)).toBe(0);
    expect(await outboxFor('refund.rejected', refundId)).toBe(1);

    // Idempotent replay: a re-submitted reject on an already-rejected refund RETURNS.
    await app.query('begin');
    await asUser(T('approver'));
    const replay = await runProcess(randomUUID(), refundId, 'reject', 'again', null);
    expect(replay.code).toBeUndefined();
    await app.query('commit');
    s = await state();
    expect(String(s.status)).toBe('rejected');
    expect(String(s.rejection_reason)).toBe('parent withdrew the appeal');
    expect(await outboxFor('refund.rejected', refundId)).toBe(1);

    // Rejecting a PROCESSED refund is refused. Drive a second refund through the
    // real machine so the machine itself, not a hand-rolled UPDATE, produces the
    // 'processed' state (the state-machine trigger refuses non-adjacent jumps).
    // A second invoice needs a second enrollment: invoices are UNIQUE per
    // (tenant, enrollment, year).
    const studentB = randomUUID();
    const enrollmentB = randomUUID();
    const payB = randomUUID();
    const allocB = randomUUID();
    const invoiceB = randomUUID();
    const refundB = randomUUID();
    paymentIds.add(payB);
    extraRefunds.push(refundB);
    await migrator.query(
      `insert into students
         (id, tenant_id, student_no, first_name, last_name, status, primary_campus_id)
       values (${q(studentB)}, ${q(T('tenantA'))}, ${q(`fsmstB-${slug}`)}, 'Stu', 'Two', 'active', ${q(T('campusA'))});
       insert into enrollments
         (id, tenant_id, student_id, academic_year_id, class_id, section_id, roll_no, status)
       values (${q(enrollmentB)}, ${q(T('tenantA'))}, ${q(studentB)}, ${q(T('yearA'))}, ${q(T('classA'))}, ${q(T('sectionA'))}, '02', 'active');
       insert into student_guardians (tenant_id, student_id, guardian_id, relation, is_primary)
       values (${q(T('tenantA'))}, ${q(studentB)}, ${q(T('guardianA'))}, 'father', true);
       insert into fin_invoices
         (id, tenant_id, student_id, academic_year_id, enrollment_id, status, due_date, subtotal, total, balance, created_by)
       values (${q(invoiceB)}, ${q(T('tenantA'))}, ${q(studentB)}, ${q(T('yearA'))}, ${q(enrollmentB)},
               'issued', '2026-04-01', 300, 300, 300, ${q(T('requester'))});
       insert into fin_payments
         (id, tenant_id, payment_no, amount, method, payer_guardian_id, received_at, idempotency_key)
       values (${q(payB)}, ${q(T('tenantA'))}, ${q(`P2-${uniq()}`)}, 600, 'cash',
               ${q(T('guardianA'))}, now(), ${q(`ik2-${uniq()}`)});
       insert into fin_payment_allocations
         (id, tenant_id, payment_id, invoice_id, amount, effect, reversal_of_allocation_id, refund_id, reason, created_by)
       values (${q(allocB)}, ${q(T('tenantA'))}, ${q(payB)}, ${q(invoiceB)}, 300, 'apply',
               null, null, 'allocB', ${q(T('requester'))});
       insert into fin_refunds
         (id, tenant_id, refund_no, payment_id, amount, status, reason, proposed_allocations, requested_by, idempotency_key)
       values (${q(refundB)}, ${q(T('tenantA'))}, ${q(`R3-${uniq()}`)}, ${q(payB)}, 200,
               'requested', 'second review',
               '[{"allocation_id": "${allocB}", "amount": 200}]'::jsonb,
               ${q(T('requester'))}, ${q(`ikr3-${uniq()}`)})`,
    );
    await app.query('begin');
    await asUser(T('approver'));
    expect((await approve(randomUUID(), refundB)).code).toBeUndefined();
    await app.query('commit');
    await app.query('begin');
    await asUser(T('processor'));
    expect((await runProcess(randomUUID(), refundB, 'process', null, 'CHK-0003')).code).toBeUndefined();
    await app.query('commit');

    await app.query('begin');
    await asUser(T('approver'));
    const refused = await runProcess(randomUUID(), refundB, 'reject', 'too late', null);
    expect(refused.code).toBe('55000');
    expect(refused.message).toMatch(/refund_already_decided/);
    await app.query('commit');
  });

  it('T4 process refuses: a requested (not yet approved) refund, and an approved refund without a disbursement reference', async () => {
    // (a) process on 'requested' -> refund_not_approved.
    await app.query('begin');
    await asUser(T('processor'));
    const pre = await runProcess(randomUUID(), refundId, 'process', null, 'CHK-0004');
    expect(pre.code).toBe('55000');
    expect(pre.message).toMatch(/refund .* is requested, not approved/);
    await app.query('commit');

    // (b) approved but no disbursement reference -> disbursement_reference_required.
    await app.query('begin');
    await asUser(T('approver'));
    expect((await approve(randomUUID(), refundId)).code).toBeUndefined();
    await app.query('commit');
    await app.query('begin');
    await asUser(T('processor'));
    const nodisp = await runProcess(randomUUID(), refundId, 'process', null, null);
    expect(nodisp.code).toBe('55000');
    expect(nodisp.message).toMatch(/disbursement_reference_required/);
    await app.query('commit');
  });

  it('T5 approve is idempotent: a replay returns early and posts no second ledger group', async () => {
    await app.query('begin');
    await asUser(T('approver'));
    expect((await approve(randomUUID(), refundId)).code).toBeUndefined();
    await app.query('commit');
    const s1 = await state();
    expect(String(s1.status)).toBe('approved');
    expect(s1.applied_allocations as unknown as Array<unknown>).toHaveLength(1);
    expect(await ledgerLegs('refund.approved', refundId)).toBe(2);

    await app.query('begin');
    await asUser(T('approver'));
    expect((await approve(randomUUID(), refundId)).code).toBeUndefined();
    await app.query('commit');

    const s2 = await state();
    expect(String(s2.status)).toBe('approved');
    expect(s2.applied_allocations as unknown as Array<unknown>).toHaveLength(1);
    expect(await ledgerLegs('refund.approved', refundId)).toBe(2);
    expect(await outboxFor('refund.approved', refundId)).toBe(1);
  });

  it('T6 disclosure: the handler DOES NOT gate on step-up — a no-session, no-challenge call still lands (route-side enforcement)', async () => {
    // The PERFORM app_consume_step_up(session, ...) in F11 returns FALSE when no
    // session exists and its return is DISCARDED. The transition proceeds. This
    // is the documented contract: the API route must verify the caller's code
    // with app_consume_step_up BEFORE invoking postRefundApproval.
    await app.query('begin');
    await asUser(T('approver'));
    const ghostSession = randomUUID(); // no auth_sessions row, no challenge
    const r = await approve(ghostSession, refundId);
    expect(r.code).toBeUndefined();
    await app.query('commit');
    expect(String((await state()).status)).toBe('approved');
  });

  it('T7 step-up consumption is OBSERVABLE but not enforcing: a real challenge has attempts_left decremented by the F8 PERFORM, yet the transition lands', async () => {
    // Mint a genuine challenge for the approver's real session, then run the
    // handler. F11's F8 PERFORM passes NULL as the code: app_consume_step_up
    // verifies, fails, decrements attempts_left, and RETURNS FALSE (discarded).
    await app.query('begin');
    await asUser(T('approver'));
    const minted = await app.query(
      `select app_mint_step_up_challenge(${q(sessionApp)}, 'fin_refunds', ${q(refundId)}, 400.00, 'refund.approve') as code`,
    );
    expect(String(minted.rows[0].code)).toHaveLength(6);
    expect((await approve(sessionApp, refundId)).code).toBeUndefined();
    await app.query('commit');

    // The challenge table is RLS-FORCE with SELF-only policies: its rows are
    // readable ONLY through a signed ticket naming the owning user, so the
    // assertion runs on the app connection (whose approver ticket is still set).
    await app.query('begin');
    await asUser(T('approver'));
    const ch = one(
      (await app.query(
        `select attempts_left, consumed_at from auth_step_up_challenges
          where tenant_id = ${q(T('tenantA'))} and session_id = ${q(sessionApp)}
            and action = 'refund.approve' and resource_id = ${q(refundId)}`,
      )).rows as Row[],
    );
    await app.query('rollback');

    expect(num(ch.attempts_left)).toBe(2); // 3 - 1 for the NULL-code attempt
    expect(ch.consumed_at).toBeNull(); // never verified, never consumed
    expect(String((await state()).status)).toBe('approved');
  });
});