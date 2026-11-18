import mongoose from 'mongoose';
import { defineModel } from '../db/defineModel.js';

const locationMappingSchema = new mongoose.Schema({
  shopifyLocationId: { type: String, required: true, trim: true },
  name: { type: String, trim: true, default: '' },
  outlet: { type: mongoose.Schema.Types.ObjectId, ref: 'Outlet', required: true },
  isActive: { type: Boolean, default: true },
}, { _id: false });

const shopifyConnectionSchema = new mongoose.Schema({
  shopDomain: { type: String, required: true, lowercase: true, trim: true },
  // Dev Dashboard credentials are exchanged for short-lived Admin API tokens.
  // Keep the legacy token field optional so existing installations can migrate.
  clientIdEncrypted: { type: String, select: false },
  accessTokenEncrypted: { type: String, select: false },
  clientSecretEncrypted: { type: String, required: true, select: false },
  apiVersion: { type: String, default: '2026-10', trim: true },
  currency: { type: String, uppercase: true, trim: true, default: 'PKR' },
  onlineOrderOutlet: { type: mongoose.Schema.Types.ObjectId, ref: 'Outlet', default: null },
  status: { type: String, enum: ['connected', 'attention', 'disconnected'], default: 'connected' },
  locationMappings: { type: [locationMappingSchema], default: [] },
  webhookSubscriptions: { type: [{ topic: String, subscriptionId: String, updatedAt: Date }], default: [] },
  lastCatalogSyncAt: { type: Date, default: null },
  lastInventorySyncAt: { type: Date, default: null },
  lastOrderSyncAt: { type: Date, default: null },
  lastError: { type: String, trim: true, maxlength: 1000, default: '' },
  configuredBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
}, { timestamps: true });

shopifyConnectionSchema.index({ shopDomain: 1 }, { unique: true });

export default defineModel('ShopifyConnection', shopifyConnectionSchema);
