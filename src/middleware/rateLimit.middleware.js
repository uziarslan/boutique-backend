import IORedis from 'ioredis';
import { rateLimit } from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import { env } from '../config/env.js';
import { ioredisTlsOptions } from '../config/redisTls.js';
import logger from '../utils/logger.js';

let client = null;

const getClient = () => {
  if (!env.DISTRIBUTED_RATE_LIMIT_ENABLED) return null;
  if (client) return client;

  client = new IORedis(env.RATE_LIMIT_REDIS_URL, {
    connectionName: 'restaurant-rate-limits',
    maxRetriesPerRequest: 1,
    connectTimeout: 5_000,
    keepAlive: 10_000,
    ...ioredisTlsOptions(env.RATE_LIMIT_REDIS_URL),
  });
  client.on('error', (err) => {
    logger.error(`Rate-limit Redis error: ${err.message}`);
  });
  return client;
};

const storeFor = (prefix) => {
  const redis = getClient();
  if (!redis) return undefined;
  return new RedisStore({
    prefix: `restaurant:rl:${prefix}:`,
    sendCommand: (command, ...args) => redis.call(command, ...args),
  });
};

export const createRateLimiter = ({
  prefix,
  windowMs,
  max,
  message,
  skipSuccessfulRequests = false,
}) => rateLimit({
  windowMs,
  max,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests,
  passOnStoreError: true,
  store: storeFor(prefix),
  message: {
    success: false,
    code: 'RATE_LIMITED',
    message,
  },
});

export const publicApiLimiter = createRateLimiter({
  prefix: 'public-api',
  windowMs: 60 * 1000,
  max: env.PUBLIC_RATE_LIMIT_MAX,
  message: 'Too many public requests. Please wait and try again.',
});

export const devicePairingLimiter = createRateLimiter({
  prefix: 'device-pairing',
  windowMs: 15 * 60 * 1000,
  max: 30,
  message: 'Too many device pairing attempts. Please wait and try again.',
  skipSuccessfulRequests: true,
});

export const closeRateLimitRedis = async () => {
  const redis = client;
  client = null;
  if (redis && redis.status !== 'end') await redis.quit();
};
