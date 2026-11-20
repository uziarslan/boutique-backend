import mongoose from 'mongoose';
import { defineModel } from '../db/defineModel.js';

const shopifyTaskSchema = new mongoose.Schema({
  type: {
    type: String,
    enum: ['catalog-sync', 'product-update', 'barcode-update', 'order-reconcile', 'webhook-register'],
    required: true,
  },
  payload: { type: mongoose.Schema.Types.Mixed, default: {} },
  status: { type: String, enum: ['pending', 'processing', 'complete', 'failed', 'cancelled'], default: 'pending' },
  leaseToken: { type: String, default: null },
  result: { type: mongoose.Schema.Types.Mixed, default: null },
  workerVersion: { type: String, default: '' },
  cancelRequested: { type: Boolean, default: false },
  attempts: { type: Number, default: 0, min: 0 },
  availableAt: { type: Date, default: Date.now },
  leaseUntil: { type: Date, default: null },
  startedAt: { type: Date, default: null },
  finishedAt: { type: Date, default: null },
  lastError: { type: String, trim: true, maxlength: 1000, default: '' },
}, { timestamps: true });

shopifyTaskSchema.index({ status: 1, availableAt: 1, createdAt: 1 });

export default defineModel('ShopifyTask', shopifyTaskSchema);
