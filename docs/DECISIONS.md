# Architecture Decision Records (ADR)

Format: Decision / Context / Options considered / Decision / Reason / Consequences.
New ADRs appended; never rewrite history — supersede with a new numbered ADR.

---

## ADR-001 — ORM: Drizzle ORM (not Prisma)

**Date:** 2026-09-22 | **Status:** Accepted

**Context.** We need a production-quality TypeScript PostgreSQL ORM that supports: raw SQL escape hatches (required for RLS `SET LOCAL`, advisory locks, `COPY`), predictable SQL (composite/ partial indexes, check constraints, exclusion constraints), lightweight migrations reviewable as SQL, and no runtime engine binary that complicates CI and serverless-style deploys.

**Options considered.**
1. **Drizzle** — SQL-like TS DSL, compiles to real SQL, first-class raw SQL, push/migrate via SQL files, tiny runtime.
2. **Prisma** — excellent DX and studio, but: own engine binaries, RLS requires raw queries + `$queryRaw` frequently, migrations are Prisma-format (harder to audit for policies/indexes), schema cannot express all PG features we need (partial indexes, RLS policies, composite FKs with actions) without escaping.
3. TypeORM — weaker typing, decorators, historically buggy migrations; not chosen.

**Decision.** Drizzle ORM with SQL migration files checked into `packages/db/migrations`.

**Reason.** Tenant isolation via RLS, financial constraints, and audit triggers are DB-centric; we need an ORM that never fights the database. Drizzle's schema is code-reviewable, generates precise SQL, and raw SQL is a first-class path for `SET LOCAL` / policy management. Type inference flows into Zod contracts.

**Consequences.** We write more SQL by hand for complex features (fine — reviewed migrations). No built-in admin UI (acceptable; use Drizzle Studio/psql). Prisma-style auto-relations are manual FKs (desired explicitness).

---

## ADR-002 — Monorepo: pnpm workspaces + Turborepo

**Date:** 2026-09-22 | **Status:** Accepted

**Context.** Multiple apps (api, web, worker) and many shared packages (contracts, db, rbac…) must share types and build/test atomically.

**Options considered.**
1. **pnpm workspaces alone** — sufficient linking, fast installs, strict node_modules.
2. **pnpm + Turborepo** — adds remote/local task graph caching (`build`, `test`, `lint`, `typecheck`), parallel scheduling, affected filtering.
3. Nx — heavier conventions/plugins; more than we need now.
4. npm/yarn workspaces — weaker linking + speed.

**Decision.** pnpm workspaces as the package manager; Turborepo as thin task runner.

**Reason.** Simplest setup that yields real value: one lockfile, strict dependency boundaries, and cached CI/dev tasks. Nx's extra concepts are overengineering at this stage; can be adopted later without lock-in.

**Consequences.** `turbo.json` defines pipelines; packages use `workspace:*` deps. Remote cache optional (self-hosted or Vercel/Turborepo remote) — configure in Phase 1 infra.

---

## ADR-003 — Frontend: single Next.js app with portal segments (not separate apps)

**Date:** 2026-09-22 | **Status:** Accepted

**Context.** Spec requires distinct experiences: `/platform`, `/school`, `/teacher`, `/parent`, `/student`.

**Options.** (a) One Next.js app with route groups; (b) multiple Next.js apps in `apps/`.

**Decision.** One app (`apps/web`), route groups per persona, shared `packages/ui`, middleware guards per segment, code-splitting per segment.

**Reason.** Separate apps duplicate auth, config, CI, and UI wiring with zero isolation benefit (same origin, same API). Route groups + middleware give logical separation; extraction to separate apps remains possible because business logic lives in the API, not the portal.

**Consequences.** Build is one artifact; a bad deploy affects all portals (mitigate with staging + canary later). Permission-driven navigation via shared `useSession` capability list.

---

## ADR-004 — Tenant model: School = tenant, shared-schema with PostgreSQL RLS

**Date:** 2026-09-22 | **Status:** Accepted
**Supersedes:** nothing | **See:** MULTI_TENANCY.md

**Context.** Strict isolation for thousands of schools on one database.

**Options per tenant-per-x:**
1. **Shared DB, shared schema, row-level `tenant_id` + RLS** — chosen.
2. Shared schema, app-level `WHERE tenant_id` only — weaker (any missed query leaks data).
3. Schema-per-tenant — stronger physical separation, but migration fan-out, connection overhead, RLS still useful, ops cost explodes at thousands of tenants.
4. DB-per-tenant — max isolation, worst operational cost; connection pooling per tenant; migrations × N.

**Decision.** Option 1 with defense-in-depth: app-layer tenant scoping + mandatory RLS policies + integration tests that attempt cross-tenant access.

**Reason.** RLS is enforced inside PostgreSQL regardless of which code path issued the query (API, worker, psql, analytics notebook). Operable at thousands of tenants with `(tenant_id, …)` composite indexes. Schema-per-tenant rejected: migration orchestration across thousands of schemas is a top operational risk.

**Consequences.** Every tenant-owned table must have `tenant_id NOT NULL` + policy. RLS complicates some migrations (need `FORCE ROW LEVEL SECURITY` handling, policy tests). Platform-scope tables use a separate `platform` RLS context. Connection poolers must support `SET LOCAL` (PgBouncer transaction pooling OK).

---

## ADR-005 — Identity: global users + tenant memberships

**Date:** 2026-09-22 | **Status:** Accepted | **See:** AUTHORIZATION.md, MULTI_TENANCY.md §Identity

**Context.** One person may belong to multiple schools; platform admins need cross-tenant access.

**Options.** (a) Global user identity with membership rows; (b) per-tenant user rows (duplicate accounts per school).

**Decision.** (a) `users` is global (unique email), authentication separate from profile; `memberships` bind user↔school with roles; tenant-scoped resources (students/employees) link to `users` only via explicit FK where a portal account exists.

**Reason.** Avoids credential sprawl and enables single login across schools; platform staff operate in an explicit "platform context" or an impersonation-free read path. Student accounts are tenant-scoped identities that may (later) be linked to a global user — modeled as `stu_student_accounts` referencing `users` nullable.

**Consequences.** Authorization must always combine `user_id` + `membership_id` + roles; never infer tenant from email domain. Unlinking a membership revokes all tenant access instantly.

---

## ADR-006 — Authorization: RBAC with string permissions, DB-driven roles

**Date:** 2026-09-22 | **Status:** Accepted | **See:** AUTHORIZATION.md

**Decision.** Permissions are code-defined strings (`students.read`); roles are DB rows mapping role→permissions; users get roles per membership; checks are `can(actor, permission, tenantScope)`. Platform roles and tenant roles are distinct namespaces. No permission inheritance graphs initially (explicit permission sets; a role may be "copied" from another role at creation).

**Reason.** Permission checks must be greppable/testable in code; role composition must be tenant-customizable without deploys. Avoids brittle hierarchy bugs.

**Consequences.** Permission catalog changes require code review + migration for renamed permissions. UI renders capability lists from `/me` endpoint.

---

## ADR-007 — Billing provider abstraction

**Date:** 2026-09-22 | **Status:** Accepted | **See:** BILLING_DESIGN.md

**Decision.** Billing domain models plans/entitlements/subscriptions internally; a `BillingProvider` interface (createCheckout, handleWebhook, cancel, changePlan) has adapters (e.g., Stripe adapter, manual/offline adapter). Webhooks normalized to internal events; subscription state machine is internal, not the provider's truth.

**Reason.** Spec forbids provider coupling; schools in some markets pay by bank transfer → "manual" provider must be first-class.

**Consequences.** Internal reconciliation job compares provider state vs internal state. Provider-specific data stored as JSONB in `billing_provider_refs` (no leakage into domain logic).

---

## ADR-008 — Queues: BullMQ on Redis + transactional outbox

**Date:** 2026-09-22 | **Status:** Accepted | **See:** JOB_ARCHITECTURE.md, EVENT_ARCHITECTURE.md

**Context.** Jobs must not be lost between DB commit and Redis publish.

**Decision.** Write job/event rows to a Postgres **outbox** inside the same transaction as business data; a dispatcher (worker, `LISTEN/NOTIFY` + polling fallback) enqueues BullMQ jobs. BullMQ handles retries/backoff/dedup; idempotency keys stored in `job_runs`.

**Reason.** Dual-write to Redis directly risks lost jobs on crash between commit and enqueue. Outbox gives at-least-once DB→queue delivery; consumers must be idempotent.

**Consequences.** Small latency for async work (dispatcher interval ≤ 1s via NOTIFY). Outbox table needs pruning job.

---

## ADR-009 — Storage: private S3-compatible bucket + short-lived presigned URLs

**Date:** 2026-09-22 | **Status:** Accepted | **See:** FILE_STORAGE.md

**Decision.** All tenant files private; access only via authorized presigned GET/PUT URLs (≤15 min), keys namespaced `tenants/{tenantId}/…`, metadata row in DB with content-hash, virus-scan hook point. No public ACLs; CDN only in front of an authorized path if ever needed.

**Reason.** Prevents permanent public URLs for student documents/payslips; enables tenant isolation at object-key level independent of app bugs.

**Consequences.** Uploads go browser→S3 (presigned PUT) after API authorization, keeping bytes off the API process. Lifecycle rules per retention policy.

---

## ADR-010 — AI: gateway with permission-aware tools, no DB access for LLM

**Date:** 2026-09-22 | **Status:** Accepted | **See:** AI_ARCHITECTURE.md

**Decision.** LLM calls go through an AI Gateway that (1) authenticates the user, (2) resolves tenant, (3) exposes a fixed catalog of tools whose handlers run normal RBAC checks, (4) redacts/filters results, (5) logs tool invocations to audit. LLM never receives raw SQL or unscoped data. Prompt inputs treated as untrusted (injection defense).

**Reason.** Spec requirement + threat model: LLM must not be an authorization bypass side channel.

**Consequences.** New AI capability = new typed tool + permission + tests. Latency/cost metering per tenant via `usage_limits`.

---

## ADR-011 — API style: REST, versioned path, cookie sessions + Idempotency-Key

**Date:** 2026-09-22 | **Status:** Accepted | **See:** API_DESIGN.md

**Decision.** `/api/v1/…` REST, JSON, cursor+limit pagination, filter/sort query conventions, CSRF-safe cookie sessions (httpOnly, SameSite) + optional bearer tokens for machine clients, `Idempotency-Key` on all mutating POSTs to payment/finance endpoints (required) and available generally, unified error envelope with `requestId`.

**Reason.** API-first requirement; REST + OpenAPI generated from Zod keeps web/worker/clients honest.

**Consequences.** Versioning discipline: additive changes only within v1; breaking → `/api/v2`.

---

## ADR-012 — Config over hard-coding; env parsed by Zod

**Date:** 2026-09-22 | **Status:** Accepted

**Decision.** `packages/config` parses `process.env` with Zod at boot; fail fast on missing vars. Feature flags and school-level toggles stored in DB (`cfg_*` tables), not constants. No secrets in repo; `.env.example` placeholders only.

**Consequences.** Every new env var must be added to `.env.example` and config schema in the same PR.
