import { createHash, randomBytes } from 'node:crypto';
import { getEnv } from '@sms/config';
import { createOpaqueToken } from '@sms/core';
import type { Redis } from 'ioredis';

export interface RedisSession {
  userId: string;
  activeTenantId: string | null;
  csrfToken: string;
  createdAt: number;
  expiresAt: number;
}

export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function issueSessionToken(): { token: string; tokenHash: string } {
  const token = createOpaqueToken();
  return { token, tokenHash: hashSessionToken(token) };
}

export function newCsrfToken(): string {
  return randomBytes(24).toString('base64url');
}

export function absoluteTtlMs(): number {
  return getEnv().SESSION_TTL_ABSOLUTE_MINUTES * 60_000;
}

export async function readSession(redis: Redis, token: string): Promise<RedisSession | null> {
  const raw = await redis.get(`sess:${hashSessionToken(token)}`);
  if (!raw) return null;
  let data: RedisSession;
  try {
    data = JSON.parse(raw) as RedisSession;
  } catch {
    return null;
  }
  if (Number.isFinite(data.expiresAt) && data.expiresAt <= Date.now()) {
    await redis.del(`sess:${hashSessionToken(token)}`);
    return null;
  }
  return data;
}

export async function writeSession(
  redis: Redis,
  token: string,
  session: Omit<RedisSession, 'createdAt'> & { createdAt?: number },
): Promise<void> {
  const key = `sess:${hashSessionToken(token)}`;
  const ttlMs = session.expiresAt - Date.now();
  await redis.set(
    key,
    JSON.stringify({ ...session, createdAt: session.createdAt ?? Date.now() }),
    'PX',
    Math.max(ttlMs, 1000),
  );
}

export async function updateSessionActiveTenant(
  redis: Redis,
  token: string,
  tenantId: string | null,
): Promise<void> {
  const key = `sess:${hashSessionToken(token)}`;
  const raw = await redis.get(key);
  if (!raw) return;
  try {
    const data = JSON.parse(raw) as RedisSession;
    data.activeTenantId = tenantId;
    await redis.set(key, JSON.stringify(data), 'PX', Math.max(data.expiresAt - Date.now(), 1000));
  } catch {
    // ignore malformed session
  }
}

export async function deleteSession(redis: Redis, token: string): Promise<void> {
  await redis.del(`sess:${hashSessionToken(token)}`);
}