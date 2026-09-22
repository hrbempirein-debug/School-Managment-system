# Observability

Status: Phase 0 | Related: API_DESIGN.md, JOB_ARCHITECTURE.md, DEPLOYMENT.md

## 1. Goals

Answer in minutes: which request failed, for which tenant/user, why; detect queue backlog, error spikes, slow queries, entitlement anomalies.

## 2. Structured logging

- JSON lines to stdout; fields: `timestamp, level, msg, requestId, traceId, tenantId?, userId?, jobId?, module, route, method, status, durationMs, err?`.
- Logger: `pino` (Fastify native) with AsyncLocalStorage-bound context (multi-tenant safe per request/job).
- Environments: local → pretty dev; CI/staging/prod → JSON to collector (Loki/CloudWatch/whatever deploy target provides — provider-agnostic stdout first).
- **Scrubbing**: central `redact` paths: `req.headers.authorization, req.headers.cookie, *.password, *.token, *.totpSecret, *.pan`, audit diffs key denylist (SECURITY §15).
- No row payloads in logs; IDs only.

## 3. Error tracking

- Unhandled exceptions + `error` route logs sent to Sentry-compatible DSN (env config; optional until Phase 1), tagged `environment, release, tenantId`.
- Sampling: 100% for error/fatal; 1% for warn.
- User feedback hooks not in Phase 1.

## 4. Metrics (Prometheus-style `/metrics` on internal port)

| Type | Examples |
|---|---|
| HTTP | `http_requests_total{route,method,status}`, `http_request_duration_seconds` histogram (p50/p95/p99) |
| Auth | `auth_login_total{result}`, `auth_lockouts_total` |
| Tenancy | `tenant_context_fail_total` |
| DB | pool usage, query duration (pg_stat_statements), rls_denied (if observable via logs) |
| Queue | BullMQ: `jobs_active{queue}`, `jobs_completed_total{queue}`, `jobs_failed_total{queue}`, `jobs_waiting_oldest_age_seconds{queue}`, DLQ depth |
| Outbox | `outbox_backlog`, `outbox_oldest_age_seconds` |
| Billing | `entitlement_denied_total{feature}`, `usage_limit_hit_total{metric}` |
| AI | `ai_requests_total{tenant}`, tokens, tool_deny_total |
| Finance | `payment_settled_total`, `reconciliation_drift` gauge |

Labels never include raw user ids (cardinality): tenant id allowed (bounded by thousands — acceptable; if not, hash). Alert rules defined in `infra/alerts.yml` (Phase 13 formalize).

## 5. Tracing

- W3C traceparent honored; generate if absent; propagate API → outbox (`correlation_id`) → BullMQ job → child spans.
- OpenTelemetry SDK optional Phase 13 (stdout exporter dev). Correlation id alone gives 80% value initially — required from Phase 1.

## 6. Health endpoints

| Endpoint | Meaning | Checks |
|---|---|---|
| `GET /healthz` (liveness) | process alive | always 200 if event loop responsive; **no** dependencies |
| `GET /readyz` (readiness) | can serve traffic | config loaded, PG `SELECT 1` w/ 2s timeout, Redis ping (if required for auth sessions — yes for API), migrations up-to-date check |
| `GET /health/deps` (restricted) | detail | pool stats, queue depths, outbox age, provider ping — network-restricted or platform-auth |

Liveness must NOT fail on Redis blip (avoid restart loops); readiness fails → remove from LB.

## 7. Worker monitoring

- Per-queue metrics above; worker exposes same `/healthz`/`/readyz` (ready = Redis + PG reachable).
- Stalled-job events → logs + `jobs_stalled_total`.
- Cron leadership lock presence metric.

## 8. Audit vs logs

Logs = operational, mutable/rotating, scrubbed. Audit logs = business/security facts, append-only, retained per DATA_RETENTION, queryable by tenant admins (`audit.read`) and platform (platform audit).

## 9. Dashboards (Phase 13)

- Golden signals per service (latency, traffic, errors, saturation).
- Tenant-aware: top error tenants, DLQ by tenant, AI spend by tenant.
- Runbooks linked from alert descriptions (`docs/runbooks/` created when infra lands).

## 10. SLOs (initial targets)

- API availability 99.9% monthly (readyz success ratio).
- p95 read latency < 300ms (excluding uploads/AI).
- Outbox dispatch lag p95 < 2s.
- Job success rate > 99% ex-DLQ.
Breach → alert; error budget review monthly Phase 13.
