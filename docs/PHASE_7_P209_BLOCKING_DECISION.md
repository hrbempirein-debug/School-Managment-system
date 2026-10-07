# Phase 7 — P2-09 Blocking Decision Report

**Status:** `0028` is **BLOCKED — P2-09 unresolved.**

**Ruling (user, authoritative):** Defer P2-09 literally. `0028` must not silently resolve
`app_secret_digest`, `app_secret_equals`, `app_totp_verify`, or `app_mfa_decrypt`, and must not
weaken F7/F9 merely to make the migration apply. `0028` remains blocked rather than partially
implemented with invented cryptographic behaviour.

**Blocker statement:**

> P2-09 is an unresolved normative dependency. F7 (`app_verify_mfa_code`) and F9
> (`app_mint_step_up_challenge`) require four cryptographic helper contracts whose concrete bodies
> and persistent pepper/key source are not specified anywhere in the accepted design, schema, or
> migration chain. Implementing them would require an unauthorized security decision.

## 1. Why 0028 is blocked as a whole

- The design (`PHASE_7_FINANCE_DESIGN.md` §19.8.3/§19.8.4, lines 11403–11415, 11834–11874) defines the
  four helpers **by contract only** and defers implementation to P2-09. No concrete body exists in
  the design, any accepted migration (`0001`–`0027`), the accepted schema, or the quarantined
  reference files (`migrations-not-authorized/` — verified by grep, zero matches).
- F7's email path calls `app_secret_equals(f.secret_digest, app_secret_digest(p_code))`; F7's TOTP
  path calls `app_totp_verify(app_mfa_decrypt(f.secret_ciphertext), p_code, p_at)`; F9's INSERT calls
  `app_secret_digest(v_code)`. Without the helpers, the first mint or verify raises
  `42883 undefined_function` — reproducing the OD-17 class defect the design itself condemns.
- F11 (approve) and F12 (process) depend on F8 (`app_consume_step_up`), which depends on F9-minted
  challenges and F7 verification. The step-up-protected money path is therefore unexercisable
  end-to-end until the contract is authorized.
- The `app_ctx_secret()` ruling authorizes **only** `app_mfa_encrypt` (pgp_sym_encrypt against
  `app_ctx_secret()`). It does **not** extend to the four P2-09 helpers. Note the asymmetry: TOTP
  seeds can be encrypted, but no authorized `app_mfa_decrypt` yet exists to open them.

## 2. What must be specified before 0028 can proceed

### 2.1 Persistent MFA pepper/key source
- Where the persistent key material lives (email-code digest pepper; TOTP seed-wrapping key).
- Must be usable **across separate requests** — a per-ticket/session key is invalid (a digest minted
  in one request must verify in a later one).
- Who may read it; rotation lifecycle; compromise model. Options listed for a decision, not chosen:
  deployment secret injected via env/Kubernetes secret; external KMS; or — if explicitly authorized —
  an `app_rls_secrets`-style single-row definer-only secret. `app_rls_secrets` must NOT be exposed to
  the runtime role. **No new pepper column/store may be invented without authorization.**

### 2.2 `app_secret_digest(text) → bytea`
- Algorithm: HMAC-SHA256 over the authorized persistent pepper.
- Output encoding (raw bytes vs hex); NULL handling; length of input accepted.
- Volatility (STABLE), `SET search_path`, `SECURITY DEFINER` (owned by `school_migrator`), and which
  callers may EXECUTE it directly.

### 2.3 `app_secret_equals(bytea, bytea) → boolean`
- Constant-time equality semantics: no early exit on first differing byte; length-handling rule
  (what, if anything, leaks about length).
- Volatility (design text implies IMMUTABLE — to be confirmed), search_path, definer properties.

### 2.4 `app_totp_verify(secret_bytea, code text, at timestamptz) → boolean`
- Decryption of the seed via `app_mfa_decrypt` (dependency — item 2.5).
- RFC 6238 parameters (design text pins): HMAC-SHA1, 30-second step, 6 digits, ±1 step window
  (±30 seconds), `floor(epoch / 30)` counter, 8-byte big-endian counter encoding, dynamic truncation
  per RFC 4226 §5.4.
- Explicitly NOT a digest comparison (recoverable seed required).
- Test-vector requirement (T-FIN-26): SHA1 seed ASCII `12345678901234567890` →
  `287082` @ t=59, `081804` @ t=37037036, `050471` @ t=25423423, `353130` @ t=20000000000.

### 2.5 `app_mfa_decrypt(bytea) → bytea`
- Inverse of the envelope encryption; whether it may use `app_ctx_secret()` (currently **not**
  authorized — only `app_mfa_encrypt` may), or another authorized key/pepper.
- Who may call it. F7 must remain the only path by which a factor's `secret_ciphertext` is read.

### 2.6 Authorized runtime/enrollment boundary
- Which helpers `school_app_rw` may EXECUTE directly (enrollment paths) vs restricted to transitive
  definer reach (F7/F8/F9/F10).
- Whether an authorized enrollment function/route exists that can INSERT into `auth_mfa_factors`
  (no such producer exists today; `auth_mfa_factors` INSERT policy is self-scoped).

### 2.7 Required grants and SECURITY DEFINER properties
- Per helper: owner `school_migrator`, definer vs invoker, volatility, `SET search_path =
  pg_catalog, public, pg_temp`, `REVOKE ALL … FROM PUBLIC`, and `GRANT EXECUTE … TO school_app_rw`
  only where the API process calls directly.
- Consistency with reconciliation §D.4, which currently does **not** list the crypto helpers — the
  grant set is pending this contract.

### 2.8 Test vectors / verification requirements
- T-FIN-26 RFC 6238 vectors (2.4); T-FIN-28 distribution/uniformity for F9 code generation
  (`gen_random_bytes(4)` → 6 hex digits, no modulo bias).
- `finance-mfa-contract.test.ts` assertions: every identifier F7 calls is definable or a listed
  helper; each helper carries signature + SECURITY DEFINER note + PUBLIC revoke + named dependency;
  listed-but-undefined count is **reported, not asserted to be zero** — until the contract is
  authorized, that count stays four.
- Behavioural tests for both factor paths are deferred with the contract.

## 3. Constraints (do not violate)

- No stub/placeholder bodies; no functions added merely to satisfy resolution.
- No per-ticket/session key substituted for the persistent digest.
- No invented pepper column/store; no exposure of `app_rls_secrets`.
- No silent reinterpretation of 0002's deployment secret as the MFA pepper.
- Do not weaken F7/F9 to make the migration apply.
- Do not modify `0001`–`0027`, `0002`, or the accepted 0026/0025 files.

## 4. Preserved decisions (not reopened)

- Canonical F11 `postRefundApproval(p_session_id, p_refund_id, p_action)` / F12
  `postRefundProcess(p_session_id, p_refund_id, p_action, p_reason, p_disbursement_reference)` (§E,
  rulings 8/9).
- Same-transaction step-up assertion semantics (`consumed_xid = txid_current()`); NULL = assert
  consumed-in-current-tx, never consume-without-verify.
- Canonical event types `refund.approved` / `refund.processed` (I.2, E.1); no `fee.refund.*`.
- Five-argument `post_fin_ledger_group(uuid, text, uuid, jsonb, uuid)` (I.4).
- 25-table RLS inventory + §B.1 matrix; `fin_receipts` UPDATE `USING (app_privileged())` (I.1);
  `fin_receipts` INSERT disjunction (I.3); `fin_ledger_event_types` zero runtime privilege (B8).
- `school_saas_dev` migration-history drift classified external/pre-existing, untouched (I.5).
- `app_mfa_encrypt` ruling stands (pgp_sym_encrypt against `app_ctx_secret()`), scoped strictly to
  that function.

## 5. Gate state

- Reconciliation gate: `DESIGN-AMENDED — FORWARD-REMEDIATION REQUIRED` (§38.7) — unchanged.
- New blocker: **P2-09 MFA crypto contract unauthorized** — blocks authoring/application of the
  0028 MFA substrate and, with it, the step-up-protected refund path.
- No 0028 migration or test file is created or modified by this report.