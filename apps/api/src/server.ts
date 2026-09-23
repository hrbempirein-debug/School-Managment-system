import { getEnv } from '@sms/config';
import { createDb } from '@sms/db';
import { createStorageProvider } from '@sms/storage';
import { buildApp } from './app.js';

async function main() {
  const env = getEnv();
  const { db } = createDb({ url: env.DATABASE_URL_APP, max: env.DB_POOL_MAX });
  const redis = createRedis(env.REDIS_URL);
  await redis.connect().catch(() => {
    // lazyConnect: connection is established lazily; a failed eager connect here
    // only matters for readiness, which covers redis separately.
  });
  const storage = createStorageProvider();
  const app = await buildApp({ deps: { db, redis, storage } });

  await app.listen({ port: env.API_PORT, host: env.API_HOST });
}

import { createRedis } from '@sms/redis';

void main();