// Long-running scheduler worker. Stays alive and triggers jobs on the cron
// schedules configured in .env. Run in its own terminal/process — completely
// independent of the API server.
//
// Usage:
//   npm run jobs:scheduler
//
// Heroku: don't run this dyno. Use the Heroku Scheduler add-on instead and
// point it at `npm run jobs:overdue` (the one-shot runner).

import 'dotenv/config';
import '../config/env.js';

import cron from 'node-cron';
import connectDB from '../config/db.js';
import logger from '../utils/logger.js';
import { env } from '../config/env.js';
import runOverdueCheck from './overdueCheck.js';
import runLoyaltyExpiry from './loyaltyExpiry.js';
import runPraRetry from './praRetry.js';
import runBillingReminders from './billingReminders.js';
import { closeAllConnections } from '../db/connections.js';

const activeRuns = new Set();
const registerJob = (name, expression, handler) => {
  if (!expression) {
    logger.warn(`[scheduler] ${name}: no cron expression in .env (e.g. OVERDUE_CRON="*/5 * * * *") — not scheduling.`);
    return false;
  }
  if (!cron.validate(expression)) {
    logger.error(`[scheduler] ${name}: invalid cron expression "${expression}".`);
    return false;
  }
  let running = false;
  const task = cron.schedule(expression, () => {
    if (running) {
      logger.warn(`[scheduler] ${name}: previous run still active; skipping overlapping tick.`);
      return;
    }

    running = true;
    const run = (async () => {
      const startedAt = Date.now();
      logger.info(`[scheduler] ${name}: tick`);
      try {
        await handler();
        logger.info(`[scheduler] ${name}: completed in ${Date.now() - startedAt}ms`);
      } catch (err) {
        logger.error(`[scheduler] ${name} failed: ${err.stack || err.message}`);
      } finally {
        running = false;
      }
    })();
    activeRuns.add(run);
    run.finally(() => activeRuns.delete(run));
  });
  logger.info(`[scheduler] ${name}: registered with "${expression}"`);
  return task;
};

const main = async () => {
  logger.info('[scheduler] starting long-running worker.');
  await connectDB();

  const jobs = [
    registerJob('overdueCheck', env.OVERDUE_CRON, runOverdueCheck),
    // Default to once-a-day at 03:15 if no override is provided. Tenants whose
    // membershipRewards flag is off are skipped inside the job.
    registerJob('loyaltyExpiry', env.LOYALTY_EXPIRY_CRON || '15 3 * * *', runLoyaltyExpiry),
    // Re-submit PRA invoices/credits left pending by a timeout or outage.
    // Default every 10 minutes; idempotent so already-reported sales are skipped.
    registerJob('praRetry', env.PRA_RETRY_CRON || '*/10 * * * *', runPraRetry),
    // Scan hourly; each invoice carries nextReminderAt so successful messages
    // remain at least 24 hours apart even after worker downtime.
    registerJob('billingReminders', env.BILLING_REMINDER_CRON || '7 * * * *', runBillingReminders),
  ];

  if (!jobs.some(Boolean)) {
    logger.error('[scheduler] no jobs were registered — check your .env. Exiting.');
    process.exit(1);
  }

  logger.info('[scheduler] worker is live. Press Ctrl+C to stop.');

  let stopping = false;
  const shutdown = async (signal) => {
    if (stopping) return;
    stopping = true;
    logger.info(`[scheduler] received ${signal}; stopping schedules and draining active jobs.`);

    const forceTimer = setTimeout(() => process.exit(1), 25_000);
    forceTimer.unref();
    jobs.filter(Boolean).forEach((job) => job.stop());
    await Promise.allSettled(Array.from(activeRuns));
    await closeAllConnections();
    clearTimeout(forceTimer);
    logger.info('[scheduler] shutdown complete.');
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
};

main().catch((err) => {
  logger.error(`[scheduler] failed to start: ${err.stack || err.message}`);
  process.exit(1);
});
