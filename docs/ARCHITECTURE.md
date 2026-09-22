# Architecture — School Management SaaS

Status: Phase 0 | Last updated: 2026-09-22

## 1. Style

**Modular monolith** deployed as three runtime units sharing one codebase and one PostgreSQL database:

```text
                    ┌────────────────────────────┐
   Browser ───────► │  apps/web  (Next.js)       │  portals: /platform /school /teacher /parent /student
                    └──────────────┬─────────────┘
                                   │ HTTPS / JSON /api/v1
                    ┌──────────────▼─────────────┐
                    │  apps/api   (Fastify)      │  REST API, auth, RBAC, RLS context, outbox writes
                    └──────┬──────────────┬──────┘
                           │              │ transactional outbox
              PostgreSQL   │              ▼
        ┌──────────────────▼──┐   ┌────────────────┐   ┌──────────────┐
        │  PostgreSQL + RLS   │◄──┤ apps/worker    │──►│ Redis/BullMQ │
        └─────────────────────┘   │ (BullMQ consumers) └──────────────┘
                                  └───────┬────────┘
                                          │ signed URLs / SMTP / SMS / LLM
                                  ┌───────▼────────┐
                                  │ External svcs  │ (S3-compatible, providers, LLM API)
                                  └────────────────┘
```

One codebase, one database, strict row-level isolation. Boundaries are package-level (workspace packages), not network-level. Extraction to services later is allowed by keeping modules free of cross-module table access (see §5).

## 2. Stack (decided)

| Layer | Choice | Rationale |
|---|---|---|
| Frontend | Next.js + TypeScript + React | Required; App Router, server components for portals |
| API | Fastify + TypeScript | Required; fast, schema-first plugins, good ecosystem |
| DB | PostgreSQL (verified running locally) | Required; RLS is the backbone of tenant isolation |
| ORM | **Drizzle** | See DECISIONS.md ADR-001 |
| Cache/queue | Redis + BullMQ | Required; BullMQ gives retries, backoff, job ids, priorities |
| Validation | Zod | Required; shared contracts package |
| Monorepo | **pnpm workspaces + Turborepo** | See DECISIONS.md ADR-002 |
| Files | S3-compatible private bucket + presigned URLs | See FILE_STORAGE.md |
| Reverse proxy / TLS | Caddy or Nginx (deploy env) | Simple auto-TLS; not app-coupled |

## 3. Workspace Layout

```text
apps/
  api/          Fastify HTTP server (public + internal routes)
  web/          Next.js portals (platform, school, teacher, parent, student)
  worker/       BullMQ consumers (email, sms, reports, payroll, AI, exports)
packages/
  contracts/    Zod schemas + shared TS types (API request/response, events, jobs)
  config/       Env parsing (Zod), typed config loaders
  db/           Drizzle schema, migrations, RLS policies, seed helpers
  core/         Domain primitives: Result, ids, money, pagination, tenant context types
  auth/         Authentication + session + MFA primitives
  rbac/         Permission catalog, role/permission evaluation
  tenancy/      Tenant resolution, membership guards, RLS session vars
  audit/        Audit log writer
  billing/      Subscription/entitlement domain (provider-agnostic)
  finance/      Invoices, payments, refunds, ledger rules
  students/, academics/, attendance/, exams/, hr/, library/, transport/,
  notifications/, ai/, storage/   Module domains (Phase-gated)
  ui/           Shared React component kit
infra/          Docker-compose (prod-ish local), nginx/caddy, k8s-ready manifests later
docs/           This documentation set
scripts/        Dev/CI scripts
tests/          Cross-app integration & e2e suites
```

Evaluation of the proposed layout (spec §23): kept, with modifications —
- `packages/core` split: cross-cutting primitives vs `auth`/`rbac`/`tenancy` (they have distinct lifecycle and are Phase 1 critical path).
- `packages/audit` elevated (spec §13 requires first-class audit).
- `admin/` merged into `web/` as the `/platform` route segment — one Next.js app avoids duplicated tooling; separate deployable only if scaling demands it later (ADR-003).
- No `packages/students` etc. code exists until its phase; package.json scaffolding is created per phase to avoid empty shells.

## 4. Request Lifecycle (API)

1. Reverse proxy assigns/propagates `X-Request-Id` (generate if absent).
2. Fastify hooks: parse env config → rate limit → authenticate (session cookie or PAT) → resolve tenant context → authorize (RBAC check for route permission) → validate body/params/query with Zod → idempotency lookup (mutations) → handler.
3. Handler opens transaction, sets RLS session variables (`app.tenant_id`, `app.user_id`, `app.role_ids`) via `SET LOCAL`, executes Drizzle queries, writes audit + outbox rows **in the same transaction**, commits.
4. Response serialized via contract schema; errors via unified error format (`ERROR_HANDLING.md`).
5. Structured log emitted with request id, trace id, tenant id, user id, route, latency, status.

## 5. Module Rules (monolith with clean seams)

- A module owns its tables (prefix, e.g., `fin_*`, `stu_*`). Cross-module reads go through the owning module's service functions, not raw SQL joins across ownership (exception: read-only reporting views).
- Modules communicate in-process via typed domain events written to the outbox table in the same transaction (see EVENT_ARCHITECTURE.md).
- No circular imports between module packages; `packages/contracts` is dependency-free.
- Future extraction: an event handler that is expensive (AI, reports) can move to a separate service consuming the same outbox without schema redesign.

## 6. Tenant Context Propagation

| Layer | Mechanism |
|---|---|
| HTTP | `X-Tenant-Id` header **or** subdomain → resolved to tenant id → verified against session memberships |
| DB | `SET LOCAL app.tenant_id = '<uuid>'` per transaction; RLS policies compare `tenant_id` |
| Jobs | BullMQ job data carries `tenantId` + `actorUserId`; worker re-establishes RLS vars before DB access |
| Cache | All Redis keys prefixed `t:{tenantId}:` (platform keys use `t:platform:`) |
| Files | Object keys `tenants/{tenantId}/...`; bucket private; presigned URLs only |
| Logs | Every log line includes `tenantId` when in tenant scope |

## 7. Environments

`local` → `ci` → `staging` → `production`. Same artifacts (images) promoted; config via env only. No env-specific code paths.

## 8. Scaling Assumptions (not premature)

- Stateless API/worker → horizontal replicas.
- PostgreSQL primary first; read replicas for reporting later (RLS still applied).
- Redis: cache + queues; BullMQ queues partitioned by workload (default, mail, reports, ai, payroll).
- Thousands of schools: RLS + composite indexes `(tenant_id, …)` keep queries local; connection pooling (PgBouncer transaction mode compatible because RLS vars use `SET LOCAL`).

## 9. What We Explicitly Do NOT Do (Phase 0–13)

- Microservices, event sourcing, CQRS frameworks, service mesh.
- Per-tenant databases or schemas (rejected in MULTI_TENANCY.md; revisit only with hard evidence).
- Shared mutable caches across tenants without key prefixing.
- Direct LLM access to the database (AI_ARCHITECTURE.md).
