import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { getEnv } from '@sms/config';

/**
 * P2-09 (D5) production-wrapper regression test for `app_mfa_encrypt(bytea)`.
 *
 * WHY THIS EXISTS
 * `0028_phase7_finance_security.sql` shipped `app_mfa_encrypt` calling
 * `pgp_sym_encrypt(bytea, …)`, an overload PostgreSQL does not provide, so the
 * helper raised `42883` on every call. The refund step-up acceptance suite never
 * caught it because it built the TOTP envelope itself. This suite exercises the
 * REAL production wrapper through the REAL runtime boundary and proves the
 * encrypt → decrypt round-trip, so the defect cannot silently return.
 *
 * It calls `app_mfa_encrypt` as `school_app_rw` (the API's enrollment boundary),
 * and opens the envelope with `app_mfa_decrypt` (deliberately NOT granted to the
 * runtime role — F7 is its only caller). No test-side `pgp_sym_encrypt_bytea`
 * workaround is used for any assertion here.
 *
 * Opt-in: RUN_RUNTIME_SECURITY_TESTS=1 (requires PostgreSQL through the
 * `0028_phase7_finance_security_mfa_encrypt_remediation.sql` tail).
 */
const enabled = process.env.RUN_RUNTIME_SECURITY_TESTS === '1';
const describeDb = enabled ? describe : describe.skip;

const hex = (b: Buffer): string => b.toString('hex');

describeDb('app_mfa_encrypt(bytea) — production wrapper round-trip (P2-09 D5)', () => {
  let app: pg.Client;
  let migrator: pg.Client;

  beforeAll(async () => {
    const env = getEnv();
    app = new pg.Client({ connectionString: env.DATABASE_URL_APP });
    migrator = new pg.Client({ connectionString: env.DATABASE_URL_MIGRATOR });
    await app.connect();
    await migrator.connect();
  });

  afterAll(async () => {
    await app?.end().catch(() => undefined);
    await migrator?.end().catch(() => undefined);
  });

  it('the INSTALLED wrapper calls pgp_sym_encrypt_bytea, and never the broken text call', async () => {
    const { rows } = await migrator.query<{ def: string }>(
      "select pg_get_functiondef('public.app_mfa_encrypt(bytea)'::regprocedure) as def",
    );
    const def = rows[0]!.def;
    // The correct binary primitive is present.
    expect(def).toMatch(/pgp_sym_encrypt_bytea\s*\(/);
    // The broken call `pgp_sym_encrypt(` is gone. This regex cannot match inside
    // `pgp_sym_encrypt_bytea(` because an `_` follows the base name.
    expect(def).not.toMatch(/pgp_sym_encrypt\s*\(/);
  });

  it('preserves the accepted P2-09 posture: SECURITY DEFINER, VOLATILE, pinned search_path, ACL', async () => {
    const { rows } = await migrator.query<{
      prosecdef: boolean;
      provolatile: string;
      proconfig: string[] | null;
    }>(
      "select prosecdef, provolatile, proconfig from pg_proc where oid = 'public.app_mfa_encrypt(bytea)'::regprocedure",
    );
    expect(rows[0]!.prosecdef).toBe(true);
    expect(rows[0]!.provolatile).toBe('v');
    expect(rows[0]!.proconfig ?? []).toContain('search_path=pg_catalog, public, pg_temp');

    const acl = await migrator.query<{ public_can: boolean; app_can: boolean }>(
      "select has_function_privilege('public','public.app_mfa_encrypt(bytea)','EXECUTE') as public_can, " +
        "has_function_privilege('school_app_rw','public.app_mfa_encrypt(bytea)','EXECUTE') as app_can",
    );
    expect(acl.rows[0]!.public_can).toBe(false);
    expect(acl.rows[0]!.app_can).toBe(true);
  });

  it('THE PRODUCTION PATH: runtime role encrypts, F7 decrypts, bytes round-trip exactly (incl. 0x00/0xFF)', async () => {
    // A deliberately non-textual 20-byte seed (NUL and 0xFF included). A
    // text-based pgp_sym_encrypt could not round-trip this byte-exactly; a
    // bytea-based one must.
    const seed = Buffer.from([
      0x00, 0xff, 0x01, 0xfe, 0x7f, 0x80, 0x10, 0x20, 0x30, 0x40, 0x50, 0x60, 0x70, 0x80, 0x90,
      0xa0, 0xb0, 0xc0, 0xd0, 0xe0,
    ]);

    // The REAL production wrapper, called as the runtime role — the exact path
    // the API uses for TOTP enrollment.
    const enc = await app.query<{ ct: Buffer }>('select app_mfa_encrypt($1::bytea) as ct', [seed]);
    const ct = enc.rows[0]!.ct;
    expect(Buffer.isBuffer(ct)).toBe(true);
    expect(ct.length).toBeGreaterThan(0);
    expect(ct.equals(seed)).toBe(false); // actually encrypted
    expect(ct.length).toBeGreaterThan(seed.length); // PGP envelope overhead

    // F7's decrypt half opens it (not granted to the runtime role by design).
    const dec = await migrator.query<{ pt: Buffer }>('select app_mfa_decrypt($1::bytea) as pt', [ct]);
    expect(hex(dec.rows[0]!.pt)).toBe(hex(seed));
  });

  it('is genuinely randomized PGP encryption: two calls differ, both decrypt to the same seed', async () => {
    const seed = Buffer.from('12345678901234567890', 'utf8');
    const a = (await app.query<{ ct: Buffer }>('select app_mfa_encrypt($1::bytea) as ct', [seed])).rows[0]!.ct;
    const b = (await app.query<{ ct: Buffer }>('select app_mfa_encrypt($1::bytea) as ct', [seed])).rows[0]!.ct;
    expect(hex(a)).not.toBe(hex(b));
    for (const ct of [a, b]) {
      const pt = (await migrator.query<{ pt: Buffer }>('select app_mfa_decrypt($1::bytea) as pt', [ct])).rows[0]!.pt;
      expect(hex(pt)).toBe(hex(seed));
    }
  });

  it('NULL in, NULL out (accepted contract)', async () => {
    const r = await app.query<{ ct: Buffer | null }>('select app_mfa_encrypt(null::bytea) as ct');
    expect(r.rows[0]!.ct).toBeNull();
  });
});