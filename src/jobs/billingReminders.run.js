import 'dotenv/config';
import '../config/env.js';
import connectDB from '../config/db.js';
import logger from '../utils/logger.js';
import { closeAllConnections } from '../db/connections.js';
import runBillingReminders from './billingReminders.js';

const main = async () => {
  await connectDB();
  const summary = await runBillingReminders();
  logger.info(`[billing] one-shot reminder run complete: ${JSON.stringify(summary)}`);
  await closeAllConnections();
};

main().catch(async (error) => {
  logger.error(`[billing] reminder runner failed: ${error.stack || error.message}`);
  try { await closeAllConnections(); } catch { /* best effort */ }
  process.exit(1);
});
