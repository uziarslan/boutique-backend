import mongoose from 'mongoose';
import { defineModel } from '../db/defineModel.js';

const riderTrackingBatchSchema = new mongoose.Schema(
  {
    batchKey: { type: String, required: true, trim: true, maxlength: 80, unique: true },
    rider: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    outlet: { type: mongoose.Schema.Types.ObjectId, ref: 'Outlet', required: true, index: true },
    shift: { type: mongoose.Schema.Types.ObjectId, ref: 'RiderShift', required: true, index: true },
    body: { type: mongoose.Schema.Types.Mixed, required: true },
    pointCount: { type: Number, required: true, min: 1, max: 100 },
    status: {
      type: String,
      enum: ['pending', 'processing', 'completed', 'failed'],
      default: 'pending',
      index: true,
    },
    attempts: { type: Number, min: 0, default: 0 },
    availableAt: { type: Date, default: Date.now, index: true },
    leaseUntil: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    expiresAt: { type: Date, required: true },
    lastError: { type: String, trim: true, maxlength: 1000, default: '' },
  },
  { timestamps: true },
);

riderTrackingBatchSchema.index({ status: 1, availableAt: 1, createdAt: 1 });
riderTrackingBatchSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export default defineModel('RiderTrackingBatch', riderTrackingBatchSchema);
