import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // DB-backed security suites share one dev database (school_saas_dev); running test
    // files in parallel lets them read each other's fixtures mid-run and breaks global
    // assertions. Serially executing files keeps global-count checks valid.
    fileParallelism: false,
  },
});