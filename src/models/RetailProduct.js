import mongoose from 'mongoose';
import { defineModel } from '../db/defineModel.js';

const retailProductSchema = new mongoose.Schema({
  shopifyProductId: { type: String, trim: true, default: undefined },
  catalogSource: { type: String, enum: ['manual', 'shopify'], default: 'manual' },
  title: { type: String, required: true, trim: true },
  handle: { type: String, trim: true, default: '' },
  description: { type: String, trim: true, default: '' },
  productType: { type: String, trim: true, default: '' },
  vendor: { type: String, trim: true, default: '' },
  tags: { type: [String], default: [] },
  imageUrl: { type: String, trim: true, default: '' },
  status: { type: String, enum: ['active', 'draft', 'archived'], default: 'active' },
  shopifyUpdatedAt: { type: Date, default: null },
  isActive: { type: Boolean, default: true },
  // Shopify deletions are hidden from live catalog views while retained for
  // historical sale, return, inventory, and production references.
  deletedAt: { type: Date, default: null },
}, { timestamps: true });

retailProductSchema.index({ shopifyProductId: 1 }, { unique: true, sparse: true });
retailProductSchema.index({ title: 'text', handle: 'text', productType: 'text', vendor: 'text' });
retailProductSchema.index({ status: 1, title: 1 });

export default defineModel('RetailProduct', retailProductSchema);
