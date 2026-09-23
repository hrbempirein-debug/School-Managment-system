import { promises as fs } from 'node:fs';
import path from 'node:path';
import { getEnv } from '@sms/config';
import { HttpError } from '@sms/core';

export interface StorageObject {
  key: string;
  size: number;
  contentType?: string;
  lastModified: string;
}

export interface StorageProvider {
  putObject(input: {
    tenantId: string;
    key: string;
    data: Buffer;
    contentType: string;
  }): Promise<{ key: string; size: number }>;
  readObject(tenantId: string, key: string): Promise<Buffer>;
  getDownloadUrl(tenantId: string, key: string): Promise<string>;
  headObject(tenantId: string, key: string): Promise<StorageObject>;
  deleteObject(tenantId: string, key: string): Promise<void>;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Object keys are always `(scopePath)/fileName` within a tenant. Callers must
 * never pass a key that starts with a tenant id — the provider injects the
 * tenant prefix so cross-tenant reads are structurally impossible.
 */
export function assertSafeKey(tenantId: string, key: string): void {
  if (!UUID_RE.test(tenantId)) {
    throw new HttpError('Invalid tenant id in storage key', { status: 400, code: 'invalid_storage_key' });
  }
  if (key.startsWith('/') || key.includes('..') || key.includes('\\') || key.length > 1024) {
    throw new HttpError('Invalid storage key', { status: 400, code: 'invalid_storage_key' });
  }
}

export class FsStorageProvider implements StorageProvider {
  constructor(private root: string) {}

  private resolvePath(tenantId: string, key: string): string {
    assertSafeKey(tenantId, key);
    return path.join(this.root, tenantId, ...key.split('/'));
  }

  async putObject(input: { tenantId: string; key: string; data: Buffer; contentType: string }) {
    assertSafeKey(input.tenantId, input.key);
    const target = path.join(this.root, input.tenantId, ...input.key.split('/'));
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, input.data);
    return { key: input.key, size: input.data.byteLength };
  }

  async getDownloadUrl(tenantId: string, key: string): Promise<string> {
    assertSafeKey(tenantId, key);
    return `${getEnv().API_BASE_URL}/api/v1/files/${tenantId}/${key.split('/').map(encodeURIComponent).join('/')}`;
  }

  async readObject(tenantId: string, key: string): Promise<Buffer> {
    return fs.readFile(this.resolvePath(tenantId, key));
  }

  async headObject(tenantId: string, key: string): Promise<StorageObject> {
    const target = this.resolvePath(tenantId, key);
    const stat = await fs.stat(target);
    return {
      key,
      size: stat.size,
      lastModified: stat.mtime.toISOString(),
    };
  }

  async deleteObject(tenantId: string, key: string): Promise<void> {
    await fs.rm(this.resolvePath(tenantId, key), { force: true });
  }
}

export class S3StorageProvider implements StorageProvider {
  putObject(_input: { tenantId: string; key: string; data: Buffer; contentType: string }): Promise<{ key: string; size: number }> {
    return Promise.reject(new Error('S3 storage driver not implemented in Phase 1'));
  }
  readObject(): Promise<Buffer> {
    return Promise.reject(new Error('S3 storage driver not implemented in Phase 1'));
  }
  getDownloadUrl(): Promise<string> {
    return Promise.reject(new Error('S3 storage driver not implemented in Phase 1'));
  }
  headObject(): Promise<StorageObject> {
    return Promise.reject(new Error('S3 storage driver not implemented in Phase 1'));
  }
  deleteObject(): Promise<void> {
    return Promise.reject(new Error('S3 storage driver not implemented in Phase 1'));
  }
}

export function createStorageProvider(): StorageProvider {
  const env = getEnv();
  return env.STORAGE_DRIVER === 's3'
    ? new S3StorageProvider()
    : new FsStorageProvider(path.resolve(env.STORAGE_FS_ROOT));
}