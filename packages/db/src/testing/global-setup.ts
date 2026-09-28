/**
 * vitest `globalSetup` for the DB-backed runtime-security suites (F-05).
 *
 * Runs ONCE per vitest invocation, in the main process, before any test worker
 * starts. Its job is to make the disposable database REAL before a single fixture
 * is written: validate the target, create it if missing, and bring it to the same
 * migration level as development. Tests then start against a known schema instead
 * of assuming whatever was already there.
 */
import { applyMigrations } from '../cli/migrate.js';
import { migrationsDir } from '../cli/paths.js';
import {
  applyRuntimeDatabaseEnv,
  ensureDatabaseExists,
  resolveRuntimeDatabaseUrls,
} from './runtime-db.js';

export default async function setup(): Promise<void> {
  const urls = resolveRuntimeDatabaseUrls();

  // Fail before connecting to anything if the target is not disposable.
  const { created } = await ensureDatabaseExists(urls);

  const { applied, skipped } = await applyMigrations(urls.migratorUrl, migrationsDir);

  // Point this process (and therefore the workers it forks) at the disposable
  // database. `setupFiles` repeats the assignment inside each worker so correctness
  // does not depend on env inheritance across the fork boundary.
  applyRuntimeDatabaseEnv(urls);

  // eslint-disable-next-line no-console
  console.log(
    `[runtime-db] disposable database "${urls.database}"` +
      `${created ? ' (created)' : ''}` +
      ` | migrations applied: ${applied.length}, already current: ${skipped.length}` +
      `${applied.length ? ` -> ${applied.join(', ')}` : ''}`,
  );
}
