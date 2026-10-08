# Phase 8 — 3D Report Remaining-Sections Audit (§20 → END)

Audit-only continuation. Target: `docs/PHASE_8_SECURITY_PROOF_CLOSURE_REPORT.md`.
The prior audit covered through ≈§19. This report independently audits every
remaining section and the final verdict. No source, test, migration, dependency
or database was modified; this document is the only new artifact.
Date: 2026-10-08.

---

## 1. Executive verdict

The remaining sections (§19–21 → Final Verdict) of the 3D closure report **do
not withstand independent verification in their D9 dimension**:

* The report's catalog count (§18, referenced material) is **113; the actual
  repository catalog is 114** (8 platform + 81 role-template tenant + 25
  `fees.*`). §23's list of 25 `fees.*` is accurate **as a catalog/migration
  inventory**, but the sections' implicit conclusion that D9 parity holds —
  including for a completely fresh tenant — is **false**: `createTenantTransaction`
  seeds roles only from `ROLE_TEMPLATES`, which contain **no `fees.*` and no
  `cashier` role**.
* §32 ("no remaining risks") and §33 ("all gates satisfied") are therefore
  contradicted by the repository, and the final verdict
  `SECURITY PROOF COMPLETE — READY FOR PHASE 8 IMPLEMENTATION AUDIT` is **not
  justified**. The authoritative-at-runtime authorization resolution reads DB
  `role_permissions` (`packages/tenancy/src/index.ts:89`), so a fresh tenant's
  finance routes are genuinely denied the 25 `fees.*` permissions and cashier
  scopes exist for nobody.

**Verdict: `3D REMAINING-SECTIONS AUDIT — BLOCKED`** (report's D9 closure claims
fail; D3/static-gate evidence in these sections is sound).

## 2. Baseline verification

* `git rev-parse HEAD` → `5bf11d0067424ea6e372f92f536e4af0aa795552` (matches).
* `git branch --show-current` → `master`.
* `git status --short` → identical to the pre-phase baseline plus the three
  proof test files (`d3-*`, `d9-*`) and doc reports; **no new migrations**, no
  `0029/0030+`, no dependency/lockfile changes surfaced this audit.
* Stop conditions not triggered; report present and readable; no repository
  modification occurred during the audit.

## 3. Exact section inventory — §20 → END

The report's numbered headings stop at §33 plus an unnumbered final section.
§20 begins *inside* the combined heading `§19-21`. Inventory of the audited
range:

```
§19–21 — Role/Template/Bootstrap Validation
§22    — D9 API Authorization Validation
§23    — Exact 25 fees.* Permissions
§24    — D6 job_runs Search
§25    — B1 Dunning Search
§26    — DEL-2 DLQ Search
§27    — Tests Executed
§28–31 — Migration/Dependency/DB Safety/Changed Files
§32    — Remaining Risks
§33    — Final Gate
Final Verdict — "SECURITY PROOF COMPLETE — READY FOR PHASE 8 IMPLEMENTATION AUDIT"
```

## 4. Section-by-section audit (§20 → END)

| Section | Claim | Evidence cited by report | Independent verification | Verdict |
| ------- | ----- | ------------------------ | ------------------------ | ------- |
| §19–21 (A) | Existing role/template validation tests pass | "(none cited)" | `packages/permissions/src/permissions.test.ts` — 30 tests (catalog consistency, namespace separation, per-role expectations: owner/principal/teacher) pass; verified catalog/template invariants hold. | **PASS** |
| §19–21 (B) | Bootstrap validated (fresh tenant receives authoritative config) | "(none cited)" | **Not supported.** No test validates a fresh tenant's role set against an authoritative full catalog. `createTenantTransaction` (`apps/api/src/routes/tenants.ts:71-88`) seeds ONLY te six `ROLE_TEMPLATES` tenant roles+permissions (81-union), no `fees.*`, no `cashier`. At report date no live-bootstrap parity test existed. | **PARTIAL** |
| §22 | API suites 496 passed (opt-in) | "(opt-in as documented)" | Declared test bodies across `apps/api/src/**/*.test.ts` ≈ 480 (parameterized/`it.each` expansions exceed this). 496 is plausible; not re-run in full (cost). Count is a run record, not a security property. | **PASS** |
| §23 (A) | Exact 25 `fees.*` presented as present | "(list)" | Verified: all 25 literals exist in `PERMISSION_CATALOG` (`permissions.ts:132-165`); 23 as `fees.*` + 4 as `fees.refunds.*` (report writes the four as `refunds.*` — cosmetic). All 25 are also the migration 0028 backfill set for EXISTING tenants. | **PASS** |
| §23 (B) | Same-section/§33 implication: D9 parity satisfied | — | **False for fresh tenants.** The 25 are not in any `ROLE_TEMPLATE`; `cashier` (0028:1682-1687) is created `WHERE NOT EXISTS` per existing tenant only. Runtime `requirePermission` reads DB `role_permissions` → fresh-tenant finance routes deny. | **FAIL** |
| §24 (A) | No `job_runs` implementation in 0001–0028 | "(search)" | Confirmed: `job_runs` appears in **no** `.ts`/`.sql`; absent from `packages/db/src/schema.ts` and all 34 migrations. Runtime false-`job_runs` claim (DEL-1) also independently documented. | **PASS** |
| §24 (B) | "Documentation references future/deferred only" | — | Substance true (design-only), wording slightly loose: `DATABASE_DESIGN.md:243` lists `job_runs` as a *designed table* without a "deferred" label; `JOB_ARCHITECTURE.md:54` explicitly phases the DLQ replay to Phase 13. | **PARTIAL** |
| §25 | B1 dunning: design references only, explicitly deferred, no emission/handler | "(search)" | Confirmed: dunning / `fee.invoice.overdue` / `fee.parent.notification.requested` / `finance-024` occur in **0** `.ts`/`.sql` and **0** tests. `events.ts` enum has no such members. Deferral matches DECISION B1-1. **Note:** `PHASE_7_FINANCE_DESIGN.md:278` still asserts "Phase 7 emits `fee.invoice.overdue` for Phase 8 to consume" — a lingering falsity the report does not flag. | **PASS** |
| §26 | DEL-2 DLQ: future/Phase 13; Phase 8 outbox-only | "(search)" | Confirmed: no DLQ queue implementation anywhere; `EVENT_ARCHITECTURE.md:119` assigns DLQ/replay to Phase 13; DEL-2 decision = Phase 8 ships a **read-only failure view**. Report's "outbox-only" is a simplification (no mention of the failure view) but not misleading. | **PASS** |
| §27 | Tests executed: default/opt-in all green | "(run records)" | Plausible and consistent: worker opt-in ≈132 (declared ≈125 excluding this phase's 3 new files + parameterized) and API ≈496 (declared ≈480); this session re-ran the phase-8 subset — d3 runtime 15, static gate 2, d9 parity 12 → **29/29 PASS** on the disposable DB. pass ≠ property-proof (distinction maintained in §15). | **PASS** |
| §28–31 (A) | Migrations unchanged | "(as per 3B)" | Confirmed: 34 migration files, `0001…0028` (two 0028 variants, six 0025 variants); `0029` absent/reserved; `0030+` absent. | **PASS** |
| §28–31 (B) | Dependencies unchanged | — | Confirmed: `package.json`/`pnpm-lock.yaml`/workspace files not in `git status`; no installs. | **PASS** |
| §28–31 (C) | Dev DB safety | — | No runtime proof touched `school_saas_dev`; phase-8 runtime proof targets the disposable `school_saas_test` (global setup migrates it; report was consistent). | **PASS** |
| §28–31 (D) | Changed-files list approved / no contamination | — | Confirmed: working tree = baseline + prior-phase files + proof tests + doc reports. No Phase 8 implementation artifacts (§14). | **PASS** |
| §32 | Remaining risks: none (P0s closed) | "(self)" | **Contradicted.** The fresh-tenant D9 provisioning gap is real and material (security + functionality); the trust-chain payload-override residual (documented by the sibling `PHASE_8_FINAL_D3_D9_SECURITY_PROOF_REPORT.md`) also remains. | **FAIL** |
| §33 (A) | D3 gates satisfied | "(preceding §)" | Confirmed independently for D3: runtime isolation 15/15 (R/U/D/S/X negative + controls), static gate 2/2 non-vacuous, DEL-2 single tenant-scoped DELETE. | **PASS** |
| §33 (B) | D9 gates satisfied | "(preceding §)" | **False.** Exact catalog↔bootstrap↔DB parity does not hold for fresh tenants; `cashier` absent; the 25 `fees.*` unprovisioned. The audit range itself contains no live-bootstrap parity evidence. | **FAIL** |
| Final Verdict | `SECURITY PROOF COMPLETE — READY FOR PHASE 8 IMPLEMENTATION AUDIT` | — | **Contradicted.** A required D9 property (fresh-tenant parity) cannot be certified; sibling Phase-8 report concludes `BLOCKED — SECURITY PROOF INCOMPLETE`. Verdict not justified. | **CONTRADICTED** |

## 5. D9 permission parity findings

* **Catalog**: `PERMISSION_CATALOG` = **114 unique**, duplicate-free
  (`assertCatalogConsistent`). 8 platform + 81 tenant-template + 25 `fees.*`.
  The report's §18 "count 113" is wrong; no count changed during 3D work (the
  catalog is intact and static in the working tree).
* **TS ↔ migration**: all 77 migration-declared permission literals are
  catalog-valid; the 25 `fees.*` are migration-declared but in **no** template
  (documented in `0028…` backfill). `template-union ∪ migrations = catalog` (114).
* **TS ↔ DB (role assignments)**: for a **fresh** tenant DB holds exactly the 81
  template permissions (verified — `d9-permission-parity.test.ts` live part, 12/12)
  → **missing_from_db = 25 fees.**; platform 8 are intentionally never
  tenant-granted. `extra_in_db = 0`; duplicates impossible
  (`(role_id, permission)` unique); invalid = 0.
* **Cashier**: exists only for tenants present when `0028_phase7_finance_security.sql`
  ran (`roles` `WHERE NOT EXISTS` insert, :1682-1687; agent grants :1762-1769).

## 6. Fresh-tenant bootstrap findings

`createTenantTransaction` trace (`apps/api/src/routes/tenants.ts:45-143`):

```
new tenant row  →  for ROLE_TEMPLATES[scope='tenant'] (six, :71)
                  roles insert per template (:72-84)
                  role_permissions insert per template.permission (:85-87)
                  memberships insert (:90-93)  →  owner role link (:95-98)
                  audit + outbox entries (:104-140)
```

A completely fresh tenant receives exactly the six
`school_owner/principal/teacher/accountant/parent/student` roles, exactly the 81
template permissions, **no `cashier`, no `fees.*`**. The report's implied
"bootstrap = authoritative configuration" is therefore false; the required
Phase 7 configuration (25 `fees.*`, cashier POS role) is **not** delivered to a
fresh tenant. Runtime impact: the API resolves permissions from DB
`role_permissions` at request time (`packages/tenancy/src/index.ts:89-96`), so
finance routes requiring `fees.*` return 403 to every role on a new tenant, and
nobody can act as cashier.

## 7. D3 tenant identity / trust-chain findings

Chain (`API → ctx → producer → outbox → worker → handler → DB context`):

* `ctx` from `resolveTenantContext` (header/session tenant, membership-gated).
* Producers set `enqueueOutbox({ tenantId: ctx.tenantId, payload: { tenantId:
  ctx.tenantId, … } })` — both equal **by convention** (verified per-emitter,
  e.g. `apps/api/src/routes/school/attendance.ts:591-597`).
* Worker: `processEvent` validates the envelope (`outboxEventSchema`, payload =
  `z.record(z.unknown())` — no tenantId equality constraint); `runEventHandler`
  builds the GUC from **`event.tenantId`** (`worker.ts:69`) after
  `assertEventTenant(event.tenantId)` (`tenant-invariant.ts:1-12`), but handlers
  resolve the data-plane tenant via `tenantIdOf = payload.tenantId ??
  event.tenantId` (`attendance.ts:28-30`; exams equivalent).

A state `event.tenantId = A, payload.tenantId = B` (and its reverse) is:
* **not prevented** by the schema (`z.record` payload, nullable envelope tenant
  id); *by the producer* equality is only by caller convention, not enforced;
* **not rejected** by the worker; and the handler **silently executes under B**,
  with the GUC stating A — predicates on B while context/audit claims A.

The runtime TRUST-CHAIN probe (`d3-worker-tenant-isolation.test.ts:615-629`)
pins exactly this: an A-envelope/B-payload event runs the A handler's SQL
against B. So the audit-required property
`A envelope + B payload → MUST NOT execute under B` **does not hold**. It is
unreachable from today's emitters (both id copies minted from the same
`ctx.tenantId`), but the report's §8 frame ("`event.tenantId` from trusted outbox
envelope" as the trust boundary) is **insufficient**: the data plane keys on
`payload.tenantId` first. (Documented as a defence-in-depth note, not a live
exploit path.)

## 8. Static tenant-gate findings

`apps/worker/src/d3-static-tenant-gate.test.ts` (2/2 PASS; source scanner +
allowance list) is genuinely non-vacuous:
* extracts every builder/raw tenant-table statement against 8 target modules
  (50 statements: 45 builder + 5 raw; 40 scoped + 10 allowance-documented);
* its fixture module (`SELECT enrollments` + `UPDATE students` without tenant
  predicate) **must** fail the gate and is deleted afterwards (postcondition
  asserted); production sources must match the exact allowance set — any other
  unscoped statement fails CI. This satisfies the audit's non-vacuity probes for
  `select`, `update` and (via the same path) `delete`.

## 9. Platform-event findings

Remaining sections add no platform-event evidence; §14 (pre-range) is
unaffected. Confirmed there is a defined platform envelope (`tenantId: null`)
and `assertEventTenant` rejects NULL for tenant-scoped handlers only. No
attacker-usable "tenant classified as platform" gap was found in the audited
range; platform routes additionally require a platform role membership
(`requirePlatformContext`).

## 10. D6 / job_runs findings

Occurrence classification (repository-wide):

```
schema/migration:    none (absent from schema.ts and all 34 migrations)
application code:    none
tests:               none
design/roadmap docs: DATABASE_DESIGN.md:243 · JOB_ARCHITECTURE.md:43,53,61 ·
                     DECISIONS.md:130 · DEVELOPMENT_ROADMAP.md:19 ·
                     DEPLOYMENT.md:63
future/deferred:     JOB_ARCHITECTURE.md:54 (DLQ replay tool = Phase 13)
```

The report (§24) correctly records that no implementation exists. It is a
design/roadmap table, not "implemented" — consistent with DECISION DEL-1
(no `job_runs` creation; idempotency lives on `notifications`).

## 11. B1 / dunning findings

Repo state: dunning has **0** emissions, **0** handlers, **0** enum members
(`refund.*` are the only finance events registered), **0** tests
(`finance-024` does not exist), **0** scheduler/sweep. Deferral is real and
matches DECISION B1-1. **Documentation defect (un-remediated):**
`docs/PHASE_7_FINANCE_DESIGN.md:278` still claims "Phase 7 emits
`fee.invoice.overdue` for Phase 8 to consume" — historically false; the report
(§25) does not mention this lingering false claim.

## 12. DEL-2 / DLQ findings

No dead-letter queue implementation exists anywhere; BullMQ attempts/backoff +
outbox stale-redrive (`processed_at` NULL, `last_error`, redrive after window)
is the current failure surface (`EVENT_ARCHITECTURE.md:119`). Phase 13 owns a
dedicated DLQ + replay tool. DEL-2 (documented in the Phase 8 blocking-decision
report) interprets Phase 8's "DLQ visible" acceptance as a **read-only failure
view** (failed outbox rows / failed-jobs listing), which the report §26 reduces
to "Phase 8 outbox-only" — an acceptable representation of the same decision,
not a claim that a real DLQ exists.

## 13. Migration integrity

At baseline and after the audit: `0001–0028` unchanged (34 files, incl. two
`0028_*` and six `0025_*` variants); `0029` absent & reserved; `0030+` absent.
The D9 correction path described/needed does **not** secretly depend on an
unshipped migration — the gap is a *lack* of provisioning, provable offline from
`createTenantTransaction` + `ROLE_TEMPLATES` alone. No migration work exists in
the audited range. **Migration integrity: PASS.**

## 14. Phase 8 contamination check

Scanned `apps/`, `packages/`, `scripts/`, `migrations/`, `package.json`,
`pnpm-lock.yaml` for Phase 8 implementation artifacts: **none**. Only
untracked proof/diagnostic files (3 worker tests, prior-phase worker test/SEC
files, this audit doc) and the pre-existing baseline modifications appear.
No `0029+`; no new template; no route/plugin changes. **Contamination: PASS.**

## 15. Test evidence matrix (claims cited in §19–21 → END)

| Claim | Command/file | Ran? | Flag/DB | Proves security property? |
| ----- | ------------ | ---- | ------- | ------------------------- |
| role/template tests pass | `packages/permissions/src/permissions.test.ts` (30) | Yes (static unit) | none | Parity within catalog/templates only — **not** bootstrap/cashier/fees parity (that specific property is untested there) |
| API suites 496 pass (opt-in) | `RUN_RUNTIME_SECURITY_TESTS=1 vitest apps/api` | documented; not re-run this audit | disposable `school_saas_test` | API authorization happy-paths; does not test fresh-tenant finance permission provisioning |
| worker opt-in ≈132 pass | `RUN_RUNTIME_SECURITY_TESTS=1 vitest apps/worker` | documented; subset re-run this audit (d3-15, static-2, d9-12 = 29/29) | disposable DB | D3 runtime isolation + gate + D9 parity — the subset does prove the D3/data-plane property; D9 subset *proves the gap exists* (FAIR: it asserts missing fees/cashier), it does not certify parity |
| D6 job_runs search | grep across repo | This audit | none | Claim = absence; verified absence |
| B1 dunning search | grep across repo | This audit | none | Claim = absence; verified absence |
| DEL-2 DLQ search | grep across repo | This audit | none | Claim = absence; verified absence |
| migration/deps/DB safety | git status/diff, migration glob | This audit | none | Verified |

## 16. Internal consistency check (audited range vs earlier sections)

* §18 "count 113" **contradicts** the actual catalog = 114; the §23 assertion of
  "exactly 25 fees.*" is consistent with 114 (89+25) but not with 113 — the
  report's own arithmetic is internally inconsistent.
* §8 "`event.tenantId` from trusted outbox envelope [= trust boundary]" vs the
  actual data-plane resolution `payload.tenantId ?? event.tenantId` (handlers,
  `attendance.ts:28`, `exams.ts:37`) — the trust-boundary statement is
  inconsistent with handler behaviour (GUC uses envelope id; predicates use
  payload id).
* §19-21 "bootstrap validated" vs §33 "all gates satisfied" vs the report's own
  §23 list (25 fees) not being in any template — the sections do not reconcile
  the existence of the 25 with fresh-tenant seeding.
* §32 "no remaining risks" vs the acknowledged (in sibling reports) fresh-tenant
  gap and trust-chain residual.

## 17. Repository consistency check (audited-range claims vs repo)

| Report claim | Repository fact | Result |
| ------------ | --------------- | ------ |
| Catalog = 113 | Catalog = 114 (8 platform + 81 tenant + 25 fees) | **MISMATCH** |
| 25 fees.* "present" | Present in catalog + migration 0028 backfill (existing tenants only); absent from templates and fresh-tenant bootstrap | **PARTIAL** (catalog-true, provisioning-false) |
| Existing tests pass | permissions 30/30; API/worker opt-in plausible | **MATCH** |
| No job_runs implementation | Absent from migrations/schema/code; design/roadmap only | **MATCH** |
| Dunning deferred | 0 emission/handler/test; events enum absent | **MATCH** |
| DLQ future/Phase 13 outbox-only | No DLQ code; error/redrive surface only | **MATCH** |
| Migrations unchanged | 34 files, 0001–0028, no 0029 | **MATCH** |
| No remaining risks | Fresh-tenant fees/cashier gap real; trust-chain residual | **MISMATCH** |
| Final verdict COMPLETE | D9 property not certifiable → BLOCKED | **MISMATCH** |

## 18. Confirmed blockers

1. **D9 fresh-tenant bootstrap parity (critical).** New tenants receive 81
   permissions, no `cashier`, no 25 `fees.*`. Runtime authz reads DB
   `role_permissions` → fresh-tenant finance is denied; POS cashier impossible.
   Requires `ROLE_TEMPLATES`/bootstrap remediation (owned by Phase 8
   implementation audit), not this audit.
2. **Permission count claim.** Catalog is 114; report says 113. (Documented,
   no fix.)
3. **Trust-chain override residual.** `payload.tenantId` overrides the envelope
   tenant in the data plane; mismatch constructible by schema, prevented only by
   producer convention. Report's trust-boundary framing (§8) insufficient to
   claim property; sibling report documents as defence-in-depth note.
4. **Un-remediated false doc claim.** `PHASE_7_FINANCE_DESIGN.md:278` still says
   Phase 7 emits `fee.invoice.overdue`; report §25 omits it.

## 19. Conditions (PASS WITH CONDITIONS would have required)

* Live-bootstrap parity evidence proving fresh tenants receive all 113/114
  catalog permissions incl. the 25 `fees.*` and the `cashier` role; and
* a defence-in-depth resolution of the envelope/payload tenant mismatch
  (enforce equality or validate payload tenant against envelope before the
  handler), or an explicit, gated acceptance of the override-by-convention.

Neither is present in the audited range, so the overall audit cannot PASS even
with conditions.

## 20. Final independent verdict

The audited range's D3, D6, B1, DEL-2, static-gate and integrity claims verify
cleanly. The D9 claims do not: the report documents the existence of the 25
`fees.*` and cashier at catalog/migration level but never establishes (and the
repository disproves) that a completely fresh tenant receives them. §32/§33 and
the final **COMPLETE** verdict overreach the evidence.

```
3D REMAINING-SECTIONS AUDIT — BLOCKED
```

## 21. Recommended next step (audit-only, not implementation)

Hand the single critical blocker (fresh-tenant permission/cashier provisioning)
and the two secondary findings (catalog count 113→114; false `PHASE_7_FINANCE_DESIGN.md:278`
claim; trust-chain override note) to the Phase 8 implementation audit with the
exact remediation envelope already specified in §18 — to be implemented only by
that later task. No code changes from this audit.

---

## Machine-readable summary

```json
{
  "audit_target": "docs/PHASE_8_SECURITY_PROOF_CLOSURE_REPORT.md",
  "audit_range": "§19-21 → Final Verdict",
  "head_verified": "5bf11d0067424ea6e372f92f536e4af0aa795552",
  "branch": "master",
  "material_claims_audited": 18,
  "results": { "PASS": 12, "PARTIAL": 2, "UNPROVEN": 0, "CONTRADICTED": 1, "FAIL": 3 },
  "independent_verifications": {
    "catalog_unique_count": 114,
    "catalog_platform": 8,
    "catalog_tenant_template_union": 81,
    "catalog_fees_all": 25,
    "migration_declared_catalog_valid": 77,
    "fresh_tenant_union": 81,
    "fresh_tenant_cashier": "absent",
    "fresh_tenant_fees": "absent",
    "runtime_authz_source": "DB role_permissions (packages/tenancy/src/index.ts:89)",
    "production_delete_sites": 1,
    "static_gate_non_vacuous": true,
    "job_runs_impl": "none",
    "dunning_impl": "none",
    "dlq_impl": "none",
    "migrations": { "files": 34, "new": 0, "0029": "absent" },
    "phase8_contamination": "none"
  },
  "blockers": [
    "D9 fresh-tenant bootstrap parity (25 fees.* + cashier unprovisioned)",
    "catalog count report 113 vs actual 114",
    "trust-chain payload-override residual (probe-pinned)",
    "PHASE_7_FINANCE_DESIGN.md:278 false 'Phase 7 emits fee.invoice.overdue' claim"
  ],
  "audit_verdict": "3D REMAINING-SECTIONS AUDIT — BLOCKED"
}
```

---

### FINDINGS REGISTER (audit-only; nothing modified)

**FINDING R-1** · CRITICAL · `apps/api/src/routes/tenants.ts:71-88` +
`packages/permissions/src/permissions.ts:180-360` (templates lack `fees.*`/`cashier`)
· Fresh-tenant bootstrap cannot deliver the Phase 7 finance configuration. ·
Runtime authz (`packages/tenancy/src/index.ts:89`) enforces from the DB, so
finance routes deny on new tenants. · NEXT: Phase 8 implementation audit to add
the 25 `fees.*` and cashier to the tenant bootstrap, with a deduped backfill for
pre-existing tenants only.

**FINDING R-2** · MEDIUM · `docs/PHASE_8_SECURITY_PROOF_CLOSURE_REPORT.md:64`
· Catalog counted 113; actual 114. · Undermines the reported parity arithmetic.
· NEXT: correct count + the parity re-statement in a doc fix.

**FINDING R-3** · MEDIUM · `apps/worker/src/attendance.ts:28-30` /
`apps/worker/src/exams.ts:37` (tenantIdOf) vs `packages/contracts/src/events.ts`
(payload `z.record(z.unknown())`) · Envelope/payload tenant mismatch is
constructible and silently executes under the payload tenant (probe-pinned).
Prevented only by producer convention. · NEXT: validate payload tenant =
envelope tenant at dispatch (or document the accepted residual).

**FINDING R-4** · LOW (doc) · `docs/PHASE_7_FINANCE_DESIGN.md:278` · Claimed
Phase 7 emits `fee.invoice.overdue` / `finance-024` exists — false, 0 emissions,
0 tests. · NEXT: doc correction per DEL-2/B1-1 reclassification.