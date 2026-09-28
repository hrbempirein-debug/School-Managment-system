import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FsStorageProvider, S3StorageProvider, assertSafeKey, type StorageProvider } from './index.js';

const UUID_A = '0b0f0000-0000-4000-8000-00000000000a';
const UUID_B = 'cec10000-0000-4000-8000-00000000000b';

describe('FsStorageProvider: put/read/head/delete + tenant isolation', () => {
  let root: string;
  let storage: StorageProvider;

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'sms-storage-test-'));
    storage = new FsStorageProvider(root);
  });

  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('putObject + readObject round-trips bytes under root/{tenant}/{key}', async () => {
    const data = Buffer.from('%PDF-1.7 hello');
    const put = await storage.putObject({ tenantId: UUID_A, key: 'documents/x.pdf', data, contentType: 'application/pdf' });
    expect(put.size).toBe(data.byteLength);
    const got = await storage.readObject(UUID_A, 'documents/x.pdf');
    expect(got.equals(data)).toBe(true);
  });

  it('headObject reports size and last-modified', async () => {
    await storage.putObject({ tenantId: UUID_A, key: 'documents/head.bin', data: Buffer.alloc(64), contentType: 'application/octet-stream' });
    const head = await storage.headObject(UUID_A, 'documents/head.bin');
    expect(head.size).toBe(64);
    expect(head.key).toBe('documents/head.bin');
    expect(Number.isNaN(Date.parse(head.lastModified))).toBe(false);
  });

  it('overwrite replaces existing bytes', async () => {
    await storage.putObject({ tenantId: UUID_A, key: 'documents/overwrite.txt', data: Buffer.from('old'), contentType: 'text/plain' });
    await storage.putObject({ tenantId: UUID_A, key: 'documents/overwrite.txt', data: Buffer.from('REPLACED BY LONGER'), contentType: 'text/plain' });
    const got = await storage.readObject(UUID_A, 'documents/overwrite.txt');
    expect(got.toString()).toBe('REPLACED BY LONGER');
  });

  it('same key under different tenants never collides', async () => {
    await storage.putObject({ tenantId: UUID_A, key: 'documents/shared.txt', data: Buffer.from('tenant-A'), contentType: 'text/plain' });
    await storage.putObject({ tenantId: UUID_B, key: 'documents/shared.txt', data: Buffer.from('tenant-B'), contentType: 'text/plain' });
    expect((await storage.readObject(UUID_A, 'documents/shared.txt')).toString()).toBe('tenant-A');
    expect((await storage.readObject(UUID_B, 'documents/shared.txt')).toString()).toBe('tenant-B');
  });

  it('deleteObject removes the object; read then rejects', async () => {
    await storage.putObject({ tenantId: UUID_A, key: 'documents/gone.txt', data: Buffer.from('x'), contentType: 'text/plain' });
    await storage.deleteObject(UUID_A, 'documents/gone.txt');
    await expect(storage.readObject(UUID_A, 'documents/gone.txt')).rejects.toThrow();
  });

  it('deleteObject is idempotent (force rm)', async () => {
    await expect(storage.deleteObject(UUID_A, 'documents/never-existed.txt')).resolves.toBeUndefined();
  });
});

describe('assertSafeKey: path traversal and key shape guards', () => {
  it('rejects non-UUID tenant ids', () => {
    expect(() => assertSafeKey('tenant', 'documents/a.pdf')).toThrowError(/invalid.*key/i);
  });

  it('rejects absolute keys', () => {
    expect(() => assertSafeKey(UUID_A, '/etc/passwd')).toThrowError(/invalid.*key/i);
  });

  it('rejects parent traversal', () => {
    expect(() => assertSafeKey(UUID_A, 'documents/../../outside')).toThrowError(/invalid.*key/i);
  });

  it('rejects backslashes on windows-style keys', () => {
    expect(() => assertSafeKey(UUID_A, 'documents\\evil.pdf')).toThrowError(/invalid.*key/i);
  });

  it('rejects over-long keys', () => {
    expect(() => assertSafeKey(UUID_A, `documents/${'a'.repeat(1024)}.pdf`)).toThrowError(/invalid.*key/i);
  });

  it('accepts a well-formed tenant-scoped key', () => {
    expect(() => assertSafeKey(UUID_A, 'documents/7b9e4221-dfb0-4c2d-9b80-2d2f5f5b1d30.pdf')).not.toThrow();
  });
});

describe('S3StorageProvider (Phase 1 stub)', () => {
  it('every operation fails with not-implemented', async () => {
    const s3 = new S3StorageProvider();
    await expect(s3.putObject({ tenantId: UUID_A, key: 'a', data: Buffer.from('x'), contentType: 'x' })).rejects.toThrow(/not implemented/i);
    await expect(s3.readObject(UUID_A, 'a')).rejects.toThrow(/not implemented/i);
    await expect(s3.headObject(UUID_A, 'a')).rejects.toThrow(/not implemented/i);
    await expect(s3.deleteObject(UUID_A, 'a')).rejects.toThrow(/not implemented/i);
    await expect(s3.getDownloadUrl(UUID_A, 'a')).rejects.toThrow(/not implemented/i);
  });
});