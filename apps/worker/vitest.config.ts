import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // Live Redis/BullMQ + DB-backed suites share one disposable Redis/Postgres; running
    // test files in parallel would cross-claim fixtures and break assertions.
    fileParallelism: false,
    // F-05: the DB-backed suites are pointed at a disposable PostgreSQL database,
    // never at school_saas_dev. See @sms/db/src/testing/runtime-db.ts.
    globalSetup: ['../../packages/db/src/testing/global-setup.ts'],
    setupFiles: ['../../packages/db/src/testing/setup-env.ts'],
  },
});