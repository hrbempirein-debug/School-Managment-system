# Background Job Architecture

Status: Phase 0 | Related: ADR-008, EVENT_ARCHITECTURE.md, MULTI_TENANCY.md §7

## 1. Stack

Redis + **BullMQ** in `apps/worker`; jobs enqueued from the transactional outbox (preferred) or directly for pure infra tasks (cache warm, outbox prune) with job_runs dedupe.

## 2. Queues

| Queue | Examples | Concurrency | Priority |
|---|---|---|---|
| `default` | misc | 5 | normal |
| `mail` | transactional email | 10 | normal |
| `sms` | SMS/WhatsApp abstraction | 10 | normal |
| `push` | mobile push | 10 | low |
| `reports` | report cards, PDFs, exports (Phase 6 ships `report.studentReportCard`) | 3 | low |
| `billing` | invoice generation, dunning, usage rollup | 2 | high |
| `payroll` | payroll runs | 1 | high |
| `ai` | LLM calls, embeddings, analysis | 5 | low |
| `maintenance` | retention, outbox prune, file scan follow-up | 2 | lowest |

Per-tenant fairness: optional per-tenant key limiter on heavy queues (`reports`, `ai`) so one school's bulk export cannot starve others.

## 3. Job payload contract

```ts
{
  jobId: string;            // uuid, = job_runs key
  tenantId: string | null;  // null only for platform maintenance
  actorUserId: string | null;
  idempotencyKey: string;   // event_id or deterministic hash
  correlationId: string;
  payload: unknown;         // Zod-validated per job name in packages/contracts
}
```

Job names: `notification.send`, `invoice.generate`, `report.studentReportCard`, `payroll.run`, `ai.chat.completion`, `export.studentsCsv`, `subscription.dunning`.

## 4. Worker execution protocol

1. Receive job → parse + Zod-validate payload (fail → DLQ immediately, no retry).
2. Dedupe: `INSERT job_runs(queue, job_name, idempotency_key, status) … ON CONFLICT DO NOTHING`; if conflict with `completed` → ack & skip; if `running` → delayed re-check (crash recovery via BullMQ stalled-job recovery + attempts column).
3. Open DB tx: `SET LOCAL app.tenant_id`, `app.user_id=actor`.
4. Execute handler (idempotent by design).
5. Commit (handler writes audit rows for sensitive ops).
6. Complete job; on error → BullMQ retry with exponential backoff (see §5).

## 5. Retries, backoff, DLQ

- Attempts: 5 default; backoff `exponential` base 3s, jitter (BullMQ `backoff: { type: 'exponential', delay: 3000 }`).
- **Non-retryable error class** (`PermanentJobError`: validation, missing entity, permission denied) → immediate fail, no retries.
- After max attempts → `failed` → moved to `<queue>-dlq` (BullMQ `failedEvent` handler moves) + `job_runs.status='dead'` + platform alert metric `jobs_dead_total`.
- DLQ replay tool: Phase 13 (reads job_runs, re-enqueues with new attempt budget, audit `job.replayed`).
- Stalled jobs: `lockDuration` 60s, `maxStalledCount` 1 → recovered automatically.

## 6. Idempotency & deduplication

- Natural keys: `notification.send` keyed `(user_id, template, dedupe_key)`; `invoice.generate` keyed `(student_id, academic_year_id, invoice_no)`.
- Money jobs (payroll, invoice batch) also guarded by DB constraints (unique invoice_no) — double enqueue cannot double-charge.
- API-triggered jobs (export) create `job_runs` first inside request transaction → enqueue after commit.

## 7. Tenant awareness (mandatory)

- Handler must establish RLS context before any query (helper `runAsTenant(job, fn)`).
- Job data schema rejects payload without `tenantId` for tenant-scoped job names (runtime validation).
- Logs/metrics labels: `queue`, `job`, `tenant_id`.
- Scheduled/recurring jobs (cron): iterate tenants via cursor, spawn **one child job per tenant** — parent job holds no tenant context; never mix tenants inside one DB transaction.

## 8. What runs in background vs sync

| Synchronous (request) | Background |
|---|---|
| CRUD + validation | Email/SMS/WhatsApp/push delivery |
| Payment capture confirmation from provider (webhook processing is async-ish: webhook endpoint stores + returns 200 fast, processing job follows — see FINANCE) | Invoice batch generation, recurring fee application |
| Small single-row reports (JSON) | PDF/report card generation, CSV exports |
| Permission checks | Payroll computation, AI completions, dunning sweeps, retention purge, usage rollups, file virus-scan callbacks, outbox pruning |

Rule: any operation > ~300 ms or calling an external network service → queue.

## 9. Scheduling

- BullMQ `repeat` jobs for crons (dunning daily 02:00 tenant-local sweep iterated per UTC offsets config, usage rollup hourly, retention monthly).
- Missed repeats: `settings.minimalInterval` + startup reconcile; document single-scheduler assumption (one worker instance claims cron leadership via Redis lock `lock:cron` with TTL refresh).

## 10. Observability

- Metrics: enqueued/active/completed/failed/duration per queue; DLQ depth; outbox backlog age.
- Health: readiness fails if Redis unreachable or DLQ growth rate exceeds threshold (alert, not readiness fail — readiness = Redis ping + PG ping).
- Structured log per job lifecycle: `job.started`, `job.finished`, `job.failed` with requestId-like `jobId`.

## 11. Testing

- Unit: handler idempotency, PermanentJobError classification.
- Integration: fake timers + BullMQ's test mode or in-memory Redis; assert retry/backoff counts; crash mid-job → stalled recovery; tenant context missing → job rejects.
