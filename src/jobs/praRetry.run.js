import 'dotenv/config';
import '../config/env.js';

import connectDB from '../config/db.js';
import { env } from '../config/env.js';
import { closeAllConnections } from '../db/connections.js';
import { closePraQueue } from '../queues/pra.queue.js';
import { closeQueueRedisConnections } from '../queues/redisConnection.js';
import logger from '../utils/logger.js';
import runPraRetry from './praRetry.js';
import { runPraOutboxDispatch } from './outboxDispatch.js';

const main = async () => {
  const startedAt = Date.now();
  logger.info('[jobs:pra-retry] starting standalone run.');
  try {
    await connectDB();
    await runPraRetry();
    if (env.PRA_QUEUE_ENABLED) await runPraOutboxDispatch();
    logger.info(`[jobs:pra-retry] completed in ${Date.now() - startedAt}ms.`);
  } catch (error) {
    logger.error(`[jobs:pra-retry] failed: ${error.stack || error.message}`);
    process.exitCode = 1;
  } finally {
    await closePraQueue().catch(() => {});
    await closeQueueRedisConnections();
    await closeAllConnections();
  }
};

main();
