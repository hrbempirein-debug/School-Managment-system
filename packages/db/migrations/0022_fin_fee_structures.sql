-- =============================================================================
-- 0022_fin_fee_structures.sql
--
-- WHAT
-- Phase 7 (Fees & Finance) migration 2 of 9. The fee-structure and billing
-- model: versioned structures, their line items, their installment schedule,
-- their polymorphic targets, the assignment that binds a structure to a live
-- enrollment, and the recorded billing run.
--
-- Creates, completely:
--   fin_fee_structures, fin_fee_structure_items, fin_fee_installment_plans,
--   fin_fee_structure_targets, fin_fee_assignments, fin_billing_runs,
--   fin_billing_run_items
--   trg_fin_target_validate()            - polymorphic target integrity
--   trg_fin_structure_publish_freeze()  - header freeze after publication, the
--                                          §18 status allow-list on INSERT (a
--                                          row may only be born draft), on
--                                          UPDATE and on DELETE
--   trg_fin_structure_child_freeze()    - line/target/plan freeze (3 bindings,
--                                          each on INSERT, UPDATE and DELETE)
--   trg_fin_assignment_validate()       - §6.4 student/year anchoring
--   trg_fin_billing_run_freeze()        - §8.4/§8.7 committed-run freeze
--   trg_fin_billing_run_items_freeze()  - §8.4/§8.7 committed-run item freeze
--   8 CREATE TRIGGER statements, 1 partial unique expression index
--
-- Defects D1-D7 from the first applied version of this file were fixed in
-- place, not by a new migration, so that the file that ships is the file whose
-- behaviour was verified. Every one of them is enforced by a behavioural case in
-- section 10.8, and every one of those cases has been shown to FAIL when the fix
-- is reverted and its assertions neutralised (the negative controls in
-- docs/PHASE_7_0022_CHECKPOINT_REPORT.md).
--
--   D1  child freeze was not bound to INSERT: a published structure's lines
--       were still addable, which is the change that alters what a family owes
--   D2  header freeze was not bound to DELETE: a published structure and all
--       three ON DELETE CASCADE children could be removed in one statement
--   D3  §6.4's student/year pin was not implemented at all
--   D4  the deduplication index let a NULL structure_id escape the key
--   D5  a COMMITTED billing run was fully mutable, and so were its items: the
--       §8.4 freeze and the §8.4 reproducibility guarantee were prose only.
--       The item freeze must judge both the run a row is in and the run it is
--       moved into, or run_id alone is a way out of a frozen run
--   D6  the §18 status graph was not enforced: retired -> published was
--       accepted, and so was draft -> superseded and draft -> retired, and a
--       structure could be born non-draft without ever passing through it
--   D7  published_by had no foreign key, so the audit record of WHO published a
--       fee structure accepted any uuid at all
--
-- The design's trigger inventory (§35.3, and its §19.7.2 F5 count) named three
-- functions and five bindings for 0022. This file declares SIX functions and EIGHT
-- bindings, and the design has been updated to match - each addition is a
-- requirement the design states in prose that its own inventory did not list.
--
-- DEPENDENCIES (all satisfied by 0021 or earlier; no forward reference)
--   0021  fin_fee_heads, fin_tax_profiles, fin_tenant_settings,
--         fin_ledger_accounts, fin_document_counters
--   0004  campuses, academic_years
--   0005  students, enrollments, guardians
--   0008  acd_classes, sections
--   0009  grade_levels
--   0001  users, tenants
-- Every target of a composite FK here already declares UNIQUE (tenant_id, id):
-- academic_years_tenant_id_uq, campuses_tenant_id_uq, grade_levels_tenant_id_uq,
-- acd_classes_tenant_id_uq, sections_tenant_id_uq, students_tenant_id_uq,
-- enrollments_tenant_id_uq. 0021 added the last of those.
--
-- 23 foreign keys, of which TWO are the §6.3 R4 platform-global-identity
-- exception: fin_billing_runs.started_by and fin_fee_structures.published_by,
-- both single-column references to `users`, which has no tenant_id. They are the
-- only two, and the post-condition assertion is written so that adding a third
-- FAILS rather than passing. Their delete rules differ on purpose - 'n' and 'r' -
-- because a SET NULL on published_by would have to rewrite the write-once
-- publication stamp; see the note above the CREATE TABLE.
--
-- NO FORWARD REFERENCE. The single deferred reference in the design,
-- fin_billing_run_items.invoice_id -> fin_invoices, is NOT created here:
-- fin_invoices is created by 0023, so the constraint is added by ALTER TABLE at
-- the end of 0023. A composite FK permits NULL, so every run item written
-- before its run is committed is legal with the column NULL, which is exactly
-- the state such an item is in. The post-condition assertions at the end of
-- this file assert that fin_invoices does not exist and that no FK from a
-- 0022 table points at it, so the window cannot be widened by accident.
--
-- WHY NO EXISTING MIGRATION IS EDITED
-- 0001-0021 are applied history. Editing a file that has already run does not
-- re-run it on any existing database, so the change would persist in the
-- repository while having no effect anywhere. Everything here is additive,
-- forward-only and idempotent.
--
-- SECURITY POSTURE AT THE END OF THIS MIGRATION: UNREACHABLE
-- 0001 runs ALTER DEFAULT PRIVILEGES ... GRANT SELECT, INSERT, UPDATE, DELETE
-- ON TABLES TO school_app_rw, so every table below is granted to the runtime
-- role the instant it is created. Each CREATE TABLE is therefore followed
-- immediately, in the same file and the same transaction, by
--
--     REVOKE ALL ON <t> FROM school_app_rw;
--
-- RLS is deliberately NOT enabled here and no policy is created. That is the
-- design's explicit position (the ordering sketch states "NONE of these files
-- enables RLS"), and it is the fail-closed one: a table with no ACL entry for
-- school_app_rw raises 42501 on every statement regardless of RLS, so the
-- table is unreachable whether or not RLS is on. 0028 is the only migration
-- that enables and forces RLS, creates the policies, and then grants - in that
-- order, so RLS always precedes the grant. Enabling RLS in this file with no
-- policy would not make anything safer (the ACL already denies), and creating
-- policies here would put a second, divergent copy of the policy set in place
-- of the single normative one in 0028.
--
-- WHY NO INVOICE RELATIONSHIP HERE
-- A billing run records the INPUTS that produced each amount so a disputed
-- bill can be explained without re-running the generator. The invoice link is
-- the output edge, and it belongs to 0023 with its target.
--
-- IDEMPOTENCE
-- CREATE TABLE is not re-runnable, but the runner records a migration only
-- after it commits and never re-applies a recorded file, so 0022 runs once.
-- Everything re-runnable here is written to be: DROP TRIGGER IF EXISTS before
-- every CREATE TRIGGER, CREATE OR REPLACE for the functions, and IF NOT EXISTS
-- for the index. The closing assertions fail the migration - and with it the
-- whole `pnpm db:migrate` run - if the schema this file declares is not the
-- schema that exists.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. fin_fee_structures
--
-- Versioned and explicitly published. `status` is usability
-- ('retired' = no longer usable for new assignments) and effective_from/
-- effective_to are the date range; both are checked, and they are different
-- things. supersedes_id is the version link, and publishing a new version is
-- what makes the old one 'superseded'.
--
-- code is unique per (tenant, code, version) rather than per (tenant, code), so
-- a school can re-cut a price list for the same year without renaming it.
--
-- The published_ck CHECK ties the two publication facts together: a draft has
-- no publication stamp and a non-draft must. The stamp itself is written by
-- trg_fin_structure_publish_freeze on the transition, not by the caller.
--
-- published_by is FK-backed (D7). It was not in the design's own DDL, which is
-- why the first applied version of this file declared it as a bare uuid: an
-- unconstrained uuid is not a reference, it is a hopeful string, and this column
-- is the audit record of WHO published the price list a family was quoted. The
-- shape is forced rather than chosen - `users` is platform-global and carries no
-- tenant_id, so a composite FK is unavailable and this is the §6.3 R4 exception,
-- in exactly the form fin_billing_runs.started_by already uses.
--
-- THE DELETE ACTION, and why this one is RESTRICT where started_by is SET NULL.
-- The obvious choice was to copy started_by's ON DELETE SET NULL, on the grounds
-- that the publisher is an attribute of the publication and not a dependency of
-- it. That was tried, and it does not work, because SET NULL and the
-- write-once publication stamp are mutually exclusive rules:
--
--   * SET NULL fires an UPDATE on fin_fee_structures, which is the write that the
--     stamp guard exists to refuse. Deleting a user who had published anything
--     therefore raised 55000 from trg_fin_structure_publish_freeze, not 23503
--     from the FK - verified, not assumed.
--   * So the referential action was unreachable for exactly the rows it was
--     written to serve, and the constraint documented an intent the trigger
--     contradicted. An FK whose delete action can never run is worse than no
--     delete action, because it looks like a policy and is not one.
--
-- RESTRICT states the policy the trigger is already enforcing, and states it at
-- the layer that can answer it: a user who published a fee structure cannot be
-- deleted, and the error is 23503 naming the FK. The remedy is the one the users
-- table already provides - users.status, so an account is deactivated rather
-- than erased - and the same choice the version link already makes, since
-- fin_fee_structures_supersedes_fk is RESTRICT for the same class of reason.
-- published_at is likewise write-once, so the record of WHEN survives in both
-- readings; what RESTRICT adds is that the record of WHO cannot be made
-- unfalsifiable by deleting the person.
--
-- The asymmetry with started_by is deliberate and is not an inconsistency:
-- started_by records who pressed the button on a run, a convenience pointer with
-- no audit weight, so a departed user nulls it. published_by is the audit stamp
-- itself, and an audit stamp that any identity deletion can erase is not one.
-- -----------------------------------------------------------------------------
CREATE TABLE fin_fee_structures (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id        uuid NOT NULL,
    code             text NOT NULL,
    name             text NOT NULL,
    academic_year_id uuid NOT NULL,
    version          integer NOT NULL DEFAULT 1 CHECK (version >= 1),
    status           text NOT NULL DEFAULT 'draft',
    effective_from   date NOT NULL,
    effective_to     date,
    supersedes_id    uuid,
    published_at     timestamptz,
    published_by     uuid,
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),
    deleted_at       timestamptz,
    CONSTRAINT fin_fee_structures_year_fk
        FOREIGN KEY (tenant_id, academic_year_id)
        REFERENCES academic_years (tenant_id, id) ON DELETE RESTRICT,
    CONSTRAINT fin_fee_structures_supersedes_fk
        FOREIGN KEY (tenant_id, supersedes_id)
        REFERENCES fin_fee_structures (tenant_id, id) ON DELETE RESTRICT,
    -- §6.3 R4, the platform-global identity exception: `users` has no tenant_id.
    -- RESTRICT, not SET NULL: the write-once publication stamp refuses the UPDATE
    -- that a SET NULL referential action would have to perform. See the note above.
    CONSTRAINT fin_fee_structures_publisher_fk
        FOREIGN KEY (published_by) REFERENCES users (id) ON DELETE RESTRICT,
    CONSTRAINT fin_fee_structures_status_ck
        CHECK (status IN ('draft','published','retired','superseded')),
    CONSTRAINT fin_fee_structures_dates_ck
        CHECK (effective_to IS NULL OR effective_from < effective_to),
    CONSTRAINT fin_fee_structures_published_ck CHECK (
        (status = 'draft' AND published_at IS NULL)
     OR (status <> 'draft' AND published_at IS NOT NULL)
    ),
    CONSTRAINT fin_fee_structures_code_uq
        UNIQUE (tenant_id, code, version),
    CONSTRAINT fin_fee_structures_ten_id_uq UNIQUE (tenant_id, id)
);
REVOKE ALL ON fin_fee_structures FROM school_app_rw;


-- -----------------------------------------------------------------------------
-- 2. fin_fee_structure_items
--
-- The composite key admits a REPEATED (structure, fee_head) with a different
-- installment_no, which is what makes "Tuition installment 1, 2, 3" addressable
-- and partially payable. The brief's proposed unique key of
-- (tenant_id, structure_id, fee_head_id) could not express that, and the
-- alternative of permitting arbitrary duplicates made "which one?"
-- unanswerable. Neither the structure nor the fee head is frozen here: the
-- freeze is enforced by trg_fin_structure_child_freeze, which reads the
-- parent's status, and by §35.4 revoking UPDATE for the append-only tables.
--
-- amount is nonnegative. A negative charge is not a concession - a concession
-- is an adjustment row with an approver - it is a smaller charge entered
-- wrongly, and admitting it here is how an unapproved waiver appears as a line.
--
-- recurrence records INTENT; the due dates come from
-- fin_fee_installment_plans, so the two cannot disagree about when money is due.
-- -----------------------------------------------------------------------------
CREATE TABLE fin_fee_structure_items (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id      uuid NOT NULL,
    structure_id   uuid NOT NULL,
    fee_head_id    uuid NOT NULL,
    installment_no integer NOT NULL DEFAULT 1 CHECK (installment_no >= 1),
    amount         numeric(19,4) NOT NULL CHECK (amount >= 0),
    recurrence     text NOT NULL DEFAULT 'once'
                   CHECK (recurrence IN ('once','monthly','termly','annual')),
    CONSTRAINT fin_fee_structure_items_structure_fk
        FOREIGN KEY (tenant_id, structure_id)
        REFERENCES fin_fee_structures (tenant_id, id) ON DELETE CASCADE,
    CONSTRAINT fin_fee_structure_items_fee_head_fk
        FOREIGN KEY (tenant_id, fee_head_id)
        REFERENCES fin_fee_heads (tenant_id, id) ON DELETE RESTRICT,
    CONSTRAINT fin_fee_structure_items_uq
        UNIQUE (tenant_id, structure_id, fee_head_id, installment_no),
    CONSTRAINT fin_fee_structure_items_ten_id_uq UNIQUE (tenant_id, id)
);
REVOKE ALL ON fin_fee_structure_items FROM school_app_rw;


-- -----------------------------------------------------------------------------
-- 3. fin_fee_installment_plans
--
-- At most one plan per structure (UNIQUE on installment_no), and a structure
-- with no plan rows bills as a single installment on effective_from - which is
-- what keeps a single-fee structure from needing a special case in the
-- generator.
--
-- No ON DELETE SET NULL appears in the fee-structure tables; see the SET NULL
-- audit in the implementation report. 0022 contains exactly ONE SET NULL,
-- fin_billing_runs.started_by. The second candidate,
-- fin_fee_structures.published_by (D7), is RESTRICT instead, because a SET NULL
-- there would have to rewrite the write-once publication stamp - see the note
-- above the CREATE TABLE.
-- -----------------------------------------------------------------------------
CREATE TABLE fin_fee_installment_plans (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id      uuid NOT NULL,
    structure_id   uuid NOT NULL,
    installment_no integer NOT NULL CHECK (installment_no >= 1),
    due_on         date NOT NULL,
    label          text,
    CONSTRAINT fin_installment_plans_structure_fk
        FOREIGN KEY (tenant_id, structure_id)
        REFERENCES fin_fee_structures (tenant_id, id) ON DELETE CASCADE,
    CONSTRAINT fin_installment_plans_uq UNIQUE (tenant_id, structure_id, installment_no),
    CONSTRAINT fin_installment_plans_ten_id_uq UNIQUE (tenant_id, id)
);
REVOKE ALL ON fin_fee_installment_plans FROM school_app_rw;


-- -----------------------------------------------------------------------------
-- 4. fin_fee_structure_targets
--
-- A polymorphic association: one table, a target_type discriminator and up to
-- four nullable id columns. That is the single most dangerous schema shape in a
-- system, because a row can point at nothing, at the wrong kind of thing, or at
-- another tenant's thing, and the database accepts all three unless every
-- column is independently constrained. The naive `target_id uuid` shape is
-- unimplementable: a bare uuid with no FK is not a reference, it is a hopeful
-- string.
--
-- Therefore: NO bare target_id. All four pointers are real tenant-composite
-- FKs, so a cross-tenant id is UNREPRESENTABLE rather than merely rejected:
-- the parent tables have no UNIQUE (id) without tenant_id, so there is no row a
-- cross-tenant reference could legally resolve to.
--
-- The claim in an earlier draft of this comment - that a cross-tenant id "is
-- rejected by PostgreSQL at INSERT time, BEFORE the trigger runs" - was false
-- and has been corrected. A BEFORE trigger runs before any constraint check, so
-- trg_fin_target_validate is what actually raises, and it raises 55000 from its
-- own tenant-scoped lookup. The FK is the STRUCTURAL guarantee that survives if
-- the trigger is ever dropped; it is not the one that produces the error a
-- caller sees. Getting this the wrong way round matters, because a 55000 is
-- retryable-looking to a client and a 23503 is not, and because an author who
-- believed the FK fired first would not think to check what the trigger does
-- when its lookup finds nothing.
-- `class_id` targets `acd_classes`, not `classes` - there is no `classes`
-- table in this repository.
--
-- fin_targets_shape_ck makes the four combinations mutually exclusive, and is
-- deliberately a CHECK rather than trigger logic: a CHECK is the last line of
-- defence against a COPY or a direct catalog write that skipped the trigger.
-- Note the two arms that read `(x IS NOT NULL OR x IS NULL)` are exhaustive
-- and therefore true - the shape constraint does not constrain those parents
-- for the grade and class types. The hierarchy trigger is what does.
--
-- fin_targets_uq is UNIQUE NULLS NOT DISTINCT because a plain UNIQUE treats
-- NULLs as distinct, so without it a structure could hold two identical
-- `grade` targets differing only in a NULL campus_id. PostgreSQL 15+; the CI
-- service is postgres:16.
--
-- Resolution is a total order, most specific first (section, class, grade,
-- campus, all), and a match at a more specific level EXCLUDES every less
-- specific level for the same structure. `all` is a genuine catch-all for
-- students not otherwise covered, not a fourth overlapping price list.
-- -----------------------------------------------------------------------------
CREATE TABLE fin_fee_structure_targets (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id    uuid NOT NULL,
    structure_id uuid NOT NULL,
    target_type  text NOT NULL
                 CHECK (target_type IN ('all','campus','grade','class','section')),
    campus_id    uuid,
    grade_id     uuid,
    class_id     uuid,
    section_id   uuid,
    -- Documents that priority is NOT a way to make a less specific target
    -- outrank a more specific one: that would make resolution data-dependent
    -- and therefore not reproducible from its inputs. It exists only to order
    -- two targets of the SAME rank, which the trigger's hierarchy checks make
    -- a data-entry accident; if two such targets both match, the billing run
    -- fails loudly with 55000 ambiguous_fee_target and names both rows rather
    -- than silently picking one.
    priority     integer NOT NULL DEFAULT 0,
    created_at   timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT fin_targets_structure_fk
        FOREIGN KEY (tenant_id, structure_id)
        REFERENCES fin_fee_structures (tenant_id, id) ON DELETE CASCADE,
    CONSTRAINT fin_targets_campus_fk
        FOREIGN KEY (tenant_id, campus_id)
        REFERENCES campuses (tenant_id, id),
    CONSTRAINT fin_targets_grade_fk
        FOREIGN KEY (tenant_id, grade_id)
        REFERENCES grade_levels (tenant_id, id),
    CONSTRAINT fin_targets_class_fk
        FOREIGN KEY (tenant_id, class_id)
        REFERENCES acd_classes (tenant_id, id),
    CONSTRAINT fin_targets_section_fk
        FOREIGN KEY (tenant_id, section_id)
        REFERENCES sections (tenant_id, id),
    CONSTRAINT fin_targets_shape_ck CHECK (
        (target_type = 'all'     AND campus_id IS NULL AND grade_id IS NULL
                                 AND class_id IS NULL AND section_id IS NULL)
     OR (target_type = 'campus'  AND campus_id IS NOT NULL AND grade_id IS NULL
                                 AND class_id IS NULL AND section_id IS NULL)
     OR (target_type = 'grade'   AND grade_id  IS NOT NULL AND class_id IS NULL
                                 AND section_id IS NULL
                                 AND (campus_id IS NOT NULL OR campus_id IS NULL))
     OR (target_type = 'class'   AND class_id   IS NOT NULL AND section_id IS NULL
                                 AND (campus_id IS NOT NULL OR campus_id IS NULL)
                                 AND (grade_id  IS NOT NULL OR grade_id  IS NULL))
     OR (target_type = 'section' AND section_id IS NOT NULL)
    ),
    CONSTRAINT fin_targets_uq
        UNIQUE NULLS NOT DISTINCT (tenant_id, structure_id, target_type,
                                   campus_id, grade_id, class_id, section_id),
    CONSTRAINT fin_targets_ten_id_uq UNIQUE (tenant_id, id)
);
REVOKE ALL ON fin_fee_structure_targets FROM school_app_rw;


-- -----------------------------------------------------------------------------
-- 5. fin_fee_assignments
--
-- The binding between a live enrollment and a structure, and the table the
-- "ambiguous fee assignment" property is about.
--
-- structure_id is NULLABLE, and a NULL structure is a NULL target, not a
-- wildcard: "assign nothing". A wildcard would need its own row shape, because
-- a NULL FK participates in no uniqueness index and so could not be
-- deduplicated against - which is the property the whole table exists to
-- provide.
--
-- The anchor is enrollments.id, not students.id, because billing is
-- academic-year-scoped and a student's class is reachable only through a live
-- enrollment. student_id is a denormalised copy pinned by
-- trg_fin_assignment_validate (8.4, added as defect D3), following the
-- trg_marks_validate precedent, so that a policy can decide reachability from
-- the row alone. The anchor claim was carried in this comment by the first
-- applied version of this file while no such trigger existed, which is how
-- §6.4's requirement went unsatisfied with the design appearing to be followed.
--
-- effective_to is nullable and means "whole year": a structure may be
-- effective for part of a year, which is how a mid-year fee change is
-- expressed without editing a published structure. range_ck keeps
-- effective_to >= effective_from; without it, an inverted range is
-- representable and the assignment silently never applies.
-- -----------------------------------------------------------------------------
CREATE TABLE fin_fee_assignments (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           uuid NOT NULL,
    structure_id        uuid,
    enrollment_id       uuid NOT NULL,
    student_id          uuid NOT NULL,
    academic_year_id    uuid NOT NULL,
    effective_from      date NOT NULL,
    effective_to        date,
    installment_plan_id uuid,
    is_active           boolean NOT NULL DEFAULT true,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT fin_fee_assignments_structure_fk
        FOREIGN KEY (tenant_id, structure_id)
        REFERENCES fin_fee_structures (tenant_id, id) ON DELETE RESTRICT,
    CONSTRAINT fin_fee_assignments_enrollment_fk
        FOREIGN KEY (tenant_id, enrollment_id)
        REFERENCES enrollments (tenant_id, id) ON DELETE RESTRICT,
    CONSTRAINT fin_fee_assignments_student_fk
        FOREIGN KEY (tenant_id, student_id)
        REFERENCES students (tenant_id, id) ON DELETE RESTRICT,
    CONSTRAINT fin_fee_assignments_year_fk
        FOREIGN KEY (tenant_id, academic_year_id)
        REFERENCES academic_years (tenant_id, id) ON DELETE RESTRICT,
    CONSTRAINT fin_fee_assignments_plan_fk
        FOREIGN KEY (tenant_id, installment_plan_id)
        REFERENCES fin_fee_installment_plans (tenant_id, id) ON DELETE RESTRICT,
    CONSTRAINT fin_fee_assignments_ten_id_uq UNIQUE (tenant_id, id),
    CONSTRAINT fin_fee_assignments_range_ck CHECK (
        effective_to IS NULL OR effective_to >= effective_from
    )
);
REVOKE ALL ON fin_fee_assignments FROM school_app_rw;


-- The deduplication index. One ACTIVE assignment per (enrollment, structure,
-- effective period). Partial, because deactivated history is retained for
-- audit and a full UNIQUE would forbid keeping it.
--
-- The COALESCE sentinels are load-bearing, and ALL THREE NULLABLE COLUMNS NEED
-- ONE. A plain UNIQUE (tenant_id, enrollment_id, structure_id, effective_from,
-- effective_to) would let both kinds of row be duplicated, because in PostgreSQL
-- two NULLs compare as DISTINCT and so never collide:
--
--   * an unbounded interval (effective_to IS NULL) - the original hole;
--   * an "assign nothing" row (structure_id IS NULL).
--
-- The second was a real defect in the first applied version of this file and is
-- recorded as D4 in docs/PHASE_7_0022_CHECKPOINT_REPORT.md: the sentinels were
-- written for the two dates only, so two byte-identical active rows for the same
-- enrollment and period BOTH inserted, and the resolution rule was choosing
-- between rows that should never have existed. The table comment above already
-- argued that a NULL structure must still be deduplicable - "a NULL FK
-- participates in no uniqueness index" - and the index then failed to honour its
-- own argument.
--
-- DATE '9999-12-31' is inside date's range and is never a real fee period, so
-- that sentinel cannot collide with a legitimate closed interval.
-- '00000000-0000-0000-0000-000000000000'::uuid is the nil UUID: a well-formed
-- uuid that gen_random_uuid() never returns and that no application mints as a
-- surrogate key, so it cannot collide with a real structure_id either.
-- effective_from is NOT NULL and does not strictly need its sentinel; it is
-- written anyway so both sides of the range are transformed identically and the
-- expression is obviously injective.
--
-- The grain here is deliberately (enrollment, structure, period) and NOT
-- (student, year, installment). The design's §8.3 also describes an index on
-- (tenant_id, student_id, academic_year_id, installment_no) WHERE
-- status='active' AND deleted_at IS NULL, but fin_fee_assignments has no
-- installment_no, no status and no deleted_at column, so that index is not
-- buildable against this table, and the nearest buildable form - uniqueness
-- per (tenant, student, year) - would forbid the mid-year effective-period
-- change this table's effective_from/effective_to pair exists to express. This
-- index is therefore the whole of the deduplication guarantee, and it is
-- verified behaviourally rather than assumed.
CREATE UNIQUE INDEX fin_fee_assignments_one_active_uq
    ON fin_fee_assignments (
        tenant_id, enrollment_id,
        COALESCE(structure_id, '00000000-0000-0000-0000-000000000000'::uuid),
        COALESCE(effective_from, DATE '0001-01-01'),
        COALESCE(effective_to,   DATE '9999-12-31')
    )
    WHERE is_active;


-- -----------------------------------------------------------------------------
-- 6. fin_billing_runs
--
-- A run is the unit of reproducibility: "re-run billing for year Y" must produce
-- the same invoices, so a run records its inputs, not just its outputs.
--
-- status is a REPRODUCIBILITY lifecycle, not a job lifecycle:
-- draft -> preview -> committed, with cancelled as the terminal abandonment. A
-- committed run is frozen and its items are what a regeneration must reproduce.
-- There is deliberately no pending/running/failed: "failed halfway" is not a
-- state this model has, because a run is a record of what was generated, not a
-- handle on work in progress.
--
-- state_ck makes cancelled_at and its reason a pair and committed_at exclusive
-- of both. Without it a run can be committed and cancelled simultaneously, and
-- the §8.4 freeze then applies to a run that was abandoned.
--
-- started_by is a single-column FK to `users`, which is a platform-global
-- identity table with no tenant_id - the §6.3 R4 exception, and the same shape as
-- fin_fee_structures_published_by. It is one of exactly TWO single-column FKs in
-- this file, its one referencing column is nullable, and ON DELETE SET NULL
-- therefore needs no column list. See the SET NULL audit below.
--
-- A COMMITTED RUN IS FROZEN, and so are its items (§8.4, §8.7). This table
-- declared nothing that enforced it until D5: the status CHECK below constrains
-- the TIMESTAMPS, so clearing committed_at and moving the run back to preview
-- satisfied it perfectly, and a committed run's idempotency_key, totals and
-- structure_ids - the entire input record a regeneration is supposed to
-- reproduce - were all rewritable. trg_fin_billing_run_freeze and
-- trg_fin_billing_run_items_freeze close that; see 8.5 and 8.6.
-- -----------------------------------------------------------------------------
CREATE TABLE fin_billing_runs (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           uuid NOT NULL,
    academic_year_id    uuid NOT NULL,
    status              text NOT NULL DEFAULT 'draft'
                        CHECK (status IN ('draft','preview','committed','cancelled')),
    -- Recorded so a re-run is a NEW run with the same parameters, never a
    -- mutation of a committed one. Both are supported; the second is why the
    -- parameters are on the row at all.
    structure_ids       uuid[] NOT NULL DEFAULT '{}',
    -- Snapshot of the assignment selection, so a re-run cannot pick up a changed
    -- assignment set and call the result a reproduction. Mid-year changes are
    -- ADJUSTMENTS rather than regenerated invoices, so this snapshot is stable
    -- by design.
    idempotency_key     text NOT NULL,
    total_students      integer NOT NULL DEFAULT 0 CHECK (total_students >= 0),
    total_invoices      integer NOT NULL DEFAULT 0 CHECK (total_invoices >= 0),
    total_amount        numeric(19,4) NOT NULL DEFAULT 0,
    started_by          uuid,
    started_at          timestamptz NOT NULL DEFAULT now(),
    committed_at        timestamptz,
    cancelled_at        timestamptz,
    cancelled_reason    text,
    CONSTRAINT fin_billing_runs_year_fk
        FOREIGN KEY (tenant_id, academic_year_id)
        REFERENCES academic_years (tenant_id, id) ON DELETE RESTRICT,
    CONSTRAINT fin_billing_runs_user_fk
        FOREIGN KEY (started_by) REFERENCES users (id) ON DELETE SET NULL,
    CONSTRAINT fin_billing_runs_ten_id_uq UNIQUE (tenant_id, id),
    -- The idempotency key is tenant-scoped, so two tenants may use the same
    -- value; a repeated key inside one tenant returns the same run rather than
    -- generating a second set of invoices.
    CONSTRAINT fin_billing_runs_idem_uq UNIQUE (tenant_id, idempotency_key),
    CONSTRAINT fin_billing_runs_state_ck CHECK (
        (status = 'cancelled' AND cancelled_at IS NOT NULL AND cancelled_reason IS NOT NULL
                  AND committed_at IS NULL)
     OR (status = 'committed' AND committed_at IS NOT NULL AND cancelled_at IS NULL)
     OR (status IN ('draft','preview') AND committed_at IS NULL AND cancelled_at IS NULL)
    )
);
REVOKE ALL ON fin_billing_runs FROM school_app_rw;


-- -----------------------------------------------------------------------------
-- 7. fin_billing_run_items
--
-- One row per (run, enrollment). The composite PRIMARY KEY is the dedup key: a
-- second attempt to bill the same enrollment into the same run is a PK
-- violation, not a second invoice. This is the mechanism behind "billing twice
-- is a unique violation, not a rounding difference".
--
-- The per-charge detail is NOT here - it belongs to fin_invoice_items, created
-- by 0023. This row is the provenance record: which structure, which
-- assignment, and which inputs produced each amount, so a disputed bill can be
-- explained from the run without re-running the generator.
--
-- invoice_id is declared but deliberately NOT FK-backed in this file. It is
-- added by ALTER TABLE at the end of 0023, the one deliberate forward
-- reference in 0022. It is written here as the column-list form
-- ON DELETE SET NULL (invoice_id): a bare SET NULL on that composite FK would
-- try to null tenant_id as well and the delete would fail on the NOT NULL
-- constraint, which is the same defect 0021 found and corrected on
-- fin_tenant_settings_tax_profile_fk.
--
-- §6.3 R1: UNIQUE (tenant_id, id) is NOT declared here, and the omission is
-- deliberate. This table has no surrogate id - the natural key IS the identity,
-- so there is no second id to keep consistent with it - and nothing in Phase 7
-- references fin_billing_run_items. A run's items are always fetched by
-- (tenant_id, run_id), for which the primary key's leading tenant_id is already
-- the tenant pin. Declaring an anchor on a column named `id` would fail at DDL
-- time with 42703 column "id" does not exist.
-- -----------------------------------------------------------------------------
CREATE TABLE fin_billing_run_items (
    tenant_id           uuid NOT NULL,
    run_id              uuid NOT NULL,
    enrollment_id       uuid NOT NULL,
    student_id          uuid NOT NULL,
    structure_id        uuid NOT NULL,
    assignment_id       uuid,
    invoice_id          uuid,
    amount              numeric(19,4) NOT NULL CHECK (amount >= 0),
    created_at          timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT fin_billing_run_items_pkey PRIMARY KEY (tenant_id, run_id, enrollment_id),
    CONSTRAINT fin_bri_run_fk
        FOREIGN KEY (tenant_id, run_id)
        REFERENCES fin_billing_runs (tenant_id, id) ON DELETE RESTRICT,
    CONSTRAINT fin_bri_enrollment_fk
        FOREIGN KEY (tenant_id, enrollment_id)
        REFERENCES enrollments (tenant_id, id) ON DELETE RESTRICT,
    CONSTRAINT fin_bri_student_fk
        FOREIGN KEY (tenant_id, student_id)
        REFERENCES students (tenant_id, id) ON DELETE RESTRICT,
    CONSTRAINT fin_bri_structure_fk
        FOREIGN KEY (tenant_id, structure_id)
        REFERENCES fin_fee_structures (tenant_id, id) ON DELETE RESTRICT,
    CONSTRAINT fin_bri_assignment_fk
        FOREIGN KEY (tenant_id, assignment_id)
        REFERENCES fin_fee_assignments (tenant_id, id) ON DELETE RESTRICT
);
REVOKE ALL ON fin_billing_run_items FROM school_app_rw;


-- -----------------------------------------------------------------------------
-- 8. The three trigger functions.
-- -----------------------------------------------------------------------------

-- 8.1 Header freeze after publication.
--
-- A published structure may not be edited. The one mutable column is
-- supersedes_id, because recording that this version replaces another is
-- metadata about the LINK, not about what this version charges; everything
-- that determines an amount is frozen.
--
-- The test is on OLD.status, not NEW.status: leaving draft is a DRAFT
-- operation and is what publishing is, so a draft is freely editable and a
-- published one is not. A structure that has been published can never return to
-- draft, or a number already printed and handed to a parent could be un-issued.
--
-- TWO CORRECTIONS TO THE DESIGN'S DDL, both because the function referenced
-- columns the design's own table DDL does not declare:
--
--   * is_active. §7.3.1's frozen-column list includes NEW.is_active, but
--     fin_fee_structures has no is_active column - it is not in §7.3's CREATE
--     TABLE, not in the §35.2 FK map, and not anywhere else in the design.
--     Referencing it would raise 42703 "record new has no field is_active" on
--     the first UPDATE of any non-draft structure, i.e. a 500 for a correct
--     rejection. Usability is already carried by status plus
--     effective_from/effective_to, which is what §7.3's own prose describes, so
--     the line is dropped rather than a column invented.
--
--   * retired_at. The same function stamps NEW.retired_at on
--     published -> retired. No retired_at column exists on the table and no
--     reader for one exists anywhere in the design. Stamping it would mean
--     adding a column that nothing consumes, so the stamp is dropped and the
--     status transition is left to say what it says.
--
-- The publication stamp is written here rather than trusted from the caller:
-- fin_fee_structures_published_ck requires published_at to be non-NULL for
-- every non-draft status, so without the COALESCE a caller that forgot the
-- second column would get a raw 23514 instead of a working publish. COALESCE
-- means an application that sets it explicitly still wins. It is write-once
-- afterwards: published_at and published_by are the record of WHEN this version
-- was published, and leaving them rewritable would make the freeze cosmetic.
--
-- 8.1b THE DELETE PATH, added as defect D2.
--
-- The first applied version of this function was bound BEFORE UPDATE only, so a
-- hard DELETE of a published structure succeeded, and it took its children with
-- it: fin_fee_structure_items, fin_fee_installment_plans and
-- fin_fee_structure_targets are all ON DELETE CASCADE, and PostgreSQL's
-- referential actions do NOT fire the referencing table's user triggers. That
-- last property was verified with a minimal two-temp-table reproduction in which
-- a direct child DELETE was refused 55000 while the same child deleted through
-- the parent's CASCADE was not refused at all. So the child freeze could not be
-- relied on to stop this, and the guard has to live on the HEADER - which is
-- also the only place that can see the status at all.
--
-- The branch is placed before any reference to NEW, because in a row trigger
-- PL/pgSQL assigns only NEW on INSERT and only OLD on DELETE; touching the
-- unassigned record raises P0002 "record new is not assigned yet" before any
-- comparison happens. That is the same trap documented on 8.2 below.
--
-- 8.1c THE STATUS ALLOW-LIST, added as defect D6.
--
-- §18 draws the graph for fin_fee_structures and calls it normative, and its
-- global rule is that "every transition above is enforced by a BEFORE INSERT OR
-- UPDATE trigger that validates OLD.status -> NEW.status against a table-driven
-- allow-list, raising ERRCODE = '55000' otherwise". The first applied version of
-- this function enforced exactly one edge of it - the refusal of NEW.status =
-- 'draft' - and let every other edge through. Two of those were not cosmetic:
--
--   retired    -> published   the reported P2. A retired structure is terminal in
--                             §18 ("retired / superseded (terminal)"). Republication
--                             re-issues a price list families have already been
--                             billed against, and the only thing that made it
--                             reachable was the absence of a rule, not a decision.
--   draft      -> superseded  §18's only edge INTO superseded is
--                             published -> superseded, because §7.3 sets
--                             status='superseded' when a new version's
--                             supersedes_id points at it AND THAT NEW VERSION IS
--                             PUBLISHED. A structure that was never published has
--                             promised nothing and cannot have been superseded by
--                             anything.
--
-- The allow-list below is §18's graph transcribed, and nothing more. A no-op
-- UPDATE (NEW.status = OLD.status) is not a transition and is still allowed -
-- published structures have exactly one mutable column, supersedes_id, and it
-- would be unusable if every statement had to change the status to be legal.
--
-- The list is applied BEFORE the "still a draft, so freely editable" return, and
-- that ordering is the whole of D6. An earlier version of this edit put the
-- return first on the reading that a draft row has no history to protect, and in
-- doing so re-permitted draft -> retired and draft -> superseded through the very
-- gap the defect was opened for: both have OLD.status = 'draft', so both returned
-- before the list was ever consulted. A guard that is placed after the branch it
-- was meant to constrain constrains nothing.
--
-- §18's global rule also says INSERT, because §18 states the graph as the rule
-- for entering a state, and the graph has exactly one source state. So the
-- binding carries the INSERT bit and this function refuses any row born
-- non-draft. The write-once publication stamp below can only ever be set by the
-- draft -> published UPDATE, and the trigger cannot see OLD on an INSERT at all,
-- so a row inserted as 'published' would have no stamp by construction - which
-- the published_ck already catches, one check too late to be the reason. Refusing
-- it here states the rule instead of inferring it.
CREATE OR REPLACE FUNCTION trg_fin_structure_publish_freeze() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
    -- DELETE: a draft has never promised anything and may be removed; anything
    -- else has been published or retired, and a document already handed to a
    -- parent cannot be un-issued by deleting the row it came from.
    IF TG_OP = 'DELETE' THEN
        IF OLD.status <> 'draft' THEN
            RAISE EXCEPTION 'a % fee structure is frozen; supersede it instead', OLD.status
                USING ERRCODE = '55000';
        END IF;
        RETURN OLD;
    END IF;

    -- INSERT: §18's only source state is draft, and OLD is unassigned here, so
    -- there is no edge to validate - only an illegal starting point to refuse.
    IF TG_OP = 'INSERT' THEN
        IF NEW.status <> 'draft' THEN
            RAISE EXCEPTION 'a fee structure must be created as draft, not %', NEW.status
                USING ERRCODE = '55000';
        END IF;
        RETURN NEW;
    END IF;

    IF OLD.status = 'draft' AND NEW.status = 'published' THEN
        NEW.published_at := COALESCE(NEW.published_at, now());
    END IF;

    -- D6: §18's graph, as an allow-list, consulted on every UPDATE regardless of
    -- where it started. Three edges, and nothing else:
    --   draft     -> published
    --   published -> retired
    --   published -> superseded
    -- Everything else is refused, which is what makes retired and superseded
    -- terminal rather than merely discouraged, and which subsumes the separate
    -- "cannot return to draft" refusal: draft is not the target of any edge, so
    -- published -> draft and retired -> draft are both unlisted.
    IF NEW.status IS DISTINCT FROM OLD.status
       AND NOT (    (OLD.status = 'draft'     AND NEW.status = 'published')
                 OR (OLD.status = 'published' AND NEW.status IN ('retired','superseded')))
    THEN
        RAISE EXCEPTION 'a % fee structure cannot become %', OLD.status, NEW.status
            USING ERRCODE = '55000';
    END IF;

    IF OLD.status = 'draft' THEN
        RETURN NEW;   -- never published: freely editable
    END IF;

    -- supersedes_id is the ONE mutable column, because recording that this
    -- version replaces another is metadata about the LINK, not about what this
    -- version charges. Everything that determines an amount is frozen.
    --
    -- deleted_at is in this list for the same reason, and it closes the third
    -- escape recorded as D1c: the design's §7.3.1 list does not name it, so the
    -- first applied version let a published structure be soft-deleted, which
    -- hides a structure that families have already been billed against without
    -- any UPDATE to a frozen column. Soft-deleting a published structure is an
    -- edit; it belongs in the same guard. The design's own table declares
    -- deleted_at on fin_fee_structures, so the column is part of the surface the
    -- freeze is about.
    IF NEW.academic_year_id IS DISTINCT FROM OLD.academic_year_id
       OR NEW.name          IS DISTINCT FROM OLD.name
       OR NEW.version       IS DISTINCT FROM OLD.version
       OR NEW.effective_from IS DISTINCT FROM OLD.effective_from
       OR NEW.effective_to   IS DISTINCT FROM OLD.effective_to
       OR NEW.deleted_at     IS DISTINCT FROM OLD.deleted_at
    THEN
        RAISE EXCEPTION 'a published fee structure is frozen; supersede it instead'
            USING ERRCODE = '55000';
    END IF;

    -- Write-once publication stamp, set by the transition that publishes and
    -- not rewritable afterwards. This is narrower than the frozen list above
    -- (it permits the first SET) and narrower than "everything but
    -- supersedes_id" (it does not permit a restamp).
    IF OLD.published_at IS NOT NULL
       AND (NEW.published_at IS DISTINCT FROM OLD.published_at
            OR NEW.published_by IS DISTINCT FROM OLD.published_by)
    THEN
        RAISE EXCEPTION 'the publication stamp of a % fee structure is write-once', OLD.status
            USING ERRCODE = '55000';
    END IF;

    RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION trg_fin_structure_publish_freeze() FROM PUBLIC;


-- 8.2 The child freeze.
--
-- The same rule as 8.1, reached from the child row to its parent, which is why
-- it is a separate function: a trigger on fin_fee_structure_items cannot see
-- its parent's status, so it must read it.
--
-- The header freeze alone is not enough. A trigger on fin_fee_structures cannot
-- see a line item, so without bindings on the three child tables a published
-- structure's ITEMS, TARGETS and PLANS would stay editable - and the lines are
-- what a family is actually billed.
--
-- TG_OP decides which record is read. It is NOT COALESCE(NEW.x, OLD.x): in a
-- row trigger PL/pgSQL assigns only NEW on INSERT and only OLD on DELETE, and
-- touching the unassigned one raises P0002 "record new is not assigned yet"
-- before any comparison happens. COALESCE does not rescue this - it evaluates
-- every argument, so COALESCE(NEW.tenant_id, OLD.tenant_id) still dereferences
-- NEW on the DELETE path and raises the identical error one line earlier. An
-- earlier draft did exactly that, which made every child delete against a
-- published structure fail with a P0002 naming a PL/pgSQL internal instead of
-- the intended 55000. The same reasoning applies to the RETURN: a BEFORE
-- trigger's return value IS the row written, so returning the unassigned
-- record is a write-time failure, not a cosmetic one.
--
-- A missing parent is not a freeze failure: the FK guarantees the parent exists
-- for INSERT and UPDATE, and a DELETE leaves the child rather than the parent.
-- The IS NOT NULL guard therefore reads "no parent to ask" rather than "no
-- parent to worry about".
--
-- 8.2b THE INSERT PATH, added as defect D1.
--
-- The three bindings were originally BEFORE UPDATE OR DELETE. An INSERT was
-- therefore the one way to change what a published structure charges: a new line
-- could be added to a published structure and billed to every family in the
-- target set, with no UPDATE to any frozen column and no error. §8.2's own
-- words are that "without bindings on the three child tables a published
-- structure's ITEMS, TARGETS and PLANS would stay editable - and the lines are
-- what a family is actually billed", so INSERT was a defect against the
-- requirement and not a reading of it. The function already dispatched on
-- TG_OP, so adding INSERT to the bindings is the whole fix; no function change
-- is needed and the guard now fires on all three events.
CREATE OR REPLACE FUNCTION trg_fin_structure_child_freeze() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE v_status text; v_tenant uuid; v_structure uuid;
BEGIN
    IF TG_OP = 'DELETE' THEN
        v_tenant    := OLD.tenant_id;
        v_structure := OLD.structure_id;
    ELSE
        v_tenant    := NEW.tenant_id;
        v_structure := NEW.structure_id;
    END IF;

    SELECT status INTO v_status
      FROM fin_fee_structures
     WHERE tenant_id = v_tenant AND id = v_structure;
    IF v_status IS NOT NULL AND v_status <> 'draft' THEN
        RAISE EXCEPTION
            'cannot modify % of a % fee structure; supersede it instead',
            TG_TABLE_NAME, v_status
            USING ERRCODE = '55000';
    END IF;

    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;
    RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION trg_fin_structure_child_freeze() FROM PUBLIC;


-- 8.3 Polymorphic target integrity.
--
-- SECURITY INVOKER on purpose. Steps 1, 2 and 5 must READ sections,
-- acd_classes, grade_levels and fin_fee_structures, which are RLS-scoped.
-- Running this elevated would let it read across tenants; running it as the
-- caller means it reads exactly what the caller may write, which is the correct
-- coupling - a finance_staff member cannot create a target they cannot see.
-- Cross-tenant safety needs no code at all, which is the entire reason the
-- composite-FK convention exists.
--
-- The five properties this implements, in the order they are checked:
--
--   1. Existence    - composite FK on all four pointers. UNREPRESENTABLE, not
--                     merely checked.
--   2. Tenant       - composite FK. UNREPRESENTABLE, not merely checked. This
--                     is why step 3 below is empty.
--   3. Shape        - fin_targets_shape_ck, a CHECK, so it also guards a COPY
--                     or a direct catalog write that skipped the trigger.
--   4. Soft delete  - THIS trigger. A plain FK happily accepts a soft-deleted
--                     section, grade, class or campus, so the deleted_at IS NULL
--                     predicates are the only enforcement of "not deleted" and
--                     are load-bearing.
--   5. Applicability - THIS trigger. The resolved target's academic_year_id must
--                     equal the parent structure's. A target from last year is a
--                     data-entry error that would otherwise silently bill
--                     nobody.
--
-- The design's own §7.6 DDL body implements step 1 only and leaves steps 2 and
-- 5 as comments. That is incomplete against its own normative five-row table
-- above it, and the gap is not cosmetic: without step 4-for-grade/campus a
-- soft-deleted campus target is accepted, and without step 5 a class or section
-- from a different academic year is accepted and the structure then bills
-- nobody for it. Both are implemented here, per the design's stated rules.
--
-- The hierarchy is the one the repository actually has, and it is not the
-- four-level chain a reader might assume:
--
--   campus        - tenant-wide; no parent, no academic year
--   grade_levels  - tenant-wide; no campus_id and no academic_year_id
--   acd_classes   - campus_id, grade_level_id, academic_year_id
--   sections      - campus_id, class_id, academic_year_id
--
-- So there IS a parent to assert for a class target (campus, grade) and a
-- two-step parent for a section target (class, then that class's grade), and
-- there is NOT one for a campus or grade target. For those two the only checks
-- that mean anything are existence and soft-delete, and the asserted campus_id
-- on a grade target has no hierarchy to be checked against because
-- grade_levels carries no campus_id. No rule is invented to fill that gap.
CREATE OR REPLACE FUNCTION trg_fin_target_validate() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    v_actual_campus uuid;
    v_actual_grade  uuid;
    v_actual_class  uuid;
    v_actual_year   uuid;
    v_structure_year uuid;
BEGIN
    IF NEW.target_type = 'campus' THEN
        PERFORM 1 FROM campuses c
         WHERE c.tenant_id = NEW.tenant_id AND c.id = NEW.campus_id
           AND c.deleted_at IS NULL;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'target campus does not exist, or is deleted, in this tenant'
                USING ERRCODE = '55000';
        END IF;

    ELSIF NEW.target_type = 'grade' THEN
        PERFORM 1 FROM grade_levels g
         WHERE g.tenant_id = NEW.tenant_id AND g.id = NEW.grade_id
           AND g.deleted_at IS NULL;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'target grade does not exist, or is deleted, in this tenant'
                USING ERRCODE = '55000';
        END IF;

    ELSIF NEW.target_type = 'class' THEN
        SELECT cl.campus_id, cl.grade_level_id, cl.academic_year_id
          INTO v_actual_campus, v_actual_grade, v_actual_year
          FROM acd_classes cl
         WHERE cl.tenant_id = NEW.tenant_id AND cl.id = NEW.class_id
           AND cl.deleted_at IS NULL;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'target class does not exist, or is deleted, in this tenant'
                USING ERRCODE = '55000';
        END IF;
        IF NEW.campus_id IS NOT NULL AND NEW.campus_id IS DISTINCT FROM v_actual_campus THEN
            RAISE EXCEPTION 'the asserted campus does not contain the target class'
                USING ERRCODE = '55000';
        END IF;
        IF NEW.grade_id IS NOT NULL AND NEW.grade_id IS DISTINCT FROM v_actual_grade THEN
            RAISE EXCEPTION 'the asserted grade does not contain the target class'
                USING ERRCODE = '55000';
        END IF;

    ELSIF NEW.target_type = 'section' THEN
        SELECT sec.campus_id, sec.class_id, sec.academic_year_id
          INTO v_actual_campus, v_actual_class, v_actual_year
          FROM sections sec
         WHERE sec.tenant_id = NEW.tenant_id AND sec.id = NEW.section_id
           AND sec.deleted_at IS NULL;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'target section does not exist, or is deleted, in this tenant'
                USING ERRCODE = '55000';
        END IF;
        SELECT cl.grade_level_id INTO v_actual_grade
          FROM acd_classes cl
         WHERE cl.tenant_id = NEW.tenant_id AND cl.id = v_actual_class
           AND cl.deleted_at IS NULL;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'target section''s class does not exist, or is deleted, in this tenant'
                USING ERRCODE = '55000';
        END IF;
        IF NEW.campus_id IS NOT NULL AND NEW.campus_id IS DISTINCT FROM v_actual_campus THEN
            RAISE EXCEPTION 'target campus does not contain the target section'
                USING ERRCODE = '55000';
        END IF;
        IF NEW.class_id IS NOT NULL AND NEW.class_id IS DISTINCT FROM v_actual_class THEN
            RAISE EXCEPTION 'target class does not contain the target section'
                USING ERRCODE = '55000';
        END IF;
        IF NEW.grade_id IS NOT NULL AND NEW.grade_id IS DISTINCT FROM v_actual_grade THEN
            RAISE EXCEPTION 'target grade does not match the target section hierarchy'
                USING ERRCODE = '55000';
        END IF;
    END IF;
    -- target_type = 'all': fin_targets_shape_ck has already proved all four id
    -- columns are NULL and there is no pointer to resolve.
    --
    -- Step 3 (cross-tenant) is intentionally absent, not forgotten. The four
    -- pointer FKs are FOREIGN KEY (tenant_id, <col>) REFERENCES <t> (tenant_id,
    -- id), so PostgreSQL itself rejects a foreign-tenant id before this body
    -- runs. A hand-written check here would be dead code, and dead security code
    -- is worse than none because it reads as a control.
    --
    -- Step 5 (academic-year applicability) applies to exactly the two target
    -- types that carry a year. campuses and grade_levels have no
    -- academic_year_id, so for target_type 'campus', 'grade' and 'all' there is
    -- no year on the target to compare and the design defines no rule.
    IF NEW.target_type IN ('class','section') THEN
        SELECT s.academic_year_id INTO v_structure_year
          FROM fin_fee_structures s
         WHERE s.tenant_id = NEW.tenant_id AND s.id = NEW.structure_id;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'target structure does not exist in this tenant'
                USING ERRCODE = '55000';
        END IF;
        IF v_actual_year IS DISTINCT FROM v_structure_year THEN
            RAISE EXCEPTION 'target % belongs to a different academic year than the fee structure',
                NEW.target_type
                USING ERRCODE = '55000';
        END IF;
    END IF;

    RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION trg_fin_target_validate() FROM PUBLIC;


-- -----------------------------------------------------------------------------
-- 8.4 Assignment anchoring, added as defect D3.
--
-- §6.4 is normative and specific:
--
--   "a student's class/section is only reachable through a live enrollment.
--    ... student_id must match the enrollment's student, ERRCODE 55000."
--
-- The four FKs on fin_fee_assignments each guarantee that a referenced id
-- EXISTS in this tenant. None of them says the two references agree with each
-- other, and the first applied version of this file declared no trigger here at
-- all, so student_id and academic_year_id were free columns: an enrollment for
-- student A in 2025 could be assigned with student_id = B, or billed into the
-- next year, and both rows were accepted. The denormalised student_id then
-- disagreed with its own anchor, which defeats the stated reason for copying it
-- ("a policy can decide reachability from the row alone") and is the kind of
-- silent corruption no foreign key anywhere in the schema can catch.
--
-- academic_year_id is checked for the same reason. fin_fee_structures pins the
-- year with fin_fee_structures_year_fk, and §6.4 anchors billing to the year of
-- the enrollment; if the two may disagree then a student enrolled in 2025 can be
-- assigned a 2025-only structure, or a 2026 one, by writing a single column, and
-- the cohort a fee was quoted for is not the cohort that owes it.
--
-- The check is tenant-scoped on the enrollment lookup, and the row's own
-- fin_fee_assignments_enrollment_fk is a tenant-composite FK to
-- (enrollments.tenant_id, enrollments.id), so the lookup below cannot cross a
-- tenant even if tenant_id were wrong: it would simply find no row. "Not found"
-- is raised as 55000 rather than being allowed to fall through, because letting
-- it fall through would rely on the FK to produce the error AFTER the trigger,
-- which changes the error's code and its message for no benefit.
--
-- Deliberately NOT checked: the enrollment's status or its deleted_at. A
-- withdrawal or a soft-deleted enrollment is a legitimate billing fact - the
-- fees were owed up to the withdrawal - and §6.4 asks the row to agree with its
-- ANCHOR, not to assert that the anchor is still teachable. Adding a status rule
-- here would invent a requirement the design does not state, and would make a
-- historical invoice unreconstructable the moment an enrollment is withdrawn.
-- That is a design question to settle in 0023 or later, not something to
-- smuggle in here.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trg_fin_assignment_validate() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE v_student uuid; v_year uuid;
BEGIN
    SELECT e.student_id, e.academic_year_id
      INTO v_student, v_year
      FROM enrollments e
     WHERE e.tenant_id = NEW.tenant_id
       AND e.id = NEW.enrollment_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'assignment anchor enrollment is not in this tenant'
            USING ERRCODE = '55000';
    END IF;

    IF v_student IS DISTINCT FROM NEW.student_id THEN
        RAISE EXCEPTION
            'assignment student_id must match the anchor enrollment''s student_id'
            USING ERRCODE = '55000';
    END IF;

    IF v_year IS DISTINCT FROM NEW.academic_year_id THEN
        RAISE EXCEPTION
            'assignment academic_year_id must match the anchor enrollment''s academic_year_id'
            USING ERRCODE = '55000';
    END IF;

    RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION trg_fin_assignment_validate() FROM PUBLIC;


-- -----------------------------------------------------------------------------
-- 8.5 The committed-run freeze, added as defect D5.
--
-- §8.4 is unambiguous and is the whole reason this table exists: "a run is the
-- unit of reproducibility: re-run billing for year Y must produce the same
-- invoices, so a run records its inputs, not just its outputs", and
-- "fin_billing_run_items is immutable once the run completes". §8.7's own
-- DDL comment repeats it: "A committed run is frozen (§8.4) and its items are
-- what a regeneration must reproduce."
--
-- The first applied version of 0022 implemented NONE of it, and the gap was not
-- subtle. fin_billing_runs_state_ck constrains the TIMESTAMPS, not the history:
--     UPDATE fin_billing_runs SET status='preview', committed_at=NULL WHERE id=…
-- satisfies every arm of that CHECK perfectly, so an un-committed committed run
-- is a legal row. Once it is back in preview, idempotency_key, structure_ids,
-- total_students, total_invoices and total_amount are all rewritable - and those
-- are exactly the fields §8.4 says a regeneration must reproduce. A run can
-- therefore be edited to agree with whatever invoices were in fact created, which
-- makes the reproducibility claim unfalsifiable rather than merely unenforced. The
-- three defects were confirmed by execution, not inferred; they are cases C28,
-- C30 and C37 of the suite in docs/PHASE_7_0022_CHECKPOINT_REPORT.md.
--
-- The freeze is on OLD.status = 'committed', never on NEW.status: entering
-- `committed` is the transition being protected, so the UPDATE that performs it
-- must be legal, and every UPDATE after it must not be. That also makes
-- `committed` terminal, which is the only reading consistent with §8.7's own
-- state_ck: a cancelled run must have committed_at IS NULL, so the design's own
-- CHECK already refuses committed -> cancelled unless the commit is un-done
-- first, and the freeze refuses the un-doing. The two agree.
--
-- Why DELETE is refused as well as UPDATE. The run is the evidence that a set of
-- invoices was produced, and fin_billing_run_items is ON DELETE RESTRICT from it,
-- so a run that produced anything already cannot be deleted; refusing the empty
-- one too closes the last hole by which a committed run's record disappears. The
-- consequence is stated rather than hidden: a mis-committed run cannot be purged,
-- and the correction is a NEW run carrying a new idempotency key - which is
-- precisely what §8.4 prescribes ("a re-run is a NEW run with the same
-- parameters, never a mutation of a committed one"). No role, GUC or TRUNCATE
-- escape exists; TRUNCATE does not fire row triggers and school_app_rw holds no
-- TRUNCATE privilege (asserted in 10.7), exactly as for the structure freeze.
--
-- Deliberately NOT enforced here: the draft -> preview -> committed ORDER. §8.7
-- defines the four statuses and its CHECK pairs their timestamps, but the design
-- states no edge list for billing runs - §18's graph covers fee structures only -
-- so inventing one here would be a rule the design does not have. The transition
-- that matters, the one that ends the mutability, is the freeze.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trg_fin_billing_run_freeze() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
    IF OLD.status = 'committed' THEN
        RAISE EXCEPTION
            'billing run % is committed and frozen; re-run it as a new run rather than editing this one',
            OLD.id
            USING ERRCODE = '55000';
    END IF;

    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;
    RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION trg_fin_billing_run_freeze() FROM PUBLIC;


-- -----------------------------------------------------------------------------
-- 8.6 The committed-run item freeze, added as defect D5.
--
-- Same rule as 8.5, reached from the item to its run - so a second function,
-- for the same reason 8.2 is a second function: a trigger on
-- fin_billing_run_items cannot see the run's status and must read it. One
-- function for both tables would have to branch on TG_TABLE_NAME and would still
-- need the branch, so two functions state two rules.
--
-- §8.4: "fin_billing_run_items is immutable once the run completes". Before the
-- fix the items of a committed run could be inserted, re-priced and deleted, so
-- the per-enrollment amounts a regeneration must reproduce were freely editable -
-- the same class of hole as D1, one table further from the structure.
--
-- THE ONE PERMITTED CHANGE, and why it is not a loophole. §8.7's DDL says of
-- invoice_id: "Set when the run is committed: an item in an uncommitted run has
-- no invoice yet, and the FK is added by ALTER at the end of 0023." So the single
-- legal write to a committed run's item is NULL -> a value, exactly once:
-- attaching the invoice the run produced. It is write-once, because a second
-- attachment (OLD.invoice_id IS NOT NULL) falls through to the refusal, and it
-- cannot be used as a smuggling route because every other column is compared
-- first. A full freeze including invoice_id would instead break the design's own
-- stated lifecycle, so the narrow exception is the only shape that leaves no
-- contradiction; §8.7 is updated to say so in the same words.
--
-- BOTH RUNS, on UPDATE. "Reachable from the item" means the run the row is in
-- now, and the run it is being moved into. Checking only the destination is a
-- freeze with a door in it: run_id is an ordinary column, so a single
-- UPDATE ... SET run_id = <an uncommitted run> removed the item from a committed
-- run without touching any of the columns the comparison covers. Both statuses
-- are therefore read on UPDATE, and either one being 'committed' freezes the row.
-- The invoice exception cannot help here, because it already requires tenant_id
-- and run_id to be unchanged.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trg_fin_billing_run_items_freeze() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE v_old_status text; v_new_status text; v_run uuid;
BEGIN
    -- TG_OP, not COALESCE(NEW.x, OLD.x): the P0002 trap of 8.2 applies here too.
    -- v_run is carried alongside the status lookups because the error message
    -- needs the run id, and naming NEW.run_id in a DELETE branch would raise
    -- P0002 "record new is not assigned yet" instead of the intended 55000.
    --
    -- BOTH sides are read on UPDATE, and that is the whole point. Reading only
    -- NEW satisfies the check with the destination and lets a row walk out of a
    -- committed run into a draft one - the same escape as the P0002 trap, seen
    -- from the other direction. fin_billing_run_items has no trigger-visible
    -- immutability of run_id, so without the OLD lookup "committed items are
    -- frozen" was true only of rows that stayed put. Either parent being
    -- committed freezes the row.
    IF TG_OP = 'DELETE' OR TG_OP = 'UPDATE' THEN
        SELECT r.status INTO v_old_status
          FROM fin_billing_runs r
         WHERE r.tenant_id = OLD.tenant_id AND r.id = OLD.run_id;
    END IF;
    IF TG_OP = 'INSERT' OR TG_OP = 'UPDATE' THEN
        SELECT r.status INTO v_new_status
          FROM fin_billing_runs r
         WHERE r.tenant_id = NEW.tenant_id AND r.id = NEW.run_id;
    END IF;

    -- The refused run is the committed one, not the destination: a row caught
    -- leaving a committed run is named by the run it was trying to leave.
    IF TG_OP = 'DELETE' OR (TG_OP = 'UPDATE' AND v_old_status = 'committed') THEN
        v_run := OLD.run_id;
    ELSE
        v_run := NEW.run_id;
    END IF;

    -- A missing run is not a freeze failure: fin_bri_run_fk guarantees the parent
    -- exists on INSERT and UPDATE, and a DELETE leaves the item, not the run. On
    -- INSERT only v_new_status is ever assigned, and on DELETE only v_old_status,
    -- so the untouched one is NULL and IS DISTINCT FROM keeps the row open.
    IF v_old_status IS DISTINCT FROM 'committed'
       AND v_new_status IS DISTINCT FROM 'committed'
    THEN
        IF TG_OP = 'DELETE' THEN
            RETURN OLD;
        END IF;
        RETURN NEW;
    END IF;

    IF TG_OP = 'UPDATE'
       AND OLD.invoice_id IS NULL
       AND NEW.invoice_id IS NOT NULL
       AND NEW.tenant_id     IS NOT DISTINCT FROM OLD.tenant_id
       AND NEW.run_id        IS NOT DISTINCT FROM OLD.run_id
       AND NEW.enrollment_id IS NOT DISTINCT FROM OLD.enrollment_id
       AND NEW.student_id    IS NOT DISTINCT FROM OLD.student_id
       AND NEW.structure_id  IS NOT DISTINCT FROM OLD.structure_id
       AND NEW.assignment_id IS NOT DISTINCT FROM OLD.assignment_id
       AND NEW.amount        IS NOT DISTINCT FROM OLD.amount
       AND NEW.created_at    IS NOT DISTINCT FROM OLD.created_at
    THEN
        RETURN NEW;   -- §8.7: the invoice this item produced, attached once
    END IF;

    RAISE EXCEPTION
        'the items of a committed billing run are frozen (run %)', v_run
        USING ERRCODE = '55000';
END $$;
REVOKE ALL ON FUNCTION trg_fin_billing_run_items_freeze() FROM PUBLIC;


-- -----------------------------------------------------------------------------
-- 9. Trigger bindings.
--
-- DROP TRIGGER IF EXISTS before every CREATE TRIGGER, per the repository's
-- idempotence convention. The trg_ prefix is reserved for trigger FUNCTIONS;
-- a trigger is never named trg_*.
--
-- trg_fin_structure_child_freeze has three bindings and that is a requirement,
-- not sloppiness: a header-only freeze leaves the LINES editable, and the lines
-- are what a family is billed. Each of those three bindings is BEFORE INSERT OR
-- UPDATE OR DELETE (D1): without INSERT a published structure's lines were still
-- addable, which is a change to what is charged with no UPDATE to any frozen
-- column.
--
-- trg_fin_structure_publish_freeze is bound to DELETE as well as UPDATE (D2).
-- The header is the only place that can see the structure's status, and
-- PostgreSQL's ON DELETE CASCADE does not fire the referencing table's triggers,
-- so a header guard is the only thing that can stop a published structure and
-- its lines from being removed in one statement.
--
-- Both triggers on fin_fee_structure_targets (the target validator and the
-- child freeze) are BEFORE INSERT OR UPDATE. PostgreSQL fires them in name
-- order, and `fin_structure_targets_freeze` sorts before `fin_targets_validate`,
-- so a published structure's target is refused for the right reason - "you may
-- not add to a published structure" - before the polymorphic hierarchy is even
-- evaluated. A tie would have produced a shape error for what is really a
-- freeze violation.
--
-- fin_structures_publish is bound to INSERT, UPDATE and DELETE. DELETE is D2 and
-- is load-bearing: it is the only thing that stops a published structure being
-- removed along with its ON DELETE CASCADE children, which do not fire their own
-- triggers. UPDATE is the freeze and the §18 status graph. INSERT (D6) is
-- §18's global rule read literally - the graph has one source state, so a row
-- born non-draft is refused rather than being left to the published_ck to notice
-- the missing stamp after the fact.
--
-- trg_fin_billing_run_freeze is bound to UPDATE and DELETE (D5): a committed run
-- may not be edited and may not be removed, and the DELETE bit is the only thing
-- that can stop the record of a generation disappearing. It is deliberately NOT
-- bound to INSERT - a run is born in draft, and binding INSERT would freeze
-- nothing, since OLD is not assigned there.
--
-- trg_fin_billing_run_items_freeze is bound to INSERT, UPDATE and DELETE (D5),
-- with all three bits load-bearing: the items of a committed run are what a
-- regeneration must reproduce, so an item may be neither added to that set,
-- changed within it, nor removed from it. The same completeness argument as D1.
-- -----------------------------------------------------------------------------
DROP TRIGGER IF EXISTS fin_structures_publish ON fin_fee_structures;
CREATE TRIGGER fin_structures_publish    BEFORE INSERT OR UPDATE OR DELETE ON fin_fee_structures
    FOR EACH ROW EXECUTE FUNCTION trg_fin_structure_publish_freeze();

DROP TRIGGER IF EXISTS fin_targets_validate ON fin_fee_structure_targets;
CREATE TRIGGER fin_targets_validate      BEFORE INSERT OR UPDATE ON fin_fee_structure_targets
    FOR EACH ROW EXECUTE FUNCTION trg_fin_target_validate();

DROP TRIGGER IF EXISTS fin_structure_items_freeze ON fin_fee_structure_items;
CREATE TRIGGER fin_structure_items_freeze   BEFORE INSERT OR UPDATE OR DELETE ON fin_fee_structure_items
    FOR EACH ROW EXECUTE FUNCTION trg_fin_structure_child_freeze();

DROP TRIGGER IF EXISTS fin_structure_targets_freeze ON fin_fee_structure_targets;
CREATE TRIGGER fin_structure_targets_freeze BEFORE INSERT OR UPDATE OR DELETE ON fin_fee_structure_targets
    FOR EACH ROW EXECUTE FUNCTION trg_fin_structure_child_freeze();

DROP TRIGGER IF EXISTS fin_structure_plans_freeze ON fin_fee_installment_plans;
CREATE TRIGGER fin_structure_plans_freeze   BEFORE INSERT OR UPDATE OR DELETE ON fin_fee_installment_plans
    FOR EACH ROW EXECUTE FUNCTION trg_fin_structure_child_freeze();

DROP TRIGGER IF EXISTS fin_assignments_validate ON fin_fee_assignments;
CREATE TRIGGER fin_assignments_validate   BEFORE INSERT OR UPDATE ON fin_fee_assignments
    FOR EACH ROW EXECUTE FUNCTION trg_fin_assignment_validate();

DROP TRIGGER IF EXISTS fin_runs_freeze ON fin_billing_runs;
CREATE TRIGGER fin_runs_freeze          BEFORE UPDATE OR DELETE ON fin_billing_runs
    FOR EACH ROW EXECUTE FUNCTION trg_fin_billing_run_freeze();

DROP TRIGGER IF EXISTS fin_run_items_freeze ON fin_billing_run_items;
CREATE TRIGGER fin_run_items_freeze     BEFORE INSERT OR UPDATE OR DELETE ON fin_billing_run_items
    FOR EACH ROW EXECUTE FUNCTION trg_fin_billing_run_items_freeze();


-- =============================================================================
-- 10. Post-condition assertions.
--
-- These fail the migration, and with it the whole `pnpm db:migrate` run, if the
-- schema this file declares is not the schema that exists. They read the
-- CATALOG, not the text of this file, so they report the state that is actually
-- in effect rather than the state the SQL intended.
-- =============================================================================

-- 10.1 Every declared table exists, with its declared columns.
DO $assert_tables$
DECLARE
    v_expected text[] := ARRAY[
        'fin_fee_structures', 'fin_fee_structure_items', 'fin_fee_installment_plans',
        'fin_fee_structure_targets', 'fin_fee_assignments', 'fin_billing_runs',
        'fin_billing_run_items'
    ];
    v_cols jsonb := '{
      "fin_fee_structures": ["tenant_id","code","name","academic_year_id","version","status",
        "effective_from","effective_to","supersedes_id","published_at","published_by",
        "created_at","updated_at","deleted_at"],
      "fin_fee_structure_items": ["tenant_id","structure_id","fee_head_id","installment_no",
        "amount","recurrence"],
      "fin_fee_installment_plans": ["tenant_id","structure_id","installment_no","due_on","label"],
      "fin_fee_structure_targets": ["tenant_id","structure_id","target_type","campus_id",
        "grade_id","class_id","section_id","priority","created_at"],
      "fin_fee_assignments": ["tenant_id","structure_id","enrollment_id","student_id",
        "academic_year_id","effective_from","effective_to","installment_plan_id","is_active",
        "created_at","updated_at"],
      "fin_billing_runs": ["tenant_id","academic_year_id","status","structure_ids",
        "idempotency_key","total_students","total_invoices","total_amount","started_by",
        "started_at","committed_at","cancelled_at","cancelled_reason"],
      "fin_billing_run_items": ["tenant_id","run_id","enrollment_id","student_id",
        "structure_id","assignment_id","invoice_id","amount","created_at"]
    }'::jsonb;
    v_tbl  text;
    v_missing text;
BEGIN
    FOREACH v_tbl IN ARRAY v_expected LOOP
        IF to_regclass('public.' || v_tbl) IS NULL THEN
            RAISE EXCEPTION 'post-0022 assertion failed: table % does not exist', v_tbl;
        END IF;

        SELECT string_agg(k, ', ' ORDER BY k)
          INTO v_missing
          FROM jsonb_array_elements_text(v_cols -> v_tbl) AS k
         WHERE NOT EXISTS (
            SELECT 1 FROM information_schema.columns c
             WHERE c.table_schema = 'public' AND c.table_name = v_tbl
               AND c.column_name = k
         );
        IF v_missing IS NOT NULL THEN
            RAISE EXCEPTION 'post-0022 assertion failed: % is missing column(s) %', v_tbl, v_missing;
        END IF;
    END LOOP;
END
$assert_tables$;

-- 10.2 The FK inventory is EXACTLY what is declared: no missing constraint, no
-- extra one, no wrong parent, no wrong delete rule, and no FK that silently
-- became a single-column tenant reference.
--
-- `expected_composite` is false for exactly two rows, fin_billing_runs_user_fk
-- and fin_fee_structures_publisher_fk, and both are the §6.3 R4
-- platform-global-identity exception on `users`. The assertion is written so that
-- adding a THIRD single-column FK FAILS rather than passing, which is the
-- direction that matters: the composite convention is what makes a cross-tenant
-- reference unrepresentable.
--
-- The two rows also disagree on the delete rule - 'n' for started_by, 'r' for
-- published_by - and the assertion checks each separately rather than accepting
-- either for both. That disagreement is the documented policy in the DDL comment:
-- a SET NULL on published_by would have to rewrite the write-once publication
-- stamp, so the FK is RESTRICT and deleting a publisher is refused. An assertion
-- that accepted 'n' here would have passed while the trigger made the action
-- unreachable.
-- The expected set is a CTE repeated in each statement rather than a PL/pgSQL
-- `table(...)` variable. A composite-typed variable cannot be initialised from
-- a multi-row VALUES list, and the alternative - a single-row `record` - would
-- silently keep only the first FK, which is precisely the failure mode an
-- inventory assertion exists to prevent.
DO $assert_fks$
DECLARE
    v_bad text;
    v_n   integer;
BEGIN
    -- A missing or mis-shaped expected constraint.
    --
    -- The parent is compared by OID, not by name. regclass::text renders the
    -- SHORTEST name that resolves under the current search_path, so a text
    -- comparison against 'public.academic_years' is true for a correct schema
    -- whenever `public` is on the search_path - i.e. it would pass for the wrong
    -- reason in exactly the environment the migration runs in. OID equality
    -- cannot have that failure mode.
    WITH e(child, conname, parent, composite, del) AS (
        VALUES
        ('fin_fee_structures',      'fin_fee_structures_year_fk',        'academic_years',           true,  'r'),
        ('fin_fee_structures',      'fin_fee_structures_supersedes_fk',  'fin_fee_structures',      true,  'r'),
        ('fin_fee_structures',      'fin_fee_structures_publisher_fk',   'users',                   false, 'r'),
        ('fin_fee_structure_items', 'fin_fee_structure_items_structure_fk','fin_fee_structures',     true,  'c'),
        ('fin_fee_structure_items', 'fin_fee_structure_items_fee_head_fk', 'fin_fee_heads',          true,  'r'),
        ('fin_fee_installment_plans','fin_installment_plans_structure_fk', 'fin_fee_structures',      true,  'c'),
        ('fin_fee_structure_targets','fin_targets_structure_fk',          'fin_fee_structures',      true,  'c'),
        ('fin_fee_structure_targets','fin_targets_campus_fk',             'campuses',                true,  'a'),
        ('fin_fee_structure_targets','fin_targets_grade_fk',              'grade_levels',            true,  'a'),
        ('fin_fee_structure_targets','fin_targets_class_fk',              'acd_classes',             true,  'a'),
        ('fin_fee_structure_targets','fin_targets_section_fk',            'sections',                true,  'a'),
        ('fin_fee_assignments',     'fin_fee_assignments_structure_fk',   'fin_fee_structures',      true,  'r'),
        ('fin_fee_assignments',     'fin_fee_assignments_enrollment_fk',  'enrollments',             true,  'r'),
        ('fin_fee_assignments',     'fin_fee_assignments_student_fk',     'students',                true,  'r'),
        ('fin_fee_assignments',     'fin_fee_assignments_year_fk',        'academic_years',          true,  'r'),
        ('fin_fee_assignments',     'fin_fee_assignments_plan_fk',        'fin_fee_installment_plans',true,  'r'),
        ('fin_billing_runs',        'fin_billing_runs_year_fk',           'academic_years',          true,  'r'),
        -- R4 exception: users is platform-global and has no tenant_id.
        ('fin_billing_runs',        'fin_billing_runs_user_fk',           'users',                   false, 'n'),
        ('fin_billing_run_items',   'fin_bri_run_fk',                     'fin_billing_runs',        true,  'r'),
        ('fin_billing_run_items',   'fin_bri_enrollment_fk',              'enrollments',             true,  'r'),
        ('fin_billing_run_items',   'fin_bri_student_fk',                 'students',                true,  'r'),
        ('fin_billing_run_items',   'fin_bri_structure_fk',               'fin_fee_structures',      true,  'r'),
        ('fin_billing_run_items',   'fin_bri_assignment_fk',              'fin_fee_assignments',     true,  'r')
    )
    SELECT string_agg(format('%s.%s', e.child, e.conname), ', ' ORDER BY e.child, e.conname)
      INTO v_bad
      FROM e
      LEFT JOIN pg_constraint con
        ON con.conname = e.conname
       AND con.conrelid = ('public.' || e.child)::regclass
     WHERE con.oid IS NULL
        OR con.contype <> 'f'
        OR con.confdeltype <> e.del
        OR (SELECT count(*) FROM unnest(con.conkey) k) <> CASE WHEN e.composite THEN 2 ELSE 1 END
        OR (SELECT count(*) FROM unnest(con.confkey) k) <> CASE WHEN e.composite THEN 2 ELSE 1 END
        OR con.confrelid <> ('public.' || e.parent)::regclass;

    IF v_bad IS NOT NULL THEN
        RAISE EXCEPTION
            'post-0022 assertion failed: expected foreign key(s) missing or mis-shaped: %', v_bad;
    END IF;

    -- An actual FK that is not in the expected set. This is what catches an
    -- accidental extra constraint, and what will catch fin_bri_invoice_fk if
    -- anyone adds the 0023 ALTER to this file by mistake.
    WITH e(child, conname, parent, composite, del) AS (
        VALUES
        ('fin_fee_structures',      'fin_fee_structures_year_fk',        'academic_years',           true,  'r'),
        ('fin_fee_structures',      'fin_fee_structures_supersedes_fk',  'fin_fee_structures',      true,  'r'),
        ('fin_fee_structures',      'fin_fee_structures_publisher_fk',   'users',                   false, 'r'),
        ('fin_fee_structure_items', 'fin_fee_structure_items_structure_fk','fin_fee_structures',     true,  'c'),
        ('fin_fee_structure_items', 'fin_fee_structure_items_fee_head_fk', 'fin_fee_heads',          true,  'r'),
        ('fin_fee_installment_plans','fin_installment_plans_structure_fk', 'fin_fee_structures',      true,  'c'),
        ('fin_fee_structure_targets','fin_targets_structure_fk',          'fin_fee_structures',      true,  'c'),
        ('fin_fee_structure_targets','fin_targets_campus_fk',             'campuses',                true,  'a'),
        ('fin_fee_structure_targets','fin_targets_grade_fk',              'grade_levels',            true,  'a'),
        ('fin_fee_structure_targets','fin_targets_class_fk',              'acd_classes',             true,  'a'),
        ('fin_fee_structure_targets','fin_targets_section_fk',            'sections',                true,  'a'),
        ('fin_fee_assignments',     'fin_fee_assignments_structure_fk',   'fin_fee_structures',      true,  'r'),
        ('fin_fee_assignments',     'fin_fee_assignments_enrollment_fk',  'enrollments',             true,  'r'),
        ('fin_fee_assignments',     'fin_fee_assignments_student_fk',     'students',                true,  'r'),
        ('fin_fee_assignments',     'fin_fee_assignments_year_fk',        'academic_years',          true,  'r'),
        ('fin_fee_assignments',     'fin_fee_assignments_plan_fk',        'fin_fee_installment_plans',true,  'r'),
        ('fin_billing_runs',        'fin_billing_runs_year_fk',           'academic_years',          true,  'r'),
        ('fin_billing_runs',        'fin_billing_runs_user_fk',           'users',                   false, 'n'),
        ('fin_billing_run_items',   'fin_bri_run_fk',                     'fin_billing_runs',        true,  'r'),
        ('fin_billing_run_items',   'fin_bri_enrollment_fk',              'enrollments',             true,  'r'),
        ('fin_billing_run_items',   'fin_bri_student_fk',                 'students',                true,  'r'),
        ('fin_billing_run_items',   'fin_bri_structure_fk',               'fin_fee_structures',      true,  'r'),
        ('fin_billing_run_items',   'fin_bri_assignment_fk',              'fin_fee_assignments',     true,  'r')
    )
    SELECT string_agg(format('%s.%s -> %s', con.conrelid::regclass, con.conname,
                             con.confrelid::regclass), ', '
                       ORDER BY con.conrelid::regclass::text, con.conname)
      INTO v_bad
      FROM pg_constraint con
     WHERE con.contype = 'f'
       AND con.conrelid IN (SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                             WHERE n.nspname = 'public' AND c.relname = ANY(
                                 ARRAY['fin_fee_structures','fin_fee_structure_items',
                                       'fin_fee_installment_plans','fin_fee_structure_targets',
                                       'fin_fee_assignments','fin_billing_runs','fin_billing_run_items']))
       AND NOT EXISTS (
            SELECT 1 FROM e
             WHERE con.conrelid = ('public.' || e.child)::regclass
               AND e.conname = con.conname
       );
    IF v_bad IS NOT NULL THEN
        RAISE EXCEPTION
            'post-0022 assertion failed: unexpected foreign key(s) on a 0022 table: %', v_bad;
    END IF;

    WITH e(child, conname, parent, composite, del) AS (
        VALUES
        ('fin_fee_structures',      'fin_fee_structures_year_fk',        'academic_years',           true,  'r'),
        ('fin_fee_structures',      'fin_fee_structures_supersedes_fk',  'fin_fee_structures',      true,  'r'),
        ('fin_fee_structures',      'fin_fee_structures_publisher_fk',   'users',                   false, 'r'),
        ('fin_fee_structure_items', 'fin_fee_structure_items_structure_fk','fin_fee_structures',     true,  'c'),
        ('fin_fee_structure_items', 'fin_fee_structure_items_fee_head_fk', 'fin_fee_heads',          true,  'r'),
        ('fin_fee_installment_plans','fin_installment_plans_structure_fk', 'fin_fee_structures',      true,  'c'),
        ('fin_fee_structure_targets','fin_targets_structure_fk',          'fin_fee_structures',      true,  'c'),
        ('fin_fee_structure_targets','fin_targets_campus_fk',             'campuses',                true,  'a'),
        ('fin_fee_structure_targets','fin_targets_grade_fk',              'grade_levels',            true,  'a'),
        ('fin_fee_structure_targets','fin_targets_class_fk',              'acd_classes',             true,  'a'),
        ('fin_fee_structure_targets','fin_targets_section_fk',            'sections',                true,  'a'),
        ('fin_fee_assignments',     'fin_fee_assignments_structure_fk',   'fin_fee_structures',      true,  'r'),
        ('fin_fee_assignments',     'fin_fee_assignments_enrollment_fk',  'enrollments',             true,  'r'),
        ('fin_fee_assignments',     'fin_fee_assignments_student_fk',     'students',                true,  'r'),
        ('fin_fee_assignments',     'fin_fee_assignments_year_fk',        'academic_years',          true,  'r'),
        ('fin_fee_assignments',     'fin_fee_assignments_plan_fk',        'fin_fee_installment_plans',true,  'r'),
        ('fin_billing_runs',        'fin_billing_runs_year_fk',           'academic_years',          true,  'r'),
        ('fin_billing_runs',        'fin_billing_runs_user_fk',           'users',                   false, 'n'),
        ('fin_billing_run_items',   'fin_bri_run_fk',                     'fin_billing_runs',        true,  'r'),
        ('fin_billing_run_items',   'fin_bri_enrollment_fk',              'enrollments',             true,  'r'),
        ('fin_billing_run_items',   'fin_bri_student_fk',                 'students',                true,  'r'),
        ('fin_billing_run_items',   'fin_bri_structure_fk',               'fin_fee_structures',      true,  'r'),
        ('fin_billing_run_items',   'fin_bri_assignment_fk',              'fin_fee_assignments',     true,  'r')
    )
    SELECT count(*) INTO v_n FROM e;
    IF v_n <> 23 THEN
        RAISE EXCEPTION
            'post-0022 assertion failed: the expected-FK fixture itself is wrong (% rows, not 23); '
            'an assertion that cannot notice its own drift is not an assertion', v_n;
    END IF;
END
$assert_fks$;

-- 10.3 The forward-reference window is still closed.
--
-- fin_invoices is created by 0023. If it does not exist, no FK from a 0022
-- table can possibly point at it, and saying so explicitly means a future
-- contributor who adds the 0023 ALTER here gets a named error rather than a
-- P0-01 window nobody noticed.
DO $assert_no_forward_fk$
DECLARE v_n integer;
BEGIN
    IF to_regclass('public.fin_invoices') IS NOT NULL THEN
        RAISE EXCEPTION
            'post-0022 assertion failed: fin_invoices already exists; 0022 and 0023 are being applied '
            'in an order this file does not expect. Stop and reconcile the migration ledger';
    END IF;

    SELECT count(*) INTO v_n
      FROM pg_constraint con
     WHERE con.contype = 'f'
       AND con.confrelid = 'public.fin_billing_run_items'::regclass;
    IF v_n > 0 THEN
        RAISE EXCEPTION
            'post-0022 assertion failed: % FK(s) point at fin_billing_run_items; the table is a leaf by '
            'design and has no surrogate id, so any such FK is invalid', v_n;
    END IF;
END
$assert_no_forward_fk$;

-- 10.4 Every composite-FK target declared by this file carries its anchor.
DO $assert_anchors$
DECLARE
    v_missing text;
    v_n       integer;
BEGIN
    -- fin_billing_run_items is deliberately excluded: it has no surrogate id, so
    -- (tenant_id, id) does not exist and nothing references it.
    SELECT string_agg(t, ', ' ORDER BY t)
      INTO v_missing
      FROM unnest(ARRAY['fin_fee_structures','fin_fee_structure_items',
                        'fin_fee_installment_plans','fin_fee_structure_targets',
                        'fin_fee_assignments','fin_billing_runs']) AS t
     WHERE NOT EXISTS (
        SELECT 1 FROM pg_index i
          JOIN pg_class ic ON ic.oid = i.indexrelid
         WHERE i.indrelid = ('public.' || t)::regclass
           AND i.indisunique
           AND pg_get_indexdef(i.indexrelid) LIKE '%(tenant_id, id)%'
    );
    IF v_missing IS NOT NULL THEN
        RAISE EXCEPTION
            'post-0022 assertion failed: UNIQUE (tenant_id, id) anchor missing on %; a composite FK '
            'target without an anchor is a build failure, not a review comment', v_missing;
    END IF;

    -- The same guarantee for the existing parents, whose anchors this file
    -- relies on rather than creates.
    SELECT count(*) INTO v_n
      FROM pg_index i
     WHERE i.indrelid IN ('campuses'::regclass, 'grade_levels'::regclass,
                          'acd_classes'::regclass, 'sections'::regclass,
                          'students'::regclass, 'enrollments'::regclass,
                          'academic_years'::regclass)
       AND i.indisunique
       AND pg_get_indexdef(i.indexrelid) LIKE '%(tenant_id, id)%';
    IF v_n < 7 THEN
        RAISE EXCEPTION
            'post-0022 assertion failed: only % of the 7 existing parent anchors are present; '
            'the composite FKs of 0022 would not be legal by declaration', v_n;
    END IF;
END
$assert_anchors$;

-- 10.5 The declared UNIQUE and CHECK constraints exist, with the intended
-- uniqueness semantics.
DO $assert_constraints$
DECLARE
    v_expected text[] := ARRAY[
        'fin_fee_structures_code_uq', 'fin_fee_structures_ten_id_uq',
        'fin_fee_structures_status_ck', 'fin_fee_structures_dates_ck',
        'fin_fee_structures_published_ck',
        'fin_fee_structure_items_uq', 'fin_fee_structure_items_ten_id_uq',
        'fin_installment_plans_uq', 'fin_installment_plans_ten_id_uq',
        'fin_targets_uq', 'fin_targets_ten_id_uq', 'fin_targets_shape_ck',
        'fin_fee_assignments_ten_id_uq', 'fin_fee_assignments_range_ck',
        'fin_billing_runs_ten_id_uq', 'fin_billing_runs_idem_uq', 'fin_billing_runs_state_ck'
    ];
    v_c text;
    v_missing text;
    v_nd integer;
BEGIN
    FOREACH v_c IN ARRAY v_expected LOOP
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = v_c) THEN
            v_missing := coalesce(v_missing || ', ', '') || v_c;
        END IF;
    END LOOP;
    IF v_missing IS NOT NULL THEN
        RAISE EXCEPTION
            'post-0022 assertion failed: declared constraint(s) missing: %', v_missing;
    END IF;

    -- fin_targets_uq must carry NULLS NOT DISTINCT, or two identical grade
    -- targets differing only in a NULL campus_id would both be accepted.
    --
    -- Read from pg_get_constraintdef, not from a `connullsnotdistinct` catalog
    -- column: no such column exists in pg_constraint on PostgreSQL 18.6 (checked
    -- against attname ILIKE '%null%'), so a column-based assertion fails at
    -- runtime with 42703 rather than reporting the state it means to report. The
    -- rendered definition is also the thing a reader of the catalog sees, so
    -- asserting the rendering asserts the visible contract.
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'fin_targets_uq'
           AND pg_get_constraintdef(oid) LIKE 'UNIQUE NULLS NOT DISTINCT (%'
    ) THEN
        RAISE EXCEPTION
            'post-0022 assertion failed: fin_targets_uq is not NULLS NOT DISTINCT; a plain UNIQUE '
            'treats NULLs as distinct and the constraint would not mean what it says';
    END IF;

    -- fin_billing_runs_idem_uq must be tenant-scoped, so two tenants may use the
    -- same idempotency key.
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'fin_billing_runs_idem_uq'
           AND pg_get_constraintdef(oid) LIKE '%(tenant_id, idempotency_key)%'
    ) THEN
        RAISE EXCEPTION
            'post-0022 assertion failed: fin_billing_runs_idem_uq is not scoped to (tenant_id, idempotency_key)';
    END IF;

    -- The deduplication index must be a partial unique expression index; a plain
    -- UNIQUE cannot enforce it because NULLs are distinct.
    IF NOT EXISTS (
        SELECT 1 FROM pg_index i
          JOIN pg_class ic ON ic.oid = i.indexrelid
         WHERE ic.relname = 'fin_fee_assignments_one_active_uq'
           AND i.indisunique
           AND i.indpred IS NOT NULL
           AND pg_get_expr(i.indpred, i.indrelid) LIKE '%is_active%'
    ) THEN
        RAISE EXCEPTION
            'post-0022 assertion failed: fin_fee_assignments_one_active_uq is not a partial unique '
            'index with a WHERE is_active predicate';
    END IF;

    -- D4: and every NULLABLE key column must be inside a COALESCE. A COALESCE on
    -- the dates alone - which is what the first applied version of this file
    -- had - satisfies the assertion above and still lets two byte-identical
    -- "assign nothing" rows coexist, because two NULL structure_ids never
    -- collide. Asserting the predicate and not the key expression is what let
    -- that pass a green run.
    IF NOT EXISTS (
        SELECT 1 FROM pg_index i
          JOIN pg_class ic ON ic.oid = i.indexrelid
         WHERE ic.relname = 'fin_fee_assignments_one_active_uq'
           AND pg_get_indexdef(i.indexrelid)
               LIKE '%COALESCE(structure_id%'
           AND pg_get_indexdef(i.indexrelid)
               LIKE '%COALESCE(effective_from%'
           AND pg_get_indexdef(i.indexrelid)
               LIKE '%COALESCE(effective_to%'
    ) THEN
        RAISE EXCEPTION
            'post-0022 assertion failed: fin_fee_assignments_one_active_uq does not COALESCE '
            'structure_id, effective_from and effective_to; a nullable key column outside COALESCE '
            'escapes the index, so duplicate active assignments can be created';
    END IF;

    SELECT count(*) INTO v_nd FROM pg_constraint
     WHERE conname = 'fin_targets_uq'
       AND pg_get_constraintdef(oid) LIKE 'UNIQUE NULLS NOT DISTINCT (%';
    IF v_nd <> 1 THEN
        RAISE EXCEPTION
            'post-0022 assertion failed: fin_targets_uq NULLS NOT DISTINCT check matched % rows, not 1; '
            'either the constraint is gone or a duplicate name exists somewhere', v_nd;
    END IF;
END
$assert_constraints$;

-- 10.6 The trigger inventory is exactly the 8 declared statements, each naming a
-- function that exists and none of which is named trg_*.
DO $assert_triggers$
DECLARE
    -- pg_trigger.tgtype is a bitmask: 1=ROW, 2=BEFORE, 4=INSERT, 8=DELETE,
    -- 16=UPDATE, 32=TRUNCATE, 64=INSTEAD OF. The four values in use here are
    --   BEFORE UPDATE                    = 1+2+16     = 19
    --   BEFORE UPDATE OR DELETE          = 1+2+8+16   = 27
    --   BEFORE INSERT OR UPDATE          = 1+2+4+16   = 23
    --   BEFORE INSERT OR UPDATE OR DELETE= 1+2+4+8+16 = 31
    -- Asserting 1 (ROW alone) would have passed for a trigger with the WRONG
    -- timing and the WRONG events, which is the part of a binding that decides
    -- whether a freeze fires at all - and an INSERT-or-not on a freeze trigger
    -- is exactly the difference between D1 being fixed and D1 still being open.
    -- 19 appears in no row below on purpose: it is the value this file shipped
    -- with, and a migration that ever grows one again has reintroduced a hole.
    v_bad    text;
    v_n      integer;
    v_tables text[] := ARRAY['fin_fee_structures','fin_fee_structure_items',
                             'fin_fee_installment_plans','fin_fee_structure_targets',
                             'fin_fee_assignments','fin_billing_runs','fin_billing_run_items'];
BEGIN
    WITH e(tbl, trg, fn, tgtype) AS (
        VALUES
        ('fin_fee_structures',       'fin_structures_publish',       'trg_fin_structure_publish_freeze',  31),
        ('fin_fee_structure_targets','fin_targets_validate',         'trg_fin_target_validate',            23),
        ('fin_fee_structure_items',  'fin_structure_items_freeze',   'trg_fin_structure_child_freeze',     31),
        ('fin_fee_structure_targets','fin_structure_targets_freeze', 'trg_fin_structure_child_freeze',     31),
        ('fin_fee_installment_plans','fin_structure_plans_freeze',   'trg_fin_structure_child_freeze',     31),
        ('fin_fee_assignments',      'fin_assignments_validate',     'trg_fin_assignment_validate',        23),
        ('fin_billing_runs',         'fin_runs_freeze',              'trg_fin_billing_run_freeze',         27),
        ('fin_billing_run_items',    'fin_run_items_freeze',         'trg_fin_billing_run_items_freeze',   31)
    )
    SELECT string_agg(format('%s on %s', e.trg, e.tbl), ', ' ORDER BY e.trg)
      INTO v_bad
      FROM e
      LEFT JOIN pg_trigger t
        ON t.tgname = e.trg
       AND t.tgrelid = ('public.' || e.tbl)::regclass
       AND NOT t.tgisinternal
     WHERE t.oid IS NULL
        OR t.tgfoid <> (SELECT p.oid FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                         WHERE n.nspname = 'public' AND p.proname = e.fn)
        OR t.tgtype <> e.tgtype;
    IF v_bad IS NOT NULL THEN
        RAISE EXCEPTION 'post-0022 assertion failed: expected trigger(s) missing or mis-bound: %', v_bad;
    END IF;

    -- No trigger may name a function that is not one of the six, and no
    -- trigger may be named with the trg_ prefix, which is reserved for
    -- trigger FUNCTIONS.
    SELECT string_agg(format('%s on %s', t.tgname, t.tgrelid::regclass), ', ' ORDER BY t.tgname)
      INTO v_bad
      FROM pg_trigger t
     WHERE NOT t.tgisinternal
       AND t.tgrelid IN (SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                          WHERE n.nspname = 'public' AND c.relname = ANY(v_tables))
       AND (t.tgname LIKE 'trg\_%'
         OR t.tgfoid NOT IN (SELECT p.oid FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                              WHERE n.nspname = 'public'
                                AND p.proname IN ('trg_fin_structure_publish_freeze',
                                                  'trg_fin_structure_child_freeze',
                                                  'trg_fin_assignment_validate',
                                                  'trg_fin_billing_run_freeze',
                                                  'trg_fin_billing_run_items_freeze',
                                                  'trg_fin_target_validate')));
    IF v_bad IS NOT NULL THEN
        RAISE EXCEPTION 'post-0022 assertion failed: unexpected or mis-named trigger(s): %', v_bad;
    END IF;

    -- The six functions exist and are not world-callable.
    SELECT count(*) INTO v_n
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN ('trg_fin_structure_publish_freeze',
                         'trg_fin_structure_child_freeze',
                         'trg_fin_assignment_validate',
                         'trg_fin_billing_run_freeze',
                         'trg_fin_billing_run_items_freeze',
                         'trg_fin_target_validate')
       AND NOT EXISTS (SELECT 1 FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
                        WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE');
    IF v_n <> 6 THEN
        RAISE EXCEPTION
            'post-0022 assertion failed: % of 6 trigger functions exist and are revoked from PUBLIC', v_n;
    END IF;
END
$assert_triggers$;

-- 10.6b The freeze event coverage itself, asserted per binding.
--
-- 10.6 asserts the tgtype BITS, which is the same fact, but a reader who wants
-- to know "is INSERT covered" should not have to do arithmetic on a bitmask, and
-- the arithmetic is exactly what was wrong the first time. This states the
-- requirement in the same words as the design: a published structure's ITEMS,
-- TARGETS and PLANS may not be added, changed or removed.
DO $assert_freeze_events$
DECLARE
    v_missing text;
BEGIN
    SELECT string_agg(format('%s (%s)', t.tgrelid::regclass, t.tgname), ', ' ORDER BY t.tgrelid::regclass::text)
      INTO v_missing
      FROM (VALUES
                ('fin_fee_structure_items',   'fin_structure_items_freeze'),
                ('fin_fee_structure_targets', 'fin_structure_targets_freeze'),
                ('fin_fee_installment_plans', 'fin_structure_plans_freeze')) AS x(tbl, trg)
      JOIN pg_trigger t
        ON t.tgname = x.trg
       AND t.tgrelid = ('public.' || x.tbl)::regclass
       AND NOT t.tgisinternal
     WHERE (t.tgtype & 4)  = 0                       -- INSERT
        OR (t.tgtype & 16) = 0                       -- UPDATE
        OR (t.tgtype & 8)  = 0;                      -- DELETE
    IF v_missing IS NOT NULL THEN
        RAISE EXCEPTION
            'post-0022 assertion failed: freeze binding(s) missing INSERT, UPDATE or DELETE: %; a '
            'published structure''s lines would be addable or removable', v_missing;
    END IF;

    -- And the same for the header, which is the only guard against a published
    -- structure being deleted along with its ON DELETE CASCADE children. The
    -- INSERT bit rides along on the same assertion because §18's graph is the
    -- rule for entering a state, and the DELETE bit alone would pass on a
    -- binding that had quietly lost it.
    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger
         WHERE tgname = 'fin_structures_publish'
           AND tgrelid = 'public.fin_fee_structures'::regclass
           AND NOT tgisinternal
           AND (tgtype & 8) <> 0                    -- DELETE (D2)
           AND (tgtype & 16) <> 0                   -- UPDATE
           AND (tgtype & 4) <> 0) THEN              -- INSERT  (D6)
        RAISE EXCEPTION
            'post-0022 assertion failed: fin_structures_publish is not bound to INSERT, UPDATE and DELETE; '
            'a published structure can be removed, and PostgreSQL CASCADE does not fire the child '
            'triggers that would otherwise refuse - or a row can be born non-draft and never pass '
            'through the §18 graph at all';
    END IF;

    -- D5: the same three-word requirement for a committed billing run's ITEMS -
    -- they may not be added to that set, changed within it, or removed from it -
    -- plus the header's UPDATE and DELETE bits. An INSERT-or-not on either
    -- binding is the whole difference between D5 fixed and D5 open, so it is
    -- asserted by name rather than left to the tgtype bitmask above.
    SELECT string_agg(format('%s (%s)', t.tgrelid::regclass, t.tgname), ', ' ORDER BY t.tgrelid::regclass::text)
      INTO v_missing
      FROM (VALUES ('fin_billing_run_items', 'fin_run_items_freeze')) AS x(tbl, trg)
      JOIN pg_trigger t
        ON t.tgname = x.trg
       AND t.tgrelid = ('public.' || x.tbl)::regclass
       AND NOT t.tgisinternal
     WHERE (t.tgtype & 4)  = 0                       -- INSERT
        OR (t.tgtype & 16) = 0                       -- UPDATE
        OR (t.tgtype & 8)  = 0;                      -- DELETE
    IF v_missing IS NOT NULL THEN
        RAISE EXCEPTION
            'post-0022 assertion failed: committed-run item binding missing INSERT, UPDATE or DELETE: %; '
            'the amounts a regeneration must reproduce would be addable, editable or removable', v_missing;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger
         WHERE tgname = 'fin_runs_freeze'
           AND tgrelid = 'public.fin_billing_runs'::regclass
           AND NOT tgisinternal
           AND (tgtype & 8) <> 0                    -- DELETE
           AND (tgtype & 16) <> 0) THEN              -- UPDATE
        RAISE EXCEPTION
            'post-0022 assertion failed: fin_runs_freeze is not bound to UPDATE and DELETE; a committed '
            'run can be un-committed by clearing committed_at, or removed, and §8.4''s reproducibility '
            'guarantee becomes unfalsifiable';
    END IF;
END
$assert_freeze_events$;

-- 10.7 The security posture is UNREACHABLE, and it is asserted in the catalog
-- rather than assumed from the text above.
--
-- The three facts together are what "unreachable" means. Asserting only the
-- first would pass against a table that had RLS enabled and no policy, and
-- asserting only the third would pass against a table the runtime role can read
-- because 0001's default privilege was never taken back.
DO $assert_unreachable$
DECLARE
    v_tables text[] := ARRAY['fin_fee_structures','fin_fee_structure_items',
                             'fin_fee_installment_plans','fin_fee_structure_targets',
                             'fin_fee_assignments','fin_billing_runs','fin_billing_run_items'];
    v_tbl      text;
    v_survivor text;
    v_policies integer;
    v_rls_on   integer;
BEGIN
    FOREACH v_tbl IN ARRAY v_tables LOOP
        SELECT string_agg(p, ', ' ORDER BY p)
          INTO v_survivor
          FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE',
                            'REFERENCES','TRIGGER']) AS p
         WHERE has_table_privilege('school_app_rw', v_tbl, p);
        IF v_survivor IS NOT NULL THEN
            RAISE EXCEPTION
                'post-0022 assertion failed: role school_app_rw still holds % on %; 0001 ALTER DEFAULT '
                'PRIVILEGES granted this table at CREATE TABLE time and the per-table REVOKE did not '
                'take effect. A granted-but-RLS-not-yet-enabled finance table FAILS OPEN', v_survivor, v_tbl;
        END IF;
    END LOOP;

    -- 0028 owns RLS and the policies for every finance table. Finding either
    -- here means a copy of the policy set has been made outside 0028, and the
    -- two copies would then drift - which is the defect the design's own
    -- inventories exist to prevent.
    SELECT count(*) INTO v_policies
      FROM pg_policies WHERE schemaname = 'public' AND tablename = ANY(v_tables);
    IF v_policies <> 0 THEN
        RAISE EXCEPTION
            'post-0022 assertion failed: % policy/policies exist on 0022 tables; RLS and the finance '
            'policy set belong to 0028, and a second copy here would drift from the normative one', v_policies;
    END IF;

    SELECT count(*) INTO v_rls_on
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = ANY(v_tables) AND c.relrowsecurity;
    IF v_rls_on <> 0 THEN
        RAISE EXCEPTION
            'post-0022 assertion failed: RLS is already enabled on % of 7 0022 tables; 0021-0027 do not '
            'enable RLS, and 0028 does it once for all of them so that RLS precedes every grant', v_rls_on;
    END IF;
END
$assert_unreachable$;

-- 10.8 The FREEZE AND THE ANCHOR ACTUALLY HOLD, exercised rather than described.
--
-- Everything above reads the catalog: it proves the trigger is bound with the
-- right tgtype, and it says nothing about what the trigger does when it fires.
-- That gap is not theoretical. This file passed a full green verification run
-- three times with the child freeze bound to UPDATE OR DELETE only, with no
-- assignment anchor trigger at all, and with a deduplication index whose key
-- escaped the NULL structure. Each of those was a real defect, and each of those
-- runs was green, because the checks that existed could not see them. A catalog
-- assertion cannot catch a missing behaviour; only executing the statement can.
--
-- So the four defects are asserted by running them.
--
-- THE ROLLBACK MARKER. A published structure is deliberately unremovable - the
-- trigger refuses the DELETE, and demoting it to draft is also refused - so a
-- fixture containing one cannot be deleted afterwards by any legal statement.
-- The test therefore runs inside a subtransaction that is abandoned on purpose:
-- the trailing RAISE EXCEPTION is caught by the handler below, which discards
-- every fixture row, and the handler re-raises anything that is NOT the marker so
-- a genuine assertion failure still fails the migration. An exception raised
-- inside an exception handler is not caught by that same handler, so the
-- re-raise is safe. Nothing this block inserts survives it, which is what makes
-- it acceptable for a migration that also runs against a development database.
--
-- The ids are literals rather than gen_random_uuid() so that a failure message
-- can be reproduced by hand, and so that the fixture cannot collide with
-- anything: 00220000-... is not a value any table can produce on its own.
--
-- There is deliberately no helper procedure. A nested PL/pgSQL subprogram is
-- rejected by the plpgsql in this environment - `PROCEDURE p() AS $$ ... $$`
-- fails to parse at the parameter list, and the failure is a 42601 at a byte
-- offset with no line number, which is a miserable thing to debug inside a
-- migration. The three parallel arrays cost a few lines and need no grammar.
DO $assert_freeze_behaviour$
DECLARE
    v_tenant   CONSTANT uuid := '00220000-0000-4000-8000-000000000001';
    v_year1    CONSTANT uuid := '00220000-0000-4000-8000-000000000002';
    v_year2    CONSTANT uuid := '00220000-0000-4000-8000-000000000003';
    v_stu1     CONSTANT uuid := '00220000-0000-4000-8000-000000000004';
    v_stu2     CONSTANT uuid := '00220000-0000-4000-8000-000000000005';
    v_stu3     CONSTANT uuid := '00220000-0000-4000-8000-000000000015';
    v_enr      CONSTANT uuid := '00220000-0000-4000-8000-000000000006';
    v_enr2     CONSTANT uuid := '00220000-0000-4000-8000-000000000010';
    v_head     CONSTANT uuid := '00220000-0000-4000-8000-000000000007';
    v_pub      CONSTANT uuid := '00220000-0000-4000-8000-000000000008';
    v_draft    CONSTANT uuid := '00220000-0000-4000-8000-000000000009';
    v_user     CONSTANT uuid := '00220000-0000-4000-8000-00000000000a';
    v_ret      CONSTANT uuid := '00220000-0000-4000-8000-00000000000b';
    v_sup      CONSTANT uuid := '00220000-0000-4000-8000-00000000000c';
    v_run      CONSTANT uuid := '00220000-0000-4000-8000-00000000000d';
    v_run2     CONSTANT uuid := '00220000-0000-4000-8000-00000000000e';
    v_inv      CONSTANT uuid := '00220000-0000-4000-8000-00000000000f';
    v_audit    CONSTANT uuid := '00220000-0000-4000-8000-000000000011';
    v_draft2   CONSTANT uuid := '00220000-0000-4000-8000-000000000012';
    -- A third student, its enrollment, and a second draft run, so the item freeze
    -- can be tested on both sides of a re-pointed row. v_enr3 belongs to its own
    -- student because enrollments_student_year_uq gives a student one enrollment
    -- per year, and it is an enrollment the committed run has never seen: a move
    -- INTO the committed run must be refused by the freeze, not by the
    -- (tenant_id, run_id, enrollment_id) primary key, or the case would pass for
    -- the wrong reason.
    v_enr3     CONSTANT uuid := '00220000-0000-4000-8000-000000000013';
    v_run3     CONSTANT uuid := '00220000-0000-4000-8000-000000000014';
    v_err      text;
    v_lbl      text[] := ARRAY[]::text[];
    v_exp      text[] := ARRAY[]::text[];
    v_got      text[] := ARRAY[]::text[];
    i          integer;
BEGIN
  BEGIN
    ------------------------------------------------------------------ fixture
    INSERT INTO tenants (id, slug, name)
         VALUES (v_tenant, 'p7-0022-selftest', '0022 self-test');
    -- A real user, because published_by is FK-backed (D7) and because a
    -- write-once stamp probe that sets NULL to NULL is vacuous. On a database
    -- built from an empty schema there is no user to publish as, which is
    -- exactly how a stamp assertion comes to report PASS while testing nothing.
    INSERT INTO users (id, email, status)
         VALUES (v_user, 'p7-0022-selftest@example.invalid', 'active');
    INSERT INTO academic_years (id, tenant_id, code, name, starts_on, ends_on, status)
         VALUES (v_year1, v_tenant, '2025', '2025', DATE '2025-01-01', DATE '2025-12-31', 'active'),
                (v_year2, v_tenant, '2026', '2026', DATE '2026-01-01', DATE '2026-12-31', 'active');
    INSERT INTO students (id, tenant_id, student_no, first_name, last_name, status)
         VALUES (v_stu1, v_tenant, 'S-1', 'Ada', 'One',  'active'),
                (v_stu2, v_tenant, 'S-2', 'Ben', 'Two',  'active'),
                (v_stu3, v_tenant, 'S-3', 'Cleo', 'Three', 'active');
    -- A SECOND enrollment, because fin_billing_run_items is keyed
    -- (tenant_id, run_id, enrollment_id): a run's second line is a second
    -- enrollment, and a "second item" that reused the first enrollment's key
    -- would be refused by the PK before the freeze was ever reached, which is
    -- how the first draft of the D5 cases passed a delete for the wrong reason.
    INSERT INTO enrollments (id, tenant_id, student_id, academic_year_id, status)
         VALUES (v_enr,  v_tenant, v_stu1, v_year1, 'active'),
                (v_enr2, v_tenant, v_stu2, v_year1, 'active'),
                (v_enr3, v_tenant, v_stu3, v_year1, 'active');
    INSERT INTO fin_fee_heads (id, tenant_id, code, name)
         VALUES (v_head, v_tenant, 'TUITION', 'Tuition');

    -- One published-candidate with one of each child, and one deletable draft
    -- carrying the same three children.
    INSERT INTO fin_fee_structures (id, tenant_id, code, name, academic_year_id, effective_from)
         VALUES (v_pub,   v_tenant, 'PUB',   'Published', v_year1, DATE '2025-01-01'),
                (v_draft, v_tenant, 'DRAFT', 'Draft',     v_year1, DATE '2025-01-01');
    INSERT INTO fin_fee_structure_items (tenant_id, structure_id, fee_head_id, installment_no, amount)
         VALUES (v_tenant, v_pub,   v_head, 1, 100.00),
                (v_tenant, v_draft, v_head, 1, 100.00);
    INSERT INTO fin_fee_structure_targets (tenant_id, structure_id, target_type)
         VALUES (v_tenant, v_pub,   'all'),
                (v_tenant, v_draft, 'all');
    INSERT INTO fin_fee_installment_plans (tenant_id, structure_id, installment_no, due_on)
         VALUES (v_tenant, v_pub,   1, DATE '2025-03-01'),
                (v_tenant, v_draft, 1, DATE '2025-03-01');

    ------------------------------------------------- baseline: draft is open
    v_lbl := array_append(v_lbl, 'D0 a draft structure''s lines are editable');
    v_exp := array_append(v_exp, 'no error');
    v_err := NULL;
    BEGIN
        UPDATE fin_fee_structure_items SET amount = 200.00
         WHERE tenant_id = v_tenant AND structure_id = v_draft;
    EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_err = RETURNED_SQLSTATE;
    END;
    v_got := array_append(v_got, coalesce(v_err, 'no error'));

    v_lbl := array_append(v_lbl, 'D0 a line may be ADDED to a draft structure');
    v_exp := array_append(v_exp, 'no error');
    v_err := NULL;
    BEGIN
        INSERT INTO fin_fee_structure_items (tenant_id, structure_id, fee_head_id, installment_no, amount)
             VALUES (v_tenant, v_draft, v_head, 2, 50.00);
    EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_err = RETURNED_SQLSTATE;
    END;
    v_got := array_append(v_got, coalesce(v_err, 'no error'));

    ------------------------------------------------------------- publish it
    v_lbl := array_append(v_lbl, 'D0 a draft may be published');
    v_exp := array_append(v_exp, 'no error');
    v_err := NULL;
    BEGIN
        UPDATE fin_fee_structures SET status = 'published'
         WHERE tenant_id = v_tenant AND id = v_pub;
    EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_err = RETURNED_SQLSTATE;
    END;
    v_got := array_append(v_got, coalesce(v_err, 'no error'));

    IF (SELECT published_at IS NULL FROM fin_fee_structures
         WHERE tenant_id = v_tenant AND id = v_pub) THEN
        RAISE EXCEPTION
            'post-0022 assertion failed: publishing did not stamp published_at';
    END IF;

    ------------------------------------------------------ D1: child INSERT
    -- The three inserts that were accepted against the draft one statement
    -- earlier, against the same columns and the same shape.
    v_lbl := array_append(v_lbl, 'D1 an ITEM may not be added to a published structure');
    v_exp := array_append(v_exp, '55000');
    v_err := NULL;
    BEGIN
        INSERT INTO fin_fee_structure_items (tenant_id, structure_id, fee_head_id, installment_no, amount)
             VALUES (v_tenant, v_pub, v_head, 2, 50.00);
    EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_err = RETURNED_SQLSTATE;
    END;
    v_got := array_append(v_got, coalesce(v_err, 'no error'));

    v_lbl := array_append(v_lbl, 'D1 a TARGET may not be added to a published structure');
    v_exp := array_append(v_exp, '55000');
    v_err := NULL;
    BEGIN
        INSERT INTO fin_fee_structure_targets (tenant_id, structure_id, target_type)
             VALUES (v_tenant, v_pub, 'all');
    EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_err = RETURNED_SQLSTATE;
    END;
    v_got := array_append(v_got, coalesce(v_err, 'no error'));

    v_lbl := array_append(v_lbl, 'D1 a PLAN may not be added to a published structure');
    v_exp := array_append(v_exp, '55000');
    v_err := NULL;
    BEGIN
        INSERT INTO fin_fee_installment_plans (tenant_id, structure_id, installment_no, due_on)
             VALUES (v_tenant, v_pub, 2, DATE '2025-06-01');
    EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_err = RETURNED_SQLSTATE;
    END;
    v_got := array_append(v_got, coalesce(v_err, 'no error'));

    -------------------------------------------------- D1: child UPDATE/DELETE
    v_lbl := array_append(v_lbl, 'D1 an ITEM of a published structure may not be changed');
    v_exp := array_append(v_exp, '55000');
    v_err := NULL;
    BEGIN
        UPDATE fin_fee_structure_items SET amount = 999.00
         WHERE tenant_id = v_tenant AND structure_id = v_pub;
    EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_err = RETURNED_SQLSTATE;
    END;
    v_got := array_append(v_got, coalesce(v_err, 'no error'));

    v_lbl := array_append(v_lbl, 'D1 a TARGET of a published structure may not be changed');
    v_exp := array_append(v_exp, '55000');
    v_err := NULL;
    BEGIN
        UPDATE fin_fee_structure_targets SET priority = 99
         WHERE tenant_id = v_tenant AND structure_id = v_pub;
    EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_err = RETURNED_SQLSTATE;
    END;
    v_got := array_append(v_got, coalesce(v_err, 'no error'));

    v_lbl := array_append(v_lbl, 'D1 a PLAN of a published structure may not be changed');
    v_exp := array_append(v_exp, '55000');
    v_err := NULL;
    BEGIN
        UPDATE fin_fee_installment_plans SET label = 'moved'
         WHERE tenant_id = v_tenant AND structure_id = v_pub;
    EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_err = RETURNED_SQLSTATE;
    END;
    v_got := array_append(v_got, coalesce(v_err, 'no error'));

    v_lbl := array_append(v_lbl, 'D1 an ITEM may not be deleted directly');
    v_exp := array_append(v_exp, '55000');
    v_err := NULL;
    BEGIN
        DELETE FROM fin_fee_structure_items
         WHERE tenant_id = v_tenant AND structure_id = v_pub;
    EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_err = RETURNED_SQLSTATE;
    END;
    v_got := array_append(v_got, coalesce(v_err, 'no error'));

    ------------------------------------------------------------ D2: the header
    -- Deleting the header is the only route to the children: this DELETE would
    -- otherwise cascade to all three child tables without firing any of the
    -- child triggers, which is precisely why the guard has to be here.
    v_lbl := array_append(v_lbl, 'D2 a published structure may not be DELETEd');
    v_exp := array_append(v_exp, '55000');
    v_err := NULL;
    BEGIN
        DELETE FROM fin_fee_structures WHERE tenant_id = v_tenant AND id = v_pub;
    EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_err = RETURNED_SQLSTATE;
    END;
    v_got := array_append(v_got, coalesce(v_err, 'no error'));

    IF NOT EXISTS (SELECT 1 FROM fin_fee_structure_items
                    WHERE tenant_id = v_tenant AND structure_id = v_pub) THEN
        RAISE EXCEPTION
            'post-0022 assertion failed: the refused header DELETE still removed the child ITEM; the '
            'guard fired but the cascade went through';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM fin_fee_structure_targets
                    WHERE tenant_id = v_tenant AND structure_id = v_pub) THEN
        RAISE EXCEPTION
            'post-0022 assertion failed: the refused header DELETE still removed the child TARGET';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM fin_fee_installment_plans
                    WHERE tenant_id = v_tenant AND structure_id = v_pub) THEN
        RAISE EXCEPTION
            'post-0022 assertion failed: the refused header DELETE still removed the child PLAN';
    END IF;

    -- supersedes_id is the documented mutable column and must stay writable.
    v_lbl := array_append(v_lbl, 'D0 supersedes_id stays mutable after publication');
    v_exp := array_append(v_exp, 'no error');
    v_err := NULL;
    BEGIN
        UPDATE fin_fee_structures SET supersedes_id = v_draft
         WHERE tenant_id = v_tenant AND id = v_pub;
    EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_err = RETURNED_SQLSTATE;
    END;
    v_got := array_append(v_got, coalesce(v_err, 'no error'));

    v_lbl := array_append(v_lbl, 'D0 supersedes_id may be cleared again');
    v_exp := array_append(v_exp, 'no error');
    v_err := NULL;
    BEGIN
        UPDATE fin_fee_structures SET supersedes_id = NULL
         WHERE tenant_id = v_tenant AND id = v_pub;
    EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_err = RETURNED_SQLSTATE;
    END;
    v_got := array_append(v_got, coalesce(v_err, 'no error'));

    ------------------------------------------------- D1c: the soft-delete hole
    v_lbl := array_append(v_lbl, 'D1c a published structure may not be soft-deleted');
    v_exp := array_append(v_exp, '55000');
    v_err := NULL;
    BEGIN
        UPDATE fin_fee_structures SET deleted_at = now()
         WHERE tenant_id = v_tenant AND id = v_pub;
    EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_err = RETURNED_SQLSTATE;
    END;
    v_got := array_append(v_got, coalesce(v_err, 'no error'));

    v_lbl := array_append(v_lbl, 'D1 a published structure may not be renamed');
    v_exp := array_append(v_exp, '55000');
    v_err := NULL;
    BEGIN
        UPDATE fin_fee_structures SET name = 'Renamed'
         WHERE tenant_id = v_tenant AND id = v_pub;
    EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_err = RETURNED_SQLSTATE;
    END;
    v_got := array_append(v_got, coalesce(v_err, 'no error'));

    -- A draft that still has children must remain deletable, or the guard is
    -- indistinguishable from a blanket denial and no application can use this.
    v_lbl := array_append(v_lbl, 'D2 a DRAFT structure with children may still be deleted');
    v_exp := array_append(v_exp, 'no error');
    v_err := NULL;
    BEGIN
        DELETE FROM fin_fee_structures WHERE tenant_id = v_tenant AND id = v_draft;
    EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_err = RETURNED_SQLSTATE;
    END;
    v_got := array_append(v_got, coalesce(v_err, 'no error'));

    IF EXISTS (SELECT 1 FROM fin_fee_structure_items
                WHERE tenant_id = v_tenant AND structure_id = v_draft) THEN
        RAISE EXCEPTION
            'post-0022 assertion failed: deleting a draft left its ITEM behind; the cascade is broken';
    END IF;
    IF EXISTS (SELECT 1 FROM fin_fee_structure_targets
                WHERE tenant_id = v_tenant AND structure_id = v_draft) THEN
        RAISE EXCEPTION
            'post-0022 assertion failed: deleting a draft left its TARGET behind';
    END IF;
    IF EXISTS (SELECT 1 FROM fin_fee_installment_plans
                WHERE tenant_id = v_tenant AND structure_id = v_draft) THEN
        RAISE EXCEPTION
            'post-0022 assertion failed: deleting a draft left its PLAN behind';
    END IF;

    --------------------------------------------------------- D3: the 6.4 pin
    -- In every D3 case below all four FKs are SATISFIED: the referenced student,
    -- enrollment, year and structure all exist in this tenant. So the only thing
    -- that can refuse the row is the anchor trigger. This is the difference
    -- between a pin and a set of foreign keys.
    v_lbl := array_append(v_lbl, 'D3 an assignment matching its anchor is accepted');
    v_exp := array_append(v_exp, 'no error');
    v_err := NULL;
    BEGIN
        INSERT INTO fin_fee_assignments
               (tenant_id, structure_id, enrollment_id, student_id, academic_year_id,
                effective_from, is_active)
             VALUES (v_tenant, v_pub, v_enr, v_stu1, v_year1, DATE '2025-01-01', true);
    EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_err = RETURNED_SQLSTATE;
    END;
    v_got := array_append(v_got, coalesce(v_err, 'no error'));

    v_lbl := array_append(v_lbl, 'D3 student_id may not differ from the enrollment''s student');
    v_exp := array_append(v_exp, '55000');
    v_err := NULL;
    BEGIN
        INSERT INTO fin_fee_assignments
               (tenant_id, structure_id, enrollment_id, student_id, academic_year_id,
                effective_from, is_active)
             VALUES (v_tenant, v_pub, v_enr, v_stu2, v_year1, DATE '2025-01-01', true);
    EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_err = RETURNED_SQLSTATE;
    END;
    v_got := array_append(v_got, coalesce(v_err, 'no error'));

    v_lbl := array_append(v_lbl, 'D3 academic_year_id may not differ from the enrollment''s year');
    v_exp := array_append(v_exp, '55000');
    v_err := NULL;
    BEGIN
        INSERT INTO fin_fee_assignments
               (tenant_id, structure_id, enrollment_id, student_id, academic_year_id,
                effective_from, is_active)
             VALUES (v_tenant, v_pub, v_enr, v_stu1, v_year2, DATE '2025-01-01', true);
    EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_err = RETURNED_SQLSTATE;
    END;
    v_got := array_append(v_got, coalesce(v_err, 'no error'));

    -- The pin must hold on UPDATE too, or it is a check on first write only.
    v_lbl := array_append(v_lbl, 'D3 an assignment may not be re-pointed at another student');
    v_exp := array_append(v_exp, '55000');
    v_err := NULL;
    BEGIN
        UPDATE fin_fee_assignments SET student_id = v_stu2
         WHERE tenant_id = v_tenant AND enrollment_id = v_enr;
    EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_err = RETURNED_SQLSTATE;
    END;
    v_got := array_append(v_got, coalesce(v_err, 'no error'));

    -- A withdrawn enrollment is still a real anchor. Asserted explicitly so a
    -- future reader does not "fix" 8.4 by adding an enrollment-status check.
    UPDATE enrollments SET status = 'withdrawn' WHERE id = v_enr;
    v_lbl := array_append(v_lbl, 'D3 a WITHDRAWN enrollment is still a valid anchor');
    v_exp := array_append(v_exp, 'no error');
    v_err := NULL;
    BEGIN
        INSERT INTO fin_fee_assignments
               (tenant_id, structure_id, enrollment_id, student_id, academic_year_id,
                effective_from, effective_to, is_active)
             VALUES (v_tenant, v_pub, v_enr, v_stu1, v_year1,
                     DATE '2025-02-01', DATE '2025-03-01', true);
    EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_err = RETURNED_SQLSTATE;
    END;
    v_got := array_append(v_got, coalesce(v_err, 'no error'));

    ------------------------------------------------------------ D4: dedup
    -- Two byte-identical "assign nothing" rows, same enrollment, same period.
    -- Before the fix both were accepted: a bare structure_id key column is a
    -- NULL to the index, and two NULLs never collide.
    v_lbl := array_append(v_lbl, 'D4 a first NULL-structure assignment is accepted');
    v_exp := array_append(v_exp, 'no error');
    v_err := NULL;
    BEGIN
        INSERT INTO fin_fee_assignments
               (tenant_id, structure_id, enrollment_id, student_id, academic_year_id,
                effective_from, is_active)
             VALUES (v_tenant, NULL, v_enr, v_stu1, v_year1, DATE '2025-04-01', true);
    EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_err = RETURNED_SQLSTATE;
    END;
    v_got := array_append(v_got, coalesce(v_err, 'no error'));

    v_lbl := array_append(v_lbl, 'D4 the identical second NULL-structure assignment is refused');
    v_exp := array_append(v_exp, '23505');
    v_err := NULL;
    BEGIN
        INSERT INTO fin_fee_assignments
               (tenant_id, structure_id, enrollment_id, student_id, academic_year_id,
                effective_from, is_active)
             VALUES (v_tenant, NULL, v_enr, v_stu1, v_year1, DATE '2025-04-01', true);
    EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_err = RETURNED_SQLSTATE;
    END;
    v_got := array_append(v_got, coalesce(v_err, 'no error'));

    -- The date sentinels must still distinguish, so this row is legitimate.
    v_lbl := array_append(v_lbl, 'D4 a different effective_from is still a distinct assignment');
    v_exp := array_append(v_exp, 'no error');
    v_err := NULL;
    BEGIN
        INSERT INTO fin_fee_assignments
               (tenant_id, structure_id, enrollment_id, student_id, academic_year_id,
                effective_from, is_active)
             VALUES (v_tenant, NULL, v_enr, v_stu1, v_year1, DATE '2025-05-01', true);
    EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_err = RETURNED_SQLSTATE;
    END;
    v_got := array_append(v_got, coalesce(v_err, 'no error'));

    -- is_active is the predicate, so an inactive row is outside the index.
    v_lbl := array_append(v_lbl, 'D4 an inactive duplicate is outside the index and is accepted');
    v_exp := array_append(v_exp, 'no error');
    v_err := NULL;
    BEGIN
        INSERT INTO fin_fee_assignments
               (tenant_id, structure_id, enrollment_id, student_id, academic_year_id,
                effective_from, is_active)
             VALUES (v_tenant, NULL, v_enr, v_stu1, v_year1, DATE '2025-04-01', false);
    EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_err = RETURNED_SQLSTATE;
    END;
    v_got := array_append(v_got, coalesce(v_err, 'no error'));

    ---------------------------------------------- D7: published_by is a reference
    -- A structure of its own for the D7 probes: v_draft has already been deleted
    -- by the D2 case above, and an UPDATE that matches no row raises nothing at
    -- all - so reusing it here would have made this case PASS for the wrong
    -- reason, which is the failure mode this file keeps refusing to accept.
    INSERT INTO fin_fee_structures (id, tenant_id, code, name, academic_year_id, effective_from)
         VALUES (v_audit, v_tenant, 'AUD', 'Audit Probe', v_year1, DATE '2025-01-01');

    -- A nonexistent user id must be refused, which is the whole content of D7.
    v_lbl := array_append(v_lbl, 'D7 a structure may NOT be published by a user who does not exist');
    v_exp := array_append(v_exp, '23503');
    v_err := NULL;
    BEGIN
        UPDATE fin_fee_structures SET status = 'published', published_by = v_stu1
         WHERE tenant_id = v_tenant AND id = v_audit;
    EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_err = RETURNED_SQLSTATE;
    END;
    v_got := array_append(v_got, coalesce(v_err, 'no error'));

    v_lbl := array_append(v_lbl, 'D7 the real user is accepted as the publisher');
    v_exp := array_append(v_exp, 'no error');
    v_err := NULL;
    BEGIN
        UPDATE fin_fee_structures SET status = 'published', published_by = v_user
         WHERE tenant_id = v_tenant AND id = v_audit;
    EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_err = RETURNED_SQLSTATE;
    END;
    v_got := array_append(v_got, coalesce(v_err, 'no error'));

    IF (SELECT published_by IS DISTINCT FROM v_user FROM fin_fee_structures
         WHERE tenant_id = v_tenant AND id = v_audit) THEN
        RAISE EXCEPTION 'post-0022 assertion failed: the accepted publisher was not recorded';
    END IF;

    -- The delete rule, asserted rather than assumed. This is the case that
    -- decided ON DELETE RESTRICT: the write-once publication stamp refuses the
    -- UPDATE a SET NULL referential action has to perform, so with SET NULL the
    -- delete raised 55000 from the trigger instead of 23503 from this FK, and
    -- the constraint's declared action could never run. Under RESTRICT the
    -- refusal arrives here, at the layer that can name the reason, and the audit
    -- stamp is left completely untouched by the attempt.
    -- 23001, restrict_violation, and not 23503 foreign_key_violation: RESTRICT
    -- reports its own SQLSTATE and refuses at once, where NO ACTION would defer
    -- the same verdict to the end of the statement. The distinction is the point
    -- of choosing RESTRICT, so it is asserted exactly rather than as REJECTED.
    v_lbl := array_append(v_lbl, 'D7 a user who published a structure may NOT be deleted');
    v_exp := array_append(v_exp, '23001');
    v_err := NULL;
    BEGIN
        DELETE FROM users WHERE id = v_user;
    EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_err = RETURNED_SQLSTATE;
    END;
    v_got := array_append(v_got, coalesce(v_err, 'no error'));

    v_lbl := array_append(v_lbl, 'D7 and the refused delete left the publication stamp intact');
    v_exp := array_append(v_exp, 'no error');
    v_err := NULL;
    BEGIN
        IF (SELECT published_by IS DISTINCT FROM v_user
               OR published_at IS NULL
              FROM fin_fee_structures WHERE tenant_id = v_tenant AND id = v_audit) THEN
            RAISE EXCEPTION 'the publication stamp did not survive the refused delete';
        END IF;
    EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_err = RETURNED_SQLSTATE;
    END;
    v_got := array_append(v_got, coalesce(v_err, 'no error'));

    ----------------------------------------------------- D6: the §18 status graph
    -- A structure may not be born in a state §18 gives no edge into. The
    -- trigger has to be the reason: the published_ck would also reject this row,
    -- with 23514 and a complaint about published_at, which is a different rule
    -- arriving later by accident rather than the graph being enforced.
    v_lbl := array_append(v_lbl, 'D6 a structure may not be CREATED as published');
    v_exp := array_append(v_exp, '55000');
    v_err := NULL;
    BEGIN
        INSERT INTO fin_fee_structures (id, tenant_id, code, name, academic_year_id, effective_from,
                                        status, published_at)
             VALUES ('00220000-0000-4000-8000-0000000000ff', v_tenant, 'BORN', 'Born published',
                     v_year1, DATE '2025-01-01', 'published', now());
    EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_err = RETURNED_SQLSTATE;
    END;
    v_got := array_append(v_got, coalesce(v_err, 'no error'));

    v_lbl := array_append(v_lbl, 'D6 a structure may not be CREATED as retired');
    v_exp := array_append(v_exp, '55000');
    v_err := NULL;
    BEGIN
        -- fin_fee_structures carries no retired_at: retirement is recorded by the
        -- status alone, and the retirement date is the historical row's. A probe
        -- that named a retired_at column would fail with 42703 and look like a
        -- PASS about the graph, which is why this is the shape used here.
        INSERT INTO fin_fee_structures (id, tenant_id, code, name, academic_year_id, effective_from,
                                        status)
             VALUES ('00220000-0000-4000-8000-0000000000fe', v_tenant, 'BORN2', 'Born retired',
                     v_year1, DATE '2025-01-01', 'retired');
    EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_err = RETURNED_SQLSTATE;
    END;
    v_got := array_append(v_got, coalesce(v_err, 'no error'));

    -- Two structures, one retired and one superseded, both of which the first
    -- applied version of this file let return to 'published'.
    INSERT INTO fin_fee_structures (id, tenant_id, code, name, academic_year_id, effective_from)
         VALUES (v_ret, v_tenant, 'RET', 'Retired', v_year1, DATE '2025-01-01'),
                (v_sup, v_tenant, 'SUP', 'Superseded', v_year1, DATE '2025-01-01');
    UPDATE fin_fee_structures SET status = 'published'
     WHERE tenant_id = v_tenant AND id IN (v_ret, v_sup);

    v_lbl := array_append(v_lbl, 'D6 published -> retired is an edge of §18''s graph');
    v_exp := array_append(v_exp, 'no error');
    v_err := NULL;
    BEGIN
        UPDATE fin_fee_structures SET status = 'retired'
         WHERE tenant_id = v_tenant AND id = v_ret;
    EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_err = RETURNED_SQLSTATE;
    END;
    v_got := array_append(v_got, coalesce(v_err, 'no error'));

    v_lbl := array_append(v_lbl, 'D6 published -> superseded is an edge of §18''s graph');
    v_exp := array_append(v_exp, 'no error');
    v_err := NULL;
    BEGIN
        UPDATE fin_fee_structures SET status = 'superseded'
         WHERE tenant_id = v_tenant AND id = v_sup;
    EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_err = RETURNED_SQLSTATE;
    END;
    v_got := array_append(v_got, coalesce(v_err, 'no error'));

    -- The reported P2. Retired is terminal in §18, and republication re-issues a
    -- price list families have already been billed against.
    v_lbl := array_append(v_lbl, 'D6 a RETIRED structure may not be published again');
    v_exp := array_append(v_exp, '55000');
    v_err := NULL;
    BEGIN
        UPDATE fin_fee_structures SET status = 'published'
         WHERE tenant_id = v_tenant AND id = v_ret;
    EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_err = RETURNED_SQLSTATE;
    END;
    v_got := array_append(v_got, coalesce(v_err, 'no error'));

    v_lbl := array_append(v_lbl, 'D6 a SUPERSEDED structure may not be published again');
    v_exp := array_append(v_exp, '55000');
    v_err := NULL;
    BEGIN
        UPDATE fin_fee_structures SET status = 'published'
         WHERE tenant_id = v_tenant AND id = v_sup;
    EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_err = RETURNED_SQLSTATE;
    END;
    v_got := array_append(v_got, coalesce(v_err, 'no error'));

    v_lbl := array_append(v_lbl, 'D6 a retired structure may not be retired a second time under a new name');
    v_exp := array_append(v_exp, '55000');
    v_err := NULL;
    BEGIN
        UPDATE fin_fee_structures SET status = 'superseded'
         WHERE tenant_id = v_tenant AND id = v_ret;
    EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_err = RETURNED_SQLSTATE;
    END;
    v_got := array_append(v_got, coalesce(v_err, 'no error'));

    v_lbl := array_append(v_lbl, 'D6 a retired structure stays frozen for its other columns');
    v_exp := array_append(v_exp, '55000');
    v_err := NULL;
    BEGIN
        UPDATE fin_fee_structures SET name = 'Retired rename'
         WHERE tenant_id = v_tenant AND id = v_ret;
    EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_err = RETURNED_SQLSTATE;
    END;
    v_got := array_append(v_got, coalesce(v_err, 'no error'));

    -- A no-op is not a transition and must stay legal, or the one mutable column
    -- of a published structure would be unusable.
    v_lbl := array_append(v_lbl, 'D6 re-stating a retired structure''s own status is a no-op, not an edge');
    v_exp := array_append(v_exp, 'no error');
    v_err := NULL;
    BEGIN
        UPDATE fin_fee_structures SET status = 'retired'
         WHERE tenant_id = v_tenant AND id = v_ret;
    EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_err = RETURNED_SQLSTATE;
    END;
    v_got := array_append(v_got, coalesce(v_err, 'no error'));

    -- §18's only edge INTO superseded starts at published, so a structure that
    -- was never published cannot be superseded: nothing has replaced it.
    --
    -- A structure of its own, because v_pub is PUBLISHED by the time this block
    -- runs - v_pub is the D1/D2 fixture - and published -> superseded is a legal
    -- edge, so aiming the draft case at it would have returned "no error" and
    -- been reported as the graph refusing something it never saw.
    INSERT INTO fin_fee_structures (id, tenant_id, code, name, academic_year_id, effective_from)
         VALUES (v_draft2, v_tenant, 'DRF2', 'Draft Two', v_year1, DATE '2025-01-01');

    v_lbl := array_append(v_lbl, 'D6 a DRAFT structure may not be marked superseded');
    v_exp := array_append(v_exp, '55000');
    v_err := NULL;
    BEGIN
        UPDATE fin_fee_structures SET status = 'superseded', supersedes_id = v_ret
         WHERE tenant_id = v_tenant AND id = v_draft2;
    EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_err = RETURNED_SQLSTATE;
    END;
    v_got := array_append(v_got, coalesce(v_err, 'no error'));

    v_lbl := array_append(v_lbl, 'D6 a DRAFT structure may not be marked retired');
    v_exp := array_append(v_exp, '55000');
    v_err := NULL;
    BEGIN
        UPDATE fin_fee_structures SET status = 'retired'
         WHERE tenant_id = v_tenant AND id = v_draft2;
    EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_err = RETURNED_SQLSTATE;
    END;
    v_got := array_append(v_got, coalesce(v_err, 'no error'));

    v_lbl := array_append(v_lbl, 'D6 that draft is still a draft, unstamped and unpointed');
    v_exp := array_append(v_exp, 'no error');
    v_err := NULL;
    BEGIN
        PERFORM 1 FROM fin_fee_structures
         WHERE tenant_id = v_tenant AND id = v_draft2
           AND status = 'draft' AND published_at IS NULL AND supersedes_id IS NULL;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'refused transitions changed the row';
        END IF;
    EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_err = RETURNED_SQLSTATE;
    END;
    v_got := array_append(v_got, coalesce(v_err, 'no error'));

    ------------------------------------------------------------ D5: the run freeze
    -- A draft run, one item, and every mutation the design expects to be legal
    -- before the commit. If any of these is refused the freeze is a blanket
    -- denial and no billing could ever be generated.
    INSERT INTO fin_billing_runs (id, tenant_id, academic_year_id, status, structure_ids,
                                  idempotency_key, total_students, total_amount, started_by)
         VALUES (v_run, v_tenant, v_year1, 'draft', ARRAY[v_pub], '0022-SELFTEST-1',
                 1, 100.00, v_user);
    INSERT INTO fin_billing_run_items (tenant_id, run_id, enrollment_id, student_id,
                                       structure_id, amount)
         VALUES (v_tenant, v_run, v_enr, v_stu1, v_pub, 100.00);

    v_lbl := array_append(v_lbl, 'D5 a DRAFT run''s items are freely editable');
    v_exp := array_append(v_exp, 'no error');
    v_err := NULL;
    BEGIN
        UPDATE fin_billing_run_items SET amount = 120.00
         WHERE tenant_id = v_tenant AND run_id = v_run;
    EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_err = RETURNED_SQLSTATE;
    END;
    v_got := array_append(v_got, coalesce(v_err, 'no error'));

    v_lbl := array_append(v_lbl, 'D5 a second item may be added to a DRAFT run');
    v_exp := array_append(v_exp, 'no error');
    v_err := NULL;
    BEGIN
        INSERT INTO fin_billing_run_items (tenant_id, run_id, enrollment_id, student_id,
                                           structure_id, amount)
             VALUES (v_tenant, v_run, v_enr2, v_stu2, v_pub, 20.00);
    EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_err = RETURNED_SQLSTATE;
    END;
    v_got := array_append(v_got, coalesce(v_err, 'no error'));

    v_lbl := array_append(v_lbl, 'D5 a DRAFT run may be previewed, and a preview may be re-stated');
    v_exp := array_append(v_exp, 'no error');
    v_err := NULL;
    BEGIN
        UPDATE fin_billing_runs SET status = 'preview' WHERE tenant_id = v_tenant AND id = v_run;
        UPDATE fin_billing_runs SET total_students = 2 WHERE tenant_id = v_tenant AND id = v_run;
    EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_err = RETURNED_SQLSTATE;
    END;
    v_got := array_append(v_got, coalesce(v_err, 'no error'));

    v_lbl := array_append(v_lbl, 'D5 a run may be committed');
    v_exp := array_append(v_exp, 'no error');
    v_err := NULL;
    BEGIN
        UPDATE fin_billing_runs SET status = 'committed', committed_at = now()
         WHERE tenant_id = v_tenant AND id = v_run;
    EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_err = RETURNED_SQLSTATE;
    END;
    v_got := array_append(v_got, coalesce(v_err, 'no error'));

    -- Everything below is the freeze. Each of these was a legal statement against
    -- the first applied version of this file.
    v_lbl := array_append(v_lbl, 'D5 committed_at may NOT be cleared to un-commit the run');
    v_exp := array_append(v_exp, '55000');
    v_err := NULL;
    BEGIN
        UPDATE fin_billing_runs SET status = 'preview', committed_at = NULL
         WHERE tenant_id = v_tenant AND id = v_run;
    EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_err = RETURNED_SQLSTATE;
    END;
    v_got := array_append(v_got, coalesce(v_err, 'no error'));

    v_lbl := array_append(v_lbl, 'D5 a committed run''s idempotency key, totals and structure_ids are frozen');
    v_exp := array_append(v_exp, '55000');
    v_err := NULL;
    BEGIN
        UPDATE fin_billing_runs
           SET idempotency_key = '0022-REWRITTEN', total_students = 999,
               total_invoices = 42, total_amount = 12345.00, structure_ids = ARRAY[v_ret]
         WHERE tenant_id = v_tenant AND id = v_run;
    EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_err = RETURNED_SQLSTATE;
    END;
    v_got := array_append(v_got, coalesce(v_err, 'no error'));

    v_lbl := array_append(v_lbl, 'D5 a committed run may not be cancelled by un-committing it');
    v_exp := array_append(v_exp, '55000');
    v_err := NULL;
    BEGIN
        UPDATE fin_billing_runs
           SET status = 'cancelled', committed_at = NULL, cancelled_at = now(),
               cancelled_reason = 'superseded'
         WHERE tenant_id = v_tenant AND id = v_run;
    EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_err = RETURNED_SQLSTATE;
    END;
    v_got := array_append(v_got, coalesce(v_err, 'no error'));

    v_lbl := array_append(v_lbl, 'D5 a committed run may not even be re-stated with its own totals');
    v_exp := array_append(v_exp, '55000');
    v_err := NULL;
    BEGIN
        UPDATE fin_billing_runs SET total_students = 2 WHERE tenant_id = v_tenant AND id = v_run;
    EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_err = RETURNED_SQLSTATE;
    END;
    v_got := array_append(v_got, coalesce(v_err, 'no error'));

    v_lbl := array_append(v_lbl, 'D5 a committed run may not be DELETEd');
    v_exp := array_append(v_exp, '55000');
    v_err := NULL;
    BEGIN
        DELETE FROM fin_billing_runs WHERE tenant_id = v_tenant AND id = v_run;
    EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_err = RETURNED_SQLSTATE;
    END;
    v_got := array_append(v_got, coalesce(v_err, 'no error'));

    v_lbl := array_append(v_lbl, 'D5 an item may not be ADDED to a committed run');
    v_exp := array_append(v_exp, '55000');
    v_err := NULL;
    BEGIN
        INSERT INTO fin_billing_run_items (tenant_id, run_id, enrollment_id, student_id,
                                           structure_id, amount)
             VALUES (v_tenant, v_run, v_stu1, v_stu1, v_pub, 1.00);
    EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_err = RETURNED_SQLSTATE;
    END;
    v_got := array_append(v_got, coalesce(v_err, 'no error'));

    v_lbl := array_append(v_lbl, 'D5 an item of a committed run may not be re-priced');
    v_exp := array_append(v_exp, '55000');
    v_err := NULL;
    BEGIN
        UPDATE fin_billing_run_items SET amount = 999.00
         WHERE tenant_id = v_tenant AND run_id = v_run;
    EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_err = RETURNED_SQLSTATE;
    END;
    v_got := array_append(v_got, coalesce(v_err, 'no error'));

    v_lbl := array_append(v_lbl, 'D5 an item of a committed run may not be deleted');
    v_exp := array_append(v_exp, '55000');
    v_err := NULL;
    BEGIN
        DELETE FROM fin_billing_run_items
         WHERE tenant_id = v_tenant AND run_id = v_run AND enrollment_id = v_enr2;
    EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_err = RETURNED_SQLSTATE;
    END;
    v_got := array_append(v_got, coalesce(v_err, 'no error'));

    IF NOT EXISTS (SELECT 1 FROM fin_billing_run_items
                    WHERE tenant_id = v_tenant AND run_id = v_run AND enrollment_id = v_enr2) THEN
        RAISE EXCEPTION
            'post-0022 assertion failed: the refused item DELETE removed the row anyway';
    END IF;

    -- The one write a committed run's item may still take, which §8.7's own DDL
    -- requires: the invoice the run produced, attached once.
    v_lbl := array_append(v_lbl, 'D5 the invoice a committed run produced may be attached once');
    v_exp := array_append(v_exp, 'no error');
    v_err := NULL;
    BEGIN
        UPDATE fin_billing_run_items SET invoice_id = v_inv
         WHERE tenant_id = v_tenant AND run_id = v_run AND student_id = v_stu1;
    EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_err = RETURNED_SQLSTATE;
    END;
    v_got := array_append(v_got, coalesce(v_err, 'no error'));

    v_lbl := array_append(v_lbl, 'D5 re-attaching a different invoice is refused');
    v_exp := array_append(v_exp, '55000');
    v_err := NULL;
    BEGIN
        UPDATE fin_billing_run_items SET invoice_id = v_ret
         WHERE tenant_id = v_tenant AND run_id = v_run AND student_id = v_stu1;
    EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_err = RETURNED_SQLSTATE;
    END;
    v_got := array_append(v_got, coalesce(v_err, 'no error'));

    v_lbl := array_append(v_lbl, 'D5 clearing the attached invoice is refused');
    v_exp := array_append(v_exp, '55000');
    v_err := NULL;
    BEGIN
        UPDATE fin_billing_run_items SET invoice_id = NULL
         WHERE tenant_id = v_tenant AND run_id = v_run AND student_id = v_stu1;
    EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_err = RETURNED_SQLSTATE;
    END;
    v_got := array_append(v_got, coalesce(v_err, 'no error'));

    -- The write-once exception must not become a smuggling route for a re-price.
    v_lbl := array_append(v_lbl, 'D5 the invoice exception may not carry a second change with it');
    v_exp := array_append(v_exp, '55000');
    v_err := NULL;
    BEGIN
        UPDATE fin_billing_run_items SET invoice_id = v_ret, amount = 1.00
         WHERE tenant_id = v_tenant AND run_id = v_run AND enrollment_id = v_enr2;
    EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_err = RETURNED_SQLSTATE;
    END;
    v_got := array_append(v_got, coalesce(v_err, 'no error'));

    -- Re-pointing a row is an UPDATE, so the item freeze has to judge the run the
    -- row came FROM as well as the run it is going TO. The first draft of this
    -- function read only NEW, which froze a committed item only for as long as it
    -- stayed put: UPDATE fin_billing_run_items SET run_id = <draft run> walked a
    -- priced line out of a committed run and left the run's totals disagreeing
    -- with its contents. Three cases, because a freeze that is merely asymmetric
    -- is the same defect wearing a different hat: out, in, and the control that
    -- shows neither direction is refused outright.
    INSERT INTO fin_billing_runs (id, tenant_id, academic_year_id, status, structure_ids,
                                  idempotency_key)
         VALUES (v_run2, v_tenant, v_year1, 'draft', ARRAY[v_pub], '0022-SELFTEST-2'),
                (v_run3, v_tenant, v_year1, 'draft', ARRAY[v_pub], '0022-SELFTEST-3');
    INSERT INTO fin_billing_run_items (tenant_id, run_id, enrollment_id, student_id,
                                       structure_id, amount)
         VALUES (v_tenant, v_run3, v_enr3, v_stu3, v_pub, 30.00);

    v_lbl := array_append(v_lbl, 'D5 an item may NOT be moved OUT of a committed run');
    v_exp := array_append(v_exp, '55000');
    v_err := NULL;
    BEGIN
        UPDATE fin_billing_run_items SET run_id = v_run3
         WHERE tenant_id = v_tenant AND run_id = v_run AND enrollment_id = v_enr;
    EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_err = RETURNED_SQLSTATE;
    END;
    v_got := array_append(v_got, coalesce(v_err, 'no error'));

    v_lbl := array_append(v_lbl, 'D5 an item may NOT be moved INTO a committed run');
    v_exp := array_append(v_exp, '55000');
    v_err := NULL;
    BEGIN
        UPDATE fin_billing_run_items SET run_id = v_run
         WHERE tenant_id = v_tenant AND run_id = v_run3 AND enrollment_id = v_enr3;
    EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_err = RETURNED_SQLSTATE;
    END;
    v_got := array_append(v_got, coalesce(v_err, 'no error'));

    v_lbl := array_append(v_lbl, 'D5 an item may be moved between two UNCOMMITTED runs');
    v_exp := array_append(v_exp, 'no error');
    v_err := NULL;
    BEGIN
        UPDATE fin_billing_run_items SET run_id = v_run2
         WHERE tenant_id = v_tenant AND run_id = v_run3 AND enrollment_id = v_enr3;
        -- ... and back again in the same case. A freeze that is merely
        -- asymmetric is the same defect wearing a different hat, so the control
        -- has to show the move is legal in BOTH directions; the row is returned
        -- to v_run3 so the delete case below still finds an empty draft run.
        UPDATE fin_billing_run_items SET run_id = v_run3
         WHERE tenant_id = v_tenant AND run_id = v_run2 AND enrollment_id = v_enr3;
    EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_err = RETURNED_SQLSTATE;
    END;
    v_got := array_append(v_got, coalesce(v_err, 'no error'));

    -- And the two refused moves changed nothing: the committed run still holds
    -- the item it priced, at the amount it priced it at, with its invoice.
    IF NOT EXISTS (SELECT 1 FROM fin_billing_run_items
                    WHERE tenant_id = v_tenant AND run_id = v_run AND enrollment_id = v_enr
                      AND amount = 120.00 AND invoice_id = v_inv) THEN
        RAISE EXCEPTION
            'post-0022 assertion failed: a refused re-point still moved or re-priced the committed run''s item';
    END IF;

    -- And the freeze must be scoped to committed: a run that was never committed
    -- is still the owner's to delete, or the table has no lifecycle at all.
    v_lbl := array_append(v_lbl, 'D5 an uncommitted run may still be deleted');
    v_exp := array_append(v_exp, 'no error');
    v_err := NULL;
    BEGIN
        DELETE FROM fin_billing_runs WHERE tenant_id = v_tenant AND id = v_run2;
    EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_err = RETURNED_SQLSTATE;
    END;
    v_got := array_append(v_got, coalesce(v_err, 'no error'));

    IF NOT EXISTS (SELECT 1 FROM fin_billing_runs
                    WHERE tenant_id = v_tenant AND id = v_run AND status = 'committed') THEN
        RAISE EXCEPTION
            'post-0022 assertion failed: the committed run is no longer committed; one of the refused '
            'statements above went through and the freeze is not holding';
    END IF;

    -------------------------------------------------------- compare and report
    IF coalesce(array_length(v_lbl, 1), 0) <> coalesce(array_length(v_exp, 1), 0)
       OR coalesce(array_length(v_lbl, 1), 0) <> coalesce(array_length(v_got, 1), 0) THEN
        RAISE EXCEPTION
            'post-0022 assertion failed: the self-test''s own label/expected/observed arrays are %/%/% '
            'long; a test that cannot count its own cases is not a test',
            coalesce(array_length(v_lbl, 1), 0),
            coalesce(array_length(v_exp, 1), 0),
            coalesce(array_length(v_got, 1), 0);
    END IF;
    IF coalesce(array_length(v_lbl, 1), 0) < 61 THEN
        RAISE EXCEPTION
            'post-0022 assertion failed: only % behavioural case(s) ran; 61 is the expected floor',
            coalesce(array_length(v_lbl, 1), 0);
    END IF;
    FOR i IN 1 .. array_length(v_lbl, 1) LOOP
        IF v_got[i] IS DISTINCT FROM v_exp[i] THEN
            RAISE EXCEPTION
                'post-0022 assertion failed (case % of %): % raised SQLSTATE %, expected %',
                i, array_length(v_lbl, 1), v_lbl[i], v_got[i], v_exp[i];
        END IF;
    END LOOP;

    RAISE EXCEPTION 'p7-0022-selftest-rollback-marker';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'p7-0022-selftest-rollback-marker' THEN
        RAISE;
    END IF;
  END;
END
$assert_freeze_behaviour$;
