# Security Design

Status: Phase 0 | Related: THREAT_MODEL.md, AUTHORIZATION.md, MULTI_TENANCY.md

## 1. Security stance

Deny by default; least privilege at every layer (HTTP, DB role, bucket, queue, AI tool); defense-in-depth for tenant isolation; assume breach of one layer.

## 2. Authentication

- Passwords: argon2id (m=64MB, t=3, p=4 — tune to hardware), unique per user; breach-password denylist via k-anonymity range API or local list (config); minimum 12 chars with composition hints (no forced rotation except compromise).
- MFA: TOTP for privileged roles (platform staff, `fees.refund`, `users.roles.manage`, `fees.payments.collect` ≥ threshold — step-up); recovery codes hashed.
- Sessions: server-side, httpOnly+Secure+SameSite=Lax cookie `sid`, absolute lifetime 12h (config) / idle 2h; Redis-stored with version bump on privilege change; logout revokes; "sign out everywhere" iterates sessions.
- Password reset: single-use hashed token (30 min), sent to verified email; successful reset revokes all sessions; response identical for existing/non-existing email (no enumeration).
- Invitations: hashed single-use token, expiry 7 days, bound to tenant+email+roles; acceptance creates/links membership.
- Rate limit + progressive delay + lockout with captcha after N failures (login, reset, MFA).
- Machine tokens: opaque random, stored hashed, scoped permissions subset, expiry, revocable.

## 3. Authorization

Per AUTHORIZATION.md — RBAC + campus scope + RLS + entitlements. Additional rules:
- IDOR prevention: every `:id` fetch goes through RLS/service scoping — ownership never trusted from payload.
- Mass assignment: Zod allowlists fields (e.g., clients cannot set `status`, `tenantId`, `roleIds` via generic PATCH).
- Privilege escalation: role management requires `users.roles.manage` **and** cannot grant permissions the granter lacks (no privilege amplification) — platform scope strictly separate.

## 4. Tenant isolation

Per MULTI_TENANCY.md: RLS FORCE + app ctx + repository ctx requirement + isolation test suite. DB runtime role lacks BYPASSRLS and is not table owner.

## 5. Injection

- SQL: only parameterized queries via Drizzle; dynamic sort/filter from whitelists; raw SQL fragments reviewed; RLS context via `SET LOCAL` with validated UUID casts (`format('%L')` style or bind params).
- XSS: React escaping; strict CSP (`default-src 'self'`; no `unsafe-inline` scripts — nonces for hydration data); sanitize any HTML (none expected initially); `Content-Security-Policy`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, frame-ancestors none on app (portals don't need embedding).
- Command injection: no shell-outs with user data; export filenames sanitized.
- Path traversal: server-generated storage keys only.

## 6. CSRF

SameSite=Lax + double-submit token on cookie-auth mutations + custom header requirement (`X-Requested-With` or CSRF token) + Origin/Referer check for mutations.

## 7. Sessions & transport

TLS 1.2+ enforced (HSTS preload in prod); secure cookies; no tokens in URLs/localStorage (except short-lived presigned URLs which are capability-scoped). Session fixation impossible (new sid on login).

## 8. Credential attacks

Rate limits per IP+account (Sliding window Redis); audit `auth.login_failed`; alerting on burst; no user enumeration; optional lockout.

## 9. File upload attacks

Per FILE_STORAGE.md: type allowlist + magic-byte sniff, size caps, server-side keys, scan gate before download, no inline SVG, attachment disposition, tenant path check on read.

## 10. Webhook spoofing & replay

Signature verification with secret per endpoint; timestamp tolerance (5 min); (`provider`,`external_id`) uniqueness; constant-time compare; raw body required before JSON parse; IP allowlist as secondary where provider publishes ranges.

## 11. Replay attacks (API)

Idempotency keys prevent duplicate side effects; presigned URL TTLs short; password reset & invite single-use; bearer tokens random 256-bit.

## 12. Rate-limit abuse

Buckets: IP (global), session, tenant, endpoint class (auth, ai, write); 429 + Retry-After; heavier limits on expensive endpoints (exports, reports, AI, payment create); circuit breaker on downstream providers.

## 13. Secrets management

- No secrets in git (`.gitignore` covers `.env*` except `.env.example`).
- Runtime secrets from environment/secret manager; Zod config fails boot if missing.
- Encryption at rest for MFA secrets & PAT hashes: AES-256-GCM with app master key (env), key id stored for rotation.
- Rotation runbook in DEPLOYMENT.md.

## 14. Dependency & supply chain

pnpm lockfile committed; `pnpm audit` in CI; minimal dependency policy for `packages/db`, `auth`; provenance where available; no install scripts from unvetted packages.

## 15. Logging hygiene

Denylist scrub before log/audit/Sentry: passwords, tokens, cookies, authorization headers, TOTP secrets, full payment card fields (we never store PANs — gateway tokens only), national IDs if introduced. Audit diffs filter sensitive keys.

## 16. Infrastructure

- Least-privilege DB users: `migrator` (DDL), `app_rw` (DML+RLS, no BYPASSRLS), read-only reporting role later.
- App servers no inbound except proxy; workers outbound-only + Redis/PG.
- Bucket private; Redis password + not exposed; TLS between services where network untrusted.
- Backup encryption; break-glass superuser access audited (DEPLOYMENT).

## 17. AI-specific

Per AI_ARCHITECTURE.md: closed tool catalog, RBAC per tool, RLS in handlers, output caps, injection corpus tests, no raw SQL tools, human confirmation for state changes.

## 18. Compliance posture (ASSUMED — confirm)

- Students = minors → data minimization, guardian consent hooks, export/delete subject requests (DATA_RETENTION).
- Financial records retention as configured per jurisdiction.
- DPA with sub-processors (LLM, email, SMS, hosting) documented in deployment phase.

## 19. Security testing gates

CI: unit+authz tests, dependency audit, secret scan (gitleaks), lint for raw SQL patterns. Pre-release: tenant isolation suite, OWASP ASVS L1 checklist, external pen test before GA (Phase 13).
