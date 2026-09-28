-- 0004: Phase 2B.3 school-domain foundation (forward-only).
--
-- Adds the tenant-scoped school domain beneath the Phase 2B.2 authorization
-- layer: campuses, academic_years, academic_terms, holidays, calendars,
-- calendar_events, departments and school_settings.
--
-- SECURITY MODEL (inherited from 0002/0003)
--   * Every table is FORCE ROW LEVEL SECURITY. Policies trust ONLY the signed
--     context ticket (app_current_tenant_id()/app_privileged()); no raw
--     current_setting('app.*') is ever read, and no BYPASSRLS / SET ROLE /
--     SECURITY DEFINER shortcuts are used.
--   * The runtime role (school_app_rw) can see and mutate only rows whose
--     tenant_id equals the signed tenant claim. The privileged executor
--     (school_migrator) is the sole DELETE-capable and cross-tenant role.
--   * tenant_id derives from the trusted context in the API layer and is
--     enforced here WITH CHECK; cross-tenant INSERT/UPDATE is impossible even
--     if application authz is bypassed.
--   * Cross-table tenant integrity uses composite tenant-aware foreign keys:
--     parents expose UNIQUE (tenant_id, id); children FK (tenant_id, parent_id)
--     to that (tenant_id, id). A cross-tenant parent reference fails at the DB
--     before any business rule runs (terms->academic_years,
--     calendar_events->calendars, holidays->campuses).
--
-- BUSINESS RULES ENFORCED AT THE DB
--   * academic_years: starts_on < ends_on; draft -> active -> closed (no
--     backslide); a year cannot be closed while it has an open term.
--   * academic_terms: deterministic sequence (UNIQUE (academic_year_id,
--     sequence), dup codes blocked), dates must fall inside the parent year,
--     only one open term per year with overlapping dates, and a term cannot be
--     opened inside a closed year.
--   * holidays: ends_on >= starts_on; campus scope optional but tenant-bound.
--   * calendar_events: ends_at > starts_at always; calendar is tenant-bound.
--   * school_settings: exactly one row per tenant (UNIQUE (tenant_id)).
--   * campuses/departments/calendars: status CHECK + tenant-local unique codes.
--
-- Note: memberships.campus_id (from 0001) is carried by the API context but is
-- NOT a trusted authorization boundary; it is intentionally left unmodified so
-- its semantics stay discoverable. Campus-level RLS is out of scope for 2B.3.

-- ================================================================== campuses
CREATE TABLE campuses (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id  uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    code       text NOT NULL,
    name       text NOT NULL,
    address    text,
    city       text,
    country    text,
    status     text NOT NULL DEFAULT 'active',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz,
    CONSTRAINT campuses_status_ck CHECK (status IN ('active', 'inactive'))
);
-- Tenant-local uniqueness for live rows, allowed across deleted history.
CREATE UNIQUE INDEX campuses_tenant_code_uq ON campuses (tenant_id, code)
    WHERE deleted_at IS NULL;
CREATE INDEX campuses_tenant_status_idx ON campuses (tenant_id, status)
    WHERE deleted_at IS NULL;
-- Composite tenant-aware FK anchor (holidays.campus_id references this).
CREATE UNIQUE INDEX campuses_tenant_id_uq ON campuses (tenant_id, id);

-- ================================================================== academic_years
CREATE TABLE academic_years (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id  uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    code       text NOT NULL,
    name       text NOT NULL,
    starts_on  date NOT NULL,
    ends_on    date NOT NULL,
    status     text NOT NULL DEFAULT 'draft',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz,
    CONSTRAINT academic_years_dates_ck CHECK (starts_on < ends_on),
    CONSTRAINT academic_years_status_ck CHECK (status IN ('draft', 'active', 'closed'))
);
CREATE UNIQUE INDEX academic_years_tenant_code_uq ON academic_years (tenant_id, code)
    WHERE deleted_at IS NULL;
CREATE INDEX academic_years_tenant_status_idx ON academic_years (tenant_id, status)
    WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX academic_years_tenant_id_uq ON academic_years (tenant_id, id);

-- ================================================================== academic_terms
CREATE TABLE academic_terms (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id        uuid NOT NULL,
    academic_year_id uuid NOT NULL,
    code             text NOT NULL,
    name             text NOT NULL,
    sequence         integer NOT NULL,
    starts_on        date NOT NULL,
    ends_on          date NOT NULL,
    status           text NOT NULL DEFAULT 'draft',
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),
    deleted_at       timestamptz,
    CONSTRAINT academic_terms_parent_fk FOREIGN KEY (tenant_id, academic_year_id)
        REFERENCES academic_years (tenant_id, id) ON DELETE CASCADE,
    CONSTRAINT academic_terms_dates_ck CHECK (starts_on < ends_on),
    CONSTRAINT academic_terms_sequence_ck CHECK (sequence >= 1),
    CONSTRAINT academic_terms_status_ck CHECK (status IN ('draft', 'open', 'closed'))
);
CREATE UNIQUE INDEX academic_terms_tenant_code_uq ON academic_terms (tenant_id, code)
    WHERE deleted_at IS NULL;
-- Deterministic, non-overlapping ordering within a year.
CREATE UNIQUE INDEX academic_terms_year_seq_uq ON academic_terms (academic_year_id, sequence)
    WHERE deleted_at IS NULL;
CREATE INDEX academic_terms_year_status_idx ON academic_terms (academic_year_id, status)
    WHERE deleted_at IS NULL;

-- ================================================================== holidays
CREATE TABLE holidays (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id  uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    campus_id  uuid,
    name       text NOT NULL,
    starts_on  date NOT NULL,
    ends_on    date NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz,
    CONSTRAINT holidays_dates_ck CHECK (ends_on >= starts_on)
);
-- A holiday may target a campus; the campus must belong to the SAME tenant.
ALTER TABLE holidays ADD CONSTRAINT holidays_campus_fk
    FOREIGN KEY (tenant_id, campus_id) REFERENCES campuses (tenant_id, id);
CREATE INDEX holidays_tenant_range_idx ON holidays (tenant_id, starts_on, ends_on)
    WHERE deleted_at IS NULL;

-- ================================================================== calendars
CREATE TABLE calendars (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id  uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    code       text NOT NULL,
    name       text NOT NULL,
    type       text NOT NULL DEFAULT 'general',
    status     text NOT NULL DEFAULT 'active',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz,
    CONSTRAINT calendars_status_ck CHECK (status IN ('active', 'archived')),
    CONSTRAINT calendars_type_ck CHECK (type IN ('general', 'academic'))
);
CREATE UNIQUE INDEX calendars_tenant_code_uq ON calendars (tenant_id, code)
    WHERE deleted_at IS NULL;
CREATE INDEX calendars_tenant_status_idx ON calendars (tenant_id, status)
    WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX calendars_tenant_id_uq ON calendars (tenant_id, id);

-- ================================================================== calendar_events
CREATE TABLE calendar_events (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   uuid NOT NULL,
    calendar_id uuid NOT NULL,
    title       text NOT NULL,
    description text,
    starts_at   timestamptz NOT NULL,
    ends_at     timestamptz NOT NULL,
    all_day     boolean NOT NULL DEFAULT false,
    location    text,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    deleted_at  timestamptz,
    CONSTRAINT calendar_events_calendar_fk FOREIGN KEY (tenant_id, calendar_id)
        REFERENCES calendars (tenant_id, id) ON DELETE CASCADE,
    CONSTRAINT calendar_events_times_ck CHECK (ends_at > starts_at)
);
CREATE INDEX calendar_events_calendar_range_idx ON calendar_events (calendar_id, starts_at, ends_at)
    WHERE deleted_at IS NULL;

-- ================================================================== departments
CREATE TABLE departments (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id  uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    code       text NOT NULL,
    name       text NOT NULL,
    status     text NOT NULL DEFAULT 'active',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz,
    CONSTRAINT departments_status_ck CHECK (status IN ('active', 'inactive'))
);
CREATE UNIQUE INDEX departments_tenant_code_uq ON departments (tenant_id, code)
    WHERE deleted_at IS NULL;
CREATE INDEX departments_tenant_status_idx ON departments (tenant_id, status)
    WHERE deleted_at IS NULL;

-- ================================================================== school_settings
-- Singleton per tenant: exactly one live settings row per tenant_id.
CREATE TABLE school_settings (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id      uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    school_name    text NOT NULL,
    school_code    text,
    email          text,
    phone          text,
    address        text,
    timezone       text NOT NULL DEFAULT 'UTC',
    locale         text NOT NULL DEFAULT 'en',
    branding_color text,
    logo_path      text,
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT school_settings_tenant_uq UNIQUE (tenant_id)
);

-- ================================================================== RLS
-- All eight tables: FORCE row level security; tenant-branch CRUD for any row
-- whose tenant_id equals the signed tenant claim, privileged executor escapes
-- for maintenance/cross-tenant operations. Hard DELETE is privileged-only, so
-- the runtime role can only soft-delete (update deleted_at), never destroy.
DO $$
DECLARE
    t text;
BEGIN
    FOREACH t IN ARRAY ARRAY[
        'campuses', 'academic_years', 'academic_terms', 'holidays',
        'calendars', 'calendar_events', 'departments', 'school_settings'
    ] LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
        EXECUTE format(
            'CREATE POLICY %I ON %I FOR SELECT USING (
                 (tenant_id = app_current_tenant_id() AND app_current_tenant_id() IS NOT NULL)
                 OR app_privileged()
             )', t || '_select', t);
        EXECUTE format(
            'CREATE POLICY %I ON %I FOR INSERT WITH CHECK (
                 (tenant_id = app_current_tenant_id() AND app_current_tenant_id() IS NOT NULL)
                 OR app_privileged()
             )', t || '_insert', t);
        EXECUTE format(
            'CREATE POLICY %I ON %I FOR UPDATE USING (
                 (tenant_id = app_current_tenant_id() AND app_current_tenant_id() IS NOT NULL)
                 OR app_privileged()
             ) WITH CHECK (
                 (tenant_id = app_current_tenant_id() AND app_current_tenant_id() IS NOT NULL)
                 OR app_privileged()
             )', t || '_update', t);
        EXECUTE format(
            'CREATE POLICY %I ON %I FOR DELETE USING (app_privileged())',
            t || '_delete', t);
    END LOOP;
END
$$;

-- Explicit runtime grants (idempotent with 0001 default privileges).
GRANT SELECT, INSERT, UPDATE, DELETE ON
    campuses, academic_years, academic_terms, holidays,
    calendars, calendar_events, departments, school_settings TO school_app_rw;

-- ================================================================== domain triggers
-- All trigger functions are SECURITY INVOKER: subqueries run under the invoking
-- role and its RLS, so the tendency checks are automatically tenant-local.

-- Academic year lifecycle: draft -> active -> closed, no backslide, and a year
-- may not be closed while it still has an open term.
CREATE OR REPLACE FUNCTION trg_academic_years_state() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = public, pg_catalog
AS $$
BEGIN
    IF NEW.status = OLD.status THEN
        RETURN NEW;
    END IF;
    IF NOT (
        (OLD.status = 'draft' AND NEW.status IN ('active', 'closed'))
        OR (OLD.status = 'active' AND NEW.status = 'closed')
    ) THEN
        RAISE EXCEPTION 'invalid academic year status transition: % -> %', OLD.status, NEW.status
            USING ERRCODE = '55000';
    END IF;
    IF NEW.status = 'closed' THEN
        PERFORM 1 FROM academic_terms
            WHERE academic_year_id = NEW.id AND status = 'open' AND deleted_at IS NULL;
        IF FOUND THEN
            RAISE EXCEPTION 'cannot close academic year with open terms'
                USING ERRCODE = '55000';
        END IF;
    END IF;
    RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS academic_years_state_trg ON academic_years;
CREATE TRIGGER academic_years_state_trg
    BEFORE UPDATE ON academic_years
    FOR EACH ROW EXECUTE FUNCTION trg_academic_years_state();

-- Academic term validation: parent year must exist with matching tenant, term
-- dates must fit inside the year, a term cannot be opened inside a closed year,
-- and only one open term per year may span any given day.
CREATE OR REPLACE FUNCTION trg_academic_terms_validate() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = public, pg_catalog
AS $$
DECLARE
    y academic_years%ROWTYPE;
BEGIN
    IF NEW.status = OLD.status AND TG_OP = 'UPDATE' THEN
        RETURN NEW;
    END IF;
    SELECT * INTO y FROM academic_years
        WHERE id = NEW.academic_year_id AND tenant_id = NEW.tenant_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'academic year not found for term'
            USING ERRCODE = '23503';
    END IF;
    IF NEW.starts_on < y.starts_on OR NEW.ends_on > y.ends_on THEN
        RAISE EXCEPTION 'term dates must fall inside the academic year'
            USING ERRCODE = '55000';
    END IF;
    IF NEW.status = 'open' THEN
        IF y.status = 'closed' THEN
            RAISE EXCEPTION 'cannot open a term inside a closed academic year'
                USING ERRCODE = '55000';
        END IF;
        PERFORM 1 FROM academic_terms t
            WHERE t.academic_year_id = NEW.academic_year_id
              AND t.id IS DISTINCT FROM NEW.id
              AND t.deleted_at IS NULL
              AND t.status = 'open'
              AND (t.starts_on, t.ends_on) OVERLAPS (NEW.starts_on, NEW.ends_on);
        IF FOUND THEN
            RAISE EXCEPTION 'overlapping open terms within academic year'
                USING ERRCODE = '55000';
        END IF;
    END IF;
    RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS academic_terms_validate_trg ON academic_terms;
CREATE TRIGGER academic_terms_validate_trg
    BEFORE INSERT OR UPDATE ON academic_terms
    FOR EACH ROW EXECUTE FUNCTION trg_academic_terms_validate();