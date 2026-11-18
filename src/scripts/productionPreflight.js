import 'dotenv/config';
import '../config/env.js';

import IORedis from 'ioredis';
import connectDB from '../config/db.js';
import { env } from '../config/env.js';
import { ioredisTlsOptions } from '../config/redisTls.js';
import {
  closeAllConnections,
  getConnectionHealth,
  getPlatformConnection,
} from '../db/connections.js';

const result = {
  ok: true,
  checkedAt: new Date().toISOString(),
  node: process.version,
  environment: env.NODE_ENV,
  database: null,
  queueRedis: {
    configured: Boolean(env.QUEUE_REDIS_URL),
    reachable: null,
    maxmemoryPolicy: null,
  },
  features: {
    praQueue: env.PRA_QUEUE_ENABLED,
    riderTrackingQueue: env.RIDER_TRACKING_QUEUE_ENABLED,
    socketRedis: env.SOCKET_REDIS_ENABLED,
    distributedRateLimit: env.DISTRIBUTED_RATE_LIMIT_ENABLED,
  },
};

let redis = null;

try {
  await connectDB();
  const platformConnection = getPlatformConnection();
  const topologyType = platformConnection.getClient()
    ?.topology
    ?.description
    ?.type || 'unknown';
  result.database = {
    ...getConnectionHealth().platform,
    topologyType,
    transactionCapable: [
      'ReplicaSetWithPrimary',
      'Sharded',
      'LoadBalanced',
    ].includes(topologyType),
  };

  if (env.QUEUE_REDIS_URL) {
    redis = new IORedis(env.QUEUE_REDIS_URL, {
      connectionName: 'restaurant-production-preflight',
      maxRetriesPerRequest: 1,
      connectTimeout: 5_000,
      lazyConnect: true,
      ...ioredisTlsOptions(env.QUEUE_REDIS_URL),
    });
    await redis.connect();
    result.queueRedis.reachable = (await redis.ping()) === 'PONG';

    // BullMQ requires a non-evicting queue store. Some managed services forbid
    // CONFIG; report "unavailable" instead of failing an otherwise useful
    // connectivity check.
    try {
      const policy = await redis.config('GET', 'maxmemory-policy');
      result.queueRedis.maxmemoryPolicy = policy?.[1] || 'unknown';
      if (result.queueRedis.maxmemoryPolicy !== 'noeviction') result.ok = false;
    } catch {
      result.queueRedis.maxmemoryPolicy = 'unavailable';
    }
  }
} catch (error) {
  result.ok = false;
  result.error = error.message;
} finally {
  if (redis?.status !== 'end') await redis?.quit().catch(() => {});
  await closeAllConnections();
}

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (!result.ok) process.exitCode = 1;
