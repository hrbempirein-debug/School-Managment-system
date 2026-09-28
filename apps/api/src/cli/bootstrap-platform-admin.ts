import { hashPassword } from '@sms/auth';
import { writeAudit } from '@sms/audit';
import { createDb, users, userProfiles, authIdentities, roles, rolePermissions, platformRoleAssignments } from '@sms/db';
import { eq, sql } from 'drizzle-orm';
import { ROLE_TEMPLATES } from '@sms/permissions';
import { loadEnv } from '@sms/config';
import { isMainModule } from '@sms/db/src/cli/paths.js';

/**
 * Explicit, opt-in platform-administrator bootstrap.
 *
 * WHY THIS EXISTS. `PLATFORM_ADMIN_EMAIL` / `PLATFORM_ADMIN_PASSWORD` are declared in
 * `@sms/config` and were read by nothing, and `pnpm db:seed` is deliberately a no-op
 * that refuses to invent fixtures. So a fresh deployment had exactly one way to obtain
 * a platform administrator: open a SQL console as the migrator and hand-write a user,
 * a profile, a password identity, a platform role and a role assignment. That path is
 * unaudited, unrepeatable, and easy to get subtly wrong (a `provider_key` that does not
 * match the login lookup silently yields an account that cannot log in).
 *
 * WHAT THIS IS NOT. This is NOT a migration, NOT part of `db:seed`, and NOT triggered
 * by the API booting or by `pnpm db:migrate`. It runs only when an operator runs
 * `pnpm platform:bootstrap-admin` and supplies credentials through the environment.
 * Nothing here runs implicitly, so the "no admin exists after deploy" state stays
 * observable instead of being papered over.
 *
 * THE PROPERTIES THAT MATTER
 *
 *  - EXTERNALLY CREDENTIALED. The email and password come from the environment only.
 *    There is no default, no generated password, and no fallback account. Neither
 *    value is ever printed, logged, or written to the audit trail.
 *  - IDEMPOTENT. Running it twice is safe and converges. It will NOT reset the
 *    password of an account that already exists: a bootstrap command that silently
 *    rotates a live operator's credential is a backdoor, not a convenience. It reports
 *    that the account exists and leaves the credential alone.
 *  - AUDITED. Every run writes one `platform.admin_bootstrap` audit row recording what
 *    it actually changed, with `actorType = 'system'`.
 *  - ALL-OR-NOTHING. User, profile, identity, role, role permissions and assignment
 *    are written in a single transaction, so a failure can never leave an account
 *    without its platform role.
 *  - MIGRATOR CONNECTION, ON PURPOSE. These are platform-scope rows with no tenant
 *    context and no RLS ticket, which is exactly the work the runtime role must never
 *    be able to do. The command therefore refuses to run on `DATABASE_URL`, and reads
 *    `DATABASE_URL_MIGRATOR` directly.
 */

/** The role template the bootstrap provisions. Resolved, never hardcoded, so the
 * granted permission set cannot drift from the catalog in `@sms/permissions`. */
export const PLATFORM_ADMIN_ROLE_CODE = 'platform_admin';

export type BootstrapAction =
  | 'user_created'
  | 'user_exists'
  | 'role_created'
  | 'role_exists'
  | 'permissions_added'
  | 'assigned'
  | 'already_assigned';

export interface BootstrapResult {
  email: string;
  roleId: string;
  userId: string;
  actions: BootstrapAction[];
  /** True when the account already existed, so its password was deliberately left
   * untouched. Surfaced so an operator is never surprised by a no-op credential. */
  passwordUntouched: boolean;
}

export interface BootstrapCredentials {
  email: string;
  password: string;
}

/**
 * Validate operator-supplied credentials before any connection is opened.
 *
 * Returns the normalized credentials or throws with a message that is safe to print
 * (it names the missing variable but never echoes a supplied value).
 */
export function normalizeCredentials(input: {
  email?: string | undefined;
  password?: string | undefined;
}): BootstrapCredentials {
  const email = input.email?.trim().toLowerCase() ?? '';
  if (!email) {
    throw new Error(
      'PLATFORM_ADMIN_EMAIL is not set. Export the platform administrator email and retry; ' +
        'this command never invents an account.',
    );
  }
  // Mirrors the `@sms/config` schema (z.string().email()) closely enough to fail fast
  // with an actionable message instead of letting a malformed address reach Postgres.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error('PLATFORM_ADMIN_EMAIL is not a valid email address.');
  }
  if (!input.password) {
    throw new Error(
      'PLATFORM_ADMIN_PASSWORD is not set. Export the platform administrator password and retry; ' +
        'this command never generates one.',
    );
  }
  if (input.password.length < 12) {
    // Matches the `z.string().min(12)` floor in `@sms/config`. The length is reported;
    // the value never is.
    throw new Error(
      `PLATFORM_ADMIN_PASSWORD must be at least 12 characters (got ${input.password.length}).`,
    );
  }
  return { email, password: input.password };
}

/** The permissions the `platform_admin` template grants. */
function platformAdminPermissions(): string[] {
  const template = ROLE_TEMPLATES.find((t) => t.code === PLATFORM_ADMIN_ROLE_CODE);
  if (!template || template.scope !== 'platform') {
    throw new Error(
      `the ${PLATFORM_ADMIN_ROLE_CODE} role template is missing from @sms/permissions; ` +
        'refusing to bootstrap an admin with an undefined permission set.',
    );
  }
  return [...template.permissions];
}

/**
 * Create (or converge) the platform administrator.
 *
 * `url` MUST be the migrator connection string. The caller is responsible for that;
 * `bootstrapPlatformAdminFromEnv` enforces it.
 */
export async function bootstrapPlatformAdmin(
  url: string,
  creds: BootstrapCredentials,
): Promise<BootstrapResult> {
  const { email, password } = creds;
  const permissions = platformAdminPermissions();
  const { db, pool } = createDb({ url });
  const actions: BootstrapAction[] = [];
  let passwordUntouched = false;

  try {
    const result = await db.transaction(async (tx) => {
      // ---- the account -------------------------------------------------------
      const existing = await tx
        .select({ id: users.id })
        .from(users)
        .where(sql`lower(${users.email}) = ${email}`)
        .limit(1)
        .then((r) => r[0]);

      let userId = existing?.id as string | undefined;
      if (userId) {
        actions.push('user_exists');
        // A bootstrap must never rotate the credential of an account that already
        // exists. Say so loudly rather than pretending it did something.
        passwordUntouched = true;
      } else {
        const inserted = await tx
          .insert(users)
          .values({ email })
          .returning({ id: users.id });
        userId = inserted[0]!.id;
        actions.push('user_created');

        await tx.insert(userProfiles).values({ userId, fullName: email });
        await tx.insert(authIdentities).values({
          userId,
          provider: 'password',
          // MUST match the login lookup, which keys on the normalized address.
          providerKey: email,
          passwordHash: await hashPassword(password),
        });
      }

      // ---- the platform role -------------------------------------------------
      const roleRows = await tx
        .select({ id: roles.id })
        .from(roles)
        .where(sql`${roles.scope} = 'platform' and ${roles.code} = ${PLATFORM_ADMIN_ROLE_CODE}`)
        .limit(1)
        .then((r) => r[0]);

      let roleId = roleRows?.id as string | undefined;
      if (roleId) {
        actions.push('role_exists');
      } else {
        const created = await tx
          .insert(roles)
          .values({
            scope: 'platform',
            code: PLATFORM_ADMIN_ROLE_CODE,
            name: 'Platform Administrator',
            description: 'Full platform administration',
            isSystem: true,
          })
          .returning({ id: roles.id });
        roleId = created[0]!.id;
        actions.push('role_created');
      }

      // ---- the role's permissions (additive convergence) ---------------------
      const held = new Set(
        await tx
          .select({ permission: rolePermissions.permission })
          .from(rolePermissions)
          .where(eq(rolePermissions.roleId, roleId!))
          .then((r) => r.map((x) => x.permission)),
      );
      const missing = permissions.filter((p) => !held.has(p));
      if (missing.length > 0) {
        await tx
          .insert(rolePermissions)
          .values(missing.map((permission) => ({ roleId: roleId!, permission })));
        actions.push('permissions_added');
      }

      // ---- the assignment ----------------------------------------------------
      const assignment = await tx
        .select({ roleId: platformRoleAssignments.roleId })
        .from(platformRoleAssignments)
        .where(
          sql`${platformRoleAssignments.userId} = ${userId!} and ${platformRoleAssignments.roleId} = ${roleId!}`,
        )
        .limit(1)
        .then((r) => r[0]);
      if (assignment) {
        actions.push('already_assigned');
      } else {
        await tx.insert(platformRoleAssignments).values({ userId: userId!, roleId: roleId! });
        actions.push('assigned');
      }

      // ---- the audit record --------------------------------------------------
      // The password and its hash are never included; `writeAudit` deep-redacts as a
      // second line of defence, but the value is simply not passed.
      await writeAudit(tx, {
        scope: 'platform',
        tenantId: null,
        actorUserId: null,
        actorType: 'system',
        action: 'platform.admin_bootstrap',
        resourceType: 'user',
        resourceId: userId!,
        newValue: { email, roleCode: PLATFORM_ADMIN_ROLE_CODE, actions, permissionsGranted: permissions.length },
      });

      return { userId: userId!, roleId: roleId! };
    });

    return {
      email,
      userId: result.userId,
      roleId: result.roleId,
      actions,
      passwordUntouched,
    };
  } finally {
    // A CLI holds no other handle on the pool; without this the process would hang
    // after a successful run.
    await pool.end();
  }
}

/**
 * The three environment inputs this command reads. Declared structurally rather than
 * as `NodeJS.ProcessEnv` or the full `@sms/config` shape, so a test can pass a literal
 * and so the command's actual credential surface is visible in one place.
 */
export interface BootstrapEnv {
  PLATFORM_ADMIN_EMAIL?: string | undefined;
  PLATFORM_ADMIN_PASSWORD?: string | undefined;
  DATABASE_URL_MIGRATOR?: string | undefined;
}

/**
 * Env-driven entry point. Refuses to run unless the migrator URL is configured, so the
 * command can never be pointed at the runtime role by accident.
 */
export async function bootstrapPlatformAdminFromEnv(env: BootstrapEnv): Promise<BootstrapResult> {
  const creds = normalizeCredentials({
    email: env.PLATFORM_ADMIN_EMAIL,
    password: env.PLATFORM_ADMIN_PASSWORD,
  });
  const migratorUrl = env.DATABASE_URL_MIGRATOR?.trim();
  if (!migratorUrl) {
    throw new Error(
      'DATABASE_URL_MIGRATOR is not set. The platform bootstrap writes platform-scope ' +
        'rows with no RLS context and must run as the migrator.',
    );
  }
  return bootstrapPlatformAdmin(migratorUrl, creds);
}

/** Operator-facing summary. Deliberately contains no secret material. */
export function formatBootstrapReport(result: BootstrapResult): string {
  const lines = [
    `platform administrator ready: ${result.email}`,
    `  user id: ${result.userId}`,
    `  role id: ${result.roleId} (${PLATFORM_ADMIN_ROLE_CODE})`,
    `  actions: ${result.actions.join(', ')}`,
  ];
  if (result.passwordUntouched) {
    lines.push(
      '  the account already existed, so its password was NOT changed. ' +
        'Reset it through the normal account-recovery path if you need to rotate it.',
    );
  }
  return lines.join('\n');
}

if (isMainModule(import.meta.url)) {
  const env = loadEnv();
  try {
    const result = await bootstrapPlatformAdminFromEnv(env);
    console.log(formatBootstrapReport(result));
  } catch (err) {
    // The message is authored to be secret-free; an unexpected driver error could
    // contain a connection string, so only well-known errors are echoed verbatim.
    const message = err instanceof Error ? err.message : String(err);
    const known =
      message.startsWith('PLATFORM_ADMIN_') ||
      message.startsWith('DATABASE_URL_MIGRATOR') ||
      message.startsWith('the platform_admin role template');
    console.error(known ? message : 'platform bootstrap failed; see the error detail above.');
    if (!known) console.error(err);
    process.exit(1);
  }
}
