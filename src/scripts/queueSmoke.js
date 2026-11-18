import 'dotenv/config';
import '../config/env.js';

import mongoose from 'mongoose';
import connectDB from '../config/db.js';
import {
  closeAllConnections,
  dropTenantDatabase,
  getTenantConnectionFor,
} from '../db/connections.js';
import { runWithTenant } from '../db/tenantContext.js';
import OutboxEvent from '../models/OutboxEvent.js';
import {
  closePraQueue,
  ensurePraOutboxEvent,
  publishPraOutboxEventById,
} from '../queues/pra.queue.js';
import { closeQueueRedisConnections } from '../queues/redisConnection.js';

if (
  process.env.DEPLOYMENT_ENV !== 'staging'
  || process.env.QUEUE_SMOKE_ALLOWED !== 'true'
) {
  throw new Error(
    'Queue smoke is destructive and may run only with ' +
    'DEPLOYMENT_ENV=staging and QUEUE_SMOKE_ALLOWED=true.',
  );
}

const tenantSlug = `queue-smoke-${Date.now()}`;
const fakeSaleId = new mongoose.Types.ObjectId();
let tenantCreated = false;

try {
  await connectDB();
  const conn = await getTenantConnectionFor(tenantSlug);
  tenantCreated = true;

  const event = await runWithTenant({ conn, slug: tenantSlug }, () => (
    ensurePraOutboxEvent(fakeSaleId)
  ));
  const published = await runWithTenant({ conn, slug: tenantSlug }, () => (
    publishPraOutboxEventById(tenantSlug, event._id)
  ));
  if (!published) throw new Error('Smoke event could not be published.');

  const deadline = Date.now() + 30_000;
  let completed = null;
  while (Date.now() < deadline) {
    completed = await runWithTenant({ conn, slug: tenantSlug }, () => (
      OutboxEvent.findById(event._id).lean()
    ));
    if (completed?.status === 'completed') break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  if (completed?.status !== 'completed') {
    throw new Error('Worker did not complete the smoke event within 30 seconds.');
  }

  process.stdout.write(`${JSON.stringify({
    ok: true,
    tenantSlug,
    eventId: String(event._id),
    publishAttempts: completed.publishAttempts,
    workerResult: completed.lastError || 'completed',
  }, null, 2)}\n`);
} finally {
  await closePraQueue().catch(() => {});
  await closeQueueRedisConnections();
  if (tenantCreated) await dropTenantDatabase(tenantSlug).catch(() => {});
  await closeAllConnections();
}
