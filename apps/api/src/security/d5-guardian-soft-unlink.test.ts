import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { getEnv } from '@sms/config';
import {
  activeGuardianStudentEmails,
  createDb,
  parentReadableStudentIds,
  withTenant,
  type Db,
} from '@sms/db';
import type { RequestContext } from '@sms/core';
import { createTenantTransaction } from '../routes/tenants.js';
import { readableStudentIds } from '../routes/school/attendance.js';
import { parentScopesClass, resolveHomeworkContext } from '../routes/school/homework.js';

/**
 * D5 isolation proof — a soft-unlinked guardian is nobody's parent.
 *
 * D5-1 requires an isolation test that seeds (a) a soft-deleted LINK,
 * (b) a soft-deleted GUARDIAN and (c) a soft-deleted STUDENT and asserts ZERO
 * visibility/recipients from each.
 *
 * Announcements and messages do not exist yet (Phase 8 builds them), so the
 * recipient assertions are made against the resolvers Phase 8 MUST reuse:
 *   - `readableStudentIds(tx, ctx, 'parent')` — the canonical read ladder
 *   - `parentReadableStudentIds`             — the exported D5-1 resolver
 *   - `activeGuardianStudentEmails`          — the recipient resolver
 *   - `parentScopesClass` / `resolveHomeworkContext` — the two portal branches
 *
 * Each assertion carries a POSITIVE CONTROL: the one live-linked student must
 * come back, so a passing test can never be the vacuous "everything is empty"
 * that a broken join would also produce.
 *
 * Opt-in: RUN_RUNTIME_SECURITY_TESTS=1 (uses `school_saas_test` via the
 * standard disposable-database setup, never a development database).
 */
const enabled = process.env.RUN_RUNTIME_SECURITY_TESTS === '1';
const describeDb = enabled ? describe : describe.skip;

describeDb('D5 guardian soft-unlink isolation (real PG)', () => {
  let migratorDb: Db;
  let appDb: Db;
  let endMigrator: () => Promise<void>;
  let endApp: () => Promise<void>;

  const uid: Record<string, string> = {};
  const slug = `d5${randomUUID().slice(0, 8)}`;

  const rows = async (db: Db, q: ReturnType<typeof sql>): Promise<Record<string, unknown>[]> =>
    (await db.execute(q)).rows;

  beforeAll(async () => {
    const env = getEnv();
    const mig = createDb({ url: env.DATABASE_URL_MIGRATOR });
    const app_ = createDb({ url: env.DATABASE_URL_APP });
    migratorDb = mig.db;
    appDb = app_.db;
    endMigrator = () => mig.pool.end();
    endApp = () => app_.pool.end();

    uid.platRole = randomUUID();
    uid.owner = randomUUID();
    uid.parent = randomUUID();
    uid.deadUser = randomUUID();
    uid.stranger = randomUUID();

    await rows(
      migratorDb,
      sql`insert into roles (id, scope, code, name, is_system) values
        (${uid.platRole}, 'platform', ${`d5${slug}_plat`}, 'D5 Platform Admin', true)`,
    );
    await rows(
      migratorDb,
      sql`insert into role_permissions (role_id, permission) values
        (${uid.platRole}, 'platform.tenants.read'), (${uid.platRole}, 'platform.tenants.create')`,
    );
    await rows(
      migratorDb,
      sql`insert into users (id, email) values
        (${uid.owner}, ${`o-${slug}@example.com`}),
        (${uid.parent}, ${`pa-${slug}@example.com`}),
        (${uid.deadUser}, ${`du-${slug}@example.com`}),
        (${uid.stranger}, ${`st-${slug}@example.com`})`,
    );
    await rows(
      migratorDb,
      sql`insert into platform_role_assignments (user_id, role_id) values (${uid.owner}, ${uid.platRole})`,
    );

    const platformCtx: RequestContext = {
      requestId: randomUUID(),
      userId: uid.owner,
      scope: 'platform',
      tenantId: null,
      membershipId: null,
      campusId: null,
      roleIds: [uid.platRole],
      permissions: new Set(['platform.tenants.create', 'platform.tenants.read']),
      platformAccess: true,
      isSystem: false,
    };
    const created = await withTenant(appDb, platformCtx, (tx) =>
      createTenantTransaction(tx, platformCtx, {
        slug,
        name: 'D5 Soft Unlink School',
        requestId: randomUUID(),
      }),
    );
    uid.tenant = created.tenantId;

    const parentRoleId = String(
      (await rows(migratorDb, sql`select id from roles where tenant_id = ${uid.tenant} and code = 'parent'`))[0]!
        .id,
    );
    uid.parentMembership = String(
      (
        await rows(
          migratorDb,
          sql`insert into memberships (id, tenant_id, user_id, status)
              values (${randomUUID()}, ${uid.tenant}, ${uid.parent}, 'active') returning id`,
        )
      )[0]!.id,
    );
    await rows(
      migratorDb,
      sql`insert into membership_roles (membership_id, role_id) values (${uid.parentMembership}, ${parentRoleId})`,
    );

    uid.campus = randomUUID();
    uid.year = randomUUID();
    uid.classLive = randomUUID();
    uid.classUnlinked = randomUUID();
    await rows(
      migratorDb,
      sql`insert into campuses (id, tenant_id, code, name) values (${uid.campus}, ${uid.tenant}, ${`cp-${slug}`}, 'D5 Campus')`,
    );
    await rows(
      migratorDb,
      sql`insert into academic_years (id, tenant_id, code, name, starts_on, ends_on)
          values (${uid.year}, ${uid.tenant}, ${`ay-${slug}`}, 'AY D5', '2026-01-01', '2026-12-31')`,
    );
    await rows(
      migratorDb,
      sql`insert into acd_classes (id, tenant_id, campus_id, academic_year_id, code, name) values
        (${uid.classLive}, ${uid.tenant}, ${uid.campus}, ${uid.year}, 'live', 'Live Class'),
        (${uid.classUnlinked}, ${uid.tenant}, ${uid.campus}, ${uid.year}, 'unlinked', 'Unlinked Class')`,
    );

    // Three guardians: the parent's LIVE guardian, one whose OWN row is
    // soft-deleted, and (below) a stranger with no links at all.
    uid.gLive = randomUUID();
    uid.gDead = randomUUID();
    await rows(
      migratorDb,
      sql`insert into guardians (id, tenant_id, user_id, first_name, last_name) values
        (${uid.gLive}, ${uid.tenant}, ${uid.parent}, 'Live', 'Guardian'),
        (${uid.gDead}, ${uid.tenant}, ${uid.deadUser}, 'Dead', 'Guardian')`,
    );
    await rows(migratorDb, sql`update guardians set deleted_at = now() where id = ${uid.gDead}`);

    // Four students, each isolating one failure mode.
    uid.sLive = randomUUID();
    uid.sUnlinked = randomUUID(); // link soft-deleted
    uid.sDeleted = randomUUID(); // student soft-deleted
    uid.sDeadGuardian = randomUUID(); // guardian soft-deleted
    await rows(
      migratorDb,
      sql`insert into students (id, tenant_id, student_no, first_name, last_name, status) values
        (${uid.sLive}, ${uid.tenant}, ${`s1-${slug}`}, 'Live', 'Kid', 'active'),
        (${uid.sUnlinked}, ${uid.tenant}, ${`s2-${slug}`}, 'Unlinked', 'Kid', 'active'),
        (${uid.sDeleted}, ${uid.tenant}, ${`s3-${slug}`}, 'Deleted', 'Kid', 'active'),
        (${uid.sDeadGuardian}, ${uid.tenant}, ${`s4-${slug}`}, 'DeadG', 'Kid', 'active')`,
    );
    await rows(migratorDb, sql`update students set deleted_at = now() where id = ${uid.sDeleted}`);

    uid.lLive = randomUUID();
    uid.lUnlinked = randomUUID();
    uid.lDeleted = randomUUID();
    uid.lDeadGuardian = randomUUID();
    await rows(
      migratorDb,
      sql`insert into student_guardians (id, tenant_id, student_id, guardian_id, relation, is_primary) values
        (${uid.lLive}, ${uid.tenant}, ${uid.sLive}, ${uid.gLive}, 'parent', true),
        (${uid.lUnlinked}, ${uid.tenant}, ${uid.sUnlinked}, ${uid.gLive}, 'parent', false),
        (${uid.lDeleted}, ${uid.tenant}, ${uid.sDeleted}, ${uid.gLive}, 'parent', false),
        (${uid.lDeadGuardian}, ${uid.tenant}, ${uid.sDeadGuardian}, ${uid.gDead}, 'parent', false)`,
    );
    await rows(
      migratorDb,
      sql`update student_guardians set deleted_at = now() where id = ${uid.lUnlinked}`,
    );

    // Enrolments: the live student into `classLive`, the soft-unlinked student
    // into `classUnlinked`. If the link predicate is missing, the parent would
    // scope to BOTH classes through homework.
    await rows(
      migratorDb,
      sql`insert into enrollments (id, tenant_id, student_id, academic_year_id, class_id, status, roll_no) values
        (${randomUUID()}, ${uid.tenant}, ${uid.sLive}, ${uid.year}, ${uid.classLive}, 'active', 'r1'),
        (${randomUUID()}, ${uid.tenant}, ${uid.sUnlinked}, ${uid.year}, ${uid.classUnlinked}, 'active', 'r2')`,
    );
  });

  afterAll(async () => {
    try {
      const t = uid.tenant;
      if (!t) return;
      await rows(migratorDb, sql`delete from enrollments where tenant_id = ${t}`);
      await rows(migratorDb, sql`delete from acd_classes where tenant_id = ${t}`);
      await rows(migratorDb, sql`delete from academic_years where tenant_id = ${t}`);
      await rows(migratorDb, sql`delete from student_guardians where tenant_id = ${t}`);
      await rows(migratorDb, sql`delete from students where tenant_id = ${t}`);
      await rows(migratorDb, sql`delete from guardians where tenant_id = ${t}`);
      await rows(migratorDb, sql`delete from outbox_events where tenant_id = ${t}`);
      await rows(
        migratorDb,
        sql`delete from membership_roles where membership_id in (select id from memberships where tenant_id = ${t})`,
      );
      await rows(migratorDb, sql`delete from memberships where tenant_id = ${t}`);
      await rows(
        migratorDb,
        sql`delete from role_permissions where role_id in (select id from roles where tenant_id = ${t} or id = ${uid.platRole})`,
      );
      await rows(migratorDb, sql`delete from platform_role_assignments where user_id = ${uid.owner}`);
      await rows(migratorDb, sql`delete from roles where tenant_id = ${t} or id = ${uid.platRole}`);
      await rows(migratorDb, sql`delete from campuses where tenant_id = ${t}`);
      await rows(migratorDb, sql`delete from audit_logs where tenant_id = ${t}`);
      await rows(
        migratorDb,
        sql`delete from users where id in (${uid.owner}, ${uid.parent}, ${uid.deadUser}, ${uid.stranger})`,
      );
      await rows(migratorDb, sql`delete from tenants where id = ${t}`);
    } finally {
      await endMigrator();
      await endApp();
    }
  });

  const parentCtx = (): RequestContext => ({
    requestId: randomUUID(),
    userId: uid.parent!,
    scope: 'tenant',
    tenantId: uid.tenant!,
    membershipId: uid.parentMembership!,
    campusId: null,
    roleIds: [],
    permissions: new Set(),
    platformAccess: false,
    isSystem: false,
  });

  const strangerCtx = (): RequestContext => ({
    ...parentCtx(),
    userId: uid.stranger!,
  });

  const ALL_STUDENTS = () => [uid.sLive!, uid.sUnlinked!, uid.sDeleted!, uid.sDeadGuardian!];

  const parentIds = async (ctx: RequestContext): Promise<string[]> => {
    const ids = await withTenant(appDb, ctx, (tx) => readableStudentIds(tx, ctx, 'parent'));
    expect(ids, 'parent visibility is a SET of ids, never the null (school-wide) marker').not.toBeNull();
    return [...(ids ?? [])];
  };

  it('(a) a soft-deleted LINK grants no read visibility — POSITIVE CONTROL holds', async () => {
    const ids = await parentIds(parentCtx());
    // Positive control: the live link is visible, so the test is not vacuous.
    expect(ids).toContain(uid.sLive!);
    // The three isolations.
    expect(ids, 'soft-deleted link must not be visible').not.toContain(uid.sUnlinked!);
    expect(ids, 'soft-deleted student must not be visible').not.toContain(uid.sDeleted!);
    expect(ids, 'student of a soft-deleted guardian must not be visible').not.toContain(
      uid.sDeadGuardian!,
    );
    expect(ids.length, 'exactly the one live relationship').toBe(1);
  });

  it('(a) the exported D5-1 resolver agrees with the read ladder exactly', async () => {
    const ctx = parentCtx();
    const viaResolver = await withTenant(appDb, ctx, (tx) => parentReadableStudentIds(tx, ctx));
    const viaLadder = await parentIds(ctx);
    expect([...viaResolver].sort()).toEqual([...viaLadder].sort());
    expect([...viaResolver].sort()).toEqual([uid.sLive!]);
  });

  it('(a) a stranger with no guardian row resolves to nothing', async () => {
    expect(await parentIds(strangerCtx())).toEqual([]);
  });

  it('(a) the homework parent branch scopes ONLY to the live-linked class', async () => {
    const ctx = parentCtx();
    const live = await withTenant(appDb, ctx, (tx) => parentScopesClass(tx, ctx, uid.classLive!));
    const unlinked = await withTenant(appDb, ctx, (tx) =>
      parentScopesClass(tx, ctx, uid.classUnlinked!),
    );
    expect(live, 'positive control: the live relationship still reaches its class').toBe(true);
    expect(unlinked, 'a soft-unlinked student must not reach its class').toBe(false);
  });

  it('(a) the homework portal context advertises only the live-linked class', async () => {
    const ctx = parentCtx();
    const resolved = await withTenant(appDb, ctx, (tx) => resolveHomeworkContext(tx, ctx));
    expect(resolved.role).toBe('parent');
    const classIds = resolved.classes.map((c) => c.id);
    expect(classIds).toContain(uid.classLive!);
    expect(classIds, 'a soft-unlinked student must not advertise its class').not.toContain(
      uid.classUnlinked!,
    );
    expect(classIds.length).toBe(1);
  });

  it('(a) RECIPIENT resolution yields exactly one address — no removed guardian is a recipient', async () => {
    const ctx = parentCtx();
    const found = await withTenant(appDb, ctx, (tx) =>
      activeGuardianStudentEmails(tx, uid.tenant!, ALL_STUDENTS()),
    );
    expect(found.length, 'positive control: the live link still produces a recipient').toBeGreaterThan(
      0,
    );
    expect(found.map((r) => r.studentId).sort()).toEqual([uid.sLive!]);
    expect(found.map((r) => r.email)).toEqual([`pa-${slug}@example.com`]);
  });

  it('(a) an empty audience input resolves to an empty audience, not an error', async () => {
    const ctx = parentCtx();
    const found = await withTenant(appDb, ctx, (tx) =>
      activeGuardianStudentEmails(tx, uid.tenant!, []),
    );
    expect(found).toEqual([]);
  });
});
