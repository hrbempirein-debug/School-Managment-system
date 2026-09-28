-- =============================================================================
-- 0020_schema_migrations_runtime_protection.sql
--
-- Forward-only, idempotent. Removes the least-privilege runtime role's write
-- access to the migration ledger `schema_migrations`.
--
-- THE DEFECT THIS FIXES
-- `0001_init.sql` ends with:
--
--     GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO school_app_rw;
--     ALTER DEFAULT PRIVILEGES FOR ROLE school_migrator IN SCHEMA public
--         GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO school_app_rw;
--
-- The default-privileges clause is deliberate for APPLICATION tables: every
-- table in this schema is created by `school_migrator`, and without it
-- `school_app_rw` could not read or write any of them. So that grant stays.
--
-- `schema_migrations` is the one table that is NOT an application table, and it
-- is not created by a migration file at all. It is created by the migration
-- CLI, as `school_migrator`, with `create table if not exists`:
--
--     packages/db/src/cli/migrate.ts:23
--     packages/db/src/cli/migrate-down.ts:54 and :100
--     packages/db/src/cli/seed.ts:30
--
-- Because the CLI creates it as `school_migrator`, 0001's default privileges
-- swept it up and granted `school_app_rw` SELECT, INSERT, UPDATE and DELETE on
-- the migration ledger. `school_app_rw` is the role the API and worker connect
-- as, so a compromised application session could run
--
--     DELETE FROM schema_migrations;
--
-- and erase the record of which migrations had been applied. The ledger is the
-- only thing that makes "this database is at version N" true, so removing it
-- does not merely hide history - it makes the next `pnpm db:migrate` believe
-- nothing has run, which is a correctness and availability problem as much as
-- a confidentiality one.
--
-- WHY NO EXISTING MIGRATION IS EDITED
-- 0001-0019 are applied history. Changing a file that has already run on real
-- databases does not re-run it there, so the defect would persist on every
-- existing installation while looking fixed in the repository. The repair is
-- therefore additive, as a new forward migration.
--
-- WHAT THE RUNTIME ROLE LEGITIMATELY NEEDS: NOTHING
-- This was verified against the codebase rather than assumed. Every reference
-- to `schema_migrations` in the repository is a migrator-role access:
--
--     packages/db/src/cli/migrate.ts:12,14        (SELECT / INSERT)
--     packages/db/src/cli/migrate-down.ts:58,80,106 (SELECT / DELETE)
--     packages/db/src/cli/seed.ts:34              (SELECT)
--     packages/db/src/security/phase6-migration-regression.test.ts:320,423
--         -> both use the `mig` client built from DATABASE_URL_MIGRATOR
--            (line 235-242), not the app role
--     packages/db/src/testing/runtime-db.test.ts:158
--         -> explicitly getEnv().DATABASE_URL_MIGRATOR
--
-- No code path reads or writes the ledger as `school_app_rw`, so this revokes
-- ALL privileges rather than preserving SELECT "just in case". Least privilege
-- is the point: a grant nothing needs is a grant an attacker can use.
--
-- SCOPE DELIBERATELY LIMITED
-- 0001's ALTER DEFAULT PRIVILEGES is NOT revoked here. Doing so would strip
-- `school_app_rw` of DML on every future application table and break the
-- application. The default grant is correct for application tables; it is only
-- wrong for the migrator's own bookkeeping table, which already exists and is
-- fixed here by name.
--
-- `create table if not exists` means this table is created once. If it is ever
-- dropped and recreated, 0001's default privileges would re-grant, so the
-- regression test asserts the negative on every run rather than trusting that
-- the fix stays in place.
--
-- IDEMPOTENCE
-- REVOKE is inherently idempotent, and the table-existence guard makes a run
-- against a database that has no ledger yet a no-op instead of an error. The
-- closing assertion fails the migration - and therefore the whole
-- `pnpm db:migrate` run, since `applyMigrations` aborts on the first failure -
-- if any privilege survives, so the fix can never be silently half-applied.
-- =============================================================================

-- Guarded: a database whose ledger has not been created yet is left alone.
DO $guard$
BEGIN
    IF to_regclass('public.schema_migrations') IS NULL THEN
        RETURN;
    END IF;

    EXECUTE 'REVOKE ALL PRIVILEGES ON TABLE public.schema_migrations FROM school_app_rw';
    -- Belt and braces. Nothing grants this to PUBLIC today, but a ledger that
    -- is readable by any role is the same defect one indirection away.
    EXECUTE 'REVOKE ALL PRIVILEGES ON TABLE public.schema_migrations FROM PUBLIC';
END
$guard$;

-- Fail closed. `has_table_privilege` is evaluated as a superuser-free lookup
-- against the catalog, so this reports the grants that are actually in effect
-- rather than the grants this file intended to make.
DO $assert$
DECLARE
    v_role    text;
    v_privs   text[];
    v_survivor text;
BEGIN
    IF to_regclass('public.schema_migrations') IS NULL THEN
        RETURN;
    END IF;

    SELECT array_agg(p ORDER BY p)
      INTO v_privs
      FROM unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE',
                        'REFERENCES', 'TRIGGER'])
           AS p
     WHERE has_table_privilege('school_app_rw', 'public.schema_migrations', p);

    IF v_privs IS NOT NULL THEN
        SELECT string_agg(x, ', ')
          INTO v_survivor
          FROM unnest(v_privs) AS x;
        RAISE EXCEPTION
            'post-0020 assertion failed: role school_app_rw still holds % on public.schema_migrations; the runtime role must not be able to read or rewrite the migration ledger',
            v_survivor;
    END IF;
END
$assert$;

-- Guarded for the same reason as the blocks above: PostgreSQL has no
-- `COMMENT ON TABLE IF EXISTS`, so an unguarded COMMENT would make this file error
-- out on a database that has no ledger yet, which contradicts the guard that precedes
-- it. Running this file directly with psql against an empty database hits exactly that
-- path, because only the CLI creates the table first.
DO $comment$
BEGIN
    IF to_regclass('public.schema_migrations') IS NOT NULL THEN
        EXECUTE $c$COMMENT ON TABLE public.schema_migrations IS
            'Applied-migration ledger. Migrator role only: revoked from school_app_rw by 0020 so the API/worker role cannot erase migration history.'$c$;
    END IF;
END
$comment$;
