import IORedis from 'ioredis';
import { env } from '../config/env.js';
import { ioredisTlsOptions } from '../config/redisTls.js';
import logger from '../utils/logger.js';

const connections = new Set();

export const createQueueRedisConnection = ({ worker = false, name } = {}) => {
  if (!env.QUEUE_REDIS_URL) {
    throw new Error('QUEUE_REDIS_URL (or REDIS_URL) is required for queue processing.');
  }

  const connection = new IORedis(env.QUEUE_REDIS_URL, {
    connectionName: name || (worker ? 'restaurant-worker' : 'restaurant-producer'),
    maxRetriesPerRequest: worker ? null : 1,
    connectTimeout: 5_000,
    keepAlive: 10_000,
    enableReadyCheck: true,
    ...ioredisTlsOptions(env.QUEUE_REDIS_URL),
  });

  connection.on('error', (err) => {
    logger.error(`Queue Redis connection error: ${err.message}`, {
      redisRole: worker ? 'worker' : 'producer',
    });
  });
  connection.on('close', () => connections.delete(connection));
  connections.add(connection);
  return connection;
};

export const closeQueueRedisConnections = async () => {
  const open = Array.from(connections);
  connections.clear();
  await Promise.allSettled(open.map((connection) => connection.quit()));
};
