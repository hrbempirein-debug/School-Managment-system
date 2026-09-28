/**
 * vitest `setupFiles` entry for the DB-backed runtime-security suites (F-05).
 *
 * Runs inside EVERY test worker, before that worker imports any test module. Its
 * only job is to repoint `DATABASE_URL_APP` / `DATABASE_URL_MIGRATOR` at the
 * disposable database, so the first `@sms/config` read in the worker already sees
 * the test database. It performs no I/O — the database was created and migrated by
 * `global-setup.ts` — so a pure-unit test file in the same package pays nothing.
 *
 * This duplicates the env assignment from `global-setup.ts` on purpose. Depending
 * on a mutated `process.env` surviving the fork into a worker is an implementation
 * detail of the pool; doing the assignment again where it is actually read is not.
 */
import { applyRuntimeDatabaseEnv, resolveRuntimeDatabaseUrls } from './runtime-db.js';

// Mirrors the opt-in guard in `global-setup.ts`. Without it, every worker in a default
// `pnpm test` run would throw on a clean checkout that has no `.env`, failing the whole
// package for tests that never touch a database. When the opt-in IS set, the strict
// resolution below still runs and still refuses the development database.
if (process.env.RUN_RUNTIME_SECURITY_TESTS === '1') {
  applyRuntimeDatabaseEnv(resolveRuntimeDatabaseUrls());
}
