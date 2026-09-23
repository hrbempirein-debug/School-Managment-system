import { describe, it, expect } from 'vitest';
import { buildSeedReport } from './seed.js';

describe('seed report (Phase 1 seed contract not defined)', () => {
  it('reports nothing was created when migrations are applied', () => {
    const report = buildSeedReport({
      migrated: true,
      applied: ['0001_init.sql'],
      reason:
        'seed fixtures intentionally deferred: no Phase 1 seed contract defined yet. Nothing was created or modified.',
    });
    expect(report).toContain('0001_init.sql');
    expect(report).toContain('seed fixtures intentionally deferred');
    expect(report).not.toMatch(/password|secret|token/i);
  });

  it('reminds the operator to migrate when nothing is applied', () => {
    const report = buildSeedReport({
      migrated: false,
      applied: [],
      reason:
        'seed fixtures intentionally deferred: no Phase 1 seed contract defined yet. Nothing was created or modified.',
    });
    expect(report).toContain('pnpm db:migrate');
  });
});