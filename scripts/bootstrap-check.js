'use strict';
/**
 * Read-only Phase 1 bootstrap verification (`pnpm db:bootstrap`).
 *
 * Verifies the state that `scripts/bootstrap.sql` is expected to have created.
 * This script NEVER creates roles/databases, alters PostgreSQL, touches
 * pg_hba.conf, resets passwords, or prints any credential/connection secret.
 */

const path = require('node:path');
const fs = require('node:fs');
const dotenv = require('dotenv');
const pg = require('pg');

const REPO_ROOT = path.resolve(__dirname, '..');
const ENV_PATH = path.join(REPO_ROOT, '.env');

function maskUrl(url) {
  try {
    const u = new URL(url);
    if (u.password) u.password = '***';
    return u.toString();
  } catch {
    return '<unparseable connection URL (not shown)>';
  }
}

function envSnapshot() {
  if (!fs.existsSync(ENV_PATH)) {
    return { exists: false };
  }
  dotenv.config({ path: ENV_PATH, quiet: true });
  return { exists: true };
}

async function check(client, label, fn) {
  try {
    const detail = await fn(client);
    console.log(`PASS  ${label}${detail ? ` — ${detail}` : ''}`);
    return true;
  } catch (err) {
    console.log(`FAIL  ${label} — ${err.message}`);
    return false;
  }
}

async function main() {
  const results = [];

  if (envSnapshot().exists) {
    if (!process.env.DATABASE_URL_MIGRATOR || !process.env.DATABASE_URL_APP) {
      results.push(false);
      console.log('FAIL  root .env present — DATABASE_URL_MIGRATOR/DATABASE_URL_APP not loaded');
    } else {
      const mig = process.env.DATABASE_URL_MIGRATOR;
      const app = process.env.DATABASE_URL_APP;
      const migDb = new URL(mig).pathname.replace(/^\//, '');
      const appDb = new URL(app).pathname.replace(/^\//, '');
      results.push(true);
      console.log(
        `PASS  root .env present — migrator → ${maskUrl(mig)}; app_rw → ${maskUrl(app)} (dbs: ${migDb}, ${appDb})`,
      );
    }
  } else {
    results.push(false);
    console.log(`FAIL  root .env present — .env not found at ${ENV_PATH} (run bootstrap.sql first)`);
  }

  let client = null;
  try {
    client = new pg.Client({ connectionString: process.env.DATABASE_URL_MIGRATOR });
    await client.connect();
    results.push(
      await check(client, 'PostgreSQL reachable', () => 'connected'),
    );

    results.push(
      await check(client, 'expected databases exist', async (c) => {
        const { rows } = await c.query(
          `select datname from pg_database where datname in ($1,$2) order by datname`,
          ['school_saas_dev', 'school_saas_test'],
        );
        const found = rows.map((r) => r.datname).sort();
        const missing = ['school_saas_dev', 'school_saas_test'].filter((d) => !found.includes(d));
        if (missing.length) throw new Error(`missing: ${missing.join(', ')}`);
        return `school_saas_dev, school_saas_test`;
      }),
    );

    results.push(
      await check(client, 'expected roles exist', async (c) => {
        const { rows } = await c.query(
          `select rolname from pg_roles where rolname in ($1,$2) order by rolname`,
          ['school_migrator', 'school_app_rw'],
        );
        const found = rows.map((r) => r.rolname).sort();
        const missing = ['school_migrator', 'school_app_rw'].filter((r) => !found.includes(r));
        if (missing.length) throw new Error(`missing roles: ${missing.join(', ')}`);
        return found.join(', ');
      }),
    );

    results.push(
      await check(client, 'roles are non-superuser', async (c) => {
        const { rows } = await c.query(
          `select rolname from pg_roles where rolname in ($1,$2) and rolsuper`,
          ['school_migrator', 'school_app_rw'],
        );
        if (rows.length) throw new Error(`superusers: ${rows.map((r) => r.rolname).join(', ')}`);
        return 'neither role is superuser';
      }),
    );

    results.push(
      await check(client, 'school_app_rw has no BYPASSRLS', async (c) => {
        const { rows } = await c.query(
          `select 1 from pg_roles where rolname=$1 and rolbypassrls`,
          ['school_app_rw'],
        );
        if (rows.length) throw new Error('school_app_rw has BYPASSRLS set');
        return 'rolbypassrls=false';
      }),
    );

    results.push(
      await check(client, 'migrations applied', async (c) => {
        const { rows } = await c.query(
          `select count(*)::int as n from information_schema.tables where table_schema='public' and table_name='schema_migrations'`,
        );
        if (!rows[0] || rows[0].n === 0) return 'no schema_migrations yet (db:migrate not run)';
        const applied = await c.query(`select version from schema_migrations order by version`);
        const v = applied.rows.map((r) => r.version).join(', ');
        return v ? v : 'schema_migrations empty';
      }),
    );
  } catch (err) {
    results.push(
      await check(null, 'connect as school_migrator', async () => {
        throw new Error(`cannot connect as school_migrator: ${err.message}`);
      }),
    );
    console.log(`\nUnverified connection string: ${maskUrl(process.env.DATABASE_URL_MIGRATOR || '')}`);
  } finally {
    if (client) await client.end();
  }

  console.log(''); // eslint-disable-next-line no-console
  const failures = results.filter((r) => r === false).length;
  console.log(failures === 0 ? 'bootstrap OK' : `bootstrap FAILED (${failures} check(s) failed)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(`FATAL: ${err.message}`);
  process.exit(2);
});