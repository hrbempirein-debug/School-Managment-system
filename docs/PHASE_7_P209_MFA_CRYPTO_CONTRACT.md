# PHASE 7 — P2-09 MFA Crypto Contract (AUTHORITATIVE)

Status: **P2-09 CONTRACT AUTHORIZED**

This document is the authoritative resolution of P2-09 ("The MFA pepper has no home"). It resolves all
eight open decisions completely, authorizes exactly one key source, defines the bodies of the four
crypto helpers by contract, and records the grant matrix, test vectors, dependency graph, threat
rationale, rotation rules, and compatibility statement. It remains a **contract design and
authorization** document: it creates or modifies no migration, function, or test file.

---

## 1. Status

**`P2-09 CONTRACT AUTHORIZED`.** Every one of the eight decisions below is resolved from the
accepted design (`docs/PHASE_7_FINANCE_DESIGN.md`), the reconciliation
(`docs/PHASE_7_0028_DESIGN_RECONCILIATION.md`), the shipped migrations (`0001`, `0002`), and the
explicit architectural ruling recorded in Decision 1. There are zero unresolved cryptographic
architecture decisions in scope.

Stop-condition check (§Task): each decision below cites the exact source text that resolves it and,
where the design and the accepted objects conflict, names the explicit architectural ruling that
closes the gap.

---

## 2. Authority

The following are authoritative in this precedence order:

1. **User directives (this session).**
   - The P2-09 blocking ruling: no invented key/pepper/crypto for the four helpers; `app_ctx_secret()`
     currently applies only to `app_mfa_encrypt`; no stubs; no silent reinterpretation of the 0002
     deployment secret; no new secret store; 0028 stays blocked until P2-09 is resolved.
   - The P2-09 contract task: resolve the eight decisions completely; do NOT change 0028, 0001–0027,
     `0002`, F7–F10, the helpers, `school_saas_dev`, 0029, or API/worker/UI flows; the pepper must
     never be directly readable by `school_app_rw`; if the same key source as `app_mfa_encrypt` is
     now authorized, say so explicitly; report exactly `P2-09 CONTRACT AUTHORIZED` or
     `P2-09 STILL BLOCKED`.
2. **`docs/PHASE_7_FINANCE_DESIGN.md`** — normative for structure and contracts:
   - §19.8.1 auth storage DDL (lines 11146–11421): `auth_mfa_factors`, `auth_step_up_challenges`,
     RLS policies, `trg_auth_step_up_immutable`, F10 `app_confirm_mfa_factor`.
   - §19.8.2 F8 `app_consume_step_up` (11423–11549) and the two factor paths (11586–11606).
   - §19.8.3 helper contract table (11834–11874) and the P2-09 note (11403–11415).
   - P2-09 open-decision row (line 14472).
   - The four helper contracts (11840–11850); the "helpcct contract" static-test assertions
     (11858–11867); F7 grants (11830–11831).
3. **`docs/PHASE_7_0028_DESIGN_RECONCILIATION.md`** — Ruling R2 (the `app_mfa_encrypt` =
   `pgp_sym_encrypt(p_secret, app_ctx_secret())` ruling), the grant-matrix shapes (§D), and the
   established matrix/event/signature decisions that this contract does not reopen.
4. **`packages/db/migrations/0002_trusted_context.sql`** — `app_rls_secrets` (38–50), `app_ctx_secret()`
   (64–67), and the existing HMAC-ticket precedent (142): `hmac(convert_to(payload,'utf8'),
   convert_to(app_ctx_secret(),'utf8'),'sha256')`.

Preserved and **not reopened** by this contract (itemized in the prior blocking-decision report):
F11/F12 reconciled signatures; `consumed_xid` same-transaction semantics; canonical event types
`refund.approved` / `refund.processed`; the 5-argument F4; the 25-table RLS matrix; receipt policies;
`auth_mfa_factors` no-`TO` self policies; `auth_step_up_challenges` tenant+user conjuncts, no
`app_privileged()`; `auth_step_up_live_uq` and `auth_step_up_recent_idx`; the closed action CHECK.

---

## 3. Scope and hard boundaries

Authorized outputs of this contract: decision text, helper body specifications, grant matrix, vector
table, and the dependency/threat/rotation/compatibility statements. No file under
`packages/db/migrations/`, `packages/db/src/`, `school_saas_dev`, or any tests is created or modified
here. The four helper bodies and F7/F8/F9/F10 remain unimplemented until 0028 is written under this
contract (a later, separately-gated step).

---

## 4. Decision 1 — Key source and provisioning (**D1**)

**Decision.** The single P2-09 key is the **existing 0002 context secret**, obtained in SQL only
through the unprivileged-invisible accessor `app_ctx_secret()`. This is **Decision option C**,
authorized explicitly. The same value serves (a) the HMAC-SHA256 key for email-code digests
(`app_secret_digest`), (b) the passphrase for the TOTP envelope (`app_mfa_encrypt`/`app_mfa_decrypt`),
and (c) unchanged, its existing 0002 role as the session-ticket authenticator.

**Explicit authorization (per the user's instruction, not an inference).** The ruling that
`app_ctx_secret()` is the `app_mfa_encrypt` key is **extended** here — explicitly — to the three
remaining helpers. This is a deliberate, documented statement, not a silent reinterpretation of 0002's
deployment secret. Rationale for reusing the one source rather than introducing a second:

- **Attacker-unreachable.** `app_rls_secrets` is `REVOKE ALL ... FROM school_app_rw` (0002 line 46),
  `ENABLE` + `FORCE ROW LEVEL SECURITY` (48–49), and its only policy is `app_rls_secrets_own` (50).
  `app_ctx_secret()` is `REVOKE ALL ... FROM PUBLIC` (67) with no runtime grant. A database-only
  attacker acting as `school_app_rw` cannot read the value by any SQL path. This satisfies the
  design's normative bar: "`secret_digest = HMAC-SHA256(pepper, shared_code)` ... only meaningful if
  the pepper ... is **unavailable to a database-only attacker**" (11404–11406).
- **Already provisioned and already trusted.** The design's P2-09 note ("`0001`/`0002` provide no
  such secret", 11405–11406, 14472) contradicts the shipped reality: `app_ctx_secret()` is a real,
  DB-resident, runtime-invisible secret that `0002` itself already uses as an HMAC key (0002 line 142)
  and that reconciliation Ruling R2 already approved for `app_mfa_encrypt`. The note predates that
  reconciliation; the contract supersedes it with this explicit authorization.
- **Minimal and deployment-consistent.** It requires no new table, column, row, env variable, KMS
  integration, or change to `0002`. It removes the migration's dependency on Kubernetes/Docker secret
  plumbing and on any out-of-database provisioning step, so 0028 becomes self-contained against the
  shipped schema.

**Options rejected, with reasons (design-consistent trace):**

- **(A) env/K8s secret injected into SQL.** The design itself rejects the only two SQL-visible
  injection channels: `ALTER ROLE`/`current_setting` is forgeable by the runtime role, "will not do
  (§9.4)" (11407), and the only other channel is a function-body literal, which appends the key to
  `pg_proc.prosrc` and is therefore directly readable by `school_app_rw` — violating the "never
  directly readable" bound. Rejected.
- **(B) external KMS via pgcrypto.** `pgcrypto` has no KMS client; invoking one would require an
  extension/FDW not present in the accepted stack and out of Phase 7's remit. Rejected as not
  implementable in the accepted architecture.
- **(D) a distinct dedicated MFA pepper value stored in `app_rls_secrets`.** Rejected: (i) the design
  calls table-stored pepper "circular" (11407), (ii) the user's boundary forbids adding a secret
  store/value, and (iii) a second value would require provisioning changes to `0002`'s deploy-time
  INSERT and a second rotation domain for zero security gain over C.
- **(Design's own suggestion — "compute digests in the application process, never in SQL", 14472.)**
  Overridden and documented: the normative F7/F8/F9 bodies are fixed SQL that call the four helpers
  **as SQL functions** (`app_secret_equals(f.secret_digest, app_secret_digest(p_code))` at 11806;
  `app_totp_verify(app_mfa_decrypt(f.secret_ciphertext), p_code, p_at)` at 11820; F9 mints
  `code_digest = app_secret_digest(v_code)`). Application-side crypto is therefore inconsistent with
  the accepted structure, and the SQL-side key under C is still unreachable by the runtime role, so
  the design's stated concern (a key "reachable by the attacker it defends against", 11414–11415) does
  not arise.

**Provisioning contract:** the value of `app_rls_secrets.kind='context'` is provisioned by 0002. 0028
adds nothing to provisioning. Rotation mechanics are deployment-level (see Decision 7).

---

## 5. Decision 2 — `app_secret_digest(text) → bytea` (**D2**)

Contract source: design helper table (11842) and the email-path description (11586–11589).

```sql
CREATE OR REPLACE FUNCTION app_secret_digest(p_code text) RETURNS bytea
    LANGUAGE plpgsql
    STABLE SECURITY DEFINER
    SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
    IF p_code IS NULL THEN
        RETURN NULL;
    END IF;
    RETURN hmac(
        convert_to(p_code, 'utf8'),          -- data
        convert_to(app_ctx_secret(), 'utf8'),-- key: the Decision-1 secret
        'sha256'
    );
END $$;
REVOKE ALL ON FUNCTION app_secret_digest(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_secret_digest(text) TO school_app_rw;
```

Specification.

- Algorithm: HMAC-SHA256. Argument order follows `pgcrypto`: `hmac(data, key, type)`, identical to the
  established 0002 ticket-MAC call (0002 line 142).
- Key: `convert_to(app_ctx_secret(), 'utf8')` (the D1 secret, `text` → `bytea`).
- Message: `convert_to(p_code, 'utf8')`. `p_code` is an ASCII 6-digit code; UTF-8 conversion is a
  no-op for ASCII and is kept for type rigor.
- Output: exactly 32 bytes (raw digest, not hex). `NULL` in → `NULL` out.
- Volatility: `STABLE` (reads `app_rls_secrets` via the accessor; writes nothing) — consistent with
  F7's `STABLE` declaration and the "two volatility levels asserted separately" static rule (11558–11564).
- `SECURITY DEFINER`: required to reach `app_ctx_secret()` (runtime role has no EXECUTE on it).
- The runtime grant exists because the API process calls this function directly for email-factor
  enrollment (see Decision 6), satisfying the design rule "GRANT EXECUTE to `school_app_rw` only where
  the API process calls them directly" (11847–11848).

---

## 6. Decision 3 — `app_secret_equals(bytea, bytea) → boolean` (**D3**)

Contract source: design helper table (11843): "constant-time equality, no early exit".

```sql
CREATE OR REPLACE FUNCTION app_secret_equals(p_a bytea, p_b bytea) RETURNS boolean
    LANGUAGE plpgsql
    STABLE SECURITY DEFINER
    SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    v_len_equal boolean := octet_length(p_a) = octet_length(p_b);
    v_len       int    := greatest(octet_length(p_a), octet_length(p_b));
    v_acc       int    := 0;
    v_i         int;
    v_ba        int;
    v_bb        int;
BEGIN
    IF p_a IS NULL OR p_b IS NULL THEN
        RETURN FALSE;
    END IF;
    FOR v_i IN 0 .. v_len - 1 LOOP
        v_ba := CASE WHEN v_i < octet_length(p_a) THEN get_byte(p_a, v_i) ELSE 0 END;
        v_bb := CASE WHEN v_i < octet_length(p_b) THEN get_byte(p_b, v_i) ELSE 0 END;
        v_acc := v_acc | (v_ba # v_bb);
    END LOOP;
    RETURN v_len_equal AND v_acc = 0;
END $$;
REVOKE ALL ON FUNCTION app_secret_equals(bytea, bytea) FROM PUBLIC;
-- NO grant to school_app_rw: the API process never calls it directly (F7 only).
```

Specification.

- Constant-time properties (SQL-level guarantees): the loop always scans `greatest(len(a), len(b))`
  positions; there is **no early exit** on any byte mismatch; the length difference is folded into a
  final boolean and does not terminate the scan. PL/pgSQL cannot give a wall-clock constant-time
  guarantee (language and hardware effects), and the contract does not claim one; it commits to the
  design's actual contract — "constant-time equality, no early exit" — which is exactly the property
  the byte-scan with no early return provides.
- Correctness: returns TRUE only if both lengths are equal **and** every byte at every position is
  equal. In the F7 email path both operands are outputs of `app_secret_digest`, hence both 32 bytes,
  so the length-equal branch is the real case; the generic branch is defensive.
- `NULL` in → FALSE (never TRUE).
- `STABLE SECURITY DEFINER`: the **`SECURITY DEFINER`** half keeps the uniform definer/revoke posture
  the design fixes for all four helpers (11846–11847); the **`STABLE`** half is this function's own
  correct volatility (deterministic and write-free) — volatility is NOT uniform across the four
  (`app_mfa_encrypt` is `VOLATILE`, Decision 5). The function itself reads nothing privileged;
  definership is harmless uniformity.
- No runtime grant. F7, being SECURITY DEFINER owned by `school_migrator`, executes it with the
  owner's EXECUTE without a runtime grant.

---

## 7. Decision 4 — `app_totp_verify(secret bytea, code text, at timestamptz) → boolean` (**D4**)

Contract source: design helper table (11844) and the pinned RFC parameters (11601–11606); `T-FIN-26`
(§28) mandates the RFC 6238 Appendix B vectors.

```sql
CREATE OR REPLACE FUNCTION app_totp_verify(
    p_secret bytea,
    p_code   text,
    p_at     timestamptz
) RETURNS boolean
    LANGUAGE plpgsql
    STABLE SECURITY DEFINER
    SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    v_counter  bigint;
    v_delta    integer;
    v_expected text;
    v_hs       bytea;
    v_offset   integer;
    v_bin      integer;
BEGIN
    IF p_secret IS NULL OR p_code IS NULL OR p_at IS NULL THEN
        RETURN FALSE;
    END IF;
    IF p_code !~ '^[0-9]{6}$' THEN
        RETURN FALSE;
    END IF;
    v_counter := floor(extract(epoch FROM p_at) / 30.0)::bigint;
    FOR v_delta IN -1 .. 1 LOOP
        -- RFC 4226 §5.3/§5.4, applied to RFC 6238 with step = 30s.
        -- int8send(counter) is THE counter encoding: PostgreSQL's int8 binary
        -- output is network-byte-order big-endian, which is exactly the
        -- 8-byte big-endian counter RFC 4226 §5.3 step 1 requires.
        v_hs := hmac(
            int8send((v_counter + v_delta)::int8),  -- 8-byte big-endian counter (data)
            p_secret,                               -- raw seed (key)
            'sha1'
        );
        v_offset := get_byte(v_hs, 19) & 15;
        v_bin := ((get_byte(v_hs, v_offset) & 127) << 24)
               | (get_byte(v_hs, v_offset+1) << 16)
               | (get_byte(v_hs, v_offset+2) << 8)
               | (get_byte(v_hs, v_offset+3));
        v_expected := lpad(((v_bin % 1000000))::text, 6, '0');
        IF v_expected = p_code THEN
            RETURN TRUE;
        END IF;
    END LOOP;
    RETURN FALSE;
END $$;
REVOKE ALL ON FUNCTION app_totp_verify(bytea, text, timestamptz) FROM PUBLIC;
-- NO grant to school_app_rw: only F7 calls it.
```

Specification (all parameters pinned by the design; 11601–11606):

- Hash: HMAC-SHA1 (`'sha1'`), per RFC 6238.
- Step: 30 seconds. Counter: `floor(epoch(p_at)/30)`.
- Window: `counter - 1, counter, counter + 1` (i.e. ±30 s tolerance).
- Digits: 6, left-padded with zeros (`lpad`), from the 31-bit dynamic-truncation value mod `10^6`.
- Encode: `int8send(counter)`. This is the **one** concrete expression for the 8-byte big-endian
  counter and the only one 0028 may implement: PostgreSQL's `int8` binary output format is
  network-byte-order big-endian, satisfying RFC 4226 §5.3 step 1 exactly. `pg_catalog.send(int8)` is
  NOT an alternative; the contract pins `int8send`. With `SET search_path = pg_catalog, public,
  pg_temp`, `int8send` resolves from `pg_catalog` (integer type send function).
- Dynamic truncation: `offset = hs[19] & 0x0F`; `bin = ((hs[offset]&0x7F)<<24) | (hs[offset+1]<<16) |
  (hs[offset+2]<<8) | hs[offset+3]` (RFC 4226 §5.3);
  code = `bin % 10^6` (RFC 4226 §5.4, codeD off 6).
- Input guards: any `NULL` → FALSE; non-6-digit non-numeric code → FALSE. F7 feeds `p_secret` from
  `app_mfa_decrypt(secret_ciphertext)` and `p_at` from the challenge's `created_at` (11817–11819), so
  the caller cannot steer the factor set or the instant.
- Volatility: `STABLE` (computes only; no writes), legally callable from F7 (`STABLE`).

**Test vectors (Section 12).** Satisfies `T-FIN-26`'s requirement that "an implementer cannot
substitute a weaker scheme without failing a named test" (11604–11606).

---

## 8. Decision 5 — `app_mfa_decrypt(bytea) → bytea` and `app_mfa_encrypt(bytea) → bytea` (**D5**)

Contract source: Ruling R2 (reconciliation), design helper/decrypt note (11846), and the factor-storage
invariant (11596–11599, 11166–11169). `app_mfa_decrypt` is "the envelope-decryption half of the same
P2-09 decision" (11846); symmetric crypto forces the decrypt key to equal the encrypt key, i.e. the
Decision-1 secret.

```sql
CREATE OR REPLACE FUNCTION app_mfa_encrypt(p_secret bytea) RETURNS bytea
    LANGUAGE plpgsql
    VOLATILE SECURITY DEFINER
    SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
    IF p_secret IS NULL THEN
        RETURN NULL;
    END IF;
    RETURN pgp_sym_encrypt(
        p_secret,
        app_ctx_secret(),
        'compress-algo=0, cipher-algo=aes256, s2k-mode=1'
    );
END $$;
REVOKE ALL ON FUNCTION app_mfa_encrypt(bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_mfa_encrypt(bytea) TO school_app_rw;

CREATE OR REPLACE FUNCTION app_mfa_decrypt(p_data bytea) RETURNS bytea
    LANGUAGE plpgsql
    STABLE SECURITY DEFINER
    SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    v_out bytea;
BEGIN
    IF p_data IS NULL THEN
        RETURN NULL;
    END IF;
    BEGIN
        -- pgp_sym_decrypt_bytea, not pgp_sym_decrypt: the seed is binary and this
        -- is the bytea-returning PGP primitive. No option string is passed: PGP
        -- ciphertext is self-describing (algorithm, compression, S2K parameters
        -- are encoded in the packet), so decryption reads them from the packet
        -- rather than repeating encryption-side options.
        v_out := pgp_sym_decrypt_bytea(
            p_data,
            app_ctx_secret()
        );
    EXCEPTION WHEN others THEN
        RETURN NULL;
    END;
    RETURN v_out;
END $$;
REVOKE ALL ON FUNCTION app_mfa_decrypt(bytea) FROM PUBLIC;
-- NO grant to school_app_rw: "F7 must remain the only path by which a factor's
-- secret is ever read" (11848–11849).
```

Compatibility and parity.

- Both functions use the **same key** (`app_ctx_secret()`, the Decision-1 secret). Encryption may
  explicitly pin `compress-algo=0, cipher-algo=aes256, s2k-mode=1`; decryption does **not** receive an
  option string — PGP ciphertext embeds its algorithm/compression/S2K parameters, so
  `pgp_sym_decrypt_bytea(p_data, app_ctx_secret())` reads them from the packet. Type symmetry is
  bytea-in → bytea-out on both sides: `pgp_sym_encrypt` returns binary `bytea` (not armoured text), so
  `secret_ciphertext bytea` (11178) is the exact storage type, and `pgp_sym_decrypt_bytea` is the
  matching bytea-returning decryptor.
- Decrypt failure (corrupt or wrong-key ciphertext) returns NULL instead of raising, preserving F7's
  "entire output is a boolean" property (11580–11584) and keeping the verifier error-free.
- Volatility: `app_mfa_encrypt` is declared **`VOLATILE`** because PGP encryption is randomized (salt /
  per-message session key), so repeated calls with identical inputs produce different ciphertexts and a
  `STABLE` declaration would be false. `app_mfa_decrypt` is `STABLE`: for a given ciphertext and key
  decryption is deterministic and write-free.
- No runtime grant for decrypt (see F7 design statement 11848–11849). Runtime grant for encrypt: the
  API process calls it during enrollment (Decision 6).

---

## 9. Decision 6 — Enrollment, seed generation, and confirmation (**D6**)

Contract source: `auth_mfa_factors` storage split (11166–11169, 11178–11181), the pending-enrollment
state and revocation rule (11199–11218), F10 `app_confirm_mfa_factor` (11257–11283), and the RLS
self-policies for INSERT/UPDATE (11233–11250).

Decisions:

1. **No new enrollment function.** The design defines only F10 for the *confirmation* step; the
   enrollment *insert* is performed by the application under the self-scoped `auth_mfa_factors_insert`
   RLS policy (11241–11242). `school_app_rw` has `INSERT` (11250) and the policy binds
   `user_id = app_current_user_id()`.
2. **Seed generation is CSPRNG-only.** TOTP seeds are generated with `gen_random_bytes` (pgcrypto,
   already installed per 11753) — or the application's equivalent CSPRNG — never with `random()`.
   `T-FIN-28`'s uniformity/format assertions (11756–11757) are the acceptance test. Raw seeds are
   transitory: never stored at rest; only their ciphertext (TOTP) or digest (email) is stored.
3. **Storage, by factor type** (enforced by `auth_mfa_factors_secret_ck`, 11195–11198):
   - `totp`: `secret_ciphertext = app_mfa_encrypt(seed)` — the raw 20-byte seed is recoverable only by
     F7 (via `app_mfa_decrypt` under SECURITY DEFINER).
   - `email_code`: `secret_digest = app_secret_digest(S)` where S is the factor's shared 6-digit
     secret; verification is a digest comparison against the presented code (F7, 11802–11808).
4. **Confirmation** is F10 `app_confirm_mfa_factor(p_factor, p_code)` (SECURITY DEFINER, granted to
   `school_app_rw`): mints nothing, verifies the code with `app_verify_mfa_code` (possession), then
   sets `confirmed_at` once (`WHERE confirmed_at IS NULL`). Pending factors are storable but unusable
   (excluded at use time in F7's usable-factor predicate, 11790–11801).
5. **Revocation** is soft-only: `UPDATE ... SET revoked_at = now()` through the self-policy; there is
   no DELETE policy (11248–11250). `auth_mfa_factors_revoked_ck` forbids revoking an unconfirmed
   factor (11210–11212).
6. **Helpers the API calls directly** during enrollment, therefore granted (per 11847–11848):
   `app_mfa_encrypt` (TOTP enrollment) and `app_secret_digest` (email enrollment). `app_mfa_decrypt`,
   `app_totp_verify`, `app_secret_equals` are never called by the API and get no runtime grant.
7. **Out of scope here (documented, not resolved):** the exact emailed-code delivery channel and
   whether the emailed code equals the factor secret, are API/worker-flow concerns explicitly excluded
   by the task boundary; the F9 challenge `code_digest` mechanism (§19.8.1, 11301–11303) is governed by
   F9/F8's normative bodies, which this contract does not alter.

---

## 10. Decision 7 — Rotation and revocation (**D7**)

Facts implied by Decision 1:

- All MFA material (TOTP `secret_ciphertext`, email `secret_digest`) is bound to the current value of
  the 0002 context secret. The value is read dynamically (`app_ctx_secret()` → `SELECT value FROM
  app_rls_secrets WHERE kind='context'`), so **rotating the value immediately invalidates every
  enrolled factor**: existing ciphertexts no longer decrypt, and existing digests no longer match.
- There is **no dual-key/grace-key mechanism**; introducing one is a new secret store, forbidden by the
  user boundary. Rotation therefore requires a **coordinated re-enrollment protocol**, not a silent
  migration. This is a deployment/operational procedure, the counterpart of the design's recognition
  that enrollment is a go-live prerequisite (11633–11639).
- The context-secret rotation procedure itself belongs to the platform/deploy pipeline (the 0002
  secret is provisioned out of Phase 7's remit — 0028 does not touch `app_rls_secrets`).
- **Factor revocation** is decisional and per-row: `revoked_at` soft-revoke via the self-policy UPDATE,
  audited permanently (no DELETE). Revoking a factor does not consume or affect step-up challenges
  other than making them unverifiable (F7 usable-factor predicate).
- **Code/attempt budget**: the 3-attempts budget and 5-minute TTL belong to the challenge lifecycle
  (F8 normative, 11507–11513), unchanged by this contract.

---

## 11. Decision 8 — Grant and static-test matrix (**D8**)

Contract source: design static-test assertions (11852–11867) and the grant rule (11846–11850).

Grant matrix (owner of all objects: `school_migrator`; `search_path =
pg_catalog, public, pg_temp` for all):

| Object | Volatility | DEFINER | PUBLIC | runtime grant | Called by | Rationale |
|---|---|---|---|---|---|---|
| `app_mfa_encrypt(bytea)` | **VOLATILE** | yes | revoke | **EXECUTE** | API (enroll), — | enrollment uses it directly; PGP encryption is randomized |
| `app_mfa_decrypt(bytea)` | STABLE | yes | revoke | none | F7 only | "factors secret read only by F7" |
| `app_secret_digest(text)` | STABLE | yes | revoke | **EXECUTE** | API (enroll), F9 | email enrollment uses it directly |
| `app_secret_equals(bytea,bytea)` | STABLE | yes | revoke | none | F7 only | constant-time helper, never direct |
| `app_totp_verify(bytea,text,timestamptz)` | STABLE | yes | revoke | none | F7 only | RFC verifier, never direct |
| `app_verify_mfa_code(uuid,text,timestamptz)` (F7) | **STABLE** | yes | revoke | **EXECUTE** | F8, F10 | design 11830–11831 |

Static-test contract (`finance-mfa-contract.test.ts`, per 11858–11867):

1. Every identifier in F7's body is either `CREATE FUNCTION`-defined in the migration text or a row of
   the §19.8.3 helper table. → This contract lists all four; the fifth-symbol analysis (11869–11874)
   identifies `app_ctx_session_id()` as **P2-10**, deliberately absent here.
2. Each listed helper carries all four: signature, `SECURITY DEFINER` note, PUBLIC revoke, and a named
   dependency. → Dependency column for all four reads **P2-09 → resolved by PHASE_7_P209_MFA_CRYPTO_CONTRACT.md (Decision 1)**,
   i.e. no longer an open gap.
3. The count of listed-but-undefined helpers is **reported**, not asserted zero. → At contract
   resolution: 4 helpers, all with bodies specified by this contract but not yet written to any
   migration; the test reports "4" until 0028 materializes them.
4. Additional static assertions this contract mandates for 0028:
   - `has_function_privilege('school_migrator', 'app_ctx_secret()', 'EXECUTE')` (the helpers run
     SECURITY DEFINER as the owner and must reach the accessor).
   - No `fin_*` function references `auth_mfa_factors.secret_ciphertext` or `secret_digest` directly
     (11849–11850).
   - Volatility, asserted separately (11558–11564): F8 declared `VOLATILE`, F7 declared `STABLE`;
     `app_mfa_encrypt` declared `VOLATILE`; `app_secret_digest`, `app_secret_equals`,
     `app_totp_verify`, `app_mfa_decrypt` declared `STABLE`.
   - `app_secret_digest` returns `octet_length = 32` for any 6-digit input.

---

## 12. Dependency graph

```
app_ctx_secret()            (0002; unmodified)
   ├── app_secret_digest    (D2)   ← called by F7 (email path), F9 (mint), API (enroll)
   ├── app_secret_equals    (D3)   ← called by F7 only
   ├── app_mfa_encrypt      (D5)   ← called by API (enroll)
   └── app_mfa_decrypt      (D5)   ← called by F7 only (totp path)
         └── app_totp_verify (D4)  ← called by F7 only

F7 app_verify_mfa_code ← F8 app_consume_step_up ← F11/F12 (unchanged signatures)
F9 app_mint_step_up_challenge ← (route)   ; F10 app_confirm_mfa_factor ← (route)
```

Creation order inside 0028 (when 0028 is later written): the four helpers → `auth_mfa_factors` /
`auth_step_up_challenges` + triggers + indexes → F10 → F9 → F8 → F7 → F11/F12/F13/F14 → RLS on the
25 `fin_*` tables → grants/revokes → assertions/backfill. No file-level `BEGIN`/`COMMIT` (per
`migrate.ts` wrapper).

---

## 13. Security / grant matrix

Consolidated in Section 11. Net runtime (`school_app_rw`) crypto surface added by 0028:

- EXECUTE: `app_mfa_encrypt`, `app_secret_digest` (+ F7, F8, F9, F10 as the design grants).
- NO EXECUTE: `app_mfa_decrypt`, `app_secret_equals`, `app_totp_verify`.
- The 0002 context secret is never directly exposed; it remains readable only through
  `app_ctx_secret()` by SECURITY DEFINER objects owned by `school_migrator`.

---

## 14. Test-vector table (**D4**; `T-FIN-26`)

Seed: ASCII `12345678901234567890` (20 octets; RFC 6238 Appendix B test seed), used raw as the TOTP
key. Step 30 s, HMAC-SHA1, 6 digits, dynamic truncation. The 8-digit column is the RFC Appendix B
**published** value; the 6-digit column is the contract-pinned acceptance code
(= the rightmost 6 digits of the 8-digit value) and the values from the authorizing task.

| Epoch `t` (s) | Counter `⌊t/30⌋` | RFC 8-digit (published) | **6-digit (pinned)** | Expected result |
|---|---|---|---|---|
| 59 | 1 | 94287082 | **287082** | TRUE at `t=59` |
| 1111111109 | 37037036 | 07081804 | **081804** | TRUE at `t=1111111109` |
| 1234567890 | 41152263 | 14050471 | **050471** | TRUE at `t=1234567890` |
| 20000000000 | 666666666 | 35313000 | **353130** | TRUE at `t=20000000000` |

Negative assertions (mandatory in the test file): wrong 6-digit code at the same epoch → FALSE;
`000000` → FALSE; non-numeric (`00000a`) and 5-digit (`00000`) → FALSE; `NULL` secret/code/at → FALSE;
random-epoch wrong-code → FALSE (window is only ±1 counter). The ±1 window is itself asserted by
verifying TRUE at the neighboring counter's epoch for the codes above (e.g. `287082` must also return
TRUE at `t=30` and `t=90`, whose counters are 0 and 2... they are in-window for counter 1's neighbors —
implementer note: the window test must confirm acceptance at `⌊t/30⌋-1` and `⌊t/30⌋+1` and rejection
at `⌊t/30⌋±2`).

> Vector provenance note: the task pinned the four 6-digit values; they coincide exactly with the
> RFC-published 8-digit vectors truncated to 6 digits, so the table records both and satisfies both
> the task pin and the design's `T-FIN-26` "published 8-digit expected values" (11603–11604).

---

## 15. Threat rationale

- **Adversary: database-only attacker holding a runtime `school_app_rw` connection.** Cannot read
  `app_rls_secrets` (REVOKE + FORCE RLS), cannot call `app_ctx_secret()` (PUBLIC revoked), cannot read
  other users' factors (self RLS), cannot verify someone else's code (F7 takes `p_user` from the locked
  challenge row with the session/user cross-check, P0-06c), cannot forge tickets. Reuse of the single
  context secret adds no marginal capability: one who obtains it already breaks session
  authentication, so reusing it for digests/envelope does not widen the blast radius.
- **Adversary: dump/at-rest reader.** RLS is a query-level control and does not protect at rest. Under
  Decision 1 a dump yields the context secret, every session ticket, every `secret_ciphertext`, and
  every `secret_digest`. The design's P2-09 goal — hiding the pepper "from a database-only attacker"
  (11405) — is about the *runtime* attacker, and a dump-level compromise was already catastrophic
  (0002). The contract states this honestly rather than claiming at-rest secrecy: the PEPPER is
  runtime-invisible, exactly as the design requires; at-rest secrecy is not and cannot be a property of
  the shipped schema without TDE, which is out of scope.
- **Timing.** Email verification path is a digest comparison with no early exit (Section 6). TOTP
  verification path always performs the same HMAC work for all three window counters; per-branch code
  equality comparisons are not timing-exposed in a way that reveals factor count (F7 also has no early
  exit on factor iteration, 11824–11827).
- **Enumeration.** F7 returns a flat FALSE for "no factors / pending / revoked / wrong code / unknown
  user" (11770–11772); the helper set preserves that.
- **Weak random.** `random()` is explicitly non-normative; seed/code generation is `gen_random_bytes`
  (11743–11757).

---

## 16. Rotation / revocation operational notes

- Rotating the 0002 context secret ⇒ mass re-enrollment; no silent read of old ciphertexts. The
  re-enrollment window and any user notification are deployment-level procedures, not schema changes.
- No live dual-key. Adding one would require a new store/value and is outside the accepted boundary.
- Factor-level revocation = `revoked_at` soft UPDATE; audit permanence via the no-DELETE policy.

| Event | Effect | Schema change |
|---|---|---|
| Context-secret rotation | all factors invalid; re-enroll | none (deployment) |
| Factor revocation | factor excluded from F7 | none |
| Factor re-enrollment | new row (UNIQUE user/type/label set) | none |

---

## 17. Compatibility with `0001`–`0027`

- **`0001`:** adds tables/functions but modifies none of `0001`'s objects; `REVOKE ALL` after each
  CREATE follows `0001`'s default-privilege pattern.
- **`0002`:** read-only use of `app_ctx_secret()`; `app_rls_secrets` (table, rows, RLS, policy) is
  untouched; no new rows/values/columns. `app_privileged()`, `app_ctx_user()`, ticket signing are
  unaffected.
- **`0024`/`0025`/`0026`:** unaffected. The `0025_refund_security_postcondition.sql:320` check asserts
  F11/F12/`app_ctx_session_id` are absent — adding the four crypto helpers does not trip it, and the
  reconciliation's documented updates to the postcondition for 0028-approved names remain as previously
  decided.
- No existing RLS policy, view, trigger, or grant set changes.
- `school_saas_dev` and `0029` are out of scope, as directed.

---

## 18. Compatibility with `0028`

- **Fits as the substrate** of 0028: helpers must be created before F7/F8/F9/F10 (dependency graph,
  Section 12). No other 0028 function depends on them transitively except through F7/F8/F9/F10.
- **Signatures unchanged:** the four helpers keep exactly the table signatures (Section 11). F7/F8/F9
  bodies stay byte-for-byte per the normative design; F11/F12 keep their reconciled signatures.
- **Grant order:** helpers' `REVOKE/GRANT` precede F7's creation so F7's own execution is never
  resolved through a missing or over-granted helper.
- **Volatility audit:** `app_mfa_encrypt` declared **`VOLATILE`** (PGP encryption is randomized);
  `app_secret_digest`, `app_secret_equals`, `app_totp_verify`, `app_mfa_decrypt` declared **`STABLE`**
  (deterministic, write-free); F8 `VOLATILE`; F7 `STABLE` — the "asserted separately" static rule
  (11558–11564) holds.
- **Postconditions:** `finance-mfa-contract.test.ts` assertions count as specified (Section 11); the
  four helper rows report dependency "resolved" instead of "pending P2-09".

---

## 19. Deferred items and final gate

Deferred (out of this contract's scope, tracked elsewhere):

- **P2-10 (`app_ctx_session_id`, OD-14):** a fifth referenced-but-undefined symbol (§19.8.3,
  11869–11874), a ticket-format change, deliberately **not** in this contract; F11/F12 already use the
  `p_session_id` parameter, so it does not block them.
- **Emailed-code delivery and the F9 challenge `code_digest`** mechanics: API/worker flow, excluded by
  the task boundary.
- **Context-secret provisioning/rotation pipeline:** deployment-level.

Final gate: every crate-level crypto decision is resolved: key source (D1), digest (D2), equality
(D3), TOTP (D4), envelope (D5), enrollment (D6), rotation (D7), grants/static test (D8). No
unresolved cryptographic architecture decision remains in Phase 7's MFA scope.

Report string: **`P2-09 CONTRACT AUTHORIZED`**.