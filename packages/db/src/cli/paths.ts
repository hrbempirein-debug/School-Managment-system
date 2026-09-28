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

/**
 * True when the module identified by `metaUrl` is the process entry point
 * (`tsx .../cli/foo.ts`), rather than merely imported by it.
 *
 * `metaUrl` must be the *caller's* `import.meta.url`. A default of
 * `import.meta.url` inside this file would resolve to `paths.ts` itself, so the
 * comparison could only ever succeed for `paths.ts` and would silently return
 * `false` for every real CLI entry point.
 */
export const isMainModule = (metaUrl: string): boolean => {
  const arg = process.argv[1];
  if (!arg) return false;
  try {
    return path.resolve(arg) === path.resolve(fileURLToPath(metaUrl));
  } catch {
    return false;
  }
};