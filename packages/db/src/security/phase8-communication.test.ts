import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { getEnv } from '@sms/config';

/**
 * Phase 8 communication foundation DB security+integrity proofs, run against the
 * REAL roles and REAL disposable test database (school_app_rw -> school_saas_test).
 * Requires migrations 0001..0036.
 *
 * Section A (row-level security): all nine new tables are FORCE RLS; a bare
 * app_rw session sees nothing; a signed tenant context sees exactly its own rows
 * and can neither write nor hard-delete rows of a foreign tenant; the runtime
 * role has no DELETE path.
 * Section B (recipient-scoped reads, C-2): a user sees only notifications
 * addressed to them or to a student/guardian they are linked to.
 * Section C (integrity): C-1 exactly-one-recipient, C-4 tenant-bound recipient
 * FKs, nullable template_id + ON DELETE SET NULL, TMPL-1 system/tenant shape.
 * Section D (consent/quota seams): channel-wide preference uniqueness, quota
 * counter uniqueness and tenant isolation.
 * Section F (0035 guardian context integrity): ALL-context ALL-valid commit
 * invariants enforced by DEFERRABLE constraint triggers, fail-closed runtime
 * paths, and RLS visibility after link revocation.
 * Section G (0036 announcement lifecycle): draft-only insert, server-owned
 * publication stamp, frozen content, write-once recipient_snapshot, one-way
 * soft delete, and the interim non-draft DELETE refusal.
 * Section H (0035 concurrency gates): isolated sessions with bounded
 * lock_timeout proving that concurrent context deletions cannot commit a
 * guardian notification with zero contexts and that concurrent reassignment
 * preserves the invariant.
 *
 * Opt-in: RUN_RUNTIME_SECURITY_TESTS=1 (requires PostgreSQL + migrations 0001..0036).
 */
const enabled = process.env.RUN_RUNTIME_SECURITY_TESTS === '1';
const describeDb = enabled ? describe : describe.skip;

const TABLES = [
  'notification_templates',
  'notifications',
  'notification_student_contexts',
  'announcements',
  'message_threads',
  'message_thread_participants',
  'messages',
  'communication_preferences',
  'communication_quotas',
];

/** Tables using the standing 0004/0005 tenant shape (system templates excluded). */
const TENANT_TABLES = TABLES.filter((t) => t !== 'notification_templates');

const CHANNELS = ['email', 'sms', 'push', 'in_app'];

describeDb('phase 8 communication foundation RLS + integrity (school_saas_test)', () => {
  let migrator: pg.Client;
  let app: pg.Client;
  const uid: Record<string, string> = {};
  const slug = 'p8' + randomUUID().slice(0, 8);

  const appQ = <T extends pg.QueryResultRow = pg.QueryResultRow>(
    sqlText: string,
  ): Promise<T[]> => app.query<T>(sqlText).then((r) => r.rows);
  const migQ = <T extends pg.QueryResultRow = pg.QueryResultRow>(
    sqlText: string,
    params?: unknown[],
  ): Promise<T[]> => migrator.query<T>(sqlText, params as never[]).then((r) => r.rows);

  const rejectCode = async (
    fn: () => Promise<unknown>,
    code: string,
  ): Promise<void> => {
    await app.query('savepoint sp');
    const caught = await fn().catch((err: pg.DatabaseError) => err);
    await app.query('rollback to savepoint sp');
    expect(caught).toBeInstanceOf(Error);
    expect((caught as pg.DatabaseError).code).toBe(code);
  };

  /** Run under a signed tenant-A context transaction, rolling back afterwards. */
  async function tenantA<T>(fn: () => Promise<T>): Promise<T> {
    const tkt = (await appQ(
      `select app_ctx_mint('tenant', '${uid.userA}', '${uid.tenantA}') t`,
    ))[0]!.t as string;
    await app.query('begin');
    await app.query(`set local app.rls = '${tkt}'`);
    try {
      return await fn();
    } finally {
      await app.query('rollback').catch(() => {});
    }
  }

  /** Mint a signed tenant ticket for an arbitrary user/tenant (test-only). */
  async function mintTicket(user: string, tenant: string): Promise<string> {
    return (await appQ(
      `select app_ctx_mint('tenant', '${user}', '${tenant}') t`,
    ))[0]!.t as string;
  }

  /** Run fn inside a migrator transaction and always roll back (no fixtures). */
  async function migratorTx<T>(fn: () => Promise<T>): Promise<T> {
    await migrator.query('begin');
    try {
      return await fn();
    } finally {
      await migrator.query('rollback').catch(() => {});
    }
  }

  /** Assert a statement rejects with a PostgreSQL SQLSTATE. */
  async function expectPgError(
    p: Promise<unknown>,
    code: string,
  ): Promise<pg.DatabaseError> {
    const err = await p.then(
      () => null,
      (e: pg.DatabaseError) => e,
    );
    expect(err, 'expected a PostgreSQL error').toBeInstanceOf(Error);
    expect((err as pg.DatabaseError).code).toBe(code);
    return err as pg.DatabaseError;
  }

  /** Run fn under a savepoint, requiring failure with `code`, then recover. */
  async function migSavepointExpectError(
    code: string,
    fn: () => Promise<unknown>,
  ): Promise<pg.DatabaseError> {
    await migrator.query('savepoint mig_sp');
    const err = await fn().then(
      () => null,
      (e: pg.DatabaseError) => e,
    );
    await migrator.query('rollback to savepoint mig_sp');
    expect(err, 'expected a PostgreSQL error').toBeInstanceOf(Error);
    expect((err as pg.DatabaseError).code).toBe(code);
    return err as pg.DatabaseError;
  }

  /**
   * COMMIT the open transaction and assert it is rejected with `code`
   * (deferred-constraint negatives fire here, not at DML). Leaves the session
   * idle so later fixtures on the same client are unaffected.
   */
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

  beforeAll(async () => {
    const env = getEnv();
    migrator = new pg.Client({ connectionString: env.DATABASE_URL_MIGRATOR });
    app = new pg.Client({ connectionString: env.DATABASE_URL_APP });
    await migrator.connect();
    await app.connect();

    for (const k of [
      'userA', 'userA2', 'userB', 'tenantA', 'tenantB', 'studentA', 'studentA2',
      'studentB', 'guardianA', 'guardianB', 'relA', 'relA2', 'relB', 'ctxA',
      'sysTpl', 'tplA', 'tplB', 'noteUser', 'noteStudent', 'noteGuardian',
      'noteOther', 'annA', 'annB', 'threadA', 'threadB', 'msgA', 'msgB',
      'prefA', 'prefB', 'quotaA', 'quotaB',
    ]) {
      uid[k] = randomUUID();
    }

    await migrator.query('begin');
    // Idempotency guard: a crashed prior run may have left its randomly-keyed
    // system template behind (system templates are tenant-less, so afterAll can
    // only delete its own id). Clear the fixed (code,channel,locale) we insert.
    await migrator.query(
      `delete from notification_templates where tenant_id is null and code = 'welcome' and channel = 'email' and locale = 'en'`,
    );
    await migrator.query(
      `insert into tenants (id, slug, name) values
         ('${uid.tenantA}', '${slug}-a', 'Phase8 Comm A'),
         ('${uid.tenantB}', '${slug}-b', 'Phase8 Comm B')`,
    );
    await migrator.query(
      `insert into users (id, email) values
         ('${uid.userA}', 'p8-a-${slug}@example.com'),
         ('${uid.userA2}', 'p8-a2-${slug}@example.com'),
         ('${uid.userB}', 'p8-b-${slug}@example.com')`,
    );
    await migrator.query(
      `insert into memberships (id, tenant_id, user_id, status) values
         ('${randomUUID()}', '${uid.tenantA}', '${uid.userA}', 'active'),
         ('${randomUUID()}', '${uid.tenantA}', '${uid.userA2}', 'active'),
         ('${randomUUID()}', '${uid.tenantB}', '${uid.userB}', 'active')`,
    );
    await migrator.query(
      `insert into students (id, tenant_id, student_no, first_name, last_name, user_id) values
         ('${uid.studentA}', '${uid.tenantA}', 'p8-sa-${slug}', 'Alice', 'And', '${uid.userA}'),
         ('${uid.studentA2}', '${uid.tenantA}', 'p8-sa2-${slug}', 'Ava', 'And', null),
         ('${uid.studentB}', '${uid.tenantB}', 'p8-sb-${slug}', 'Bob', 'Brown', '${uid.userB}')`,
    );
    await migrator.query(
      `insert into guardians (id, tenant_id, first_name, last_name, email, user_id) values
         ('${uid.guardianA}', '${uid.tenantA}', 'Gina', 'Alt', 'gina-${slug}@example.com', '${uid.userA}'),
         ('${uid.guardianB}', '${uid.tenantB}', 'Gary', 'Blue', 'gary-${slug}@example.com', '${uid.userB}')`,
    );
    await migrator.query(
      `insert into student_guardians (id, tenant_id, student_id, guardian_id, relation) values
         ('${uid.relA}', '${uid.tenantA}', '${uid.studentA}', '${uid.guardianA}', 'mother'),
         ('${uid.relA2}', '${uid.tenantA}', '${uid.studentA2}', '${uid.guardianA}', 'guardian'),
         ('${uid.relB}', '${uid.tenantB}', '${uid.studentB}', '${uid.guardianB}', 'mother')`,
    );
    // TMPL-1: one system template + one tenant override each.
    await migrator.query(
      `insert into notification_templates (id, tenant_id, code, channel, locale, body, is_system) values
         ('${uid.sysTpl}', null, 'welcome', 'email', 'en', 'Welcome (system)', true)`,
    );
    await migrator.query(
      `insert into notification_templates (id, tenant_id, code, channel, locale, body, is_system) values
         ('${uid.tplA}', '${uid.tenantA}', 'welcome', 'email', 'en', 'Welcome A', false),
         ('${uid.tplB}', '${uid.tenantB}', 'welcome', 'email', 'en', 'Welcome B', false)`,
    );
    // notifications: user/student/guardian recipient + one addressed to userA2.
    await migrator.query(
      `insert into notifications (id, tenant_id, recipient_user_id, channel, dedupe_key, body) values
         ('${uid.noteUser}', '${uid.tenantA}', '${uid.userA}', 'email', 'k-user-${slug}', 'to user A'),
         ('${uid.noteOther}', '${uid.tenantA}', '${uid.userA2}', 'email', 'k-other-${slug}', 'to user A2')`,
    );
    await migrator.query(
      `insert into notifications (id, tenant_id, recipient_student_id, channel, dedupe_key, body) values
         ('${uid.noteStudent}', '${uid.tenantA}', '${uid.studentA}', 'sms', 'k-stu-${slug}', 'to student A')`,
    );
    await migrator.query(
      `insert into notifications (id, tenant_id, recipient_guardian_id, template_id, channel, dedupe_key, body) values
         ('${uid.noteGuardian}', '${uid.tenantA}', '${uid.guardianA}', '${uid.tplA}', 'push', 'k-gua-${slug}', 'to guardian A')`,
    );
    // 0035: the guardian notification must carry at least one valid student context.
    await migrator.query(
      `insert into notification_student_contexts (id, tenant_id, notification_id, student_id) values
         ('${uid.ctxA}', '${uid.tenantA}', '${uid.noteGuardian}', '${uid.studentA}')`,
    );
    // 0036: fixtures start as drafts so the lifecycle trigger owns publication.
    await migrator.query(
      `insert into announcements (id, tenant_id, title, body, status) values
         ('${uid.annA}', '${uid.tenantA}', 'A notice', 'A body', 'draft'),
         ('${uid.annB}', '${uid.tenantB}', 'B notice', 'B body', 'draft')`,
    );
    await migrator.query(
      `insert into message_threads (id, tenant_id, subject, created_by) values
         ('${uid.threadA}', '${uid.tenantA}', 'A thread', '${uid.userA}'),
         ('${uid.threadB}', '${uid.tenantB}', 'B thread', '${uid.userB}')`,
    );
    await migrator.query(
      `insert into message_thread_participants (id, tenant_id, thread_id, user_id) values
         ('${randomUUID()}', '${uid.tenantA}', '${uid.threadA}', '${uid.userA}'),
         ('${randomUUID()}', '${uid.tenantB}', '${uid.threadB}', '${uid.userB}')`,
    );
    await migrator.query(
      `insert into messages (id, tenant_id, thread_id, sender_user_id, body) values
         ('${uid.msgA}', '${uid.tenantA}', '${uid.threadA}', '${uid.userA}', 'hi A'),
         ('${uid.msgB}', '${uid.tenantB}', '${uid.threadB}', '${uid.userB}', 'hi B')`,
    );
    await migrator.query(
      `insert into communication_preferences (id, tenant_id, user_id, channel, enabled) values
         ('${uid.prefA}', '${uid.tenantA}', '${uid.userA}', 'email', false),
         ('${uid.prefB}', '${uid.tenantB}', '${uid.userB}', 'email', false)`,
    );
    await migrator.query(
      `insert into communication_quotas (id, tenant_id, channel, quota_date, sent_count) values
         ('${uid.quotaA}', '${uid.tenantA}', 'email', '2026-01-15', 3),
         ('${uid.quotaB}', '${uid.tenantB}', 'email', '2026-01-15', 3)`,
    );
    await migrator.query('commit');
  });

  afterAll(async () => {
    try {
      await migrator.query('begin');
      const tids = `'${uid.tenantA}','${uid.tenantB}'`;
      await migrator.query(`delete from notification_student_contexts where tenant_id in (${tids})`);
      await migrator.query(`delete from notifications where tenant_id in (${tids})`);
      await migrator.query(`delete from communication_preferences where tenant_id in (${tids})`);
      await migrator.query(`delete from communication_quotas where tenant_id in (${tids})`);
      await migrator.query(`delete from messages where tenant_id in (${tids})`);
      await migrator.query(`delete from message_thread_participants where tenant_id in (${tids})`);
      await migrator.query(`delete from message_threads where tenant_id in (${tids})`);
      await migrator.query(`delete from announcements where tenant_id in (${tids})`);
      await migrator.query(`delete from notification_templates where id in ('${uid.sysTpl}','${uid.tplA}','${uid.tplB}')`);
      await migrator.query(`delete from student_guardians where tenant_id in (${tids})`);
      await migrator.query(`delete from guardians where tenant_id in (${tids})`);
      await migrator.query(`delete from students where tenant_id in (${tids})`);
      await migrator.query(`delete from memberships where tenant_id in (${tids})`);
      await migrator.query(`delete from users where id in ('${uid.userA}','${uid.userA2}','${uid.userB}')`);
      await migrator.query(`delete from tenants where id in (${tids})`);
      await migrator.query('commit');
    } finally {
      await migrator.end();
      await app.end();
    }
  });

  afterEach(async () => {
    await migrator.query('rollback').catch(() => {});
    await app.query('rollback').catch(() => {});
  });

  describe('A. row-level security boundary', () => {
    it('1. RLS is enabled AND forced on all nine new tables', async () => {
      const res = await migrator.query<{ tbl: string; rls: boolean; force: boolean }>(
        `
        select c.relname tbl, c.relrowsecurity rls, c.relforcerowsecurity force
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relname = ANY($1)
        order by c.relname`,
        [TABLES],
      );
      expect(res.rows).toHaveLength(TABLES.length);
      for (const row of res.rows) {
        expect(row.rls).toBe(true);
        expect(row.force).toBe(true);
      }
    });

    it('2. all nine new tables are registered in this isolation suite', async () => {
      const rels = await migQ<{ tablename: string }>(
        `select tablename from pg_tables where schemaname = 'public' and tablename = ANY($1)`,
        [TABLES],
      );
      expect(rels.map((r) => r.tablename).sort()).toEqual([...TABLES].sort());
    });

    it('3. school_app_rw has DML grants but sees zero rows without a context', async () => {
      const grants = await migQ<{ s: boolean; i: boolean; u: boolean; d: boolean }>(`
        select has_table_privilege('school_app_rw', 'notifications', 'SELECT') s,
               has_table_privilege('school_app_rw', 'notifications', 'INSERT') i,
               has_table_privilege('school_app_rw', 'notifications', 'UPDATE') u,
               has_table_privilege('school_app_rw', 'notifications', 'DELETE') d`);
      expect(grants[0]).toEqual({ s: true, i: true, u: true, d: true });
      for (const t of TABLES) {
        const r = await appQ<{ n: number }>(`select count(*)::int n from "${t}"`);
        expect(Number(r[0]!.n), t).toBe(0);
      }
    });

    it('4. tenant A context sees exactly its own rows, never tenant B', async () => {
      await tenantA(async () => {
        for (const t of TENANT_TABLES) {
          const o = (await appQ<{ n: number }>(
            `select count(*)::int n from "${t}" where tenant_id = '${uid.tenantA}'`,
          ))[0]!.n;
          const f = (await appQ<{ n: number }>(
            `select count(*)::int n from "${t}" where tenant_id = '${uid.tenantB}'`,
          ))[0]!.n;
          expect(Number(o), t).toBeGreaterThan(0);
          expect(Number(f), t).toBe(0);
        }
        // System templates are visible from any tenant context; foreign overrides are not.
        const sys = (await appQ<{ n: number }>(
          `select count(*)::int n from notification_templates where is_system`,
        ))[0]!.n;
        const foreignTpl = (await appQ<{ n: number }>(
          `select count(*)::int n from notification_templates where tenant_id = '${uid.tenantB}'`,
        ))[0]!.n;
        expect(Number(sys)).toBeGreaterThan(0);
        expect(Number(foreignTpl)).toBe(0);
      });
    });

    it('5. cross-tenant INSERT is rejected for every new table', async () => {
      await tenantA(async () => {
        const inserts: Record<string, string> = {
          announcement: `insert into announcements (id, tenant_id, title, body)
                         values ('${randomUUID()}', '${uid.tenantB}', 'x', 'y')`,
          announcement_tpl: `insert into notification_templates (id, tenant_id, code, channel, body)
                             values ('${randomUUID()}', '${uid.tenantB}', 'x-${slug}', 'email', 'y')`,
          notification: `insert into notifications (id, tenant_id, recipient_user_id, channel, dedupe_key, body)
                         values ('${randomUUID()}', '${uid.tenantB}', '${uid.userB}', 'email', 'x-${slug}', 'y')`,
          context: `insert into notification_student_contexts (id, tenant_id, notification_id, student_id)
                    values ('${randomUUID()}', '${uid.tenantB}', '${uid.noteGuardian}', '${uid.studentB}')`,
          thread: `insert into message_threads (id, tenant_id, subject)
                   values ('${randomUUID()}', '${uid.tenantB}', 'x')`,
          participant: `insert into message_thread_participants (id, tenant_id, thread_id, user_id)
                        values ('${randomUUID()}', '${uid.tenantB}', '${uid.threadB}', '${uid.userB}')`,
          message: `insert into messages (id, tenant_id, thread_id, sender_user_id, body)
                    values ('${randomUUID()}', '${uid.tenantB}', '${uid.threadB}', '${uid.userB}', 'x')`,
          pref: `insert into communication_preferences (id, tenant_id, user_id, channel)
                 values ('${randomUUID()}', '${uid.tenantB}', '${uid.userB}', 'sms')`,
          quota: `insert into communication_quotas (id, tenant_id, channel, quota_date)
                  values ('${randomUUID()}', '${uid.tenantB}', 'sms', '2026-02-01')`,
        };
        for (const sql of Object.values(inserts)) {
          await rejectCode(() => app.query(sql), '42501');
        }
      });
    });

    it('6. runtime DELETE is privileged-only (tenant shape) but tenant-scoped for templates', async () => {
      await tenantA(async () => {
        for (const t of TENANT_TABLES) {
          const del = await app.query(`delete from "${t}" where tenant_id = '${uid.tenantA}'`);
          expect(del.rowCount, t).toBe(0);
        }
        // TMPL-1 allows a tenant to delete its own non-system override.
        const throwaway = randomUUID();
        await app.query(
          `insert into notification_templates (id, tenant_id, code, channel, body)
           values ('${throwaway}', '${uid.tenantA}', 'tmp-${slug}', 'email', 'x')`,
        );
        const delTpl = await app.query(
          `delete from notification_templates where id = '${throwaway}'`,
        );
        expect(delTpl.rowCount).toBe(1);
      });
    });

    it('7. cross-tenant composite FK parents are rejected', async () => {
      await tenantA(async () => {
        // A tenant-A participant/message may not reference tenant-B parents.
        await rejectCode(
          () =>
            app.query(
              `insert into message_thread_participants (id, tenant_id, thread_id, user_id)
               values ('${randomUUID()}', '${uid.tenantA}', '${uid.threadB}', '${uid.userA}')`,
            ),
          '23503',
        );
        await rejectCode(
          () =>
            app.query(
              `insert into messages (id, tenant_id, thread_id, sender_user_id, body)
               values ('${randomUUID()}', '${uid.tenantA}', '${uid.threadB}', '${uid.userA}', 'x')`,
            ),
          '23503',
        );
        await rejectCode(
          () =>
            app.query(
              `insert into notifications (id, tenant_id, recipient_student_id, channel, dedupe_key, body)
               values ('${randomUUID()}', '${uid.tenantA}', '${uid.studentB}', 'email', 'x-${slug}', 'y')`,
            ),
          '23503',
        );
      });
    });
  });

  describe('B. notifications C-2 recipient-scoped reads', () => {
    it('8. user A sees own + linked student/guardian rows, not other recipients', async () => {
      await tenantA(async () => {
        const seen = await appQ<{ id: string }>(
          `select id from notifications where tenant_id = '${uid.tenantA}' order by id`,
        );
        const ids = seen.map((r) => r.id);
        expect(ids).toContain(uid.noteUser);
        expect(ids).toContain(uid.noteStudent);
        expect(ids).toContain(uid.noteGuardian);
        expect(ids).not.toContain(uid.noteOther);
      });
    });

    it('9. the target user does see the row addressed to them', async () => {
      const tkt = (await appQ(
        `select app_ctx_mint('tenant', '${uid.userA2}', '${uid.tenantA}') t`,
      ))[0]!.t as string;
      await app.query('begin');
      await app.query(`set local app.rls = '${tkt}'`);
      try {
        const seen = await appQ<{ id: string }>(
          `select id from notifications where tenant_id = '${uid.tenantA}'`,
        );
        const ids = seen.map((r) => r.id);
        expect(ids).toContain(uid.noteOther);
        expect(ids).not.toContain(uid.noteUser);
      } finally {
        await app.query('rollback').catch(() => {});
      }
    });
  });

  describe('C. notifications integrity (C-1, C-4, template seam)', () => {
    it('10. exactly-one-recipient CHECK accepts one and rejects zero/pairs/three', async () => {
      await tenantA(async () => {
        // Accepts a single recipient.
        const ok = await app.query(
          `insert into notifications (id, tenant_id, recipient_user_id, channel, dedupe_key, body)
           values ('${randomUUID()}', '${uid.tenantA}', '${uid.userA}', 'email', 'ok-${slug}', 'ok')`,
        );
        expect(ok.rowCount).toBe(1);

        const base = `insert into notifications (id, tenant_id, channel, dedupe_key, body)`;
        await rejectCode(
          () => app.query(`${base} values ('${randomUUID()}', '${uid.tenantA}', 'email', 'n0-${slug}', 'x')`),
          '23514',
        ); // all null
        // Each pair.
        await rejectCode(
          () =>
            app.query(
              `insert into notifications (id, tenant_id, recipient_user_id, recipient_student_id, channel, dedupe_key, body)
               values ('${randomUUID()}', '${uid.tenantA}', '${uid.userA}', '${uid.studentA}', 'email', 'p-${slug}', 'x')`,
            ),
          '23514',
        );
        await rejectCode(
          () =>
            app.query(
              `insert into notifications (id, tenant_id, recipient_user_id, recipient_guardian_id, channel, dedupe_key, body)
               values ('${randomUUID()}', '${uid.tenantA}', '${uid.userA}', '${uid.guardianA}', 'email', 'p2-${slug}', 'x')`,
            ),
          '23514',
        );
        await rejectCode(
          () =>
            app.query(
              `insert into notifications (id, tenant_id, recipient_student_id, recipient_guardian_id, channel, dedupe_key, body)
               values ('${randomUUID()}', '${uid.tenantA}', '${uid.studentA}', '${uid.guardianA}', 'email', 'p3-${slug}', 'x')`,
            ),
          '23514',
        );
        // All three.
        await rejectCode(
          () =>
            app.query(
              `insert into notifications (id, tenant_id, recipient_user_id, recipient_student_id, recipient_guardian_id, channel, dedupe_key, body)
               values ('${randomUUID()}', '${uid.tenantA}', '${uid.userA}', '${uid.studentA}', '${uid.guardianA}', 'email', 'p4-${slug}', 'x')`,
            ),
          '23514',
        );
      });
    });

    it('11. invalid channel value is rejected (column domain)', async () => {
      await tenantA(async () => {
        await rejectCode(
          () =>
            app.query(
              `insert into notifications (id, tenant_id, recipient_user_id, channel, dedupe_key, body)
               values ('${randomUUID()}', '${uid.tenantA}', '${uid.userA}', 'carrier_pigeon', 'c-${slug}', 'x')`,
            ),
          '23514',
        );
      });
    });

    it('12. nullable template_id is SET NULL when the template row is deleted', async () => {
      const before = await migQ<{ template_id: string | null }>(
        `select template_id from notifications where id = '${uid.noteGuardian}'`,
      );
      expect(before[0]!.template_id).toBe(uid.tplA);
      await migrator.query(`delete from notification_templates where id = '${uid.tplA}'`);
      const after = await migQ<{ template_id: string | null }>(
        `select template_id from notifications where id = '${uid.noteGuardian}'`,
      );
      expect(after[0]!.template_id).toBeNull();
    });
  });

  describe('D. TMPL-1 template access shape', () => {
    it('13. tenant context cannot modify or delete a system template row', async () => {
      await tenantA(async () => {
        const upd = await app.query(
          `update notification_templates set body = 'hacked' where id = '${uid.sysTpl}'`,
        );
        expect(upd.rowCount).toBe(0);
        const del = await app.query(
          `delete from notification_templates where id = '${uid.sysTpl}'`,
        );
        expect(del.rowCount).toBe(0);
      });
    });

    it('14. a tenant cannot create a system (tenant-less) template', async () => {
      await tenantA(async () => {
        await rejectCode(
          () =>
            app.query(
              `insert into notification_templates (id, tenant_id, code, channel, body, is_system)
               values ('${randomUUID()}', null, 'sys-${slug}', 'email', 'x', true)`,
            ),
          // Writing a tenant-less row travels the tenant branch and is blocked by
          // the INSERT WITH CHECK policy (RLS) before the invariant CHECK runs.
          '42501',
        );
      });
    });
  });

  describe('E. consent + quota seams', () => {
    it('15. communication_preferences is channel-wide and rejects duplicates', async () => {
      await tenantA(async () => {
        const upd = await app.query(
          `update communication_preferences set enabled = true
           where tenant_id = '${uid.tenantA}' and user_id = '${uid.userA}' and channel = 'email'`,
        );
        expect(upd.rowCount).toBe(1);
        await rejectCode(
          () =>
            app.query(
              `insert into communication_preferences (id, tenant_id, user_id, channel)
               values ('${randomUUID()}', '${uid.tenantA}', '${uid.userA}', 'email')`,
            ),
          '23505',
        );
      });
    });

    it('16. communication_quotas enforces counter uniqueness and tenant isolation', async () => {
      await tenantA(async () => {
        await rejectCode(
          () =>
            app.query(
              `insert into communication_quotas (id, tenant_id, channel, quota_date)
               values ('${randomUUID()}', '${uid.tenantA}', 'email', '2026-01-15')`,
            ),
          '23505',
        );
        const own = (await appQ<{ n: number }>(
          `select count(*)::int n from communication_quotas where tenant_id = '${uid.tenantA}'`,
        ))[0]!.n;
        const foreign = (await appQ<{ n: number }>(
          `select count(*)::int n from communication_quotas where tenant_id = '${uid.tenantB}'`,
        ))[0]!.n;
        expect(Number(own)).toBe(1);
        expect(Number(foreign)).toBe(0);
      });
    });

    it('17. negative sent_count is rejected', async () => {
      await tenantA(async () => {
        await rejectCode(
          () =>
            app.query(
              `insert into communication_quotas (id, tenant_id, channel, quota_date, sent_count)
               values ('${randomUUID()}', '${uid.tenantA}', 'sms', '2026-03-01', -1)`,
            ),
          '23514',
        );
      });
    });

    it('18. template channel domain is enforced', async () => {
      await tenantA(async () => {
        await rejectCode(
          () =>
            app.query(
              `insert into notification_templates (id, tenant_id, code, channel, body)
               values ('${randomUUID()}', '${uid.tenantA}', 'c-${slug}', 'telepathy', 'x')`,
            ),
          '23514',
        );
      });
    });
  });

  describe('F. guardian notification context integrity (0035)', () => {
    it('F1. commit succeeds for a guardian notification with one valid context', async () => {
      const n = randomUUID();
      await migrator.query('begin');
      await migrator.query(
        `insert into notifications (id, tenant_id, recipient_guardian_id, channel, dedupe_key, body)
         values ('${n}', '${uid.tenantA}', '${uid.guardianA}', 'email', 'f1-${slug}', 'x')`,
      );
      await migrator.query(
        `insert into notification_student_contexts (id, tenant_id, notification_id, student_id)
         values ('${randomUUID()}', '${uid.tenantA}', '${n}', '${uid.studentA}')`,
      );
      await migrator.query('commit');
      const c = await migQ<{ n: number }>(
        `select count(*)::int n from notification_student_contexts where notification_id = '${n}'`,
      );
      expect(Number(c[0]!.n)).toBe(1);
      await migrator.query(`delete from notifications where id = '${n}'`);
    });

    it('F2. commit fails closed when a guardian notification has no context (55000, not committed)', async () => {
      const n = randomUUID();
      await migrator.query('begin');
      await migrator.query(
        `insert into notifications (id, tenant_id, recipient_guardian_id, channel, dedupe_key, body)
         values ('${n}', '${uid.tenantA}', '${uid.guardianA}', 'email', 'f2-${slug}', 'x')`,
      );
      const err = await expectCommitError(migrator, '55000');
      expect(err.message).toMatch(/valid context set/);
      const row = await migQ<{ n: number }>(
        `select count(*)::int n from notifications where id = '${n}'`,
      );
      expect(Number(row[0]!.n)).toBe(0);
    });

    it('F3. commit fails when a context row targets a non-guardian notification (55000)', async () => {
      const n = randomUUID();
      await migrator.query('begin');
      await migrator.query(
        `insert into notifications (id, tenant_id, recipient_user_id, channel, dedupe_key, body)
         values ('${n}', '${uid.tenantA}', '${uid.userA}', 'email', 'f3-${slug}', 'x')`,
      );
      await migrator.query(
        `insert into notification_student_contexts (id, tenant_id, notification_id, student_id)
         values ('${randomUUID()}', '${uid.tenantA}', '${n}', '${uid.studentA}')`,
      );
      await expectCommitError(migrator, '55000');
      const c = await migQ<{ n: number }>(
        `select count(*)::int n from notification_student_contexts where notification_id = '${n}'`,
      );
      expect(Number(c[0]!.n)).toBe(0);
    });

    it('F4. commit fails when a context student has no live link to the guardian (55000)', async () => {
      const n = randomUUID();
      const s = randomUUID();
      await migrator.query('begin');
      await migrator.query(
        `insert into students (id, tenant_id, student_no, first_name, last_name)
         values ('${s}', '${uid.tenantA}', 'f4-${slug}', 'Una', 'Linked')`,
      );
      await migrator.query(
        `insert into notifications (id, tenant_id, recipient_guardian_id, channel, dedupe_key, body)
         values ('${n}', '${uid.tenantA}', '${uid.guardianA}', 'email', 'f4-${slug}', 'x')`,
      );
      await migrator.query(
        `insert into notification_student_contexts (id, tenant_id, notification_id, student_id)
         values ('${randomUUID()}', '${uid.tenantA}', '${n}', '${s}')`,
      );
      await expectCommitError(migrator, '55000');
    });

    it('F5. commit fails when the context student is soft-deleted (55000)', async () => {
      const n = randomUUID();
      const s = randomUUID();
      const link = randomUUID();
      await migrator.query('begin');
      await migrator.query(
        `insert into students (id, tenant_id, student_no, first_name, last_name)
         values ('${s}', '${uid.tenantA}', 'f5-${slug}', 'Soft', 'Deleted')`,
      );
      await migrator.query(
        `insert into student_guardians (id, tenant_id, student_id, guardian_id, relation)
         values ('${link}', '${uid.tenantA}', '${s}', '${uid.guardianA}', 'guardian')`,
      );
      await migrator.query(`update students set deleted_at = now() where id = '${s}'`);
      await migrator.query(
        `insert into notifications (id, tenant_id, recipient_guardian_id, channel, dedupe_key, body)
         values ('${n}', '${uid.tenantA}', '${uid.guardianA}', 'email', 'f5-${slug}', 'x')`,
      );
      await migrator.query(
        `insert into notification_student_contexts (id, tenant_id, notification_id, student_id)
         values ('${randomUUID()}', '${uid.tenantA}', '${n}', '${s}')`,
      );
      await expectCommitError(migrator, '55000');
    });

    it('F6. commit fails when the guardian-student link is soft-deleted (55000)', async () => {
      const n = randomUUID();
      const s = randomUUID();
      const link = randomUUID();
      await migrator.query('begin');
      await migrator.query(
        `insert into students (id, tenant_id, student_no, first_name, last_name)
         values ('${s}', '${uid.tenantA}', 'f6-${slug}', 'Live', 'Unlinked')`,
      );
      await migrator.query(
        `insert into student_guardians (id, tenant_id, student_id, guardian_id, relation)
         values ('${link}', '${uid.tenantA}', '${s}', '${uid.guardianA}', 'guardian')`,
      );
      await migrator.query(`update student_guardians set deleted_at = now() where id = '${link}'`);
      await migrator.query(
        `insert into notifications (id, tenant_id, recipient_guardian_id, channel, dedupe_key, body)
         values ('${n}', '${uid.tenantA}', '${uid.guardianA}', 'email', 'f6-${slug}', 'x')`,
      );
      await migrator.query(
        `insert into notification_student_contexts (id, tenant_id, notification_id, student_id)
         values ('${randomUUID()}', '${uid.tenantA}', '${n}', '${s}')`,
      );
      await expectCommitError(migrator, '55000');
    });

    it('F7. deleting the last context of a committed guardian notification is refused (55000)', async () => {
      const n = randomUUID();
      const c = randomUUID();
      await migrator.query('begin');
      await migrator.query(
        `insert into notifications (id, tenant_id, recipient_guardian_id, channel, dedupe_key, body)
         values ('${n}', '${uid.tenantA}', '${uid.guardianA}', 'email', 'f7-${slug}', 'x')`,
      );
      await migrator.query(
        `insert into notification_student_contexts (id, tenant_id, notification_id, student_id)
         values ('${c}', '${uid.tenantA}', '${n}', '${uid.studentA}')`,
      );
      await migrator.query('commit');
      await migrator.query('begin');
      await migrator.query(`delete from notification_student_contexts where id = '${c}'`);
      await expectCommitError(migrator, '55000');
      const cnt = await migQ<{ n: number }>(
        `select count(*)::int n from notification_student_contexts where notification_id = '${n}'`,
      );
      expect(Number(cnt[0]!.n)).toBe(1);
      await migrator.query(`delete from notifications where id = '${n}'`);
    });

    it('F8. reassignment is allowed while a context remains and refused when it would empty the source (55000)', async () => {
      const n1 = randomUUID();
      const n2 = randomUUID();
      const c1 = randomUUID();
      const c2 = randomUUID();
      const c3 = randomUUID();
      const s8 = randomUUID();
      const rel8 = randomUUID();
      await migrator.query('begin');
      await migrator.query(
        `insert into students (id, tenant_id, student_no, first_name, last_name)
         values ('${s8}', '${uid.tenantA}', 'f8-${slug}', 'Move', 'Target')`,
      );
      await migrator.query(
        `insert into student_guardians (id, tenant_id, student_id, guardian_id, relation)
         values ('${rel8}', '${uid.tenantA}', '${s8}', '${uid.guardianA}', 'guardian')`,
      );
      await migrator.query(
        `insert into notifications (id, tenant_id, recipient_guardian_id, channel, dedupe_key, body) values
           ('${n1}', '${uid.tenantA}', '${uid.guardianA}', 'email', 'f8a-${slug}', 'x'),
           ('${n2}', '${uid.tenantA}', '${uid.guardianA}', 'email', 'f8b-${slug}', 'x')`,
      );
      await migrator.query(
        `insert into notification_student_contexts (id, tenant_id, notification_id, student_id) values
           ('${c1}', '${uid.tenantA}', '${n1}', '${uid.studentA}'),
           ('${c2}', '${uid.tenantA}', '${n1}', '${uid.studentA2}'),
           ('${c3}', '${uid.tenantA}', '${n2}', '${s8}')`,
      );
      await migrator.query('commit');
      await migrator.query('begin');
      await migrator.query(`update notification_student_contexts set notification_id = '${n2}' where id = '${c1}'`);
      await migrator.query('commit');
      const left = await migQ<{ n: number }>(
        `select count(*)::int n from notification_student_contexts where notification_id = '${n1}'`,
      );
      expect(Number(left[0]!.n)).toBe(1);
      await migrator.query('begin');
      await migrator.query(`update notification_student_contexts set notification_id = '${n2}' where id = '${c2}'`);
      await expectCommitError(migrator, '55000');
      const still = await migQ<{ n: number }>(
        `select count(*)::int n from notification_student_contexts where notification_id = '${n1}'`,
      );
      expect(Number(still[0]!.n)).toBe(1);
      await migrator.query(`delete from notifications where id in ('${n1}','${n2}')`);
      await migrator.query(`delete from student_guardians where id = '${rel8}'`);
      await migrator.query(`delete from students where id = '${s8}'`);
    });

    it('F9. deleting the notification cascades its contexts and commits cleanly', async () => {
      const n = randomUUID();
      await migrator.query('begin');
      await migrator.query(
        `insert into notifications (id, tenant_id, recipient_guardian_id, channel, dedupe_key, body)
         values ('${n}', '${uid.tenantA}', '${uid.guardianA}', 'email', 'f9-${slug}', 'x')`,
      );
      await migrator.query(
        `insert into notification_student_contexts (id, tenant_id, notification_id, student_id)
         values ('${randomUUID()}', '${uid.tenantA}', '${n}', '${uid.studentA}')`,
      );
      await migrator.query('commit');
      await migrator.query(`delete from notifications where id = '${n}'`);
      const c = await migQ<{ n: number }>(
        `select count(*)::int n from notification_student_contexts where notification_id = '${n}'`,
      );
      expect(Number(c[0]!.n)).toBe(0);
    });

    it('F10. a student kept valid by a second context cascades away cleanly', async () => {
      const s = randomUUID();
      const link = randomUUID();
      const n = randomUUID();
      await migrator.query('begin');
      await migrator.query(
        `insert into students (id, tenant_id, student_no, first_name, last_name)
         values ('${s}', '${uid.tenantA}', 'f10-${slug}', 'Casc', 'Ade')`,
      );
      await migrator.query(
        `insert into student_guardians (id, tenant_id, student_id, guardian_id, relation)
         values ('${link}', '${uid.tenantA}', '${s}', '${uid.guardianA}', 'guardian')`,
      );
      await migrator.query(
        `insert into notifications (id, tenant_id, recipient_guardian_id, channel, dedupe_key, body)
         values ('${n}', '${uid.tenantA}', '${uid.guardianA}', 'email', 'f10-${slug}', 'x')`,
      );
      await migrator.query(
        `insert into notification_student_contexts (id, tenant_id, notification_id, student_id) values
           ('${randomUUID()}', '${uid.tenantA}', '${n}', '${s}'),
           ('${randomUUID()}', '${uid.tenantA}', '${n}', '${uid.studentA}')`,
      );
      await migrator.query('commit');
      await migrator.query(`delete from students where id = '${s}'`);
      const c = await migQ<{ n: number }>(
        `select count(*)::int n from notification_student_contexts where notification_id = '${n}'`,
      );
      expect(Number(c[0]!.n)).toBe(1);
      await migrator.query(`delete from notifications where id = '${n}'`);
    });

    it('F11. deleting a sole-context student would orphan a guardian notification and is refused (55000)', async () => {
      const s = randomUUID();
      const link = randomUUID();
      const n = randomUUID();
      await migrator.query('begin');
      await migrator.query(
        `insert into students (id, tenant_id, student_no, first_name, last_name)
         values ('${s}', '${uid.tenantA}', 'f11-${slug}', 'Sole', 'Ctx')`,
      );
      await migrator.query(
        `insert into student_guardians (id, tenant_id, student_id, guardian_id, relation)
         values ('${link}', '${uid.tenantA}', '${s}', '${uid.guardianA}', 'guardian')`,
      );
      await migrator.query(
        `insert into notifications (id, tenant_id, recipient_guardian_id, channel, dedupe_key, body)
         values ('${n}', '${uid.tenantA}', '${uid.guardianA}', 'email', 'f11-${slug}', 'x')`,
      );
      await migrator.query(
        `insert into notification_student_contexts (id, tenant_id, notification_id, student_id)
         values ('${randomUUID()}', '${uid.tenantA}', '${n}', '${s}')`,
      );
      await migrator.query('commit');
      await migrator.query('begin');
      await migrator.query(`delete from students where id = '${s}'`);
      await expectCommitError(migrator, '55000');
      const sRow = await migQ<{ n: number }>(
        `select count(*)::int n from students where id = '${s}'`,
      );
      expect(Number(sRow[0]!.n)).toBe(1);
      await migrator.query(`delete from notifications where id = '${n}'`);
      await migrator.query(`delete from student_guardians where id = '${link}'`);
      await migrator.query(`delete from students where id = '${s}'`);
    });

    it('F12. runtime commit of a guardian notification without a context fails closed (55000)', async () => {
      const n = randomUUID();
      const tkt = await mintTicket(uid.userA!, uid.tenantA!);
      await app.query('begin');
      await app.query(`set local app.rls = '${tkt}'`);
      await app.query(
        `insert into notifications (id, tenant_id, recipient_guardian_id, channel, dedupe_key, body)
         values ('${n}', '${uid.tenantA}', '${uid.guardianA}', 'email', 'f12-${slug}', 'x')`,
      );
      const err = await expectCommitError(app, '55000');
      expect(err.message).toMatch(/valid context set/);
      const row = await migQ<{ n: number }>(
        `select count(*)::int n from notifications where id = '${n}'`,
      );
      expect(Number(row[0]!.n)).toBe(0);
    });

    it('F13. runtime commits a guarded notification with a valid context and then reads it', async () => {
      const n = randomUUID();
      const tkt = await mintTicket(uid.userA!, uid.tenantA!);
      await app.query('begin');
      await app.query(`set local app.rls = '${tkt}'`);
      await app.query(
        `insert into notifications (id, tenant_id, recipient_guardian_id, channel, dedupe_key, body)
         values ('${n}', '${uid.tenantA}', '${uid.guardianA}', 'email', 'f13-${slug}', 'x')`,
      );
      await app.query(
        `insert into notification_student_contexts (id, tenant_id, notification_id, student_id)
         values ('${randomUUID()}', '${uid.tenantA}', '${n}', '${uid.studentA}')`,
      );
      await app.query('commit');
      await tenantA(async () => {
        const seen = await appQ<{ id: string }>(`select id from notifications where id = '${n}'`);
        expect(seen.map((r) => r.id)).toEqual([n]);
      });
      await migrator.query(`delete from notifications where id = '${n}'`);
    });

    it('F14. revoking the link hides the committed notification, and restoring it restores visibility', async () => {
      const n = randomUUID();
      const tkt = await mintTicket(uid.userA!, uid.tenantA!);
      await app.query('begin');
      await app.query(`set local app.rls = '${tkt}'`);
      await app.query(
        `insert into notifications (id, tenant_id, recipient_guardian_id, channel, dedupe_key, body)
         values ('${n}', '${uid.tenantA}', '${uid.guardianA}', 'email', 'f14-${slug}', 'x')`,
      );
      await app.query(
        `insert into notification_student_contexts (id, tenant_id, notification_id, student_id)
         values ('${randomUUID()}', '${uid.tenantA}', '${n}', '${uid.studentA}')`,
      );
      await app.query('commit');
      try {
        await migrator.query(`update student_guardians set deleted_at = now() where id = '${uid.relA}'`);
        await tenantA(async () => {
          const seen = await appQ<{ id: string }>(`select id from notifications where id = '${n}'`);
          expect(seen).toHaveLength(0);
        });
      } finally {
        await migrator.query(`update student_guardians set deleted_at = null where id = '${uid.relA}'`);
      }
      await tenantA(async () => {
        const seen = await appQ<{ id: string }>(`select id from notifications where id = '${n}'`);
        expect(seen.map((r) => r.id)).toEqual([n]);
      });
      await migrator.query(`delete from notifications where id = '${n}'`);
    });

    it('F15. ALL-context: revoking one of several context links hides the whole notification', async () => {
      const n = randomUUID();
      const tkt = await mintTicket(uid.userA!, uid.tenantA!);
      await app.query('begin');
      await app.query(`set local app.rls = '${tkt}'`);
      await app.query(
        `insert into notifications (id, tenant_id, recipient_guardian_id, channel, dedupe_key, body)
         values ('${n}', '${uid.tenantA}', '${uid.guardianA}', 'email', 'f15-${slug}', 'x')`,
      );
      await app.query(
        `insert into notification_student_contexts (id, tenant_id, notification_id, student_id) values
           ('${randomUUID()}', '${uid.tenantA}', '${n}', '${uid.studentA}'),
           ('${randomUUID()}', '${uid.tenantA}', '${n}', '${uid.studentA2}')`,
      );
      await app.query('commit');
      await tenantA(async () => {
        const seen = await appQ<{ id: string }>(`select id from notifications where id = '${n}'`);
        expect(seen.map((r) => r.id)).toEqual([n]);
      });
      try {
        await migrator.query(`update student_guardians set deleted_at = now() where id = '${uid.relA2}'`);
        await tenantA(async () => {
          const seen = await appQ<{ id: string }>(`select id from notifications where id = '${n}'`);
          expect(seen).toHaveLength(0);
        });
      } finally {
        await migrator.query(`update student_guardians set deleted_at = null where id = '${uid.relA2}'`);
      }
      await migrator.query(`delete from notifications where id = '${n}'`);
    });
  });

  describe('G. announcement lifecycle + immutability (0036)', () => {
    it('G1. a draft can be published; the stamp is server-owned and write-once', async () => {
      await migratorTx(async () => {
        const a = randomUUID();
        await migrator.query(
          `insert into announcements (id, tenant_id, title, body)
           values ('${a}', '${uid.tenantA}', 'T', 'B')`,
        );
        const b = (await migQ<{ published_at: string | null }>(
          `select published_at from announcements where id = '${a}'`,
        ))[0]!;
        expect(b.published_at).toBeNull();
        await migrator.query(`update announcements set status = 'published' where id = '${a}'`);
        const after = (await migQ<{ status: string; published_at: string | null }>(
          `select status, published_at from announcements where id = '${a}'`,
        ))[0]!;
        expect(after.status).toBe('published');
        expect(after.published_at).not.toBeNull();
        await migSavepointExpectError('55000', () =>
          migrator.query(`update announcements set published_at = null where id = '${a}'`),
        );
        await migSavepointExpectError('55000', () =>
          migrator.query(`update announcements set published_at = now() + interval '1 hour' where id = '${a}'`),
        );
      });
    });

    it('G2. INSERT is draft-only (published/cancelled refused, 55000)', async () => {
      await migratorTx(async () => {
        await migSavepointExpectError('55000', () =>
          migrator.query(
            `insert into announcements (id, tenant_id, title, body, status)
             values ('${randomUUID()}', '${uid.tenantA}', 'T', 'B', 'published')`,
          ),
        );
        await migSavepointExpectError('55000', () =>
          migrator.query(
            `insert into announcements (id, tenant_id, title, body, status)
             values ('${randomUUID()}', '${uid.tenantA}', 'T', 'B', 'cancelled')`,
          ),
        );
      });
    });

    it('G3. a new announcement may not carry a publication stamp (55000)', async () => {
      await migratorTx(async () => {
        await migSavepointExpectError('55000', () =>
          migrator.query(
            `insert into announcements (id, tenant_id, title, body, published_at)
             values ('${randomUUID()}', '${uid.tenantA}', 'T', 'B', now())`,
          ),
        );
      });
    });

    it('G4. illegal status transitions are refused (55000)', async () => {
      await migratorTx(async () => {
        const a = randomUUID();
        await migrator.query(
          `insert into announcements (id, tenant_id, title, body)
           values ('${a}', '${uid.tenantA}', 'T', 'B')`,
        );
        await migrator.query(`update announcements set status = 'published' where id = '${a}'`);
        await migSavepointExpectError('55000', () =>
          migrator.query(`update announcements set status = 'draft' where id = '${a}'`),
        );
        const b = randomUUID();
        await migrator.query(
          `insert into announcements (id, tenant_id, title, body)
           values ('${b}', '${uid.tenantA}', 'T', 'B')`,
        );
        await migrator.query(`update announcements set status = 'cancelled' where id = '${b}'`);
        await migSavepointExpectError('55000', () =>
          migrator.query(`update announcements set status = 'draft' where id = '${b}'`),
        );
        await migSavepointExpectError('55000', () =>
          migrator.query(`update announcements set status = 'published' where id = '${b}'`),
        );
      });
    });

    it('G5. draft -> cancelled is allowed and leaves published_at null', async () => {
      await migratorTx(async () => {
        const a = randomUUID();
        await migrator.query(
          `insert into announcements (id, tenant_id, title, body)
           values ('${a}', '${uid.tenantA}', 'T', 'B')`,
        );
        await migrator.query(`update announcements set status = 'cancelled' where id = '${a}'`);
        const after = (await migQ<{ status: string; published_at: string | null }>(
          `select status, published_at from announcements where id = '${a}'`,
        ))[0]!;
        expect(after.status).toBe('cancelled');
        expect(after.published_at).toBeNull();
      });
    });

    it('G6. published -> cancelled preserves the publication stamp', async () => {
      await migratorTx(async () => {
        const a = randomUUID();
        await migrator.query(
          `insert into announcements (id, tenant_id, title, body)
           values ('${a}', '${uid.tenantA}', 'T', 'B')`,
        );
        await migrator.query(`update announcements set status = 'published' where id = '${a}'`);
        const t0 = (await migQ<{ published_at: string }>(
          `select published_at from announcements where id = '${a}'`,
        ))[0]!.published_at;
        await migrator.query(`update announcements set status = 'cancelled' where id = '${a}'`);
        const t1 = (await migQ<{ published_at: string | null }>(
          `select published_at from announcements where id = '${a}'`,
        ))[0]!.published_at;
        expect(t1).not.toBeNull();
        expect(new Date(t1!).getTime()).toBe(new Date(t0).getTime());
      });
    });

    it('G7. title/body/audience_scope freeze once published or cancelled (55000)', async () => {
      await migratorTx(async () => {
        const a = randomUUID();
        await migrator.query(
          `insert into announcements (id, tenant_id, title, body, audience_scope)
           values ('${a}', '${uid.tenantA}', 'T', 'B', '{"grade":5}'::jsonb)`,
        );
        await migrator.query(`update announcements set status = 'published' where id = '${a}'`);
        await migSavepointExpectError('55000', () =>
          migrator.query(`update announcements set title = 'T2' where id = '${a}'`),
        );
        await migSavepointExpectError('55000', () =>
          migrator.query(`update announcements set body = 'B2' where id = '${a}'`),
        );
        await migSavepointExpectError('55000', () =>
          migrator.query(`update announcements set audience_scope = '{"grade":6}'::jsonb where id = '${a}'`),
        );
        const b = randomUUID();
        await migrator.query(
          `insert into announcements (id, tenant_id, title, body)
           values ('${b}', '${uid.tenantA}', 'T', 'B')`,
        );
        await migrator.query(`update announcements set status = 'cancelled' where id = '${b}'`);
        await migSavepointExpectError('55000', () =>
          migrator.query(`update announcements set body = 'B2' where id = '${b}'`),
        );
      });
    });

    it('G8. audience_scope is editable while draft', async () => {
      await migratorTx(async () => {
        const a = randomUUID();
        await migrator.query(
          `insert into announcements (id, tenant_id, title, body, audience_scope)
           values ('${a}', '${uid.tenantA}', 'T', 'B', '{}'::jsonb)`,
        );
        await migrator.query(`update announcements set audience_scope = '{"grade":5}'::jsonb where id = '${a}'`);
        const v = (await migQ<{ audience_scope: Record<string, number> }>(
          `select audience_scope from announcements where id = '${a}'`,
        ))[0]!.audience_scope;
        expect(v).toEqual({ grade: 5 });
      });
    });

    it('G9. recipient_snapshot is write-once (55000 on rewrite or clear)', async () => {
      await migratorTx(async () => {
        const a = randomUUID();
        await migrator.query(
          `insert into announcements (id, tenant_id, title, body)
           values ('${a}', '${uid.tenantA}', 'T', 'B')`,
        );
        await migrator.query(`update announcements set recipient_snapshot = '{"n":1}'::jsonb where id = '${a}'`);
        await migSavepointExpectError('55000', () =>
          migrator.query(`update announcements set recipient_snapshot = '{"n":2}'::jsonb where id = '${a}'`),
        );
        await migSavepointExpectError('55000', () =>
          migrator.query(`update announcements set recipient_snapshot = null where id = '${a}'`),
        );
      });
    });

    it('G10. deleted_at is one-way and a soft delete may not change status (55000)', async () => {
      await migratorTx(async () => {
        const a = randomUUID();
        await migrator.query(
          `insert into announcements (id, tenant_id, title, body)
           values ('${a}', '${uid.tenantA}', 'T', 'B')`,
        );
        await migrator.query(`update announcements set deleted_at = now() where id = '${a}'`);
        await migSavepointExpectError('55000', () =>
          migrator.query(`update announcements set deleted_at = null where id = '${a}'`),
        );
        const b = randomUUID();
        await migrator.query(
          `insert into announcements (id, tenant_id, title, body)
           values ('${b}', '${uid.tenantA}', 'T', 'B')`,
        );
        await migSavepointExpectError('55000', () =>
          migrator.query(`update announcements set deleted_at = now(), status = 'cancelled' where id = '${b}'`),
        );
      });
    });

    it('G11. identity fields (id, tenant_id, created_at) are immutable (55000)', async () => {
      await migratorTx(async () => {
        const a = randomUUID();
        await migrator.query(
          `insert into announcements (id, tenant_id, title, body)
           values ('${a}', '${uid.tenantA}', 'T', 'B')`,
        );
        await migSavepointExpectError('55000', () =>
          migrator.query(`update announcements set id = '${randomUUID()}' where id = '${a}'`),
        );
        await migSavepointExpectError('55000', () =>
          migrator.query(`update announcements set tenant_id = '${uid.tenantB}' where id = '${a}'`),
        );
        await migSavepointExpectError('55000', () =>
          migrator.query(`update announcements set created_at = now() + interval '1 hour' where id = '${a}'`),
        );
      });
    });

    it('G12. draft DELETE is allowed; published/cancelled DELETE is refused (55000)', async () => {
      await migratorTx(async () => {
        const a = randomUUID();
        await migrator.query(
          `insert into announcements (id, tenant_id, title, body)
           values ('${a}', '${uid.tenantA}', 'T', 'B')`,
        );
        const del = await migrator.query(`delete from announcements where id = '${a}'`);
        expect(del.rowCount).toBe(1);
        const b = randomUUID();
        await migrator.query(
          `insert into announcements (id, tenant_id, title, body)
           values ('${b}', '${uid.tenantA}', 'T', 'B')`,
        );
        await migrator.query(`update announcements set status = 'published' where id = '${b}'`);
        await migSavepointExpectError('55000', () =>
          migrator.query(`delete from announcements where id = '${b}'`),
        );
        const c = randomUUID();
        await migrator.query(
          `insert into announcements (id, tenant_id, title, body)
           values ('${c}', '${uid.tenantA}', 'T', 'B')`,
        );
        await migrator.query(`update announcements set status = 'cancelled' where id = '${c}'`);
        await migSavepointExpectError('55000', () =>
          migrator.query(`delete from announcements where id = '${c}'`),
        );
      });
    });

    it('G13. runtime draft DELETE affects 0 rows (privileged-only RLS path)', async () => {
      const d = randomUUID();
      await tenantA(async () => {
        await app.query(
          `insert into announcements (id, tenant_id, title, body)
           values ('${d}', '${uid.tenantA}', 'RT', 'RB')`,
        );
        const del = await app.query(`delete from announcements where id = '${d}'`);
        expect(del.rowCount).toBe(0);
      });
    });

    it('G14. runtime publish is server-stamped and content is frozen afterwards (55000)', async () => {
      await tenantA(async () => {
        const d = randomUUID();
        await app.query(
          `insert into announcements (id, tenant_id, title, body)
           values ('${d}', '${uid.tenantA}', 'RT', 'RB')`,
        );
        await app.query(`update announcements set status = 'published' where id = '${d}'`);
        const s = (await appQ<{ status: string; published_at: string | null }>(
          `select status, published_at from announcements where id = '${d}'`,
        ))[0]!;
        expect(s.status).toBe('published');
        expect(s.published_at).not.toBeNull();
        await expectPgError(
          app.query(`update announcements set title = 'RT2' where id = '${d}'`),
          '55000',
        );
      });
    });

    it('G15. tenant cascade delete is refused while a non-draft announcement survives (55000)', async () => {
      await migratorTx(async () => {
        const t = randomUUID();
        const a = randomUUID();
        await migrator.query(
          `insert into tenants (id, slug, name) values ('${t}', '${slug}-g15', 'G15 tenant')`,
        );
        await migrator.query(
          `insert into announcements (id, tenant_id, title, body)
           values ('${a}', '${t}', 'T', 'B')`,
        );
        await migrator.query(`update announcements set status = 'published' where id = '${a}'`);
        await migSavepointExpectError('55000', () =>
          migrator.query(`delete from tenants where id = '${t}'`),
        );
        const tRow = await migQ<{ n: number }>(
          `select count(*)::int n from tenants where id = '${t}'`,
        );
        expect(Number(tRow[0]!.n)).toBe(1);
      });
    });

    it('G16. Option A: a soft-deleted published announcement may later be cancelled (separate UPDATE)', async () => {
      await migratorTx(async () => {
        const a = randomUUID();
        await migrator.query(
          `insert into announcements (id, tenant_id, title, body, audience_scope)
           values ('${a}', '${uid.tenantA}', 'T', 'B', '{"grade":5}'::jsonb)`,
        );
        await migrator.query(`update announcements set status = 'published' where id = '${a}'`);
        const published = (await migQ<{ status: string; published_at: Date; audience_scope: unknown }>(
          `select status, published_at, audience_scope from announcements where id = '${a}'`,
        ))[0]!;
        await migrator.query(
          `update announcements set deleted_at = now() where id = '${a}'`,
        );
        const softDeleted = (await migQ<{ status: string; deleted_at: string }>(
          `select status, deleted_at from announcements where id = '${a}'`,
        ))[0]!;
        expect(softDeleted.status).toBe('published');
        expect(softDeleted.deleted_at).not.toBeNull();
        await migrator.query(
          `update announcements set status = 'cancelled' where id = '${a}'`,
        );
        const final = (await migQ<{
          status: string;
          deleted_at: string;
          title: string;
          body: string;
          audience_scope: unknown;
          published_at: Date;
        }>(
          `select status, deleted_at, title, body, audience_scope, published_at
             from announcements where id = '${a}'`,
        ))[0]!;
        expect(final.status).toBe('cancelled');
        expect(final.deleted_at).not.toBeNull();
        expect(final.title).toBe('T');
        expect(final.body).toBe('B');
        expect(final.audience_scope).toEqual({ grade: 5 });
        expect(final.published_at.toISOString()).toBe(published.published_at.toISOString());
        await migSavepointExpectError('55000', () =>
          migrator.query(`update announcements set deleted_at = null where id = '${a}'`),
        );
        await migSavepointExpectError('55000', () =>
          migrator.query(`update announcements set deleted_at = now() + interval '1 hour' where id = '${a}'`),
        );
        await migSavepointExpectError('55000', () =>
          migrator.query(`update announcements set title = 'T2' where id = '${a}'`),
        );
        await migSavepointExpectError('55000', () =>
          migrator.query(`update announcements set body = 'B2' where id = '${a}'`),
        );
        await migSavepointExpectError('55000', () =>
          migrator.query(`update announcements set audience_scope = '{"grade":6}'::jsonb where id = '${a}'`),
        );
      });
    });
  });

  describe('H. concurrency gates (0035 deferred-constraint serialization)', () => {
    let c1: pg.Client;
    let c2: pg.Client;

    beforeAll(async () => {
      const env = getEnv();
      c1 = new pg.Client({ connectionString: env.DATABASE_URL_MIGRATOR });
      c2 = new pg.Client({ connectionString: env.DATABASE_URL_MIGRATOR });
      await c1.connect();
      await c2.connect();
      // Bound every lock wait so a design defect surfaces as 55P03, never a hang.
      for (const c of [c1, c2]) {
        await c.query(`set lock_timeout = '3s'`);
        await c.query(`set statement_timeout = '10s'`);
      }
    });

    afterAll(async () => {
      await c1.end().catch(() => {});
      await c2.end().catch(() => {});
    });

    it('H1. two concurrent removals of the last two contexts cannot both commit', async () => {
      const n = randomUUID();
      const ca = randomUUID();
      const cb = randomUUID();
      await migrator.query('begin');
      await migrator.query(
        `insert into notifications (id, tenant_id, recipient_guardian_id, channel, dedupe_key, body)
         values ('${n}', '${uid.tenantA}', '${uid.guardianA}', 'email', 'h1-${slug}', 'x')`,
      );
      await migrator.query(
        `insert into notification_student_contexts (id, tenant_id, notification_id, student_id) values
           ('${ca}', '${uid.tenantA}', '${n}', '${uid.studentA}'),
           ('${cb}', '${uid.tenantA}', '${n}', '${uid.studentA2}')`,
      );
      await migrator.query('commit');

      await c1.query('begin');
      await c2.query('begin');
      await c1.query(`delete from notification_student_contexts where id = '${ca}'`);
      await c2.query(`delete from notification_student_contexts where id = '${cb}'`);
      const [r1, r2] = await Promise.allSettled([c1.query('commit'), c2.query('commit')]);
      await c1.query('rollback').catch(() => {});
      await c2.query('rollback').catch(() => {});
      const outcomes = [r1, r2].map((r) =>
        r.status === 'fulfilled' ? 'ok' : (r.reason as pg.DatabaseError).code,
      );
      await c1.query(`select 1`).catch(() => {}); // ensure idle
      const fin = await migQ<{ n: number }>(
        `select count(*)::int n from notification_student_contexts where notification_id = '${n}'`,
      );
      console.log('[H1] commit outcomes:', outcomes.join(', '), '| final committed contexts:', fin[0]!.n);
      await migrator.query(`delete from notifications where id = '${n}'`);
      expect(outcomes.filter((o) => o === 'ok').length).toBe(1);
      expect(outcomes.filter((o) => o !== 'ok')).toEqual(['55000']);
      expect(Number(fin[0]!.n)).toBe(1);
    });

    it('H2. concurrent mirrored reassignment of two multi-context notifications commits validly', async () => {
      const n1 = randomUUID();
      const n2 = randomUUID();
      const a1 = randomUUID();
      const b1 = randomUUID();
      const a2 = randomUUID();
      const b2 = randomUUID();
      const s9 = randomUUID();
      const rel9 = randomUUID();
      const s10 = randomUUID();
      const rel10 = randomUUID();
      await migrator.query('begin');
      await migrator.query(
        `insert into students (id, tenant_id, student_no, first_name, last_name) values
           ('${s9}', '${uid.tenantA}', 'h2-s9-${slug}', 'Move', 'Nine'),
           ('${s10}', '${uid.tenantA}', 'h2-s10-${slug}', 'Move', 'Ten')`,
      );
      await migrator.query(
        `insert into student_guardians (id, tenant_id, student_id, guardian_id, relation) values
           ('${rel9}', '${uid.tenantA}', '${s9}', '${uid.guardianA}', 'guardian'),
           ('${rel10}', '${uid.tenantA}', '${s10}', '${uid.guardianA}', 'guardian')`,
      );
      await migrator.query(
        `insert into notifications (id, tenant_id, recipient_guardian_id, channel, dedupe_key, body) values
           ('${n1}', '${uid.tenantA}', '${uid.guardianA}', 'email', 'h2a-${slug}', 'x'),
           ('${n2}', '${uid.tenantA}', '${uid.guardianA}', 'email', 'h2b-${slug}', 'x')`,
      );
      await migrator.query(
        `insert into notification_student_contexts (id, tenant_id, notification_id, student_id) values
           ('${a1}', '${uid.tenantA}', '${n1}', '${s9}'),
           ('${b1}', '${uid.tenantA}', '${n1}', '${s10}'),
           ('${a2}', '${uid.tenantA}', '${n2}', '${uid.studentA}'),
           ('${b2}', '${uid.tenantA}', '${n2}', '${uid.studentA2}')`,
      );
      await migrator.query('commit');

      await c1.query('begin');
      await c2.query('begin');
      await c1.query(`update notification_student_contexts set notification_id = '${n2}' where id = '${a1}'`);
      await c2.query(`update notification_student_contexts set notification_id = '${n1}' where id = '${a2}'`);
      const [r1, r2] = await Promise.allSettled([c1.query('commit'), c2.query('commit')]);
      await c1.query('rollback').catch(() => {});
      await c2.query('rollback').catch(() => {});
      const outcomes = [r1, r2].map((r) =>
        r.status === 'fulfilled' ? 'ok' : (r.reason as pg.DatabaseError).code,
      );
      const cnt1 = Number((await migQ<{ n: number }>(
        `select count(*)::int n from notification_student_contexts where notification_id = '${n1}'`,
      ))[0]!.n);
      const cnt2 = Number((await migQ<{ n: number }>(
        `select count(*)::int n from notification_student_contexts where notification_id = '${n2}'`,
      ))[0]!.n);
      console.log(
        '[H2] mirrored reassignment outcomes:', outcomes.join(', '),
        '| final n1/n2 contexts:', cnt1, cnt2,
      );
      await migrator.query(`delete from notifications where id in ('${n1}','${n2}')`);
      await migrator.query(`delete from student_guardians where id in ('${rel9}','${rel10}')`);
      await migrator.query(`delete from students where id in ('${s9}','${s10}')`);
      // Invariant: neither notification may be left contextless.
      expect(cnt1).toBeGreaterThanOrEqual(1);
      expect(cnt2).toBeGreaterThanOrEqual(1);
      // Intended: canonical parent locking serializes both moves to success.
      // A surfaced lock error (55P03) or deadlock (40P01) fails this on purpose.
      expect(outcomes.filter((o) => o === 'ok').length).toBe(2);
    });

    it('H3a. a guardian notification cannot commit after the revocation commits (55000)', async () => {
      const n = randomUUID();
      try {
        await migrator.query(`update student_guardians set deleted_at = now() where id = '${uid.relA}'`);
        await migrator.query('begin');
        await migrator.query(
          `insert into notifications (id, tenant_id, recipient_guardian_id, channel, dedupe_key, body)
           values ('${n}', '${uid.tenantA}', '${uid.guardianA}', 'email', 'h3a-${slug}', 'x')`,
        );
        await migrator.query(
          `insert into notification_student_contexts (id, tenant_id, notification_id, student_id)
           values ('${randomUUID()}', '${uid.tenantA}', '${n}', '${uid.studentA}')`,
        );
        await expectCommitError(migrator, '55000');
      } finally {
        await migrator.query(`update student_guardians set deleted_at = null where id = '${uid.relA}'`);
      }
      const row = await migQ<{ n: number }>(
        `select count(*)::int n from notifications where id = '${n}'`,
      );
      expect(Number(row[0]!.n)).toBe(0);
    });

    it('H3b. a notification committed before revocation survives but becomes hidden (both commit orders)', async () => {
      const n = randomUUID();
      const tkt = await mintTicket(uid.userA!, uid.tenantA!);
      await app.query('begin');
      await app.query(`set local app.rls = '${tkt}'`);
      await app.query(
        `insert into notifications (id, tenant_id, recipient_guardian_id, channel, dedupe_key, body)
         values ('${n}', '${uid.tenantA}', '${uid.guardianA}', 'email', 'h3b-${slug}', 'x')`,
      );
      await app.query(
        `insert into notification_student_contexts (id, tenant_id, notification_id, student_id)
         values ('${randomUUID()}', '${uid.tenantA}', '${n}', '${uid.studentA}')`,
      );
      await app.query('commit');
      try {
        await migrator.query(`update student_guardians set deleted_at = now() where id = '${uid.relA}'`);
        await tenantA(async () => {
          const seen = await appQ<{ id: string }>(`select id from notifications where id = '${n}'`);
          expect(seen).toHaveLength(0);
        });
      } finally {
        await migrator.query(`update student_guardians set deleted_at = null where id = '${uid.relA}'`);
      }
      const row = await migQ<{ n: number }>(
        `select count(*)::int n from notifications where id = '${n}'`,
      );
      expect(Number(row[0]!.n)).toBe(1);
      await migrator.query(`delete from notifications where id = '${n}'`);
    });
  });
});
