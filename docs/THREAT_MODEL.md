# Threat Model

Status: Phase 0 | Related: SECURITY.md | Scope: SaaS platform (data-centric, STRIDE-ish)

Assets ranked: (1) cross-tenant data, (2) financial records & money movement, (3) credentials/sessions, (4) student PII (minors), (5) availability of school operations, (6) AI cost/abuse.

| # | Threat | Vector | Impact | Mitigations | Residual |
|---|---|---|---|---|---|
| T1 | Broken access control / IDOR | Guess IDs, crafted routes, missing perm checks | Cross-record data access | Route permission metadata + boot assertion, RLS, deny-by-default, 404 semantics, authz fuzz tests | Medium→Low |
| T2 | Cross-tenant leakage | Missing `tenant_id`, worker without ctx, cache mix-up, support access abuse | Catastrophic (commercial + legal) | RLS FORCE + non-owner runtime role, mandatory ctx repositories, tenant-keyed caches, isolation test suite generated per table, platform access = separate routes + reason + audit, AI handlers RLS | Low (primary risk, heavily tested) |
| T3 | SQL injection | Sort params, search, raw SQL | Full DB read | Parameterized Drizzle only, whitelists, review gate on `.$executeRaw`, WAF optional, least-priv DB role | Low |
| T4 | XSS | Stored fields (names, announcements), SVG uploads, markdown | Session theft, portal defacement | React escaping, CSP nonces, no raw HTML render initially / sanitize, SVG policy, cookie httpOnly | Low |
| T5 | CSRF | Cross-site form/fetch with cookies | State change as victim | SameSite + double-submit + Origin check | Low |
| T6 | Session theft | XSS (see T4), network sniffing, device steal | Account takeover | TLS/HSTS, httpOnly+Secure, short idle timeout, revoke on reset, MFA for privileged, device/IP anomaly logging (later) | Medium (user endpoint risk) |
| T7 | Credential stuffing / brute force | Login, reset, invite endpoints | Account takeover | Rate limits, lockout/backoff, captcha, argon2id, breach list, no enumeration | Low |
| T8 | Privilege escalation | Role API abuse, mass assignment, grantor grants beyond own perms | Elevated access | Permission subset rule, Zod allowlists, separate platform scope, step-up MFA, audit `user.role.changed` | Low |
| T9 | Webhook spoofing / payment replay | Forged provider callbacks, replayed bodies | False payments, free activation | HMAC verify + timestamp window + raw-body + unique external_id + state machine idempotency | Low |
| T10 | Payment logic abuse | Negative amounts, allocation races, refund > paid, double refund | Financial loss | DB CHECKs + triggers, idempotency keys, row locks, ledger balance trigger, nighty reconciliation, step-up MFA on refunds | Low |
| T11 | Invoice/payment tampering by insider | Edit history | Fraud, disputes | Immutability triggers, append-only ledger REVOKE, audit logs, segregation: refund approval permission, reconciliation reports | Medium→Low (detect via recon) |
| T12 | File abuse | Oversized/malicious uploads, key traversal, public URL leak, cross-tenant file id | Malware, PII leak | Allowlist+sniff+scan, server keys, private bucket, presign TTL, RLS on `files`, per-request authz | Low |
| T13 | Queue poisoning / job injection | Crafted payloads in Redis, stolen Redis | Tenant confusion, spam | Redis not public + AUTH, payload Zod validation, tenant ctx re-established server-side (never trust client), idempotency, DLQ | Low |
| T14 | Cache poisoning / cross-tenant cache hit | Missing key prefix | Data leak | ctx-required cache API (typed), code review, tests with two tenants | Low |
| T15 | Denial of service | Cheap heavy endpoints, exports, AI, file spam | Outage, cost blowup | Rate limits, per-tenant fair queues, size caps, autoscale (later), AI token caps, pagination caps | Medium (accept; add WAF/autoscale Phase 13) |
| T16 | Secrets leak in repo/logs | .env commit, log PII | Compromise | gitignore, gitleaks CI, scrub denylist, secret manager env | Low |
| T17 | Supply chain | Malicious/compromised npm pkg | RCE | Lockfile, audit CI, minimal deps, review new deps, no arbitrary install scripts | Medium→Low |
| T18 | AI prompt injection | Malicious text in student notes, user prompt | Tool misuse, data exfil via answers | Closed tool catalog, RBAC+RLS in handlers (not prompt), args validation, output caps, no SQL tools, injection corpus tests, human-confirm for writes | Low (by design of §AI) |
| T19 | AI data leakage / cross-tenant context | Retrieval without scope, shared conversation cache | Cross-tenant PII in answers | Tenant RLS in every tool, conversation rows tenant-RLS, no cross-tenant retrieval index, deny tests | Low |
| T20 | AI cost abuse | Scripted chat spam | Financial | Entitlement caps, rate limits, queue priorities, anomaly alert | Low |
| T21 | Backup/snapshot exposure | Stolen backup | Full leak | Encrypted backups, access control, key separate from DB host, restore tests | Low |
| T22 | Insider platform admin misuse | Support browsing tenants | Privacy breach | Separate platform session, mandatory reason/ticket, audit, read-narrow scopes, review of platform audit logs | Medium (organizational) |
| T23 | Denial of tenant (malicious member) | Deleting school data | Data loss for school | Roles: destructive perms limited, soft-delete + recycle windows, backups, owner-only school deletion with 30d grace | Low |
| T24 | SSRF (future webhooks/exports fetch) | URL params server fetch | Cloud metadata access | No arbitrary server-side URL fetch (allowlist); LLM web tools disabled by default | Low |

Trust boundaries: Browser↔API (TLS, cookies), API↔PG ( creds + RLS), API↔Redis, Worker↔Providers, LLM provider (treat as processing untrusted processor — minimize PII sent: prefer aggregates/ids+display fields needed only), Platform staff↔Tenant data (audited).

Review cadence: threat model updated when new module/AI tool/provider introduced (checklist in CONTRIBUTING).
