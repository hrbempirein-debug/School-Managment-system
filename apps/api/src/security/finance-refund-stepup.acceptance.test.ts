import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { randomUUID, createHmac } from 'node:crypto';
import { Writable } from 'node:stream';
import { sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { getEnv } from '@sms/config';
import { createDb, withGuc, type Db, type Tx } from '@sms/db';
import type { StorageProvider } from '@sms/storage';
import { hashSessionToken, writeSession, type RedisSession } from '@sms/auth';
import { createRedis } from '@sms/redis';
import { buildApp } from '../app.js';

/**
 * Refund step-up (MFA) enforcement at the API/service boundary — the Item 12
 * close-out for Phase 7 / 0028.
 *
 * F11 (`postRefundApproval`) and F12 (`postRefundProcess`) PERFORM
 * `app_consume_step_up(..., NULL)` and DISCARD the boolean
 * (finance-refund-state-machine.test.ts T6/T7). The enforcement point is
 * therefore this layer: resolve the caller's session, verify the caller's OWN
 * code with the REAL `app_consume_step_up`, and invoke the handler ONLY on TRUE.
 *
 * Note on "the code": F8 does NOT compare the challenge's stored digest with the
 * submitted value. It calls `app_verify_mfa_code(user, code, challenge.created_at)`,
 * i.e. the correct code is the caller's live TOTP value at the challenge's step
 * (±1 window). The 6-digit nonce F9 returns is therefore NOT what a caller
 * submits; this suite submits `totpNow()`.
 *
 * This suite drives the real Fastify app against the real database + Redis and
 * proves the twelve required behaviours:
 *   1. correct code   -> TRUE  -> the handler runs
 *   2. wrong code     -> FALSE -> the handler is NOT called; the decrement is durable
 *   3. null/missing code -> rejected before any DB call
 *   4. no challenge   -> rejected
 *   5. expired        -> rejected
 *   6. exhausted      -> rejected
 *   7. session/tenant mismatch -> rejected
 *   8. missing route permission remains rejected
 *   9. the raw code is never logged or persisted in plaintext
 *  10. a successful decision is idempotent (one ledger group, one outbox event)
 *  11. a failed step-up does not mutate the refund
 *  12. a failed step-up writes no ledger / outbox side effects
 *
 * Opt-in: RUN_RUNTIME_SECURITY_TESTS=1 (requires PostgreSQL through 0028).
 */
const enabled = process.env.RUN_RUNTIME_SECURITY_TESTS === '1';
const describeDb = enabled ? describe : describe.skip;

const TOTP_SEED = '12345678901234567890';

/** RFC 6238 HMAC-SHA1, 30s step, 6 digits — the JS mirror of app_totp_verify. */
function totpNow(atMs = Date.now()): string {
  const counter = Math.floor(atMs / 1000 / 30);
  const msg = Buffer.alloc(8);
  msg.writeBigInt64BE(BigInt(counter));
  const hs = createHmac('sha1', Buffer.from(TOTP_SEED, 'utf8')).update(msg).digest();
  const offset = hs[19]! & 0x0f;
  const bin =
    ((hs[offset]! & 0x7f) << 24) |
    (hs[offset + 1]! << 16) |
    (hs[offset + 2]! << 8) |
    hs[offset + 3]!;
  return String(bin % 1_000_000).padStart(6, '0');
}

const stubStorage = ((): StorageProvider => ({}) as StorageProvider)();

interface Session {
  token: string;
  csrf: string;
  cookie: string;
  sessionId: string;
}

interface InjectResult {
  statusCode: number;
  body: string;
  json(): Record<string, any>;
}

interface Fixture {
  refundId: string;
  paymentId: string;
  allocId: string;
}

describeDb('refund step-up enforcement (API + DB + Redis)', () => {
  let migratorDb: Db;
  let appDb: Db;
  let redis: Redis;
  let endMigrator: () => Promise<void>;
  let endApp: () => Promise<void>;
  let endRedis: () => Promise<void>;
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;
  const logLines: string[] = [];

  const slug = randomUUID().slice(0, 8);
  let n = 0;
  const uniq = (): string => `${slug}-${(n += 1)}`;

  const uid: Record<string, string> = {};
  let tenantId = '';
  let tenantBId = '';
  let campusId = '';
  let yearId = '';
  let levelId = '';
  let classId = '';
  let sectionId = '';
  let studentId = '';
  let enrollmentId = '';
  let guardianId = '';
  let invoiceId = '';
  let accountantRole = '';
  let clerkRole = '';
  let approverSession: Session;
  let approverSession2: Session;
  let processorSession: Session;
  let clerkSession: Session;
  let outsiderSession: Session;
  let fx: Fixture;

  const rows = async (db: Db, query: ReturnType<typeof sql>): Promise<Record<string, unknown>[]> =>
    (await db.execute(query)).rows as Record<string, unknown>[];
  const one = async (db: Db, query: ReturnType<typeof sql>): Promise<Record<string, unknown>> => {
    const r = (await db.execute(query)).rows as Record<string, unknown>[];
    if (!r[0]) throw new Error('expected at least one row');
    return r[0];
  };
  const num = (v: unknown): number => Number(String(v));

  function captureSink(into: string[]): Writable {
    return new Writable({
      write(chunk: Buffer, _enc, callback) {
        into.push(chunk.toString());
        callback();
      },
    });
  }

  const envelope = (res: InjectResult): { code?: string; requiredPermission?: string | null } =>
    (res.json() as { error?: { code?: string; requiredPermission?: string | null } }).error ?? {};

  async function seedSession(userId: string, activeTenantId: string): Promise<Session> {
    const token = `tok-${randomUUID()}`;
    const sessionId = randomUUID();
    const csrf = `csrf-${randomUUID()}`;
    const session: RedisSession = {
      userId,
      activeTenantId,
      csrfToken: csrf,
      createdAt: Date.now(),
      expiresAt: Date.now() + 3_600_000,
    };
    await writeSession(redis, token, session);
    await rows(
      migratorDb,
      sql`insert into auth_sessions (id, user_id, token_hash, expires_at)
          values (${sessionId}, ${userId}, ${hashSessionToken(token)}, now() + interval '1 hour')`,
    );
    return { token, csrf, cookie: `${getEnv().SESSION_COOKIE_NAME}=${token}`, sessionId };
  }

  const injectAs = (
    s: Session,
    method: 'POST' | 'GET',
    url: string,
    opts: { payload?: unknown; headers?: Record<string, string> } = {},
  ): Promise<InjectResult> =>
    app!.inject({
      method,
      url,
      headers: { cookie: s.cookie, 'x-csrf-token': s.csrf, ...opts.headers },
      payload: opts.payload as never,
    }) as unknown as Promise<InjectResult>;

  /** Runs `fn` on the APP connection under `userId`'s own signed tenant ticket. */
  const asUser = <T>(userId: string, tenant: string, fn: (tx: Tx) => Promise<T>): Promise<T> =>
    withGuc(appDb, { userId, tenantId: tenant }, fn);

  beforeAll(async () => {
    const env = getEnv();
    const mig = createDb({ url: env.DATABASE_URL_MIGRATOR });
    const appC = createDb({ url: env.DATABASE_URL_APP });
    migratorDb = mig.db;
    appDb = appC.db;
    endMigrator = () => mig.pool.end();
    endApp = () => appC.pool.end();
    redis = createRedis();
    endRedis = () => redis.quit().then(() => undefined);
    await redis.connect();

    for (const k of ['requester', 'approver', 'processor', 'clerk', 'outsider']) {
      uid[k] = randomUUID();
    }
    tenantId = randomUUID();
    tenantBId = randomUUID();
    campusId = randomUUID();
    yearId = randomUUID();
    levelId = randomUUID();
    classId = randomUUID();
    sectionId = randomUUID();
    studentId = randomUUID();
    enrollmentId = randomUUID();
    guardianId = randomUUID();
    invoiceId = randomUUID();
    accountantRole = randomUUID();
    clerkRole = randomUUID();

    await rows(
      migratorDb,
      sql`insert into tenants (id, slug, name) values
        (${tenantId}, ${`rsu-a-${slug}`}, 'RSU A'),
        (${tenantBId}, ${`rsu-b-${slug}`}, 'RSU B')`,
    );
    await rows(
      migratorDb,
      sql`insert into users (id, email) values
        (${uid.requester!}, ${`rsu-req-${slug}@example.com`}),
        (${uid.approver!}, ${`rsu-app-${slug}@example.com`}),
        (${uid.processor!}, ${`rsu-pro-${slug}@example.com`}),
        (${uid.clerk!}, ${`rsu-clk-${slug}@example.com`}),
        (${uid.outsider!}, ${`rsu-out-${slug}@example.com`})`,
    );

    await rows(
      migratorDb,
      sql`insert into campuses (id, tenant_id, code, name, status)
          values (${campusId}, ${tenantId}, ${`rsu-${slug}`}, 'Campus', 'active')`,
    );
    await rows(
      migratorDb,
      sql`insert into academic_years (id, tenant_id, code, name, starts_on, ends_on, status)
          values (${yearId}, ${tenantId}, ${`rsuy-${slug}`}, 'AY', '2026-01-01', '2026-12-31', 'active')`,
    );
    await rows(
      migratorDb,
      sql`insert into grade_levels (id, tenant_id, code, name, status)
          values (${levelId}, ${tenantId}, ${`rsul-${slug}`}, 'Grade', 'active')`,
    );
    await rows(
      migratorDb,
      sql`insert into acd_classes (id, tenant_id, campus_id, academic_year_id, grade_level_id, code, name, status)
          values (${classId}, ${tenantId}, ${campusId}, ${yearId}, ${levelId}, ${`rsuc-${slug}`}, 'Class', 'active')`,
    );
    await rows(
      migratorDb,
      sql`insert into sections (id, tenant_id, class_id, campus_id, academic_year_id, code, status)
          values (${sectionId}, ${tenantId}, ${classId}, ${campusId}, ${yearId}, ${`rsus-${slug}`}, 'active')`,
    );
    await rows(
      migratorDb,
      sql`insert into students (id, tenant_id, student_no, first_name, last_name, status, primary_campus_id)
          values (${studentId}, ${tenantId}, ${`rsust-${slug}`}, 'Stu', 'Rsu', 'active', ${campusId})`,
    );
    await rows(
      migratorDb,
      sql`insert into enrollments (id, tenant_id, student_id, academic_year_id, class_id, section_id, roll_no, status)
          values (${enrollmentId}, ${tenantId}, ${studentId}, ${yearId}, ${classId}, ${sectionId}, '01', 'active')`,
    );
    await rows(
      migratorDb,
      sql`insert into guardians (id, tenant_id, first_name, last_name)
          values (${guardianId}, ${tenantId}, 'G', 'Rsu')`,
    );
    await rows(
      migratorDb,
      sql`insert into student_guardians (tenant_id, student_id, guardian_id, relation, is_primary)
          values (${tenantId}, ${studentId}, ${guardianId}, 'father', true)`,
    );
    await rows(
      migratorDb,
      sql`insert into fin_document_counters (tenant_id, academic_year_id, kind)
          values (${tenantId}, ${yearId}, 'invoice')`,
    );
    await rows(migratorDb, sql`select app_finance_seeds_ledger_accounts(${tenantId})`);
    await rows(
      migratorDb,
      sql`insert into fin_invoices
            (id, tenant_id, student_id, academic_year_id, enrollment_id, status, due_date, subtotal, total, balance, created_by)
          values (${invoiceId}, ${tenantId}, ${studentId}, ${yearId}, ${enrollmentId},
                  'issued', '2026-03-01', 500, 500, 500, ${uid.requester!})`,
    );

    // SYSTEM 'accountant' role (finance_staff) with the four refund permissions.
    // A custom (is_system=false) role must NEVER hold fees.* (finance-rbac §20.5).
    await rows(
      migratorDb,
      sql`insert into roles (id, tenant_id, code, name, description, scope, is_system)
          values (${accountantRole}, ${tenantId}, 'accountant', 'Accountant', 'system accountant', 'tenant', true)`,
    );
    await rows(
      migratorDb,
      sql`insert into role_permissions (role_id, permission) values
        (${accountantRole}, 'fees.refunds.request'),
        (${accountantRole}, 'fees.refunds.read'),
        (${accountantRole}, 'fees.refunds.approve'),
        (${accountantRole}, 'fees.refunds.process')`,
    );
    // A non-finance role: passes tenant context, fails requirePermission (403).
    await rows(
      migratorDb,
      sql`insert into roles (id, tenant_id, code, name, description, scope, is_system)
          values (${clerkRole}, ${tenantId}, 'clerk', 'Clerk', 'no finance role', 'tenant', false)`,
    );
    const mApp = randomUUID();
    const mProc = randomUUID();
    const mClk = randomUUID();
    await rows(
      migratorDb,
      sql`insert into memberships (id, tenant_id, user_id, status) values
        (${mApp}, ${tenantId}, ${uid.approver!}, 'active'),
        (${mProc}, ${tenantId}, ${uid.processor!}, 'active'),
        (${mClk}, ${tenantId}, ${uid.clerk!}, 'active')`,
    );
    await rows(
      migratorDb,
      sql`insert into membership_roles (membership_id, role_id) values
        (${mApp}, ${accountantRole}),
        (${mProc}, ${accountantRole}),
        (${mClk}, ${clerkRole})`,
    );

    // Tenant B: an outsider who DOES hold the refund permission, so the refusal
    // must come from tenant isolation (unknown refund -> 404), not permission.
    const accountantB = randomUUID();
    const mOut = randomUUID();
    await rows(
      migratorDb,
      sql`insert into roles (id, tenant_id, code, name, description, scope, is_system)
          values (${accountantB}, ${tenantBId}, 'accountant', 'Accountant', 'system accountant', 'tenant', true)`,
    );
    await rows(
      migratorDb,
      sql`insert into role_permissions (role_id, permission) values
        (${accountantB}, 'fees.refunds.approve')`,
    );
    await rows(
      migratorDb,
      sql`insert into memberships (id, tenant_id, user_id, status)
          values (${mOut}, ${tenantBId}, ${uid.outsider!}, 'active')`,
    );
    await rows(
      migratorDb,
      sql`insert into membership_roles (membership_id, role_id)
          values (${mOut}, ${accountantB})`,
    );

    // Sessions (Redis + a matching auth_sessions row so the route can resolve the
    // session id from the token_hash). The approver gets two, for the
    // session-binding case.
    approverSession = await seedSession(uid.approver!, tenantId);
    approverSession2 = await seedSession(uid.approver!, tenantId);
    processorSession = await seedSession(uid.processor!, tenantId);
    clerkSession = await seedSession(uid.clerk!, tenantId);
    outsiderSession = await seedSession(uid.outsider!, tenantBId);

    // Enroll a confirmed TOTP factor for the approver and the processor. The
    // ciphertext is produced with the CORRECT pgcrypto primitive
    // (pgp_sym_encrypt_bytea / app_ctx_secret, the exact inverse of F7's
    // app_mfa_decrypt) because 0028's app_mfa_encrypt wrapper calls the
    // nonexistent pgp_sym_encrypt(bytea, …) overload. That wrapper is not this
    // task's to fix (migrations are frozen), so we seed the envelope directly and
    // insert through the APP connection under the owning user's own ticket (the
    // table is FORCE-RLS self-only with no privileged branch).
    for (const userId of [uid.approver!, uid.processor!]) {
      const sealed = await one(
        migratorDb,
        sql`select pgp_sym_encrypt_bytea(convert_to(${TOTP_SEED}, 'UTF8'), app_ctx_secret()) as ct`,
      );
      await asUser(userId, tenantId, (tx) =>
        tx.execute(sql`
          insert into auth_mfa_factors (user_id, factor_type, label, secret_ciphertext, confirmed_at)
          values (${userId}, 'totp', 'authenticator', ${sealed.ct as Buffer}, now())`),
      );
    }

    app = await buildApp({
      deps: { db: appDb, redis, storage: stubStorage },
      logger: { level: 'info', stream: captureSink(logLines) },
    });
  });

  afterAll(async () => {
    try {
      if (app) await app.close();
    } catch {
      /* ignore */
    }
    const t = `'${tenantId}'`;
    const tb = `'${tenantBId}'`;
    const userIds = Object.values(uid).map((v) => `'${v}'`).join(', ');
    const cleanup = [
      `truncate fin_ledger_entry_groups, fin_ledger_entries, fin_ledger_accounts`,
      `alter table fin_payment_allocations disable trigger trg_fin_allocations_delete_guard`,
      `delete from fin_payment_allocations where tenant_id in (${t}, ${tb})`,
      `alter table fin_payment_allocations enable trigger trg_fin_allocations_delete_guard`,
      `delete from outbox_events where tenant_id in (${t}, ${tb})`,
      `delete from fin_refunds where tenant_id in (${t}, ${tb})`,
      `delete from fin_payments where tenant_id in (${t}, ${tb})`,
      `delete from fin_invoices where tenant_id in (${t}, ${tb})`,
      `delete from fin_document_counters where tenant_id in (${t}, ${tb})`,
      `delete from membership_roles where membership_id in
         (select id from memberships where tenant_id in (${t}, ${tb}))`,
      `delete from memberships where tenant_id in (${t}, ${tb})`,
      `delete from role_permissions where role_id in (select id from roles where tenant_id in (${t}, ${tb}))`,
      `delete from roles where tenant_id in (${t}, ${tb})`,
      `delete from auth_sessions where user_id in (${userIds})`,
      `delete from student_guardians where tenant_id in (${t})`,
      `delete from enrollments where tenant_id in (${t})`,
      `delete from students where tenant_id in (${t})`,
      `delete from guardians where tenant_id in (${t})`,
      `delete from sections where tenant_id in (${t})`,
      `delete from acd_classes where tenant_id in (${t})`,
      `delete from grade_levels where tenant_id in (${t})`,
      `delete from campuses where tenant_id in (${t})`,
      `delete from academic_years where tenant_id in (${t})`,
      `delete from users where id in (${userIds})`,
      `delete from tenants where id in (${t}, ${tb})`,
    ];
    for (const statement of cleanup) {
      await migratorDb.execute(sql.raw(statement)).catch(() => {});
    }
    await endApp().catch(() => undefined);
    await endMigrator().catch(() => undefined);
    await endRedis().catch(() => undefined);
  });

  beforeEach(async () => {
    const paymentId = randomUUID();
    const allocId = randomUUID();
    const refundId = randomUUID();
    const proposed = `[{"allocation_id": "${allocId}", "amount": 400}]`;
    await rows(
      migratorDb,
      sql`insert into fin_payments
            (id, tenant_id, payment_no, amount, method, payer_guardian_id, received_at, idempotency_key)
          values (${paymentId}, ${tenantId}, ${`P-${uniq()}`}, 1000, 'cash', ${guardianId}, now(), ${`ik-${uniq()}`})`,
    );
    await rows(
      migratorDb,
      sql`insert into fin_payment_allocations
            (id, tenant_id, payment_id, invoice_id, amount, effect, reversal_of_allocation_id, refund_id, reason, created_by)
          values (${allocId}, ${tenantId}, ${paymentId}, ${invoiceId}, 500, 'apply', null, null, 'alloc', ${uid.requester!})`,
    );
    await rows(
      migratorDb,
      sql`insert into fin_refunds
            (id, tenant_id, refund_no, payment_id, amount, status, reason, proposed_allocations, requested_by, idempotency_key)
          values (${refundId}, ${tenantId}, ${`R-${uniq()}`}, ${paymentId}, 400,
                  'requested', 'parent appeal', ${proposed}::jsonb, ${uid.requester!}, ${`ikr-${uniq()}`})`,
    );
    fx = { refundId, paymentId, allocId };
  });

  afterEach(async () => {
    if (!fx) return;
    const t = `'${tenantId}'`;
    const steps = [
      `truncate fin_ledger_entry_groups, fin_ledger_entries`,
      `alter table fin_payment_allocations disable trigger trg_fin_allocations_delete_guard`,
      `delete from fin_payment_allocations where tenant_id in (${t}) and payment_id = '${fx.paymentId}'`,
      `alter table fin_payment_allocations enable trigger trg_fin_allocations_delete_guard`,
      `delete from outbox_events where tenant_id in (${t}) and aggregate_id = '${fx.refundId}'`,
      `delete from fin_refunds where tenant_id in (${t}) and id = '${fx.refundId}'`,
      `delete from fin_payments where tenant_id in (${t}) and id = '${fx.paymentId}'`,
    ];
    for (const statement of steps) {
      await migratorDb.execute(sql.raw(statement)).catch(() => {});
    }
  });

  // ---------------------------------------------------------------- helpers

  const refundState = async (): Promise<Record<string, unknown>> =>
    one(
      migratorDb,
      sql`select status, decided_by, processed_by, applied_allocations
            from fin_refunds where id = ${fx.refundId}`,
    );

  const ledgerLegs = async (event: string, srcId: string): Promise<number> =>
    num(
      (await one(
        migratorDb,
        sql`select count(*)::int n
              from fin_ledger_entry_groups g
              join fin_ledger_entries e
                on e.tenant_id = g.tenant_id and e.entry_group_id = g.id
             where g.tenant_id = ${tenantId}
               and g.event_type = ${event} and g.source_id = ${srcId}`,
      )).n,
    );

  const outboxFor = async (event: string, srcId: string): Promise<number> =>
    num(
      (await one(
        migratorDb,
        sql`select count(*)::int n from outbox_events
             where tenant_id = ${tenantId} and event_type = ${event} and aggregate_id = ${srcId}`,
      )).n,
    );

  const mint = (session: Session): Promise<InjectResult> =>
    injectAs(session, 'POST', `/api/v1/finance/refunds/${fx.refundId}/step-up`, { payload: {} });

  const approve = (session: Session, code: string): Promise<InjectResult> =>
    injectAs(session, 'POST', `/api/v1/finance/refunds/${fx.refundId}/approve`, { payload: { code } });

  /** Live challenge count for a session/refund, read under the owner's ticket. */
  const liveChallenges = async (userId: string, sessionId: string): Promise<number> => {
    let count = 0;
    await asUser(userId, tenantId, async (tx) => {
      const r = await tx.execute(
        sql`select count(*)::int n from auth_step_up_challenges
             where tenant_id = ${tenantId} and session_id = ${sessionId}
               and resource_id = ${fx.refundId} and consumed_at is null`,
      );
      count = Number((r.rows[0] as Record<string, unknown>).n);
    });
    return count;
  };

  /** attempts_left on the newest live approve challenge for a session/refund. */
  const attemptsLeft = async (userId: string, sessionId: string): Promise<number | null> => {
    let value: number | null = null;
    await asUser(userId, tenantId, async (tx) => {
      const r = await tx.execute(
        sql`select attempts_left from auth_step_up_challenges
             where tenant_id = ${tenantId} and session_id = ${sessionId}
               and resource_id = ${fx.refundId} and action = 'refund.approve' and consumed_at is null
             order by created_at desc limit 1`,
      );
      const row = r.rows[0] as Record<string, unknown> | undefined;
      value = row ? Number(row.attempts_left) : null;
    });
    return value;
  };

  /**
   * Insert a challenge directly (used to manufacture expired / exhausted states,
   * which the immutability trigger makes impossible to reach by UPDATE).
   */
  const insertChallenge = async (
    userId: string,
    sessionId: string,
    opts: { attemptsLeft: number; createdAtOffsetSec: number; expiresAtOffsetSec: number },
  ): Promise<void> => {
    const createdAt = new Date(Date.now() + opts.createdAtOffsetSec * 1000).toISOString();
    const expiresAt = new Date(Date.now() + opts.expiresAtOffsetSec * 1000).toISOString();
    await asUser(userId, tenantId, (tx) =>
      tx.execute(sql`
        insert into auth_step_up_challenges
          (tenant_id, user_id, session_id, action, resource_type, resource_id,
           resource_amount, code_digest, attempts_left, created_at, expires_at)
        values (${tenantId}, ${userId}, ${sessionId}, 'refund.approve', 'fin_refunds', ${fx.refundId},
                400, app_secret_digest(${totpNow()}), ${opts.attemptsLeft},
                ${createdAt}::timestamptz, ${expiresAt}::timestamptz)`),
    );
  };

  const wrongCode = (): string => {
    const real = totpNow();
    return real === '000000' ? '000001' : '000000';
  };

  /** A code is "present" only as a delimited token, never as a hex/digit run. */
  const hasToken = (haystack: string, code: string): boolean =>
    new RegExp(`(?<![0-9a-fA-F])${code}(?![0-9a-fA-F])`).test(haystack);

  // ---------------------------------------------------------------- cases

  it('1. a correct step-up code verifies TRUE and the approval handler runs', async () => {
    const m = await mint(approverSession);
    expect(m.statusCode).toBe(200);
    expect(m.json().action).toBe('refund.approve');

    const res = await approve(approverSession, totpNow());
    expect(res.statusCode).toBe(200);
    expect(res.json().refund.status).toBe('approved');

    const s = await refundState();
    expect(String(s.status)).toBe('approved');
    expect(String(s.decided_by)).toBe(uid.approver);
    expect((s.applied_allocations as unknown[]).length).toBe(1);
    expect(await ledgerLegs('refund.approved', fx.refundId)).toBe(2);
    expect(await outboxFor('refund.approved', fx.refundId)).toBe(1);
  });

  it('2. a wrong code verifies FALSE, the handler is not called, and the decrement is durable', async () => {
    await mint(approverSession);
    const res = await approve(approverSession, wrongCode());
    expect(res.statusCode).toBe(401);
    expect(envelope(res).code).toBe('step_up_invalid');
    expect(await attemptsLeft(uid.approver!, approverSession.sessionId)).toBe(2);
  });

  it('3. a missing/null code is rejected before any DB call', async () => {
    const missing = await injectAs(
      approverSession,
      'POST',
      `/api/v1/finance/refunds/${fx.refundId}/approve`,
      { payload: {} },
    );
    expect(missing.statusCode).toBe(400);
    expect(envelope(missing).code).toBe('validation_error');

    const nul = await injectAs(
      approverSession,
      'POST',
      `/api/v1/finance/refunds/${fx.refundId}/approve`,
      { payload: { code: null } },
    );
    expect(nul.statusCode).toBe(400);
    expect(envelope(nul).code).toBe('validation_error');

    expect(String((await refundState()).status)).toBe('requested');
    expect(await liveChallenges(uid.approver!, approverSession.sessionId)).toBe(0);
  });

  it('4. a correct code with no live challenge is rejected', async () => {
    const res = await approve(approverSession, totpNow());
    expect(res.statusCode).toBe(428);
    expect(envelope(res).code).toBe('step_up_required');
    expect(String((await refundState()).status)).toBe('requested');
  });

  it('5. an expired challenge is rejected', async () => {
    await insertChallenge(uid.approver!, approverSession.sessionId, {
      attemptsLeft: 3,
      createdAtOffsetSec: -600,
      expiresAtOffsetSec: -300,
    });
    const res = await approve(approverSession, totpNow());
    expect(res.statusCode).toBe(401);
    expect(envelope(res).code).toBe('step_up_expired');
    expect(String((await refundState()).status)).toBe('requested');
  });

  it('6. an exhausted challenge is rejected', async () => {
    await insertChallenge(uid.approver!, approverSession.sessionId, {
      attemptsLeft: 0,
      createdAtOffsetSec: -60,
      expiresAtOffsetSec: 300,
    });
    const res = await approve(approverSession, totpNow());
    expect(res.statusCode).toBe(401);
    expect(envelope(res).code).toBe('step_up_locked');
    expect(String((await refundState()).status)).toBe('requested');
  });

  it('7. a session/tenant mismatch is rejected (428 / 404)', async () => {
    // (a) challenge bound to session A, verified with session B for the same user.
    await mint(approverSession);
    const mismatch = await approve(approverSession2, totpNow());
    expect(mismatch.statusCode).toBe(428);
    expect(envelope(mismatch).code).toBe('step_up_required');
    expect(String((await refundState()).status)).toBe('requested');
    expect(await liveChallenges(uid.approver!, approverSession.sessionId)).toBe(1);

    // (b) a tenant-B accountant with the permission cannot see a tenant-A refund.
    const foreign = await approve(outsiderSession, totpNow());
    expect(foreign.statusCode).toBe(404);
    expect(envelope(foreign).code).toBe('refund_not_found');
    expect(String((await refundState()).status)).toBe('requested');
  });

  it('8. an actor without the route permission is still refused', async () => {
    const res = await approve(clerkSession, totpNow());
    expect(res.statusCode).toBe(403);
    expect(envelope(res).code).toBe('forbidden');
    expect(envelope(res).requiredPermission).toBe('fees.refunds.approve');
    expect(String((await refundState()).status)).toBe('requested');
  });

  it('9. the raw step-up code never appears in logs or persistent sinks', async () => {
    const code = totpNow();
    const wrong = wrongCode();

    await mint(approverSession);
    const failed = await approve(approverSession, wrong);
    expect(failed.statusCode).toBe(401);

    // F9 supersedes the live challenge, so a re-mint then a correct code succeeds.
    await mint(approverSession);
    const ok = await approve(approverSession, code);
    expect(ok.statusCode).toBe(200);

    const logs = logLines.join('');
    expect(hasToken(logs, wrong), 'wrong code leaked to logs').toBe(false);
    expect(hasToken(logs, code), 'real code leaked to logs').toBe(false);

    for (const c of [wrong, code]) {
      const audit = await one(
        migratorDb,
        sql`select count(*)::int n from audit_logs
             where tenant_id = ${tenantId} and new_value::text like ${'%' + c + '%'}`,
      );
      expect(num(audit.n), `code ${c} leaked to audit_logs`).toBe(0);
      const outbox = await one(
        migratorDb,
        sql`select count(*)::int n from outbox_events
             where tenant_id = ${tenantId} and payload::text like ${'%' + c + '%'}`,
      );
      expect(num(outbox.n), `code ${c} leaked to outbox_events`).toBe(0);
    }
  });

  it('10. a successful decision is idempotent (one ledger group, one outbox event)', async () => {
    await mint(approverSession);
    const first = await approve(approverSession, totpNow());
    expect(first.statusCode).toBe(200);
    expect(first.json().refund.status).toBe('approved');

    // The replay needs no step-up: the refund is already approved.
    const replay = await approve(approverSession, totpNow());
    expect(replay.statusCode).toBe(200);
    expect(replay.json().refund.status).toBe('approved');

    expect(await ledgerLegs('refund.approved', fx.refundId)).toBe(2);
    expect(await outboxFor('refund.approved', fx.refundId)).toBe(1);
    const groups = await one(
      migratorDb,
      sql`select count(*)::int n from fin_ledger_entry_groups
           where tenant_id = ${tenantId} and event_type = 'refund.approved' and source_id = ${fx.refundId}`,
    );
    expect(num(groups.n)).toBe(1);
  });

  it('11. a failed step-up does not mutate the refund', async () => {
    await mint(approverSession);
    const res = await approve(approverSession, wrongCode());
    expect(res.statusCode).toBe(401);

    const s = await refundState();
    expect(String(s.status)).toBe('requested');
    expect(s.decided_by).toBeNull();
    expect(s.processed_by).toBeNull();
    expect(s.applied_allocations).toBeNull();
  });

  it('12. a failed step-up writes no ledger or outbox side effects', async () => {
    await mint(approverSession);
    const res = await approve(approverSession, wrongCode());
    expect(res.statusCode).toBe(401);

    expect(await ledgerLegs('refund.approved', fx.refundId)).toBe(0);
    expect(await outboxFor('refund.approved', fx.refundId)).toBe(0);
  });

  // A process-path smoke case: the enforcement is identical for refund.process.
  it('13. the process command is gated by the same step-up, bound to its own action', async () => {
    await mint(approverSession);
    expect((await approve(approverSession, totpNow())).statusCode).toBe(200);

    const m = await mint(processorSession);
    expect(m.statusCode).toBe(200);
    expect(m.json().action).toBe('refund.process');

    // A process-action challenge cannot satisfy approve, and vice versa; here we
    // simply prove the process handler runs on its own correct code.
    const res = await injectAs(
      processorSession,
      'POST',
      `/api/v1/finance/refunds/${fx.refundId}/process`,
      { payload: { code: totpNow(), disbursementReference: 'CHK-0001' } },
    );
    expect(res.statusCode).toBe(200);
    expect(res.json().refund.status).toBe('processed');
    expect(await ledgerLegs('refund.processed', fx.refundId)).toBe(2);
    expect(await outboxFor('refund.processed', fx.refundId)).toBe(1);
  });
});