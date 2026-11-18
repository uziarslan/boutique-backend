import mongoose from 'mongoose';
import { defineModel } from '../db/defineModel.js';

const optionSchema = new mongoose.Schema({
  name: { type: String, trim: true },
  value: { type: String, trim: true },
}, { _id: false });

const locationStockSchema = new mongoose.Schema({
  shopifyLocationId: { type: String, trim: true, default: '' },
  outlet: { type: mongoose.Schema.Types.ObjectId, ref: 'Outlet', default: null },
  available: { type: Number, default: 0 },
  onHand: { type: Number, default: 0 },
  updatedAt: { type: Date, default: null },
}, { _id: false });

const retailVariantSchema = new mongoose.Schema({
  product: { type: mongoose.Schema.Types.ObjectId, ref: 'RetailProduct', required: true },
  shopifyProductId: { type: String, trim: true, default: undefined },
  shopifyVariantId: { type: String, trim: true, default: undefined },
  catalogSource: { type: String, enum: ['manual', 'shopify'], default: 'manual' },
  shopifyInventoryItemId: { type: String, trim: true, default: '' },
  title: { type: String, trim: true, default: 'Default Title' },
  options: { type: [optionSchema], default: [] },
  sku: { type: String, trim: true, default: '' },
  barcode: { type: String, trim: true, default: '' },
  price: { type: Number, required: true, min: 0, default: 0 },
  compareAtPrice: { type: Number, min: 0, default: null },
  unitCost: { type: Number, min: 0, default: null },
  unitCostSource: { type: String, enum: ['shopify', 'production', 'manual'], default: 'shopify' },
  unitCostStatus: { type: String, enum: ['complete', 'review'], default: 'review' },
  tracked: { type: Boolean, default: true },
  inventoryPolicy: { type: String, enum: ['DENY', 'CONTINUE'], default: 'DENY' },
  isActive: { type: Boolean, default: true },
  inventoryByLocation: { type: [locationStockSchema], default: [] },
  shopifyUpdatedAt: { type: Date, default: null },
  barcodeSyncStatus: { type: String, enum: ['synced', 'pending', 'failed'], default: 'synced' },
  barcodeSyncError: { type: String, trim: true, maxlength: 500, default: '' },
}, { timestamps: true });

retailVariantSchema.index({ product: 1, isActive: 1 });
retailVariantSchema.index({ shopifyVariantId: 1 }, { unique: true, sparse: true });
retailVariantSchema.index({ sku: 1 });
retailVariantSchema.index({ barcode: 1 });
retailVariantSchema.index({ shopifyInventoryItemId: 1 });
retailVariantSchema.index({ 'inventoryByLocation.outlet': 1, isActive: 1 });
retailVariantSchema.index({ title: 'text', sku: 'text', barcode: 'text' });

export default defineModel('RetailVariant', retailVariantSchema);
