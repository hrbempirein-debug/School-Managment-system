# Deployment & Environments

Status: Phase 0 | Related: OBSERVABILITY.md, SECURITY.md, FILE_STORAGE.md

## 1. Verified local environment (audit 2026-09-22)

| Fact | Status |
|---|---|
| OS: Windows (win32) + Git Bash; WSL2 Ubuntu available | VERIFIED |
| Node v26.5.0, npm 11.17.0, pnpm 12.4.1, git 2.55.0, Python 3.12.10 | VERIFIED |
| PostgreSQL server listening on Windows :5432 (`postgres.exe`) — client `psql` NOT on PATH | VERIFIED (server), REQUIRES USER ACTION (client tooling/creds) |
| PostgreSQL 16 + Redis 8.10.1 installed inside WSL Ubuntu | VERIFIED |
| Redis port 6379 reachable via `wslrelay.exe` (response not yet ping-verified) | PARTIAL |
| Docker / Docker Compose | NOT INSTALLED |
| Git repository in project dir | ABSENT (will init) |
| DB credentials for local dev | NOT VERIFIED — REQUIRES USER ACTION |
| Object storage (S3/MinIO) | ABSENT — REQUIRES USER ACTION (or FS adapter dev fallback) |
| SMTP/SMS provider accounts | ABSENT — ASSUMED not yet provisioned |

**User actions needed before Phase 1 runtime:** confirm working Postgres credentials/database name (or create `school_saas_dev`), confirm Redis reachability, decide storage approach (Docker/MinIO vs FS adapter), provide later: email/SMS provider keys (Phase 8), Stripe-like keys (Phase 11), LLM keys (Phase 12).

## 2. Environments

| Env | Purpose | Data | Infra |
|---|---|---|---|
| local | dev | synthetic seed, disposable | developer machine (PG+Redis local/WSL) |
| ci | tests | ephemeral DBs per run | CI runner services |
| staging | pre-prod verify | masked/limited seed | prod-like single-node |
| production | live | real | HA per §6 |

Same containers/artifacts promoted; config strictly via env (ADR-012).

## 3. Build artifacts

- `apps/api`, `apps/worker`: Docker images (node26-slim, non-root) — images defined though Docker unavailable locally (authoring fine; **running** image builds REQUIRES Docker or CI).
- `apps/web`: standalone Next build → image or node server.
- Migrations: run as init container/job (`migrator` role) before rollout; expand/contract for zero downtime.

## 4. Runtime topology (production, initial)

```text
Internet → LB/TLS (Caddy/Nginx or cloud LB)
             ├─ app.example.com  → Next.js (web) replicas ≥2
             └─ api.example.com  → Fastify (api) replicas ≥2
Workers: separate deployment, replicas per queue load (≥2 for critical queues)
PostgreSQL: managed primary (or single VM + WAL archiving) + daily backups
Redis: managed or VM, AUTH, persistence for BullMQ (AOF)
Object storage: S3-compatible managed bucket (private)
```

No microservices; scale API/web/worker horizontally first; PG connection pooler (PgBouncer transaction mode) before many replicas.

## 5. Configuration

- `.env.example` documents every var (placeholders only); real `.env` gitignored.
- Boot: Zod parse fail → crash (readiness never passes).
- Secret rotation runbook: DB URL, Redis URL, session pepper, AES master key, webhook secrets, SMTP, provider API keys — rotate quarterly / on compromise; sessions salted so session pepper rotation logs users out (documented).

## 6. Availability & DR (targets)

- Initial: single region, 99.9% with LB + ≥2 app replicas; PG automated backups daily + WAL PITR (if managed).
- RPO ≤ 5 min (WAL), RTO ≤ 1 h (restore drill quarterly).
- Redis: AOF everysec; queue loss window mitigated by outbox (jobs re-derivable from `job_runs`/outbox retries — document residual risk).
- Failover drills in Phase 13.

## 7. CI/CD

1. PR: typecheck, lint, unit, integration (ephemeral PG), tenant isolation, contract, secret scan, dep audit.
2. Merge → build images → deploy staging → e2e smoke.
3. Prod deploy: manual gate Phase 1–7; canary/auto after Phase 13 maturity. Migrations auto-expand; destructive contract migrations manual.
4. Rollback: image rollback; migrations forward-fix only (no auto down migrations for prod).

## 8. Observability wiring

stdout JSON logs → collector; `/metrics` scraped; alerts on readiness fail, error rate, DLQ depth, outbox age, backup failure, cert expiry (OBSERVABILITY.md).

## 9. Local dev commands (Phase 1 defines exact scripts)

Target scripts (repo root): `pnpm dev` (api+web+worker watch), `pnpm db:migrate`, `pnpm db:seed`, `pnpm test`, `pnpm typecheck`, `pnpm build`. Windows compatibility mandatory (developer machine is win32) — avoid bash-only scripts; use `tsx`/`node` runners.

There is deliberately **no `pnpm lint` script**. One existed and invoked `turbo run lint` while no package
defined a `lint` task, so it reported success having checked nothing — a false-success gate. It was removed
rather than replaced, because no linter is installed here and adopting one (ESLint, or a repo-wide Prettier
policy covering ~141 files that do not currently match Prettier's output) is a separate engineering change.
Until that lands, correctness is enforced by `pnpm typecheck`, `pnpm build` and `pnpm test`.

## 10. Production hardening backlog (Phase 13)

WAF/rate-limit edge, autoscaling, multi-AZ DB, DR drill, pen test, status page, canary releases, chaos tests for queue loss.
