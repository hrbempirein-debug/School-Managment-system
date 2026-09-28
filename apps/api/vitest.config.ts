import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // Bump the global per-IP gateway ceiling for the DB + Redis-backed security
    // suites: one serial macro-run issues more than the 300/min production
    // default, which is a firewall posture, not something under test.
    env: { RATE_LIMIT_MAX: '100000' },
    // DB-backed security suites share ONE DISPOSABLE database (school_saas_test),
    // never the development database: running test files in parallel lets them read
    // each other's fixtures mid-run. Serially executing files keeps fixtures and
    // cleanup deterministic. F-05 — see @sms/db/src/testing/runtime-db.ts.
    fileParallelism: false,
    globalSetup: ['../../packages/db/src/testing/global-setup.ts'],
    setupFiles: ['../../packages/db/src/testing/setup-env.ts'],
  },
});