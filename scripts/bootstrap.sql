-- Phase 1 database bootstrap.
-- Run ONCE as a PostgreSQL superuser (e.g. the password you set during the
-- Windows PostgreSQL 18 installer), BEFORE the first `pnpm db:migrate`. The two
-- role passwords are supplied at run time via psql variables — this file
-- contains NO literal credentials and refuses to run without them:
--
--   "/c/Program Files/PostgreSQL/18/bin/psql.exe" -h 127.0.0.1 -U postgres \
--     -v MIGRATOR_PASSWORD=<migrator-password> \
--     -v APP_RW_PASSWORD=<app-password> \
--     -f scripts/bootstrap.sql
--
-- After it completes, put the same passwords into the (git-ignored) root .env:
--   DATABASE_URL_MIGRATOR=postgresql://school_migrator:<migrator-password>@127.0.0.1:5432/school_saas_dev
--   DATABASE_URL_APP=postgresql://school_app_rw:<app-password>@127.0.0.1:5432/school_saas_dev
--   DATABASE_URL_TEST=postgresql://school_app_rw:<app-password>@127.0.0.1:5432/school_saas_test
-- Then verify: `pnpm db:bootstrap` (read-only check) and `pnpm db:migrate`.
--
-- Creates two databases (dev + test) and two least-privilege roles:
--   school_migrator  -> owns schema objects, runs migrations (DDL)
--   school_app_rw    -> runtime role used by API + worker (DML only, no BYPASSRLS)
-- ---------------------------------------------------------------------------

-- Fail fast on any SQL error.
\set ON_ERROR_STOP on

-- Guard: refuse to run unless both passwords were provided externally.
-- `:\{?VAR\}` is psql's "variable is set" test; `:`'VAR'` is psql's quoted-literal
-- substitution (value is quoted + escaped by psql). No default is ever used.
\if :{?MIGRATOR_PASSWORD}
\if :{?APP_RW_PASSWORD}
  \echo 'bootstrap: using passwords supplied via -v MIGRATOR_PASSWORD / -v APP_RW_PASSWORD'
\else
  \echo 'ERROR: APP_RW_PASSWORD is not set. Rerun with: psql ... -v APP_RW_PASSWORD=<app-password> -f scripts/bootstrap.sql'
  SELECT CAST('bootstrap aborted: APP_RW_PASSWORD was not provided' AS integer);  -- abort (exit != 0)
  \quit
\endif
\else
  \echo 'ERROR: MIGRATOR_PASSWORD is not set. Rerun with: psql ... -v MIGRATOR_PASSWORD=<migrator-password> -f scripts/bootstrap.sql'
  SELECT CAST('bootstrap aborted: MIGRATOR_PASSWORD was not provided' AS integer);  -- abort (exit != 0)
  \quit
\endif

CREATE ROLE school_migrator LOGIN PASSWORD :'MIGRATOR_PASSWORD';
CREATE ROLE school_app_rw LOGIN PASSWORD :'APP_RW_PASSWORD';

CREATE DATABASE school_saas_dev OWNER school_migrator;
CREATE DATABASE school_saas_test OWNER school_migrator;

GRANT CONNECT ON DATABASE school_saas_dev TO school_app_rw;
GRANT CONNECT ON DATABASE school_saas_test TO school_app_rw;

-- Both roles may create temporary objects for exports/reports.
GRANT TEMPORARY ON DATABASE school_saas_dev TO school_app_rw;
GRANT TEMPORARY ON DATABASE school_saas_test TO school_app_rw;

-- Runtime role must never bypass RLS and is not a superuser. It must not own
-- tables (school_migrator grants privileges to it inside migrations).
-- safety check:
SELECT rolname, rolsuper,
       CASE WHEN rolcanlogin THEN 'can-login' ELSE 'ro' END AS login
FROM pg_roles
WHERE rolname IN ('school_migrator','school_app_rw');