import { Queue } from 'bullmq';
import { env } from '../config/env.js';
import { createQueueRedisConnection } from './redisConnection.js';

export const RIDER_TRACKING_QUEUE_NAME = 'rider-tracking-location-batches';
export const RIDER_TRACKING_EVENT_CHANNEL = 'restaurant:rider-tracking:events';

let queue = null;
let producerConnection = null;
let unavailableUntil = 0;

export const getRiderTrackingQueue = () => {
  if (!env.RIDER_TRACKING_QUEUE_ENABLED) throw new Error('Rider tracking queue is disabled.');
  if (!queue) {
    producerConnection = createQueueRedisConnection({ name: 'restaurant-rider-tracking-producer' });
    queue = new Queue(RIDER_TRACKING_QUEUE_NAME, { connection: producerConnection });
  }
  return queue;
};

export const enqueueRiderTrackingBatch = async ({ tenantSlug, batchId, attempt = 1 }) => {
  if (Date.now() < unavailableUntil) {
    throw new Error('Rider tracking queue circuit is temporarily open.');
  }
  const trackingQueue = getRiderTrackingQueue();
  try {
    const job = await trackingQueue.add(
      'persist-location-batch',
      {
        tenantSlug: String(tenantSlug),
        batchId: String(batchId),
      },
      {
        jobId: `rider-gps-${String(batchId)}-${Math.max(1, Number(attempt) || 1)}`,
        attempts: 8,
        backoff: { type: 'exponential', delay: 1_000 },
        removeOnComplete: { age: 60 * 60, count: 20_000 },
        removeOnFail: { age: 7 * 24 * 60 * 60, count: 50_000 },
      },
    );
    unavailableUntil = 0;
    return job.id;
  } catch (error) {
    unavailableUntil = Date.now() + 30_000;
    throw error;
  }
};

export const closeRiderTrackingQueue = async () => {
  const currentQueue = queue;
  const currentConnection = producerConnection;
  queue = null;
  producerConnection = null;
  unavailableUntil = 0;
  if (currentQueue) await currentQueue.close();
  if (currentConnection && currentConnection.status !== 'end') await currentConnection.quit();
};

export default {
  closeRiderTrackingQueue,
  enqueueRiderTrackingBatch,
  getRiderTrackingQueue,
};
