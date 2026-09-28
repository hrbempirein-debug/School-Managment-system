import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // DB-backed security suites share ONE DISPOSABLE database (school_saas_test),
    // never the development database: running test files in parallel lets them read
    // each other's fixtures mid-run and breaks global assertions. Serially
    // executing files keeps global-count checks valid.
    fileParallelism: false,
    // F-05: the disposable database is validated, created and migrated once per run,
    // before any worker starts, and each worker re-points the two connection
    // variables before it imports anything. See src/testing/runtime-db.ts for why
    // there is no override that permits running against school_saas_dev.
    globalSetup: ['./src/testing/global-setup.ts'],
    setupFiles: ['./src/testing/setup-env.ts'],
  },
});