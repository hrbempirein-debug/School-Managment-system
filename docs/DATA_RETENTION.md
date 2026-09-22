# Data Retention & Privacy

Status: Phase 0 (defaults; jurisdiction confirmation = owner decision) | Related: SECURITY.md, DATABASE_DESIGN.md, FILE_STORAGE.md

## 1. Classification

| Class | Examples | Sensitivity |
|---|---|---|
| A — Auth secrets | password hashes, TOTP, tokens | Highest; never export; rotate/purge fast |
| B — Student/guardian PII | names, dob, contacts, photos, documents | High (minors) |
| C — Financial records | invoices, payments, receipts, ledgers, payslips | High; statutory retention overrides deletion |
| D — Operational | attendance, grades, timetable | Medium |
| E — Logs/audit/telemetry | audit_logs, app logs, traces | Medium; audit longer-lived |
| F — AI content | conversations, tool call args/results | High-variance; tenant-configurable |
| G — Platform | subscriptions, platform audit | Medium-high |

## 2. Retention defaults (configurable per tenant/jurisdiction; ASSUMED values pending owner confirmation)

| Data | Hot retention | Then |
|---|---|---|
| Audit logs | 13 months in PG | compress → object storage archive 6 years (finance-adjacent audit 7 years) |
| App logs (JSON) | 30 days in collector | delete |
| Invoices/payments/receipts/ledger | **7 years** (statutory default) | archive read-only then delete per policy |
| Payslips | 7 years | archive/delete |
| Attendance/grades for graduated students | duration of school relationship + 6 years | archive |
| Dormant student records (no enrollment 3y) | flag inactive | PII purge job → anonymize (keep aggregate stats) |
| AI conversations | 90 days default (tenant setting 0–365) | delete; digests/audit metadata kept 13 months |
| Auth sessions | idle/absolute expiry (hours) | immediate |
| Auth reset/invite tokens | ≤ 7 days / consumed | delete |
| Idempotency keys | 24h (up to 7d finance) | delete |
| Job runs | 90 days | delete |
| Files: financial (receipts/payslips) | 7 years | delete object + tombstone metadata |
| Files: student docs | per student lifecycle policy | delete on purge |
| Backups | 30 days rolling (daily), monthly × 12 | delete |
| Webhook raw payloads | 180 days | delete raw; keep normalized facts |
| Marketing/platform contact | until consent withdraw + 24 months | delete |

## 3. Deletion / subject rights workflow

- **Export (right to access):** async job builds per-tenant user/student package (JSON+files manifest) → signed download link, TTL 24h, audited; cap size; human approval for bulk (Phase 13).
- **Erasure:** orchestrator states: `erasure_requested → blocked_by_legal_hold? → anonymize or delete → completed`.
  - Auth user: anonymize email (`deleted+<hash>@removed.invalid`), revoke sessions/tokens, detach memberships, keep audit rows with `actor_anonymized=true`.
  - Student PII: null contacts/photo/documents (delete objects), replace name with pseudonym, **keep** enrollment/grades/finance records if legally required (pseudonymized) — finance references student ids, so soft-anonymize not hard FK delete.
  - Financial rows: never deleted within statutory window (legal basis: legal obligation overrides erasure).
- Legal hold flag per tenant/record blocks purge jobs.

## 4. Soft delete vs hard delete

- Operational entities: soft delete (`deleted_at`) + recycle (30d) + purge job.
- Immutable financial/audit: no deletes except retention job running as elevated role with dual logging (which rows purged, counts, actor=system, reason=retention_policy).
- RLS policies for soft-deleted rows: default queries filter `deleted_at IS NULL` via repository scope; restore = clear flag (permission-gated).

## 5. Backups & purge coupling

- PITR/WAL + daily snapshots (DEPLOYMENT); backups inherit retention: deleted-data can persist inside backup window (30d) — documented in privacy notices (deletion effective after backup expiry for full purge).
- Backup encryption keys held separately from DB host.

## 6. Config surface

`school_settings.retention_overrides` JSONB (per tenant allowed ranges within platform min/max); platform defaults in config package; changes audited (`retention.changed`).

## 7. Implementation hooks (phase-gated)

- Phase 1: idempotency/session/token cleanup jobs.
- Phase 7+: financial archive job.
- Phase 12+: AI content purge.
- Phase 13: full erasure/export workflow + DPA docs.
