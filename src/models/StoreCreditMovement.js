import mongoose from 'mongoose';
import { defineModel } from '../db/defineModel.js';

const storeCreditMovementSchema = new mongoose.Schema({
  storeCredit: { type: mongoose.Schema.Types.ObjectId, ref: 'StoreCredit', required: true },
  type: { type: String, enum: ['issue', 'redeem', 'adjustment'], required: true },
  amount: { type: Number, required: true, min: 0.01 },
  saleReturn: { type: mongoose.Schema.Types.ObjectId, ref: 'SaleReturn', default: null },
  saleTransaction: { type: mongoose.Schema.Types.ObjectId, ref: 'SaleTransaction', default: null },
  idempotencyKey: { type: String, trim: true, default: undefined },
  note: { type: String, trim: true, maxlength: 300, default: '' },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
}, { timestamps: true });

storeCreditMovementSchema.index({ idempotencyKey: 1 }, { unique: true, sparse: true });
storeCreditMovementSchema.index({ storeCredit: 1, createdAt: -1 });

export default defineModel('StoreCreditMovement', storeCreditMovementSchema);
