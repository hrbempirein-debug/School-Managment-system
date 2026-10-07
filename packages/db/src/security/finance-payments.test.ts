import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';

import { randomUUID } from 'node:crypto';

import pg from 'pg';

import { getEnv } from '@sms/config';



/**

 * 0024 PAYMENT RUNTIME PROOF â€” C-ALLOC-DEL-1 â€¦ C-ALLOC-DEL-10 (Â§28.3.2, A19),

 * plus the 0024-owned money, reversal, challan, receipt and boundary controls.

 *

 * WHY THIS FILE EXISTS SEPARATELY FROM THE CATALOG SUITES

 * `finance-trigger-inventory.test.ts` proves a trigger EXISTS with the right

 * timing, events and events-bitmask, and `finance-composite-fk.test.ts` proves a

 * constraint has the right columns and actions. Both are static. A trigger can be

 * present, correctly bound, correctly timed, and still never fire on the row shape

 * an application actually sends â€” or fire on every row and refuse all of them.

 * Only a statement against a real row distinguishes those two worlds.

 *

 * So every assertion below is BEHAVIOURAL: it inserts a real payment, a real

 * allocation, a real receipt, a real challan, and reads the real cache columns and

 * the real views. Where a control is negative the test asserts the SQLSTATE *and*

 * the message substring, because an unrelated failure is not a pass â€” a suite that

 * only checks "something was refused" is satisfied by a typo in its own fixture.

 *

 * WHY THE TEN DELETE CONTROLS ARE NOT ONE

 * Â§28.3.2 is explicit: of the ten, C-ALLOC-DEL-3 is "the one that fails loudly",

 * and the other six exist "so that a future revision cannot replace the guard with

 * a cheaper mechanism that satisfies only C-ALLOC-DEL-3". A suite that asserted

 * only -3 would therefore be satisfiable by `BEFORE DELETE ... RAISE`, by a rule on

 * `ON DELETE RESTRICT`, by a privilege revocation, or by deleting the rows from a

 * maintenance script â€” all of which satisfy -3 and violate the append-only

 * guarantee the phase actually needs. Hence -1, -2, -8 and -9 are POSITIVE

 * (a legitimate INSERT, a permitted UPDATE, the reversal-only workflow, and 0025

 * compatibility) and -4 â€¦ -7 assert provenance, unchanged money, tenant isolation,

 * and definership.

 *

 * TWO IMPLEMENTATION FACTS THESE TESTS PIN DOWN, BOTH NON-OBVIOUS:

 *

 *  1. `trg_fin_receipt_freeze` OVERWRITES `amount` (and `payer_guardian_id`) from

 *     the payment rather than validating it â€” design Â§25.5 line 8174: "overwrites

 *     `amount` from the payment rather than validating it". The function then

 *     compares `NEW.amount <> v_amount` AFTER assigning it, so that branch is

 *     unreachable. A test written the obvious way ("a mismatched receipt amount is

 *     rejected") FAILS against correct code. The receipt control below asserts the

 *     overwrite instead, and the dead branch is reported rather than papered over.

 *

 *  2. `trg_fin_allocation_bounds` sums committed allocations WITHOUT an

 *     `invoice_id` predicate, so a negative `on_account_return` row on the same

 *     payment reduces the committed total and legitimately frees room for a further

 *     `apply`. That is the return-then-reapply money model, and the on-account

 *     control below depends on it rather than working around it.

 *

 * Opt-in: RUN_RUNTIME_SECURITY_TESTS=1 (requires PostgreSQL + migrations 0001..0024).

 */

const enabled = process.env.RUN_RUNTIME_SECURITY_TESTS === '1';

const describeDb = enabled ? describe : describe.skip;



let migrator: pg.Client;

let app: pg.Client;



const uid: Record<string, string> = {};

const slug = randomUUID().slice(0, 8);



const u = (k: string): string => {

  const v = uid[k];

  if (v === undefined) throw new Error(`fixture id "${k}" was never assigned`);

  return v;

};



/** A fresh id registered under `key`. Allocates a NEW uuid on every call. */

const id = (key: string): string => {

  uid[key] = randomUUID();

  return uid[key];

};



/**

 * The id ALREADY registered under `key`.

 *

 * `id()` is an allocator, not a lookup, so `where id = ${q(id('x'))}` after

 * `values (${q(id('x'))}, ...)` compares two DIFFERENT uuids and silently counts

 * zero rows -- a failure that reads like a missing row rather than a typo.

 */

const ref = (key: string): string => u(key);



type Row = Record<string, unknown>;



const q = (v: string) => `'${v}'`;



const mig = async (sql: string): Promise<Row[]> => (await migrator.query(sql)).rows as Row[];



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



const one = (rows: Row[]): Row => {

  const r = rows[0];

  if (r === undefined) throw new Error('expected at least one row');

  return r;

};



const num = (v: unknown): number => Number(String(v));

const n1 = (rows: Row[]): number => num(one(rows).n);



/** `prosrc` with SQL comments removed, so a note about removed code is not code. */

const codeOf = (prosrc: unknown): string =>

  String(prosrc)

    .replace(/\/\*[\s\S]*?\*\//g, ' ')

    .split('\n')

    .map((l) => {

      const at = l.indexOf('--');

      return at === -1 ? l : l.slice(0, at);

    })

    .join('\n');



/** One enrollment per case: the partial unique index allows one LIVE invoice each. */

const CASES_A = 12;

const CASES_B = 2;



/** Seeds everything a tenant needs before an invoice can exist. */

const seedTenant = async (t: string): Promise<void> => {

  for (const k of ['tenant', 'user', 'campus', 'year', 'level', 'class', 'section', 'struct', 'headA', 'headB', 'counter']) {

    uid[`${k}${t}`] = randomUUID();

  }

  await migrator.query(

    `insert into tenants (id, slug, name) values (${q(u(`tenant${t}`))}, ${q(`cs-${t}-${slug}`)}, ${q(`CS ${t}`)})`,

  );

  await migrator.query(

    `insert into users (id, email) values (${q(u(`user${t}`))}, ${q(`cs-${t}-${slug}@example.com`)})`,

  );

  await migrator.query(

    `insert into campuses (id, tenant_id, code, name, status)

     values (${q(u(`campus${t}`))}, ${q(u(`tenant${t}`))}, ${q(`cp-${t}-${slug}`)}, 'Campus', 'active')`,

  );

  await migrator.query(

    `insert into academic_years (id, tenant_id, code, name, starts_on, ends_on, status)

     values (${q(u(`year${t}`))}, ${q(u(`tenant${t}`))}, ${q(`ay-${t}-${slug}`)}, 'AY', '2026-01-01', '2026-12-31', 'active')`,

  );

  await migrator.query(

    `insert into grade_levels (id, tenant_id, code, name, status)

     values (${q(u(`level${t}`))}, ${q(u(`tenant${t}`))}, ${q(`gl-${t}-${slug}`)}, 'Grade', 'active')`,

  );

  await migrator.query(

    `insert into acd_classes (id, tenant_id, campus_id, academic_year_id, grade_level_id, code, name, status)

     values (${q(u(`class${t}`))}, ${q(u(`tenant${t}`))}, ${q(u(`campus${t}`))}, ${q(u(`year${t}`))}, ${q(u(`level${t}`))}, ${q(`cl-${t}-${slug}`)}, 'Class', 'active')`,

  );

  await migrator.query(

    `insert into sections (id, tenant_id, class_id, campus_id, academic_year_id, code, status)

     values (${q(u(`section${t}`))}, ${q(u(`tenant${t}`))}, ${q(u(`class${t}`))}, ${q(u(`campus${t}`))},

             ${q(u(`year${t}`))}, ${q(`sc-${t}-${slug}`)}, 'active')`,

  );

  // Two heads, not one: fin_invoice_items_uq is UNIQUE on

  // (tenant_id, invoice_id, structure_id, fee_head_id, installment_no) with NULLS

  // NOT DISTINCT, so any second line on one invoice needs a different fee_head_id.

  await migrator.query(

    `insert into fin_fee_heads (id, tenant_id, code, name) values

       (${q(u(`headA${t}`))}, ${q(u(`tenant${t}`))}, ${q(`fh-${t}-${slug}`)}, 'Tuition'),

       (${q(u(`headB${t}`))}, ${q(u(`tenant${t}`))}, ${q(`fh2-${t}-${slug}`)}, 'Books')`,

  );

  // A plan-less structure, so due_date derives from effective_from and

  // fin_invoice_items.installment_no is legitimately NULL.

  await migrator.query(

    `insert into fin_fee_structures (id, tenant_id, code, name, academic_year_id, version, status, effective_from)

     values (${q(u(`struct${t}`))}, ${q(u(`tenant${t}`))}, ${q(`st-${t}-${slug}`)}, 'Structure',

             ${q(u(`year${t}`))}, 1, 'draft', '2026-03-01')`,

  );

  await migrator.query(

    `insert into fin_document_counters (id, tenant_id, academic_year_id, kind, last_value)

     values (${q(u(`counter${t}`))}, ${q(u(`tenant${t}`))}, ${q(u(`year${t}`))}, 'invoice', 0)`,

  );

};



/** One student + enrollment per case, in tenant `t`. */

const seedCases = async (t: string, count: number): Promise<void> => {

  for (let n = 1; n <= count; n += 1) {

    uid[`stu${t}${n}`] = randomUUID();

    uid[`enr${t}${n}`] = randomUUID();

    const stu = u(`stu${t}${n}`);

    const enr = u(`enr${t}${n}`);

    const tenant = u(`tenant${t}`);

    const year = u(`year${t}`);

    const klass = u(`class${t}`);

    const section = u(`section${t}`);

    const campus = u(`campus${t}`);

    const studentNo = q(`s-${t}-${n}-${slug}`);

    const lastName = q(`${t}${n}`);

    await migrator.query(

      `insert into students (id, tenant_id, student_no, first_name, last_name, status)

       values (${q(stu)}, ${q(tenant)}, ${studentNo}, 'Stu', ${lastName}, 'active')`,

    );

    await migrator.query(

      `insert into enrollments (id, tenant_id, student_id, academic_year_id, class_id, section_id, roll_no, status)

       values (${q(enr)}, ${q(tenant)}, ${q(stu)}, ${q(year)}, ${q(klass)}, ${q(section)}, ${String(n).padStart(2, '0')}, 'active')`,

    );

  }

};



/** A draft invoice for tenant `t` case `n`, with one line of `amount`. */

const mkInvoice = async (t: string, n: number, amount = '100.00'): Promise<string> => {

  const inv = id(`inv${t}${n}`);

  await mig(

    `insert into fin_invoices

       (id, tenant_id, student_id, academic_year_id, enrollment_id, structure_id, created_by)

     values (${q(inv)}, ${q(u(`tenant${t}`))}, ${q(u(`stu${t}${n}`))}, ${q(u(`year${t}`))}, ${q(u(`enr${t}${n}`))},

             ${q(u(`struct${t}`))}, ${q(u(`user${t}`))})`,

  );

  await mig(

    `insert into fin_invoice_items

       (id, tenant_id, invoice_id, structure_id, fee_head_id, description, quantity, unit_amount)

     values (${q(id(`line${t}${n}`))}, ${q(u(`tenant${t}`))}, ${q(inv)}, ${q(u(`struct${t}`))},

             ${q(u(`headA${t}`))}, 'Tuition', 1, ${amount})`,

  );

  return inv;

};



/** Issues an invoice â€” the only state in which cash may be applied (D9). */

const issue = async (t: string, inv: string): Promise<void> => {

  await mig(`update fin_invoices set status = 'issued' where id = ${q(inv)}`);

};



/** A settled payment by `guardianKey` in tenant `t`. */

const mkPayment = async (t: string, guardianKey: string, amount = '100.00', key?: string): Promise<string> => {

const pay = key ?? id(`pay${t}`);

  const short = pay.slice(0, 8);

  const paymentNo = q(`PM-${slug}-${short}`);

  const idemKey = q(`ik-${slug}-${short}`);

  const tenant = u(`tenant${t}`);

  const user = u(`user${t}`);

  await mig(

    `insert into fin_payments

       (id, tenant_id, payment_no, amount, method, status, payer_guardian_id, received_at, received_by, idempotency_key)

     values (${q(pay)}, ${q(tenant)}, ${paymentNo}, ${amount},

             'cash', 'settled', ${q(u(guardianKey))}, now(), ${q(user)}, ${idemKey})`,

  );

  return pay;

};



/** An `apply` allocation of `amount` from `pay` to `inv`. */

const mkAlloc = async (

  t: string,

  pay: string,

  inv: string | null,

  amount = '100.00',

  key?: string,

): Promise<string> => {

  const a = key ?? id(`al${t}`);

  await mig(

    `insert into fin_payment_allocations

       (id, tenant_id, payment_id, invoice_id, amount, effect, reason, created_by)

     values (${q(a)}, ${q(u(`tenant${t}`))}, ${q(pay)}, ${inv === null ? 'null' : q(inv)}, ${amount},

             'apply', 'runtime proof', ${q(u(`user${t}`))})`,

  );

  return a;

};



/** A `reverse` allocation of `amount` (negative) against `target`. */

const mkReverse = async (

  t: string,

  pay: string,

  target: string,

  inv: string | null,

  amount = '-100.00',

  refundId?: string,

): Promise<string> => {

  const a = id(`rv${t}`);

  await mig(

    `insert into fin_payment_allocations

       (id, tenant_id, payment_id, invoice_id, amount, effect, reversal_of_allocation_id, refund_id, reason, created_by)

     values (${q(a)}, ${q(u(`tenant${t}`))}, ${q(pay)}, ${inv === null ? 'null' : q(inv)}, ${amount},

             'reverse', ${q(target)}, ${refundId === undefined ? 'null' : q(refundId)}, 'reversal proof', ${q(u(`user${t}`))})`,

  );

  return a;

};



/** A `requested` refund of `amount` against `pay` â€” the 0025 write-once row. */

const mkRefund = async (t: string, pay: string, amount = '100.00', key?: string): Promise<string> => {

  const refund = key ?? id(`ref${t}`);

  const short = refund.slice(0, 8);

  const refundNo = q(`RF-${slug}-${short}`);

  const idemKey = q(`ikr-${slug}-${short}`);

  const tenant = u(`tenant${t}`);

  const user = u(`user${t}`);

  // status is left to the DEFAULT 'requested' and every decision/process column is

  // omitted, which is what the 'requested' arm of fin_refunds_decision_ck requires.

  await mig(

    `insert into fin_refunds

       (id, tenant_id, refund_no, payment_id, amount, reason, proposed_allocations, requested_by, idempotency_key)

     values (${q(refund)}, ${q(tenant)}, ${refundNo}, ${q(pay)}, ${amount},

             'refund proof', '[]'::jsonb, ${q(user)}, ${idemKey})`,

  );

  return refund;

};



interface Money {

  balance: number;

  status: string;

  total: number;

}



const invMoney = async (t: string, inv: string): Promise<Money> => {

  const r = one(await mig(`select balance, status, total from fin_invoices where id = ${q(inv)}`));

  return { balance: num(r.balance), status: String(r.status), total: num(r.total) };

};



interface Position {

  unallocated: number;

  applied: number;

  refundable: number;

  refunded: number;

  onAccountReturned: number;

}



const payPosition = async (pay: string): Promise<Position | null> => {

  const rows = await mig(

    `select unallocated_amount, applied_amount, refundable_amount, refunded_amount, on_account_returned_amount

       from fin_v_payment_position where payment_id = ${q(pay)}`,

  );

  const r = rows[0];

  if (r === undefined) return null;

  return {

    unallocated: num(r.unallocated_amount),

    applied: num(r.applied_amount),

    refundable: num(r.refundable_amount),

    refunded: num(r.refunded_amount),

    onAccountReturned: num(r.on_account_returned_amount),

  };

};



/** The full payment + issued invoice + applied allocation chain, in one call. */

const paid = async (t: string, n: number, amount = '100.00'): Promise<{ inv: string; pay: string; alloc: string }> => {

  const inv = await mkInvoice(t, n, amount);

  await issue(t, inv);

  const pay = await mkPayment(t, `guardian${t}`, amount);

  const alloc = await mkAlloc(t, pay, inv, amount);

  return { inv, pay, alloc };

};



/** `0024`'s eleven bound trigger functions, plus 0023's thirteen = 24. */

const BOUND_0024 = [

  'trg_fin_target_validate',

  'trg_fin_structure_publish_freeze',

  'trg_fin_structure_child_freeze',

  'trg_fin_assignment_validate',

  'trg_fin_billing_run_freeze',

  'trg_fin_billing_run_items_freeze',

  'trg_fin_invoice_number',

  'trg_fin_invoice_header_guard',

  'trg_fin_invoice_freeze_lines',

  'trg_fin_invoice_item_amount',

  'trg_fin_invoice_adjustment_approval',

  'trg_fin_invoice_item_total',

  'trg_fin_invoice_items_freeze',

  // 0024's eleven.

  'trg_fin_reversal_shape',

  'trg_fin_allocation_bounds',

  'trg_fin_allocation_family_guard',

  'trg_fin_allocation_target_state',

  'trg_fin_pa_delete_guard',

  'trg_fin_on_account_return_bounds',

  'trg_fin_receipt_freeze',

  'trg_fin_invoice_balance_recompute',

  'trg_fin_invoice_void',

  'trg_fin_challan_status',

  'trg_fin_challan_refresh',

] as const;



/** Rows 4, 4d, 6, 13 and 8a â€” the F5d definers owned by the applied set. */

const DEFINERS_0024 = [

  'trg_fin_challan_refresh',

  'trg_fin_invoice_balance_recompute',

  'trg_fin_invoice_freeze_lines',

  'trg_fin_invoice_item_total',

  'trg_fin_invoice_number',

] as const;



describeDb('0024 payment runtime proof (C-ALLOC-DEL-1..10 + money/reversal/challan/receipt/boundary)', () => {

  beforeAll(async () => {

    const env = getEnv();

    migrator = new pg.Client({ connectionString: env.DATABASE_URL_MIGRATOR });

    app = new pg.Client({ connectionString: env.DATABASE_URL_APP });

    await migrator.connect();

    await app.connect();



    await migrator.query('begin');

    await seedTenant('A');

    await seedTenant('B');

    await seedCases('A', CASES_A);

    await seedCases('B', CASES_B);



    // guardianA is a LIVE guardian of every tenant-A student, so a payment can be

    // allocated at all: trg_fin_allocation_family_guard walks

    // students -> student_guardians -> guardians and demands BOTH deleted_at NULL.

    uid.guardianA = randomUUID();

    await migrator.query(

      `insert into guardians (id, tenant_id, first_name, last_name)

       values (${q(uid.guardianA)}, ${q(u('tenantA'))}, 'Pay', 'One')`,

    );

    for (let n = 1; n <= CASES_A; n += 1) {

      await migrator.query(

        `insert into student_guardians (id, tenant_id, student_id, guardian_id, relation, is_primary, can_pickup)

         values (${q(id(`sgA${n}`))}, ${q(u('tenantA'))}, ${q(u(`stuA${n}`))}, ${q(uid.guardianA)}, 'father', true, true)`,

      );

    }

    // A LIVE guardian who is linked to NOBODY: the family-boundary negative.

    uid.guardianOut = randomUUID();

    await migrator.query(

      `insert into guardians (id, tenant_id, first_name, last_name)

       values (${q(uid.guardianOut)}, ${q(u('tenantA'))}, 'Not', 'Linked')`,

    );

    // A SOFT-DELETED guardian, linked to student 1. The guard requires

    // g.deleted_at IS NULL, so this payer is as good as unlinked â€” and it proves the

    // check reads the column rather than merely the presence of a link row.

    uid.guardianSoft = randomUUID();

    await migrator.query(

      `insert into guardians (id, tenant_id, first_name, last_name, deleted_at)

       values (${q(uid.guardianSoft)}, ${q(u('tenantA'))}, 'Soft', 'Deleted', now())`,

    );

    await migrator.query(

      `insert into student_guardians (id, tenant_id, student_id, guardian_id, relation, is_primary, can_pickup)

       values (${q(id('sgSoft'))}, ${q(u('tenantA'))}, ${q(u('stuA1'))}, ${q(uid.guardianSoft)}, 'father', true, true)`,

    );

    // Tenant B's payer, linked only within tenant B.

    uid.guardianB = randomUUID();

    await migrator.query(

      `insert into guardians (id, tenant_id, first_name, last_name)

       values (${q(uid.guardianB)}, ${q(u('tenantB'))}, 'Pay', 'Two')`,

    );

    for (let n = 1; n <= CASES_B; n += 1) {

      await migrator.query(

        `insert into student_guardians (id, tenant_id, student_id, guardian_id, relation, is_primary, can_pickup)

         values (${q(id(`sgB${n}`))}, ${q(u('tenantB'))}, ${q(u(`stuB${n}`))}, ${q(uid.guardianB)}, 'father', true, true)`,

      );

    }

    await migrator.query('commit');

  });



  beforeEach(async () => {

    await migrator.query('begin');

    // The app connection needs a transaction too: appReject wraps its statement in a

    // savepoint, and SAVEPOINT outside a transaction block raises 25P01 â€” which

    // surfaces as "SAVEPOINT can only be used in transaction blocks" and masks the

    // 42501 the case is about.

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

      // Each statement gets its OWN savepoint: in PostgreSQL a single failed

      // statement poisons the whole transaction with 25P02 until ROLLBACK, so a

      // teardown that shares one savepoint across several DELETEs loses every

      // DELETE after the first refusal â€” which is how fixtures leak.

      const wipe = async (sql: string): Promise<void> => {

        const tag = randomUUID().replace(/-/g, '');

        await migrator.query(`savepoint w_${tag}`);

        try {

          await migrator.query(sql);

        } catch {

          await migrator.query(`rollback to savepoint w_${tag}`);

        }

      };

      for (const t of ['A', 'B']) {

        // First, because fin_refunds_payment_fk is ON DELETE RESTRICT: the refund is

        // the referencing side, so it has to go before any payment it names. No trigger

        // lift is needed â€” fin_refunds_prov_trg is BEFORE INSERT OR UPDATE, so DELETE

        // never reaches it.

        await wipe(`delete from fin_refunds where tenant_id = ${q(u(`tenant${t}`))}`);

        await wipe(`delete from fin_document_counters where tenant_id = ${q(u(`tenant${t}`))}`);

        await wipe(`delete from guardians where tenant_id = ${q(u(`tenant${t}`))}`);

        await wipe(`delete from tenants where id = ${q(u(`tenant${t}`))}`);

        await wipe(`delete from users where id = ${q(u(`user${t}`))}`);

      }

      await migrator.query('commit');

    } finally {

      await migrator.query('rollback').catch(() => undefined);

      await migrator.end().catch(() => undefined);

      await app.end().catch(() => undefined);

    }

  });



  // ---------------------------------------------------------------- C-ALLOC-DEL



  it('C-ALLOC-DEL-1 (positive): a settled payment + an apply allocation INSERT succeeds', async () => {

    const inv = await mkInvoice('A', 1);

    await issue('A', inv);

    const pay = await mkPayment('A', 'guardianA');

    const alloc = await mkAlloc('A', pay, inv);



    const row = one(

      await mig(

        `select count(*)::int as n from fin_payment_allocations

          where id = ${q(alloc)} and tenant_id = ${q(u('tenantA'))}`,

      ),

    );

    expect(n1([row])).toBe(1);

    // The whole point of the positive half: the guard is BEFORE DELETE only, so the

    // INSERT path a payment actually takes is untouched.

    const money = await invMoney('A', inv);

    expect(money.balance).toBe(0);

    expect(money.status).toBe('paid');

  });



  it('C-ALLOC-DEL-2 (positive): a permitted UPDATE on an allocation succeeds', async () => {

    const { alloc } = await paid('A', 1);

    // `reason` is free text and provenance columns are not rewritable in practice,

    // but nothing forbids correcting a reason, and A19 forbids DELETE only. A

    // future revision that added a blanket BEFORE UPDATE would break this.

    await mig(`update fin_payment_allocations set reason = 'corrected reason' where id = ${q(alloc)}`);

    expect(

      String(one(await mig(`select reason from fin_payment_allocations where id = ${q(alloc)}`)).reason),

    ).toBe('corrected reason');

  });



  it('C-ALLOC-DEL-3 (negative): a direct DELETE is refused with 55000 naming append-only', async () => {

    const { alloc } = await paid('A', 1);

    const msg = await migReject(`delete from fin_payment_allocations where id = ${q(alloc)}`, '55000');

    expect(msg).toMatch(/append-only/i);

    // And the row is still there: the refusal is the guard's, not a cascade of some

    // later failure.

    expect(n1(await mig(`select count(*)::int as n from fin_payment_allocations where id = ${q(alloc)}`))).toBe(1);

  });



  it('C-ALLOC-DEL-4 (negative): DELETE cannot destroy reversal provenance, and the chain survives', async () => {

    const { inv, pay, alloc } = await paid('A', 1);

    const rev = await mkReverse('A', pay, alloc, inv);



    // Both the target and the reversal that names it refuse deletion.

    for (const victim of [alloc, rev]) {

      const msg = await migReject(`delete from fin_payment_allocations where id = ${q(victim)}`, '55000');

      expect(msg).toMatch(/append-only/i);

    }

    // Provenance is intact in both directions: the reversal still names its target,

    // and the target still exists to be named.

    const row = one(

      await mig(

        `select r.reversal_of_allocation_id as tgt,

                (select count(*)::int from fin_payment_allocations t where t.id = r.reversal_of_allocation_id) as alive

           from fin_payment_allocations r where r.id = ${q(rev)}`,

      ),

    );

    expect(String(row.tgt)).toBe(alloc);

    expect(num(row.alive)).toBe(1);

  });



  it('C-ALLOC-DEL-5 (negative): invoice balance and payment position are unchanged by a refused DELETE', async () => {

    const { inv, pay, alloc } = await paid('A', 1);

    const before = await invMoney('A', inv);

    const posBefore = await payPosition(pay);

    expect(before.balance).toBe(0);

    expect(posBefore?.unallocated).toBe(0);



    await migReject(`delete from fin_payment_allocations where id = ${q(alloc)}`, '55000');



    const after = await invMoney('A', inv);

    const posAfter = await payPosition(pay);

    expect(after).toEqual(before);

    expect(posAfter).toEqual(posBefore);

    // The AFTER DELETE branch of the balance trigger is unreachable; the BEFORE

    // guard aborts first, which is exactly what A19 states.

    expect(n1(await mig(`select count(*)::int as n from fin_payment_allocations where payment_id = ${q(pay)}`))).toBe(1);

  });



  it('C-ALLOC-DEL-6 (negative): DELETE across a tenant boundary is refused, by the guard and by the ACL', async () => {

    const { alloc } = await paid('A', 1);

    // The guard carries no tenant predicate, so the OWNER cannot delete another

    // tenant's money either â€” this is not a privilege story.

    const msg = await migReject(`delete from fin_payment_allocations where id = ${q(alloc)}`, '55000');

    expect(msg).toMatch(/append-only/i);

    // And the application role is stopped earlier, by the ACL: at 0024

    // school_app_rw holds no privilege on any finance table (Â§16.5.1's grants are

    // 0028's), so it never reaches a trigger at all.

    const aclMsg = await appReject(`delete from fin_payment_allocations where id = ${q(alloc)}`, '42501');

    expect(aclMsg).toMatch(/permission denied/i);

  });



  it('C-ALLOC-DEL-7 (negative): no 0024 SECURITY DEFINER can delete an allocation', async () => {

    // Static, and the strong form: the guard's body is an UNCONDITIONAL raise, so

    // there is no scope value, no depth, and no caller that reaches a permitted

    // branch. A guard written as `IF <condition> THEN RAISE` would satisfy

    // C-ALLOC-DEL-3 and fail this.

    const guard = one(

      await mig(

        `select p.prosrc as src, p.prosecdef as definer, p.proconfig as cfg

           from pg_proc p join pg_namespace n on n.oid = p.pronamespace

          where n.nspname = 'public' and p.proname = 'trg_fin_pa_delete_guard'`,

      ),

    );

    const guardCode = codeOf(guard.src);

    expect(guardCode).not.toMatch(/\bif\b/i);

    expect(guardCode).toMatch(/raise\s+exception/i);

    // INVOKER: the guard reads no row and issues no statement, so definership would

    // buy nothing and cost the ability to reason about it from the caller's session.

    expect(guard.definer).toBe(false);



    // No definer in the applied set issues a DELETE at all â€” so there is no

    // function to call, at any scope, that removes an allocation.

    const definers = await mig(

      `select p.proname as fn, p.prosrc as src

         from pg_proc p join pg_namespace n on n.oid = p.pronamespace

        where n.nspname = 'public' and p.prosecdef

          and (p.proname like 'trg\_fin%' or p.proname like 'fn\_fin%')`,

    );

    expect(definers.length).toBeGreaterThan(0);

    for (const d of definers) {

      // The claim is "no definer DELETES AN ALLOCATION", not "no definer ever

      // mentions DELETE": trg_fin_invoice_item_total is AFTER INSERT OR UPDATE OR

      // DELETE and legitimately branches on TG_OP.

      expect(codeOf(d.src), `${String(d.fn)} must not DELETE an allocation`)

        .not.toMatch(/\bdelete\s+from\s+fin_payment_allocations\b/i);

    }

    // And the two 0024 definers are specifically the ones a DELETE escape would

    // most plausibly hide in, since both write rows as part of a cache refresh.

    for (const name of ['trg_fin_challan_refresh', 'trg_fin_invoice_balance_recompute']) {

      const r = one(await mig(`select prosrc as src from pg_proc where proname = ${q(name)}`));

      expect(codeOf(r.src)).not.toMatch(/\bdelete\s+from\s+fin_payment_allocations\b/i);

    }

  });



  it('C-ALLOC-DEL-8 (positive): the correction workflow runs on INSERT alone', async () => {

    const { inv, pay, alloc } = await paid('A', 1);

    expect((await invMoney('A', inv)).balance).toBe(0);



    // Reverse the whole application. No DELETE anywhere in this control.

    await mkReverse('A', pay, alloc, inv, '-100.00');



    const money = await invMoney('A', inv);

    expect(money.balance).toBe(100);

    expect(money.status).toBe('issued');

    // The original allocation is untouched and still present â€” a correction ADDS a

    // row rather than editing one.

    expect(n1(await mig(`select count(*)::int as n from fin_payment_allocations where id = ${q(alloc)}`))).toBe(1);

    const pos = await payPosition(pay);

    expect(pos?.applied).toBe(0);

  });



  it('C-ALLOC-DEL-9 (positive): the refund linkage window is CLOSED at 0025, not open', async () => {

    // refund_id is still a plain nullable column (P0-01) â€” present and optional.

    const col = one(

      await mig(

        `select is_nullable as nullable

           from information_schema.columns

          where table_name = 'fin_payment_allocations' and column_name = 'refund_id'`,

      ),

    );

    expect(String(col.nullable)).toBe('YES');

    // 0025 installed the composite FK and its forward remediation set the action to

    // the canonical NO ACTION ('a'), so the link cannot be silently detached.

    const fk = one(

      await mig(

        `select confdeltype::text as on_delete, convalidated as validated

           from pg_constraint

          where conrelid = 'fin_payment_allocations'::regclass and conname = 'fin_pa_refund_fk'`,

      ),

    );

    expect(String(fk.on_delete)).toBe('a');

    expect(fk.validated).toBe(true);

    // The window is therefore no longer unguarded: a reverse row naming a refund

    // that does not exist is refused by 0025's provenance guard.

    const { pay, alloc, inv } = await paid('A', 1);

    await migReject(

      `insert into fin_payment_allocations

         (id, tenant_id, payment_id, invoice_id, amount, effect, reversal_of_allocation_id, refund_id, reason, created_by)

       values (${q(id('rvGhost'))}, ${q(u('tenantA'))}, ${q(pay)}, ${q(inv)}, '-100.00',

               'reverse', ${q(alloc)}, ${q(id('refundGhost'))}, 'ghost refund', ${q(u('userA'))})`,

      '55000',

    );

    // A reverse row naming a REAL `requested` refund of the same payment, reversing

    // the applied allocation, is accepted: this is the shape 0025 governs.

    const refund = await mkRefund('A', pay, '100.00');

    await mkReverse('A', pay, alloc, inv, '-100.00', refund);

    expect(

      n1(await mig(`select count(*)::int as n from fin_payment_allocations where refund_id = ${q(refund)}`)),

    ).toBe(1);

  });



  it('C-ALLOC-DEL-10 (positive): the guard is BEFORE DELETE only and spares INSERT/UPDATE', async () => {

    const row = one(

      await mig(

        `select t.tgtype as ty, t.tgisinternal as internal, p.proname as fn

           from pg_trigger t

           join pg_class c on c.oid = t.tgrelid

           join pg_proc p on p.oid = t.tgfoid

          where c.relname = 'fin_payment_allocations' and t.tgname = 'trg_fin_allocations_delete_guard'`,

      ),

    );

    const ty = num(row.ty);

    // pg_trigger.tgtype: 1 = ROW, 2 = BEFORE, 64 = INSTEAD OF; of the event bits

    // 4 INSERT, 8 DELETE, 16 UPDATE, 32 TRUNCATE. BEFORE ROW DELETE is therefore

    // 1 + 2 + 8 = 11. Reading bit 1 as "BEFORE" yields 9, which would let this

    // control pass on an AFTER trigger while never noticing an INSERT bit.

    expect(ty).toBe(11);

    expect(row.internal).toBe(false);

    expect(String(row.fn)).toBe('trg_fin_pa_delete_guard');



    // The same table's INSERT and UPDATE paths still work, in one statement each.

    const { inv, pay, alloc } = await paid('A', 1);

    await mig(`update fin_payment_allocations set reason = 'still writable' where id = ${q(alloc)}`);

    const inv2 = await mkInvoice('A', 2);

    await issue('A', inv2);

    const pay2 = await mkPayment('A', 'guardianA');

    await mkAlloc('A', pay2, inv2);

    expect(n1(await mig(`select count(*)::int as n from fin_payment_allocations where payment_id = ${q(pay2)}`))).toBe(1);

  });



  // --------------------------------------------------------------- money model



  it('MONEY: bounds refuse an over-allocation, and allow the exact total', async () => {

    const inv = await mkInvoice('A', 3, '100.00');

    await issue('A', inv);

    const pay = await mkPayment('A', 'guardianA', '100.00');



    await mkAlloc('A', pay, inv, '60.00');

    // The cumulative total is checked, not the row: 60 + 60 > 100 is refused.

    const msg = await migReject(

      `insert into fin_payment_allocations

         (id, tenant_id, payment_id, invoice_id, amount, effect, reason, created_by)

       values (${q(id('over'))}, ${q(u('tenantA'))}, ${q(pay)}, ${q(inv)}, '60.00', 'apply', 'over', ${q(u('userA'))})`,

      '55000',

    );

    expect(msg).toMatch(/exceeding the payment amount/i);

    // 40 more brings the total to exactly 100, which is allowed.

    await mkAlloc('A', pay, inv, '40.00');

    const pos = await payPosition(pay);

    expect(pos?.applied).toBe(100);

    expect(pos?.unallocated).toBe(0);

    expect((await invMoney('A', inv)).status).toBe('paid');

  });



  it('MONEY: an on_account_return is bounded by the UNAPPLIED remainder (DEFECT FOUND HERE)', async () => {

    // Â§13.3.2's literal formula -- SUM of invoice-less non-refunded allocations --

    // cannot work, and this test is where that was found. That SUM contains only

    // rows that fin_pa_effect_ck requires to be NEGATIVE, so it is <= 0 for every

    // payment; combined with NEW.amount < 0 the guard reduces to "always raise",

    // and the on_account_return effect is unreachable. The migration now computes

    // held = payment.amount - applied + already-returned, which is the same

    // quantity fin_v_payment_position.unallocated_amount reports.

    //

    // (1) A payment applied in FULL holds nothing, so any return is refused.

    const full = await paid('A', 4, '100.00');

    const msg = await migReject(

      `insert into fin_payment_allocations

         (id, tenant_id, payment_id, invoice_id, amount, effect, reason, created_by)

       values (${q(id('oar1'))}, ${q(u('tenantA'))}, ${q(full.pay)}, null, '-1.00',

               'on_account_return', 'nothing is held', ${q(u('userA'))})`,

      '55000',

    );

    expect(msg).toMatch(/still held on account/i);



    // (2) Â§13.4 mode `none`: a payment with NO allocations is fully on-account, so

    // it may be returned in full -- the design's own worked example (P2 = 100,000,

    // fully unallocated, "returned in full via one on_account_return row").

    const idle = await mkPayment('A', 'guardianA', '100.00');

    await mig(

      `insert into fin_payment_allocations

         (id, tenant_id, payment_id, invoice_id, amount, effect, reason, created_by)

       values (${q(id('oar2'))}, ${q(u('tenantA'))}, ${q(idle)}, null, '-100.00',

               'on_account_return', 'return in full', ${q(u('userA'))})`,

    );

    const idlePos = await payPosition(idle);

    expect(idlePos?.onAccountReturned).toBe(-100);

    expect(idlePos?.unallocated).toBe(0);



    // (3) Held is now 0, so returning again is refused -- the invariant the control

    // exists for: unallocated can never be driven negative, i.e. over-returned.

    const again = await migReject(

      `insert into fin_payment_allocations

         (id, tenant_id, payment_id, invoice_id, amount, effect, reason, created_by)

       values (${q(id('oar3'))}, ${q(u('tenantA'))}, ${q(idle)}, null, '-0.01',

               'on_account_return', 'over-return', ${q(u('userA'))})`,

      '55000',

    );

    expect(again).toMatch(/still held on account/i);



    // (4) A PARTIALLY applied payment returns exactly its unapplied remainder and

    // no more -- this is what distinguishes "held" from "payment.amount".

    const part = await mkInvoice('A', 5, '100.00');

    await issue('A', part);

    const partPay = await mkPayment('A', 'guardianA', '100.00');

    await mkAlloc('A', partPay, part, '60.00');

    const tooMuch = await migReject(

      `insert into fin_payment_allocations

         (id, tenant_id, payment_id, invoice_id, amount, effect, reason, created_by)

       values (${q(id('oar4'))}, ${q(u('tenantA'))}, ${q(partPay)}, null, '-41.00',

               'on_account_return', 'more than the 40 unapplied', ${q(u('userA'))})`,

      '55000',

    );

    expect(tooMuch).toMatch(/still held on account/i);

    await mig(

      `insert into fin_payment_allocations

         (id, tenant_id, payment_id, invoice_id, amount, effect, reason, created_by)

       values (${q(id('oar5'))}, ${q(u('tenantA'))}, ${q(partPay)}, null, '-40.00',

               'on_account_return', 'exactly the unapplied remainder', ${q(u('userA'))})`,

    );

    const partPos = await payPosition(partPay);

    expect(partPos?.unallocated).toBe(0);

    expect(partPos?.onAccountReturned).toBe(-40);

  });



  it('MONEY: fin_v_payment_position and fin_v_invoice_balance report the derived figures', async () => {

    const { inv, pay } = await paid('A', 5, '250.00');

    const pos = await payPosition(pay);

    expect(pos?.unallocated).toBe(0);

    expect(pos?.applied).toBe(250);

    expect(pos?.refundable).toBe(250);

    expect(pos?.refunded).toBe(0);



    // A settled payment with nothing allocated is wholly unallocated.

    const idle = await mkPayment('A', 'guardianA', '75.00');

    const idlePos = await payPosition(idle);

    expect(idlePos?.unallocated).toBe(75);

    expect(idlePos?.applied).toBe(0);



    // fin_v_invoice_balance excludes drafts: a draft invoice is not visible in it.

    const draft = await mkInvoice('A', 6, '100.00');

    expect(

      n1(await mig(`select count(*)::int as n from fin_v_invoice_balance where invoice_id = ${q(draft)}`)),

    ).toBe(0);

    // The issued one is, with total and balance agreeing.

    const v = one(await mig(`select invoice_total, net_applied, balance from fin_v_invoice_balance where invoice_id = ${q(inv)}`));

    expect(num(v.invoice_total)).toBe(250);

    expect(num(v.net_applied)).toBe(250);

    expect(num(v.balance)).toBe(0);

  });



  it('MONEY: fin_v_payment_position only exposes settled payments', async () => {

    const pending = id('pendingPay');

    await mig(

      `insert into fin_payments

         (id, tenant_id, payment_no, amount, method, status, payer_guardian_id, received_at, received_by, idempotency_key)

       values (${q(pending)}, ${q(u('tenantA'))}, ${q(`PM-${slug}-pend`)}, '50.00', 'cash', 'pending',

               ${q(u('guardianA'))}, now(), ${q(u('userA'))}, ${q(`ik-${slug}-pend`)})`,

    );

    expect(await payPosition(pending)).toBeNull();

  });



  // ------------------------------------------------------------------ reversal



  it('REVERSAL: the shape guard refuses a targetless, foreign, mismatched or oversized reversal', async () => {

    const { inv, pay, alloc } = await paid('A', 7);



    // (1) A reverse row must name what it reverses.

    const m1 = await migReject(

      `insert into fin_payment_allocations

         (id, tenant_id, payment_id, invoice_id, amount, effect, reversal_of_allocation_id, reason, created_by)

       values (${q(id('r1'))}, ${q(u('tenantA'))}, ${q(pay)}, ${q(inv)}, '-10.00', 'reverse', null, 'x', ${q(u('userA'))})`,

      '55000',

    );

    expect(m1).toMatch(/must name the allocation it reverses/i);



    // (2) The target must exist IN THIS TENANT.

    const m2 = await migReject(

      `insert into fin_payment_allocations

         (id, tenant_id, payment_id, invoice_id, amount, effect, reversal_of_allocation_id, reason, created_by)

       values (${q(id('r2'))}, ${q(u('tenantA'))}, ${q(pay)}, ${q(inv)}, '-10.00', 'reverse',

               ${q(id('ghost'))}, 'x', ${q(u('userA'))})`,

      '55000',

    );

    expect(m2).toMatch(/does not exist in this tenant/i);



    // (3) It may not name an invoice its target did not name (P1-13 part 1).

    const other = await mkInvoice('A', 8);

    await issue('A', other);

    const m3 = await migReject(

      `insert into fin_payment_allocations

         (id, tenant_id, payment_id, invoice_id, amount, effect, reversal_of_allocation_id, reason, created_by)

       values (${q(id('r3'))}, ${q(u('tenantA'))}, ${q(pay)}, ${q(other)}, '-10.00', 'reverse',

               ${q(alloc)}, 'x', ${q(u('userA'))})`,

      '55000',

    );

    expect(m3).toMatch(/same invoice as the allocation it reverses/i);



    // (4) It may not exceed the magnitude outstanding (P1-13 part 2): the target is

    // 100.00 applied, so -150.00 is refused.

    const m4 = await migReject(

      `insert into fin_payment_allocations

         (id, tenant_id, payment_id, invoice_id, amount, effect, reversal_of_allocation_id, reason, created_by)

       values (${q(id('r4'))}, ${q(u('tenantA'))}, ${q(pay)}, ${q(inv)}, '-150.00', 'reverse',

               ${q(alloc)}, 'x', ${q(u('userA'))})`,

      '55000',

    );

    expect(m4).toMatch(/exceeds the .* still available on allocation/i);



    // (5) The one legal reversal: exactly the target's magnitude.

    await mkReverse('A', pay, alloc, inv, '-100.00');

    expect((await invMoney('A', inv)).balance).toBe(100);



    // (6) A SECOND correction of the same allocation is refused, and it is the

    // SHAPE guard that refuses it -- available is now 0 -- rather than

    // fin_pa_one_correction_uq. Asserting the index here would be unreachable and

    // therefore untested: BEFORE triggers run before the index, so 23505 cannot

    // occur on this statement. The index is asserted structurally below instead,

    // as the backstop it is.

    const dbl = await migReject(

      `insert into fin_payment_allocations

         (id, tenant_id, payment_id, invoice_id, amount, effect, reversal_of_allocation_id, reason, created_by)

       values (${q(id('r5'))}, ${q(u('tenantA'))}, ${q(pay)}, ${q(inv)}, '-1.00', 'reverse',

               ${q(alloc)}, 'x', ${q(u('userA'))})`,

      '55000',

    );

    expect(dbl).toMatch(/still available/i);



    // The backstop: one correction per allocation where refund_id IS NULL. A

    // correction is all-or-nothing per allocation, so this is what makes two

    // partial corrections of one application unrepresentable.

    expect(

      n1(

        await mig(

          `select count(*)::int as n from pg_indexes

            where tablename = 'fin_payment_allocations' and indexname = 'fin_pa_one_correction_uq'`,

        ),

      ),

    ).toBe(1);



    // (7) Withdrawing the correction is a NEW apply row, not a positive-amount

    // reverse: fin_pa_effect_ck admits reverse only with amount < 0. Applied is 0

    // again, so the bounds guard admits the full 100.

    await mkAlloc('A', pay, inv, '100.00', id('reapply'));

    expect((await invMoney('A', inv)).balance).toBe(0);

  });



  it('REVERSAL: on_account_return is exempt from the shape guard', async () => {

    const pay = await mkPayment('A', 'guardianA', '100.00');

    // trg_fin_reversal_shape returns immediately for this effect: a return names no

    // target, so there is no magnitude to bound against an original allocation.

    // Nothing about the SHAPE would refuse this row.

    await mig(

      `insert into fin_payment_allocations

         (id, tenant_id, payment_id, invoice_id, amount, effect, reason, created_by)

       values (${q(id('oarOk'))}, ${q(u('tenantA'))}, ${q(pay)}, null, '-10.00',

               'on_account_return', 'exempt from shape', ${q(u('userA'))})`,

    );

    expect(n1(await mig(`select count(*)::int as n from fin_payment_allocations where id = ${q(ref('oarOk'))}`))).toBe(1);

    // The exemption is not unbounded: fin_pa_effect_ck still requires invoice_id IS

    // NULL and reversal_of_allocation_id IS NULL on this branch, so a return cannot

    // borrow the shape guard's exemptions to name a target.

    const named = await migReject(

      `insert into fin_payment_allocations

         (id, tenant_id, payment_id, invoice_id, amount, effect, reversal_of_allocation_id, reason, created_by)

       values (${q(id('oarNamed'))}, ${q(u('tenantA'))}, ${q(pay)}, null, '-10.00',

               'on_account_return', ${q(id('someTarget'))}, 'x', ${q(u('userA'))})`,

      '23514',

    );

    expect(named).toMatch(/fin_pa_effect_ck/);

  });



  // ------------------------------------------------------------------ boundary



  it('BOUNDARY: cash may not cross a family boundary', async () => {

    const inv = await mkInvoice('A', 9);

    await issue('A', inv);

    // (1) A payer who is a LIVE guardian of NOBODY.

    const stranger = await mkPayment('A', 'guardianOut', '100.00');

    const m1 = await migReject(

      `insert into fin_payment_allocations

         (id, tenant_id, payment_id, invoice_id, amount, effect, reason, created_by)

       values (${q(id('f1'))}, ${q(u('tenantA'))}, ${q(stranger)}, ${q(inv)}, '100.00', 'apply', 'x', ${q(u('userA'))})`,

      '55000',

    );

    expect(m1).toMatch(/family boundary/i);



    // (2) A payer whose guardianship link exists but whose guardian is SOFT-DELETED.

    // The guard demands g.deleted_at IS NULL, so a link row alone is not enough.

    const soft = await mkPayment('A', 'guardianSoft', '100.00');

    const m2 = await migReject(

      `insert into fin_payment_allocations

         (id, tenant_id, payment_id, invoice_id, amount, effect, reason, created_by)

       values (${q(id('f2'))}, ${q(u('tenantA'))}, ${q(soft)}, ${q(inv)}, '100.00', 'apply', 'x', ${q(u('userA'))})`,

      '55000',

    );

    expect(m2).toMatch(/family boundary/i);

  });



  it('BOUNDARY: a cross-tenant payment cannot back an allocation, and a draft invoice cannot be paid', async () => {

    const inv = await mkInvoice('A', 10);

    await issue('A', inv);

    const bPay = await mkPayment('B', 'guardianB', '100.00');



    // Tenant A's allocation naming tenant B's payment. The composite FK

    // (tenant_id, payment_id) WOULD stop this at 23503, but PostgreSQL runs BEFORE

    // triggers before constraint checks, so trg_fin_allocation_bounds refuses it at

    // 55000 first. Asserting 23503 would pass on a build carrying no guard at all,

    // which is the wrong reason to be safe; the FK is proved in

    // finance-composite-fk.test.ts.

    const msg = await migReject(

      `insert into fin_payment_allocations

         (id, tenant_id, payment_id, invoice_id, amount, effect, reason, created_by)

       values (${q(id('x1'))}, ${q(u('tenantA'))}, ${q(bPay)}, ${q(inv)}, '100.00', 'apply', 'x', ${q(u('userA'))})`,

      '55000',

    );

    expect(msg).toMatch(/unknown payment/i);



    // D9 (Â§12.5.1, Â§36.2 row 46, a P0): cash may not be applied to a draft.

    const draft = await mkInvoice('A', 11);

    const draftPay = await mkPayment('A', 'guardianA', '100.00');

    const dmsg = await migReject(

      `insert into fin_payment_allocations

         (id, tenant_id, payment_id, invoice_id, amount, effect, reason, created_by)

       values (${q(id('x2'))}, ${q(u('tenantA'))}, ${q(draftPay)}, ${q(draft)}, '100.00', 'apply', 'x', ${q(u('userA'))})`,

      '55000',

    );

    expect(dmsg).toMatch(/only an issued invoice may be paid/i);

    expect(String(one(await mig(`select status from fin_invoices where id = ${q(draft)}`)).status)).toBe('draft');

  });



  // ------------------------------------------------------------------- receipt



  it('RECEIPT: the amount is stamped FROM the payment, not validated against it', async () => {

    const pay = await mkPayment('A', 'guardianA', '100.00');

    const rec = id('receipt');

    // A deliberately wrong amount, and a deliberately wrong payer. Design Â§25.5:

    // the receipt "overwrites amount from the payment rather than validating it",

    // and Â§25.5's payer column is "frozen from the payment at issue".

    await mig(

      `insert into fin_receipts

         (id, tenant_id, receipt_no, payment_id, payer_guardian_id, amount, currency, method, received_at, received_by, snapshot, version)

       values (${q(rec)}, ${q(u('tenantA'))}, ${q(`R-${slug}-1`)}, ${q(pay)}, ${q(u('guardianOut'))},

               999999.00, 'PKR', 'cash', now(), ${q(u('userA'))}, '{}'::jsonb, 1)`,

    );

    const row = one(await mig(`select amount, payer_guardian_id from fin_receipts where id = ${q(rec)}`));

    // Stamped, not refused. This is the control's real content: a receipt is a

    // document whose figure is DERIVED, so it cannot be used to assert a payment of

    // a different size.

    expect(num(row.amount)).toBe(100);

    expect(String(row.payer_guardian_id)).toBe(u('guardianA'));

  });



  it('RECEIPT: a receipt is immutable for life â€” no UPDATE, no DELETE, and no status column to void', async () => {

    const pay = await mkPayment('A', 'guardianA', '100.00');

    const rec = id('receipt2');

    await mig(

      `insert into fin_receipts

         (id, tenant_id, receipt_no, payment_id, payer_guardian_id, amount, currency, method, received_at, received_by, snapshot)

       values (${q(rec)}, ${q(u('tenantA'))}, ${q(`R-${slug}-2`)}, ${q(pay)}, ${q(u('guardianA'))},

               100.00, 'PKR', 'cash', now(), ${q(u('userA'))}, '{}'::jsonb)`,

    );

    const uMsg = await migReject(`update fin_receipts set amount = 1.00 where id = ${q(rec)}`, '55000');

    expect(uMsg).toMatch(/immutable/i);

    // 0028 (recon §B.2.10): fin_receipts has NO DELETE policy, so the owner's
    // DELETE is refused by SILENCE - 0 rows, no error to mishandle - not by a
    // 55000. The row must still exist afterwards.
    await mig(`delete from fin_receipts where id = ${q(rec)}`);

    expect(n1(await mig(`select count(*)::int as n from fin_receipts where id = ${q(rec)}`))).toBe(1);

    // There is no `status` column and no `voided_at` on fin_receipts â€” a correction

    // is a new `version` (Â§25.5, FI-019), so "void this receipt" is not expressible.

    expect(

      n1(

        await mig(

          `select count(*)::int as n from information_schema.columns

            where table_name = 'fin_receipts' and column_name in ('status','voided_at','void_reason')`,

        ),

      ),

    ).toBe(0);

    // And a superseding receipt must declare a higher version.

    const badVer = await migReject(

      `insert into fin_receipts

         (id, tenant_id, receipt_no, payment_id, payer_guardian_id, amount, currency, method, received_at, received_by, snapshot, version, supersedes_id)

       values (${q(id('receipt3'))}, ${q(u('tenantA'))}, ${q(`R-${slug}-3`)}, ${q(pay)}, ${q(u('guardianA'))},

               100.00, 'PKR', 'cash', now(), ${q(u('userA'))}, '{}'::jsonb, 1, ${q(rec)})`,

      '23514',

    );

    expect(badVer).toMatch(/fin_receipts_version_ck/);

  });



  // ------------------------------------------------------------------- challan



  it('CHALLAN: status is derived from the invoice balance, and void is terminal', async () => {

    const { inv, pay } = await paid('A', 12, '100.00');

    const ch = id('challan');

    // Paid in full, so the derived status is 'paid' â€” the trigger decides from

    // fin_v_invoice_balance, not from what the caller asked for.

    await mig(

      `insert into fin_challans (id, tenant_id, invoice_id, due_on, issued_at, status, snapshot)

       values (${q(ch)}, ${q(u('tenantA'))}, ${q(inv)}, current_date + 30, now(), 'issued', '{}'::jsonb)`,

    );

    expect(String(one(await mig(`select status from fin_challans where id = ${q(ch)}`)).status)).toBe('paid');



    // The snapshot is immutable.

    const sMsg = await migReject(`update fin_challans set snapshot = '{"a":1}'::jsonb where id = ${q(ch)}`, '55000');

    expect(sMsg).toMatch(/immutable/i);



    // And a challan may not be voided directly â€” only through its invoice.

    const vMsg = await migReject(

      `update fin_challans set status = 'void', voided_at = now(), void_reason = 'x' where id = ${q(ch)}`,

      '55000',

    );

    expect(vMsg).toMatch(/only be voided via its invoice/i);



    // Voiding an invoice that still carries SETTLED CASH is refused, and this is

    // the correct refusal: trg_fin_invoice_void (row 8a/0024) demands the

    // allocation be withdrawn first, so money is never stranded on a dead invoice.

    // Asserted here because the obvious way to void this invoice -- the one just

    // paid in full -- is exactly the mistake the guard exists to catch.

    const refundMsg = await migReject(

      `update fin_invoices set status = 'void', void_reason = 'uncollectible' where id = ${q(inv)}`,

      '55000',

    );

    expect(refundMsg).toMatch(/refund invoice .* before voiding it/i);



    // An UNPAID invoice voids, and its challan follows via trg_fin_challan_refresh

    // (a SECURITY DEFINER, because the application role may not UPDATE

    // fin_challans directly -- the refresh is the only writer).

    const unpaid = await mkInvoice('A', 1, '100.00');

    await issue('A', unpaid);

    const ch2 = id('challan2');

    await mig(

      `insert into fin_challans (id, tenant_id, invoice_id, due_on, issued_at, status, snapshot)

       values (${q(ch2)}, ${q(u('tenantA'))}, ${q(unpaid)}, current_date + 30, now(), 'issued', '{}'::jsonb)`,

    );

    // Balance is the full total, so the derived status is 'issued', not 'paid'.

    expect(String(one(await mig(`select status from fin_challans where id = ${q(ch2)}`)).status)).toBe('issued');

    await mig(`update fin_invoices set status = 'void', void_reason = 'uncollectible' where id = ${q(unpaid)}`);

    expect(String(one(await mig(`select status from fin_challans where id = ${q(ch2)}`)).status)).toBe('void');

    void pay;

  });



  // ------------------------------------------------------------ C-SEC at 0024



  it('C-SEC-M4b: the applied set reaches 0024 â€” 24 bound functions, 5 definers, helper unbound', async () => {

    const rows = await mig(

      `select p.proname as fn, p.prosecdef as definer

         from pg_proc p join pg_namespace n on n.oid = p.pronamespace

        where n.nspname = 'public' and p.proname in (${BOUND_0024.map(q).join(',')})`,

    );

    expect(rows).toHaveLength(24);

    const def = Object.fromEntries(rows.map((r) => [String(r.fn), r.definer]));

    const definers = Object.entries(def).filter(([, d]) => d === true).map(([n]) => n).sort();

    expect(definers).toEqual([...DEFINERS_0024].sort());

    // Row 13 is the producer the whole maintenance story depends on, and it IS a

    // definer; the F5h helper it calls is NOT, and is bound to no trigger.

    expect(def.trg_fin_invoice_balance_recompute).toBe(true);

    const helper = one(

      await mig(

        `select p.prosecdef as definer,

                (select count(*)::int from pg_trigger t where t.tgfoid = p.oid) as bound

           from pg_proc p join pg_namespace n on n.oid = p.pronamespace

          where n.nspname = 'public' and p.proname = 'fin_invoice_reapply_derived_state'`,

      ),

    );

    expect(helper.definer).toBe(false);

    expect(num(helper.bound)).toBe(0);

  });



  it('BOUNDARY/FIDELITY: the two views are SECURITY INVOKER and expose no un-granted row to the app role', async () => {

    const rows = await mig(

      `select c.relname as name, c.reloptions as opts

         from pg_class c join pg_namespace n on n.oid = c.relnamespace

        where n.nspname = 'public' and c.relname in ('fin_v_payment_position','fin_v_invoice_balance')`,

    );

    expect(rows).toHaveLength(2);

    for (const v of rows) {

      expect(String(v.opts), `${String(v.name)} must be security_invoker=on`).toMatch(/security_invoker=on/);

    }

    // 0028 Shape 7 grants SELECT on both views to the runtime role. A view
    // marked security_invoker still cannot become a way around the ACL: the bare
    // session carries no signed ticket, so RLS silence returns zero rows rather
    // than a leaked row that the column ACL would have refused.

    const bal = await app.query(`select count(*)::int as n from fin_v_invoice_balance`);

    expect(Number(bal.rows[0]?.n)).toBe(0);

    const pos = await app.query(`select count(*)::int as n from fin_v_payment_position`);

    expect(Number(pos.rows[0]?.n)).toBe(0);

  });



  // ------------------------------------------------------------ 0025 refund fixture



  it('FIXTURE: mkRefund creates exactly one valid requested refund, and decides nothing', async () => {

    // A bare payment is the whole dependency: no invoice, no allocation, no

    // enrollment, because fin_refunds names only fin_payments.

    const pay = await mkPayment('A', 'guardianA', '250.00');

    const refund = await mkRefund('A', pay, '40.0000');



    // The RETURNED id is the one that was registered, not a fresh allocation â€”

    // `ref` rather than `id` is the whole reason that distinction exists (:75-82).

    expect(refund).toBe(ref('refA'));



    const row = one(

      await mig(

        `select tenant_id, payment_id, amount, status, reason, requested_by, requested_at,

                refund_no, idempotency_key, decided_by, decided_at, processed_by, processed_at,

                rejection_reason, disbursement_reference, applied_allocations,

                jsonb_typeof(proposed_allocations) as prop_kind,

                jsonb_array_length(proposed_allocations) as prop_len

           from fin_refunds where id = ${q(refund)}`,

      ),

    );

    expect(String(row.tenant_id)).toBe(u('tenantA'));

    expect(String(row.payment_id)).toBe(pay);

    expect(num(row.amount)).toBe(40);

    expect(String(row.status)).toBe('requested');

    expect(String(row.requested_by)).toBe(u('userA'));

    // requested_at is NOT NULL DEFAULT now(), so a non-null value proves the row was

    // really inserted rather than assembled by the assertion.

    expect(row.requested_at).not.toBeNull();

    expect(String(row.refund_no).length).toBeGreaterThan(0);

    expect(String(row.idempotency_key).length).toBeGreaterThan(0);

    // An empty ARRAY, not merely valid jsonb: a '{}' would satisfy the column's CHECK

    // and be the wrong shape for a request that proposes nothing.

    expect(String(row.prop_kind)).toBe('array');

    expect(num(row.prop_len)).toBe(0);

    // Nothing is decided and nothing is processed. This is the 'requested' arm of

    // fin_refunds_decision_ck asserted from the read side rather than inferred from

    // the INSERT's column list, so a helper that grew a decision column would fail.

    for (const c of [

      'decided_by', 'decided_at', 'processed_by', 'processed_at',

      'rejection_reason', 'disbursement_reference', 'applied_allocations',

    ]) {

      expect(row[c], `${c} must be NULL on a requested refund`).toBeNull();

    }



    // One row for this payment, and no allocation of any kind: the helper stages a

    // request and moves no money.

    expect(n1(await mig(`select count(*)::int as n from fin_refunds where payment_id = ${q(pay)}`))).toBe(1);

    expect(n1(await mig(`select count(*)::int as n from fin_payment_allocations where payment_id = ${q(pay)}`))).toBe(0);

  });



  // ------------------------------------------------ 0025 refund provenance (P1/P2/P3)

  //

  // FIRE ORDER MATTERS FOR EVERY NEGATIVE BELOW. PostgreSQL runs the BEFORE INSERT

  // triggers of one statement in ALPHABETICAL ORDER BY TRIGGER NAME, so on

  // fin_payment_allocations the 0024 guards all precede 0025's:

  //

  //   fin_allocations_bounds -> fin_allocations_family -> fin_allocations_onaccount

  //   -> fin_allocations_shape -> fin_allocations_target_state

  //   -> fin_pa_refund_prov_trg          <-- 0025, LAST

  //

  // So a case that wants 0025 to be the layer that refuses must first be admitted by

  // all five. Two of them stand aside on their own for a refund-linked row:

  // trg_fin_allocation_bounds returns immediately when refund_id IS NOT NULL

  // (0024:1224), and trg_fin_reversal_shape returns immediately for any effect that

  // is not 'reverse' (0024:1014-1019). CHECK constraints are evaluated AFTER all

  // BEFORE triggers, which is what decides P3.



  it('P1 (positive): a reverse allocation naming a refund of the SAME payment is accepted', async () => {

    const { inv, pay, alloc } = await paid('A', 9, '100.00');

    const refund = await mkRefund('A', pay, '100.00');

    const rev = await mkReverse('A', pay, alloc, inv, '-100.00', refund);



    // Read the row back rather than trusting the INSERT's return: every column the

    // three-way agreement is about, read from the table.

    const row = one(

      await mig(

        `select tenant_id, payment_id, invoice_id, amount, effect, refund_id, reversal_of_allocation_id

           from fin_payment_allocations where id = ${q(rev)}`,

      ),

    );

    expect(String(row.refund_id)).toBe(refund);

    expect(String(row.effect)).toBe('reverse');

    expect(num(row.amount)).toBe(-100);

    expect(String(row.reversal_of_allocation_id)).toBe(alloc);

    expect(String(row.invoice_id)).toBe(inv);



    // The refund names that same payment, and both rows agree on the tenant -- the

    // three-way agreement the trigger exists to enforce, satisfied.

    const r = one(await mig(`select tenant_id, payment_id, status from fin_refunds where id = ${q(refund)}`));

    expect(String(r.payment_id)).toBe(pay);

    expect(String(r.status)).toBe('requested');

    expect(String(row.payment_id)).toBe(String(r.payment_id));

    expect(String(row.tenant_id)).toBe(u('tenantA'));

    expect(String(r.tenant_id)).toBe(String(row.tenant_id));



    // And the reversal really moved money: the invoice is back to its full balance.

    expect((await invMoney('A', inv)).balance).toBe(100);

  });



  it('P2 (negative): a reverse allocation naming a refund of ANOTHER payment is refused with 55000', async () => {

    // Payment A, and a refund that belongs to it.

    const a = await paid('A', 10, '100.00');

    const refund = await mkRefund('A', a.pay, '100.00');



    // Payment B: its own issued invoice and its own fully applied allocation, so the

    // reversal below is legitimate in EVERY respect except the refund it names.

    const invB = await mkInvoice('A', 11, '100.00');

    await issue('A', invB);

    const payB = await mkPayment('A', 'guardianA', '100.00');

    const allocB = await mkAlloc('A', payB, invB, '100.00');



    const bad = id('crossPay');

    const msg = await migReject(

      `insert into fin_payment_allocations

         (id, tenant_id, payment_id, invoice_id, amount, effect, reversal_of_allocation_id, refund_id, reason, created_by)

       values (${q(bad)}, ${q(u('tenantA'))}, ${q(payB)}, ${q(invB)}, '-100.00', 'reverse',

               ${q(allocB)}, ${q(refund)}, 'cross-payment refund', ${q(u('userA'))})`,

      '55000',

    );

    expect(msg).toMatch(/does not match refund/i);



    // The refusal is 0025's, not an earlier guard's: the message names the payment

    // disagreement, which only trg_fin_refund_provenance words that way.

    expect(msg).toMatch(new RegExp(String(payB)));

    expect(msg).toMatch(new RegExp(String(a.pay)));



    // Nothing persisted -- proved by reading the table, not by trusting the rollback.

    expect(n1(await mig(`select count(*)::int as n from fin_payment_allocations where id = ${q(bad)}`))).toBe(0);

    expect(

      n1(

        await mig(

          `select count(*)::int as n from fin_payment_allocations

             where payment_id = ${q(payB)} and refund_id = ${q(refund)}`,

        ),

      ),

    ).toBe(0);

    // No allocation anywhere in the tenant pairs that refund with a foreign payment.

    expect(

      n1(

        await mig(

          `select count(*)::int as n from fin_payment_allocations a

             join fin_refunds r on r.id = a.refund_id

            where a.payment_id is distinct from r.payment_id`,

        ),

      ),

    ).toBe(0);

    // Payment B's own legitimate allocation is untouched, so the refusal was this

    // statement's and not a cascade of some later failure.

    expect(n1(await mig(`select count(*)::int as n from fin_payment_allocations where id = ${q(allocB)}`))).toBe(1);

  });



  it('P3 (negative): a non-reverse effect naming a refund is refused by the 0025 provenance guard', async () => {

    // One payment of 200 with 100 applied, so the on-account branch of this case has

    // real held money to work with (v_held = 200 - 100 = 100) and is not refused by

    // trg_fin_on_account_return_bounds before 0025 is ever reached.

    const inv = await mkInvoice('A', 12, '100.00');

    await issue('A', inv);

    const pay = await mkPayment('A', 'guardianA', '200.00');

    await mkAlloc('A', pay, inv, '100.00');

    const refund = await mkRefund('A', pay, '40.00');



    // (1) effect = 'apply' with refund_id set. fin_pa_effect_ck ALSO forbids this

    // shape (0024:217-222), but a CHECK is evaluated only after every BEFORE

    // trigger, so the observed refusal is 0025's 55000 and the check is never

    // reached. Asserting 23514 here would be the wrong reason to be safe.

    const asApply = id('applyNamingRefund');

    const applyMsg = await migReject(

      `insert into fin_payment_allocations

         (id, tenant_id, payment_id, invoice_id, amount, effect, refund_id, reason, created_by)

       values (${q(asApply)}, ${q(u('tenantA'))}, ${q(pay)}, ${q(inv)}, '10.00', 'apply',

               ${q(refund)}, 'apply naming a refund', ${q(u('userA'))})`,

      '55000',

    );

    expect(applyMsg).toMatch(/must have effect = 'reverse'/i);



    // (2) The other non-reverse effect. trg_fin_allocation_bounds stands aside

    // (refund_id IS NOT NULL) and trg_fin_on_account_return_bounds is satisfied by

    // the 100 still held, so 0025 is once more the layer that refuses -- which is

    // what makes this a property of the GUARD rather than of one effect value.

    const asReturn = id('returnNamingRefund');

    const returnMsg = await migReject(

      `insert into fin_payment_allocations

         (id, tenant_id, payment_id, invoice_id, amount, effect, refund_id, reason, created_by)

       values (${q(asReturn)}, ${q(u('tenantA'))}, ${q(pay)}, null, '-10.00', 'on_account_return',

               ${q(refund)}, 'return naming a refund', ${q(u('userA'))})`,

      '55000',

    );

    expect(returnMsg).toMatch(/must have effect = 'reverse'/i);



    // Neither attempt persisted, and no allocation in the tenant names this refund.

    expect(n1(await mig(`select count(*)::int as n from fin_payment_allocations where id = ${q(asApply)}`))).toBe(0);

    expect(n1(await mig(`select count(*)::int as n from fin_payment_allocations where id = ${q(asReturn)}`))).toBe(0);

    expect(

      n1(await mig(`select count(*)::int as n from fin_payment_allocations where refund_id = ${q(refund)}`)),

    ).toBe(0);

    // The refund is untouched and still requested: a refused linkage does not decide it.

    expect(String(one(await mig(`select status from fin_refunds where id = ${q(refund)}`)).status)).toBe('requested');

  });



  it('R1: a fresh refund INSERT scans an empty set, so that branch is vacuous by construction', async () => {

    const pay = await mkPayment('A', 'guardianA', '100.00');

    const refund = await mkRefund('A', pay, '50.00');



    // The fin_refunds branch of trg_fin_refund_provenance scans

    // fin_payment_allocations WHERE refund_id = NEW.id. On a fresh id that set is

    // empty -- measured, not assumed -- and fin_pa_refund_fk makes it impossible to

    // be anything else: an allocation may only name a refund that already exists.

    // So this INSERT reaches the branch and returns NEW without ever raising, and

    // there is NO honest negative case for this branch on the INSERT path.

    expect(

      n1(await mig(`select count(*)::int as n from fin_payment_allocations where refund_id = ${q(refund)}`)),

    ).toBe(0);

    // The row the FIXTURE case asserts is therefore reached THROUGH the trigger,

    // not around it.

    expect(n1(await mig(`select count(*)::int as n from fin_refunds where id = ${q(refund)}`))).toBe(1);

  });



  it('R1b (supplementary): the refund-side payment re-point guard is GONE by D2, so the re-point now succeeds', async () => {

    // D2 ordered the refund-side FOR UPDATE scan removed from trg_fin_refund_provenance

    // and explicitly forbade replacing it with another scan, a weaker approximation,

    // retries, SERIALIZABLE, or a deferrable FK. This test pins the RESULT of that

    // decision rather than the old guard, because the old guard was NOT in fact vacuous

    // on this path. fin_pa_refund_fk being NOT DEFERRABLE only proves an allocation can

    // never name a refund that does not exist yet (the BEFORE INSERT case). It does NOT

    // stop an existing, already-referenced refund from later being re-pointed at a

    // different payment, which is precisely what happens here.

    // The probe below therefore SUCCEEDS: fin_refunds_prov_trg is the only trigger on

    // fin_refunds, and after the D2 removal nothing else guards payment_id.

    const { inv, pay, alloc } = await paid('A', 1, '100.00');

    const refund = await mkRefund('A', pay, '100.00');

    await mkReverse('A', pay, alloc, inv, '-100.00', refund);

    const other = await mkPayment('A', 'guardianA', '100.00');



    // No 55000 is raised any more. This is a deliberate, owner-directed loss of a

    // defense-in-depth check at the 0025 checkpoint -- NOT a silent simplification.

    await mig(`update fin_refunds set payment_id = ${q(other)} where id = ${q(refund)}`);

    // The re-point took: the refund now names a payment it never had a reversal in.

    expect(String(one(await mig(`select payment_id from fin_refunds where id = ${q(refund)}`)).payment_id)).toBe(other);

    // The reversal still names the refund, so the two sides now disagree. This
    // incoherent pairing is exactly the state the removed branch used to forbid, and
    // it is the residual risk this checkpoint knowingly accepts until 0028 owns the
    // refund lifecycle.
    expect(

      n1(

        await mig(

          `select count(*)::int as n from fin_payment_allocations where refund_id = ${q(refund)}`,

        ),

      ),

    ).toBe(1);

    // Mitigating control at this checkpoint: the runtime role cannot reach this state
    // at all. 0025_privilege_remediation.sql leaves school_app_rw with no privilege on
    // fin_refunds, so only the migration/owner role can perform the re-point.
    const viaApp = await appReject(
      `update fin_refunds set payment_id = ${q(pay)} where id = ${q(refund)}`,
      '42501',
    );
    expect(viaApp).toBeTruthy();

  });

  // ------------------------------------------------ 0025 deferred refund ceiling (C1â€“C3)

  it('C1 (per-refund ceiling): sum of reverse amounts for refund > refund.amount is rejected at deferred check', async () => {

    const { inv, pay, alloc } = await paid('A', 2, '100.00');

    const refund = await mkRefund('A', pay, '50.00');

    const badRev = id('revOverPerRefund');

    const sp = 'c1_' + badRev.replace(/-/g, '');

    await migrator.query('savepoint ' + sp);

    try {

      await mig(

        'insert into fin_payment_allocations (id, tenant_id, payment_id, invoice_id, amount, effect, reversal_of_allocation_id, refund_id, reason, created_by) values (' +

          q(badRev) + ',' + q(u('tenantA')) + ',' + q(pay) + ',' + q(inv) + ", '-100.00', 'reverse'," +

          q(alloc) + ',' + q(refund) + ",'rev ceiling test'," + q(u('userA')) + ')'

      );

      await mig('SET CONSTRAINTS fin_allocations_refund_ceiling IMMEDIATE');

      await migrator.query('rollback to savepoint ' + sp);

      throw new Error('expected SET CONSTRAINTS to reject');

    } catch (e) {

      const err = e as { code?: string; message: string };

      await migrator.query('rollback to savepoint ' + sp);

      if (err.code !== '55000') {

        throw new Error('expected SQLSTATE 55000, got ' + (err.code ?? '?') + ': ' + err.message);

      }

      expect(n1(await mig('select count(*)::int as n from fin_payment_allocations where id = ' + q(badRev)))).toBe(0);

      expect(err.message).toMatch(/ceiling violated/i);

    }

  });



  it('C3 (exact ceiling): sum(reverse)=refund.amount is allowed; can reach transaction completion', async () => {

    const inv = await mkInvoice('A', 4, '100.00');

    await issue('A', inv);

    const pay = await mkPayment('A', 'guardianA', '100.00');

    const alloc = await mkAlloc('A', pay, inv, '100.00');

    const refund = await mkRefund('A', pay, '50.00');

    const rev = id('revExact');

    const sp = 'c3_' + rev.replace(/-/g, '');

    await migrator.query('savepoint ' + sp);

    try {

      await mig(

        'insert into fin_payment_allocations (id, tenant_id, payment_id, invoice_id, amount, effect, reversal_of_allocation_id, refund_id, reason, created_by) values (' +

          q(rev) + ',' + q(u('tenantA')) + ',' + q(pay) + ',' + q(inv) + ", '-50.00', 'reverse'," +

          q(alloc) + ',' + q(refund) + ",'exact'," + q(u('userA')) + ')'

      );

      await mig('SET CONSTRAINTS fin_allocations_refund_ceiling IMMEDIATE');

      await migrator.query('rollback to savepoint ' + sp);

    } catch (e) {

      await migrator.query('rollback to savepoint ' + sp);

      throw e;

    }

  });



  it('C3 (update path): updating reverse amount beyond ceiling is rejected; valid update is allowed', async () => {

    const { inv, pay, alloc } = await paid('A', 5, '100.00');

    const refund = await mkRefund('A', pay, '50.00');

    const rev = id('revUpd');

    await mig(

      'insert into fin_payment_allocations (id, tenant_id, payment_id, invoice_id, amount, effect, reversal_of_allocation_id, refund_id, reason, created_by) values (' +

        q(rev) + ',' + q(u('tenantA')) + ',' + q(pay) + ',' + q(inv) + ", '-40.00', 'reverse'," +

        q(alloc) + ',' + q(refund) + ",'upd'," + q(u('userA')) + ')'

    );

    await mig("update fin_payment_allocations set amount = '-50.00' where id = " + q(rev));

    await mig('SET CONSTRAINTS fin_allocations_refund_ceiling IMMEDIATE');

    const spu = 'c3u_' + rev.replace(/-/g, '');

    await migrator.query('savepoint ' + spu);

    try {

      await mig("update fin_payment_allocations set amount = '-60.00' where id = " + q(rev));

      await mig('SET CONSTRAINTS fin_allocations_refund_ceiling IMMEDIATE');

      await migrator.query('rollback to savepoint ' + spu);

      throw new Error('expected SET CONSTRAINTS to reject');

    } catch (e) {

      const err = e as { code?: string; message: string };

      await migrator.query('rollback to savepoint ' + spu);

      if (err.code !== '55000') {

        throw new Error('expected SQLSTATE 55000, got ' + (err.code ?? '?') + ': ' + err.message);

      }

      expect(num(one(await mig('select amount from fin_payment_allocations where id = ' + q(rev))).amount)).toBe(-50);

    }

  });

  // ------------------------------------------------ 0025 tenant/isolation & ACL (T1â€“T3)

  it('T1 (negative): tenant B cannot create refund referencing tenant A payment', async () => {

    const tA = 'A'; const tB = 'B';

    // Ensure A exists minimally

    const bad = id('badT1');

    // Try to create refund in tenant B referencing a payment from tenant A - need existing A payment

    const invA = await mkInvoice('A', 1, '100.00');

    await issue('A', invA);

    const payA = await mkPayment('A', 'guardianA', '100.00');

    const sp = 't1_' + bad.replace(/-/g, '');

    await migrator.query('savepoint ' + sp);

    try {

      await mig('insert into fin_refunds (id, tenant_id, refund_no, payment_id, amount, reason, proposed_allocations, requested_by, idempotency_key) values (' + q(bad) + ',' + q(u('tenantB')) + ",'RF-BAD'," + q(payA) + ", '50.00', 'x', '[]'::jsonb," + q(u('userB')) + ",'bad-key')");

      await migrator.query('rollback to savepoint ' + sp);

      throw new Error('expected');

    } catch (e) {

      const err = e as { code?: string; message: string };

      await migrator.query('rollback to savepoint ' + sp);

      if (err.code !== '23503' && err.code !== '55000') {

        throw new Error('bad ' + (err.code ?? '?'));

      }

      expect(n1(await mig('select count(*)::int as n from fin_refunds where id=' + q(bad)))).toBe(0);

    }

    const good = await mkRefund('A', payA, '10.00');

    expect(n1(await mig('select count(*)::int as n from fin_refunds where id=' + q(good)))).toBe(1);

  });

  it('T2 (negative): cross-tenant allocation cannot reference refund', async () => {

    // use existing seeded context A,B

    await mig('SET search_path = pg_catalog, public, pg_temp');

    const invA = await mkInvoice('A', 1, '100.00');

    await issue('A', invA);

    const payA = await mkPayment('A', 'guardianA', '100.00');

    const refA = await mkRefund('A', payA, '20.00');

    const invB = await mkInvoice('B', 1, '100.00');

    await issue('B', invB);

    const payB = await mkPayment('B', 'guardianB', '100.00');

    const allocB = await mkAlloc('B', payB, invB, '100.00');

    const bad = id('badAllocCross');

    const sp = 't2_' + bad.replace(/-/g, '');

    await migrator.query('savepoint ' + sp);

    try {

      await mig(

        'insert into fin_payment_allocations (id, tenant_id, payment_id, invoice_id, amount, effect, reversal_of_allocation_id, refund_id, reason, created_by) values (' +

          q(bad) + ',' + q(u('tenantB')) + ',' + q(payB) + ',' + q(invB) + ", '-20.00', 'reverse'," +

          q(allocB) + ',' + q(refA) + ",'x'," + q(u('userB')) + ')'

      );

      await migrator.query('rollback to savepoint ' + sp);

      throw new Error('expected rejection');

    } catch (e) {

      const err = e as { code?: string; message: string };

      await migrator.query('rollback to savepoint ' + sp);

      if (err.code !== '23503' && err.code !== '55000') {

        throw new Error('unexpected SQLSTATE ' + (err.code ?? '?') + ': ' + err.message);

      }

      expect(n1(await mig('select count(*)::int as n from fin_payment_allocations where id = ' + q(bad)))).toBe(0);

    }

  });




  // ------------------------------------------------ 0025 ACL (T3)
  it("T3 (ACL+RLS): at the 0028 stage fin_refunds is granted S+I with FORCE RLS — a bare session is refused by silence, and UPDATE/DELETE/TRUNCATE stay 42501", async () => {
    const invA = await mkInvoice("A", 1, "100.00");
    await issue("A", invA);
    const payA = await mkPayment("A", "guardianA", "100.00");
    const r = await mkRefund("A", payA, "5.00");

    // D1 fail-closed: 0028 REVOKEs and re-grants §D.2 Shape 3 (SELECT, INSERT)
    // on fin_refunds and FORCE RLS. A BARE app session (no signed ticket)
    // satisfies neither `app_privileged()` nor the tenant-scoped finance_staff
    // conjunct, so the SELECT and INSERT are refused by RLS silence — zero rows,
    // no error — not by the ACL.
    const sel = await app.query("select count(*)::int as n from fin_refunds");
    expect(Number(sel.rows[0]?.n)).toBe(0);

    const r2 = id("r2");
    const ins = await appReject(
      `insert into fin_refunds (id, tenant_id, refund_no, payment_id, amount, reason, proposed_allocations, requested_by, idempotency_key) values ('` +
        r2 +
        `','` +
        u("tenantA") +
        `','RF-T3X','` +
        payA +
        `',5.00,'x','[]'::jsonb,'` +
        u("userA") +
        `','ikr-t3x')`,
      "42501",
    );
    // An INSERT has no result-set "0 rows": a WITH CHECK that admits nothing is
    // reported as the 42501 RLS violation, which is the layer failing closed.
    expect(ins).toMatch(/row-level security/i);
    // The refused INSERT really wrote nothing.
    const ghost = await mig(`select count(*)::int as n from fin_refunds where id = '${r2}'`);
    expect(n1(ghost)).toBe(0);

    // UPDATE, DELETE and TRUNCATE are not granted to the runtime role in Shape 3,
    // so they still raise 42501 at the ACL check.
    await appReject("update fin_refunds set reason='y' where id='" + r + "'", "42501");
    await appReject("delete from fin_refunds where id='" + r + "'", "42501");
    await appReject("truncate fin_refunds", "42501");

    // The migration role can still stage requested refunds: 0028 keeps the
    // write-once checkpoint, and fin_refunds carries no insert trigger that the
    // migrator bypasses.
    const staged = await migrator.query("select count(*)::int as n from fin_refunds where id = $1", [r]);
    expect(staged.rows[0]?.n).toBe(1);

    // Fail-closed is now RLS-based, not ACL-absence-based. Asserting the RLS
    // layer explicitly is what distinguishes "locked by RLS" from "locked by
    // accident because RLS happens to be off".
    const rls = await migrator.query(
      "select relrowsecurity, relforcerowsecurity from pg_class where relname = 'fin_refunds'",
    );
    expect(rls.rows[0]?.relrowsecurity).toBe(true);
    expect(rls.rows[0]?.relforcerowsecurity).toBe(true);

    // The §B.1 policy set, one policy per command. fin_refunds is NOT in the
    // §B.2.10 DELETE-omitted set, so DELETE is present (P-only).
    const pol = await migrator.query(
      `select cmd, count(*)::int as n from pg_policies
        where schemaname = 'public' and tablename = 'fin_refunds'
        group by 1 order by 1`,
    );
    expect(pol.rows.map((x) => `${String(x.cmd)}=${Number(x.n)}`)).toEqual([
      "DELETE=1",
      "INSERT=1",
      "SELECT=1",
      "UPDATE=1",
    ]);
  });

});
