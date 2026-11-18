import mongoose from 'mongoose';
import { defineModel } from '../db/defineModel.js';

const shopifyWebhookEventSchema = new mongoose.Schema({
  deliveryId: { type: String, required: true, trim: true, unique: true },
  eventId: { type: String, trim: true, default: '' },
  shopDomain: { type: String, required: true, lowercase: true, trim: true },
  topic: { type: String, required: true, trim: true },
  resourceId: { type: String, trim: true, default: '' },
  payload: { type: mongoose.Schema.Types.Mixed, required: true },
  status: { type: String, enum: ['pending', 'processing', 'processed', 'failed', 'conflict'], default: 'pending' },
  attempts: { type: Number, default: 0, min: 0 },
  availableAt: { type: Date, default: Date.now },
  leaseUntil: { type: Date, default: null },
  processedAt: { type: Date, default: null },
  lastError: { type: String, trim: true, maxlength: 1500, default: '' },
}, { timestamps: true });

shopifyWebhookEventSchema.index({ status: 1, availableAt: 1, createdAt: 1 });
shopifyWebhookEventSchema.index({ topic: 1, resourceId: 1, createdAt: -1 });

export default defineModel('ShopifyWebhookEvent', shopifyWebhookEventSchema);
