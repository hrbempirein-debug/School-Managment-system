import { readdir } from 'node:fs/promises';
import { describe, it, expect } from 'vitest';
import { parseArgs, downFileName, DOWN_SUFFIX } from './migrate-down.js';
import { migrationsDir } from './paths.js';

describe('migrate-down arg parsing', () => {
  it('refuses to roll back without an explicit --yes (destructive confirmation)', () => {
    expect(parseArgs([]).yes).toBe(false);
    expect(parseArgs(['--revision=0002_x.sql']).yes).toBe(false);
  });

  it('accepts an explicit --yes / -y flag', () => {
    expect(parseArgs(['--yes']).yes).toBe(true);
    expect(parseArgs(['-y']).yes).toBe(true);
    expect(parseArgs(['--yes', '--revision=0002_x.sql']).yes).toBe(true);
  });

  it('parses an optional --revision target', () => {
    expect(parseArgs(['--revision=0002_x.sql']).revision).toBe('0002_x.sql');
    expect(parseArgs([]).revision).toBeUndefined();
  });
});

describe('rollback file convention', () => {
  it('maps 0001_init.sql to 0001_init.down.sql', () => {
    expect(downFileName('0001_init.sql')).toBe(`0001_init${DOWN_SUFFIX}`);
  });
});

describe('forward-fix-only migration policy', () => {
  it('currently ships NO rollback (down) SQL for Phase 1 migrations', async () => {
    const files = await readdir(migrationsDir);
    const downFiles = files.filter((f) => f.endsWith(DOWN_SUFFIX));
    expect(downFiles).toEqual([]);
  });
});