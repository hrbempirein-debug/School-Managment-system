import { randomBytes, createHash, randomUUID } from 'node:crypto';

export function uuidv7(): string {
  const b = randomBytes(16);
  const tsHex = Date.now().toString(16).padStart(12, '0');
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 6; i++) {
    bytes[i] = Number.parseInt(tsHex.slice(i * 2, i * 2 + 2), 16);
  }
  bytes[6] = 0x70 | (b[6]! & 0x0f);
  bytes[7] = b[7]!;
  bytes[8] = 0x80 | (b[8]! & 0x3f);
  for (let i = 9; i < 16; i++) bytes[i] = b[i]!;
  const hex = [...bytes].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export { randomUUID };

export function createOpaqueToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function isUuid7(value: string): boolean {
  return (
    value.length === 36 &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  );
}