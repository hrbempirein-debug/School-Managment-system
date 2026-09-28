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

applyRuntimeDatabaseEnv(resolveRuntimeDatabaseUrls());
