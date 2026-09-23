import { Redis } from 'ioredis';
import { getEnv } from '@sms/config';

let singleton: Redis | null = null;

/**
 * Canonical Redis client for the whole workspace. Every tenant-specific key
 * MUST be namespaced with the tenant id — enforced by helper `tenancyKey`.
 */
export function createRedis(url = getEnv().REDIS_URL): Redis {
  return new Redis(url, {
    maxRetriesPerRequest: null,
    enableOfflineQueue: false,
    lazyConnect: true,
  });
}

export function redisInstance(): Redis {
  if (!singleton) singleton = createRedis();
  return singleton;
}

export function tenancyKey(tenantId: string | null, rest: string[]): string {
  return ['t', tenantId ?? 'platform', ...rest].join(':');
}

export function userKey(tenantId: string | null, userId: string): string {
  return tenancyKey(tenantId, ['user', userId]);
}

export function sessionKey(tokenHash: string): string {
  return `sess:${tokenHash}`;
}

export async function pingRedis(): Promise<boolean> {
  try {
    return (await redisInstance().ping()) === 'PONG';
  } catch {
    return false;
  }
}

export async function closeRedis(): Promise<void> {
  if (singleton) {
    await singleton.quit();
    singleton = null;
  }
}