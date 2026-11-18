import { Queue } from 'bullmq';
import { env } from '../config/env.js';
import OutboxEvent from '../models/OutboxEvent.js';
import SaleTransaction from '../models/SaleTransaction.js';
import { createQueueRedisConnection } from './redisConnection.js';
import { praJobId } from './jobIds.js';

export const PRA_QUEUE_NAME = 'critical-pra-submission';
export const PRA_OUTBOX_TYPE = 'pra.invoice.submit';

let queue = null;
let producerConnection = null;

const normalizedAction = (action) => (action === 'credit' ? 'credit' : 'sale');
const statusFor = (sale, action) => (
  normalizedAction(action) === 'credit' ? sale?.pra?.credit?.status : sale?.pra?.status
);

export const getPraQueue = () => {
  if (!env.PRA_QUEUE_ENABLED) throw new Error('PRA queue is disabled.');
  if (!queue) {
    producerConnection = createQueueRedisConnection({ name: 'restaurant-pra-producer' });
    queue = new Queue(PRA_QUEUE_NAME, { connection: producerConnection });
  }
  return queue;
};

export const closePraQueue = async () => {
  const currentQueue = queue;
  const currentConnection = producerConnection;
  queue = null;
  producerConnection = null;
  if (currentQueue) await currentQueue.close();
  if (currentConnection && currentConnection.status !== 'end') await currentConnection.quit();
};

export const ensurePraOutboxEvent = async (saleId, action = 'sale') => {
  if (!env.PRA_QUEUE_ENABLED) return null;
  const id = String(saleId);
  const normalized = normalizedAction(action);
  const eventKey = `${PRA_OUTBOX_TYPE}:${normalized}:${id}`;
  return OutboxEvent.findOneAndUpdate(
    { eventKey },
    {
      $setOnInsert: {
        type: PRA_OUTBOX_TYPE,
        aggregateType: 'SaleTransaction',
        aggregateId: id,
        payload: { saleId: id, action: normalized },
        status: 'pending',
        availableAt: new Date(),
      },
    },
    { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true },
  );
};

export const claimPraOutboxEvent = async (eventId = null) => {
  const now = new Date();
  const filter = {
    type: PRA_OUTBOX_TYPE,
    status: 'pending',
    availableAt: { $lte: now },
  };
  if (eventId) filter._id = eventId;
  return OutboxEvent.findOneAndUpdate(
    filter,
    { $set: { status: 'publishing', leaseUntil: new Date(now.getTime() + 60_000) } },
    { sort: { createdAt: 1 }, returnDocument: 'after' },
  );
};

export const recoverExpiredPraOutboxLeases = () => OutboxEvent.updateMany(
  {
    type: PRA_OUTBOX_TYPE,
    status: 'publishing',
    leaseUntil: { $lt: new Date() },
  },
  {
    $set: {
      status: 'pending',
      leaseUntil: null,
      availableAt: new Date(),
    },
  },
);

// MongoDB is the source of truth when Redis is restarted or evicts old jobs.
export const recoverStalePublishedPraEvents = async ({
  staleBefore = new Date(Date.now() - 15 * 60 * 1000),
  limit = 300,
} = {}) => {
  const events = await OutboxEvent.find({
    type: PRA_OUTBOX_TYPE,
    status: 'published',
    publishedAt: { $lt: staleBefore },
  })
    .select('_id aggregateId payload')
    .sort({ publishedAt: 1 })
    .limit(limit)
    .lean();
  if (!events.length) return { requeued: 0, completed: 0 };

  const sales = await SaleTransaction.find({ _id: { $in: events.map((event) => event.aggregateId) } })
    .select('_id status pra.status pra.credit.status')
    .lean();
  const saleById = new Map(sales.map((sale) => [String(sale._id), sale]));
  const pendingIds = [];
  const terminalIds = [];
  for (const event of events) {
    const sale = saleById.get(String(event.aggregateId));
    const status = statusFor(sale, event.payload?.action);
    if (status === 'pending') pendingIds.push(event._id);
    else if (status !== 'submitting') terminalIds.push(event._id);
  }

  const [requeued, completed] = await Promise.all([
    pendingIds.length
      ? OutboxEvent.updateMany(
        { _id: { $in: pendingIds }, status: 'published' },
        {
          $set: {
            status: 'pending', availableAt: new Date(), publishedAt: null,
            lastError: 'Queue acknowledgement became stale; republishing.',
          },
        },
      )
      : { modifiedCount: 0 },
    terminalIds.length
      ? OutboxEvent.updateMany(
        { _id: { $in: terminalIds }, status: 'published' },
        { $set: { status: 'completed', completedAt: new Date(), lastError: '' } },
      )
      : { modifiedCount: 0 },
  ]);
  return { requeued: requeued.modifiedCount || 0, completed: completed.modifiedCount || 0 };
};

export const publishClaimedPraEvent = async (tenantSlug, event) => {
  const nextAttempt = Number(event.publishAttempts || 0) + 1;
  try {
    const action = normalizedAction(event.payload?.action);
    await getPraQueue().add(
      action === 'credit' ? 'submit-credit' : 'submit-sale',
      {
        tenantSlug: String(tenantSlug),
        saleId: String(event.payload.saleId),
        outboxEventId: String(event._id),
        action,
      },
      {
        jobId: praJobId(event.eventKey, nextAttempt),
        attempts: 8,
        backoff: { type: 'exponential', delay: 2_000 },
        removeOnComplete: { age: 24 * 60 * 60, count: 10_000 },
        removeOnFail: { age: 7 * 24 * 60 * 60, count: 50_000 },
      },
    );
    await OutboxEvent.updateOne(
      { _id: event._id, status: 'publishing' },
      {
        $set: { status: 'published', publishedAt: new Date(), leaseUntil: null, lastError: '' },
        $inc: { publishAttempts: 1 },
      },
    );
    return true;
  } catch (error) {
    await OutboxEvent.updateOne(
      { _id: event._id, status: 'publishing' },
      {
        $set: {
          status: 'pending', leaseUntil: null,
          availableAt: new Date(Date.now() + 10_000), lastError: error.message,
        },
      },
    ).catch(() => {});
    return false;
  }
};

export const publishPraOutboxEventById = async (tenantSlug, eventId) => {
  const event = await claimPraOutboxEvent(eventId);
  if (!event) return false;
  return publishClaimedPraEvent(tenantSlug, event);
};
