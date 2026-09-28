import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

/**
 * Guards the claims in `docs/SECURITY.md` (and the `.env.example` comment for
 * `APP_ENCRYPTION_KEY`) against drifting away from the code.
 *
 * The audit finding behind this file: SECURITY.md asserted "Encryption at rest for
 * MFA secrets & PAT hashes: AES-256-GCM with app master key (env), key id stored for
 * rotation", while in the repository:
 *
 *   - `APP_ENCRYPTION_KEY` was declared in `packages/config` and read by nothing;
 *   - `auth_identities.secret_enc` was never written and never read;
 *   - no `key_id` column existed, so "key id stored for rotation" was untrue;
 *   - no encryption primitive existed anywhere (only argon2id hashing + sha256);
 *   - `password` was the only provider, so there were no OAuth secrets to encrypt.
 *
 * A documentation test is the right shape for this class of defect: the bug is a
 * claim about code, so the cheapest way to keep claim and code in agreement is to
 * assert both in one place. This is NOT a substitute for implementing encryption —
 * it pins the current, honest state so the false claim cannot silently return.
 *
 * Runs ungated (no `RUN_RUNTIME_SECURITY_TESTS`), because a documentation lie is
 * wrong on a clean checkout with no database, and it must fail in the default
 * `pnpm test` / `pnpm build` path.
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const read = (rel: string) => readFileSync(resolve(repoRoot, rel), 'utf8');

describe('SECURITY.md encryption claims match the code', () => {
  const security = read('docs/SECURITY.md');

  it('does not claim encryption at rest is an active control', () => {
    // The forbidden shape is a bare present-tense assertion. The corrected text is
    // allowed to DISCUSS encryption, but must mark it as not implemented.
    const forbidden = [
      /^-\s*Encryption at rest for .*AES-256-GCM/mi,
      /^-\s*.*encrypted at rest\./mi,
    ];
    for (const pattern of forbidden) {
      expect(security).not.toMatch(pattern);
    }
  });

  it('states plainly that secret encryption is NOT implemented', () => {
    expect(security).toMatch(/NOT YET IMPLEMENTED/i);
    expect(security).toMatch(/APP_ENCRYPTION_KEY/);
    expect(security).toMatch(/secret_enc/);
  });

  it('says passwords and tokens are hashed, not encrypted', () => {
    expect(security).toMatch(/hashed, not encrypted/i);
  });

  it('flags the absence of key-id rotation support rather than promising it', () => {
    expect(security).toMatch(/no .*key_id.*rotation support exists yet/i);
  });

  it('does not advertise a phantom column in DATABASE_DESIGN.md', () => {
    // `totp_secret_enc` never existed in any migration or in the Drizzle schema.
    const dbDesign = read('docs/DATABASE_DESIGN.md');
    expect(dbDesign).not.toMatch(/totp_secret_enc/);
  });

  it('marks the .env.example key as reserved and unused', () => {
    const envExample = read('.env.example');
    const line = envExample
      .split('\n')
      .find((l) => l.startsWith('APP_ENCRYPTION_KEY='));
    expect(line).toBeDefined();
    // The old comment claimed a "32-byte AES-GCM key ... for token encryption",
    // which was wrong twice over: nothing reads the key, and tokens are hashed.
    expect(envExample).not.toMatch(/for token encryption/i);
    expect(envExample).toMatch(/RESERVED \/ UNUSED/);
  });

  it('confirms the code really does leave secret_enc unpopulated', () => {
    // If someone later implements encryption, this test fails and forces a
    // deliberate decision to update the documentation, rather than the two drifting.
    const schema = read('packages/db/src/schema.ts');
    expect(schema).toMatch(/secretEnc: text\('secret_enc'\)/);

    // No source file outside the schema/audit-denylist may reference the column.
    const writers = ['packages/auth/src/service.ts', 'apps/api/src/cli/bootstrap-platform-admin.ts'];
    for (const f of writers) {
      expect(read(f)).not.toMatch(/secretEnc/);
    }
    // The audit denylist may keep redacting it defensively; that is not usage.
    expect(read('packages/audit/src/index.ts')).toMatch(/'secret_enc'/);
  });
});
