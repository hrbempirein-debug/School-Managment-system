# AI Architecture

Status: Phase 0 | Related: ADR-010, AUTHORIZATION.md, SECURITY.md, BILLING_DESIGN.md

## 1. Hard rules

1. The LLM **never** executes SQL or accesses the database directly.
2. The LLM **never** sees data the calling user could not fetch via normal API permission checks.
3. Every tool call is authorized, tenant-scoped (RLS via service layer), rate/entitlement limited, and audited.
4. Prompt/user content is untrusted input (injection defenses).
5. AI is a Phase 12 feature; foundations (audit, RBAC, gateway seams) exist from Phase 1.

## 2. Flow

```text
User (portal)
  → POST /api/v1/ai/messages  (auth cookie, tenant ctx, CSRF)
  → RBAC: ai.assist.use   + Entitlement: ai.requests
  → AI Gateway
       ├── assemble system prompt (tenant branding, locale, strict role)
       ├── attach ONLY redacted context allowed for this user (minimal)
       ├── call LLM provider adapter (streaming optional)
       └── on tool_call from model:
              tool registry lookup (closed catalog, typed Zod args)
              → runAsTenant(ctx) → RBAC(tool.permission) → handler service call
              → redact/limit output (pagination caps, PII minimization)
              → audit ai.tool.invoked (tool, args digest, result summary)
              → return tool result to model (bounded tokens)
  → response stream to user
  → ai_messages persisted (tenant RLS), usage counters incremented
```

## 3. AI Gateway responsibilities

- Single egress point for all LLM calls (chat, assistants, batch analysis, report generation).
- Provider abstraction: `LlmProvider { chat(request): Stream }` — adapters for OpenAI-compatible, Anthropic, local/ollama (config-selected; no provider lock-in like billing).
- Per-tenant + per-user rate limits (Redis token bucket) and monthly `ai.requests`/token entitlements.
- Timeout, retry only on retryable transport errors (never retry non-idempotent tool side effects without idempotency key).
- Content filtering hooks (input/output moderation pass-through where provider offers).
- Full prompt/response logging policy: metadata + digests by default; full bodies only when `ai.store_content=true` per tenant setting and retention window (DATA_RETENTION).

## 4. Tool catalog (closed, typed)

Tools are code — each entry: name, Zod args schema, required permission, handler, max rows.

| Tool | Permission | Notes |
|---|---|---|
| `getMyChildren` | (parent scope via membership links) | resolves children of the *calling* parent only |
| `getStudentAttendance` | `attendance.read` + student scoping | ≤90 days, 100 rows |
| `getStudentFees` | `fees.read` | balances only, no card data |
| `getStudentResults` | `exams.read` | published results only |
| `getClassAttendance` | `attendance.read` + class assignment check | teacher's own classes or admin |
| `getOutstandingFees` | `fees.read` + report perm | aggregate + limited list |
| `getAcademicPerformance` | `exams.read` | aggregates |
| `listStudents` | `students.read` | capped search |
| `generateReportDraft` | module read perms | output to user, not auto-published |

- Platform-scope tools (`platform.getSchoolUsage`) require platform session — never invocable from tenant chat.
- New tool = PR with permission, tests (allow/deny matrix), audit fields, arg validation — reviewed checklist in CONTRIBUTING.

## 5. Persona assistants

One gateway, different system prompts + tool subsets per portal:
- **Parent assistant**: only child-scoped tools, fee reminders, calendar queries.
- **Teacher assistant**: own classes, attendance entry help (draft → human confirms writes; AI does not write attendance directly Phase 12 — read-mostly + content generation).
- **Admin assistant**: school-wide read tools per admin permissions; report drafting.
- **School AI** responses labeled with disclaimer; financial/publishing actions always require human UI confirmation (AI cannot publish results, issue invoices, or collect payments).

## 6. Prompt injection & data leakage defenses

- Tool args validated; instructions from retrieved data placed in delimited sections marked as data, not instructions ("ignore previous instructions" in a student note must not escalate).
- System prompt states authorization invariants but **not** relied upon alone — enforcement is in tool handlers.
- Output size caps prevent exfiltration-by-dump; no tool returns raw audit logs or auth tables.
- Cross-tenant: handler runs under RLS context — even a malicious "ignore tenant" instruction cannot see other rows; tests assert this.
- Denylist: tools cannot accept arbitrary SQL, file paths, URLs to fetch, or shell strings.

## 7. Auditing & observability

- `ai_tool_calls` row: conversation, tool, args JSON (post-validation), result row-count, duration, tokens, permission snapshot, tenant, user.
- Sensitive tools (`getStudentFees`, `getOutstandingFees`) always audit → `audit_logs` with action `ai.tool.invoked`.
- Metrics: latency, error rate, tokens/day/tenant, tool deny count (security signal).

## 8. Cost control

- Entitlement pre-check; hard monthly token cap per tenant (stop → 402 with upgrade path).
- Cheaper model routing for classification; expensive model only for chat (config).
- Batch/analysis jobs queue on `ai` queue with low priority.

## 9. Testing

- Authorization matrix per tool (role × tool × allowed/denied) automated.
- Cross-tenant tool prompt tests: instruct model/force args for tenant B ids while in tenant A → handler returns not-found/denied (asserted at handler level, not by trusting model).
- Injection corpus tests: adversarial stored strings don't alter tool selection outcomes (handler-level assertions).
- Contract tests for provider adapter fakes.
