import mongoose from 'mongoose';
import { defineModel } from '../db/defineModel.js';

const retailInventoryMovementSchema = new mongoose.Schema({
  variant: { type: mongoose.Schema.Types.ObjectId, ref: 'RetailVariant', required: true },
  outlet: { type: mongoose.Schema.Types.ObjectId, ref: 'Outlet', default: null },
  shopifyLocationId: { type: String, trim: true, default: '' },
  quantityDelta: { type: Number, required: true },
  unitCost: { type: Number, min: 0, default: 0 },
  type: {
    type: String,
    enum: ['shopify-sync', 'pos-sale', 'production-receipt', 'return', 'exchange', 'count', 'adjustment'],
    required: true,
  },
  referenceType: { type: String, trim: true, default: '' },
  referenceId: { type: String, trim: true, default: '' },
  idempotencyKey: { type: String, trim: true, default: undefined },
  syncStatus: { type: String, enum: ['not-required', 'pending', 'processing', 'synced', 'conflict', 'failed'], default: 'not-required' },
  syncError: { type: String, trim: true, maxlength: 1000, default: '' },
  syncAttempts: { type: Number, default: 0, min: 0 },
  syncLeaseUntil: { type: Date, default: null },
  syncAvailableAt: { type: Date, default: Date.now },
  shopifyMutationId: { type: String, trim: true, default: '' },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  occurredAt: { type: Date, default: Date.now },
}, { timestamps: true });

retailInventoryMovementSchema.index({ idempotencyKey: 1 }, { unique: true, sparse: true });
retailInventoryMovementSchema.index({ outlet: 1, createdAt: -1 });
retailInventoryMovementSchema.index({ variant: 1, shopifyLocationId: 1, createdAt: -1 });

export default defineModel('RetailInventoryMovement', retailInventoryMovementSchema);
