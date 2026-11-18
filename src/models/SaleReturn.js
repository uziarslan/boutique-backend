import mongoose from 'mongoose';
import { defineModel } from '../db/defineModel.js';

const returnLineSchema = new mongoose.Schema({
  variant: { type: mongoose.Schema.Types.ObjectId, ref: 'RetailVariant', required: true },
  originalSaleItemIndex: { type: Number, required: true, min: 0 },
  quantity: { type: Number, required: true, min: 0.0001 },
  unitRefund: { type: Number, required: true, min: 0 },
  restock: { type: Boolean, default: true },
  condition: { type: String, enum: ['resalable', 'damaged', 'altered', 'other'], default: 'resalable' },
  reason: { type: String, trim: true, default: '' },
}, { _id: true });

const saleReturnSchema = new mongoose.Schema({
  returnNumber: { type: String, trim: true, unique: true },
  saleTransaction: { type: mongoose.Schema.Types.ObjectId, ref: 'SaleTransaction', required: true },
  session: { type: mongoose.Schema.Types.ObjectId, ref: 'SaleSession', default: null },
  outlet: { type: mongoose.Schema.Types.ObjectId, ref: 'Outlet', required: true },
  lines: { type: [returnLineSchema], required: true },
  refundAmount: { type: Number, required: true, min: 0 },
  refundMethod: { type: String, enum: ['cash', 'card', 'online-transfer', 'store-credit', 'shopify'], required: true },
  storeCreditReference: { type: String, trim: true, default: '' },
  reason: { type: String, trim: true, maxlength: 500, default: '' },
  status: { type: String, enum: ['completed', 'pending-sync', 'sync-conflict'], default: 'completed' },
  journalEntry: { type: mongoose.Schema.Types.ObjectId, ref: 'JournalEntry', default: null },
  shopifyRefundId: { type: String, trim: true, default: undefined },
  storeCredit: { type: mongoose.Schema.Types.ObjectId, ref: 'StoreCredit', default: null },
  unitCostReturned: { type: Number, min: 0, default: 0 },
  clientReturnId: { type: String, trim: true, default: undefined },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
}, { timestamps: true });

saleReturnSchema.index({ saleTransaction: 1, createdAt: -1 });
saleReturnSchema.index({ clientReturnId: 1 }, { unique: true, sparse: true });
saleReturnSchema.index({ shopifyRefundId: 1 }, { unique: true, sparse: true });

export default defineModel('SaleReturn', saleReturnSchema);
