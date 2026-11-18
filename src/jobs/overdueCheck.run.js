// One-shot runner for the overdue-invoice check. Designed to be invoked by
// Heroku Scheduler (which fires a fresh dyno) or any external cron.
//
// Usage:
//   node src/jobs/overdueCheck.run.js
//   npm run jobs:overdue

import 'dotenv/config';
import '../config/env.js';

import connectDB from '../config/db.js';
import logger from '../utils/logger.js';
import runOverdueCheck from './overdueCheck.js';
import { closeAllConnections } from '../db/connections.js';

const main = async () => {
  const startedAt = Date.now();
  logger.info('[jobs:overdue] starting standalone run.');
  try {
    await connectDB();
    await runOverdueCheck();
    logger.info(`[jobs:overdue] completed in ${Date.now() - startedAt}ms.`);
  } catch (err) {
    logger.error(`[jobs:overdue] failed: ${err.stack || err.message}`);
    process.exitCode = 1;
  } finally {
    await closeAllConnections();
  }
};

main();
