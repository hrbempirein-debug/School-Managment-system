# Billing / Subscription / Entitlement Design

Status: Phase 0 | Related: ADR-007, DATABASE_DESIGN.md §1, AUTHORIZATION.md §5

## 1. Principle

**Never branch on plan names.** Code asks: `entitlements.can(tenantId, featureCode)` and `usage.check(tenantId, metric)`.

```text
plt_plans ──< plt_plan_features (feature_code, limit_value) ── feature catalog (plt_features)
      │
      ▼
plt_subscriptions (tenant) ── status state machine
      │
      ▼
Entitlement resolver (cache 60s, invalidated on subscription.changed)
      ├── feature flags: on/off
      └── usage limits: plt_usage_counters vs limit_value
```

## 2. Feature catalog (examples)

| Feature code | Type | Example limits |
|---|---|---|
| `students.count` | counter limit | 500 / 5000 / unlimited |
| `staff.count` | counter limit | |
| `campuses.count` | counter limit | |
| `storage.bytes` | counter limit | |
| `ai.requests` | counter limit per month | |
| `attendance.period_level` | boolean | off in starter |
| `payroll.enabled` | boolean | |
| `library.enabled` | boolean | |
| `sms.credits` | counter | add-on |

Feature checks attach to API routes as `feature: 'payroll.enabled'` metadata evaluated after RBAC (403 vs 402: RBAC first — a parent isn't told "upgrade to see fees"; permission denials mask entitlement info).

## 3. Subscription state machine

```text
(no sub) ──create trial──► trialing ──convert──► active
trialing/active ──payment fail──► past_due ──grace (config, default 7d)──► suspended
past_due ──paid──► active
trialing/active/past_due ──cancel at period end──► active … ──period end──► cancelled
cancelled/suspended ──period end/timeout──► expired
any ──admin──► suspended
suspended/expired ──resubscribe──► active (new sub row or reactivate)
```

Transitions written to `plt_subscription_events` + audit `subscription.changed` + outbox event. Allowed transitions table enforced in domain code (invalid → error).

**Grace semantics:** during `past_due` and grace: all features on. `suspended`: read-only access — only `fees.read`-style exports/audit + payment portal + platform support; writes blocked at entitlement gate with `subscription_required`. Exact write-deny list is config (`billing.suspended_blocked_features`), default: everything except `billing.pay`, `audit.read`, profile reads.

## 4. Trial

- School creation optionally starts `trialing` with `trial_ends_at` (default 14 days, configurable plan-level).
- Dunning/sweeps: daily job transitions `trialing` past end without converted payment → `expired` (or `past_due` per product choice — **owner decision**, default: expired, school data retained read-only).

## 5. Usage limits

- Counters in `plt_usage_counters (tenant_id, metric, period_start, value)` incremented transactionally when resources are created (student created → `students.count` +1; deletion → decrement, floor 0).
- Check before create: if `value >= limit` → 402 `usage_limit_exceeded` with `metric`, `limit`.
- Recurring metrics (AI requests/month): period bucket `date_trunc('month')`; rollup job closes periods.
- Race safety: `INSERT … ON CONFLICT DO UPDATE SET value = value + 1 WHERE value < limit` style (atomic) or advisory lock per tenant+metric on creation paths.
- Storage bytes: async reconciliation job (sum file sizes) with alert drift.

## 6. Billing provider abstraction

```ts
interface BillingProvider {
  createCheckout(input: { tenantId, planCode, successUrl, cancelUrl }): Promise<{ url, externalId }>
  cancelSubscription(externalId, atPeriodEnd: boolean): Promise<void>
  changePlan(externalId, planCode): Promise<void>
  verifyWebhook(rawBody, signature): Promise<NormalizedBillingEvent>
  getPortalUrl(externalId): Promise<string>
}
```

Adapters: `StripeProvider`, `ManualProvider` (offline bank transfer: admin marks payment received → activates), `FreeProvider` (community/self-host).

- Provider truth never overwrites internal state blindly: webhook handler maps to our state machine; mismatches → reconciliation job + platform alert.
- `billing_provider_refs` stores external ids + raw payloads.
- Webhooks: verify signature (Stripe-style timestamped HMAC, tolerance 5 min), store raw in `payment_gateway_webhooks` with unique (provider, external_id) → enqueue processing job (idempotent replay protection).

## 7. Platform invoicing vs school finance

Two ledgers of concern:
1. **Platform → School** (subscription payments): platform-scope tables, provider-driven.
2. **School → Parents** (tuition etc.): tenant finance module (`fin_*`), never touches provider abstraction except optional online tuition collection (Phase 7+, separate `fin_gateway` interface — do not reuse billing provider blindly).

## 8. Entitlement evaluation placement

- API middleware after auth+RBAC: route metadata `{ feature?: string, usageMetric?: 'increment'|'check' }`.
- Worker: handlers check entitlements before expensive operations (AI, reports) and after (increment usage).
- AI gateway: `ai.requests` check pre-call + increment post (bill actual tokens → `storage`/`ai` counters from usage response).

## 9. Edge cases (must-test)

- Downgrade below current usage (500 students, plan limit 200): allow existing, block new creates until under limit (config flag `strict_downgrade` default block-on-create only).
- Concurrent creates racing the limit.
- Trial → paid mid-period; cancel scheduled then reactivated.
- Past_due webhook late-arriving marking active twice (idempotent).
- Clock skew on period end (evaluate with 60s tolerance).
- School suspended mid request-batch: some succeed some 402 — idempotency keys remain valid.
