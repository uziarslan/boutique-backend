import { createHash } from 'node:crypto';
import RiderTrackingBatch from '../models/RiderTrackingBatch.js';

export const riderTrackingBatchKey = ({ riderId, body }) => {
  const pointIds = (body?.points || []).map((point) => String(point?.clientPointId || '')).join('|');
  return createHash('sha256').update(`${riderId}|${pointIds}`).digest('hex').slice(0, 64);
};

export const ensureRiderTrackingBatch = async ({ riderId, outletId, shiftId, body }) => {
  const batchKey = riderTrackingBatchKey({ riderId, body });
  const expiresAt = new Date(Date.now() + 7 * 86_400_000);
  return RiderTrackingBatch.findOneAndUpdate(
    { batchKey },
    {
      $setOnInsert: {
        rider: riderId,
        outlet: outletId,
        shift: shiftId,
        body,
        pointCount: body.points.length,
        status: 'pending',
        availableAt: new Date(),
        expiresAt,
      },
    },
    { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true, runValidators: true },
  );
};

export const claimRiderTrackingBatch = async (batchId) => {
  const now = new Date();
  return RiderTrackingBatch.findOneAndUpdate(
    {
      _id: batchId,
      $or: [
        { status: 'pending', availableAt: { $lte: now } },
        { status: 'processing', leaseUntil: { $lt: now } },
      ],
    },
    {
      $set: {
        status: 'processing',
        leaseUntil: new Date(now.getTime() + 2 * 60_000),
      },
      $inc: { attempts: 1 },
    },
    { returnDocument: 'after' },
  );
};

export const completeRiderTrackingBatch = async (batchId) => RiderTrackingBatch.updateOne(
  { _id: batchId },
  {
    $set: {
      status: 'completed',
      completedAt: new Date(),
      leaseUntil: null,
      lastError: '',
    },
    $unset: { body: 1 },
  },
);

export const releaseRiderTrackingBatch = async (batch, error, { terminal = false } = {}) => {
  const attempts = Math.max(1, Number(batch?.attempts || 1));
  const delay = Math.min(5 * 60_000, 1_000 * (2 ** Math.min(attempts - 1, 8)));
  return RiderTrackingBatch.updateOne(
    { _id: batch._id, status: 'processing' },
    {
      $set: {
        status: terminal ? 'failed' : 'pending',
        leaseUntil: null,
        availableAt: new Date(Date.now() + delay),
        lastError: String(error?.message || error || 'Tracking batch failed.').slice(0, 1000),
      },
    },
  );
};

export const pendingRiderTrackingBatches = async (limit = 100) => RiderTrackingBatch.find({
  $or: [
    { status: 'pending', availableAt: { $lte: new Date() } },
    { status: 'processing', leaseUntil: { $lt: new Date() } },
  ],
}).select('_id').sort({ createdAt: 1 }).limit(limit).lean();

export default {
  claimRiderTrackingBatch,
  completeRiderTrackingBatch,
  ensureRiderTrackingBatch,
  pendingRiderTrackingBatches,
  releaseRiderTrackingBatch,
  riderTrackingBatchKey,
};
