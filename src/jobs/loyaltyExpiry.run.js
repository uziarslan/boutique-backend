// One-shot runner for the loyalty-points expiry sweep. Invoke from Heroku
// Scheduler / cron. Tenants with membershipRewards off are skipped inside the job.
//
// Usage:
//   node src/jobs/loyaltyExpiry.run.js
//   npm run jobs:loyalty

import 'dotenv/config';
import '../config/env.js';

import connectDB from '../config/db.js';
import logger from '../utils/logger.js';
import runLoyaltyExpiry from './loyaltyExpiry.js';
import { closeAllConnections } from '../db/connections.js';

const main = async () => {
  const startedAt = Date.now();
  logger.info('[jobs:loyalty] starting standalone run.');
  try {
    await connectDB();
    await runLoyaltyExpiry();
    logger.info(`[jobs:loyalty] completed in ${Date.now() - startedAt}ms.`);
  } catch (err) {
    logger.error(`[jobs:loyalty] failed: ${err.stack || err.message}`);
    process.exitCode = 1;
  } finally {
    await closeAllConnections();
  }
};

main();
