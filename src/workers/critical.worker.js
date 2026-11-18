import 'dotenv/config';
import '../config/env.js';

import { Worker } from 'bullmq';
import connectDB from '../config/db.js';
import { env } from '../config/env.js';
import {
  closeAllConnections,
  getTenantConnectionFor,
} from '../db/connections.js';
import { runWithTenant } from '../db/tenantContext.js';
import SaleTransaction from '../models/SaleTransaction.js';
import OutboxEvent from '../models/OutboxEvent.js';
import { submitCreditToPra, submitSaleToPra } from '../services/pra.service.js';
import {
  PRA_QUEUE_NAME,
  PRA_OUTBOX_TYPE,
} from '../queues/pra.queue.js';
import {
  closeQueueRedisConnections,
  createQueueRedisConnection,
} from '../queues/redisConnection.js';
import logger from '../utils/logger.js';

const terminalPraStatuses = new Set(['reported', 'failed', 'skipped']);

const processPraJob = async (job) => {
  const { tenantSlug, saleId, outboxEventId, action = 'sale' } = job.data || {};
  if (!tenantSlug || !saleId) throw new Error('PRA job is missing tenantSlug or saleId.');

  const conn = await getTenantConnectionFor(tenantSlug);
  return runWithTenant({ conn, slug: tenantSlug }, async () => {
    const transaction = await SaleTransaction.findById(saleId);
    if (!transaction) {
      await OutboxEvent.updateOne(
        { _id: outboxEventId },
        {
          $set: {
            status: 'completed',
            completedAt: new Date(),
            lastError: 'Sale no longer exists.',
          },
        },
      );
      return { status: 'missing' };
    }

    const isCredit = action === 'credit';
    const result = isCredit
      ? await submitCreditToPra(transaction)
      : await submitSaleToPra(transaction);
    const status = result?.status
      || (isCredit ? transaction.pra?.credit?.status : transaction.pra?.status)
      || 'skipped';
    if (status === 'pending' || status === 'submitting') {
      throw new Error(result?.error || 'PRA submission remains pending.');
    }

    if (terminalPraStatuses.has(status) || !result) {
      await OutboxEvent.updateOne(
        { _id: outboxEventId, type: PRA_OUTBOX_TYPE },
        {
          $set: {
            status: 'completed',
            completedAt: new Date(),
            leaseUntil: null,
            lastError: result?.error || '',
          },
        },
      );
    }
    return { status };
  });
};

const main = async () => {
  if (!env.PRA_QUEUE_ENABLED) {
    throw new Error('worker-critical requires PRA_QUEUE_ENABLED=true.');
  }

  await connectDB();
  const redis = createQueueRedisConnection({
    worker: true,
    name: 'restaurant-critical-worker',
  });
  const worker = new Worker(PRA_QUEUE_NAME, processPraJob, {
    connection: redis,
    concurrency: env.PRA_WORKER_CONCURRENCY,
  });

  worker.on('completed', (job, result) => {
    logger.info(`PRA job completed: ${job.id}`, {
      jobId: job.id,
      tenantSlug: job.data?.tenantSlug,
      saleId: job.data?.saleId,
      result,
    });
  });

  worker.on('failed', async (job, err) => {
    logger.error(`PRA job failed: ${job?.id || 'unknown'}: ${err.message}`, {
      jobId: job?.id,
      tenantSlug: job?.data?.tenantSlug,
      saleId: job?.data?.saleId,
      attemptsMade: job?.attemptsMade,
    });

    const attempts = Number(job?.opts?.attempts || 1);
    if (!job || job.attemptsMade < attempts) return;

    const { tenantSlug, outboxEventId } = job.data || {};
    if (!tenantSlug || !outboxEventId) return;
    try {
      const conn = await getTenantConnectionFor(tenantSlug);
      await runWithTenant({ conn, slug: tenantSlug }, () => (
        OutboxEvent.updateOne(
          { _id: outboxEventId, status: { $ne: 'completed' } },
          {
            $set: {
              status: 'pending',
              availableAt: new Date(Date.now() + 5 * 60 * 1000),
              lastError: err.message,
            },
          },
        )
      ));
    } catch (updateError) {
      logger.error(`Could not return PRA outbox event to pending: ${updateError.message}`);
    }
  });

  logger.info(`Critical worker started with PRA concurrency=${env.PRA_WORKER_CONCURRENCY}.`);

  let stopping = false;
  const shutdown = async (signal) => {
    if (stopping) return;
    stopping = true;
    logger.warn(`Critical worker received ${signal}; draining active jobs.`);

    const forceTimer = setTimeout(() => process.exit(1), 25_000);
    forceTimer.unref();
    await worker.close();
    await closeQueueRedisConnections();
    await closeAllConnections();
    clearTimeout(forceTimer);
    logger.info('Critical worker shutdown complete.');
  };

  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
};

main().catch((err) => {
  logger.error(`Critical worker failed to start: ${err.stack || err.message}`);
  process.exit(1);
});
