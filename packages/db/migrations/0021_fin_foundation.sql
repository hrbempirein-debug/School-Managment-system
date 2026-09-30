-- =============================================================================
-- 0021_fin_foundation.sql
--
-- WHAT
-- Phase 7 (Fees & Finance) migration 1 of 9. Creates the five foundation
-- tables the rest of the finance graph hangs off, the `(tenant_id, id)` anchor
-- indexes that make the composite-FK rule *legal by declaration* on existing
-- Phase 1-6 tables, and the four no-argument context helpers that every later
-- finance RLS policy is written against.
--
-- Creates, completely:
--   fin_tenant_settings, fin_ledger_accounts, fin_document_counters,
--   fin_fee_heads, fin_tax_profiles
--   12 anchor indexes on existing tables (section 3 below)
--   F1 app_finance_actor_class()          - actor classification for policies
--   F2 app_finance_linked_students()     - student reachability for guardians
--   F6 app_finance_current_guardian_ids()- guardian reachability for receipts
--   F3 app_finance_seeds_ledger_accounts(uuid) - the fixed 9-row chart
--
-- WHY THIS FILE IS DELIBERATELY UNREACHABLE
-- 0001_init.sql runs, for role school_migrator in schema public,
--
--     ALTER DEFAULT PRIVILEGES GRANT SELECT, INSERT, UPDATE, DELETE
--         ON TABLES TO school_app_rw
--
-- so every table created from 0021 onward is granted to the runtime role the
-- instant it is created, before any policy exists. Two facts are then easy to
-- confuse and both are security properties:
--
--   * "granted, but RLS not yet enabled" FAILS OPEN. PostgreSQL does not
--     enforce RLS on a table whose RLS was never enabled, so a policy created
--     later is inert until ALTER TABLE ... ENABLE ROW LEVEL SECURITY runs.
--     For the whole 0021-0027 window a committed finance table would therefore
--     have been readable and writable by school_app_rw across EVERY tenant.
--   * "revoked, but RLS not yet enabled" FAILS CLOSED. SELECT and every write
--     raise 42501 until 0028 enables and forces RLS and then grants.
--
-- Every CREATE TABLE below is therefore followed immediately, in the same file
-- and therefore the same transaction, by
--
--     REVOKE ALL ON <t> FROM school_app_rw;
--
-- and 0028 is the only migration that grants school_app_rw anything at all on
-- a fin_* table, sequenced so RLS precedes every grant. The transaction
-- boundary alone is not the control: it prevents other sessions from *seeing*
-- the table, but the ACL entry would still have existed cluster-wide. Only the
-- REVOKE is the privilege argument.
--
-- The four functions here are the deliberate exception: they read membership
-- and guardian relationships and return no money, and F1/F2/F6 are the
-- predicates 0028's policies are built from, so they are granted to
-- school_app_rw explicitly. F3 seeds a tenant's chart of accounts and is
-- owner-retained only - no route calls it.
--
-- WHY NO EXISTING MIGRATION IS EDITED
-- 0001-0020 are applied history. Changing a file that has already run on real
-- databases does not re-run it there, so any change would persist in the
-- repository while having no effect on any existing installation. Everything
-- here is additive, forward-only, and idempotent.
--
-- DEPENDENCY NOTES THAT ARE NOT OBVIOUS
--   * fin_tax_profiles is created AFTER fin_tenant_settings even though
--     fin_tenant_settings.tax_profile_id references it. The two are declared in
--     that order so the constraint is added by ALTER TABLE once the target
--     exists - a forward reference would fail, and there is no reason to
--     reorder the tables to avoid one ALTER.
--   * The anchor indexes come first. fin_billing_run_items,
--     fin_fee_assignments and fin_invoices all FK to enrollments(tenant_id, id)
--     from 0022 onward, and enrollments_tenant_id_uq does not exist yet in
--     0005. Declaring the anchors before the tables keeps the "targets before
--     referrers" order true in this file as well as across files.
--   * No trigger function in this file declares a row type, and none references
--     a table created by a later migration. The composite-type ordering rule
--     (a plpgsql DECLARE of a table's row type is resolved at CREATE FUNCTION
--     with 42704, while a body statement is not) has no bite in 0021; its two
--     real instances are both in 0024/0025.
--
-- IDEMPOTENCE
-- CREATE TABLE is not re-runnable, but the runner records a migration only
-- after it commits and refuses to re-apply a recorded file, so 0021 runs
-- exactly once. Everything in it that is re-runnable - the anchor indexes and
-- the four functions - is written to be: IF NOT EXISTS on the indexes,
-- CREATE OR REPLACE on the functions. The closing assertion fails the
-- migration - and with it the whole `pnpm db:migrate` run, since
-- applyMigrations aborts on the first failure - if the unreachable state this
-- file exists to establish does not hold.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Anchor indexes on existing tables.
--
-- Tenants reference existing Phase 1-6 tables by (tenant_id, id). A composite
-- FK is only legal if the referenced columns are covered by a UNIQUE or
-- PRIMARY KEY constraint, and every existing table here declares
-- `id uuid PRIMARY KEY` - so (tenant_id, id) is already unique in all of them
-- and CREATE UNIQUE INDEX cannot fail. These are additive index creations with
-- no behavioural effect and no data migration: they exist purely so the FK is
-- legal by declaration and so the composite-FK test has something to assert.
--
-- Three of the twelve (academic_terms, enrollments, report_card_subjects) were
-- already anchored by an earlier migration; IF NOT EXISTS leaves them
-- untouched, which is the required behaviour rather than an accident.
-- -----------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS enrollments_tenant_id_uq
    ON enrollments (tenant_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS student_guardians_tenant_id_uq
    ON student_guardians (tenant_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS academic_terms_tenant_id_uq
    ON academic_terms (tenant_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS holidays_tenant_id_uq
    ON holidays (tenant_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS calendar_events_tenant_id_uq
    ON calendar_events (tenant_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS departments_tenant_id_uq
    ON departments (tenant_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS school_settings_tenant_id_uq
    ON school_settings (tenant_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS student_documents_tenant_id_uq
    ON student_documents (tenant_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS admission_applications_tenant_id_uq
    ON admission_applications (tenant_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS transfers_tenant_id_uq
    ON transfers (tenant_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS promotion_items_tenant_id_uq
    ON promotion_items (tenant_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS report_card_subjects_tenant_id_uq
    ON report_card_subjects (tenant_id, id);


-- -----------------------------------------------------------------------------
-- 2. The five foundation tables.
-- -----------------------------------------------------------------------------

-- 2.1 fin_tenant_settings -- per-tenant money configuration, exactly one row.
--
-- currency is text rather than an enum so that adding a currency is a new
-- CHECK value and not a type change on every dependent view. Only PKR is
-- accepted for go-live.
--
-- tax_profile_id is NULLABLE and NULL by default: a school with no tax
-- registration has no profile, and a NOT NULL FK here would force every tenant
-- to invent one. Invoice issue treats NULL as "untaxed", not as an error.
--
-- webhook_raw_retention_days defaults to 0, meaning "never store a raw body".
-- The encryption that would make a non-zero value safe is NOT implemented in
-- Phase 7, so 0 is the only legitimate value today and anything else is an
-- owner's decision to make later rather than this migration's to enable.
CREATE TABLE fin_tenant_settings (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           uuid NOT NULL,
    currency            text NOT NULL DEFAULT 'PKR'
                        CHECK (currency IN ('PKR')),
    tax_profile_id      uuid,
    webhook_raw_retention_days integer NOT NULL DEFAULT 0
                        CHECK (webhook_raw_retention_days >= 0),
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    -- tenants IS the tenant: a composite anchor would be (id, id), so the
    -- single-column reference is correct here and is on the section 6.3 R4
    -- allowlist.
    CONSTRAINT fin_tenant_settings_tenant_fk
        FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE CASCADE,
    -- Exactly one settings row per tenant. This is also what makes the 0028
    -- backfill idempotent via ON CONFLICT (tenant_id).
    CONSTRAINT fin_tenant_settings_tenant_uq UNIQUE (tenant_id),
    CONSTRAINT fin_tenant_settings_ten_id_uq UNIQUE (tenant_id, id)
);
-- Undo 0001's ALTER DEFAULT PRIVILEGES grant in the same transaction that
-- created the table. See the header.
REVOKE ALL ON fin_tenant_settings FROM school_app_rw;


-- 2.2 fin_ledger_accounts -- the fixed chart of accounts, seeded per tenant.
--
-- `code` is the business key and is what a ledger leg carries, rather than
-- this table's id: a posting that says "Dr 1200" should carry 1200, not a uuid
-- an auditor cannot read. That is why fin_ledger_entries.account_code FKs this
-- column and not this table's primary key - and why the UNIQUE is
-- (tenant_id, code) and not (tenant_id, id).
--
-- is_contra exists because 4100 "Fee Income - Concessions & Waivers" is
-- revenue whose normal side is DEBIT. A CHECK that said "revenue implies
-- credit" rejected 4100 at insert, so the seed function's own INSERT raised
-- 23514 and the chart could not be seeded at all. The flag makes the exception
-- explicit and machine-checked, and the constraint below pins it to the only
-- combination that is real: contra accounts are revenue-and-debit, and a
-- non-contra account must not be. Without the NOT is_contra clause on the
-- revenue arm, is_contra would be decorative.
--
-- 1300 is a liability precisely because it is over-payment; the asset treatment
-- is rejected explicitly. The side constraint is what stops an on-account
-- return from being posted as Dr 1200.
CREATE TABLE fin_ledger_accounts (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid NOT NULL,
    code            text NOT NULL CHECK (code IN
                    ('1000','1100','1200','1300','2200','4000','4100','4200','4900')),
    name            text NOT NULL,
    account_class   text NOT NULL CHECK (account_class IN ('asset','liability','revenue')),
    is_contra       boolean NOT NULL DEFAULT false,
    normal_side     text NOT NULL CHECK (normal_side IN ('debit','credit')),
    -- Seeded rows are system-owned and may not be renamed or recoded. A tenant
    -- may not add accounts: the chart is fixed, and an extension point is an
    -- owner decision, not a per-tenant one.
    is_system       boolean NOT NULL DEFAULT true,
    created_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT fin_ledger_accounts_tenant_fk
        FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE CASCADE,
    -- The FK target for fin_ledger_entries.account_code. Required, not incidental.
    CONSTRAINT fin_ledger_accounts_code_uq UNIQUE (tenant_id, code),
    -- Anchor uniformity: declared even though nothing FKs on id.
    CONSTRAINT fin_ledger_accounts_ten_id_uq UNIQUE (tenant_id, id),
    -- A class and a normal side that disagree is this defect in column form.
    -- Enforced here so F4's jsonb validation and this constraint cannot
    -- disagree about what an account means.
    CONSTRAINT fin_ledger_accounts_side_ck CHECK (
        (account_class = 'asset'     AND normal_side = 'debit'  AND NOT is_contra)
     OR (account_class = 'liability' AND normal_side = 'credit' AND NOT is_contra)
     OR (account_class = 'revenue'   AND normal_side = 'credit' AND NOT is_contra)
     OR (account_class = 'revenue'   AND normal_side = 'debit'  AND     is_contra)
    )
);
REVOKE ALL ON fin_ledger_accounts FROM school_app_rw;


-- 2.3 fin_document_counters -- per-tenant, per-year, per-kind sequence source.
--
-- The counter is a ROW, not a sequence. A PostgreSQL sequence is global to the
-- database, cannot be scoped per tenant, and cannot be reset or audited per
-- tenant. UNIQUE (tenant_id, academic_year_id, kind) is what makes advancing
-- it a single-row UPDATE with RETURNING, and therefore gap-free under
-- concurrency: two concurrent issues both take the row lock, so the second
-- reads the value the first wrote.
CREATE TABLE fin_document_counters (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid NOT NULL,
    academic_year_id uuid NOT NULL,
    -- Closed, so a new document kind is a reviewable schema change rather than
    -- a value a route can invent.
    kind            text NOT NULL CHECK (kind IN ('invoice','receipt','challan')),
    last_value      bigint NOT NULL DEFAULT 0 CHECK (last_value >= 0),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT fin_document_counters_year_fk
        FOREIGN KEY (tenant_id, academic_year_id)
        REFERENCES academic_years (tenant_id, id) ON DELETE RESTRICT,
    CONSTRAINT fin_document_counters_uq UNIQUE (tenant_id, academic_year_id, kind),
    CONSTRAINT fin_document_counters_ten_id_uq UNIQUE (tenant_id, id)
);
REVOKE ALL ON fin_document_counters FROM school_app_rw;


-- 2.4 fin_fee_heads -- the fee taxonomy.
--
-- A structure item names a head, and the head carries the tax treatment, so a
-- tax change is one row rather than a structure edit. is_waivable gates whether
-- a head may be the target of a concession at all, which stops a non-waivable
-- fee from being waived indirectly through a negative adjustment.
CREATE TABLE fin_fee_heads (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid NOT NULL,
    code            text NOT NULL,
    name            text NOT NULL,
    description     text,
    -- A head-level default a structure item may override, so a mixed invoice
    -- does not need a structure per head.
    tax_treatment   text NOT NULL DEFAULT 'none'
                    CHECK (tax_treatment IN ('none','exclusive','inclusive')),
    is_waivable     boolean NOT NULL DEFAULT true,
    is_active       boolean NOT NULL DEFAULT true,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT fin_fee_heads_tenant_fk
        FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE CASCADE,
    -- Referenced by fin_fee_structure_items via (tenant_id, fee_head_id).
    CONSTRAINT fin_fee_heads_ten_id_uq UNIQUE (tenant_id, id),
    CONSTRAINT fin_fee_heads_code_uq UNIQUE (tenant_id, code)
);
REVOKE ALL ON fin_fee_heads FROM school_app_rw;


-- 2.5 fin_tax_profiles -- created before fin_tenant_settings is backfilled,
-- because fin_tenant_settings.tax_profile_id references it.
--
-- tax_number is TEXT: Pakistani NTNs and STRNs are alphanumeric and
-- leading-zero significant, and an integer column would silently corrupt both.
CREATE TABLE fin_tax_profiles (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid NOT NULL,
    name            text NOT NULL,
    tax_number      text,
    rate            numeric(7,4) NOT NULL DEFAULT 0
                    CHECK (rate >= 0 AND rate <= 100),
    is_default      boolean NOT NULL DEFAULT false,
    is_active       boolean NOT NULL DEFAULT true,
    created_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT fin_tax_profiles_tenant_fk
        FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE CASCADE,
    CONSTRAINT fin_tax_profiles_ten_id_uq UNIQUE (tenant_id, id),
    CONSTRAINT fin_tax_profiles_name_uq UNIQUE (tenant_id, name)
);
REVOKE ALL ON fin_tax_profiles FROM school_app_rw;


-- The tax_profile_id FK is added here rather than inline on
-- fin_tenant_settings, because at the point that table was created
-- fin_tax_profiles did not exist yet.
--
-- ON DELETE SET NULL rather than RESTRICT: deleting a tax profile must not
-- cascade into deleting a tenant's entire money configuration, and nulling the
-- reference degrades to "untaxed", which is the safe direction.
--
-- The COLUMN LIST is required, and this is a correction to the design DDL
-- rather than a stylistic preference. Written as a bare
-- `ON DELETE SET NULL` on a composite foreign key, PostgreSQL nulls EVERY
-- referencing column, so the referential action tries to set
-- `fin_tenant_settings.tenant_id` to NULL as well and the delete dies with
-- `null value in column "tenant_id" ... violates not-null constraint`. The
-- documented intent - "the row survives, so tenant_id is left intact" - is
-- then unreachable through the bare form, and the failure surfaces on the first
-- tax-profile deletion rather than at migration time, which is the worst time
-- to find it. `ON DELETE SET NULL (tax_profile_id)` names the one column that
-- is meant to be cleared and leaves tenant_id intact.
--
-- The column-list form is PostgreSQL 15+; the CI service is postgres:16 and the
-- deployment target is 16 or later, so it is available everywhere this
-- repository is expected to run. A composite FK also permits NULL in any
-- referenced column, so a tenant with no tax profile is represented by
-- `tax_profile_id IS NULL` and no constraint is violated.
ALTER TABLE fin_tenant_settings
    ADD CONSTRAINT fin_tenant_settings_tax_profile_fk
    FOREIGN KEY (tenant_id, tax_profile_id)
    REFERENCES fin_tax_profiles (tenant_id, id) ON DELETE SET NULL (tax_profile_id);


-- -----------------------------------------------------------------------------
-- 3. The four context helpers.
--
-- F1, F2 and F6 are SECURITY DEFINER on purpose. The relationship joins they
-- perform must be provable even though memberships, roles, guardians and
-- student_guardians are themselves RLS-scoped; a SECURITY INVOKER version
-- would be filtered by the caller's context and could return an empty set for
-- a legitimate guardian, silently denying access - a security bug in the
-- availability direction.
--
-- All three take NO arguments, which is the property that makes definership
-- safe: a caller cannot pass a different tenant or a different user id. Their
-- only inputs are app_current_tenant_id() and app_ctx_user(), which come from
-- the HMAC-signed app.rls ticket that only app_ctx_mint() can produce, and only
-- for a user with a real active membership in that tenant. So obtaining any
-- finance row at all requires an active membership, and within the tenant a
-- caller sees only students they are actually the guardian of, or their own
-- student record.
-- -----------------------------------------------------------------------------

-- F1: classifies the current actor for finance row visibility.
CREATE OR REPLACE FUNCTION app_finance_actor_class() RETURNS text
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path = pg_catalog, public, pg_temp
AS $$
    SELECT CASE
        WHEN app_privileged() THEN 'system'
        WHEN app_ctx_scope() <> 'tenant' THEN 'none'
        WHEN EXISTS (
            SELECT 1 FROM memberships m
            JOIN membership_roles mr ON mr.membership_id = m.id
            JOIN roles r ON r.id = mr.role_id
            WHERE m.tenant_id = app_current_tenant_id()
              AND m.user_id = app_ctx_user()
              AND m.status = 'active'
              AND r.tenant_id = m.tenant_id
              AND r.code IN ('school_owner','accountant','cashier')
        ) THEN 'finance_staff'
        WHEN EXISTS (
            SELECT 1 FROM memberships m
            JOIN membership_roles mr ON mr.membership_id = m.id
            JOIN roles r ON r.id = mr.role_id
            WHERE m.tenant_id = app_current_tenant_id()
              AND m.user_id = app_ctx_user()
              AND m.status = 'active'
              AND r.tenant_id = m.tenant_id
              AND r.code = 'principal'
        ) THEN 'reporting_staff'
        WHEN EXISTS (
            SELECT 1 FROM guardians g
            JOIN student_guardians sg
              ON sg.tenant_id = g.tenant_id AND sg.guardian_id = g.id
            WHERE g.tenant_id = app_current_tenant_id()
              AND g.user_id = app_ctx_user() AND g.deleted_at IS NULL
              AND sg.deleted_at IS NULL
        ) THEN 'guardian'
        WHEN EXISTS (
            SELECT 1 FROM students s
            WHERE s.tenant_id = app_current_tenant_id()
              AND s.user_id = app_ctx_user() AND s.deleted_at IS NULL
        ) THEN 'student_self'
        ELSE 'none'
    END
$$;
REVOKE ALL ON FUNCTION app_finance_actor_class() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_finance_actor_class() TO school_app_rw;


-- F2: the student ids this actor may see, for the current tenant claim.
--
-- guardian is classified above student_self on purpose: a user who is both a
-- guardian and a student is a guardian, and gets the broader multi-child view.
CREATE OR REPLACE FUNCTION app_finance_linked_students() RETURNS SETOF uuid
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path = pg_catalog, public, pg_temp
AS $$
    SELECT sg.student_id
    FROM student_guardians sg
    JOIN guardians g
      ON g.tenant_id = sg.tenant_id AND g.id = sg.guardian_id
    WHERE sg.tenant_id = app_current_tenant_id()
      AND g.user_id = app_ctx_user()
      AND g.deleted_at IS NULL
      AND sg.deleted_at IS NULL
    UNION
    SELECT s.id FROM students s
    WHERE s.tenant_id = app_current_tenant_id()
      AND s.user_id = app_ctx_user() AND s.deleted_at IS NULL
$$;
REVOKE ALL ON FUNCTION app_finance_linked_students() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_finance_linked_students() TO school_app_rw;


-- F6: the guardian ids the current actor acts as, for the current tenant claim.
--
-- A SETOF rather than a scalar, and a separate helper from F2 rather than a
-- derivation from it. The invoice policy needs students and the receipt policy
-- needs guardians; those are different relations, and deriving one from the
-- other is exactly the many-to-many reasoning that produced a real disclosure
-- defect: a payment settling two siblings is reachable from both families, so
-- an existence test through the relationship discloses the amount to a
-- guardian who is not party to that particular charge. One user may also be
-- several guardians (a mother registered separately per child, which 0005
-- permits and real data will contain), so a scalar would silently pick one
-- child and hide the other's receipts.
CREATE OR REPLACE FUNCTION app_finance_current_guardian_ids() RETURNS SETOF uuid
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path = pg_catalog, public, pg_temp
AS $$
    SELECT g.id
    FROM guardians g
    WHERE g.tenant_id = app_current_tenant_id()
      AND g.user_id = app_ctx_user()
      AND g.deleted_at IS NULL
$$;
REVOKE ALL ON FUNCTION app_finance_current_guardian_ids() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_finance_current_guardian_ids() TO school_app_rw;


-- F3: seeds a tenant's chart of accounts. Owner-retained: no grant to
-- school_app_rw, because the caller context is school_migrator and there is no
-- route that calls it.
--
-- The tenant is re-checked in the body rather than trusted from the caller, so
-- the write is refused for a tenant the caller has no right to seed.
--
-- ON CONFLICT (tenant_id, code) DO NOTHING makes a second call return 0 and
-- leaves the is_system rows a tenant may never edit exactly as seeded.
-- GET DIAGNOSTICS rather than FOUND because the caller needs the count: 9 on a
-- fresh tenant, 0 when already seeded, which makes the conflict skip visible.
--
-- The closing count assertion is the part that makes this function worth
-- existing. A seed that merely inserted nine rows would return 9 and stop,
-- leaving a tenant with a chart edited since. The chart is fixed and is_system
-- rows are frozen, so the only legal end state is exactly nine rows per tenant,
-- and asserting it here makes a drifted chart fail loudly instead of being
-- carried silently into every financial report. It is also the check that would
-- have caught the 4100 CHECK violation at seed time rather than at report time.
--
-- The nine VALUES rows below are the only place the fixed list is written down.
-- The 0028 backfill and every test call THIS function rather than repeating it.
CREATE OR REPLACE FUNCTION app_finance_seeds_ledger_accounts(p_tenant_id uuid)
    RETURNS integer
    LANGUAGE plpgsql VOLATILE SECURITY DEFINER
    SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    v_inserted integer;
BEGIN
    IF p_tenant_id IS DISTINCT FROM app_current_tenant_id() AND NOT app_privileged() THEN
        RAISE EXCEPTION 'seeds_ledger_accounts: tenant % is not the current tenant and caller is not privileged',
            p_tenant_id
            USING ERRCODE = '55000';
    END IF;

    WITH seed(code, name, account_class, normal_side, is_contra) AS (
        VALUES
            ('1000', 'Cash in hand',                          'asset',     'debit',  false),
            ('1100', 'Bank / mobile wallet',                   'asset',     'debit',  false),
            ('1200', 'Accounts Receivable - Fees',             'asset',     'debit',  false),
            ('1300', 'Unapplied Cash (On Account)',            'liability', 'credit', false),
            ('2200', 'Refund Payable',                         'liability', 'credit', false),
            ('4000', 'Fee Income',                             'revenue',   'credit', false),
            ('4100', 'Fee Income - Concessions & Waivers',     'revenue',   'debit',  true ),
            ('4200', 'Fee Income - Fines & Penalties',         'revenue',   'credit', false),
            ('4900', 'Unapplied / Advance Fee Income',         'revenue',   'credit', false)
    )
    INSERT INTO fin_ledger_accounts
        (tenant_id, code, name, account_class, normal_side, is_contra, is_system)
    SELECT p_tenant_id, s.code, s.name, s.account_class, s.normal_side, s.is_contra, true
    FROM seed s
    ON CONFLICT (tenant_id, code) DO NOTHING;

    GET DIAGNOSTICS v_inserted = ROW_COUNT;

    IF (SELECT count(*) FROM fin_ledger_accounts WHERE tenant_id = p_tenant_id) <> 9 THEN
        RAISE EXCEPTION 'seeds_ledger_accounts: tenant % has a chart that is not the fixed 9 accounts',
            p_tenant_id
            USING ERRCODE = '55000';
    END IF;

    RETURN v_inserted;
END;
$$;
REVOKE ALL ON FUNCTION app_finance_seeds_ledger_accounts(uuid) FROM PUBLIC;


-- -----------------------------------------------------------------------------
-- 4. Post-condition assertions.
--
-- These fail the migration, and with it the whole `pnpm db:migrate` run, if
-- the state this file exists to establish does not hold. The primary control
-- is the per-table REVOKE above; these assert it rather than trust it, and they
-- read the catalog rather than the text of this file, so they report the
-- privileges actually in effect.
-- -----------------------------------------------------------------------------
DO $assert_unreachable$
DECLARE
    v_tbl       text;
    v_survivor  text;
    v_expected  text[] := ARRAY[
        'fin_tenant_settings', 'fin_ledger_accounts', 'fin_document_counters',
        'fin_fee_heads', 'fin_tax_profiles'
    ];
BEGIN
    FOREACH v_tbl IN ARRAY v_expected LOOP
        SELECT string_agg(p, ', ' ORDER BY p)
          INTO v_survivor
          FROM unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE',
                            'REFERENCES', 'TRIGGER']) AS p
         WHERE has_table_privilege('school_app_rw', v_tbl, p);

        IF v_survivor IS NOT NULL THEN
            RAISE EXCEPTION
                'post-0021 assertion failed: role school_app_rw still holds % on %. 0001 ALTER DEFAULT PRIVILEGES granted this table at CREATE TABLE time and the per-table REVOKE did not take effect; a granted-but-RLS-not-yet-enabled finance table fails OPEN',
                v_survivor, v_tbl;
        END IF;
    END LOOP;
END
$assert_unreachable$;

DO $assert_no_policy$
DECLARE
    v_n integer;
BEGIN
    SELECT count(*)
      INTO v_n
      FROM pg_policies p
     WHERE p.schemaname = 'public'
       AND p.tablename IN ('fin_tenant_settings', 'fin_ledger_accounts',
                           'fin_document_counters', 'fin_fee_heads', 'fin_tax_profiles');

    IF v_n <> 0 THEN
        RAISE EXCEPTION
            'post-0021 assertion failed: % policies exist on 0021 tables; RLS and policies are 0028''s responsibility and 0021 must leave the tables unreachable',
            v_n;
    END IF;
END
$assert_no_policy$;

DO $assert_anchors$
DECLARE
    v_missing text;
BEGIN
    SELECT string_agg(t, ', ' ORDER BY t)
      INTO v_missing
      FROM unnest(ARRAY[
            'enrollments_tenant_id_uq', 'student_guardians_tenant_id_uq',
            'academic_terms_tenant_id_uq', 'holidays_tenant_id_uq',
            'calendar_events_tenant_id_uq', 'departments_tenant_id_uq',
            'school_settings_tenant_id_uq', 'student_documents_tenant_id_uq',
            'admission_applications_tenant_id_uq', 'transfers_tenant_id_uq',
            'promotion_items_tenant_id_uq', 'report_card_subjects_tenant_id_uq'
       ]) AS t
     WHERE NOT EXISTS (
        SELECT 1
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
          JOIN pg_index i ON i.indexrelid = c.oid
         WHERE n.nspname = 'public' AND c.relname = t AND i.indisunique
           AND pg_get_indexdef(i.indexrelid) LIKE '%(tenant_id, id)%'
    );

    IF v_missing IS NOT NULL THEN
        RAISE EXCEPTION
            'post-0021 assertion failed: composite-FK anchor index(es) missing: %; a missing anchor is a build failure, not a review comment',
            v_missing;
    END IF;
END
$assert_anchors$;

DO $assert_functions$
DECLARE
    v_leak text;
BEGIN
    -- F1, F2 and F6 are the predicates 0028's policies are written from, so the
    -- runtime role must be able to execute them and PUBLIC must not.
    -- F3 seeds a chart of accounts: owner-only, and this is the assertion that
    -- keeps it that way.
    --
    -- aclexplode rather than has_function_privilege('PUBLIC', ...): the latter
    -- resolves its first argument to a role OID, and PUBLIC is not a role, so
    -- the call raises 42704 instead of answering the question. grantee = 0 is
    -- the ACL encoding of PUBLIC.
    SELECT string_agg(p.proname, ', ' ORDER BY p.proname)
      INTO v_leak
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN ('app_finance_actor_class',
                         'app_finance_linked_students',
                         'app_finance_current_guardian_ids',
                         'app_finance_seeds_ledger_accounts')
       AND (
             EXISTS (
                SELECT 1
                  FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
                 WHERE a.grantee = 0
                   AND a.privilege_type = 'EXECUTE'
             )
          OR (
                p.proname = 'app_finance_seeds_ledger_accounts'
            AND has_function_privilege('school_app_rw', p.oid, 'EXECUTE')
            )
          );

    IF v_leak IS NOT NULL THEN
        RAISE EXCEPTION
            'post-0021 assertion failed: PUBLIC may EXECUTE (or school_app_rw may seed) %; the seed function must be owner-retained and no helper may be world-callable',
            v_leak;
    END IF;

    -- And the positive half: the three policy helpers must be callable by the
    -- runtime role, or every 0028 policy silently denies rather than errors.
    IF NOT has_function_privilege('school_app_rw', 'public.app_finance_actor_class()', 'EXECUTE')
       OR NOT has_function_privilege('school_app_rw', 'public.app_finance_linked_students()', 'EXECUTE')
       OR NOT has_function_privilege('school_app_rw', 'public.app_finance_current_guardian_ids()', 'EXECUTE') THEN
        RAISE EXCEPTION
            'post-0021 assertion failed: school_app_rw cannot execute one of the three finance context helpers; 0028 policies built on them would deny silently instead of erroring';
    END IF;
END
$assert_functions$;
