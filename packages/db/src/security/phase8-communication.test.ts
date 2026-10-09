import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { getEnv } from '@sms/config';

/**
 * Phase 8 communication foundation DB security+integrity proofs, run against the
 * REAL roles and REAL disposable test database (school_app_rw -> school_saas_test).
 * Requires migration 0030.
 *
 * Section A (row-level security): all eight new tables are FORCE RLS; a bare
 * app_rw session sees nothing; a signed tenant context sees exactly its own rows
 * and can neither write nor hard-delete rows of a foreign tenant; the runtime
 * role has no DELETE path.
 * Section B (recipient-scoped reads, C-2): a user sees only notifications
 * addressed to them or to a student/guardian they are linked to.
 * Section C (integrity): C-1 exactly-one-recipient, C-4 tenant-bound recipient
 * FKs, nullable template_id + ON DELETE SET NULL, TMPL-1 system/tenant shape.
 * Section D (consent/quota seams): channel-wide preference uniqueness, quota
 * counter uniqueness and tenant isolation.
 *
 * Opt-in: RUN_RUNTIME_SECURITY_TESTS=1 (requires PostgreSQL + migrations 0001..0030).
 */
const enabled = process.env.RUN_RUNTIME_SECURITY_TESTS === '1';
const describeDb = enabled ? describe : describe.skip;

const TABLES = [
  'notification_templates',
  'notifications',
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

  beforeAll(async () => {
    const env = getEnv();
    migrator = new pg.Client({ connectionString: env.DATABASE_URL_MIGRATOR });
    app = new pg.Client({ connectionString: env.DATABASE_URL_APP });
    await migrator.connect();
    await app.connect();

    for (const k of [
      'userA', 'userA2', 'userB', 'tenantA', 'tenantB', 'studentA', 'studentB',
      'guardianA', 'guardianB', 'relA', 'relB', 'sysTpl', 'tplA', 'tplB',
      'noteUser', 'noteStudent', 'noteGuardian', 'noteOther', 'annA', 'annB',
      'threadA', 'threadB', 'msgA', 'msgB', 'prefA', 'prefB', 'quotaA', 'quotaB',
    ]) {
      uid[k] = randomUUID();
    }

    await migrator.query('begin');
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
    await migrator.query(
      `insert into announcements (id, tenant_id, title, body, status, published_at) values
         ('${uid.annA}', '${uid.tenantA}', 'A notice', 'A body', 'published', now()),
         ('${uid.annB}', '${uid.tenantB}', 'B notice', 'B body', 'published', now())`,
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

  describe('A. row-level security boundary', () => {
    it('1. RLS is enabled AND forced on all eight new tables', async () => {
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

    it('2. all eight new tables are registered in this isolation suite', async () => {
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
});
