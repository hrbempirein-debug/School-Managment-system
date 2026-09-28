import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { getEnv } from '@sms/config';

/**
 * Phase 2B.3 school-domain DB security + integrity proofs, run against the REAL
 * roles and REAL disposable test database (school_app_rw -> school_saas_test). Requires
 * migration 0004.
 *
 * Section A (row-level security): all eight new tables are FORCE RLS; a bare
 * app_rw session sees nothing; a signed tenant context sees exactly its own
 * rows and can neither write nor update rows of a foreign tenant; composite
 * tenant-aware FKs (terms->years, events->calendars, holidays->campuses) reject
 * cross-tenant parents; the runtime role has no DELETE path.
 *
 * Section B (domain constraints): date-range checks, tenant-local unique codes
 * and term sequences, year/term lifecycle transitions, close-with-open-terms,
 * open-term-inside-closed-year, overlapping open terms, term dates outside the
 * year, event time ordering, holiday date ordering and the settings singleton.
 *
 * Opt-in: RUN_RUNTIME_SECURITY_TESTS=1 (requires PostgreSQL + migrations 0001..0004).
 */
const enabled = process.env.RUN_RUNTIME_SECURITY_TESTS === '1';
const describeDb = enabled ? describe : describe.skip;

const TABLES = [
  'campuses',
  'academic_years',
  'academic_terms',
  'holidays',
  'calendars',
  'calendar_events',
  'departments',
  'school_settings',
];

describeDb('school domain RLS + constraints (campuses/…/settings on school_saas_test)', () => {
  let migrator: pg.Client;
  let app: pg.Client;
  const uid: Record<string, string> = {};
  const slug = 'sd' + randomUUID().slice(0, 8);

  const appQ = <T extends pg.QueryResultRow = pg.QueryResultRow>(
    sqlText: string,
  ): Promise<T[]> => app.query<T>(sqlText).then((r) => r.rows);
  const migQ = <T extends pg.QueryResultRow = pg.QueryResultRow>(
    sqlText: string,
  ): Promise<T[]> => migrator.query<T>(sqlText).then((r) => r.rows);

  /**
   * Runs fn inside a savepoint and rolls the savepoint back afterwards, so a
   * raised error (which aborts the enclosing transaction at statement level)
   * does not poison subsequent assertions in the same tenantA() session.
   */
  const rejectCode = async (
    fn: () => Promise<unknown>,
    code: string,
    pattern?: RegExp,
  ): Promise<void> => {
    await app.query('savepoint sp');
    const caught = await fn().catch((err: pg.DatabaseError) => err);
    await app.query('rollback to savepoint sp');
    expect(caught).toBeInstanceOf(Error);
    expect((caught as pg.DatabaseError).code).toBe(code);
    if (pattern) expect((caught as Error).message).toMatch(pattern);
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

    uid.userA = randomUUID();
    uid.userB = randomUUID();
    uid.tenantA = randomUUID();
    uid.tenantB = randomUUID();
    uid.campusA = randomUUID();
    uid.campusB = randomUUID();
    uid.yearA1 = randomUUID();
    uid.yearA2 = randomUUID();
    uid.yearB = randomUUID();
    uid.termA1 = randomUUID();
    uid.termA2 = randomUUID();
    uid.termB = randomUUID();
    uid.calendarA = randomUUID();
    uid.calendarB = randomUUID();
    uid.eventA = randomUUID();
    uid.eventB = randomUUID();
    uid.holidayA = randomUUID();
    uid.holidayB = randomUUID();
    uid.deptA = randomUUID();
    uid.deptB = randomUUID();
    uid.settingsA = randomUUID();
    uid.settingsB = randomUUID();

    await migrator.query('begin');
    await migrator.query(
      `insert into tenants (id, slug, name) values
         ('${uid.tenantA}', '${slug}-a', 'School Domain A'),
         ('${uid.tenantB}', '${slug}-b', 'School Domain B')`,
    );
    await migrator.query(
      `insert into users (id, email) values
         ('${uid.userA}', 'sd-a-${slug}@example.com'),
         ('${uid.userB}', 'sd-b-${slug}@example.com')`,
    );
    await migrator.query(
      `insert into memberships (id, tenant_id, user_id, status) values
         ('${randomUUID()}', '${uid.tenantA}', '${uid.userA}', 'active'),
         ('${randomUUID()}', '${uid.tenantB}', '${uid.userB}', 'active')`,
    );
    // Campuses (before holidays reference them via the composite FK).
    await migrator.query(
      `insert into campuses (id, tenant_id, code, name, status) values
         ('${uid.campusA}', '${uid.tenantA}', 'ca-${slug}', 'Campus A', 'active'),
         ('${uid.campusB}', '${uid.tenantB}', 'cb-${slug}', 'Campus B', 'active')`,
    );
    // Academic years.
    await migrator.query(
      `insert into academic_years (id, tenant_id, code, name, starts_on, ends_on, status) values
         ('${uid.yearA1}', '${uid.tenantA}', 'ya1-${slug}', 'AY 2026 A', '2026-01-01', '2026-12-31', 'active'),
         ('${uid.yearA2}', '${uid.tenantA}', 'ya2-${slug}', 'AY 2027 A', '2027-01-01', '2027-12-31', 'draft'),
         ('${uid.yearB}', '${uid.tenantB}', 'yb-${slug}', 'AY 2026 B', '2026-01-01', '2026-12-31', 'active')`,
    );
    // Terms: A1 open inside the active year, A2 draft, B open.
    await migrator.query(
      `insert into academic_terms (id, tenant_id, academic_year_id, code, name, sequence, starts_on, ends_on, status) values
         ('${uid.termA1}', '${uid.tenantA}', '${uid.yearA1}', 'ta1-${slug}', 'Term 1 A', 1, '2026-02-01', '2026-06-30', 'open'),
         ('${uid.termA2}', '${uid.tenantA}', '${uid.yearA2}', 'ta2-${slug}', 'Term 2 A', 1, '2027-02-01', '2027-06-30', 'draft'),
         ('${uid.termB}', '${uid.tenantB}', '${uid.yearB}', 'tb-${slug}', 'Term B', 1, '2026-02-01', '2026-06-30', 'open')`,
    );
    // Calendars.
    await migrator.query(
      `insert into calendars (id, tenant_id, code, name, type, status) values
         ('${uid.calendarA}', '${uid.tenantA}', 'cal-a-${slug}', 'Calendar A', 'general', 'active'),
         ('${uid.calendarB}', '${uid.tenantB}', 'cal-b-${slug}', 'Calendar B', 'general', 'active')`,
    );
    // Calendar events.
    await migrator.query(
      `insert into calendar_events (id, tenant_id, calendar_id, title, starts_at, ends_at) values
         ('${uid.eventA}', '${uid.tenantA}', '${uid.calendarA}', 'Event A', '2026-03-01T10:00:00Z', '2026-03-01T11:00:00Z'),
         ('${uid.eventB}', '${uid.tenantB}', '${uid.calendarB}', 'Event B', '2026-03-01T10:00:00Z', '2026-03-01T11:00:00Z')`,
    );
    // Holidays (campus-bound via composite FK).
    await migrator.query(
      `insert into holidays (id, tenant_id, campus_id, name, starts_on, ends_on) values
         ('${uid.holidayA}', '${uid.tenantA}', '${uid.campusA}', 'Holiday A', '2026-04-01', '2026-04-02'),
         ('${uid.holidayB}', '${uid.tenantB}', '${uid.campusB}', 'Holiday B', '2026-04-01', '2026-04-02')`,
    );
    // Departments.
    await migrator.query(
      `insert into departments (id, tenant_id, code, name, status) values
         ('${uid.deptA}', '${uid.tenantA}', 'dp-a-${slug}', 'Dept A', 'active'),
         ('${uid.deptB}', '${uid.tenantB}', 'dp-b-${slug}', 'Dept B', 'active')`,
    );
    // Settings singleton.
    await migrator.query(
      `insert into school_settings (id, tenant_id, school_name) values
         ('${uid.settingsA}', '${uid.tenantA}', 'School A'),
         ('${uid.settingsB}', '${uid.tenantB}', 'School B')`,
    );
    await migrator.query('commit');
  });

  afterAll(async () => {
    try {
      await migrator.query('begin');
      const tenantIds = `'${uid.tenantA}','${uid.tenantB}'`;
      await migrator.query(
        `delete from calendar_events where tenant_id in (${tenantIds})`,
      );
      await migrator.query(`delete from holidays where tenant_id in (${tenantIds})`);
      await migrator.query(`delete from academic_terms where tenant_id in (${tenantIds})`);
      await migrator.query(`delete from academic_years where tenant_id in (${tenantIds})`);
      await migrator.query(`delete from calendars where tenant_id in (${tenantIds})`);
      await migrator.query(`delete from departments where tenant_id in (${tenantIds})`);
      await migrator.query(`delete from school_settings where tenant_id in (${tenantIds})`);
      await migrator.query(`delete from campuses where tenant_id in (${tenantIds})`);
      await migrator.query(`delete from memberships where tenant_id in (${tenantIds})`);
      await migrator.query(`delete from users where id in ('${uid.userA}','${uid.userB}')`);
      // audit_logs is append-only by design (0001: INSERT + SELECT policies only - no
      // DELETE policy even for the privileged migrator role), so residue accumulates by
      // design; scoped count assertions are RLS-isolated. outbox_events IS removed below.
      await migrator.query(`delete from outbox_events where tenant_id in (${tenantIds})`);
      await migrator.query(`delete from tenants where id in (${tenantIds})`);
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
      const r = res.rows;
      expect(r).toHaveLength(TABLES.length);
      for (const row of r) {
        expect(row.rls).toBe(true);
        expect(row.force).toBe(true);
      }
    });

    it('2. school_app_rw has DML grants but sees zero rows without a context', async () => {
      const grants = await migQ<{ s: boolean; i: boolean; u: boolean; d: boolean }>(`
        select has_table_privilege('school_app_rw', 'campuses', 'SELECT') s,
               has_table_privilege('school_app_rw', 'campuses', 'INSERT') i,
               has_table_privilege('school_app_rw', 'campuses', 'UPDATE') u,
               has_table_privilege('school_app_rw', 'campuses', 'DELETE') d`);
      expect(grants[0]).toEqual({ s: true, i: true, u: true, d: true });
      for (const t of TABLES) {
        const r = await appQ<{ n: number }>(
          `select count(*)::int n from "${t}"`,
        );
        expect(Number(r[0]!.n), t).toBe(0);
      }
    });

    it('3. tenant A context sees exactly its own rows, never tenant B', async () => {
      await tenantA(async () => {
        const own: Array<{ tbl: string; n: number }> = [];
        const foreign: Array<{ tbl: string; n: number }> = [];
        for (const t of TABLES) {
          const o = (await appQ<{ n: number }>(
            `select count(*)::int n from "${t}" where tenant_id = '${uid.tenantA}'`,
          ))[0]!.n;
          const f = (await appQ<{ n: number }>(
            `select count(*)::int n from "${t}" where tenant_id = '${uid.tenantB}'`,
          ))[0]!.n;
          own.push({ tbl: t, n: Number(o) });
          foreign.push({ tbl: t, n: Number(f) });
        }
        for (const row of own) {
          expect(row.n, row.tbl).toBeGreaterThan(0);
        }
        for (const row of foreign) {
          expect(row.n, row.tbl).toBe(0);
        }
      });
    });

    it('4. cross-tenant INSERT is rejected for every new table', async () => {
      await tenantA(async () => {
        const inserts: Record<string, string> = {
          campuses: `insert into campuses (id, tenant_id, code, name, status)
                      values ('${randomUUID()}', '${uid.tenantB}', 'x-${slug}', 'X', 'active')`,
          academic_years: `insert into academic_years (id, tenant_id, code, name, starts_on, ends_on)
                            values ('${randomUUID()}', '${uid.tenantB}', 'xy-${slug}', 'X', '2026-01-01', '2026-12-31')`,
          academic_terms: `insert into academic_terms (id, tenant_id, academic_year_id, code, name, sequence, starts_on, ends_on)
                            values ('${randomUUID()}', '${uid.tenantB}', '${uid.yearB}', 'xt-${slug}', 'X', 70, '2026-03-01', '2026-04-01')`,
          holidays: `insert into holidays (id, tenant_id, campus_id, name, starts_on, ends_on)
                     values ('${randomUUID()}', '${uid.tenantB}', '${uid.campusB}', 'X', '2026-05-01', '2026-05-02')`,
          calendars: `insert into calendars (id, tenant_id, code, name, type, status)
                      values ('${randomUUID()}', '${uid.tenantB}', 'xc-${slug}', 'X', 'general', 'active')`,
          calendar_events: `insert into calendar_events (id, tenant_id, calendar_id, title, starts_at, ends_at)
                            values ('${randomUUID()}', '${uid.tenantB}', '${uid.calendarB}', 'X', '2026-03-01T10:00:00Z', '2026-03-01T11:00:00Z')`,
          departments: `insert into departments (id, tenant_id, code, name, status)
                         values ('${randomUUID()}', '${uid.tenantB}', 'xd-${slug}', 'X', 'active')`,
          school_settings: `insert into school_settings (id, tenant_id, school_name)
                             values ('${randomUUID()}', '${uid.tenantB}', 'X')`,
        };
        // Parent-anchored tables reject via the RLS WITH CHECK (42501). The
        // academic_terms BEFORE INSERT trigger validates its year through an
        // RLS-filtered lookup, so a foreign year surfaces as 23503 instead -
        // either way the row is never written.
        const expected: Record<string, string> = {
          campuses: '42501',
          academic_years: '42501',
          academic_terms: '23503',
          holidays: '42501',
          calendars: '42501',
          calendar_events: '42501',
          departments: '42501',
          school_settings: '42501',
        };
        for (const t of TABLES) {
          await rejectCode(() => app.query(inserts[t]!), expected[t]!);
        }
      });
    });

    it('5. cross-tenant UPDATE changes nothing; no tenant_id rewrite', async () => {
      await tenantA(async () => {
        const upd = await app.query(
          `update academic_years set name = 'owned' where tenant_id = '${uid.tenantB}'`,
        );
        expect(upd.rowCount).toBe(0);
        await rejectCode(
          () =>
            app.query(
              `insert into campuses (id, tenant_id, code, name, status)
               values ('${randomUUID()}', '${uid.tenantA}', 'rewrite-${slug}', 'Own', 'active')`,
            ).then(() =>
              app.query(
                `update campuses set tenant_id = '${uid.tenantB}' where code = 'rewrite-${slug}'`,
              ),
            ),
          '42501',
        );
      });
    });

    it('6. the runtime role has no DELETE path (privileged-only policy)', async () => {
      await tenantA(async () => {
        for (const t of TABLES) {
          // Own visible row: the FORCE RLS DELETE policy is privileged-only, so
          // even a tenant's own row is not deletable by app_rw.
          const del = await app.query(`delete from "${t}" where tenant_id = '${uid.tenantA}'`);
          expect(del.rowCount, t).toBe(0);
        }
      });
    });

    it('7. cross-tenant composite FK parents are rejected (terms/events/holidays)', async () => {
      await tenantA(async () => {
        await rejectCode(
          () =>
            app.query(
              `insert into academic_terms (id, tenant_id, academic_year_id, code, name, sequence, starts_on, ends_on)
               values ('${randomUUID()}', '${uid.tenantA}', '${uid.yearB}', 'xff-${slug}', 'X', 99, '2026-03-01', '2026-04-01')`,
            ),
          '23503',
        );
        await rejectCode(
          () =>
            app.query(
              `insert into calendar_events (id, tenant_id, calendar_id, title, starts_at, ends_at)
               values ('${randomUUID()}', '${uid.tenantA}', '${uid.calendarB}', 'X', '2026-03-01T10:00:00Z', '2026-03-01T11:00:00Z')`,
            ),
          '23503',
        );
        await rejectCode(
          () =>
            app.query(
              `insert into holidays (id, tenant_id, campus_id, name, starts_on, ends_on)
               values ('${randomUUID()}', '${uid.tenantA}', '${uid.campusB}', 'X', '2026-05-01', '2026-05-02')`,
            ),
          '23503',
        );
      });
    });

    it('8. legacy forgeable GUCs grant nothing on the new tables', async () => {
      await app.query('begin');
      await app.query(`select set_config('app.platform_access', 'on', true)`);
      await app.query(`select set_config('app.current_tenant', '${uid.tenantA}', true)`);
      await app.query(`select set_config('app.current_user', '${uid.userA}', true)`);
      const r = await appQ<{ n: number }>(
        `select count(*)::int n from campuses`,
      );
      await app.query('rollback');
      expect(Number(r[0]!.n)).toBe(0);
    });

    it('9. positive control: tenant A can create its own campus row', async () => {
      await tenantA(async () => {
        const ins = await app.query(
          `insert into campuses (id, tenant_id, code, name, status)
           values ('${randomUUID()}', '${uid.tenantA}', 'pos-${slug}', 'Positive', 'active')`,
        );
        const seen = await appQ<{ n: number }>(
          `select count(*)::int n from campuses where code = 'pos-${slug}'`,
        );
        expect(ins.rowCount).toBe(1);
        expect(Number(seen[0]!.n)).toBe(1);
      });
    });

    it('9a. nested-query isolation: children of a FOREIGN parent are invisible (API-style parent-scoped select)', async () => {
      await tenantA(async () => {
        // These mirror the API nested getters exactly (WHERE parent_id = X, no
        // tenant_id predicate): RLS must hide tenant B's children just as if the
        // parent did not exist, so the API can safely 404.
        const termsOfB = await appQ<{ n: number }>(
          `select count(*)::int n from academic_terms where academic_year_id = '${uid.yearB}'`,
        );
        const eventsOfB = await appQ<{ n: number }>(
          `select count(*)::int n from calendar_events where calendar_id = '${uid.calendarB}'`,
        );
        const holidaysOfB = await appQ<{ n: number }>(
          `select count(*)::int n from holidays where campus_id = '${uid.campusB}'`,
        );
        expect(Number(termsOfB[0]!.n)).toBe(0);
        expect(Number(eventsOfB[0]!.n)).toBe(0);
        expect(Number(holidaysOfB[0]!.n)).toBe(0);

        // Positive controls: the same parent-scoped queries see tenant A's own children.
        const termsOfA = await appQ<{ n: number }>(
          `select count(*)::int n from academic_terms where academic_year_id = '${uid.yearA1}'`,
        );
        const eventsOfA = await appQ<{ n: number }>(
          `select count(*)::int n from calendar_events where calendar_id = '${uid.calendarA}'`,
        );
        const holidaysOfA = await appQ<{ n: number }>(
          `select count(*)::int n from holidays where campus_id = '${uid.campusA}'`,
        );
        expect(Number(termsOfA[0]!.n)).toBeGreaterThan(0);
        expect(Number(eventsOfA[0]!.n)).toBeGreaterThan(0);
        expect(Number(holidaysOfA[0]!.n)).toBeGreaterThan(0);
      });
    });
  });

  describe('B. domain constraints', () => {
    it('10. academic year requires starts_on < ends_on', async () => {
      await tenantA(async () => {
        await rejectCode(
          () =>
            app.query(
              `insert into academic_years (id, tenant_id, code, name, starts_on, ends_on)
               values ('${randomUUID()}', '${uid.tenantA}', 'bad-${slug}', 'Bad', '2026-12-31', '2026-01-01')`,
            ),
          '23514',
        );
      });
    });

    it('11. tenant-local unique codes block duplicates (campus/year/term/calendar/department)', async () => {
      await tenantA(async () => {
        await rejectCode(
          () =>
            app.query(
              `insert into campuses (id, tenant_id, code, name, status)
               values ('${randomUUID()}', '${uid.tenantA}', 'ca-${slug}', 'Dup', 'active')`,
            ),
          '23505',
        );
        await rejectCode(
          () =>
            app.query(
              `insert into academic_years (id, tenant_id, code, name, starts_on, ends_on)
               values ('${randomUUID()}', '${uid.tenantA}', 'ya1-${slug}', 'Dup', '2028-01-01', '2028-12-31')`,
            ),
          '23505',
        );
        await rejectCode(
          () =>
            app.query(
              `insert into academic_terms (id, tenant_id, academic_year_id, code, name, sequence, starts_on, ends_on)
               values ('${randomUUID()}', '${uid.tenantA}', '${uid.yearA1}', 'ta1-${slug}', 'Dup', 9, '2026-07-01', '2026-08-01')`,
            ),
          '23505',
        );
        await rejectCode(
          () =>
            app.query(
              `insert into calendars (id, tenant_id, code, name, type, status)
               values ('${randomUUID()}', '${uid.tenantA}', 'cal-a-${slug}', 'Dup', 'general', 'active')`,
            ),
          '23505',
        );
        await rejectCode(
          () =>
            app.query(
              `insert into departments (id, tenant_id, code, name, status)
               values ('${randomUUID()}', '${uid.tenantA}', 'dp-a-${slug}', 'Dup', 'active')`,
            ),
          '23505',
        );
      });
    });

    it('12. duplicate term sequence within the same year is rejected', async () => {
      await tenantA(async () => {
        await rejectCode(
          () =>
            app.query(
              `insert into academic_terms (id, tenant_id, academic_year_id, code, name, sequence, starts_on, ends_on)
               values ('${randomUUID()}', '${uid.tenantA}', '${uid.yearA1}', 'seqdup-${slug}', 'DupSeq', 1, '2026-09-01', '2026-10-01')`,
            ),
          '23505',
        );
      });
    });

    it('13. term dates must fall inside the academic year', async () => {
      await tenantA(async () => {
        await rejectCode(
          () =>
            app.query(
              `insert into academic_terms (id, tenant_id, academic_year_id, code, name, sequence, starts_on, ends_on)
               values ('${randomUUID()}', '${uid.tenantA}', '${uid.yearA1}', 'outside-${slug}', 'Outside', 40, '2025-02-01', '2026-06-30')`,
            ),
          '55000',
          /term dates must fall inside the academic year/,
        );
      });
    });

    it('14. overlapping open terms within a year are rejected', async () => {
      await tenantA(async () => {
        await rejectCode(
          () =>
            app.query(
              `insert into academic_terms (id, tenant_id, academic_year_id, code, name, sequence, starts_on, ends_on, status)
               values ('${randomUUID()}', '${uid.tenantA}', '${uid.yearA1}', 'overlap-${slug}', 'Overlap', 50, '2026-05-01', '2026-07-15', 'open')`,
            ),
          '55000',
          /overlapping open terms within academic year/,
        );
      });
    });

    it('15. non-overlapping open terms in the same year are fine', async () => {
      await tenantA(async () => {
        const ins = await app.query(
          `insert into academic_terms (id, tenant_id, academic_year_id, code, name, sequence, starts_on, ends_on, status)
           values ('${randomUUID()}', '${uid.tenantA}', '${uid.yearA1}', 'adjacent-${slug}', 'Adjacent', 60, '2026-07-01', '2026-08-31', 'open')`,
        );
        expect(ins.rowCount).toBe(1);
      });
    });

    it('16. invalid year transitions: active->draft and closed->active rejected', async () => {
      await tenantA(async () => {
        await rejectCode(
          () =>
            app.query(
              `update academic_years set status = 'draft' where id = '${uid.yearA1}'`,
            ),
          '55000',
          /invalid academic year status transition/,
        );
        // draft -> closed is legal; then closed -> active is not.
        await app.query(
          `update academic_years set status = 'closed' where id = '${uid.yearA2}'`,
        );
        await rejectCode(
          () =>
            app.query(
              `update academic_years set status = 'active' where id = '${uid.yearA2}'`,
            ),
          '55000',
          /invalid academic year status transition/,
        );
      });
    });

    it('17. closing a year with an open term is rejected', async () => {
      await tenantA(async () => {
        await rejectCode(
          () =>
            app.query(
              `update academic_years set status = 'closed' where id = '${uid.yearA1}'`,
            ),
          '55000',
          /cannot close academic year with open terms/,
        );
      });
    });

    it('18. opening a term inside a closed year is rejected', async () => {
      await tenantA(async () => {
        await app.query(
          `update academic_years set status = 'closed' where id = '${uid.yearA2}'`,
        );
        await rejectCode(
          () =>
            app.query(
              `update academic_terms set status = 'open' where id = '${uid.termA2}'`,
            ),
          '55000',
          /cannot open a term inside a closed academic year/,
        );
      });
    });

    it('19. calendar event requires ends_at > starts_at', async () => {
      await tenantA(async () => {
        await rejectCode(
          () =>
            app.query(
              `insert into calendar_events (id, tenant_id, calendar_id, title, starts_at, ends_at)
               values ('${randomUUID()}', '${uid.tenantA}', '${uid.calendarA}', 'Bad', '2026-03-01T10:00:00Z', '2026-03-01T10:00:00Z')`,
            ),
          '23514',
        );
      });
    });

    it('20. holiday requires ends_on >= starts_on', async () => {
      await tenantA(async () => {
        await rejectCode(
          () =>
            app.query(
              `insert into holidays (id, tenant_id, name, starts_on, ends_on)
               values ('${randomUUID()}', '${uid.tenantA}', 'Bad', '2026-05-02', '2026-05-01')`,
            ),
          '23514',
        );
      });
    });

    it('21. school_settings is a per-tenant singleton', async () => {
      await tenantA(async () => {
        await rejectCode(
          () =>
            app.query(
              `insert into school_settings (id, tenant_id, school_name)
               values ('${randomUUID()}', '${uid.tenantA}', 'Second row')`,
            ),
          '23505',
        );
      });
    });

    it('22. status CHECK constraints reject unknown statuses', async () => {
      await tenantA(async () => {
        await rejectCode(
          () =>
            app.query(
              `insert into campuses (id, tenant_id, code, name, status)
               values ('${randomUUID()}', '${uid.tenantA}', 'badst-${slug}', 'Bad', 'open')`,
            ),
          '23514',
        );
        await rejectCode(
          () =>
            app.query(
              `insert into calendars (id, tenant_id, code, name, type, status)
               values ('${randomUUID()}', '${uid.tenantA}', 'badcal-${slug}', 'Bad', 'exam', 'active')`,
            ),
          '23514',
        );
      });
    });
  });
});