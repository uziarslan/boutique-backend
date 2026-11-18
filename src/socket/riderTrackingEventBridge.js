import { env } from '../config/env.js';
import { createQueueRedisConnection } from '../queues/redisConnection.js';
import { RIDER_TRACKING_EVENT_CHANNEL } from '../queues/riderTracking.queue.js';
import { emitRiderEvent } from '../services/riderTracking.service.js';
import logger from '../utils/logger.js';

let subscriber = null;

export const startRiderTrackingEventBridge = async () => {
  if (!env.RIDER_TRACKING_QUEUE_ENABLED) return false;
  if (subscriber) return true;
  const connection = createQueueRedisConnection({ name: 'restaurant-rider-tracking-events' });
  try {
    await connection.subscribe(RIDER_TRACKING_EVENT_CHANNEL);
    connection.on('message', (channel, raw) => {
      if (channel !== RIDER_TRACKING_EVENT_CHANNEL) return;
      try {
        const message = JSON.parse(raw);
        emitRiderEvent(message);
      } catch (error) {
        logger.warn(`Invalid rider tracking worker event: ${error.message}`);
      }
    });
    subscriber = connection;
    logger.info('Rider tracking worker event bridge enabled.');
    return true;
  } catch (error) {
    logger.error(`Rider tracking event bridge unavailable; dashboard polling remains active: ${error.message}`);
    if (connection.status !== 'end') await connection.quit().catch(() => connection.disconnect());
    return false;
  }
};

export const closeRiderTrackingEventBridge = async () => {
  const current = subscriber;
  subscriber = null;
  if (current && current.status !== 'end') await current.quit();
};

export default {
  closeRiderTrackingEventBridge,
  startRiderTrackingEventBridge,
};
