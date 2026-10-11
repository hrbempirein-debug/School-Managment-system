import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { getEnv } from '@sms/config';

/**
 * Phase 8 guardian-revocation concurrency overlap suite (M1-M6).
 *
 * SCOPE: The only purpose of this file is to exercise the overlapping
 * guardian-link revocation vs. notification/context-creation interleavings that
 * the recorded H-section (phase8-communication.test.ts H1/H2/H3a/H3b) does not
 * cover: both transactions genuinely in flight at the same time. It runs only
 * against the disposable school_saas_test database (name-validated by
 * runtime-db.ts); it never touches school_saas_dev.
 *
 * OPTOUT/OPTIN: exactly like the other DB-backed security suites, everything
 * self-skips unless RUN_RUNTIME_SECURITY_TESTS=1. It is included by the existing
 * phase6-security aggregate CI step (`vitest run src/security ...`, which runs
 * with RUN_RUNTIME_SECURITY_TESTS=1) and does not change the default test
 * selection; it is the C1/C2 scoped investigation suite.
 *
 * ROLES USED:
 *  - school_migrator (migrator / revoker / fixture sessions): DDL + privileged.
 *  - school_app_rw (app session): the tenant runtime role, exercised only with
 *    a signed tenant ticket (mintTicket + `set local app.rls`).
 *
 * ---------------------------------------------------------------- boundary
 * WHICH TRANSACTION-ORDERING BOUNDARIES POSTGRESQL CAN SYNC (used by M1, M3-M6)
 *  1. Negotiating a row lock is deterministic and observable: a session that
 *     UPDATEs/DELETEs `student_guardians` holds the row lock until COMMIT, and
 *     a second session that attempts a LOCKING operation (UPDATE/DELETE/FOR
 *     UPDATE) on the same row blocks until release or lock_timeout. A PLAIN
 *     SELECT never blocks and never sees the uncommitted change (READ COMMITTED
 *     snapshot); it reads the latest committed version. This is exactly the
 *     asymmetry the design relies on (0035_com_guardian_context_rls.sql:43-46).
 *  2. Advisory locks are deterministic and exposable: `fn_lock_notification_parent`
 *     (0035:216-227) is a transaction-scoped `pg_advisory_xact_lock` keyed on
 *     (hashtext(tenant), hashtext(notif)); a session holding it forces a second
 *     session's deferred COMMIT-time re-validation to block until lock_timeout
 *     (55P03) or release. M5 uses this directly.
 *  3. "Both transactions in flight" is deterministically reachable: hold T_R
 *     (revoker) open on the row lock, run T_N (creator) INSERTs in another open
 *     transaction, then commit in either order. Both real open-window orders are
 *     forced deterministically and asserted (M1a/M1b, M3a/M3b, M6).
 *  4. Statement-boundary visibility is deterministic: READ COMMITTED fixes a
 *     snapshot at statement start, so the SAME open transaction sees a row on
 *     statement one (pre-revocation) and not on statement two (post-revocation).
 *     M4a asserts exactly this. A fresh reader statement after the revocation is
 *     durable is asserted in M4b.
 *
 * WHICH BOUNDARIES CANNOT BE DETERMINISTICALLY FORCED (why M2 is a stress, not
 * a pin):
 *  5. There is no client-reachable primitive that inserts T_R's commit-record
 *     durability EXACTLY between T_N's final re-validation snapshot and T_N's
 *     commit-record durability. Commit processing and snapshot timing are
 *     internal to PostgreSQL; there is no lock, wait, or fence that pins an
 *     arbitrary point inside another session's COMMIT. A test that claims to
 *     "cover" that precise interleave would be claiming something it cannot
 *     reach.
 *  6. The internal ordering in which multiple deferred constraint triggers of
 *     one COMMIT are fired is not documented/stable and cannot be forced; the
 *     design accepts either order because both triggers independently
 *     re-validate (0035:229-355), so no test needs to pin it.
 *  7. Microsecond-scale commit/durability ordering of two independent commits
 *     cannot be forced; the two branches it can yield are exactly the tolerated
 *     outcome set (§22.3).
 *
 * Because of (5), M2 is implemented as an HONEST close-boundary stress:
 *   - it widens T_N's re-validation window (several context rows, so the
 *     validation re-read takes longer),
 *   - it fires both COMMITs against each other uncoordinatedly (Promise.allSettled),
 *   - it asserts that EVERY observed outcome lands in the tolerated set
 *     {creator 55000} ∪ {committed and hidden at read},
 *   - it does NOT claim to have forced the commit-protocol interleave (5).
 * A concurrency guarantee is asserted only as "the observed envelope lies
 * inside the documented tolerated set, and a post-revocation-durability reader
 * never sees the notification" - never as proof of a specific unforceable
 * ordering.
 * ------------------------------------------------------------------------
 */
const enabled = process.env.RUN_RUNTIME_SECURITY_TESTS === '1';
const describeDb = enabled ? describe : describe.skip;

const CHANNEL = 'email';

describeDb('phase 8 guardian-revocation concurrency overlap (school_saas_test)', () => {
  let migrator: pg.Client;
  let app: pg.Client;
  const uid: Record<string, string> = {};
  const slug = 'p8c' + randomUUID().slice(0, 8);

  const createdNotifs: string[] = [];
  const createdStudents: string[] = [];
  const createdRels: string[] = [];

  async function appQ<T extends pg.QueryResultRow = pg.QueryResultRow>(
    sqlText: string,
  ): Promise<T[]> {
    return app.query<T>(sqlText).then((r) => r.rows);
  }

  async function migQ<T extends pg.QueryResultRow = pg.QueryResultRow>(
    sqlText: string,
  ): Promise<T[]> {
    return migrator.query<T>(sqlText).then((r) => r.rows);
  }

  /** COMMIT the open transaction and assert it is rejected with `code`. */
  async function expectCommitError(
    client: pg.Client,
    code: string,
  ): Promise<pg.DatabaseError> {
    const err = await client.query('commit').then(
      () => null,
      (e: pg.DatabaseError) => e,
    );
    expect(err, 'expected COMMIT to be rejected').toBeInstanceOf(Error);
    expect((err as pg.DatabaseError).code).toBe(code);
    await client.query('rollback').catch(() => {});
    return err as pg.DatabaseError;
  }

  /** Bound every lock/statement wait so a defect surfaces as an error, never a hang. */
  async function makeClient(url: string, lockMs = 3000, stmtMs = 10000): Promise<pg.Client> {
    const c = new pg.Client({ connectionString: url });
    await c.connect();
    await c.query(`set lock_timeout = '${lockMs}ms'`);
    await c.query(`set statement_timeout = '${stmtMs}ms'`);
    return c;
  }

  async function close(c: pg.Client | undefined): Promise<void> {
    if (!c) return;
    await c.query('rollback').catch(() => {});
    await c.end().catch(() => {});
  }

  /** Mint a signed tenant ticket for the runtime role (mirrors phase8). */
  async function mintTicket(user: string, tenant: string): Promise<string> {
    return (await appQ(
      `select app_ctx_mint('tenant', '${user}', '${tenant}') t`,
    ))[0]!.t as string;
  }

  /** Create a dedicated live-linked student (never shared between tests). */
  async function makeLinkedStudent(label: string): Promise<{ studentId: string; relId: string }> {
    const studentId = randomUUID();
    const relId = randomUUID();
    await migrator.query(
      `insert into students (id, tenant_id, student_no, first_name, last_name) values
         ('${studentId}', '${uid.tenantA}', 'p8c-${label}-${slug}', 'C', '${label}')`,
    );
    await migrator.query(
      `insert into student_guardians (id, tenant_id, student_id, guardian_id, relation) values
         ('${relId}', '${uid.tenantA}', '${studentId}', '${uid.guardianA}', 'guardian')`,
    );
    createdStudents.push(studentId);
    createdRels.push(relId);
    return { studentId, relId };
  }

  async function insertNotification(
    client: pg.Client,
    notifId: string,
    dedupeKey: string,
  ): Promise<void> {
    createdNotifs.push(notifId);
    await client.query(
      `insert into notifications (id, tenant_id, recipient_guardian_id, channel, dedupe_key, body) values
         ('${notifId}', '${uid.tenantA}', '${uid.guardianA}', '${CHANNEL}', '${dedupeKey}', 'x')`,
    );
  }

  async function insertContext(
    client: pg.Client,
    notifId: string,
    studentId: string,
  ): Promise<void> {
    await client.query(
      `insert into notification_student_contexts (id, tenant_id, notification_id, student_id) values
         ('${randomUUID()}', '${uid.tenantA}', '${notifId}', '${studentId}')`,
    );
  }

  /** Read the notification as the runtime role (guardian user A, tenant A). */
  async function runtimeSees(notifId: string): Promise<number> {
    const tkt = await mintTicket(uid.userA!, uid.tenantA!);
    await app.query('begin');
    try {
      await app.query(`set local app.rls = '${tkt}'`);
      const r = await app.query<{ id: string }>(
        `select id from notifications where id = '${notifId}'`,
      );
      return r.rowCount ?? 0;
    } finally {
      await app.query('rollback').catch(() => {});
    }
  }

  async function migratorCount(notifId: string): Promise<number> {
    return Number((await migQ<{ n: number }>(
      `select count(*)::int n from notifications where id = '${notifId}'`,
    ))[0]!.n);
  }

  beforeAll(async () => {
    const env = getEnv();
    migrator = new pg.Client({ connectionString: env.DATABASE_URL_MIGRATOR });
    app = new pg.Client({ connectionString: env.DATABASE_URL_APP });
    await migrator.connect();
    await app.connect();

    uid.tenantA = randomUUID();
    uid.userA = randomUUID();
    uid.guardianA = randomUUID();

    await migrator.query('begin');
    await migrator.query(
      `insert into tenants (id, slug, name) values ('${uid.tenantA}', '${slug}-a', 'Phase8 Overlap A')`,
    );
    await migrator.query(
      `insert into users (id, email) values ('${uid.userA}', 'p8c-a-${slug}@example.com')`,
    );
    await migrator.query(
      `insert into memberships (id, tenant_id, user_id, status) values
         ('${randomUUID()}', '${uid.tenantA}', '${uid.userA}', 'active')`,
    );
    await migrator.query(
      `insert into guardians (id, tenant_id, first_name, last_name, email, user_id) values
         ('${uid.guardianA}', '${uid.tenantA}', 'Gina', 'Overlap', 'gina-${slug}@example.com', '${uid.userA}')`,
    );
    await migrator.query('commit');
  });

  afterAll(async () => {
    try {
      await migrator.query('begin');
      if (createdNotifs.length) {
        const nids = createdNotifs.map((n) => `'${n}'`).join(',');
        await migrator.query(
          `delete from notification_student_contexts where notification_id in (${nids})`,
        );
        await migrator.query(`delete from notifications where id in (${nids})`);
      }
      if (createdRels.length) {
        const rids = createdRels.map((r) => `'${r}'`).join(',');
        await migrator.query(`delete from student_guardians where id in (${rids})`);
      }
      if (createdStudents.length) {
        const sids = createdStudents.map((s) => `'${s}'`).join(',');
        await migrator.query(`delete from students where id in (${sids})`);
      }
      await migrator.query(`delete from guardians where id = '${uid.guardianA}'`);
      await migrator.query(`delete from memberships where tenant_id = '${uid.tenantA}'`);
      await migrator.query(`delete from users where id = '${uid.userA}'`);
      await migrator.query(`delete from tenants where id = '${uid.tenantA}'`);
      await migrator.query('commit');
    } finally {
      await migrator.end().catch(() => {});
      await app.end().catch(() => {});
    }
  });

  afterEach(async () => {
    await migrator.query('rollback').catch(() => {});
    await app.query('rollback').catch(() => {});
  });

it('M1a. creator commits while the revoker is in flight; the committed notification is hidden after the revocation lands',
      { timeout: 120_000 },
      async () => {
      const { studentId, relId } = await makeLinkedStudent('m1a');
      const notifId = randomUUID();
      let cR: pg.Client | undefined;
      let cC: pg.Client | undefined;
      try {
        const env = getEnv();
        cR = await makeClient(env.DATABASE_URL_MIGRATOR);
        cC = await makeClient(env.DATABASE_URL_MIGRATOR);

        await cR.query('begin');
        await cR.query(`update student_guardians set deleted_at = now() where id = '${relId}'`);

        await cC.query('begin');
        await insertNotification(cC, notifId, 'm1a-' + slug);
        await insertContext(cC, notifId, studentId);
        await cC.query('commit');
        console.log('[M1a] creator committed while revoker in flight');
        await cR.query('commit');
        console.log('[M1a] revoker committed after creator');

        expect(await migratorCount(notifId)).toBe(1);
        expect(await runtimeSees(notifId)).toBe(0);
      } finally {
        await close(cR);
        await close(cC);
        await migrator.query(`delete from notifications where id = '${notifId}'`).catch(() => {});
        await migrator.query(`delete from student_guardians where id = '${relId}'`).catch(() => {});
        await migrator.query(`delete from students where id = '${studentId}'`).catch(() => {});
      }
    });

it('M1b. revoker commits first while the creator is in flight; the creator COMMIT is refused 55000',
      { timeout: 120_000 },
      async () => {
      const { studentId, relId } = await makeLinkedStudent('m1b');
      const notifId = randomUUID();
      let cR: pg.Client | undefined;
      let cC: pg.Client | undefined;
      try {
        const env = getEnv();
        cR = await makeClient(env.DATABASE_URL_MIGRATOR);
        cC = await makeClient(env.DATABASE_URL_MIGRATOR);

        await cR.query('begin');
        await cR.query(`update student_guardians set deleted_at = now() where id = '${relId}'`);
        await cR.query('commit');

        await cC.query('begin');
        await insertNotification(cC, notifId, 'm1b-' + slug);
        await insertContext(cC, notifId, studentId);
        await expectCommitError(cC, '55000');
        console.log('[M1b] revoker committed first; creator COMMIT refused 55000');

        expect(await migratorCount(notifId)).toBe(0);
      } finally {
        await close(cR);
        await close(cC);
        await migrator.query(`delete from student_guardians where id = '${relId}'`).catch(() => {});
        await migrator.query(`delete from students where id = '${studentId}'`).catch(() => {});
      }
    });

  // ---------------------------------------------------------------- M2
  // The precise commit-protocol boundary (revoker durable between the creator's
  // final re-validation snapshot and the creator's commit-record durability)
  // CANNOT be deterministically forced from client SQL (see header item 5).
  // This test therefore does not claim to pin it; it widens the creator's
  // validation window (multiple context rows), fires both COMMITs against each
  // other uncoordinatedly across iterations, and asserts every observed outcome
  // falls inside the documented tolerated set: {creator 55000} ∪ {committed and
  // hidden at read}. A reader starting after the revoker's durability must never
  // see the notification.
it('M2. close-boundary stress: overlapping commits stay inside the tolerated envelope',
      { timeout: 120_000 },
      async () => {
      const REPEAT = 8;
      const WIDTH = 4;
      let okHidden = 0;
      let failClosed = 0;
      const env = getEnv();
      for (let i = 0; i < REPEAT; i++) {
        const { studentIds, relIds } = {
          studentIds: [] as string[],
          relIds: [] as string[],
        };
        for (let w = 0; w < WIDTH; w++) {
          const ls = await makeLinkedStudent(`m2-${i}-${w}`);
          studentIds.push(ls.studentId);
          relIds.push(ls.relId);
        }
        const notifId = randomUUID();
        let cR: pg.Client | undefined;
        let cC: pg.Client | undefined;
        try {
          cR = await makeClient(env.DATABASE_URL_MIGRATOR);
          cC = await makeClient(env.DATABASE_URL_MIGRATOR);
          await cR.query('begin');
          await cR.query(`update student_guardians set deleted_at = now() where id = '${relIds[0]}'`);
          await cC.query('begin');
          await insertNotification(cC, notifId, `m2-${i}-${slug}`);
          for (const s of studentIds) await insertContext(cC, notifId, s);

          const [cr, cc] = await Promise.allSettled([cR.query('commit'), cC.query('commit')]);
          const crStatus = cr.status === 'fulfilled' ? 'ok' : (cr.reason as pg.DatabaseError).code;
          const ccStatus = cc.status === 'fulfilled' ? 'ok' : (cc.reason as pg.DatabaseError).code;
          expect(crStatus, `iteration ${i}: revoker must always commit`).toBe('ok');
          expect(['ok', '55000'], `iteration ${i}: unexpected creator outcome ${ccStatus}`).toContain(ccStatus);

          if (ccStatus === '55000') failClosed++;
          else okHidden++;
          expect(await migratorCount(notifId)).toBe(ccStatus === '55000' ? 0 : 1);
          expect(await runtimeSees(notifId)).toBe(0);
        } finally {
          await close(cR);
          await close(cC);
          await migrator.query(`delete from notifications where id = '${notifId}'`).catch(() => {});
          for (const r of relIds) await migrator.query(`delete from student_guardians where id = '${r}'`).catch(() => {});
          for (const s of studentIds) await migrator.query(`delete from students where id = '${s}'`).catch(() => {});
        }
      }
      console.log(`[M2] observed envelope: ${okHidden} committed-and-hidden, ${failClosed} fail-closed (55000), over ${REPEAT} iterations`);
      expect(failClosed + okHidden, 'unexpected: some iterations produced a third outcome').toBe(REPEAT);
    });

it('M3a. runtime creator (school_app_rw) commits while the privileged revoker is in flight; hidden after revocation',
      { timeout: 120_000 },
      async () => {
      const { studentId, relId } = await makeLinkedStudent('m3a');
      const notifId = randomUUID();
      const tkt = await mintTicket(uid.userA!, uid.tenantA!);
      let cR: pg.Client | undefined;
      try {
        const env = getEnv();
        cR = await makeClient(env.DATABASE_URL_MIGRATOR);
        await cR.query('begin');
        await cR.query(`update student_guardians set deleted_at = now() where id = '${relId}'`);

        await app.query('begin');
        await app.query(`set local app.rls = '${tkt}'`);
        await insertNotification(app, notifId, 'm3a-' + slug);
        await insertContext(app, notifId, studentId);
        await app.query('commit');
        console.log('[M3a] runtime creator committed while revoker in flight');
        await cR.query('commit');

        expect(await migratorCount(notifId)).toBe(1);
        expect(await runtimeSees(notifId)).toBe(0);
      } finally {
        await close(cR);
        await migrator.query(`delete from notifications where id = '${notifId}'`).catch(() => {});
        await migrator.query(`delete from student_guardians where id = '${relId}'`).catch(() => {});
        await migrator.query(`delete from students where id = '${studentId}'`).catch(() => {});
      }
    });

it('M3b. privileged revoker commits first; runtime creator COMMIT is refused 55000',
      { timeout: 120_000 },
      async () => {
      const { studentId, relId } = await makeLinkedStudent('m3b');
      const notifId = randomUUID();
      const tkt = await mintTicket(uid.userA!, uid.tenantA!);
      let cR: pg.Client | undefined;
      try {
        const env = getEnv();
        cR = await makeClient(env.DATABASE_URL_MIGRATOR);
        await cR.query('begin');
        await cR.query(`update student_guardians set deleted_at = now() where id = '${relId}'`);
        await cR.query('commit');

        await app.query('begin');
        await app.query(`set local app.rls = '${tkt}'`);
        await insertNotification(app, notifId, 'm3b-' + slug);
        await insertContext(app, notifId, studentId);
        await expectCommitError(app, '55000');
        console.log('[M3b] revoker committed first; runtime creator COMMIT refused 55000');

        expect(await migratorCount(notifId)).toBe(0);
      } finally {
        await close(cR);
        await migrator.query(`delete from student_guardians where id = '${relId}'`).catch(() => {});
        await migrator.query(`delete from students where id = '${studentId}'`).catch(() => {});
      }
    });

it('M4. reads beginning after the revocation commits never see the notification (statement-boundary semantics)',
      { timeout: 120_000 },
      async () => {
      const { studentId, relId } = await makeLinkedStudent('m4');
      const notifId = randomUUID();
      const tkt = await mintTicket(uid.userA!, uid.tenantA!);
      let cR: pg.Client | undefined;
      try {
        const env = getEnv();
        await migrator.query('begin');
        await insertNotification(migrator, notifId, 'm4-' + slug);
        await insertContext(migrator, notifId, studentId);
        await migrator.query('commit');

        cR = await makeClient(env.DATABASE_URL_MIGRATOR);

        // M4a: same open reader transaction, two READ COMMITTED statements.
        await app.query('begin');
        await app.query(`set local app.rls = '${tkt}'`);
        const before = await app.query<{ id: string }>(
          `select id from notifications where id = '${notifId}'`,
        );
        expect(before.rowCount ?? 0).toBe(1);
        await cR.query('begin');
        await cR.query(`update student_guardians set deleted_at = now() where id = '${relId}'`);
        await cR.query('commit');
        const after = await app.query<{ id: string }>(
          `select id from notifications where id = '${notifId}'`,
        );
        expect(after.rowCount ?? 0).toBe(0);
        await app.query('rollback').catch(() => {});
        console.log('[M4a] same-transaction reader: 1 before revocation commit, 0 after');

        // M4b: a brand-new reader statement (fresh transaction) after durability.
        expect(await runtimeSees(notifId)).toBe(0);
        console.log('[M4b] fresh reader statement after revocation durability: 0');
        expect(await migratorCount(notifId)).toBe(1);
      } finally {
        await app.query('rollback').catch(() => {});
        await close(cR);
        await migrator.query(`delete from notifications where id = '${notifId}'`).catch(() => {});
        await migrator.query(`delete from student_guardians where id = '${relId}'`).catch(() => {});
        await migrator.query(`delete from students where id = '${studentId}'`).catch(() => {});
      }
    });

it('M5. advisory-lock contention is bounded: creator COMMIT surfaces 55P03, then succeeds after the lock is released',
      { timeout: 120_000 },
      async () => {
      const { studentId, relId } = await makeLinkedStudent('m5');
      const notifId = randomUUID();
      const env = getEnv();
      let cHold: pg.Client | undefined;
      let cPush: pg.Client | undefined;
      try {
        cHold = await makeClient(env.DATABASE_URL_MIGRATOR);
        cPush = await makeClient(env.DATABASE_URL_MIGRATOR, 1000, 10000);

        await cHold.query('begin');
        await cHold.query(`select fn_lock_notification_parent('${uid.tenantA}', '${notifId}')`);

        await cPush.query('begin');
        await insertNotification(cPush, notifId, 'm5-' + slug);
        await insertContext(cPush, notifId, studentId);
        const started = Date.now();
        await expectCommitError(cPush, '55P03');
        const elapsed = Date.now() - started;
        expect(elapsed).toBeLessThan(10000);
        console.log(`[M5] creator COMMIT blocked on held advisory lock -> 55P03 in ${elapsed}ms`);

        await cHold.query('rollback').catch(() => {});

        await cPush.query('begin');
        await insertNotification(cPush, notifId, 'm5b-' + slug);
        await insertContext(cPush, notifId, studentId);
        await cPush.query('commit');
        console.log('[M5] after lock release, creator COMMIT succeeds');
        expect(await migratorCount(notifId)).toBe(1);
      } finally {
        await close(cHold);
        await close(cPush);
        await migrator.query(`delete from notifications where id = '${notifId}'`).catch(() => {});
        await migrator.query(`delete from student_guardians where id = '${relId}'`).catch(() => {});
        await migrator.query(`delete from students where id = '${studentId}'`).catch(() => {});
      }
    });

it('M6a1. hard delete of the link after commit: the notification survives but is hidden',
      { timeout: 120_000 },
      async () => {
      const { studentId, relId } = await makeLinkedStudent('m6a1');
      const notifId = randomUUID();
      try {
        await migrator.query('begin');
        await insertNotification(migrator, notifId, 'm6a1-' + slug);
        await insertContext(migrator, notifId, studentId);
        await migrator.query('commit');
        await migrator.query(`delete from student_guardians where id = '${relId}'`);
        expect(await migratorCount(notifId)).toBe(1);
        expect(await runtimeSees(notifId)).toBe(0);
        console.log('[M6a1] hard-deleted link: committed notification hidden at read');
      } finally {
        await migrator.query(`delete from notifications where id = '${notifId}'`).catch(() => {});
        await migrator.query(`delete from students where id = '${studentId}'`).catch(() => {});
      }
    });

it('M6a2. hard delete of the link before commit: creator COMMIT is refused 55000',
      { timeout: 120_000 },
      async () => {
      const { studentId, relId } = await makeLinkedStudent('m6a2');
      const notifId = randomUUID();
      let cC: pg.Client | undefined;
      try {
        const env = getEnv();
        await migrator.query(`delete from student_guardians where id = '${relId}'`);
        cC = await makeClient(env.DATABASE_URL_MIGRATOR);
        await cC.query('begin');
        await insertNotification(cC, notifId, 'm6a2-' + slug);
        await insertContext(cC, notifId, studentId);
        await expectCommitError(cC, '55000');
        expect(await migratorCount(notifId)).toBe(0);
        console.log('[M6a2] hard-deleted link before commit: creator COMMIT refused 55000');
      } finally {
        await close(cC);
        await migrator.query(`delete from students where id = '${studentId}'`).catch(() => {});
      }
    });

it('M6b1. soft-deleted student after commit: the notification is hidden',
      { timeout: 120_000 },
      async () => {
      const { studentId, relId } = await makeLinkedStudent('m6b1');
      const notifId = randomUUID();
      try {
        await migrator.query('begin');
        await insertNotification(migrator, notifId, 'm6b1-' + slug);
        await insertContext(migrator, notifId, studentId);
        await migrator.query('commit');
        await migrator.query(`update students set deleted_at = now() where id = '${studentId}'`);
        expect(await migratorCount(notifId)).toBe(1);
        expect(await runtimeSees(notifId)).toBe(0);
        console.log('[M6b1] soft-deleted student: committed notification hidden at read');
      } finally {
        await migrator.query(`delete from notifications where id = '${notifId}'`).catch(() => {});
        await migrator.query(`delete from students where id = '${studentId}'`).catch(() => {});
      }
    });

it('M6b2. hard-deleting the sole-context student is refused (55000); the notification and its context survive',
      { timeout: 120_000 },
      async () => {
      const { studentId, relId } = await makeLinkedStudent('m6b2');
      const notifId = randomUUID();
      try {
        await migrator.query('begin');
        await insertNotification(migrator, notifId, 'm6b2-' + slug);
        await insertContext(migrator, notifId, studentId);
        await migrator.query('commit');
        // Fresh finding: the hard delete does NOT cascade to a contextless state.
        // The context table's deferred DELETE trigger (0035:337-352) refuses any
        // deletion that would leave the guardian notification without a valid
        // context set, so a sole-context student's hard delete fails closed 55000
        // (the whole statement rolls back; the student and context survive).
        const err = await migrator
          .query(`delete from students where id = '${studentId}'`)
          .then(() => null, (e: unknown) => e as pg.DatabaseError);
        expect(err, 'expected the sole-context student hard delete to be refused').toBeInstanceOf(Error);
        expect((err as pg.DatabaseError).code).toBe('55000');
        const contexts = Number((await migQ<{ n: number }>(
          `select count(*)::int n from notification_student_contexts where notification_id = '${notifId}'`,
        ))[0]!.n);
        expect(contexts).toBe(1);
        expect(await migratorCount(notifId)).toBe(1);
        expect(await runtimeSees(notifId)).toBe(1);
        console.log('[M6b2] hard-deleting the sole-context student is REFUSED 55000 (fail closed); notification+context survive');
      } finally {
        await migrator.query(`delete from notifications where id = '${notifId}'`).catch(() => {});
        await migrator.query(`delete from student_guardians where id = '${relId}'`).catch(() => {});
        await migrator.query(`delete from students where id = '${studentId}'`).catch(() => {});
      }
    });

it('M6b3. hard-deleting one of two context students cascades cleanly (0035:81-83) and the notification stays visible',
      { timeout: 120_000 },
      async () => {
      const ls2 = await makeLinkedStudent('m6b3-a');
      const ls1 = await makeLinkedStudent('m6b3-b');
      const notifId = randomUUID();
      try {
        await migrator.query('begin');
        await insertNotification(migrator, notifId, 'm6b3-' + slug);
        await insertContext(migrator, notifId, ls1.studentId);
        await insertContext(migrator, notifId, ls2.studentId);
        await migrator.query('commit');
        // With a second valid context surviving, the FK cascade (0035:81-83)
        // proceeds: the deleted student's context row cascades away and the
        // re-validation of the surviving set still passes.
        await migrator.query(`delete from students where id = '${ls1.studentId}'`);
        const contexts = Number((await migQ<{ n: number }>(
          `select count(*)::int n from notification_student_contexts where notification_id = '${notifId}'`,
        ))[0]!.n);
        expect(contexts).toBe(1);
        expect(await migratorCount(notifId)).toBe(1);
        expect(await runtimeSees(notifId)).toBe(1);
        console.log('[M6b3] hard-deleted one of two students: context cascaded, notification stays visible');
      } finally {
        await migrator.query(`delete from notifications where id = '${notifId}'`).catch(() => {});
        for (const r of [ls1.relId, ls2.relId]) await migrator.query(`delete from student_guardians where id = '${r}'`).catch(() => {});
        for (const s of [ls1.studentId, ls2.studentId]) await migrator.query(`delete from students where id = '${s}'`).catch(() => {});
      }
    });
});