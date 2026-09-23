import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { migrationsDir, packageRoot } from './paths.js';

describe('migrations directory resolution (BUG 2 regression)', () => {
  it('resolves to <packageRoot>/migrations, not the old src/migrations path', () => {
    const srcDir = path.dirname(fileURLToPath(import.meta.url));
    expect(migrationsDir).toBe(path.join(packageRoot, 'migrations'));
    expect(migrationsDir).not.toBe(path.resolve(srcDir, '../migrations'));
    expect(path.resolve(srcDir, '../migrations')).toBe(path.join(packageRoot, 'src', 'migrations'));
  });

  it('points at an existing directory containing the migration file', async () => {
    const contents = await readFile(path.join(migrationsDir, '0001_init.sql'), 'utf8');
    expect(contents.length).toBeGreaterThan(0);
  });

  it('is derived from import.meta.url under <packageRoot>/src/cli, never from process.cwd()', () => {
    const srcDir = path.dirname(fileURLToPath(import.meta.url));
    expect(packageRoot).toBe(path.resolve(srcDir, '../..'));
    expect(migrationsDir).toBe(path.join(packageRoot, 'migrations'));
  });
});