import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';
import { loadEnv } from '@sms/config';
import { migrationsDir, isMainModule } from './paths.js';

/**
 * Phase 1 migration discipline (see DATABASE_DESIGN.md §19 and DEPLOYMENT.md):
 * migrations are forward-fix only — no automated down-migrations on prod, and no
 * destructive operation runs without a reviewed rollback note. There is NO
 * rollback SQL for `0001_init.sql`, so this command can never invent one.
 *
 * It therefore acts as a *guarded* rollback runner for the future: it only
 * executes a migration-specific `<NNNN_name>.down.sql` file when one exists
 * next to the migration, requires an explicit `--yes` destructive confirmation,
 * verifies the migration history first, and keeps `schema_migrations` consistent
 * in the same transaction. Without a down-file it refuses to do anything.
 */
export interface RollbackArgs {
  yes: boolean;
  revision?: string;
}

export const DOWN_SUFFIX = '.down.sql';

export function parseArgs(argv: string[]): RollbackArgs {
  const args: RollbackArgs = { yes: false };
  for (const arg of argv) {
    if (arg === '--yes' || arg === '-y') args.yes = true;
    else if (arg.startsWith('--revision=')) args.revision = arg.slice('--revision='.length).trim();
  }
  return args;
}

/** Convention: a forward migration `0001_init.sql` rolls back via `0001_init.down.sql`. */
export function downFileName(migrationFile: string): string {
  return migrationFile.replace(/\.sql$/i, DOWN_SUFFIX);
}

export interface RollbackResult {
  rolledBack?: string;
  reason?: string;
}

/** Verify the rollback file exists; throws a descriptive error if it does not. */
export async function rollbackMigration(
  url: string,
  target: string,
  dir = migrationsDir,
): Promise<RollbackResult> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query(`create table if not exists schema_migrations (
      version text primary key,
      applied_at timestamptz not null default now()
    )`);
    const applied = (await client.query('select version from schema_migrations')).rows
      .map((r: { version: string }) => r.version)
      .filter((v): v is string => Boolean(v));
    if (!applied.includes(target)) {
      return { reason: `migration '${target}' is not in the migration history; nothing to roll back` };
    }
    const down = path.join(dir, downFileName(target));
    const files = await readdir(dir);
    if (!files.includes(downFileName(target))) {
      return {
        reason:
          `no rollback SQL exists for '${target}' (expected '${downFileName(target)}' next to it). ` +
          `Phase 1 migrations are forward-fix only; write a reviewed '${downFileName(target)}' ` +
          `before attempting a rollback. Nothing was executed.`,
      };
    }
    const { readFile: rf } = await import('node:fs/promises');
    const sqlText = await rf(down, 'utf8');
    await client.query('begin');
    try {
      await client.query('set local search_path = public');
      await client.query(sqlText);
      await client.query('delete from schema_migrations where version = $1', [target]);
      await client.query('commit');
    } catch (err) {
      await client.query('rollback');
      throw new Error(`Rollback ${target} failed: ${(err as Error).message}`);
    }
    return { rolledBack: target };
  } finally {
    await client.end();
  }
}

if (isMainModule()) {
  const env = loadEnv();
  const args = parseArgs(process.argv.slice(2));

  const history = await (async () => {
    const client = new pg.Client({ connectionString: env.DATABASE_URL_MIGRATOR });
    await client.connect();
    try {
      await client.query(`create table if not exists schema_migrations (
        version text primary key,
        applied_at timestamptz not null default now()
      )`);
      const rows = (
        await client.query(
          'select version, to_char(applied_at, \'YYYY-MM-DD HH24:MI:SS\') as applied_at from schema_migrations order by applied_at',
        )
      ).rows as { version: string; applied_at: string }[];
      return rows;
    } finally {
      await client.end();
    }
  })();

  if (history.length === 0) {
    console.log('migration history is empty; nothing to roll back.');
    process.exit(0);
  }

  const target = args.revision ?? history.at(-1)!.version;
  const confirmed = `${target} ${args.yes ? '(confirmed)' : ''}`;
  console.log(
    `migration history:\n${history.map((r) => `  ${r.version}  (${r.applied_at})`).join('\n')}`,
  );
  console.log(`rollback target: ${target}`);

  if (!args.yes) {
    console.error(
      `ABORTED: rollback is destructive. Re-run with --yes to confirm rolling back '${confirmed}'.`,
    );
    process.exit(2);
  }

  const result = await rollbackMigration(env.DATABASE_URL_MIGRATOR, target);
  if (result.rolledBack) {
    console.log(`rolled back: ${result.rolledBack}`);
    process.exit(0);
  }
  console.error(`ABORTED: ${result.reason}`);
  process.exit(2);
}