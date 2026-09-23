import { existsSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { envFilePath, loadEnv, resetEnv } from './index.js';

describe('root .env loading (BUG 1 regression)', () => {
  it('pins the env file to the workspace root regardless of CWD', () => {
    const dir = path.dirname(envFilePath);
    const workspaceMarker = path.join(dir, 'pnpm-workspace.yaml');
    expect(envFilePath.includes('.env')).toBe(true);
    expect(existsSync(workspaceMarker)).toBe(true);
  });

  it('parses a valid environment (loaded from the root .env file)', () => {
    resetEnv();
    const env = loadEnv();
    expect(env.DATABASE_URL_MIGRATOR.length).toBeGreaterThan(0);
    expect(env.DATABASE_URL_APP.length).toBeGreaterThan(0);
    expect(env.API_PORT).toBeGreaterThan(0);
  });
});