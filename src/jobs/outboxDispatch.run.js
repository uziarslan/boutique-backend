import 'dotenv/config';
import '../config/env.js';

import connectDB from '../config/db.js';
import { closeAllConnections } from '../db/connections.js';
import {
  closePraQueue,
} from '../queues/pra.queue.js';
import { closeQueueRedisConnections } from '../queues/redisConnection.js';
import logger from '../utils/logger.js';
import { runPraOutboxDispatch } from './outboxDispatch.js';

const main = async () => {
  await connectDB();
  await runPraOutboxDispatch();
};

main()
  .catch((err) => {
    logger.error(`Outbox dispatch failed: ${err.stack || err.message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePraQueue().catch(() => {});
    await closeQueueRedisConnections();
    await closeAllConnections();
  });
