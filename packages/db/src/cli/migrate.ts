import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';
import { loadEnv } from '@sms/config';
import { migrationsDir, isMainModule } from './paths.js';

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

const SELECT_APPLIED = 'select version from schema_migrations';
const INSERT_VERSION =
  'insert into schema_migrations(version, applied_at) values ($1, now()) on conflict do nothing';

export async function applyMigrations(
  url: string,
  dir = migrationsDir,
): Promise<MigrationResult> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query(`create table if not exists schema_migrations (
      version text primary key,
      applied_at timestamptz not null default now()
    )`);
    const applied = new Set(
      (await client.query(SELECT_APPLIED)).rows
        .map((r: { version: string }) => r.version)
        .filter((v): v is string => Boolean(v)),
    );
    const files = (await readdir(dir)).filter((f) => /^[0-9]+_.+\.sql$/.test(f)).sort();

    const appliedList: string[] = [];
    const skipped: string[] = [];
    for (const file of files) {
      if (applied.has(file)) {
        skipped.push(file);
        continue;
      }
      const sqlText = await readFile(path.join(dir, file), 'utf8');
      await client.query('begin');
      try {
        await client.query(sqlText);
        await client.query(INSERT_VERSION, [file]);
        await client.query('commit');
        appliedList.push(file);
      } catch (err) {
        await client.query('rollback');
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
      }
    }
    return { applied: appliedList, skipped };
  } finally {
    await client.end();
  }
}

if (isMainModule(import.meta.url)) {
  try {
    const env = loadEnv();
    const result = await applyMigrations(env.DATABASE_URL_MIGRATOR);
    // eslint-disable-next-line no-console
    console.log(
      `migrations applied: ${result.applied.length ? result.applied.join(', ') : '(none)'}`,
      `| already applied: ${result.skipped.length}`,
    );
    if (result.applied.length === 0) {
      // eslint-disable-next-line no-console
      console.log('database is already up to date; nothing to migrate');
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`migration failed: ${(err as Error).message}`);
    process.exitCode = 1;
  }
}