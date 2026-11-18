import { createAdapter } from '@socket.io/redis-streams-adapter';
import { createClient } from 'redis';
import { env } from '../config/env.js';
import { nodeRedisSocketOptions } from '../config/redisTls.js';
import logger from '../utils/logger.js';

let redisClient = null;

export const configureSocketRedisAdapter = async (io) => {
  if (!env.SOCKET_REDIS_ENABLED) return false;

  redisClient = createClient({
    url: env.SOCKET_REDIS_URL,
    name: 'restaurant-socket-streams',
    socket: nodeRedisSocketOptions(env.SOCKET_REDIS_URL),
  });
  redisClient.on('error', (err) => {
    logger.error(`Socket Redis error: ${err.message}`);
  });
  await redisClient.connect();

  io.adapter(createAdapter(redisClient, {
    streamName: 'restaurant:socket.io',
    sessionKeyPrefix: 'restaurant:sio:session:',
    maxLen: 20_000,
  }));
  logger.info('Socket.IO Redis Streams adapter enabled.');
  return true;
};

export const closeSocketRedisAdapter = async () => {
  const client = redisClient;
  redisClient = null;
  if (client?.isOpen) await client.quit();
};
