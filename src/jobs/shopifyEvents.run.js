import 'dotenv/config';
import '../config/env.js';
import connectDB from '../config/db.js';
import { closeAllConnections } from '../db/connections.js';
import logger from '../utils/logger.js';
import { runShopifyEvents } from './shopifyEvents.js';

const main = async () => {
  try {
    await connectDB();
    logger.info(`[jobs:shopify-events] queue-v2 worker started; release=${process.env.HEROKU_SLUG_COMMIT || 'local'}.`);
    await runShopifyEvents();
  } catch (error) {
    logger.error(`[jobs:shopify-events] worker stopped: ${error.stack || error.message}`);
    process.exitCode = 1;
  } finally {
    await closeAllConnections();
  }
};

main();
