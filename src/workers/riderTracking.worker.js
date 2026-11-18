import 'dotenv/config';
import '../config/env.js';

import { Worker } from 'bullmq';
import connectDB from '../config/db.js';
import { env } from '../config/env.js';
import { closeAllConnections, getTenantConnectionFor } from '../db/connections.js';
import { runWithTenant } from '../db/tenantContext.js';
import { TenantModel } from '../platform/models/Tenant.js';
import {
  RIDER_TRACKING_EVENT_CHANNEL,
  RIDER_TRACKING_QUEUE_NAME,
} from '../queues/riderTracking.queue.js';
import {
  closeQueueRedisConnections,
  createQueueRedisConnection,
} from '../queues/redisConnection.js';
import {
  processRiderLocationBatch,
  RiderLocationIngestionError,
} from '../services/riderLocationIngestion.service.js';
import {
  claimRiderTrackingBatch,
  completeRiderTrackingBatch,
  pendingRiderTrackingBatches,
  releaseRiderTrackingBatch,
} from '../services/riderTrackingInbox.service.js';
import logger from '../utils/logger.js';

const main = async () => {
  if (!env.RIDER_TRACKING_QUEUE_ENABLED) {
    throw new Error('worker-tracking requires RIDER_TRACKING_QUEUE_ENABLED=true.');
  }

  await connectDB();
  const workerRedis = createQueueRedisConnection({
    worker: true,
    name: 'restaurant-rider-tracking-worker',
  });
  const eventRedis = createQueueRedisConnection({
    name: 'restaurant-rider-tracking-event-publisher',
  });

  const processStoredBatch = async ({ tenantSlug, batchId }) => {
    if (!tenantSlug || !batchId) throw new Error('Rider tracking job is missing its tenant or durable batch ID.');
    const conn = await getTenantConnectionFor(tenantSlug);
    return runWithTenant({ conn, slug: tenantSlug }, async () => {
      const batch = await claimRiderTrackingBatch(batchId);
      if (!batch) return { status: 'already-claimed-or-completed' };
      try {
        const result = await processRiderLocationBatch({
          tenantSlug,
          riderId: batch.rider,
          shiftId: batch.shift,
          body: batch.body,
          onEvent: (message) => eventRedis
            .publish(RIDER_TRACKING_EVENT_CHANNEL, JSON.stringify(message))
            .catch((error) => {
              logger.warn(`Rider tracking realtime publish skipped: ${error.message}`);
              return 0;
            }),
        });
        await completeRiderTrackingBatch(batch._id);
        return { status: 'completed', ...result };
      } catch (error) {
        const terminal = error instanceof RiderLocationIngestionError
          && error.code === 'NO_ACTIVE_SHIFT';
        await releaseRiderTrackingBatch(batch, error, { terminal });
        if (terminal) return { status: 'discarded', reason: error.code };
        throw error;
      }
    });
  };

  const worker = new Worker(
    RIDER_TRACKING_QUEUE_NAME,
    async (job) => {
      const { tenantSlug, batchId } = job.data || {};
      return processStoredBatch({ tenantSlug, batchId });
    },
    {
      connection: workerRedis,
      concurrency: env.RIDER_TRACKING_WORKER_CONCURRENCY,
    },
  );

  worker.on('completed', (job, result) => {
    logger.info(`Rider tracking job completed: ${job.id}`, {
      tenantSlug: job.data?.tenantSlug,
      batchId: job.data?.batchId,
      accepted: result?.accepted,
    });
  });
  worker.on('failed', (job, error) => {
    const noLongerApplicable = error instanceof RiderLocationIngestionError
      && error.code === 'NO_ACTIVE_SHIFT';
    const log = noLongerApplicable ? logger.warn.bind(logger) : logger.error.bind(logger);
    log(`Rider tracking job failed: ${job?.id || 'unknown'}: ${error.message}`, {
      tenantSlug: job?.data?.tenantSlug,
      batchId: job?.data?.batchId,
      attemptsMade: job?.attemptsMade,
    });
  });

  logger.info(`Rider tracking worker started with concurrency=${env.RIDER_TRACKING_WORKER_CONCURRENCY}.`);

  let recovering = false;
  const recoverDurableInbox = async () => {
    if (recovering) return;
    recovering = true;
    try {
      const tenants = await TenantModel().find({ status: { $ne: 'suspended' } }).select('slug').lean();
      for (const tenant of tenants) {
        const conn = await getTenantConnectionFor(tenant.slug);
        const pending = await runWithTenant({ conn, slug: tenant.slug }, () => pendingRiderTrackingBatches(100));
        for (const batch of pending) {
          await processStoredBatch({ tenantSlug: tenant.slug, batchId: batch._id });
        }
      }
    } catch (error) {
      logger.error(`Rider tracking durable-inbox recovery failed: ${error.message}`);
    } finally {
      recovering = false;
    }
  };
  const recoveryTimer = setInterval(recoverDurableInbox, 15_000);
  recoveryTimer.unref();
  recoverDurableInbox();

  let stopping = false;
  const shutdown = async (signal) => {
    if (stopping) return;
    stopping = true;
    clearInterval(recoveryTimer);
    logger.warn(`Rider tracking worker received ${signal}; draining active GPS jobs.`);
    const forceTimer = setTimeout(() => process.exit(1), 25_000);
    forceTimer.unref();
    await worker.close();
    await closeQueueRedisConnections();
    await closeAllConnections();
    clearTimeout(forceTimer);
    logger.info('Rider tracking worker shutdown complete.');
  };
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
};

main().catch((error) => {
  logger.error(`Rider tracking worker failed to start: ${error.stack || error.message}`);
  process.exit(1);
});
