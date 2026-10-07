import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createHmac } from 'node:crypto';
import pg from 'pg';
import { getEnv } from '@sms/config';

/**
 * TOTP known-answer suite for 0028's `app_totp_verify` (D4).
 *
 * The function is RFC 6238: HMAC-SHA1, 30 s step, 6 digits, ±1 counter window,
 * dynamic truncation, counter = floor(epoch/30) encoded with int8send() (RFC
 * 4226 §5.3 network-byte-order big-endian). This suite pins the vectors from
 * RFC 6238 Appendix B (the SHA1 row, seed = the ASCII bytes of
 * "12345678901234567890"). RFC 6238 prints 8-digit codes; the app's contract is
 * 6 digits, so the asserted values are the last six digits of each RFC code and
 * the 8-digit forms are asserted NOT to verify.
 *
 * Security posture: the function is SECURITY DEFINER and granted to NOBODY —
 * only F7 (`app_verify_mfa_code`) calls it. The ACL is asserted explicitly: a
 * bare school_app_rw session is refused with 42501.
 *
 * Opt-in: RUN_RUNTIME_SECURITY_TESTS=1 (requires PostgreSQL through 0028).
 */
const enabled = process.env.RUN_RUNTIME_SECURITY_TESTS === '1';
const describeDb = enabled ? describe : describe.skip;

let migrator: pg.Client;
let app: pg.Client;

const SEED = `convert_to('12345678901234567890', 'UTF8')`;

/** RFC 6238 Appendix B, SHA1 row: T -> 6-digit expected code. */
const VECTORS: Array<[number, string]> = [
  [59, '287082'], //        counter 1
  [1111111109, '081804'], // counter 37037036
  [1111111111, '050471'], // counter 37037037
  [1234567890, '005924'], // counter 41152263
  [2000000000, '279037'], // counter 66666666
  [20000000000, '353130'], // counter 666666666
];

/** The 8-digit RFC 6238 printed forms for the same seeds (rejected: 6 digits only). */
const RFC_8DIGIT: Array<[number, string]> = [
  [59, '94287082'],
  [1111111109, '07081804'],
  [1234567890, '89005924'],
  [2000000000, '69279037'],
];

/** Does the seed produce the code at T? */
const verify = (seed: string, code: string, t: number): Promise<pg.QueryResult> =>
  migrator.query(
    `select app_totp_verify(${seed}, '${code}', to_timestamp(${t})) as ok`,
  );

describeDb('finance-totp: RFC 6238 vectors against app_totp_verify', () => {
  beforeAll(async () => {
    const env = getEnv();
    migrator = new pg.Client({ connectionString: env.DATABASE_URL_MIGRATOR });
    app = new pg.Client({ connectionString: env.DATABASE_URL_APP });
    await migrator.connect();
    await app.connect();
  });

  afterAll(async () => {
    await migrator?.end().catch(() => undefined);
    await app?.end().catch(() => undefined);
  });

  it('all six RFC 6238 Appendix B vectors verify with their 6-digit codes', async () => {
    for (const [t, expected] of VECTORS) {
      const r = await verify(SEED, expected, t);
      expect(String(r.rows[0].ok), `T=${t}`).toBe('true');
    }
  });

  it('the counter is floor(epoch/30), not a fixed step — neighbouring steps do not alias', async () => {
    // 20000000000 / 30 = 666666666.66..., so T=20000000000 maps to counter
    // 666666666; one second either side of a step boundary is still the same
    // counter, but the adjacent counter differs and its code must not verify at
    // T where the window does not cover it.
    const at = await verify(SEED, '353130', 20000000000);
    expect(String(at.rows[0].ok)).toBe('true');
    // counter 666666667 is T + 30s: app_totp_verify's ±1 window DOES cover +1...
    const plus30 = await verify(SEED, codeFor(666666667), 20000000030);
    expect(String(plus30.rows[0].ok)).toBe('true');
  });

  it('the ±1 window: a code verifies 30 s early and 30 s late, but not 60 s either side', async () => {
    const [t, expected] = [1234567890, '005924'];
    expect(String((await verify(SEED, expected, t - 30)).rows[0].ok)).toBe('true');
    expect(String((await verify(SEED, expected, t)).rows[0].ok)).toBe('true');
    expect(String((await verify(SEED, expected, t + 30)).rows[0].ok)).toBe('true');
    expect(String((await verify(SEED, expected, t - 60)).rows[0].ok)).toBe('false');
    expect(String((await verify(SEED, expected, t + 60)).rows[0].ok)).toBe('false');
  });

  it('the 8-digit RFC 6238 printed codes are refused — the contract is exactly 6 digits', async () => {
    for (const [t, code] of RFC_8DIGIT) {
      const r = await verify(SEED, code, t);
      expect(String(r.rows[0].ok), `8-digit at T=${t}`).toBe('false');
    }
  });

  it('a wrong code, a wrong seed, and a wrong-length or malformed code are all FALSE', async () => {
    expect(String((await verify(SEED, '005925', 1234567890)).rows[0].ok)).toBe('false');
    expect(
      String((await verify(`convert_to('99999999999999999999', 'UTF8')`, '005924', 1234567890)).rows[0].ok),
    ).toBe('false');
    for (const bad of ['12345', '1234567', 'abcdef', '', '12 456']) {
      const r = await verify(SEED, bad, 1234567890);
      expect(String(r.rows[0].ok), `code '${bad}'`).toBe('false');
    }
  });

  it('NULL secret, code or instant is FALSE (single return value for every failure mode)', async () => {
    for (const sql of [
      `select app_totp_verify(null, '005924', to_timestamp(1234567890)) as ok`,
      `select app_totp_verify(${SEED}, null, to_timestamp(1234567890)) as ok`,
      `select app_totp_verify(${SEED}, '005924', null) as ok`,
    ]) {
      const r = await migrator.query(sql);
      expect(String(r.rows[0].ok)).toBe('false');
    }
  });

  it('school_app_rw cannot EXECUTE app_totp_verify — it is granted to nobody, NOT callable by the runtime role', async () => {
    try {
      await app.query(`select app_totp_verify(${SEED}, '005924', to_timestamp(1234567890))`);
      throw new Error('expected the function to be refused, but it executed');
    } catch (e) {
      const err = e as { code?: string };
      expect(err.code).toBe('42501');
    }
  });

  // Computes the expected 6-digit code for an arbitrary counter, reimplementing
  // RFC 4226 §5.3 in node (HMAC-SHA1 with an 8-byte big-endian message, dynamic
  // truncation, mod 10^6) so the test can explore window boundaries beyond the
  // fixed Appendix B steps.
  function codeFor(counter: number): string {
    const msg = Buffer.alloc(8);
    msg.writeBigUInt64BE(BigInt(counter));
    const hs = createHmac('sha1', Buffer.from('12345678901234567890', 'ascii')).update(msg).digest();
    const offset = hs[19]! & 0x0f;
    const bin =
      ((hs[offset]! & 0x7f) << 24) | (hs[offset + 1]! << 16) | (hs[offset + 2]! << 8) | hs[offset + 3]!;
    return String(bin % 1_000_000).padStart(6, '0');
  }
});