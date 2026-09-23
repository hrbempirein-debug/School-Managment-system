import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * Absolute path of the `@sms/db` package root.
 *
 * `import.meta.url` always points at this file's real location, so this works
 * identically when running from source via tsx (`packages/db/src/cli`) and from
 * compiled output (`packages/db/dist/cli`) without depending on `process.cwd()`.
 */
export const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** Directory holding the SQL migration files for this package. */
export const migrationsDir = path.join(packageRoot, 'migrations');

/** True when this module was invoked directly (tsx .../cli/foo.ts), not imported. */
export const isMainModule = (): boolean => {
  const arg = process.argv[1];
  if (!arg) return false;
  try {
    return path.resolve(arg) === path.resolve(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
};