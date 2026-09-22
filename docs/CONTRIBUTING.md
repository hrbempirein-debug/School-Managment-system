# Contributing

Status: Phase 0 | Applies to all phases.

## 1. Ground rules

- Phase discipline: implement only the current phase's scope; no placeholder CRUD for future modules; no fake integrations.
- Every non-trivial change updates or references docs (ADRs in `DECISIONS.md` for technology/contract decisions).
- Assumptions must be labeled: VERIFIED / ASSUMED / REQUIRES USER ACTION (in docs and PR descriptions).
- No secrets in the repo, ever. `.env.example` placeholders only.
- Modular monolith rules (ARCHITECTURE §5): no cross-module raw table access; use the owning module's service API; cross-module reactions via outbox events.

## 2. Branching & commits

- Trunk-based: short-lived branches `feat/…`, `fix/…`, `docs/…` → PR → main.
- Conventional-ish commits: `feat(students): …`, `fix(finance): …`, `docs(arch): …`, `chore(ci): …`.
- Do not commit generated artifacts, lockfile churn from unrelated updates, or env files.

## 3. PR checklist

- [ ] Scope matches current phase; no drive-by refactors of unrelated modules.
- [ ] Types: no new `any`; Zod contract updated if API shape changed; OpenAPI snapshot diff reviewed.
- [ ] DB: migration includes RLS policy + `tenant_id` lead indexes; registered in isolation-test schema list; expand/contract respected.
- [ ] AuthZ: new route declares `permission` (+ `feature` if gated); route-without-permission fails boot tests.
- [ ] Idempotency: mutating finance/auth-critical endpoints accept/require `Idempotency-Key`.
- [ ] Audit: sensitive mutations write `audit_logs` in same tx; no secrets in diff values.
- [ ] Jobs/events: payload in `packages/contracts` Zod; handler idempotent; tenant ctx via `runAsTenant`.
- [ ] Tests: unit + integration for changed behavior; tenant isolation suite green; new tables covered.
- [ ] Logs: no PII payloads; fields follow OBSERVABILITY schema.
- [ ] Docs updated or ADR added.

## 4. Code style

- TypeScript strict everywhere; `verbatimModuleSyntax`; no default exports in packages (named only) except Next pages/app convention.
- Formatting: Prettier defaults; lint: ESLint (+ no-restricted-raw-sql rule for `.$raw` outside `packages/db`).
- Naming: tables snake_case with module prefix; columns snake_case; code camelCase; permissions `module.action`; events `domain.entity.past`.
- Errors: throw typed `DomainError`/`HttpError` from ERROR_HANDLING taxonomy; never string throws.
- Money: `numeric` + bigint minor units in app? **Decision: use decimal.js or native scaled integers in app code — store numeric(19,4); never floats** (enforced in finance package utils).
- No comments-as-docs unless non-obvious invariant; document invariants in docs/.

## 5. Testing expectations

See TESTING_STRATEGY.md. Minimum for feature PR: happy path + deny path (wrong permission) + validation error; finance/tenancy changes require the dedicated suites.

## 6. Dependency changes

Justify in PR; check bundle/attack surface; lockfile update only with the dep change; `pnpm audit` clean.

## 7. Adding a permission

1. Add string to `packages/rbac/src/permissions.ts` (+ module map).
2. Attach to route metadata.
3. Add to role templates that need it (code) — existing tenants get a data migration/seed script to add to roles flagged "managed by template".
4. Add authz test row.
5. Document in AUTHORIZATION.md catalog section if core.

## 8. Adding an AI tool

Checklist per AI_ARCHITECTURE §4: Zod args, permission, handler uses services (no raw SQL), row caps, audit fields, allow/deny tests, cross-tenant test, docs row.

## 9. Adding a table

Prefix + tenant_id + RLS policy + FORCE + indexes (tenant lead) + soft-delete decision + audit columns + isolation test registration + doc section in DATABASE_DESIGN.md.

## 10. Adding an outbox event

Define Zod in contracts, emit in same tx as state change, document consumer idempotency, add replay/dlq expectations, update EVENT_ARCHITECTURE catalog table.

## 11. Reviews

- ≥1 approval for `packages/db`, `auth`, `rbac`, `finance`, `ai`; docs-only can self-merge after CI.
- Security-sensitive PRs reference THREAT_MODEL rows touched.

## 12. Phase gate

Do not open the next phase's module PRs until the current phase acceptance criteria (DEVELOPMENT_ROADMAP) are met and verified by tests.
