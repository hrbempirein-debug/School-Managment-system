/**
 * Disposable database plumbing for the DB-backed runtime/security suites (F-05).
 *
 * WHY THIS EXISTS
 * Every DB-backed suite in this workspace (Phase 3, 4, 5 and 6) resolves its two
 * connections from the SAME two variables, `DATABASE_URL_MIGRATOR` and
 * `DATABASE_URL_APP`, and both pointed at the long-lived development database
 * `school_saas_dev`. That made the whole security suite mutate the database a
 * developer is actively working in: fixtures were written and deleted inside
 * `school_saas_dev`, and a green run was indistinguishable from a corrupted one.
 * It also made the suites non-hermetic — a failure halfway through a run left
 * tenant/user/role rows behind in the dev database.
 *
 * THE RULE THIS MODULE ENFORCES
 * A runtime-security suite may only ever connect to a database whose name proves
 * it is disposable. There is no override switch, because an override is exactly
 * the thing that turns "this is safe by construction" into "this is safe until
 * someone sets the variable". Instead the escape hatch is a *different
 * `DATABASE_URL_TEST`* that is still named like a test database — which is
 * explicit, reviewable in `.env`, and cannot be aimed at development or
 * production by accident.
 *
 * The safety check is deliberately a NAME check and not a best-effort heuristic.
 * Anything that does not end in `_test` (or start with `test_`) is refused, and
 * the well-known non-disposable names are refused with their own dedicated error
 * so the failure reads as a policy violation rather than as bad configuration.
 */
import pg from 'pg';

/** Roles/URLs the runtime suites need, pointed at a disposable database. */
export interface RuntimeDatabaseUrls {
  /** Runtime role (school_app_rw) — what the application under test connects with. */
  appUrl: string;
  /** DDL role (school_migrator) — needed for migrations and the teardown guards. */
  migratorUrl: string;
  /** The database name both URLs resolve to, after validation. */
  database: string;
}

/**
 * Databases that must never be targeted even if somebody invents a
 * `DATABASE_URL_TEST` pointing at them. Checked by exact name so the error can
 * name the violation.
 */
const NEVER_DISPOSABLE = new Set([
  'school_saas_dev',
  'school_saas',
  'school_saas_prod',
  'school_saas_production',
  'postgres',
  'template0',
  'template1',
]);

/**
 * True when `name` is shaped like a purpose-built throwaway database. Both a
 * suffix and a prefix are accepted so a project can name its test databases
 * either way, but the name must opt in to being disposable — the safe default for
 * an unrecognised name is "no".
 */
export function isDisposableTestDatabaseName(name: string): boolean {
  return name.endsWith('_test') || name.startsWith('test_');
}

/**
 * Fail loudly rather than connect. Returns the validated name so callers can use
 * it as a single source of truth.
 */
export function assertDisposableTestDatabase(name: string): string {
  if (NEVER_DISPOSABLE.has(name)) {
    throw new Error(
      `Refusing to run runtime-security tests against database "${name}".\n` +
        `DATABASE_URL_TEST must name a DISPOSABLE database; "${name}" is a real ` +
        `environment. Point DATABASE_URL_TEST at a dedicated throwaway database ` +
        `(e.g. school_saas_test) instead. There is deliberately no override flag.`,
    );
  }
  if (!isDisposableTestDatabaseName(name)) {
    throw new Error(
      `Refusing to run runtime-security tests against database "${name}".\n` +
        `The name must end in "_test" (or start with "test_") so it is obviously ` +
        `disposable. Set DATABASE_URL_TEST to such a database.`,
    );
  }
  return name;
}

/** The database component of a libpq URL, without depending on WHATWG URL quirks. */
export function databaseNameOf(url: string): string {
  const withoutQuery = url.split('?')[0] ?? '';
  const afterScheme = withoutQuery.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, '');
  const slash = afterScheme.indexOf('/');
  if (slash === -1) return '';
  return decodeURIComponent(afterScheme.slice(slash + 1));
}

/** Same credentials and host, different database. Used to derive the DDL URL. */
export function withDatabase(url: string, database: string): string {
  const base = url.split('?')[0] ?? '';
  const schemeMatch = base.match(/^([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)/);
  const scheme = schemeMatch?.[1] ?? '';
  const afterScheme = base.slice(scheme.length);
  const slash = afterScheme.indexOf('/');
  if (slash === -1) throw new Error('Cannot derive a database URL from a URL with no path');
  return `${scheme}${afterScheme.slice(0, slash)}/${encodeURIComponent(database)}`;
}

/**
 * Resolve the disposable-database URLs from the environment.
 *
 * `DATABASE_URL_TEST` is REQUIRED (not optional, not defaulted). Defaulting it
 * from `DATABASE_URL_APP` would be the exact failure this finding is about: it
 * would silently retarget the suites at development the first time the variable
 * was missing. The schema in `@sms/config` keeps it optional so that
 * non-testing code paths do not require it, so this function is where the
 * requirement is enforced.
 *
 * The migrator URL is derived from `DATABASE_URL_MIGRATOR` by swapping only the
 * database, so the DDL role keeps its own credentials and no second secret has to
 * be introduced.
 */
export function resolveRuntimeDatabaseUrls(env: NodeJS.ProcessEnv = process.env): RuntimeDatabaseUrls {
  const testUrl = env.DATABASE_URL_TEST?.trim();
  if (!testUrl) {
    throw new Error(
      'DATABASE_URL_TEST is required to run the DB-backed runtime-security suites.\n' +
        'It must point at a DISPOSABLE database (name ending in "_test").\n' +
        'Refusing to fall back to DATABASE_URL_APP, which is the development ' +
        'database these suites are being moved OFF of.',
    );
  }
  const database = assertDisposableTestDatabase(databaseNameOf(testUrl));

  const migratorSource = env.DATABASE_URL_MIGRATOR?.trim();
  if (!migratorSource) {
    throw new Error('DATABASE_URL_MIGRATOR is required to migrate the disposable test database.');
  }
  return {
    appUrl: testUrl,
    migratorUrl: withDatabase(migratorSource, database),
    database,
  };
}

/**
 * Create the disposable database if it is missing, then report what happened.
 *
 * `school_migrator` deliberately has no CREATEDB, so the common case is "an
 * operator created it once". If creation is not permitted we do not guess: we
 * verify the database is at least present and, if it is not, throw with the
 * exact command to run. This keeps the suite from ever silently migrating
 * whichever database happens to exist.
 */
export async function ensureDatabaseExists(urls: RuntimeDatabaseUrls): Promise<{ created: boolean }> {
  const admin = new pg.Client({ connectionString: withDatabase(urls.migratorUrl, 'postgres') });
  await admin.connect();
  try {
    const existing = await admin.query('select 1 from pg_database where datname = $1', [
      urls.database,
    ]);
    if (existing.rowCount && existing.rowCount > 0) return { created: false };
    try {
      // CREATE DATABASE cannot be parameterised; the name is already restricted to
      // an identifier-safe `_test`/`test_` shape by assertDisposableTestDatabase.
      await admin.query(`create database "${urls.database}"`);
      return { created: true };
    } catch (err) {
      throw new Error(
        `The disposable test database "${urls.database}" does not exist and the ` +
          `migration role cannot create it (${(err as Error).message}).\n` +
          `Create it once as a superuser: createdb "${urls.database}", then re-run.`,
      );
    }
  } finally {
    await admin.end();
  }
}

/**
 * Rewrite the two connection variables the suites actually read so that they
 * point at the disposable database, in this process only.
 *
 * This runs BEFORE `@sms/config` is imported by any test module (it is wired as a
 * vitest `setupFiles` entry). `dotenv.config()` does not overwrite variables that
 * are already set, so the root `.env` cannot re-point the suite back at
 * development after this assignment.
 */
export function applyRuntimeDatabaseEnv(urls: RuntimeDatabaseUrls, env: NodeJS.ProcessEnv = process.env): void {
  // Re-assert after the rewrite as well, so a URL built from an already-set
  // process env still cannot smuggle a non-test database past the first check.
  assertDisposableTestDatabase(databaseNameOf(urls.appUrl));
  assertDisposableTestDatabase(databaseNameOf(urls.migratorUrl));
  env.DATABASE_URL_APP = urls.appUrl;
  env.DATABASE_URL_MIGRATOR = urls.migratorUrl;
}
