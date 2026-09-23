import pg from 'pg';
import { loadEnv } from '@sms/config';
import { isMainModule } from './paths.js';

/**
 * Phase 1 seed contract: NONE defined yet.
 *
 * There is no documented seed specification for Phase 1 (see DEVELOPMENT_ROADMAP:
 * "two tenants seeded" is an acceptance criterion, but the fixture content is
 * unspecified; DECISIONS has no ADR for seeding; no platform-admin rollout exists).
 * The `PLATFORM_ADMIN_EMAIL/PASSWORD` env keys are optional and currently unused.
 *
 * Seeding is intentionally deferred. Rather than invent a large fixture system,
 * this command validates that the database is migrated and reports "nothing to
 * seed" so `pnpm db:seed` is a predictable, non-destructive no-op until a seed
 * contract (ADRs, fixture definitions) lands.
 *
 * It MUST NOT create tenants/users/roles, and never prints passwords/secrets.
 */
export interface SeedState {
  migrated: boolean;
  applied: string[];
  reason: string;
}

export async function inspectSeedState(url: string): Promise<SeedState> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query(`create table if not exists schema_migrations (
      version text primary key,
      applied_at timestamptz not null default now()
    )`);
    const rows = (await client.query('select version from schema_migrations order by version')).rows as {
      version: string;
    }[];
    const applied = rows.map((r) => r.version).filter((v): v is string => Boolean(v));
    return {
      migrated: applied.length > 0,
      applied,
      reason:
        'seed fixtures intentionally deferred: no Phase 1 seed contract defined yet. ' +
        'Nothing was created or modified.',
    };
  } finally {
    await client.end();
  }
}

export function buildSeedReport(state: SeedState): string {
  const lines = [`migrations applied: ${state.applied.length ? state.applied.join(', ') : '(none)'}`];
  lines.push(state.reason);
  if (!state.migrated) {
    lines.push('Run `pnpm db:migrate` first if you expected migrated fixtures.');
  }
  return lines.join('\n');
}

if (isMainModule()) {
  const env = loadEnv();
  const state = await inspectSeedState(env.DATABASE_URL_MIGRATOR);
  console.log(buildSeedReport(state));
  process.exit(state.migrated ? 0 : 1);
}