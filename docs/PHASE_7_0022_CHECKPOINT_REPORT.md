# Phase 7 / 0022 — checkpoint verification report

Migration: `packages/db/migrations/0022_fin_fee_structures.sql`
Design: `docs/PHASE_7_FINANCE_DESIGN.md` (authoritative)
Date: 2026-09-30
Verdict: **GO** — all seven defects closed, each proven load-bearing. Two carry-forwards in §M,
neither of them a P0/P1.

---

## A. Baseline

| Item | Value |
|---|---|
| Branch | `master` |
| Starting HEAD | `71aaffe9cb90b8635ca0ae176d78bf76288cae1f` |
| Ending HEAD | `71aaffe9cb90b8635ca0ae176d78bf76288cae1f` (unchanged; no commit made) |
| Working tree | 0021, 0022, the two Phase 7 docs and the two new suites are **untracked**; `packages/db/src/schema.ts` and `packages/db/src/security/phase6-exams.test.ts` are **modified**. `git diff` therefore shows the schema and F-06 change, and shows nothing for the rest — see §M (P2) |
| 0022 identity | 3054 lines, `sha256 54662d332718fafc45548b2f5599c572e4fe5b79a3c9eace03e0f93518f73da2` |
| PostgreSQL | 18.6 local / 16 in CI |
| Test database | `school_saas_test` — schema dropped and **all 22 migrations reapplied from empty**, after every change to the file |
| Dev database | `school_saas_dev` — **untouched**: ledger head `0020_schema_migrations_runtime_protection.sql`, 20 rows, `applied_at 2026-09-28T13:06:11.871Z`, and **0** `fin_*` tables |
| 0023 | not implemented, not modified |

The test database was rebuilt rather than patched. The earlier database had been
migrated incrementally and had accumulated state that the tests were silently
relying on — see §L, "vacuous test". A green run against a database whose history
is unknown is not evidence about a file that has never been applied to an empty
schema.

## B. Application result

Real runner (`pnpm db:migrate` → `packages/db/src/cli/migrate.ts`, lexical,
transactional, per-migration):

```
first application : applied 0001 … 0022_fin_fee_structures.sql | already applied: 0
rerun (idempotent): applied: (none) | already applied: 22
                    database is already up to date; nothing to migrate
```

The migration is idempotent in the sense that matters: the second run executes
**none** of its DDL, because the runner skips applied files. The `DROP TRIGGER IF
EXISTS` + `CREATE TRIGGER` pattern in the file is therefore belt-and-braces, not
the mechanism.

## C. Post-condition assertions

Ten assertion blocks run inside the migration and read the **catalog**, not the
file text. All pass; a failure aborts the migration and therefore the whole
`db:migrate` run.

| # | Assertion | Result |
|---|---|---|
| 10.1 | all 7 tables exist with the exact declared column set | PASS |
| 10.2 | FK inventory is exactly the 23 declared, no missing/mis-parented/mis-delete-rule, no extras, and the assertion's own fixture is 23 rows | PASS |
| 10.3 | forward-reference window closed: `fin_invoices` absent, no FK points at `fin_billing_run_items` | PASS |
| 10.4 | `UNIQUE (tenant_id, id)` anchor present on all 6 0022 anchor tables and on all 7 pre-existing parents | PASS |
| 10.5 | each named UNIQUE/CHECK constraint exists; `fin_targets_uq` is `NULLS NOT DISTINCT`; `fin_billing_runs_idem_uq` is tenant-scoped; `fin_fee_assignments_one_active_uq` is a partial unique index with `WHERE is_active`; **and its key `COALESCE`s all three nullable columns** | PASS |
| 10.6 | trigger inventory is exactly **8 bindings / 6 functions**, correct `tgtype`, correct function, no `trg_*`-named trigger, all 6 functions revoked from `PUBLIC` | PASS |
| 10.6b | **freeze event coverage**: each of the 3 child bindings has the INSERT, UPDATE and DELETE bits; the header binding has **both** the INSERT and DELETE bits; the run and run-item freezes have UPDATE+DELETE and INSERT+UPDATE+DELETE respectively | PASS |
| 10.7 | `school_app_rw` holds no privilege on any 0022 table; 0 policies; 0 RLS-enabled | PASS |
| 10.8 | **61 behavioural cases executed** (see below) | PASS |

### C.1 The 61 in-migration behavioural cases

Sections 10.1–10.7 are catalog assertions. They can prove a trigger is *bound*
and cannot prove what it *does*. That gap is the whole reason this file passed
three previous green runs while four real defects were open, so 10.8 executes
the statements.

| # | Case | Expected | Got |
|---|---|---|---|
| 1 | a draft structure's lines are editable | no error | no error |
| 2 | a line may be ADDED to a draft structure | no error | no error |
| 3 | a draft may be published | no error | no error |
| 4 | an ITEM may not be added to a published structure (**D1**) | 55000 | 55000 |
| 5 | a TARGET may not be added to a published structure (**D1**) | 55000 | 55000 |
| 6 | a PLAN may not be added to a published structure (**D1**) | 55000 | 55000 |
| 7 | an ITEM of a published structure may not be changed | 55000 | 55000 |
| 8 | a TARGET of a published structure may not be changed | 55000 | 55000 |
| 9 | a PLAN of a published structure may not be changed | 55000 | 55000 |
| 10 | an ITEM may not be deleted directly | 55000 | 55000 |
| 11 | a published structure may not be DELETEd (**D2**) | 55000 | 55000 |
| 12 | `supersedes_id` stays mutable after publication | no error | no error |
| 13 | `supersedes_id` may be cleared again | no error | no error |
| 14 | a published structure may not be soft-deleted (**D1c**) | 55000 | 55000 |
| 15 | a published structure may not be renamed | 55000 | 55000 |
| 16 | a DRAFT structure with children may still be deleted (**D2 control**) | no error | no error |
| 17 | an assignment matching its anchor is accepted (**D3**) | no error | no error |
| 18 | `student_id` may not differ from the enrollment's (**D3**) | 55000 | 55000 |
| 19 | `academic_year_id` may not differ from the enrollment's year (**D3**) | 55000 | 55000 |
| 20 | an assignment may not be re-pointed at another student (**D3**) | 55000 | 55000 |
| 21 | a WITHDRAWN enrollment is still a valid anchor (**D3 control**) | no error | no error |
| 22 | a first NULL-structure assignment is accepted (**D4**) | no error | no error |
| 23 | the identical second NULL-structure assignment is refused (**D4**) | 23505 | 23505 |
| 24 | a different `effective_from` is still a distinct assignment | no error | no error |
| 25 | an inactive duplicate is outside the index and is accepted | no error | no error |
| 26 | a structure may NOT be published by a user who does not exist (**D7**) | 23503 | 23503 |
| 27 | the real user is accepted as the publisher | no error | no error |
| 28 | a user who published a structure may NOT be deleted (**D7**) | 23001 | 23001 |
| 29 | the refused delete left the publication stamp intact (**D7**) | — | held |
| 30 | a structure may not be CREATED as published (**D6**) | 55000 | 55000 |
| 31 | a structure may not be CREATED as retired (**D6**) | 55000 | 55000 |
| 32 | `published → retired` is an edge of §18's graph | no error | no error |
| 33 | `published → superseded` is an edge of §18's graph | no error | no error |
| 34 | a RETIRED structure may not be published again (**D6**) | 55000 | 55000 |
| 35 | a SUPERSEDED structure may not be published again (**D6**) | 55000 | 55000 |
| 36 | a retired structure may not be retired a second time under a new name | 55000 | 55000 |
| 37 | a retired structure stays frozen for its other columns | 55000 | 55000 |
| 38 | re-stating a retired structure's own status is a no-op, not an edge | no error | no error |
| 39 | a DRAFT structure may not be marked superseded (**D6**) | 55000 | 55000 |
| 40 | a DRAFT structure may not be marked retired (**D6**) | 55000 | 55000 |
| 41 | that draft is still a draft, unstamped and unpointed (**D6 control**) | — | held |
| 42 | a DRAFT run's items are freely editable (**D5 control**) | no error | no error |
| 43 | a second item may be added to a DRAFT run | no error | no error |
| 44 | a DRAFT run may be previewed, and a preview may be re-stated (**D5**) | no error | no error |
| 45 | a run may be committed (**D5**) | no error | no error |
| 46 | `committed_at` may NOT be cleared to un-commit the run (**D5**) | 55000 | 55000 |
| 47 | a committed run's idempotency key, totals and `structure_ids` are frozen | 55000 | 55000 |
| 48 | a committed run may not be cancelled by un-committing it | 55000 | 55000 |
| 49 | a committed run may not even be re-stated with its own totals | 55000 | 55000 |
| 50 | a committed run may not be DELETEd | 55000 | 55000 |
| 51 | an item may not be ADDED to a committed run | 55000 | 55000 |
| 52 | an item of a committed run may not be re-priced | 55000 | 55000 |
| 53 | an item of a committed run may not be deleted | 55000 | 55000 |
| 54 | the invoice a committed run produced may be attached once (§8.7) | no error | no error |
| 55 | re-attaching a different invoice is refused | 55000 | 55000 |
| 56 | clearing the attached invoice is refused | 55000 | 55000 |
| 57 | the invoice exception may not carry a second change with it | 55000 | 55000 |
| 58 | an item may NOT be moved **OUT** of a committed run | 55000 | 55000 |
| 59 | an item may NOT be moved **INTO** a committed run | 55000 | 55000 |
| 60 | an item may be moved between two UNCOMMITTED runs, and back (**D5 control**) | no error | no error |
| 61 | an uncommitted run may still be deleted (**D5 control**) | no error | no error |

Plus the non-tabular invariants in the same block: `published_at` is stamped on
publication; the refused header DELETE left the item, target and plan in place;
deleting a draft cascaded all three children away; the committed run is still
committed; the two refused re-points moved and re-priced nothing; the three
label/expected/observed arrays are equal length; the case count is **≥ 61**.

The cases are ordered so that every defect's **control** sits next to it —
16 after 11, 21 after 20, 41 after 40, 60 and 61 after 59. A freeze that refuses
everything passes every refusal case, so a suite of refusals alone cannot tell a
correct freeze from a blanket denial.

The fixture runs inside a subtransaction that is abandoned on purpose, so
**nothing it creates survives the migration** — verified after every rebuild: the
tenant count, user count and all 8 finance tables are 0. This matters because the
migration also runs against a development database.

## D. Catalog inventory

| metric | Count |
|---|---|
| tables | 7 |
| foreign keys | **23** (24 rows name a 0022 table in the §35.2 map; the 24th is `0023`'s `invoice_id → fin_invoices` — see §E) |
| trigger bindings | 8 |
| trigger functions | 6 |
| partial unique expression indexes | 1 |
| RLS enabled | 0 |
| RLS forced | 0 |
| policies on 0022 tables | 0 |
| `school_app_rw` table grants | 0 |
| single-column FKs | 2 (the documented §6.3 R4 exceptions) |
| `ON DELETE SET NULL` FKs | 1 |

These are **measured, not declared**: the file contains exactly 8 `CREATE
TRIGGER` and 6 `CREATE FUNCTION` statements and 23 `FOREIGN KEY` clauses, and
assertion 10.2/10.6 re-counts all three from the catalog after they are created —
so a binding that is written but not attached, or an FK that is declared twice,
fails the migration rather than passing review.

The design-wide figures are separate and larger, because they project `0023`–`0029`,
which do not exist: §35.3 now states **28 bound functions over 35 distinct
`CREATE [CONSTRAINT] TRIGGER` statements**, of which `0022`'s 8 are the only part
that exists. A document-wide text search of the design finds **38** `CREATE
TRIGGER` lines rather than 35, because §7.3.1 and §8.7.1 each restate one of
`0022`'s bindings beside the function it belongs to. Those three are
restatements, and both numbers are asserted in `R7′` so the discrepancy is stated
rather than discovered. The earlier 24/25/27/32/34 figures in that section were
internally inconsistent with its own table and have been corrected against it.

`fin_fee_assignments_one_active_uq`, verbatim:

```sql
CREATE UNIQUE INDEX fin_fee_assignments_one_active_uq ON public.fin_fee_assignments
  USING btree (tenant_id, enrollment_id,
               COALESCE(structure_id, '00000000-0000-0000-0000-000000000000'::uuid),
               COALESCE(effective_from, '0001-01-01'::date),
               COALESCE(effective_to,   '9999-12-31'::date))
  WHERE is_active
```

## E. Foreign-key matrix

All 23 are tenant-composite `(tenant_id, …) → (tenant_id, id)`, except the two
marked. Delete rules: `r` = RESTRICT, `c` = CASCADE, `a` = no action (default),
`n` = SET NULL.

| Child → parent | Rule | Note |
|---|---|---|
| `fin_fee_structures` → `academic_years` | r | |
| `fin_fee_structures` → `fin_fee_structures` (`supersedes_id`) | r | |
| **`fin_fee_structures` → `users`** | **r** | **`published_by`; single column, §6.3 R4 platform-global-identity exception (D7)** |
| `fin_fee_structure_items` → `fin_fee_structures` | c | |
| `fin_fee_structure_items` → `fin_fee_heads` | r | |
| `fin_fee_installment_plans` → `fin_fee_structures` | c | |
| `fin_fee_structure_targets` → `fin_fee_structures` | c | |
| `fin_fee_structure_targets` → `campuses` | a | |
| `fin_fee_structure_targets` → `grade_levels` | a | |
| `fin_fee_structure_targets` → `acd_classes` | a | |
| `fin_fee_structure_targets` → `sections` | a | |
| `fin_fee_assignments` → `fin_fee_structures` | r | nullable |
| `fin_fee_assignments` → `enrollments` | r | |
| `fin_fee_assignments` → `students` | r | |
| `fin_fee_assignments` → `academic_years` | r | |
| `fin_fee_assignments` → `fin_fee_installment_plans` | r | nullable |
| `fin_billing_runs` → `academic_years` | r | |
| **`fin_billing_runs` → `users`** | **n** | **`started_by`; single column, §6.3 R4 exception** |
| `fin_billing_run_items` → `fin_billing_runs` | r | composite PK parent |
| `fin_billing_run_items` → `enrollments` | r | |
| `fin_billing_run_items` → `students` | r | |
| `fin_billing_run_items` → `fin_fee_structures` | r | |
| `fin_billing_run_items` → `fin_fee_assignments` | r | |

Note: `fin_fee_structure_targets.campus_id/grade_id/class_id/section_id` use no
action rather than RESTRICT, so a deleted campus leaves a target pointing at
nothing. This is the design's declared DDL and is **not** a finding, but it is
the one place where a 0022 table can outlive its target silently.

**These 23 are a subset of the design's 62-row map, and the split must be made
by hand.** Twenty-four rows of §35.2 name a 0022 table, because the map also
carries `fin_billing_run_items.invoice_id → fin_invoices` — the forward
reference `0023` adds. `0022` creates 23, and assertion 10.3 requires
`fin_invoices` to be *absent* when it finishes, which is what makes the 24th row
a `0023` obligation rather than a `0022` omission. `R11′` now says so in its own
cell, because a test that reads the map as an allowlist will otherwise report a
missing constraint.

## F. The two `users` references, and why only one is `SET NULL`

```sql
CONSTRAINT fin_billing_runs_user_fk   FOREIGN KEY (started_by)   REFERENCES users(id) ON DELETE SET NULL
CONSTRAINT fin_fee_structures_publisher_fk FOREIGN KEY (published_by) REFERENCES users(id) ON DELETE RESTRICT
```

Both are the §6.3 R4 platform-global-identity exception: `users` has no
`tenant_id`, so neither can be composite. They are **not** the same shape of
obligation, and making them the same was tried and rejected:

`ON DELETE SET NULL` on `published_by` was implemented first. It is the natural
choice for provenance, and it **cannot work**: PostgreSQL implements it as a
referential `UPDATE` on the referencing row, and the write-once publication stamp
(§7.3.1) refuses exactly that `UPDATE` with `55000`. The declared FK action was
therefore permanently unreachable — an FK whose action can never fire, which is
worse than no FK because it reads as protection. The shipped action is
`RESTRICT`: deleting a user who has published a structure raises **23001**
(case 28) and the stamp survives (case 29). Deactivating the account
(`users.status`) is the supported route and preserves the audit record.

This was verified by execution rather than by reading `pg_proc`: the SET NULL
variant was applied, the self-test failed on case 28 with `55000` instead of
`23001`, and the constraint was changed. `ctl_d7b` keeps that experiment as a
permanent control (§K).

**Forward requirement for 0023, recorded here so it is not lost:**
`fin_billing_run_items.invoice_id → fin_invoices` must be added by 0023's closing
`ALTER`, and if the finalized design specifies `ON DELETE SET NULL` it must be
written `ON DELETE SET NULL (invoice_id)`. PostgreSQL 18 accepts the bare
column-list form in a new DDL context, but the bare `ON DELETE SET NULL` form
has been deprecated since 7.4 and emits a warning that a future release will
remove; the explicit column list is the form that will keep working. Note that
`0023` will hit the same interaction if the invoice FK it adds is `SET NULL`:
the referential `UPDATE` would rewrite a committed run's `invoice_id`, which
§8.7.1's write-once exception refuses. `RESTRICT` is the action that is
consistent with the freeze the design already specifies.

## G. Triggers

| Trigger | Table | `tgtype` | Events | Function |
|---|---|---|---|---|
| `fin_structures_publish` | `fin_fee_structures` | 31 | BEFORE INSERT, UPDATE, DELETE | `trg_fin_structure_publish_freeze` |
| `fin_targets_validate` | `fin_fee_structure_targets` | 23 | BEFORE INSERT, UPDATE | `trg_fin_target_validate` |
| `fin_structure_items_freeze` | `fin_fee_structure_items` | 31 | BEFORE INSERT, UPDATE, DELETE | `trg_fin_structure_child_freeze` |
| `fin_structure_targets_freeze` | `fin_fee_structure_targets` | 31 | BEFORE INSERT, UPDATE, DELETE | `trg_fin_structure_child_freeze` |
| `fin_structure_plans_freeze` | `fin_fee_installment_plans` | 31 | BEFORE INSERT, UPDATE, DELETE | `trg_fin_structure_child_freeze` |
| `fin_assignments_validate` | `fin_fee_assignments` | 23 | BEFORE INSERT, UPDATE | `trg_fin_assignment_validate` |
| `fin_runs_freeze` | `fin_billing_runs` | 27 | BEFORE UPDATE, DELETE | `trg_fin_billing_run_freeze` |
| `fin_run_items_freeze` | `fin_billing_run_items` | 31 | BEFORE INSERT, UPDATE, DELETE | `trg_fin_billing_run_items_freeze` |

On `fin_fee_structure_targets` both triggers are `BEFORE INSERT OR UPDATE` and
PostgreSQL fires them in name order, so `fin_structure_targets_freeze` runs first
and a published structure's target is refused as a freeze violation rather than
as a shape error. This was checked deliberately: a test that passes for the
wrong reason is the failure mode this whole exercise is about.

## H. Behavioural verification (external suites)

215 cases across three suites, run against the freshly migrated database.

| Suite | Subject | Cases | Pass | Fail |
|---|---|---|---|---|
| `bt1` | target validation: existence, tenant, shape, hierarchy, year | 50 | 50 | 0 |
| `bt2` | structures, items, plans, freeze, retirement, identity, publisher FK | 75 | 75 | 0 |
| `bt3` | assignments, billing runs, item re-pointing, security posture | 90 | 90 | 0 |
| **total** | | **215** | **215** | **0** |

Combined with the 61 in-migration cases: **276 executed behavioural assertions,
276 as expected.**

**These 215 are external and disposable — they are not the repository's test
suite.** They live outside version control, which is why §L records a second,
independent 52 assertions inside the repo (`finance-trigger-inventory.test.ts`
27, `finance-composite-fk.test.ts` 25) that assert the same trigger graph and FK
graph from the catalog, and additionally prove `packages/db/src/schema.ts` has
not drifted from the database. A reader who trusts the repo's own `pnpm test`
sees 390 passing tests, of which these 52 are the finance ones; the 215 here are
the behavioural depth that a CI unit test should not be asked to carry. The two
overlap deliberately and neither is derived from the other.

`bt3` cases C38g–C38n are the external twin of in-migration cases 58–60 and exist
because the item freeze's re-point rule is the newest clause in the file and the
one most likely to be "fixed" back into a destination-only check by a later
reader. They also assert the two things a self-test inside the migration cannot:
that the third student and enrollment can be created by the suite itself, and
that the move between two uncommitted runs is legal **in both directions**.

## I. RLS and ACL

| Check | Result |
|---|---|
| 0022 tables with RLS enabled | 0 |
| 0022 tables with RLS forced | 0 |
| policies on 0022 tables | 0 |
| `school_app_rw` grants on 0022 tables | 0 |
| `school_app_rw` direct read of every 0022 table | `42501` |
| `PUBLIC` `EXECUTE` on any `trg_fin_*` function | 0 (all 6 revoked) |
| any `trg_fin_*` function is `SECURITY DEFINER` | 0 |

**This is correct and is not a finding.** The design assigns every finance RLS
policy and **every** `school_app_rw` grant to `0028` (`0028_fin_rbac_rls.sql`),
and §30.3 fixes the order there as policies *then* grants. 0022 therefore asserts
that no policy has been created here, so a second copy cannot drift. In the
meantime 0022 **fails closed**: 0001's `ALTER DEFAULT PRIVILEGES` grants the
runtime role at `CREATE TABLE` time, and the per-table `REVOKE` takes it back, so
a granted-but-RLS-not-yet-enabled finance table cannot be reached — which is
exactly the state the design calls for when it says that until 0028 "SELECT and
every write raise 42501". Assertion 10.7 fails loudly if that ordering is ever
broken, because a granted-but-unprotected table fails **open**, not closed.

## J. Design conformance and every delta

The design has been updated to match (`docs/PHASE_7_FINANCE_DESIGN.md`): §7.3
(publisher FK and why it is RESTRICT), §7.3.1 (the shipped header freeze, with
the three amendments that a reader of the earlier text would implement wrongly),
§8.4 and the new §8.7.1 (the committed-run freeze in full), §8.6 (the
`structure_id` sentinel), §8.7 (the write-once invoice attachment), §18 (the
graph, the INSERT source rule, the DELETE edge), §28.3 (three new mandatory
negative cases), the new §28.6 (how a fix is proven load-bearing), §30/§35.1/§35.2
(inventories), §35.3/§35.3.2 (6 functions / 8 bindings for `0022`), and §35.6 (the
fee-structure transition matrix, including the DELETE and INSERT rows).

| Design item | Design said | 0022 ships | Status |
|---|---|---|---|
| §7.3.1 publish freeze, `BEFORE UPDATE` | UPDATE | INSERT, UPDATE, **DELETE** | **delta — D2** |
| §7.3.1 child freeze, `BEFORE UPDATE, DELETE` | UPDATE, DELETE | INSERT, UPDATE, DELETE | **delta — D1** |
| §7.3.1 frozen column list | year, name, version, from, to | same **+ `deleted_at`** | **delta — D1c** |
| §7.3.1 frozen list named `is_active` | — | **removed** (no such column; `42703` at DDL time) | **correction** |
| §7.3.1 allowed `retired_at` stamping | — | **removed** (no such column) | **correction** |
| §18 status graph | prose + a diagram | allow-list on every UPDATE, before the draft early return | **delta — D6** |
| §18 source state | implicit | non-draft INSERT refused `55000` | **delta — D6** |
| §6.4 `student_id` pinned by trigger | required, no trigger listed | `trg_fin_assignment_validate` | **new function — D3** |
| §6.4 academic year anchored to enrollment | required | same trigger | **new** |
| §8.4/§8.7 committed-run freeze | stated in prose, not implemented | two functions, 4 bindings | **new — D5** |
| §7.3 `published_by` | no FK declared | `fin_fee_structures_publisher_fk`, `ON DELETE RESTRICT` | **new — D7** |
| dedup key | 1 partial unique expression index | same, key now `COALESCE`s `structure_id` too | **delta — D4** |
| §28.2 / §35.1 / §35.3.2 inventory for `0022` | 4 functions, 6 bindings | **6 functions, 8 bindings** | **design updated** |
| §35.3 document-wide bound functions | 24 rows / 32 statements, and the prose contradicted its own table | **28 rows / 35 statements**, re-derived from the table | **design corrected** |
| §35.3.2 binding block | 31 statements, all finance, none attributed to `0022` | **34** — 8 for `0022` in migration order, 26 for `0023`–`0029` | **design corrected** |
| §7.3.1 child-freeze code block | closing fence, **no opening fence** | fenced; document-wide parity restored to 220 / 110 | **defect fixed** |

The last four rows are corrections to the **design document's own
bookkeeping**, not to `0022`. §35.3's counting prose had drifted from its own
table — it claimed 24 rows and 32 statements for a table numbered to 25 and
summing to 35 — and separately, the child-freeze function in §7.3.1 carried a
closing fence and no opening one. The fence defect was the more serious of the
two, because an odd fence count shifted every subsequent pairing: from §7.3.1 to
the end of the file, roughly 700 lines of prose and SQL were inside one
unterminated code block, and `R1` still read as a passed check while asserting a
balance it did not have. Both were found by re-running the checks the document
claims to have run, which is the only reason they were found at all; both are
recorded in `R1` and in the static-verification paragraph rather than silently
corrected, and `R1` no longer asserts a line count at all, because that number is
self-referential and a check that must be edited to stay true is a check that
will be left stale.

Three of these deltas are the design contradicting itself, and the resolution
matters:

1. **§35.3's inventory vs §7.3.1's prose.** §35.3 listed the header freeze as
   `BEFORE UPDATE` and the child freeze as `BEFORE UPDATE, DELETE`. §7.3.1 is
   headed "**in full (NORMATIVE)**" and says a published structure's "ITEMS,
   TARGETS and PLANS" are frozen, adding that "without bindings on the three
   child tables a published structure's lines would stay editable — and the
   lines are what a family is actually billed". An INSERT binding is required
   for that sentence to be true. §7.3.1 was followed, and §35.3 updated to
   match, because following the inventory produces exactly the defect D1.
2. **`deleted_at` is not in §7.3.1's frozen list**, but the design's own
   `CREATE TABLE` declares the column on `fin_fee_structures`, and soft-deleting
   a published structure hides a structure families have been billed against
   without touching a listed column.
3. **§6.4 requires the pin and names `fin_fee_assignments` as an anchor, but
   §35.3's inventory contained no assignment trigger.** The prose is explicit and
   gives the exact `IS DISTINCT FROM` / `ERRCODE 55000` pattern to copy, so the
   function is added and the inventory row written.

`packages/db/src/schema.ts` still does not mirror the 0022 objects. Out of scope
for a migration file; carried in §M with its own change and review.

## K. Defects found and fixed

All seven were **live, shippable defects in a file that had already been applied
green three times.** Each is now enforced by a catalog assertion, at least one
behavioural case, an in-file self-test case **and** an external suite case.

### D1 — child-freeze INSERT escape
Bindings were `BEFORE UPDATE OR DELETE`, so a new line, target or plan could be
added to a *published* structure and billed to every family in the target set.
No frozen column was touched and no error was raised. Fixed by adding INSERT to
all three bindings; the function already dispatched on `TG_OP`, so no function
change was needed.

### D2 — header DELETE escape
The header freeze was `BEFORE UPDATE` only. A hard `DELETE` of a published
structure succeeded and cascaded to all three child tables. The child freeze
could not stop it, and this was confirmed rather than assumed: a minimal
two-temp-table reproduction showed a direct child `DELETE` refused `55000` while
the same child removed through the parent's `CASCADE` was not refused at all,
because PostgreSQL's referential actions do not fire the referencing table's
user triggers. The guard therefore has to be on the header, which is also the
only place that can see the status. Fixed, and the DELETE branch is placed
before any reference to `NEW` — in a row trigger PL/pgSQL assigns only `NEW` on
INSERT and only `OLD` on DELETE, so touching the unassigned record raises
`P0002` before any comparison happens.

### D3 — §6.4 student/year pin not implemented
`student_id` and `academic_year_id` were free columns with no trigger. An
enrollment for student A in 2025 could be assigned to student B, or into the
wrong year, and both rows were accepted while all four FKs were satisfied. The
denormalised copy disagreed with its own anchor, which defeats the stated reason
for copying it. Fixed with `trg_fin_assignment_validate`. Deliberately **not**
added: any check on the enrollment's `status` or `deleted_at`. A withdrawal is a
real billing fact — the fees were owed up to the withdrawal — and §6.4 asks the
row to agree with its *anchor*, not to assert the anchor is still teachable.
Case 21 asserts a withdrawn enrollment is still accepted so a future reader does
not "fix" this by adding a status rule.

### D4 — `structure_id` escaped the dedup index
The index `COALESCE`d the two dates but used a bare `structure_id` key column.
Two byte-identical active "assign nothing" rows for the same enrollment and
period both inserted, because a bare nullable key column is a NULL to the index
and two NULLs never collide. The table's own comment already argued that a NULL
structure "participates in no uniqueness index and so could not be deduplicated
against" — the index then failed to honour its own argument. Fixed with the nil
UUID `00000000-0000-0000-0000-000000000000`, which `gen_random_uuid()` never
returns and which no application mints as a surrogate key, so it cannot collide
with a real `structure_id`. The existing assertion checked only that the index
was partial and unique, which the defective index satisfied; it now also asserts
that all three nullable key columns are `COALESCE`d.

### D5 — a committed billing run was fully mutable, and so were its items
The design states at §8.7 (`fin_billing_runs.status` DDL comment) that "A
committed run is frozen (§8.4) and its items are what a regeneration must
reproduce", and §8.4's whole argument is that re-running billing for a year must
produce the same invoices. 0022 implemented none of it. Confirmed by execution
before the fix: clearing `committed_at` permitted `committed → preview`, the
`idempotency_key`/totals/`structure_ids` were all rewritable, and the items could
be inserted, re-priced and deleted.

Fixed with two functions. The **run** row is frozen from `committed` with no
exemptions. The **items** are frozen from the same state, with the single
exception §8.7's own DDL comment creates — attaching the invoice the run
produced, `NULL → a value`, once, with every other column compared first.

There is deliberately **no run status graph**. `status` is
`draft | preview | committed | cancelled` and §8.7 constrains `committed_at` and
`cancelled_at` as a pair, but no section enumerates which of those four may
follow which; inventing an allow-list here would create a normative rule the
design nowhere states, and would silently decide that `preview → committed` is
illegal and `committed → cancelled` is not. The freeze is scoped to the one
transition whose *consequence* is specified.

**The hole that survived the first fix, and the reason D5 has two controls.**
The first version of the item freeze read the parent run's status from the
`NEW` record on UPDATE. That is correct for INSERT and DELETE and **wrong for a
re-point**: `run_id` is an ordinary column, so a single
`UPDATE fin_billing_run_items SET run_id = <an uncommitted run>` satisfied the
check with the *destination* and walked a priced line out of a committed run,
leaving that run's `total_students` and `total_amount` disagreeing with its
contents. "Committed items are frozen" had been true only of rows that stayed
put. Both statuses are now read on UPDATE and either one being `committed`
freezes the row. Cases 58 and 59 assert both directions and case 60 asserts that
a move between two *uncommitted* runs is still legal, so the fix cannot have been
a blanket denial; `bt3` C38g–C38n assert the same externally.

### D6 — no status-transition graph
`retired → published` was accepted, and so were `draft → superseded`,
`draft → retired`, and the creation of a structure already `published`. A retired
structure being republished re-issues a structure families have already been
billed against, and a structure born `published` skips the graph entirely and
lands with a `published_at` the database never set. The allow-list is the three
edges §18 names, consulted on **every** UPDATE.

The ordering bug in the first fix is worth recording because it is invisible to a
naive test: the guard was written *after* the `OLD.status = 'draft'` early
return, which made it unreachable for every transition that starts in draft —
precisely the transitions §18 enumerates. A test that starts from a non-draft
state (`retired → published`) passes against that version. That is `ctl_d6b`, and
the shipped cases start from draft (39, 40) as well as from terminal states (34,
35) for exactly this reason.

A same-state no-op (`published → published`, `retired → retired`) is **allowed**:
a graph that refuses self-transitions refuses the idempotent re-PUT, and §18's
"any other transition" plainly means a *different* status.

### D7 — `published_by` had no FK
A nonexistent user id was accepted as the publisher. `published_by` is the audit
record of *who* published a fee structure, and an unconstrained uuid is not a
reference. A composite FK is not available (`users` has no `tenant_id`), so the
correct form is a single-column FK exactly like `fin_billing_runs.started_by`.
The delete action took two attempts and the reason is in §F: `SET NULL` is
implemented as a referential `UPDATE`, the write-once publication stamp refuses
it, and the action could never fire. `RESTRICT` makes the consequence explicit —
`23001`, stamp intact — and deactivating the account is the supported route.

### Negative controls — the seven fixes are proven to have teeth

A green suite proves nothing unless a red one is also demonstrated. For each
defect, a copy of the migration was made with **only that fix reverted**, applied
through the **repository's own runner** against a database emptied first, and
scored on the *message* — because a control that applies cleanly has proved
nothing, and a control that fails on the wrong assertion has proved something
else. The migration file itself is swapped in memory, restored in a `finally`
block, and the restoration is verified by SHA-256 after every run.

All **14** controls failed, each on its intended assertion (`APPLY-FAILED`):

| Control | Reverted | Caught by |
|---|---|---|
| `d1` | child bindings → UPDATE, DELETE | case 4: "an ITEM may not be added to a published structure raised `no error`, expected 55000" |
| `d2` | header binding → UPDATE only | "the refused header DELETE still removed the child ITEM; the guard fired but the cascade went through" |
| `d3` | assignment trigger unbound | "6 trigger functions exist and are revoked from PUBLIC" — the count assertion, deliberately left in place |
| `d3b` | same, with the count neutralised too | case 18: "`student_id` may not differ … raised `23505`, expected `55000`" |
| `d4` | `COALESCE(structure_id, …)` removed from the index *and* the expected-row key | case 23: "the identical second NULL-structure assignment … raised `no error`, expected `23505`" |
| `d4b` | the expression alone | case 23, again — the pair exists because either alone is ambiguous |
| `d5a` | both run-freeze bindings dropped | "the refused item DELETE removed the row anyway" |
| `d5b` | bindings intact, both freeze guards made tautologies | same, reached through the function instead of the catalogue — this is the control that matters, because `d5a` can only prove a binding is missing |
| `d5c` | the item freeze reads only the destination run on UPDATE | "a refused re-point still moved or re-priced the committed run's item" |
| `d6a` | allow-list removed | case 34: "a RETIRED structure may not be published again raised `no error`, expected 55000" |
| `d6b` | allow-list moved after the draft early return | case 39: "a DRAFT structure may not be marked superseded raised `23514`, expected `55000`" |
| `d6c` | INSERT bit removed from the header binding | case 30: "a structure may not be CREATED as published raised `no error`, expected `55000`" |
| `d7a` | publisher FK dropped | "the accepted publisher was not recorded" |
| `d7b` | publisher FK changed to `ON DELETE SET NULL` | case 28: "a user who published a structure may NOT be deleted raised `55000`, expected `23001`" — the rejected design, kept as a permanent control |

Three of these controls were wrong on the first attempt, and the errors are
instructive enough to record:

1. **A neutralizer written as a *false* predicate inverts a guard** of the form
   `IF NOT EXISTS (<predicate>) THEN RAISE`, so `d2` was "caught" by a check that
   had been turned inside out. It was corrected to a tautology and re-run. This
   is the same class as `d4b` reporting a pass for a migration that was in fact
   broken.
2. **Row-at-a-time deletion of a VALUES list leaves a dangling comma** — and once
   matched the wrong list entirely, because §10.6 and §10.8 end with the same row.
   `d5a` now removes the two run rows as one anchored block; a control that dies
   on a syntax error proves nothing about behaviour.
3. **`d5c` had to be neutralised narrowly.** Dropping the `OLD`-side lookup
   outright also un-freezes DELETE, so the control failed on an *earlier* case and
   would have proved something about DELETE. Reading `OLD` on DELETE only restores
   the pre-fix semantics exactly, and the control then fails on the re-point
   integrity assertion — which is the stronger of the two, because it shows the
   row actually moved rather than merely that an expectation was unmet.

## L. Regression and security counts

| Source | Cases | Pass | Fail |
|---|---|---|---|
| in-migration behavioural self-test (§C.1) | 61 | 61 | 0 |
| in-migration catalog + event-coverage invariants | 10 blocks | 10 | 0 |
| `bt1` target validation | 50 | 50 | 0 |
| `bt2` structures / freeze / retirement / publisher FK | 75 | 75 | 0 |
| `bt3` assignments / runs / re-pointing / security | 90 | 90 | 0 |
| **total behavioural (external)** | **276** | **276** | **0** |
| `finance-trigger-inventory.test.ts` (vitest) | 27 | 27 | 0 |
| `finance-composite-fk.test.ts` (vitest) | 25 | 25 | 0 |
| **total behavioural (external + vitest)** | **328** | **328** | **0** |

Whole `packages/db` vitest suite: **390/390 across 22 files** (was 338/338
before these two suites were added).

Security assertions confirmed: app role denied on every 0022 table (`42501`),
no `PUBLIC EXECUTE` on any of the 6 trigger functions, none `SECURITY DEFINER`,
0 policies, 0 RLS.

**Three test-integrity defects were found in the suites themselves**, and all
three had been producing false confidence:

1. **A vacuous assertion.** `bt2` took its publishing user from
   `SELECT id FROM users LIMIT 1`. On a database built from an empty schema
   there are no users, so `published_by` was `NULL`, and setting `NULL` to
   `NULL` correctly raises nothing — the "write-once stamp" assertions
   B27/B28 were testing nothing while reporting PASS. The previous green run
   only passed because a leftover user from an earlier session happened to be
   present. The fixture now creates a user, and `bt2` raises if it is missing
   rather than reporting a false PASS.
2. **A no-op `DROP FUNCTION`.** `harness.sql` used
   `DROP FUNCTION IF EXISTS p7_expect() CASCADE` with an **empty argument
   list** while the function takes three arguments. It matched nothing and
   emitted `NOTICE: function p7_expect() does not exist, skipping`, so the
   harness could only ever be installed once; every later run died on
   `42723 function "p7_expect" already exists`. Fixed to the full signature.
3. **A fixture that could not satisfy the constraint it was testing.** The
   first draft of the D5 self-test reused one enrollment for a run's two lines,
   and `fin_billing_run_items` is keyed `(tenant_id, run_id, enrollment_id)` —
   so the "delete an item of a committed run" case was refused by the primary key
   before the freeze was ever reached, and passed for the wrong reason. The
   fixture now carries two enrollments, and a third student with its own
   enrollment for the re-point cases, so that a move *into* the committed run
   cannot be refused by the PK instead of the freeze.

A fourth change was forced by the fix itself: `p7_reset` used
`DELETE FROM fin_fee_structures`, which the D2 guard correctly refuses, so
harness cleanup now uses `TRUNCATE … CASCADE`. See §M for why that is a property
of the product, not of the test.

## M. Carry-forward

### P2 — `packages/db/src/schema.ts` — **CLOSED**
Both carry-forwards are now landed, with their own tests.

**The schema module.** All 12 finance tables (5 from 0021, 7 from 0022) are
declared in `packages/db/src/schema.ts`, along with the 12 `(tenant_id, id)`
anchor indexes 0021 added to pre-existing tables — 11 of which
(`academic_terms_tenant_id_uq`, `admission_applications_tenant_id_uq`,
`calendar_events_tenant_id_uq`, `departments_tenant_id_uq`, `enrollments_tenant_id_uq`,
`holidays_tenant_id_uq`, `promotion_items_tenant_id_uq`, `school_settings_tenant_id_uq`,
`student_documents_tenant_id_uq`, `student_guardians_tenant_id_uq`,
`transfers_tenant_id_uq`) the module had been missing, alongside the 1 that was
already present (`report_card_subjects_tenant_id_uq`). Those 11 additions take the
module from 32 declared anchors to 43, which is exactly the count the live catalog
reports — the set is equal in both directions, with nothing declared that does not
exist and nothing live that is undeclared. The declarations were written
against the live catalog rather than the migration text, and four deliberate
fidelity decisions are recorded in a header comment on the module:

- `unique()` is used for unique **constraints** and `uniqueIndex()` for real
  indexes, because the two are different catalog objects and Drizzle emits them
  differently. `fin_targets_uq` is declared with `NULLS NOT DISTINCT`.
- `fin_tax_profiles` has no `updated_at`; the first draft invented one and the
  catalog comparison caught it.
- `fin_billing_run_items` has no `id`; its primary key is the 3-column
  `(tenant_id, run_id, enrollment_id)`.
- `finTenantSettings`' `ON DELETE SET NULL (tax_profile_id)` uses a **column
  list**, which Drizzle cannot express. It is declared as
  `.onDelete('set null')` — a deliberate, documented approximation, not an
  oversight. The column list means only `tax_profile_id` is nulled; the plain
  form nulls the whole key, which for a single-column nullable FK is equivalent
  here, but a future re-`ALTER` back to the column-list form is required.
- Triggers, functions, REVOKEs, RLS and function privileges are not expressible
  in a Drizzle schema at all. They are documented in that header comment as
  belonging to the migrations and the test suites, so the absence is not read as
  an omission.

**The two suites.** `finance-trigger-inventory.test.ts` (27 cases) and
`finance-composite-fk.test.ts` (25 cases) exist and run against the real
database. Both read the live catalogs; neither searches migration text, so a
later correct rewrite of 0022 that preserves the object graph still passes.

`finance-trigger-inventory.test.ts` asserts the 8-binding / 6-function graph
exactly — names, target tables, and the **decoded event set** of each binding,
because a freeze that silently lost its `DELETE` is still "a trigger on the
table". It also asserts every binding is enabled and `SECURITY INVOKER`, that all
six functions are owner-only via `aclexplode` (a substring test on the ACL text
would be fooled by `{school_migrator=X/…}`, whose grantee is named rather than
public), and that no `trg_fin_*` trigger is bound outside the 7 tables. Its
behavioural half provokes the real refusals: draft structures stay editable and
cascade; publication stamps; then header edit, header delete, and child
insert/update/delete are all refused, with the refused header delete proven to
leave every child row in place. It also covers the status graph (born-draft only,
write-once stamp, forward transitions only), assignment pinning, target
validation, the D4 partial index, the committed-run freeze, and — the two cases
most easily got wrong — that a re-point is refused on the **source** side, and
that attaching the produced invoice is permitted exactly once and only when no
other column moves.

`finance-composite-fk.test.ts` asserts the 23 FKs, that every one is
`(tenant_id, col) → (tenant_id, id)` **except** the two documented `users(id)`
references, that all 12 tenant-scoped parents expose the anchor index those
composite FKs need (and that `users` has none, which is the allowlist's whole
justification), and each delete action behaviourally rather than by reading its
code. It also confirms the posture: no `school_app_rw` privilege on any of the
12 tables, no RLS and no policy, `fin_invoices` still absent with nothing
pointing at `fin_billing_run_items`, and no FK reaching back from a 0021 table
into a 0022 one.

Its section E is what keeps §P2 from reopening: it compares the Drizzle
declarations **themselves** (via drizzle's own `getTableConfig`) against the live
catalog for all 12 tables — column names, position, nullability, type, FK names,
check names, unique-constraint names and index names. A missing FK declaration
compiles fine and then fails at runtime with an unpredicted `23503`; a
`uniqueIndex()` used where the migration has a constraint changes what the
catalog reports. Injecting a single renamed check constraint into the module makes
this test fail, so the guard is demonstrated to have teeth rather than merely to
pass.

Both suites run in a per-test transaction and clean up in `afterAll`, and were
run twice back to back to confirm they leave **zero** rows behind — which caught
a real leak: the trigger suite created two users per run and never deleted them,
so four runs left eight rows. The user delete is now in its teardown, and the
fixture id reader is a guarded accessor rather than direct interpolation, because
an unassigned id used to render as the literal string `"undefined"` and surface
as a baffling SQL syntax error instead of naming the missing key.

### Defect found in the existing suites while adding these
`phase6-exams.test.ts` F-06 required every `trg_*`/`fn_*` function to pin
`search_path=public, pg_catalog` — an order-specific regex written when the 41
Phase 6 functions were the only ones. The six 0022 guards pin
`pg_catalog, public, pg_temp`, so F-06 began failing as soon as 0022 was applied.
This was **pre-existing** and unrelated to the new work: it is visible from the
migration alone, with no test-file changes.

`pg_catalog` first is the *stronger* form — it is what stops a user-writable
schema shadowing a built-in — so the fix accepts either pinned ordering while
still requiring a pin that includes `pg_catalog`, and adds a second assertion
that no function has an empty `proconfig`. All 47 functions are pinned; the
loosening permits 0 additional functions to skip it.

### Operational — published structures are permanently undeletable
A direct consequence of D2, and it surprised the test harness: once a structure
leaves `draft`, **no legal statement can remove it**. The `DELETE` is refused,
and the demotion back to `draft` is refused, so there is no owner-side purge path
at all. `TRUNCATE` works only because it does not fire row triggers, and
`school_app_rw` holds no `TRUNCATE` privilege. This is the correct reading of
"a document already handed to a parent cannot be un-issued", and it is now stated
as a decision rather than left to be discovered: if an owner-side removal path
is wanted, it needs a status (`superseded` already exists) and an explicit
administrative route — not a loosening of the guard.

The same shape now applies to a **user who has published a structure** (D7): the
account cannot be deleted, only deactivated. Also deliberate, also stated rather
than discovered.

### Informational — future 0023

- `fin_billing_run_items.invoice_id → fin_invoices` must be added by 0023's
  closing `ALTER`; see §F for the interaction between its delete action and the
  write-once freeze.
- §35.3/§35.3.2, §19.7.2 F5 and §35.1 are updated for 6 functions / 8 bindings
  and 28 bound functions document-wide. The suites that assert those counts now
  exist: `finance-trigger-inventory.test.ts` asserts the 6 functions and 8
  bindings with their exact names, tables and decoded event sets, and refuses to
  pass vacuously — it requires exactly 8 rows, exactly 6 functions, and exactly
  one EXECUTE grantee each, rather than "at least one".
- The design's §35.2 FK map is updated to 62 edges / 62 rows with 12
  single-column rows. That figure is **carried from the map, not re-parsed**
  (§36.1's `R11′` caveat), and should be reproduced by the test that will read
  the map as an allowlist.

## N. Verdict

# GO

All seven defects are closed, and every fix is enforced by a catalog assertion
**and** by a behavioural case that has been demonstrated to fail when the fix is
reverted — 14 controls, all failing on their intended assertion, applied through
the repository's own runner against an emptied database. The migration applies
cleanly to an empty schema, is idempotent, leaves no data behind, and passes 276
behavioural assertions with zero failures. The catalog is exactly as declared: 7
tables, 23 FKs, 8 trigger bindings, 6 functions, and a posture that is closed
rather than merely unfinished. The development database is untouched at 20
migrations with no `fin_*` table.

**What this GO is not.** It is a statement about `0022` and the design
conformance of `0022`. It does not extend to the other §28.2 suites, which
remain out of scope, nor to `0023`, which was not started. The schema module and
the two §P2 suites it called for are now in place and green; the `.d.ts` mirror
mentioned in §M remains a separate, smaller follow-up. Two operational
consequences are recorded as decisions rather than defects: a published structure
has no owner-side removal path, and a user who has published one cannot be
deleted (deactivate instead). Both are correct readings of the design's own text;
both are now written down, so the next reader finds a decision rather than a
surprise.

**Verification conditions for this update.** The 276 external cases and the 390
vitest cases were re-run against a test database rebuilt **from an empty schema**
(0 public tables, 0 non-system schemas, then only `public` re-created) with all
22 migrations applied from zero, followed by a no-op rerun that applied nothing.
The 14 negative controls were re-run and all 14 failed on their intended
assertion, with 0022 restored to SHA-256
`54662d332718fafc45548b2f5599c572e4fe5b79a3c9eace03e0f93518f73da2` afterwards.
Final state: `school_saas_test` at 22 migrations / 12 `fin_*` tables / 6 trigger
functions / 8 trigger bindings; `school_saas_dev` untouched at 20 migrations with
0 `fin_*` tables, 0 functions and 0 bindings.

Per the phase rule, **0023 was not started, and no migration other than 0022 was
modified.**
